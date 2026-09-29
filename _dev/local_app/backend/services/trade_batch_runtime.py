"""Bounded subprocess bridge for local T010P3A Trade draft recognition."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[3]
WORKER_VERSION = "t010p3b1-worker-v1"
ENGINE_ID = "paddle-korean-ppocrv5-mobile-onnx-cpu-v1"
MODEL_ONNX_SHA256 = "92f0b7785e64fc9090106a241cf4c1eb97472824558272751b88a2a4476d3a08"
MODEL_CONFIG_SHA256 = "f757fa1c40e99edcf27e9cce879b93eb2a51fa46f5ef39095689b8c37dd75998"
MODEL_BUNDLE_SHA256 = "f56168a615fa6439b18f42e55cf48dad52883dd0411590a7a4d73603e5955f90"
MAX_BATCH_BYTES = 20 * 1024 * 1024
MAX_CAPTURES = 100
WORKER_TIMEOUT_SECONDS = 120
BOUNDARY_POLICY = "edge-segments-evidence-only-v1"


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
    """Server-configured runtime; injectable runner keeps API tests Paddle-free."""

    def __init__(self, *, python_path: str | Path | None = None, model_dir: str | Path | None = None,
                 worker_path: str | Path | None = None, selection_path: str | Path | None = None,
                 temp_root: str | Path | None = None, timeout: int = WORKER_TIMEOUT_SECONDS,
                 runner: Callable[..., Any] | None = None):
        self.python_path = Path(python_path or os.environ.get(
            "BDO_TRADE_OCR_PYTHON", ROOT / "recognition-local" / "envs" / "t010b1-ocr" / "Scripts" / "python.exe"))
        self.model_dir = Path(model_dir or os.environ.get(
            "BDO_TRADE_OCR_MODEL_DIR", ROOT / "recognition-local" / "models" / "t010b1" / "official_models" /
            "korean_PP-OCRv5_mobile_rec_onnx"))
        self.worker_path = Path(worker_path or ROOT / "local_app" / "tools" / "trade_batch_worker.py")
        self.selection_path = Path(selection_path or ROOT / "local_app" / "recognition_data" / "trade-t010p3a-experiment.json")
        self.row_selection_path = ROOT / "local_app" / "recognition_data" / "trade-t010a-experiment.json"
        self.numeric_selection_path = ROOT / "local_app" / "recognition_data" / "trade-t010a2-experiment.json"
        self.temp_root = Path(temp_root) if temp_root else None
        self.timeout = timeout
        self.runner = runner or subprocess.run
        self._worker_lock = threading.BoundedSemaphore(1)

    def _integrity(self) -> tuple[str | None, dict[str, Any]]:
        if not self.python_path.is_file():
            return "python_missing", {"available": False, "modelReady": False}
        if not self.worker_path.is_file() or not self.selection_path.is_file() or not self.row_selection_path.is_file() or not self.numeric_selection_path.is_file():
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
                "reason": reason, "mode": "LOCAL_DEVELOPMENT_RUNTIME_ONLY",
                "modelBundleSha256": info.get("hashes", {}).get("bundle", MODEL_BUNDLE_SHA256)}

    def recognize(self, batch_id: str, captures: list[dict[str, Any]]) -> dict[str, Any]:
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
                command = [str(self.python_path), "-B", str(self.worker_path), "--request", str(manifest_path),
                           "--out", str(output_path), "--model-dir", str(self.model_dir)]
                environment = {key: os.environ[key] for key in (
                    "PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
                    "PROGRAMDATA",
                ) if key in os.environ}
                environment.update({"PYTHONDONTWRITEBYTECODE": "1", "HF_HUB_OFFLINE": "1",
                                    "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8",
                                    "PADDLE_PDX_MODEL_SOURCE": "LOCAL", "PADDLE_PDX_CACHE_HOME": str(work_dir / "paddle-cache")})
                try:
                    result = self.runner(command, cwd=str(ROOT), shell=False, timeout=self.timeout,
                                         capture_output=True, text=True, env=environment)
                except subprocess.TimeoutExpired:
                    raise TradeBatchRuntimeError("recognition_timeout", "Local recognition timed out.", 504, retryable=True) from None
                if getattr(result, "returncode", 1) != 0 or not output_path.is_file():
                    raise TradeBatchRuntimeError("recognition_worker_failed", "Local recognition could not complete.", 502, retryable=True)
                try:
                    payload = json.loads(output_path.read_text(encoding="utf-8"))
                except (OSError, UnicodeError, json.JSONDecodeError):
                    raise TradeBatchRuntimeError("recognition_worker_failed", "Local recognition returned an invalid result.", 502) from None
                self._validate_worker_result(payload, batch_id, captures)
                payload["runtime"] = {"available": True, "engineId": ENGINE_ID,
                                      "modelBundleSha256": info["hashes"]["bundle"], "workerVersion": WORKER_VERSION,
                                      "durationMs": round((time.monotonic() - started) * 1000),
                                      "captureCount": len(captures), "draftRowCount": len(payload["draftRows"])}
                return payload
        finally:
            self._worker_lock.release()

    @staticmethod
    def _validate_worker_result(payload: Any, batch_id: str, captures: list[dict[str, Any]]) -> None:
        expected = [item["captureId"] for item in captures]
        if not isinstance(payload, dict) or payload.get("batchId") != batch_id or payload.get("version") != 1:
            raise TradeBatchRuntimeError("recognition_worker_failed", "Local recognition returned an invalid result.", 502)
        capture_evidence = payload.get("captures")
        edge_segments = payload.get("edgeSegments")
        metrics = payload.get("metrics")
        if (payload.get("captureIds") != expected or not isinstance(capture_evidence, list)
                or [item.get("captureId") for item in capture_evidence if isinstance(item, dict)] != expected
                or len(capture_evidence) != len(expected) or not isinstance(payload.get("draftRows"), list)
                or not isinstance(edge_segments, list) or not isinstance(metrics, dict)
                or metrics.get("boundaryPolicy") != BOUNDARY_POLICY):
            raise TradeBatchRuntimeError("recognition_worker_failed", "Local recognition returned an invalid result.", 502)
        detected = complete = edge_count = 0
        for item in capture_evidence:
            dimensions = item.get("imageDimensions")
            if (not isinstance(item.get("imageHash"), str) or len(item["imageHash"]) != 64
                    or not isinstance(dimensions, dict)
                    or any(not isinstance(dimensions.get(key), int) or dimensions[key] <= 0 for key in ("width", "height"))):
                raise TradeBatchRuntimeError("recognition_worker_failed", "Local recognition returned invalid capture evidence.", 502)
            counts = (item.get("detectedCandidateCount"), item.get("completeRowCount"), item.get("edgeSegmentCount"))
            if any(not isinstance(value, int) or value < 0 for value in counts) or counts[0] != counts[1] + counts[2]:
                raise TradeBatchRuntimeError("recognition_worker_failed", "Local recognition returned invalid capture metrics.", 502)
            detected += counts[0]
            complete += counts[1]
            edge_count += counts[2]
        if (metrics.get("detectedCandidateCount") != detected or metrics.get("completeRowCount") != complete
                or metrics.get("edgeSegmentCount") != edge_count or metrics.get("draftRowCount") != len(payload["draftRows"])
                or len(edge_segments) != edge_count or len(payload["draftRows"]) != complete):
            raise TradeBatchRuntimeError("recognition_worker_failed", "Local recognition returned inconsistent row metrics.", 502)
        for edge in edge_segments:
            if (not isinstance(edge, dict) or edge.get("captureId") not in expected
                    or edge.get("classification") != "EDGE_SEGMENT_UNCERTAIN"
                    or edge.get("boundarySide") not in ("top", "bottom", "both") or "fields" in edge):
                raise TradeBatchRuntimeError("recognition_worker_failed", "Local recognition returned invalid edge evidence.", 502)
        for row in payload["draftRows"]:
            fields = row.get("fields") if isinstance(row, dict) else None
            if (not isinstance(fields, dict) or set(fields) != {"island", "fromItem", "reqAmount", "toItem", "count", "yield"}
                    or row.get("status") != "DRAFT_UNVERIFIED" or row.get("automationDecision") != "REVIEW"
                    or row.get("captureId") not in expected
                    or any(not isinstance(value, dict) or value.get("value") is not None
                           or "ROW_BOUNDARY_CONTACT" in value.get("reasonCodes", []) for value in fields.values())):
                raise TradeBatchRuntimeError("recognition_worker_failed", "Local recognition returned an invalid draft.", 502)
