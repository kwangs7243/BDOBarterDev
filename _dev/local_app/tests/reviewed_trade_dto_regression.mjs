import assert from "node:assert/strict";
import { adaptLegacyCatalog, registrySnapshotSha256 } from "../frontend/js/domain/trade-master-registry.js";
import { validateReviewedTradeBatch } from "../frontend/js/domain/reviewed-trade-dto.js";

const POLICY = "reviewed-trade-dto-mapping-v1";
const UUIDS = {
  mutation: "20000000-0000-4000-8000-000000000001",
  observation: "10000000-0000-4000-8000-000000000001",
  batch: "30000000-0000-4000-8000-000000000001",
  capture: "40000000-0000-4000-8000-000000000001",
};
const sha = (letter) => letter.repeat(64);
const catalog = {
  masterData: { 1: ["재료 A", "재료 B"], 2: ["교환품 A", "교환품 B"], 3: ["3단"], 4: ["4단"], 5: ["5단"], 6: ["6단"], 7: ["7단"] },
  specialItems: ["특수품"], islands: ["섬 A", "섬 B", "섬  A"], t6Islands: ["6단 섬"], t7Islands: ["7단 섬"],
};
const registry = adaptLegacyCatalog(catalog, { sourceRevision: "test-v1", sourceSha256: sha("a") });
const verifiedTerm = (text) => ({ text, status: "VERIFIED", provenance: { evidenceRefs: ["synthetic-test"], note: null } });
const verifiedEntity = (stableId, kind, canonicalName, rawName, locator, displayName) => ({ stableId, kind, canonicalName,
  status: "VERIFIED", legacyNames: [{ rawName, expectedLocators: [locator] }], displayNames: [verifiedTerm(displayName)], aliases: [],
  provenance: { evidenceRefs: ["synthetic-test"], note: null }, replacedBy: null });
const verifiedRegistry = adaptLegacyCatalog(catalog, { sourceRevision: "test-curated-v1", sourceSha256: sha("b"),
  curatedMappings: { schemaVersion: 1, mappingRevision: "test-curation-v1", entities: [
    verifiedEntity("island-a", "ISLAND", "Island canonical", "섬 A", "/islands/0", "섬 표시"),
    verifiedEntity("item-a", "MASTER_ITEM", "Material canonical", "재료 A", "/masterData/1/0", "재료 표시"),
    verifiedEntity("item-out", "MASTER_ITEM", "Output canonical", "교환품 A", "/masterData/2/0", "교환품 표시"),
  ] } });
const legacyEntityRegistry = adaptLegacyCatalog(catalog, { sourceRevision: "test-unverified-v1", sourceSha256: sha("c"),
  curatedMappings: { schemaVersion: 1, mappingRevision: "test-unverified-curation", entities: [{
    stableId: "opaque-unverified-id", kind: "MASTER_ITEM", canonicalName: null, status: "LEGACY_UNVERIFIED",
    legacyNames: [{ rawName: "재료 A", expectedLocators: ["/masterData/1/0"] }], displayNames: [], aliases: [],
    provenance: { evidenceRefs: ["synthetic-test"], note: null }, replacedBy: null,
  }] } });

