// Runtime bridge for the preserved classic-script engine and the SPEC-004 in-memory session.
let inventory = {};
let scannedTrades = [];
let tierRules = { 1: 20, 2: 20, 3: 20, 4: 20, 5: 2 };
let sortiesSpeed = [];
let sortiesBalance = [];
let sortiesBulk = [];
let draggedRoute = null;
let draggedSortie = null;
let completionStore = async () => { throw new Error("완료 재고 저장기가 초기화되지 않았습니다."); };
let scheduleStatus = () => {};
let pendingCompletion = null;
let externalSessionMutationPending = false;
const sessionMutationPending = () => pendingCompletion || (externalSessionMutationPending ? true : null);

function showToast(message) { scheduleStatus(message, "info"); }
function openModal() { window.__bdoOpenBriefing?.(); }
function isValidIsland(islandName) {
  const cleanName = String(islandName || "").replace(/ 섬$/, "").replace(/ 제도$/, "").trim();
  return islandCoordinates[cleanName] !== undefined || islandCoordinates[`${cleanName} 섬`] !== undefined || islandCoordinates[`${cleanName} 제도`] !== undefined;
}
function saveInventoryState() {}
function saveScannedTradesSilent() {}
function renderTrades() { window.dispatchEvent(new CustomEvent("bdo:trade-list-changed")); }

function syncLegacyState(appState) {
  const session = appState.session;
  window.applyBdoPersistentConfig({ ...appState.settings, ...(session.config || {}) });
  inventory = Object.fromEntries(appState.inventory.map((item) => [item.programName, { ...item }]));
  tierRules = Object.fromEntries(Object.entries(appState.settings.tierRules || {}).map(([key, value]) => [Number(key), value]));
  scannedTrades = session.scannedTrades || [];
  sortiesSpeed = session.schedule?.speed || [];
  sortiesBalance = session.schedule?.balance || [];
  window.ACTIVE_TIMERS = session.timers || (session.timers = {});
  const ship = session.config?.ship || appState.settings.ship || {};
  const parley = session.config?.parley || appState.settings.parley || {};
  document.getElementById("normalWeight").value = ship.normalWeight ?? 14379;
  document.getElementById("maxWeight").value = ship.maxWeight ?? 24445;
  document.getElementById("parleyPerTrade").value = parley.normalCost ?? 10973;
  document.getElementById("parleyCrow").value = parley.crowCost ?? 15962;
  document.getElementById("maxParley").value = session.remainingParley ?? parley.defaultBudget ?? 1500000;
}

function findUnknownStockTrades(trades) {
  const known = new Map(Object.values(inventory).map((item) => [item.programName, item.stock]));
  const unknown = new Set();
  for (const trade of trades || []) {
    if (trade.deleted || trade.disabled || (Number.parseInt(trade.count, 10) || 0) <= 0) continue;
    for (const name of [trade.fromItem, trade.toItem]) {
      const clean = String(name || "").replace(/\[.*?\]\s*/g, "").replace(/\s*x\s*\d+/gi, "").trim();
      if (known.has(clean) && known.get(clean) === null) unknown.add(clean);
    }
  }
  return [...unknown];
}

function generateSchedule(appState, setStatus) {
  scheduleStatus = setStatus;
  if (sessionMutationPending()) { showToast("완료 저장을 먼저 확인하세요."); return false; }
  ensureSessionContext(appState);
  if (appState.session.scannedTrades === null) { showToast("먼저 회차 물교 JSON을 적용하세요."); return false; }
  syncLegacyState(appState);
  const unknown = findUnknownStockTrades(scannedTrades);
  if (unknown.length) { showToast(`현재 재고를 확인해야 계산할 수 있습니다: ${unknown.join(", ")}`); return false; }
  const mode = appState.session.config.ship.mode || "inner";
  window.APP_CONFIG.ALLOW_OCEAN = mode;
  document.getElementById("maxParley").value = appState.session.remainingParley ?? appState.settings.parley?.defaultBudget ?? 1500000;
  window.runAlgorithmAllModes(false);
  appState.session.schedule = { speed: sortiesSpeed, balance: sortiesBalance };
  appState.session.completed = { speed: [], balance: [] };
  appState.session.timers = window.ACTIVE_TIMERS;
  appState.session.diagnostics = { mode, generatedAt: Date.now(), speed: sortiesSpeed.length, balance: sortiesBalance.length, engineDebug: window.ENGINE_DEBUG || null };
  appState.session.remainingParley = Number(document.getElementById("maxParley").value) || 0;
  window.dispatchEvent(new CustomEvent("bdo:session-changed"));
  return true;
}

