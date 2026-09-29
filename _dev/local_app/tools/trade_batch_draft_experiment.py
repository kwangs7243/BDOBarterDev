#!/usr/bin/env python3
"""Oracle-isolated local T010P3A six-field Trade draft experiment."""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import statistics
import sys
import time
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from local_app.backend.services.trade_recognition import (  # noqa: E402
    FIELDS, NUMERIC_FIELDS, TEXT_FIELDS, _components, _crop_hash,
    _foreground_mask, _lane_boxes, canonical_hash, detect_rows, sha256_file,
)
from local_app.tools.trade_ocr_experiment import (  # noqa: E402
    MODEL_NAME, _load_reader, recognize_one,
)
from local_app.tools.trade_recognition_experiments import (  # noqa: E402
    infer_trade_numeric_field_v2,
)

ROW_DETECTOR = "repeated-horizontal-separator-pair-v1"
TEXT_FIELD_ORDER = ("island", "fromItem", "toItem")
NUMERIC_FIELD_ORDER = ("reqAmount", "count", "yield")


def _json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _normalized_text(raw: str | None) -> str | None:
    return unicodedata.normalize("NFKC", raw).strip() if raw is not None else None


def _strict_integer(raw: str | None) -> tuple[int | None, str]:
    if raw is None:
        return None, "OCR_ERROR"
    if raw == "":
        return None, "EMPTY_OCR"
    if re.fullmatch(r"[0-9]+", raw) is None:
        return None, "INVALID_NUMERIC_TOKEN"
    return int(raw), "NUMERIC_OCR_CANDIDATE"


def _lane_crop(row_crop: Image.Image, lane: dict[str, float]) -> tuple[Image.Image | None, dict[str, Any]]:
    boxes, errors = _lane_boxes(row_crop.width, row_crop.height, {"island": lane})
    selected = boxes.get("island")
    if not selected or not selected["valid"]:
        return None, {"valid": False, "errors": errors, "normalized": lane}
    box = selected["box"]
    crop = row_crop.crop((box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]))
    return crop, {"valid": True, "box": {k: box[k] for k in ("x", "y", "width", "height")},
                  "normalized": dict(lane), "errors": errors}


def _visual_evidence(crop: Image.Image, field: str,
                     numeric_parameters: dict[str, Any] | None = None,
                     lane: dict[str, float] | None = None) -> dict[str, Any]:
    mask = _foreground_mask(crop)
    components = _components(mask)
    h, w = mask.shape
    total = int(mask.sum())
    band_y = int(h * 0.65)
    band = int(mask[band_y:, :].sum())
    rgb = np.asarray(crop.convert("RGB"), dtype=np.uint8)
    warm_mask = (rgb[:, :, 0] > 140) & (rgb[:, :, 1] > 120) & (rgb[:, :, 2] < 145)
    warm_total = int(warm_mask.sum())
    warm_bottom = int(warm_mask[band_y:, :].sum())
    name_line_pixels = None
    text_bands: list[dict[str, int]] = []
    if field == "fromItem" and lane is not None:
        y0, y1 = float(lane["y0"]), float(lane["y1"])
        fraction = min(1.0, max(0.0, (0.50 - y0) / (y1 - y0)))
        name_line_pixels = int(mask[:max(1, int(round(h * fraction))), :].sum())
        text_components = [item for item in components if item["x"] < w * .78
                           and item["height"] >= max(2, int(round(h * .07)))]
        intervals = sorted((item["y"], item["y"] + item["height"]) for item in text_components)
        gap = max(1, int(round(h * .04)))
        for top, bottom in intervals:
            if text_bands and top <= text_bands[-1]["bottom"] + gap:
                text_bands[-1]["bottom"] = max(text_bands[-1]["bottom"], bottom)
                text_bands[-1]["componentCount"] += 1
            else:
                text_bands.append({"top": top, "bottom": bottom, "componentCount": 1})
    edge_width = max(1, int(round(w * 0.04)))
    right = int(mask[:, max(0, w - edge_width):].sum())
    left = int(mask[:, :edge_width].sum())
    plausible_contacts = None
    if field in NUMERIC_FIELDS:
        structural = infer_trade_numeric_field_v2(crop, field, {"top": False, "bottom": False},
                                                   {"componentPlausibility": numeric_parameters})
        plausible_contacts = structural["readerEvidence"]["plausibleTokenBoundaryContact"]
    vertical_bins = [int(mask[int(h * i / 4):int(h * (i + 1) / 4), :].sum()) for i in range(4)]
    return {
        "foregroundPixels": total,
        "bottomBandForegroundRatio": (band / total) if total else 0.0,
        "bottomBandWarmForegroundRatio": warm_bottom / warm_total if warm_total else 0.0,
        "bottomBandWarmForegroundPixels": warm_bottom,
        "fromItemNameLineForegroundPixels": name_line_pixels,
        "fromItemHorizontalTextBandCount": len(text_bands) if field == "fromItem" else None,
        "fromItemSecondaryLineRisk": len(text_bands) >= 2 if field == "fromItem" else None,
        "fromItemTextBands": text_bands if field == "fromItem" else None,
        "rightEdgeForegroundRatio": (right / total) if total else 0.0,
        "leftEdgeForegroundRatio": (left / total) if total else 0.0,
        "edgeForegroundPixels": {"left": left, "right": right},
        "verticalForegroundBins": vertical_bins,
        "componentCount": len(components),
        "components": components,
        "plausibleTokenBoundaryContact": plausible_contacts,
        "cropDimensions": {"width": w, "height": h},
        "cropHash": _crop_hash(crop),
    }


