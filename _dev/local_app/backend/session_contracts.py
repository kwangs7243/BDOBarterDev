"""Versioned JSON snapshots for current work; no server-side barter calculations."""
from __future__ import annotations

from copy import deepcopy
from typing import Any

from .contracts import ContractError, require_int, require_object, validate_envelope, validate_json_tree, validate_setting_section

SESSION_KEYS = {"version", "id", "scannedTrades", "schedule", "completed", "remainingParley", "config", "selection", "diagnostics"}
TIMER_KEYS = {"timerActive", "timerEnd", "alarmPlayed", "__completionPending"}


def validate_session(value: Any, catalog: dict[str, int]) -> dict[str, Any]:
    """Validate and copy a working snapshot, excluding timer runtime on both API boundaries."""
    obj = require_object(value, "session")
    if set(obj) != SESSION_KEYS or type(obj.get("version")) is not int or obj["version"] != 1:
        raise ContractError("session must use the exact version 1 snapshot fields")
    validate_json_tree(obj, "session")
    if not isinstance(obj["id"], str) or not obj["id"].strip() or len(obj["id"]) > 128:
        raise ContractError("session.id must be a non-empty identifier")
    rows = obj["scannedTrades"]
    if not isinstance(rows, list) or len(rows) > 10000:
        raise ContractError("session.scannedTrades must be an array")
    for index, row in enumerate(rows):
        row = require_object(row, f"trade[{index}]")
        for key in ("island", "fromItem", "toItem"):
            if not isinstance(row.get(key), str):
                raise ContractError(f"trade[{index}].{key} must be text")
        for key in ("reqAmount", "count", "yield"):
            require_int(row.get(key), f"trade[{index}].{key}")
        for key in ("disabled", "deleted"):
            if key in row and not isinstance(row[key], bool):
                raise ContractError(f"trade[{index}].{key} must be Boolean")
    require_int(obj["remainingParley"], "session.remainingParley")
    config = require_object(obj["config"], "session.config")
    if set(config) != {"ship", "parley", "tuning"}:
        raise ContractError("session.config requires ship, parley, tuning")
    for section, payload in config.items():
        validate_setting_section(section, payload, catalog)
    selection = require_object(obj["selection"], "session.selection")
    if set(selection) - {"briefMode", "selectedScheduleSlot"}:
        raise ContractError("unsupported persisted session selection")
    if selection.get("briefMode", "speed") not in {"speed", "balance", "both"}:
        raise ContractError("briefMode must be speed, balance, or both")
    slot = selection.get("selectedScheduleSlot", 1)
    if type(slot) is not int or slot not in range(1, 6):
        raise ContractError("selectedScheduleSlot must be 1 through 5")
    schedule = obj["schedule"]
    if schedule is not None:
        schedule = require_object(schedule, "session.schedule")
        if set(schedule) != {"speed", "balance"}:
            raise ContractError("schedule requires speed and balance")
        for mode, sorties in schedule.items():
            if not isinstance(sorties, list):
                raise ContractError(f"schedule.{mode} must be an array")
            for sortie in sorties:
                sortie = require_object(sortie, "sortie")
                if not isinstance(sortie.get("trades"), list):
                    raise ContractError("sortie.trades must be an array")
                for trade in sortie["trades"]:
                    trade = require_object(trade, "scheduled trade")
                    if not isinstance(trade.get("island"), str):
                        raise ContractError("scheduled trade island must be text")
                    if "originalIndex" in trade and trade["originalIndex"] is not None:
                        position = require_int(trade["originalIndex"], "originalIndex")
                        if position >= len(rows):
                            raise ContractError("schedule originalIndex is outside the working trade list")
    clean = deepcopy(obj)
    if clean["schedule"]:
        for sorties in clean["schedule"].values():
            for sortie in sorties:
                for trade in sortie["trades"]:
                    for key in TIMER_KEYS:
                        trade.pop(key, None)
    return clean


def session_request(body: Any, catalog: dict[str, int], *, reset: bool = False):
    data = require_object(body, "request")
    mutation_id, revision = validate_envelope(data)
    keys = {"mutationId", "baseRevision"} | (set() if reset else {"session"})
    if set(data) != keys:
        raise ContractError("unsupported working session request fields")
    return mutation_id, revision, None if reset else validate_session(data["session"], catalog)


def slot_request(body: Any, catalog: dict[str, int], *, delete: bool = False):
    data = require_object(body, "request")
    mutation_id, revision = validate_envelope(data)
    if set(data) != {"mutationId", "baseRevision"} | (set() if delete else {"snapshot"}):
        raise ContractError("unsupported slot request fields")
    if delete:
        return mutation_id, revision, None
    snapshot = require_object(data["snapshot"], "snapshot")
    if set(snapshot) != {"version", "createdAt", "session"} or type(snapshot.get("version")) is not int or snapshot["version"] != 1:
        raise ContractError("slot snapshot requires version 1, createdAt, session")
    require_int(snapshot["createdAt"], "snapshot.createdAt")
    session = validate_session(snapshot["session"], catalog)
    if not session["schedule"] or not any(session["schedule"].values()):
        raise ContractError("a saved slot must contain a generated schedule")
    return mutation_id, revision, {**snapshot, "session": session}
