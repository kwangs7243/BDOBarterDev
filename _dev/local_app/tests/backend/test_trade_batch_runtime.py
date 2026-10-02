from __future__ import annotations

import json
import copy
import hashlib
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

from local_app.backend.services.trade_batch_runtime import (
    ENGINE_ID, MODEL_BUNDLE_SHA256, TradeBatchRuntime, TradeBatchRuntimeError,
)
from local_app.tools.trade_batch_draft_experiment import build_batch_drafts_once
from local_app.tools.trade_batch_worker import _load_inputs


FIELDS = ("island", "fromItem", "reqAmount", "toItem", "count", "yield")


def _fake_result(command):
    request_path = Path(command[command.index("--request") + 1])
    output_path = Path(command[command.index("--out") + 1])
    manifest = json.loads(request_path.read_text(encoding="utf-8"))
    rows = []
    for ordinal, capture in enumerate(manifest["captures"], 1):
        rows.append({"draftId": f"{capture['captureId']}:draft-row-01", "captureId": capture["captureId"],
                     "batchId": capture.get("batchId"), "ordinal": ordinal, "sourceRefs": [], "rowBox": {},
                     "fields": {field: {"rawText": None, "rawNumericCandidate": None, "value": None,
                                        "status": "OCR_ERROR", "readerEvidence": {"geometry": "fixed"},
                                        "reasonCodes": ["OCR_ERROR"], "cropHash": None}
                                for field in FIELDS},
                     "status": "DRAFT_UNVERIFIED", "automationDecision": "REVIEW"})
    count = len(rows)
    output_path.write_text(json.dumps({"version": 1, "batchId": manifest["batchId"],
                                       "captureIds": [item["captureId"] for item in manifest["captures"]],
                                       "captures": [{"captureId": item["captureId"], "imageHash": "a" * 64,
                                                     "imageDimensions": {"width": 80, "height": 50},
                                                     "detectedCandidateCount": 1, "completeRowCount": 1,
                                                     "edgeSegmentCount": 0}
                                                    for item in manifest["captures"]],
                                       "draftRows": rows, "edgeSegments": [],
                                       "metrics": {"boundaryPolicy": "edge-segments-evidence-only-v1",
                                                   "detectedCandidateCount": count, "completeRowCount": count,
                                                   "edgeSegmentCount": 0, "draftRowCount": count,
                                                   "countMeaning": "remainingExchangeCount"}}),
                           encoding="utf-8")
    return SimpleNamespace(returncode=0, stdout="", stderr="")


def _raw_v2_snapshot(batch_id, captures):
    raw_captures = []
    rows = []
    for index, capture in enumerate(captures, 1):
        metadata = capture["metadata"]
        source_type = {"file": "FILE", "clipboard": "CLIPBOARD", "browser-stream": "STREAM"}[metadata["sourceType"]]
        raw_captures.append({"captureId": capture["captureId"], "captureOrdinal": index,
            "imageSha256": hashlib.sha256(capture["imageBytes"]).hexdigest(), "bitmapSha256": "b" * 64, "sourceType": source_type,
            "frame": metadata["frame"], "sourceFidelity": metadata["fidelity"],
            "reencoded": capture["reencoded"], "completeRowCount": 1})
        fields = []
        for name in FIELDS:
            fields.append({"field": name, "rawText": None, "rawNumeric": None,
                           "readerStatus": "OCR_ERROR", "confidence": None, "cropRefs": []})
        rows.append({"sourceRowId": f"source-{capture['captureId']}", "captureId": capture["captureId"],
                     "ordinal": 0, "rowBox": {"x": 0, "y": 0, "width": 80, "height": 20}, "fields": fields})
    return {"schemaVersion": 2, "recognitionBatchId": batch_id, "captures": raw_captures,
            "sourceRows": rows, "edgeSegments": []}


def _fake_raw_v2_result(command):
    request_path = Path(command[command.index("--request") + 1])
    output_path = Path(command[command.index("--out") + 1])
    manifest = json.loads(request_path.read_text(encoding="utf-8"))
    output_path.write_text(json.dumps(_raw_v2_snapshot(manifest["batchId"], [
        {"captureId": item["captureId"], "metadata": {"sourceType": {"FILE":"file", "CLIPBOARD":"clipboard",
          "STREAM":"browser-stream"}[item["sourceType"]], "fidelity": item["sourceFidelity"],
          "frame": {"width":80,"height":50}}, "reencoded": item["reencoded"],
          "imageBytes": (request_path.parent / item["imagePath"]).read_bytes()}
        for item in manifest["captures"]])), encoding="utf-8")
    return SimpleNamespace(returncode=0, stdout="", stderr="")


