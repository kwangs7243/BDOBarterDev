from __future__ import annotations

import io
import struct
import tempfile
import threading
import unittest
import zlib
from collections import Counter
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from local_app.backend.app import PORT, create_app
from local_app.backend.services import warehouse_scan
from local_app.backend.storage import load_catalog
from tools.warehouse_patch.warehouse_patch import convert


ROOT = Path(__file__).resolve().parents[3]
REFERENCE = ROOT / "reference" / "barter_items.json"
TEMPLATES = ROOT / "tools" / "warehouse_patch" / "quantity_templates.npz"


class WarehouseScanApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="bdo-spec003-")
        self.root = Path(self.temporary.name)
        self.database = self.root / "isolated.sqlite3"
        self.upload_dir = self.root / "uploads"
        self.upload_dir.mkdir()
        self.local = f"http://127.0.0.1:{PORT}"
        self.app = create_app(self.database, testing=True)
        self.app.config["WAREHOUSE_SCAN_TEMP_DIR"] = str(self.upload_dir)
        self.client = self.app.test_client()
        self.catalog, _ = load_catalog()

    def tearDown(self):
        self.temporary.cleanup()

    def scan(self, filename: str, data: bytes, content_type="image/png"):
        return self.client.post(
            "/api/warehouse-scan", base_url=self.local,
            data={"image": (io.BytesIO(data), filename, content_type)},
            headers={"Origin": self.local},
        )

    def test_real_fixture_api_matches_direct_convert_and_keeps_only_safe_patch(self):
        for filename in ("barter_only.png", "mixed.png"):
            with self.subTest(filename=filename):
                path = ROOT / "local_app" / "tests" / "fixtures" / "warehouse_patch" / filename
                expected_patch, expected_report = convert(path, REFERENCE, TEMPLATES)
                response = self.scan(filename, path.read_bytes())
                self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
                payload = response.get_json()
                self.assertEqual(payload["patch"], expected_patch)
                self.assertEqual([slot["decision"] for slot in payload["report"]["slots"]], [slot["decision"] for slot in expected_report["slots"]])
                self.assertNotIn("path", payload["report"]["input"])
                self.assertNotIn(str(self.upload_dir), response.get_data(as_text=True))
                self.assertTrue(all(self.catalog[name] in {1, 2, 3, 4} for name in payload["patch"]["items"]))
                decisions = Counter(slot["decision"] for slot in payload["report"]["slots"])
                self.assertGreater(decisions["TIER5_IGNORE"], 0)
                self.assertFalse(any(slot.get("finalItem") in payload["patch"]["items"] and slot["decision"] != "MATCH" for slot in payload["report"]["slots"]))
                self.assertEqual(list(self.upload_dir.iterdir()), [])

    def test_missing_multiple_unsupported_and_corrupt_uploads_are_rejected(self):
        before = self.client.get("/api/bootstrap", base_url=self.local).get_json()
        no_file = self.client.post("/api/warehouse-scan", base_url=self.local, data={"note": "empty"}, content_type="multipart/form-data", headers={"Origin": self.local})
        self.assertEqual(no_file.status_code, 422)
        self.assertEqual(no_file.get_json()["error"]["code"], "missing_file")
        multiple = self.client.post(
            "/api/warehouse-scan", base_url=self.local,
            data={"first": (io.BytesIO(b"a"), "a.png"), "second": (io.BytesIO(b"b"), "b.png")},
            headers={"Origin": self.local},
        )
        self.assertEqual(multiple.get_json()["error"]["code"], "single_file_required")
        wrong_extension = self.scan("photo.jpg", b"not an image", "image/jpeg")
        self.assertEqual(wrong_extension.status_code, 415)
        self.assertEqual(wrong_extension.get_json()["error"]["code"], "unsupported_image_format")
        jpeg = io.BytesIO()
        Image.new("RGB", (12, 12), (30, 40, 50)).save(jpeg, format="JPEG")
        mismatched_format = self.scan("not-really.png", jpeg.getvalue(), "image/png")
        self.assertEqual(mismatched_format.status_code, 415)
        self.assertEqual(mismatched_format.get_json()["error"]["code"], "unsupported_image_format")
        corrupt = self.scan("broken.png", b"\x89PNG\r\n\x1a\ncorrupt")
        self.assertEqual(corrupt.status_code, 422)
        self.assertEqual(corrupt.get_json()["error"]["code"], "corrupt_image")
        self.assertEqual(list(self.upload_dir.iterdir()), [])
        after = self.client.get("/api/bootstrap", base_url=self.local).get_json()
        self.assertEqual(after, before)

    def test_only_scanner_confirmed_match_rows_are_accepted(self):
        match_name = next(name for name, tier in self.catalog.items() if tier == 1)
        tier5_name = next(name for name, tier in self.catalog.items() if tier == 5)
        other_names = [name for name, tier in self.catalog.items() if tier < 5 and name != match_name]
        report = {"input": {"path": "private-temp-path"}, "slots": [
            {"decision": "MATCH", "finalItem": match_name, "quantity": {"status": "QUANTITY_MATCH", "value": 7}},
            {"decision": "TIER5_IGNORE", "finalItem": tier5_name, "quantity": {"status": "QUANTITY_MATCH", "value": 8}},
            {"decision": "ICON_MATCH_UNKNOWN", "bestCandidate": other_names[0]},
            {"decision": "QUANTITY_UNKNOWN", "finalItem": other_names[1], "quantity": {"status": "QUANTITY_UNKNOWN", "value": None}},
            {"decision": "DUPLICATE_ITEM_DETECTED", "finalItem": other_names[2]},
        ]}
        expected = {"type": "master_inventory_patch", "version": 1, "items": {match_name: 7}}
        fixture = (ROOT / "local_app/tests/fixtures/warehouse_patch/barter_only.png").read_bytes()
        with patch.object(warehouse_scan, "convert", return_value=(expected, report)):
            response = self.scan("confirmed.png", fixture)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()["patch"], expected)
        self.assertNotIn("private-temp-path", response.get_data(as_text=True))
        self.assertEqual(list(self.upload_dir.iterdir()), [])

        invalid = {"type": "master_inventory_patch", "version": 1, "items": {other_names[1]: 9}}
        with patch.object(warehouse_scan, "convert", return_value=(invalid, report)):
            rejected = self.scan("unsafe.png", fixture)
        self.assertEqual(rejected.status_code, 503)
        self.assertEqual(rejected.get_json()["error"]["code"], "scanner_processing_failed")
        self.assertEqual(list(self.upload_dir.iterdir()), [])

    def test_file_size_pixel_grid_and_scanner_failures_clean_temporary_uploads(self):
        before = self.client.get("/api/bootstrap", base_url=self.local).get_json()
        large = self.scan("large.png", b"x" * (20 * 1024 * 1024 + 1))
        self.assertEqual(large.status_code, 413, large.get_data(as_text=True))
        self.assertEqual(large.get_json()["error"]["code"], "file_too_large")
        large.close()

        oversized_pixels = io.BytesIO()
        Image.new("RGB", (6401, 5000), (1, 2, 3)).save(oversized_pixels, format="PNG")
        pixel_response = self.scan("pixels.png", oversized_pixels.getvalue())
        self.assertEqual(pixel_response.status_code, 413, pixel_response.get_data(as_text=True))
        self.assertEqual(pixel_response.get_json()["error"]["code"], "image_pixel_limit")

        def png_chunk(kind, payload):
            chunk = kind + payload
            return struct.pack(">I", len(payload)) + chunk + struct.pack(">I", zlib.crc32(chunk) & 0xffffffff)
        ihdr = struct.pack(">IIBBBBB", 20_000, 20_000, 8, 2, 0, 0, 0)
        bomb_png = b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", ihdr) + png_chunk(b"IDAT", zlib.compress(b"")) + png_chunk(b"IEND", b"")
        bomb_response = self.scan("bomb.png", bomb_png)
        self.assertEqual(bomb_response.status_code, 413, bomb_response.get_data(as_text=True))
        self.assertEqual(bomb_response.get_json()["error"]["code"], "image_pixel_limit")

        blank = io.BytesIO()
        Image.new("RGB", (240, 240), (20, 20, 20)).save(blank, format="PNG")
        grid_response = self.scan("nogrid.png", blank.getvalue())
        self.assertEqual(grid_response.status_code, 422)
        self.assertEqual(grid_response.get_json()["error"]["code"], "SLOT_GRID_DETECTION_FAILED")

        path_seen = []
        def fail_convert(image_path, _reference, _templates):
            path_seen.append(image_path)
            self.assertTrue(image_path.exists())
            raise RuntimeError("test scanner failure")
        with patch.object(warehouse_scan, "convert", side_effect=fail_convert):
            scanner_failure = self.scan("valid.png", (ROOT / "local_app/tests/fixtures/warehouse_patch/barter_only.png").read_bytes())
        self.assertEqual(scanner_failure.status_code, 503)
        self.assertEqual(scanner_failure.get_json()["error"]["code"], "scanner_processing_failed")
        self.assertEqual(len(path_seen), 1)
        self.assertFalse(path_seen[0].exists())
        self.assertEqual(list(self.upload_dir.iterdir()), [])
        after = self.client.get("/api/bootstrap", base_url=self.local).get_json()
        self.assertEqual(after, before)

    def test_concurrent_scan_is_rejected_without_creating_a_second_temp_file(self):
        entered = threading.Event()
        release = threading.Event()
        fixture = (ROOT / "local_app/tests/fixtures/warehouse_patch/barter_only.png").read_bytes()
        def slow_convert(_image_path, _reference, _templates):
            entered.set()
            release.wait(timeout=5)
            return {"type": "master_inventory_patch", "version": 1, "items": {}}, {"input": {}, "slots": []}

        first_result = []
        with patch.object(warehouse_scan, "convert", side_effect=slow_convert):
            thread = threading.Thread(target=lambda: first_result.append(self.scan("first.png", fixture)), daemon=True)
            thread.start()
            self.assertTrue(entered.wait(timeout=5))
            second_client = self.app.test_client()
            second = second_client.post(
                "/api/warehouse-scan", base_url=self.local,
                data={"image": (io.BytesIO(fixture), "second.png", "image/png")},
                headers={"Origin": self.local},
            )
            release.set()
            thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(second.status_code, 503)
        self.assertEqual(second.get_json()["error"]["code"], "scan_in_progress")
        self.assertEqual(first_result[0].status_code, 200)
        self.assertEqual(list(self.upload_dir.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
