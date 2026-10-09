"""Bounded native input controller; OCR and inventory remain caller-owned."""
from __future__ import annotations

import copy
import hashlib
import json
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from local_app.native_diagnostics import CaptureDiagnostics

from local_app.backend.recognition_contracts import validate_capture_metadata, validate_capture_payload

MAX_BYTES = 20 * 1024 * 1024
MAX_FRAMES = 100


class NativeCaptureError(Exception):
    def __init__(self, code, message, status=409):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


def validate_roi(roi, geometry):
    if not isinstance(roi, dict) or set(roi) != {"x", "y", "width", "height"}:
        raise NativeCaptureError("invalid_roi", "캡처 영역을 다시 지정하세요.", 422)
    if any(type(v) is not int for v in roi.values()):
        raise NativeCaptureError("invalid_roi", "영역은 물리 픽셀 정수여야 합니다.", 422)
    x, y, width, height = (roi[k] for k in ("x", "y", "width", "height"))
    if (x < 0 or y < 0 or width < 8 or height < 8 or x + width > geometry["width"]
            or y + height > geometry["height"] or width * height > 32_000_000):
        raise NativeCaptureError("invalid_roi", "게임 화면 안에서 유효한 영역을 지정하세요.", 422)
    return dict(roi)


def adjust_roi(roi, handle, dx, dy, geometry):
    x, y, width, height = (roi[k] for k in ("x", "y", "width", "height"))
    if not handle:
        return {"x": max(0, min(geometry["width"]-width, x+dx)),
                "y": max(0, min(geometry["height"]-height, y+dy)), "width": width, "height": height}
    left, top, right, bottom = x, y, x+width, y+height
    minimum_width, minimum_height = min(80, width), min(60, height)
    if "w" in handle: left = max(0, min(right-minimum_width, left+dx))
    if "e" in handle: right = min(geometry["width"], max(left+minimum_width, right+dx))
    if "n" in handle: top = max(0, min(bottom-minimum_height, top+dy))
    if "s" in handle: bottom = min(geometry["height"], max(top+minimum_height, bottom+dy))
    return {"x": left, "y": top, "width": right-left, "height": bottom-top}


def signature(geometry):
    return {**{k: geometry[k] for k in ("identity", "width", "height", "dpi", "monitor", "mode")},
            "windowDpi": geometry.get("windowDpi", geometry["dpi"])}


def screen_box(geometry, roi):
    return (geometry["left"] + roi["x"], geometry["top"] + roi["y"],
            geometry["left"] + roi["x"] + roi["width"], geometry["top"] + roi["y"] + roi["height"])


