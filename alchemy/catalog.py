"""Versioned recipe data; loaded per request rather than held in a global store."""
from __future__ import annotations

import json
from pathlib import Path
import re

MAX_QUANTITY = 1_000_000_000


class AlchemyError(Exception):
    def __init__(self, message, status=400, code="invalid_alchemy_request"):
        super().__init__(message)
        self.status, self.code = status, code


def integer(value, name="수량", *, minimum=0):
    if type(value) is not int or not minimum <= value <= MAX_QUANTITY:
        raise AlchemyError(f"{name}: {minimum:,}~{MAX_QUANTITY:,} 사이의 정수를 입력하세요.")
    return value


def load_catalog():
    return json.loads((Path(__file__).parent / "data/catalog.json").read_text(encoding="utf-8"))


def validate_catalog(data):
    if not isinstance(data, dict) or not isinstance(data.get("version"), str):
        raise AlchemyError("레시피 데이터 버전이 필요합니다.")
    if not isinstance(data.get("items"), list) or not isinstance(data.get("recipes"), list):
        raise AlchemyError("items와 recipes 배열이 필요합니다.")
    items = {v["item_id"]: v for v in data["items"]}
    if any(not isinstance(i, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", i) for i in items):
        raise AlchemyError("품목 ID는 100자 이하의 영문·숫자·밑줄·하이픈을 사용하세요.")
    if len(items) != len(data["items"]) or any(not v.get("name") for v in items.values()):
        raise AlchemyError("품목 ID 중복 또는 이름 누락입니다.")
    if any(v.get("icon") is not None and not re.fullmatch(r"icons/[A-Za-z0-9_-]{1,100}\.(?:png|webp)", str(v["icon"])) for v in items.values()):
        raise AlchemyError("아이콘은 앱에 포함된 icons/*.png 또는 *.webp 경로를 사용하세요.")
    recipes = {}
    for r in data["recipes"]:
        rid = r.get("recipe_id")
        if not isinstance(rid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", rid) or rid in recipes or r.get("output_item_id") not in items:
            raise AlchemyError("제작식 ID 중복 또는 산출 품목 누락입니다.")
        integer(r.get("output_quantity"), "산출 단위", minimum=1)
        if r.get("yield_type") not in {"fixed", "variable", "additional"}:
            raise AlchemyError("산출 유형이 필요합니다.")
        if not isinstance(r.get("inputs"), list) or not r["inputs"]:
            raise AlchemyError("빈 제작식은 사용할 수 없습니다.")
        seen = set()
        for ingredient in r["inputs"]:
            if ingredient.get("item_id") not in items or ingredient["item_id"] in seen:
                raise AlchemyError("누락되거나 중복된 재료입니다.")
            seen.add(ingredient["item_id"])
            integer(ingredient.get("quantity"), "재료 수량", minimum=1)
            for alternative in ingredient.get("alternatives", []):
                if alternative.get("item_id") not in items or not alternative.get("source_url"):
                    raise AlchemyError("대체 재료의 품목 또는 검증 출처가 없습니다.")
                integer(alternative.get("quantity"), "대체 수량", minimum=1)
        if any(i not in items for i in r.get("additional_output_ids", [])):
            raise AlchemyError("추가 산출 품목이 누락되었습니다.")
        if r.get("verification") == "verified" and (not r.get("source_urls") or not r.get("verified_at")):
            raise AlchemyError("검증된 제작식은 출처와 확인일이 필요합니다.")
        if any(not isinstance(url, str) or not url.startswith(("https://", "http://")) for url in r.get("source_urls", [])):
            raise AlchemyError("출처는 HTTP/HTTPS URL이어야 합니다.")
        recipes[rid] = r
    for i in data.get("products", []):
        if i not in items or not any(r["output_item_id"] == i for r in recipes.values()):
            raise AlchemyError("초기 지원 제작품의 제작식이 누락되었습니다.")
    return items, recipes


def ingredients(recipe, selections=None):
    selections = selections or {}
    result = []
    for row in recipe["inputs"]:
        chosen = selections.get(f'{recipe["recipe_id"]}:{row["item_id"]}', row["item_id"])
        if chosen == row["item_id"]:
            result.append({"item_id": chosen, "quantity": row["quantity"]})
        else:
            alternate = next((v for v in row.get("alternatives", []) if v["item_id"] == chosen), None)
            if alternate is None:
                raise AlchemyError("해당 제작식에서 허용되지 않은 재료 치환입니다.")
            result.append({"item_id": chosen, "quantity": alternate["quantity"]})
    merged = {}
    for row in result:
        merged[row["item_id"]] = merged.get(row["item_id"], 0) + row["quantity"]
    return [{"item_id": i, "quantity": q} for i, q in merged.items()]


def graph(catalog, root, choices=None, substitutions=None):
    items, recipes = validate_catalog(catalog)
    if root not in items:
        raise AlchemyError("등록되지 않은 품목입니다.")
    choices = choices or {}
    selected, visiting, finished, order = {}, set(), set(), []

    def visit(item):
        if item in visiting:
            raise AlchemyError(f'순환 참조: {items[item]["name"]}. 제작을 차단합니다.', 409, "recipe_cycle")
        if item in finished:
            return
        visiting.add(item)
        options = [r for r in recipes.values() if r["output_item_id"] == item]
        rid = choices.get(item)
        recipe = recipes.get(rid) if rid else next(iter(options), None)
        if rid and (recipe is None or recipe["output_item_id"] != item):
            raise AlchemyError("선택한 제작 경로가 품목과 맞지 않습니다.")
        if recipe:
            selected[item] = recipe
            for row in ingredients(recipe, substitutions):
                visit(row["item_id"])
        visiting.remove(item)
        finished.add(item)
        order.append(item)
    visit(root)
    return items, selected, list(reversed(order))
