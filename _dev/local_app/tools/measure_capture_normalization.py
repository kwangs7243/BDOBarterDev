"""Rebuild the deterministic T005A1 grid-crop measurement artifact."""
from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops

from local_app.backend.services.capture_normalization import load_anchor_bundle, load_profile, normalize_capture


ROOT = Path(__file__).resolve().parents[2]
REPO = ROOT.parent
PROFILE_PATH = ROOT / "local_app" / "recognition_data" / "profiles.json"
ANCHOR_PATH = ROOT / "local_app" / "recognition_data" / "anchors.npz"
FIXTURE_DIR = ROOT / "fixtures" / "warehouse_patch"
OUTPUT_PATH = ROOT / "local_app" / "recognition_data" / "t005a1_measurements.json"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _mae(first: list[Image.Image], second: list[Image.Image]) -> float:
    total = 0
    count = 0
    for left, right in zip(first, second):
        diff = ImageChops.difference(left.convert("RGB"), right.convert("RGB"))
        values = np.asarray(diff, dtype="uint64")
        total += int(values.sum())
        count += values.size
    return total / max(1, count)


def _summary(result) -> dict:
    mapping_errors = []
    if result.transform and result.rawBoxes and result.canonicalBoxes:
        scale_x, scale_y = result.transform["scaleX"], result.transform["scaleY"]
        tx, ty = result.transform["translationX"], result.transform["translationY"]
        for raw, canonical in zip(result.rawBoxes, result.canonicalBoxes):
            mapping_errors.extend((
                abs((raw["x"] - tx) / scale_x - canonical["x"]),
                abs((raw["y"] - ty) / scale_y - canonical["y"]),
                abs(raw["w"] / scale_x - canonical["w"]),
                abs(raw["h"] / scale_y - canonical["h"]),
            ))
    return {"validity": result.validity, "qualityReasons": result.qualityReasons,
            "transform": result.transform, "gridEvidence": result.gridEvidence,
            "gridBounds": result.measurement.get("gridBounds"),
            "rows": result.measurement.get("rows"), "columns": result.measurement.get("columns"),
            "slotCount": len(result.rawCrops),
            "maxCanonicalMappingErrorPx": max(mapping_errors, default=None)}


