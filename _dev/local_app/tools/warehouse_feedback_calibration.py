"""Calibrate the existing local quantity templates from explicitly checked scan exports."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image

from tools.warehouse_patch.warehouse_patch import crop_inner_slots, detect_grid, quantity_cell_feature


def calibrate(dataset: Path, base: Path, output: Path, *, holdout_scan: str | None = None) -> dict:
    digits, labels = [], []
    blanks = [[] for _ in range(4)]
    sources, accepted, checked_slots, checked_values, checked_names = [], 0, [], [], []
    with zipfile.ZipFile(dataset) as bundle:
        manifest = json.loads(bundle.read("manifest.json"))
        if manifest.get("formatVersion") != 2:
            raise ValueError("A version 2 warehouse feedback export is required")
        for filename in sorted(bundle.namelist()):
            if not filename.endswith("/feedback.json"):
                continue
            folder = filename.rsplit("/", 1)[0]
            scan_id = folder.rsplit("/", 1)[-1]
            if scan_id == holdout_scan:
                continue
            feedback = json.loads(bundle.read(filename))
            checked = {}
            for entry in feedback:
                record = entry.get("feedback", {})
                if record.get("version") != 2:
                    continue
                for row in record.get("rows", []):
                    if row.get("excluded") or row.get("agreement") not in {
                        "both_match", "item_only", "quantity_only", "both_different"
                    }:
                        checked.pop(row.get("slot"), None)
                        continue
                    value = row.get("quantity")
                    if type(value) is int and 0 <= value <= 9999 and isinstance(row.get("name"), str) and row["name"].strip():
                        checked[row["slot"]] = (value, row["name"])
                    else:
                        checked.pop(row.get("slot"), None)
            if not checked:
                continue
            image_bytes = bundle.read(f"{folder}/input.png")
            image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            xgrid, ygrid, _ = detect_grid(image)
            slots = {f"R{slot['row']}C{slot['column']}": slot["rgb"]
                     for slot in crop_inner_slots(image, xgrid, ygrid)}
            for slot_id, (value, name) in checked.items():
                if slot_id not in slots:
                    raise ValueError("A checked slot is missing from the detected grid")
                reversed_digits = [int(number) for number in reversed(str(value))]
                features = [quantity_cell_feature(slots[slot_id], index) for index in range(4)]
                if any(np.count_nonzero(features[index]) < 3 for index in range(len(reversed_digits))):
                    continue
                for index, feature in enumerate(features):
                    if index < len(reversed_digits):
                        digits.append(feature)
                        labels.append(reversed_digits[index])
                    else:
                        blanks[index].append(feature)
                accepted += 1
                checked_slots.append(np.rint(slots[slot_id] * 255).astype(np.uint8))
                checked_values.append(value)
                checked_names.append(name)
            sources.append({"scanId": scan_id, "sha256": hashlib.sha256(image_bytes).hexdigest()})
    if not digits:
        raise ValueError("No explicitly verified quantity samples are available")
    with np.load(base, allow_pickle=False) as original:
        data = {key: original[key] for key in original.files if not key.startswith("feedback_")}
    data.update(feedback_digit_features=np.stack(digits).astype(np.float32),
                feedback_digit_labels=np.asarray(labels, dtype=np.uint8),
                feedback_slots=np.stack(checked_slots), feedback_values=np.asarray(checked_values, dtype=np.int32),
                feedback_item_names=np.asarray(checked_names))
    for index, values in enumerate(blanks):
        data[f"feedback_blank_features_{index}"] = (np.unique(np.stack(values), axis=0).astype(np.float32)
                                                    if values else np.empty((0, 96), dtype=np.float32))
    provenance = {"version": 1, "verifiedRows": accepted, "sources": sources,
                  "baseSha256": hashlib.sha256(base.read_bytes()).hexdigest()}
    data["feedback_provenance_json"] = np.asarray(json.dumps(provenance, sort_keys=True))
    output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(output, **data)
    return provenance


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(calibrate(args.dataset, args.base, args.output)))


if __name__ == "__main__":
    main()
