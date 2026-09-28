"""Strict request contracts for the isolated recognition V2 API."""
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
UNSUPPORTED_FLAGS = {
    "warehouseV2", "tradeOCR", "autoApply", "nativeCapture", "remoteFallback", "debugCapture",
}


class RecognitionContractError(ValueError):
    def __init__(self, code: str, message: str, status: int = 422):
        super().__init__(message)
        self.code = code
        self.status = status


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_constant(_value: str) -> None:
    raise ValueError("non-finite JSON number")


def parse_json(raw: str | bytes, *, max_bytes: int, label: str) -> dict[str, Any]:
    encoded = raw.encode("utf-8") if isinstance(raw, str) else raw
    if len(encoded) > max_bytes:
        raise RecognitionContractError("metadata_too_large", f"{label} exceeds the allowed size.", 413)
    try:
        value = json.loads(encoded.decode("utf-8"), object_pairs_hook=_object, parse_constant=_reject_constant)
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
        raise RecognitionContractError("frame_mismatch", "Frame dimensions must match the decoded PNG.")
    return metadata, width, height


def validate_profile(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RecognitionContractError("invalid_profile", "Each profile must be an object.")
    _keys(value, {"version", "id", "profileVersion", "taskType", "sourceType", "referenceFrame", "region",
                  "anchorSetId", "anchorSetHash", "anchorOffsets", "canonicalGeometry", "observed", "verifiedStratumIds"})
    if value["version"] != 1 or type(value["version"]) is not int:
        raise RecognitionContractError("unsupported_version", "CaptureProfile version 1 is required.")
    profile_id = _uuid(value["id"], "profile.id")
    profile_version = _integer(value["profileVersion"], "profile.profileVersion", minimum=1)
    if (not isinstance(value["taskType"], str) or value["taskType"] not in TASK_TYPES
            or not isinstance(value["sourceType"], str) or value["sourceType"] not in SOURCE_TYPES):
        raise RecognitionContractError("invalid_profile", "Profile task/source type is not supported.")
    frame = value["referenceFrame"]
    if not isinstance(frame, dict):
        raise RecognitionContractError("invalid_profile", "referenceFrame must be an object.")
    _keys(frame, {"width", "height"})
    width = _integer(frame["width"], "referenceFrame.width", minimum=1)
    height = _integer(frame["height"], "referenceFrame.height", minimum=1)
    if width * height > MAX_IMAGE_PIXELS:
        raise RecognitionContractError("invalid_profile", "referenceFrame exceeds the pixel limit.")
    region = value["region"]
    if not isinstance(region, dict):
        raise RecognitionContractError("invalid_profile", "region must be an object.")
    _keys(region, {"x", "y", "w", "h"})
    coordinates = {key: _finite_number(region[key], f"region.{key}", minimum=0.0, maximum=1.0) for key in ("x", "y", "w", "h")}
    if coordinates["w"] <= 0 or coordinates["h"] <= 0 or coordinates["x"] + coordinates["w"] > 1 or coordinates["y"] + coordinates["h"] > 1:
        raise RecognitionContractError("invalid_profile", "region must fit within the normalized frame.")
    anchor_id = value["anchorSetId"]
    anchor_hash = value["anchorSetHash"]
    if not isinstance(anchor_id, str) or not anchor_id or len(anchor_id) > MAX_ID_LENGTH:
        raise RecognitionContractError("invalid_profile", "anchorSetId is invalid.")
    if not isinstance(anchor_hash, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", anchor_hash):
        raise RecognitionContractError("invalid_profile", "anchorSetHash must be SHA-256 hex.")
    for key in ("anchorOffsets", "canonicalGeometry", "observed"):
        if not isinstance(value[key], dict):
            raise RecognitionContractError("invalid_profile", f"{key} must be an object.")
    strata = value["verifiedStratumIds"]
    if not isinstance(strata, list) or len(strata) > 256 or any(not isinstance(item, str) or not item or len(item) > MAX_ID_LENGTH for item in strata):
        raise RecognitionContractError("invalid_profile", "verifiedStratumIds must be a bounded string list.")
    try:
        if len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")) > MAX_METADATA_BYTES:
            raise RecognitionContractError("metadata_too_large", "Profile metadata exceeds the allowed size.", 413)
    except (TypeError, ValueError):
        raise RecognitionContractError("invalid_profile", "Profile contains unsupported values.") from None
    return {**value, "id": profile_id, "profileVersion": profile_version,
            "referenceFrame": {"width": width, "height": height}, "region": coordinates}


def validate_config_update(value: dict[str, Any]) -> dict[str, Any]:
    _keys(value, {"version", "expectedConfigRevision", "flags", "profiles"})
    if value["version"] != 1 or type(value["version"]) is not int:
        raise RecognitionContractError("unsupported_version", "Recognition config version 1 is required.")
    revision = _integer(value["expectedConfigRevision"], "expectedConfigRevision")
    flags = value["flags"]
    if not isinstance(flags, dict):
        raise RecognitionContractError("invalid_contract", "flags must be an object.")
    _keys(flags, UNSUPPORTED_FLAGS)
    if any(type(enabled) is not bool for enabled in flags.values()):
        raise RecognitionContractError("invalid_contract", "Feature flags must be booleans.")
    if any(flags.values()):
        raise RecognitionContractError("unsupported_feature", "Recognition engines, capture, remote fallback, debug capture, and auto-apply are not enabled in this task.", 422)
    profiles = value["profiles"]
    if not isinstance(profiles, list) or len(profiles) > 64:
        raise RecognitionContractError("invalid_contract", "profiles must be a bounded list.")
    validated_profiles = [validate_profile(profile) for profile in profiles]
    ids = [profile["id"] for profile in validated_profiles]
    if len(ids) != len(set(ids)):
        raise RecognitionContractError("invalid_profile", "Profile IDs must be unique.")
    return {"expectedConfigRevision": revision, "flags": dict(flags), "profiles": validated_profiles}


def validate_feedback_payload(value: dict[str, Any]) -> dict[str, Any]:
    _keys(value, {"version", "labelMutationId", "rows"})
    if value["version"] != 1 or type(value["version"]) is not int:
        raise RecognitionContractError("unsupported_version", "Feedback version 1 is required.")
    mutation_id = _uuid(value["labelMutationId"], "labelMutationId")
    rows = value["rows"]
    if not isinstance(rows, list) or not rows or len(rows) > 63:
        raise RecognitionContractError("invalid_contract", "rows must contain between 1 and 63 labels.")
    seen_units: set[str] = set()
    normalized_rows = []
    for row in rows:
        if not isinstance(row, dict):
            raise RecognitionContractError("invalid_contract", "Each label row must be an object.")
        _keys(row, {"unitId", "fields"})
        unit = row["unitId"]
        fields = row["fields"]
        if not isinstance(unit, str) or not unit or len(unit) > MAX_ID_LENGTH or unit in seen_units:
            raise RecognitionContractError("invalid_contract", "unitId must be unique and bounded.")
        seen_units.add(unit)
        if not isinstance(fields, dict) or not fields or set(fields) - {"item", "quantity"}:
            raise RecognitionContractError("invalid_contract", "Each row needs supported item or quantity fields.")
        clean_fields = {}
        for field_name, label in fields.items():
            if not isinstance(label, dict):
                raise RecognitionContractError("invalid_contract", "Each field label must be an object.")
            _keys(label, {"value", "verification", "reason"})
            if label["verification"] != "explicit":
                raise RecognitionContractError("invalid_contract", "Only explicit human confirmations are accepted.")
            reason = label["reason"]
            if reason is not None and (not isinstance(reason, str) or len(reason) > 256):
                raise RecognitionContractError("invalid_contract", "Label reason must be a short string or null.")
            label_value = label["value"]
            if field_name == "item" and (not isinstance(label_value, str) or not label_value or len(label_value) > 128):
                raise RecognitionContractError("invalid_contract", "Item labels must be non-empty bounded strings.")
            if field_name == "quantity":
                _integer(label_value, "quantity label", minimum=0)
            clean_fields[field_name] = {"value": label_value, "verification": "explicit", "reason": reason}
        normalized_rows.append({"unitId": unit, "fields": clean_fields})
    return {"version": 1, "labelMutationId": mutation_id, "rows": normalized_rows}
