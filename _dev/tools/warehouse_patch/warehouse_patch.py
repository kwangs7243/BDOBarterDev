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
    period: float
    width: int
    count: int
    peak_score: float
    positions: tuple[int, ...] = ()
    sizes: tuple[int, ...] = ()


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
    if abs(xgrid.period - ygrid.period) > 1 or abs(xgrid.width - ygrid.width) > 1:
        raise GridDetectionError("SLOT_GRID_DETECTION_FAILED")
    period, width = xgrid.period, xgrid.width
    gap = period - width
    if gap < 2 or gap > max(10, period * 0.20):
        raise GridDetectionError("SLOT_GRID_DETECTION_FAILED")
    valid = 0
    contrast_values: list[float] = []
    gap_values: list[float] = []
    total = xgrid.count * ygrid.count
    for row in range(ygrid.count):
        for col in range(xgrid.count):
            x = xgrid.positions[col] if xgrid.positions else round(xgrid.origin + col * xgrid.period)
            y = ygrid.positions[row] if ygrid.positions else round(ygrid.origin + row * ygrid.period)
            cell_width = xgrid.sizes[col] if xgrid.sizes else xgrid.width
            cell_height = ygrid.sizes[row] if ygrid.sizes else ygrid.width
            slot = rgb[y : y + cell_height, x : x + cell_width]
            if slot.shape[:2] != (cell_height, cell_width):
                continue
            border = np.concatenate(
                [slot[0, :, :].ravel(), slot[-1, :, :].ravel(), slot[:, 0, :].ravel(), slot[:, -1, :].ravel()]
            )
            if xgrid.positions or ygrid.positions:
                border = np.concatenate([slot[:2].max(axis=0).ravel(), slot[-2:].max(axis=0).ravel(),
                                         slot[:, :2].max(axis=1).ravel(), slot[:, -2:].max(axis=1).ravel()])
            inner = slot[2:-2, 2:-2, :].ravel()
            contrast = float(border.mean() - inner.mean())
            contrast_values.append(contrast)
            gx0 = x + cell_width
            gy0 = y + cell_height
            gap = max(1, round(period - width))
            gaps: list[np.ndarray] = []
            if gx0 + gap <= rgb.shape[1]:
                gaps.append(rgb[y : y + cell_height, gx0 : gx0 + gap])
            if gy0 + gap <= rgb.shape[0]:
                gaps.append(rgb[gy0 : gy0 + gap, x : x + cell_width])
            gap_mean = float(np.mean([value.mean() for value in gaps])) if gaps else 0.0
            gap_values.append(gap_mean)
            # A bright item can fill a small cell; validate its frame against the gap, not the icon.
            frame_contrast = float(border.mean()) - gap_mean if xgrid.positions or ygrid.positions else contrast
            if frame_contrast > 0.015 and (not gaps or gap_mean < 0.35):
                valid += 1
    ratio = valid / total if total else 0.0
    if ratio < 0.80:
        raise GridDetectionError("SLOT_GRID_DETECTION_FAILED")
    return {
        "validatedCellRatio": ratio,
        "meanBorderContrast": float(np.mean(contrast_values)),
        "meanGapBrightness": float(np.mean(gap_values)),
    }


