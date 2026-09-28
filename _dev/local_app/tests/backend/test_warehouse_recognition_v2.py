from __future__ import annotations

import hashlib
import inspect
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image


ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import recognition_benchmark as benchmark_module  # noqa: E402
from local_app.backend.services.capture_normalization import load_anchor_bundle, load_profile, normalize_capture  # noqa: E402
from local_app.backend.services.warehouse_recognition import _pixel_hash, run_r0_shadow  # noqa: E402
import local_app.backend.services.warehouse_recognition as recognition_service  # noqa: E402
from local_app.tools.recognition_experiments import _classification, build_artifact  # noqa: E402
from recognition_benchmark import (  # noqa: E402
    canonical_hash,
    run_benchmark,
    sha256_file,
)
from warehouse_patch import convert as convert_r0  # noqa: E402


MANIFEST = ROOT / "tests" / "fixtures" / "recognition-v2" / "manifest.json"
FIXTURE_ROOT = ROOT / "fixtures" / "warehouse_patch"
REFERENCE = ROOT / "reference" / "barter_items.json"
TEMPLATES = ROOT / "tools" / "warehouse_patch" / "quantity_templates.npz"
PROFILE_PATH = ROOT / "local_app" / "recognition_data" / "profiles.json"
ANCHOR_PATH = ROOT / "local_app" / "recognition_data" / "anchors.npz"


