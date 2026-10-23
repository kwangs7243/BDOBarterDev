from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from uuid import uuid4

from alchemy.catalog import AlchemyError
from alchemy.storage import AlchemyStorage, encode
from local_app.backend.app import create_app
from local_app.tests.backend.test_alchemy_engine import sample


class AlchemyStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bdo-alchemy-test-")
        self.path = Path(self.temp.name) / "alchemy.sqlite3"
        self.store = AlchemyStorage(self.path)
        self.catalog = sample()
        self.catalog["recipes"][1]["additional_output_ids"] = ["X"]
        with closing(self.store.connect()) as db:
            db.execute("INSERT INTO settings VALUES ('catalog',?)", (encode(self.catalog),))
            db.commit()
        self.change("inventory", changes=[{"item_id": i, "quantity": q} for i, q in {"F": 0, "A": 0, "X": 0, "B": 100}.items()])

    def tearDown(self):
        self.temp.cleanup()

    def change(self, action, **fields):
        return self.store.mutate(action, {"mutationId": str(uuid4()), "baseRevision": self.store.snapshot()["revision"], **fields})

    def test_t04_t05_t07_start_actual_outputs_and_duplicate_finish(self):
        job = self.change("start", recipe_id="a", calls=10)["job"]
        self.assertEqual(self.store.snapshot()["inventory"], {"F": 0, "A": 0, "X": 0, "B": 80})
        request = {"mutationId": str(uuid4()), "baseRevision": self.store.snapshot()["revision"], "job_id": job["job_id"], "outputs": {"A": 24, "X": 2}}
        result = self.store.mutate("finish", request)
        self.assertEqual(self.store.mutate("finish", request), result)
        self.assertEqual(self.store.snapshot()["inventory"], {"F": 0, "A": 24, "X": 2, "B": 80})
        with self.assertRaises(AlchemyError):
            self.change("finish", job_id=job["job_id"], outputs={"A": 24, "X": 2})
        self.assertEqual(self.store.snapshot()["inventory"]["A"], 24)

    def test_t06_t08_restart_partial_completion_and_cancel_refund(self):
        job = self.change("start", recipe_id="a", calls=10)["job"]
        self.store = AlchemyStorage(self.path)
        self.assertEqual(self.store.snapshot()["jobs"][0]["job_id"], job["job_id"])
        self.change("finish", job_id=job["job_id"], executed_calls=4, outputs={"A": 9, "X": 1})
        self.assertEqual(self.store.snapshot()["inventory"]["B"], 92)
        job = self.change("start", recipe_id="a", calls=2)["job"]
        self.change("cancel", job_id=job["job_id"])
        self.assertEqual(self.store.snapshot()["inventory"]["B"], 92)

    def test_correction_refuses_to_undo_outputs_consumed_by_later_work(self):
        job = self.change("start", recipe_id="a", calls=5)["job"]
        self.change("finish", job_id=job["job_id"], outputs={"A": 10})
        self.change("inventory", changes=[{"item_id": "A", "kind": "use", "quantity": 8}])
        before = self.store.export()
        with self.assertRaises(AlchemyError):
            self.change("correct", job_id=job["job_id"], outputs={"A": 1}, reason="실제 수량 재확인")
        self.assertEqual(self.store.export()["tables"], before["tables"])
        self.change("correct", job_id=job["job_id"], outputs={"A": 9}, reason="1개 과다 입력")
        self.assertEqual(self.store.snapshot()["inventory"]["A"], 1)

    def test_t09_t15_goals_reserve_once_and_editing_plans_never_changes_inventory(self):
        before = self.store.snapshot()["inventory"]
        first = self.change("goal", item_id="F", quantity=10, priority=0)["goal"]
        second = self.change("goal", item_id="F", quantity=10, priority=1)["goal"]
        plans = self.store.plans()
        self.assertEqual(sum(p["reservations"].get("B", 0) for p in plans), 100)
        with self.assertRaises(AlchemyError):
            self.change("start", recipe_id="a", calls=30, goal_id=second["goal_id"])
        self.change("goal", goal_id=first["goal_id"], delete=True)
        self.assertEqual(self.store.snapshot()["inventory"], before)

    def test_t16_validated_backup_and_atomic_pre_restore_backup(self):
        goal = self.change("goal", item_id="F", quantity=10)["goal"]
        self.change("start", recipe_id="a", calls=2, goal_id=goal["goal_id"])
        original = self.store.export()
        self.assertTrue(self.store.validate_backup(original)["valid"])
        self.change("inventory", changes=[{"item_id": "B", "quantity": 77}])
        replaced = self.store.export()
        result = self.change("restore", backup=original)
        restored = self.store.export()
        for table in ("inventory", "goals", "jobs", "ledger"):
            self.assertEqual(restored["tables"][table], original["tables"][table])
        self.assertEqual(self.store.export(result["previous_backup_id"])["tables"], replaced["tables"])
        invalid = deepcopy(original)
        invalid["tables"]["inventory"][0]["quantity"] = -1
        invalid["checksum"] = hashlib.sha256(encode({k:v for k,v in invalid.items() if k != "checksum"}).encode()).hexdigest()
        before = self.store.export()["tables"]
        with self.assertRaises(AlchemyError):
            self.change("restore", backup=invalid)
        self.assertEqual(self.store.export()["tables"], before)

    def test_t21_unknown_quantity_requires_explicit_confirmation(self):
        self.change("inventory", changes=[{"item_id": "B", "quantity": None}])
        with self.assertRaises(AlchemyError):
            self.change("start", recipe_id="a", calls=1)
        self.assertIsNone(self.store.snapshot()["inventory"]["B"])
        self.change("inventory", changes=[{"item_id": "B", "quantity": 10}, {"item_id": "A", "quantity": None}])
        job = self.change("start", recipe_id="a", calls=1)["job"]
        with self.assertRaises(AlchemyError):
            self.change("finish", job_id=job["job_id"], outputs={"A": 2})
        self.change("finish", job_id=job["job_id"], outputs={"A": 2}, baseline_counts={"A": 7})
        self.assertEqual(self.store.snapshot()["inventory"]["A"], 9)

    def test_t22_database_failure_rolls_back_inventory_jobs_and_receipt(self):
        before = self.store.export()["tables"]
        with closing(self.store.connect()) as db:
            db.execute("CREATE TRIGGER fail_ledger BEFORE INSERT ON ledger BEGIN SELECT RAISE(ABORT,'test failure'); END")
            db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            self.change("start", recipe_id="a", calls=2)
        self.assertEqual(self.store.export()["tables"], before)

    def test_concurrent_writes_and_reused_mutation_id(self):
        request = {"mutationId": str(uuid4()), "baseRevision": self.store.snapshot()["revision"], "recipe_id": "a", "calls": 30}
        def write():
            return self.store.mutate("start", request)
        with ThreadPoolExecutor(2) as executor:
            results = list(executor.map(lambda _: write(), range(2)))
        self.assertEqual(results[0], results[1])
        self.assertEqual(self.store.snapshot()["inventory"]["B"], 40)
        with self.assertRaises(AlchemyError):
            self.store.mutate("start", {**request, "calls": 1})

    def test_future_schema_refusal_does_not_create_tables(self):
        path = Path(self.temp.name) / "future.sqlite3"
        with closing(sqlite3.connect(path)) as db:
            db.execute("CREATE TABLE meta(id INTEGER PRIMARY KEY,schema_version INTEGER,revision INTEGER)")
            db.execute("INSERT INTO meta VALUES(1,99,10)")
            db.commit()
            before = list(db.iterdump())
        with self.assertRaises(AlchemyError):
            AlchemyStorage(path).snapshot()
        with closing(sqlite3.connect(path)) as db:
            self.assertEqual(list(db.iterdump()), before)

    def test_start_remembers_goal_recipe_and_in_progress_never_counts_as_inventory(self):
        g = self.change("goal", item_id="F", quantity=1)["goal"]
        self.change("start", recipe_id="a", calls=3, goal_id=g["goal_id"])
        snapshot = self.store.snapshot()
        self.assertEqual(snapshot["goals"][0]["choices"]["A"], "a")
        self.assertEqual(snapshot["inventory"]["A"], 0)
        plan = self.store.plans()[0]
        self.assertEqual(next(r for r in plan["rows"] if r["item_id"] == "A")["status"], "in_progress")


