import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adaptLegacyCatalog, registrySnapshotSha256 } from "../frontend/js/domain/trade-master-registry.js";
import { evaluateTradeReviewDataset, semanticEvaluationSha256 } from "../tools/trade_review_evaluation.mjs";

const FIELDS = ["island", "fromItem", "reqAmount", "toItem", "count", "yield"];
const VERSION = { evaluationPolicyVersion: "trade-review-evaluation-v1", rawEvaluationVersion: "trade-raw-eval-v1", splitSeed: "r010-test-seed" };
const hex = (letter) => letter.repeat(64);
const uuid = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const catalog = { masterData: { 1: ["재료 A", "재료 B"], 2: ["교환품 A", "교환품 B"], 3: ["3단"], 4: ["4단"], 5: ["5단"], 6: ["6단"], 7: ["7단"] },
  specialItems: ["특수품"], islands: ["섬 A", "섬 B"], t6Islands: ["6단 섬"], t7Islands: ["7단 섬"] };
const registry = adaptLegacyCatalog(catalog, { sourceRevision: "evaluation-synthetic-v1", sourceSha256: hex("a") });
const defaults = { island: "섬 A", fromItem: "재료 A", reqAmount: 1, toItem: "교환품 A", count: 0, yield: 48 };
function fieldRaw(field, value) {
  if (field === "reqAmount" || field === "count" || field === "yield") return { rawText: value === null ? "" : String(value), normalizedText: null, rawNumericCandidate: value };
  return { rawText: value ?? null, normalizedText: value ?? null, rawNumericCandidate: null };
}
function makeRow(rowNumber, config = {}) {
  const values = { ...defaults, ...(config.values ?? {}) };
  const methods = config.methods ?? {};
  const shownOverrides = config.shown ?? {};
  const rawOverrides = config.raw ?? {};
  const riskOverrides = config.risks ?? {};
  const statusOverrides = config.statuses ?? {};
  const candidateOverrides = config.candidates ?? {};
  const projectionRowId = `synthetic-row-${rowNumber}`;
  const captureId = uuid(config.captureNumber ?? 1);
  const sourceRefs = [{ captureId, ordinal: rowNumber, draftRowId: `draft-${rowNumber}` }];
  const projectedFields = {};
  const reviewedFields = [];
  for (const field of FIELDS) {
    const method = methods[field] ?? "USER_BATCH_CONFIRMED_UNCHANGED";
    const finalValue = method === "USER_MARKED_UNKNOWN" ? null : values[field];
    const shownValue = Object.hasOwn(shownOverrides, field) ? shownOverrides[field]
      : method === "USER_EDITED" ? (field === "island" ? "섬 B" : field === "fromItem" ? "재료 B" : field === "toItem" ? "교환품 B" : values[field] + 1)
        : finalValue;
    const rawEvidence = fieldRaw(field, Object.hasOwn(rawOverrides, field) ? rawOverrides[field] : shownValue);
    const riskReasons = riskOverrides[field] ?? [];
    const status = statusOverrides[field] ?? "MATCHED";
    const candidate = Object.hasOwn(candidateOverrides, field) ? candidateOverrides[field]
      : ["island", "fromItem", "toItem"].includes(field) ? shownValue : null;
    projectedFields[field] = { field, shownValue, candidate, alternatives: [], status, correctionReason: [], riskReasons,
      normalizationSteps: [], rawEvidence, masterVersion: registry.registryVersion };
    reviewedFields.push({ field, shownValueBefore: shownValue, finalValue, verificationMethod: method, projectionStatus: status,
      candidate, rawEvidence, correctionReason: [], riskReasons, masterVersion: registry.registryVersion });
  }
  const row = { projectionRowId, captureId, ordinal: rowNumber, sourceIndex: rowNumber - 1, rowStatus: "COMPLETE",
    reviewState: "SYSTEM_PREDICTION_UNREVIEWED", sourceRefs,
    originalRowEvidence: { captureId, ordinal: rowNumber, rowId: projectionRowId, sourceRefs,
      fields: Object.fromEntries(FIELDS.map((field) => [field, projectedFields[field].rawEvidence])) }, fields: projectedFields };
  return { row, reviewed: { projectionRowId, captureId, ordinal: rowNumber, sourceRefs, fields: reviewedFields } };
}
function makeExport({ number = 1, rows = [{}], cohort = "DEVELOPMENT", sessionId = null, sourceSha256 = null,
  bitmapSha256 = null, edges = [], analysisAttributions = [] } = {}) {
  const captureId = uuid(number);
  const built = rows.map((row, index) => makeRow(index + 1, { ...row, captureNumber: number }));
  const projectionRows = built.map((item) => item.row);
  const completionRows = built.map((item) => item.reviewed);
  const riskFieldCount = completionRows.flatMap((row) => row.fields).filter((field) => field.riskReasons.length
    || ["AMBIGUOUS", "UNMATCHED", "MASTER_DISAGREEMENT"].includes(field.projectionStatus)).length;
  const unchangedFieldCount = completionRows.flatMap((row) => row.fields).filter((field) => field.verificationMethod === "USER_BATCH_CONFIRMED_UNCHANGED").length;
  const editedFieldCount = completionRows.flatMap((row) => row.fields).filter((field) => field.verificationMethod === "USER_EDITED").length;
  const unknownFieldCount = completionRows.flatMap((row) => row.fields).filter((field) => field.verificationMethod === "USER_MARKED_UNKNOWN").length;
  const projection = { schemaVersion: 1, reviewMode: "REVIEW_FIRST", reconciliation: null,
    masterVersion: registry.registryVersion, masterRevision: registry.registryVersion,
    masterSourceRevision: registry.source.revision, masterSnapshotSha256: registrySnapshotSha256(registry),
    correctionPolicyVersion: "correction-test-v1", rows: projectionRows };
  projection.projectionHash = registrySnapshotSha256(projection);
  const batchId = uuid(number + 1000);
  const imageHash = bitmapSha256 ?? hex(String((number % 9) + 1));
  const edgeCopies = edges.map((edge) => ({ captureId, ...edge }));
  const observation = { schemaVersion: 1, mutationId: uuid(number + 2000), createdAt: "2026-09-30T01:00:00.000Z",
    confirmationRevision: 1, supersedesObservationId: null,
    completion: { schemaVersion: 1, reviewMode: "REVIEW_FIRST", recognitionBatchId: batchId,
      projectionHash: projection.projectionHash, registryVersion: registry.registryVersion, correctionVersion: "correction-test-v1",
      reviewRevision: 1, rows: completionRows, edgeSegments: edgeCopies,
      summary: { rowCount: completionRows.length, fieldCount: completionRows.length * 6, unchangedFieldCount,
        editedFieldCount, unknownFieldCount, riskFieldCount, edgeSegmentCount: edgeCopies.length } },
    sourceContext: { version: 1, authority: "CLIENT_ATTESTED",
      registry: { sourceRevision: registry.source.revision, sourceSha256: registry.source.sha256,
        snapshotSha256: registrySnapshotSha256(registry), snapshot: registry, hashBasis: "JS_REGISTRY_SORTED_JSON_V1" },
      projection: { snapshot: projection, hashBasis: "JS_REGISTRY_SORTED_JSON_V1" },
      recognition: { resultVersion: 1, runtime: { engineId: "synthetic", modelBundleSha256: null, workerVersion: null },
        boundaryPolicy: "edge-segments-evidence-only-v1",
        captureEvidence: { captures: [{ captureId, batchId, captureOrdinal: 1, imageHash,
          imageDimensions: { width: 640, height: 360 }, detectedCandidateCount: completionRows.length + edgeCopies.length,
          completeRowCount: completionRows.length, edgeSegmentCount: edgeCopies.length }], edgeSegments: edgeCopies },
        geometryProfile: { revision: null, sha256: null, availability: "NOT_EXPOSED_BY_API" } },
      captures: [{ captureId, metadata: { version: 1, captureId, batchId, taskType: "trade", sourceType: "file",
        capturedAt: "2026-09-30T01:00:00Z", frame: { width: 640, height: 360 },
        fidelity: { sourceWidth: 640, sourceHeight: 360, rescaled: false, evidence: "file-metadata" }, profileId: null,
        profileVersion: 1, context: { baseRevision: 0, sessionId, sessionRevision: sessionId ? 1 : null },
        observed: { browserDpr: null, windowsDpi: null, gameResolution: null, gameUiScale: null } },
        bitmapSha256: imageHash, sourceSha256, bitmapBytes: 100, sourceBytes: 100, reencoded: false }], gameVersion: null },
    cropPlan: { policy: "C2_REVIEW_VALUE_SUBSET_V1", entries: [] }, observationId: uuid(number),
    persistedAt: "2026-09-30T01:01:00.000Z", hashBasis: "PY_CANONICAL_JSON_V1", payloadHash: hex("e"), observationHash: hex(String((number % 8) + 1)) };
  const datasetFields = completionRows.flatMap((row) => row.fields.map((field) => {
    const projected = projectionRows.find((item) => item.projectionRowId === row.projectionRowId).fields[field.field];
    return { projectionRowId: row.projectionRowId, field: field.field, rawEvidence: field.rawEvidence, candidate: field.candidate,
      shownValueBefore: field.shownValueBefore, finalValue: field.finalValue, verificationMethod: field.verificationMethod,
      risk: field.riskReasons, masterVersion: field.masterVersion, sourceRefs: row.sourceRefs,
      geometry: null, truthStatus: field.verificationMethod === "USER_MARKED_UNKNOWN" ? "HUMAN_DECLARED_UNKNOWN" : "HUMAN_DECLARED_VALUE",
      knownTruthEligible: field.verificationMethod !== "USER_MARKED_UNKNOWN", identityMappingVerified: false,
      projectionStatus: projected.status };
  }));
  return { cohort, exclusions: [], exportRecord: { schemaVersion: 1, exportType: "TRADE_REVIEW_OBSERVATION",
    generatedAt: "2026-09-30T01:02:00.000Z", semanticHash: hex("9"), semantic: {
      manifest: { observationSchemaVersion: 1, sidecarSchemaVersion: 2, hashBasis: observation.hashBasis,
        payloadHash: observation.payloadHash, observationHash: observation.observationHash,
        sourceSnapshotHashes: { registry: registrySnapshotSha256(registry), projection: projection.projectionHash },
        sourceHashClaims: { registry: registry.source.sha256, projection: projection.projectionHash, hashBasis: "JS_REGISTRY_SORTED_JSON_V1" },
        cropPolicy: observation.cropPlan.policy, evaluationBasis: "NOT_EVALUATED_R006" },
      observation, cropEvidence: [], dataset: { fields: datasetFields,
        edgeSegments: edgeCopies.map((item) => ({ ...item, sixFieldTruth: false })), analysisAttributions } } } };
}
function evaluate(entries, candidateRuns = [], splitSeed = VERSION.splitSeed) {
  return evaluateTradeReviewDataset({ observations: entries, candidateRuns, ...VERSION, splitSeed });
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
const known = makeExport({ number: 1 });
const one = evaluate([known]);
assert.equal(one.evaluationStatus, "VALID_DESCRIPTIVE_EVALUATION");
assert.deepEqual(one.denominators, { F: 6, V: 6, R: 1, T: 1, rawWrongOrMissingKnownTruth: 0, rawCorrectKnownTruth: 6,
  unhighlightedKnownTruth: 6, registryComparable: 3, numericSlots: 3 });
assert.deepEqual(one.metrics.PRE_REVIEW_FINAL_CANDIDATE_CORRECTNESS, { numerator: 6, denominator: 6, rate: 1, status: "AVAILABLE" });
assert.equal(one.metrics.sixFieldExactRows.rate, 1);
assert.equal(one.metrics.FINAL_VERIFIED_DTO_SUCCESS.withoutExclusions.rate, 1);
assert.equal(one.metricsByCohort.INDEPENDENT.denominators.V, 0);
assert.equal(one.metricsByCohort.INDEPENDENT.metrics.PRE_REVIEW_FINAL_CANDIDATE_CORRECTNESS.status, "N/A");

// A. Unchanged, edited, unknown: unknown truth is outside V but remains visible in coverage.
const mixed = makeExport({ number: 2, rows: [{ methods: { island: "USER_EDITED", count: "USER_MARKED_UNKNOWN" },
  values: { island: "섬 B" }, raw: { island: "섬 A" }, shown: { island: "섬 A" } }] });
const mixedResult = evaluate([mixed]);
assert.deepEqual([mixedResult.denominators.F, mixedResult.denominators.V, mixedResult.denominators.R, mixedResult.denominators.T], [6, 5, 1, 0]);
assert.equal(mixedResult.coverage.unknownFieldCount, 1);
assert.equal(mixedResult.coverage.unknownRowCount, 1);
assert.equal(mixedResult.metrics.USER_EDIT_RATE.rate, 0.2);
assert.equal(mixedResult.metrics.ROWS_REQUIRING_EDIT.numerator, 1);
assert.equal(mixedResult.metrics.FIELDS_REQUIRING_EDIT.count, 1);
assert.equal(mixedResult.metrics.FIELDS_REQUIRING_EDIT.byField.island.count, 1);
assert.equal(mixedResult.failureTaxonomy.counts.USER_UNKNOWN, 1);

// B. Denominator zero is explicit N/A.
const allUnknown = makeExport({ number: 3, rows: [{ methods: Object.fromEntries(FIELDS.map((key) => [key, "USER_MARKED_UNKNOWN"])) }] });
const noKnown = evaluate([allUnknown]);
assert.equal(noKnown.denominators.V, 0);
assert.deepEqual(noKnown.metrics.PRE_REVIEW_FINAL_CANDIDATE_CORRECTNESS, { numerator: 0, denominator: 0, rate: null, status: "N/A" });

// C-F. Raw recovery and harm use only the versioned scalar reader result.
const rawCases = makeExport({ number: 4, rows: [
  { raw: { island: "섬 B" } },
  { raw: { fromItem: "재료 B", yield: 99 }, values: { fromItem: "재료 B", yield: 48 }, methods: { fromItem: "USER_EDITED" }, shown: { fromItem: "재료 A" } },
] });
const rawResult = evaluate([rawCases]);
assert.equal(rawResult.metrics.CORRECTION_RECOVERY_RATE.numerator, 2);
assert.equal(rawResult.metrics.CORRECTION_RECOVERY_RATE.denominator, 2);
assert.equal(rawResult.metrics.CORRECTION_HARM_RATE.numerator, 1);
assert.equal(rawResult.metrics.CORRECTION_HARM_RATE.denominator, 10);
assert.equal(rawResult.failureTaxonomy.counts.CORRECTION_ERROR, 1);
assert.equal(rawResult.failureTaxonomy.counts.RECOGNITION_ERROR, 0);
const rawNumericMinimum = makeExport({ number: 40, rows: [{ raw: { reqAmount: 0 }, values: { reqAmount: 1 } }] });
assert.equal(evaluate([rawNumericMinimum]).metrics.CORRECTION_RECOVERY_RATE.denominator, 1,
  "numeric raw candidate below field minimum is missing, not reparsed from text");

// G-H. Highlighted edits are excluded from unhighlighted error denominator.
const riskCase = makeExport({ number: 5, rows: [{ methods: { island: "USER_EDITED", count: "USER_EDITED" },
  values: { island: "섬 B", count: 1 }, shown: { island: "섬 A", count: 0 },
  risks: { count: [{ code: "NUMERIC_COMPLETENESS_UNVERIFIED" }] } }] });
const riskResult = evaluate([riskCase]);
assert.equal(riskResult.metrics.UNHIGHLIGHTED_ERROR_RATE.numerator, 1);
assert.equal(riskResult.metrics.UNHIGHLIGHTED_ERROR_RATE.denominator, 5);
assert.equal(riskResult.metrics.NUMERIC_REVIEW_RATE.riskCount, 1);
assert.equal(riskResult.metrics.NUMERIC_REVIEW_RATE.editedCount, 1);
assert.equal(riskResult.metrics.NUMERIC_REVIEW_RATE.unionCount, 1);
assert.equal(riskResult.failureTaxonomy.counts.NUMERIC_INCOMPLETE, 1);

// I. Master disagreement uses only registry-comparable confirmed identity fields.
const masterCase = makeExport({ number: 6, rows: [{ statuses: { island: "MASTER_DISAGREEMENT" },
  risks: { island: [{ code: "MASTER_DISAGREEMENT" }] }, candidates: { island: { name: "registry candidate" } } }] });
const masterResult = evaluate([masterCase]);
assert.equal(masterResult.metrics.MASTER_DISAGREEMENT_RATE.numerator, 1);
assert.equal(masterResult.metrics.MASTER_DISAGREEMENT_RATE.denominator, 3);
assert.equal(masterResult.metrics.masterCounts.masterDisagreement, 1);
assert.equal(masterResult.failureTaxonomy.counts.MASTER_DISAGREEMENT, 1);

// J. Numeric risk/edit/unknown union prevents overlap double counting.
assert.equal(riskResult.metrics.NUMERIC_REVIEW_RATE.unionCount, 1);

// K-L. R008 replay contributes verified DTO success; exclusions are evaluated both ways.
const heldPair = makeExport({ number: 7, rows: [
  {}, { values: { yield: 49 }, methods: { yield: "USER_EDITED" }, shown: { yield: 48 } },
] });
const heldIds = heldPair.exportRecord.semantic.observation.completion.rows.map((row) => row.projectionRowId);
const exclusions = heldIds.map((projectionRowId) => ({ projectionRowId, action: "EXCLUDE_FROM_FINAL_DTO", reason: "USER_EXPLICIT_EXCLUSION" }));
const heldMetrics = evaluate([{ ...heldPair, exclusions }]);
assert.equal(heldMetrics.metrics.FINAL_VERIFIED_DTO_SUCCESS.batchErrors.length, 0);
assert.equal(heldMetrics.metrics.FINAL_VERIFIED_DTO_SUCCESS.includingExplicitExclusions.denominator,
  heldMetrics.metrics.FINAL_VERIFIED_DTO_SUCCESS.excludingExplicitExclusions.denominator + exclusions.length);

const unknownHeld = makeExport({ number: 70, rows: [{ methods: { fromItem: "USER_MARKED_UNKNOWN" } }] });
const unknownRowId = unknownHeld.exportRecord.semantic.observation.completion.rows[0].projectionRowId;
const exclusion = [{ projectionRowId: unknownRowId, action: "EXCLUDE_FROM_FINAL_DTO", reason: "USER_EXPLICIT_EXCLUSION" }];
const unknownDto = evaluate([{ ...unknownHeld, exclusions: exclusion }]).metrics.FINAL_VERIFIED_DTO_SUCCESS;
assert.equal(unknownDto.batchErrors.length, 0);
assert.deepEqual(unknownDto.excludingExplicitExclusions, { numerator: 0, denominator: 0, rate: null, status: "N/A" });
assert.deepEqual(unknownDto.includingExplicitExclusions, { numerator: 0, denominator: 1, rate: 0, status: "AVAILABLE" });
const invalidExclusion = evaluate([{ ...unknownHeld, exclusions: [{ projectionRowId: "not-a-row", action: "EXCLUDE_FROM_FINAL_DTO", reason: "USER_EXPLICIT_EXCLUSION" }] }])
  .metrics.FINAL_VERIFIED_DTO_SUCCESS;
assert.equal(invalidExclusion.includingExplicitExclusions.status, "N/A");
assert.equal(invalidExclusion.batchErrors.length > 0, true);
const exactDuplicateRows = evaluate([makeExport({ number: 71, rows: [{}, {}] })]);
assert.deepEqual(exactDuplicateRows.metrics.FINAL_VERIFIED_DTO_SUCCESS.withoutExclusions,
  { numerator: 1, denominator: 1, rate: 1, status: "AVAILABLE" });
const conflictRows = evaluate([makeExport({ number: 72, rows: [{}, { values: { yield: 49 }, methods: { yield: "USER_EDITED" }, shown: { yield: 48 } }] })]);
assert.deepEqual(conflictRows.metrics.FINAL_VERIFIED_DTO_SUCCESS.withoutExclusions,
  { numerator: 0, denominator: 2, rate: 0, status: "AVAILABLE" });
assert.equal(conflictRows.failureTaxonomy.counts.DUPLICATE_CONFLICT, 2);

// M-N. Duplicate exports count once; same ID with a different observation hash is rejected.
const repeated = evaluate([known, copy(known)]);
assert.equal(repeated.datasetManifest.observationCount, 2);
assert.equal(repeated.datasetManifest.uniqueObservationCount, 1);
assert.equal(repeated.denominators.R, 1);
assert.equal(repeated.duplicateInputs[0].duplicateCount, 1);
const changedHash = copy(known); changedHash.exportRecord.semantic.observation.observationHash = hex("b");
changedHash.exportRecord.semantic.manifest.observationHash = hex("b");
assert.throws(() => evaluate([known, changedHash]), /same observationId has different observationHash/);

// O-P. Shared evidence cannot leak across cohorts or be split across internal replay sets.
const dev = makeExport({ number: 8, cohort: "DEVELOPMENT", sessionId: "shared-session" });
const independent = makeExport({ number: 9, cohort: "INDEPENDENT", sessionId: "shared-session", bitmapSha256: hex("c") });
const leakage = evaluate([dev, independent]);
assert.equal(leakage.evaluationStatus, "INVALID_SPLIT_LEAKAGE");
assert.equal(leakage.metrics.status, "INVALID");
assert.equal(leakage.splitValidation.errors[0].code, "SPLIT_LEAKAGE");
assert.equal(leakage.metricsByField.island.status, "INVALID");
const groupSafe = evaluate([dev, independent], [], "different-seed");
assert.equal(groupSafe.evidenceGroups.find((group) => group.splitLeakage).internalSplit, "DEVELOPMENT_REPLAY_A");
const independentOnly = evaluate([independent]);
assert.equal(independentOnly.evidenceGroups[0].internalSplit, null);
assert.equal(independentOnly.splitValidation.independentHoldoutClaim, false);
const sharedCaptureId = (record, id) => {
  const result = copy(record);
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "captureId") value[key] = id;
      else walk(child);
    }
  };
  walk(result.exportRecord);
  return result;
};
const captureOnlyGroup = evaluate([sharedCaptureId(makeExport({ number: 80 }), "capture-shared"),
  sharedCaptureId(makeExport({ number: 81 }), "capture-shared")]);
