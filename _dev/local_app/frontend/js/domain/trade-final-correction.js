import { getSafeUniqueItemMatch } from "./trade-import.js";
import { masterBundleContentHash, validateMasterBundleV2 } from "./trade-master-bundle.js";
import { reconcileTradeProjectionRows } from "./trade-batch-reconciliation.js";

const FIELDS = Object.freeze(["island", "fromItem", "reqAmount", "toItem", "count", "yield"]);
const NUMERIC = new Set(["reqAmount", "count", "yield"]);
const MINIMUM = Object.freeze({ reqAmount: 1, count: 0, yield: 1 });
const SAFE_AUTHORITY = new Set(["VERIFIED_CURATED", "VERIFIED_REFERENCE"]);
const BLOCKED_AUTHORITY = new Set(["DISPUTED", "DEPRECATED"]);
const UNRESOLVED = new Set(["AMBIGUOUS", "UNMATCHED", "MASTER_DISAGREEMENT"]);

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }
function clone(value, label = "value", ancestors = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new TypeError(`${label} must contain safe integers`);
    return value;
  }
  if (!value || typeof value !== "object" || ancestors.has(value)) throw new TypeError(`${label} must be acyclic JSON data`);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError(`${label} must be plain JSON data`);
  ancestors.add(value);
  const result = Array.isArray(value)
    ? value.map((entry, index) => clone(entry, `${label}[${index}]`, ancestors))
    : Object.fromEntries(Object.keys(value).map((key) => [key, clone(value[key], `${label}.${key}`, ancestors)]));
  ancestors.delete(value);
  return result;
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}
function normalizeName(value, field) {
  const steps = [];
  let normalized = value.trim();
  if (normalized !== value) steps.push({ operation: "TRIM", before: value, after: normalized });
  let tierHint = null;
  if (field !== "island") {
    const prefix = normalized.match(/^\[[^\]]*\]\s*/u);
    const stage = prefix?.[0].match(/(?:T?([1-7])\s*(?:단계|티어)?|(?:tier|stage|티어|단계)\s*T?([1-7]))/i);
    if (prefix) {
      const before = normalized;
      normalized = normalized.slice(prefix[0].length).trim();
      steps.push({ operation: "REMOVE_DISPLAY_PREFIX", before, after: normalized });
      if (stage) { tierHint = Number(stage[1] ?? stage[2]); steps.push({ operation: "TIER_HINT", tier: tierHint }); }
    }
    const decoration = normalized.match(/\s+x\s*\d+\s*$/i);
    if (decoration) {
      const before = normalized;
      normalized = normalized.slice(0, decoration.index).trim();
      steps.push({ operation: "REMOVE_DISPLAY_QUANTITY", before, after: normalized });
    }
  }
  const matchingKey = field === "island" ? normalized : normalized.replace(/\s+/gu, "");
  if (matchingKey !== normalized) steps.push({ operation: "REMOVE_WHITESPACE_FOR_MATCH", before: normalized, after: matchingKey });
  return { value: normalized, matchingKey, tierHint, appliedRules: steps };
}
function compact(value) { return String(value ?? "").replace(/\s+/gu, ""); }
function termIdentity(term) { return term.stableId ? `stable:${term.stableId}` : `legacy:${term.legacyNameKey}`; }
function sourceFieldText(field) {
  return nonempty(field.normalizedText) ? field.normalizedText : nonempty(field.rawText) ? field.rawText : null;
}
function reason(code, detail = null) { return { code, detail }; }
function sourceRisks(field) {
  const risks = [];
  if (field.status === undefined || field.status === null || field.status === "UNKNOWN") risks.push(reason("FIELD_STATUS_MISSING"));
  if (!nonempty(field.rawText) && nonempty(field.normalizedText)) risks.push(reason("RAW_TEXT_MISSING"));
  if (["FIELD_CLIPPED", "GEOMETRY_ABSTAIN", "UNREADABLE", "OCR_ERROR", "EMPTY_OCR"].includes(field.status)) risks.push(reason(field.status));
  for (const code of field.reasonCodes ?? []) {
    if (code === "ROW_BOUNDARY_CONTACT") continue;
    risks.push(["FIELD_CLIPPED", "GEOMETRY_ABSTAIN", "OCR_ERROR", "EMPTY_OCR"].includes(code)
      ? reason(code) : reason("RECOGNITION_WARNING", code));
  }
  return risks;
}

