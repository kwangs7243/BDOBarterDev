from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from local_app.backend.app import PORT, create_app
from local_app.backend.storage import load_catalog


class DurableStateUiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="bdo-spec002-")
        self.database = Path(self.temporary.name) / "isolated-spec002.sqlite3"
        self.local = f"http://127.0.0.1:{PORT}"
        self.app = create_app(self.database, testing=True)
        self.client = self.app.test_client()
        self.catalog, self.default_order = load_catalog()

    def tearDown(self):
        self.temporary.cleanup()

    def bootstrap(self):
        response = self.client.get("/api/bootstrap", base_url=self.local)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.get_json()

    def restart(self):
        self.client = None
        self.app = None
        self.app = create_app(self.database, testing=True)
        self.client = self.app.test_client()
        return self.bootstrap()

    def test_inventory_order_null_zero_and_targets_survive_restart(self):
        initial = self.bootstrap()
        self.assertEqual(len(initial["inventory"]), 70)
        self.assertEqual({tier: sum(row["tier"] == int(tier) for row in initial["inventory"]) for tier in "12345"}, {tier: 14 for tier in "12345"})
        self.assertTrue(all(row["stock"] is None for row in initial["inventory"]))
        item_a, item_b = initial["inventory"][0]["programName"], initial["inventory"][1]["programName"]
        saved = self.client.patch("/api/inventory", base_url=self.local, json={
            "mutationId": "spec002-inventory", "baseRevision": 0, "kind": "manual",
            "patch": {"items": {item_a: {"stock": 0, "target": 0}, item_b: {"stock": 48, "target": 123}}},
        })
        self.assertEqual(saved.status_code, 200, saved.get_data(as_text=True))
        order = self.bootstrap()["order"]
        order["1"] = list(reversed(order["1"]))[:-1]
        saved_order = json.loads(json.dumps(order, ensure_ascii=False))
        saved = self.client.put("/api/inventory/order", base_url=self.local, json={"mutationId": "spec002-order", "baseRevision": 1, "order": order})
        self.assertEqual(saved.status_code, 200, saved.get_data(as_text=True))

        restored = self.restart()
        by_name = {row["programName"]: row for row in restored["inventory"]}
        self.assertEqual(by_name[item_a]["stock"], 0)
        self.assertEqual(by_name[item_a]["target"], 0)
        self.assertEqual(by_name[item_b]["stock"], 48)
        self.assertEqual(by_name[item_b]["target"], 123)
        self.assertIsNone(next(row["stock"] for row in restored["inventory"] if row["stock"] is None))
        self.assertEqual(restored["order"]["1"], saved_order["1"])
        tier1_names = [row["programName"] for row in restored["inventory"] if row["tier"] == 1]
        self.assertEqual(tier1_names, saved_order["1"] + [name for name in self.default_order["1"] if name not in saved_order["1"]])

    def test_all_settings_groups_map_snapshots_and_viewer_survive_restart(self):
        snapshot = {
            "coords": {"테스트 섬": {"x": 12.5, "y": -4, "isOcean": True}},
            "routes": [{"id": "route-a", "startNodeName": "A", "endNodeName": "B", "customSeconds": 87}],
            "routeCalibrations": {"A>B": 1.125},
            "memos": [{"id": "memo-a", "startName": "A", "endName": "B", "timeStr": "1:27", "text": "검증 메모"}],
        }
        tuning = {
            "specialMatPriority": 81000, "crowCoinPriority": 31000, "pathEfficiencyBonus": 21000,
            "smallTradePenalty": 19000, "chainMaxDistance": 99, "chainBonusScore": 10001,
            "distancePenaltyWeight": 4, "overloadPenalty": 1.7, "efficiencyThreshold": 101,
            "iliyaPitstopRadius": 600, "overloadTimeWeight": 1.4, "deficitRatioBonus": 10002,
            "emergencyBonus": 10003, "preservationBonus": 10004, "westBias": 11,
            "useClustering": 20001, "tierPriority": {"T1": 1, "T2": 2001, "T3": 2901, "T4": 4501, "T5": 8001},
            "excludeSurplus": {"T1": False, "T2": True, "T3": False, "T4": True, "T5": False},
        }
        changed = {
            "tierRules": {"1": 21, "2": 22, "3": 23, "4": 24, "5": 3},
            "ship": {"normalWeight": 14380, "maxWeight": 24446, "speed": 171, "mode": "ocean"},
            "parley": {"defaultBudget": 1500001, "normalCost": 10974, "crowCost": 15963},
            "shipPresets": {
                "1": {"mode": "inner", "nW": 14379, "mW": 24445, "speed": 170},
                "2": {"mode": "ocean", "nW": 14000, "mW": 24000, "speed": 160},
                "3": None, "4": {"mode": "none", "nW": 1, "mW": 2, "speed": 3},
            },
            "tuning": tuning,
            "navigation": {"coords": snapshot["coords"], "routeCalibrations": snapshot["routeCalibrations"], "memos": snapshot["memos"]},
            "mapSlots": {"1": snapshot, "2": None, "3": None},
            "mapBase": {"coords": {"기본 지도": {"x": 1, "y": 2}}, "routes": [], "routeCalibrations": {}, "memos": []},
            "viewer": {"uiZoom": 125, "panels": {"mainPanel": {"left": 17, "top": 23, "width": 640, "height": 420}, "routeCalibrationPanel": {"left": 9, "top": 11, "width": 400, "height": 300}}},
        }
        saved = self.client.patch("/api/settings", base_url=self.local, json={"mutationId": "spec002-settings", "baseRevision": 0, "settings": changed})
        self.assertEqual(saved.status_code, 200, saved.get_data(as_text=True))

        # Merely starting the app must keep active navigation; saved snapshots are not auto-applied.
        restored = self.restart()
        settings = restored["settings"]
        for section, value in changed.items():
            self.assertEqual(settings[section], value, section)
        self.assertNotEqual(settings["navigation"]["coords"], settings["mapBase"]["coords"])
        self.assertEqual(settings["tuning"]["useClustering"], 20001)

        # Explicit user load is one navigation-section mutation and survives another restart.
        loaded = self.client.patch("/api/settings", base_url=self.local, json={
            "mutationId": "spec002-explicit-load", "baseRevision": restored["revision"],
            "settings": {"navigation": {"coords": snapshot["coords"], "routeCalibrations": snapshot["routeCalibrations"], "memos": snapshot["memos"]}},
        })
        self.assertEqual(loaded.status_code, 200, loaded.get_data(as_text=True))
        restored_again = self.restart()
        self.assertEqual(restored_again["settings"]["navigation"]["coords"], snapshot["coords"])
        self.assertEqual(restored_again["settings"]["navigation"]["routeCalibrations"], snapshot["routeCalibrations"])
        self.assertEqual(restored_again["settings"]["navigation"]["memos"], snapshot["memos"])

    def test_invalid_order_and_stale_revision_do_not_change_persisted_state(self):
        initial = self.bootstrap()
        invalid = {key: list(value) for key, value in initial["order"].items()}
        invalid["1"][0] = invalid["1"][1]
        duplicate = self.client.put("/api/inventory/order", base_url=self.local, json={"mutationId": "spec002-duplicate", "baseRevision": 0, "order": invalid})
        self.assertEqual(duplicate.status_code, 422)
        wrong_tier = {key: list(value) for key, value in initial["order"].items()}
        wrong_tier["1"][0] = wrong_tier["2"][0]
        wrong = self.client.put("/api/inventory/order", base_url=self.local, json={"mutationId": "spec002-wrong-tier", "baseRevision": 0, "order": wrong_tier})
        self.assertEqual(wrong.status_code, 422)
        stale = self.client.patch("/api/settings", base_url=self.local, json={"mutationId": "spec002-stale", "baseRevision": 99, "settings": {"viewer": {"uiZoom": 140}}})
        self.assertEqual(stale.status_code, 409)
        after = self.bootstrap()
        self.assertEqual(after["revision"], 0)
        self.assertEqual(after["settings"]["viewer"]["uiZoom"], 100)

    def test_session_storage_is_separate_from_durable_settings_and_temporary_ui(self):
        snapshot = self.bootstrap()
        self.assertNotIn("scannedTrades", json.dumps(snapshot))
        self.assertNotIn("schedule", snapshot)
        self.assertNotIn("remainingParley", snapshot)
        with closing(sqlite3.connect(self.database)) as connection:
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertEqual(tables, {"inventory", "settings", "app_meta", "working_session", "saved_schedule_slot", "mutation_receipt", "warehouse_scan", "warehouse_feedback"})
        rules = {rule.rule for rule in self.app.url_map.iter_rules() if rule.rule.startswith("/api/")}
        self.assertEqual(rules, {"/api/health", "/api/bootstrap", "/api/inventory", "/api/inventory/order", "/api/settings", "/api/warehouse-scan", "/api/warehouse-dataset", "/api/app/shutdown", "/api/working-session", "/api/working-session/completion", "/api/schedule-slots/<int:slot>", "/api/recognition/config", "/api/recognition/warehouse", "/api/recognition/trade", "/api/recognition/trade-runtime", "/api/recognition/trade-batch", "/api/recognition/<recognition_id>", "/api/recognition/<recognition_id>/feedback", "/api/recognition/<recognition_id>/apply", "/api/recognition/native-capture", "/api/recognition/remote-fallback", "/api/recognition/trade-review-observations", "/api/recognition/trade-review-observations/<observation_id>", "/api/recognition/trade-review-observations/<observation_id>/export", "/api/recognition/trade-review-observations/<observation_id>/crops", "/api/recognition/trade-review-observations/<observation_id>/export/crops/<digest>", "/api/recognition/trade-review-observations/<observation_id>/truth-labels", "/api/master/active", "/api/master/bundles/<registry_version>", "/api/master/bundles/<path:registry_version>/export", "/api/master/proposal", "/api/master/publish"})
        frontend = Path(__file__).resolve().parents[2] / "frontend"
        js = "\n".join(path.read_text(encoding="utf-8") for path in frontend.rglob("*.js"))
        self.assertNotIn("localStorage", js)
        self.assertIn("warehouse-scan", js)


if __name__ == "__main__":
    unittest.main()
