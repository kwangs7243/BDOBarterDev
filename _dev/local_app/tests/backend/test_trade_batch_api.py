from __future__ import annotations

import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from PIL import Image
from werkzeug.datastructures import MultiDict

from local_app.backend.app import create_app
from local_app.backend.services.trade_batch_runtime import TradeBatchRuntime, TradeBatchRuntimeError
from local_app.tools.trade_batch_draft_experiment import FIELDS
from local_app.tests.backend.test_trade_batch_runtime import _fake_result


def _png(width=80, height=50):
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, format="PNG")
    return buffer.getvalue()


class TradeBatchApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.database = self.root / "main.sqlite3"
        self.sidecar = self.root / "recognition.sqlite3"
        self.app = create_app(self.database, recognition_database_path=self.sidecar, testing=True)
        self.app.config["TESTING"] = True
        runtime_dir = self.root / "runtime-temp"
        runtime_dir.mkdir()
        self.runtime_dir = runtime_dir
        self.runtime = TradeBatchRuntime(temp_root=runtime_dir, runner=lambda command, **kwargs: _fake_result(command))
        self.app.extensions["trade_batch_runtime"] = self.runtime
        self.client = self.app.test_client()
        self.headers = {"Origin": "http://localhost:18765", "Sec-Fetch-Site": "same-origin"}

    def tearDown(self):
        self.temp.cleanup()

    def _capture(self, *, width=80, height=50, task="trade", capture_id=None):
        capture_id = capture_id or str(uuid4())
        metadata = {"version": 1, "captureId": capture_id, "batchId": str(uuid4()), "taskType": task,
                    "sourceType": "file", "capturedAt": "2026-09-29T00:00:00Z",
                    "frame": {"width": width, "height": height},
                    "fidelity": {"sourceWidth": width, "sourceHeight": height, "rescaled": False, "evidence": "file-metadata"},
                    "profileId": None, "profileVersion": 1,
                    "context": {"baseRevision": 0, "sessionId": None, "sessionRevision": None},
                    "observed": {"browserDpr": None, "windowsDpi": None, "gameResolution": None, "gameUiScale": None}}
        return {"captureId": capture_id, "metadata": metadata}, _png(width, height)

    def _post(self, items=None, *, batch_id=None, batch_overrides=None, upload_overrides=None, extra_form=()):
        items = items if items is not None else [self._capture()]
        descriptors = [descriptor for descriptor, _png_bytes in items]
        batch = {"version": 1, "batchId": batch_id or str(uuid4()), "captures": descriptors}
        if batch_overrides:
            batch.update(batch_overrides)
        form = [("batch", json.dumps(batch))]
        form.extend(extra_form)
        for index, (descriptor, png_bytes) in enumerate(items):
            options = (upload_overrides or {}).get(index, {})
            form.append(("image", (io.BytesIO(options.get("bytes", png_bytes)), options.get("filename", "ignored.png"),
                                   options.get("content_type", "image/png"))))
        return self.client.post("/api/recognition/trade-batch", data=MultiDict(form), headers=self.headers,
                                base_url="http://localhost:18765")

    def test_runtime_status_is_read_only_and_does_not_expose_paths(self):
        response = self.client.get("/api/recognition/trade-runtime")
        self.assertEqual(response.status_code, 200)
        body = response.get_json()["runtime"]
        self.assertIn("available", body)
        self.assertNotIn(str(self.root), response.get_data(as_text=True))

    def test_valid_single_and_multi_capture_preserve_order_and_contract(self):
        first, second = self._capture(), self._capture()
        main_before, sidecar_before = self.database.read_bytes(), self.sidecar.read_bytes()
        response = self._post([first, second])
        self.assertEqual(response.status_code, 200, response.get_json())
        result = response.get_json()["result"]
        self.assertEqual([capture["captureId"] for capture in result["captures"]],
                         [first[0]["captureId"], second[0]["captureId"]])
        self.assertEqual([row["captureId"] for row in result["draftRows"]],
                         [first[0]["captureId"], second[0]["captureId"]])
        self.assertEqual(result["metrics"]["countMeaning"], "remainingExchangeCount")
        self.assertEqual(result["approval"], {"production": False, "HIGH": 0,
                                               "importerIntegration": False, "automationDecision": "REVIEW"})
        self.assertEqual(self.database.read_bytes(), main_before)
        self.assertEqual(self.sidecar.read_bytes(), sidecar_before)
        self.assertEqual(list(self.runtime_dir.iterdir()), [])
        single = self._post([self._capture()])
        self.assertEqual(single.status_code, 200)

    def test_duplicate_ids_parts_count_task_frame_and_png_are_rejected(self):
        item = self._capture()
        duplicate = self._post([item, item])
        self.assertEqual(duplicate.get_json()["error"]["code"], "duplicate_capture_id")
        missing_image = self._post([item], upload_overrides={0: {"bytes": b""}})
        self.assertEqual(missing_image.get_json()["error"]["code"], "invalid_image")
        wrong_task, _ = self._capture(task="warehouse")
        response = self._post([(wrong_task, _png())])
        self.assertEqual(response.get_json()["error"]["code"], "invalid_task_type")
        mismatch, _ = self._capture(width=81, height=50)
        response = self._post([(mismatch, _png(80, 50))])
        self.assertEqual(response.get_json()["error"]["code"], "frame_mismatch")
        response = self._post([item], upload_overrides={0: {"content_type": "image/jpeg"}})
        self.assertEqual(response.get_json()["error"]["code"], "invalid_image")
        response = self._post([item], extra_form=[("extra", "no")])
        self.assertEqual(response.get_json()["error"]["code"], "invalid_capture_parts")

    def test_invalid_batch_duplicate_and_runtime_request_path_are_rejected(self):
        item = self._capture()
        response = self._post([item], batch_overrides={"pythonPath": "C:/request-controlled.exe"})
        self.assertEqual(response.get_json()["error"]["code"], "invalid_batch")
        response = self._post([item], batch_overrides={"batchId": "bad"})
        self.assertEqual(response.get_json()["error"]["code"], "invalid_batch")
        response = self.client.post("/api/recognition/trade-batch", data={"batch": "{}"}, headers=self.headers,
                                    base_url="http://localhost:18765")
        self.assertEqual(response.get_json()["error"]["code"], "invalid_batch")

    def test_capture_image_count_mismatch_and_wrapper_metadata_id_mismatch(self):
        item = self._capture()
        response = self._post([item], batch_overrides={"captures": []})
        self.assertEqual(response.get_json()["error"]["code"], "invalid_capture_parts")
        mismatched = self._capture()
        response = self._post([mismatched], batch_overrides={"captures": [{
            "captureId": str(uuid4()), "metadata": mismatched[0]["metadata"]}]})
        self.assertEqual(response.get_json()["error"]["code"], "invalid_batch")

    def test_capture_count_and_byte_limits(self):
        items = [self._capture() for _ in range(101)]
        response = self._post(items)
        self.assertEqual(response.get_json()["error"]["code"], "invalid_batch")
        item = self._capture()
        with patch("local_app.backend.api.recognition.MAX_BATCH_BYTES", 32):
            response = self._post([item])
        self.assertEqual(response.get_json()["error"]["code"], "image_too_large")

    def test_unavailable_worker_failure_timeout_and_same_origin(self):
        item = self._capture()
        unavailable = TradeBatchRuntime(python_path=self.root / "missing-python.exe")
        self.app.extensions["trade_batch_runtime"] = unavailable
        response = self._post([item])
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["error"]["code"], "engine_unavailable")
        self.app.extensions["trade_batch_runtime"] = TradeBatchRuntime(
            temp_root=self.runtime_dir, runner=lambda *_args, **_kwargs: SimpleNamespace(returncode=7, stdout="", stderr="secret"))
        response = self._post([item])
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.get_json()["error"]["code"], "recognition_worker_failed")
        self.assertNotIn("secret", response.get_data(as_text=True))
        self.app.extensions["trade_batch_runtime"] = TradeBatchRuntime(
            temp_root=self.runtime_dir, runner=lambda *_args, **_kwargs: (_ for _ in ()).throw(
                subprocess.TimeoutExpired("worker", 1)))
        response = self._post([item])
        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.get_json()["error"]["code"], "recognition_timeout")
        response = self.client.post("/api/recognition/trade-batch", data={}, base_url="http://localhost:18765")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(list(self.runtime_dir.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
