from contextlib import closing
import io
import json
import hashlib
import sqlite3
import tempfile
import unittest
import zipfile
from unittest.mock import patch
from local_app.backend.services import warehouse_scan
from pathlib import Path
from local_app.backend.app import create_app

ROOT = Path(__file__).resolve().parents[4]

class WarehouseEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name) / "data.sqlite3"
        self.app = create_app(self.database, testing=True)
        self.client = self.app.test_client()
        self.image = (ROOT / "_dev" / "local_app" / "tests" / "fixtures" / "warehouse_patch" / "barter_only.png").read_bytes()
        # Persistence tests need stable review cases regardless of improvements to OCR.
        real_convert = warehouse_scan.convert
        def review_cases(*args, **kwargs):
            result, report = real_convert(*args, **kwargs)
            for slot in report["slots"]:
                if slot["slot"] in {"R5C8", "R6C4"}:
                    slot["decision"] = "ICON_MATCH_UNKNOWN"
                    slot["finalItem"] = None
            items = {}
            for slot in report["slots"]:
                name = slot.get("finalItem")
                if slot["decision"] == "MATCH" and name in result["items"]:
                    items[name] = items.get(name, 0) + slot["quantity"]["value"]
            result["items"] = items
            report["patch"]["items"] = items
            return result, report
        with patch.object(warehouse_scan, "convert", side_effect=review_cases):
            response = self.client.post("/api/warehouse-scan", data={"image": (io.BytesIO(self.image), "master.png")})
        self.assertEqual(response.status_code, 200)
        self.result = response.get_json()
        self.report = self.result["report"]
        self.rows = [{"slot": slot["slot"], "name": None, "quantity": None, "excluded": True, "itemCheck": "unchecked"}
                     for slot in self.report["slots"] if slot["decision"] not in {"MATCH", "EMPTY", "TIER5_IGNORE"}]
        self.items = dict(self.result["patch"]["items"])
        self.assertGreater(len(self.rows), 0)
    def tearDown(self):
        self.temp.cleanup()
    def body(self, mid="apply", revision=0):
        return {"mutationId": mid, "baseRevision": revision, "kind": "warehouse", "patch": {"type": "master_inventory_patch", "version": 1, "items": self.items}, "feedback": {"scanId": self.report["scanId"], "rows": self.rows}}
    def labels(self):
        with closing(sqlite3.connect(self.database)) as connection, connection:
            return connection.execute("SELECT count(*) FROM warehouse_feedback").fetchone()[0]
    def test_original_input_output_provenance_without_stock_mutation(self):
        self.assertEqual(self.client.get("/api/bootstrap").get_json()["revision"], 0)
        with closing(sqlite3.connect(self.database)) as c, c:
            image, report, provenance = c.execute("SELECT image_png, report_json, provenance_json FROM warehouse_scan").fetchone()
        self.assertEqual(image, self.image)
        self.assertEqual(json.loads(report)["input"]["sha256"], hashlib.sha256(self.image).hexdigest())
        self.assertNotIn("path", json.loads(report)["input"])
        self.assertEqual(len(json.loads(provenance)["sourceHashes"]), 73)
        self.assertEqual(self.labels(), 0)
    def test_seed_guess_confirmation_and_correction_are_separate_from_original(self):
        slot = next(slot for slot in self.report["slots"] if slot["slot"] == "R5C8")
        row = next(row for row in self.rows if row["slot"] == slot["slot"])
        row.update(name=slot["bestCandidate"], quantity=23, excluded=False, itemCheck="match")
        self.items[row["name"]] = self.items.get(row["name"], 0) + 23
        other = next(value for value in self.rows if value["slot"] != slot["slot"])
        guess = next(value.get("bestCandidate") for value in self.report["slots"] if value["slot"] == other["slot"])
        name = next(name for name in self.items if name != guess)
        other.update(name=name, quantity=0, excluded=False, itemCheck="different")
        self.items.setdefault(name, 0)
        response = self.client.patch("/api/inventory", json=self.body())
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.get_json()["revision"], 1)
        self.assertEqual(self.labels(), 1)
        exported = self.client.get("/api/warehouse-dataset")
        with zipfile.ZipFile(io.BytesIO(exported.data)) as archive:
            samples = [json.loads(line) for line in archive.read("samples.jsonl").splitlines()]
            sample = next(value for value in samples if value["modelOutput"]["slot"] == "R5C8")
            self.assertEqual(sample["modelOutput"], slot)
            self.assertTrue(sample["humanFeedback"][0]["verifiedItemLabel"])
            self.assertEqual(archive.read(f"scans/{self.report['scanId']}/input.png"), self.image)
            self.assertIn(sample["crop"], archive.namelist())
            auto = next(value for value in samples if value["modelOutput"]["decision"] == "MATCH")
            self.assertEqual(auto["humanFeedback"], [])
        exported.close()
    def test_retry_after_later_mutation_does_not_duplicate_feedback(self):
        body = self.body()
        self.assertEqual(self.client.patch("/api/inventory", json=body).status_code, 200)
        name = next(iter(self.items))
        self.client.patch("/api/inventory", json={"mutationId": "manual", "baseRevision": 1, "kind": "manual", "patch": {"items": {name: {"stock": 999}}}})
        response = self.client.patch("/api/inventory", json=body)
        self.assertTrue(response.get_json()["idempotent"])
        self.assertEqual(self.labels(), 1)
        stock = next(row["stock"] for row in self.client.get("/api/bootstrap").get_json()["inventory"] if row["programName"] == name)
        self.assertEqual(stock, 999)
    def test_database_failure_rolls_back_stock_and_feedback(self):
        with closing(sqlite3.connect(self.database)) as c, c:
            c.execute("CREATE TRIGGER fail_stock BEFORE UPDATE ON inventory BEGIN SELECT RAISE(ABORT,'test failure'); END")
        before = self.client.get("/api/bootstrap").get_json()
        self.assertEqual(self.client.patch("/api/inventory", json=self.body()).status_code, 503)
        self.assertEqual(self.client.get("/api/bootstrap").get_json(), before)
        self.assertEqual(self.labels(), 0)
    def test_bad_feedback_and_patch_disagreement_are_atomic(self):
        before = self.client.get("/api/bootstrap").get_json()
        self.items[next(iter(self.items))] += 1
        self.assertEqual(self.client.patch("/api/inventory", json=self.body()).status_code, 422)
        self.assertEqual(self.client.get("/api/bootstrap").get_json(), before)
        self.assertEqual(self.labels(), 0)
        self.rows[0]["itemCheck"] = []
        self.assertEqual(self.client.patch("/api/inventory", json=self.body()).status_code, 422)
    def test_stale_review_does_not_save_labels(self):
        self.assertEqual(self.client.patch("/api/inventory", json=self.body(revision=99)).status_code, 409)
        self.assertEqual(self.labels(), 0)
    def test_schema_two_upgrade_preserves_inventory_and_is_repeatable(self):
        name = next(iter(self.items))
        self.client.patch("/api/inventory", json={"mutationId": "before", "baseRevision": 0, "kind": "manual", "patch": {"items": {name: {"stock": 0, "target": 91}}}})
        with closing(sqlite3.connect(self.database)) as c, c:
            c.execute("DROP TABLE warehouse_feedback")
            c.execute("DROP TABLE warehouse_scan")
            c.execute("UPDATE app_meta SET schema_version=2")
        create_app(self.database, testing=True)
        upgraded = create_app(self.database, testing=True).test_client().get("/api/bootstrap").get_json()
        self.assertEqual(upgraded["schemaVersion"], 3)
        self.assertEqual(upgraded["revision"], 1)
        row = next(row for row in upgraded["inventory"] if row["programName"] == name)
        self.assertEqual((row["stock"], row["target"]), (0, 91))
