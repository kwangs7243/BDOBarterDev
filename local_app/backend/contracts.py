"""Input contracts for the bounded SPEC-001 state API."""
from __future__ import annotations

import json
import math
from typing import Any

MAX_SAFE_INTEGER = 9_007_199_254_740_991
VALID_KINDS = {"warehouse", "manual", "completion"}
VALID_SECTIONS = {"inventoryOrder", "tierRules", "ship", "parley", "shipPresets", "tuning", "navigation", "mapSlots", "mapBase", "viewer"}
TIERS = {"1", "2", "3", "4", "5"}
MODES = {"none", "inner", "ocean", "t7_2region", "t7_2region_south", "t7_2region_arehazaX", "t7_3region"}
TUNING_FIELDS = {"specialMatPriority", "crowCoinPriority", "pathEfficiencyBonus", "smallTradePenalty", "chainMaxDistance", "chainBonusScore", "distancePenaltyWeight", "overloadPenalty", "efficiencyThreshold", "iliyaPitstopRadius", "overloadTimeWeight", "deficitRatioBonus", "emergencyBonus", "preservationBonus", "westBias", "useClustering", "tierPriority", "excludeSurplus"}


class ContractError(ValueError):
    def __init__(self, message: str, code: str = "invalid_request", status: int = 422):
        super().__init__(message)
        self.code, self.status = code, status


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError(f"{label} must be an object")
    return value


