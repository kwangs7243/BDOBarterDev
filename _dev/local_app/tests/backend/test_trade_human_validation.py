from __future__ import annotations

import copy
import hashlib
import inspect
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import pytest

from local_app.backend.services.trade_recognition import canonical_hash
from local_app.tools import trade_human_validation as validation
from local_app.tools.trade_ocr_experiment import FIELDS, _semantic_signature


def _field(name: str, index: int) -> dict:
    is_numeric = name in validation.NUMERIC_FIELDS
    raw = str(index + 1) if is_numeric else ("섬" if name == "island" else ("갈퀴 꽃" if name == "toItem" else "육지 재료"))
    candidate = {"integer": int(raw)} if is_numeric else {"text": raw}
    status = "OCR_CANDIDATE_UNVERIFIED" if is_numeric else "RAW_OCR_ONLY"
    if name == "count" and index % 2:
        status = "GEOMETRY_ABSTAIN"
        candidate = None
    return {"rawText": raw, "normalizedText": raw, "ocrCandidate": candidate,
            "ocrScore": 0.2 + (index % 8) / 10, "catalogCandidates": [], "value": None,
            "status": status, "verificationStatus": "OCR_CANDIDATE_UNVERIFIED" if not (name == "count" and index % 2) else "UNVERIFIED",
            "readerEvidence": {"geometryEligible": not (name == "count" and index % 2),
                               "lane": {"x": 0, "y": 0, "width": 10, "height": 8},
                               "tokenBox": {"x": 1, "y": 1, "width": 5, "height": 4} if is_numeric and candidate else None,
                               "inputKind": "frozen-test-crop"},
            "cropHash": f"crop-{name}-{index}", "reasonCodes": []}


def _artifact() -> dict:
    rows = []
    for capture_index in range(16):
        count = 2 if capture_index < 8 else 1
        for ordinal in range(1, count + 1):
            index = len(rows)
            capture = f"capture-{capture_index + 1:02}"
            rows.append({"rowId": f"{capture}:candidate-{ordinal}", "ordinal": ordinal,
                         "box": {"x": 0, "y": 0, "width": 100, "height": 30},
                         "clipped": False, "rowCropHash": f"row-{index}",
                         "fields": {name: _field(name, index) for name in FIELDS},
                         "importerEligible": False, "automationDecision": "REVIEW"})
    metrics = {"text": {}, "numeric": {}, "rows": {"rowsTotal": len(rows)}}
    artifact = {"version": 1, "task": "T010B1", "status": "T010B1_OCR_CANDIDATE_READY_FOR_HUMAN_VALIDATION",
                "sourceT010A2SemanticHash": "t010a2", "captureSet": {"captureCount": 16,
                    "captureSetSha256": "capture-set", "mappedOracleRows": 0,
                    "oracleMappingStatus": "UNRESOLVED"},
                "modelProvenance": {"logicalBundleSha256": "bundle"},
                "textCandidateMetrics": metrics["text"], "numericCandidateMetrics": metrics["numeric"],
                "rowCandidateMetrics": metrics["rows"], "determinism": {"semanticRunHashes": []},
                "accuracy": {"fieldAccuracy": None, "rowExactMatch": None,
                             "captureExactMatch": None, "fullListExact": None}, "rows": rows}
    artifact["semanticHash"] = canonical_hash({
        "task": artifact["task"], "sourceT010A2SemanticHash": artifact["sourceT010A2SemanticHash"],
        "captureSetSha256": artifact["captureSet"]["captureSetSha256"],
        "modelBundleSha256": artifact["modelProvenance"]["logicalBundleSha256"],
        "rows": _semantic_signature(rows), "metrics": metrics, "semanticRunHashes": [],
    })
    return artifact


def _catalog() -> dict:
    return {"islands": ["섬", "다른 섬", "섬"],
            "t6Islands": ["별도 티어 별칭"], "t7Islands": [],
            "masterData": {"1": ["갈퀴 꽃", "갈퀴 꽃"], "2": ["다른 물품"]},
            "specialItems": ["특수 주화", "갈퀴 꽃"]}