def _row_records(captures: list[dict[str, Any]], row_parameters: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    all_rows: list[dict[str, Any]] = []
    capture_evidence: list[dict[str, Any]] = []
    for capture_ordinal, capture in enumerate(captures, 1):
        path = Path(capture["imagePath"]).resolve()
        actual_hash = sha256_file(path)
        expected_hash = capture.get("imageHash")
        if expected_hash and actual_hash != expected_hash:
            raise ValueError(f"capture image hash mismatch: {capture['captureId']}")
        with Image.open(path) as image_handle:
            image = image_handle.convert("RGB")
        detected = detect_rows(image, row_parameters)
        capture_evidence.append({"captureId": capture["captureId"], "batchId": capture.get("batchId"),
                                 "captureOrdinal": capture_ordinal, "imageHash": actual_hash,
                                 "imageDimensions": {"width": image.width, "height": image.height},
                                 "rowCount": len(detected)})
        for ordinal, row in enumerate(detected, 1):
            box = {key: int(row[key]) for key in ("top", "bottom", "height")}
            row_box = {"x": 0, "y": box["top"], "width": image.width, "height": box["height"]}
            crop = image.crop((0, box["top"], image.width, box["bottom"]))
            all_rows.append({"capture": capture, "captureOrdinal": capture_ordinal, "rowOrdinal": ordinal,
                             "rowBox": row_box, "rowCrop": crop, "rowCropHash": _crop_hash(crop),
                             "clipped": bool(row.get("clipped")), "boundaryContact": row.get("boundaryContact", {})})
    return all_rows, capture_evidence


def _count_lane_candidates(base: dict[str, float]) -> list[dict[str, Any]]:
    candidates = []
    for left in (0.0, 0.02, 0.04):
        for right in (0.0, 0.02, 0.04):
            lane = dict(base)
            lane["x0"] = base["x0"] - left
            lane["x1"] = base["x1"] - right
            candidates.append({"candidateId": f"shift-left-{int(round(left*1000)):03d}-shrink-right-{int(round(right*1000)):03d}",
                               "lane": lane, "leftShift": left, "rightShrink": right})
    return candidates


def _candidate_sets(base: dict[str, dict[str, float]]) -> dict[str, list[dict[str, Any]]]:
    sets: dict[str, list[dict[str, Any]]] = {}
    for field, amounts in (("island", (0.0, .01, .02, .03)), ("toItem", (0.0, .01, .02, .03, .04))):
        sets[field] = [{"candidateId": "base" if amount == 0 else f"shrink-right-{int(round(amount*1000)):03d}",
                        "lane": {**base[field], "x1": base[field]["x1"] - amount}}
                       for amount in amounts]
    sets["fromItem"] = [{"candidateId": "base" if y == base["fromItem"]["y1"] else f"name-line-y1-{int(y*100):03d}",
                         "lane": {**base["fromItem"], "y1": y}}
                        for y in (base["fromItem"]["y1"], .65, .60, .55, .50, .45)]
    sets["count"] = _count_lane_candidates(base["count"])
    return sets


def _measure_candidate_set(rows: list[dict[str, Any]], field: str, candidates: list[dict[str, Any]], reader: Any,
                           numeric_parameters: dict[str, Any]) -> list[dict[str, Any]]:
    results = []
    for candidate in candidates:
        lane = candidate["lane"]
        observed = []
        for row in rows:
            crop, geometry = _lane_crop(row["rowCrop"], lane)
            if crop is None:
                observed.append({"geometryValid": False, "rawText": None, "ocrScore": None,
                                 "visual": None, "strictInteger": None, "status": "GEOMETRY_ABSTAIN"})
                continue
            visual = _visual_evidence(crop, field, numeric_parameters, lane)
            try:
                ocr = recognize_one(reader, crop)
                raw = ocr["rawText"]
                status = "OCR_CANDIDATE" if raw else "EMPTY_OCR"
                score = ocr["ocrScore"]
            except Exception as error:  # preserve a per-crop error; never replace with guessed content
                raw, score, status = None, None, "OCR_ERROR"
            integer, integer_status = _strict_integer(raw) if field in NUMERIC_FIELDS else (None, None)
            observed.append({"geometryValid": geometry["valid"], "rawText": raw, "ocrScore": score,
                             "visual": visual, "strictInteger": integer, "numericStatus": integer_status,
                             "status": status})
        valid = [item for item in observed if item["geometryValid"]]
        nonempty = sum(item["rawText"] not in (None, "") for item in valid)
        visual = [item["visual"] for item in valid]
        count_contacts = [item["visual"]["plausibleTokenBoundaryContact"] for item in valid
                          if item["visual"] and item["visual"]["plausibleTokenBoundaryContact"] is not None]
        results.append({
            "candidateId": candidate["candidateId"], "lane": lane,
            "rowsTotal": len(rows), "geometryValid": len(valid), "ocrNonEmpty": nonempty,
            "ocrNonEmptyRate": nonempty / len(valid) if valid else 0.0,
            "rightEdgeForegroundPixels": sum(item["edgeForegroundPixels"]["right"] for item in visual),
            "rightEdgeForegroundRatioMean": statistics.mean(item["rightEdgeForegroundRatio"] for item in visual) if visual else 0.0,
            "bottomBandForegroundRatioMean": statistics.mean(item["bottomBandForegroundRatio"] for item in visual) if visual else 0.0,
            "fromItemNameLineForegroundPixels": sum(item["fromItemNameLineForegroundPixels"] or 0 for item in visual),
            "foregroundRetentionAgainstBase": None,
            "plausibleTokenBoundaryContactCount": sum(any(sides.values()) for sides in count_contacts),
            "strictIntegerRawCandidate": sum(item["strictInteger"] is not None for item in observed),
            "ocrErrors": sum(item["status"] == "OCR_ERROR" for item in observed),
            "observations": observed,
        })
    base_pixels = results[0]["rightEdgeForegroundPixels"] if results else 0
    base_foreground = sum(item["visual"]["foregroundPixels"] for item in results[0]["observations"] if item["visual"]) if results else 0
    base_name_line = sum(item["visual"]["fromItemNameLineForegroundPixels"] or 0
                         for item in results[0]["observations"] if item["visual"]) if results else 0
    for result in results:
        result["foregroundRetentionAgainstBase"] = (
            sum(item["visual"]["foregroundPixels"] for item in result["observations"] if item["visual"]) / base_foreground
            if base_foreground else None)
        result["rightEdgeReductionAgainstBase"] = (base_pixels - result["rightEdgeForegroundPixels"])
        result["fromItemNameLineForegroundRetentionAgainstBase"] = (
            result["fromItemNameLineForegroundPixels"] / base_name_line if base_name_line else None)
    return results


def _select_candidate(field: str, measured: list[dict[str, Any]]) -> dict[str, Any]:
    if not measured:
        raise ValueError(f"no candidate measurements for {field}")
    baseline = measured[0]
    eligible = [entry for entry in measured if entry["geometryValid"] == entry["rowsTotal"]
                and entry["ocrNonEmptyRate"] >= baseline["ocrNonEmptyRate"] * .8]
    if not eligible:
        return baseline
    if field in ("island", "toItem"):
        eligible = [entry for entry in eligible if (entry["foregroundRetentionAgainstBase"] or 0) >= .80]
        return min(eligible or [baseline], key=lambda entry: (entry["rightEdgeForegroundPixels"],
                                                -entry["foregroundRetentionAgainstBase"],
                                                entry["candidateId"]))
    if field == "fromItem":
        eligible = [entry for entry in eligible if (entry["fromItemNameLineForegroundRetentionAgainstBase"] or 0) >= .95]
        return min(eligible or [baseline], key=lambda entry: (entry["bottomBandForegroundRatioMean"],
                                                -entry["foregroundRetentionAgainstBase"],
                                                entry["candidateId"]))
    return min(eligible, key=lambda entry: (entry["plausibleTokenBoundaryContactCount"],
                                            -entry["strictIntegerRawCandidate"],
                                            -entry["foregroundRetentionAgainstBase"],
                                            entry["candidateId"]))


def measure_geometry_candidates(captures: list[dict[str, Any]], base_lanes: dict[str, dict[str, float]],
                                row_parameters: dict[str, Any], numeric_parameters: dict[str, Any],
                                reader: Any) -> dict[str, Any]:
    """Measure finite image/OCR-only candidates; signature deliberately excludes oracle inputs."""
    rows, capture_evidence = _row_records(captures, row_parameters)
    sets = _candidate_sets(base_lanes)
    measurements = {field: _measure_candidate_set(rows, field, candidates, reader, numeric_parameters)
                    for field, candidates in sets.items()}
    selections = {field: _select_candidate(field, values) for field, values in measurements.items()}
    lanes = {field: dict(base_lanes[field]) for field in FIELDS}
    for field, selected in selections.items():
        lanes[field] = dict(selected["lane"])
    return {"rows": rows, "captureEvidence": capture_evidence, "candidateSets": sets,
            "candidateMeasurements": measurements, "selected": selections, "selectedLanes": lanes}


def _field_record(field: str, crop: Image.Image | None, geometry: dict[str, Any], row_clipped: bool,
                  numeric_parameters: dict[str, Any], reader: Any) -> dict[str, Any]:
    if crop is None or not geometry.get("valid"):
        return {"rawText": None, "normalizedText": None, "ocrScore": None, "rawNumericCandidate": None,
                "value": None, "status": "GEOMETRY_ABSTAIN", "cropHash": None,
                "readerEvidence": {"geometry": geometry}, "reasonCodes": ["LANE_INVALID"]}
    visual = _visual_evidence(crop, field, numeric_parameters, geometry.get("box"))
    boundary = {"top": False, "bottom": False}
    output = None
    error_type = None
    try:
        output = recognize_one(reader, crop)
        raw, score = output.get("rawText"), output.get("ocrScore")
    except Exception as error:
        raw, score, error_type = None, None, type(error).__name__
    parse, parse_status = _strict_integer(raw) if field in NUMERIC_FIELDS else (None, None)
    if error_type:
        status, reasons = "OCR_ERROR", ["OCR_INFERENCE_ERROR"]
    elif field in NUMERIC_FIELDS:
        numeric = infer_trade_numeric_field_v2(crop, field, boundary,
                                               {"componentPlausibility": numeric_parameters})
        contact = numeric["readerEvidence"]["plausibleTokenBoundaryContact"]
        if row_clipped or any(contact.values()):
            status, reasons = "FIELD_CLIPPED", ["ROW_BOUNDARY_CONTACT" if row_clipped else "TOKEN_BOUNDARY_CONTACT"]
        elif raw in (None, ""):
            status, reasons = ("OCR_ERROR", ["OCR_OUTPUT_NULL"]) if raw is None else ("EMPTY_OCR", ["OCR_EMPTY"])
        elif parse is not None:
            status, reasons = "NUMERIC_OCR_CANDIDATE", ["STRICT_ASCII_INTEGER_TOKEN"]
        else:
            status, reasons = "UNREADABLE", [parse_status]
    elif row_clipped:
        status, reasons = "FIELD_CLIPPED", ["ROW_BOUNDARY_CONTACT"]
    elif raw in (None, ""):
        status, reasons = ("OCR_ERROR", ["OCR_OUTPUT_NULL"]) if raw is None else ("EMPTY_OCR", ["OCR_EMPTY"])
    else:
        status, reasons = "RAW_OCR_CANDIDATE", ["RAW_TEXT_UNVERIFIED"]
    reader_evidence: dict[str, Any] = {
        "readerId": "paddle-korean-ppocrv5-mobile-onnx-cpu-v1", "geometry": geometry,
        "visual": visual, "normalization": "Unicode NFKC and outer whitespace trim; rawText preserved",
        "candidateStatusOnly": True,
    }
    if field in NUMERIC_FIELDS:
        numeric = infer_trade_numeric_field_v2(crop, field, boundary,
                                               {"componentPlausibility": numeric_parameters})
        reader_evidence["numericStructure"] = numeric["readerEvidence"]
        reader_evidence["rawNumericParseEvidence"] = {"strictAsciiInteger": parse is not None,
                                                        "parseStatus": parse_status,
                                                        "observedCountRange1To10": (1 <= parse <= 10) if field == "count" and parse is not None else None}
    if error_type:
        reader_evidence["errorType"] = error_type
    return {"rawText": raw, "normalizedText": _normalized_text(raw), "ocrScore": score,
            "rawNumericCandidate": parse, "value": None, "status": status,
            "cropHash": visual["cropHash"], "readerEvidence": reader_evidence, "reasonCodes": reasons}


def _semantic_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{**{key: row[key] for key in ("draftId", "captureId", "batchId", "ordinal", "rowBox", "sourceRefs",
                                          "status", "automationDecision")},
             "fields": {field: {key: value for key, value in record.items() if key != "ocrScore"}
                        for field, record in row["fields"].items()}} for row in rows]


