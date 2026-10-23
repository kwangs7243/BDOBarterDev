"""Independent SQLite ledger and atomic, idempotent crafting transactions."""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
import re
from pathlib import Path
import sqlite3
import threading
from uuid import uuid4

from .catalog import AlchemyError, graph, ingredients, integer, load_catalog, validate_catalog
from .engine import plan_goals

SCHEMA_VERSION = 1
TABLES = {"inventory": ("item_id", "quantity", "checked_at"), "goals": ("goal_id", "data"),
          "jobs": ("job_id", "data"), "ledger": ("entry_id", "data"), "events": ("event_id", "data"),
          "receipts": ("mutation_id", "request_hash", "response"), "settings": ("key", "value")}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def default_database_path():
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        raise AlchemyError("LOCALAPPDATA 경로를 확인하세요.", 503)
    return Path(local) / "BDOSuite" / "alchemy" / "alchemy.sqlite3"


class AlchemyStorage:
    def __init__(self, path):
        self.path = Path(path)
        self._ready = False
        self._lock = threading.Lock()

    def connect(self):
        if not self._ready:
            with self._lock:
                if not self._ready:
                    self.path.parent.mkdir(parents=True, exist_ok=True)
                    with closing(sqlite3.connect(self.path, timeout=15)) as db:
                        existing = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                        if existing:
                            version = db.execute("SELECT schema_version FROM meta WHERE id=1").fetchone() if "meta" in existing else None
                            if version is None or version[0] != SCHEMA_VERSION:
                                raise AlchemyError("지원하지 않는 연금 DB 버전입니다. 원본을 유지합니다.", 409)
                        db.executescript("""
                            CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, revision INTEGER NOT NULL);
                            INSERT OR IGNORE INTO meta VALUES(1,1,0);
                            CREATE TABLE IF NOT EXISTS inventory (item_id TEXT PRIMARY KEY, quantity INTEGER CHECK(quantity IS NULL OR quantity>=0), checked_at TEXT NOT NULL);
                            CREATE TABLE IF NOT EXISTS goals (goal_id TEXT PRIMARY KEY, data TEXT NOT NULL);
                            CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, data TEXT NOT NULL);
                            CREATE TABLE IF NOT EXISTS ledger (entry_id TEXT PRIMARY KEY, data TEXT NOT NULL);
                            CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, data TEXT NOT NULL);
                            CREATE TABLE IF NOT EXISTS receipts (mutation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, response TEXT NOT NULL);
                            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                        """)
                        if db.execute("SELECT schema_version FROM meta").fetchone()[0] != SCHEMA_VERSION:
                            raise AlchemyError("지원하지 않는 연금 DB 버전입니다. 원본을 유지합니다.", 409)
                        db.commit()
                    self._ready = True
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        return db

    def catalog(self, db):
        row = db.execute("SELECT value FROM settings WHERE key='catalog'").fetchone()
        return json.loads(row[0]) if row else load_catalog()

    def _stock(self, db):
        return {r["item_id"]: r["quantity"] for r in db.execute("SELECT * FROM inventory")}

    def _records(self, db, table):
        return [json.loads(r[0]) for r in db.execute(f"SELECT data FROM {table} ORDER BY rowid")]

    def snapshot(self):
        with closing(self.connect()) as db:
            db.execute("BEGIN")
            goals = self._records(db, "goals")
            return {"schema_version": SCHEMA_VERSION, "revision": db.execute("SELECT revision FROM meta").fetchone()[0],
                    "data_version": self.catalog(db)["version"], "goals": goals,
                    "jobs": [json.loads(r[0]) for r in db.execute("SELECT data FROM jobs WHERE json_extract(data,'$.status')='in_progress' ORDER BY rowid")],
                    "inventory": self._stock(db), "settings": {r[0]: json.loads(r[1]) for r in db.execute("SELECT key,value FROM settings WHERE key!='catalog'")}}

    def plans(self):
        with closing(self.connect()) as db:
            db.execute("BEGIN")
            plans = plan_goals(self.catalog(db), self._stock(db), self._records(db, "goals"))
            jobs = [json.loads(r[0]) for r in db.execute("SELECT data FROM jobs WHERE json_extract(data,'$.status')='in_progress'")]
            for plan in plans:
                for row in plan["rows"]:
                    active = [j for j in jobs if j["goal_id"] == plan["goal_id"] and j["recipe"]["output_item_id"] == row["item_id"]]
                    row["in_progress_calls"] = sum(j["calls"] for j in active)
                    if active:
                        row["status"] = "in_progress"
            return plans

    def history(self, offset=0, limit=50):
        with closing(self.connect()) as db:
            total = db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            rows = db.execute("SELECT data FROM events ORDER BY rowid DESC LIMIT ? OFFSET ?", (limit, offset))
            return {"total": total, "offset": offset, "events": [json.loads(r[0]) for r in rows]}

    def _put(self, db, table, key, value):
        db.execute(f"INSERT OR REPLACE INTO {table} VALUES (?,?)", (key, encode(value)))

    def _change(self, db, item, *, quantity=None, delta=None, absolute=False, transaction, kind, job=None):
        before = self._stock(db).get(item)
        if not absolute and before is None:
            raise AlchemyError("미확인 재고입니다. 절대 수량을 먼저 확인하세요.", 409, "unknown_inventory")
        after = quantity if absolute else before + delta
        if after is not None:
            integer(after, "변경 후 재고")
        checked = now()
        db.execute("INSERT OR REPLACE INTO inventory VALUES (?,?,?)", (item, after, checked))
        entry = {"entry_id": str(uuid4()), "transaction_id": transaction, "item_id": item,
                 "before": before, "after": after, "delta": None if before is None or after is None else after - before,
                 "kind": kind, "job_id": job, "at": checked}
        self._put(db, "ledger", entry["entry_id"], entry)

    def mutate(self, action, payload):
        if not isinstance(payload, dict):
            raise AlchemyError("JSON 객체가 필요합니다.")
        mutation = payload.get("mutationId")
        if not isinstance(mutation, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", mutation):
            raise AlchemyError("고유 mutationId가 필요합니다.")
        integer(payload.get("baseRevision"), "저장 버전")
        digest = hashlib.sha256(encode({"action": action, "payload": payload}).encode()).hexdigest()
        with closing(self.connect()) as db:
            try:
                db.execute("BEGIN IMMEDIATE")
                receipt = db.execute("SELECT * FROM receipts WHERE mutation_id=?", (mutation,)).fetchone()
                if receipt:
                    if receipt["request_hash"] != digest:
                        raise AlchemyError("같은 트랜잭션 ID를 다른 요청에 사용할 수 없습니다.", 409, "mutation_reused")
                    return json.loads(receipt["response"])
                revision = db.execute("SELECT revision FROM meta").fetchone()[0]
                if payload["baseRevision"] != revision:
                    raise AlchemyError("다른 작업이 먼저 저장됐습니다. 최신 상태를 불러온 뒤 다시 확인하세요.", 409, "stale_revision")
                catalog = self.catalog(db)
                items, recipes = validate_catalog(catalog)
                result = self._apply(db, action, payload, items, recipes, catalog, mutation)
                revision += 1
                db.execute("UPDATE meta SET revision=? WHERE id=1", (revision,))
                event = {"event_id": str(uuid4()), "transaction_id": mutation, "action": action, "at": now(), "result": result}
                self._put(db, "events", event["event_id"], event)
                response = {"ok": True, "revision": revision, **result}
                db.execute("INSERT INTO receipts VALUES (?,?,?)", (mutation, digest, encode(response)))
                db.commit()
                return response
            except BaseException:
                db.rollback()
                raise

    def _apply(self, db, action, p, items, recipes, catalog, transaction):
        if action == "inventory":
            changes = p.get("changes")
            if not isinstance(changes, list) or not 1 <= len(changes) <= 1000:
                raise AlchemyError("1~1,000개의 재고 변경을 입력하세요.")
            seen = set()
            for change in changes:
                item = change.get("item_id")
                kind = change.get("kind", "audit")
                if item not in items or item in seen or kind not in {"audit", "gather", "purchase", "use", "adjustment"}:
                    raise AlchemyError("중복 품목 또는 지원하지 않는 재고 변경입니다.")
                seen.add(item)
                value = change.get("quantity")
                if kind in {"audit", "adjustment"}:
                    if value is not None:
                        integer(value)
                    if kind == "adjustment" and not str(p.get("reason", "")).strip():
                        raise AlchemyError("보정 거래의 사유를 입력하세요.")
                    self._change(db, item, quantity=value, absolute=True, transaction=transaction, kind=kind)
                else:
                    integer(value, minimum=1)
                    self._change(db, item, delta=-value if kind == "use" else value, transaction=transaction, kind=kind)
            return {"changed_items": list(seen), "reason": str(p.get("reason", ""))[:1000]}
        if action == "goal":
            gid = p.get("goal_id") or str(uuid4())
            if not isinstance(gid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", gid):
                raise AlchemyError("목표 ID 형식이 올바르지 않습니다.")
            old = db.execute("SELECT data FROM goals WHERE goal_id=?", (gid,)).fetchone()
            previous = json.loads(old[0]) if old else {}
            if p.get("delete"):
                if not old:
                    raise AlchemyError("제작 목표가 없습니다.", 404)
                db.execute("DELETE FROM goals WHERE goal_id=?", (gid,))
                return {"deleted_goal": gid}
            item = p.get("item_id", previous.get("item_id"))
            if item not in items:
                raise AlchemyError("제작 목표 품목을 선택하세요.")
            quantity = integer(p.get("quantity", previous.get("quantity")), "목표량", minimum=1)
            mode = p.get("mode", previous.get("mode", "held"))
            if mode not in {"held", "additional"}:
                raise AlchemyError("목표 기준을 확인하세요.")
            baseline = previous.get("baseline") if previous.get("mode") == mode and previous.get("item_id") == item else self._stock(db).get(item)
            if mode == "additional" and baseline is None:
                raise AlchemyError("추가 제작 모드는 현재 최종품 재고 확인 후 사용할 수 있습니다.", 409)
            goal = {"goal_id": gid, "item_id": item, "quantity": quantity, "mode": mode, "baseline": baseline if mode == "additional" else 0,
                    "priority": integer(p.get("priority", previous.get("priority", len(self._records(db, "goals")))) , "우선순위"),
                    "active": p.get("active", previous.get("active", True)),
                    **{key: p.get(key, previous.get(key, {})) for key in ("choices", "substitutions", "expected_yields")},
                    "assume_unknown_zero": p.get("assume_unknown_zero", previous.get("assume_unknown_zero", False))}
            if type(goal["active"]) is not bool or type(goal["assume_unknown_zero"]) is not bool:
                raise AlchemyError("계획 설정값을 확인하세요.")
            if any(not isinstance(goal[key], dict) for key in ("choices", "substitutions", "expected_yields")):
                raise AlchemyError("제작 경로 설정 형식이 잘못됐습니다.")
            graph(catalog, item, goal["choices"], goal["substitutions"])
            planned = plan_goals(catalog, self._stock(db), [{**goal, "active": True}])[0]
            if planned["errors"]:
                raise AlchemyError(" / ".join(planned["errors"]), 409)
            self._put(db, "goals", gid, goal)
            return {"goal": goal}
        if action == "start":
            recipe = recipes.get(p.get("recipe_id"))
            if not recipe or recipe.get("verification") != "verified":
                raise AlchemyError("검증되지 않은 제작식은 차감에 사용할 수 없습니다.", 409)
            substitutions = p.get("substitutions", {})
            graph(catalog, recipe["output_item_id"], {**p.get("choices", {}), recipe["output_item_id"]: recipe["recipe_id"]}, substitutions)
            calls = integer(p.get("calls"), "제작 횟수", minimum=1)
            inputs = ingredients(recipe, substitutions)
            stock = self._stock(db)
            for row in inputs:
                required = integer(row["quantity"] * calls, "차감량", minimum=1)
                if stock.get(row["item_id"]) is None or stock[row["item_id"]] < required:
                    raise AlchemyError(f'{items[row["item_id"]]["name"]}: 재고 부족 또는 미확인입니다.', 409, "insufficient_inventory")
            # Only this goal may spend its reserved stock. Unassigned work cannot spend other goals' reservations.
            plans = plan_goals(catalog, stock, self._records(db, "goals"))
            goal_id = p.get("goal_id")
            if goal_id is not None:
                target = next((g for g in self._records(db, "goals") if g["goal_id"] == goal_id), None)
                if target is None:
                    raise AlchemyError("제작 목표가 없습니다.", 404)
                if not target["active"]:
                    raise AlchemyError("보류한 목표입니다. 목표를 활성화한 뒤 제작하세요.", 409)
                target["choices"] = {**target["choices"], **p.get("choices", {}), recipe["output_item_id"]: recipe["recipe_id"]}
                target["substitutions"] = {**target["substitutions"], **substitutions}
                graph(catalog, target["item_id"], target["choices"], target["substitutions"])
                self._put(db, "goals", goal_id, target)
                plans = plan_goals(catalog, stock, self._records(db, "goals"))
            reserved = {}
            for plan in plans:
                if plan["goal_id"] != goal_id:
                    for item, q in plan["reservations"].items():
                        reserved[item] = reserved.get(item, 0) + q
            for row in inputs:
                if stock[row["item_id"]] - reserved.get(row["item_id"], 0) < row["quantity"] * calls:
                    raise AlchemyError("다른 목표에 예약된 재료입니다. 목표의 우선순위·활성을 조정하세요.", 409, "reserved_inventory")
            jid = str(uuid4())
            for row in inputs:
                self._change(db, row["item_id"], delta=-row["quantity"] * calls, transaction=transaction, kind="craft_start", job=jid)
            job = {"job_id": jid, "goal_id": goal_id, "recipe": recipe, "inputs_per_call": inputs, "calls": calls,
                   "status": "in_progress", "created_at": now(), "outputs": {}, "executed_calls": None, "data_version": catalog["version"]}
            self._put(db, "jobs", jid, job)
            return {"job": job}
        if action in {"finish", "cancel", "correct"}:
            raw = db.execute("SELECT data FROM jobs WHERE job_id=?", (p.get("job_id"),)).fetchone()
            if not raw:
                raise AlchemyError("제작 작업이 없습니다.", 404)
            job = json.loads(raw[0])
            if action == "correct":
                if job["status"] != "completed" or not str(p.get("reason", "")).strip():
                    raise AlchemyError("완료한 작업과 정정 사유가 필요합니다.", 409)
                executed = job["executed_calls"]
            else:
                if job["status"] != "in_progress":
                    raise AlchemyError("이미 확정된 작업입니다. 중복 반영하지 않았습니다.", 409, "job_finalized")
                executed = 0 if action == "cancel" else integer(p.get("executed_calls", job["calls"]), "실제 수행 횟수")
                if executed > job["calls"]:
                    raise AlchemyError("수행 횟수는 시작한 횟수보다 클 수 없습니다.")
            outputs = {} if action == "cancel" else p.get("outputs")
            allowed = {job["recipe"]["output_item_id"], *job["recipe"].get("additional_output_ids", [])}
            if not isinstance(outputs, dict) or (action != "cancel" and job["recipe"]["output_item_id"] not in outputs):
                raise AlchemyError("실제 주 산출량을 0 이상으로 입력하세요.")
            for item, q in outputs.items():
                if item not in allowed:
                    raise AlchemyError("이 제작식에 등록되지 않은 산출물입니다.")
                integer(q, "실제 산출량")
                if executed == 0 and q:
                    raise AlchemyError("수행 횟수 0회에는 산출물을 등록할 수 없습니다.")
            for item, q in p.get("baseline_counts", {}).items():
                if item not in allowed or self._stock(db).get(item) is not None:
                    raise AlchemyError("제작 전 재고 확인은 미확인 산출물에만 입력하세요.")
                integer(q, "제작 전 확인 재고")
                self._change(db, item, quantity=q, absolute=True, transaction=transaction, kind="output_baseline", job=job["job_id"])
            if action != "correct":
                for row in job["inputs_per_call"]:
                    refund = row["quantity"] * (job["calls"] - executed)
                    if refund:
                        self._change(db, row["item_id"], delta=refund, transaction=transaction, kind="craft_refund", job=job["job_id"])
            before_outputs = job["outputs"] if action == "correct" else {}
            for item in allowed:
                difference = outputs.get(item, 0) - before_outputs.get(item, 0)
                if difference:
                    try:
                        self._change(db, item, delta=difference, transaction=transaction, kind="craft_correction" if action == "correct" else "craft_output", job=job["job_id"])
                    except AlchemyError as error:
                        raise AlchemyError(f"정정·완료 충돌: {error} 원장을 유지했습니다. 실제 재고를 확인한 뒤 보정 거래로 처리하세요.", 409, "output_conflict") from error
            job.update(status="cancelled" if action == "cancel" else "completed", outputs=outputs, executed_calls=executed, updated_at=now())
            self._put(db, "jobs", job["job_id"], job)
            return {"job": job, "previous_outputs": before_outputs, "reason": str(p.get("reason", ""))[:1000]}
        if action == "settings":
            settings = p.get("settings")
            if not isinstance(settings, dict) or set(settings) - {"tree_filter", "inventory_filter", "expected_yield_note"}:
                raise AlchemyError("지원하지 않는 UI 설정입니다.")
            for key, value in settings.items():
                if not isinstance(value, str) or len(value) > 1000:
                    raise AlchemyError("설정 문자열이 너무 깁니다.")
                self._put(db, "settings", key, value)
            return {"settings": settings}
        if action == "catalog":
            data = p.get("catalog")
            validate_catalog(data)
            if not set(items).issubset({i["item_id"] for i in data["items"]}):
                raise AlchemyError("기존 품목 ID를 제거할 수 없습니다.")
            self._put(db, "settings", "catalog", data)
            return {"data_version": data["version"]}
        if action == "restore":
            backup = p.get("backup")
            self.validate_backup(backup)
            # Captured inside the same write transaction, before any replacement.
            previous = self._export(db)
            db.execute("CREATE TABLE IF NOT EXISTS restore_backups (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
            backup_id = str(uuid4())
            db.execute("INSERT INTO restore_backups VALUES (?,?)", (backup_id, encode(previous)))
            for table, columns in TABLES.items():
                db.execute(f"DELETE FROM {table}")
                for row in backup["tables"][table]:
                    db.execute(f'INSERT INTO {table} ({",".join(columns)}) VALUES ({",".join("?" for _ in columns)})', tuple(row[c] for c in columns))
            self._put(db, "settings", "catalog", backup["catalog"])
            return {"restored": True, "previous_backup_id": backup_id, "source_revision": backup["source_revision"]}
        raise AlchemyError("지원하지 않는 연금 작업입니다.", 404)

    def _export(self, db):
        data = {"format": "bdo-alchemy-backup", "schema_version": SCHEMA_VERSION, "exported_at": now(),
                "source_revision": db.execute("SELECT revision FROM meta").fetchone()[0], "catalog": self.catalog(db),
                "tables": {t: [dict(r) for r in db.execute(f"SELECT * FROM {t} ORDER BY rowid")] for t in TABLES}}
        data["checksum"] = hashlib.sha256(encode(data).encode()).hexdigest()
        return data

    def export(self, backup_id=None):
        with closing(self.connect()) as db:
            if backup_id:
                try:
                    row = db.execute("SELECT data FROM restore_backups WHERE id=?", (backup_id,)).fetchone()
                except sqlite3.OperationalError:
                    row = None
                if not row:
                    raise AlchemyError("복원 전 백업이 없습니다.", 404)
                return json.loads(row[0])
            db.execute("BEGIN")
            return self._export(db)

    @staticmethod
    def validate_backup(data):
        if not isinstance(data, dict) or data.get("format") != "bdo-alchemy-backup" or data.get("schema_version") != SCHEMA_VERSION:
            raise AlchemyError("지원하지 않는 연금 백업 형식/버전입니다.")
        content = {k: v for k, v in data.items() if k != "checksum"}
        if hashlib.sha256(encode(content).encode()).hexdigest() != data.get("checksum"):
            raise AlchemyError("백업 체크섬이 맞지 않습니다.")
        items, recipes = validate_catalog(data.get("catalog"))
        integer(data.get("source_revision"), "백업 버전")
        tables = data.get("tables")
        if not isinstance(tables, dict) or set(tables) != set(TABLES):
            raise AlchemyError("백업 테이블이 누락되었거나 알 수 없는 테이블이 있습니다.")
        for table, columns in TABLES.items():
            if not isinstance(tables[table], list) or len(tables[table]) > 500_000:
                raise AlchemyError("백업 테이블 크기를 확인하세요.")
            seen = set()
            for row in tables[table]:
                if not isinstance(row, dict) or set(row) != set(columns) or not isinstance(row[columns[0]], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", row[columns[0]]) or row[columns[0]] in seen:
                    raise AlchemyError("중복 키 또는 잘못된 백업 행입니다.")
                seen.add(row[columns[0]])
                if table == "inventory":
                    if row["item_id"] not in items or not isinstance(row["checked_at"], str):
                        raise AlchemyError("백업 재고 품목이 유효하지 않습니다.")
                    if row["quantity"] is not None:
                        integer(row["quantity"])
                elif table in {"goals", "jobs", "ledger", "events"}:
                    value = json.loads(row["data"])
                    if value.get(columns[0]) != row[columns[0]]:
                        raise AlchemyError("백업 행의 고유 ID가 맞지 않습니다.")
                    if table == "goals":
                        integer(value["quantity"], minimum=1)
                        if value.get("mode") not in {"held", "additional"}:
                            raise AlchemyError("백업 목표 기준을 확인하세요.")
                        if value.get("mode") == "additional":
                            integer(value.get("baseline"))
                        graph(data["catalog"], value["item_id"], value.get("choices"), value.get("substitutions"))
                    if table == "jobs":
                        integer(value["calls"], minimum=1)
                        if value["status"] not in {"in_progress", "completed", "cancelled"}:
                            raise AlchemyError("백업 작업 상태가 잘못됐습니다.")
                        validate_catalog({**data["catalog"], "products": [], "recipes": [value["recipe"]]})
                        if any(v["item_id"] not in items for v in value["inputs_per_call"]):
                            raise AlchemyError("작업 소비 재료가 누락됐습니다.")
                        for v in value["inputs_per_call"]:
                            integer(v["quantity"], minimum=1)
                        if value["status"] != "in_progress":
                            integer(value["executed_calls"])
                            if value["executed_calls"] > value["calls"]:
                                raise AlchemyError("작업 수행 횟수가 맞지 않습니다.")
                        for item, q in value["outputs"].items():
                            if item not in {value["recipe"]["output_item_id"], *value["recipe"].get("additional_output_ids", [])}:
                                raise AlchemyError("작업 산출물이 맞지 않습니다.")
                            integer(q)
                elif table == "settings":
                    json.loads(row["value"])
                elif table == "receipts":
                    if not isinstance(row["request_hash"], str) or len(row["request_hash"]) != 64 or not isinstance(json.loads(row["response"]), dict):
                        raise AlchemyError("백업 트랜잭션 영수증이 잘못됐습니다.")
        ends = {}
        for row in tables["ledger"]:
            entry = json.loads(row["data"])
            item = entry.get("item_id")
            if item not in items or (item in ends and ends[item] != entry.get("before")):
                raise AlchemyError("백업 재고 원장의 연결이 맞지 않습니다.")
            for key in ("before", "after"):
                if entry.get(key) is not None:
                    integer(entry[key])
            expected_delta = None if entry["before"] is None or entry["after"] is None else entry["after"] - entry["before"]
            if entry.get("delta") != expected_delta:
                raise AlchemyError("원장 증감량이 맞지 않습니다.")
            ends[item] = entry["after"]
        if ends != {r["item_id"]: r["quantity"] for r in tables["inventory"]}:
            raise AlchemyError("백업 재고와 원장의 최종 수량이 일치하지 않습니다.")
        return {"valid": True, "items": len(tables["inventory"]), "goals": len(tables["goals"]), "jobs": len(tables["jobs"]), "events": len(tables["events"]), "data_version": data["catalog"]["version"]}
