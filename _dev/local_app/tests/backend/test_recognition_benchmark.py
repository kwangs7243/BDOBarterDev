from __future__ import annotations

import hashlib
import json
import runpy
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from io import BytesIO
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from recognition_benchmark import (  # noqa: E402
    evaluate_predictions,
    run_benchmark,
    summarize_legacy_samples,
    validate_split_leakage,
    verify_manifest,
)
from recognition_dataset import export_legacy_feedback, export_to_directory  # noqa: E402


MANIFEST_PATH = ROOT / "tests" / "fixtures" / "recognition-v2" / "manifest.json"


def _png(color=(30, 50, 70)) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (16, 16), color).save(buffer, format="PNG")
    return buffer.getvalue()


def _create_feedback_db(path: Path) -> None:
    image = _png()
    other_image = _png((31, 51, 71))
    report = {
        "grid": {"slotWidth": 8},
        "slots": [
            {"slot": "R1C1", "x": 0, "y": 0, "decision": "MATCH", "bestCandidate": "Item A",
             "finalItem": "Item A", "bestItemId": 1, "quantity": {"status": "QUANTITY_MATCH", "value": 0}},
            {"slot": "R1C2", "x": 8, "y": 0, "decision": "QUANTITY_UNKNOWN", "bestCandidate": "Item C",
             "finalItem": "Item C", "bestItemId": 3, "quantity": {"status": "QUANTITY_UNKNOWN", "value": None}},
        ],
    }
    report_b = json.loads(json.dumps(report))
    report_b["slots"][0].update({"decision": "MATCH", "bestCandidate": "Item B", "finalItem": "Item B",
                                 "bestItemId": 2, "quantity": {"status": "QUANTITY_MATCH", "value": 1}})
    provenance = {"engineVersion": "test-r0", "engineHash": "engine-hash"}
    with sqlite3.connect(path) as connection:
        connection.executescript("""
            CREATE TABLE warehouse_scan (
                scan_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, image_png BLOB NOT NULL,
                report_json TEXT NOT NULL, provenance_json TEXT NOT NULL
            );
            CREATE TABLE warehouse_feedback (
                mutation_id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, created_at TEXT NOT NULL,
                feedback_json TEXT NOT NULL, applied_items_json TEXT NOT NULL
            );
        """)
        connection.execute("INSERT INTO warehouse_scan VALUES (?,?,?,?,?)",
                           ("scan-a", "2026-09-28T00:00:00Z", image,
                            json.dumps(report), json.dumps(provenance)))
        connection.execute("INSERT INTO warehouse_scan VALUES (?,?,?,?,?)",
                           ("scan-b", "2026-09-28T00:01:00Z", image,
                            json.dumps(report_b), json.dumps(provenance)))
        connection.execute("INSERT INTO warehouse_scan VALUES (?,?,?,?,?)",
                           ("scan-c", "2026-09-28T00:02:00Z", other_image,
                            json.dumps(report), json.dumps(provenance)))
        connection.execute("INSERT INTO warehouse_feedback VALUES (?,?,?,?,?)",
                           ("feedback-a", "scan-a", "2026-09-28T00:00:01Z",
                            json.dumps({"version": 2, "scanId": "scan-a", "rows": [
                                {"slot": "R1C1", "name": "Item A", "quantity": 0, "excluded": False, "agreement": "both_match"},
                                {"slot": "R1C2", "name": "Item C", "quantity": 7, "excluded": False, "itemCheck": "match"},
                            ]}), "{}"))
        connection.execute("INSERT INTO warehouse_feedback VALUES (?,?,?,?,?)",
                           ("feedback-b", "scan-b", "2026-09-28T00:01:01Z",
                            json.dumps({"version": 2, "scanId": "scan-b", "rows": [
                                {"slot": "R1C1", "name": "Item B", "quantity": 1, "excluded": False, "agreement": "both_different"},
                            ]}), "{}"))
        connection.execute("INSERT INTO warehouse_feedback VALUES (?,?,?,?,?)",
                           ("feedback-c", "scan-c", "2026-09-28T00:02:01Z",
                            json.dumps({"version": 2, "scanId": "scan-c", "rows": [
                                {"slot": "R1C1", "name": "Item A", "quantity": 0, "excluded": False, "agreement": "both_match"},
                            ]}), "{}"))
    connection.close()