function createTerms(bundle) {
  const terms = [];
  const referenceFindings = new Map((bundle.provenance.referenceFindings ?? []).map((finding) => [finding.legacyNameKey, finding.status]));
  for (const entity of bundle.entities) {
    for (const legacy of entity.legacyNames) {
      const base = {
        stableId: entity.stableId, legacyNameKey: legacy.legacyNameKey,
        kind: entity.kind, legacyKind: legacy.legacyKind, tier: legacy.tier,
        category: entity.category, authorityStatus: legacy.authorityStatus,
        entityStatus: entity.status, canonicalName: entity.canonicalName,
        scopes: [...new Set(legacy.occurrences.map((occurrence) => occurrence.scope))].sort(),
        provenance: clone(entity.provenance),
      };
      terms.push({ ...base, value: legacy.rawName, source: "LEGACY_NAME", nameStatus: legacy.authorityStatus, legacyNameKey: legacy.legacyNameKey });
      if (entity.canonicalName) terms.push({ ...base, authorityStatus: entity.status, value: entity.canonicalName, source: "CANONICAL_NAME", nameStatus: entity.status });
      for (const name of entity.displayNames) terms.push({ ...base, authorityStatus: entity.status, value: name.text, source: "DISPLAY_NAME", nameStatus: name.status, provenance: clone(name.provenance) });
      for (const name of entity.aliases) terms.push({ ...base, authorityStatus: entity.status, value: name.text, source: "ALIAS", nameStatus: name.status, provenance: clone(name.provenance) });
    }
  }
  for (const legacy of bundle.unresolvedLegacyNames) terms.push({
    value: legacy.rawName, stableId: null, legacyNameKey: legacy.legacyNameKey,
    kind: legacy.legacyKind === "ISLAND" ? "ISLAND" : "ITEM", legacyKind: legacy.legacyKind,
    tier: legacy.tier, category: legacy.legacyKind === "SPECIAL_ITEM" ? "LEGACY_SPECIAL_ITEM" : null,
    authorityStatus: "LEGACY_UNVERIFIED", entityStatus: null, canonicalName: null,
    scopes: [...new Set(legacy.occurrences.map((occurrence) => occurrence.scope))].sort(),
    source: "LEGACY_NAME", nameStatus: "LEGACY_UNVERIFIED", provenance: null,
    unresolvedReason: legacy.reason, referenceStatus: referenceFindings.get(legacy.legacyNameKey) ?? null,
  });
  const unique = new Map();
  for (const term of terms) {
    const key = `${termIdentity(term)}\0${term.kind}\0${compact(term.value)}`;
    const prior = unique.get(key);
    if (!prior) { unique.set(key, { ...term, scopes: [...term.scopes] }); continue; }
    prior.scopes = [...new Set([...prior.scopes, ...term.scopes])].sort();
    if (prior.source !== term.source) prior.source = "CURATED_NAME_SET";
    if (term.nameStatus === "DISPUTED") prior.nameStatus = "DISPUTED";
  }
  return [...unique.values()];
}

function publicCandidate(term, observedText, normalization, matchKind) {
  return {
    value: term.value,
    observedText,
    stableId: term.stableId,
    legacyNameKey: term.legacyNameKey,
    kind: term.legacyKind === "SPECIAL_ITEM" ? "SPECIAL_ITEM" : term.kind,
    legacyKind: term.legacyKind,
    tier: term.tier,
    category: term.category,
    authorityStatus: term.authorityStatus,
    entityStatus: term.entityStatus,
    canonicalName: term.canonicalName,
    nameSource: term.source,
    nameStatus: term.nameStatus,
    provenance: clone(term.provenance),
    referenceStatus: term.referenceStatus ?? null,
    sourceScopes: [...term.scopes],
    matchKind,
    normalizationRules: clone(normalization.appliedRules),
  };
}