_CONTRACT_ROW_KEYS = ("draftId", "captureId", "batchId", "ordinal", "rowBox", "rowCropHash",
                      "sourceRefs", "status", "automationDecision")
_CONTRACT_FIELD_KEYS = ("rawText", "normalizedText", "rawNumericCandidate", "value", "status",
                        "cropHash", "reasonCodes")
_CONTRACT_NUMERIC_STRUCTURE_KEYS = ("readerId", "tokenBox", "plausibleTokenBoundaryContact",
                                    "rawForegroundBoundaryContact", "rowBoundaryContact")
_CONTRACT_FIELD_METRIC_KEYS = (
    "rowsTotal", "geometryValid", "ocrAttempted", "ocrNonEmpty", "ocrEmpty", "ocrError",
    "boundaryContact", "numericStrictCandidate", "geometryAbstain", "geometryEligible",
    "plausibleTokenBoundaryContact", "strictIntegerRawCandidate", "empty", "invalidToken", "abstain",
    "secondaryLineRiskCount", "bottomBandForegroundHighCount", "rawTextContainsParleyMarkerCount",
)
_CONTRACT_ROW_METRIC_KEYS = (
    "captureCount", "candidateRows", "completeGeometryRows", "clippedRows", "sixFieldDraftRows",
    "rowsWithAllTextRawCandidates", "rowsWithAllNumericRawCandidates", "rowsWithAllSixRawCandidates",
)


