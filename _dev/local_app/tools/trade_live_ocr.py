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
    rows = [(top, bottom) for top, bottom in spans if .65 * spacing <= bottom - top <= 1.4 * spacing]
    # The bottom border can fall outside a capture while the entire row is visible.
    if peaks and .90 * spacing <= image.height - peaks[-1] <= 1.10 * spacing:
        rows.append((peaks[-1], image.height))
    return rows


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


def _requirement_crop(row):
    compact = _crop(row, (.287, .55, .328, .84))
    mask = _ink(compact, numeric=True)
    if mask.any() and not mask[:, -1].any() and not mask[-1, :].any():
        # A trailing digit may lie entirely beyond the blank compact boundary.
        wide = _crop(row, (.287, .55, .340, .93))
        outside = _ink(wide, numeric=True)
        outside[:compact.height, :compact.width] = False
        ys = np.flatnonzero(outside.any(axis=1))
        if not len(ys) or ys[-1] - ys[0] + 1 < wide.height * .30:
            return compact
        return wide
    return _crop(row, (.287, .55, .340, .93))


def read_quantity_token(reader, row, field, allowed_values=None, destination=None):
    """Keep anti-aliased digit edges and read the complete right-aligned token."""
    import cv2

    crop = _crop(row, (.690 if allowed_values else .663, .55 if allowed_values else .50, .714, .84) if field == "yield" else (.287, .48, .340, .84))
    rgb = np.asarray(crop.convert("RGB")).astype(np.int16)
    readings = []
    clipped = False
    for threshold in (80, 120):
        mask = (rgb.min(axis=2) > threshold) & (rgb.max(axis=2) - rgb.min(axis=2) < 55)
        count, _, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
        candidates = [stat for stat in stats[1:] if stat[cv2.CC_STAT_HEIGHT] >= crop.height * .30
                      and stat[cv2.CC_STAT_TOP] > 0]
        if not candidates:
            if allowed_values is None or not mask.any():
                continue
            ys, xs = np.nonzero(mask)
            candidates = [np.array([xs.min(), ys.min(), xs.max()-xs.min()+1, ys.max()-ys.min()+1, len(xs)])]
        anchor = max(candidates, key=lambda stat: stat[cv2.CC_STAT_LEFT] + stat[cv2.CC_STAT_WIDTH])
        top, height = int(anchor[cv2.CC_STAT_TOP]), int(anchor[cv2.CC_STAT_HEIGHT])
        top = max(0, top - 1)
        height = min(crop.height - top, height + 2)
        band = mask[top:top + height]
        columns = np.flatnonzero(band.any(axis=0))
        groups = np.split(columns, np.where(np.diff(columns) > max(2, round(height * .6)))[0] + 1)
        token = groups[-1]
        left, right = int(token[0]), int(token[-1]) + 1
        clipped |= left == 0 or right == crop.width or bool(mask[-1, left:right].any())
        color = ImageOps.expand(crop.crop((left, top, right, top + height)), 3, fill="black")
        clean = ImageOps.expand(Image.fromarray(np.where(band[:, left:right], 0, 255).astype(np.uint8)), 3, fill="white").convert("RGB")
        for image in (color, ImageOps.invert(color), clean, ImageOps.invert(clean)):
            readings.append(reader.read(image))
    if destination == "coin":
        narrow = _crop(row, (.687, .55, .714, .84))
        pixels = np.asarray(narrow).astype(np.int16)
        mask = (pixels.min(axis=2) > 80) & (pixels.max(axis=2) - pixels.min(axis=2) < 55)
        ys, xs = np.nonzero(mask)
        if len(xs) and xs.min() > 0 and xs.max() < narrow.width - 1:
            box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
            color = ImageOps.expand(narrow.crop(box), 3, fill="black")
            clean = ImageOps.expand(Image.fromarray(np.where(mask, 0, 255).astype(np.uint8)).crop(box), 3, fill="white").convert("RGB")
            readings.extend(reader.read(image) for image in (color, ImageOps.invert(color), clean, ImageOps.invert(clean)))
    valid = [(int(text), score) for text, score in readings if re.fullmatch(r"\d+", text)
             and int(text) >= 1 and (allowed_values is None or int(text) in allowed_values)]
    votes = Counter(value for value, score in valid if score >= .8)
    value, vote = votes.most_common(1)[0] if votes else (None, 0)
    conflict = any(candidate != value and score >= .75 for candidate, score in valid)
    return {"corrected": value, "reviewRequired": vote < 2 or conflict or clipped,
            "confidence": max((score for candidate, score in valid if candidate == value), default=0),
            "variants": [{"text": text, "confidence": score} for text, score in readings]}


