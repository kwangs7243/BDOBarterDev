"""Exercise the rebuilt executable with isolated AppData and bundled OCR only."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from urllib.error import URLError
from urllib.request import Request, urlopen
from uuid import uuid4

from PIL import Image

BASE = "http://127.0.0.1:18765"
FIXTURES = Path(__file__).resolve().parent / "fixtures/trade-recognition"


def request(path, data=None, content_type="application/json"):
    headers = {"Origin": BASE, "Content-Type": content_type}
    with urlopen(Request(BASE + path, data=data, headers=headers), timeout=120) as response:
        return json.load(response)


def wait_for(predicate, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = predicate()
            if result:
                return result
        except (OSError, URLError):
            pass
        time.sleep(.1)
    raise RuntimeError("Packaged application readiness timed out")


def batch_body(mapping):
    batch_id, boundary = str(uuid4()), "bdo-package-" + uuid4().hex
    captures, images = [], []
    for entry in mapping:
        path = FIXTURES / entry["image"]
        with Image.open(path) as image:
            width, height = image.size
        capture_id = str(uuid4())
        metadata = {"version": 1, "captureId": capture_id, "batchId": batch_id,
                    "taskType": "trade", "sourceType": "file", "capturedAt": "2026-10-03T00:00:00Z",
                    "frame": {"width": width, "height": height},
                    "fidelity": {"sourceWidth": width, "sourceHeight": height, "rescaled": False, "evidence": "file-metadata"},
                    "profileId": None, "profileVersion": 1,
                    "context": {"baseRevision": 0, "sessionId": None, "sessionRevision": None},
                    "observed": {"browserDpr": None, "windowsDpi": None, "gameResolution": None, "gameUiScale": None}}
        captures.append({"captureId": capture_id, "metadata": metadata})
        images.append(path.read_bytes())
    manifest = json.dumps({"version": 1, "batchId": batch_id, "captures": captures}).encode()
    parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="batch"\r\n\r\n'.encode() + manifest + b"\r\n"]
    for index, data in enumerate(images, 1):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="capture-{index:04d}.png"\r\nContent-Type: image/png\r\n\r\n'.encode() + data + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        request("/api/health")
    except (OSError, URLError):
        pass
    else:
        raise RuntimeError("Port 18765 is already occupied; refusing to test another app")
    mapping = json.loads((FIXTURES / "live-list-mapping.json").read_text(encoding="utf-8"))
    oracle = json.loads((FIXTURES / "정답.json").read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(prefix="bdo-package-live-") as temporary:
        environment = {key: value for key, value in os.environ.items() if not key.startswith("BDO_TRADE_OCR_")}
        environment["LOCALAPPDATA"] = temporary
        process = subprocess.Popen([str(args.exe.resolve())], cwd=temporary, env=environment,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            wait_for(lambda: request("/api/health").get("ok"))
            runtime = request("/api/recognition/trade-runtime")["runtime"]
            assert runtime["available"] and runtime["mode"] == "PACKAGED_LOCAL_RUNTIME", runtime
            before = request("/api/bootstrap")
            duplicate = subprocess.Popen([str(args.exe.resolve())], cwd=temporary, env=environment,
                                         creationflags=subprocess.CREATE_NO_WINDOW)
            assert duplicate.wait(timeout=20) == 0
            body, content_type = batch_body(mapping)
            result = request("/api/recognition/trade-live-list", body, content_type)["result"]
            expected = [oracle[index] for entry in mapping for index in entry["oracleRows"]]
            assert len(result["rows"]) == len(expected) == 80
            numeric = {name: sum(row["fields"][name]["corrected"] == truth[name]
                                for row, truth in zip(result["rows"], expected))
                       for name in ("reqAmount", "count", "yield")}
            assert all(value == 80 for value in numeric.values()), numeric
            assert request("/api/bootstrap") == before, "Recognition changed the working session or stock"
            request("/api/app/shutdown", b"{}")
            assert process.wait(timeout=20) == 0
            restarted = subprocess.Popen([str(args.exe.resolve())], cwd=temporary, env=environment,
                                         creationflags=subprocess.CREATE_NO_WINDOW)
            process = restarted
            wait_for(lambda: request("/api/health").get("ok"))
            assert request("/api/bootstrap") == before, "Packaged restart changed persisted data"
            report = {"ok": True, "runtime": runtime, "images": 16, "rows": 80, "numericExact": numeric,
                      "externalOcrEnvironmentRemoved": True, "singleInstance": True,
                      "restartPersistence": True, "exeSha256": hashlib.sha256(args.exe.read_bytes()).hexdigest()}
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps(report, ensure_ascii=True, indent=2))
        finally:
            if process.poll() is None:
                try:
                    request("/api/app/shutdown", b"{}")
                    process.wait(timeout=20)
                except (OSError, subprocess.TimeoutExpired):
                    process.kill()
                    process.wait(timeout=5)


if __name__ == "__main__":
    main()
