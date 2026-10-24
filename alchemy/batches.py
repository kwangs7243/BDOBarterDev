"""Exact planning for the verified ten/hundred-unit recipe families."""
from fractions import Fraction
from math import ceil, floor

from .catalog import AlchemyError, ingredients, integer

POLICIES = {"manual", "surplus", "shortage", "calls"}


def choose_batches(options, missing, policy, stock, substitutions=None):
    if policy not in POLICIES - {"manual"}:
        raise AlchemyError("배치 선택 기준을 확인하세요.")
    small, large = sorted(options, key=lambda r: r["output_quantity"])
    a, b = small["output_quantity"], large["output_quantity"]
    if (a, b) != (10, 100):
        raise AlchemyError("자동 배치는 검증된 10개·100개 제작식만 지원합니다.")
    inputs = [{v["item_id"]: v["quantity"] for v in ingredients(r, substitutions)} for r in (small, large)]
    small_calls = (missing + a - 1) // a
    last = (missing + b - 1) // b
    # Up to the final all-large candidate, small calls decrease linearly by ten.
    # Shortage is convex and piecewise linear; endpoints and stock breakpoints suffice.
    candidates = {0, max(0, last - 1), last}
    for item in inputs[0].keys() | inputs[1].keys():
        slope = inputs[1].get(item, 0) - 10 * inputs[0].get(item, 0)
        available = stock.get(item)
        if slope and available is not None:
            point = Fraction(available - small_calls * inputs[0].get(item, 0), slope)
            candidates.update((floor(point), ceil(point)))

    def evaluate(y):
        x = max(0, small_calls - 10 * y)
        needed = {i: x * inputs[0].get(i, 0) + y * inputs[1].get(i, 0) for i in inputs[0].keys() | inputs[1].keys()}
        shortage = sum(max(0, q - stock[i]) for i, q in needed.items() if stock.get(i) is not None)
        unknown = sum(q for i, q in needed.items() if stock.get(i) is None)
        excess, calls = x * a + y * b - missing, x + y
        scores = {"surplus": (excess, unknown, shortage, calls),
                  "shortage": (unknown, shortage, excess, calls),
                  "calls": (calls, excess, unknown, shortage)}
        return scores[policy], x, y

    _, x, y = min(evaluate(y) for y in candidates if 0 <= y <= last)
    return [{"recipe_id": r["recipe_id"], "calls": integer(n, "배치 횟수", minimum=1),
             "planned_output": integer(n * r["output_quantity"], "예상 산출 합계"),
             "inputs": [{**v, "quantity": integer(v["quantity"] * n, "배치 재료 합계")} for v in ingredients(r, substitutions)]}
            for r, n in ((large, y), (small, x)) if n]
