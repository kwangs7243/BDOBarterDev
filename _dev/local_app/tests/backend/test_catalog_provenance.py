from __future__ import annotations

import json
from pathlib import Path
import unittest

from local_app.backend.catalog_provenance import compute_catalog_provenance_v2


ROOT = Path(__file__).resolve().parents[2]
VECTORS = json.loads((ROOT / "tests" / "fixtures" / "catalog-provenance-v2-vectors.json").read_text(encoding="utf-8"))


class CatalogProvenanceV2Tests(unittest.TestCase):
    def test_shared_golden_vector_and_line_endings(self):
        text = VECTORS["catalogText"]
        expected = VECTORS["expectedSha256"]
        self.assertEqual(compute_catalog_provenance_v2(text.encode("utf-8"))["sha256"], expected)
        self.assertEqual(compute_catalog_provenance_v2(text.replace("\n", "\r\n").encode("utf-8"))["sha256"], expected)
        mixed = text.replace("\n", "\r\n", 1)
        self.assertEqual(compute_catalog_provenance_v2(mixed.encode("utf-8"))["sha256"], expected)

    def test_changes_change_digest(self):
        text = VECTORS["catalogText"]
        expected = VECTORS["expectedSha256"]
        for changed in (text[:-1], text + " ", text.replace("[\"품목 A\"]", "[ \"품목 A\"]"),
                        text.replace("품목 A", "품목 B"), text.replace("\"masterData\":", "\"specialItems\":[],\"masterData\":")):
            self.assertNotEqual(compute_catalog_provenance_v2(changed.encode("utf-8"))["sha256"], expected)

    def test_invalid_source_rejected(self):
        text = VECTORS["catalogText"]
        invalid_inputs = (text.replace("\n", "\r", 1).encode("utf-8"), b"\xef\xbb\xbf" + text.encode("utf-8"),
                          b"\xc3(", b"{broken json", VECTORS["invalidCatalogText"].encode("utf-8"),
                          text.replace("\"품목 A\"", "NaN").encode("utf-8"))
        for raw in invalid_inputs:
            with self.subTest(raw=raw[:16]):
                with self.assertRaises((TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError)):
                    compute_catalog_provenance_v2(raw)


if __name__ == "__main__":
    unittest.main()
