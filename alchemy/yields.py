"""Yield estimates derived from the latest durable result of each completed job."""
from __future__ import annotations

import hashlib
import json
from .catalog import ingredients


def recipe_key(recipe, consumed=None):
    # A route, recipe edit, or different substitute material is a separate sample population.
    data = {k: recipe.get(k) for k in ("recipe_id", "output_item_id", "output_quantity", "yield_type", "method")}
    data["inputs"] = sorted((v["item_id"], v["quantity"]) for v in (ingredients(recipe) if consumed is None else consumed))
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def observed_yields(jobs):
    results = {}
    for job in jobs:
        calls = job.get("executed_calls")
        if job.get("status") != "completed" or type(calls) is not int or calls <= 0:
            continue
        recipe = job["recipe"]
        output = job.get("outputs", {}).get(recipe["output_item_id"])
        if type(output) is not int or output < 0:
            continue
        key = recipe_key(recipe, job["inputs_per_call"])
        row = results.setdefault(key, {"recipe_id": recipe["recipe_id"], "total_calls": 0, "total_output": 0, "jobs": 0})
        row["total_calls"] += calls
        row["total_output"] += output
        row["jobs"] += 1
    for row in results.values():
        row["average"] = row["total_output"] / row["total_calls"]
    return results