function textField(fieldName, field, terms, context, scopeFilter = null, termFilter = null) {
  const rawText = sourceFieldText(field);
  const raw = {
    text: field.rawText ?? null,
    normalizedText: field.normalizedText ?? null,
    numericCandidate: field.rawNumericCandidate ?? null,
    status: field.status ?? null,
    reasonCodes: clone(field.reasonCodes ?? []),
    sourceRefs: clone(context.sourceRefs),
    cropRefs: clone(context.cropRefs),
    geometry: clone(context.geometry),
    otherEvidence: Object.fromEntries(Object.entries(field).filter(([key]) => !["rawText", "normalizedText", "rawNumericCandidate", "value", "status", "reasonCodes"].includes(key)).map(([key, value]) => [key, clone(value)])),
  };
  const trace = [{ stage: 0, name: "RAW_OBSERVATION", ruleVersion: "raw-draft-adapter-v1", reason: null }];
  const risks = [];
  const reasons = [];
  const text = rawText;
  if (!text) {
    risks.push(reason("RAW_TEXT_MISSING"));
    return { field: fieldName, raw, normalized: { value: null, matchingKey: null, policyVersion: "r003-name-normalization-v1", appliedRules: [] }, masterMatches: [], correctionCandidates: [], selectedCandidate: null, correctionReasons: [], riskReasons: risks, finalValue: null, finalStatus: "UNMATCHED", stageTrace: [...trace, { stage: 1, name: "NORMALIZATION", ruleVersion: "r003-name-normalization-v1", reason: "RAW_TEXT_MISSING" }, { stage: 2, name: "MASTER_EXACT_MATCH", ruleVersion: "bundle2-exact-v1", reason: "NO_TEXT" }, { stage: 3, name: "MASTER_BOUNDED_CORRECTION", ruleVersion: "V1_UNIQUE_BOUNDED_0.75", reason: "NO_TEXT" }, { stage: 4, name: "DOMAIN_CORRECTION", ruleVersion: "r003-domain-v1", reason: "NO_TEXT" }], deferred: { stage7: "DEFERRED_TO_C3", stage8: "DEFERRED_TO_C3" } };
  }
  const normalized = normalizeName(text, fieldName);
  trace.push({ stage: 1, name: "NORMALIZATION", ruleVersion: "r003-name-normalization-v1", reason: null });
  const expectedKind = fieldName === "island" ? "ISLAND" : "ITEM";
  let pool = terms.filter((term) => term.kind === expectedKind
    && (scopeFilter === null || term.scopes.some((scope) => scopeFilter.includes(scope)))
    && (termFilter === null || termFilter(term)));
  if (normalized.tierHint !== null) pool = pool.filter((term) => term.tier === normalized.tierHint);
  const exact = pool.filter((term) => (fieldName === "island" ? term.value.trim() : compact(term.value)) === normalized.matchingKey);
  trace.push({ stage: 2, name: "MASTER_EXACT_MATCH", ruleVersion: "bundle2-exact-v1", reason: exact.length ? null : "NO_EXACT_NAME" });
  const safeExact = exact.filter((term) => !BLOCKED_AUTHORITY.has(term.authorityStatus) && !BLOCKED_AUTHORITY.has(term.nameStatus));
  let matches = safeExact;
  let matchKind = "EXACT";
  let bounded = [];
  if (!exact.length) {
    const verified = pool.filter((term) => SAFE_AUTHORITY.has(term.authorityStatus)
      && SAFE_AUTHORITY.has(term.nameStatus) && !BLOCKED_AUTHORITY.has(term.entityStatus));
    const result = getSafeUniqueItemMatch(fieldName === "island" ? normalized.value : normalized.matchingKey, verified.map((term) => term.value));
    if (result.status === "corrected") {
      matches = verified.filter((term) => term.value === result.value);
      matchKind = "BOUNDED_UNIQUE_MATCH";
    } else if (result.status === "ambiguous") {
      const names = new Set(result.candidates);
      bounded = verified.filter((term) => names.has(term.value));
      matchKind = "AMBIGUOUS";
    }
  }
  const distinct = new Map();
  for (const term of matches) distinct.set(termIdentity(term), term);
  matches = [...distinct.values()];
  const blockedOnly = exact.length > 0 && safeExact.length === 0;
  const blockedIdentities = new Set(exact.map(termIdentity));
  const ambiguous = matches.length > 1 || matchKind === "AMBIGUOUS" || (exact.length > 0 && safeExact.length > 0 && safeExact.length !== exact.length)
    || (blockedOnly && blockedIdentities.size > 1);
  const allMatchTerms = exact.length ? exact : (bounded.length ? bounded : matches);
  const candidates = allMatchTerms.map((term) => publicCandidate(term, text, normalized, exact.length ? "EXACT" : matchKind));
  trace.push({ stage: 3, name: "MASTER_BOUNDED_CORRECTION", ruleVersion: "V1_UNIQUE_BOUNDED_0.75", reason: exact.length ? "EXACT_MATCH_PRECEDENCE" : (matches.length ? null : matchKind === "AMBIGUOUS" ? "AMBIGUOUS" : "NO_QUALIFIED_MATCH") });
  let selectedCandidate = null;
  let finalStatus = "UNMATCHED";
  if (blockedOnly && !ambiguous) {
    finalStatus = exact.some((term) => term.authorityStatus === "DISPUTED" || term.nameStatus === "DISPUTED") ? "MASTER_DISAGREEMENT" : "MASTER_DEPRECATED";
    risks.push(reason(finalStatus === "MASTER_DISAGREEMENT" ? "MASTER_DISPUTED" : "MASTER_DEPRECATED"));
  } else if (ambiguous) {
    finalStatus = "AMBIGUOUS";
    risks.push(reason(exact.length ? "MASTER_NAME_COLLISION_OR_BLOCKED" : "AMBIGUOUS_MATCH"));
  } else if (matches.length === 1) {
    const term = matches[0];
    selectedCandidate = publicCandidate(term, text, normalized, matchKind);
    finalStatus = term.authorityStatus === "DISPUTED" || term.nameStatus === "DISPUTED" ? "MASTER_DISAGREEMENT" : "MATCHED";
    reasons.push(reason(matchKind === "BOUNDED_UNIQUE_MATCH" ? "BOUNDED_UNIQUE_MATCH" : "EXACT_MATCH"));
    if (term.authorityStatus === "LEGACY_UNVERIFIED") risks.push(reason("MASTER_UNRESOLVED"));
    if (term.referenceStatus === "SOURCE_CONFLICT") risks.push(reason("SOURCE_CONFLICT"));
    if (matchKind === "BOUNDED_UNIQUE_MATCH") risks.push(reason("BOUNDED_UNIQUE_MATCH", { similarityPolicy: "V1_UNIQUE_BOUNDED_0.75" }));
    if (term.authorityStatus === "DISPUTED" || term.nameStatus === "DISPUTED") risks.push(reason("MASTER_DISPUTED"));
  } else {
    risks.push(reason("IDENTITY_UNRESOLVED"));
    risks.push(reason("NO_MATCH"));
  }
  risks.push(...sourceRisks(field));
  trace.push({ stage: 4, name: "DOMAIN_CORRECTION", ruleVersion: "r003-domain-v1", reason: context.domainReason ?? null });
  return {
    field: fieldName, raw,
    normalized: { value: normalized.value, matchingKey: normalized.matchingKey, tierHint: normalized.tierHint, policyVersion: "r003-name-normalization-v1", appliedRules: normalized.appliedRules },
    masterMatches: candidates,
    correctionCandidates: candidates.filter((candidate) => SAFE_AUTHORITY.has(candidate.authorityStatus) && candidate.matchKind !== "EXACT"),
    selectedCandidate,
    correctionReasons: reasons,
    riskReasons: risks,
    finalValue: selectedCandidate?.value ?? normalized.value,
    finalStatus,
    stageTrace: trace,
    deferred: { stage7: "DEFERRED_TO_C3", stage8: "DEFERRED_TO_C3" },
  };
}

