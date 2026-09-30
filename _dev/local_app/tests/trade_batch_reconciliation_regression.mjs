import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { adaptLegacyCatalog } from "../frontend/js/domain/trade-master-registry.js";
import { buildTradeBatchReconciliation, reconcileTradeProjectionRows } from "../frontend/js/domain/trade-batch-reconciliation.js";
import { buildTradeReviewProjection } from "../frontend/js/domain/trade-review-projection.js";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const catalog = { masterData: Object.fromEntries(["1", "2", "3", "4", "5", "6", "7"].map((tier) => [tier, []])), specialItems: [], islands: ["A", "B", "C", "D"], t6Islands: [], t7Islands: [] };
catalog.masterData["1"] = ["feed"];
catalog.masterData["2"] = ["output"];
const registrySnapshot = adaptLegacyCatalog(catalog, { sourceRevision: "r007-test", sourceSha256: hash(JSON.stringify(catalog)), curatedMappings: null });
const fields = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
  value: null, rawText: value === null ? null : String(value), normalizedText: value === null ? null : String(value),
  rawNumericCandidate: null, status: value === null ? "EMPTY_OCR" : "RAW_OCR_CANDIDATE", reasonCodes: [],
  readerEvidence: { readerId: "r007-test", geometry: { box: { x: 1, y: 1, width: 5, height: 5 } } },
}]));
const makeRow = (captureId, ordinal, letter, yieldValue = 48, crop = null) => ({
  captureId, ordinal, status: "DRAFT_UNVERIFIED", automationDecision: "REVIEW", rowId: `${captureId}:${ordinal}`,
  rowBox: { x: 0, y: ordinal * 10, width: 30, height: 9 },
  rowCropHash: crop,
  sourceRefs: [{ captureId, ordinal }, { diagnostic: `ref-${ordinal}` }],
  fields: fields({ island: letter, fromItem: "feed", reqAmount: "1", toItem: "output", count: "0", yield: String(yieldValue) }),
});
const captures = [
  { captureId: "A", captureOrdinal: 1, imageHash: hash("image-A") },
  { captureId: "B", captureOrdinal: 2, imageHash: hash("image-B") },
];
const draftRows = [makeRow("A", 1, "A"), makeRow("A", 2, "B"), makeRow("A", 3, "C"),
  makeRow("B", 1, "B"), makeRow("B", 2, "C", 148), makeRow("B", 3, "D")];
const before = structuredClone({ captures, draftRows });
const preliminary = buildTradeBatchReconciliation({ captures, draftRows, policyVersion: "trade-batch-reconciliation-v1" });
assert.equal(preliminary.phase, "PRELIMINARY");
assert.equal(preliminary.sourceRows.length, 6);
assert.deepEqual({ captures, draftRows }, before, "topology construction does not mutate inputs");
assert.deepEqual(buildTradeBatchReconciliation({ captures, draftRows, policyVersion: "trade-batch-reconciliation-v1" }), preliminary);

