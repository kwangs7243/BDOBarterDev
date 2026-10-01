from __future__ import annotations

import json
import inspect
import sys
import unittest
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from local_app.backend.services.trade_recognition import (  # noqa: E402
    FIELDS, _lane_boxes, _numeric_evidence, canonical_hash, detect_rows,
    infer_trade_capture, validate_trade_integer,
)
from local_app.tools.trade_recognition_experiments import (  # noqa: E402
    _candidate_lanes, infer_trade_numeric_field_v2, run_trade_candidate,
    validate_trade_manifest,
)


class TradeRecognitionV2Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture_root = ROOT / "local_app" / "tests" / "fixtures" / "recognition-v2"
        cls.manifest = json.loads((cls.fixture_root / "manifest.json").read_text(encoding="utf-8"))
        cls.experiment = json.loads((ROOT / "local_app" / "recognition_data" / "trade-t010a-experiment.json").read_text(encoding="utf-8"))
        cls.experiment_v2 = json.loads((ROOT / "local_app" / "recognition_data" / "trade-t010a2-experiment.json").read_text(encoding="utf-8"))

    def test_manifest_keeps_all_trade_mapping_unresolved(self):
        audit = validate_trade_manifest(self.manifest)
        self.assertEqual(audit, {"captureCount": 16, "oracleRowCount": 80,
                                 "mappedOracleRows": 0, "rowMappingStatus": "UNRESOLVED"})

    def test_repeated_row_separator_detection_is_deterministic_without_expected_count(self):
        image = Image.new("RGB", (320, 165), (10, 10, 10))
        draw = ImageDraw.Draw(image)
        for y in (10, 80, 85, 155):
            draw.line((0, y, 319, y), fill=(245, 245, 245), width=1)
        first = detect_rows(image, self.experiment["parameters"])
        second = detect_rows(image, self.experiment["parameters"])
        self.assertEqual(first, second)
        self.assertEqual(len(first), 2)
        self.assertTrue(all(abs(row["top"] - expected_top) <= 1 and row["bottom"] == expected_bottom
                            for row, expected_top, expected_bottom in zip(first, (10, 85), (80, 155))))
        self.assertTrue(all(row["bottom"] > row["top"] for row in first))

    def test_boundary_rows_are_separate_clipped_candidates(self):
        image = Image.new("RGB", (320, 80), (10, 10, 10))
        ImageDraw.Draw(image).line((0, 30, 319, 30), fill=(245, 245, 245), width=1)
        candidates = detect_rows(image, self.experiment["parameters"])
        self.assertGreaterEqual(len(candidates), 1)
        self.assertTrue(all(row["clipped"] for row in candidates))
        self.assertTrue(any(set(row.get("reasonCodes", [])) & {"ROW_CLIPPED_TOP", "ROW_CLIPPED_BOTTOM"}
                            for row in candidates))

    def test_six_lanes_have_reproducible_normalized_geometry(self):
        lanes, errors = _lane_boxes(990, 70, self.experiment["parameters"]["lanes"])
        self.assertEqual(set(lanes), set(FIELDS))
        self.assertEqual(errors, [])
        self.assertTrue(all(lane["valid"] for lane in lanes.values()))
        self.assertTrue(all(0 <= lane["box"]["normalized"]["x0"] < lane["box"]["normalized"]["x1"] <= 1
                            for lane in lanes.values()))
        bad = dict(self.experiment["parameters"]["lanes"])
        bad["yield"] = {"x0": 0.2, "x1": 0.8, "y0": 0.2, "y1": 0.8}
        rejected, reasons = _lane_boxes(990, 70, bad)
        self.assertTrue(any("LANE_OVERLAP" in reason for reason in reasons))
        self.assertFalse(rejected["yield"]["valid"])

    def test_numeric_empty_clipped_partial_and_no_default(self):
        empty = Image.new("RGB", (40, 20), (0, 0, 0))
        self.assertEqual(_numeric_evidence(empty, "count", {"top": False, "bottom": False})["status"], "MISSING")
        edge = Image.new("RGB", (40, 20), (0, 0, 0))
        ImageDraw.Draw(edge).rectangle((0, 4, 4, 15), fill=(250, 250, 250))
        self.assertEqual(_numeric_evidence(edge, "count", {"top": False, "bottom": False})["status"], "CLIPPED")
        partial = Image.new("RGB", (40, 20), (0, 0, 0))
        ImageDraw.Draw(partial).rectangle((10, 4, 11, 7), fill=(250, 250, 250))
        record = _numeric_evidence(partial, "count", {"top": False, "bottom": False})
        self.assertEqual(record["status"], "UNREADABLE")
        self.assertIsNone(record["value"])
        self.assertIsNone(record["rawText"])
        self.assertFalse(record["readerEvidence"]["reconstructable"])
        self.assertEqual(record["readerEvidence"]["componentCount"], 1)
        self.assertTrue(record["readerEvidence"]["components"])

    def test_t010a2_separates_raw_edge_noise_from_plausible_token_clipping(self):
        noise_and_token = Image.new("RGB", (40, 20), (0, 0, 0))
        draw = ImageDraw.Draw(noise_and_token)
        draw.line((0, 1, 20, 1), fill=(250, 250, 250), width=1)
        draw.rectangle((15, 5, 18, 15), fill=(250, 250, 250))
        result = infer_trade_numeric_field_v2(
            noise_and_token, "count", {"top": False, "bottom": False}, self.experiment_v2)
        self.assertEqual(result["readerEvidence"]["readerId"], "connected-component-token-structure-v2")
        self.assertEqual(result["status"], "UNVERIFIED_NUMERIC_CANDIDATE")
        self.assertIn("FOREGROUND_EDGE_NOISE", result["reasonCodes"])
        self.assertNotIn("TOKEN_BOUNDARY_CONTACT", result["reasonCodes"])
        self.assertTrue(result["readerEvidence"]["rawForegroundBoundaryContact"]["left"])
        self.assertFalse(any(result["readerEvidence"]["plausibleTokenBoundaryContact"].values()))
        self.assertIsNone(result["value"])
        self.assertFalse(result["readerEvidence"]["reconstructable"])

    def test_t010a2_actual_plausible_edge_component_remains_clipped(self):
        image = Image.new("RGB", (40, 20), (0, 0, 0))
        ImageDraw.Draw(image).rectangle((0, 5, 3, 15), fill=(250, 250, 250))
        result = infer_trade_numeric_field_v2(
            image, "yield", {"top": False, "bottom": False}, self.experiment_v2)
        self.assertEqual(result["status"], "CLIPPED")
        self.assertIn("TOKEN_BOUNDARY_CONTACT", result["reasonCodes"])

    def test_t010a2_empty_and_small_partial_classification(self):
        empty = infer_trade_numeric_field_v2(
            Image.new("RGB", (40, 20), (0, 0, 0)), "reqAmount",
            {"top": False, "bottom": False}, self.experiment_v2)
        self.assertEqual(empty["status"], "MISSING")
        self.assertIn("NO_FOREGROUND_COMPONENTS", empty["reasonCodes"])
        partial = Image.new("RGB", (40, 20), (0, 0, 0))
        ImageDraw.Draw(partial).rectangle((10, 7, 11, 8), fill=(250, 250, 250))
        result = infer_trade_numeric_field_v2(
            partial, "reqAmount", {"top": False, "bottom": False}, self.experiment_v2)
        self.assertEqual(result["status"], "UNREADABLE")
        self.assertIn("NO_PLAUSIBLE_TOKEN_COMPONENTS", result["reasonCodes"])
        self.assertIsNone(result["value"])

    def test_t010a2_finite_lane_candidates_obey_bounds_and_overlap_guards(self):
        operations = self.experiment_v2["laneCandidateDerivation"]["operations"]
        candidates = _candidate_lanes(self.experiment["parameters"]["lanes"], "reqAmount", operations)
        self.assertEqual(len(candidates), len(operations))
        results = []
        for candidate in candidates:
            lanes, errors = _lane_boxes(990, 70, candidate["lanes"])
            results.append((candidate["candidateId"], lanes, errors))
        self.assertTrue(any(errors for _, _, errors in results), "expansion touching an adjacent semantic lane must be rejected")
        self.assertTrue(any(not errors and all(item["valid"] for item in lanes.values())
                            for _, lanes, errors in results), "finite sweep must retain valid candidates")

    def test_original_t010a_benchmark_semantic_hash_is_reproducible(self):
        fixture_root = ROOT / "local_app" / "tests" / "fixtures" / "recognition-v2"
        artifact = run_trade_candidate(
            fixture_root / "manifest.json",
            ROOT / "local_app" / "recognition_data" / "trade-t010a-experiment.json", runs=10)
        payload = {key: value for key, value in artifact.items() if key not in {"timing", "semanticHash"}}
        payload["baseCommit"] = self.experiment_v2["baselineT010ACommit"]
        relocation = json.loads((ROOT / "local_app/tests/fixtures/resource-relocation.json").read_text(encoding="utf-8"))
        # Guard current bytes before comparing with the immutable pre-relocation result.
        for key, hashes in relocation["resources"].items():
            self.assertEqual(payload["resourceHashes"][key], hashes["after"])
            payload["resourceHashes"][key] = hashes["before"]
        self.assertEqual(canonical_hash(payload), self.experiment_v2["baselineT010ASemanticHash"])

    def test_trade_integer_domain_rejects_bool_float_negative_and_zero_minima(self):
        self.assertTrue(validate_trade_integer("count", 0))
        self.assertTrue(validate_trade_integer("reqAmount", 1))
        self.assertTrue(validate_trade_integer("yield", 1))
        for field, value in (("count", True), ("count", 1.0), ("count", -1),
                             ("reqAmount", 0), ("reqAmount", -1), ("yield", 0), ("yield", 1.5)):
            self.assertFalse(validate_trade_integer(field, value), (field, value))

    def test_inference_has_no_oracle_input_and_emits_six_unconfirmed_fields(self):
        capture = self.manifest["trade"]["captures"][0]
        image_path = (self.fixture_root / capture["imagePath"]).resolve()
        result_a = infer_trade_capture(image_path, capture["captureId"], self.experiment["parameters"])
        # Oracle content is intentionally varied outside the inference API boundary.
        changed_oracle = json.loads(json.dumps(self.manifest["trade"]["oracleRows"]))
        changed_oracle[0]["fields"]["count"]["rawValue"] = 987654321
        result_b = infer_trade_capture(image_path, capture["captureId"], self.experiment["parameters"])
        self.assertEqual(canonical_hash(result_a), canonical_hash(result_b))
        self.assertEqual(list(inspect.signature(infer_trade_capture).parameters), ["image_path", "capture_id", "parameters"])
        self.assertNotIn("expectedRows", inspect.signature(detect_rows).parameters)
        self.assertGreater(result_a["rowDetection"]["candidateRows"], 0)
        for row in result_a["rows"]:
            self.assertEqual(set(row["fields"]), set(FIELDS))
            self.assertTrue(all(row["fields"][field]["status"] == "UNREADABLE"
                                for field in ("island", "fromItem", "toItem")))
            self.assertFalse(row["clipped"] and row["fields"]["count"]["status"] != "CLIPPED")


if __name__ == "__main__":
    unittest.main()
