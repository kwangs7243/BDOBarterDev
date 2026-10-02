const FIELD_KEYS = Object.freeze(["island", "fromItem", "reqAmount", "toItem", "count", "yield"]);
const NUMERIC_FIELDS = new Set(["reqAmount", "count", "yield"]);
const UNRESOLVED = new Set(["AMBIGUOUS", "UNMATCHED", "MASTER_DISAGREEMENT"]);

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }
function clone(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}
function same(left, right) { return stableJson(left) === stableJson(right); }
function union(values) {
  const result = [];
  for (const value of values) if (!result.some((item) => same(item, value))) result.push(clone(value));
  return result;
}
function validRowHash(value) { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }

function sourceIdentity(row, fieldName) {
  const field = row.fields[fieldName];
  if (UNRESOLVED.has(field.status)) return null;
  const candidate = field.candidate;
  if (nonempty(candidate?.stableId)) return { stableId: candidate.stableId };
  if (nonempty(candidate?.legacyNameKey)) return { legacyNameKey: candidate.legacyNameKey };
  if (fieldName === "fromItem" && candidate?.authorityStatus === "OPEN_WORLD" && typeof field.shownValue === "string") {
    return { openWorld: field.shownValue };
  }
  return null;
}

function semantic(fieldName, field) {
  if (NUMERIC_FIELDS.has(fieldName)) return { value: field.shownValue, identityKey: null };
  const identityKey = sourceIdentity({ fields: { [fieldName]: field } }, fieldName);
  return { value: identityKey ?? field.shownValue, identityKey };
}

function identity3(row) {
  const values = ["island", "fromItem", "toItem"].map((key) => sourceIdentity(row, key));
  return values.every(Boolean) ? values : null;
}
function sameIdentity(left, right) { return left !== null && right !== null && same(left, right); }
function exactSix(left, right) {
  return FIELD_KEYS.every((key) => same(semantic(key, left.fields[key]).value, semantic(key, right.fields[key]).value));
}

function validatePreliminary(value) {
  if (!record(value) || value.schemaVersion !== 1 || value.phase !== "PRELIMINARY"
      || value.policyVersion !== "trade-batch-reconciliation-v1" || !Array.isArray(value.captureOrder)
      || !Array.isArray(value.sourceRows) || !Array.isArray(value.adjacentCapturePairs) || !Array.isArray(value.findings)) {
    throw new TypeError("reconciliation must be a valid PRELIMINARY trade-batch topology");
  }
  if (Object.keys(value).sort().join("|") !== ["adjacentCapturePairs", "captureOrder", "findings", "phase", "policyVersion", "schemaVersion", "sourceRows"].sort().join("|")) {
    throw new TypeError("PRELIMINARY reconciliation has an unsupported shape");
  }
}

export function buildTradeBatchReconciliation({ captures, draftRows, policyVersion } = {}) {
  if (!Array.isArray(captures) || captures.length < 1 || !Array.isArray(draftRows)) throw new TypeError("captures must be a nonempty array and draftRows must be an array");
  if (policyVersion !== "trade-batch-reconciliation-v1") throw new TypeError("unsupported policyVersion");
  const captureIds = new Set();
  const captureOrder = captures.map((capture, index) => {
    const captureId = capture?.captureId;
    if (!nonempty(captureId) || captureIds.has(captureId)) throw new TypeError("captureId must be unique and nonempty");
    captureIds.add(captureId);
    const captureOrdinal = capture.captureOrdinal ?? index + 1;
    if (!Number.isSafeInteger(captureOrdinal) || captureOrdinal !== index + 1) throw new TypeError("captureOrdinal must match capture array order");
    if (capture.imageHash !== undefined && capture.imageHash !== null && !nonempty(capture.imageHash)) throw new TypeError("capture imageHash must be a nonempty string when provided");
    return { captureId, captureOrdinal, imageHash: capture.imageHash ?? null };
  });
  const captureIndex = new Map(captureOrder.map((capture, index) => [capture.captureId, index]));
  const positions = new Set();
  const sourceRows = draftRows.map((row, projectionSourceIndex) => {
    if (!record(row) || row.status !== "DRAFT_UNVERIFIED" || row.automationDecision !== "REVIEW"
        || !captureIndex.has(row.captureId) || !Number.isSafeInteger(row.ordinal) || row.ordinal < 0) {
      throw new TypeError(`draftRows[${projectionSourceIndex}] has invalid source position`);
    }
    const position = `${row.captureId}\0${row.ordinal}`;
    if (positions.has(position)) throw new TypeError("duplicate captureId/ordinal source row");
    positions.add(position);
    const sourceRowId = nonempty(row.rowId) ? row.rowId : `draft:${row.captureId}:${row.ordinal}`;
    const sourceRefs = row.sourceRefs === undefined ? [{ captureId: row.captureId, ordinal: row.ordinal, draftRowId: sourceRowId }] : row.sourceRefs;
    if (!Array.isArray(sourceRefs)) throw new TypeError("sourceRefs must be an array");
    return {
      sourceRowId, captureId: row.captureId, ordinal: row.ordinal, projectionSourceIndex,
      sourceRefs: clone(sourceRefs),
      ...(Object.hasOwn(row, "draftId") ? { draftId: clone(row.draftId) } : {}),
      ...(Object.hasOwn(row, "rowBox") ? { rowBox: clone(row.rowBox) } : {}),
      ...(Object.hasOwn(row, "rowCropHash") ? { rowCropHash: clone(row.rowCropHash) } : {}),
    };
  }).sort((left, right) => captureIndex.get(left.captureId) - captureIndex.get(right.captureId) || left.ordinal - right.ordinal);
  if (new Set(sourceRows.map((row) => row.sourceRowId)).size !== sourceRows.length) throw new TypeError("duplicate source row identity");
  const adjacentCapturePairs = captureOrder.slice(0, -1).map((left, index) => ({
    leftCaptureId: left.captureId,
    rightCaptureId: captureOrder[index + 1].captureId,
    sameImage: left.imageHash === captureOrder[index + 1].imageHash,
  }));
  return clone({ schemaVersion: 1, phase: "PRELIMINARY", policyVersion, captureOrder, sourceRows, adjacentCapturePairs, findings: [] });
}

