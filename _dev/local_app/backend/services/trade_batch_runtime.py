"""Bounded subprocess bridge for the local live trade list."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[3]
WORKER_VERSION = "trade-live-worker-v3"
ENGINE_ID = "paddle-korean-ppocrv5-mobile-onnx-cpu-v1"
MODEL_ONNX_SHA256 = "92f0b7785e64fc9090106a241cf4c1eb97472824558272751b88a2a4476d3a08"
MODEL_CONFIG_SHA256 = "f757fa1c40e99edcf27e9cce879b93eb2a51fa46f5ef39095689b8c37dd75998"
MODEL_BUNDLE_SHA256 = "f56168a615fa6439b18f42e55cf48dad52883dd0411590a7a4d73603e5955f90"
MAX_BATCH_BYTES = 20 * 1024 * 1024
MAX_CAPTURES = 100
WORKER_TIMEOUT_SECONDS = 120
LIVE_FIELDS = ('island', 'fromItem', 'reqAmount', 'toItem', 'count', 'yield')

class TradeBatchRuntimeError(RuntimeError):
    def __init__(self, code: str, message: str, status: int, *, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.status = status
        self.retryable = retryable


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _bundle_hash(onnx_hash: str, config_hash: str) -> str:
    payload = json.dumps([
        {"path": "inference.onnx", "sha256": onnx_hash},
        {"path": "inference.yml", "sha256": config_hash},
    ], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


class TradeBatchRuntime:
    """One local worker, verified bundled model, and bounded live-list output."""

    def __init__(self, *, python_path: str | Path | None = None, model_dir: str | Path | None = None,
                 worker_path: str | Path | None = None,
                 temp_root: str | Path | None = None, timeout: int = WORKER_TIMEOUT_SECONDS,
                 runner: Callable[..., Any] | None = None):
        self.packaged_worker = bool(getattr(sys, "frozen", False) and python_path is None and not os.environ.get("BDO_TRADE_OCR_PYTHON"))
        self.python_path = Path(python_path or os.environ.get(
            "BDO_TRADE_OCR_PYTHON", sys.executable if self.packaged_worker else ROOT / "recognition-local" / "envs" / "t010b1-ocr" / "Scripts" / "python.exe"))
        self.model_dir = Path(model_dir or os.environ.get(
            "BDO_TRADE_OCR_MODEL_DIR", ROOT / "local_app" / "recognition_data" / "trade-model" if self.packaged_worker else
            ROOT / "recognition-local" / "models" / "t010b1" / "official_models" / "korean_PP-OCRv5_mobile_rec_onnx"))
        self.worker_path = Path(worker_path or ROOT / "local_app" / "tools" / "trade_batch_worker.py")
        self.temp_root = Path(temp_root) if temp_root else None
        self.timeout = timeout
        self.runner = runner or subprocess.run
        self._worker_lock = threading.BoundedSemaphore(1)



    def _integrity(self) -> tuple[str | None, dict[str, Any]]:
        if not self.python_path.is_file():
            return "python_missing", {"available": False, "modelReady": False}
        if not self.worker_path.is_file():
            return "engine_integrity_error", {"available": False, "modelReady": False}
        onnx = self.model_dir / "inference.onnx"
        config = self.model_dir / "inference.yml"
        if not onnx.is_file() or not config.is_file():
            return "model_missing", {"available": False, "modelReady": False}
        try:
            onnx_hash, config_hash = _sha256(onnx), _sha256(config)
        except OSError:
            return "model_missing", {"available": False, "modelReady": False}
        bundle_hash = _bundle_hash(onnx_hash, config_hash)
        hashes = {"onnx": onnx_hash, "config": config_hash, "bundle": bundle_hash}
        if (onnx_hash, config_hash, bundle_hash) != (MODEL_ONNX_SHA256, MODEL_CONFIG_SHA256, MODEL_BUNDLE_SHA256):
            return "engine_integrity_error", {"available": False, "modelReady": False, "hashes": hashes}
        return None, {"available": True, "modelReady": True, "hashes": hashes}


    def status(self) -> dict[str, Any]:
        reason, info = self._integrity()
        return {"available": reason is None, "engineId": ENGINE_ID, "modelReady": info["modelReady"],
                "reason": reason, "mode": "PACKAGED_LOCAL_RUNTIME" if self.packaged_worker else "LOCAL_DEVELOPMENT_RUNTIME_ONLY",
                "modelBundleSha256": info.get("hashes", {}).get("bundle", MODEL_BUNDLE_SHA256)}


    def recognize_live(self, batch_id: str, captures: list[dict[str, Any]]) -> dict[str, Any]:
        reason, info = self._integrity()
        if reason == "engine_integrity_error":
            raise TradeBatchRuntimeError(reason, "The local recognition engine failed integrity verification.", 503)
        if reason:
            raise TradeBatchRuntimeError("engine_unavailable", "The local recognition engine is unavailable.", 503)
        if not self._worker_lock.acquire(blocking=False):
            raise TradeBatchRuntimeError("engine_busy", "The local recognition engine is busy.", 409, retryable=True)
        started = time.monotonic()
        try:
            with tempfile.TemporaryDirectory(prefix="bdo-trade-batch-", dir=self.temp_root) as temporary:
                work_dir = Path(temporary)
                manifest_captures = []
                for ordinal, capture in enumerate(captures, 1):
                    name = f"capture-{ordinal:04d}.png"
                    (work_dir / name).write_bytes(capture["imageBytes"])
                    manifest_captures.append({"captureId": capture["captureId"], "batchId": capture["metadata"]["batchId"],
                                              "imagePath": name})
                manifest_path, output_path = work_dir / "request.json", work_dir / "result.json"
                manifest_path.write_text(json.dumps({"version": 1, "batchId": batch_id, "captures": manifest_captures},
                                                    ensure_ascii=False), encoding="utf-8")
                prefix = [str(self.python_path), "--trade-ocr-worker"] if self.packaged_worker else [str(self.python_path), "-B", str(self.worker_path)]
                command = [*prefix, "--request", str(manifest_path),
                           "--out", str(output_path), "--model-dir", str(self.model_dir)]
                environment = {key: os.environ[key] for key in (
                    "PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
                    "PROGRAMDATA",
                ) if key in os.environ}
                environment.update({"PYTHONDONTWRITEBYTECODE": "1", "HF_HUB_OFFLINE": "1",
                                    "PYINSTALLER_RESET_ENVIRONMENT": "1",
                                    "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8",
                                    "PADDLE_PDX_MODEL_SOURCE": "LOCAL", "PADDLE_PDX_CACHE_HOME": str(work_dir / "paddle-cache")})
                try:
                    result = self.runner(command, cwd=str(ROOT), shell=False, timeout=self.timeout,
                                         capture_output=True, text=True, env=environment,
                                         creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
                except subprocess.TimeoutExpired:
                    raise TradeBatchRuntimeError("recognition_timeout", "Local recognition timed out.", 504, retryable=True) from None
                if getattr(result, "returncode", 1) != 0 or not output_path.is_file():
                    raise TradeBatchRuntimeError("recognition_worker_failed", "Local recognition could not complete.", 502, retryable=True)
                try:
                    if output_path.stat().st_size > MAX_BATCH_BYTES:
                        raise TradeBatchRuntimeError("recognition_worker_failed", "Local recognition output is too large.", 502)
                    payload = json.loads(output_path.read_text(encoding="utf-8"))
                except (OSError, UnicodeError, json.JSONDecodeError):
                    raise TradeBatchRuntimeError("recognition_worker_failed", "Local recognition returned an invalid result.", 502) from None
                self._validate_live_result(payload, batch_id, captures)
                payload["runtime"] = {"available": True, "engineId": ENGINE_ID,
                                      "modelBundleSha256": info["hashes"]["bundle"], "workerVersion": WORKER_VERSION,
                                      "durationMs": round((time.monotonic() - started) * 1000),
                                      "captureCount": len(captures), "rowCount": len(payload["rows"])}
                return payload
        finally:
            self._worker_lock.release()


    @staticmethod
    def _validate_live_result(payload: Any, batch_id: str, captures: list[dict[str, Any]]) -> None:
        ids = [capture["captureId"] for capture in captures]
        if (not isinstance(payload, dict) or payload.get("version") != 3 or payload.get("batchId") != batch_id
                or not isinstance(payload.get("rows"), list) or not isinstance(payload.get("captures"), list)
                or any(not isinstance(item, dict) for item in payload["captures"])
                or [item.get("captureId") for item in payload["captures"]] != ids):
            raise TradeBatchRuntimeError("recognition_worker_failed", "Local recognition returned an invalid live list.", 502)
        for row in payload["rows"]:
            if (not isinstance(row, dict) or row.get("captureId") not in ids
                    or type(row.get("ordinal")) is not int or row["ordinal"] < 0
                    or not isinstance(row.get("fields"), dict) or set(row["fields"]) != set(LIVE_FIELDS)):
                raise TradeBatchRuntimeError("recognition_worker_failed", "Local recognition returned an invalid live list.", 502)
            for field, value in row["fields"].items():
                if (not isinstance(value, dict) or not isinstance(value.get("rawOCR"), str)
                        or type(value.get("reviewRequired")) is not bool):
                    raise TradeBatchRuntimeError("recognition_worker_failed", "Local recognition returned an invalid live list.", 502)
                confidence = value.get("confidence")
                if confidence is not None and (type(confidence) not in (int, float)
                        or not math.isfinite(confidence) or not 0 <= confidence <= 1):
                    raise TradeBatchRuntimeError("recognition_worker_failed", "Local recognition returned invalid confidence.", 502)
                corrected = value.get("corrected")
                if corrected is not None and (field in ("reqAmount", "count", "yield")
                        and (type(corrected) is not int or corrected < (0 if field == "count" else 1))
                        or field not in ("reqAmount", "count", "yield") and not isinstance(corrected, str)):
                    raise TradeBatchRuntimeError("recognition_worker_failed", "Local recognition returned an invalid live list.", 502)