def merge_quantity_readings(primary, token, allowed_values=None, field=None):
    combined = primary["variants"] + token["variants"]
    if not token["reviewRequired"]:
        conflict = field == "reqAmount" and any(reading["text"].isdigit() and int(reading["text"]) >= 1
                   and int(reading["text"]) != token["corrected"] and reading["confidence"] >= .5
                   for reading in primary["variants"])
        return {**primary, **token, "rawOCR": primary["rawOCR"], "variants": combined,
                "reviewRequired": conflict,
                **({"allowedValues": list(allowed_values), "valueSource": "CONSTRAINED_OCR"} if allowed_values else {})}
    conflicts = [reading for reading in token["variants"] if reading["text"].isdigit()
                 and reading["confidence"] >= .5 and int(reading["text"]) != primary["corrected"]]
    return {**primary, "variants": combined, "reviewRequired": primary["reviewRequired"] or bool(conflicts)}


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
            # Background artwork must not replace unanimous, stronger digit-only evidence.
            strong_digits = len(valid) == 3 and vote == 3 and min(score for _, score in valid) >= .9
            color_confidence = max((score for _, score in color_votes), default=0)
            if (len(color_votes) >= 2 and len({candidate for candidate, _ in color_votes}) == 1
                    and color_confidence >= .75 and (not strong_digits or color_confidence >= confidence)):
                value = color_votes[0][0]
                confidence = max(score for _, score in color_votes)
                certain = enhanced_agreement = True
    conflicts = originals + ([(int(text), score) for text, score in readings
                              if text.isdigit() and int(text) in allowed_values] if allowed_values is not None else [])
    requirement_clipped = field == "reqAmount" and bool(mask[:, -1].any() or mask[-1, :].any())
    result_clipped = field == "yield" and allowed_values is None and bool(mask[:, 0].any() or mask[:, -1].any() or mask[-1, :].any())
    requirement_conflict = field == "reqAmount" and any(
        int(text) != value and int(text) >= 1 and score >= .5
        for text, score in readings + original + enhanced if re.fullmatch(r"\d+", text))
    return {"rawOCR": readings[0][0], "corrected": value if certain else None,
            "reviewRequired": not certain or (not enhanced_agreement and any(candidate != value and score >= .5 for candidate, score in conflicts))
                or (allowed_values is not None and len(votes) > 1) or requirement_clipped or requirement_conflict or result_clipped, "confidence": confidence,
            "variants": [{"text": text, "confidence": score} for text, score in readings + original + enhanced + (candidates if allowed_values else [])],
            **({"allowedValues": list(allowed_values), "valueSource": "CONSTRAINED_OCR"} if allowed_values else {})}


def trade_stages(fields, item_stages):
    return tuple(item_stages.get(fields[key].get("corrected")) or fields[key].get("recognizedStage")
                 for key in ("fromItem", "toItem"))