def _contract_row(row: dict[str, Any]) -> dict[str, Any]:
    stable = {key: row[key] for key in _CONTRACT_ROW_KEYS if key in row}
    fields: dict[str, Any] = {}
    for field, record in row.get("fields", {}).items():
        stable_field = {key: record[key] for key in _CONTRACT_FIELD_KEYS if key in record}
        evidence = record.get("readerEvidence", {})
        geometry = evidence.get("geometry", {})
        stable_evidence: dict[str, Any] = {}
        if geometry:
            stable_evidence["geometry"] = {key: geometry[key] for key in ("valid", "box", "rowClipped")
                                            if key in geometry}
        if field in NUMERIC_FIELDS:
            if "rawNumericParseEvidence" in evidence:
                stable_evidence["rawNumericParseEvidence"] = evidence["rawNumericParseEvidence"]
            numeric = evidence.get("numericStructure", {})
            stable_evidence["numericStructure"] = {
                key: numeric[key] for key in _CONTRACT_NUMERIC_STRUCTURE_KEYS if key in numeric
            }
        if stable_evidence:
            stable_field["readerEvidence"] = stable_evidence
        fields[field] = stable_field
    stable["fields"] = fields
    return stable


def build_contract_semantic_projection(artifact: dict[str, Any]) -> dict[str, Any]:
    """Project stable recognition semantics; diagnostic visuals and runtime timing are excluded."""
    capture_set = artifact.get("captureSet", {})
    captures = capture_set.get("captures", [])
    capture_identity_keys = ("captureId", "batchId", "captureOrdinal", "imageHash", "rowCount")
    row_detector = artifact.get("rowDetector", {})
    field_geometry = artifact.get("fieldGeometry", {})
    runtime = artifact.get("ocrRuntime", {})
    metrics = artifact.get("metrics", {})
    determinism = artifact.get("determinism", {})
    return {
        "task": artifact.get("task"),
        "status": artifact.get("status"),
        "captureSet": {
            "captureCount": capture_set.get("captureCount"),
            "captureSetSha256": capture_set.get("captureSetSha256"),
            "rowDetector": capture_set.get("rowDetector"),
            "captures": [{key: item[key] for key in capture_identity_keys if key in item} for item in captures],
        },
        "batchContract": artifact.get("batchContract", {}),
        "rowDetector": {key: row_detector[key] for key in (
            "id", "parameters", "oracleUsed", "rowCountIsOptimizationTarget", "frozenRowCountRegression"
        ) if key in row_detector},
        "fieldGeometry": {key: field_geometry[key] for key in (
            "selectedFieldLanes", "numericReader", "frozenLaneSources", "numericGeometrySource", "selectedCandidates"
        ) if key in field_geometry},
        "ocrRuntime": {key: runtime[key] for key in (
            "framework", "package", "model", "engine", "onnxruntime", "device", "modelHash",
            "remoteOcrRequests", "externalImageUpload"
        ) if key in runtime},
        "draftRows": [_contract_row(row) for row in artifact.get("draftRows", [])],
        "metrics": {
            "rows": {key: metrics.get("rows", {})[key] for key in _CONTRACT_ROW_METRIC_KEYS
                     if key in metrics.get("rows", {})},
            "fields": {field: {key: metrics.get("fields", {}).get(field, {})[key]
                                for key in _CONTRACT_FIELD_METRIC_KEYS
                                if key in metrics.get("fields", {}).get(field, {})}
                       for field in FIELDS if field in metrics.get("fields", {})},
        },
        "determinism": {key: determinism[key] for key in (
            "runs", "semanticDeterminism", "rawScoreDeterminism", "semanticFieldsCompared"
        ) if key in determinism},
        "oracleMapping": artifact.get("oracleMapping", {}),
        "approval": artifact.get("approval", {}),
    }


def contract_semantic_hash(artifact: dict[str, Any]) -> str:
    """Hash stable recognition contract fields, independent of diagnostic visuals/timing."""
    return canonical_hash(build_contract_semantic_projection(artifact))


def _legacy_semantic_hash(artifact: dict[str, Any]) -> str:
    """Preserve the historical full-representation semanticHash payload and field ordering."""
    keys = ("task", "baseCommit", "batchId", "captureSet", "batchContract", "rowDetector",
            "fieldGeometry", "ocrRuntime", "draftRows", "metrics", "determinism", "oracleMapping", "approval")
    legacy = {key: artifact[key] for key in keys}
    if "contractSemanticRunHashes" in legacy["determinism"]:
        legacy["determinism"] = {key: value for key, value in legacy["determinism"].items()
                                  if key != "contractSemanticRunHashes"}
    return canonical_hash(legacy)


def _model_hashes(model_dir: Path) -> dict[str, Any]:
    names = ("inference.onnx", "inference.yml")
    files = {name: sha256_file(model_dir / name) for name in names}
    logical = canonical_hash([{"path": name, "sha256": files[name]} for name in sorted(files)])
    return {"files": files, "logicalBundleSha256": logical}


