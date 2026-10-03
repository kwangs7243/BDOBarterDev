import json
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from local_app.backend.services.trade_batch_runtime import (
    TradeBatchRuntime, TradeBatchRuntimeError, MODEL_BUNDLE_SHA256, MODEL_CONFIG_SHA256, MODEL_ONNX_SHA256)


class ReadyRuntime(TradeBatchRuntime):
    def _integrity(self):
        return None, {"modelReady": True, "hashes": {"bundle": MODEL_BUNDLE_SHA256}}


def live_result(batch_id, captures):
    return {"version": 3, "batchId": batch_id, "captures": [{"captureId": c["captureId"]} for c in captures],
            "rows": [{"captureId": c["captureId"], "ordinal": 0,
                      "rowBox": {"x": 0, "y": 0, "width": 80, "height": 50},
                      "fields": {key: {"rawOCR": "2" if key in {"count", "yield", "reqAmount"} else "품목",
                                      "corrected": 2 if key in {"count", "yield", "reqAmount"} else "품목",
                                      "confidence": .9, "reviewRequired": key == "island",
                                      "box": {"x": 0, "y": 0, "width": 20, "height": 20}}
                                 for key in ("island", "fromItem", "toItem", "count", "reqAmount", "yield")}}
                     for c in captures]}


def fake_worker(command, **kwargs):
    manifest = json.loads(Path(command[command.index("--request") + 1]).read_text(encoding="utf-8"))
    Path(command[command.index("--out") + 1]).write_text(json.dumps(live_result(manifest["batchId"], manifest["captures"])), encoding="utf-8")
    return SimpleNamespace(returncode=0)


class LiveRuntimeTests(unittest.TestCase):
    capture = {"captureId": "10000000-0000-4000-8000-000000000001", "metadata": {"batchId": None}, "imageBytes": b"png"}

    def test_live_worker_manifest_and_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            def inspect(command, **kwargs):
                self.assertNotIn("--live-list", command)
                self.assertFalse(kwargs["shell"])
                self.assertEqual(kwargs["env"]["HF_HUB_OFFLINE"], "1")
                manifest = json.loads(Path(command[command.index("--request")+1]).read_text())
                self.assertEqual(manifest["version"], 1)
                self.assertEqual(manifest["captures"][0]["imagePath"], "capture-0001.png")
                return fake_worker(command, **kwargs)
            result = ReadyRuntime(temp_root=folder, runner=inspect).recognize_live("batch", [self.capture])
            self.assertEqual(result["runtime"]["rowCount"], 1)
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_timeout_failure_invalid_output_release_lock_and_cleanup(self):
        for kind in ("timeout", "exit", "json", "contract"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as folder:
                def broken(command, **kwargs):
                    if kind == "timeout": raise subprocess.TimeoutExpired("worker", 1)
                    if kind == "exit": return SimpleNamespace(returncode=1)
                    Path(command[command.index("--out")+1]).write_text("{" if kind == "json" else '{"version":3}')
                    return SimpleNamespace(returncode=0)
                runtime = ReadyRuntime(temp_root=folder, runner=broken)
                with self.assertRaises(TradeBatchRuntimeError) as caught:
                    runtime.recognize_live("batch", [self.capture])
                self.assertEqual(caught.exception.code, "recognition_timeout" if kind == "timeout" else "recognition_worker_failed")
                self.assertEqual(list(Path(folder).iterdir()), [])
                runtime.runner = fake_worker
                self.assertEqual(len(runtime.recognize_live("batch", [self.capture])["rows"]), 1)

    def test_second_worker_rejected_while_first_is_running(self):
        entered, release = threading.Event(), threading.Event()
        def blocking(command, **kwargs):
            entered.set(); release.wait(5)
            return fake_worker(command, **kwargs)
        with tempfile.TemporaryDirectory() as folder:
            runtime = ReadyRuntime(temp_root=folder, runner=blocking)
            completed = []
            thread = threading.Thread(target=lambda: completed.append(runtime.recognize_live("batch", [self.capture])))
            thread.start()
            try:
                self.assertTrue(entered.wait(2))
                with self.assertRaises(TradeBatchRuntimeError) as caught:
                    runtime.recognize_live("batch", [self.capture])
                self.assertEqual(caught.exception.code, "engine_busy")
            finally:
                release.set(); thread.join(5)
            self.assertEqual(len(completed), 1)

    def test_integrity_requires_only_worker_and_exact_model(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ("python.exe", "worker.py", "inference.onnx", "inference.yml"):
                (root/name).write_text("fixture")
            runtime = TradeBatchRuntime(python_path=root/"python.exe", worker_path=root/"worker.py", model_dir=root)
            with patch("local_app.backend.services.trade_batch_runtime._sha256", side_effect=[MODEL_ONNX_SHA256, MODEL_CONFIG_SHA256]):
                self.assertTrue(runtime.status()["available"])
            self.assertEqual(runtime.status()["reason"], "engine_integrity_error")
            (root/"inference.yml").unlink()
            self.assertEqual(runtime.status()["reason"], "model_missing")

    def test_frozen_worker_uses_current_executable(self):
        with patch("local_app.backend.services.trade_batch_runtime.sys.frozen", True, create=True), patch.dict("os.environ", {}, clear=True):
            runtime = ReadyRuntime(runner=fake_worker)
            self.assertTrue(runtime.packaged_worker)
            self.assertEqual(runtime.recognize_live("batch", [self.capture])["runtime"]["rowCount"], 1)
