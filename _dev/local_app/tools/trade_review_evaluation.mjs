#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReviewedTradeBatch } from "../frontend/js/domain/reviewed-trade-dto.js";
import { masterBundleContentHash, validateMasterBundleV2 } from "../frontend/js/domain/trade-master-bundle.js";
import { registrySnapshotSha256 } from "../frontend/js/domain/trade-master-registry.js";

const FIELDS = Object.freeze(["island", "fromItem", "reqAmount", "toItem", "count", "yield"]);
const IDENTITY = new Set(["island", "fromItem", "toItem"]);
const NUMERIC = new Set(["reqAmount", "count", "yield"]);
const MINIMUM = Object.freeze({ reqAmount: 1, count: 0, yield: 1 });
const METHODS = new Set(["USER_BATCH_CONFIRMED_UNCHANGED", "USER_EDITED", "USER_MARKED_UNKNOWN"]);
const COHORTS = new Set(["DEVELOPMENT", "INDEPENDENT", "UNASSIGNED"]);
const EVALUATION_POLICY = "trade-review-evaluation-v1";
const RAW_POLICY = "trade-raw-eval-v1";
const DTO_POLICY = "reviewed-trade-dto-mapping-v1";
const HASH = /^[0-9a-f]{64}$/i;
const TAXONOMY = Object.freeze(["RECOGNITION_ERROR", "CORRECTION_ERROR", "MASTER_DISAGREEMENT", "NUMERIC_INCOMPLETE",
  "ROW_DETECTION_ERROR", "CAPTURE_INCOMPLETE", "DUPLICATE_CONFLICT", "USER_UNKNOWN", "OTHER"]);
