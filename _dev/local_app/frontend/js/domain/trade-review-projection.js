import { getSafeUniqueItemMatch } from "./trade-import.js";
import { registrySnapshotSha256, validateRegistrySnapshot } from "./trade-master-registry.js";
import { reconcileTradeProjectionRows } from "./trade-batch-reconciliation.js";

const FIELD_KEYS = Object.freeze(["island", "fromItem", "reqAmount", "toItem", "count", "yield"]);
const FIELD_LABELS = Object.freeze({
  island: "섬", fromItem: "소모품", reqAmount: "필요 수량", toItem: "획득품", count: "남은 교환 횟수", yield: "수율",
});
const CLIPPED_STATUSES = new Set(["FIELD_CLIPPED", "GEOMETRY_ABSTAIN", "UNREADABLE", "OCR_ERROR", "EMPTY_OCR"]);
const RAW_EVIDENCE = Symbol("rawEvidence");
const REASON_MESSAGES = Object.freeze({
  EXACT_MATCH: "원문과 같은 이름 후보를 찾았습니다. 검수가 필요합니다.",
  BOUNDED_UNIQUE_MATCH: "기존 0.75 유일 후보 규칙으로 이름을 보정했습니다. 원문과 비교해 주세요.",
  VERIFIED_ALIAS_MATCH: "검증된 별칭 후보입니다. 원문과 비교해 주세요.",
  VERIFIED_DISPLAY_NAME_MATCH: "검증된 표시명 후보입니다. 원문과 비교해 주세요.",
  OPEN_WORLD_PRESERVED: "목록 밖 이름일 수 있어 원문을 그대로 후보로 남겼습니다.",
  UNMATCHED_SOURCE_PRESERVED: "일치 후보가 없어 정리한 원문을 그대로 남겼습니다.",
  NORMALIZED_NAME_COLLISION: "정규화한 이름이 여러 기준 항목과 겹칩니다. 하나를 자동 선택하지 않았습니다.",
  AMBIGUOUS_MATCH: "여러 이름 후보가 있어 하나를 자동 선택하지 않았습니다.",
  NUMERIC_COMPLETENESS_UNVERIFIED: "숫자 후보는 있지만 원래 숫자 전체가 잘리지 않았는지는 확인되지 않았습니다.",
  NUMERIC_MISSING_OR_INVALID: "숫자 후보가 없거나 허용 범위·표기 조건을 만족하지 않습니다.",
  OUTPUT_TIER_HINT_UNAVAILABLE: "화면 단계 표기에 해당하는 기준 항목이 없어 후보를 확정하지 않았습니다.",
  NO_MATCH: "일치하는 기준 이름을 찾지 못했습니다. 원문을 확인해 주세요.",
  AMBIGUOUS_MATCH: "여러 이름 후보가 있어 하나를 자동 선택하지 않았습니다.",
  MASTER_DISAGREEMENT: "화면 이름과 기준 자료의 대표 이름이 다릅니다. OCR 오류로 단정하지 말고 확인해 주세요.",
  MULTIPLE_NUMERIC_GROUPS: "원문에 숫자 묶음이 여러 개 있어 수량을 선택하지 않았습니다.",
  NUMERIC_MISSING: "숫자를 확인하지 못했습니다. 기본값을 넣지 않았습니다.",
  NUMERIC_FORMAT_UNSUPPORTED: "숫자 주변 표기가 정해진 형식과 달라 후보를 만들지 않았습니다.",
  TO_ITEM_DEPENDENCY_UNRESOLVED: "획득품 단계가 정해지지 않아 소모품 기준 후보를 확정하지 않았습니다.",
  TO_ITEM_TIER_UNRESOLVED: "획득품 단계를 확인할 수 없어 모든 섬 범위에서 후보를 찾았습니다.",
  MASTER_IDENTITY_UNVERIFIED: "연결된 Master identity가 아직 검증되지 않았습니다.",
  MASTER_NAME_DISPUTED: "이 Master 이름은 분쟁 상태로 기록되어 있습니다.",
  RAW_TEXT_MISSING: "인식 원문이 없어 원본 evidence에서 확인해 주세요.",
  FIELD_STATUS_MISSING: "인식 상태가 제공되지 않았습니다. 원본을 확인해 주세요.",
  RECOGNITION_WARNING: "인식 단계에서 추가 확인 사유가 기록되어 있습니다.",
  FIELD_CLIPPED: "인식 영역이 잘렸을 수 있습니다. 후보를 원본과 대조해 주세요.",
  GEOMETRY_ABSTAIN: "인식 영역의 기하 정보가 불확실합니다. 후보를 원본과 대조해 주세요.",
  OCR_ERROR: "인식 오류가 보고되었습니다. 후보를 원본과 대조해 주세요.",
  EMPTY_OCR: "원문이 비어 있습니다. 원본에서 확인해 주세요.",
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function cloneJson(value, path = "value", ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite JSON numbers`);
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`${path} must contain JSON-compatible data`);
  if (ancestors.has(value)) throw new TypeError(`${path} must not contain cycles`);
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item, index) => cloneJson(item, `${path}[${index}]`, ancestors));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must contain plain objects`);
    result = {};
    for (const [key, item] of Object.entries(value)) result[key] = cloneJson(item, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function normalizeName(value, fieldKey) {
  const steps = [];
  const original = value;
  let normalized = value.trim();
  if (normalized !== original) steps.push({ operation: "TRIM", before: original, after: normalized });
  if (fieldKey !== "island") {
    const displayPrefix = normalized.match(/^\[[^\]]*\]\s*/u);
    const stage = displayPrefix?.[0].match(/(?:T?([1-7])\s*(?:단계|티어)?|(?:tier|stage|티어|단계)\s*T?([1-7]))/i);
    if (displayPrefix) {
      const before = normalized;
      normalized = normalized.slice(displayPrefix[0].length).trim();
      steps.push({ operation: "REMOVE_DISPLAY_PREFIX", before, after: normalized });
      if (stage) steps.push({ operation: "TIER_HINT", tier: Number(stage[1] ?? stage[2]) });
    }
    const decorated = normalized.match(/\s+x\s*\d+\s*$/i);
    if (decorated) {
      const before = normalized;
      normalized = normalized.slice(0, decorated.index).trim();
      steps.push({ operation: "REMOVE_DISPLAY_QUANTITY", before, after: normalized });
    }
  }
  const compact = fieldKey === "island" ? normalized : normalized.replace(/\s+/gu, "");
  if (compact !== normalized) steps.push({ operation: "REMOVE_WHITESPACE_FOR_MATCH", before: normalized, after: compact });
  return { original, normalized, compact, steps };
}

function makeRisk(code, detail = null) {
  return { code, messageKo: REASON_MESSAGES[code] ?? "후보에 추가 확인이 필요합니다.", detail };
}

function makeReason(code, detail = null) {
  return { code, messageKo: REASON_MESSAGES[code] ?? "후보를 확인해 주세요.", detail };
}

function validateDraftRows(draftRows) {
  if (!Array.isArray(draftRows)) throw new TypeError("draftRows must be an array");
  const rowIds = new Set();
  return draftRows.map((row, index) => {
    if (!isRecord(row) || row.status !== "DRAFT_UNVERIFIED" || row.automationDecision !== "REVIEW") {
      throw new TypeError(`draftRows[${index}] is not a reviewable recognition draft`);
    }
    if (!nonempty(row.captureId) || !Number.isInteger(row.ordinal) || row.ordinal < 1) {
      throw new TypeError(`draftRows[${index}] is missing captureId or positive ordinal`);
    }
    const rowId = nonempty(row.rowId) ? row.rowId : `draft:${row.captureId}:${row.ordinal}`;
    if (rowIds.has(rowId)) throw new TypeError(`duplicate draft row identity: ${rowId}`);
    rowIds.add(rowId);
    if (!isRecord(row.fields) || Object.keys(row.fields).length !== FIELD_KEYS.length
        || FIELD_KEYS.some((key) => !Object.hasOwn(row.fields, key))) {
      throw new TypeError(`draftRows[${index}] must contain exactly six field slots`);
    }
    const fields = {};
    for (const key of FIELD_KEYS) {
      const field = row.fields[key];
      if (!isRecord(field) || !Object.hasOwn(field, "value") || field.value !== null
          || (Object.hasOwn(field, "rawText") && !(field.rawText === null || typeof field.rawText === "string"))
          || (Object.hasOwn(field, "normalizedText") && !(field.normalizedText === null || typeof field.normalizedText === "string"))
          || (Object.hasOwn(field, "rawNumericCandidate") && !(field.rawNumericCandidate === null || Number.isSafeInteger(field.rawNumericCandidate)))
          || (Object.hasOwn(field, "status") && field.status !== null && !nonempty(field.status))
          || (Object.hasOwn(field, "reasonCodes") && (!Array.isArray(field.reasonCodes) || !field.reasonCodes.every(nonempty)))) {
        throw new TypeError(`draftRows[${index}].fields.${key} violates the raw recognition draft contract`);
      }
      const evidence = cloneJson(field, `draftRows[${index}].fields.${key}`);
      const normalizedField = {
        ...evidence,
        rawText: evidence.rawText ?? null,
        normalizedText: evidence.normalizedText ?? null,
        rawNumericCandidate: evidence.rawNumericCandidate ?? null,
        status: nonempty(evidence.status) ? evidence.status : "UNKNOWN",
        reasonCodes: evidence.reasonCodes ?? [],
      };
      Object.defineProperty(normalizedField, RAW_EVIDENCE, { value: evidence });
      fields[key] = normalizedField;
    }
    const sourceRefs = Array.isArray(row.sourceRefs)
      ? cloneJson(row.sourceRefs, `draftRows[${index}].sourceRefs`)
      : [{ captureId: row.captureId, ordinal: row.ordinal, draftRowId: rowId }];
    if (row.sourceRefs !== undefined && !Array.isArray(row.sourceRefs)) throw new TypeError(`draftRows[${index}].sourceRefs must be an array`);
    const original = cloneJson(row, `draftRows[${index}]`);
    return { row, rowId, index, fields, sourceRefs, original };
  });
}

function entityForName(name, entitiesById) {
  return name.stableId === null ? null : entitiesById.get(name.stableId) ?? null;
}

function createIdentityTerms(registrySnapshot) {
  const entitiesById = new Map(registrySnapshot.entities.map((entity) => [entity.stableId, entity]));
  const terms = [];
  const add = (base, text, source, nameStatus = null) => {
    if (!nonempty(text)) return;
    terms.push({ ...base, text, source, nameStatus });
  };
  for (const name of registrySnapshot.legacyNames) {
    const entity = entityForName(name, entitiesById);
    const base = {
      kind: name.kind,
      tier: name.tier,
      stableId: name.stableId,
      legacyNameKey: name.legacyNameKey,
      legacyNameKeys: [name.legacyNameKey],
      authorityStatus: entity?.status ?? name.authorityStatus,
      canonicalName: entity?.canonicalName ?? null,
      occurrenceScopes: [...new Set(name.occurrences.map((item) => item.scope))].sort(),
    };
    add(base, name.rawName, "LEGACY_NAME");
    if (!entity) continue;
    // canonicalName is a program label, not proof of the game-facing display spelling.
    add(base, entity.canonicalName, "CANONICAL_NAME");
    for (const displayName of entity.displayNames) {
      if (displayName.status === "VERIFIED" || displayName.status === "DISPUTED") add(base, displayName.text, "DISPLAY_NAME", displayName.status);
    }
    for (const alias of entity.aliases) {
      if (alias.status === "VERIFIED" || alias.status === "DISPUTED") add(base, alias.text, "ALIAS", alias.status);
    }
  }
  const seen = new Map();
  for (const term of terms) {
    const identity = term.stableId === null ? `legacy:${term.legacyNameKey}` : `entity:${term.stableId}`;
    const key = `${identity}\0${term.kind}\0${normalizeName(term.text, "toItem").compact}`;
    const prior = seen.get(key);
    if (!prior) {
      seen.set(key, { ...term, legacyNameKeys: [...term.legacyNameKeys] });
      continue;
    }
    prior.legacyNameKeys = [...new Set([...prior.legacyNameKeys, ...term.legacyNameKeys])].sort();
    prior.occurrenceScopes = [...new Set([...prior.occurrenceScopes, ...term.occurrenceScopes])].sort();
    if (prior.source !== term.source) prior.source = "CURATED_NAME_SET";
    if (term.nameStatus === "DISPUTED") prior.nameStatus = "DISPUTED";
    else if (prior.nameStatus !== "DISPUTED" && term.nameStatus === "VERIFIED") prior.nameStatus = "VERIFIED";
  }
  return [...seen.values()];
}

function toPublicCandidate(term, observedText, normalizationSteps) {
  return {
    value: term.text,
    observedText,
    stableId: term.stableId,
    kind: term.kind,
    tier: term.tier,
    canonicalName: term.canonicalName,
    authorityStatus: term.authorityStatus,
    legacyNameKey: term.legacyNameKey,
    legacyNameKeys: [...term.legacyNameKeys],
    nameSource: term.source,
    source: term.source,
    nameStatus: term.nameStatus,
    occurrenceScopes: [...term.occurrenceScopes],
    normalizationSteps,
  };
}

function riskForIdentity(term, matchStatus) {
  const risks = [];
  if (term.authorityStatus === "DISPUTED" || term.nameStatus === "DISPUTED") risks.push(makeRisk("MASTER_NAME_DISPUTED"));
  else if (term.stableId && term.authorityStatus !== "VERIFIED") risks.push(makeRisk("MASTER_IDENTITY_UNVERIFIED"));
  if (matchStatus === "corrected") risks.push(makeRisk("BOUNDED_UNIQUE_MATCH", { similarityPolicy: "V1_UNIQUE_BOUNDED_0.75" }));
  return risks;
}

function identityFieldProjection({ key, field, registrySnapshot, terms, pool, scopeFilter = null, externalRisk = [] }) {
  const rawEvidence = field[RAW_EVIDENCE] ?? cloneJson(field, `rawEvidence.${key}`);
  const rawText = nonempty(field.normalizedText) ? field.normalizedText : nonempty(field.rawText) ? field.rawText : null;
  const normalization = rawText === null ? null : normalizeName(rawText, key);
  const risks = [...externalRisk];
  const reasons = [];
  if (field.status === "UNKNOWN") risks.push(makeRisk("FIELD_STATUS_MISSING"));
  if (!rawText) {
    risks.push(makeRisk("RAW_TEXT_MISSING"));
    return makeFieldResult({ key, rawEvidence, candidate: null, alternatives: [], shownValue: null, status: "UNMATCHED", reasons: [makeReason("UNMATCHED_SOURCE_PRESERVED")], risks, normalizationSteps: [], registrySnapshot });
  }
  if (!field.rawText && field.normalizedText) risks.push(makeRisk("RAW_TEXT_MISSING"));
  if (CLIPPED_STATUSES.has(field.status)) risks.push(makeRisk(field.status));
  for (const reasonCode of field.reasonCodes) {
    if (reasonCode === "FIELD_CLIPPED" || reasonCode === "GEOMETRY_ABSTAIN" || reasonCode === "OCR_ERROR" || reasonCode === "EMPTY_OCR") {
      risks.push(makeRisk(reasonCode));
    } else if (reasonCode !== "ROW_BOUNDARY_CONTACT") {
      risks.push(makeRisk("RECOGNITION_WARNING", reasonCode));
    }
  }
  let eligible = pool.filter((term) => scopeFilter === null || term.occurrenceScopes.some((scope) => scopeFilter.includes(scope)));
  if (key !== "island" && normalization.steps.some((step) => step.operation === "TIER_HINT")) {
    const hintedTier = normalization.steps.find((step) => step.operation === "TIER_HINT").tier;
    const tierCandidates = eligible.filter((term) => term.tier === hintedTier);
    eligible = tierCandidates;
    if (!tierCandidates.length) risks.push(makeRisk("OUTPUT_TIER_HINT_UNAVAILABLE", `인식된 접두 단계 ${hintedTier}`));
  }

  let matches = [];
  let matchStatus = "unmatched";
  const exactMatches = eligible.filter((term) => normalizeName(term.text, key).compact === normalization.compact);
  if (exactMatches.length) {
    matches = exactMatches;
    matchStatus = "exact";
  } else {
    const matchTarget = key === "island" ? normalization.normalized : normalization.compact;
    const result = getSafeUniqueItemMatch(matchTarget, eligible.map((term) => term.text));
    if (result.status === "exact") {
      // Ask the V1 helper per identity so its whitespace-insensitive exact
      // semantics cannot hide a second legacy or curated identity.
      matches = eligible.filter((term) => getSafeUniqueItemMatch(matchTarget, [term.text]).status === "exact");
      matchStatus = "exact";
    } else if (result.status === "corrected") {
      matches = eligible.filter((term) => term.text === result.value);
      matchStatus = "corrected";
    } else if (result.status === "ambiguous") {
      const values = new Set(result.candidates);
      matches = eligible.filter((term) => values.has(term.text));
      matchStatus = "ambiguous";
    }
  }
  const distinct = new Map();
  for (const term of matches) {
    const identity = term.stableId === null ? `legacy:${term.legacyNameKey}` : `entity:${term.stableId}`;
    distinct.set(identity, term);
  }
  matches = [...distinct.values()];
  if (matches.length > 1 || matchStatus === "ambiguous") {
    const alternatives = matches.map((term) => toPublicCandidate(term, rawText, normalization.steps));
    const ambiguityCode = exactMatches.length > 1 ? "NORMALIZED_NAME_COLLISION" : "AMBIGUOUS_MATCH";
    return makeFieldResult({ key, rawEvidence, candidate: null, alternatives, shownValue: normalization.normalized, status: "AMBIGUOUS", reasons: [makeReason("AMBIGUOUS_MATCH")], risks: [...risks, makeRisk(ambiguityCode)], normalizationSteps: normalization.steps, registrySnapshot });
  }
  if (!matches.length) {
    risks.push(makeRisk("NO_MATCH"));
    return makeFieldResult({ key, rawEvidence, candidate: null, alternatives: [], shownValue: normalization.normalized, status: "UNMATCHED", reasons: [makeReason("UNMATCHED_SOURCE_PRESERVED")], risks, normalizationSteps: normalization.steps, registrySnapshot });
  }

  const term = matches[0];
  const candidate = toPublicCandidate(term, rawText, normalization.steps);
  const correctionReason = matchStatus === "corrected" ? "BOUNDED_UNIQUE_MATCH"
    : term.source === "ALIAS" ? "VERIFIED_ALIAS_MATCH"
      : term.source === "DISPLAY_NAME" ? "VERIFIED_DISPLAY_NAME_MATCH"
        : matchStatus === "exact" ? "EXACT_MATCH" : "UNMATCHED_SOURCE_PRESERVED";
  reasons.push(makeReason(correctionReason));
  risks.push(...riskForIdentity(term, matchStatus));
  const disputed = term.nameStatus === "DISPUTED" || term.authorityStatus === "DISPUTED";
  const status = disputed ? "MASTER_DISAGREEMENT" : "MATCHED";
  if (disputed) reasons.push(makeReason("MASTER_DISAGREEMENT"));
  if (disputed) {
    risks.push(makeRisk("MASTER_NAME_DISPUTED"));
    risks.push(makeRisk("MASTER_DISAGREEMENT"));
    return makeFieldResult({ key, rawEvidence, candidate, alternatives: [candidate], status, reasons: [...reasons, makeReason("MASTER_NAME_DISPUTED")], risks, normalizationSteps: normalization.steps, registrySnapshot });
  }
  return makeFieldResult({ key, rawEvidence, candidate, alternatives: [], status, reasons, risks, normalizationSteps: normalization.steps, registrySnapshot });
}

function numericToken(value) {
  const compact = value.replace(/\s+/gu, "");
  const matches = [...compact.matchAll(/[0-9]+(?:,[0-9]{3})*/gu)];
  return { compact, matches };
}

function allowedNumericDecoration(key, before, after) {
  const prefixes = {
    reqAmount: new Set(["", "수:", "수량:", "필요:", "필요수량:", "필요수량", "필요", "요구", "요구수량:"]),
    count: new Set(["", "횟수:", "남은횟수:", "남은교환횟수:", "수:"]),
    yield: new Set(["", "수율:", "획득:"]),
  };
  const suffixes = {
    reqAmount: new Set(["", "개", "개씩", "회", "회분"]),
    count: new Set(["", "회", "번", "회남음", "번남음"]),
    yield: new Set(["", "개", "개씩", "개당", "회"]),
  };
  return prefixes[key].has(before) && suffixes[key].has(after);
}

function numericFieldProjection(key, field, registrySnapshot) {
  const rawEvidence = field[RAW_EVIDENCE] ?? cloneJson(field, `rawEvidence.${key}`);
  const rawText = nonempty(field.normalizedText) ? field.normalizedText : nonempty(field.rawText) ? field.rawText : null;
  const risks = [];
  const reasons = [];
  for (const reasonCode of field.reasonCodes) {
    if (CLIPPED_STATUSES.has(reasonCode)) risks.push(makeRisk(reasonCode));
    else if (reasonCode !== "ROW_BOUNDARY_CONTACT") risks.push(makeRisk("RECOGNITION_WARNING", reasonCode));
  }
  if (!field.rawText && field.normalizedText) risks.push(makeRisk("RAW_TEXT_MISSING"));
  if (field.status === "UNKNOWN") risks.push(makeRisk("FIELD_STATUS_MISSING"));
  if (CLIPPED_STATUSES.has(field.status)) risks.push(makeRisk(field.status));
  const textNumbers = rawText === null ? { compact: "", matches: [] } : numericToken(rawText);
  let parsed = null;
  let parseFailure = null;
  if (textNumbers.matches.length > 1) {
    parseFailure = "MULTIPLE_NUMERIC_GROUPS";
  } else if (textNumbers.matches.length === 1) {
    const match = textNumbers.matches[0];
    const before = textNumbers.compact.slice(0, match.index);
    const after = textNumbers.compact.slice(match.index + match[0].length);
    if (allowedNumericDecoration(key, before, after)) {
      const value = Number(match[0].replaceAll(",", ""));
      if (Number.isSafeInteger(value) && value >= (key === "count" ? 0 : 1)) parsed = value;
      else parseFailure = "NUMERIC_FORMAT_UNSUPPORTED";
    } else parseFailure = "NUMERIC_FORMAT_UNSUPPORTED";
  } else {
    parseFailure = "NUMERIC_MISSING";
  }
  const minimum = key === "count" ? 0 : 1;
  const hasReaderCandidate = field.rawNumericCandidate !== null;
  const readerCandidateValid = Number.isSafeInteger(field.rawNumericCandidate) && field.rawNumericCandidate >= minimum;
  const readerValue = readerCandidateValid ? field.rawNumericCandidate : null;
  const alternatives = [];
  if (parseFailure === "MULTIPLE_NUMERIC_GROUPS" && !hasReaderCandidate) {
    risks.push(makeRisk("MULTIPLE_NUMERIC_GROUPS", textNumbers.matches.map((match) => match[0])));
    reasons.push(makeReason("MULTIPLE_NUMERIC_GROUPS"));
    return makeFieldResult({ key, rawEvidence, candidate: null, alternatives, shownValue: null, status: "AMBIGUOUS", reasons, risks, normalizationSteps: [], registrySnapshot });
  }
  if (hasReaderCandidate && !readerCandidateValid) {
    risks.push(makeRisk("NUMERIC_MISSING_OR_INVALID", { rawNumericCandidate: field.rawNumericCandidate, minimum }));
    reasons.push(makeReason("NUMERIC_MISSING_OR_INVALID"));
    return makeFieldResult({ key, rawEvidence, candidate: null, alternatives: [], status: "UNMATCHED", reasons, risks, registrySnapshot });
  }
  if (!hasReaderCandidate && parsed === null) {
    const code = parseFailure === "MULTIPLE_NUMERIC_GROUPS" ? "MULTIPLE_NUMERIC_GROUPS" : "NUMERIC_MISSING_OR_INVALID";
    risks.push(makeRisk(code, parseFailure === "MULTIPLE_NUMERIC_GROUPS" ? textNumbers.matches.map((match) => match[0]) : null));
    reasons.push(makeReason(code));
    return makeFieldResult({ key, rawEvidence, candidate: null, alternatives: [], shownValue: null, status: parseFailure === "MULTIPLE_NUMERIC_GROUPS" ? "AMBIGUOUS" : "UNMATCHED", reasons, risks, registrySnapshot });
  }
  const value = hasReaderCandidate ? readerValue : parsed;
  if (rawText === null) risks.push(makeRisk("RAW_TEXT_MISSING"));
  const source = hasReaderCandidate ? "RAW_NUMERIC_CANDIDATE" : "BOUNDED_NUMERIC_PARSE";
  const candidate = { value, source, rawText, rawNumericCandidate: hasReaderCandidate ? readerValue : null };
  reasons.push(makeReason(source));
  if (key === "reqAmount" || key === "yield") risks.push(makeRisk("NUMERIC_COMPLETENESS_UNVERIFIED"));
  if (field.status === "FIELD_CLIPPED" || field.status === "GEOMETRY_ABSTAIN" || field.status === "UNREADABLE" || field.status === "OCR_ERROR") {
    risks.push(makeRisk(field.status));
  }
  return makeFieldResult({ key, rawEvidence, candidate, alternatives: [], status: "MATCHED", reasons, risks, normalizationSteps: rawText === null || hasReaderCandidate ? [] : [{ operation: "BOUNDED_NUMERIC_PARSE", rawText, value }], registrySnapshot });
}

function makeFieldResult({ key, rawEvidence, candidate, alternatives, status, reasons, risks, normalizationSteps = [], registrySnapshot, shownValue }) {
  const uniqueRisks = [...new Map(risks.map((risk) => [`${risk.code}\0${JSON.stringify(risk.detail)}`, risk])).values()];
  return {
    field: key,
    labelKo: FIELD_LABELS[key],
    rawEvidence,
    candidate,
    alternatives,
    correctionReason: reasons,
    masterVersion: registrySnapshot?.registryVersion ?? null,
    masterRevision: registrySnapshot?.registryVersion ?? null,
    riskReasons: uniqueRisks,
    shownValue: shownValue !== undefined ? shownValue : candidate?.value ?? null,
    reviewState: "SYSTEM_PREDICTION_UNREVIEWED",
    editable: true,
    status,
    normalizationSteps,
  };
}

function getTierChoices(field) {
  const choices = [field.candidate, ...field.alternatives].filter((candidate) => candidate && candidate.kind === "MASTER_ITEM" && Number.isInteger(candidate.tier));
  return [...new Set(choices.map((candidate) => candidate.tier))];
}

function projectFromItem(field, toItemProjection, registrySnapshot, terms, masterVersion) {
  const rawEvidence = field[RAW_EVIDENCE] ?? cloneJson(field, "rawEvidence.fromItem");
  if (toItemProjection.status === "MATCHED" && toItemProjection.candidate?.kind === "SPECIAL_ITEM") {
    const pool = terms.filter((term) => term.kind === "MASTER_ITEM" || term.kind === "SPECIAL_ITEM");
    const result = identityFieldProjection({ key: "fromItem", field, registrySnapshot, terms, pool });
    result.masterVersion = masterVersion;
    result.masterRevision = masterVersion;
    return result;
  }
  const tiers = getTierChoices(toItemProjection);
  if (toItemProjection.status !== "MATCHED" || tiers.length !== 1) {
    const rawText = nonempty(field.normalizedText) ? field.normalizedText : nonempty(field.rawText) ? field.rawText : null;
    const normalized = rawText === null ? null : normalizeName(rawText, "fromItem");
    const status = ["AMBIGUOUS", "MASTER_DISAGREEMENT"].includes(toItemProjection.status) ? "AMBIGUOUS" : "UNMATCHED";
    return makeFieldResult({
      key: "fromItem", rawEvidence, candidate: null, alternatives: [],
      shownValue: normalized?.normalized ?? null, status,
      reasons: [makeReason("TO_ITEM_DEPENDENCY_UNRESOLVED")],
      risks: [makeRisk("TO_ITEM_DEPENDENCY_UNRESOLVED", { toItemStatus: toItemProjection.status, tierChoices: tiers }),
        ...(field.status === "UNKNOWN" ? [makeRisk("FIELD_STATUS_MISSING")] : []),
        ...(CLIPPED_STATUSES.has(field.status) ? [makeRisk(field.status)] : []),
        ...field.reasonCodes.filter((code) => code !== "ROW_BOUNDARY_CONTACT").map((code) =>
          ["FIELD_CLIPPED", "GEOMETRY_ABSTAIN", "OCR_ERROR", "EMPTY_OCR"].includes(code) ? makeRisk(code) : makeRisk("RECOGNITION_WARNING", code)),
        ...(rawText ? [] : [makeRisk("RAW_TEXT_MISSING")])],
      normalizationSteps: normalized?.steps ?? [], registrySnapshot,
    });
  }
  const outputTier = tiers[0];
  if (outputTier === 1) {
    const rawText = nonempty(field.normalizedText) ? field.normalizedText : nonempty(field.rawText) ? field.rawText : null;
    const candidate = rawText === null ? null : {
      value: rawText.trim(), observedText: rawText, stableId: null, kind: "MASTER_ITEM", tier: null,
      canonicalName: null, authorityStatus: "OPEN_WORLD", legacyNameKey: null, legacyNameKeys: [],
      source: "RAW_OPEN_WORLD", nameSource: "RAW_OPEN_WORLD", nameStatus: null, occurrenceScopes: [], normalizationSteps: [],
    };
    const risk = makeRisk("OPEN_WORLD_PRESERVED");
    if (toItemProjection.status === "MASTER_DISAGREEMENT") risk.detail = "획득품 매핑도 검수 필요";
    const risks = [risk, ...(candidate ? [] : [makeRisk("RAW_TEXT_MISSING")])];
    if (field.status === "UNKNOWN") risks.push(makeRisk("FIELD_STATUS_MISSING"));
    if (CLIPPED_STATUSES.has(field.status)) risks.push(makeRisk(field.status));
    for (const code of field.reasonCodes) {
      if (code === "ROW_BOUNDARY_CONTACT") continue;
      risks.push(["FIELD_CLIPPED", "GEOMETRY_ABSTAIN", "OCR_ERROR", "EMPTY_OCR"].includes(code)
        ? makeRisk(code) : makeRisk("RECOGNITION_WARNING", code));
    }
    return makeFieldResult({ key: "fromItem", rawEvidence, candidate, alternatives: [], status: candidate ? "OPEN_WORLD" : "UNMATCHED", reasons: [makeReason(candidate ? "OPEN_WORLD_PRESERVED" : "RAW_TEXT_MISSING")], risks, normalizationSteps: [], registrySnapshot });
  }
  const allowedTier = outputTier - 1;
  const pool = terms.filter((term) => term.kind === "MASTER_ITEM" && term.tier === allowedTier);
  const result = identityFieldProjection({ key: "fromItem", field, registrySnapshot, terms, pool });
  result.masterVersion = masterVersion;
  result.masterRevision = masterVersion;
  return result;
}

function projectRow(rowInfo, registrySnapshot, terms, masterVersion) {
  const row = rowInfo.row;
  const toItemPool = terms.filter((term) => term.kind === "MASTER_ITEM" || term.kind === "SPECIAL_ITEM");
  const toItem = identityFieldProjection({ key: "toItem", field: rowInfo.fields.toItem, registrySnapshot, terms, pool: toItemPool });
  toItem.masterRevision = masterVersion;
  const tierChoices = getTierChoices(toItem);
  const tierResolved = toItem.status === "MATCHED" && tierChoices.length === 1;
  const islandScopes = tierResolved
    ? [...new Set(tierChoices.map((tier) => tier === 6 ? "T6_ISLANDS" : tier === 7 ? "T7_ISLANDS" : "GENERAL_ISLANDS"))]
    : ["GENERAL_ISLANDS", "T6_ISLANDS", "T7_ISLANDS"];
  const islandRisk = tierResolved ? [] : [makeRisk("TO_ITEM_TIER_UNRESOLVED", { toItemStatus: toItem.status, tierChoices })];
  const islandPool = terms.filter((term) => term.kind === "ISLAND");
  const island = identityFieldProjection({ key: "island", field: rowInfo.fields.island, registrySnapshot, terms, pool: islandPool, scopeFilter: islandScopes, externalRisk: islandRisk });
  island.masterRevision = masterVersion;
  const fromItem = projectFromItem(rowInfo.fields.fromItem, toItem, registrySnapshot, terms, masterVersion);
  const fields = {
    island,
    fromItem,
    reqAmount: numericFieldProjection("reqAmount", rowInfo.fields.reqAmount, registrySnapshot),
    toItem,
    count: numericFieldProjection("count", rowInfo.fields.count, registrySnapshot),
    yield: numericFieldProjection("yield", rowInfo.fields.yield, registrySnapshot),
  };
  for (const field of Object.values(fields)) field.masterRevision = masterVersion;
  return {
    projectionRowId: rowInfo.rowId,
    sourceIndex: rowInfo.index,
    rowStatus: "COMPLETE",
    sourceRefs: cloneJson(rowInfo.sourceRefs, `sourceRefs.${rowInfo.rowId}`),
    captureId: row.captureId,
    ordinal: row.ordinal,
    ...(row.draftId !== undefined ? { draftId: cloneJson(row.draftId, "draftId") } : {}),
    ...(row.rowCropHash !== undefined ? { rowCropHash: cloneJson(row.rowCropHash, "rowCropHash") } : {}),
    ...(row.rowBox !== undefined ? { rowBox: cloneJson(row.rowBox, "rowBox") } : {}),
    originalRowEvidence: rowInfo.original,
    fields,
    reviewState: "SYSTEM_PREDICTION_UNREVIEWED",
  };
}

export function buildTradeReviewProjection({ draftRows, reconciliation = null, registrySnapshot, correctionPolicyVersion } = {}) {
  if (reconciliation !== null && (reconciliation?.phase !== "PRELIMINARY" || reconciliation?.schemaVersion !== 1)) {
    throw new TypeError("reconciliation must be a validated PRELIMINARY topology");
  }
  const validation = validateRegistrySnapshot(registrySnapshot);
  if (!validation.ok) throw new TypeError(`registrySnapshot is invalid: ${validation.errors.join("; ")}`);
  if (!nonempty(correctionPolicyVersion)) throw new TypeError("correctionPolicyVersion must be a nonempty string");
  const inputRows = validateDraftRows(draftRows);
  const masterSnapshotSha256 = registrySnapshotSha256(registrySnapshot);
  const masterVersion = registrySnapshot.registryVersion;
  const terms = createIdentityTerms(registrySnapshot);
  const sourceProjectionRows = inputRows.map((rowInfo) => projectRow(rowInfo, registrySnapshot, terms, masterVersion));
  if (reconciliation === null) {
    const base = {
      schemaVersion: 1,
      reviewMode: "REVIEW_FIRST",
      correctionVersion: correctionPolicyVersion,
      correctionPolicyVersion,
      masterVersion,
      masterRevision: registrySnapshot.registryVersion,
      masterSourceRevision: registrySnapshot.source.revision,
      masterSnapshotSha256,
      reconciliation: null,
      rows: sourceProjectionRows,
    };
    const projectionHash = registrySnapshotSha256(base);
    return deepFreeze({ ...base, projectionHash });
  }
  const finalized = reconcileTradeProjectionRows({ projectionRows: sourceProjectionRows, reconciliation });
  const base = {
    schemaVersion: 2,
    reviewMode: "REVIEW_FIRST",
    correctionVersion: correctionPolicyVersion,
    correctionPolicyVersion,
    masterVersion,
    masterRevision: registrySnapshot.registryVersion,
    masterSourceRevision: registrySnapshot.source.revision,
    masterSnapshotSha256,
    reconciliation: finalized.reconciliation,
    rows: finalized.rows,
  };
  const projectionHash = registrySnapshotSha256(base);
  return deepFreeze({ ...base, projectionHash });
}
