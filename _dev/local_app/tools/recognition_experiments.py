#!/usr/bin/env python3
"""Rebuild T006A frozen-R0 evidence replay artifacts (local output by default)."""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
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


MANIFEST_PATH = ROOT / "tests" / "fixtures" / "recognition-v2" / "manifest.json"
MODEL_MANIFEST_PATH = ROOT / "local_app" / "recognition_data" / "model-manifest.json"
DEFAULT_FEEDBACK = ROOT / "recognition-local" / "legacy-feedback-v7" / "samples.jsonl"
DEFAULT_OUT = ROOT / "recognition-local" / "results" / "warehouse-r0-evidence.json"


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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--feedback-jsonl", type=Path, default=DEFAULT_FEEDBACK)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    result = build_artifact(args.runs, args.feedback_jsonl)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": result["fixtureReplaySummary"]["status"],
                      "semanticEvidenceHash": result["semanticEvidenceHash"],
                      "out": str(args.out)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