assert.equal(captureOnlyGroup.evidenceGroups.length, 2, "captureId alone is diagnostic, not an independence/leakage key");
const sameDevelopmentGroup = evaluate([makeExport({ number: 82, sessionId: "same-dev-session" }),
  makeExport({ number: 83, sessionId: "same-dev-session" })]);
assert.equal(sameDevelopmentGroup.evidenceGroups.length, 1);
assert.equal(new Set(sameDevelopmentGroup.evidenceGroups.flatMap((group) => group.observationRefs.map((ref) =>
  sameDevelopmentGroup.datasetManifest.observationRefs.find((item) => item.observationId === ref.split(":")[0]).observationId))).size, 2);
assert.equal(new Set(sameDevelopmentGroup.evidenceGroups.map((group) => group.internalSplit)).size, 1);

// Q. Same seed stabilizes assignments; seed is included in semantic hash.
const splits = [makeExport({ number: 10 }), makeExport({ number: 11 }), makeExport({ number: 12 })];
assert.deepEqual(evaluate(splits).evidenceGroups.map((group) => group.internalSplit), evaluate(splits).evidenceGroups.map((group) => group.internalSplit));
assert.notEqual(evaluate(splits, [], "seed-A").semanticHash, evaluate(splits, [], "seed-B").semanticHash);

