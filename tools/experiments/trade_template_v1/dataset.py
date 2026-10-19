from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from PIL import Image

from .contracts import canonical_bytes, hash_file, sha256_bytes, write_json


def _jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
    temporary.replace(path)


def _decoded_hash(image: Image.Image) -> str:
    rgb = image.convert("RGB")
    return hashlib.sha256(f"{rgb.width}x{rgb.height}:".encode() + rgb.tobytes()).hexdigest()


def _normalize_name(value: Any) -> str:
    text = unicodedata.normalize("NFC", str(value or ""))
    text = re.sub(r"^\s*[\[|]?\s*[1-7]\s*(?:단계|[가-힣]{1,3}[\]|!]?)\s*", "", text)
    return re.sub(r"\s+", "", text)


def _iter_index(path: Path):
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list):
        raise ValueError(f"capture index must be a list: {path.name}")
    yield from value


def collect_dataset(manifest: dict[str, Any], roots: dict[str, Path], run_root: Path,
                    legacy_module, catalog: dict[str, Any]) -> dict[str, Any]:
    """Stream only manifest-pinned artifacts and emit auditable, deduplicated evidence."""
    data_root = run_root / "data"
    png_root = data_root / "png"
    png_root.mkdir(parents=True, exist_ok=True)
    artifact = roots["artifactRoot"]
    prep = roots["preparationRoot"]
    images: dict[str, dict[str, Any]] = {}
    decoded_owner: dict[str, str] = {}
    truths: list[dict[str, Any]] = []
    quarantined: list[dict[str, Any]] = []
    source_counts: Counter[str] = Counter()
    source_image_sets: defaultdict[str, set[str]] = defaultdict(set)
    all_memberships: list[dict[str, Any]] = []
    item_stages = {name: int(stage) for stage, names in catalog["masterData"].items()
                   for name in names if str(stage).isdigit()}
    item_stages.update({name: "coin" if "까마귀" in name else "special" for name in catalog.get("specialItems", [])})
    item_names = set(item_stages)
    island_names = set(catalog.get("islands", []) + catalog.get("t6Islands", []) + catalog.get("t7Islands", []))

    def add_image(payload: bytes, metadata: dict[str, Any], membership: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        image_sha = hashlib.sha256(payload).hexdigest()
        if image_sha not in images:
            import io
            with Image.open(io.BytesIO(payload)) as source:
                image = source.convert("RGB")
                decoded_sha = _decoded_hash(image)
                width, height = image.size
            path = png_root / f"{image_sha}.png"
            temporary = path.with_suffix(".png.tmp")
            temporary.write_bytes(payload)
            temporary.replace(path)
            images[image_sha] = {"imageSha256": image_sha, "decodedImageSha256": decoded_sha,
                                 "width": width, "height": height, "path": path.name,
                                 "metadata": metadata, "memberships": []}
            decoded_owner.setdefault(decoded_sha, image_sha)
        images[image_sha]["memberships"].append(membership)
        source_id = membership.get("sourceId", "unknown")
        source_counts[source_id] += 1
        source_image_sets[source_id].add(image_sha)
        all_memberships.append({"imageSha256": image_sha, **membership})
        return image_sha, images[image_sha]

    def field_truth(image_sha: str, rec: dict[str, Any], field: str, value: Any, truth_class: str,
                    evidence: dict[str, Any], scope: str = "THIS_FIELD_ONLY") -> None:
        if field not in {"island", "fromItem", "toItem", "reqAmount", "yield", "count"}:
            quarantined.append({"imageSha256": image_sha, "reason": "UNKNOWN_FIELD", "field": field})
            return
        if value is None or value == "" or isinstance(value, bool):
            quarantined.append({"imageSha256": image_sha, "reason": "EMPTY_OR_INVALID_VALUE", "field": field})
            return
        if field in {"reqAmount", "yield", "count"}:
            if type(value) is not int or value < 0 or (field in {"reqAmount", "yield"} and value == 0):
                quarantined.append({"imageSha256": image_sha, "reason": "INVALID_NUMERIC_TRUTH", "field": field,
                                    "value": value})
                return
        elif not isinstance(value, str) or not value.strip():
            quarantined.append({"imageSha256": image_sha, "reason": "INVALID_NAME_TRUTH", "field": field})
            return
        rec.setdefault("truthCandidates", []).append({"field": field, "value": value, "truthClass": truth_class,
                                                       "sourceEvidence": [evidence], "scope": scope})

    # The two fixed capture indexes contain the only path-based native inputs.
    index_by_id: dict[tuple[str, str], str] = {}
    stored_rows: dict[str, list[dict[str, Any]]] = {}
    for source in manifest["dataSources"]:
        if source["id"] not in {"native77-capture-index", "latest15-capture-index"}:
            continue
        index_path = artifact / source["path"]
        for position, entry in enumerate(_iter_index(index_path)):
            image_path = Path(entry["imagePath"])
            if not image_path.is_file():
                quarantined.append({"sourceId": source["id"], "entryIndex": position,
                                    "reason": "IMAGE_MISSING", "path": str(image_path)})
                continue
            payload = image_path.read_bytes()
            if len(payload) == 0:
                quarantined.append({"sourceId": source["id"], "entryIndex": position, "reason": "IMAGE_EMPTY"})
                continue
            membership = {"sourceId": source["id"], "entryIndex": position,
                          "captureId": entry.get("captureId"), "batchId": entry.get("stored", {}).get("batchId"),
                          "capturedAt": entry.get("metadata", {}).get("capturedAt"),
                          "phase": entry.get("stored", {}).get("phase"),
                          "workerVersion": entry.get("stored", {}).get("runtime", {}).get("workerVersion")}
            image_sha, rec = add_image(payload, entry.get("metadata", {}), membership)
            if entry.get("sha256") and entry["sha256"] != image_sha:
                raise ValueError(f"capture index image hash mismatch: {source['id']}[{position}]")
            index_by_id[(source["id"], str(entry.get("captureId")))] = image_sha
            stored_rows.setdefault(image_sha, []).extend(entry.get("stored", {}).get("rows", []))
            # Only explicit per-field review confirmations are truth.
            for row in entry.get("stored", {}).get("rows", []):
                for field, result in row.get("fields", {}).items():
                    if (isinstance(result, dict) and result.get("valueSource") == "USER_REVIEW"
                            and result.get("reviewRequired") is False and row.get("excluded") is not True):
                        field_truth(image_sha, rec, field, result.get("corrected"), "USER_CONFIRMED_FIELD",
                                    {"sourceId": source["id"], "captureId": entry.get("captureId"),
                                     "entryIndex": position, "ordinal": row.get("ordinal"),
                                     "rowBox": row.get("rowBox"), "valueSource": "USER_REVIEW",
                                     "rawOCR": result.get("rawOCR", ""), "confidence": result.get("confidence")})

    # Frozen legacy oracle is evaluation-only and never used for the current-size bank.
    fixture_root = prep / "baseline-source" / "_dev" / "local_app" / "tests" / "fixtures" / "trade-recognition"
    oracle_path = fixture_root / "정답.json"
    mapping_path = fixture_root / "live-list-mapping.json"
    oracle = json.loads(oracle_path.read_text(encoding="utf-8"))
    mappings = json.loads(mapping_path.read_text(encoding="utf-8"))
    oracle_values = {index: row for index, row in enumerate(oracle)}
    for mapping in mappings:
        image_path = fixture_root / mapping["image"]
        payload = image_path.read_bytes()
        image_sha, rec = add_image(payload, {"sourceType": "legacy-oracle", "rescaled": None},
                                   {"sourceId": "legacy-oracle", "captureId": mapping["captureId"],
                                    "legacyOracle": True, "oracleRows": mapping["oracleRows"]})
        expected = [oracle_values.get(index) for index in mapping.get("oracleRows", [])]
        import io
        with Image.open(io.BytesIO(payload)) as image:
            detected = legacy_module.detect_live_rows(image.convert("RGB"))
        if len(detected) != len(expected):
            quarantined.append({"imageSha256": image_sha, "reason": "LEGACY_ORACLE_ROW_COUNT_MISMATCH",
                                "expectedRows": len(expected), "detectedRows": len(detected)})
            continue
        for ordinal, truth_row in enumerate(expected):
            if not isinstance(truth_row, dict):
                continue
            row_box = {"x": 0, "y": detected[ordinal][0], "width": rec["width"],
                       "height": detected[ordinal][1] - detected[ordinal][0]}
            for field, value in truth_row.items():
                field_truth(image_sha, rec, field, value, "EXISTING_ORACLE",
                            {"sourceId": "legacy-oracle", "captureId": mapping["captureId"],
                             "ordinal": ordinal, "rowBox": row_box})

    # Stream correction BLOBs from the pinned read-only databases; never load the DB into memory.
    correction_count = 0
    warehouse_records_audited = 0
    for source in manifest["dataSources"]:
        if source["id"] not in {"history-before-cleanup", "recent-before-fixed-roi"}:
            continue
        db_path = artifact / source["path"]
        connection = sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        try:
            try:
                warehouse_records_audited += int(connection.execute("SELECT COUNT(*) FROM warehouse_scan").fetchone()[0])
            except sqlite3.Error:
                pass
            cursor = connection.execute("SELECT feedback_id,capture_id,created_at,image_png,details_json FROM trade_correction ORDER BY created_at")
            while True:
                batch = cursor.fetchmany(32)
                if not batch:
                    break
                for row in batch:
                    correction_count += 1
                    try:
                        details = json.loads(row["details_json"])
                        payload = row["image_png"]
                        metadata = details.get("metadata", {})
                        corrections = details.get("corrections", [])
                        membership = {"sourceId": source["id"], "feedbackId": row["feedback_id"],
                                      "captureId": row["capture_id"], "batchId": metadata.get("batchId"),
                                      "createdAt": row["created_at"], "phase": details.get("phase"),
                                      "workerVersion": details.get("workerVersion") or metadata.get("workerVersion")}
                        image_sha, rec = add_image(payload, metadata, membership)
                        for entry_index, correction in enumerate(corrections):
                            field_truth(image_sha, rec, str(correction.get("field", "")),
                                        correction.get("finalValue"), "USER_CORRECTION",
                                        {"sourceId": source["id"], "feedbackId": row["feedback_id"],
                                         "captureId": row["capture_id"], "entryIndex": entry_index,
                                         "ordinal": correction.get("ordinal"), "rowBox": correction.get("rowBox"),
                                         "rawOCR": correction.get("rawOCR"),
                                         "automaticCorrected": correction.get("automaticCorrected")})
                    except Exception as error:
                        quarantined.append({"sourceId": source["id"], "feedbackId": row["feedback_id"],
                                            "reason": "CORRECTION_RECORD_INVALID", "error": type(error).__name__})
        finally:
            connection.close()

    # Consolidate labels by decoded image + row identity + field. Conflicting confirmed values are quarantined.
    grouped_truth: defaultdict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for image_sha, rec in images.items():
        for candidate in rec.pop("truthCandidates", []):
            evidence = candidate["sourceEvidence"][0]
            row_box = evidence.get("rowBox") or {}
            row_key = f"{row_box.get('x', 0)}:{row_box.get('y')}:{row_box.get('width')}:{row_box.get('height')}"
            if row_box.get("y") is None:
                row_key = f"ordinal:{evidence.get('ordinal')}"
            grouped_truth[(rec["decodedImageSha256"], row_key, candidate["field"])].append(
                {**candidate, "imageSha256": image_sha, "decodedImageSha256": rec["decodedImageSha256"],
                 "rowBox": row_box, "evidence": evidence})
    for (decoded_sha, row_key, field), candidates in grouped_truth.items():
        values: dict[bytes, Any] = {canonical_bytes(candidate["value"]): candidate["value"] for candidate in candidates}
        if len(values) != 1:
            quarantined.append({"decodedImageSha256": decoded_sha, "rowKey": row_key, "field": field,
                                "reason": "CONFLICTING_CONFIRMED_VALUES", "values": list(values.values()),
                                "sourceEvidence": [x["evidence"] for x in candidates]})
            continue
        candidates.sort(key=lambda x: ({"USER_CORRECTION": 0, "USER_CONFIRMED_FIELD": 1, "EXISTING_ORACLE": 2}.get(x["truthClass"], 9),
                                       x["imageSha256"], canonical_bytes(x["evidence"])))
        winner = candidates[0]
        truth = {"imageSha256": winner["imageSha256"], "decodedImageSha256": decoded_sha,
                 "rowBox": winner["rowBox"], "field": field, "value": winner["value"],
                 "truthClass": winner["truthClass"], "sourceEvidence": [x["evidence"] for x in candidates],
                 "scope": "THIS_FIELD_ONLY"}
        truth["truthId"] = sha256_bytes(canonical_bytes(truth))
        truths.append(truth)

    # Stable connected groups from capture/batch membership and pixel identity.
    parent: dict[str, str] = {}
    def find(key: str) -> str:
        parent.setdefault(key, key)
        if parent[key] != key:
            parent[key] = find(parent[key])
        return parent[key]
    def union(a: str, b: str) -> None:
        left, right = find(a), find(b)
        if left != right:
            parent[max(left, right)] = min(left, right)
    image_ids = list(images)
    by_decoded: defaultdict[str, list[str]] = defaultdict(list)
    by_capture: defaultdict[str, list[str]] = defaultdict(list)
    by_batch: defaultdict[str, list[str]] = defaultdict(list)
    for image_sha, record in images.items():
        by_decoded[record["decodedImageSha256"]].append(image_sha)
        for membership in record["memberships"]:
            if membership.get("captureId"):
                by_capture[str(membership["captureId"])].append(image_sha)
            if membership.get("batchId"):
                by_batch[str(membership["batchId"])].append(image_sha)
    for group in list(by_decoded.values()) + list(by_capture.values()) + list(by_batch.values()):
        for image_sha in group[1:]:
            union(group[0], image_sha)
    components: defaultdict[str, list[str]] = defaultdict(list)
    for image_sha in image_ids:
        components[find(image_sha)].append(image_sha)
    split = {"groups": [], "imageRoles": {}}
    config = json.loads((Path(__file__).resolve().parents[3] / "docs" / "archive" / "specs" / "trade-template-v1" / "experiment-config.json").read_text(encoding="utf-8"))
    salt = config["data"]["splitHashSalt"]
    latest_hashes = {image_sha for (source_id, capture_id), image_sha in index_by_id.items()
                     if source_id == "latest15-capture-index"}
    legacy_hashes = {image_sha for image_sha, record in images.items()
                     if any(membership.get("legacyOracle") for membership in record["memberships"])}
    import hashlib as _hashlib
    for member_images in components.values():
        decoded_hashes = sorted({images[value]["decodedImageSha256"] for value in member_images})
        group_id = sha256_bytes("\n".join(decoded_hashes).encode())
        bucket = int(_hashlib.sha256(f"{salt}:{group_id}".encode()).hexdigest(), 16) % 10
        role = "ENROLL" if bucket in config["data"]["enrollBuckets"] else "CALIBRATION" if bucket in config["data"]["calibrationBuckets"] else "TEST"
        if any(value in legacy_hashes for value in member_images):
            role = "LEGACY_EVAL"
        elif any(value in latest_hashes for value in member_images):
            role = "TEST_LOCKED"
        split["groups"].append({"groupId": group_id, "images": sorted(member_images), "decodedHashes": decoded_hashes,
                                "bucket": bucket, "role": role})
        for value in member_images:
            split["imageRoles"][value] = role
    group_for_image = {image_sha: group["groupId"] for group in split["groups"] for image_sha in group["images"]}

    for truth in truths:
        truth["splitRole"] = split["imageRoles"].get(truth["imageSha256"], "UNASSIGNED")
        truth["sourceGroupId"] = group_for_image.get(truth["imageSha256"])
    source_inventory = []
    for source in manifest["dataSources"]:
        source_inventory.append({"sourceId": source["id"], "recordCount": source_counts[source["id"]],
                                 "uniqueImageCount": len(source_image_sets[source["id"]]),
                                 "pinnedBytes": source["bytes"], "sha256": source["sha256"]})
    summary = {"schemaVersion": 1, "sourceRecordCount": correction_count + sum(1 for x in all_memberships if x.get("sourceId") in {"native77-capture-index", "latest15-capture-index"}),
               "uniqueImages": len(images), "decodedImageGroups": len(by_decoded), "truthFieldCount": len(truths),
               "quarantinedFieldCount": len(quarantined), "sourceInventory": source_inventory,
               "splitGroupCounts": dict(Counter(group["role"] for group in split["groups"])),
               "coverageByKind": {}, "correctionRecordsRead": correction_count,
               "warehouseRecordsAuditedOnly": warehouse_records_audited,
               "truthCountsByClass": dict(Counter(truth["truthClass"] for truth in truths)),
               "excludedLegacyOracleRows": sum(1 for t in truths if t["truthClass"] == "EXISTING_ORACLE")}
    _jsonl(data_root / "captures.jsonl", list(images.values()))
    _jsonl(data_root / "truth.jsonl", truths)
    _jsonl(data_root / "quarantine.jsonl", quarantined)
    write_json(data_root / "split.json", split)
    write_json(data_root / "inventory.json", summary)
    # Small human-readable summary deliberately omits private absolute input paths.
    (data_root / "data-summary.md").write_text(
        "# 기준 자료 요약\n\n" + f"- 원본 출처 레코드: {summary['sourceRecordCount']}\n"
        + f"- 원본 PNG 고유 수: {summary['uniqueImages']}\n- 필드 정답 수: {summary['truthFieldCount']}\n"
        + f"- 격리 항목 수: {summary['quarantinedFieldCount']}\n- 그룹 분할: {json.dumps(summary['splitGroupCounts'], ensure_ascii=False)}\n",
        encoding="utf-8")
    return {**summary, "images": list(images.values()), "truths": truths, "split": split,
            "quarantine": quarantined, "storedRows": stored_rows}
