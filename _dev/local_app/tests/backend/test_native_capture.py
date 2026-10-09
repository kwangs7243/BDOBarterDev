import copy
import io
import json
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from contextlib import closing
from unittest.mock import patch

from PIL import Image

from local_app.backend.app import create_app
from local_app.backend.recognition_contracts import RecognitionContractError, validate_capture_metadata
from local_app.native_capture import NativeCaptureController, NativeCaptureError, MAX_BYTES, LEASE_SECONDS
from .test_trade_batch_runtime import ReadyRuntime, fake_worker


class FakePlatform:
    hotkey_registered = False
    foreground = True
    stopped = False

    def __init__(self):
        self.geo = {"identity": "c:/game/blackdesert64.exe", "pid": 42,
                    "width": 1920, "height": 1080, "left": -1920, "top": -100,
                    "dpi": 144, "monitor": "DISPLAY2:1920x1080", "mode": "borderless"}
        self.boxes = []
        self.release = threading.Event()
        self.release.set()

    def start(self, controller): pass
    def stop(self): self.stopped = True
    def cancel_selection(self): pass
    def targets(self): return [{"id": "42", "title": "검은사막"}]
    def geometry(self, target):
        if target != "42": raise NativeCaptureError("target_unavailable", "Missing target")
        return dict(self.geo)
    def is_foreground(self, target): return self.foreground
    def select(self, target, generation): self.selection = (target, generation)
    def capture(self, box):
        self.boxes.append(box)
        if not self.release.wait(3): raise TimeoutError()
        output = io.BytesIO()
        Image.new("RGB", (box[2]-box[0], box[3]-box[1]), (20, 40, 60)).save(output, format="PNG")
        return output.getvalue()


class NativeFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.platform = FakePlatform()
        self.now = 100
        self.controller = NativeCaptureController(self.platform, Path(self.temp.name)/"profiles.json", clock=lambda: self.now)
        self.receiver = str(uuid.uuid4())
        self.context = {"baseRevision": 0, "sessionId": None, "sessionRevision": None}
        self.roi = {"x": 100, "y": 80, "width": 80, "height": 50}

    def tearDown(self):
        self.platform.release.set()
        self.wait_capture()
        self.controller.close()
        self.temp.cleanup()

    def wait_capture(self):
        deadline = time.monotonic() + 3
        while self.controller.busy and time.monotonic() < deadline: time.sleep(.005)
        self.assertFalse(self.controller.busy)

    def prepare(self, mode="trade", select=True):
        result = self.controller.prepare(self.receiver, mode, "42", self.context, select=select)
        if select: self.controller.selected(result["generation"], self.roi, dict(self.platform.geo))
        return self.controller.generation

    def heartbeat(self, *, count=0, size=0, busy=False, context=None, generation=None):
        return self.controller.heartbeat(self.receiver, self.controller.generation if generation is None else generation,
                                         count, size, busy, self.context if context is None else context)

    def capture(self):
        self.assertTrue(self.controller.on_hotkey())
        self.wait_capture()
        result = self.heartbeat()
        self.assertEqual(len(result["frames"]), 1, result)
        return result["frames"][0]



