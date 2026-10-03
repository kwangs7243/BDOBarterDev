import json
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import Mock, patch

from PIL import Image
from local_app.tools.trade_live_ocr import _requirement_crop, apply_trade_rules, detect_live_rows, read_count, read_numeric, correct_name, recognize_live

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures/trade-recognition"


class LiveListTests(unittest.TestCase):
    def rule_fields(self, source, destination, ambiguous=False):
        return {"fromItem": {"corrected": source, "reviewRequired": ambiguous},
                "toItem": {"corrected": destination, "reviewRequired": False},
                "reqAmount": {"rawOCR": "7", "corrected": None, "reviewRequired": True},
                "yield": {"rawOCR": "62", "corrected": None, "reviewRequired": True}}

    def test_fixed_ratios_preserve_ocr_and_clear_numeric_review(self):
        stages = {str(stage): stage for stage in range(1, 8)}
        for source, destination, amount in ((3, 4, 2), (4, 5, 1), (5, 6, 1), (6, 7, 1)):
            with self.subTest(source=source, destination=destination):
                fields = apply_trade_rules(self.rule_fields(str(source), str(destination)), stages)
                self.assertEqual(fields["reqAmount"]["corrected"], 1)
                self.assertEqual(fields["yield"]["corrected"], amount)
                self.assertFalse(fields["yield"]["reviewRequired"])
                self.assertEqual(fields["yield"]["rawOCR"], "62")
                self.assertEqual(fields["yield"]["valueSource"], "TRADE_RULE")

    def test_land_result_fixed_and_variable_results_still_read(self):
        stages = {str(stage): stage for stage in range(1, 8)}
        fields = apply_trade_rules(self.rule_fields("land", "1"), stages)
        self.assertIsNone(fields["reqAmount"]["corrected"])
        self.assertEqual(fields["yield"]["corrected"], 1)
        self.assertFalse(fields["yield"]["reviewRequired"])
        for source, destination in (("1", "2"), ("2", "3"), ("4", "coin"), ("4", "general")):
            fields = self.rule_fields(source, destination)
            fields["yield"].update(corrected=100, reviewRequired=True)
            apply_trade_rules(fields, stages)
            self.assertEqual(fields["yield"]["corrected"], 100)
            self.assertTrue(fields["yield"]["reviewRequired"])
            self.assertEqual(fields["reqAmount"]["corrected"], 1)
        fields = apply_trade_rules(self.rule_fields("3", "4", ambiguous=True), stages)
        self.assertEqual(fields["reqAmount"]["corrected"], 1)
        self.assertIsNone(fields["yield"]["corrected"])

    def test_two_or_three_requires_recognition_and_preserves_conflicts(self):
        fake_cv2 = SimpleNamespace(connectedComponentsWithStats=lambda mask, _: (1, mask, [], None))
        for constrained, expected, review in ((["2", "2", "2"], 2, False), (["3", "3", "3"], 3, False),
                                              (["2", "3", "2"], 2, True), (["23", "23", "23"], None, True)):
            reader = Mock()
            reader.read.side_effect = [("62", .95)] * 5 + [(value, .95) for value in constrained]
            with self.subTest(constrained=constrained), patch.dict("sys.modules", {"cv2": fake_cv2}):
                result = read_numeric(reader, Image.new("RGB", (20, 15), "white"), "yield", allowed_values=(2, 3))
            self.assertEqual(result["corrected"], expected)
            self.assertEqual(result["reviewRequired"], review)
            self.assertEqual(result["rawOCR"], "62")
        reader = Mock()
        reader.read.side_effect = [("3", .95)] * 3 + [("62", .95)] * 2 + [("2", .95)] * 3
        with patch.dict("sys.modules", {"cv2": fake_cv2}):
            result = read_numeric(reader, Image.new("RGB", (20, 15), "white"), "yield", allowed_values=(2, 3))
        self.assertTrue(result["reviewRequired"])

    def test_stage1_output_cannot_fix_requirement_from_a_misidentified_input(self):
        fields = self.rule_fields("1", "1")
        fields["reqAmount"].update(corrected=500, reviewRequired=True)
        apply_trade_rules(fields, {"1": 1})
        self.assertEqual(fields["reqAmount"]["corrected"], 500)
        self.assertTrue(fields["reqAmount"]["reviewRequired"])
        self.assertNotEqual(fields["reqAmount"].get("valueSource"), "TRADE_RULE")

    def test_requirement_crop_expands_only_when_its_digits_reach_the_edge(self):
        complete = Image.new("RGB", (300, 100), "black")
        for x in range(90, 95):
            for y in range(60, 70):
                complete.putpixel((x, y), (255, 255, 255))
        self.assertEqual(_requirement_crop(complete).size, (12, 29))
        clipped = Image.new("RGB", (300, 100), "black")
        for x in range(97, 101):
            for y in range(60, 70):
                clipped.putpixel((x, y), (255, 255, 255))
        expanded = _requirement_crop(clipped)
        self.assertEqual(expanded.size, (16, 38))
        self.assertEqual(expanded.getpixel((14, 10)), (255, 255, 255))

    def test_requirement_crop_edge_cannot_be_certain_despite_matching_high_scores(self):
        fake_cv2 = SimpleNamespace(connectedComponentsWithStats=lambda mask, _: (1, mask, [], None))
        image = Image.new("RGB", (20, 15), "black")
        for x in range(15, 20):
            for y in range(5, 12):
                image.putpixel((x, y), (255, 255, 255))
        reader = Mock()
        reader.read.return_value = ("11", .99)
        with patch.dict("sys.modules", {"cv2": fake_cv2}):
            result = read_numeric(reader, image, "reqAmount")
        self.assertEqual(result["corrected"], 11)
        self.assertTrue(result["reviewRequired"])
        self.assertGreater(result["confidence"], .98)
        self.assertTrue(json.loads(json.dumps(result))["reviewRequired"])

    def test_requirement_crop_finds_digit_after_a_blank_boundary(self):
        row = Image.new("RGB", (1000, 100), "black")
        for left, right in [(315, 321), (331, 337)]:
            for x in range(left, right):
                for y in range(60, 74):
                    row.putpixel((x, y), (255, 255, 255))
        crop = _requirement_crop(row)
        self.assertEqual(crop.size, (53, 38))
        self.assertEqual(crop.getpixel((49, 10)), (255, 255, 255))

    def test_requirement_enhancement_cannot_hide_conflicting_digits(self):
        fake_cv2 = SimpleNamespace(connectedComponentsWithStats=lambda mask, _: (1, mask, [], None))
        image = Image.new("RGB", (20, 15), "black")
        for x in range(8, 13):
            for y in range(5, 12):
                image.putpixel((x, y), (255, 255, 255))
        reader = Mock()
        reader.read.side_effect = [("11", .99)] * 3 + [("10", .95)] * 5
        with patch.dict("sys.modules", {"cv2": fake_cv2}):
            result = read_numeric(reader, image, "reqAmount")
        self.assertEqual(result["corrected"], 10)
        self.assertTrue(result["reviewRequired"])

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