function makeRow(id, values = {}, methods = {}) {
  const captureId = UUIDS.capture;
  const defaults = { island: "섬 A", fromItem: "재료 A", reqAmount: 1, toItem: "교환품 A", count: 0, yield: 48 };
  const finalValues = { ...defaults, ...values };
  const fields = {};
  const reviewFields = [];
  for (const field of ["island", "fromItem", "reqAmount", "toItem", "count", "yield"]) {
    const shownValue = methods[field] === "unknown" && field === "fromItem" ? "미등록 재료"
      : methods[field] === "edited" ? defaults[field] : finalValues[field];
    const finalValue = methods[field] === "unknown" ? null : finalValues[field];
    const method = methods[field] === "unknown" ? "USER_MARKED_UNKNOWN"
      : methods[field] === "edited" ? "USER_EDITED" : "USER_BATCH_CONFIRMED_UNCHANGED";
    const projectedField = { field, shownValue, status: "MATCHED", candidate: null, rawEvidence: { rawText: String(shownValue) },
      correctionReason: [], riskReasons: [], masterVersion: registry.registryVersion };
    fields[field] = projectedField;
    reviewFields.push({ field, shownValueBefore: shownValue, finalValue, verificationMethod: method,
      projectionStatus: projectedField.status, candidate: projectedField.candidate, rawEvidence: projectedField.rawEvidence,
      correctionReason: [], riskReasons: [], masterVersion: registry.registryVersion });
  }
  const sourceRefs = [{ captureId, ordinal: id, draftRowId: `row-${id}`}];
  return {
    projection: { projectionRowId: `row-${id}`, captureId, ordinal: id, sourceIndex: id - 1, rowStatus: "COMPLETE",
      reviewState: "SYSTEM_PREDICTION_UNREVIEWED", sourceRefs, originalRowEvidence: { captureId, ordinal: id,
        sourceRefs, rowId: `row-${id}`, fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.rawEvidence])) }, fields },
    reviewed: { projectionRowId: `row-${id}`, captureId, ordinal: id, sourceRefs, fields: reviewFields },
  };
}

function observation({ rows = [makeRow(1)], cropPolicy = "C2_REVIEW_VALUE_SUBSET_V1" } = {}) {
  const projectionRows = rows.map((row) => row.projection);
  const completionRows = rows.map((row) => row.reviewed);
  const projection = {
    schemaVersion: 1, reviewMode: "REVIEW_FIRST", reconciliation: null,
    masterVersion: registry.registryVersion, masterRevision: registry.registryVersion,
    masterSourceRevision: registry.source.revision, masterSnapshotSha256: registrySnapshotSha256(registry),
    correctionPolicyVersion: "correction-v1", rows: projectionRows,
  };
  projection.projectionHash = registrySnapshotSha256(projection);
  const riskFieldCount = completionRows.flatMap((row) => row.fields).filter((field) => field.riskReasons.length).length;
  const unchangedFieldCount = completionRows.flatMap((row) => row.fields).filter((field) => field.verificationMethod === "USER_BATCH_CONFIRMED_UNCHANGED").length;
  const editedFieldCount = completionRows.flatMap((row) => row.fields).filter((field) => field.verificationMethod === "USER_EDITED").length;
  const unknownFieldCount = completionRows.flatMap((row) => row.fields).filter((field) => field.verificationMethod === "USER_MARKED_UNKNOWN").length;
  const record = {
    schemaVersion: 1, mutationId: UUIDS.mutation, createdAt: "2026-09-30T12:00:00.000Z", confirmationRevision: 1,
    supersedesObservationId: null,
    completion: { schemaVersion: 1, reviewMode: "REVIEW_FIRST", recognitionBatchId: UUIDS.batch,
      projectionHash: projection.projectionHash, registryVersion: registry.registryVersion, correctionVersion: "correction-v1",
      reviewRevision: 2, rows: completionRows, edgeSegments: [], summary: { rowCount: completionRows.length,
        fieldCount: completionRows.length * 6, unchangedFieldCount, editedFieldCount, unknownFieldCount, riskFieldCount, edgeSegmentCount: 0 } },
    sourceContext: { version: 1, authority: "CLIENT_ATTESTED",
      registry: { sourceRevision: registry.source.revision, sourceSha256: registry.source.sha256,
        snapshotSha256: registrySnapshotSha256(registry), snapshot: registry, hashBasis: "JS_REGISTRY_SORTED_JSON_V1" },
      projection: { snapshot: projection, hashBasis: "JS_REGISTRY_SORTED_JSON_V1" },
      recognition: { resultVersion: 1, runtime: { engineId: "test", modelBundleSha256: null, workerVersion: null },
        boundaryPolicy: "edge-segments-evidence-only-v1", captureEvidence: { captures: [{ captureId: UUIDS.capture,
          batchId: UUIDS.batch, captureOrdinal: 1, imageHash: sha("d"), imageDimensions: { width: 100, height: 80 },
          detectedCandidateCount: completionRows.length, completeRowCount: completionRows.length, edgeSegmentCount: 0 }], edgeSegments: [] },
        geometryProfile: { revision: null, sha256: null, availability: "NOT_EXPOSED_BY_API" } },
      captures: [{ captureId: UUIDS.capture, metadata: { version: 1, captureId: UUIDS.capture, batchId: UUIDS.batch,
        taskType: "trade", sourceType: "file", capturedAt: "2026-09-30T12:00:00Z", frame: { width: 100, height: 80 },
        fidelity: { sourceWidth: 100, sourceHeight: 80, rescaled: false, evidence: "file-metadata" }, profileId: null,
        profileVersion: 1, context: { baseRevision: 0, sessionId: null, sessionRevision: null },
        observed: { browserDpr: null, windowsDpi: null, gameResolution: null, gameUiScale: null } },
        bitmapSha256: sha("d"), sourceSha256: null, bitmapBytes: 100, sourceBytes: 100, reencoded: false }], gameVersion: null },
    cropPlan: { policy: cropPolicy, entries: [] }, observationId: UUIDS.observation, persistedAt: "2026-09-30T12:01:00.000Z",
    hashBasis: "PY_CANONICAL_JSON_V1", payloadHash: sha("e"), observationHash: sha("f"),
  };
  return record;
}

