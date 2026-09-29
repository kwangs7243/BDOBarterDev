"""Unapproved T006B candidate readers; isolated from production APIs and policy."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image


R1_READER_ID = "R1"
Q1_READER_ID = "Q1"
R1_PARAMS: dict[str, Any] = {
    "version": 1,
    "roi": {"referenceCrop": [1, 1, 42, 26], "t005a1IconRegion": "icon"},
    "resizeKernel": "lanczos",
    "grayscale": "Pillow-L",
    "ncc": "mean-centered dot / l2 norms; epsilon=1e-12",
    "brightnessNormalization": "per-image mean-center and variance-normalize within item ROI",
    "colorEvidence": "RGB mean-absolute and RMS distance divided by 255",
    "ranking": "grayscale-NCC descending; color is separate evidence only",
}
Q1_PARAMS: dict[str, Any] = {
    "version": 1,
    "quantityRoiCanonical": [1, 29, 44, 44],
    "rawRoiProjection": "full lower slot band; scaleX/scaleY from T005A1 geometry",
    "whiteMask": {"maxRgbGreaterThan": 0.62, "maxMinusMinLessThan": 0.22},
    "connectivity": 8,
    "minimumComponentPixels": 2,
    "glyphNormalization": {"canvas": [8, 12], "aspectPreserved": True,
                             "paddingPixels": 1, "resizeKernel": "nearest"},
    "templateDistance": "binary-mask RMS; best distance per distinct digit label",
    "minimumDistinctDigitMargin": 0.015,
    "minimumSafetyMarginPixels": 1,
    "maximumDigitComponents": 4,
    "maximumSingleComponentWidth": 8,
    "maximumTrailingMarginPixels": 8,
    "maximumBestTemplateDistance": 0.38,
    "splitSuspect": {"maxNeighborGap": 1, "minimumVerticalOverlapRatio": 0.75,
                     "interpretation": "candidate abstention signal; adjacent legitimate digits may also match"},
    "policy": "candidate measurement only; all thresholds unapproved",
}


def canonical_hash(value: Any) -> str:
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: str | Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _reference_rgb(path: Path) -> np.ndarray:
    with Image.open(path) as source:
        icon = source.convert("RGBA").resize((43, 43), Image.Resampling.LANCZOS)
    rgba = np.asarray(icon, dtype=np.float32) / 255.0
    alpha = rgba[:, :, 3:4]
    background = np.asarray([23, 24, 27], dtype=np.float32).reshape(1, 1, 3) / 255.0
    rgb = rgba[:, :, :3] * alpha + background * (1.0 - alpha)
    return np.asarray(Image.fromarray(np.uint8(np.clip(rgb * 255.0, 0, 255))).crop((1, 1, 42, 26)),
                      dtype=np.float32) / 255.0


def load_r1_templates(reference_json: str | Path) -> dict[str, Any]:
    path = Path(reference_json)
    catalog = json.loads(path.read_text(encoding="utf-8"))
    items = catalog["items"]
    templates = []
    for item in items:
        templates.append({
            "itemId": item["itemId"],
            "programName": item["programName"],
            "tier": item.get("tier"),
            "inventoryTarget": item.get("inventoryTarget"),
            "rgb": _reference_rgb(path.parent / item["iconFile"]),
        })
    return {"items": templates, "catalogSha256": sha256_file(path), "roi": R1_PARAMS["roi"]}


def _resize_rgb(image: Image.Image, size: tuple[int, int] = (41, 25)) -> np.ndarray:
    resized = image.convert("RGB")
    if resized.size != size:
        resized = resized.resize(size, Image.Resampling.LANCZOS)
    return np.asarray(resized, dtype=np.float32) / 255.0


def _gray(rgb: np.ndarray) -> np.ndarray:
    return rgb[:, :, 0] * 0.299 + rgb[:, :, 1] * 0.587 + rgb[:, :, 2] * 0.114


def run_r1(icon_crop: Image.Image, templates: dict[str, Any]) -> dict[str, Any]:
    """Rank icon references by normalized grayscale NCC; color remains separate."""
    rgb = _resize_rgb(icon_crop)
    gray = _gray(rgb).astype(np.float64)
    centered = gray - float(gray.mean())
    input_norm = float(np.linalg.norm(centered))
    candidates = []
    undefined = input_norm <= 1e-12
    for item in templates["items"]:
        reference_rgb = item["rgb"]
        reference_gray = _gray(reference_rgb).astype(np.float64)
        reference_centered = reference_gray - float(reference_gray.mean())
        denominator = input_norm * float(np.linalg.norm(reference_centered))
        ncc = None if denominator <= 1e-12 else float(np.sum(centered * reference_centered) / denominator)
        delta = rgb.astype(np.float64) - reference_rgb.astype(np.float64)
        candidates.append({
            "itemId": item["itemId"], "programName": item["programName"], "tier": item["tier"],
            "inventoryTarget": item["inventoryTarget"], "grayscaleNcc": ncc,
            "colorMeanAbsoluteDistance": float(np.mean(np.abs(delta))),
            "colorRmsDistance": float(np.sqrt(np.mean(delta * delta))),
        })
    valid = [item for item in candidates if item["grayscaleNcc"] is not None and np.isfinite(item["grayscaleNcc"])]
    valid.sort(key=lambda item: (-item["grayscaleNcc"], item["itemId"]))
    top = valid[:2]
    reasons = ["NCC_UNDEFINED"] if undefined or not valid else []
    return {
        "readerId": R1_READER_ID,
        "status": "CANDIDATE_EVIDENCE" if top else "UNKNOWN",
        "top1": top[0] if top else None,
        "top2": top[1] if len(top) > 1 else None,
        "nccMargin": (top[0]["grayscaleNcc"] - top[1]["grayscaleNcc"]) if len(top) > 1 else None,
        "qualityReasons": reasons,
        "candidateOrder": top,
        "colorEvidenceIndependentOfRanking": True,
        "readerCorrelationRisk": "SHARED_REFERENCE_SOURCE",
    }


def load_q1_templates(templates_path: str | Path) -> dict[str, Any]:
    with np.load(templates_path, allow_pickle=False) as archive:
        feature = np.asarray(archive["digit_features"], dtype=np.float32)
        labels = np.asarray(archive["digit_labels"], dtype=np.int16)
    coverage = sorted(set(int(value) for value in labels.tolist()))
    per_digit = {digit: int(np.count_nonzero(labels == digit)) for digit in range(10)}
    return {"features": feature, "labels": labels, "coverage": coverage,
            "perDigitCount": per_digit, "templatesSha256": sha256_file(templates_path)}


def _mask(image: Image.Image) -> np.ndarray:
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    maximum = rgb.max(axis=2)
    chroma = maximum - rgb.min(axis=2)
    return (maximum > Q1_PARAMS["whiteMask"]["maxRgbGreaterThan"]
            ) & (chroma < Q1_PARAMS["whiteMask"]["maxMinusMinLessThan"])


def _components(mask: np.ndarray) -> list[dict[str, Any]]:
    height, width = mask.shape
    visited = np.zeros_like(mask, dtype=bool)
    result = []
    for start_y, start_x in zip(*np.nonzero(mask)):
        if visited[start_y, start_x]:
            continue
        stack = [(int(start_x), int(start_y))]
        visited[start_y, start_x] = True
        points = []
        while stack:
            x, y = stack.pop()
            points.append((x, y))
            for ny in range(max(0, y - 1), min(height, y + 2)):
                for nx in range(max(0, x - 1), min(width, x + 2)):
                    if mask[ny, nx] and not visited[ny, nx]:
                        visited[ny, nx] = True
                        stack.append((nx, ny))
        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        x0, x1, y0, y1 = min(xs), max(xs) + 1, min(ys), max(ys) + 1
        count = len(points)
        result.append({
            "x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0, "pixelCount": count,
            "centroid": {"x": float(sum(xs) / count), "y": float(sum(ys) / count)},
            "touchesLeft": x0 == 0, "touchesRight": x1 == width,
            "touchesTop": y0 == 0, "touchesBottom": y1 == height,
            "_points": points,
        })
    return sorted(result, key=lambda component: (component["x"], component["y"]))


def _component_mask(mask: np.ndarray, component: dict[str, Any]) -> np.ndarray:
    result = np.zeros((component["h"], component["w"]), dtype=np.uint8)
    for x, y in component["_points"]:
        result[y - component["y"], x - component["x"]] = 255
    return result


def _normalize_glyph(binary: np.ndarray) -> np.ndarray:
    canvas_w, canvas_h = 8, 12
    inner_w, inner_h = canvas_w - 2, canvas_h - 2
    h, w = binary.shape
    scale = min(inner_w / max(w, 1), inner_h / max(h, 1))
    target = (max(1, int(round(w * scale))), max(1, int(round(h * scale))))
    glyph = Image.fromarray(binary, mode="L").resize(target, Image.Resampling.NEAREST)
    canvas = Image.new("L", (canvas_w, canvas_h), 0)
    x = (canvas_w - target[0]) // 2
    y = (canvas_h - target[1]) // 2
    canvas.paste(glyph, (x, y))
    return np.asarray(canvas, dtype=np.float32).reshape(-1) / 255.0


def _classify_glyph(mask: np.ndarray, component: dict[str, Any], templates: dict[str, Any]) -> dict[str, Any]:
    binary = _component_mask(mask, component)
    feature = _normalize_glyph(binary)
    distances = np.sqrt(np.mean((templates["features"] - feature[None, :]) ** 2, axis=1))
    per_label = []
    for label in templates["coverage"]:
        label_distances = distances[templates["labels"] == label]
        if len(label_distances):
            per_label.append({"digit": label, "distance": float(label_distances.min())})
    per_label.sort(key=lambda row: (row["distance"], row["digit"]))
    best = per_label[0] if per_label else None
    second = per_label[1] if len(per_label) > 1 else None
    margin = (second["distance"] - best["distance"]) if best and second else None
    return {
        "componentBox": {key: component[key] for key in ("x", "y", "w", "h")},
        "pixelCount": component["pixelCount"],
        "candidates": per_label[:2],
        "bestDigit": best["digit"] if best else None,
        "bestDistance": best["distance"] if best else None,
        "secondDistinctDistance": second["distance"] if second else None,
        "distinctLabelMargin": margin,
        "templateCoverage": templates["coverage"],
        "qualityReasons": [],
    }


def run_q1(quantity_crop: Image.Image, templates: dict[str, Any]) -> dict[str, Any]:
    """Segment a whole quantity token and compare components with read-only templates."""
    mask = _mask(quantity_crop)
    height, width = mask.shape
    components = _components(mask)
    accepted = [component for component in components
                if component["pixelCount"] >= Q1_PARAMS["minimumComponentPixels"]]
    rejected = [component for component in components
                if component["pixelCount"] < Q1_PARAMS["minimumComponentPixels"]]
    public_components = [{key: value for key, value in component.items() if not key.startswith("_")}
                         for component in accepted]
    coverage_complete = templates["coverage"] == list(range(10))
    reasons: list[str] = []
    if not accepted:
        return {
            "readerId": Q1_READER_ID, "status": "MISSING", "value": None,
            "tokenBox": None, "components": [], "rejectedComponents": len(rejected),
            "digits": [], "templateCoverage": templates["coverage"],
            "templateCoverageComplete": coverage_complete, "qualityReasons": ["NO_FOREGROUND_COMPONENTS"],
        }
    accepted.sort(key=lambda component: (component["x"], component["y"]))
    x0 = min(component["x"] for component in accepted)
    y0 = min(component["y"] for component in accepted)
    x1 = max(component["x"] + component["w"] for component in accepted)
    y1 = max(component["y"] + component["h"] for component in accepted)
    token_box = {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0,
                 "leftSafetyMargin": x0, "rightSafetyMargin": width - x1,
                 "topSafetyMargin": y0, "bottomSafetyMargin": height - y1,
                 "touchesLeft": x0 == 0, "touchesRight": x1 == width,
                 "touchesTop": y0 == 0, "touchesBottom": y1 == height}
    if any(component["touchesLeft"] for component in accepted) or token_box["leftSafetyMargin"] < Q1_PARAMS["minimumSafetyMarginPixels"]:
        reasons.append("CLIPPED_LEFT")
    if any(component["touchesRight"] for component in accepted) or token_box["rightSafetyMargin"] < Q1_PARAMS["minimumSafetyMarginPixels"]:
        reasons.append("CLIPPED_RIGHT")
    elif token_box["rightSafetyMargin"] > Q1_PARAMS["maximumTrailingMarginPixels"]:
        reasons.append("TOKEN_RIGHT_ALIGNMENT_UNSUPPORTED")
    if any(component["touchesTop"] for component in accepted) or token_box["topSafetyMargin"] < Q1_PARAMS["minimumSafetyMarginPixels"]:
        reasons.append("CLIPPED_TOP")
    if any(component["touchesBottom"] for component in accepted) or token_box["bottomSafetyMargin"] < Q1_PARAMS["minimumSafetyMarginPixels"]:
        reasons.append("CLIPPED_BOTTOM")
    if len(accepted) > Q1_PARAMS["maximumDigitComponents"]:
        reasons.append("MORE_THAN_FOUR_DIGITS_POSSIBLE")
    if any(component["w"] > Q1_PARAMS["maximumSingleComponentWidth"] for component in accepted):
        reasons.append("MERGED_COMPONENT_SUSPECTED")
    digits = [_classify_glyph(mask, component, templates) for component in accepted]
    for left, right in zip(accepted, accepted[1:]):
        gap = right["x"] - (left["x"] + left["w"])
        overlap = max(0, min(left["y"] + left["h"], right["y"] + right["h"]) - max(left["y"], right["y"]))
        overlap_ratio = overlap / max(1, min(left["h"], right["h"]))
        if gap <= Q1_PARAMS["splitSuspect"]["maxNeighborGap"] and overlap_ratio >= Q1_PARAMS["splitSuspect"]["minimumVerticalOverlapRatio"]:
            reasons.append("SPLIT_COMPONENT_SUSPECTED")
            break
    for digit in digits:
        if digit["bestDigit"] is None or digit["bestDigit"] not in templates["coverage"]:
            reasons.append("TEMPLATE_LABEL_UNAVAILABLE")
        if digit["distinctLabelMargin"] is None or digit["distinctLabelMargin"] < Q1_PARAMS["minimumDistinctDigitMargin"]:
            digit["qualityReasons"].append("DIGIT_CLASSIFIER_AMBIGUOUS")
            reasons.append("DIGIT_CLASSIFIER_AMBIGUOUS")
        if (digit["bestDistance"] is None
                or digit["bestDistance"] > Q1_PARAMS["maximumBestTemplateDistance"]):
            digit["qualityReasons"].append("DIGIT_TEMPLATE_DISTANCE_TOO_HIGH")
            reasons.append("DIGIT_TEMPLATE_DISTANCE_TOO_HIGH")
    if not coverage_complete:
        reasons.append("TEMPLATE_COVERAGE_INCOMPLETE")
    if rejected:
        reasons.append("SMALL_COMPONENT_NOISE")
    # These fixed-cell templates were sampled over four 8px cells. A fifth
    # leading glyph cannot be ruled out when the token begins at the ROI edge.
    if token_box["leftSafetyMargin"] <= 1:
        reasons.append("FIVE_DIGIT_TRUNCATION_POSSIBLE")
    reasons = sorted(set(reasons))
    clipping = any(reason.startswith("CLIPPED_") or reason == "FIVE_DIGIT_TRUNCATION_POSSIBLE" for reason in reasons)
    unreadable = bool(reasons)
    value = None
    status = "CLIPPED" if clipping else "UNREADABLE" if unreadable else "VALUE"
    if status == "VALUE":
        value = int("".join(str(digit["bestDigit"]) for digit in digits))
    return {
        "readerId": Q1_READER_ID, "status": status, "value": value,
        "tokenBox": token_box, "components": public_components, "rejectedComponents": len(rejected),
        "digits": digits, "templateCoverage": templates["coverage"],
        "templateCoverageComplete": coverage_complete, "qualityReasons": reasons,
    }


def quantity_roi_from_slot(slot: Image.Image, *, raw: bool = False,
                           scale_x: float = 1.0, scale_y: float = 1.0) -> Image.Image:
    """Crop the full lower slot band, retaining margins for clipping/fifth-digit checks."""
    if raw:
        bounds = tuple(round(value * scale) for value, scale in zip(
            Q1_PARAMS["quantityRoiCanonical"], (scale_x, scale_y, scale_x, scale_y)))
    else:
        bounds = tuple(Q1_PARAMS["quantityRoiCanonical"])
    return slot.convert("RGB").crop(bounds)


def quantity_roi_from_legacy_crop(slot: Image.Image) -> Image.Image:
    return quantity_roi_from_slot(slot, raw=False)


def template_coverage(templates_path: str | Path) -> dict[str, Any]:
    templates = load_q1_templates(templates_path)
    return {"digits": templates["coverage"], "complete0To9": templates["coverage"] == list(range(10)),
            "perDigitTemplateCount": templates["perDigitCount"],
            "templatesSha256": templates["templatesSha256"]}
