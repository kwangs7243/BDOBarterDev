import json
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import Mock, patch

from PIL import Image
from local_app.tools.trade_live_ocr import _requirement_crop, apply_trade_rules, detect_live_rows, read_count, read_numeric, read_requirement, read_yield, correct_name, read_catalog_name, recognize_live

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
        self.assertEqual(fields["yield"]["corrected"], 2)

    def test_only_confirmed_special_outputs_have_fixed_result(self):
        names = ["유실된 무역품 상자", "화려한 진주 결정", "화려한 암염 주괴", "파도의 블랙스톤", "까마귀 주화"]
        stages = {name: "coin" if "까마귀" in name else "special" for name in names}
        for name in names:
            fields = apply_trade_rules(self.rule_fields("land", name), stages)
            self.assertEqual(fields["reqAmount"]["corrected"], 1)
            self.assertEqual(fields["yield"]["corrected"], None if name in names[3:] else 1)

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

    def test_weaker_artwork_readings_cannot_replace_unanimous_digits(self):
        fake_cv2 = SimpleNamespace(connectedComponentsWithStats=lambda mask, _: (1, mask, [], None))
        image = Image.new("RGB", (20, 15), "black")
        for x in range(8, 13):
            for y in range(5, 12):
                image.putpixel((x, y), (255, 255, 255))
        reader = Mock()
        reader.read.side_effect = [("10", .99)] * 3 + [("410", .77)] * 2 + [("그", .6)] * 2 + [("410", .72)]
        with patch.dict("sys.modules", {"cv2": fake_cv2}):
            result = read_numeric(reader, image, "reqAmount")
        self.assertEqual(result["corrected"], 10)
        self.assertTrue(result["reviewRequired"])
        self.assertGreater(result["confidence"], .98)

    def test_strong_lower_baseline_can_restore_missing_digit(self):
        fake_cv2 = SimpleNamespace(connectedComponentsWithStats=lambda mask, _: (1, mask, [], None))
        image = Image.new("RGB", (20, 15), "black")
        for x in range(8, 13):
            for y in range(5, 12):
                image.putpixel((x, y), (255, 255, 255))
        reader = Mock()
        reader.read.side_effect = [("20", .99)] * 3 + [("7200", .85)] * 2 + [("200", .99)] * 2 + [("7200", .83)]
        with patch.dict("sys.modules", {"cv2": fake_cv2}):
            result = read_numeric(reader, image, "reqAmount")
        self.assertEqual(result["corrected"], 200)
        self.assertTrue(result["reviewRequired"])

    def test_outline_candidate_improves_value_and_preserves_original_evidence_and_review(self):
        primary = {"rawOCR": "20", "corrected": 20, "confidence": .99, "reviewRequired": True,
                   "variants": [{"text": "20", "confidence": .99}]}
        token = {"corrected": None, "reviewRequired": True, "variants": []}
        outlined = {"corrected": 200, "confidence": .98,
                    "variants": [{"text": "200", "confidence": .98, "method": "outline-mask"}]}
        with patch("local_app.tools.trade_live_ocr.read_numeric", return_value=primary), \
                patch("local_app.tools.trade_live_ocr.read_quantity_token", return_value=token), \
                patch("local_app.tools.trade_live_ocr.read_outlined_requirement", return_value=outlined):
            result = read_requirement(None, Image.new("RGB", (1000, 70)))
        self.assertEqual(result["corrected"], 200)
        self.assertEqual(result["rawOCR"], "20")
        self.assertEqual(result["variants"], primary["variants"] + outlined["variants"])
        self.assertTrue(result["reviewRequired"])
        self.assertEqual(primary["corrected"], 20)

    def test_confirmed_requirement_bypasses_outline_candidate(self):
        primary = {"rawOCR": "100", "corrected": 100, "confidence": .99, "reviewRequired": False, "variants": []}
        token = {"corrected": None, "reviewRequired": True, "variants": []}
        with patch("local_app.tools.trade_live_ocr.read_numeric", return_value=primary), \
                patch("local_app.tools.trade_live_ocr.read_quantity_token", return_value=token), \
                patch("local_app.tools.trade_live_ocr.read_outlined_requirement") as outlined:
            result = read_requirement(None, Image.new("RGB", (1000, 70)))
        self.assertEqual(result, primary)
        outlined.assert_not_called()

    def test_unresolved_outline_does_not_replace_existing_requirement(self):
        primary = {"rawOCR": "", "corrected": None, "confidence": 0, "reviewRequired": True, "variants": []}
        token = {"corrected": None, "reviewRequired": True, "variants": []}
        with patch("local_app.tools.trade_live_ocr.read_numeric", return_value=primary), \
                patch("local_app.tools.trade_live_ocr.read_quantity_token", return_value=token), \
                patch("local_app.tools.trade_live_ocr.read_outlined_requirement", return_value=None):
            result = read_requirement(None, Image.new("RGB", (1000, 70)))
        self.assertEqual(result, primary)

    def test_small_font_candidate_cannot_become_automatic_truth(self):
        primary = {"rawOCR": "1", "corrected": 1, "confidence": .99, "reviewRequired": True, "variants": []}
        token = {"corrected": None, "reviewRequired": True, "variants": []}
        with patch("local_app.tools.trade_live_ocr.read_numeric", return_value=primary), \
                patch("local_app.tools.trade_live_ocr.read_quantity_token", return_value=token), \
                patch("local_app.tools.trade_live_ocr.read_outlined_requirement", return_value={"corrected": 1, "confidence": 1, "variants": []}):
            result = read_requirement(None, Image.new("RGB", (658, 47)))
        self.assertEqual(result["corrected"], 1)
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

    def test_verified_land_names_require_exact_letters_and_restore_spacing(self):
        self.assertEqual(correct_name("구리주괴", [], ["구리 주괴"]), ("구리 주괴", False))
        self.assertEqual(correct_name("영롱한비취", [], ["영롱한 비취"]), ("영롱한 비취", False))
        self.assertEqual(correct_name("구리주과", [], ["구리 주괴"]), ("구리주과", True))

    def test_unique_master_prefix_is_completed_without_review(self):
        for raw in ("까마귀 상단 소유의", "까마귀 상단 소유의 ..."):
            value, review = correct_name(raw, ["까마귀 상단 소유의 선박"])
            self.assertEqual(value, "까마귀 상단 소유의 선박")
            self.assertFalse(review)
        self.assertTrue(correct_name("까마귀 상단 소유의 ...", ["까마귀 상단 소유의 선박", "까마귀 상단 소유의 상자"])[1])

    def test_damaged_stage_label_does_not_corrupt_item_name(self):
        for raw in ("[2뒤계] 균형잡헌 돌탑", "[2딘계균형잡힌 돌탑", "[/난계| 균형잡힌 돌탑"):
            self.assertEqual(correct_name(raw, ["균형잡힌 돌탑"]), ("균형잡힌 돌탑", False))
        self.assertEqual(correct_name("[S단제] 정체불명의 암석", ["정체불명의 암석"]), ("정체불명의 암석", False))
        self.assertEqual(correct_name("[5단계]102년 묵은 황금초", ["102년 묵은 황금초"]), ("102년 묵은 황금초", False))

    def test_color_agreement_restores_name_lost_by_thresholding(self):
        reader = Mock()
        reader.read.side_effect = [("[2단계] 정제된 식수", .91), ("[2단계] 정제된 식수", .90)]
        with patch("local_app.tools.trade_live_ocr.read_name", return_value=("[2단계]정세된스수", .88)):
            result = read_catalog_name(reader, Image.new("RGB", (30, 20)), ["정제된 식수"])
        self.assertEqual(result["corrected"], "정제된 식수")
        self.assertFalse(result["reviewRequired"])
        self.assertEqual(result["rawOCR"], "[2단계]정세된스수")
        self.assertEqual(len(result["variants"]), 3)

    def test_agreement_cannot_confirm_unknown_names(self):
        for raw in ("완전히 새로운 품목",):
            reader = Mock(); reader.read.return_value = (raw, .99)
            with patch("local_app.tools.trade_live_ocr.read_name", return_value=(raw, .99)):
                result = read_catalog_name(reader, Image.new("RGB", (30, 20)), ["고대인을 형상화한 초상화"])
            self.assertTrue(result["reviewRequired"])

    def test_known_name_conflict_remains_reviewable(self):
        reader = Mock(); reader.read.return_value = ("다른 물품", .99)
        with patch("local_app.tools.trade_live_ocr.read_name", return_value=("원본물퐁", .89)):
            result = read_catalog_name(reader, Image.new("RGB", (30, 20)), ["원본 물품", "다른 물품"])
        self.assertEqual(result["corrected"], "다른 물품")
        self.assertTrue(result["reviewRequired"])

    def test_unresolved_name_keeps_independently_recognized_stage_for_fixed_ratio(self):
        reader = Mock(); reader.read.return_value = ("[4단계] 금주화가 담긴 낡은", .96)
        with patch("local_app.tools.trade_live_ocr.read_name", return_value=("[4단계] 금주화가 담긴 낡은", .96)):
            source = read_catalog_name(reader, Image.new("RGB", (30, 20)), ["금주화가 담긴 낡은 상자", "금주화가 담긴 낡은 항아리"])
        self.assertTrue(source["reviewRequired"])
        self.assertEqual(source["recognizedStage"], 4)
        fields = self.rule_fields("unknown", "5")
        fields["fromItem"] = source
        apply_trade_rules(fields, {"5": 5})
        self.assertEqual(fields["yield"]["corrected"], 1)
        self.assertTrue(fields["fromItem"]["reviewRequired"])

    def test_count_color_agreement_restores_missing_one_without_inventing_zero(self):
        reader = Mock(); reader.read.return_value = ("남은 교환 횟수: 1회", .92)
        with patch("local_app.tools.trade_live_ocr.read_name", return_value=("남은교환횟수:회", .93)):
            result = read_count(reader, Image.new("RGB", (30, 20)))
        self.assertEqual(result["corrected"], 1)
        self.assertFalse(result["reviewRequired"])

    def test_single_digit_fallback_cannot_truncate_unconstrained_currency_amount(self):
        unknown = {"rawOCR": "", "corrected": None, "reviewRequired": True, "confidence": 0, "variants": []}
        with patch("local_app.tools.trade_live_ocr.read_numeric", return_value=unknown) as read, \
                patch("local_app.tools.trade_live_ocr.read_quantity_token", return_value=unknown):
            result = read_yield(None, Image.new("RGB", (1000, 100)))
        self.assertIsNone(result["corrected"])
        self.assertEqual(read.call_count, 1)

    def test_constrained_yield_uses_cleaner_crop_and_keeps_conflicts(self):
        unknown = {"rawOCR": "3", "corrected": None, "reviewRequired": True, "confidence": 0, "variants": []}
        three = {"rawOCR": "3", "corrected": 3, "reviewRequired": False, "confidence": .98,
                 "variants": [{"text": "3", "confidence": .98}]}
        two = {**three, "corrected": 2, "variants": [{"text": "2", "confidence": .97}]}
        for alternate, review in ((three, False), (two, True)):
            with patch("local_app.tools.trade_live_ocr.read_numeric", side_effect=[unknown, three, alternate]), \
                    patch("local_app.tools.trade_live_ocr.read_quantity_token", return_value=unknown):
                result = read_yield(None, Image.new("RGB", (1000, 100)), (2, 3))
            self.assertEqual(result["corrected"], 3)
            self.assertEqual(result["reviewRequired"], review)

    def test_uncertain_known_item_names_do_not_require_fixed_quantity_review(self):
        stages = {str(stage): stage for stage in range(1, 8)}
        stages["유실된 무역품 상자"] = "special"
        for source, destination, amount in (("land", "1", 1), ("3", "4", 2), ("5", "6", 1),
                                             ("6", "7", 1), ("1", "유실된 무역품 상자", 1)):
            fields = self.rule_fields(source, destination, ambiguous=True)
            fields["toItem"]["reviewRequired"] = True
            apply_trade_rules(fields, stages)
            self.assertTrue(fields["toItem"]["reviewRequired"])
            self.assertFalse(fields["yield"]["reviewRequired"])
            self.assertEqual(fields["yield"]["corrected"], amount)
            self.assertEqual(fields["reqAmount"]["reviewRequired"], destination == "1")

    def test_complete_edge_row_is_preserved_but_cut_row_is_not(self):
        image = Image.new("RGB", (652, 308), (40, 40, 40))
        for top in (12, 61, 111, 160, 210, 259):
            for x in range(image.width):
                image.putpixel((x, top), (90, 90, 90))
        self.assertEqual(len(detect_live_rows(image)), 6)
        self.assertEqual(len(detect_live_rows(image.crop((0, 0, 652, 281)))), 5)

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