function request(record, { duplicate = false, exclusions = [] } = {}) {
  const observation = record;
  return {
    storedObservation: observation,
    evidenceReceipt: { schemaVersion: 1, observationId: observation.observationId, mutationId: observation.mutationId,
      payloadHash: observation.payloadHash, observationHash: observation.observationHash, persistedAt: observation.persistedAt,
      duplicate, evidenceSaved: true, sessionApplied: false, cropPolicy: observation.cropPlan.policy },
    expectedReview: { observationId: observation.observationId, mutationId: observation.mutationId,
      recognitionBatchId: observation.completion.recognitionBatchId, projectionHash: observation.completion.projectionHash,
      registryVersion: observation.completion.registryVersion, correctionVersion: observation.completion.correctionVersion,
      reviewRevision: observation.completion.reviewRevision, confirmationRevision: observation.confirmationRevision },
    exclusions, mappingPolicyVersion: POLICY,
  };
}

function run(record, options) { return validateReviewedTradeBatch(request(record, options)); }
function deepFrozen(value) { return !value || typeof value !== "object" || Object.isFrozen(value) && Object.values(value).every(deepFrozen); }
function bindRegistry(record, snapshot) {
  const source = record.sourceContext;
  const projection = source.projection.snapshot;
  const hash = registrySnapshotSha256(snapshot);
  source.registry = { sourceRevision: snapshot.source.revision, sourceSha256: snapshot.source.sha256,
    snapshotSha256: hash, snapshot, hashBasis: "JS_REGISTRY_SORTED_JSON_V1" };
  projection.masterVersion = snapshot.registryVersion;
  projection.masterRevision = snapshot.registryVersion;
  projection.masterSourceRevision = snapshot.source.revision;
  projection.masterSnapshotSha256 = hash;
  for (let i = 0; i < projection.rows.length; i += 1) {
    for (const field of Object.values(projection.rows[i].fields)) field.masterVersion = snapshot.registryVersion;
    for (const field of record.completion.rows[i].fields) field.masterVersion = snapshot.registryVersion;
  }
  record.completion.registryVersion = snapshot.registryVersion;
  delete projection.projectionHash;
  projection.projectionHash = registrySnapshotSha256(projection);
  record.completion.projectionHash = projection.projectionHash;
  return record;
}

