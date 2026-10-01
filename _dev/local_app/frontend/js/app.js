import { refreshPersistentState } from "./persistence.js";
import { state } from "./state.js";
import { renderInventory } from "./inventory-ui.js";
import { renderSettings } from "./settings-ui.js";
import { applyViewerState, renderFreeRoute, renderMap, renderViewer } from "./map-ui.js";
import { initWarehouseScanUI } from "./warehouse-scan-ui.js";
import { initRecognitionUI } from "./recognition-ui.js";
import { openPatchReview } from "./patch-review.js";
import { initTradeSessionUI, renderTradeList } from "./trade-ui.js";
import { initScheduleUI, syncScheduleState } from "./schedule-ui.js";
import { initTradeMasterUI } from "./trade-master-ui.js";

const status = document.querySelector("#runtime-status");
const content = document.querySelector("#app-content");
function setStatus(message, kind = "info") { status.textContent = message; status.dataset.kind = kind; }
function renderAll() {
  if (!state.inventory.length) return;
  renderInventory(document.querySelector("#inventory-root"), setStatus);
  renderSettings(document.querySelector("#ship-root"), setStatus, renderAll);
  renderMap(document.querySelector("#map-root"), setStatus, renderAll);
  renderViewer(document.querySelector("#viewer-root"), setStatus, renderAll);
  renderFreeRoute(document.querySelector("#free-route-root"), setStatus);
  renderTradeList();
  syncScheduleState();
  applyViewerState();
  window.__bdoApplyAppZoom?.();
  content.setAttribute("aria-busy", "false");
}
const warehouseCaptureUI = initWarehouseScanUI({ setStatus, onPatch: (patch, report, imageFile) => openPatchReview(patch, report, { setStatus, onApplied: renderAll, imageFile }) });
initRecognitionUI({ warehouseCaptureUI });
initScheduleUI(setStatus);
initTradeMasterUI();
window.__bdoRenderTradeList = renderTradeList;
window.__bdoRenderAll = renderAll;
window.addEventListener("bdo:trade-list-changed", renderTradeList);
window.addEventListener("beforeunload", (event) => {
  if (state.persistencePending > 0 || window.__bdoScheduleRuntime?.pending) {
    event.preventDefault();
    event.returnValue = "";
  }
});
async function load({ restoreSession = false } = {}) {
  setStatus("SQLite에 저장된 영구 상태를 불러오는 중입니다.", "saving");
  content.setAttribute("aria-busy", "true");
  try {
    const snapshot = await refreshPersistentState({ restoreSession });
    await initTradeSessionUI(setStatus);
    window.__bdoScheduleRuntime.syncLegacyState(state);
    renderAll();
    setStatus(`저장 상태를 확인했습니다 · 품목 ${snapshot.inventory.length}종 · 저장 버전 ${snapshot.revision}`, "success");
  } catch (error) {
    setStatus(`저장 상태를 불러오지 못했습니다: ${error.message}`, "error");
    content.setAttribute("aria-busy", "false");
  }
}

document.querySelector("#reload-state").addEventListener("click", load);
load({ restoreSession: true });
