from __future__ import annotations

import hashlib
import json
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .contracts import LayoutProbe, TemplateMatch, canonical_bytes, sha256_bytes, write_json


BOUNDS = {"island": (.063, .05, .241, .48), "fromItem": (.340, .10, .558, .47),
          "toItem": (.714, .10, .931, .87), "guard": (.645, .45, .745, .99)}
EXTRACTOR_VERSION = "frozen-v13-crop-round-rgb-v1"


def _box(bounds: tuple[float, float, float, float], width: int, height: int) -> tuple[int, int, int, int]:
    return tuple(round(value * size) for value, size in zip(bounds, (width, height, width, height)))


def probe_layout(image: Image.Image, metadata: dict[str, Any], config: dict[str, Any]) -> LayoutProbe:
    layout = config["layout"]
    if image.size != tuple(layout["frame"]) or metadata.get("sourceType") != layout["sourceType"]:
        return LayoutProbe(False, None, (), "LAYOUT_UNSUPPORTED")
    if metadata.get("fidelity", {}).get("rescaled") is not False:
        return LayoutProbe(False, None, (), "LAYOUT_UNSUPPORTED")
    rgb = np.asarray(image.convert("RGB"), dtype=np.int16)
    edges = np.mean(np.max(np.abs(np.diff(rgb, axis=1)), axis=2) > layout["edgeDeltaExclusive"], axis=0)
    offsets, supports = [], []
    radius = layout["searchRadiusX"]
    for anchor in layout["anchorsX"]:
        left, right = max(0, anchor - radius), min(len(edges), anchor + radius + 1)
        if right <= left:
            return LayoutProbe(False, None, tuple(supports), "ANCHOR_UNCERTAIN")
        actual = left + int(np.argmax(edges[left:right]))
        supports.append(float(edges[actual]))
        offsets.append(actual - anchor)
    if min(supports, default=0.0) < layout["minimumAnchorSupport"] or len(set(offsets)) != 1:
        return LayoutProbe(False, None, tuple(supports), "ANCHOR_UNCERTAIN")
    return LayoutProbe(True, offsets[0], tuple(supports), None)


def crop_rgb(image: Image.Image, row_box: dict[str, int], field: str, offset_x: int = 0,
             config: dict[str, Any] | None = None) -> tuple[Image.Image | None, dict[str, int] | None]:
    row = image.crop((0, row_box["y"], image.width, row_box["y"] + row_box["height"]))
    bounds = BOUNDS["guard"] if field in {"yield", "guard"} else BOUNDS[field]
    left, top, right, bottom = _box(bounds, row.width, row.height)
    actual_left, actual_right = left + offset_x, right + offset_x
    if min(actual_left, top, actual_right, bottom) < 0 or actual_right > image.width or row_box["y"] + bottom > image.height:
        return None, None
    crop = image.crop((actual_left, row_box["y"] + top, actual_right, row_box["y"] + bottom)).convert("RGB")
    return crop, {"x": actual_left, "y": row_box["y"] + top, "width": actual_right - actual_left,
                  "height": bottom - top}


def map_row_box(target: dict[str, int], detected: list[tuple[int, int]], image_width: int,
                minimum_iou: float) -> tuple[int, dict[str, int]] | None:
    candidates = []
    tx = int(target.get("x", 0))
    tw = int(target.get("width", image_width))
    ty = int(target.get("y", 0))
    th = int(target.get("height", 0))
    left, right = max(0, tx), min(image_width, tx + tw)
    if right <= left or th <= 0:
        return None
    for index, (top, bottom) in enumerate(detected):
        y0, y1 = max(top, ty), min(bottom, ty + th)
        intersection = max(0, right - left) * max(0, y1 - y0)
        target_area = max(1, tw * th)
        detected_area = max(1, image_width * (bottom - top))
        iou = intersection / max(1, target_area + detected_area - intersection)
        candidates.append((iou, index, top, bottom))
    candidates.sort(reverse=True)
    if not candidates or candidates[0][0] < minimum_iou:
        return None
    if len(candidates) > 1 and candidates[0][0] == candidates[1][0]:
        return None
    _, ordinal, top, bottom = candidates[0]
    return ordinal, {"x": 0, "y": top, "width": image_width, "height": bottom - top}


