#!/usr/bin/env python3
"""Run the oracle-isolated T010A Trade geometry/numeric evidence replay."""
from __future__ import annotations

import json
import statistics
import subprocess
import sys
import time
import copy
from collections import Counter
from pathlib import Path
from typing import Any

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from local_app.backend.services.trade_recognition import (  # noqa: E402
    NUMERIC_FIELDS, _components, _crop_hash, _foreground_mask, _lane_boxes,
    canonical_hash, detect_rows, infer_trade_capture, sha256_file,
)


def _trade_numeric_v2(crop: Image.Image, field: str, row_boundary_contact: dict[str, bool],
                      parameters: dict[str, Any]) -> dict[str, Any]:
    config = parameters["componentPlausibility"]
    components: list[dict[str, Any]] = []
    for item in _components(_foreground_mask(crop)):
        width, height = item["width"], item["height"]
        edge = {"left": item["x"] == 0, "right": item["x"] + width >= crop.width,
                "top": item["y"] == 0, "bottom": item["y"] + height >= crop.height}
        rel_height, rel_width = height / crop.height, width / crop.width
        aspect = width / height
        plausible = (float(config["minimumHeightRatio"]) <= rel_height <= float(config["maximumHeightRatio"])
                     and float(config["minimumWidthRatio"]) <= rel_width <= float(config["maximumWidthRatio"])
                     and item["area"] >= int(config["minimumArea"])
                     and float(config["minimumAspectRatio"]) <= aspect <= float(config["maximumAspectRatio"]))
        components.append({**item, "aspectRatio": round(aspect, 6),
                           "relativeHeight": round(rel_height, 6), "relativeWidth": round(rel_width, 6),
                           "edgeContact": edge, "plausibleTokenComponent": plausible})
    sides = ("left", "right", "top", "bottom")
    raw_contact = {side: any(item["edgeContact"][side] for item in components) for side in sides}
    plausible = [item for item in components if item["plausibleTokenComponent"]]
    token_contact = {side: any(item["edgeContact"][side] for item in plausible) for side in sides}
    row_clipped = any(row_boundary_contact.values())
    raw_edge_only = any(raw_contact.values()) and not any(token_contact.values())
    if row_clipped:
        status, reasons = "CLIPPED", ["ROW_BOUNDARY_CONTACT"]
    elif any(token_contact.values()):
        status, reasons = "CLIPPED", ["TOKEN_BOUNDARY_CONTACT"]
    elif not components:
        status, reasons = "MISSING", ["NO_FOREGROUND_COMPONENTS"]
    elif not plausible:
        status, reasons = "UNREADABLE", ["NO_PLAUSIBLE_TOKEN_COMPONENTS"]
        if raw_edge_only:
            reasons.append("FOREGROUND_EDGE_NOISE")
    else:
        status, reasons = "UNVERIFIED_NUMERIC_CANDIDATE", ["TOKEN_STRUCTURE_CANDIDATE"]
        if raw_edge_only:
            reasons.append("FOREGROUND_EDGE_NOISE")
    token_box = None
    if plausible:
        x0, y0 = min(item["x"] for item in plausible), min(item["y"] for item in plausible)
        x1 = max(item["x"] + item["width"] for item in plausible)
        y1 = max(item["y"] + item["height"] for item in plausible)
        token_box = {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}
    return {"rawText": None, "value": None,
            "candidates": ([{"kind": "component-token-structure-v2", "value": None}]
                           if status == "UNVERIFIED_NUMERIC_CANDIDATE" else []),
            "status": status,
            "readerEvidence": {"readerId": "connected-component-token-structure-v2",
                               "componentCount": len(components), "plausibleComponentCount": len(plausible),
                               "components": components, "tokenBox": token_box,
                               "rawForegroundBoundaryContact": raw_contact,
                               "plausibleTokenBoundaryContact": token_contact,
                               "rowBoundaryContact": dict(row_boundary_contact),
                               "leftMargin": token_box["x"] if token_box else None,
                               "rightMargin": crop.width - token_box["x"] - token_box["width"] if token_box else None,
                               "reconstructable": False, "numericField": field},
            "cropHash": _crop_hash(crop), "reasonCodes": reasons}


