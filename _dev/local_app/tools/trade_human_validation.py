"""Local-only T010B2 postprocessing and human-validation pilot server."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import re
import tempfile
import threading
import webbrowser
from collections import Counter, defaultdict
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in os.sys.path:
    os.sys.path.insert(0, str(ROOT))
from local_app.backend.services.trade_recognition import canonical_hash, sha256_file  # noqa: E402
from local_app.tools.trade_ocr_experiment import (  # noqa: E402
    FIELDS, NUMERIC_FIELDS, TEXT_FIELDS, _semantic_signature,
    catalog_candidate_evidence, normalize_text, strict_numeric_candidate,
)

TASK = "T010B2"
EXPECTED_T010B1_SEMANTIC_HASH = "ff73a677a7712628741606d1282557c8e6984673aa2b34d8535386cd6a434eab"
PILOT_ID = "spec008-t010b2-calibration-pilot-v1"
PILOT_SIZE = 24
LABEL_ACTIONS = {"CONFIRM", "CORRECT", "UNREADABLE", "UNVERIFIED"}
DATA_DIR = ROOT / "recognition-local" / "human-validation" / "t010b2"
ARTIFACT_PATH = ROOT / "recognition-local" / "results" / "trade-ocr-t010b1.json"
CATALOG_PATH = ROOT / "local_app" / "frontend" / "data" / "trade-catalog.json"
MANIFEST_PATH = ROOT / "tests" / "fixtures" / "recognition-v2" / "manifest.json"


def _unique_strings(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    return list(dict.fromkeys(value for value in values if isinstance(value, str) and value.strip()))


def load_catalog_sets(catalog: dict[str, Any]) -> dict[str, Any]:
    islands = _unique_strings(catalog.get("islands"))
    item_values: list[str] = []
    master = catalog.get("masterData")
    if isinstance(master, dict):
        for tier_values in master.values():
            item_values.extend(_unique_strings(tier_values))
    item_values.extend(_unique_strings(catalog.get("specialItems")))
    items = list(dict.fromkeys(item_values))
    if not islands or not items:
        raise ValueError("Trade catalog must provide islands and masterData/specialItems")
    return {
        "islandCandidates": islands,
        "itemCandidates": items,
        "islandSet": {"count": len(islands), "sha256": canonical_hash(sorted(islands))},
        "itemSet": {"count": len(items), "sha256": canonical_hash(sorted(items))},
    }


def verify_t010b1_artifact(artifact: dict[str, Any],
                           expected_semantic_hash: str = EXPECTED_T010B1_SEMANTIC_HASH) -> None:
    if artifact.get("task") != "T010B1":
        raise ValueError("input artifact is not T010B1")
    if artifact.get("semanticHash") != expected_semantic_hash:
        raise ValueError("T010B1 semantic hash differs from the reviewed source")
    if artifact.get("status") != "T010B1_OCR_CANDIDATE_READY_FOR_HUMAN_VALIDATION":
        raise ValueError("T010B1 artifact is not ready for human validation")
    expected = canonical_hash({
        "task": artifact["task"],
        "sourceT010A2SemanticHash": artifact["sourceT010A2SemanticHash"],
        "captureSetSha256": artifact["captureSet"]["captureSetSha256"],
        "modelBundleSha256": artifact["modelProvenance"]["logicalBundleSha256"],
        "rows": _semantic_signature(artifact["rows"]),
        "metrics": {"text": artifact["textCandidateMetrics"],
                    "numeric": artifact["numericCandidateMetrics"],
                    "rows": artifact["rowCandidateMetrics"]},
        "semanticRunHashes": artifact["determinism"]["semanticRunHashes"],
    })
    if expected != artifact["semanticHash"]:
        raise ValueError("T010B1 semantic payload verification failed")
    if (artifact.get("captureSet", {}).get("mappedOracleRows") != 0
            or artifact.get("captureSet", {}).get("oracleMappingStatus") != "UNRESOLVED"):
        raise ValueError("T010B1 oracle mapping is no longer unresolved")
    if any(value is not None for value in artifact.get("accuracy", {}).values()):
        raise ValueError("T010B1 accuracy must remain null")
    rows = artifact.get("rows")
    if not isinstance(rows, list) or not rows:
        raise ValueError("T010B1 artifact has no candidate rows")
    for row in rows:
        if set(row.get("fields", {})) != set(FIELDS):
            raise ValueError(f"T010B1 row lacks the six-field contract: {row.get('rowId')}")
        if any(row["fields"][field].get("value") is not None for field in FIELDS):
            raise ValueError(f"T010B1 contains a promoted value: {row.get('rowId')}")


def _postprocess_field(field_name: str, field: dict[str, Any], catalog_sets: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(field)
    raw_text = field.get("rawText")
    if field_name not in TEXT_FIELDS or raw_text is None or not normalize_text(raw_text):
        return result
    source = catalog_sets["islandCandidates"] if field_name == "island" else catalog_sets["itemCandidates"]
    match = catalog_candidate_evidence(raw_text, source)
    result["catalogCandidates"] = match["candidates"]
    result["status"] = match["status"]
    # value and verificationStatus deliberately remain the T010B1 candidate contract.
    return result


def _row_features(row: dict[str, Any], score_low: float, score_high: float) -> set[str]:
    fields = row["fields"]
    features: set[str] = set()
    text_statuses = {fields[name].get("status") for name in TEXT_FIELDS}
    if text_statuses.intersection({"EXACT_CATALOG_MATCH", "UNIQUE_SAFE_CANDIDATE"}):
        features.add("text_catalog_hit")
    if "NO_CATALOG_MATCH" in text_statuses:
        features.add("text_no_catalog_match")
    for name in NUMERIC_FIELDS:
        field = fields[name]
        candidate = field.get("ocrCandidate")
        if (name in {"reqAmount", "yield"} and field.get("status") == "OCR_CANDIDATE_UNVERIFIED"
                and isinstance(candidate, dict) and type(candidate.get("integer")) is int):
            features.add(f"{name}_strict_integer")
        if field.get("status") == "INVALID_NUMERIC_TOKEN":
            features.add("numeric_invalid_token")
        if name == "count" and field.get("readerEvidence", {}).get("geometryEligible") is True:
            features.add("count_geometry_eligible")
        if field.get("status") == "GEOMETRY_ABSTAIN":
            features.add("numeric_geometry_abstain")
    scores = [field.get("ocrScore") for field in fields.values()
              if isinstance(field.get("ocrScore"), (int, float))]
    if any(score >= score_high for score in scores):
        features.add("high_ocr_score")
    if any(score <= score_low for score in scores):
        features.add("low_ocr_score")
    return features


def _nearest_rank(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    index = max(0, min(len(ordered) - 1, int((len(ordered) * fraction + 0.999999)) - 1))
    return float(ordered[index])


def select_pilot_rows(rows: list[dict[str, Any]], capture_count: int = 16) -> dict[str, Any]:
    """Select 24 calibration rows using candidate evidence only; accepts no oracle input."""
    complete = [row for row in rows if not row.get("clipped") and set(row.get("fields", {})) == set(FIELDS)]
    if not complete:
        raise ValueError("no complete Trade rows are available for the pilot")
    scores = [field.get("ocrScore") for row in complete for field in row["fields"].values()
              if isinstance(field.get("ocrScore"), (int, float))]
    low, high = _nearest_rank(scores, 0.25), _nearest_rank(scores, 0.75)
    features = {row["rowId"]: _row_features(row, low, high) for row in complete}
    feature_totals = Counter(feature for row_features in features.values() for feature in row_features)
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    capture_order: list[str] = []
    for row in complete:
        capture_id = row["rowId"].split(":candidate-", 1)[0]
        if capture_id not in groups:
            capture_order.append(capture_id)
        groups[capture_id].append(row)
    if len(capture_order) != capture_count:
        raise ValueError(f"pilot requires complete rows from all {capture_count} captures; got {len(capture_order)}")
    if capture_count > PILOT_SIZE:
        raise ValueError("pilot size cannot cover every capture")

    selected: list[dict[str, Any]] = []
    selected_ids: set[str] = set()
    covered = Counter()

    def rarity_score(row: dict[str, Any], uncovered_only: bool) -> float:
        terms = [1.0 / max(1, feature_totals[feature])
                 for feature in sorted(features[row["rowId"]])
                 if not uncovered_only or not covered[feature]]
        return math.fsum(terms)

    # Guarantee capture coverage first; ties use original row order and rowId.
    for capture_id in capture_order:
        choice = max(groups[capture_id], key=lambda row: (rarity_score(row, False),
                                                          -int(row.get("ordinal", 0)), row["rowId"]))
        selected.append(choice)
        selected_ids.add(choice["rowId"])
        covered.update(features[choice["rowId"]])

    while len(selected) < PILOT_SIZE:
        remaining = [row for row in complete if row["rowId"] not in selected_ids]
        if not remaining:
            raise ValueError("fewer than 24 distinct complete rows are available")
        choice = max(remaining, key=lambda row: (rarity_score(row, True),
                                                  len(features[row["rowId"]]),
                                                  row["rowId"]))
        selected.append(choice)
        selected_ids.add(choice["rowId"])
        covered.update(features[choice["rowId"]])

    selected_counts = Counter(feature for row in selected for feature in features[row["rowId"]])
    available = sorted(feature_totals)
    pilot_rows = [{"rowId": row["rowId"], "captureId": row["rowId"].split(":candidate-", 1)[0],
                   "ordinal": row.get("ordinal"), "selectionFeatures": sorted(features[row["rowId"]])}
                  for row in selected]
    payload = {"pilotId": PILOT_ID, "rowIds": [item["rowId"] for item in pilot_rows],
               "scoreQuartiles": {"low": low, "high": high},
               "selectionFeatures": {feature: selected_counts[feature] for feature in available}}
    return {"pilotId": PILOT_ID, "rowCount": len(pilot_rows), "rows": pilot_rows,
            "rowIds": payload["rowIds"], "captureIds": capture_order,
            "captureCoverage": {"selectedCaptureCount": len({item["captureId"] for item in pilot_rows}),
                                "requiredCaptureCount": capture_count,
                                "allCapturesRepresented": len({item["captureId"] for item in pilot_rows}) == capture_count},
            "blindHoldout": False, "validationKind": "HUMAN_LABELED_CALIBRATION_PILOT",
            "scoreQuartiles": payload["scoreQuartiles"],
            "availableStrata": available,
            "selectedStrataCounts": payload["selectionFeatures"],
            "uncoveredAvailableStrata": [feature for feature in available if not selected_counts[feature]],
            "selectionHash": canonical_hash(payload)}


def build_postprocessed_artifact(raw_artifact: dict[str, Any], catalog: dict[str, Any],
                                 source_file_sha256: str,
                                 catalog_sha256: str | None = None,
                                 expected_semantic_hash: str = EXPECTED_T010B1_SEMANTIC_HASH) -> dict[str, Any]:
    verify_t010b1_artifact(raw_artifact, expected_semantic_hash)
    catalog_sha256 = catalog_sha256 or sha256_file(CATALOG_PATH)
    catalog_sets = load_catalog_sets(catalog)
    rows = copy.deepcopy(raw_artifact["rows"])
    semantic_fields: list[dict[str, Any]] = []
    for row in rows:
        for field_name in FIELDS:
            field = row["fields"][field_name]
            processed = _postprocess_field(field_name, field, catalog_sets)
            # Guard against changing any raw OCR evidence during postprocessing.
            for immutable in ("rawText", "normalizedText", "ocrScore", "cropHash"):
                if processed.get(immutable) != field.get(immutable):
                    raise RuntimeError(f"T010B2 changed frozen OCR evidence: {row['rowId']} {field_name} {immutable}")
            if processed.get("value") is not None or processed.get("verificationStatus") != field.get("verificationStatus"):
                raise RuntimeError(f"T010B2 changed verification/value state: {row['rowId']} {field_name}")
            row["fields"][field_name] = processed
        semantic_fields.append({"rowId": row["rowId"],
                                "fields": {name: {"status": row["fields"][name]["status"],
                                                  "catalogCandidates": row["fields"][name]["catalogCandidates"]}
                                           for name in FIELDS}})
    pilot = select_pilot_rows(rows, raw_artifact["captureSet"]["captureCount"])
    postprocessing_hash = canonical_hash({
        "sourceT010B1SemanticHash": raw_artifact["semanticHash"],
        "sourceT010B1ArtifactSha256": source_file_sha256,
        "catalogSha256": catalog_sha256,
        "islandSet": catalog_sets["islandSet"], "itemSet": catalog_sets["itemSet"],
        "fields": semantic_fields, "pilotSelectionHash": pilot["selectionHash"],
    })
    return {
        "version": 1, "task": TASK,
        "sourceT010B1SemanticHash": raw_artifact["semanticHash"],
        "sourceT010B1ArtifactSha256": source_file_sha256,
        "sourceT010A2SemanticHash": raw_artifact["sourceT010A2SemanticHash"],
        "captureCount": raw_artifact["captureSet"]["captureCount"],
        "oracleMappingStatus": "UNRESOLVED", "mappedOracleRows": 0,
        "fieldAccuracy": None, "rowExactMatch": None, "captureExactMatch": None,
        "fullListExact": None,
        "catalogSource": {"source": "trade-catalog.json",
                          "catalogSha256": catalog_sha256,
                          "islandCandidates": catalog_sets["islandCandidates"],
                          "itemCandidates": catalog_sets["itemCandidates"],
                          "islandSet": catalog_sets["islandSet"], "itemSet": catalog_sets["itemSet"],
                          "islandSupplementSource": "islands only; t6/t7 aliases not added"},
        "pilot": pilot, "rows": rows,
        "approval": {"requiresSolReview": True, "productionApproved": False,
                     "engineSelected": False, "HIGH": False, "importerIntegration": False},
        "postprocessingHash": postprocessing_hash,
    }


def _candidate_value(field_name: str, field: dict[str, Any]) -> str | int | None:
    if field_name in NUMERIC_FIELDS:
        value = field.get("ocrCandidate")
        candidate = value.get("integer") if isinstance(value, dict) else None
        return candidate if type(candidate) is int else None
    return field.get("normalizedText") if isinstance(field.get("normalizedText"), str) and field.get("normalizedText").strip() else None


def _validate_human_value(field_name: str, value: Any) -> str | int:
    if field_name in NUMERIC_FIELDS:
        if not isinstance(value, str) or re.fullmatch(r"[0-9]+", value) is None:
            raise ValueError(f"{field_name} requires an ASCII full-token integer")
        number = int(value)
        if (field_name == "count" and number < 0) or (field_name != "count" and number < 1):
            raise ValueError(f"{field_name} is outside its allowed numeric domain")
        return number
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} requires a non-empty text value")
    if len(value) > 500:
        raise ValueError(f"{field_name} exceeds the 500-character limit")
    return value.strip()


def _field_truth_equal(field_name: str, left: Any, right: Any) -> bool:
    if field_name in NUMERIC_FIELDS:
        return type(left) is int and type(right) is int and left == right
    return re.sub(r"\s+", "", normalize_text(str(left)) or "") == re.sub(r"\s+", "", normalize_text(str(right)) or "")


def _normalized_text_exact(left: Any, right: Any) -> bool:
    return isinstance(left, str) and isinstance(right, str) and normalize_text(left) == normalize_text(right)


def _label_key(label: dict[str, Any]) -> tuple[str, str, str]:
    return label["pilotId"], label["rowId"], label["field"]


def _atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class ValidationStore:
    def __init__(self, artifact: dict[str, Any], data_dir: Path):
        self.artifact = artifact
        self.pilot = artifact["pilot"]
        self.rows = {row["rowId"]: row for row in artifact["rows"]}
        self.pilot_rows = {item["rowId"]: item for item in self.pilot["rows"]}
        self.data_dir = Path(data_dir)
        self.labels_path = self.data_dir / "labels.jsonl"
        self.summary_path = self.data_dir / "summary.json"
        self.progress_path = self.data_dir / "progress.json"
        self._lock = threading.RLock()
        self.labels = self._load_labels()
        self.current_index = self._load_progress()
        self.summary = summarize_labels(artifact, self.labels)
        _atomic_write(self.summary_path, (json.dumps(self.summary, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))

    def _load_progress(self) -> int:
        if not self.progress_path.exists():
            return 0
        try:
            progress = _load_json(self.progress_path)
            index = progress.get("currentIndex")
        except (OSError, AttributeError, json.JSONDecodeError) as error:
            raise ValueError("invalid local progress.json") from error
        if progress.get("pilotId") != self.pilot["pilotId"] or type(index) is not int or not 0 <= index < PILOT_SIZE:
            raise ValueError("progress.json is outside the selected pilot")
        return index

    def set_current_index(self, index: Any) -> int:
        if type(index) is not int or not 0 <= index < PILOT_SIZE:
            raise ValueError("currentIndex is outside the 24-row pilot")
        with self._lock:
            _atomic_write(self.progress_path, _json_bytes({"pilotId": self.pilot["pilotId"], "currentIndex": index}))
            self.current_index = index
            return index

    def _load_labels(self) -> dict[tuple[str, str, str], dict[str, Any]]:
        labels: dict[tuple[str, str, str], dict[str, Any]] = {}
        if not self.labels_path.exists():
            return labels
        for line_no, line in enumerate(self.labels_path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                label = json.loads(line)
                key = _label_key(label)
            except (json.JSONDecodeError, KeyError, TypeError) as error:
                raise ValueError(f"invalid local labels.jsonl line {line_no}") from error
            if (label.get("pilotId") != self.pilot["pilotId"] or label.get("rowId") not in self.pilot_rows
                    or label.get("field") not in FIELDS or label.get("action") not in LABEL_ACTIONS):
                raise ValueError(f"labels.jsonl contains an out-of-pilot label at line {line_no}")
            previous = labels.get(key)
            if previous is None or int(label.get("labelVersion", 0)) > int(previous.get("labelVersion", 0)):
                labels[key] = label
        return labels

    def _row_status(self, row_id: str) -> str:
        actions = [self.labels.get((self.pilot["pilotId"], row_id, field), {}).get("action") for field in FIELDS]
        return "HUMAN_COMPLETE" if all(action in LABEL_ACTIONS for action in actions) else "HUMAN_PARTIAL"

    def state(self) -> dict[str, Any]:
        with self._lock:
            rows = []
            for selection in self.pilot["rows"]:
                row_id = selection["rowId"]
                row = self.rows[row_id]
                rows.append({"selection": selection, "row": row,
                             "rowLabelStatus": self._row_status(row_id),
                             "labels": {field: self.labels.get((self.pilot["pilotId"], row_id, field))
                                        for field in FIELDS}})
            complete = sum(item["rowLabelStatus"] == "HUMAN_COMPLETE" for item in rows)
            return {"task": TASK, "pilotId": self.pilot["pilotId"], "rowCount": PILOT_SIZE,
                    "rows": rows, "completedRows": complete, "pilotComplete": complete == PILOT_SIZE,
                    "currentIndex": self.current_index,
                    "sourceT010B1SemanticHash": self.artifact["sourceT010B1SemanticHash"],
                    "postprocessingHash": self.artifact["postprocessingHash"],
                    "blindHoldout": False, "validationKind": self.pilot["validationKind"]}

    def save_label(self, row_id: str, field_name: str, action: str,
                   supplied_value: Any = None) -> dict[str, Any]:
        if row_id not in self.pilot_rows or field_name not in FIELDS:
            raise ValueError("row or field is outside the selected pilot")
        if action not in LABEL_ACTIONS:
            raise ValueError("action must be CONFIRM, CORRECT, UNREADABLE, or UNVERIFIED")
        field = self.rows[row_id]["fields"][field_name]
        candidate = _candidate_value(field_name, field)
        if action == "CONFIRM":
            if candidate is None:
                raise ValueError("there is no usable OCR candidate to confirm")
            human_value = candidate
        elif action == "CORRECT":
            human_value = _validate_human_value(field_name, supplied_value)
        else:
            if supplied_value not in (None, ""):
                raise ValueError("UNREADABLE and UNVERIFIED labels cannot contain a value")
            human_value = None
        corrected = action == "CORRECT" and not _field_truth_equal(field_name, candidate, human_value)
        key = (self.pilot["pilotId"], row_id, field_name)
        with self._lock:
            previous = self.labels.get(key)
            if (previous and previous.get("action") == action and previous.get("humanValue") == human_value
                    and previous.get("corrected") == corrected):
                return previous
            label = {
                "pilotId": self.pilot["pilotId"], "rowId": row_id,
                "captureId": self.pilot_rows[row_id]["captureId"],
                "rowOrdinal": self.pilot_rows[row_id]["ordinal"], "field": field_name,
                "action": action, "originalOcr": field.get("rawText"),
                "humanValue": human_value, "corrected": corrected,
                "labelVersion": int(previous.get("labelVersion", 0)) + 1 if previous else 1,
                "sourceCropHash": field.get("cropHash"),
                "sourceT010B1SemanticHash": self.artifact["sourceT010B1SemanticHash"],
                "savedAt": _iso_now(),
            }
            updated = dict(self.labels)
            updated[key] = label
            serialized = b"".join((json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
                                   for _, value in sorted(updated.items()))
            _atomic_write(self.labels_path, serialized)
            self.labels = updated
            self.summary = summarize_labels(self.artifact, self.labels)
            _atomic_write(self.summary_path, (json.dumps(self.summary, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
            return label


def summarize_labels(artifact: dict[str, Any], labels: dict[tuple[str, str, str], dict[str, Any]]) -> dict[str, Any]:
    rows = {row["rowId"]: row for row in artifact["rows"]}
    pilot = artifact["pilot"]
    text_candidates = artifact["catalogSource"]["islandCandidates"]
    item_candidates = artifact["catalogSource"]["itemCandidates"]
    verified_actions = {"CONFIRM", "CORRECT"}
    fields_summary: dict[str, Any] = {}
    verified_labels: dict[tuple[str, str], dict[str, Any]] = {}
    for field_name in FIELDS:
        field_labels = [label for key, label in labels.items() if key[0] == pilot["pilotId"] and key[2] == field_name]
        verified = [label for label in field_labels if label.get("action") in verified_actions]
        correct_ocr = 0
        raw_exact = 0
        normalized_exact = 0
        candidate_contains_truth = 0
        exact_candidate_equals_truth = 0
        unique_candidate_equals_truth = 0
        ambiguous_candidate_contains_truth = 0
        no_match_truth_outside_catalog = 0
        for label in verified:
            row = rows[label["rowId"]]
            source = row["fields"][field_name]
            truth = label.get("humanValue")
            if field_name in NUMERIC_FIELDS:
                raw_candidate = _candidate_value(field_name, source)
                is_exact = type(raw_candidate) is int and raw_candidate == truth
                raw_exact += int(source.get("rawText") == str(truth))
                normalized_exact += int(is_exact)
            else:
                raw = source.get("rawText")
                normalized = source.get("normalizedText")
                norm_match = _normalized_text_exact(normalized, truth)
                raw_exact += int(isinstance(raw, str) and raw == truth)
                normalized_exact += int(norm_match)
                is_exact = norm_match
            correct_ocr += int(is_exact)
            verified_labels[(label["rowId"], field_name)] = label
            if field_name in TEXT_FIELDS:
                candidate_set = text_candidates if field_name == "island" else item_candidates
                truth_in_catalog = any(_field_truth_equal(field_name, truth, value) for value in candidate_set)
                candidates = source.get("catalogCandidates", [])
                candidate_hit = any(_field_truth_equal(field_name, truth, item.get("value"))
                                    for item in candidates if isinstance(item, dict))
                candidate_contains_truth += int(candidate_hit)
                exact_candidate_equals_truth += int(source.get("status") == "EXACT_CATALOG_MATCH" and candidate_hit)
                unique_candidate_equals_truth += int(source.get("status") == "UNIQUE_SAFE_CANDIDATE" and candidate_hit)
                ambiguous_candidate_contains_truth += int(source.get("status") == "AMBIGUOUS_CATALOG_MATCH" and candidate_hit)
                no_match_truth_outside_catalog += int(source.get("status") == "NO_CATALOG_MATCH" and not truth_in_catalog)
        unreadable = sum(label.get("action") == "UNREADABLE" for label in field_labels)
        unverified = sum(label.get("action") == "UNVERIFIED" for label in field_labels)
        fields_summary[field_name] = {
            "humanVerifiedFields": len(verified), "ocrExact": correct_ocr,
            "ocrExactRate": correct_ocr / len(verified) if verified else None,
            "rawOcrExact": raw_exact, "normalizedOcrExact": normalized_exact,
            "correctedFields": sum(bool(label.get("corrected")) for label in verified),
            "unreadableFields": unreadable, "unverifiedFields": unverified,
            "catalogCandidateSetContainsTruth": candidate_contains_truth if field_name in TEXT_FIELDS else None,
            "exactCatalogCandidateEqualsTruth": exact_candidate_equals_truth if field_name in TEXT_FIELDS else None,
            "uniqueSafeCandidateEqualsTruth": unique_candidate_equals_truth if field_name in TEXT_FIELDS else None,
            "ambiguousCandidateContainsTruth": ambiguous_candidate_contains_truth if field_name in TEXT_FIELDS else None,
            "noCatalogMatchTruthOutsideCatalog": no_match_truth_outside_catalog if field_name in TEXT_FIELDS else None,
        }

    numeric_summary: dict[str, Any] = {}
    for field_name in NUMERIC_FIELDS:
        correct = wrong_candidate = invalid_readable = geometry_abstain_readable = empty_or_error = 0
        for (pilot_id, row_id, label_field), label in labels.items():
            if pilot_id != pilot["pilotId"] or label_field != field_name or label.get("action") not in verified_actions:
                continue
            source = rows[row_id]["fields"][field_name]
            candidate = _candidate_value(field_name, source)
            if type(candidate) is int:
                if candidate == label.get("humanValue"):
                    correct += 1
                else:
                    wrong_candidate += 1
            elif source.get("status") == "INVALID_NUMERIC_TOKEN":
                invalid_readable += 1
            elif source.get("status") == "GEOMETRY_ABSTAIN":
                geometry_abstain_readable += 1
            else:
                empty_or_error += 1
        numeric_summary[field_name] = {
            "humanVerifiedFields": fields_summary[field_name]["humanVerifiedFields"],
            "numericCorrect": correct,
            "numericWrong": wrong_candidate + invalid_readable,
            "strictCandidateWrong": wrong_candidate,
            "invalidTokenReadable": invalid_readable,
            "numericAbstain": geometry_abstain_readable + empty_or_error,
            "geometryAbstainReadable": geometry_abstain_readable,
            "emptyOrErrorReadable": empty_or_error,
            "ocrExactRate": correct / fields_summary[field_name]["humanVerifiedFields"]
            if fields_summary[field_name]["humanVerifiedFields"] else None,
        }

    row_label_status: dict[str, str] = {}
    complete_rows = 0
    truth_complete_rows = 0
    six_field_exact = 0
    for row_id in pilot["rowIds"]:
        actions = [labels.get((pilot["pilotId"], row_id, field), {}).get("action") for field in FIELDS]
        complete = all(action in LABEL_ACTIONS for action in actions)
        row_label_status[row_id] = "HUMAN_COMPLETE" if complete else "HUMAN_PARTIAL"
        if complete:
            complete_rows += 1
        if all((row_id, field) in verified_labels for field in FIELDS):
            truth_complete_rows += 1
            six_field_exact += int(all(
                (_field_truth_equal(field, _candidate_value(field, rows[row_id]["fields"][field]),
                                    verified_labels[(row_id, field)]["humanValue"])
                 if field in NUMERIC_FIELDS else
                 _normalized_text_exact(_candidate_value(field, rows[row_id]["fields"][field]),
                                        verified_labels[(row_id, field)]["humanValue"]))
                for field in FIELDS))

    verified_total = sum(item["humanVerifiedFields"] for item in fields_summary.values())
    exact_total = sum(item["ocrExact"] for item in fields_summary.values())
    unreadable_total = sum(item["unreadableFields"] for item in fields_summary.values())
    unverified_total = sum(item["unverifiedFields"] for item in fields_summary.values())
    capture_ids = [item["captureId"] for item in pilot["rows"]]
    capture_counts = Counter(capture_ids)
    return {
        "version": 1, "task": TASK, "pilotId": pilot["pilotId"],
        "sourceT010B1SemanticHash": artifact["sourceT010B1SemanticHash"],
        "sourceT010B1ArtifactSha256": artifact["sourceT010B1ArtifactSha256"],
        "postprocessingHash": artifact["postprocessingHash"],
        "pilotSelectionHash": pilot["selectionHash"], "selectedRowIds": pilot["rowIds"],
        "captureCoverage": {"selectedCaptureCount": len(capture_counts), "requiredCaptureCount": len(pilot["captureIds"]),
                            "allCapturesRepresented": len(capture_counts) == len(pilot["captureIds"]),
                            "rowsPerCapture": dict(sorted(capture_counts.items()))},
        "humanCompleteRows": complete_rows,
        "humanPartialRows": PILOT_SIZE - complete_rows,
        "fieldMetrics": fields_summary,
        "humanVerifiedFields": verified_total,
        "fieldAccuracy": exact_total / verified_total if verified_total else None,
        "fieldCorrectOcrCount": exact_total, "correctedFields": sum(item["correctedFields"] for item in fields_summary.values()),
        "unreadableFields": unreadable_total, "unverifiedFields": unverified_total,
        "numericEvaluation": numeric_summary,
        "sixFieldExact": {"denominatorHumanTruthRows": truth_complete_rows,
                           "exactHumanLabeledRows": six_field_exact,
                           "rate": six_field_exact / truth_complete_rows if truth_complete_rows else None,
                           "humanPartialRowsExcluded": sum(value == "HUMAN_PARTIAL" for value in row_label_status.values()),
                           "completeRowsWithoutSixHumanValuesExcluded": complete_rows - truth_complete_rows},
        "fullListExact": None, "blindHoldout": False,
        "validationKind": "HUMAN_LABELED_CALIBRATION_PILOT",
        "oracleRowsUsed": False,
        "requiresSolReview": True,
        "productionApproved": False, "engineSelected": False, "HIGH": False,
    }


def load_capture_image_map(manifest_path: Path, expected_capture_set_hash: str,
                           expected_capture_count: int) -> dict[str, Path]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    captures = manifest.get("trade", {}).get("captures", [])
    capture_set = [{"captureId": item["captureId"], "imageHash": item["imageHash"]} for item in captures]
    if len(captures) != expected_capture_count or canonical_hash(capture_set) != expected_capture_set_hash:
        raise ValueError("archive capture set does not match the frozen T010B1 evidence")
    result = {}
    for item in captures:
        image_path = (manifest_path.parent / item["imagePath"]).resolve()
        if not image_path.is_file() or sha256_file(image_path) != item["imageHash"]:
            raise ValueError(f"archive image hash mismatch: {item.get('captureId')}")
        result[item["captureId"]] = image_path
    return result


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def create_server(store: ValidationStore, capture_images: dict[str, Path], host: str = "127.0.0.1") -> ThreadingHTTPServer:
    if host != "127.0.0.1":
        raise ValueError("T010B2 server may bind only to 127.0.0.1")

    class Handler(BaseHTTPRequestHandler):
        server_version = "TradeOCRValidation/1"

        def log_message(self, fmt: str, *args: Any) -> None:
            return

        def _send(self, code: int, content_type: str, body: bytes) -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path == "/":
                self._send(200, "text/html; charset=utf-8", HTML_PAGE.encode("utf-8"))
                return
            if parsed.path == "/api/state":
                self._send(200, "application/json; charset=utf-8", _json_bytes(store.state()))
                return
            if parsed.path == "/api/summary":
                self._send(200, "application/json; charset=utf-8", _json_bytes(store.summary))
                return
            if parsed.path == "/api/progress":
                self._send(200, "application/json; charset=utf-8", _json_bytes({"currentIndex": store.current_index}))
                return
            if parsed.path == "/api/crop":
                query = parse_qs(parsed.query)
                row_id = query.get("rowId", [""])[0]
                kind = query.get("kind", [""])[0]
                field_name = query.get("field", [""])[0]
                if row_id not in store.pilot_rows or kind not in {"row", "field"}:
                    self._send(404, "application/json; charset=utf-8", _json_bytes({"error": "crop not found"}))
                    return
                try:
                    content = render_crop_png(store.rows[row_id], capture_images, kind, field_name)
                except (KeyError, ValueError, OSError) as error:
                    self._send(404, "application/json; charset=utf-8", _json_bytes({"error": str(error)}))
                    return
                self._send(200, "image/png", content)
                return
            self._send(404, "application/json; charset=utf-8", _json_bytes({"error": "not found"}))

        def do_POST(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path not in {"/api/label", "/api/progress"}:
                self._send(404, "application/json; charset=utf-8", _json_bytes({"error": "not found"}))
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > 8192:
                    raise ValueError("request body size is invalid")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                if path == "/api/progress":
                    index = store.set_current_index(payload.get("currentIndex"))
                    self._send(200, "application/json; charset=utf-8", _json_bytes({"currentIndex": index}))
                    return
                label = store.save_label(payload.get("rowId"), payload.get("field"),
                                         payload.get("action"), payload.get("humanValue"))
            except (UnicodeDecodeError, json.JSONDecodeError, AttributeError, ValueError) as error:
                self._send(400, "application/json; charset=utf-8", _json_bytes({"error": str(error)}))
                return
            self._send(200, "application/json; charset=utf-8", _json_bytes({"label": label,
                                                                             "summary": store.summary,
                                                                             "state": store.state()}))

    return ThreadingHTTPServer((host, 0), Handler)


def render_crop_png(row: dict[str, Any], capture_images: dict[str, Path],
                    kind: str, field_name: str = "") -> bytes:
    from io import BytesIO
    from PIL import Image

    capture_id = row["rowId"].split(":candidate-", 1)[0]
    image_path = capture_images.get(capture_id)
    if image_path is None:
        raise ValueError("capture source is unavailable")
    box = row["box"]
    with Image.open(image_path) as source:
        base = source.convert("RGB").crop((box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]))
    if kind == "field":
        if field_name not in FIELDS:
            raise ValueError("field is outside the six-field contract")
        evidence = row["fields"][field_name].get("readerEvidence", {})
        lane = evidence.get("lane")
        if not isinstance(lane, dict):
            raise ValueError("field lane crop is unavailable")
        base = base.crop((lane["x"], lane["y"], lane["x"] + lane["width"], lane["y"] + lane["height"]))
        token_box = evidence.get("tokenBox") if field_name in NUMERIC_FIELDS else None
        if evidence.get("geometryEligible") is True and isinstance(token_box, dict):
            base = base.crop((token_box["x"], token_box["y"], token_box["x"] + token_box["width"], token_box["y"] + token_box["height"]))
    output = BytesIO()
    base.save(output, format="PNG")
    return output.getvalue()


HTML_PAGE = r"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trade OCR 검수</title><style>
*{box-sizing:border-box}body{font-family:system-ui,'Malgun Gothic',sans-serif;margin:0;background:#f4f6f8;color:#1d2733}header{background:#17324d;color:white;padding:18px 24px}header h1{margin:0 0 5px;font-size:22px}header p{margin:0;color:#e2edf7}.wrap{max-width:1200px;margin:auto;padding:18px}.toolbar,.panel,.field{background:white;border:1px solid #d4dce4;border-radius:10px;padding:14px;margin-bottom:12px}.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.toolbar .spacer{flex:1}button{border:1px solid #b8c4d0;border-radius:7px;background:#fff;padding:8px 12px;cursor:pointer;font:inherit}button:hover{background:#eaf1f7}button:disabled{opacity:.45;cursor:default}.status{font-weight:700;color:#17613b}.error{color:#a22626;min-height:1.4em}.layout{display:grid;grid-template-columns:minmax(250px,1fr) minmax(360px,1.5fr);gap:14px}.row-image,.field-image{max-width:100%;height:auto;border:1px solid #ccd4dc;background:#eef1f4;image-rendering:auto}.row-image{width:100%;max-height:240px;object-fit:contain}.fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}.field h3{margin:0 0 8px}.field img{max-height:86px;max-width:100%;object-fit:contain}.meta{font-size:13px;color:#47596b;overflow-wrap:anywhere}.raw{font-weight:650;margin:5px 0}.candidate{color:#435a70;margin:4px 0}.field input{width:100%;padding:8px;border:1px solid #aebbc7;border-radius:6px;margin:6px 0}.actions{display:flex;gap:5px;flex-wrap:wrap}.actions button{font-size:13px;padding:6px 8px}.label-state{color:#17613b;font-size:13px;font-weight:600}.complete{background:#e6f5ec;border-color:#66a47b;padding:12px;border-radius:8px}details{font-size:13px;color:#425365}pre{white-space:pre-wrap;word-break:break-all}@media(max-width:800px){.layout{grid-template-columns:1fr}.fields{grid-template-columns:1fr}}
</style></head><body><header><h1>Trade OCR 후보 검수</h1><p>사진을 보고 각 항목이 맞으면 확인, 틀리면 수정하세요.</p></header>
<main class="wrap"><div class="toolbar"><button id="previous">이전</button><button id="next">다음</button><strong id="position">현재 진행 1 / 24</strong><span class="spacer"></span><span id="complete-count">완료 0 / 24</span><span id="saved" class="status" aria-live="polite"></span></div>
<div id="pilot-complete" class="complete" hidden>검증 완료 — 24개 pilot row의 모든 field action이 저장되었습니다. 실제 label 결과는 요약 파일에서 확인할 수 있습니다.</div><div id="error" class="error" role="alert"></div>
<section class="layout"><div class="panel"><h2>원본 row</h2><div id="row-meta" class="meta"></div><img id="row-crop" class="row-image" alt="선택한 row crop"><details><summary>진단 정보</summary><pre id="diagnostics"></pre></details></div><div id="fields" class="fields"></div></section></main>
<script>
const FIELDS=['island','fromItem','reqAmount','toItem','count','yield'];const LABELS={island:'섬',fromItem:'교환 전 물품',reqAmount:'요구 수량',toItem:'교환 후 물품',count:'남은 교환 횟수',yield:'결과 수량'};let state=null,index=0;
const $=s=>document.querySelector(s);const esc=s=>encodeURIComponent(s);const text=(parent,tag,value,cls='')=>{const e=document.createElement(tag);e.textContent=value??'';if(cls)e.className=cls;parent.append(e);return e};
async function load(){const r=await fetch('/api/state');if(!r.ok)throw new Error('검수 상태를 불러오지 못했습니다.');state=await r.json();index=Math.max(0,Math.min(state.currentIndex,state.rows.length-1));render()}
function button(label,action,rowId,field,value=null){const b=document.createElement('button');b.textContent=label;b.dataset.action=action;b.dataset.field=field;b.addEventListener('click',()=>save(rowId,field,action,value));return b}
function render(){const item=state.rows[index],row=item.row;$('#position').textContent=`현재 진행 ${index+1} / 24`;$('#complete-count').textContent=`완료 ${state.completedRows} / 24`;$('#previous').disabled=index===0;$('#next').disabled=index===state.rows.length-1;$('#pilot-complete').hidden=!state.pilotComplete;$('#row-meta').textContent=`${item.selection.captureId} · row ${item.selection.ordinal} · ${item.rowLabelStatus}`;$('#row-crop').src=`/api/crop?rowId=${esc(row.rowId)}&kind=row`;$('#diagnostics').textContent=`pilotId: ${state.pilotId}\nsource T010B1 semantic hash: ${state.sourceT010B1SemanticHash}\npostprocessing hash: ${state.postprocessingHash}\nblindHoldout: ${state.blindHoldout}\nvalidationKind: ${state.validationKind}`;const root=$('#fields');root.replaceChildren();for(const fieldName of FIELDS){const data=row.fields[fieldName],label=item.labels[fieldName];const card=document.createElement('article');card.className='field';card.dataset.field=fieldName;text(card,'h3',LABELS[fieldName]);const img=document.createElement('img');img.className='field-image';img.alt=LABELS[fieldName]+' crop';img.src=`/api/crop?rowId=${esc(row.rowId)}&kind=field&field=${fieldName}`;card.append(img);text(card,'div',`OCR 원문: ${data.rawText===null?'(없음)':data.rawText}`,'raw');text(card,'div',`score: ${data.ocrScore===null?'—':Number(data.ocrScore).toFixed(4)} · 상태: ${data.status}`,'meta');if(data.catalogCandidates?.length)text(card,'div','catalog 후보: '+data.catalogCandidates.map(x=>x.value).join(' / '),'candidate');else if(['island','fromItem','toItem'].includes(fieldName))text(card,'div','catalog 후보 없음','candidate');const candidate=fieldName==='reqAmount'||fieldName==='count'||fieldName==='yield'?(data.ocrCandidate?.integer??''):(data.normalizedText??'');text(card,'div',`현재 후보: ${candidate===''?'(없음)':candidate}`,'meta');const input=document.createElement('input');input.dataset.value=fieldName;input.value=label?.humanValue??candidate??'';input.setAttribute('aria-label',LABELS[fieldName]+' 수정값');if(['reqAmount','count','yield'].includes(fieldName))input.inputMode='numeric';card.append(input);const actions=document.createElement('div');actions.className='actions';actions.append(button('OCR 맞음','CONFIRM',row.rowId,fieldName));actions.append(button('수정 저장','CORRECT',row.rowId,fieldName,input));actions.append(button('읽을 수 없음','UNREADABLE',row.rowId,fieldName));actions.append(button('없음/판정 불가','UNVERIFIED',row.rowId,fieldName));card.append(actions);if(label)text(card,'div',`저장됨 · ${label.action} · version ${label.labelVersion}`,'label-state');root.append(card)} }
async function save(rowId,field,action,value){$('#error').textContent='';$('#saved').textContent='저장 중…';try{const humanValue=action==='CORRECT'?value.value:null;const r=await fetch('/api/label',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rowId,field,action,humanValue})});const payload=await r.json();if(!r.ok)throw new Error(payload.error||'저장하지 못했습니다.');state=payload.state;$('#saved').textContent='저장됨';render()}catch(e){$('#saved').textContent='';$('#error').textContent=e.message}}
async function navigate(next){index=Math.max(0,Math.min(state.rows.length-1,next));render();try{const r=await fetch('/api/progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentIndex:index})});if(!r.ok)throw new Error('진행 위치를 저장하지 못했습니다.')}catch(e){$('#error').textContent=e.message}}
$('#previous').onclick=()=>navigate(index-1);$('#next').onclick=()=>navigate(index+1);load().catch(e=>$('#error').textContent=e.message);
</script></body></html>"""


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def start_server(artifact_path: Path = ARTIFACT_PATH, catalog_path: Path = CATALOG_PATH,
                manifest_path: Path = MANIFEST_PATH, data_dir: Path = DATA_DIR,
                open_browser: bool = True) -> None:
    source_bytes = artifact_path.read_bytes()
    raw_artifact = json.loads(source_bytes.decode("utf-8"))
    verify_t010b1_artifact(raw_artifact)
    catalog = _load_json(catalog_path)
    postprocessed = build_postprocessed_artifact(raw_artifact, catalog, hashlib.sha256(source_bytes).hexdigest(),
                                                  sha256_file(catalog_path))
    data_dir.mkdir(parents=True, exist_ok=True)
    _atomic_write(data_dir / "postprocessed.json", _json_bytes(postprocessed))
    _atomic_write(data_dir / "pilot.json", _json_bytes(postprocessed["pilot"]))
    capture_images = load_capture_image_map(manifest_path, raw_artifact["captureSet"]["captureSetSha256"],
                                            raw_artifact["captureSet"]["captureCount"])
    store = ValidationStore(postprocessed, data_dir)
    server = create_server(store, capture_images)
    host, port = server.server_address
    url = f"http://{host}:{port}/"
    print(f"Trade OCR 검수 화면: {url}", flush=True)
    print(f"Local-only server bound to {host}; close this window to stop it.", flush=True)
    if open_browser:
        try:
            if not webbrowser.open(url, new=2):
                print(f"브라우저가 자동으로 열리지 않으면 이 주소를 여세요: {url}", flush=True)
        except Exception:
            print(f"브라우저가 자동으로 열리지 않으면 이 주소를 여세요: {url}", flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, default=ARTIFACT_PATH)
    parser.add_argument("--catalog", type=Path, default=CATALOG_PATH)
    parser.add_argument("--manifest", type=Path, default=MANIFEST_PATH)
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    try:
        start_server(args.artifact, args.catalog, args.manifest, args.data_dir, not args.no_browser)
    except (OSError, ValueError, KeyError) as error:
        print(f"T010B2 검수 서버를 시작하지 못했습니다: {error}", file=os.sys.stderr, flush=True)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
