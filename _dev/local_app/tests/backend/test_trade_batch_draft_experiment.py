from __future__ import annotations

import inspect
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from local_app.backend.services.trade_recognition import FIELDS
from local_app.tools import trade_batch_draft_experiment as experiment


class StableReader:
    def predict(self, input, batch_size=1):
        return [{"rec_text": "123", "rec_score": 0.875}]


def _capture(path: Path, capture_id: str, batch_id: str) -> dict:
    image = Image.new("RGB", (320, 140), (25, 28, 30))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 24, 319, 25), fill=(190, 190, 190))
    draw.rectangle((0, 94, 319, 95), fill=(190, 190, 190))
    draw.rectangle((15, 43, 24, 55), fill=(230, 220, 175))
    draw.rectangle((87, 43, 104, 55), fill=(230, 220, 175))
    image.save(path)
    return {"captureId": capture_id, "batchId": batch_id, "imagePath": str(path)}


class TradeBatchDraftExperimentTests(unittest.TestCase):
    def setUp(self):
        self.row_parameters = {"separatorPixelDelta": 24, "separatorSupportThreshold": .55,
                               "rowHeightMin": 55, "rowHeightMax": 90}
        self.numeric_parameters = {"minimumHeightRatio": .2, "maximumHeightRatio": .95,
                                   "minimumWidthRatio": .015, "maximumWidthRatio": .55,
                                   "minimumArea": 8, "minimumAspectRatio": .08,
                                   "maximumAspectRatio": 6.0}
        self.lanes = {
            "island": {"x0": .05, "x1": .25, "y0": .12, "y1": .45},
            "fromItem": {"x0": .30, "x1": .60, "y0": .12, "y1": .90},
            "reqAmount": {"x0": .26, "x1": .31, "y0": .40, "y1": .95},
            "toItem": {"x0": .70, "x1": .95, "y0": .12, "y1": .90},
            "count": {"x0": .19, "x1": .28, "y0": .45, "y1": .90},
            "yield": {"x0": .66, "x1": .71, "y0": .35, "y1": .95},
        }

    def test_finite_candidate_sweeps_and_lane_changes(self):
        candidates = experiment._candidate_sets(self.lanes)
        self.assertEqual([len(candidates[field]) for field in ("island", "fromItem", "toItem", "count")],
                         [4, 6, 5, 9])
        self.assertEqual([item["candidateId"] for item in candidates["island"]],
                         ["base", "shrink-right-010", "shrink-right-020", "shrink-right-030"])
        self.assertEqual(candidates["count"][-1]["candidateId"], "shift-left-040-shrink-right-040")
        with Image.new("RGB", (100, 100), "black") as image:
            row = image.crop((0, 0, 100, 100))
            island = candidates["island"][-1]["lane"]
            from_item = candidates["fromItem"][-1]["lane"]
            to_item = candidates["toItem"][-1]["lane"]
            count = candidates["count"][-1]["lane"]
            self.assertLess(island["x1"], self.lanes["island"]["x1"])
            self.assertLess(from_item["y1"], self.lanes["fromItem"]["y1"])
            self.assertLess(to_item["x1"], self.lanes["toItem"]["x1"])
            self.assertLess(count["x0"], self.lanes["count"]["x0"])
            self.assertLess(count["x1"], self.lanes["count"]["x1"])
            self.assertEqual(experiment._lane_crop(row, from_item)[0].height, 33)

    def test_strict_integer_preserves_raw_token_semantics(self):
        self.assertEqual(experiment._strict_integer("10"), (10, "NUMERIC_OCR_CANDIDATE"))
        for raw in ("10회", "10 회", "1O", "10?", "1.0", "-1", ""):
            self.assertIsNone(experiment._strict_integer(raw)[0], raw)
        self.assertIsNone(experiment._strict_integer(None)[0])

    def test_batch_contract_provenance_and_ten_run_determinism(self):
        with tempfile.TemporaryDirectory() as temp:
            first = _capture(Path(temp) / "first.png", "cap-a", "batch-a")
            second = _capture(Path(temp) / "second.png", "cap-b", "batch-b")
            artifact = experiment.run_batch([first, second], self.lanes, self.row_parameters,
                                            self.numeric_parameters, StableReader(), "base-sha", runs=10)
        self.assertTrue(artifact["determinism"]["semanticDeterminism"])
        self.assertEqual(artifact["captureSet"]["captureCount"], 2)
        self.assertEqual(artifact["metrics"]["rows"]["candidateRows"], 6)
        for row in artifact["draftRows"]:
            self.assertEqual(set(row["fields"]), set(FIELDS))
            self.assertEqual(row["automationDecision"], "REVIEW")
            self.assertEqual(len(row["sourceRefs"]), 1)
            self.assertEqual(row["sourceRefs"][0]["captureId"], row["captureId"])
            self.assertEqual(row["sourceRefs"][0]["rowCropHash"], row["rowCropHash"])
            for field in FIELDS:
                self.assertIsNone(row["fields"][field]["value"])
        self.assertEqual(artifact["oracleMapping"]["mappedOracleRows"], 0)
        self.assertIsNone(artifact["oracleMapping"]["fieldAccuracy"])
        self.assertEqual(artifact["approval"]["HIGH"], 0)
        self.assertEqual(artifact["batchContract"]["fieldSemantics"]["count"], "remainingExchangeCount")

    def test_runner_signatures_accept_no_oracle_or_catalog_inputs(self):
        self.assertEqual(list(inspect.signature(experiment.measure_geometry_candidates).parameters),
                         ["captures", "base_lanes", "row_parameters", "numeric_parameters", "reader"])
        self.assertEqual(list(inspect.signature(experiment.run_batch).parameters),
                         ["captures", "selected_lanes", "row_parameters", "numeric_parameters", "reader",
                          "base_commit", "capture_evidence", "runs", "model_hashes"])

    def test_pipeline_has_no_domain_authority_calls_or_importer(self):
        source = Path(experiment.__file__).read_text(encoding="utf-8")
        forbidden = ("getSafeUniqueItemMatch", "catalog_candidate_evidence", "masterData",
                     "Levenshtein", "processParsedTrades")
        for token in forbidden:
            self.assertNotIn(token, source)
        self.assertNotIn("catalog_path", inspect.signature(experiment.main).parameters)

    def test_numeric_candidate_reuses_t010a2_reader(self):
        crop = Image.new("RGB", (30, 20), "black")
        ImageDraw.Draw(crop).rectangle((8, 4, 11, 15), fill="white")
        evidence = experiment.infer_trade_numeric_field_v2(crop, "count", {"top": False, "bottom": False},
                                                           {"componentPlausibility": self.numeric_parameters})
        self.assertEqual(evidence["readerEvidence"]["readerId"], "connected-component-token-structure-v2")
        self.assertIn("rawForegroundBoundaryContact", evidence["readerEvidence"])
        self.assertIn("plausibleTokenBoundaryContact", evidence["readerEvidence"])


if __name__ == "__main__":
    unittest.main()