def build_measurement() -> dict:
    profile = load_profile(PROFILE_PATH)
    anchors = load_anchor_bundle(ANCHOR_PATH)
    fixture_paths = {name: FIXTURE_DIR / f"{name}.png" for name in ("barter_only", "mixed")}
    fixture_hashes = {name: _sha256(path) for name, path in fixture_paths.items()}
    normal: dict[str, dict] = {}
    for name, path in fixture_paths.items():
        result = normalize_capture(Image.open(path).convert("RGB"), profile, anchors)
        normal[name] = _summary(result)

    base = Image.open(fixture_paths["barter_only"]).convert("RGB")
    base_result = normalize_capture(base, profile, anchors)
    translated = Image.new("RGB", (base.width + 30, base.height + 24), (24, 24, 27))
    injected_translation = {"dx": 13, "dy": 9}
    translated.paste(base, (injected_translation["dx"], injected_translation["dy"]))
    translated_result = normalize_capture(translated, profile, anchors)
    translation = {"injected": injected_translation, "measured": translated_result.transform,
                   "recoveryError": {"dx": translated_result.transform["translationX"] - base_result.transform["translationX"] - injected_translation["dx"],
                                     "dy": translated_result.transform["translationY"] - base_result.transform["translationY"] - injected_translation["dy"]},
                   "validity": translated_result.validity}

    uniform: list[dict] = []
    for candidate in (.75, 1.0, 1.25):
        resized = base.resize((round(base.width * candidate), round(base.height * candidate)), Image.Resampling.BILINEAR)
        result = normalize_capture(resized, profile, anchors)
        uniform.append({"candidateScale": candidate, **_summary(result),
                        "canonicalSlotMAEvsReference": _mae(base_result.canonicalCrops, result.canonicalCrops),
                        "scaleApproved": False})

    nonuniform_image = base.resize((round(base.width * 1.25), round(base.height * .75)), Image.Resampling.BILINEAR)
    nonuniform_result = normalize_capture(nonuniform_image, profile, anchors)
    clips = {
        "firstColumn": base.crop((10, 0, base.width, base.height)),
        "lastColumn": base.crop((0, 0, 440, base.height)),
        "firstRow": base.crop((0, 20, base.width, base.height)),
        "lastRow": base.crop((0, 0, base.width, 340)),
    }
    clip_results = {name: _summary(normalize_capture(image, profile, anchors)) for name, image in clips.items()}
    digit_result = normalize_capture(clips["lastRow"], profile, anchors)
    no_grid_result = normalize_capture(Image.new("RGB", (100, 80), (24, 24, 27)), profile, anchors)

    resampling: list[dict] = []
    scaled = base.resize((390, 307), Image.Resampling.BILINEAR)
    outputs = {}
    for kernel in ("bilinear", "bicubic", "lanczos"):
        result = normalize_capture(scaled, profile, anchors, resampling=kernel)
        outputs[kernel] = result.canonicalCrops
        resampling.append({"kernel": kernel, "validity": result.validity, "approved": False})
    comparisons = {f"{left}-vs-{right}": _mae(outputs[left], outputs[right])
                   for left, right in (("bilinear", "bicubic"), ("bilinear", "lanczos"), ("bicubic", "lanczos"))}

    source_commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, check=True,
                                  capture_output=True, text=True).stdout.strip()
    code_digest = hashlib.sha256()
    for code_path in (ROOT / "local_app" / "backend" / "services" / "capture_normalization.py", Path(__file__)):
        code_digest.update(code_path.read_bytes())
    return {
        "version": 1,
        "task": "T005A1",
        "sourceCommit": source_commit,
        "measurementCodeSha256": code_digest.hexdigest(),
        "scope": "warehouse-grid-crop",
        "profilesHash": _sha256(PROFILE_PATH),
        "anchorSetId": profile["anchorSetId"],
        "anchorLogicalHash": anchors["logicalHash"],
        "anchorByteHash": _sha256(ANCHOR_PATH),
        "fixtureHashes": fixture_hashes,
        "normalFixtureMeasurements": normal,
        "translationMeasurements": [translation],
        "uniformScaleMeasurements": uniform,
        "nonuniformNegativeResults": [{"injectedScale": {"x": 1.25, "y": .75}, **_summary(nonuniform_result), "expectedReason": "NONUNIFORM_TRANSFORM"}],
        "gridClippingResults": clip_results,
        "digitClippingResults": [{"case": "lastRow", "qualityReasons": digit_result.qualityReasons,
                                   "expectedReason": "DIGIT_REGION_CLIPPED"}],
        "gridMissingResults": [{"case": "solid-region", "validity": no_grid_result.validity,
                                "qualityReasons": no_grid_result.qualityReasons}],
        "canonicalAlignmentMetrics": {"scaleCases": [{"candidateScale": item["candidateScale"],
                                                        "meanAbsolutePixelDifference": item["canonicalSlotMAEvsReference"]}
                                                       for item in uniform],
                                       "resamplingPairwiseMAE": comparisons},
        "resamplingCandidates": resampling,
        "observedCandidateStrata": [],
        "authority": {"releaseApproved": False, "liveApproved": False, "allowedStrata": [], "highAuthority": False},
        "deferredValidity": ["WRONG_TASK_UI", "FULL_PANEL_REGION", "PANEL_CLIPPED", "LIVE_WINDOW_PROFILE", "REAL_GAME_SCALE_SUPPORT"],
        "unapprovedParameters": [
            "candidate scales .75/1.0/1.25 are measurement probes, not a supported range",
            "bilinear/bicubic/lanczos differences are measurements; no kernel is approved",
            "edge contrast ratio > 1 and one-pixel period quantization are experimental validity heuristics, not release cutoffs",
            "fixture-derived 45/51 structural slot ratio is a grid-crop measurement anchor only",
        ],
    }


if __name__ == "__main__":
    artifact = build_measurement()
    OUTPUT_PATH.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"artifact": str(OUTPUT_PATH), "profilesHash": artifact["profilesHash"],
                      "anchorLogicalHash": artifact["anchorLogicalHash"],
                      "fixtureCases": len(artifact["normalFixtureMeasurements"])}, ensure_ascii=False))
