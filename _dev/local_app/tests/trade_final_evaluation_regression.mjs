import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateFinalTradeReviewDataset, evaluateTradeReviewDataset, semanticEvaluationSha256 } from "../tools/trade_review_evaluation.mjs";
import { createMasterBundleV2 } from "../frontend/js/domain/trade-master-bundle.js";
import { registrySnapshotSha256 } from "../frontend/js/domain/trade-master-registry.js";

const FIELDS = ["island", "fromItem", "reqAmount", "toItem", "count", "yield"];
const VALUES = { island: "해모 섬", fromItem: "재료", reqAmount: 1, toItem: "교환품", count: 0, yield: 48 };
const hex = (n) => n.toString(16).padStart(64, "0");
const stable = semanticEvaluationSha256;
const truthProvenance = (family = "family-independent", manifestHash = null) => ({ method: "HUMAN_CROP_VERIFIED", labelerRole: "PRODUCT_OWNER",
  sourceFamilyId: family, cohort: "INDEPENDENT", splitManifestHash: manifestHash, sourceOrigin: "FRESH_CAPTURE",
  independentOfOperationalReview: true, note: null });

function makeExport({ labelFields = FIELDS, decisions = {}, raw = {}, corrected = {}, final = {}, classification = "FINAL_READY", family,
  observationKey = family ?? "one", truths = {}, splitManifestHash = null } = {}) {
  const observationId = `observation-${observationKey}`;
  const sourceRowId = `source-${observationKey}`;
  const projectionRowId = `logical-${observationKey}`;
  const masterSnapshot = createMasterBundleV2({ createdAt: "2026-10-02T00:00:00.000Z", entities: [], compatibilityMappings: [],
    unresolvedLegacyNames: [], sourceRevisions: [{ sourceType: "SYNTHETIC", revision: "fixture-v1", sha256: hex(900) }],
    provenance: { purpose: "E1-D regression fixture" } });
  const masterBinding = { masterSchemaVersion: 2, registryVersion: masterSnapshot.registryVersion,
    contentHash: masterSnapshot.contentHash, hashBasis: "MASTER_CANONICAL_JSON_V2" };
  const sourceFields = []; const rawRecognitionFields = []; const rawProjectionFields = []; const completionFields = []; const logicalFields = [];
  const labels = [];
  for (const field of FIELDS) {
    const truth = Object.hasOwn(truths, field) ? truths[field] : VALUES[field]; const rawValue = Object.hasOwn(raw, field) ? raw[field] : truth;
    const correctedValue = Object.hasOwn(corrected, field) ? corrected[field] : truth;
    const finalValue = Object.hasOwn(final, field) ? final[field] : correctedValue;
    const numeric = ["reqAmount", "count", "yield"].includes(field);
    const cropRefId = `crop-${observationKey}-${field}`;
    const bitmapSha256 = hex(FIELDS.indexOf(field) + (family?.endsWith("b") ? 100 : 1));
    const pixelSha256 = hex(FIELDS.indexOf(field) + (family?.endsWith("b") ? 200 : 20));
    const crop = { cropRefId, sourceRowId, captureId: `capture-${observationKey}`, field, bitmapSha256,
      frame: { width: 10, height: 10 }, coordinateSpace: "CAPTURE_BITMAP_PIXELS",
      box: { x: 1, y: 2, width: 4, height: 5 }, pixelHashBasis: "RGB8_ROW_MAJOR_V1", pixelSha256,
      pngArtifactSha256: hex(FIELDS.indexOf(field) + 300) };
    const rawEvidence = { sourceRowId, rawText: numeric ? (rawValue === null ? "" : String(rawValue)) : rawValue,
      rawNumeric: numeric ? rawValue : null, readerStatus: rawValue === null ? "EMPTY" : "OK", confidence: "0.91" };
    rawRecognitionFields.push({ field, rawText: rawEvidence.rawText, rawNumeric: rawEvidence.rawNumeric,
      readerStatus: rawEvidence.readerStatus, confidence: rawEvidence.confidence, cropRefs: [crop] });
    const decision = decisions[field] ?? "CANDIDATE_RETAINED";
    sourceFields.push({ sourceRowId, field, rawEvidence, normalizedValue: rawValue, correctedValue,
      truthEvidence: labelFields.includes(field) ? "HUMAN_CROP_VERIFIED" : "NONE",
      knownTruthEligible: labelFields.includes(field), truthValue: labelFields.includes(field) ? truth : null,
      truthLabelIds: labelFields.includes(field) ? [`label-${observationKey}-${field}`] : [], cropRefs: [crop] });
    rawProjectionFields.push({ field, normalizedValue: rawValue, finalValue: correctedValue, correctionReasons: [], riskReasons: [], cropRefs: [cropRefId],
      identity: ["island", "fromItem", "toItem"].includes(field) ? { kind: field === "island" ? "ISLAND" : "ITEM",
        stableId: "stable-example", authorityStatus: "VERIFIED_CURATED" } : null });
    completionFields.push({ field, operationalDecision: decision, finalValue,
      shownValueBefore: correctedValue, riskReasons: [], cropRefs: [cropRefId], userEditReason: null });
    for (const cropField of [crop]) {
      if (!labelFields.includes(field)) continue;
      const label = { schemaVersion: 1, mutationId: `mutation-${observationKey}-${field}`, sourceRowId, field,
        cropRefId: cropField.cropRefId, labelRevision: 1, supersedesLabelId: null, labelStatus: "KNOWN", value: truth,
        provenance: truthProvenance(family, splitManifestHash), createdAt: "2026-10-02T00:00:00Z", labelId: `label-${observationKey}-${field}`,
        observationId, persistedAt: "2026-10-02T00:01:00Z",
        artifact: { sha256: cropField.pngArtifactSha256, pixelSha256, width: 4, height: 5 }, truthEvidence: "HUMAN_CROP_VERIFIED" };
      label.labelHash = stable(label); labels.push(label);
    }
    const exported = { field, operationalDecision: decision, truthEvidence: labelFields.includes(field) ? "HUMAN_CROP_VERIFIED" : "NONE",
      knownTruthEligible: labelFields.includes(field), truthValue: labelFields.includes(field) ? truth : null,
      truthLabelIds: labelFields.includes(field) ? [`label-${observationKey}-${field}`] : [], rawEvidence: [rawEvidence],
      normalizedValue: rawValue, correctedValue, shownValueBefore: correctedValue, finalValue,
      riskReasons: [], correctionReasons: [], masterBinding,
      sourceRefs: [{ sourceRowId, captureId: `capture-${observationKey}`, ordinal: 1 }], cropRefs: [crop] };
    logicalFields.push(exported);
  }
  const projection = { schemaVersion: 3, reviewMode: "FINAL_CORRECTED_RESULT", recognitionBatchId: `batch-${observationKey}`,
    rawEvidenceHash: null, projectionHash: null, masterBinding, correctionVersion: "synthetic-correction-v1",
    reconciliation: { schemaVersion: 2, policyVersion: "trade-batch-reconciliation-v1", captureOrder: [`capture-${observationKey}`],
      sourceRows: [{ sourceRowId, captureId: `capture-${observationKey}`, ordinal: 1, projectionSourceIndex: 0 }],
      groups: [{ groupId: `group-${observationKey}`, status: "SINGLE", memberSourceRowIds: [sourceRowId],
        representativeSourceRowId: sourceRowId, logicalRowId: projectionRowId, memberEvidence: [] }],
      sourceToLogical: [{ sourceRowId, logicalRowId: projectionRowId }], findings: [] },
    pixelAvailability: sourceFields.flatMap((sourceField) => sourceField.cropRefs.map((crop) => ({ cropRefId: crop.cropRefId, state: "IN_MEMORY" }))),
    hashBasis: "TRADE_FINAL_PROJECTION_JSON_V3", rows: [{ projectionRowId, captureId: `capture-${observationKey}`, ordinal: 1,
      rowBox: { x: 0, y: 0, width: 10, height: 10 }, classification, classificationReasons: [],
      sourceRefs: [{ sourceRowId, captureId: `capture-${observationKey}`, ordinal: 1 }], fields: rawProjectionFields }], edgeWorkItems: [] };
  projection.projectionHash = stable(Object.fromEntries(Object.entries(projection).filter(([key]) => key !== "projectionHash")));
  const completion = { schemaVersion: 3, reviewMode: "FINAL_CORRECTED_RESULT", recognitionBatchId: projection.recognitionBatchId,
    projectionHash: projection.projectionHash, masterBinding, correctionVersion: "synthetic-correction-v1", reviewRevision: 1,
    rows: [{ projectionRowId, disposition: "INCLUDE", dispositionReason: null,
      sourceRefs: [{ sourceRowId, captureId: `capture-${observationKey}`, ordinal: 1 }], fields: completionFields }], workItems: [] };
  completion.batchConfirmation = { method: "USER_FINAL_LIST_CONFIRMED", confirmedAt: "2026-10-02T00:01:00Z",
    projectionHash: projection.projectionHash, reviewRevision: completion.reviewRevision,
    completionValuesHash: registrySnapshotSha256(completion) };
  const rawSnapshot = { schemaVersion: 2, recognitionBatchId: projection.recognitionBatchId,
    captures: [{ captureId: `capture-${observationKey}`, captureOrdinal: 0, imageSha256: hex(1000), bitmapSha256: hex(1001),
      sourceType: "STREAM", frame: { width: 10, height: 10 }, sourceFidelity: { sourceWidth: null, sourceHeight: null, rescaled: null, evidence: "unknown" },
      reencoded: false, completeRowCount: 1 }],
    sourceRows: [{ sourceRowId, captureId: `capture-${observationKey}`, ordinal: 1, rowBox: { x: 0, y: 0, width: 10, height: 10 }, fields: rawRecognitionFields }],
    edgeSegments: [] };
  const rawEvidenceHash = registrySnapshotSha256(rawSnapshot);
  projection.rawEvidenceHash = rawEvidenceHash;
  projection.projectionHash = null;
  projection.projectionHash = stable(Object.fromEntries(Object.entries(projection).filter(([key]) => key !== "projectionHash")));
  completion.projectionHash = projection.projectionHash;
  completion.batchConfirmation.projectionHash = projection.projectionHash;
  completion.batchConfirmation.completionValuesHash = registrySnapshotSha256(Object.fromEntries(Object.entries(completion)
    .filter(([key]) => key !== "batchConfirmation")));
  const observation = { schemaVersion: 3, reviewMode: "FINAL_CORRECTED_RESULT", mutationId: "10000000-0000-4000-8000-000000000001",
    createdAt: "2026-10-02T00:00:00Z", confirmationRevision: 1, supersedesObservationId: null, projection, completion,
    sourceContext: { schemaVersion: 3, authority: "CLIENT_ATTESTED",
      rawEvidence: { hashBasis: "TRADE_RAW_EVIDENCE_JSON_V2", rawEvidenceHash, snapshot: rawSnapshot },
      masterBundle: { binding: masterBinding, snapshot: masterSnapshot },
      audit: { recognitionStartedAt: null, recognitionFinishedAt: null, latencyMs: null, gameVersion: null } },
    cropPlan: { schemaVersion: 3, policy: "C2_LOGICAL_REPRESENTATIVE_V3", entries: completionFields.map((field) => {
      const reasons = [];
      if (field.operationalDecision === "USER_EDITED") reasons.push("USER_EDITED");
      if (field.operationalDecision === "USER_MARKED_UNKNOWN") reasons.push("USER_MARKED_UNKNOWN");
      if (field.riskReasons.length) reasons.push("RISKY_FIELD");
      const selected = reasons.length > 0;
      return { projectionRowId, field: field.field, cropRefId: `crop-${observationKey}-${field.field}`, selected, reasons,
        retentionClass: !selected ? "NONE" : field.operationalDecision === "USER_MARKED_UNKNOWN" ? "UNKNOWN_EVIDENCE" : "OPERATIONAL_REVIEW_EVIDENCE" };
    }) },
    observationId, persistedAt: "2026-10-02T00:01:00Z",
    hashBasis: "TRADE_OBSERVATION_JSON_V3" };
  const request = Object.fromEntries(Object.entries(observation).filter(([key]) =>
    !["observationId", "persistedAt", "hashBasis", "payloadHash", "observationHash"].includes(key)));
  observation.payloadHash = registrySnapshotSha256(request);
  observation.observationHash = registrySnapshotSha256({ ...request, observationId, persistedAt: observation.persistedAt,
    hashBasis: observation.hashBasis, payloadHash: observation.payloadHash });
  const cropEvidence = sourceFields.flatMap((sourceField) => sourceField.cropRefs.map((crop) => ({ projectionRowId, field: sourceField.field,
    cropRefId: crop.cropRefId, artifactSha256: null, pixelSha256: crop.pixelSha256, state: "NOT_UPLOADED",
    retentionClass: observation.cropPlan.entries.find((entry) => entry.field === sourceField.field).retentionClass })));
  const semantic = { manifest: { observationSchemaVersion: 3, sidecarSchemaVersion: 3, projectionSchemaVersion: 3,
    completionSchemaVersion: 3, masterBinding, projectionHash: projection.projectionHash, payloadHash: observation.payloadHash,
    observationHash: observation.observationHash, truthLabelBindings: [...labels].sort((a, b) => a.labelId.localeCompare(b.labelId))
      .map(({ labelId, labelHash }) => ({ labelId, labelHash })), evaluationPolicyVersion: "trade-final-review-evaluation-v3" },
    observation, cropEvidence, truthLabels: labels, dataset: { recognitionBatchId: projection.recognitionBatchId,
      rows: [{ projectionRowId, classification, disposition: "INCLUDE", sourceRefs: completion.rows[0].sourceRefs, fields: logicalFields }],
      sourceFields, edgeWorkItems: [] } };
  const exportRecord = { schemaVersion: 3, exportType: "TRADE_FINAL_REVIEW_OBSERVATION", generatedAt: "2026-10-02T00:02:00Z",
    hashBasis: "TRADE_EXPORT_JSON_V3", semanticHash: stable(semantic), semantic };
  return exportRecord;
}

