export const state = {
  revision: null,
  inventory: [],
  order: {},
  settings: {},
  sessionRevision: null,
  workingSession: null,
  scheduleSlots: { 1: null, 2: null, 3: null, 4: null, 5: null },
  persistencePending: 0,
  // Ordinary durable refreshes must not replace the current working copy.
  session: { scannedTrades: null, schedule: null, completed: null, remainingParley: null, timers: null, selection: null, drag: null, diagnostics: null },
  mapRouteDraft: []
};

export function applyBootstrap(snapshot) {
  state.revision = snapshot.revision;
  state.inventory = snapshot.inventory;
  state.order = snapshot.order;
  state.settings = snapshot.settings;
  state.sessionRevision = snapshot.sessionRevision ?? null;
  state.workingSession = snapshot.workingSession ?? null;
  state.scheduleSlots = snapshot.scheduleSlots ?? state.scheduleSlots;
  return snapshot;
}
