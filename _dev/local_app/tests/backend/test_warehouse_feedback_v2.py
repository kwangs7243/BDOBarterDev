import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from PIL import Image
from local_app.backend.app import create_app


class FeedbackV2Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Path(self.temp.name) / "db.sqlite3", testing=True)
        self.client = self.app.test_client()
        store = self.app.extensions["bdo_storage"]
        self.names = [n for n, tier in store.catalog.items() if tier <= 4][:6]
        self.slots = [{"slot": f"R1C{i+1}", "decision": "MATCH" if i < 5 else "ICON_MATCH_UNKNOWN",
                       "finalItem": self.names[i] if i < 5 else None, "bestCandidate": self.names[i],
                       "quantity": {"value": 10+i, "status": "QUANTITY_MATCH"}, "x": 0, "y": 0}
                      for i in range(6)]
        self.report = {"slots": self.slots, "grid": {"slotWidth": 10},
                       "patch": {"items": {self.names[i]: 10+i for i in range(5)}}}
        image = io.BytesIO(); Image.new("RGB", (10, 10)).save(image, format="PNG")
        self.scan_id = store.record_warehouse_scan(image.getvalue(), self.report, {})

    def tearDown(self):
        self.temp.cleanup()

    def body(self):
        rows = [{"slot": s["slot"], "name": s["bestCandidate"], "quantity": s["quantity"]["value"],
                 "excluded": False, "agreement": "both_match"} for s in self.slots]
        rows[4]["agreement"] = "unchecked"
        return self.make_body(rows)

    def make_body(self, rows):
        items = {}
        for row in rows:
            if not row["excluded"]:
                items[row["name"]] = items.get(row["name"], 0) + row["quantity"]
        return {"mutationId": "v2", "baseRevision": 0, "kind": "warehouse",
                "patch": {"type": "master_inventory_patch", "version": 1, "items": items},
                "feedback": {"version": 2, "scanId": self.scan_id, "rows": rows}}

    def test_all_four_checks_correct_success_and_unknown_rows_export_and_retry(self):
        rows = self.body()["feedback"]["rows"]
        rows[1].update(agreement="item_only", quantity=99)
        rows[2].update(agreement="quantity_only", name=self.names[0])
        rows[3].update(agreement="both_different", name=self.names[0], quantity=98)
        body = self.make_body(rows)
        response = self.client.patch("/api/inventory", json=body)
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertTrue(self.client.patch("/api/inventory", json=body).get_json()["idempotent"])
        response = self.client.get("/api/warehouse-dataset")
        with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
            samples = [json.loads(line) for line in archive.read("samples.jsonl").splitlines()]
            for index in [1,2,3,5]:
                label = samples[index]["humanFeedback"][0]
                self.assertTrue(label["verifiedItemLabel"])
                self.assertTrue(label["verifiedQuantityLabel"])
                self.assertEqual(label["user"], rows[index])
                self.assertEqual(samples[index]["modelOutput"], self.slots[index])
                self.assertEqual(len(samples[index]["humanFeedback"]), 1)
            self.assertEqual(samples[0]["humanFeedback"], [])
            self.assertEqual(samples[4]["humanFeedback"], [])
            self.assertEqual(json.loads(archive.read("manifest.json"))["formatVersion"], 2)
        response.close()
        actual = {r["programName"]: r["stock"] for r in self.client.get("/api/bootstrap").get_json()["inventory"]}
        for name, quantity in body["patch"]["items"].items():
            self.assertEqual(actual[name], quantity)

    def test_contradictory_missing_or_duplicate_rows_never_commit(self):
        before = self.client.get("/api/bootstrap").get_json()
        body = self.body(); body["feedback"]["rows"][0]["agreement"] = "both_different"
        self.assertEqual(self.client.patch("/api/inventory", json=body).status_code, 422)
        body = self.body(); body["feedback"]["rows"].pop()
        self.assertEqual(self.client.patch("/api/inventory", json=body).status_code, 422)
        body = self.body(); body["feedback"]["rows"][-1] = body["feedback"]["rows"][0]
        self.assertEqual(self.client.patch("/api/inventory", json=body).status_code, 422)
        self.assertEqual(self.client.get("/api/bootstrap").get_json(), before)