def _scaled_axis_grids(profile: np.ndarray) -> list[AxisGrid]:
    threshold = max(0.005, float(profile.max()) * 0.12)
    peaks = np.flatnonzero((profile >= threshold) &
        (profile >= np.r_[profile[0], profile[:-1]]) &
        (profile >= np.r_[profile[1:], profile[-1]]))
    candidates = {}
    for first in peaks:
        for second in peaks[(peaks >= first + 16) & (peaks <= first + len(profile) // 2)]:
            period = int(second - first)
            rights = peaks[(peaks >= first + period * 0.80) & (peaks <= first + period * 0.94)]
            for right in rights:
                width = int(right - first + 1)
                positions, sizes, scores = [], [], []
                start = int(first)
                while start + width <= len(profile):
                    end0 = start + width - 1
                    end_lo, end_hi = max(start + 1, end0 - 1), min(len(profile), end0 + 2)
                    end = end_lo + int(np.argmax(profile[end_lo:end_hi]))
                    pair_score = float((profile[start] + profile[end]) / 2)
                    if min(profile[start], profile[end]) < max(0.005, float(profile.max()) * 0.08):
                        break
                    positions.append(start)
                    sizes.append(end - start + 1)
                    scores.append(pair_score)
                    next0 = start + period
                    lo, hi = max(start + width, next0 - 1), min(len(profile), next0 + 2)
                    if lo >= hi:
                        break
                    start = lo + int(np.argmax(profile[lo:hi]))
                if len(positions) < 2:
                    continue
                pitch = float(np.mean(np.diff(positions)))
                grid = AxisGrid(positions[0], pitch, int(round(float(np.median(sizes)))),
                    len(positions), float(np.mean(scores)), tuple(positions), tuple(sizes))
                key = (tuple(positions), tuple(sizes))
                candidates[key] = grid
    return list(candidates.values())


def _scaled_grid(rgb: np.ndarray) -> tuple[AxisGrid, AxisGrid, dict[str, float]]:
    axes = [_scaled_axis_grids(_brightness_peak_profile(rgb, axis)) for axis in (0, 1)]
    candidates = []
    for xgrid in axes[0]:
        for ygrid in axes[1]:
            if abs(xgrid.period - ygrid.period) > 1 or abs(xgrid.width - ygrid.width) > 1:
                continue
            score = xgrid.count * ygrid.count * min(xgrid.peak_score, ygrid.peak_score)
            candidates.append((score, xgrid, ygrid))
    for _, xgrid, ygrid in sorted(candidates, key=lambda candidate: candidate[0], reverse=True):
        try:
            return xgrid, ygrid, _validate_grid(rgb, xgrid, ygrid)
        except GridDetectionError:
            continue
    raise GridDetectionError("SLOT_GRID_DETECTION_FAILED")


def detect_grid(image: Image.Image) -> tuple[AxisGrid, AxisGrid, dict[str, float]]:
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    try:
        xgrid = _best_axis_grid(rgb, axis=0)
        ygrid = _best_axis_grid(rgb, axis=1)
        validation = _validate_grid(rgb, xgrid, ygrid)
        if xgrid.width == 45:
            return xgrid, ygrid, validation
    except GridDetectionError:
        pass
    return _scaled_grid(rgb)


def crop_inner_slots(image: Image.Image, xgrid: AxisGrid, ygrid: AxisGrid) -> list[dict[str, Any]]:
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    slots: list[dict[str, Any]] = []
    for row in range(ygrid.count):
        for col in range(xgrid.count):
            x = xgrid.positions[col] if xgrid.positions else round(xgrid.origin + col * xgrid.period)
            y = ygrid.positions[row] if ygrid.positions else round(ygrid.origin + row * ygrid.period)
            cell_width = xgrid.sizes[col] if xgrid.sizes else xgrid.width
            cell_height = ygrid.sizes[row] if ygrid.sizes else ygrid.width
            outer = rgb[y : y + cell_height, x : x + cell_width]
            border = max(1, round(xgrid.width / 45))
            inner = outer[border:-border, border:-border]
            source_size = (inner.shape[1], inner.shape[0])
            if outer.shape[:2] != (cell_height, cell_width) or not inner.size:
                raise GridDetectionError("SLOT_GRID_DETECTION_FAILED")
            if inner.shape[:2] != (43, 43):
                pixels = Image.fromarray(np.rint(inner * 255).astype(np.uint8))
                inner = np.asarray(pixels.resize((43, 43), Image.Resampling.LANCZOS), dtype=np.float32) / 255.0
            slots.append({"row": row + 1, "column": col + 1, "x": x, "y": y,
                          "width": cell_width, "height": cell_height, "source_size": source_size, "rgb": inner})
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
        with np.load(templates_path, allow_pickle=False) as archive:
            data = {key: archive[key] for key in archive.files}
        self.digit_features = data["digit_features"].astype(np.float32)
        self.digit_labels = data["digit_labels"].astype(np.int16)
        self.blank_features = [data[f"blank_features_{index}"].astype(np.float32) for index in range(4)]
        self.feedback_templates = None
        self.scaled_templates = {}
        self.feedback_slots = data["feedback_slots"] if "feedback_slots" in data else []
        self.feedback_values = data["feedback_values"] if "feedback_values" in data else []
        self.feedback_item_names = data["feedback_item_names"] if "feedback_item_names" in data else []
        self.feedback_icons = np.asarray(self.feedback_slots, dtype=np.float32) / 255.0
        if "feedback_digit_features" in data:
            self.feedback_templates = (
                np.concatenate([self.digit_features, data["feedback_digit_features"].astype(np.float32)]),
                np.concatenate([self.digit_labels, data["feedback_digit_labels"].astype(np.int16)]),
                [np.concatenate([self.blank_features[index], data[f"feedback_blank_features_{index}"].astype(np.float32)])
                 for index in range(4)],
            )

    def icon_scores(self, slot: np.ndarray, items: list[dict], references: np.ndarray) -> np.ndarray:
        scores = _icon_scores(slot, references)
        order = np.argsort(scores, kind="stable")
        if scores[order[0]] <= ICON_SCORE_MAX and scores[order[1]] - scores[order[0]] >= ICON_GAP_MIN:
            return scores
        if len(self.feedback_item_names):
            index = {item["programName"]: number for number, item in enumerate(items)}
            learned = _icon_scores(slot, self.feedback_icons)
            for name, score in zip(self.feedback_item_names, learned):
                if name in index:
                    scores[index[name]] = min(scores[index[name]], score)
        return scores

    @staticmethod
    def _distances(feature: np.ndarray, candidates: np.ndarray) -> np.ndarray:
        return np.sqrt(np.mean((candidates - feature) ** 2, axis=1))

    def _templates_for_size(self, size: tuple[int, int]):
        if size in self.scaled_templates:
            return self.scaled_templates[size]
        digits, labels, blanks = [], [], [[] for _ in range(4)]
        for pixels, value in zip(self.feedback_slots, self.feedback_values):
            numbers = [int(number) for number in reversed(str(value))]
            for width in range(max(8, size[0] - 1), size[0] + 2):
                for height in range(max(8, size[1] - 1), size[1] + 2):
                    image = Image.fromarray(pixels).resize((width, height), Image.Resampling.LANCZOS)
                    normalized = np.asarray(image.resize((43, 43), Image.Resampling.LANCZOS), dtype=np.float32) / 255.0
                    for index in range(4):
                        feature = quantity_cell_feature(normalized, index)
                        if index < len(numbers):
                            digits.append(feature)
                            labels.append(numbers[index])
                        else:
                            blanks[index].append(feature)
        original = self.feedback_templates or (self.digit_features, self.digit_labels, self.blank_features)
        result = (np.concatenate([original[0], digits]) if digits else original[0],
                  np.concatenate([original[1], labels]) if labels else original[1],
                  [np.concatenate([old, extra]) if extra else old for old, extra in zip(original[2], blanks)])
        self.scaled_templates[size] = result
        return result

    def read(self, slot: np.ndarray, source_size: tuple[int, int] = (43, 43)) -> dict[str, Any]:
        if source_size != (43, 43):
            templates = self._templates_for_size(source_size)
            result = self._read(slot, *templates)
            if result["status"] == "QUANTITY_MATCH":
                digits = result["digits"][:len(str(result["value"]))]
                if all(digit["digitDistance"] <= 0.35 or digit["digitGap"] >= 0.075 for digit in digits):
                    result["method"] = "scale-normalized-templates"
                    return result
                result = {"status": "QUANTITY_UNKNOWN", "value": None, "digits": result["digits"],
                          "reason": "normalized_digit_ambiguous"}
            # Pixel rounding can move the text baseline by one normalized pixel.
            alternatives = []
            for dy, dx in ((0, -1), (0, 1), (-1, 0), (1, 0)):
                candidate = self._read(np.roll(slot, (dy, dx), (0, 1)), *templates)
                if candidate["status"] != "QUANTITY_MATCH":
                    continue
                digits = candidate["digits"][:len(str(candidate["value"]))]
                if max(digit["digitDistance"] for digit in digits) <= 0.35:
                    alternatives.append(candidate)
            if alternatives and len({candidate["value"] for candidate in alternatives}) == 1:
                result = alternatives[0]
                result["method"] = "scale-aligned-templates"
            return result
        original = self._read(slot, self.digit_features, self.digit_labels, self.blank_features)
        if original["status"] == "QUANTITY_MATCH" or self.feedback_templates is None:
            return original
        corrected = self._read(slot, *self.feedback_templates)
        if corrected["status"] == "QUANTITY_MATCH":
            corrected["method"] = "verified-feedback-templates"
        return corrected

    def _read(self, slot: np.ndarray, digit_features: np.ndarray, digit_labels: np.ndarray,
              blank_features: list[np.ndarray]) -> dict[str, Any]:
        digits_reversed: list[int] = []
        details: list[dict[str, Any]] = []
        stopped = False
        for position in range(4):
            feature = quantity_cell_feature(slot, position)
            digit_distances = self._distances(feature, digit_features)
            order = np.argsort(digit_distances, kind="stable")
            best_index = int(order[0])
            best_digit_distance = float(digit_distances[best_index])
            best_label = int(digit_labels[best_index])
            second_distinct = next(
                (float(digit_distances[idx]) for idx in order[1:] if int(digit_labels[idx]) != best_label),
                float("inf"),
            )
            digit_gap = second_distinct - best_digit_distance
            blank_distance = float(self._distances(feature, blank_features[position]).min())
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
        source_size = slot_info.pop("source_size")
        result: dict[str, Any] = dict(slot_info)
        result["slot"] = f"R{result['row']}C{result['column']}"
        if _is_empty(slot):
            result.update({"decision": "EMPTY", "quantity": None})
            slot_results.append(result)
            continue
        scores = quantity_reader.icon_scores(slot, items, references)
        order = np.argsort(scores, kind="stable")
        first, second = int(order[0]), int(order[1])
        best, runner_up = items[first], items[second]
        best_score, second_score = float(scores[first]), float(scores[second])
        gap = second_score - best_score
        quantity = quantity_reader.read(slot, source_size)
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