class NativeCaptureController:
    def __init__(self, platform, profile_path: Path):
        self.platform, self.profile_path = platform, Path(profile_path)
        self.lock = threading.RLock()
        self.mode, self.state, self.error = "NONE", "IDLE", None
        self.generation, self.receiver = 0, None
        self.target, self.context, self.profile = None, None, None
        self.target_pid = None
        self.frames, self.queue_count, self.queue_bytes = {}, 0, 0
        self.receiver_busy, self.busy, self.closed = False, False, False
        self.profiles = {}
        self.worker = None
        self.runtime_failed = False
        self.captured_count = 0
        self.roi_adjusting = False
        self.diagnostics = CaptureDiagnostics(self.profile_path.parent / "logs" / "native-capture.jsonl")
        self.last_receiver_status = None
        try:
            data = json.loads(self.profile_path.read_text(encoding="utf-8"))
            if data.get("version") == 1 and isinstance(data.get("profiles"), dict):
                self.profiles = {k: v for k, v in data["profiles"].items() if k in {"trade", "warehouse"} and isinstance(v, dict)}
        except (OSError, ValueError, AttributeError):
            pass

    def start(self):
        self.platform.start(self)

    def targets(self):
        return self.platform.targets()

    def record(self, event, **fields):
        self.diagnostics.write(event, generation=self.generation, state=self.state, target=self.target,
                               workerBusy=self.busy, receiverBusy=self.receiver_busy, roiAdjusting=self.roi_adjusting, **fields)

    def _clear(self, error=None):
        self.record("session_cleared", reason=error or "explicit_reset")
        self.generation += 1
        self.mode, self.state, self.error = "NONE", "IDLE", error
        self.receiver, self.target, self.profile = None, None, None
        self.target_pid = None
        self.frames.clear()
        self.captured_count = 0
        self.roi_adjusting = False
        self.platform.cancel_selection()

    def disarm(self, receiver=None, generation=None, reason="unspecified"):
        with self.lock:
            if receiver is None or (self.receiver == receiver and generation == self.generation):
                self.record("session_disarmed", reason=reason)
                self._clear()
            return self.snapshot()

    def stop_capture(self, error=None):
        with self.lock:
            self.state, self.error, self.target = "STOPPED", error, None
            self.target_pid = None
            self.roi_adjusting = False
            self.platform.cancel_selection()
            self.record("capture_stopped", reason=error or "user_stop")

    def attach(self, receiver):
        try: receiver = str(uuid.UUID(receiver))
        except (ValueError, TypeError, AttributeError):
            raise NativeCaptureError("invalid_receiver", "캡처 수신기를 다시 여세요.", 422) from None
        with self.lock:
            self.receiver = receiver
            return self.snapshot()

    def maintenance(self):
        with self.lock:
            if self.target is not None:
                try:
                    geo = self.platform.geometry(self.target)
                    if geo["pid"] != self.target_pid:
                        self.stop_capture("target_unavailable")
                    elif self.profile and signature(geo) != self.profile["signature"]:
                        self.stop_capture("profile_changed")
                    else: return geo
                except (NativeCaptureError, OSError): self.stop_capture("target_unavailable")

    def snapshot(self):
        with self.lock:
            return {"available": not self.closed and not self.runtime_failed, "mode": self.mode, "state": self.state,
                    "generation": self.generation, "error": self.error,
                    "hotkeyRegistered": self.platform.hotkey_registered,
                    "pending": len(self.frames), "captured": self.captured_count,
                    "busy": self.busy, "receiverBusy": self.receiver_busy,
                    "context": copy.deepcopy(self.context), "inputSinkReady": bool(getattr(self.platform, "sink", None)),
                    "diagnostics": {"path": str(self.diagnostics.path), "loggingError": self.diagnostics.error}}

    def prepare(self, receiver, mode, target, context, *, select=False, count=0, size=0):
        try:
            receiver = str(uuid.UUID(receiver))
        except (ValueError, TypeError, AttributeError):
            raise NativeCaptureError("invalid_receiver", "캡처 수신기를 다시 여세요.", 422) from None
        if not isinstance(mode, str) or mode not in {"trade", "warehouse"}:
            raise NativeCaptureError("invalid_mode", "물교 또는 창고 모드를 선택하세요.", 422)
        if type(count) is not int or not 0 <= count <= MAX_FRAMES or type(size) is not int or not 0 <= size <= MAX_BYTES:
            raise NativeCaptureError("invalid_queue", "대기열 상태가 올바르지 않습니다.", 422)
        geo = self.platform.geometry(target)
        skeleton = self._metadata(mode, context, geo, {"x": 0, "y": 0, "width": 8, "height": 8}, None)
        normalized = validate_capture_metadata(skeleton)["context"]
        with self.lock:
            if self.runtime_failed:
                raise NativeCaptureError("native_runtime_failed", "네이티브 캡처가 중단되었습니다. 앱을 다시 실행하세요.", 503)
            if self.closed:
                raise NativeCaptureError("capture_closed", "앱이 종료 중입니다.")
            if self.frames or self.busy:
                raise NativeCaptureError("pending_capture", "기존 캡처를 먼저 수신한 뒤 모드를 변경하세요.")
            self._clear()
            self.receiver, self.mode, self.target, self.context = receiver, mode.upper(), target, normalized
            self.target_pid = geo["pid"]
            self.receiver_busy = False
            self.queue_count, self.queue_bytes = count, size
            generation = self.generation
            if select:
                self.state = "SELECTING"
                self.platform.select(target, generation)
            else:
                profile = self.profiles.get(mode)
                try:
                    if not profile or profile["signature"] != signature(geo):
                        raise ValueError()
                    validate_roi(profile["roi"], geo)
                    uuid.UUID(profile["id"])
                    if type(profile["version"]) is not int or profile["version"] < 1:
                        raise ValueError()
                except (ValueError, KeyError, TypeError, NativeCaptureError):
                    self._clear("roi_missing")
                    raise NativeCaptureError("roi_missing", "게임 화면에서 영역을 먼저 지정하세요.") from None
                self.profile, self.state = copy.deepcopy(profile), "READY"
            self.record("session_prepared", select=select, mode=mode)
            return self.snapshot()

    def selected(self, generation, roi, geo):
        self.record("roi_result", accepted=roi is not None, selectionGeneration=generation)
        with self.lock:
            if generation != self.generation or self.state != "SELECTING":
                return
            if roi is None:
                if self.profile:
                    self.state, self.error = "READY", "roi_cancelled"
                else:
                    self._clear("roi_cancelled")
                return
            try:
                current = self.platform.geometry(self.target)
                if current != geo:
                    raise NativeCaptureError("profile_changed", "게임 화면 환경이 바뀌었습니다. 다시 지정하세요.")
                roi = validate_roi(roi, current)
                self._store_profile(roi, current)
                self.state = "READY"
                self.record("roi_saved", roi=roi)
            except (NativeCaptureError, OSError, ValueError):
                self.diagnostics.exception("roi_save_failed")
                self._clear("roi_save_failed")

    def _store_profile(self, roi, geometry):
        key = self.mode.lower()
        old = self.profiles.get(key, {})
        profile = {"id": str(uuid.uuid4()), "version": 1, "signature": signature(geometry), "roi": roi}
        if type(old.get("version")) is int: profile["version"] = max(1, old["version"]+1)
        profiles = {**self.profiles, key: profile}
        self.profile_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.profile_path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"version": 1, "profiles": profiles}, ensure_ascii=False), encoding="utf-8")
        temporary.replace(self.profile_path)
        self.profiles, self.profile = profiles, profile

    def begin_roi_adjustment(self):
        with self.lock:
            if self.state != "READY" or self.busy or not self.profile: return False
            self.roi_adjusting = True
            self.record("roi_drag_started")
            return True

    def update_roi(self, generation, roi, geometry):
        with self.lock:
            try:
                if generation != self.generation or self.state != "READY" or not self.profile: return False
                current = self.platform.geometry(self.target)
                if current != geometry or signature(current) != self.profile["signature"]:
                    raise NativeCaptureError("profile_changed", "ゲーム 창 환경이 바뀌었습니다.")
                roi = validate_roi(roi, current)
                if roi != self.profile["roi"]: self._store_profile(roi, current)
                self.error = None
                self.record("roi_updated", roi=roi)
                return True
            except (NativeCaptureError, OSError, ValueError) as exc:
                self.error = getattr(exc, "code", "roi_save_failed")
                self.diagnostics.exception("roi_update_failed", code=self.error)
                return False
            finally: self.roi_adjusting = False

    def finish(self, receiver=None, generation=None):
        with self.lock:
            if receiver is not None and (receiver != self.receiver or generation != self.generation):
                raise NativeCaptureError("stale_capture", "다른 수신기의 캡처입니다.")
            self.stop_capture()

    def registration_failed(self):
        with self.lock:
            if self.state == "READY":
                self.error = "hotkey_conflict"

    def wants_hotkey(self):
        with self.lock:
            return self.state == "READY" and not self.closed and not self.busy and not self.roi_adjusting

    def heartbeat(self, receiver, generation, count, size, busy, context):
        if (type(count) is not int or not 0 <= count <= MAX_FRAMES or type(size) is not int
                or not 0 <= size <= MAX_BYTES or type(busy) is not bool):
            raise NativeCaptureError("invalid_queue", "대기열 상태가 올바르지 않습니다.", 422)
        self.maintenance()
        with self.lock:
            if receiver != self.receiver or generation != self.generation:
                return {**self.snapshot(), "frames": [], "owned": False}
            if not isinstance(context, dict) or context != self.context:
                self.record("stale_frames_discarded", reason="session_changed",
                            discardedCount=len(self.frames), discardedBytes=sum(len(v["png"]) for v in self.frames.values()),
                            invalidatedCaptureGeneration=self.generation)
                self._clear("session_changed")
                return {**self.snapshot(), "frames": [], "owned": False}
            receiver_status = (count, size, busy)
            if receiver_status != self.last_receiver_status:
                self.record("receiver_status", queueCount=count, queueBytes=size, busy=busy)
                self.last_receiver_status = receiver_status
            self.queue_count, self.queue_bytes, self.receiver_busy = count, size, busy
            return {**self.snapshot(), "owned": True,
                    "frames": [{"metadata": copy.deepcopy(v["metadata"]), "generation": generation,
                                "sha256": v["sha256"], "bytes": len(v["png"])} for v in self.frames.values()]}

    def image(self, receiver, generation, capture_id):
        self.maintenance()
        with self.lock:
            if receiver != self.receiver or generation != self.generation or capture_id not in self.frames:
                raise NativeCaptureError("stale_capture", "이미 만료된 캡처입니다.", 404)
            return self.frames[capture_id]["png"]

    def acknowledge(self, receiver, generation, capture_id):
        with self.lock:
            if receiver == self.receiver and generation == self.generation:
                removed = self.frames.pop(capture_id, None)
                self.record("frame_acknowledged", removed=removed is not None)

    def on_hotkey(self):
        self.maintenance()
        with self.lock:
            if not self.wants_hotkey():
                if self.state == "READY": self.error = "capture_busy"
                self.record("capture_rejected", reason="busy_or_inactive")
                return False
            if not self.platform.is_foreground(self.target):
                self.error = "foreground_required"
                self.record("capture_rejected", reason=self.error)
                return False
            if self.queue_count + len(self.frames) >= MAX_FRAMES or self.queue_bytes >= MAX_BYTES:
                self.error = "queue_full"
                self.record("capture_rejected", reason=self.error)
                return False
            self.busy = True
            self.record("capture_accepted")
            args = (self.generation, self.target, copy.deepcopy(self.profile), copy.deepcopy(self.context), self.mode.lower(), self.target_pid)
            self.worker = threading.Thread(target=self._capture, args=args, name="bdo-native-pixels", daemon=True)
            self.worker.start()
            return True

    def _metadata(self, mode, context, geo, roi, profile):
        return {"version": 1, "captureId": str(uuid.uuid4()), "batchId": None,
                "taskType": mode, "sourceType": "native-screen",
                "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "frame": {"width": roi["width"], "height": roi["height"]},
                "fidelity": {"sourceWidth": geo["width"], "sourceHeight": geo["height"],
                             "rescaled": False, "evidence": "native-pixels"},
                "profileId": profile["id"] if profile else None,
                "profileVersion": profile["version"] if profile else 1,
                "context": context,
                "observed": {"browserDpr": None, "windowsDpi": geo["dpi"],
                             "gameResolution": None, "gameUiScale": None},
                "nativeEvidence": {"provider": "gdi", "roi": roi,
                                   "clientSize": {"width": geo["width"], "height": geo["height"]},
                                   "screenOrigin": {"x": geo["left"], "y": geo["top"]},
                                   "windowMode": geo["mode"], "monitor": geo["monitor"]}}

    def _capture(self, generation, target, profile, context, mode, target_pid):
        started = time.monotonic()
        self.record("capture_worker_started")
        try:
            geo = self.platform.geometry(target)
            if geo["pid"] != target_pid:
                raise NativeCaptureError("target_changed", "게임 프로세스가 바뀌었습니다.")
            if signature(geo) != profile["signature"]:
                raise NativeCaptureError("profile_changed", "게임 화면 환경이 바뀌었습니다.")
            if not self.platform.is_foreground(target):
                raise NativeCaptureError("foreground_required", "게임 화면을 앞에 두세요.")
            roi = validate_roi(profile["roi"], geo)
            metadata = self._metadata(mode, context, geo, roi, profile)
            self.record("pixel_read_started")
            png = self.platform.capture(screen_box(geo, roi))
            self.record("pixel_read_done", bytes=len(png))
            current = self.platform.geometry(target)
            if current != geo or not self.platform.is_foreground(target):
                raise NativeCaptureError("target_changed", "캡처 중 게임 창이 바뀌었습니다.")
            validate_capture_payload(json.dumps(metadata), png, content_type="image/png", expected_task=mode)
            with self.lock:
                if generation != self.generation or self.closed:
                    self.record("frame_discarded", captureGeneration=generation, closed=self.closed, discardedBytes=len(png))
                    return
                if self.queue_count + len(self.frames) >= MAX_FRAMES:
                    raise NativeCaptureError("queue_full", "대기 이미지 개수 제한에 도달했습니다.")
                if self.queue_bytes + sum(len(v["png"]) for v in self.frames.values()) + len(png) > MAX_BYTES:
                    raise NativeCaptureError("queue_full", "대기 이미지의 전체 용량 제한에 도달했습니다.")
                self.frames[metadata["captureId"]] = {"metadata": metadata, "png": png,
                                                        "sha256": hashlib.sha256(png).hexdigest()}
                self.captured_count += 1
                self.error = None
                self.record("capture_completed", captured=self.captured_count, elapsedMs=round((time.monotonic()-started)*1000))
        except Exception as exc:
            self.diagnostics.exception("capture_failed", code=getattr(exc, "code", "pixel_capture_failed"))
            with self.lock:
                if generation == self.generation:
                    self.error = getattr(exc, "code", "pixel_capture_failed")
        finally:
            with self.lock:
                self.busy = False

    def close(self):
        with self.lock:
            self.closed = True
            self._clear()
        self.platform.stop()
        if self.worker and self.worker is not threading.current_thread():
            self.worker.join(timeout=3)
        self.diagnostics.close()
