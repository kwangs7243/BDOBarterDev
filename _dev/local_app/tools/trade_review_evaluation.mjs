#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReviewedTradeBatch } from "../frontend/js/domain/reviewed-trade-dto.js";

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
export function evaluateTradeReviewDataset({ observations, candidateRuns = [], evaluationPolicyVersion, rawEvaluationVersion, splitSeed } = {}) {
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
    assert(isRecord(entry) && nonempty(entry.exportPath) && Array.isArray(entry.exclusions) && COHORTS.has(entry.cohort), "invalid manifest observation entry");
    const sourcePath = await resolveInput(entry.exportPath); sourcePaths.add(sourcePath);
    observations.push({ exportRecord: JSON.parse(await readFile(sourcePath, "utf8")), exclusions: entry.exclusions, cohort: entry.cohort });
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
    splitSeed: manifest.splitSeed });
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
