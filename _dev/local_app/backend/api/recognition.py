"""Same-origin API skeleton for the isolated recognition sidecar."""
from __future__ import annotations

import json
import uuid

from flask import Blueprint, Response, current_app, jsonify, request
from werkzeug.exceptions import BadRequest, RequestEntityTooLarge

from ..recognition_contracts import (
    MAX_IMAGE_BYTES,
    RecognitionContractError,
    parse_json,
    validate_capture_payload,
    validate_config_update,
    validate_feedback_payload,
    validate_trade_review_observation,
    validate_trade_crop_metadata,
    validate_final_review_observation,
    validate_trade_crop_metadata_v3,
    validate_crop_truth_label_request,
    MAX_TRADE_OBSERVATION_BYTES,
    MAX_TRADE_CROP_BYTES,
)
from ..recognition_store import (
    ConfigConflictError,
    MutationConflictError,
    ProfileUnavailableError,
    RecognitionStoreError,
    RunNotFoundError,
    sha256_bytes,
    _ArtifactBudgetExceeded,
    EvidenceIntegrityError,
    CropLinkConflictError,
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


def _trade_observation_body() -> dict:
    if request.mimetype != "application/json":
        raise RecognitionContractError("unsupported_media_type", "Content-Type must be application/json.", 415)
    if request.headers.get("Content-Encoding", "identity").lower() not in {"", "identity"}:
        raise RecognitionContractError("unsupported_media_type", "Compressed JSON is not supported.", 415)
    charset = request.mimetype_params.get("charset")
    if charset and charset.lower().replace("_", "-") not in {"utf-8", "utf8"}:
        raise RecognitionContractError("unsupported_media_type", "JSON must use UTF-8.", 415)
    if request.content_length is not None and request.content_length > MAX_TRADE_OBSERVATION_BYTES:
        raise RecognitionContractError("request_too_large", "The observation exceeds 8 MiB.", 413)
    raw = request.stream.read(MAX_TRADE_OBSERVATION_BYTES + 1)
    if len(raw) > MAX_TRADE_OBSERVATION_BYTES:
        raise RecognitionContractError("request_too_large", "The observation exceeds 8 MiB.", 413)
    return parse_json(raw, max_bytes=MAX_TRADE_OBSERVATION_BYTES, label="observation", reject_negative_zero=True)


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
    if isinstance(error, EvidenceIntegrityError):
        return _error("evidence_integrity_error", "Stored evidence failed integrity verification.", 500)
    if isinstance(error, ConfigConflictError):
        return _error("config_conflict", "Recognition configuration changed; reload it before retrying.", 409)
    if isinstance(error, CropLinkConflictError):
        return _error("crop_link_conflict", "This review field already has a different crop attached.", 409)
    if isinstance(error, MutationConflictError):
        return _error("idempotency_conflict", "The request ID was already used with different content.", 409)
    if isinstance(error, RunNotFoundError):
        return _error("recognition_not_found", "The recognition run is unavailable.", 404)
    if isinstance(error, ProfileUnavailableError):
        return _error("profile_unavailable", "The requested profile version is unavailable.", 422)
    if isinstance(error, _ArtifactBudgetExceeded):
        return _error("evidence_budget_exceeded", "Evidence storage is full. Export or explicitly clean up evidence before retrying.", 507)
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


TRADE_OBSERVATION_PREFIX = "/trade-review-observations"


@recognition_api.post(TRADE_OBSERVATION_PREFIX)
def post_trade_review_observation():
    body = _trade_observation_body()
    if body.get("schemaVersion") == 3 and body.get("reviewMode") == "FINAL_CORRECTED_RESULT":
        payload = validate_final_review_observation(body)
        receipt, duplicate = _store().create_final_review_observation(payload)
    elif body.get("schemaVersion") == 1 and body.get("completion", {}).get("reviewMode") == "REVIEW_FIRST":
        payload = validate_trade_review_observation(body)
        receipt, duplicate = _store().create_trade_review_observation(payload)
    else:
        raise RecognitionContractError("invalid_contract", "Observation version and review mode are unsupported.", 422)
    status = 200 if duplicate else 201
    response = jsonify({"ok": True, "receipt": {**receipt, "duplicate": duplicate}})
    response.headers["Cache-Control"] = "no-store"
    return response, status


@recognition_api.get(TRADE_OBSERVATION_PREFIX + "/<observation_id>")
def get_trade_review_observation(observation_id: str):
    observation = _store().get_trade_review_observation(observation_id)
    if observation is None: return _error("observation_not_found", "The observation is unavailable.", 404)
    requested_version = request.args.get("schemaVersion")
    if requested_version is not None and requested_version != str(observation.get("schemaVersion")):
        return _error("observation_not_found", "The observation is unavailable.", 404)
    response = jsonify({"ok": True, "observation": observation,
                        "cropEvidence": _store().get_trade_review_crop_evidence(observation_id)})
    response.headers["Cache-Control"] = "no-store"
    return response


@recognition_api.get(TRADE_OBSERVATION_PREFIX + "/<observation_id>/export")
def export_trade_review_observation(observation_id: str):
    exported = _store().export_trade_review_observation(observation_id)
    if exported is None: return _error("observation_not_found", "The observation is unavailable.", 404)
    requested_version = request.args.get("schemaVersion")
    if requested_version is not None and requested_version != str(exported.get("schemaVersion")):
        return _error("observation_not_found", "The observation is unavailable.", 404)
    body = json.dumps(exported, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(body) > 32 * 1024 * 1024: return _error("export_too_large", "The observation export exceeds 32 MiB.", 413)
    return Response(body, mimetype="application/json; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="trade-review-{observation_id}.json"', "Cache-Control": "no-store"})


@recognition_api.post(TRADE_OBSERVATION_PREFIX + "/<observation_id>/crops")
def post_trade_review_crop(observation_id: str):
    if request.headers.get("Content-Encoding", "identity").lower() not in {"", "identity"}:
        return _error("unsupported_media_type", "Compressed crop uploads are not supported.", 415)
    if request.mimetype != "multipart/form-data": return _error("unsupported_media_type", "Crop upload must use multipart/form-data.", 415)
    if set(request.form.keys()) != {"metadata"} or len(request.form.getlist("metadata")) != 1 or set(request.files.keys()) != {"image"} or len(request.files.getlist("image")) != 1:
        return _error("invalid_crop_parts", "Exactly one metadata field and one image part are required.", 422)
    raw_metadata = request.form.getlist("metadata")[0]
    metadata = parse_json(raw_metadata, max_bytes=4096, label="crop metadata")
    upload = request.files.getlist("image")[0]
    data = upload.stream.read(MAX_TRADE_CROP_BYTES + 1)
    if (upload.content_type or "").lower() != "image/png": return _error("invalid_crop", "Crop content type must be image/png.", 422)
    stored = _store().get_trade_review_observation(observation_id)
    if stored is None: return _error("observation_not_found", "The observation is unavailable.", 404)
    if stored.get("schemaVersion") == 3:
        plan = next((entry for entry in stored["cropPlan"]["entries"] if entry.get("projectionRowId") == metadata.get("projectionRowId") and entry.get("field") == metadata.get("field")), None)
        crop_ref = next((crop for row in stored["sourceContext"]["rawEvidence"]["snapshot"]["sourceRows"] for field in row["fields"] for crop in field["cropRefs"] if plan and crop.get("cropRefId") == plan.get("cropRefId")), None)
        if crop_ref is None: raise RecognitionContractError("invalid_contract", "The crop source binding is unavailable.", 422)
        validated = validate_trade_crop_metadata_v3(metadata, data, crop_ref)
    else:
        validated = validate_trade_crop_metadata(metadata, data)
    receipt, duplicate = _store().attach_trade_review_crop(observation_id, validated, data)
    response = jsonify({"ok": True, "receipt": {**receipt, "duplicate": duplicate}})
    response.headers["Cache-Control"] = "no-store"
    return response, 200 if duplicate else 201


@recognition_api.get(TRADE_OBSERVATION_PREFIX + "/<observation_id>/export/crops/<digest>")
def get_trade_review_crop(observation_id: str, digest: str):
    import re
    if not re.fullmatch(r"[0-9a-f]{64}", digest): return _error("crop_not_found", "The crop is unavailable.", 404)
    state = _store().get_trade_crop_artifact_state(observation_id, digest)
    if state is None: return _error("crop_not_found", "The crop is unavailable.", 404)
    if state == "EXPIRED": return _error("crop_expired", "The crop retention period has ended.", 410)
    if state != "AVAILABLE": return _error("crop_not_found", "The crop is unavailable.", 404)
    path = _store().artifact_root / f"{digest}.png"
    try: data = path.read_bytes()
    except OSError: return _error("crop_not_found", "The crop is unavailable.", 404)
    if sha256_bytes(data) != digest: return _error("evidence_integrity_error", "Stored evidence failed integrity verification.", 500)
    return Response(data, mimetype="image/png", headers={"Content-Disposition": f'attachment; filename="{digest}.png"', "Cache-Control": "no-store"})


@recognition_api.post(TRADE_OBSERVATION_PREFIX + "/<observation_id>/truth-labels")
def post_trade_crop_truth_label(observation_id: str):
    if request.headers.get("Content-Encoding", "identity").lower() not in {"", "identity"}:
        return _error("unsupported_media_type", "Compressed truth uploads are not supported.", 415)
    if request.mimetype != "multipart/form-data" or set(request.form.keys()) != {"metadata"} or len(request.form.getlist("metadata")) != 1 or set(request.files) - {"image"}:
        return _error("invalid_truth_parts", "Truth labels require metadata and an optional PNG image.", 422)
    metadata = parse_json(request.form.getlist("metadata")[0], max_bytes=64 * 1024, label="truth label")
    observation = _store().get_trade_review_observation(observation_id)
    if observation is None or observation.get("schemaVersion") != 3: return _error("observation_not_found", "The v3 observation is unavailable.", 404)
    png = None
    if request.files.getlist("image"):
        if len(request.files.getlist("image")) != 1: return _error("invalid_truth_parts", "Exactly one PNG image is accepted.", 422)
        upload=request.files.getlist("image")[0]
        if (upload.content_type or "").lower()!="image/png": return _error("invalid_crop", "Truth crop content type must be image/png.", 422)
        png=upload.stream.read(MAX_TRADE_CROP_BYTES+1)
        if len(png)>MAX_TRADE_CROP_BYTES: return _error("crop_too_large", "The crop exceeds the allowed size.", 413)
    validate_crop_truth_label_request(metadata, observation, artifact_present=png is not None)
    if png is not None:
        import hashlib
        from io import BytesIO
        from PIL import Image, UnidentifiedImageError
        ref=next(c for row in observation["sourceContext"]["rawEvidence"]["snapshot"]["sourceRows"] for field in row["fields"] for c in field["cropRefs"] if c["cropRefId"]==metadata["cropRefId"])
        artifact=metadata["artifact"]
        try:
            image=Image.open(BytesIO(png))
            if image.format!="PNG" or getattr(image,"n_frames",1)!=1: raise ValueError("invalid PNG")
            image.load()
            if image.size!=(ref["box"]["width"],ref["box"]["height"]): raise ValueError("wrong dimensions")
            if "A" in image.getbands() and image.getchannel("A").getextrema()!=(255,255): raise ValueError("alpha is not opaque")
            pixel_hash=hashlib.sha256(image.convert("RGB").tobytes()).hexdigest()
            if pixel_hash!=ref["pixelSha256"] or hashlib.sha256(png).hexdigest()!=artifact["sha256"]: raise ValueError("hash mismatch")
        except (UnidentifiedImageError,OSError,ValueError):
            raise RecognitionContractError("invalid_crop", "Truth crop PNG does not match its pixel binding.", 422) from None
    receipt, duplicate=_store().create_crop_truth_label(observation_id,metadata,png)
    response=jsonify({"ok":True,"receipt":{**receipt,"duplicate":duplicate}})
    response.headers["Cache-Control"]="no-store"
    return response,200 if duplicate else 201


@recognition_api.get(TRADE_OBSERVATION_PREFIX + "/<observation_id>/truth-labels")
def get_trade_crop_truth_labels(observation_id: str):
    labels=_store().get_crop_truth_labels(observation_id)
    if labels is None: return _error("observation_not_found", "The v3 observation is unavailable.", 404)
    response=jsonify({"ok":True,"labels":labels})
    response.headers["Cache-Control"]="no-store"
    return response


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
    if set(batch) != {"version", "batchId", "captures"} or type(batch.get("version")) is not int or batch["version"] not in (1, 2):
        return _error("invalid_batch", "The batch contract is invalid.", 422)
    batch_version = batch["version"]
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
        expected_descriptor_keys = {"captureId", "metadata"} if batch_version == 1 else {"captureId", "metadata", "reencoded"}
        if not isinstance(descriptor, dict) or set(descriptor) != expected_descriptor_keys:
            return _error("invalid_batch", "Each capture descriptor does not match its batch version.", 422)
        if batch_version == 2 and type(descriptor.get("reencoded")) is not bool:
            return _error("invalid_batch", "Each v2 capture requires a boolean reencoded value.", 422)
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
            return _error(code, str(error), status, diagnostics={
                "stage": "SERVER_IMAGE_VALIDATE", "captureId": wrapper_id,
                "sourceType": descriptor["metadata"].get("sourceType") if isinstance(descriptor["metadata"], dict) else None,
                "blobType": upload.content_type, "blobSize": len(image_bytes),
                **(error.details or {}),
            })
        if metadata["captureId"] != wrapper_id:
            return _error("invalid_batch", "Wrapper and metadata capture IDs must match.", 422)
        raw_capture = {"captureId": wrapper_id, "metadata": metadata, "imageBytes": image_bytes}
        if batch_version == 2:
            raw_capture["reencoded"] = descriptor["reencoded"]
        raw_captures.append(raw_capture)

    runtime = current_app.extensions.get("trade_batch_runtime")
    if runtime is None:
        return _error("engine_unavailable", "The local recognition engine is unavailable.", 503)
    try:
        if batch_version == 1:
            result = runtime.recognize(batch_id, raw_captures)
        else:
            result = runtime.recognize_raw_v2(batch_id, raw_captures)
    except TradeBatchRuntimeError as error:
        return _error(error.code, str(error), error.status, retryable=error.retryable,
                      diagnostics={"stage": "OCR_RUNTIME"})
    if batch_version == 2:
        raw_evidence = result.get("rawEvidence") if isinstance(result, dict) else None
        runtime_metadata = result.get("runtime") if isinstance(result, dict) else None
        if (not isinstance(raw_evidence, dict) or raw_evidence.get("recognitionBatchId") != batch_id
                or not isinstance(runtime_metadata, dict)):
            return _error("recognition_worker_failed", "Local recognition returned an invalid raw evidence result.", 502)
        return jsonify({"ok": True, "result": {
            "version": 2, "batchId": batch_id, "status": "RAW_EVIDENCE_ONLY",
            "rawEvidence": raw_evidence, "runtime": runtime_metadata,
        }})
    return jsonify({"ok": True, "result": {
        "version": 1, "batchId": batch_id, "status": "DRAFT_UNVERIFIED",
        "captures": result["captures"], "draftRows": result["draftRows"],
        "edgeSegments": result["edgeSegments"],
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