function splitManifest(assignments) {
  const base = { schemaVersion: 1, frozen: true, assignments };
  return { ...base, manifestHash: stable(base) };
}
function resignExport(record) {
  const { observation, manifest } = record.semantic;
  const request = Object.fromEntries(Object.entries(observation).filter(([key]) =>
    !["observationId", "persistedAt", "hashBasis", "payloadHash", "observationHash"].includes(key)));
  observation.payloadHash = registrySnapshotSha256(request);
  observation.observationHash = registrySnapshotSha256({ ...request, observationId: observation.observationId,
    persistedAt: observation.persistedAt, hashBasis: observation.hashBasis, payloadHash: observation.payloadHash });
  manifest.payloadHash = observation.payloadHash;
  manifest.observationHash = observation.observationHash;
  record.semanticHash = stable(record.semantic);
  return record;
}

const noLabels = makeExport({ labelFields: [], decisions: { yield: "USER_EDITED" }, corrected: { yield: 49 }, final: { yield: 48 } });
const descriptive = evaluateFinalTradeReviewDataset({ observations: [noLabels] });
assert.equal(descriptive.evaluationStatus, "VALID_DESCRIPTIVE_EVALUATION", JSON.stringify(descriptive.invalidReasons));
assert.deepEqual({ V: descriptive.denominators.V, T: descriptive.denominators.T, K: descriptive.denominators.K }, { V: 0, T: 0, K: 0 });
assert.equal(descriptive.metrics.USER_EDIT_RATE_AFTER_FULL_CORRECTION.numerator, 1);
assert.equal(descriptive.metrics.FINAL_FIELD_ACCURACY.status, "N/A");
const unknownCase = evaluateFinalTradeReviewDataset({ observations: [makeExport({ labelFields: [],
  decisions: { yield: "USER_MARKED_UNKNOWN" }, final: { yield: null } })] });
