from __future__ import annotations

import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image

from local_app.tools.warehouse_feedback_calibration import calibrate
from tools.warehouse_patch.warehouse_patch import GridDetectionError, QuantityReader, crop_inner_slots, detect_grid, load_reference

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "local_app/tests/fixtures/warehouse_patch"
BASE = ROOT / "tools/warehouse_patch/quantity_templates.npz"


class WarehouseScaleTests(unittest.TestCase):
    def test_full_grid_survives_fractional_and_large_scales(self):
        with Image.open(FIXTURES / "barter_only.png") as original:
            for scale in (0.5, 0.65, 0.8, 1.2, 1.5, 2.0, 2.5):
                with self.subTest(scale=scale):
                    image = original.resize((round(original.width * scale), round(original.height * scale)), Image.Resampling.LANCZOS)
                    xgrid, ygrid, _ = detect_grid(image)
                    self.assertEqual((xgrid.count, ygrid.count), (9, 7))
                    slots = crop_inner_slots(image, xgrid, ygrid)
                    self.assertEqual(len(slots), 63)
                    self.assertTrue(all(slot["rgb"].shape == (43, 43, 3) for slot in slots))
                    self.assertEqual(len({(slot["x"], slot["y"]) for slot in slots}), 63)
                    self.assertTrue(all(slot["x"] + slot["width"] <= image.width and
                                        slot["y"] + slot["height"] <= image.height for slot in slots))

    def test_two_visible_rows_and_extra_capture_margins(self):
        with Image.open(FIXTURES / "barter_only.png") as original:
            crop = original.crop((0, 0, original.width, 110))
            padded = Image.new("RGB", (crop.width + 80, crop.height + 50), (10, 10, 10))
            padded.paste(crop, (31, 17))
            xgrid, ygrid, _ = detect_grid(padded)
            self.assertEqual((xgrid.count, ygrid.count), (9, 2))

    def test_scaled_grid_inside_full_screen_capture(self):
        with Image.open(FIXTURES / "mixed.png") as original:
            for scale in (0.65, 1.5):
                with self.subTest(scale=scale):
                    image = original.resize((round(original.width * scale), round(original.height * scale)), Image.Resampling.LANCZOS)
                    screen = Image.new("RGB", (1920, 1080), (12, 12, 12))
                    screen.paste(image, (937, 221))
                    xgrid, ygrid, _ = detect_grid(screen)
                    self.assertEqual((xgrid.count, ygrid.count), (9, 7))

    def test_blank_image_is_not_a_warehouse(self):
        with self.assertRaises(GridDetectionError):
            detect_grid(Image.new("RGB", (400, 400), (20, 20, 20)))

    def test_only_explicit_latest_feedback_becomes_templates(self):
        with tempfile.TemporaryDirectory(prefix="warehouse-calibration-") as temporary:
            folder = Path(temporary)
            archive = folder / "dataset.zip"
            manifest = json.loads((FIXTURES / "calibration_manifest.json").read_text())
            labels = [{"slot": f"R{slot['row']}C{slot['column']}", "name": "checked item",
                       "quantity": slot["quantity"], "excluded": False, "agreement": "both_match"}
                      for slot in manifest["slots"] if slot["quantity"] is not None]
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("manifest.json", json.dumps({"formatVersion": 2}))
                bundle.writestr("scans/checked/input.png", (FIXTURES / "calibration.png").read_bytes())
                bundle.writestr("scans/checked/feedback.json", json.dumps([
                    {"feedback": {"version": 2, "rows": labels}},
                    {"feedback": {"version": 2, "rows": [
                        {**labels[0], "agreement": "unchecked"},
                        {**labels[1], "excluded": True},
                        {**labels[2], "quantity": None}
                    ]}}
                ]))
            output = folder / "calibrated.npz"
            provenance = calibrate(archive, BASE, output)
            self.assertEqual(provenance["verifiedRows"], len(labels) - 3)
            with np.load(BASE, allow_pickle=False) as original, np.load(output, allow_pickle=False) as calibrated:
                for key in ("digit_features", "digit_labels", "blank_features_0", "blank_features_1"):
                    np.testing.assert_array_equal(original[key], calibrated[key])
            with self.assertRaisesRegex(ValueError, "No explicitly verified"):
                calibrate(archive, BASE, folder / "empty.npz", holdout_scan="checked")

    def test_feedback_does_not_replace_confident_original_matches(self):
        reader = QuantityReader(BASE)
        reader.feedback_templates = (reader.digit_features, (reader.digit_labels + 1) % 10,
                                     reader.blank_features)
        with Image.open(FIXTURES / "calibration.png") as image:
            xgrid, ygrid, _ = detect_grid(image)
            for slot in crop_inner_slots(image, xgrid, ygrid):
                original = reader._read(slot["rgb"], reader.digit_features, reader.digit_labels, reader.blank_features)
                if original["status"] == "QUANTITY_MATCH":
                    self.assertEqual(reader.read(slot["rgb"]), original)
        items, references = load_reference(ROOT / "reference/barter_items.json")
        reader.feedback_icons = references[::-1]
        reader.feedback_item_names = [item["programName"] for item in items]
        scores = reader.icon_scores(references[0], items, references)
        self.assertEqual(int(np.argmin(scores)), 0)
        self.assertGreater(np.partition(scores, 1)[1] - scores[0], 0.045)

    def test_scaled_numbers_remain_correct_or_uncertain(self):
        manifest = json.loads((FIXTURES / "calibration_manifest.json").read_text())
        truth = {(slot["row"], slot["column"]): slot["quantity"]
                 for slot in manifest["slots"] if slot["quantity"] is not None}
        with tempfile.TemporaryDirectory(prefix="warehouse-scaling-") as temporary:
            folder = Path(temporary)
            archive = folder / "dataset.zip"
            labels = [{"slot": f"R{row}C{column}", "name": "checked item", "quantity": value,
                       "excluded": False, "agreement": "both_match"}
                      for (row, column), value in truth.items()]
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("manifest.json", json.dumps({"formatVersion": 2}))
                bundle.writestr("scans/checked/input.png", (FIXTURES / "calibration.png").read_bytes())
                bundle.writestr("scans/checked/feedback.json", json.dumps([
                    {"feedback": {"version": 2, "rows": labels}}
                ]))
            model = folder / "calibrated.npz"
            calibrate(archive, BASE, model)
            reader = QuantityReader(model)
            with Image.open(FIXTURES / "calibration.png") as original:
                for scale in (0.65, 0.8, 1.0, 1.2, 2.5):
                    with self.subTest(scale=scale):
                        image = original.resize((round(original.width * scale), round(original.height * scale)), Image.Resampling.LANCZOS)
                        xgrid, ygrid, _ = detect_grid(image)
                        confirmed = 0
                        for slot in crop_inner_slots(image, xgrid, ygrid):
                            key = (slot["row"], slot["column"])
                            if key not in truth:
                                continue
                            result = reader.read(slot["rgb"], slot["source_size"])
                            if result["status"] == "QUANTITY_MATCH":
                                self.assertEqual(result["value"], truth[key], (scale, key, result))
                                confirmed += 1
                        self.assertGreaterEqual(confirmed, len(truth) // 2)
                        if scale == 1.0:
                            self.assertEqual(confirmed, len(truth))


if __name__ == "__main__":
    unittest.main()