const validInput = observation();
const before = JSON.stringify(validInput);
const ready = run(validInput);
assert.equal(ready.status, "READY");
assert.equal(ready.rows.length, 1);
assert.deepEqual(Object.keys(ready.rows[0].dto), ["island", "fromItem", "reqAmount", "toItem", "count", "yield"]);
assert.equal(ready.rows[0].dto.count, 0);
assert.equal(ready.rows[0].dto.yield, 48);
assert.equal(ready.coverage.fullGameCoverageClaim, false);
assert.equal(Object.keys(ready.rows[0].dto).length, 6);
assert.equal("stableId" in ready.rows[0].dto, false);
assert.equal("deleted" in ready.rows[0].dto, false);
assert.equal(JSON.stringify(validInput), before, "input must not be mutated");
assert.equal(deepFrozen(ready), true, "output must be recursively frozen");
assert.equal(run(validInput).semanticHash, ready.semanticHash);
assert.equal(run(validInput, { duplicate: true }).semanticHash, ready.semanticHash, "receipt replay flag is transport-only");

const missingReceipt = validateReviewedTradeBatch({ ...request(validInput), evidenceReceipt: null });
assert.equal(missingReceipt.status, "NOT_READY");
assert.equal(missingReceipt.batchErrors[0].code, "EVIDENCE_NOT_SAVED");
const notSaved = request(validInput); notSaved.evidenceReceipt.evidenceSaved = false;
assert.equal(validateReviewedTradeBatch(notSaved).batchErrors[0].code, "EVIDENCE_NOT_SAVED");
const stale = request(validInput); stale.expectedReview.reviewRevision += 1;
assert.equal(validateReviewedTradeBatch(stale).batchErrors[0].code, "STALE_REVIEW");
assert.equal(run(validInput, { }).status, "READY", "crop completeness is not a readiness gate");
assert.equal(validateReviewedTradeBatch({ ...request(validInput), mappingPolicyVersion: "future" }).batchErrors[0].code, "UNSUPPORTED_MAPPING_POLICY");

const unknownInput = observation({ rows: [makeRow(1, {}, { fromItem: "unknown" })] });
const unknown = run(unknownInput);
assert.equal(unknown.status, "NOT_READY");
assert(unknown.heldRows[0].heldReasons.some((reason) => reason.code === "UNKNOWN_FIELD"));
assert.equal(unknown.heldRows[0].heldReasons.some((reason) => ["INVALID_TEXT", "UNRESOLVED_MAPPING"].includes(reason.code)), false,
  "UNKNOWN is not relabeled as invalid or unmapped text");
const excludedUnknown = run(unknownInput, { exclusions: [{ projectionRowId: "row-1", action: "EXCLUDE_FROM_FINAL_DTO", reason: "USER_EXPLICIT_EXCLUSION" }] });
assert.equal(excludedUnknown.status, "EMPTY");
assert.equal(excludedUnknown.excludedRows.length, 1);
assert.equal(excludedUnknown.summary.reviewedRowCount,
  excludedUnknown.summary.validRowCount + excludedUnknown.summary.heldRowCount + excludedUnknown.summary.explicitlyExcludedRowCount);
assert.equal(run(validInput, { exclusions: [{ projectionRowId: "row-1", action: "EXCLUDE_FROM_FINAL_DTO", reason: "USER_EXPLICIT_EXCLUSION" }] }).batchErrors[0].code, "INVALID_EXCLUSION");
const twoUnknown = observation({ rows: [makeRow(1, {}, { fromItem: "unknown" }), makeRow(2, {}, { fromItem: "unknown" })] });
const exclusionA = { projectionRowId: "row-1", action: "EXCLUDE_FROM_FINAL_DTO", reason: "USER_EXPLICIT_EXCLUSION" };
const exclusionB = { projectionRowId: "row-2", action: "EXCLUDE_FROM_FINAL_DTO", reason: "USER_EXPLICIT_EXCLUSION" };
assert.equal(run(twoUnknown, { exclusions: [exclusionA, exclusionB] }).semanticHash,
  run(twoUnknown, { exclusions: [exclusionB, exclusionA] }).semanticHash, "exclusion order is normalized deterministically");
