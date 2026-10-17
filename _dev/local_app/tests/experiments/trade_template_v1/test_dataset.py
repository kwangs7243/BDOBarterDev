from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from local_app.experiments.trade_template_v1.dataset import collect_dataset
from local_app.experiments.trade_template_v1.contracts import hash_file


class FakeOCR:
    @staticmethod
    def detect_live_rows(_image):
        return []


def _png(path: Path, color=(30, 40, 50)) -> bytes:
    image = Image.new("RGB", (987, 456), color)
    image.save(path, format="PNG")
    return path.read_bytes()


class DatasetTests(unittest.TestCase):
    def test_same_image_memberships_merge_and_conflicting_labels_quarantine(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            artifact = root / "artifact"
            prep = root / "prep"
            run = root / "run"
            fixture = prep / "baseline-source/_dev/local_app/tests/fixtures/trade-recognition"
            fixture.mkdir(parents=True)
            (fixture / "정답.json").write_text("[]", encoding="utf-8")
            (fixture / "live-list-mapping.json").write_text("[]", encoding="utf-8")
            png_dir = artifact / "fixed-region-work"
            png_dir.mkdir(parents=True)
            source_png = png_dir / "capture.png"
            payload = _png(source_png)
            metadata = {"sourceType": "native-screen", "fidelity": {"rescaled": False},
                        "frame": {"width": 987, "height": 456}}
            stored_rows = [{"captureId": "capture-1", "ordinal": 0,
                            "rowBox": {"x": 0, "y": 0, "width": 987, "height": 70},
                            "fields": {"yield": {"corrected": 2, "reviewRequired": False,
                                                  "valueSource": "USER_REVIEW", "rawOCR": "2"}}}]
            index = [{"captureId": "capture-1", "imagePath": str(source_png), "metadata": metadata,
                      "stored": {"batchId": "batch-1", "phase": "reviewed", "rows": stored_rows}},
                     {"captureId": "capture-2", "imagePath": str(source_png), "metadata": metadata,
                      "stored": {"batchId": "batch-1", "phase": "recognized", "rows": []}}]
            (png_dir / "trade-input.json").write_text(json.dumps(index), encoding="utf-8")
            (artifact / "speed-review").mkdir()
            (artifact / "speed-review/latest-captures.json").write_text("[]", encoding="utf-8")
            db_path = artifact / "history.sqlite3"
            connection = sqlite3.connect(db_path)
            connection.execute("CREATE TABLE trade_correction (feedback_id TEXT,capture_id TEXT,created_at TEXT,image_png BLOB,details_json TEXT)")
            for index_value, label in enumerate((2, 3)):
                details = {"metadata": metadata, "corrections": [{"field": "yield", "finalValue": label,
                            "ordinal": 0, "rowBox": {"x": 0, "y": 0, "width": 987, "height": 70},
                            "rawOCR": str(label)}]}
                connection.execute("INSERT INTO trade_correction VALUES(?,?,?,?,?)", (f"f{index_value}", "capture-1", f"2026-01-0{index_value+1}", payload, json.dumps(details)))
            connection.commit()
            connection.close()
            sources = [
                {"id": "native77-capture-index", "root": "artifactRoot", "path": "fixed-region-work/trade-input.json", "sha256": hash_file(png_dir / "trade-input.json"), "bytes": (png_dir / "trade-input.json").stat().st_size},
                {"id": "latest15-capture-index", "root": "artifactRoot", "path": "speed-review/latest-captures.json", "sha256": hash_file(artifact / "speed-review/latest-captures.json"), "bytes": 2},
                {"id": "history-before-cleanup", "root": "artifactRoot", "path": "history.sqlite3", "sha256": hash_file(db_path), "bytes": db_path.stat().st_size},
            ]
            manifest = {"dataSources": sources, "priorBaselineReplays": []}
            config_path = Path(__file__).resolve().parents[4] / "specs/trade-template-v1/experiment-config.json"
            # The production collector resolves this pinned config relative to its implementation package.
            self.assertTrue(config_path.is_file())
            result = collect_dataset(manifest, {"artifactRoot": artifact, "preparationRoot": prep}, run,
                                     FakeOCR, {"masterData": {"0": [], "1": [], "2": [], "3": [], "4": [], "5": [], "6": [], "7": []}, "specialItems": [], "islands": [], "t6Islands": [], "t7Islands": []})
            self.assertEqual(result["uniqueImages"], 1)
            self.assertEqual(len(result["images"][0]["memberships"]), 4)
            self.assertEqual(result["truthFieldCount"], 0)
            self.assertTrue(any(item.get("reason") == "CONFLICTING_CONFIRMED_VALUES" for item in result["quarantine"]))
            self.assertEqual(result["splitGroupCounts"].get("ENROLL", 0) + result["splitGroupCounts"].get("CALIBRATION", 0) + result["splitGroupCounts"].get("TEST", 0), 1)


if __name__ == "__main__":
    unittest.main()