// R-T. Candidate replay compares predictions without changing truth or selecting a winner.
const baselineFields = one.failureTaxonomy.derivedAttributions;
const candidate = { candidateId: "candidate-a", policyVersion: "candidate-policy-v1", sourceSha256: hex("d"), predictions: [] };
for (const field of one.datasetManifest.observationRefs) void field;
const truth = known.exportRecord.semantic.observation.completion.rows[0];
candidate.predictions = truth.fields.map((field) => ({ observationId: known.exportRecord.semantic.observation.observationId,
  projectionRowId: truth.projectionRowId, field: field.field, value: field.shownValueBefore, highlighted: false }));
candidate.predictions[0].value = "섬 B";
candidate.predictions.pop();
const candidateResult = evaluate([known], [candidate]);
const compared = candidateResult.candidateComparisons[0];
assert.equal(compared.candidateCorrectness.numerator, 4);
assert.equal(compared.predictionCoverage.numerator, 5);
assert.equal(compared.improvementCount, 0);
assert.equal(compared.regressionCount, 2);
assert.equal(compared.unchangedCorrectCount, 4);
assert.equal(compared.unchangedWrongCount, 0);
assert.equal(compared.unhighlightedErrorRate.numerator, 1);
assert.equal(compared.candidateReplayAuthority, "CALLER_ATTESTED_OFFLINE_REPLAY");
assert.throws(() => evaluate([known], [{ ...candidate, predictions: [{ ...candidate.predictions[0], finalValue: "truth leak" }] }]), /truth-bearing fields/);
const improvementExport = makeExport({ number: 90, rows: [{ methods: { fromItem: "USER_EDITED" }, values: { fromItem: "재료 A" }, shown: { fromItem: "재료 B" } }] });
const improvementTruth = improvementExport.exportRecord.semantic.observation.completion.rows[0];
const improvementRun = { candidateId: "candidate-improving", policyVersion: "candidate-policy-v1", sourceSha256: hex("f"),
  predictions: [{ observationId: improvementExport.exportRecord.semantic.observation.observationId,
    projectionRowId: improvementTruth.projectionRowId, field: "fromItem", value: "재료 A", highlighted: true }] };
