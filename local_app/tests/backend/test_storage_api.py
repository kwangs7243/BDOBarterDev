from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import threading
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from werkzeug.serving import make_server

from local_app.backend.app import HOST, PORT, create_app, serve_local
from local_app.backend.storage import Storage, default_database_path, load_catalog


ITEM_A = "갈퀴 꽃 씨앗 주머니"
ITEM_B = "해적선 돛대"


class StorageApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="bdo-spec001-")
        self.database = Path(self.temporary.name) / "isolated-test.sqlite3"
        self.app = create_app(self.database, testing=True)
        self.client = self.app.test_client()
        self.local = f"http://127.0.0.1:{PORT}"

    def tearDown(self):
        self.temporary.cleanup()

    def bootstrap(self):
        response = self.client.get("/api/bootstrap", base_url=self.local)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.get_json()

    def patch_inventory(self, mutation_id, base_revision, items, kind="warehouse"):
        patch = {"type": "master_inventory_patch", "version": 1, "items": items} if kind == "warehouse" else {"items": items}
        return self.client.patch(
            "/api/inventory", base_url=self.local,
            json={"mutationId": mutation_id, "baseRevision": base_revision, "kind": kind, "patch": patch},
            headers={"Origin": self.local},
        )

    def test_default_database_path_uses_localappdata_and_creates_directories(self):
        local_app_data = Path(self.temporary.name) / "local-app-data"
        expected = local_app_data / "BDOBarter" / "data" / "bdo.sqlite3"
        with patch.dict(os.environ, {"LOCALAPPDATA": str(local_app_data)}):
            self.assertEqual(default_database_path(), expected)
            catalog, order = load_catalog()
            Storage(default_database_path(), catalog, order).initialize()
        self.assertTrue(expected.is_file())
        self.assertTrue((local_app_data / "BDOBarter" / "data").is_dir())

    def test_health_static_bootstrap_and_current_schema(self):
        health = self.client.get("/api/health", base_url=self.local)
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.get_json()["schemaVersion"], 4)
        page = self.client.get("/", base_url=self.local)
        self.assertEqual(page.status_code, 200)
        self.assertIn("/assets/js/state.js", page.get_data(as_text=True))
        page.close()
        snapshot = self.bootstrap()
        self.assertEqual(len(snapshot["inventory"]), 70)
        self.assertEqual(snapshot["revision"], 0)
        with closing(sqlite3.connect(self.database)) as db:
            names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
        self.assertEqual(names, {"inventory", "settings", "app_meta", "working_session", "saved_schedule_slot", "mutation_receipt", "warehouse_scan", "warehouse_feedback", "trade_correction"})

    def test_inventory_partial_patch_and_restart_persistence(self):
        initial = self.bootstrap()
        before = {item["programName"]: item for item in initial["inventory"]}
        self.assertIsNone(before[ITEM_A]["stock"])
        self.assertEqual(before[ITEM_A]["target"], 80)
        self.assertIsNone(before[ITEM_B]["stock"])
        response = self.patch_inventory("partial-1", 0, {ITEM_A: 31})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        after = self.client.get("/api/inventory", base_url=self.local).get_json()
        values = {item["programName"]: item for item in after["items"]}
        self.assertEqual(values[ITEM_A]["stock"], 31)
        self.assertIsNone(values[ITEM_B]["stock"])
        restarted = create_app(self.database, testing=True).test_client().get("/api/bootstrap", base_url=self.local).get_json()
        restored = {item["programName"]: item for item in restarted["inventory"]}
        self.assertEqual(restored[ITEM_A]["stock"], 31)
        self.assertIsNone(restored[ITEM_B]["stock"])
        self.assertEqual(restarted["revision"], 1)

    def test_transaction_rolls_back_all_rows_and_revision_on_database_failure(self):
        store: Storage = self.app.extensions["bdo_storage"]
        with closing(store.connect()) as db:
            db.execute(
                f"""CREATE TRIGGER reject_second_item BEFORE UPDATE ON inventory
                    WHEN NEW.program_name = '{ITEM_B}'
                    BEGIN SELECT RAISE(ABORT, 'forced test failure'); END"""
            )
        response = self.patch_inventory("rollback-1", 0, {ITEM_A: 12, ITEM_B: 22})
        self.assertEqual(response.status_code, 503)
        state = self.bootstrap()
        self.assertTrue(all(item["stock"] is None for item in state["inventory"]))
        self.assertEqual(state["revision"], 0)

    def test_stale_revision_is_rejected(self):
        self.assertEqual(self.patch_inventory("revision-1", 0, {ITEM_A: 7}).status_code, 200)
        stale = self.patch_inventory("revision-2", 0, {ITEM_B: 9})
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.get_json()["error"]["code"], "stale_revision")
        inventory = self.client.get("/api/inventory", base_url=self.local).get_json()["items"]
        self.assertIsNone(next(item["stock"] for item in inventory if item["programName"] == ITEM_B))

    def test_mutation_idempotency_and_reuse_conflict(self):
        body = {"mutationId": "repeat-1", "baseRevision": 0, "kind": "warehouse", "patch": {"type": "master_inventory_patch", "version": 1, "items": {ITEM_A: 18}}}
        first = self.client.patch("/api/inventory", base_url=self.local, json=body)
        again = self.client.patch("/api/inventory", base_url=self.local, json=body)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(again.status_code, 200)
        self.assertTrue(again.get_json()["idempotent"])
        self.assertEqual(again.get_json()["revision"], 1)
        changed = json.loads(json.dumps(body, ensure_ascii=False))
        changed["patch"]["items"][ITEM_A] = 19
        conflict = self.client.patch("/api/inventory", base_url=self.local, json=changed)
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.get_json()["error"]["code"], "mutation_id_reused")
        current = self.bootstrap()
        self.assertEqual(next(item["stock"] for item in current["inventory"] if item["programName"] == ITEM_A), 18)
        self.assertEqual(current["revision"], 1)

    def test_invalid_inventory_values_names_and_tier_are_atomic(self):
        cases = [
            ("negative", {ITEM_A: -1}), ("fraction", {ITEM_A: 1.5}),
            ("string", {ITEM_A: "4"}), ("boolean", {ITEM_A: True}),
            ("unknown", {"존재하지 않는 품목": 4}), ("tier5", {"흰색 애벌레 박제품": 5}),
        ]
        for mutation_id, items in cases:
            with self.subTest(mutation_id=mutation_id):
                result = self.patch_inventory(mutation_id, 0, items)
                self.assertEqual(result.status_code, 422)
        current = self.bootstrap()
        self.assertEqual(current["revision"], 0)
        self.assertTrue(all(item["stock"] is None for item in current["inventory"]))

    def test_manual_inventory_patch_and_order_api(self):
        manual = self.patch_inventory("manual-1", 0, {ITEM_A: {"stock": 0, "target": 90}}, kind="manual")
        self.assertEqual(manual.status_code, 200, manual.get_data(as_text=True))
        order = self.client.get("/api/inventory/order", base_url=self.local).get_json()["order"]
        order["1"] = list(reversed(order["1"]))
        saved = self.client.put(
            "/api/inventory/order", base_url=self.local,
            json={"mutationId": "order-1", "baseRevision": 1, "order": order},
        )
        self.assertEqual(saved.status_code, 200, saved.get_data(as_text=True))
        self.assertEqual(self.client.get("/api/inventory/order", base_url=self.local).get_json()["order"]["1"], order["1"])
        invalid_order = dict(order)
        invalid_order["1"] = [ITEM_B]
        bad = self.client.put(
            "/api/inventory/order", base_url=self.local,
            json={"mutationId": "order-bad", "baseRevision": 2, "order": invalid_order},
        )
        self.assertEqual(bad.status_code, 422)

    def test_settings_patch_is_partial_and_unknown_section_is_rejected(self):
        first = self.client.patch(
            "/api/settings", base_url=self.local,
            json={"mutationId": "settings-1", "baseRevision": 0, "settings": {"ship": {"speed": 181}}},
        )
        self.assertEqual(first.status_code, 200, first.get_data(as_text=True))
        settings = self.client.get("/api/settings", base_url=self.local).get_json()["settings"]
        self.assertEqual(settings["ship"], {"normalWeight": 14379, "maxWeight": 24445, "speed": 181, "mode": "inner"})
        bad = self.client.patch(
            "/api/settings", base_url=self.local,
            json={"mutationId": "settings-bad", "baseRevision": 1, "settings": {"arbitrary": {"x": 1}}},
        )
        self.assertEqual(bad.status_code, 422)
        self.assertEqual(self.bootstrap()["revision"], 1)

    def test_waitress_entry_uses_fixed_loopback_and_port(self):
        mocked_serve = Mock()
        with patch.dict("sys.modules", {"waitress": SimpleNamespace(serve=mocked_serve)}):
            serve_local(self.app)
        mocked_serve.assert_called_once_with(self.app, host="127.0.0.1", port=18765, threads=4)

    def test_actual_loopback_http_and_foreign_host_rejection(self):
        server = make_server(HOST, 0, self.app)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with urlopen(f"http://127.0.0.1:{server.server_port}/api/health", timeout=3) as response:
                self.assertEqual(response.status, 200)
                self.assertTrue(json.loads(response.read())["ok"])
            request = Request(f"http://127.0.0.1:{server.server_port}/api/health", headers={"Host": "evil.example"})
            with self.assertRaises(HTTPError) as error:
                urlopen(request, timeout=3)
            self.assertEqual(error.exception.code, 400)
            error.exception.close()
            cross_origin = Request(f"http://127.0.0.1:{server.server_port}/api/health", headers={"Origin": "http://evil.example"})
            with self.assertRaises(HTTPError) as origin_error:
                urlopen(cross_origin, timeout=3)
            self.assertEqual(origin_error.exception.code, 403)
            origin_error.exception.close()
        finally:
            server.shutdown()
            thread.join(timeout=3)
            server.server_close()


if __name__ == "__main__":
    unittest.main()
