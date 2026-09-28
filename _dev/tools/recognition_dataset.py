#!/usr/bin/env python3
"""Export verified legacy warehouse feedback from a read-only SQLite snapshot."""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any, Iterator

from PIL import Image


CHECKED_FIELDS = {
    # Four-way labels compare the final item and quantity with both original
    # predictions; the name describes which comparison matched, not which
    # field was verified.
    "item_only": (True, True),
    "quantity_only": (True, True),
    "both_match": (True, True),
    "both_different": (True, True),
}
REVIEW_DECISIONS = {"ICON_MATCH_UNKNOWN", "QUANTITY_UNKNOWN", "DUPLICATE_ITEM_DETECTED"}
REVIEW_DECISIONS = {"ICON_MATCH_UNKNOWN", "QUANTITY_UNKNOWN", "DUPLICATE_ITEM_DETECTED"}


@dataclass(frozen=True)
class RecognitionSample:
    """One immutable field-level sample plus local-only image artifact bytes."""

    sample: dict[str, Any]
    source_png: bytes
    crop_png: bytes | None


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _read_json(raw: str | bytes, where: str) -> Any:
    try:
        return json.loads(raw)
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid JSON in {where}: {error}") from error


def _readonly_uri(path: Path) -> str:
    return path.resolve().as_uri() + "?mode=ro"


def _explicit_labels(feedback_rows: list[dict[str, Any]]) -> dict[str, dict[str, list[dict[str, Any]]]]:
    labels: dict[str, dict[str, list[dict[str, Any]]]] = {}
    for feedback in feedback_rows:
        body = _read_json(feedback["feedback_json"], "warehouse_feedback.feedback_json")
        rows = body.get("rows") if isinstance(body, dict) else None
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("slot"), str) or row.get("excluded") is True:
                continue
            fields = labels.setdefault(row["slot"], {"item": [], "quantity": []})
            agreement = row.get("agreement")
            if agreement in CHECKED_FIELDS:
                item_verified, quantity_verified = CHECKED_FIELDS[agreement]
                if item_verified and isinstance(row.get("name"), str):
                    fields["item"].append({"value": row["name"], "source": "four_way_feedback_v2",
                                            "mutationId": feedback["mutation_id"], "createdAt": feedback["created_at"]})
                if quantity_verified and type(row.get("quantity")) is int:
                    fields["quantity"].append({"value": row["quantity"], "source": "four_way_feedback_v2",
                                                "mutationId": feedback["mutation_id"], "createdAt": feedback["created_at"]})
                continue
            if row.get("itemCheck") in {"match", "different"} and isinstance(row.get("name"), str):
                fields["item"].append({"value": row["name"], "source": "legacy_item_check",
                                        "mutationId": feedback["mutation_id"], "createdAt": feedback["created_at"]})
    return labels


def _field_truth(evidence: list[dict[str, Any]]) -> dict[str, Any]:
    if not evidence:
        return {"status": "UNVERIFIED", "value": None, "verified": False,
                "reason": "NO_EXPLICIT_HUMAN_LABEL", "evidence": []}
    canonical = {json.dumps(entry["value"], ensure_ascii=False, sort_keys=True) for entry in evidence}
    if len(canonical) > 1:
        return {"status": "DISPUTED", "value": None, "verified": False,
                "reason": "CONFLICTING_HUMAN_LABELS", "evidence": evidence}
    return {"status": "VALUE", "value": evidence[0]["value"], "verified": True,
            "reason": None, "evidence": evidence}


def _decision_label(slot: dict[str, Any], truth: dict[str, Any]) -> str:
    decision = slot.get("decision")
    item = truth["item"]
    quantity = truth["quantity"]
    predicted_item = (slot.get("finalItem") or slot.get("bestCandidate")) if decision == "MATCH" else slot.get("bestCandidate")
    predicted_quantity = (slot.get("quantity") or {}).get("value") if isinstance(slot.get("quantity"), dict) else None
    item_known = item["verified"]
    quantity_known = quantity["verified"]
    item_exact = item_known and predicted_item == item["value"]
    quantity_exact = quantity_known and type(predicted_quantity) is int and predicted_quantity == quantity["value"]
    if decision == "MATCH":
        if item_known and not item_exact:
            return "WRONG_ACCEPTED"
        if quantity_known and not quantity_exact:
            return "WRONG_ACCEPTED"
        if item_known and quantity_known:
            return "CORRECT_ACCEPTED"
        return "UNVERIFIED_ACCEPTED"
    if decision in REVIEW_DECISIONS:
        if item_exact and quantity_exact:
            return "CORRECT_REVIEW"
        if item_known and quantity_known and predicted_item is not None and type(predicted_quantity) is int:
            return "WRONG_REVIEW"
        return "UNKNOWN_REVIEW"
    return "UNKNOWN"


