"""Exercise the rebuilt executable and feedback export only against disposable data."""
import json
import io
import os
import sqlite3
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path
from urllib.request import Request, urlopen

DEV = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:18765"
EXE = DEV / "build/scan-feedback-dist/app/BDO 물교 실행.exe"
STARTUP = subprocess.STARTUPINFO()
STARTUP.dwFlags |= subprocess.STARTF_USESHOWWINDOW
STARTUP.wShowWindow = 0

def request(path, data=None):
    body = None if data is None else json.dumps(data).encode()
    return urlopen(Request(BASE+path, data=body, headers={"Origin": BASE, "Content-Type": "application/json"}), timeout=20)

with tempfile.TemporaryDirectory(prefix="BDO-FeedbackV2-") as temp:
    temp = Path(temp)
    profile = temp / "chrome"
    env = os.environ.copy()
    env["LOCALAPPDATA"] = str(temp / "data")
    env["BROWSER"] = f'"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --no-sandbox --disable-gpu --remote-debugging-port=0 --user-data-dir="{profile}" %s &'
    for key in ("PYTHONPATH", "PYTHONHOME"):
        env.pop(key, None)
    import socket
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 18765))
    app = subprocess.Popen([str(EXE)], env=env, startupinfo=STARTUP)
    try:
        deadline = time.monotonic()+40
        while True:
            try:
                with request("/api/health") as response: health = json.load(response)
                break
            except OSError:
                if time.monotonic()>deadline: raise RuntimeError("Package startup timed out")
                time.sleep(.15)
        test_env = os.environ.copy()
        test_env["BDO_TEST_URL"] = BASE+"/"
        test_env["PYTHON"] = os.sys.executable
        result = subprocess.run(["node", str(DEV / "local_app/tests/browser_scan_feedback_v2.mjs")], env=test_env, cwd=DEV, startupinfo=STARTUP, capture_output=True, text=True, encoding="utf-8", timeout=90)
        if result.returncode: raise RuntimeError(result.stdout+result.stderr)
        with request("/api/warehouse-dataset") as response: dataset = response.read()
        with zipfile.ZipFile(io.BytesIO(dataset)) as archive:
            samples = [json.loads(line) for line in archive.read("samples.jsonl").splitlines()]
            labels = [f for s in samples for f in s["humanFeedback"] if f["verifiedItemLabel"] and f["verifiedQuantityLabel"]]
            assert len(labels) == 5
            assert {f["user"]["agreement"] for f in labels} >= {"item_only", "quantity_only", "both_match", "both_different"}
            assert json.loads(archive.read("manifest.json"))["formatVersion"] == 2
        with request("/api/bootstrap") as response: bootstrap = json.load(response)
        assert bootstrap["revision"] == 1
        proof = {"ok": True, "frozenExecutable": str(EXE), "browser": json.loads(result.stdout), "verifiedItemAndQuantityLabels": len(labels), "datasetSamples": len(samples), "singleStockRevision": bootstrap["revision"], "userDatabaseUsed": False}
        (DEV / "test_results/scan-feedback-package.json").write_text(json.dumps(proof, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(proof, ensure_ascii=False, indent=2))
    finally:
        try:
            with request("/api/app/shutdown", {}) as response: response.read()
            app.wait(timeout=20)
        except OSError:
            app.kill()
        if (profile / "DevToolsActivePort").exists():
            port = (profile / "DevToolsActivePort").read_text().splitlines()[0]
            code = "const d=await fetch('http://127.0.0.1:'+process.argv[1]+'/json/version').then(r=>r.json());const w=new WebSocket(d.webSocketDebuggerUrl);await new Promise(r=>w.onopen=r);w.send(JSON.stringify({id:1,method:'Browser.close'}));await new Promise(r=>w.onclose=r);"
            subprocess.run(["node", "--input-type=module", "-e", code, port], startupinfo=STARTUP, timeout=10, capture_output=True)
        time.sleep(.3)