assert.equal(unknownCase.metrics.UNKNOWN_FIELD_COUNT.count, 1);
assert.equal(unknownCase.metrics.UNKNOWN_ROW_COUNT.count, 1);
const classificationCases = ["FINAL_READY", "NEEDS_REVIEW", "NEEDS_RECAPTURE", "CONFLICT"].map((classification, index) =>
  makeExport({ labelFields: [], classification, family: `class-${index}`, observationKey: `class-row-${index}` }));
const classifications = evaluateFinalTradeReviewDataset({ observations: classificationCases });
assert.equal(classifications.denominators.R, 4);
for (const classification of ["FINAL_READY", "NEEDS_REVIEW", "NEEDS_RECAPTURE", "CONFLICT"]) {
  assert.deepEqual(classifications.metrics[`${classification}_RATE`], { numerator: 1, denominator: 4, rate: "0.250000", status: "AVAILABLE" });
}

const split = splitManifest([{ sourceFamilyId: "family-independent", cohort: "INDEPENDENT" }]);
const edited = makeExport({ decisions: { yield: "USER_EDITED" }, corrected: { yield: 49 }, final: { yield: 48 }, splitManifestHash: split.manifestHash });
const independent = evaluateTradeReviewDataset({ observations: [edited], evaluationPolicyVersion: "trade-final-review-evaluation-v3", splitManifest: split });
assert.equal(independent.evaluationStatus, "VALID_INDEPENDENT_EVALUATION", JSON.stringify(independent.invalidReasons));
assert.equal(independent.denominators.V, 6);
assert.equal(independent.metrics.FINAL_FIELD_ACCURACY.numerator, 5);
assert.equal(independent.metrics.POST_REVIEW_OPERATIONAL_EXACT.numerator, 6);
assert.equal(independent.metrics.USER_EDIT_RATE_AFTER_FULL_CORRECTION.numerator, 1);
assert.equal(independent.metrics.RAW_NUMERIC_EXACT.numerator, 3, "count=0 is a valid exact raw numeric");
assert.equal(independent.metrics.CORRECTION_HARM.numerator, 1);

