"""Local image-to-list reader. Display candidates have no persistence authority."""
from __future__ import annotations

import json
import math
import re
import statistics
import unicodedata
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from local_app.backend.services.trade_recognition import _edge_profile, _separator_peaks

FIELDS = ("island", "fromItem", "reqAmount", "toItem", "count", "yield")
NUMERIC = {"reqAmount", "count", "yield"}


class LocalReader:
    def __init__(self, model_dir: Path):
        import onnxruntime as ort
        import yaml

        config = yaml.safe_load((model_dir / "inference.yml").read_text(encoding="utf-8"))
        self.characters = [""] + config["PostProcess"]["character_dict"] + [" "]
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        self.session = ort.InferenceSession(str(model_dir / "inference.onnx"), options,
                                            providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name

    def read(self, image: Image.Image, digits: bool = False, allowed_digits: str | None = None):
        import cv2

        rgb = np.asarray(image.convert("RGB"))[:, :, ::-1]
        width = min(3200, max(320, math.ceil(48 * image.width / image.height)))
        resized_width = min(width, math.ceil(48 * image.width / image.height))
        resized = cv2.resize(rgb, (resized_width, 48)).astype(np.float32)
        tensor = np.zeros((1, 3, 48, width), dtype=np.float32)
        tensor[0, :, :, :resized_width] = (resized.transpose(2, 0, 1) / 255 - .5) / .5
        probabilities = self.session.run(None, {self.input_name: tensor})[0][0]
        if digits:
            allowed = [0] + [i for i, char in enumerate(self.characters) if char in (allowed_digits or "0123456789") and char]
            indexes = np.array(allowed)[probabilities[:, allowed].argmax(axis=1)]
        else:
            indexes = probabilities.argmax(axis=1)
        text, scores, previous = [], [], -1
        for position, index in enumerate(indexes):
            if index and index != previous:
                text.append(self.characters[index])
                scores.append(float(probabilities[position, index]))
            previous = index
        return unicodedata.normalize("NFC", "".join(text)).strip(), (statistics.mean(scores) if scores else 0)


def detect_live_rows(image: Image.Image):
    profile = _edge_profile(np.asarray(image.convert("RGB")), 12)
    peaks = _separator_peaks(profile, .45)
    spans = [(top, bottom) for top, bottom in zip(peaks, peaks[1:])
             if image.width * .025 <= bottom - top <= image.width * .18]
    if not spans:
        return []
    spacing = statistics.median(bottom - top for top, bottom in spans)
    return [(top, bottom) for top, bottom in spans if .65 * spacing <= bottom - top <= 1.4 * spacing]


def _crop(row, bounds):
    x0, y0, x1, y1 = bounds
    return row.crop((round(x0 * row.width), round(y0 * row.height),
                     round(x1 * row.width), round(y1 * row.height)))


def _ink(image, numeric=False):
    rgb = np.asarray(image.convert("RGB")).astype(np.int16)
    maximum, minimum = rgb.max(axis=2), rgb.min(axis=2)
    if numeric:
        mask = (minimum > 155) & (maximum - minimum < 55)
    else:
        mask = ((maximum > 145) & (maximum - minimum < 95)) | ((maximum > 115) & (maximum - minimum > 35))
    return mask


def _tight(image, mask, padding=3):
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return None
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    return ImageOps.expand(image.crop(box), padding, fill="white")


def read_numeric(reader, crop, field, allowed_values=None):
    mask = _ink(crop, numeric=True)
    # Item artwork can be white too; the number is the rightmost baseline token.
    import cv2
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    eligible = [i for i in range(1, count) if stats[i, cv2.CC_STAT_HEIGHT] >= crop.height * .30
                and stats[i, cv2.CC_STAT_TOP] > 0]
    if eligible:
        mask = np.isin(labels, eligible)
    clean = Image.fromarray(np.where(mask, 0, 255).astype(np.uint8)).convert("RGB")
    tight = _tight(clean, mask)
    if tight is None:
        return {"rawOCR": "", "corrected": None, "reviewRequired": True, "confidence": None, "variants": []}
    variants = [tight, tight.resize((tight.width * 3, tight.height * 3), Image.Resampling.LANCZOS),
                ImageOps.invert(tight)]
    readings = [reader.read(variant, digits=True) for variant in variants]
    original = [reader.read(crop), reader.read(ImageOps.grayscale(crop))]
    candidates = readings
    if allowed_values is not None:
        candidates = [reader.read(variant, digits=True, allowed_digits="".join(map(str, allowed_values)))
                      for variant in variants]
    valid = [(int(text), score) for text, score in candidates if re.fullmatch(r"\d+", text)
             and (field == "count" or int(text) >= 1)
             and (allowed_values is None or int(text) in allowed_values)]
    votes = Counter(value for value, score in valid if score >= .5)
    value, vote = votes.most_common(1)[0] if votes else (None, 0)
    confidence = max((score for candidate, score in valid if candidate == value), default=0)
    certain = vote >= 2 and confidence >= .7
    originals = [(int(text), score) for text, score in original if re.fullmatch(r"\d+", text)
                 and (field == "count" or int(text) >= 1)
                 and (allowed_values is None or int(text) in allowed_values)]
    if not certain and len(originals) == 2 and originals[0][0] == originals[1][0] and min(score for _, score in originals) >= .5:
        value = originals[0][0]
        confidence = max(score for _, score in originals)
        certain = confidence >= .75
    enhanced = []
    enhanced_agreement = False
    if allowed_values is None:
        baseline = ImageOps.expand(crop.crop((0, round(crop.height * .15), crop.width, crop.height)), 3, fill="black")
        enhanced = [reader.read(baseline), reader.read(ImageOps.invert(baseline)), reader.read(ImageOps.invert(crop))]
        lower = [(int(text), score) for text, score in enhanced[:2] if re.fullmatch(r"\d+", text) and int(text) >= 1]
        if len(lower) == 2 and lower[0][0] == lower[1][0] and min(score for _, score in lower) >= .8:
            value, confidence = lower[0][0], min(score for _, score in lower)
            certain = enhanced_agreement = True
        else:
            color_votes = [(int(text), score) for text, score in original + enhanced[2:]
                           if re.fullmatch(r"\d+", text) and int(text) >= 1 and score >= .6]
            if len(color_votes) >= 2 and len({candidate for candidate, _ in color_votes}) == 1 and max(score for _, score in color_votes) >= .75:
                value = color_votes[0][0]
                confidence = max(score for _, score in color_votes)
                certain = enhanced_agreement = True
    conflicts = originals + ([(int(text), score) for text, score in readings
                              if text.isdigit() and int(text) in allowed_values] if allowed_values is not None else [])
    return {"rawOCR": readings[0][0], "corrected": value if certain else None,
            "reviewRequired": not certain or (not enhanced_agreement and any(candidate != value and score >= .5 for candidate, score in conflicts))
                or (allowed_values is not None and len(votes) > 1), "confidence": confidence,
            "variants": [{"text": text, "confidence": score} for text, score in readings + original + enhanced + (candidates if allowed_values else [])],
            **({"allowedValues": list(allowed_values), "valueSource": "CONSTRAINED_OCR"} if allowed_values else {})}


def trade_stages(fields, item_stages):
    return tuple(item_stages.get(fields[key].get("corrected")) if not fields[key]["reviewRequired"] else None
                 for key in ("fromItem", "toItem"))


def apply_trade_rules(fields, item_stages):
    source, destination = trade_stages(fields, item_stages)
    fixed = {}
    if source in range(1, 8) or destination in {2, 3, 4, 5, 6, 7, "coin", "special"}:
        fixed["reqAmount"] = (1, "TRADE_ITEM_REQUIREMENT_ONE")
    if destination == 1 and source is None and (fields["fromItem"].get("corrected") or fields["fromItem"].get("rawOCR")):
        fixed["yield"] = (1, "LAND_TO_STAGE_1")
    elif (source, destination) == (3, 4):
        fixed["yield"] = (2, "STAGE_3_TO_4")
    elif (source, destination) in {(4, 5), (5, 6), (6, 7)}:
        fixed["yield"] = (1, f"STAGE_{source}_TO_{destination}")
    for key, (value, rule) in fixed.items():
        fields[key].update(corrected=value, reviewRequired=False, valueSource="TRADE_RULE", rule=rule)
    return fields


def _normalize(text):
    text = re.sub(r"^[\[|I1]*(?:\d+\s*단계)[\]I|l1 ]*", "", text.strip())
    return re.sub(r"[^가-힣a-zA-Z0-9]", "", unicodedata.normalize("NFC", text))


def _distance(left, right):
    previous = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        current = [i]
        for j, b in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (a != b)))
        previous = current
    return previous[-1]


