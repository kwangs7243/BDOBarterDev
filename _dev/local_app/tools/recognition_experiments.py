#!/usr/bin/env python3
"""Rebuild T006A frozen-R0 evidence replay artifacts (local output by default)."""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from recognition_benchmark import (  # noqa: E402
    canonical_hash,
    run_benchmark,
    sha256_file,
)
from local_app.backend.services.capture_normalization import (  # noqa: E402
    load_anchor_bundle, load_profile, normalize_capture,
)
from local_app.backend.services.warehouse_candidate_readers import (  # noqa: E402
    Q1_PARAMS, R1_PARAMS, canonical_hash, load_q1_templates, load_r1_templates,
    quantity_roi_from_legacy_crop, quantity_roi_from_slot, run_q1, run_r1,
)
from local_app.backend.services.warehouse_recognition import run_r0_shadow  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402


MANIFEST_PATH = ROOT / "tests" / "fixtures" / "recognition-v2" / "manifest.json"
MODEL_MANIFEST_PATH = ROOT / "local_app" / "recognition_data" / "model-manifest.json"
DEFAULT_FEEDBACK = ROOT / "recognition-local" / "legacy-feedback-v7" / "samples.jsonl"
DEFAULT_OUT = ROOT / "recognition-local" / "results" / "warehouse-r0-evidence.json"
DEFAULT_T006B_OUT = ROOT / "recognition-local" / "results" / "warehouse-candidates-t006b.json"


def _truth_value(record: dict[str, Any], field: str) -> tuple[bool, Any]:
    value = record.get(field) or {}
    return value.get("verified") is True and value.get("status") == "VALUE", value.get("value")


def _classification(expected: dict[str, Any], prediction: dict[str, Any]) -> str:
    scope = expected.get("scope")
    decision = prediction.get("decision")
    if scope in {"EMPTY", "OUT_OF_SCOPE_TIER5"} or decision in {"EMPTY", "TIER5_IGNORE"}:
        return "SKIP"
    item_verified, item_truth = _truth_value(expected, "item")
    quantity_verified, quantity_truth = _truth_value(expected, "quantity")
    quantity = prediction.get("quantity") if isinstance(prediction.get("quantity"), dict) else {}
    item_pred = prediction.get("bestItemId", prediction.get("bestCandidate"))
    quantity_pred = quantity.get("value")
    exact = (item_verified and quantity_verified and item_pred == item_truth
             and type(quantity_pred) is int and quantity_pred == quantity_truth
             and quantity.get("status") == "QUANTITY_MATCH")
    full = item_pred is not None and type(quantity_pred) is int
    accepted = decision == "MATCH"
    reviewed = decision in {"ICON_MATCH_UNKNOWN", "QUANTITY_UNKNOWN", "DUPLICATE_ITEM_DETECTED", "REVIEW", "REJECT"}
    if accepted:
        if not (item_verified and quantity_verified):
            return "UNVERIFIED_ACCEPTED"
        return "CORRECT_ACCEPTED" if exact else "WRONG_ACCEPTED"
    if reviewed:
        if not (item_verified and quantity_verified) or not full:
            return "UNKNOWN_REVIEW"
        return "CORRECT_REVIEW" if exact else "WRONG_REVIEW"
    return "UNVERIFIED"


def _slot_detail(expected: dict[str, Any], prediction: dict[str, Any],
                 evidence: dict[str, Any] | None) -> dict[str, Any]:
    item_verified, item_truth = _truth_value(expected, "item")
    quantity_verified, quantity_truth = _truth_value(expected, "quantity")
    quantity = prediction.get("quantity") if isinstance(prediction.get("quantity"), dict) else {}
    best = prediction.get("bestScore")
    gap = prediction.get("scoreGap")
    decision = prediction.get("decision")
    observations: list[str] = []
    item_causes: list[str] = []
    quantity_causes: list[str] = []
    if item_verified:
        if prediction.get("bestItemId", prediction.get("bestCandidate")) == item_truth:
            item_causes.append("ITEM_TOP1_EXACT")
        else:
            item_causes.append("ITEM_TOP1_WRONG")
    else:
        item_causes.append("ITEM_TRUTH_UNVERIFIED")
    if best is None or gap is None or prediction.get("bestCandidate") is None:
        item_causes.append("ITEM_EVIDENCE_INSUFFICIENT")
    if best is not None and best > 0.35:
        item_causes.append("ITEM_SCORE_ABOVE_R0_LIMIT")
    if gap is not None and gap < 0.045:
        item_causes.append("ITEM_MARGIN_BELOW_R0_LIMIT")
        observations.append("LOW_MARGIN_OBSERVED")
    if quantity_verified:
        if quantity.get("status") != "QUANTITY_MATCH" or type(quantity.get("value")) is not int:
            quantity_causes.append("QUANTITY_UNKNOWN")
        elif quantity.get("value") == quantity_truth:
            quantity_causes.append("QUANTITY_EXACT")
        else:
            quantity_causes.append("QUANTITY_WRONG")
    else:
        quantity_causes.append("QUANTITY_TRUTH_UNVERIFIED")
    digits = quantity.get("digits") or []
    if any(isinstance(digit, dict) and digit.get("presenceDelta", 0) < 0.03 for digit in digits):
        quantity_causes.append("PRESENCE_MARGIN_AMBIGUOUS")
    if any(isinstance(digit, dict) and digit.get("digitGap", float("inf")) < 0.03 for digit in digits):
        quantity_causes.append("DIGIT_MARGIN_AMBIGUOUS")
    if quantity_verified and quantity.get("status") == "QUANTITY_MATCH" and quantity.get("value") != quantity_truth:
        predicted_text = str(quantity.get("value"))
        truth_text = str(quantity_truth)
        if len(predicted_text) == len(truth_text) and digits:
            for index, (truth_digit, predicted_digit) in enumerate(zip(reversed(truth_text), digits)):
                if isinstance(predicted_digit, dict) and predicted_digit.get("digit") != int(truth_digit):
                    observations.append(f"DIGIT_CONFUSION_OBSERVED:{truth_digit}->{predicted_digit.get('digit')}")
        else:
            quantity_causes.append("TOKEN_NOT_FULLY_RECONSTRUCTABLE")
    geometry = (evidence or {}).get("geometryReasons") or []
    return {
        "slot": expected.get("slot"),
        "scope": expected.get("scope"),
        "decision": decision,
        "decisionClassification": _classification(expected, prediction),
        "item": {
            "bestCandidate": prediction.get("bestCandidate"), "bestItemId": prediction.get("bestItemId"),
            "bestScore": best, "secondCandidate": prediction.get("secondCandidate"),
            "secondScore": prediction.get("secondScore"), "scoreGap": gap,
            "truth": {"verified": item_verified, "value": item_truth if item_verified else None},
            "evidence": item_causes,
        },
        "quantity": {
            "status": quantity.get("status"), "value": quantity.get("value"),
            "digits": digits, "truth": {"verified": quantity_verified, "value": quantity_truth if quantity_verified else None},
            "evidence": quantity_causes,
        },
        "observations": observations,
        "hypotheses": [],
        "verifiedCauses": [],
        "geometry": evidence,
        "reviewTrigger": decision if decision not in {"MATCH", "EMPTY", "TIER5_IGNORE"} else None,
    }


