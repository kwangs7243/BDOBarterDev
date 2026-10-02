import assert from "node:assert/strict";
import { createMasterBundleV2 } from "../frontend/js/domain/trade-master-bundle.js";
import { buildFinalTradeProjection } from "../frontend/js/domain/trade-final-correction.js";
import { buildFinalProjection3, buildFinalReviewCompletion } from "../frontend/js/domain/trade-final-evidence.js";
import { buildTradeBatchReconciliation } from "../frontend/js/domain/trade-batch-reconciliation.js";
import { buildClassifiedFinalProjection3, classifyTradeFinalRow } from "../frontend/js/domain/trade-final-classification.js";

const masterNames = [
  { stableId: "10000000-0000-4000-8000-000000000001", kind: "ISLAND", legacyKind: "ISLAND", rawName: "아지르 섬", legacyNameKey: "c3-island", tier: null, scope: "GENERAL_ISLANDS" },
  { stableId: "10000000-0000-4000-8000-000000000002", kind: "ITEM", legacyKind: "MASTER_ITEM", rawName: "고대 잎", legacyNameKey: "c3-input", tier: 1, scope: "MASTER_TIER_1" },
  ...["산호 상자", "푸른 상자", "은빛 상자", "금빛 상자"].map((rawName, index) => ({ stableId: `10000000-0000-4000-8000-${String(index + 3).padStart(12, "0")}`, kind: "ITEM", legacyKind: "MASTER_ITEM", rawName, legacyNameKey: `c3-output-${index}`, tier: 2, scope: "MASTER_TIER_2" })),
];
const entities = masterNames.map((name) => ({ stableId: name.stableId, kind: name.kind, canonicalName: name.rawName, displayNames: [], aliases: [],
  legacyNames: [{ legacyNameKey: name.legacyNameKey, legacyKind: name.legacyKind, rawName: name.rawName, tier: name.tier, authorityStatus: "VERIFIED_CURATED",
    occurrences: [{ locator: `/c3/${name.legacyNameKey}`, scope: name.scope, tier: name.tier }] }], tier: name.tier,
  category: null, status: "VERIFIED_CURATED", provenance: { ownerNote: "synthetic C3 regression" }, replacedBy: null }));
const masterBundle = createMasterBundleV2({ createdAt: "2026-10-02T00:00:00Z", entities,
  compatibilityMappings: entities.map((entity) => ({ stableId: entity.stableId, legacyNameKeys: entity.legacyNames.map((name) => name.legacyNameKey), sourceLocators: entity.legacyNames.flatMap((name) => name.occurrences.map((occurrence) => occurrence.locator)) })),
  unresolvedLegacyNames: [], sourceRevisions: [{ sourceType: "TEST", revision: "c3-v1", sha256: "d".repeat(64) }], provenance: { purpose: "synthetic C3 classification regression" } });