const PREFIXES = {
  reqAmount: new Set(["", "수:", "수량:", "필요:", "필요수량:", "필요수량", "필요", "요구", "요구수량:"]),
  count: new Set(["", "횟수:", "남은횟수:", "남은교환횟수:", "수:"]),
  yield: new Set(["", "수율:", "획득:"]),
};
const SUFFIXES = {
  reqAmount: new Set(["", "개", "개씩", "회", "회분"]),
  count: new Set(["", "회", "번", "회남음", "번남음"]),
  yield: new Set(["", "개", "개씩", "개당", "회"]),
};
function numericField(fieldName, field, context) {
  const rawText = sourceFieldText(field);
  const compactText = rawText === null ? "" : rawText.replace(/\s+/gu, "");
  const groups = [...compactText.matchAll(/[0-9]+(?:,[0-9]{3})*/gu)];
  let parsed = null;
  let parseStatus = "NUMERIC_MISSING";
  if (groups.length > 1) parseStatus = "MULTIPLE_NUMERIC_GROUPS";
  else if (groups.length === 1) {
    const match = groups[0];
    const before = compactText.slice(0, match.index);
    const after = compactText.slice(match.index + match[0].length);
    const value = Number(match[0].replaceAll(",", ""));
    if (!PREFIXES[fieldName].has(before) || !SUFFIXES[fieldName].has(after)
        || !Number.isSafeInteger(value) || value < MINIMUM[fieldName]) parseStatus = "NUMERIC_FORMAT_UNSUPPORTED";
    else { parsed = value; parseStatus = "PARSED"; }
  }
  const hasReader = field.rawNumericCandidate !== null && field.rawNumericCandidate !== undefined;
  const readerValid = hasReader && Number.isSafeInteger(field.rawNumericCandidate) && field.rawNumericCandidate >= MINIMUM[fieldName];
  const value = hasReader ? (readerValid ? field.rawNumericCandidate : null) : parsed;
  const disagreement = readerValid && parsed !== null && parsed !== field.rawNumericCandidate;
  const risks = [];
  if (value === null) risks.push(reason(parseStatus === "MULTIPLE_NUMERIC_GROUPS" ? "AMBIGUOUS_NUMERIC_GROUPS" : "NUMERIC_MISSING_OR_INVALID", { parseStatus }));
  if (rawText === null) risks.push(reason("RAW_TEXT_MISSING"));
  if (disagreement) risks.push(reason("NUMERIC_READER_TEXT_DISAGREEMENT", { reader: field.rawNumericCandidate, parsed }));
  if (fieldName !== "count" && value !== null) risks.push(reason("NUMERIC_COMPLETENESS_UNVERIFIED"));
  risks.push(...sourceRisks(field));
  return {
    field: fieldName,
    raw: { text: field.rawText ?? null, normalizedText: field.normalizedText ?? null, numericCandidate: field.rawNumericCandidate ?? null, status: field.status ?? null, reasonCodes: clone(field.reasonCodes ?? []), sourceRefs: clone(context.sourceRefs), cropRefs: clone(context.cropRefs), geometry: clone(context.geometry), otherEvidence: Object.fromEntries(Object.entries(field).filter(([key]) => !["rawText", "normalizedText", "rawNumericCandidate", "value", "status", "reasonCodes"].includes(key)).map(([key, entry]) => [key, clone(entry)])) },
    normalized: { value: rawText === null ? null : compactText, matchingKey: null, policyVersion: "r003-numeric-token-v1", appliedRules: rawText === null ? [] : [{ operation: "REMOVE_WHITESPACE_FOR_NUMERIC_PARSE", before: rawText, after: compactText }] },
    masterMatches: [], correctionCandidates: [], selectedCandidate: value === null ? null : { value, source: hasReader ? "RAW_NUMERIC_CANDIDATE" : "BOUNDED_NUMERIC_PARSE", rawText, rawNumericCandidate: hasReader ? field.rawNumericCandidate : null },
    correctionReasons: value === null ? [] : [reason(hasReader ? "RAW_NUMERIC_CANDIDATE" : "BOUNDED_NUMERIC_PARSE")],
    riskReasons: risks,
    finalValue: value,
    finalStatus: value === null ? (parseStatus === "MULTIPLE_NUMERIC_GROUPS" ? "AMBIGUOUS" : "UNMATCHED") : (disagreement ? "CONFLICT" : "MATCHED"),
    parse: { status: parseStatus, candidate: parsed, readerCandidateValid: Boolean(readerValid), disagreement },
    stageTrace: [
      { stage: 0, name: "RAW_OBSERVATION", ruleVersion: "raw-draft-adapter-v1", reason: null },
      { stage: 5, name: "NUMERIC_RESOLUTION", ruleVersion: "r003-bounded-numeric-v1", reason: parseStatus === "PARSED" ? null : parseStatus },
    ],
    deferred: { stage7: "DEFERRED_TO_C3", stage8: "DEFERRED_TO_C3" },
  };
}

