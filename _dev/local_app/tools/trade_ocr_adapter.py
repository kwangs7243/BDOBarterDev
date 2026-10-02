"""Master-free adapter for raw Trade OCR and legacy draft compatibility."""
from __future__ import annotations

import copy
import re
import unicodedata
from typing import Any, Callable, Literal, TypedDict


TradeField = Literal["island", "fromItem", "reqAmount", "toItem", "count", "yield"]
RecognizeFn = Callable[[Any, Any], dict[str, Any]]

_TEXT_FIELDS = frozenset(("island", "fromItem", "toItem"))
_NUMERIC_FIELDS = frozenset(("reqAmount", "count", "yield"))
_READER = {
    "readerId": "paddle-korean-ppocrv5-mobile-onnx-cpu-v1",
    "engine": "onnxruntime",
    "model": "korean_PP-OCRv5_mobile_rec",
    "device": "cpu",
}


class NumericParse(TypedDict):
    numericCandidate: int | None
    numericParseStatus: str


class TradeOcrAdapterResult(TypedDict):
    schemaVersion: int
    adapterVersion: str
    field: str
    reader: dict[str, str]
    raw: dict[str, Any]
    parse: dict[str, Any]
    geometry: dict[str, Any]
    diagnostics: dict[str, Any]
    status: str
    reasonCodes: list[str]
    cropHash: Any


def normalize_trade_ocr_compat_text(raw_text: str | None) -> str | None:
    """Legacy reader compatibility only: NFKC plus outer trim; not correction authority."""
    if raw_text is None:
        return None
    return unicodedata.normalize("NFKC", raw_text).strip()


def parse_trade_numeric_raw(field: str, raw_text: str | None) -> NumericParse:
    """Parse one raw token without decoration removal, defaults, or domain inference."""
    if field not in _NUMERIC_FIELDS:
        raise ValueError(f"not a numeric Trade field: {field}")
    if raw_text is None:
        return {"numericCandidate": None, "numericParseStatus": "OCR_ERROR"}
    if raw_text == "":
        return {"numericCandidate": None, "numericParseStatus": "EMPTY_OCR"}
    if re.fullmatch(r"[0-9]+", raw_text) is None:
        return {"numericCandidate": None, "numericParseStatus": "INVALID_NUMERIC_TOKEN"}
    candidate = int(raw_text)
    if field in ("reqAmount", "yield") and candidate < 1:
        return {"numericCandidate": None, "numericParseStatus": "INVALID_NUMERIC_TOKEN"}
    return {"numericCandidate": candidate, "numericParseStatus": "NUMERIC_OCR_CANDIDATE"}


def _default_recognize(reader: Any, crop: Any) -> dict[str, Any]:
    # Keep the current Paddle module out of adapter import and fake-reader test startup.
    from local_app.tools.trade_ocr_experiment import recognize_one

    return recognize_one(reader, crop)


