import ctypes
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch
from ctypes import wintypes as w

from PIL import Image
from local_app.native_capture import NativeCaptureController, NativeCaptureError
from local_app.native_win32 import Win32CapturePlatform
from .backend.test_native_capture import FakePlatform


@unittest.skipUnless(os.name == "nt", "Windows UI thread only")
class NativeWin32LifecycleTests(unittest.TestCase):
    def wait(self, predicate):
        deadline = time.monotonic() + 4
        while not predicate() and time.monotonic() < deadline: time.sleep(.01)
        self.assertTrue(predicate())

    def events(self, controller):
        return [json.loads(line) for line in controller.diagnostics.path.read_text(encoding="utf-8").splitlines()]

    def test_real_raw_input_registration_and_window_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            platform = Win32CapturePlatform()
            controller = NativeCaptureController(platform, Path(folder)/"profiles.json")
            controller.start()
            try:
                self.wait(lambda: platform.raw_registered or controller.runtime_failed)
                self.assertFalse(controller.runtime_failed, self.events(controller))
                self.assertTrue(platform.display_excluded)
                self.assertTrue(platform.u.IsWindow(platform.hud))
                self.assertFalse(platform.u.IsWindowVisible(platform.hud))
            finally: controller.close()
            self.assertFalse(platform.thread.is_alive())
            self.assertFalse(platform.watchdog.is_alive())
            self.assertFalse(platform.raw_registered)

    def test_runtime_exception_has_traceback_and_unavailable_status(self):
        with tempfile.TemporaryDirectory() as folder:
            platform = Win32CapturePlatform()
            controller = NativeCaptureController(platform, Path(folder)/"profiles.json")
            with patch.object(platform, "_dpi", side_effect=OSError("DPI unavailable")):
                controller.start(); self.wait(lambda: controller.runtime_failed); controller.close()
            failure = next(e for e in self.events(controller) if e["event"] == "native_ui_failed")
            self.assertIn("DPI unavailable", failure["traceback"])
            self.assertFalse(controller.snapshot()["available"])

    def test_global_f10_stays_registered_during_capture_and_receiver_busy(self):
        with tempfile.TemporaryDirectory() as folder:
            platform = Win32CapturePlatform()
            controller = NativeCaptureController(platform, Path(folder)/"profiles.json")
            controller.state = "READY"
            with patch.object(platform.u, "RegisterHotKey", return_value=True) as register, patch.object(platform.u, "UnregisterHotKey", return_value=True) as unregister:
                controller.start()
                try:
                    self.wait(lambda: platform.hotkey_registered)
                    controller.busy = controller.receiver_busy = True
                    time.sleep(.1)
                    self.assertTrue(platform.hotkey_registered)
                    register.assert_called_once_with(None, 0xBD0, 0x4000, 0x79)
                    unregister.assert_not_called()
                finally: controller.busy = False; controller.close()
                self.assertFalse(platform.hotkey_registered)

    def test_raw_key_releases_and_deduplicates_all_three_paths(self):
        with tempfile.TemporaryDirectory() as folder:
            platform = Win32CapturePlatform()
            controller = NativeCaptureController(platform, Path(folder)/"profiles.json")
            platform.controller = controller; controller.state = "READY"; controller.target = "42"
            with patch.object(platform, "is_foreground", return_value=True), patch.object(controller, "on_hotkey") as capture, patch("local_app.native_win32.time.monotonic", return_value=10):
                platform._raw_key(13, False); platform._raw_key(13, False)
                platform._handle_panel_key(13); platform._handle_panel_key(13, 1 << 30)
                capture.assert_called_once()
                platform._raw_key(13, True)
                with patch("local_app.native_win32.time.monotonic", return_value=11): platform._raw_key(13, False)
                self.assertEqual(capture.call_count, 2)
                platform._raw_key(0x79, False); platform._key_action(0x79, "hotkey")
                self.assertEqual(capture.call_count, 3)
            controller.close()

    def test_raw_input_buffer_decoding_and_other_keys_not_logged(self):
        with tempfile.TemporaryDirectory() as folder:
            platform = Win32CapturePlatform()
            controller = NativeCaptureController(platform, Path(folder)/"profiles.json")
            platform.controller = controller; controller.state = "READY"; controller.target = "42"
            header = platform.RawHeader(1, 40, None, 0)
            keyboard = platform.RawKeyboard(28, 0, 0, 13, 0x100, 0)
            payload = bytes(header) + bytes(keyboard)
            def read(handle, command, buffer, size, header_size):
                ctypes.cast(size, ctypes.POINTER(w.UINT)).contents.value = len(payload)
                if buffer is None: return 0
                ctypes.memmove(buffer, payload, len(payload)); return len(payload)
            with patch.object(platform.u, "GetRawInputData", side_effect=read), patch.object(platform, "is_foreground", return_value=True), patch.object(controller, "on_hotkey") as capture:
                platform._raw_input(1); capture.assert_called_once()
                platform._raw_key(65, False)
            keys = [e["key"] for e in self.events(controller) if e["event"] == "key_received"]
            self.assertEqual(keys, [13]); controller.close()

    def test_other_foreground_rejection_is_logged(self):
        with tempfile.TemporaryDirectory() as folder:
            platform = Win32CapturePlatform(); controller = NativeCaptureController(platform, Path(folder)/"profiles.json")
            platform.controller = controller; controller.state = "READY"; controller.target = "42"
            with patch.object(platform, "is_foreground", return_value=False), patch.object(controller, "on_hotkey") as capture:
                platform._raw_key(13, False); capture.assert_not_called()
            self.assertEqual(self.events(controller)[-1]["reason"], "other_foreground"); controller.close()

    def test_real_button_click_and_panel_enter_queue_without_hiding_or_focus_calls(self):
        with tempfile.TemporaryDirectory() as folder:
            platform = Win32CapturePlatform(); controller = NativeCaptureController(platform, Path(folder)/"profiles.json")
            with patch.object(platform, "geometry", return_value=FakePlatform().geo), patch.object(platform, "select"), patch.object(platform, "is_foreground", return_value=True), patch.object(platform, "_update_game_controls"), patch("PIL.ImageGrab.grab", side_effect=lambda **kw:Image.new("RGB", (80,50),(20,40,60))), patch.object(platform.u, "ShowWindow") as show, patch.object(platform.u, "SetForegroundWindow") as focus:
                controller.prepare(str(uuid.uuid4()), "trade", "42", {"baseRevision":0,"sessionId":None,"sessionRevision":None}, select=True)
                controller.selected(controller.generation, {"x":100,"y":80,"width":80,"height":50}, dict(FakePlatform().geo))
                controller.start()
                try:
                    self.wait(lambda: platform.raw_registered)
                    platform.u.SendMessageW.argtypes = [w.HWND,w.UINT,w.WPARAM,w.LPARAM]
                    platform.u.SendMessageW.restype = ctypes.c_ssize_t
                    for count in (1,2):
                        platform.u.SendMessageW(platform.hud_buttons[0], 0x00f5, 0, 0) # BM_CLICK on a real BUTTON.
                        self.wait(lambda:controller.captured_count == count and not controller.busy)
                    platform.u.PostMessageW(platform.hud_buttons[0],0x100,13,0)
                    self.wait(lambda:controller.captured_count == 3 and not controller.busy)
                    self.assertEqual(len(controller.frames),3)
                    show.assert_not_called(); focus.assert_not_called()
                    # Focus notifications must not trigger capture.
                    platform.u.SendMessageW(platform.hud,0x111,101 | (6 << 16),0)
                    self.assertEqual(controller.captured_count,3)
                finally: controller.close()

    def test_panel_visibility_does_not_follow_foreground_or_busy(self):
        with tempfile.TemporaryDirectory() as folder:
            platform = Win32CapturePlatform(); controller = NativeCaptureController(platform, Path(folder)/"profiles.json")
            platform.controller = controller; controller.state = "READY"; controller.target = "42"
            platform._create_hud()
            try:
                with patch.object(platform, "geometry", return_value=FakePlatform().geo), patch.object(platform.u,"SetWindowPos",return_value=True), patch.object(platform.u,"ShowWindow") as show, patch.object(platform.u,"SetForegroundWindow") as focus, patch.object(platform.u,"EnableWindow") as enable:
                    platform._update_game_controls()
                    controller.busy = True
                    platform._update_game_controls(); platform._update_game_controls()
                    show.assert_called_once_with(platform.hud,4)
                    focus.assert_not_called(); enable.assert_not_called()
            finally:
                platform.u.DestroyWindow(platform.hud)
                platform.u.UnregisterClassW(platform.hud_class,platform.k.GetModuleHandleW(None))
                controller.busy=False; controller.close()

    def test_capture_records_rejection_failure_and_disarm_before_reset(self):
        with tempfile.TemporaryDirectory() as folder:
            platform=FakePlatform(); controller=NativeCaptureController(platform,Path(folder)/"profiles.json")
            state=controller.prepare(str(uuid.uuid4()),"trade","42",{"baseRevision":0,"sessionId":None,"sessionRevision":None},select=True)
            controller.selected(state["generation"],{"x":100,"y":80,"width":80,"height":50},dict(platform.geo))
            controller.receiver_busy=True; self.assertFalse(controller.on_hotkey())
            controller.receiver_busy=False
            with patch.object(platform,"capture",side_effect=OSError("capture failure")):
                self.assertTrue(controller.on_hotkey()); self.wait(lambda:not controller.busy)
            controller.disarm(); controller.close()
            events=self.events(controller)
            self.assertTrue(any(e["event"]=="capture_rejected" and e["reason"]=="busy_or_inactive" for e in events))
            self.assertTrue(any(e["event"]=="capture_failed" and "capture failure" in e["traceback"] for e in events))
            self.assertTrue(any(e["event"]=="session_cleared" and e["target"]=="42" for e in events))

    def test_foreground_game_child_matches_process_and_other_process_does_not(self):
        platform=Win32CapturePlatform()
        with patch.object(platform.u,"GetForegroundWindow",return_value=84), patch.object(platform,"_window_pid",side_effect=lambda hwnd: 5620 if hwnd in (42,84) else 7000):
            self.assertTrue(platform._game_is_foreground("42"))
            self.assertFalse(platform._game_is_foreground("43"))

    def test_window_callback_exception_is_persisted_instead_of_swallowed_by_ctypes(self):
        with tempfile.TemporaryDirectory() as folder:
            platform=Win32CapturePlatform(); controller=NativeCaptureController(platform,Path(folder)/"profiles.json")
            platform.controller=controller
            def fail(*args): raise RuntimeError("window callback failed")
            callback=platform._window_callback(fail)
            callback(None,0x111,0,0)
            failure=self.events(controller)[-1]
            self.assertEqual(failure["event"],"window_callback_failed")
            self.assertIn("window callback failed",failure["traceback"])
            controller.close()

    def test_target_validation_and_black_frame_rejection(self):
        platform=Win32CapturePlatform()
        with self.assertRaises(NativeCaptureError): platform.geometry("not-a-window")
        with patch("PIL.ImageGrab.grab",return_value=Image.new("RGB",(80,50))):
            with self.assertRaises(NativeCaptureError) as failure: platform.capture((0,0,80,50))
            self.assertEqual(failure.exception.code,"black_frame")


if __name__ == "__main__": unittest.main()
