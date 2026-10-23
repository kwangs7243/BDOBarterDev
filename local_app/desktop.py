"""Native suite launch window; server lifetime stays in launcher.py."""
from __future__ import annotations

import ctypes
from ctypes import wintypes as w
import threading


def run_manager(start, open_app, stop, stopped: threading.Event, icon_path):
    u = ctypes.WinDLL("user32", use_last_error=True)
    try:
        u.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except AttributeError:
        pass
    g = ctypes.WinDLL("gdi32", use_last_error=True)
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    result_type = ctypes.c_ssize_t
    callback_type = ctypes.WINFUNCTYPE(result_type, w.HWND, w.UINT, w.WPARAM, w.LPARAM)

    class WindowClass(ctypes.Structure):
        _fields_ = [("style", w.UINT), ("procedure", callback_type), ("class_extra", ctypes.c_int),
                    ("window_extra", ctypes.c_int), ("instance", w.HINSTANCE), ("icon", w.HANDLE),
                    ("cursor", w.HANDLE), ("background", w.HANDLE), ("menu", w.LPCWSTR), ("name", w.LPCWSTR)]

    class Paint(ctypes.Structure):
        _fields_ = [("dc", w.HDC), ("erase", w.BOOL), ("rect", w.RECT), ("restore", w.BOOL),
                    ("update", w.BOOL), ("reserved", w.BYTE * 32)]

    class DrawItem(ctypes.Structure):
        _fields_ = [("kind", w.UINT), ("control", w.UINT), ("item", w.UINT), ("action", w.UINT),
                    ("state", w.UINT), ("window", w.HWND), ("dc", w.HDC), ("rect", w.RECT), ("data", ctypes.c_size_t)]

    bindings = {
        "DefWindowProcW": ([w.HWND, w.UINT, w.WPARAM, w.LPARAM], result_type),
        "RegisterClassW": ([ctypes.POINTER(WindowClass)], w.ATOM),
        "CreateWindowExW": ([w.DWORD, w.LPCWSTR, w.LPCWSTR, w.DWORD, ctypes.c_int, ctypes.c_int,
                             ctypes.c_int, ctypes.c_int, w.HWND, w.HMENU, w.HINSTANCE, ctypes.c_void_p], w.HWND),
        "BeginPaint": ([w.HWND, ctypes.POINTER(Paint)], w.HDC),
        "EndPaint": ([w.HWND, ctypes.POINTER(Paint)], w.BOOL),
        "FillRect": ([w.HDC, ctypes.POINTER(w.RECT), w.HANDLE], ctypes.c_int),
        "DrawTextW": ([w.HDC, w.LPCWSTR, ctypes.c_int, ctypes.POINTER(w.RECT), w.UINT], ctypes.c_int),
        "PostMessageW": ([w.HWND, w.UINT, w.WPARAM, w.LPARAM], w.BOOL),
        "SendMessageW": ([w.HWND, w.UINT, w.WPARAM, w.LPARAM], result_type),
        "EnableWindow": ([w.HWND, w.BOOL], w.BOOL),
        "SetWindowTextW": ([w.HWND, w.LPCWSTR], w.BOOL),
        "InvalidateRect": ([w.HWND, ctypes.POINTER(w.RECT), w.BOOL], w.BOOL),
        "DestroyWindow": ([w.HWND], w.BOOL),
        "ShowWindow": ([w.HWND, ctypes.c_int], w.BOOL),
        "UpdateWindow": ([w.HWND], w.BOOL),
        "LoadImageW": ([w.HINSTANCE, w.LPCWSTR, w.UINT, ctypes.c_int, ctypes.c_int, w.UINT], w.HANDLE),
        "AdjustWindowRectEx": ([ctypes.POINTER(w.RECT), w.DWORD, w.BOOL, w.DWORD], w.BOOL),
        "GetMessageW": ([ctypes.POINTER(w.MSG), w.HWND, w.UINT, w.UINT], w.BOOL),
        "TranslateMessage": ([ctypes.POINTER(w.MSG)], w.BOOL),
        "DispatchMessageW": ([ctypes.POINTER(w.MSG)], result_type),
        "IsDialogMessageW": ([w.HWND, ctypes.POINTER(w.MSG)], w.BOOL),
        "PostQuitMessage": ([ctypes.c_int], None),
        "SetTimer": ([w.HWND, ctypes.c_size_t, w.UINT, ctypes.c_void_p], ctypes.c_size_t),
        "KillTimer": ([w.HWND, ctypes.c_size_t], w.BOOL),
        "DestroyIcon": ([w.HANDLE], w.BOOL),
        "IsWindowEnabled": ([w.HWND], w.BOOL),
        "DrawFocusRect": ([w.HDC, ctypes.POINTER(w.RECT)], w.BOOL),
        "MessageBoxW": ([w.HWND, w.LPCWSTR, w.LPCWSTR, w.UINT], ctypes.c_int),
        "UnregisterClassW": ([w.LPCWSTR, w.HINSTANCE], w.BOOL),
    }
    for name, (args, restype) in bindings.items():
        method = getattr(u, name)
        method.argtypes, method.restype = args, restype
    k.GetModuleHandleW.argtypes, k.GetModuleHandleW.restype = [w.LPCWSTR], w.HINSTANCE
    for name, args, restype in (
        ("CreateSolidBrush", [w.DWORD], w.HANDLE), ("DeleteObject", [w.HANDLE], w.BOOL),
        ("SelectObject", [w.HDC, w.HANDLE], w.HANDLE), ("SetTextColor", [w.HDC, w.DWORD], w.DWORD),
        ("SetBkMode", [w.HDC, ctypes.c_int], ctypes.c_int),
        ("CreateFontW", [ctypes.c_int] * 5 + [w.DWORD] * 8 + [w.LPCWSTR], w.HANDLE),
    ):
        method = getattr(g, name)
        method.argtypes, method.restype = args, restype
    try:
        dpi = u.GetDpiForSystem() / 96
    except AttributeError:
        dpi = 1
    scale = lambda n: round(n * dpi)
    rgb = lambda r, green, b: r | (green << 8) | (b << 16)
    background, panel, gold, text_color, muted = [rgb(*v) for v in (
        (12, 16, 23), (22, 29, 39), (205, 174, 101), (239, 234, 221), (154, 165, 181))]
    brushes = {color: g.CreateSolidBrush(color) for color in (background, panel, gold)}
    fonts = [g.CreateFontW(-scale(size), 0, 0, 0, weight, 0, 0, 0, 1, 0, 0, 5, 0, "맑은 고딕")
             for size, weight in ((31, 700), (13, 400), (15, 600), (11, 400))]
    instance = k.GetModuleHandleW(None)
    icon = u.LoadImageW(None, str(icon_path), 1, 64, 64, 0x10)
    handle, open_button, exit_button = None, None, None
    state = {"ready": False, "failed": False, "closing": False, "close_requested": False,
             "status": "로컬 서비스를 준비하고 있습니다.", "error": ""}
    update_message, ready_message, error_message = 0x8002, 0x8003, 0x8004

    def rectangle(dc, bounds, color):
        rect = w.RECT(*(scale(n) for n in bounds))
        u.FillRect(dc, ctypes.byref(rect), brushes[color])

    def label(dc, value, bounds, font=1, color=text_color, centered=False):
        previous = g.SelectObject(dc, fonts[font])
        g.SetTextColor(dc, color)
        g.SetBkMode(dc, 1)
        rect = w.RECT(*(scale(n) for n in bounds))
        u.DrawTextW(dc, value, -1, ctypes.byref(rect), 0x24 | (1 if centered else 0))
        g.SelectObject(dc, previous)

    def progress(value):
        state["status"] = value
        if handle:
            u.PostMessageW(handle, update_message, 0, 0)

    def startup():
        try:
            start(progress)
            u.PostMessageW(handle, ready_message, 0, 0)
        except Exception as error:
            state["error"] = str(error)
            state["failed"] = True
            u.PostMessageW(handle, error_message, 0, 0)

    def shutdown():
        try:
            stop()
        except Exception as error:
            state["error"] = str(error)
            state["closing"] = False
            u.PostMessageW(handle, error_message, 0, 0)

    def begin_shutdown():
        if state["failed"]:
            u.DestroyWindow(handle)
        elif not state["ready"]:
            state["close_requested"] = True
            progress("준비를 마친 뒤 안전하게 종료합니다.")
        elif not state["closing"]:
            state["closing"] = True
            progress("저장과 캡처를 마무리한 뒤 종료합니다.")
            u.EnableWindow(open_button, False)
            u.EnableWindow(exit_button, False)
            threading.Thread(target=shutdown, name="bdo-stop", daemon=True).start()

    @callback_type
    def procedure(hwnd, message, wparam, lparam):
        nonlocal handle, open_button, exit_button
        if message == 1:
            handle = hwnd
            open_button = u.CreateWindowExW(0, "BUTTON", "통합 앱 열기", 0x5001000B,
                                           scale(30), scale(255), scale(278), scale(45), hwnd, w.HMENU(101), instance, None)
            exit_button = u.CreateWindowExW(0, "BUTTON", "서버 종료", 0x5001000B,
                                           scale(320), scale(255), scale(130), scale(45), hwnd, w.HMENU(102), instance, None)
            u.EnableWindow(open_button, False)
            u.EnableWindow(exit_button, False)
            u.SetTimer(hwnd, 1, 200, None)
            return 0
        if message == 0xF:
            paint = Paint()
            dc = u.BeginPaint(hwnd, ctypes.byref(paint))
            rectangle(dc, (0, 0, 480, 340), background)
            rectangle(dc, (30, 32, 34, 94), gold)
            label(dc, "BDO SUITE", (50, 25, 450, 75), 0, gold)
            label(dc, "모험가의 작업실", (52, 77, 450, 102), 1, muted)
            rectangle(dc, (30, 130, 450, 230), panel)
            label(dc, "물물교환   /   연금 제작", (48, 145, 430, 175), 2)
            label(dc, state["status"], (48, 183, 435, 216), 1, muted)
            label(dc, "LOCAL WORKSPACE   ·   YOUR ADVENTURE, YOUR RECORDS", (30, 307, 455, 331), 3, muted)
            u.EndPaint(hwnd, ctypes.byref(paint))
            return 0
        if message == 0x2B:
            draw = ctypes.cast(lparam, ctypes.POINTER(DrawItem)).contents
            enabled = bool(u.IsWindowEnabled(draw.window))
            color = gold if draw.control == 101 and enabled else panel
            u.FillRect(draw.dc, ctypes.byref(draw.rect), brushes[color])
            rect = draw.rect
            old = g.SelectObject(draw.dc, fonts[2])
            g.SetTextColor(draw.dc, background if color == gold else text_color if enabled else muted)
            g.SetBkMode(draw.dc, 1)
            caption = "통합 앱 열기" if draw.control == 101 else "닫기" if state["failed"] else "서버 종료"
            u.DrawTextW(draw.dc, caption, -1, ctypes.byref(rect), 0x25)
            if draw.state & 0x10:
                u.DrawFocusRect(draw.dc, ctypes.byref(rect))
            g.SelectObject(draw.dc, old)
            return 1
        if message == 0x111:
            if wparam & 0xFFFF == 101:
                open_app()
            elif wparam & 0xFFFF == 102:
                begin_shutdown()
            return 0
        if message == ready_message:
            state["ready"] = True
            progress("실행 중 · 이 창에서 다시 열거나 종료할 수 있습니다.")
            u.EnableWindow(open_button, True)
            u.EnableWindow(exit_button, True)
            if state["close_requested"]:
                begin_shutdown()
            return 0
        if message == error_message:
            progress("시작하지 못했습니다." if state["failed"] else "종료를 다시 시도해 주세요.")
            u.EnableWindow(exit_button, True)
            u.EnableWindow(open_button, state["ready"])
            u.MessageBoxW(hwnd, state["error"], "BDO Suite", 0x10)
            return 0
        if message == update_message:
            u.InvalidateRect(hwnd, None, False)
            return 0
        if message == 0x113 and stopped.is_set():
            u.DestroyWindow(hwnd)
            return 0
        if message == 0x10:
            begin_shutdown()
            return 0
        if message == 2:
            u.KillTimer(hwnd, 1)
            u.PostQuitMessage(0)
            return 0
        return u.DefWindowProcW(hwnd, message, wparam, lparam)

    name = "BDOSuiteDesktopWindow"
    window_class = WindowClass()
    window_class.procedure, window_class.instance = procedure, instance
    window_class.icon, window_class.background, window_class.name = icon, brushes[background], name
    if not u.RegisterClassW(ctypes.byref(window_class)):
        raise ctypes.WinError(ctypes.get_last_error())
    style = 0x00CA0000
    bounds = w.RECT(0, 0, scale(480), scale(340))
    u.AdjustWindowRectEx(ctypes.byref(bounds), style, False, 0)
    width, height = bounds.right - bounds.left, bounds.bottom - bounds.top
    try:
        handle = u.CreateWindowExW(0, name, "BDO Suite · 모험가의 작업실", style,
                                  (u.GetSystemMetrics(0) - width) // 2, (u.GetSystemMetrics(1) - height) // 2,
                                  width, height, None, None, instance, None)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            dark_title = ctypes.WinDLL("dwmapi").DwmSetWindowAttribute
            dark_title.argtypes = [w.HWND, w.DWORD, ctypes.c_void_p, w.DWORD]
            dark_title(handle, 20, ctypes.byref(ctypes.c_int(1)), 4)
        except OSError:
            pass
        u.ShowWindow(handle, 5)
        u.UpdateWindow(handle)
        threading.Thread(target=startup, name="bdo-start", daemon=True).start()
        message = w.MSG()
        while u.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
            if not u.IsDialogMessageW(handle, ctypes.byref(message)):
                u.TranslateMessage(ctypes.byref(message))
                u.DispatchMessageW(ctypes.byref(message))
        return 1 if state["failed"] else 0
    finally:
        u.UnregisterClassW(name, instance)
        if icon:
            u.DestroyIcon(icon)
        for object_handle in [*brushes.values(), *fonts]:
            g.DeleteObject(object_handle)
