"""Same-origin API skeleton for the isolated recognition sidecar."""
from __future__ import annotations

import json
import uuid

from flask import Blueprint, current_app, jsonify, request
from werkzeug.exceptions import BadRequest, RequestEntityTooLarge

from ..recognition_contracts import (
    MAX_IMAGE_BYTES,
    RecognitionContractError,
    parse_json,
    validate_capture_payload,
    validate_config_update,
    validate_feedback_payload,
)
from ..recognition_store import (
    ConfigConflictError,
    MutationConflictError,
    ProfileUnavailableError,
    RecognitionStoreError,
    RunNotFoundError,
    sha256_bytes,
)
from ..services.trade_batch_runtime import (
    MAX_BATCH_BYTES, MAX_CAPTURES, TradeBatchRuntimeError,
)


recognition_api = Blueprint("recognition_api", __name__, url_prefix="/api/recognition")
MAX_JSON_BYTES = 64 * 1024


def _error(code: str, message: str, status: int, *, retryable: bool = False, **extra):
    return jsonify({"ok": False, **extra,
                    "error": {"code": code, "message": message, "retryable": retryable}}), status


def _store():
    store = current_app.extensions.get("recognition_store")
    if store is None:
        raise RecognitionStoreError("recognition sidecar is unavailable")
    return store


def _json_body() -> dict:
    if request.mimetype != "application/json":
        raise RecognitionContractError("unsupported_media_type", "Content-Type must be application/json.", 415)
    charset = request.mimetype_params.get("charset")
    if charset and charset.lower().replace("_", "-") not in {"utf-8", "utf8"}:
        raise RecognitionContractError("unsupported_media_type", "JSON must use UTF-8.", 415)
    raw = request.get_data(cache=True)
    return parse_json(raw, max_bytes=MAX_JSON_BYTES, label="request body")


@recognition_api.errorhandler(RecognitionContractError)
def handle_recognition_contract_error(error: RecognitionContractError):
    return _error(error.code, str(error), error.status)


@recognition_api.errorhandler(BadRequest)
def handle_recognition_bad_request(_error_value):
    return _error("invalid_json", "A valid JSON request body is required.", 400)


@recognition_api.errorhandler(RequestEntityTooLarge)
def handle_recognition_too_large(_error_value):
    return _error("request_too_large", "The request exceeds the allowed size.", 413)


@recognition_api.errorhandler(RecognitionStoreError)
def handle_recognition_store_error(error: RecognitionStoreError):
    if isinstance(error, ConfigConflictError):
        return _error("config_conflict", "Recognition configuration changed; reload it before retrying.", 409)
    if isinstance(error, MutationConflictError):
        return _error("idempotency_conflict", "The request ID was already used with different content.", 409)
    if isinstance(error, RunNotFoundError):
        return _error("recognition_not_found", "The recognition run is unavailable.", 404)
    if isinstance(error, ProfileUnavailableError):
        return _error("profile_unavailable", "The requested profile version is unavailable.", 422)
    return _error("evidence_store_unavailable", "Recognition evidence could not be stored.", 503, retryable=True)


@recognition_api.get("/config")
def get_config():
    return jsonify({"ok": True, "config": _store().get_config()})


@recognition_api.put("/config")
def put_config():
    payload = validate_config_update(_json_body())
    config = _store().update_config(payload["expectedConfigRevision"], payload["flags"], payload["profiles"])
    return jsonify({"ok": True, "config": config})


def _capture(task_type: str):
    if request.mimetype != "multipart/form-data":
        return _error("unsupported_media_type", "Capture requests must use multipart/form-data.", 415)
    if set(request.form.keys()) != {"metadata"} or len(request.form.getlist("metadata")) != 1:
        return _error("invalid_capture_parts", "Exactly one metadata field and one image part are required.", 422)
    if set(request.files.keys()) != {"image"} or len(request.files.getlist("image")) != 1:
        return _error("invalid_capture_parts", "Exactly one metadata field and one image part are required.", 422)
    upload = request.files.getlist("image")[0]
    image_bytes = upload.stream.read(MAX_IMAGE_BYTES + 1)
    metadata, _width, _height = validate_capture_payload(
        request.form.getlist("metadata")[0], image_bytes,
        content_type=upload.content_type or "", expected_task=task_type)
    if len(image_bytes) > MAX_IMAGE_BYTES:
        return _error("image_too_large", "The PNG image exceeds the allowed size.", 413)
    # The V2 engines do not exist in T002. Keep a metadata/hash-only unsupported run;
    # never imply that an image was recognized or retain the uploaded frame by default.
    run, created = _store().create_run(
        metadata, input_hash=sha256_bytes(image_bytes),
    )
    return _error("unsupported_feature", "Recognition engines are not implemented in this task.", 501,
                  recognitionId=run["recognitionId"], duplicate=not created)


@recognition_api.post("/warehouse")
def post_warehouse_capture():
    return _capture("warehouse")


@recognition_api.post("/trade")
def post_trade_capture():
    return _capture("trade")