assert.equal(evaluate([improvementExport], [improvementRun]).candidateComparisons[0].improvementCount, 1);
assert.equal(baselineFields.length, 0);

// U-W. Multiple attribution, edge omission, and manual-only proposals.
const attributed = makeExport({ number: 13, rows: [{ methods: { island: "USER_EDITED", yield: "USER_MARKED_UNKNOWN" },
  values: { island: "섬 B" }, shown: { island: "섬 A" }, raw: { island: "섬 B", yield: null },
  statuses: { island: "MASTER_DISAGREEMENT" }, risks: { island: [{ code: "MASTER_DISAGREEMENT" }] } }],
  edges: [{ ordinal: 1, classification: "EDGE_SEGMENT_UNCERTAIN" }],
  analysisAttributions: [{ type: "REVIEWER_NOTE", field: "island", note: "source attribution remains separate",
    imageBytesBase64: "iVBORw0KGgoAAAANSUhEUg==" }] });
const attributedResult = evaluate([attributed]);
const islandAttributions = attributedResult.failureTaxonomy.derivedAttributions.filter((item) => item.field === "island");
assert(islandAttributions.some((item) => item.type === "MASTER_DISAGREEMENT"));
assert(islandAttributions.some((item) => item.type === "CORRECTION_ERROR"));
assert.equal(attributedResult.failureTaxonomy.counts.CAPTURE_INCOMPLETE, 1);
assert.equal(attributedResult.failureTaxonomy.sourceAttributions[0].note, "source attribution remains separate");
assert(!JSON.stringify(attributedResult).includes("iVBORw0KGgo"), "report must not include image bytes/base64");
assert(attributedResult.curationProposals.length > 0);
assert(attributedResult.curationProposals.every((item) => item.requiresManualCuration && item.proposedMutation === null));