const projection = buildTradeReviewProjection({ draftRows, reconciliation: preliminary, registrySnapshot, correctionPolicyVersion: "r007-correction-v1" });
assert.equal(projection.schemaVersion, 2);
assert.equal(projection.reconciliation.phase, "FINAL");
assert.equal(projection.reconciliation.sourceRows.length, 6);
assert.equal(projection.rows.length, 4);
assert.equal(projection.reconciliation.groups.filter((group) => group.status === "EXACT_OVERLAP").length, 1);
assert.equal(projection.reconciliation.groups.filter((group) => group.status === "CONFLICT").length, 1);
assert.equal(projection.reconciliation.sourceToLogical.length, 6);
assert.equal(new Set(projection.reconciliation.sourceToLogical.map((entry) => entry.sourceRowId)).size, 6);
assert.equal(projection.reconciliation.sourceProjectionEvidence.length, 4);
const exact = projection.rows.find((row) => row.reconciliationStatus === "EXACT_OVERLAP");
assert.equal(exact.reconciliationMembers.length, 2);
assert.equal(exact.sourceRefs.length, 4, "lineage references are unioned; they are not used as source-row count");
const conflict = projection.rows.find((row) => row.reconciliationStatus === "CONFLICT");
assert.equal(conflict.fields.yield.status, "AMBIGUOUS");
assert.equal(conflict.fields.yield.shownValue, null);
assert.equal(conflict.fields.yield.candidate, null);
assert.deepEqual(conflict.fields.yield.alternatives.map((item) => item.value), [48, 148]);
assert.equal(conflict.fields.yield.riskReasons.some((item) => item.code === "RECONCILIATION_CONFLICT"), true);
assert.equal(Object.isFrozen(projection) && Object.isFrozen(projection.reconciliation.sourceRows[0]), true);
assert.equal(projection.projectionHash.length, 64);
const remappedRows = structuredClone(draftRows);
remappedRows.slice(3).forEach((row, index) => { row.rowId = `alternate:${index}`; });
const remappedProjection = buildTradeReviewProjection({ draftRows: remappedRows,
  reconciliation: buildTradeBatchReconciliation({ captures, draftRows: remappedRows, policyVersion: "trade-batch-reconciliation-v1" }),
  registrySnapshot, correctionPolicyVersion: "r007-correction-v1" });
assert.deepEqual(remappedProjection.rows.map((row) => Object.fromEntries(Object.entries(row.fields).map(([key, field]) => [key, field.shownValue]))),
  projection.rows.map((row) => Object.fromEntries(Object.entries(row.fields).map(([key, field]) => [key, field.shownValue]))), "mapping-only change leaves logical shown values unchanged");
assert.notEqual(remappedProjection.projectionHash, projection.projectionHash, "different source mapping changes semantic projection hash");
assert.throws(() => reconcileTradeProjectionRows({ projectionRows: projection.rows, reconciliation: projection.reconciliation }), /PRELIMINARY/);
assert.throws(() => buildTradeBatchReconciliation({ captures: [captures[1]], draftRows, policyVersion: "trade-batch-reconciliation-v1" }), /captureOrdinal|invalid source position/);

const weakCaptures = captures;
const weakRows = [makeRow("A", 1, "A"), makeRow("B", 1, "A")];
const weak = buildTradeReviewProjection({ draftRows: weakRows, reconciliation: buildTradeBatchReconciliation({ captures: weakCaptures, draftRows: weakRows, policyVersion: "trade-batch-reconciliation-v1" }), registrySnapshot, correctionPolicyVersion: "r007-correction-v1" });
assert.equal(weak.rows.length, 2, "weak one-row overlap is not merged");
assert.equal(weak.reconciliation.findings.some((item) => item.code === "POSSIBLE_SINGLE_ROW_OVERLAP"), true);

const cropHash = hash("same-row-bitmap");
const cropRows = [makeRow("A", 1, "A", 48, cropHash), makeRow("B", 1, "A", 48, cropHash)];
const crop = buildTradeReviewProjection({ draftRows: cropRows, reconciliation: buildTradeBatchReconciliation({ captures: weakCaptures, draftRows: cropRows, policyVersion: "trade-batch-reconciliation-v1" }), registrySnapshot, correctionPolicyVersion: "r007-correction-v1" });
assert.equal(crop.rows.length, 1, "matching resolved identity plus boundary crop hash supports one-row merge");
assert.equal(crop.reconciliation.overlaps[0].basis, "ADJACENT_ROW_CROP_HASH");