const FIELD_NAMES = ["island", "fromItem", "reqAmount", "toItem", "count", "yield"];
const hash = (text) => createHash("sha256").update(text).digest("hex");
function cropRef(sourceRowId, captureId, field) {
  const cropRefId = `c3-crop-${sourceRowId}-${field}`;
  return { cropRefId, sourceRowId, captureId, field, bitmapSha256: "a".repeat(64), frame: { width: 100, height: 100 }, coordinateSpace: "CAPTURE_BITMAP_PIXELS",
    box: { x: 1, y: 1, width: 10, height: 10 }, pixelHashBasis: "RGB8_ROW_MAJOR_V1", pixelSha256: "b".repeat(64), pngArtifactSha256: null };
}
function draftRow(captureId, ordinal, values, { sourceCropRefs = true, overrides = {} } = {}) {
  const rowId = `${captureId}-row-${ordinal}`;
  const fields = Object.fromEntries(FIELD_NAMES.map((field) => {
    const rawText = values[field] === null ? null : String(values[field]);
    return [field, { rawText, normalizedText: rawText, rawNumericCandidate: Number.isSafeInteger(values[field]) ? values[field] : null, value: null,
      status: rawText === null ? "EMPTY_OCR" : "RAW_OCR_CANDIDATE", reasonCodes: [], ...(sourceCropRefs ? { cropRefs: [cropRef(rowId, captureId, field)] } : {}), ...(overrides[field] ?? {}) }];
  }));
  return { captureId, ordinal, rowId, status: "DRAFT_UNVERIFIED", automationDecision: "REVIEW", rowBox: { x: 0, y: ordinal * 12, width: 100, height: 10 }, fields };
}
function baseRows(captureId = "cap-one") {
  return [draftRow(captureId, 1, { island: "아지르 섬", fromItem: "고대 잎", reqAmount: 1, toItem: "산호 상자", count: 0, yield: 2 })];
}
function correction(rows = baseRows(), extras = {}) {
  return buildFinalTradeProjection({ rawObservation: { recognitionBatchId: "c3-batch", draftRows: rows, edgeSegments: [], ...extras }, masterBundle,
    correctionPolicy: { policyVersion: "c3-correction-test-v1" }, reconciliationPolicyVersion: extras.reconciliation?.policyVersion });
}
function readyCorrection() {
  const captureId = "cap-ready"; const ordinal = 1; const sourceRowId = `${captureId}-row-${ordinal}`;
  const values = { island: "아지르 섬", fromItem: "고대 잎", reqAmount: 1, toItem: "산호 상자", count: 0, yield: 2 };
  const rawFields = {};
  const correctedFields = {};
  for (const field of FIELD_NAMES) {
    const value = values[field]; const isText = typeof value === "string";
    const term = isText ? masterNames.find((entry) => entry.rawName === value) : null;
    const candidate = term ? { value, stableId: term.stableId, legacyNameKey: term.legacyNameKey, kind: term.legacyKind, legacyKind: term.legacyKind, tier: term.tier,
      authorityStatus: "VERIFIED_CURATED", nameStatus: "VERIFIED_CURATED", matchKind: "EXACT", sourceScopes: [term.scope] } : null;
    const cropRefs = [cropRef(sourceRowId, captureId, field)];
    rawFields[field] = { rawText: String(value), normalizedText: String(value), rawNumericCandidate: isText ? null : value, value: null,
      status: "RAW_OCR_CANDIDATE", reasonCodes: [], cropRefs };
    correctedFields[field] = { field, raw: { text: String(value), normalizedText: String(value), numericCandidate: isText ? null : value,
      status: "RAW_OCR_CANDIDATE", reasonCodes: [], sourceRefs: [{ captureId, ordinal, draftRowId: sourceRowId }], cropRefs, geometry: null, otherEvidence: {} },
      normalized: { value: isText ? value : String(value) }, masterMatches: candidate ? [candidate] : [], correctionCandidates: [],
      selectedCandidate: candidate ?? { value, source: "RAW_NUMERIC_CANDIDATE" }, correctionReasons: [{ code: isText ? "EXACT_MATCH" : "RAW_NUMERIC_CANDIDATE" }], riskReasons: [],
      finalValue: value, finalStatus: "MATCHED", ...(isText ? {} : { parse: { candidate: value, readerCandidate: value, disagreement: false } }),
      stageTrace: isText ? [0, 1, 2, 3, 4].map((stage) => ({ stage, name: `S${stage}`, ruleVersion: `synthetic-${stage}-v1`, reason: null }))
        : [{ stage: 0, name: "RAW_OBSERVATION", ruleVersion: "synthetic-0-v1", reason: null }, { stage: 5, name: "NUMERIC_RESOLUTION", ruleVersion: "synthetic-5-v1", reason: null }] };
  }
  const source = { sourceRowId, sourceIndex: 0, captureId, ordinal, rowBox: { x: 0, y: 0, width: 100, height: 10 },
    sourceRefs: [{ captureId, ordinal, draftRowId: sourceRowId }], originalRawRow: { captureId, ordinal, rowId: sourceRowId, status: "DRAFT_UNVERIFIED", automationDecision: "REVIEW", fields: rawFields }, fields: correctedFields };
  const logical = { sourceRowId, sourceRowIds: [sourceRowId], captureId, ordinal, sourceRefs: source.sourceRefs, representativeSource: { captureId, ordinal, rowBox: source.rowBox }, fields: structuredClone(correctedFields) };
  return { schemaVersion: 1, pipelineKind: "TRADE_FINAL_CORRECTION_SHADOW", pipelineVersion: "trade-final-correction-v1", activation: "SHADOW_ONLY",
    isFinalProjection3: false, sessionCompatible: false, recognitionBatchId: "c3-batch", correctionPolicy: { policyVersion: "c3-correction-test-v1", definition: {} },
    masterBinding: { masterSchemaVersion: 2, registryVersion: masterBundle.registryVersion, contentHash: masterBundle.contentHash, hashBasis: masterBundle.hashBasis },
    pixelAvailability: null, sourceRows: [source], logicalRows: [logical], captures: null, edgeSegments: [], reconciliation: null, provisionalFindings: [],
    stageBoundaries: { stage7: "DEFERRED_TO_C3", stage8: "DEFERRED_TO_C3" }, truthGenerated: false, sessionWrites: false };
}
function build(result, states = null) {
  const crops = [...new Set(result.sourceRows.flatMap((source) => FIELD_NAMES.flatMap((field) => source.originalRawRow.fields[field].cropRefs?.map((ref) => ref.cropRefId) ?? [])))];
  return buildClassifiedFinalProjection3({ correctionResult: result, rawEvidenceHash: "c".repeat(64),
    pixelAvailability: states ?? crops.map((cropRefId) => ({ cropRefId, state: "IN_MEMORY" })) });
}

