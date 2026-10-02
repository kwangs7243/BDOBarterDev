"""One-pass local OCR worker for the T010P3B1 batch bridge."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

FIELDS = {"island", "fromItem", "reqAmount", "toItem", "count", "yield"}
BOUNDARY_POLICY = "edge-segments-evidence-only-v1"
EXPECTED = {
    "inference.onnx": "92f0b7785e64fc9090106a241cf4c1eb97472824558272751b88a2a4476d3a08",
    "inference.yml": "f757fa1c40e99edcf27e9cce879b93eb2a51fa46f5ef39095689b8c37dd75998",
}


def _digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def _load_inputs(request_path: Path, model_dir: Path, raw_evidence_version: int = 1) -> tuple[str, list[dict[str, Any]], dict[str, Any], dict[str, Any], dict[str, Any]]:
    if raw_evidence_version not in (1, 2):
        raise ValueError("raw evidence version is invalid")
    if not request_path.is_file():
        raise ValueError("request manifest is missing")
    for name, expected in EXPECTED.items():
        model_file = model_dir / name
        if not model_file.is_file() or _digest(model_file) != expected:
            raise ValueError("model integrity verification failed")
    request_value = json.loads(request_path.read_text(encoding="utf-8"))
    if request_value.get("version") != 1 or not isinstance(request_value.get("batchId"), str):
        raise ValueError("request manifest is invalid")
    work_dir = request_path.resolve().parent
    captures = request_value.get("captures")
    if not isinstance(captures, list) or not 1 <= len(captures) <= 100:
        raise ValueError("request capture list is invalid")
    checked = []
    for ordinal, capture in enumerate(captures, 1):
        if not isinstance(capture, dict) or capture.get("imagePath") != f"capture-{ordinal:04d}.png":
            raise ValueError("request image reference is invalid")
        image_path = (work_dir / capture["imagePath"]).resolve()
        if image_path.parent != work_dir or not image_path.is_file():
            raise ValueError("request image is unavailable")
        checked_capture = {"captureId": capture["captureId"], "batchId": capture.get("batchId"),
                           "imagePath": str(image_path)}
        if raw_evidence_version == 2:
            source_type = capture.get("sourceType")
            fidelity = capture.get("sourceFidelity")
            reencoded = capture.get("reencoded")
            if (source_type not in ("FILE", "CLIPBOARD", "STREAM") or type(reencoded) is not bool
                    or not isinstance(fidelity, dict)
                    or set(fidelity) != {"sourceWidth", "sourceHeight", "rescaled", "evidence"}):
                raise ValueError("v2 capture source metadata is invalid")
            checked_capture.update({"sourceType": source_type, "sourceFidelity": dict(fidelity),
                                    "reencoded": reencoded})
        checked.append(checked_capture)

    selection_path = ROOT / "local_app" / "recognition_data" / "trade-t010p3a-experiment.json"
    row_path = ROOT / "local_app" / "recognition_data" / "trade-t010a-experiment.json"
    numeric_path = ROOT / "local_app" / "recognition_data" / "trade-t010a2-experiment.json"
    selection = json.loads(selection_path.read_text(encoding="utf-8"))
    row_selection = json.loads(row_path.read_text(encoding="utf-8"))
    numeric_selection = json.loads(numeric_path.read_text(encoding="utf-8"))
    if (selection.get("task") != "T010P3A" or selection.get("oracleUsed") is not False
            or selection.get("approved") is not False or selection.get("production") is not False
            or selection.get("engineSelectedForProduction") is not False):
        raise ValueError("pinned geometry selection is invalid")
    selected = selection.get("selectedFieldLanes")
    if not isinstance(selected, dict) or set(selected) != FIELDS:
        raise ValueError("pinned geometry fields are invalid")
    lanes = {}
    for field in FIELDS:
        lane = selected[field].get("lane") if isinstance(selected[field], dict) else None
        if not isinstance(lane, dict) or set(lane) != {"x0", "x1", "y0", "y1"}:
            raise ValueError("pinned geometry lane is invalid")
        lanes[field] = lane
    if row_selection.get("task") != "T010A" or numeric_selection.get("task") != "T010A2":
        raise ValueError("frozen geometry parameters are invalid")
    row_parameters = row_selection["parameters"]
    numeric_parameters = numeric_selection["componentPlausibility"]
    return request_value["batchId"], checked, lanes, row_parameters, numeric_parameters


def _valid_hash(value: Any) -> bool:
    return (isinstance(value, str) and len(value) == 64 and value == value.lower()
            and all(character in "0123456789abcdef" for character in value))


def _valid_box(box: Any, frame: dict[str, Any]) -> bool:
    if not isinstance(box, dict) or set(box) != {"x", "y", "width", "height"}:
        return False
    if any(type(box[key]) is not int for key in box):
        return False
    return (box["x"] >= 0 and box["y"] >= 0 and box["width"] > 0 and box["height"] > 0
            and box["x"] + box["width"] <= frame["width"]
            and box["y"] + box["height"] <= frame["height"])


def _validate_raw_evidence_snapshot_v2(snapshot: Any, batch_id: str,
                                       expected_capture_ids: list[str]) -> None:
    top_keys = {"schemaVersion", "recognitionBatchId", "captures", "sourceRows", "edgeSegments"}
    capture_keys = {"captureId", "captureOrdinal", "imageSha256", "bitmapSha256", "sourceType",
                    "frame", "sourceFidelity", "reencoded", "completeRowCount"}
    row_keys = {"sourceRowId", "captureId", "ordinal", "rowBox", "fields"}
    field_keys = {"field", "rawText", "rawNumeric", "readerStatus", "confidence", "cropRefs"}
    crop_keys = {"cropRefId", "sourceRowId", "captureId", "field", "bitmapSha256", "frame",
                 "coordinateSpace", "box", "pixelHashBasis", "pixelSha256", "pngArtifactSha256"}
    edge_keys = {"edgeId", "captureId", "ordinal", "reason", "rowBox", "sourceRefs"}
    source_ref_keys = {"sourceRowId", "captureId", "ordinal"}
    field_order = ("island", "fromItem", "reqAmount", "toItem", "count", "yield")
    if (not isinstance(snapshot, dict) or set(snapshot) != top_keys or snapshot.get("schemaVersion") != 2
            or snapshot.get("recognitionBatchId") != batch_id):
        raise ValueError("RAW_EVIDENCE_V2_INVALID_TOP_LEVEL")
    captures = snapshot.get("captures")
    source_rows = snapshot.get("sourceRows")
    edges = snapshot.get("edgeSegments")
    if (not isinstance(captures, list) or len(captures) != len(expected_capture_ids)
            or [item.get("captureId") for item in captures if isinstance(item, dict)] != expected_capture_ids
            or len(captures) != len([item for item in captures if isinstance(item, dict)])
            or not isinstance(source_rows, list) or not isinstance(edges, list)):
        raise ValueError("RAW_EVIDENCE_V2_INVALID_ACCOUNTING")
    capture_map: dict[str, dict[str, Any]] = {}
    for index, capture in enumerate(captures, 1):
        capture_id = capture.get("captureId")
        fidelity = capture.get("sourceFidelity")
        unknown_fidelity = {"sourceWidth": None, "sourceHeight": None,
                            "rescaled": None, "evidence": "unknown"}
        valid_fidelity = fidelity == unknown_fidelity or (
            isinstance(fidelity, dict)
            and type(fidelity.get("sourceWidth")) is int and fidelity["sourceWidth"] > 0
            and type(fidelity.get("sourceHeight")) is int and fidelity["sourceHeight"] > 0
            and type(fidelity.get("rescaled")) is bool
            and isinstance(fidelity.get("evidence"), str) and bool(fidelity["evidence"].strip())
            and fidelity["evidence"] != "unknown"
        )
        if (set(capture) != capture_keys or not isinstance(capture_id, str) or not capture_id
                or len(capture_id) > 128 or capture_id in capture_map
                or capture.get("captureOrdinal") != index
                or capture.get("sourceType") not in ("FILE", "CLIPBOARD", "STREAM")
                or type(capture.get("reencoded")) is not bool
                or not isinstance(capture.get("frame"), dict)
                or set(capture["frame"]) != {"width", "height"}
                or any(type(capture["frame"].get(key)) is not int or capture["frame"][key] <= 0
                       for key in ("width", "height"))
                or not _valid_hash(capture.get("imageSha256")) or not _valid_hash(capture.get("bitmapSha256"))
                or type(capture.get("completeRowCount")) is not int or capture["completeRowCount"] < 0
                or not isinstance(fidelity, dict)
                or set(fidelity) != {"sourceWidth", "sourceHeight", "rescaled", "evidence"}
                or not valid_fidelity):
            raise ValueError("RAW_EVIDENCE_V2_INVALID_CAPTURE")
        capture_map[capture_id] = capture

    source_ids: set[str] = set()
    crop_ids: set[str] = set()
    row_counts = {capture_id: 0 for capture_id in expected_capture_ids}
    source_ordinals = {capture_id: set() for capture_id in expected_capture_ids}
    last_position = (-1, -1)
    for row in source_rows:
        if not isinstance(row, dict) or set(row) != row_keys:
            raise ValueError("RAW_EVIDENCE_V2_INVALID_SOURCE_ROW")
        source_id, capture_id, ordinal = row.get("sourceRowId"), row.get("captureId"), row.get("ordinal")
        if (not isinstance(source_id, str) or not source_id or len(source_id) > 128
                or source_id in source_ids or source_id in capture_map or capture_id not in capture_map
                or type(ordinal) is not int or ordinal < 0):
            raise ValueError("RAW_EVIDENCE_V2_INVALID_SOURCE_ID")
        position = (capture_map[capture_id]["captureOrdinal"], ordinal)
        if position < last_position:
            raise ValueError("RAW_EVIDENCE_V2_SOURCE_ORDER_INVALID")
        last_position = position
        if ordinal in source_ordinals[capture_id]:
            raise ValueError("RAW_EVIDENCE_V2_DUPLICATE_SOURCE_ORDINAL")
        source_ordinals[capture_id].add(ordinal)
        source_ids.add(source_id)
        row_counts[capture_id] += 1
        frame = capture_map[capture_id]["frame"]
        if not _valid_box(row.get("rowBox"), frame):
            raise ValueError("RAW_EVIDENCE_V2_INVALID_ROW_BOX")
        fields = row.get("fields")
        if not isinstance(fields, list) or len(fields) != 6 or [item.get("field") for item in fields if isinstance(item, dict)] != list(field_order):
            raise ValueError("RAW_EVIDENCE_V2_INVALID_FIELDS")
        for field in fields:
            if (set(field) != field_keys or field.get("rawText") is not None and not isinstance(field.get("rawText"), str)
                    or field.get("rawNumeric") is not None and type(field.get("rawNumeric")) is not int
                    or field.get("field") not in ("reqAmount", "count", "yield") and field.get("rawNumeric") is not None
                    or not isinstance(field.get("readerStatus"), str) or not field["readerStatus"]
                    or field.get("confidence") is not None and not isinstance(field.get("confidence"), str)
                    or not isinstance(field.get("cropRefs"), list) or len(field["cropRefs"]) > 1):
                raise ValueError("RAW_EVIDENCE_V2_INVALID_FIELD")
            expected_field = field["field"]
            for crop in field["cropRefs"]:
                if (not isinstance(crop, dict) or set(crop) != crop_keys
                        or not isinstance(crop.get("cropRefId"), str) or not crop["cropRefId"]
                        or crop["cropRefId"] in crop_ids or crop.get("sourceRowId") != source_id
                        or crop.get("captureId") != capture_id or crop.get("field") != expected_field
                        or crop.get("bitmapSha256") != capture_map[capture_id]["bitmapSha256"]
                        or crop.get("frame") != frame or crop.get("coordinateSpace") != "CAPTURE_BITMAP_PIXELS"
                        or crop.get("pixelHashBasis") != "RGB8_ROW_MAJOR_V1"
                        or not _valid_hash(crop.get("pixelSha256")) or crop.get("pngArtifactSha256") is not None
                        or not _valid_box(crop.get("box"), frame)):
                    raise ValueError("RAW_EVIDENCE_V2_INVALID_CROP_REF")
                crop_ids.add(crop["cropRefId"])

    if any(capture_map[capture_id]["completeRowCount"] != count for capture_id, count in row_counts.items()):
        raise ValueError("RAW_EVIDENCE_V2_COMPLETE_COUNT_MISMATCH")
    edge_ids: set[str] = set()
    edge_ordinals = {capture_id: set() for capture_id in expected_capture_ids}
    for edge in edges:
        if (not isinstance(edge, dict) or set(edge) != edge_keys or edge.get("captureId") not in capture_map
                or not isinstance(edge.get("edgeId"), str) or not edge["edgeId"] or len(edge["edgeId"]) > 128
                or edge["edgeId"] in edge_ids or edge["edgeId"] in source_ids or edge["edgeId"] in capture_map
                or type(edge.get("ordinal")) is not int or edge["ordinal"] < 0
                or edge["ordinal"] in edge_ordinals[edge["captureId"]]
                or not isinstance(edge.get("reason"), str) or not edge["reason"]
                or not _valid_box(edge.get("rowBox"), capture_map[edge["captureId"]]["frame"])):
            raise ValueError("RAW_EVIDENCE_V2_INVALID_EDGE")
        edge_ordinals[edge["captureId"]].add(edge["ordinal"])
        refs = edge.get("sourceRefs")
        if (not isinstance(refs, list) or len(refs) != 1 or not isinstance(refs[0], dict)
                or set(refs[0]) != source_ref_keys or refs[0] != {"sourceRowId": edge["edgeId"],
                    "captureId": edge["captureId"], "ordinal": edge["ordinal"]}):
            raise ValueError("RAW_EVIDENCE_V2_INVALID_EDGE_SOURCE_REF")
        edge_ids.add(edge["edgeId"])


def run(request_path: Path, output_path: Path, model_dir: Path, raw_evidence_version: int = 1) -> None:
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    os.environ["HF_HUB_OFFLINE"] = "1"
    if raw_evidence_version == 1:
        batch_id, captures, lanes, row_parameters, numeric_parameters = _load_inputs(request_path, model_dir)
    elif raw_evidence_version == 2:
        batch_id, captures, lanes, row_parameters, numeric_parameters = _load_inputs(
            request_path, model_dir, raw_evidence_version=2
        )
    else:
        raise ValueError("raw evidence version is invalid")
    from local_app.tools.trade_ocr_experiment import _load_reader

    reader, _init_ms = _load_reader(model_dir)
    if raw_evidence_version == 2:
        from local_app.tools.trade_batch_draft_experiment import build_raw_evidence_snapshot_v2_once

        payload = build_raw_evidence_snapshot_v2_once(
            captures, lanes, row_parameters, numeric_parameters, reader,
            recognition_batch_id=batch_id,
        )
        _validate_raw_evidence_snapshot_v2(payload, batch_id,
                                           [capture["captureId"] for capture in captures])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        handle, temporary_name = tempfile.mkstemp(prefix="trade-result-", suffix=".json", dir=output_path.parent)
        try:
            with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
                json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_name, output_path)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)
        return

    from local_app.tools.trade_batch_draft_experiment import build_batch_drafts_once

    result = build_batch_drafts_once(captures, lanes, row_parameters, numeric_parameters, reader)
    rows = result["draftRows"]
    if any(set(row.get("fields", {})) != FIELDS or row.get("status") != "DRAFT_UNVERIFIED"
           or row.get("automationDecision") != "REVIEW"
           or any(field.get("value") is not None or "ROW_BOUNDARY_CONTACT" in field.get("reasonCodes", [])
                  for field in row["fields"].values()) for row in rows):
        raise ValueError("draft contract validation failed")
    captures_out = result["captureEvidence"]
    detected = sum(item["detectedCandidateCount"] for item in captures_out)
    complete = sum(item["completeRowCount"] for item in captures_out)
    edges = sum(item["edgeSegmentCount"] for item in captures_out)
    payload = {"version": 1, "batchId": batch_id,
               "captureIds": [capture["captureId"] for capture in captures],
               "captures": captures_out, "draftRows": rows, "edgeSegments": result["edgeSegments"],
               "metrics": {"boundaryPolicy": BOUNDARY_POLICY, "captureCount": len(captures),
                           "detectedCandidateCount": detected, "completeRowCount": complete,
                           "edgeSegmentCount": edges, "draftRowCount": len(rows),
                           "countMeaning": "remainingExchangeCount"}}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(prefix="trade-result-", suffix=".json", dir=output_path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, output_path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--raw-evidence-version", choices=(1, 2), type=int, default=1)
    return parser


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()
    try:
        run(args.request, args.out, args.model_dir, raw_evidence_version=args.raw_evidence_version)
    except Exception as error:
        print(f"trade batch worker failed: {type(error).__name__}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