class AlchemyApiTests(unittest.TestCase):
    def test_t17_t18_t20_isolated_loading_direct_urls_and_origin(self):
        with tempfile.TemporaryDirectory(prefix="bdo-suite-isolation-") as temp:
            barter_path, alchemy_path = Path(temp)/"barter.sqlite3", Path(temp)/"alchemy.sqlite3"
            app = create_app(barter_path, alchemy_path=alchemy_path, testing=True)
            client = app.test_client()
            for path in ("/", "/suite-health", "/alchemy", "/alchemy/inventory", "/alchemy/history", "/alchemy/settings"):
                with client.get(path) as response:
                    self.assertEqual(response.status_code, 200)
            self.assertIsNone(app.extensions["bdo_storage"]._value)
            self.assertFalse(barter_path.exists())
            self.assertFalse(alchemy_path.exists())
            response = client.get("/api/alchemy/state")
            self.assertEqual(response.status_code, 200)
            self.assertFalse(barter_path.exists())
            self.assertTrue(alchemy_path.exists())
            self.assertEqual(client.post("/api/alchemy/mutations/start", json={}).status_code, 403)
            headers = {"Origin": "http://localhost:18765"}
            self.assertEqual(client.post("/api/alchemy/mutations/start", base_url="http://localhost:18765", json={}, headers=headers).status_code, 400)
            self.assertEqual(client.get("/api/bootstrap").status_code, 200)
            self.assertTrue(barter_path.exists())
