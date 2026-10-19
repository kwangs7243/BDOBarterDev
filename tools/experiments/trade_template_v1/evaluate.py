from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from PIL import Image

from .contracts import canonical_bytes


def _iou(a: dict[str, Any], b: dict[str, Any]) -> float:
    ax0, ay0 = int(a.get("x", 0)), int(a.get("y", 0))
    ax1, ay1 = ax0 + int(a.get("width", 0)), ay0 + int(a.get("height", 0))
    bx0, by0 = int(b.get("x", 0)), int(b.get("y", 0))
    bx1, by1 = bx0 + int(b.get("width", 0)), by0 + int(b.get("height", 0))
    area = max(0, min(ax1, bx1) - max(ax0, bx0)) * max(0, min(ay1, by1) - max(ay0, by0))
    union = max(0, ax1-ax0) * max(0, ay1-ay0) + max(0, bx1-bx0) * max(0, by1-by0) - area
    return area / union if union else 0.0


def _normalize(value: Any) -> Any:
    if isinstance(value, str):
        import unicodedata
        return "".join(unicodedata.normalize("NFC", value).split())
    return value


def _truth_row(truth: dict[str, Any], result_rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    matches = sorted(((_iou(truth.get("rowBox", {}), row.get("rowBox", {})), row) for row in result_rows), key=lambda x: x[0], reverse=True)
    if not matches or matches[0][0] < .90 or (len(matches) > 1 and matches[0][0] == matches[1][0]):
        return None
    return matches[0][1]


def compare_results(baseline: dict[str, Any], candidate: dict[str, Any], truths: list[dict[str, Any]],
                    captures: list[dict[str, Any]], trace: list[dict[str, Any]],
                    split: dict[str, Any], variant: str) -> dict[str, Any]:
    baseline_rows: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    candidate_rows: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in baseline.get("rows", []):
        baseline_rows[str(row.get("captureId"))].append(row)
    for row in candidate.get("rows", []):
        candidate_rows[str(row.get("captureId"))].append(row)
    capture_sha = {str(capture["captureId"]): capture.get("imageSha256") for capture in captures}
    roles = split.get("imageRoles", {})
    test_truths = [truth for truth in truths if roles.get(truth["imageSha256"]) in {"TEST", "TEST_LOCKED", "LEGACY_EVAL"}]
    verified = 0
    correct = wrong_auto = new_wrong = wrong_review = 0
    truth_hit = Counter()
    truth_hit_by_label = Counter()
    values_by_kind: defaultdict[str, set[str]] = defaultdict(set)
    baseline_wrong_ids = set()
    new_wrong_ids = set()
    errors = []
    for truth in test_truths:
        image_sha = truth["imageSha256"]
        capture_id = next((capture_id for capture_id, sha in capture_sha.items() if sha == image_sha), None)
        if not capture_id:
            continue
        brow = _truth_row(truth, baseline_rows.get(capture_id, []))
        crow = _truth_row(truth, candidate_rows.get(capture_id, []))
        if brow is None or crow is None:
            errors.append({"truthId": truth["truthId"], "reason": "ROW_MAPPING_AMBIGUOUS"})
            continue
        field = truth["field"]
        before, after = brow.get("fields", {}).get(field, {}), crow.get("fields", {}).get(field, {})
        value = truth["value"]
        verified += 1
        expected, actual = _normalize(value), _normalize(after.get("corrected"))
        is_correct = expected == actual
        if is_correct:
            correct += 1
        kind = "YIELD_23" if field == "yield" and truth.get("value") in (2, 3) else "YIELD_BLACKSTONE" if field == "yield" else {"island": "NAME_ISLAND", "fromItem": "NAME_FROM_ITEM", "toItem": "NAME_TO_ITEM"}.get(field)
        if after.get("valueSource") == "VERIFIED_TEMPLATE":
            truth_hit[kind or "OTHER"] += 1
            values_by_kind[kind or "OTHER"].add(str(value))
            if kind == "YIELD_23":
                truth_hit_by_label[str(value)] += 1
        baseline_bad = _normalize(before.get("corrected")) != expected
        candidate_bad = not is_correct
        if candidate_bad and after.get("reviewRequired") is False:
            wrong_auto += 1
            if baseline_bad and before.get("reviewRequired") is False:
                baseline_wrong_ids.add(truth["truthId"])
            else:
                new_wrong += 1
                new_wrong_ids.add(truth["truthId"])
            errors.append({"truthId": truth["truthId"], "field": field, "truth": value,
                           "candidate": after.get("corrected"), "reviewRequired": False,
                           "baseline": before.get("corrected")})
        elif candidate_bad and after.get("reviewRequired") is True:
            wrong_review += 1
            errors.append({"truthId": truth["truthId"], "field": field, "truth": value,
                           "candidate": after.get("corrected"), "reviewRequired": True,
                           "baseline": before.get("corrected")})

    baseline_index = {(row.get("captureId"), row.get("ordinal")): row for row in baseline.get("rows", [])}
    candidate_index = {(row.get("captureId"), row.get("ordinal")): row for row in candidate.get("rows", [])}
    membership_lost = len(set(baseline_index) - set(candidate_index))
    unverified_changed = unverified_relaxations = fallback_differences = 0
    for key, brow in baseline_index.items():
        crow = candidate_index.get(key)
        if crow is None:
            continue
        for field in ("island", "fromItem", "toItem", "count", "reqAmount", "yield"):
            before, after = brow.get("fields", {}).get(field, {}), crow.get("fields", {}).get(field, {})
            if canonical_bytes(before) != canonical_bytes(after):
                if after.get("valueSource") == "VERIFIED_TEMPLATE":
                    if not any(t["imageSha256"] == capture_sha.get(str(key[0])) and t["field"] == field for t in test_truths):
                        unverified_changed += 1
                    continue
                fallback_differences += 1
            if before.get("reviewRequired") is True and after.get("reviewRequired") is False:
                has_truth = any(t["imageSha256"] == capture_sha.get(str(key[0])) and t["field"] == field for t in test_truths)
                if not has_truth:
                    unverified_relaxations += 1
    trace_by_kind = Counter(entry.get("kind") for entry in trace if entry.get("status") == "HIT")
    source_groups = defaultdict(set)
    for truth in test_truths:
        kind = "YIELD_23" if truth["field"] == "yield" and truth["value"] in (2, 3) else "YIELD_BLACKSTONE" if truth["field"] == "yield" else {"island": "NAME_ISLAND", "fromItem": "NAME_FROM_ITEM", "toItem": "NAME_TO_ITEM"}.get(truth["field"])
        if kind and truth.get("sourceGroupId"):
            source_groups[kind].add(truth["sourceGroupId"])
    quality = {"verifiedTruthFields": verified, "verifiedCorrectFields": correct,
               "verifiedFieldAccuracy": correct / verified if verified else None,
               "templateHitsWithTruth": sum(truth_hit.values()), "templateHitsByKind": dict(truth_hit),
               "testSourceGroupsByKind": {key: len(value) for key, value in source_groups.items()},
               "distinctBlackstoneTestValues": len(values_by_kind.get("YIELD_BLACKSTONE", set())),
               "testHitsByYieldLabel": dict(truth_hit_by_label),
               "verifiedWrongAutoAccept": wrong_auto, "newVerifiedWrongAutoAccept": new_wrong,
               "wrongAutoAcceptAllFields": None, "wrongCandidatesBlockedByReview": wrong_review,
               "unverifiedChangedFields": unverified_changed,
               "unverifiedReviewRelaxations": unverified_relaxations,
               "fallbackFieldDifferences": fallback_differences,
               "rawSourceMembershipLost": membership_lost,
               "baselineParity": {"matched": max(0, sum(1 for _ in baseline_index) * 6 - fallback_differences),
                                  "differences": fallback_differences},
               "rowMissing": None, "rowExtra": None,
               "traceHitsByKind": dict(trace_by_kind), "errors": errors,
               "truthMappingErrors": len([e for e in errors if e["reason"] == "ROW_MAPPING_AMBIGUOUS"])}
    return quality


def truth_coverage(truths: list[dict[str, Any]], split: dict[str, Any],
                   images: list[dict[str, Any]] | None = None,
                   kind_overrides: dict[str, str] | None = None) -> dict[str, Any]:
    counts = defaultdict(lambda: {"truthFields": 0, "enroll": 0, "calibration": 0, "test": 0,
                                  "distinctValues": set(), "groups": set(), "supportedNativeFields": 0,
                                  "supportedNativeEnroll": 0, "supportedNativeCalibration": 0,
                                  "supportedNativeTest": 0})
    image_by_id = {entry["imageSha256"]: entry for entry in (images or [])}
    for truth in truths:
        field, value = truth["field"], truth["value"]
        kind = (kind_overrides or {}).get(truth["truthId"])
        if kind is None:
            kind = "YIELD_23" if field == "yield" and value in (2, 3) else "YIELD_BLACKSTONE" if field == "yield" else {"island": "NAME_ISLAND", "fromItem": "NAME_FROM_ITEM", "toItem": "NAME_TO_ITEM"}.get(field)
        if kind is None:
            continue
        row = counts[kind]
        row["truthFields"] += 1
        role = truth.get("splitRole", "UNKNOWN")
        if truth.get("sourceGroupId"):
            row["groups"].add(truth["sourceGroupId"])
        if role in {"ENROLL", "CALIBRATION", "TEST", "TEST_LOCKED", "LEGACY_EVAL"}:
            row["distinctValues"].add(str(value))
        if role == "ENROLL": row["enroll"] += 1
        if role == "CALIBRATION": row["calibration"] += 1
        if role in {"TEST", "TEST_LOCKED"}: row["test"] += 1
        image = image_by_id.get(truth["imageSha256"], {})
        metadata = image.get("metadata", {})
        native_layout = (image.get("width") == 987 and image.get("height") == 456
                         and metadata.get("sourceType") == "native-screen"
                         and metadata.get("fidelity", {}).get("rescaled") is False)
        if native_layout:
            row["supportedNativeFields"] += 1
            if role == "ENROLL": row["supportedNativeEnroll"] += 1
            if role == "CALIBRATION": row["supportedNativeCalibration"] += 1
            if role in {"TEST", "TEST_LOCKED"}: row["supportedNativeTest"] += 1
    return {key: {"truthFields": value["truthFields"], "enroll": value["enroll"],
                  "calibration": value["calibration"], "test": value["test"],
                  "distinctValues": len(value["distinctValues"]), "testSourceGroups": len(value["groups"]),
                  "supportedNativeFields": value["supportedNativeFields"],
                  "supportedNativeEnroll": value["supportedNativeEnroll"],
                  "supportedNativeCalibration": value["supportedNativeCalibration"],
                  "supportedNativeTest": value["supportedNativeTest"]}
            for key, value in counts.items()}