def _build_drafts_from_detected_rows(detected_rows: list[dict[str, Any]],
                                     selected_lanes: dict[str, dict[str, float]],
                                     numeric_parameters: dict[str, Any], reader: Any) -> list[dict[str, Any]]:
    drafts: list[dict[str, Any]] = []
    for item in detected_rows:
        lane_boxes, lane_errors = _lane_boxes(item["rowCrop"].width, item["rowCrop"].height, selected_lanes)
        fields: dict[str, Any] = {}
        for field in FIELDS:
            lane = lane_boxes.get(field, {})
            geometry = {"valid": bool(lane.get("valid")), "box": lane.get("box", {}).get("normalized"),
                        "laneErrors": lane_errors, "rowClipped": item["clipped"]}
            crop = None
            if lane.get("valid"):
                box = lane["box"]
                crop = item["rowCrop"].crop((box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]))
            fields[field] = _field_record(field, crop, geometry, item["clipped"], numeric_parameters, reader)
        capture_id = item["capture"]["captureId"]
        refs = [{"captureId": capture_id, "captureOrdinal": item["captureOrdinal"],
                 "rowOrdinal": item["rowOrdinal"], "rowCropHash": item["rowCropHash"],
                 "rowBox": item["rowBox"]}]
        drafts.append({"draftId": f"{capture_id}:draft-row-{item['rowOrdinal']:02d}",
                       "captureId": capture_id, "batchId": item["capture"].get("batchId"),
                       "ordinal": len(drafts) + 1, "rowBox": item["rowBox"], "sourceRefs": refs,
                       "rowCropHash": item["rowCropHash"], "fields": fields,
                       "status": "DRAFT_UNVERIFIED", "automationDecision": "REVIEW"})
    return drafts


def build_batch_drafts_once(captures: list[dict[str, Any]],
                            selected_lanes: dict[str, dict[str, float]],
                            row_parameters: dict[str, Any],
                            numeric_parameters: dict[str, Any], reader: Any) -> dict[str, Any]:
    """Run selected-geometry row and six-field reading once, without sweeps or oracle input."""
    detected_rows, capture_evidence = _row_records(captures, row_parameters)
    return {"captureEvidence": capture_evidence,
            "draftRows": _build_drafts_from_detected_rows(detected_rows, selected_lanes,
                                                            numeric_parameters, reader)}


def run_batch(captures: list[dict[str, Any]], selected_lanes: dict[str, dict[str, float]],
              row_parameters: dict[str, Any], numeric_parameters: dict[str, Any], reader: Any,
              base_commit: str, capture_evidence: list[dict[str, Any]] | None = None,
              runs: int = 10, model_hashes: dict[str, Any] | None = None) -> dict[str, Any]:
    """Create raw six-field drafts. No catalog or oracle parameter is accepted."""
    if runs != 10:
        raise ValueError("T010P3A determinism requires exactly 10 semantic runs")
    detected_rows, detected_captures = _row_records(captures, row_parameters)
    drafts = _build_drafts_from_detected_rows(detected_rows, selected_lanes, numeric_parameters, reader)
    semantic_signature = canonical_hash(_semantic_rows(drafts))
    repeated_signatures = [semantic_signature]
    repeated_contract_signatures = [canonical_hash([_contract_row(row) for row in drafts])]
    repeated_score_hashes = [canonical_hash([[row["fields"][field]["ocrScore"] for field in FIELDS]
                                             for row in drafts])]
    # The initial drafts are run 1; repeat the exact selected crops 9 more times.
    for _ in range(1, runs):
        repeat_rows = _build_drafts_from_detected_rows(detected_rows, selected_lanes, numeric_parameters, reader)
        repeated_signatures.append(canonical_hash(_semantic_rows(repeat_rows)))
        repeated_contract_signatures.append(canonical_hash([_contract_row(row) for row in repeat_rows]))
        repeated_score_hashes.append(canonical_hash([[row["fields"][field]["ocrScore"] for field in FIELDS]
                                                     for row in repeat_rows]))
    field_metrics = {}
    for field in FIELDS:
        records = [row["fields"][field] for row in drafts]
        statuses = Counter(record["status"] for record in records)
        field_metrics[field] = {
            "rowsTotal": len(records), "geometryValid": sum(record["readerEvidence"].get("geometry", {}).get("valid", False) for record in records),
            "ocrAttempted": sum(record["status"] not in ("GEOMETRY_ABSTAIN",) for record in records),
            "ocrNonEmpty": sum(record["rawText"] not in (None, "") for record in records),
            "ocrEmpty": statuses["EMPTY_OCR"], "ocrError": statuses["OCR_ERROR"],
            "boundaryContact": sum(record["status"] == "FIELD_CLIPPED" for record in records),
            "contaminationSuspected": sum(
                record["readerEvidence"].get("visual", {}).get(
                    "bottomBandWarmForegroundRatio" if field == "fromItem" else "bottomBandForegroundRatio", 0)
                > (.02 if field == "fromItem" else .15) for record in records),
            "numericStrictCandidate": sum(record["rawNumericCandidate"] is not None for record in records),
            "geometryAbstain": statuses["GEOMETRY_ABSTAIN"],
        }
    from_metrics = field_metrics["fromItem"]
    from_metrics.update({
        "secondaryLineRiskCount": sum(record["readerEvidence"].get("visual", {}).get("bottomBandWarmForegroundRatio", 0) > .02 for record in [row["fields"]["fromItem"] for row in drafts]),
        "bottomBandForegroundHighCount": sum(record["readerEvidence"].get("visual", {}).get("bottomBandWarmForegroundRatio", 0) > .10 for record in [row["fields"]["fromItem"] for row in drafts]),
        "rawTextContainsParleyMarkerCount": sum("교섭력" in (row["fields"]["fromItem"]["rawText"] or "") for row in drafts),
    })
    count_records = [row["fields"]["count"] for row in drafts]
    field_metrics["count"].update({
        "geometryEligible": field_metrics["count"]["geometryValid"],
        "plausibleTokenBoundaryContact": sum(any(record["readerEvidence"].get("numericStructure", {}).get("plausibleTokenBoundaryContact", {}).values()) for record in count_records),
        "strictIntegerRawCandidate": sum(record["rawNumericCandidate"] is not None for record in count_records),
        "empty": sum(record["status"] == "EMPTY_OCR" for record in count_records),
        "invalidToken": sum(record["status"] == "UNREADABLE" for record in count_records),
        "abstain": sum(record["status"] == "GEOMETRY_ABSTAIN" for record in count_records),
    })
    complete_geometry = sum(all(row["fields"][field]["status"] != "GEOMETRY_ABSTAIN" for field in FIELDS) for row in drafts)
    clipped_rows = sum(any(row["fields"][field]["status"] == "FIELD_CLIPPED" for field in FIELDS) for row in drafts)
    all_text = sum(all(row["fields"][field]["rawText"] not in (None, "") for field in TEXT_FIELDS) for row in drafts)
    all_numeric = sum(all(row["fields"][field]["rawNumericCandidate"] is not None for field in NUMERIC_FIELDS) for row in drafts)
    all_six = sum(all(row["fields"][field]["rawText"] not in (None, "") and
                       (field in TEXT_FIELDS or row["fields"][field]["rawNumericCandidate"] is not None) for field in FIELDS) for row in drafts)
    score_determinism = len(set(repeated_score_hashes)) == 1
    semantic_determinism = len(set(repeated_signatures)) == 1
    if not semantic_determinism:
        raise RuntimeError("10-run selected-geometry semantic output changed")
    if len(set(repeated_contract_signatures)) != 1:
        raise RuntimeError("10-run stable contract output changed")
    metrics = {"fields": field_metrics,
               "rows": {"captureCount": len(captures), "candidateRows": len(drafts),
                        "completeGeometryRows": complete_geometry, "clippedRows": clipped_rows,
                        "sixFieldDraftRows": sum(len(row["fields"]) == 6 for row in drafts),
                        "rowsWithAllTextRawCandidates": all_text,
                        "rowsWithAllNumericRawCandidates": all_numeric,
                        "rowsWithAllSixRawCandidates": all_six}}
    capture_set = capture_evidence if capture_evidence is not None else detected_captures
    capture_hash = canonical_hash([{key: item[key] for key in ("captureId", "batchId", "captureOrdinal", "imageHash", "rowCount") if key in item} for item in capture_set])
    count_clip_fraction = (field_metrics["count"]["plausibleTokenBoundaryContact"] / len(count_records)
                           if count_records else 1.0)
    status = ("T010P3A_BLOCKED_REQUIRES_SOL" if len(drafts) != 80 or count_clip_fraction > .5
              else "T010P3A_LOCAL_BATCH_DRAFT_READY_FOR_SOL_REVIEW")
    result = {
        "version": 1, "task": "T010P3A", "status": status, "baseCommit": base_commit,
        "batchId": (next(iter({capture.get("batchId") for capture in captures}))
                    if len({capture.get("batchId") for capture in captures}) == 1 else None),
        "captureSet": {"captureCount": len(captures), "captures": capture_set, "captureSetSha256": capture_hash,
                       "rowDetector": ROW_DETECTOR},
        "batchContract": {"fieldOrder": list(FIELDS), "fieldKeys": list(FIELDS),
                           "fieldSemantics": {"count": "remainingExchangeCount"}, "canonicalValue": None,
                           "rowStatus": "DRAFT_UNVERIFIED", "automationDecision": "REVIEW"},
        "rowDetector": {"id": ROW_DETECTOR, "parameters": row_parameters,
                        "oracleUsed": False, "rowCountIsOptimizationTarget": False},
        "fieldGeometry": {"selectedFieldLanes": selected_lanes, "numericReader": "connected-component-token-structure-v2",
                          "frozenLaneSources": {"reqAmount": "T010A2_FROZEN", "yield": "T010A2_FROZEN"},
                          "numericGeometrySource": "T010A2 frozen reqAmount/yield lanes; count selected finite P3A crop"},
        "ocrRuntime": {"framework": "PaddleOCR", "package": "paddleocr==3.7.0", "model": MODEL_NAME,
                       "engine": "onnxruntime", "onnxruntime": "1.30.0", "device": "cpu",
                       "modelHash": model_hashes, "remoteOcrRequests": 0, "externalImageUpload": False},
        "draftRows": drafts, "metrics": metrics,
        "determinism": {"runs": runs, "semanticDeterminism": semantic_determinism,
                        "semanticRunHashes": repeated_signatures, "rawScoreDeterminism": score_determinism,
                        "semanticFieldsCompared": ["rowBoxes", "cropHashes", "rawText", "normalizedText",
                                                    "rawNumericCandidate", "fieldStatus", "reasonCodes", "rowOrdering"]},
        "oracleMapping": {"oracleMappingStatus": "UNRESOLVED", "oracleRowCount": 80, "mappedOracleRows": 0,
                          "fieldAccuracy": None, "rowAccuracy": None, "fullListExact": None},
        "approval": {"approved": False, "production": False, "engineSelectedForProduction": False,
                     "importerIntegration": False, "HIGH": 0, "automationDecision": "REVIEW"},
        "limitations": ["Raw OCR and geometry candidates are unverified; screenshot-row to oracle mapping remains unresolved.",
                        "No cross-capture fuzzy merge, canonicalization, defaults, importer, API, frontend, session or database access."],
    }
    result["semanticHash"] = _legacy_semantic_hash(result)
    result["determinism"]["contractSemanticRunHashes"] = repeated_contract_signatures
    result["contractSemanticHash"] = contract_semantic_hash(result)
    return result


