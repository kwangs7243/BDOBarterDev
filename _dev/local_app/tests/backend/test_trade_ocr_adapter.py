from __future__ import annotations

import ast
import copy
import subprocess
import sys
from pathlib import Path

import pytest

from local_app.tools.trade_ocr_adapter import (
    normalize_trade_ocr_compat_text,
    parse_trade_numeric_raw,
    read_trade_ocr_field,
    to_legacy_trade_draft_field,
)


GEOMETRY = {"valid": True, "box": {"x": 1, "y": 2, "width": 10, "height": 8}}
VISUAL = {"cropHash": "legacy-crop-hash", "foregroundPixels": 17}
NUMERIC_STRUCTURE = {
    "readerId": "connected-component-token-structure-v2",
    "plausibleTokenBoundaryContact": {"left": False, "right": False},
    "componentCount": 2,
}


def _read(field: str, raw: str | None, *, geometry=None, visual=None, numeric=None, recognize=None):
    return read_trade_ocr_field(
        field=field,
        crop=object(),
        geometry=copy.deepcopy(GEOMETRY if geometry is None else geometry),
        reader=object(),
        visual_evidence=copy.deepcopy(VISUAL if visual is None else visual),
        numeric_structure=copy.deepcopy(
            NUMERIC_STRUCTURE if numeric is None and field in {"reqAmount", "count", "yield"} else numeric
        ),
        recognize_fn=recognize or (lambda _reader, _crop: {"rawText": raw, "ocrScore": 0.875}),
    )


def test_text_raw_score_and_compatibility_normalization_are_separate() -> None:
    result = _read("fromItem", "  ＡＢＣ  ")
    assert result["raw"] == {"text": "  ＡＢＣ  ", "score": 0.875, "errorType": None}
    assert result["parse"]["compatNormalizedText"] == "ABC"
    assert result["status"] == "RAW_OCR_CANDIDATE"
    assert result["reasonCodes"] == ["RAW_TEXT_UNVERIFIED"]
    assert normalize_trade_ocr_compat_text(None) is None
    legacy = to_legacy_trade_draft_field(result)
    assert legacy["rawText"] == "  ＡＢＣ  "
    assert legacy["normalizedText"] == "ABC"
    assert legacy["ocrScore"] == 0.875
    assert legacy["cropHash"] == "legacy-crop-hash"
    assert legacy["value"] is None


def test_text_reader_does_not_repair_or_lookup_names() -> None:
    result = _read("island", "해모섬")
    assert result["raw"]["text"] == "해모섬"
    assert result["parse"]["compatNormalizedText"] == "해모섬"
    source = Path(__file__).parents[2] / "tools" / "trade_ocr_adapter.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    imported = [alias.name for node in ast.walk(tree)
                if isinstance(node, (ast.Import, ast.ImportFrom))
                for alias in node.names]
    source_text = source.read_text(encoding="utf-8")
    forbidden = ("catalog_candidate_evidence", "getSafeUniqueItemMatch", "stableId",
                 "legacyNameKey", "canonicalName", "Master Bundle", "fuzzy")
    assert not any(token in source_text for token in forbidden)
    assert not any("master" in name.lower() or "catalog" in name.lower()
                   or "correction" in name.lower() for name in imported)


def test_adapter_import_does_not_load_ocr_runtime() -> None:
    code = (
        "import sys; import local_app.tools.trade_ocr_adapter; "
        "assert 'local_app.tools.trade_ocr_experiment' not in sys.modules; "
        "assert 'paddleocr' not in sys.modules; assert 'onnxruntime' not in sys.modules"
    )
    completed = subprocess.run([sys.executable, "-B", "-c", code], check=False,
                                capture_output=True, text=True)
    assert completed.returncode == 0, completed.stderr


@pytest.mark.parametrize(("raw", "status", "reason"), [
    ("", "EMPTY_OCR", "OCR_EMPTY"),
    (None, "OCR_ERROR", "OCR_OUTPUT_NULL"),
])
def test_empty_and_reader_returned_null_are_distinct(raw, status, reason) -> None:
    result = _read("island", raw)
    assert result["status"] == status
    assert result["reasonCodes"] == [reason]
    assert result["raw"]["errorType"] is None


def test_recognizer_exception_is_portable_error_evidence() -> None:
    def fail(_reader, _crop):
        raise RuntimeError("secret path and machine detail")

    result = _read("toItem", None, recognize=fail)
    assert result["raw"] == {"text": None, "score": None, "errorType": "RuntimeError"}
    assert result["status"] == "OCR_ERROR"
    assert result["reasonCodes"] == ["OCR_INFERENCE_ERROR"]
    assert "secret" not in repr(result)
    assert to_legacy_trade_draft_field(result)["readerEvidence"]["errorType"] == "RuntimeError"


def test_invalid_geometry_abstains_without_calling_reader() -> None:
    calls = []
    geometry = {"valid": False, "normalized": {"x0": 0.2}}
    before = copy.deepcopy(geometry)
    result = _read("count", "4", geometry=geometry, recognize=lambda *_: calls.append(True))
    assert calls == []
    assert result["status"] == "GEOMETRY_ABSTAIN"
    assert result["reasonCodes"] == ["LANE_INVALID"]
    assert result["raw"]["text"] is None
    assert result["parse"]["numericCandidate"] is None
    assert result["cropHash"] is None
    assert result["geometry"] == before
    assert geometry == before
    assert to_legacy_trade_draft_field(result) == {
        "rawText": None, "normalizedText": None, "ocrScore": None,
        "rawNumericCandidate": None, "value": None, "status": "GEOMETRY_ABSTAIN",
        "cropHash": None, "readerEvidence": {"geometry": before}, "reasonCodes": ["LANE_INVALID"],
    }