def require_int(value: Any, label: str, *, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum or value > MAX_SAFE_INTEGER:
        raise ContractError(f"{label} must be an integer between {minimum} and {MAX_SAFE_INTEGER}")
    return value


def validate_json_tree(value: Any, label: str = "payload", depth: int = 0) -> None:
    if depth > 32:
        raise ContractError(f"{label} is nested too deeply")
    if value is None or isinstance(value, (str, bool)):
        if isinstance(value, str) and len(value) > 16_384:
            raise ContractError(f"{label} contains an overly long string")
        return
    if type(value) is int:
        if abs(value) > MAX_SAFE_INTEGER:
            raise ContractError(f"{label} contains an out-of-range integer")
        return
    if type(value) is float:
        if not math.isfinite(value) or abs(value) > MAX_SAFE_INTEGER:
            raise ContractError(f"{label} contains an invalid number")
        return
    if isinstance(value, list):
        if len(value) > 10_000:
            raise ContractError(f"{label} contains too many entries")
        for index, item in enumerate(value):
            validate_json_tree(item, f"{label}[{index}]", depth + 1)
        return
    if isinstance(value, dict):
        if len(value) > 10_000 or any(not isinstance(key, str) for key in value):
            raise ContractError(f"{label} must have string keys")
        for key, item in value.items():
            validate_json_tree(item, f"{label}.{key}", depth + 1)
        return
    raise ContractError(f"{label} is not JSON-compatible")


def validate_envelope(body: Any) -> tuple[str, int]:
    data = require_object(body, "request")
    mutation_id = data.get("mutationId")
    if not isinstance(mutation_id, str) or not mutation_id.strip() or len(mutation_id) > 128:
        raise ContractError("mutationId must be a non-empty string of at most 128 characters")
    revision = require_int(data.get("baseRevision"), "baseRevision")
    return mutation_id, revision


def validate_inventory_patch(body: Any, catalog: dict[str, int]) -> tuple[str, int, str, dict[str, dict[str, int]]]:
    data = require_object(body, "request")
    mutation_id, revision = validate_envelope(data)
    allowed = {"mutationId", "baseRevision", "kind", "patch"}
    if "feedback" in data and data.get("kind") == "warehouse":
        allowed.add("feedback")
    if set(data) != allowed:
        raise ContractError("inventory request has unsupported fields")
    kind = data.get("kind")
    if kind not in VALID_KINDS:
        raise ContractError("kind must be warehouse, manual, or completion")
    patch = require_object(data.get("patch"), "patch")
    if kind == "warehouse":
        if set(patch) != {"type", "version", "items"} or patch.get("type") != "master_inventory_patch" or type(patch.get("version")) is not int or patch.get("version") != 1:
            raise ContractError("warehouse patch must use master_inventory_patch version 1")
        raw_items = require_object(patch.get("items"), "patch.items")
        if not raw_items:
            raise ContractError("patch.items must not be empty")
        updates: dict[str, dict[str, int]] = {}
        for name, stock in raw_items.items():
            if name not in catalog or catalog[name] > 4:
                raise ContractError(f"unsupported warehouse item: {name}")
            updates[name] = {"stock": require_int(stock, f"items.{name}")}
    else:
        if set(patch) != {"items"}:
            raise ContractError("patch must contain only items")
        raw_items = require_object(patch.get("items"), "patch.items")
        if not raw_items:
            raise ContractError("patch.items must not be empty")
        updates = {}
        for name, fields in raw_items.items():
            if name not in catalog:
                raise ContractError(f"unsupported inventory item: {name}")
            fields = require_object(fields, f"items.{name}")
            allowed = {"stock", "target"} if kind == "manual" else {"stock"}
            if not fields or not set(fields).issubset(allowed):
                raise ContractError(f"unsupported fields for {kind} item {name}")
            updates[name] = {key: require_int(value, f"items.{name}.{key}") for key, value in fields.items()}
    return mutation_id, revision, kind, updates


def validate_order(body: Any, catalog: dict[str, int]) -> tuple[str, int, dict[str, list[str]]]:
    data = require_object(body, "request")
    mutation_id, revision = validate_envelope(data)
    if set(data) != {"mutationId", "baseRevision", "order"}:
        raise ContractError("order request has unsupported fields")
    order = require_object(data.get("order"), "order")
    if set(order) != TIERS:
        raise ContractError("order must contain tiers 1 through 5")
    normalized: dict[str, list[str]] = {}
    for tier, names in order.items():
        if not isinstance(names, list) or len(names) > 70:
            raise ContractError(f"order tier {tier} must be an array")
        if any(not isinstance(name, str) or catalog.get(name) != int(tier) for name in names):
            raise ContractError(f"order tier {tier} contains an unknown or wrong-tier item")
        if len(set(names)) != len(names):
            raise ContractError(f"order tier {tier} contains duplicate items")
        normalized[tier] = list(names)
    return mutation_id, revision, normalized


def _number(value: Any, label: str, *, minimum: float = 0) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < minimum or value > MAX_SAFE_INTEGER:
        raise ContractError(f"{label} must be a finite number >= {minimum}")


def _exact_keys(value: dict[str, Any], keys: set[str], label: str) -> None:
    if set(value) != keys:
        raise ContractError(f"{label} must contain exactly: {', '.join(sorted(keys))}")


def _validate_snapshot(value: Any, label: str) -> None:
    snap = require_object(value, label)
    required = {"coords", "routes", "routeCalibrations", "memos"}
    if set(snap) != required:
        raise ContractError(f"{label} must contain coords, routes, routeCalibrations, and memos")
    if not isinstance(snap["coords"], dict) or not isinstance(snap["routes"], list) or not isinstance(snap["routeCalibrations"], dict) or not isinstance(snap["memos"], list):
        raise ContractError(f"{label} has invalid map snapshot field types")
    validate_json_tree(snap, label)


def validate_setting_section(section: str, value: Any, catalog: dict[str, int]) -> dict[str, Any]:
    if section not in VALID_SECTIONS:
        raise ContractError(f"unsupported settings section: {section}")
    if section == "mapBase":
        if value is not None:
            _validate_snapshot(value, "mapBase")
        return value
    obj = require_object(value, f"settings.{section}")
    validate_json_tree(obj, f"settings.{section}")
    if section == "inventoryOrder":
        _exact_keys(obj, TIERS, section)
        for tier, names in obj.items():
            if not isinstance(names, list) or any(not isinstance(name, str) or catalog.get(name) != int(tier) for name in names) or len(names) != len(set(names)):
                raise ContractError(f"inventoryOrder tier {tier} must contain unique canonical names from that tier")
    elif section == "tierRules":
        _exact_keys(obj, TIERS, section)
        for tier, count in obj.items():
            require_int(count, f"tierRules.{tier}")
    elif section == "ship":
        required = {"normalWeight", "maxWeight", "speed", "mode"}
        if set(obj) != required:
            raise ContractError("ship requires normalWeight, maxWeight, speed, and mode")
        for key in ("normalWeight", "maxWeight", "speed"):
            _number(obj[key], f"ship.{key}")
        if obj["mode"] not in MODES:
            raise ContractError("ship.mode is unsupported")
    elif section == "parley":
        _exact_keys(obj, {"defaultBudget", "normalCost", "crowCost"}, section)
        for key, value in obj.items():
            require_int(value, f"parley.{key}")
    elif section == "shipPresets":
        _exact_keys(obj, {"1", "2", "3", "4"}, section)
        for slot, preset in obj.items():
            if preset is None:
                continue
            p = require_object(preset, f"shipPresets.{slot}")
            _exact_keys(p, {"mode", "nW", "mW", "speed"}, f"shipPresets.{slot}")
            if p["mode"] not in MODES:
                raise ContractError(f"shipPresets.{slot}.mode is unsupported")
            for key in ("nW", "mW", "speed"):
                _number(p[key], f"shipPresets.{slot}.{key}")
    elif section == "tuning":
        if not obj or set(obj) - TUNING_FIELDS:
            raise ContractError("tuning is empty or has unknown fields")
        for key, entry in obj.items():
            if key == "tierPriority":
                priority = require_object(entry, "tuning.tierPriority")
                if set(priority) - {"T1", "T2", "T3", "T4", "T5"}:
                    raise ContractError("tuning.tierPriority has unsupported tier")
                for name, number in priority.items():
                    require_int(number, f"tuning.tierPriority.{name}", minimum=-MAX_SAFE_INTEGER)
            elif key == "excludeSurplus":
                if not isinstance(entry, dict) or any(not isinstance(v, bool) for v in entry.values()):
                    raise ContractError("tuning.excludeSurplus must map names to Boolean values")
            else:
                _number(entry, f"tuning.{key}", minimum=-MAX_SAFE_INTEGER)
    elif section == "navigation":
        _exact_keys(obj, {"coords", "routeCalibrations", "memos"}, section)
        if not isinstance(obj["coords"], dict) or not isinstance(obj["routeCalibrations"], dict) or not isinstance(obj["memos"], list):
            raise ContractError("navigation requires coords/object, routeCalibrations/object, and memos/array")
    elif section == "mapSlots":
        _exact_keys(obj, {"1", "2", "3"}, section)
        for slot, snapshot in obj.items():
            if snapshot is not None:
                _validate_snapshot(snapshot, f"mapSlots.{slot}")
    elif section == "viewer":
        if set(obj) - {"uiZoom", "panels"}:
            raise ContractError("viewer has unsupported fields")
        if "uiZoom" in obj:
            _number(obj["uiZoom"], "viewer.uiZoom", minimum=25)
        if "panels" in obj and not isinstance(obj["panels"], dict):
            raise ContractError("viewer.panels must be an object")
    return obj


def validate_settings_patch(body: Any, catalog: dict[str, int]) -> tuple[str, int, dict[str, dict[str, Any]]]:
    data = require_object(body, "request")
    mutation_id, revision = validate_envelope(data)
    if set(data) != {"mutationId", "baseRevision", "settings"}:
        raise ContractError("settings request has unsupported fields")
    sections = require_object(data.get("settings"), "settings")
    if not sections:
        raise ContractError("settings must contain at least one section")
    for section, value in sections.items():
        if section not in VALID_SECTIONS:
            raise ContractError(f"unsupported settings section: {section}")
        if section != "mapBase" and not isinstance(value, dict):
            raise ContractError(f"settings.{section} must be an object")
        validate_json_tree(value, f"settings.{section}")
    return mutation_id, revision, sections


def canonical_request_hash(body: Any) -> str:
    import hashlib
    encoded = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
