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


SCHEMA_VERSION = 3
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


class EvidenceIntegrityError(RecognitionStoreError):
    pass


class CropLinkConflictError(MutationConflictError):
    pass


class ProfileUnavailableError(RecognitionStoreError):
    pass


TRADE_REVIEW_SCHEMA = (
    """CREATE TABLE trade_review_observation (
        observation_id TEXT PRIMARY KEY, mutation_id TEXT NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL CHECK(schema_version=1), recognition_batch_id TEXT NOT NULL,
        projection_hash TEXT NOT NULL, registry_version TEXT NOT NULL, correction_version TEXT NOT NULL,
        review_revision INTEGER NOT NULL CHECK(review_revision>=0), confirmation_revision INTEGER NOT NULL CHECK(confirmation_revision=1),
        supersedes_observation_id TEXT CHECK(supersedes_observation_id IS NULL), created_at TEXT NOT NULL,
        persisted_at TEXT NOT NULL, hash_basis TEXT NOT NULL CHECK(hash_basis='PY_CANONICAL_JSON_V1'),
        payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, observation_hash TEXT NOT NULL, receipt_json TEXT NOT NULL
    )""",
    "CREATE INDEX trade_review_observation_batch ON trade_review_observation(recognition_batch_id,persisted_at)",
    """CREATE TABLE trade_review_artifact (
        observation_id TEXT NOT NULL REFERENCES trade_review_observation(observation_id),
        projection_row_id TEXT NOT NULL, field_name TEXT NOT NULL CHECK(field_name IN ('island','fromItem','reqAmount','toItem','count','yield')),
        artifact_hash TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size>0), width INTEGER NOT NULL CHECK(width>0),
        height INTEGER NOT NULL CHECK(height>0), verification_method TEXT NOT NULL CHECK(verification_method IN
        ('USER_BATCH_CONFIRMED_UNCHANGED','USER_EDITED','USER_MARKED_UNKNOWN')),
        state TEXT NOT NULL CHECK(state IN ('AVAILABLE','EXPIRED','MISSING')), attached_at TEXT NOT NULL, expired_at TEXT,
        PRIMARY KEY(observation_id,projection_row_id,field_name)
    )""",
    "CREATE INDEX trade_review_artifact_hash ON trade_review_artifact(artifact_hash,state)",
    """CREATE TABLE trade_review_crop_receipt (
        crop_mutation_id TEXT PRIMARY KEY, observation_id TEXT NOT NULL REFERENCES trade_review_observation(observation_id),
        request_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL
    )""",
)


