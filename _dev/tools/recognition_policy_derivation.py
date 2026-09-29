#!/usr/bin/env python3
"""Derive deterministic, non-production warehouse policy candidates from T006B."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "recognition-local" / "results" / "warehouse-candidates-t006b.json"
DEFAULT_OUTPUT = ROOT / "recognition-local" / "results" / "warehouse-policy-candidates-t007a.json"
FIXTURE_MANIFEST = ROOT / "tests" / "fixtures" / "recognition-v2" / "manifest.json"
T006B_RUNNER = ROOT / "local_app" / "tools" / "recognition_experiments.py"
EXPECTED_T006B_SEMANTIC_HASH = "679cc2d1b300c2036574c7b377405b46f10edbd474e7cb3d93997a91ad08091f"

DERIVATION_SPEC: dict[str, Any] = {
    "version": 1,
    "scope": {"capture": "warehouse-grid-crop", "source": "checked-in fixture/replay",
              "geometry": "current-native-observed", "fullPanel": "unsupported",
              "liveWindow": "unsupported", "realGameScale": "unsupported"},
    "truthBoundary": "Readers finish before fixture truth is loaded; truth is joined only for evaluation.",
    "breakpoints": "sorted unique finite observed values plus exact values and adjacent midpoints",
    "operators": {"lowerIsBetter": "<=", "higherIsBetter": ">="},
    "tieBreak": "feature-axis order, then ascending numeric threshold; duplicate high-slot sets keep first",
    "canonicalization": "UTF-8 JSON, sorted keys, compact separators; SHA-256",
    "families": ["A_R0_BASELINE", "B_R0_R1_AGREEMENT", "C_R0_Q0_Q1_FULL_TOKEN", "D_COMBINED_CONSERVATIVE"],
    "q1Comparison": "Q1 ignored for A/B; mandatory VALUE and Q0 exact agreement for C/D",
    "productionActivation": "never; every output decision is hypothetical calibration replay",
}


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _finite(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    result = float(value)
    return result if math.isfinite(result) else None


def observed_breakpoints(values: Iterable[Any]) -> list[float]:
    unique = sorted({number for value in values if (number := _finite(value)) is not None})
    points = set(unique)
    points.update((left + right) / 2 for left, right in zip(unique, unique[1:]))
    return sorted(points)


def resolve_policy_decision(policy: dict[str, Any] | None, candidate_id: str | None,
                            stratum: str | None) -> dict[str, str]:
    """Fail closed; T007A deliberately never returns HIGH, even for a fabricated approval."""
    if not isinstance(policy, dict):
        return {"automationDecision": "REVIEW", "reason": "POLICY_MISSING_OR_INVALID"}
    if not (policy.get("approved") is True and policy.get("usableReviewApproved") is True
            and policy.get("releaseApproved") is True and policy.get("autoApproved") is True):
        return {"automationDecision": "REVIEW", "reason": "POLICY_NOT_APPROVED"}
    if not candidate_id or policy.get("approvedCandidateId") != candidate_id:
        return {"automationDecision": "REVIEW", "reason": "UNKNOWN_CANDIDATE"}
    strata = policy.get("supportedStrata")
    if not isinstance(strata, list) or stratum not in strata:
        return {"automationDecision": "REVIEW", "reason": "UNKNOWN_STRATUM"}
    return {"automationDecision": "REVIEW", "reason": "T007A_PRODUCTION_ACTIVATION_DISABLED"}


def resolve_policy_file(policy_path: Path, candidate_id: str | None,
                        stratum: str | None) -> dict[str, str]:
    """Read an optional policy file and fail closed for absence or malformed JSON."""
    try:
        value = json.loads(policy_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return resolve_policy_decision(None, candidate_id, stratum)
    return resolve_policy_decision(value, candidate_id, stratum)


def _q0(record: dict[str, Any]) -> dict[str, Any]:
    value = record.get("r0", {}).get("quantity") or {}
    return value if isinstance(value, dict) else {}


def _reader(record: dict[str, Any], reader: str, variant: str = "raw") -> dict[str, Any]:
    candidate = record.get(reader, {}).get(variant) or {}
    return candidate if isinstance(candidate, dict) else {}


def _top_id(evidence: dict[str, Any]) -> Any:
    return (evidence.get("top1") or {}).get("itemId")


def _q1_margin(evidence: dict[str, Any]) -> float | None:
    margins = [m for digit in evidence.get("digits", [])
               if (m := _finite(digit.get("distinctLabelMargin"))) is not None]
    return min(margins) if margins else None


def _q0_axis(record: dict[str, Any], name: str) -> float | None:
    digits = _q0(record).get("digits", [])
    values = [v for digit in digits if (v := _finite(digit.get(name))) is not None]
    return min(values) if values else None


def load_verified_records(artifact: dict[str, Any], manifest_path: Path = FIXTURE_MANIFEST) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Join truth only after the candidate artifact has completed reader inference."""
    leakage = artifact.get("truthLeakageEvidence", {})
    if (artifact.get("task") != "T006B" or artifact.get("blindHoldout") is not False
            or artifact.get("candidateResultsAreCalibrationReplay") is not True
            or leakage.get("candidateReaderInputsContainTruth") is not False
            or leakage.get("candidateReaderInputsContainCurrentStock") is not False
            or leakage.get("candidateReaderInputsContainHumanCorrection") is not False
            or leakage.get("candidateInferenceCompletedBeforeFixtureTruthEvaluation") is not True):
        raise ValueError("T006B artifact does not prove an unapproved, truth-isolated calibration replay")
    if artifact.get("semanticEvidenceHash") != EXPECTED_T006B_SEMANTIC_HASH:
        raise ValueError("T006B semantic evidence hash differs from the Sol-reviewed input")
    if artifact.get("approval", {}).get("productionV2Activated") is not False:
        raise ValueError("T006B production activation must remain false")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest_digest = sha256_file(manifest_path)
    if artifact.get("datasetHashes", {}).get("fixtureManifestSha256") != manifest_digest:
        raise ValueError("T006B fixture manifest hash differs from the checked-in dataset")
    expected_by_id: dict[str, dict[str, dict[str, Any]]] = {}
    expected_base = manifest_path.parent
    for fixture in manifest.get("fixtures", []):
        expected_path = expected_base / fixture["expectedPath"]
        if sha256_file(expected_path) != fixture["expectedHash"]:
            raise ValueError(f"fixture truth hash mismatch: {fixture['fixtureId']}")
        truth = json.loads(expected_path.read_text(encoding="utf-8"))
        expected_by_id[fixture["fixtureId"]] = {slot["slot"]: slot for slot in truth["slots"]}

    records: list[dict[str, Any]] = []
    counts = {"targetVerified": 0, "emptySkipped": 0, "tier5Skipped": 0,
              "generalUnknownExcluded": 0, "generalUnknownByCapture": {}, "unverifiedExcluded": 0}
    for capture in artifact.get("fixtureReplay", {}).get("captures", []):
        truth_slots = expected_by_id.get(capture.get("fixtureId"))
        if truth_slots is None:
            raise ValueError(f"unknown T006B fixture id: {capture.get('fixtureId')}")
        if capture.get("validity") != "VALID_GRID_CROP":
            raise ValueError(f"unsupported calibration geometry for {capture.get('fixtureId')}")
        for source in capture.get("slots", []):
            truth = truth_slots.get(source.get("slot"))
            if truth is None:
                raise ValueError(f"fixture slot missing from truth: {source.get('slot')}")
            scope = truth.get("scope")
            if scope == "EMPTY":
                counts["emptySkipped"] += 1
                continue
            if scope == "OUT_OF_SCOPE_TIER5":
                counts["tier5Skipped"] += 1
                continue
            if scope == "GENERAL_UNKNOWN":
                counts["generalUnknownExcluded"] += 1
                counts["generalUnknownByCapture"][capture["fixtureId"]] = counts["generalUnknownByCapture"].get(capture["fixtureId"], 0) + 1
                continue
            item, quantity = truth.get("item", {}), truth.get("quantity", {})
            if (scope != "TARGET_1_4" or item.get("verified") is not True or quantity.get("verified") is not True
                    or not isinstance(item.get("value"), int) or not isinstance(quantity.get("value"), int)):
                counts["unverifiedExcluded"] += 1
                continue
            counts["targetVerified"] += 1
            records.append({"fixtureId": capture["fixtureId"], "slot": source["slot"],
                            "captureValidity": capture["validity"], "evidence": source,
                            "truth": {"itemId": item["value"], "quantity": quantity["value"]}})
    records.sort(key=lambda row: (row["fixtureId"], row["slot"]))
    return records, counts