function canCompleteScheduleStep(schedule, si, ti) {
    if (schedule.slice(0, si).some(s => s.trades.some(t => !t.completed))) {
        showToast('앞 출항의 교환과 경유지를 먼저 완료하세요.');
        return false;
    }
    const sortie = schedule[si], trade = sortie.trades[ti];
    const consumed = trade.isWaypoint ? trade.consumed : {name:trade.fromClean, count:trade.execC*trade.reqA};
    if (!consumed) return true;
    const cargo = Object.fromEntries(Object.entries(getSortieCargoPlan(sortie.trades).reqItems).map(([name, req]) => [name, req.count]));
    sortie.trades.slice(0, ti).forEach(t => {
        if (!t.completed) return;
        if (t.isWaypoint) { if (t.consumed) cargo[t.consumed.name] = (cargo[t.consumed.name] || 0) - t.consumed.count; return; }
        cargo[t.fromClean] = (cargo[t.fromClean] || 0) - t.execC*t.reqA;
        cargo[t.toClean] = (cargo[t.toClean] || 0) + t.execC*t.mult;
    });
    if ((cargo[consumed.name] || 0) < consumed.count) {
        showToast('필요한 물품을 얻는 앞선 교환을 먼저 완료하세요.');
        return false;
    }
    return true;
}

function wrapCompletion(original) {
  return function(...args) {
    const btn = args[0];
    const mode = args[1];
    const si = args[2];
    const ti = args[3];
    const schedule = mode === "speed" ? sortiesSpeed : sortiesBalance;
    const trade = schedule?.[si]?.trades?.[ti];
    if (!trade || trade.completed) return;
    if (sessionMutationPending()) {
      showToast("이전 완료의 재고 저장이 대기 중입니다. 재시도 버튼을 사용하세요.");
      return;
    }
    syncLegacyState(window.__bdoAppState);
    if (!canCompleteScheduleStep(schedule, si, ti)) return;
    const count = trade.execC;
    const cost = Number(document.getElementById(trade.isCoin ? "parleyCrow" : "parleyPerTrade").value);
    const budget = Number(document.getElementById("maxParley").value);
    const originalTrade = scannedTrades[trade.originalIndex ?? args[4]];
    if (!Number.isSafeInteger(count) || count <= 0 || !Number.isSafeInteger(cost) || cost < 0
        || !Number.isSafeInteger(budget) || budget < count * cost
        || originalTrade && (originalTrade.deleted || originalTrade.count < count)) {
      showToast("현재 교섭력 또는 남은 교환 횟수가 부족합니다. 스케줄을 다시 계산하세요.");
      return;
    }
    // The warehouse catalog tracks tiers 1-5; tier 6 cargo is outside that catalog.
    if (trade.fromTier >= 1 && trade.fromTier <= 5 && (!Number.isSafeInteger(inventory[trade.fromClean]?.stock)
        || inventory[trade.fromClean].stock < count * trade.reqA)) {
      showToast("소모품 재고가 부족합니다. 앞선 교환 완료 또는 창고 재고를 확인하세요.");
      return;
    }
    const before = Object.fromEntries(Object.entries(inventory).map(([name, item]) => [name, item.stock]));
    window.__bdoCompletionInvocationObserver?.("completeTrade");
    original.apply(this, args);
    const after = Object.fromEntries(Object.entries(inventory).map(([name, item]) => [name, item.stock]));
    const changed = Object.fromEntries(Object.entries(after).filter(([name, value]) => before[name] !== value).map(([name, stock]) => [name, { stock }]));
    const remaining = Number(document.getElementById("maxParley").value);
    const appState = window.__bdoAppState;
    if (appState) {
      appState.session.remainingParley = Number.isSafeInteger(remaining) ? remaining : appState.session.remainingParley;
      appState.session.scannedTrades = scannedTrades;
      appState.session.timers = window.ACTIVE_TIMERS;
    }
    const payload = { mutationId: crypto.randomUUID(), baseRevision: appState.revision, kind: "completion", patch: { items: changed } };
    payload.session = snapshotWorkingSession(appState);
    Object.defineProperty(payload, "beforeInventory", { value: before, enumerable: false });
    pendingCompletion = { payload, before, after, changed, trade, btn };
    trade.__completionPending = true;
    persistPendingCompletion();
  };
}

async function persistPendingCompletion() {
  if (!pendingCompletion) return;
  const item = pendingCompletion;
  const retry = document.getElementById("retry-completion-save");
  retry.hidden = true;
  scheduleStatus("완료 재고를 저장하고 있습니다.", "saving");
  try {
    await completionStore(item.payload, item.before);
    item.trade.__completionPending = false;
    pendingCompletion = null;
    syncLegacyState(window.__bdoAppState);
    window.__bdoRenderAll?.();
    scheduleStatus("완료와 재고 저장을 확인했습니다.", "success");
  } catch (error) {
    retry.hidden = false;
    scheduleStatus(`완료 계산은 유지했고 재고 저장이 확인되지 않았습니다: ${error.message}`, "error");
  }
}