@pytest.fixture
def t010b2_tmp_path():
    root = validation.DATA_DIR / "test-tmp"
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="t010b2-", dir=root) as directory:
        yield Path(directory)


def _postprocessed() -> dict:
    raw = _artifact()
    return validation.build_postprocessed_artifact(
        raw, _catalog(), hashlib.sha256(b"source artifact").hexdigest(),
        hashlib.sha256(b"catalog").hexdigest(), expected_semantic_hash=raw["semanticHash"])


def test_catalog_sets_are_unique_field_specific_and_hashed() -> None:
    sets = validation.load_catalog_sets(_catalog())
    assert sets["islandCandidates"] == ["섬", "다른 섬"]
    assert "별도 티어 별칭" not in sets["islandCandidates"]
    assert sets["itemCandidates"] == ["갈퀴 꽃", "다른 물품", "특수 주화"]
    assert sets["islandSet"] == {"count": 2, "sha256": canonical_hash(["다른 섬", "섬"])}
    assert sets["itemSet"] == {"count": 3, "sha256": canonical_hash(["갈퀴 꽃", "다른 물품", "특수 주화"])}


def test_postprocess_uses_islands_for_island_and_union_for_items() -> None:
    artifact = _postprocessed()
    first = artifact["rows"][0]["fields"]
    assert first["island"]["status"] == "EXACT_CATALOG_MATCH"
    assert first["island"]["catalogCandidates"][0]["value"] == "섬"
    assert first["toItem"]["status"] == "EXACT_CATALOG_MATCH"
    assert first["toItem"]["catalogCandidates"][0]["value"] == "갈퀴 꽃"


def test_from_item_no_match_remains_open_world_raw_evidence() -> None:
    artifact = _postprocessed()
    field = artifact["rows"][0]["fields"]["fromItem"]
    assert field["status"] == "NO_CATALOG_MATCH"
    assert field["rawText"] == "육지 재료"
    assert field["value"] is None
    assert field["verificationStatus"] == "OCR_CANDIDATE_UNVERIFIED"
    assert artifact["catalogSource"]["itemSet"]["count"] == 3


def test_raw_t010b1_ocr_evidence_is_immutable_and_hashes_are_separate() -> None:
    raw = _artifact()
    snapshot = copy.deepcopy(raw)
    post = validation.build_postprocessed_artifact(
        raw, _catalog(), "a" * 64, "b" * 64, expected_semantic_hash=raw["semanticHash"])
    assert raw == snapshot
    for old_row, new_row in zip(snapshot["rows"], post["rows"]):
        for field in FIELDS:
            before, after = old_row["fields"][field], new_row["fields"][field]
            for key in ("rawText", "normalizedText", "ocrScore", "cropHash"):
                assert after[key] == before[key]
            assert after["value"] is None
            assert after["verificationStatus"] == before["verificationStatus"]
    assert post["sourceT010B1SemanticHash"] == raw["semanticHash"]
    assert post["postprocessingHash"] != raw["semanticHash"]


def test_t010b1_semantic_source_is_pinned_and_payload_verified() -> None:
    with pytest.raises(ValueError, match="semantic hash"):
        validation.verify_t010b1_artifact(_artifact())
    raw = validation._load_json(validation.ARTIFACT_PATH)
    validation.verify_t010b1_artifact(raw)
    assert raw["semanticHash"] == validation.EXPECTED_T010B1_SEMANTIC_HASH


