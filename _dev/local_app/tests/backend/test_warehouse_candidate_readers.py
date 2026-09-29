from __future__ import annotations

import inspect
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image
from PIL import ImageDraw


ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from local_app.backend.services.warehouse_candidate_readers import (  # noqa: E402
    Q1_PARAMS,
    load_q1_templates,
    load_r1_templates,
    quantity_roi_from_slot,
    run_q1,
    run_r1,
)
import local_app.tools.recognition_experiments as experiments  # noqa: E402
import recognition_benchmark as benchmark_module  # noqa: E402


Q1_TEMPLATES = ROOT / "tools" / "warehouse_patch" / "quantity_templates.npz"
REFERENCE = ROOT / "reference" / "barter_items.json"
MODEL_MANIFEST = ROOT / "local_app" / "recognition_data" / "model-manifest.json"


class WarehouseCandidateReaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.q1 = load_q1_templates(Q1_TEMPLATES)
        cls.r1 = load_r1_templates(REFERENCE)
        zero_index = next(index for index, label in enumerate(cls.q1["labels"]) if int(label) == 0)
        cls.zero = (cls.q1["features"][zero_index].reshape((12, 8)) > 0.5).astype(np.uint8) * 255

    def band(self):
        return Image.new("RGB", (43, 15), (20, 20, 22))

    def paste_zero(self, image, xy):
        image.paste(Image.fromarray(self.zero, mode="L").convert("RGB"), xy)
        return image

    def test_r1_ncc_self_match_and_constant_input_are_finite(self):
        reference = self.r1["items"][0]
        image = Image.fromarray((reference["rgb"] * 255).astype(np.uint8), mode="RGB")
        result = run_r1(image, self.r1)
        self.assertEqual(result, run_r1(image, self.r1))
        self.assertEqual(result["top1"]["itemId"], reference["itemId"])
        self.assertTrue(np.isfinite(result["top1"]["grayscaleNcc"]))
        constant = run_r1(Image.new("RGB", (41, 25), (0, 0, 0)), self.r1)
        self.assertEqual(constant["status"], "UNKNOWN")
        self.assertIn("NCC_UNDEFINED", constant["qualityReasons"])
        self.assertTrue(all(row["grayscaleNcc"] is None for row in constant["candidateOrder"]))

    def test_r1_and_q1_inference_interfaces_take_only_reader_inputs(self):
        self.assertEqual(set(inspect.signature(run_r1).parameters), {"icon_crop", "templates"})
        self.assertEqual(set(inspect.signature(run_q1).parameters), {"quantity_crop", "templates"})
        self.assertEqual(Q1_PARAMS["quantityRoiCanonical"], [1, 29, 44, 44])
        slot = Image.new("RGB", (45, 45), (20, 20, 22))
        self.assertEqual(quantity_roi_from_slot(slot).size, (43, 15))

    def test_r1_icon_roi_is_invariant_to_quantity_overlay(self):
        first = Image.new("RGB", (45, 45), (20, 20, 22))
        reference = self.r1["items"][0]["rgb"]
        icon = Image.fromarray((reference * 255).astype(np.uint8), mode="RGB")
        first.paste(icon, (2, 2))
        second = first.copy()
        for x in range(32, 42):
            for y in range(30, 41):
                second.putpixel((x, y), (245, 245, 245))
        first_result = run_r1(first.crop((2, 2, 43, 27)), self.r1)
        second_result = run_r1(second.crop((2, 2, 43, 27)), self.r1)
        self.assertEqual(first_result, second_result)

    def test_zero_is_value_and_empty_is_missing(self):
        zero = run_q1(self.paste_zero(self.band(), (33, 1)), self.q1)
        self.assertEqual(zero, run_q1(self.paste_zero(self.band(), (33, 1)), self.q1))
        missing = run_q1(self.band(), self.q1)
        self.assertEqual((zero["status"], zero["value"]), ("VALUE", 0))
        self.assertNotEqual(zero["digits"][0]["candidates"][0]["digit"],
                            zero["digits"][0]["candidates"][1]["digit"])
        self.assertEqual((missing["status"], missing["value"]), ("MISSING", None))

    def test_clipped_token_edges_abstain(self):
        cases = {"left": (0, 2, 2, 12), "right": (41, 2, 42, 12),
                 "top": (18, 0, 24, 1), "bottom": (18, 14, 24, 14)}
        for edge, box in cases.items():
            with self.subTest(edge=edge):
                image = self.band()
                ImageDraw.Draw(image).rectangle(box, fill=(255, 255, 255))
                result = run_q1(image, self.q1)
                self.assertEqual(result["status"], "CLIPPED")
                self.assertTrue(any(reason.startswith("CLIPPED_") for reason in result["qualityReasons"]))

    def test_more_than_four_components_never_returns_value(self):
        image = self.band()
        for x in (1, 9, 17, 25, 33):
            self.paste_zero(image, (x, 1))
        result = run_q1(image, self.q1)
        self.assertNotEqual(result["status"], "VALUE")
        self.assertIn("MORE_THAN_FOUR_DIGITS_POSSIBLE", result["qualityReasons"])

    def test_merged_and_split_components_abstain(self):
        merged = self.band()
        self.paste_zero(merged, (12, 1))
        self.paste_zero(merged, (17, 1))
        merged_result = run_q1(merged, self.q1)
        self.assertNotEqual(merged_result["status"], "VALUE")
        self.assertTrue({"MERGED_COMPONENT_SUSPECTED", "DIGIT_CLASSIFIER_AMBIGUOUS"}
                        & set(merged_result["qualityReasons"]))

        split = self.band()
        self.paste_zero(split, (18, 1))
        # Remove a full vertical column through the foreground to create two fragments.
        pixels = split.load()
        for y in range(15):
            pixels[22, y] = (20, 20, 22)
        split_result = run_q1(split, self.q1)
        self.assertNotEqual(split_result["status"], "VALUE")
        self.assertTrue(split_result["qualityReasons"])

    def test_all_candidate_inference_finishes_before_fixture_truth_is_loaded(self):
        counts = {"r1": 0, "q1": 0}
        original_r1, original_q1 = experiments.run_r1, experiments.run_q1
        original_benchmark = benchmark_module.run_benchmark

        def tracked_r1(*args, **kwargs):
            counts["r1"] += 1
            return original_r1(*args, **kwargs)

        def tracked_q1(*args, **kwargs):
            counts["q1"] += 1
            return original_q1(*args, **kwargs)

        def checked_benchmark(*args, **kwargs):
            self.assertEqual(counts, {"r1": 252, "q1": 252})
            return original_benchmark(*args, **kwargs)

        with patch.object(experiments, "run_r1", side_effect=tracked_r1), \
                patch.object(experiments, "run_q1", side_effect=tracked_q1), \
                patch.object(experiments, "run_benchmark", side_effect=checked_benchmark):
            result = experiments.build_candidate_artifact(runs=1, feedback_jsonl=None)
        self.assertTrue(result["truthLeakageEvidence"]["candidateInferenceCompletedBeforeFixtureTruthEvaluation"])
        self.assertEqual(result["approval"]["approvedReaders"], [])
        self.assertEqual(result["approval"]["HIGH"], 0)
        simulation = result["policySimulation"]
        self.assertEqual(simulation["hypotheticalHigh"] + simulation["hypotheticalReviewCount"], 105)
        self.assertEqual(simulation["hypotheticalCorrectReview"] + simulation["hypotheticalWrongReview"],
                         simulation["hypotheticalReviewCount"])

    def test_candidate_manifest_remains_unapproved_and_covers_all_digits(self):
        manifest = json.loads(MODEL_MANIFEST.read_text(encoding="utf-8"))
        candidate = manifest["candidateMeasurements"]
        self.assertEqual(candidate["Q1"]["templateCoverage"], list(range(10)))
        self.assertEqual(candidate["R1"]["pHashStatus"], "NOT_IMPLEMENTED_WITH_REASON")
        self.assertIsNone(candidate["policyHash"])
        self.assertFalse(candidate["approved"])
        self.assertEqual(candidate["approvedReaders"], [])
        self.assertEqual(candidate["HIGH"], 0)
        self.assertFalse(candidate["productionRecognitionActivated"])


if __name__ == "__main__":
    unittest.main()