@recognition_api.get("/trade-runtime")
def get_trade_runtime():
    runtime = current_app.extensions.get("trade_batch_runtime")
    if runtime is None:
        return jsonify({"ok": True, "runtime": {"available": False, "engineId": "paddle-korean-ppocrv5-mobile-onnx-cpu-v1",
                                                  "modelReady": False, "reason": "python_missing",
                                                  "mode": "LOCAL_DEVELOPMENT_RUNTIME_ONLY"}})
    return jsonify({"ok": True, "runtime": runtime.status()})


@recognition_api.post("/trade-batch")
def post_trade_batch():
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
    if set(batch) != {"version", "batchId", "captures"} or type(batch.get("version")) is not int or batch["version"] != 1:
        return _error("invalid_batch", "The batch contract is invalid.", 422)
    try:
        batch_id = str(uuid.UUID(batch.get("batchId", "")))
    except (ValueError, TypeError, AttributeError):
        return _error("invalid_batch", "batchId must be a UUID.", 422)
    descriptors = batch.get("captures")
    if not isinstance(descriptors, list) or not 1 <= len(descriptors) <= MAX_CAPTURES or len(descriptors) != len(uploads):
        return _error("invalid_capture_parts", "Capture metadata count must match the image part count.", 422)

    seen: set[str] = set()
    raw_captures = []
    total_bytes = 0
    for descriptor, upload in zip(descriptors, uploads, strict=True):
        if not isinstance(descriptor, dict) or set(descriptor) != {"captureId", "metadata"}:
            return _error("invalid_batch", "Each capture requires captureId and metadata.", 422)
        if not isinstance(descriptor["metadata"], dict):
            return _error("invalid_batch", "Capture metadata must be an object.", 422)
        try:
            wrapper_id = str(uuid.UUID(descriptor["captureId"]))
        except (ValueError, TypeError, AttributeError):
            return _error("invalid_batch", "Each captureId must be a UUID.", 422)
        if wrapper_id in seen:
            return _error("duplicate_capture_id", "Capture IDs must be unique within a batch.", 422)
        seen.add(wrapper_id)
        image_bytes = upload.stream.read(MAX_BATCH_BYTES + 1)
        total_bytes += len(image_bytes)
        if len(image_bytes) > MAX_BATCH_BYTES or total_bytes > MAX_BATCH_BYTES:
            return _error("image_too_large", "Uploaded PNG data exceeds the 20 MiB batch limit.", 413)
        metadata_raw = json.dumps(descriptor["metadata"], ensure_ascii=False, separators=(",", ":"))
        try:
            metadata, _width, _height = validate_capture_payload(
                metadata_raw, image_bytes, content_type=upload.content_type or "", expected_task="trade")
        except RecognitionContractError as error:
            code = "invalid_image" if error.code == "unsupported_media_type" else error.code
            status = 415 if error.code == "unsupported_media_type" else error.status
            return _error(code, str(error), status)
        if metadata["captureId"] != wrapper_id:
            return _error("invalid_batch", "Wrapper and metadata capture IDs must match.", 422)
        raw_captures.append({"captureId": wrapper_id, "metadata": metadata, "imageBytes": image_bytes})

    runtime = current_app.extensions.get("trade_batch_runtime")
    if runtime is None:
        return _error("engine_unavailable", "The local recognition engine is unavailable.", 503)
    try:
        result = runtime.recognize(batch_id, raw_captures)
    except TradeBatchRuntimeError as error:
        return _error(error.code, str(error), error.status, retryable=error.retryable)
    return jsonify({"ok": True, "result": {
        "version": 1, "batchId": batch_id, "status": "DRAFT_UNVERIFIED",
        "captures": result["captures"], "draftRows": result["draftRows"],
        "metrics": {**result.get("metrics", {}), "captureCount": len(raw_captures),
                     "draftRowCount": len(result["draftRows"]), "countMeaning": "remainingExchangeCount"},
        "runtime": result["runtime"],
        "approval": {"production": False, "HIGH": 0, "importerIntegration": False,
                     "automationDecision": "REVIEW"},
    }})


@recognition_api.get("/<recognition_id>")
def get_run(recognition_id: str):
    run = _store().get_run(recognition_id)
    if run is None:
        return _error("recognition_not_found", "The recognition run is unavailable.", 404)
    return jsonify({"ok": True, "run": run})


@recognition_api.post("/<recognition_id>/feedback")
def post_feedback(recognition_id: str):
    payload = validate_feedback_payload(_json_body())
    result, duplicate = _store().write_labels(recognition_id, payload)
    return jsonify({**result, "duplicate": duplicate})


@recognition_api.post("/<recognition_id>/apply")
def post_apply(recognition_id: str):
    # T002 lays down the guarded route only; no recognition proposal can mutate main state.
    _json_body()
    return _error("unsupported_feature", "Recognition apply is disabled until a reviewed engine policy exists.", 501)


@recognition_api.post("/native-capture")
def post_native_capture():
    return _error("unsupported_feature", "Native capture is not supported.", 501)


@recognition_api.post("/remote-fallback")
def post_remote_fallback():
    return _error("unsupported_feature", "Remote recognition fallback is not supported.", 501)