def exact_match(crop: Image.Image, context: dict[str, Any], bank: dict[str, Any]) -> TemplateMatch:
    started = time.perf_counter()
    key = context["contextKey"]
    refs = bank.get("contexts", {}).get(key, [])
    if not refs:
        return TemplateMatch("ABSTAIN", reason="NO_REFERENCE", timings={"lookupSeconds": time.perf_counter() - started})
    if len(refs) > 64:
        return TemplateMatch("ABSTAIN", reason="AMBIGUOUS_REFERENCE", timings={"lookupSeconds": time.perf_counter() - started})
    pixels = crop.convert("RGB").tobytes()
    hit = [reference for reference in refs if reference.get("rgbSha256") == hashlib.sha256(pixels).hexdigest()
           and reference.get("rgbShape") == [crop.height, crop.width, 3]
           and (bank.get("_referencePixels", {}).get(reference["referenceId"]) == pixels)]
    elapsed = time.perf_counter() - started
    labels = {canonical_bytes(reference["label"]) for reference in hit}
    if len(labels) == 1 and hit:
        ref = hit[0]
        return TemplateMatch("HIT", ref["label"], tuple(sorted(x["referenceId"] for x in hit)), "EXACT_RGB",
                             0.0, None, context.get("matchedBox"), None, {"lookupSeconds": elapsed})
    if len(labels) > 1:
        return TemplateMatch("ABSTAIN", reason="AMBIGUOUS_REFERENCE", timings={"lookupSeconds": elapsed})
    return TemplateMatch("ABSTAIN", reason="NO_EXACT_MATCH", timings={"lookupSeconds": elapsed})


def _context_key(kind: str, row_height: int, shape: list[int], source_tier: Any = None,
                 destination_tier: Any = None, to_item: str | None = None, field: str | None = None) -> str:
    return sha256_bytes(canonical_bytes({"kind": kind, "rowHeight": row_height, "rgbShape": shape,
                                         "extractorVersion": EXTRACTOR_VERSION,
                                         "sourceTier": source_tier, "destinationTier": destination_tier,
                                         "toItem": to_item, "field": field}))


