"""Exercise the rebuilt executable with isolated AppData and bundled OCR only."""
from __future__ import annotations

import argparse
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import shutil
import sqlite3
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
    with urlopen(Request(BASE + path, data=data, headers=headers), timeout=150) as response:
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


def batch_body(mapping, batch_id=None):
    batch_id, boundary = batch_id or str(uuid4()), "bdo-package-" + uuid4().hex
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


def exercise_alchemy():
    data = request("/api/alchemy/catalog?full=1")
    ids = {item["name"]: item["item_id"] for item in data["items"]}
    assert len(data["items"]) == 170 and len(data["recipes"]) == 87
    recipe = next(row for row in data["recipes"] if row["output_item_id"] == ids["맑은 액체 시약"])

    def change(action, **values):
        state = request("/api/alchemy/state")
        payload = {"mutationId": str(uuid4()), "baseRevision": state["revision"], **values}
        return request("/api/alchemy/mutations/" + action, json.dumps(payload).encode())

    change("inventory", changes=[{"item_id": ids[name], "quantity": quantity} for name, quantity in (
        ("맑은 액체 시약", 0), ("소금", 20), ("여명초", 20), ("정제수", 20), ("야생 들풀", 20))])
    job = change("start", recipe_id=recipe["recipe_id"], calls=5)["job"]
    state = request("/api/alchemy/state")
    assert state["inventory"][ids["소금"]] == 15 and state["inventory"][ids["맑은 액체 시약"]] == 0
    finish = json.dumps({"mutationId": str(uuid4()), "baseRevision": state["revision"], "job_id": job["job_id"],
                         "executed_calls": 3, "outputs": {ids["맑은 액체 시약"]: 7}}).encode()
    result = request("/api/alchemy/mutations/finish", finish)
    assert request("/api/alchemy/mutations/finish", finish) == result
    state = request("/api/alchemy/state")
    assert state["inventory"][ids["소금"]] == 17 and state["inventory"][ids["맑은 액체 시약"]] == 7
    learned = state["yield_statistics"]
    observed = next(v for v in learned.values() if v["recipe_id"] == recipe["recipe_id"])
    assert (observed["total_calls"], observed["total_output"], observed["jobs"]) == (3, 7, 1)
    goal = change("goal", item_id=ids["조화의 영약"], quantity=25, mode="held", priority=0,
                  assume_unknown_zero=True)["goal"]
    plan = request("/api/alchemy/plans")["plans"][0]
    assert plan["goal_id"] == goal["goal_id"]
    learned_row = next(row for row in plan["rows"] if row["item_id"] == recipe["output_item_id"])
    assert learned_row["yield_source"] == "history" and learned_row["expected_yield"] == 7 / 3
    backup = request("/api/alchemy/backup")
    assert backup["format"] == "bdo-alchemy-backup"
    change("inventory", changes=[{"item_id": ids["소금"], "quantity": 0}])
    restored = change("restore", backup=backup)
    assert restored["previous_backup_id"]
    state = request("/api/alchemy/state")
    assert state["inventory"][ids["소금"]] == 17 and state["goals"][0]["goal_id"] == goal["goal_id"]
    assert state["yield_statistics"] == learned
    return state


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--ocr-baseline", type=Path, required=True, help="Verified prior installed-package OCR comparison report")
    parser.add_argument("--expected-worker-version", help="Explicit worker version for an intentional engine update; OCR comparisons remain unchanged")
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.out.parent.mkdir(parents=True, exist_ok=True)
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
        environment["BROWSER"] = f'"{Path(os.sys.executable).with_name("pythonw.exe")}" -c pass %s'
        process = subprocess.Popen([str(args.exe.resolve())], cwd=temporary, env=environment,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            wait_for(lambda: request("/api/health").get("ok"))
            suite = request("/suite-health")
            assert suite["service"] == "bdo-suite-local" and suite["workspaces"] == ["barter", "alchemy"]
            with urlopen(BASE + "/", timeout=10) as response:
                portal = response.read().decode("utf-8")
                assert 'href="/barter/"' in portal and 'href="/alchemy/"' in portal
            native = request("/api/native-capture")
            assert native["available"] and native["mode"] == "NONE" and native["state"] == "IDLE", native
            assert not native["hotkeyRegistered"] and native["pending"] == 0, native
            with urlopen(BASE + "/assets/js/native-capture-ui.js", timeout=10) as response:
                assert b"initNativeCaptureUI" in response.read(), "Native UI is missing from the package"
            runtime = request("/api/recognition/trade-runtime")["runtime"]
            assert runtime["available"] and runtime["mode"] == "PACKAGED_LOCAL_RUNTIME", runtime
            before = request("/api/bootstrap")
            assert before["schemaVersion"] == 4 and before["revision"] == 0
            databases = list(Path(temporary).rglob("*.sqlite3"))
            assert len(databases) == 1 and databases[0].name == "bdo.sqlite3", databases
            with closing(sqlite3.connect(databases[0])) as connection:
                tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            assert tables == {"inventory", "settings", "app_meta", "working_session", "saved_schedule_slot",
                              "mutation_receipt", "warehouse_scan", "warehouse_feedback", "trade_correction"}, tables
            duplicate = subprocess.Popen([str(args.exe.resolve())], cwd=temporary, env=environment,
                                         creationflags=subprocess.CREATE_NO_WINDOW)
            assert duplicate.wait(timeout=20) == 0
            batch_id = str(uuid4())
            body, content_type = batch_body(mapping, batch_id)
            observed_progress = []
            with ThreadPoolExecutor(max_workers=1) as executor:
                pending = executor.submit(request, "/api/recognition/trade-live-list", body, content_type)
                while not pending.done():
                    try:
                        observed_progress.append(request(f"/api/recognition/trade-progress/{batch_id}")["progress"])
                    except (OSError, URLError):
                        pass
                    time.sleep(.25)
                result = pending.result()["result"]
            assert any(value["stage"] == "recognizing" and value["currentRowsCompleted"] > 0
                       for value in observed_progress), "No actual intermediate OCR progress was observed"
            assert all(value["totalCaptures"] == len(mapping) for value in observed_progress)
            assert request(f"/api/recognition/trade-progress/{batch_id}")["progress"]["stage"] == "complete"
            expected = [oracle[index] for entry in mapping for index in entry["oracleRows"]]
            assert len(result["rows"]) == len(expected) == 80
            ocr_duration_ms = result["runtime"]["durationMs"]
            numeric = {name: sum(row["fields"][name]["corrected"] == truth[name]
                                for row, truth in zip(result["rows"], expected))
                       for name in ("reqAmount", "count", "yield")}
            numeric_errors = [{"row": index, "field": name, "actual": row["fields"][name]["corrected"], "expected": truth[name]}
                              for index, (row, truth) in enumerate(zip(result["rows"], expected))
                              for name in numeric if row["fields"][name]["corrected"] != truth[name]]
            baseline = json.loads(args.ocr_baseline.read_text(encoding="utf-8"))
            assert isinstance(baseline, dict) and baseline.get("ok"), "A verified package baseline is required"
            assert baseline["runtime"]["modelBundleSha256"] == runtime["modelBundleSha256"]
            assert runtime["workerVersion"] == (args.expected_worker_version or baseline["runtime"]["workerVersion"])
            assert numeric == baseline["numeric"] and numeric_errors == baseline["numericErrors"], numeric_errors
            assert [{name: field["corrected"] for name, field in row["fields"].items()} for row in result["rows"]] == baseline["correctedFields"]
            fully_correct = sum(all(row["fields"][name]["corrected"] == truth[name] for name in truth)
                                for row, truth in zip(result["rows"], expected))
            assert fully_correct >= 76, fully_correct
            assert request("/api/bootstrap") == before, "Recognition changed the working session or stock"
            browser_environment = {**environment, "BDO_EXTERNAL_APP": "1", "BDO_TEST_URL": BASE + "/",
                                   "PYTHON": str(Path(os.sys.executable)),
                                   "BDO_LIVE_REPORT_DIR": str(args.out.parent / "browser")}
            browser_checks = []
            alchemy_before = exercise_alchemy()
            for script in ("browser_trade_live_list.mjs", "browser_warehouse_scan.mjs", "browser_scheduler.mjs", "packaging/browser_suite.mjs"):
                completed = subprocess.run([shutil.which("node"), str(Path(__file__).parent / script)],
                                           cwd=Path(__file__).resolve().parents[2], env=browser_environment,
                                           creationflags=subprocess.CREATE_NO_WINDOW, capture_output=True,
                                           text=True, encoding="utf-8", timeout=300)
                (args.out.parent / (script.replace("/", "-") + ".log")).write_text(completed.stdout + completed.stderr, encoding="utf-8")
                assert completed.returncode == 0, f"{script}: {completed.stderr[-2000:]}"
                browser_checks.append(script)
            before = request("/api/bootstrap")
            with closing(sqlite3.connect(databases[0])) as connection:
                corrections = connection.execute("SELECT image_png, details_json FROM trade_correction").fetchall()
                assert corrections and all(row[0] and (json.loads(row[1])["corrections"] or json.loads(row[1]).get("snapshot")) for row in corrections)
                scans = connection.execute("SELECT count(*) FROM warehouse_scan").fetchone()[0]
                feedback = connection.execute("SELECT feedback_json FROM warehouse_feedback").fetchall()
                assert scans > 0 and any(json.loads(row[0])["rows"] for row in feedback)
                persisted_feedback = list(connection.iterdump())
            request("/api/app/shutdown", b"{}")
            assert process.wait(timeout=20) == 0
            restarted = subprocess.Popen([str(args.exe.resolve())], cwd=temporary, env=environment,
                                         creationflags=subprocess.CREATE_NO_WINDOW)
            process = restarted
            wait_for(lambda: request("/api/health").get("ok"))
            assert request("/api/bootstrap") == before, "Packaged restart changed persisted data"
            assert request("/api/alchemy/state") == alchemy_before, "Packaged restart changed alchemy data"
            with closing(sqlite3.connect(databases[0])) as connection:
                assert list(connection.iterdump()) == persisted_feedback
            report = {"ok": True, "runtime": runtime, "images": 16, "rows": 80, "numeric": numeric,
                      "suitePortal": True, "alchemyActualCrafting": True, "alchemyYieldLearning": True, "alchemyDuplicateFinish": True,
                      "alchemyBackupRestore": True, "alchemyRestartPersistence": True,
                      "intermediateProgressObserved": True, "progressSamples": len(observed_progress),
                      "correctedFields": [{name: field["corrected"] for name, field in row["fields"].items()} for row in result["rows"]],
                      "fullyCorrectRows": fully_correct, "ocrDurationMs": ocr_duration_ms,
                      "ocrBaselineMatched": bool(args.ocr_baseline), "numericErrors": numeric_errors,
                      "baselineWorkerVersion": baseline["runtime"]["workerVersion"],
                      "freshSchema": 4, "tables": sorted(tables),
                      "browserProductFlows": browser_checks, "tradeCorrectionCaptures": len(corrections),
                      "warehouseScans": scans, "warehouseFeedbackApplications": len(feedback),
                      "externalOcrEnvironmentRemoved": True, "singleInstance": True,
                      "restartPersistence": True, "nativeCaptureStandby": True, "nativeUiBundled": True, "exeSha256": hashlib.sha256(args.exe.read_bytes()).hexdigest()}
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