def _stored_legacy_wrong_accepted(path: Path | None) -> list[dict[str, Any]]:
    if path is None or not path.is_file():
        return []
    matches = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        sample = json.loads(line)
        if sample.get("decisionClassification") != "WRONG_ACCEPTED":
            continue
        truth = sample.get("fieldTruth", {})
        predicted = sample.get("predictedValue", {})
        matches.append({
            "source": "STORED_LEGACY_PREDICTION",
            "sampleId": sample.get("sampleId"),
            "sourceImageHash": sample.get("sourceImageHash"),
            "slot": sample.get("unitId"),
            "decision": sample.get("decision"),
            "item": {"truth": truth.get("item", {}).get("value") if truth.get("item", {}).get("verified") else None,
                     "truthVerified": truth.get("item", {}).get("verified") is True,
                     "prediction": predicted.get("item")},
            "quantity": {"truth": truth.get("quantity", {}).get("value") if truth.get("quantity", {}).get("verified") else None,
                         "truthVerified": truth.get("quantity", {}).get("verified") is True,
                         "prediction": predicted.get("quantity")},
            "confidence": sample.get("confidence"),
            "predictionConsistent": sample.get("predictionConsistent"),
            "observations": ["ITEM_MISMATCH_OBSERVED"] if (
                truth.get("item", {}).get("verified") is True
                and predicted.get("item") != truth.get("item", {}).get("value")
            ) else ["QUANTITY_MISMATCH_OBSERVED"],
            "digitEvidenceAvailable": False,
        })
    return matches