function validateRows(draftRows) {
  if (!Array.isArray(draftRows)) throw new TypeError("rawObservation.draftRows must be an array");
  const ids = new Set();
  return draftRows.map((row, index) => {
    if (!isRecord(row) || row.status !== "DRAFT_UNVERIFIED" || row.automationDecision !== "REVIEW"
        || !nonempty(row.captureId) || !Number.isSafeInteger(row.ordinal) || row.ordinal < 1) throw new TypeError(`draftRows[${index}] is not a valid R003 recognition draft`);
    const rowId = nonempty(row.rowId) ? row.rowId : `draft:${row.captureId}:${row.ordinal}`;
    if (ids.has(rowId)) throw new TypeError(`duplicate draft row identity: ${rowId}`);
    ids.add(rowId);
    if (!isRecord(row.fields) || Object.keys(row.fields).length !== 6 || FIELDS.some((field) => !Object.hasOwn(row.fields, field))) throw new TypeError(`draftRows[${index}] must contain exactly six fields`);
    if (row.sourceRefs !== undefined && !Array.isArray(row.sourceRefs)) throw new TypeError(`draftRows[${index}].sourceRefs must be an array`);
    for (const field of FIELDS) {
      const value = row.fields[field];
      const invalid = !isRecord(value) || value.value !== null
        || (value.rawText !== undefined && value.rawText !== null && typeof value.rawText !== "string")
        || (value.normalizedText !== undefined && value.normalizedText !== null && typeof value.normalizedText !== "string")
        || (value.rawNumericCandidate !== undefined && value.rawNumericCandidate !== null && !Number.isSafeInteger(value.rawNumericCandidate))
        || (value.status !== undefined && value.status !== null && !nonempty(value.status))
        || (value.reasonCodes !== undefined && (!Array.isArray(value.reasonCodes) || !value.reasonCodes.every(nonempty)));
      if (invalid) throw new TypeError(`draftRows[${index}].fields.${field} violates the R003 source contract`);
    }
    return { row: clone(row), rowId, index, sourceRefs: clone(row.sourceRefs ?? [{ captureId: row.captureId, ordinal: row.ordinal, draftRowId: rowId }]) };
  });
}

