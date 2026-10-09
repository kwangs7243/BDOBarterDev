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
                 patch.object(platform, "is_foreground", side_effect=[False, True]), \
                 patch.object(controller, "maintenance"), patch.object(platform.stopping, "wait"):
                platform._wait_for_game("42", controller.generation)
            from local_app.native_capture import NativeCaptureError
            with patch.object(platform.u, "SetForegroundWindow", return_value=False), \
                 patch.object(platform, "is_foreground", return_value=False), \
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


if __name__ == "__main__": unittest.main()
