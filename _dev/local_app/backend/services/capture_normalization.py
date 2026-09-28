"""Experimental, grid-crop-only geometry measurement for SPEC-008 T005A1.

This module observes repeated grid edges. It does not identify a warehouse UI,
recognize items, or grant a production-validity decision.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image


SCOPE = "warehouse-grid-crop"
HIGH_AUTHORITY = False


def logical_array_hash(arrays: dict[str, np.ndarray]) -> str:
    digest = hashlib.sha256()
    for name in sorted(arrays):
        array = np.ascontiguousarray(arrays[name])
        digest.update(name.encode("utf-8") + b"\0")
        digest.update(array.dtype.str.encode("ascii") + b"\0")
        digest.update(json.dumps(list(array.shape), separators=(",", ":")).encode("ascii") + b"\0")
        digest.update(array.tobytes(order="C"))
    return digest.hexdigest()


def load_anchor_bundle(path: str | Path) -> dict[str, Any]:
    with np.load(path, allow_pickle=False) as archive:
        arrays = {name: np.array(archive[name], copy=True) for name in archive.files}
    required = {"column_edges", "row_edges", "slot_width_ratio"}
    if set(arrays) != required:
        raise ValueError("anchor bundle has an unexpected array set")
    if arrays["column_edges"].ndim != 1 or arrays["row_edges"].ndim != 1:
        raise ValueError("anchor edge indices must be one-dimensional")
    if arrays["slot_width_ratio"].shape != (2,):
        raise ValueError("anchor slot ratios must contain x and y values")
    return {"arrays": arrays, "logicalHash": logical_array_hash(arrays)}


def load_profile(path: str | Path) -> dict[str, Any]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    profile = value.get("profiles", [None])[0]
    if not isinstance(profile, dict) or profile.get("scope") != SCOPE:
        raise ValueError("profile must be scoped to warehouse-grid-crop")
    if profile.get("releaseApproved") is not False or profile.get("liveApproved") is not False:
        raise ValueError("measurement profiles cannot be approved")
    if profile.get("allowedStrata") != []:
        raise ValueError("measurement profiles cannot enable strata")
    if profile.get("profileVersion") != 1:
        raise ValueError("profileVersion 1 is required")
    return profile


def _gray_edges(image: Image.Image) -> tuple[np.ndarray, np.ndarray]:
    gray = np.asarray(image.convert("L"), dtype=np.float32) / 255.0
    # Edge projections are averaged along the other axis, so icon pixels do not
    # become identity anchors. Only repeated boundaries contribute coherently.
    x_edges = np.abs(np.diff(gray, axis=1)).mean(axis=0)
    y_edges = np.abs(np.diff(gray, axis=0)).mean(axis=1)
    return x_edges, y_edges


def _observe_axis(edge: np.ndarray, cell_count: int, slot_ratio: float) -> dict[str, float] | None:
    """Measure a repeated paired-edge lattice without an absolute pixel range.

    The search span follows only the number of cells and available frame size.
    Candidate score and separation from background are retained as measurements;
    this experimental result is not a production acceptance cutoff.
    """
    length = len(edge) + 1
    if cell_count < 2 or length < cell_count * 2:
        return None
    best: tuple[float, int, int, int] | None = None
    # A period is bounded by the frame and expected logical cell count. Both
    # period and cell width are observed from edge energy, not fixed pixels.
    for period in range(2, max(3, length // (cell_count - 1) + 1)):
        # The fixture-derived edge-pair ratio is a structural anchor, not a
        # scale cutoff. Width is still observed in pixels and reported below.
        width = max(1, min(period - 1, int(round(period * slot_ratio))))
        span = (cell_count - 1) * period + width
        if span >= length:
            continue
        origins = np.arange(0, length - span + 1, dtype=np.int32)
        offsets = np.array([index * period + side for index in range(cell_count)
                            for side in (0, width)], dtype=np.int32)
        scores = edge[np.minimum(origins[:, None] + offsets[None, :], len(edge) - 1)].sum(axis=1)
        index = int(np.argmax(scores))
        score = float(scores[index])
        if best is None or score > best[0]:
            best = (score, int(origins[index]), period, width)
    if best is None:
        return None
    score, origin, period, width = best
    positions = np.array([origin + index * period + side for index in range(cell_count)
                          for side in (0, width)], dtype=np.int32)
    boundary_strength = float(np.mean(edge[np.minimum(positions, len(edge) - 1)]))
    background = float(np.mean(edge))
    first_edge_strength = float(edge[min(origin, len(edge) - 1)])
    last_edge_position = origin + (cell_count - 1) * period + width
    last_edge_strength = float(edge[min(last_edge_position, len(edge) - 1)])
    return {
        "origin": float(origin), "period": float(period), "slotWidth": float(width),
        "slotWidthRatio": float(width / period), "gapRatio": float((period - width) / period),
        "boundaryStrength": boundary_strength, "backgroundStrength": background,
        "contrastRatio": float(boundary_strength / max(background, 1e-9)),
        "firstOuterEdgeStrength": first_edge_strength,
        "lastOuterEdgeStrength": last_edge_strength,
        "candidateScore": score, "relativeOrigin": float(origin / length),
        "relativePeriod": float(period / length), "anchorSlotRatio": float(slot_ratio),
    }


def _resample(image: Image.Image, size: tuple[int, int], kernel: str) -> Image.Image:
    kernels = {
        "bilinear": Image.Resampling.BILINEAR,
        "bicubic": Image.Resampling.BICUBIC,
        "lanczos": Image.Resampling.LANCZOS,
    }
    if kernel not in kernels:
        raise ValueError("unsupported measurement resampling kernel")
    return image.resize(size, kernels[kernel])


@dataclass
class NormalizedCapture:
    scope: str
    validity: str
    transform: dict[str, float] | None
    gridEvidence: dict[str, Any]
    qualityReasons: list[str]
    profileStratum: str
    rawBoxes: list[dict[str, Any]]
    canonicalBoxes: list[dict[str, Any]]
    rawCrops: list[Image.Image]
    canonicalCrops: list[Image.Image]
    rawRegionCrops: list[dict[str, Image.Image]]
    canonicalRegionCrops: list[dict[str, Image.Image]]
    measurement: dict[str, Any]

    def as_metadata(self) -> dict[str, Any]:
        return {"scope": self.scope, "validity": self.validity, "transform": self.transform,
                "gridEvidence": self.gridEvidence, "qualityReasons": self.qualityReasons,
                "profileStratum": self.profileStratum, "rawBoxes": self.rawBoxes,
                "canonicalBoxes": self.canonicalBoxes, "measurement": self.measurement,
                "recognitionDecision": None, "highAuthority": False}


def normalize_capture(image: Image.Image, profile: dict[str, Any], anchor_data: dict[str, Any],
                      *, resampling: str = "lanczos") -> NormalizedCapture:
    """Measure and canonicalize a known grid-crop candidate; never recognize items."""
    if profile.get("scope") != SCOPE or profile.get("releaseApproved") is not False:
        raise ValueError("unsupported or approved profile is not accepted by the measurement helper")
    arrays = anchor_data["arrays"]
    if profile.get("anchorLogicalHash") != anchor_data.get("logicalHash"):
        raise ValueError("anchor logical hash does not match profile")
    columns = len(arrays["column_edges"]) - 1
    rows = len(arrays["row_edges"]) - 1
    ratios = np.asarray(arrays["slot_width_ratio"], dtype=np.float64)
    x_edges, y_edges = _gray_edges(image)
    x_observation = _observe_axis(x_edges, columns, float(ratios[0]))
    y_observation = _observe_axis(y_edges, rows, float(ratios[1]))
    reasons: list[str] = []
    if x_observation is None or y_observation is None:
        return NormalizedCapture(SCOPE, "INVALID_GRID_CROP", None, {"x": x_observation, "y": y_observation},
                                 ["GRID_NOT_FOUND"], "unsupported", [], [], [], [], [], [], {})
    if x_observation["contrastRatio"] <= 1.0 or y_observation["contrastRatio"] <= 1.0:
        return NormalizedCapture(SCOPE, "INVALID_GRID_CROP", None,
                                 {"x": x_observation, "y": y_observation}, ["GRID_NOT_FOUND"],
                                 "unsupported", [], [], [], [], [], [],
                                 {"rows": rows, "columns": columns, "approvedStrata": []})

    x_scale = x_observation["period"] / float(profile["canonicalGeometry"]["periodX"])
    y_scale = y_observation["period"] / float(profile["canonicalGeometry"]["periodY"])
    scale_delta = abs(x_scale - y_scale)
    # Quantization uncertainty is one observed pixel on each axis. Any larger
    # scale divergence is retained as an explicit nonuniform-transform negative.
    uncertainty = (1.0 / x_observation["period"] + 1.0 / y_observation["period"])
    if scale_delta > uncertainty:
        reasons.append("NONUNIFORM_TRANSFORM")
    expected_x_ratio = float(ratios[0])
    expected_y_ratio = float(ratios[1])
    ratio_uncertainty = max(1.0 / x_observation["period"], 1.0 / y_observation["period"])
    if (abs(x_observation["slotWidthRatio"] - expected_x_ratio) > ratio_uncertainty
            or abs(y_observation["slotWidthRatio"] - expected_y_ratio) > ratio_uncertainty):
        reasons.append("STRUCTURE_MISMATCH")
    x_outer_missing = (x_observation["firstOuterEdgeStrength"] <= x_observation["backgroundStrength"]
                       or x_observation["lastOuterEdgeStrength"] <= x_observation["backgroundStrength"])
    y_outer_missing = (y_observation["firstOuterEdgeStrength"] <= y_observation["backgroundStrength"]
                       or y_observation["lastOuterEdgeStrength"] <= y_observation["backgroundStrength"])
    reference_frame = profile["referenceFrame"]
    frame_scale_x = image.width / float(reference_frame["width"])
    frame_scale_y = image.height / float(reference_frame["height"])
    frame_scale_uncertainty = max(1.0 / float(profile["canonicalGeometry"]["periodX"]),
                                  1.0 / float(profile["canonicalGeometry"]["periodY"]))
    frame_matches_candidate = (
        abs(frame_scale_x - x_scale) <= frame_scale_uncertainty
        and abs(frame_scale_y - y_scale) <= frame_scale_uncertainty
    )
    if (x_outer_missing or y_outer_missing) and not frame_matches_candidate:
        reasons.append("GRID_CLIPPED")
    # If the final outer edge disappears, project the known quantity region
    # with the other, still-observed axis scale. This is specifically a crop
    # boundary check; it does not approve that scale for production use.
    x_last_missing = x_observation["lastOuterEdgeStrength"] <= x_observation["backgroundStrength"]
    y_last_missing = y_observation["lastOuterEdgeStrength"] <= y_observation["backgroundStrength"]
    digit_bounds_exceed_frame = (
        (x_last_missing and x_observation["origin"] + (columns - 1) * y_scale * float(profile["canonicalGeometry"]["periodX"]) + 40 * y_scale > image.width)
        or (y_last_missing and y_observation["origin"] + (rows - 1) * x_scale * float(profile["canonicalGeometry"]["periodY"]) + 41 * x_scale > image.height)
    )
    if "GRID_CLIPPED" in reasons and digit_bounds_exceed_frame:
        reasons.append("DIGIT_REGION_CLIPPED")

    canonical = profile["canonicalGeometry"]
    cell_w, cell_h = int(canonical["slotWidthX"]), int(canonical["slotWidthY"])
    raw_boxes: list[dict[str, Any]] = []
    canonical_boxes: list[dict[str, Any]] = []
    raw_crops: list[Image.Image] = []
    canonical_crops: list[Image.Image] = []
    raw_region_crops: list[dict[str, Image.Image]] = []
    canonical_region_crops: list[dict[str, Image.Image]] = []
    width, height = image.size
    grid_right = x_observation["origin"] + (columns - 1) * x_observation["period"] + x_observation["slotWidth"]
    grid_bottom = y_observation["origin"] + (rows - 1) * y_observation["period"] + y_observation["slotWidth"]
    for row in range(rows):
        for column in range(columns):
            x0 = int(round(x_observation["origin"] + column * x_observation["period"]))
            y0 = int(round(y_observation["origin"] + row * y_observation["period"]))
            x1 = int(round(x0 + x_observation["slotWidth"]))
            y1 = int(round(y0 + y_observation["slotWidth"]))
            # Quantity ROI is projected from the canonical inner-slot region.
            # When one axis is clipped, the other measured axis supplies the
            # uniform-scale candidate so a truncated final row/column cannot
            # silently shrink its own expected digit boundary.
            scale_for_digits = (x_scale + y_scale) / 2.0
            if scale_delta > uncertainty:
                scale_for_digits = y_scale if abs(x_scale - 1.0) >= abs(y_scale - 1.0) else x_scale
            digit_x0 = x0 + int(round(32 * scale_for_digits))
            digit_y0 = y0 + int(round(29 * scale_for_digits))
            digit_x1 = x0 + int(round(40 * scale_for_digits))
            digit_y1 = y0 + int(round(41 * scale_for_digits))
            if digit_x0 < 0 or digit_y0 < 0 or digit_x1 > width or digit_y1 > height:
                if "DIGIT_REGION_CLIPPED" not in reasons:
                    reasons.append("DIGIT_REGION_CLIPPED")
            clipped = x0 < 0 or y0 < 0 or x1 > width or y1 > height
            if clipped:
                reason = "DIGIT_REGION_CLIPPED" if row == rows - 1 or column == columns - 1 else "GRID_CLIPPED"
                if reason not in reasons:
                    reasons.append(reason)
                continue
            slot = image.crop((x0, y0, x1, y1))
            canonical_crop = _resample(slot, (cell_w, cell_h), resampling)
            unit = f"R{row + 1}C{column + 1}"
            canonical_x = column * int(canonical["periodX"])
            canonical_y = row * int(canonical["periodY"])
            raw_icon_box = (x0 + int(round(2 * x_scale)), y0 + int(round(2 * y_scale)),
                            x0 + int(round(43 * x_scale)), y0 + int(round(27 * y_scale)))
            raw_quantity_box = (x0 + int(round(32 * x_scale)), y0 + int(round(29 * y_scale)),
                                x0 + int(round(40 * x_scale)), y0 + int(round(41 * y_scale)))
            raw_boxes.append({"unitId": unit, "x": x0, "y": y0, "w": x1-x0, "h": y1-y0})
            canonical_boxes.append({"unitId": unit, "x": canonical_x, "y": canonical_y, "w": cell_w, "h": cell_h})
            canonical_icon = (2, 2, cell_w - 2, 27)
            canonical_quantity = (32, 29, 40, 41)
            raw_icon = (raw_icon_box[0] - x0, raw_icon_box[1] - y0,
                        raw_icon_box[2] - x0, raw_icon_box[3] - y0)
            raw_quantity = (raw_quantity_box[0] - x0, raw_quantity_box[1] - y0,
                            raw_quantity_box[2] - x0, raw_quantity_box[3] - y0)
            raw_boxes[-1]["regions"] = {
                "icon": {"x": raw_icon_box[0], "y": raw_icon_box[1], "w": raw_icon_box[2]-raw_icon_box[0], "h": raw_icon_box[3]-raw_icon_box[1]},
                "quantity": {"x": raw_quantity_box[0], "y": raw_quantity_box[1], "w": raw_quantity_box[2]-raw_quantity_box[0], "h": raw_quantity_box[3]-raw_quantity_box[1]},
            }
            canonical_boxes[-1]["regions"] = {
                "icon": {"x": canonical_x + canonical_icon[0], "y": canonical_y + canonical_icon[1], "w": canonical_icon[2]-canonical_icon[0], "h": canonical_icon[3]-canonical_icon[1]},
                "quantity": {"x": canonical_x + canonical_quantity[0], "y": canonical_y + canonical_quantity[1], "w": canonical_quantity[2]-canonical_quantity[0], "h": canonical_quantity[3]-canonical_quantity[1]},
            }
            raw_crops.append(slot.copy())
            canonical_crops.append(canonical_crop.copy())
            raw_region_crops.append({"icon": slot.crop(raw_icon), "quantity": slot.crop(raw_quantity)})
            canonical_region_crops.append({"icon": canonical_crop.crop(canonical_icon),
                                           "quantity": canonical_crop.crop(canonical_quantity)})

    expected_count = rows * columns
    if len(raw_crops) != expected_count:
        if "GRID_CLIPPED" not in reasons and "DIGIT_REGION_CLIPPED" not in reasons:
            reasons.append("GRID_CLIPPED")
    validity = "VALID_GRID_CROP" if not reasons else "INVALID_GRID_CROP"
    transform = {"scaleX": float(x_scale), "scaleY": float(y_scale),
                 "translationX": float(x_observation["origin"]), "translationY": float(y_observation["origin"])}
    return NormalizedCapture(
        SCOPE, validity, transform, {"x": x_observation, "y": y_observation}, reasons,
        "unsupported", raw_boxes, canonical_boxes, raw_crops, canonical_crops,
        raw_region_crops, canonical_region_crops,
        {"gridBounds": {"x": x_observation["origin"], "y": y_observation["origin"],
                        "right": grid_right, "bottom": grid_bottom},
         "rows": rows, "columns": columns, "resamplingCandidate": resampling,
         "approvedStrata": [], "fullPanelClippingValidated": False},
    )
