const FIELDS = Object.freeze(["island", "fromItem", "reqAmount", "toItem", "count", "yield"]);
const NUMERIC = Object.freeze(["reqAmount", "count", "yield"]);
const SESSION_FIELDS = Object.freeze(["version", "id", "scannedTrades", "schedule", "completed", "remainingParley", "config", "selection", "diagnostics"]);

function clone(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}
function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}
function same(a, b) { return stable(a) === stable(b); }
function six(row) { return Object.fromEntries(FIELDS.map((field) => [field, row?.[field]])); }
function validDto(dto) {
  return dto && typeof dto === "object" && !Array.isArray(dto)
    && Object.keys(dto).sort().join("\0") === [...FIELDS].sort().join("\0")
    && ["island", "fromItem", "toItem"].every((key) => typeof dto[key] === "string" && dto[key].trim() === dto[key] && dto[key].length > 0)
    && Number.isSafeInteger(dto.reqAmount) && dto.reqAmount > 0
    && Number.isSafeInteger(dto.count) && dto.count >= 0
    && Number.isSafeInteger(dto.yield) && dto.yield > 0;
}
function cleanRuntime(value) {
  if (Array.isArray(value)) return value.map(cleanRuntime);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (["timers", "drag", "timerActive", "timerEnd", "alarmPlayed", "__completionPending"].includes(key)) continue;
    result[key] = cleanRuntime(item);
  }
  return result;
}
function persistedSession(session) {
  if (session === null || session === undefined) return null;
  const cleaned = cleanRuntime(session);
  const result = {};
  for (const key of SESSION_FIELDS) if (Object.hasOwn(cleaned, key)) result[key] = cleaned[key];
  if (!Object.hasOwn(result, "version")) result.version = 1;
  return result;
}
function makeResult({ status, mode, hash, observationRef, precondition, stagedSession = null, request = null, duplicateRows = [], conflictGroups = [], reasons = [], summary = {} }) {
  return freeze({ schemaVersion: 1, status, mode, validatedBatchSemanticHash: hash ?? null, observationRef: observationRef ?? null,
    precondition, stagedSession, request, duplicateRows, conflictGroups, reasons,
    summary: { incomingRowCount: 0, appendedRowCount: 0, existingDuplicateSkippedCount: duplicateRows.length, ...summary } });
}
function block(context, reason, extras = {}) {
  return makeResult({ ...context, status: "BLOCKED", reasons: [reason], ...extras });
}

