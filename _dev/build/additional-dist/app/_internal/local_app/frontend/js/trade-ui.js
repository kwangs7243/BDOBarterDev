import { reviewExcludedTrades } from "./trade-import-review.js";
import { state } from "./state.js";
import { resetWorkingSession } from "./persistence.js";
import { parseTradeJsonText, processParsedTrades } from "./domain/trade-import.js";

let catalogPromise;
let catalog;
let initialized = false;
let setStatusFn = () => {};
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
function invalidateSchedule() { state.session.schedule = null; state.session.completed = null; state.session.diagnostics = null; }
function describeResult(result) {
  const parts = [];
  if (result.addedCount) parts.push(`${result.addedCount}건 추가`);
  if (result.duplicateCount) parts.push(`${result.duplicateCount}건 중복`);
  if (result.conflictCount) parts.push(`${result.conflictCount}건 기존 목록 충돌`);
  const ambiguous = result.outcomes.filter((row) => row.status === "ambiguous").length;
  const unmatched = result.outcomes.filter((row) => row.status === "unmatched").length;
  const missing = result.outcomes.filter((row) => row.status === "held").length;
  const invalidYield = result.outcomes.filter((row) => row.field === "yield").length;
  if (ambiguous) parts.push(`${ambiguous}건 모호 후보 보류`);
  if (unmatched) parts.push(`${unmatched}건 품목 매칭 실패 보류`);
  if (missing) parts.push(`${missing}건 필수값 누락 보류`);
  if (invalidYield) parts.push(`${invalidYield}건 수율 확인 보류`);
  return parts.length ? parts.join(" · ") : "추가된 항목이 없습니다.";
}
function showImportFailure(result) { const status = document.querySelector("#trade-import-status"); status.textContent = `${result.kind === "json_parse" ? "JSON 파싱 실패" : result.kind === "unsupported_structure" ? "지원하지 않는 구조" : "필수 필드 누락"}: ${result.message}`; status.dataset.kind = "error"; }
function applyInput(mode) {
  if (window.__bdoScheduleRuntime?.pending) { setStatusFn("완료 저장을 먼저 확인하거나 재시도하세요.", "error"); return; }
  const parsed = parseTradeJsonText(document.querySelector("#trade-json-input").value);
  if (!parsed.ok) { showImportFailure(parsed); return; }
  if (mode === "append" && state.session.scannedTrades === null) { showImportFailure({ kind: "required_field", message: "먼저 새 회차를 시작하세요." }); return; }
  if (mode === "new" && state.session.scannedTrades !== null && !window.confirm("현재 회차를 새 물교 목록으로 바꿀까요?")) return;
  const previous = mode === "append" ? state.session.scannedTrades : [];
  const result = processParsedTrades(parsed.rows, previous, catalog);
  const commit = (result) => {
  if (window.__bdoScheduleRuntime?.pending || state.session !== sessionReferenceAtReview || JSON.stringify(state.session.scannedTrades) !== sessionAtReview) throw new Error("검토 중 회차가 바뀌었습니다. JSON을 다시 읽어 주세요.");
  if (!result.addedCount) {
    const status = document.querySelector("#trade-import-status"); status.textContent = `${describeResult(result)} 기존 회차는 유지했습니다.`; status.dataset.kind = "error";
    state.session.diagnostics = result;
    return;
  }
  if (mode === "new") {
    state.session = {
      id: crypto.randomUUID(), scannedTrades: result.trades, schedule: null, completed: null,
      remainingParley: Number(state.settings.parley.defaultBudget),
      config: structuredClone({ ship: state.settings.ship, parley: state.settings.parley, tuning: state.settings.tuning }),
      timers: null, selection: { briefMode: "speed", selectedScheduleSlot: 1 }, drag: null, diagnostics: result,
    };
    setStatusFn("새 회차를 시작하고 저장하고 있습니다.", "saving");
  } else {
    state.session.scannedTrades = result.trades; invalidateSchedule(); state.session.diagnostics = result;
  }
  const status = document.querySelector("#trade-import-status"); status.textContent = describeResult(result); status.dataset.kind = result.rejectedCount || result.conflictCount ? "error" : "success";
  document.querySelector("#trade-json-input").value = "";
  document.querySelector("#json-import-dialog").close();
  renderTradeList();
  window.dispatchEvent(new CustomEvent("bdo:session-changed"));
  window.dispatchEvent(new CustomEvent("bdo:trade-list-changed"));
  };
  const sessionAtReview = JSON.stringify(state.session.scannedTrades);
  const sessionReferenceAtReview = state.session;
  document.querySelector("#trade-import-status").textContent = describeResult(result);
  reviewExcludedTrades(parsed.rows, previous, catalog, result, commit);
}