const HASH_BASIS = "NODE_SORTED_JSON_UTF8_SHA256_V1";

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function assert(condition, message) { if (!condition) throw new TypeError(message); }
function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }
function validHash(value) { return typeof value === "string" && HASH.test(value); }
function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function stable(value, ancestors = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("semantic data contains a non-finite number");
    return JSON.stringify(value);
  }
  if (!Array.isArray(value) && !isRecord(value)) throw new TypeError("semantic data must be JSON values");
  if (ancestors.has(value)) throw new TypeError("semantic data contains a cycle");
  ancestors.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((item) => stable(item, ancestors)).join(",")}]`
    : `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${stable(value[key], ancestors)}`).join(",")}}`;
  ancestors.delete(value);
  return result;
}
export function semanticEvaluationSha256(value) {
  return createHash("sha256").update(stable(value), "utf8").digest("hex");
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function equal(a, b) { return stable(a) === stable(b); }
function ratio(numerator, denominator) {
  return { numerator, denominator, rate: denominator === 0 ? null : numerator / denominator,
    status: denominator === 0 ? "N/A" : "AVAILABLE" };
}
function count(value) { return { count: value }; }
function riskCodes(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => typeof item === "string" ? item : item?.code).filter(nonempty))].sort(compareText);
}
function checkedRaw(field, key) {
  const raw = field.rawEvidence;
  if (!isRecord(raw)) return { available: false, value: null };
  if (IDENTITY.has(key)) {
    const value = nonempty(raw.normalizedText) ? raw.normalizedText : nonempty(raw.rawText) ? raw.rawText : null;
    return { available: value !== null, value };
  }
  const value = raw.rawNumericCandidate;
  const valid = Number.isSafeInteger(value) && value >= MINIMUM[key];
  return { available: valid, value: valid ? value : null };
}
function predictionKey(observationId, projectionRowId, field) { return `${observationId}\0${projectionRowId}\0${field}`; }
function dtoReceipt(observation) {
  return { schemaVersion: 1, observationId: observation.observationId, mutationId: observation.mutationId,
    payloadHash: observation.payloadHash, observationHash: observation.observationHash, persistedAt: observation.persistedAt,
    duplicate: false, evidenceSaved: true, sessionApplied: false, cropPolicy: observation.cropPlan.policy };
}
function expectedReview(observation) {
  const completion = observation.completion;
  return { observationId: observation.observationId, mutationId: observation.mutationId,
    recognitionBatchId: completion.recognitionBatchId, projectionHash: completion.projectionHash,
    registryVersion: completion.registryVersion, correctionVersion: completion.correctionVersion,
    reviewRevision: completion.reviewRevision, confirmationRevision: observation.confirmationRevision };
}
function exportParts(exportRecord) {
  assert(isRecord(exportRecord) && exportRecord.schemaVersion === 1 && exportRecord.exportType === "TRADE_REVIEW_OBSERVATION"
    && validHash(exportRecord.semanticHash) && nonempty(exportRecord.generatedAt), "invalid R006 export envelope");
  const semantic = exportRecord.semantic;
  assert(isRecord(semantic) && isRecord(semantic.manifest) && isRecord(semantic.observation)
    && isRecord(semantic.dataset) && Array.isArray(semantic.dataset.fields)
    && Array.isArray(semantic.dataset.edgeSegments), "invalid R006 semantic export");
  const manifest = semantic.manifest; const observation = semantic.observation;
  assert(manifest.observationSchemaVersion === 1 && manifest.sidecarSchemaVersion === 2
    && manifest.observationHash === observation.observationHash && manifest.payloadHash === observation.payloadHash
    && validHash(observation.observationHash) && validHash(observation.payloadHash), "R006 export manifest binding mismatch");
  assert(nonempty(observation.observationId) && nonempty(observation.mutationId)
    && Array.isArray(observation.completion?.rows) && Array.isArray(observation.completion?.edgeSegments)
    && isRecord(observation.sourceContext) && isRecord(observation.cropPlan), "incomplete embedded observation");
  assert(equal(semantic.dataset.edgeSegments, observation.completion.edgeSegments.map((item) => ({ ...item, sixFieldTruth: false }))),
    "edge segment export does not match completion");
  const projection = observation.sourceContext.projection?.snapshot;
  assert(isRecord(projection) && Array.isArray(projection.rows), "missing frozen projection");
  const projectedById = new Map(projection.rows.map((row) => [row.projectionRowId, row]));
  const reviewedById = new Map(observation.completion.rows.map((row) => [row.projectionRowId, row]));
  assert(projectedById.size === projection.rows.length && reviewedById.size === observation.completion.rows.length,
    "duplicate projection row identity");
  assert(semantic.dataset.fields.length === observation.completion.rows.length * FIELDS.length,
    "export must contain six fields per reviewed logical row");
  const seen = new Set(); const fields = [];
  for (const exported of semantic.dataset.fields) {
    assert(isRecord(exported) && nonempty(exported.projectionRowId) && FIELDS.includes(exported.field), "invalid exported field identity");
    const key = predictionKey(observation.observationId, exported.projectionRowId, exported.field);
    assert(!seen.has(key), "duplicate exported field"); seen.add(key);
    const reviewed = reviewedById.get(exported.projectionRowId);
    const projected = projectedById.get(exported.projectionRowId);
    const completedField = reviewed?.fields?.find((item) => item.field === exported.field);
    const projectedField = projected?.fields?.[exported.field];
    assert(completedField && projectedField && METHODS.has(completedField.verificationMethod), "export field is not backed by reviewed evidence");
    for (const [exportKey, sourceKey] of [["rawEvidence", "rawEvidence"], ["candidate", "candidate"],
      ["shownValueBefore", "shownValueBefore"], ["finalValue", "finalValue"], ["verificationMethod", "verificationMethod"], ["risk", "riskReasons"]]) {
      const expected = sourceKey === "riskReasons" ? completedField.riskReasons : completedField[sourceKey];
      assert(equal(exported[exportKey], expected), `R006 exported ${exportKey} differs from human observation`);
    }
    assert(exported.truthStatus === (completedField.verificationMethod === "USER_MARKED_UNKNOWN" ? "HUMAN_DECLARED_UNKNOWN" : "HUMAN_DECLARED_VALUE")
      && exported.knownTruthEligible === (completedField.verificationMethod !== "USER_MARKED_UNKNOWN"), "truth status mismatch");
    fields.push({ observationId: observation.observationId, projectionRowId: exported.projectionRowId, field: exported.field,
      rawEvidence: exported.rawEvidence, candidate: exported.candidate, shownValueBefore: exported.shownValueBefore,
      finalValue: exported.finalValue, verificationMethod: exported.verificationMethod,
      method: exported.verificationMethod,
      riskReasons: clone(exported.risk), truthStatus: exported.truthStatus, projectionStatus: projectedField.status,
      alternatives: Array.isArray(projectedField.alternatives) ? projectedField.alternatives : [],
      cohort: null, projectionRow: projected, projectionField: projectedField });
  }
  assert(seen.size === observation.completion.rows.length * FIELDS.length, "review fields are incomplete");
  const analysisAttributions = semantic.dataset.analysisAttributions ?? [];
  assert(Array.isArray(analysisAttributions), "analysisAttributions must be an array");
  return { semantic, observation, projection, fields, analysisAttributions };
}
function validateCandidateRuns(candidateRuns, observationMap) {
  assert(Array.isArray(candidateRuns), "candidateRuns must be an array");
  const ids = new Set(); const results = [];
  for (const run of candidateRuns) {
    assert(isRecord(run) && Object.keys(run).sort().join("\0") === ["candidateId", "policyVersion", "sourceSha256", "predictions"].sort().join("\0"),
      "candidate run must have exactly candidateId, policyVersion, sourceSha256, predictions");
    assert(nonempty(run.candidateId) && nonempty(run.policyVersion) && validHash(run.sourceSha256) && Array.isArray(run.predictions), "invalid candidate run metadata");
    assert(!ids.has(run.candidateId), "duplicate candidateId"); ids.add(run.candidateId);
    const predictions = new Map();
    for (const prediction of run.predictions) {
      assert(isRecord(prediction) && Object.keys(prediction).sort().join("\0") === ["observationId", "projectionRowId", "field", "value", "highlighted"].sort().join("\0"),
        "candidate prediction has unexpected or truth-bearing fields");
      assert(nonempty(prediction.observationId) && nonempty(prediction.projectionRowId) && FIELDS.includes(prediction.field)
        && typeof prediction.highlighted === "boolean", "invalid candidate prediction");
      if (IDENTITY.has(prediction.field)) assert(prediction.value === null || nonempty(prediction.value), "invalid identity candidate value");
      else assert(prediction.value === null || Number.isSafeInteger(prediction.value) && prediction.value >= MINIMUM[prediction.field], "invalid numeric candidate value");
      const parent = observationMap.get(prediction.observationId);
      assert(parent && parent.projectionIds.has(prediction.projectionRowId), "candidate prediction references unknown row");
      const key = predictionKey(prediction.observationId, prediction.projectionRowId, prediction.field);
      assert(!predictions.has(key), "duplicate candidate prediction");
      predictions.set(key, { value: prediction.value, highlighted: prediction.highlighted });
    }
    results.push({ candidateId: run.candidateId, policyVersion: run.policyVersion, sourceSha256: run.sourceSha256, predictions });
  }
  return results.sort((a, b) => compareText(a.candidateId, b.candidateId));
}
function evidenceKeys(item) {
  const keys = [];
  for (const capture of item.observation.sourceContext.captures ?? []) {
    const metadata = capture.metadata ?? {};
    const sessionId = metadata.context?.sessionId;
    if (nonempty(sessionId)) keys.push(["SHARED_SESSION_ID", sessionId]);
    if (validHash(capture.sourceSha256)) keys.push(["SHARED_SOURCE_SHA256", capture.sourceSha256.toLowerCase()]);
    if (validHash(capture.bitmapSha256)) keys.push(["SHARED_BITMAP_SHA256", capture.bitmapSha256.toLowerCase()]);
    if (nonempty(capture.captureId)) item.captureIds.add(capture.captureId);
  }
  return [...new Map(keys.map(([kind, value]) => [`${kind}\0${value}`, [kind, value]])).values()];
}
function buildEvidenceGroups(items, splitSeed) {
  const parent = items.map((_, i) => i);
  const find = (n) => parent[n] === n ? n : (parent[n] = find(parent[n]));
  const union = (a, b) => { const x = find(a); const y = find(b); if (x !== y) parent[y] = x; };
  const owners = new Map(); const keysByItem = items.map((item, index) => {
    const keys = evidenceKeys(item);
    keys.push(["SAME_OBSERVATION", `${item.observation.observationId}\0${item.observation.observationHash}`]);
    for (const [kind, value] of keys) {
      const key = `${kind}\0${value}`;
      if (owners.has(key)) union(index, owners.get(key)); else owners.set(key, index);
    }
    return keys;
  });
  const components = new Map();
  items.forEach((item, index) => { const root = find(index); const group = components.get(root) ?? []; group.push(item); components.set(root, group); });
  const groups = [];
  for (const members of components.values()) {
    const observationRefs = members.map((item) => `${item.observation.observationId}:${item.observation.observationHash}`).sort(compareText);
    const groupId = `evidence-group:${semanticEvaluationSha256(observationRefs)}`;
    const cohorts = [...new Set(members.flatMap((item) => item.cohorts))].sort(compareText);
    const developmentIndependentLeakage = cohorts.includes("DEVELOPMENT") && cohorts.includes("INDEPENDENT");
    const reasons = new Set();
    for (const item of members) for (const [kind] of keysByItem[items.indexOf(item)]) reasons.add(kind);
    const groupCohort = cohorts.includes("INDEPENDENT") && !cohorts.includes("DEVELOPMENT") ? "INDEPENDENT"
      : cohorts.includes("DEVELOPMENT") ? "DEVELOPMENT" : "UNASSIGNED";
    const internalSplit = groupCohort === "DEVELOPMENT"
      ? (Number.parseInt(createHash("sha256").update(`${splitSeed}\0${groupId}`).digest("hex")[0], 16) % 2 === 0 ? "DEVELOPMENT_REPLAY_A" : "DEVELOPMENT_REPLAY_B") : null;
    groups.push({ groupId, observationRefs, cohortLabels: cohorts, cohort: groupCohort,
      captureIds: [...new Set(members.flatMap((item) => [...item.captureIds]))].sort(compareText),
      linkageReasons: [...reasons].sort(compareText), internalSplit,
      splitLeakage: developmentIndependentLeakage });
  }
  return groups.sort((a, b) => compareText(a.groupId, b.groupId));
}
function fieldMetrics(fields) {
  const known = fields.filter((field) => field.known);
  const edits = known.filter((field) => field.method === "USER_EDITED");
  const unknown = fields.filter((field) => !field.known);
  const baselineCorrect = known.filter((field) => field.shownCorrect);
  const rawWrong = known.filter((field) => !field.rawCorrect);
  const rawCorrect = known.filter((field) => field.rawCorrect);
  const unhighlighted = known.filter((field) => !field.highlighted);
  const numericFields = fields.filter((field) => NUMERIC.has(field.field));
  const numericRisk = numericFields.filter((field) => field.highlighted);
  const numericEdits = numericFields.filter((field) => field.method === "USER_EDITED");
  const numericUnknown = numericFields.filter((field) => field.method === "USER_MARKED_UNKNOWN");
  const numericUnion = new Set([...numericRisk, ...numericEdits, ...numericUnknown].map((field) => predictionKey(field.observationId, field.projectionRowId, field.field))).size;
  const comparable = known.filter((field) => IDENTITY.has(field.field) && (field.candidate !== null || field.alternatives.length > 0 || field.projectionStatus === "MASTER_DISAGREEMENT"));
  const disagreement = comparable.filter((field) => field.masterDisagreement);
  const unhighlightedUnknown = unknown.filter((field) => !field.highlighted);
  return {
    PRE_REVIEW_FINAL_CANDIDATE_CORRECTNESS: ratio(baselineCorrect.length, known.length),
    USER_EDIT_RATE: ratio(edits.length, known.length),
    ROWS_REQUIRING_EDIT: ratio(new Set(edits.map((field) => `${field.observationId}\0${field.projectionRowId}`)).size,
      new Set(fields.map((field) => `${field.observationId}\0${field.projectionRowId}`)).size),
    FIELDS_REQUIRING_EDIT: { count: edits.length, rate: ratio(edits.length, known.length), byField: Object.fromEntries(FIELDS.map((key) => [key, count(edits.filter((field) => field.field === key).length)])) },
    CORRECTION_RECOVERY_RATE: ratio(rawWrong.filter((field) => field.shownCorrect).length, rawWrong.length),
    CORRECTION_HARM_RATE: ratio(rawCorrect.filter((field) => !field.shownCorrect).length, rawCorrect.length),
    UNHIGHLIGHTED_ERROR_RATE: ratio(unhighlighted.filter((field) => field.method === "USER_EDITED").length, unhighlighted.length),
    unhighlightedUnknownCount: unhighlightedUnknown.length,
    MASTER_DISAGREEMENT_RATE: ratio(disagreement.length, comparable.length),
    masterCounts: { registryComparable: comparable.length, masterDisagreement: disagreement.length,
      identityUnmapped: known.filter((field) => IDENTITY.has(field.field) && field.mappingUnmapped).length,
      verifiedAliasOnly: known.filter((field) => IDENTITY.has(field.field) && field.verifiedAliasOnly).length },
    NUMERIC_REVIEW_RATE: { ...ratio(numericUnion, numericFields.length), riskCount: numericRisk.length,
      editedCount: numericEdits.length, unknownCount: numericUnknown.length, unionCount: numericUnion },
  };
}
function dtoMetric(results) {
  const errors = results.flatMap((entry) => entry.result.batchErrors.map((error) => ({ observationId: entry.observationId, ...error })));
  if (errors.length) return { includingExplicitExclusions: { numerator: null, denominator: null, rate: null, status: "N/A" },
    excludingExplicitExclusions: { numerator: null, denominator: null, rate: null, status: "N/A" }, batchErrors: errors };
  let outputs = 0; let held = 0; let excluded = 0;
  for (const { result } of results) { outputs += result.rows.length; held += result.heldRows.length; excluded += result.excludedRows.length; }
  return { includingExplicitExclusions: ratio(outputs, outputs + held + excluded),
    excludingExplicitExclusions: ratio(outputs, outputs + held), batchErrors: [] };
}
function candidateComparison(run, fields) {
  const known = fields.filter((field) => field.known);
  let correct = 0; let covered = 0; let improvements = 0; let regressions = 0; let unchangedCorrect = 0; let unchangedWrong = 0;
  let rawWrong = 0; let recovered = 0; let rawCorrect = 0; let harmed = 0; let unhighlighted = 0; let unhighlightedErrors = 0;
  for (const field of known) {
    const prediction = run.predictions.get(predictionKey(field.observationId, field.projectionRowId, field.field));
    const candidateCorrect = Boolean(prediction) && equal(prediction.value, field.finalValue);
    if (prediction) covered += 1;
    if (candidateCorrect) correct += 1;
    if (!field.rawCorrect) { rawWrong += 1; if (candidateCorrect) recovered += 1; }
    else { rawCorrect += 1; if (!candidateCorrect) harmed += 1; }
    if (!field.shownCorrect && candidateCorrect) improvements += 1;
    else if (field.shownCorrect && !candidateCorrect) regressions += 1;
    if (field.shownCorrect && candidateCorrect) unchangedCorrect += 1;
    if (!field.shownCorrect && !candidateCorrect) unchangedWrong += 1;
    if (prediction && !prediction.highlighted) { unhighlighted += 1; if (!candidateCorrect) unhighlightedErrors += 1; }
  }
  return { candidateId: run.candidateId, policyVersion: run.policyVersion, sourceSha256: run.sourceSha256,
    candidateReplayAuthority: "CALLER_ATTESTED_OFFLINE_REPLAY",
    candidateCorrectness: ratio(correct, known.length), predictionCoverage: ratio(covered, known.length),
    improvementCount: improvements, regressionCount: regressions, unchangedCorrectCount: unchangedCorrect,
    unchangedWrongCount: unchangedWrong, recoveryRate: ratio(recovered, rawWrong), harmRate: ratio(harmed, rawCorrect),
    unhighlightedErrorRate: ratio(unhighlightedErrors, unhighlighted) };
}
function safeSourceAttribution(item) {
  const blocked = /(base64|png.?bytes|image.?bytes|image.?data|screenshot.?bytes|crop.?bytes|dataurl|raw.?bytes|blob.?data)/i;
  const visit = (value) => {
    if (Array.isArray(value)) return value.map(visit);
    if (typeof value === "string" && (value.startsWith("data:image/") || value.startsWith("iVBOR")
        || value.length >= 128 && /^[A-Za-z0-9+/]+={0,2}$/.test(value))) {
      return { redactedContentSha256: semanticEvaluationSha256(value) };
    }
    if (!isRecord(value)) return value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if (blocked.test(key) && !/(sha256|hash|geometry|path|ref|id)$/i.test(key)) {
        output[`${key}Sha256`] = semanticEvaluationSha256(child); continue;
      }
      output[key] = visit(child);
    }
    return output;
  };
  return visit(item);
}
function safeReportValue(value) {
  if (typeof value !== "string") return value;
  if (value.startsWith("data:image/") || value.startsWith("iVBOR")
      || value.length >= 128 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return { redactedContentSha256: semanticEvaluationSha256(value) };
  }
  return value;
}
function buildTaxonomy(fields, items) {
  const attributions = [];
  const add = (type, field, evidenceRef, explanation) => attributions.push({ type, ...evidenceRef, explanation });
  const rowDetectionCodes = new Set(["ROW_DETECTION_ERROR", "ROW_GEOMETRY_INVALID", "ROW_GEOMETRY_UNCERTAIN"]);
  for (const field of fields) {
    const ref = { observationId: field.observationId, projectionRowId: field.projectionRowId, field: field.field };
    const codes = new Set([...riskCodes(field.riskReasons), ...riskCodes(field.projectionField.reasonCodes),
      ...riskCodes(field.projectionRow.reasonCodes), ...riskCodes(field.projectionRow.originalRowEvidence?.reasonCodes)]);
    if (!field.known) add("USER_UNKNOWN", field.field, ref, "사용자가 이 필드를 모름으로 표시했습니다.");
    if (field.masterDisagreement) add("MASTER_DISAGREEMENT", field.field, ref, "projection status 또는 risk evidence가 Master disagreement를 명시합니다.");
    if (field.duplicateConflict) add("DUPLICATE_CONFLICT", field.field, ref, "reconciliation 또는 R008 conflict evidence가 있습니다.");
    if (field.known && field.rawCorrect && !field.shownCorrect) add("CORRECTION_ERROR", field.field, ref, "raw evaluation은 맞았지만 pre-review shown candidate가 human truth와 다릅니다.");
    if (field.known && !field.rawCorrect && !field.shownCorrect) add("RECOGNITION_ERROR", field.field, ref, "raw value가 틀리거나 없고 pre-review candidate도 human truth와 다릅니다.");
    if (NUMERIC.has(field.field) && ["USER_EDITED", "USER_MARKED_UNKNOWN"].includes(field.method)
        && [...codes].some((code) => /NUMERIC_(MISSING|INCOMPLETE|COMPLETENESS)|INVALID_NUMERIC/.test(code))) {
      add("NUMERIC_INCOMPLETE", field.field, ref, "숫자 raw 후보가 없거나 numeric completeness/missing risk와 edit/unknown evidence가 함께 있습니다.");
    }
    if ([...codes].some((code) => rowDetectionCodes.has(code)) || field.projectionRow.rowDetectionError === true
        || field.projectionRow.rowDetectionStatus === "ERROR") {
      add("ROW_DETECTION_ERROR", field.field, ref, "source row에 명시적인 detection/geometry error evidence가 있습니다.");
    }
  }
  for (const item of items) for (const projectionRowId of item.r008ConflictProjectionIds ?? []) {
    add("DUPLICATE_CONFLICT", null, { observationId: item.observation.observationId, projectionRowId, field: null },
      "R008 validator가 logical row에 collision/conflict를 보고했습니다.");
  }
  for (const item of items) {
    const edges = item.semantic.dataset.edgeSegments;
    edges.forEach((edge, index) => add("CAPTURE_INCOMPLETE", null,
      { observationId: item.observation.observationId, projectionRowId: null, field: null, edgeIndex: index,
        captureId: edge.captureId ?? null }, "R006 export에 six-field truth가 아닌 edge segment가 있습니다."));
  }
  const knownFieldKeys = new Set(attributions.filter((item) => item.projectionRowId)
    .map((item) => `${item.observationId}\0${item.projectionRowId}\0${item.field}`));
  for (const field of fields) {
    if (field.known && field.method === "USER_EDITED"
        && !knownFieldKeys.has(predictionKey(field.observationId, field.projectionRowId, field.field))) {
      attributions.push({ type: "OTHER", observationId: field.observationId, projectionRowId: field.projectionRowId,
        field: field.field, explanation: "known edit가 있지만 export된 evidence만으로 원인을 분류할 수 없습니다." });
    }
  }
  const sourceAttributions = items.flatMap((item) => item.analysisAttributions.map(safeSourceAttribution));
  attributions.sort((a, b) => compareText(a.observationId, b.observationId) || compareText(a.projectionRowId ?? "", b.projectionRowId ?? "")
    || compareText(a.field ?? "", b.field ?? "") || compareText(a.type, b.type) || compareText(a.explanation, b.explanation));
  const counts = Object.fromEntries(TAXONOMY.map((type) => [type, attributions.filter((item) => item.type === type).length]));
  return { sourceAttributions, derivedAttributions: attributions, counts };
}
function proposalsFrom(attributions, fields, candidateRuns) {
  const typeMap = { CORRECTION_ERROR: "CORRECTION_RULE_REVIEW", MASTER_DISAGREEMENT: "MASTER_RELATION_REVIEW",
    NUMERIC_INCOMPLETE: "NUMERIC_READER_REVIEW", RECOGNITION_ERROR: "CAPTURE_ROW_REVIEW",
    ROW_DETECTION_ERROR: "CAPTURE_ROW_REVIEW", CAPTURE_INCOMPLETE: "CAPTURE_ROW_REVIEW",
    DUPLICATE_CONFLICT: "CAPTURE_ROW_REVIEW", USER_UNKNOWN: "CAPTURE_ROW_REVIEW", OTHER: "CAPTURE_ROW_REVIEW" };
  const byKey = new Map(fields.map((field) => [predictionKey(field.observationId, field.projectionRowId, field.field), field]));
  const groups = new Map();
  for (const attribution of attributions) {
    const type = typeMap[attribution.type]; if (!type) continue;
    const field = attribution.projectionRowId ? byKey.get(predictionKey(attribution.observationId, attribution.projectionRowId, attribution.field)) : null;
    const pattern = { failureType: attribution.type, field: attribution.field ?? null,
      rawValue: safeReportValue(field?.raw.value ?? null), shownValueBefore: safeReportValue(field?.shownValueBefore ?? null),
      finalValue: field?.known ? safeReportValue(field.finalValue) : null, riskCodes: field ? riskCodes(field.riskReasons) : [] };
    const key = stable([type, attribution.field ?? null, pattern]);
    const entry = groups.get(key) ?? { type, field: attribution.field ?? null, pattern, refs: new Map(), runIds: new Set() };
    const refKey = stable({ observationId: attribution.observationId, projectionRowId: attribution.projectionRowId ?? null,
      field: attribution.field ?? null, edgeIndex: attribution.edgeIndex ?? null });
    entry.refs.set(refKey, { observationId: attribution.observationId, projectionRowId: attribution.projectionRowId ?? null,
      field: attribution.field ?? null, ...(attribution.edgeIndex === undefined ? {} : { edgeIndex: attribution.edgeIndex }),
      ...(attribution.captureId ? { captureId: attribution.captureId } : {}) });
    for (const run of candidateRuns) if (attribution.projectionRowId && run.predictions.has(predictionKey(attribution.observationId, attribution.projectionRowId, attribution.field))) entry.runIds.add(run.candidateId);
    groups.set(key, entry);
  }
  return [...groups.values()].map((entry) => {
    const observedPattern = entry.pattern;
    const proposalId = `curation:${semanticEvaluationSha256([entry.type, entry.field, observedPattern])}`;
    const evidenceRefs = [...entry.refs.values()].sort((a, b) => compareText(a.observationId, b.observationId)
      || compareText(a.projectionRowId ?? "", b.projectionRowId ?? "") || compareText(a.field ?? "", b.field ?? ""));
    return { proposalId, type: entry.type, field: entry.field, evidenceRefs, observedPattern,
      supportCount: evidenceRefs.length, candidateRunRefs: [...entry.runIds].sort(compareText),
      requiresManualCuration: true, proposedMutation: null };
  }).sort((a, b) => b.supportCount - a.supportCount || compareText(a.type, b.type)
    || compareText(a.field ?? "", b.field ?? "") || compareText(stable(a.observedPattern), stable(b.observedPattern)));
}
function finalizeField(field, dtoState) {
  const raw = checkedRaw(field, field.field);
  const known = field.method !== "USER_MARKED_UNKNOWN";
  const finalValue = known ? field.finalValue : null;
  const shownCorrect = known && field.shownValueBefore !== null && field.shownValueBefore !== undefined
    && equal(field.shownValueBefore, finalValue);
  const rawCorrect = known && raw.available && equal(raw.value, finalValue);
  const codes = new Set(riskCodes(field.riskReasons));
  const status = field.projectionStatus;
  const highlighted = field.riskReasons.length > 0 || ["AMBIGUOUS", "UNMATCHED", "MASTER_DISAGREEMENT"].includes(status);
  const masterDisagreement = IDENTITY.has(field.field) && (status === "MASTER_DISAGREEMENT"
    || codes.has("MASTER_DISAGREEMENT") || codes.has("MASTER_NAME_DISPUTED"));
  const duplicateConflict = codes.has("RECONCILIATION_CONFLICT") || status === "CONFLICT";
  const mapping = dtoState.mappingByProjection.get(field.projectionRowId)?.[field.field] ?? null;
  const mappingUnmapped = IDENTITY.has(field.field) && (!mapping || mapping.mappingMethod === "NO_SAFE_MAPPING");
  const verifiedAliasOnly = IDENTITY.has(field.field) && mapping?.mappingMethod === "VERIFIED_ENTITY_COMPATIBILITY"
    && mapping.verifiedNameEvidence?.status === "VERIFIED";
  return { ...field, known, finalValue, raw, rawCorrect, shownCorrect, highlighted, masterDisagreement,
    duplicateConflict, mappingUnmapped, verifiedAliasOnly };
}
function r008Replay(item, exclusions) {
  const result = validateReviewedTradeBatch({ storedObservation: item.observation, evidenceReceipt: dtoReceipt(item.observation),
    expectedReview: expectedReview(item.observation), exclusions, mappingPolicyVersion: DTO_POLICY });
  const conflictProjectionIds = new Set();
  for (const outputRow of [...result.rows, ...result.heldRows]) {
    for (const reason of outputRow.heldReasons ?? []) if (["INPUT_CONFLICT", "NUMERIC_CONFLICT"].includes(reason.code)) conflictProjectionIds.add(outputRow.projectionRowId);
  }
  for (const group of result.conflictGroups ?? []) for (const id of group.projectionRowIds ?? []) conflictProjectionIds.add(id);
  for (const row of item.projection.rows) if (row.reconciliationStatus === "CONFLICT") conflictProjectionIds.add(row.projectionRowId);
  const mappings = new Map();
  for (const row of [...result.rows, ...result.heldRows]) {
    mappings.set(row.projectionRowId, row.mappingEvidence ?? {});
    for (const id of row.memberProjectionRowIds ?? []) mappings.set(id, row.mappingEvidence ?? {});
  }
  return { result, mappingByProjection: mappings, conflictProjectionIds };
}
function analyzeObservation(item, suppliedExclusions) {
  item.fields = item.fields.map((field) => ({ ...field, cohort: item.cohort }));
  const baseReplay = r008Replay(item, []); const suppliedReplay = r008Replay(item, suppliedExclusions);
  const dtoState = { mappingByProjection: baseReplay.mappingByProjection };
  const fields = item.fields.map((field) => finalizeField(field, dtoState));
  item.r008ConflictProjectionIds = [...baseReplay.conflictProjectionIds].sort(compareText);
  const truthRows = new Map();
  for (const field of fields) {
    const group = truthRows.get(field.projectionRowId) ?? [];
    group.push(field); truthRows.set(field.projectionRowId, group);
  }
  let truthCompleteRows = 0; let sixFieldExact = 0;
  for (const rowFields of truthRows.values()) {
    const known = rowFields.length === FIELDS.length && rowFields.every((field) => field.known);
    const mapping = baseReplay.mappingByProjection.get(rowFields[0]?.projectionRowId);
    const mappingKnown = IDENTITY.size === 3 && [...IDENTITY].every((key) => mapping?.[key]
      && mapping[key].mappingMethod !== "NO_SAFE_MAPPING");
    if (known && mappingKnown) { truthCompleteRows += 1; if (rowFields.every((field) => field.shownCorrect)) sixFieldExact += 1; }
  }
  const mapped = fields.map((field) => ({ ...field,
    mapping: baseReplay.mappingByProjection.get(field.projectionRowId)?.[field.field] ?? null }));
  return { item, fields: mapped, truthCompleteRows, sixFieldExact,
    dtoWithoutExclusions: { observationId: item.observation.observationId, result: baseReplay.result },
    dtoWithExclusions: { observationId: item.observation.observationId, result: suppliedReplay.result } };
}
function buildCohortMetrics(analyzedItems) {
  const fields = analyzedItems.flatMap((item) => item.fields);
  const metrics = fieldMetrics(fields);
  const rows = new Set(fields.map((field) => `${field.observationId}\0${field.projectionRowId}`));
  const known = fields.filter((field) => field.known);
  const exact = analyzedItems.reduce((sum, item) => sum + item.sixFieldExact, 0);
  const truthRows = analyzedItems.reduce((sum, item) => sum + item.truthCompleteRows, 0);
  const numericSlotCount = analyzedItems.reduce((sum, item) => sum + item.item.observation.completion.rows.length * 3, 0);
  const dtoWithout = dtoMetric(analyzedItems.flatMap((item) => [item.dtoWithoutExclusions]));
  const dtoWith = dtoMetric(analyzedItems.flatMap((item) => [item.dtoWithExclusions]));
  const mappingCounts = metrics.masterCounts;
  const rawWrongKnown = known.filter((field) => !field.rawCorrect).length;
  const unhighlightedKnown = known.filter((field) => !field.highlighted).length;
  const numeric = metrics.NUMERIC_REVIEW_RATE;
  return { denominators: { F: fields.length, V: known.length, R: rows.size, T: truthRows,
    rawWrongOrMissingKnownTruth: rawWrongKnown, rawCorrectKnownTruth: known.length - rawWrongKnown,
    unhighlightedKnownTruth: unhighlightedKnown, registryComparable: mappingCounts.registryComparable,
    numericSlots: numericSlotCount },
    metrics: { ...metrics, sixFieldExactRows: ratio(exact, truthRows),
      FINAL_VERIFIED_DTO_SUCCESS: { includingExplicitExclusions: dtoWith.includingExplicitExclusions,
        excludingExplicitExclusions: dtoWith.excludingExplicitExclusions,
        withoutExclusions: dtoWithout.includingExplicitExclusions, batchErrors: [...dtoWithout.batchErrors, ...dtoWith.batchErrors] } },
    coverage: { unknownFieldCount: fields.length - known.length,
      unknownRate: ratio(fields.length - known.length, fields.length), unknownRowCount: new Set(fields.filter((field) => !field.known).map((field) => `${field.observationId}\0${field.projectionRowId}`)).size,
      disputedFieldCount: fields.filter((field) => field.method === "USER_MARKED_UNKNOWN" && field.truthStatus === "DISPUTED").length } };
}
function buildCandidateComparisons(runs, fields) {
  return runs.map((run) => candidateComparison(run, fields));
}
function prepareInput({ observations, candidateRuns = [], evaluationPolicyVersion, rawEvaluationVersion, splitSeed } = {}) {
  assert(evaluationPolicyVersion === EVALUATION_POLICY, `unsupported evaluationPolicyVersion: ${String(evaluationPolicyVersion)}`);
  assert(rawEvaluationVersion === RAW_POLICY, `unsupported rawEvaluationVersion: ${String(rawEvaluationVersion)}`);
  assert(nonempty(splitSeed), "splitSeed must be a nonempty string");
  assert(Array.isArray(observations), "observations must be an array");
  const byId = new Map(); const duplicateMap = new Map();
  for (const entry of observations) {
    assert(isRecord(entry) && isRecord(entry.exportRecord) && Array.isArray(entry.exclusions) && COHORTS.has(entry.cohort),
      "observation input requires exportRecord, exclusions[], and a supported cohort");
    const parts = exportParts(entry.exportRecord); const id = parts.observation.observationId; const hash = parts.observation.observationHash;
    const prior = byId.get(id);
    assert(!prior || prior.observation.observationHash === hash, "same observationId has different observationHash");
    if (prior) {
      assert(equal(prior.semantic.observation, parts.semantic.observation)
        && equal(prior.semantic.dataset.fields, parts.semantic.dataset.fields)
        && equal(prior.semantic.dataset.edgeSegments, parts.semantic.dataset.edgeSegments), "duplicate observation identity has different semantic evidence");
      assert(equal(prior.suppliedExclusions, entry.exclusions), "duplicate observation identity has different supplied exclusions");
      prior.cohorts.add(entry.cohort);
      duplicateMap.set(`${id}\0${hash}`, (duplicateMap.get(`${id}\0${hash}`) ?? 0) + 1);
      continue;
    }
    const item = { ...parts, observation: parts.observation, cohorts: new Set([entry.cohort]),
      suppliedExclusions: clone(entry.exclusions), captureIds: new Set(), inputCohort: entry.cohort };
    byId.set(id, item);
  }
  const items = [...byId.values()].sort((a, b) => compareText(a.observation.observationId, b.observation.observationId));
  const duplicateInputs = [...duplicateMap.entries()].map(([key, duplicateCount]) => {
    const [observationId, observationHash] = key.split("\0");
    return { observationId, observationHash, duplicateCount };
  }).sort((a, b) => compareText(a.observationId, b.observationId) || compareText(a.observationHash, b.observationHash));
  const observationMap = new Map();
  for (const item of items) {
    item.cohorts = [...item.cohorts].sort(compareText);
    item.cohort = item.cohorts.length === 1 ? item.cohorts[0] : "UNASSIGNED";
    item.fields.forEach((field) => { field.cohort = item.cohort; });
    observationMap.set(item.observation.observationId, { projectionIds: new Set(item.projection.rows.map((row) => row.projectionRowId)) });
  }
  const runs = validateCandidateRuns(candidateRuns, observationMap);
  return { items, duplicateInputs, runs };
}
function datasetRef(item) {
  const obs = item.observation; const completion = obs.completion;
  return { observationId: obs.observationId, observationHash: obs.observationHash,
    recognitionBatchId: completion.recognitionBatchId, projectionHash: completion.projectionHash,
    registryVersion: completion.registryVersion, correctionVersion: completion.correctionVersion,
    reviewRevision: completion.reviewRevision, cohort: item.cohort };
}
function validateCurationOnly(output) {
  output.curationProposals.forEach((proposal) => {
    assert(proposal.requiresManualCuration === true && proposal.proposedMutation === null, "curation proposals cannot mutate production");
  });
}
function evaluateLegacyTradeReviewDataset({ observations, candidateRuns = [], evaluationPolicyVersion, rawEvaluationVersion, splitSeed } = {}) {
  const input = prepareInput({ observations, candidateRuns, evaluationPolicyVersion, rawEvaluationVersion, splitSeed });
  const evidenceGroups = buildEvidenceGroups(input.items, splitSeed);
  const leakageGroups = evidenceGroups.filter((group) => group.splitLeakage);
  const allFields = []; const analyzed = [];
  for (const item of input.items) {
    const result = analyzeObservation(item, item.suppliedExclusions);
    item.fields = result.fields;
    analyzed.push(result); allFields.push(...result.fields);
  }
  const invalidSplit = leakageGroups.length > 0;
  const overall = invalidSplit ? null : buildCohortMetrics(analyzed);
  const byCohort = {};
  if (!invalidSplit) for (const cohort of ["DEVELOPMENT", "INDEPENDENT", "UNASSIGNED"]) {
    byCohort[cohort] = buildCohortMetrics(analyzed.filter((item) => item.item.cohort === cohort));
  }
  const bySplit = {};
  if (!invalidSplit) for (const split of ["DEVELOPMENT_REPLAY_A", "DEVELOPMENT_REPLAY_B"]) {
    const groupIds = new Set(evidenceGroups.filter((group) => group.internalSplit === split).flatMap((group) => group.observationRefs.map((ref) => ref.split(":")[0])));
    bySplit[split] = buildCohortMetrics(analyzed.filter((item) => groupIds.has(item.item.observation.observationId)));
  }
  const candidateComparisons = invalidSplit ? [] : buildCandidateComparisons(input.runs, allFields);
  const taxonomy = buildTaxonomy(allFields, input.items);
  const candidateRefs = input.runs.map((run) => ({ candidateId: run.candidateId, policyVersion: run.policyVersion, sourceSha256: run.sourceSha256 }));
  const curationProposals = proposalsFrom(taxonomy.derivedAttributions, allFields, input.runs);
  const output = { schemaVersion: 1, evaluationPolicyVersion, rawEvaluationVersion, splitSeed,
    evaluationStatus: invalidSplit ? "INVALID_SPLIT_LEAKAGE" : "VALID_DESCRIPTIVE_EVALUATION",
    datasetManifest: { observationCount: observations.length, uniqueObservationCount: input.items.length,
      groupCount: evidenceGroups.length,
      developmentCount: input.items.filter((item) => item.cohort === "DEVELOPMENT").length,
      independentCount: input.items.filter((item) => item.cohort === "INDEPENDENT").length,
      unassignedCount: input.items.filter((item) => item.cohort === "UNASSIGNED").length,
      observationRefs: input.items.map(datasetRef).sort((a, b) => compareText(a.observationId, b.observationId)) },
    evidenceGroups, duplicateInputs: input.duplicateInputs,
    splitValidation: { valid: !invalidSplit, errors: leakageGroups.map((group) => ({ code: "SPLIT_LEAKAGE", groupId: group.groupId,
      observationRefs: group.observationRefs, cohorts: group.cohortLabels })), internalSplitLabels: ["DEVELOPMENT_REPLAY_A", "DEVELOPMENT_REPLAY_B"],
      independentHoldoutClaim: false },
    denominators: overall?.denominators ?? { F: null, V: null, R: null, T: null },
    metrics: overall?.metrics ?? { status: "INVALID", reason: "SPLIT_LEAKAGE" },
    coverage: overall?.coverage ?? { unknownFieldCount: null, unknownRate: { numerator: null, denominator: null, rate: null, status: "N/A" },
      unknownRowCount: null, disputedFieldCount: null },
    metricsByField: Object.fromEntries(FIELDS.map((field) => {
      if (invalidSplit) return [field, { status: "INVALID", reason: "SPLIT_LEAKAGE" }];
      const scoped = allFields.filter((item) => item.field === field);
      return [field, fieldMetrics(scoped)];
    })),
    metricsByCohort: byCohort, developmentReplayMetrics: bySplit,
    failureTaxonomy: { types: [...TAXONOMY], counts: taxonomy.counts,
      sourceAttributions: taxonomy.sourceAttributions, derivedAttributions: taxonomy.derivedAttributions },
    candidateComparisons, candidateReplayAuthority: "CALLER_ATTESTED_OFFLINE_REPLAY", candidateRunRefs: candidateRefs,
    curationProposals, warnings: ["Metrics are descriptive review measurements, not production promotion or auto-acceptance gates.",
      "DEVELOPMENT_REPLAY_A/B are internal group-safe replay splits, not independent holdouts.",
      ...(input.items.some((item) => item.cohort === "UNASSIGNED") ? ["UNASSIGNED evidence is descriptive and is not reported as independent evaluation."] : [])],
    semanticHashBasis: HASH_BASIS };
  validateCurationOnly(output);
  output.semanticHash = semanticEvaluationSha256(output);
  return output;
}