class NativeCaptureTests(NativeFixture):
    def test_game_foreground_pixels_and_negative_physical_coordinates(self):
        self.prepare()
        packet = self.capture()
        self.assertEqual(self.platform.boxes, [(-1820, -20, -1740, 30)])
        metadata = validate_capture_metadata(packet["metadata"])
        self.assertEqual(metadata["sourceType"], "native-screen")
        self.assertEqual(metadata["observed"]["windowsDpi"], 144)
        self.assertIsNone(metadata["observed"]["gameResolution"])
        self.assertEqual(metadata["nativeEvidence"]["provider"], "gdi")
        self.assertEqual(metadata["nativeEvidence"]["roi"], self.roi)
        self.assertEqual(metadata["profileId"], self.controller.profile["id"])
        self.assertEqual(packet["bytes"], len(self.controller.image(self.receiver, packet["generation"], metadata["captureId"])))

    def test_only_prepared_foreground_not_busy_can_capture(self):
        self.assertFalse(self.controller.on_hotkey())
        self.prepare()
        self.platform.foreground = False
        self.assertFalse(self.controller.on_hotkey())
        self.platform.foreground = True
        self.heartbeat(busy=True)
        self.assertFalse(self.controller.on_hotkey())
        self.heartbeat()
        self.platform.release.clear()
        self.assertTrue(self.controller.on_hotkey())
        self.assertFalse(self.controller.on_hotkey())
        self.platform.release.set()
        self.wait_capture()

    def test_distinct_modes_and_saved_profiles_survive_restart(self):
        trade_generation = self.prepare()
        trade_id = self.controller.profile["id"]
        self.prepare("warehouse")
        self.assertNotEqual(self.controller.profile["id"], trade_id)
        self.assertFalse(self.heartbeat(generation=trade_generation)["owned"])
        packet = self.capture()
        self.assertEqual(packet["metadata"]["taskType"], "warehouse")
        self.controller.close()
        self.controller = NativeCaptureController(self.platform, Path(self.temp.name)/"profiles.json", clock=lambda: self.now)
        self.prepare(select=False)
        self.assertEqual(self.controller.profile["id"], trade_id)

    def test_cancel_preserves_profile_and_no_roi_is_not_ready(self):
        with self.assertRaises(NativeCaptureError): self.prepare(select=False)
        self.prepare()
        before = copy.deepcopy(self.controller.profiles)
        result = self.controller.prepare(self.receiver, "trade", "42", self.context, select=True)
        self.controller.selected(result["generation"], None, self.platform.geo)
        self.assertEqual(self.controller.profiles, before)
        self.assertEqual(self.controller.mode, "NONE")
        self.prepare(select=False)
        self.assertTrue(self.controller.wants_hotkey())

    def test_geometry_changes_require_new_profile_but_same_monitor_move_is_safe(self):
        self.prepare()
        self.platform.geo["left"] = -1800
        self.controller.maintenance()
        self.assertEqual(self.controller.state, "READY")
        for key, value in (("dpi", 192), ("width", 1600), ("monitor", "DISPLAY3:1920x1080"), ("mode", "windowed")):
            original = self.platform.geo[key]
            self.platform.geo[key] = value
            self.controller.maintenance()
            self.assertEqual(self.controller.mode, "NONE", key)
            with self.assertRaises(NativeCaptureError): self.prepare(select=False)
            self.platform.geo[key] = original
            self.prepare(select=False)

    def test_target_move_during_selection_rejects_and_invalid_roi_is_not_saved(self):
        result = self.controller.prepare(self.receiver, "trade", "42", self.context, select=True)
        geo = dict(self.platform.geo)
        self.platform.geo["left"] += 20
        self.controller.selected(result["generation"], self.roi, geo)
        self.assertEqual(self.controller.mode, "NONE")
        result = self.controller.prepare(self.receiver, "trade", "42", self.context, select=True)
        self.controller.selected(result["generation"], {**self.roi, "x": -1}, self.platform.geo)
        self.assertFalse(self.controller.profiles)

    def test_lease_close_and_generation_drop_in_flight_capture(self):
        self.prepare()
        self.platform.release.clear()
        self.assertTrue(self.controller.on_hotkey())
        old = self.controller.generation
        self.prepare("warehouse")
        self.controller.disarm(self.receiver, old)
        self.assertEqual(self.controller.mode, "WAREHOUSE")
        self.platform.release.set()
        self.wait_capture()
        self.assertFalse(self.controller.frames)
        self.now += LEASE_SECONDS + 1
        self.controller.maintenance()
        self.assertEqual(self.controller.mode, "NONE")
        self.assertFalse(self.controller.wants_hotkey())
        self.prepare()
        self.controller.close()
        self.assertFalse(self.controller.snapshot()["available"])
        self.assertTrue(self.platform.stopped)

    def test_expired_image_and_wrong_receiver_never_deliver(self):
        self.prepare()
        packet = self.capture()
        capture_id = packet["metadata"]["captureId"]
        with self.assertRaises(NativeCaptureError): self.controller.image(str(uuid.uuid4()), packet["generation"], capture_id)
        self.now += LEASE_SECONDS + 1
        with self.assertRaises(NativeCaptureError): self.controller.image(self.receiver, packet["generation"], capture_id)

    def test_background_browser_tick_delay_does_not_expire_prepared_input(self):
        self.prepare()
        for _ in range(3):
            self.now += 65
            self.controller.maintenance()
            self.assertEqual(self.controller.state, "READY")
            self.assertTrue(self.heartbeat()["owned"])
        self.capture()
        self.now += LEASE_SECONDS + 1
        self.controller.maintenance()
        self.assertEqual(self.controller.mode, "NONE")
        self.assertFalse(self.controller.frames)

    def test_session_change_disarms_without_delivering_old_capture(self):
        for key, value in (("sessionId", str(uuid.uuid4())), ("sessionRevision", 1), ("baseRevision", 1)):
            self.prepare()
            self.capture()
            result = self.heartbeat(context={**self.context, key: value})
            self.assertFalse(result["owned"])
            self.assertFalse(result["frames"])
            self.assertFalse(self.controller.frames)

    def test_queue_limits_pending_retry_and_idempotent_ack(self):
        self.prepare()
        self.heartbeat(count=100)
        self.assertFalse(self.controller.on_hotkey())
        self.heartbeat(size=MAX_BYTES)
        self.assertFalse(self.controller.on_hotkey())
        self.heartbeat(count=98)
        for _ in range(2):
            self.assertTrue(self.controller.on_hotkey()); self.wait_capture()
        self.assertFalse(self.controller.on_hotkey())
        first = self.heartbeat()["frames"][0]
        self.assertEqual(self.heartbeat()["frames"][0], first)
        self.controller.acknowledge("other", first["generation"], first["metadata"]["captureId"])
        self.assertEqual(len(self.controller.frames), 2)
        for _ in range(2): self.controller.acknowledge(self.receiver, first["generation"], first["metadata"]["captureId"])
        self.assertEqual(len(self.controller.frames), 1)
        self.controller.frames.clear()
        self.heartbeat(size=MAX_BYTES-1)
        self.assertTrue(self.controller.on_hotkey()); self.wait_capture()
        self.assertEqual(self.controller.error, "queue_full")
        self.assertFalse(self.controller.frames)

    def test_capture_failure_focus_change_and_hotkey_collision_are_explicit(self):
        self.prepare()
        with patch.object(self.platform, "capture", side_effect=OSError("capture failed")):
            self.assertTrue(self.controller.on_hotkey()); self.wait_capture()
        self.assertEqual(self.controller.error, "pixel_capture_failed")
        self.assertFalse(self.controller.frames)
        def capture_and_move(box):
            data = FakePlatform.capture(self.platform, box)
            self.platform.foreground = False
            return data
        with patch.object(self.platform, "capture", side_effect=capture_and_move):
            self.assertTrue(self.controller.on_hotkey()); self.wait_capture()
        self.assertEqual(self.controller.error, "target_changed")
        self.assertFalse(self.controller.frames)
        self.controller.registration_failed()
        self.assertEqual(self.controller.error, "hotkey_conflict")
        self.assertTrue(self.controller.wants_hotkey(), "Enter must remain usable when F10 registration fails")

    def test_rejected_capture_reports_busy_and_wrong_foreground(self):
        self.prepare()
        self.controller.receiver_busy = True
        self.assertFalse(self.controller.on_hotkey())
        self.assertEqual(self.controller.error, "capture_busy")
        self.controller.receiver_busy = False; self.platform.foreground = False
        self.assertFalse(self.controller.on_hotkey())
        self.assertEqual(self.controller.error, "foreground_required")
        self.platform.foreground = True
        self.assertTrue(self.controller.on_hotkey()); self.wait_capture()
        self.assertIsNone(self.controller.error)

    def test_native_metadata_is_strict_and_cannot_impersonate_file(self):
        self.prepare()
        metadata = self.capture()["metadata"]
        for mutation in (lambda m: m.pop("nativeEvidence"), lambda m: m.update(sourceType="file"),
                         lambda m: m["nativeEvidence"].update(windowMode=[]),
                         lambda m: m["nativeEvidence"]["roi"].update(width=99),
                         lambda m: m["nativeEvidence"]["screenOrigin"].update(x=True)):
            invalid = copy.deepcopy(metadata); mutation(invalid)
            with self.assertRaises(RecognitionContractError): validate_capture_metadata(invalid)


    def test_share_session_enter_select_captures_first_image(self):
        generation = self.controller.prepare(self.receiver, "trade", "42", self.context, select=True, game_session=True)["generation"]
        self.assertFalse(self.controller.frames)
        self.controller.selected(generation, self.roi, dict(self.platform.geo))
        self.wait_capture()
        self.assertEqual(self.controller.captured_count, 1)
        self.assertEqual(len(self.heartbeat()["frames"]), 1)
        self.assertTrue(self.controller.on_hotkey())
        self.wait_capture()
        self.assertEqual(self.controller.captured_count, 2)

    def test_game_session_survives_browser_pause_but_expires_after_game_leaves(self):
        generation = self.controller.prepare(self.receiver, "trade", "42", self.context, select=True, game_session=True)["generation"]
        self.controller.selected(generation, self.roi, dict(self.platform.geo)); self.wait_capture()
        self.now += 600
        self.controller.maintenance()
        self.assertEqual(self.controller.state, "READY")
        self.assertTrue(self.controller.on_hotkey()); self.wait_capture()
        self.platform.foreground = False
        self.now += LEASE_SECONDS + 1
        self.controller.maintenance()
        self.assertEqual(self.controller.mode, "NONE")

    def test_game_finish_keeps_completed_frames_until_browser_acknowledges(self):
        generation = self.controller.prepare(self.receiver, "trade", "42", self.context, select=True, game_session=True)["generation"]
        self.controller.selected(generation, self.roi, dict(self.platform.geo)); self.wait_capture()
        self.controller.finish()
        self.assertFalse(self.controller.wants_hotkey())
        self.platform.foreground = False; self.now += 600
        packet = self.heartbeat()["frames"][0]
        self.assertEqual(self.controller.state, "STOPPED")
        self.assertTrue(self.controller.image(self.receiver, generation, packet["metadata"]["captureId"]))
        self.controller.acknowledge(self.receiver, generation, packet["metadata"]["captureId"])
        self.assertFalse(self.controller.frames)

    def test_cancel_reselect_keeps_old_roi_and_pending_images(self):
        generation = self.controller.prepare(self.receiver, "trade", "42", self.context, select=True, game_session=True)["generation"]
        self.controller.selected(generation, self.roi, dict(self.platform.geo)); self.wait_capture()
        first = self.heartbeat()["frames"][0]
        self.controller.reselect()
        self.controller.selected(generation, None, dict(self.platform.geo))
        self.assertEqual(self.controller.state, "READY")
        self.assertEqual(self.heartbeat()["frames"][0], first)
        self.assertTrue(self.controller.on_hotkey()); self.wait_capture()
        self.assertEqual(self.controller.captured_count, 2)

    def test_game_reselect_preserves_existing_capture_and_captures_new_region(self):
        generation = self.controller.prepare(self.receiver, "trade", "42", self.context, select=True, game_session=True)["generation"]
        self.controller.selected(generation, self.roi, dict(self.platform.geo)); self.wait_capture()
        first = self.heartbeat()["frames"][0]
        self.controller.reselect()
        self.assertEqual(self.controller.state, "SELECTING")
        self.controller.selected(generation, {**self.roi, "x": 120}, dict(self.platform.geo)); self.wait_capture()
        frames = self.heartbeat()["frames"]
        self.assertEqual(len(frames), 2)
        self.assertEqual(frames[0], first)
        self.assertEqual(frames[1]["metadata"]["nativeEvidence"]["roi"]["x"], 120)


