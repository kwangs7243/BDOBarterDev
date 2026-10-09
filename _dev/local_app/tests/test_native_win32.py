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
from contextlib import contextmanager

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

    @contextmanager
    def owned_window(self, platform, activate=False):
        platform._dpi();instance=platform.k.GetModuleHandleW(None)
        name=f"BDOBarterPreflight-{uuid.uuid4()}"
        def procedure(hwnd,msg,wp,lp):
            if msg in (0x100,0x101,0x104,0x105):return 0
            return platform.u.DefWindowProcW(hwnd,msg,wp,lp)
        callback=platform.WindowProc(procedure)
        wc=platform.WindowClass(0,callback,0,0,instance,None,None,platform.g.GetStockObject(0),None,name)
        self.assertTrue(platform.u.RegisterClassW(ctypes.byref(wc)))
        surface=platform.u.CreateWindowExW(0x88 if activate else 0x08000088,name,"F10 preflight",0x80000000,80,80,320,240,None,None,instance,None)
        try:
            self.assertTrue(surface);platform.u.ShowWindow(surface,5 if activate else 4);platform.u.UpdateWindow(surface)
            yield surface
        finally:
            if surface:platform.u.DestroyWindow(surface)
            platform.u.UnregisterClassW(name,instance)

    @unittest.skipUnless(os.environ.get("BDO_OS_INPUT_PREFLIGHT")=="1", "Opt-in interactive OS input preflight")
    def test_sendinput_f10_single_triple_and_synthetic_repeat_through_windows(self):
        platform=Win32CapturePlatform();previous=platform.u.GetForegroundWindow()
        class Keyboard(ctypes.Structure):
            _fields_=[("vk",w.WORD),("scan",w.WORD),("flags",w.DWORD),("time",w.DWORD),("extra",ctypes.c_size_t)]
        class Mouse(ctypes.Structure):
            _fields_=[("x",w.LONG),("y",w.LONG),("data",w.DWORD),("flags",w.DWORD),("time",w.DWORD),("extra",ctypes.c_size_t)]
        class Payload(ctypes.Union):_fields_=[("keyboard",Keyboard),("mouse",Mouse)]
        class Input(ctypes.Structure):_fields_=[("type",w.DWORD),("payload",Payload)]
        platform.u.SendInput.argtypes=[w.UINT,ctypes.POINTER(Input),ctypes.c_int];platform.u.SendInput.restype=w.UINT
        platform.u.GetAsyncKeyState.argtypes=[ctypes.c_int];platform.u.GetAsyncKeyState.restype=ctypes.c_short
        if any(platform.u.GetAsyncKeyState(key)&0x8000 for key in (0x79,0x10,0x11,0x12,0x5b,0x5c)):
            self.skipTest("F10/modifier already held; test does not reset user keys")
        with tempfile.TemporaryDirectory() as folder,self.owned_window(platform,activate=True) as surface:
            controller=NativeCaptureController(platform,Path(folder)/"profiles.json")
            geo={**FakePlatform().geo,"pid":os.getpid(),"left":80,"top":80,"width":320,"height":240}
            def pump():
                message=platform.Message()
                while platform.u.PeekMessageW(ctypes.byref(message),None,0,0,1):
                    platform.u.TranslateMessage(ctypes.byref(message));platform.u.DispatchMessageW(ctypes.byref(message))
            def wait_capture(count):
                try:self.wait(lambda:(pump() or controller.captured_count==count) and not controller.busy)
                except AssertionError:
                    foreground=platform.u.GetForegroundWindow()
                    if controller.error in {"foreground_required","target_changed"} and platform._window_pid(foreground)!=os.getpid():
                        self.skipTest("External desktop focus changed during capture; production foreground guard rejected it")
                    self.fail(json.dumps({"native":controller.snapshot(),"events":self.events(controller)},ensure_ascii=False))
            def key(flags):
                pump()
                foreground=platform.u.GetForegroundWindow()
                if foreground!=surface and platform._window_pid(foreground)!=os.getpid():
                    self.skipTest("External desktop focus changed; no input sent outside the test window")
                self.assertEqual(foreground,surface,"native windows must not steal test focus")
                event=Input();event.type=1;event.payload.keyboard=Keyboard(0x79,0,flags,0,0)
                self.assertEqual(platform.u.SendInput(1,ctypes.byref(event),ctypes.sizeof(Input)),1,ctypes.get_last_error())
            def pixels(box):
                output=io.BytesIO();Image.new("RGB",(box[2]-box[0],box[3]-box[1]),"white").save(output,format="PNG");return output.getvalue()
            with patch.object(platform,"geometry",return_value=geo),patch.object(platform,"select"),patch.object(platform,"capture",side_effect=pixels):
                controller.prepare(str(uuid.uuid4()),"trade",str(surface),{"baseRevision":0,"sessionId":None,"sessionRevision":None},select=True)
                controller.selected(controller.generation,{"x":60,"y":60,"width":120,"height":90},geo)
                controller.start()
                try:
                    platform.u.SetForegroundWindow(surface)
                    if platform.u.GetForegroundWindow()!=surface:
                        platform.u.AttachThreadInput.argtypes=[w.DWORD,w.DWORD,w.BOOL];platform.u.AttachThreadInput.restype=w.BOOL
                        platform.k.GetCurrentThreadId.argtypes=[];platform.k.GetCurrentThreadId.restype=w.DWORD
                        current=platform.k.GetCurrentThreadId()
                        foreground_thread=platform.u.GetWindowThreadProcessId(platform.u.GetForegroundWindow(),None)
                        if foreground_thread and foreground_thread!=current and platform.u.AttachThreadInput(current,foreground_thread,True):
                            try:platform.u.SetForegroundWindow(surface);platform.u.SetFocus.argtypes=[w.HWND];platform.u.SetFocus.restype=w.HWND;platform.u.SetFocus(surface)
                            finally:platform.u.AttachThreadInput(current,foreground_thread,False)
                    if platform.u.GetForegroundWindow()!=surface:self.skipTest("Windows foreground policy denied the test-owned window")
                    self.wait(lambda:platform.hotkey_registered)
                    key(0);key(2);wait_capture(1)
                    self.assertEqual(len(controller.frames),1)
                    for count in (2,3,4):
                        key(0);key(2);wait_capture(count)
                    self.assertEqual(len(controller.frames),4,"three additional press/release events produce exactly three images")
                    key(0);wait_capture(5)
                    for _ in range(8):key(0);time.sleep(.075)
                    self.assertEqual(controller.captured_count,5,"repeat keydowns while held must not recapture")
                    key(2);key(0);key(2);wait_capture(6)
                    received=[e for e in self.events(controller) if e["event"]=="hotkey_received"]
                    self.assertEqual(len(received),6);self.assertEqual(len(controller.frames),6)
                    self.assertEqual(platform.u.GetForegroundWindow(),surface)
                    print(json.dumps({"osSendInputF10":"PASS","singlePressFrames":1,"threeAdditionalPressFrames":3,"eightHeldRepeatKeydownsAdditionalFrames":0,"provider":"mock PNG; OS input and foreground checks real","actualGame":False}))
                finally:
                    # Release only this test's F10; restore focus only if still owned.
                    event=Input();event.type=1;event.payload.keyboard=Keyboard(0x79,0,2,0,0)
                    platform.u.SendInput(1,ctypes.byref(event),ctypes.sizeof(Input))
                    controller.close()
                    if platform.u.GetForegroundWindow()==surface and previous:platform.u.SetForegroundWindow(previous)

    def test_real_window_move_follows_without_reset_and_size_change_stops(self):
        platform=Win32CapturePlatform()
        with tempfile.TemporaryDirectory() as folder,self.owned_window(platform) as surface:
            controller=NativeCaptureController(platform,Path(folder)/"profiles.json")
            original_identity=platform._identity
            def alias(hwnd):
                _,pid=original_identity(hwnd);return "c:/test/blackdesert64.exe",pid
            with patch.object(platform,"_identity",side_effect=alias),patch.object(platform,"select"),patch.object(platform,"is_foreground",return_value=True):
                target=str(surface);geo=platform.geometry(target)
                controller.prepare(str(uuid.uuid4()),"trade",target,{"baseRevision":0,"sessionId":None,"sessionRevision":None},select=True)
                controller.selected(controller.generation,{"x":60,"y":60,"width":120,"height":90},geo)
                controller.start()
                try:
                    self.wait(lambda:platform.roi_frame_visible)
                    self.assertTrue(controller.on_hotkey());self.wait(lambda:not controller.busy)
                    self.assertEqual(len(controller.frames),1);generation=controller.generation
                    previous_frame=next(iter(controller.frames.values()));previous_roi=dict(controller.profile["roi"])
                    started=time.monotonic();platform.u.SetWindowPos(surface,None,100,110,320,240,0x0014)
                    self.wait(lambda:platform.frame_bounds[:2]==(152,162))
                    latency=time.monotonic()-started;self.assertLess(latency,.35)
                    self.assertEqual(controller.generation,generation);self.assertEqual(controller.profile["roi"],previous_roi)
                    self.assertIs(next(iter(controller.frames.values())),previous_frame)
                    self.assertTrue(controller.on_hotkey());self.wait(lambda:not controller.busy)
                    current=list(controller.frames.values())[-1]["metadata"]
                    self.assertEqual(current["nativeEvidence"]["screenOrigin"],{"x":100,"y":110})
                    platform.u.SetWindowPos(surface,None,100,110,360,240,0x0014)
                    self.wait(lambda:controller.state=="STOPPED")
                    self.assertEqual(controller.error,"profile_changed");self.assertEqual(len(controller.frames),2)
                    print(json.dumps({"realWindowFollow":"PASS","followLatencyMs":round(latency*1000,2),"clientResizeInvalidation":"PASS","pendingAndGenerationPreserved":True}))
                finally:controller.close()

    def test_identity_cache_checks_pid_expiry_and_rejects_replaced_non_game_process(self):
        platform=Win32CapturePlatform()
        with patch.object(platform,"_window_pid",return_value=42) as pid,patch.object(platform,"_identity",return_value=("c:/game/blackdesert64.exe",42)) as identity,patch("local_app.native_win32.time.monotonic",return_value=10) as clock:
            for _ in range(20):self.assertEqual(platform._geometry_identity(100)[1],42)
            self.assertEqual(identity.call_count,1)
            clock.return_value=11.1;platform._geometry_identity(100);self.assertEqual(identity.call_count,2)
            pid.return_value=43;identity.return_value=("c:/other/notgame.exe",43)
            with self.assertRaises(NativeCaptureError):platform._geometry_identity(100)
            self.assertEqual(identity.call_count,3);self.assertIsNone(platform.identity_cache)

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
