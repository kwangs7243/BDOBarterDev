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

from local_app.backend.recognition_contracts import validate_capture_metadata, validate_capture_payload

MAX_BYTES = 20 * 1024 * 1024
MAX_FRAMES = 100
# Hidden Chrome timers can be batched once per minute. Keep two missed ticks tolerable.
LEASE_SECONDS = 150


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


def signature(geometry):
    return {**{k: geometry[k] for k in ("identity", "width", "height", "dpi", "monitor", "mode")},
            "windowDpi": geometry.get("windowDpi", geometry["dpi"])}


def screen_box(geometry, roi):
    return (geometry["left"] + roi["x"], geometry["top"] + roi["y"],
            geometry["left"] + roi["x"] + roi["width"], geometry["top"] + roi["y"] + roi["height"])


class NativeCaptureController:
    def __init__(self, platform, profile_path: Path, *, clock=time.monotonic):
        self.platform, self.profile_path, self.clock = platform, Path(profile_path), clock
        self.lock = threading.RLock()
        self.mode, self.state, self.error = "NONE", "IDLE", None
        self.generation, self.receiver, self.deadline = 0, None, 0
        self.target, self.context, self.profile = None, None, None
        self.frames, self.queue_count, self.queue_bytes = {}, 0, 0
        self.receiver_busy, self.busy, self.closed = False, False, False
        self.profiles = {}
        self.worker = None
        self.runtime_failed = False
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

    def _clear(self, error=None):
        self.generation += 1
        self.mode, self.state, self.error = "NONE", "IDLE", error
        self.receiver, self.target, self.profile = None, None, None
        self.frames.clear()
        self.platform.cancel_selection()

    def disarm(self, receiver=None, generation=None):
        with self.lock:
            if receiver is None or (self.receiver == receiver and generation == self.generation):
                self._clear()
            return self.snapshot()

    def maintenance(self):
        with self.lock:
            if self.receiver and self.clock() > self.deadline:
                self._clear("receiver_expired")
            if self.target is not None:
                try:
                    geo = self.platform.geometry(self.target)
                    if self.profile and signature(geo) != self.profile["signature"]:
                        self._clear("profile_changed")
                except (NativeCaptureError, OSError):
                    self._clear("target_unavailable")

    def snapshot(self):
        with self.lock:
            return {"available": not self.closed and not self.runtime_failed, "mode": self.mode, "state": self.state,
                    "generation": self.generation, "error": self.error,
                    "hotkeyRegistered": self.platform.hotkey_registered,
                    "pending": len(self.frames)}

    def prepare(self, receiver, mode, target, context, *, select=False):
        try:
            receiver = str(uuid.UUID(receiver))
        except (ValueError, TypeError, AttributeError):
            raise NativeCaptureError("invalid_receiver", "캡처 수신기를 다시 여세요.", 422) from None
        if not isinstance(mode, str) or mode not in {"trade", "warehouse"}:
            raise NativeCaptureError("invalid_mode", "물교 또는 창고 모드를 선택하세요.", 422)
        geo = self.platform.geometry(target)
        skeleton = self._metadata(mode, context, geo, {"x": 0, "y": 0, "width": 8, "height": 8}, None)
        normalized = validate_capture_metadata(skeleton)["context"]
        with self.lock:
            if self.runtime_failed:
                raise NativeCaptureError("native_runtime_failed", "네이티브 캡처가 중단되었습니다. 앱을 다시 실행하세요.", 503)
            if self.closed:
                raise NativeCaptureError("capture_closed", "앱이 종료 중입니다.")
            self._clear()
            self.receiver, self.mode, self.target, self.context = receiver, mode.upper(), target, normalized
            self.deadline, self.receiver_busy = self.clock() + LEASE_SECONDS, False
            self.queue_count, self.queue_bytes = 0, 0
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
            return self.snapshot()

    def selected(self, generation, roi, geo):
        with self.lock:
            if generation != self.generation or self.state != "SELECTING":
                return
            if roi is None:
                self._clear("roi_cancelled")
                return
            try:
                current = self.platform.geometry(self.target)
                if current != geo:
                    raise NativeCaptureError("profile_changed", "게임 화면 환경이 바뀌었습니다. 다시 지정하세요.")
                roi = validate_roi(roi, current)
                key = self.mode.lower()
                old = self.profiles.get(key, {})
                profile = {"id": str(uuid.uuid4()), "version": 1,
                           "signature": signature(current), "roi": roi}
                if type(old.get("version")) is int:
                    profile["version"] = max(1, old["version"] + 1)
                profiles = {**self.profiles, key: profile}
                self.profile_path.parent.mkdir(parents=True, exist_ok=True)
                temporary = self.profile_path.with_suffix(".tmp")
                temporary.write_text(json.dumps({"version": 1, "profiles": profiles}, ensure_ascii=False), encoding="utf-8")
                temporary.replace(self.profile_path)
                self.profiles, self.profile, self.state = profiles, profile, "READY"
            except (NativeCaptureError, OSError, ValueError):
                self._clear("roi_save_failed")

    def registration_failed(self):
        with self.lock:
            if self.state == "READY":
                self.state, self.error = "ERROR", "hotkey_conflict"

    def wants_hotkey(self):
        with self.lock:
            return self.state == "READY" and not self.closed and not self.busy and not self.receiver_busy

    def heartbeat(self, receiver, generation, count, size, busy, context):
        if (type(count) is not int or not 0 <= count <= MAX_FRAMES or type(size) is not int
                or not 0 <= size <= MAX_BYTES or type(busy) is not bool):
            raise NativeCaptureError("invalid_queue", "대기열 상태가 올바르지 않습니다.", 422)
        self.maintenance()
        with self.lock:
            if receiver != self.receiver or generation != self.generation:
                return {**self.snapshot(), "frames": [], "owned": False}
            if not isinstance(context, dict) or context != self.context:
                self._clear("session_changed")
                return {**self.snapshot(), "frames": [], "owned": False}
            self.deadline = self.clock() + LEASE_SECONDS
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
                self.frames.pop(capture_id, None)

    def on_hotkey(self):
        self.maintenance()
        with self.lock:
            if not self.wants_hotkey() or not self.platform.is_foreground(self.target):
                return False
            if self.queue_count + len(self.frames) >= MAX_FRAMES or self.queue_bytes >= MAX_BYTES:
                self.error = "queue_full"
                return False
            self.busy = True
            args = (self.generation, self.target, copy.deepcopy(self.profile), copy.deepcopy(self.context), self.mode.lower())
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

    def _capture(self, generation, target, profile, context, mode):
        try:
            geo = self.platform.geometry(target)
            if signature(geo) != profile["signature"] or not self.platform.is_foreground(target):
                raise NativeCaptureError("profile_changed", "게임 화면 환경이 바뀌었습니다.")
            roi = validate_roi(profile["roi"], geo)
            metadata = self._metadata(mode, context, geo, roi, profile)
            png = self.platform.capture(screen_box(geo, roi))
            current = self.platform.geometry(target)
            if current != geo or not self.platform.is_foreground(target):
                raise NativeCaptureError("target_changed", "캡처 중 게임 창이 바뀌었습니다.")
            validate_capture_payload(json.dumps(metadata), png, content_type="image/png", expected_task=mode)
            with self.lock:
                if generation != self.generation or self.closed or self.clock() > self.deadline:
                    return
                if self.queue_count + len(self.frames) >= MAX_FRAMES:
                    raise NativeCaptureError("queue_full", "대기 이미지 개수 제한에 도달했습니다.")
                if self.queue_bytes + sum(len(v["png"]) for v in self.frames.values()) + len(png) > MAX_BYTES:
                    raise NativeCaptureError("queue_full", "대기 이미지의 전체 용량 제한에 도달했습니다.")
                self.frames[metadata["captureId"]] = {"metadata": metadata, "png": png,
                                                        "sha256": hashlib.sha256(png).hexdigest()}
                self.error = None
        except Exception as exc:
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
