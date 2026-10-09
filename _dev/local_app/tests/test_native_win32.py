import ctypes
import io
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

    def test_runtime_exception_has_traceback_and_unavailable_status(self):
        with tempfile.TemporaryDirectory() as folder:
            platform = Win32CapturePlatform()
            controller = NativeCaptureController(platform, Path(folder)/"profiles.json")
            with patch.object(platform, "_dpi", side_effect=OSError("DPI unavailable")):
                controller.start(); self.wait(lambda: controller.runtime_failed); controller.close()
            failure = next(e for e in self.events(controller) if e["event"] == "native_ui_failed")
            self.assertIn("DPI unavailable", failure["traceback"])
            self.assertFalse(controller.snapshot()["available"])

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

    def test_real_frame_shape_has_clickable_border_and_hollow_game_interior(self):
        with tempfile.TemporaryDirectory() as folder:
            platform=Win32CapturePlatform(); controller=NativeCaptureController(platform,Path(folder)/"profiles.json")
            platform.controller=controller; platform._create_roi_frame()
            try:
                platform._position_roi_frame({"x":100,"y":80,"width":80,"height":50},dict(FakePlatform().geo))
                platform.u.GetWindowRgn.argtypes=[w.HWND,w.HANDLE];platform.u.GetWindowRgn.restype=ctypes.c_int
                platform.g.PtInRegion.argtypes=[w.HANDLE,ctypes.c_int,ctypes.c_int];platform.g.PtInRegion.restype=w.BOOL
                region=platform.g.CreateRectRgn(0,0,0,0)
                try:
                    self.assertNotEqual(platform.u.GetWindowRgn(platform.roi_frame,region),0)
                    self.assertTrue(platform.g.PtInRegion(region,30,3))
                    self.assertFalse(platform.g.PtInRegion(region,30,20))
                    self.assertFalse(platform.g.PtInRegion(region,8,8))
                finally:platform.g.DeleteObject(region)
                self.assertTrue(platform.u.GetWindowLongW(platform.roi_frame,-20) & 0x08000000)
            finally:
                platform.u.DestroyWindow(platform.roi_frame);platform.roi_frame=None
                platform.u.UnregisterClassW(platform.roi_frame_class,platform.k.GetModuleHandleW(None));controller.close()

    def test_real_frame_drag_updates_saved_roi_without_capture_or_selection(self):
        with tempfile.TemporaryDirectory() as folder:
            platform=Win32CapturePlatform();controller=NativeCaptureController(platform,Path(folder)/"profiles.json")
            platform.controller=controller
            with patch.object(platform,"geometry",return_value=FakePlatform().geo),patch.object(platform,"select") as select:
                controller.prepare(str(uuid.uuid4()),"trade","42",{"baseRevision":0,"sessionId":None,"sessionRevision":None},select=True)
                controller.selected(controller.generation,{"x":100,"y":80,"width":80,"height":50},dict(FakePlatform().geo))
                select.reset_mock();platform._create_roi_frame()
                platform._position_roi_frame(controller.profile["roi"],dict(FakePlatform().geo))
                cursor=[100,80]
                def point(output):
                    value=ctypes.cast(output,ctypes.POINTER(w.POINT)).contents;value.x,value.y=cursor;return True
                platform.u.SendMessageW.argtypes=[w.HWND,w.UINT,w.WPARAM,w.LPARAM];platform.u.SendMessageW.restype=ctypes.c_ssize_t
                try:
                    with patch.object(platform.u,"GetCursorPos",side_effect=point):
                        platform.u.SendMessageW(platform.roi_frame,0x201,1,(3<<16)|30)
                        self.assertTrue(controller.roi_adjusting)
                        cursor[:]=[120,95];platform.u.SendMessageW(platform.roi_frame,0x200,1,0)
                        platform.u.SendMessageW(platform.roi_frame,0x202,0,0)
                    self.assertEqual(controller.profile["roi"],{"x":120,"y":95,"width":80,"height":50})
                    self.assertFalse(controller.roi_adjusting);self.assertEqual(controller.captured_count,0)
                    generation=controller.generation
                    with patch.object(platform.u,"GetCursorPos",side_effect=point):
                        platform.u.SendMessageW(platform.roi_frame,0x201,1,(64<<16)|94)
                        cursor[:]=[140,125];platform.u.SendMessageW(platform.roi_frame,0x200,1,0)
                        platform.u.SendMessageW(platform.roi_frame,0x202,0,0)
                    self.assertEqual(controller.profile["roi"],{"x":120,"y":95,"width":100,"height":80})
                    self.assertEqual(controller.generation,generation)
                    self.assertFalse(controller.roi_adjusting);self.assertEqual(controller.captured_count,0)
                    select.assert_not_called()
                finally:
                    platform.u.DestroyWindow(platform.roi_frame);platform.roi_frame=None
                    platform.u.UnregisterClassW(platform.roi_frame_class,platform.k.GetModuleHandleW(None));controller.close()

    def test_real_gdi_excludes_visible_roi_and_interior_hit_reaches_underlying_window(self):
        with tempfile.TemporaryDirectory() as folder:
            platform=Win32CapturePlatform();controller=NativeCaptureController(platform,Path(folder)/"profiles.json")
            platform.controller=controller;platform._dpi()
            instance=platform.k.GetModuleHandleW(None)
            name=f"BDOBarterPixelTest-{os.getpid()}";received=[]
            def procedure(hwnd,msg,wp,lp):
                if msg in (0x201,0x20a):received.append(msg);return 0
                return platform.u.DefWindowProcW(hwnd,msg,wp,lp)
            callback=platform.WindowProc(procedure)
            wc=platform.WindowClass(0,callback,0,0,instance,None,None,platform.g.GetStockObject(0),None,name)
            self.assertTrue(platform.u.RegisterClassW(ctypes.byref(wc)))
            surface=platform.u.CreateWindowExW(0x08000088,name,"ROI pixel test",0x80000000,80,80,320,240,None,None,instance,None)
            try:
                self.assertTrue(surface);platform.u.ShowWindow(surface,4);platform.u.UpdateWindow(surface)
                platform._create_roi_frame()
                platform._position_roi_frame({"x":60,"y":60,"width":120,"height":90},{"left":80,"top":80})
                platform.u.ShowWindow(platform.roi_frame,4);platform.u.UpdateWindow(platform.roi_frame)
                self.assertTrue(platform.u.IsWindowVisible(platform.roi_frame))
                interior=platform.u.WindowFromPoint(w.POINT(170,170))
                self.assertEqual(interior,surface,"hollow interior must hit the underlying window")
                self.assertEqual(platform.u.WindowFromPoint(w.POINT(160,134)),platform.roi_frame)
                platform.u.SendMessageW.argtypes=[w.HWND,w.UINT,w.WPARAM,w.LPARAM];platform.u.SendMessageW.restype=ctypes.c_ssize_t
                for msg in (0x201,0x20a):platform.u.SendMessageW(interior,msg,0,0)
                self.assertEqual(received,[0x201,0x20a])
                affinity=w.DWORD()
                platform.u.GetWindowDisplayAffinity.argtypes=[w.HWND,ctypes.POINTER(w.DWORD)];platform.u.GetWindowDisplayAffinity.restype=w.BOOL
                self.assertTrue(platform.u.GetWindowDisplayAffinity(platform.roi_frame,ctypes.byref(affinity)))
                self.assertEqual(affinity.value,0x11);self.assertEqual(platform.dwm.DwmFlush(),0)
                with Image.open(io.BytesIO(platform.capture((128,128,272,242)))) as image:
                    self.assertEqual(image.getcolors(),[(144*114,(255,255,255))],"real GDI excludes the entire visible border")
                self.assertTrue(platform.u.IsWindowVisible(platform.roi_frame),"capture must not hide the frame")
            finally:
                if platform.roi_frame:platform.u.DestroyWindow(platform.roi_frame);platform.roi_frame=None
                if platform.roi_frame_class:platform.u.UnregisterClassW(platform.roi_frame_class,instance)
                if surface:platform.u.DestroyWindow(surface)
                platform.u.UnregisterClassW(name,instance);controller.close()

    def test_target_validation_and_black_frame_rejection(self):
        platform=Win32CapturePlatform()
        with self.assertRaises(NativeCaptureError): platform.geometry("not-a-window")
        with patch("PIL.ImageGrab.grab",return_value=Image.new("RGB",(80,50))):
            with self.assertRaises(NativeCaptureError) as failure: platform.capture((0,0,80,50))
            self.assertEqual(failure.exception.code,"black_frame")

    def test_message_only_sink_and_real_f10_registration_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            platform=Win32CapturePlatform();controller=NativeCaptureController(platform,Path(folder)/"profiles.json")
            controller.start()
            try:
                self.wait(lambda:platform.sink is not None or controller.runtime_failed)
                self.assertFalse(controller.runtime_failed,self.events(controller))
                self.assertFalse(platform.u.IsWindowVisible(platform.sink))
                self.assertFalse(platform.u.IsWindowVisible(platform.roi_frame))
                self.assertFalse(hasattr(platform,"hud"))
                controller.state="READY"
                self.wait(lambda:platform.hotkey_registered or controller.error=="hotkey_conflict")
                self.assertTrue(platform.hotkey_registered,self.events(controller))
                controller.busy=True;controller.receiver_busy=True;time.sleep(.1)
                self.assertTrue(platform.hotkey_registered)
            finally:controller.busy=False;controller.close()
            self.assertFalse(platform.thread.is_alive());self.assertIsNone(platform.sink);self.assertIsNone(platform.roi_frame)

    def test_hidden_sink_f10_three_captures_and_visible_roi_no_other_native_window(self):
        with tempfile.TemporaryDirectory() as folder:
            platform=Win32CapturePlatform();controller=NativeCaptureController(platform,Path(folder)/"profiles.json")
            geo={**FakePlatform().geo,"left":24,"top":24}
            with patch.object(platform,"geometry",return_value=geo),patch.object(platform,"select"),patch.object(platform,"is_foreground",return_value=True),patch("PIL.ImageGrab.grab",side_effect=lambda **kw:Image.new("RGB",(80,50),(20,40,60))),patch.object(platform.u,"SetForegroundWindow") as focus:
                controller.prepare(str(uuid.uuid4()),"trade","42",{"baseRevision":0,"sessionId":None,"sessionRevision":None},select=True)
                controller.selected(controller.generation,{"x":100,"y":80,"width":80,"height":50},geo)
                self.assertEqual(controller.captured_count,0)
                controller.start()
                try:
                    self.wait(lambda:platform.hotkey_registered)
                    self.wait(lambda:platform.roi_frame_visible)
                    self.assertTrue(platform.u.IsWindowVisible(platform.roi_frame))
                    self.assertFalse(platform.u.IsWindowVisible(platform.sink))
                    for count in (1,2,3):
                        platform.u.PostMessageW(platform.sink,0x312,0xBD0,0x79<<16)
                        self.wait(lambda:controller.captured_count==count and not controller.busy)
                    self.assertEqual(len(controller.frames),3);focus.assert_not_called()
                    controller.finish();self.wait(lambda:not platform.roi_frame_visible)
                    self.assertEqual(len(controller.frames),3)
                finally:controller.close()

    def test_hotkey_conflict_records_win32_error_then_recovers(self):
        with tempfile.TemporaryDirectory() as folder:
            platform=Win32CapturePlatform();controller=NativeCaptureController(platform,Path(folder)/"profiles.json")
            self.assertTrue(platform.u.RegisterHotKey(None,0xBE0,0x4000,0x79))
            controller.state="READY";controller.start()
            try:
                self.wait(lambda:controller.error=="hotkey_conflict")
                failure=next(e for e in self.events(controller) if e["event"]=="f10_registered")
                self.assertFalse(failure["success"]);self.assertEqual(failure["winError"],1409)
                platform.u.UnregisterHotKey(None,0xBE0);platform.hotkey_retry=0
                self.wait(lambda:platform.hotkey_registered);self.assertIsNone(controller.error)
            finally:platform.u.UnregisterHotKey(None,0xBE0);controller.close()


if __name__ == "__main__":unittest.main()
