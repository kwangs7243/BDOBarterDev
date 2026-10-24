"""Pure, inventory-first DAG planning with ordered reservations across goals."""
from __future__ import annotations

import math
from .catalog import AlchemyError, MAX_QUANTITY, graph, ingredients, integer
from .yields import recipe_key
from .batches import choose_batches


def plan_goals(catalog, inventory, goals, yield_statistics=None):
    yield_statistics = yield_statistics or {}
    pool = dict(inventory)
    results = []
    for goal in sorted((g for g in goals if g.get("active", True)), key=lambda g: (g.get("priority", 0), g["goal_id"])):
        root = goal["item_id"]
        target = integer(goal["quantity"], "목표량", minimum=1)
        base = goal.get("baseline", 0) if goal.get("mode") == "additional" else 0
        if base is None:
            raise AlchemyError("추가 제작 목표를 만들기 전에 현재 재고를 확인하세요.")
        required = target + base
        integer(required, "최종 확보 목표", minimum=1)
        actual = inventory.get(root)
        progress = None if actual is None else min(target, max(0, actual - base))
        result = {"goal_id": goal["goal_id"], "target": target, "actual": actual,
                  "progress": progress, "progress_percent": None if progress is None else round(100 * progress / target, 1),
                  "rows": [], "reservations": {}, "errors": []}
        try:
            items, selected, order = graph(catalog, root, goal.get("choices"), goal.get("substitutions"), goal.get("batch_policies"))
            demand = {root: required}
            goal_pool = dict(pool)
            execution_pool = dict(pool)
            for item in order:
                needed = demand.get(item, 0)
                if not needed:
                    continue
                integer(needed, "합산 필요량")
                available = pool.get(item)
                unknown = available is None
                allocated = min(available or 0, needed)
                pool[item] = None if unknown else available - allocated
                if allocated:
                    result["reservations"][item] = allocated
                missing = None if unknown and not goal.get("assume_unknown_zero", False) else needed - allocated
                recipe = selected.get(item)
                row = {"item_id": item, "name": items[item]["name"], "icon": items[item].get("icon"), "need": needed, "stock": inventory.get(item),
                       "available": available, "allocated": allocated, "missing": missing, "unknown": unknown,
                       "recipe_id": recipe["recipe_id"] if recipe else None, "calls": None, "planned_output": 0,
                       "surplus": 0, "ready": False, "plan_ready": False, "batches": [], "inputs": [], "status": "unknown" if missing is None else "supplied" if missing == 0 else "short"}
                if missing and recipe:
                    if recipe.get("verification") != "verified" or recipe.get("update_conflict"):
                        row["status"] = "unverified"
                        result["errors"].append(f'{row["name"]}: 레시피 검증 필요')
                    else:
                        output = recipe["output_quantity"]
                        consumed = ingredients(recipe, goal.get("substitutions"))
                        observed = yield_statistics.get(recipe_key(recipe, consumed))
                        source = "fixed" if recipe["yield_type"] == "fixed" else "minimum"
                        expectation = goal.get("expected_yields", {}).get(recipe["recipe_id"])
                        if recipe["yield_type"] != "fixed" and expectation is None and observed:
                            output = observed["average"]
                            source = "history"
                        row.update(yield_source=source, yield_history=observed, expected_yield=output,
                                   estimate=source != "fixed")
                        if output == 0 and expectation is None:
                            row["status"] = "yield_unknown"
                            result["rows"].append(row)
                            continue
                        if expectation is not None:
                            if type(expectation) not in (int, float) or not math.isfinite(expectation) or expectation < output or expectation > MAX_QUANTITY:
                                raise AlchemyError("기대 수율은 보장 산출 이상인 유한한 수여야 합니다.")
                            if recipe["yield_type"] == "fixed" and expectation != output:
                                raise AlchemyError("고정 제작식의 산출 단위는 변경할 수 없습니다.")
                            output = expectation
                            source = "manual"
                        calls = ((missing * observed["total_calls"] + observed["total_output"] - 1) // observed["total_output"]
                                 if source == "history" else math.ceil(missing / output))
                        integer(calls, "제작 횟수", minimum=1)
                        row.update(calls=calls, planned_output=calls * output, surplus=calls * output - missing,
                                   expected_yield=output, estimate=source != "fixed", yield_source=source)
                        row["inputs"] = [{**v, "quantity": integer(v["quantity"] * calls, "제작 재료 합계")}
                                         for v in ingredients(recipe, goal.get("substitutions"))]
                        if recipe.get("_batch_options"):
                            row["batches"] = choose_batches(recipe["_batch_options"], missing,
                                goal["batch_policies"][item], goal_pool, goal.get("substitutions"))
                            merged = {}
                            for batch in row["batches"]:
                                for v in batch["inputs"]:
                                    merged[v["item_id"]] = integer(merged.get(v["item_id"], 0) + v["quantity"], "배치 합산 재료")
                            planned_output = sum(b["planned_output"] for b in row["batches"])
                            row.update(calls=sum(b["calls"] for b in row["batches"]), planned_output=planned_output,
                                       surplus=planned_output-missing, inputs=[{"item_id": i, "quantity": q} for i, q in merged.items()],
                                       recipe_id=row["batches"][0]["recipe_id"],
                                       expected_yield=planned_output / sum(b["calls"] for b in row["batches"]) if len(row["batches"]) == 1 else None)
                        else:
                            row["batches"] = [{"recipe_id": recipe["recipe_id"], "calls": calls,
                                               "planned_output": row["planned_output"], "inputs": row["inputs"]}]
                        row["ready"] = all(goal_pool.get(v["item_id"]) is not None and goal_pool[v["item_id"]] >= v["quantity"] for v in row["inputs"])
                        row["plan_ready"] = all(execution_pool.get(v["item_id"]) is not None and execution_pool[v["item_id"]] >= v["quantity"] for v in row["inputs"])
                        if row["plan_ready"]:
                            for v in row["inputs"]:
                                execution_pool[v["item_id"]] -= v["quantity"]
                        row["status"] = "ready" if row["ready"] else "short"
                        for v in row["inputs"]:
                            demand[v["item_id"]] = demand.get(v["item_id"], 0) + v["quantity"]
                result["rows"].append(row)
                if item == root:
                    result["progress"] = None if unknown else min(target, max(0, allocated - base))
                    result["progress_percent"] = None if unknown else round(100 * result["progress"] / target, 1)
            result["base_materials"] = [r for r in result["rows"] if not r["recipe_id"]]
            result["has_unknown"] = any(r["unknown"] for r in result["rows"])
            result["materials_satisfied"] = not result["errors"] and not result["has_unknown"] and not any(r["status"] in {"yield_unknown", "unverified"} for r in result["rows"]) and all(r["missing"] == 0 for r in result["base_materials"])
            result["has_estimates"] = any(r.get("estimate") for r in result["rows"])
        except AlchemyError as error:
            result["errors"].append(str(error))
            result["base_materials"] = []
            # An invalid plan cannot reserve stock from later goals.
            for item, amount in result["reservations"].items():
                pool[item] += amount
            result["reservations"] = {}
        results.append(result)
    return results