def test_frozen_artifact_preserves_historical_pilot_when_available() -> None:
    if not validation.ARTIFACT_PATH.is_file() or not validation.CATALOG_PATH.is_file():
        pytest.skip("local frozen T010B1 artifact/catalog are not required Git fixtures")
    raw = validation._load_json(validation.ARTIFACT_PATH)
    catalog = validation._load_json(validation.CATALOG_PATH)
    post = validation.build_postprocessed_artifact(
        raw, catalog, validation.sha256_file(validation.ARTIFACT_PATH),
        validation.sha256_file(validation.CATALOG_PATH))
    pilot = post["pilot"]
    assert pilot["selectionHash"] == "993f624f4ff87c00317747f3512687037ec053b250fee5917720d33b104ac43c"
    assert pilot["rowCount"] == 24
    assert pilot["captureCoverage"] == {
        "selectedCaptureCount": 16,
        "requiredCaptureCount": 16,
        "allCapturesRepresented": True,
    }
    saved_pilot = validation.DATA_DIR / "pilot.json"
    if saved_pilot.is_file():
        assert pilot["rowIds"] == validation._load_json(saved_pilot)["rowIds"]


def test_pilot_is_deterministic_has_24_rows_and_covers_all_16_captures() -> None:
    rows = _artifact()["rows"]
    first = validation.select_pilot_rows(rows)
    second = validation.select_pilot_rows(copy.deepcopy(rows))
    assert first == second
    assert first["rowIds"] == second["rowIds"]
    assert first["selectionHash"] == second["selectionHash"]
    assert first["selectedStrataCounts"] == second["selectedStrataCounts"]
    assert first["rowCount"] == 24
    assert first["captureCoverage"] == {"selectedCaptureCount": 16, "requiredCaptureCount": 16,
                                         "allCapturesRepresented": True}
    assert len(set(first["rowIds"])) == 24
    assert first["blindHoldout"] is False
    assert first["validationKind"] == "HUMAN_LABELED_CALIBRATION_PILOT"
    assert "oracleRows" not in inspect.getsource(validation.select_pilot_rows)


def test_pilot_selection_and_postprocessing_are_hash_seed_independent() -> None:
    raw = _artifact()
    catalog = _catalog()
    script = """
import json, sys
from local_app.tools import trade_human_validation as validation
raw, catalog = json.load(sys.stdin)
post = validation.build_postprocessed_artifact(
    raw, catalog, 'a' * 64, 'b' * 64,
    expected_semantic_hash=raw['semanticHash'])
result = {
    'rowIds': post['pilot']['rowIds'],
    'selectionHash': post['pilot']['selectionHash'],
    'selectedStrataCounts': post['pilot']['selectedStrataCounts'],
    'scoreQuartiles': post['pilot']['scoreQuartiles'],
    'captureCoverage': post['pilot']['captureCoverage'],
    'postprocessingHash': post['postprocessingHash'],
}
print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(',', ':')))
"""
    expected = None
    for seed in ("0", "1", "2", "7", "42", "123", "random", "random", "random", "random", "random"):
        env = os.environ.copy()
        env["PYTHONHASHSEED"] = seed
        completed = subprocess.run(
            [sys.executable, "-c", script],
            input=json.dumps([raw, catalog], ensure_ascii=False),
            text=True,
            capture_output=True,
            check=True,
            env=env,
        )
        actual = completed.stdout.strip()
        if expected is None:
            expected = actual
        assert actual == expected, f"pilot output changed under PYTHONHASHSEED={seed}"
    result = json.loads(expected)
    assert len(result["rowIds"]) == 24
    assert result["captureCoverage"] == {
        "selectedCaptureCount": 16,
        "requiredCaptureCount": 16,
        "allCapturesRepresented": True,
    }


def test_pilot_function_has_no_oracle_input_or_truth_join() -> None:
    signature = inspect.signature(validation.select_pilot_rows)
    assert list(signature.parameters) == ["rows", "capture_count"]
    assert "oracleRows" not in inspect.getsource(validation.select_pilot_rows)
    assert "sourceCaptureId" not in inspect.getsource(validation.select_pilot_rows)