assert.equal(run(unknownInput, { exclusions: [{ projectionRowId: "source-only", action: "EXCLUDE_FROM_FINAL_DTO", reason: "USER_EXPLICIT_EXCLUSION" }] }).batchErrors[0].code, "INVALID_EXCLUSION");

const duplicateRows = observation({ rows: [makeRow(1), makeRow(2)] });
const duplicate = run(duplicateRows);
assert.equal(duplicate.status, "READY");
assert.equal(duplicate.rows.length, 1, "exact mapped-six duplicate rows collapse");
assert.deepEqual(duplicate.rows[0].memberProjectionRowIds, ["row-1", "row-2"]);
assert.equal(duplicate.rows[0].sourceRefs.length, 2, "all source references survive mapped duplicate collapse");
assert.equal(duplicate.rows[0].memberObservations.length, 2);
assert.equal(duplicate.coverage.duplicateCollapsedRowCount, 1);

const conflictRows = observation({ rows: [makeRow(1), makeRow(2, { yield: 148 })] });
const conflict = run(conflictRows);
assert.equal(conflict.status, "NOT_READY");
assert.equal(conflict.heldRows.length, 2);
assert(conflict.heldRows.every((row) => row.heldReasons.some((reason) => reason.code === "NUMERIC_CONFLICT")));
assert.equal(conflict.conflictGroups[0].alternatives.length, 2);
const conflictResolved = run(conflictRows, { exclusions: [{ projectionRowId: "row-1", action: "EXCLUDE_FROM_FINAL_DTO", reason: "USER_EXPLICIT_EXCLUSION" }] });
assert.equal(conflictResolved.status, "READY");
assert.equal(conflictResolved.conflictGroups[0].status, "RESOLVED_BY_EXCLUSION");

const inputConflict = run(observation({ rows: [makeRow(1), makeRow(2, { fromItem: "재료 B" })] }));
assert.equal(inputConflict.status, "NOT_READY");
assert(inputConflict.heldRows.every((row) => row.heldReasons.some((reason) => reason.code === "INPUT_CONFLICT")));
for (const [field, left, right] of [["reqAmount", 1, 2], ["count", 0, 1], ["yield", 48, 148]]) {
  const pair = run(observation({ rows: [makeRow(1, { [field]: left }), makeRow(2, { [field]: right })] }));
  assert.equal(pair.status, "NOT_READY", `${field} disagreement remains held`);
  assert(pair.heldRows.every((row) => row.heldReasons.some((reason) => reason.code === "NUMERIC_CONFLICT")));
}

const outOfTier = observation({ rows: [makeRow(1, { fromItem: "등록 안 된 재료", toItem: "교환품 B" }, { fromItem: "edited", toItem: "edited" })] });
assert.equal(run(outOfTier).status, "NOT_READY", "tier two cannot use OPEN_WORLD fromItem");

const openWorld = observation({ rows: [makeRow(1, { fromItem: "미등록 재료", toItem: "재료 A" }, { fromItem: "edited", toItem: "edited" })] });
const openWorldResult = run(openWorld);
assert.equal(openWorldResult.status, "READY");
assert.equal(openWorldResult.rows[0].mappingEvidence.fromItem.mappingMethod, "OPEN_WORLD_HUMAN_CONFIRMED");
assert.equal(openWorldResult.rows[0].dto.fromItem, "미등록 재료");

