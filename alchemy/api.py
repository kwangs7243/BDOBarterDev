"""Local-only alchemy APIs; no external requests or shared barter state."""
from functools import wraps
from contextlib import closing

from flask import Blueprint, current_app, jsonify, request

from .catalog import AlchemyError, graph, validate_catalog
from .storage import AlchemyStorage
from .yields import recipe_key

alchemy_api = Blueprint("alchemy_api", __name__, url_prefix="/api/alchemy")


def store():
    return current_app.extensions["alchemy_storage"]


def endpoint(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        try:
            response = jsonify(function(*args, **kwargs))
            response.headers["Cache-Control"] = "no-store"
            return response
        except AlchemyError as error:
            return jsonify({"ok": False, "error": {"code": error.code, "message": str(error)}}), error.status
        except (KeyError, TypeError, ValueError, OverflowError, RecursionError):
            return jsonify({"ok": False, "error": {"code": "invalid_alchemy_request", "message": "입력 데이터의 구조와 수량을 확인하세요. 저장하지 않았습니다."}}), 400
    return wrapped


@alchemy_api.get("/state")
@endpoint
def state():
    return store().snapshot()


@alchemy_api.get("/catalog")
@endpoint
def catalog():
    with closing(store().connect()) as db:
        data = store().catalog(db)
    items, recipes = validate_catalog(data)
    if request.args.get("full") == "1":
        return data
    return {"version": data["version"], "products": [items[i] for i in data["products"]], "item_count": len(items),
            "recipe_count": len(recipes), "official_recipe_count": sum(r.get("source_kind") == "official" for r in recipes.values()), "notes": data.get("notes", [])}


@alchemy_api.get("/items")
@endpoint
def items():
    with closing(store().connect()) as db:
        data = store().catalog(db)
        stocks = {r["item_id"]: dict(r) for r in db.execute("SELECT * FROM inventory")}
    q = request.args.get("q", "").casefold()
    rows = [v for v in data["items"] if q in " ".join([v["name"], *v.get("aliases", [])]).casefold()]
    offset = max(0, int(request.args.get("offset", 0)))
    limit = max(1, min(200, int(request.args.get("limit", 50))))
    return {"total": len(rows), "items": [{**v, **stocks.get(v["item_id"], {"quantity": None, "checked_at": None})} for v in rows[offset:offset + limit]]}


@alchemy_api.get("/recipes/<item_id>")
@endpoint
def recipes(item_id):
    with closing(store().connect()) as db:
        data = store().catalog(db)
    items, all_recipes = validate_catalog(data)
    if item_id not in items:
        raise AlchemyError("품목이 없습니다.", 404)
    options = [r for r in all_recipes.values() if r["output_item_id"] == item_id]
    errors = []
    for recipe in options:
        try:
            graph(data, item_id, {item_id: recipe["recipe_id"]})
        except AlchemyError as error:
            errors.append({"recipe_id": recipe["recipe_id"], "message": str(error)})
    ids = {item_id}
    for r in options:
        ids.update(r.get("additional_output_ids", []))
        for v in r["inputs"]:
            ids.add(v["item_id"])
            ids.update(a["item_id"] for a in v.get("alternatives", []))
    with closing(store().connect()) as db:
        statistics = store()._yield_statistics(db)
    return {"item": items[item_id], "recipes": options, "items": {i: items[i] for i in ids}, "errors": errors,
            "yield_history": {r["recipe_id"]: statistics.get(recipe_key(r)) for r in options}}


@alchemy_api.get("/plans")
@endpoint
def plans():
    return {"plans": store().plans()}


@alchemy_api.get("/history")
@endpoint
def history():
    return store().history(max(0, int(request.args.get("offset", 0))), max(1, min(100, int(request.args.get("limit", 50)))))


@alchemy_api.get("/jobs/<job_id>")
@endpoint
def job(job_id):
    with closing(store().connect()) as db:
        row = db.execute("SELECT data FROM jobs WHERE job_id=?", (job_id,)).fetchone()
    if not row:
        raise AlchemyError("제작 작업이 없습니다.", 404)
    import json
    return {"job": json.loads(row[0])}


@alchemy_api.post("/mutations/<action>")
@endpoint
def mutate(action):
    return store().mutate(action, request.get_json())


@alchemy_api.get("/backup")
@endpoint
def backup():
    return store().export(request.args.get("id"))


@alchemy_api.post("/backup/preview")
@endpoint
def backup_preview():
    return AlchemyStorage.validate_backup(request.get_json())


@alchemy_api.post("/catalog/preview")
@endpoint
def catalog_preview():
    data = request.get_json()
    items, recipes = validate_catalog(data)
    errors = []
    for r in recipes.values():
        try:
            graph(data, r["output_item_id"], {r["output_item_id"]: r["recipe_id"]})
        except AlchemyError as error:
            errors.append(str(error))
    return {"items": len(items), "recipes": len(recipes), "version": data["version"], "errors": sorted(set(errors))}
