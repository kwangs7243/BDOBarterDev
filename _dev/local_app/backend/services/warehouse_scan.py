"""Validate one warehouse PNG and adapt the existing scanner's in-memory result."""
from __future__ import annotations

import tempfile
import threading
from pathlib import Path
from typing import Any

from PIL import Image, UnidentifiedImageError
from werkzeug.datastructures import FileStorage

from tools.warehouse_patch.warehouse_patch import GridDetectionError, convert

MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_IMAGE_PIXELS = 32_000_000
_SCAN_LOCK = threading.Lock()


class WarehouseScanError(Exception):
    def __init__(self, code: str, message: str, status: int):
        super().__init__(message)
        self.code = code
        self.status = status


def _write_limited_upload(upload: FileStorage, path: Path) -> int:
    total = 0
    with path.open("wb") as target:
        while True:
            chunk = upload.stream.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                raise WarehouseScanError("file_too_large", "PNG 파일은 20 MiB 이하여야 합니다.", 413)
            target.write(chunk)
    if total == 0:
        raise WarehouseScanError("corrupt_image", "빈 파일은 판독할 수 없습니다.", 422)
    return total


def _validate_png(path: Path) -> None:
    try:
        with Image.open(path) as image:
            if image.format != "PNG":
                raise WarehouseScanError("unsupported_image_format", "PNG 이미지 한 장만 지원합니다.", 415)
            if getattr(image, "n_frames", 1) != 1:
                raise WarehouseScanError("unsupported_image_format", "애니메이션 PNG는 지원하지 않습니다.", 415)
            width, height = image.size
            if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                raise WarehouseScanError("image_pixel_limit", "이미지는 32메가픽셀 이하여야 합니다.", 413)
            image.verify()
        # verify() checks the container; load() also forces pixel decoding before scanner invocation.
        with Image.open(path) as image:
            image.load()
    except WarehouseScanError:
        raise
    except Image.DecompressionBombError as error:
        raise WarehouseScanError("image_pixel_limit", "이미지는 32메가픽셀 이하여야 합니다.", 413) from error
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, EOFError) as error:
        raise WarehouseScanError("corrupt_image", "손상되었거나 해독할 수 없는 PNG입니다.", 422) from error


def _validate_scanner_patch(patch: Any, report: Any, catalog: dict[str, int]) -> None:
    if not isinstance(patch, dict) or set(patch) != {"type", "version", "items"}:
        raise RuntimeError("scanner returned an invalid PATCH envelope")
    if patch["type"] != "master_inventory_patch" or type(patch["version"]) is not int or patch["version"] != 1:
        raise RuntimeError("scanner returned an unsupported PATCH version")
    items = patch["items"]
    if not isinstance(items, dict):
        raise RuntimeError("scanner returned invalid PATCH items")
    for name, quantity in items.items():
        if name not in catalog or catalog[name] not in {1, 2, 3, 4}:
            raise RuntimeError("scanner returned an unsupported warehouse item")
        if type(quantity) is not int or quantity < 0:
            raise RuntimeError("scanner returned an invalid warehouse quantity")
    if not isinstance(report, dict) or not isinstance(report.get("slots"), list):
        raise RuntimeError("scanner returned an invalid review report")
    confirmed: dict[str, int] = {}
    for slot in report["slots"]:
        if not isinstance(slot, dict) or slot.get("decision") != "MATCH":
            continue
        name = slot.get("finalItem")
        quantity = slot.get("quantity")
        if name not in catalog or catalog[name] not in {1, 2, 3, 4}:
            raise RuntimeError("scanner MATCH report contains an unsupported item")
        if not isinstance(quantity, dict) or quantity.get("status") != "QUANTITY_MATCH":
            raise RuntimeError("scanner MATCH report has no confirmed quantity")
        value = quantity.get("value")
        if type(value) is not int or value < 0 or name in confirmed:
            raise RuntimeError("scanner MATCH report contains an invalid or duplicate item")
        confirmed[name] = value
    if confirmed != items:
        raise RuntimeError("scanner PATCH does not match its confirmed report rows")


def _safe_report(report: dict[str, Any]) -> dict[str, Any]:
    safe = dict(report)
    original_input = report.get("input", {})
    safe["input"] = {key: value for key, value in original_input.items() if key != "path"}
    return safe


def process_warehouse_upload(
    upload: FileStorage,
    catalog: dict[str, int],
    *,
    temporary_directory: str | Path | None = None,
    record_scan=None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Run the local converter with one validated temporary PNG."""
    if not upload.filename or Path(upload.filename).suffix.lower() != ".png":
        raise WarehouseScanError("unsupported_image_format", "PNG 이미지 한 장만 지원합니다.", 415)
    if not _SCAN_LOCK.acquire(blocking=False):
        raise WarehouseScanError("scan_in_progress", "다른 창고 이미지 판독이 진행 중입니다.", 503)

    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix="bdo-warehouse-", suffix=".png", dir=temporary_directory, delete=False
        ) as handle:
            temp_path = Path(handle.name)
        _write_limited_upload(upload, temp_path)
        _validate_png(temp_path)

        root = Path(__file__).resolve().parents[3]
        reference_json = root / "reference" / "barter_items.json"
        templates_path = root / "recognition-local" / "models" / "warehouse" / "quantity_templates.npz"
        if not templates_path.is_file():
            templates_path = root / "tools" / "warehouse_patch" / "quantity_templates.npz"
        patch, report = convert(temp_path, reference_json, templates_path)
        _validate_scanner_patch(patch, report, catalog)
        safe = _safe_report(report)
        if record_scan is not None:
            from hashlib import sha256
            sources = [reference_json, templates_path, root / "tools" / "warehouse_patch" / "warehouse_patch.py"]
            sources.extend(sorted((root / "reference" / "icons").glob("*.webp")))
            provenance = {"formatVersion": 1, "engine": "local-template-matching", "sourceHashes": {str(source.relative_to(root)).replace("\\", "/"): sha256(source.read_bytes()).hexdigest() for source in sources}}
            safe["scanId"] = record_scan(temp_path.read_bytes(), safe, provenance)
        return patch, safe
    except GridDetectionError as error:
        raise WarehouseScanError("SLOT_GRID_DETECTION_FAILED", "창고 칸의 테두리를 찾지 못했습니다. 칸이 가려지거나 잘리지 않도록 창고 영역을 캡처해 주세요.", 422) from error
    except WarehouseScanError:
        raise
    except Exception as error:
        raise WarehouseScanError("scanner_processing_failed", "창고 이미지 판독 중 오류가 발생했습니다.", 503) from error
    finally:
        try:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
        finally:
            _SCAN_LOCK.release()