const candidateFallback = observation({ rows: [makeRow(1, { toItem: "등록되지 않은 출력" }, { toItem: "edited" })] });
const fallbackProjectionField = candidateFallback.sourceContext.projection.snapshot.rows[0].fields.toItem;
const fallbackReviewField = candidateFallback.completion.rows[0].fields.find((field) => field.field === "toItem");
const misleadingCandidate = { value: "교환품 A", stableId: null, legacyNameKey: "fake-key", kind: "MASTER_ITEM", tier: 2,
  authorityStatus: "LEGACY_UNVERIFIED", canonicalName: null, nameSource: "LEGACY_NAME" };
fallbackProjectionField.status = "UNMATCHED";
fallbackProjectionField.candidate = misleadingCandidate;
fallbackReviewField.projectionStatus = "UNMATCHED";
fallbackReviewField.candidate = misleadingCandidate;
candidateFallback.completion.summary.riskFieldCount = 1;
bindRegistry(candidateFallback, registry);
const noFallback = run(candidateFallback);
assert(noFallback.heldRows[0].heldReasons.some((reason) => reason.code === "UNRESOLVED_MAPPING"));
assert.equal(noFallback.heldRows[0].mappingEvidence.toItem.mappedValue, null, "candidate is never promoted to human final");

const numericInvalid = observation({ rows: [makeRow(1, { reqAmount: Number.MAX_SAFE_INTEGER + 1 }, { reqAmount: "edited" })] });
const invalidNumeric = run(numericInvalid);
assert.equal(invalidNumeric.status, "NOT_READY");
assert(invalidNumeric.heldRows[0].heldReasons.some((reason) => reason.code === "INVALID_NUMERIC"));

const numericLimit = observation({ rows: [makeRow(1, { reqAmount: Number.MAX_SAFE_INTEGER, count: Number.MAX_SAFE_INTEGER })] });
assert.equal(run(numericLimit).status, "READY");
for (const [field, value] of [["reqAmount", 0], ["count", -1], ["yield", 0]]) {
  const record = observation({ rows: [makeRow(1)] });
  const reviewed = record.completion.rows[0].fields.find((entry) => entry.field === field);
  reviewed.finalValue = value;
  reviewed.verificationMethod = "USER_EDITED";
  record.completion.summary.unchangedFieldCount -= 1;
  record.completion.summary.editedFieldCount += 1;
  const invalid = run(record);
  assert(invalid.heldRows[0].heldReasons.some((reason) => reason.code === "INVALID_NUMERIC"));
}
const numericString = observation({ rows: [makeRow(1)] });
const stringFinal = numericString.completion.rows[0].fields.find((field) => field.field === "reqAmount");
stringFinal.finalValue = "1";
stringFinal.verificationMethod = "USER_EDITED";
numericString.completion.summary.unchangedFieldCount -= 1;
numericString.completion.summary.editedFieldCount += 1;
assert(run(numericString).heldRows[0].heldReasons.some((reason) => reason.code === "INVALID_NUMERIC"), "numeric string coercion is forbidden");

const internalWhitespace = run(observation({ rows: [makeRow(1, { island: "섬  A" })] }));
assert.equal(internalWhitespace.status, "READY", "internal whitespace remains exact and is never normalized");
for (const name of ["island", "toItem"]) {
  const text = name === "island" ? " 섬 A" : "[T2] 교환품 A";
  const invalidText = run(observation({ rows: [makeRow(1, { [name]: text }, { [name]: "edited" })] }));
  assert(invalidText.heldRows[0].heldReasons.some((reason) => reason.code === "INVALID_TEXT"));
}
const oversizedText = run(observation({ rows: [makeRow(1, { fromItem: "가".repeat(171) }, { fromItem: "edited" })] }));
assert(oversizedText.heldRows[0].heldReasons.some((reason) => reason.code === "INVALID_TEXT"), "text limit is UTF-8 bytes");