function toReconciliationRow(row, index) {
  const fields = {};
  for (const fieldName of FIELDS) {
    const trace = row.fields[fieldName];
    const candidate = trace.selectedCandidate;
    fields[fieldName] = {
      field: fieldName,
      candidate: candidate && typeof candidate.value === "string" ? { stableId: candidate.stableId ?? null, legacyNameKey: candidate.legacyNameKey ?? null, kind: candidate.kind, authorityStatus: candidate.authorityStatus } : candidate,
      shownValue: trace.finalValue,
      status: trace.finalStatus,
      riskReasons: trace.riskReasons,
      correctionReason: trace.correctionReasons,
      alternatives: trace.masterMatches,
    };
  }
  return {
    projectionRowId: row.sourceRowId, captureId: row.captureId, ordinal: row.ordinal, sourceIndex: index,
    sourceRefs: row.sourceRefs, originalRowEvidence: { sourceRefs: row.sourceRefs }, fields,
  };
}
function toShadowLogicalRows(finalized, sourceRows) {
  const bySource = new Map(sourceRows.map((row) => [row.sourceRowId, row]));
  return finalized.rows.map((logical) => {
    const members = logical.reconciliationMembers.map((member) => bySource.get(member.projectionRowId));
    const representative = members[0];
    const fields = {};
    for (const fieldName of FIELDS) {
      const source = representative.fields[fieldName];
      const combined = logical.fields[fieldName];
      const field = clone(source);
      field.raw.sourceRefs = clone(logical.sourceRefs);
      field.riskReasons = clone(combined.riskReasons ?? source.riskReasons);
      field.correctionReasons = clone(combined.correctionReason ?? source.correctionReasons);
      if (combined.status === "AMBIGUOUS" && Array.isArray(combined.alternatives) && combined.alternatives.length) {
        field.selectedCandidate = null;
        field.finalValue = null;
        field.finalStatus = "CONFLICT";
        field.conflictAlternatives = clone(combined.alternatives);
      }
      field.stageTrace = [...field.stageTrace, { stage: 6, name: "MULTI_CAPTURE_RECONCILIATION", ruleVersion: "trade-batch-reconciliation-v1", reason: logical.reconciliationStatus }];
      fields[fieldName] = field;
    }
    return {
      sourceRowId: logical.projectionRowId,
      sourceRowIds: logical.reconciliationMembers.map((member) => member.projectionRowId),
      captureId: logical.captureId,
      ordinal: logical.ordinal,
      sourceRefs: clone(logical.sourceRefs),
      reconciliationGroupId: logical.reconciliationGroupId,
      reconciliationStatus: logical.reconciliationStatus,
      representativeSource: { captureId: logical.captureId, ordinal: logical.ordinal, rowBox: clone(logical.rowBox ?? null), rowCropHash: clone(logical.rowCropHash ?? null) },
      fields,
    };
  });
}

