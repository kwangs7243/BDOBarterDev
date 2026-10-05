import io
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from uuid import uuid4
from PIL import Image
from werkzeug.datastructures import MultiDict
from local_app.backend.app import create_app
from local_app.backend.services.trade_batch_runtime import ENGINE_ID, MODEL_BUNDLE_SHA256, WORKER_VERSION
from .test_recognition_contracts import capture_metadata
from .test_trade_batch_runtime import ReadyRuntime, fake_worker


class LiveApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name)/"data.sqlite3"
        self.app = create_app(self.database, testing=True)
        self.app.extensions["trade_batch_runtime"] = ReadyRuntime(runner=fake_worker)
        self.client = self.app.test_client()
        self.headers = {"Origin": "http://localhost:18765", "Sec-Fetch-Site": "same-origin"}
        self.metadata = capture_metadata(width=80, height=50, task="trade")
        self.capture = {"captureId": self.metadata["captureId"], "metadata": self.metadata}
        output = io.BytesIO(); Image.new("RGB", (80,50)).save(output, format="PNG"); self.image = output.getvalue()

    def tearDown(self):
        self.temp.cleanup()

    def post(self, payload, *, field="batch", headers=None, image=None, copies=1):
        form = [(field, json.dumps(payload))] + [("image", (io.BytesIO(self.image if image is None else image), "capture.png", "image/png")) for _ in range(copies)]
        return self.client.post("/api/recognition/trade-live-list" if field=="batch" else "/api/recognition/trade-corrections",
                                data=MultiDict(form), headers=self.headers if headers is None else headers,
                                base_url="http://localhost:18765")

    def batch(self):
        return {"version":1, "batchId":str(uuid4()), "captures":[self.capture]}

    def feedback(self):
        result = self.post(self.batch()).get_json()["result"]
        row=result["rows"][0]; value=row["fields"]["island"]
        return {"version":1, "feedbackId":str(uuid4()), "captures":[self.capture],
                "engineId":ENGINE_ID, "modelVersion":MODEL_BUNDLE_SHA256, "workerVersion":WORKER_VERSION,
                "corrections":[{"captureId":row["captureId"], "ordinal":row["ordinal"], "rowBox":row["rowBox"],
                                "field":"island", "box":value["box"], "rawOCR":value["rawOCR"],
                                "confidence":value["confidence"], "automaticCorrected":value["corrected"], "finalValue":"새 섬"}]}

    def records(self, include_automatic=False):
        with closing(sqlite3.connect(self.database)) as db:
            rows = db.execute("SELECT * FROM trade_correction").fetchall()
            return rows if include_automatic else [row for row in rows if json.loads(row[5]).get("snapshot", {}).get("phase") != "recognized"]

    def test_live_recognition_preserves_all_source_rows_without_changing_working_state(self):
        before=self.client.get("/api/bootstrap").get_json()
        response=self.post(self.batch())
        self.assertEqual(response.status_code,200,response.get_json())
        self.assertEqual(response.get_json()["result"]["version"],3)
        self.assertEqual(self.records(),[])
        records = self.records(include_automatic=True)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0][4], self.image)
        self.assertEqual(json.loads(records[0][5])["snapshot"]["rows"], response.get_json()["result"]["rows"])
        self.assertEqual(self.client.get("/api/bootstrap").get_json(),before)
        self.assertEqual([p.name for p in Path(self.temp.name).rglob('*.sqlite3')],["data.sqlite3"])

    def test_correction_source_values_restart_and_retry_are_preserved(self):
        feedback=self.feedback()
        before=self.client.get("/api/bootstrap").get_json()
        self.assertTrue(self.post(feedback,field="feedback").get_json()["created"])
        self.assertFalse(self.post(feedback,field="feedback").get_json()["created"])
        rows=self.records();self.assertEqual(len(rows),1)
        self.assertEqual(rows[0][4],self.image)
        details=json.loads(rows[0][5]);self.assertEqual(details["corrections"],feedback["corrections"])
        self.assertEqual(details["modelVersion"],MODEL_BUNDLE_SHA256)
        self.assertEqual(self.client.get("/api/bootstrap").get_json(),before)
        create_app(self.database,testing=True)
        self.assertEqual(self.records(),rows)
        feedback["corrections"][0]["finalValue"]="다른 섬"
        self.assertEqual(self.post(feedback,field="feedback").status_code,409)
        self.assertEqual(self.records(),rows)

    def test_invalid_samples_are_rejected_without_writes(self):
        for change in ({"finalValue":"품목"},{"confidence":True},{"confidence":2},{"field":[]},
                       {"box":{"x":79,"y":0,"width":2,"height":1}}, {"captureId":[]}):
            feedback=self.feedback();feedback["corrections"][0].update(change)
            with self.subTest(change=change):
                self.assertEqual(self.post(feedback,field="feedback").status_code,422)
        self.assertEqual(self.records(),[])

    def test_image_frame_ids_parts_and_origin_are_checked(self):
        batch=self.batch()
        for headers in ({},{"Origin":"https://example.com"},{"Origin":"http://localhost","Sec-Fetch-Site":"cross-site"}):
            self.assertEqual(self.post(batch,headers=headers).status_code,403)
        self.assertEqual(self.post(batch,image=b'bad png').status_code,422)
        batch["captures"][0]["metadata"]["frame"]["width"]=81
        self.assertEqual(self.post(batch).status_code,422)
        batch["captures"][0]["metadata"]["frame"]["width"]=80
        batch["captures"]=batch["captures"]*2
        self.assertEqual(self.post(batch,copies=2).get_json()["error"]["code"],"duplicate_capture_id")

    def test_removed_routes_have_no_registration(self):
        rules={rule.rule for rule in self.app.url_map.iter_rules()}
        self.assertEqual({r for r in rules if r.startswith('/api/recognition/')},
                         {'/api/recognition/trade-runtime','/api/recognition/trade-live-list','/api/recognition/trade-corrections'})
        self.assertFalse(any(r.startswith('/api/master') for r in rules))

    def test_feedback_database_failure_records_no_success(self):
        feedback = self.feedback()
        with closing(sqlite3.connect(self.database)) as db:
            db.execute("CREATE TRIGGER fail_feedback BEFORE INSERT ON trade_correction BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
        self.assertEqual(self.post(feedback,field='feedback').status_code,503)
        self.assertEqual(self.records(),[])

    def test_full_review_keeps_unchanged_confirmation_exclusion_and_original_ocr(self):
        result = self.post(self.batch()).get_json()["result"]
        row = result["rows"][0]
        row["excluded"] = True
        row["fields"]["island"].update(automaticCorrected="품목", corrected="새 섬", reviewRequired=False, valueSource="USER_REVIEW")
        feedback = {"version": 2, "feedbackId": str(uuid4()), "captures": [self.capture], "engineId": ENGINE_ID,
                    "modelVersion": MODEL_BUNDLE_SHA256, "workerVersion": WORKER_VERSION, "corrections": [],
                    "snapshot": {"phase": "reviewed", "result": result}}
        before = self.client.get("/api/bootstrap").get_json()
        self.assertEqual(self.post(feedback, field="feedback").status_code, 200)
        self.assertFalse(self.post(feedback, field="feedback").get_json()["created"])
        details = json.loads(self.records()[0][5])
        self.assertEqual(details["snapshot"]["rows"], [row])
        self.assertEqual(self.client.get("/api/bootstrap").get_json(), before)
        feedback["feedbackId"] = str(uuid4())
        row["rowBox"]["width"] = 81
        self.assertEqual(self.post(feedback, field="feedback").status_code, 422)
        self.assertEqual(len(self.records()), 1)
