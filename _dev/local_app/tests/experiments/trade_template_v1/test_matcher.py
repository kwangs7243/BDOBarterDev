from __future__ import annotations

import hashlib
import unittest

import numpy as np
from PIL import Image

from local_app.experiments.trade_template_v1.matcher import exact_match, map_row_box, probe_layout


class MatcherTests(unittest.TestCase):
    def test_layout_requires_both_detected_anchors_and_native_metadata(self):
        image = np.zeros((456, 987, 3), dtype=np.uint8)
        image[:, 7, :] = 255
        image[:, 272, :] = 255
        pil = Image.fromarray(image)
        config = {"layout": {"frame": [987, 456], "sourceType": "native-screen", "rescaled": False,
                             "anchorsX": [6, 271], "searchRadiusX": 8, "edgeDeltaExclusive": 20,
                             "minimumAnchorSupport": .75}}
        metadata = {"sourceType": "native-screen", "fidelity": {"rescaled": False}}
        valid = probe_layout(pil, metadata, config)
        self.assertTrue(valid.valid)
        self.assertEqual(valid.offset_x, 0)
        self.assertFalse(probe_layout(pil, {**metadata, "sourceType": "browser-stream"}, config).valid)
        self.assertFalse(probe_layout(pil, {"sourceType": "native-screen", "fidelity": {"rescaled": True}}, config).valid)

    def test_exact_match_checks_context_hash_shape_and_pixels(self):
        crop = Image.new("RGB", (10, 5), (1, 2, 3))
        pixels = crop.tobytes()
        reference = {"referenceId": "ref-1", "label": 3, "rgbSha256": hashlib.sha256(pixels).hexdigest(),
                     "rgbShape": [5, 10, 3]}
        bank = {"contexts": {"context": [reference]}, "_referencePixels": {"ref-1": pixels}}
        hit = exact_match(crop, {"contextKey": "context"}, bank)
        self.assertEqual((hit.status, hit.value, hit.reference_ids), ("HIT", 3, ("ref-1",)))
        self.assertEqual(exact_match(crop, {"contextKey": "other"}, bank).reason, "NO_REFERENCE")
        altered = Image.new("RGB", (10, 5), (1, 2, 4))
        self.assertEqual(exact_match(altered, {"contextKey": "context"}, bank).reason, "NO_EXACT_MATCH")
        ambiguous = {"contexts": {"context": [reference, {**reference, "referenceId": "ref-2", "label": 2}]},
                     "_referencePixels": {"ref-1": pixels, "ref-2": pixels}}
        self.assertEqual(exact_match(crop, {"contextKey": "context"}, ambiguous).reason, "AMBIGUOUS_REFERENCE")

    def test_row_mapping_uses_complete_saved_box_height(self):
        boxes = [(2, 72), (77, 147), (152, 222), (227, 297), (302, 372), (377, 447)]
        matched = map_row_box({"x": 0, "y": 303, "width": 987, "height": 70}, boxes, 987, .90)
        self.assertEqual(matched, (4, {"x": 0, "y": 302, "width": 987, "height": 70}))
        self.assertIsNone(map_row_box({"x": 0, "y": 800, "width": 987, "height": 70}, boxes, 987, .90))


if __name__ == "__main__":
    unittest.main()
