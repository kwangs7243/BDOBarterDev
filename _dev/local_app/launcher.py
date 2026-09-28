"""Double-click launcher for the localhost BDO Barter application."""
from __future__ import annotations

import ctypes
import json
import os
import sys
import threading
import time
from ctypes import wintypes
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen
import webbrowser

from local_app.backend.app import HOST, PORT, create_app

APP_URL = f"http://{HOST}:{PORT}/"
HEALTH_URL = f"http://{HOST}:{PORT}/api/health"
MUTEX_NAME = "Local\\BDOBarter-18765"
ERROR_ALREADY_EXISTS = 183
WM_APP_SHUTDOWN = 0x8001
IDC_OPEN = 101
IDC_EXIT = 102


def resource_root() -> Path:
    """Return the root containing local_app, reference, and scanner resources."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS")).resolve()
    return Path(__file__).resolve().parents[1]


class SingleInstance:
    """Hold a Windows named mutex for the lifetime of the launcher process."""

    def __init__(self) -> None:
        self.handle = None

    def acquire(self) -> bool:
        if os.name != "nt":
            return True
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        create_mutex = kernel32.CreateMutexW
        create_mutex.argtypes = (ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p)
        create_mutex.restype = ctypes.c_void_p
        ctypes.set_last_error(0)
        self.handle = create_mutex(None, False, MUTEX_NAME)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        return ctypes.get_last_error() != ERROR_ALREADY_EXISTS

    def release(self) -> None:
        if self.handle:
            close_handle = ctypes.WinDLL("kernel32", use_last_error=True).CloseHandle
            close_handle.argtypes = (ctypes.c_void_p,)
            close_handle.restype = ctypes.c_bool
            close_handle(self.handle)
            self.handle = None


def _health_is_ours(timeout: float = 0.8) -> bool:
    try:
        with urlopen(HEALTH_URL, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return payload.get("ok") is True and payload.get("service") == "bdo-barter-local"
    except (OSError, URLError, ValueError, json.JSONDecodeError):
        return False


def wait_for_health(timeout: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _health_is_ours():
            return True
        time.sleep(0.2)
    return False


def _message_box(title: str, message: str, *, error: bool = False) -> None:
    if os.name != "nt":
        return
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.MessageBoxW.argtypes = (wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.UINT)
    user32.MessageBoxW.restype = ctypes.c_int
    user32.MessageBoxW(None, message, title, 0x10 if error else 0x30)


def _friendly_start_error(error: BaseException) -> str:
    if isinstance(error, OSError) and getattr(error, "winerror", None) in {10013, 10048}:
        return f"고정 포트 {PORT}를 사용할 수 없습니다. 다른 프로그램이 점유 중일 수 있습니다. 기존 프로세스는 종료하지 않았습니다."
    return f"앱을 시작할 수 없습니다.\n\n{error}"


def _run_manager_window(server, server_thread: threading.Thread, app) -> None:
    """Show a small native Win32 window and drain writes before server exit."""
    if os.name != "nt":
        # The distributable is Windows-only; this keeps launcher imports testable elsewhere.
        app.extensions["bdo_shutdown_complete"].wait()
        server.close()
        server_thread.join(timeout=10)
        return

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    hinstance = kernel32.GetModuleHandleW(None)
    hinstance = wintypes.HINSTANCE(hinstance)
    LRESULT = ctypes.c_ssize_t
    WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)

    class WNDCLASSW(ctypes.Structure):
        _fields_ = [
            ("style", wintypes.UINT),
            ("lpfnWndProc", WNDPROC),
            ("cbClsExtra", ctypes.c_int),
            ("cbWndExtra", ctypes.c_int),
            ("hInstance", wintypes.HINSTANCE),
            ("hIcon", wintypes.HANDLE),
            ("hCursor", wintypes.HANDLE),
            ("hbrBackground", wintypes.HANDLE),
            ("lpszMenuName", wintypes.LPCWSTR),
            ("lpszClassName", wintypes.LPCWSTR),
        ]

    class MSG(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("message", wintypes.UINT),
            ("wParam", wintypes.WPARAM),
            ("lParam", wintypes.LPARAM),
            ("time", wintypes.DWORD),
            ("pt", wintypes.POINT),
        ]

    user32.DefWindowProcW.argtypes = (wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
    user32.DefWindowProcW.restype = LRESULT
    user32.RegisterClassW.argtypes = (ctypes.POINTER(WNDCLASSW),)
    user32.RegisterClassW.restype = wintypes.ATOM
    user32.CreateWindowExW.argtypes = (
        wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, ctypes.c_void_p,
    )
    user32.CreateWindowExW.restype = wintypes.HWND
    user32.ShowWindow.argtypes = (wintypes.HWND, ctypes.c_int)
    user32.UpdateWindow.argtypes = (wintypes.HWND,)
    user32.GetMessageW.argtypes = (ctypes.POINTER(MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT)
    user32.GetMessageW.restype = ctypes.c_int
    user32.TranslateMessage.argtypes = (ctypes.POINTER(MSG),)
    user32.DispatchMessageW.argtypes = (ctypes.POINTER(MSG),)
    user32.PostQuitMessage.argtypes = (ctypes.c_int,)
    user32.PostMessageW.argtypes = (wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
    user32.EnableWindow.argtypes = (wintypes.HWND, wintypes.BOOL)
    user32.SetWindowTextW.argtypes = (wintypes.HWND, wintypes.LPCWSTR)

    window_handle = None
    exit_button = None
    shutdown_started = threading.Event()
    server_closed = threading.Event()
    close_lock = threading.Lock()

    def close_server() -> None:
        with close_lock:
            if server_closed.is_set():
                return
            server_closed.set()
        server.close()
        server_thread.join(timeout=10)

    def post_close() -> None:
        if window_handle:
            user32.PostMessageW(window_handle, WM_APP_SHUTDOWN, 0, 0)

    def shutdown_request() -> None:
        try:
            request = Request(
                f"http://{HOST}:{PORT}/api/app/shutdown",
                data=b"{}",
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urlopen(request, timeout=35) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if payload.get("ok") is not True:
                raise RuntimeError("서버가 종료 준비를 확인하지 않았습니다.")
            close_server()
            post_close()
        except Exception as error:  # Keep the manager available so the user can retry.
            shutdown_started.clear()
            if exit_button:
                user32.EnableWindow(exit_button, True)
            _message_box("종료를 완료하지 못했습니다", str(error), error=True)

    def begin_shutdown() -> None:
        if shutdown_started.is_set():
            return
        shutdown_started.set()
        if exit_button:
            user32.EnableWindow(exit_button, False)
        threading.Thread(target=shutdown_request, name="bdo-shutdown", daemon=True).start()

    @WNDPROC
    def wnd_proc(hwnd, message, wparam, lparam):
        nonlocal window_handle, exit_button
        if message == 0x0001:  # WM_CREATE
            window_handle = hwnd
            user32.CreateWindowExW(0, "STATIC", f"앱 실행 중 · 127.0.0.1:{PORT}", 0x50000000, 20, 18, 300, 24, hwnd, None, hinstance, None)
            user32.CreateWindowExW(0, "BUTTON", "화면 열기", 0x50010000, 52, 58, 108, 32, hwnd, wintypes.HMENU(IDC_OPEN), hinstance, None)
            exit_button = user32.CreateWindowExW(0, "BUTTON", "종료", 0x50010000, 176, 58, 108, 32, hwnd, wintypes.HMENU(IDC_EXIT), hinstance, None)
            return 0
        if message == 0x0111:  # WM_COMMAND
            command = wparam & 0xFFFF
            if command == IDC_OPEN:
                webbrowser.open_new_tab(APP_URL)
                return 0
            if command == IDC_EXIT:
                begin_shutdown()
                return 0
        if message == 0x0010:  # WM_CLOSE
            begin_shutdown()
            return 0
        if message == WM_APP_SHUTDOWN:
            user32.DestroyWindow(hwnd)
            return 0
        if message == 0x0002:  # WM_DESTROY
            user32.PostQuitMessage(0)
            return 0
        return user32.DefWindowProcW(hwnd, message, wparam, lparam)

    class_name = "BDOBarterLauncherWindow"
    window_class = WNDCLASSW()
    window_class.lpfnWndProc = wnd_proc
    window_class.hInstance = hinstance
    window_class.hbrBackground = wintypes.HANDLE(6)  # COLOR_WINDOW + 1
    window_class.lpszClassName = class_name
    if not user32.RegisterClassW(ctypes.byref(window_class)):
        raise ctypes.WinError(ctypes.get_last_error())
    window_handle = user32.CreateWindowExW(
        0, class_name, "BDO 물교 실행 중", 0x00C00000 | 0x10000000,
        100, 100, 350, 145, None, None, hinstance, None,
    )
    if not window_handle:
        raise ctypes.WinError(ctypes.get_last_error())
    user32.ShowWindow(window_handle, 5)
    user32.UpdateWindow(window_handle)

    def watch_api_shutdown() -> None:
        app.extensions["bdo_shutdown_complete"].wait()
        close_server()
        post_close()

    threading.Thread(target=watch_api_shutdown, name="bdo-shutdown-watch", daemon=True).start()
    message = MSG()
    while user32.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
        user32.TranslateMessage(ctypes.byref(message))
        user32.DispatchMessageW(ctypes.byref(message))


def run_launcher() -> int:
    instance = SingleInstance()
    try:
        if not instance.acquire():
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                if _health_is_ours():
                    webbrowser.open_new_tab(APP_URL)
                    return 0
                time.sleep(0.2)
            _message_box(
                "BDO 물교가 이미 실행 중입니다",
                "기존 실행을 찾았지만 localhost 서버가 응답하지 않습니다. 잠시 뒤 다시 실행해 주세요.",
            )
            return 1
        if _health_is_ours():
            webbrowser.open_new_tab(APP_URL)
            return 0

        packaged_root = resource_root()
        app = create_app(reference_path=packaged_root / "reference" / "barter_items.json")
        try:
            from waitress import create_server

            server = create_server(app, host=HOST, port=PORT, threads=4)
        except OSError as error:
            raise RuntimeError(_friendly_start_error(error)) from error

        server_thread = threading.Thread(target=server.run, name="bdo-waitress", daemon=True)
        server_thread.start()
        if not wait_for_health():
            server.close()
            server_thread.join(timeout=5)
            raise RuntimeError(f"localhost:{PORT} 서버가 준비 시간 안에 응답하지 않았습니다.")

        # Open the browser only after the fixed loopback health endpoint responds.
        webbrowser.open_new_tab(APP_URL)
        _run_manager_window(server, server_thread, app)
        return 0
    except Exception as error:
        _message_box("BDO 물교 시작 실패", _friendly_start_error(error), error=True)
        return 1
    finally:
        instance.release()


if __name__ == "__main__":
    raise SystemExit(run_launcher())
