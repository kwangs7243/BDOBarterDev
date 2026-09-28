const dialogs = [...document.querySelectorAll("dialog.app-dialog")];

function openDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog && !dialog.open) dialog.showModal();
}

function zoomScale() { return Number(getComputedStyle(document.body).zoom) || 1; }
function applyAppZoomMetrics() {
  const scale = Number(getComputedStyle(document.documentElement).getPropertyValue("--app-zoom")) || 1;
  document.body.style.width = `${window.innerWidth / scale}px`;
  document.body.style.height = `${window.innerHeight / scale}px`;
  const bodyStyle = getComputedStyle(document.body);
  const header = document.querySelector(".app-header");
  const headerStyle = getComputedStyle(header);
  const bodyInsets = Number.parseFloat(bodyStyle.paddingTop) + Number.parseFloat(bodyStyle.paddingBottom);
  const headerSpace = header.getBoundingClientRect().height / scale + Number.parseFloat(headerStyle.marginBottom);
  document.querySelector("main.workspace").style.height = `${Math.max(240, window.innerHeight / scale - bodyInsets - headerSpace)}px`;
  const width = (fraction) => Math.min(window.innerWidth - 24, window.innerWidth * fraction) / scale;
  const height = (fraction) => Math.min(window.innerHeight - 24, window.innerHeight * fraction) / scale;
  for (const dialog of dialogs) {
    dialog.style.maxWidth = `${(window.innerWidth - 24) / scale}px`;
    dialog.style.maxHeight = `${(window.innerHeight - 24) / scale}px`;
    if (dialog.classList.contains("briefing-dialog")) { dialog.style.width = `${width(.9)}px`; dialog.style.height = `${height(.88)}px`; }
    else if (dialog.classList.contains("tuning-dialog")) { dialog.style.width = `${width(.94)}px`; dialog.style.height = `${height(.88)}px`; }
    else if (dialog.classList.contains("map-tools-dialog")) { dialog.style.width = `${width(.92)}px`; dialog.style.height = `${height(.86)}px`; }
    else dialog.style.width = `${Math.min(620, (window.innerWidth - 24) / scale)}px`;
  }
}
window.__bdoApplyAppZoom = applyAppZoomMetrics;
window.addEventListener("resize", applyAppZoomMetrics);

for (const button of document.querySelectorAll("[data-close-dialog]")) {
  button.addEventListener("click", () => button.closest("dialog")?.close());
}

for (const [buttonId, dialogId] of [
  ["open-json-import", "json-import-dialog"],
  ["open-schedule", "schedule-dialog"],
  ["open-tuning", "tuning-dialog"],
  ["open-map-tools", "map-tools-dialog"],
  ["open-engine-diagnostics", "engine-diagnostics-dialog"],
]) {
  document.getElementById(buttonId)?.addEventListener("click", () => openDialog(dialogId));
}
document.getElementById("brief-open-tuning")?.addEventListener("click", () => openDialog("tuning-dialog"));

for (const mode of ["speed", "balance"]) {
  for (const id of [`open-map-${mode}`, `brief-map-${mode}`]) document.getElementById(id)?.addEventListener("click", () => {
    const host = document.getElementById("map-tools-dialog");
    if (!host.open) host.showModal();
    requestAnimationFrame(() => {
      if (typeof window.__bdoOpenMapViewer === "function") window.__bdoOpenMapViewer(mode);
    });
  });
}

for (const button of document.querySelectorAll("[data-tuning-tab]")) {
  button.addEventListener("click", () => {
    const mode = button.dataset.tuningTab;
    for (const tab of document.querySelectorAll("[data-tuning-tab]")) tab.setAttribute("aria-selected", String(tab === button));
    document.querySelector("#tuning-root").dataset.mode = mode;
    window.dispatchEvent(new CustomEvent("bdo:tuning-tab-changed", { detail: { mode } }));
  });
}

for (const dialog of dialogs) {
  const bar = dialog.querySelector(".dialog-titlebar");
  if (!bar) continue;
  bar.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    const rect = dialog.getBoundingClientRect();
    const scale = zoomScale();
    const offsetX = (event.clientX - rect.left) / scale;
    const offsetY = (event.clientY - rect.top) / scale;
    dialog.style.position = "fixed";
    dialog.style.margin = "0";
    dialog.style.transform = "none";
    dialog.style.left = `${rect.left / scale}px`;
    dialog.style.top = `${rect.top / scale}px`;
    bar.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      const left = Math.max(0, Math.min(window.innerWidth / scale - 80, moveEvent.clientX / scale - offsetX));
      const top = Math.max(0, Math.min(window.innerHeight / scale - 48, moveEvent.clientY / scale - offsetY));
      dialog.style.left = `${left}px`;
      dialog.style.top = `${top}px`;
    };
    const stop = () => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", stop);
      bar.removeEventListener("pointercancel", stop);
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", stop);
    bar.addEventListener("pointercancel", stop);
  });
}

export { openDialog };
