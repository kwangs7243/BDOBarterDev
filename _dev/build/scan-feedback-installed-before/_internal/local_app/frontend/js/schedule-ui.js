import { totalDepartureDuration } from "./duration.js";
import { state } from "./state.js";
import { deleteScheduleSlot, loadScheduleSlot, saveCompletionInventory, saveScheduleSlot, whenPersistenceIdle } from "./persistence.js";
import { renderScheduleDiagnostics } from "./diagnostics-ui.js";

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const scheduleStatus = document.querySelector("#schedule-status");
function setScheduleStatus(message, kind = "info") { scheduleStatus.textContent = message; scheduleStatus.dataset.kind = kind; }
const minutes = (value) => window.formatTimeExact?.(value) ?? `${Math.floor(value || 0)}분`;
const itemTone = (tier) => tier === "coin" ? "tone-coin" : tier === "mat" ? "tone-special" : !tier ? "tone-land" : `tone-tier-${tier}`;
const itemTierLabel = (tier) => tier === "coin" ? "까마귀" : tier === "mat" ? "특수" : !tier ? "육지" : String(tier) + "단";
const numberFormat = new Intl.NumberFormat("ko-KR");
const tradeCost = (trade) => Math.max(0, Number(trade.execC) || 0) * Math.max(0, Number(trade.reqA) || 0);
const tradeGain = (trade) => Math.max(0, Number(trade.execC) || 0) * Math.max(0, Number(trade.mult) || 0);

function renderModeSettlement(mode, sorties) {
  const root = document.getElementById('summary-' + mode);
  root.replaceChildren();
  const title = document.createElement('h4'); title.textContent = '창고 결산 · 품목별 순증감';
  const note = document.createElement('p'); note.className = 'settlement-note'; note.textContent = '해당 모드의 전체 스케줄 완료 기준입니다. 창고 1~5단만 합산하며 6·7단, 육지품, 특수품, 까마귀 주화는 제외합니다.';
  const list = document.createElement('ul'); list.className = 'settlement-net-list';
  const deltas = new Map();
  const isWarehouseTier = (tier) => Number.isInteger(Number(tier)) && Number(tier) >= 1 && Number(tier) <= 5;
  const addDelta = (name, delta, tier) => {
    if (!name || !isWarehouseTier(tier) || !Number.isFinite(delta) || delta === 0) return;
    const entry = deltas.get(name) || { amount: 0, tier: Number(tier) };
    entry.amount += delta; deltas.set(name, entry);
  };
  for (const sortie of sorties || []) for (const trade of sortie.trades || []) {
    if (trade.isWaypoint) {
      if (trade.consumed) addDelta(trade.consumed.name, -(Number(trade.consumed.count) || 0), trade.consumed.tier);
      continue;
    }
    if (isWarehouseTier(trade.fromTier)) addDelta(trade.fromClean, -tradeCost(trade), Number(trade.fromTier));
    if (isWarehouseTier(trade.toTier)) addDelta(trade.toClean, tradeGain(trade), Number(trade.toTier));
  }
  const rows = [...deltas.entries()].filter(([, item]) => item.amount !== 0).sort((a, b) => a[1].tier - b[1].tier || a[0].localeCompare(b[0], 'ko'));
  if (!rows.length) {
    const empty = document.createElement('li'); empty.className = 'settlement-empty'; empty.textContent = '창고 1~5단 순증감 품목 없음'; list.append(empty);
  } else {
    const tiers = new Map();
    for (const [name, item] of rows) {
      if (!tiers.has(item.tier)) tiers.set(item.tier, []);
      tiers.get(item.tier).push({ name, amount: item.amount });
    }
    for (const [tierNumber, items] of tiers) {
      const row = document.createElement('li'); row.className = 'settlement-tier-line';
      const tierTotal = items.reduce((sum, item) => sum + item.amount, 0);
      const tier = document.createElement('span'); tier.className = 'settlement-tier ' + itemTone(tierNumber);
      tier.textContent = `${tierNumber}단계(총 ${tierTotal > 0 ? '+' : '−'}${numberFormat.format(Math.abs(tierTotal))}): `;
      row.append(tier);
      items.forEach((item, index) => {
        if (index) row.append(document.createTextNode(' · '));
        const entry = document.createElement('span'); entry.className = 'settlement-entry';
        const itemName = document.createElement('span'); itemName.className = 'settlement-item-name'; itemName.textContent = item.name + ' ';
        const amount = document.createElement('strong'); amount.className = item.amount > 0 ? 'settlement-delta-positive' : 'settlement-delta-negative';
        amount.textContent = (item.amount > 0 ? '+' : '−') + numberFormat.format(Math.abs(item.amount));
        entry.append(itemName, amount); row.append(entry);
      });
      list.append(row);
    }
  }
  root.append(title, note, list);
}

