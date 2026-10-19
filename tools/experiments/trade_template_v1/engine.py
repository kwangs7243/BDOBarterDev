from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from PIL import Image

from .contracts import TemplateMatch
from .matcher import _context_key, crop_rgb, exact_match, probe_layout


FIELD_BOUNDS = {"island": (.063, .05, .241, .48), "fromItem": (.340, .10, .558, .47),
                "toItem": (.714, .10, .931, .87), "count": (.064, .47, .233, .83),
                "reqAmount": (.287, .55, .340, .93), "yield": (.663, .55, .724, .95)}


def _box(field: str, row_width: int, row_height: int) -> dict[str, int]:
    x0, y0, x1, y1 = FIELD_BOUNDS[field]
    left, top, right, bottom = round(x0 * row_width), round(y0 * row_height), round(x1 * row_width), round(y1 * row_height)
    return {"x": left, "y": top, "width": right - left, "height": bottom - top}


def _load_catalog(module) -> dict[str, Any]:
    path = module._experiment_catalog_path
    return json.loads(path.read_text(encoding="utf-8"))


def _canonical_name(name: Any, legacy) -> str:
    return legacy._normalize(str(name or "")) if name else ""


def _context(fields: dict[str, Any], catalog: dict[str, Any], legacy, kind: str,
             row_height: int, shape: list[int], field: str | None = None) -> dict[str, Any] | None:
    item_stages = {name: int(stage) for stage, names in catalog["masterData"].items()
                   for name in names if str(stage).isdigit()}
    item_stages.update({name: "coin" if "까마귀" in name else "special" for name in catalog.get("specialItems", [])})
    if kind.startswith("NAME"):
        return {"contextKey": _context_key(kind, row_height, shape, field=field),
                "sourceTier": None, "destinationTier": None, "toItem": None, "field": field}
    source_field, target_field = fields.get("fromItem", {}), fields.get("toItem", {})
    for result in (source_field, target_field):
        value = result.get("corrected")
        if not isinstance(value, str) or result.get("reviewRequired") is not False:
            return None
        if result.get("valueSource") == "VERIFIED_TEMPLATE":
            evidence = result.get("templateEvidence")
            if not isinstance(evidence, dict) or not evidence.get("referenceIds"):
                return None
        elif result.get("confidence") is None or result.get("confidence") < .90:
            return None
    from_item, to_item = source_field.get("corrected"), target_field.get("corrected")
    if from_item not in item_stages or to_item not in item_stages:
        return None
    source_tier, destination_tier = item_stages[from_item], item_stages[to_item]
    if kind == "YIELD_23" and (source_tier, destination_tier) not in {(1, 2), (2, 3)}:
        return None
    if kind == "YIELD_BLACKSTONE" and to_item != "파도의 블랙스톤":
        return None
    if kind.startswith("NAME"):
        current = fields.get(field or "", {})
        if current.get("reviewRequired") is not False:
            return None
    context_key = _context_key(kind, row_height, shape, source_tier if kind.startswith("YIELD") else None,
                               destination_tier if kind.startswith("YIELD") else None,
                               to_item if kind.startswith("YIELD") else None,
                               field if kind.startswith("NAME") else None)
    return {"contextKey": context_key, "sourceTier": source_tier, "destinationTier": destination_tier,
            "toItem": to_item, "field": field}


