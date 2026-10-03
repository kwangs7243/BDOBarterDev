import { saveSettings } from "./persistence.js";
import { state } from "./state.js";
const { MODES, MODE_SELECT_LABELS, TUNING_FIELDS } = window.BDO_CONSTANTS;

const node = (tag, cls, text) => { const item = document.createElement(tag); if (cls) item.className = cls; if (text !== undefined) item.textContent = text; return item; };
function field(labelText, input) { const wrap = node("div", "field"); const label = node("label", "", labelText); label.htmlFor = input.id; wrap.append(label, input); return wrap; }
function number(id, value, step = "1") { const input = document.createElement("input"); input.id = id; input.type = "number"; input.step = step; input.value = value ?? ""; if (step === "1") input.min = "0"; return input; }
function selectMode(id, value) { const select = document.createElement("select"); select.id = id; for (const mode of MODES) { const option = document.createElement("option"); option.value = mode; option.textContent = MODE_SELECT_LABELS[mode]; select.append(option); } select.value = MODES.includes(value) ? value : "none"; return select; }
function saveButton(label, click) { const button = node("button", "primary", label); button.type = "button"; button.addEventListener("click", click); return button; }
function actionBar(...buttons) { const wrap = node("div", "actions"); wrap.append(...buttons); return wrap; }
function readNumber(id, integer = true) { const input = document.getElementById(id); const value = Number(input.value); if (!input.value.trim() || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) throw new Error(`${input.getAttribute("aria-label") || input.id}: 유효한 ${integer ? "정수" : "숫자"}를 입력하세요.`); return value; }
async function persist(section, payload, setStatus, label, after) { try { setStatus(`${label} 저장 중입니다.`, "saving"); await saveSettings({ [section]: payload }); setStatus(`${label} 저장을 확인했습니다.`, "success"); after?.(); return true; } catch (error) { if (error.status === 409) after?.(); setStatus(error.committed ? error.message : `${label} 저장 실패: ${error.message}`, "error"); return false; } }

function applyShipToSession(payload, setStatus) {
  if (window.__bdoScheduleRuntime?.pending) { setStatus("완료 저장을 먼저 확인하거나 재시도하세요.", "error"); return; }
  if (state.session.scannedTrades === null) return;
  state.session.config ||= { ship: structuredClone(state.settings.ship), parley: structuredClone(state.settings.parley), tuning: structuredClone(state.settings.tuning) };
  state.session.config.ship = structuredClone(payload);
  window.dispatchEvent(new CustomEvent("bdo:session-changed"));
  if (state.session.schedule && window.__bdoScheduleRuntime.generateSchedule(state, setStatus)) {
    window.renderModeColumn?.("col-speed", state.session.schedule.speed, "speed");
    window.renderModeColumn?.("col-balance", state.session.schedule.balance, "balance");
    setStatus("이번 회차 선박·교역 설정을 바꾸고 스케줄을 다시 계산했습니다.", "success");
  }
  window.__bdoRenderAll?.();
}

function applyParleyToSession(payload, setStatus) {
  if (state.session.scannedTrades === null) return;
  state.session.config ||= { ship: structuredClone(state.settings.ship), parley: structuredClone(state.settings.parley), tuning: structuredClone(state.settings.tuning) };
  state.session.config.parley = structuredClone(payload);
  window.dispatchEvent(new CustomEvent("bdo:session-changed"));
  if (state.session.schedule && window.__bdoScheduleRuntime.generateSchedule(state, setStatus)) {
    window.renderModeColumn?.("col-speed", state.session.schedule.speed, "speed");
    window.renderModeColumn?.("col-balance", state.session.schedule.balance, "balance");
  }
  window.__bdoRenderAll?.();
  setStatus("교환 비용을 이번 회차에 적용했습니다. 현재 교섭력은 유지했습니다.", "success");
}