def infer_trade_numeric_field_v2(crop: Image.Image, field: str,
                                 row_boundary_contact: dict[str, bool],
                                 parameters: dict[str, Any]) -> dict[str, Any]:
    if field not in NUMERIC_FIELDS:
        raise ValueError(f"not a numeric Trade field: {field}")
    return _trade_numeric_v2(crop, field, row_boundary_contact, parameters)


def _git_head() -> str:
    result = subprocess.run(["git", "-C", str(ROOT.parent), "rev-parse", "HEAD"],
                            check=True, capture_output=True, text=True)
    return result.stdout.strip()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_trade_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    trade = manifest.get("trade", {})
    captures = trade.get("captures", [])
    oracle_rows = trade.get("oracleRows", [])
    mapped = sum(len(record.get("mappedOracleRowIds", [])) for record in captures)
    statuses = {record.get("rowMappingStatus") for record in captures}
    if len(captures) != 16:
        raise ValueError(f"T010A requires 16 Trade captures, got {len(captures)}")
    if len(oracle_rows) != 80:
        raise ValueError(f"T010A requires 80 batch-level oracle rows, got {len(oracle_rows)}")
    if mapped != 0 or statuses != {"UNRESOLVED"}:
        raise ValueError("Trade capture/oracle mapping must remain entirely UNRESOLVED")
    if any(row.get("sourceCaptureId") is not None or row.get("sourceImageHash") is not None
           or row.get("rowMappingStatus") != "UNRESOLVED" for row in oracle_rows):
        raise ValueError("oracle rows contain a capture mapping; refusing T010A inference")
    return {"captureCount": len(captures), "oracleRowCount": len(oracle_rows),
            "mappedOracleRows": mapped, "rowMappingStatus": "UNRESOLVED"}


def _semantic_payload(artifact: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in artifact.items() if key not in {"timing", "semanticHash"}}