def _base_gates(family: str, record: dict[str, Any], q1_mode: str) -> bool:
    e = record["evidence"]
    r0 = e.get("r0", {})
    q0 = _q0(e)
    if r0.get("bestItemId") is None or q0.get("status") != "QUANTITY_MATCH" or not isinstance(q0.get("value"), int):
        return False
    if family in ("B_R0_R1_AGREEMENT", "D_COMBINED_CONSERVATIVE"):
        r1, r1c = _reader(e, "r1"), _reader(e, "r1", "canonical")
        if (_top_id(r1) != r0.get("bestItemId") or _top_id(r1) is None
                or _top_id(r1) != _top_id(r1c)):
            return False
    if family in ("C_R0_Q0_Q1_FULL_TOKEN", "D_COMBINED_CONSERVATIVE") and q1_mode == "mandatory":
        q1, q1c = _reader(e, "q1"), _reader(e, "q1", "canonical")
        if (q1.get("status") != "VALUE" or not isinstance(q1.get("value"), int)
                or q1.get("value") != q0.get("value") or q1c.get("status") != "VALUE"
                or q1c.get("value") != q1.get("value")):
            return False
    if family == "D_COMBINED_CONSERVATIVE" and e.get("geometry", {}).get("geometryValidity") != "VALID_GRID_CROP":
        return False
    return True


