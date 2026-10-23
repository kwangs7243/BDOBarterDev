"""Double-click launcher for the localhost BDO application."""
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

if len(sys.argv) > 1 and sys.argv[1] == "--trade-ocr-worker":
    sys.argv.pop(1)
    from barter.tools.trade_batch_worker import main
    raise SystemExit(main())

from local_app.config import HOST, PORT, SERVICE

APP_URL = f"http://{HOST}:{PORT}/"
HEALTH_URL = f"http://{HOST}:{PORT}/suite-health"
MUTEX_NAME = "Local\\BDOBarter-18765"
ERROR_ALREADY_EXISTS = 183


def resource_root() -> Path:
    """Return the root containing the portal, workspaces, and scanner resources."""
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
        return payload.get("ok") is True and payload.get("service") == SERVICE and payload.get("workspaces") == ["barter", "alchemy"]
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


def run_launcher() -> int:
    instance = SingleInstance()
    native_capture = None
    try:
        if not instance.acquire():
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                if _health_is_ours():
                    webbrowser.open_new_tab(APP_URL)
                    return 0
                time.sleep(0.2)
            _message_box(
                "BDO 프로그램이 이미 실행 중입니다",
                "기존 실행을 찾았지만 localhost 서버가 응답하지 않습니다. 잠시 뒤 다시 실행해 주세요.",
            )
            return 1
        if _health_is_ours():
            webbrowser.open_new_tab(APP_URL)
            return 0

        from local_app.backend.app import create_app
        from local_app.desktop import run_manager

        packaged_root = resource_root()
        stopped = threading.Event()
        service = {}
        close_lock = threading.Lock()

        def close_server():
            with close_lock:
                if stopped.is_set():
                    return
                if native_capture is not None:
                    native_capture.close()
                if service.get("server") is not None:
                    service["server"].close()
                    service["thread"].join(timeout=10)
                stopped.set()

        def start(progress):
            nonlocal native_capture
            progress("캡처와 저장 환경을 확인하고 있습니다.")
            if os.name == "nt":
                from local_app.native_capture import NativeCaptureController
                from local_app.native_win32 import Win32CapturePlatform
                from barter.backend.storage import default_database_path
                native_capture = NativeCaptureController(Win32CapturePlatform(), default_database_path().with_name("native-capture-profiles.json"))
            app = create_app(reference_path=packaged_root / "reference/barter_items.json", native_capture=native_capture)
            service["app"] = app
            progress("물물교환과 연금 작업실을 연결하고 있습니다.")
            from waitress import create_server
            try:
                server = create_server(app, host=HOST, port=PORT, threads=4)
            except OSError as error:
                raise RuntimeError(_friendly_start_error(error)) from error
            service["server"] = server
            thread = threading.Thread(target=server.run, name="bdo-waitress", daemon=True)
            service["thread"] = thread
            thread.start()
            if not wait_for_health():
                close_server()
                raise RuntimeError("로컬 서비스를 시작하지 못했습니다. 잠시 뒤 다시 실행하세요.")
            if native_capture is not None:
                native_capture.start()
            def watch_shutdown():
                app.extensions["bdo_shutdown_complete"].wait()
                close_server()
            threading.Thread(target=watch_shutdown, name="bdo-drain", daemon=True).start()
            progress("통합 메인을 열고 있습니다.")
            webbrowser.open_new_tab(APP_URL)

        def stop():
            request = Request(APP_URL + "api/app/shutdown", data=b"{}", method="POST",
                              headers={"Content-Type": "application/json", "Origin": APP_URL.rstrip("/")})
            with urlopen(request, timeout=35) as response:
                if json.load(response).get("ok") is not True:
                    raise RuntimeError("저장 완료를 확인하지 못했습니다.")
            close_server()

        try:
            if os.name == "nt":
                return run_manager(start, lambda: webbrowser.open_new_tab(APP_URL), stop, stopped,
                                   packaged_root / "local_app/frontend/bdo.ico")
            start(lambda _message: None)
            stopped.wait()
            return 0
        finally:
            close_server()
    except Exception as error:
        _message_box("BDO 프로그램 시작 실패", _friendly_start_error(error), error=True)
        return 1
    finally:
        if native_capture is not None:
            native_capture.close()
        instance.release()


if __name__ == "__main__":
    raise SystemExit(run_launcher())
