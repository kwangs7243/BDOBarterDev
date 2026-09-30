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
MAX_TRADE_OBSERVATION_BYTES = 8 * 1024 * 1024
MAX_TRADE_CROP_BYTES = 512 * 1024
TRADE_FIELDS = ("island", "fromItem", "reqAmount", "toItem", "count", "yield")
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


def _trade_fail(message: str = "The trade review observation contract is invalid.") -> None:
    raise RecognitionContractError("invalid_contract", message, 422)


def _same_trade_json(left: Any, right: Any) -> bool:
    try: return json.dumps(left, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False) == json.dumps(right, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError): return False


def _trade_json_walk(value: Any, *, depth: int = 0, budget: list[int] | None = None) -> None:
    if budget is None: budget = [250_000]
    budget[0] -= 1
    if budget[0] < 0 or depth > 32: _trade_fail("The observation exceeds structural limits.")
    if isinstance(value, float):
        if not math.isfinite(value): _trade_fail("Non-finite numbers are not allowed.")
        return
    if isinstance(value, str):
        try: encoded = value.encode("utf-8", "strict")
        except UnicodeEncodeError: _trade_fail("Text must be valid Unicode.")
        if len(encoded) > 8192: _trade_fail("A diagnostic string exceeds its limit.")
    elif isinstance(value, dict):
        if len(value) > 128 and not ("legacyNames" in value or "entities" in value): _trade_fail("An object exceeds its key limit.")
        for key, child in value.items():
            if not isinstance(key, str): _trade_fail()
            if key.lower() in {"image", "imagebytes", "base64", "dataurl", "blob", "bytes", "path", "filepath", "url"}: _trade_fail("Binary data and external paths are not accepted in JSON.")
            if (key.endswith("Id") or key.endswith("Version") or key in {"projectionRowId", "draftId", "registryVersion", "correctionVersion"}) and isinstance(child, str) and len(child.encode("utf-8")) > 256: _trade_fail("An identifier or version label exceeds its limit.")
            if isinstance(child, list):
                list_limit = 128 if key in {"riskReasons", "correctionReason", "reasonCodes", "alternatives", "selectionReasons"} else 100 if key == "sourceRefs" else 1000 if key in {"rows", "legacyNames", "entities"} else 200 if key == "edgeSegments" else 100 if key in {"captures", "captureEvidence"} else 6000
                if len(child) > list_limit: _trade_fail("A contract list exceeds its limit.")
            _trade_json_walk(key, depth=depth + 1, budget=budget)
            _trade_json_walk(child, depth=depth + 1, budget=budget)
    elif isinstance(value, list):
        if len(value) > 6000: _trade_fail("An array exceeds its limit.")
        for child in value: _trade_json_walk(child, depth=depth + 1, budget=budget)
    elif value is None or type(value) in (bool, int):
        if type(value) is int and abs(value) > MAX_SAFE_INTEGER: _trade_fail("An integer exceeds the safe range.")
    elif value is not None:
        _trade_fail()