def _axis_value(record: dict[str, Any], axis: str) -> float | None:
    e = record["evidence"]
    if axis == "r0BestScore":
        return _finite(e.get("r0", {}).get("bestScore"))
    if axis == "r0ScoreGap":
        return _finite(e.get("r0", {}).get("scoreGap"))
    if axis == "r1NccMargin":
        return _finite(_reader(e, "r1").get("nccMargin"))
    if axis == "r1ColorMeanAbsoluteDistance":
        return _finite((_reader(e, "r1").get("top1") or {}).get("colorMeanAbsoluteDistance"))
    if axis == "q0PresenceDeltaMin":
        return _q0_axis(e, "presenceDelta")
    if axis == "q0DigitGapMin":
        return _q0_axis(e, "digitGap")
    if axis == "q1DistinctLabelMarginMin":
        return _q1_margin(_reader(e, "q1"))
    raise KeyError(axis)


AXIS_DIRECTION = {"r0BestScore": "lower", "r0ScoreGap": "higher", "r1NccMargin": "higher",
                  "r1ColorMeanAbsoluteDistance": "lower", "q0PresenceDeltaMin": "higher",
                  "q0DigitGapMin": "higher", "q1DistinctLabelMarginMin": "higher"}


def _axis_supported(family: str, axis: str, q1_mode: str) -> bool:
    if axis in ("r0BestScore", "r0ScoreGap", "q0PresenceDeltaMin", "q0DigitGapMin"):
        return True
    if axis in ("r1NccMargin", "r1ColorMeanAbsoluteDistance"):
        return family in ("B_R0_R1_AGREEMENT", "D_COMBINED_CONSERVATIVE")
    if axis == "q1DistinctLabelMarginMin":
        return q1_mode == "mandatory" and family in ("C_R0_Q0_Q1_FULL_TOKEN", "D_COMBINED_CONSERVATIVE")
    return False


def _passes_axis(value: float | None, axis: str, threshold: float) -> bool:
    if value is None:
        return False
    return value <= threshold if AXIS_DIRECTION[axis] == "lower" else value >= threshold


