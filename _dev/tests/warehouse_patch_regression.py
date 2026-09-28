#!/usr/bin/env python3
"""End-to-end regression for the standalone warehouse patch prototype."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
TOOL_DIR = ROOT / "tools" / "warehouse_patch"
sys.path.insert(0, str(TOOL_DIR))

from warehouse_patch import GridDetectionError, convert, detect_grid  # noqa: E402


PYTHON_RESULT = ROOT / "test_results" / "warehouse_patch" / "regression_result.json"
REFERENCE = ROOT / "reference" / "barter_items.json"
TEMPLATES = TOOL_DIR / "quantity_templates.npz"
EXPECTED_HTML_SHA256 = "b5f29bfec3c3ebbd4257a42c1e311c28ce8e38d78dfb7a55279bd455a59e6598"
SEED_IDS = {800012, 800011, 800009}
GENERAL = "GENERAL"


DEDICATED_IDS = [
    [800059, 800059, 800065, 800064, 800064, 800048, 800051, 800053, 800054],
    [800050, 800045, 800052, 800055, 800049, 800047, 800043, 800056, 800036],
    [800041, 800040, 800035, 800029, 800032, 800037, 800033, 800030, 800042],
    [800034, 800038, 800031, 800039, 800026, 800024, 800023, 800022, 800015],
    [800028, 800020, 800018, 800019, 800016, 800025, 800027, 800017, 800012],
    [800002, 800007, 800004, 800005, 800011, 800001, 800013, 800008, 800009],
    [800006, 800003, 800014, 800010, None, None, None, None, None],
]

DEDICATED_QTY = [
    [None, None, None, None, None, 4, 4, 25, 7],
    [5, 8, 2, 1, 22, 20, 2, 3, 3],
    [9, 15, 44, 5, 20, 34, 23, 22, 34],
    [21, 22, 38, 1, 39, 38, 46, 20, 44],
    [57, 71, 42, 80, 36, 24, 8, 41, 26],
    [31, 27, 59, 46, 35, 37, 23, 25, 48],
    [43, 53, 31, 41, None, None, None, None, None],
]

MIXED_IDS = [
    [800059, 800059, 800065, 800064, 800064, 800048, 800051, 800053, 800054],
    [800050, 800045, 800052, 800049, 800047, 800043, 800056, 800036, 800041],
    [800040, 800035, 800029, 800032, 800037, 800033, 800030, 800042, 800034],
    [800038, 800031, 800039, GENERAL, GENERAL, GENERAL, 800026, 800024, 800023],
    [800022, 800015, 800028, 800020, 800018, 800019, 800016, 800025, 800027],
    [800017, GENERAL, 800012, 800002, 800007, 800004, 800005, 800011, 800001],
    [800013, 800008, 800009, 800006, 800003, 800014, 800010, GENERAL, None],
]

MIXED_QTY = [
    [None, None, None, None, None, 4, 4, 25, 6],
    [5, 7, 2, 22, 10, 2, 3, 3, 9],
    [15, 35, 5, 20, 18, 23, 4, 33, 20],
    [10, 38, 1, 10, 13, 9, 19, 38, 46],
    [26, 44, 57, 74, 42, 80, 36, 24, 8],
    [41, 3785, 26, 31, 17, 49, 41, 35, 37],
    [23, 25, 48, 43, 38, 31, 31, 17, None],
]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load_items() -> dict[int, dict]:
    payload = json.loads(REFERENCE.read_text(encoding="utf-8"))
    require(len(payload["items"]) == 70, "Reference must contain exactly 70 items")
    return {int(item["itemId"]): item for item in payload["items"]}


def expected_patch(layout: list[list[object]], quantities: list[list[int | None]], items: dict[int, dict]) -> dict[str, int]:
    result: dict[str, int] = {}
    for row, qty_row in zip(layout, quantities):
        for value, quantity in zip(row, qty_row):
            if not isinstance(value, int):
                continue
            item = items[value]
            if item["inventoryTarget"] and value not in SEED_IDS:
                require(quantity is not None, f"Missing quantity for {item['programName']}")
                result[item["programName"]] = quantity
    return dict(sorted(result.items()))


def evaluate_fixture(name: str, layout: list[list[object]], quantities: list[list[int | None]], items: dict[int, dict]) -> tuple[dict, dict]:
    image_path = ROOT / "fixtures" / "warehouse_patch" / f"{name}.png"
    patch, report = convert(image_path, REFERENCE, TEMPLATES)
    by_slot = {entry["slot"]: entry for entry in report["slots"]}
    target_slots = 0
    target_top1_correct = 0
    quantity_correct = 0
    tier5_excluded = 0
    general_excluded = 0
    general_quantity_correct = 0
    icon_unknown = 0
    empty = 0
    wrong_names: list[str] = []
    quantity_errors: list[str] = []

    for row_index, (row, qty_row) in enumerate(zip(layout, quantities), 1):
        for column_index, (expected, expected_quantity) in enumerate(zip(row, qty_row), 1):
            slot_name = f"R{row_index}C{column_index}"
            actual = by_slot[slot_name]
            if expected is None:
                require(actual["decision"] == "EMPTY", f"{name} {slot_name}: expected EMPTY, got {actual['decision']}")
                empty += 1
                continue
            if expected == GENERAL:
                require(actual["decision"] == "ICON_MATCH_UNKNOWN", f"{name} {slot_name}: general item was not rejected")
                quantity = actual.get("quantity", {})
                require(
                    quantity.get("status") == "QUANTITY_MATCH" and quantity.get("value") == expected_quantity,
                    f"{name} {slot_name}: independent general-item quantity {quantity.get('value')} != {expected_quantity}",
                )
                general_excluded += 1
                general_quantity_correct += 1
                continue

            item = items[int(expected)]
            if item["inventoryTarget"]:
                target_slots += 1
                if actual.get("bestItemId") == expected:
                    target_top1_correct += 1
                else:
                    wrong_names.append(f"{slot_name}: {actual.get('bestCandidate')} != {item['programName']}")
                quantity = actual.get("quantity", {})
                if quantity.get("status") == "QUANTITY_MATCH" and quantity.get("value") == expected_quantity:
                    quantity_correct += 1
                else:
                    quantity_errors.append(f"{slot_name}: {quantity.get('value')} != {expected_quantity}")
                expected_decision = "ICON_MATCH_UNKNOWN" if expected in SEED_IDS else "MATCH"
                require(actual["decision"] == expected_decision, f"{name} {slot_name}: unexpected decision {actual['decision']}")
                if expected_decision == "ICON_MATCH_UNKNOWN":
                    icon_unknown += 1
            else:
                require(actual.get("bestItemId") == expected, f"{name} {slot_name}: tier-5 identity mismatch")
                require(actual["decision"] == "TIER5_IGNORE", f"{name} {slot_name}: tier-5 item not excluded")
                tier5_excluded += 1

    expected_items = expected_patch(layout, quantities, items)
    require(patch["items"] == expected_items, f"{name}: final patch differs from ground truth")
    require(not wrong_names, f"{name}: wrong item names: {wrong_names}")
    require(not quantity_errors, f"{name}: quantity errors: {quantity_errors}")
    summary = {
        "grid": report["grid"],
        "targetSlots": target_slots,
        "top1ItemIdentityCorrect": target_top1_correct,
        "quantityCorrect": quantity_correct,
        "patchItems": len(patch["items"]),
        "tier5Excluded": tier5_excluded,
        "generalExcluded": general_excluded,
        "generalQuantityCorrect": general_quantity_correct,
        "iconUnknown": icon_unknown,
        "empty": empty,
        "wrongItemNames": wrong_names,
        "quantityErrors": quantity_errors,
        "phantomItems": [],
    }
    return patch, summary


def canonical_patch_bytes(patch: dict) -> bytes:
    return (json.dumps(patch, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def main() -> int:
    items = load_items()
    html_hash = hashlib.sha256((ROOT / "BDO_물교_v1.0.html").read_bytes()).hexdigest()
    require(html_hash == EXPECTED_HTML_SHA256, "Protected HTML changed")
    dedicated_patch, dedicated = evaluate_fixture("barter_only", DEDICATED_IDS, DEDICATED_QTY, items)
    mixed_patch, mixed = evaluate_fixture("mixed", MIXED_IDS, MIXED_QTY, items)

    hashes: list[str] = []
    for _ in range(10):
        patch, _ = convert(ROOT / "fixtures" / "warehouse_patch" / "barter_only.png", REFERENCE, TEMPLATES)
        hashes.append(hashlib.sha256(canonical_patch_bytes(patch)).hexdigest())
    require(len(set(hashes)) == 1, "Ten identical-input runs produced different JSON")

    base_image = Image.open(ROOT / "fixtures" / "warehouse_patch" / "barter_only.png").convert("RGB")
    xgrid, ygrid, _ = detect_grid(base_image)
    width = (xgrid.count - 1) * xgrid.period + xgrid.width
    height = (ygrid.count - 1) * ygrid.period + ygrid.width
    origin_zero = base_image.crop((xgrid.origin, ygrid.origin, xgrid.origin + width, ygrid.origin + height))
    origin_zero_path = ROOT / "test_results" / "warehouse_patch" / "origin_zero.png"
    origin_zero.save(origin_zero_path)
    padded = Image.new("RGB", (base_image.width + 31, base_image.height + 29), (16, 17, 20))
    padded.paste(base_image, (13, 17))
    padded_path = ROOT / "test_results" / "warehouse_patch" / "padded_origin.png"
    padded.save(padded_path)
    origin_results = []
    for label, path, expected_origin in [
        ("near_zero", origin_zero_path, (0, 0)),
        ("left_top_padding", padded_path, (xgrid.origin + 13, ygrid.origin + 17)),
    ]:
        patch, report = convert(path, REFERENCE, TEMPLATES)
        require(patch == dedicated_patch, f"{label}: origin change altered PATCH")
        actual_origin = (report["grid"]["origin"]["x"], report["grid"]["origin"]["y"])
        require(actual_origin == expected_origin, f"{label}: wrong grid origin {actual_origin}")
        origin_results.append({"case": label, "origin": list(actual_origin), "patchIdentical": True})
    origin_results.extend([
        {"case": "actual_barter_only", "origin": [dedicated["grid"]["origin"]["x"], dedicated["grid"]["origin"]["y"]], "patchVerified": True},
        {"case": "actual_mixed", "origin": [mixed["grid"]["origin"]["x"], mixed["grid"]["origin"]["y"]], "patchVerified": True},
    ])

    duplicate_image = base_image.copy()
    source_box = (xgrid.origin, ygrid.origin + xgrid.period, xgrid.origin + xgrid.width, ygrid.origin + xgrid.period + xgrid.width)
    duplicated_slot = base_image.crop(source_box)
    duplicate_image.paste(duplicated_slot, (xgrid.origin + 4 * xgrid.period, ygrid.origin + 6 * ygrid.period))
    duplicate_path = ROOT / "test_results" / "warehouse_patch" / "duplicate_case.png"
    duplicate_image.save(duplicate_path)
    duplicate_patch, duplicate_report = convert(duplicate_path, REFERENCE, TEMPLATES)
    duplicate_name = items[800050]["programName"]
    require(duplicate_report["duplicates"].get(duplicate_name) == ["R2C1", "R7C5"], "Duplicate item was not isolated")
    require(duplicate_name not in duplicate_patch["items"], "Duplicate item leaked into PATCH")

    blank_path = ROOT / "test_results" / "warehouse_patch" / "no_grid.png"
    Image.new("RGB", (320, 240), (16, 17, 20)).save(blank_path)
    failed_as_expected = False
    try:
        convert(blank_path, REFERENCE, TEMPLATES)
    except GridDetectionError as error:
        failed_as_expected = str(error) == "SLOT_GRID_DETECTION_FAILED"
    require(failed_as_expected, "Missing grid did not stop with SLOT_GRID_DETECTION_FAILED")

    result = {
        "status": "PASS",
        "protectedHtml": {"sha256": html_hash, "unchanged": True},
        "referenceItems": len(items),
        "barterOnly": dedicated,
        "mixed": mixed,
        "determinism": {"runs": 10, "identical": len(set(hashes)) == 1, "sha256": hashes[0]},
        "originRegression": origin_results,
        "duplicatePolicy": {"detected": True, "item": duplicate_name, "slots": ["R2C1", "R7C5"], "excludedFromPatch": True},
        "gridFailurePolicy": {"result": "SLOT_GRID_DETECTION_FAILED", "passed": failed_as_expected},
    }
    PYTHON_RESULT.parent.mkdir(parents=True, exist_ok=True)
    PYTHON_RESULT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
