"""Capture and explicit correction request validation."""
from __future__ import annotations

import json
import math
import re
import uuid
from datetime import datetime, timezone
from io import BytesIO
from typing import Any

from PIL import Image, UnidentifiedImageError


MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_METADATA_BYTES = 64 * 1024
MAX_IMAGE_PIXELS = 32_000_000
MAX_ID_LENGTH = 128
MAX_SAFE_INTEGER = 9_007_199_254_740_991
TASK_TYPES = {"warehouse", "trade"}
SOURCE_TYPES = {"file", "clipboard", "browser-stream"}


class RecognitionContractError(ValueError):
    def __init__(self, code: str, message: str, status: int = 422, *, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.details = details


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_constant(_value: str) -> None:
    raise ValueError("non-finite JSON number")


def parse_json(raw: str | bytes, *, max_bytes: int, label: str, reject_negative_zero: bool = False) -> dict[str, Any]:
    encoded = raw.encode("utf-8") if isinstance(raw, str) else raw
    if len(encoded) > max_bytes:
        raise RecognitionContractError("metadata_too_large", f"{label} exceeds the allowed size.", 413)
    try:
        def parse_integer(token: str):
            if reject_negative_zero and token == "-0": raise ValueError("negative zero is not allowed")
            return int(token)
        value = json.loads(encoded.decode("utf-8"), object_pairs_hook=_object, parse_constant=_reject_constant, parse_int=parse_integer)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise RecognitionContractError("invalid_json", f"{label} must be valid UTF-8 JSON.", 400) from None
    if not isinstance(value, dict):
        raise RecognitionContractError("invalid_contract", f"{label} must be a JSON object.")
    return value


def _keys(value: dict[str, Any], required: set[str], optional: set[str] = frozenset()) -> None:
    keys = set(value)
    if not required <= keys or keys - required - optional:
        raise RecognitionContractError("invalid_contract", "The request contains missing or unsupported fields.")


def _integer(value: Any, label: str, *, minimum: int = 0, maximum: int = MAX_SAFE_INTEGER) -> int:
    if type(value) is not int or value < minimum or value > maximum:
        raise RecognitionContractError("invalid_contract", f"{label} must be an integer in range.")
    return value


def _finite_number(value: Any, label: str, *, minimum: float = 0.0, maximum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise RecognitionContractError("invalid_contract", f"{label} must be a finite number.")
    if value < minimum or (maximum is not None and value > maximum):
        raise RecognitionContractError("invalid_contract", f"{label} is outside the allowed range.")
    return float(value)


def _uuid(value: Any, label: str, *, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or len(value) > MAX_ID_LENGTH:
        raise RecognitionContractError("invalid_contract", f"{label} must be a UUID.")
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError):
        raise RecognitionContractError("invalid_contract", f"{label} must be a UUID.") from None


def _utc_timestamp(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 64:
        raise RecognitionContractError("invalid_contract", "capturedAt must be an ISO-8601 UTC timestamp.")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise RecognitionContractError("invalid_contract", "capturedAt must be an ISO-8601 UTC timestamp.") from None
    if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        raise RecognitionContractError("invalid_contract", "capturedAt must include a UTC offset.")
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def validate_capture_metadata(value: dict[str, Any], *, expected_task: str | None = None) -> dict[str, Any]:
    _keys(value, {"version", "captureId", "batchId", "taskType", "sourceType", "capturedAt", "frame",
                  "fidelity", "profileId", "profileVersion", "context", "observed"})
    if value["version"] != 1 or type(value["version"]) is not int:
        raise RecognitionContractError("unsupported_version", "Capture metadata version 1 is required.")
    task = value["taskType"]
    if not isinstance(task, str) or task not in TASK_TYPES or (expected_task and task != expected_task):
        raise RecognitionContractError("invalid_task_type", "The capture task type is not supported.")
    source = value["sourceType"]
    if not isinstance(source, str) or source not in SOURCE_TYPES:
        raise RecognitionContractError("invalid_source_type", "The capture source type is not supported.")

    frame = value["frame"]
    if not isinstance(frame, dict):
        raise RecognitionContractError("invalid_contract", "frame must be an object.")
    _keys(frame, {"width", "height"})
    width = _integer(frame["width"], "frame.width", minimum=1, maximum=MAX_IMAGE_PIXELS)
    height = _integer(frame["height"], "frame.height", minimum=1, maximum=MAX_IMAGE_PIXELS)
    if width * height > MAX_IMAGE_PIXELS:
        raise RecognitionContractError("image_too_large", "The image pixel limit was exceeded.", 413)

    fidelity = value["fidelity"]
    if not isinstance(fidelity, dict):
        raise RecognitionContractError("invalid_contract", "fidelity must be an object.")
    _keys(fidelity, {"sourceWidth", "sourceHeight", "rescaled", "evidence"})
    for key in ("sourceWidth", "sourceHeight"):
        if fidelity[key] is not None:
            _integer(fidelity[key], f"fidelity.{key}", minimum=1, maximum=MAX_IMAGE_PIXELS)
    if (fidelity["sourceWidth"] is None) != (fidelity["sourceHeight"] is None):
        raise RecognitionContractError("invalid_contract", "Source dimensions must both be known or both be null.")
    if fidelity["rescaled"] is not None and type(fidelity["rescaled"]) is not bool:
        raise RecognitionContractError("invalid_contract", "fidelity.rescaled must be boolean or null.")
    if not isinstance(fidelity["evidence"], str) or fidelity["evidence"] not in {"track-settings", "file-metadata", "user-observed", "unknown"}:
        raise RecognitionContractError("invalid_contract", "fidelity.evidence is not supported.")

    context = value["context"]
    if not isinstance(context, dict):
        raise RecognitionContractError("invalid_contract", "context must be an object.")
    _keys(context, {"baseRevision", "sessionId", "sessionRevision"})
    _integer(context["baseRevision"], "context.baseRevision")
    _uuid(context["sessionId"], "context.sessionId", nullable=True)
    if context["sessionRevision"] is not None:
        _integer(context["sessionRevision"], "context.sessionRevision")

    observed = value["observed"]
    if not isinstance(observed, dict):
        raise RecognitionContractError("invalid_contract", "observed must be an object.")
    _keys(observed, {"browserDpr", "windowsDpi", "gameResolution", "gameUiScale"})
    for key in ("browserDpr", "windowsDpi", "gameUiScale"):
        if observed[key] is not None:
            _finite_number(observed[key], f"observed.{key}", minimum=0.01, maximum=10000)
    resolution = observed["gameResolution"]
    if resolution is not None and (not isinstance(resolution, str) or len(resolution) > 64):
        raise RecognitionContractError("invalid_contract", "observed.gameResolution must be a short string or null.")

    profile_version = _integer(value["profileVersion"], "profileVersion", minimum=1)
    return {
        "version": 1,
        "captureId": _uuid(value["captureId"], "captureId"),
        "batchId": _uuid(value["batchId"], "batchId", nullable=True),
        "taskType": task,
        "sourceType": source,
        "capturedAt": _utc_timestamp(value["capturedAt"]),
        "frame": {"width": width, "height": height},
        "fidelity": fidelity,
        "profileId": _uuid(value["profileId"], "profileId", nullable=True),
        "profileVersion": profile_version,
        "context": context,
        "observed": observed,
    }


def validate_capture_payload(metadata_raw: str | bytes, image_bytes: bytes, *, content_type: str,
                             expected_task: str | None = None) -> tuple[dict[str, Any], int, int]:
    metadata = validate_capture_metadata(parse_json(metadata_raw, max_bytes=MAX_METADATA_BYTES, label="metadata"),
                                         expected_task=expected_task)
    if content_type.lower().split(";", 1)[0].strip() != "image/png":
        raise RecognitionContractError("unsupported_media_type", "A single PNG image is required.", 415)
    if not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES:
        status = 413 if len(image_bytes) > MAX_IMAGE_BYTES else 422
        code = "image_too_large" if status == 413 else "invalid_image"
        raise RecognitionContractError(code, "The PNG image is empty or exceeds the allowed size.", status)
    try:
        with Image.open(BytesIO(image_bytes)) as image:
            if image.format != "PNG" or getattr(image, "is_animated", False) or getattr(image, "n_frames", 1) != 1:
                raise RecognitionContractError("invalid_image", "A non-animated PNG image is required.")
            width, height = image.size
            if width < 1 or height < 1 or width * height > MAX_IMAGE_PIXELS:
                raise RecognitionContractError("image_too_large", "The image pixel limit was exceeded.", 413)
            image.verify()
        with Image.open(BytesIO(image_bytes)) as decoded:
            decoded.load()
    except RecognitionContractError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise RecognitionContractError("invalid_image", "The uploaded image is not a valid PNG.") from None
    if metadata["frame"] != {"width": width, "height": height}:
        raise RecognitionContractError("frame_mismatch", "Frame dimensions must match the decoded PNG.",
                                       details={"frame": metadata["frame"], "decodedFrame": {"width": width, "height": height}})
    return metadata, width, height



def validate_trade_corrections(feedback, captures):
    from .services.trade_batch_runtime import ENGINE_ID, MODEL_BUNDLE_SHA256, WORKER_VERSION
    def fail():
        raise RecognitionContractError("invalid_feedback", "Correction feedback is invalid.")
    snapshot = feedback.get("snapshot")
    expanded = feedback.get("version") == 2 and type(feedback.get("version")) is int
    expected = {"version", "feedbackId", "captures", "engineId", "modelVersion", "workerVersion", "corrections"}
    if expanded:
        expected.add("snapshot")
    if (set(feedback) != expected
            or type(feedback["version"]) is not int or feedback["version"] not in (1, 2)
            or feedback["engineId"] != ENGINE_ID or feedback["modelVersion"] != MODEL_BUNDLE_SHA256
            or feedback["workerVersion"] not in ({WORKER_VERSION, "trade-live-worker-v5", "trade-live-worker-v6", "trade-live-worker-v7", "trade-live-worker-v8", "trade-live-worker-v9"} if expanded else {WORKER_VERSION})):
        fail()
    _uuid(feedback["feedbackId"], "feedbackId")
    rows = feedback["corrections"]
    if not isinstance(rows, list) or not (0 if expanded else 1) <= len(rows) <= 600:
        fail()
    frames = {capture["captureId"]: capture["metadata"]["frame"] for capture in captures}
    seen = set()
    touched = set()
    def box(value, frame):
        if (not isinstance(value, dict) or set(value) != {"x", "y", "width", "height"}
                or any(type(v) is not int for v in value.values())
                or value["x"] < 0 or value["y"] < 0 or value["width"] <= 0 or value["height"] <= 0
                or value["x"] + value["width"] > frame["width"]
                or value["y"] + value["height"] > frame["height"]):
            fail()
    for row in rows:
        if (not isinstance(row, dict) or set(row) != {"captureId", "ordinal", "rowBox", "field", "box", "rawOCR",
                                                    "confidence", "automaticCorrected", "finalValue"}
                or not isinstance(row["captureId"], str) or row["captureId"] not in frames
                or type(row["ordinal"]) is not int or row["ordinal"] < 0
                or not isinstance(row["field"], str) or row["field"] not in {"island", "fromItem", "toItem", "reqAmount", "count", "yield"}
                or not isinstance(row["rawOCR"], str) or len(row["rawOCR"]) > 1024):
            fail()
        key = (row["captureId"], row["ordinal"], row["field"])
        if key in seen:
            fail()
        seen.add(key)
        touched.add(row["captureId"])
        frame = frames[row["captureId"]]
        box(row["rowBox"], frame)
        box(row["box"], frame)
        parent, child = row["rowBox"], row["box"]
        if (child["x"] < parent["x"] or child["y"] < parent["y"]
                or child["x"] + child["width"] > parent["x"] + parent["width"]
                or child["y"] + child["height"] > parent["y"] + parent["height"]):
            fail()
        confidence = row["confidence"]
        if confidence is not None and (type(confidence) not in (int, float) or not math.isfinite(confidence) or not 0 <= confidence <= 1):
            fail()
        numeric = row["field"] in {"reqAmount", "count", "yield"}
        for label in ("automaticCorrected", "finalValue"):
            value = row[label]
            if label == "automaticCorrected" and value is None:
                continue
            if numeric:
                if type(value) is not int or not (0 if row["field"] == "count" else 1) <= value <= MAX_SAFE_INTEGER:
                    fail()
            elif not isinstance(value, str) or not value.strip() or len(value) > 256:
                fail()
        if row["automaticCorrected"] == row["finalValue"]:
            fail()
    if not expanded and touched != set(frames):
        fail()
    if expanded:
        from .services.trade_batch_runtime import TradeBatchRuntime, TradeBatchRuntimeError
        if not isinstance(snapshot, dict) or set(snapshot) != {"phase", "result"} or snapshot["phase"] not in {"recognized", "reviewed", "applied", "recovered"}:
            fail()
        result = snapshot["result"]
        if not isinstance(result, dict) or not isinstance(result.get("rows"), list) or len(result["rows"]) > 600:
            fail()
        try:
            TradeBatchRuntime._validate_live_result(result, result.get("batchId"), captures)
        except TradeBatchRuntimeError:
            fail()
        members = set()
        for row in result["rows"]:
            key = (row["captureId"], row["ordinal"])
            if key in members or type(row.get("excluded", False)) is not bool:
                fail()
            members.add(key)
            frame = frames[row["captureId"]]
            box(row.get("rowBox"), frame)
            for value in row["fields"].values():
                box(value.get("box"), frame)
                if len(value["rawOCR"]) > 1024:
                    fail()