def correct_name(raw, candidates):
    target = _normalize(raw)
    if not target:
        return None, True
    ranked = []
    for name in candidates:
        normalized = _normalize(name)
        similarity = 1 - _distance(target, normalized) / max(len(target), len(normalized))
        if ("..." in raw or "…" in raw) and normalized.startswith(target) and len(target) >= 6:
            similarity = 1
        ranked.append((similarity, name))
    ranked.sort(reverse=True)
    if ranked and ranked[0][0] >= .65:
        ambiguous = len(ranked) > 1 and ranked[0][0] - ranked[1][0] < .10
        return ranked[0][1], ambiguous or ranked[0][0] < .75
    return re.sub(r"^[\[|I1]*(?:\d+\s*단계)[\]I|l1 ]*", "", raw.strip()), True


def read_count(reader, crop):
    raw, score = read_name(reader, crop)
    match = re.search(r"(?:[:：]\s*|횟수\s*)([0-9]+)\s*회", raw)
    if match is None:
        match = re.fullmatch(r"\s*([0-9]+)\s*회\s*", raw)
    value = int(match.group(1)) if match and score >= .65 else None
    return {"rawOCR": raw, "corrected": value, "reviewRequired": value is None, "confidence": score}


def read_name(reader, crop):
    mask = _ink(crop)
    occupied = np.flatnonzero(mask.sum(axis=1) >= 2)
    if not len(occupied):
        return "", 0
    groups = np.split(occupied, np.where(np.diff(occupied) > 2)[0] + 1)
    readings = []
    for group in groups:
        if len(group) < 3:
            continue
        top, bottom = int(group[0]), int(group[-1]) + 1
        line_mask = mask[top:bottom]
        clean = Image.fromarray(np.where(line_mask, 0, 255).astype(np.uint8)).convert("RGB")
        tight = _tight(clean, line_mask)
        if tight:
            readings.append(reader.read(tight))
    return " ".join(text for text, score in readings), min((score for text, score in readings), default=0)