def build_bank(run_root: Path, dataset: dict[str, Any], captures: dict[str, dict[str, Any]],
               truths: list[dict[str, Any]], legacy_module, catalog: dict[str, Any],
               config: dict[str, Any], provenance: dict[str, Any]) -> dict[str, Any]:
    bank_root = run_root / "bank"
    ref_root = bank_root / "references"
    ref_root.mkdir(parents=True, exist_ok=True)
    item_stages = {name: int(stage) for stage, names in catalog["masterData"].items()
                   for name in names if str(stage).isdigit()}
    item_stages.update({name: "coin" if "까마귀" in name else "special" for name in catalog.get("specialItems", [])})
    all_items = set(item_stages)
    islands = set(catalog.get("islands", []) + catalog.get("t6Islands", []) + catalog.get("t7Islands", []))
    contexts: dict[str, list[dict[str, Any]]] = {}
    reference_pixels: dict[str, bytes] = {}
    excluded: list[dict[str, Any]] = []
    image_by_id = {entry["imageSha256"]: entry for entry in dataset["images"]}
    truth_by_row: dict[tuple[str, int], dict[str, Any]] = {}

    def row_index(image_sha: str, truth: dict[str, Any], image: Image.Image) -> tuple[int, dict[str, int]] | None:
        target = truth.get("rowBox", {})
        boxes = legacy_module.detect_live_rows(image)
        return map_row_box(target, boxes, image.width, config["data"]["rowMappingMinimumIoU"])

    import io
    # Only one authoritative PNG per truth row is considered; its raw bytes and decoded size are retained.
    for truth in truths:
        image_meta = image_by_id.get(truth["imageSha256"])
        if not image_meta:
            excluded.append({"truthId": truth["truthId"], "reason": "IMAGE_MISSING"})
            continue
        source_types = {m.get("sourceId") for m in image_meta["memberships"]}
        meta = image_meta.get("metadata", {})
        if image_meta["width"] != 987 or image_meta["height"] != 456 or meta.get("sourceType") != "native-screen" or meta.get("fidelity", {}).get("rescaled") is not False:
            excluded.append({"truthId": truth["truthId"], "reason": "LAYOUT_UNSUPPORTED"})
            continue
        if truth.get("splitRole") not in {"ENROLL", "CALIBRATION"}:
            excluded.append({"truthId": truth["truthId"], "reason": "NOT_ENROLL"})
            continue
        path = run_root / "data" / "png" / f"{truth['imageSha256']}.png"
        with Image.open(path) as opened:
            image = opened.convert("RGB")
            probe = __import__("local_app.experiments.trade_template_v1.matcher", fromlist=["probe_layout"]).probe_layout(image, meta, config)
            if not probe.valid:
                excluded.append({"truthId": truth["truthId"], "reason": probe.reason or "ANCHOR_UNCERTAIN"})
                continue
            found = row_index(truth["imageSha256"], truth, image)
            if found is None:
                excluded.append({"truthId": truth["truthId"], "reason": "ROW_MAPPING_AMBIGUOUS"})
                continue
            ordinal, row_box = found
            rows = legacy_module.detect_live_rows(image)
            if len(rows) < config["layout"]["expectedFullFrameRows"]:
                excluded.append({"truthId": truth["truthId"], "reason": "COVERAGE_SUSPECT"})
                continue
            field = truth["field"]
            value = truth["value"]
            kind, source_tier, destination_tier, to_item = None, None, None, None
            target_fields = defaultdict(dict)
            for sibling in truths:
                if sibling["imageSha256"] == truth["imageSha256"] and sibling.get("rowBox", {}).get("y") == truth.get("rowBox", {}).get("y"):
                    target_fields[ordinal][sibling["field"]] = sibling["value"]
            row_truth = target_fields.get(ordinal, {})
            evidence = truth.get("sourceEvidence", [{}])[0]
            for saved_row in dataset.get("storedRows", {}).get(truth["imageSha256"], []):
                if evidence.get("ordinal") == saved_row.get("ordinal"):
                    for context_field in ("fromItem", "toItem"):
                        observed = saved_row.get("fields", {}).get(context_field, {})
                        if (observed.get("reviewRequired") is False and observed.get("confidence") is not None
                                and observed.get("confidence") >= .90 and isinstance(observed.get("corrected"), str)):
                            row_truth.setdefault(context_field, observed["corrected"])
            if field == "yield":
                to_item = row_truth.get("toItem")
                from_item = row_truth.get("fromItem")
                source_tier = item_stages.get(from_item)
                destination_tier = item_stages.get(to_item)
                if (source_tier, destination_tier) in {tuple(x) for x in config["numeric"]["allowedStagePairs"]} and value in config["numeric"]["allowedValues23"]:
                    kind = "YIELD_23"
                elif to_item == config["numeric"]["blackstoneCanonicalName"]:
                    kind = "YIELD_BLACKSTONE"
                else:
                    excluded.append({"truthId": truth["truthId"], "reason": "CONTEXT_UNCERTAIN"})
                    continue
                crop_field = "guard"
            elif field in {"island", "fromItem", "toItem"}:
                if field == "island":
                    if value not in islands:
                        excluded.append({"truthId": truth["truthId"], "reason": "OUT_OF_CATALOG"})
                        continue
                    kind = "NAME_ISLAND"
                elif field == "fromItem":
                    if value not in all_items or item_stages.get(value) == 0:
                        excluded.append({"truthId": truth["truthId"], "reason": "OUT_OF_CATALOG"})
                        continue
                    kind = "NAME_FROM_ITEM"
                else:
                    if value not in all_items:
                        excluded.append({"truthId": truth["truthId"], "reason": "OUT_OF_CATALOG"})
                        continue
                    kind = "NAME_TO_ITEM"
                source_text = " ".join(str(e.get("rawOCR", "")) for e in truth.get("sourceEvidence", []))
                if not source_text or "..." in source_text or "…" in source_text:
                    excluded.append({"truthId": truth["truthId"], "reason": "NEEDS_FULL_NAME_EVIDENCE"})
                    continue
                if _name_canonical(source_text) != _name_canonical(value):
                    excluded.append({"truthId": truth["truthId"], "reason": "RAW_NAME_NOT_FULL_CANONICAL"})
                    continue
                crop_field = field
            else:
                excluded.append({"truthId": truth["truthId"], "reason": "FIELD_OUTSIDE_V1"})
                continue
            crop, matched_box = crop_rgb(image, row_box, crop_field, probe.offset_x or 0)
            if crop is None:
                excluded.append({"truthId": truth["truthId"], "reason": "CROP_INCOMPLETE"})
                continue
            shape = [crop.height, crop.width, 3]
            key = _context_key(kind, row_box["height"], shape, source_tier, destination_tier,
                               to_item if kind.startswith("YIELD") else None,
                               field if kind.startswith("NAME") else None)
            pixels = crop.tobytes()
            digest = hashlib.sha256(pixels).hexdigest()
            ref_id = sha256_bytes(canonical_bytes({"truthId": truth["truthId"], "contextKey": key,
                                                  "rgbSha256": digest, "label": value}))
            crop_file = f"references/{ref_id}.png"
            crop.save(ref_root / f"{ref_id}.png")
            reference = {"referenceId": ref_id, "contextKey": key, "kind": kind, "label": value,
                         "truthId": truth["truthId"], "truthClass": truth["truthClass"],
                         "sourceGroupId": next((group["groupId"] for group in dataset["split"]["groups"] if truth["imageSha256"] in group["images"]), None),
                         "sourceImageSha256": truth["imageSha256"], "sourceRowBox": row_box,
                         "sourceCropBox": matched_box, "frameSize": [image.width, image.height],
                         "rowHeight": row_box["height"], "sourceTier": source_tier,
                         "destinationTier": destination_tier, "toItem": to_item, "rgbShape": shape,
                         "rgbSha256": digest, "cropFile": crop_file, "extractorVersion": EXTRACTOR_VERSION,
                         "catalogSha256": provenance["catalogSha256"], "evidence": truth["sourceEvidence"]}
            contexts.setdefault(key, []).append(reference)
            reference_pixels[ref_id] = pixels

    # Same exact pixels with conflicting confirmed labels invalidate that context/pixel pair.
    for key, refs in list(contexts.items()):
        pixel_labels: defaultdict[str, set[bytes]] = defaultdict(set)
        for ref in refs:
            pixel_labels[ref["rgbSha256"]].add(canonical_bytes(ref["label"]))
        bad = {pixel for pixel, labels in pixel_labels.items() if len(labels) > 1}
        if bad:
            contexts[key] = [ref for ref in refs if ref["rgbSha256"] not in bad]
            for pixel in bad:
                excluded.append({"contextKey": key, "rgbSha256": pixel, "reason": "CONFLICTING_EXACT_PIXELS"})
        refs.sort(key=lambda ref: ({"USER_CORRECTION": 0, "USER_CONFIRMED_FIELD": 1, "EXISTING_ORACLE": 2}.get(ref["truthClass"], 9),
                                   ref.get("sourceGroupId") or "", ref["sourceImageSha256"], ref["truthId"]))
        per_label: defaultdict[bytes, list[dict[str, Any]]] = defaultdict(list)
        for ref in refs:
            per_label[canonical_bytes(ref["label"])].append(ref)
        keep_ids = {ref["referenceId"] for label_refs in per_label.values()
                    for ref in label_refs[:config["data"]["maxReferencesPerContextLabel"]]}
        contexts[key] = [ref for ref in refs if ref["referenceId"] in keep_ids]
        if not contexts[key]:
            del contexts[key]
    if sum(len(refs) for refs in contexts.values()) > config["data"]["globalBankMaxReferences"]:
        flattened = sorted((ref for refs in contexts.values() for ref in refs),
                           key=lambda ref: (ref["kind"], ref.get("sourceGroupId") or "", ref["sourceImageSha256"], ref["truthId"]))
        allowed = {ref["referenceId"] for ref in flattened[:config["data"]["globalBankMaxReferences"]]}
        for key in list(contexts):
            contexts[key] = [ref for ref in contexts[key] if ref["referenceId"] in allowed]
            if not contexts[key]:
                del contexts[key]
    bank_payload = {"schemaVersion": 1, "specId": "TRADE-TEMPLATE-V1", "contexts": contexts,
                    "provenance": provenance, "extractorVersion": EXTRACTOR_VERSION}
    bank_version = sha256_bytes(canonical_bytes(bank_payload))
    bank = {**bank_payload, "bankVersion": bank_version, "_referencePixels": reference_pixels}
    # On-disk bank excludes in-memory byte lookup cache.
    disk_bank = {**bank_payload, "bankVersion": bank_version}
    (bank_root / "bank.json").write_text(json.dumps(disk_bank, ensure_ascii=False, indent=2), encoding="utf-8")
    (bank_root / "calibration.json").write_text(json.dumps({"enabled": False, "reason": "CALIBRATION_DISABLED",
                                                            "method": "EXACT_RGB_ONLY", "gridEvaluated": True,
                                                            "candidateCount": 0}, indent=2), encoding="utf-8")
    write_json(bank_root / "bank-summary.json", {"bankVersion": bank_version, "references": sum(map(len, contexts.values())),
                                                   "contexts": len(contexts), "byKind": {kind: sum(len(refs) for refs in contexts.values() if refs and refs[0]["kind"] == kind) for kind in ("YIELD_23", "YIELD_BLACKSTONE", "NAME_ISLAND", "NAME_FROM_ITEM", "NAME_TO_ITEM")},
                                                   "excludedCount": len(excluded),
                                                   "excludedReasons": dict(__import__("collections").Counter(item["reason"] for item in excluded)),
                                                   "excluded": excluded})
    bank["summary"] = {"references": sum(map(len, contexts.values())), "contexts": len(contexts), "excluded": excluded}
    return bank


