import io
import sqlite3
import tempfile
import unittest
import uuid
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from local_app.backend.recognition_contracts import validate_feedback_payload
from local_app.backend.recognition_store import RecognitionStore


def small_png(color=(10, 20, 30, 255)):
    output = io.BytesIO()
    Image.new("RGBA", (3, 3), color).save(output, format="PNG")
    return output.getvalue()


def metadata():
    return {"version": 1, "captureId": str(uuid.uuid4()), "batchId": None, "taskType": "warehouse",
            "sourceType": "file", "capturedAt": "2026-09-28T12:00:00Z", "frame": {"width": 3, "height": 3},
            "fidelity": {"sourceWidth": None, "sourceHeight": None, "rescaled": None, "evidence": "unknown"},
            "profileId": None, "profileVersion": 1,
            "context": {"baseRevision": 0, "sessionId": None, "sessionRevision": None},
            "observed": {"browserDpr": None, "windowsDpi": None, "gameResolution": None, "gameUiScale": None}}


class RecognitionArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = RecognitionStore(self.root / "sidecar.sqlite3")
        self.store.initialize()

    def tearDown(self):
        self.temp.cleanup()

    def create_run(self):
        return self.store.create_run(metadata(), input_hash="f" * 64)[0]

    def test_content_addressed_artifacts_are_hash_idempotent(self):
        run = self.create_run()
        png = small_png()
        crops = [{"unitId": "R1C1", "field": "item", "pngBytes": png},
                 {"unitId": "R1C1", "field": "quantity", "pngBytes": png}]
        first = self.store.store_evidence(run, crops)
        second = self.store.store_evidence(run, crops)
        self.assertFalse(first["evidenceIncomplete"])
        self.assertEqual(first, second)
        self.assertEqual(len(first["artifactRefs"]), 2)
        with closing(sqlite3.connect(self.store.database_path)) as connection, connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM recognition_artifact").fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT count(*) FROM recognition_run_artifact").fetchone()[0], 2)
        artifact = self.store.artifact_root / f"{first['artifactRefs'][0]['sha256']}.png"
        self.assertEqual(artifact.read_bytes(), png)

    def test_budget_failure_keeps_metadata_and_reports_incomplete_evidence(self):
        run = self.create_run()
        png = small_png()
        limited = RecognitionStore(self.root / "sidecar.sqlite3", artifact_budget_bytes=len(png) - 1)
        result = limited.store_evidence(run, [{"unitId": "R1C1", "field": "item", "pngBytes": png}])
        self.assertTrue(result["evidenceIncomplete"])
        self.assertEqual(result["artifactMissingReasons"], ["ARTIFACT_BUDGET_EXCEEDED"])
        self.assertEqual(self.store.get_run(run["recognitionId"])["recognitionId"], run["recognitionId"])
        with closing(sqlite3.connect(self.store.database_path)) as connection, connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM recognition_artifact").fetchone()[0], 0)

    def test_disk_failure_is_reported_without_exposing_any_path(self):
        run = self.create_run()
        blocked = self.root / "not-a-directory"
        blocked.write_text("block", encoding="utf-8")
        failing = RecognitionStore(self.root / "sidecar.sqlite3", artifact_root=blocked)
        result = failing.store_evidence(run, [{"unitId": "R1C1", "field": "panel", "pngBytes": small_png()}])
        self.assertTrue(result["evidenceIncomplete"])
        self.assertEqual(result["artifactMissingReasons"], ["ARTIFACT_STORE_FAILED"])
        self.assertNotIn(str(self.root), str(result))

    def test_sidecar_write_failure_keeps_run_and_reports_incomplete_evidence(self):
        run = self.create_run()
        with patch.object(self.store, "_store_artifact", side_effect=sqlite3.OperationalError("disk unavailable")):
            result = self.store.store_evidence(run, [{"unitId": "R1C1", "field": "item", "pngBytes": small_png()}])
        self.assertTrue(result["evidenceIncomplete"])
        self.assertEqual(result["artifactMissingReasons"], ["ARTIFACT_STORE_FAILED"])
        self.assertEqual(self.store.get_run(run["recognitionId"])["recognitionId"], run["recognitionId"])

    def test_retention_is_explicit_and_keeps_artifacts_referenced_by_labels(self):
        unlabelled = self.create_run()
        labelled = self.create_run()
        png1, png2 = small_png(), small_png((30, 40, 50, 255))
        refs1 = self.store.store_evidence(unlabelled, [{"unitId": "R1C1", "field": "item", "pngBytes": png1}])["artifactRefs"]
        refs2 = self.store.store_evidence(labelled, [{"unitId": "R1C1", "field": "item", "pngBytes": png2}])["artifactRefs"]
        payload = validate_feedback_payload({"version": 1, "labelMutationId": str(uuid.uuid4()), "rows": [
            {"unitId": "R1C1", "fields": {"item": {"value": "known", "verification": "explicit", "reason": None}}}
        ]})
        self.store.write_labels(labelled["recognitionId"], payload)
        old = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with closing(sqlite3.connect(self.store.database_path)) as connection, connection:
            connection.execute("UPDATE recognition_artifact SET created_at=?", (old,))
        self.assertEqual(len(list(self.store.artifact_root.glob("*.png"))), 2)
        removed = self.store.cleanup_unlabelled_artifacts(now=datetime.now(timezone.utc))
        self.assertEqual(removed, 1)
        self.assertFalse((self.store.artifact_root / f"{refs1[0]['sha256']}.png").exists())
        self.assertTrue((self.store.artifact_root / f"{refs2[0]['sha256']}.png").exists())


if __name__ == "__main__":
    unittest.main()
