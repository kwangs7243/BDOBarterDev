import { buildFinalProjection3 } from "./trade-final-evidence.js";

const FIELDS = Object.freeze(["island", "fromItem", "reqAmount", "toItem", "count", "yield"]);
const TEXT_FIELDS = new Set(["island", "fromItem", "toItem"]);
const NUMERIC_MINIMUM = Object.freeze({ reqAmount: 1, count: 0, yield: 1 });
const PIXEL_STATES = new Set(["IN_MEMORY", "DURABLE", "MISSING", "EXPIRED", "INVALID"]);
const RECAPTURE_RISKS = new Set(["FIELD_CLIPPED", "GEOMETRY_ABSTAIN"]);
const CONFLICT_RISKS = new Set(["NUMERIC_READER_TEXT_DISAGREEMENT", "RECONCILIATION_CONFLICT", "DOMAIN_CONFLICT", "INPUT_CONFLICT"]);

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }
function fail(message) { throw new TypeError(message); }
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}
function clone(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
}
function unique(values) { return [...new Set(values)]; }
function codes(values) { return unique((values ?? []).map((entry) => typeof entry === "string" ? entry : entry?.code).filter(nonempty)); }
function sourceRefsFor(ids, sourceById) {
  return ids.map((sourceRowId) => {
    const source = sourceById.get(sourceRowId);
    if (!source) fail(`unknown source row: ${sourceRowId}`);
    return { sourceRowId, captureId: source.captureId, ordinal: source.ordinal };
  });
}
function rawField(source, fieldName) { return source.originalRawRow?.fields?.[fieldName] ?? null; }
function cropIds(source, fieldName) {
  const raw = rawField(source, fieldName);
  const candidates = [raw?.cropRefs, source.fields?.[fieldName]?.raw?.cropRefs];
  const ids = [];
  for (const list of candidates) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry === "string") continue; // Row-level strings are not field-bound CropRefs.
      if (!record(entry) || entry.field !== fieldName || !nonempty(entry.cropRefId)) continue;
      if (entry.sourceRowId !== undefined && entry.sourceRowId !== source.sourceRowId) continue;
      ids.push(entry.cropRefId);
    }
  }
  return unique(ids);
}
function identity(candidate, fieldName) {
  if (!candidate || !TEXT_FIELDS.has(fieldName)) return null;
  const candidateKind = candidate.kind === "SPECIAL_ITEM" || candidate.kind === "MASTER_ITEM" ? "ITEM" : candidate.kind;
  if (!new Set(["ITEM", "ISLAND"]).has(candidateKind)) return null;
  const authorityStatus = candidate.authorityStatus ?? candidate.nameStatus ?? null;
  if (!nonempty(authorityStatus)) return null;
  const result = {
    kind: candidateKind,
    stableId: candidate.stableId ?? null,
    legacyNameKey: candidate.legacyNameKey ?? null,
    authorityStatus,
  };
  if (result.stableId !== null && !nonempty(result.stableId)) fail("candidate stableId is invalid");
  if (result.legacyNameKey !== null && !nonempty(result.legacyNameKey)) fail("candidate legacyNameKey is invalid");
  if (authorityStatus === "OPEN_WORLD" && (fieldName !== "fromItem" || result.stableId !== null || result.legacyNameKey !== null)) fail("OPEN_WORLD is only valid for unresolved fromItem");
  return result;
}
function semanticCandidate(candidate, fieldName, fallbackReason) {
  if (!record(candidate) || candidate.value === undefined) return null;
  return { value: clone(candidate.value), identity: identity(candidate, fieldName), reason: candidate.matchKind ?? candidate.source ?? fallbackReason };
}
function sameCandidate(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function fieldCandidates(field, fieldName) {
  const candidates = [];
  for (const candidate of field.masterMatches ?? []) {
    const mapped = semanticCandidate(candidate, fieldName, "MASTER_CANDIDATE");
    if (mapped && !candidates.some((item) => sameCandidate(item, mapped))) candidates.push(mapped);
  }
  for (const candidate of field.correctionCandidates ?? []) {
    const mapped = semanticCandidate(candidate, fieldName, "CORRECTION_CANDIDATE");
    if (mapped && !candidates.some((item) => sameCandidate(item, mapped))) candidates.push(mapped);
  }
  if (field.selectedCandidate) {
    const mapped = semanticCandidate(field.selectedCandidate, fieldName, "SELECTED_CANDIDATE");
    if (mapped && !candidates.some((item) => sameCandidate(item, mapped))) candidates.push(mapped);
  } else if (!TEXT_FIELDS.has(fieldName) && Number.isSafeInteger(field.finalValue)) {
    const selected = semanticCandidate({ value: field.finalValue, source: field.selectedCandidate?.source ?? "NUMERIC_CANDIDATE" }, fieldName, "NUMERIC_CANDIDATE");
    if (!candidates.some((item) => sameCandidate(item, selected))) candidates.push(selected);
  }
  return candidates;
}
function fieldSourceRows(sourceRows, fieldName) {
  return sourceRows.map((source) => source.fields?.[fieldName]).filter(Boolean);
}
function alternativeRefs(alternative, memberIds, sourceById) {
  let ids = alternative?.sourceRowIds;
  if (!Array.isArray(ids) && Array.isArray(alternative?.sourceRefs)) ids = alternative.sourceRefs.map((ref) => ref.sourceRowId);
  if (!Array.isArray(ids) || !ids.length) ids = memberIds;
  const allowed = new Set(memberIds);
  return sourceRefsFor(unique(ids.filter((id) => allowed.has(id))), sourceById);
}
function fieldAlternatives(field, sourceFields, fieldName, memberIds, sourceById) {
  const alternatives = [];
  const sourceRefs = sourceRefsFor(memberIds, sourceById);
  const append = (value, refs, riskReasons) => {
    if (value !== null && value !== undefined && TEXT_FIELDS.has(fieldName) && typeof value !== "string") return;
    if (value !== null && value !== undefined && Object.hasOwn(NUMERIC_MINIMUM, fieldName) && !Number.isSafeInteger(value)) return;
    const item = { value: value ?? null, sourceRefs: clone(refs), riskReasons: codes(riskReasons) };
    if (!alternatives.some((candidate) => sameCandidate(candidate, item))) alternatives.push(item);
  };
  for (const alt of field.conflictAlternatives ?? []) append(alt.value, alternativeRefs(alt, memberIds, sourceById), alt.riskReasons ?? field.riskReasons);
  for (const alt of field.alternatives ?? []) append(alt.value, alternativeRefs(alt, memberIds, sourceById), alt.riskReasons ?? field.riskReasons);
  if (!alternatives.length && (field.finalStatus === "AMBIGUOUS" || codes(field.riskReasons).includes("AMBIGUOUS_MATCH"))) {
    for (const candidate of field.masterMatches ?? []) append(candidate.value, sourceRefs, field.riskReasons);
  }
  if (field.parse?.disagreement) {
    const sourceId = memberIds[0];
    append(field.parse.readerCandidate, sourceRefsFor([sourceId], sourceById), ["NUMERIC_READER_TEXT_DISAGREEMENT"]);
    append(field.parse.textParsedCandidate, sourceRefsFor([sourceId], sourceById), ["NUMERIC_READER_TEXT_DISAGREEMENT"]);
  }
  if (alternatives.length) return alternatives;
  if (sourceFields.length > 1) {
    sourceFields.forEach((sourceField, index) => append(sourceField.finalValue, sourceRefsFor([memberIds[index]], sourceById), sourceField.riskReasons));
  }
  return alternatives;
}
function projectionTrace(field, fieldName, rowClassification, stage7Reason) {
  const source = Array.isArray(field.stageTrace) ? field.stageTrace : [];
  const trace = [];
  const rawInput = field.raw?.text ?? field.raw?.numericCandidate ?? null;
  const stageValue = field.finalValue ?? null;
  for (const entry of source) {
    if (!Number.isSafeInteger(entry?.stage) || entry.stage < 0 || entry.stage > 6) continue;
    if (trace.some((item) => item.stage === entry.stage)) fail(`duplicate correction stage ${entry.stage}`);
    trace.push({ stage: entry.stage, ruleVersion: entry.ruleVersion, inputValue: clone(rawInput), outputValue: clone(stageValue), reason: typeof entry.reason === "string" ? entry.reason : null });
  }
  trace.sort((a, b) => a.stage - b.stage);
  trace.push({ stage: 7, ruleVersion: "trade-final-validation-v1", inputValue: clone(field.finalValue ?? null), outputValue: clone(field.finalValue ?? null), reason: stage7Reason ?? null });
  trace.push({ stage: 8, ruleVersion: "trade-final-classification-v1", inputValue: clone(field.finalValue ?? null), outputValue: clone(field.finalValue ?? null), reason: rowClassification });
  return trace;
}
function criticalCropFindings(field, fieldName, cropRefs, availability) {
  if (!cropRefs.length) return [`${fieldName}:CRITICAL_CROP_MISSING`];
  if (!cropRefs.some((id) => ["IN_MEMORY", "DURABLE"].includes(availability.get(id)))) return [`${fieldName}:CRITICAL_CROP_UNAVAILABLE`];
  return [];
}
function riskFindings(field, fieldName) {
  const risks = codes(field.riskReasons);
  return risks.map((code) => `${fieldName}:${code}`);
}
function fieldConflict(field) {
  const risks = codes(field.riskReasons);
  return field.finalStatus === "CONFLICT" || field.valueState === "CONFLICT" || risks.some((code) => CONFLICT_RISKS.has(code));
}
function sourceSemantic(field, fieldName) {
  if (!field) return { value: null, identity: null, conflict: true };
  const candidate = field.selectedCandidate;
  const value = field.finalValue ?? null;
  if (field.finalStatus === "CONFLICT" || codes(field.riskReasons).some((code) => CONFLICT_RISKS.has(code))) return { value, identity: null, conflict: true };
  if (TEXT_FIELDS.has(fieldName) && candidate?.stableId) return { value: null, identity: `stable:${candidate.stableId}`, conflict: false };
  if (TEXT_FIELDS.has(fieldName) && candidate?.legacyNameKey) return { value, identity: `legacy:${candidate.legacyNameKey}`, conflict: false };
  if (TEXT_FIELDS.has(fieldName) && candidate?.authorityStatus === "OPEN_WORLD") return { value, identity: `open:${value}`, conflict: false };
  return { value, identity: null, conflict: false };
}
function sourceValuesConflict(sourceFields, fieldName) {
  if (sourceFields.length < 2) return false;
  const semantics = sourceFields.map((field) => sourceSemantic(field, fieldName));
  if (semantics.some((entry) => entry.conflict)) return true;
  const first = semantics[0];
  return semantics.slice(1).some((entry) => first.identity !== null || entry.identity !== null
    ? entry.identity !== first.identity
    : entry.value !== first.value);
}
function isValidNumeric(fieldName, value) {
  return Number.isSafeInteger(value) && value >= NUMERIC_MINIMUM[fieldName];
}
function selectedIdentity(field) { return field.selectedCandidate ?? null; }
function domainFindings(row) {
  const fields = row.fields ?? {};
  const to = selectedIdentity(fields.toItem);
  const from = selectedIdentity(fields.fromItem);
  const island = selectedIdentity(fields.island);
  const findings = [];
  if (!to || !from || !island) return findings;
  const toKind = to.kind === "SPECIAL_ITEM" ? "SPECIAL_ITEM" : to.kind;
  if (!["SPECIAL_ITEM", "MASTER_ITEM", "ITEM"].includes(toKind) || island.kind !== "ISLAND" || !["MASTER_ITEM", "ITEM", "SPECIAL_ITEM"].includes(from.kind)) {
    findings.push("row:DOMAIN_CONFLICT");
    return findings;
  }
  if (toKind !== "SPECIAL_ITEM" && Number.isSafeInteger(to.tier)) {
    if (to.tier === 1) {
      if (from.authorityStatus !== "OPEN_WORLD") findings.push("row:DOMAIN_CONFLICT");
    } else if (from.authorityStatus !== "OPEN_WORLD") {
      if (Number.isSafeInteger(from.tier) && from.tier !== to.tier - 1) findings.push("row:DOMAIN_CONFLICT");
      else if (!Number.isSafeInteger(from.tier)) findings.push("row:TO_ITEM_DEPENDENCY_UNRESOLVED");
    }
    const expectedScope = to.tier === 6 ? "T6_ISLANDS" : to.tier === 7 ? "T7_ISLANDS" : "GENERAL_ISLANDS";
    if (Array.isArray(island.sourceScopes) && island.sourceScopes.length && !island.sourceScopes.includes(expectedScope)) findings.push("row:DOMAIN_CONFLICT");
    else if (!Array.isArray(island.sourceScopes) || !island.sourceScopes.length) findings.push("row:ISLAND_SCOPE_UNVERIFIED");
  } else if (toKind !== "SPECIAL_ITEM") {
    findings.push("row:TO_ITEM_TIER_UNRESOLVED");
  }
  return findings;
}
function classifyCore({ row, group, pixelAvailability }) {
  if (!record(row) || !record(row.fields) || !record(group) || !Array.isArray(group.memberSourceRowIds) || !group.memberSourceRowIds.length) fail("row and reconciliation group are required");
  if (Object.keys(row.fields).length !== 6 || FIELDS.some((field) => !record(row.fields[field]))) fail("row must contain exactly six correction fields");
  const availability = pixelAvailability instanceof Map ? pixelAvailability : new Map((pixelAvailability ?? []).map((item) => [item.cropRefId, item.state]));
  const reasons = [];
  let conflict = group.status === "CONFLICT";
  let recapture = false;
  let review = !new Set(["UNMERGED", "SINGLE", "EXACT_OVERLAP"]).has(group.status);
  if (group.status === "CONFLICT") reasons.push("row:RECONCILIATION_CONFLICT");
  const fieldFindings = {};
  for (const fieldName of FIELDS) {
    const field = row.fields[fieldName];
    const fieldReasons = [];
    if (!field || field.field !== fieldName) fail(`missing or misordered field ${fieldName}`);
    const riskCodes = codes(field.riskReasons);
    if (fieldConflict(field)) { conflict = true; fieldReasons.push(...riskCodes.filter((code) => CONFLICT_RISKS.has(code)).map((code) => `${fieldName}:${code}`)); if (!fieldReasons.length) fieldReasons.push(`${fieldName}:FIELD_CONFLICT`); }
    const clipped = riskCodes.some((code) => RECAPTURE_RISKS.has(code));
    if (clipped) { recapture = true; fieldReasons.push(...riskCodes.filter((code) => RECAPTURE_RISKS.has(code)).map((code) => `${fieldName}:${code}`)); }
    const cropRefs = field._cropRefs ?? [];
    const cropFinding = criticalCropFindings(field, fieldName, cropRefs, availability);
    if (cropFinding.length) { recapture = true; fieldReasons.push(...cropFinding); }
    if (!TEXT_FIELDS.has(fieldName) && !isValidNumeric(fieldName, field.finalValue)) {
      review = true;
      fieldReasons.push(`${fieldName}:NUMERIC_MISSING_OR_INVALID`);
    }
    if (riskCodes.length) { review = true; fieldReasons.push(...riskFindings(field, fieldName)); }
    if (TEXT_FIELDS.has(fieldName)) {
      const candidate = field.selectedCandidate;
      const authority = candidate?.authorityStatus ?? candidate?.nameStatus;
      if (!candidate || !["VERIFIED_CURATED", "VERIFIED_REFERENCE"].includes(authority)) {
        review = true;
        if (!riskCodes.length) fieldReasons.push(`${fieldName}:${authority === "LEGACY_UNVERIFIED" ? "LEGACY_UNVERIFIED" : "IDENTITY_UNRESOLVED"}`);
      }
      if (authority === "DISPUTED" || authority === "DEPRECATED") review = true;
      if (authority === "OPEN_WORLD") { review = true; fieldReasons.push(`${fieldName}:OPEN_WORLD_FROM_ITEM`); }
    }
    fieldFindings[fieldName] = unique(fieldReasons);
    reasons.push(...fieldFindings[fieldName]);
  }
  const domain = domainFindings(row);
  if (domain.length) {
    if (domain.some((finding) => finding.endsWith(":DOMAIN_CONFLICT"))) conflict = true;
    if (domain.some((finding) => !finding.endsWith(":DOMAIN_CONFLICT"))) review = true;
    reasons.push(...domain);
  }
  if (!Array.isArray(row.sourceRefs) || row.sourceRefs.length !== group.memberSourceRowIds.length) { review = true; reasons.push("row:SOURCE_LINEAGE_INVALID"); }
  const classification = conflict ? "CONFLICT" : recapture ? "NEEDS_RECAPTURE" : review ? "NEEDS_REVIEW" : "FINAL_READY";
  return { classification, classificationReasons: unique(reasons), fieldFindings, conflict, recapture, review };
}

export function classifyTradeFinalRow({ row, group, pixelAvailability } = {}) {
  const cleanRow = clone(row);
  const result = classifyCore({ row: cleanRow, group: clone(group), pixelAvailability: clone(pixelAvailability ?? []) });
  return deepFreeze(result);
}

function mapProjectionField(field, fieldName, sourceRows, memberIds, sourceById, rowClassification, stage7Reason = null) {
  const representativeSource = sourceRows[0];
  const sourceField = representativeSource.fields[fieldName];
  const allSourceFields = fieldSourceRows(sourceRows, fieldName);
  const ids = unique(sourceRows.flatMap((source) => cropIds(source, fieldName)));
  const fieldValueConflict = fieldConflict(field);
  const correctedValue = clone(sourceField.finalValue ?? null);
  const finalValue = fieldValueConflict ? null : clone(field.finalValue ?? null);
  const chosen = field.selectedCandidate ?? sourceField.selectedCandidate ?? null;
  const candidates = fieldCandidates({ ...sourceField, selectedCandidate: chosen }, fieldName);
  const selected = fieldValueConflict ? null : semanticCandidate(chosen, fieldName, "SELECTED_CANDIDATE");
  let selectedCandidateIndex = selected ? candidates.findIndex((candidate) => sameCandidate(candidate, selected)) : null;
  if (selected && selectedCandidateIndex < 0) { candidates.push(selected); selectedCandidateIndex = candidates.length - 1; }
  let valueState = "UNRESOLVED";
  if (fieldValueConflict) valueState = "CONFLICT";
  else if (codes(field.riskReasons).some((code) => RECAPTURE_RISKS.has(code))) valueState = "CLIPPED";
  else if (!TEXT_FIELDS.has(fieldName) ? isValidNumeric(fieldName, finalValue) : selected !== null && finalValue !== null) valueState = "RESOLVED";
  const alternatives = fieldAlternatives(field, allSourceFields, fieldName, memberIds, sourceById);
  const riskReasons = codes(allSourceFields.flatMap((entry) => entry.riskReasons ?? []));
  const correctionReasons = codes(allSourceFields.flatMap((entry) => entry.correctionReasons ?? []));
  return {
    field: fieldName,
    rawEvidenceRefs: memberIds.map((sourceRowId) => ({ sourceRowId, field: fieldName })),
    normalizedValue: clone(TEXT_FIELDS.has(fieldName) ? sourceField.normalized?.value ?? null : sourceField.parse?.candidate ?? null),
    candidates,
    selectedCandidateIndex,
    correctedValue,
    finalValue,
    identity: fieldValueConflict ? null : identity(chosen, fieldName),
    valueState,
    riskReasons,
    correctionReasons,
    alternatives,
    cropRefs: ids,
    stageTrace: projectionTrace({ ...field, finalValue }, fieldName, rowClassification, stage7Reason),
  };
}

function reconciliationLedger(correctionResult) {
  const sourceRows = correctionResult.sourceRows;
  const finalized = correctionResult.reconciliation?.finalized?.reconciliation ?? null;
  const captureOrder = finalized
    ? finalized.captureOrder.map((entry) => entry.captureId)
    : sourceRows.reduce((ids, source) => ids.includes(source.captureId) ? ids : [...ids, source.captureId], []);
  if (new Set(captureOrder).size !== captureOrder.length || captureOrder.some((id) => !nonempty(id))) fail("duplicate or invalid capture order");
  const sourceLedger = sourceRows.map((source, index) => ({ sourceRowId: source.sourceRowId, captureId: source.captureId, ordinal: source.ordinal, projectionSourceIndex: index }));
  if (sourceLedger.some((source, index) => !nonempty(source.sourceRowId) || !nonempty(source.captureId) || !Number.isSafeInteger(source.ordinal) || source.ordinal < 0 || !captureOrder.includes(source.captureId) || sourceRows.findIndex((entry) => entry.sourceRowId === source.sourceRowId) !== index)) fail("correction source row ledger is invalid");
  if (!finalized) {
    const logicalRows = new Map(correctionResult.logicalRows.map((row) => [row.sourceRowId, row]));
    const groups = sourceLedger.map((source) => {
      const logical = logicalRows.get(source.sourceRowId);
      if (!logical) fail("unreconciled source row has no logical correction row");
      return { groupId: source.sourceRowId, status: "SINGLE", memberSourceRowIds: [source.sourceRowId], representativeSourceRowId: source.sourceRowId,
        logicalRowId: source.sourceRowId, memberEvidence: [], logical };
    });
    return { ledger: { schemaVersion: 2, policyVersion: "trade-batch-reconciliation-v1", captureOrder, sourceRows: sourceLedger, groups: groups.map(({ logical, ...group }) => group),
      sourceToLogical: sourceLedger.map((source) => ({ sourceRowId: source.sourceRowId, logicalRowId: source.sourceRowId })), findings: [] }, finalizedGroups: groups };
  }
  if (finalized.schemaVersion !== 1 || finalized.phase !== "FINAL" || !Array.isArray(finalized.groups) || !Array.isArray(finalized.sourceToLogical)) fail("R007 final reconciliation contract is invalid");
  const sourceIds = new Set(sourceLedger.map((source) => source.sourceRowId));
  const projectionRows = new Map(sourceRows.map((source) => [source.sourceRowId, source]));
  const logicalRows = new Map(correctionResult.logicalRows.map((row) => [row.sourceRowId, row]));
  const groups = finalized.groups.map((entry) => {
    const logical = logicalRows.get(entry.logicalProjectionRowId);
    if (!logical || !Array.isArray(entry.memberSourceRowIds) || !entry.memberSourceRowIds.length) fail("R007 logical group is missing");
    const expectedStatus = entry.status === "UNMERGED" ? "SINGLE" : entry.status;
    if (!new Set(["SINGLE", "EXACT_OVERLAP", "CONFLICT"]).has(expectedStatus)) fail("R007 group status is invalid");
    const members = entry.memberSourceRowIds;
    if (members.some((id) => !sourceIds.has(id)) || entry.representativeSourceRowId !== members[0]) fail("R007 group member or representative is invalid");
    for (const sourceRowId of members) if (!projectionRows.has(sourceRowId)) fail("R007 member evidence source is missing");
    return { groupId: entry.reconciliationGroupId, status: expectedStatus, memberSourceRowIds: [...members], representativeSourceRowId: entry.representativeSourceRowId,
      logicalRowId: entry.logicalProjectionRowId, memberEvidence: [], logical };
  });
  const actualAssigned = groups.flatMap((group) => group.memberSourceRowIds);
  if (actualAssigned.length !== sourceLedger.length || new Set(actualAssigned).size !== sourceLedger.length || actualAssigned.some((id) => !sourceIds.has(id))) fail("R007 source accounting is not one-to-one");
  const sourceToLogical = finalized.sourceToLogical.map((item) => ({ sourceRowId: item.sourceRowId, logicalRowId: item.logicalProjectionRowId }));
  if (sourceToLogical.length !== sourceLedger.length || sourceToLogical.some((item, index) => item.sourceRowId !== sourceLedger[index].sourceRowId)) fail("R007 source map does not match source order");
  for (const group of groups) for (const id of group.memberSourceRowIds) if (!sourceToLogical.some((item) => item.sourceRowId === id && item.logicalRowId === group.logicalRowId)) fail("R007 source map disagrees with group membership");
  const captureSources = new Map();
  for (const source of sourceLedger) {
    const ids = captureSources.get(source.captureId) ?? [];
    ids.push(source.sourceRowId);
    captureSources.set(source.captureId, ids);
  }
  const findings = (finalized.findings ?? []).map((finding) => {
    let ids = finding.sourceRowIds ?? finding.sourceIds ?? [];
    if (!ids.length) {
      const captureIds = finding.captureIds ?? [finding.leftCaptureId, finding.rightCaptureId].filter(Boolean);
      ids = unique(captureIds.flatMap((captureId) => captureSources.get(captureId) ?? []));
      for (const key of ["leftSourceRowId", "rightSourceRowId"]) if (nonempty(finding[key])) ids.push(finding[key]);
    }
    const detail = typeof finding.detail === "string" ? finding.detail : JSON.stringify(Object.fromEntries(Object.entries(finding).filter(([key]) => key !== "code")));
    return { code: finding.code ?? finding.kind ?? finding.type, sourceRowIds: unique(ids), detail };
  });
  if (findings.some((finding) => !nonempty(finding.code) || !Array.isArray(finding.sourceRowIds) || finding.sourceRowIds.some((id) => !sourceIds.has(id)))) fail("R007 finding cannot be represented in Evidence3");
  return { ledger: { schemaVersion: 2, policyVersion: finalized.policyVersion, captureOrder, sourceRows: sourceLedger,
    groups: groups.map(({ logical, ...group }) => group), sourceToLogical, findings }, finalizedGroups: groups };
}

function edgeWorkItems(edgeSegments) {
  if (edgeSegments === null || edgeSegments === undefined) return [];
  if (!Array.isArray(edgeSegments)) fail("edge segments must be an array");
  return edgeSegments.map((edge) => {
    if (!record(edge) || !nonempty(edge.edgeId)) fail("edge segment requires a stable edgeId");
    if (!nonempty(edge.reason) || !nonempty(edge.captureId) || !Number.isSafeInteger(edge.ordinal)) fail("edge segment evidence is incomplete");
    return { workItemId: `recapture:${edge.edgeId}`, edgeId: edge.edgeId, classification: "NEEDS_RECAPTURE", reason: edge.reason,
      sourceRefs: (edge.sourceRefs ?? []).map((ref) => ({ sourceRowId: ref.sourceRowId, captureId: ref.captureId, ordinal: ref.ordinal })) };
  });
}

export function buildClassifiedFinalProjection3({ correctionResult, rawEvidenceHash, pixelAvailability } = {}) {
  if (!record(correctionResult) || correctionResult.schemaVersion !== 1 || correctionResult.pipelineKind !== "TRADE_FINAL_CORRECTION_SHADOW"
      || correctionResult.pipelineVersion !== "trade-final-correction-v1" || correctionResult.activation !== "SHADOW_ONLY"
      || correctionResult.isFinalProjection3 !== false || correctionResult.truthGenerated !== false || correctionResult.sessionWrites !== false) fail("C1 shadow correction result is required");
  if (!/^[0-9a-f]{64}$/.test(rawEvidenceHash ?? "")) fail("rawEvidenceHash must be lowercase SHA-256");
  const masterBinding = correctionResult.masterBinding;
  if (!record(masterBinding) || masterBinding.masterSchemaVersion !== 2 || masterBinding.hashBasis !== "MASTER_CANONICAL_JSON_V2"
      || !nonempty(masterBinding.registryVersion) || !/^[0-9a-f]{64}$/.test(masterBinding.contentHash ?? "")
      || masterBinding.registryVersion !== `registry-v2:${masterBinding.contentHash}`) fail("pinned Master Bundle2 binding is invalid");
  const correctionVersion = correctionResult.correctionPolicy?.policyVersion;
  if (!nonempty(correctionVersion) || !Array.isArray(correctionResult.sourceRows) || !correctionResult.sourceRows.length || !Array.isArray(correctionResult.logicalRows)) fail("correction result is incomplete");
  const { ledger, finalizedGroups } = reconciliationLedger(correctionResult);
  const sourceById = new Map(correctionResult.sourceRows.map((source) => [source.sourceRowId, source]));
  const allCropRefs = [];
  for (const source of correctionResult.sourceRows) for (const fieldName of FIELDS) allCropRefs.push(...cropIds(source, fieldName));
  const cropOrder = unique(allCropRefs);
  const supplied = new Map();
  for (const entry of pixelAvailability ?? []) {
    if (!record(entry) || !nonempty(entry.cropRefId) || !PIXEL_STATES.has(entry.state) || supplied.has(entry.cropRefId)) fail("pixel availability entry is invalid or duplicated");
    supplied.set(entry.cropRefId, entry.state);
  }
  if ([...supplied.keys()].some((id) => !cropOrder.includes(id))) fail("pixel availability references an unknown crop");
  const pixels = cropOrder.map((cropRefId) => ({ cropRefId, state: supplied.get(cropRefId) ?? "MISSING" }));
  const rows = finalizedGroups.map((group) => {
    const memberIds = group.memberSourceRowIds;
    const memberSources = memberIds.map((id) => sourceById.get(id));
    const logical = group.logical;
    if (!logical || Object.keys(logical.fields ?? {}).length !== 6 || FIELDS.some((fieldName) => !record(logical.fields[fieldName]))) fail("logical correction row must contain six fields");
    const rowCropFields = Object.fromEntries(FIELDS.map((fieldName) => {
      const field = { ...logical.fields[fieldName], _cropRefs: unique(memberSources.flatMap((source) => cropIds(source, fieldName))) };
      const sourceFieldValues = memberSources.map((source) => source.fields[fieldName]);
      if (sourceValuesConflict(sourceFieldValues, fieldName)) {
        field.finalStatus = "CONFLICT";
        field.riskReasons = [...(field.riskReasons ?? []), { code: "RECONCILIATION_CONFLICT" }];
        field.conflictAlternatives = sourceFieldValues.map((sourceField, index) => ({ value: sourceField.finalValue ?? null, sourceRowIds: [memberIds[index]], riskReasons: ["RECONCILIATION_CONFLICT"] }));
      }
      return [fieldName, field];
    }));
    const classRow = { ...logical, fields: rowCropFields, sourceRefs: memberIds.map((id) => sourceById.get(id)?.sourceRefs?.[0] ?? { sourceRowId: id, captureId: sourceById.get(id).captureId, ordinal: sourceById.get(id).ordinal }) };
    const availabilityMap = new Map(pixels.map((entry) => [entry.cropRefId, entry.state]));
    const classified = classifyCore({ row: classRow, group, pixelAvailability: availabilityMap });
    const sourceRefs = memberIds.map((id) => ({ sourceRowId: id, captureId: sourceById.get(id).captureId, ordinal: sourceById.get(id).ordinal }));
    const fields = FIELDS.map((fieldName) => {
      const originalField = rowCropFields[fieldName];
      const corrected = { ...originalField, _cropRefs: rowCropFields[fieldName]._cropRefs };
      const primaryReason = classified.fieldFindings[fieldName][0]?.split(":").slice(1).join(":") ?? null;
      return mapProjectionField(corrected, fieldName, memberSources, memberIds, sourceById, classified.classification, primaryReason);
    });
    const reasons = [...classified.classificationReasons];
    const rowBox = logical.representativeSource?.rowBox ?? memberSources[0].rowBox ?? null;
    return { projectionRowId: logical.sourceRowId, captureId: memberSources[0].captureId, ordinal: memberSources[0].ordinal, rowBox: clone(rowBox), sourceRefs, fields,
      classification: classified.classification, classificationReasons: reasons };
  });
  const projectionRowById = new Map(rows.map((row) => [row.projectionRowId, row]));
  const evidenceGroups = new Map(ledger.groups.map((group) => [group.logicalRowId, group]));
  for (const group of finalizedGroups) {
    if (group.memberSourceRowIds.length === 1) continue;
    const logicalProjection = projectionRowById.get(group.logicalRowId);
    const evidenceGroup = evidenceGroups.get(group.logicalRowId);
    evidenceGroup.memberEvidence = group.memberSourceRowIds.map((sourceRowId) => {
      const source = sourceById.get(sourceRowId);
      return { sourceRowId, fields: FIELDS.map((fieldName) => {
        const sourceField = source.fields[fieldName];
        const cropRefs = cropIds(source, fieldName);
        const isolated = { ...sourceField, _cropRefs: cropRefs };
        const stage7Reason = logicalProjection.fields[FIELDS.indexOf(fieldName)].stageTrace.find((entry) => entry.stage === 7)?.reason ?? null;
        return mapProjectionField(isolated, fieldName, [source], [sourceRowId], sourceById, logicalProjection.classification, stage7Reason);
      }) };
    });
  }
  const edgeItems = edgeWorkItems(correctionResult.edgeSegments);
  return buildFinalProjection3({ recognitionBatchId: correctionResult.recognitionBatchId, rawEvidenceHash, masterBinding: clone(masterBinding), correctionVersion,
    reconciliation: ledger, pixelAvailability: pixels, rows, edgeWorkItems: edgeItems });
}