def apply_trade_rules(fields, item_stages):
    source, destination = trade_stages(fields, item_stages)
    fixed = {}
    if destination != 1 and (source in range(1, 8) or destination in {2, 3, 4, 5, 6, 7, "coin", "special"}):
        fixed["reqAmount"] = (1, "TRADE_ITEM_REQUIREMENT_ONE")
    if destination == 1:
        fixed["yield"] = (1, "LAND_TO_STAGE_1")
    elif destination == 4:
        fixed["yield"] = (2, "STAGE_3_TO_4")
    elif destination in {5, 6, 7}:
        fixed["yield"] = (1, f"STAGE_{source}_TO_{destination}")
    if _normalize(fields["toItem"].get("corrected") or "") in {
            "유실된무역품상자", "화려한진주결정", "화려한암염주괴"}:
        fixed["yield"] = (1, "SPECIAL_OUTPUT_ONE")
    for key, (value, rule) in fixed.items():
        fields[key].update(corrected=value, reviewRequired=False, valueSource="TRADE_RULE", rule=rule)
        fields[key].pop("allowedValues", None)
    return fields


def _strip_stage(text):
    text = re.sub(r"^\s*[\[|]\s*[1-7SIil/?>]\s*[가-힣]{1,3}\s*[\]|!]\s*", "", text.strip())
    return re.sub(r"^\s*[\[|]?\s*[1-7SIil/?>]\s*[단딘난뒤]\s*[계제]\s*[\]|]?\s*", "", text)


def _normalize(text):
    text = _strip_stage(text)
    return re.sub(r"[^가-힣a-zA-Z0-9]", "", unicodedata.normalize("NFC", text))


def _distance(left, right):
    previous = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        current = [i]
        for j, b in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (a != b)))
        previous = current
    return previous[-1]


def correct_name(raw, candidates, literal_candidates=()):
    target = _normalize(raw)
    if not target:
        return None, True
    for name in literal_candidates:
        if _normalize(name) == target:
            return name, False
    ranked = []
    for name in candidates:
        normalized = _normalize(name)
        similarity = 1 - _distance(target, normalized) / max(len(target), len(normalized))
        if normalized.startswith(target) and len(target) >= 6:
            similarity = 1
        ranked.append((similarity, name))
    ranked.sort(reverse=True)
    if ranked and ranked[0][0] >= .65:
        ambiguous = len(ranked) > 1 and ranked[0][0] - ranked[1][0] < .10
        normalized = _normalize(ranked[0][1])
        return ranked[0][1], ambiguous or ranked[0][0] < .75
    return _strip_stage(raw), True


def read_count(reader, crop):
    raw, score = read_name(reader, crop)
    match = re.search(r"(?:[:：]\s*|횟수\s*)([0-9]+)\s*회", raw)
    if match is None:
        match = re.fullmatch(r"\s*([0-9]+)\s*회\s*", raw)
    value = int(match.group(1)) if match and score >= .65 else None
    if value is None and reader is not None:
        alternatives = [reader.read(crop), reader.read(ImageOps.grayscale(crop))]
        numbers = []
        for text, confidence in alternatives:
            found = re.search(r"(?:[:：]\s*|횟수\s*)([0-9]+)\s*회", text)
            if found and confidence >= .85:
                numbers.append((int(found.group(1)), confidence))
        if len(numbers) == 2 and numbers[0][0] == numbers[1][0]:
            value, score = numbers[0][0], min(confidence for _, confidence in numbers)
    return {"rawOCR": raw, "corrected": value, "reviewRequired": value is None, "confidence": score}