const FINAL_EVALUATION_POLICY = "trade-final-review-evaluation-v3";
const FINAL_EXPORT_TYPE = "TRADE_FINAL_REVIEW_OBSERVATION";
const FINAL_EXPORT_HASH_BASIS = "TRADE_EXPORT_JSON_V3";
const DECISIONS = new Set(["CANDIDATE_RETAINED", "USER_EDITED", "USER_MARKED_UNKNOWN"]);
const CLASSIFICATIONS = new Set(["FINAL_READY", "NEEDS_REVIEW", "NEEDS_RECAPTURE", "CONFLICT"]);
const RETENTION = new Set(["OPERATIONAL_REVIEW_EVIDENCE", "HUMAN_TRUTH_EVIDENCE", "UNKNOWN_EVIDENCE", "NONE"]);
const TRUTH_LABEL_KEYS = ["schemaVersion", "mutationId", "sourceRowId", "field", "cropRefId", "labelRevision",
  "supersedesLabelId", "labelStatus", "value", "provenance", "createdAt", "labelId", "observationId", "persistedAt",
  "artifact", "truthEvidence", "labelHash"];

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort(compareText).join("\0") === [...keys].sort(compareText).join("\0");
}
function finalRatio(numerator, denominator) {
  const rate = denominator === 0 ? null : (() => {
    const scaled = Math.floor((numerator * 1_000_000 + denominator / 2) / denominator);
    return `${Math.floor(scaled / 1_000_000)}.${String(scaled % 1_000_000).padStart(6, "0")}`;
  })();
  return { numerator, denominator, rate, status: denominator === 0 ? "N/A" : "AVAILABLE" };
}
function physicalCropKey(crop, field) {
  assert(isRecord(crop) && validHash(crop.bitmapSha256) && validHash(crop.pixelSha256) && isRecord(crop.box)
    && ["x", "y", "width", "height"].every((key) => Number.isSafeInteger(crop.box[key])), "invalid physical crop identity");
  return stable([crop.bitmapSha256, crop.box, crop.pixelSha256, field]);
}
function finalRawValue(sourceField, field) {
  const raw = sourceField.rawEvidence;
  if (field === "island" || field === "fromItem" || field === "toItem") return raw.rawText;
  const value = raw.rawNumeric;
  return Number.isSafeInteger(value) && value >= MINIMUM[field] ? value : null;
}
function validFinalValue(value, field) {
  return (IDENTITY.has(field) && (value === null || nonempty(value)))
    || (NUMERIC.has(field) && (value === null || Number.isSafeInteger(value) && value >= MINIMUM[field]));
}
function validUtcTimestamp(value) {
  const match = typeof value === "string" && value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/);
  if (!match) return false;
  const millis = (match[2] ?? "").padEnd(3, "0");
  const normalized = `${match[1]}.${millis}Z`;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === normalized;
}
function finalLabelIndex(parts) {
  const { semantic, observation } = parts;
  const rawRows = observation.sourceContext?.rawEvidence?.snapshot?.sourceRows;
  const captures = observation.sourceContext?.rawEvidence?.snapshot?.captures;
  const snapshot = observation.sourceContext?.rawEvidence?.snapshot;
  assert(Array.isArray(rawRows) && Array.isArray(captures), "Export3 lacks source/capture snapshot");
  assert(exactKeys(snapshot, ["schemaVersion", "recognitionBatchId", "captures", "sourceRows", "edgeSegments"])
    && snapshot.schemaVersion === 2 && snapshot.recognitionBatchId === observation.projection.recognitionBatchId
    && Array.isArray(snapshot.edgeSegments), "invalid RawEvidenceSnapshot2");
  const captureCounts = new Map(); const captureIds = new Set();
  const captureOrdinals = new Set();
  for (const capture of captures) {
    assert(exactKeys(capture, ["captureId", "captureOrdinal", "imageSha256", "bitmapSha256", "sourceType", "frame", "sourceFidelity", "reencoded", "completeRowCount"])
      && nonempty(capture.captureId) && !captureIds.has(capture.captureId) && Number.isSafeInteger(capture.captureOrdinal)
      && capture.captureOrdinal >= 0 && !captureOrdinals.has(capture.captureOrdinal) && validHash(capture.imageSha256)
      && validHash(capture.bitmapSha256) && ["FILE", "CLIPBOARD", "STREAM"].includes(capture.sourceType)
      && exactKeys(capture.frame, ["width", "height"]) && Number.isSafeInteger(capture.frame.width) && capture.frame.width > 0
      && Number.isSafeInteger(capture.frame.height) && capture.frame.height > 0
      && exactKeys(capture.sourceFidelity, ["sourceWidth", "sourceHeight", "rescaled", "evidence"])
      && ["file-metadata", "unknown"].includes(capture.sourceFidelity.evidence) && typeof capture.reencoded === "boolean"
      && Number.isSafeInteger(capture.completeRowCount) && capture.completeRowCount >= 0, "invalid capture source evidence");
    if (capture.sourceFidelity.evidence === "unknown") assert(capture.sourceFidelity.sourceWidth === null
      && capture.sourceFidelity.sourceHeight === null && capture.sourceFidelity.rescaled === null, "unknown source fidelity must remain null");
    else assert(Number.isSafeInteger(capture.sourceFidelity.sourceWidth) && capture.sourceFidelity.sourceWidth > 0
      && Number.isSafeInteger(capture.sourceFidelity.sourceHeight) && capture.sourceFidelity.sourceHeight > 0
      && capture.sourceFidelity.rescaled === false, "invalid file-metadata source fidelity");
    captureIds.add(capture.captureId); captureCounts.set(capture.captureId, 0);
    captureOrdinals.add(capture.captureOrdinal);
  }
  assert([...captureOrdinals].sort((a, b) => a - b).every((ordinal, index) => ordinal === index), "capture ordinals must be contiguous");
  const crops = new Map();
  const sourceIds = new Set(); const sourceOrdinals = new Map();
  const captureOrder = new Map(captures.slice().sort((a, b) => a.captureOrdinal - b.captureOrdinal)
    .map((capture, index) => [capture.captureId, index]));
  let previousSourcePosition = null;
  for (const source of rawRows) {
    assert(exactKeys(source, ["sourceRowId", "captureId", "ordinal", "rowBox", "fields"])
      && nonempty(source.sourceRowId) && !sourceIds.has(source.sourceRowId) && captureCounts.has(source.captureId)
      && Number.isSafeInteger(source.ordinal) && source.ordinal >= 0 && Array.isArray(source.fields)
      && source.fields.length === FIELDS.length && equal(source.fields.map((field) => field.field), FIELDS), "invalid source row");
    sourceIds.add(source.sourceRowId);
    const position = [captureOrder.get(source.captureId), source.ordinal];
    assert(!previousSourcePosition || position[0] > previousSourcePosition[0]
      || position[0] === previousSourcePosition[0] && position[1] > previousSourcePosition[1],
    "RawEvidence source rows are not in capture/ordinal order");
    previousSourcePosition = position;
    const ordinals = sourceOrdinals.get(source.captureId) ?? new Set();
    assert(!ordinals.has(source.ordinal), "duplicate source ordinal in capture"); ordinals.add(source.ordinal); sourceOrdinals.set(source.captureId, ordinals);
    captureCounts.set(source.captureId, captureCounts.get(source.captureId) + 1);
    for (const sourceField of source.fields) {
      assert(exactKeys(sourceField, ["field", "rawText", "rawNumeric", "readerStatus", "confidence", "cropRefs"])
        && (sourceField.rawText === null || typeof sourceField.rawText === "string")
        && (sourceField.rawNumeric === null || Number.isSafeInteger(sourceField.rawNumeric))
        && nonempty(sourceField.readerStatus) && (sourceField.confidence === null || typeof sourceField.confidence === "string")
        && Array.isArray(sourceField.cropRefs), "invalid source field binding");
      for (const crop of sourceField.cropRefs) {
        assert(exactKeys(crop, ["cropRefId", "sourceRowId", "captureId", "field", "bitmapSha256", "frame", "coordinateSpace", "box",
          "pixelHashBasis", "pixelSha256", "pngArtifactSha256"])
          && nonempty(crop.cropRefId) && crop.sourceRowId === source.sourceRowId && crop.captureId === source.captureId
          && crop.field === sourceField.field && validHash(crop.bitmapSha256) && validHash(crop.pixelSha256)
          && exactKeys(crop.frame, ["width", "height"]) && crop.coordinateSpace === "CAPTURE_BITMAP_PIXELS"
          && exactKeys(crop.box, ["x", "y", "width", "height"]) && ["x", "y", "width", "height"].every((key) => Number.isSafeInteger(crop.box[key]))
          && crop.box.x >= 0 && crop.box.y >= 0 && crop.box.width > 0 && crop.box.height > 0
          && crop.box.x + crop.box.width <= crop.frame.width && crop.box.y + crop.box.height <= crop.frame.height
          && crop.pixelHashBasis === "RGB8_ROW_MAJOR_V1" && (crop.pngArtifactSha256 === null || validHash(crop.pngArtifactSha256)),
          `crop source/field binding mismatch: ${JSON.stringify(crop)}`);
        const cropKey = `${source.sourceRowId}\0${sourceField.field}\0${crop.cropRefId}`;
        assert(!crops.has(cropKey), "duplicate source crop reference");
        crops.set(cropKey, crop);
      }
    }
  }
  assert([...captureCounts].every(([captureId, count]) => captures.find((capture) => capture.captureId === captureId).completeRowCount === count),
    "source COMPLETE rows differ from immutable capture evidence");
  const labels = semantic.truthLabels;
  assert(Array.isArray(labels), "truthLabels must be an array");
  const labelIds = new Set(); const subjectHistory = new Map();
  for (const label of labels) {
    assert(exactKeys(label, TRUTH_LABEL_KEYS) && label.schemaVersion === 1 && label.truthEvidence === "HUMAN_CROP_VERIFIED"
      && nonempty(label.labelId) && !labelIds.has(label.labelId) && label.observationId === observation.observationId
      && FIELDS.includes(label.field) && Number.isSafeInteger(label.labelRevision) && label.labelRevision > 0
      && ["KNOWN", "UNKNOWN", "DISPUTED"].includes(label.labelStatus) && isRecord(label.provenance)
      && exactKeys(label.artifact, ["sha256", "pixelSha256", "width", "height"]) && validHash(label.artifact.sha256)
      && validHash(label.artifact.pixelSha256) && Number.isSafeInteger(label.artifact.width) && Number.isSafeInteger(label.artifact.height),
    "invalid truth-label record");
    assert(exactKeys(label.provenance, ["method", "labelerRole", "sourceFamilyId", "cohort", "splitManifestHash", "sourceOrigin",
      "independentOfOperationalReview", "note"]) && label.provenance.method === "HUMAN_CROP_VERIFIED"
      && label.provenance.labelerRole === "PRODUCT_OWNER" && nonempty(label.provenance.sourceFamilyId)
      && ["DEVELOPMENT", "INDEPENDENT"].includes(label.provenance.cohort)
      && ["FRESH_CAPTURE", "ARCHIVED_CAPTURE"].includes(label.provenance.sourceOrigin)
      && typeof label.provenance.independentOfOperationalReview === "boolean"
      && (label.provenance.splitManifestHash === null || validHash(label.provenance.splitManifestHash)), "invalid truth-label provenance");
    labelIds.add(label.labelId);
    const crop = crops.get(`${label.sourceRowId}\0${label.field}\0${label.cropRefId}`);
    assert(crop, "truth label refers to unknown source crop");
    assert(label.artifact.pixelSha256 === crop.pixelSha256 && label.artifact.width === crop.box.width
      && label.artifact.height === crop.box.height && (crop.pngArtifactSha256 == null || label.artifact.sha256 === crop.pngArtifactSha256),
    "truth label artifact binding mismatch");
    const unhashed = { ...label }; delete unhashed.labelHash;
    assert(validHash(label.labelHash) && semanticEvaluationSha256(unhashed) === label.labelHash, "truth label hash mismatch");
    assert((label.labelStatus === "KNOWN" && validFinalValue(label.value, label.field))
      || (label.labelStatus !== "KNOWN" && label.value === null), "truth label value/status mismatch");
    const subject = `${label.sourceRowId}\0${label.field}\0${label.cropRefId}`;
    const history = subjectHistory.get(subject) ?? [];
    history.push(label); subjectHistory.set(subject, history);
  }
  for (const history of subjectHistory.values()) {
    history.sort((a, b) => a.labelRevision - b.labelRevision || compareText(a.labelId, b.labelId));
    for (let index = 0; index < history.length; index += 1) {
      assert(history[index].labelRevision === index + 1
        && history[index].supersedesLabelId === (index ? history[index - 1].labelId : null), "truth label revision chain mismatch");
    }
  }
  const bindings = [...labels].sort((a, b) => compareText(a.labelId, b.labelId)).map(({ labelId, labelHash }) => ({ labelId, labelHash }));
  assert(equal(semantic.manifest.truthLabelBindings, bindings), "truthLabelBindings mismatch");
  const latest = new Map([...subjectHistory].map(([key, history]) => [key, history.at(-1)]));
  return { rawRows, crops, labels, latest };
}
function validateFinalExport(exportRecord) {
  const topKeys = ["schemaVersion", "exportType", "generatedAt", "hashBasis", "semanticHash", "semantic"];
  assert(exactKeys(exportRecord, topKeys) && exportRecord.schemaVersion === 3 && exportRecord.exportType === FINAL_EXPORT_TYPE
    && nonempty(exportRecord.generatedAt) && exportRecord.hashBasis === FINAL_EXPORT_HASH_BASIS && validHash(exportRecord.semanticHash),
  "invalid Export3 envelope");
  const semantic = exportRecord.semantic;
  assert(exactKeys(semantic, ["manifest", "observation", "cropEvidence", "truthLabels", "dataset"]), "invalid Export3 semantic shape");
  assert(semanticEvaluationSha256(semantic) === exportRecord.semanticHash, "Export3 semantic hash mismatch");
  const manifest = semantic.manifest; const observation = semantic.observation; const dataset = semantic.dataset;
  assert(exactKeys(manifest, ["observationSchemaVersion", "sidecarSchemaVersion", "projectionSchemaVersion", "completionSchemaVersion",
    "masterBinding", "projectionHash", "payloadHash", "observationHash", "truthLabelBindings", "evaluationPolicyVersion"])
    && manifest.observationSchemaVersion === 3 && manifest.sidecarSchemaVersion === 3 && manifest.projectionSchemaVersion === 3
    && manifest.completionSchemaVersion === 3 && manifest.evaluationPolicyVersion === FINAL_EVALUATION_POLICY
    && validHash(manifest.projectionHash) && validHash(manifest.payloadHash) && validHash(manifest.observationHash),
  "invalid Export3 manifest");
  assert(isRecord(observation) && observation.schemaVersion === 3 && observation.reviewMode === "FINAL_CORRECTED_RESULT"
    && observation.observationHash === manifest.observationHash && observation.payloadHash === manifest.payloadHash
    && observation.projection?.projectionHash === manifest.projectionHash, "Export3 observation hash binding mismatch");
  assert(observation.hashBasis === "TRADE_OBSERVATION_JSON_V3" && nonempty(observation.observationId)
    && nonempty(observation.persistedAt) && validHash(observation.payloadHash) && validHash(observation.observationHash),
  "invalid embedded Observation3 identity");
  const request = Object.fromEntries(Object.entries(observation).filter(([key]) =>
    !["observationId", "persistedAt", "hashBasis", "payloadHash", "observationHash"].includes(key)));
  assert(registrySnapshotSha256(request) === observation.payloadHash, "embedded Observation3 payload hash mismatch");
  const recordForHash = { ...request, observationId: observation.observationId, persistedAt: observation.persistedAt,
    hashBasis: observation.hashBasis, payloadHash: observation.payloadHash };
  assert(registrySnapshotSha256(recordForHash) === observation.observationHash, "embedded Observation3 observation hash mismatch");
  const projection = observation.projection; const completion = observation.completion;
  const sourceContext = observation.sourceContext;
  const rawEvidence = sourceContext?.rawEvidence;
  assert(exactKeys(observation, ["schemaVersion", "reviewMode", "mutationId", "createdAt", "confirmationRevision", "supersedesObservationId",
    "projection", "completion", "sourceContext", "cropPlan", "observationId", "persistedAt", "hashBasis", "payloadHash", "observationHash"])
    && exactKeys(sourceContext, ["schemaVersion", "authority", "rawEvidence", "masterBundle", "audit"])
    && sourceContext.schemaVersion === 3 && sourceContext.authority === "CLIENT_ATTESTED"
    && exactKeys(rawEvidence, ["hashBasis", "rawEvidenceHash", "snapshot"])
    && rawEvidence.hashBasis === "TRADE_RAW_EVIDENCE_JSON_V2" && validHash(rawEvidence.rawEvidenceHash)
    && registrySnapshotSha256(rawEvidence.snapshot) === rawEvidence.rawEvidenceHash
    && exactKeys(sourceContext.masterBundle, ["binding", "snapshot"])
    && exactKeys(sourceContext.audit, ["recognitionStartedAt", "recognitionFinishedAt", "latencyMs", "gameVersion"])
    && (sourceContext.audit.recognitionStartedAt === null || nonempty(sourceContext.audit.recognitionStartedAt))
    && (sourceContext.audit.recognitionFinishedAt === null || nonempty(sourceContext.audit.recognitionFinishedAt))
    && (sourceContext.audit.latencyMs === null || Number.isSafeInteger(sourceContext.audit.latencyMs) && sourceContext.audit.latencyMs >= 0)
    && (sourceContext.audit.gameVersion === null || typeof sourceContext.audit.gameVersion === "string"),
  "invalid Observation3 source context or raw evidence hash");
  assert(exactKeys(projection, ["schemaVersion", "reviewMode", "recognitionBatchId", "rawEvidenceHash", "masterBinding", "correctionVersion",
    "reconciliation", "pixelAvailability", "rows", "edgeWorkItems", "hashBasis", "projectionHash"])
    && projection.reviewMode === "FINAL_CORRECTED_RESULT" && nonempty(projection.recognitionBatchId)
    && projection.rawEvidenceHash === rawEvidence.rawEvidenceHash && nonempty(projection.correctionVersion)
    && projection.hashBasis === "TRADE_FINAL_PROJECTION_JSON_V3" && Array.isArray(projection.rows)
    && Array.isArray(projection.pixelAvailability) && Array.isArray(projection.edgeWorkItems), "invalid FinalProjection3 shape/binding");
  const reconciliation = projection.reconciliation;
  assert(exactKeys(reconciliation, ["schemaVersion", "policyVersion", "captureOrder", "sourceRows", "groups", "sourceToLogical", "findings"])
    && reconciliation.schemaVersion === 2 && nonempty(reconciliation.policyVersion) && Array.isArray(reconciliation.captureOrder)
    && Array.isArray(reconciliation.sourceRows) && Array.isArray(reconciliation.groups)
    && Array.isArray(reconciliation.sourceToLogical) && Array.isArray(reconciliation.findings),
  "invalid finalized reconciliation contract");
  assert(exactKeys(completion, ["schemaVersion", "reviewMode", "recognitionBatchId", "projectionHash", "masterBinding", "correctionVersion",
    "reviewRevision", "rows", "workItems", "batchConfirmation"])
    && projection?.schemaVersion === 3 && completion.schemaVersion === 3 && completion.reviewMode === "FINAL_CORRECTED_RESULT"
    && completion.projectionHash === projection.projectionHash && completion.recognitionBatchId === dataset.recognitionBatchId
    && nonempty(completion.correctionVersion) && Number.isSafeInteger(completion.reviewRevision) && completion.reviewRevision > 0
    && Array.isArray(completion.rows) && Array.isArray(completion.workItems)
    && equal(projection.masterBinding, manifest.masterBinding) && equal(completion.masterBinding, manifest.masterBinding),
  "Export3 projection/completion binding mismatch");
  const confirmation = completion.batchConfirmation;
  assert(exactKeys(confirmation, ["method", "confirmedAt", "projectionHash", "reviewRevision", "completionValuesHash"])
    && confirmation.method === "USER_FINAL_LIST_CONFIRMED" && validUtcTimestamp(confirmation.confirmedAt)
    && confirmation.projectionHash === projection.projectionHash && confirmation.reviewRevision === completion.reviewRevision
    && validHash(confirmation.completionValuesHash), "invalid Completion3 batch confirmation");
  const { batchConfirmation, ...completionValues } = completion;
  assert(registrySnapshotSha256(completionValues) === batchConfirmation.completionValuesHash,
    "Completion3 values do not match batch confirmation hash");
  const { projectionHash, ...projectionBase } = projection;
  const masterSnapshot = observation.sourceContext?.masterBundle?.snapshot;
  const masterValidation = masterSnapshot && validateMasterBundleV2(masterSnapshot);
  assert(registrySnapshotSha256(projectionBase) === projectionHash
    && equal(observation.sourceContext?.masterBundle?.binding, manifest.masterBinding)
    && exactKeys(manifest.masterBinding, ["masterSchemaVersion", "registryVersion", "contentHash", "hashBasis"])
    && manifest.masterBinding.masterSchemaVersion === 2 && validHash(manifest.masterBinding.contentHash)
    && manifest.masterBinding.hashBasis === "MASTER_CANONICAL_JSON_V2"
    && masterSnapshot?.schemaVersion === 2 && masterSnapshot.registryVersion === manifest.masterBinding.registryVersion
    && masterSnapshot.contentHash === manifest.masterBinding.contentHash && masterValidation?.ok === true
    && masterBundleContentHash(masterSnapshot) === manifest.masterBinding.contentHash,
  "Export3 projection or pinned Master content hash mismatch");
  assert(exactKeys(dataset, ["recognitionBatchId", "rows", "sourceFields", "edgeWorkItems"])
    && Array.isArray(dataset.rows) && Array.isArray(dataset.sourceFields) && Array.isArray(dataset.edgeWorkItems)
    && Array.isArray(semantic.cropEvidence), "invalid Export3 dataset shape");
  assert(equal(manifest.masterBinding, projection.masterBinding), "Export3 Master binding mismatch");
  const { rawRows, crops, latest } = finalLabelIndex({ semantic, observation });
  const expectedPixelAvailability = [...new Set(rawRows.flatMap((source) => source.fields.flatMap((field) => field.cropRefs.map((crop) => crop.cropRefId))))];
  assert(projection.pixelAvailability.length === expectedPixelAvailability.length
    && projection.pixelAvailability.every((item, index) => exactKeys(item, ["cropRefId", "state"])
      && item.cropRefId === expectedPixelAvailability[index]
      && ["IN_MEMORY", "DURABLE", "MISSING", "EXPIRED", "INVALID"].includes(item.state)),
  "Projection3 pixel availability does not cover raw crop references in stable order");
  const projectionRows = new Map(projection.rows.map((row) => [row.projectionRowId, row]));
  const completionRows = new Map(completion.rows.map((row) => [row.projectionRowId, row]));
  assert(projectionRows.size === projection.rows.length && completionRows.size === completion.rows.length
    && dataset.rows.length === projection.rows.length && completionRows.size === projectionRows.size
    && equal(completion.rows.map((row) => row.projectionRowId), projection.rows.map((row) => row.projectionRowId))
    && equal(dataset.rows.map((row) => row.projectionRowId), projection.rows.map((row) => row.projectionRowId)),
  "Export3 logical row accounting mismatch");
  const sourceIds = new Set(rawRows.map((row) => row.sourceRowId));
  assert(sourceIds.size === rawRows.length, "duplicate source row identity in Observation3");
  const rawRowsById = new Map(rawRows.map((row) => [row.sourceRowId, row]));
  const rawCaptures = observation.sourceContext.rawEvidence.snapshot.captures;
  assert(equal(reconciliation.captureOrder, rawCaptures.slice().sort((a, b) => a.captureOrdinal - b.captureOrdinal).map((capture) => capture.captureId))
    && reconciliation.sourceRows.length === rawRows.length && reconciliation.sourceToLogical.length === rawRows.length,
  "reconciliation source/capture accounting differs from raw evidence");
  const reconciliationSourceIds = new Set();
  for (const [index, source] of reconciliation.sourceRows.entries()) {
    const raw = rawRows[index];
    assert(exactKeys(source, ["sourceRowId", "captureId", "ordinal", "projectionSourceIndex"])
      && source.sourceRowId === raw.sourceRowId && source.captureId === raw.captureId && source.ordinal === raw.ordinal
      && source.projectionSourceIndex === index && !reconciliationSourceIds.has(source.sourceRowId),
    "reconciliation source row differs from immutable raw source");
    reconciliationSourceIds.add(source.sourceRowId);
  }
  const groupedSources = new Set(); const groupByLogicalId = new Map();
  for (const group of reconciliation.groups) {
    assert(exactKeys(group, ["groupId", "status", "memberSourceRowIds", "representativeSourceRowId", "logicalRowId", "memberEvidence"])
      && nonempty(group.groupId) && ["SINGLE", "EXACT_OVERLAP", "CONFLICT"].includes(group.status)
      && Array.isArray(group.memberSourceRowIds) && group.memberSourceRowIds.length > 0
      && (group.status === "SINGLE" ? group.memberSourceRowIds.length === 1 : group.memberSourceRowIds.length > 1)
      && group.representativeSourceRowId === group.memberSourceRowIds[0] && sourceIds.has(group.representativeSourceRowId)
      && nonempty(group.logicalRowId) && Array.isArray(group.memberEvidence)
      && (group.memberSourceRowIds.length === 1 ? group.memberEvidence.length === 0 : group.memberEvidence.length === group.memberSourceRowIds.length)
      && !groupByLogicalId.has(group.logicalRowId),
    "invalid reconciliation group");
    for (const [index, member] of group.memberEvidence.entries()) {
      assert(exactKeys(member, ["sourceRowId", "fields"]) && member.sourceRowId === group.memberSourceRowIds[index]
        && Array.isArray(member.fields) && member.fields.length === FIELDS.length && equal(member.fields.map((field) => field.field), FIELDS),
      "reconciliation member evidence is incomplete or unordered");
    }
    groupByLogicalId.set(group.logicalRowId, group);
    for (const sourceId of group.memberSourceRowIds) {
      assert(sourceIds.has(sourceId) && !groupedSources.has(sourceId), "source row is missing or multiply assigned in reconciliation groups");
      groupedSources.add(sourceId);
    }
  }
  assert(groupedSources.size === sourceIds.size, "reconciliation groups dropped source rows");
  const logicalBySource = new Map();
  for (const mapping of reconciliation.sourceToLogical) {
    assert(exactKeys(mapping, ["sourceRowId", "logicalRowId"]) && sourceIds.has(mapping.sourceRowId)
      && mapping.sourceRowId === reconciliation.sourceRows[logicalBySource.size]?.sourceRowId
      && groupByLogicalId.has(mapping.logicalRowId) && !logicalBySource.has(mapping.sourceRowId),
    "invalid source-to-logical reconciliation mapping");
    logicalBySource.set(mapping.sourceRowId, mapping.logicalRowId);
  }
  assert(logicalBySource.size === sourceIds.size && projection.rows.length === groupByLogicalId.size,
    "logical reconciliation accounting mismatch");
  for (const pRow of projection.rows) {
    const group = groupByLogicalId.get(pRow.projectionRowId);
    assert(group && equal(pRow.sourceRefs, group.memberSourceRowIds.map((sourceRowId) => {
      const raw = rawRowsById.get(sourceRowId); return { sourceRowId, captureId: raw.captureId, ordinal: raw.ordinal };
    })) && pRow.captureId === rawRowsById.get(group.representativeSourceRowId).captureId
      && pRow.ordinal === rawRowsById.get(group.representativeSourceRowId).ordinal
      && group.memberSourceRowIds.every((sourceRowId) => logicalBySource.get(sourceRowId) === pRow.projectionRowId),
    "Projection3 row/sourceRefs disagree with reconciliation group");
  }
  const sourceFieldMap = new Map();
  for (const sourceField of dataset.sourceFields) {
    assert(exactKeys(sourceField, ["sourceRowId", "field", "rawEvidence", "normalizedValue", "correctedValue", "truthEvidence",
      "knownTruthEligible", "truthValue", "truthLabelIds", "cropRefs"]) && sourceIds.has(sourceField.sourceRowId)
      && FIELDS.includes(sourceField.field) && isRecord(sourceField.rawEvidence)
      && sourceField.rawEvidence.sourceRowId === sourceField.sourceRowId && Array.isArray(sourceField.cropRefs)
      && Array.isArray(sourceField.truthLabelIds), "invalid Export3 source field");
    const key = `${sourceField.sourceRowId}\0${sourceField.field}`;
    assert(!sourceFieldMap.has(key), "duplicate Export3 source field");
    sourceFieldMap.set(key, sourceField);
  }
  assert(sourceFieldMap.size === sourceIds.size * FIELDS.length, "Export3 must preserve all source COMPLETE fields");
  for (const sourceId of sourceIds) for (const field of FIELDS) assert(sourceFieldMap.has(`${sourceId}\0${field}`), "missing Export3 source field");
  const allPhysicalBindings = new Map();
  const rawSourceById = new Map(rawRows.map((source) => [source.sourceRowId, source]));
  for (const [key, sourceField] of sourceFieldMap) {
    const [sourceId, fieldName] = key.split("\0");
    const rawSource = rawSourceById.get(sourceId);
    const raw = rawSource.fields.find((field) => field.field === fieldName);
    const rawEvidence = { sourceRowId: sourceId, rawText: raw.rawText, rawNumeric: raw.rawNumeric,
      readerStatus: raw.readerStatus, confidence: raw.confidence };
    assert(equal(sourceField.rawEvidence, rawEvidence) && equal(sourceField.cropRefs, raw.cropRefs),
      "Export3 source field raw/crop evidence differs from immutable recognition snapshot");
    const logicalId = logicalBySource.get(sourceId);
    const group = groupByLogicalId.get(logicalId);
    const member = group.memberEvidence.find((entry) => entry.sourceRowId === sourceId);
    const sourceProjectionField = member?.fields.find((field) => field.field === fieldName)
      ?? projectionRows.get(logicalId)?.fields.find((field) => field.field === fieldName);
    assert(sourceProjectionField && sourceField.normalizedValue === sourceProjectionField.normalizedValue
      && sourceField.correctedValue === sourceProjectionField.finalValue,
    "Export3 source corrected trace differs from Projection3 reconciliation evidence");
    const physical = new Map();
    for (const crop of raw.cropRefs) {
      const key = physicalCropKey(crop, fieldName); physical.set(key, crop);
      const refs = allPhysicalBindings.get(key) ?? []; refs.push({ sourceId, fieldName, crop }); allPhysicalBindings.set(key, refs);
    }
    const labels = new Set(); const values = []; let eligible = physical.size > 0; let disputed = false;
    for (const [key] of physical) {
      const sameSourceBindings = (allPhysicalBindings.get(key) ?? []).filter((binding) => binding.sourceId === sourceId);
      const boundLabels = sameSourceBindings.map((binding) => latest.get(`${sourceId}\0${fieldName}\0${binding.crop.cropRefId}`)).filter(Boolean);
      for (const label of boundLabels) {
        labels.add(label.labelId);
        if (label.labelStatus === "DISPUTED") disputed = true;
      }
      const known = boundLabels.filter((label) => label.labelStatus === "KNOWN");
      const distinct = new Map(known.map((label) => [stable(label.value), label.value]));
      if (distinct.size > 1) disputed = true;
      if (distinct.size !== 1) eligible = false;
      else values.push([...distinct.values()][0]);
    }
    if (new Set(values.map(stable)).size !== values.length) disputed = true;
    if (values.length !== physical.size || new Set(values.map(stable)).size !== 1) eligible = false;
    const expectedValue = eligible && !disputed ? values[0] : null;
    assert(sourceField.knownTruthEligible === Boolean(eligible && !disputed)
      && sourceField.truthEvidence === (eligible && !disputed ? "HUMAN_CROP_VERIFIED" : "NONE")
      && equal(sourceField.truthLabelIds, [...labels].sort(compareText))
      && (eligible && !disputed ? equal(sourceField.truthValue, expectedValue) : sourceField.truthValue === null),
    "Export3 source field truth eligibility mismatch");
  }
  const logicalFields = [];
  const seenRows = new Set();
  const mappedSources = new Set();
  for (const row of dataset.rows) {
    assert(exactKeys(row, ["projectionRowId", "classification", "disposition", "sourceRefs", "fields"])
      && projectionRows.has(row.projectionRowId) && completionRows.has(row.projectionRowId) && !seenRows.has(row.projectionRowId)
      && CLASSIFICATIONS.has(row.classification) && Array.isArray(row.sourceRefs) && Array.isArray(row.fields)
      && row.fields.length === FIELDS.length, "invalid Export3 logical row");
    seenRows.add(row.projectionRowId);
    const cRow = completionRows.get(row.projectionRowId);
    const pRow = projectionRows.get(row.projectionRowId);
    assert(exactKeys(cRow, ["projectionRowId", "sourceRefs", "fields", "disposition", "dispositionReason"])
      && (cRow.disposition === "INCLUDE" || cRow.disposition === "EXCLUDE" || cRow.disposition === "RECAPTURE_REQUIRED")
      && (cRow.disposition === "EXCLUDE" ? nonempty(cRow.dispositionReason)
        : cRow.dispositionReason === null || typeof cRow.dispositionReason === "string")
      && Array.isArray(cRow.fields) && cRow.fields.length === FIELDS.length && equal(cRow.fields.map((field) => field.field), FIELDS)
      && equal(pRow.fields.map((field) => field.field), FIELDS) && equal(row.fields.map((field) => field.field), FIELDS),
    "invalid Completion3 row");
    assert(row.disposition === cRow.disposition && equal(row.sourceRefs, cRow.sourceRefs)
      && row.classification === pRow.classification && equal(row.sourceRefs, pRow.sourceRefs), "Export3 row differs from projection/completion");
    for (const ref of row.sourceRefs) {
      const source = rawRowsById.get(ref.sourceRowId);
      assert(isRecord(ref) && source && !mappedSources.has(ref.sourceRowId) && ref.captureId === source.captureId
        && ref.ordinal === source.ordinal, "Export3 source mapping missing, duplicated, or mismatched");
      mappedSources.add(ref.sourceRowId);
    }
    for (const name of FIELDS) {
      const field = row.fields.find((item) => item.field === name);
      assert(field && exactKeys(field, ["field", "operationalDecision", "truthEvidence", "knownTruthEligible", "truthValue", "truthLabelIds",
        "rawEvidence", "normalizedValue", "correctedValue", "shownValueBefore", "finalValue", "riskReasons", "correctionReasons",
        "masterBinding", "sourceRefs", "cropRefs"])
        && DECISIONS.has(field.operationalDecision) && Array.isArray(field.truthLabelIds) && Array.isArray(field.riskReasons)
        && Array.isArray(field.correctionReasons) && equal(field.sourceRefs, row.sourceRefs)
        && validFinalValue(field.correctedValue, name) && validFinalValue(field.finalValue, name), "invalid Export3 logical field");
      const completionField = cRow.fields.find((item) => item.field === name);
      const projectedField = pRow.fields.find((item) => item.field === name);
      assert(exactKeys(completionField, ["field", "shownValueBefore", "finalValue", "operationalDecision", "riskReasons", "cropRefs", "userEditReason"])
        || exactKeys(completionField, ["field", "shownValueBefore", "finalValue", "operationalDecision", "riskReasons", "cropRefs"]),
      "invalid Completion3 field shape");
      assert(DECISIONS.has(completionField.operationalDecision) && Array.isArray(completionField.riskReasons)
        && Array.isArray(completionField.cropRefs) && equal(completionField.riskReasons, projectedField.riskReasons)
        && equal(completionField.cropRefs, projectedField.cropRefs) && equal(completionField.shownValueBefore, projectedField.finalValue)
        && (completionField.operationalDecision === "CANDIDATE_RETAINED"
          ? equal(completionField.finalValue, completionField.shownValueBefore)
          : completionField.operationalDecision === "USER_EDITED"
            ? completionField.finalValue !== null && !equal(completionField.finalValue, completionField.shownValueBefore)
            : completionField.finalValue === null), "Completion3 field decision/value mismatch");
      assert(completionField && projectedField && field.finalValue === completionField.finalValue
        && field.operationalDecision === completionField.operationalDecision
        && field.correctedValue === projectedField.finalValue && field.normalizedValue === projectedField.normalizedValue
        && field.shownValueBefore === completionField.shownValueBefore
        && equal(field.riskReasons, completionField.riskReasons) && equal(field.correctionReasons, projectedField.correctionReasons)
        && equal(field.masterBinding, manifest.masterBinding), "Export3 field trace mismatch");
      const sourceBindings = [];
      const expectedRawEvidence = []; const expectedCrops = [];
      for (const ref of row.sourceRefs) {
        const sf = sourceFieldMap.get(`${ref.sourceRowId}\0${name}`);
        assert(sf, "logical row refers to unknown source field");
        expectedRawEvidence.push(sf.rawEvidence); expectedCrops.push(...sf.cropRefs);
        for (const crop of sf.cropRefs) sourceBindings.push({ sourceRowId: ref.sourceRowId, crop });
      }
      assert(equal(field.rawEvidence, expectedRawEvidence) && equal(field.cropRefs, expectedCrops), "Export3 logical field dropped source evidence");
      const physical = new Map();
      for (const item of sourceBindings) physical.set(physicalCropKey(item.crop, name), item);
      let truthValues = []; let truthLabelIds = new Set(); let truthEligible = physical.size > 0; let truthDisputed = false;
      for (const key of physical.keys()) {
        const knownLabels = [];
        for (const { sourceId, fieldName, crop } of allPhysicalBindings.get(key) ?? []) {
          if (fieldName !== name) continue;
          const label = latest.get(`${sourceId}\0${name}\0${crop.cropRefId}`);
          if (label) { truthLabelIds.add(label.labelId); if (label.labelStatus === "KNOWN") knownLabels.push(label);
            if (label.labelStatus === "DISPUTED") truthDisputed = true; }
        }
        const values = new Map(knownLabels.map((label) => [stable(label.value), label.value]));
        if (values.size > 1) truthDisputed = true;
        if (values.size !== 1) truthEligible = false;
        else truthValues.push([...values.values()][0]);
      }
      if (new Set(truthValues.map(stable)).size !== 1) truthEligible = false;
      assert(field.knownTruthEligible === truthEligible
        && field.truthEvidence === (truthEligible ? "HUMAN_CROP_VERIFIED" : "NONE")
        && (truthEligible ? equal(field.truthValue, truthValues[0]) : field.truthValue === null),
      "Export3 knownTruthEligible claim does not match bound crop truth");
      assert(equal([...field.truthLabelIds].sort(compareText), [...truthLabelIds].sort(compareText)), "Export3 truth label references mismatch");
      logicalFields.push({ row, projectionRow: pRow, completionRow: cRow, field, sourceBindings, truthEligible, truthDisputed });
    }
  }
  assert(seenRows.size === projectionRows.size && mappedSources.size === sourceIds.size, "Export3 dropped logical/source row");
  assert(Array.isArray(projection.edgeWorkItems) && Array.isArray(completion.workItems)
    && equal(dataset.edgeWorkItems, completion.workItems) && projection.edgeWorkItems.length === completion.workItems.length,
  "Export3 edge work item accounting mismatch");
  const edgeWorkIds = new Set(); const completionWorkById = new Map();
  for (const work of completion.workItems) {
    assert(exactKeys(work, ["workItemId", "decision", "reason"]) && nonempty(work.workItemId)
      && ["RECAPTURE_REQUIRED", "EXPLICITLY_EXCLUDED"].includes(work.decision) && nonempty(work.reason)
      && !completionWorkById.has(work.workItemId), "invalid Completion3 work item");
    completionWorkById.set(work.workItemId, work);
  }
  for (const edge of projection.edgeWorkItems) {
    assert(exactKeys(edge, ["workItemId", "edgeId", "classification", "reason", "sourceRefs"])
      && nonempty(edge.workItemId) && nonempty(edge.edgeId) && edge.classification === "NEEDS_RECAPTURE"
      && nonempty(edge.reason) && Array.isArray(edge.sourceRefs) && !edgeWorkIds.has(edge.workItemId)
      && completionWorkById.has(edge.workItemId), "invalid Projection3 edge work item");
    edgeWorkIds.add(edge.workItemId);
  }
  assert(edgeWorkIds.size === completionWorkById.size, "Completion3 omitted or added edge work items");
  const expectedCropEvidence = new Set();
  const cropEvidenceByKey = new Map();
  for (const item of semantic.cropEvidence) {
    assert(exactKeys(item, ["projectionRowId", "field", "cropRefId", "artifactSha256", "pixelSha256", "state", "retentionClass"])
      && projectionRows.has(item.projectionRowId) && FIELDS.includes(item.field) && nonempty(item.cropRefId)
      && (item.artifactSha256 === null || validHash(item.artifactSha256)) && (item.pixelSha256 === null || validHash(item.pixelSha256))
      && ["AVAILABLE", "NOT_UPLOADED", "MISSING", "EXPIRED"].includes(item.state) && RETENTION.has(item.retentionClass),
    "invalid cropEvidence entry");
    const key = `${item.projectionRowId}\0${item.field}\0${item.cropRefId}`;
    assert(!expectedCropEvidence.has(key), "duplicate cropEvidence entry"); expectedCropEvidence.add(key); cropEvidenceByKey.set(key, item);
  }
  const cropPlan = observation.cropPlan;
  assert(exactKeys(cropPlan, ["schemaVersion", "policy", "entries"]) && cropPlan.schemaVersion === 3
    && cropPlan.policy === "C2_LOGICAL_REPRESENTATIVE_V3" && Array.isArray(cropPlan.entries)
    && cropPlan.entries.length === projection.rows.length * FIELDS.length, "invalid frozen CropPlan3");
  const cropPlanKeys = new Set();
  for (const [rowIndex, pRow] of projection.rows.entries()) for (const [fieldIndex, name] of FIELDS.entries()) {
    const completionField = completionRows.get(pRow.projectionRowId).fields[fieldIndex];
    const projectedField = pRow.fields[fieldIndex];
    const entry = cropPlan.entries[rowIndex * FIELDS.length + fieldIndex];
    assert(exactKeys(entry, ["projectionRowId", "field", "cropRefId", "selected", "reasons", "retentionClass"])
      && entry.projectionRowId === pRow.projectionRowId && entry.field === name && typeof entry.selected === "boolean"
      && Array.isArray(entry.reasons), "invalid CropPlan3 entry/order");
    const representativeId = pRow.sourceRefs[0]?.sourceRowId;
    const representative = rawRowsById.get(representativeId);
    const representativeCrop = representative?.fields.find((item) => item.field === name)?.cropRefs[0]?.cropRefId ?? null;
    const reasons = [];
    if (completionField.operationalDecision === "USER_EDITED") reasons.push("USER_EDITED");
    if (completionField.operationalDecision === "USER_MARKED_UNKNOWN") reasons.push("USER_MARKED_UNKNOWN");
    if (projectedField.riskReasons.length) reasons.push("RISKY_FIELD");
    const selected = reasons.length > 0 && representativeCrop !== null;
    const retentionClass = !selected ? "NONE" : completionField.operationalDecision === "USER_MARKED_UNKNOWN"
      ? "UNKNOWN_EVIDENCE" : "OPERATIONAL_REVIEW_EVIDENCE";
    assert(entry.cropRefId === representativeCrop && entry.selected === selected && equal(entry.reasons, reasons)
      && entry.retentionClass === retentionClass, "CropPlan3 does not match Completion3/projection/source evidence");
    const key = `${entry.projectionRowId}\0${entry.field}\0${entry.cropRefId}`;
    assert(!cropPlanKeys.has(key), "duplicate CropPlan3 entry"); cropPlanKeys.add(key);
    const evidence = cropEvidenceByKey.get(key);
    const crop = representative?.fields.find((item) => item.field === name)?.cropRefs[0] ?? null;
    assert(evidence && evidence.pixelSha256 === (crop?.pixelSha256 ?? null) && evidence.retentionClass === retentionClass
      && (evidence.state === "AVAILABLE" ? validHash(evidence.artifactSha256)
        : evidence.state === "NOT_UPLOADED" || evidence.state === "MISSING" || evidence.state === "EXPIRED")
      && (entry.selected || evidence.state === "NOT_UPLOADED" && evidence.artifactSha256 === null),
    "cropEvidence does not match its frozen source crop/retention plan");
  }
  assert(cropPlanKeys.size === expectedCropEvidence.size && [...cropPlanKeys].every((key) => expectedCropEvidence.has(key)),
    "Export3 crop evidence differs from frozen crop plan");
  return { semantic, observation, projection, completion, dataset, rawRows, sourceFieldMap, logicalFields, latest, labels: semantic.truthLabels };
}

