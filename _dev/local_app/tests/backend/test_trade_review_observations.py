import json
import hashlib
import io
import sqlite3
import tempfile
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from local_app.backend.app import create_app
from local_app.backend.recognition_contracts import RecognitionContractError, validate_trade_review_observation
from local_app.backend.recognition_store import MutationConflictError, RecognitionStore


def observation_payload(with_geometry=False):
    capture_id = str(uuid.uuid4())
    batch_id = str(uuid.uuid4())
    names = ("island", "fromItem", "reqAmount", "toItem", "count", "yield")
    values = {"island": "섬", "fromItem": "재료", "reqAmount": 10, "toItem": "교환품", "count": 0, "yield": 48}
    projected_fields = {}
    reviewed_fields = []
    crop_entries = []
    for name in names:
        projected = {"field": name, "shownValue": values[name], "status": "MATCHED", "candidate": None,
                     "rawEvidence": {"rawText": str(values[name])}, "correctionReason": [], "riskReasons": [], "masterVersion": "registry-v1:test"}
        if with_geometry and name == "reqAmount":
            projected["rawEvidence"]["readerEvidence"] = {"geometry": {"box": {"x": 1, "y": 1, "width": 4, "height": 4}}}
        projected_fields[name] = projected
        method = "USER_MARKED_UNKNOWN" if name == "reqAmount" else "USER_EDITED" if name == "island" else "USER_BATCH_CONFIRMED_UNCHANGED"
        final = None if method == "USER_MARKED_UNKNOWN" else "섬 수정" if method == "USER_EDITED" else values[name]
        reviewed_fields.append({"field": name, "shownValueBefore": values[name], "finalValue": final, "verificationMethod": method,
            "projectionStatus": projected["status"], "candidate": projected["candidate"], "rawEvidence": projected["rawEvidence"],
            "correctionReason": projected["correctionReason"], "riskReasons": projected["riskReasons"], "masterVersion": projected["masterVersion"]})
        selected = method != "USER_BATCH_CONFIRMED_UNCHANGED"
        geometry = {"source": "CAPTURE_BITMAP_PIXELS", "captureId": capture_id, "x": 1, "y": 1, "width": 4, "height": 4} if with_geometry and selected and name == "reqAmount" else None
        crop_entries.append({"projectionRowId": "row-1", "field": name, "selected": selected,
            "selectionReasons": (["USER_EDITED"] if method == "USER_EDITED" else ["USER_MARKED_UNKNOWN"]) if selected else [], "geometry": None, "readerCropHash": None,
            "skipReason": "GEOMETRY_UNAVAILABLE" if selected and geometry is None else "NOT_SELECTED" if not selected else None})
        crop_entries[-1]["geometry"] = geometry
    source_refs = [{"captureId": capture_id, "ordinal": 1}]
    row = {"projectionRowId": "row-1", "captureId": capture_id, "ordinal": 1, "sourceRefs": source_refs,
           "fields": reviewed_fields}
    projection_row = {"projectionRowId": "row-1", "captureId": capture_id, "ordinal": 1,
                      "sourceRefs": source_refs, "fields": projected_fields}
    if with_geometry:
        row["rowBox"] = {"x": 0, "y": 0, "width": 20, "height": 20}
        projection_row["rowBox"] = dict(row["rowBox"])
    capture_metadata = {"version": 1, "captureId": capture_id, "batchId": batch_id, "taskType": "trade", "sourceType": "file",
        "capturedAt": "2026-09-30T12:00:00Z", "frame": {"width": 100, "height": 80},
        "fidelity": {"sourceWidth": 100, "sourceHeight": 80, "rescaled": False, "evidence": "file-metadata"},
        "profileId": None, "profileVersion": 1, "context": {"baseRevision": 0, "sessionId": None, "sessionRevision": None},
        "observed": {"browserDpr": None, "windowsDpi": None, "gameResolution": None, "gameUiScale": None}}
    digest = "d" * 64
    registry = {"registryVersion": "registry-v1:test"}
    projection = {"projectionHash": "a" * 64, "masterVersion": "registry-v1:test", "correctionPolicyVersion": "policy-v1", "rows": [projection_row]}
    return {"schemaVersion": 1, "mutationId": str(uuid.uuid4()), "createdAt": "2026-09-30T12:00:00.000Z",
        "confirmationRevision": 1, "supersedesObservationId": None,
        "completion": {"schemaVersion": 1, "reviewMode": "REVIEW_FIRST", "recognitionBatchId": batch_id, "projectionHash": "a" * 64,
            "registryVersion": "registry-v1:test", "correctionVersion": "policy-v1", "reviewRevision": 0, "rows": [row], "edgeSegments": [],
            "summary": {"rowCount": 1, "fieldCount": 6, "unchangedFieldCount": 4, "editedFieldCount": 1, "unknownFieldCount": 1, "riskFieldCount": 0, "edgeSegmentCount": 0}},
        "sourceContext": {"version": 1, "authority": "CLIENT_ATTESTED", "registry": {"sourceRevision": "test", "sourceSha256": "c" * 64,
            "snapshotSha256": "b" * 64, "snapshot": registry, "hashBasis": "JS_REGISTRY_SORTED_JSON_V1"},
            "projection": {"snapshot": projection, "hashBasis": "JS_REGISTRY_SORTED_JSON_V1"},
            "recognition": {"resultVersion": 1, "runtime": {"engineId": "fake", "modelBundleSha256": None, "workerVersion": None},
                "boundaryPolicy": "edge-segments-evidence-only-v1", "captureEvidence": {"captures": [{"captureId": capture_id, "batchId": batch_id,
                "captureOrdinal": 1, "imageHash": digest, "imageDimensions": {"width": 100, "height": 80},
                "detectedCandidateCount": 1, "completeRowCount": 1, "edgeSegmentCount": 0}], "edgeSegments": []},
                "geometryProfile": {"revision": None, "sha256": None, "availability": "NOT_EXPOSED_BY_API"}},
            "captures": [{"captureId": capture_id, "metadata": capture_metadata, "bitmapSha256": digest, "sourceSha256": None,
                "bitmapBytes": 1234, "sourceBytes": 1234, "reencoded": False}], "gameVersion": None},
        "cropPlan": {"policy": "C2_REVIEW_VALUE_SUBSET_V1", "entries": crop_entries}}


class TradeReviewObservationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = self.root / "main.sqlite3"
        self.sidecar = self.root / "recognition.sqlite3"
        self.app = create_app(self.db, recognition_database_path=self.sidecar, testing=False)
        self.client = self.app.test_client()
        self.headers = {"Origin": "http://127.0.0.1:18765", "Sec-Fetch-Site": "same-origin"}

    def tearDown(self): self.temp.cleanup()

    def test_strict_truth_contract_rejects_bad_unknown_and_preserves_zero(self):
        payload = observation_payload()
        validate_trade_review_observation(payload)
        self.assertEqual(payload["completion"]["rows"][0]["fields"][4]["finalValue"], 0)
        browser_dpr = observation_payload()
        browser_dpr["sourceContext"]["captures"][0]["metadata"]["observed"]["browserDpr"] = 1.3
        validate_trade_review_observation(browser_dpr)
        non_finite = observation_payload()
        non_finite["sourceContext"]["captures"][0]["metadata"]["observed"]["browserDpr"] = float("nan")
        with self.assertRaises(RecognitionContractError): validate_trade_review_observation(non_finite)
        wrong = json.loads(json.dumps(payload)); wrong["completion"]["rows"][0]["fields"][2]["finalValue"] = 0
        with self.assertRaises(RecognitionContractError): validate_trade_review_observation(wrong)
        whitespace = json.loads(json.dumps(payload)); whitespace["completion"]["rows"][0]["fields"][0]["finalValue"] = "   "; whitespace["completion"]["summary"]["unknownFieldCount"] = 0; whitespace["completion"]["summary"]["unchangedFieldCount"] = 6
        with self.assertRaises(RecognitionContractError): validate_trade_review_observation(whitespace)

    def test_master_disagreement_is_retained_as_a_risky_review_field(self):
        payload = observation_payload()
        projected = payload["sourceContext"]["projection"]["snapshot"]["rows"][0]["fields"]["island"]
        reviewed = payload["completion"]["rows"][0]["fields"][0]
        projected["status"] = reviewed["projectionStatus"] = "MASTER_DISAGREEMENT"
        payload["completion"]["summary"]["riskFieldCount"] = 1
        payload["cropPlan"]["entries"][0]["selectionReasons"].append("RISKY_FIELD")
        validate_trade_review_observation(payload)

    def test_real_pillow_crop_validation_rejects_bad_hash_dimensions_metadata_and_oversize(self):
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo
        from local_app.backend.recognition_contracts import MAX_TRADE_CROP_BYTES, validate_trade_crop_metadata

        def make_png(*, text=False):
            output = io.BytesIO()
            options = {}
            if text:
                info = PngInfo(); info.add_text("note", "private metadata")
                options["pnginfo"] = info
            Image.new("RGBA", (4, 4), (10, 20, 30, 255)).save(output, format="PNG", **options)
            return output.getvalue()

        def metadata_for(data, *, width=4, height=4, sha=None):
            return {"version": 1, "cropMutationId": str(uuid.uuid4()), "projectionRowId": "row-1",
                    "field": "reqAmount", "sha256": sha or hashlib.sha256(data).hexdigest(), "width": width, "height": height}

        valid_png = make_png()
        validate_trade_crop_metadata(metadata_for(valid_png), valid_png)
        with self.assertRaises(RecognitionContractError):
            validate_trade_crop_metadata(metadata_for(b"not a png"), b"not a png")
        with self.assertRaises(RecognitionContractError):
            validate_trade_crop_metadata(metadata_for(valid_png, width=5), valid_png)
        with self.assertRaises(RecognitionContractError):
            validate_trade_crop_metadata(metadata_for(valid_png, sha="0" * 64), valid_png)
        text_png = make_png(text=True)
        with self.assertRaises(RecognitionContractError):
            validate_trade_crop_metadata(metadata_for(text_png), text_png)
        oversized = valid_png + b"x" * (MAX_TRADE_CROP_BYTES - len(valid_png) + 1)
        with self.assertRaises(RecognitionContractError) as raised:
            validate_trade_crop_metadata(metadata_for(oversized), oversized)
        self.assertEqual(raised.exception.status, 413)

    def test_concurrent_same_mutation_creates_one_observation(self):
        payload = validate_trade_review_observation(observation_payload())
        store = self.app.extensions["recognition_store"]
        barrier = threading.Barrier(2)

        def create():
            barrier.wait(timeout=5)
            return store.create_trade_review_observation(payload)

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(lambda _: create(), range(2)))
        ids = {receipt["observationId"] for receipt, _duplicate in outcomes}
        self.assertEqual(len(ids), 1)
        self.assertEqual(sorted(duplicate for _receipt, duplicate in outcomes), [False, True])
        with closing(sqlite3.connect(self.sidecar)) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM trade_review_observation").fetchone()[0], 1)

    def test_observation_retry_conflict_read_integrity_and_semantic_export(self):
        payload = validate_trade_review_observation(observation_payload())
        url = "/api/recognition/trade-review-observations"
        first = self.client.post(url, base_url="http://127.0.0.1:18765", data=json.dumps(payload, ensure_ascii=False), content_type="application/json", headers=self.headers)
        self.assertEqual(first.status_code, 201, first.get_json())
        receipt = first.get_json()["receipt"]
        retry = self.client.post(url, base_url="http://127.0.0.1:18765", data=json.dumps(payload, ensure_ascii=False), content_type="application/json", headers=self.headers)
        self.assertEqual(retry.status_code, 200)
        self.assertTrue(retry.get_json()["receipt"]["duplicate"])
        self.assertEqual(retry.get_json()["receipt"]["observationId"], receipt["observationId"])
        reordered = dict(reversed(list(payload.items())))
        canonical_replay = self.client.post(url, base_url="http://127.0.0.1:18765", data=json.dumps(reordered, ensure_ascii=False), content_type="application/json", headers=self.headers)
        self.assertEqual(canonical_replay.status_code, 200, "object key order does not change the canonical request hash")
        changed = json.loads(json.dumps(payload)); changed["createdAt"] = "2026-09-30T12:00:00.001Z"
        conflict = self.client.post(url, base_url="http://127.0.0.1:18765", data=json.dumps(changed), content_type="application/json", headers=self.headers)
        self.assertEqual(conflict.status_code, 409)
        read = self.client.get(f"{url}/{receipt['observationId']}", base_url="http://127.0.0.1:18765")
        self.assertEqual(read.status_code, 200)
        self.assertEqual(read.get_json()["observation"]["observationHash"], receipt["observationHash"])
        exported = self.client.get(f"{url}/{receipt['observationId']}/export", base_url="http://127.0.0.1:18765")
        self.assertEqual(exported.status_code, 200)
        self.assertEqual(exported.get_json()["semantic"]["manifest"]["evaluationBasis"], "NOT_EVALUATED_R006")
        self.assertEqual(exported.get_json()["semantic"]["dataset"]["fields"][2]["truthStatus"], "HUMAN_DECLARED_UNKNOWN")
        second_export = self.client.get(f"{url}/{receipt['observationId']}/export", base_url="http://127.0.0.1:18765").get_json()
        self.assertEqual(exported.get_json()["semanticHash"], second_export["semanticHash"])
        with closing(sqlite3.connect(self.sidecar)) as connection, connection:
            connection.execute("UPDATE trade_review_observation SET payload_json='{}' WHERE observation_id=?", (receipt["observationId"],))
        tampered = self.client.get(f"{url}/{receipt['observationId']}", base_url="http://127.0.0.1:18765")
        self.assertEqual(tampered.status_code, 500)
        self.assertEqual(tampered.get_json()["error"]["code"], "evidence_integrity_error")
        with closing(sqlite3.connect(self.db)) as connection:
            main_tables = connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='trade_review_observation'").fetchall()
        self.assertEqual(main_tables, [])

    def test_store_receipt_replay_after_restart_and_conflict(self):
        payload = validate_trade_review_observation(observation_payload())
        store = self.app.extensions["recognition_store"]
        first, duplicate = store.create_trade_review_observation(payload)
        self.assertFalse(duplicate)
        replay, duplicate = store.create_trade_review_observation(payload)
        self.assertTrue(duplicate)
        self.assertEqual(first["observationId"], replay["observationId"])
        changed = json.loads(json.dumps(payload)); changed["createdAt"] = "2026-09-30T12:00:00.001Z"
        with self.assertRaises(MutationConflictError): store.create_trade_review_observation(changed)

    def test_selected_unknown_crop_deduplicates_and_expires_with_tombstone(self):
        from PIL import Image
        from local_app.backend.recognition_store import sha256_bytes
        payload = validate_trade_review_observation(observation_payload(with_geometry=True))
        origin = "http://127.0.0.1:18765"
        saved = self.client.post("/api/recognition/trade-review-observations", base_url=origin, data=json.dumps(payload, ensure_ascii=False), content_type="application/json", headers=self.headers)
        self.assertEqual(saved.status_code, 201, saved.get_json())
        observation_id = saved.get_json()["receipt"]["observationId"]
        output = io.BytesIO(); Image.new("RGBA", (4, 4), (10, 20, 30, 255)).save(output, format="PNG"); png = output.getvalue()
        metadata = {"version": 1, "cropMutationId": str(uuid.uuid4()), "projectionRowId": "row-1", "field": "reqAmount",
                    "sha256": sha256_bytes(png), "width": 4, "height": 4}
        def post_crop():
            return self.client.post(f"/api/recognition/trade-review-observations/{observation_id}/crops", base_url=origin,
                headers=self.headers, data={"metadata": json.dumps(metadata), "image": (io.BytesIO(png), "crop.png", "image/png")})
        first = post_crop(); self.assertEqual(first.status_code, 201, first.get_json())
        duplicate = post_crop(); self.assertEqual(duplicate.status_code, 200, duplicate.get_json())
        self.assertTrue(duplicate.get_json()["receipt"]["duplicate"])
        changed_output = io.BytesIO(); Image.new("RGBA", (4, 4), (80, 90, 100, 255)).save(changed_output, format="PNG"); changed_png = changed_output.getvalue()
        conflict_metadata = {**metadata, "cropMutationId": str(uuid.uuid4()), "sha256": sha256_bytes(changed_png)}
        conflict = self.client.post(f"/api/recognition/trade-review-observations/{observation_id}/crops", base_url=origin,
            headers=self.headers, data={"metadata": json.dumps(conflict_metadata), "image": (io.BytesIO(changed_png), "crop.png", "image/png")})
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.get_json()["error"]["code"], "crop_link_conflict")
        evidence = self.client.get(f"/api/recognition/trade-review-observations/{observation_id}", base_url=origin).get_json()["cropEvidence"]
        self.assertEqual(next(item for item in evidence if item["field"] == "reqAmount")["availability"], "AVAILABLE")
        store = self.app.extensions["recognition_store"]
        removed = store.cleanup_unlabelled_artifacts(now=datetime(2026, 11, 15, tzinfo=timezone.utc), retention_days=30)
        self.assertGreaterEqual(removed, 1)
        evidence = store.get_trade_review_crop_evidence(observation_id)
        crop = next(item for item in evidence if item["field"] == "reqAmount")
        self.assertEqual(crop["availability"], "EXPIRED")
        self.assertEqual(crop["retentionClass"], "UNKNOWN_30_DAY")
        with closing(sqlite3.connect(self.sidecar)) as connection:
            self.assertEqual(connection.execute("SELECT state FROM trade_review_artifact WHERE observation_id=?", (observation_id,)).fetchone()[0], "EXPIRED")


if __name__ == "__main__": unittest.main()