const sameSourceDifferentCapture = makeExport({ family: "family-independent", observationKey: "same-family-recapture",
  truths: { island: "다른 정답" }, splitManifestHash: split.manifestHash });
const disputedCrop = evaluateFinalTradeReviewDataset({ observations: [edited, sameSourceDifferentCapture], splitManifest: split });
assert.equal(disputedCrop.evaluationStatus, "VALID_INDEPENDENT_EVALUATION");
assert.equal(disputedCrop.denominators.V, 10, "conflicting known labels for one physical crop are excluded from logical truth");
assert.equal(disputedCrop.denominators.K, 5, "the disputed physical crop is excluded and duplicate crops count once");
assert.equal(disputedCrop.coverage.disputedFieldCount, 2);
const renamedSplit = splitManifest([{ sourceFamilyId: "family-independent", cohort: "INDEPENDENT" },
  { sourceFamilyId: "renamed-independent-family", cohort: "INDEPENDENT" }]);
const renamedCrop = makeExport({ family: "renamed-independent-family", splitManifestHash: renamedSplit.manifestHash });
assert.equal(evaluateFinalTradeReviewDataset({ observations: [edited, renamedCrop], splitManifest: renamedSplit }).evaluationStatus,
  "INVALID_EVALUATION", "the same physical crop cannot be laundered through a new sourceFamilyId");

