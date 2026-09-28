"""Isolated SQLite and content-addressed evidence storage for recognition V2."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import tempfile
import threading
import uuid
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = 1
DEFAULT_ARTIFACT_BUDGET_BYTES = 200 * 1024 * 1024
DEFAULT_FLAGS = {
    "warehouseV2": False,
    "tradeOCR": False,
    "autoApply": False,
    "nativeCapture": False,
    "remoteFallback": False,
    "debugCapture": False,
}
DEFAULT_POLICY = {
    "parameters": {},
    "allowedStrata": [],
    "usableReviewApproved": False,
    "releaseApproved": False,
}


class RecognitionStoreError(RuntimeError):
    pass


class FutureSchemaError(RecognitionStoreError):
    pass


class ConfigConflictError(RecognitionStoreError):
    pass


class MutationConflictError(RecognitionStoreError):
    pass


class RunNotFoundError(RecognitionStoreError):
    pass


class ProfileUnavailableError(RecognitionStoreError):
    pass


def default_recognition_database_path() -> Path:
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        raise RuntimeError("LOCALAPPDATA is required for the recognition sidecar")
    return Path(local) / "BDOBarter" / "recognition" / "recognition.sqlite3"


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class RecognitionStore:
    def __init__(self, database_path: str | Path, *, artifact_budget_bytes: int = DEFAULT_ARTIFACT_BUDGET_BYTES,
                 artifact_root: str | Path | None = None):
        if type(artifact_budget_bytes) is not int or artifact_budget_bytes < 0:
            raise ValueError("artifact_budget_bytes must be a non-negative integer")
        self.database_path = Path(database_path).resolve()
        self.artifact_root = Path(artifact_root).resolve() if artifact_root else self.database_path.parent / "artifacts"
        self.artifact_budget_bytes = artifact_budget_bytes
        self._closed = False
        self._lock = threading.RLock()

    def _connect(self) -> sqlite3.Connection:
        if self._closed:
            raise RecognitionStoreError("recognition sidecar is closed")
        connection = sqlite3.connect(self.database_path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

    def close(self) -> None:
        """Prevent new work after the app has drained active recognition requests."""
        with self._lock:
            self._closed = True

    def initialize(self) -> None:
        try:
            self.database_path.parent.mkdir(parents=True, exist_ok=True)
            with self._lock, closing(self._connect()) as connection:
                tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                has_meta = "recognition_meta" in tables
                if has_meta:
                    row = connection.execute("SELECT schema_version FROM recognition_meta WHERE id=1").fetchone()
                    if row is None:
                        raise RecognitionStoreError("recognition sidecar metadata is malformed")
                    version = int(row["schema_version"])
                    if version > SCHEMA_VERSION:
                        raise FutureSchemaError("recognition sidecar schema is newer than this application")
                    if version != SCHEMA_VERSION:
                        raise RecognitionStoreError("recognition sidecar schema is unsupported")
                    required = {"capture_profile", "recognition_run", "recognition_label", "recognition_label_receipt",
                                "recognition_apply_intent", "recognition_artifact", "recognition_run_artifact"}
                    if not required <= tables:
                        raise RecognitionStoreError("recognition sidecar schema is incomplete")
                    return
                if tables:
                    raise RecognitionStoreError("unrecognized tables exist in the recognition sidecar")
                connection.executescript("""
                    BEGIN IMMEDIATE;
                    CREATE TABLE recognition_meta (
                        id INTEGER PRIMARY KEY CHECK (id=1),
                        schema_version INTEGER NOT NULL,
                        config_revision INTEGER NOT NULL,
                        config_json TEXT NOT NULL
                    );
                    CREATE TABLE capture_profile (
                        profile_id TEXT PRIMARY KEY,
                        profile_version INTEGER NOT NULL,
                        payload_json TEXT NOT NULL,
                        payload_hash TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                    CREATE TABLE recognition_run (
                        recognition_id TEXT PRIMARY KEY,
                        capture_id TEXT NOT NULL UNIQUE,
                        batch_id TEXT,
                        created_at TEXT NOT NULL,
                        task_type TEXT NOT NULL,
                        source_type TEXT NOT NULL,
                        input_hash TEXT NOT NULL,
                        crop_hash TEXT,
                        engine_hash TEXT,
                        model_hash TEXT,
                        parameter_hash TEXT,
                        profile_hash TEXT,
                        policy_hash TEXT NOT NULL,
                        config_revision INTEGER NOT NULL,
                        profile_snapshot_json TEXT,
                        report_json TEXT NOT NULL,
                        mode TEXT NOT NULL,
                        run_state TEXT NOT NULL,
                        request_hash TEXT NOT NULL,
                        raw_artifact_ref TEXT
                    );
                    CREATE TABLE recognition_label (
                        label_id TEXT PRIMARY KEY,
                        recognition_id TEXT NOT NULL REFERENCES recognition_run(recognition_id),
                        unit_id TEXT NOT NULL,
                        field_name TEXT NOT NULL,
                        label_version INTEGER NOT NULL,
                        value_json TEXT NOT NULL,
                        status TEXT NOT NULL,
                        source TEXT NOT NULL,
                        corrected INTEGER NOT NULL,
                        reason TEXT,
                        created_at TEXT NOT NULL,
                        UNIQUE(recognition_id, unit_id, field_name, label_version)
                    );
                    CREATE TABLE recognition_label_receipt (
                        label_mutation_id TEXT PRIMARY KEY,
                        request_hash TEXT NOT NULL,
                        response_json TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    );
                    CREATE TABLE recognition_apply_intent (
                        recognition_id TEXT PRIMARY KEY REFERENCES recognition_run(recognition_id),
                        mutation_id TEXT NOT NULL UNIQUE,
                        request_hash TEXT NOT NULL,
                        base_revision INTEGER NOT NULL,
                        state TEXT NOT NULL CHECK(state IN ('PREPARED','APPLIED','STALE','COMMIT_UNKNOWN')),
                        applied_revision INTEGER,
                        created_at TEXT NOT NULL
                    );
                    CREATE TABLE recognition_artifact (
                        artifact_hash TEXT PRIMARY KEY,
                        relative_path TEXT NOT NULL UNIQUE,
                        byte_size INTEGER NOT NULL,
                        media_type TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    );
                    CREATE TABLE recognition_run_artifact (
                        recognition_id TEXT NOT NULL REFERENCES recognition_run(recognition_id),
                        unit_id TEXT NOT NULL,
                        field_name TEXT NOT NULL,
                        artifact_hash TEXT NOT NULL REFERENCES recognition_artifact(artifact_hash),
                        created_at TEXT NOT NULL,
                        PRIMARY KEY(recognition_id, unit_id, field_name, artifact_hash)
                    );
                """)
                config = {"version": 1, "flags": DEFAULT_FLAGS, "profiles": [], "policy": DEFAULT_POLICY}
                connection.execute("INSERT INTO recognition_meta VALUES (1, ?, 0, ?)",
                                   (SCHEMA_VERSION, canonical_json(config)))
                connection.commit()
        except (FutureSchemaError, RecognitionStoreError):
            raise
        except (OSError, sqlite3.Error) as error:
            raise RecognitionStoreError("recognition sidecar is unavailable") from error

    def _meta(self, connection: sqlite3.Connection) -> sqlite3.Row:
        row = connection.execute("SELECT schema_version, config_revision, config_json FROM recognition_meta WHERE id=1").fetchone()
        if row is None or int(row["schema_version"]) != SCHEMA_VERSION:
            raise RecognitionStoreError("recognition sidecar schema is unavailable")
        return row

    def get_config(self) -> dict[str, Any]:
        try:
            with closing(self._connect()) as connection:
                row = self._meta(connection)
                payload = json.loads(row["config_json"])
                return {**payload, "configRevision": int(row["config_revision"])}
        except sqlite3.Error as error:
            raise RecognitionStoreError("recognition sidecar is unavailable") from error

    def update_config(self, expected_revision: int, flags: dict[str, bool], profiles: Sequence[dict[str, Any]]) -> dict[str, Any]:
        requested_config = {"version": 1, "flags": flags, "profiles": list(profiles), "policy": DEFAULT_POLICY}
        encoded = canonical_json(requested_config)
        stamp = _utc_now()
        try:
            with self._lock, closing(self._connect()) as connection:
                connection.execute("BEGIN IMMEDIATE")
                meta = self._meta(connection)
                if int(meta["config_revision"]) != expected_revision:
                    raise ConfigConflictError("recognition config revision is stale")
                old_profiles = {row["profile_id"]: row for row in connection.execute("SELECT * FROM capture_profile")}
                new_profiles = {profile["id"]: profile for profile in profiles}
                for profile_id, profile in new_profiles.items():
                    previous = old_profiles.get(profile_id)
                    payload = canonical_json(profile)
                    digest = sha256_bytes(payload.encode("utf-8"))
                    if previous:
                        old_payload = previous["payload_json"]
                        old_version = int(previous["profile_version"])
                        if payload != old_payload and profile["profileVersion"] != old_version + 1:
                            raise ConfigConflictError("profile version must advance by one when its content changes")
                        if payload == old_payload and profile["profileVersion"] != old_version:
                            raise ConfigConflictError("unchanged profile version cannot change")
                        connection.execute("UPDATE capture_profile SET profile_version=?, payload_json=?, payload_hash=?, updated_at=? WHERE profile_id=?",
                                           (profile["profileVersion"], payload, digest, stamp, profile_id))
                    else:
                        if profile["profileVersion"] != 1:
                            raise ConfigConflictError("new profiles must start at version one")
                        connection.execute("INSERT INTO capture_profile VALUES (?, ?, ?, ?, ?)",
                                           (profile_id, profile["profileVersion"], payload, digest, stamp))
                for profile_id in set(old_profiles) - set(new_profiles):
                    connection.execute("DELETE FROM capture_profile WHERE profile_id=?", (profile_id,))
                changed = connection.execute("UPDATE recognition_meta SET config_revision=config_revision+1, config_json=? WHERE id=1 AND config_revision=?",
                                             (encoded, expected_revision)).rowcount
                if changed != 1:
                    raise ConfigConflictError("recognition config revision is stale")
                connection.commit()
                return {**requested_config, "configRevision": expected_revision + 1}
        except (ConfigConflictError, RecognitionStoreError):
            raise
        except sqlite3.Error as error:
            raise RecognitionStoreError("recognition sidecar is unavailable") from error

    def create_run(self, metadata: dict[str, Any], *, input_hash: str,
                   run_state: str = "UNSUPPORTED_FEATURE") -> tuple[dict[str, Any], bool]:
        if not isinstance(input_hash, str) or len(input_hash) != 64 or any(char not in "0123456789abcdef" for char in input_hash.lower()):
            raise ValueError("input_hash must be SHA-256 hex")
        if run_state != "UNSUPPORTED_FEATURE":
            raise ValueError("unsupported run state")
        request_hash = sha256_bytes(canonical_json({"metadata": metadata, "inputHash": input_hash}).encode("utf-8"))
        try:
            with self._lock, closing(self._connect()) as connection:
                connection.execute("BEGIN IMMEDIATE")
                existing = connection.execute("SELECT * FROM recognition_run WHERE capture_id=?", (metadata["captureId"],)).fetchone()
                if existing:
                    if existing["request_hash"] != request_hash:
                        raise MutationConflictError("capture ID was reused with different content")
                    connection.commit()
                    return self._run_response(existing), False
                meta = self._meta(connection)
                config = json.loads(meta["config_json"])
                profile = None
                profile_hash = None
                if metadata.get("profileId"):
                    profile_row = connection.execute("SELECT * FROM capture_profile WHERE profile_id=?", (metadata["profileId"],)).fetchone()
                    if profile_row is None or int(profile_row["profile_version"]) != metadata["profileVersion"]:
                        raise ProfileUnavailableError("capture profile is unavailable")
                    profile = json.loads(profile_row["payload_json"])
                    profile_hash = profile_row["payload_hash"]
                policy_hash = sha256_bytes(canonical_json(config["policy"]).encode("utf-8"))
                recognition_id = str(uuid.uuid4())
                created_at = _utc_now()
                report_payload = {
                    "version": 2,
                    "recognitionId": recognition_id,
                    "captureId": metadata["captureId"],
                    "taskType": metadata["taskType"],
                    "sourceType": metadata["sourceType"],
                    "runState": run_state,
                    "captureMetadata": metadata,
                    "input": {"sha256": input_hash, "width": metadata["frame"]["width"],
                              "height": metadata["frame"]["height"], "fidelity": metadata["fidelity"]},
                    "profileId": metadata["profileId"],
                    "profileVersion": metadata["profileVersion"],
                    "profileHash": profile_hash,
                    "profileSnapshot": profile,
                    "configRevision": int(meta["config_revision"]),
                    "automationDecision": "REJECT",
                    "automationEligible": False,
                    "reasonCodes": ["RECOGNIZER_UNAVAILABLE"],
                    "slots": [],
                    "rows": [],
                }
                connection.execute("""INSERT INTO recognition_run(
                    recognition_id,capture_id,batch_id,created_at,task_type,source_type,input_hash,
                    engine_hash,model_hash,parameter_hash,profile_hash,policy_hash,config_revision,
                    profile_snapshot_json,report_json,mode,run_state,request_hash
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (recognition_id, metadata["captureId"], metadata["batchId"], created_at, metadata["taskType"],
                     metadata["sourceType"], input_hash, None, None, None, profile_hash, policy_hash,
                     int(meta["config_revision"]), canonical_json(profile) if profile else None,
                     canonical_json(report_payload), "unsupported", run_state, request_hash))
                row = connection.execute("SELECT * FROM recognition_run WHERE recognition_id=?", (recognition_id,)).fetchone()
                connection.commit()
                return self._run_response(row), True
        except (MutationConflictError, RecognitionStoreError):
            raise
        except sqlite3.Error as error:
            raise RecognitionStoreError("recognition sidecar is unavailable") from error

    @staticmethod
    def _run_response(row: sqlite3.Row) -> dict[str, Any]:
        return {"recognitionId": row["recognition_id"], "captureId": row["capture_id"],
                "runState": row["run_state"], "inputHash": row["input_hash"],
                "createdAt": row["created_at"], "report": json.loads(row["report_json"])}

    def get_run(self, recognition_id: str) -> dict[str, Any] | None:
        try:
            with closing(self._connect()) as connection:
                row = connection.execute("SELECT * FROM recognition_run WHERE recognition_id=?", (recognition_id,)).fetchone()
                return self._run_response(row) if row else None
        except sqlite3.Error as error:
            raise RecognitionStoreError("recognition sidecar is unavailable") from error

    def write_labels(self, recognition_id: str, payload: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        request_hash = sha256_bytes(canonical_json({"recognitionId": recognition_id, "payload": payload}).encode("utf-8"))
        mutation_id = payload["labelMutationId"]
        try:
            with self._lock, closing(self._connect()) as connection:
                connection.execute("BEGIN IMMEDIATE")
                receipt = connection.execute("SELECT request_hash,response_json FROM recognition_label_receipt WHERE label_mutation_id=?", (mutation_id,)).fetchone()
                if receipt:
                    if receipt["request_hash"] != request_hash:
                        raise MutationConflictError("label mutation ID was reused with different content")
                    connection.commit()
                    return json.loads(receipt["response_json"]), True
                if connection.execute("SELECT 1 FROM recognition_run WHERE recognition_id=?", (recognition_id,)).fetchone() is None:
                    raise RunNotFoundError("recognition run is unavailable")
                created = []
                for row in payload["rows"]:
                    for field_name, label in row["fields"].items():
                        previous = connection.execute("SELECT label_version,value_json FROM recognition_label WHERE recognition_id=? AND unit_id=? AND field_name=? ORDER BY label_version DESC",
                                                      (recognition_id, row["unitId"], field_name)).fetchall()
                        version = int(previous[0]["label_version"]) + 1 if previous else 1
                        value_json = canonical_json(label["value"])
                        disputed = any(item["value_json"] != value_json for item in previous)
                        status = "DISPUTED" if disputed else "HUMAN_VERIFIED"
                        label_id = str(uuid.uuid4())
                        connection.execute("""INSERT INTO recognition_label(
                            label_id,recognition_id,unit_id,field_name,label_version,value_json,status,source,corrected,reason,created_at
                        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                            (label_id, recognition_id, row["unitId"], field_name, version, value_json,
                             status, "user_correction", 1, label["reason"], _utc_now()))
                        created.append({"labelId": label_id, "unitId": row["unitId"], "field": field_name,
                                        "labelVersion": version, "status": status})
                response = {"ok": True, "recognitionId": recognition_id, "labels": created, "duplicate": False}
                connection.execute("INSERT INTO recognition_label_receipt VALUES (?, ?, ?, ?)",
                                   (mutation_id, request_hash, canonical_json(response), _utc_now()))
                connection.commit()
                return response, False
        except (MutationConflictError, RunNotFoundError):
            raise
        except sqlite3.Error as error:
            raise RecognitionStoreError("recognition sidecar is unavailable") from error

    def store_evidence(self, run: Mapping[str, Any], crops: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        """Persist bounded crop artifacts under content hashes; never accepts caller paths."""
        recognition_id = run.get("recognitionId")
        if not isinstance(recognition_id, str) or self.get_run(recognition_id) is None:
            raise RunNotFoundError("recognition run is unavailable")
        refs: list[dict[str, str]] = []
        missing: list[str] = []
        for crop in crops:
            unit_id, field_name, payload = crop.get("unitId"), crop.get("field"), crop.get("pngBytes")
            if not isinstance(unit_id, str) or not unit_id or len(unit_id) > 128 or not isinstance(field_name, str) or field_name not in {"panel", "layout", "item", "quantity"}:
                missing.append("INVALID_EVIDENCE_METADATA")
                continue
            if not isinstance(payload, bytes) or not payload:
                missing.append("EVIDENCE_BYTES_UNAVAILABLE")
                continue
            digest = sha256_bytes(payload)
            relative = f"artifacts/{digest}.png"
            try:
                self._store_artifact(recognition_id, unit_id, field_name, digest, relative, payload)
            except _ArtifactBudgetExceeded:
                missing.append("ARTIFACT_BUDGET_EXCEEDED")
                continue
            except (OSError, sqlite3.Error, RecognitionStoreError):
                missing.append("ARTIFACT_STORE_FAILED")
                continue
            refs.append({"sha256": digest, "ref": relative, "unitId": unit_id, "field": field_name})
        return {"artifactRefs": refs, "evidenceIncomplete": bool(missing),
                "artifactMissingReasons": sorted(set(missing))}

    def _store_artifact(self, recognition_id: str, unit_id: str, field_name: str,
                        digest: str, relative: str, payload: bytes) -> None:
        with self._lock, closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute("SELECT * FROM recognition_artifact WHERE artifact_hash=?", (digest,)).fetchone()
            target = self.artifact_root / f"{digest}.png"
            if existing is None:
                used = int(connection.execute("SELECT COALESCE(SUM(byte_size),0) FROM recognition_artifact").fetchone()[0])
                if used + len(payload) > self.artifact_budget_bytes:
                    connection.rollback()
                    raise _ArtifactBudgetExceeded
            created_file = False
            if not target.exists():
                self.artifact_root.mkdir(parents=True, exist_ok=True)
                temp_path = None
                try:
                    with tempfile.NamedTemporaryFile(prefix=".evidence-", suffix=".tmp", dir=self.artifact_root, delete=False) as temporary:
                        temp_path = Path(temporary.name)
                        temporary.write(payload)
                        temporary.flush()
                        os.fsync(temporary.fileno())
                    os.replace(temp_path, target)
                    created_file = True
                finally:
                    if temp_path is not None and temp_path.exists():
                        temp_path.unlink()
            stamp = _utc_now()
            try:
                connection.execute("INSERT OR IGNORE INTO recognition_artifact VALUES (?, ?, ?, ?, ?)",
                                   (digest, relative, len(payload), "image/png", stamp))
                connection.execute("INSERT OR IGNORE INTO recognition_run_artifact VALUES (?, ?, ?, ?, ?)",
                                   (recognition_id, unit_id, field_name, digest, stamp))
                connection.commit()
            except Exception:
                connection.rollback()
                if created_file:
                    target.unlink(missing_ok=True)
                raise

    def cleanup_unlabelled_artifacts(self, *, now: datetime | None = None, retention_days: int = 30) -> int:
        """Explicit cleanup only; this method is never called automatically."""
        if type(retention_days) is not int or retention_days < 1:
            raise ValueError("retention_days must be a positive integer")
        cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=retention_days)
        cutoff_text = cutoff.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        paths: list[Path] = []
        try:
            with self._lock, closing(self._connect()) as connection:
                connection.execute("BEGIN IMMEDIATE")
                rows = connection.execute("""SELECT a.artifact_hash,a.relative_path FROM recognition_artifact a
                    WHERE a.created_at < ? AND NOT EXISTS (
                      SELECT 1 FROM recognition_run_artifact ra JOIN recognition_label l
                      ON l.recognition_id=ra.recognition_id WHERE ra.artifact_hash=a.artifact_hash
                    )""", (cutoff_text,)).fetchall()
                for row in rows:
                    paths.append(self.artifact_root / f"{row['artifact_hash']}.png")
                    connection.execute("DELETE FROM recognition_run_artifact WHERE artifact_hash=?", (row["artifact_hash"],))
                    connection.execute("DELETE FROM recognition_artifact WHERE artifact_hash=?", (row["artifact_hash"],))
                connection.commit()
            removed = 0
            for path in paths:
                try:
                    path.unlink(missing_ok=True)
                    removed += 1
                except OSError:
                    pass
            return removed
        except sqlite3.Error as error:
            raise RecognitionStoreError("recognition sidecar is unavailable") from error


class _ArtifactBudgetExceeded(Exception):
    pass
