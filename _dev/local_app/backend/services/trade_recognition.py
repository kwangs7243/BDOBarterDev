"""Oracle-isolated T010A Trade row, lane, and numeric-structure measurements.

This module deliberately contains no text OCR or catalog decision logic. Numeric
results are structural candidates only and never contain inferred values.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image


FIELDS = ("island", "fromItem", "reqAmount", "toItem", "count", "yield")
TEXT_FIELDS = {"island", "fromItem", "toItem"}
NUMERIC_FIELDS = {"reqAmount", "count", "yield"}


def canonical_hash(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _crop_hash(image: Image.Image) -> str:
    digest = hashlib.sha256()
    digest.update(image.mode.encode("ascii") + b"\0")
    digest.update(f"{image.width}x{image.height}".encode("ascii") + b"\0")
    digest.update(image.tobytes())
    return digest.hexdigest()


def validate_trade_integer(field: str, value: Any) -> bool:
    """Strict domain validator; bool and float are intentionally rejected."""
    if field not in NUMERIC_FIELDS or type(value) is not int:
        return False
    return value >= 0 if field == "count" else value >= 1


def _edge_profile(rgb: np.ndarray, threshold: int) -> np.ndarray:
    delta = np.max(np.abs(np.diff(rgb.astype(np.int16), axis=0)), axis=2)
    return np.mean(delta >= threshold, axis=1, dtype=np.float64)


def _separator_peaks(profile: np.ndarray, support_threshold: float) -> list[int]:
    peaks: list[int] = []
    for index, support in enumerate(profile):
        if support < support_threshold:
            continue
        left = profile[index - 1] if index else -1.0
        right = profile[index + 1] if index + 1 < len(profile) else -1.0
        if support >= left and support >= right:
            peaks.append(index + 1)
    return peaks


def detect_rows(image: Image.Image, parameters: dict[str, Any]) -> list[dict[str, Any]]:
    """Find row candidates by pairing measured repeated separators, no row-count input."""
    rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
    width, height = image.size
    profile = _edge_profile(rgb, int(parameters.get("separatorPixelDelta", 24)))
    threshold = float(parameters.get("separatorSupportThreshold", 0.55))
    min_height = int(parameters.get("rowHeightMin", 55))
    max_height = int(parameters.get("rowHeightMax", 90))
    peaks = _separator_peaks(profile, threshold)
    candidates: list[dict[str, Any]] = []
    cursor = 0
    while cursor + 1 < len(peaks):
        top, bottom = peaks[cursor], peaks[cursor + 1]
        span = bottom - top
        if min_height <= span <= max_height:
            top_support = float(profile[max(0, top - 1)])
            bottom_support = float(profile[max(0, bottom - 1)])
            candidates.append({
                "top": top, "bottom": bottom, "height": span,
                "separatorEvidence": {"topSupport": top_support, "bottomSupport": bottom_support},
                "rawMetric": min(top_support, bottom_support),
                "boundaryContact": {"top": top <= 0, "bottom": bottom >= height},
                "clipped": top <= 0 or bottom >= height,
            })
            cursor += 2
        else:
            cursor += 1
    # A separator touching an image boundary is evidence of a partial candidate,
    # kept separate from complete rows and never counted as a complete row.
    boundary_pairs = []
    if peaks and peaks[0] <= max_height:
        boundary_pairs.append((0, peaks[0], "ROW_CLIPPED_TOP"))
    if peaks and height - peaks[-1] <= max_height:
        boundary_pairs.append((peaks[-1], height, "ROW_CLIPPED_BOTTOM"))
    for top, bottom, reason in boundary_pairs:
        if bottom - top >= 12 and not any(row["top"] == top and row["bottom"] == bottom for row in candidates):
            candidates.append({
                "top": top, "bottom": bottom, "height": bottom - top,
                "separatorEvidence": {"topSupport": None, "bottomSupport": None},
                "rawMetric": None,
                "boundaryContact": {"top": top == 0, "bottom": bottom == height},
                "clipped": True, "reasonCodes": [reason],
            })
    return sorted(candidates, key=lambda row: (row["top"], row["bottom"]))


def _rectangles_overlap(a: dict[str, float], b: dict[str, float]) -> bool:
    return min(a["x1"], b["x1"]) > max(a["x0"], b["x0"]) and min(a["y1"], b["y1"]) > max(a["y0"], b["y0"])


def _lane_boxes(row_width: int, row_height: int, lanes: dict[str, dict[str, float]]) -> tuple[dict[str, dict[str, Any]], list[str]]:
    result: dict[str, dict[str, Any]] = {}
    errors: list[str] = []
    for field in FIELDS:
        ratios = lanes.get(field)
        if not isinstance(ratios, dict):
            errors.append(f"{field}:LANE_MISSING")
            continue
        coords = {key: float(ratios[key]) for key in ("x0", "x1", "y0", "y1")}
        valid = (0 <= coords["x0"] < coords["x1"] <= 1 and 0 <= coords["y0"] < coords["y1"] <= 1)
        box = {
            "x": int(round(coords["x0"] * row_width)),
            "y": int(round(coords["y0"] * row_height)),
            "width": int(round((coords["x1"] - coords["x0"]) * row_width)),
            "height": int(round((coords["y1"] - coords["y0"]) * row_height)),
            "normalized": coords,
        }
        if box["width"] <= 0 or box["height"] <= 0 or box["x"] + box["width"] > row_width or box["y"] + box["height"] > row_height:
            valid = False
        result[field] = {"box": box, "valid": valid}
        if not valid:
            errors.append(f"{field}:LANE_INVALID")
    for index, first in enumerate(FIELDS):
        for second in FIELDS[index + 1:]:
            if result.get(first, {}).get("valid") and result.get(second, {}).get("valid"):
                if _rectangles_overlap(result[first]["box"]["normalized"], result[second]["box"]["normalized"]):
                    errors.append(f"{first}:{second}:LANE_OVERLAP")
                    result[first]["valid"] = result[second]["valid"] = False
    return result, errors


def _components(mask: np.ndarray) -> list[dict[str, int]]:
    """8-connected components, using a bounded flood fill over the field crop."""
    height, width = mask.shape
    seen = np.zeros_like(mask, dtype=np.bool_)
    found: list[dict[str, int]] = []
    ys, xs = np.nonzero(mask)
    for start_y, start_x in zip(ys.tolist(), xs.tolist()):
        if seen[start_y, start_x]:
            continue
        stack = [(start_y, start_x)]
        seen[start_y, start_x] = True
        x0 = x1 = start_x
        y0 = y1 = start_y
        area = 0
        while stack:
            y, x = stack.pop()
            area += 1
            x0, x1 = min(x0, x), max(x1, x)
            y0, y1 = min(y0, y), max(y1, y)
            for ny in range(max(0, y - 1), min(height, y + 2)):
                for nx in range(max(0, x - 1), min(width, x + 2)):
                    if mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
        if area >= 2:
            found.append({"x": x0, "y": y0, "width": x1 - x0 + 1, "height": y1 - y0 + 1, "area": area})
    return sorted(found, key=lambda component: (component["x"], component["y"]))


def _foreground_mask(crop: Image.Image) -> np.ndarray:
    rgb = np.asarray(crop.convert("RGB"), dtype=np.uint8).astype(np.int16)
    maximum = rgb.max(axis=2)
    spread = maximum - rgb.min(axis=2)
    neutral = (maximum >= 150) & (spread <= 80)
    warm = (rgb[:, :, 0] > 140) & (rgb[:, :, 1] > 120) & (rgb[:, :, 2] < 145)
    return neutral | warm


def _numeric_evidence(crop: Image.Image, field: str, boundary_contact: dict[str, bool]) -> dict[str, Any]:
    components = _components(_foreground_mask(crop))
    contacts = {
        "left": any(item["x"] == 0 for item in components),
        "right": any(item["x"] + item["width"] >= crop.width for item in components),
        "top": any(item["y"] == 0 for item in components),
        "bottom": any(item["y"] + item["height"] >= crop.height for item in components),
    }
    clipped = any(contacts.values()) or any(boundary_contact.values())
    min_glyph_height = max(5, int(round(crop.height * 0.2)))
    plausible = [item for item in components if item["height"] >= min_glyph_height
                 and item["width"] <= max(2, crop.width // 2)]
    if clipped:
        status, reasons = "CLIPPED", ["TOKEN_OR_ROW_BOUNDARY_CONTACT"]
    elif not components:
        status, reasons = "MISSING", ["NO_FOREGROUND_COMPONENTS"]
    elif not plausible:
        status, reasons = "UNREADABLE", ["NO_PLAUSIBLE_TOKEN_COMPONENTS"]
    else:
        status, reasons = "UNVERIFIED_NUMERIC_CANDIDATE", ["STRUCTURAL_COMPONENTS_ONLY_NO_DIGIT_READER"]
    token_box = None
    if plausible:
        x0 = min(item["x"] for item in plausible)
        y0 = min(item["y"] for item in plausible)
        x1 = max(item["x"] + item["width"] for item in plausible)
        y1 = max(item["y"] + item["height"] for item in plausible)
        token_box = {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}
    return {
        "rawText": None, "candidates": ([{"kind": "component-token-structure", "value": None}] if status == "UNVERIFIED_NUMERIC_CANDIDATE" else []),
        "value": None, "status": status, "readerEvidence": {
            "readerId": "connected-component-token-structure-v1", "componentCount": len(components),
            "plausibleComponentCount": len(plausible), "components": components,
            "tokenBox": token_box, "boundaryContact": contacts,
            "leftMargin": token_box["x"] if token_box else None,
            "rightMargin": crop.width - (token_box["x"] + token_box["width"]) if token_box else None,
            "reconstructable": False, "numericField": field,
        },
        "cropHash": _crop_hash(crop), "reasonCodes": reasons,
    }


def infer_trade_capture(image_path: str | Path, capture_id: str, parameters: dict[str, Any]) -> dict[str, Any]:
    """Infer solely from one image and geometry parameters; oracle is not accepted."""
    path = Path(image_path)
    source_hash = sha256_file(path)
    with Image.open(path) as source:
        image = source.convert("RGB")
    rows = detect_rows(image, parameters)
    lane_defs = parameters["lanes"]
    row_outputs = []
    counts = {"candidateRows": len(rows), "completeRows": 0, "clippedRows": 0}
    for ordinal, measured in enumerate(rows, 1):
        top, bottom = measured["top"], measured["bottom"]
        row_crop = image.crop((0, top, image.width, bottom))
        clipped = bool(measured["clipped"])
        counts["clippedRows" if clipped else "completeRows"] += 1
        lanes, lane_errors = _lane_boxes(row_crop.width, row_crop.height, lane_defs)
        fields = {}
        for field in FIELDS:
            lane = lanes.get(field, {})
            if not lane.get("valid"):
                fields[field] = {"rawText": None, "candidates": [], "value": None,
                                 "status": "UNREADABLE", "readerEvidence": {"reason": "LANE_INVALID"},
                                 "cropHash": None}
                continue
            box = lane["box"]
            crop = row_crop.crop((box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]))
            if field in TEXT_FIELDS:
                fields[field] = {"rawText": None, "candidates": [], "value": None, "status": "UNREADABLE",
                                 "readerEvidence": {"readerId": None, "reason": "NO_TEXT_READER_IN_T010A"},
                                 "cropHash": _crop_hash(crop)}
            else:
                fields[field] = _numeric_evidence(crop, field, measured["boundaryContact"])
        reason_codes = list(measured.get("reasonCodes", [])) + lane_errors
        row_outputs.append({
            "rowId": f"{capture_id}:candidate-{ordinal}", "ordinal": ordinal,
            "box": {"x": 0, "y": top, "width": image.width, "height": bottom - top,
                    "normalized": {"x0": 0.0, "x1": 1.0, "y0": top / image.height, "y1": bottom / image.height}},
            "clipped": clipped, "fields": fields, "automationDecision": "REVIEW",
            "reasonCodes": reason_codes or (["ROW_CLIPPED"] if clipped else ["TEXT_UNREADABLE_NUMERIC_UNVERIFIED"]),
            "separatorEvidence": measured["separatorEvidence"], "rawMetric": measured["rawMetric"],
            "boundaryContact": measured["boundaryContact"], "laneGeometry": lanes,
            "rowCropHash": _crop_hash(row_crop),
        })
    return {
        "version": 2, "captureId": capture_id, "taskType": "trade",
        "validity": "UNVERIFIED_ARCHIVE_REPLAY", "automationDecision": "REVIEW",
        "layout": {"candidateListRegion": {"x": 0, "y": 0, "width": image.width, "height": image.height},
                   "rowDetector": "repeated-horizontal-separator-pair-v1", "rows": [row["box"] for row in row_outputs]},
        "frame": {"width": image.width, "height": image.height},
        "rows": row_outputs,
        "quality": {"candidateRows": counts["candidateRows"], "completeRows": counts["completeRows"],
                    "clippedRows": counts["clippedRows"], "automationEligible": False},
        "timing": {"status": "MEASURED_AT_BENCHMARK_LEVEL"},
        "engineVersion": "t010a-component-geometry-v1",
        "engineHash": sha256_file(Path(__file__)),
        "parameterHash": canonical_hash(parameters), "catalogHash": None,
        "sourceImageSha256": source_hash, "rowDetection": counts,
    }


def as_list_path(path: str | Path) -> Path:
    return Path(path)