export function reconcileTradeProjectionRows({ projectionRows, reconciliation } = {}) {
  validatePreliminary(reconciliation);
  if (!Array.isArray(projectionRows) || projectionRows.length !== reconciliation.sourceRows.length) throw new TypeError("projection rows must correspond one-to-one with source rows");
  const rowsById = new Map();
  for (const row of projectionRows) {
    if (!record(row) || !nonempty(row.projectionRowId) || rowsById.has(row.projectionRowId)) throw new TypeError("projection rows contain invalid or duplicate IDs");
    rowsById.set(row.projectionRowId, row);
  }
  const sourceRows = reconciliation.sourceRows.map((source) => {
    const row = rowsById.get(source.sourceRowId);
    if (!row || row.captureId !== source.captureId || row.ordinal !== source.ordinal || row.sourceIndex !== source.projectionSourceIndex
        || !same(row.sourceRefs, source.sourceRefs)
        || (row.originalRowEvidence?.sourceRefs !== undefined && !same(row.originalRowEvidence.sourceRefs, source.sourceRefs))) {
      throw new TypeError("projection rows do not match the preliminary source ledger");
    }
    const sourceProjection = clone(row);
    sourceProjection.originalRowEvidence.sourceRefs = clone(source.sourceRefs);
    return { source, row: sourceProjection };
  });
  if (sourceRows.some(({ row }) => Object.keys(row.fields ?? {}).sort().join("|") !== [...FIELD_KEYS].sort().join("|"))) throw new TypeError("source projection must contain six fields");

  const sourceById = new Map(sourceRows.map(({ source, row }) => [source.sourceRowId, { source, row }]));
  const perCapture = new Map(reconciliation.captureOrder.map(({ captureId }) => [captureId, []]));
  for (const entry of sourceRows) perCapture.get(entry.source.captureId).push(entry);
  for (const list of perCapture.values()) list.sort((a, b) => a.source.ordinal - b.source.ordinal);
  const captureIndex = new Map(reconciliation.captureOrder.map((capture, index) => [capture.captureId, index]));
  const accepted = [];
  const findings = [...reconciliation.findings];
  let overlapSequence = 0;
  const addOverlap = (basis, leftCaptureId, rightCaptureId, pairs) => {
    if (!pairs.length) return;
    accepted.push({ overlapId: `overlap:${++overlapSequence}`, basis, leftCaptureId, rightCaptureId, pairs });
  };

  // Repeated identical bitmaps are strong source evidence and use complete ordinal correspondence.
  const byImage = new Map();
  for (const capture of reconciliation.captureOrder) {
    if (!nonempty(capture.imageHash)) continue;
    const list = byImage.get(capture.imageHash) ?? [];
    list.push(capture.captureId); byImage.set(capture.imageHash, list);
  }
  for (const captureIds of byImage.values()) {
    if (captureIds.length < 2) continue;
    const anchorId = captureIds[0];
    const anchorRows = perCapture.get(anchorId);
    for (const otherId of captureIds.slice(1)) {
      const otherRows = perCapture.get(otherId);
      if (anchorRows.length !== otherRows.length || anchorRows.some((item, index) => item.source.ordinal !== otherRows[index].source.ordinal)) {
        findings.push({ code: "DUPLICATE_IMAGE_ROW_MAPPING_CONFLICT", captureIds: [anchorId, otherId] });
        continue;
      }
      addOverlap("DUPLICATE_IMAGE", anchorId, otherId, anchorRows.map((item, index) => ({ leftSourceRowId: item.source.sourceRowId, rightSourceRowId: otherRows[index].source.sourceRowId })));
    }
  }

  for (let index = 0; index + 1 < reconciliation.captureOrder.length; index += 1) {
    const leftCapture = reconciliation.captureOrder[index]; const rightCapture = reconciliation.captureOrder[index + 1];
    if (!nonempty(leftCapture.imageHash) || !nonempty(rightCapture.imageHash)) {
      findings.push({ code: "IMAGE_HASH_UNAVAILABLE", leftCaptureId: leftCapture.captureId, rightCaptureId: rightCapture.captureId });
      continue;
    }
    if (leftCapture.imageHash === rightCapture.imageHash) continue;
    const leftRows = perCapture.get(leftCapture.captureId); const rightRows = perCapture.get(rightCapture.captureId);
    let longest = 0;
    for (let length = 1; length <= Math.min(leftRows.length, rightRows.length); length += 1) {
      const left = leftRows.slice(-length); const right = rightRows.slice(0, length);
      if (left.every((item, i) => sameIdentity(identity3(item.row), identity3(right[i].row)))) longest = length;
    }
    if (longest >= 2) {
      addOverlap("ADJACENT_SUFFIX_PREFIX", leftCapture.captureId, rightCapture.captureId,
        leftRows.slice(-longest).map((item, i) => ({ leftSourceRowId: item.source.sourceRowId, rightSourceRowId: rightRows[i].source.sourceRowId })));
    } else if (leftRows.length && rightRows.length) {
      const left = leftRows.at(-1); const right = rightRows[0];
      if (sameIdentity(identity3(left.row), identity3(right.row)) && validRowHash(left.source.rowCropHash) && left.source.rowCropHash === right.source.rowCropHash) {
        addOverlap("ADJACENT_ROW_CROP_HASH", leftCapture.captureId, rightCapture.captureId,
          [{ leftSourceRowId: left.source.sourceRowId, rightSourceRowId: right.source.sourceRowId }]);
      } else if (sameIdentity(identity3(left.row), identity3(right.row))) {
        findings.push({ code: "POSSIBLE_SINGLE_ROW_OVERLAP", leftCaptureId: leftCapture.captureId, rightCaptureId: rightCapture.captureId,
          leftSourceRowId: left.source.sourceRowId, rightSourceRowId: right.source.sourceRowId });
      }
    }
  }

  const edges = accepted.flatMap((overlap) => overlap.pairs.map((pair) => ({ ...pair, overlapId: overlap.overlapId })));
  const parent = new Map(sourceRows.map(({ source }) => [source.sourceRowId, source.sourceRowId]));
  const find = (id) => { let current = id; while (parent.get(current) !== current) current = parent.get(current); let node = id; while (parent.get(node) !== current) { const next = parent.get(node); parent.set(node, current); node = next; } return current; };
  const join = (left, right) => { const a = find(left); const b = find(right); if (a !== b) parent.set(b, a); };
  edges.forEach((edge) => join(edge.leftSourceRowId, edge.rightSourceRowId));
  const components = new Map();
  for (const { source } of sourceRows) { const root = find(source.sourceRowId); const list = components.get(root) ?? []; list.push(source.sourceRowId); components.set(root, list); }
  const blocked = new Set();
  for (const members of components.values()) {
    const captures = members.map((id) => sourceById.get(id).source.captureId);
    if (members.length > 1 && new Set(captures).size !== captures.length) {
      members.forEach((id) => blocked.add(id));
      findings.push({ code: "AMBIGUOUS_SOURCE_ALIGNMENT", sourceRowIds: members });
    }
  }
  if (blocked.size) {
    for (let index = accepted.length - 1; index >= 0; index -= 1) {
      if (accepted[index].pairs.some((pair) => blocked.has(pair.leftSourceRowId) || blocked.has(pair.rightSourceRowId))) accepted.splice(index, 1);
    }
    edges.length = 0;
    for (const overlap of accepted) edges.push(...overlap.pairs.map((pair) => ({ ...pair, overlapId: overlap.overlapId })));
    parent.forEach((_value, id) => parent.set(id, id));
    edges.forEach((edge) => join(edge.leftSourceRowId, edge.rightSourceRowId));
    components.clear();
    for (const { source } of sourceRows) { const root = find(source.sourceRowId); const list = components.get(root) ?? []; list.push(source.sourceRowId); components.set(root, list); }
  }
  const groupMembers = new Map();
  for (const members of components.values()) {
    if (members.some((id) => blocked.has(id))) members.forEach((id) => groupMembers.set(id, [id]));
    else members.forEach((id) => groupMembers.set(id, members));
  }
  const orderSource = (left, right) => {
    const a = sourceById.get(left).source; const b = sourceById.get(right).source;
    return captureIndex.get(a.captureId) - captureIndex.get(b.captureId) || a.ordinal - b.ordinal;
  };
  const orderedGroups = [];
  const seen = new Set();
  for (const { source } of sourceRows) {
    if (seen.has(source.sourceRowId)) continue;
    const members = [...groupMembers.get(source.sourceRowId)].sort(orderSource);
    members.forEach((id) => seen.add(id));
    orderedGroups.push(members);
  }
  const rows = [];
  const groups = [];
  const sourceToLogical = [];
  const sourceProjectionEvidence = [];
  for (const members of orderedGroups) {
    const entries = members.map((id) => sourceById.get(id));
    const representative = entries[0]; const logicalId = representative.source.sourceRowId;
    const multi = members.length > 1;
    let conflict = false;
    const logical = clone(representative.row);
    const refs = union(entries.flatMap(({ row }) => row.sourceRefs));
    logical.sourceRefs = refs;
    logical.reconciliationMembers = entries.map(({ source }) => ({
      projectionRowId: source.sourceRowId, captureId: source.captureId, ordinal: source.ordinal, sourceRefs: clone(source.sourceRefs),
      ...(Object.hasOwn(source, "draftId") ? { draftId: clone(source.draftId) } : {}),
      ...(Object.hasOwn(source, "rowBox") ? { rowBox: clone(source.rowBox) } : {}),
      ...(Object.hasOwn(source, "rowCropHash") ? { rowCropHash: clone(source.rowCropHash) } : {}),
    }));
    for (const key of FIELD_KEYS) {
      const memberFields = entries.map(({ row }) => row.fields[key]);
      const semantics = memberFields.map((field) => semantic(key, field));
      const distinct = [];
      semantics.forEach((item, index) => {
        const found = distinct.find((candidate) => same(candidate.value, item.value));
        if (found) found.indices.push(index); else distinct.push({ value: item.value, identityKey: item.identityKey, indices: [index] });
      });
      const field = logical.fields[key];
      field.riskReasons = union(memberFields.flatMap((item) => item.riskReasons ?? []));
      field.correctionReason = union(memberFields.flatMap((item) => item.correctionReason ?? []));
      if (distinct.length > 1) {
        conflict = true;
        field.shownValue = null; field.candidate = null; field.status = "AMBIGUOUS";
        field.alternatives = distinct.map((item) => {
          const sourceIds = item.indices.map((i) => members[i]);
          return { value: memberFields[item.indices[0]].shownValue, identityKey: clone(item.identityKey), sourceRowIds: sourceIds,
            sourceRefs: union(sourceIds.flatMap((id) => sourceById.get(id).source.sourceRefs)) };
        });
        field.riskReasons = union([...field.riskReasons, { code: "RECONCILIATION_CONFLICT", messageKo: "겹친 캡처의 값이 달라 직접 확인이 필요합니다.", detail: { sourceRowIds: members } }]);
      }
    }
    const status = !multi ? "UNMERGED" : conflict ? "CONFLICT" : "EXACT_OVERLAP";
    const groupId = `reconcile-group:${representative.source.projectionSourceIndex}`;
    logical.projectionRowId = logicalId;
    logical.reconciliationGroupId = groupId;
    logical.reconciliationStatus = status;
    rows.push(logical);
    const memberSet = new Set(members);
    const mergeEvidenceIds = union(edges.filter((edge) => memberSet.has(edge.leftSourceRowId) && memberSet.has(edge.rightSourceRowId)).map((edge) => edge.overlapId));
    groups.push({ reconciliationGroupId: groupId, status, memberSourceRowIds: members, representativeSourceRowId: logicalId,
      logicalProjectionRowId: logicalId, mergeEvidenceIds });
    members.forEach((sourceRowId) => sourceToLogical.push({ sourceRowId, logicalProjectionRowId: logicalId }));
    if (multi) entries.forEach(({ row }) => sourceProjectionEvidence.push(clone(row)));
  }
  const orderMap = new Map(sourceRows.map(({ source }, index) => [source.sourceRowId, index]));
  sourceToLogical.sort((a, b) => orderMap.get(a.sourceRowId) - orderMap.get(b.sourceRowId));
  sourceProjectionEvidence.sort((a, b) => orderMap.get(a.projectionRowId) - orderMap.get(b.projectionRowId));
  const finalReconciliation = {
    schemaVersion: 1, phase: "FINAL", policyVersion: reconciliation.policyVersion,
    captureOrder: clone(reconciliation.captureOrder), sourceRows: clone(reconciliation.sourceRows), overlaps: accepted,
    groups, sourceToLogical, sourceProjectionEvidence, findings,
  };
  return { rows, reconciliation: finalReconciliation };
}