const rawWrongCorrected = makeExport({ raw: { island: "해모섬" }, corrected: { island: "해모 섬" }, splitManifestHash: split.manifestHash });
const recovery = evaluateFinalTradeReviewDataset({ observations: [rawWrongCorrected], splitManifest: split });
assert.equal(recovery.metrics.CORRECTION_RECOVERY.numerator, 1);
const rawCorrectWrong = makeExport({ corrected: { toItem: "잘못된 품목" }, splitManifestHash: split.manifestHash });
const harm = evaluateFinalTradeReviewDataset({ observations: [rawCorrectWrong], splitManifest: split });
assert.equal(harm.metrics.CORRECTION_HARM.numerator, 1);

assert.equal(evaluateFinalTradeReviewDataset({ observations: [edited] }).evaluationStatus, "INVALID_EVALUATION",
  "independent truth must not be evaluated without frozen split manifest");
const mismatch = splitManifest([{ sourceFamilyId: "family-independent", cohort: "DEVELOPMENT" }]);
assert.equal(evaluateFinalTradeReviewDataset({ observations: [edited], splitManifest: mismatch }).evaluationStatus, "INVALID_EVALUATION");
const tampered = structuredClone(edited); tampered.semantic.dataset.rows[0].fields[0].truthValue = "tampered";
assert.equal(evaluateFinalTradeReviewDataset({ observations: [tampered], splitManifest: split }).evaluationStatus, "INVALID_EVALUATION");
const badCompletionConfirmation = structuredClone(noLabels);
badCompletionConfirmation.semantic.observation.completion.batchConfirmation.completionValuesHash = hex(777);
resignExport(badCompletionConfirmation);
assert.equal(evaluateFinalTradeReviewDataset({ observations: [badCompletionConfirmation] }).evaluationStatus, "INVALID_EVALUATION",
  "a rehashed Export3 cannot hide a stale Completion3 confirmation hash");