const reconciled = observation();
const p = reconciled.sourceContext.projection.snapshot;
const logical = p.rows[0];
const conflictProjectionField = logical.fields.yield;
const conflictReviewField = reconciled.completion.rows[0].fields.find((field) => field.field === "yield");
conflictProjectionField.shownValue = null;
conflictProjectionField.status = "AMBIGUOUS";
conflictProjectionField.riskReasons = [{ code: "RECONCILIATION_CONFLICT" }];
conflictReviewField.shownValueBefore = null;
conflictReviewField.finalValue = 148;
conflictReviewField.verificationMethod = "USER_EDITED";
conflictReviewField.projectionStatus = "AMBIGUOUS";
conflictReviewField.riskReasons = conflictProjectionField.riskReasons;
reconciled.completion.summary.unchangedFieldCount -= 1;
reconciled.completion.summary.editedFieldCount += 1;
reconciled.completion.summary.riskFieldCount = 1;
p.schemaVersion = 2;
logical.reconciliationGroupId = "reconcile-group:0";
logical.reconciliationStatus = "UNMERGED";
logical.reconciliationMembers = [{ projectionRowId: "row-1", captureId: UUIDS.capture, ordinal: 1,
  sourceRefs: logical.sourceRefs }];
p.reconciliation = { schemaVersion: 1, phase: "FINAL", policyVersion: "trade-batch-reconciliation-v1",
  captureOrder: [{ captureId: UUIDS.capture, captureOrdinal: 1, imageHash: sha("d") }],
  sourceRows: [{ sourceRowId: "row-1", captureId: UUIDS.capture, ordinal: 1, projectionSourceIndex: 0, sourceRefs: logical.sourceRefs }],
  overlaps: [], groups: [{ reconciliationGroupId: "reconcile-group:0", status: "UNMERGED", memberSourceRowIds: ["row-1"],
    representativeSourceRowId: "row-1", logicalProjectionRowId: "row-1", mergeEvidenceIds: [] }],
  sourceToLogical: [{ sourceRowId: "row-1", logicalProjectionRowId: "row-1" }], sourceProjectionEvidence: [], findings: [] };
delete p.projectionHash;
p.projectionHash = registrySnapshotSha256(p);
reconciled.completion.projectionHash = p.projectionHash;
const reconciledReady = run(reconciled);
assert.equal(reconciledReady.status, "READY", "valid R007 FINAL singleton accounting remains usable");
assert.equal(reconciledReady.rows[0].dto.yield, 148, "human-resolved R007 conflict is not reopened from old source alternatives");
assert.equal(reconciledReady.coverage.sourceCompleteRowCount, 1);
assert.equal(reconciledReady.provenance.reconciliation.phase, "FINAL");

const verifiedInput = bindRegistry(observation(), verifiedRegistry);
for (const [field, displayName] of [["island", "섬 표시"], ["fromItem", "재료 표시"], ["toItem", "교환품 표시"]]) {
  const projected = verifiedInput.sourceContext.projection.snapshot.rows[0].fields[field];
  const reviewed = verifiedInput.completion.rows[0].fields.find((item) => item.field === field);
  projected.status = "MASTER_DISAGREEMENT";
  reviewed.projectionStatus = "MASTER_DISAGREEMENT";
  reviewed.shownValueBefore = projected.shownValue;
  reviewed.finalValue = displayName;
  reviewed.verificationMethod = "USER_EDITED";
  projected.shownValue = field === "island" ? "섬 A" : field === "fromItem" ? "재료 A" : "교환품 A";
}
verifiedInput.completion.summary.riskFieldCount = 3;
verifiedInput.completion.summary.unchangedFieldCount -= 3;
verifiedInput.completion.summary.editedFieldCount += 3;
bindRegistry(verifiedInput, verifiedRegistry);
const verifiedOutput = run(verifiedInput);
assert.equal(verifiedOutput.status, "READY", "safe verified names can resolve a previous master disagreement");
assert.deepEqual(verifiedOutput.rows[0].dto, { island: "섬 A", fromItem: "재료 A", reqAmount: 1, toItem: "교환품 A", count: 0, yield: 48 });
assert.equal(verifiedOutput.rows[0].humanFinalValues.island, "섬 표시");
assert.equal(verifiedOutput.rows[0].mappingEvidence.toItem.mappingMethod, "VERIFIED_ENTITY_COMPATIBILITY");

