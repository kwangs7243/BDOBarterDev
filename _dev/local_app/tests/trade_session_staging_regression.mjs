import assert from "node:assert/strict";
import { buildReviewedTradeSessionStage } from "../frontend/js/domain/trade-session-staging.js";

const settings = { ship: { mode: "inner" }, parley: { defaultBudget: 1500000, normalCost: 1 }, tuning: { value: 2 } };
const row = (island, fromItem, reqAmount, toItem, count, yieldValue) => ({ island, fromItem, reqAmount, toItem, count, yield: yieldValue });
const a = row("A", "물품1", 1, "물품2", 0, 10);
const b = row("B", "물품3", 2, "물품4", 1, 20);
const batch = (rows) => ({ schemaVersion: 1, status: "READY", semanticHash: "review-hash", observationRef: { observationId: "obs-1" },
  summary: { reviewedRowCount: rows.length + 1, explicitlyExcludedRowCount: 1 }, rows: rows.map((dto, index) => ({ projectionRowId: `row-${index}`, dto })) });
const args = (overrides = {}) => ({ mode: "NEW", validatedBatch: batch([a]), currentWorkingSession: null, localSession: { scannedTrades: null }, settings,
  baseRevision: 4, sessionRevision: null, mutationId: "mutation-1", newSessionId: "new-session", ...overrides });
const session = (trades = [a], overrides = {}) => ({ version: 1, id: "session-1", scannedTrades: trades, schedule: null, completed: null,
  remainingParley: 77, config: structuredClone(settings), selection: { briefMode: "balance", selectedScheduleSlot: 3 }, diagnostics: null, ...overrides });

const before = structuredClone(args());
const created = buildReviewedTradeSessionStage(args());
assert.equal(created.status, "READY");
assert.equal(created.stagedSession.id, "new-session");
assert.deepEqual(created.stagedSession.scannedTrades, [a]);
assert.equal(created.stagedSession.schedule, null);
assert.equal(created.stagedSession.completed, null);
assert.equal(created.stagedSession.remainingParley, 1500000);
assert.deepEqual(created.stagedSession.config, settings);
assert.deepEqual(created.stagedSession.selection, { briefMode: "speed", selectedScheduleSlot: 1 });
assert.deepEqual(created.request, { mutationId: "mutation-1", baseRevision: 4, session: created.stagedSession });
assert.deepEqual(created.stagedSession.diagnostics, { type: "TRADE_REVIEW_SESSION_APPLY", version: 1, mode: "NEW", observationId: "obs-1",
  validatedBatchSemanticHash: "review-hash", reviewedRowCount: 2, outputRowCount: 1, excludedRowCount: 1, existingDuplicateSkippedCount: 0 });
assert.deepEqual(args(), before, "input mutation");
assert.deepEqual(buildReviewedTradeSessionStage(args()), created, "deterministic output semantics");
assert.ok(Object.isFrozen(created) && Object.isFrozen(created.stagedSession.scannedTrades[0]));
assert.throws(() => { created.stagedSession.id = "changed"; }, TypeError);

const old = session([a], { schedule: { speed: [{ timerActive: true, trades: [{ timerEnd: 9 }] }] }, completed: { speed: [0] } });
const local = structuredClone(old); local.timers = { x: 1 }; local.drag = { y: 1 };
const appendArgs = (rows, current = old, localCopy = local) => args({ mode: "APPEND", validatedBatch: batch(rows), currentWorkingSession: current,
  localSession: localCopy, sessionRevision: 6, mutationId: "append-1", newSessionId: null });
const appended = buildReviewedTradeSessionStage(appendArgs([b]));
assert.equal(appended.status, "READY");
assert.deepEqual(appended.stagedSession.scannedTrades, [a, b]);
assert.equal(appended.stagedSession.id, "session-1");
assert.equal(appended.stagedSession.remainingParley, 77);
assert.deepEqual(appended.stagedSession.config, old.config);
assert.deepEqual(appended.stagedSession.selection, old.selection);
assert.equal(appended.stagedSession.schedule, null);
assert.equal(appended.stagedSession.completed, null);
assert.equal(appended.summary.appendedRowCount, 1);

const duplicate = buildReviewedTradeSessionStage(appendArgs([a, b]));
assert.equal(duplicate.status, "READY");
assert.equal(duplicate.summary.appendedRowCount, 1);
assert.equal(duplicate.summary.existingDuplicateSkippedCount, 1);
assert.equal(duplicate.duplicateRows[0].code, "EXISTING_EXACT6_DUPLICATE");
const allDuplicate = buildReviewedTradeSessionStage(appendArgs([a]));
assert.equal(allDuplicate.status, "NO_CHANGE");
assert.equal(allDuplicate.request, null);
assert.equal(allDuplicate.summary.appendedRowCount, 0);

for (const [field, value] of [["reqAmount", 2], ["count", 1], ["yield", 48]]) {
  const changed = { ...a, [field]: value };
  const result = buildReviewedTradeSessionStage(appendArgs([changed, b]));
  assert.equal(result.status, "BLOCKED", `${field} conflict`);
  assert.ok(result.conflictGroups.some((group) => group.type === "EXISTING_NUMERIC_CONFLICT"));
  assert.equal(result.request, null, "no partial append after conflict");
}
const inputConflict = buildReviewedTradeSessionStage(appendArgs([{ ...a, fromItem: "다른 물품" }]));
assert.equal(inputConflict.status, "BLOCKED");
assert.ok(inputConflict.conflictGroups.some((group) => group.type === "EXISTING_INPUT_CONFLICT"));
assert.equal(buildReviewedTradeSessionStage(appendArgs([a], null, local)).reasons[0], "NO_DURABLE_SESSION");
assert.equal(buildReviewedTradeSessionStage(appendArgs([b], old, { ...local, remainingParley: 999 })).reasons[0], "LOCAL_SESSION_DIVERGED");

const deleted = session([{ ...a, deleted: true }]);
const deletedStage = buildReviewedTradeSessionStage(appendArgs([a], deleted, structuredClone(deleted)));
assert.equal(deletedStage.status, "READY", "deleted rows do not collide");
const disabled = session([{ ...a, disabled: true }]);
const disabledStage = buildReviewedTradeSessionStage(appendArgs([a], disabled, structuredClone(disabled)));
assert.equal(disabledStage.status, "NO_CHANGE", "disabled rows still collide");
const malformed = session([{ island: "A", toItem: "물품2" }]);
const malformedStage = buildReviewedTradeSessionStage(appendArgs([a], malformed, structuredClone(malformed)));
assert.equal(malformedStage.status, "BLOCKED");
assert.ok(malformedStage.conflictGroups.some((group) => group.type === "EXISTING_SESSION_UNSAFE_ROW"));
const notReady = buildReviewedTradeSessionStage(args({ validatedBatch: { ...batch([a]), status: "NOT_READY" } }));
assert.equal(notReady.status, "BLOCKED");
assert.equal(notReady.request, null);

console.log(JSON.stringify({ ok: true, new: true, append: true, exact6Duplicates: true, allDuplicateNoChange: true,
  numericAndInputConflictsBlocked: true, deletedAndDisabledSemantics: true, localDivergenceBlocked: true, immutableDeterministic: true }));