// A contract-only synthetic fixture is allowed to model approved numeric quality.
const ready = build(readyCorrection());
assert.equal(ready.schemaVersion, 3);
assert.equal(ready.reviewMode, "FINAL_CORRECTED_RESULT");
assert.equal(ready.hashBasis, "TRADE_FINAL_PROJECTION_JSON_V3");
assert.equal(ready.rows[0].classification, "FINAL_READY");
assert.deepEqual(ready.rows[0].fields.map((field) => field.field), FIELD_NAMES);
assert.ok(ready.rows[0].fields.every((field) => field.stageTrace.some((entry) => entry.stage === 7) && field.stageTrace.some((entry) => entry.stage === 8)));
assert.ok(ready.rows[0].fields.every((field) => field.stageTrace.every((entry) => Object.keys(entry).sort().join("|") === "inputValue|outputValue|reason|ruleVersion|stage")));
assert.equal(ready.rows[0].fields.some((field) => field.truthEvidence || field.operationalDecision), false);
assert.equal(build(readyCorrection()).projectionHash, ready.projectionHash, "projection hash is deterministic");

const retainedRows = ready.rows.map((row) => ({ projectionRowId: row.projectionRowId, sourceRefs: row.sourceRefs, disposition: "INCLUDE", dispositionReason: null,
  fields: row.fields.map((field) => ({ field: field.field, finalValue: field.finalValue, unknown: false })) }));
const completion = buildFinalReviewCompletion({ projection: ready, reviewRevision: 0, rows: retainedRows, workItems: [], confirmedAt: "2026-10-02T00:00:00Z" });
assert.equal(completion.batchConfirmation.method, "USER_FINAL_LIST_CONFIRMED");
assert.ok(completion.rows[0].fields.every((field) => field.operationalDecision === "CANDIDATE_RETAINED" && !Object.hasOwn(field, "truthEvidence")));

