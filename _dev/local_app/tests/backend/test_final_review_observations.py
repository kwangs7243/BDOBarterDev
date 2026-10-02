import copy
import hashlib
import io
import json
import re
import tempfile
import unittest
from unittest.mock import patch
from contextlib import closing
from pathlib import Path

from local_app.backend.recognition_contracts import (RecognitionContractError, validate_final_review_observation,
    validate_trade_crop_metadata_v3, validate_crop_truth_label_request)
from local_app.backend.recognition_store import EvidenceIntegrityError, RecognitionStore
from local_app.backend.app import create_app


def example_request():
    contract = Path(__file__).resolve().parents[3] / "specs" / "008-capture-recognition-v2" / "EVIDENCE-V3-CONTRACT.md"
    text = contract.read_text(encoding="utf-8")
    for match in re.finditer(r"```json\s*(.*?)```", text, re.DOTALL):
        try:
            value = json.loads(match.group(1))
        except json.JSONDecodeError:
            continue
        if value.get("schemaVersion") == 3 and "projection" in value:
            return {key: item for key, item in value.items() if key not in {"observationId", "persistedAt", "hashBasis", "payloadHash", "observationHash"}}
    raise AssertionError("EVIDENCE-V3-CONTRACT example is missing")


def _hash(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":"),allow_nan=False).encode("utf-8")).hexdigest()


def truth_ready_request():
    from PIL import Image
    request=example_request()
    output=io.BytesIO();Image.new("RGB",(10,10),(21,42,63)).save(output,format="PNG");png=output.getvalue()
    pixel=hashlib.sha256(bytes([21,42,63])*100).hexdigest();png_hash=hashlib.sha256(png).hexdigest()
    source=request["sourceContext"]["rawEvidence"]["snapshot"]["sourceRows"][0]
    crop=source["fields"][0]["cropRefs"][0]
    crop["pixelSha256"]=pixel;crop["pngArtifactSha256"]=png_hash
    raw_hash=_hash(request["sourceContext"]["rawEvidence"]["snapshot"])
    request["sourceContext"]["rawEvidence"]["rawEvidenceHash"]=raw_hash
    request["projection"]["rawEvidenceHash"]=raw_hash
    projection={k:v for k,v in request["projection"].items() if k!="projectionHash"}
    projection_hash=_hash(projection)
    request["projection"]["projectionHash"]=projection_hash
    request["completion"]["projectionHash"]=projection_hash
    request["completion"]["batchConfirmation"]["projectionHash"]=projection_hash
    completion={k:v for k,v in request["completion"].items() if k!="batchConfirmation"}
    request["completion"]["batchConfirmation"]["completionValuesHash"]=_hash(completion)
    validate_final_review_observation(request)
    return request,png


