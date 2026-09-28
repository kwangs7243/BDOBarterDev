const jsonRequest = async (path, { method = "GET", body } = {}) => {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Request failed: ${response.status}`);
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
};

export const api = Object.freeze({
  health: () => jsonRequest("/api/health"),
  bootstrap: () => jsonRequest("/api/bootstrap"),
  saveWorkingSession: (body) => jsonRequest("/api/working-session", { method: "PUT", body }),
  resetWorkingSession: (body) => jsonRequest("/api/working-session", { method: "DELETE", body }),
  saveScheduleSlot: (slot, body) => jsonRequest(`/api/schedule-slots/${slot}`, { method: "PUT", body }),
  deleteScheduleSlot: (slot, body) => jsonRequest(`/api/schedule-slots/${slot}`, { method: "DELETE", body }),
  completeSession: (body) => jsonRequest("/api/working-session/completion", { method: "POST", body }),
  inventory: () => jsonRequest("/api/inventory"),
  patchInventory: (payload) => jsonRequest("/api/inventory", { method: "PATCH", body: payload }),
  warehouseScan: async (file) => {
    const form = new FormData();
    form.append("image", file, file.name);
    const response = await fetch("/api/warehouse-scan", { method: "POST", body: form, credentials: "same-origin" });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload?.error?.message || `Request failed: ${response.status}`);
      error.status = response.status;
      error.code = payload?.error?.code;
      throw error;
    }
    return payload;
  },
  inventoryOrder: () => jsonRequest("/api/inventory/order"),
  saveInventoryOrder: (payload) => jsonRequest("/api/inventory/order", { method: "PUT", body: payload }),
  settings: () => jsonRequest("/api/settings"),
  patchSettings: (payload) => jsonRequest("/api/settings", { method: "PATCH", body: payload }),
});
