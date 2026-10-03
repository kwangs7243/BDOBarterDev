"""Flask same-origin app and fixed-loopback Waitress entry point."""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

from flask import Flask, g, jsonify, request, send_from_directory
from werkzeug.exceptions import BadRequest, RequestEntityTooLarge

from .api.scan import scan_api
from .api.maintenance import maintenance_api
from .api.state import api
from .api.session import session_api
from .api.recognition import recognition_api
from .contracts import ContractError
from .services.trade_batch_runtime import TradeBatchRuntime
from .storage import MutationConflict, RevisionConflict, Storage, default_database_path, load_catalog

HOST = "127.0.0.1"
PORT = 18765
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
# Leave room for bounded metadata plus multipart headers while the route independently
# enforces the 20 MiB image and 64 KiB metadata contracts.
MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 128 * 1024


def create_app(database_path: str | Path | None = None, *, reference_path: str | Path | None = None,
               testing: bool = False) -> Flask:
    root = Path(__file__).resolve().parents[1]
    frontend = root / "frontend"
    catalog, order = load_catalog(Path(reference_path) if reference_path else None)
    app = Flask(__name__, static_folder=str(frontend), static_url_path="/assets")
    app.config.update(TESTING=testing, MAX_CONTENT_LENGTH=MAX_REQUEST_BYTES)
    db_path = Path(database_path) if database_path else default_database_path()
    store = Storage(db_path, catalog, order)
    store.initialize()
    app.extensions["bdo_storage"] = store
    app.extensions["trade_batch_runtime"] = TradeBatchRuntime()
    mutation_condition = threading.Condition()
    app.extensions["bdo_mutation_condition"] = mutation_condition
    app.extensions["bdo_mutation_state"] = {"active": 0, "stopping": False}
    app.extensions["bdo_shutdown_complete"] = threading.Event()
    app.register_blueprint(api)
    app.register_blueprint(session_api)
    app.register_blueprint(scan_api)
    app.register_blueprint(maintenance_api)
    app.register_blueprint(recognition_api)

    @app.before_request
    def restrict_to_local_origin():
        host = request.host.lower()
        allowed_hosts = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
        if app.testing:
            allowed_hosts.add(host) if host in {"localhost", "127.0.0.1"} or host.startswith("localhost:") or host.startswith("127.0.0.1:") else None
        if host not in allowed_hosts:
            return jsonify({"ok": False, "error": {"code": "invalid_host", "message": "Only the local application host is accepted."}}), 400
        recognition_request = request.path == "/api/recognition" or request.path.startswith("/api/recognition/")
        session_mutation = request.path.startswith("/api/working-session") and request.method in {"PATCH", "PUT", "POST", "DELETE"}
        recognition_mutation = recognition_request and request.method in {"PATCH", "PUT", "POST", "DELETE"}
        if recognition_request and request.method == "OPTIONS":
            return jsonify({"ok": False, "error": {"code": "cors_preflight_denied", "message": "Cross-origin preflight is not accepted."}}), 403
        origin = request.headers.get("Origin")
        if origin:
            allowed_origins = {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}
            if app.testing and origin.startswith(("http://127.0.0.1:", "http://localhost:")):
                allowed_origins.add(origin)
            if origin not in allowed_origins:
                return jsonify({"ok": False, "error": {"code": "invalid_origin", "message": "Cross-origin requests are not accepted."}}), 403
        if recognition_mutation or session_mutation:
            expected_origin = f"http://{host}"
            if origin is None:
                return jsonify({"ok": False, "error": {"code": "origin_required", "message": "A same-origin request is required."}}), 403
            if origin != expected_origin:
                return jsonify({"ok": False, "error": {"code": "invalid_origin", "message": "A same-origin request is required."}}), 403
            fetch_site = request.headers.get("Sec-Fetch-Site")
            if fetch_site is not None and fetch_site.lower() != "same-origin":
                return jsonify({"ok": False, "error": {"code": "invalid_fetch_site", "message": "A same-origin request is required."}}), 403
        state_mutation = request.method in {"PATCH", "PUT", "POST", "DELETE"} and (request.path in {
            "/api/inventory", "/api/inventory/order", "/api/settings", "/api/warehouse-scan"
        } or request.path.startswith(("/api/working-session", "/api/schedule-slots/")))
        if recognition_request or state_mutation:
            with mutation_condition:
                state = app.extensions["bdo_mutation_state"]
                if state["stopping"]:
                    return jsonify({"ok": False, "error": {"code": "app_shutting_down", "message": "앱 종료가 진행 중입니다. 저장을 새로 시작할 수 없습니다."}}), 503
                state["active"] += 1
                g.bdo_active_mutation = True
        return None

    @app.after_request
    def release_mutation_slot(response):
        if getattr(g, "bdo_active_mutation", False):
            with mutation_condition:
                state = app.extensions["bdo_mutation_state"]
                state["active"] -= 1
                mutation_condition.notify_all()
        if request.path == "/api/app/shutdown" and response.status_code == 200:
            threading.Timer(0.35, app.extensions["bdo_shutdown_complete"].set).start()
        return response

    @app.get("/")
    def frontend_index():
        return send_from_directory(frontend, "index.html")

    @app.errorhandler(ContractError)
    def handle_contract_error(error: ContractError):
        return jsonify({"ok": False, "error": {"code": error.code, "message": str(error)}}), error.status

    @app.errorhandler(RevisionConflict)
    def handle_revision_conflict(error: RevisionConflict):
        return jsonify({"ok": False, "error": {"code": "stale_revision", "message": str(error)}}), 409

    @app.errorhandler(MutationConflict)
    def handle_mutation_conflict(error: MutationConflict):
        return jsonify({"ok": False, "error": {"code": "mutation_id_reused", "message": str(error)}}), 409

    @app.errorhandler(RequestEntityTooLarge)
    def handle_too_large(_error):
        return jsonify({"ok": False, "error": {"code": "file_too_large", "message": "이미지 파일은 20 MiB 이하여야 합니다."}}), 413

    @app.errorhandler(BadRequest)
    def handle_bad_request(_error):
        return jsonify({"ok": False, "error": {"code": "invalid_json", "message": "A valid JSON request body is required."}}), 400

    @app.errorhandler(sqlite3.Error)
    def handle_database_error(_error):
        return jsonify({"ok": False, "error": {"code": "storage_error", "message": "Persistent storage operation failed; no success was recorded."}}), 503

    @app.errorhandler(RuntimeError)
    def handle_storage_runtime_error(_error):
        return jsonify({"ok": False, "error": {"code": "storage_error", "message": "Persistent storage operation failed; no success was recorded."}}), 503

    return app


def serve_local(app: Flask | None = None) -> None:
    """Serve only on the fixed loopback address using Waitress."""
    try:
        from waitress import serve
    except ImportError as exc:
        raise RuntimeError("Waitress is required. Install local_app project dependencies before starting the local server.") from exc
    serve(app or create_app(), host=HOST, port=PORT, threads=4)


if __name__ == "__main__":
    serve_local()