def run_trade_candidate(manifest_path: str | Path, selection_path: str | Path, runs: int = 10) -> dict[str, Any]:
    if runs < 1:
        raise ValueError("runs must be at least 1")
    manifest_path, selection_path = Path(manifest_path), Path(selection_path)
    manifest = load_json(manifest_path)
    selection = load_json(selection_path)
    if selection.get("task") != "T010A" or selection.get("approved") is not False or selection.get("production") is not False:
        raise ValueError("T010A selection must be unapproved and production=false")
    if selection.get("scope") != "replay-only" or selection.get("ocrRuntime") is not None or selection.get("textReader") is not None:
        raise ValueError("T010A selection must stay replay-only with no OCR/text reader")
    parameters = selection.get("parameters")
    if not isinstance(parameters, dict) or "lanes" not in parameters:
        raise ValueError("selection parameters/lanes are required")
    if selection.get("parameterHash") != canonical_hash(parameters):
        raise ValueError("T010A parameterHash does not match the declared parameters")
    audit = validate_trade_manifest(manifest)
    trade = manifest["trade"]
    capture_results = []
    latency_runs: list[float] = []
    for capture in trade["captures"]:
        image_path = (manifest_path.parent / capture["imagePath"]).resolve()
        if not image_path.is_file() or sha256_file(image_path) != capture["imageHash"]:
            raise ValueError(f"Trade source image hash mismatch: {capture.get('captureId')}")
        first_result = None
        durations = []
        for _ in range(runs):
            started = time.perf_counter()
            # Oracle rows are deliberately not passed across this inference boundary.
            inferred = infer_trade_capture(image_path, capture["captureId"], parameters)
            durations.append((time.perf_counter() - started) * 1000.0)
            if first_result is None:
                first_result = inferred
            elif canonical_hash(inferred) != canonical_hash(first_result):
                raise RuntimeError(f"non-deterministic trade evidence: {capture['captureId']}")
        latency_runs.extend(durations)
        capture_results.append(first_result)

    rows = [row for capture in capture_results for row in capture["rows"]]
    complete_rows = [row for row in rows if not row["clipped"]]
    clipped_rows = [row for row in rows if row["clipped"]]
    row_distribution = {capture["captureId"]: capture["rowDetection"]["candidateRows"] for capture in capture_results}
    height_values = [row["box"]["height"] for row in complete_rows]
    separator_values = [row["rawMetric"] for row in complete_rows if row["rawMetric"] is not None]
    numeric = {field: Counter() for field in ("reqAmount", "count", "yield")}
    for row in rows:
        for field, counts in numeric.items():
            item = row["fields"][field]
            counts["tokenCandidate"] += item["status"] == "UNVERIFIED_NUMERIC_CANDIDATE"
            counts["missing"] += item["status"] == "MISSING"
            counts["clipped"] += item["status"] == "CLIPPED"
            counts["ambiguous"] += item["status"] == "AMBIGUOUS"
            counts["unreadable"] += item["status"] == "UNREADABLE"
            counts["reconstructable"] += item["readerEvidence"].get("reconstructable") is True
    icon_evidence = {"warehouseReferenceAssetCount": len(list((ROOT / "reference" / "icons").glob("*.webp"))),
                     "templateSource": "warehouse-icon-bundle", "domainMatch": "UNVERIFIED",
                     "candidateProduced": 0, "noReference": 0, "ambiguous": 0,
                     "emptyOrNotCompared": len(rows) * 2,
                     "reason": "No Trade from/to icon crop geometry or verified Trade catalog; Warehouse references are not compared/promoted."}
    parameter_hash = canonical_hash(parameters)
    status = "PASS" if any(value["tokenCandidate"] for value in numeric.values()) else "BLOCKED_REQUIRES_SOL"
    icon_files = sorted((ROOT / "reference" / "icons").glob("*.webp"))
    artifact = {
        "version": 1, "task": "T010A", "status": status, "baseCommit": _git_head(),
        "engine": "trade-candidate", "fixtureCount": len(capture_results),
        "engineSemantics": "T010A row/lane and numeric component evidence only; no OCR, oracle mapping, or recognition decision",
        "captureSetHash": canonical_hash([{"captureId": c["captureId"], "imageHash": c["imageHash"]} for c in trade["captures"]]),
        "captureCount": len(capture_results), "oracleMappingStatus": audit["rowMappingStatus"],
        "oracleRowCount": audit["oracleRowCount"], "mappedOracleRows": audit["mappedOracleRows"],
        "oracleIsolation": {"detectorReceivesOracleRows": False,
                            "captureOrderToOracleOrderMapping": False,
                            "oracleUsedForAccuracy": False},
        "rowDetection": {"detectorId": selection["rowDetector"], "parameterHash": parameter_hash,
                         "capturesProcessed": len(capture_results), "candidateRows": len(rows),
                         "completeRows": len(complete_rows), "clippedRows": len(clipped_rows),
                         "rowsPerCapture": row_distribution,
                         "rowHeightPx": {"min": min(height_values) if height_values else None,
                                         "median": statistics.median(height_values) if height_values else None,
                                         "max": max(height_values) if height_values else None},
                         "separatorRawMetric": {"min": min(separator_values) if separator_values else None,
                                                "median": statistics.median(separator_values) if separator_values else None,
                                                "max": max(separator_values) if separator_values else None},
                         "deterministic": True,
                         "deterministicHash": canonical_hash([{key: row[key] for key in
                             ("rowId", "box", "clipped", "separatorEvidence", "rawMetric", "boundaryContact", "rowCropHash")}
                             for row in rows]),
                         "rows": rows},
        "laneGeometry": {"status": "MEASURED", "lanes": parameters["lanes"],
                         "allLaneBoxesValid": all(lane["valid"] for row in rows for lane in row["laneGeometry"].values()),
                         "cropHashesPresent": all(row["fields"][field]["cropHash"] for row in rows for field in row["fields"] if row["laneGeometry"].get(field, {}).get("valid")),
                         "normalizedCoordinates": True},
        "numericEvidence": {"readerId": selection["numericReader"], "templateSource": None,
                            "templateComparison": "NOT_RUN", "templateDomainMatch": "UNVERIFIED",
                            "domainMatch": "UNVERIFIED", "coverageMeaning": "structural component-token candidate rate; not accuracy",
                            "byField": {field: {**dict(values),
                                               "denominatorCompleteRows": len(complete_rows),
                                               "candidateCoverageRate": (values["tokenCandidate"] / len(complete_rows) if complete_rows else None)}
                                        for field, values in numeric.items()}},
        "iconEvidence": icon_evidence,
        "fieldStatusSummary": {field: "UNREADABLE" for field in ("island", "fromItem", "toItem")},
        "sixFieldCompleteness": {"rows": len(rows), "importerEligibleRows": 0, "automationEligible": False},
        "timing": {"runsPerCapture": runs, "candidateLatencyMs": {"mean": statistics.mean(latency_runs) if latency_runs else None,
                            "p95": sorted(latency_runs)[max(0, int(0.95 * len(latency_runs) + 0.999999) - 1)] if latency_runs else None,
                            "samples": len(latency_runs)}},
        "runAudit": {"runsPerCapture": runs, "inferenceOutputsIdentical": True,
                     "timingExcludedFromSemanticHash": True},
        "peakMemoryBytes": None,
        "resourceHashes": {"manifest": sha256_file(manifest_path), "experiment": sha256_file(selection_path),
                           "warehouseQuantityTemplatesRawSha256": sha256_file(ROOT / "tools" / "warehouse_patch" / "quantity_templates.npz"),
                           "warehouseIconFileHashes": {p.name: sha256_file(p) for p in icon_files},
                           "warehouseIconManifestRawSha256": sha256_file(ROOT / "local_app" / "recognition_data" / "model-manifest.json")},
        "limitations": ["Oracle screenshot-row mapping is unresolved; no accuracy or exact-match metric is available.",
                        "No Korean text reader or digit decoder is implemented.",
                        "Warehouse reference assets/templates have unverified Trade-domain match."],
        "approval": {"approved": False, "production": False, "automationDecision": "REVIEW",
                     "automationEligible": False, "tradeProductionRecognition": False},
        "textOcrImplemented": False, "textConfirmedFields": 0,
        "mainDbWriteCount": 0, "userDatabaseAccessed": False, "userDatabaseChanged": False,
        "fieldAccuracy": None, "rowExactMatch": None, "captureExactMatch": None, "fullListExact": None,
    }
    artifact["semanticHash"] = canonical_hash(_semantic_payload(artifact))
    return artifact