def recognize_live(captures, model_dir, batch_id):
    reader = LocalReader(model_dir)
    try:
        catalog = json.loads((Path(__file__).resolve().parents[1] / "frontend/data/trade-catalog.json").read_text(encoding="utf-8"))
        items = list(dict.fromkeys([name for names in catalog["masterData"].values() for name in names] + catalog["specialItems"]))
        islands = list(dict.fromkeys(catalog["islands"] + catalog["t6Islands"] + catalog["t7Islands"]))
        item_stages = {name: int(stage) for stage, names in catalog["masterData"].items() for name in names}
        item_stages.update({name: "coin" if "까마귀" in name else "special" for name in catalog["specialItems"]})
    except (OSError, ValueError, KeyError, TypeError):
        items, islands, item_stages = [], [], {}
    bounds = {"island": (.063, .05, .241, .48), "fromItem": (.340, .10, .558, .47),
              "toItem": (.714, .10, .931, .87), "count": (.064, .47, .233, .83),
              "reqAmount": (.287, .55, .328, .84), "yield": (.665, .55, .710, .84)}
    rows, capture_results = [], []
    for capture in captures:
        image = Image.open(capture["imagePath"]).convert("RGB")
        boxes = detect_live_rows(image)
        capture_results.append({"captureId": capture["captureId"], "rows": len(boxes),
                                "width": image.width, "height": image.height})
        for ordinal, (top, bottom) in enumerate(boxes):
            row = image.crop((0, top, image.width, bottom))
            fields = {key: {"rawOCR": "", "corrected": None, "reviewRequired": True, "confidence": None} for key in NUMERIC}
            for field in ("island", "fromItem", "toItem", "count", "reqAmount", "yield"):
                crop = _crop(row, bounds[field])
                try:
                    if field == "count":
                        fields[field] = read_count(reader, crop)
                    elif field in NUMERIC:
                        apply_trade_rules(fields, item_stages)
                        if fields[field].get("valueSource") == "TRADE_RULE":
                            continue
                        source, destination = trade_stages(fields, item_stages)
                        allowed = (2, 3) if field == "yield" and (source, destination) in {(1, 2), (2, 3)} else None
                        fields[field] = read_numeric(reader, crop, field, allowed_values=allowed)
                    else:
                        raw, score = read_name(reader, crop)
                        value, review = correct_name(raw, islands if field == "island" else items)
                        fields[field] = {"rawOCR": raw, "corrected": value, "reviewRequired": review,
                                         "confidence": score}
                except Exception as error:
                    fields[field] = {"rawOCR": "", "corrected": None, "reviewRequired": True,
                                     "confidence": None, "error": type(error).__name__}
            apply_trade_rules(fields, item_stages)
            rows.append({"captureId": capture["captureId"], "ordinal": ordinal,
                         "rowBox": {"x": 0, "y": top, "width": image.width, "height": bottom - top},
                         "fields": fields})
    return {"version": 3, "batchId": batch_id, "rows": rows, "captures": capture_results,
            "engine": "korean_PP-OCRv5_mobile_rec/ONNX-CPU", "rowDetector": "measured-separator-spacing-v1"}
