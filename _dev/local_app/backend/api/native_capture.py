"""Same-origin native capture commands and receiver-owned PNG delivery."""
from flask import Blueprint, current_app, jsonify, request, Response

from local_app.native_capture import NativeCaptureError
from ..recognition_contracts import RecognitionContractError

native_capture_api = Blueprint("native_capture", __name__, url_prefix="/api/native-capture")


def controller():
    value = current_app.extensions.get("native_capture")
    if value is None:
        raise NativeCaptureError("native_unavailable", "Windows 실행기로 앱을 시작하세요.", 503)
    return value


@native_capture_api.get("")
def status():
    value = current_app.extensions.get("native_capture")
    if value is None:
        return jsonify({"ok": True, "available": False, "mode": "NONE", "state": "IDLE"})
    value.maintenance()
    return jsonify({"ok": True, **value.snapshot(), "targets": value.targets()})


@native_capture_api.post("")
def command():
    data = request.get_json()
    if not isinstance(data, dict):
        raise NativeCaptureError("invalid_command", "잘못된 캡처 요청입니다.", 422)
    action = data.get("action")
    fields = {"prepare": {"action", "receiver", "mode", "target", "context", "select"},
              "heartbeat": {"action", "receiver", "generation", "count", "bytes", "busy", "context"},
              "ack": {"action", "receiver", "generation", "captureId"},
              "disarm": {"action", "receiver", "generation"}}
    if not isinstance(action, str) or action not in fields or (set(data) != fields[action] and
            not (action == "prepare" and set(data) == fields[action] | {"gameSession"})):
        raise NativeCaptureError("invalid_command", "잘못된 캡처 요청입니다.", 422)
    if action != "prepare" and (type(data["generation"]) is not int or data["generation"] < 0):
        raise NativeCaptureError("invalid_command", "잘못된 캡처 세대입니다.", 422)
    if action == "ack" and not isinstance(data["captureId"], str):
        raise NativeCaptureError("invalid_command", "잘못된 캡처 ID입니다.", 422)
    value = controller()
    if action == "prepare":
        if type(data["select"]) is not bool or type(data.get("gameSession", False)) is not bool:
            raise NativeCaptureError("invalid_command", "영역 설정 요청이 올바르지 않습니다.", 422)
        result = value.prepare(data["receiver"], data["mode"], data["target"], data["context"], select=data["select"], game_session=data.get("gameSession", False))
    elif action == "heartbeat":
        result = value.heartbeat(data["receiver"], data["generation"], data["count"], data["bytes"], data["busy"], data["context"])
    elif action == "ack":
        value.acknowledge(data["receiver"], data["generation"], data["captureId"])
        result = value.snapshot()
    else:
        result = value.disarm(data["receiver"], data["generation"])
    return jsonify({"ok": True, **result})


@native_capture_api.get("/<capture_id>.png")
def image(capture_id):
    try:
        generation = int(request.args.get("generation", ""))
    except ValueError:
        raise NativeCaptureError("stale_capture", "이미 만료된 캡처입니다.", 404) from None
    png = controller().image(request.args.get("receiver"), generation, capture_id)
    return Response(png, mimetype="image/png", headers={"Cache-Control": "no-store"})


@native_capture_api.errorhandler(NativeCaptureError)
@native_capture_api.errorhandler(RecognitionContractError)
def capture_error(error):
    return jsonify({"ok": False, "error": {"code": error.code, "message": str(error)}}), error.status
