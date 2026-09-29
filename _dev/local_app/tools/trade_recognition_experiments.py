#!/usr/bin/env python3
"""Run the oracle-isolated T010A Trade geometry/numeric evidence replay."""
from __future__ import annotations

import json
import statistics
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from local_app.backend.services.trade_recognition import (  # noqa: E402
    canonical_hash, infer_trade_capture, sha256_file,
)


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
