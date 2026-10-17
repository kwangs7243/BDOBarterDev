from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np

from tools.warehouse_patch.warehouse_patch import QuantityReader, quantity_cell_feature


class WarehouseQuantitySafetyTests(unittest.TestCase):
    def make_reader(self, root, features, labels, feedback=None):
        arrays = {"digit_features": np.asarray(features, dtype=np.float32),
                  "digit_labels": np.asarray(labels, dtype=np.int16)}
        for position in range(4):
            arrays[f"blank_features_{position}"] = np.zeros((1, 96), dtype=np.float32)
        if feedback is not None:
            arrays["feedback_digit_features"] = feedback[0]
            arrays["feedback_digit_labels"] = np.asarray(feedback[1], dtype=np.int16)
            for position in range(4):
                arrays[f"feedback_blank_features_{position}"] = np.empty((0, 96), dtype=np.float32)
        path = Path(root)/"templates.npz"
        np.savez(path, **arrays)
        return QuantityReader(path)

    def test_verified_five_outvotes_previously_accepted_three(self):
        slot = np.zeros((43, 43, 3), dtype=np.float32)
        slot[28:40:2, 31:39] = 1
        feature = quantity_cell_feature(slot, 0)
        misleading = feature.copy()
        misleading[0] = 1-misleading[0]
        distant_five = np.ones(96, dtype=np.float32)
        with tempfile.TemporaryDirectory() as root:
            reader = self.make_reader(root, [misleading, distant_five], [3, 5],
                                      (feature.reshape(1, -1), [5]))
            self.assertEqual(reader._read(slot, reader.digit_features, reader.digit_labels, reader.blank_features)["value"], 3)
            result = reader.read(slot)
        self.assertEqual(result["value"], 5)
        self.assertEqual(result["status"], "QUANTITY_MATCH")

    def test_large_absolute_difference_cannot_pass_on_gap_alone(self):
        slot = np.zeros((43, 43, 3), dtype=np.float32)
        slot[28:40, 31:39] = 1
        distant = np.zeros(96, dtype=np.float32)
        distant[:40] = 1
        with tempfile.TemporaryDirectory() as root:
            reader = self.make_reader(root, [distant, np.zeros(96)], [3, 5])
            result = reader.read(slot)
        self.assertEqual(result["status"], "QUANTITY_UNKNOWN")
        self.assertIsNone(result["value"])
        self.assertEqual(result["reason"], "digit_feature_ambiguous")

    def test_exact_known_digit_and_empty_cells_remain_automatic(self):
        slot = np.zeros((43, 43, 3), dtype=np.float32)
        slot[28:40:2, 31:39] = 1
        feature = quantity_cell_feature(slot, 0)
        with tempfile.TemporaryDirectory() as root:
            reader = self.make_reader(root, [feature, np.ones(96)], [5, 8])
            result = reader.read(slot)
        self.assertEqual((result["status"], result["value"]), ("QUANTITY_MATCH", 5))


if __name__ == "__main__":
    unittest.main()
