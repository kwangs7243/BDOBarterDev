"""Verify the frozen package against isolated LocalAppData and existing browser suites."""
from __future__ import annotations
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

DEV = Path(__file__).resolve().parents[1]
ROOT = DEV.parent
EVIDENCE = DEV / "reports/freeze-20260926"
BASE = "http://127.0.0.1:18765/"
NODE = shutil.which("node")
CHROME = Path(os.environ.get("BDO_CHROME", r"C:\Program Files\Google\Chrome\Application\chrome.exe"))
TEMP = Path(tempfile.mkdtemp(prefix="BDO-Frozen-Release-"))
EXE = ROOT / "app/BDO 물교 실행.exe"
USER_DB = Path(os.environ["LOCALAPPDATA"]) / "BDOBarter/data/bdo.sqlite3"
RESULT = {"temporaryRoot": str(TEMP), "browserSuites": {}, "actualUserDatabaseTouched": False}
user_hash = hashlib.sha256(USER_DB.read_bytes()).hexdigest() if USER_DB.exists() else None
startup = subprocess.STARTUPINFO()
startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
startup.wShowWindow = 0

def request(path, body=None, method=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    req = Request(BASE + path, data=data, method=method,
                  headers={"Content-Type": "application/json", "Origin": BASE.rstrip("/")})
    with urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def health():
    try:
        r = request("api/health")
        return r.get("service") == "bdo-barter-local" and r.get("ok") is True
    except Exception:
        return False

def wait(predicate, label, timeout=40):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = predicate()
            if value:
                return value
        except (OSError, ValueError, RuntimeError):
            pass
        time.sleep(.1)
    raise RuntimeError("Timed out: " + label)

def browser_rpc(profile, close=False, expression=None):
    port = int((profile / "DevToolsActivePort").read_text().splitlines()[0])
    js = """
const port=process.argv[1],close=process.argv[2]==='close';
const data=await fetch('http://127.0.0.1:'+port+(close?'/json/version':'/json/list')).then(r=>r.json());
const target=close?data:data.find(t=>t.url==='http://127.0.0.1:18765/');
if(!target)throw Error('launcher did not open localhost browser tab');
const ws=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok,fail)=>{ws.onopen=ok;ws.onerror=fail});
const response=new Promise((ok,fail)=>{const timeout=setTimeout(()=>fail(Error('CDP timeout')),10000);ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1){clearTimeout(timeout);ok(m)}};ws.onclose=()=>{if(close){clearTimeout(timeout);ok({closed:true})}}});
ws.send(JSON.stringify({id:1,method:close?'Browser.close':'Runtime.evaluate',params:close?{}:{expression:process.argv[3]||"new Promise(resolve=>{const t=setInterval(()=>{if(document.querySelectorAll('.inventory-row').length===70){clearInterval(t);resolve({url:location.href,rows:70,title:document.title})}},100)})",awaitPromise:true,returnByValue:true}}));
console.log(JSON.stringify(await response));ws.close();
"""
    r = subprocess.run([NODE, "--input-type=module", "-e", js, str(port), "close" if close else "read", expression or ""],
                       capture_output=True, text=True, encoding="utf-8", timeout=20, startupinfo=startup)
    if r.returncode:
        raise RuntimeError(r.stderr)
    result = json.loads(r.stdout)
    if not close and (result.get("error") or result.get("result", {}).get("exceptionDetails")):
        raise RuntimeError("Browser not ready: " + json.dumps(result))
    return result

def env_for(name):
    profile = TEMP / (name + "-browser")
    env = os.environ.copy()
    env["LOCALAPPDATA"] = str(TEMP / (name + "-data"))
    env["PATH"] = str(Path(os.environ["SystemRoot"]) / "System32")
    for key in ("PYTHONHOME", "PYTHONPATH"):
        env.pop(key, None)
    env["BROWSER"] = (f'"{CHROME}" --headless=new --no-sandbox --disable-gpu --no-first-run '
                      f'--disable-background-networking --remote-debugging-port=0 '
                      f'--user-data-dir="{profile}" %s &')
    return env, profile

def start(env, profile, exe=EXE, use_cmd=False):
    if health():
        raise RuntimeError("Port already holds an application; refusing to use its data")
    if use_cmd:
        p = subprocess.run([os.environ["COMSPEC"], "/d", "/c", str(ROOT / "실행하기.cmd")],
                           cwd=TEMP, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, startupinfo=startup)
        if p.returncode:
            raise RuntimeError("User CMD launcher failed: " + str(p.returncode))
    else:
        subprocess.Popen([str(exe)], cwd=TEMP, env=env, startupinfo=startup)
    wait(health, "packaged health")
    wait(lambda: (profile / "DevToolsActivePort").exists(), "automatic browser launch")
    return wait(lambda: browser_rpc(profile), "loaded automatic browser")

def stop(profile):
    request("api/app/shutdown", {})
    wait(lambda: not health(), "server shutdown")
    try:
        browser_rpc(profile, close=True)
    finally:
        time.sleep(.5)

def fresh_case(name, suite=None, use_cmd=False):
    env, profile = env_for(name)
    try:
        opened = start(env, profile, use_cmd=use_cmd)
        if suite:
            testenv = os.environ.copy()
            testenv["PYTHON"] = sys.executable
            testenv["BDO_TEST_URL"] = BASE
            testenv["BDO_TEST_DATABASE"] = str(Path(env["LOCALAPPDATA"]) / "BDOBarter/data/bdo.sqlite3")
            r = subprocess.run([NODE, str(DEV / "local_app/tests" / (suite + ".mjs"))],
                               cwd=DEV, env=testenv, capture_output=True, timeout=180, startupinfo=startup)
            (EVIDENCE / ("packaged-" + suite + ".log")).write_bytes(r.stdout + r.stderr)
            if r.returncode:
                raise RuntimeError(suite + " failed; inspect its log")
            RESULT["browserSuites"][suite] = {"exitCode": r.returncode, "target": BASE,
                                                "automaticBrowser": opened}
        return env, profile
    finally:
        if health():
            stop(profile)

# Refuse to touch an existing listener, including a user's running app.
with socket.socket() as probe:
    probe.bind(("127.0.0.1", 18765))
try:
    suites = ("browser_smoke", "browser_warehouse_scan", "browser_trade_session", "browser_scheduler")
    if "--lifecycle-only" in sys.argv:
        previous = json.loads((EVIDENCE / "attempt5-packaged-runtime.json").read_text(encoding="utf-8"))
        assert all(previous["browserSuites"][name]["exitCode"] == 0 for name in suites)
        RESULT["browserSuites"] = previous["browserSuites"]
        RESULT["priorBrowserSuiteEvidence"] = "attempt5-packaged-runtime.json"
        suites = ()
    for i, suite in enumerate(suites):
        fresh_case(suite, suite, use_cmd=(i == 0))
        print("PACKAGED PASS:", suite, flush=True)
    RESULT["rootCmdDifferentWorkingDirectory"] = True

    relocated = TEMP / "relocated package"
    shutil.copytree(ROOT / "app", relocated)
    env, profile = env_for("durable")
    try:
        RESULT["relocatedAutomaticBrowser"] = start(env, profile, exe=relocated / EXE.name)
        second = subprocess.run([str(relocated / EXE.name)], env=env, cwd=TEMP,
                                timeout=20, startupinfo=startup)
        assert second.returncode == 0 and health()
        RESULT["secondInstance"] = {"exitCode": second.returncode, "originalHealthy": True}
        snapshot = request("api/bootstrap")
        name = snapshot["inventory"][0]["programName"]
        body = {"mutationId": "frozen-inventory-43", "baseRevision": snapshot["revision"],
                "kind": "manual", "patch": {"items": {name: {"stock": 43}}}}
        first = request("api/inventory", body, "PATCH")
        repeat = request("api/inventory", body, "PATCH")
        assert repeat["idempotent"] is True and first["revision"] == repeat["revision"]
        snapshot = request("api/bootstrap")
        request("api/settings", {"mutationId": "frozen-ship-speed",
                "baseRevision": snapshot["revision"], "settings": {"ship": {"speed": 181}}}, "PATCH")
        stop(profile)
        start(env, profile, exe=relocated / EXE.name)
        snapshot = request("api/bootstrap")
        assert next(x for x in snapshot["inventory"] if x["programName"] == name)["stock"] == 43
        assert snapshot["settings"]["ship"]["speed"] == 181
        database = Path(env["LOCALAPPDATA"]) / "BDOBarter/data/bdo.sqlite3"
        with sqlite3.connect(database) as db:
            tables = sorted(x[0] for x in db.execute("select name from sqlite_master where type='table'"))
        assert tables == ["app_meta", "inventory", "settings"]
        RESULT["durableRestart"] = {"stock": 43, "shipSpeed": 181, "tables": tables, "mutationRetryIdempotent": True}

        seed = json.loads((DEV / "fixtures/KNOWN_CORRECT_SPECIAL_IMPORT_4.json").read_text(encoding="utf-8"))[0]
        normal = json.dumps([seed], ensure_ascii=False)
        fenced = "\x60\x60\x60json\n" + normal + "\n\x60\x60\x60"
        expression = """(async()=>{
const {state}=await import('/assets/js/state.js');
const apply=async(text)=>{
 document.querySelector('#trade-json-input').value=text;
 document.querySelector('#apply-new-session').click();
 await new Promise(resolve=>setTimeout(resolve,300));
 if(!state.session.scannedTrades?.length)throw Error('No imported trades');
 return JSON.stringify(state.session.scannedTrades);
};
const normal=await apply(NORMAL_INPUT);
const fenced=await apply(FENCED_INPUT);
if(normal!==fenced)throw Error('Fenced import changed rows');
return {normalArray:true,markdownFence:true,identical:true,rows:JSON.parse(normal).length};
})()""".replace("NORMAL_INPUT", json.dumps(normal, ensure_ascii=False)).replace("FENCED_INPUT", json.dumps(fenced, ensure_ascii=False))
        RESULT["packagedJsonForms"] = browser_rpc(profile, expression=expression)["result"]["result"]["value"]

        RESULT["pythonlessEnvironment"] = {"PATH": env["PATH"], "PYTHONHOME": None, "PYTHONPATH": None}
    finally:
        if health():
            stop(profile)

    class OtherService(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"service":"unrelated","ok":true}')
        def log_message(self, *args):
            pass
    listener = ThreadingHTTPServer(("127.0.0.1", 18765), OtherService)
    threading.Thread(target=listener.serve_forever, daemon=True).start()
    env, profile = env_for("port-conflict")
    conflict = subprocess.Popen([str(EXE)], cwd=TEMP, env=env, startupinfo=startup)
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
    user32.GetWindowTextW.argtypes = (wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
    user32.PostMessageW.argtypes = (wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def dismiss_owned_error():
        found = []
        @callback_type
        def callback(hwnd, _):
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value == conflict.pid:
                title = ctypes.create_unicode_buffer(256)
                user32.GetWindowTextW(hwnd, title, 256)
                if title.value == "BDO 물교 시작 실패":
                    found.append(title.value)
                    user32.PostMessageW(hwnd, 0x0111, 1, 0)
            return True
        user32.EnumWindows(callback, 0)
        return found
    try:
        titles = wait(dismiss_owned_error, "owned port-conflict message box")
        code = conflict.wait(timeout=15)
        assert code == 1
        with urlopen(BASE) as response:
            assert json.loads(response.read())["service"] == "unrelated"
        RESULT["portConflict"] = {"exitCode": code, "errorWindow": titles, "otherListenerPreserved": True}
    finally:
        if conflict.poll() is None:
            conflict.terminate()
        listener.shutdown()
        listener.server_close()
    assert user_hash == (hashlib.sha256(USER_DB.read_bytes()).hexdigest() if USER_DB.exists() else None)
    RESULT["actualUserDatabaseHashUnchanged"] = True
    RESULT["ok"] = True
finally:
    (EVIDENCE / "packaged-runtime.json").write_text(json.dumps(RESULT, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(RESULT, ensure_ascii=False, indent=2))