export function buildReviewedTradeSessionStage({ mode, validatedBatch, currentWorkingSession, localSession, settings, baseRevision, sessionRevision, mutationId, newSessionId = null } = {}) {
  const emptyContext = { mode, hash: validatedBatch?.semanticHash, observationRef: validatedBatch?.observationRef ? clone(validatedBatch.observationRef) : null,
    precondition: { baseRevision, sessionRevision, currentWorkingSession: clone(currentWorkingSession ?? null) } };
  if (!["NEW", "APPEND"].includes(mode)) return block(emptyContext, "UNSUPPORTED_MODE");
  if (!validatedBatch || validatedBatch.schemaVersion !== 1 || validatedBatch.status !== "READY" || !Array.isArray(validatedBatch.rows)
      || validatedBatch.rows.length === 0 || typeof validatedBatch.semanticHash !== "string" || !validatedBatch.semanticHash.trim()) {
    return block(emptyContext, "VALIDATED_BATCH_NOT_READY");
  }
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || !(sessionRevision === null || (Number.isSafeInteger(sessionRevision) && sessionRevision >= 0))
      || typeof mutationId !== "string" || !mutationId.trim()) return block(emptyContext, "INVALID_PRECONDITION");
  const incoming = validatedBatch.rows.map((row) => row?.dto);
  if (incoming.some((dto) => !validDto(dto))) return block(emptyContext, "INVALID_REVIEWED_DTO");
  const context = { ...emptyContext, hash: validatedBatch.semanticHash };
  let stagedSession; let duplicateRows = []; let conflictGroups = [];
  if (mode === "NEW") {
    if (typeof newSessionId !== "string" || !newSessionId.trim()) return block(context, "NEW_SESSION_ID_REQUIRED");
    const parley = settings?.parley?.defaultBudget;
    const config = { ship: settings?.ship, parley: settings?.parley, tuning: settings?.tuning };
    if (!Number.isSafeInteger(parley) || parley < 0 || [config.ship, config.parley, config.tuning].some((item) => !item || typeof item !== "object")) {
      return block(context, "DURABLE_SETTINGS_UNAVAILABLE");
    }
    stagedSession = { version: 1, id: newSessionId, scannedTrades: incoming.map(clone), schedule: null, completed: null,
      remainingParley: parley, config: clone(config), selection: { briefMode: "speed", selectedScheduleSlot: 1 },
      diagnostics: { type: "TRADE_REVIEW_SESSION_APPLY", version: 1, mode, observationId: validatedBatch.observationRef?.observationId ?? null,
        validatedBatchSemanticHash: validatedBatch.semanticHash, reviewedRowCount: validatedBatch.summary?.reviewedRowCount ?? validatedBatch.rows.length,
        outputRowCount: validatedBatch.rows.length, excludedRowCount: validatedBatch.summary?.explicitlyExcludedRowCount ?? 0, existingDuplicateSkippedCount: 0 } };
  } else {
    if (!currentWorkingSession) return block(context, "NO_DURABLE_SESSION");
    const current = persistedSession(currentWorkingSession);
    const local = persistedSession(localSession);
    if (!local || !same(local, current)) return block(context, "LOCAL_SESSION_DIVERGED");
    if (!Array.isArray(current.scannedTrades) || typeof current.id !== "string" || !current.id) return block(context, "EXISTING_SESSION_UNSAFE_ROW");
    const active = current.scannedTrades.map((row, index) => ({ row, index })).filter(({ row }) => row?.deleted !== true);
    for (let incomingIndex = 0; incomingIndex < incoming.length; incomingIndex += 1) {
      const next = incoming[incomingIndex];
      for (const { row: old, index: oldIndex } of active) {
        const sameIslandOutput = old?.island === next.island && old?.toItem === next.toItem;
        const relevant = sameIslandOutput || (old?.island === next.island && old?.fromItem === next.fromItem && old?.toItem === next.toItem);
        if (!relevant) continue;
        if (!validDto(six(old))) {
          conflictGroups.push({ type: "EXISTING_SESSION_UNSAFE_ROW", incomingRowIndex: incomingIndex, existingRowIndex: oldIndex });
          continue;
        }
        const oldDto = six(old);
        if (same(oldDto, next) && !duplicateRows.some((item) => item.incomingRowIndex === incomingIndex)) {
          duplicateRows.push({ incomingRowIndex: incomingIndex, existingRowIndex: oldIndex, code: "EXISTING_EXACT6_DUPLICATE" });
        }
        else if (oldDto.island === next.island && oldDto.fromItem === next.fromItem && oldDto.toItem === next.toItem
          && NUMERIC.some((field) => oldDto[field] !== next[field])) {
          conflictGroups.push({ type: "EXISTING_NUMERIC_CONFLICT", incomingRowIndex: incomingIndex, existingRowIndex: oldIndex,
            differingFields: NUMERIC.filter((field) => oldDto[field] !== next[field]), existing: oldDto, incoming: clone(next) });
        } else if (oldDto.island === next.island && oldDto.toItem === next.toItem && oldDto.fromItem !== next.fromItem) {
          conflictGroups.push({ type: "EXISTING_INPUT_CONFLICT", incomingRowIndex: incomingIndex, existingRowIndex: oldIndex,
            existing: oldDto, incoming: clone(next) });
        }
      }
    }
    if (conflictGroups.length) return block(context, "EXISTING_SESSION_CONFLICT", { duplicateRows, conflictGroups,
      summary: { incomingRowCount: incoming.length, appendedRowCount: 0, existingDuplicateSkippedCount: duplicateRows.length } });
    const duplicateIndexes = new Set(duplicateRows.map((row) => row.incomingRowIndex));
    const appendRows = incoming.filter((_, index) => !duplicateIndexes.has(index));
    if (!appendRows.length) return makeResult({ ...context, status: "NO_CHANGE", duplicateRows,
      reasons: ["EXISTING_EXACT6_DUPLICATE"], summary: { incomingRowCount: incoming.length, appendedRowCount: 0, existingDuplicateSkippedCount: duplicateRows.length } });
    stagedSession = { ...current, scannedTrades: [...clone(current.scannedTrades), ...appendRows.map(clone)], schedule: null, completed: null,
      diagnostics: { type: "TRADE_REVIEW_SESSION_APPLY", version: 1, mode, observationId: validatedBatch.observationRef?.observationId ?? null,
        validatedBatchSemanticHash: validatedBatch.semanticHash, reviewedRowCount: validatedBatch.summary?.reviewedRowCount ?? validatedBatch.rows.length,
        outputRowCount: validatedBatch.rows.length, excludedRowCount: validatedBatch.summary?.explicitlyExcludedRowCount ?? 0, existingDuplicateSkippedCount: duplicateRows.length } };
  }
  const request = freeze({ mutationId, baseRevision, session: freeze(clone(stagedSession)) });
  stagedSession = request.session;
  return makeResult({ ...context, status: "READY", stagedSession, request, duplicateRows,
    summary: { incomingRowCount: incoming.length, appendedRowCount: mode === "NEW" ? incoming.length : incoming.length - duplicateRows.length,
      existingDuplicateSkippedCount: duplicateRows.length, reviewedRowCount: validatedBatch.summary?.reviewedRowCount ?? validatedBatch.rows.length,
      outputRowCount: validatedBatch.rows.length, excludedRowCount: validatedBatch.summary?.explicitlyExcludedRowCount ?? 0 } });
}