def build_artifact(runs: int = 10, feedback_jsonl: Path | None = None) -> dict[str, Any]:
    feedback = feedback_jsonl if feedback_jsonl and feedback_jsonl.is_file() else None
    benchmark = run_benchmark("warehouse-v2", MANIFEST_PATH, runs=runs, feedback_jsonl=feedback)
    truth_manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    fixture_defs = {entry["fixtureId"]: entry for entry in truth_manifest["fixtures"]}
    detailed_fixtures = []
    classifications = Counter()
    item_causes = Counter()
    quantity_causes = Counter()
    geometry_causes = Counter()
    correct_review = []
    wrong_accepted = []
    tier5_count = 0
    for result in benchmark["byCapture"]:
        fixture = fixture_defs[result["fixtureId"]]
        truth = json.loads((MANIFEST_PATH.parent / fixture["expectedPath"]).read_text(encoding="utf-8"))
        truth_by_slot = {slot["slot"]: slot for slot in truth["slots"]}
        all_predictions: dict[str, dict[str, Any]] = result.get("r0Predictions", result.get("predictions", {}))
        geometry = (result.get("t006aEvidence") or {}).get("slots", {})
        details = []
        for slot_id, expected in sorted(truth_by_slot.items()):
            prediction = all_predictions.get(slot_id) or {"decision": "UNKNOWN"}
            detail = _slot_detail(expected, prediction, geometry.get(slot_id))
            details.append(detail)
            classification = detail["decisionClassification"]
            classifications[classification] += 1
            item_causes.update(detail["item"]["evidence"])
            quantity_causes.update(detail["quantity"]["evidence"])
            if detail["geometry"]:
                if detail["geometry"].get("geometryValidity") == "VALID_GRID_CROP":
                    geometry_causes["GRID_CROP_VALID"] += 1
                geometry_causes.update(detail["geometry"].get("geometryReasons") or [])
            else:
                geometry_causes["GRID_NOT_FOUND"] += 1
            if classification == "CORRECT_REVIEW":
                correct_review.append({"fixtureId": fixture["fixtureId"], **detail})
            elif classification == "WRONG_ACCEPTED":
                wrong_accepted.append({"fixtureId": fixture["fixtureId"], **detail})
            if expected.get("scope") == "OUT_OF_SCOPE_TIER5":
                tier5_count += 1
        detailed_fixtures.append({
            "fixtureId": fixture["fixtureId"],
            "source": "FULL_FIXTURE_RERUN",
            "imageSha256": fixture["imageHash"],
            "truthHash": fixture["expectedHash"],
            "metrics": {key: result[key] for key in ("item", "quantity", "decision", "reviewSlots", "fullCaptureExact")},
            "slots": details,
        })

    model_manifest = json.loads(MODEL_MANIFEST_PATH.read_text(encoding="utf-8"))
    feedback_summary = benchmark["legacyFeedbackReplay"]
    stored_legacy_wrong = _stored_legacy_wrong_accepted(feedback)
    feedback_manifest_path = feedback.parent / "manifest.json" if feedback else None
    feedback_manifest = (json.loads(feedback_manifest_path.read_text(encoding="utf-8"))
                         if feedback_manifest_path and feedback_manifest_path.is_file() else None)
    measurement_code_hash = sha256_file(Path(__file__))
    implementation_code_hashes = {
        "warehouseRecognitionSha256": sha256_file(ROOT / "local_app" / "backend" / "services" / "warehouse_recognition.py"),
        "recognitionBenchmarkSha256": sha256_file(ROOT / "tools" / "recognition_benchmark.py"),
    }

    legacy_decisions = feedback_summary.get("metrics", {}).get("decisionCounts", {})
    normalized_legacy_decisions = {("UNVERIFIED" if key == "UNKNOWN" else key): value
                                   for key, value in legacy_decisions.items()}
    return {
        "version": 1,
        "task": "T006A",
        "baseCommit": "34005f1bed6da41c823b6ee982839def5dc508ed",
        "implementationCommit": None,
        "measurementCodeSha256": measurement_code_hash,
        "implementationCodeHashes": implementation_code_hashes,
        "engine": {"id": model_manifest["engine"]["id"], "version": model_manifest["engine"]["version"],
                   "stage": "T006A_R0_EVIDENCE_ONLY", "candidateImprovement": False,
                   "policyApproved": False, "HIGH": 0, "automationEligible": False},
        "engineResourceHashes": model_manifest["resources"],
        "dataset": {"manifestSha256": sha256_file(MANIFEST_PATH),
                    "fixtureHashes": {item["fixtureId"]: {"image": item["imageHash"], "truth": item["expectedHash"]}
                                      for item in truth_manifest["fixtures"]}},
        "fixtureReplaySummary": benchmark,
        "fixtureReplays": detailed_fixtures,
        "legacyFeedback": feedback_summary,
        "legacyFeedbackDataset": ({
            "status": "PRESENT",
            "manifestSha256": feedback_summary.get("datasetManifestSha256"),
            "sourceSnapshotHash": feedback_manifest.get("sourceSnapshotHash"),
            "sampleCount": feedback_manifest.get("sampleCount"),
            "captureCount": feedback_manifest.get("captureCount"),
            "labelCounts": feedback_manifest.get("labelCounts"),
            "verifiedFieldCounts": feedback_manifest.get("verifiedFieldCounts"),
            "disputedFieldCounts": feedback_manifest.get("disputedFieldCounts"),
            "sourceAccessMode": feedback_manifest.get("sourceAccessMode"),
            "mainDatabaseWriteCount": feedback_manifest.get("mainDatabaseWriteCount"),
            "trainingPerformed": feedback_manifest.get("trainingPerformed"),
        } if feedback_manifest else {"status": "NOT_PROVIDED"}),
        "legacyDecisionClassifications": normalized_legacy_decisions,
        "decisionClassifications": dict(classifications),
        "correctReviewEvidence": correct_review,
        "wrongAcceptedEvidence": wrong_accepted,
        "storedLegacyWrongAccepted": {
            "count": len(stored_legacy_wrong),
            "source": "STORED_LEGACY_PREDICTION",
            "samples": stored_legacy_wrong,
            "historicalSevenMappingStatus": "UNMAPPED; no evidence ties these samples to the separate documented aggregate",
        },
        "historicalWrongAccepted": {
            "documentedCount": 7, "replayableCount": 0, "mappedSamples": [],
            "status": "DOCUMENTED_AGGREGATE_NOT_REPLAYABLE",
            "reason": "The repository has no screenshot/slot/truth mapping for the documented historical seven; no current sample is substituted.",
        },
        "itemEvidenceSummary": dict(item_causes),
        "quantityEvidenceSummary": dict(quantity_causes),
        "geometryEvidenceSummary": dict(geometry_causes),
        "tier5": {"excludedCount": tier5_count, "metricEligible": False, "classification": "SKIP"},
        "replayModes": {"fixtures": "FULL_FIXTURE_RERUN",
                        "legacyFeedback": "STORED_LEGACY_PREDICTION" if feedback else "NOT_PROVIDED"},
        "missingEvidence": {
            "historicalWrongAcceptedSlotMappings": 7,
            "legacyWrongAcceptedDigitDetails": sum(not bool((row.get("confidence") or {}).get("digits"))
                                                   for row in stored_legacy_wrong),
            "liveScaleAndFullPanelValidity": "DEFERRED_T005A2",
            "wrongAcceptedVerifiedCauses": sum(bool(row["verifiedCauses"]) for row in wrong_accepted),
        },
        "unapprovedParameters": ["R0 thresholds are frozen prototype values; no policy/HIGH calibration is approved."],
        "mainDatabaseWriteCount": 0,
        "userDatabaseAccessed": False,
        "semanticEvidenceHash": canonical_hash({
            "fixtureReplay": [{"fixtureId": row["fixtureId"], "metrics": row["metrics"], "slots": row["slots"]}
                               for row in detailed_fixtures],
            "engineResourceHashes": model_manifest["resources"],
            "measurementCodeSha256": measurement_code_hash,
            "implementationCodeHashes": implementation_code_hashes,
            "legacyFeedbackHashes": {"samples": feedback_summary.get("samplesSha256"),
                                     "manifest": feedback_summary.get("datasetManifestSha256")},
        }),
        "timing": benchmark.get("latency"),
        "environment": benchmark.get("environment"),
    }


