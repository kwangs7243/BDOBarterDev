"""Validate original scanner output and final user labels in the stock transaction."""
import json
from .contracts import ContractError, require_object, require_int

AGREEMENTS = {"item_only": (True, False), "quantity_only": (False, True),
              "both_match": (True, True), "both_different": (False, False)}


def validate_feedback(connection, feedback, updates, catalog):
    feedback = require_object(feedback, "feedback")
    version2 = feedback.get("version") == 2 and type(feedback.get("version")) is int
    keys = {"scanId", "rows", "version"} if version2 else {"scanId", "rows"}
    if set(feedback) != keys or not isinstance(feedback["scanId"], str) or not isinstance(feedback["rows"], list):
        raise ContractError("판독 기록 형식이 올바르지 않습니다.")
    record = connection.execute("SELECT report_json FROM warehouse_scan WHERE scan_id = ?", (feedback["scanId"],)).fetchone()
    if record is None:
        raise ContractError("원본 판독 기록이 없습니다. 이미지를 다시 판독하세요.")
    report = json.loads(record["report_json"])
    ignored = {"EMPTY", "TIER5_IGNORE"} if version2 else {"MATCH", "EMPTY", "TIER5_IGNORE"}
    slots = {slot["slot"]: slot for slot in report["slots"] if slot["decision"] not in ignored}
    rows = feedback["rows"]
    check_key = "agreement" if version2 else "itemCheck"
    if any(not isinstance(row, dict) or set(row) != {"slot", "name", "quantity", "excluded", check_key}
           or not isinstance(row["slot"], str) for row in rows):
        raise ContractError("사용자 확인 행 형식이 올바르지 않습니다.")
    if len(rows) != len(slots) or {row["slot"] for row in rows} != set(slots):
        raise ContractError("모든 판독 칸의 확인값이 필요합니다.")
    expected = {} if version2 else dict(report["patch"]["items"])
    checks = {"unchecked", *AGREEMENTS} if version2 else {"unchecked", "match", "different"}
    for row in rows:
        check = row[check_key]
        if type(row["excluded"]) is not bool or not isinstance(check, str) or check not in checks:
            raise ContractError("품목·수량 일치 확인 상태가 올바르지 않습니다.")
        if row["excluded"]:
            if check != "unchecked" or row["name"] is not None or row["quantity"] is not None:
                raise ContractError("비대상 칸은 품목 정답으로 저장할 수 없습니다.")
            continue
        name = row["name"]
        if not isinstance(name, str) or name not in catalog or catalog[name] > 4:
            raise ContractError("1~4단 정본 품목을 선택하세요.")
        quantity = require_int(row["quantity"], "feedback.quantity")
        slot = slots[row["slot"]]
        if version2:
            guess = slot.get("finalItem") or slot.get("bestCandidate")
            original_quantity = (slot.get("quantity") or {}).get("value")
            observed = (name == guess, type(original_quantity) is int and quantity == original_quantity)
            if check != "unchecked" and AGREEMENTS[check] != observed:
                raise ContractError("선택한 일치 여부가 원본 판독값·최종 수정값과 다릅니다.")
        else:
            guess = slot.get("bestCandidate")
            if (check == "match" and name != guess) or (check == "different" and name == guess):
                raise ContractError("품목 추측 일치 여부와 선택한 품목이 다릅니다.")
        expected[name] = require_int(expected.get(name, 0) + quantity, "combined quantity")
    if expected != {name: value["stock"] for name, value in updates.items()}:
        raise ContractError("사용자 확인값과 적용 재고가 일치하지 않습니다.")


def label_verification(row):
    """Separate explicit human labels from unchecked or excluded corrections."""
    if row["excluded"]:
        return {"verifiedItemLabel": False, "verifiedQuantityLabel": False, "itemMatch": None, "quantityMatch": None}
    agreement = row.get("agreement")
    if agreement in AGREEMENTS:
        item_match, quantity_match = AGREEMENTS[agreement]
        return {"verifiedItemLabel": True, "verifiedQuantityLabel": True,
                "itemMatch": item_match, "quantityMatch": quantity_match}
    return {"verifiedItemLabel": row.get("itemCheck") in {"match", "different"},
            "verifiedQuantityLabel": False, "itemMatch": None, "quantityMatch": None}
