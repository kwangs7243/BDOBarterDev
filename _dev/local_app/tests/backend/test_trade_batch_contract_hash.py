from __future__ import annotations
import copy, json, os, subprocess, sys, unittest
from pathlib import Path
from local_app.tools.trade_batch_draft_experiment import build_contract_semantic_projection, contract_semantic_hash

FIELDS = ("island", "fromItem", "reqAmount", "toItem", "count", "yield")
NUMERIC = {"reqAmount", "count", "yield"}

def _artifact():
    fields = {}
    for name in FIELDS:
        numeric = name in NUMERIC
        evidence = {"geometry": {"valid": True, "box": {"x0": 0.1, "x1": 0.2, "y0": 0.3, "y1": 0.4},
                                 "laneErrors": [], "rowClipped": False},
                    "visual": {"foregroundPixels": 5}}
        if numeric:
            evidence.update({"rawNumericParseEvidence": {"strictAsciiInteger": True, "parseStatus": "NUMERIC_OCR_CANDIDATE"},
                             "numericStructure": {"readerId": "numeric-v2", "tokenBox": [1, 2, 3, 4],
                                                  "plausibleTokenBoundaryContact": {"left": False},
                                                  "rawForegroundBoundaryContact": {"right": False},
                                                  "rowBoundaryContact": False, "componentCount": 4}})
        fields[name] = {"rawText": "123" if numeric else "candidate",
                        "normalizedText": "123" if numeric else "candidate",
                        "rawNumericCandidate": 123 if numeric else None, "value": None,
                        "status": "NUMERIC_OCR_CANDIDATE" if numeric else "RAW_OCR_CANDIDATE",
                        "cropHash": f"crop-{name}", "reasonCodes": ["candidate"], "readerEvidence": evidence}
    return {
        "task": "T010P3A", "status": "T010P3A_LOCAL_BATCH_DRAFT_READY_FOR_SOL_REVIEW",
        "baseCommit": "provenance-only",
        "captureSet": {"captureCount": 1, "captureSetSha256": "captures", "rowDetector": "rows-v1",
                       "captures": [{"captureId": "capture-1", "batchId": "batch", "captureOrdinal": 1,
                                     "imageHash": "image-1", "rowCount": 1}]},
        "batchContract": {"fieldOrder": list(FIELDS), "fieldKeys": list(FIELDS),
                          "fieldSemantics": {"count": "remainingExchangeCount"}, "canonicalValue": None,
                          "rowStatus": "DRAFT_UNVERIFIED", "automationDecision": "REVIEW"},
        "rowDetector": {"id": "rows-v1", "parameters": {"threshold": 4}, "oracleUsed": False,
                        "rowCountIsOptimizationTarget": False},
        "fieldGeometry": {"selectedFieldLanes": {n: {"x0": i / 10, "x1": (i + 1) / 10, "y0": 0.1, "y1": 0.9}
                                                    for i, n in enumerate(FIELDS)},
                           "numericReader": "numeric-v2", "frozenLaneSources": {"yield": "frozen"},
                           "numericGeometrySource": "selected", "selectedCandidates": {"count": "candidate-a"},
                           "comparisonMetrics": {"elapsedMs": 10}, "temporaryPath": "local-only"},
        "ocrRuntime": {"framework": "PaddleOCR", "package": "paddleocr==3.7.0", "model": "model-v1",
                       "engine": "onnxruntime", "onnxruntime": "1.30.0", "device": "cpu",
                       "modelHash": {"logicalBundleSha256": "model-hash"}, "remoteOcrRequests": 0,
                       "externalImageUpload": False, "initializationMs": 15.5, "path": "local-only"},
        "draftRows": [{"draftId": "draft-1", "captureId": "capture-1", "batchId": "batch", "ordinal": 1,
                        "rowBox": {"x": 0, "y": 1, "width": 2, "height": 3}, "rowCropHash": "row-crop-1",
                        "sourceRefs": [{"captureId": "capture-1", "rowOrdinal": 1}], "status": "DRAFT_UNVERIFIED",
                        "automationDecision": "REVIEW", "fields": fields}],
        "metrics": {"rows": {"captureCount": 1, "candidateRows": 1, "completeGeometryRows": 1, "clippedRows": 0,
                              "sixFieldDraftRows": 1, "rowsWithAllTextRawCandidates": 1,
                              "rowsWithAllNumericRawCandidates": 1, "rowsWithAllSixRawCandidates": 1, "elapsedMs": 10},
                    "fields": {n: {"rowsTotal": 1, "geometryValid": 1, "ocrAttempted": 1, "ocrNonEmpty": 1,
                                   "ocrEmpty": 0, "ocrError": 0, "boundaryContact": 0,
                                   "numericStrictCandidate": int(n in NUMERIC), "geometryAbstain": 0,
                                   "contaminationSuspected": 0} for n in FIELDS}},
        "determinism": {"runs": 10, "semanticDeterminism": True, "rawScoreDeterminism": True,
                        "semanticFieldsCompared": ["rawText", "status"], "semanticRunHashes": ["legacy-a"] * 10},
        "oracleMapping": {"oracleMappingStatus": "UNRESOLVED", "oracleRowCount": 1, "mappedOracleRows": 0,
                          "fieldAccuracy": None, "rowAccuracy": None, "fullListExact": None},
        "approval": {"approved": False, "production": False, "engineSelectedForProduction": False,
                     "importerIntegration": False, "HIGH": 0, "automationDecision": "REVIEW"},
    }

