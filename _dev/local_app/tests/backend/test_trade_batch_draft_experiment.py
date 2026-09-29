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
        stable_run_hashes = artifact["determinism"]["contractSemanticRunHashes"]
        self.assertEqual(len(stable_run_hashes), 10)
        self.assertEqual(len(set(stable_run_hashes)), 1)
        self.assertEqual(artifact["contractSemanticHash"], experiment.contract_semantic_hash(artifact))
        legacy_keys = ("task", "baseCommit", "batchId", "captureSet", "batchContract", "rowDetector",
                       "fieldGeometry", "ocrRuntime", "boundaryPolicy", "edgeSegments", "draftRows", "metrics", "determinism",
                       "oracleMapping", "approval")
        legacy_payload = {key: artifact[key] for key in legacy_keys}
        legacy_payload["determinism"] = {key: value for key, value in artifact["determinism"].items()
                                         if key != "contractSemanticRunHashes"}
        self.assertEqual(artifact["semanticHash"], experiment.canonical_hash(legacy_payload))
        self.assertEqual(artifact["captureSet"]["captureCount"], 2)
        self.assertEqual(artifact["metrics"]["rows"]["detectedCandidateCount"], 6)
        self.assertEqual(artifact["metrics"]["rows"]["completeRowCount"], 2)
        self.assertEqual(artifact["metrics"]["rows"]["edgeSegmentCount"], 4)
        self.assertEqual(artifact["metrics"]["rows"]["draftRowCount"], 2)
        self.assertEqual(artifact["boundaryPolicy"], experiment.BOUNDARY_POLICY)
        self.assertEqual(len(artifact["edgeSegments"]), 4)
        self.assertTrue(all("fields" not in edge for edge in artifact["edgeSegments"]))
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

    def test_partition_scenarios_and_unexpected_clipped_diagnostic(self):
        def row(clipped=False, top=False, bottom=False):
            return {"clipped": clipped, "boundaryContact": {"top": top, "bottom": bottom}}
        scenarios = {
            "A": ([row()], (1, 0)),
            "B": ([row(True, top=True), row(), row()], (2, 1)),
            "C": ([row(), row(True, bottom=True)], (1, 1)),
            "D": ([row(True, top=True), row(), row(), row(), row(True, bottom=True)], (3, 2)),
            "E": ([row()], (1, 0)),
            "F": ([], (0, 0)),
        }
        for name, (detected, expected) in scenarios.items():
            with self.subTest(scenario=name):
                complete, edges = experiment.partition_detected_rows(detected)
                self.assertEqual((len(complete), len(edges)), expected)
        with self.assertRaisesRegex(ValueError, "UNEXPECTED_CLIPPED_ROW"):
            experiment.partition_detected_rows([row(True)])

    def test_edge_rows_never_reach_six_field_ocr(self):
        class CountingReader:
            calls = 0
            def predict(self, input, batch_size=1):
                self.calls += 1
                return [{"rec_text": "123", "rec_score": .9}]
        raw_rows = ([{"top": 0, "bottom": 12, "height": 12, "clipped": True,
                      "boundaryContact": {"top": True, "bottom": False}, "reasonCodes": ["ROW_CLIPPED_TOP"]}]
                    + [{"top": top, "bottom": top + 70, "height": 70, "clipped": False,
                        "boundaryContact": {"top": False, "bottom": False},
                        "separatorEvidence": {"topSupport": .9, "bottomSupport": .9}, "rawMetric": .9}
                       for top in (20, 100, 180)]
                    + [{"top": 260, "bottom": 320, "height": 60, "clipped": True,
                        "boundaryContact": {"top": False, "bottom": True}, "reasonCodes": ["ROW_CLIPPED_BOTTOM"]}])
        reader = CountingReader()
        with tempfile.TemporaryDirectory() as folder:
            image_path = Path(folder) / "capture.png"
            Image.new("RGB", (320, 320), (25, 28, 30)).save(image_path)
            capture = {"captureId": "cap", "batchId": "batch", "imagePath": str(image_path)}
            selection = experiment._json(Path(experiment.__file__).resolve().parents[1]
                                         / "recognition_data" / "trade-t010p3a-experiment.json")
            lanes = {name: record["lane"] for name, record in selection["selectedFieldLanes"].items()}
            from unittest.mock import patch
            with patch.object(experiment, "detect_rows", return_value=raw_rows):
                result = experiment.build_batch_drafts_once([capture], lanes, self.row_parameters,
                                                              self.numeric_parameters, reader)
        self.assertEqual((len(result["draftRows"]), len(result["edgeSegments"])), (3, 2))
        self.assertEqual(reader.calls, 18)
        self.assertEqual([edge["boundarySide"] for edge in result["edgeSegments"]], ["top", "bottom"])
        self.assertTrue(all(edge["classification"] == "EDGE_SEGMENT_UNCERTAIN"
                            and "fields" not in edge and "value" not in edge for edge in result["edgeSegments"]))
        self.assertEqual(result["captureEvidence"][0]["detectedCandidateCount"], 5)
        self.assertEqual(result["captureEvidence"][0]["completeRowCount"], 3)
        self.assertEqual(result["captureEvidence"][0]["edgeSegmentCount"], 2)


if __name__ == "__main__":
    unittest.main()