const testRisk = (risk, expected, mutate = (field) => { field.riskReasons.push({ code: risk }); }) => {
  const result = structuredClone(readyCorrection()); mutate(result.sourceRows[0].fields.toItem); mutate(result.logicalRows[0].fields.toItem);
  const projected = build(result);
  assert.equal(projected.rows[0].classification, expected, risk);
  assert.ok(projected.rows[0].classificationReasons.some((reason) => reason.includes(risk)) || expected === "NEEDS_REVIEW", `${risk} reason retained`);
  assert.ok(projected.rows[0].fields[3].finalValue !== null, `${risk} keeps the candidate visible`);
};
for (const risk of ["MASTER_UNRESOLVED", "SOURCE_CONFLICT", "AMBIGUOUS_MATCH", "NO_MATCH", "MASTER_DISPUTED", "MASTER_DEPRECATED", "BOUNDED_UNIQUE_MATCH", "NUMERIC_COMPLETENESS_UNVERIFIED", "NUMERIC_MISSING_OR_INVALID", "OPEN_WORLD_FROM_ITEM", "OCR_ERROR"]) {
  testRisk(risk, "NEEDS_REVIEW");
}
const reviewCases = [
  ["LEGACY_UNVERIFIED", (field) => { field.selectedCandidate.authorityStatus = "LEGACY_UNVERIFIED"; field.selectedCandidate.nameStatus = "LEGACY_UNVERIFIED"; field.riskReasons.push({ code: "MASTER_UNRESOLVED" }); }],
  ["MASTER_DISPUTED", (field) => { field.selectedCandidate.authorityStatus = "DISPUTED"; field.selectedCandidate.nameStatus = "DISPUTED"; field.finalStatus = "MASTER_DISAGREEMENT"; field.riskReasons.push({ code: "MASTER_DISPUTED" }); }],
  ["MASTER_DEPRECATED", (field) => { field.selectedCandidate.authorityStatus = "DEPRECATED"; field.selectedCandidate.nameStatus = "DEPRECATED"; field.finalStatus = "MASTER_DEPRECATED"; field.riskReasons.push({ code: "MASTER_DEPRECATED" }); }],
  ["BOUNDED_UNIQUE_MATCH", (field) => { field.selectedCandidate.matchKind = "BOUNDED_UNIQUE_MATCH"; field.riskReasons.push({ code: "BOUNDED_UNIQUE_MATCH" }); }],
  ["AMBIGUOUS_MATCH", (field) => { field.selectedCandidate = null; field.finalStatus = "AMBIGUOUS"; field.riskReasons.push({ code: "AMBIGUOUS_MATCH" }); }],
  ["UNMATCHED", (field) => { field.selectedCandidate = null; field.finalStatus = "UNMATCHED"; field.riskReasons.push({ code: "NO_MATCH" }); }],
];
for (const [name, mutate] of reviewCases) {
  const result = readyCorrection();
  mutate(result.sourceRows[0].fields.toItem); mutate(result.logicalRows[0].fields.toItem);
  const projection = build(result);
  assert.equal(projection.rows[0].classification, "NEEDS_REVIEW", name);
  assert.ok(projection.rows[0].fields[3].finalValue !== null, `${name} candidate remains reviewable`);
}
const missingNumber = readyCorrection();
for (const field of [missingNumber.sourceRows[0].fields.reqAmount, missingNumber.logicalRows[0].fields.reqAmount]) {
  field.finalValue = null; field.normalized.value = null; field.selectedCandidate = null; field.parse.candidate = null; field.riskReasons.push({ code: "NUMERIC_MISSING_OR_INVALID" });
}
assert.equal(build(missingNumber).rows[0].classification, "NEEDS_REVIEW", "missing numeric value is retained as a review row");
for (const risk of ["FIELD_CLIPPED", "GEOMETRY_ABSTAIN"]) testRisk(risk, "NEEDS_RECAPTURE");

for (const state of ["MISSING", "EXPIRED", "INVALID"]) {
  const result = readyCorrection();
  const oneCrop = result.sourceRows[0].originalRawRow.fields.island.cropRefs[0].cropRefId;
  const baseline = build(result);
  const changed = build(result, baseline.pixelAvailability.map((item) => item.cropRefId === oneCrop ? { ...item, state } : item));
  assert.equal(changed.rows[0].classification, "NEEDS_RECAPTURE", `${state} crop state requires recapture`);
  assert.notEqual(changed.projectionHash, baseline.projectionHash);
}

const clippedAndReview = structuredClone(readyCorrection());
for (const target of [clippedAndReview.sourceRows[0].fields.toItem, clippedAndReview.logicalRows[0].fields.toItem]) target.riskReasons.push({ code: "MASTER_UNRESOLVED" });
const clippedProjection = build(clippedAndReview, build(clippedAndReview).pixelAvailability.map((entry) => entry.cropRefId === clippedAndReview.sourceRows[0].originalRawRow.fields.island.cropRefs[0].cropRefId ? { ...entry, state: "MISSING" } : entry));
assert.equal(clippedProjection.rows[0].classification, "NEEDS_RECAPTURE");
assert.ok(clippedProjection.rows[0].classificationReasons.some((reason) => reason.includes("MASTER_UNRESOLVED")));

