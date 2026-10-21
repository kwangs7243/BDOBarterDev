"""Verified whole-field foreground matching; unmatched inputs retain the OCR path."""
from __future__ import annotations
import hashlib
import json
import time
from pathlib import Path
from types import SimpleNamespace
import numpy as np
from PIL import Image

VERSION = "trade-field-binary-exact-v1"
BANK_SHA256 = "0dfcd5f8d7e2b77434604b9805ee11258586e0836df9e1217af8ea6eb01399d0"

def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")

def feature_key(mask, scaled=False):
    """Whole foreground, including every component; never match a substring."""
    if mask.size == 0 or not mask.any():
        return None
    ys, xs = np.nonzero(mask)
    tight = mask[ys.min():ys.max()+1, xs.min():xs.max()+1].astype(np.uint8)
    if scaled:
        width = max(1, round(tight.shape[1] * 32 / tight.shape[0]))
        if width > 1600:
            return None
        tight = np.asarray(Image.fromarray(tight).resize((width, 32), Image.Resampling.NEAREST))
    return f"{tight.shape[0]}x{tight.shape[1]}:" + hashlib.sha256(tight.tobytes()).hexdigest()


def text_mask(crop, module):
    mask = module._ink(crop)
    occupied = np.flatnonzero(mask.sum(axis=1) >= 2)
    if not len(occupied):
        return None
    groups = np.split(occupied, np.where(np.diff(occupied) > 2)[0]+1)
    lines = []
    for group in groups:
        if len(group) < 3:
            continue
        band = mask[int(group[0]):int(group[-1])+1]
        ys, xs = np.nonzero(band)
        if not len(xs) or xs.min() == 0 or xs.max() == crop.width-1:
            return None
        lines.append(band[:, xs.min():xs.max()+1])
    if not lines:
        return None
    width = max(x.shape[1] for x in lines)
    result = np.zeros((sum(x.shape[0] for x in lines)+3*(len(lines)-1), width), dtype=bool)
    offset = 0
    for line in lines:
        result[offset:offset+line.shape[0], :line.shape[1]] = line
        offset += line.shape[0]+3
    return result


def quantity_mask(row, field, module):
    """Outline extraction with a wider guard against omitted digits."""
    import cv2
    bounds = (.287, .55, .340, .93) if field == "reqAmount" else (.663, .50, .724, .95)
    crop = module._crop(row, bounds)
    rgb = np.asarray(crop.convert("RGB"), dtype=np.int16)
    white = (rgb.min(axis=2)>155) & (rgb.max(axis=2)-rgb.min(axis=2)<55)
    dark = (rgb.max(axis=2)<100).astype(np.uint8)
    mask = white & cv2.dilate(dark, np.ones((3, 3), dtype=np.uint8)).astype(bool)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    candidates = [i for i in range(1, count) if stats[i, cv2.CC_STAT_HEIGHT] >= crop.height*.30]
    if not candidates:
        return None
    anchor = stats[max(candidates, key=lambda i: stats[i, cv2.CC_STAT_LEFT]+stats[i, cv2.CC_STAT_WIDTH])]
    top, bottom = anchor[1], anchor[1]+anchor[3]
    candidates = [i for i in candidates if min(bottom, stats[i, 1]+stats[i, 3])-max(top, stats[i, 1]) >= .7*max(anchor[3], stats[i, 3])]
    selected = np.isin(labels, candidates)
    ys, xs = np.nonzero(selected)
    if not len(xs) or xs.min() == 0 or xs.max() == crop.width-1 or ys.min() == 0 or ys.max() == crop.height-1:
        return None
    # Check the wider visible band before discarding whitespace or artwork.
    guard_bounds = (.270, .45, .350, .99) if field == "reqAmount" else (.645, .45, .745, .99)
    guard = module._crop(row, guard_bounds)
    grgb = np.asarray(guard.convert("RGB"), dtype=np.int16)
    gwhite = (grgb.min(axis=2)>155) & (grgb.max(axis=2)-grgb.min(axis=2)<55)
    gcount, _, gstats, _ = cv2.connectedComponentsWithStats(gwhite.astype(np.uint8), 8)
    cx, cy = round(bounds[0]*row.width), round(bounds[1]*row.height)
    gx, gy = round(guard_bounds[0]*row.width), round(guard_bounds[1]*row.height)
    bx0, by0, bx1, by1 = cx+xs.min(), cy+ys.min(), cx+xs.max()+1, cy+ys.max()+1
    for stat in gstats[1:]:
        x, y, w, h = stat[:4]
        x, y = x+gx, y+gy
        overlap = min(by1, y+h)-max(by0, y)
        if h >= (by1-by0)*.6 and overlap >= .7*max(by1-by0, h):
            if x < bx0-1 or x+w > bx1+1:
                return None
    tight = selected[ys.min():ys.max()+1, xs.min():xs.max()+1]
    columns = np.flatnonzero(tight.any(axis=0))
    groups = np.split(columns, np.where(np.diff(columns)>1)[0]+1)
    return tight, len(groups)


