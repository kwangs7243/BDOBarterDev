"""Win32 UI thread and GDI provider, sharing the launcher's process lifetime."""
from __future__ import annotations

import ctypes
import io
import os
import queue
import threading
import time
import sys
import traceback
from ctypes import wintypes as w

from local_app.native_capture import NativeCaptureError, adjust_roi


class Win32CapturePlatform:
    def __init__(self):
        self.hotkey_registered = False
        self.controller = None
        self.commands = queue.Queue()
        self.stopping = threading.Event()
        self.overlay = None
        self.hud = None
        self.roi_frame = None
        self.roi_frame_class = None
        self.roi_frame_visible = False
        self.frame_drag = None
        self.frame_bounds = None
        self.hud_class = None
        self.hud_buttons = []
        self.panel_generation = None
        self.raw_registered = False
        self.panel_visible = False
        self.display_excluded = False
        self.last_ui_tick = time.monotonic()
        self.watchdog = None
        self.last_panel_status = None
        self.enter_registered = False
        self.hotkey_retry = 0
        self.keys_down = set()
        self.last_hotkey = {}
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
            (u, "IsChild", [w.HWND, w.HWND], w.BOOL),
            (u, "SetWindowDisplayAffinity", [w.HWND, w.DWORD], w.BOOL),
            (u, "IsWindowEnabled", [w.HWND], w.BOOL),
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
        class RawDevice(ctypes.Structure):
            _fields_ = [("usagePage", w.USHORT), ("usage", w.USHORT), ("flags", w.DWORD), ("target", w.HWND)]
        class RawHeader(ctypes.Structure):
            _fields_ = [("kind", w.DWORD), ("size", w.DWORD), ("device", w.HANDLE), ("parameter", w.WPARAM)]
        class RawKeyboard(ctypes.Structure):
            _fields_ = [("scan", w.USHORT), ("flags", w.USHORT), ("reserved", w.USHORT),
                        ("key", w.USHORT), ("message", w.UINT), ("extra", w.ULONG)]
        self.RawDevice, self.RawHeader, self.RawKeyboard = RawDevice, RawHeader, RawKeyboard
        u.RegisterRawInputDevices.argtypes, u.RegisterRawInputDevices.restype = [ctypes.POINTER(RawDevice), w.UINT, w.UINT], w.BOOL
        u.GetRawInputData.argtypes, u.GetRawInputData.restype = [w.HANDLE, w.UINT, ctypes.c_void_p, ctypes.POINTER(w.UINT), w.UINT], w.UINT
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
        foreground = self.u.GetForegroundWindow()
        return target is not None and (self._game_is_foreground(target) or
                (foreground in (self.hud, self.roi_frame) and foreground is not None and
                 self.controller is not None and self.controller.target == target))

    def capture(self, box):
        from PIL import ImageGrab
        self._dpi()
        # Window mutations belong to the UI thread. WDA excludes our controls from GDI capture.
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
        self.watchdog = threading.Thread(target=self._watch, name="bdo-native-watch", daemon=True)
        self.watchdog.start()

    def stop(self):
        self.stopping.set()
        self.cancel_selection()
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=3)
        if self.watchdog and self.watchdog is not threading.current_thread(): self.watchdog.join(timeout=3)

    def _record(self, event, **fields):
        if self.controller is not None:
            foreground = self.u.GetForegroundWindow()
            self.controller.record(event, foreground=foreground, foregroundPid=self._window_pid(foreground),
                                   targetPid=self._window_pid(int(self.controller.target)) if self.controller.target else None,
                                   panel=self.hud, **fields)

    def _watch(self):
        reported = False
        while not self.stopping.wait(2):
            if self.controller.state not in {"READY", "SELECTING"}: continue
            age = time.monotonic() - self.last_ui_tick
            point = w.POINT()
            self.u.GetCursorPos(ctypes.byref(point))
            self._record("runtime_health", uiAgeMs=round(age*1000), uiAlive=self.thread.is_alive(),
                         rawRegistered=self.raw_registered, hotkeyRegistered=self.hotkey_registered,
                         panelVisible=bool(self.hud and self.u.IsWindowVisible(self.hud)),
                         panelEnabled=bool(self.hud and self.u.IsWindowEnabled(self.hud)),
                         pointerWindow=self.u.WindowFromPoint(point),
                         workerAlive=bool(self.controller.worker and self.controller.worker.is_alive()))
            if age > 5 and not reported:
                frames = sys._current_frames()
                stacks = {t.name: "".join(traceback.format_stack(frames[t.ident]))
                          for t in threading.enumerate() if t.name.startswith("bdo-native") and t.ident in frames}
                self._record("ui_stalled", stacks=stacks)
                reported = True
            elif age <= 5: reported = False

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
            self._create_hud()
            self._create_roi_frame()
            device = self.RawDevice(1, 6, 0x100, self.hud)  # RIDEV_INPUTSINK, without suppressing game input.
            self.raw_registered = bool(self.u.RegisterRawInputDevices(ctypes.byref(device), 1, ctypes.sizeof(device)))
            self.enter_registered = self.raw_registered
            self._record("raw_input_registered", success=self.raw_registered, winError=ctypes.get_last_error() if not self.raw_registered else 0)
            message = Message()
            while not self.stopping.is_set():
                self.last_ui_tick = time.monotonic()
                self.controller.maintenance()
                wanted = self.controller.state == "READY"
                if wanted and not self.hotkey_registered and time.monotonic() >= self.hotkey_retry:
                    self.hotkey_registered = bool(self.u.RegisterHotKey(None, 0xBD0, 0x4000, 0x79))
                    self._record("f10_registered", success=self.hotkey_registered, winError=ctypes.get_last_error() if not self.hotkey_registered else 0)
                    if not self.hotkey_registered: self.hotkey_retry = time.monotonic() + 5
                elif not wanted and self.hotkey_registered:
                    self.u.UnregisterHotKey(None, 0xBD0)
                    self.hotkey_registered = False
                self._update_game_controls()
                while self.u.PeekMessageW(ctypes.byref(message), None, 0, 0, 1):
                    if message.message == 0x0312 and message.wParam == 0xBD0:
                        self._key_action(0x79, "hotkey")
                    elif (message.message == 0x0100 and self.hud and
                          (message.hwnd == self.hud or self.u.IsChild(self.hud, message.hwnd)) and
                          self._handle_panel_key(message.wParam, message.lParam)):
                        pass
                    else:
                        self.u.TranslateMessage(ctypes.byref(message))
                        self.u.DispatchMessageW(ctypes.byref(message))
                try:
                    target, generation = self.commands.get_nowait()
                except queue.Empty: pass
                else:
                    self.u.ShowWindow(self.hud, 0); self.panel_visible = False
                    if generation == self.controller.snapshot()["generation"]:
                        try: self._select_overlay(target, generation)
                        except NativeCaptureError as error:
                            self.controller.diagnostics.exception("selection_failed", code=error.code)
                            with self.controller.lock:
                                if generation == self.controller.generation:
                                    self.controller.disarm(); self.controller.error = error.code
                self.stopping.wait(.01)
        except Exception:
            self.controller.diagnostics.exception("native_ui_failed")
            self.controller.disarm()
            with self.controller.lock:
                self.controller.runtime_failed = True; self.controller.error = "native_runtime_failed"
        finally:
            if self.raw_registered:
                device = self.RawDevice(1, 6, 1, None)
                self.u.RegisterRawInputDevices(ctypes.byref(device), 1, ctypes.sizeof(device))
            self.raw_registered = self.enter_registered = False
            if self.hotkey_registered: self.u.UnregisterHotKey(None, 0xBD0)
            self.hotkey_registered = False
            if self.roi_frame: self.u.DestroyWindow(self.roi_frame); self.roi_frame = None
            if self.roi_frame_class: self.u.UnregisterClassW(self.roi_frame_class, self.k.GetModuleHandleW(None))
            if self.hud: self.u.DestroyWindow(self.hud); self.hud = None
            if self.hud_class: self.u.UnregisterClassW(self.hud_class, self.k.GetModuleHandleW(None))
            self._record("native_ui_stopped")

    def _raw_input(self, handle):
        size = w.UINT()
        header_size = ctypes.sizeof(self.RawHeader)
        if self.u.GetRawInputData(handle, 0x10000003, None, ctypes.byref(size), header_size) == 0xffffffff:
            self._record("raw_input_read_failed", winError=ctypes.get_last_error()); return
        if not header_size <= size.value <= 4096: return
        data = ctypes.create_string_buffer(size.value)
        result = self.u.GetRawInputData(handle, 0x10000003, data, ctypes.byref(size), header_size)
        if result == 0xffffffff:
            self._record("raw_input_read_failed", winError=ctypes.get_last_error()); return
        header = self.RawHeader.from_buffer_copy(data)
        if header.kind != 1 or result < header_size + ctypes.sizeof(self.RawKeyboard): return
        keyboard = self.RawKeyboard.from_buffer_copy(data, header_size)
        self._raw_key(keyboard.key, bool(keyboard.flags & 1))

    def _raw_key(self, key, released):
        if key not in (13, 0x79, 0x77, 27): return
        if released: self.keys_down.discard(key); return
        if key in self.keys_down: return
        self.keys_down.add(key)
        self._key_action(key, "raw-input")

    def _key_action(self, key, source):
        if self.controller is None or self.controller.state != "READY": return
        action = {13: 101, 0x79: 101, 0x77: 102, 27: 103}.get(key)
        if action is None: return
        self._record("key_received", key=key, source=source)
        if not self.is_foreground(self.controller.target):
            self._record("key_ignored", reason="other_foreground"); return
        now = time.monotonic()
        # WM_INPUT, WM_KEYDOWN and WM_HOTKEY can describe the same physical press.
        previous = self.last_hotkey.get(key)
        if previous and now - previous[0] < .12 and previous[1] != source: return
        self.last_hotkey[key] = (now, source)
        self._panel_action(action, source)

    def _handle_panel_key(self, key, flags=0):
        if key not in (13, 0x79, 0x77, 27): return False
        if not flags & (1 << 30): self._key_action(key, "panel-key")
        return True

    def _panel_action(self, action, source="button"):
        if self.controller is None: return
        self._record("panel_action", action=action, source=source)
        if action == 101: self.controller.on_hotkey()
        elif action == 102: self.controller.reselect()
        elif action == 103: self.controller.finish()

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

    def _create_hud(self):
        u, g = self.u, self.g
        def procedure(hwnd, msg, wp, lp):
            if msg == 0x00ff:
                self._raw_input(lp)
                return u.DefWindowProcW(hwnd, msg, wp, lp)
            if msg == 0x0210 and wp & 0xffff == 0x0201:
                self._record("panel_mouse_down")
            if msg == 0x0111:
                if wp >> 16 == 0: self._panel_action(wp & 0xffff)
                return 0
            if msg == 0x0100 and self._handle_panel_key(wp, lp): return 0
            if msg == 0x0010:
                self._panel_action(103); u.ShowWindow(hwnd, 0); return 0
            if msg == 0x000f:
                paint = self.Paint(); hdc = u.BeginPaint(hwnd, ctypes.byref(paint))
                try:
                    state = self.controller.snapshot()
                    title = "물교" if state["mode"] == "TRADE" else "창고"
                    text = f"{title} · {state['captured']}장 캡처" + (" · 처리 중" if state["busy"] else "")
                    errors = {"queue_full":"대기열이 가득 찼습니다. 브라우저에서 이미지를 확인하세요.",
                              "black_frame":"검은 화면입니다. 게임을 표시한 뒤 다시 캡처하세요.",
                              "pixel_capture_failed":"캡처 실패. 게임 화면과 영역을 확인하세요.",
                              "foreground_required":"게임 화면을 앞에 둔 뒤 이 창의 캡처 버튼을 누르세요.",
                              "capture_busy":"이전 캡처 또는 인식 처리 중입니다. 잠시 기다리세요.",
                              "hotkey_conflict":"F10 충돌. 이 창의 캡처 버튼 또는 Enter를 사용하세요."}
                    guide = errors.get(state["error"], "테두리 드래그: 이동 · 모서리: 크기 · Enter / F10: 캡처")
                    g.SetTextColor(hdc, 0xFFFFFF); g.SetBkMode(hdc, 1)
                    g.TextOutW(hdc, 12, 10, text, len(text)); g.TextOutW(hdc, 12, 38, guide, len(guide))
                finally: u.EndPaint(hwnd, ctypes.byref(paint))
                return 0
            return u.DefWindowProcW(hwnd, msg, wp, lp)
        self.hud_callback = self._window_callback(procedure)
        self.hud_class = f"BDOBarterCapturePanel-{os.getpid()}"
        instance = self.k.GetModuleHandleW(None)
        wc = self.WindowClass(0, self.hud_callback, 0, 0, instance, None, None, g.GetStockObject(4), None, self.hud_class)
        if not u.RegisterClassW(ctypes.byref(wc)): raise ctypes.WinError(ctypes.get_last_error())
        self.hud = u.CreateWindowExW(0x00000008 | 0x00000080, self.hud_class,
                                    "BDO 캡처 · Enter / F10 / 버튼", 0x80C80000,
                                    0, 0, 600, 155, None, None, instance, None)
        if not self.hud: raise ctypes.WinError(ctypes.get_last_error())
        self.display_excluded = bool(u.SetWindowDisplayAffinity(self.hud, 0x11))
        self._record("panel_created", displayExcluded=self.display_excluded,
                     winError=ctypes.get_last_error() if not self.display_excluded else 0)
        if not self.display_excluded:
            raise NativeCaptureError("capture_exclusion_failed", "캡처 조작창 제외를 지원하지 않는 Windows 환경입니다.")
        self.hud_buttons = []
        for index, (label, action) in enumerate((("캡처 · Enter", 101), ("영역 변경 · F8", 102), ("종료 · Esc", 103))):
            button = u.CreateWindowExW(0, "BUTTON", label, 0x50010000,
                                       12 + index*192, 76, 182, 32, self.hud, w.HMENU(action), instance, None)
            if not button: raise ctypes.WinError(ctypes.get_last_error())
            self.hud_buttons.append(button)

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

    def _update_game_controls(self):
        state = self.controller.snapshot()
        active = state["state"] == "READY" and self.controller.target is not None
        self._update_roi_frame(active)
        if not active:
            if self.panel_visible:
                self.u.ShowWindow(self.hud, 0); self.panel_visible = False
                self._record("panel_hidden", reason=state["state"])
            return
        if self.panel_generation != state["generation"]:
            geo = self.geometry(self.controller.target)
            if not self.u.SetWindowPos(self.hud, w.HWND(-1), geo["left"]+12, geo["top"]+12, 600, 155, 0x0010):
                raise ctypes.WinError(ctypes.get_last_error())
            self.panel_generation = state["generation"]
        if not self.panel_visible:
            self.u.ShowWindow(self.hud, 4); self.panel_visible = True
            self._record("panel_shown")
        status = (state["mode"], state["captured"], state["busy"], state["error"])
        if status != self.last_panel_status:
            self.last_panel_status = status
            self.u.InvalidateRect(self.hud, None, True)

    def _wait_for_game(self, target, generation):
        self.u.SetForegroundWindow(int(target))
        deadline = time.monotonic() + 30
        while not self._game_is_foreground(target):
            self.last_ui_tick = time.monotonic()
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
                self.last_ui_tick = time.monotonic()
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
        self.panel_generation = None
        self.controller.selected(generation, roi, geo)