const exactUnverified = run(bindRegistry(observation(), legacyEntityRegistry));
assert.equal(exactUnverified.status, "READY", "a curated but unverified stable entity remains usable by exact legacy raw token");
assert.equal(exactUnverified.rows[0].mappingEvidence.fromItem.mappingMethod, "EXACT_LEGACY_NAME");
assert.equal(exactUnverified.rows[0].mappingEvidence.fromItem.stableId, "opaque-unverified-id");
assert.equal(exactUnverified.rows[0].mappingEvidence.fromItem.authorityStatus, "LEGACY_UNVERIFIED");

const canonicalOnly = bindRegistry(observation(), verifiedRegistry);
const canonicalField = canonicalOnly.sourceContext.projection.snapshot.rows[0].fields.toItem;
const canonicalReview = canonicalOnly.completion.rows[0].fields.find((item) => item.field === "toItem");
canonicalField.status = "MASTER_DISAGREEMENT";
canonicalReview.projectionStatus = "MASTER_DISAGREEMENT";
canonicalReview.shownValueBefore = canonicalField.shownValue;
canonicalReview.finalValue = "Output canonical";
canonicalReview.verificationMethod = "USER_EDITED";
canonicalOnly.completion.summary.riskFieldCount = 1;
canonicalOnly.completion.summary.unchangedFieldCount -= 1;
canonicalOnly.completion.summary.editedFieldCount += 1;
bindRegistry(canonicalOnly, verifiedRegistry);
assert.equal(run(canonicalOnly).heldRows[0].heldReasons.some((reason) => reason.code === "MASTER_DISAGREEMENT_UNRESOLVED"), true,
  "canonicalName by itself is not a verified compatibility mapping");

const tierSix = observation({ rows: [makeRow(1, { island: "6단 섬", fromItem: "5단", toItem: "6단" })] });
assert.equal(run(tierSix).status, "READY");
const wrongTierIsland = observation({ rows: [makeRow(1, { island: "섬 A", fromItem: "5단", toItem: "6단" })] });
assert.equal(run(wrongTierIsland).status, "NOT_READY", "tier-six output requires T6 island scope");
const specialOutput = observation({ rows: [makeRow(1, { island: "섬 A", fromItem: "재료 A", toItem: "특수품" })] });
assert.equal(run(specialOutput).status, "READY");

let accessorRan = false;
const hostileExclusions = [];
Object.defineProperty(hostileExclusions, "0", { enumerable: true, get() { accessorRan = true; return {}; } });
hostileExclusions.length = 1;
assert.equal(run(validInput, { exclusions: hostileExclusions }).status, "NOT_READY");
assert.equal(accessorRan, false, "accessor properties must be rejected without executing them");

const badProjection = structuredClone(validInput);
badProjection.sourceContext.projection.snapshot.rows[0].fields.toItem.shownValue = "changed";
assert.equal(run(badProjection).batchErrors[0].code, "INVALID_OBSERVATION");
const badRegistry = structuredClone(validInput);
badRegistry.sourceContext.registry.snapshot.source.revision = "tampered";
assert.equal(run(badRegistry).batchErrors[0].code, "INVALID_OBSERVATION");
const nonHuman = structuredClone(validInput);
nonHuman.completion.rows[0].fields[0].verificationMethod = "SYSTEM_PREDICTION_UNREVIEWED";
assert.equal(run(nonHuman).batchErrors[0].code, "NON_HUMAN_REVIEW");

const cycle = structuredClone(validInput);
cycle.sourceContext.untrusted = cycle;
assert.equal(validateReviewedTradeBatch({ ...request(cycle) }).batchErrors[0].code, "INVALID_OBSERVATION");

console.log("reviewed_trade_dto_regression: PASS");