def _threshold_rule(family: str, q1_mode: str, thresholds: dict[str, float],
                    records: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    conditions = {"family": family, "q1Mode": q1_mode, "baseGates": True,
                  "thresholds": {key: thresholds[key] for key in sorted(thresholds)}}
    rule_id = canonical_hash(conditions)
    selected = []
    for record in records:
        if not _base_gates(family, record, q1_mode):
            continue
        if all(_passes_axis(_axis_value(record, axis), axis, cut) for axis, cut in thresholds.items()):
            selected.append(record)
    return {"candidateId": "t007a-" + rule_id[:16], "candidateHash": rule_id,
            "family": family, "conditions": conditions}, selected


def generate_candidates(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    families = ["A_R0_BASELINE", "B_R0_R1_AGREEMENT", "C_R0_Q0_Q1_FULL_TOKEN", "D_COMBINED_CONSERVATIVE"]
    candidates: list[dict[str, Any]] = []
    for family in families:
        modes = ["ignored"] if family in ("A_R0_BASELINE", "B_R0_R1_AGREEMENT") else ["mandatory"]
        for q1_mode in modes:
            axes = [axis for axis in AXIS_DIRECTION if _axis_supported(family, axis, q1_mode)]
            # Precompute observed cuts as integer bitsets; threshold semantics stay explicit,
            # while the pairwise score/gap frontier avoids rescanning evidence for each rule.
            base_mask = 0
            for index, row in enumerate(records):
                if _base_gates(family, row, q1_mode):
                    base_mask |= 1 << index

            axis_masks: dict[str, list[tuple[float, int]]] = {}
            for axis in axes:
                points = observed_breakpoints(_axis_value(row, axis) for row in records)
                cuts = []
                for threshold in points:
                    mask = 0
                    for index, row in enumerate(records):
                        if _passes_axis(_axis_value(row, axis), axis, threshold):
                            mask |= 1 << index
                    cuts.append((threshold, mask))
                axis_masks[axis] = cuts

            # Sweep R0 score and gap jointly; sweep each remaining observed feature independently.
            score_points = observed_breakpoints(_axis_value(row, "r0BestScore") for row in records)
            gap_points = observed_breakpoints(_axis_value(row, "r0ScoreGap") for row in records)
            by_selected: dict[int, dict[str, float]] = {}
            axis_order = {axis: index for index, axis in enumerate(AXIS_DIRECTION)}

            def retain(mask: int, thresholds: dict[str, float]) -> None:
                prior = by_selected.get(mask)
                order_key = tuple((axis_order[key], thresholds[key]) for key in AXIS_DIRECTION if key in thresholds)
                prior_order = tuple((axis_order[key], prior[key]) for key in AXIS_DIRECTION if prior and key in prior)
                if prior is None or order_key < prior_order:
                    by_selected[mask] = dict(thresholds)

            retain(base_mask, {})
            score_masks = axis_masks["r0BestScore"]
            gap_masks = axis_masks["r0ScoreGap"]
            for score, score_mask in score_masks:
                retain(base_mask & score_mask, {"r0BestScore": score})
                for gap, gap_mask in gap_masks:
                    retain(base_mask & score_mask & gap_mask, {"r0BestScore": score, "r0ScoreGap": gap})
            for gap, gap_mask in gap_masks:
                retain(base_mask & gap_mask, {"r0ScoreGap": gap})
            for axis in axes:
                if axis in ("r0BestScore", "r0ScoreGap"):
                    continue
                for threshold, feature_mask in axis_masks[axis]:
                    retain(base_mask & feature_mask, {axis: threshold})

            for mask in sorted(by_selected):
                thresholds = by_selected[mask]
                conditions = {"family": family, "q1Mode": q1_mode, "baseGates": True,
                              "thresholds": {key: thresholds[key] for key in sorted(thresholds)}}
                rule_hash = canonical_hash(conditions)
                high_slots = [f"{records[index]['fixtureId']}:{records[index]['slot']}"
                              for index in range(len(records)) if mask & (1 << index)]
                candidates.append({"candidateId": "t007a-" + rule_hash[:16], "candidateHash": rule_hash,
                                   "family": family, "conditions": conditions, "highSlots": high_slots})
    candidates.sort(key=lambda c: (c["family"], c["candidateHash"]))
    return candidates


def evaluate_candidate(candidate: dict[str, Any], records: list[dict[str, Any]],
                       scope_counts: dict[str, Any] | None = None) -> dict[str, Any]:
    high = set(candidate.get("highSlots", []))
    correct_high = wrong_high = correct_review = wrong_review = unknown_review = 0
    review_by_capture: dict[str, int] = {}
    correct_review_slots: list[str] = []
    for record in records:
        key = f"{record['fixtureId']}:{record['slot']}"
        truth = record["truth"]
        e = record["evidence"]
        q0 = _q0(e)
        exact = (e.get("r0", {}).get("bestItemId") == truth.get("itemId")
                 and q0.get("value") == truth.get("quantity")
                 and q0.get("status") == "QUANTITY_MATCH")
        if key in high:
            if exact:
                correct_high += 1
            else:
                wrong_high += 1
        else:
            review_by_capture[record["fixtureId"]] = review_by_capture.get(record["fixtureId"], 0) + 1
            if exact:
                correct_review += 1
                correct_review_slots.append(key)
            elif e.get("r0", {}).get("bestItemId") is None or not isinstance(q0.get("value"), int):
                unknown_review += 1
            else:
                wrong_review += 1
    target_count = len(records)
    counts = scope_counts or {}
    unknown_by_capture = counts.get("generalUnknownByCapture", {})
    for capture_id, count in unknown_by_capture.items():
        review_by_capture[capture_id] = review_by_capture.get(capture_id, 0) + count
        unknown_review += count
    capture_count = len(set(row["fixtureId"] for row in records) | set(unknown_by_capture))
    review_count = target_count - len(high) + sum(unknown_by_capture.values())
    wrong_high_status = "REJECTED_ON_CALIBRATION" if wrong_high else "CALIBRATION_REPLAY_ONLY"
    return {
        "evaluatedVerifiedSlots": target_count,
        "hypotheticalHigh": len(high), "hypotheticalCorrectHigh": correct_high,
        "observedWrongHigh": wrong_high, "candidateStatus": wrong_high_status,
        "correctReview": correct_review, "wrongReview": wrong_review, "unknownReview": unknown_review,
        "coverage": (len(high) / target_count) if target_count else 0.0,
        "reviewSlots": review_count,
        "reviewSlotsPerCapture": {"total": review_count, "captureCount": capture_count,
                                  "mean": review_count / capture_count if capture_count else None,
                                  "byCapture": review_by_capture},
        "capturesRequiringReview": sum(value > 0 for value in review_by_capture.values()),
        "legacyWrongAccepted": {"count": 7, "containedByReview": 0,
                                "hypotheticalHigh": 0, "evidenceIncomplete": 7,
                                "hypotheticalDecision": "EVIDENCE_INCOMPLETE",
                                "reason": "Stored crops lack full-screen R0/R1 and frozen grid geometry; no missing evidence is fabricated."},
        "unsupportedOrEvidenceIncomplete": 7 + sum(unknown_by_capture.values()) + counts.get("unverifiedExcluded", 0),
        "unsupportedFixtureReview": sum(unknown_by_capture.values()),
        "correctReviewSlots": correct_review_slots,
    }


def _nondominated(rows: list[dict[str, Any]], metrics: dict[str, dict[str, Any]]) -> list[str]:
    viable = [row["candidateId"] for row in rows if metrics[row["candidateId"]]["observedWrongHigh"] == 0]
    keep: list[str] = []
    for candidate_id in viable:
        metric = metrics[candidate_id]
        dominated = False
        for other_id in viable:
            if other_id == candidate_id:
                continue
            other = metrics[other_id]
            if (other["hypotheticalHigh"] >= metric["hypotheticalHigh"]
                    and other["reviewSlots"] <= metric["reviewSlots"]
                    and other["unsupportedOrEvidenceIncomplete"] <= metric["unsupportedOrEvidenceIncomplete"]
                    and (other["hypotheticalHigh"] > metric["hypotheticalHigh"]
                         or other["reviewSlots"] < metric["reviewSlots"])):
                dominated = True
                break
        if not dominated:
            keep.append(candidate_id)
    return sorted(keep)


def build_result(artifact: dict[str, Any], artifact_path: Path, manifest_path: Path = FIXTURE_MANIFEST) -> dict[str, Any]:
    records, counts = load_verified_records(artifact, manifest_path)
    candidates = generate_candidates(records)
    metrics = {candidate["candidateId"]: evaluate_candidate(candidate, records, counts) for candidate in candidates}
    review_slots = {f"{row['fixtureId']}:{row['slot']}" for row in records
                    if row["evidence"].get("r0", {}).get("decision") != "MATCH"}
    correct_review_slots = {f"{row['fixtureId']}:{row['slot']}" for row in records
                            if f"{row['fixtureId']}:{row['slot']}" in review_slots
                            and row["evidence"].get("r0", {}).get("bestItemId") == row["truth"]["itemId"]
                            and _q0(row["evidence"]).get("status") == "QUANTITY_MATCH"
                            and _q0(row["evidence"]).get("value") == row["truth"]["quantity"]}
    correct_review_baseline = len(correct_review_slots)
    review_slots.update(f"{fixture_id}:UNVERIFIED:{index}" for fixture_id, count in counts["generalUnknownByCapture"].items()
                        for index in range(count))
    candidate_by_id = {candidate["candidateId"]: candidate for candidate in candidates}
    correct_review_comparison = {
        "baselineCorrectReview": correct_review_baseline,
        "baselineReviewSlots": len(review_slots),
        "perCandidate": {candidate_id: {"correctReview": metrics[candidate_id]["correctReview"],
                                         "stillReviewCorrect": len(correct_review_slots & set(metrics[candidate_id]["correctReviewSlots"])),
                                         "correctReviewPromotedToHypotheticalHigh": len(correct_review_slots & set(candidate_by_id[candidate_id]["highSlots"]))}
                          for candidate_id in sorted(metrics)},
    }
    legacy_comparison = {candidate_id: metrics[candidate_id]["legacyWrongAccepted"] for candidate_id in sorted(metrics)}
    rejected = sorted(candidate_id for candidate_id, metric in metrics.items() if metric["observedWrongHigh"] >= 1)
    nondominated = _nondominated(candidates, metrics)
    for candidate in candidates:
        candidate.pop("highSlots", None)
        candidate["metrics"] = metrics[candidate["candidateId"]]

    resource_hashes = artifact.get("resourceHashes", {})
    readers = artifact.get("readers", {})
    model_manifest_path = ROOT / "local_app" / "recognition_data" / "model-manifest.json"
    model_manifest = json.loads(model_manifest_path.read_text(encoding="utf-8"))
    hashes = {
        "t006bSemanticEvidence": artifact.get("semanticEvidenceHash"),
        "t006bArtifactRawSha256": sha256_file(artifact_path),
        "r0Resources": resource_hashes,
        "r1ImplementationAndParameters": {"sharedReaderSourceSha256": artifact.get("readerCodeSha256"),
                                          "parameters": readers.get("R1", {}).get("parameterHash")},
        "q1ImplementationAndParameters": {"sharedReaderSourceSha256": artifact.get("readerCodeSha256"),
                                          "parameters": readers.get("Q1", {}).get("parameterHash")},
        "fixtureManifestSha256": artifact.get("datasetHashes", {}).get("fixtureManifestSha256"),
        "legacyFeedbackSamplesSha256": artifact.get("datasetHashes", {}).get("legacyFeedbackSamplesSha256"),
        "t005a1ProfileSha256": resource_hashes.get("profileSha256"),
        "t005a1AnchorLogicalSha256": resource_hashes.get("anchorLogicalSha256"),
        "derivationSpecSha256": canonical_hash(DERIVATION_SPEC),
        "modelManifestSha256": sha256_file(model_manifest_path),
    }
    total = len(records)
    result = {
        "version": 1, "task": "T007A_POLICY_FRONTIER", "inputHashes": hashes,
        "derivationSpec": DERIVATION_SPEC, "fixtureScopeCounts": counts,
        "candidateCount": len(candidates), "rejectedCandidates": rejected,
        "nonDominatedCandidates": nondominated, "candidateMetrics": candidates,
        "correctReviewComparison": correct_review_comparison,
        "legacyWrongAcceptedComparison": legacy_comparison,
        "captureWorkload": {"verifiedTargetSlots": total, "captureCount": len({r["fixtureId"] for r in records}),
                            "baselineReviewSlots": len(review_slots), "baselineReviewSlotsPerCapture": len(review_slots) / max(1, len({r['fixtureId'] for r in records})),
                            "baselineCorrectReview": correct_review_baseline,
                            "baselineUnsupportedReview": sum(counts["generalUnknownByCapture"].values())},
        "limitations": ["CALIBRATION_REPLAY_ONLY", "blindHoldout=false", "not validated accuracy or production risk",
                        "native checked-fixture/replay geometry only", "T004 live and T005A2 full-panel remain pending",
                        "Sol selection required; no candidate is recommended", "historical documented aggregate 7 mapped=0 and excluded from denominator"],
        "historicalDocumentedAggregate": {"documentedCount": 7, "mapped": 0, "denominatorIncluded": False},
        "approval": {"approved": False, "usableReviewApproved": False, "releaseApproved": False,
                     "autoApproved": False, "approvedCandidateId": None, "supportedStrata": [],
                     "auditFrequency": None, "confidenceLevel": None, "allowedRisk": None,
                     "productionV2Activated": False, "HIGHAuthority": False},
        "selection": "Sol selection required",
    }
    result["semanticHash"] = canonical_hash(result)
    return result


def ensure_t006b(input_path: Path) -> None:
    if input_path.is_file():
        return
    completed = subprocess.run([sys.executable, str(T006B_RUNNER), "--task", "T006B", "--runs", "10"],
                               cwd=ROOT, check=False)
    if completed.returncode != 0 or not input_path.is_file():
        raise RuntimeError("T006B reproducible runner failed to create the required local artifact")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args(argv)
    ensure_t006b(args.input)
    artifact = json.loads(args.input.read_text(encoding="utf-8"))
    result = build_result(artifact, args.input)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"task": result["task"], "candidateCount": result["candidateCount"],
                      "rejectedWrongHigh": len(result["rejectedCandidates"]),
                      "nonDominatedCount": len(result["nonDominatedCandidates"]),
                      "semanticHash": result["semanticHash"], "out": str(args.out)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