def load_bank(run_root: Path, expected_provenance: dict[str, Any]) -> dict[str, Any]:
    bank_root = run_root / "bank"
    path = bank_root / "bank.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("provenance") != expected_provenance:
        raise ValueError("BANK_INVALID: provenance mismatch")
    without_version = {key: value for key, value in payload.items() if key not in {"bankVersion", "summary"}}
    version = sha256_bytes(canonical_bytes(without_version))
    if payload.get("bankVersion") != version:
        raise ValueError("BANK_INVALID: bank version mismatch")
    pixels = {}
    seen = 0
    for refs in payload.get("contexts", {}).values():
        for ref in refs:
            file_name = Path(ref["cropFile"])
            if file_name.is_absolute() or ".." in file_name.parts:
                raise ValueError("BANK_INVALID: unsafe reference path")
            crop_path = (bank_root / file_name).resolve()
            if bank_root.resolve() not in crop_path.parents or not crop_path.is_file():
                raise ValueError("BANK_INVALID: reference image missing")
            crop = Image.open(crop_path).convert("RGB")
            raw = crop.tobytes()
            if [crop.height, crop.width, 3] != ref.get("rgbShape") or hashlib.sha256(raw).hexdigest() != ref.get("rgbSha256"):
                raise ValueError("BANK_INVALID: reference pixels mismatch")
            pixels[ref["referenceId"]] = raw
            seen += 1
    summary_path = bank_root / "bank-summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8")) if summary_path.is_file() else {}
    return {**payload, "_referencePixels": pixels,
            "summary": {"references": seen, "contexts": len(payload.get("contexts", {})),
                        "byKind": summary.get("byKind", {}), "excludedCount": summary.get("excludedCount", 0),
                        "excludedReasons": summary.get("excludedReasons", {})}}


def _name_canonical(text: str) -> str:
    import re
    import unicodedata
    text = unicodedata.normalize("NFC", text)
    text = re.sub(r"^\s*[\[|]?\s*[1-7]\s*(?:단계|[가-힣]{1,3}[\]|!]?)\s*", "", text)
    return re.sub(r"\s+", "", text)


def _context_key(kind: str, row_height: int, shape: list[int], source_tier: Any = None,
                 destination_tier: Any = None, to_item: str | None = None, field: str | None = None) -> str:
    from .contracts import canonical_bytes
    return sha256_bytes(canonical_bytes({"kind": kind, "rowHeight": row_height, "rgbShape": shape,
                                         "extractorVersion": EXTRACTOR_VERSION,
                                         "sourceTier": source_tier, "destinationTier": destination_tier,
                                         "toItem": to_item, "field": field}))
