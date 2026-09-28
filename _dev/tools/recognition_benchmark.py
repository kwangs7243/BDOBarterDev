#!/usr/bin/env python3
"""Reproducible, oracle-isolated V1 warehouse and legacy Trade baseline harness."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import platform
import statistics
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[1]
TOOL_DIR = ROOT / "tools" / "warehouse_patch"
REFERENCE = ROOT / "reference" / "barter_items.json"
TEMPLATES = TOOL_DIR / "quantity_templates.npz"
REVIEW_DECISIONS = {"ICON_MATCH_UNKNOWN", "QUANTITY_UNKNOWN", "DUPLICATE_ITEM_DETECTED", "REVIEW", "REJECT"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_hash(value: Any) -> str:
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_split_leakage(records: list[dict[str, Any]]) -> None:
    """Reject source captures, exact image hashes, or derivatives across splits."""
    keys: dict[tuple[str, str], set[str]] = defaultdict(set)
    for record in records:
        split = record.get("split")
        if not isinstance(split, str) or not split:
            raise ValueError("every dataset record requires an explicit split")
        values = [
            ("capture", record.get("captureId")),
            ("sourceHash", record.get("sourceImageHash") or record.get("imageHash")),
            ("group", record.get("groupId")),
        ]
        derivatives = record.get("derivativeGroupIds") or []
        values.extend(("derivative", value) for value in derivatives)
        for kind, value in values:
            if value is not None:
                keys[(kind, str(value))].add(split)
    leaked = [f"{kind}:{value}" for (kind, value), splits in keys.items() if len(splits) > 1]
    if leaked:
        raise ValueError("split leakage detected: " + ", ".join(sorted(leaked)))


def verify_manifest(manifest: dict[str, Any], manifest_path: Path) -> dict[str, Any]:
    """Verify raw-byte hashes for every referenced source and expected file."""
    base = manifest_path.parent
    verified: dict[str, str] = {}
    for key, record in manifest.get("baselineFiles", {}).items():
        path = (base / record["path"]).resolve()
        if not path.is_file():
            raise FileNotFoundError(f"baseline source missing ({key}): {path}")
        actual = sha256_file(path)
        if actual != record["sha256"]:
            raise ValueError(f"baseline source hash mismatch ({key})")
        verified[key] = actual
    fixture_records = []
    for fixture in manifest.get("fixtures", []):
        image = (base / fixture["imagePath"]).resolve()
        expected = (base / fixture["expectedPath"]).resolve()
        if not image.is_file() or not expected.is_file():
            raise FileNotFoundError(f"fixture source missing: {fixture.get('fixtureId')}")
        image_hash = sha256_file(image)
        expected_hash = sha256_file(expected)
        if image_hash != fixture["imageHash"] or expected_hash != fixture["expectedHash"]:
            raise ValueError(f"fixture raw-byte hash mismatch: {fixture.get('fixtureId')}")
        fixture_records.append({**fixture, "sourceImageHash": image_hash})
    trade = manifest.get("trade", {})
    for capture in trade.get("captures", []):
        image = (base / capture["imagePath"]).resolve()
        if not image.is_file() or sha256_file(image) != capture["imageHash"]:
            raise ValueError(f"Trade source image hash mismatch: {capture.get('captureId')}")
    trade_records = trade.get("splitRecords", [])
    trade_rows = trade.get("oracleRows", [])
    validate_split_leakage(fixture_records + trade_records + trade_rows)
    group_splits = {group.get("groupId"): group.get("split") for group in manifest.get("groups", [])}
    for record in fixture_records + trade_records + trade_rows:
        if record.get("groupId") not in group_splits or group_splits[record["groupId"]] != record.get("split"):
            raise ValueError(f"split group mismatch: {record.get('groupId')}")
    split_payload = {
        "groups": manifest.get("groups", []),
        "fixtures": [{key: fixture.get(key) for key in ("fixtureId", "groupId", "split", "imageHash")} for fixture in manifest.get("fixtures", [])],
        "tradeSplitRecords": [{key: row.get(key) for key in ("captureId", "groupId", "split", "sourceImageHash", "derivativeGroupIds")} for row in trade_records],
        "tradeOracleRows": [{key: row.get(key) for key in ("oracleRowId", "groupId", "split", "sourceImageHash", "derivativeGroupIds")} for row in trade_rows],
    }
    if canonical_hash(split_payload) != manifest.get("splitManifestHash"):
        raise ValueError("splitManifestHash mismatch")
    return {"baselineFiles": verified, "fixtureCount": len(fixture_records),
            "tradeCaptureCount": len(trade.get("captures", [])), "tradeOracleRowCount": len(trade.get("oracleRows", [])),
            "manifestHash": canonical_hash(manifest), "splitManifestHash": manifest["splitManifestHash"]}


def _load_current_engine() -> Callable[..., tuple[dict[str, Any], dict[str, Any]]]:
    if str(TOOL_DIR) not in sys.path:
        sys.path.insert(0, str(TOOL_DIR))
    from warehouse_patch import convert
    return convert


def _prediction_by_slot(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result = {}
    for slot in report.get("slots", []):
        if isinstance(slot.get("slot"), str):
            result[slot["slot"]] = slot
    return result


def _is_target(expected: dict[str, Any]) -> bool:
    return expected.get("scope") == "TARGET_1_4"


def _truth_value(expected: dict[str, Any], field: str) -> tuple[bool, Any]:
    record = expected.get(field) or {}
    return record.get("verified") is True and record.get("status") == "VALUE", record.get("value")


def _target_slot_truth_complete(expected_slots: list[dict[str, Any]]) -> bool:
    for expected in expected_slots:
        scope = expected.get("scope")
        if scope == "TARGET_1_4":
            item_ok, _ = _truth_value(expected, "item")
            quantity_ok, _ = _truth_value(expected, "quantity")
            if not (item_ok and quantity_ok):
                return False
        elif scope not in {"EMPTY", "OUT_OF_SCOPE_TIER5", "GENERAL_UNKNOWN"}:
            return False
    return True


def _slot_decision(prediction: dict[str, Any]) -> str:
    decision = prediction.get("decision")
    if decision == "MATCH":
        return "ACCEPTED"
    if decision in REVIEW_DECISIONS:
        return "REVIEW"
    if decision in {"EMPTY", "TIER5_IGNORE"}:
        return "SKIP"
    return "UNKNOWN"


def _percentile_nearest_rank(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(percentile * len(ordered)) - 1)
    return ordered[index]


def evaluate_predictions(fixture: dict[str, Any], predictions: dict[str, dict[str, Any]]) -> dict[str, Any]:
    expected_slots = fixture["truth"]["slots"]
    item_counts = Counter()
    quantity_counts = Counter()
    decision_counts = Counter()
    v1_visible_slots = sum(
        predictions.get(expected["slot"], {}).get("decision") not in {"EMPTY", "TIER5_IGNORE"}
        for expected in expected_slots
    )
    v1_exception_slots = sum(
        predictions.get(expected["slot"], {}).get("decision") not in {"MATCH", "EMPTY", "TIER5_IGNORE"}
        for expected in expected_slots
    )
    per_capture_wrong_accepted = 0
    by_slot: dict[str, Counter] = defaultdict(Counter)
    correct_review_reasons: Counter = Counter()
    target_slots = 0
    unverified_target_slots = 0
    all_target_values_exact = True
    required_slot_predictions: dict[str, dict[str, Any]] = {}

    for expected in expected_slots:
        slot_id = expected["slot"]
        prediction = predictions.get(slot_id)
        if prediction is None:
            prediction = {"decision": "UNKNOWN", "bestItemId": None, "bestCandidate": None, "quantity": None}
        if not _is_target(expected):
            continue
        target_slots += 1
        required_slot_predictions[slot_id] = prediction
        item_verified, expected_item = _truth_value(expected, "item")
        quantity_verified, expected_quantity = _truth_value(expected, "quantity")
        predicted_item = prediction.get("bestItemId")
        if predicted_item is None and prediction.get("bestCandidate"):
            predicted_item = prediction.get("bestCandidate")
        item_exact = item_verified and predicted_item == expected_item
        quantity = prediction.get("quantity")
        predicted_quantity = quantity.get("value") if isinstance(quantity, dict) else None
        quantity_status = quantity.get("status") if isinstance(quantity, dict) else None
        quantity_exact = quantity_verified and type(predicted_quantity) is int and predicted_quantity == expected_quantity

        if item_verified:
            item_counts["evaluated"] += 1
            item_counts["exact" if item_exact else "wrong"] += 1
        else:
            item_counts["unverified"] += 1
        if quantity_verified:
            quantity_counts["evaluated"] += 1
            if quantity_status != "QUANTITY_MATCH" or type(predicted_quantity) is not int:
                quantity_counts["unknown"] += 1
                quantity_counts["notExact"] += 1
            elif quantity_exact:
                quantity_counts["exact"] += 1
            else:
                quantity_counts["wrong"] += 1
                quantity_counts["notExact"] += 1
        else:
            quantity_counts["unverified"] += 1
        if not (item_verified and quantity_verified):
            unverified_target_slots += 1
            all_target_values_exact = False
        elif not (item_exact and quantity_exact):
            all_target_values_exact = False

        decision = _slot_decision(prediction)
        fully_verified = item_verified and quantity_verified
        has_full_prediction = predicted_item is not None and type(predicted_quantity) is int
        if not fully_verified:
            decision_counts["unverifiedDecision"] += 1
        elif decision == "ACCEPTED":
            if item_exact and quantity_exact:
                decision_counts["correctAccepted"] += 1
            else:
                decision_counts["wrongAccepted"] += 1
                per_capture_wrong_accepted += 1
        elif decision == "REVIEW":
            if has_full_prediction and item_exact and quantity_exact:
                decision_counts["correctReview"] += 1
                reason = prediction.get("decision") or "UNKNOWN_REASON"
                correct_review_reasons[str(reason)] += 1
            elif has_full_prediction:
                decision_counts["wrongReview"] += 1
            else:
                decision_counts["unknownReview"] += 1
        elif decision == "UNKNOWN":
            decision_counts["rejectedUnknown"] += 1

        by_slot[slot_id]["targetCount"] += 1
        by_slot[slot_id]["itemExact"] += int(item_exact)
        by_slot[slot_id]["itemEvaluated"] += int(item_verified)
        by_slot[slot_id]["quantityExact"] += int(quantity_exact)
        by_slot[slot_id]["quantityEvaluated"] += int(quantity_verified)
        by_slot[slot_id]["reviewCount"] += int(decision == "REVIEW")
        by_slot[slot_id]["wrongAccepted"] += int(fully_verified and decision == "ACCEPTED" and not (item_exact and quantity_exact))

    # Include known EMPTY/TIER5/general semantics when deciding capture exactness.
    scope_exact = True
    for expected in expected_slots:
        prediction = predictions.get(expected["slot"], {})
        decision = prediction.get("decision")
        if expected.get("scope") == "EMPTY" and decision != "EMPTY":
            scope_exact = False
        elif expected.get("scope") == "OUT_OF_SCOPE_TIER5" and decision != "TIER5_IGNORE":
            scope_exact = False
        elif expected.get("scope") == "GENERAL_UNKNOWN" and decision != "ICON_MATCH_UNKNOWN":
            scope_exact = False
        elif expected.get("scope") == "TARGET_1_4" and decision != expected.get("expectedV1Decision"):
            scope_exact = False

    complete_truth = _target_slot_truth_complete(expected_slots)
    full_capture_exact = bool(complete_truth and all_target_values_exact and scope_exact)
    review_slot_count = v1_exception_slots
    return {
        "fixtureId": fixture["fixtureId"],
        "captureId": fixture["captureId"],
        "groupId": fixture["groupId"],
        "split": fixture["split"],
        "profileStratum": fixture.get("profileStratum"),
        "targetSlots": target_slots,
        "unverifiedTargetSlots": unverified_target_slots,
        "item": dict(item_counts),
        "quantity": dict(quantity_counts),
        "decision": dict(decision_counts),
        "reviewSlots": review_slot_count,
        "v1VisibleReviewSlots": v1_visible_slots,
        "captureTruthComplete": complete_truth,
        "fullCaptureExact": full_capture_exact if complete_truth else None,
        "captureWithWrongAccepted": per_capture_wrong_accepted > 0 if complete_truth else None,
        "correctReviewReasons": dict(correct_review_reasons),
        "bySlot": {key: dict(value) for key, value in sorted(by_slot.items())},
        "predictions": required_slot_predictions,
    }


def _ratio(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def summarize_legacy_samples(samples: list[dict[str, Any]]) -> dict[str, Any]:
    """Report historical decisions separately from fixture reruns and truth labels."""
    counts = Counter(sample.get("decisionClassification", "UNCLASSIFIED") for sample in samples)
    by_capture: dict[str, Counter] = defaultdict(Counter)
    for sample in samples:
        capture_id = str(sample.get("captureId") or "UNKNOWN_CAPTURE")
        decision = sample.get("decision")
        if decision not in {"EMPTY", "TIER5_IGNORE"}:
            by_capture[capture_id]["visibleSlots"] += 1
        if decision not in {"MATCH", "EMPTY", "TIER5_IGNORE"}:
            by_capture[capture_id]["reviewSlots"] += 1
    review_samples = [sample for sample in samples
                      if sample.get("decision") not in {"MATCH", "EMPTY", "TIER5_IGNORE"}]
    visible_per_capture = [row["visibleSlots"] for row in by_capture.values()]
    review_per_capture = [row["reviewSlots"] for row in by_capture.values()]
    item_results = Counter()
    quantity_results = Counter()
    for sample in samples:
        prediction_consistent = sample.get("predictionConsistent", True)
        item = sample.get("fieldTruth", {}).get("item", {})
        predicted_item = sample.get("predictedValue", {}).get("item")
        if not prediction_consistent:
            item_results["unverified"] += 1
        elif item.get("verified") is True:
            item_results["exact" if predicted_item == item.get("value") else "wrong"] += 1
        else:
            item_results["unverified"] += 1
        quantity = sample.get("fieldTruth", {}).get("quantity", {})
        predicted_quantity = sample.get("predictedValue", {}).get("quantity")
        if not prediction_consistent:
            quantity_results["unverified"] += 1
        elif quantity.get("verified") is not True:
            quantity_results["unverified"] += 1
        elif type(predicted_quantity) is not int:
            quantity_results["unknown"] += 1
        elif predicted_quantity == quantity.get("value"):
            quantity_results["exact"] += 1
        else:
            quantity_results["wrong"] += 1
    fully_reconstructable = sum(
        sample.get("fieldTruth", {}).get("item", {}).get("verified") is True
        and sample.get("fieldTruth", {}).get("quantity", {}).get("verified") is True
        and sample.get("predictedValue", {}).get("item") is not None
        and type(sample.get("predictedValue", {}).get("quantity")) is int
        for sample in review_samples
    )
    item_review_reconstructable = sum(
        sample.get("fieldTruth", {}).get("item", {}).get("verified") is True
        and sample.get("predictedValue", {}).get("item") is not None
        for sample in review_samples
    )
    item_review_correct = sum(
        sample.get("decision") in REVIEW_DECISIONS
        and sample.get("fieldTruth", {}).get("item", {}).get("verified") is True
        and sample.get("predictedValue", {}).get("item") == sample.get("fieldTruth", {}).get("item", {}).get("value")
        for sample in samples
    )
    missing_review_evidence = {
        "itemTruth": sum(sample.get("fieldTruth", {}).get("item", {}).get("verified") is not True for sample in review_samples),
        "quantityTruth": sum(sample.get("fieldTruth", {}).get("quantity", {}).get("verified") is not True for sample in review_samples),
        "itemPrediction": sum(sample.get("predictedValue", {}).get("item") is None for sample in review_samples),
        "quantityPrediction": sum(type(sample.get("predictedValue", {}).get("quantity")) is not int for sample in review_samples),
    }
    return {
        "sampleCount": len(samples),
        "captureCount": len(by_capture),
        "predictionConflictSampleCount": sum(sample.get("predictionConsistent", True) is False for sample in samples),
        "reviewDecisionCount": len(review_samples),
        "v1VisibleReviewSlots": sum(visible_per_capture),
        "visibleSlotsPerCapture": visible_per_capture,
        "reviewSlotsPerCapture": {
            "mean": statistics.mean(review_per_capture) if review_per_capture else None,
            "median": statistics.median(review_per_capture) if review_per_capture else None,
            "p95": _percentile_nearest_rank([float(value) for value in review_per_capture], 0.95),
            "capturesRequiringReview": sum(value > 0 for value in review_per_capture),
        },
        "decisionCounts": {name: counts[name] for name in (
            "CORRECT_ACCEPTED", "WRONG_ACCEPTED", "UNVERIFIED_ACCEPTED", "CORRECT_REVIEW",
            "WRONG_REVIEW", "UNKNOWN_REVIEW", "UNKNOWN")},
        "verifiedItemFields": sum(sample.get("fieldTruth", {}).get("item", {}).get("verified") is True for sample in samples),
        "verifiedQuantityFields": sum(sample.get("fieldTruth", {}).get("quantity", {}).get("verified") is True for sample in samples),
        "itemFieldResults": {"exact": item_results["exact"], "wrong": item_results["wrong"],
                             "unverified": item_results["unverified"]},
        "quantityFieldResults": {"exact": quantity_results["exact"], "wrong": quantity_results["wrong"],
                                 "unknown": quantity_results["unknown"], "unverified": quantity_results["unverified"]},
        "correctReview": {
            "fullSlotReconstructableCount": fully_reconstructable,
            "itemDecisionReconstructableCount": item_review_reconstructable,
            "itemCorrectReviewCount": item_review_correct,
            "fullSlotNotReconstructableReviewCount": len(review_samples) - fully_reconstructable,
            "missingEvidenceCounts": missing_review_evidence,
        },
        "blindHoldout": False,
    }


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    result = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid JSONL at {path.name}:{line_number}: {error}") from error
        if not isinstance(value, dict):
            raise ValueError(f"expected object at {path.name}:{line_number}")
        result.append(value)
    return result


def _legacy_feedback_replay(path: Path) -> dict[str, Any]:
    manifest_path = path.parent / "manifest.json"
    manifest = load_json(manifest_path) if manifest_path.is_file() else {}
    return {
        "status": "PASS",
        "samplesSha256": sha256_file(path),
        "datasetManifestSha256": sha256_file(manifest_path) if manifest_path.is_file() else None,
        "sourceSnapshotHash": manifest.get("sourceSnapshotHash"),
        "metrics": summarize_legacy_samples(_load_jsonl(path)),
    }


def run_benchmark(engine: str, manifest: str | Path | dict[str, Any], policy: dict[str, Any] | None = None,
                  runs: int = 10, feedback_jsonl: str | Path | None = None) -> dict[str, Any]:
    """Run R0 with fixture images; oracle truth is opened only after inference."""
    if runs < 1:
        raise ValueError("runs must be at least 1")
    if engine != "warehouse-current":
        raise ValueError(f"engine {engine!r} is unavailable in T001; no candidate result was fabricated")
    manifest_path = Path(manifest) if not isinstance(manifest, dict) else None
    loaded = load_json(manifest_path) if manifest_path else manifest
    if manifest_path is None:
        raise ValueError("manifest must be a path so source hashes can be verified")
    audit = verify_manifest(loaded, manifest_path)
    converter = _load_current_engine()
    fixture_results = []
    latency_by_run: list[float] = []
    engine_hash = sha256_file(TOOL_DIR / "warehouse_patch.py")
    reference_hash = sha256_file(REFERENCE)
    template_hash = sha256_file(TEMPLATES)
    for fixture in loaded.get("fixtures", []):
        image_path = (manifest_path.parent / fixture["imagePath"]).resolve()
        first_payload_hash = None
        last_report = None
        timings = []
        for _ in range(runs):
            started = time.perf_counter()
            # The recognizer receives only the input image and frozen resources.
            patch, report = converter(image_path, REFERENCE, TEMPLATES)
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            timings.append(elapsed_ms)
            payload_hash = canonical_hash({"patch": patch, "slots": report.get("slots", [])})
            if first_payload_hash is None:
                first_payload_hash = payload_hash
            elif payload_hash != first_payload_hash:
                raise RuntimeError(f"non-deterministic R0 output for {fixture['fixtureId']}")
            last_report = report
        latency_by_run.extend(timings)
        predictions = _prediction_by_slot(last_report or {})
        truth = load_json((manifest_path.parent / fixture["expectedPath"]).resolve())
        # This evaluation boundary is intentionally after all inference runs.
        record = {**fixture, "truth": truth}
        fixture_results.append(evaluate_predictions(record, predictions))

    item = Counter()
    quantity = Counter()
    decision = Counter()
    review_counts = []
    by_slot: dict[str, Counter] = defaultdict(Counter)
    by_stratum: dict[str, Counter] = defaultdict(Counter)
    correct_review_reasons = Counter()
    v1_visible_slots = 0
    complete_captures = 0
    full_capture_exact = 0
    captures_with_wrong = 0
    unverified_captures = 0
    captures_requiring_review = 0
    for result in fixture_results:
        item.update(result["item"])
        quantity.update(result["quantity"])
        decision.update(result["decision"])
        review_counts.append(result["reviewSlots"])
        v1_visible_slots += result["v1VisibleReviewSlots"]
        if result["reviewSlots"]:
            captures_requiring_review += 1
        stratum = str(result.get("profileStratum") or "UNAVAILABLE")
        by_stratum[stratum]["captures"] += 1
        by_stratum[stratum]["targetSlots"] += result["targetSlots"]
        by_stratum[stratum]["reviewSlots"] += result["reviewSlots"]
        by_stratum[stratum]["wrongAccepted"] += result["decision"].get("wrongAccepted", 0)
        correct_review_reasons.update(result["correctReviewReasons"])
        for slot_id, values in result["bySlot"].items():
            by_slot[slot_id].update(values)
        if result["captureTruthComplete"]:
            complete_captures += 1
            full_capture_exact += int(result["fullCaptureExact"] is True)
            captures_with_wrong += int(result["captureWithWrongAccepted"] is True)
        else:
            unverified_captures += 1

    item_rate = _ratio(item["exact"], item["evaluated"])
    quantity_rate = _ratio(quantity["exact"], quantity["evaluated"])
    review_distribution = {
        "captureCount": len(fixture_results),
        "mean": statistics.mean(review_counts) if review_counts else None,
        "median": statistics.median(review_counts) if review_counts else None,
        "p95": _percentile_nearest_rank([float(value) for value in review_counts], 0.95),
        "capturesRequiringReview": captures_requiring_review,
    }
    run_seconds_mean = statistics.mean(latency_by_run) if latency_by_run else None
    report = {
        "version": 1,
        "status": "PASS",
        "engine": "warehouse-current",
        "engineSemantics": "R0 decisions/proposals; MATCH is reported as accepted and never relabeled HIGH",
        "fixtureCount": len(fixture_results),
        "verifiedUnits": item["evaluated"],
        "unverifiedUnits": item["unverified"],
        "itemMetrics": {
            "evaluatedCount": item["evaluated"], "exact": item["exact"], "wrong": item["wrong"],
            "unverified": item["unverified"], "accuracy": item_rate,
        },
        "quantityMetrics": {
            "evaluatedCount": quantity["evaluated"], "exact": quantity["exact"], "wrong": quantity["wrong"],
            "unknown": quantity["unknown"], "unverified": quantity["unverified"], "exactMatchRate": quantity_rate,
        },
        "decisionMetrics": {
            "correctAccepted": decision["correctAccepted"], "wrongAccepted": decision["wrongAccepted"],
            "correctReview": decision["correctReview"], "wrongReview": decision["wrongReview"],
            "unknownReview": decision["unknownReview"], "rejectedUnknown": decision["rejectedUnknown"],
            "unverifiedDecision": decision["unverifiedDecision"],
            "correctHigh": None, "wrongHigh": None, "highMetricStatus": "UNAVAILABLE_R0_HAS_NO_HIGH_DECISION",
            "correctReviewReasons": dict(correct_review_reasons),
        },
        "captureMetrics": {
            "captureCount": len(fixture_results), "truthCompleteCaptureCount": complete_captures,
            "fullCaptureExactCount": full_capture_exact if complete_captures else None,
            "fullCaptureExactRate": _ratio(full_capture_exact, complete_captures),
            "captureRequiringReview": captures_requiring_review,
            "reviewSlotsPerCapture": review_distribution,
            "captureWithWrongConfirmedResult": captures_with_wrong if complete_captures else None,
            "unverifiedCaptureCount": unverified_captures,
            "captureInvalidCount": None,
            "captureInvalidStatus": "UNAVAILABLE_NO_INVALID_CAPTURE_FIXTURE",
            "v1VisibleReviewSlots": v1_visible_slots,
            "meanV1VisibleReviewSlotsPerCapture": _ratio(v1_visible_slots, len(fixture_results)),
        },
        "byField": {"item": {"exact": item["exact"], "wrong": item["wrong"], "evaluated": item["evaluated"]},
                    "quantity": {"exact": quantity["exact"], "wrong": quantity["wrong"],
                                 "unknown": quantity["unknown"], "evaluated": quantity["evaluated"]}},
        "bySlot": {key: dict(value) for key, value in sorted(by_slot.items())},
        "byCapture": fixture_results,
        "byStratum": {key: dict(value) for key, value in sorted(by_stratum.items())},
        "risk": {"status": "UNAVAILABLE_POLICY_UNAPPROVED", "n": None, "k": None,
                 "upperBound": None, "confidenceLevel": None, "allowableRisk": None},
        "audit": {"runs": runs, "reproducibleOutput": True, "quantileMethod": "nearest-rank",
                  "manifest": audit, "sourceHashes": {"engine": engine_hash, "reference": reference_hash,
                                                        "quantityTemplates": template_hash}},
        "latency": {"measurement": "in-process inference only; excludes process startup/upload/UI/DB",
                    "coldMs": None, "coldStatus": "NOT_MEASURED",
                    "runs": len(latency_by_run), "meanMs": run_seconds_mean,
                    "warmMeanMs": run_seconds_mean, "p95Ms": _percentile_nearest_rank(latency_by_run, 0.95)},
        "peakMemoryBytes": None,
        "policyHash": None,
        "datasetHash": audit["manifestHash"],
        "environment": {"python": platform.python_version(), "platform": platform.platform(),
                        "processor": platform.processor() or None},
        "tradeMetrics": {"fieldAccuracy": None, "rowExactMatch": None,
                         "status": loaded.get("trade", {}).get("status", "UNAVAILABLE")},
        "legacyFeedbackReplay": (_legacy_feedback_replay(Path(feedback_jsonl))
                                 if feedback_jsonl else {"status": "NOT_PROVIDED", "metrics": None}),
        "scopeWarnings": [
            "Known fixture/calibration/replay data only; not a blind holdout.",
            "R0 has no HIGH decision vocabulary; MATCH is kept as V1 accepted behavior.",
            "Profile stratum, risk bound, process peak memory, and independent holdout are unavailable.",
        ],
    }
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--engine", required=True, choices=("warehouse-current", "warehouse-v2", "trade-candidate"))
    parser.add_argument("--policy", type=Path)
    parser.add_argument("--selection", type=Path)
    parser.add_argument("--feedback-jsonl", type=Path,
                        help="optional local-only export from recognition_dataset.py")
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--mode", choices=("shadow",), default="shadow")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = run_benchmark(args.engine, args.manifest,
                               load_json(args.policy) if args.policy else None, args.runs, args.feedback_jsonl)
    except (FileNotFoundError, ValueError, RuntimeError) as error:
        print(json.dumps({"status": "BLOCKED", "reason": str(error)}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 2
    args.out.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    args.out.write_bytes(payload)
    print(json.dumps({"status": result["status"], "engine": result["engine"], "fixtureCount": result["fixtureCount"],
                      "itemMetrics": result["itemMetrics"], "quantityMetrics": result["quantityMetrics"],
                      "decisionMetrics": result["decisionMetrics"], "captureMetrics": result["captureMetrics"],
                      "legacyFeedbackReplay": result["legacyFeedbackReplay"],
                      "out": str(args.out)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