def _data_uri(crop: Image.Image) -> str:
    import base64
    from io import BytesIO
    buffer = BytesIO()
    crop.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def write_contact_sheet(path: Path, rows: list[dict[str, Any]], selected: dict[str, dict[str, float]],
                        base_lanes: dict[str, dict[str, float]], numeric_parameters: dict[str, Any], reader: Any) -> dict[str, Any]:
    parts = ["<!doctype html><meta charset='utf-8'><title>T010P3A local crop comparison</title>",
             "<style>body{font:14px sans-serif;background:#181a1b;color:#eee}section{border:1px solid #666;margin:1rem;padding:.7rem}article{display:inline-block;vertical-align:top;width:23%;min-width:260px;margin:.5rem;background:#26292b;padding:.5rem}img{max-width:100%;image-rendering:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>"]
    comparison = {field: {side: [] for side in ("baseline", "selected")}
                  for field in ("island", "fromItem", "toItem", "count")}
    for row in rows:
        parts.append(f"<section><h2>{html.escape(row['capture']['captureId'])} · row {row['rowOrdinal']}</h2>")
        for field in ("island", "fromItem", "toItem", "count"):
            before, old_geometry = _lane_crop(row["rowCrop"], base_lanes[field])
            after, new_geometry = _lane_crop(row["rowCrop"], selected[field])
            if before is None or after is None:
                continue
            try:
                old_ocr = recognize_one(reader, before)
                new_ocr = recognize_one(reader, after)
            except Exception as error:
                old_ocr = new_ocr = {"rawText": f"OCR_ERROR:{type(error).__name__}", "ocrScore": None}
            old_ev, new_ev = (_visual_evidence(before, field, numeric_parameters, base_lanes[field]),
                              _visual_evidence(after, field, numeric_parameters, selected[field]))
            for side, output, visual in (("baseline", old_ocr, old_ev), ("selected", new_ocr, new_ev)):
                numeric, _parse_status = _strict_integer(output.get("rawText")) if field == "count" else (None, None)
                plausible = visual.get("plausibleTokenBoundaryContact")
                comparison[field][side].append({
                    "ocrNonEmpty": output.get("rawText") not in (None, ""),
                    "rightEdgeForegroundPixels": visual["edgeForegroundPixels"]["right"],
                    "rightEdgeForegroundRatio": visual["rightEdgeForegroundRatio"],
                    "foregroundPixels": visual["foregroundPixels"],
                    "bottomBandForegroundRatio": visual["bottomBandForegroundRatio"],
                    "bottomBandWarmForegroundRatio": visual["bottomBandWarmForegroundRatio"],
                    "secondaryLineRisk": visual.get("fromItemSecondaryLineRisk", False),
                    "parleyMarker": "교섭력" in (output.get("rawText") or ""),
                    "plausibleTokenBoundaryContact": bool(plausible and any(plausible.values())),
                    "strictInteger": numeric is not None,
                })
            parts.append(f"<article><h3>{field}</h3><b>old</b><img src='{_data_uri(before)}'><pre>{html.escape(json.dumps(old_ocr,ensure_ascii=False))}\n{html.escape(json.dumps(old_ev,ensure_ascii=False))}</pre><b>selected</b><img src='{_data_uri(after)}'><pre>{html.escape(json.dumps(new_ocr,ensure_ascii=False))}\n{html.escape(json.dumps(new_ev,ensure_ascii=False))}</pre></article>")
        parts.append("</section>")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(parts), encoding="utf-8")
    summaries = {}
    for field, sides in comparison.items():
        summaries[field] = {}
        for side, values in sides.items():
            count = len(values)
            summaries[field][side] = {
                "rowsTotal": count,
                "ocrNonEmpty": sum(item["ocrNonEmpty"] for item in values),
                "rightEdgeForegroundPixels": sum(item["rightEdgeForegroundPixels"] for item in values),
                "rightEdgeForegroundRatioMean": statistics.mean(item["rightEdgeForegroundRatio"] for item in values) if values else 0.0,
                "foregroundPixels": sum(item["foregroundPixels"] for item in values),
                "bottomBandForegroundHighCount": sum(item["bottomBandForegroundRatio"] > .10 for item in values),
                "secondaryLineRiskCount": sum(bool(item["secondaryLineRisk"]) for item in values),
                "rawTextContainsParleyMarkerCount": sum(item["parleyMarker"] for item in values),
                "plausibleTokenBoundaryContactCount": sum(item["plausibleTokenBoundaryContact"] for item in values),
                "strictIntegerRawCandidate": sum(item["strictInteger"] for item in values),
            }
    return summaries


