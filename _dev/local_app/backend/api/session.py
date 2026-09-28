"""Working session and explicit schedule-slot persistence endpoints."""
from flask import Blueprint, current_app, jsonify, request

from ..contracts import ContractError, canonical_request_hash, require_int, require_object, validate_envelope, validate_inventory_patch
from ..session_contracts import session_request, slot_request, validate_session

session_api = Blueprint("session_api", __name__, url_prefix="/api")


def response(result):
    revision, replayed = result
    return jsonify({"ok": True, "revision": revision, "idempotent": replayed})


@session_api.route("/working-session", methods=["PUT", "DELETE"])
def working_session():
    store = current_app.extensions["bdo_storage"]
    body = request.get_json()
    mutation_id, revision, payload = session_request(body, store.catalog, reset=request.method == "DELETE")
    return response(store.update_session(payload, mutation_id, revision, canonical_request_hash(body)))


@session_api.route("/schedule-slots/<int:slot>", methods=["PUT", "DELETE"])
def schedule_slot(slot):
    if slot not in range(1, 6):
        raise ContractError("slot must be 1 through 5")
    store = current_app.extensions["bdo_storage"]
    body = request.get_json()
    mutation_id, revision, payload = slot_request(body, store.catalog, delete=request.method == "DELETE")
    # Include endpoint identity so an ID cannot replay on a different slot or operation.
    fingerprint = {"method": request.method, "path": request.path, "body": body}
    return response(store.update_slot(slot, payload, mutation_id, revision, canonical_request_hash(fingerprint)))


@session_api.post("/working-session/completion")
def completion():
    store = current_app.extensions["bdo_storage"]
    body = require_object(request.get_json(), "request")
    if set(body) != {"mutationId", "baseRevision", "kind", "patch", "session", "sessionRevision"} or body["kind"] != "completion":
        raise ContractError("completion requires inventory and working snapshot")
    inventory_body = {key: body[key] for key in ("mutationId", "baseRevision", "kind", "patch")}
    if body["patch"] == {"items": {}}:
        mutation_id, revision = validate_envelope(body)
        updates = {}
    else:
        mutation_id, revision, _, updates = validate_inventory_patch(inventory_body, store.catalog)
    payload = validate_session(body["session"], store.catalog)
    session_revision = require_int(body["sessionRevision"], "sessionRevision")
    return response(store.complete_session(updates, payload, session_revision, mutation_id, revision, canonical_request_hash(body)))
