"""Strict request contracts for the isolated recognition V2 API."""
from __future__ import annotations

import json
import math
import re
import uuid
from datetime import datetime, timezone
from io import BytesIO
from typing import Any

from PIL import Image, UnidentifiedImageError


MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_METADATA_BYTES = 64 * 1024
MAX_IMAGE_PIXELS = 32_000_000
MAX_ID_LENGTH = 128
MAX_SAFE_INTEGER = 9_007_199_254_740_991
TASK_TYPES = {"warehouse", "trade"}
SOURCE_TYPES = {"file", "clipboard", "browser-stream"}
MAX_TRADE_OBSERVATION_BYTES = 8 * 1024 * 1024
MAX_TRADE_CROP_BYTES = 512 * 1024
TRADE_FIELDS = ("island", "fromItem", "reqAmount", "toItem", "count", "yield")
UNSUPPORTED_FLAGS = {
    "warehouseV2", "tradeOCR", "autoApply", "nativeCapture", "remoteFallback", "debugCapture",
}


class RecognitionContractError(ValueError):
    def __init__(self, code: str, message: str, status: int = 422, *, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.details = details


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_constant(_value: str) -> None:
    raise ValueError("non-finite JSON number")


def parse_json(raw: str | bytes, *, max_bytes: int, label: str, reject_negative_zero: bool = False) -> dict[str, Any]:
    encoded = raw.encode("utf-8") if isinstance(raw, str) else raw
    if len(encoded) > max_bytes:
        raise RecognitionContractError("metadata_too_large", f"{label} exceeds the allowed size.", 413)
    try:
        def parse_integer(token: str):
            if reject_negative_zero and token == "-0": raise ValueError("negative zero is not allowed")
            return int(token)
        value = json.loads(encoded.decode("utf-8"), object_pairs_hook=_object, parse_constant=_reject_constant, parse_int=parse_integer)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise RecognitionContractError("invalid_json", f"{label} must be valid UTF-8 JSON.", 400) from None
    if not isinstance(value, dict):
        raise RecognitionContractError("invalid_contract", f"{label} must be a JSON object.")
    return value


def _trade_fail(message: str = "The trade review observation contract is invalid.") -> None:
    raise RecognitionContractError("invalid_contract", message, 422)


def _same_trade_json(left: Any, right: Any) -> bool:
    try: return json.dumps(left, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False) == json.dumps(right, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError): return False


def _validate_reconciled_trade_projection(proj: dict[str, Any], captures: list[dict[str, Any]], evidence_by_id: dict[str, Any], completion_rows: list[Any]) -> dict[str, int]:
    """Validate R007-C1 source accounting without treating logical rows as sources."""
    import re
    keys = {"schemaVersion", "phase", "policyVersion", "captureOrder", "sourceRows", "overlaps", "groups", "sourceToLogical", "sourceProjectionEvidence", "findings"}
    rec = proj.get("reconciliation")
    if type(proj.get("schemaVersion")) is not int or proj["schemaVersion"] != 2 or not isinstance(rec, dict) or set(rec) != keys:
        _trade_fail("Unsupported reconciled projection schema.")
    if type(rec.get("schemaVersion")) is not int or rec["schemaVersion"] != 1 or rec.get("phase") != "FINAL" or rec.get("policyVersion") != "trade-batch-reconciliation-v1":
        _trade_fail("Unsupported reconciliation version or policy.")
    captures_ordered = [capture["captureId"] for capture in captures]
    if not isinstance(rec.get("captureOrder"), list) or len(rec["captureOrder"]) != len(captures): _trade_fail()
    image_hashes = {}
    for index, (entry, capture) in enumerate(zip(rec["captureOrder"], captures, strict=True), 1):
        if not isinstance(entry, dict) or set(entry) != {"captureId", "captureOrdinal", "imageHash"}: _trade_fail()
        evidence = evidence_by_id[capture["captureId"]]
        if entry.get("captureId") != capture["captureId"] or type(entry.get("captureOrdinal")) is not int or entry["captureOrdinal"] != index or entry.get("imageHash") != evidence.get("imageHash"):
            _trade_fail("Reconciliation capture order does not match recognition evidence.")
        image_hashes[capture["captureId"]] = entry["imageHash"]

    ledger = rec.get("sourceRows")
    if not isinstance(ledger, list) or len(ledger) > 1000: _trade_fail()
    ledger_keys = {"sourceRowId", "captureId", "ordinal", "projectionSourceIndex", "sourceRefs"}
    optional = {"draftId", "rowBox", "rowCropHash"}
    sources = {}
    per_capture = {cid: [] for cid in captures_ordered}
    seen_positions, indices = set(), []
    for item in ledger:
        if not isinstance(item, dict) or not ledger_keys <= set(item) or set(item) - ledger_keys - optional: _trade_fail()
        sid, cid, ordinal, index = (item.get(key) for key in ("sourceRowId", "captureId", "ordinal", "projectionSourceIndex"))
        if not isinstance(sid, str) or not sid or len(sid.encode("utf-8")) > 256 or sid in sources: _trade_fail("Duplicate or invalid source row ID.")
        if cid not in per_capture or type(ordinal) is not int or not 1 <= ordinal <= 9_007_199_254_740_991 or (cid, ordinal) in seen_positions: _trade_fail("Invalid source capture/ordinal.")
        if type(index) is not int or not 0 <= index < len(ledger): _trade_fail("Invalid projection source index.")
        if not isinstance(item.get("sourceRefs"), list) or len(item["sourceRefs"]) > 100: _trade_fail()
        if "draftId" in item and item["draftId"] is not None and (not isinstance(item["draftId"], str) or not item["draftId"]): _trade_fail()
        if "rowCropHash" in item and item["rowCropHash"] is not None and (not isinstance(item["rowCropHash"], str) or not re.fullmatch(r"[0-9a-f]{64}", item["rowCropHash"])): _trade_fail()
        if "rowBox" in item and item["rowBox"] is not None:
            box = item["rowBox"]
            if not isinstance(box, dict) or set(box) != {"x", "y", "width", "height"} or any(type(box.get(k)) is not int for k in box) or box["x"] < 0 or box["y"] < 0 or box["width"] < 1 or box["height"] < 1: _trade_fail()
        sources[sid] = item; per_capture[cid].append(item); seen_positions.add((cid, ordinal)); indices.append(index)
    if sorted(indices) != list(range(len(ledger))): _trade_fail("Projection source indices must be a permutation.")
    if ledger != sorted(ledger, key=lambda x: (captures_ordered.index(x["captureId"]), x["ordinal"])): _trade_fail("Source rows must follow capture order and ordinal.")
    counts = {cid: len(per_capture[cid]) for cid in captures_ordered}
    for ordinal, capture in enumerate(captures, 1):
        evidence = evidence_by_id[capture["captureId"]]
        if evidence.get("captureOrdinal") != ordinal or evidence.get("completeRowCount") != counts[capture["captureId"]]: _trade_fail("Capture metrics do not match source rows and edges.")

    logical = proj.get("rows")
    if not isinstance(logical, list) or not isinstance(completion_rows, list) or len(logical) != len(completion_rows) or len(logical) > 1000: _trade_fail()
    logical_by_id = {}
    for row in logical:
        if not isinstance(row, dict) or not isinstance(row.get("projectionRowId"), str) or not row["projectionRowId"] or row["projectionRowId"] in logical_by_id: _trade_fail("Invalid or duplicate logical row ID.")
        logical_by_id[row["projectionRowId"]] = row
    groups = rec.get("groups")
    group_keys = {"reconciliationGroupId", "status", "memberSourceRowIds", "representativeSourceRowId", "logicalProjectionRowId", "mergeEvidenceIds"}
    if not isinstance(groups, list) or len(groups) != len(logical): _trade_fail()
    assigned, group_by_logical = {}, {}
    order = lambda sid: (captures_ordered.index(sources[sid]["captureId"]), sources[sid]["ordinal"])
    for group in groups:
        if not isinstance(group, dict) or set(group) != group_keys: _trade_fail()
        members = group.get("memberSourceRowIds")
        if not isinstance(members, list) or not members or len(members) != len(set(members)) or any(sid not in sources or sid in assigned for sid in members): _trade_fail("Source rows must be assigned exactly once.")
        ordered = sorted(members, key=order); rep = ordered[0]; lid = group.get("logicalProjectionRowId")
        if members != ordered or group.get("representativeSourceRowId") != rep or lid != rep: _trade_fail("Invalid representative or member order.")
        if group.get("reconciliationGroupId") != f"reconcile-group:{sources[rep]['projectionSourceIndex']}" or lid not in logical_by_id or lid in group_by_logical: _trade_fail()
        if len({sources[sid]["captureId"] for sid in members}) != len(members): _trade_fail("A group cannot contain multiple rows from one capture.")
        status = group.get("status")
        if status not in {"UNMERGED", "EXACT_OVERLAP", "CONFLICT"} or (len(members) == 1) != (status == "UNMERGED"): _trade_fail()
        row = logical_by_id[lid]
        if row.get("reconciliationGroupId") != group["reconciliationGroupId"] or row.get("reconciliationStatus") != status or row.get("captureId") != sources[rep]["captureId"] or row.get("ordinal") != sources[rep]["ordinal"] or row.get("projectionRowId") != lid: _trade_fail("Logical row representative metadata disagrees.")
        member_meta = row.get("reconciliationMembers")
        if not isinstance(member_meta, list) or len(member_meta) != len(members): _trade_fail()
        for sid, meta in zip(members, member_meta, strict=True):
            src = sources[sid]; required_meta = {"projectionRowId", "captureId", "ordinal", "sourceRefs"}
            if not isinstance(meta, dict) or not required_meta <= set(meta) or set(meta) - required_meta - optional: _trade_fail()
            if meta.get("projectionRowId") != sid or meta.get("captureId") != src["captureId"] or type(meta.get("ordinal")) is not int or meta["ordinal"] != src["ordinal"] or not _same_trade_json(meta.get("sourceRefs"), src["sourceRefs"]): _trade_fail("Member metadata disagrees with the source ledger.")
            if any((key in src) != (key in meta) or key in src and not _same_trade_json(meta.get(key), src[key]) for key in optional): _trade_fail("Member provenance is missing or inconsistent.")
            assigned[sid] = lid
        if not isinstance(group.get("mergeEvidenceIds"), list) or len(group["mergeEvidenceIds"]) != len(set(group["mergeEvidenceIds"])): _trade_fail()
        group_by_logical[lid] = group
    if set(assigned) != set(sources) or set(group_by_logical) != set(logical_by_id): _trade_fail("Source partition is incomplete.")
    if [group["logicalProjectionRowId"] for group in groups] != [row["projectionRowId"] for row in logical]: _trade_fail("Logical rows and reconciliation groups must share order.")
    expected_mapping = [{"sourceRowId": item["sourceRowId"], "logicalProjectionRowId": assigned[item["sourceRowId"]]} for item in ledger]
    if not _same_trade_json(rec.get("sourceToLogical"), expected_mapping): _trade_fail("Source-to-logical mapping is inconsistent.")

    extra_evidence = rec.get("sourceProjectionEvidence")
    if not isinstance(extra_evidence, list) or len(extra_evidence) > len(ledger): _trade_fail()
    evidence_rows = {}
    for row in extra_evidence:
        if not isinstance(row, dict) or row.get("projectionRowId") not in sources or row["projectionRowId"] in evidence_rows: _trade_fail()
        evidence_rows[row["projectionRowId"]] = row
    merged_sources = {sid for group in groups if len(group["memberSourceRowIds"]) > 1 for sid in group["memberSourceRowIds"]}
    if set(evidence_rows) != merged_sources: _trade_fail("Multi-source evidence must be complete and singleton evidence must not be duplicated.")
    if list(evidence_rows) != [item["sourceRowId"] for item in ledger if item["sourceRowId"] in merged_sources]: _trade_fail("Multi-source evidence order must follow source order.")

    def exact_union(values):
        union = []
        for value in values:
            if not any(_same_trade_json(value, old) for old in union): union.append(value)
        return union
    def semantic(field_name, field):
        if field_name in {"reqAmount", "count", "yield"}:
            value = field.get("shownValue")
            if value is not None and type(value) is not int: _trade_fail()
            return ("number", value), None
        candidate = field.get("candidate")
        identity = None
        if isinstance(candidate, dict) and isinstance(candidate.get("stableId"), str) and candidate["stableId"]:
            identity = {"stableId": candidate["stableId"]}
        elif isinstance(candidate, dict) and isinstance(candidate.get("legacyNameKey"), str) and candidate["legacyNameKey"]:
            identity = {"legacyNameKey": candidate["legacyNameKey"]}
        elif isinstance(candidate, dict) and candidate.get("authorityStatus") == "OPEN_WORLD" and field_name == "fromItem" and isinstance(field.get("shownValue"), str):
            identity = {"openWorld": field["shownValue"]}
        return ("identity", identity if identity is not None else field.get("shownValue")), identity
    for lid, group in group_by_logical.items():
        members = group["memberSourceRowIds"]; row = logical_by_id[lid]; member_rows = []
        for sid in members:
            source_row = sources[sid]; member = row if len(members) == 1 else evidence_rows[sid]
            if member.get("projectionRowId") != sid or member.get("captureId") != source_row["captureId"] or member.get("ordinal") != source_row["ordinal"] or member.get("sourceIndex") != source_row["projectionSourceIndex"] or member.get("rowStatus") != "COMPLETE" or member.get("reviewState") != "SYSTEM_PREDICTION_UNREVIEWED": _trade_fail("Source projection evidence disagrees with the ledger.")
            if (len(members) > 1 and not _same_trade_json(member.get("sourceRefs"), source_row["sourceRefs"])) or any((key in source_row) != (key in member) or key in source_row and not _same_trade_json(member.get(key), source_row[key]) for key in optional): _trade_fail("Source refs or geometry disagree with the ledger.")
            original = member.get("originalRowEvidence")
            if not isinstance(original, dict) or original.get("captureId") != source_row["captureId"] or original.get("ordinal") != source_row["ordinal"] or not _same_trade_json(original.get("sourceRefs"), source_row["sourceRefs"]): _trade_fail()
            if any((key in source_row) != (key in original) or key in source_row and not _same_trade_json(original.get(key), source_row[key]) for key in optional): _trade_fail("Original row evidence metadata disagrees with the ledger.")
            original_id = original.get("rowId")
            expected_source_id = original_id if isinstance(original_id, str) and original_id else f"draft:{source_row['captureId']}:{source_row['ordinal']}"
            if expected_source_id != sid or not isinstance(original.get("fields"), dict) or set(original["fields"]) != set(TRADE_FIELDS): _trade_fail("Source row ID or raw field evidence does not match R003 semantics.")
            if not isinstance(member.get("fields"), dict) or set(member["fields"]) != set(TRADE_FIELDS) or not isinstance(row.get("fields"), dict) or set(row["fields"]) != set(TRADE_FIELDS): _trade_fail()
            for field_name in TRADE_FIELDS:
                projected_field = member["fields"][field_name]
                if not isinstance(projected_field, dict) or not _same_trade_json(projected_field.get("rawEvidence"), original["fields"][field_name]): _trade_fail("R003 raw source evidence was changed.")
            member_rows.append(member)
        expected_refs = exact_union([ref for member in member_rows for ref in member["sourceRefs"]])
        if not _same_trade_json(row.get("sourceRefs"), expected_refs): _trade_fail("Logical source refs must be the deterministic member union.")
        if not _same_trade_json(row.get("rowBox"), sources[members[0]].get("rowBox")) or not _same_trade_json(row.get("rowCropHash"), sources[members[0]].get("rowCropHash")): _trade_fail("Logical crop compatibility fields must use the representative source.")
        has_conflict = False
        for field_name in TRADE_FIELDS:
            member_fields = [member["fields"][field_name] for member in member_rows]
            logical_field = row["fields"][field_name]
            semantic_values = [semantic(field_name, field) for field in member_fields]
            distinct = []
            for value, identity in semantic_values:
                if not any(_same_trade_json(value, seen[0]) for seen in distinct): distinct.append((value, identity))
            if len(distinct) > 1:
                has_conflict = True
                if logical_field.get("shownValue") is not None or logical_field.get("candidate") is not None or logical_field.get("status") != "AMBIGUOUS": _trade_fail("Conflicting source fields cannot select one value.")
                expected_alternatives = []
                for distinct_value, identity in distinct:
                    selected_ids = [sid for sid, sem_value in zip(members, semantic_values, strict=True) if _same_trade_json(sem_value[0], distinct_value)]
                    expected_alternatives.append({"value": member_fields[members.index(selected_ids[0])].get("shownValue"),
                        "identityKey": identity, "sourceRowIds": selected_ids,
                        "sourceRefs": exact_union([ref for sid in selected_ids for ref in sources[sid]["sourceRefs"]])})
                if not _same_trade_json(logical_field.get("alternatives"), expected_alternatives): _trade_fail("Conflict alternatives must preserve every distinct source result and lineage.")
                conflicts = [item for item in logical_field.get("riskReasons", []) if isinstance(item, dict) and item.get("code") == "RECONCILIATION_CONFLICT"]
                if len(conflicts) != 1 or not _same_trade_json(conflicts[0].get("detail"), {"sourceRowIds": members}): _trade_fail("Conflict risk provenance is missing.")
            else:
                representative = member_fields[0]
                if any(not _same_trade_json(logical_field.get(key), representative.get(key)) for key in ("shownValue", "candidate", "status", "normalizationSteps")): _trade_fail("Equal source fields must preserve the representative candidate.")
            expected_risks = exact_union([item for field in member_fields for item in field.get("riskReasons", [])])
            if len(distinct) > 1:
                conflict_risks = [item for item in logical_field.get("riskReasons", []) if isinstance(item, dict) and item.get("code") == "RECONCILIATION_CONFLICT"]
                expected_risks = exact_union(expected_risks + conflict_risks)
            expected_reasons = exact_union([item for field in member_fields for item in field.get("correctionReason", [])])
            if not _same_trade_json(logical_field.get("riskReasons", []), expected_risks) or not _same_trade_json(logical_field.get("correctionReason", []), expected_reasons):
                _trade_fail("Source risks and correction reasons must be preserved deterministically.")
        if (group["status"] == "CONFLICT") != has_conflict: _trade_fail("Group status must reflect source field conflicts.")
    overlaps = rec.get("overlaps")
    if not isinstance(overlaps, list) or len(overlaps) > 200: _trade_fail()
    overlap_ids = set(); links = set()
    def source_identity(sid, field_name):
        member = evidence_rows.get(sid)
        if not isinstance(member, dict): return None
        field = member.get("fields", {}).get(field_name)
        if not isinstance(field, dict) or field.get("status") in {"AMBIGUOUS", "UNMATCHED", "MASTER_DISAGREEMENT"}: return None
        candidate = field.get("candidate")
        if isinstance(candidate, dict) and isinstance(candidate.get("stableId"), str) and candidate["stableId"]: return ("stableId", candidate["stableId"])
        if isinstance(candidate, dict) and isinstance(candidate.get("legacyNameKey"), str) and candidate["legacyNameKey"]: return ("legacyNameKey", candidate["legacyNameKey"])
        if field_name == "fromItem" and isinstance(candidate, dict) and candidate.get("authorityStatus") == "OPEN_WORLD" and isinstance(field.get("shownValue"), str): return ("openWorld", field["shownValue"])
        return None
    for overlap in overlaps:
        if not isinstance(overlap, dict) or set(overlap) != {"overlapId", "basis", "leftCaptureId", "rightCaptureId", "pairs"}: _trade_fail()
        oid, basis, left, right, pairs = (overlap.get(key) for key in ("overlapId", "basis", "leftCaptureId", "rightCaptureId", "pairs"))
        if not isinstance(oid, str) or oid in overlap_ids or basis not in {"ADJACENT_SUFFIX_PREFIX", "ADJACENT_ROW_CROP_HASH", "DUPLICATE_IMAGE"} or left not in per_capture or right not in per_capture or not isinstance(pairs, list) or not pairs: _trade_fail()
        overlap_ids.add(oid); li, ri = captures_ordered.index(left), captures_ordered.index(right)
        if li >= ri or basis != "DUPLICATE_IMAGE" and (ri != li + 1 or image_hashes[left] == image_hashes[right]): _trade_fail()
        left_rows, right_rows = sorted(per_capture[left], key=lambda x: x["ordinal"]), sorted(per_capture[right], key=lambda x: x["ordinal"])
        left_ord, right_ord = [], []
        for pair in pairs:
            if not isinstance(pair, dict) or set(pair) != {"leftSourceRowId", "rightSourceRowId"}: _trade_fail()
            ls, rs = pair["leftSourceRowId"], pair["rightSourceRowId"]
            if ls not in sources or rs not in sources or sources[ls]["captureId"] != left or sources[rs]["captureId"] != right: _trade_fail()
            if assigned.get(ls) != assigned.get(rs): _trade_fail("Overlap pair endpoints must belong to one logical group.")
            if basis != "DUPLICATE_IMAGE" and any(source_identity(ls, name) is None or source_identity(ls, name) != source_identity(rs, name) for name in ("island", "fromItem", "toItem")):
                _trade_fail("Ordinary overlap requires matching resolved identity3 evidence.")
            link = frozenset((ls, rs))
            if link in links: _trade_fail("A source pair cannot be asserted by multiple overlap descriptors.")
            left_ord.append(sources[ls]["ordinal"]); right_ord.append(sources[rs]["ordinal"]); links.add(link)
        if basis == "ADJACENT_SUFFIX_PREFIX":
            if len(pairs) < 2 or left_ord != [x["ordinal"] for x in left_rows[-len(pairs):]] or right_ord != [x["ordinal"] for x in right_rows[:len(pairs)]]: _trade_fail()
        elif basis == "ADJACENT_ROW_CROP_HASH":
            if len(pairs) != 1 or left_ord != [left_rows[-1]["ordinal"]] or right_ord != [right_rows[0]["ordinal"]]: _trade_fail()
            lh, rh = sources[pairs[0]["leftSourceRowId"]].get("rowCropHash"), sources[pairs[0]["rightSourceRowId"]].get("rowCropHash")
            if not isinstance(lh, str) or not re.fullmatch(r"[0-9a-f]{64}", lh) or lh != rh: _trade_fail()
        else:
            if image_hashes[left] != image_hashes[right] or len(left_rows) != len(right_rows) or [x["ordinal"] for x in left_rows] != [x["ordinal"] for x in right_rows] or len(pairs) != len(left_rows) or left_ord != [x["ordinal"] for x in left_rows] or right_ord != left_ord: _trade_fail()
    for group in groups:
        members = group["memberSourceRowIds"]
        internal = [link for link in links if link <= set(members)]
        if len(members) > 1:
            adjacency = {sid: set() for sid in members}
            for link in internal:
                left, right = tuple(link); adjacency[left].add(right); adjacency[right].add(left)
            reached, pending = set(), [members[0]]
            while pending:
                current = pending.pop()
                if current in reached: continue
                reached.add(current); pending.extend(adjacency[current] - reached)
            if len(reached) != len(members): _trade_fail("Merged group is disconnected from overlap evidence.")
        expected_ids = [overlap["overlapId"] for overlap in overlaps if any(pair["leftSourceRowId"] in members and pair["rightSourceRowId"] in members for pair in overlap["pairs"])]
        if group["mergeEvidenceIds"] != expected_ids: _trade_fail("Group overlap references do not match pair evidence.")
    findings = rec.get("findings")
    if not isinstance(findings, list) or len(findings) > 1000: _trade_fail()
    for finding in findings:
        if not isinstance(finding, dict) or set(finding) != {"code", "messageKo", "sourceRowIds", "captureIds"} or not isinstance(finding.get("code"), str) or not isinstance(finding.get("messageKo"), str) or not isinstance(finding.get("sourceRowIds"), list) or any(sid not in sources for sid in finding["sourceRowIds"]) or not isinstance(finding.get("captureIds"), list) or any(cid not in per_capture for cid in finding["captureIds"]): _trade_fail()
    return counts


def _trade_json_walk(value: Any, *, depth: int = 0, budget: list[int] | None = None) -> None:
    if budget is None: budget = [250_000]
    budget[0] -= 1
    if budget[0] < 0 or depth > 32: _trade_fail("The observation exceeds structural limits.")
    if isinstance(value, float):
        if not math.isfinite(value): _trade_fail("Non-finite numbers are not allowed.")
        return
    if isinstance(value, str):
        try: encoded = value.encode("utf-8", "strict")
        except UnicodeEncodeError: _trade_fail("Text must be valid Unicode.")
        if len(encoded) > 8192: _trade_fail("A diagnostic string exceeds its limit.")
    elif isinstance(value, dict):
        if len(value) > 128 and not ("legacyNames" in value or "entities" in value): _trade_fail("An object exceeds its key limit.")
        for key, child in value.items():
            if not isinstance(key, str): _trade_fail()
            if key.lower() in {"image", "imagebytes", "base64", "dataurl", "blob", "bytes", "path", "filepath", "url"}: _trade_fail("Binary data and external paths are not accepted in JSON.")
            if (key.endswith("Id") or key.endswith("Version") or key in {"projectionRowId", "draftId", "registryVersion", "correctionVersion"}) and isinstance(child, str) and len(child.encode("utf-8")) > 256: _trade_fail("An identifier or version label exceeds its limit.")
            if isinstance(child, list):
                list_limit = 128 if key in {"riskReasons", "correctionReason", "reasonCodes", "alternatives", "selectionReasons"} else 100 if key == "sourceRefs" else 1000 if key in {"rows", "legacyNames", "entities"} else 200 if key == "edgeSegments" else 100 if key in {"captures", "captureEvidence"} else 6000
                if len(child) > list_limit: _trade_fail("A contract list exceeds its limit.")
            _trade_json_walk(key, depth=depth + 1, budget=budget)
            _trade_json_walk(child, depth=depth + 1, budget=budget)
    elif isinstance(value, list):
        if len(value) > 6000: _trade_fail("An array exceeds its limit.")
        for child in value: _trade_json_walk(child, depth=depth + 1, budget=budget)
    elif value is None or type(value) in (bool, int):
        if type(value) is int and abs(value) > MAX_SAFE_INTEGER: _trade_fail("An integer exceeds the safe range.")
    elif value is not None:
        _trade_fail()


def validate_trade_review_observation(payload: dict[str, Any]) -> dict[str, Any]:
    """Strict, endpoint-specific R006 truth and cross-snapshot validator."""
    import re
    from .recognition_store import canonical_json
    required = {"schemaVersion", "mutationId", "createdAt", "confirmationRevision", "supersedesObservationId", "completion", "sourceContext", "cropPlan"}
    if set(payload) != required: _trade_fail()
    _trade_json_walk(payload)
    try: canonical_bytes = canonical_json(payload).encode("utf-8", "strict")
    except (ValueError, UnicodeEncodeError): _trade_fail("The observation cannot be serialized canonically.")
    if len(canonical_bytes) > MAX_TRADE_OBSERVATION_BYTES: raise RecognitionContractError("request_too_large", "The canonical observation exceeds 8 MiB.", 413)
    if type(payload["schemaVersion"]) is not int or payload["schemaVersion"] != 1 or type(payload["confirmationRevision"]) is not int or payload["confirmationRevision"] != 1 or payload["supersedesObservationId"] is not None: _trade_fail()
    try: mutation = str(uuid.UUID(payload["mutationId"]))
    except (ValueError, TypeError, AttributeError): _trade_fail("mutationId must be a UUID.")
    if mutation != payload["mutationId"]: _trade_fail("mutationId must use canonical lowercase UUID form.")
    created = payload["createdAt"]
    if not isinstance(created, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", created): _trade_fail("createdAt must be an ISO UTC timestamp with milliseconds.")
    try:
        if datetime.fromisoformat(created.replace("Z", "+00:00")).utcoffset() != timezone.utc.utcoffset(datetime.now(timezone.utc)): _trade_fail()
    except ValueError: _trade_fail("createdAt must be a valid UTC timestamp.")
    completion = payload["completion"]
    ckeys = {"schemaVersion", "reviewMode", "recognitionBatchId", "projectionHash", "registryVersion", "correctionVersion", "reviewRevision", "rows", "edgeSegments", "summary"}
    if not isinstance(completion, dict) or set(completion) != ckeys or completion.get("schemaVersion") != 1 or type(completion.get("schemaVersion")) is not int or completion.get("reviewMode") != "REVIEW_FIRST": _trade_fail()
    try: batch = str(uuid.UUID(completion["recognitionBatchId"]))
    except (ValueError, TypeError, AttributeError): _trade_fail("recognitionBatchId must be a UUID.")
    if batch != completion["recognitionBatchId"]: _trade_fail()
    for key in ("projectionHash",):
        if not isinstance(completion.get(key), str) or not re.fullmatch(r"[0-9a-f]{64}", completion[key]): _trade_fail()
    for key in ("registryVersion", "correctionVersion"):
        if not isinstance(completion.get(key), str) or not completion[key] or len(completion[key].encode("utf-8")) > 256: _trade_fail()
    if type(completion.get("reviewRevision")) is not int or completion["reviewRevision"] < 0: _trade_fail()
    source = payload["sourceContext"]
    if not isinstance(source, dict) or set(source) != {"version", "authority", "registry", "projection", "recognition", "captures", "gameVersion"} or source.get("version") != 1 or source.get("authority") != "CLIENT_ATTESTED": _trade_fail()
    if source["gameVersion"] is not None and (not isinstance(source["gameVersion"], str) or len(source["gameVersion"].encode("utf-8")) > 128): _trade_fail()
    registry, projection, recognition = source["registry"], source["projection"], source["recognition"]
    if not isinstance(registry, dict) or not isinstance(projection, dict) or not isinstance(recognition, dict): _trade_fail()
    if not isinstance(registry, dict) or set(registry) != {"sourceRevision", "sourceSha256", "snapshotSha256", "snapshot", "hashBasis"} or registry.get("hashBasis") != "JS_REGISTRY_SORTED_JSON_V1" or not isinstance(registry.get("snapshot"), dict): _trade_fail()
    if not isinstance(registry.get("sourceRevision"), str) or not registry["sourceRevision"] or any(not isinstance(registry.get(k), str) or not re.fullmatch(r"[0-9a-f]{64}", registry[k]) for k in ("sourceSha256", "snapshotSha256")): _trade_fail()
    if not isinstance(projection, dict) or set(projection) != {"snapshot", "hashBasis"} or projection.get("hashBasis") != "JS_REGISTRY_SORTED_JSON_V1" or not isinstance(projection.get("snapshot"), dict): _trade_fail()
    if not isinstance(recognition, dict) or set(recognition) != {"resultVersion", "runtime", "boundaryPolicy", "captureEvidence", "geometryProfile"} or recognition.get("resultVersion") != 1: _trade_fail()
    if not isinstance(recognition.get("runtime"), dict) or set(recognition["runtime"]) != {"engineId", "modelBundleSha256", "workerVersion"}: _trade_fail()
    if any(value is not None and (not isinstance(value, str) or len(value.encode("utf-8")) > 256) for value in recognition["runtime"].values()): _trade_fail()
    model_hash = recognition["runtime"].get("modelBundleSha256")
    if model_hash is not None and not re.fullmatch(r"[0-9a-f]{64}", model_hash): _trade_fail()
    if not isinstance(recognition.get("boundaryPolicy"), str) or not recognition["boundaryPolicy"]: _trade_fail()
    geometry_profile = recognition.get("geometryProfile")
    if not isinstance(geometry_profile, dict) or set(geometry_profile) != {"revision", "sha256", "availability"} or geometry_profile != {"revision": None, "sha256": None, "availability": "NOT_EXPOSED_BY_API"}: _trade_fail()
    if not isinstance(recognition.get("captureEvidence"), dict) or set(recognition["captureEvidence"]) != {"captures", "edgeSegments"} or not isinstance(recognition["captureEvidence"].get("captures"), list) or not isinstance(recognition["captureEvidence"].get("edgeSegments"), list): _trade_fail()
    captures = source.get("captures")
    if not isinstance(captures, list) or not 1 <= len(captures) <= 100: _trade_fail()
    capture_ids = set()
    evidence_by_id = {item.get("captureId"): item for item in recognition["captureEvidence"]["captures"] if isinstance(item, dict)}
    if len(evidence_by_id) != len(captures) or len(recognition["captureEvidence"]["captures"]) != len(captures): _trade_fail("Capture evidence must match the submitted captures.")
    for item in captures:
        if not isinstance(item, dict) or set(item) != {"captureId", "metadata", "bitmapSha256", "sourceSha256", "bitmapBytes", "sourceBytes", "reencoded"}: _trade_fail()
        try: cid = str(uuid.UUID(item["captureId"]))
        except (ValueError, TypeError, AttributeError): _trade_fail()
        if cid != item["captureId"] or cid in capture_ids: _trade_fail()
        capture_ids.add(cid)
        if not isinstance(item["metadata"], dict) or item["metadata"].get("captureId") != cid or item["metadata"].get("taskType") != "trade": _trade_fail()
        validate_capture_metadata(item["metadata"], expected_task="trade")
        if not isinstance(item["bitmapSha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", item["bitmapSha256"]): _trade_fail()
        if item["sourceSha256"] is not None and (not isinstance(item["sourceSha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", item["sourceSha256"])): _trade_fail()
        for key in ("bitmapBytes", "sourceBytes"):
            if type(item[key]) is not int or item[key] < 0: _trade_fail()
        if type(item["reencoded"]) is not bool: _trade_fail()
        evidence = evidence_by_id.get(cid)
        if not isinstance(evidence, dict) or set(evidence) != {"captureId", "batchId", "captureOrdinal", "imageHash", "imageDimensions", "detectedCandidateCount", "completeRowCount", "edgeSegmentCount"}: _trade_fail()
        if evidence.get("batchId") != item["metadata"].get("batchId") or type(evidence.get("captureOrdinal")) is not int or evidence["captureOrdinal"] < 1: _trade_fail()
        counts = [evidence.get(key) for key in ("detectedCandidateCount", "completeRowCount", "edgeSegmentCount")]
        if any(type(count) is not int or count < 0 for count in counts) or counts[0] != counts[1] + counts[2]: _trade_fail()
        if evidence is None or evidence.get("imageHash") != item["bitmapSha256"] or not _same_trade_json(evidence.get("imageDimensions"), item["metadata"].get("frame")): _trade_fail("Capture provenance does not match recognition evidence.")
    if [item.get("captureId") for item in recognition["captureEvidence"]["captures"]] != [item["captureId"] for item in captures]: _trade_fail("Capture order does not match recognition evidence.")
    proj = projection["snapshot"]
    if not isinstance(proj.get("projectionHash"), str) or not isinstance(proj.get("masterVersion"), str) or not isinstance(proj.get("correctionPolicyVersion"), str): _trade_fail()
    proj_rows = proj.get("rows") if isinstance(proj, dict) else None
    rows, edges = completion["rows"], completion["edgeSegments"]
    if not isinstance(proj_rows, list) or not isinstance(rows, list) or len(rows) != len(proj_rows) or len(rows) > 1000 or not isinstance(edges, list) or len(edges) > 200: _trade_fail()
    reconciliation = proj.get("reconciliation")
    if reconciliation is None:
        if "schemaVersion" in proj and (type(proj["schemaVersion"]) is not int or proj["schemaVersion"] != 1): _trade_fail("Unsupported legacy projection schema.")
        for row in proj_rows:
            if isinstance(row, dict) and any(key in row for key in ("reconciliationGroupId", "reconciliationStatus", "reconciliationMembers")): _trade_fail("Reconciled row metadata requires a reconciliation mapping.")
    else:
        _validate_reconciled_trade_projection(proj, captures, evidence_by_id, rows)
    if completion["projectionHash"] != proj.get("projectionHash") or completion["registryVersion"] != registry["snapshot"].get("registryVersion") or completion["registryVersion"] != proj.get("masterVersion") or completion["correctionVersion"] != proj.get("correctionPolicyVersion"): _trade_fail("Completion and source snapshots disagree.")
    if not _same_trade_json(edges, recognition["captureEvidence"]["edgeSegments"]): _trade_fail("Edge evidence does not match the recognition source.")
    for ordinal, capture in enumerate(captures, 1):
        evidence = evidence_by_id[capture["captureId"]]
        complete_count = (sum(1 for row in proj_rows if row.get("captureId") == capture["captureId"])
                          if reconciliation is None else sum(1 for source_row in reconciliation["sourceRows"] if source_row["captureId"] == capture["captureId"]))
        edge_count = sum(1 for edge in edges if edge.get("captureId") == capture["captureId"])
        if evidence["captureOrdinal"] != ordinal or evidence["completeRowCount"] != complete_count or evidence["edgeSegmentCount"] != edge_count: _trade_fail("Capture metrics do not match reviewed rows and edges.")
    unchanged = edited = unknown = risky_count = 0
    row_ids = set()
    for row, projected in zip(rows, proj_rows, strict=True):
        if not isinstance(row, dict) or not isinstance(projected, dict): _trade_fail()
        row_keys = {"projectionRowId", "captureId", "ordinal", "sourceRefs", "fields"}
        if not row_keys <= set(row) or set(row) - row_keys - {"draftId", "rowBox", "rowCropHash"}: _trade_fail()
        rid = row.get("projectionRowId")
        if not isinstance(rid, str) or not rid or len(rid.encode("utf-8")) > 256 or rid != projected.get("projectionRowId") or rid in row_ids: _trade_fail()
        row_ids.add(rid)
        if row.get("captureId") != projected.get("captureId") or row.get("ordinal") != projected.get("ordinal") or row.get("captureId") not in capture_ids or not _same_trade_json(row.get("sourceRefs"), projected.get("sourceRefs")): _trade_fail("Row lineage does not match its projection.")
        if any(not _same_trade_json(row.get(key, None), projected.get(key, None)) for key in ("draftId", "rowBox", "rowCropHash")): _trade_fail()
        if type(row.get("ordinal")) is not int or row["ordinal"] < 0 or not isinstance(row.get("sourceRefs"), list) or len(row["sourceRefs"]) > 100: _trade_fail()
        fields = row.get("fields")
        if not isinstance(fields, list) or len(fields) != 6 or not all(isinstance(f, dict) for f in fields) or [f.get("field") for f in fields] != list(TRADE_FIELDS): _trade_fail()
        expected_fields = projected.get("fields")
        for field in fields:
            if set(field) != {"field", "shownValueBefore", "finalValue", "verificationMethod", "projectionStatus", "candidate", "rawEvidence", "correctionReason", "riskReasons", "masterVersion"}: _trade_fail()
            key = field["field"]
            pf = expected_fields.get(key) if isinstance(expected_fields, dict) else None
            if not isinstance(pf, dict) or not _same_trade_json(field.get("shownValueBefore"), pf.get("shownValue")) or field.get("projectionStatus") != pf.get("status") or not _same_trade_json(field.get("candidate"), pf.get("candidate")) or not _same_trade_json(field.get("rawEvidence"), pf.get("rawEvidence")) or not _same_trade_json(field.get("correctionReason"), pf.get("correctionReason")) or not _same_trade_json(field.get("riskReasons"), pf.get("riskReasons")) or field.get("masterVersion") != pf.get("masterVersion"): _trade_fail("Field truth does not match its projection.")
            method, shown, final = field.get("verificationMethod"), field.get("shownValueBefore"), field.get("finalValue")
            numeric = key in {"reqAmount", "count", "yield"}
            minimum = 0 if key == "count" else 1
            for value in (shown, final):
                if value is not None and (numeric and (type(value) is not int or value < minimum) or not numeric and not isinstance(value, str)): _trade_fail()
                if not numeric and isinstance(value, str) and len(value.encode("utf-8")) > 512: _trade_fail()
            if method == "USER_MARKED_UNKNOWN":
                if final is not None: _trade_fail()
                unknown += 1
            elif method == "USER_BATCH_CONFIRMED_UNCHANGED":
                if shown is None or type(shown) is not type(final) or shown != final: _trade_fail()
                unchanged += 1
            elif method == "USER_EDITED":
                if final is None or type(shown) is type(final) and shown == final: _trade_fail()
                edited += 1
            else: _trade_fail()
            if not numeric and final is not None and not final.strip(): _trade_fail()
            if field.get("riskReasons") or field.get("projectionStatus") in {"AMBIGUOUS", "UNMATCHED", "MASTER_DISAGREEMENT"}: risky_count += 1
    summary = completion["summary"]
    expected_summary = {"rowCount": len(rows), "fieldCount": len(rows)*6, "unchangedFieldCount": unchanged, "editedFieldCount": edited, "unknownFieldCount": unknown, "riskFieldCount": risky_count, "edgeSegmentCount": len(edges)}
    if not isinstance(summary, dict) or set(summary) != set(expected_summary) or any(type(summary.get(key)) is not int or summary.get(key) != value for key, value in expected_summary.items()) or unchanged+edited+unknown != len(rows)*6: _trade_fail("Review summary does not match reviewed fields.")
    for edge in edges:
        if not isinstance(edge, dict) or "fields" in edge or edge.get("captureId") not in capture_ids: _trade_fail()
    plan = payload["cropPlan"]
    if not isinstance(plan, dict) or set(plan) != {"policy", "entries"} or plan.get("policy") != "C2_REVIEW_VALUE_SUBSET_V1" or not isinstance(plan.get("entries"), list) or len(plan["entries"]) != len(rows)*6: _trade_fail()
    expected_plan = {(r["projectionRowId"], f["field"]): f for r in rows for f in r["fields"]}
    seen = set()
    for entry in plan["entries"]:
        if not isinstance(entry, dict) or set(entry) != {"projectionRowId", "field", "selected", "selectionReasons", "geometry", "readerCropHash", "skipReason"}: _trade_fail()
        key = (entry["projectionRowId"], entry["field"])
        if key not in expected_plan or key in seen: _trade_fail()
        seen.add(key); field = expected_plan[key]
        risky = bool(field["riskReasons"]) or field["projectionStatus"] in {"AMBIGUOUS", "UNMATCHED", "MASTER_DISAGREEMENT"}
        reasons = ([] if field["verificationMethod"] not in {"USER_EDITED", "USER_MARKED_UNKNOWN"} else ["USER_EDITED" if field["verificationMethod"] == "USER_EDITED" else "USER_MARKED_UNKNOWN"]) + (["RISKY_FIELD"] if risky else [])
        if type(entry["selected"]) is not bool or entry["selected"] != bool(reasons) or entry["selectionReasons"] != reasons: _trade_fail()
        if entry["readerCropHash"] is not None and (not isinstance(entry["readerCropHash"], str) or not re.fullmatch(r"[0-9a-f]{64}", entry["readerCropHash"])): _trade_fail()
        projected_row = next(candidate for candidate in proj_rows if candidate["projectionRowId"] == key[0])
        projected_field = projected_row["fields"][key[1]]
        expected_reader_hash = projected_field.get("rawEvidence", {}).get("readerEvidence", {}).get("cropHash")
        if entry["readerCropHash"] != expected_reader_hash: _trade_fail()
        reader_box = projected_field.get("rawEvidence", {}).get("readerEvidence", {}).get("geometry", {}).get("box")
        row_box = projected_row.get("rowBox")
        expected_geometry = None
        if isinstance(reader_box, dict) and isinstance(row_box, dict):
            coordinates = [reader_box.get(k) for k in ("x", "y", "width", "height")] + [row_box.get(k) for k in ("x", "y", "width", "height")]
            if (all(type(number) is int for number in coordinates) and reader_box["x"] >= 0 and reader_box["y"] >= 0
                    and reader_box["width"] > 0 and reader_box["height"] > 0 and row_box["x"] >= 0 and row_box["y"] >= 0
                    and reader_box["x"] + reader_box["width"] <= row_box["width"] and reader_box["y"] + reader_box["height"] <= row_box["height"]
                    and reader_box["width"] <= 1024 and reader_box["height"] <= 256 and reader_box["width"] * reader_box["height"] <= 262144):
                expected_geometry = {"source": "CAPTURE_BITMAP_PIXELS", "captureId": projected_row["captureId"],
                    "x": row_box["x"] + reader_box["x"], "y": row_box["y"] + reader_box["y"], "width": reader_box["width"], "height": reader_box["height"]}
        if not _same_trade_json(entry["geometry"], expected_geometry): _trade_fail("Crop geometry does not match stored source evidence.")
        if entry["geometry"] is None:
            if entry["skipReason"] != ("NOT_SELECTED" if not entry["selected"] else "GEOMETRY_UNAVAILABLE"): _trade_fail()
        else:
            geo = entry["geometry"]
            selected_skip = None if entry["selected"] else "NOT_SELECTED"
            capture_record = next((c for c in captures if c["captureId"] == geo.get("captureId")), None)
            if capture_record is None: _trade_fail()
            frame = capture_record["metadata"].get("frame", {})
            if entry["skipReason"] != selected_skip or set(geo) != {"source", "captureId", "x", "y", "width", "height"} or geo.get("source") != "CAPTURE_BITMAP_PIXELS" or geo.get("captureId") != projected_row["captureId"] or any(type(geo.get(k)) is not int for k in ("x","y","width","height")) or geo["x"]<0 or geo["y"]<0 or geo["width"]<1 or geo["height"]<1 or geo["x"]+geo["width"]>frame.get("width",0) or geo["y"]+geo["height"]>frame.get("height",0): _trade_fail()
    return payload


def validate_trade_crop_metadata(value: dict[str, Any], png_bytes: bytes) -> dict[str, Any]:
    import hashlib
    required = {"version", "cropMutationId", "projectionRowId", "field", "sha256", "width", "height"}
    if set(value) != required or type(value.get("version")) is not int or value["version"] != 1: _trade_fail()
    try:
        if str(uuid.UUID(value["cropMutationId"])) != value["cropMutationId"]: _trade_fail()
    except (ValueError, TypeError, AttributeError): _trade_fail()
    if not isinstance(value.get("projectionRowId"), str) or not value["projectionRowId"] or value.get("field") not in TRADE_FIELDS: _trade_fail()
    if len(png_bytes) > MAX_TRADE_CROP_BYTES: raise RecognitionContractError("crop_too_large", "The crop exceeds the allowed size.", 413)
    if hashlib.sha256(png_bytes).hexdigest() != value.get("sha256"): _trade_fail("Crop SHA-256 does not match its bytes.")
    if type(value.get("width")) is not int or type(value.get("height")) is not int or not (1 <= value["width"] <= 1024 and 1 <= value["height"] <= 256 and value["width"]*value["height"] <= 262144): _trade_fail()
    try:
        if not png_bytes.startswith(b"\x89PNG\r\n\x1a\n"): _trade_fail("Crop must be a PNG image.")
        offset = 8
        while offset + 12 <= len(png_bytes):
            length = int.from_bytes(png_bytes[offset:offset+4], "big")
            chunk = png_bytes[offset+4:offset+8]
            end = offset + 12 + length
            if end > len(png_bytes): _trade_fail("The PNG crop is truncated.")
            if chunk in {b"tEXt", b"iTXt", b"zTXt", b"eXIf"}: _trade_fail("PNG text and EXIF metadata are not accepted.")
            offset = end
            if chunk == b"IEND": break
        image = Image.open(BytesIO(png_bytes))
        if image.format != "PNG" or getattr(image, "n_frames", 1) != 1 or image.size != (value["width"], value["height"]): _trade_fail("Only plain, single-frame PNG crops are accepted.")
    except (UnidentifiedImageError, OSError, ValueError): _trade_fail("The crop is not a valid PNG image.")
    return value


def validate_trade_crop_metadata_v3(value: dict[str, Any], png_bytes: bytes, crop_ref: dict[str, Any]) -> dict[str, Any]:
    import hashlib
    expected = {"schemaVersion", "cropMutationId", "projectionRowId", "field", "cropRefId", "sha256", "pixelSha256", "width", "height"}
    _keys(value, expected)
    if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 3 or _uuid(value["cropMutationId"], "cropMutationId") != value["cropMutationId"]: _trade_fail()
    if not isinstance(value["projectionRowId"], str) or value["field"] not in TRADE_FIELDS or value["cropRefId"] != crop_ref["cropRefId"]: _trade_fail()
    if len(png_bytes) > MAX_TRADE_CROP_BYTES: raise RecognitionContractError("crop_too_large", "The crop exceeds the allowed size.", 413)
    if not _v3_sha(value["sha256"]) or hashlib.sha256(png_bytes).hexdigest() != value["sha256"] or value["pixelSha256"] != crop_ref["pixelSha256"]: _trade_fail("Crop hashes do not match their source binding.")
    width, height = crop_ref["box"]["width"], crop_ref["box"]["height"]
    if type(value["width"]) is not int or type(value["height"]) is not int or (value["width"], value["height"]) != (width, height): _trade_fail("Crop dimensions do not match the source geometry.")
    if not (1 <= width <= 1024 and 1 <= height <= 256 and width * height <= 262144): _trade_fail()
    try:
        if not png_bytes.startswith(b"\x89PNG\r\n\x1a\n"): _trade_fail("Crop must be a PNG image.")
        offset = 8
        while offset + 12 <= len(png_bytes):
            length = int.from_bytes(png_bytes[offset:offset+4], "big")
            chunk = png_bytes[offset+4:offset+8]
            if offset + 12 + length > len(png_bytes): _trade_fail("The PNG crop is truncated.")
            if chunk in {b"tEXt", b"iTXt", b"zTXt", b"eXIf"}: _trade_fail("PNG text and EXIF metadata are not accepted.")
            offset += 12 + length
            if chunk == b"IEND": break
        image = Image.open(BytesIO(png_bytes))
        if image.format != "PNG" or getattr(image, "n_frames", 1) != 1 or image.size != (width, height): _trade_fail("Only plain, single-frame PNG crops are accepted.")
        image.load()
        if "A" in image.getbands() and image.getchannel("A").getextrema() != (255, 255): _trade_fail("Transparent crop pixels are not accepted.")
        pixel_hash = hashlib.sha256(image.convert("RGB").tobytes()).hexdigest()
    except (UnidentifiedImageError, OSError, ValueError): _trade_fail("The crop is not a valid PNG image.")
    if pixel_hash != value["pixelSha256"]: _trade_fail("Decoded crop pixels do not match their pixel hash.")
    return value


def validate_crop_truth_label_request(value: dict[str, Any], observation: dict[str, Any], *, artifact_present: bool) -> dict[str, Any]:
    required = {"schemaVersion", "mutationId", "sourceRowId", "field", "cropRefId", "labelRevision", "supersedesLabelId", "labelStatus", "value", "provenance", "createdAt"}
    _keys(value, required, {"artifact"})
    if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1 or _uuid(value["mutationId"], "mutationId") != value["mutationId"]: _trade_fail()
    if not isinstance(value["sourceRowId"], str) or not value["sourceRowId"] or value["field"] not in TRADE_FIELDS or not isinstance(value["cropRefId"], str): _trade_fail()
    _integer(value["labelRevision"], "labelRevision", minimum=1)
    if value["supersedesLabelId"] is not None and _uuid(value["supersedesLabelId"], "supersedesLabelId") != value["supersedesLabelId"]: _trade_fail()
    if value["labelStatus"] not in {"KNOWN", "UNKNOWN", "DISPUTED"}: _trade_fail()
    numeric=value["field"] in {"reqAmount","count","yield"}
    val=value["value"]
    if value["labelStatus"]=="KNOWN":
        if val is None or numeric and (type(val) is not int or val < (0 if value["field"]=="count" else 1)) or not numeric and not isinstance(val,str): _trade_fail()
    elif val is not None: _trade_fail()
    provenance=value["provenance"]
    _keys(provenance,{"method","labelerRole","sourceFamilyId","cohort","splitManifestHash","sourceOrigin","independentOfOperationalReview","note"})
    if provenance["method"]!="HUMAN_CROP_VERIFIED" or provenance["labelerRole"]!="PRODUCT_OWNER" or provenance["cohort"] not in {"DEVELOPMENT","INDEPENDENT"} or provenance["sourceOrigin"] not in {"FRESH_CAPTURE","ARCHIVED_CAPTURE"} or type(provenance["independentOfOperationalReview"]) is not bool: _trade_fail()
    if not isinstance(provenance["sourceFamilyId"],str) or not provenance["sourceFamilyId"] or provenance["splitManifestHash"] is not None and not _v3_sha(provenance["splitManifestHash"]) or provenance["note"] is not None and not isinstance(provenance["note"],str): _trade_fail()
    _utc_timestamp(value["createdAt"])
    raw=observation["sourceContext"]["rawEvidence"]["snapshot"]
    source=next((row for row in raw["sourceRows"] if row["sourceRowId"]==value["sourceRowId"]),None)
    ref=next((crop for row in raw["sourceRows"] for field in row["fields"] for crop in field["cropRefs"] if crop["cropRefId"]==value["cropRefId"]),None)
    if source is None or ref is None or ref["sourceRowId"]!=source["sourceRowId"] or ref["field"]!=value["field"]: _trade_fail("Truth label must bind to a source row crop.")
    if ref["pngArtifactSha256"] is None and ("artifact" not in value or not artifact_present): _trade_fail("A new PNG artifact is required for this truth label.")
    artifact=value.get("artifact")
    if artifact is not None:
        _keys(artifact,{"sha256","pixelSha256","width","height"})
        if not _v3_sha(artifact["sha256"]) or ref["pngArtifactSha256"] is not None and artifact["sha256"]!=ref["pngArtifactSha256"] or artifact["pixelSha256"]!=ref["pixelSha256"] or artifact["width"]!=ref["box"]["width"] or artifact["height"]!=ref["box"]["height"]: _trade_fail()
    return value


def _v3_hash(value: Any) -> str:
    import hashlib
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8", errors="strict")).hexdigest()


def _v3_sha(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _v3_json_walk(value: Any, *, depth: int = 0, budget: list[int] | None = None) -> None:
    if budget is None: budget=[250_000]
    budget[0]-=1
    if budget[0]<0 or depth>32: _trade_fail("The v3 observation exceeds structural limits.")
    if type(value) is float: _trade_fail("Floating point values are not permitted in evidence v3.")
    if isinstance(value,str):
        try: encoded=value.encode("utf-8",errors="strict")
        except UnicodeEncodeError: _trade_fail("Text must be valid Unicode.")
        if len(encoded)>8192: _trade_fail("A v3 text value exceeds its limit.")
    elif isinstance(value,dict):
        if len(value)>256: _trade_fail("A v3 object exceeds its key limit.")
        for key,item in value.items():
            if not isinstance(key,str) or key.lower() in {"imagebytes","base64","dataurl","blob","bytes","filepath"}: _trade_fail("Evidence JSON cannot contain image bytes or local paths.")
            _v3_json_walk(key,depth=depth+1,budget=budget);_v3_json_walk(item,depth=depth+1,budget=budget)
    elif isinstance(value,list):
        if len(value)>6000: _trade_fail("A v3 array exceeds its limit.")
        for item in value: _v3_json_walk(item,depth=depth+1,budget=budget)
    elif value is None or type(value) in (bool,int):
        if type(value) is int and abs(value)>MAX_SAFE_INTEGER: _trade_fail("An integer exceeds the safe range.")
    else: _trade_fail()


def validate_final_review_observation(payload: dict[str, Any]) -> dict[str, Any]:
    """Validate the immutable FINAL_CORRECTED_RESULT observation v3 envelope.

    This intentionally does not treat retained candidates or batch confirmation as truth.
    """
    request_keys = {"schemaVersion", "reviewMode", "mutationId", "createdAt", "confirmationRevision",
                    "supersedesObservationId", "projection", "completion", "sourceContext", "cropPlan"}
    _keys(payload, request_keys)
    _v3_json_walk(payload)
    if type(payload["schemaVersion"]) is not int or payload["schemaVersion"] != 3 or payload["reviewMode"] != "FINAL_CORRECTED_RESULT": _trade_fail("Observation v3 mode/version is invalid.")
    if _uuid(payload["mutationId"], "mutationId") != payload["mutationId"] or type(payload["confirmationRevision"]) is not int or payload["confirmationRevision"] != 1: _trade_fail()
    if payload["supersedesObservationId"] is not None and _uuid(payload["supersedesObservationId"], "supersedesObservationId") != payload["supersedesObservationId"]: _trade_fail()
    _utc_timestamp(payload["createdAt"])
    projection, completion, context, crop_plan = (payload[k] for k in ("projection", "completion", "sourceContext", "cropPlan"))
    if not all(isinstance(item, dict) for item in (projection, completion, context, crop_plan)): _trade_fail()
    projection_keys = {"schemaVersion", "reviewMode", "recognitionBatchId", "rawEvidenceHash", "masterBinding", "correctionVersion", "reconciliation", "pixelAvailability", "rows", "edgeWorkItems", "hashBasis", "projectionHash"}
    completion_keys = {"schemaVersion", "reviewMode", "recognitionBatchId", "projectionHash", "masterBinding", "correctionVersion", "reviewRevision", "rows", "workItems", "batchConfirmation"}
    _keys(projection, projection_keys); _keys(completion, completion_keys)
    if projection["schemaVersion"] != 3 or type(projection["schemaVersion"]) is not int or projection["reviewMode"] != "FINAL_CORRECTED_RESULT" or projection["hashBasis"] != "TRADE_FINAL_PROJECTION_JSON_V3": _trade_fail()
    if completion["schemaVersion"] != 3 or type(completion["schemaVersion"]) is not int or completion["reviewMode"] != "FINAL_CORRECTED_RESULT": _trade_fail()
    if projection["recognitionBatchId"] != completion["recognitionBatchId"] or projection["correctionVersion"] != completion["correctionVersion"] or projection["projectionHash"] != completion["projectionHash"]: _trade_fail("Projection and completion bindings disagree.")
    review_revision = _integer(completion["reviewRevision"], "reviewRevision")
    binding_keys = {"masterSchemaVersion", "registryVersion", "contentHash", "hashBasis"}
    binding = projection["masterBinding"]
    _keys(binding, binding_keys)
    if binding.get("masterSchemaVersion") != 2 or type(binding.get("masterSchemaVersion")) is not int or binding.get("hashBasis") != "MASTER_CANONICAL_JSON_V2" or not isinstance(binding.get("registryVersion"), str) or not _v3_sha(binding.get("contentHash")): _trade_fail("Master Bundle binding is invalid.")
    if not _same_trade_json(binding, completion.get("masterBinding")): _trade_fail("Master bindings disagree.")
    try:
        from .master_store import validate_master_bundle
        master_bundle = validate_master_bundle(context.get("masterBundle", {}).get("snapshot"))
    except Exception:
        _trade_fail("Pinned Master Bundle is invalid.")
    if master_bundle.get("registryVersion") != binding["registryVersion"] or master_bundle.get("contentHash") != binding["contentHash"]: _trade_fail("Pinned Master Bundle does not match its binding.")
    if projection.get("rawEvidenceHash") != context.get("rawEvidence", {}).get("rawEvidenceHash") or not _v3_sha(projection.get("rawEvidenceHash")): _trade_fail()
    raw = context.get("rawEvidence")
    _keys(context, {"schemaVersion", "authority", "rawEvidence", "masterBundle", "audit"})
    if context["schemaVersion"] != 3 or context["authority"] != "CLIENT_ATTESTED": _trade_fail()
    _keys(raw, {"hashBasis", "rawEvidenceHash", "snapshot"})
    if raw["hashBasis"] != "TRADE_RAW_EVIDENCE_JSON_V2" or _v3_hash(raw["snapshot"]) != raw["rawEvidenceHash"]: _trade_fail("Raw evidence hash mismatch.")
    _keys(context["masterBundle"], {"binding", "snapshot"})
    if not _same_trade_json(context["masterBundle"]["binding"], binding): _trade_fail()
    audit = context["audit"]
    _keys(audit, {"recognitionStartedAt", "recognitionFinishedAt", "latencyMs", "gameVersion"})
    for key in ("recognitionStartedAt", "recognitionFinishedAt"):
        if audit[key] is not None: _utc_timestamp(audit[key])
    if audit["latencyMs"] is not None: _integer(audit["latencyMs"], "latencyMs")
    if audit["gameVersion"] is not None and not isinstance(audit["gameVersion"], str): _trade_fail()

    snapshot = raw["snapshot"]
    _keys(snapshot, {"schemaVersion", "recognitionBatchId", "captures", "sourceRows", "edgeSegments"})
    if snapshot["schemaVersion"] != 2 or type(snapshot["schemaVersion"]) is not int or snapshot["recognitionBatchId"] != projection["recognitionBatchId"]: _trade_fail()
    captures, source_rows, edges = snapshot["captures"], snapshot["sourceRows"], snapshot["edgeSegments"]
    if not isinstance(captures, list) or not isinstance(source_rows, list) or not isinstance(edges, list) or len(captures) > 100 or len(source_rows) > 1000 or len(edges) > 200: _trade_fail()
    capture_ids, source_by_id, crops = [], {}, {}
    capture_keys = {"captureId", "captureOrdinal", "imageSha256", "bitmapSha256", "sourceType", "frame", "sourceFidelity", "reencoded", "completeRowCount"}
    for idx, cap in enumerate(captures, 1):
        if not isinstance(cap, dict): _trade_fail()
        _keys(cap, capture_keys)
        if not isinstance(cap["captureId"], str) or not cap["captureId"] or len(cap["captureId"]) > MAX_ID_LENGTH or cap["captureId"] in capture_ids or type(cap["captureOrdinal"]) is not int or cap["captureOrdinal"] != idx or not _v3_sha(cap["imageSha256"]) or not _v3_sha(cap["bitmapSha256"]): _trade_fail()
        if cap["sourceType"] not in {"FILE", "CLIPBOARD", "STREAM"} or type(cap["reencoded"]) is not bool: _trade_fail()
        _keys(cap["frame"], {"width", "height"}); _integer(cap["frame"]["width"], "frame.width", minimum=1); _integer(cap["frame"]["height"], "frame.height", minimum=1)
        if cap["frame"]["width"]*cap["frame"]["height"]>MAX_IMAGE_PIXELS: _trade_fail()
        _keys(cap["sourceFidelity"], {"sourceWidth", "sourceHeight", "rescaled", "evidence"})
        fidelity=cap["sourceFidelity"]
        if fidelity["sourceWidth"] is not None: _integer(fidelity["sourceWidth"],"sourceWidth",minimum=1)
        if fidelity["sourceHeight"] is not None: _integer(fidelity["sourceHeight"],"sourceHeight",minimum=1)
        if fidelity["rescaled"] is not None and type(fidelity["rescaled"]) is not bool or not isinstance(fidelity["evidence"],str) or not fidelity["evidence"]: _trade_fail()
        if fidelity["evidence"]=="unknown" and (fidelity["sourceWidth"] is not None or fidelity["sourceHeight"] is not None or fidelity["rescaled"] is not None): _trade_fail()
        capture_ids.append(cap["captureId"])
    row_keys = {"sourceRowId", "captureId", "ordinal", "rowBox", "fields"}
    field_keys = {"field", "rawText", "rawNumeric", "readerStatus", "confidence", "cropRefs"}
    crop_keys = {"cropRefId", "sourceRowId", "captureId", "field", "bitmapSha256", "frame", "coordinateSpace", "box", "pixelHashBasis", "pixelSha256", "pngArtifactSha256"}
    for row in source_rows:
        if not isinstance(row, dict): _trade_fail()
        _keys(row, row_keys)
        sid = row["sourceRowId"]
        if not isinstance(sid, str) or not sid or sid in source_by_id or sid in capture_ids or row["captureId"] not in capture_ids: _trade_fail()
        source_by_id[sid] = row
        _integer(row["ordinal"], "ordinal")
        if row["rowBox"] is not None:
            _keys(row["rowBox"],{"x","y","width","height"})
            for key in ("x","y"): _integer(row["rowBox"][key],key)
            for key in ("width","height"): _integer(row["rowBox"][key],key,minimum=1)
            cap=next(c for c in captures if c["captureId"]==row["captureId"])
            if row["rowBox"]["x"]+row["rowBox"]["width"]>cap["frame"]["width"] or row["rowBox"]["y"]+row["rowBox"]["height"]>cap["frame"]["height"]: _trade_fail()
        fields = row["fields"]
        if not isinstance(fields, list) or len(fields) != 6 or [x.get("field") for x in fields if isinstance(x, dict)] != list(TRADE_FIELDS): _trade_fail()
        for field in fields:
            _keys(field, field_keys)
            if field["rawText"] is not None and not isinstance(field["rawText"], str): _trade_fail()
            if field["rawNumeric"] is not None: _integer(field["rawNumeric"], "rawNumeric", minimum=0)
            if not isinstance(field["readerStatus"], str) or not field["readerStatus"] or field["confidence"] is not None and not isinstance(field["confidence"], str): _trade_fail()
            if not isinstance(field["cropRefs"], list): _trade_fail()
            for crop in field["cropRefs"]:
                _keys(crop, crop_keys)
                if crop["sourceRowId"] != sid or crop["captureId"] != row["captureId"] or crop["field"] != field["field"] or crop["coordinateSpace"] != "CAPTURE_BITMAP_PIXELS" or crop["pixelHashBasis"] != "RGB8_ROW_MAJOR_V1" or not _v3_sha(crop["bitmapSha256"]) or not _v3_sha(crop["pixelSha256"]): _trade_fail()
                if crop["pngArtifactSha256"] is not None and not _v3_sha(crop["pngArtifactSha256"]): _trade_fail()
                if crop["cropRefId"] in crops: _trade_fail()
                _keys(crop["frame"], {"width", "height"}); _integer(crop["frame"]["width"], "crop frame width", minimum=1); _integer(crop["frame"]["height"], "crop frame height", minimum=1)
                _keys(crop["box"], {"x", "y", "width", "height"})
                for coordinate in ("x", "y"): _integer(crop["box"][coordinate], coordinate)
                for dimension in ("width", "height"): _integer(crop["box"][dimension], dimension, minimum=1)
                cap = next(c for c in captures if c["captureId"] == crop["captureId"])
                if crop["frame"] != cap["frame"] or crop["box"]["x"] + crop["box"]["width"] > cap["frame"]["width"] or crop["box"]["y"] + crop["box"]["height"] > cap["frame"]["height"]: _trade_fail("CropRef geometry is outside its capture frame.")
                crops[crop["cropRefId"]] = crop
    edge_ids=set()
    for edge in edges:
        _keys(edge,{"edgeId","captureId","ordinal","reason","rowBox","sourceRefs"})
        if not isinstance(edge["edgeId"],str) or not edge["edgeId"] or edge["edgeId"] in edge_ids or edge["edgeId"] in capture_ids or edge["captureId"] not in capture_ids or not isinstance(edge["reason"],str) or not edge["reason"] or not isinstance(edge["sourceRefs"],list): _trade_fail()
        edge_ids.add(edge["edgeId"]); _integer(edge["ordinal"],"edge ordinal")
    if edge_ids & set(source_by_id): _trade_fail()
    for edge in edges:
        for ref in edge["sourceRefs"]:
            _keys(ref,{"sourceRowId","captureId","ordinal"})
            if ref["sourceRowId"] not in source_by_id and ref["sourceRowId"] not in edge_ids: _trade_fail()
            if ref["sourceRowId"] in source_by_id and (ref["captureId"]!=source_by_id[ref["sourceRowId"]]["captureId"] or ref["ordinal"]!=source_by_id[ref["sourceRowId"]]["ordinal"]): _trade_fail()
    if any(cap["completeRowCount"] != sum(1 for row in source_rows if row["captureId"] == cap["captureId"]) for cap in captures): _trade_fail("Capture source row counts disagree with the raw ledger.")
    source_order=[(capture_ids.index(row["captureId"]),row["ordinal"]) for row in source_rows]
    if source_order!=sorted(source_order) or len(source_order)!=len(set(source_order)): _trade_fail("Raw source rows must preserve capture and ordinal order.")
    ledger = projection["reconciliation"]
    _keys(ledger, {"schemaVersion", "policyVersion", "captureOrder", "sourceRows", "groups", "sourceToLogical", "findings"})
    if ledger["schemaVersion"] != 2 or type(ledger["schemaVersion"]) is not int or ledger["captureOrder"] != capture_ids: _trade_fail()
    ledger_rows = ledger["sourceRows"]
    if not isinstance(ledger_rows, list) or len(ledger_rows) != len(source_rows): _trade_fail()
    ledger_source_ids=[]
    for index, item in enumerate(ledger_rows):
        _keys(item, {"sourceRowId", "captureId", "ordinal", "projectionSourceIndex"})
        sid=item["sourceRowId"]
        if sid not in source_by_id or item["captureId"] != source_by_id[sid]["captureId"] or item["ordinal"] != source_by_id[sid]["ordinal"] or item["projectionSourceIndex"] != index: _trade_fail()
        ledger_source_ids.append(sid)
    if ledger_source_ids != [x["sourceRowId"] for x in source_rows]: _trade_fail()
    rows=projection["rows"]
    if not isinstance(rows,list) or not isinstance(completion["rows"],list) or len(rows)!=len(completion["rows"]): _trade_fail()
    row_ids=[]; mapped=[]
    group_map={}
    group_ids=set()
    for group in ledger["groups"]:
        _keys(group,{"groupId","status","memberSourceRowIds","representativeSourceRowId","logicalRowId","memberEvidence"})
        members=group["memberSourceRowIds"]
        if not isinstance(members,list) or not members or group["status"] not in {"SINGLE","EXACT_OVERLAP","CONFLICT"} or group["representativeSourceRowId"]!=members[0] or any(s not in source_by_id for s in members) or group["groupId"] in group_ids: _trade_fail()
        group_ids.add(group["groupId"])
        if members!=sorted(members,key=lambda sid:(capture_ids.index(source_by_id[sid]["captureId"]),source_by_id[sid]["ordinal"])): _trade_fail("Reconciliation members must preserve source order.")
        if len(members)==1 and group["memberEvidence"]!=[] or len(members)>1 and (not isinstance(group["memberEvidence"],list) or len(group["memberEvidence"])!=len(members)): _trade_fail()
        for member_evidence in group["memberEvidence"]:
            _keys(member_evidence,{"sourceRowId","fields"})
            if member_evidence["sourceRowId"] not in members or not isinstance(member_evidence["fields"],list) or len(member_evidence["fields"])!=6: _trade_fail()
            for evidence_field in member_evidence["fields"]:
                _keys(evidence_field,{"field","rawEvidenceRefs","normalizedValue","candidates","selectedCandidateIndex","correctedValue","finalValue","identity","valueState","riskReasons","correctionReasons","alternatives","cropRefs","stageTrace"})
        if group["logicalRowId"] in group_map: _trade_fail()
        group_map[group["logicalRowId"]]=group; mapped.extend(members)
    if sorted(mapped)!=sorted(source_by_id) or len(mapped)!=len(set(mapped)): _trade_fail("Reconciliation must map every source exactly once.")
    source_to_logical=ledger["sourceToLogical"]
    if not isinstance(source_to_logical,list) or len(source_to_logical)!=len(source_rows): _trade_fail()
    mapping_by_source={}
    for item in source_to_logical:
        _keys(item,{"sourceRowId","logicalRowId"})
        if item["sourceRowId"] in mapping_by_source or item["sourceRowId"] not in source_by_id or item["logicalRowId"] not in group_map: _trade_fail()
        mapping_by_source[item["sourceRowId"]]=item["logicalRowId"]
    if [item["sourceRowId"] for item in source_to_logical]!=[item["sourceRowId"] for item in ledger_rows] or set(mapping_by_source)!=set(source_by_id) or any(mapping_by_source[sid]!=next(g["logicalRowId"] for g in ledger["groups"] if sid in g["memberSourceRowIds"]) for sid in source_by_id): _trade_fail()
    for row, done in zip(rows, completion["rows"], strict=True):
        _keys(row,{"projectionRowId","captureId","ordinal","rowBox","sourceRefs","fields","classification","classificationReasons"})
        _keys(done,{"projectionRowId","sourceRefs","fields","disposition","dispositionReason"})
        rid=row["projectionRowId"]
        if rid in row_ids or rid not in group_map or done["projectionRowId"]!=rid: _trade_fail()
        row_ids.append(rid)
        group = group_map[rid]
        if row["captureId"] != source_by_id[group["representativeSourceRowId"]]["captureId"] or row["ordinal"] != source_by_id[group["representativeSourceRowId"]]["ordinal"]: _trade_fail("Logical row representative does not match its source member.")
        if row["classification"] not in {"FINAL_READY","NEEDS_REVIEW","NEEDS_RECAPTURE","CONFLICT"} or not isinstance(row["classificationReasons"],list) or any(not isinstance(x,str) or not x for x in row["classificationReasons"]): _trade_fail()
        if row["rowBox"] != source_by_id[group["representativeSourceRowId"]]["rowBox"]: _trade_fail("Logical row box must come from its representative source.")
        expected_refs = [{"sourceRowId": sid, "captureId": source_by_id[sid]["captureId"], "ordinal": source_by_id[sid]["ordinal"]} for sid in group["memberSourceRowIds"]]
        if row["sourceRefs"] != expected_refs or done["sourceRefs"] != expected_refs: _trade_fail("Logical row sourceRefs do not match its reconciliation group.")
        if len(row["fields"])!=6 or [x.get("field") for x in row["fields"] if isinstance(x,dict)]!=list(TRADE_FIELDS) or len(done["fields"])!=6: _trade_fail()
        for pf, cf in zip(row["fields"],done["fields"],strict=True):
            _keys(pf,{"field","rawEvidenceRefs","normalizedValue","candidates","selectedCandidateIndex","correctedValue","finalValue","identity","valueState","riskReasons","correctionReasons","alternatives","cropRefs","stageTrace"})
            required={"field","shownValueBefore","finalValue","operationalDecision","riskReasons","cropRefs"}
            _keys(cf,required,{"userEditReason"})
            if pf["field"]!=cf["field"] or pf["finalValue"]!=cf["shownValueBefore"] or pf["riskReasons"]!=cf["riskReasons"] or pf["cropRefs"]!=cf["cropRefs"]: _trade_fail()
            name=pf["field"]; numeric=name in {"reqAmount","count","yield"}
            for value in (pf["normalizedValue"],pf["correctedValue"],pf["finalValue"],cf["shownValueBefore"],cf["finalValue"]):
                if value is not None and (numeric and type(value) is not int or not numeric and not isinstance(value,str)): _trade_fail("Projection field value has the wrong type.")
                if numeric and value is not None and value < (0 if name=="count" else 1): _trade_fail()
            if not isinstance(pf["candidates"],list) or type(pf["selectedCandidateIndex"]) is not int and pf["selectedCandidateIndex"] is not None: _trade_fail()
            if pf["selectedCandidateIndex"] is not None and not 0<=pf["selectedCandidateIndex"]<len(pf["candidates"]): _trade_fail()
            for candidate in pf["candidates"]:
                _keys(candidate,{"value","identity","reason"})
                if not isinstance(candidate["reason"],str) or not candidate["reason"]: _trade_fail()
            if pf["valueState"] not in {"RESOLVED","UNRESOLVED","CONFLICT","CLIPPED"}: _trade_fail()
            if pf["valueState"]=="CONFLICT" and (pf["finalValue"] is not None or pf["selectedCandidateIndex"] is not None): _trade_fail()
            for identity in [pf["identity"]]+[candidate.get("identity") for candidate in pf["candidates"] if isinstance(candidate,dict)]:
                if identity is None: continue
                _keys(identity,{"kind","stableId","legacyNameKey","authorityStatus"})
                if identity["kind"] not in {"ITEM","ISLAND"} or identity["stableId"] is not None and _uuid(identity["stableId"],"stableId")!=identity["stableId"] or identity["legacyNameKey"] is not None and (not isinstance(identity["legacyNameKey"],str) or not identity["legacyNameKey"]): _trade_fail()
                if identity["authorityStatus"] not in {"OPEN_WORLD","LEGACY_UNVERIFIED","VERIFIED_REFERENCE","VERIFIED_CURATED","DISPUTED","DEPRECATED"}: _trade_fail()
                if identity["authorityStatus"]=="OPEN_WORLD" and (name!="fromItem" or identity["stableId"] is not None or identity["legacyNameKey"] is not None): _trade_fail()
            if pf["identity"] is not None and numeric: _trade_fail()
            if not all(isinstance(pf[key],list) for key in ("rawEvidenceRefs","riskReasons","correctionReasons","alternatives","cropRefs","stageTrace")): _trade_fail()
            expected_raw_refs=[{"sourceRowId":sid,"field":name} for sid in group["memberSourceRowIds"]]
            if pf["rawEvidenceRefs"]!=expected_raw_refs: _trade_fail()
            expected_crop_refs=[]
            for sid in group["memberSourceRowIds"]:
                source_field=next(x for x in source_by_id[sid]["fields"] if x["field"]==name)
                for crop in source_field["cropRefs"]:
                    if crop["cropRefId"] not in expected_crop_refs: expected_crop_refs.append(crop["cropRefId"])
            if pf["cropRefs"]!=expected_crop_refs: _trade_fail("Projection crop references disagree with source evidence.")
            if any(not isinstance(x,str) or not x for x in pf["riskReasons"]+pf["correctionReasons"]): _trade_fail()
            for alternative in pf["alternatives"]:
                _keys(alternative,{"value","sourceRefs","riskReasons"})
                if not isinstance(alternative["sourceRefs"],list) or not isinstance(alternative["riskReasons"],list): _trade_fail()
            previous_stage=-1
            for trace in pf["stageTrace"]:
                _keys(trace,{"stage","ruleVersion","inputValue","outputValue","reason"})
                stage=_integer(trace["stage"],"stage",maximum=8)
                if stage<=previous_stage or not isinstance(trace["ruleVersion"],str) or not trace["ruleVersion"] or trace["reason"] is not None and not isinstance(trace["reason"],str): _trade_fail()
                previous_stage=stage
            decision=cf["operationalDecision"]
            if decision=="CANDIDATE_RETAINED":
                if cf["finalValue"]!=cf["shownValueBefore"]: _trade_fail()
            elif decision=="USER_EDITED":
                if cf["finalValue"] is None or cf["finalValue"]==cf["shownValueBefore"]: _trade_fail()
            elif decision=="USER_MARKED_UNKNOWN":
                if cf["finalValue"] is not None: _trade_fail()
            else: _trade_fail()
        if done["disposition"] not in {"INCLUDE","EXCLUDE","RECAPTURE_REQUIRED"}: _trade_fail()
        if done["disposition"]=="EXCLUDE" and (not isinstance(done["dispositionReason"],str) or not done["dispositionReason"].strip()) or done["disposition"]!="EXCLUDE" and done["dispositionReason"] is not None and not isinstance(done["dispositionReason"],str): _trade_fail()
    if set(row_ids)!=set(group_map): _trade_fail()
    edge_work_items=projection["edgeWorkItems"]
    if not isinstance(edge_work_items,list) or len(edge_work_items)!=len(edges) or not isinstance(completion["workItems"],list) or len(completion["workItems"])!=len(edges): _trade_fail()
    edge_item_ids=set(); completion_work={}
    for work in completion["workItems"]:
        _keys(work,{"workItemId","decision","reason"})
        if work["decision"] not in {"RECAPTURE_REQUIRED","EXPLICITLY_EXCLUDED"} or not isinstance(work["reason"],str) or not work["reason"] or work["workItemId"] in completion_work: _trade_fail()
        completion_work[work["workItemId"]]=work
    for item in edge_work_items:
        _keys(item,{"workItemId","edgeId","classification","reason","sourceRefs"})
        if item["classification"]!="NEEDS_RECAPTURE" or item["edgeId"] not in edge_ids or item["workItemId"] in edge_item_ids or not isinstance(item["reason"],str) or not item["reason"] or not isinstance(item["sourceRefs"],list): _trade_fail()
        edge_item_ids.add(item["workItemId"])
        done=completion_work.get(item["workItemId"])
        if done is None or done["decision"] not in {"RECAPTURE_REQUIRED","EXPLICITLY_EXCLUDED"}: _trade_fail()
    if edge_item_ids!=set(completion_work): _trade_fail()
    availability = projection["pixelAvailability"]
    if not isinstance(availability, list) or any(not isinstance(item, dict) or set(item)!={"cropRefId","state"} or item["cropRefId"] not in crops or item["state"] not in {"IN_MEMORY","DURABLE","MISSING","EXPIRED","INVALID"} for item in availability): _trade_fail()
    if len({item["cropRefId"] for item in availability}) != len(availability): _trade_fail()
    if [item["cropRefId"] for item in availability] != list(crops): _trade_fail("Pixel availability must preserve the raw crop reference order.")
    batch=completion["batchConfirmation"]
    _keys(batch,{"method","confirmedAt","projectionHash","reviewRevision","completionValuesHash"})
    if batch["method"]!="USER_FINAL_LIST_CONFIRMED" or batch["projectionHash"]!=projection["projectionHash"] or batch["reviewRevision"]!=review_revision or batch["completionValuesHash"]!=_v3_hash({k:v for k,v in completion.items() if k!="batchConfirmation"}): _trade_fail()
    projection_basis={k:v for k,v in projection.items() if k!="projectionHash"}
    if projection["projectionHash"]!=_v3_hash(projection_basis): _trade_fail("Projection hash mismatch.")
    if not isinstance(crop_plan,dict): _trade_fail()
    _keys(crop_plan,{"schemaVersion","policy","entries"})
    if crop_plan["schemaVersion"]!=3 or crop_plan["policy"]!="C2_LOGICAL_REPRESENTATIVE_V3" or not isinstance(crop_plan["entries"],list) or len(crop_plan["entries"])!=len(rows)*6: _trade_fail()
    crop_seen=set()
    for entry in crop_plan["entries"]:
        _keys(entry,{"projectionRowId","field","cropRefId","selected","reasons","retentionClass"})
        key=(entry["projectionRowId"],entry["field"])
        if key in crop_seen or entry["projectionRowId"] not in row_ids or entry["field"] not in TRADE_FIELDS or type(entry["selected"]) is not bool or not isinstance(entry["reasons"],list): _trade_fail()
        crop_seen.add(key)
        row=next(r for r in rows if r["projectionRowId"]==entry["projectionRowId"])
        field=next(f for f in row["fields"] if f["field"]==entry["field"])
        group=group_map[entry["projectionRowId"]]
        representative=source_by_id[group["representativeSourceRowId"]]
        source_field=next(f for f in representative["fields"] if f["field"]==entry["field"])
        expected_crop=source_field["cropRefs"][0]["cropRefId"] if source_field["cropRefs"] else None
        if entry["cropRefId"] != expected_crop: _trade_fail()
        reasons=[]
        completion_field=next(f for f in next(r for r in completion["rows"] if r["projectionRowId"]==entry["projectionRowId"])["fields"] if f["field"]==entry["field"])
        if completion_field["operationalDecision"]=="USER_EDITED": reasons.append("USER_EDITED")
        if completion_field["operationalDecision"]=="USER_MARKED_UNKNOWN": reasons.append("USER_MARKED_UNKNOWN")
        if field["riskReasons"]: reasons.append("RISKY_FIELD")
        selected=bool(reasons) and expected_crop is not None
        retention="NONE" if not selected else "UNKNOWN_EVIDENCE" if completion_field["operationalDecision"]=="USER_MARKED_UNKNOWN" else "OPERATIONAL_REVIEW_EVIDENCE"
        if entry["reasons"]!=reasons or entry["selected"]!=selected or entry["retentionClass"]!=retention: _trade_fail("Crop plan does not match completion decisions.")
    return payload


def _keys(value: dict[str, Any], required: set[str], optional: set[str] = frozenset()) -> None:
    keys = set(value)
    if not required <= keys or keys - required - optional:
        raise RecognitionContractError("invalid_contract", "The request contains missing or unsupported fields.")


def _integer(value: Any, label: str, *, minimum: int = 0, maximum: int = MAX_SAFE_INTEGER) -> int:
    if type(value) is not int or value < minimum or value > maximum:
        raise RecognitionContractError("invalid_contract", f"{label} must be an integer in range.")
    return value


def _finite_number(value: Any, label: str, *, minimum: float = 0.0, maximum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise RecognitionContractError("invalid_contract", f"{label} must be a finite number.")
    if value < minimum or (maximum is not None and value > maximum):
        raise RecognitionContractError("invalid_contract", f"{label} is outside the allowed range.")
    return float(value)


def _uuid(value: Any, label: str, *, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or len(value) > MAX_ID_LENGTH:
        raise RecognitionContractError("invalid_contract", f"{label} must be a UUID.")
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError):
        raise RecognitionContractError("invalid_contract", f"{label} must be a UUID.") from None


def _utc_timestamp(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 64:
        raise RecognitionContractError("invalid_contract", "capturedAt must be an ISO-8601 UTC timestamp.")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise RecognitionContractError("invalid_contract", "capturedAt must be an ISO-8601 UTC timestamp.") from None
    if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        raise RecognitionContractError("invalid_contract", "capturedAt must include a UTC offset.")
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def validate_capture_metadata(value: dict[str, Any], *, expected_task: str | None = None) -> dict[str, Any]:
    _keys(value, {"version", "captureId", "batchId", "taskType", "sourceType", "capturedAt", "frame",
                  "fidelity", "profileId", "profileVersion", "context", "observed"})
    if value["version"] != 1 or type(value["version"]) is not int:
        raise RecognitionContractError("unsupported_version", "Capture metadata version 1 is required.")
    task = value["taskType"]
    if not isinstance(task, str) or task not in TASK_TYPES or (expected_task and task != expected_task):
        raise RecognitionContractError("invalid_task_type", "The capture task type is not supported.")
    source = value["sourceType"]
    if not isinstance(source, str) or source not in SOURCE_TYPES:
        raise RecognitionContractError("invalid_source_type", "The capture source type is not supported.")

    frame = value["frame"]
    if not isinstance(frame, dict):
        raise RecognitionContractError("invalid_contract", "frame must be an object.")
    _keys(frame, {"width", "height"})
    width = _integer(frame["width"], "frame.width", minimum=1, maximum=MAX_IMAGE_PIXELS)
    height = _integer(frame["height"], "frame.height", minimum=1, maximum=MAX_IMAGE_PIXELS)
    if width * height > MAX_IMAGE_PIXELS:
        raise RecognitionContractError("image_too_large", "The image pixel limit was exceeded.", 413)

    fidelity = value["fidelity"]
    if not isinstance(fidelity, dict):
        raise RecognitionContractError("invalid_contract", "fidelity must be an object.")
    _keys(fidelity, {"sourceWidth", "sourceHeight", "rescaled", "evidence"})
    for key in ("sourceWidth", "sourceHeight"):
        if fidelity[key] is not None:
            _integer(fidelity[key], f"fidelity.{key}", minimum=1, maximum=MAX_IMAGE_PIXELS)
    if (fidelity["sourceWidth"] is None) != (fidelity["sourceHeight"] is None):
        raise RecognitionContractError("invalid_contract", "Source dimensions must both be known or both be null.")
    if fidelity["rescaled"] is not None and type(fidelity["rescaled"]) is not bool:
        raise RecognitionContractError("invalid_contract", "fidelity.rescaled must be boolean or null.")
    if not isinstance(fidelity["evidence"], str) or fidelity["evidence"] not in {"track-settings", "file-metadata", "user-observed", "unknown"}:
        raise RecognitionContractError("invalid_contract", "fidelity.evidence is not supported.")

    context = value["context"]
    if not isinstance(context, dict):
        raise RecognitionContractError("invalid_contract", "context must be an object.")
    _keys(context, {"baseRevision", "sessionId", "sessionRevision"})
    _integer(context["baseRevision"], "context.baseRevision")
    _uuid(context["sessionId"], "context.sessionId", nullable=True)
    if context["sessionRevision"] is not None:
        _integer(context["sessionRevision"], "context.sessionRevision")

    observed = value["observed"]
    if not isinstance(observed, dict):
        raise RecognitionContractError("invalid_contract", "observed must be an object.")
    _keys(observed, {"browserDpr", "windowsDpi", "gameResolution", "gameUiScale"})
    for key in ("browserDpr", "windowsDpi", "gameUiScale"):
        if observed[key] is not None:
            _finite_number(observed[key], f"observed.{key}", minimum=0.01, maximum=10000)
    resolution = observed["gameResolution"]
    if resolution is not None and (not isinstance(resolution, str) or len(resolution) > 64):
        raise RecognitionContractError("invalid_contract", "observed.gameResolution must be a short string or null.")

    profile_version = _integer(value["profileVersion"], "profileVersion", minimum=1)
    return {
        "version": 1,
        "captureId": _uuid(value["captureId"], "captureId"),
        "batchId": _uuid(value["batchId"], "batchId", nullable=True),
        "taskType": task,
        "sourceType": source,
        "capturedAt": _utc_timestamp(value["capturedAt"]),
        "frame": {"width": width, "height": height},
        "fidelity": fidelity,
        "profileId": _uuid(value["profileId"], "profileId", nullable=True),
        "profileVersion": profile_version,
        "context": context,
        "observed": observed,
    }


def validate_capture_payload(metadata_raw: str | bytes, image_bytes: bytes, *, content_type: str,
                             expected_task: str | None = None) -> tuple[dict[str, Any], int, int]:
    metadata = validate_capture_metadata(parse_json(metadata_raw, max_bytes=MAX_METADATA_BYTES, label="metadata"),
                                         expected_task=expected_task)
    if content_type.lower().split(";", 1)[0].strip() != "image/png":
        raise RecognitionContractError("unsupported_media_type", "A single PNG image is required.", 415)
    if not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES:
        status = 413 if len(image_bytes) > MAX_IMAGE_BYTES else 422
        code = "image_too_large" if status == 413 else "invalid_image"
        raise RecognitionContractError(code, "The PNG image is empty or exceeds the allowed size.", status)
    try:
        with Image.open(BytesIO(image_bytes)) as image:
            if image.format != "PNG" or getattr(image, "is_animated", False) or getattr(image, "n_frames", 1) != 1:
                raise RecognitionContractError("invalid_image", "A non-animated PNG image is required.")
            width, height = image.size
            if width < 1 or height < 1 or width * height > MAX_IMAGE_PIXELS:
                raise RecognitionContractError("image_too_large", "The image pixel limit was exceeded.", 413)
            image.verify()
        with Image.open(BytesIO(image_bytes)) as decoded:
            decoded.load()
    except RecognitionContractError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise RecognitionContractError("invalid_image", "The uploaded image is not a valid PNG.") from None
    if metadata["frame"] != {"width": width, "height": height}:
        raise RecognitionContractError("frame_mismatch", "Frame dimensions must match the decoded PNG.",
                                       details={"frame": metadata["frame"], "decodedFrame": {"width": width, "height": height}})
    return metadata, width, height


def validate_profile(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RecognitionContractError("invalid_profile", "Each profile must be an object.")
    _keys(value, {"version", "id", "profileVersion", "taskType", "sourceType", "referenceFrame", "region",
                  "anchorSetId", "anchorSetHash", "anchorOffsets", "canonicalGeometry", "observed", "verifiedStratumIds"})
    if value["version"] != 1 or type(value["version"]) is not int:
        raise RecognitionContractError("unsupported_version", "CaptureProfile version 1 is required.")
    profile_id = _uuid(value["id"], "profile.id")
    profile_version = _integer(value["profileVersion"], "profile.profileVersion", minimum=1)
    if (not isinstance(value["taskType"], str) or value["taskType"] not in TASK_TYPES
            or not isinstance(value["sourceType"], str) or value["sourceType"] not in SOURCE_TYPES):
        raise RecognitionContractError("invalid_profile", "Profile task/source type is not supported.")
    frame = value["referenceFrame"]
    if not isinstance(frame, dict):
        raise RecognitionContractError("invalid_profile", "referenceFrame must be an object.")
    _keys(frame, {"width", "height"})
    width = _integer(frame["width"], "referenceFrame.width", minimum=1)
    height = _integer(frame["height"], "referenceFrame.height", minimum=1)
    if width * height > MAX_IMAGE_PIXELS:
        raise RecognitionContractError("invalid_profile", "referenceFrame exceeds the pixel limit.")
    region = value["region"]
    if not isinstance(region, dict):
        raise RecognitionContractError("invalid_profile", "region must be an object.")
    _keys(region, {"x", "y", "w", "h"})
    coordinates = {key: _finite_number(region[key], f"region.{key}", minimum=0.0, maximum=1.0) for key in ("x", "y", "w", "h")}
    if coordinates["w"] <= 0 or coordinates["h"] <= 0 or coordinates["x"] + coordinates["w"] > 1 or coordinates["y"] + coordinates["h"] > 1:
        raise RecognitionContractError("invalid_profile", "region must fit within the normalized frame.")
    anchor_id = value["anchorSetId"]
    anchor_hash = value["anchorSetHash"]
    if not isinstance(anchor_id, str) or not anchor_id or len(anchor_id) > MAX_ID_LENGTH:
        raise RecognitionContractError("invalid_profile", "anchorSetId is invalid.")
    if not isinstance(anchor_hash, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", anchor_hash):
        raise RecognitionContractError("invalid_profile", "anchorSetHash must be SHA-256 hex.")
    for key in ("anchorOffsets", "canonicalGeometry", "observed"):
        if not isinstance(value[key], dict):
            raise RecognitionContractError("invalid_profile", f"{key} must be an object.")
    strata = value["verifiedStratumIds"]
    if not isinstance(strata, list) or len(strata) > 256 or any(not isinstance(item, str) or not item or len(item) > MAX_ID_LENGTH for item in strata):
        raise RecognitionContractError("invalid_profile", "verifiedStratumIds must be a bounded string list.")
    try:
        if len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")) > MAX_METADATA_BYTES:
            raise RecognitionContractError("metadata_too_large", "Profile metadata exceeds the allowed size.", 413)
    except (TypeError, ValueError):
        raise RecognitionContractError("invalid_profile", "Profile contains unsupported values.") from None
    return {**value, "id": profile_id, "profileVersion": profile_version,
            "referenceFrame": {"width": width, "height": height}, "region": coordinates}


def validate_config_update(value: dict[str, Any]) -> dict[str, Any]:
    _keys(value, {"version", "expectedConfigRevision", "flags", "profiles"})
    if value["version"] != 1 or type(value["version"]) is not int:
        raise RecognitionContractError("unsupported_version", "Recognition config version 1 is required.")
    revision = _integer(value["expectedConfigRevision"], "expectedConfigRevision")
    flags = value["flags"]
    if not isinstance(flags, dict):
        raise RecognitionContractError("invalid_contract", "flags must be an object.")
    _keys(flags, UNSUPPORTED_FLAGS)
    if any(type(enabled) is not bool for enabled in flags.values()):
        raise RecognitionContractError("invalid_contract", "Feature flags must be booleans.")
    if any(flags.values()):
        raise RecognitionContractError("unsupported_feature", "Recognition engines, capture, remote fallback, debug capture, and auto-apply are not enabled in this task.", 422)
    profiles = value["profiles"]
    if not isinstance(profiles, list) or len(profiles) > 64:
        raise RecognitionContractError("invalid_contract", "profiles must be a bounded list.")
    validated_profiles = [validate_profile(profile) for profile in profiles]
    ids = [profile["id"] for profile in validated_profiles]
    if len(ids) != len(set(ids)):
        raise RecognitionContractError("invalid_profile", "Profile IDs must be unique.")
    return {"expectedConfigRevision": revision, "flags": dict(flags), "profiles": validated_profiles}


def validate_feedback_payload(value: dict[str, Any]) -> dict[str, Any]:
    _keys(value, {"version", "labelMutationId", "rows"})
    if value["version"] != 1 or type(value["version"]) is not int:
        raise RecognitionContractError("unsupported_version", "Feedback version 1 is required.")
    mutation_id = _uuid(value["labelMutationId"], "labelMutationId")
    rows = value["rows"]
    if not isinstance(rows, list) or not rows or len(rows) > 63:
        raise RecognitionContractError("invalid_contract", "rows must contain between 1 and 63 labels.")
    seen_units: set[str] = set()
    normalized_rows = []
    for row in rows:
        if not isinstance(row, dict):
            raise RecognitionContractError("invalid_contract", "Each label row must be an object.")
        _keys(row, {"unitId", "fields"})
        unit = row["unitId"]
        fields = row["fields"]
        if not isinstance(unit, str) or not unit or len(unit) > MAX_ID_LENGTH or unit in seen_units:
            raise RecognitionContractError("invalid_contract", "unitId must be unique and bounded.")
        seen_units.add(unit)
        if not isinstance(fields, dict) or not fields or set(fields) - {"item", "quantity"}:
            raise RecognitionContractError("invalid_contract", "Each row needs supported item or quantity fields.")
        clean_fields = {}
        for field_name, label in fields.items():
            if not isinstance(label, dict):
                raise RecognitionContractError("invalid_contract", "Each field label must be an object.")
            _keys(label, {"value", "verification", "reason"})
            if label["verification"] != "explicit":
                raise RecognitionContractError("invalid_contract", "Only explicit human confirmations are accepted.")
            reason = label["reason"]
            if reason is not None and (not isinstance(reason, str) or len(reason) > 256):
                raise RecognitionContractError("invalid_contract", "Label reason must be a short string or null.")
            label_value = label["value"]
            if field_name == "item" and (not isinstance(label_value, str) or not label_value or len(label_value) > 128):
                raise RecognitionContractError("invalid_contract", "Item labels must be non-empty bounded strings.")
            if field_name == "quantity":
                _integer(label_value, "quantity label", minimum=0)
            clean_fields[field_name] = {"value": label_value, "verification": "explicit", "reason": reason}
        normalized_rows.append({"unitId": unit, "fields": clean_fields})
    return {"version": 1, "labelMutationId": mutation_id, "rows": normalized_rows}
