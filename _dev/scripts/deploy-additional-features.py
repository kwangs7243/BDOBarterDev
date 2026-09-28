"""Preserve the installed app/data, verify frozen runtime, then deploy approved changes."""
from pathlib import Path
from contextlib import closing
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from urllib.request import Request, urlopen
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "_dev/test_results/additional_features"
SOURCE = ROOT / "_dev/build/additional-dist/app"
BASE = "http://127.0.0.1:18765"
DATABASE = Path(os.environ["LOCALAPPDATA"]) / "BDOBarter/data/bdo.sqlite3"
TABLES = ["inventory", "settings", "working_session", "saved_schedule_slot", "mutation_receipt"]
startup = subprocess.STARTUPINFO()
startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
startup.wShowWindow = 0


def request(path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    with urlopen(Request(BASE+path, data=data, headers={"Origin": BASE, "Content-Type": "application/json"}), timeout=30) as response:
        return json.load(response)


def fingerprints(path):
    with closing(sqlite3.connect(path.as_uri()+"?mode=ro", uri=True)) as connection:
        values = {table: sorted(connection.execute(f"SELECT * FROM {table}").fetchall()) for table in TABLES}
        values["meta"] = connection.execute("SELECT revision,last_mutation_id,last_mutation_hash FROM app_meta WHERE id=1").fetchone()
        return {table: hashlib.sha256(json.dumps(rows, ensure_ascii=False, sort_keys=True).encode()).hexdigest() for table, rows in values.items()}


def safe_directory(path):
    resolved = path.resolve()
    if not resolved.is_relative_to(ROOT.resolve()) or resolved == ROOT.resolve():
        raise RuntimeError(f"Directory is outside the approved workspace: {path}")
    return path


def start_installed():
    return subprocess.Popen([str(ROOT / "app/BDO 물교 실행.exe")], cwd=ROOT, startupinfo=startup)


def wait(predicate, label):
    until = time.monotonic()+40
    while time.monotonic()<until:
        try:
            if predicate(): return
        except OSError: pass
        time.sleep(.15)
    raise RuntimeError("Timed out: "+label)


def stopped():
    try: request("/api/health"); return False
    except OSError: return True


before = request("/api/bootstrap")
(OUT / "installed-before.json").write_text(json.dumps(before, ensure_ascii=False, indent=2), encoding="utf-8")
print("Stopping installed app normally and preserving SQLite snapshot", flush=True)
request("/api/app/shutdown", {})
wait(stopped, "old app shutdown")
backup = OUT / f"user-data-before-schema3-{uuid4().hex[:8]}.sqlite3"
with closing(sqlite3.connect(DATABASE.as_uri()+"?mode=ro", uri=True)) as original, closing(sqlite3.connect(backup)) as preserved:
    original.backup(preserved)
baseline = fingerprints(backup)
try:
    print("Verifying frozen executable with isolated user data", flush=True)
    env = os.environ.copy()
    env["BDO_PACKAGE_APP"] = str(SOURCE)
    env["BDO_EVIDENCE_DIR"] = str(OUT)
    with (OUT / "packaged-runtime.log").open("w", encoding="utf-8") as log:
        result = subprocess.run([sys.executable, str(ROOT / "_dev/scripts/verify-restoration-runtime.py")], env=env, stdout=log, stderr=subprocess.STDOUT, startupinfo=startup)
    if result.returncode:
        raise RuntimeError("Frozen executable validation failed; inspect packaged-runtime.log")
except Exception:
    start_installed()
    raise

stamp = "20260926_"+uuid4().hex[:8]
installed_backup = safe_directory(ROOT / ("app_추가기능전_"+stamp))
safe_directory(ROOT / "app").rename(installed_backup)
try:
    shutil.copytree(SOURCE, ROOT / "app")
except Exception:
    # Copy destination may be partial; preserve it for diagnosis instead of deleting.
    if (ROOT / "app").exists():
        safe_directory(ROOT / "app").rename(safe_directory(ROOT / ("app_복사실패_"+stamp)))
    installed_backup.rename(ROOT / "app")
    start_installed()
    raise
stage = safe_directory(ROOT / "업데이트_검증판/app")
if stage.exists(): stage.rename(safe_directory(stage.parent / ("app_추가기능전_"+stamp)))
shutil.copytree(SOURCE, stage)
print("Starting updated installed app", flush=True)
process = start_installed()
wait(lambda: request("/api/health").get("schemaVersion")==3, "installed schema 3 health")
after = request("/api/bootstrap")
assert fingerprints(DATABASE)==baseline, "User data changed during additive schema migration"
expected = {p.relative_to(SOURCE).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in SOURCE.rglob("*") if p.is_file()}
actual = {p.relative_to(ROOT / "app").as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT / "app").rglob("*") if p.is_file()}
assert actual==expected, "Installed files differ from validated package"
result = {"ok": True, "schemaVersion": 3, "revision": after["revision"], "inventoryRows": len(after["inventory"]), "workingSessionPreserved": after["workingSession"]==before["workingSession"], "allPreexistingSqliteRowsAndRevisionPreserved": True, "fileComparisons": len(actual), "installedBackup": str(installed_backup), "databaseBackup": str(backup), "installedExeSha256": actual["BDO 물교 실행.exe"], "processId": process.pid, "entrypoint": str(ROOT / "실행하기.cmd")}
(OUT / "deployment.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(result, ensure_ascii=True), flush=True)
