import copy
import io
import json
import logging
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
from local_app.native_diagnostics import CaptureDiagnostics
from local_app.native_capture import NativeCaptureController, NativeCaptureError, MAX_BYTES, adjust_roi
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
        self.controller = NativeCaptureController(self.platform, Path(self.temp.name)/"profiles.json")
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
        self.controller.busy=True
        self.assertFalse(self.controller.on_hotkey())
        self.controller.busy=False
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
        self.controller = NativeCaptureController(self.platform, Path(self.temp.name)/"profiles.json")
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

    def test_target_validation_failure_records_exact_reason_before_stopping(self):
        self.prepare()
        with patch.object(self.platform,"geometry",side_effect=NativeCaptureError("target_unavailable","window is minimized")):
            self.controller.maintenance()
        event=next(e for e in self.controller.diagnostics.snapshot()["recent"] if e["event"]=="target_validation_failed")
        self.assertEqual(event["target"],"42");self.assertIn("window is minimized",event["detail"])
        self.assertEqual(self.controller.state,"STOPPED")

    def test_geometry_changes_require_new_profile_but_same_monitor_move_is_safe(self):
        self.prepare()
        self.platform.geo["left"] = -1800
        self.controller.maintenance()
        self.assertEqual(self.controller.state, "READY")
        for key, value in (("dpi", 192), ("width", 1600), ("monitor", "DISPLAY3:1920x1080"), ("mode", "windowed")):
            original = self.platform.geo[key]
            self.platform.geo[key] = value
            self.controller.maintenance()
            self.assertEqual(self.controller.state, "STOPPED", key)
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

    def test_mode_switch_cannot_drop_pending_or_in_flight_capture(self):
        self.prepare(); self.platform.release.clear()
        self.assertTrue(self.controller.on_hotkey())
        generation=self.controller.generation
        with self.assertRaises(NativeCaptureError): self.prepare("warehouse")
        self.assertEqual(self.controller.generation,generation)
        self.platform.release.set(); self.wait_capture()
        with self.assertRaises(NativeCaptureError): self.prepare("warehouse")
        self.assertEqual(len(self.controller.frames),1)
        self.controller.close()
        self.assertFalse(self.controller.snapshot()["available"])
        self.assertTrue(self.platform.stopped)

    def test_wrong_receiver_rejected_but_browser_delay_keeps_image(self):
        self.prepare(); packet=self.capture(); capture_id=packet["metadata"]["captureId"]
        with self.assertRaises(NativeCaptureError):self.controller.image(str(uuid.uuid4()),packet["generation"],capture_id)
        self.platform.foreground=False
        with patch("local_app.native_capture.time.monotonic",return_value=10000):self.controller.maintenance()
        self.assertTrue(self.controller.image(self.receiver,packet["generation"],capture_id))

    def test_browser_pause_and_receiver_busy_do_not_stop_native_capture(self):
        self.prepare(); self.heartbeat(busy=True)
        with patch("local_app.native_capture.time.monotonic",return_value=10000):self.controller.maintenance()
        self.assertEqual(self.controller.state,"READY")
        self.assertTrue(self.controller.on_hotkey());self.wait_capture()
        self.assertEqual(len(self.controller.frames),1)
        self.platform.foreground=False;self.controller.maintenance()
        self.assertEqual(self.controller.state,"READY")

    def test_context_change_discards_only_unacknowledged_frames_and_restarts(self):
        for mode in ("trade", "warehouse"):
            with self.subTest(mode=mode):
                self.prepare(mode);packet=self.capture();generation=self.controller.generation
                changed={**self.context,"baseRevision":self.context["baseRevision"]+1}
                result=self.heartbeat(context=changed)
                self.assertFalse(result["owned"]);self.assertEqual(result["frames"],[])
                self.assertEqual(self.controller.mode,"NONE");self.assertFalse(self.controller.frames)
                self.assertGreater(self.controller.generation,generation)
                with self.assertRaises(NativeCaptureError):self.controller.image(self.receiver,generation,packet["metadata"]["captureId"])
                events=self.controller.diagnostics.snapshot()["recent"]
                discarded=next(e for e in reversed(events) if e["event"]=="stale_frames_discarded")
                self.assertEqual(discarded["discardedCount"],1);self.assertEqual(discarded["discardedBytes"],packet["bytes"])
                self.context=changed
                self.controller.prepare(self.receiver,mode,"42",changed,select=False)
                self.assertEqual(self.controller.state,"READY")

    def test_context_change_invalidates_in_flight_result_without_stale_injection(self):
        self.prepare();self.platform.release.clear();self.assertTrue(self.controller.on_hotkey())
        generation=self.controller.generation;changed={**self.context,"baseRevision":1}
        self.heartbeat(context=changed)
        self.platform.release.set();self.wait_capture()
        self.assertFalse(self.controller.frames)
        self.assertGreater(self.controller.generation,generation)
        self.context=changed;self.controller.prepare(self.receiver,"trade","42",changed,select=False)
        self.assertEqual(self.controller.state,"READY")

    def test_frozen_browser_context_change_clears_multiple_frames_and_old_ack_is_harmless(self):
        self.prepare();generation=self.controller.generation
        for _ in range(3):self.assertTrue(self.controller.on_hotkey());self.wait_capture()
        packets=self.heartbeat()["frames"];self.assertEqual(len(packets),3)
        changed={**self.context,"sessionId":str(uuid.uuid4()),"sessionRevision":1}
        self.heartbeat(context=changed);self.assertFalse(self.controller.frames)
        self.context=changed;self.controller.prepare(self.receiver,"trade","42",changed,select=False)
        fresh=self.capture()
        self.controller.acknowledge(self.receiver,generation,packets[0]["metadata"]["captureId"])
        self.assertEqual(self.heartbeat()["frames"],[fresh])
        self.assertEqual(fresh["metadata"]["context"],changed)

    def test_target_process_replacement_stops_and_holds_frames_without_reusing_stale_roi(self):
        self.prepare();self.capture();self.platform.geo["pid"]=43
        self.controller.maintenance()
        self.assertEqual(self.controller.state,"STOPPED");self.assertEqual(self.controller.error,"target_unavailable")
        self.assertEqual(len(self.controller.frames),1);self.assertFalse(self.controller.on_hotkey())

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
        self.heartbeat();self.assertTrue(self.controller.on_hotkey());self.wait_capture()
        self.assertEqual(len(self.controller.frames),1)

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
        self.assertTrue(self.controller.wants_hotkey(), "controller retains pending state during hotkey conflict")

    def test_capture_rejection_for_pixel_busy_and_wrong_foreground(self):
        self.prepare();self.controller.busy=True
        self.assertFalse(self.controller.on_hotkey());self.assertEqual(self.controller.error,"capture_busy")
        self.controller.busy=False;self.platform.foreground=False
        self.assertFalse(self.controller.on_hotkey());self.assertEqual(self.controller.error,"foreground_required")
        self.platform.foreground=True;self.assertTrue(self.controller.on_hotkey());self.wait_capture()
        self.assertIsNone(self.controller.error)

    def test_move_region_preserves_pending_images_and_generation_and_uses_new_box(self):
        generation = self.prepare()
        self.assertTrue(self.controller.on_hotkey()); self.wait_capture()
        old_frame = next(iter(self.controller.frames.values()))
        old_profile = old_frame["metadata"]["profileId"]
        self.assertTrue(self.controller.begin_roi_adjustment())
        self.assertFalse(self.controller.on_hotkey())
        self.assertEqual(self.controller.state, "READY")
        moved = adjust_roi(self.roi, "", 140, 30, self.platform.geo)
        self.assertTrue(self.controller.update_roi(generation, moved, dict(self.platform.geo)))
        self.assertEqual(self.controller.generation, generation)
        self.assertEqual(len(self.controller.frames), 1)
        self.assertEqual(old_frame["metadata"]["nativeEvidence"]["roi"], self.roi)
        self.assertEqual(old_frame["metadata"]["profileId"], old_profile)
        self.assertTrue(self.controller.on_hotkey()); self.wait_capture()
        new_frame = list(self.controller.frames.values())[-1]
        self.assertEqual(new_frame["metadata"]["nativeEvidence"]["roi"], moved)
        self.assertNotEqual(new_frame["metadata"]["profileId"], old_profile)
        self.assertEqual(self.platform.boxes[-1], (-1680,10,-1600,60))
        with closing(NativeCaptureController(FakePlatform(),self.controller.profile_path)) as restored:
            self.assertEqual(restored.profiles["trade"]["roi"], moved)

    def test_region_move_resize_clamps_to_game_and_minimum_size(self):
        self.assertEqual(adjust_roi(self.roi,"",-200,-100,self.platform.geo),{**self.roi,"x":0,"y":0})
        self.assertEqual(adjust_roi(self.roi,"",5000,5000,self.platform.geo),{**self.roi,"x":1840,"y":1030})
        resized=adjust_roi(self.roi,"se",20,30,self.platform.geo)
        self.assertEqual(resized,{"x":100,"y":80,"width":100,"height":80})
        self.assertEqual(adjust_roi(self.roi,"nw",500,500,self.platform.geo), self.roi)

    def test_failed_region_save_preserves_previous_region_and_unblocks_input(self):
        generation=self.prepare(); previous=copy.deepcopy(self.controller.profile)
        self.assertTrue(self.controller.begin_roi_adjustment())
        with patch.object(self.controller,"_store_profile",side_effect=OSError("readonly profile")):
            self.assertFalse(self.controller.update_roi(generation,{**self.roi,"x":200},dict(self.platform.geo)))
        self.assertEqual(self.controller.profile,previous)
        self.assertFalse(self.controller.roi_adjusting)
        self.assertEqual(self.controller.error,"roi_save_failed")
        self.assertTrue(self.controller.wants_hotkey())

    def test_native_metadata_is_strict_and_cannot_impersonate_file(self):
        self.prepare()
        metadata = self.capture()["metadata"]
        for mutation in (lambda m: m.pop("nativeEvidence"), lambda m: m.update(sourceType="file"),
                         lambda m: m["nativeEvidence"].update(windowMode=[]),
                         lambda m: m["nativeEvidence"]["roi"].update(width=99),
                         lambda m: m["nativeEvidence"]["screenOrigin"].update(x=True)):
            invalid = copy.deepcopy(metadata); mutation(invalid)
            with self.assertRaises(RecognitionContractError): validate_capture_metadata(invalid)


    def test_roi_confirmation_does_not_capture_until_f10(self):
        self.prepare();self.assertEqual(self.controller.captured_count,0)
        self.assertFalse(self.controller.frames)
        self.assertTrue(self.controller.on_hotkey());self.wait_capture()
        self.assertEqual(self.controller.captured_count,1)

    def test_target_loss_stops_input_and_preserves_pending_frames(self):
        self.prepare();self.capture()
        with patch.object(self.platform,"geometry",side_effect=NativeCaptureError("target_unavailable","gone")):
            self.controller.maintenance()
        self.assertEqual(self.controller.state,"STOPPED");self.assertEqual(len(self.controller.frames),1)
        self.assertFalse(self.controller.wants_hotkey())

    def test_finish_retains_frames_until_ack_then_next_mode_can_start(self):
        generation=self.prepare();packet=self.capture();self.controller.finish()
        self.assertFalse(self.controller.wants_hotkey());self.platform.foreground=False
        self.assertEqual(len(self.heartbeat()["frames"]),1)
        self.assertTrue(self.controller.image(self.receiver,generation,packet["metadata"]["captureId"]))
        self.controller.acknowledge(self.receiver,generation,packet["metadata"]["captureId"])
        self.platform.foreground=True;self.prepare("warehouse")
        self.assertEqual(self.controller.mode,"WAREHOUSE")

    def test_attach_new_browser_retains_generation_and_frames(self):
        generation=self.prepare();packet=self.capture();replacement=str(uuid.uuid4())
        self.controller.attach(replacement)
        self.assertFalse(self.heartbeat()["owned"])
        self.assertEqual(self.controller.generation,generation)
        self.assertTrue(self.controller.image(replacement,generation,packet["metadata"]["captureId"]))

    def test_resize_preserves_old_capture_and_next_capture_has_new_size(self):
        generation=self.prepare();first=self.capture()
        self.assertTrue(self.controller.begin_roi_adjustment())
        resized=adjust_roi(self.roi,"se",20,30,self.platform.geo)
        self.assertTrue(self.controller.update_roi(generation,resized,self.platform.geo))
        self.assertTrue(self.controller.on_hotkey());self.wait_capture();frames=self.heartbeat()["frames"]
        self.assertEqual(len(frames),2);self.assertEqual(frames[0],first)
        self.assertEqual(frames[1]["metadata"]["frame"],{"width":100,"height":80})


