from __future__ import annotations

import hashlib
import inspect
import unittest
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw

from local_app.backend.services.capture_normalization import (
    load_anchor_bundle,
    load_profile,
    normalize_capture,
)


ROOT = Path(__file__).resolve().parents[3]
PROFILE_PATH = ROOT / "local_app" / "recognition_data" / "profiles.json"
ANCHOR_PATH = ROOT / "local_app" / "recognition_data" / "anchors.npz"
FIXTURE_ROOT = ROOT / "fixtures" / "warehouse_patch"


class CaptureNormalizationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profile = load_profile(PROFILE_PATH)
        cls.anchors = load_anchor_bundle(ANCHOR_PATH)

    def fixture(self, name: str) -> Image.Image:
        return Image.open(FIXTURE_ROOT / f"{name}.png").convert("RGB")

    def test_profile_anchor_and_fixture_provenance_are_verified(self):
        self.assertEqual(self.profile["scope"], "warehouse-grid-crop")
        self.assertFalse(self.profile["releaseApproved"])
        self.assertFalse(self.profile["liveApproved"])
        self.assertEqual(self.profile["allowedStrata"], [])
        self.assertEqual(self.profile["anchorLogicalHash"], self.anchors["logicalHash"])
        self.assertEqual(self.anchors["arrays"]["column_edges"].shape, (10,))
        self.assertEqual(self.anchors["arrays"]["row_edges"].shape, (8,))
        for fixture in self.profile["referenceFixtures"]:
            path = ROOT.parent / fixture["path"]
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), fixture["sha256"])

    def test_both_checked_in_fixtures_produce_grid_crop_measurements(self):
        for name in ("barter_only", "mixed"):
            with self.subTest(fixture=name):
                result = normalize_capture(self.fixture(name), self.profile, self.anchors)
                self.assertEqual(result.scope, "warehouse-grid-crop")
                self.assertEqual(result.validity, "VALID_GRID_CROP")
                self.assertEqual((result.measurement["rows"], result.measurement["columns"]), (7, 9))
                self.assertEqual(len(result.rawCrops), 63)
                self.assertAlmostEqual(result.gridEvidence["x"]["period"], 51, delta=1)
                self.assertAlmostEqual(result.gridEvidence["y"]["period"], 51, delta=1)
                self.assertAlmostEqual(result.gridEvidence["x"]["slotWidthRatio"], 45 / 51, delta=.03)
                self.assertAlmostEqual(result.gridEvidence["y"]["slotWidthRatio"], 45 / 51, delta=.03)
                self.assertTrue(all("regions" in box for box in result.rawBoxes))
                self.assertTrue(all("regions" in box for box in result.canonicalBoxes))
                self.assertFalse(result.as_metadata()["highAuthority"])
                self.assertIsNone(result.as_metadata()["recognitionDecision"])

    def test_translation_recovery_uses_frame_pixels(self):
        image = self.fixture("barter_only")
        baseline = normalize_capture(image, self.profile, self.anchors)
        dx, dy = 13, 9
        frame = Image.new("RGB", (image.width + 30, image.height + 24), (24, 24, 27))
        frame.paste(image, (dx, dy))
        translated = normalize_capture(frame, self.profile, self.anchors)
        self.assertEqual(translated.validity, "VALID_GRID_CROP")
        self.assertAlmostEqual(translated.transform["translationX"] - baseline.transform["translationX"], dx, delta=1)
        self.assertAlmostEqual(translated.transform["translationY"] - baseline.transform["translationY"], dy, delta=1)

    def test_uniform_scale_candidates_are_measured_without_declaring_support(self):
        image = self.fixture("barter_only")
        for scale in (.75, 1.0, 1.25):
            with self.subTest(scale=scale):
                resized = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.BILINEAR)
                result = normalize_capture(resized, self.profile, self.anchors)
                self.assertEqual(result.validity, "VALID_GRID_CROP")
                self.assertAlmostEqual(result.transform["scaleX"], scale, delta=.02)
                self.assertAlmostEqual(result.transform["scaleY"], scale, delta=.02)
                self.assertEqual(self.profile["approvedScaleRange"], None)
                self.assertEqual(self.profile["allowedStrata"], [])

    def test_nonuniform_scale_is_explicitly_rejected(self):
        image = self.fixture("barter_only")
        resized = image.resize((round(image.width * 1.25), round(image.height * .75)), Image.Resampling.BILINEAR)
        result = normalize_capture(resized, self.profile, self.anchors)
        self.assertEqual(result.validity, "INVALID_GRID_CROP")
        self.assertIn("NONUNIFORM_TRANSFORM", result.qualityReasons)

    def test_first_and_last_row_column_grid_clipping_are_rejected(self):
        image = self.fixture("barter_only")
        cases = {
            "first-column": image.crop((10, 0, image.width, image.height)),
            "last-column": image.crop((0, 0, 440, image.height)),
            "first-row": image.crop((0, 20, image.width, image.height)),
            "last-row": image.crop((0, 0, image.width, 340)),
        }
        for name, clipped in cases.items():
            with self.subTest(edge=name):
                result = normalize_capture(clipped, self.profile, self.anchors)
                self.assertEqual(result.validity, "INVALID_GRID_CROP")
                self.assertIn("GRID_CLIPPED", result.qualityReasons)

    def test_quantity_region_clipped_at_grid_boundary_is_explicit(self):
        image = self.fixture("barter_only")
        result = normalize_capture(image.crop((0, 0, image.width, 340)), self.profile, self.anchors)
        self.assertIn("DIGIT_REGION_CLIPPED", result.qualityReasons)

    def test_grid_missing_is_not_treated_as_a_recognition_candidate(self):
        blank = Image.new("RGB", (100, 80), (24, 24, 27))
        result = normalize_capture(blank, self.profile, self.anchors)
        self.assertEqual(result.validity, "INVALID_GRID_CROP")
        self.assertIn("GRID_NOT_FOUND", result.qualityReasons)
        self.assertEqual(result.rawCrops, [])
        self.assertIsNone(result.as_metadata()["recognitionDecision"])

    def test_tier5_pixels_do_not_affect_geometry_authority(self):
        image = self.fixture("mixed")
        result = normalize_capture(image, self.profile, self.anchors)
        altered_content = image.copy()
        ImageDraw.Draw(altered_content).rectangle((12, 14, 34, 36), fill=(245, 12, 220))
        altered_result = normalize_capture(altered_content, self.profile, self.anchors)
        self.assertEqual(result.validity, "VALID_GRID_CROP")
        self.assertEqual(altered_result.validity, result.validity)
        self.assertEqual(altered_result.transform, result.transform)
        self.assertEqual(result.profileStratum, "unsupported")
        self.assertFalse(result.as_metadata()["highAuthority"])
        self.assertEqual(self.profile["allowedStrata"], [])

    def test_raw_and_canonical_slot_and_region_crops_are_reproducible(self):
        image = self.fixture("barter_only").resize((351, 277), Image.Resampling.BILINEAR)
        first = normalize_capture(image, self.profile, self.anchors)
        second = normalize_capture(image, self.profile, self.anchors)
        self.assertEqual(first.validity, "VALID_GRID_CROP")
        self.assertEqual(first.rawCrops[0].size, second.rawCrops[0].size)
        self.assertEqual(first.rawCrops[0].tobytes(), second.rawCrops[0].tobytes())
        self.assertEqual(first.canonicalCrops[0].size, (45, 45))
        self.assertEqual(first.canonicalCrops[0].tobytes(), second.canonicalCrops[0].tobytes())
        self.assertNotEqual(first.rawCrops[0].size, first.canonicalCrops[0].size)
        self.assertEqual(first.rawRegionCrops[0]["quantity"].tobytes(), second.rawRegionCrops[0]["quantity"].tobytes())
        self.assertEqual(first.canonicalRegionCrops[0]["icon"].size, (41, 25))
        self.assertEqual(first.canonicalRegionCrops[0]["quantity"].size, (8, 12))

    def test_resampling_candidates_are_measurements_not_approvals(self):
        image = self.fixture("barter_only").resize((390, 307), Image.Resampling.BILINEAR)
        outputs = {}
        for kernel in ("bilinear", "bicubic", "lanczos"):
            result = normalize_capture(image, self.profile, self.anchors, resampling=kernel)
            self.assertEqual(result.measurement["resamplingCandidate"], kernel)
            outputs[kernel] = result.canonicalCrops[0]
        self.assertGreater(ImageChops.difference(outputs["bilinear"], outputs["lanczos"]).getbbox() is not None, 0)
        self.assertIsNone(self.profile["approvedResamplingKernel"])

    def test_item_oracle_is_not_an_input_to_geometry(self):
        parameters = inspect.signature(normalize_capture).parameters
        self.assertEqual(set(parameters), {"image", "profile", "anchor_data", "resampling"})
        self.assertNotIn("oracle", inspect.getsource(normalize_capture).lower())


if __name__ == "__main__":
    unittest.main()