def _try_template(image: Image.Image, row_box: dict[str, int], fields: dict[str, Any], field: str,
                  variant: str, bank: dict[str, Any], legacy, catalog: dict[str, Any], config: dict[str, Any],
                  layout, offset_x: int, kind: str, trace: list[dict[str, Any]], capture_id: str,
                  ordinal: int, row_height: int, image_sha256: str | None = None) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    crop_field = "guard" if field == "yield" else field
    crop, matched_box = crop_rgb(image, row_box, crop_field, offset_x)
    if crop is None:
        result = TemplateMatch("ABSTAIN", reason="CROP_INCOMPLETE", timings={"lookupSeconds": 0.0})
        trace.append({"captureId": capture_id, "ordinal": ordinal, "rowBox": row_box, "field": field,
                      "status": result.status, "reason": result.reason, "context_changed": False})
        return None, result.json()
    context = _context(fields, catalog, legacy, kind, row_height, [crop.height, crop.width, 3], field)
    if not layout.valid:
        result = TemplateMatch("ABSTAIN", reason=layout.reason or "ANCHOR_UNCERTAIN")
    elif context is None:
        result = TemplateMatch("ABSTAIN", reason="CONTEXT_UNCERTAIN")
    else:
        context["matchedBox"] = matched_box
        try:
            result = exact_match(crop, context, bank)
        except Exception:
            result = TemplateMatch("ERROR", reason="TEMPLATE_ERROR", timings={"lookupSeconds": 0.0})
    diagnostic = {"captureId": capture_id, "imageSha256": image_sha256, "ordinal": ordinal, "rowBox": row_box,
                  "field": field, "kind": kind, "variant": variant, "status": result.status,
                  "reason": result.reason, "method": result.method, "value": result.value,
                  "referenceIds": list(result.reference_ids), "distance": result.score, "margin": result.margin,
                  "matchedBox": matched_box, "lookupSeconds": (result.timings or {}).get("lookupSeconds", 0.0),
                  "context_changed": False}
    trace.append(diagnostic)
    if result.status != "HIT":
        return None, result.json()
    box = _box(field, row_box["width"], row_height)
    box["x"] += offset_x
    box["y"] += row_box["y"]
    return {"rawOCR": "", "corrected": result.value, "reviewRequired": False, "confidence": None,
            "variants": [], "valueSource": "VERIFIED_TEMPLATE",
            "templateEvidence": {"bankVersion": bank["bankVersion"], "referenceIds": list(result.reference_ids),
                                 "method": result.method, "distance": result.score, "margin": result.margin,
                                 "sourceImageSha256": image_sha256, "guardBox": matched_box},
            "box": box, **({"masterMatch": "RESOLVED"} if field in {"island", "fromItem", "toItem"} else {})}, result.json()


