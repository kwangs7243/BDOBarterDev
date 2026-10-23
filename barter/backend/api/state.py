"""Health, bootstrap, inventory, order, and settings endpoints."""
from __future__ import annotations

from copy import deepcopy

from flask import Blueprint, current_app, jsonify, request

from ..contracts import (
    canonical_request_hash,
    validate_inventory_patch,
    validate_order,
    validate_setting_section,
    validate_settings_patch,
)
from ..storage import SCHEMA_VERSION

api = Blueprint("state_api", __name__, url_prefix="/api")


def _store():
    return current_app.extensions["bdo_storage"]


def _mutation_response(revision: int, idempotent: bool):
    return jsonify({"ok": True, "revision": revision, "idempotent": idempotent})


def _merge(base, patch):
    if isinstance(base, dict) and isinstance(patch, dict):
        result = deepcopy(base)
        for key, value in patch.items():
            result[key] = _merge(result[key], value) if key in result else deepcopy(value)
        return result
    return deepcopy(patch)


@api.get("/health")
def health():
    store = _store()
    return jsonify({"ok": True, "service": "bdo-barter-local", "schemaVersion": SCHEMA_VERSION, "revision": store.revision()})


@api.get("/bootstrap")
def bootstrap():
    return jsonify(_store().bootstrap())


@api.get("/inventory")
def inventory():
    store = _store()
    return jsonify({"revision": store.revision(), "items": store.get_inventory()})


@api.patch("/inventory")
def patch_inventory():
    store = _store()
    body = request.get_json()
    mutation_id, revision, _kind, updates = validate_inventory_patch(body, store.catalog)
    next_revision, idempotent = store.update_inventory(
        updates, mutation_id, revision, canonical_request_hash(body), body.get("feedback")
    )
    return _mutation_response(next_revision, idempotent)


@api.get("/inventory/order")
def inventory_order():
    store = _store()
    return jsonify({"revision": store.revision(), "order": store.get_order()})


@api.put("/inventory/order")
def put_inventory_order():
    store = _store()
    body = request.get_json()
    mutation_id, revision, order = validate_order(body, store.catalog)
    next_revision, idempotent = store.update_order(
        order, mutation_id, revision, canonical_request_hash(body)
    )
    return _mutation_response(next_revision, idempotent)


@api.get("/settings")
def settings():
    store = _store()
    return jsonify({"revision": store.revision(), "settings": store.get_settings()})


@api.patch("/settings")
def patch_settings():
    store = _store()
    body = request.get_json()
    mutation_id, revision, requested = validate_settings_patch(body, store.catalog)
    current = store.get_settings()
    merged = {
        section: validate_setting_section(
            section, _merge(current[section], payload), store.catalog
        )
        for section, payload in requested.items()
    }
    next_revision, idempotent = store.update_settings(
        merged, mutation_id, revision, canonical_request_hash(body)
    )
    return _mutation_response(next_revision, idempotent)