def _fixture_candidate_inference(feedback_jsonl: Path | None) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    """Run R0/R1/Q1 for fixtures and stored crops before opening any truth fields."""
    fixture_defs = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))["fixtures"]
    reference = ROOT / "reference" / "barter_items.json"
    quantity_templates_path = TOOLS / "warehouse_patch" / "quantity_templates.npz"
    profile_path = ROOT / "local_app" / "recognition_data" / "profiles.json"
    anchors_path = ROOT / "local_app" / "recognition_data" / "anchors.npz"
    r1_templates = load_r1_templates(reference)
    q1_templates = load_q1_templates(quantity_templates_path)
    profile = load_profile(profile_path)
    anchors = load_anchor_bundle(anchors_path)
    fixtures: list[dict[str, Any]] = []
    reader_times: dict[str, list[float]] = defaultdict(list)

    def measured(reader_id: str, callback):
        started = time.perf_counter_ns()
        result = callback()
        reader_times[reader_id].append((time.perf_counter_ns() - started) / 1_000_000)
        return result

    for fixture in fixture_defs:
        image_path = (MANIFEST_PATH.parent / fixture["imagePath"]).resolve()
        started = time.perf_counter_ns()
        with Image.open(image_path) as source:
            image = source.convert("RGB")
        r0_report = measured("R0_SHADOW_INCLUDING_Q0", lambda: run_r0_shadow(
            image_path, reference, quantity_templates_path, profile_path, anchors_path))[1]
        normalized = normalize_capture(image, profile, anchors)
        slot_rows = []
        for index, raw_slot in enumerate(normalized.rawCrops):
            slot_id = normalized.rawBoxes[index]["unitId"]
            canonical_slot = normalized.canonicalCrops[index]
            raw_icon = normalized.rawRegionCrops[index]["icon"]
            canonical_icon = normalized.canonicalRegionCrops[index]["icon"]
            raw_transform = normalized.measurement.get("transform", {}) if isinstance(normalized.measurement, dict) else {}
            scale_x = float(raw_transform.get("scaleX", raw_slot.width / 45))
            scale_y = float(raw_transform.get("scaleY", raw_slot.height / 45))
            slot_rows.append({
                "slot": slot_id,
                "r0": r0_report["slots"][index],
                "r1": {
                    "raw": measured("R1_RAW", lambda: run_r1(raw_icon, r1_templates)),
                    "canonical": measured("R1_CANONICAL", lambda: run_r1(canonical_icon, r1_templates)),
                },
                "q1": {
                    "raw": measured("Q1_RAW", lambda: run_q1(quantity_roi_from_slot(
                        raw_slot, raw=True, scale_x=scale_x, scale_y=scale_y), q1_templates)),
                    "canonical": measured("Q1_CANONICAL", lambda: run_q1(
                        quantity_roi_from_slot(canonical_slot), q1_templates)),
                },
                "geometry": r0_report["t006aEvidence"]["slots"].get(slot_id),
            })
        fixtures.append({"fixtureId": fixture["fixtureId"], "imagePath": str(image_path),
                         "imageSha256": fixture["imageHash"], "validity": normalized.validity,
                         "slots": slot_rows, "inferenceMs": (time.perf_counter_ns() - started) / 1_000_000})

    legacy_rows = []
    if feedback_jsonl and feedback_jsonl.is_file():
        # Only crop references and opaque sample keys enter inference. No decision or truth labels
        # are consulted until every stored crop candidate has been computed.
        crop_inputs = []
        for line in feedback_jsonl.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            sample = json.loads(line)
            crop_inputs.append((sample.get("sampleId"), sample.get("artifactRefs", {}).get("crop"), sample.get("cropHash")))
        for sample_id, crop_ref, crop_hash in crop_inputs:
            if not crop_ref:
                legacy_rows.append({"sampleId": sample_id, "cropHash": crop_hash, "candidateReplayStatus": "MISSING_CROP"})
                continue
            crop_path = feedback_jsonl.parent / crop_ref
            if not crop_path.is_file():
                legacy_rows.append({"sampleId": sample_id, "cropHash": crop_hash, "candidateReplayStatus": "MISSING_CROP"})
                continue
            with Image.open(crop_path) as source:
                crop = source.convert("RGB")
            started = time.perf_counter_ns()
            q1 = run_q1(quantity_roi_from_legacy_crop(crop), q1_templates)
            legacy_rows.append({"sampleId": sample_id, "cropHash": crop_hash, "q1": q1,
                                "candidateReplayStatus": "REPLAYED",
                                "inferenceMs": (time.perf_counter_ns() - started) / 1_000_000})
    return fixtures, legacy_rows, {"r1Templates": r1_templates, "q1Templates": q1_templates,
                                   "readerTimesMs": dict(reader_times)}


