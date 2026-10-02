"""Owner-confirmed HTTP boundary for immutable Master Bundle v2 storage."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sqlite3
import uuid

from flask import Blueprint, Response, current_app, jsonify, request

from ..master_store import (
    InvalidMasterBundle,
    MasterMutationConflict,
    MasterRevisionConflict,
    MasterStoreError,
    validate_reference_bundle_against_manifest,
    validate_reference_manifest,
    validate_master_bundle,
)

master_api = Blueprint("master_api", __name__, url_prefix="/api/master")
MAX_MASTER_JSON_BYTES = 2 * 1024 * 1024
_NO_CACHE = {"Cache-Control": "no-store"}


def _error(code: str, message: str, status: int):
    return jsonify({"ok": False, "error": {"code": code, "message": message}}), status, _NO_CACHE


def _store():
    store = current_app.extensions.get("master_store")
    if store is None:
        return None
    return store


def _approved_reference_manifest():
    manifest_path = current_app.config.get("MASTER_REFERENCE_MANIFEST_PATH")
    if manifest_path is None:
        manifest_path = Path(__file__).resolve().parents[2] / "frontend" / "data" / "trade-master-reference-manifest.json"
    manifest_path = Path(manifest_path).resolve()
    catalog_path = current_app.config.get("MASTER_REFERENCE_CATALOG_PATH")
    if catalog_path is None:
        catalog_path = manifest_path.parent / "trade-catalog.json"
    catalog_bytes = Path(catalog_path).read_bytes()
    catalog_hash = hashlib.sha256(catalog_bytes).hexdigest()
    raw = manifest_path.read_bytes()
    if len(raw) > MAX_MASTER_JSON_BYTES:
        raise InvalidMasterBundle("approved reference manifest exceeds configured size limit")
    try:
        manifest = json.loads(raw.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InvalidMasterBundle("approved reference manifest is not valid UTF-8 JSON") from error
    return validate_reference_manifest(manifest, expected_catalog_sha256=catalog_hash)


def _validate_reference_authority(bundle):
    if not any(entity.get("status") == "VERIFIED_REFERENCE" for entity in bundle.get("entities", [])):
        return
    validate_reference_bundle_against_manifest(bundle, _approved_reference_manifest())


def _body():
    if request.mimetype != "application/json":
        return None, _error("unsupported_media_type", "Content-Type must be application/json.", 415)
    charset = request.mimetype_params.get("charset")
    if charset and charset.lower().replace("_", "-") not in {"utf-8", "utf8"}:
        return None, _error("unsupported_media_type", "Master JSON must use UTF-8.", 415)
    if request.headers.get("Content-Encoding", "identity").lower() not in {"", "identity"}:
        return None, _error("unsupported_media_type", "Compressed Master JSON is not supported.", 415)
    if request.content_length is not None and request.content_length > MAX_MASTER_JSON_BYTES:
        return None, _error("request_too_large", "Master JSON exceeds 2 MiB.", 413)
    raw = request.stream.read(MAX_MASTER_JSON_BYTES + 1)
    if len(raw) > MAX_MASTER_JSON_BYTES:
        return None, _error("request_too_large", "Master JSON exceeds 2 MiB.", 413)
    try:
        text = raw.decode("utf-8", errors="strict")

        def unique_object(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError(f"duplicate JSON key: {key}")
                result[key] = value
            return result

        def reject_number(_value):
            raise ValueError("Master JSON accepts integers only")

        body = json.loads(text, object_pairs_hook=unique_object, parse_float=reject_number,
                          parse_constant=reject_number)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        return None, _error("invalid_json", f"Invalid UTF-8 JSON: {error}", 400)
    if not isinstance(body, dict):
        return None, _error("invalid_master_request", "Request body must be a JSON object.", 422)
    return body, None


def _expected(value):
    return value is None or (isinstance(value, str) and bool(value.strip()))


def _proposal_hash(expected_registry_version, bundle):
    basis = {
        "version": 1,
        "expectedRegistryVersion": expected_registry_version,
        "registryVersion": bundle["registryVersion"],
        "contentHash": bundle["contentHash"],
    }
    payload = json.dumps(basis, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return "master-proposal-v1:" + hashlib.sha256(payload.encode("utf-8", errors="strict")).hexdigest()


def _invalid_keys(body, expected):
    if set(body) != expected:
        return _error("invalid_master_request", "Request contains missing or unknown fields.", 422)
    return None


def _store_failure(error):
    if isinstance(error, MasterRevisionConflict):
        return _error("master_revision_conflict", "Master가 변경되었습니다. 다시 불러와 검수해 주세요.", 409)
    if isinstance(error, MasterMutationConflict):
        return _error("master_mutation_conflict", "같은 mutationId가 다른 요청 내용에 이미 사용되었습니다.", 409)
    if isinstance(error, InvalidMasterBundle):
        return _error("invalid_master_bundle", "Master bundle 검증에 실패했습니다.", 422)
    if isinstance(error, (MasterStoreError, sqlite3.Error, OSError)):
        return _error("master_store_unavailable", "Master 저장소를 사용할 수 없습니다.", 503)
    return _error("master_store_unavailable", "Master 저장소 요청을 처리하지 못했습니다.", 503)


@master_api.after_request
def prevent_master_caching(response):
    response.headers["Cache-Control"] = "no-store"
    return response


@master_api.get("/active")
def active_master():
    store = _store()
    if store is None:
        return _error("master_store_unavailable", "Master 저장소를 사용할 수 없습니다.", 503)
    try:
        return jsonify({"ok": True, "storeRevision": store.store_revision(),
                        "activeRegistryVersion": store.get_active_registry_version(),
                        "bundle": store.get_active_bundle()})
    except (MasterStoreError, sqlite3.Error, OSError) as error:
        return _store_failure(error)


@master_api.get("/bundles/<path:registry_version>/export")
def export_bundle(registry_version):
    store = _store()
    if store is None:
        return _error("master_store_unavailable", "Master 저장소를 사용할 수 없습니다.", 503)
    try:
        bundle = store.get_bundle(registry_version)
    except (MasterStoreError, sqlite3.Error, OSError) as error:
        return _store_failure(error)
    if bundle is None:
        return _error("master_bundle_not_found", "요청한 Master bundle이 없습니다.", 404)
    # MasterStore persists this exact canonical semantic JSON; sorting compactly
    # reproduces those bytes without adding an API envelope or changing content.
    payload = json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    response = Response(payload.encode("utf-8"), content_type="application/json; charset=utf-8")
    response.headers["Content-Disposition"] = f'attachment; filename="master-{registry_version.replace(":", "-")}.json"'
    return response


@master_api.get("/bundles/<registry_version>")
def get_bundle(registry_version):
    store = _store()
    if store is None:
        return _error("master_store_unavailable", "Master 저장소를 사용할 수 없습니다.", 503)
    try:
        bundle = store.get_bundle(registry_version)
    except (MasterStoreError, sqlite3.Error, OSError) as error:
        return _store_failure(error)
    if bundle is None:
        return _error("master_bundle_not_found", "요청한 Master bundle이 없습니다.", 404)
    return jsonify({"ok": True, "bundle": bundle})


@master_api.post("/proposal")
def propose_bundle():
    body, error = _body()
    if error:
        return error
    error = _invalid_keys(body, {"version", "expectedRegistryVersion", "bundle"})
    if error:
        return error
    if type(body["version"]) is not int or body["version"] != 1 or not _expected(body["expectedRegistryVersion"]):
        return _error("invalid_master_request", "Proposal version or expected registry is invalid.", 422)
    store = _store()
    if store is None:
        return _error("master_store_unavailable", "Master 저장소를 사용할 수 없습니다.", 503)
    try:
        bundle = validate_master_bundle(body["bundle"])
        _validate_reference_authority(bundle)
        active = store.get_active_registry_version()
        if active != body["expectedRegistryVersion"]:
            raise MasterRevisionConflict("proposal base is stale")
        proposal_hash = _proposal_hash(active, bundle)
        return jsonify({"ok": True, "proposal": {"version": 1, "proposalHash": proposal_hash,
                        "expectedRegistryVersion": active, "registryVersion": bundle["registryVersion"],
                        "contentHash": bundle["contentHash"], "entityCount": len(bundle["entities"]),
                        "unresolvedCount": len(bundle["unresolvedLegacyNames"])}})
    except (MasterRevisionConflict, InvalidMasterBundle, MasterStoreError, sqlite3.Error, OSError) as failure:
        return _store_failure(failure)


@master_api.post("/publish")
def publish_bundle():
    body, error = _body()
    if error:
        return error
    error = _invalid_keys(body, {"version", "mutationId", "expectedRegistryVersion", "ownerApproved", "proposalHash", "bundle"})
    if error:
        return error
    mutation_id = body["mutationId"]
    try:
        if not isinstance(mutation_id, str) or str(uuid.UUID(mutation_id)) != mutation_id:
            raise ValueError
    except (ValueError, AttributeError, TypeError):
        return _error("invalid_master_request", "mutationId must be a canonical UUID.", 422)
    if (type(body["version"]) is not int or body["version"] != 1
            or not _expected(body["expectedRegistryVersion"])
            or not isinstance(body["proposalHash"], str)):
        return _error("invalid_master_request", "Publish request fields are invalid.", 422)
    if body["ownerApproved"] is not True:
        return _error("approval_required", "명시적인 ownerApproved=true 확인이 필요합니다.", 422)
    store = _store()
    if store is None:
        return _error("master_store_unavailable", "Master 저장소를 사용할 수 없습니다.", 503)
    try:
        bundle = validate_master_bundle(body["bundle"])
        _validate_reference_authority(bundle)
        expected_proposal = _proposal_hash(body["expectedRegistryVersion"], bundle)
        if body["proposalHash"] != expected_proposal:
            return _error("proposal_mismatch", "Proposal과 publish bundle이 일치하지 않습니다.", 422)
        receipt = store.publish_bundle(bundle, mutation_id=mutation_id,
                                       expected_registry_version=body["expectedRegistryVersion"], owner_approved=True)
        return jsonify({"ok": True, **receipt})
    except (MasterRevisionConflict, MasterMutationConflict, InvalidMasterBundle,
            MasterStoreError, sqlite3.Error, OSError) as failure:
        return _store_failure(failure)


__all__ = ["master_api", "MAX_MASTER_JSON_BYTES"]
