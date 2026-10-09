import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from local_app.native_capture import NativeCaptureController
from local_app.native_win32 import Win32CapturePlatform
from .backend.test_native_capture import FakePlatform


@unittest.skipUnless(os.name == "nt", "Windows UI thread only")
class NativeWin32LifecycleTests(unittest.TestCase):
    def wait(self, predicate):
        deadline = time.monotonic() + 3
        while not predicate() and time.monotonic() < deadline: time.sleep(.01)
        self.assertTrue(predicate())

    def test_f10_registration_busy_unregister_retry_and_thread_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            platform = Win32CapturePlatform()
            controller = NativeCaptureController(platform, Path(folder)/"profiles.json")
            with patch.object(platform, "geometry", return_value=FakePlatform().geo), \
                 patch.object(platform.u, "RegisterHotKey", return_value=True) as register, \
                 patch.object(platform.u, "UnregisterHotKey", return_value=True) as unregister:
                controller.state = "READY"
                controller.start()
                try:
                    self.wait(lambda: platform.hotkey_registered)
                    register.assert_called_with(None, 0xBD0, 0x4000, 0x79)
                    controller.receiver_busy = True
                    self.wait(lambda: not platform.hotkey_registered)
                    self.assertGreaterEqual(unregister.call_count, 1)
                    register.return_value = False
                    controller.receiver_busy = False
                    self.wait(lambda: controller.error == "hotkey_conflict")
                    self.assertFalse(platform.hotkey_registered)
                    register.return_value = True
                    controller.state, controller.error = "READY", None
                    self.wait(lambda: platform.hotkey_registered)
                finally:
                    controller.close()
                self.assertFalse(platform.thread.is_alive())
                self.assertFalse(platform.hotkey_registered)
                self.assertGreaterEqual(unregister.call_count, 2)

    def test_runtime_failure_marks_provider_unavailable(self):
        with tempfile.TemporaryDirectory() as folder:
            platform = Win32CapturePlatform()
            controller = NativeCaptureController(platform, Path(folder)/"profiles.json")
            with patch.object(platform, "_dpi", side_effect=OSError("DPI unavailable")):
                controller.start()
                self.wait(lambda: controller.runtime_failed)
                controller.close()
            self.assertFalse(controller.snapshot()["available"])
            self.assertFalse(platform.thread.is_alive())

    def test_overlay_waits_for_actual_game_foreground_without_input_injection(self):
        with tempfile.TemporaryDirectory() as folder:
            platform = Win32CapturePlatform()
            controller = NativeCaptureController(platform, Path(folder)/"profiles.json")
            platform.controller = controller
            with patch.object(platform.u, "SetForegroundWindow", return_value=False), \
                 patch.object(platform, "_game_is_foreground", side_effect=[False, True]), \
                 patch.object(controller, "maintenance"), patch.object(platform.stopping, "wait"):
                platform._wait_for_game("42", controller.generation)
            from local_app.native_capture import NativeCaptureError
            with patch.object(platform.u, "SetForegroundWindow", return_value=False), \
                 patch.object(platform, "_game_is_foreground", return_value=False), \
                 patch("local_app.native_win32.time.monotonic", side_effect=[100, 131]):
                with self.assertRaises(NativeCaptureError) as failure:
                    platform._wait_for_game("42", controller.generation)
                self.assertEqual(failure.exception.code, "foreground_required")
            controller.close()

    def test_monitor_scale_detected_independently_from_game_window_dpi(self):
        import ctypes
        platform = Win32CapturePlatform()
        def monitor_scale(monitor, output):
            ctypes.cast(output, ctypes.POINTER(ctypes.c_int)).contents.value = 125
            return 0
        with patch.object(platform.shcore, "GetScaleFactorForMonitor", side_effect=monitor_scale):
            self.assertEqual(platform._monitor_dpi(1), 120)
        with patch.object(platform.shcore, "GetScaleFactorForMonitor", return_value=-1):
            from local_app.native_capture import NativeCaptureError
            with self.assertRaises(NativeCaptureError): platform._monitor_dpi(1)

    def test_target_validation_and_provider_reject_black_pixels(self):
        platform = Win32CapturePlatform()
        from PIL import Image
        from local_app.native_capture import NativeCaptureError
        with self.assertRaises(NativeCaptureError): platform.geometry("not-a-window")
        with patch("PIL.ImageGrab.grab", return_value=Image.new("RGB", (80, 50))) as grab:
            with self.assertRaises(NativeCaptureError) as failure:
                platform.capture((-100, -50, -20, 0))
            self.assertEqual(failure.exception.code, "black_frame")
            grab.assert_called_once_with(bbox=(-100, -50, -20, 0), all_screens=True)


    def test_game_keys_are_registered_only_while_game_is_foreground(self):
        from unittest.mock import Mock
        platform = Win32CapturePlatform()
        controller = Mock(state="READY", target="42")
        controller.snapshot.return_value = {"generation": 1, "busy": False}
        platform.controller = controller
        with patch.object(platform, "is_foreground", return_value=True), patch.object(platform, "_game_is_foreground", return_value=True), patch.object(platform, "geometry", return_value=FakePlatform().geo), \
             patch.object(platform, "_create_hud"), patch.object(platform.u, "RegisterHotKey", return_value=True) as register, \
             patch.object(platform.u, "SetWindowPos"), patch.object(platform.u, "ShowWindow"), patch.object(platform.u, "InvalidateRect"):
            platform._update_game_controls()
            self.assertTrue(platform.enter_registered)
            register.assert_any_call(None, 0xBD1, 0x4000, 13)
            register.assert_any_call(None, 0xBD2, 0x4000, 0x77)
            register.assert_any_call(None, 0xBD3, 0x4000, 27)
        with patch.object(platform, "is_foreground", return_value=False), patch.object(platform, "_game_is_foreground", return_value=False), patch.object(platform.u, "UnregisterHotKey", return_value=True) as unregister:
            platform._update_game_controls()
            self.assertFalse(platform.enter_registered)
            self.assertEqual(unregister.call_count, 3)

    def test_enter_f10_reselect_and_finish_route_without_browser_focus(self):
        from unittest.mock import Mock
        platform = Win32CapturePlatform(); platform.controller = Mock(target="42")
        with patch.object(platform, "is_foreground", return_value=True):
            for key in (0xBD0, 0xBD1, 0xBD2, 0xBD3): platform._handle_hotkey(key)
        self.assertEqual(platform.controller.on_hotkey.call_count, 2)
        platform.controller.reselect.assert_called_once(); platform.controller.finish.assert_called_once()
        with patch.object(platform, "is_foreground", return_value=False): platform._handle_hotkey(0xBD1)
        self.assertEqual(platform.controller.on_hotkey.call_count, 2)

    def test_physical_key_fallback_survives_missing_hotkey_messages_without_repeat(self):
        from unittest.mock import Mock
        platform = Win32CapturePlatform(); platform.controller = Mock(state="READY", target="42")
        held = {13}
        with patch.object(platform.u, "GetAsyncKeyState", side_effect=lambda key: 0x8000 if key in held else 0), \
             patch.object(platform, "_game_is_foreground", return_value=True), patch.object(platform, "is_foreground", return_value=True), patch("local_app.native_win32.time.monotonic", return_value=10):
            platform._poll_game_keys(); platform._poll_game_keys(); platform._handle_hotkey(0xBD1)
            platform.controller.on_hotkey.assert_called_once()
            held.clear(); platform._poll_game_keys()
            held.add(0x79)
            with patch("local_app.native_win32.time.monotonic", return_value=11): platform._poll_game_keys()
            self.assertEqual(platform.controller.on_hotkey.call_count, 2)
        with patch.object(platform.u, "GetAsyncKeyState", return_value=0x8000), patch.object(platform, "_game_is_foreground", return_value=False):
            platform._poll_game_keys()
        self.assertEqual(platform.controller.on_hotkey.call_count, 2)

    def test_real_panel_accepts_button_and_enter_and_ignores_held_key(self):
        import ctypes
        from ctypes import wintypes
        from unittest.mock import Mock
        platform = Win32CapturePlatform(); platform.controller = Mock()
        platform._create_hud()
        try:
            style = platform.u.GetWindowLongW(platform.hud, -20)
            self.assertFalse(style & 0x08000000)
            self.assertFalse(style & 0x20)
            self.assertEqual(len(platform.hud_buttons), 3)
            platform.u.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
            platform.u.SendMessageW.restype = ctypes.c_ssize_t
            self.assertNotEqual(platform.u.SendMessageW(platform.hud, 0x84, 0, 0), -1)
            platform.u.SendMessageW(platform.hud, 0x111, 101, 0)
            platform.u.SendMessageW(platform.hud, 0x100, 13, 0)
            platform.u.SendMessageW(platform.hud, 0x100, 13, 1 << 30)
            self.assertEqual(platform.controller.on_hotkey.call_count, 2)
            platform.u.SendMessageW(platform.hud, 0x111, 102, 0)
            platform.controller.reselect.assert_called_once()
            platform.u.SendMessageW(platform.hud, 0x111, 103, 0)
            platform.controller.finish.assert_called_once()
        finally:
            platform.u.DestroyWindow(platform.hud)
            platform.u.UnregisterClassW(platform.hud_class, platform.k.GetModuleHandleW(None))

    def test_real_ui_message_loop_repeated_panel_enter_reaches_capture_queue(self):
        import ctypes, uuid
        from ctypes import wintypes
        from PIL import Image
        with tempfile.TemporaryDirectory() as folder:
            platform = Win32CapturePlatform()
            controller = NativeCaptureController(platform, Path(folder)/"profiles.json")
            foreground = [42]
            def activate(hwnd): foreground[0] = hwnd; return True
            platform.u.PostMessageW.argtypes = [wintypes.HWND,wintypes.UINT,wintypes.WPARAM,wintypes.LPARAM]
            with patch.object(platform, "geometry", return_value=FakePlatform().geo), \
                 patch.object(platform, "select"), patch.object(platform.u, "GetForegroundWindow", side_effect=lambda:foreground[0]), \
                 patch.object(platform.u, "SetForegroundWindow", side_effect=activate), patch.object(platform.u, "ShowWindow"), \
                 patch.object(platform.u, "SetWindowPos"), patch.object(platform.u, "RegisterHotKey", return_value=True), \
                 patch.object(platform.u, "UnregisterHotKey", return_value=True), patch.object(platform.u, "GetAsyncKeyState", return_value=0), \
                 patch.object(platform.dwm, "DwmFlush", return_value=0), \
                 patch("PIL.ImageGrab.grab", side_effect=lambda **kw:Image.new("RGB",(80,50),(20,40,60))):
                receiver=str(uuid.uuid4()); context={"baseRevision":0,"sessionId":None,"sessionRevision":None}
                state=controller.prepare(receiver,"trade","42",context,select=True,game_session=True)
                controller.selected(state["generation"],{"x":100,"y":80,"width":80,"height":50},dict(FakePlatform().geo))
                controller.start()
                try:
                    self.wait(lambda:controller.captured_count==1 and len(platform.hud_buttons)==3)
                    for expected in (2,3):
                        self.wait(lambda:not controller.busy)
                        platform.u.PostMessageW(platform.hud_buttons[0],0x100,13,0)
                        self.wait(lambda:controller.captured_count==expected)
                    self.assertEqual(len(controller.frames),3)
                    self.assertEqual(foreground[0],platform.hud)
                    platform.u.PostMessageW(platform.hud,0x111,103,0)
                    self.wait(lambda:controller.state=="STOPPED")
                    self.assertEqual(len(controller.frames),3)
                finally: controller.close()

    def test_only_game_or_own_panel_is_a_valid_capture_foreground(self):
        from unittest.mock import Mock
        platform = Win32CapturePlatform(); platform.hud = 123
        platform.controller = Mock(target="42")
        with patch.object(platform.u, "GetForegroundWindow", return_value=123):
            self.assertTrue(platform.is_foreground("42"))
            self.assertFalse(platform.is_foreground("43"))
            self.assertFalse(platform._game_is_foreground("42"))
        with patch.object(platform.u, "GetForegroundWindow", return_value=456):
            self.assertFalse(platform.is_foreground("42"))

    def test_panel_capture_hides_controls_switches_to_game_and_restores_panel_focus(self):
        from PIL import Image
        from unittest.mock import Mock
        platform = Win32CapturePlatform(); platform.hud = 123
        platform.controller = Mock(target="42", state="READY")
        foreground=[123]
        def activate(hwnd): foreground[0]=hwnd; return True
        def grab(**kwargs):
            self.assertEqual(foreground[0], 42)
            self.assertTrue(platform.suppress_hud.is_set())
            return Image.new("RGB", (80,50), (20,40,60))
        with patch.object(platform.u, "GetForegroundWindow", side_effect=lambda:foreground[0]), \
             patch.object(platform.u, "SetForegroundWindow", side_effect=activate), \
             patch.object(platform.u, "ShowWindow") as show, patch.object(platform.dwm, "DwmFlush", return_value=0), \
             patch("PIL.ImageGrab.grab", side_effect=grab):
            self.assertTrue(platform.capture((0,0,80,50)))
            self.assertEqual(foreground[0], 123)
            show.assert_any_call(123, 0); show.assert_any_call(123, 4)

    def test_hud_is_hidden_before_pixels_are_read(self):
        from PIL import Image
        platform = Win32CapturePlatform(); platform.hud = 123
        def grab(**kwargs):
            self.assertTrue(platform.suppress_hud.is_set())
            return Image.new("RGB", (80, 50), (20, 40, 60))
        with patch.object(platform.u, "ShowWindow") as hide, patch.object(platform.dwm, "DwmFlush", return_value=0), patch("PIL.ImageGrab.grab", side_effect=grab):
            self.assertTrue(platform.capture((0, 0, 80, 50)))
            hide.assert_called_once_with(123, 0)
        self.assertFalse(platform.suppress_hud.is_set())


if __name__ == "__main__": unittest.main()