def _coin_quantity_crop(row):
    import cv2

    compact = _crop(row, (.675, .55, .715, .93))
    wide = _crop(row, (.663, .55, .715, .93))
    mask = _ink(wide, numeric=True)
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    digits = [stats[i] for i in range(1, count)
              if stats[i, cv2.CC_STAT_HEIGHT] >= wide.height * .30 and stats[i, cv2.CC_STAT_TOP] > 0]
    if not digits:
        return compact
    anchor = max(digits, key=lambda stat: stat[cv2.CC_STAT_LEFT] + stat[cv2.CC_STAT_WIDTH])
    top, bottom = anchor[cv2.CC_STAT_TOP], anchor[cv2.CC_STAT_TOP] + anchor[cv2.CC_STAT_HEIGHT]
    offset = wide.width - compact.width
    # Expand when a complete leading digit lies beyond the compact crop, even across a blank gap.
    for stat in digits:
        overlap = min(bottom, stat[cv2.CC_STAT_TOP] + stat[cv2.CC_STAT_HEIGHT]) - max(top, stat[cv2.CC_STAT_TOP])
        if stat[cv2.CC_STAT_LEFT] < offset and overlap >= .7 * max(anchor[cv2.CC_STAT_HEIGHT], stat[cv2.CC_STAT_HEIGHT]):
            return wide
    return compact


def read_yield(reader, row, allowed_values=None, destination=None):
    token = read_quantity_token(reader, row, "yield", allowed_values, destination)
    if not token["reviewRequired"]:
        return {**token, "rawOCR": token["variants"][0]["text"],
                **({"allowedValues": list(allowed_values), "valueSource": "CONSTRAINED_OCR"} if allowed_values else {})}
    bounds = (.665, .55, .724, .95) if allowed_values is None else (.665, .55, .710, .84)
    crop = _coin_quantity_crop(row) if destination == "coin" else _crop(row, bounds)
    result = read_numeric(reader, crop, "yield", allowed_values)
    if not token["reviewRequired"] or result["corrected"] is not None or allowed_values is None:
        return merge_quantity_readings(result, token, allowed_values)
    alternatives = [read_numeric(reader, _crop(row, bounds), "yield", allowed_values)
                    for bounds in ((.700, .55, .712, .93), (.680, .55, .710, .93))]
    certain = [value for value in alternatives if value["corrected"] is not None and not value["reviewRequired"]]
    if not certain:
        return merge_quantity_readings(result, token, allowed_values)
    selected = max(certain, key=lambda value: value["confidence"])
    variants = result["variants"] + [reading for value in alternatives for reading in value["variants"]]
    conflict = any(reading["text"].isdigit() and int(reading["text"]) in allowed_values
                   and int(reading["text"]) != selected["corrected"] and reading["confidence"] >= .8
                   for reading in variants)
    return merge_quantity_readings({**selected, "rawOCR": result["rawOCR"], "variants": variants,
            "reviewRequired": conflict or len({value["corrected"] for value in certain}) > 1}, token, allowed_values)


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


def read_catalog_name(reader, crop, candidates, literal_candidates=()):
    raw, score = read_name(reader, crop)
    value, review = correct_name(raw, candidates, literal_candidates)
    variants = [(raw, score)]
    if review or score < .9 or _normalize(raw) != _normalize(value or ""):
        for image in (crop, ImageOps.grayscale(crop)):
            try:
                text, confidence = reader.read(image)
                variants.append((text, confidence))
            except Exception:
                continue
        alternatives = [(correct_name(text, candidates, literal_candidates), confidence)
                        for text, confidence in variants[1:]]
        if (len(alternatives) == 2 and alternatives[0][0][0] == alternatives[1][0][0]
                and all(not decision[1] and confidence >= .75 for decision, confidence in alternatives)):
            selected = alternatives[0][0][0]
            conflict = not review and value != selected
            value, score, review = selected, min(confidence for _, confidence in alternatives), conflict
        elif review:
            known = set(candidates) | set(literal_candidates)
            suggestions = [(correct_name(text, candidates, literal_candidates)[0], confidence)
                           for text, confidence in variants]
            suggestions = [(name, confidence) for name, confidence in suggestions if name in known]
            if suggestions:
                value, score = max(suggestions, key=lambda entry: entry[1])
    stages = []
    for text, confidence in variants:
        match = re.match(r"^\s*[\[|]?\s*([1-7])\s*(?:단계|[가-힣]{1,3}[\]|!])", text)
        if match and confidence >= .75:
            stages.append(int(match.group(1)))
    recognized_stage = stages[0] if len(stages) >= 2 and len(set(stages)) == 1 else None
    return {"rawOCR": raw, "corrected": value, "reviewRequired": review, "confidence": score,
            "masterMatch": "UNRESOLVED" if review else "RESOLVED", "valueSource": "MASTER" if not review else "OCR_CANDIDATE",
            "variants": [{"text": text, "confidence": confidence} for text, confidence in variants],
            **({"recognizedStage": recognized_stage} if recognized_stage is not None else {})}