class NativeApiTests(NativeFixture):
    def setUp(self):
        super().setUp()
        self.app = create_app(Path(self.temp.name)/"test.sqlite3", testing=True, native_capture=self.controller)
        self.client = self.app.test_client()
        self.headers = {"Origin": "http://localhost:18765", "Sec-Fetch-Site": "same-origin"}

    def post(self, data, headers=None):
        return self.client.post("/api/native-capture", json=data, base_url="http://localhost:18765", headers=self.headers if headers is None else headers)

    def test_commands_require_exact_origin_and_strict_shape(self):
        command = {"action": "prepare", "receiver": self.receiver, "mode": "trade", "target": "42", "context": self.context, "select": True}
        for headers in ({}, {"Origin": "http://evil.test"}, {"Origin": "http://127.0.0.1:18765"}, {**self.headers, "Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self.post(command, headers).status_code, 403)
        self.assertEqual(self.post({"action": []}).status_code, 422)
        self.assertEqual(self.post({**command, "extra": True}).status_code, 422)
        self.assertEqual(self.post(command).status_code, 200)
        generation = self.controller.generation
        self.assertEqual(self.post({"action": "disarm", "receiver": self.receiver, "generation": True}).status_code, 422)
        self.assertEqual(self.post({"action": "disarm", "receiver": self.receiver, "generation": generation}).get_json()["mode"], "NONE")

    def test_png_bridge_does_not_mutate_inventory_or_trigger_ocr(self):
        before = self.client.get("/api/bootstrap").get_json()
        self.prepare()
        packet = self.capture()
        with patch.object(self.app.extensions["trade_batch_runtime"], "recognize_live") as ocr:
            url = f"/api/native-capture/{packet['metadata']['captureId']}.png?receiver={self.receiver}&generation={packet['generation']}"
            response = self.client.get(url)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.mimetype, "image/png")
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertEqual(self.client.get("/api/bootstrap").get_json(), before)
            ocr.assert_not_called()
        self.assertEqual(self.client.get(url.replace(self.receiver, str(uuid.uuid4()))).status_code, 404)
        self.post({"action": "ack", "receiver": self.receiver, "generation": packet["generation"], "captureId": packet["metadata"]["captureId"]})
        self.assertEqual(self.client.get(url).status_code, 404)

    def test_native_capture_is_accepted_by_existing_trade_ocr_and_feedback(self):
        self.prepare()
        packet = self.capture()
        self.app.extensions["trade_batch_runtime"] = ReadyRuntime(runner=fake_worker)
        metadata = packet["metadata"]
        capture = {"captureId": metadata["captureId"], "metadata": metadata}
        batch = {"version": 1, "batchId": str(uuid.uuid4()), "captures": [capture]}
        png = self.controller.image(self.receiver, packet["generation"], metadata["captureId"])
        response = self.client.post("/api/recognition/trade-live-list", base_url="http://localhost:18765", headers=self.headers,
            data={"batch": json.dumps(batch), "image": (io.BytesIO(png), "native.png", "image/png")})
        self.assertEqual(response.status_code, 200, response.get_json())
        records = self.app.extensions["bdo_storage"]
        import sqlite3
        with closing(sqlite3.connect(records.database_path)) as db:
            saved = db.execute("SELECT details_json FROM trade_correction").fetchone()
        self.assertEqual(json.loads(saved[0])["metadata"]["nativeEvidence"], metadata["nativeEvidence"])


if __name__ == "__main__": unittest.main()
