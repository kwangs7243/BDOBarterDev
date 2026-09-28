from __future__ import annotations

import json
import os
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError

from local_app import launcher
from local_app.backend.app import create_app


class LauncherResourceTests(unittest.TestCase):
    def test_source_resource_root_contains_all_runtime_assets(self):
        root = launcher.resource_root()
        self.assertTrue((root / "local_app" / "frontend" / "index.html").is_file())
        self.assertTrue((root / "reference" / "barter_items.json").is_file())
        self.assertTrue((root / "tools" / "warehouse_patch" / "quantity_templates.npz").is_file())

    def test_packaged_resource_root_uses_extraction_root_not_working_directory(self):
        with patch.object(launcher.sys, "frozen", True, create=True), patch.object(
            launcher.sys, "_MEIPASS", r"Z:\isolated\release\_internal", create=True
        ):
            self.assertEqual(launcher.resource_root(), Path(r"Z:\isolated\release\_internal"))

    def test_health_probe_accepts_only_this_application(self):
        class Response:
            def __init__(self, payload):
                self.payload = json.dumps(payload).encode()

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return self.payload

        with patch.object(launcher, "urlopen", return_value=Response({"ok": True, "service": "bdo-barter-local"})):
            self.assertTrue(launcher._health_is_ours())
        with patch.object(launcher, "urlopen", return_value=Response({"ok": True, "service": "other"})):
            self.assertFalse(launcher._health_is_ours())
        with patch.object(launcher, "urlopen", side_effect=URLError("offline")):
            self.assertFalse(launcher._health_is_ours())


@unittest.skipUnless(os.name == "nt", "Windows named mutex behavior is release-platform specific")
class LauncherSingleInstanceTests(unittest.TestCase):
    def test_second_launcher_cannot_claim_the_running_instance(self):
        # An isolated name tests the real mutex without touching a running user app.
        with patch.object(launcher, "MUTEX_NAME", f"Local\\BDOBarter-test-{uuid.uuid4()}"):
            self._check_single_instance()

    def _check_single_instance(self):
        first = launcher.SingleInstance()
        second = launcher.SingleInstance()
        try:
            self.assertTrue(first.acquire())
            self.assertFalse(second.acquire())
        finally:
            second.release()
            first.release()
        third = launcher.SingleInstance()
        try:
            self.assertTrue(third.acquire())
        finally:
            third.release()


class ShutdownDrainTests(unittest.TestCase):
    def test_shutdown_waits_for_mutation_and_rejects_new_writes(self):
        with tempfile.TemporaryDirectory(prefix="bdo-shutdown-") as temp:
            database = Path(temp) / "data" / "bdo.sqlite3"
            app = create_app(database_path=database, testing=True)
            app.config["TESTING"] = True
            condition = app.extensions["bdo_mutation_condition"]
            state = app.extensions["bdo_mutation_state"]
            with condition:
                state["active"] = 1

            completed = threading.Event()
            result = {}

            def request_shutdown():
                with app.test_client() as client:
                    response = client.post("/api/app/shutdown", json={})
                    result["status"] = response.status_code
                    result["body"] = response.get_json()
                    completed.set()

            thread = threading.Thread(target=request_shutdown)
            thread.start()
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                with condition:
                    if state["stopping"]:
                        break
                time.sleep(0.01)
            self.assertFalse(completed.is_set(), "shutdown must wait while a write/scan is active")

            with app.test_client() as client:
                bootstrap = client.get("/api/bootstrap").get_json()
                payload = {
                    "mutationId": "after-shutdown-start",
                    "baseRevision": bootstrap["revision"],
                    "kind": "manual",
                    "patch": {"items": {}},
                }
                blocked = client.patch("/api/inventory", json=payload)
                self.assertEqual(blocked.status_code, 503)

            with condition:
                state["active"] = 0
                condition.notify_all()
            thread.join(timeout=3)
            self.assertTrue(completed.is_set())
            self.assertEqual(result["status"], 200)
            self.assertTrue(result["body"]["ok"])
            self.assertTrue(app.extensions["bdo_shutdown_complete"].wait(timeout=2))


if __name__ == "__main__":
    unittest.main()