class FinalReviewObservationTests(unittest.TestCase):
    def test_contract_example_is_valid_and_keeps_operational_decisions_separate(self):
        request = example_request()
        self.assertIs(validate_final_review_observation(request), request)
        decisions = [field["operationalDecision"] for row in request["completion"]["rows"] for field in row["fields"]]
        self.assertTrue(decisions)
        self.assertTrue(set(decisions) <= {"CANDIDATE_RETAINED", "USER_EDITED", "USER_MARKED_UNKNOWN"})
        self.assertNotIn("truthEvidence", request["completion"]["rows"][0]["fields"][0])

    def test_duplicate_source_assignment_is_rejected(self):
        request = example_request()
        members = request["projection"]["reconciliation"]["groups"][0]["memberSourceRowIds"]
        members.append(members[0])
        with self.assertRaises(RecognitionContractError):
            validate_final_review_observation(request)

    def test_unknown_cannot_carry_a_final_value(self):
        request = example_request()
        request["completion"]["rows"][0]["fields"][0]["operationalDecision"] = "USER_MARKED_UNKNOWN"
        with self.assertRaises(RecognitionContractError):
            validate_final_review_observation(request)

    def test_store_roundtrip_export_and_idempotent_replay(self):
        request = example_request()
        validate_final_review_observation(request)
        with tempfile.TemporaryDirectory() as directory:
            store = RecognitionStore(Path(directory) / "recognition.sqlite3")
            store.initialize()
            first, duplicate = store.create_final_review_observation(request)
            self.assertFalse(duplicate)
            replay, duplicate = store.create_final_review_observation(request)
            self.assertTrue(duplicate)
            self.assertEqual(first["observationId"], replay["observationId"])
            saved = store.get_trade_review_observation(first["observationId"])
            self.assertEqual(saved["schemaVersion"], 3)
            exported = store.export_trade_review_observation(first["observationId"])
            self.assertEqual(exported["schemaVersion"], 3)
            self.assertFalse(any(field["knownTruthEligible"] for row in exported["semantic"]["dataset"]["rows"] for field in row["fields"]))

    def test_api_dispatches_v3_and_schema_version_query_uses_stored_version(self):
        request=example_request()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            app=create_app(root/"main.sqlite3",recognition_database_path=root/"sidecar"/"recognition.sqlite3",testing=True)
            client=app.test_client(); url="/api/recognition/trade-review-observations"
            headers={"Origin":"http://127.0.0.1:18765","Sec-Fetch-Site":"same-origin"}
            response=client.post(url,base_url="http://127.0.0.1:18765",data=json.dumps(request,ensure_ascii=False),content_type="application/json",headers=headers)
            self.assertEqual(response.status_code,201,response.get_json())
            observation_id=response.get_json()["receipt"]["observationId"]
            self.assertEqual(client.get(f"{url}/{observation_id}?schemaVersion=1").status_code,404)
            fetched=client.get(f"{url}/{observation_id}?schemaVersion=3")
            self.assertEqual(fetched.status_code,200)
            self.assertEqual(fetched.get_json()["observation"]["reviewMode"],"FINAL_CORRECTED_RESULT")
            exported=client.get(f"{url}/{observation_id}/export?schemaVersion=3")
            self.assertEqual(exported.status_code,200)
            self.assertEqual(exported.get_json()["exportType"],"TRADE_FINAL_REVIEW_OBSERVATION")

    def test_explicit_truth_route_saves_crop_bound_label_and_only_then_exports_eligible_truth(self):
        from PIL import Image
        request,png=truth_ready_request()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);sidecar=root/"sidecar"/"recognition.sqlite3"
            app=create_app(root/"main.sqlite3",recognition_database_path=sidecar,testing=True)
            store=app.extensions["recognition_store"];client=app.test_client();origin="http://127.0.0.1:18765"
            headers={"Origin":origin,"Sec-Fetch-Site":"same-origin"};url="/api/recognition/trade-review-observations"
            posted=client.post(url,base_url=origin,data=json.dumps(request,ensure_ascii=False),content_type="application/json",headers=headers)
            self.assertEqual(posted.status_code,201,posted.get_json());observation_id=posted.get_json()["receipt"]["observationId"]
            crop_hash=request["sourceContext"]["rawEvidence"]["snapshot"]["sourceRows"][0]["fields"][0]["cropRefs"][0]["pngArtifactSha256"]
            source=request["sourceContext"]["rawEvidence"]["snapshot"]["sourceRows"][0]
            crop=source["fields"][0]["cropRefs"][0]
            crop_metadata={"schemaVersion":3,"cropMutationId":"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                "projectionRowId":request["completion"]["rows"][0]["projectionRowId"],"field":"island","cropRefId":crop["cropRefId"],
                "sha256":crop_hash,"pixelSha256":crop["pixelSha256"],"width":10,"height":10}
            crop_response=client.post(f"{url}/{observation_id}/crops",base_url=origin,
                data={"metadata":json.dumps(crop_metadata),"image":(io.BytesIO(png),"crop.png","image/png")},headers=headers)
            self.assertEqual(crop_response.status_code,201,crop_response.get_json())
            label={"schemaVersion":1,"mutationId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","sourceRowId":source["sourceRowId"],
                "field":"island","cropRefId":crop["cropRefId"],"labelRevision":1,"supersedesLabelId":None,"labelStatus":"KNOWN",
                "value":"예제 섬","provenance":{"method":"HUMAN_CROP_VERIFIED","labelerRole":"PRODUCT_OWNER","sourceFamilyId":"family-live-1",
                "cohort":"INDEPENDENT","splitManifestHash":"2"*64,"sourceOrigin":"FRESH_CAPTURE","independentOfOperationalReview":True,"note":None},
                "createdAt":"2026-10-02T00:03:00Z"}
            truth_url=f"{url}/{observation_id}/truth-labels"
            saved=client.post(truth_url,base_url=origin,data={"metadata":json.dumps(label,ensure_ascii=False)},content_type="multipart/form-data",headers=headers)
            self.assertEqual(saved.status_code,201,saved.get_json())
            replay=client.post(truth_url,base_url=origin,data={"metadata":json.dumps(label,ensure_ascii=False)},content_type="multipart/form-data",headers=headers)
            self.assertEqual(replay.status_code,200);self.assertTrue(replay.get_json()["receipt"]["duplicate"])
            self.assertEqual(len(client.get(truth_url).get_json()["labels"]),1)
            exported=client.get(f"{url}/{observation_id}/export").get_json()
            field=exported["semantic"]["dataset"]["rows"][0]["fields"][0]
            self.assertEqual(field["truthEvidence"],"HUMAN_CROP_VERIFIED");self.assertTrue(field["knownTruthEligible"])
            self.assertEqual(len(exported["semantic"]["dataset"]["sourceFields"]),6)
            original_hashes=(exported["semantic"]["observation"]["payloadHash"],exported["semantic"]["observation"]["observationHash"])
            original_projection_hash=exported["semantic"]["manifest"]["projectionHash"]
            self.assertEqual(exported["semanticHash"],client.get(f"{url}/{observation_id}/export").get_json()["semanticHash"])

            def relabel(revision,status,value,supersedes,mutation):
                request_label={**label,"mutationId":mutation,"labelRevision":revision,"supersedesLabelId":supersedes,
                    "labelStatus":status,"value":value,"createdAt":f"2026-10-02T00:0{revision+3}:00Z"}
                response=client.post(truth_url,base_url=origin,data={"metadata":json.dumps(request_label,ensure_ascii=False)},
                    content_type="multipart/form-data",headers=headers)
                self.assertEqual(response.status_code,201,response.get_json())
                return response.get_json()["receipt"]["labelId"]

            unknown_id=relabel(2,"UNKNOWN",None,saved.get_json()["receipt"]["labelId"],"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")
            unknown_export=client.get(f"{url}/{observation_id}/export").get_json()
            unknown_field=unknown_export["semantic"]["dataset"]["rows"][0]["fields"][0]
            self.assertFalse(unknown_field["knownTruthEligible"]);self.assertIsNone(unknown_field["truthValue"])
            disputed_id=relabel(3,"DISPUTED",None,unknown_id,"ffffffff-ffff-4fff-8fff-ffffffffffff")
            disputed_export=client.get(f"{url}/{observation_id}/export").get_json()
            self.assertFalse(disputed_export["semantic"]["dataset"]["rows"][0]["fields"][0]["knownTruthEligible"])
            latest_id=relabel(4,"KNOWN","예제 섬",disputed_id,"abababab-abab-4bab-8bab-abababababab")
            resolved_export=client.get(f"{url}/{observation_id}/export").get_json()
            resolved_field=resolved_export["semantic"]["dataset"]["rows"][0]["fields"][0]
            self.assertTrue(resolved_field["knownTruthEligible"]);self.assertEqual(resolved_field["truthValue"],"예제 섬")
            self.assertEqual(resolved_export["semantic"]["observation"]["payloadHash"],original_hashes[0])
            self.assertEqual(resolved_export["semantic"]["observation"]["observationHash"],original_hashes[1])
            self.assertEqual(resolved_export["semantic"]["manifest"]["projectionHash"],original_projection_hash)
            self.assertEqual(len(resolved_export["semantic"]["truthLabels"]),4)
            self.assertEqual(resolved_export["semantic"]["manifest"]["truthLabelBindings"],sorted(
                resolved_export["semantic"]["manifest"]["truthLabelBindings"],key=lambda binding:binding["labelId"]))
            label_rows=store.get_crop_truth_labels(observation_id)
            with patch.object(store,"get_crop_truth_labels",return_value=list(reversed(label_rows))):
                reversed_label_export=store.export_trade_review_observation(observation_id)
            self.assertEqual(reversed_label_export["semanticHash"],resolved_export["semanticHash"])
            with closing(store._connect()) as connection:
                connection.execute("DROP TRIGGER trade_crop_truth_label_v3_no_update")
                connection.execute("UPDATE trade_crop_truth_label_v3 SET field_name='yield' WHERE label_id=?",(latest_id,))
                connection.commit()
            with self.assertRaises(EvidenceIntegrityError): store.export_trade_review_observation(observation_id)
            store.close()
            store.close()

    def test_validator_does_not_mutate_request(self):
        request = example_request()
        before = copy.deepcopy(request)
        validate_final_review_observation(request)
        self.assertEqual(request, before)

    def test_v3_crop_uses_png_hash_and_decoded_rgb_pixel_hash_separately(self):
        from PIL import Image
        output=io.BytesIO(); Image.new("RGBA",(2,2),(12,34,56,255)).save(output,format="PNG"); png=output.getvalue()
        pixel=hashlib.sha256(bytes([12,34,56])*4).hexdigest()
        crop_ref={"cropRefId":"crop-x","box":{"x":0,"y":0,"width":2,"height":2},"pixelSha256":pixel}
        metadata={"schemaVersion":3,"cropMutationId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","projectionRowId":"row-x",
                  "field":"yield","cropRefId":"crop-x","sha256":hashlib.sha256(png).hexdigest(),"pixelSha256":pixel,"width":2,"height":2}
        validate_trade_crop_metadata_v3(metadata,png,crop_ref)
        bad=dict(metadata,pixelSha256="0"*64)
        with self.assertRaises(RecognitionContractError): validate_trade_crop_metadata_v3(bad,png,crop_ref)

    def test_truth_label_requires_explicit_crop_binding_and_provenance(self):
        observation=example_request()
        source=observation["sourceContext"]["rawEvidence"]["snapshot"]["sourceRows"][0]
        crop=source["fields"][0]["cropRefs"][0]
        request={"schemaVersion":1,"mutationId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","sourceRowId":source["sourceRowId"],
            "field":"island","cropRefId":crop["cropRefId"],"labelRevision":1,"supersedesLabelId":None,"labelStatus":"KNOWN",
            "value":"예제 섬","provenance":{"method":"HUMAN_CROP_VERIFIED","labelerRole":"PRODUCT_OWNER","sourceFamilyId":"family-1",
            "cohort":"INDEPENDENT","splitManifestHash":"1"*64,"sourceOrigin":"FRESH_CAPTURE","independentOfOperationalReview":True,"note":None},
            "createdAt":"2026-10-02T00:02:00Z"}
        validate_crop_truth_label_request(request,observation,artifact_present=False)
        request["provenance"]["independentOfOperationalReview"]=False
        validate_crop_truth_label_request(request,observation,artifact_present=False)


if __name__ == "__main__":
    unittest.main()