def quantity_context_key(row, field, module):
    # Keep every bright component in the wider band, including a digit joined to artwork.
    bounds = (.270, .40, .350, .99) if field == "reqAmount" else (.645, .40, .745, .99)
    return feature_key(module._ink(module._crop(row, bounds), numeric=True))


def get_features(kind, crop, module, *, row=None, field=None):
    context = {}
    if kind == "quantity":
        key = quantity_context_key(row, field, module)
        if key is not None:
            context["context"] = key
        found = quantity_mask(row, field, module)
        if found is None:
            return context, None
        mask, group_count = found
    else:
        mask, group_count = text_mask(crop, module), None
    if mask is None:
        return {}, group_count
    return {**context, **{mode: feature_key(mask, mode == "scaled") for mode in ("native", "scaled")}}, group_count


def lookup(bank, kind, features, group_count, modes=("native", "scaled", "context"), allowed=None):
    matched = []
    ambiguous = False
    for mode in modes:
        key = features.get(mode)
        refs = bank["lookup"].get(f"{kind}|{mode}|{key}", []) if key else []
        labels = {_canonical(r["value"]): r["value"] for r in refs}
        if len(labels)>1:
            ambiguous = True
        if len(labels)==1:
            value = next(iter(labels.values()))
            if kind == "quantity" and mode != "context" and len(str(value)) != group_count:
                continue
            if allowed is not None and value not in allowed:
                continue
            matched.append((value, refs, mode))
    labels = {_canonical(x[0]) for x in matched}
    if ambiguous or len(labels) != 1:
        return None
    value = matched[0][0]
    refs = {r["referenceId"]: r for _, items, _ in matched for r in items}
    return {"value": value, "references": list(refs), "modes": sorted({x[2] for x in matched})}


class TemplateReader:
    def __init__(self, path, *, ink, crop):
        self.extractor = SimpleNamespace(_ink=ink, _crop=crop)
        self.bank = None
        self.enabled = False
        self.stats = {"bankVersion": VERSION, "bankSha256": BANK_SHA256,
                      "available": False, "attempts": 0, "hits": 0, "byKind": {}, "lookupSeconds": 0.0}
        try:
            data = Path(path).read_bytes()
            if hashlib.sha256(data).hexdigest() != BANK_SHA256:
                raise ValueError("bank integrity mismatch")
            bank = json.loads(data)
            if bank.get("version") != VERSION or not isinstance(bank.get("lookup"), dict):
                raise ValueError("unsupported bank")
            self.bank = bank
            self.stats.update(available=True, referenceCount=bank["referenceCount"])
        except (OSError, ValueError, KeyError, TypeError):
            self.stats["fallbackReason"] = "bank_missing_or_invalid"

    def configure(self, image, metadata):
        fidelity = metadata.get("fidelity", {})
        self.enabled = (self.bank is not None and image.size == (987, 456)
                        and metadata.get("sourceType") == "native-screen"
                        and fidelity.get("rescaled") is False
                        and fidelity.get("evidence") == "native-pixels")

    def match(self, kind, crop, *, row=None, field=None, allowed=None):
        if not self.enabled:
            return None
        started = time.perf_counter()
        self.stats["attempts"] += 1
        try:
            features, groups = get_features(kind, crop, self.extractor, row=row, field=field)
            hit = lookup(self.bank, kind, features, groups, allowed=allowed)
        except Exception:
            self.stats["lookupErrors"] = self.stats.get("lookupErrors", 0) + 1
            return None
        finally:
            self.stats["lookupSeconds"] += time.perf_counter() - started
        if hit is None:
            return None
        self.stats["hits"] += 1
        self.stats["byKind"][kind] = self.stats["byKind"].get(kind, 0) + 1
        return {"rawOCR": "", "corrected": hit["value"], "reviewRequired": False,
                "confidence": None, "valueSource": "VERIFIED_TEMPLATE", "variants": [],
                "templateEvidence": {"bankVersion": VERSION, "bankSha256": BANK_SHA256,
                                     "references": hit["references"], "modes": hit["modes"]},
                **({"masterMatch": "RESOLVED"} if kind in ("island", "item") else {})}
