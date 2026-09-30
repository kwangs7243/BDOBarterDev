import copy
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


def reconciled_observation_payload(*, conflict_method="USER_EDITED", conflict_field="yield", conflict_values=(48, 148), overlap_mode="suffix"):
    """Deterministic R007-C1 synthetic: six source rows become four logical rows."""
    payload = observation_payload()
    capture_a, capture_b = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
    batch = payload["completion"]["recognitionBatchId"]
    projection = payload["sourceContext"]["projection"]["snapshot"]
    projection.update({"schemaVersion": 2, "reconciliation": None})
    source_rows, source_evidence, source_by_id = [], [], {}
    image_b = "d" * 64 if overlap_mode == "duplicate" else "e" * 64
    capture_values = [(capture_a, 1, "d" * 64), (capture_b, 2, image_b)]
    payload["sourceContext"]["captures"] = []
    for capture_id, ordinal, digest in capture_values:
        capture = copy.deepcopy(payload["sourceContext"]["captures"][0]) if payload["sourceContext"]["captures"] else copy.deepcopy(observation_payload()["sourceContext"]["captures"][0])
        capture["captureId"] = capture_id; capture["metadata"]["captureId"] = capture_id
        capture["metadata"]["batchId"] = batch; capture["bitmapSha256"] = digest
        payload["sourceContext"]["captures"].append(capture)
    payload["sourceContext"]["recognition"]["captureEvidence"]["captures"] = [
        {"captureId": cid, "batchId": batch, "captureOrdinal": ordinal, "imageHash": digest,
         "imageDimensions": {"width": 100, "height": 80}, "detectedCandidateCount": 3,
         "completeRowCount": 3, "edgeSegmentCount": 0}
        for cid, ordinal, digest in capture_values]

    # A=[A,B,C], B=[B,C,D], with only yield conflicting on C.
    raw_names = [("A", "A"), ("B", "B"), ("C", "C"), ("B", "B"), ("C", "C"), ("D", "D")]
    if overlap_mode == "duplicate": raw_names = [("A", "A"), ("B", "B"), ("C", "C"), ("A", "A"), ("B", "B"), ("C", "C")]
    if overlap_mode == "single_crop": raw_names[3] = ("C", "C")
    ids = []
    for index, (label, identity) in enumerate(raw_names):
        capture_id = capture_a if index < 3 else capture_b
        ordinal = index + 1 if index < 3 else index - 2
        sid = f"draft:{capture_id}:{ordinal}"; ids.append(sid)
        refs = [{"captureId": capture_id, "ordinal": ordinal, "draftRowId": sid}]
        row_box = {"x": 0, "y": (ordinal - 1) * 20, "width": 80, "height": 20}
        row_hash = f"{index + 1:064x}"
        if overlap_mode == "single_crop" and index == 3: row_hash = f"{3:064x}"
        nums = {"reqAmount": 1, "count": 0, "yield": 20}
        if overlap_mode != "duplicate":
            if index == 2: nums[conflict_field] = conflict_values[0]
            if index == 4: nums[conflict_field] = conflict_values[1]
            if overlap_mode == "single_crop" and index == 3: nums[conflict_field] = conflict_values[0]
        texts = {"island": "섬", "fromItem": f"재료-{identity}", "toItem": f"교환품-{identity}"}
        original_fields, projected_fields = {}, {}
        for field_name in ("island", "fromItem", "reqAmount", "toItem", "count", "yield"):
            numeric = field_name in nums
            raw_text = str(nums[field_name]) if numeric else texts[field_name]
            raw = {"value": None, "rawText": raw_text, "normalizedText": raw_text,
                   "rawNumericCandidate": nums[field_name] if numeric else None,
                   "status": "RAW_OCR_CANDIDATE", "reasonCodes": [],
                   "readerEvidence": {"readerId": "test-reader", "cropHash": f"{index + 10:064x}",
                                      "geometry": {"box": {"x": 0, "y": 1, "width": 8, "height": 8}}}}
            original_fields[field_name] = copy.deepcopy(raw)
            candidate = None if numeric else {"value": texts[field_name], "stableId": None,
                "legacyNameKey": "island-key" if field_name == "island" else f"{field_name}:{identity}",
                "kind": "ISLAND" if field_name == "island" else "ITEM", "tier": None,
                "authorityStatus": "LEGACY_UNVERIFIED", "canonicalName": None, "nameSource": "LEGACY_NAME"}
            projected_fields[field_name] = {"field": field_name, "labelKo": field_name,
                "rawEvidence": copy.deepcopy(raw), "candidate": candidate, "alternatives": [],
                "correctionReason": [], "masterVersion": "registry-v1:test", "masterRevision": "registry-v1:test",
                "riskReasons": [], "shownValue": nums[field_name] if numeric else texts[field_name],
                "reviewState": "SYSTEM_PREDICTION_UNREVIEWED", "editable": True, "status": "MATCHED", "normalizationSteps": []}
        original = {"captureId": capture_id, "ordinal": ordinal, "rowBox": row_box, "rowCropHash": row_hash,
                    "sourceRefs": refs, "fields": original_fields, "status": "DRAFT_UNVERIFIED", "automationDecision": "REVIEW"}
        source_projection = {"projectionRowId": sid, "sourceIndex": index, "rowStatus": "COMPLETE", "sourceRefs": refs,
            "captureId": capture_id, "ordinal": ordinal, "rowBox": row_box, "rowCropHash": row_hash,
            "originalRowEvidence": original, "fields": projected_fields, "reviewState": "SYSTEM_PREDICTION_UNREVIEWED"}
        source_by_id[sid] = source_projection
        source_rows.append({"sourceRowId": sid, "captureId": capture_id, "ordinal": ordinal,
            "projectionSourceIndex": index, "sourceRefs": refs, "rowBox": row_box, "rowCropHash": row_hash})
        if index in {1, 2, 3, 4}: source_evidence.append(copy.deepcopy(source_projection))

    if overlap_mode == "duplicate": group_members = [[ids[0], ids[3]], [ids[1], ids[4]], [ids[2], ids[5]]]
    elif overlap_mode == "single_crop": group_members = [[ids[0]], [ids[1]], [ids[2], ids[3]], [ids[4]], [ids[5]]]
    else: group_members = [[ids[0]], [ids[1], ids[3]], [ids[2], ids[4]], [ids[5]]]
    logical_rows, groups, source_map = [], [], []
    for members in group_members:
        rep_id = members[0]; rep = copy.deepcopy(source_by_id[rep_id]); group_id = f"reconcile-group:{source_by_id[rep_id]['sourceIndex']}"
        status = "UNMERGED" if len(members) == 1 else "EXACT_OVERLAP"
        if members == [ids[2], ids[4]] and overlap_mode == "suffix":
            status = "CONFLICT"
            field = rep["fields"][conflict_field]
            field.update({"shownValue": None, "candidate": None, "status": "AMBIGUOUS",
                "riskReasons": [{"code": "RECONCILIATION_CONFLICT", "messageKo": "겹침 출처의 값이 다릅니다.", "detail": {"sourceRowIds": members}}],
                "alternatives": [{"value": conflict_values[0], "identityKey": None, "sourceRowIds": [ids[2]], "sourceRefs": source_by_id[ids[2]]["sourceRefs"]},
                                 {"value": conflict_values[1], "identityKey": None, "sourceRowIds": [ids[4]], "sourceRefs": source_by_id[ids[4]]["sourceRefs"]}]})
        refs = []
        for sid in members:
            for ref in source_by_id[sid]["sourceRefs"]:
                if ref not in refs: refs.append(copy.deepcopy(ref))
        rep["sourceRefs"] = refs; rep.update({"reconciliationGroupId": group_id, "reconciliationStatus": status,
            "reconciliationMembers": [{"projectionRowId": sid, "captureId": source_by_id[sid]["captureId"],
                "ordinal": source_by_id[sid]["ordinal"], "sourceRefs": copy.deepcopy(source_by_id[sid]["sourceRefs"]),
                "rowBox": copy.deepcopy(source_by_id[sid]["rowBox"]), "rowCropHash": source_by_id[sid]["rowCropHash"]} for sid in members]})
        logical_rows.append(rep)
        overlap_refs = ["overlap:0:1"] if len(members) > 1 else []
        groups.append({"reconciliationGroupId": group_id, "status": status, "memberSourceRowIds": members,
            "representativeSourceRowId": rep_id, "logicalProjectionRowId": rep_id, "mergeEvidenceIds": overlap_refs})
        for sid in members: source_map.append({"sourceRowId": sid, "logicalProjectionRowId": rep_id})
    # Persist all member projections only for multi-source logical rows.
    merged_ids = {sid for group in group_members if len(group) > 1 for sid in group}
    source_evidence = [copy.deepcopy(source_by_id[item["sourceRowId"]]) for item in source_rows if item["sourceRowId"] in merged_ids]
    if overlap_mode == "duplicate":
        overlap_pairs = [{"leftSourceRowId": ids[index], "rightSourceRowId": ids[index + 3]} for index in range(3)]
        overlap_basis = "DUPLICATE_IMAGE"
    elif overlap_mode == "single_crop":
        overlap_pairs = [{"leftSourceRowId": ids[2], "rightSourceRowId": ids[3]}]
        overlap_basis = "ADJACENT_ROW_CROP_HASH"
    else:
        overlap_pairs = [{"leftSourceRowId": ids[1], "rightSourceRowId": ids[3]}, {"leftSourceRowId": ids[2], "rightSourceRowId": ids[4]}]
        overlap_basis = "ADJACENT_SUFFIX_PREFIX"
    reconciliation = {"schemaVersion": 1, "phase": "FINAL", "policyVersion": "trade-batch-reconciliation-v1",
        "captureOrder": [{"captureId": cid, "captureOrdinal": ordinal, "imageHash": digest} for cid, ordinal, digest in capture_values],
        "sourceRows": source_rows, "overlaps": [{"overlapId": "overlap:0:1", "basis": overlap_basis,
            "leftCaptureId": capture_a, "rightCaptureId": capture_b, "pairs": overlap_pairs}],
        "groups": groups, "sourceToLogical": source_map, "sourceProjectionEvidence": source_evidence, "findings": []}
    logical_for_source = {sid: members[0] for members in group_members for sid in members}
    reconciliation["sourceToLogical"] = [{"sourceRowId": item["sourceRowId"], "logicalProjectionRowId": logical_for_source[item["sourceRowId"]]} for item in source_rows]
    logical_rows.sort(key=lambda row: next(group["projectionSourceIndex"] for group in source_rows if group["sourceRowId"] == row["projectionRowId"]))
    projection.update({"schemaVersion": 2, "reconciliation": reconciliation, "rows": logical_rows})
    completion_rows, crop_entries = [], []
    for row in logical_rows:
        fields = []
        for field_name in ("island", "fromItem", "reqAmount", "toItem", "count", "yield"):
            projected = row["fields"][field_name]
            is_conflict = projected["status"] == "AMBIGUOUS"
            method = conflict_method if is_conflict else "USER_BATCH_CONFIRMED_UNCHANGED"
            final = conflict_values[1] if is_conflict and method == "USER_EDITED" else None if is_conflict else projected["shownValue"]
            fields.append({"field": field_name, "shownValueBefore": projected["shownValue"], "finalValue": final,
                "verificationMethod": method, "projectionStatus": projected["status"], "candidate": projected["candidate"],
                "rawEvidence": projected["rawEvidence"], "correctionReason": projected["correctionReason"],
                "riskReasons": projected["riskReasons"], "masterVersion": projected["masterVersion"]})
            risky = bool(projected["riskReasons"]) or projected["status"] in {"AMBIGUOUS", "UNMATCHED", "MASTER_DISAGREEMENT"}
            reasons = ([method] if method in {"USER_EDITED", "USER_MARKED_UNKNOWN"} else []) + (["RISKY_FIELD"] if risky else [])
            crop_entries.append({"projectionRowId": row["projectionRowId"], "field": field_name, "selected": bool(reasons),
                "selectionReasons": reasons, "geometry": {"source": "CAPTURE_BITMAP_PIXELS", "captureId": row["captureId"],
                    "x": row["rowBox"]["x"], "y": row["rowBox"]["y"] + 1, "width": 8, "height": 8},
                "readerCropHash": projected["rawEvidence"]["readerEvidence"]["cropHash"], "skipReason": None if reasons else "NOT_SELECTED"})
        completion_rows.append({"projectionRowId": row["projectionRowId"], "captureId": row["captureId"], "ordinal": row["ordinal"],
            "sourceRefs": copy.deepcopy(row["sourceRefs"]), "rowBox": copy.deepcopy(row["rowBox"]),
            "rowCropHash": row["rowCropHash"], "fields": fields})
    payload["completion"]["rows"] = completion_rows
    unchanged = edited = unknown = 0
    for row in completion_rows:
        for field in row["fields"]:
            if field["verificationMethod"] == "USER_EDITED": edited += 1
            elif field["verificationMethod"] == "USER_MARKED_UNKNOWN": unknown += 1
            else: unchanged += 1
    payload["completion"]["summary"] = {"rowCount": len(logical_rows), "fieldCount": len(logical_rows) * 6, "unchangedFieldCount": unchanged,
        "editedFieldCount": edited, "unknownFieldCount": unknown, "riskFieldCount": 1 if overlap_mode == "suffix" else 0, "edgeSegmentCount": 0}
    payload["cropPlan"]["entries"] = crop_entries
    return payload


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

    def test_reconciled_source_six_logical_four_validation(self):
        payload = reconciled_observation_payload()
        before = copy.deepcopy(payload)
        validate_trade_review_observation(payload)
        self.assertEqual(payload, before)
        recognition = payload["sourceContext"]["recognition"]["captureEvidence"]["captures"]
        self.assertEqual([item["completeRowCount"] for item in recognition], [3, 3])
        reconciliation = payload["sourceContext"]["projection"]["snapshot"]["reconciliation"]
        self.assertEqual(len(reconciliation["sourceRows"]), 6)
        self.assertEqual(len(payload["sourceContext"]["projection"]["snapshot"]["rows"]), 4)
        self.assertEqual(len(payload["completion"]["rows"]), 4)
        self.assertEqual(payload["completion"]["summary"]["fieldCount"], 24)

    def test_reconciled_count_spoof_rejected(self):
        mutations = [
            lambda p: p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["sourceRows"].pop(),
            lambda p: p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["sourceRows"].append(
                {**copy.deepcopy(p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["sourceRows"][0]),
                 "sourceRowId": "draft:11111111-1111-4111-8111-111111111111:4", "ordinal": 4, "projectionSourceIndex": 6}),
            lambda p: p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["sourceRows"][0].update(
                {"captureId": "22222222-2222-4222-8222-222222222222", "ordinal": 4}),
            lambda p: p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["sourceRows"][1].update(
                {"sourceRowId": p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["sourceRows"][0]["sourceRowId"]}),
            lambda p: p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["sourceRows"][1].update({"ordinal": 1}),
            lambda p: p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["sourceRows"][1].update({"projectionSourceIndex": 0}),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                payload = reconciled_observation_payload(); mutate(payload)
                with self.assertRaises(RecognitionContractError): validate_trade_review_observation(payload)

    def test_reconciled_partition_invalid_rejected(self):
        mutations = [
            lambda p: p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["sourceToLogical"].pop(),
            lambda p: p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["sourceToLogical"][1].update(
                p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["sourceToLogical"][0]),
            lambda p: p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["sourceToLogical"][0].update({"logicalProjectionRowId": "unknown"}),
            lambda p: p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["groups"][1].update({"representativeSourceRowId": "unknown"}),
            lambda p: p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["groups"][0].update({"memberSourceRowIds": []}),
            lambda p: p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["groups"][1].update({"logicalProjectionRowId": "draft:11111111-1111-4111-8111-111111111111:1"}),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                payload = reconciled_observation_payload(); mutate(payload)
                with self.assertRaises(RecognitionContractError): validate_trade_review_observation(payload)

    def test_reconciled_source_evidence_union_rejected(self):
        def missing_source(p): p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["sourceProjectionEvidence"].pop()
        def raw_mismatch(p): p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["sourceProjectionEvidence"][0]["sourceIndex"] = 99
        def member_refs(p): p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["sourceRows"][1]["sourceRefs"] = []
        def union_loss(p): p["sourceContext"]["projection"]["snapshot"]["rows"][1]["sourceRefs"].pop()
        def completion_mismatch(p): p["completion"]["rows"][1]["sourceRefs"].pop()
        for mutate in (missing_source, raw_mismatch, member_refs, union_loss, completion_mismatch):
            with self.subTest(mutation=mutate):
                payload = reconciled_observation_payload(); mutate(payload)
                with self.assertRaises(RecognitionContractError): validate_trade_review_observation(payload)
        valid = reconciled_observation_payload()
        rec = valid["sourceContext"]["projection"]["snapshot"]["reconciliation"]
        duplicate = copy.deepcopy(rec["sourceRows"][0]["sourceRefs"][0])
        rec["sourceRows"][0]["sourceRefs"].append(copy.deepcopy(duplicate))
        logical = valid["sourceContext"]["projection"]["snapshot"]["rows"][0]
        logical["originalRowEvidence"]["sourceRefs"].append(copy.deepcopy(duplicate))
        logical["reconciliationMembers"][0]["sourceRefs"].append(copy.deepcopy(duplicate))
        # Logical lineage is an exact ordered union: a repeated ref is retained once.
        validate_trade_review_observation(valid)
        merged = valid["sourceContext"]["projection"]["snapshot"]["rows"][1]
        self.assertEqual(len(merged["sourceRefs"]), 2)
        self.assertEqual([len(member["sourceRefs"]) for member in merged["reconciliationMembers"]], [1, 1])

    def test_reconciled_overlap_basis_contract(self):
        validate_trade_review_observation(reconciled_observation_payload())
        validate_trade_review_observation(reconciled_observation_payload(overlap_mode="single_crop"))
        validate_trade_review_observation(reconciled_observation_payload(overlap_mode="duplicate"))
        for mutation in (
            lambda p: p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["overlaps"][0]["pairs"].pop(),
            lambda p: p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["overlaps"][0].update({"leftCaptureId": "22222222-2222-4222-8222-222222222222"}),
            lambda p: p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["overlaps"][0].update({"basis": "DUPLICATE_IMAGE"}),
            lambda p: p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["sourceProjectionEvidence"][0]["fields"]["fromItem"]["candidate"].update({"legacyNameKey": "different"}),
        ):
            with self.subTest(mutation=mutation):
                payload = reconciled_observation_payload(); mutation(payload)
                with self.assertRaises(RecognitionContractError): validate_trade_review_observation(payload)

    def test_reconciled_conflict_truth_and_alternatives(self):
        for field, values in (("reqAmount", (1, 2)), ("count", (0, 1)), ("yield", (48, 148)), ("count", (None, 1))):
            with self.subTest(field=field, values=values):
                validate_trade_review_observation(reconciled_observation_payload(conflict_field=field, conflict_values=values))
        unknown = reconciled_observation_payload(conflict_method="USER_MARKED_UNKNOWN")
        validate_trade_review_observation(unknown)
        conflict = unknown["sourceContext"]["projection"]["snapshot"]["rows"][2]["fields"]["yield"]
        conflict["alternatives"].pop()
        with self.assertRaises(RecognitionContractError): validate_trade_review_observation(unknown)
        silent_choice = reconciled_observation_payload()
        chosen_row = silent_choice["sourceContext"]["projection"]["snapshot"]["rows"][2]
        chosen_row["fields"]["yield"]["shownValue"] = 48
        silent_choice["completion"]["rows"][2]["fields"][5]["shownValueBefore"] = 48
        with self.assertRaises(RecognitionContractError): validate_trade_review_observation(silent_choice)
        missing_lineage = reconciled_observation_payload()
        missing_lineage["sourceContext"]["projection"]["snapshot"]["rows"][2]["fields"]["yield"]["alternatives"][0]["sourceRefs"] = []
        with self.assertRaises(RecognitionContractError): validate_trade_review_observation(missing_lineage)
        duplicate_identity_disagreement = reconciled_observation_payload(overlap_mode="duplicate")
        duplicate_identity_disagreement["sourceContext"]["projection"]["snapshot"]["reconciliation"]["sourceProjectionEvidence"][3]["fields"]["island"]["candidate"]["legacyNameKey"] = "different-island"
        with self.assertRaises(RecognitionContractError): validate_trade_review_observation(duplicate_identity_disagreement)

    def test_reconciled_version_and_null_path_compatibility(self):
        validate_trade_review_observation(observation_payload())
        missing_tag = observation_payload(); missing_tag["sourceContext"]["projection"]["snapshot"].pop("schemaVersion", None)
        validate_trade_review_observation(missing_tag)
        invalid = []
        p = reconciled_observation_payload(); p["sourceContext"]["projection"]["snapshot"]["schemaVersion"] = 1; invalid.append(p)
        p = reconciled_observation_payload(); p["sourceContext"]["projection"]["snapshot"]["reconciliation"] = None; invalid.append(p)
        p = reconciled_observation_payload(); p["sourceContext"]["projection"]["snapshot"]["schemaVersion"] = True; invalid.append(p)
        p = reconciled_observation_payload(); p["sourceContext"]["projection"]["snapshot"]["schemaVersion"] = 3; invalid.append(p)
        p = reconciled_observation_payload(); p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["phase"] = "PRELIMINARY"; invalid.append(p)
        p = reconciled_observation_payload(); p["sourceContext"]["projection"]["snapshot"]["reconciliation"]["policyVersion"] = "future"; invalid.append(p)
        p = observation_payload(); p["sourceContext"]["projection"]["snapshot"]["rows"][0]["reconciliationGroupId"] = "reconciled"; invalid.append(p)
        for payload in invalid:
            with self.subTest(payload=payload):
                with self.assertRaises(RecognitionContractError): validate_trade_review_observation(payload)

    def test_reconciled_endpoint_roundtrip_retry_export(self):
        payload = reconciled_observation_payload()
        url, origin = "/api/recognition/trade-review-observations", "http://127.0.0.1:18765"
        post = lambda value: self.client.post(url, base_url=origin, data=json.dumps(value, ensure_ascii=False), content_type="application/json", headers=self.headers)
        first = post(payload); self.assertEqual(first.status_code, 201, first.get_json())
        receipt = first.get_json()["receipt"]
        replay = post(payload); self.assertEqual(replay.status_code, 200); self.assertTrue(replay.get_json()["receipt"]["duplicate"])
        changed = copy.deepcopy(payload); changed["sourceContext"]["projection"]["snapshot"]["reconciliation"]["findings"].append(
            {"code": "SOURCE_NOTE", "messageKo": "검수 참고", "sourceRowIds": [], "captureIds": []})
        self.assertEqual(post(changed).status_code, 409)
        read = self.client.get(f"{url}/{receipt['observationId']}", base_url=origin)
        self.assertEqual(read.status_code, 200)
        stored = read.get_json()["observation"]
        self.assertEqual(len(stored["sourceContext"]["projection"]["snapshot"]["reconciliation"]["sourceRows"]), 6)
        export = self.client.get(f"{url}/{receipt['observationId']}/export", base_url=origin)
        self.assertEqual(export.status_code, 200)
        self.assertEqual(export.get_json()["schemaVersion"], 1)
        self.assertIn("semantic", export.get_json())
        with closing(sqlite3.connect(self.sidecar)) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM trade_review_observation").fetchone()[0], 1)
        with closing(sqlite3.connect(self.db)) as connection:
            self.assertEqual(connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='trade_review_observation'").fetchall(), [])

    def test_reconciled_projection_and_payload_hash_mapping(self):
        first = validate_trade_review_observation(reconciled_observation_payload())
        changed = copy.deepcopy(first)
        rec = changed["sourceContext"]["projection"]["snapshot"]["reconciliation"]
        ref = {"captureId": "11111111-1111-4111-8111-111111111111", "ordinal": 1, "draftRowId": "draft:11111111-1111-4111-8111-111111111111:1", "lineage": "retained"}
        source = rec["sourceRows"][0]; source["sourceRefs"].append(ref)
        row = changed["sourceContext"]["projection"]["snapshot"]["rows"][0]
        row["sourceRefs"].append(ref); row["reconciliationMembers"][0]["sourceRefs"].append(ref)
        row["originalRowEvidence"]["sourceRefs"].append(ref)
        changed["completion"]["rows"][0]["sourceRefs"].append(ref)
        validate_trade_review_observation(changed)
        self.assertNotEqual(json.dumps(first, sort_keys=True), json.dumps(changed, sort_keys=True))
        first["mutationId"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        changed["mutationId"] = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        post = lambda value: self.client.post("/api/recognition/trade-review-observations", base_url="http://127.0.0.1:18765", data=json.dumps(value), content_type="application/json", headers=self.headers)
        first_response = post(first); self.assertEqual(first_response.status_code, 201)
        changed_response = post(changed); self.assertEqual(changed_response.status_code, 201)
        self.assertNotEqual(first_response.get_json()["receipt"]["payloadHash"], changed_response.get_json()["receipt"]["payloadHash"])
        changed["mutationId"] = first["mutationId"]
        response = post(changed)
        self.assertEqual(response.status_code, 409)

    def test_reconciled_representative_c2_crop(self):
        payload = reconciled_observation_payload()
        validate_trade_review_observation(payload)
        conflict_row = payload["sourceContext"]["projection"]["snapshot"]["rows"][2]
        crop = next(item for item in payload["cropPlan"]["entries"] if item["projectionRowId"] == conflict_row["projectionRowId"] and item["field"] == "yield")
        self.assertEqual(crop["geometry"]["captureId"], "11111111-1111-4111-8111-111111111111")
        self.assertEqual(crop["selected"], True)
        from PIL import Image
        output = io.BytesIO(); Image.new("RGBA", (8, 8), (1, 2, 3, 255)).save(output, format="PNG"); png = output.getvalue()
        url = "/api/recognition/trade-review-observations"
        saved = self.client.post(url, base_url="http://127.0.0.1:18765", data=json.dumps(payload, ensure_ascii=False), content_type="application/json", headers=self.headers)
        self.assertEqual(saved.status_code, 201, saved.get_json())
        observation_id = saved.get_json()["receipt"]["observationId"]
        metadata = {"version": 1, "cropMutationId": str(uuid.uuid4()), "projectionRowId": conflict_row["projectionRowId"],
            "field": "yield", "sha256": hashlib.sha256(png).hexdigest(), "width": 8, "height": 8}
        uploaded = self.client.post(f"{url}/{observation_id}/crops", base_url="http://127.0.0.1:18765", headers=self.headers,
            data={"metadata": json.dumps(metadata), "image": (io.BytesIO(png), "crop.png", "image/png")})
        self.assertEqual(uploaded.status_code, 201, uploaded.get_json())
        crop["geometry"]["captureId"] = "22222222-2222-4222-8222-222222222222"
        with self.assertRaises(RecognitionContractError): validate_trade_review_observation(payload)

    def test_legacy_stored_observation_integrity_unchanged(self):
        payload = validate_trade_review_observation(observation_payload())
        receipt, duplicate = self.app.extensions["recognition_store"].create_trade_review_observation(payload)
        self.assertFalse(duplicate)
        read = self.app.extensions["recognition_store"].get_trade_review_observation(receipt["observationId"])
        self.assertIsNone(read["sourceContext"]["projection"]["snapshot"].get("reconciliation"))
        self.assertEqual(read["completion"]["rows"], payload["completion"]["rows"])
        exported = self.app.extensions["recognition_store"].export_trade_review_observation(receipt["observationId"])
        self.assertEqual(exported["schemaVersion"], 1)


if __name__ == "__main__": unittest.main()