def test_numeric_human_input_uses_strict_field_domains() -> None:
    assert validation._validate_human_value("count", "0") == 0
    assert validation._validate_human_value("reqAmount", "15") == 15
    assert validation._validate_human_value("yield", "2") == 2
    for value in ("", " 1", "1 ", "1 0", "1.0", "1,000", "-1", "+1", "１", "1x"):
        with pytest.raises(ValueError):
            validation._validate_human_value("count", value)
    for field in ("reqAmount", "yield"):
        with pytest.raises(ValueError):
            validation._validate_human_value(field, "0")


def test_confirm_correct_unreadable_and_unverified_actions_are_explicit(t010b2_tmp_path: Path) -> None:
    artifact = _postprocessed()
    store = validation.ValidationStore(artifact, t010b2_tmp_path)
    row_id = artifact["pilot"]["rowIds"][0]
    confirmed = store.save_label(row_id, "island", "CONFIRM")
    assert confirmed["action"] == "CONFIRM" and confirmed["humanValue"] == "섬"
    corrected = store.save_label(row_id, "reqAmount", "CORRECT", "99")
    assert corrected["humanValue"] == 99 and corrected["corrected"] is True
    unreadable = store.save_label(row_id, "fromItem", "UNREADABLE")
    unverified = store.save_label(row_id, "count", "UNVERIFIED")
    assert unreadable["humanValue"] is None and unverified["humanValue"] is None
    assert unreadable["originalOcr"] == "육지 재료"


def test_confirm_requires_valid_ocr_and_label_values_are_validated(t010b2_tmp_path: Path) -> None:
    artifact = _postprocessed()
    store = validation.ValidationStore(artifact, t010b2_tmp_path)
    row_id = next(row["rowId"] for row in artifact["rows"]
                  if row["fields"]["count"]["status"] == "GEOMETRY_ABSTAIN"
                  and row["rowId"] in artifact["pilot"]["rowIds"])
    with pytest.raises(ValueError, match="usable OCR candidate"):
        store.save_label(row_id, "count", "CONFIRM")
    with pytest.raises(ValueError, match="ASCII"):
        store.save_label(row_id, "count", "CORRECT", "3.5")
    with pytest.raises(ValueError, match="outside"):
        store.save_label(row_id, "yield", "CORRECT", "0")
    with pytest.raises(ValueError, match="cannot contain a value"):
        store.save_label(row_id, "island", "UNREADABLE", "섬")


def test_idempotent_save_latest_version_and_resume(t010b2_tmp_path: Path) -> None:
    artifact = _postprocessed()
    store = validation.ValidationStore(artifact, t010b2_tmp_path)
    row_id = next(row["rowId"] for row in artifact["rows"]
                  if row["fields"]["count"]["ocrCandidate"] is not None
                  and row["rowId"] in artifact["pilot"]["rowIds"])
    first = store.save_label(row_id, "island", "CONFIRM")
    repeat = store.save_label(row_id, "island", "CONFIRM")
    assert repeat == first and repeat["labelVersion"] == 1
    corrected = store.save_label(row_id, "island", "CORRECT", "다른 섬")
    assert corrected["labelVersion"] == 2 and corrected["corrected"] is True
    records = [json.loads(line) for line in (t010b2_tmp_path / "labels.jsonl").read_text(encoding="utf-8").splitlines()]
    assert len(records) == 1 and records[0]["labelVersion"] == 2
    assert store.set_current_index(12) == 12
    resumed = validation.ValidationStore(artifact, t010b2_tmp_path)
    assert resumed.state()["rows"][0]["labels"]["island"] == corrected
    assert resumed.state()["currentIndex"] == 12


def test_progress_rejects_positions_outside_pilot(t010b2_tmp_path: Path) -> None:
    store = validation.ValidationStore(_postprocessed(), t010b2_tmp_path)
    for value in (-1, 24, True, "2", None):
        with pytest.raises(ValueError, match="24-row pilot"):
            store.set_current_index(value)