export function renderTierRules(root, setStatus, refresh) {
  root.replaceChildren();
  const rules = state.settings.tierRules;
  const grid = node("div", "form-grid");
  for (let tier = 1; tier <= 5; tier += 1) grid.append(field(`${tier}단 최소 보존`, number(`tier-rule-${tier}`, rules[String(tier)])));
  const button = saveButton("단계 규칙 저장", () => {
    try { const payload = Object.fromEntries([1,2,3,4,5].map((tier) => [String(tier), readNumber(`tier-rule-${tier}`)])); persist("tierRules", payload, setStatus, "단계 규칙", refresh); }
    catch (error) { setStatus(error.message, "error"); }
  });
  root.append(grid, actionBar(button));
}

function tuningEditor(root, values, prefix, dataMode, onSave, onReset) {
  const panel = node("section", "tuning-editor");
  panel.dataset[dataMode] = "";
  if (dataMode === "tuningTemporary") panel.append(field("이번 회차 선박 속도", number("temp-ship-speed", state.session.config?.ship?.speed ?? state.settings.ship.speed, "any")));
  const grid = node("div", "form-grid");
  for (const [key, label, type] of TUNING_FIELDS) grid.append(field(label, number(`${prefix}-${key}`, values[key], type === "integer" ? "1" : "any")));
  const tierPriority = node("fieldset"); tierPriority.append(node("legend", "", "단계별 우선 점수"));
  const priorityGrid = node("div", "form-grid");
  for (let tier = 1; tier <= 5; tier += 1) priorityGrid.append(field(`T${tier}`, number(`${prefix}-priority-${tier}`, values.tierPriority?.[`T${tier}`] ?? 0)));
  tierPriority.append(priorityGrid);
  const exclude = node("fieldset"); exclude.append(node("legend", "", "단계별 잉여 제외"));
  const checks = node("div", "inline-field");
  for (let tier = 1; tier <= 5; tier += 1) { const wrap = node("label", "inline-field"); const check = document.createElement("input"); check.type = "checkbox"; check.id = `${prefix}-exclude-${tier}`; check.checked = values.excludeSurplus?.[`T${tier}`] === true; wrap.append(check, document.createTextNode(`${tier}단 잉여 제외`)); checks.append(wrap); }
  exclude.append(checks);
  panel.append(grid, tierPriority, exclude, actionBar(onSave(), onReset()));
  root.append(panel);
}

function readTuning(prefix) {
  const payload = {};
  for (const [key, , type] of TUNING_FIELDS) payload[key] = readNumber(`${prefix}-${key}`, type === "integer");
  payload.tierPriority = Object.fromEntries([1,2,3,4,5].map((tier) => [`T${tier}`, readNumber(`${prefix}-priority-${tier}`)]));
  payload.excludeSurplus = Object.fromEntries([1,2,3,4,5].map((tier) => [`T${tier}`, document.getElementById(`${prefix}-exclude-${tier}`).checked]));
  return payload;
}