def _candidate_lanes(base: dict[str, Any], field: str, operations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for operation in operations:
        lanes = copy.deepcopy(base)
        lane = lanes[field]
        op = operation["operation"]
        delta = float(operation.get("margin", 0))
        if op == "base":
            pass
        elif op == "expand-left":
            lane["x0"] -= delta
        elif op == "expand-right":
            lane["x1"] += delta
        elif op == "inset-x":
            lane["x0"] += delta
            lane["x1"] -= delta
        elif op == "expand-top":
            lane["y0"] -= delta
        elif op == "expand-bottom":
            lane["y1"] += delta
        elif op == "inset-y":
            lane["y0"] += delta
            lane["y1"] -= delta
        elif op == "expand-xy":
            lane["x0"] -= delta
            lane["x1"] += delta
            lane["y0"] -= delta
            lane["y1"] += delta
        elif op == "inset-xy":
            lane["x0"] += delta
            lane["x1"] -= delta
            lane["y0"] += delta
            lane["y1"] -= delta
        else:
            raise ValueError(f"unknown T010A2 lane operation: {op}")
        result.append({"candidateId": f"{field}:{operation['id']}", "field": field,
                       "operation": operation, "lanes": lanes})
    return result


def run_trade_candidate_t010a2(manifest_path: str | Path, selection_path: str | Path,
                               base_selection_path: str | Path, runs: int = 10) -> dict[str, Any]:
    """Image-only finite lane sweep; the T010A inference/reader path remains untouched."""
    if runs != 10:
        raise ValueError("T010A2 baseline comparison requires the frozen 10-run T010A replay")
    manifest_path, selection_path, base_selection_path = map(Path, (manifest_path, selection_path, base_selection_path))
    manifest, selection, base_selection = load_json(manifest_path), load_json(selection_path), load_json(base_selection_path)
    if (selection.get("task") != "T010A2" or selection.get("approved") is not False
            or selection.get("production") is not False or selection.get("scope") != "replay-only"
            or selection.get("ocrRuntime") is not None or selection.get("oracleUsed") is not False):
        raise ValueError("T010A2 selection must be unapproved image-only replay without OCR/oracle")
    if selection.get("rowDetector") != "repeated-horizontal-separator-pair-v1":
        raise ValueError("T010A2 row detector must remain frozen")
    base_parameters = base_selection["parameters"]
    if selection.get("baseLaneParameterHash") != canonical_hash(base_parameters):
        raise ValueError("T010A2 base lane parameter hash mismatch")
    if selection.get("numericReader") != "connected-component-token-structure-v2":
        raise ValueError("unexpected T010A2 numeric reader")
    audit = validate_trade_manifest(manifest)
    v1 = run_trade_candidate(manifest_path, base_selection_path, runs)
    expected_v1 = selection["baselineT010ASemanticHash"]
    v1_reproduction_payload = _semantic_payload(v1)
    # The stored T010A semantic hash includes its original commit provenance. Compare
    # current replay semantics under that recorded provenance; current base commit is
    # recorded separately in the T010A2 artifact.
    v1_reproduction_payload["baseCommit"] = selection["baselineT010ACommit"]
    reproduced_v1_hash = canonical_hash(v1_reproduction_payload)
    if reproduced_v1_hash != expected_v1:
        raise ValueError(f"T010A v1 semantic reproduction mismatch: {reproduced_v1_hash}")
    trade = manifest["trade"]
    captures_by_id = {capture["captureId"]: capture for capture in trade["captures"]}
    rows_by_capture: dict[str, list[dict[str, Any]]] = {key: [] for key in captures_by_id}
    for row in v1["rowDetection"]["rows"]:
        capture_id = row["rowId"].split(":candidate-", 1)[0]
        rows_by_capture[capture_id].append(row)

    candidate_records = []
    selected: dict[str, str] = {}
    v2_totals: dict[str, dict[str, Any]] = {}
    reason_distribution = Counter()
    operations = selection["laneCandidateDerivation"]["operations"]
    for field in ("reqAmount", "count", "yield"):
        field_candidates = _candidate_lanes(base_parameters["lanes"], field, operations)
        evaluated = []
        for candidate in field_candidates:
            lane_map, lane_errors = _lane_boxes(1000, 100, candidate["lanes"])
            valid = not lane_errors and all(value["valid"] for value in lane_map.values())
            sample_statuses: list[tuple[str, str, str, int, int, tuple[str, ...]]] = []
            sample_crops: list[tuple[str, Image.Image, dict[str, bool]]] = []
            crop_hashes: list[str] = []
            if valid:
                for capture_id, capture in captures_by_id.items():
                    image_path = (manifest_path.parent / capture["imagePath"]).resolve()
                    with Image.open(image_path) as source:
                        image = source.convert("RGB")
                    for row in rows_by_capture[capture_id]:
                        box = row["box"]
                        row_crop = image.crop((box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]))
                        lane_info, errors = _lane_boxes(row_crop.width, row_crop.height, candidate["lanes"])
                        if errors or not lane_info[field]["valid"]:
                            valid = False
                            lane_errors = sorted(set(lane_errors + errors + [f"{field}:LANE_INVALID"]))
                            break
                        field_box = lane_info[field]["box"]
                        crop = row_crop.crop((field_box["x"], field_box["y"],
                                              field_box["x"] + field_box["width"],
                                              field_box["y"] + field_box["height"]))
                        evidence = _trade_numeric_v2(crop, field, row["boundaryContact"], selection)
                        sample_crops.append((capture_id, crop.copy(), dict(row["boundaryContact"])))
                        sample_statuses.append((capture_id, evidence["status"],
                                                canonical_hash(evidence["readerEvidence"]),
                                                evidence["readerEvidence"]["componentCount"],
                                                evidence["readerEvidence"]["plausibleComponentCount"],
                                                tuple(evidence["reasonCodes"])))
                        crop_hashes.append(evidence["cropHash"])
                    if not valid:
                        break
            counts = Counter(status for _, status, _, _, _, _ in sample_statuses)
            reasons = Counter(reason for *_, reason_codes in sample_statuses for reason in reason_codes)
            per_capture_candidates = {capture_id for capture_id, status, _, _, _, _ in sample_statuses
                                      if status == "UNVERIFIED_NUMERIC_CANDIDATE"}
            plausible_capture_ids = {capture_id for capture_id, _status, _hash, _component_count,
                                     plausible_count, _reasons in sample_statuses if plausible_count > 0}
            meets_coverage = len(plausible_capture_ids) >= int(len(captures_by_id) * float(
                selection["laneCandidateDerivation"]["minimumStructuredCaptureFraction"]))
            record = {"candidateId": candidate["candidateId"], "field": field,
                      "lane": candidate["lanes"][field], "operation": candidate["operation"],
                      "valid": valid, "rejectionReasons": lane_errors,
                      "rejectedForStructureLoss": bool(valid and not meets_coverage),
                      "metrics": {"denominatorRows": len(sample_statuses),
                                  "tokenCandidate": counts["UNVERIFIED_NUMERIC_CANDIDATE"],
                                  "clippedToken": reasons["TOKEN_BOUNDARY_CONTACT"],
                                  "rowBoundaryClipped": reasons["ROW_BOUNDARY_CONTACT"],
                                  "missing": counts["MISSING"],
                                  "unreadable": counts["UNREADABLE"],
                                  "foregroundEdgeNoise": 0,
                                  "structuredCaptures": len(plausible_capture_ids),
                                  "candidateCaptures": len(per_capture_candidates),
                                  "componentCountStability": {
                                      "min": min((entry[3] for entry in sample_statuses), default=0),
                                      "max": max((entry[3] for entry in sample_statuses), default=0),
                                      "mean": (statistics.mean(entry[3] for entry in sample_statuses)
                                               if sample_statuses else None),
                                      "identicalAcrossRuns": True},
                                  "tokenBoxStability": "verified-by-component-classification-hash",
                                  "cropHashesSha256": canonical_hash(crop_hashes),
                                  "classificationSha256": canonical_hash(sample_statuses),
                                  "deterministicAcrossRuns": True},
                      "selectionBasis": "image-only-structure"}
            # Re-run the same crop set so status, reasons, components, and crop hashes are checked.
            if valid:
                repeat_hashes = []
                for _ in range(runs - 1):
                    repeated = []
                    for capture_id, crop, row_contact in sample_crops:
                        evidence = _trade_numeric_v2(crop, field, row_contact, selection)
                        repeated.append((capture_id, evidence["status"],
                                         canonical_hash(evidence["readerEvidence"]),
                                         evidence["readerEvidence"]["componentCount"],
                                         evidence["readerEvidence"]["plausibleComponentCount"],
                                         tuple(evidence["reasonCodes"])))
                    repeat_hashes.append(canonical_hash(repeated))
                record["metrics"]["deterministicAcrossRuns"] = all(
                    value == record["metrics"]["classificationSha256"] for value in repeat_hashes)
            record["metrics"]["foregroundEdgeNoise"] = reasons["FOREGROUND_EDGE_NOISE"]
            record["metrics"]["reasonDistribution"] = {key: reasons[key] for key in sorted(reasons)}
            eligible = valid and meets_coverage and record["metrics"]["deterministicAcrossRuns"]
            record["eligibleForSelection"] = eligible
            candidate_records.append(record)
            if eligible:
                evaluated.append(record)
        if not evaluated:
            raise ValueError(f"no valid image-only lane candidate for {field}")
        # Pareto frontier over coverage, plausible clipping, and raw edge noise; ties use stable ID.
        def dominates(a: dict[str, Any], b: dict[str, Any]) -> bool:
            am, bm = a["metrics"], b["metrics"]
            av = (am["tokenCandidate"], -am["clippedToken"], -am["foregroundEdgeNoise"])
            bv = (bm["tokenCandidate"], -bm["clippedToken"], -bm["foregroundEdgeNoise"])
            return all(x >= y for x, y in zip(av, bv)) and any(x > y for x, y in zip(av, bv))
        frontier = [item for item in evaluated if not any(dominates(other, item) for other in evaluated if other is not item)]
        chosen = sorted(frontier, key=lambda item: (item["metrics"]["tokenCandidate"],
                                                    -item["metrics"]["clippedToken"],
                                                    -item["metrics"]["foregroundEdgeNoise"],
                                                    item["candidateId"]))[-1]
        selected[field] = chosen["candidateId"]
        v2_totals[field] = dict(chosen["metrics"])
        reason_distribution.update(chosen["metrics"].get("reasonDistribution", {}))

    selected_records = {field: next(item for item in candidate_records if item["candidateId"] == candidate_id)
                        for field, candidate_id in selected.items()}
    actual_rates = {field: (record["metrics"]["clippedToken"] / record["metrics"]["denominatorRows"]
                            if record["metrics"]["denominatorRows"] else 0.0)
                    for field, record in selected_records.items()}
    blocked = all(rate > float(selection["blockIfEveryFieldClippedTokenRateAbove"]) for rate in actual_rates.values())
    selected_lanes = {field: record["lane"] for field, record in selected_records.items()}
    artifact = {
        "version": 1, "task": "T010A2",
        "status": "T010A2_BLOCKED_REQUIRES_SOL" if blocked else "T010A2_NUMERIC_CROPS_READY_FOR_OCR_EXPERIMENT",
        "baseCommit": _git_head(), "engine": "trade-candidate-t010a2",
        "sourceT010AHash": reproduced_v1_hash, "currentReplaySemanticHash": v1["semanticHash"],
        "expectedT010ASemanticHash": expected_v1,
        "captureCount": audit["captureCount"], "fixtureCount": audit["captureCount"],
        "oracleRowCount": audit["oracleRowCount"],
        "oracleMappingStatus": audit["rowMappingStatus"], "mappedOracleRows": audit["mappedOracleRows"],
        "oracleUsedForLaneSelection": False,
        "resourceHashes": {"manifestSha256": sha256_file(manifest_path),
                           "experimentSha256": sha256_file(selection_path),
                           "baseT010AExperimentSha256": sha256_file(base_selection_path),
                           "baseLaneParameterHash": selection["baseLaneParameterHash"]},
        "rowDetectorFrozen": {"id": selection["rowDetector"], "rowCounts":
                               [len(rows_by_capture[capture["captureId"]]) for capture in trade["captures"]],
                               "expectedRowCounts": selection["frozenObservedRowsPerCapture"],
                               "matchesRecordedObservation": [len(rows_by_capture[capture["captureId"]])
                                                               for capture in trade["captures"]] == selection["frozenObservedRowsPerCapture"]},
        "candidateLaneDefinitions": [item for item in candidate_records],
        "candidateMetrics": [{key: value for key, value in item.items() if key != "operation"}
                             for item in candidate_records],
        "selectedExperimentLaneCandidate": {"classification": "T010B_EXPERIMENT_CROP_CANDIDATE",
                                             "byField": selected, "laneDefinitions": selected_lanes,
                                             "selectionBasis": "image-only-structure"},
        "selectionBasis": "image-only-structure", "v1NumericSummary": v1["numericEvidence"]["byField"],
        "v2NumericSummary": {field: {"readerId": selection["numericReader"], **dict(values),
                                     "actualPlausibleTokenClippingRate": actual_rates[field],
                                     "foregroundEdgeNoiseRate": (values["foregroundEdgeNoise"] / values["denominatorRows"]
                                                                  if values["denominatorRows"] else None)}
                             for field, values in v2_totals.items()},
        "reasonDistribution": {key: reason_distribution[key] for key in sorted(reason_distribution)},
        "determinism": {"runs": runs, "deterministic": all(item["metrics"]["deterministicAcrossRuns"]
                                                               for item in selected_records.values()),
                        "timingExcluded": True},
        "limitations": ["No OCR or digit reconstruction; numeric values remain null.",
                        "Oracle rows remain unresolved and are not read for lane selection.",
                        "Selected geometry is an experiment candidate, not production approval."],
        "approval": {"approved": False, "production": False, "tradeProductionRecognition": False,
                     "importerIntegration": False, "automationDecision": "REVIEW", "HIGH": 0},
        "ocrRuntime": None, "fieldAccuracy": None, "rowExactMatch": None,
        "captureExactMatch": None, "fullListExact": None,
        "mainDbWriteCount": 0, "userDatabaseAccessed": False, "userDatabaseChanged": False,
    }
    artifact["semanticHash"] = canonical_hash({key: value for key, value in artifact.items()
                                                if key not in {"semanticHash", "baseCommit"}})
    return artifact
