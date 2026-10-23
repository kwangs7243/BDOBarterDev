"""SQLite durable data, current working snapshot, and explicit schedule slots."""
from __future__ import annotations

import json
import os
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any, Callable

SCHEMA_VERSION = 4
MAX_SAFE_INTEGER = 9_007_199_254_740_991
SETTINGS_SECTIONS = ("inventoryOrder", "tierRules", "ship", "parley", "shipPresets", "tuning", "navigation", "mapSlots", "mapBase", "viewer")


class RevisionConflict(Exception):
    pass


class MutationConflict(Exception):
    pass


def repository_root() -> Path:
    return Path(__file__).resolve().parents[2]


def default_database_path() -> Path:
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        raise RuntimeError("LOCALAPPDATA is required for persistent user data")
    return Path(local) / "BDOBarter" / "data" / "bdo.sqlite3"


def load_catalog(reference_path: Path | None = None) -> tuple[dict[str, int], dict[str, list[str]]]:
    path = reference_path or repository_root() / "reference" / "barter_items.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    items = data.get("items")
    if not isinstance(items, list) or len(items) != 70:
        raise RuntimeError("reference catalog must contain exactly 70 inventory items")
    catalog: dict[str, int] = {}
    order = {str(tier): [] for tier in range(1, 6)}
    for item in items:
        name, tier = item.get("programName"), item.get("tier")
        if not isinstance(name, str) or type(tier) is not int or tier not in range(1, 6) or name in catalog:
            raise RuntimeError("reference catalog contains an invalid or duplicate programName/tier")
        catalog[name] = tier
        order[str(tier)].append(name)
    if any(len(names) != 14 for names in order.values()):
        raise RuntimeError("reference catalog must contain 14 items per tier")
    return catalog, order


def _default_settings(order: dict[str, list[str]]) -> dict[str, Any]:
    return {
        "inventoryOrder": order,
        "tierRules": {"1": 20, "2": 20, "3": 20, "4": 20, "5": 2},
        "ship": {"normalWeight": 14379, "maxWeight": 24445, "speed": 170, "mode": "inner"},
        "parley": {"defaultBudget": 1500000, "normalCost": 10973, "crowCost": 15962},
        "shipPresets": {"1": None, "2": None, "3": None, "4": None},
        "tuning": {
            "specialMatPriority": 80000, "crowCoinPriority": 30000,
            "pathEfficiencyBonus": 20000, "smallTradePenalty": 20000,
            "chainMaxDistance": 100, "chainBonusScore": 10000,
            "distancePenaltyWeight": 4, "overloadPenalty": 1.6,
            "efficiencyThreshold": 100, "iliyaPitstopRadius": 599,
            "overloadTimeWeight": 1.5, "deficitRatioBonus": 10000,
            "emergencyBonus": 10000, "preservationBonus": 10000,
            "westBias": 10, "useClustering": 20000,
            "tierPriority": {"T1": 0, "T2": 2000, "T3": 2900, "T4": 4500, "T5": 8000},
            "excludeSurplus": {},
        },
        "navigation": {"coords": {}, "routeCalibrations": {}, "memos": []},
        "mapSlots": {"1": None, "2": None, "3": None},
        "mapBase": None,
        "viewer": {"uiZoom": 100, "panels": {}},
    }