def export_legacy_feedback(readonly_db: str | Path) -> Iterator[RecognitionSample]:
    """Yield samples from a copied database; SQLite is opened with mode=ro."""
    database = Path(readonly_db)
    if not database.is_file():
        raise FileNotFoundError(f"read-only snapshot not found: {database}")
    with closing(sqlite3.connect(_readonly_uri(database), uri=True)) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only = ON")
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"warehouse_scan", "warehouse_feedback"}.issubset(tables):
            raise ValueError("snapshot is missing warehouse_scan or warehouse_feedback")
        records = connection.execute(
            "SELECT scan_id, created_at, image_png, report_json, provenance_json "
            "FROM warehouse_scan WHERE scan_id IN (SELECT DISTINCT scan_id FROM warehouse_feedback) "
            "ORDER BY created_at, scan_id"
        ).fetchall()
        labels_by_hash: dict[str, dict[str, dict[str, list[dict[str, Any]]]]] = {}
        record_hash: dict[str, str] = {}
        records_by_hash: dict[str, list[str]] = {}
        reports_by_scan: dict[str, dict[str, Any]] = {}
        provenance_by_scan: dict[str, dict[str, Any]] = {}
        predictions_by_hash_slot: dict[str, dict[str, list[dict[str, Any]]]] = {}
        for record in records:
            source_hash = sha256_bytes(bytes(record["image_png"]))
            feedback_rows = [dict(row) for row in connection.execute(
                "SELECT mutation_id, created_at, feedback_json FROM warehouse_feedback "
                "WHERE scan_id = ? ORDER BY created_at, mutation_id", (record["scan_id"],))]
            record_hash[record["scan_id"]] = source_hash
            records_by_hash.setdefault(source_hash, []).append(record["scan_id"])
            report = _read_json(record["report_json"], "warehouse_scan.report_json")
            provenance = _read_json(record["provenance_json"], "warehouse_scan.provenance_json")
            reports_by_scan[record["scan_id"]] = report
            provenance_by_scan[record["scan_id"]] = provenance
            prediction_slots = predictions_by_hash_slot.setdefault(source_hash, {})
            for output_slot in report.get("slots", []):
                output_slot_id = output_slot.get("slot")
                if isinstance(output_slot_id, str):
                    prediction_slots.setdefault(output_slot_id, []).append({
                        "scanId": record["scan_id"], "timestamp": record["created_at"], "slot": output_slot,
                        "provenance": provenance, "slotWidth": (report.get("grid") or {}).get("slotWidth"),
                    })
            combined = labels_by_hash.setdefault(source_hash, {})
            for slot_id, fields in _explicit_labels(feedback_rows).items():
                target = combined.setdefault(slot_id, {"item": [], "quantity": []})
                target["item"].extend(fields["item"])
                target["quantity"].extend(fields["quantity"])
        seen_source_hashes: set[str] = set()
        for record in records:
            image_bytes = bytes(record["image_png"])
            source_hash = record_hash[record["scan_id"]]
            if source_hash in seen_source_hashes:
                continue
            seen_source_hashes.add(source_hash)
            report = reports_by_scan[record["scan_id"]]
            provenance = provenance_by_scan[record["scan_id"]]
            labels_by_slot = labels_by_hash[source_hash]
            image = Image.open(BytesIO(image_bytes)).convert("RGB")
            for slot in report.get("slots", []):
                slot_id = slot.get("slot")
                if not isinstance(slot_id, str):
                    continue
                observations = predictions_by_hash_slot.get(source_hash, {}).get(slot_id, [])
                signatures = {_prediction_signature(observation["slot"]) for observation in observations}
                prediction_consistent = len(signatures) <= 1
                prediction_observations = [_prediction_observation(observation) for observation in observations]
                crop_width = observations[0]["slotWidth"] if observations else None
                truth = {
                    "item": _field_truth(labels_by_slot.get(slot_id, {}).get("item", [])),
                    "quantity": _field_truth(labels_by_slot.get(slot_id, {}).get("quantity", [])),
                }
                crop_bytes = None
                crop_hash = None
                artifact_missing = []
                if (type(slot.get("x")) is int and type(slot.get("y")) is int and type(crop_width) is int
                        and crop_width > 0):
                    buffer = BytesIO()
                    image.crop((slot["x"], slot["y"], slot["x"] + crop_width, slot["y"] + crop_width)).save(buffer, format="PNG")
                    crop_bytes = buffer.getvalue()
                    crop_hash = sha256_bytes(crop_bytes)
                else:
                    artifact_missing.append("SLOT_CROP_COORDINATES_UNAVAILABLE")
                label_status = "DISPUTED" if any(value["status"] == "DISPUTED" for value in truth.values()) else (
                    "HUMAN_VERIFIED" if any(value["verified"] for value in truth.values()) else "UNVERIFIED")
                sample_id = sha256_bytes(f"{source_hash}\0{slot_id}".encode("utf-8"))
                source_scan_ids = records_by_hash[source_hash]
                quantity_prediction = (slot.get("quantity") or {}) if prediction_consistent else {}
                sample = {
                    "version": 1,
                    "sampleId": sample_id,
                    "captureId": f"capture:{source_hash}",
                    "sourceScanId": source_scan_ids[0],
                    "sourceScanIds": source_scan_ids,
                    "timestamp": record["created_at"],
                    "taskType": "warehouse",
                    "unitId": slot_id,
                    "sourceType": "legacy_feedback_v1",
                    "sourceImageHash": source_hash,
                    "inputImageHash": source_hash,
                    "cropHash": crop_hash,
                    "captureProfile": provenance.get("captureProfile") if prediction_consistent else None,
                    "engineVersion": provenance.get("engineVersion") if prediction_consistent else None,
                    "engineHash": provenance.get("engineHash") if prediction_consistent else None,
                    "modelVersion": provenance.get("modelVersion") if prediction_consistent else None,
                    "modelHashes": (provenance.get("modelHashes") or {}) if prediction_consistent else {},
                    "parameterHash": provenance.get("parameterHash") if prediction_consistent else None,
                    "profileHash": provenance.get("profileHash") if prediction_consistent else None,
                    "policyHash": provenance.get("policyHash") if prediction_consistent else None,
                    "predictedValue": {
                        "item": slot.get("bestCandidate") if prediction_consistent else None,
                        "acceptedItem": slot.get("finalItem") if prediction_consistent else None,
                        "itemId": slot.get("bestItemId") if prediction_consistent else None,
                        "quantity": quantity_prediction.get("value"),
                        "quantityStatus": quantity_prediction.get("status"),
                    },
                    "candidateValues": {
                        "item": ([candidate for candidate in (
                            {"programName": slot.get("bestCandidate"), "itemId": slot.get("bestItemId"),
                             "score": slot.get("bestScore"), "rank": 1} if slot.get("bestCandidate") is not None else None,
                            {"programName": slot.get("secondCandidate"), "score": slot.get("secondScore"), "rank": 2}
                            if slot.get("secondCandidate") is not None else None) if candidate is not None]
                            if prediction_consistent else []),
                        "quantity": quantity_prediction.get("value"),
                    },
                    "confidence": ({key: slot.get(key) for key in ("bestScore", "secondScore", "scoreGap") if key in slot}
                                   if prediction_consistent else {}),
                    "decision": slot.get("decision") if prediction_consistent else None,
                    "reasonCodes": ((slot.get("reasonCodes") or ([slot.get("decision")] if slot.get("decision") in REVIEW_DECISIONS else []))
                                    if prediction_consistent else ["PREDICTION_CONFLICT_ACROSS_IDENTICAL_SOURCE"]),
                    "predictionConsistent": prediction_consistent,
                    "predictionObservations": prediction_observations,
                    "decisionClassification": _decision_label(slot, truth) if prediction_consistent else "UNKNOWN",
                    "finalValue": {key: value["value"] if value["verified"] else None for key, value in truth.items()},
                    "fieldTruth": truth,
                    "corrected": any(value["verified"] and value["value"] != sample_prediction(slot, key)
                                     for key, value in truth.items()) if prediction_consistent else False,
                    "correctionReason": None,
                    "processingTimeMs": provenance.get("processingTimeMs"),
                    "labelStatus": label_status,
                    "labelSource": "legacy_feedback_v1",
                    "verifiedFields": [key for key, value in truth.items() if value["verified"]],
                    "groupId": f"source:{source_hash}",
                    "split": "replay",
                    "artifactRefs": {
                        "sourceImage": f"artifacts/source/{source_hash}.png",
                        "crop": f"artifacts/crop/{crop_hash}.png" if crop_hash else None,
                    },
                    "artifactMissingReasons": artifact_missing,
                    "replayStatus": ("PREDICTION_CONFLICT" if not prediction_consistent else
                                     "REPLAYABLE" if crop_bytes else "PARTIAL_LAYOUT"),
                    "auditSelection": None,
                }
                yield RecognitionSample(sample, image_bytes, crop_bytes)