function setModeHeading(header, mode, sorties, totalParley) {
  const label = document.createElement("span"); label.className = "mode-heading-label"; label.textContent = mode === "speed" ? "⚡ 쾌속 모드" : "⚖️ 균형 모드";
  const stats = document.createElement("span"); stats.className = "mode-heading-stats";
  for (const [captionText, valueText] of [["출항", `${sorties.length}회`], ["총 소요시간", totalDepartureDuration(sorties)], ["교섭력", numberFormat.format(totalParley)]]) {
    const stat = document.createElement("span"); stat.className = "mode-stat";
    const caption = document.createElement("small"); caption.textContent = captionText;
    const value = document.createElement("strong"); value.textContent = valueText;
    stat.append(caption, value); stats.append(stat);
  }
  header.replaceChildren(label, stats);
}

function renderModeColumn(id, sorties, mode) {
  const root = document.getElementById(id);
  const header = document.getElementById(id === "col-speed" ? "header-speed" : "header-balance");
  const label = mode === "speed" ? "⚡ 쾌속 모드" : "⚖️ 균형 모드";
  if (!sorties?.length) {
    root.replaceChildren(Object.assign(document.createElement("p"), { className: "empty", textContent: "조건에 맞는 경로를 찾을 수 없습니다." }));
    header.textContent = `${label} (계산 불가)`;
    renderModeSettlement(mode, []);
    return;
  }
  const totalParley = sorties.reduce((sum, sortie) => sum + (sortie.parleyUsed || 0), 0);
  setModeHeading(header, mode, sorties, totalParley);
  renderModeSettlement(mode, sorties);
  root.replaceChildren();
  sorties.forEach((sortie, sortieIndex) => {
    const card = document.createElement("article");
    card.className = "sortie-card";
    card.draggable = true;
    card.addEventListener("dragstart", (event) => window.sortieDragStart(event, sortieIndex, mode));
    card.addEventListener("dragend", window.sortieDragEnd);
    card.addEventListener("dragover", (event) => window.sortieDragOver(event, sortieIndex, mode));
    card.addEventListener("drop", (event) => { window.sortieDrop(event, sortieIndex, mode); renderModeColumn(id, mode === "speed" ? state.session.schedule.speed : state.session.schedule.balance, mode); });
    const top = document.createElement("div"); top.className = "sortie-heading";
    const heading = document.createElement("strong"); heading.className = "sortie-title"; heading.textContent = `[${sortieIndex + 1}차 출항] · 약 ${minutes(sortie.totalTime)}`;
    const addWaypoint = document.createElement("button"); addWaypoint.type = "button"; addWaypoint.textContent = "＋ 경유지"; addWaypoint.addEventListener("click", () => window.openWaypointModal(mode, sortieIndex));
    const weight = document.createElement("span"); weight.textContent = `${(sortie.startWeight || 0).toLocaleString()} LT · 교섭력 ${(sortie.parleyUsed || 0).toLocaleString()}`;
    top.append(heading, addWaypoint, weight); card.append(top);
    const cargo = document.createElement("div"); cargo.className = "sortie-cargo";
    const cargoHeading = document.createElement("strong"); cargoHeading.className = "sortie-cargo-heading"; cargoHeading.textContent = "출항 적재";
    const cargoItems = document.createElement("div"); cargoItems.className = "sortie-cargo-items";
    for (const [name, req] of Object.entries(sortie.reqItems || {})) {
      const tier = req.isBase ? 0 : req.tier; const tone = itemTone(tier);
      const chip = document.createElement("span"); chip.className = "cargo-item " + tone;
      const tierLabel = document.createElement("span"); tierLabel.className = "cargo-tier-label " + tone; tierLabel.textContent = itemTierLabel(tier);
      const separator = document.createElement("span"); separator.className = "cargo-separator"; separator.textContent = " | ";
      const itemName = document.createElement("span"); itemName.className = "cargo-item-name " + tone; itemName.textContent = name;
      const count = document.createElement("span"); count.className = "cargo-item-count"; count.textContent = " ×" + numberFormat.format(req.count);
      chip.append(tierLabel, separator, itemName, count); cargoItems.append(chip);
    }
    if (!cargoItems.childElementCount) cargoItems.textContent = "적재물 없음";
    cargo.append(cargoHeading, cargoItems);
    card.append(cargo);
    const route = document.createElement("ol"); route.className = "schedule-route";
    sortie.trades.forEach((trade, tradeIndex) => {
      const row = document.createElement("li"); row.className = `route-card${trade.isWaypoint ? "" : " route-trade"}${trade.completed ? " route-completed" : ""} ${trade.isCoin ? "tone-coin" : trade.isSpec ? "tone-special" : itemTone(trade.toTier)}`; row.draggable = true;
      row.addEventListener("dragstart", (event) => window.routeDragStart(event, sortieIndex, tradeIndex, mode));
      row.addEventListener("dragend", window.routeDragEnd);
      row.addEventListener("dragover", (event) => window.routeDragOver(event, sortieIndex, mode));
      row.addEventListener("drop", (event) => { window.routeDrop(event, sortieIndex, tradeIndex, mode); renderModeColumn(id, mode === "speed" ? state.session.schedule.speed : state.session.schedule.balance, mode); });
      const step = document.createElement('span'); step.className = 'route-step-number'; step.textContent = String(tradeIndex + 1); row.append(step);
      const content = document.createElement('div'); content.className = 'route-content';
      const heading = document.createElement('strong'); heading.className = 'route-heading';
      const exchange = document.createElement('div'); exchange.className = 'route-exchange-items';
      const info = document.createElement('div'); info.className = 'route-trade-info';
      const actions = document.createElement('div'); actions.className = 'route-actions';
      const timerSpan = document.createElement('span'); timerSpan.id = `timer_${mode}_${sortieIndex}_${tradeIndex}`; timerSpan.className = trade.timerActive ? 'timer-countdown' : 'timer-countdown hidden'; timerSpan.textContent = '⏱ 00:00';
      const button = (className, text, callback, disabled = false) => { const item = document.createElement('button'); item.type = 'button'; item.className = className; item.textContent = text; item.disabled = disabled; item.addEventListener('click', callback); return item; };
      if (trade.isWaypoint) {
        heading.textContent = '🧭 ' + trade.island + ' · 경유지';
        info.append(document.createTextNode(trade.consumed ? '사용 재료: ' + itemTierLabel(trade.consumed.tier) + ' ' + trade.consumed.name + ' ×' + trade.consumed.count : '재료없음'), timerSpan);
        const timer = button('route-depart-button', trade.timerActive ? '⏱ 취소' : '🚀 출발', (event) => window.toggleTimer(event.currentTarget, mode, sortieIndex, tradeIndex, trade.island, trade.toClean), !!trade.completed);
        const complete = button('route-complete-button', trade.completed ? '완료됨' : '✔ 완료', (event) => window.completeWaypoint(event.currentTarget, mode, sortieIndex, tradeIndex), !!trade.completed);
        const remove = button('route-remove-button', '✕ 삭제', () => window.removeWaypoint(mode, sortieIndex, tradeIndex), !!trade.completed);
        actions.append(timer, complete, remove);
      } else {
        const routeLabels = [trade.isCoin ? '까마귀 주화' : '', trade.isSpec ? '특수 물자' : '', trade.isChained ? '연쇄 승선' : ''].filter(Boolean);
        heading.textContent = trade.island + (routeLabels.length ? ' · ' + routeLabels.join(' · ') : '');
        const tieredItem = (name, tier) => {
          const item = document.createElement('span'); item.className = 'route-labeled-item';
          const label = document.createElement('span'); label.className = 'route-tier-label ' + itemTone(tier); label.textContent = itemTierLabel(tier);
          const separator = document.createElement('span'); separator.className = 'route-tier-separator'; separator.textContent = ' | ';
          const itemName = document.createElement('span'); itemName.className = 'route-item-name ' + itemTone(tier); itemName.textContent = name;
          item.append(label, separator, itemName); return item;
        };
        const from = tieredItem(trade.fromClean, trade.fromTier);
        const arrow = document.createElement('span'); arrow.className = 'route-arrow'; arrow.textContent = '→';
        const to = tieredItem(trade.toClean, trade.toTier);
        const minus = button('route-count-adjust', '▼', (event) => window.adjustTradeCount(event, mode, sortieIndex, tradeIndex, -1), !!trade.completed);
        const count = document.createElement('span'); count.className = 'route-count-label'; count.textContent = '(' + trade.execC + '회 · 회당 ' + trade.mult + '개 · 획득 ' + numberFormat.format(trade.execC * trade.mult) + '개)';
        const plus = button('route-count-adjust', '▲', (event) => window.adjustTradeCount(event, mode, sortieIndex, tradeIndex, 1), !!trade.completed);
        const yieldAdjust = document.createElement('span'); yieldAdjust.className = 'route-yield-adjust'; yieldAdjust.append(minus, count, plus);
        exchange.append(from, arrow, to, yieldAdjust);
        info.append(document.createTextNode('교환 후 ' + (trade.afterW ?? 0).toLocaleString() + ' LT  |  도착 구간 +' + minutes(trade.estT) + ' '));
        const speed = document.createElement('span'); speed.className = trade.over ? 'route-overload' : 'route-speed'; speed.textContent = trade.over ? '⚠ 과적' : '💨 쾌속'; speed.title = '현재 섬에 도착하기 직전 이동 구간의 적재량 기준'; info.append(speed, timerSpan);
        info.title = 'LT는 현재 섬에서 교환을 마친 직후 배에 남은 화물 무게입니다. 과적/쾌속은 이 섬까지 오는 도착 구간 기준입니다.';
        const timer = button('route-depart-button', trade.timerActive ? '⏱ 취소' : '🚀 출발', (event) => window.toggleTimer(event.currentTarget, mode, sortieIndex, tradeIndex, trade.island, trade.toClean), !!trade.completed);
        const complete = button('route-complete-button', trade.completed ? '완료됨' : '✔ 완료', (event) => window.completeTradeAndTimer(event.currentTarget, mode, sortieIndex, tradeIndex, trade.originalIndex, trade.island, trade.toClean), !!trade.completed);
        actions.append(timer, complete);
      }
      content.append(heading);
      if (exchange.childElementCount) content.append(exchange);
      content.append(info);
      if (trade.debug) {
        const debug = document.createElement('div'); debug.className = 'route-debug';
        const formatDiagnostic = (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '기록 없음';
        debug.textContent = `↳ 부족:${formatDiagnostic(trade.debug.lack)} | 신분:${formatDiagnostic(trade.debug.score)} | 🏆적합도:${formatDiagnostic(trade.debug.fitness)}`;
        content.append(debug);
      }
      row.append(content, actions);
      route.append(row);
    });
    card.append(route);
    const footer = document.createElement("div"); footer.className = "sortie-footer";
    footer.textContent = `일리야 귀환 및 하역 · +${minutes(sortie.returnTime)}${sortie.returnOver ? " · 과적" : " · 쾌속"}`;
    const returnTimer = document.createElement("button"); returnTimer.type = "button"; returnTimer.textContent = window.ACTIVE_TIMERS?.[`return_${mode}_${sortieIndex}`] ? "⏱ 귀환 취소" : "🚀 귀환 출발"; returnTimer.addEventListener("click", (event) => window.toggleReturnTimer(event.currentTarget, mode, sortieIndex, sortie.returnTime));
    const returnSpan = document.createElement("span"); returnSpan.id = `timer_return_${mode}_${sortieIndex}`; returnSpan.className = window.ACTIVE_TIMERS?.[`return_${mode}_${sortieIndex}`] ? "timer-countdown" : "timer-countdown hidden"; returnSpan.textContent = "⏱ 00:00";
    footer.append(returnTimer, returnSpan);
    card.append(footer); root.append(card);
  });
}

function persistCompletion(payload) { return saveCompletionInventory(payload); }

function renderScheduleSlots(setStatus) {
  const root = document.getElementById("schedule-slot-controls");
  root.replaceChildren();
  const selected = state.session.selection?.selectedScheduleSlot ?? 1;
  const select = document.createElement("select"); select.id = "selected-schedule-slot"; select.setAttribute("aria-label", "스케줄 저장 슬롯 선택");
  for (let slot = 1; slot <= 5; slot += 1) {
    const option = document.createElement("option"); option.value = String(slot);
    option.textContent = `${slot}번 ${state.scheduleSlots?.[slot] ? "· 저장됨" : "· 비어 있음"}`; select.append(option);
  }
  select.value = String(selected);
  select.addEventListener("change", () => { if (window.__bdoScheduleRuntime?.pending) { select.value = String(state.session.selection?.selectedScheduleSlot ?? 1); setScheduleStatus("완료 저장을 먼저 확인하거나 재시도하세요.", "error"); return; } state.session.selection ||= {}; state.session.selection.selectedScheduleSlot = Number(select.value); window.dispatchEvent(new CustomEvent("bdo:session-changed")); renderScheduleSlots(setStatus); });
  root.append(select);
  const button = (label, click, disabled = false) => { const item = document.createElement("button"); item.type = "button"; item.textContent = label; item.disabled = disabled; item.addEventListener("click", click); return item; };
  const slot = () => Number(document.getElementById("selected-schedule-slot").value);
  root.append(button("저장", async () => { const current = slot(); try { await whenPersistenceIdle(); await saveScheduleSlot(current); renderScheduleSlots(setStatus); setScheduleStatus(`${current}번 회차 스케줄을 저장했습니다.`, "success"); } catch (error) { setScheduleStatus(`슬롯 저장 실패: ${error.message}`, "error"); } }, state.session.scannedTrades === null || !state.session.schedule));
  root.append(button("불러오기", async () => { const current = slot(); if (!state.scheduleSlots?.[current]) return; if (state.session.scannedTrades !== null && !window.confirm(`${current}번 슬롯 내용으로 현재 회차를 바꿀까요?`)) return; try { await loadScheduleSlot(current); syncScheduleState(); renderModeColumn("col-speed", state.session.schedule?.speed, "speed"); renderModeColumn("col-balance", state.session.schedule?.balance, "balance"); renderScheduleDiagnostics(state); renderScheduleSlots(setStatus); setScheduleStatus(`${current}번 스케줄 회차를 불러왔습니다.`, "success"); } catch (error) { setScheduleStatus(`슬롯 불러오기 실패: ${error.message}`, "error"); } }, !state.scheduleSlots?.[selected]));
  root.append(button("삭제", async () => { const current = slot(); if (!state.scheduleSlots?.[current] || !window.confirm(`${current}번 저장 슬롯을 삭제할까요?`)) return; try { await deleteScheduleSlot(current); renderScheduleSlots(setStatus); setScheduleStatus(`${current}번 슬롯을 삭제했습니다.`, "success"); } catch (error) { setScheduleStatus(`슬롯 삭제 실패: ${error.message}`, "error"); } }, !state.scheduleSlots?.[selected]));
}

export function initScheduleUI(setStatus) {
  window.renderModeColumn = renderModeColumn;
  window.showToast = (message) => setScheduleStatus(message, "info");
  window.__bdoRenderTradeList = () => window.dispatchEvent(new CustomEvent("bdo:trade-list-changed"));
  window.__bdoScheduleRuntime.installCompletionAdapters((payload) => persistCompletion(payload), state, setScheduleStatus);
  const modeSelect = document.getElementById("brief-session-mode");
  const { MODES, MODE_LABELS } = window.BDO_CONSTANTS;
  for (const mode of MODES) { const option = document.createElement("option"); option.value = mode; option.textContent = MODE_LABELS[mode]; modeSelect.append(option); }
  document.getElementById("generate-schedule").addEventListener("click", () => {
    try {
      if (!window.__bdoScheduleRuntime.generateSchedule(state, setScheduleStatus)) return;
      renderModeColumn("col-speed", state.session.schedule.speed, "speed");
      renderModeColumn("col-balance", state.session.schedule.balance, "balance");
      renderScheduleDiagnostics(state);
      renderScheduleSlots(setStatus);
      setScheduleStatus("쾌속·균형 스케줄을 생성했습니다.", "success");
    } catch (error) { setScheduleStatus(`스케줄 생성 실패: ${error.message}`, "error"); }
  });
  modeSelect.addEventListener("change", () => {
    if (window.__bdoScheduleRuntime.pending) { syncScheduleState(); setScheduleStatus("완료 저장을 먼저 확인하거나 재시도하세요.", "error"); return; }
    if (state.session.scannedTrades === null) return;
    state.session.config ||= structuredClone({ ship: state.settings.ship, parley: state.settings.parley, tuning: state.settings.tuning });
    state.session.config.ship.mode = modeSelect.value;
    window.dispatchEvent(new CustomEvent("bdo:session-changed"));
    try {
      if (window.__bdoScheduleRuntime.generateSchedule(state, setScheduleStatus)) {
        renderModeColumn("col-speed", state.session.schedule.speed, "speed"); renderModeColumn("col-balance", state.session.schedule.balance, "balance");
        renderScheduleDiagnostics(state); renderScheduleSlots(setStatus); setScheduleStatus("이번 회차 교역 모드를 바꾸고 스케줄을 다시 계산했습니다.", "success");
      }
    } catch (error) { setScheduleStatus(`스케줄 생성 실패: ${error.message}`, "error"); }
  });
  document.getElementById("wpUseMat").addEventListener("change", window.toggleWaypointMaterial);
  document.getElementById("confirm-waypoint").addEventListener("click", window.confirmWaypoint);
  document.getElementById("close-waypoint").addEventListener("click", window.closeWaypointModal);
  document.getElementById("retry-completion-save").addEventListener("click", () => window.__bdoScheduleRuntime.retryCompletion());
  renderScheduleSlots(setStatus);
  document.getElementById("open-schedule").addEventListener("click", syncScheduleState);
  document.querySelectorAll("[data-brief-mode]").forEach((button) => button.addEventListener("click", () => {
    if (window.__bdoScheduleRuntime.pending) { setScheduleStatus("완료 저장을 먼저 확인하거나 재시도하세요.", "error"); syncScheduleState(); return; }
    const mode = button.dataset.briefMode; state.session.selection ||= {}; state.session.selection.briefMode = mode;
    document.getElementById("schedule-columns").dataset.mode = mode;
    document.querySelectorAll("[data-brief-mode]").forEach((tab) => tab.setAttribute("aria-selected", String(tab === button)));
    window.dispatchEvent(new CustomEvent("bdo:session-changed"));
  }));
  const copyDiagnostics = () => {
    renderScheduleDiagnostics(state);
    const text = document.getElementById("schedule-diagnostics").textContent;
    navigator.clipboard.writeText(text).then(() => { document.getElementById("diagnostics-copy-status").textContent = "경로 요약과 ENGINE_DEBUG를 복사했습니다."; }, (error) => { document.getElementById("diagnostics-copy-status").textContent = `복사 실패: ${error.message}`; });
  };
  document.getElementById("open-engine-diagnostics").addEventListener("click", () => renderScheduleDiagnostics(state));
  document.getElementById("copy-engine-diagnostics").addEventListener("click", copyDiagnostics);
  document.getElementById("copy-engine-diagnostics-dialog").addEventListener("click", copyDiagnostics);
  window.__bdoRenderScheduleDiagnostics = renderScheduleDiagnostics;
  window.__bdoAppState = state;
  window.addEventListener("bdo:session-changed", () => { if (state.session.scannedTrades === null) renderScheduleSlots(setStatus); });
  window.addEventListener("bdo:trade-list-changed", () => {
    if (state.session.schedule === null) {
      document.getElementById("col-speed").replaceChildren();
      document.getElementById("col-balance").replaceChildren();
      setScheduleStatus("물교 목록이 바뀌었습니다. 다시 스케줄을 생성하세요.", "info");
    }
  });
}

export function syncScheduleState() {
  window.__bdoScheduleRuntime.syncLegacyState(state);
  const mode = state.session.selection?.briefMode ?? "both";
  document.getElementById("schedule-columns").dataset.mode = mode;
  document.querySelectorAll("[data-brief-mode]").forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.briefMode === mode)));
  const modeSelect = document.getElementById("brief-session-mode");
  if (modeSelect) { modeSelect.value = state.session.config?.ship?.mode ?? state.settings.ship?.mode ?? "inner"; modeSelect.disabled = state.session.scannedTrades === null; }
  if (state.session.schedule) {
    renderModeColumn("col-speed", state.session.schedule.speed, "speed");
    renderModeColumn("col-balance", state.session.schedule.balance, "balance");
    renderScheduleDiagnostics(state);
  } else {
    document.getElementById("col-speed").replaceChildren(); document.getElementById("col-balance").replaceChildren();
    renderScheduleDiagnostics(state);
  }
  renderScheduleSlots(setScheduleStatus);
}











