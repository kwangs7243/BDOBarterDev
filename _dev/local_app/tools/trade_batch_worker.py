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


def _load_inputs(request_path: Path, model_dir: Path) -> tuple[str, list[dict[str, Any]], dict[str, Any], dict[str, Any], dict[str, Any]]:
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
        checked.append({"captureId": capture["captureId"], "batchId": capture.get("batchId"),
                        "imagePath": str(image_path)})

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


def run(request_path: Path, output_path: Path, model_dir: Path) -> None:
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    os.environ["HF_HUB_OFFLINE"] = "1"
    batch_id, captures, lanes, row_parameters, numeric_parameters = _load_inputs(request_path, model_dir)
    from local_app.tools.trade_batch_draft_experiment import build_batch_drafts_once
    from local_app.tools.trade_ocr_experiment import _load_reader

    reader, _init_ms = _load_reader(model_dir)
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--model-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        run(args.request, args.out, args.model_dir)
    except Exception as error:
        print(f"trade batch worker failed: {type(error).__name__}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