class RecognitionBenchmarkTests(unittest.TestCase):
    def test_manifest_hashes_splits_and_unchanged_fixture_truth(self):
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        checked = verify_manifest(manifest, MANIFEST_PATH)
        self.assertEqual(checked["fixtureCount"], 2)
        self.assertEqual(checked["tradeCaptureCount"], 16)
        self.assertEqual(checked["tradeOracleRowCount"], 80)
        trade = manifest["trade"]
        self.assertTrue(all(row["rowMappingStatus"] == "UNRESOLVED" for row in trade["oracleRows"]))
        self.assertTrue(all(row["labelStatus"] == "UNVERIFIED" for row in trade["oracleRows"]))
        self.assertEqual(trade["catalogAudit"]["reconciliationStatus"], "UNRESOLVED")
        self.assertEqual(len(trade["captures"]), 16)

        old = runpy.run_path(str(ROOT / "tests" / "warehouse_patch_regression.py"))
        fixtures = {record["fixtureId"]: record for record in manifest["fixtures"]}
        expected_ids = {
            "barter-only": (old["DEDICATED_IDS"], old["DEDICATED_QTY"]),
            "mixed": (old["MIXED_IDS"], old["MIXED_QTY"]),
        }
        for fixture_id, (ids, quantities) in expected_ids.items():
            fixture = fixtures[fixture_id]
            truth = json.loads((MANIFEST_PATH.parent / fixture["expectedPath"]).read_text(encoding="utf-8"))
            slots = {slot["slot"]: slot for slot in truth["slots"]}
            self.assertEqual(len(slots), 63)
            for row_index, (id_row, qty_row) in enumerate(zip(ids, quantities), 1):
                for column_index, (expected_id, expected_quantity) in enumerate(zip(id_row, qty_row), 1):
                    slot = slots[f"R{row_index}C{column_index}"]
                    if expected_id is None:
                        self.assertEqual(slot["scope"], "EMPTY")
                        self.assertEqual(slot["quantity"]["status"], "NOT_APPLICABLE")
                    elif expected_id == old["GENERAL"]:
                        self.assertEqual(slot["scope"], "GENERAL_UNKNOWN")
                        self.assertFalse(slot["item"]["verified"])
                        self.assertEqual(slot["quantity"]["value"], expected_quantity)
                    else:
                        self.assertEqual(slot["item"]["value"], expected_id)
                        if expected_quantity is None:
                            self.assertFalse(slot["quantity"]["verified"])
                        else:
                            self.assertEqual(slot["quantity"]["value"], expected_quantity)
        self.assertEqual(sum(fixture["verifiedFields"]["item"] for fixture in fixtures.values()), 105)
        self.assertEqual(sum(fixture["verifiedFields"]["quantity"] for fixture in fixtures.values()), 105)

    def test_v1_baseline_runs_both_fixtures_with_truth_outside_recognizer(self):
        result = run_benchmark("warehouse-current", MANIFEST_PATH, runs=2)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["fixtureCount"], 2)
        self.assertEqual(result["itemMetrics"]["evaluatedCount"], 105)
        self.assertEqual(result["quantityMetrics"]["evaluatedCount"], 105)
        self.assertEqual(result["itemMetrics"]["wrong"], 0)
        self.assertEqual(result["quantityMetrics"]["wrong"], 0)
        self.assertEqual(result["decisionMetrics"]["correctHigh"], None)
        self.assertEqual(result["decisionMetrics"]["highMetricStatus"], "UNAVAILABLE_R0_HAS_NO_HIGH_DECISION")
        self.assertEqual(result["captureMetrics"]["v1VisibleReviewSlots"], 110)
        self.assertEqual(result["captureMetrics"]["meanV1VisibleReviewSlotsPerCapture"], 55)
        self.assertEqual(result["captureMetrics"]["reviewSlotsPerCapture"]["mean"], 5.5)
        self.assertEqual(result["captureMetrics"]["captureCount"], 2)
        self.assertTrue(result["audit"]["reproducibleOutput"])

    def test_unknown_truth_is_not_scored_and_true_zero_is_distinct(self):
        fixture = {"fixtureId": "synthetic-test", "captureId": "capture", "groupId": "group", "split": "replay",
                   "truth": {"slots": [{"slot": "R1C1", "scope": "TARGET_1_4",
                       "item": {"status": "VALUE", "value": 7, "verified": True},
                       "quantity": {"status": "UNVERIFIED", "value": None, "verified": False}}]}}
        prediction = {"R1C1": {"decision": "MATCH", "bestItemId": 7,
                               "quantity": {"status": "QUANTITY_MATCH", "value": 0}}}
        result = evaluate_predictions(fixture, prediction)
        self.assertEqual(result["item"]["evaluated"], 1)
        self.assertEqual(result["quantity"].get("evaluated", 0), 0)
        self.assertEqual(result["quantity"]["unverified"], 1)
        self.assertFalse(result["captureTruthComplete"])
        self.assertIsNone(result["fullCaptureExact"])

        fixture["truth"]["slots"][0]["quantity"] = {"status": "VALUE", "value": 0, "verified": True}
        result = evaluate_predictions(fixture, prediction)
        self.assertEqual(result["quantity"]["exact"], 1)
        self.assertEqual(result["quantity"].get("unknown", 0), 0)

    def test_decision_metrics_keep_wrong_match_and_correct_review_separate(self):
        slots = []
        predictions = {}
        for index, (decision, predicted_item, predicted_qty) in enumerate([
            ("MATCH", 99, 5), ("ICON_MATCH_UNKNOWN", 7, 5), ("QUANTITY_UNKNOWN", 7, None),
        ], 1):
            slot_id = f"R1C{index}"
            slots.append({"slot": slot_id, "scope": "TARGET_1_4",
                          "item": {"status": "VALUE", "value": 7, "verified": True},
                          "quantity": {"status": "VALUE", "value": 5, "verified": True}})
            predictions[slot_id] = {"decision": decision, "bestItemId": predicted_item,
                                    "quantity": {"status": "QUANTITY_MATCH" if predicted_qty is not None else "QUANTITY_UNKNOWN",
                                                 "value": predicted_qty}}
        result = evaluate_predictions({"fixtureId": "metrics", "captureId": "c", "groupId": "g", "split": "replay",
                                       "truth": {"slots": slots}}, predictions)
        self.assertEqual(result["decision"]["wrongAccepted"], 1)
        self.assertEqual(result["decision"]["correctReview"], 1)
        self.assertEqual(result["decision"]["unknownReview"], 1)

    def test_legacy_summary_separates_verified_wrong_unknown_and_review(self):
        def sample(decision, predicted_quantity, truth_quantity, classification):
            return {
                "decision": decision,
                "decisionClassification": classification,
                "fieldTruth": {
                    "item": {"status": "VALUE", "value": "A", "verified": True},
                    "quantity": {"status": "VALUE", "value": truth_quantity, "verified": True},
                },
                "predictedValue": {"item": "A", "quantity": predicted_quantity},
            }
        summary = summarize_legacy_samples([
            sample("MATCH", 8, 9, "WRONG_ACCEPTED"),
            sample("ICON_MATCH_UNKNOWN", 0, 0, "CORRECT_REVIEW"),
            sample("QUANTITY_UNKNOWN", None, 4, "UNKNOWN_REVIEW"),
        ])
        self.assertEqual(summary["quantityFieldResults"], {"exact": 1, "wrong": 1, "unknown": 1, "unverified": 0})
        self.assertEqual(summary["decisionCounts"]["WRONG_ACCEPTED"], 1)
        self.assertEqual(summary["decisionCounts"]["CORRECT_REVIEW"], 1)
        self.assertEqual(summary["correctReview"]["fullSlotReconstructableCount"], 1)
        self.assertEqual(summary["correctReview"]["fullSlotNotReconstructableReviewCount"], 1)

    def test_split_leakage_capture_hash_and_derivative(self):
        for field_case in (
            [{"captureId": "same", "split": "train"}, {"captureId": "same", "split": "test"}],
            [{"sourceImageHash": "same", "split": "train"}, {"sourceImageHash": "same", "split": "test"}],
            [{"derivativeGroupIds": ["same"], "split": "train"}, {"derivativeGroupIds": ["same"], "split": "test"}],
            [{"groupId": "same", "split": "train"}, {"groupId": "same", "split": "test"}],
        ):
            with self.subTest(case=field_case), self.assertRaisesRegex(ValueError, "split leakage"):
                validate_split_leakage(field_case)
        validate_split_leakage([{"groupId": "same", "split": "replay"},
                                {"groupId": "same", "split": "replay"}])

    def test_feedback_export_is_readonly_and_preserves_zero_unknown_and_disputes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            database = Path(temp_dir) / "snapshot.sqlite3"
            _create_feedback_db(database)
            before = hashlib.sha256(database.read_bytes()).hexdigest()
            samples = list(export_legacy_feedback(database))
            after = hashlib.sha256(database.read_bytes()).hexdigest()
            self.assertEqual(before, after)
            self.assertEqual(len(samples), 4)  # two unique source images x two slots
            with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as connection:
                with self.assertRaises(sqlite3.OperationalError):
                    connection.execute("DELETE FROM warehouse_scan")

            by_id = {(scan_id, sample.sample["unitId"]): sample
                     for sample in samples for scan_id in sample.sample["sourceScanIds"]}
            zero = by_id[("scan-c", "R1C1")].sample
            self.assertEqual(zero["fieldTruth"]["quantity"]["status"], "VALUE")
            self.assertEqual(zero["fieldTruth"]["quantity"]["value"], 0)
            legacy = by_id[("scan-a", "R1C2")].sample
            self.assertEqual(legacy["fieldTruth"]["item"]["status"], "VALUE")
            self.assertEqual(legacy["fieldTruth"]["quantity"]["status"], "UNVERIFIED")
            self.assertIsNone(legacy["finalValue"]["quantity"])
            disputed = by_id[("scan-a", "R1C1")].sample
            disputed_repeat = by_id[("scan-b", "R1C1")].sample
            self.assertEqual(disputed["labelStatus"], "DISPUTED", disputed["fieldTruth"])
            self.assertEqual(disputed["fieldTruth"]["item"]["status"], "DISPUTED", disputed["fieldTruth"])
            self.assertEqual(disputed["fieldTruth"]["quantity"]["status"], "DISPUTED", disputed["fieldTruth"])
            self.assertEqual(disputed["sourceImageHash"], disputed_repeat["sourceImageHash"])
            self.assertEqual(disputed["groupId"], disputed_repeat["groupId"])
            self.assertEqual(disputed["sampleId"], disputed_repeat["sampleId"])
            self.assertFalse(disputed["predictionConsistent"])
            self.assertEqual(len(disputed["predictionObservations"]), 2)
            self.assertEqual(disputed["decisionClassification"], "UNKNOWN")
            self.assertNotEqual(disputed["groupId"], zero["groupId"])
            self.assertTrue(all(sample.crop_png and sample.sample["cropHash"] for sample in samples))
            exported = Path(temp_dir) / "dataset"
            first_manifest = export_to_directory(database, exported)
            second_manifest = export_to_directory(database, exported)
            self.assertEqual(first_manifest, second_manifest)
            self.assertEqual(first_manifest["captureCount"], 2)
            self.assertEqual(first_manifest["sourceScanCount"], 3)
            self.assertEqual(first_manifest["sampleCount"], 4)
            self.assertTrue((exported / "samples.jsonl").is_file())
            self.assertGreater(len(list((exported / "artifacts" / "crop").glob("*.png"))), 0)


if __name__ == "__main__":
    unittest.main()