const conflict = structuredClone(readyCorrection());
for (const target of [conflict.sourceRows[0].fields.yield, conflict.logicalRows[0].fields.yield]) {
  target.finalStatus = "CONFLICT"; target.riskReasons.push({ code: "NUMERIC_READER_TEXT_DISAGREEMENT" });
  target.parse = { disagreement: true, readerCandidate: 3, textParsedCandidate: 2 };
}
const conflictProjection = build(conflict);
assert.equal(conflictProjection.rows[0].classification, "CONFLICT");
assert.equal(conflictProjection.rows[0].fields[5].valueState, "CONFLICT");
assert.equal(conflictProjection.rows[0].fields[5].finalValue, null);
assert.equal(conflictProjection.rows[0].fields[5].selectedCandidateIndex, null);
assert.deepEqual(conflictProjection.rows[0].fields[5].alternatives.map((entry) => entry.value), [3, 2]);

const clippedConflict = structuredClone(conflict);
clippedConflict.sourceRows[0].fields.island.riskReasons.push({ code: "FIELD_CLIPPED" });
clippedConflict.logicalRows[0].fields.island.riskReasons.push({ code: "FIELD_CLIPPED" });
const priorityProjection = build(clippedConflict, conflictProjection.pixelAvailability.map((entry) => entry.cropRefId === clippedConflict.sourceRows[0].originalRawRow.fields.island.cropRefs[0].cropRefId ? { ...entry, state: "MISSING" } : entry));
assert.equal(priorityProjection.rows[0].classification, "CONFLICT", "conflict outranks recapture and review");
assert.ok(priorityProjection.rows[0].classificationReasons.some((reason) => reason.includes("NUMERIC_READER_TEXT_DISAGREEMENT")));
assert.ok(priorityProjection.rows[0].classificationReasons.some((reason) => reason.includes("FIELD_CLIPPED")));
assert.ok(priorityProjection.rows[0].classificationReasons.some((reason) => reason.includes("CRITICAL_CROP_UNAVAILABLE")));

const noCropRows = baseRows("cap-no-crop").map((row) => ({ ...row, fields: Object.fromEntries(Object.entries(row.fields).map(([field, value]) => {
  const { cropRefs: _cropRefs, ...withoutCrop } = value; return [field, withoutCrop];
})) }));
const noCrop = correction(noCropRows);
const noCropProjection = build(noCrop, []);
assert.equal(noCropProjection.rows[0].classification, "NEEDS_RECAPTURE");
assert.ok(noCropProjection.rows[0].fields.every((field) => field.cropRefs.length === 0));

const values = (toItem, yieldValue = 2) => ({ island: "아지르 섬", fromItem: "고대 잎", reqAmount: 1, toItem, count: 0, yield: yieldValue });
const scrollRows = [draftRow("scroll-a", 1, values("산호 상자")), draftRow("scroll-a", 2, values("푸른 상자")), draftRow("scroll-a", 3, values("은빛 상자")),
  draftRow("scroll-b", 1, values("푸른 상자")), draftRow("scroll-b", 2, values("은빛 상자", 3)), draftRow("scroll-b", 3, values("금빛 상자"))];
const topology = buildTradeBatchReconciliation({ captures: [{ captureId: "scroll-a", imageHash: "image-a" }, { captureId: "scroll-b", imageHash: "image-b" }], draftRows: scrollRows, policyVersion: "trade-batch-reconciliation-v1" });
const reconciled = correction(scrollRows, { reconciliation: topology });
const reconciledProjection = build(reconciled);
assert.equal(reconciledProjection.reconciliation.sourceRows.length, 6);
assert.equal(reconciledProjection.reconciliation.groups.length, 4);
assert.equal(reconciledProjection.rows.length, 4);
assert.equal(reconciledProjection.reconciliation.sourceToLogical.length, 6);
assert.equal(new Set(reconciledProjection.reconciliation.sourceToLogical.map((entry) => entry.sourceRowId)).size, 6);
assert.ok(reconciledProjection.reconciliation.groups.filter((group) => group.memberSourceRowIds.length > 1).every((group) => group.memberEvidence.length === group.memberSourceRowIds.length && group.memberEvidence.every((member) => member.fields.length === 6)));
assert.equal(reconciledProjection.rows.find((row) => row.classification === "CONFLICT")?.fields[5].finalValue, null);

