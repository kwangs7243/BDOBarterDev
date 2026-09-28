import json
import sqlite3
import tempfile
import unittest
import uuid
from contextlib import closing
from pathlib import Path

from local_app.backend.recognition_contracts import UNSUPPORTED_FLAGS, validate_config_update
from local_app.backend.recognition_store import (
    ConfigConflictError,
    FutureSchemaError,
    MutationConflictError,
    RecognitionStore,
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

    def test_schema_v1_initializes_idempotently_in_its_own_database(self):
        main_path = self.root / "main.sqlite3"
        with closing(sqlite3.connect(main_path)) as connection, connection:
            connection.execute("CREATE TABLE main_data(value TEXT)")
        self.store.initialize()
        self.store.initialize()
        with closing(sqlite3.connect(self.path)) as connection, connection:
            row = connection.execute("SELECT schema_version,config_revision FROM recognition_meta WHERE id=1").fetchone()
            tables = {item[0] for item in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertEqual(row, (1, 0))
        self.assertTrue({"recognition_run", "capture_profile", "recognition_label", "recognition_label_receipt",
                         "recognition_apply_intent", "recognition_artifact", "recognition_run_artifact"} <= tables)
        with closing(sqlite3.connect(self.path)) as connection, connection:
            self.assertIsNone(connection.execute("SELECT 1 FROM sqlite_master WHERE name='main_data'").fetchone())

    def test_future_and_malformed_schema_are_rejected_without_migration(self):
        future = self.root / "future.sqlite3"
        with closing(sqlite3.connect(future)) as connection, connection:
            connection.execute("CREATE TABLE recognition_meta(id INTEGER PRIMARY KEY, schema_version INTEGER)")
            connection.execute("INSERT INTO recognition_meta VALUES (1, 2)")
        with self.assertRaises(FutureSchemaError):
            RecognitionStore(future).initialize()
        malformed = self.root / "malformed.sqlite3"
        malformed.write_bytes(b"not a sqlite database")
        with self.assertRaises(Exception):
            RecognitionStore(malformed).initialize()

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
