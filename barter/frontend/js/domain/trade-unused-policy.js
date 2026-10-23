const normalized = (value) => String(value ?? "").replace(/\[.*?\]\s*/g, "").replace(/\s+/g, "");

export function validateUnusedTradePolicy(policy, catalog) {
  const items = new Set([...Object.values(catalog.masterData).flat(), ...catalog.specialItems]);
  if (policy?.version !== 2 || typeof policy.autoExcludeUnregisteredOutputs !== "boolean"
      || !Array.isArray(policy.excludedOutputs) || policy.excludedOutputs.some((name) => !items.has(name))) {
    throw new Error("자동 미사용 기준 자료를 확인할 수 없습니다.");
  }
  return policy;
}

function confirmedName(field) {
  if (!field || field.reviewRequired || !field.corrected || field.reviewDraft !== undefined) return false;
  if (["USER_REVIEW", "USER_EDIT"].includes(field.valueSource)) return true;
  if (field.valueSource === "VERIFIED_TEMPLATE" && field.templateEvidence?.references?.length) return true;
  const expected = normalized(field.corrected);
  const readings = [{text:field.rawOCR, confidence:field.confidence}, ...(field.variants ?? [])];
  return readings.some((reading) => reading.confidence >= .75 && normalized(reading.text) === expected);
}

export function applyUnusedTradePolicy(rows, policy) {
  const outputs = new Map(policy.excludedOutputs.map((name) => [normalized(name), name]));
  for (const row of rows) {
    if (row.exclusionSource === "AUTO_UNUSED") {
      row.excluded = false;
      delete row.exclusionSource;
    }
    delete row.autoUnusedReason;
    const output = row.fields.toItem;
    if (confirmedName(output) && outputs.has(normalized(output.corrected))) {
      row.autoUnusedReason = `미사용 획득품 · ${outputs.get(normalized(output.corrected))}`;
    } else if (policy.autoExcludeUnregisteredOutputs && output.supportStatus === "UNREGISTERED_CANDIDATE"
        && output.reviewDraft === undefined) {
      row.autoUnusedReason = `미지원 획득품 · ${output.corrected}`;
    }
    if (row.autoUnusedReason && row.inclusionOverride !== true && !row.excluded) {
      row.excluded = true;
      row.exclusionSource = "AUTO_UNUSED";
    }
  }
}

export function setTradeRowIncluded(row, included) {
  row.inclusionOverride = included;
  row.excluded = !included;
  delete row.exclusionSource;
}