const changedMaster = structuredClone(noLabels);
changedMaster.semantic.observation.sourceContext.masterBundle.snapshot.provenance.purpose = "tampered";
resignExport(changedMaster);
assert.equal(evaluateFinalTradeReviewDataset({ observations: [changedMaster] }).evaluationStatus, "INVALID_EVALUATION",
  "Master Bundle2 semantic content is revalidated, not only its claimed contentHash");
assert.equal(evaluateFinalTradeReviewDataset({ observations: [edited, { schemaVersion: 1 }], splitManifest: split }).evaluationStatus,
  "INVALID_EVALUATION", "Export1/Export3 input is rejected instead of mixed");

const tempDir = await mkdtemp(path.join(os.tmpdir(), "trade-final-eval-v3-"));
try {
  await writeFile(path.join(tempDir, "export.json"), JSON.stringify(edited));
  await writeFile(path.join(tempDir, "split.json"), JSON.stringify(split));
  await writeFile(path.join(tempDir, "manifest.json"), JSON.stringify({ schemaVersion: 1,
    evaluationPolicyVersion: "trade-final-review-evaluation-v3", splitManifestPath: "split.json",
    observations: [{ exportPath: "export.json" }] }));
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../tools/trade_review_evaluation.mjs");
  const output = path.join(tempDir, "report.json");
  const result = spawnSync(process.execPath, [cli, "--manifest", path.join(tempDir, "manifest.json"), "--out", output], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(output, "utf8")).evaluationStatus, "VALID_INDEPENDENT_EVALUATION");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("trade_final_evaluation_regression: PASS · Export3 integrity, truth/split binding, raw/correction/final metrics, retained/edit separation, count=0");
