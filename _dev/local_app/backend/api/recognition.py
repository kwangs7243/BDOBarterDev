"""Same-origin API skeleton for the isolated recognition sidecar."""
from __future__ import annotations

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