function changed() { invalidateSchedule(); renderTradeList(); window.dispatchEvent(new CustomEvent("bdo:session-changed")); window.dispatchEvent(new CustomEvent("bdo:trade-list-changed")); }
function addInput(row, field, type = "text", min) {
  const td = document.createElement("td"); const input = document.createElement("input"); input.type = type; input.value = row[field] ?? ""; input.setAttribute("aria-label", `${field} · ${row.island || "새 행"}`);
  if (type === "number") { input.step = "1"; if (min !== undefined) input.min = String(min); }
  input.addEventListener("change", () => { if (window.__bdoScheduleRuntime?.pending) { input.value = row[field] ?? ""; setStatusFn("완료 저장을 먼저 확인하거나 재시도하세요.", "error"); return; } const trade = state.session.scannedTrades[Number(input.closest("tr").dataset.index)]; trade[field] = type === "number" ? parseInt(input.value, 10) || 0 : input.value; changed(); });
  td.append(input); return td;
}
function renderTradeList() {
  const root = document.querySelector("#trade-list-root"); const parley = document.querySelector("#remaining-parley"); const tradeCount = document.querySelector("#session-trade-count");
  const trades = state.session.scannedTrades;
  const toggle = document.querySelector("#toggle-all-trades");
  const resetButton = document.querySelector("#reset-session");
  if (trades === null) {
    parley.value = ""; parley.disabled = true; tradeCount.textContent = "회차 없음"; toggle.disabled = true; toggle.textContent = "전체 비활성"; resetButton.disabled = true;
    const empty = el("div", undefined, "empty"); empty.append(el("p", "물교목록이 없습니다. 새 회차 JSON을 입력하거나 다른 회차를 불러오세요."));
    const open = el("button", "JSON 입력"); open.type = "button"; open.className = "primary"; open.addEventListener("click", () => document.getElementById("json-import-dialog").showModal());
    empty.append(open); root.replaceChildren(empty); return;
  }
  parley.disabled = false; parley.value = state.session.remainingParley ?? ""; resetButton.disabled = false; tradeCount.textContent = `물교 ${trades.filter((trade) => !trade.deleted).length}행`;
  const active = trades.filter((trade) => !trade.deleted); toggle.disabled = active.length === 0; toggle.textContent = active.some((trade) => !trade.disabled) ? "전체 비활성" : "전체 활성";
  root.replaceChildren(); const table = document.createElement("table"); const head = document.createElement("thead"); const headingRow = document.createElement("tr");
  for (const heading of ["섬", "소모품", "필요 수량", "획득품", "횟수", "수율", "상태", "행"]) headingRow.append(el("th", heading)); head.append(headingRow); table.append(head);
  const body = document.createElement("tbody");
  trades.forEach((trade, index) => {
    const row = document.createElement("tr"); row.dataset.index = String(index); row.className = `trade-row${trade.deleted ? " trade-deleted" : ""}${trade.disabled ? " trade-disabled" : ""}`;
    for (const [field, type, min] of [["island", "text"], ["fromItem", "text"], ["reqAmount", "number", 1], ["toItem", "text"], ["count", "number", 0], ["yield", "number", 1]]) row.append(addInput(trade, field, type, min));
    const stateCell = document.createElement("td"); const label = el("label", undefined, "trade-toggle"); const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = !trade.disabled; checkbox.setAttribute("aria-label", `활성화 · ${trade.island || index + 1}행`);
    checkbox.addEventListener("change", () => { if (window.__bdoScheduleRuntime?.pending) { checkbox.checked = !trade.disabled; setStatusFn("완료 저장을 먼저 확인하거나 재시도하세요.", "error"); return; } trade.disabled = !checkbox.checked; changed(); }); label.append(checkbox, el("span", trade.disabled ? "OFF" : "ON")); stateCell.append(label); row.append(stateCell);
    const actionCell = document.createElement("td"); const toggleDeleted = el("button", trade.deleted ? "복원" : "삭제"); toggleDeleted.type = "button"; toggleDeleted.addEventListener("click", () => { if (window.__bdoScheduleRuntime?.pending) { setStatusFn("완료 저장을 먼저 확인하거나 재시도하세요.", "error"); return; } trade.deleted = !trade.deleted; changed(); }); actionCell.append(toggleDeleted); row.append(actionCell); body.append(row);
  });
  table.append(body); root.append(table);
}