class NativeApiTests(NativeFixture):
    def setUp(self):
        super().setUp()
        self.app = create_app(Path(self.temp.name)/"test.sqlite3", testing=True, native_capture=self.controller)
        self.client = self.app.test_client()
        self.headers = {"Origin": "http://localhost:18765", "Sec-Fetch-Site": "same-origin"}

    def post(self, data, headers=None):
        return self.client.post("/api/native-capture", json=data, base_url="http://localhost:18765", headers=self.headers if headers is None else headers)

    def test_commands_require_exact_origin_and_strict_shape(self):
        command = {"action": "prepare", "receiver": self.receiver, "mode": "trade", "target": "42", "context": self.context, "select": True, "count":0, "bytes":0}
        for headers in ({}, {"Origin": "http://evil.test"}, {"Origin": "http://127.0.0.1:18765"}, {**self.headers, "Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self.post(command, headers).status_code, 403)
        self.assertEqual(self.post({"action": []}).status_code, 422)
        self.assertEqual(self.post({**command, "extra": True}).status_code, 422)
        self.assertEqual(self.post(command).status_code, 200)
        generation = self.controller.generation
        self.assertEqual(self.post({"action": "disarm", "receiver": self.receiver, "generation": True}).status_code, 422)
        self.assertEqual(self.post({"action": "disarm", "receiver": self.receiver, "generation": generation}).get_json()["mode"], "NONE")

    def test_prepare_includes_current_browser_queue_limits_before_first_heartbeat(self):
        self.prepare()
        command={"action":"prepare","receiver":self.receiver,"mode":"trade","target":"42","context":self.context,"select":False,"count":100,"bytes":0}
        self.assertEqual(self.post(command).status_code,200)
        self.assertFalse(self.controller.on_hotkey());self.assertEqual(self.controller.error,"queue_full")
        self.heartbeat();self.assertTrue(self.controller.on_hotkey());self.wait_capture()
        self.assertEqual(len(self.controller.frames),1)
        command["count"]=True
        self.assertEqual(self.post(command).status_code,422);self.assertEqual(len(self.controller.frames),1)

    def test_diagnostics_retain_reason_and_reject_invalid_reason_without_reset(self):
        generation = self.prepare()
        command = {"action": "disarm", "receiver": self.receiver, "generation": generation, "reason": []}
        self.assertEqual(self.post(command).status_code, 422)
        self.assertEqual(self.controller.state, "READY")
        command["reason"] = "dialog_closed"
        self.assertEqual(self.post(command).status_code, 422)
        self.assertEqual(self.controller.state, "READY")
        command["reason"] = "finished"
        self.assertEqual(self.post(command).status_code, 200)
        response = self.client.get("/api/native-capture/diagnostics", base_url="http://localhost:18765")
        self.assertEqual(response.status_code, 200)
        events = response.get_json()["recent"]
        self.assertTrue(any(e["event"] == "session_disarmed" and e["reason"] == "finished" for e in events))
        self.assertTrue(any(e["event"] == "api_rejected" and e["code"] == "invalid_command" for e in events))

    def test_stop_and_attach_keep_pending_and_enforce_current_receiver(self):
        self.prepare();packet=self.capture();generation=self.controller.generation
        other=str(uuid.uuid4())
        command={"action":"stop","receiver":other,"generation":generation}
        self.assertEqual(self.post(command).status_code,409)
        self.assertEqual(self.controller.state,"READY")
        result=self.post({"action":"attach","receiver":other}).get_json()
        self.assertEqual(result["generation"],generation);self.assertEqual(result["pending"],1)
        command["receiver"]=self.receiver
        self.assertEqual(self.post(command).status_code,409)
        command["receiver"]=other
        self.assertEqual(self.post(command).get_json()["state"],"STOPPED")
        self.assertEqual(len(self.controller.frames),1)
        self.assertEqual(self.post({"action":"ack","receiver":other,"generation":generation,"captureId":packet["metadata"]["captureId"]}).get_json()["pending"],0)

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

    def test_native_warehouse_png_passes_existing_scan_bridge_only_on_explicit_request(self):
        self.prepare("warehouse");packet=self.capture();metadata=packet["metadata"]
        png=self.controller.image(self.receiver,packet["generation"],metadata["captureId"])
        before=self.client.get("/api/bootstrap").get_json()
        from local_app.backend.services import warehouse_scan
        output={"type":"master_inventory_patch","version":1,"items":{}}
        report={"input":{},"slots":[]}
        with patch.object(warehouse_scan,"convert",return_value=(output,report)) as scan:
            self.assertEqual(self.client.get("/api/bootstrap").get_json(),before);scan.assert_not_called()
            result=self.client.post("/api/warehouse-scan",base_url="http://localhost:18765",headers=self.headers,
                data={"image":(io.BytesIO(png),"native.png","image/png")})
            self.assertEqual(result.status_code,200,result.get_json());scan.assert_called_once()
        self.assertEqual(self.client.get("/api/bootstrap").get_json(),before,"recognition never applies inventory automatically")

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


class DiagnosticsLifecycleTests(unittest.TestCase):
    def test_repeated_diagnostics_close_does_not_retain_global_loggers(self):
        registered = set(logging.Logger.manager.loggerDict)
        with tempfile.TemporaryDirectory() as directory:
            for index in range(3):
                diagnostics = CaptureDiagnostics(Path(directory) / f"capture-{index}.jsonl")
                diagnostics.write("lifecycle_test")
                diagnostics.close()
                diagnostics.close()
                self.assertFalse(diagnostics.logger.handlers)
                events = [json.loads(line)["event"] for line in diagnostics.path.read_text(encoding="utf-8").splitlines()]
                self.assertIn("lifecycle_test", events)
        self.assertEqual(set(logging.Logger.manager.loggerDict), registered)


if __name__ == "__main__": unittest.main()