/** Pure, synchronous shadow correction. It never creates human truth or an E1 Projection3. */
export function buildFinalTradeProjection({ rawObservation, masterBundle, correctionPolicy, reconciliationPolicyVersion, pixelAvailability } = {}) {
  if (!isRecord(rawObservation) || !nonempty(rawObservation.recognitionBatchId)) throw new TypeError("rawObservation requires recognitionBatchId");
  if (!isRecord(correctionPolicy) || !nonempty(correctionPolicy.policyVersion)) throw new TypeError("correctionPolicy.policyVersion must be a nonempty caller-supplied string");
  const validation = validateMasterBundleV2(masterBundle);
  if (!validation.ok) throw new TypeError(`masterBundle is invalid: ${validation.errors.join("; ")}`);
  const bundleHash = masterBundleContentHash(masterBundle);
  if (bundleHash !== masterBundle.contentHash) throw new TypeError("masterBundle contentHash does not match its canonical content");
  const inputs = validateRows(rawObservation.draftRows);
  const terms = createTerms(masterBundle);
  const rows = inputs.map(({ row, rowId, index, sourceRefs }) => {
    const context = { sourceRefs, cropRefs: row.cropRefs ?? null, geometry: row.rowBox ?? null };
    const fields = {};
    fields.toItem = textField("toItem", row.fields.toItem, terms, context, null);
    const to = fields.toItem.selectedCandidate;
    const outputTier = fields.toItem.finalStatus === "MATCHED" ? to?.tier : null;
    const scopes = outputTier === null ? ["GENERAL_ISLANDS", "T6_ISLANDS", "T7_ISLANDS"]
      : [outputTier === 6 ? "T6_ISLANDS" : outputTier === 7 ? "T7_ISLANDS" : "GENERAL_ISLANDS"];
    fields.island = textField("island", row.fields.island, terms, { ...context, domainReason: outputTier === null ? "TO_ITEM_TIER_UNRESOLVED" : null }, scopes);
    if (outputTier === null) fields.island.riskReasons.push(reason("TO_ITEM_TIER_UNRESOLVED", { toItemStatus: fields.toItem.finalStatus }));
    if (to?.legacyKind === "SPECIAL_ITEM" && fields.toItem.finalStatus === "MATCHED") {
      fields.fromItem = textField("fromItem", row.fields.fromItem, terms, context, null);
    } else if (fields.toItem.finalStatus === "MATCHED" && outputTier === 1) {
      const observed = sourceFieldText(row.fields.fromItem);
      const value = observed === null ? null : observed.trim();
      fields.fromItem = {
        field: "fromItem",
        raw: { text: row.fields.fromItem.rawText ?? null, normalizedText: row.fields.fromItem.normalizedText ?? null, numericCandidate: null, status: row.fields.fromItem.status ?? null, reasonCodes: clone(row.fields.fromItem.reasonCodes ?? []), sourceRefs: clone(sourceRefs), cropRefs: clone(row.cropRefs ?? null), geometry: clone(row.rowBox ?? null), otherEvidence: {} },
        normalized: { value, matchingKey: value, policyVersion: "r003-name-normalization-v1", appliedRules: [] },
        masterMatches: [], correctionCandidates: [],
        selectedCandidate: value === null ? null : { value, stableId: null, legacyNameKey: null, kind: "ITEM", authorityStatus: "OPEN_WORLD", nameSource: "RAW_OPEN_WORLD", matchKind: "OPEN_WORLD" },
        correctionReasons: value === null ? [] : [reason("OPEN_WORLD_PRESERVED")], riskReasons: [reason(value === null ? "RAW_TEXT_MISSING" : "OPEN_WORLD_FROM_ITEM")],
        finalValue: value, finalStatus: value === null ? "UNMATCHED" : "OPEN_WORLD",
        stageTrace: [{ stage: 0, name: "RAW_OBSERVATION", ruleVersion: "raw-draft-adapter-v1", reason: null }, { stage: 4, name: "DOMAIN_CORRECTION", ruleVersion: "r003-domain-v1", reason: "TIER_ONE_OPEN_WORLD" }],
        deferred: { stage7: "DEFERRED_TO_C3", stage8: "DEFERRED_TO_C3" },
      };
    } else if (fields.toItem.finalStatus !== "MATCHED" || !Number.isSafeInteger(outputTier)) {
      fields.fromItem = textField("fromItem", row.fields.fromItem, terms, { ...context, domainReason: "TO_ITEM_DEPENDENCY_UNRESOLVED" }, []);
      fields.fromItem.masterMatches = [];
      fields.fromItem.correctionCandidates = [];
      fields.fromItem.selectedCandidate = null;
      fields.fromItem.finalValue = fields.fromItem.normalized.value;
      fields.fromItem.finalStatus = "UNMATCHED";
      fields.fromItem.riskReasons.push(reason("TO_ITEM_DEPENDENCY_UNRESOLVED"));
    } else {
      const allowedTier = outputTier - 1;
      fields.fromItem = textField("fromItem", row.fields.fromItem, terms, context, null,
        (term) => term.legacyKind === "MASTER_ITEM" && term.tier === allowedTier);
    }
    fields.reqAmount = numericField("reqAmount", row.fields.reqAmount, context);
    fields.count = numericField("count", row.fields.count, context);
    fields.yield = numericField("yield", row.fields.yield, context);
    return {
      sourceRowId: rowId, sourceIndex: index, captureId: row.captureId, ordinal: row.ordinal,
      ...(Object.hasOwn(row, "draftId") ? { draftId: clone(row.draftId) } : {}),
      ...(Object.hasOwn(row, "rowBox") ? { rowBox: clone(row.rowBox) } : {}),
      ...(Object.hasOwn(row, "rowCropHash") ? { rowCropHash: clone(row.rowCropHash) } : {}),
      sourceRefs, originalRawRow: clone(row), fields,
    };
  });
  let reconciliation = null;
  let logicalRows = rows;
  if (rawObservation.reconciliation !== undefined && rawObservation.reconciliation !== null) {
    if (!nonempty(reconciliationPolicyVersion)) throw new TypeError("reconciliationPolicyVersion is required with preliminary reconciliation");
    if (rawObservation.reconciliation.policyVersion !== reconciliationPolicyVersion) throw new TypeError("reconciliationPolicyVersion does not match preliminary topology");
    const finalized = reconcileTradeProjectionRows({ projectionRows: rows.map(toReconciliationRow), reconciliation: rawObservation.reconciliation });
    reconciliation = { preliminary: clone(rawObservation.reconciliation), finalized: clone(finalized) };
    logicalRows = toShadowLogicalRows(finalized, rows);
  }
  const findings = [];
  for (const row of rows) for (const field of Object.values(row.fields)) for (const risk of field.riskReasons) {
    if (["IDENTITY_UNRESOLVED", "MASTER_DISPUTED", "MASTER_DEPRECATED", "AMBIGUOUS_MATCH", "AMBIGUOUS_NUMERIC_GROUPS", "NUMERIC_MISSING_OR_INVALID", "NUMERIC_READER_TEXT_DISAGREEMENT", "FIELD_CLIPPED", "GEOMETRY_ABSTAIN", "OPEN_WORLD_FROM_ITEM"].includes(risk.code)) findings.push({ sourceRowId: row.sourceRowId, field: field.field, code: risk.code });
  }
  return freeze({
    schemaVersion: 1,
    pipelineKind: "TRADE_FINAL_CORRECTION_SHADOW",
    pipelineVersion: "trade-final-correction-v1",
    activation: "SHADOW_ONLY",
    isFinalProjection3: false,
    sessionCompatible: false,
    recognitionBatchId: rawObservation.recognitionBatchId,
    correctionPolicy: { policyVersion: correctionPolicy.policyVersion, definition: clone(Object.fromEntries(Object.entries(correctionPolicy).filter(([key]) => key !== "policyVersion"))) },
    masterBinding: { masterSchemaVersion: 2, registryVersion: masterBundle.registryVersion, contentHash: bundleHash, hashBasis: masterBundle.hashBasis },
    pixelAvailability: pixelAvailability === undefined ? null : clone(pixelAvailability),
    sourceRows: rows,
    logicalRows,
    captures: rawObservation.captures === undefined ? null : clone(rawObservation.captures),
    edgeSegments: rawObservation.edgeSegments === undefined ? null : clone(rawObservation.edgeSegments),
    reconciliation,
    provisionalFindings: findings,
    stageBoundaries: { stage7: "DEFERRED_TO_C3", stage8: "DEFERRED_TO_C3" },
    truthGenerated: false,
    sessionWrites: false,
  });
}