def load_archive_captures(manifest_path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Extract only capture/image metadata. Oracle keys are never loaded into inference inputs."""
    manifest = _json(manifest_path)
    capture_records = manifest.get("trade", {}).get("captures", [])
    captures = []
    for item in capture_records:
        captures.append({"captureId": item["captureId"], "batchId": item.get("batchId"),
                         "imagePath": str((manifest_path.parent / item["imagePath"]).resolve()),
                         "imageHash": item["imageHash"]})
    return captures, {"count": len(captures), "oracleInputPassed": False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=ROOT / "tests" / "fixtures" / "recognition-v2" / "manifest.json")
    parser.add_argument("--captures-json", type=Path,
                        help="UTF-8 JSON list of {captureId,batchId,imagePath[,imageHash]} records")
    parser.add_argument("--selection", type=Path, default=ROOT / "local_app" / "recognition_data" / "trade-t010p3a-experiment.json")
    parser.add_argument("--t010a2-artifact", type=Path, default=ROOT / "recognition-local" / "results" / "trade-candidate-t010a2.json")
    parser.add_argument("--t010a2-selection", type=Path, default=ROOT / "local_app" / "recognition_data" / "trade-t010a2-experiment.json")
    parser.add_argument("--row-selection", type=Path, default=ROOT / "local_app" / "recognition_data" / "trade-t010a-experiment.json")
    parser.add_argument("--model-dir", type=Path, default=ROOT / "recognition-local" / "models" / "t010b1" / "official_models" / f"{MODEL_NAME}_onnx")
    parser.add_argument("--out", type=Path, default=ROOT / "recognition-local" / "results" / "trade-batch-draft-t010p3a.json")
    parser.add_argument("--contact-sheet", type=Path, default=ROOT / "recognition-local" / "results" / "t010p3a-contact-sheet.html")
    parser.add_argument("--measure-only", action="store_true")
    parser.add_argument("--skip-selection", action="store_true")
    parser.add_argument("--contact-sheet-only", action="store_true",
                        help="refresh local visual comparison/metrics without repeating 10-run batch inference")
    args = parser.parse_args()
    selection, t010a2 = _json(args.selection), _json(args.t010a2_artifact)
    row_selection, numeric_selection = _json(args.row_selection), _json(args.t010a2_selection)
    if selection.get("task") != "T010P3A" or selection.get("oracleUsed") is not False:
        raise ValueError("T010P3A selection invalid or oracle-enabled")
    if t010a2.get("semanticHash") != "28c7233d5cfddc62a9bdbf8a27acd7feb15878d200b463286d85ea97b01bb925":
        raise ValueError("T010A2 verified artifact semantic hash mismatch")
    if t010a2.get("sourceT010AHash") != selection.get("frozenSources", {}).get("t010aSemanticHash"):
        raise ValueError("T010A2 artifact source provenance mismatch")
    lanes = {field: dict(value) for field, value in row_selection["parameters"]["lanes"].items()}
    numeric_lanes = t010a2["selectedExperimentLaneCandidate"]["laneDefinitions"]
    for field in NUMERIC_FIELDS:
        lanes[field] = dict(numeric_lanes[field])
    numeric_parameters = numeric_selection["componentPlausibility"]
    if args.captures_json:
        supplied = _json(args.captures_json)
        if not isinstance(supplied, list) or any(not isinstance(item, dict) for item in supplied):
            raise ValueError("--captures-json must be a list of capture metadata objects")
        captures = [{"captureId": item["captureId"], "batchId": item.get("batchId"),
                     "imagePath": str((args.captures_json.parent / item["imagePath"]).resolve()),
                     "imageHash": item.get("imageHash")} for item in supplied]
    else:
        captures, _capture_origin = load_archive_captures(args.manifest)
    reader, init_ms = _load_reader(args.model_dir)
    measurements = None
    if not args.skip_selection and not args.contact_sheet_only:
        measurements = measure_geometry_candidates(captures, lanes, row_selection["parameters"], numeric_parameters, reader)
        selection["fieldCandidateMeasurements"] = {
            field: [{key: value for key, value in item.items() if key != "observations"} for item in values]
            for field, values in measurements["candidateMeasurements"].items()}
        selection["selectedFieldLanes"] = {
            field: {"selectedCandidate": measurements["selected"][field]["candidateId"],
                    "lane": measurements["selectedLanes"][field], "approval": "NOT_PRODUCTION_APPROVED"}
            for field in measurements["selected"]}
        selection["selectedFieldLanes"]["reqAmount"] = {"source": "T010A2_FROZEN", "lane": lanes["reqAmount"], "approval": "NOT_PRODUCTION_APPROVED"}
        selection["selectedFieldLanes"]["yield"] = {"source": "T010A2_FROZEN", "lane": lanes["yield"], "approval": "NOT_PRODUCTION_APPROVED"}
        selection["selectionBasis"] = "finite image structure and raw OCR nonempty evidence only; catalog/oracle/human-label values unused"
        args.selection.write_text(json.dumps(selection, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    selected = {field: dict(value["lane"] if "lane" in value else value) for field, value in selection["selectedFieldLanes"].items()}
    for field in NUMERIC_FIELDS:
        if selected.get(field, {}).get("source") == "T010A2_FROZEN":
            selected[field] = dict(selected[field]["lane"])
    if args.measure_only:
        summary = {field: [{key: value for key, value in item.items() if key != "observations"} for item in values]
                   for field, values in (measurements or {}).get("candidateMeasurements", {}).items()}
        print(json.dumps({"candidateMeasurements": summary,
                          "selected": {key: value.get("selectedCandidate") for key, value in selection["selectedFieldLanes"].items()}}, ensure_ascii=False, indent=2))
        return 0
    rows, capture_evidence = _row_records(captures, row_selection["parameters"])
    if args.contact_sheet_only:
        comparison = write_contact_sheet(args.contact_sheet, rows, selected, lanes, numeric_parameters, reader)
        artifact = _json(args.out)
        artifact["batchContract"]["fieldSemantics"] = {"count": "remainingExchangeCount"}
        artifact["fieldGeometry"]["frozenLaneSources"] = {"reqAmount": "T010A2_FROZEN", "yield": "T010A2_FROZEN"}
        artifact["fieldGeometry"]["numericGeometrySource"] = "T010A2 frozen reqAmount/yield lanes; count selected finite P3A crop"
        artifact["fieldGeometry"]["comparisonMetrics"] = comparison
        from_comparison = comparison.get("fromItem", {}).get("selected", {})
        artifact["metrics"]["fields"]["fromItem"]["secondaryLineRiskCount"] = from_comparison.get("secondaryLineRiskCount", 0)
        artifact["metrics"]["fields"]["fromItem"]["bottomBandForegroundHighCount"] = from_comparison.get("bottomBandForegroundHighCount", 0)
        artifact["metrics"]["fields"]["fromItem"]["contaminationSuspected"] = from_comparison.get("secondaryLineRiskCount", 0)
        artifact["metrics"]["fields"]["fromItem"]["rawTextContainsParleyMarkerCount"] = from_comparison.get("rawTextContainsParleyMarkerCount", 0)
        artifact["semanticHash"] = _legacy_semantic_hash(artifact)
        artifact["contractSemanticHash"] = contract_semantic_hash(artifact)
        args.out.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"semanticHash": artifact["semanticHash"], "comparisonMetrics": comparison,
                          "contactSheet": str(args.contact_sheet)}, ensure_ascii=False, indent=2))
        return 0
    base_commit = selection["baseCommit"]
    artifact = run_batch(captures, selected, row_selection["parameters"], numeric_parameters, reader,
                         base_commit, capture_evidence, runs=10, model_hashes=_model_hashes(args.model_dir))
    measured = selection.get("fieldCandidateMeasurements", {})
    artifact["fieldGeometry"]["candidateMeasurements"] = {
        field: [{key: value for key, value in candidate.items() if key != "observations"}
                for candidate in candidates]
        for field, candidates in measured.items()}
    artifact["fieldGeometry"]["selectedCandidates"] = {
        field: value.get("selectedCandidate") for field, value in selection.get("selectedFieldLanes", {}).items()}
    frozen_counts = numeric_selection.get("frozenObservedRowsPerCapture", [])
    observed_counts = [item["rowCount"] for item in capture_evidence]
    artifact["rowDetector"]["frozenRowCountRegression"] = {
        "expectedPerCapture": frozen_counts, "observedPerCapture": observed_counts,
        "matched": observed_counts == frozen_counts and sum(observed_counts) == 80}
    if not artifact["rowDetector"]["frozenRowCountRegression"]["matched"]:
        artifact["status"] = "T010P3A_BLOCKED_REQUIRES_SOL"
    artifact["semanticHash"] = _legacy_semantic_hash(artifact)
    artifact["ocrRuntime"]["initializationMs"] = round(init_ms, 3)
    comparison = write_contact_sheet(args.contact_sheet, rows, selected, lanes, numeric_parameters, reader)
    artifact["fieldGeometry"]["comparisonMetrics"] = comparison
    from_comparison = comparison.get("fromItem", {}).get("selected", {})
    artifact["metrics"]["fields"]["fromItem"]["secondaryLineRiskCount"] = from_comparison.get("secondaryLineRiskCount", 0)
    artifact["metrics"]["fields"]["fromItem"]["bottomBandForegroundHighCount"] = from_comparison.get("bottomBandForegroundHighCount", 0)
    artifact["metrics"]["fields"]["fromItem"]["contaminationSuspected"] = from_comparison.get("secondaryLineRiskCount", 0)
    artifact["metrics"]["fields"]["fromItem"]["rawTextContainsParleyMarkerCount"] = from_comparison.get("rawTextContainsParleyMarkerCount", 0)
    artifact["semanticHash"] = _legacy_semantic_hash(artifact)
    artifact["contractSemanticHash"] = contract_semantic_hash(artifact)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": artifact["status"], "semanticHash": artifact["semanticHash"],
                      "contractSemanticHash": artifact["contractSemanticHash"],
                      "captureCount": artifact["captureSet"]["captureCount"],
                      "metrics": artifact["metrics"], "determinism": artifact["determinism"],
                      "out": str(args.out), "contactSheet": str(args.contact_sheet)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
