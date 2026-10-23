from copy import deepcopy
from contextlib import closing
import unittest
from alchemy.engine import plan_goals
from alchemy.storage import AlchemyStorage, encode
from alchemy.yields import observed_yields, recipe_key
from local_app.tests.backend.test_alchemy_engine import sample, goal
from local_app.tests.backend import test_alchemy_storage as storage_tests


class ObservedYieldTests(unittest.TestCase):
    def test_weighted_mean_partial_cancel_and_recipe_identity(self):
        r = sample()["recipes"][1]
        def job(calls, output, **extra):
            return {"recipe": r, "inputs_per_call": r["inputs"], "status": "completed", "executed_calls": calls, "outputs": {"A": output, "X": 999}, **extra}
        stats = observed_yields([job(10,23), job(90,180), job(30,0,status="cancelled"), job(0,0), job(2,4,status="in_progress")])
        row = stats[recipe_key(r)]
        self.assertEqual((row["total_calls"],row["total_output"],row["jobs"],row["average"]),(100,203,2,2.03))
        changed = deepcopy(r);changed["inputs"][0]["quantity"] = 3
        self.assertNotEqual(recipe_key(r),recipe_key(changed))
        self.assertNotEqual(recipe_key(r),recipe_key(r,[{"item_id":"X","quantity":2}]))

    def test_observed_rate_changes_nested_demand_without_inventory_mutation(self):
        c=sample();r=c["recipes"][1];stats={recipe_key(r):{"average":2.5,"total_calls":10,"total_output":25,"jobs":1}}
        stock={"F":0,"A":7,"B":0};before=deepcopy(stock)
        rows={r["item_id"]:r for r in plan_goals(c,stock,[goal()],stats)[0]["rows"]}
        self.assertEqual((rows["A"]["missing"],rows["A"]["calls"],rows["B"]["need"]),(23,10,20))
        self.assertEqual(rows["A"]["yield_source"],"history");self.assertEqual(stock,before)
        rows=plan_goals(c,stock,[goal(expected_yields={"a":1})],stats)[0]["rows"]
        self.assertEqual(next(r for r in rows if r["item_id"]=="A")["calls"],23)

    def test_zero_observations_hold_plan_and_fixed_yields_remain_fixed(self):
        c=sample();r=c["recipes"][1];stats={recipe_key(r):{"average":0,"total_calls":2,"total_output":0,"jobs":1}}
        rows=plan_goals(c,{"F":0,"A":0,"B":10},[goal()],stats)[0]["rows"]
        a=next(v for v in rows if v["item_id"]=="A");self.assertEqual(a["status"],"yield_unknown");self.assertIsNone(a["calls"])
        self.assertFalse(any(v["item_id"]=="B" for v in rows))
        r=c["recipes"][0];stats={recipe_key(r):{"average":4,"total_calls":1,"total_output":4,"jobs":1}}
        self.assertEqual(plan_goals(c,{"F":0,"A":0,"B":0},[goal()],stats)[0]["rows"][0]["calls"],10)


class DurableYieldTests(unittest.TestCase):
    setUp = storage_tests.AlchemyStorageTests.setUp
    tearDown = storage_tests.AlchemyStorageTests.tearDown
    change = storage_tests.AlchemyStorageTests.change
    def test_latest_corrected_job_is_counted_once_and_survives_restore(self):
        j=self.change("start",recipe_id="a",calls=10)["job"]
        request={"mutationId":"same-finish","baseRevision":self.store.snapshot()["revision"],"job_id":j["job_id"],"executed_calls":4,"outputs":{"A":9,"X":1}}
        self.store.mutate("finish",request);self.store.mutate("finish",request)
        k=recipe_key(self.catalog["recipes"][1]);self.assertEqual(self.store.snapshot()["yield_statistics"][k]["average"],2.25)
        self.change("correct",job_id=j["job_id"],outputs={"A":8},reason="actual total")
        saved=self.store.export();self.store=AlchemyStorage(self.path)
        stat=self.store.snapshot()["yield_statistics"][k];self.assertEqual((stat["jobs"],stat["total_calls"],stat["total_output"]),(1,4,8))
        self.change("restore",backup=saved)
        self.assertEqual(self.store.snapshot()["yield_statistics"][k],stat)
        j=self.change("start",recipe_id="a",calls=1)["job"];self.change("cancel",job_id=j["job_id"])
        self.assertEqual(self.store.snapshot()["yield_statistics"][k],stat)
        self.change("inventory",changes=[{"item_id":"A","quantity":0}])
        self.change("goal",item_id="F",quantity=10)
        rows={r["item_id"]:r for r in self.store.plans()[0]["rows"]};self.assertEqual(rows["A"]["calls"],15)