def _candidate_bucket(expected: Any, prediction: Any) -> str:
    if expected is None or prediction is None:
        return "unknown"
    return "exact" if expected == prediction else "wrong"


def build_candidate_artifact(runs: int = 10, feedback_jsonl: Path | None = None) -> dict[str, Any]:
    """Measure isolated R1/Q1 candidate evidence. No policy or reader is activated."""
    fixture_inference, legacy_inference, resources = _fixture_candidate_inference(feedback_jsonl)
    # Truth-bearing files and labels are intentionally opened only after every candidate inference above.
    benchmark = run_benchmark("warehouse-v2", MANIFEST_PATH, runs=runs, feedback_jsonl=None)
    truth_manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    defs = {entry["fixtureId"]: entry for entry in truth_manifest["fixtures"]}
    fixture_results = {row["fixtureId"]: row for row in benchmark["byCapture"]}
    item_counts = Counter()
    quantity_counts = Counter()
    q0_q1_agreement = Counter()
    r0_r1_agreement = Counter()
    confusion_pairs: Counter[tuple[str, str]] = Counter()
    confusion_evidence: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    raw_canonical_item = Counter()
    raw_canonical_quantity = Counter()
    review_analysis = []
    fixture_output = []
    candidate_elapsed = []
    simulation = Counter()
    for capture in fixture_inference:
        fixture = defs[capture["fixtureId"]]
        truth = json.loads((MANIFEST_PATH.parent / fixture["expectedPath"]).read_text(encoding="utf-8"))
        truth_by_slot = {row["slot"]: row for row in truth["slots"]}
        slots = []
        for slot in capture["slots"]:
            expected = truth_by_slot[slot["slot"]]
            if expected.get("scope") == "TARGET_1_4":
                item_truth = expected.get("item", {}).get("value") if expected.get("item", {}).get("verified") else None
                quantity_truth = expected.get("quantity", {}).get("value") if expected.get("quantity", {}).get("verified") else None
                for view in ("raw", "canonical"):
                    r1 = slot["r1"][view]
                    q1 = slot["q1"][view]
                    item_counts[view, _candidate_bucket(item_truth, (r1.get("top1") or {}).get("itemId"))] += 1
                    q1_value = q1.get("value") if q1.get("status") == "VALUE" else None
                    quantity_counts[view, _candidate_bucket(quantity_truth, q1_value)] += 1
                r0_item = slot["r0"].get("bestItemId")
                r1_item = (slot["r1"]["canonical"].get("top1") or {}).get("itemId")
                r0_name = slot["r0"].get("bestCandidate")
                r1_name = (slot["r1"]["canonical"].get("top1") or {}).get("programName")
                r0_r1_agreement["agree" if r0_name == r1_name else "disagree"] += 1
                raw_name = (slot["r1"]["raw"].get("top1") or {}).get("programName")
                raw_canonical_item["agree" if raw_name == r1_name else "disagree"] += 1
                q0 = slot["r0"].get("quantity") or {}
                q1 = slot["q1"]["canonical"]
                q0_value = q0.get("value") if q0.get("status") == "QUANTITY_MATCH" else None
                q1_value = q1.get("value") if q1.get("status") == "VALUE" else None
                raw_q1 = slot["q1"]["raw"]
                raw_q1_value = raw_q1.get("value") if raw_q1.get("status") == "VALUE" else None
                raw_canonical_quantity["agree" if raw_q1_value == q1_value else "disagree"] += 1
                q0_q1_agreement["BOTH_UNKNOWN" if q0_value is None and q1_value is None else
                                "Q0_ONLY" if q0_value is not None and q1_value is None else
                                "Q1_ONLY" if q0_value is None else
                                "EXACT_AGREEMENT" if q0_value == q1_value else "DISAGREE"] += 1
                r1 = slot["r1"]["canonical"]
                top1, top2 = r1.get("top1"), r1.get("top2")
                if top1 and top2:
                    pair = tuple(sorted((top1["programName"], top2["programName"])))
                    confusion_pairs[pair] += 1
                    color_delta = (top1["colorMeanAbsoluteDistance"] - top2["colorMeanAbsoluteDistance"])
                    confusion_evidence[pair].append({
                        "fixtureId": capture["fixtureId"], "slot": slot["slot"],
                        "r0Margin": slot["r0"].get("scoreGap"), "r1NccMargin": r1.get("nccMargin"),
                        "top1Top2ColorMeanAbsoluteDistanceDelta": color_delta,
                        "truthKnown": expected.get("item", {}).get("verified") is True,
                    })
                exact_both = (item_truth is not None and item_truth == r1_item
                              and quantity_truth is not None and q1_value == quantity_truth)
                fallback_exact = (item_truth is not None and item_truth == r0_item
                                  and quantity_truth is not None and quantity_truth == q0_value)
                hypothetical_high = (r0_name is not None and r0_name == r1_name
                                     and q0_value is not None and q0_value == q1_value
                                     and q1.get("status") == "VALUE")
                if hypothetical_high:
                    simulation["hypotheticalHigh"] += 1
                    simulation["hypotheticalWrongHigh" if not exact_both else "hypotheticalExactHigh"] += 1
                else:
                    simulation["hypotheticalReviewCount"] += 1
                    simulation["hypotheticalCorrectReview" if fallback_exact else "hypotheticalWrongReview"] += 1
                if slot["r0"].get("decision") in {"ICON_MATCH_UNKNOWN", "QUANTITY_UNKNOWN", "REVIEW", "REJECT"}:
                    review_analysis.append({
                        "fixtureId": capture["fixtureId"], "slot": slot["slot"],
                        "truth": {"itemId": item_truth, "quantity": quantity_truth},
                        "r0": {"itemId": r0_item, "bestScore": slot["r0"].get("bestScore"),
                               "scoreGap": slot["r0"].get("scoreGap"), "quantity": q0},
                        "r1Raw": slot["r1"]["raw"], "r1Canonical": r1,
                        "q1Raw": slot["q1"]["raw"], "q1Canonical": q1,
                        "geometry": slot["geometry"],
                    })
            candidate_elapsed.append(capture["inferenceMs"])
            slots.append(slot)
        fixture_output.append({"fixtureId": capture["fixtureId"], "imageSha256": capture["imageSha256"],
                               "validity": capture["validity"], "slots": slots})

    # The stored local crop replay uses only the seven wrong-accepted samples and remains separate from
    # the undocumented historical aggregate. Load truths only now, after candidate inference completed.
    legacy_truth = {}
    if feedback_jsonl and feedback_jsonl.is_file():
        for line in feedback_jsonl.read_text(encoding="utf-8").splitlines():
            if line.strip():
                sample = json.loads(line)
                if sample.get("decisionClassification") == "WRONG_ACCEPTED":
                    legacy_truth[sample.get("sampleId")] = sample
    legacy_counts = Counter()
    legacy_output = []
    for row in legacy_inference:
        sample = legacy_truth.get(row["sampleId"], {})
        if sample.get("decisionClassification") != "WRONG_ACCEPTED":
            continue
        truth = sample.get("fieldTruth", {}).get("quantity", {})
        predicted = sample.get("predictedValue", {}).get("quantity")
        q1_result = row.get("q1") or {"status": "MISSING_CROP", "value": None, "qualityReasons": ["MISSING_CROP"]}
        value = q1_result.get("value") if q1_result.get("status") == "VALUE" else None
        outcome = _candidate_bucket(truth.get("value") if truth.get("verified") else None, value)
        legacy_counts[outcome] += 1
        legacy_output.append({"source": "STORED_LEGACY_CROP_REPLAY", "sampleId": row["sampleId"],
                              "cropHash": row["cropHash"], "q0StoredPrediction": predicted,
                              "truthVerified": truth.get("verified") is True,
                              "truth": truth.get("value") if truth.get("verified") else None,
                              "candidateReplayStatus": row.get("candidateReplayStatus"),
                              "q1": q1_result, "outcome": outcome})

    resource_manifest = json.loads(MODEL_MANIFEST_PATH.read_text(encoding="utf-8"))
    r0_summary = benchmark.get("itemMetrics", {})
    q0_summary = benchmark.get("quantityMetrics", {})
    candidates = {
        "version": 1, "task": "T006B", "baseCommit": "ffa6baf3d9128283ae567da8428fae7bfcc59bd6",
        "implementationCommit": None,
        "measurementCodeSha256": sha256_file(Path(__file__)),
        "readerCodeSha256": sha256_file(ROOT / "local_app" / "backend" / "services" / "warehouse_candidate_readers.py"),
        "engine": {"stage": "T006B_CANDIDATE_MEASUREMENT", "candidateImprovement": True,
                   "policyApproved": False, "HIGH": 0, "automationEligible": False},
        "readers": {
            "R1": {"parameters": R1_PARAMS, "parameterHash": canonical_hash(R1_PARAMS),
                   "templatesSha256": resources["r1Templates"]["catalogSha256"],
                   "evidence": "normalized grayscale NCC ranking; color distances remain separate; quantity ROI excluded",
                   "pHash": {"implemented": False, "reason": "NCC and independent color evidence are sufficient for this candidate measurement; no additional uncalibrated similarity channel."}},
            "Q1": {"parameters": Q1_PARAMS, "parameterHash": canonical_hash(Q1_PARAMS),
                   "templatesSha256": resources["q1Templates"]["templatesSha256"],
                   "templateCoverage": resources["q1Templates"]["coverage"],
                   "perDigitTemplateCount": resources["q1Templates"]["perDigitCount"],
                   "evidence": "full lower-slot token band; connected components; distinct-label template distance; abstains on clipping/ambiguity"},
        },
        "dataset": {"fixtureManifestSha256": sha256_file(MANIFEST_PATH),
                    "fixtures": {row["fixtureId"]: row["imageSha256"] for row in fixture_output},
                    "legacyFeedbackSamplesSha256": sha256_file(feedback_jsonl) if feedback_jsonl and feedback_jsonl.is_file() else None,
                    "sourceAccessMode": "LOCAL_EXPORT_READ_ONLY", "userDatabaseAccessed": False},
        "datasetHashes": {"fixtureManifestSha256": sha256_file(MANIFEST_PATH),
                          "legacyFeedbackSamplesSha256": sha256_file(feedback_jsonl) if feedback_jsonl and feedback_jsonl.is_file() else None},
        "blindHoldout": False,
        "candidateResultsAreCalibrationReplay": True,
        "fixtureReplay": {"baselineT006A": benchmark,
                          "r1": {"raw": dict(Counter({key[1]: value for key, value in item_counts.items() if key[0] == "raw"})),
                                 "canonical": dict(Counter({key[1]: value for key, value in item_counts.items() if key[0] == "canonical"}))},
                          "q1": {"raw": dict(Counter({key[1]: value for key, value in quantity_counts.items() if key[0] == "raw"})),
                                 "canonical": dict(Counter({key[1]: value for key, value in quantity_counts.items() if key[0] == "canonical"}))},
                          "r0R1Agreement": dict(r0_r1_agreement), "q0Q1Agreement": dict(q0_q1_agreement),
                          "rawCanonicalItemAgreement": dict(raw_canonical_item),
                          "rawCanonicalQuantityAgreement": dict(raw_canonical_quantity),
                          "confusionPairs": [{"items": list(pair), "count": count,
                                              "truthKnownCount": sum(row["truthKnown"] for row in confusion_evidence[pair]),
                                              "samples": confusion_evidence[pair]}
                                             for pair, count in confusion_pairs.most_common()],
                          "correctReviewAnalysis": review_analysis, "captures": fixture_output},
        "storedLegacyCropReplay": {"source": "STORED_LEGACY_CROP_REPLAY", "count": len(legacy_output),
                                   "outcomes": dict(legacy_counts), "samples": legacy_output,
                                   "historicalAggregateSevenMapping": "UNMAPPED; separate documented aggregate remains replayableCount=0"},
        "resourceHashes": resource_manifest["resources"],
        "itemCandidateMetrics": {
            "R1_RAW": {"exact": item_counts["raw", "exact"], "wrong": item_counts["raw", "wrong"], "unknown": item_counts["raw", "unknown"]},
            "R1_CANONICAL": {"exact": item_counts["canonical", "exact"], "wrong": item_counts["canonical", "wrong"], "unknown": item_counts["canonical", "unknown"]},
        },
        "quantityCandidateMetrics": {
            "Q0_FROZEN": q0_summary,
            "Q1_RAW": {"exact": quantity_counts["raw", "exact"], "wrong": quantity_counts["raw", "wrong"], "unknown": quantity_counts["raw", "unknown"]},
            "Q1_CANONICAL": {"exact": quantity_counts["canonical", "exact"], "wrong": quantity_counts["canonical", "wrong"], "unknown": quantity_counts["canonical", "unknown"]},
        },
        "readerAgreement": {"R0_R1_programNameTop1": dict(r0_r1_agreement), "Q0_Q1": dict(q0_q1_agreement),
                            "R1_RAW_CANONICAL": dict(raw_canonical_item), "Q1_RAW_CANONICAL": dict(raw_canonical_quantity),
                            "sharedReferenceSource": True,
                            "agreementIsIndependentStatisticalConfirmation": False},
        "syntheticNegativeCases": _candidate_negative_cases(resources["q1Templates"], resources["r1Templates"]),
        "timing": {key: {"sampleCount": len(values), "meanMs": sum(values) / len(values) if values else None,
                         "p95Ms": sorted(values)[max(0, int(0.95 * len(values) + 0.999999) - 1)] if values else None}
                   for key, values in resources["readerTimesMs"].items()},
        "policySimulation": {"status": "SIMULATION_ONLY_UNAPPROVED", "approved": False,
                             "conditions": "R0/R1 programName agreement AND Q0/Q1 exact agreement AND Q1 VALUE; otherwise retain R0/Q0 and REVIEW",
                             "hypotheticalHigh": simulation["hypotheticalHigh"],
                             "hypotheticalWrongHigh": simulation["hypotheticalWrongHigh"],
                             "hypotheticalExactHigh": simulation["hypotheticalExactHigh"],
                             "hypotheticalCorrectReview": simulation["hypotheticalCorrectReview"],
                             "hypotheticalWrongReview": simulation["hypotheticalWrongReview"],
                             "hypotheticalReviewCount": simulation["hypotheticalReviewCount"],
                             "candidateCoverage": simulation["hypotheticalHigh"],
                             "activation": False, "thresholdsApproved": False, "strataApproved": False},
        "approval": {"approvedReaders": [], "approvedThresholds": [], "approvedStrata": [],
                     "HIGH": 0, "productionV2Activated": False, "status": "UNAPPROVED"},
        "limitations": ["No independent blind holdout; all reported candidate results are calibration replay.",
                        "R1 shares reference icons with R0; reader agreement is correlated.",
                        "T004 live and T005A2 full-panel validity remain pending.",
                        "Legacy crop replay is not a full-screen R0 scanner replay."],
        "truthLeakageEvidence": {"candidateReaderInputsContainTruth": False,
                                 "candidateReaderInputsContainCurrentStock": False,
                                 "candidateReaderInputsContainHumanCorrection": False,
                                 "candidateInferenceCompletedBeforeFixtureTruthEvaluation": True},
        "protectedBaseline": {"r0Resources": resource_manifest["resources"], "mainDatabaseWriteCount": 0,
                              "userDatabaseAccessed": False, "productionRecognitionEngineChanged": False},
        "semanticEvidenceHash": canonical_hash({"fixtureReplay": fixture_output, "legacy": legacy_output,
                                                 "readers": {"R1": R1_PARAMS, "Q1": Q1_PARAMS},
                                                 "measurementCodeSha256": sha256_file(Path(__file__))}),
    }
    return candidates