class ReadyRuntime(TradeBatchRuntime):
    def _integrity(self):
        return None, {"available": True, "modelReady": True,
                      "hashes": {"bundle": MODEL_BUNDLE_SHA256}}


class TradeBatchRuntimeTests(unittest.TestCase):
    def test_import_does_not_load_paddleocr(self):
        self.assertNotIn("paddleocr", sys.modules)
        self.assertNotIn("onnxruntime", sys.modules)

    def test_runtime_result_and_temp_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            seen = {}
            def runner(command, **kwargs):
                seen["command"] = command
                return _fake_result(command)
            runtime = ReadyRuntime(temp_root=root, runner=runner)
            capture_id = "10000000-0000-4000-8000-000000000001"
            batch_id = "20000000-0000-4000-8000-000000000001"
            payload = runtime.recognize(batch_id, [{"captureId": capture_id,
                "metadata": {"batchId": "30000000-0000-4000-8000-000000000001"}, "imageBytes": b"png"}])
            self.assertEqual(payload["captureIds"], [capture_id])
            self.assertEqual(payload["runtime"]["engineId"], ENGINE_ID)
            self.assertEqual(payload["runtime"]["modelBundleSha256"], MODEL_BUNDLE_SHA256)
            self.assertNotIn("--raw-evidence-version", seen["command"])
            self.assertEqual(list(root.iterdir()), [])

    def test_raw_v2_source_type_mapping_for_file_clipboard_and_stream(self):
        sources = (
            ("file", {"sourceWidth":80,"sourceHeight":50,"rescaled":False,"evidence":"file-metadata"}, "FILE"),
            ("clipboard", {"sourceWidth":None,"sourceHeight":None,"rescaled":None,"evidence":"unknown"}, "CLIPBOARD"),
            ("browser-stream", {"sourceWidth":None,"sourceHeight":None,"rescaled":None,"evidence":"unknown"}, "STREAM"),
        )
        with tempfile.TemporaryDirectory() as folder:
            runtime = ReadyRuntime(temp_root=folder, runner=lambda command, **kwargs: _fake_raw_v2_result(command))
            for index, (source_type, fidelity, expected_type) in enumerate(sources, 1):
                with self.subTest(source_type=source_type):
                    capture_id = f"10000000-0000-4000-8000-{index:012d}"
                    result = runtime.recognize_raw_v2("20000000-0000-4000-8000-000000000001", [{
                        "captureId": capture_id, "metadata": {"batchId": None, "sourceType": source_type,
                            "frame": {"width":80,"height":50}, "fidelity": fidelity},
                        "imageBytes": b"png", "reencoded": index == 2,
                    }])
                    self.assertEqual(result["rawEvidence"]["captures"][0]["sourceType"], expected_type)
                    self.assertEqual(result["rawEvidence"]["captures"][0]["sourceFidelity"], fidelity)
                    self.assertEqual(result["rawEvidence"]["captures"][0]["reencoded"], index == 2)

    def test_raw_v2_runtime_manifest_wrapper_and_exact_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            seen = {}
            def runner(command, **kwargs):
                seen["command"] = command
                request_path = Path(command[command.index("--request") + 1])
                seen["manifest"] = json.loads(request_path.read_text(encoding="utf-8"))
                return _fake_raw_v2_result(command)
            runtime = ReadyRuntime(temp_root=root, runner=runner)
            capture_id = "10000000-0000-4000-8000-000000000001"
            batch_id = "20000000-0000-4000-8000-000000000001"
            fidelity = {"sourceWidth": None, "sourceHeight": None, "rescaled": None, "evidence": "unknown"}
            request = [{"captureId": capture_id, "metadata": {"batchId": None, "sourceType": "browser-stream",
                        "frame": {"width":80,"height":50}, "fidelity": fidelity}, "imageBytes": b"png", "reencoded": False}]
            result = runtime.recognize_raw_v2(batch_id, request)
            self.assertEqual(seen["manifest"]["version"], 1)
            self.assertEqual(seen["manifest"]["captures"][0], {
                "captureId": capture_id, "batchId": None, "imagePath": "capture-0001.png",
                "sourceType": "STREAM", "sourceFidelity": fidelity, "reencoded": False})
            self.assertEqual(seen["command"][-2:], ["--raw-evidence-version", "2"])
            self.assertEqual(set(result), {"rawEvidence", "runtime"})
            self.assertEqual(result["rawEvidence"]["recognitionBatchId"], batch_id)
            self.assertNotIn("runtime", result["rawEvidence"])
            self.assertEqual(result["runtime"]["captureCount"], 1)
            self.assertEqual(list(root.iterdir()), [])

    def test_raw_v2_rejects_unknown_source_and_invalid_worker_snapshots(self):
        with tempfile.TemporaryDirectory() as folder:
            runtime = ReadyRuntime(temp_root=folder, runner=lambda command, **kwargs: _fake_raw_v2_result(command))
            base = {"captureId": "10000000-0000-4000-8000-000000000001",
                    "metadata": {"batchId": None, "sourceType": "file", "frame": {"width":80,"height":50}, "fidelity": {
                        "sourceWidth": 80, "sourceHeight": 50, "rescaled": False, "evidence": "file-metadata"}},
                    "imageBytes": b"png", "reencoded": True}
            with self.assertRaises(TradeBatchRuntimeError) as unknown:
                runtime.recognize_raw_v2("20000000-0000-4000-8000-000000000001", [{**base, "metadata": {
                    **base["metadata"], "sourceType": "future-source"}}])
            self.assertEqual(unknown.exception.code, "invalid_batch")
            valid = _raw_v2_snapshot("20000000-0000-4000-8000-000000000001", [base])
            invalid_cases = []
            for name, mutate in [
                ("schema", lambda p: p.update(schemaVersion=1)),
                ("batch", lambda p: p.update(recognitionBatchId="wrong")),
                ("capture_order", lambda p: p["captures"][0].update(captureOrdinal=2)),
                ("unknown_capture", lambda p: p["sourceRows"][0].update(captureId="missing")),
                ("duplicate_source", lambda p: p["sourceRows"].append(copy.deepcopy(p["sourceRows"][0]))),
                ("field_order", lambda p: p["sourceRows"][0]["fields"].reverse()),
                ("bad_crop_owner", lambda p: (p["sourceRows"][0]["fields"][0].update(cropRefs=[{
                    "cropRefId":"crop", "sourceRowId":"wrong", "captureId":base["captureId"], "field":"island",
                    "bitmapSha256":"b"*64,"frame":{"width":80,"height":50},"coordinateSpace":"CAPTURE_BITMAP_PIXELS",
                    "box":{"x":0,"y":0,"width":5,"height":5},"pixelHashBasis":"RGB8_ROW_MAJOR_V1",
                    "pixelSha256":"c"*64,"pngArtifactSha256":None}]))),
                ("bad_hash", lambda p: p["captures"][0].update(imageSha256="A"*64)),
                ("unknown_edge_capture", lambda p: p.update(edgeSegments=[{
                    "edgeId":"edge", "captureId":"missing", "ordinal":2, "reason":"EDGE",
                    "rowBox":{"x":0,"y":0,"width":5,"height":5},
                    "sourceRefs":[{"sourceRowId":"edge","captureId":"missing","ordinal":2}]}])),
            ]:
                broken = copy.deepcopy(valid)
                mutate(broken)
                invalid_cases.append((name, broken))
            for name, broken in invalid_cases:
                with self.subTest(name=name):
                    def runner(command, **kwargs):
                        Path(command[command.index("--out") + 1]).write_text(json.dumps(broken), encoding="utf-8")
                        return SimpleNamespace(returncode=0, stdout="", stderr="")
                    runtime.runner = runner
                    with self.assertRaises(TradeBatchRuntimeError) as caught:
                        runtime.recognize_raw_v2("20000000-0000-4000-8000-000000000001", [base])
                    self.assertEqual(caught.exception.code, "recognition_worker_failed")

    def test_worker_failure_timeout_and_invalid_result_clean_temporary_files(self):
        errors = [
            (lambda *_args, **_kwargs: SimpleNamespace(returncode=5, stdout="", stderr="secret path"), "recognition_worker_failed"),
            (lambda *_args, **_kwargs: (_ for _ in ()).throw(subprocess.TimeoutExpired("worker", 1)), "recognition_timeout"),
        ]
        for runner, expected in errors:
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as folder:
                runtime = ReadyRuntime(temp_root=folder, runner=runner)
                with self.assertRaises(TradeBatchRuntimeError) as caught:
                    runtime.recognize("20000000-0000-4000-8000-000000000001", [{
                        "captureId": "10000000-0000-4000-8000-000000000001",
                        "metadata": {"batchId": None}, "imageBytes": b"png"}])
                self.assertEqual(caught.exception.code, expected)
                self.assertEqual(list(Path(folder).iterdir()), [])

    def test_busy_rejects_second_worker_without_waiting(self):
        entered, release = threading.Event(), threading.Event()
        def blocking_runner(command, **kwargs):
            entered.set()
            release.wait(5)
            return _fake_result(command)
        with tempfile.TemporaryDirectory() as folder:
            runtime = ReadyRuntime(temp_root=folder, runner=blocking_runner)
            capture = {"captureId": "10000000-0000-4000-8000-000000000001",
                       "metadata": {"batchId": None}, "imageBytes": b"png"}
            first_error = []
            thread = threading.Thread(target=lambda: runtime.recognize(
                "20000000-0000-4000-8000-000000000001", [capture]), daemon=True)
            thread.start()
            self.assertTrue(entered.wait(2))
            with self.assertRaises(TradeBatchRuntimeError) as caught:
                runtime.recognize("20000000-0000-4000-8000-000000000002", [capture])
            self.assertEqual(caught.exception.code, "engine_busy")
            release.set()
            thread.join(5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_one_pass_core_preserves_six_field_review_draft_and_fixed_lanes(self):
        selection_path = Path(__file__).resolve().parents[2] / "recognition_data" / "trade-t010p3a-experiment.json"
        selection = json.loads(selection_path.read_text(encoding="utf-8"))
        lanes = {field: record["lane"] for field, record in selection["selectedFieldLanes"].items()}
        crop = Image.new("RGB", (240, 70), "white")
        detected = [{"capture": {"captureId": "10000000-0000-4000-8000-000000000001",
                                   "batchId": "30000000-0000-4000-8000-000000000001"},
                     "captureOrdinal": 1, "rowOrdinal": 1, "rowBox": {"x": 0, "y": 5, "width": 240, "height": 70},
                     "rowCrop": crop, "rowCropHash": "a" * 64, "clipped": False}]
        seen = []
        def field_record(field, field_crop, geometry, numeric_parameters, reader):
            seen.append((field, geometry["box"]))
            return {"rawText": None, "normalizedText": None, "ocrScore": None, "rawNumericCandidate": None,
                    "value": None, "status": "OCR_ERROR", "cropHash": None,
                    "readerEvidence": {"geometryEligible": False}, "reasonCodes": ["OCR_ERROR"]}
        with patch("local_app.tools.trade_batch_draft_experiment._row_records",
                   return_value=(detected, [], [{"captureId": detected[0]["capture"]["captureId"],
                                                 "detectedCandidateCount": 1, "completeRowCount": 1,
                                                 "edgeSegmentCount": 0}])), \
             patch("local_app.tools.trade_batch_draft_experiment._field_record", side_effect=field_record):
            result = build_batch_drafts_once([{"captureId": detected[0]["capture"]["captureId"]}], lanes,
                                             {"row": "fixed"}, object(), object())
        self.assertEqual(len(result["draftRows"]), 1)
        row = result["draftRows"][0]
        self.assertEqual(set(row["fields"]), set(FIELDS))
        self.assertTrue(all(field["value"] is None for field in row["fields"].values()))
        self.assertEqual(row["status"], "DRAFT_UNVERIFIED")
        self.assertEqual(row["automationDecision"], "REVIEW")
        self.assertEqual({field for field, _box in seen}, set(FIELDS))
        self.assertEqual(row["sourceRefs"][0]["captureId"], detected[0]["capture"]["captureId"])

    def test_worker_accepts_only_fixed_temp_names_and_pinned_selection(self):
        root = Path(__file__).resolve().parents[3]
        model = root / "recognition-local" / "models" / "t010b1" / "official_models" / "korean_PP-OCRv5_mobile_rec_onnx"
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder)
            (work / "capture-0001.png").write_bytes(b"test image placeholder")
            manifest = {"version": 1, "batchId": "20000000-0000-4000-8000-000000000001", "captures": [{
                "captureId": "10000000-0000-4000-8000-000000000001", "batchId": None,
                "imagePath": "capture-0001.png"}]}
            path = work / "request.json"
            path.write_text(json.dumps(manifest), encoding="utf-8")
            batch_id, captures, lanes, _rows, _numeric = _load_inputs(path, model)
            self.assertEqual(batch_id, manifest["batchId"])
            self.assertEqual(captures[0]["imagePath"], str((work / "capture-0001.png").resolve()))
            self.assertEqual(set(lanes), set(FIELDS))
            self.assertEqual(lanes["island"]["x1"], 0.23500000000000001)
            self.assertEqual(lanes["reqAmount"]["x0"], 0.285)
            manifest["captures"][0]["imagePath"] = "../outside.png"
            path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaises(ValueError):
                _load_inputs(path, model)


if __name__ == "__main__":
    unittest.main()