TRADE_REVIEW_V3_SCHEMA = (
    """CREATE TABLE trade_review_observation_v3 (
        observation_id TEXT NOT NULL PRIMARY KEY, mutation_id TEXT NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL CHECK(schema_version=3),
        review_mode TEXT NOT NULL CHECK(review_mode='FINAL_CORRECTED_RESULT'),
        recognition_batch_id TEXT NOT NULL, projection_hash TEXT NOT NULL CHECK(length(projection_hash)=64),
        master_schema_version INTEGER NOT NULL CHECK(master_schema_version=2), registry_version TEXT NOT NULL,
        master_content_hash TEXT NOT NULL CHECK(length(master_content_hash)=64), correction_version TEXT NOT NULL,
        review_revision INTEGER NOT NULL CHECK(review_revision>=0),
        confirmation_revision INTEGER NOT NULL CHECK(confirmation_revision=1),
        supersedes_observation_id TEXT REFERENCES trade_review_observation_v3(observation_id),
        created_at TEXT NOT NULL, persisted_at TEXT NOT NULL,
        hash_basis TEXT NOT NULL CHECK(hash_basis='TRADE_OBSERVATION_JSON_V3'),
        payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
        observation_hash TEXT NOT NULL CHECK(length(observation_hash)=64), receipt_json TEXT NOT NULL,
        CHECK(supersedes_observation_id IS NULL OR supersedes_observation_id<>observation_id)
    )""",
    "CREATE INDEX trade_review_observation_v3_batch ON trade_review_observation_v3(recognition_batch_id,persisted_at)",
    """CREATE TABLE trade_review_artifact_v3 (
        observation_id TEXT NOT NULL REFERENCES trade_review_observation_v3(observation_id),
        projection_row_id TEXT NOT NULL,
        field_name TEXT NOT NULL CHECK(field_name IN ('island','fromItem','reqAmount','toItem','count','yield')),
        crop_ref_id TEXT NOT NULL, artifact_hash TEXT NOT NULL REFERENCES recognition_artifact(artifact_hash),
        pixel_sha256 TEXT NOT NULL CHECK(length(pixel_sha256)=64), byte_size INTEGER NOT NULL CHECK(byte_size>0),
        width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 1024), height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 256),
        operational_decision TEXT NOT NULL CHECK(operational_decision IN ('CANDIDATE_RETAINED','USER_EDITED','USER_MARKED_UNKNOWN')),
        retention_class TEXT NOT NULL CHECK(retention_class IN ('OPERATIONAL_REVIEW_EVIDENCE','UNKNOWN_EVIDENCE')),
        state TEXT NOT NULL CHECK(state IN ('AVAILABLE','EXPIRED','MISSING')),
        attached_at TEXT NOT NULL, expired_at TEXT,
        PRIMARY KEY(observation_id,projection_row_id,field_name), CHECK(width*height<=262144),
        CHECK((operational_decision='USER_MARKED_UNKNOWN' AND retention_class='UNKNOWN_EVIDENCE') OR
              (operational_decision<>'USER_MARKED_UNKNOWN' AND retention_class='OPERATIONAL_REVIEW_EVIDENCE'))
    )""",
    "CREATE INDEX trade_review_artifact_v3_hash ON trade_review_artifact_v3(artifact_hash,state)",
    """CREATE TABLE trade_review_crop_receipt_v3 (
        crop_mutation_id TEXT NOT NULL PRIMARY KEY,
        observation_id TEXT NOT NULL REFERENCES trade_review_observation_v3(observation_id),
        request_hash TEXT NOT NULL CHECK(length(request_hash)=64), response_json TEXT NOT NULL, created_at TEXT NOT NULL
    )""",
    """CREATE TABLE trade_crop_truth_label_v3 (
        label_id TEXT NOT NULL PRIMARY KEY,
        observation_id TEXT NOT NULL REFERENCES trade_review_observation_v3(observation_id),
        source_row_id TEXT NOT NULL,
        field_name TEXT NOT NULL CHECK(field_name IN ('island','fromItem','reqAmount','toItem','count','yield')),
        crop_ref_id TEXT NOT NULL, label_revision INTEGER NOT NULL CHECK(label_revision>=1),
        supersedes_label_id TEXT REFERENCES trade_crop_truth_label_v3(label_id),
        truth_evidence TEXT NOT NULL CHECK(truth_evidence='HUMAN_CROP_VERIFIED'),
        label_status TEXT NOT NULL CHECK(label_status IN ('KNOWN','UNKNOWN','DISPUTED')),
        value_json TEXT NOT NULL,
        artifact_hash TEXT NOT NULL REFERENCES recognition_artifact(artifact_hash),
        pixel_sha256 TEXT NOT NULL CHECK(length(pixel_sha256)=64), provenance_json TEXT NOT NULL,
        payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
        created_at TEXT NOT NULL, persisted_at TEXT NOT NULL, label_hash TEXT NOT NULL CHECK(length(label_hash)=64),
        UNIQUE(observation_id,source_row_id,field_name,crop_ref_id,label_revision),
        CHECK(supersedes_label_id IS NULL OR supersedes_label_id<>label_id),
        CHECK((label_status='KNOWN' AND value_json<>'null') OR (label_status<>'KNOWN' AND value_json='null'))
    )""",
    "CREATE INDEX trade_crop_truth_label_v3_subject ON trade_crop_truth_label_v3(pixel_sha256,field_name,label_revision)",
    "CREATE INDEX trade_crop_truth_label_v3_artifact ON trade_crop_truth_label_v3(artifact_hash)",
    """CREATE TABLE trade_crop_truth_receipt_v3 (
        mutation_id TEXT NOT NULL PRIMARY KEY,
        label_id TEXT NOT NULL REFERENCES trade_crop_truth_label_v3(label_id),
        request_hash TEXT NOT NULL CHECK(length(request_hash)=64), response_json TEXT NOT NULL, created_at TEXT NOT NULL
    )""",
    "CREATE TRIGGER trade_review_observation_v3_no_update BEFORE UPDATE ON trade_review_observation_v3 BEGIN SELECT RAISE(ABORT,'immutable observation'); END",
    "CREATE TRIGGER trade_review_observation_v3_no_delete BEFORE DELETE ON trade_review_observation_v3 BEGIN SELECT RAISE(ABORT,'immutable observation'); END",
    "CREATE TRIGGER trade_crop_truth_label_v3_no_update BEFORE UPDATE ON trade_crop_truth_label_v3 BEGIN SELECT RAISE(ABORT,'immutable truth label'); END",
    "CREATE TRIGGER trade_crop_truth_label_v3_no_delete BEFORE DELETE ON trade_crop_truth_label_v3 BEGIN SELECT RAISE(ABORT,'immutable truth label'); END",
)


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
                    if version == 1:
                        self._migrate_v1_to_v2(connection)
                        version = 2
                    if version == 2:
                        self._migrate_v2_to_v3(connection)
                        version = 3
                    if version != SCHEMA_VERSION:
                        raise RecognitionStoreError("recognition sidecar schema is unsupported")
                    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                    required = {"capture_profile", "recognition_run", "recognition_label", "recognition_label_receipt",
                                "recognition_apply_intent", "recognition_artifact", "recognition_run_artifact",
                                "trade_review_observation", "trade_review_artifact", "trade_review_crop_receipt",
                                "trade_review_observation_v3", "trade_review_artifact_v3", "trade_review_crop_receipt_v3",
                                "trade_crop_truth_label_v3", "trade_crop_truth_receipt_v3"}
                    if not required <= tables:
                        raise RecognitionStoreError("recognition sidecar schema is incomplete")
                    required_objects = required | {"recognition_meta", "trade_review_observation_batch", "trade_review_artifact_hash",
                        "trade_review_observation_v3_batch", "trade_review_artifact_v3_hash",
                        "trade_crop_truth_label_v3_subject", "trade_crop_truth_label_v3_artifact",
                        "trade_review_observation_v3_no_update", "trade_review_observation_v3_no_delete",
                        "trade_crop_truth_label_v3_no_update", "trade_crop_truth_label_v3_no_delete"}
                    objects = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")}
                    if objects != required_objects:
                        raise RecognitionStoreError("recognition sidecar schema objects are incomplete or unexpected")
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
                for statement in TRADE_REVIEW_SCHEMA:
                    connection.execute(statement)
                for statement in TRADE_REVIEW_V3_SCHEMA:
                    connection.execute(statement)
                config = {"version": 1, "flags": DEFAULT_FLAGS, "profiles": [], "policy": DEFAULT_POLICY}
                connection.execute("INSERT INTO recognition_meta VALUES (1, ?, 0, ?)",
                                   (SCHEMA_VERSION, canonical_json(config)))
                connection.commit()
        except (FutureSchemaError, RecognitionStoreError):
            raise
        except (OSError, sqlite3.Error) as error:
            raise RecognitionStoreError("recognition sidecar is unavailable") from error

    @staticmethod
    def _logical_digest(connection: sqlite3.Connection) -> str:
        rows = connection.execute("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()
        snapshot = []
        for row in rows:
            entry = [row[0], row[1], row[2]]
            if row[0] == "table":
                data = connection.execute(f"SELECT * FROM \"{row[1]}\"").fetchall()
                entry.append([tuple(item) for item in data])
            snapshot.append(entry)
        return sha256_bytes(canonical_json(snapshot).encode("utf-8"))

    def _migrate_v1_to_v2(self, connection: sqlite3.Connection) -> None:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        required = {"recognition_meta", "capture_profile", "recognition_run", "recognition_label", "recognition_label_receipt",
                    "recognition_apply_intent", "recognition_artifact", "recognition_run_artifact"}
        if tables != required:
            raise RecognitionStoreError("recognition sidecar schema is incomplete or has unexpected tables")
        before = self._logical_digest(connection)
        backup_path = self.database_path.with_name(self.database_path.name + ".v1-backup")
        if backup_path.exists():
            with closing(sqlite3.connect(backup_path)) as stale:
                stale.row_factory = sqlite3.Row
                if self._logical_digest(stale) != before:
                    raise RecognitionStoreError("recognition migration backup is stale")
        else:
            temporary_backup = None
            try:
                with tempfile.NamedTemporaryFile(prefix=backup_path.name + ".", suffix=".tmp", dir=backup_path.parent, delete=False) as temp:
                    temporary_backup = Path(temp.name)
                with closing(sqlite3.connect(temporary_backup)) as backup:
                    connection.backup(backup)
                    backup.commit()
                with closing(sqlite3.connect(temporary_backup)) as backup:
                    backup.row_factory = sqlite3.Row
                    if self._logical_digest(backup) != before:
                        raise RecognitionStoreError("recognition migration backup verification failed")
                os.replace(temporary_backup, backup_path)
            except Exception:
                if temporary_backup is not None:
                    temporary_backup.unlink(missing_ok=True)
                raise
        # Detect a stale backup/source pair before the schema transaction starts.
        if self._logical_digest(connection) != before:
            raise RecognitionStoreError("recognition sidecar changed during migration preparation")
        try:
            connection.execute("BEGIN IMMEDIATE")
            current = connection.execute("SELECT schema_version FROM recognition_meta WHERE id=1").fetchone()
            if current is None or int(current[0]) != 1:
                raise RecognitionStoreError("recognition sidecar changed during migration")
            if self._logical_digest(connection) != before:
                raise RecognitionStoreError("recognition sidecar changed during migration")
            for statement in TRADE_REVIEW_SCHEMA:
                connection.execute(statement)
            updated = connection.execute("UPDATE recognition_meta SET schema_version=2 WHERE id=1 AND schema_version=1")
            if updated.rowcount != 1:
                raise RecognitionStoreError("recognition sidecar migration metadata update failed")
            self._commit_schema_migration(connection)
        except Exception:
            connection.rollback()
            raise

    @staticmethod
    def _v2_logical_digest(connection: sqlite3.Connection) -> str:
        """Stable digest for the v2→v3 backup gate; unlike the legacy v1 digest it is order-independent."""
        objects = connection.execute(
            "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
        ).fetchall()
        snapshot = []
        for obj in objects:
            entry: list[Any] = [obj[0], obj[1], obj[2]]
            if obj[0] == "table":
                columns = [row[1] for row in connection.execute(f'PRAGMA table_info("{obj[1]}")')]
                rows = connection.execute(f'SELECT * FROM "{obj[1]}"').fetchall()
                normalized = []
                for row in rows:
                    values = []
                    for value in row:
                        if value is None: values.append(["null", None])
                        elif isinstance(value, bytes): values.append(["blob", value.hex()])
                        elif type(value) is int: values.append(["integer", value])
                        elif type(value) is float: values.append(["real", value.hex()])
                        else: values.append(["text", str(value)])
                    normalized.append(values)
                normalized.sort(key=canonical_json)
                entry.append([columns, normalized])
            snapshot.append(entry)
        return sha256_bytes(canonical_json(snapshot).encode("utf-8"))

    @staticmethod
    def _legacy_v2_state_digest(connection: sqlite3.Connection) -> str:
        legacy = {"recognition_meta", "capture_profile", "recognition_run", "recognition_label", "recognition_label_receipt",
                  "recognition_apply_intent", "recognition_artifact", "recognition_run_artifact",
                  "trade_review_observation", "trade_review_artifact", "trade_review_crop_receipt",
                  "trade_review_observation_batch", "trade_review_artifact_hash"}
        objects=connection.execute("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()
        snapshot=[]
        for obj in objects:
            if obj[1] not in legacy: continue
            entry=[obj[0],obj[1],obj[2]]
            if obj[0]=="table":
                columns=[row[1] for row in connection.execute(f'PRAGMA table_info("{obj[1]}")')]
                rows=connection.execute(f'SELECT * FROM "{obj[1]}"').fetchall()
                encoded=[]
                for row in rows:
                    values=[]
                    for index,value in enumerate(row):
                        if obj[1]=="recognition_meta" and columns[index]=="schema_version": value=2
                        if value is None: values.append(["null",None])
                        elif isinstance(value,bytes): values.append(["blob",value.hex()])
                        elif type(value) is int: values.append(["integer",value])
                        elif type(value) is float: values.append(["real",value.hex()])
                        else: values.append(["text",str(value)])
                    encoded.append(values)
                encoded.sort(key=canonical_json);entry.append([columns,encoded])
            snapshot.append(entry)
        return sha256_bytes(canonical_json(snapshot).encode("utf-8"))

    def _migrate_v2_to_v3(self, connection: sqlite3.Connection) -> None:
        required_v2 = {"recognition_meta", "capture_profile", "recognition_run", "recognition_label", "recognition_label_receipt",
                       "recognition_apply_intent", "recognition_artifact", "recognition_run_artifact",
                       "trade_review_observation", "trade_review_artifact", "trade_review_crop_receipt"}
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        version_row = connection.execute("SELECT schema_version FROM recognition_meta WHERE id=1").fetchone()
        if tables != required_v2 or version_row is None or int(version_row[0]) != 2:
            raise RecognitionStoreError("recognition sidecar schema is incomplete or has unexpected objects")
        v2_objects = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")}
        if v2_objects != required_v2 | {"trade_review_observation_batch", "trade_review_artifact_hash"}:
            raise RecognitionStoreError("recognition sidecar schema is incomplete or has unexpected objects")
        before = self._v2_logical_digest(connection)
        legacy_state = self._legacy_v2_state_digest(connection)
        artifact_manifest = self._artifact_file_manifest(connection)
        backup_path = self.database_path.with_name(self.database_path.name + ".v2-backup")
        if backup_path.exists():
            try:
                with closing(sqlite3.connect(backup_path)) as backup:
                    if self._v2_logical_digest(backup) != before:
                        raise RecognitionStoreError("recognition v2 migration backup is stale or corrupt")
            except sqlite3.Error as error:
                raise RecognitionStoreError("recognition v2 migration backup is corrupt") from error
        else:
            temporary_backup: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(prefix=backup_path.name + ".", suffix=".tmp", dir=backup_path.parent, delete=False) as temp:
                    temporary_backup = Path(temp.name)
                with closing(sqlite3.connect(temporary_backup)) as backup:
                    connection.backup(backup)
                    backup.commit()
                with closing(sqlite3.connect(temporary_backup)) as backup:
                    if self._v2_logical_digest(backup) != before:
                        raise RecognitionStoreError("recognition v2 migration backup verification failed")
                with open(temporary_backup, "r+b") as stream: os.fsync(stream.fileno())
                os.replace(temporary_backup, backup_path)
            except Exception:
                if temporary_backup is not None: temporary_backup.unlink(missing_ok=True)
                raise
        if self._v2_logical_digest(connection) != before:
            raise RecognitionStoreError("recognition sidecar changed during migration preparation")
        try:
            connection.execute("BEGIN IMMEDIATE")
            current = connection.execute("SELECT schema_version FROM recognition_meta WHERE id=1").fetchone()
            if current is None or int(current[0]) != 2 or self._v2_logical_digest(connection) != before:
                raise RecognitionStoreError("recognition sidecar changed during migration")
            for statement in TRADE_REVIEW_V3_SCHEMA:
                connection.execute(statement)
            updated = connection.execute("UPDATE recognition_meta SET schema_version=3 WHERE id=1 AND schema_version=2")
            if updated.rowcount != 1:
                raise RecognitionStoreError("recognition sidecar migration metadata update failed")
            if self._artifact_file_manifest(connection) != artifact_manifest:
                raise RecognitionStoreError("recognition artifact bytes changed during schema migration")
            if self._legacy_v2_state_digest(connection) != legacy_state:
                raise RecognitionStoreError("legacy v2 evidence changed during schema migration")
            self._commit_schema_migration(connection)
        except Exception:
            connection.rollback()
            raise

    def _artifact_file_manifest(self, connection: sqlite3.Connection) -> list[tuple[str, str, int | None]]:
        manifest=[]
        for row in connection.execute("SELECT artifact_hash,relative_path FROM recognition_artifact ORDER BY artifact_hash"):
            relative=Path(row["relative_path"])
            if relative.is_absolute() or ".." in relative.parts: raise RecognitionStoreError("artifact registry path is invalid")
            path=self.database_path.parent / relative
            try:
                data=path.read_bytes()
            except OSError:
                manifest.append((row["artifact_hash"],"MISSING",None))
            else:
                manifest.append((row["artifact_hash"],sha256_bytes(data),len(data)))
        return manifest

    @staticmethod
    def _commit_schema_migration(connection: sqlite3.Connection) -> None:
        connection.commit()

    def _meta(self, connection: sqlite3.Connection) -> sqlite3.Row:
        row = connection.execute("SELECT schema_version, config_revision, config_json FROM recognition_meta WHERE id=1").fetchone()
        if row is None or int(row["schema_version"]) != SCHEMA_VERSION:
            raise RecognitionStoreError("recognition sidecar schema is unavailable")
        return row

    def _storage_usage(self, connection: sqlite3.Connection) -> int:
        pages = int(connection.execute("PRAGMA page_count").fetchone()[0]) * int(connection.execute("PRAGMA page_size").fetchone()[0])
        registered = int(connection.execute("SELECT COALESCE(SUM(byte_size),0) FROM recognition_artifact").fetchone()[0])
        files = 0
        if self.artifact_root.exists():
            for path in self.artifact_root.glob("*.png"):
                try: files += path.stat().st_size
                except OSError: pass
        return pages + max(registered, files)

    def create_trade_review_observation(self, payload: Mapping[str, Any]) -> tuple[dict[str, Any], bool]:
        request = json.loads(canonical_json(payload))
        payload_json = canonical_json(request)
        request_hash = sha256_bytes(payload_json.encode("utf-8"))
        with self._lock, closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            if connection.execute("SELECT 1 FROM trade_review_observation_v3 WHERE mutation_id=?", (request["mutationId"],)).fetchone():
                connection.rollback(); raise MutationConflictError("The mutation ID is already used by a v3 observation.")
            prior = connection.execute("SELECT * FROM trade_review_observation WHERE mutation_id=?", (request["mutationId"],)).fetchone()
            if prior:
                if prior["payload_hash"] != request_hash:
                    connection.rollback(); raise MutationConflictError("The mutation ID was reused with different content.")
                stored_request = json.loads(prior["payload_json"])
                if canonical_json(stored_request) != prior["payload_json"] or sha256_bytes(prior["payload_json"].encode("utf-8")) != prior["payload_hash"]:
                    connection.rollback(); raise EvidenceIntegrityError("stored observation integrity check failed")
                stored_record = {**stored_request, "observationId": prior["observation_id"], "persistedAt": prior["persisted_at"],
                    "hashBasis": prior["hash_basis"], "payloadHash": prior["payload_hash"]}
                if sha256_bytes(canonical_json(stored_record).encode("utf-8")) != prior["observation_hash"]:
                    connection.rollback(); raise EvidenceIntegrityError("stored observation integrity check failed")
                stored_receipt = json.loads(prior["receipt_json"])
                expected_receipt = {"schemaVersion": 1, "observationId": prior["observation_id"], "mutationId": prior["mutation_id"],
                    "payloadHash": prior["payload_hash"], "observationHash": prior["observation_hash"], "persistedAt": prior["persisted_at"],
                    "duplicate": False, "evidenceSaved": True, "sessionApplied": False, "cropPolicy": stored_request["cropPlan"]["policy"]}
                if canonical_json(stored_receipt) != canonical_json(expected_receipt):
                    connection.rollback(); raise EvidenceIntegrityError("stored receipt integrity check failed")
                receipt = {**stored_receipt, "duplicate": True}
                connection.commit(); return receipt, True
            self._meta(connection)
            reserve = len(payload_json.encode("utf-8")) + 16 * 1024
            if self._storage_usage(connection) + reserve > self.artifact_budget_bytes:
                connection.rollback(); raise _ArtifactBudgetExceeded
            observation_id, persisted_at = str(uuid.uuid4()), _utc_now()
            if connection.execute("SELECT 1 FROM trade_review_observation_v3 WHERE observation_id=?", (observation_id,)).fetchone():
                connection.rollback(); raise EvidenceIntegrityError("generated observation ID collision")
            payload_hash = request_hash
            record_without_hash = {**request, "observationId": observation_id, "persistedAt": persisted_at,
                                   "hashBasis": "PY_CANONICAL_JSON_V1", "payloadHash": payload_hash}
            observation_hash = sha256_bytes(canonical_json(record_without_hash).encode("utf-8"))
            completion = request["completion"]
            receipt = {"schemaVersion": 1, "observationId": observation_id, "mutationId": request["mutationId"],
                       "payloadHash": payload_hash, "observationHash": observation_hash, "persistedAt": persisted_at,
                       "duplicate": False, "evidenceSaved": True, "sessionApplied": False,
                       "cropPolicy": request["cropPlan"]["policy"]}
            connection.execute("""INSERT INTO trade_review_observation VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (observation_id, request["mutationId"], 1, completion["recognitionBatchId"], completion["projectionHash"],
                 completion["registryVersion"], completion["correctionVersion"], completion["reviewRevision"],
                 request["confirmationRevision"], request["supersedesObservationId"], request["createdAt"], persisted_at,
                 "PY_CANONICAL_JSON_V1", payload_json, payload_hash, observation_hash, canonical_json(receipt)))
            if self._storage_usage(connection) > self.artifact_budget_bytes:
                connection.rollback(); raise _ArtifactBudgetExceeded
            connection.commit()
            return receipt, False

    def create_final_review_observation(self, payload: Mapping[str, Any]) -> tuple[dict[str, Any], bool]:
        request = json.loads(canonical_json(payload))
        payload_json = canonical_json(request)
        payload_hash = sha256_bytes(payload_json.encode("utf-8"))
        projection, completion = request["projection"], request["completion"]
        binding = projection["masterBinding"]
        with self._lock, closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            old = connection.execute("SELECT payload_hash FROM trade_review_observation WHERE mutation_id=?", (request["mutationId"],)).fetchone()
            prior = connection.execute("SELECT * FROM trade_review_observation_v3 WHERE mutation_id=?", (request["mutationId"],)).fetchone()
            if old:
                connection.rollback()
                raise MutationConflictError("The mutation ID is already used by a legacy observation.")
            if prior:
                if prior["payload_hash"] != payload_hash:
                    connection.rollback(); raise MutationConflictError("The mutation ID was reused with different content.")
                receipt = self._verify_v3_observation_row(prior)["receipt"]
                connection.commit()
                return {**receipt, "duplicate": True}, True
            self._meta(connection)
            if request["supersedesObservationId"] is not None:
                previous = connection.execute("SELECT recognition_batch_id FROM trade_review_observation_v3 WHERE observation_id=?", (request["supersedesObservationId"],)).fetchone()
                if previous is None or previous["recognition_batch_id"] != completion["recognitionBatchId"]:
                    connection.rollback(); raise MutationConflictError("The superseded observation is unavailable or belongs to another batch.")
            reserve = len(payload_json.encode("utf-8")) + 16 * 1024
            if self._storage_usage(connection) + reserve > self.artifact_budget_bytes:
                connection.rollback(); raise _ArtifactBudgetExceeded
            observation_id, persisted_at = str(uuid.uuid4()), _utc_now()
            collision = connection.execute("SELECT 1 FROM trade_review_observation WHERE observation_id=?", (observation_id,)).fetchone()
            if collision:
                connection.rollback(); raise EvidenceIntegrityError("generated observation ID collision")
            record = {**request, "observationId": observation_id, "persistedAt": persisted_at,
                      "hashBasis": "TRADE_OBSERVATION_JSON_V3", "payloadHash": payload_hash}
            observation_hash = sha256_bytes(canonical_json(record).encode("utf-8"))
            receipt = {"schemaVersion": 3, "observationId": observation_id, "mutationId": request["mutationId"],
                       "payloadHash": payload_hash, "observationHash": observation_hash, "persistedAt": persisted_at,
                       "duplicate": False, "evidenceSaved": True, "sessionApplied": False,
                       "reviewMode": "FINAL_CORRECTED_RESULT", "projectionHash": projection["projectionHash"],
                       "masterBinding": binding, "reviewRevision": completion["reviewRevision"],
                       "cropPolicy": "C2_LOGICAL_REPRESENTATIVE_V3"}
            connection.execute("""INSERT INTO trade_review_observation_v3
                (observation_id,mutation_id,schema_version,review_mode,recognition_batch_id,projection_hash,
                 master_schema_version,registry_version,master_content_hash,correction_version,review_revision,
                 confirmation_revision,supersedes_observation_id,created_at,persisted_at,hash_basis,payload_json,
                 payload_hash,observation_hash,receipt_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (observation_id, request["mutationId"], 3, "FINAL_CORRECTED_RESULT", completion["recognitionBatchId"],
                 projection["projectionHash"], binding["masterSchemaVersion"], binding["registryVersion"], binding["contentHash"],
                 completion["correctionVersion"], completion["reviewRevision"], request["confirmationRevision"],
                 request["supersedesObservationId"], request["createdAt"], persisted_at, "TRADE_OBSERVATION_JSON_V3",
                 payload_json, payload_hash, observation_hash, canonical_json(receipt)))
            if self._storage_usage(connection) > self.artifact_budget_bytes:
                connection.rollback(); raise _ArtifactBudgetExceeded
            connection.commit()
            return receipt, False

    def _verify_v3_observation_row(self, row: sqlite3.Row) -> dict[str, Any]:
        payload_json = row["payload_json"]
        request = json.loads(payload_json)
        if canonical_json(request) != payload_json or sha256_bytes(payload_json.encode("utf-8")) != row["payload_hash"]:
            raise EvidenceIntegrityError("stored v3 observation payload integrity check failed")
        try:
            from .recognition_contracts import validate_final_review_observation
            validate_final_review_observation(request)
        except Exception as error:
            raise EvidenceIntegrityError("stored v3 observation contract integrity check failed") from error
        record = {**request, "observationId": row["observation_id"], "persistedAt": row["persisted_at"],
                  "hashBasis": row["hash_basis"], "payloadHash": row["payload_hash"]}
        if row["hash_basis"] != "TRADE_OBSERVATION_JSON_V3" or sha256_bytes(canonical_json(record).encode("utf-8")) != row["observation_hash"]:
            raise EvidenceIntegrityError("stored v3 observation hash integrity check failed")
        p, c, b = request["projection"], request["completion"], request["projection"]["masterBinding"]
        indexed = (row["schema_version"], row["review_mode"], row["recognition_batch_id"], row["projection_hash"],
                   row["master_schema_version"], row["registry_version"], row["master_content_hash"],
                   row["correction_version"], row["review_revision"], row["confirmation_revision"],
                   row["supersedes_observation_id"], row["created_at"])
        expected = (3, "FINAL_CORRECTED_RESULT", c["recognitionBatchId"], p["projectionHash"], b["masterSchemaVersion"],
                    b["registryVersion"], b["contentHash"], c["correctionVersion"], c["reviewRevision"],
                    request["confirmationRevision"], request["supersedesObservationId"], request["createdAt"])
        if indexed != expected: raise EvidenceIntegrityError("stored v3 observation index integrity check failed")
        receipt = json.loads(row["receipt_json"])
        expected_receipt = {"schemaVersion": 3, "observationId": row["observation_id"], "mutationId": row["mutation_id"],
            "payloadHash": row["payload_hash"], "observationHash": row["observation_hash"], "persistedAt": row["persisted_at"],
            "duplicate": False, "evidenceSaved": True, "sessionApplied": False, "reviewMode": "FINAL_CORRECTED_RESULT",
            "projectionHash": p["projectionHash"], "masterBinding": b, "reviewRevision": c["reviewRevision"],
            "cropPolicy": "C2_LOGICAL_REPRESENTATIVE_V3"}
        if canonical_json(receipt) != canonical_json(expected_receipt): raise EvidenceIntegrityError("stored v3 receipt integrity check failed")
        record["observationHash"] = row["observation_hash"]
        return {"record": record, "receipt": receipt}

    def get_trade_review_observation(self, observation_id: str) -> dict[str, Any] | None:
        try: observation_id = str(uuid.UUID(observation_id))
        except (ValueError, TypeError, AttributeError): return None
        with closing(self._connect()) as connection:
            v3 = connection.execute("SELECT * FROM trade_review_observation_v3 WHERE observation_id=?", (observation_id,)).fetchone()
            row = connection.execute("SELECT * FROM trade_review_observation WHERE observation_id=?", (observation_id,)).fetchone()
            if v3 is not None and row is not None: raise EvidenceIntegrityError("observation ID collides across schema versions")
            if v3 is not None: return self._verify_v3_observation_row(v3)["record"]
            if row is None: return None
            request = json.loads(row["payload_json"])
            if canonical_json(request) != row["payload_json"] or sha256_bytes(row["payload_json"].encode("utf-8")) != row["payload_hash"]:
                raise EvidenceIntegrityError("stored observation integrity check failed")
            completion = request.get("completion", {})
            indexed = (completion.get("recognitionBatchId"), completion.get("projectionHash"), completion.get("registryVersion"),
                       completion.get("correctionVersion"), completion.get("reviewRevision"), request.get("confirmationRevision"),
                       request.get("supersedesObservationId"), request.get("createdAt"))
            stored = (row["recognition_batch_id"], row["projection_hash"], row["registry_version"], row["correction_version"],
                      row["review_revision"], row["confirmation_revision"], row["supersedes_observation_id"], row["created_at"])
            if indexed != stored:
                raise EvidenceIntegrityError("stored observation index integrity check failed")
            record = {**request, "observationId": row["observation_id"], "persistedAt": row["persisted_at"],
                      "hashBasis": row["hash_basis"], "payloadHash": row["payload_hash"]}
            if sha256_bytes(canonical_json(record).encode("utf-8")) != row["observation_hash"]:
                raise EvidenceIntegrityError("stored observation integrity check failed")
            receipt = json.loads(row["receipt_json"])
            expected_receipt = {"schemaVersion": 1, "observationId": row["observation_id"], "mutationId": row["mutation_id"],
                "payloadHash": row["payload_hash"], "observationHash": row["observation_hash"], "persistedAt": row["persisted_at"],
                "duplicate": False, "evidenceSaved": True, "sessionApplied": False, "cropPolicy": request["cropPlan"]["policy"]}
            if canonical_json(receipt) != canonical_json(expected_receipt):
                raise EvidenceIntegrityError("stored receipt integrity check failed")
            record["observationHash"] = row["observation_hash"]
            return record

    def get_trade_review_crop_evidence(self, observation_id: str) -> list[dict[str, Any]]:
        record = self.get_trade_review_observation(observation_id)
        if record is None: raise RunNotFoundError("observation not found")
        if record.get("schemaVersion") == 3:
            links = {}
            with closing(self._connect()) as connection:
                for row in connection.execute("SELECT * FROM trade_review_artifact_v3 WHERE observation_id=?", (observation_id,)):
                    links[(row["projection_row_id"], row["field_name"])] = dict(row)
            result = []
            for entry in record["cropPlan"]["entries"]:
                key = (entry["projectionRowId"], entry["field"])
                link = links.get(key)
                if not link:
                    availability = "NOT_UPLOADED"
                    result.append({"projectionRowId": key[0], "field": key[1], "cropRefId": entry["cropRefId"],
                                   "artifactSha256": None, "pixelSha256": None, "state": availability, "retentionClass": entry["retentionClass"]})
                    continue
                path = self.artifact_root / f"{link['artifact_hash']}.png"
                state = link["state"]
                if state == "AVAILABLE" and not path.exists(): state = "MISSING"
                elif state == "AVAILABLE":
                    data=path.read_bytes()
                    if sha256_bytes(data) != link["artifact_hash"]: raise EvidenceIntegrityError("stored v3 crop integrity check failed")
                    try:
                        from io import BytesIO
                        from PIL import Image
                        image=Image.open(BytesIO(data)); image.load()
                        if image.format!="PNG" or image.size!=(link["width"],link["height"]) or "A" in image.getbands() and image.getchannel("A").getextrema()!=(255,255) or sha256_bytes(image.convert("RGB").tobytes())!=link["pixel_sha256"]:
                            raise EvidenceIntegrityError("stored v3 crop pixel integrity check failed")
                    except (OSError,ValueError) as error:
                        raise EvidenceIntegrityError("stored v3 crop pixel integrity check failed") from error
                result.append({"projectionRowId": key[0], "field": key[1], "cropRefId": link["crop_ref_id"],
                               "artifactSha256": link["artifact_hash"], "pixelSha256": link["pixel_sha256"],
                               "state": state, "retentionClass": link["retention_class"]})
            return result
        links = {}
        with closing(self._connect()) as connection:
            for row in connection.execute("SELECT * FROM trade_review_artifact WHERE observation_id=?", (observation_id,)):
                links[(row["projection_row_id"], row["field_name"])] = dict(row)
        plans = {(entry["projectionRowId"], entry["field"]): entry for entry in record["cropPlan"]["entries"]}
        result = []
        for row in record["completion"]["rows"]:
            for field in row["fields"]:
                key = (row["projectionRowId"], field["field"]); plan = plans[key]; link = links.get(key)
                if link:
                    path = self.artifact_root / f"{link['artifact_hash']}.png"
                    state = link["state"]
                    if state == "AVAILABLE" and not path.exists(): state = "MISSING"
                    elif state == "AVAILABLE" and sha256_bytes(path.read_bytes()) != link["artifact_hash"]: raise EvidenceIntegrityError("stored crop integrity check failed")
                    retention = "UNKNOWN_30_DAY" if link["verification_method"] == "USER_MARKED_UNKNOWN" else "PROTECTED_VERIFIED"
                    result.append({"projectionRowId": key[0], "field": key[1], "geometry": plan["geometry"], "readerCropHash": plan["readerCropHash"],
                                   "artifactSha256": link["artifact_hash"], "availability": state, "byteSize": link["byte_size"],
                                   "width": link["width"], "height": link["height"], "retentionClass": retention, "reason": None})
                else:
                    status = "NOT_SELECTED" if not plan["selected"] else "SKIPPED_GEOMETRY_UNAVAILABLE" if plan["geometry"] is None else "NOT_UPLOADED"
                    retention = "UNKNOWN_30_DAY" if field["verificationMethod"] == "USER_MARKED_UNKNOWN" else "PROTECTED_VERIFIED" if plan["selected"] else "NONE"
                    result.append({"projectionRowId": key[0], "field": key[1], "geometry": plan["geometry"], "readerCropHash": plan["readerCropHash"],
                                   "artifactSha256": None, "availability": status, "byteSize": None, "width": None, "height": None,
                                   "retentionClass": retention, "reason": plan["skipReason"] or "NOT_UPLOADED"})
        return result

    def export_trade_review_observation(self, observation_id: str) -> dict[str, Any] | None:
        record = self.get_trade_review_observation(observation_id)
        if record is None: return None
        if record.get("schemaVersion") == 3:
            return self._export_final_review_observation(record)
        source = record["sourceContext"]; completion = record["completion"]
        registry_hash = sha256_bytes(canonical_json(source["registry"]["snapshot"]).encode("utf-8"))
        projection_hash = sha256_bytes(canonical_json(source["projection"]["snapshot"]).encode("utf-8"))
        projection_rows = {row["projectionRowId"]: row for row in source["projection"]["snapshot"]["rows"]}
        fields = []
        for row in completion["rows"]:
            projected = projection_rows[row["projectionRowId"]]
            for field in row["fields"]:
                projected_field = projected["fields"][field["field"]]
                fields.append({"projectionRowId": row["projectionRowId"], "field": field["field"],
                    "rawEvidence": field["rawEvidence"], "candidate": field["candidate"], "shownValueBefore": field["shownValueBefore"],
                    "finalValue": field["finalValue"], "verificationMethod": field["verificationMethod"],
                    "risk": field["riskReasons"], "masterVersion": field["masterVersion"], "sourceRefs": row["sourceRefs"],
                    "geometry": projected_field.get("rawEvidence", {}).get("readerEvidence", {}).get("geometry"),
                    "truthStatus": "HUMAN_DECLARED_UNKNOWN" if field["verificationMethod"] == "USER_MARKED_UNKNOWN" else "HUMAN_DECLARED_VALUE",
                    "knownTruthEligible": field["verificationMethod"] != "USER_MARKED_UNKNOWN", "identityMappingVerified": False})
        semantic = {"manifest": {"observationSchemaVersion": 1, "sidecarSchemaVersion": 2, "hashBasis": record["hashBasis"],
            "payloadHash": record["payloadHash"], "observationHash": record["observationHash"],
            "sourceSnapshotHashes": {"registry": registry_hash, "projection": projection_hash},
            "sourceHashClaims": {"registry": source["registry"]["snapshotSha256"], "projection": completion["projectionHash"], "hashBasis": "JS_REGISTRY_SORTED_JSON_V1"},
            "cropPolicy": record["cropPlan"]["policy"], "evaluationBasis": "NOT_EVALUATED_R006"},
            "observation": record, "cropEvidence": self.get_trade_review_crop_evidence(observation_id),
            "dataset": {"fields": fields, "edgeSegments": [{**item, "sixFieldTruth": False} for item in completion["edgeSegments"]], "analysisAttributions": []}}
        semantic_hash = sha256_bytes(canonical_json(semantic).encode("utf-8"))
        return {"schemaVersion": 1, "exportType": "TRADE_REVIEW_OBSERVATION", "generatedAt": _utc_now(),
                "semanticHash": semantic_hash, "semantic": semantic}

    def _export_final_review_observation(self, record: dict[str, Any]) -> dict[str, Any]:
        projection, completion = record["projection"], record["completion"]
        fields = []
        truth_history = self.get_crop_truth_labels(record["observationId"]) or []
        truth_labels = [item["label"] for item in truth_history]
        truth_bindings = [{"labelId": label["labelId"], "labelHash": label["labelHash"]} for label in sorted(truth_labels, key=lambda x: x["labelId"])]
        snapshot = record["sourceContext"]["rawEvidence"]["snapshot"]
        source_rows = {row["sourceRowId"]: row for row in snapshot["sourceRows"]}
        groups = {group["logicalRowId"]: group for group in projection["reconciliation"]["groups"]}
        crop_states = {(item["projectionRowId"], item["field"]): item for item in self.get_trade_review_crop_evidence(record["observationId"])}
        latest_labels = {}
        for label in truth_labels:
            key=(label["sourceRowId"],label["field"],label["cropRefId"])
            if key not in latest_labels or label["labelRevision"]>latest_labels[key]["labelRevision"]: latest_labels[key]=label

        def source_cell_truth(source_id: str, field_name: str, crop_refs: list[dict[str, Any]]):
            eligible=[]; ids=[]; physical=set()
            for crop in crop_refs:
                physical.add((crop["bitmapSha256"],canonical_json(crop["box"]),crop["pixelSha256"],field_name))
                label=latest_labels.get((source_id,field_name,crop["cropRefId"]))
                if label is None: continue
                ids.append(label["labelId"])
                provenance=label["provenance"]
                if (label["labelStatus"]=="KNOWN" and label["truthEvidence"]=="HUMAN_CROP_VERIFIED"
                    and provenance["cohort"]=="INDEPENDENT" and provenance["sourceOrigin"]=="FRESH_CAPTURE"
                    and provenance["independentOfOperationalReview"] is True and isinstance(provenance["splitManifestHash"],str)):
                    eligible.append(label["value"])
            return ids, eligible, len(physical)

        def raw_field(source_id: str, field_name: str):
            row=source_rows[source_id]
            return next(item for item in row["fields"] if item["field"]==field_name)

        source_fields=[]
        for source_id, raw_row in source_rows.items():
            for field_name in ("island","fromItem","reqAmount","toItem","count","yield"):
                raw=raw_field(source_id,field_name); crop_refs=raw["cropRefs"]
                label_ids,eligible,physical_count=source_cell_truth(source_id,field_name,crop_refs)
                value=eligible[-1] if physical_count>0 and len(eligible)==physical_count and len(set(map(canonical_json,eligible)))==1 else None
                group=next(g for g in projection["reconciliation"]["groups"] if source_id in g["memberSourceRowIds"])
                source_projection_field=None
                if group["memberEvidence"]:
                    source_member=next(m for m in group["memberEvidence"] if m["sourceRowId"]==source_id)
                    source_projection_field=next(f for f in source_member["fields"] if f["field"]==field_name)
                else:
                    projected_row=next(r for r in projection["rows"] if r["projectionRowId"]==group["logicalRowId"])
                    source_projection_field=next(f for f in projected_row["fields"] if f["field"]==field_name)
                source_fields.append({"sourceRowId":source_id,"field":field_name,
                    "rawEvidence":{"sourceRowId":source_id,"rawText":raw["rawText"],"rawNumeric":raw["rawNumeric"],"readerStatus":raw["readerStatus"],"confidence":raw["confidence"]},
                    "normalizedValue":source_projection_field["normalizedValue"],"correctedValue":source_projection_field["correctedValue"],"truthEvidence":"HUMAN_CROP_VERIFIED" if value is not None else "NONE",
                    "knownTruthEligible":value is not None,"truthValue":value,"truthLabelIds":label_ids,"cropRefs":crop_refs})
        dataset_rows=[]
        for row in completion["rows"]:
            group=groups[row["projectionRowId"]]
            dataset_fields=[]
            for field in row["fields"]:
                name=field["field"]
                physical=[]; labels_for_field=[]; raw_evidence=[]
                for source_ref in row["sourceRefs"]:
                    sid=source_ref["sourceRowId"]; raw=raw_field(sid,name); raw_evidence.append({"sourceRowId":sid,"rawText":raw["rawText"],"rawNumeric":raw["rawNumeric"],"readerStatus":raw["readerStatus"],"confidence":raw["confidence"]})
                    for crop in raw["cropRefs"]:
                        physical_key=(crop["bitmapSha256"],canonical_json(crop["box"]),crop["pixelSha256"],name)
                        if physical_key not in [x[0] for x in physical]: physical.append((physical_key,crop,sid))
                truth_values=[]; truth_ok=bool(physical)
                for _,crop,sid in physical:
                    label=latest_labels.get((sid,name,crop["cropRefId"]))
                    # A repeated bitmap may use a different cropRefId; labels remain source-bound.
                    if label is None:
                        label=next((candidate for candidate in truth_labels if candidate["field"]==name and candidate["artifact"]["pixelSha256"]==crop["pixelSha256"] and candidate["artifact"]["width"]==crop["box"]["width"] and candidate["artifact"]["height"]==crop["box"]["height"]),None)
                    if label is None:
                        truth_ok=False; continue
                    labels_for_field.append(label["labelId"])
                    provenance=label["provenance"]
                    valid=(label["labelStatus"]=="KNOWN" and label["truthEvidence"]=="HUMAN_CROP_VERIFIED" and provenance["cohort"]=="INDEPENDENT" and provenance["sourceOrigin"]=="FRESH_CAPTURE" and provenance["independentOfOperationalReview"] is True and isinstance(provenance["splitManifestHash"],str))
                    if not valid: truth_ok=False
                    else: truth_values.append(label["value"])
                same_truth=truth_ok and len(truth_values)==len(physical) and len({canonical_json(v) for v in truth_values})==1
                projected_field=next(f for f in next(p for p in projection["rows"] if p["projectionRowId"]==row["projectionRowId"])["fields"] if f["field"]==name)
                dataset_field={"field":name,"operationalDecision":field["operationalDecision"],"truthEvidence":"HUMAN_CROP_VERIFIED" if same_truth else "NONE",
                    "knownTruthEligible":same_truth,"truthValue":truth_values[0] if same_truth else None,"truthLabelIds":sorted(set(labels_for_field)),
                    "rawEvidence":raw_evidence,"normalizedValue":projected_field["normalizedValue"],"correctedValue":field["shownValueBefore"],
                    "shownValueBefore":field["shownValueBefore"],"finalValue":field["finalValue"],"riskReasons":field["riskReasons"],
                    "correctionReasons":projected_field["correctionReasons"],"masterBinding":projection["masterBinding"],"sourceRefs":row["sourceRefs"],
                    "cropRefs":[crop for sid in [x["sourceRowId"] for x in row["sourceRefs"]] for crop in raw_field(sid,name)["cropRefs"]]}
                fields.append({"projectionRowId":row["projectionRowId"],**dataset_field})
                dataset_fields.append(dataset_field)
            dataset_rows.append({"projectionRowId":row["projectionRowId"],"classification":next(p["classification"] for p in projection["rows"] if p["projectionRowId"]==row["projectionRowId"]),
                "disposition":row["disposition"],"sourceRefs":row["sourceRefs"],"fields":dataset_fields})
        semantic = {"manifest": {"observationSchemaVersion": 3, "sidecarSchemaVersion": 3,
                "projectionSchemaVersion": 3, "completionSchemaVersion": 3, "masterBinding": projection["masterBinding"],
                "projectionHash": projection["projectionHash"], "payloadHash": record["payloadHash"],
                "observationHash": record["observationHash"], "truthLabelBindings": truth_bindings,
                "evaluationPolicyVersion": "trade-final-review-evaluation-v3"},
            "observation": record, "cropEvidence": self.get_trade_review_crop_evidence(record["observationId"]),
            "truthLabels": truth_labels, "dataset": {"recognitionBatchId":completion["recognitionBatchId"],"rows":dataset_rows,
                "sourceFields":source_fields,"edgeWorkItems":completion["workItems"]}}
        semantic_hash = sha256_bytes(canonical_json(semantic).encode("utf-8"))
        return {"schemaVersion": 3, "exportType": "TRADE_FINAL_REVIEW_OBSERVATION", "generatedAt": _utc_now(),
                "hashBasis": "TRADE_EXPORT_JSON_V3", "semanticHash": semantic_hash, "semantic": semantic}

    def attach_trade_review_crop(self, observation_id: str, metadata: Mapping[str, Any], png_bytes: bytes) -> tuple[dict[str, Any], bool]:
        record = self.get_trade_review_observation(observation_id)
        if record is None: raise RunNotFoundError("observation not found")
        if record.get("schemaVersion") == 3:
            return self._attach_final_review_crop(observation_id, record, metadata, png_bytes)
        plan = next((entry for entry in record["cropPlan"]["entries"] if entry["projectionRowId"] == metadata["projectionRowId"] and entry["field"] == metadata["field"]), None)
        if not plan or not plan["selected"] or plan["geometry"] is None: raise RecognitionStoreError("crop is not selected by the stored plan")
        geometry = plan["geometry"]
        if (metadata["width"], metadata["height"]) != (geometry["width"], geometry["height"]): raise RecognitionStoreError("crop dimensions do not match its stored geometry")
        capture = next((item for item in record["sourceContext"]["captures"] if item["captureId"] == geometry["captureId"]), None)
        frame = capture["metadata"]["frame"] if capture else {}
        if geometry["x"] == 0 and geometry["y"] == 0 and geometry["width"] == frame.get("width") and geometry["height"] == frame.get("height"):
            raise RecognitionStoreError("full-frame evidence is not accepted as a crop")
        field = next(f for r in record["completion"]["rows"] if r["projectionRowId"] == metadata["projectionRowId"] for f in r["fields"] if f["field"] == metadata["field"])
        request_hash = sha256_bytes(canonical_json({"metadata": dict(metadata), "pngSha256": metadata["sha256"]}).encode("utf-8"))
        now = _utc_now(); digest = metadata["sha256"]; target = self.artifact_root / f"{digest}.png"
        with self._lock, closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            if connection.execute("SELECT 1 FROM trade_review_crop_receipt_v3 WHERE crop_mutation_id=?", (metadata["cropMutationId"],)).fetchone():
                connection.rollback(); raise MutationConflictError("The crop mutation ID is already used by a v3 crop.")
            prior = connection.execute("SELECT * FROM trade_review_crop_receipt WHERE crop_mutation_id=?", (metadata["cropMutationId"],)).fetchone()
            if prior:
                if prior["request_hash"] != request_hash: connection.rollback(); raise MutationConflictError("The crop mutation ID was reused with different content.")
                response = json.loads(prior["response_json"])
                expected_receipt = {"version": 1, "cropMutationId": metadata["cropMutationId"], "observationId": observation_id,
                    "projectionRowId": metadata["projectionRowId"], "field": metadata["field"], "sha256": digest,
                    "persistedAt": prior["created_at"], "duplicate": False}
                if canonical_json(response) != canonical_json(expected_receipt):
                    connection.rollback(); raise EvidenceIntegrityError("stored crop receipt integrity check failed")
                response["duplicate"] = True; connection.commit(); return response, True
            existing = connection.execute("SELECT artifact_hash FROM trade_review_artifact WHERE observation_id=? AND projection_row_id=? AND field_name=?", (observation_id, metadata["projectionRowId"], metadata["field"])).fetchone()
            if existing and existing[0] != digest: connection.rollback(); raise CropLinkConflictError("The crop field already has another artifact.")
            if self._storage_usage(connection) + len(png_bytes) + 8192 > self.artifact_budget_bytes: connection.rollback(); raise _ArtifactBudgetExceeded
            self.artifact_root.mkdir(parents=True, exist_ok=True)
            if target.exists():
                if sha256_bytes(target.read_bytes()) != digest: connection.rollback(); raise RecognitionStoreError("existing artifact hash mismatch")
            else:
                with tempfile.NamedTemporaryFile(prefix=".evidence-", suffix=".tmp", dir=self.artifact_root, delete=False) as temp:
                    temp_path = Path(temp.name); temp.write(png_bytes); temp.flush(); os.fsync(temp.fileno())
                os.replace(temp_path, target)
            receipt = {"version": 1, "cropMutationId": metadata["cropMutationId"], "observationId": observation_id,
                       "projectionRowId": metadata["projectionRowId"], "field": metadata["field"], "sha256": digest,
                       "persistedAt": now, "duplicate": False}
            try:
                connection.execute("INSERT OR IGNORE INTO recognition_artifact VALUES(?,?,?,?,?)", (digest, f"artifacts/{digest}.png", len(png_bytes), "image/png", now))
                if not existing:
                    connection.execute("INSERT INTO trade_review_artifact VALUES(?,?,?,?,?,?,?,?,?,?,?)", (observation_id, metadata["projectionRowId"], metadata["field"], digest, len(png_bytes), metadata["width"], metadata["height"], field["verificationMethod"], "AVAILABLE", now, None))
                connection.execute("INSERT INTO trade_review_crop_receipt VALUES(?,?,?,?,?)", (metadata["cropMutationId"], observation_id, request_hash, canonical_json(receipt), now))
                if self._storage_usage(connection) > self.artifact_budget_bytes: raise _ArtifactBudgetExceeded
                connection.commit()
            except Exception:
                connection.rollback(); raise
        return receipt, False

    def _attach_final_review_crop(self, observation_id: str, record: dict[str, Any], metadata: Mapping[str, Any], png_bytes: bytes) -> tuple[dict[str, Any], bool]:
        plan = next((entry for entry in record["cropPlan"]["entries"] if entry["projectionRowId"] == metadata["projectionRowId"] and entry["field"] == metadata["field"]), None)
        if plan is None or not plan["selected"] or plan["cropRefId"] is None: raise RecognitionStoreError("crop is not selected by the stored v3 plan")
        crop_ref = next((crop for row in record["sourceContext"]["rawEvidence"]["snapshot"]["sourceRows"] for field in row["fields"] for crop in field["cropRefs"] if crop["cropRefId"] == plan["cropRefId"]), None)
        if crop_ref is None: raise EvidenceIntegrityError("stored crop plan references an unknown CropRef")
        field = next(f for r in record["completion"]["rows"] if r["projectionRowId"] == metadata["projectionRowId"] for f in r["fields"] if f["field"] == metadata["field"])
        request_hash = sha256_bytes(canonical_json({"observationId": observation_id, "metadata": dict(metadata), "pngSha256": metadata["sha256"]}).encode("utf-8"))
        now = _utc_now(); digest = metadata["sha256"]; target = self.artifact_root / f"{digest}.png"
        with self._lock, closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            legacy_mutation = connection.execute("SELECT 1 FROM trade_review_crop_receipt WHERE crop_mutation_id=?", (metadata["cropMutationId"],)).fetchone()
            prior = connection.execute("SELECT * FROM trade_review_crop_receipt_v3 WHERE crop_mutation_id=?", (metadata["cropMutationId"],)).fetchone()
            if legacy_mutation:
                connection.rollback(); raise MutationConflictError("The crop mutation ID is already used by a legacy crop.")
            if prior:
                if prior["request_hash"] != request_hash: connection.rollback(); raise MutationConflictError("The crop mutation ID was reused with different content.")
                response = json.loads(prior["response_json"])
                expected = {"schemaVersion": 3, "cropMutationId": metadata["cropMutationId"], "observationId": observation_id,
                    "projectionRowId": metadata["projectionRowId"], "field": metadata["field"], "cropRefId": metadata["cropRefId"],
                    "sha256": digest, "pixelSha256": metadata["pixelSha256"], "persistedAt": prior["created_at"], "duplicate": False}
                if canonical_json(response) != canonical_json(expected): connection.rollback(); raise EvidenceIntegrityError("stored v3 crop receipt integrity check failed")
                response["duplicate"] = True; connection.commit(); return response, True
            existing = connection.execute("SELECT artifact_hash FROM trade_review_artifact_v3 WHERE observation_id=? AND projection_row_id=? AND field_name=?", (observation_id, metadata["projectionRowId"], metadata["field"])).fetchone()
            if existing and existing[0] != digest: connection.rollback(); raise CropLinkConflictError("The crop field already has another artifact.")
            if self._storage_usage(connection) + len(png_bytes) + 8192 > self.artifact_budget_bytes: connection.rollback(); raise _ArtifactBudgetExceeded
            self.artifact_root.mkdir(parents=True, exist_ok=True)
            if target.exists():
                if sha256_bytes(target.read_bytes()) != digest: connection.rollback(); raise EvidenceIntegrityError("existing artifact hash mismatch")
            else:
                with tempfile.NamedTemporaryFile(prefix=".evidence-", suffix=".tmp", dir=self.artifact_root, delete=False) as temp:
                    temp_path = Path(temp.name); temp.write(png_bytes); temp.flush(); os.fsync(temp.fileno())
                os.replace(temp_path, target)
            response = {"schemaVersion": 3, "cropMutationId": metadata["cropMutationId"], "observationId": observation_id,
                "projectionRowId": metadata["projectionRowId"], "field": metadata["field"], "cropRefId": metadata["cropRefId"],
                "sha256": digest, "pixelSha256": metadata["pixelSha256"], "persistedAt": now, "duplicate": False}
            try:
                connection.execute("INSERT OR IGNORE INTO recognition_artifact VALUES(?,?,?,?,?)", (digest, f"artifacts/{digest}.png", len(png_bytes), "image/png", now))
                if not existing:
                    retention = plan["retentionClass"]
                    connection.execute("""INSERT INTO trade_review_artifact_v3
                        (observation_id,projection_row_id,field_name,crop_ref_id,artifact_hash,pixel_sha256,byte_size,width,height,
                         operational_decision,retention_class,state,attached_at,expired_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'AVAILABLE',?,NULL)""",
                        (observation_id, metadata["projectionRowId"], metadata["field"], metadata["cropRefId"], digest,
                         metadata["pixelSha256"], len(png_bytes), metadata["width"], metadata["height"],
                         field["operationalDecision"], retention, now))
                connection.execute("INSERT INTO trade_review_crop_receipt_v3 VALUES(?,?,?,?,?)", (metadata["cropMutationId"], observation_id, request_hash, canonical_json(response), now))
                if self._storage_usage(connection) > self.artifact_budget_bytes: raise _ArtifactBudgetExceeded
                connection.commit()
            except Exception:
                connection.rollback(); raise
        return response, False

    def create_crop_truth_label(self, observation_id: str, request: Mapping[str, Any], png_bytes: bytes | None = None) -> tuple[dict[str, Any], bool]:
        record = self.get_trade_review_observation(observation_id)
        if record is None or record.get("schemaVersion") != 3: raise RunNotFoundError("v3 observation not found")
        request = json.loads(canonical_json(dict(request)))
        request_json = canonical_json(request); request_hash = sha256_bytes(request_json.encode("utf-8"))
        crop_ref = next(c for row in record["sourceContext"]["rawEvidence"]["snapshot"]["sourceRows"] for field in row["fields"] for c in field["cropRefs"] if c["cropRefId"] == request["cropRefId"])
        artifact = request.get("artifact")
        digest = crop_ref["pngArtifactSha256"] or (artifact["sha256"] if artifact else None)
        pixel_digest = crop_ref["pixelSha256"]
        width, height = crop_ref["box"]["width"], crop_ref["box"]["height"]
        if png_bytes is not None:
            if digest is None or sha256_bytes(png_bytes) != digest: raise EvidenceIntegrityError("truth artifact hash mismatch")
        now = _utc_now(); target = self.artifact_root / f"{digest}.png" if digest else None
        with self._lock, closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            prior = connection.execute("SELECT * FROM trade_crop_truth_receipt_v3 WHERE mutation_id=?", (request["mutationId"],)).fetchone()
            if prior:
                if prior["request_hash"] != request_hash: connection.rollback(); raise MutationConflictError("truth mutation ID was reused with different content")
                response=json.loads(prior["response_json"])
                label=connection.execute("SELECT label_hash FROM trade_crop_truth_label_v3 WHERE label_id=?",(prior["label_id"],)).fetchone()
                if label is None or response.get("labelHash")!=label["label_hash"]: connection.rollback(); raise EvidenceIntegrityError("truth receipt integrity check failed")
                response["duplicate"]=True; connection.commit(); return response, True
            if connection.execute("SELECT 1 FROM trade_review_observation WHERE observation_id=?",(observation_id,)).fetchone():
                connection.rollback(); raise RunNotFoundError("truth labels require a v3 observation")
            latest=connection.execute("SELECT label_id,label_revision FROM trade_crop_truth_label_v3 WHERE observation_id=? AND source_row_id=? AND field_name=? AND crop_ref_id=? ORDER BY label_revision DESC LIMIT 1",
                (observation_id,request["sourceRowId"],request["field"],request["cropRefId"])).fetchone()
            expected_revision=(int(latest["label_revision"])+1) if latest else 1
            expected_supersedes=latest["label_id"] if latest else None
            if request["labelRevision"]!=expected_revision or request["supersedesLabelId"]!=expected_supersedes:
                connection.rollback(); raise MutationConflictError("truth label revision is stale")
            if not digest or connection.execute("SELECT 1 FROM recognition_artifact WHERE artifact_hash=?",(digest,)).fetchone() is None and png_bytes is None:
                connection.rollback(); raise RecognitionStoreError("truth crop artifact is unavailable")
            if png_bytes is not None:
                if self._storage_usage(connection)+len(png_bytes)+8192>self.artifact_budget_bytes: connection.rollback(); raise _ArtifactBudgetExceeded
                self.artifact_root.mkdir(parents=True,exist_ok=True)
                if target.exists():
                    if sha256_bytes(target.read_bytes())!=digest: connection.rollback(); raise EvidenceIntegrityError("truth crop artifact hash collision")
                else:
                    with tempfile.NamedTemporaryFile(prefix=".truth-",suffix=".tmp",dir=self.artifact_root,delete=False) as temp:
                        temp_path=Path(temp.name);temp.write(png_bytes);temp.flush();os.fsync(temp.fileno())
                    os.replace(temp_path,target)
                connection.execute("INSERT OR IGNORE INTO recognition_artifact VALUES(?,?,?,?,?)",(digest,f"artifacts/{digest}.png",len(png_bytes),"image/png",now))
            if connection.execute("SELECT 1 FROM recognition_artifact WHERE artifact_hash=?",(digest,)).fetchone() is None:
                connection.rollback(); raise RecognitionStoreError("truth crop artifact is unavailable")
            label_id=str(uuid.uuid4())
            resolved_artifact={"sha256":digest,"pixelSha256":pixel_digest,"width":width,"height":height}
            label_record={**request,"labelId":label_id,"observationId":observation_id,"persistedAt":now,
                          "artifact":resolved_artifact,"truthEvidence":"HUMAN_CROP_VERIFIED"}
            label_hash=sha256_bytes(canonical_json(label_record).encode("utf-8"));label_record["labelHash"]=label_hash
            response={"schemaVersion":1,"labelId":label_id,"mutationId":request["mutationId"],"observationId":observation_id,
                      "labelHash":label_hash,"persistedAt":now,"duplicate":False}
            connection.execute("""INSERT INTO trade_crop_truth_label_v3
                (label_id,observation_id,source_row_id,field_name,crop_ref_id,label_revision,supersedes_label_id,truth_evidence,
                 label_status,value_json,artifact_hash,pixel_sha256,provenance_json,payload_json,payload_hash,created_at,persisted_at,label_hash)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (label_id,observation_id,request["sourceRowId"],request["field"],request["cropRefId"],request["labelRevision"],
                 request["supersedesLabelId"],"HUMAN_CROP_VERIFIED",request["labelStatus"],canonical_json(request["value"]),digest,
                 pixel_digest,canonical_json(request["provenance"]),request_json,request_hash,request["createdAt"],now,label_hash))
            connection.execute("INSERT INTO trade_crop_truth_receipt_v3 VALUES(?,?,?,?,?)",(request["mutationId"],label_id,request_hash,canonical_json(response),now))
            connection.commit()
            return response,False

    def get_crop_truth_labels(self, observation_id: str) -> list[dict[str, Any]] | None:
        record=self.get_trade_review_observation(observation_id)
        if record is None or record.get("schemaVersion")!=3: return None
        results=[]
        with closing(self._connect()) as connection:
            rows=connection.execute("SELECT * FROM trade_crop_truth_label_v3 WHERE observation_id=? ORDER BY created_at,label_id",(observation_id,)).fetchall()
            for row in rows:
                request=json.loads(row["payload_json"])
                receipt_row=connection.execute("SELECT * FROM trade_crop_truth_receipt_v3 WHERE label_id=?",(row["label_id"],)).fetchone()
                if canonical_json(request)!=row["payload_json"] or sha256_bytes(row["payload_json"].encode("utf-8"))!=row["payload_hash"] or receipt_row is None or request["mutationId"]!=receipt_row["mutation_id"] or receipt_row["request_hash"]!=row["payload_hash"]: raise EvidenceIntegrityError("stored truth request integrity check failed")
                artifact={"sha256":row["artifact_hash"],"pixelSha256":row["pixel_sha256"],"width":request.get("artifact",{}).get("width"),"height":request.get("artifact",{}).get("height")}
                if artifact["width"] is None:
                    ref=next(c for source in record["sourceContext"]["rawEvidence"]["snapshot"]["sourceRows"] for f in source["fields"] for c in f["cropRefs"] if c["cropRefId"]==row["crop_ref_id"])
                    artifact["width"],artifact["height"]=ref["box"]["width"],ref["box"]["height"]
                label={**request,"labelId":row["label_id"],"observationId":observation_id,"persistedAt":row["persisted_at"],"artifact":artifact,"truthEvidence":row["truth_evidence"]}
                if sha256_bytes(canonical_json(label).encode("utf-8"))!=row["label_hash"]: raise EvidenceIntegrityError("stored truth label hash mismatch")
                label["labelHash"]=row["label_hash"]
                artifact_path=self.artifact_root / f"{row['artifact_hash']}.png"
                if not artifact_path.exists(): raise EvidenceIntegrityError("stored truth artifact is missing")
                artifact_bytes=artifact_path.read_bytes()
                if sha256_bytes(artifact_bytes)!=row["artifact_hash"]: raise EvidenceIntegrityError("stored truth artifact hash mismatch")
                crop_ref=next((crop for source in record["sourceContext"]["rawEvidence"]["snapshot"]["sourceRows"]
                               for field in source["fields"] for crop in field["cropRefs"]
                               if crop["cropRefId"]==row["crop_ref_id"]),None)
                if crop_ref is None or crop_ref["sourceRowId"]!=row["source_row_id"] or crop_ref["field"]!=row["field_name"]:
                    raise EvidenceIntegrityError("stored truth crop binding mismatch")
                try:
                    from io import BytesIO
                    from PIL import Image, UnidentifiedImageError
                    image=Image.open(BytesIO(artifact_bytes))
                    if image.format!="PNG" or getattr(image,"n_frames",1)!=1: raise ValueError("invalid truth PNG")
                    image.load()
                    if image.size!=(crop_ref["box"]["width"],crop_ref["box"]["height"]): raise ValueError("truth crop dimensions mismatch")
                    if "A" in image.getbands() and image.getchannel("A").getextrema()!=(255,255): raise ValueError("truth crop alpha is not opaque")
                    pixel_digest=sha256_bytes(image.convert("RGB").tobytes())
                    if pixel_digest!=crop_ref["pixelSha256"] or pixel_digest!=row["pixel_sha256"]:
                        raise ValueError("truth crop pixel hash mismatch")
                except (UnidentifiedImageError,OSError,ValueError):
                    raise EvidenceIntegrityError("stored truth artifact failed pixel verification") from None
                response=json.loads(receipt_row["response_json"])
                expected_receipt={"schemaVersion":1,"labelId":row["label_id"],"mutationId":receipt_row["mutation_id"],"observationId":observation_id,"labelHash":row["label_hash"],"persistedAt":row["persisted_at"],"duplicate":False}
                if canonical_json(response)!=canonical_json(expected_receipt): raise EvidenceIntegrityError("stored truth receipt integrity check failed")
                results.append({"label":label,"receipt":response})
        return results

    def get_trade_crop_artifact_state(self, observation_id: str, digest: str) -> str | None:
        record=self.get_trade_review_observation(observation_id)
        if record is None: return None
        with closing(self._connect()) as connection:
            if record.get("schemaVersion")==3:
                links=connection.execute("SELECT state FROM trade_review_artifact_v3 WHERE observation_id=? AND artifact_hash=?",(observation_id,digest)).fetchall()
                truth=connection.execute("SELECT 1 FROM trade_crop_truth_label_v3 WHERE observation_id=? AND artifact_hash=? LIMIT 1",(observation_id,digest)).fetchone()
                if links:
                    if any(row["state"]=="AVAILABLE" for row in links): return "AVAILABLE"
                    if any(row["state"]=="EXPIRED" for row in links): return "EXPIRED"
                    return "MISSING"
                return "AVAILABLE" if truth else None
        evidence=self.get_trade_review_crop_evidence(observation_id)
        item=next((entry for entry in evidence if entry.get("artifactSha256")==digest),None)
        if item is None:return None
        return item.get("availability")

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
                used = self._storage_usage(connection)
                added = 0 if target.exists() else len(payload)
                if used + added + 8192 > self.artifact_budget_bytes:
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
            elif sha256_bytes(target.read_bytes()) != digest:
                connection.rollback()
                raise EvidenceIntegrityError("existing content-addressed artifact is corrupt")
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
                connection.execute("""UPDATE trade_review_artifact SET state='EXPIRED', expired_at=?
                    WHERE state='AVAILABLE' AND verification_method='USER_MARKED_UNKNOWN' AND attached_at < ?""",
                    (_utc_now(), cutoff_text))
                connection.execute("""UPDATE trade_review_artifact_v3 SET state='EXPIRED', expired_at=?
                    WHERE state='AVAILABLE' AND retention_class='UNKNOWN_EVIDENCE' AND attached_at < ?""",
                    (_utc_now(), cutoff_text))
                rows = connection.execute("""SELECT a.artifact_hash,a.relative_path FROM recognition_artifact a
                    WHERE a.created_at < ? AND NOT EXISTS (
                      SELECT 1 FROM recognition_run_artifact ra JOIN recognition_label l
                      ON l.recognition_id=ra.recognition_id WHERE ra.artifact_hash=a.artifact_hash
                    ) AND NOT EXISTS (
                      SELECT 1 FROM trade_review_artifact ta WHERE ta.artifact_hash=a.artifact_hash
                      AND (ta.state='AVAILABLE' OR ta.verification_method<>'USER_MARKED_UNKNOWN')
                    ) AND NOT EXISTS (
                      SELECT 1 FROM trade_review_artifact_v3 va WHERE va.artifact_hash=a.artifact_hash
                    ) AND NOT EXISTS (
                      SELECT 1 FROM trade_crop_truth_label_v3 tl WHERE tl.artifact_hash=a.artifact_hash
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
            known = set()
            with closing(self._connect()) as connection:
                known = {row[0] for row in connection.execute("SELECT artifact_hash FROM recognition_artifact")}
            if self.artifact_root.exists():
                import re
                for path in self.artifact_root.iterdir():
                    if path.is_file() and re.fullmatch(r"[0-9a-f]{64}\.png", path.name) and path.stem not in known:
                        try:
                            if datetime.fromtimestamp(path.stat().st_mtime, timezone.utc) < cutoff:
                                path.unlink(); removed += 1
                        except OSError:
                            pass
                    elif path.is_file() and path.name.startswith(".evidence-") and path.suffix == ".tmp":
                        try:
                            if datetime.fromtimestamp(path.stat().st_mtime, timezone.utc) < cutoff:
                                path.unlink(); removed += 1
                        except OSError:
                            pass
            return removed
        except sqlite3.Error as error:
            raise RecognitionStoreError("recognition sidecar is unavailable") from error


class _ArtifactBudgetExceeded(RecognitionStoreError):
    pass