def _candidate_negative_cases(q1_templates: dict[str, Any], r1_templates: dict[str, Any]) -> dict[str, Any]:
    """Runtime-only diagnostic cases. No image bytes are persisted in the local artifact."""
    blank = Image.new("RGB", (43, 15), (20, 20, 22))
    q1_blank = run_q1(blank, q1_templates)
    # Use a committed template glyph to prove that a visible zero remains VALUE-capable, distinct from MISSING.
    zero_index = next(index for index, label in enumerate(q1_templates["labels"]) if int(label) == 0)
    glyph = (q1_templates["features"][zero_index].reshape((12, 8)) > 0.5).astype("uint8") * 255
    band = Image.new("RGB", (43, 15), (20, 20, 22))
    band.paste(Image.fromarray(glyph, mode="L").convert("RGB"), (33, 1))
    q1_zero = run_q1(band, q1_templates)
    icon_template = r1_templates["items"][0]["rgb"]
    icon = Image.fromarray((icon_template * 255).astype("uint8"), mode="RGB")
    r1_self = run_r1(icon, r1_templates)
    modified = icon.copy()
    pixels = modified.load()
    pixels[0, 0] = (pixels[0, 0][0], pixels[0, 0][1], 255 - pixels[0, 0][2])
    r1_changed = run_r1(modified, r1_templates)
    # Clipping and structural guards are exercised with runtime-only derived token bands.
    edge_results = {}
    edge_boxes = {"left": (0, 2, 2, 12), "right": (41, 2, 42, 12),
                  "top": (18, 0, 24, 1), "bottom": (18, 14, 24, 14)}
    for edge, box in edge_boxes.items():
        test_band = Image.new("RGB", (43, 15), (20, 20, 22))
        ImageDraw.Draw(test_band).rectangle(box, fill=(255, 255, 255))
        result = run_q1(test_band, q1_templates)
        edge_results[edge] = {"status": result["status"], "reasons": result["qualityReasons"]}
    five = Image.new("RGB", (43, 15), (20, 20, 22))
    for x in (1, 9, 17, 25, 33):
        five.paste(Image.fromarray(glyph, mode="L").convert("RGB"), (x, 1))
    five_result = run_q1(five, q1_templates)
    merged = Image.new("RGB", (43, 15), (20, 20, 22))
    glyph_rgb = Image.fromarray(glyph, mode="L").convert("RGB")
    merged.paste(glyph_rgb, (12, 1))
    merged.paste(glyph_rgb, (17, 1))
    merged_result = run_q1(merged, q1_templates)
    split = Image.new("RGB", (43, 15), (20, 20, 22))
    split.paste(glyph_rgb, (18, 1))
    for y in range(15):
        split.putpixel((22, y), (20, 20, 22))
    split_result = run_q1(split, q1_templates)
    return {
        "zeroVersusMissing": {"zero": {"status": q1_zero["status"], "value": q1_zero["value"], "reasons": q1_zero["qualityReasons"]},
                              "missing": {"status": q1_blank["status"], "value": q1_blank["value"], "reasons": q1_blank["qualityReasons"]}},
        "clippedEdges": edge_results,
        "r1TemplateSelfMatch": {"expectedItemId": r1_templates["items"][0]["itemId"],
                                "top1ItemId": (r1_self.get("top1") or {}).get("itemId"),
                                "finite": bool(r1_self.get("top1") and r1_self["top1"].get("grayscaleNcc") is not None),
                                "changedPixelTop1": (r1_changed.get("top1") or {}).get("itemId")},
        "splitMergeAndFiveDigit": {
            "fiveDigit": {"status": five_result["status"], "reasons": five_result["qualityReasons"]},
            "merged": {"status": merged_result["status"], "reasons": merged_result["qualityReasons"]},
            "split": {"status": split_result["status"], "reasons": split_result["qualityReasons"]},
            "persistedImage": False,
        },
        "itemOodEvidence": {
            "emptySlot": run_r1(Image.new("RGB", (41, 25), (20, 20, 22)), r1_templates),
            "brightnessShifted": run_r1(Image.eval(icon, lambda value: min(255, int(value * 1.12 + 8))), r1_templates),
            "slightCanonicalResampling": run_r1(icon.resize((39, 24), Image.Resampling.BILINEAR), r1_templates),
            "authority": "candidate score distributions only; no nearest-item acceptance threshold",
        },
        "status": "DIAGNOSTIC_ONLY",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--feedback-jsonl", type=Path, default=DEFAULT_FEEDBACK)
    parser.add_argument("--task", choices=("T006A", "T006B"), default="T006B")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    output = args.out or (DEFAULT_OUT if args.task == "T006A" else DEFAULT_T006B_OUT)
    result = build_artifact(args.runs, args.feedback_jsonl) if args.task == "T006A" else build_candidate_artifact(args.runs, args.feedback_jsonl)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": result["fixtureReplaySummary"]["status"],
                      "semanticEvidenceHash": result["semanticEvidenceHash"], "out": str(output)}, ensure_ascii=False, indent=2)
          if args.task == "T006A" else json.dumps({"status": "CANDIDATES_MEASURED", "semanticEvidenceHash": result["semanticEvidenceHash"],
                                                   "out": str(output)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
