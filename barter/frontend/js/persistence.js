import { api } from "./api.js";
import { applyBootstrap, state } from "./state.js";

let mutationQueue = Promise.resolve();
const createMutationId = () => crypto.randomUUID();
const runtime = () => window.__bdoScheduleRuntime;

export async function refreshPersistentState({ restoreSession = false } = {}) {
  const snapshot = applyBootstrap(await api.bootstrap());
  if (restoreSession) runtime().restoreWorkingSession(state, snapshot.workingSession);
  return snapshot;
}

function enqueue(operation) {
  state.persistencePending++;
  const result = mutationQueue.then(operation).finally(() => { state.persistencePending--; });
  mutationQueue = result.catch(() => undefined);
  return result;
}

export const whenPersistenceIdle = () => mutationQueue;

function assertMutable() {
  if (runtime()?.pending) throw new Error("완료 저장을 먼저 확인하거나 재시도하세요. 다른 회차 변경은 대기합니다.");
}

function enqueueMutation(send) {
  assertMutable();
  return enqueue(async () => {
    const baseRevision = state.revision;
    if (!Number.isSafeInteger(baseRevision)) throw new Error("저장 버전을 먼저 불러와야 합니다.");
    const mutationId = createMutationId();
    try {
      const result = await send({ mutationId, baseRevision });
      state.revision = result.revision;
      try {
        await refreshPersistentState();
      } catch (reloadError) {
        const error = new Error(`서버 저장은 확인됐지만 최신 상태 재조회가 실패했습니다: ${reloadError.message}`); error.committed = true; throw error;
      }
      return result;
    } catch (error) {
      // Conflict/error never becomes a local success. Re-read only to display current server state.
      if (error.status === 409) {
        try { await refreshPersistentState(); } catch { /* retain last confirmed in-memory state */ }
      }
      throw error;
    }
  });
}

export const saveInventory = (items) => enqueueMutation(({ mutationId, baseRevision }) => api.patchInventory({ mutationId, baseRevision, kind: "manual", patch: { items } }));
export const saveWarehouseInventory = (items, feedback) => enqueueMutation(({ mutationId, baseRevision }) => api.patchInventory({
  mutationId,
  baseRevision,
  kind: "warehouse",
  patch: { type: "master_inventory_patch", version: 1, items },
  ...(feedback ? { feedback } : {}),
}));
export const saveInventoryOrder = (order) => enqueueMutation(({ mutationId, baseRevision }) => api.saveInventoryOrder({ mutationId, baseRevision, order }));
export const saveSettings = (settings) => enqueueMutation(({ mutationId, baseRevision }) => api.patchSettings({ mutationId, baseRevision, settings }));

export function saveWorkingSession() {
  assertMutable();
  const session = runtime().snapshotWorkingSession(state);
  if (!session) return Promise.resolve();
  return enqueueMutation((envelope) => api.saveWorkingSession({ ...envelope, session }));
}

export async function resetWorkingSession() {
  await enqueueMutation((envelope) => api.resetWorkingSession(envelope));
  runtime().restoreWorkingSession(state, null);
  window.dispatchEvent(new CustomEvent("bdo:trade-list-changed"));
  window.__bdoRenderAll?.();
}

export function saveScheduleSlot(slot) {
  assertMutable();
  const session = runtime().snapshotWorkingSession(state);
  if (!session?.schedule || !session.schedule.speed.length && !session.schedule.balance.length) throw new Error("저장할 스케줄 데이터가 없습니다.");
  const snapshot = { version: 1, createdAt: Date.now(), session };
  return enqueueMutation((envelope) => api.saveScheduleSlot(slot, { ...envelope, snapshot }));
}

export async function loadScheduleSlot(slot) {
  assertMutable();
  await whenPersistenceIdle();
  await refreshPersistentState();
  const snapshot = state.scheduleSlots[String(slot)];
  if (!snapshot) throw new Error(`${slot}번 슬롯이 비어 있습니다.`);
  const session = JSON.parse(JSON.stringify(snapshot.session));
  session.id = createMutationId();
  session.selection = { ...session.selection, selectedScheduleSlot: Number(slot) };
  await enqueueMutation((envelope) => api.saveWorkingSession({ ...envelope, session }));
  runtime().restoreWorkingSession(state, session);
  window.__bdoRenderAll?.();
}

export const deleteScheduleSlot = (slot) => enqueueMutation((envelope) => api.deleteScheduleSlot(slot, envelope));

// Exact-body retries resolve uncertain response loss using bounded server receipts.
// Reconciliation is allowed only for inventory edits while this working session is unchanged.
export function saveCompletionInventory(request) {
  return enqueue(async () => {
    if (request.beforeInventory && !Object.hasOwn(request, "inventoryDeltas")) {
      // Rebasing mutates the request's absolute stocks; retries must retain the original consumption/gain.
      Object.defineProperty(request, "inventoryDeltas", { value: Object.freeze(Object.fromEntries(
        Object.entries(request.patch.items).map(([name, update]) => [name, update.stock - request.beforeInventory[name]])
      )), enumerable: false });
    }
    if (!request.session) request.session = runtime().snapshotWorkingSession(state);
    if (request.sessionRevision === undefined) {
      request.baseRevision = state.revision;
      request.sessionRevision = state.sessionRevision;
    }
    const send = async (body) => {
      const result = await api.completeSession(body);
      state.revision = result.revision;
      await refreshPersistentState();
      return result;
    };
    try { return await send(request); }
    catch (error) {
      if (error.status !== 409) throw error;
      await refreshPersistentState();
      if (state.sessionRevision !== request.sessionRevision || state.workingSession?.id !== request.session?.id) {
        throw new Error("저장된 회차가 다른 작업에서 변경됐습니다. 현재 회차를 다시 읽어 확인하세요.");
      }
      if (!request.beforeInventory) throw error;
      const current = new Map(state.inventory.map((row) => [row.programName, row.stock]));
      const items = {};
      for (const name of Object.keys(request.patch.items)) {
        const stock = current.get(name);
        const before = request.beforeInventory[name];
        if (!Number.isSafeInteger(stock) || !Number.isSafeInteger(before)) throw new Error(`${name}의 재고가 미확인 상태입니다.`);
        const delta = request.inventoryDeltas[name];
        const next = stock + delta;
        if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(next)) throw new Error(`${name}의 재고 계산값이 올바르지 않습니다.`);
        if (next < 0) throw new Error(`${name}의 현재 재고가 완료 차감량보다 부족합니다. 재고를 확인한 뒤 저장을 재시도하세요.`);
        items[name] = { stock: next };
      }
      request.mutationId = createMutationId();
      request.baseRevision = state.revision;
      request.patch = { items };
      return await send(request);
    }
  });
}

window.addEventListener("bdo:session-changed", () => {
  if (runtime()?.pending) return;
  const failed = (error) => {
    const status = document.getElementById("runtime-status");
    if (status) { status.dataset.kind = "error"; status.textContent = `회차 저장 실패: ${error.message}`; }
  };
  try {
    saveWorkingSession().then((result) => {
      if (!result || state.persistencePending > 0) return;
      const status = document.getElementById("runtime-status");
      if (status) { status.dataset.kind = "success"; status.textContent = "현재 회차 저장을 확인했습니다."; }
    }).catch(failed);
  } catch (error) { failed(error); }
});