class WarehouseRecognitionV2Tests(unittest.TestCase):
    def test_inference_signature_has_no_truth_stock_or_correction_inputs(self):
        parameters = set(inspect.signature(run_r0_shadow).parameters)
        self.assertEqual(parameters, {"image_path", "reference_json", "templates_path", "profile_path", "anchor_path"})
        self.assertFalse({"truth", "expected", "oracle", "stock", "final_value", "correction"} & parameters)

    def test_adapter_preserves_frozen_r0_patch_and_semantic_slot_output(self):
        for name in ("barter_only", "mixed"):
            path = FIXTURE_ROOT / f"{name}.png"
            baseline_patch, baseline_report = convert_r0(path, REFERENCE, TEMPLATES)
            patch, report = run_r0_shadow(path, REFERENCE, TEMPLATES, PROFILE_PATH, ANCHOR_PATH)
            self.assertEqual(patch, baseline_patch)
            self.assertEqual(report["slots"], baseline_report["slots"])
            self.assertEqual(report["t006aEvidence"]["engineStage"], "T006A_R0_EVIDENCE_ONLY")
            self.assertFalse(report["t006aEvidence"]["candidateImprovement"])
            self.assertFalse(report["t006aEvidence"]["policyApproved"])
            self.assertFalse(report["t006aEvidence"]["highAuthority"])
            self.assertFalse(report["t006aEvidence"]["automationEligible"])

    def test_all_inference_finishes_before_impossible_oracle_is_opened(self):
        baseline = {}
        fixtures = json.loads(MANIFEST.read_text(encoding="utf-8"))["fixtures"]
        for fixture in fixtures:
            path = (MANIFEST.parent / fixture["imagePath"]).resolve()
            baseline[path.name] = convert_r0(path, REFERENCE, TEMPLATES)[1]["slots"]
        reports = {}
        inference_count = 0
        original_shadow = recognition_service.run_r0_shadow
        original_load = benchmark_module.load_json

        def tracked_inference(*args, **kwargs):
            nonlocal inference_count
            patch_value, report = original_shadow(*args, **kwargs)
            inference_count += 1
            reports[Path(args[0]).name] = report["slots"]
            return patch_value, report

        def impossible_oracle(path):
            if Path(path).name.endswith(".expected.json"):
                self.assertEqual(inference_count, len(fixtures))
                self.assertEqual(set(reports), set(baseline))
                truth = original_load(path)
                for slot in truth["slots"]:
                    if slot.get("item", {}).get("verified"):
                        slot["item"]["value"] = -999999
                    if slot.get("quantity", {}).get("verified"):
                        slot["quantity"]["value"] = 999999999
                return truth
            return original_load(path)

        with patch.object(recognition_service, "run_r0_shadow", side_effect=tracked_inference), \
                patch.object(benchmark_module, "load_json", side_effect=impossible_oracle):
            result = run_benchmark("warehouse-v2", MANIFEST, runs=1)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(reports, baseline)

    def test_warehouse_v2_benchmark_matches_t001_semantic_baseline(self):
        baseline = run_benchmark("warehouse-current", MANIFEST, runs=1)
        shadow = run_benchmark("warehouse-v2", MANIFEST, runs=2)
        for key in ("itemMetrics", "quantityMetrics", "decisionMetrics", "captureMetrics", "byField", "bySlot", "byStratum"):
            self.assertEqual(shadow[key], baseline[key], key)
        self.assertEqual(shadow["itemMetrics"]["exact"], 105)
        self.assertEqual(shadow["quantityMetrics"]["exact"], 105)
        self.assertEqual(shadow["decisionMetrics"]["wrongAccepted"], 0)
        self.assertEqual(shadow["decisionMetrics"]["correctReview"], 6)
        self.assertEqual(shadow["captureMetrics"]["fullCaptureExactCount"], 2)
        self.assertEqual(shadow["engineStage"], "T006A_R0_EVIDENCE_ONLY")
        self.assertFalse(shadow["candidateImprovement"])
        self.assertFalse(shadow["policyApproved"])
        self.assertFalse(shadow["highAuthority"])
        self.assertTrue(shadow["audit"]["reproducibleOutput"])
        self.assertEqual(shadow["audit"]["runs"], 2)
        for capture in shadow["byCapture"]:
            self.assertIn("t006aEvidence", capture)
            self.assertEqual(len(capture["t006aEvidence"]["slots"]), 63)

    def test_t005a_crop_hashes_are_stable_and_scaled_raw_canonical_are_distinct(self):
        image = Image.open(FIXTURE_ROOT / "barter_only.png").convert("RGB")
        profile = load_profile(PROFILE_PATH)
        anchors = load_anchor_bundle(ANCHOR_PATH)
        scaled = image.resize((351, 277), Image.Resampling.BILINEAR)
        first = normalize_capture(scaled, profile, anchors)
        second = normalize_capture(scaled, profile, anchors)
        self.assertEqual(first.validity, "VALID_GRID_CROP")
        self.assertEqual(_pixel_hash(first.rawCrops[0]), _pixel_hash(second.rawCrops[0]))
        self.assertEqual(_pixel_hash(first.canonicalCrops[0]), _pixel_hash(second.canonicalCrops[0]))
        self.assertNotEqual(first.rawCrops[0].size, first.canonicalCrops[0].size)
        self.assertNotEqual(_pixel_hash(first.rawCrops[0]), _pixel_hash(first.canonicalCrops[0]))
        self.assertNotEqual(_pixel_hash(first.rawRegionCrops[0]["icon"]),
                            _pixel_hash(first.canonicalRegionCrops[0]["icon"]))

    def test_taxonomy_keeps_wrong_accepted_review_and_unknown_truth_separate(self):
        truth = {"scope": "TARGET_1_4",
                 "item": {"status": "VALUE", "value": 7, "verified": True},
                 "quantity": {"status": "VALUE", "value": 0, "verified": True}}
        exact_zero = {"decision": "ICON_MATCH_UNKNOWN", "bestItemId": 7,
                      "quantity": {"status": "QUANTITY_MATCH", "value": 0}}
        wrong_match = {"decision": "MATCH", "bestItemId": 8,
                       "quantity": {"status": "QUANTITY_MATCH", "value": 0}}
        unknown_truth = {"scope": "TARGET_1_4",
                         "item": {"status": "UNVERIFIED", "value": None, "verified": False},
                         "quantity": {"status": "VALUE", "value": 0, "verified": True}}
        self.assertEqual(_classification(truth, exact_zero), "CORRECT_REVIEW")
        self.assertEqual(_classification(truth, wrong_match), "WRONG_ACCEPTED")
        self.assertEqual(_classification(unknown_truth, wrong_match), "UNVERIFIED_ACCEPTED")

    def test_duplicate_r0_slots_are_not_auto_summed(self):
        source = FIXTURE_ROOT / "barter_only.png"
        baseline_patch, baseline_report = convert_r0(source, REFERENCE, TEMPLATES)
        accepted = next(row for row in baseline_report["slots"] if row["decision"] == "MATCH")
        empty = next(row for row in baseline_report["slots"] if row["decision"] == "EMPTY")
        width = baseline_report["grid"]["slotWidth"]
        period = baseline_report["grid"]["period"]
        origin = baseline_report["grid"]["origin"]
        with Image.open(source) as original:
            image = original.convert("RGB")
        source_crop = image.crop((accepted["x"], accepted["y"], accepted["x"] + width, accepted["y"] + width))
        target_x = origin["x"] + (empty["column"] - 1) * period
        target_y = origin["y"] + (empty["row"] - 1) * period
        image.paste(source_crop, (target_x, target_y))
        with tempfile.TemporaryDirectory() as folder:
            duplicate_path = Path(folder) / "duplicate.png"
            image.save(duplicate_path)
            patch, report = convert_r0(duplicate_path, REFERENCE, TEMPLATES)
        duplicate_rows = [row for row in report["slots"] if row.get("bestItemId") == accepted["bestItemId"]]
        self.assertGreaterEqual(len(duplicate_rows), 2)
        self.assertTrue(all(row["decision"] == "DUPLICATE_ITEM_DETECTED" for row in duplicate_rows))
        self.assertNotIn(accepted["finalItem"], patch["items"])
        self.assertEqual(baseline_patch["items"].get(accepted["finalItem"]), accepted["quantity"]["value"])

    def test_experiment_separates_correct_review_from_historical_gap_and_tier5(self):
        result = build_artifact(runs=1, feedback_jsonl=ROOT / "recognition-local" / "legacy-feedback-v7" / "samples.jsonl")
        self.assertEqual(len(result["correctReviewEvidence"]), 6)
        self.assertEqual(result["wrongAcceptedEvidence"], [])
        self.assertEqual(result["historicalWrongAccepted"]["documentedCount"], 7)
        self.assertEqual(result["historicalWrongAccepted"]["replayableCount"], 0)
        self.assertEqual(result["historicalWrongAccepted"]["status"], "DOCUMENTED_AGGREGATE_NOT_REPLAYABLE")
        self.assertEqual(result["storedLegacyWrongAccepted"]["count"], 7)
        self.assertTrue(all(row["source"] == "STORED_LEGACY_PREDICTION"
                            for row in result["storedLegacyWrongAccepted"]["samples"]))
        self.assertIn("UNMAPPED", result["storedLegacyWrongAccepted"]["historicalSevenMappingStatus"])
        self.assertEqual(result["missingEvidence"]["legacyWrongAcceptedDigitDetails"], 7)
        self.assertEqual(result["legacyFeedbackDataset"]["sampleCount"], 306)
        self.assertEqual(result["legacyFeedbackDataset"]["labelCounts"],
                         {"DISPUTED": 0, "HUMAN_VERIFIED": 175, "UNVERIFIED": 131})
        self.assertEqual(result["legacyFeedbackDataset"]["disputedFieldCounts"], {"item": 0, "quantity": 0})
        self.assertEqual(result["legacyFeedbackDataset"]["verifiedFieldCounts"], {"item": 175, "quantity": 163})
        self.assertEqual(result["tier5"]["excludedCount"], 10)
        self.assertFalse(result["tier5"]["metricEligible"])
        self.assertEqual(result["mainDatabaseWriteCount"], 0)
        self.assertFalse(result["userDatabaseAccessed"])
        self.assertEqual(result["engine"]["HIGH"], 0)
        self.assertFalse(result["engine"]["automationEligible"])

    def test_manifest_hashes_match_frozen_resources(self):
        manifest_path = ROOT / "local_app" / "recognition_data" / "model-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        resources = manifest["resources"]
        self.assertEqual(resources["r0SourceSha256"], sha256_file(ROOT / "tools" / "warehouse_patch" / "warehouse_patch.py"))
        self.assertEqual(resources["catalogSha256"], sha256_file(REFERENCE))
        self.assertEqual(resources["quantityTemplatesSha256"], sha256_file(TEMPLATES))
        self.assertEqual(resources["profileSha256"], sha256_file(PROFILE_PATH))
        self.assertEqual(resources["anchorLogicalSha256"], load_anchor_bundle(ANCHOR_PATH)["logicalHash"])
        self.assertEqual(resources["parameterSha256"], canonical_hash(resources["parameters"]))
        icon_records = resources["iconBundle"]["entries"]
        logical = json.dumps(icon_records, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        self.assertEqual(resources["iconBundle"]["logicalSha256"], hashlib.sha256(logical).hexdigest())
        for icon in icon_records:
            self.assertEqual(icon["sha256"], sha256_file(ROOT / "reference" / icon["path"]))
        self.assertIsNone(manifest["policyHash"])
        self.assertFalse(manifest["approved"])
        self.assertFalse(manifest["highAuthority"])


if __name__ == "__main__":
    unittest.main()
