"""T006A shadow evidence adapter around the frozen R0 warehouse converter.

This module is deliberately not connected to the production recognition API.
It preserves R0 predictions and adds independent T005A1 crop measurements.
"""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path
from typing import Any

from PIL import Image


DEV_ROOT = Path(__file__).resolve().parents[3]
TOOLS = DEV_ROOT / "tools" / "warehouse_patch"
if str(DEV_ROOT) not in sys.path:
    sys.path.insert(0, str(DEV_ROOT))
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from warehouse_patch import convert as convert_r0  # noqa: E402
from local_app.backend.services.capture_normalization import normalize_capture  # noqa: E402


def _pixel_hash(image: Image.Image) -> str:
    digest = hashlib.sha256()
    digest.update(image.mode.encode("ascii") + b"\0")
    digest.update(f"{image.width}x{image.height}".encode("ascii") + b"\0")
    digest.update(image.tobytes())
    return digest.hexdigest()


def run_r0_shadow(image_path: str | Path, reference_json: str | Path,
                  templates_path: str | Path, profile_path: str | Path,
                  anchor_path: str | Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """Run frozen R0 on the original image and attach T005A1-only evidence.

    No truth, stock, correction, or final-value data is accepted by this API.
    The R0 converter's patch and slot decisions are returned unchanged.
    """
    image_path = Path(image_path)
    patch, report = convert_r0(image_path, Path(reference_json), Path(templates_path))

    from local_app.backend.services.capture_normalization import load_anchor_bundle, load_profile

    with Image.open(image_path) as source:
        image = source.convert("RGB")
    profile = load_profile(profile_path)
    anchors = load_anchor_bundle(anchor_path)
    measured = normalize_capture(image, profile, anchors)
    boxes = {record["unitId"]: record for record in measured.rawBoxes}
    canonical_boxes = {record["unitId"]: record for record in measured.canonicalBoxes}
    raw_crops = {record["unitId"]: crop for record, crop in zip(measured.rawBoxes, measured.rawCrops)}
    canonical_crops = {record["unitId"]: crop for record, crop in zip(measured.canonicalBoxes, measured.canonicalCrops)}
    raw_regions = {box["unitId"]: record for box, record in zip(measured.rawBoxes, measured.rawRegionCrops)}
    canonical_regions = {box["unitId"]: record for box, record in zip(measured.canonicalBoxes, measured.canonicalRegionCrops)}

    evidence_slots: dict[str, dict[str, Any]] = {}
    grid = report.get("grid", {})
    period = grid.get("period")
    slot_width = grid.get("slotWidth")
    for prediction in report.get("slots", []):
        slot_id = prediction.get("slot")
        evidence: dict[str, Any] = {
            "slotId": slot_id,
            "row": prediction.get("row"),
            "column": prediction.get("column"),
            "r0RawBox": {"x": prediction.get("x"), "y": prediction.get("y"),
                         "w": slot_width, "h": slot_width},
            "r0InputCropPixelSha256": None,
            "t005a1RawBox": boxes.get(slot_id),
            "t005a1CanonicalBox": canonical_boxes.get(slot_id),
            "rawCropPixelSha256": _pixel_hash(raw_crops[slot_id]) if slot_id in raw_crops else None,
            "canonicalCropPixelSha256": _pixel_hash(canonical_crops[slot_id]) if slot_id in canonical_crops else None,
            "rawIconCropPixelSha256": None,
            "canonicalIconCropPixelSha256": None,
            "rawQuantityCropPixelSha256": None,
            "canonicalQuantityCropPixelSha256": None,
            "geometryValidity": measured.validity,
            "geometryReasons": list(measured.qualityReasons),
            "measuredTransform": measured.transform,
            "profileStratum": measured.profileStratum,
        }
        if slot_id in raw_regions and slot_id in canonical_regions:
            evidence["rawIconCropPixelSha256"] = _pixel_hash(raw_regions[slot_id]["icon"])
            evidence["canonicalIconCropPixelSha256"] = _pixel_hash(canonical_regions[slot_id]["icon"])
            evidence["rawQuantityCropPixelSha256"] = _pixel_hash(raw_regions[slot_id]["quantity"])
            evidence["canonicalQuantityCropPixelSha256"] = _pixel_hash(canonical_regions[slot_id]["quantity"])
        if (type(prediction.get("x")) is int and type(prediction.get("y")) is int
                and type(slot_width) is int):
            # R0's recognition input is the 43x43 inner crop after removing the
            # one-pixel border from its measured outer slot.
            r0_crop = image.crop((prediction["x"] + 1, prediction["y"] + 1,
                                  prediction["x"] + slot_width - 1, prediction["y"] + slot_width - 1))
            evidence["r0InputCropPixelSha256"] = _pixel_hash(r0_crop)
        evidence_slots[slot_id] = evidence

    report["t006aEvidence"] = {
        "engineStage": "T006A_R0_EVIDENCE_ONLY",
        "candidateImprovement": False,
        "policyApproved": False,
        "highAuthority": False,
        "automationEligible": False,
        "normalizationIsSideChannel": True,
        "geometry": measured.as_metadata(),
        "slots": evidence_slots,
    }
    return patch, report