function frozenSplit(splitManifest) {
  assert(isRecord(splitManifest) && splitManifest.schemaVersion === 1 && splitManifest.frozen === true
    && Array.isArray(splitManifest.assignments) && validHash(splitManifest.manifestHash), "splitManifest must be a frozen schemaVersion 1 manifest");
  const base = { schemaVersion: splitManifest.schemaVersion, frozen: splitManifest.frozen, assignments: splitManifest.assignments };
  assert(semanticEvaluationSha256(base) === splitManifest.manifestHash, "splitManifest hash mismatch");
  const assignments = new Map();
  for (const entry of splitManifest.assignments) {
    assert(exactKeys(entry, ["sourceFamilyId", "cohort"]) && nonempty(entry.sourceFamilyId)
      && ["DEVELOPMENT", "INDEPENDENT"].includes(entry.cohort) && !assignments.has(entry.sourceFamilyId),
    "invalid splitManifest assignment");
    assignments.set(entry.sourceFamilyId, entry.cohort);
  }
  return { assignments, manifestHash: splitManifest.manifestHash };
}
function evalInvalid(errors, partial = {}) {
  const report = { schemaVersion: 3, evaluationPolicyVersion: FINAL_EVALUATION_POLICY, evaluationStatus: "INVALID_EVALUATION",
    invalidReasons: [...new Set(errors)].sort(compareText), denominators: { S: null, R: null, F: null, V: null, T: null, K: null, B: null, E: null },
    metrics: { status: "INVALID", accuracyAvailable: false }, ...partial };
  report.semanticHash = semanticEvaluationSha256(report); return report;
}
function evaluateFinalTradeReviewDataset({ observations, evaluationPolicyVersion = FINAL_EVALUATION_POLICY, splitManifest = null } = {}) {
  assert(evaluationPolicyVersion === FINAL_EVALUATION_POLICY, `unsupported evaluationPolicyVersion: ${String(evaluationPolicyVersion)}`);
  assert(Array.isArray(observations), "observations must be an Export3 array");
  let split = null; const errors = [];
  try { if (splitManifest !== null) split = frozenSplit(splitManifest); }
  catch (error) { errors.push(`SPLIT_MANIFEST_INVALID:${error.message}`); }
  const prepared = [];
  try {
    for (const input of observations) {
      const exportRecord = input?.exportRecord ?? input;
      assert(exportRecord?.schemaVersion === 3, "Export1/Export3 mixed or unsupported input");
      prepared.push(validateFinalExport(exportRecord));
    }
  } catch (error) { return evalInvalid([`EXPORT_INVALID:${error.message}`]); }
  const byObservation = new Map();
  for (const item of prepared) {
    const id = item.observation.observationId;
    if (byObservation.has(id)) errors.push("DUPLICATE_OBSERVATION_ID");
    else byObservation.set(id, item);
  }
  const familyCohorts = new Map(); const familyCropCohorts = new Map(); const seenPhysicalSources = new Map();
  const labelInfo = [];
  for (const item of prepared) {
    const sourceFamilies = new Set();
    for (const label of item.labels) {
      const p = label.provenance; const expectedCohort = split?.assignments.get(p.sourceFamilyId);
      if (p.cohort === "INDEPENDENT") {
        if (!split || !expectedCohort || expectedCohort !== "INDEPENDENT" || p.splitManifestHash !== split.manifestHash
          || p.sourceOrigin !== "FRESH_CAPTURE" || p.independentOfOperationalReview !== true) errors.push("INDEPENDENT_TRUTH_NOT_BOUND_TO_FROZEN_SPLIT");
      } else if (p.cohort === "DEVELOPMENT" && split && (expectedCohort !== "DEVELOPMENT" || p.splitManifestHash !== split.manifestHash)) {
        errors.push("DEVELOPMENT_TRUTH_NOT_BOUND_TO_FROZEN_SPLIT");
      }
      if (p.cohort === "INDEPENDENT" || p.cohort === "DEVELOPMENT") {
        sourceFamilies.add(p.sourceFamilyId);
        const cohorts = familyCohorts.get(p.sourceFamilyId) ?? new Set(); cohorts.add(p.cohort); familyCohorts.set(p.sourceFamilyId, cohorts);
      }
      const crop = item.sourceFieldMap.get(`${label.sourceRowId}\0${label.field}`)?.cropRefs.find((ref) => ref.cropRefId === label.cropRefId);
      if (crop) {
        const physical = physicalCropKey(crop, label.field);
        const cohorts = familyCropCohorts.get(physical) ?? new Set(); cohorts.add(p.cohort); familyCropCohorts.set(physical, cohorts);
        const refs = seenPhysicalSources.get(physical) ?? new Set(); refs.add(`${p.sourceFamilyId}\0${p.cohort}`); seenPhysicalSources.set(physical, refs);
      }
      labelInfo.push({ label, provenance: p });
    }
  }
  if ([...familyCohorts.values()].some((cohorts) => cohorts.size > 1)
      || [...familyCropCohorts.values()].some((cohorts) => cohorts.has("DEVELOPMENT") && cohorts.has("INDEPENDENT"))) {
    errors.push("DEVELOPMENT_INDEPENDENT_LEAKAGE");
  }
  if ([...seenPhysicalSources.values()].some((owners) => new Set([...owners].map((value) => value.split("\0")[0])).size > 1)) {
    errors.push("PHYSICAL_CROP_SOURCE_FAMILY_LAUNDERING");
  }
  if (errors.length) return evalInvalid(errors);
  const allLogical = prepared.flatMap((item) => item.logicalFields.map((entry) => ({ ...entry, item })));
  const sourceAttempts = [];
  for (const item of prepared) for (const sf of item.sourceFieldMap.values()) {
    for (const crop of sf.cropRefs) {
      const key = physicalCropKey(crop, sf.field);
      const label = item.latest.get(`${sf.sourceRowId}\0${sf.field}\0${crop.cropRefId}`);
      sourceAttempts.push({ item, sf, crop, key, truthLabel: label?.labelStatus === "KNOWN" ? label : null,
        raw: finalRawValue(sf, sf.field), corrected: sf.correctedValue });
    }
  }
  const physicalAttempts = new Map();
  for (const attempt of sourceAttempts) {
    const entry = physicalAttempts.get(attempt.key) ?? { attempts: [], truths: new Map(), labels: [] };
    entry.attempts.push(attempt);
    if (attempt.truthLabel) {
      entry.truths.set(stable(attempt.truthLabel.value), attempt.truthLabel.value);
      entry.labels.push(attempt.truthLabel);
    }
    physicalAttempts.set(attempt.key, entry);
  }
  const independentPhysicalKeys = new Set(sourceAttempts.filter((attempt) => attempt.truthLabel
    && attempt.truthLabel.provenance.cohort === "INDEPENDENT" && attempt.truthLabel.provenance.sourceOrigin === "FRESH_CAPTURE"
    && attempt.truthLabel.provenance.independentOfOperationalReview === true).map((attempt) => attempt.key));
  const eligiblePhysical = [...physicalAttempts.entries()].filter(([key, entry]) => independentPhysicalKeys.has(key) && entry.truths.size === 1)
    .map(([, entry]) => entry);
  const disputedPhysicalKeys = new Set([...physicalAttempts.entries()].filter(([, entry]) => entry.truths.size > 1).map(([key]) => key));
  const independentLabels = labelInfo.filter(({ label, provenance }) => label.labelStatus === "KNOWN"
    && provenance.cohort === "INDEPENDENT" && provenance.sourceOrigin === "FRESH_CAPTURE" && provenance.independentOfOperationalReview === true);
  const errorsAfter = [];
  // Independent truth already passed the frozen-manifest checks above; descriptive-only datasets remain valid.
  const S = prepared.reduce((sum, item) => sum + item.rawRows.length, 0);
  const R = allLogical.length / FIELDS.length; const F = R * FIELDS.length;
  const truthFields = allLogical.filter((entry) => {
    if (!entry.truthEligible) return false;
    const physical = new Set(entry.sourceBindings.map(({ crop }) => physicalCropKey(crop, entry.field.field)));
    return [...physical].every((key) => {
      const labels = (physicalAttempts.get(key)?.labels ?? []).filter((label) => label.labelStatus === "KNOWN");
      return !disputedPhysicalKeys.has(key) && labels.length > 0
        && new Set(labels.map((label) => stable(label.value))).size === 1
        && labels.some((label) => label.provenance.cohort === "INDEPENDENT" && label.provenance.sourceOrigin === "FRESH_CAPTURE"
          && label.provenance.independentOfOperationalReview === true);
    });
  });
  const V = truthFields.length;
  const rowGroups = new Map();
  for (const entry of allLogical) { const key = `${entry.item.observation.observationId}\0${entry.row.projectionRowId}`; const group = rowGroups.get(key) ?? []; group.push(entry); rowGroups.set(key, group); }
  const knownRows = [...rowGroups.values()].filter((fields) => fields.length === 6 && fields.every((entry) => truthFields.includes(entry)));
  const T = knownRows.length; const E = prepared.reduce((sum, item) => sum + item.dataset.edgeWorkItems.length, 0); const B = F;
  const K = eligiblePhysical.length;
  const metric = {};
  const scorePhysical = (fieldNames, predicate) => {
    const entries = eligiblePhysical.filter((entry) => fieldNames.has(entry.attempts[0].sf.field));
    return finalRatio(entries.filter((entry) => entry.attempts.every((attempt) => predicate(attempt, entry.truths.values().next().value))).length, entries.length);
  };
  const names = new Set(["island", "fromItem", "toItem"]); const nums = new Set(NUMERIC);
  metric.RAW_TEXT_EXACT = scorePhysical(names, (attempt, truth) => attempt.raw === truth);
  metric.RAW_NUMERIC_EXACT = scorePhysical(nums, (attempt, truth) => attempt.raw === truth);
  const rawAll = prepared.flatMap((item) => [...item.sourceFieldMap.values()].map((sf) => ({ sf, raw: finalRawValue(sf, sf.field) })));
  const rawEmpty = rawAll.filter(({ sf }) => {
    const value = sf.rawEvidence.rawText;
    return sf.field === "island" || sf.field === "fromItem" || sf.field === "toItem"
      ? value === null || value === "" : sf.rawEvidence.rawNumeric === null;
  }).length;
  metric.RAW_EMPTY_RATE = finalRatio(rawEmpty, S * FIELDS.length);
  metric.RAW_EMPTY_RATE_KNOWN = finalRatio(eligiblePhysical.filter((entry) => entry.attempts.every((attempt) => attempt.raw === null)).length, K);
  metric.RAW_WRONG_CONFIDENT_RATE = { numerator: null, denominator: null, rate: null, status: "N/A", reason: "NO_FROZEN_CONFIDENCE_CALIBRATION" };
  const rawWrong = eligiblePhysical.filter((entry) => !entry.attempts.every((a) => a.raw === entry.truths.values().next().value));
  const rawCorrect = eligiblePhysical.filter((entry) => entry.attempts.every((a) => a.raw === entry.truths.values().next().value));
  metric.CORRECTION_RECOVERY = finalRatio(rawWrong.filter((entry) => entry.attempts.every((a) => a.corrected === entry.truths.values().next().value)).length, rawWrong.length);
  metric.CORRECTION_HARM = finalRatio(rawCorrect.filter((entry) => entry.attempts.some((a) => a.corrected === null || a.corrected !== entry.truths.values().next().value)).length, rawCorrect.length);
  const identityFields = allLogical.filter((entry) => IDENTITY.has(entry.field.field));
  const unresolved = identityFields.filter((entry) => {
    const projectionField = entry.projectionRow.fields.find((f) => f.field === entry.field.field);
    const authority = projectionField?.identity?.authorityStatus;
    return !(projectionField?.identity?.kind === "OPEN_WORLD" && entry.field.field === "fromItem")
      && !(projectionField?.identity?.stableId && ["VERIFIED_CURATED", "VERIFIED_REFERENCE"].includes(authority));
  }).length;
  metric.MASTER_UNRESOLVED = finalRatio(unresolved, R * 3);
  metric.MASTER_OPEN_WORLD_RESOLVED = count(identityFields.filter((entry) => {
    const p = entry.projectionRow.fields.find((f) => f.field === entry.field.field);
    return entry.field.field === "fromItem" && p?.identity?.kind === "OPEN_WORLD";
  }).length);
  const numericLogical = allLogical.filter((entry) => NUMERIC.has(entry.field.field));
  const numericFailed = (value, entry) => value === null || !validFinalValue(value, entry.field.field)
    || riskCodes(entry.field.riskReasons).some((code) => /CLIPPED|CONFLICT|INVALID|INCOMPLETE/.test(code));
  metric.NUMERIC_RESOLUTION_FAILURE = finalRatio(numericLogical.filter((entry) => numericFailed(entry.field.correctedValue, entry)).length, 3 * R);
  metric.RAW_NUMERIC_FAILURE = finalRatio(rawAll.filter(({ sf, raw }) => NUMERIC.has(sf.field) && raw === null).length, 3 * S);
  metric.FINAL_FIELD_ACCURACY = finalRatio(truthFields.filter((entry) => entry.field.correctedValue === entry.field.truthValue).length, V);
  metric.FINAL_SIX_FIELD_ROW_ACCURACY = finalRatio(knownRows.filter((fields) => fields.every((entry) => entry.field.correctedValue === entry.field.truthValue)).length, T);
  metric.POST_REVIEW_OPERATIONAL_EXACT = finalRatio(truthFields.filter((entry) => entry.field.finalValue === entry.field.truthValue).length, V);
  const rowEntries = prepared.flatMap((item) => item.dataset.rows.map((row) => ({ observationId: item.observation.observationId, row })));
  for (const classification of CLASSIFICATIONS) metric[`${classification}_RATE`] = finalRatio(rowEntries.filter((entry) => entry.row.classification === classification).length, R);
  const edited = allLogical.filter((entry) => entry.field.operationalDecision === "USER_EDITED");
  metric.USER_EDIT_RATE_AFTER_FULL_CORRECTION = finalRatio(edited.length, F);
  metric.USER_EDITED_ROWS_RATE = finalRatio(new Set(edited.map((entry) => `${entry.item.observation.observationId}\0${entry.row.projectionRowId}`)).size, R);
  metric.USER_EDITED_BY_FIELD = Object.fromEntries(FIELDS.map((field) => [field, finalRatio(edited.filter((entry) => entry.field.field === field).length, R)]));
  const unknown = allLogical.filter((entry) => entry.field.operationalDecision === "USER_MARKED_UNKNOWN");
  metric.UNKNOWN_FIELD_COUNT = count(unknown.length); metric.UNKNOWN_FIELD_RATE = finalRatio(unknown.length, F);
  metric.UNKNOWN_ROW_COUNT = count(new Set(unknown.map((entry) => `${entry.item.observation.observationId}\0${entry.row.projectionRowId}`)).size);
  const riskEmptyKnown = truthFields.filter((entry) => riskCodes(entry.field.riskReasons).length === 0);
  metric.UNHIGHLIGHTED_ERROR_RATE = finalRatio(riskEmptyKnown.filter((entry) => entry.field.correctedValue !== entry.field.truthValue).length, riskEmptyKnown.length);
  metric.UNHIGHLIGHTED_COVERAGE = finalRatio(riskEmptyKnown.length, V);
  metric.UNHIGHLIGHTED_EDIT_COUNT = count(edited.filter((entry) => riskCodes(entry.field.riskReasons).length === 0).length);
  let dtoReadyRows = 0; let dtoExcludedRows = 0;
  for (const item of prepared) {
    const observation = item.observation; const projection = observation.projection; const completion = observation.completion;
    dtoExcludedRows += completion.rows.filter((row) => row.disposition === "EXCLUDE").length;
    const receipt = { schemaVersion: 3, observationId: observation.observationId, mutationId: observation.mutationId,
      payloadHash: observation.payloadHash, observationHash: observation.observationHash, persistedAt: observation.persistedAt,
      duplicate: false, evidenceSaved: true, sessionApplied: false, reviewMode: "FINAL_CORRECTED_RESULT",
      projectionHash: projection.projectionHash, masterBinding: projection.masterBinding,
      reviewRevision: completion.reviewRevision, cropPolicy: observation.cropPlan?.policy };
    const expectedReview = { schemaVersion: 3, recognitionBatchId: projection.recognitionBatchId,
      projectionHash: projection.projectionHash, reviewRevision: completion.reviewRevision, masterBinding: projection.masterBinding,
      correctionVersion: projection.correctionVersion, completionValuesHash: completion.batchConfirmation?.completionValuesHash,
      pixelAvailability: projection.pixelAvailability };
    const exclusions = completion.rows.filter((row) => row.disposition === "EXCLUDE").map((row) => ({
      projectionRowId: row.projectionRowId, action: "EXCLUDE_FROM_FINAL_DTO", reason: "USER_EXPLICIT_EXCLUSION" }));
    try {
      const result = validateReviewedTradeBatch({ storedObservation: observation, evidenceReceipt: receipt, expectedReview,
        exclusions, mappingPolicyVersion: "reviewed-trade-dto-mapping-v3" });
      dtoReadyRows += result.rows?.length ?? 0;
    } catch { /* invalid observation contributes zero ready outputs */ }
  }
  metric.DTO_READY_RATE = { includingExplicitExclusions: finalRatio(dtoReadyRows, R),
    excludingExplicitExclusions: finalRatio(dtoReadyRows, Math.max(0, R - dtoExcludedRows)),
    readyRows: dtoReadyRows, explicitExclusions: dtoExcludedRows,
    note: "DTO readiness is an operational gate, not an accuracy claim." };
  const independentTruthAvailable = independentLabels.length > 0;
  const output = { schemaVersion: 3, evaluationPolicyVersion: FINAL_EVALUATION_POLICY,
    evaluationStatus: independentTruthAvailable ? "VALID_INDEPENDENT_EVALUATION" : "VALID_DESCRIPTIVE_EVALUATION",
    splitManifestHash: split?.manifestHash ?? null,
    denominators: { S, R, F, V, T, K, B, E }, metrics: metric,
    coverage: { truthEligibleLogicalFields: V, logicalFieldCount: F, unknownFieldCount: unknown.length,
      unknownRowCount: metric.UNKNOWN_ROW_COUNT.count, disputedFieldCount: allLogical.filter((entry) => entry.truthDisputed
        || entry.sourceBindings.some(({ crop }) => disputedPhysicalKeys.has(physicalCropKey(crop, entry.field.field)))).length,
      operationalObservationCount: prepared.length, independentTruthLabelCount: independentLabels.length,
      developmentTruthLabelCount: labelInfo.filter(({ label }) => label.labelStatus === "KNOWN" && label.provenance.cohort === "DEVELOPMENT").length },
    rowClassifications: Object.fromEntries([...CLASSIFICATIONS].sort(compareText).map((value) => [value, metric[`${value}_RATE`]])),
    warnings: ["Operational review decisions are not independent truth.", "RAW_WRONG_CONFIDENT_RATE is N/A without frozen calibration.",
      "DTO readiness is not persisted in Export3 and is therefore N/A in this evaluator."] };
  output.semanticHash = semanticEvaluationSha256(output);
  return output;
}