const hiddenConflict = structuredClone(reconciled);
const conflictGroup = hiddenConflict.reconciliation.finalized.reconciliation.groups.find((group) => group.status === "CONFLICT");
assert.ok(conflictGroup);
conflictGroup.status = "EXACT_OVERLAP";
const hiddenLogical = hiddenConflict.logicalRows.find((row) => row.sourceRowId === conflictGroup.logicalProjectionRowId);
const hiddenField = hiddenLogical.fields.yield;
hiddenField.finalStatus = "MATCHED";
hiddenField.selectedCandidate = hiddenConflict.sourceRows.find((source) => source.sourceRowId === conflictGroup.representativeSourceRowId).fields.yield.selectedCandidate;
hiddenField.finalValue = hiddenField.selectedCandidate.value;
hiddenField.riskReasons = hiddenField.riskReasons.filter((risk) => risk.code !== "RECONCILIATION_CONFLICT");
delete hiddenField.conflictAlternatives;
const hiddenConflictProjection = build(hiddenConflict);
assert.equal(hiddenConflictProjection.rows.find((row) => row.projectionRowId === conflictGroup.logicalProjectionRowId).classification, "CONFLICT",
  "source-level disagreement remains a conflict even if finalized group status was tampered");
assert.equal(hiddenConflictProjection.rows.find((row) => row.projectionRowId === conflictGroup.logicalProjectionRowId).fields[5].finalValue, null);

const domainConflict = structuredClone(readyCorrection());
for (const row of [domainConflict.sourceRows[0], domainConflict.logicalRows[0]]) row.fields.fromItem.selectedCandidate.tier = 2;
assert.equal(build(domainConflict).rows[0].classification, "CONFLICT", "verified but incompatible item tiers are a domain conflict");

const edge = structuredClone(readyCorrection());
edge.edgeSegments = [{ edgeId: "edge-stable-1", captureId: "cap-one", ordinal: 1, reason: "EDGE_SEGMENT_UNCERTAIN", rowBox: null, sourceRefs: [] }];
const edgeProjection = build(edge);
assert.equal(edgeProjection.rows.length, 1);
assert.deepEqual(edgeProjection.edgeWorkItems, [{ workItemId: "recapture:edge-stable-1", edgeId: "edge-stable-1", classification: "NEEDS_RECAPTURE", reason: "EDGE_SEGMENT_UNCERTAIN", sourceRefs: [] }]);
assert.throws(() => build({ ...edge, edgeSegments: [{ captureId: "cap-one", ordinal: 1, reason: "EDGE_SEGMENT_UNCERTAIN" }] }), /edgeId/);

const sourceBefore = structuredClone(readyCorrection());
const sourceBytes = JSON.stringify(sourceBefore);
const finalResult = build(sourceBefore);
assert.equal(JSON.stringify(sourceBefore), sourceBytes, "correction result is not mutated");
assert.equal(Object.isFrozen(finalResult), true);
assert.equal(Object.isFrozen(finalResult.rows[0].fields[0].stageTrace[0]), true);
assert.throws(() => build({ ...sourceBefore, masterBinding: { ...sourceBefore.masterBinding, contentHash: "0".repeat(64) } }), TypeError);
assert.throws(() => build({ ...sourceBefore, correctionPolicy: { policyVersion: "" } }), TypeError);
assert.throws(() => build(sourceBefore, [{ cropRefId: "unknown-crop", state: "IN_MEMORY" }]), /unknown crop/);

const directClassified = classifyTradeFinalRow({ row: { ...readyCorrection().logicalRows[0], sourceRefs: [{ sourceRowId: "c3-batch-row-1", captureId: "cap-one", ordinal: 0 }] },
  group: { status: "UNMERGED", memberSourceRowIds: ["c3-batch-row-1"] }, pixelAvailability: [] });
assert.equal(directClassified.classification, "NEEDS_RECAPTURE");

const seven = { ...ready.rows[0], fields: [...ready.rows[0].fields, { ...ready.rows[0].fields[0], field: "extra" }] };
assert.throws(() => buildFinalProjection3({ recognitionBatchId: "x", rawEvidenceHash: "c".repeat(64), masterBinding: ready.masterBinding, correctionVersion: "x",
  reconciliation: ready.reconciliation, pixelAvailability: ready.pixelAvailability, rows: [seven], edgeWorkItems: [] }), TypeError);

console.log("trade_final_classification_regression: PASS · four-state priority, crop availability, exact Projection3, R007 source accounting, edge work, Completion3 smoke");
