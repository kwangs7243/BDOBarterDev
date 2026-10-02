import { buildTradeBatchReconciliation } from "./trade-batch-reconciliation.js";
import { buildFinalTradeProjection } from "./trade-final-correction.js";
import { buildClassifiedFinalProjection3 } from "./trade-final-classification.js";
import { hashRawEvidenceSnapshot2 } from "./trade-final-evidence.js";

const FIELDS = Object.freeze(["island", "fromItem", "reqAmount", "toItem", "count", "yield"]);
const RECONCILIATION_POLICY = "trade-batch-reconciliation-v1";

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function fail(message) { throw new TypeError(message); }
function clone(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail("RawEvidenceSnapshot2 contains an invalid number");
    return value;
  }
  if (Array.isArray(value)) return value.map(clone);
  if (!isRecord(value)) fail("RawEvidenceSnapshot2 must contain plain JSON data");
  const result = {};
  for (const [key, child] of Object.entries(value)) result[key] = clone(child);
  return result;
}
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}
function validateSnapshot(rawEvidence) {
  const keys = ["schemaVersion", "recognitionBatchId", "captures", "sourceRows", "edgeSegments"];
  if (!isRecord(rawEvidence) || Object.keys(rawEvidence).sort().join("|") !== [...keys].sort().join("|")
      || rawEvidence.schemaVersion !== 2 || typeof rawEvidence.recognitionBatchId !== "string" || !rawEvidence.recognitionBatchId
      || !Array.isArray(rawEvidence.captures) || !rawEvidence.captures.length
      || !Array.isArray(rawEvidence.sourceRows) || !Array.isArray(rawEvidence.edgeSegments)) fail("RawEvidenceSnapshot2 has an invalid shape");
  const captureIds = new Set();
  rawEvidence.captures.forEach((capture, index) => {
    if (!isRecord(capture) || typeof capture.captureId !== "string" || !capture.captureId || captureIds.has(capture.captureId)
        || capture.captureOrdinal !== index + 1 || typeof capture.imageSha256 !== "string" || !/^[0-9a-f]{64}$/.test(capture.imageSha256)) {
      fail("RawEvidenceSnapshot2 capture order or image hash is invalid");
    }
    captureIds.add(capture.captureId);
  });
  const rowIds = new Set();
  let priorCaptureOrdinal = 0;
  let priorRowOrdinal = -1;
  const captureOrdinal = new Map(rawEvidence.captures.map((capture) => [capture.captureId, capture.captureOrdinal]));
  for (const [index, row] of rawEvidence.sourceRows.entries()) {
    if (!isRecord(row) || typeof row.sourceRowId !== "string" || !row.sourceRowId || rowIds.has(row.sourceRowId)
        || !captureIds.has(row.captureId) || !Number.isSafeInteger(row.ordinal) || row.ordinal < 1
        || (captureOrdinal.get(row.captureId) < priorCaptureOrdinal)
        || (captureOrdinal.get(row.captureId) === priorCaptureOrdinal && row.ordinal <= priorRowOrdinal)
        || !(row.rowBox === null || isRecord(row.rowBox)) || !Array.isArray(row.fields) || row.fields.length !== FIELDS.length) {
      fail(`RawEvidenceSnapshot2 sourceRows[${index}] has invalid identity/order`);
    }
    const actualFields = row.fields.map((field) => field?.field);
    if (actualFields.some((field, fieldIndex) => field !== FIELDS[fieldIndex])) fail(`RawEvidenceSnapshot2 sourceRows[${index}] has invalid field order`);
    row.fields.forEach((field) => {
      if ((field.rawText !== null && typeof field.rawText !== "string")
          || (field.rawNumeric !== null && !Number.isSafeInteger(field.rawNumeric))
          || typeof field.readerStatus !== "string" || !field.readerStatus || !Array.isArray(field.cropRefs)) {
        fail(`RawEvidenceSnapshot2 sourceRows[${index}] has invalid field evidence`);
      }
    });
    rowIds.add(row.sourceRowId);
    const currentCaptureOrdinal = captureOrdinal.get(row.captureId);
    if (currentCaptureOrdinal !== priorCaptureOrdinal) priorRowOrdinal = -1;
    priorCaptureOrdinal = currentCaptureOrdinal;
    priorRowOrdinal = row.ordinal;
  }
}

export function adaptRawEvidenceSnapshot2ToCorrectionInput(rawEvidence) {
  validateSnapshot(rawEvidence);
  const snapshot = clone(rawEvidence);
  const captures = snapshot.captures.map((capture) => ({
    captureId: capture.captureId,
    captureOrdinal: capture.captureOrdinal,
    imageHash: capture.imageSha256,
  }));
  const draftRows = snapshot.sourceRows.map((source) => {
    const fields = {};
    const cropRefs = [];
    source.fields.forEach((field, index) => {
      if (field.field !== FIELDS[index]) fail("RawEvidenceSnapshot2 field order is invalid");
      fields[field.field] = {
        rawText: field.rawText,
        normalizedText: null,
        rawNumericCandidate: field.rawNumeric,
        value: null,
        status: field.readerStatus,
        reasonCodes: [],
        confidence: field.confidence,
      };
      cropRefs.push(...clone(field.cropRefs));
    });
    return {
      captureId: source.captureId,
      ordinal: source.ordinal,
      rowId: source.sourceRowId,
      rowBox: clone(source.rowBox),
      cropRefs,
      status: "DRAFT_UNVERIFIED",
      automationDecision: "REVIEW",
      fields,
    };
  });
  return deepFreeze({
    recognitionBatchId: snapshot.recognitionBatchId,
    captures,
    draftRows,
    edgeSegments: clone(snapshot.edgeSegments),
  });
}

export function buildTradeFinalShadowPipeline({ rawEvidence, masterBundle, pixelAvailability, correctionPolicy } = {}) {
  if (!isRecord(correctionPolicy) || typeof correctionPolicy.policyVersion !== "string" || !correctionPolicy.policyVersion.trim()) {
    fail("correctionPolicy with a nonempty policyVersion is required");
  }
  const rawEvidenceHash = hashRawEvidenceSnapshot2(rawEvidence);
  const adapted = adaptRawEvidenceSnapshot2ToCorrectionInput(rawEvidence);
  const preliminaryReconciliation = buildTradeBatchReconciliation({
    captures: adapted.captures,
    draftRows: adapted.draftRows,
    policyVersion: RECONCILIATION_POLICY,
  });
  const rawObservation = deepFreeze({
    recognitionBatchId: adapted.recognitionBatchId,
    captures: clone(adapted.captures),
    draftRows: clone(adapted.draftRows),
    edgeSegments: clone(adapted.edgeSegments),
    reconciliation: clone(preliminaryReconciliation),
  });
  const correctionResult = buildFinalTradeProjection({
    rawObservation,
    masterBundle,
    correctionPolicy,
    reconciliationPolicyVersion: RECONCILIATION_POLICY,
    pixelAvailability,
  });
  const projection = buildClassifiedFinalProjection3({ correctionResult, rawEvidenceHash, pixelAvailability });
  return deepFreeze({
    schemaVersion: 1,
    pipelineKind: "TRADE_FINAL_SHADOW_PIPELINE",
    activation: "SHADOW_ONLY",
    rawEvidenceHash,
    rawObservation,
    preliminaryReconciliation,
    correctionResult,
    projection,
  });
}
