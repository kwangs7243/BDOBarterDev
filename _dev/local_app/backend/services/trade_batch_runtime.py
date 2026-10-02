"""Bounded subprocess bridge for local T010P3A Trade draft recognition."""
from __future__ import annotations

import hashlib
import json
import os
import re
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
RAW_FIELDS = ("island", "fromItem", "reqAmount", "toItem", "count", "yield")
_LOWER_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _raw_v2_error() -> TradeBatchRuntimeError:
    return TradeBatchRuntimeError("recognition_worker_failed", "Local recognition returned an invalid raw evidence result.", 502)


def _valid_raw_hash(value: Any) -> bool:
    return isinstance(value, str) and _LOWER_SHA256.fullmatch(value) is not None


def _valid_raw_box(box: Any, frame: dict[str, Any]) -> bool:
    return (isinstance(box, dict) and set(box) == {"x", "y", "width", "height"}
            and all(type(box.get(key)) is int for key in ("x", "y", "width", "height"))
            and box["x"] >= 0 and box["y"] >= 0 and box["width"] > 0 and box["height"] > 0
            and box["x"] + box["width"] <= frame["width"]
            and box["y"] + box["height"] <= frame["height"])


def _validate_raw_evidence_v2(snapshot: Any, batch_id: str, captures: list[dict[str, Any]]) -> None:
    """Validate the worker trust boundary without rewriting its raw snapshot."""
    top_keys = {"schemaVersion", "recognitionBatchId", "captures", "sourceRows", "edgeSegments"}
    capture_keys = {"captureId", "captureOrdinal", "imageSha256", "bitmapSha256", "sourceType",
                    "frame", "sourceFidelity", "reencoded", "completeRowCount"}
    row_keys = {"sourceRowId", "captureId", "ordinal", "rowBox", "fields"}
    field_keys = {"field", "rawText", "rawNumeric", "readerStatus", "confidence", "cropRefs"}
    crop_keys = {"cropRefId", "sourceRowId", "captureId", "field", "bitmapSha256", "frame",
                 "coordinateSpace", "box", "pixelHashBasis", "pixelSha256", "pngArtifactSha256"}
    edge_keys = {"edgeId", "captureId", "ordinal", "reason", "rowBox", "sourceRefs"}
    ref_keys = {"sourceRowId", "captureId", "ordinal"}
    expected_ids = [capture["captureId"] for capture in captures]
    if (not isinstance(snapshot, dict) or set(snapshot) != top_keys or type(snapshot.get("schemaVersion")) is not int
            or snapshot["schemaVersion"] != 2 or snapshot.get("recognitionBatchId") != batch_id):
        raise _raw_v2_error()
    raw_captures, rows, edges = snapshot.get("captures"), snapshot.get("sourceRows"), snapshot.get("edgeSegments")
    if (not isinstance(raw_captures, list) or len(raw_captures) != len(expected_ids)
            or not isinstance(rows, list) or not isinstance(edges, list)):
        raise _raw_v2_error()
    capture_map: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(raw_captures, 1):
        if not isinstance(item, dict) or set(item) != capture_keys:
            raise _raw_v2_error()
        fidelity = item.get("sourceFidelity")
        unknown_fidelity = {"sourceWidth": None, "sourceHeight": None, "rescaled": None, "evidence": "unknown"}
        valid_fidelity = fidelity == unknown_fidelity or (
            isinstance(fidelity, dict) and set(fidelity) == set(unknown_fidelity)
            and type(fidelity.get("sourceWidth")) is int and fidelity["sourceWidth"] > 0
            and type(fidelity.get("sourceHeight")) is int and fidelity["sourceHeight"] > 0
            and type(fidelity.get("rescaled")) is bool
            and isinstance(fidelity.get("evidence"), str) and bool(fidelity["evidence"].strip())
            and fidelity["evidence"] != "unknown")
        frame = item.get("frame")
        capture_id = item.get("captureId")
        if (capture_id != expected_ids[index - 1] or not isinstance(capture_id, str) or not capture_id
                or len(capture_id) > 128 or capture_id in capture_map
                or type(item.get("captureOrdinal")) is not int or item.get("captureOrdinal") != index
                or item.get("sourceType") not in ("FILE", "CLIPBOARD", "STREAM")
                or item.get("sourceType") != {"file": "FILE", "clipboard": "CLIPBOARD", "browser-stream": "STREAM"}.get(
                    captures[index - 1]["metadata"].get("sourceType"))
                or type(item.get("reencoded")) is not bool or not valid_fidelity
                or item.get("reencoded") is not captures[index - 1].get("reencoded")
                or fidelity != captures[index - 1]["metadata"].get("fidelity")
                or not isinstance(frame, dict) or set(frame) != {"width", "height"}
                or any(type(frame.get(key)) is not int or frame[key] < 1 for key in ("width", "height"))
                or frame != captures[index - 1]["metadata"].get("frame")
                or not _valid_raw_hash(item.get("imageSha256")) or not _valid_raw_hash(item.get("bitmapSha256"))
                or item.get("imageSha256") != hashlib.sha256(captures[index - 1].get("imageBytes", b"")).hexdigest()
                or type(item.get("completeRowCount")) is not int or item["completeRowCount"] < 0):
            raise _raw_v2_error()
        capture_map[capture_id] = item

    source_ids: set[str] = set()
    crop_ids: set[str] = set()
    source_counts = {capture_id: 0 for capture_id in expected_ids}
    ordinals = {capture_id: set() for capture_id in expected_ids}
    last_position = (-1, -1)
    for row in rows:
        if not isinstance(row, dict) or set(row) != row_keys:
            raise _raw_v2_error()
        source_id, capture_id, ordinal = row.get("sourceRowId"), row.get("captureId"), row.get("ordinal")
        if (not isinstance(source_id, str) or not source_id or len(source_id) > 128 or source_id in source_ids
                or source_id in capture_map or not isinstance(capture_id, str) or capture_id not in capture_map
                or type(ordinal) is not int or ordinal < 0):
            raise _raw_v2_error()
        position = (capture_map[capture_id]["captureOrdinal"], ordinal)
        if position < last_position or ordinal in ordinals[capture_id]:
            raise _raw_v2_error()
        last_position = position
        ordinals[capture_id].add(ordinal)
        source_ids.add(source_id)
        source_counts[capture_id] += 1
        frame = capture_map[capture_id]["frame"]
        if not _valid_raw_box(row.get("rowBox"), frame):
            raise _raw_v2_error()
        fields = row.get("fields")
        if (not isinstance(fields, list) or len(fields) != len(RAW_FIELDS)
                or any(not isinstance(field, dict) for field in fields)
                or [field.get("field") for field in fields] != list(RAW_FIELDS)):
            raise _raw_v2_error()
        for field in fields:
            if (set(field) != field_keys or field.get("rawText") is not None and not isinstance(field.get("rawText"), str)
                    or field.get("rawNumeric") is not None and (type(field.get("rawNumeric")) is not int
                        or abs(field["rawNumeric"]) > 9007199254740991)
                    or field.get("field") not in ("reqAmount", "count", "yield") and field.get("rawNumeric") is not None
                    or not isinstance(field.get("readerStatus"), str) or not field["readerStatus"]
                    or field.get("confidence") is not None and not isinstance(field.get("confidence"), str)
                    or not isinstance(field.get("cropRefs"), list) or len(field["cropRefs"]) > 1):
                raise _raw_v2_error()
            for crop in field["cropRefs"]:
                if (not isinstance(crop, dict) or set(crop) != crop_keys
                        or not isinstance(crop.get("cropRefId"), str) or not crop["cropRefId"]
                        or crop["cropRefId"] in crop_ids or crop.get("sourceRowId") != source_id
                        or crop.get("captureId") != capture_id or crop.get("field") != field["field"]
                        or crop.get("bitmapSha256") != capture_map[capture_id]["bitmapSha256"]
                        or crop.get("frame") != frame or crop.get("coordinateSpace") != "CAPTURE_BITMAP_PIXELS"
                        or crop.get("pixelHashBasis") != "RGB8_ROW_MAJOR_V1"
                        or not _valid_raw_hash(crop.get("pixelSha256")) or crop.get("pngArtifactSha256") is not None
                        or not _valid_raw_box(crop.get("box"), frame)):
                    raise _raw_v2_error()
                crop_ids.add(crop["cropRefId"])
    if any(capture_map[capture_id]["completeRowCount"] != count for capture_id, count in source_counts.items()):
        raise _raw_v2_error()

    edge_ids: set[str] = set()
    edge_ordinals = {capture_id: set() for capture_id in expected_ids}
    for edge in edges:
        if (not isinstance(edge, dict) or set(edge) != edge_keys or not isinstance(edge.get("captureId"), str)
                or edge.get("captureId") not in capture_map
                or not isinstance(edge.get("edgeId"), str) or not edge["edgeId"] or len(edge["edgeId"]) > 128
                or edge["edgeId"] in edge_ids or edge["edgeId"] in source_ids or edge["edgeId"] in capture_map
                or type(edge.get("ordinal")) is not int or edge["ordinal"] < 0
                or edge["ordinal"] in edge_ordinals[edge["captureId"]]
                or not isinstance(edge.get("reason"), str) or not edge["reason"]
                or not _valid_raw_box(edge.get("rowBox"), capture_map[edge["captureId"]]["frame"])):
            raise _raw_v2_error()
        edge_ordinals[edge["captureId"]].add(edge["ordinal"])
        refs = edge.get("sourceRefs")
        if (not isinstance(refs, list) or len(refs) != 1 or not isinstance(refs[0], dict)
                or set(refs[0]) != ref_keys
                or refs[0] != {"sourceRowId": edge["edgeId"], "captureId": edge["captureId"],
                               "ordinal": edge["ordinal"]}):
            raise _raw_v2_error()
        edge_ids.add(edge["edgeId"])


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

    def recognize_raw_v2(self, batch_id: str, captures: list[dict[str, Any]]) -> dict[str, Any]:
        """Run the explicitly opted-in raw evidence worker contract."""
        source_types = {"file": "FILE", "clipboard": "CLIPBOARD", "browser-stream": "STREAM"}
        if not isinstance(captures, list) or not 1 <= len(captures) <= MAX_CAPTURES:
            raise TradeBatchRuntimeError("invalid_batch", "Raw evidence capture list is invalid.", 422)
        for capture in captures:
            metadata = capture.get("metadata") if isinstance(capture, dict) else None
            if (not isinstance(capture, dict) or set(capture) != {"captureId", "metadata", "imageBytes", "reencoded"}
                    or not isinstance(capture.get("captureId"), str) or not capture["captureId"]
                    or len(capture["captureId"]) > 128 or not isinstance(capture.get("imageBytes"), bytes)
                    or not isinstance(metadata, dict) or metadata.get("sourceType") not in source_types
                    or not isinstance(metadata.get("frame"), dict)
                    or type(capture.get("reencoded")) is not bool):
                raise TradeBatchRuntimeError("invalid_batch", "Raw evidence capture metadata is invalid.", 422)
            fidelity = metadata.get("fidelity")
            if not isinstance(fidelity, dict) or set(fidelity) != {"sourceWidth", "sourceHeight", "rescaled", "evidence"}:
                raise TradeBatchRuntimeError("invalid_batch", "Raw evidence source fidelity is invalid.", 422)
        reason, info = self._integrity()
        if reason == "engine_integrity_error":
            raise TradeBatchRuntimeError(reason, "The local recognition engine failed integrity verification.", 503)
        if reason:
            raise TradeBatchRuntimeError("engine_unavailable", "The local recognition engine is unavailable.", 503)
        if not self._worker_lock.acquire(blocking=False):
            raise TradeBatchRuntimeError("engine_busy", "The local recognition engine is busy.", 409, retryable=True)
        started = time.monotonic()
        try:
            with tempfile.TemporaryDirectory(prefix="bdo-trade-batch-v2-", dir=self.temp_root) as temporary:
                work_dir = Path(temporary)
                manifest_captures = []
                for ordinal, capture in enumerate(captures, 1):
                    name = f"capture-{ordinal:04d}.png"
                    (work_dir / name).write_bytes(capture["imageBytes"])
                    manifest_captures.append({
                        "captureId": capture["captureId"], "batchId": capture["metadata"]["batchId"],
                        "imagePath": name, "sourceType": source_types[capture["metadata"]["sourceType"]],
                        "sourceFidelity": dict(capture["metadata"]["fidelity"]),
                        "reencoded": capture["reencoded"],
                    })
                manifest_path, output_path = work_dir / "request.json", work_dir / "result.json"
                manifest_path.write_text(json.dumps({"version": 1, "batchId": batch_id, "captures": manifest_captures},
                                                    ensure_ascii=False), encoding="utf-8")
                command = [str(self.python_path), "-B", str(self.worker_path), "--request", str(manifest_path),
                           "--out", str(output_path), "--model-dir", str(self.model_dir),
                           "--raw-evidence-version", "2"]
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
                    raise _raw_v2_error()
                try:
                    snapshot = json.loads(output_path.read_text(encoding="utf-8"))
                except (OSError, UnicodeError, json.JSONDecodeError):
                    raise _raw_v2_error() from None
                _validate_raw_evidence_v2(snapshot, batch_id, captures)
                return {"rawEvidence": snapshot, "runtime": {
                    "available": True, "engineId": ENGINE_ID, "modelBundleSha256": info["hashes"]["bundle"],
                    "workerVersion": WORKER_VERSION, "durationMs": round((time.monotonic() - started) * 1000),
                    "captureCount": len(captures),
                }}
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
