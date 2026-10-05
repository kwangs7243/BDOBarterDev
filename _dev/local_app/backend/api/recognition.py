"""Live trade recognition and explicitly corrected samples only."""
import json
import uuid
from flask import Blueprint, current_app, jsonify, request
from ..recognition_contracts import RecognitionContractError, parse_json, validate_capture_payload
from ..services.trade_batch_runtime import MAX_BATCH_BYTES, MAX_CAPTURES, TradeBatchRuntimeError
recognition_api = Blueprint('recognition_api', __name__, url_prefix='/api/recognition')
MAX_JSON_BYTES = 64 * 1024

def _error(code: str, message: str, status: int, *, retryable: bool = False, **extra):
    return jsonify({"ok": False, **extra,
                    "error": {"code": code, "message": message, "retryable": retryable}}), status


@recognition_api.errorhandler(RecognitionContractError)
def handle_recognition_contract_error(error: RecognitionContractError):
    return _error(error.code, str(error), error.status)


@recognition_api.get("/trade-runtime")
def get_trade_runtime():
    runtime = current_app.extensions.get("trade_batch_runtime")
    if runtime is None:
        return jsonify({"ok": True, "runtime": {"available": False, "engineId": "paddle-korean-ppocrv5-mobile-onnx-cpu-v1",
                                                  "modelReady": False, "reason": "python_missing",
                                                  "mode": "LOCAL_DEVELOPMENT_RUNTIME_ONLY"}})
    return jsonify({"ok": True, "runtime": runtime.status()})


@recognition_api.post("/trade-live-list")
def post_trade_live_list():
    if request.mimetype != "multipart/form-data":
        return _error("invalid_batch", "Batch requests must use multipart/form-data.", 415)
    if set(request.form.keys()) != {"batch"} or len(request.form.getlist("batch")) != 1:
        return _error("invalid_capture_parts", "Exactly one batch field and one or more image parts are required.", 422)
    if set(request.files.keys()) != {"image"}:
        return _error("invalid_capture_parts", "Exactly one batch field and one or more image parts are required.", 422)
    uploads = request.files.getlist("image")
    if not uploads or len(uploads) > MAX_CAPTURES:
        return _error("invalid_batch", "A batch must contain between 1 and 100 captures.", 422)
    try:
        batch = parse_json(request.form.getlist("batch")[0], max_bytes=MAX_JSON_BYTES, label="batch")
    except RecognitionContractError:
        raise
    if (set(batch) != {"version", "batchId", "captures"} or type(batch.get("version")) is not int
            or batch["version"] != 1):
        return _error("invalid_batch", "The batch contract is invalid.", 422)
    try:
        batch_id = str(uuid.UUID(batch.get("batchId", "")))
    except (ValueError, TypeError, AttributeError):
        return _error("invalid_batch", "batchId must be a UUID.", 422)
    raw_captures = _read_captures(batch.get("captures"), uploads)

    runtime = current_app.extensions.get("trade_batch_runtime")
    if runtime is None:
        return _error("engine_unavailable", "The local recognition engine is unavailable.", 503)
    try:
        result = runtime.recognize_live(batch_id, raw_captures)
    except TradeBatchRuntimeError as error:
        return _error(error.code, str(error), error.status, retryable=error.retryable,
                      diagnostics={"stage": "OCR_RUNTIME"})
    current_app.extensions["bdo_storage"].record_trade_corrections({
        "version": 2, "feedbackId": str(uuid.uuid4()), "engineId": result["runtime"]["engineId"],
        "modelVersion": result["runtime"]["modelBundleSha256"], "workerVersion": result["runtime"]["workerVersion"],
        "corrections": [], "snapshot": {"phase": "recognized", "result": result}}, raw_captures)
    return jsonify({"ok": True, "result": result})


def _read_captures(descriptors, uploads):
    if not isinstance(descriptors, list) or not 1 <= len(descriptors) <= MAX_CAPTURES or len(descriptors) != len(uploads):
        raise RecognitionContractError("invalid_capture_parts", "Capture metadata count must match the image part count.", 422)

    seen: set[str] = set()
    raw_captures = []
    total_bytes = 0
    for descriptor, upload in zip(descriptors, uploads, strict=True):
        expected_descriptor_keys = {"captureId", "metadata"}
        if not isinstance(descriptor, dict) or set(descriptor) != expected_descriptor_keys:
            raise RecognitionContractError("invalid_batch", "Each capture descriptor does not match its batch version.", 422)
        if not isinstance(descriptor["metadata"], dict):
            raise RecognitionContractError("invalid_batch", "Capture metadata must be an object.", 422)
        try:
            wrapper_id = str(uuid.UUID(descriptor["captureId"]))
        except (ValueError, TypeError, AttributeError):
            raise RecognitionContractError("invalid_batch", "Each captureId must be a UUID.", 422)
        if wrapper_id in seen:
            raise RecognitionContractError("duplicate_capture_id", "Capture IDs must be unique within a batch.", 422)
        seen.add(wrapper_id)
        image_bytes = upload.stream.read(MAX_BATCH_BYTES + 1)
        total_bytes += len(image_bytes)
        if len(image_bytes) > MAX_BATCH_BYTES or total_bytes > MAX_BATCH_BYTES:
            raise RecognitionContractError("image_too_large", "Uploaded PNG data exceeds the 20 MiB batch limit.", 413)
        metadata_raw = json.dumps(descriptor["metadata"], ensure_ascii=False, separators=(",", ":"))
        try:
            metadata, _width, _height = validate_capture_payload(
                metadata_raw, image_bytes, content_type=upload.content_type or "", expected_task="trade")
        except RecognitionContractError:
            raise
        if metadata["captureId"] != wrapper_id:
            raise RecognitionContractError("invalid_batch", "Wrapper and metadata capture IDs must match.", 422)
        raw_capture = {"captureId": wrapper_id, "metadata": metadata, "imageBytes": image_bytes}
        raw_captures.append(raw_capture)

    return raw_captures

@recognition_api.post("/trade-corrections")
def post_trade_corrections():
    from ..recognition_contracts import validate_trade_corrections
    if (request.mimetype != "multipart/form-data" or set(request.form) != {"feedback"}
            or len(request.form.getlist("feedback")) != 1 or set(request.files) != {"image"}):
        return _error("invalid_feedback", "Correction feedback requires metadata and PNG parts.", 422)
    feedback = parse_json(request.form["feedback"], max_bytes=2 * 1024 * 1024, label="feedback")
    captures = _read_captures(feedback.get("captures"), request.files.getlist("image"))
    validate_trade_corrections(feedback, captures)
    created = current_app.extensions["bdo_storage"].record_trade_corrections(feedback, captures)
    return jsonify({"ok": True, "created": created})
