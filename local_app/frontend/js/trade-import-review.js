import { createAutocomplete } from "./autocomplete.js";
import { getItemTier, getSafeUniqueItemMatch, processParsedTrades } from "./domain/trade-import.js";
const fields = [["island", "섬"], ["fromItem", "소모품"], ["reqAmount", "필요 수량"], ["toItem", "획득품"], ["count", "횟수"], ["yield", "수율"]];
const reasons = { held: "필수값 또는 수율 확인 필요", unmatched: "품목 미인식", ambiguous: "여러 품목 후보", duplicate: "기존 또는 입력 행과 중복", conflict: "같은 섬·획득품의 소모품 충돌" };
const node = (tag, text) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n; };
const allTradeItems = (catalog) => [...new Set([
  ...Object.values(catalog.masterData).flat(), ...catalog.specialItems,
])];
const allIslands = (catalog) => [...new Set([
  ...catalog.islands, ...catalog.t6Islands, ...catalog.t7Islands,
])];
function fromItemOptions(toItem, catalog, candidates, items) {
  const matched = getSafeUniqueItemMatch(String(toItem || "").replace(/\[.*?\]\s*/g, "").replace(/\s*x\s*\d+/gi, "").trim(), items).value;
  const tier = getItemTier(matched, catalog.masterData, catalog.specialItems);
  if (tier === 6) return catalog.masterData[5] || [];
  if (tier === 7) return catalog.masterData[6] || [];
  if (tier === "mat" || tier === "coin") return candidates;
  if (tier === 1) return catalog.masterData[0] || candidates;
  if (tier > 1) return catalog.masterData[tier - 1] || [];
  return candidates;
}
export function reviewExcludedTrades(rows, previous, catalog, initial, onApply) {
  const omitted = initial.outcomes.filter(row => row.status !== "accepted");
  if (!omitted.length) { onApply(initial); return; }
  const dialog = node("dialog"); dialog.className = "patch-review-dialog trade-import-review";
  const title = node("h2", `JSON 제외행 검토 · ${omitted.length}행`); title.id = "trade-review-title"; dialog.setAttribute("aria-labelledby", title.id);
  const header = node("header"); header.className = "patch-review-header"; header.append(title);
  const body = node("main"); body.className = "patch-review-body";
  body.append(node("p", `자동 통과 ${initial.addedCount}행. 아래 행은 기본 제외입니다. 수정한 뒤 ‘리스트에 삽입’을 선택하면 다시 검증합니다.`));
  const edits = new Map();
  const items = allTradeItems(catalog);
  const islands = allIslands(catalog);
  for (const outcome of omitted) {
    const section = node("section"); section.className = "patch-review-tier"; section.dataset.index = outcome.index;
    section.append(node("h3", `${outcome.index + 1}번째 행 · ${reasons[outcome.status] ?? outcome.status}${outcome.field ? ` (${fields.find(([field]) => field === outcome.field)?.[1] ?? outcome.field})` : ""}`));
    if (outcome.candidates?.length) section.append(node("p", `후보: ${outcome.candidates.join(", ")}`));
    const entry = { include: false, row: structuredClone(rows[outcome.index]) }; edits.set(outcome.index, entry);
    const label = node("label"); const check = node("input"); check.type = "checkbox"; check.className = "trade-review-include";
    check.addEventListener("change", () => { entry.include = check.checked; }); label.append(check, node("span", "리스트에 삽입 (기본: 제외)")); section.append(label);
    const grid = node("div"); grid.style.cssText = "display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px";
    let fromItemControl = null;
    for (const [field, caption] of fields) {
      const fieldWrap = node("div"); fieldWrap.className = "trade-review-field";
      const fieldLabel = node("label", caption); fieldLabel.setAttribute("for", `trade-review-${outcome.index}-${field}`);
      if (["island", "fromItem", "toItem"].includes(field)) {
        const initialOptions = field === "island" ? islands : field === "fromItem" ? fromItemOptions(entry.row.toItem, catalog, items, items) : items;
        const control = createAutocomplete({
          className: `trade-review-autocomplete trade-review-${field}`,
          options: initialOptions,
          value: entry.row[field] ?? "",
          ariaLabel: `${outcome.index + 1}행 ${caption}`,
          placeholder: `${caption}을 입력하거나 목록에서 선택`,
          onInput: (value) => {
            entry.row[field] = value.trim();
            if (field === "toItem") fromItemControl?.setOptions(fromItemOptions(value, catalog, items, items));
          },
        });
        control.input.id = `trade-review-${outcome.index}-${field}`;
        control.input.dataset.field = field;
        if (field === "fromItem") fromItemControl = control;
        fieldWrap.append(fieldLabel, control.element);
      } else {
        const input = node("input"); input.dataset.field = field;
        input.type = "number";
        input.step = "1"; input.min = field === "count" ? "0" : "1";
        input.id = `trade-review-${outcome.index}-${field}`;
        input.value = entry.row[field] ?? ""; input.setAttribute("aria-label", `${outcome.index + 1}행 ${caption}`);
        input.addEventListener("input", () => { entry.row[field] = input.value === "" ? null : Number(input.value); });
        fieldWrap.append(fieldLabel, input);
      }
      grid.append(fieldWrap);
    }
    section.append(grid);
    const original = node("details"); original.append(node("summary", "원본 행 보기"), node("pre", JSON.stringify(rows[outcome.index], null, 2))); section.append(original); body.append(section);
  }
  const error = node("p"); error.setAttribute("role", "alert"); body.append(error);
  const footer = node("footer"); footer.className = "patch-review-footer";
  const cancel = node("button", "취소"), apply = node("button", "선택 결과로 리스트 생성"); apply.className = "primary"; apply.dataset.action = "apply";
  cancel.addEventListener("click", () => dialog.close());
  apply.addEventListener("click", () => {
    const selected = rows.flatMap((row, index) => {
      const edit = edits.get(index); return edit ? (edit.include ? [{ row: edit.row, index }] : []) : [{ row, index }];
    });
    for (const { row, index } of selected.filter(value => edits.has(value.index))) {
      if (!row.island || !row.fromItem || !row.toItem || !Number.isSafeInteger(row.reqAmount) || row.reqAmount < 1 || !Number.isSafeInteger(row.count) || row.count < 0 || !Number.isSafeInteger(row.yield) || row.yield < 1) {
        error.textContent = `${index + 1}행: 섬·품목과 정수 수량·횟수·수율을 확인하세요.`; return;
      }
    }
    const result = processParsedTrades(selected.map(value => value.row), previous, catalog);
    const failed = result.outcomes.filter(row => row.status !== "accepted");
    if (failed.length) { error.textContent = failed.map(row => `${selected[row.index].index + 1}행: ${reasons[row.status] ?? row.status}`).join(" · "); return; }
    try { onApply(result); dialog.close(); } catch (failure) { error.textContent = failure.message; }
  });
  footer.append(cancel, apply); dialog.append(header, body, footer); document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true }); dialog.style.setProperty("--review-zoom", String(Number(getComputedStyle(document.body).zoom) || 1)); dialog.showModal();
}
