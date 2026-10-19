#!/usr/bin/env python3
"""Build deterministic quantity glyph templates from an annotated local screenshot."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image

from warehouse_patch import crop_inner_slots, detect_grid, quantity_cell_feature


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("screenshot", type=Path)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    image = Image.open(args.screenshot).convert("RGB")
    xgrid, ygrid, _ = detect_grid(image)
    slots = {(slot["row"], slot["column"]): slot.pop("rgb") for slot in crop_inner_slots(image, xgrid, ygrid)}
    annotations = json.loads(args.manifest.read_text(encoding="utf-8"))["slots"]

    digit_features: list[np.ndarray] = []
    digit_labels: list[int] = []
    blank_features: list[list[np.ndarray]] = [[] for _ in range(4)]
    for annotation in annotations:
        key = (int(annotation["row"]), int(annotation["column"]))
        slot = slots[key]
        quantity = annotation["quantity"]
        digits = [] if quantity is None else [int(value) for value in reversed(str(quantity))]
        for position in range(4):
            feature = quantity_cell_feature(slot, position)
            if position < len(digits):
                digit_features.append(feature)
                digit_labels.append(digits[position])
            else:
                blank_features[position].append(feature)

    missing_digits = sorted(set(range(10)) - set(digit_labels))
    if missing_digits:
        raise RuntimeError(f"Calibration is missing digit labels: {missing_digits}")
    if any(not values for values in blank_features):
        raise RuntimeError("Calibration is missing blank samples")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        args.output,
        digit_features=np.stack(digit_features).astype(np.float32),
        digit_labels=np.asarray(digit_labels, dtype=np.uint8),
        blank_features_0=np.stack(blank_features[0]).astype(np.float32),
        blank_features_1=np.stack(blank_features[1]).astype(np.float32),
        blank_features_2=np.stack(blank_features[2]).astype(np.float32),
        blank_features_3=np.stack(blank_features[3]).astype(np.float32),
        source_sha256=np.asarray(hashlib.sha256(args.screenshot.read_bytes()).hexdigest()),
        manifest_sha256=np.asarray(hashlib.sha256(args.manifest.read_bytes()).hexdigest()),
    )
    print(json.dumps({
        "output": str(args.output),
        "digitSamples": len(digit_features),
        "blankSamples": [len(values) for values in blank_features],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