// X-Z. Deterministic order/hash and no input mutation.
const orderA = makeExport({ number: 14, rows: [{}, { methods: { fromItem: "USER_EDITED" }, values: { fromItem: "재료 B" } }] });
const orderB = makeExport({ number: 15, rows: [{}] });
const before = JSON.stringify([orderA, orderB]);
const ordered = evaluate([orderA, orderB]);
const reversed = evaluate([orderB, orderA]);
assert.equal(ordered.semanticHash, reversed.semanticHash);
assert.equal(ordered.semanticHash, semanticEvaluationSha256(Object.fromEntries(Object.entries(ordered).filter(([key]) => key !== "semanticHash"))));
assert.equal(JSON.stringify([orderA, orderB]), before);
assert.equal(ordered.warnings.some((item) => item.includes("not independent holdouts")), true);

// Source generatedAt does not define dataset identity.
const generatedAtVariant = copy(known);
generatedAtVariant.exportRecord.generatedAt = "2030-01-01T00:00:00.000Z";
assert.equal(evaluate([known]).semanticHash, evaluate([generatedAtVariant]).semanticHash);

// Input validation rejects unsupported versions and semantically mismatched exports.
assert.throws(() => evaluateTradeReviewDataset({ ...VERSION, evaluationPolicyVersion: "future", observations: [] }), /unsupported evaluationPolicyVersion/);
const badFields = copy(known); badFields.exportRecord.semantic.dataset.fields.pop();
assert.throws(() => evaluate([badFields]), /six fields per reviewed logical row/);