def _prediction_signature(slot: dict[str, Any]) -> str:
    quantity = slot.get("quantity") if isinstance(slot.get("quantity"), dict) else {}
    signature = {"decision": slot.get("decision"), "bestCandidate": slot.get("bestCandidate"),
                 "finalItem": slot.get("finalItem"), "bestItemId": slot.get("bestItemId"),
                 "quantityStatus": quantity.get("status"), "quantityValue": quantity.get("value")}
    return json.dumps(signature, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _prediction_observation(entry: dict[str, Any]) -> dict[str, Any]:
    slot = entry["slot"]
    quantity = slot.get("quantity") if isinstance(slot.get("quantity"), dict) else {}
    return {"sourceScanId": entry["scanId"], "timestamp": entry["timestamp"],
            "decision": slot.get("decision"), "bestCandidate": slot.get("bestCandidate"),
            "finalItem": slot.get("finalItem"), "bestItemId": slot.get("bestItemId"),
            "quantityStatus": quantity.get("status"), "quantityValue": quantity.get("value"),
            "box": {key: slot.get(key) for key in ("x", "y", "row", "column") if key in slot}}


def sample_prediction(slot: dict[str, Any], field_name: str) -> Any:
    if field_name == "item":
        return slot.get("bestCandidate")
    quantity = slot.get("quantity")
    return quantity.get("value") if isinstance(quantity, dict) else None


def _write_immutable(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != payload:
            raise FileExistsError(f"refusing to overwrite different evidence: {path}")
        return
    path.write_bytes(payload)


def export_to_directory(readonly_db: str | Path, output_dir: str | Path) -> dict[str, Any]:
    out = Path(output_dir)
    samples: list[dict[str, Any]] = []
    images: dict[str, bytes] = {}
    crops: dict[str, bytes] = {}
    for record in export_legacy_feedback(readonly_db):
        samples.append(record.sample)
        images[record.sample["sourceImageHash"]] = record.source_png
        if record.crop_png is not None:
            crops[record.sample["cropHash"]] = record.crop_png
    samples.sort(key=lambda value: value["sampleId"])
    jsonl = b"".join((json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8") for value in samples)
    for digest, payload in sorted(images.items()):
        _write_immutable(out / "artifacts" / "source" / f"{digest}.png", payload)
    for digest, payload in sorted(crops.items()):
        _write_immutable(out / "artifacts" / "crop" / f"{digest}.png", payload)
    _write_immutable(out / "samples.jsonl", jsonl)
    snapshot_hash = sha256_bytes(Path(readonly_db).read_bytes())
    manifest = {
        "version": 1,
        "datasetId": "legacy-feedback-replay",
        "sourceSnapshotHash": snapshot_hash,
        "sourceAccessMode": "sqlite-mode-ro",
        "mainDatabaseWriteCount": 0,
        "sampleCount": len(samples),
        "captureCount": len({sample["captureId"] for sample in samples}),
        "sourceScanCount": len({scan_id for sample in samples for scan_id in sample["sourceScanIds"]}),
        "groupCount": len({sample["groupId"] for sample in samples}),
        "sourceImageArtifactCount": len(images),
        "cropArtifactCount": len(crops),
        "sampleMissingCropCount": sum(sample["cropHash"] is None for sample in samples),
        "split": "replay",
        "blindHoldout": False,
        "trainingPerformed": False,
        "labelCounts": {status: sum(sample["labelStatus"] == status for sample in samples)
                        for status in ("HUMAN_VERIFIED", "DISPUTED", "UNVERIFIED")},
        "verifiedFieldCounts": {
            "item": sum(sample["fieldTruth"]["item"]["verified"] is True for sample in samples),
            "quantity": sum(sample["fieldTruth"]["quantity"]["verified"] is True for sample in samples),
        },
        "disputedFieldCounts": {
            "item": sum(sample["fieldTruth"]["item"]["status"] == "DISPUTED" for sample in samples),
            "quantity": sum(sample["fieldTruth"]["quantity"]["status"] == "DISPUTED" for sample in samples),
        },
    }
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    _write_immutable(out / "manifest.json", manifest_bytes)
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--main-db", required=True, type=Path, help="copied SQLite snapshot; opened read-only")
    parser.add_argument("--source", required=True, choices=("legacy-feedback",))
    parser.add_argument("--out", required=True, type=Path, help="local-only immutable output directory")
    args = parser.parse_args()
    manifest = export_to_directory(args.main_db, args.out)
    print(json.dumps({"status": "PASS", **manifest}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