const duplicateCaptures = [{ ...captures[0], imageHash: hash("same") }, { ...captures[1], imageHash: hash("same") }];
const duplicateRows = [makeRow("A", 1, "x"), makeRow("B", 1, "y")];
const duplicate = buildTradeReviewProjection({ draftRows: duplicateRows, reconciliation: buildTradeBatchReconciliation({ captures: duplicateCaptures, draftRows: duplicateRows, policyVersion: "trade-batch-reconciliation-v1" }), registrySnapshot, correctionPolicyVersion: "r007-correction-v1" });
assert.equal(duplicate.rows.length, 1, "same bitmap allows safe ordinal grouping");
assert.equal(duplicate.reconciliation.overlaps[0].basis, "DUPLICATE_IMAGE");

const malformedDuplicateRows = [makeRow("A", 1, "A"), makeRow("A", 2, "B"), makeRow("B", 1, "A")];
const malformedDuplicate = buildTradeReviewProjection({ draftRows: malformedDuplicateRows,
  reconciliation: buildTradeBatchReconciliation({ captures: duplicateCaptures, draftRows: malformedDuplicateRows, policyVersion: "trade-batch-reconciliation-v1" }),
  registrySnapshot, correctionPolicyVersion: "r007-correction-v1" });
assert.equal(malformedDuplicate.rows.length, 3, "same bitmap with incompatible row counts is never ordinal-merged");
assert.equal(malformedDuplicate.reconciliation.findings.some((item) => item.code === "DUPLICATE_IMAGE_ROW_MAPPING_CONFLICT"), true);

const cloneForConflict = (row, key, value) => {
  const copy = structuredClone(row);
  copy.fields[key].rawText = value === null ? null : String(value);
  copy.fields[key].normalizedText = value === null ? null : String(value);
  copy.fields[key].rawNumericCandidate = value === null ? null : Number(value);
  copy.fields[key].status = value === null ? "EMPTY_OCR" : "RAW_OCR_CANDIDATE";
  return copy;
};
for (const [key, values] of [["reqAmount", [1, 2]], ["count", [0, 1]], ["reqAmount", [null, 1]]]) {
  const pairRows = [cloneForConflict(makeRow("A", 1, "A"), key, values[0]), cloneForConflict(makeRow("B", 1, "A"), key, values[1])];
  const pair = buildTradeReviewProjection({ draftRows: pairRows,
    reconciliation: buildTradeBatchReconciliation({ captures: duplicateCaptures, draftRows: pairRows, policyVersion: "trade-batch-reconciliation-v1" }),
    registrySnapshot, correctionPolicyVersion: "r007-correction-v1" });
  const conflictField = pair.rows[0].fields[key];
  assert.equal(conflictField.shownValue, null, `${key} ${values.join("/")} is not silently selected`);
  assert.deepEqual(conflictField.alternatives.map((item) => item.value), values);
}

const unknownRows = [makeRow("A", 1, "not-in-master"), makeRow("B", 1, "not-in-master")];
const unknown = buildTradeReviewProjection({ draftRows: unknownRows,
  reconciliation: buildTradeBatchReconciliation({ captures, draftRows: unknownRows, policyVersion: "trade-batch-reconciliation-v1" }),
  registrySnapshot, correctionPolicyVersion: "r007-correction-v1" });
assert.equal(unknown.rows.length, 2, "unresolved ordinary identity is not merged");

const threeCaptures = ["A", "B", "C"].map((captureId, index) => ({ captureId, captureOrdinal: index + 1, imageHash: hash(`three-${captureId}`) }));
const threeRows = [makeRow("A", 1, "A"), makeRow("B", 1, "B"), makeRow("C", 1, "A")];
const nonAdjacent = buildTradeReviewProjection({ draftRows: threeRows,
  reconciliation: buildTradeBatchReconciliation({ captures: threeCaptures, draftRows: threeRows, policyVersion: "trade-batch-reconciliation-v1" }),
  registrySnapshot, correctionPolicyVersion: "r007-correction-v1" });
assert.equal(nonAdjacent.rows.length, 3, "matching non-adjacent text is never searched or merged");

console.log("trade_batch_reconciliation_regression: PASS · 6 source / 4 logical / exact + conflict + weak + crop + duplicate bitmap");