@pytest.mark.parametrize(("field", "raw", "expected"), [
    ("reqAmount", "12", (12, "NUMERIC_OCR_CANDIDATE")),
    ("yield", "48", (48, "NUMERIC_OCR_CANDIDATE")),
    ("count", "0", (0, "NUMERIC_OCR_CANDIDATE")),
    ("reqAmount", "0", (None, "INVALID_NUMERIC_TOKEN")),
    ("yield", "0", (None, "INVALID_NUMERIC_TOKEN")),
    ("count", "abc", (None, "INVALID_NUMERIC_TOKEN")),
    ("count", "1,000", (None, "INVALID_NUMERIC_TOKEN")),
    ("count", "1 000회", (None, "INVALID_NUMERIC_TOKEN")),
    ("count", "", (None, "EMPTY_OCR")),
    ("count", None, (None, "OCR_ERROR")),
])
def test_strict_numeric_raw_parse(field, raw, expected) -> None:
    parsed = parse_trade_numeric_raw(field, raw)
    assert (parsed["numericCandidate"], parsed["numericParseStatus"]) == expected
    result = _read(field, raw)
    assert result["parse"]["numericCandidate"] == expected[0]
    if raw == "":
        assert result["status"] == "EMPTY_OCR"
    elif raw is None:
        assert result["status"] == "OCR_ERROR"
    elif expected[0] is None:
        assert result["status"] == "UNREADABLE"
    else:
        assert result["status"] == "NUMERIC_OCR_CANDIDATE"
    assert to_legacy_trade_draft_field(result)["rawText"] == raw


def test_boundary_contact_and_diagnostics_are_preserved_without_mutation() -> None:
    structure = copy.deepcopy(NUMERIC_STRUCTURE)
    structure["plausibleTokenBoundaryContact"]["right"] = True
    visual = copy.deepcopy(VISUAL)
    geometry = copy.deepcopy(GEOMETRY)
    structure_before, visual_before, geometry_before = map(copy.deepcopy, (structure, visual, geometry))
    result = read_trade_ocr_field(
        field="yield", crop=object(), geometry=geometry, reader=None,
        visual_evidence=visual, numeric_structure=structure,
        recognize_fn=lambda *_: {"rawText": "148", "ocrScore": 0.91},
    )
    assert result["status"] == "FIELD_CLIPPED"
    assert result["reasonCodes"] == ["TOKEN_BOUNDARY_CONTACT"]
    assert result["parse"]["numericCandidate"] == 148
    assert result["diagnostics"] == {"visual": visual_before, "numericStructure": structure_before}
    assert structure == structure_before and visual == visual_before and geometry == geometry_before
    legacy = to_legacy_trade_draft_field(result)
    assert legacy["readerEvidence"]["visual"] == visual_before
    assert legacy["readerEvidence"]["numericStructure"] == structure_before
    assert legacy["readerEvidence"]["rawNumericParseEvidence"]["strictAsciiInteger"] is True


def test_legacy_parity_fixture_preserves_field_shape_and_meaning() -> None:
    text = to_legacy_trade_draft_field(_read("island", "해모섬"))
    assert text == {
        "rawText": "해모섬", "normalizedText": "해모섬", "ocrScore": 0.875,
        "rawNumericCandidate": None, "value": None, "status": "RAW_OCR_CANDIDATE",
        "cropHash": "legacy-crop-hash",
        "readerEvidence": {
            "readerId": "paddle-korean-ppocrv5-mobile-onnx-cpu-v1", "geometry": GEOMETRY,
            "visual": VISUAL,
            "normalization": "Unicode NFKC and outer whitespace trim; rawText preserved",
            "candidateStatusOnly": True,
        },
        "reasonCodes": ["RAW_TEXT_UNVERIFIED"],
    }
    numeric = to_legacy_trade_draft_field(_read("count", "0"))
    assert numeric["rawNumericCandidate"] == 0
    assert numeric["status"] == "NUMERIC_OCR_CANDIDATE"
    assert numeric["readerEvidence"]["rawNumericParseEvidence"] == {
        "strictAsciiInteger": True, "parseStatus": "NUMERIC_OCR_CANDIDATE",
        "observedCountRange1To10": False,
    }
    assert set(numeric) == {"rawText", "normalizedText", "ocrScore", "rawNumericCandidate",
                           "value", "status", "cropHash", "readerEvidence", "reasonCodes"}


def test_metadata_and_diagnostics_are_not_injected_into_legacy_contract() -> None:
    result = _read("count", "7")
    assert result["reader"] == {
        "readerId": "paddle-korean-ppocrv5-mobile-onnx-cpu-v1",
        "engine": "onnxruntime", "model": "korean_PP-OCRv5_mobile_rec", "device": "cpu",
    }
    legacy = to_legacy_trade_draft_field(result)
    assert set(legacy["readerEvidence"]) == {
        "readerId", "geometry", "visual", "normalization", "candidateStatusOnly",
        "numericStructure", "rawNumericParseEvidence",
    }