export function renderSettings(_root, setStatus, refresh) {
  renderTierRules(document.querySelector("#tier-rules-root"), setStatus, refresh);
  const settings = state.settings;
  const shipRoot = document.querySelector("#ship-root"); shipRoot.replaceChildren();
  const ship = settings.ship; const activeShip = state.session.config?.ship ?? ship; const shipFields = node("div", "form-grid");
  shipFields.append(field("일반 LT", number("ship-normal", activeShip.normalWeight, "any")), field("한계 LT", number("ship-max", activeShip.maxWeight, "any")), field("속도", number("ship-speed", activeShip.speed, "any")), field("교역", selectMode("ship-mode", activeShip.mode)));
  const saveShip = saveButton("저장", async () => { if (window.__bdoScheduleRuntime?.pending) { setStatus("완료 저장을 먼저 확인하거나 재시도하세요.", "error"); return; } try { const payload = { normalWeight: readNumber("ship-normal", false), maxWeight: readNumber("ship-max", false), speed: readNumber("ship-speed", false), mode: document.getElementById("ship-mode").value }; if (await persist("ship", payload, setStatus, "선박 설정", refresh)) applyShipToSession(payload, setStatus); } catch (error) { setStatus(error.message, "error"); } });
  shipRoot.append(shipFields, actionBar(saveShip));
  document.getElementById("ship-mode").addEventListener("change", (event) => {
    if (window.__bdoScheduleRuntime?.pending) { event.currentTarget.value = state.session.config?.ship?.mode ?? settings.ship.mode; setStatus("완료 저장을 먼저 확인하거나 재시도하세요.", "error"); return; }
    if (state.session.scannedTrades === null) return;
    state.session.config ||= { ship: structuredClone(settings.ship), parley: structuredClone(settings.parley), tuning: structuredClone(settings.tuning) };
    state.session.config.ship.mode = event.currentTarget.value;
    window.dispatchEvent(new CustomEvent("bdo:session-changed"));
    if (state.session.schedule && window.__bdoScheduleRuntime.generateSchedule(state, setStatus)) {
      window.renderModeColumn?.("col-speed", state.session.schedule.speed, "speed");
      window.renderModeColumn?.("col-balance", state.session.schedule.balance, "balance");
      window.__bdoRenderScheduleDiagnostics?.(state);
      setStatus("이번 회차 교역 모드를 바꾸고 스케줄을 다시 계산했습니다.", "success");
    }
  });

  const parleyRoot = document.querySelector("#parley-root"); parleyRoot.replaceChildren();
  parleyRoot.title = "새 회차 기본값은 다음 회차에 적용됩니다. 일반·주화 비용은 저장하면 현재 회차에도 적용됩니다.";
  const parley = settings.parley; const activeParley = state.session.config?.parley ?? parley; const parleyFields = node("div", "form-grid");
  parleyFields.append(field("새 회차 기본", number("parley-budget", parley.defaultBudget)), field("일반 비용", number("parley-normal", activeParley.normalCost)), field("주화 비용", number("parley-crow", activeParley.crowCost)));
  const saveParley = saveButton("저장", async () => {
    if (window.__bdoScheduleRuntime?.pending) { setStatus("완료 저장을 먼저 확인하거나 재시도하세요.", "error"); return; }
    try {
      const payload = { defaultBudget: readNumber("parley-budget"), normalCost: readNumber("parley-normal"), crowCost: readNumber("parley-crow") };
      if (await persist("parley", payload, setStatus, "교섭력 설정", refresh)) applyParleyToSession(payload, setStatus);
    } catch (error) { setStatus(error.message, "error"); }
  });
  parleyRoot.append(parleyFields, actionBar(saveParley));

  const presetsRoot = document.querySelector("#presets-root"); presetsRoot.replaceChildren();
  for (let slot = 1; slot <= 4; slot += 1) {
    const preset = settings.shipPresets[String(slot)]; const card = node("div", "preset-card"); card.append(node("strong", "", `${slot}번 프리셋`));
    card.append(node("p", "muted", preset ? `${MODE_SELECT_LABELS[preset.mode] ?? preset.mode} · ${preset.speed}` : "프리셋 없음"));
    const save = node("button", "", `${slot} 저장`); save.type = "button"; save.addEventListener("click", () => { try { const all = { ...state.settings.shipPresets, [String(slot)]: { mode: document.getElementById("ship-mode").value, nW: readNumber("ship-normal", false), mW: readNumber("ship-max", false), speed: readNumber("ship-speed", false) } }; persist("shipPresets", all, setStatus, `${slot}번 프리셋`, refresh); } catch (error) { setStatus(error.message, "error"); } });
    const load = node("button", "", `${slot} 적용`); load.type = "button"; load.disabled = !preset; load.addEventListener("click", async () => { if (!preset) return; if (window.__bdoScheduleRuntime?.pending) { setStatus("완료 저장을 먼저 확인하거나 재시도하세요.", "error"); return; } const payload = { normalWeight: preset.nW, maxWeight: preset.mW, speed: preset.speed, mode: preset.mode }; if (await persist("ship", payload, setStatus, `${slot}번 프리셋`, refresh)) applyShipToSession(payload, setStatus); });
    card.append(actionBar(save, load)); presetsRoot.append(card);
  }

  const tuningRoot = document.querySelector("#tuning-root"); tuningRoot.replaceChildren();
  tuningRoot.dataset.mode ||= "temporary";
  const temporary = state.session.config?.tuning ?? structuredClone(settings.tuning);
  const saveTemp = () => saveButton("이번 회차에 적용하고 재계산", () => {
    if (window.__bdoScheduleRuntime?.pending) { setStatus("완료 저장을 먼저 확인하거나 재시도하세요.", "error"); return; }
    if (state.session.scannedTrades === null) { setStatus("이번 회차를 먼저 시작하세요.", "error"); return; }
    try {
      if (!state.session.config) state.session.config = { ship: structuredClone(settings.ship), parley: structuredClone(settings.parley), tuning: structuredClone(settings.tuning) };
      state.session.config.tuning = readTuning("temp-tune");
      state.session.config.ship.speed = readNumber("temp-ship-speed", false);
      window.dispatchEvent(new CustomEvent("bdo:session-changed"));
      if (state.session.schedule) {
        if (window.__bdoScheduleRuntime.generateSchedule(state, setStatus)) {
          window.renderModeColumn?.("col-speed", state.session.schedule.speed, "speed");
          window.renderModeColumn?.("col-balance", state.session.schedule.balance, "balance");
          window.__bdoRenderScheduleDiagnostics?.(state);
          window.dispatchEvent(new CustomEvent("bdo:trade-list-changed"));
          setStatus("이번 회차 튜닝을 적용해 스케줄을 다시 계산했습니다.", "success");
        }
      } else setStatus("이번 회차에 튜닝을 적용했습니다. 스케줄을 생성하면 반영됩니다.", "success");
    } catch (error) { setStatus(error.message, "error"); }
  });
  const resetTemp = () => {
    const button = node("button", "", "영구 기본값 불러오기"); button.type = "button";
    button.addEventListener("click", () => {
      if (window.__bdoScheduleRuntime?.pending) { setStatus("완료 저장을 먼저 확인하거나 재시도하세요.", "error"); return; }
      if (state.session.scannedTrades === null) { setStatus("이번 회차를 먼저 시작하세요.", "error"); return; }
      if (!state.session.config) state.session.config = { ship: structuredClone(settings.ship), parley: structuredClone(settings.parley), tuning: structuredClone(settings.tuning) };
      state.session.config.ship = structuredClone(state.settings.ship);
      state.session.config.tuning = structuredClone(state.settings.tuning);
      window.dispatchEvent(new CustomEvent("bdo:session-changed"));
      if (state.session.schedule) {
        try {
          if (!window.__bdoScheduleRuntime.generateSchedule(state, setStatus)) return;
          window.renderModeColumn?.("col-speed", state.session.schedule.speed, "speed");
          window.renderModeColumn?.("col-balance", state.session.schedule.balance, "balance");
          window.__bdoRenderScheduleDiagnostics?.(state);
        } catch (error) { setStatus(`기본값 적용 후 스케줄 재계산 실패: ${error.message}`, "error"); return; }
      }
      window.__bdoRenderAll?.();
      setStatus(state.session.schedule ? "영구 기본 선박·튜닝값을 이번 회차에 적용하고 스케줄을 다시 계산했습니다." : "영구 기본 선박·튜닝값을 이번 회차에 복사했습니다.", "success");
    });
    return button;
  };
  tuningEditor(tuningRoot, temporary, "temp-tune", "tuningTemporary", saveTemp, resetTemp);
  tuningEditor(tuningRoot, settings.tuning, "durable-tune", "tuningDurable", () => saveButton("영구 기본값 저장", () => { try { persist("tuning", readTuning("durable-tune"), setStatus, "튜닝 기본값", refresh); } catch (error) { setStatus(error.message, "error"); } }), () => saveButton("현재 기본값으로 되돌리기", () => renderSettings(_root, setStatus, refresh)));
}