def validate_trade_review_observation(payload: dict[str, Any]) -> dict[str, Any]:
    """Strict, endpoint-specific R006 truth and cross-snapshot validator."""
    import re
    from .recognition_store import canonical_json
    required = {"schemaVersion", "mutationId", "createdAt", "confirmationRevision", "supersedesObservationId", "completion", "sourceContext", "cropPlan"}
    if set(payload) != required: _trade_fail()
    _trade_json_walk(payload)
    try: canonical_bytes = canonical_json(payload).encode("utf-8", "strict")
    except (ValueError, UnicodeEncodeError): _trade_fail("The observation cannot be serialized canonically.")
    if len(canonical_bytes) > MAX_TRADE_OBSERVATION_BYTES: raise RecognitionContractError("request_too_large", "The canonical observation exceeds 8 MiB.", 413)
    if type(payload["schemaVersion"]) is not int or payload["schemaVersion"] != 1 or type(payload["confirmationRevision"]) is not int or payload["confirmationRevision"] != 1 or payload["supersedesObservationId"] is not None: _trade_fail()
    try: mutation = str(uuid.UUID(payload["mutationId"]))
    except (ValueError, TypeError, AttributeError): _trade_fail("mutationId must be a UUID.")
    if mutation != payload["mutationId"]: _trade_fail("mutationId must use canonical lowercase UUID form.")
    created = payload["createdAt"]
    if not isinstance(created, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", created): _trade_fail("createdAt must be an ISO UTC timestamp with milliseconds.")
    try:
        if datetime.fromisoformat(created.replace("Z", "+00:00")).utcoffset() != timezone.utc.utcoffset(datetime.now(timezone.utc)): _trade_fail()
    except ValueError: _trade_fail("createdAt must be a valid UTC timestamp.")
    completion = payload["completion"]
    ckeys = {"schemaVersion", "reviewMode", "recognitionBatchId", "projectionHash", "registryVersion", "correctionVersion", "reviewRevision", "rows", "edgeSegments", "summary"}
    if not isinstance(completion, dict) or set(completion) != ckeys or completion.get("schemaVersion") != 1 or type(completion.get("schemaVersion")) is not int or completion.get("reviewMode") != "REVIEW_FIRST": _trade_fail()
    try: batch = str(uuid.UUID(completion["recognitionBatchId"]))
    except (ValueError, TypeError, AttributeError): _trade_fail("recognitionBatchId must be a UUID.")
    if batch != completion["recognitionBatchId"]: _trade_fail()
    for key in ("projectionHash",):
        if not isinstance(completion.get(key), str) or not re.fullmatch(r"[0-9a-f]{64}", completion[key]): _trade_fail()
    for key in ("registryVersion", "correctionVersion"):
        if not isinstance(completion.get(key), str) or not completion[key] or len(completion[key].encode("utf-8")) > 256: _trade_fail()
    if type(completion.get("reviewRevision")) is not int or completion["reviewRevision"] < 0: _trade_fail()
    source = payload["sourceContext"]
    if not isinstance(source, dict) or set(source) != {"version", "authority", "registry", "projection", "recognition", "captures", "gameVersion"} or source.get("version") != 1 or source.get("authority") != "CLIENT_ATTESTED": _trade_fail()
    if source["gameVersion"] is not None and (not isinstance(source["gameVersion"], str) or len(source["gameVersion"].encode("utf-8")) > 128): _trade_fail()
    registry, projection, recognition = source["registry"], source["projection"], source["recognition"]
    if not isinstance(registry, dict) or not isinstance(projection, dict) or not isinstance(recognition, dict): _trade_fail()
    if not isinstance(registry, dict) or set(registry) != {"sourceRevision", "sourceSha256", "snapshotSha256", "snapshot", "hashBasis"} or registry.get("hashBasis") != "JS_REGISTRY_SORTED_JSON_V1" or not isinstance(registry.get("snapshot"), dict): _trade_fail()
    if not isinstance(registry.get("sourceRevision"), str) or not registry["sourceRevision"] or any(not isinstance(registry.get(k), str) or not re.fullmatch(r"[0-9a-f]{64}", registry[k]) for k in ("sourceSha256", "snapshotSha256")): _trade_fail()
    if not isinstance(projection, dict) or set(projection) != {"snapshot", "hashBasis"} or projection.get("hashBasis") != "JS_REGISTRY_SORTED_JSON_V1" or not isinstance(projection.get("snapshot"), dict): _trade_fail()
    if not isinstance(recognition, dict) or set(recognition) != {"resultVersion", "runtime", "boundaryPolicy", "captureEvidence", "geometryProfile"} or recognition.get("resultVersion") != 1: _trade_fail()
    if not isinstance(recognition.get("runtime"), dict) or set(recognition["runtime"]) != {"engineId", "modelBundleSha256", "workerVersion"}: _trade_fail()
    if any(value is not None and (not isinstance(value, str) or len(value.encode("utf-8")) > 256) for value in recognition["runtime"].values()): _trade_fail()
    model_hash = recognition["runtime"].get("modelBundleSha256")
    if model_hash is not None and not re.fullmatch(r"[0-9a-f]{64}", model_hash): _trade_fail()
    if not isinstance(recognition.get("boundaryPolicy"), str) or not recognition["boundaryPolicy"]: _trade_fail()
    geometry_profile = recognition.get("geometryProfile")
    if not isinstance(geometry_profile, dict) or set(geometry_profile) != {"revision", "sha256", "availability"} or geometry_profile != {"revision": None, "sha256": None, "availability": "NOT_EXPOSED_BY_API"}: _trade_fail()
    if not isinstance(recognition.get("captureEvidence"), dict) or set(recognition["captureEvidence"]) != {"captures", "edgeSegments"} or not isinstance(recognition["captureEvidence"].get("captures"), list) or not isinstance(recognition["captureEvidence"].get("edgeSegments"), list): _trade_fail()
    captures = source.get("captures")
    if not isinstance(captures, list) or not 1 <= len(captures) <= 100: _trade_fail()
    capture_ids = set()
    evidence_by_id = {item.get("captureId"): item for item in recognition["captureEvidence"]["captures"] if isinstance(item, dict)}
    if len(evidence_by_id) != len(captures) or len(recognition["captureEvidence"]["captures"]) != len(captures): _trade_fail("Capture evidence must match the submitted captures.")
    for item in captures:
        if not isinstance(item, dict) or set(item) != {"captureId", "metadata", "bitmapSha256", "sourceSha256", "bitmapBytes", "sourceBytes", "reencoded"}: _trade_fail()
        try: cid = str(uuid.UUID(item["captureId"]))
        except (ValueError, TypeError, AttributeError): _trade_fail()
        if cid != item["captureId"] or cid in capture_ids: _trade_fail()
        capture_ids.add(cid)
        if not isinstance(item["metadata"], dict) or item["metadata"].get("captureId") != cid or item["metadata"].get("taskType") != "trade": _trade_fail()
        validate_capture_metadata(item["metadata"], expected_task="trade")
        if not isinstance(item["bitmapSha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", item["bitmapSha256"]): _trade_fail()
        if item["sourceSha256"] is not None and (not isinstance(item["sourceSha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", item["sourceSha256"])): _trade_fail()
        for key in ("bitmapBytes", "sourceBytes"):
            if type(item[key]) is not int or item[key] < 0: _trade_fail()
        if type(item["reencoded"]) is not bool: _trade_fail()
        evidence = evidence_by_id.get(cid)
        if not isinstance(evidence, dict) or set(evidence) != {"captureId", "batchId", "captureOrdinal", "imageHash", "imageDimensions", "detectedCandidateCount", "completeRowCount", "edgeSegmentCount"}: _trade_fail()
        if evidence.get("batchId") != item["metadata"].get("batchId") or type(evidence.get("captureOrdinal")) is not int or evidence["captureOrdinal"] < 1: _trade_fail()
        counts = [evidence.get(key) for key in ("detectedCandidateCount", "completeRowCount", "edgeSegmentCount")]
        if any(type(count) is not int or count < 0 for count in counts) or counts[0] != counts[1] + counts[2]: _trade_fail()
        if evidence is None or evidence.get("imageHash") != item["bitmapSha256"] or not _same_trade_json(evidence.get("imageDimensions"), item["metadata"].get("frame")): _trade_fail("Capture provenance does not match recognition evidence.")
    if [item.get("captureId") for item in recognition["captureEvidence"]["captures"]] != [item["captureId"] for item in captures]: _trade_fail("Capture order does not match recognition evidence.")
    proj = projection["snapshot"]
    if not isinstance(proj.get("projectionHash"), str) or not isinstance(proj.get("masterVersion"), str) or not isinstance(proj.get("correctionPolicyVersion"), str): _trade_fail()
    proj_rows = proj.get("rows") if isinstance(proj, dict) else None
    rows, edges = completion["rows"], completion["edgeSegments"]
    if not isinstance(proj_rows, list) or not isinstance(rows, list) or len(rows) != len(proj_rows) or len(rows) > 1000 or not isinstance(edges, list) or len(edges) > 200: _trade_fail()
    if completion["projectionHash"] != proj.get("projectionHash") or completion["registryVersion"] != registry["snapshot"].get("registryVersion") or completion["registryVersion"] != proj.get("masterVersion") or completion["correctionVersion"] != proj.get("correctionPolicyVersion"): _trade_fail("Completion and source snapshots disagree.")
    if not _same_trade_json(edges, recognition["captureEvidence"]["edgeSegments"]): _trade_fail("Edge evidence does not match the recognition source.")
    for ordinal, capture in enumerate(captures, 1):
        evidence = evidence_by_id[capture["captureId"]]
        complete_count = sum(1 for row in proj_rows if row.get("captureId") == capture["captureId"])
        edge_count = sum(1 for edge in edges if edge.get("captureId") == capture["captureId"])
        if evidence["captureOrdinal"] != ordinal or evidence["completeRowCount"] != complete_count or evidence["edgeSegmentCount"] != edge_count: _trade_fail("Capture metrics do not match reviewed rows and edges.")
    unchanged = edited = unknown = risky_count = 0
    row_ids = set()
    for row, projected in zip(rows, proj_rows, strict=True):
        if not isinstance(row, dict) or not isinstance(projected, dict): _trade_fail()
        row_keys = {"projectionRowId", "captureId", "ordinal", "sourceRefs", "fields"}
        if not row_keys <= set(row) or set(row) - row_keys - {"draftId", "rowBox", "rowCropHash"}: _trade_fail()
        rid = row.get("projectionRowId")
        if not isinstance(rid, str) or not rid or len(rid.encode("utf-8")) > 256 or rid != projected.get("projectionRowId") or rid in row_ids: _trade_fail()
        row_ids.add(rid)
        if row.get("captureId") != projected.get("captureId") or row.get("ordinal") != projected.get("ordinal") or row.get("captureId") not in capture_ids or not _same_trade_json(row.get("sourceRefs"), projected.get("sourceRefs")): _trade_fail("Row lineage does not match its projection.")
        if any(not _same_trade_json(row.get(key, None), projected.get(key, None)) for key in ("draftId", "rowBox", "rowCropHash")): _trade_fail()
        if type(row.get("ordinal")) is not int or row["ordinal"] < 0 or not isinstance(row.get("sourceRefs"), list) or len(row["sourceRefs"]) > 100: _trade_fail()
        fields = row.get("fields")
        if not isinstance(fields, list) or len(fields) != 6 or not all(isinstance(f, dict) for f in fields) or [f.get("field") for f in fields] != list(TRADE_FIELDS): _trade_fail()
        expected_fields = projected.get("fields")
        for field in fields:
            if set(field) != {"field", "shownValueBefore", "finalValue", "verificationMethod", "projectionStatus", "candidate", "rawEvidence", "correctionReason", "riskReasons", "masterVersion"}: _trade_fail()
            key = field["field"]
            pf = expected_fields.get(key) if isinstance(expected_fields, dict) else None
            if not isinstance(pf, dict) or not _same_trade_json(field.get("shownValueBefore"), pf.get("shownValue")) or field.get("projectionStatus") != pf.get("status") or not _same_trade_json(field.get("candidate"), pf.get("candidate")) or not _same_trade_json(field.get("rawEvidence"), pf.get("rawEvidence")) or not _same_trade_json(field.get("correctionReason"), pf.get("correctionReason")) or not _same_trade_json(field.get("riskReasons"), pf.get("riskReasons")) or field.get("masterVersion") != pf.get("masterVersion"): _trade_fail("Field truth does not match its projection.")
            method, shown, final = field.get("verificationMethod"), field.get("shownValueBefore"), field.get("finalValue")
            numeric = key in {"reqAmount", "count", "yield"}
            minimum = 0 if key == "count" else 1
            for value in (shown, final):
                if value is not None and (numeric and (type(value) is not int or value < minimum) or not numeric and not isinstance(value, str)): _trade_fail()
                if not numeric and isinstance(value, str) and len(value.encode("utf-8")) > 512: _trade_fail()
            if method == "USER_MARKED_UNKNOWN":
                if final is not None: _trade_fail()
                unknown += 1
            elif method == "USER_BATCH_CONFIRMED_UNCHANGED":
                if shown is None or type(shown) is not type(final) or shown != final: _trade_fail()
                unchanged += 1
            elif method == "USER_EDITED":
                if final is None or type(shown) is type(final) and shown == final: _trade_fail()
                edited += 1
            else: _trade_fail()
            if not numeric and final is not None and not final.strip(): _trade_fail()
            if field.get("riskReasons") or field.get("projectionStatus") in {"AMBIGUOUS", "UNMATCHED", "MASTER_DISAGREEMENT"}: risky_count += 1
    summary = completion["summary"]
    expected_summary = {"rowCount": len(rows), "fieldCount": len(rows)*6, "unchangedFieldCount": unchanged, "editedFieldCount": edited, "unknownFieldCount": unknown, "riskFieldCount": risky_count, "edgeSegmentCount": len(edges)}
    if not isinstance(summary, dict) or set(summary) != set(expected_summary) or any(type(summary.get(key)) is not int or summary.get(key) != value for key, value in expected_summary.items()) or unchanged+edited+unknown != len(rows)*6: _trade_fail("Review summary does not match reviewed fields.")
    for edge in edges:
        if not isinstance(edge, dict) or "fields" in edge or edge.get("captureId") not in capture_ids: _trade_fail()
    plan = payload["cropPlan"]
    if not isinstance(plan, dict) or set(plan) != {"policy", "entries"} or plan.get("policy") != "C2_REVIEW_VALUE_SUBSET_V1" or not isinstance(plan.get("entries"), list) or len(plan["entries"]) != len(rows)*6: _trade_fail()
    expected_plan = {(r["projectionRowId"], f["field"]): f for r in rows for f in r["fields"]}
    seen = set()
    for entry in plan["entries"]:
        if not isinstance(entry, dict) or set(entry) != {"projectionRowId", "field", "selected", "selectionReasons", "geometry", "readerCropHash", "skipReason"}: _trade_fail()
        key = (entry["projectionRowId"], entry["field"])
        if key not in expected_plan or key in seen: _trade_fail()
        seen.add(key); field = expected_plan[key]
        risky = bool(field["riskReasons"]) or field["projectionStatus"] in {"AMBIGUOUS", "UNMATCHED", "MASTER_DISAGREEMENT"}
        reasons = ([] if field["verificationMethod"] not in {"USER_EDITED", "USER_MARKED_UNKNOWN"} else ["USER_EDITED" if field["verificationMethod"] == "USER_EDITED" else "USER_MARKED_UNKNOWN"]) + (["RISKY_FIELD"] if risky else [])
        if type(entry["selected"]) is not bool or entry["selected"] != bool(reasons) or entry["selectionReasons"] != reasons: _trade_fail()
        if entry["readerCropHash"] is not None and (not isinstance(entry["readerCropHash"], str) or not re.fullmatch(r"[0-9a-f]{64}", entry["readerCropHash"])): _trade_fail()
        projected_row = next(candidate for candidate in proj_rows if candidate["projectionRowId"] == key[0])
        projected_field = projected_row["fields"][key[1]]
        expected_reader_hash = projected_field.get("rawEvidence", {}).get("readerEvidence", {}).get("cropHash")
        if entry["readerCropHash"] != expected_reader_hash: _trade_fail()
        reader_box = projected_field.get("rawEvidence", {}).get("readerEvidence", {}).get("geometry", {}).get("box")
        row_box = projected_row.get("rowBox")
        expected_geometry = None
        if isinstance(reader_box, dict) and isinstance(row_box, dict):
            coordinates = [reader_box.get(k) for k in ("x", "y", "width", "height")] + [row_box.get(k) for k in ("x", "y", "width", "height")]
            if (all(type(number) is int for number in coordinates) and reader_box["x"] >= 0 and reader_box["y"] >= 0
                    and reader_box["width"] > 0 and reader_box["height"] > 0 and row_box["x"] >= 0 and row_box["y"] >= 0
                    and reader_box["x"] + reader_box["width"] <= row_box["width"] and reader_box["y"] + reader_box["height"] <= row_box["height"]
                    and reader_box["width"] <= 1024 and reader_box["height"] <= 256 and reader_box["width"] * reader_box["height"] <= 262144):
                expected_geometry = {"source": "CAPTURE_BITMAP_PIXELS", "captureId": projected_row["captureId"],
                    "x": row_box["x"] + reader_box["x"], "y": row_box["y"] + reader_box["y"], "width": reader_box["width"], "height": reader_box["height"]}
        if not _same_trade_json(entry["geometry"], expected_geometry): _trade_fail("Crop geometry does not match stored source evidence.")
        if entry["geometry"] is None:
            if entry["skipReason"] != ("NOT_SELECTED" if not entry["selected"] else "GEOMETRY_UNAVAILABLE"): _trade_fail()
        else:
            geo = entry["geometry"]
            selected_skip = None if entry["selected"] else "NOT_SELECTED"
            capture_record = next((c for c in captures if c["captureId"] == geo.get("captureId")), None)
            if capture_record is None: _trade_fail()
            frame = capture_record["metadata"].get("frame", {})
            if entry["skipReason"] != selected_skip or set(geo) != {"source", "captureId", "x", "y", "width", "height"} or geo.get("source") != "CAPTURE_BITMAP_PIXELS" or geo.get("captureId") != projected_row["captureId"] or any(type(geo.get(k)) is not int for k in ("x","y","width","height")) or geo["x"]<0 or geo["y"]<0 or geo["width"]<1 or geo["height"]<1 or geo["x"]+geo["width"]>frame.get("width",0) or geo["y"]+geo["height"]>frame.get("height",0): _trade_fail()
    return payload


def validate_trade_crop_metadata(value: dict[str, Any], png_bytes: bytes) -> dict[str, Any]:
    import hashlib
    required = {"version", "cropMutationId", "projectionRowId", "field", "sha256", "width", "height"}
    if set(value) != required or type(value.get("version")) is not int or value["version"] != 1: _trade_fail()
    try:
        if str(uuid.UUID(value["cropMutationId"])) != value["cropMutationId"]: _trade_fail()
    except (ValueError, TypeError, AttributeError): _trade_fail()
    if not isinstance(value.get("projectionRowId"), str) or not value["projectionRowId"] or value.get("field") not in TRADE_FIELDS: _trade_fail()
    if len(png_bytes) > MAX_TRADE_CROP_BYTES: raise RecognitionContractError("crop_too_large", "The crop exceeds the allowed size.", 413)
    if hashlib.sha256(png_bytes).hexdigest() != value.get("sha256"): _trade_fail("Crop SHA-256 does not match its bytes.")
    if type(value.get("width")) is not int or type(value.get("height")) is not int or not (1 <= value["width"] <= 1024 and 1 <= value["height"] <= 256 and value["width"]*value["height"] <= 262144): _trade_fail()
    try:
        if not png_bytes.startswith(b"\x89PNG\r\n\x1a\n"): _trade_fail("Crop must be a PNG image.")
        offset = 8
        while offset + 12 <= len(png_bytes):
            length = int.from_bytes(png_bytes[offset:offset+4], "big")
            chunk = png_bytes[offset+4:offset+8]
            end = offset + 12 + length
            if end > len(png_bytes): _trade_fail("The PNG crop is truncated.")
            if chunk in {b"tEXt", b"iTXt", b"zTXt", b"eXIf"}: _trade_fail("PNG text and EXIF metadata are not accepted.")
            offset = end
            if chunk == b"IEND": break
        image = Image.open(BytesIO(png_bytes))
        if image.format != "PNG" or getattr(image, "n_frames", 1) != 1 or image.size != (value["width"], value["height"]): _trade_fail("Only plain, single-frame PNG crops are accepted.")
        image.verify()
    except (UnidentifiedImageError, OSError, ValueError): _trade_fail("The crop is not a valid PNG image.")
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
