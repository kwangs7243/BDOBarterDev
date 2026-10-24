"""Read-only three-way catalog updates; writes remain storage transactions."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path

from .catalog import AlchemyError


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def known_base(saved):
    path = Path(__file__).parent / "data/catalog-bases.json"
    if path.exists():
        for base in json.loads(path.read_text(encoding="utf-8"))["catalogs"]:
            if saved["version"].split("+user-", 1)[0] == base["version"]:
                return base
    return None


def merge_catalog(saved, upstream, base=None, resolutions=None):
    token = fingerprint([saved, upstream, base])
    if saved is None:
        return deepcopy(upstream), {"available": False, "conflicts": [], "token": token}
    if saved == upstream:
        return deepcopy(saved), {"available": False, "conflicts": [], "token": token}
    base = base or known_base(saved)
    if base == upstream:
        return deepcopy(saved), {"available": False, "conflicts": [], "token": token}
    if base is None:
        return deepcopy(saved), {"available": saved["version"] != upstream["version"], "base_unknown": True,
                                 "conflicts": [], "token": token, "upstream_version": upstream["version"]}
    result = deepcopy(upstream)
    conflicts = []
    changed = []
    for collection, key in (("items", "item_id"), ("recipes", "recipe_id")):
        old = {r[key]: r for r in base[collection]}
        user = {r[key]: r for r in saved[collection]}
        new = {r[key]: r for r in upstream[collection]}
        merged = []
        for identity in dict.fromkeys([*new, *user, *old]):
            before, mine, theirs = old.get(identity), user.get(identity), new.get(identity)
            conflict_key = collection + ":" + identity
            if mine == before:
                value = theirs
                if theirs != before:
                    changed.append(conflict_key)
            elif theirs == before or mine == theirs:
                value = mine
            else:
                resolution = (resolutions or {}).get(conflict_key)
                if resolution not in {None, "user", "upstream"}:
                    raise AlchemyError("카탈로그 충돌 선택을 확인하세요.")
                if resolution is None:
                    conflicts.append({"key": conflict_key, "base": before, "user": mine, "upstream": theirs})
                value = theirs if resolution == "upstream" else mine
            if value is not None:
                value = deepcopy(value)
                if collection == "recipes" and conflict_key in {c["key"] for c in conflicts}:
                    value["update_conflict"] = True
                merged.append(value)
        result[collection] = merged
    for key in set(base) | set(saved):
        if key not in {"items", "recipes", "version", "verified_at"} and saved.get(key) != base.get(key):
            result[key] = deepcopy(saved.get(key))
    # Saved ID deletion is disallowed in the editor, but an upstream removal must
    # still retain IDs referenced by inventory and historical job snapshots.
    ids = {r["item_id"] for r in result["items"]}
    result["items"].extend(deepcopy(r) for r in saved["items"] if r["item_id"] not in ids)
    return result, {"available": base != upstream, "base_unknown": False, "conflicts": conflicts,
                    "changed": changed, "token": token, "upstream_version": upstream["version"]}