class Storage:
    def __init__(self, database_path: Path, catalog: dict[str, int], order: dict[str, list[str]]):
        self.database_path = Path(database_path)
        self.catalog = catalog
        self.order = order

    def connect(self) -> sqlite3.Connection:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.database_path, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA synchronous = FULL")
        return connection

    def initialize(self) -> None:
        defaults = _default_settings(self.order)
        with closing(self.connect()) as connection:
            connection.execute("PRAGMA journal_mode = DELETE")
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    """CREATE TABLE IF NOT EXISTS inventory (
                        program_name TEXT PRIMARY KEY,
                        stock INTEGER NULL CHECK (stock IS NULL OR (stock >= 0 AND stock <= 9007199254740991)),
                        target INTEGER NOT NULL CHECK (target >= 0 AND target <= 9007199254740991)
                    )"""
                )
                connection.execute(
                    """CREATE TABLE IF NOT EXISTS settings (
                        section TEXT PRIMARY KEY,
                        payload_json TEXT NOT NULL
                    )"""
                )
                connection.execute(
                    """CREATE TABLE IF NOT EXISTS app_meta (
                        id INTEGER PRIMARY KEY CHECK (id = 1),
                        schema_version INTEGER NOT NULL,
                        revision INTEGER NOT NULL CHECK (revision >= 0),
                        last_mutation_id TEXT NULL,
                        last_mutation_hash TEXT NULL
                    )"""
                )
                row = connection.execute("SELECT schema_version FROM app_meta WHERE id = 1").fetchone()
                if row is not None and row["schema_version"] != SCHEMA_VERSION:
                    raise RuntimeError(f"unsupported database schema version: {row['schema_version']}")
                connection.execute("""CREATE TABLE IF NOT EXISTS working_session (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    payload_json TEXT NOT NULL, revision INTEGER NOT NULL
                )""")
                connection.execute("""CREATE TABLE IF NOT EXISTS saved_schedule_slot (
                    slot INTEGER PRIMARY KEY CHECK (slot BETWEEN 1 AND 5),
                    payload_json TEXT NOT NULL
                )""")
                connection.execute("""CREATE TABLE IF NOT EXISTS mutation_receipt (
                    mutation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
                    revision INTEGER NOT NULL UNIQUE
                )""")
                connection.execute("""CREATE TABLE IF NOT EXISTS warehouse_scan (
                    scan_id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
                    image_png BLOB NOT NULL, report_json TEXT NOT NULL, provenance_json TEXT NOT NULL
                )""")
                connection.execute("""CREATE TABLE IF NOT EXISTS warehouse_feedback (
                    mutation_id TEXT PRIMARY KEY, scan_id TEXT NOT NULL REFERENCES warehouse_scan(scan_id),
                    created_at TEXT NOT NULL, feedback_json TEXT NOT NULL, applied_items_json TEXT NOT NULL
                )""")
                connection.execute("""CREATE TABLE IF NOT EXISTS trade_correction (
                    feedback_id TEXT NOT NULL, capture_id TEXT NOT NULL,
                    request_hash TEXT NOT NULL, created_at TEXT NOT NULL,
                    image_png BLOB NOT NULL, details_json TEXT NOT NULL,
                    PRIMARY KEY (feedback_id, capture_id)
                )""")
                connection.execute(
                    "INSERT OR IGNORE INTO app_meta (id, schema_version, revision, last_mutation_id, last_mutation_hash) VALUES (1, ?, 0, NULL, NULL)",
                    (SCHEMA_VERSION,),
                )
                for name, tier in self.catalog.items():
                    target = 80 if tier <= 4 else 5
                    connection.execute(
                        "INSERT OR IGNORE INTO inventory (program_name, stock, target) VALUES (?, NULL, ?)",
                        (name, target),
                    )
                for section, payload in defaults.items():
                    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                    connection.execute(
                        "INSERT OR IGNORE INTO settings (section, payload_json) VALUES (?, ?)",
                        (section, encoded),
                    )
                connection.commit()
            except Exception:
                connection.rollback()
                raise

    def revision(self, connection: sqlite3.Connection | None = None) -> int:
        if connection is not None:
            row = connection.execute("SELECT revision FROM app_meta WHERE id = 1").fetchone()
            return int(row["revision"])
        with closing(self.connect()) as owned:
            return self.revision(owned)

    def get_inventory(self) -> list[dict[str, Any]]:
        with closing(self.connect()) as connection:
            return self.get_inventory_with_connection(connection)

    def get_settings(self, connection: sqlite3.Connection | None = None) -> dict[str, Any]:
        if connection is None:
            with closing(self.connect()) as owned:
                return self.get_settings(owned)
        rows = connection.execute("SELECT section, payload_json FROM settings").fetchall()
        return {row["section"]: json.loads(row["payload_json"]) for row in rows}

    def get_order(self) -> dict[str, list[str]]:
        with closing(self.connect()) as connection:
            payload = connection.execute("SELECT payload_json FROM settings WHERE section = 'inventoryOrder'").fetchone()
            return json.loads(payload["payload_json"])

    def bootstrap(self) -> dict[str, Any]:
        with closing(self.connect()) as connection:
            connection.execute("BEGIN")
            meta = connection.execute("SELECT schema_version, revision FROM app_meta WHERE id = 1").fetchone()
            settings = self.get_settings(connection)
            session = connection.execute("SELECT payload_json, revision FROM working_session WHERE id = 1").fetchone()
            return {
                "schemaVersion": meta["schema_version"],
                "revision": meta["revision"],
                "inventory": self.get_inventory_with_connection(connection),
                "order": settings["inventoryOrder"],
                "settings": settings,
                "workingSession": json.loads(session["payload_json"]) if session else None,
                "sessionRevision": session["revision"] if session else None,
                "scheduleSlots": {str(slot): self._slot(connection, slot) for slot in range(1, 6)},
            }

    @staticmethod
    def _slot(connection: sqlite3.Connection, slot: int) -> dict[str, Any] | None:
        row = connection.execute("SELECT payload_json FROM saved_schedule_slot WHERE slot = ?", (slot,)).fetchone()
        return json.loads(row["payload_json"]) if row else None

    def get_inventory_with_connection(self, connection: sqlite3.Connection) -> list[dict[str, Any]]:
        rows = connection.execute("SELECT program_name, stock, target FROM inventory").fetchall()
        saved_order = self.get_settings(connection)["inventoryOrder"]

        def order_key(row):
            name = row["program_name"]
            tier = self.catalog[name]
            names = saved_order[str(tier)]
            position = names.index(name) if name in names else len(names) + self.order[str(tier)].index(name)
            return tier, position

        return [
            {"programName": row["program_name"], "tier": self.catalog[row["program_name"]], "stock": row["stock"], "target": row["target"]}
            for row in sorted(rows, key=order_key)
        ]

    def mutate(self, mutation_id: str, base_revision: int, request_hash: str, action: Callable[[sqlite3.Connection], None]) -> tuple[int, bool]:
        with closing(self.connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                meta = connection.execute("SELECT revision, last_mutation_id, last_mutation_hash FROM app_meta WHERE id = 1").fetchone()
                receipt = connection.execute("SELECT request_hash, revision FROM mutation_receipt WHERE mutation_id = ?", (mutation_id,)).fetchone()
                if receipt:
                    if receipt["request_hash"] != request_hash:
                        raise MutationConflict("mutationId was already used for a different request")
                    connection.rollback()
                    return int(meta["revision"]), True
                if meta["last_mutation_id"] == mutation_id:
                    if meta["last_mutation_hash"] != request_hash:
                        raise MutationConflict("mutationId was already used for a different request")
                    connection.rollback()
                    return int(meta["revision"]), True
                if meta["revision"] != base_revision:
                    raise RevisionConflict(f"baseRevision {base_revision} is stale; current revision is {meta['revision']}")
                action(connection)
                next_revision = int(meta["revision"]) + 1
                connection.execute(
                    "UPDATE app_meta SET revision = ?, last_mutation_id = ?, last_mutation_hash = ? WHERE id = 1",
                    (next_revision, mutation_id, request_hash),
                )
                connection.execute("INSERT INTO mutation_receipt VALUES (?, ?, ?)", (mutation_id, request_hash, next_revision))
                connection.execute("DELETE FROM mutation_receipt WHERE revision <= ?", (next_revision - 128,))
                connection.commit()
                return next_revision, False
            except Exception:
                connection.rollback()
                raise

    def update_inventory(self, updates: dict[str, dict[str, int]], mutation_id: str, base_revision: int, request_hash: str, feedback: dict | None = None) -> tuple[int, bool]:
        def apply(connection: sqlite3.Connection) -> None:
            if feedback is not None:
                from .warehouse_feedback import validate_feedback
                corrected_feedback = validate_feedback(connection, feedback, updates, self.catalog)
                connection.execute("INSERT INTO warehouse_feedback VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?)", (mutation_id, feedback["scanId"], json.dumps(corrected_feedback, ensure_ascii=False), json.dumps(updates, ensure_ascii=False)))
            for name, fields in updates.items():
                assignments = ", ".join(f"{column} = ?" for column in fields)
                values = list(fields.values()) + [name]
                cursor = connection.execute(f"UPDATE inventory SET {assignments} WHERE program_name = ?", values)
                if cursor.rowcount != 1:
                    raise RuntimeError(f"inventory item disappeared: {name}")
        return self.mutate(mutation_id, base_revision, request_hash, apply)

    def update_order(self, order: dict[str, list[str]], mutation_id: str, base_revision: int, request_hash: str) -> tuple[int, bool]:
        def apply(connection: sqlite3.Connection) -> None:
            encoded = json.dumps(order, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            connection.execute("UPDATE settings SET payload_json = ? WHERE section = 'inventoryOrder'", (encoded,))
        return self.mutate(mutation_id, base_revision, request_hash, apply)

    def update_settings(self, sections: dict[str, dict[str, Any]], mutation_id: str, base_revision: int, request_hash: str) -> tuple[int, bool]:
        def apply(connection: sqlite3.Connection) -> None:
            for section, payload in sections.items():
                encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                cursor = connection.execute("UPDATE settings SET payload_json = ? WHERE section = ?", (encoded, section))
                if cursor.rowcount != 1:
                    raise RuntimeError(f"settings section disappeared: {section}")
        return self.mutate(mutation_id, base_revision, request_hash, apply)

    def update_session(self, payload: dict[str, Any] | None, mutation_id: str, base_revision: int, request_hash: str) -> tuple[int, bool]:
        """Replace the single working snapshot, or reset it without touching durable data/slots."""
        def apply(connection: sqlite3.Connection) -> None:
            if payload is None:
                connection.execute("DELETE FROM working_session WHERE id = 1")
            else:
                encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                connection.execute("INSERT INTO working_session VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, revision = excluded.revision", (encoded, base_revision + 1))
        return self.mutate(mutation_id, base_revision, request_hash, apply)

    def update_slot(self, slot: int, payload: dict[str, Any] | None, mutation_id: str, base_revision: int, request_hash: str) -> tuple[int, bool]:
        def apply(connection: sqlite3.Connection) -> None:
            if payload is None:
                connection.execute("DELETE FROM saved_schedule_slot WHERE slot = ?", (slot,))
            else:
                encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                connection.execute("INSERT INTO saved_schedule_slot VALUES (?, ?) ON CONFLICT(slot) DO UPDATE SET payload_json = excluded.payload_json", (slot, encoded))
        return self.mutate(mutation_id, base_revision, request_hash, apply)

    def complete_session(self, updates: dict[str, dict[str, int]], payload: dict[str, Any], session_revision: int, mutation_id: str, base_revision: int, request_hash: str) -> tuple[int, bool]:
        """Commit one browser-computed completion and its working snapshot atomically."""
        def apply(connection: sqlite3.Connection) -> None:
            row = connection.execute("SELECT payload_json, revision FROM working_session WHERE id = 1").fetchone()
            if row is None or row["revision"] != session_revision or json.loads(row["payload_json"])["id"] != payload["id"]:
                raise RevisionConflict("The working session changed; reload before completing another trade")
            for name, fields in updates.items():
                cursor = connection.execute("UPDATE inventory SET stock = ? WHERE program_name = ?", (fields["stock"], name))
                if cursor.rowcount != 1:
                    raise RuntimeError(f"inventory item disappeared: {name}")
            encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            connection.execute("UPDATE working_session SET payload_json = ?, revision = ? WHERE id = 1", (encoded, base_revision + 1))
        return self.mutate(mutation_id, base_revision, request_hash, apply)

    def record_warehouse_scan(self, image: bytes, report: dict, provenance: dict) -> str:
        """Preserve scanner input/output without changing inventory or its revision."""
        from uuid import uuid4
        scan_id = str(uuid4())
        with closing(self.connect()) as connection:
            connection.execute("INSERT INTO warehouse_scan VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, ?)",
                               (scan_id, image, json.dumps(report, ensure_ascii=False, allow_nan=False), json.dumps(provenance, ensure_ascii=False)))
        return scan_id

    def record_trade_corrections(self, feedback, captures):
        """Keep human corrections independently of the working-state revision."""
        import hashlib
        encoded = json.dumps(feedback, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        digest = hashlib.sha256(encoded.encode("utf-8"))
        for capture in captures:
            digest.update(capture["imageBytes"])
        request_hash = digest.hexdigest()
        with closing(self.connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                previous = connection.execute("SELECT request_hash FROM trade_correction WHERE feedback_id = ?",
                                              (feedback["feedbackId"],)).fetchone()
                if previous:
                    if previous["request_hash"] != request_hash:
                        raise MutationConflict("correction feedback ID was reused for different values")
                    connection.rollback()
                    return False
                for capture in captures:
                    details = {"metadata": capture["metadata"], "engineId": feedback["engineId"],
                               "modelVersion": feedback["modelVersion"], "workerVersion": feedback["workerVersion"],
                               "corrections": [row for row in feedback["corrections"]
                                               if row["captureId"] == capture["captureId"]]}
                    if "snapshot" in feedback:
                        snapshot = feedback["snapshot"]
                        result = snapshot["result"]
                        details["snapshot"] = {"phase": snapshot["phase"], "batchId": result["batchId"],
                                               "runtime": result.get("runtime"),
                                               "rows": [row for row in result["rows"] if row["captureId"] == capture["captureId"]]}
                    connection.execute("""INSERT INTO trade_correction VALUES
                        (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?)""",
                        (feedback["feedbackId"], capture["captureId"], request_hash, capture["imageBytes"],
                         json.dumps(details, ensure_ascii=False, allow_nan=False)))
                connection.commit()
                return True
            except Exception:
                connection.rollback()
                raise
