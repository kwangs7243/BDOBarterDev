from __future__ import annotations

import inspect

from PIL import Image

from local_app.tools import trade_ocr_experiment as experiment


def test_recognition_output_preserves_raw_text_and_score() -> None:
    parsed = experiment.extract_recognition_output({"res": {"rec_text": "  부산 ", "rec_score": 0.8125}})
    assert parsed == {"rawText": "  부산 ", "ocrScore": 0.8125}
    field = experiment.postprocess_field("island", parsed, "crop", {}, [])
    assert field["rawText"] == "  부산 "
    assert field["ocrScore"] == 0.8125
    assert field["value"] is None
    assert field["status"] == "RAW_OCR_ONLY"


def test_recognition_wrapper_receives_only_existing_crop() -> None:
    class Reader:
        def predict(self, *, input, batch_size):
            assert input.shape == (12, 30, 3)
            assert batch_size == 1
            return [{"rec_text": "섬", "rec_score": 0.9}]

    result = experiment.recognize_one(Reader(), Image.new("RGB", (30, 12), "white"))
    assert result == {"rawText": "섬", "ocrScore": 0.9}


def test_numeric_candidate_requires_full_ascii_integer_token() -> None:
    assert experiment.strict_numeric_candidate("reqAmount", "12") == (12, "OCR_CANDIDATE_UNVERIFIED")
    assert experiment.strict_numeric_candidate("count", "0") == (0, "OCR_CANDIDATE_UNVERIFIED")
    assert experiment.strict_numeric_candidate("yield", "1") == (1, "OCR_CANDIDATE_UNVERIFIED")
    for raw in ("", " 12", "12 ", "1 2", "1,2", "1.2", "-1", "+1", "1x", "١٢"):
        value, status = experiment.strict_numeric_candidate("count", raw)
        assert value is None
        assert status == ("EMPTY_OCR" if raw == "" else "INVALID_NUMERIC_TOKEN")
    for field in ("reqAmount", "yield"):
        assert experiment.strict_numeric_candidate(field, "0") == (None, "INVALID_NUMERIC_TOKEN")
    assert experiment.strict_numeric_candidate("count", None) == (None, "OCR_ERROR")


def test_numeric_postprocess_never_promotes_candidate_to_value() -> None:
    field = experiment.postprocess_field("count", {"rawText": "17", "ocrScore": 0.7}, "crop", {}, [])
    assert field["ocrCandidate"] == {"integer": 17}
    assert field["value"] is None
    assert field["status"] == "OCR_CANDIDATE_UNVERIFIED"
    invalid = experiment.postprocess_field("yield", {"rawText": "7?", "ocrScore": 0.7}, "crop", {}, [])
    assert invalid["ocrCandidate"] is None
    assert invalid["value"] is None
    assert invalid["status"] == "INVALID_NUMERIC_TOKEN"


def test_catalog_candidate_ambiguity_and_unmatched_text_are_preserved() -> None:
    ambiguous = experiment.catalog_candidate_evidence("ABCD", ["ABCE", "ABCF"])
    assert ambiguous["status"] == "AMBIGUOUS_CATALOG_MATCH"
    assert {item["value"] for item in ambiguous["candidates"]} == {"ABCE", "ABCF"}
    unmatched = experiment.postprocess_field(
        "fromItem", {"rawText": "미등록 육지 재료", "ocrScore": 0.4}, "crop", {}, ["다른 물품"])
    assert unmatched["rawText"] == "미등록 육지 재료"
    assert unmatched["normalizedText"] == "미등록 육지 재료"
    assert unmatched["status"] == "NO_CATALOG_MATCH"
    assert unmatched["value"] is None


def test_empty_and_missing_ocr_output_abstain_without_defaults() -> None:
    empty = experiment.postprocess_field("island", {"rawText": "", "ocrScore": None}, "crop", {}, [])
    missing = experiment.postprocess_field("reqAmount", {"rawText": None, "ocrScore": None}, "crop", {}, [])
    assert empty["status"] == "EMPTY_OCR" and empty["value"] is None
    assert missing["status"] == "OCR_ERROR" and missing["value"] is None


def test_public_pipeline_does_not_accept_or_join_oracle_rows() -> None:
    parameters = inspect.signature(experiment.run_trade_ocr_candidate).parameters
    assert "oracle" not in " ".join(parameters).lower()
    assert "oracle" not in inspect.signature(experiment.recognize_one).parameters
    assert "oracleRows" not in inspect.getsource(experiment.run_trade_ocr_candidate)