def test_summary_uses_only_human_verified_denominators_and_excludes_partial_rows(t010b2_tmp_path: Path) -> None:
    artifact = _postprocessed()
    store = validation.ValidationStore(artifact, t010b2_tmp_path)
    row_id = next(row["rowId"] for row in artifact["rows"]
                  if row["fields"]["count"]["ocrCandidate"] is not None
                  and row["rowId"] in artifact["pilot"]["rowIds"])
    store.save_label(row_id, "island", "CONFIRM")
    store.save_label(row_id, "reqAmount", "CORRECT", "99")
    store.save_label(row_id, "fromItem", "UNREADABLE")
    store.save_label(row_id, "toItem", "CONFIRM")
    store.save_label(row_id, "count", "CONFIRM")
    store.save_label(row_id, "yield", "CONFIRM")
    summary = store.summary
    assert summary["humanVerifiedFields"] == 5
    assert summary["fieldMetrics"]["island"]["humanVerifiedFields"] == 1
    assert summary["fieldMetrics"]["island"]["ocrExact"] == 1
    assert summary["fieldMetrics"]["reqAmount"]["humanVerifiedFields"] == 1
    assert summary["fieldMetrics"]["reqAmount"]["ocrExact"] == 0
    assert summary["fieldAccuracy"] == 0.8
    assert summary["unreadableFields"] == 1
    assert summary["sixFieldExact"]["denominatorHumanTruthRows"] == 0
    assert summary["sixFieldExact"]["humanPartialRowsExcluded"] == 23
    assert summary["sixFieldExact"]["completeRowsWithoutSixHumanValuesExcluded"] == 1


def test_summary_reports_numeric_abstain_and_keeps_full_list_unknown(t010b2_tmp_path: Path) -> None:
    artifact = _postprocessed()
    store = validation.ValidationStore(artifact, t010b2_tmp_path)
    row_id = next(row["rowId"] for row in artifact["rows"]
                  if row["fields"]["count"]["status"] == "GEOMETRY_ABSTAIN"
                  and row["rowId"] in artifact["pilot"]["rowIds"])
    store.save_label(row_id, "count", "CORRECT", "0")
    result = store.summary["numericEvaluation"]["count"]
    assert result["humanVerifiedFields"] == 1
    assert result["numericAbstain"] == 1
    assert result["geometryAbstainReadable"] == 1
    assert store.summary["fullListExact"] is None
    assert store.summary["requiresSolReview"] is True
    assert store.summary["productionApproved"] is False
    assert store.summary["engineSelected"] is False
    assert store.summary["HIGH"] is False


def test_server_binds_localhost_and_rejects_external_bind(t010b2_tmp_path: Path) -> None:
    artifact = _postprocessed()
    store = validation.ValidationStore(artifact, t010b2_tmp_path)
    with pytest.raises(ValueError, match="127.0.0.1"):
        validation.create_server(store, {}, host="0.0.0.0")
    server = validation.create_server(store, {}, host="127.0.0.1")
    try:
        assert server.server_address[0] == "127.0.0.1"
        assert server.server_address[1] > 0
    finally:
        server.server_close()


def test_capture_map_reads_capture_records_without_using_oracle_rows(t010b2_tmp_path: Path, monkeypatch) -> None:
    from PIL import Image

    image_path = t010b2_tmp_path / "capture.png"
    Image.new("RGB", (10, 10), "white").save(image_path)
    manifest_path = t010b2_tmp_path / "manifest.json"
    payload = {"trade": {"captures": [{"captureId": "capture-01", "imagePath": "capture.png",
                                         "imageHash": hashlib.sha256(image_path.read_bytes()).hexdigest()}],
                           "oracleRows": [{"rawValue": "must never be joined"}]}}
    manifest_path.write_text(json.dumps(payload), encoding="utf-8")
    expected = canonical_hash([{"captureId": "capture-01", "imageHash": payload["trade"]["captures"][0]["imageHash"]}])
    result = validation.load_capture_image_map(manifest_path, expected, 1)
    assert result == {"capture-01": image_path.resolve()}
    row = _artifact()["rows"][0]
    assert validation.render_crop_png(row, result, "row")