def _reverse_dicts(value):
    if isinstance(value, dict):
        return {key: _reverse_dicts(value[key]) for key in reversed(list(value))}
    if isinstance(value, list):
        return [_reverse_dicts(item) for item in value]
    return value

class TradeBatchContractHashTests(unittest.TestCase):
    def test_excludes_runtime_visual_and_legacy_run_hash_diagnostics(self):
        before = _artifact()
        after = copy.deepcopy(before)
        after["ocrRuntime"]["initializationMs"] = 9999.0
        after["draftRows"][0]["fields"]["fromItem"]["readerEvidence"]["visual"]["newDiagnostic"] = {"x": 1}
        after["determinism"]["semanticRunHashes"] = ["different"] * 10
        self.assertEqual(contract_semantic_hash(before), contract_semantic_hash(after))

    def test_recognition_changes_change_contract_hash(self):
        mutations = (
            lambda a: a["draftRows"][0]["fields"]["island"].update(rawText="candidateX"),
            lambda a: a["draftRows"][0]["fields"]["island"].update(cropHash="changed"),
            lambda a: a["draftRows"][0]["fields"]["island"].update(status="UNREADABLE"),
            lambda a: a["fieldGeometry"]["selectedFieldLanes"]["count"].update(x0=0.25),
            lambda a: a["draftRows"][0]["fields"]["count"].update(rawNumericCandidate=124))
        expected = contract_semantic_hash(_artifact())
        for mutate in mutations:
            changed = copy.deepcopy(_artifact())
            mutate(changed)
            with self.subTest(mutation=mutate):
                self.assertNotEqual(expected, contract_semantic_hash(changed))

    def test_row_order_is_semantic(self):
        baseline = _artifact()
        second = copy.deepcopy(baseline["draftRows"][0])
        second["draftId"], second["ordinal"] = "draft-2", 2
        baseline["draftRows"].append(second)
        reversed_rows = copy.deepcopy(baseline)
        reversed_rows["draftRows"].reverse()
        self.assertNotEqual(contract_semantic_hash(baseline), contract_semantic_hash(reversed_rows))

    def test_hash_is_stable_for_deepcopy_insertion_order_and_hashseed(self):
        artifact = _artifact()
        expected = contract_semantic_hash(artifact)
        self.assertEqual(expected, contract_semantic_hash(copy.deepcopy(artifact)))
        self.assertEqual(expected, contract_semantic_hash(_reverse_dicts(artifact)))
        code = ("import json,sys; from local_app.tools.trade_batch_draft_experiment import contract_semantic_hash; "
                "print(contract_semantic_hash(json.loads(sys.argv[1])))")
        for seed in ("1", "98765"):
            env = dict(os.environ, PYTHONHASHSEED=seed)
            package_dir = next(path for path in sys.path if (Path(path) / "numpy").is_dir())
            env["PYTHONPATH"] = os.pathsep.join(filter(None, [package_dir, env.get("PYTHONPATH")]))
            result = subprocess.run([sys.executable, "-c", code, json.dumps(artifact, ensure_ascii=False)],
                                    check=True, capture_output=True, text=True, env=env)
            self.assertEqual(expected, result.stdout.strip())

    def test_projection_excludes_provenance_and_visual_namespace(self):
        projection = build_contract_semantic_projection(_artifact())
        self.assertNotIn("baseCommit", projection)
        self.assertNotIn("initializationMs", projection["ocrRuntime"])
        self.assertNotIn("comparisonMetrics", projection["fieldGeometry"])
        field = projection["draftRows"][0]["fields"]["fromItem"]
        self.assertNotIn("visual", field.get("readerEvidence", {}))
        self.assertNotIn("semanticRunHashes", projection["determinism"])

if __name__ == "__main__":
    unittest.main()
