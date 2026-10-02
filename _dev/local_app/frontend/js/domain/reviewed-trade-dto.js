import { registrySnapshotSha256, validateRegistrySnapshot } from "./trade-master-registry.js";
import { masterBundleContentHash, validateMasterBundleV2 } from "./trade-master-bundle.js";
import { buildFinalProjection3, buildFinalReviewCompletion, buildFinalReviewObservationRequest } from "./trade-final-evidence.js";

const POLICY = "reviewed-trade-dto-mapping-v1";
const FIELDS = Object.freeze(["island", "fromItem", "reqAmount", "toItem", "count", "yield"]);
const NUMERIC_FIELDS = new Set(["reqAmount", "count", "yield"]);
const METHODS = new Set(["USER_BATCH_CONFIRMED_UNCHANGED", "USER_EDITED", "USER_MARKED_UNKNOWN"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const HASH_BASIS = "JS_REGISTRY_SORTED_JSON_V1";
const REASONS = Object.freeze({
  UNKNOWN_FIELD: "UNKNOWN_FIELD", INVALID_TEXT: "INVALID_TEXT", INVALID_NUMERIC: "INVALID_NUMERIC",
  UNRESOLVED_MAPPING: "UNRESOLVED_MAPPING", AMBIGUOUS_MAPPING: "AMBIGUOUS_MAPPING",
  MASTER_DISAGREEMENT_UNRESOLVED: "MASTER_DISAGREEMENT_UNRESOLVED",
  NUMERIC_CONFLICT: "NUMERIC_CONFLICT", INPUT_CONFLICT: "INPUT_CONFLICT",
});

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }
function validUnicode(value) {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

function cloneJson(value, path = "input", ancestors = new Set(), depth = 0, budget = { remaining: 250000 }) {
  budget.remaining -= 1;
  if (budget.remaining < 0 || depth > 32) throw new TypeError("input exceeds structural limits");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!validUnicode(value)) throw new TypeError(`${path} contains invalid Unicode`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`${path} is not JSON data`);
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} has a custom prototype`);
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError(`${path} contains symbol keys`);
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = [];
    for (let i = 0; i < value.length; i += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw new TypeError(`${path}[${i}] is not a JSON array item`);
      result.push(cloneJson(descriptor.value, `${path}[${i}]`, ancestors, depth + 1, budget));
    }
    if (Object.getOwnPropertyNames(value).filter((key) => key !== "length").length !== value.length) throw new TypeError(`${path} has non-index array properties`);
  } else {
    result = {};
    if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length) throw new TypeError(`${path} has hidden properties`);
    for (const key of Object.keys(value)) {
      if (!validUnicode(key) || key === "__proto__") throw new TypeError(`${path} has an invalid key`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw new TypeError(`${path}.${key} is an accessor or hidden property`);
      result[key] = cloneJson(descriptor.value, `${path}.${key}`, ancestors, depth + 1, budget);
    }
  }
  ancestors.delete(value);
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}
function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}
function same(a, b) { return stable(a) === stable(b); }
function unique(values) {
  const seen = new Set(); const result = [];
  for (const value of values) { const key = stable(value); if (!seen.has(key)) { seen.add(key); result.push(value); } }
  return result;
}
function validHash(value) { return typeof value === "string" && SHA256.test(value); }
function validUuid(value) { return typeof value === "string" && UUID.test(value); }
function batchError(code, detail = null) { return { code, detail }; }
function rowReason(code, field = null, detail = null) { return { code, field, detail }; }

function emptyResult(code, detail = null, mappingPolicyVersion = POLICY) {
  return {
    schemaVersion: 1, status: "NOT_READY", observationRef: null, expectedReview: null,
    projectionHash: null, registryVersion: null, mappingPolicyVersion,
    rows: [], heldRows: [], excludedRows: [], duplicateGroups: [], conflictGroups: [],
    batchErrors: [batchError(code, detail)],
    summary: { reviewedRowCount: 0, validRowCount: 0, heldRowCount: 0, explicitlyExcludedRowCount: 0, outputRowCount: 0, initialHeldRowCount: 0 },
    coverage: { sourceCompleteRowCount: null, logicalReviewedRowCount: 0, unknownRowCount: 0, invalidRowCount: 0, excludedRowCount: 0, duplicateCollapsedRowCount: 0, edgeSegmentCount: 0, fullGameCoverageClaim: false },
    provenance: { reviewMode: null, correctionVersion: null, reviewRevision: null, confirmationRevision: null, reconciliation: null, edgeSegments: [] },
    hashBasis: HASH_BASIS,
  };
}

function finish(output) {
  const base = { ...output };
  delete base.semanticHash;
  output.semanticHash = registrySnapshotSha256(base);
  return deepFreeze(output);
}

function isValidText(value, checkLegacyDecoration = false) {
  if (typeof value !== "string" || !validUnicode(value) || value.length === 0 || value.trim().length === 0
      || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  if (new TextEncoder().encode(value).length > 512) return false;
  if (!checkLegacyDecoration) return true;
  const legacyClean = value.replace(/\[.*?\]\s*/gu, "").replace(/\s*x\s*\d+/giu, "").trim();
  return legacyClean === value;
}

function minFor(field) { return field === "count" ? 0 : 1; }

function compareReceipt(observation, receipt) {
  if (!isRecord(receipt)) return batchError("EVIDENCE_NOT_SAVED", "missing_receipt");
  if (receipt.evidenceSaved !== true) return batchError("EVIDENCE_NOT_SAVED", "receipt_not_saved");
  const expectedKeys = ["schemaVersion", "observationId", "mutationId", "payloadHash", "observationHash", "persistedAt", "duplicate", "evidenceSaved", "sessionApplied", "cropPolicy"];
  if (!exactKeys(receipt, expectedKeys) || receipt.schemaVersion !== 1 || receipt.sessionApplied !== false
      || typeof receipt.duplicate !== "boolean" || receipt.cropPolicy !== observation.cropPlan?.policy) {
    return batchError("STALE_REVIEW", "receipt_shape_or_save_state");
  }
  if (receipt.observationId !== observation.observationId || receipt.mutationId !== observation.mutationId
      || receipt.payloadHash !== observation.payloadHash || receipt.observationHash !== observation.observationHash
      || receipt.persistedAt !== observation.persistedAt) return batchError("STALE_REVIEW", "receipt_observation_binding");
  return null;
}

function compareExpected(observation, expected) {
  const keys = ["observationId", "mutationId", "recognitionBatchId", "projectionHash", "registryVersion", "correctionVersion", "reviewRevision", "confirmationRevision"];
  if (!exactKeys(expected, keys)) return batchError("STALE_REVIEW", "expected_review_missing_or_malformed");
  const actual = {
    observationId: observation.observationId, mutationId: observation.mutationId,
    recognitionBatchId: observation.completion?.recognitionBatchId,
    projectionHash: observation.completion?.projectionHash,
    registryVersion: observation.completion?.registryVersion,
    correctionVersion: observation.completion?.correctionVersion,
    reviewRevision: observation.completion?.reviewRevision,
    confirmationRevision: observation.confirmationRevision,
  };
  return keys.every((key) => expected[key] === actual[key]) ? null : batchError("STALE_REVIEW", "expected_review_binding_mismatch");
}

function projectionAndRegistry(observation) {
  const source = observation.sourceContext;
  if (!exactKeys(source, ["version", "authority", "registry", "projection", "recognition", "captures", "gameVersion"])
      || source.version !== 1 || source.authority !== "CLIENT_ATTESTED" || !isRecord(source.registry)
      || !isRecord(source.projection) || !isRecord(source.recognition) || !Array.isArray(source.captures)) throw new Error("source_context_shape");
  const registryWrap = source.registry;
  if (!exactKeys(registryWrap, ["sourceRevision", "sourceSha256", "snapshotSha256", "snapshot", "hashBasis"])
      || registryWrap.hashBasis !== HASH_BASIS || !nonempty(registryWrap.sourceRevision)
      || !validHash(registryWrap.sourceSha256) || !validHash(registryWrap.snapshotSha256)
      || !isRecord(registryWrap.snapshot)) throw new Error("registry_wrapper_shape");
  const snapshot = registryWrap.snapshot;
  const registryValidation = validateRegistrySnapshot(snapshot);
  if (!registryValidation.ok || snapshot.legacyNames.length > 1000 || snapshot.entities.length > 1000 || registryWrap.sourceRevision !== snapshot.source.revision
      || registryWrap.sourceSha256 !== snapshot.source.sha256
      || registryWrap.snapshotSha256 !== registrySnapshotSha256(snapshot)) throw new Error("registry_snapshot_integrity");
  const projectionWrap = source.projection;
  if (!exactKeys(projectionWrap, ["snapshot", "hashBasis"]) || projectionWrap.hashBasis !== HASH_BASIS || !isRecord(projectionWrap.snapshot)) throw new Error("projection_wrapper_shape");
  const projection = projectionWrap.snapshot;
  if (![1, 2].includes(projection.schemaVersion) || projection.reviewMode !== "REVIEW_FIRST"
      || !validHash(projection.projectionHash) || !nonempty(projection.masterVersion)
      || !nonempty(projection.masterRevision) || !nonempty(projection.masterSourceRevision)
      || !validHash(projection.masterSnapshotSha256) || !nonempty(projection.correctionPolicyVersion)
      || !Array.isArray(projection.rows)) throw new Error("projection_shape");
  const { projectionHash, ...projectionBase } = projection;
  if (projectionHash !== registrySnapshotSha256(projectionBase)
      || projection.masterSnapshotSha256 !== registryWrap.snapshotSha256
      || projection.masterVersion !== snapshot.registryVersion || projection.masterRevision !== snapshot.registryVersion
      || projection.masterSourceRevision !== snapshot.source.revision) throw new Error("projection_integrity_or_registry_binding");
  if (projection.schemaVersion === 1 && projection.reconciliation !== null) throw new Error("legacy_projection_reconciliation");
  if (projection.schemaVersion === 2 && (!isRecord(projection.reconciliation) || projection.reconciliation.phase !== "FINAL")) throw new Error("final_reconciliation_required");
  const completion = observation.completion;
  if (completion.projectionHash !== projectionHash || completion.registryVersion !== snapshot.registryVersion
      || completion.correctionVersion !== projection.correctionPolicyVersion) throw new Error("completion_projection_binding");
  return { snapshot, projection, completion, source };
}

function validateBaseObservation(observation) {
  const keys = ["schemaVersion", "mutationId", "createdAt", "confirmationRevision", "supersedesObservationId", "completion", "sourceContext", "cropPlan", "observationId", "persistedAt", "hashBasis", "payloadHash", "observationHash"];
  if (!exactKeys(observation, keys) || observation.schemaVersion !== 1 || !validUuid(observation.mutationId)
      || !validUuid(observation.observationId) || observation.confirmationRevision !== 1 || observation.supersedesObservationId !== null
      || observation.hashBasis !== "PY_CANONICAL_JSON_V1" || !validHash(observation.payloadHash) || !validHash(observation.observationHash)
      || !nonempty(observation.createdAt) || !nonempty(observation.persistedAt)) throw new Error("stored_observation_shape");
  const completion = observation.completion;
  const ckeys = ["schemaVersion", "reviewMode", "recognitionBatchId", "projectionHash", "registryVersion", "correctionVersion", "reviewRevision", "rows", "edgeSegments", "summary"];
  if (!exactKeys(completion, ckeys) || completion.schemaVersion !== 1 || completion.reviewMode !== "REVIEW_FIRST"
      || !validUuid(completion.recognitionBatchId) || !validHash(completion.projectionHash)
      || !nonempty(completion.registryVersion) || !nonempty(completion.correctionVersion)
      || !Number.isSafeInteger(completion.reviewRevision) || completion.reviewRevision < 0
      || !Array.isArray(completion.rows) || completion.rows.length > 1000 || !Array.isArray(completion.edgeSegments) || completion.edgeSegments.length > 200) throw new Error("completion_shape");
  const cropPlan = observation.cropPlan;
  if (!isRecord(cropPlan) || cropPlan.policy !== "C2_REVIEW_VALUE_SUBSET_V1" || !Array.isArray(cropPlan.entries)) throw new Error("crop_plan_shape");
}

function captureIndex(source) {
  const captures = source.captures; const recognition = source.recognition;
  if (!exactKeys(recognition, ["resultVersion", "runtime", "boundaryPolicy", "captureEvidence", "geometryProfile"])
      || recognition.resultVersion !== 1 || !nonempty(recognition.boundaryPolicy) || !isRecord(recognition.runtime)
      || !exactKeys(recognition.captureEvidence, ["captures", "edgeSegments"]) || !Array.isArray(recognition.captureEvidence.captures)
      || !Array.isArray(recognition.captureEvidence.edgeSegments) || !Array.isArray(captures) || captures.length < 1 || captures.length > 100) throw new Error("recognition_source_shape");
  const byId = new Map(); const capturesById = new Map();
  for (const item of captures) {
    if (!isRecord(item) || !validUuid(item.captureId) || capturesById.has(item.captureId) || !isRecord(item.metadata)
        || item.metadata.captureId !== item.captureId || item.metadata.taskType !== "trade" || !validHash(item.bitmapSha256)) throw new Error("capture_record_shape");
    capturesById.set(item.captureId, item);
  }
  if (recognition.captureEvidence.captures.length !== captures.length) throw new Error("capture_evidence_count");
  for (let i = 0; i < recognition.captureEvidence.captures.length; i += 1) {
    const evidence = recognition.captureEvidence.captures[i]; const cap = captures[i];
    if (!isRecord(evidence) || evidence.captureId !== cap.captureId || !validUuid(evidence.captureId)
        || evidence.batchId !== cap.metadata.batchId || evidence.captureOrdinal !== i + 1
        || evidence.imageHash !== cap.bitmapSha256 || !Number.isSafeInteger(evidence.completeRowCount) || evidence.completeRowCount < 0
        || !Number.isSafeInteger(evidence.edgeSegmentCount) || evidence.edgeSegmentCount < 0
        || !Number.isSafeInteger(evidence.detectedCandidateCount) || evidence.detectedCandidateCount !== evidence.completeRowCount + evidence.edgeSegmentCount) throw new Error("capture_evidence_binding");
    byId.set(evidence.captureId, evidence);
  }
  return { byId, capturesById };
}

function validateRefs(refs, knownCaptures = null) {
  if (!Array.isArray(refs) || refs.length > 100) return false;
  return refs.every((ref) => isRecord(ref) && validUuid(ref.captureId) && (!knownCaptures || knownCaptures.has(ref.captureId))
    && Number.isSafeInteger(ref.ordinal) && ref.ordinal >= 1);
}

function validateLegacyProjection(projection, completion, evidenceById) {
  if (projection.schemaVersion !== 1 || projection.reconciliation !== null) throw new Error("legacy_projection_version");
  if (projection.rows.length !== completion.rows.length) throw new Error("legacy_row_count");
  const counts = new Map([...evidenceById.keys()].map((id) => [id, 0]));
  const positions = new Set();
  projection.rows.forEach((row, index) => {
    if (!isRecord(row) || !counts.has(row.captureId) || row.rowStatus !== "COMPLETE" || row.reviewState !== "SYSTEM_PREDICTION_UNREVIEWED"
        || row.sourceIndex !== index || !Number.isSafeInteger(row.ordinal) || row.ordinal < 1 || !validateRefs(row.sourceRefs, counts)) throw new Error("legacy_unknown_capture");
    const position = `${row.captureId}\0${row.ordinal}`;
    if (positions.has(position)) throw new Error("legacy_duplicate_source_position");
    positions.add(position);
    counts.set(row.captureId, counts.get(row.captureId) + 1);
    const originalRowId = row.originalRowEvidence?.rowId;
    const expectedSourceId = nonempty(originalRowId) ? originalRowId : `draft:${row.captureId}:${row.ordinal}`;
    if (row.projectionRowId !== expectedSourceId) throw new Error("legacy_source_row_id");
  });
  for (const [captureId, count] of counts) if (evidenceById.get(captureId).completeRowCount !== count) throw new Error("legacy_source_count");
  for (const row of projection.rows) if (["reconciliationGroupId", "reconciliationStatus", "reconciliationMembers"].some((key) => Object.hasOwn(row, key))) throw new Error("legacy_reconciled_metadata");
  return { sourceCount: projection.rows.length, sourceByLogical: new Map(projection.rows.map((row) => [row.projectionRowId, [row.projectionRowId]])) };
}

function validateFinalReconciliation(projection, completion, evidenceById) {
  const rec = projection.reconciliation;
  const recKeys = ["schemaVersion", "phase", "policyVersion", "captureOrder", "sourceRows", "overlaps", "groups", "sourceToLogical", "sourceProjectionEvidence", "findings"];
  if (!exactKeys(rec, recKeys) || rec.schemaVersion !== 1 || rec.phase !== "FINAL"
      || rec.policyVersion !== "trade-batch-reconciliation-v1" || !Array.isArray(rec.captureOrder)
      || !Array.isArray(rec.sourceRows) || !Array.isArray(rec.overlaps) || !Array.isArray(rec.groups)
      || !Array.isArray(rec.sourceToLogical) || !Array.isArray(rec.sourceProjectionEvidence) || !Array.isArray(rec.findings)) throw new Error("reconciliation_shape");
  const captures = [...evidenceById.keys()];
  if (rec.captureOrder.length !== captures.length || rec.captureOrder.some((entry, i) => !exactKeys(entry, ["captureId", "captureOrdinal", "imageHash"])
      || entry.captureId !== captures[i] || entry.captureOrdinal !== i + 1 || entry.imageHash !== evidenceById.get(entry.captureId).imageHash)) throw new Error("reconciliation_capture_order");
  const logical = new Map(projection.rows.map((row) => [row.projectionRowId, row]));
  if (logical.size !== projection.rows.length || logical.size !== completion.rows.length || logical.size > 1000) throw new Error("logical_ids");
  if (rec.groups.length !== projection.rows.length
      || rec.groups.some((group, index) => group?.logicalProjectionRowId !== projection.rows[index]?.projectionRowId)) throw new Error("logical_group_order");
  const source = new Map(); const perCapture = new Map(captures.map((id) => [id, 0]));
  const positions = new Set();
  rec.sourceRows.forEach((row, index) => {
    const required = ["sourceRowId", "captureId", "ordinal", "projectionSourceIndex", "sourceRefs"];
    if (!isRecord(row) || required.some((key) => !Object.hasOwn(row, key))
        || Object.keys(row).some((key) => ![...required, "draftId", "rowBox", "rowCropHash"].includes(key))
        || !nonempty(row.sourceRowId) || row.sourceRowId.length > 256 || source.has(row.sourceRowId)
        || !perCapture.has(row.captureId) || !Number.isSafeInteger(row.ordinal) || row.ordinal < 1
        || !Number.isSafeInteger(row.projectionSourceIndex) || row.projectionSourceIndex < 0
        || !validateRefs(row.sourceRefs, perCapture)) throw new Error("source_row_shape");
    const position = `${row.captureId}\0${row.ordinal}`;
    if (positions.has(position)) throw new Error("duplicate_source_position");
    positions.add(position); source.set(row.sourceRowId, row); perCapture.set(row.captureId, perCapture.get(row.captureId) + 1);
    if (row.projectionSourceIndex !== index) throw new Error("source_index_order");
  });
  if (source.size > 1000) throw new Error("source_limit");
  for (const [id, count] of perCapture) if (evidenceById.get(id).completeRowCount !== count) throw new Error("reconciled_source_count");
  if (rec.sourceToLogical.length !== source.size) throw new Error("source_mapping_count");
  const assignment = new Map();
  for (const map of rec.sourceToLogical) {
    if (!exactKeys(map, ["sourceRowId", "logicalProjectionRowId"]) || !source.has(map.sourceRowId)
        || !logical.has(map.logicalProjectionRowId) || assignment.has(map.sourceRowId)) throw new Error("source_mapping_entry");
    assignment.set(map.sourceRowId, map.logicalProjectionRowId);
  }
  if (assignment.size !== source.size) throw new Error("source_mapping_bijection");
  const expectedSourceMap = rec.sourceRows.map((row) => ({ sourceRowId: row.sourceRowId, logicalProjectionRowId: assignment.get(row.sourceRowId) }));
  if (!same(rec.sourceToLogical, expectedSourceMap)) throw new Error("source_mapping_order_or_binding");
  const groupsByLogical = new Map(); const sourceByLogical = new Map([...logical.keys()].map((id) => [id, []]));
  const seenMembers = new Set();
  for (const group of rec.groups) {
    if (!exactKeys(group, ["reconciliationGroupId", "status", "memberSourceRowIds", "representativeSourceRowId", "logicalProjectionRowId", "mergeEvidenceIds"])
        || !nonempty(group.reconciliationGroupId) || !Array.isArray(group.memberSourceRowIds)
        || !group.memberSourceRowIds.length || !nonempty(group.representativeSourceRowId)
        || !nonempty(group.logicalProjectionRowId) || !logical.has(group.logicalProjectionRowId)
        || !["UNMERGED", "EXACT_OVERLAP", "CONFLICT"].includes(group.status)
        || !Array.isArray(group.mergeEvidenceIds)) throw new Error("reconciliation_group_shape");
    if (groupsByLogical.has(group.logicalProjectionRowId)) throw new Error("duplicate_logical_group");
    if (group.representativeSourceRowId !== group.memberSourceRowIds[0]
        || group.logicalProjectionRowId !== group.representativeSourceRowId) throw new Error("representative_mismatch");
    const members = group.memberSourceRowIds;
    const memberPositions = members.map((id) => source.get(id)?.projectionSourceIndex ?? -1);
    if (memberPositions.some((position, index) => position < 0 || index > 0 && position <= memberPositions[index - 1])) throw new Error("group_member_order");
    if (!source.has(members[0]) || members.some((id) => !source.has(id) || seenMembers.has(id) || assignment.get(id) !== group.logicalProjectionRowId)) throw new Error("group_member_mismatch");
    for (const id of members) seenMembers.add(id);
    const row = logical.get(group.logicalProjectionRowId);
    if (members.length === 1 && group.status !== "UNMERGED" || members.length > 1 && group.status === "UNMERGED") throw new Error("group_status_mismatch");
    const representative = source.get(members[0]);
    if (group.reconciliationGroupId !== `reconcile-group:${representative.projectionSourceIndex}`
        || row.reconciliationGroupId !== group.reconciliationGroupId || row.reconciliationStatus !== group.status
        || row.captureId !== representative.captureId || row.ordinal !== representative.ordinal || row.projectionRowId !== group.logicalProjectionRowId
        || !Array.isArray(row.reconciliationMembers) || row.reconciliationMembers.length !== members.length
        || row.reconciliationMembers.some((item, i) => item.projectionRowId !== members[i])) throw new Error("logical_group_binding");
    for (let index = 0; index < members.length; index += 1) {
      const sid = members[index]; const src = source.get(sid); const meta = row.reconciliationMembers[index];
      const required = ["projectionRowId", "captureId", "ordinal", "sourceRefs"];
      const optional = ["draftId", "rowBox", "rowCropHash"];
      if (!isRecord(meta) || required.some((key) => !Object.hasOwn(meta, key))
          || Object.keys(meta).some((key) => ![...required, ...optional].includes(key))
          || meta.projectionRowId !== sid || meta.captureId !== src.captureId || meta.ordinal !== src.ordinal
          || !same(meta.sourceRefs, src.sourceRefs)
          || optional.some((key) => Object.hasOwn(src, key) !== Object.hasOwn(meta, key) || Object.hasOwn(src, key) && !same(src[key], meta[key]))) {
        throw new Error("logical_member_metadata_mismatch");
      }
    }
    const refs = unique(members.flatMap((id) => source.get(id).sourceRefs));
    if (!same(refs, row.sourceRefs)) throw new Error("logical_source_refs_union");
    if (!same(row.rowBox ?? null, representative.rowBox ?? null) || !same(row.rowCropHash ?? null, representative.rowCropHash ?? null)) throw new Error("logical_representative_geometry");
    for (const id of members) sourceByLogical.get(group.logicalProjectionRowId).push(id);
    groupsByLogical.set(group.logicalProjectionRowId, group);
  }
  if (seenMembers.size !== source.size || groupsByLogical.size !== logical.size || [...logical.keys()].some((id) => !groupsByLogical.has(id))) throw new Error("group_accounting");
  const mergedIds = rec.sourceRows.filter((row) => [...groupsByLogical.values()].some((group) => group.memberSourceRowIds.length > 1 && group.memberSourceRowIds.includes(row.sourceRowId))).map((row) => row.sourceRowId);
  if (rec.sourceProjectionEvidence.length !== mergedIds.length) throw new Error("source_projection_evidence_count");
  const evidenceIds = new Set();
  for (let index = 0; index < rec.sourceProjectionEvidence.length; index += 1) {
    const item = rec.sourceProjectionEvidence[index];
    if (!isRecord(item) || !source.has(item.projectionRowId) || evidenceIds.has(item.projectionRowId)) throw new Error("source_projection_evidence_entry");
    if (item.projectionRowId !== mergedIds[index]) throw new Error("source_projection_evidence_order");
    evidenceIds.add(item.projectionRowId);
    const map = assignment.get(item.projectionRowId); const logicalRow = logical.get(map);
    const member = logicalRow.reconciliationMembers.find((m) => m.projectionRowId === item.projectionRowId);
    if (item.captureId !== member.captureId || item.ordinal !== member.ordinal || !same(item.sourceRefs, member.sourceRefs)) throw new Error("source_projection_evidence_binding");
  }
  for (const [logicalId, row] of logical) {
    const completionRow = completion.rows.find((item) => item.projectionRowId === logicalId);
    if (!completionRow || completionRow.captureId !== row.captureId || completionRow.ordinal !== row.ordinal
        || !same(completionRow.sourceRefs, row.sourceRefs)) throw new Error("logical_completion_lineage");
  }
  return { sourceCount: source.size, sourceByLogical };
}

function validateCompletionRows(projection, completion, captureData, accounting) {
  if (projection.rows.length !== completion.rows.length || completion.rows.length > 1000) throw new Error("completion_row_count");
  const expectedOrder = projection.rows.map((row) => row.projectionRowId);
  if (new Set(expectedOrder).size !== expectedOrder.length) throw new Error("duplicate_projection_id");
  let unchanged = 0; let edited = 0; let unknown = 0; let risky = 0;
  const validated = [];
  for (let i = 0; i < projection.rows.length; i += 1) {
    const projected = projection.rows[i]; const reviewed = completion.rows[i];
    if (!isRecord(projected) || !isRecord(reviewed) || reviewed.projectionRowId !== expectedOrder[i]
        || reviewed.captureId !== projected.captureId || reviewed.ordinal !== projected.ordinal
        || projected.rowStatus !== "COMPLETE" || projected.reviewState !== "SYSTEM_PREDICTION_UNREVIEWED"
        || !Number.isSafeInteger(reviewed.ordinal) || reviewed.ordinal < 1
        || !captureData.capturesById.has(reviewed.captureId) || !validateRefs(reviewed.sourceRefs, captureData.capturesById)
        || !same(reviewed.sourceRefs, projected.sourceRefs)) throw new Error("completion_projection_row_binding");
    for (const key of ["draftId", "rowBox", "rowCropHash"]) if (!same(reviewed[key] ?? null, projected[key] ?? null)) throw new Error("completion_projection_metadata_binding");
    if (projected.projectionRowId !== reviewed.projectionRowId || !isRecord(projected.fields)
        || Object.keys(projected.fields).sort().join("\0") !== [...FIELDS].sort().join("\0")
        || !Array.isArray(reviewed.fields) || reviewed.fields.length !== 6
        || reviewed.fields.some((f, j) => !isRecord(f) || f.field !== FIELDS[j])) throw new Error("completion_field_shape");
    const fieldResults = {};
    for (let j = 0; j < FIELDS.length; j += 1) {
      const name = FIELDS[j]; const field = reviewed.fields[j]; const pf = projected.fields[name];
      const fieldKeys = ["field", "shownValueBefore", "finalValue", "verificationMethod", "projectionStatus", "candidate", "rawEvidence", "correctionReason", "riskReasons", "masterVersion"];
      if (!exactKeys(field, fieldKeys) || !same(field.shownValueBefore, pf.shownValue)
          || field.projectionStatus !== pf.status || !same(field.candidate, pf.candidate)
          || !same(field.rawEvidence, pf.rawEvidence) || !same(field.correctionReason, pf.correctionReason)
          || !same(field.riskReasons, pf.riskReasons) || field.masterVersion !== pf.masterVersion
          || field.masterVersion !== completion.registryVersion) throw new Error("completion_field_provenance");
      if (!METHODS.has(field.verificationMethod)) throw Object.assign(new Error("unknown_review_method"), { code: "NON_HUMAN_REVIEW" });
      const isNumeric = NUMERIC_FIELDS.has(name);
      const shown = field.shownValueBefore; const final = field.finalValue;
      if (shown !== null && (isNumeric ? typeof shown !== "number" || !Number.isSafeInteger(shown) || shown < minFor(name) : typeof shown !== "string")) throw new Error("shown_value_type");
      let method;
      if (field.verificationMethod === "USER_MARKED_UNKNOWN") {
        if (final !== null) throw new Error("unknown_method_value_mismatch");
        unknown += 1; method = "UNKNOWN";
      } else if (field.verificationMethod === "USER_BATCH_CONFIRMED_UNCHANGED") {
        if (final === null || typeof shown !== typeof final || !same(shown, final)) throw new Error("unchanged_method_value_mismatch");
        unchanged += 1; method = "KNOWN";
      } else {
        if (final === null || typeof shown === typeof final && same(shown, final)) throw new Error("edited_method_value_mismatch");
        edited += 1; method = "KNOWN";
      }
      if (!Array.isArray(field.riskReasons) || !Array.isArray(field.correctionReason)) throw new Error("completion_field_risk_shape");
      if (field.riskReasons.length || ["AMBIGUOUS", "UNMATCHED", "MASTER_DISAGREEMENT"].includes(field.projectionStatus)) risky += 1;
      const reasons = [];
      if (method === "UNKNOWN") reasons.push(rowReason(REASONS.UNKNOWN_FIELD, name, null));
      else if (isNumeric) {
        if (typeof final !== "number" || !Number.isSafeInteger(final) || final < minFor(name)) reasons.push(rowReason(REASONS.INVALID_NUMERIC, name, { minimum: minFor(name) }));
      } else if (!isValidText(final, name !== "island")) reasons.push(rowReason(REASONS.INVALID_TEXT, name, { rule: "EXACT_BOUNDED_TEXT" }));
      fieldResults[name] = { field, reasons };
    }
    const projectedSources = accounting.sourceByLogical.get(reviewed.projectionRowId);
    if (!projectedSources || !projectedSources.length) throw new Error("logical_row_without_source");
    validated.push({ reviewed, projected, fields: fieldResults, index: i });
  }
  const summary = completion.summary;
  const expectedSummary = { rowCount: completion.rows.length, fieldCount: completion.rows.length * 6,
    unchangedFieldCount: unchanged, editedFieldCount: edited, unknownFieldCount: unknown, riskFieldCount: risky, edgeSegmentCount: completion.edgeSegments.length };
  if (!exactKeys(summary, Object.keys(expectedSummary)) || Object.entries(expectedSummary).some(([key, value]) => summary[key] !== value)) throw new Error("completion_summary_mismatch");
  return validated;
}

function eligibleNames(snapshot, kind, predicate) {
  const entities = new Map(snapshot.entities.map((entity) => [entity.stableId, entity]));
  return snapshot.legacyNames.filter((name) => (!kind || name.kind === kind) && predicate(name)).map((name) => ({ name, entity: name.stableId === null ? null : entities.get(name.stableId) ?? null }));
}

function allowedExactRecord(record) {
  const { name, entity } = record;
  if (["DISPUTED", "DEPRECATED"].includes(name.authorityStatus)) return false;
  if (name.stableId !== null && (!entity || !["VERIFIED", "LEGACY_UNVERIFIED"].includes(entity.status)
      || entity.replacedBy !== null && entity.replacedBy !== undefined)) return false;
  return true;
}
function allowedVerifiedRecord(record) { return allowedExactRecord(record) && record.entity?.status === "VERIFIED"; }

function scopeMatches(name, scope) { return name.occurrences.some((o) => o.scope === scope); }
function recordContext(name, context) {
  if (context.kind && name.kind !== context.kind) return false;
  if (context.kinds && !context.kinds.includes(name.kind)) return false;
  if (context.tier !== undefined && name.tier !== context.tier) return false;
  return !context.scope || scopeMatches(name, context.scope);
}

function mappingEvidence(humanValue, record, method, registryVersion, context, verifiedNameEvidence = null) {
  const name = record?.name ?? null; const entity = record?.entity ?? null;
  return {
    humanValue, mappedValue: method === "NO_SAFE_MAPPING" ? null : name?.rawName ?? humanValue,
    mappingMethod: method, registryVersion,
    stableId: name?.stableId ?? null, legacyNameKey: name?.legacyNameKey ?? null,
    authorityStatus: method === "OPEN_WORLD_HUMAN_CONFIRMED" ? "OPEN_WORLD" : entity?.status ?? name?.authorityStatus ?? null,
    kind: name?.kind ?? context.kind ?? null, tier: name?.tier ?? (context.tier ?? null),
    scope: context.scope ?? name?.occurrences?.find((o) => o.scope)?.scope ?? null,
    sourceLocators: name?.occurrences?.filter((o) => !context.scope || o.scope === context.scope).map((o) => o.locator) ?? [],
    verifiedNameEvidence: verifiedNameEvidence ? cloneJson(verifiedNameEvidence) : null,
    ...(entity ? {} : {}),
  };
}

function mapHuman(snapshot, registryVersion, human, context, projectionStatus) {
  if (!isValidText(human, context.field !== "island")) return { evidence: { humanValue: human, mappedValue: null, mappingMethod: "NO_SAFE_MAPPING", registryVersion,
    stableId: null, legacyNameKey: null, authorityStatus: null, kind: context.kind ?? null, tier: context.tier ?? null,
    scope: context.scope ?? null, sourceLocators: [], verifiedNameEvidence: null }, reasons: [rowReason(REASONS.INVALID_TEXT, context.field, { rule: "EXACT_BOUNDED_TEXT" })] };
  if (context.openWorld) {
    return { evidence: { humanValue: human, mappedValue: human, mappingMethod: "OPEN_WORLD_HUMAN_CONFIRMED", registryVersion,
      stableId: null, legacyNameKey: null, authorityStatus: "OPEN_WORLD", kind: null, tier: null, scope: null, sourceLocators: [], verifiedNameEvidence: null }, reasons: [] };
  }
  const records = eligibleNames(snapshot, context.kind ?? null, (name) => recordContext(name, context));
  const exact = records.filter((record) => record.name.rawName === human);
  const verifiedRoutes = [];
  const entities = new Map(snapshot.entities.map((entity) => [entity.stableId, entity]));
  for (const entity of snapshot.entities) {
    if (entity.status !== "VERIFIED" || entity.replacedBy !== null && entity.replacedBy !== undefined) continue;
    for (const [listName, nameType] of [["displayNames", "DISPLAY_NAME"], ["aliases", "ALIAS"]]) {
      for (const term of entity[listName] ?? []) {
        if (term.status !== "VERIFIED" || term.text !== human) continue;
        const linked = records.filter((record) => record.name.stableId === entity.stableId && allowedVerifiedRecord(record));
        for (const record of linked) verifiedRoutes.push({ record, evidence: { nameType, text: term.text, status: term.status, provenance: cloneJson(term.provenance) } });
      }
    }
  }
  const validExact = exact.filter(allowedExactRecord);
  const deniedExact = exact.filter((record) => !allowedExactRecord(record));
  if (deniedExact.length && (validExact.length || verifiedRoutes.length)) {
    return { evidence: mappingEvidence(human, null, "NO_SAFE_MAPPING", registryVersion, context), reasons: [rowReason(REASONS.AMBIGUOUS_MAPPING, context.field, { candidateCount: deniedExact.length + validExact.length + verifiedRoutes.length })] };
  }
  if (!validExact.length && !verifiedRoutes.length) {
    if (deniedExact.length || projectionStatus === "MASTER_DISAGREEMENT") {
      return { evidence: mappingEvidence(human, null, "NO_SAFE_MAPPING", registryVersion, context), reasons: [rowReason(REASONS.MASTER_DISAGREEMENT_UNRESOLVED, context.field, null)] };
    }
    return { evidence: mappingEvidence(human, null, "NO_SAFE_MAPPING", registryVersion, context), reasons: [rowReason(REASONS.UNRESOLVED_MAPPING, context.field, null)] };
  }
  const routes = [
    ...validExact.map((record) => ({ record, method: "EXACT_LEGACY_NAME", verified: null })),
    ...verifiedRoutes.map((route) => ({ record: route.record, method: "VERIFIED_ENTITY_COMPATIBILITY", verified: route.evidence })),
  ];
  const uniqueRoutes = unique(routes.map((route) => ({
    key: [route.record.name.stableId, route.record.name.legacyNameKey, route.record.name.rawName, route.method, route.verified?.nameType ?? null],
    route,
  }))).map((item) => item.route);
  const semantic = new Map(uniqueRoutes.map((route) => [`${route.record.name.stableId ?? "null"}\0${route.record.name.legacyNameKey}\0${route.record.name.rawName}`, route]));
  const stableIds = new Set([...semantic.values()].map((route) => route.record.name.stableId ?? null));
  const tokens = new Set([...semantic.values()].map((route) => route.record.name.rawName));
  if (semantic.size !== 1 || stableIds.size !== 1 || tokens.size !== 1) {
    return { evidence: mappingEvidence(human, null, "NO_SAFE_MAPPING", registryVersion, context), reasons: [rowReason(REASONS.AMBIGUOUS_MAPPING, context.field, { candidateCount: semantic.size })] };
  }
  const selected = [...semantic.values()][0];
  // If the same exact legacy record is reachable through a verified spelling, retain exact raw authority.
  const exactSelected = validExact.find((record) => record.name.legacyNameKey === selected.record.name.legacyNameKey);
  if (exactSelected) return { evidence: mappingEvidence(human, exactSelected, "EXACT_LEGACY_NAME", registryVersion, context), reasons: [] };
  return { evidence: mappingEvidence(human, selected.record, selected.method, registryVersion, context, selected.verified), reasons: [] };
}

function mapRow(row, snapshot, registryVersion) {
  const human = Object.fromEntries(FIELDS.map((key) => [key, row.fields[key].field.finalValue]));
  const evidence = {}; const reasons = [];
  const toProjection = row.projected.fields.toItem;
  const toContext = { field: "toItem", kinds: ["MASTER_ITEM", "SPECIAL_ITEM"] };
  const toUnknown = row.fields.toItem.field.verificationMethod === "USER_MARKED_UNKNOWN";
  const to = toUnknown
    ? { evidence: mappingEvidence(human.toItem, null, "NO_SAFE_MAPPING", registryVersion, toContext), reasons: [] }
    : mapHuman(snapshot, registryVersion, human.toItem, toContext, toProjection.status);
  evidence.toItem = to.evidence; reasons.push(...to.reasons);
  let outputKind = to.evidence.kind; let outputTier = to.evidence.tier;
  if (!toUnknown && !to.reasons.length && !(outputKind === "MASTER_ITEM" && Number.isInteger(outputTier) && outputTier >= 1 && outputTier <= 7)
      && outputKind !== "SPECIAL_ITEM") reasons.push(rowReason(REASONS.UNRESOLVED_MAPPING, "toItem", { kind: outputKind, tier: outputTier }));
  const islandScope = outputKind === "MASTER_ITEM" && outputTier === 6 ? "T6_ISLANDS"
    : outputKind === "MASTER_ITEM" && outputTier === 7 ? "T7_ISLANDS" : "GENERAL_ISLANDS";
  const dependencyUnresolved = to.reasons.length > 0 || !((outputKind === "MASTER_ITEM" && Number.isInteger(outputTier) && outputTier >= 1 && outputTier <= 7) || outputKind === "SPECIAL_ITEM");
  const islandUnknown = row.fields.island.field.verificationMethod === "USER_MARKED_UNKNOWN";
  const island = islandUnknown
    ? { evidence: mappingEvidence(human.island, null, "NO_SAFE_MAPPING", registryVersion, { field: "island", kind: "ISLAND" }), reasons: [] }
    : dependencyUnresolved
    ? { evidence: mappingEvidence(human.island, null, "NO_SAFE_MAPPING", registryVersion, { field: "island", kind: "ISLAND", scope: null }), reasons: [rowReason(REASONS.UNRESOLVED_MAPPING, "island", { reason: "TO_ITEM_DEPENDENCY_UNRESOLVED" })] }
    : mapHuman(snapshot, registryVersion, human.island, { field: "island", kind: "ISLAND", scope: islandScope }, row.projected.fields.island.status);
  evidence.island = island.evidence; reasons.push(...island.reasons);
  let fromContext;
  if (outputKind === "MASTER_ITEM" && outputTier === 1) fromContext = { field: "fromItem", openWorld: true };
  else if (outputKind === "MASTER_ITEM" && Number.isInteger(outputTier) && outputTier >= 2 && outputTier <= 7) fromContext = { field: "fromItem", kind: "MASTER_ITEM", tier: outputTier - 1 };
  else if (outputKind === "SPECIAL_ITEM") fromContext = { field: "fromItem", kind: null, specialPool: true };
  else fromContext = { field: "fromItem", kind: null };
  let from;
  if (row.fields.fromItem.field.verificationMethod === "USER_MARKED_UNKNOWN") from = { evidence: mappingEvidence(human.fromItem, null, "NO_SAFE_MAPPING", registryVersion, fromContext), reasons: [] };
  else if (fromContext.openWorld) from = mapHuman(snapshot, registryVersion, human.fromItem, fromContext, row.projected.fields.fromItem.status);
  else if (fromContext.specialPool) from = mapSpecialPool(snapshot, registryVersion, human.fromItem, row.projected.fields.fromItem.status);
  else if (fromContext.kind) from = mapHuman(snapshot, registryVersion, human.fromItem, fromContext, row.projected.fields.fromItem.status);
  else from = { evidence: mappingEvidence(human.fromItem, null, "NO_SAFE_MAPPING", registryVersion, fromContext), reasons: [rowReason(REASONS.UNRESOLVED_MAPPING, "fromItem", { reason: "TO_ITEM_DEPENDENCY_UNRESOLVED" })] };
  evidence.fromItem = from.evidence; reasons.push(...from.reasons);

  for (const key of ["reqAmount", "count", "yield"]) {
    const field = row.fields[key];
    reasons.push(...field.reasons);
  }
  const dto = {
    island: evidence.island.mappedValue, fromItem: evidence.fromItem.mappedValue,
    reqAmount: human.reqAmount, toItem: evidence.toItem.mappedValue, count: human.count, yield: human.yield,
  };
  return { human, evidence, dto, reasons: unique(reasons) };
}

function mapSpecialPool(snapshot, registryVersion, human, projectionStatus) {
  if (!isValidText(human, true)) return mapHuman(snapshot, registryVersion, human, { field: "fromItem", kind: "SPECIAL_ITEM" }, projectionStatus);
  const all = [];
  const failures = [];
  for (const kind of ["MASTER_ITEM", "SPECIAL_ITEM"]) {
    const result = mapHuman(snapshot, registryVersion, human, { field: "fromItem", kind }, projectionStatus);
    if (!result.reasons.length) all.push(result);
    else failures.push(...result.reasons);
  }
  const routes = unique(all.map((item) => [item.evidence.stableId, item.evidence.legacyNameKey, item.evidence.mappedValue]));
  if (all.length && failures.some((reason) => reason.code === REASONS.MASTER_DISAGREEMENT_UNRESOLVED)) {
    const evidence = { humanValue: human, mappedValue: null, mappingMethod: "NO_SAFE_MAPPING", registryVersion,
      stableId: null, legacyNameKey: null, authorityStatus: null, kind: null, tier: null, scope: null, sourceLocators: [], verifiedNameEvidence: null };
    return { evidence, reasons: [rowReason(REASONS.AMBIGUOUS_MAPPING, "fromItem", null)] };
  }
  if (routes.length === 1) return all[0];
  const context = { field: "fromItem", kind: null, specialPool: true };
  const evidence = { humanValue: human, mappedValue: null, mappingMethod: "NO_SAFE_MAPPING", registryVersion,
    stableId: null, legacyNameKey: null, authorityStatus: null, kind: null, tier: null, scope: null, sourceLocators: [], verifiedNameEvidence: null };
  const code = routes.length ? REASONS.AMBIGUOUS_MAPPING
    : failures.some((reason) => reason.code === REASONS.MASTER_DISAGREEMENT_UNRESOLVED)
      ? REASONS.MASTER_DISAGREEMENT_UNRESOLVED : REASONS.UNRESOLVED_MAPPING;
  return { evidence, reasons: [rowReason(code, "fromItem", null)] };
}

function collisionAnalysis(rows) {
  const valid = rows.filter((row) => row.reasons.length === 0);
  const edges = [];
  for (let i = 0; i < valid.length; i += 1) for (let j = i + 1; j < valid.length; j += 1) {
    const a = valid[i]; const b = valid[j]; const reasons = [];
    if (a.dto.island === b.dto.island && a.dto.toItem === b.dto.toItem && a.dto.fromItem !== b.dto.fromItem) reasons.push({ type: "INPUT_CONFLICT", code: REASONS.INPUT_CONFLICT, fields: ["fromItem"] });
    if (a.dto.island === b.dto.island && a.dto.fromItem === b.dto.fromItem && a.dto.toItem === b.dto.toItem) {
      const differing = ["reqAmount", "count", "yield"].filter((key) => a.dto[key] !== b.dto[key]);
      if (differing.length) reasons.push({ type: "NUMERIC_CONFLICT", code: REASONS.NUMERIC_CONFLICT, fields: differing });
    }
    for (const reason of reasons) edges.push({ a, b, ...reason });
  }
  const parent = new Map(valid.map((row) => [row.reviewed.projectionRowId, row.reviewed.projectionRowId]));
  const find = (id) => { let x = id; while (parent.get(x) !== x) x = parent.get(x); return x; };
  for (const edge of edges) { const a = find(edge.a.reviewed.projectionRowId); const b = find(edge.b.reviewed.projectionRowId); if (a !== b) parent.set(b, a); }
  const components = new Map();
  for (const row of valid) { const root = find(row.reviewed.projectionRowId); const list = components.get(root) ?? []; list.push(row); components.set(root, list); }
  const groups = []; const heldIds = new Set();
  for (const members of components.values()) {
    const memberIds = members.map((row) => row.reviewed.projectionRowId);
    const memberEdges = edges.filter((edge) => memberIds.includes(edge.a.reviewed.projectionRowId) && memberIds.includes(edge.b.reviewed.projectionRowId));
    if (!memberEdges.length) continue;
    for (const row of members) {
      const own = memberEdges.filter((edge) => edge.a === row || edge.b === row);
      row.reasons.push(...unique(own.map((edge) => rowReason(edge.code, edge.fields.length === 1 ? edge.fields[0] : null,
        { relatedProjectionRowIds: [edge.a, edge.b].filter((item) => item !== row).map((item) => item.reviewed.projectionRowId) }))));
      heldIds.add(row.reviewed.projectionRowId);
    }
    for (const type of unique(memberEdges.map((edge) => edge.type))) {
      const related = memberEdges.filter((edge) => edge.type === type);
      const ids = unique(related.flatMap((edge) => [edge.a.reviewed.projectionRowId, edge.b.reviewed.projectionRowId]));
      const fields = unique(related.flatMap((edge) => edge.fields));
      groups.push({ conflictGroupId: `${type.toLowerCase()}:${Math.min(...members.map((r) => r.index))}`,
        type, projectionRowIds: ids, differingFields: fields,
        alternatives: members.filter((r) => ids.includes(r.reviewed.projectionRowId)).map((r) => ({
          projectionRowId: r.reviewed.projectionRowId, dto: cloneJson(r.dto), humanFinalValues: cloneJson(r.human), sourceRefs: cloneJson(r.reviewed.sourceRefs),
        })), status: "ACTIVE" });
    }
  }
  return { groups, heldIds };
}

function mappingRow(row, snapshot, registryVersion) {
  const mapped = mapRow(row, snapshot, registryVersion);
  row.human = mapped.human; row.mappingEvidence = mapped.evidence; row.dto = mapped.dto;
  row.reasons.push(...mapped.reasons);
  row.reasons = unique(row.reasons);
  row.initialReasons = cloneJson(row.reasons);
  return row;
}

function makeMember(row, observationRef) {
  return {
    projectionRowId: row.reviewed.projectionRowId, sourceRefs: cloneJson(row.reviewed.sourceRefs),
    humanFinalValues: cloneJson(row.human), reviewFields: cloneJson(row.reviewed.fields),
    mappingEvidence: cloneJson(row.mappingEvidence), reconciliationProvenance: cloneJson(row.projected.reconciliationGroupId ? {
      reconciliationGroupId: row.projected.reconciliationGroupId, status: row.projected.reconciliationStatus,
      reconciliationMembers: row.projected.reconciliationMembers,
      sourceToLogical: row.projected.projectionReconciliationSourceMap ?? null,
    } : null), observationRef: cloneJson(observationRef),
  };
}

function outputRow(members, observationRef) {
  const first = members[0];
  const sourceRefs = unique(members.flatMap((row) => row.reviewed.sourceRefs));
  const memberObservations = members.map((row) => makeMember(row, observationRef));
  return {
    projectionRowId: first.reviewed.projectionRowId,
    memberProjectionRowIds: members.map((row) => row.reviewed.projectionRowId),
    sourceRefs, humanFinalValues: cloneJson(first.human), dto: cloneJson(first.dto),
    mappingEvidence: cloneJson(first.mappingEvidence), observationRefs: [cloneJson(observationRef)], memberObservations,
  };
}

function heldOutput(row, observationRef) {
  return {
    projectionRowId: row.reviewed.projectionRowId, sourceRefs: cloneJson(row.reviewed.sourceRefs),
    humanFinalValues: cloneJson(row.human), reviewFields: cloneJson(row.reviewed.fields),
    mappingEvidence: cloneJson(row.mappingEvidence), reconciliationProvenance: cloneJson(row.projected.reconciliationGroupId ? {
      reconciliationGroupId: row.projected.reconciliationGroupId, status: row.projected.reconciliationStatus,
      reconciliationMembers: row.projected.reconciliationMembers,
    } : null), observationRef: cloneJson(observationRef), heldReasons: unique(row.reasons),
  };
}

function buildSemanticOutput({ observation, expectedReview, policyVersion, sourceCount, rows, edgeSegments, exclusions, initialConflicts, batchErrors, mappingPolicyVersion = policyVersion, observationRefOverride = null }) {
  const observationRef = observationRefOverride ? cloneJson(observationRefOverride) : observation ? {
    observationId: observation.observationId, mutationId: observation.mutationId,
    payloadHash: observation.payloadHash, observationHash: observation.observationHash,
    persistedAt: observation.persistedAt, hashBasis: observation.hashBasis,
  } : null;
  const exclusionMap = new Map(exclusions.map((entry) => [entry.projectionRowId, entry]));
  const initialById = new Map(rows.map((row) => [row.reviewed.projectionRowId, row]));
  const initialHeldIds = new Set(rows.filter((row) => row.reasons.length).map((row) => row.reviewed.projectionRowId));
  const excluded = [];
  for (const [id, decision] of exclusionMap) {
    const row = initialById.get(id);
    if (!row) continue;
    excluded.push({ ...heldOutput(row, observationRef), decision: cloneJson(decision) });
  }
  const eligible = rows.filter((row) => !exclusionMap.has(row.reviewed.projectionRowId));
  for (const row of eligible) row.reasons = cloneJson(row.initialReasons ?? []);
  const residual = collisionAnalysis(eligible);
  const remaining = [];
  for (const row of eligible) {
    const addedConflictReasons = row.reasons.filter((r) => r.code === REASONS.INPUT_CONFLICT || r.code === REASONS.NUMERIC_CONFLICT);
    const ownReasons = row.reasons.filter((r) => r.code !== REASONS.INPUT_CONFLICT && r.code !== REASONS.NUMERIC_CONFLICT);
    const reasons = unique([...ownReasons, ...addedConflictReasons]);
    if (reasons.length) { row.reasons = reasons; remaining.push(row); }
  }
  const initialGroups = initialConflicts.map((group) => {
    const current = residual.groups.find((item) => item.type === group.type && item.projectionRowIds.some((id) => group.projectionRowIds.includes(id)));
    if (current) return { ...group, status: "ACTIVE", remainingProjectionRowIds: current.projectionRowIds,
      excludedProjectionRowIds: group.projectionRowIds.filter((id) => exclusionMap.has(id)) };
    const excludedIds = group.projectionRowIds.filter((id) => exclusionMap.has(id));
    return excludedIds.length ? { ...group, status: "RESOLVED_BY_EXCLUSION", excludedProjectionRowIds: excludedIds } : group;
  });
  const conflicts = [...initialGroups];
  for (const group of residual.groups) {
    if (!conflicts.some((old) => old.type === group.type && old.projectionRowIds.join("\0") === group.projectionRowIds.join("\0"))) conflicts.push(group);
  }
  const heldRows = remaining.map((row) => heldOutput(row, observationRef));
  const unheld = eligible.filter((row) => !remaining.includes(row));
  const duplicateGroups = []; const deduped = new Map();
  for (const row of unheld) {
    const key = stable(FIELDS.map((field) => row.dto[field]));
    const members = deduped.get(key) ?? []; members.push(row); deduped.set(key, members);
  }
  const outputRows = [];
  for (const members of deduped.values()) {
    if (members.length > 1) duplicateGroups.push({ duplicateGroupId: `dto-duplicate:${members[0].index}`,
      basis: "MAPPED_EXACT6", memberProjectionRowIds: members.map((r) => r.reviewed.projectionRowId),
      representativeProjectionRowId: members[0].reviewed.projectionRowId });
    outputRows.push(outputRow(members, observationRef));
  }
  outputRows.sort((a, b) => initialById.get(a.projectionRowId).index - initialById.get(b.projectionRowId).index);
  const validRowCount = unheld.length;
  const heldRowCount = heldRows.length;
  const excludedCount = excluded.length;
  const reviewedCount = rows.length;
  const initialHeldRowCount = initialHeldIds.size;
  const status = batchErrors.length || heldRowCount ? "NOT_READY" : outputRows.length === 0 ? "EMPTY" : "READY";
  const unknownRowCount = rows.filter((row) => row.reasons.some((reason) => reason.code === REASONS.UNKNOWN_FIELD)).length;
  const invalidRowCount = rows.filter((row) => row.reasons.some((reason) => [REASONS.INVALID_TEXT, REASONS.INVALID_NUMERIC].includes(reason.code))).length;
  const output = {
    schemaVersion: 1, status, observationRef: cloneJson(observationRef), expectedReview: expectedReview ? cloneJson(expectedReview) : null,
    projectionHash: observation?.completion?.projectionHash ?? null, registryVersion: observation?.completion?.registryVersion ?? null,
    mappingPolicyVersion,
    rows: outputRows, heldRows, excludedRows: excluded, duplicateGroups, conflictGroups: conflicts,
    batchErrors: cloneJson(batchErrors),
    summary: { reviewedRowCount: reviewedCount, validRowCount, heldRowCount, explicitlyExcludedRowCount: excludedCount,
      outputRowCount: outputRows.length, initialHeldRowCount },
    coverage: { sourceCompleteRowCount: sourceCount, logicalReviewedRowCount: reviewedCount, unknownRowCount,
      invalidRowCount, excludedRowCount: excludedCount, duplicateCollapsedRowCount: validRowCount - outputRows.length,
      edgeSegmentCount: edgeSegments.length, fullGameCoverageClaim: false },
    provenance: { reviewMode: observation?.completion?.reviewMode ?? null,
      correctionVersion: observation?.completion?.correctionVersion ?? null, reviewRevision: observation?.completion?.reviewRevision ?? null,
      confirmationRevision: observation?.confirmationRevision ?? null,
      reconciliation: observation?.projection?.reconciliation ?? observation?.sourceContext?.projection?.snapshot?.reconciliation ?? null,
      edgeSegments: cloneJson(edgeSegments) },
    hashBasis: HASH_BASIS,
  };
  return finish(output);
}

function exclusionsFor(rows, exclusions, batchErrors) {
  if (!Array.isArray(exclusions) || exclusions.length > 1000) { batchErrors.push(batchError("INVALID_EXCLUSION", "exclusions_not_array_or_too_many")); return []; }
  const byId = new Map(rows.map((row) => [row.reviewed.projectionRowId, row]));
  const seen = new Set(); const accepted = [];
  for (const entry of exclusions) {
    if (!exactKeys(entry, ["projectionRowId", "action", "reason"]) || !nonempty(entry.projectionRowId)
        || entry.action !== "EXCLUDE_FROM_FINAL_DTO" || entry.reason !== "USER_EXPLICIT_EXCLUSION"
        || seen.has(entry.projectionRowId)) { batchErrors.push(batchError("INVALID_EXCLUSION", "malformed_or_duplicate_decision")); continue; }
    seen.add(entry.projectionRowId);
    const row = byId.get(entry.projectionRowId);
    if (!row || row.reasons.length === 0) { batchErrors.push(batchError("INVALID_EXCLUSION", "target_not_initially_held")); continue; }
    accepted.push(cloneJson(entry));
  }
  accepted.sort((a, b) => byId.get(a.projectionRowId).index - byId.get(b.projectionRowId).index);
  return accepted;
}

function prepareRows(validated, snapshot, registryVersion) {
  return validated.map((row) => mappingRow({ ...row, reasons: row.fields ? Object.values(row.fields).flatMap((field) => field.reasons) : [] }, snapshot, registryVersion));
}

function validateObservation(input, policyVersion) {
  let observation;
  try { observation = cloneJson(input.storedObservation, "storedObservation"); }
  catch { return emptyResult("INVALID_OBSERVATION", "stored_observation_not_json", policyVersion); }
  if (new TextEncoder().encode(stable(observation)).length > 8 * 1024 * 1024) return emptyResult("INVALID_OBSERVATION", "stored_observation_too_large", policyVersion);
  let receipt; let expected;
  try {
    receipt = cloneJson(input.evidenceReceipt, "evidenceReceipt");
    expected = cloneJson(input.expectedReview, "expectedReview");
  } catch { return emptyResult("INVALID_OBSERVATION", "review_binding_not_json", policyVersion); }
  const batchErrors = [];
  try { validateBaseObservation(observation); }
  catch { return emptyResult("INVALID_OBSERVATION", "stored_observation_shape", policyVersion); }
  const receiptError = compareReceipt(observation, receipt);
  if (receiptError) batchErrors.push(receiptError);
  const expectedError = compareExpected(observation, expected);
  if (expectedError) batchErrors.push(expectedError);
  let authority;
  try { authority = projectionAndRegistry(observation); }
  catch { return emptyResult("INVALID_OBSERVATION", "frozen_projection_or_registry_invalid", policyVersion); }
  const edgeSegments = observation.completion.edgeSegments;
  let captureData; let accounting;
  try {
    captureData = captureIndex(authority.source);
    if (!same(edgeSegments, authority.source.recognition.captureEvidence.edgeSegments)) throw new Error("edge_evidence_mismatch");
    if (authority.projection.schemaVersion === 1) accounting = validateLegacyProjection(authority.projection, authority.completion, captureData.byId);
    else accounting = validateFinalReconciliation(authority.projection, authority.completion, captureData.byId);
  } catch { return emptyResult("INVALID_OBSERVATION", "source_accounting_invalid", policyVersion); }
  let validated;
  try { validated = validateCompletionRows(authority.projection, authority.completion, captureData, accounting); }
  catch (error) {
    const code = error.code === "NON_HUMAN_REVIEW" ? error.code : "INVALID_OBSERVATION";
    return emptyResult(code, "completion_review_contract_invalid", policyVersion);
  }
  const mapped = prepareRows(validated, authority.snapshot, authority.snapshot.registryVersion);
  return { observation, authority, edgeSegments, accounting, rows: mapped, batchErrors };
}

const POLICY_V3 = "reviewed-trade-dto-mapping-v3";
const MASTER_BINDING_KEYS = ["masterSchemaVersion", "registryVersion", "contentHash", "hashBasis"];
const V3_EXPECTED_KEYS = ["schemaVersion", "recognitionBatchId", "projectionHash", "reviewRevision", "masterBinding", "correctionVersion", "completionValuesHash", "pixelAvailability"];
const V3_RECEIPT_KEYS = ["schemaVersion", "observationId", "mutationId", "payloadHash", "observationHash", "persistedAt", "duplicate", "evidenceSaved", "sessionApplied", "reviewMode", "projectionHash", "masterBinding", "reviewRevision", "cropPolicy"];
const OBSERVATION3_KEYS = ["schemaVersion", "reviewMode", "mutationId", "createdAt", "confirmationRevision", "supersedesObservationId", "projection", "completion", "sourceContext", "cropPlan", "observationId", "persistedAt", "hashBasis", "payloadHash", "observationHash"];
const CROP_POLICY_V3 = "C2_LOGICAL_REPRESENTATIVE_V3";

function sameBinding(left, right) { return exactKeys(left, MASTER_BINDING_KEYS) && exactKeys(right, MASTER_BINDING_KEYS) && same(left, right); }
function timestamp(value) { return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value)); }
function bundleStatusToV1(status) { return status === "VERIFIED_CURATED" ? "VERIFIED" : status; }

function candidateIdentityMatchesPinnedMapping(identity, mapping) {
  if (identity === null) return true;
  const kindMatches = identity.kind === "ISLAND"
    ? mapping.kind === "ISLAND"
    : identity.kind === "ITEM" && ["MASTER_ITEM", "SPECIAL_ITEM", null].includes(mapping.kind);
  return kindMatches && identity.stableId === mapping.stableId
    && identity.legacyNameKey === mapping.legacyNameKey
    && bundleStatusToV1(identity.authorityStatus) === mapping.authorityStatus;
}

// Build a read-only R008 mapping view from the Bundle2 snapshot pinned by Observation3.
// It translates vocabulary only; it never fetches the active Master or performs name similarity matching.
function registryViewFromBundle2(bundle) {
  const validation = validateMasterBundleV2(bundle);
  if (!validation.ok || masterBundleContentHash(bundle) !== bundle.contentHash) throw new Error("master_bundle_integrity");
  const names = [];
  const entities = bundle.entities.map((entity) => {
    const legacyNames = entity.legacyNames.map((record) => {
      names.push({ ...record, kind: record.legacyKind, stableId: entity.stableId, authorityStatus: bundleStatusToV1(record.authorityStatus) });
      return record.legacyNameKey;
    });
    const nameKinds = new Set(entity.legacyNames.map((record) => record.legacyKind));
    if (nameKinds.size > 1 && [...nameKinds].some((kind) => kind === "ISLAND") !== (entity.kind === "ISLAND")) throw new Error("master_entity_kind_mismatch");
    const displayNames = entity.displayNames.map((entry) => ({ ...entry, status: bundleStatusToV1(entry.status) }));
    const aliases = entity.aliases.map((entry) => ({ ...entry, status: bundleStatusToV1(entry.status) }));
    const status = bundleStatusToV1(entity.status);
    return { stableId: entity.stableId, kind: entity.kind === "ISLAND" ? "ISLAND" : (entity.legacyNames[0]?.legacyKind ?? "MASTER_ITEM"),
      canonicalName: entity.canonicalName, status, displayNames, aliases, provenance: entity.provenance, replacedBy: entity.replacedBy,
      legacyNameKeys: legacyNames };
  });
  for (const record of bundle.unresolvedLegacyNames) names.push({ ...record, kind: record.legacyKind, stableId: null, authorityStatus: "LEGACY_UNVERIFIED" });
  const byKey = new Map();
  for (const record of names) {
    if (byKey.has(record.legacyNameKey)) throw new Error("master_legacy_name_duplicate");
    byKey.set(record.legacyNameKey, record);
  }
  const legacyNames = [...byKey.values()];
  const unresolvedMappings = legacyNames.filter((name) => name.stableId === null).map((name) => ({ legacyNameKey: name.legacyNameKey }));
  return { schemaVersion: 1, registryVersion: bundle.registryVersion, source: { revision: bundle.sourceRevisions[0]?.revision ?? "pinned-bundle2", sha256: bundle.contentHash },
    curation: { revision: null }, legacyNames, entities, unresolvedMappings,
    compatibilityMappings: bundle.compatibilityMappings.map((mapping) => ({ ...mapping })), findings: [] };
}

function projectionInputFromV3(projection) {
  return { recognitionBatchId: projection.recognitionBatchId, rawEvidenceHash: projection.rawEvidenceHash, masterBinding: projection.masterBinding,
    correctionVersion: projection.correctionVersion, reconciliation: projection.reconciliation, pixelAvailability: projection.pixelAvailability,
    rows: projection.rows, edgeWorkItems: projection.edgeWorkItems };
}

function completionInputFromV3(projection, completion) {
  return { projection, reviewRevision: completion.reviewRevision, confirmedAt: completion.batchConfirmation?.confirmedAt,
    rows: completion.rows.map((row) => ({ projectionRowId: row.projectionRowId, sourceRefs: row.sourceRefs, disposition: row.disposition,
      dispositionReason: row.dispositionReason, fields: row.fields.map((field) => ({ field: field.field, finalValue: field.finalValue,
        unknown: field.operationalDecision === "USER_MARKED_UNKNOWN", ...(Object.hasOwn(field, "userEditReason") ? { userEditReason: field.userEditReason } : {}) })) })),
    workItems: completion.workItems };
}

function v3ObservationIntegrity(observation) {
  if (!exactKeys(observation, OBSERVATION3_KEYS) || observation.schemaVersion !== 3 || observation.reviewMode !== "FINAL_CORRECTED_RESULT"
      || !validUuid(observation.mutationId) || !validUuid(observation.observationId) || observation.confirmationRevision !== 1
      || !(observation.supersedesObservationId === null || validUuid(observation.supersedesObservationId))
      || !timestamp(observation.createdAt) || !timestamp(observation.persistedAt) || observation.hashBasis !== "TRADE_OBSERVATION_JSON_V3"
      || !validHash(observation.payloadHash) || !validHash(observation.observationHash)) throw new Error("observation3_shape");
  const projection = buildFinalProjection3(projectionInputFromV3(observation.projection));
  if (!same(projection, observation.projection)) throw new Error("projection3_hash_or_shape");
  const completion = observation.completion;
  if (!isRecord(completion) || !Array.isArray(completion.rows)) throw new Error("completion3_shape");
  const rebuiltCompletion = buildFinalReviewCompletion(completionInputFromV3(projection, completion));
  if (!same(rebuiltCompletion, completion)) throw new Error("completion3_hash_or_shape");
  const request = buildFinalReviewObservationRequest({ projection, completion, sourceContext: observation.sourceContext,
    mutationId: observation.mutationId, createdAt: observation.createdAt, supersedesObservationId: observation.supersedesObservationId });
  if (!same(request, Object.fromEntries(Object.entries(observation).filter(([key]) => !["observationId", "persistedAt", "hashBasis", "payloadHash", "observationHash"].includes(key))))) {
    throw new Error("observation3_request_mismatch");
  }
  if (registrySnapshotSha256(request) !== observation.payloadHash) throw new Error("observation3_payload_hash");
  const hashedRecord = { ...request, observationId: observation.observationId, persistedAt: observation.persistedAt, hashBasis: observation.hashBasis, payloadHash: observation.payloadHash };
  if (registrySnapshotSha256(hashedRecord) !== observation.observationHash) throw new Error("observation3_hash");
  return { projection, completion, request };
}

function compareReceipt3(observation, receipt) {
  if (!exactKeys(receipt, V3_RECEIPT_KEYS) || receipt.schemaVersion !== 3 || receipt.evidenceSaved !== true || receipt.sessionApplied !== false
      || typeof receipt.duplicate !== "boolean" || receipt.reviewMode !== "FINAL_CORRECTED_RESULT" || receipt.cropPolicy !== observation.cropPlan?.policy
      || receipt.cropPolicy !== CROP_POLICY_V3) return batchError("STALE_REVIEW", "receipt3_shape_or_save_state");
  const projection = observation.projection; const completion = observation.completion;
  if (receipt.observationId !== observation.observationId || receipt.mutationId !== observation.mutationId
      || receipt.payloadHash !== observation.payloadHash || receipt.observationHash !== observation.observationHash
      || receipt.persistedAt !== observation.persistedAt || receipt.projectionHash !== projection.projectionHash
      || receipt.reviewRevision !== completion.reviewRevision || !sameBinding(receipt.masterBinding, projection.masterBinding)) {
    return batchError("STALE_REVIEW", "receipt3_observation_binding");
  }
  return null;
}

function compareExpected3(observation, expected) {
  if (!exactKeys(expected, V3_EXPECTED_KEYS) || expected.schemaVersion !== 3) return batchError("STALE_REVIEW", "expected_review3_shape");
  const { projection, completion } = observation;
  const confirmation = completion.batchConfirmation;
  if (expected.recognitionBatchId !== projection.recognitionBatchId || expected.projectionHash !== projection.projectionHash
      || expected.reviewRevision !== completion.reviewRevision || expected.correctionVersion !== projection.correctionVersion
      || expected.completionValuesHash !== confirmation.completionValuesHash || !sameBinding(expected.masterBinding, projection.masterBinding)) {
    return batchError("STALE_REVIEW", "expected_review3_binding");
  }
  if (!Array.isArray(expected.pixelAvailability) || !same(expected.pixelAvailability, projection.pixelAvailability)) return batchError("STALE_REVIEW", "pixel_availability_stale");
  return null;
}

function v3ProjectedRow(row, projection, bundle, registryVersion, index) {
  const reviewed = observationForV3Field(row, projection);
  const projected = { projectionRowId: row.projectionRowId, captureId: row.captureId, ordinal: row.ordinal, sourceRefs: row.sourceRefs,
    reconciliationGroupId: row.reconciliationGroupId ?? null, reconciliationStatus: row.reconciliationStatus ?? null,
    reconciliationMembers: row.reconciliationMembers ?? null, fields: {} };
  for (const field of row.fields) {
    projected.fields[field.field] = { status: field.identity?.authorityStatus === "MASTER_DISAGREEMENT" ? "MASTER_DISAGREEMENT"
        : field.valueState === "CONFLICT" ? "AMBIGUOUS" : field.identity?.stableId ? "MATCHED" : "UNMATCHED",
      shownValue: field.finalValue, candidate: field.candidates?.[field.selectedCandidateIndex] ?? null,
      rawEvidence: field.rawEvidenceRefs, correctionReason: field.correctionReasons, riskReasons: field.riskReasons, masterVersion: registryVersion };
  }
  return { projected, reviewed, fields: Object.fromEntries(row.fields.map((field) => [field.field, { field: reviewed.fields.find((item) => item.field === field.field), reasons: [] }])),
    reasons: [], initialReasons: [], index };
}

function observationForV3Field(row, projection) {
  const complete = projection.completion.rows.find((item) => item.projectionRowId === row.projectionRowId);
  return { projectionRowId: row.projectionRowId, captureId: row.captureId, ordinal: row.ordinal, sourceRefs: row.sourceRefs,
    fields: complete.fields.map((field) => ({ field: field.field, shownValueBefore: field.shownValueBefore, finalValue: field.finalValue,
      verificationMethod: field.operationalDecision === "CANDIDATE_RETAINED" ? "USER_BATCH_CONFIRMED_UNCHANGED" : field.operationalDecision,
      projectionStatus: row.fields.find((item) => item.field === field.field).identity?.authorityStatus === "MASTER_DISAGREEMENT" ? "MASTER_DISAGREEMENT" : "MATCHED",
      candidate: null, rawEvidence: row.fields.find((item) => item.field === field.field).rawEvidenceRefs,
      correctionReason: row.fields.find((item) => item.field === field.field).correctionReasons,
      riskReasons: field.riskReasons, masterVersion: projection.masterBinding.registryVersion })) };
}

function validateObservation3(input, policyVersion) {
  let observation; let receipt; let expected;
  try {
    observation = cloneJson(input.storedObservation, "storedObservation");
    receipt = cloneJson(input.evidenceReceipt, "evidenceReceipt");
    expected = cloneJson(input.expectedReview, "expectedReview");
  } catch { return emptyResult("INVALID_OBSERVATION", "v3_input_not_json", policyVersion); }
  if (new TextEncoder().encode(stable(observation)).length > 8 * 1024 * 1024) return emptyResult("INVALID_OBSERVATION", "stored_observation_too_large", policyVersion);
  let verified;
  try { verified = v3ObservationIntegrity(observation); }
  catch { return emptyResult("INVALID_OBSERVATION", "stored_observation3_integrity", policyVersion); }
  const batchErrors = [];
  const receiptError = compareReceipt3(observation, receipt); if (receiptError) batchErrors.push(receiptError);
  const expectedError = compareExpected3(observation, expected); if (expectedError) batchErrors.push(expectedError);
  const projection = verified.projection; const completion = verified.completion; const bundle = observation.sourceContext.masterBundle.snapshot;
  let registry;
  try { registry = registryViewFromBundle2(bundle); }
  catch { return emptyResult("INVALID_OBSERVATION", "pinned_master_bundle2_invalid", policyVersion); }
  const evidence = observation.sourceContext.rawEvidence.snapshot;
  const sourceCount = projection.reconciliation.sourceRows.length;
  const edgeSegments = evidence.edgeSegments;
  const rows = projection.rows.map((row, index) => v3ProjectedRow(row, { ...projection, completion }, bundle, bundle.registryVersion, index));
  const rowById = new Map(completion.rows.map((row) => [row.projectionRowId, row]));
  for (const mapped of rows) {
    const source = projection.rows[mapped.index]; const completed = rowById.get(source.projectionRowId);
    const completionFields = new Map(completed.fields.map((field) => [field.field, field]));
    const reasons = [];
    if (["NEEDS_RECAPTURE", "CONFLICT"].includes(source.classification)) reasons.push(rowReason(source.classification === "NEEDS_RECAPTURE" ? "NEEDS_RECAPTURE" : "UNRESOLVED_CONFLICT", null, { classification: source.classification, reasons: source.classificationReasons }));
    if (completed.disposition === "RECAPTURE_REQUIRED") reasons.push(rowReason("NEEDS_RECAPTURE", null, { reason: completed.dispositionReason }));
    for (const field of source.fields) {
      const reviewed = completionFields.get(field.field);
      if (reviewed.operationalDecision === "USER_MARKED_UNKNOWN") reasons.push(rowReason(REASONS.UNKNOWN_FIELD, field.field, null));
      if (reviewed.operationalDecision !== "USER_MARKED_UNKNOWN" && NUMERIC_FIELDS.has(field.field) && (typeof reviewed.finalValue !== "number" || !Number.isSafeInteger(reviewed.finalValue) || reviewed.finalValue < minFor(field.field))) {
        reasons.push(rowReason(REASONS.INVALID_NUMERIC, field.field, { minimum: minFor(field.field) }));
      }
      if (reviewed.operationalDecision !== "USER_MARKED_UNKNOWN" && !NUMERIC_FIELDS.has(field.field) && !isValidText(reviewed.finalValue, field.field !== "island")) reasons.push(rowReason(REASONS.INVALID_TEXT, field.field, { rule: "EXACT_BOUNDED_TEXT" }));
      if (field.valueState === "CONFLICT" || field.identity?.authorityStatus === "MASTER_DISAGREEMENT") reasons.push(rowReason(field.valueState === "CONFLICT" ? REASONS.NUMERIC_CONFLICT : REASONS.MASTER_DISAGREEMENT_UNRESOLVED, field.field, null));
      const expectedKind = field.field === "island" ? "ISLAND" : field.field === "reqAmount" || NUMERIC_FIELDS.has(field.field) ? null : "ITEM";
      if (expectedKind && field.identity !== null && (!isRecord(field.identity) || ![expectedKind, expectedKind === "ITEM" ? "MASTER_ITEM" : "ISLAND"].includes(field.identity.kind))) {
        reasons.push(rowReason(REASONS.UNRESOLVED_MAPPING, field.field, { reason: "IDENTITY_KIND_MISMATCH" }));
      }
    }
    mapped.reasons = unique(reasons); mapped.initialReasons = cloneJson(mapped.reasons);
    const mappedValues = mapRow(mapped, registry, bundle.registryVersion);
    mapped.human = mappedValues.human; mapped.mappingEvidence = mappedValues.evidence; mapped.dto = mappedValues.dto;
    mapped.reasons = unique([...mapped.reasons, ...mappedValues.reasons]);
    mapped.initialReasons = cloneJson(mapped.reasons);
    for (const field of ["island", "fromItem", "toItem"]) {
      const projectedField = source.fields.find((item) => item.field === field);
      const operational = completionFields.get(field);
      if (operational.operationalDecision === "CANDIDATE_RETAINED" && projectedField.identity !== null) {
        const evidenceForField = mapped.mappingEvidence?.[field];
        if (!candidateIdentityMatchesPinnedMapping(projectedField.identity, evidenceForField ?? {})) {
          mapped.reasons.push(rowReason(REASONS.UNRESOLVED_MAPPING, field, { reason: "PINNED_IDENTITY_MISMATCH" }));
        }
      }
    }
    mapped.reasons = unique(mapped.reasons); mapped.initialReasons = cloneJson(mapped.reasons);
    if (completed.disposition === "EXCLUDE" && mapped.reasons.length === 0) batchErrors.push(batchError("INVALID_EXCLUSION", "target_not_initially_held"));
  }
  const explicit = [];
  const byRow = new Map(projection.rows.map((row) => [row.projectionRowId, row]));
  for (const row of completion.rows) if (row.disposition === "EXCLUDE") {
    explicit.push({ projectionRowId: row.projectionRowId, action: "EXCLUDE_FROM_FINAL_DTO", reason: "USER_EXPLICIT_EXCLUSION" });
  }
  if (Array.isArray(input.exclusions)) {
    for (const decision of input.exclusions) {
      if (!exactKeys(decision, ["projectionRowId", "action", "reason"]) || decision.action !== "EXCLUDE_FROM_FINAL_DTO" || decision.reason !== "USER_EXPLICIT_EXCLUSION") {
        batchErrors.push(batchError("INVALID_EXCLUSION", "malformed_or_unsupported_v3_exclusion")); continue;
      }
      const completed = completion.rows.find((row) => row.projectionRowId === decision.projectionRowId);
      if (!completed || completed.disposition !== "EXCLUDE") batchErrors.push(batchError("INVALID_EXCLUSION", "v3_exclusion_not_bound_to_completion"));
      else if (!explicit.some((entry) => entry.projectionRowId === decision.projectionRowId)) explicit.push(cloneJson(decision));
    }
  } else batchErrors.push(batchError("INVALID_EXCLUSION", "exclusions_not_array"));
  const uniqueExplicit = [];
  const explicitIds = new Set();
  for (const entry of explicit) {
    if (explicitIds.has(entry.projectionRowId)) { batchErrors.push(batchError("INVALID_EXCLUSION", "duplicate_v3_exclusion")); continue; }
    explicitIds.add(entry.projectionRowId); uniqueExplicit.push(entry);
  }
  const exclusionsAccepted = exclusionsFor(rows, uniqueExplicit, batchErrors);
  if (exclusionsAccepted.length !== explicit.length || exclusionsAccepted.some((item) => !byRow.has(item.projectionRowId))) {
    // exclusionsFor already records the precise reason; retain the row rather than silently dropping it.
  }
  const observationRef = { schemaVersion: 3, observationId: observation.observationId, observationHash: observation.observationHash,
    projectionHash: projection.projectionHash, reviewRevision: completion.reviewRevision,
    completionValuesHash: completion.batchConfirmation.completionValuesHash, masterBinding: cloneJson(projection.masterBinding) };
  const semanticObservation = { ...observation, completion: { ...completion, registryVersion: bundle.registryVersion } };
  const output = buildSemanticOutput({ observation: semanticObservation, expectedReview: expected, policyVersion: POLICY_V3,
    mappingPolicyVersion: POLICY_V3, sourceCount, rows, edgeSegments, exclusions: exclusionsAccepted,
    initialConflicts: [], batchErrors, observationRefOverride: observationRef });
  return output;
}

export function validateReviewedTradeBatch({ storedObservation, evidenceReceipt, expectedReview, exclusions = [], mappingPolicyVersion } = {}) {
  if (storedObservation?.schemaVersion === 3 || storedObservation?.reviewMode === "FINAL_CORRECTED_RESULT") {
    const v3Policy = mappingPolicyVersion === undefined ? POLICY_V3 : mappingPolicyVersion;
    if (v3Policy !== POLICY_V3) return finish(emptyResult("UNSUPPORTED_MAPPING_POLICY", typeof v3Policy === "string" ? v3Policy : "invalid", POLICY_V3));
    let safeExclusions;
    try { safeExclusions = cloneJson(exclusions, "exclusions"); }
    catch { return finish(emptyResult("INVALID_EXCLUSION", "exclusions_not_json", POLICY_V3)); }
    try { return validateObservation3({ storedObservation, evidenceReceipt, expectedReview, exclusions: safeExclusions }, POLICY_V3); }
    catch { return finish(emptyResult("INVALID_OBSERVATION", "unexpected_invalid_v3_input", POLICY_V3)); }
  }
  const policy = mappingPolicyVersion === undefined ? "" : mappingPolicyVersion;
  if (policy !== POLICY) return finish(emptyResult("UNSUPPORTED_MAPPING_POLICY", typeof policy === "string" ? policy : "invalid", POLICY));
  let safeExclusions; let exclusionInputError = false;
  try { safeExclusions = cloneJson(exclusions, "exclusions"); }
  catch { safeExclusions = []; exclusionInputError = true; }
  const input = { storedObservation, evidenceReceipt, expectedReview };
  let validated;
  try { validated = validateObservation(input, POLICY); }
  catch (error) { return finish(emptyResult("INVALID_OBSERVATION", "unexpected_invalid_input", POLICY)); }
  if (validated.schemaVersion === 1 && validated.status === "NOT_READY" && Array.isArray(validated.batchErrors)) return finish(validated);
  const batchErrors = [...validated.batchErrors];
  if (exclusionInputError) batchErrors.push(batchError("INVALID_EXCLUSION", "exclusions_not_json"));
  const initialCollision = collisionAnalysis(validated.rows);
  const initiallyHeld = new Set(validated.rows.filter((row) => row.reasons.length).map((row) => row.reviewed.projectionRowId));
  for (const id of initialCollision.heldIds) initiallyHeld.add(id);
  const initialConflicts = initialCollision.groups.map((group) => cloneJson(group));
  const exclusionsAccepted = exclusionsFor(validated.rows, safeExclusions, batchErrors);
  // Only the first-pass held set may be excluded; conflicts were included in that same first pass.
  if (exclusionsAccepted.some((entry) => !initiallyHeld.has(entry.projectionRowId))) batchErrors.push(batchError("INVALID_EXCLUSION", "target_not_initially_held"));
  return buildSemanticOutput({ observation: validated.observation, expectedReview: expectedReview ?? null,
    policyVersion: POLICY, sourceCount: validated.accounting.sourceCount, rows: validated.rows,
    edgeSegments: validated.edgeSegments, exclusions: exclusionsAccepted, initialConflicts,
    batchErrors, mappingPolicyVersion: POLICY });
}