def read_trade_ocr_field(
    *,
    field: TradeField | str,
    crop: Any,
    geometry: dict[str, Any],
    reader: Any,
    visual_evidence: dict[str, Any] | None,
    numeric_structure: dict[str, Any] | None = None,
    recognize_fn: RecognizeFn | None = None,
) -> TradeOcrAdapterResult:
    """Return raw OCR/parse/geometry facts; never consults Master or corrects text."""
    if field not in _TEXT_FIELDS | _NUMERIC_FIELDS:
        raise ValueError(f"unsupported Trade field: {field}")

    geometry_value = copy.deepcopy(geometry)
    if crop is None or geometry_value.get("valid") is not True:
        return {
            "schemaVersion": 1,
            "adapterVersion": "trade-ocr-adapter-v1",
            "field": field,
            "reader": dict(_READER),
            "raw": {"text": None, "score": None, "errorType": None},
            "parse": {"compatNormalizedText": None, "numericCandidate": None,
                      "numericParseStatus": None},
            "geometry": geometry_value,
            "diagnostics": {"visual": None, "numericStructure": None},
            "status": "GEOMETRY_ABSTAIN",
            "reasonCodes": ["LANE_INVALID"],
            "cropHash": None,
        }

    raw_text: str | None = None
    score: Any = None
    error_type: str | None = None
    try:
        recognize = recognize_fn or _default_recognize
        output = recognize(reader, crop)
        raw_text, score = output.get("rawText"), output.get("ocrScore")
    except Exception as error:  # store only a portable exception type, never message/path/traceback
        error_type = type(error).__name__

    normalized = normalize_trade_ocr_compat_text(raw_text)
    parsed = (parse_trade_numeric_raw(field, raw_text) if field in _NUMERIC_FIELDS else
              {"numericCandidate": None, "numericParseStatus": None})
    numeric_candidate = parsed["numericCandidate"]
    parse_status = parsed["numericParseStatus"]
    numeric_evidence = copy.deepcopy(numeric_structure)
    visual = copy.deepcopy(visual_evidence)

    if error_type:
        status, reasons = "OCR_ERROR", ["OCR_INFERENCE_ERROR"]
    elif field in _NUMERIC_FIELDS:
        contacts = (numeric_evidence or {}).get("plausibleTokenBoundaryContact") or {}
        if any(bool(contact) for contact in contacts.values()):
            status, reasons = "FIELD_CLIPPED", ["TOKEN_BOUNDARY_CONTACT"]
        elif raw_text is None:
            status, reasons = "OCR_ERROR", ["OCR_OUTPUT_NULL"]
        elif raw_text == "":
            status, reasons = "EMPTY_OCR", ["OCR_EMPTY"]
        elif numeric_candidate is not None:
            status, reasons = "NUMERIC_OCR_CANDIDATE", ["STRICT_ASCII_INTEGER_TOKEN"]
        else:
            status, reasons = "UNREADABLE", [parse_status]
    elif raw_text is None:
        status, reasons = "OCR_ERROR", ["OCR_OUTPUT_NULL"]
    elif raw_text == "":
        status, reasons = "EMPTY_OCR", ["OCR_EMPTY"]
    else:
        status, reasons = "RAW_OCR_CANDIDATE", ["RAW_TEXT_UNVERIFIED"]

    return {
        "schemaVersion": 1,
        "adapterVersion": "trade-ocr-adapter-v1",
        "field": field,
        "reader": dict(_READER),
        "raw": {"text": raw_text, "score": score, "errorType": error_type},
        "parse": {"compatNormalizedText": normalized, **parsed},
        "geometry": geometry_value,
        "diagnostics": {"visual": visual, "numericStructure": numeric_evidence},
        "status": status,
        "reasonCodes": reasons,
        "cropHash": visual.get("cropHash") if isinstance(visual, dict) else None,
    }


def to_legacy_trade_draft_field(adapter_result: TradeOcrAdapterResult) -> dict[str, Any]:
    """Project adapter facts to the established worker-v1 field contract."""
    raw = adapter_result["raw"]
    parsed = adapter_result["parse"]
    if adapter_result["status"] == "GEOMETRY_ABSTAIN":
        evidence = {"geometry": copy.deepcopy(adapter_result["geometry"])}
    else:
        evidence = {
            "readerId": adapter_result["reader"]["readerId"],
            "geometry": copy.deepcopy(adapter_result["geometry"]),
            "visual": copy.deepcopy(adapter_result["diagnostics"]["visual"]),
            "normalization": "Unicode NFKC and outer whitespace trim; rawText preserved",
            "candidateStatusOnly": True,
        }
        if adapter_result["field"] in _NUMERIC_FIELDS:
            candidate = parsed["numericCandidate"]
            status = parsed["numericParseStatus"]
            evidence["numericStructure"] = copy.deepcopy(adapter_result["diagnostics"]["numericStructure"])
            evidence["rawNumericParseEvidence"] = {
                "strictAsciiInteger": candidate is not None,
                "parseStatus": status,
                "observedCountRange1To10": (1 <= candidate <= 10)
                if adapter_result["field"] == "count" and candidate is not None else None,
            }
        if raw["errorType"] is not None:
            evidence["errorType"] = raw["errorType"]
    return {
        "rawText": raw["text"],
        "normalizedText": parsed["compatNormalizedText"],
        "ocrScore": raw["score"],
        "rawNumericCandidate": parsed["numericCandidate"],
        "value": None,
        "status": adapter_result["status"],
        "cropHash": adapter_result["cropHash"],
        "readerEvidence": evidence,
        "reasonCodes": list(adapter_result["reasonCodes"]),
    }
