"""Application lifecycle endpoints for the desktop launcher."""
from __future__ import annotations

from flask import Blueprint, current_app, jsonify

maintenance_api = Blueprint("maintenance_api", __name__, url_prefix="/api/app")


@maintenance_api.post("/shutdown")
def shutdown():
    """Stop accepting writes and wait for active writes/scans before shutdown."""
    condition = current_app.extensions["bdo_mutation_condition"]
    state = current_app.extensions["bdo_mutation_state"]
    with condition:
        state["stopping"] = True
        drained = condition.wait_for(lambda: state["active"] == 0, timeout=30)
        if not drained:
            state["stopping"] = False
            condition.notify_all()
            return jsonify({"ok": False, "error": {"code": "shutdown_busy", "message": "저장 또는 창고 스캔이 끝나지 않아 종료를 보류했습니다."}}), 503
    return jsonify({"ok": True, "stopping": True})
