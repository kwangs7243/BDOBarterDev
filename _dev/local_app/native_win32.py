"""Win32 UI thread and GDI provider, sharing the launcher's process lifetime."""
from __future__ import annotations

import ctypes
import io
import os
import queue
import threading
import time
from ctypes import wintypes as w

from local_app.native_capture import NativeCaptureError, adjust_roi


class Win32CapturePlatform:
    def __init__(self):
        self.hotkey_registered = False
        self.controller = None
        self.commands = queue.Queue()
        self.stopping = threading.Event()
        self.overlay = None
        self.sink = None
        self.sink_class = None
        self.roi_frame = None
        self.roi_frame_class = None
        self.roi_frame_visible = False
        self.frame_drag = None
        self.frame_bounds = None
        self.hotkey_retry = 0
        self.thread = None
        if os.name != "nt":
            raise NativeCaptureError("native_unsupported", "Windows 실행기에서 사용하세요.", 503)
        self.u = ctypes.WinDLL("user32", use_last_error=True)
        self.k = ctypes.WinDLL("kernel32", use_last_error=True)
        self.g = ctypes.WinDLL("gdi32", use_last_error=True)
        self.dwm = ctypes.WinDLL("dwmapi", use_last_error=True)
        self.shcore = ctypes.WinDLL("shcore", use_last_error=True)
        self._bind()

    def _bind(self):
        u, k, g = self.u, self.k, self.g
        bindings = [
            (u, "SetThreadDpiAwarenessContext", [ctypes.c_void_p], ctypes.c_void_p),
            (u, "SetWindowDisplayAffinity", [w.HWND, w.DWORD], w.BOOL),
            (u, "GetCursorPos", [ctypes.POINTER(w.POINT)], w.BOOL),
            (u, "WindowFromPoint", [w.POINT], w.HWND),
            (u, "GetForegroundWindow", [], w.HWND), (u, "IsWindow", [w.HWND], w.BOOL),
            (u, "IsWindowVisible", [w.HWND], w.BOOL), (u, "IsIconic", [w.HWND], w.BOOL),
            (u, "GetClientRect", [w.HWND, ctypes.POINTER(w.RECT)], w.BOOL),
            (u, "ClientToScreen", [w.HWND, ctypes.POINTER(w.POINT)], w.BOOL),
            (u, "GetWindowThreadProcessId", [w.HWND, ctypes.POINTER(w.DWORD)], w.DWORD),
            (u, "GetWindowTextW", [w.HWND, w.LPWSTR, ctypes.c_int], ctypes.c_int),
            (u, "GetDpiForWindow", [w.HWND], w.UINT),
            (u, "GetWindowLongW", [w.HWND, ctypes.c_int], ctypes.c_long),
            (u, "MonitorFromWindow", [w.HWND, w.DWORD], w.HANDLE),
            (u, "RegisterHotKey", [w.HWND, ctypes.c_int, w.UINT, w.UINT], w.BOOL),
            (u, "UnregisterHotKey", [w.HWND, ctypes.c_int], w.BOOL),
            (u, "SetForegroundWindow", [w.HWND], w.BOOL),
            (u, "SetLayeredWindowAttributes", [w.HWND, w.DWORD, ctypes.c_ubyte, w.DWORD], w.BOOL),
            (u, "ShowWindow", [w.HWND, ctypes.c_int], w.BOOL),
            (u, "SetWindowPos", [w.HWND, w.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, w.UINT], w.BOOL),
            (u, "UpdateWindow", [w.HWND], w.BOOL),
            (u, "DestroyWindow", [w.HWND], w.BOOL),
            (u, "SetWindowRgn", [w.HWND, w.HANDLE, w.BOOL], ctypes.c_int),
            (g, "CreateRectRgn", [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int], w.HANDLE),
            (g, "CombineRgn", [w.HANDLE, w.HANDLE, w.HANDLE, ctypes.c_int], ctypes.c_int),
            (u, "SetCapture", [w.HWND], w.HWND), (u, "ReleaseCapture", [], w.BOOL),
            (u, "InvalidateRect", [w.HWND, ctypes.POINTER(w.RECT), w.BOOL], w.BOOL),
            (u, "PostMessageW", [w.HWND, w.UINT, w.WPARAM, w.LPARAM], w.BOOL),
            (u, "DefWindowProcW", [w.HWND, w.UINT, w.WPARAM, w.LPARAM], ctypes.c_ssize_t),
            (k, "OpenProcess", [w.DWORD, w.BOOL, w.DWORD], w.HANDLE),
            (k, "CloseHandle", [w.HANDLE], w.BOOL),
            (k, "QueryFullProcessImageNameW", [w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)], w.BOOL),
            (k, "GetModuleHandleW", [w.LPCWSTR], w.HMODULE),
            (g, "CreatePen", [ctypes.c_int, ctypes.c_int, w.DWORD], w.HANDLE),
            (g, "SelectObject", [w.HDC, w.HANDLE], w.HANDLE),
            (g, "DeleteObject", [w.HANDLE], w.BOOL),
            (g, "Rectangle", [w.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int], w.BOOL),
            (g, "GetStockObject", [ctypes.c_int], w.HANDLE),
            (g, "SetTextColor", [w.HDC, w.DWORD], w.DWORD),
            (g, "SetBkMode", [w.HDC, ctypes.c_int], ctypes.c_int),
            (g, "TextOutW", [w.HDC, ctypes.c_int, ctypes.c_int, w.LPCWSTR, ctypes.c_int], w.BOOL),
        ]
        for dll, name, args, result in bindings:
            function = getattr(dll, name)
            function.argtypes, function.restype = args, result
        self.WindowProc = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, w.HWND, w.UINT, w.WPARAM, w.LPARAM)
        class WindowClass(ctypes.Structure):
            _fields_ = [("style", w.UINT), ("proc", self.WindowProc), ("classExtra", ctypes.c_int),
                        ("windowExtra", ctypes.c_int), ("instance", w.HINSTANCE), ("icon", w.HICON),
                        ("cursor", w.HANDLE), ("background", w.HBRUSH), ("menu", w.LPCWSTR), ("name", w.LPCWSTR)]
        class Paint(ctypes.Structure):
            _fields_ = [("hdc", w.HDC), ("erase", w.BOOL), ("rect", w.RECT),
                        ("restore", w.BOOL), ("update", w.BOOL), ("reserved", ctypes.c_byte * 32)]
        self.WindowClass, self.Paint = WindowClass, Paint
        u.RegisterClassW.argtypes, u.RegisterClassW.restype = [ctypes.POINTER(WindowClass)], w.ATOM
        u.UnregisterClassW.argtypes, u.UnregisterClassW.restype = [w.LPCWSTR, w.HINSTANCE], w.BOOL
        u.CreateWindowExW.argtypes = [w.DWORD, w.LPCWSTR, w.LPCWSTR, w.DWORD, ctypes.c_int, ctypes.c_int,
                                     ctypes.c_int, ctypes.c_int, w.HWND, w.HMENU, w.HINSTANCE, ctypes.c_void_p]
        u.CreateWindowExW.restype = w.HWND
        u.BeginPaint.argtypes, u.BeginPaint.restype = [w.HWND, ctypes.POINTER(Paint)], w.HDC
        u.EndPaint.argtypes, u.EndPaint.restype = [w.HWND, ctypes.POINTER(Paint)], w.BOOL
        u.LoadCursorW.argtypes, u.LoadCursorW.restype = [w.HINSTANCE, ctypes.c_void_p], w.HANDLE
        class MonitorInfo(ctypes.Structure):
            _fields_ = [("size", w.DWORD), ("monitor", w.RECT), ("work", w.RECT),
                        ("flags", w.DWORD), ("device", w.WCHAR * 32)]
        self.MonitorInfo = MonitorInfo
        u.GetMonitorInfoW.argtypes = [w.HANDLE, ctypes.POINTER(MonitorInfo)]
        u.GetMonitorInfoW.restype = w.BOOL
        self.dwm.DwmFlush.argtypes, self.dwm.DwmFlush.restype = [], ctypes.c_long
        self.shcore.GetScaleFactorForMonitor.argtypes = [w.HANDLE, ctypes.POINTER(ctypes.c_int)]
        self.shcore.GetScaleFactorForMonitor.restype = ctypes.c_long

    def _dpi(self):
        if not self.u.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4)):
            raise NativeCaptureError("dpi_unavailable", "물리 픽셀 좌표 환경을 준비하지 못했습니다.")

    def _monitor_dpi(self, monitor):
        # A DPI-unaware game's HWND reports 96 even when its monitor is scaled.
        scale = ctypes.c_int()
        if self.shcore.GetScaleFactorForMonitor(monitor, ctypes.byref(scale)) != 0 or scale.value <= 0:
            raise NativeCaptureError("dpi_unavailable", "게임 모니터의 배율을 확인하지 못했습니다.")
        return 96 * scale.value / 100

    def _identity(self, hwnd):
        pid = w.DWORD()
        self.u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        handle = self.k.OpenProcess(0x1000, False, pid.value)
        if not handle:
            raise NativeCaptureError("target_unavailable", "게임 프로세스를 확인하지 못했습니다.")
        try:
            name, length = ctypes.create_unicode_buffer(32768), w.DWORD(32768)
            if not self.k.QueryFullProcessImageNameW(handle, 0, name, ctypes.byref(length)):
                raise NativeCaptureError("target_unavailable", "게임 프로세스를 확인하지 못했습니다.")
            return name.value.lower(), pid.value
        finally:
            self.k.CloseHandle(handle)

    def _is_game(self, hwnd):
        identity, _ = self._identity(hwnd)
        return os.path.basename(identity).startswith("blackdesert") and identity.endswith(".exe")

    def targets(self):
        self._dpi()
        items = []
        callback_type = ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
        def each(hwnd, _):
            try:
                if self.u.IsWindowVisible(hwnd) and not self.u.IsIconic(hwnd) and self._is_game(hwnd):
                    self.geometry(str(hwnd))
                    title = ctypes.create_unicode_buffer(512)
                    self.u.GetWindowTextW(hwnd, title, len(title))
                    items.append({"id": str(hwnd), "title": title.value or "검은사막"})
            except (NativeCaptureError, OSError):
                pass
            return True
        self.u.EnumWindows.argtypes, self.u.EnumWindows.restype = [callback_type, w.LPARAM], w.BOOL
        self.u.EnumWindows(callback_type(each), 0)
        return items

    def geometry(self, target):
        self._dpi()
        try:
            if not isinstance(target, str) or not target.isdecimal() or len(target) > 20:
                raise ValueError()
            hwnd = int(target)
            if not 0 < hwnd < 2 ** (ctypes.sizeof(w.HWND) * 8):
                raise ValueError()
        except (ValueError, TypeError):
            raise NativeCaptureError("invalid_target", "게임 창을 선택하세요.", 422) from None
        if not self.u.IsWindow(hwnd) or self.u.IsIconic(hwnd) or not self.u.IsWindowVisible(hwnd) or not self._is_game(hwnd):
            raise NativeCaptureError("target_unavailable", "선택한 검은사막 창을 사용할 수 없습니다.")
        rect, origin = w.RECT(), w.POINT(0, 0)
        if not self.u.GetClientRect(hwnd, ctypes.byref(rect)) or not self.u.ClientToScreen(hwnd, ctypes.byref(origin)):
            raise NativeCaptureError("target_unavailable", "게임 창 좌표를 읽지 못했습니다.")
        width, height = rect.right - rect.left, rect.bottom - rect.top
        if width < 8 or height < 8:
            raise NativeCaptureError("target_unavailable", "게임 창이 너무 작습니다.")
        monitor = self.MonitorInfo()
        monitor.size = ctypes.sizeof(monitor)
        monitor_handle = self.u.MonitorFromWindow(hwnd, 2)
        if not self.u.GetMonitorInfoW(monitor_handle, ctypes.byref(monitor)):
            raise NativeCaptureError("target_unavailable", "게임 모니터를 확인하지 못했습니다.")
        identity, pid = self._identity(hwnd)
        return {"identity": identity, "pid": pid, "width": width, "height": height,
                "left": origin.x, "top": origin.y, "dpi": self._monitor_dpi(monitor_handle), "windowDpi": self.u.GetDpiForWindow(hwnd),
                "monitor": f"{monitor.device}:{monitor.monitor.right-monitor.monitor.left}x{monitor.monitor.bottom-monitor.monitor.top}",
                "mode": "windowed" if self.u.GetWindowLongW(hwnd, -16) & 0x00C00000 else "borderless"}

    def _window_pid(self, hwnd):
        pid = w.DWORD()
        if hwnd: self.u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return pid.value

    def _game_is_foreground(self, target):
        foreground = self.u.GetForegroundWindow()
        return bool(target and foreground and (foreground == int(target) or
                    self._window_pid(foreground) == self._window_pid(int(target)) != 0))

    def is_foreground(self, target):
        return self._game_is_foreground(target)

    def capture(self, box):
        from PIL import ImageGrab
        self._dpi()
        # WDA excludes the persistent ROI without hiding it or changing game focus.
        image = ImageGrab.grab(bbox=box, all_screens=True)
        try:
            if image.size != (box[2]-box[0], box[3]-box[1]) or image.getbbox() is None:
                raise NativeCaptureError("black_frame", "게임 화면을 읽지 못했습니다. 창모드/전체창모드를 확인하세요.")
            output = io.BytesIO()
            image.save(output, format="PNG")
            return output.getvalue()
        finally:
            image.close()

    def select(self, target, generation):
        self.commands.put((target, generation))

    def cancel_selection(self):
        if self.overlay:
            self.u.PostMessageW(self.overlay, 0x0010, 0, 0)

    def start(self, controller):
        self.controller = controller
        self.thread = threading.Thread(target=self._run, name="bdo-native-ui", daemon=True)
        self.thread.start()

    def stop(self):
        self.stopping.set()
        self.cancel_selection()
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=3)

    def _record(self, event, **fields):
        if self.controller is not None:
            foreground = self.u.GetForegroundWindow()
            self.controller.record(event, foreground=foreground, foregroundPid=self._window_pid(foreground), **fields)

    def _create_input_sink(self):
        def procedure(hwnd, message, wp, lp):
            if message == 0x0312 and wp == 0xBD0:
                self._record("hotkey_received", key="F10")
                self.controller.on_hotkey()
                return 0
            return self.u.DefWindowProcW(hwnd, message, wp, lp)
        self.sink_callback = self._window_callback(procedure)
        self.sink_class = f"BDOBarterInputSink-{os.getpid()}"
        instance = self.k.GetModuleHandleW(None)
        wc = self.WindowClass(0, self.sink_callback, 0, 0, instance, None, None, None, None, self.sink_class)
        if not self.u.RegisterClassW(ctypes.byref(wc)): raise ctypes.WinError(ctypes.get_last_error())
        self.sink = self.u.CreateWindowExW(0, self.sink_class, "", 0, 0, 0, 0, 0,
                                         w.HWND(-3), None, instance, None)  # HWND_MESSAGE.
        if not self.sink: raise ctypes.WinError(ctypes.get_last_error())
        self._record("input_sink_created")

    def _update_hotkey(self):
        wanted = self.controller.state == "READY"
        if wanted and not self.hotkey_registered and time.monotonic() >= self.hotkey_retry:
            self.hotkey_registered = bool(self.u.RegisterHotKey(self.sink, 0xBD0, 0x4000, 0x79))
            self._record("f10_registered", success=self.hotkey_registered,
                         winError=ctypes.get_last_error() if not self.hotkey_registered else 0)
            if not self.hotkey_registered:
                self.hotkey_retry = time.monotonic()+5
                self.controller.registration_failed()
            elif self.controller.error == "hotkey_conflict": self.controller.error = None
        elif not wanted and self.hotkey_registered:
            self.u.UnregisterHotKey(self.sink, 0xBD0)
            self.hotkey_registered = False

    def _run(self):
        try:
            self._dpi()
            class Message(ctypes.Structure):
                _fields_ = [("hwnd", w.HWND), ("message", w.UINT), ("wParam", w.WPARAM),
                            ("lParam", w.LPARAM), ("time", w.DWORD), ("pt", w.POINT), ("private", w.DWORD)]
            self.Message = Message
            self.u.PeekMessageW.argtypes, self.u.PeekMessageW.restype = [ctypes.POINTER(Message), w.HWND, w.UINT, w.UINT, w.UINT], w.BOOL
            self.u.TranslateMessage.argtypes = [ctypes.POINTER(Message)]
            self.u.DispatchMessageW.argtypes, self.u.DispatchMessageW.restype = [ctypes.POINTER(Message)], ctypes.c_ssize_t
            self._create_input_sink()
            self._create_roi_frame()
            message = Message()
            while not self.stopping.is_set():
                self.controller.maintenance()
                self._update_hotkey()
                self._update_roi_frame(self.controller.state == "READY")
                while self.u.PeekMessageW(ctypes.byref(message), None, 0, 0, 1):
                    self.u.TranslateMessage(ctypes.byref(message)); self.u.DispatchMessageW(ctypes.byref(message))
                try: target, generation = self.commands.get_nowait()
                except queue.Empty: pass
                else:
                    if generation == self.controller.generation:
                        try: self._select_overlay(target, generation)
                        except NativeCaptureError as error:
                            self.controller.diagnostics.exception("selection_failed", code=error.code)
                            self.controller.stop_capture(error.code)
                self.stopping.wait(.02)
        except Exception:
            self.controller.diagnostics.exception("native_ui_failed")
            self.controller.stop_capture("native_runtime_failed")
            self.controller.runtime_failed = True
        finally:
            if self.hotkey_registered: self.u.UnregisterHotKey(self.sink, 0xBD0)
            self.hotkey_registered = False
            instance = self.k.GetModuleHandleW(None)
            if self.roi_frame: self.u.DestroyWindow(self.roi_frame); self.roi_frame = None
            if self.roi_frame_class: self.u.UnregisterClassW(self.roi_frame_class, instance)
            if self.sink: self.u.DestroyWindow(self.sink); self.sink = None
            if self.sink_class: self.u.UnregisterClassW(self.sink_class, instance)
            self._record("native_ui_stopped")

    def _window_callback(self, procedure):
        def checked(hwnd, message, wp, lp):
            try: return procedure(hwnd, message, wp, lp)
            except Exception:
                if self.controller is not None:
                    self.controller.diagnostics.exception("window_callback_failed", message=message)
                    self.controller.error = "native_runtime_failed"
                if hwnd == self.roi_frame and self.frame_drag:
                    self._finish_frame_drag(True); self.u.ReleaseCapture()
                return self.u.DefWindowProcW(hwnd, message, wp, lp)
        return self.WindowProc(checked)

    def _create_roi_frame(self):
        u, g = self.u, self.g
        def procedure(hwnd, message, wp, lp):
            if message == 0x0201:
                geometry = self.geometry(self.controller.target)
                if not self.controller.begin_roi_adjustment(): return 0
                point = w.POINT(); u.GetCursorPos(ctypes.byref(point))
                roi = dict(self.controller.profile["roi"])
                x, y = ctypes.c_short(lp & 0xffff).value, ctypes.c_short(lp >> 16 & 0xffff).value
                width, height = roi["width"]+16, roi["height"]+16
                horizontal = "w" if x < 16 else "e" if x >= width-16 else ""
                vertical = "n" if y < 16 else "s" if y >= height-16 else ""
                self.frame_drag = {"roi": roi, "handle": vertical+horizontal if horizontal and vertical else "",
                                   "point": (point.x, point.y), "geometry": geometry,
                                   "generation": self.controller.generation, "current": roi}
                u.SetCapture(hwnd)
                return 0
            if message == 0x0200 and self.frame_drag:
                point = w.POINT(); u.GetCursorPos(ctypes.byref(point))
                drag = self.frame_drag
                drag["current"] = adjust_roi(drag["roi"], drag["handle"], point.x-drag["point"][0], point.y-drag["point"][1], drag["geometry"])
                self._position_roi_frame(drag["current"], drag["geometry"])
                return 0
            if message == 0x0202 and self.frame_drag:
                self._finish_frame_drag(False); u.ReleaseCapture(); return 0
            if message in (0x0215, 0x001f) and self.frame_drag:
                self._finish_frame_drag(True); return 0
            if message == 0x000f:
                paint = self.Paint(); hdc = u.BeginPaint(hwnd, ctypes.byref(paint))
                try:
                    if self.frame_bounds:
                        width, height = self.frame_bounds[2:]
                        pen = g.CreatePen(0, 3, 0x00ff00)
                        old_pen, old_brush = g.SelectObject(hdc, pen), g.SelectObject(hdc, g.GetStockObject(5))
                        try:
                            g.Rectangle(hdc, 3, 3, width-3, height-3)
                            for x, y in ((1,1),(width-13,1),(1,height-13),(width-13,height-13)):
                                g.Rectangle(hdc, x, y, x+12, y+12)
                        finally:
                            g.SelectObject(hdc, old_brush); g.SelectObject(hdc, old_pen); g.DeleteObject(pen)
                finally: u.EndPaint(hwnd, ctypes.byref(paint))
                return 0
            return u.DefWindowProcW(hwnd, message, wp, lp)
        self.roi_frame_callback = self._window_callback(procedure)
        self.roi_frame_class = f"BDOBarterRegionFrame-{os.getpid()}"
        instance = self.k.GetModuleHandleW(None)
        wc = self.WindowClass(0, self.roi_frame_callback, 0, 0, instance, None,
                              u.LoadCursorW(None, ctypes.c_void_p(32646)), g.GetStockObject(4), None, self.roi_frame_class)
        if not u.RegisterClassW(ctypes.byref(wc)): raise ctypes.WinError(ctypes.get_last_error())
        self.roi_frame = u.CreateWindowExW(0x08000088, self.roi_frame_class, "BDO 캡처 영역", 0x80000000,
                                         0, 0, 1, 1, None, None, instance, None)
        if not self.roi_frame: raise ctypes.WinError(ctypes.get_last_error())
        if not u.SetWindowDisplayAffinity(self.roi_frame, 0x11): raise ctypes.WinError(ctypes.get_last_error())
        self._record("roi_frame_created")

    def _finish_frame_drag(self, cancel):
        drag, self.frame_drag = self.frame_drag, None
        if cancel:
            with self.controller.lock: self.controller.roi_adjusting = False
            self._record("roi_drag_cancelled")
        else: self.controller.update_roi(drag["generation"], drag["current"], drag["geometry"])
        self.frame_bounds = None

    def _position_roi_frame(self, roi, geometry):
        bounds = (geometry["left"]+roi["x"]-8, geometry["top"]+roi["y"]-8, roi["width"]+16, roi["height"]+16)
        if bounds == self.frame_bounds: return
        x, y, width, height = bounds
        outer = self.g.CreateRectRgn(0, 0, width, height)
        inner = self.g.CreateRectRgn(8, 8, width-8, height-8)
        if not outer or not inner:
            if outer: self.g.DeleteObject(outer)
            if inner: self.g.DeleteObject(inner)
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            if not self.g.CombineRgn(outer, outer, inner, 4): raise ctypes.WinError(ctypes.get_last_error())
            if not self.u.SetWindowRgn(self.roi_frame, outer, True): raise ctypes.WinError(ctypes.get_last_error())
            outer = None  # SetWindowRgn takes ownership on success.
        finally:
            self.g.DeleteObject(inner)
            if outer: self.g.DeleteObject(outer)
        self.frame_bounds = bounds
        if not self.u.SetWindowPos(self.roi_frame, w.HWND(-1), x, y, width, height, 0x0010): raise ctypes.WinError(ctypes.get_last_error())
        self.u.InvalidateRect(self.roi_frame, None, True)

    def _update_roi_frame(self, active):
        if not self.roi_frame: return
        if not active or not self.controller.profile:
            if self.frame_drag: self._finish_frame_drag(True); self.u.ReleaseCapture()
            if self.roi_frame_visible: self.u.ShowWindow(self.roi_frame, 0); self.roi_frame_visible = False
            return
        if not self.frame_drag: self._position_roi_frame(self.controller.profile["roi"], self.geometry(self.controller.target))
        if not self.roi_frame_visible: self.u.ShowWindow(self.roi_frame, 4); self.roi_frame_visible = True

    def _wait_for_game(self, target, generation):
        self.u.SetForegroundWindow(int(target))
        deadline = time.monotonic() + 30
        while not self._game_is_foreground(target):
            if self.stopping.is_set() or generation != self.controller.snapshot()["generation"]:
                raise NativeCaptureError("roi_cancelled", "영역 지정을 취소했습니다.")
            if time.monotonic() > deadline:
                raise NativeCaptureError("foreground_required", "게임 창을 앞에 둔 뒤 영역 지정을 다시 시작하세요.")
            self.controller.maintenance()
            self.stopping.wait(.05)

    def _select_overlay(self, target, generation):
        self._wait_for_game(target, generation)
        geo = self.geometry(target)
        u, g = self.u, self.g
        proc_type, WindowClass, Paint = self.WindowProc, self.WindowClass, self.Paint
        selection, start, dragging, done, roi = None, None, False, False, None
        def point(value):
            return (max(0, min(geo["width"], ctypes.c_short(value & 0xffff).value)),
                    max(0, min(geo["height"], ctypes.c_short((value >> 16) & 0xffff).value)))
        def procedure(hwnd, msg, wp, lp):
            nonlocal selection, start, dragging, done, roi
            if msg == 0x0201:
                self._record("roi_mouse_down")
                start, dragging = point(lp), True
                u.SetCapture(hwnd)
                return 0
            if msg == 0x0200 and dragging:
                end = point(lp)
                selection = (min(start[0], end[0]), min(start[1], end[1]), max(start[0], end[0]), max(start[1], end[1]))
                u.InvalidateRect(hwnd, None, True)
                return 0
            if msg == 0x0202:
                dragging = False
                u.ReleaseCapture()
                return 0
            if msg == 0x0100 and wp == 13 and selection and not dragging:
                self._record("roi_enter")
                x, y, right, bottom = selection
                if right-x >= 8 and bottom-y >= 8:
                    roi = {"x": x, "y": y, "width": right-x, "height": bottom-y}
                    u.DestroyWindow(hwnd)
                return 0
            if msg == 0x0010 or msg == 0x0100 and wp == 27:
                u.DestroyWindow(hwnd)
                return 0
            if msg == 0x0002:
                done = True
                return 0
            if msg == 0x000f:
                paint = Paint()
                hdc = u.BeginPaint(hwnd, ctypes.byref(paint))
                try:
                    text = "영역 드래그 → Enter 확정 / Esc 취소"
                    g.SetTextColor(hdc, 0xFFFFFF); g.SetBkMode(hdc, 1)
                    g.TextOutW(hdc, 16, 16, text, len(text))
                    if selection:
                        pen = g.CreatePen(0, 3, 0x00ff00)
                        old_pen = g.SelectObject(hdc, pen)
                        old_brush = g.SelectObject(hdc, g.GetStockObject(5))
                        try:
                            g.Rectangle(hdc, *selection)
                        finally:
                            g.SelectObject(hdc, old_brush); g.SelectObject(hdc, old_pen); g.DeleteObject(pen)
                finally:
                    u.EndPaint(hwnd, ctypes.byref(paint))
                return 0
            return u.DefWindowProcW(hwnd, msg, wp, lp)
        callback = self._window_callback(procedure)
        name = f"BDOBarterROI-{generation}"
        instance = self.k.GetModuleHandleW(None)
        wc = WindowClass(0, callback, 0, 0, instance, None, u.LoadCursorW(None, ctypes.c_void_p(32515)), g.GetStockObject(4), None, name)
        if not u.RegisterClassW(ctypes.byref(wc)):
            raise ctypes.WinError(ctypes.get_last_error())
        hwnd = None
        try:
            hwnd = u.CreateWindowExW(0x00080000 | 0x00000008, name, "BDO 캡처 영역", 0x80000000,
                                    geo["left"], geo["top"], geo["width"], geo["height"], None, None, instance, None)
            if not hwnd:
                raise ctypes.WinError(ctypes.get_last_error())
            self.overlay = hwnd
            if not u.SetLayeredWindowAttributes(hwnd, 0, 100, 2):
                raise ctypes.WinError(ctypes.get_last_error())
            u.ShowWindow(hwnd, 5); u.UpdateWindow(hwnd); u.SetForegroundWindow(hwnd)
            message = self.Message()
            while not done and not self.stopping.is_set():
                self.controller.maintenance()
                while u.PeekMessageW(ctypes.byref(message), None, 0, 0, 1):
                    u.TranslateMessage(ctypes.byref(message)); u.DispatchMessageW(ctypes.byref(message))
                self.stopping.wait(0.01)
        finally:
            if hwnd and u.IsWindow(hwnd):
                u.DestroyWindow(hwnd)
            self.overlay = None
            u.UnregisterClassW(name, instance)
        if self.dwm.DwmFlush() != 0:
            roi = None
        if u.IsWindow(int(target)):
            u.SetForegroundWindow(int(target))
        self.controller.selected(generation, roi, geo)
