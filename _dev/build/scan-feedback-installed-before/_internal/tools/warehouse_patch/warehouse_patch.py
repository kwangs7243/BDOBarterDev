#!/usr/bin/env python3
"""Deterministic, local-only warehouse screenshot to inventory PATCH converter."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image


GRID_PERIOD_RANGE = range(48, 55)
SLOT_WIDTH_RANGE = range(42, 49)
ICON_SCORE_MAX = 0.35
ICON_GAP_MIN = 0.045
EMPTY_BRIGHT_PIXELS_MAX = 20
OCR_PRESENCE_MARGIN = 0.03
OCR_DIGIT_GAP_MIN = 0.03
ICON_BACKGROUND = np.array([23, 24, 27], dtype=np.float32) / 255.0


class GridDetectionError(RuntimeError):
    pass


@dataclass(frozen=True)
class AxisGrid:
    origin: int
    period: int
    width: int
    count: int
    peak_score: float


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _brightness_peak_profile(rgb: np.ndarray, axis: int) -> np.ndarray:
    luminance = rgb.mean(axis=2)
    lines = luminance.mean(axis=0 if axis == 0 else 1)
    profile = np.zeros_like(lines)
    if len(lines) > 1:
        profile[0] = max(0.0, lines[0] - lines[1])
        profile[-1] = max(0.0, lines[-1] - lines[-2])
    if len(lines) > 2:
        profile[1:-1] = np.maximum(
            0.0, lines[1:-1] - (lines[:-2] + lines[2:]) / 2.0
        )
    return profile


def _best_axis_grid(rgb: np.ndarray, axis: int) -> AxisGrid:
    profile = _brightness_peak_profile(rgb, axis)
    axis_length = rgb.shape[1] if axis == 0 else rgb.shape[0]
    best: tuple[float, AxisGrid] | None = None
    for period in GRID_PERIOD_RANGE:
        for width in SLOT_WIDTH_RANGE:
            for residue in range(period):
                positions = [
                    pos
                    for pos in range(residue, axis_length, period)
                    if pos + width - 1 < axis_length
                ]
                if len(positions) < 4:
                    continue
                pair_scores = np.array(
                    [(profile[pos] + profile[pos + width - 1]) / 2.0 for pos in positions]
                )
                threshold = max(0.005, float(pair_scores.max()) * 0.20)
                active = pair_scores >= threshold
                run_start = 0
                while run_start < len(active):
                    if not active[run_start]:
                        run_start += 1
                        continue
                    run_end = run_start
                    while run_end + 1 < len(active) and active[run_end + 1]:
                        run_end += 1
                    count = run_end - run_start + 1
                    if count >= 4:
                        values = pair_scores[run_start : run_end + 1]
                        score = count * float(values.mean()) * (1.0 + 0.08 * count)
                        grid = AxisGrid(
                            origin=positions[run_start],
                            period=period,
                            width=width,
                            count=count,
                            peak_score=float(values.mean()),
                        )
                        if best is None or score > best[0]:
                            best = (score, grid)
                    run_start = run_end + 1
    if best is None:
        raise GridDetectionError("SLOT_GRID_DETECTION_FAILED")
    return best[1]


def _validate_grid(rgb: np.ndarray, xgrid: AxisGrid, ygrid: AxisGrid) -> dict[str, float]:
    if xgrid.period != ygrid.period or xgrid.width != ygrid.width:
        raise GridDetectionError("SLOT_GRID_DETECTION_FAILED")
    period, width = xgrid.period, xgrid.width
    gap = period - width
    if gap < 3 or gap > 10:
        raise GridDetectionError("SLOT_GRID_DETECTION_FAILED")
    valid = 0
    contrast_values: list[float] = []
    gap_values: list[float] = []
    total = xgrid.count * ygrid.count
    for row in range(ygrid.count):
        for col in range(xgrid.count):
            x = xgrid.origin + col * period
            y = ygrid.origin + row * period
            slot = rgb[y : y + width, x : x + width]
            if slot.shape[:2] != (width, width):
                continue
            border = np.concatenate(
                [slot[0, :, :].ravel(), slot[-1, :, :].ravel(), slot[:, 0, :].ravel(), slot[:, -1, :].ravel()]
            )
            inner = slot[2:-2, 2:-2, :].ravel()
            contrast = float(border.mean() - inner.mean())
            contrast_values.append(contrast)
            gx0 = x + width
            gy0 = y + width
            gaps: list[np.ndarray] = []
            if gx0 + gap <= rgb.shape[1]:
                gaps.append(rgb[y : y + width, gx0 : gx0 + gap])
            if gy0 + gap <= rgb.shape[0]:
                gaps.append(rgb[gy0 : gy0 + gap, x : x + width])
            gap_mean = float(np.mean([value.mean() for value in gaps])) if gaps else 0.0
            gap_values.append(gap_mean)
            if contrast > 0.015 and (not gaps or gap_mean < 0.35):
                valid += 1
    ratio = valid / total if total else 0.0
    if ratio < 0.80:
        raise GridDetectionError("SLOT_GRID_DETECTION_FAILED")
    return {
        "validatedCellRatio": ratio,
        "meanBorderContrast": float(np.mean(contrast_values)),
        "meanGapBrightness": float(np.mean(gap_values)),
    }


def detect_grid(image: Image.Image) -> tuple[AxisGrid, AxisGrid, dict[str, float]]:
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    xgrid = _best_axis_grid(rgb, axis=0)
    ygrid = _best_axis_grid(rgb, axis=1)
    return xgrid, ygrid, _validate_grid(rgb, xgrid, ygrid)


def crop_inner_slots(image: Image.Image, xgrid: AxisGrid, ygrid: AxisGrid) -> list[dict[str, Any]]:
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    slots: list[dict[str, Any]] = []
    for row in range(ygrid.count):
        for col in range(xgrid.count):
            x = xgrid.origin + col * xgrid.period
            y = ygrid.origin + row * ygrid.period
            outer = rgb[y : y + ygrid.width, x : x + xgrid.width]
            inner = outer[1:-1, 1:-1]
            if inner.shape[:2] != (43, 43):
                raise GridDetectionError("SLOT_GRID_DETECTION_FAILED")
            slots.append({"row": row + 1, "column": col + 1, "x": x, "y": y, "rgb": inner})
    return slots


def _composite_icon(path: Path) -> np.ndarray:
    rgba = Image.open(path).convert("RGBA").resize((43, 43), Image.Resampling.LANCZOS)
    array = np.asarray(rgba, dtype=np.float32) / 255.0
    alpha = array[:, :, 3:4]
    return array[:, :, :3] * alpha + ICON_BACKGROUND.reshape(1, 1, 3) * (1.0 - alpha)


def load_reference(reference_json: Path) -> tuple[list[dict[str, Any]], np.ndarray]:
    payload = json.loads(reference_json.read_text(encoding="utf-8"))
    items = payload["items"]
    references = np.stack([_composite_icon(reference_json.parent / item["iconFile"]) for item in items])
    return items, references


def _icon_scores(slot: np.ndarray, references: np.ndarray) -> np.ndarray:
    mask = np.zeros((43, 43), dtype=bool)
    mask[1:26, 1:42] = True
    color = np.sqrt(np.mean((references[:, mask, :] - slot[mask, :]) ** 2, axis=(1, 2)))
    ref_gray = references[:, :, :, 0] * 0.299 + references[:, :, :, 1] * 0.587 + references[:, :, :, 2] * 0.114
    slot_gray = slot[:, :, 0] * 0.299 + slot[:, :, 1] * 0.587 + slot[:, :, 2] * 0.114
    ref_values = ref_gray[:, mask]
    slot_values = slot_gray[mask]
    ref_z = (ref_values - ref_values.mean(axis=1, keepdims=True)) / (ref_values.std(axis=1, keepdims=True) + 1e-6)
    slot_z = (slot_values - slot_values.mean()) / (slot_values.std() + 1e-6)
    structure = np.sqrt(np.mean((ref_z - slot_z) ** 2, axis=1)) / 2.0
    return 0.65 * color + 0.35 * structure


def _is_empty(slot: np.ndarray) -> bool:
    mask = np.zeros((43, 43), dtype=bool)
    mask[1:26, 1:42] = True
    return int(np.count_nonzero(slot[mask].max(axis=1) > 0.25)) <= EMPTY_BRIGHT_PIXELS_MAX


def quantity_cell_feature(slot: np.ndarray, position_from_right: int) -> np.ndarray:
    x0 = 31 - 8 * position_from_right
    cell = slot[28:40, x0 : x0 + 8]
    maximum = cell.max(axis=2)
    minimum = cell.min(axis=2)
    white = (maximum > 0.50) & ((maximum - minimum) < 0.25)
    return white.astype(np.float32).reshape(-1)


class QuantityReader:
    def __init__(self, templates_path: Path):
        data = np.load(templates_path, allow_pickle=False)
        self.digit_features = data["digit_features"].astype(np.float32)
        self.digit_labels = data["digit_labels"].astype(np.int16)
        self.blank_features = [data[f"blank_features_{index}"].astype(np.float32) for index in range(4)]

    @staticmethod
    def _distances(feature: np.ndarray, candidates: np.ndarray) -> np.ndarray:
        return np.sqrt(np.mean((candidates - feature) ** 2, axis=1))

    def read(self, slot: np.ndarray) -> dict[str, Any]:
        digits_reversed: list[int] = []
        details: list[dict[str, Any]] = []
        stopped = False
        for position in range(4):
            feature = quantity_cell_feature(slot, position)
            digit_distances = self._distances(feature, self.digit_features)
            order = np.argsort(digit_distances, kind="stable")
            best_index = int(order[0])
            best_digit_distance = float(digit_distances[best_index])
            best_label = int(self.digit_labels[best_index])
            second_distinct = next(
                (float(digit_distances[idx]) for idx in order[1:] if int(self.digit_labels[idx]) != best_label),
                float("inf"),
            )
            digit_gap = second_distinct - best_digit_distance
            blank_distance = float(self._distances(feature, self.blank_features[position]).min())
            presence_delta = blank_distance - best_digit_distance
            detail = {
                "positionFromRight": position,
                "digit": best_label,
                "digitDistance": best_digit_distance,
                "digitGap": digit_gap,
                "blankDistance": blank_distance,
                "presenceDelta": presence_delta,
            }
            details.append(detail)
            if presence_delta <= -OCR_PRESENCE_MARGIN:
                stopped = True
                continue
            if stopped or presence_delta < OCR_PRESENCE_MARGIN or digit_gap < OCR_DIGIT_GAP_MIN:
                return {"status": "QUANTITY_UNKNOWN", "value": None, "digits": details}
            digits_reversed.append(best_label)
        if not digits_reversed:
            return {"status": "QUANTITY_UNKNOWN", "value": None, "digits": details}
        value = int("".join(str(number) for number in reversed(digits_reversed)))
        return {
            "status": "QUANTITY_MATCH",
            "value": value,
            "digits": details,
            "confidence": {
                "minDigitGap": min(item["digitGap"] for item in details[: len(digits_reversed)]),
                "minPresenceMargin": min(abs(item["presenceDelta"]) for item in details),
            },
        }


def convert(image_path: Path, reference_json: Path, templates_path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    image = Image.open(image_path).convert("RGB")
    xgrid, ygrid, validation = detect_grid(image)
    items, references = load_reference(reference_json)
    quantity_reader = QuantityReader(templates_path)
    slot_results: list[dict[str, Any]] = []
    for slot_info in crop_inner_slots(image, xgrid, ygrid):
        slot = slot_info.pop("rgb")
        result: dict[str, Any] = dict(slot_info)
        result["slot"] = f"R{result['row']}C{result['column']}"
        if _is_empty(slot):
            result.update({"decision": "EMPTY", "quantity": None})
            slot_results.append(result)
            continue
        scores = _icon_scores(slot, references)
        order = np.argsort(scores, kind="stable")
        first, second = int(order[0]), int(order[1])
        best, runner_up = items[first], items[second]
        best_score, second_score = float(scores[first]), float(scores[second])
        gap = second_score - best_score
        quantity = quantity_reader.read(slot)
        result.update(
            {
                "bestCandidate": best["programName"],
                "bestItemId": best["itemId"],
                "tier": best["tier"],
                "bestScore": best_score,
                "secondCandidate": runner_up["programName"],
                "secondScore": second_score,
                "scoreGap": gap,
                "quantity": quantity,
            }
        )
        if best_score > ICON_SCORE_MAX or gap < ICON_GAP_MIN:
            result["decision"] = "ICON_MATCH_UNKNOWN"
        elif not best["inventoryTarget"]:
            result["decision"] = "TIER5_IGNORE"
            result["finalItem"] = best["programName"]
        elif quantity["status"] != "QUANTITY_MATCH":
            result["decision"] = "QUANTITY_UNKNOWN"
            result["finalItem"] = best["programName"]
        else:
            result["decision"] = "MATCH"
            result["finalItem"] = best["programName"]
        slot_results.append(result)

    duplicates: dict[str, list[str]] = {}
    for result in slot_results:
        if result["decision"] == "MATCH":
            duplicates.setdefault(result["finalItem"], []).append(result["slot"])
    duplicates = {name: slots for name, slots in duplicates.items() if len(slots) > 1}
    if duplicates:
        for result in slot_results:
            if result.get("finalItem") in duplicates:
                result["decision"] = "DUPLICATE_ITEM_DETECTED"

    patch_items = {
        result["finalItem"]: result["quantity"]["value"]
        for result in slot_results
        if result["decision"] == "MATCH"
    }
    patch = {
        "type": "master_inventory_patch",
        "version": 1,
        "items": dict(sorted(patch_items.items())),
    }
    report = {
        "schemaVersion": 1,
        "input": {"path": str(image_path), "sha256": sha256_file(image_path), "width": image.width, "height": image.height},
        "grid": {
            "origin": {"x": xgrid.origin, "y": ygrid.origin},
            "period": xgrid.period,
            "slotWidth": xgrid.width,
            "gap": xgrid.period - xgrid.width,
            "columns": xgrid.count,
            "rows": ygrid.count,
            "xPeakScore": xgrid.peak_score,
            "yPeakScore": ygrid.peak_score,
            **validation,
        },
        "thresholds": {
            "iconScoreMax": ICON_SCORE_MAX,
            "iconGapMin": ICON_GAP_MIN,
            "quantityPresenceMargin": OCR_PRESENCE_MARGIN,
            "quantityDigitGapMin": OCR_DIGIT_GAP_MIN,
            "status": "prototype_not_final",
        },
        "quantityMethod": {
            "method": "local game-font nearest-neighbour templates",
            "crop": "inner-slot y=28:40; four right-aligned 8px cells at x=31-8*k",
            "preprocess": "white-core mask: maxRGB>0.50 and chroma range<0.25",
            "externalApi": False,
        },
        "duplicates": duplicates,
        "slots": slot_results,
        "patch": patch,
    }
    return patch, report


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    script_dir = Path(__file__).resolve().parent
    root = script_dir.parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("screenshot", type=Path)
    parser.add_argument("--reference", type=Path, default=root / "reference" / "barter_items.json")
    parser.add_argument("--templates", type=Path, default=script_dir / "quantity_templates.npz")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    try:
        patch, report = convert(args.screenshot, args.reference, args.templates)
    except GridDetectionError:
        print("SLOT_GRID_DETECTION_FAILED", file=sys.stderr)
        return 2
    if args.output:
        _write_json(args.output, patch)
    else:
        print(json.dumps(patch, ensure_ascii=False, indent=2))
    if args.report:
        _write_json(args.report, report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