def run_experiment(captures: list[dict[str, Any]], model_dir: Path, batch_id: str, variant: str,
                   mode: str, bank: dict[str, Any], module, config: dict[str, Any],
                   telemetry: dict[str, Any] | None = None,
                   baseline_result: dict[str, Any] | None = None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if variant == "B0":
        started = time.perf_counter()
        result = module.recognize_live(captures, model_dir, batch_id)
        result["_experimentMetrics"] = {"recognitionWallSeconds": time.perf_counter() - started,
                                        **(telemetry or {})}
        return result, []
    if mode not in {"SHADOW", "FAST"}:
        raise ValueError("mode must be SHADOW or FAST")
    if mode == "SHADOW":
        started = time.perf_counter()
        baseline = baseline_result if baseline_result is not None else module.recognize_live(captures, model_dir, batch_id)
        catalog = _load_catalog(module)
        trace: list[dict[str, Any]] = []
        item_stages = {name: int(stage) for stage, names in catalog["masterData"].items()
                       for name in names if str(stage).isdigit()}
        item_stages.update({name: "coin" if "까마귀" in name else "special" for name in catalog.get("specialItems", [])})
        capture_by_id = {capture["captureId"]: capture for capture in captures}
        for row_result in baseline.get("rows", []):
            capture = capture_by_id.get(row_result.get("captureId"))
            if not capture:
                continue
            with Image.open(capture["imagePath"]) as opened:
                image = opened.convert("RGB")
            row_box = row_result.get("rowBox") or {}
            metadata = capture.get("metadata", {})
            layout = probe_layout(image, metadata, config)
            boxes = module.detect_live_rows(image)
            coverage = (image.size == tuple(config["layout"]["frame"])
                        and metadata.get("sourceType") == "native-screen"
                        and len(boxes) < config["layout"]["expectedFullFrameRows"])
            if coverage:
                layout = type(layout)(False, None, layout.anchor_supports, "COVERAGE_SUSPECT")
            fields = row_result.get("fields", {})
            if variant == "V3" and layout.valid:
                for field, kind in (("island", "NAME_ISLAND"), ("fromItem", "NAME_FROM_ITEM"), ("toItem", "NAME_TO_ITEM")):
                    _try_template(image, row_box, fields, field, variant, bank, module, catalog,
                                  config, layout, layout.offset_x or 0, kind, trace,
                                  row_result["captureId"], row_result.get("ordinal", 0), row_box.get("height", 0), capture.get("imageSha256"))
                    trace[-1]["proposalOnly"] = True
            yield_field = fields.get("yield", {})
            if yield_field.get("valueSource") == "TRADE_RULE":
                trace.append({"captureId": row_result["captureId"], "ordinal": row_result.get("ordinal"),
                              "field": "yield", "status": "ABSTAIN", "reason": "RULE_ALREADY_FIXED", "variant": variant})
                continue
            source, target = fields.get("fromItem", {}), fields.get("toItem", {})
            source_tier, destination_tier = item_stages.get(source.get("corrected")), item_stages.get(target.get("corrected"))
            qualified = all(value.get("reviewRequired") is False and value.get("confidence") is not None
                            and value.get("confidence") >= .90 for value in (source, target))
            if not qualified:
                continue
            kind = ("YIELD_23" if (source_tier, destination_tier) in {(1, 2), (2, 3)} else
                    "YIELD_BLACKSTONE" if target.get("corrected") == config["numeric"]["blackstoneCanonicalName"]
                    and variant in {"V2", "V3"} else None)
            if kind is None or (kind == "YIELD_23" and variant not in {"V1", "V2", "V3"}):
                continue
            _try_template(image, row_box, fields, "yield", variant, bank, module, catalog,
                          config, layout, layout.offset_x or 0, kind, trace,
                          row_result["captureId"], row_result.get("ordinal", 0), row_box.get("height", 0), capture.get("imageSha256"))
            trace[-1]["baselineValue"] = yield_field.get("corrected")
            trace[-1]["proposalOnly"] = True
        baseline["_experimentMetrics"] = {"recognitionWallSeconds": time.perf_counter() - started, **(telemetry or {})}
        return baseline, trace
    started = time.perf_counter()
    catalog = _load_catalog(module)
    items = list(dict.fromkeys([name for names in catalog["masterData"].values() for name in names] + catalog["specialItems"]))
    islands = list(dict.fromkeys(catalog["islands"] + catalog.get("t6Islands", []) + catalog.get("t7Islands", [])))
    item_stages = {name: int(stage) for stage, names in catalog["masterData"].items() for name in names if str(stage).isdigit()}
    item_stages.update({name: "coin" if "까마귀" in name else "special" for name in catalog.get("specialItems", [])})
    land_items = catalog["masterData"].get("0", catalog.get("landItems", []))
    reader = module.LocalReader(model_dir)
    trace: list[dict[str, Any]] = []
    rows, capture_results = [], []
    for capture_index, capture in enumerate(captures):
        with Image.open(capture["imagePath"]) as opened:
            image = opened.convert("RGB")
        boxes = module.detect_live_rows(image)
        metadata = capture.get("metadata", {})
        layout = probe_layout(image, metadata, config)
        coverage_suspect = image.size == tuple(config["layout"]["frame"]) and metadata.get("sourceType") == "native-screen" and len(boxes) < config["layout"]["expectedFullFrameRows"]
        if coverage_suspect:
            layout = type(layout)(False, None, layout.anchor_supports, "COVERAGE_SUSPECT")
        offset = layout.offset_x or 0
        capture_id = capture["captureId"]
        capture_results.append({"captureId": capture_id, "rows": len(boxes), "width": image.width,
                                "height": image.height, "layout": {"valid": layout.valid,
                                "offsetX": layout.offset_x, "supports": list(layout.anchor_supports),
                                "reason": layout.reason}, "coverageSuspect": coverage_suspect})
        for ordinal, (top, bottom) in enumerate(boxes):
            row_box = {"x": 0, "y": top, "width": image.width, "height": bottom - top}
            row = image.crop((0, top, image.width, bottom))
            fields = {key: {"rawOCR": "", "corrected": None, "reviewRequired": True, "confidence": None}
                      for key in module.NUMERIC}
            proposed: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
            for field in ("island", "fromItem", "toItem", "count", "reqAmount", "yield"):
                crop = module._crop(row, FIELD_BOUNDS[field])
                if field == "reqAmount":
                    crop = module._requirement_crop(row)
                try:
                    if field == "count":
                        fields[field] = module.read_count(reader, crop)
                    elif field in module.NUMERIC:
                        module.apply_trade_rules(fields, item_stages)
                        if fields[field].get("valueSource") == "TRADE_RULE":
                            continue
                        source, destination = module.trade_stages(fields, item_stages)
                        allowed = (2, 3) if field == "yield" and (source, destination) in {(1, 2), (2, 3)} else None
                        target_kind = "YIELD_23" if allowed else "YIELD_BLACKSTONE" if fields.get("toItem", {}).get("corrected") == config["numeric"]["blackstoneCanonicalName"] else None
                        if field == "yield" and target_kind and variant in {"V1", "V2", "V3"} and (target_kind != "YIELD_BLACKSTONE" or variant in {"V2", "V3"}):
                            match_field, match_diag = _try_template(image, row_box, fields, field, variant, bank, module,
                                catalog, config, layout, offset, target_kind, trace, capture_id, ordinal, bottom-top, capture.get("imageSha256"))
                            if trace:
                                trace[-1]["context_changed"] = any(fields.get(name, {}).get("valueSource") == "VERIFIED_TEMPLATE" for name in ("fromItem", "toItem"))
                            if match_field:
                                proposed[field] = (match_field, match_diag)
                                if mode == "FAST":
                                    fields[field] = match_field
                                    continue
                        fields[field] = module.read_yield(reader, row, allowed, destination) if field == "yield" else module.read_requirement(reader, row)
                    else:
                        target_kind = {"island": "NAME_ISLAND", "fromItem": "NAME_FROM_ITEM", "toItem": "NAME_TO_ITEM"}[field]
                        if variant == "V3" and layout.valid:
                            match_field, match_diag = _try_template(image, row_box, fields, field, variant, bank, module,
                                catalog, config, layout, offset, target_kind, trace, capture_id, ordinal, bottom-top, capture.get("imageSha256"))
                            if match_field:
                                proposed[field] = (match_field, match_diag)
                                if mode == "FAST":
                                    fields[field] = match_field
                                    continue
                        fields[field] = module.read_catalog_name(reader, crop, islands if field == "island" else items,
                                                                  land_items if field == "fromItem" else ())
                        if field == "toItem" and (item_stages.get(fields[field].get("corrected")) or fields[field].get("recognizedStage")) == 1:
                            fields["fromItem"] = module.read_catalog_name(reader, module._crop(row, FIELD_BOUNDS["fromItem"]), land_items, land_items)
                except Exception as error:
                    fields[field] = {"rawOCR": "", "corrected": None, "reviewRequired": True,
                                     "confidence": None, "error": type(error).__name__}
            # Shadow returns untouched frozen OCR; FAST has applied only exact eligible hits.
            module.apply_trade_rules(fields, item_stages)
            if offset:
                aligned_row = image.crop((offset, top, image.width + offset, bottom))
                source, destination = module.trade_stages(fields, item_stages)
                for field in ("count", "reqAmount", "yield"):
                    original = fields[field]
                    if not original["reviewRequired"]:
                        continue
                    allowed = (2, 3) if field == "yield" and (source, destination) in {(1, 2), (2, 3)} else None
                    try:
                        candidate = module.read_count(reader, module._crop(aligned_row, FIELD_BOUNDS[field])) if field == "count" else module.read_requirement(reader, aligned_row) if field == "reqAmount" else module.read_yield(reader, aligned_row, allowed, destination)
                    except Exception:
                        continue
                    value = candidate["corrected"]
                    conflict = any(reading["text"].isdigit() and reading["confidence"] >= .75 and int(reading["text"]) != value and (allowed is None or int(reading["text"]) in allowed) for reading in original.get("variants", []))
                    if value is not None and not candidate["reviewRequired"] and not conflict and original["corrected"] in (None, value):
                        fields[field] = {**candidate, "rawOCR": original["rawOCR"], "variants": original.get("variants", []) + candidate.get("variants", []), "alignmentOffsetX": offset}
            for field in FIELD_BOUNDS:
                box = _box(field, row.width, row.height)
                box["x"] += offset if fields[field].get("valueSource") == "VERIFIED_TEMPLATE" else 0
                box["y"] += top
                fields[field]["box"] = box
            rows.append({"captureId": capture_id, "ordinal": ordinal, "rowBox": row_box, "fields": fields})
    result = {"version": 3, "batchId": batch_id, "rows": rows, "captures": capture_results,
              "engine": "trade-template-experiment-v1", "rowDetector": "measured-separator-spacing-v1",
              "_experimentMetrics": {"recognitionWallSeconds": time.perf_counter() - started, **(telemetry or {})}}
    return result, trace
