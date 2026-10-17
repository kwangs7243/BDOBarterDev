from __future__ import annotations

import unittest

import numpy as np
from PIL import Image

from local_app.experiments.trade_template_v1.backup_crop_probe import feature_key, lookup, quantity_mask


class BackupCropTests(unittest.TestCase):
    def test_outline_guard_rejects_a_leading_digit_outside_the_old_crop(self):
        class Cropper:
            @staticmethod
            def _crop(row, bounds):
                return row.crop(tuple(round(v*s) for v,s in zip(bounds,(row.width,row.height,row.width,row.height))))
        pixels = np.zeros((70, 987, 3), dtype=np.uint8)
        # One complete outlined white numeral, wholly inside the regular crop.
        pixels[42:45, 681:690] = 255
        pixels[48:51, 681:690] = 255
        pixels[54:57, 681:690] = 255
        pixels[42:57, 687:690] = 255
        found = quantity_mask(Image.fromarray(pixels), "yield", Cropper)
        self.assertIsNotNone(found)
        self.assertEqual(found[1], 1)
        # A complete leading digit is outside that crop but inside the guard.
        pixels[42:57, 645:648] = 255
        self.assertIsNone(quantity_mask(Image.fromarray(pixels), "yield", Cropper))

    def test_background_padding_can_change_without_changing_whole_token(self):
        token = np.array([[0, 1, 1], [1, 0, 1], [1, 1, 0]], dtype=bool)
        padded = np.pad(token, ((4, 2), (7, 3)))
        self.assertEqual(feature_key(token), feature_key(padded))

    def test_an_extra_leading_digit_cannot_match_the_suffix(self):
        token = np.array([[0, 1, 1], [1, 0, 1], [1, 1, 0]], dtype=bool)
        prefix = np.array([[1], [1], [1]], dtype=bool)
        extended = np.concatenate((prefix, np.zeros((3, 2), dtype=bool), token), axis=1)
        self.assertNotEqual(feature_key(token), feature_key(extended))
        self.assertNotEqual(feature_key(token, True), feature_key(extended, True))

    def test_conflicting_labels_are_never_resolved_by_reference_order(self):
        refs = [{"referenceId": "a", "value": 2}, {"referenceId": "b", "value": 3}]
        bank = {"lookup": {"quantity|native|key": refs}}
        self.assertIsNone(lookup(bank, "quantity", {"native": "key"}, 1))

    def test_group_count_allowed_values_and_zero_count_are_preserved(self):
        ref = {"referenceId": "a", "value": 12}
        bank = {"lookup": {"quantity|native|key": [ref]}}
        self.assertIsNone(lookup(bank, "quantity", {"native": "key"}, 1))
        self.assertIsNone(lookup(bank, "quantity", {"native": "key"}, 2, allowed={2, 3}))
        self.assertEqual(lookup(bank, "quantity", {"native": "key"}, 2)["value"], 12)
        bank = {"lookup": {"count|native|key": [{"referenceId": "z", "value": 0}]}}
        self.assertEqual(lookup(bank, "count", {"native": "key"}, None)["value"], 0)


if __name__ == "__main__":
    unittest.main()