export { evaluateFinalTradeReviewDataset };
export function evaluateTradeReviewDataset(options = {}) {
  if (options.evaluationPolicyVersion === FINAL_EVALUATION_POLICY) {
    return evaluateFinalTradeReviewDataset({ observations: options.observations, evaluationPolicyVersion: options.evaluationPolicyVersion,
      splitManifest: options.splitManifest });
  }
  return evaluateLegacyTradeReviewDataset(options);
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!["--manifest", "--out"].includes(key) || result[key] || !argv[i + 1] || argv[i + 1].startsWith("--")) {
      throw new TypeError("usage: node trade_review_evaluation.mjs --manifest <manifest.json> --out <report.json>");
    }
    result[key] = argv[++i];
  }
  if (!result["--manifest"] || !result["--out"]) throw new TypeError("usage: node trade_review_evaluation.mjs --manifest <manifest.json> --out <report.json>");
  return result;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = await realpath(path.resolve(args["--manifest"]));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert(isRecord(manifest) && manifest.schemaVersion === 1 && Array.isArray(manifest.observations), "manifest schemaVersion 1 with observations[] required");
  const base = path.dirname(manifestPath);
  const resolveInput = async (relative) => {
    assert(nonempty(relative) && !path.isAbsolute(relative), "manifest input paths must be relative to the manifest file");
    return realpath(path.resolve(base, relative));
  };
  const sourcePaths = new Set([manifestPath]);
  const observations = [];
  for (const entry of manifest.observations) {
    assert(isRecord(entry) && nonempty(entry.exportPath), "manifest observation entries require exportPath");
    const sourcePath = await resolveInput(entry.exportPath); sourcePaths.add(sourcePath);
    const exportRecord = JSON.parse(await readFile(sourcePath, "utf8"));
    if (manifest.evaluationPolicyVersion === FINAL_EVALUATION_POLICY) observations.push(exportRecord);
    else {
      assert(Array.isArray(entry.exclusions) && COHORTS.has(entry.cohort), "invalid legacy manifest observation entry");
      observations.push({ exportRecord, exclusions: entry.exclusions, cohort: entry.cohort });
    }
  }
  let splitManifest = null;
  if (manifest.evaluationPolicyVersion === FINAL_EVALUATION_POLICY) {
    if (typeof manifest.splitManifestPath === "string") {
      const splitPath = await resolveInput(manifest.splitManifestPath); sourcePaths.add(splitPath);
      splitManifest = JSON.parse(await readFile(splitPath, "utf8"));
    } else splitManifest = manifest.splitManifest ?? null;
  }
  const candidateRuns = [];
  for (const entry of manifest.candidateRuns ?? []) {
    assert(isRecord(entry) && nonempty(entry.path), "candidateRuns entries require path");
    const sourcePath = await resolveInput(entry.path); sourcePaths.add(sourcePath);
    const parsed = JSON.parse(await readFile(sourcePath, "utf8"));
    candidateRuns.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  const outputPath = path.resolve(args["--out"]);
  const outputKey = path.normalize(outputPath).toLowerCase();
  assert(![...sourcePaths].some((source) => path.normalize(source).toLowerCase() === outputKey), "output path cannot overwrite an input file");
  const localApp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const protectedRoots = [path.join(localApp, "frontend"), path.join(localApp, "backend"), path.resolve(localApp, "..", "reference"),
    path.resolve(localApp, "..", "specs")].map((item) => path.normalize(item).toLowerCase());
  assert(!protectedRoots.some((root) => outputKey === root || outputKey.startsWith(`${root}${path.sep}`.toLowerCase())),
    "output path cannot overwrite production source, catalog/reference, or specification files");
  const report = evaluateTradeReviewDataset({ observations, candidateRuns,
    evaluationPolicyVersion: manifest.evaluationPolicyVersion, rawEvaluationVersion: manifest.rawEvaluationVersion,
    splitSeed: manifest.splitSeed, splitManifest });
  const envelope = { ...report, generatedAt: new Date().toISOString() };
  await mkdir(path.dirname(outputPath), { recursive: true });
  const canonicalOutput = path.join(await realpath(path.dirname(outputPath)), path.basename(outputPath));
  const canonicalKey = path.normalize(canonicalOutput).toLowerCase();
  assert(![...sourcePaths].some((source) => path.normalize(source).toLowerCase() === canonicalKey), "output path cannot overwrite an input file");
  assert(!protectedRoots.some((root) => canonicalKey === root || canonicalKey.startsWith(`${root}${path.sep}`.toLowerCase())),
    "output path cannot overwrite production source, catalog/reference, or specification files");
  await writeFile(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({ outputPath, semanticHash: report.semanticHash, evaluationStatus: report.evaluationStatus })}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`trade_review_evaluation: ${error.message}\n`); process.exitCode = 1; });
}