// CLI paths are manifest-relative, output is non-overwriting, and generatedAt is outside semantic hash.
const tempDir = await mkdtemp(path.join(os.tmpdir(), "r010-evaluation-"));
try {
  const exportPath = path.join(tempDir, "observation.json");
  const manifestPath = path.join(tempDir, "manifest.json");
  const outputA = path.join(tempDir, "report-a.json");
  const outputB = path.join(tempDir, "report-b.json");
  const cliManifest = { schemaVersion: 1, evaluationPolicyVersion: VERSION.evaluationPolicyVersion,
    rawEvaluationVersion: VERSION.rawEvaluationVersion, splitSeed: VERSION.splitSeed,
    observations: [{ exportPath: "observation.json", exclusions: [], cohort: "DEVELOPMENT" }] };
  await writeFile(exportPath, JSON.stringify(known.exportRecord));
  await writeFile(manifestPath, JSON.stringify(cliManifest));
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../tools/trade_review_evaluation.mjs");
  const runCli = (out) => spawnSync(process.execPath, [cli, "--manifest", manifestPath, "--out", out], { encoding: "utf8" });
  const cliA = runCli(outputA);
  assert.equal(cliA.status, 0, cliA.stderr);
  const cliB = runCli(outputB);
  assert.equal(cliB.status, 0, cliB.stderr);
  const reportA = JSON.parse(await readFile(outputA, "utf8"));
  const reportB = JSON.parse(await readFile(outputB, "utf8"));
  assert.equal(typeof reportA.generatedAt, "string");
  assert.equal(reportA.semanticHash, reportB.semanticHash);
  const firstBytes = await readFile(outputA, "utf8");
  assert.notEqual(runCli(outputA).status, 0, "existing output must not be overwritten");
  assert.equal(await readFile(outputA, "utf8"), firstBytes);
  assert.notEqual(runCli(exportPath).status, 0, "output cannot overwrite an input export");
  const protectedSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../frontend/js/domain/reviewed-trade-dto.js");
  assert.notEqual(runCli(protectedSource).status, 0,
    "output cannot target protected production source");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("trade_review_evaluation_regression: PASS · truth/metrics, R008 replay, leakage-safe splits, candidate comparison, taxonomy, curation-only, deterministic hash");
