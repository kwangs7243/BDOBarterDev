import json
import sqlite3
import tempfile
import unittest
import uuid
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from local_app.backend.recognition_contracts import UNSUPPORTED_FLAGS, validate_config_update
from local_app.backend.recognition_store import (
    ConfigConflictError,
    FutureSchemaError,
    MutationConflictError,
    RecognitionStore,
    RecognitionStoreError,
)


def metadata(profile_id=None, profile_version=1):
    return {"version": 1, "captureId": str(uuid.uuid4()), "batchId": None,
            "taskType": "warehouse", "sourceType": "file", "capturedAt": "2026-09-28T12:00:00Z",
            "frame": {"width": 4, "height": 3},
            "fidelity": {"sourceWidth": None, "sourceHeight": None, "rescaled": None, "evidence": "unknown"},
            "profileId": profile_id, "profileVersion": profile_version,
            "context": {"baseRevision": 0, "sessionId": None, "sessionRevision": None},
            "observed": {"browserDpr": None, "windowsDpi": None, "gameResolution": None, "gameUiScale": None}}


def profile(profile_id=None, version=1, width=1.0):
    return {"version": 1, "id": profile_id or str(uuid.uuid4()), "profileVersion": version,
            "taskType": "warehouse", "sourceType": "file", "referenceFrame": {"width": 1920, "height": 1080},
            "region": {"x": 0.0, "y": 0.0, "w": width, "h": 1.0}, "anchorSetId": "fixture-set",
            "anchorSetHash": "b" * 64, "anchorOffsets": {}, "canonicalGeometry": {},
            "observed": {"windowsDpi": None, "gameResolution": None, "gameUiScale": None}, "verifiedStratumIds": []}


def label_payload(value=0, mutation_id=None):
    return {"version": 1, "labelMutationId": mutation_id or str(uuid.uuid4()), "rows": [
        {"unitId": "R1C1", "fields": {"quantity": {"value": value, "verification": "explicit", "reason": "checked"}}}
    ]}


class RecognitionStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root / "recognition" / "recognition.sqlite3"
        self.store = RecognitionStore(self.path)

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def _drop_v3(connection):
        for table in ("trade_crop_truth_receipt_v3", "trade_crop_truth_label_v3", "trade_review_crop_receipt_v3",
                      "trade_review_artifact_v3", "trade_review_observation_v3"):
            connection.execute(f"DROP TABLE {table}")

    def test_schema_v3_initializes_idempotently_in_its_own_database(self):
        main_path = self.root / "main.sqlite3"
        with closing(sqlite3.connect(main_path)) as connection, connection:
            connection.execute("CREATE TABLE main_data(value TEXT)")
        self.store.initialize()
        self.store.initialize()
        with closing(sqlite3.connect(self.path)) as connection, connection:
            row = connection.execute("SELECT schema_version,config_revision FROM recognition_meta WHERE id=1").fetchone()
            tables = {item[0] for item in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertEqual(row, (3, 0))
        self.assertTrue({"recognition_run", "capture_profile", "recognition_label", "recognition_label_receipt",
                         "recognition_apply_intent", "recognition_artifact", "recognition_run_artifact",
                         "trade_review_observation", "trade_review_artifact", "trade_review_crop_receipt",
                         "trade_review_observation_v3", "trade_review_artifact_v3", "trade_review_crop_receipt_v3",
                         "trade_crop_truth_label_v3", "trade_crop_truth_receipt_v3"} <= tables)
        with closing(sqlite3.connect(self.path)) as connection, connection:
            self.assertIsNone(connection.execute("SELECT 1 FROM sqlite_master WHERE name='main_data'").fetchone())

    def test_v2_to_v3_migration_is_additive_idempotent_and_backed_up(self):
        self.store.initialize()
        run, _ = self.store.create_run(metadata(), input_hash="9" * 64)
        old_schema = {}
        old_rows = {}
        with closing(sqlite3.connect(self.path)) as connection, connection:
            self._drop_v3(connection)
            connection.execute("UPDATE recognition_meta SET schema_version=2 WHERE id=1")
            names = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%_v3'")]
            old_schema = {name: connection.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",(name,)).fetchone()[0] for name in names}
            old_rows = {name: connection.execute(f'SELECT * FROM "{name}"').fetchall() for name in names}
        self.store.initialize()
        self.store.initialize()
        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(connection.execute("SELECT schema_version FROM recognition_meta WHERE id=1").fetchone()[0], 3)
            old_tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%_v3'")}
            new_schema = {name: connection.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",(name,)).fetchone()[0] for name in old_tables}
            new_rows = {name: connection.execute(f'SELECT * FROM "{name}"').fetchall() for name in old_tables}
        old_rows["recognition_meta"] = [tuple([1,2,*old_rows["recognition_meta"][0][2:]])]
        new_rows["recognition_meta"] = [tuple([1,2,*new_rows["recognition_meta"][0][2:]])]
        self.assertEqual(old_schema, new_schema)
        self.assertEqual(old_rows, new_rows)
        self.assertEqual(self.store.get_run(run["recognitionId"])["inputHash"], "9" * 64)
        self.assertTrue({"trade_review_observation", "trade_review_artifact", "trade_review_crop_receipt"} <= old_tables)
        self.assertTrue(self.path.with_name(self.path.name + ".v2-backup").exists())

    def test_v2_to_v3_ddl_failure_rolls_back_partial_schema(self):
        self.store.initialize()
        with closing(sqlite3.connect(self.path)) as connection, connection:
            self._drop_v3(connection)
            connection.execute("UPDATE recognition_meta SET schema_version=2 WHERE id=1")
        module = __import__("local_app.backend.recognition_store", fromlist=["TRADE_REVIEW_V3_SCHEMA"])
        with patch("local_app.backend.recognition_store.TRADE_REVIEW_V3_SCHEMA", ("CREATE TABLE trade_review_observation_v3 (",)):
            with self.assertRaises(RecognitionStoreError): self.store.initialize()
        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(connection.execute("SELECT schema_version FROM recognition_meta WHERE id=1").fetchone()[0], 2)
            self.assertIsNone(connection.execute("SELECT 1 FROM sqlite_master WHERE name='trade_review_observation_v3'").fetchone())

    def test_future_and_malformed_schema_are_rejected_without_migration(self):
        future = self.root / "future.sqlite3"
        with closing(sqlite3.connect(future)) as connection, connection:
            connection.execute("CREATE TABLE recognition_meta(id INTEGER PRIMARY KEY, schema_version INTEGER)")
            connection.execute("INSERT INTO recognition_meta VALUES (1, 4)")
        with self.assertRaises(FutureSchemaError):
            RecognitionStore(future).initialize()
        malformed = self.root / "malformed.sqlite3"
        malformed.write_bytes(b"not a sqlite database")
        with self.assertRaises(Exception):
            RecognitionStore(malformed).initialize()

    def test_v1_migration_preserves_rows_and_rolls_back_failed_ddl(self):
        self.store.initialize()
        capture = metadata()
        run, _ = self.store.create_run(capture, input_hash="a" * 64)
        labels, _ = self.store.write_labels(run["recognitionId"], label_payload(0))
        artifact_bytes = b"legacy-artifact-bytes"
        artifact_result = self.store.store_evidence(run, [{"unitId": "R1C1", "field": "item", "pngBytes": artifact_bytes}])
        self.assertEqual(len(artifact_result["artifactRefs"]), 1)
        artifact_path = self.store.artifact_root / f"{artifact_result['artifactRefs'][0]['sha256']}.png"
        self.assertEqual(artifact_path.read_bytes(), artifact_bytes)
        with closing(sqlite3.connect(self.path)) as connection, connection:
            self._drop_v3(connection)
            connection.execute("DROP TABLE trade_review_crop_receipt")
            connection.execute("DROP TABLE trade_review_artifact")
            connection.execute("DROP TABLE trade_review_observation")
            connection.execute("UPDATE recognition_meta SET schema_version=1 WHERE id=1")
        with patch("local_app.backend.recognition_store.TRADE_REVIEW_SCHEMA", ("CREATE TABLE broken (",)):
            with self.assertRaises(RecognitionStoreError):
                self.store.initialize()
        with closing(sqlite3.connect(self.path)) as connection, connection:
            self.assertEqual(connection.execute("SELECT schema_version FROM recognition_meta WHERE id=1").fetchone()[0], 1)
            self.assertIsNone(connection.execute("SELECT 1 FROM sqlite_master WHERE name='trade_review_observation'").fetchone())
        self.store.initialize()
        with closing(sqlite3.connect(self.path)) as connection, connection:
            self.assertEqual(connection.execute("SELECT schema_version FROM recognition_meta WHERE id=1").fetchone()[0], 3)
            self.assertEqual(connection.execute("SELECT count(*) FROM recognition_run").fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT count(*) FROM recognition_label").fetchone()[0], len(labels["labels"]))
        self.assertEqual(artifact_path.read_bytes(), artifact_bytes)

    def test_migration_backup_meta_commit_and_stale_backup_failures_are_non_destructive(self):
        self.store.initialize()
        with closing(sqlite3.connect(self.path)) as connection, connection:
            self._drop_v3(connection)
            for table in ("trade_review_crop_receipt", "trade_review_artifact", "trade_review_observation"):
                connection.execute(f"DROP TABLE {table}")
            connection.execute("UPDATE recognition_meta SET schema_version=1 WHERE id=1")
        with patch("local_app.backend.recognition_store.tempfile.NamedTemporaryFile", side_effect=OSError("backup unavailable")):
            with self.assertRaises(RecognitionStoreError): self.store.initialize()
        with closing(sqlite3.connect(self.path)) as connection, connection:
            self.assertEqual(connection.execute("SELECT schema_version FROM recognition_meta").fetchone()[0], 1)
        original_schema = __import__("local_app.backend.recognition_store", fromlist=["TRADE_REVIEW_SCHEMA"]).TRADE_REVIEW_SCHEMA
        fail_meta = "CREATE TRIGGER fail_migration_meta BEFORE UPDATE ON recognition_meta BEGIN SELECT RAISE(ABORT,'injected'); END"
        with patch("local_app.backend.recognition_store.TRADE_REVIEW_SCHEMA", (*original_schema, fail_meta)):
            with self.assertRaises(RecognitionStoreError): self.store.initialize()
        with closing(sqlite3.connect(self.path)) as connection, connection:
            self.assertEqual(connection.execute("SELECT schema_version FROM recognition_meta").fetchone()[0], 1)
            self.assertIsNone(connection.execute("SELECT 1 FROM sqlite_master WHERE name='trade_review_observation'").fetchone())
        with patch.object(self.store, "_commit_schema_migration", side_effect=sqlite3.OperationalError("injected commit failure")):
            with self.assertRaises(RecognitionStoreError): self.store.initialize()
        with closing(sqlite3.connect(self.path)) as connection, connection:
            self.assertEqual(connection.execute("SELECT schema_version FROM recognition_meta").fetchone()[0], 1)
            self.assertIsNone(connection.execute("SELECT 1 FROM sqlite_master WHERE name='trade_review_observation'").fetchone())
        self.store.initialize()

    def test_migration_refuses_stale_backup_and_unexpected_table_collision(self):
        self.store.initialize()
        with closing(sqlite3.connect(self.path)) as connection, connection:
            self._drop_v3(connection)
            for table in ("trade_review_crop_receipt", "trade_review_artifact", "trade_review_observation"):
                connection.execute(f"DROP TABLE {table}")
            connection.execute("UPDATE recognition_meta SET schema_version=1 WHERE id=1")
        backup_path = self.path.with_name(self.path.name + ".v1-backup")
        with closing(sqlite3.connect(backup_path)) as backup, backup:
            backup.execute("CREATE TABLE unrelated(value TEXT)")
        with self.assertRaises(RecognitionStoreError): self.store.initialize()
        with closing(sqlite3.connect(self.path)) as connection:
            connection.execute("DROP TABLE IF EXISTS unrelated")
            connection.execute("CREATE TABLE unexpected_collision(value TEXT)")
            connection.commit()
        backup_path.unlink()
        with self.assertRaises(RecognitionStoreError): self.store.initialize()
        with closing(sqlite3.connect(self.path)) as connection, connection:
            self.assertEqual(connection.execute("SELECT schema_version FROM recognition_meta").fetchone()[0], 1)

    def test_config_cas_and_immutable_profile_snapshots(self):
        self.store.initialize()
        first_profile = profile()
        update = validate_config_update({"version": 1, "expectedConfigRevision": 0,
                                         "flags": {key: False for key in UNSUPPORTED_FLAGS},
                                         "profiles": [first_profile]})
        config = self.store.update_config(update["expectedConfigRevision"], update["flags"], update["profiles"])
        self.assertEqual(config["configRevision"], 1)
        with self.assertRaises(ConfigConflictError):
            self.store.update_config(0, update["flags"], update["profiles"])
        capture = metadata(first_profile["id"], 1)
        run, created = self.store.create_run(capture, input_hash="a" * 64)
        self.assertTrue(created)
        self.assertEqual(run["report"]["profileSnapshot"]["region"]["w"], 1.0)
        second_profile = profile(first_profile["id"], version=2, width=0.9)
        changed = self.store.update_config(1, update["flags"], [second_profile])
        self.assertEqual(changed["configRevision"], 2)
        saved = self.store.get_run(run["recognitionId"])
        self.assertEqual(saved["report"]["profileVersion"], 1)
        self.assertEqual(saved["report"]["profileSnapshot"]["region"]["w"], 1.0)

    def test_capture_run_is_idempotent_and_conflicting_reuse_is_rejected(self):
        self.store.initialize()
        capture = metadata()
        first, created = self.store.create_run(capture, input_hash="c" * 64)
        replay, replay_created = self.store.create_run(capture, input_hash="c" * 64)
        self.assertTrue(created)
        self.assertFalse(replay_created)
        self.assertEqual(first["recognitionId"], replay["recognitionId"])
        self.assertIn("captureMetadata", first["report"])
        with self.assertRaises(MutationConflictError):
            self.store.create_run(capture, input_hash="d" * 64)
        with closing(sqlite3.connect(self.path)) as connection, connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM recognition_run").fetchone()[0], 1)

    def test_label_receipt_idempotency_conflict_and_dispute_preserve_run(self):
        self.store.initialize()
        run, _ = self.store.create_run(metadata(), input_hash="e" * 64)
        first_payload = label_payload(0)
        first, duplicate = self.store.write_labels(run["recognitionId"], first_payload)
        replay, replayed = self.store.write_labels(run["recognitionId"], first_payload)
        self.assertFalse(duplicate)
        self.assertTrue(replayed)
        self.assertEqual(first, replay)
        changed_payload = label_payload(1, first_payload["labelMutationId"])
        with self.assertRaises(MutationConflictError):
            self.store.write_labels(run["recognitionId"], changed_payload)
        disputed, _ = self.store.write_labels(run["recognitionId"], label_payload(1))
        self.assertEqual(disputed["labels"][0]["status"], "DISPUTED")
        saved_run = self.store.get_run(run["recognitionId"])
        self.assertEqual(saved_run["report"], run["report"])
        with closing(sqlite3.connect(self.path)) as connection, connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM recognition_label").fetchone()[0], 2)
            values = [json.loads(row[0]) for row in connection.execute("SELECT value_json FROM recognition_label ORDER BY label_version")]
        self.assertEqual(values, [0, 1])


if __name__ == "__main__":
    unittest.main()