export async function initTradeSessionUI(setStatus) {
  setStatusFn = setStatus;
  if (!catalogPromise) catalogPromise = fetch("/assets/data/trade-catalog.json").then((response) => { if (!response.ok) throw new Error(`품목 기준 자료를 불러오지 못했습니다 (${response.status}).`); return response.json(); });
  catalog = await catalogPromise;
  if (!initialized) {
    document.querySelector("#apply-new-session").addEventListener("click", () => applyInput("new"));
    document.querySelector("#append-current-trades").addEventListener("click", () => applyInput("append"));
    document.querySelector("#add-manual-trade").addEventListener("click", () => {
      if (window.__bdoScheduleRuntime?.pending) { setStatusFn("완료 저장을 먼저 확인하거나 재시도하세요.", "error"); return; }
      if (state.session.scannedTrades === null) { document.querySelector("#trade-import-status").textContent = "먼저 JSON 입력으로 새 회차를 시작하세요."; return; }
      state.session.scannedTrades.unshift({ island: "", fromItem: "", toItem: "", reqAmount: 1, count: 1, yield: 0 }); changed();
    });
    document.querySelector("#remaining-parley").addEventListener("change", (event) => {
      if (window.__bdoScheduleRuntime?.pending) { event.currentTarget.value = state.session.remainingParley ?? ""; setStatusFn("완료 저장을 먼저 확인하거나 재시도하세요.", "error"); return; }
      const value = parseInt(event.currentTarget.value, 10); state.session.remainingParley = Number.isSafeInteger(value) && value >= 0 ? value : 0; event.currentTarget.value = state.session.remainingParley;
      window.dispatchEvent(new CustomEvent("bdo:session-changed"));
    });
    document.querySelector("#toggle-all-trades").addEventListener("click", () => {
      if (window.__bdoScheduleRuntime?.pending) { setStatusFn("완료 저장을 먼저 확인하거나 재시도하세요.", "error"); return; }
      const active = state.session.scannedTrades?.filter((trade) => !trade.deleted) ?? []; if (!active.length) return;
      const targetDisabled = active.some((trade) => !trade.disabled); active.forEach((trade) => { trade.disabled = targetDisabled; }); changed();
    });
    document.querySelector("#reset-session").addEventListener("click", async () => {
      if (window.__bdoScheduleRuntime?.pending) { setStatusFn("완료 저장을 먼저 확인하거나 재시도하세요.", "error"); return; }
      if (state.session.scannedTrades === null || !window.confirm("현재 회차를 초기화할까요? 영구 재고·설정과 저장 슬롯은 유지됩니다.")) return;
      try { setStatusFn("현재 회차를 초기화하는 중입니다.", "saving"); await resetWorkingSession(); renderTradeList(); document.querySelector("#col-speed").replaceChildren(); document.querySelector("#col-balance").replaceChildren(); setStatusFn("현재 회차를 초기화했습니다. 영구 재고·설정과 슬롯은 유지됩니다.", "success"); }
      catch (error) { setStatusFn(`회차를 초기화하지 못했습니다: ${error.message}`, "error"); }
    });
    initialized = true;
  }
  renderTradeList();
}
export { renderTradeList };