def recognize_live(captures, model_dir, batch_id):
    reader = LocalReader(model_dir)
    try:
        catalog = json.loads((Path(__file__).resolve().parents[1] / "frontend/data/trade-catalog.json").read_text(encoding="utf-8"))
        items = list(dict.fromkeys([name for names in catalog["masterData"].values() for name in names] + catalog["specialItems"]))
        islands = list(dict.fromkeys(catalog["islands"] + catalog["t6Islands"] + catalog["t7Islands"]))
        item_stages = {name: int(stage) for stage, names in catalog["masterData"].items() for name in names}
        item_stages.update({name: "coin" if "까마귀" in name else "special" for name in catalog["specialItems"]})
        land_items = catalog["masterData"].get("0", catalog.get("landItems", []))
    except (OSError, ValueError, KeyError, TypeError):
        items, islands, item_stages = [], [], {}
        land_items = []
    bounds = {"island": (.063, .05, .241, .48), "fromItem": (.340, .10, .558, .47),
              "toItem": (.714, .10, .931, .87), "count": (.064, .47, .233, .83),
              "reqAmount": (.287, .55, .340, .93), "yield": (.663, .55, .724, .95)}
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
                    if field == "reqAmount":
                        crop = _requirement_crop(row)
                    if field == "count":
                        fields[field] = read_count(reader, crop)
                    elif field in NUMERIC:
                        apply_trade_rules(fields, item_stages)
                        if fields[field].get("valueSource") == "TRADE_RULE":
                            continue
                        source, destination = trade_stages(fields, item_stages)
                        allowed = (2, 3) if field == "yield" and (source, destination) in {(1, 2), (2, 3)} else None
                        fields[field] = (read_yield(reader, row, allowed, destination) if field == "yield"
                                         else merge_quantity_readings(read_numeric(reader, crop, field, allowed_values=allowed),
                                                                      read_quantity_token(reader, row, field), field=field))
                    else:
                        fields[field] = read_catalog_name(reader, crop, islands if field == "island" else items,
                                                          land_items if field == "fromItem" else ())
                        if field == "toItem" and (item_stages.get(fields[field].get("corrected")) or fields[field].get("recognizedStage")) == 1:
                            fields["fromItem"] = read_catalog_name(reader, _crop(row, bounds["fromItem"]), land_items, land_items)
                except Exception as error:
                    fields[field] = {"rawOCR": "", "corrected": None, "reviewRequired": True,
                                     "confidence": None, "error": type(error).__name__}
            apply_trade_rules(fields, item_stages)
            for key, (x0, y0, x1, y1) in bounds.items():
                left, upper = round(x0 * row.width), round(y0 * row.height)
                right, lower = round(x1 * row.width), round(y1 * row.height)
                fields[key]["box"] = {"x": left, "y": top + upper,
                                      "width": right - left, "height": lower - upper}
            rows.append({"captureId": capture["captureId"], "ordinal": ordinal,
                         "rowBox": {"x": 0, "y": top, "width": image.width, "height": bottom - top},
                         "fields": fields})
    return {"version": 3, "batchId": batch_id, "rows": rows, "captures": capture_results,
            "engine": "korean_PP-OCRv5_mobile_rec/ONNX-CPU", "rowDetector": "measured-separator-spacing-v1"}