function installCompletionAdapters(store, appState, setStatus) {
  completionStore = store;
  scheduleStatus = setStatus;
  window.__bdoAppState = appState;
  if (window.__spec005CompletionInstalled) return;
  const originalTrade = window.completeTrade;
  const originalWaypoint = window.completeWaypoint;
  const originalTradeAndTimer = window.completeTradeAndTimer;
  window.completeTrade = wrapCompletion(originalTrade);
  window.completeWaypoint = function(btn, mode, si, ti) {
    const waypoint = (mode === "speed" ? sortiesSpeed : sortiesBalance)?.[si]?.trades?.[ti];
    if (!waypoint || waypoint.completed || sessionMutationPending()) return;
    if (!canCompleteScheduleStep(mode === "speed" ? sortiesSpeed : sortiesBalance, si, ti)) return;
    const before = Object.fromEntries(Object.entries(inventory).map(([name, row]) => [name, row.stock]));
    window.__bdoCompletionInvocationObserver?.("completeWaypoint");
    originalWaypoint.call(this, btn, mode, si, ti);
    const after = Object.fromEntries(Object.entries(inventory).map(([name, row]) => [name, row.stock]));
    const changed = Object.fromEntries(Object.entries(after).filter(([name, value]) => before[name] !== value).map(([name, stock]) => [name, { stock }]));
    {
      const payload = { mutationId: crypto.randomUUID(), baseRevision: appState.revision, kind: "completion", patch: { items: changed } };
    payload.session = snapshotWorkingSession(appState);
    Object.defineProperty(payload, "beforeInventory", { value: before, enumerable: false });
      pendingCompletion = { payload, before, after, changed, trade: waypoint, btn };
      waypoint.__completionPending = true;
      persistPendingCompletion();
    }
  };
  window.completeTradeAndTimer = function(...args) {
    if (sessionMutationPending()) { showToast('완료 저장을 먼저 확인하세요.'); return; }
    const schedule = args[1] === 'speed' ? sortiesSpeed : sortiesBalance;
    if (!schedule?.[args[2]]?.trades?.[args[3]] || !canCompleteScheduleStep(schedule, args[2], args[3])) return;
    return originalTradeAndTimer.apply(this, args);
  };
  window.__spec005CompletionInstalled = true;
}

function ensureSessionContext(appState) {
  const session = appState.session;
  session.id ||= crypto.randomUUID();
  session.config ||= JSON.parse(JSON.stringify({ ship: appState.settings.ship, parley: appState.settings.parley, tuning: appState.settings.tuning }));
  session.selection ||= { briefMode: "speed", selectedScheduleSlot: 1 };
}

function snapshotWorkingSession(appState) {
  const session = appState.session;
  if (session.scannedTrades === null) return null;
  ensureSessionContext(appState);
  const selection = session.selection || {};
  return JSON.parse(JSON.stringify({
    version: 1, id: session.id, scannedTrades: session.scannedTrades,
    schedule: session.schedule, completed: session.completed,
    remainingParley: session.remainingParley ?? appState.settings.parley.defaultBudget,
    config: session.config,
    selection: { briefMode: selection.briefMode || "speed", selectedScheduleSlot: selection.selectedScheduleSlot || 1 },
    diagnostics: session.diagnostics,
  }, (key, value) => ["timerActive", "timerEnd", "alarmPlayed", "__completionPending"].includes(key) ? undefined : value));
}

function restoreWorkingSession(appState, payload) {
  if (pendingCompletion) throw new Error("완료 저장이 대기 중입니다. 먼저 저장을 재시도하세요.");
  appState.session = payload ? { ...JSON.parse(JSON.stringify(payload)), timers: {}, drag: null } : {
    scannedTrades: null, schedule: null, completed: null, remainingParley: null,
    timers: {}, selection: null, drag: null, diagnostics: null,
  };
  for (const sorties of Object.values(appState.session.schedule || {})) {
    for (const sortie of sorties) for (const trade of sortie.trades) {
      delete trade.timerActive; delete trade.timerEnd; delete trade.alarmPlayed; delete trade.__completionPending;
    }
  }
  window.ACTIVE_TIMERS = {};
  window.ENGINE_DEBUG = appState.session.diagnostics?.engineDebug || null;
  window.dispatchEvent(new CustomEvent("bdo:timers-reset"));
  syncLegacyState(appState);
}

for (const name of ["routeDrop", "sortieDrop", "adjustTradeCount", "confirmWaypoint", "removeWaypoint"]) {
  const original = window[name];
  window[name] = function(...args) {
    if (sessionMutationPending()) { showToast("완료 저장을 먼저 확인하세요."); return; }
    const result = original.apply(this, args);
    window.dispatchEvent(new CustomEvent("bdo:session-changed"));
    return result;
  };
}

window.__bdoScheduleRuntime = { syncLegacyState, generateSchedule, snapshotWorkingSession, restoreWorkingSession, installCompletionAdapters,
  retryCompletion: persistPendingCompletion,
  setExternalSessionMutationPending(value) { externalSessionMutationPending = value === true; },
  get pending() { return sessionMutationPending(); } };
window.renderTrades = renderTrades;
window.saveInventoryState = saveInventoryState;
window.saveScannedTradesSilent = saveScannedTradesSilent;
window.__SPEC005_SCRIPT_LOADED = window.__SPEC005_SCRIPT_LOADED || {};
window.__SPEC005_SCRIPT_LOADED["scheduler-runtime.js"] = true;
