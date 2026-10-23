from copy import deepcopy
import unittest

from alchemy.catalog import AlchemyError, graph, ingredients, load_catalog, validate_catalog
from alchemy.engine import plan_goals


def sample():
    return {"version": "test", "items": [{"item_id": i, "name": i} for i in "FAXB"], "recipes": [
        {"recipe_id": "f", "output_item_id": "F", "output_quantity": 1, "inputs": [{"item_id": "A", "quantity": 3}],
         "yield_type": "fixed", "verification": "verified", "source_urls": ["https://example.com"], "verified_at": "2026-10-23"},
        {"recipe_id": "a", "output_item_id": "A", "output_quantity": 1, "inputs": [{"item_id": "B", "quantity": 2}],
         "yield_type": "variable", "verification": "verified", "source_urls": ["https://example.com"], "verified_at": "2026-10-23"}], "products": ["F"]}


def goal(**kwargs):
    return {"goal_id": "one", "item_id": "F", "quantity": 10, **kwargs}


class AlchemyEngineTests(unittest.TestCase):
    def test_t01_intermediate_stock_reduces_raw_materials_without_mutating_inputs(self):
        data, stock, goals = sample(), {"F": 0, "A": 7, "B": 10}, [goal()]
        before = deepcopy((data, stock, goals))
        rows = {r["item_id"]: r for r in plan_goals(data, stock, goals)[0]["rows"]}
        self.assertEqual((rows["A"]["need"], rows["A"]["missing"], rows["A"]["calls"]), (30, 23, 23))
        self.assertEqual((rows["B"]["need"], rows["B"]["missing"]), (46, 36))
        self.assertEqual((data, stock, goals), before)

    def test_t02_shared_intermediate_is_aggregated_before_rounding(self):
        data = sample()
        data["recipes"][0]["inputs"].append({"item_id": "X", "quantity": 1})
        data["recipes"].append({**data["recipes"][0], "recipe_id": "x", "output_item_id": "X", "inputs": [{"item_id": "A", "quantity": 2}]})
        rows = {r["item_id"]: r for r in plan_goals(data, {"F": 0, "X": 0, "A": 7, "B": 10}, [goal(quantity=1)])[0]["rows"]}
        self.assertEqual(rows["A"]["need"], 5)
        self.assertEqual(rows["A"]["allocated"], 5)
        self.assertNotIn("B", rows)

    def test_t03_t09_priorities_and_supply(self):
        data, stock = sample(), {"F": 0, "A": 7, "B": 10}
        plans = plan_goals(data, stock, [goal(quantity=1, priority=0), goal(goal_id="two", quantity=2, priority=1)])
        self.assertEqual([p["reservations"].get("A", 0) for p in plans], [3, 4])
        old = next(r for r in plans[1]["rows"] if r["item_id"] == "B")["missing"]
        new = plan_goals(data, {**stock, "B": 20}, [goal(quantity=1), goal(goal_id="two", quantity=2, priority=1)])
        self.assertLessEqual(next(r for r in new[1]["rows"] if r["item_id"] == "B")["missing"], old)
        completed = plan_goals(data, {**stock, "F": 10}, [goal(), goal(goal_id="two", priority=1)])
        self.assertEqual([p["progress"] for p in completed], [10, 0])

    def test_t14_cycles_and_unverified_recipes_block_execution_plans(self):
        data = sample()
        data["recipes"][1]["inputs"] = [{"item_id": "F", "quantity": 1}]
        with self.assertRaisesRegex(AlchemyError, "순환"):
            graph(data, "F")
        self.assertTrue(plan_goals(data, {}, [goal()])[0]["errors"])
        data = sample()
        data["recipes"][0]["verification"] = "review_required"
        result = plan_goals(data, {"F": 0}, [goal()])[0]
        self.assertEqual(result["rows"][0]["status"], "unverified")

    def test_t21_unknown_is_not_zero_and_expectations_are_plan_only(self):
        result = plan_goals(sample(), {}, [goal()])[0]
        self.assertIsNone(result["rows"][0]["missing"])
        result = plan_goals(sample(), {"F": 0, "A": 0, "B": 0}, [goal(expected_yields={"a": 2.5})])[0]
        self.assertEqual(next(r for r in result["rows"] if r["item_id"] == "A")["calls"], 12)

    def test_t10_t11_t12_real_batch_and_alternate_routes(self):
        data = load_catalog()
        items, recipes = validate_catalog(data)
        names = {v["name"]: i for i, v in items.items()}
        for p in data["products"]:
            graph(data, p)
        kama = [r for r in recipes.values() if r["output_item_id"] == names["[파티] 조화의 영약 - 카마실비아"]]
        hundred = next(r for r in kama if r["output_quantity"] == 100)
        self.assertEqual(next(v["quantity"] for v in hundred["inputs"] if v["item_id"] == names["이벨랍의 정수"]), 10)
        for name in ("녹음의 향수", "드넓은 대양의 영약", "열망의 향수", "관철의 향수"):
            options = [r for r in recipes.values() if r["output_item_id"] == names[name]]
            self.assertEqual(len(options), 2)
            self.assertNotEqual(options[0]["inputs"], options[1]["inputs"])
        rage = names["격노의 영약"]
        ten = next(r for r in recipes.values() if r["output_item_id"] == rage and r["output_quantity"] == 10)
        stock = {i: 0 for i in items}
        rows = plan_goals(data, stock, [goal(item_id=rage, quantity=25, choices={rage: ten["recipe_id"]})])[0]["rows"]
        self.assertEqual((rows[0]["calls"], rows[0]["planned_output"], rows[0]["surplus"]), (3, 30, 5))

    def test_t13_substitution_consumes_whole_recipe_input_only(self):
        data = load_catalog()
        rage = next(i["item_id"] for i in data["items"] if i["name"] == "격노의 영약")
        recipe = next(r for r in data["recipes"] if r["output_item_id"] == rage and r["output_quantity"] == 10)
        row = next(v for v in recipe["inputs"] if v.get("alternatives"))
        alternate = row["alternatives"][0]
        self.assertEqual((row["quantity"], alternate["quantity"]), (30, 10))
        actual = ingredients(recipe, {f'{recipe["recipe_id"]}:{row["item_id"]}': alternate["item_id"]})
        self.assertIn({"item_id": alternate["item_id"], "quantity": alternate["quantity"]}, actual)
        with self.assertRaises(AlchemyError):
            ingredients(recipe, {f'{recipe["recipe_id"]}:{row["item_id"]}': "unregistered"})

    def test_real_ocean_and_verdure_routes_use_exact_ingredients(self):
        data = load_catalog()
        ids = {i["name"]: i["item_id"] for i in data["items"]}
        stock = {i: 0 for i in ids.values()}
        for target, expected in (("드넓은 대양의 영약", [("대양의 영약", 8), ("넓은 대양의 영약", 4)]),
                                 ("녹음의 향수", [("마력이 깃든 감람석 가루", 100), ("마력이 깃든 감람석 가루", 70)])):
            options = [r for r in data["recipes"] if r["output_item_id"] == ids[target]]
            for r, (ingredient, amount) in zip(options, expected):
                result = plan_goals(data, stock, [goal(item_id=ids[target], quantity=2, choices={ids[target]: r["recipe_id"]})])[0]
                self.assertFalse(result["errors"])
                self.assertEqual(next(v["need"] for v in result["rows"] if v["item_id"] == ids[ingredient]), amount)
