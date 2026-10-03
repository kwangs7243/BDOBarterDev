import json
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from local_app.tools.trade_live_ocr import detect_live_rows, read_count, correct_name, recognize_live

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures/trade-recognition"


class LiveListTests(unittest.TestCase):
    def test_real_rows_survive_image_scaling(self):
        mapping = json.loads((FIXTURES / "live-list-mapping.json").read_text(encoding="utf-8"))
        for capture in mapping:
            with Image.open(FIXTURES / capture["image"]) as source:
                image = source.convert("RGB")
            for scale in (.65, .8, 1, 1.3, 1.7):
                with self.subTest(image=capture["image"], scale=scale):
                    resized = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
                    self.assertEqual(len(detect_live_rows(resized)), len(capture["oracleRows"]))

    def test_different_capture_dimensions(self):
        mapping = json.loads((FIXTURES / "live-list-mapping.json").read_text(encoding="utf-8"))
        with Image.open(FIXTURES / mapping[0]["image"]) as source:
            image = source.convert("RGB")
        for size in ((997, 466), (1301, 777), (811, 503)):
            with self.subTest(size=size):
                self.assertEqual(len(detect_live_rows(image.resize(size, Image.Resampling.LANCZOS))), 6)

    def test_zero_and_unknown_are_distinct(self):
        with patch("local_app.tools.trade_live_ocr.read_name", return_value=("남은 교환 횟수: 0회", .95)):
            self.assertEqual(read_count(None, None)["corrected"], 0)
        with patch("local_app.tools.trade_live_ocr.read_name", return_value=("남은 교환 횟수: ?회", .95)):
            self.assertIsNone(read_count(None, None)["corrected"])

    def test_unmatched_name_remains_visible(self):
        self.assertEqual(correct_name("새로운 물품", ["고대 항아리 파편"]), ("새로운 물품", True))
        self.assertEqual(correct_name("오색빛 실타레", ["오색빛 실타래"]), ("오색빛 실타래", False))

    def test_field_failure_cannot_hide_rows(self):
        mapping = json.loads((FIXTURES / "live-list-mapping.json").read_text(encoding="utf-8"))
        with patch("local_app.tools.trade_live_ocr.LocalReader"), \
                patch("local_app.tools.trade_live_ocr.read_numeric", side_effect=RuntimeError("numeric failure")), \
                patch("local_app.tools.trade_live_ocr.read_name", return_value=("파라타마 섬", .95)):
            result = recognize_live([{"captureId": "one", "imagePath": FIXTURES / mapping[0]["image"]}], Path("unused"), "batch")
        self.assertEqual(len(result["rows"]), 6)
        self.assertEqual(result["rows"][0]["fields"]["island"]["corrected"], "파라타마 섬")
        self.assertIsNone(result["rows"][0]["fields"]["reqAmount"]["corrected"])
        self.assertTrue(result["rows"][0]["fields"]["reqAmount"]["reviewRequired"])

    def test_catalog_failure_preserves_raw_names(self):
        mapping = json.loads((FIXTURES / "live-list-mapping.json").read_text(encoding="utf-8"))
        with patch("local_app.tools.trade_live_ocr.LocalReader"), \
                patch("pathlib.Path.read_text", side_effect=OSError("catalog unavailable")), \
                patch("local_app.tools.trade_live_ocr.read_numeric", side_effect=RuntimeError("numeric failure")), \
                patch("local_app.tools.trade_live_ocr.read_name", return_value=("알 수 없는 새 물품", .95)):
            result = recognize_live([{"captureId": "one", "imagePath": FIXTURES / mapping[0]["image"]}], Path("unused"), "batch")
        self.assertEqual(len(result["rows"]), 6)
        field = result["rows"][0]["fields"]["fromItem"]
        self.assertEqual(field["corrected"], "알 수 없는 새 물품")
        self.assertTrue(field["reviewRequired"])


if __name__ == "__main__":
    unittest.main()
