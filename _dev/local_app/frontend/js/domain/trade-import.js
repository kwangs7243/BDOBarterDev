export function parseTradeJsonText(text) {
  const cleanText = String(text ?? "").replace(/```json/gi, "").replace(/```/g, "").trim();
  let value;
  try {
    value = JSON.parse(cleanText);
  } catch (error) {
    return { ok: false, kind: "json_parse", message: error.message };
  }
  if (!Array.isArray(value)) {
    return { ok: false, kind: "unsupported_structure", message: "물교 입력은 JSON 객체 배열이어야 합니다." };
  }
  if (!value.length) {
    return { ok: false, kind: "required_field", message: "물교 행이 비어 있어 현재 회차를 바꾸지 않았습니다." };
  }
  const invalidIndex = value.findIndex((row) => !row || typeof row !== "object" || Array.isArray(row));
  if (invalidIndex !== -1) {
    return { ok: false, kind: "unsupported_structure", message: `${invalidIndex + 1}번째 행은 JSON 객체가 아닙니다.` };
  }
  return { ok: true, rows: value };
}

export function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) matrix[i][j] = matrix[i - 1][j - 1];
      else matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return matrix[b.length][a.length];
}

export function getBestMatch(target, candidates, forceMatch = false) {
  if (!target) return "";
  let best = target;
  let min = 999;
  const normalizedTarget = target.replace(/\s+/g, "");
  for (const candidate of candidates) {
    const normalizedCandidate = candidate.replace(/\s+/g, "");
    if (normalizedCandidate === normalizedTarget) return candidate;
    const distance = levenshtein(normalizedTarget, normalizedCandidate);
    if (distance < min) { min = distance; best = candidate; }
  }
  return (forceMatch || min <= 3) ? best : target;
}

const ISLAND_CANONICAL_ALIASES = Object.freeze({
  "아레하자": "아레하자 마을",
  "하코번": "하코번 섬",
  "해모": "해모 섬",
});

export function canonicalizeIslandName(value) {
  const name = String(value || "").trim();
  return ISLAND_CANONICAL_ALIASES[name] || name;
}

export function getSafeUniqueItemMatch(target, candidates) {
  const normalizedTarget = String(target || "").replace(/\s+/g, "");
  if (!normalizedTarget) return { value: "", status: "unmatched" };
  const uniqueCandidates = [...new Set((candidates || []).filter(Boolean))];
  const exact = uniqueCandidates.find((candidate) => candidate.replace(/\s+/g, "") === normalizedTarget);
  if (exact) return { value: exact, status: "exact", distance: 0 };
  const prefix = normalizedTarget.replace(/(?:\.\.\.|…)$/, "");
  const prefixMatches = prefix.length >= 6 ? uniqueCandidates.filter(candidate => candidate.replace(/\s+/g, "").startsWith(prefix)) : [];
  if (prefixMatches.length === 1) return {value: prefixMatches[0], status: "corrected"};
  if (prefixMatches.length > 1) return {value: "", status: "ambiguous", candidates: prefixMatches};
  const maxDistance = Math.min(3, Math.max(1, Math.ceil(normalizedTarget.length * 0.25)));
  const qualified = uniqueCandidates.map((candidate) => {
    const normalizedCandidate = candidate.replace(/\s+/g, "");
    const distance = levenshtein(normalizedTarget, normalizedCandidate);
    const similarity = 1 - distance / Math.max(normalizedTarget.length, normalizedCandidate.length);
    return { value: candidate, distance, similarity };
  }).filter((candidate) => candidate.distance <= maxDistance && candidate.similarity >= 0.75);
  if (qualified.length === 1) return { ...qualified[0], status: "corrected" };
  if (qualified.length > 1) return { value: "", status: "ambiguous", candidates: qualified.map((candidate) => candidate.value) };
  return { value: "", status: "unmatched" };
}

export function getItemTier(itemName, masterData, specialItems) {
  if (!itemName) return 0;
  const cleanName = itemName.replace(/\[.*?\]\s*/g, "").trim();
  for (let tier = 1; tier <= 7; tier++) {
    if ((masterData[tier] || []).some((name) => name.replace(/\s+/g, "") === cleanName.replace(/\s+/g, ""))) return tier;
  }
  if (cleanName.includes("진주 결정") || cleanName.includes("암염 주괴") || cleanName.includes("코발트 주괴") || cleanName.includes("오킬루아의 꽃") || cleanName.includes("파도의 블랙스톤") || cleanName.includes("대양의 견고한 현철") || cleanName.includes("유실된 무역품 상자")) return "mat";
  if (cleanName.replace(/\s+/g, "").includes("까마귀주화")) return "coin";
  if (specialItems.some((name) => name.replace(/\s+/g, "") === cleanName.replace(/\s+/g, ""))) return "mat";
  return 0;
}

export function applyLiveTradeRules(row, catalog) {
  const fields = row.fields;
  const tier = (name) => getItemTier(fields[name].corrected, catalog.masterData, catalog.specialItems) || fields[name].recognizedStage;
  const source = tier("fromItem"), destination = tier("toItem");
  const fixed = {};
  if (destination !== 1 && (destination || Number.isInteger(source) && source > 0)) fixed.reqAmount = 1;
  if (destination === 1) fixed.yield = 1;
  if (destination === 4) fixed.yield = 2;
  if ([5, 6, 7].includes(destination)) fixed.yield = 1;
  const output = String(fields.toItem.corrected ?? "").replace(/\s+/g, "");
  if (["유실된무역품상자", "화려한진주결정", "화려한암염주괴"].includes(output)) fixed.yield = 1;
  for (const name of ["reqAmount", "yield"]) {
    if (!Object.hasOwn(fixed, name) && fields[name].valueSource === "TRADE_RULE") {
      Object.assign(fields[name], {corrected: null, reviewRequired: true});
      delete fields[name].valueSource;
      delete fields[name].rule;
    }
  }
  for (const [name, value] of Object.entries(fixed)) {
    Object.assign(fields[name], {corrected: value, reviewRequired: false, valueSource: "TRADE_RULE"});
    delete fields[name].allowedValues;
    delete fields[name].reviewDraft;
    delete fields[name].importReview;
    delete fields[name].conflictReview;
    delete fields[name].reviewReason;
  }
  if (!Object.hasOwn(fixed, "yield")) {
    if ([[1, 2], [2, 3]].some(([a, b]) => source === a && destination === b)) fields.yield.allowedValues = [2, 3];
    else delete fields.yield.allowedValues;
  }
  row.reviewFields = (row.reviewFields ?? []).filter((name) => !Object.hasOwn(fixed, name));
  return row;
}

export function compareTradeOrder(left, right, catalog) {
  const rank = (row) => {
    const output = row.fields?.toItem;
    const destination = getItemTier(output?.corrected ?? row.toItem, catalog.masterData, catalog.specialItems) || output?.recognizedStage;
    return Number.isInteger(destination) && destination >= 1 && destination <= 7 ? destination - 1 : destination === "mat" ? 7 : destination === "coin" ? 8 : 9;
  };
  return rank(left) - rank(right);
}

export function applyMasterNameRules(row, catalog) {
  const items = [...Object.values(catalog.masterData).flat(), ...catalog.specialItems];
  const islands = [...catalog.islands, ...catalog.t6Islands, ...catalog.t7Islands];
  for (const name of ["toItem", "fromItem", "island"]) {
    const field = row.fields[name];
    if (["USER_REVIEW", "USER_EDIT"].includes(field.valueSource) || field.reviewDraft !== undefined) continue;
    const destination = getItemTier(row.fields.toItem.corrected, catalog.masterData, catalog.specialItems);
    const candidates = name === "island" ? islands : name === "fromItem" && Number.isInteger(destination) && destination >= 1 ? catalog.masterData[destination - 1] || [] : items;
    const readings = [field.rawOCR, ...(field.variants || []).map(v => v.text)].filter(Boolean);
    const matches = readings.map(text => {
      const reading = String(text).replace(/\[.*?\]\s*/g, "").trim();
      return getSafeUniqueItemMatch(name === "island" ? canonicalizeIslandName(reading) : reading, candidates);
    });
    const values = [...new Set(matches.map(match => match.value).filter(Boolean))];
    if (values.length === 1) {
      Object.assign(field, {corrected: values[0], reviewRequired: false, valueSource: "MASTER", masterMatch: "RESOLVED"});
      delete field.importReview;
      delete field.reviewReason;
    } else if (values.length > 1) {
      Object.assign(field, {reviewRequired: true, masterMatch: "CONFLICT", reviewReason: "인식된 이름들이 서로 다른 마스터 품목과 일치합니다."});
    }
  }
  return row;
}

export function prepareLiveTradeRows(result, catalog) {
  for (const row of result.rows) {
    for (const field of Object.values(row.fields)) {
      if (!Object.hasOwn(field, "automaticCorrected")) field.automaticCorrected = field.corrected;
    }
    applyMasterNameRules(row, catalog);
    applyLiveTradeRules(row, catalog);
    delete row.duplicateOf;
  }
  const ready = result.rows.filter((row) => !row.excluded && Object.values(row.fields).every((f) => f.corrected !== null && f.corrected !== undefined));
  const parsed = processParsedTrades(ready.map((row) => Object.fromEntries(Object.entries(row.fields).map(([k, f]) => [k, f.corrected]))), [], catalog);
  for (const outcome of parsed.outcomes) {
    if (["accepted", "duplicate"].includes(outcome.status)) {
      for (const field of Object.values(ready[outcome.index].fields)) {
        if (field.importReview === true) { field.reviewRequired = false; delete field.importReview; delete field.reviewReason; }
      }
      applyLiveTradeRules(ready[outcome.index], catalog);
    } else {
      const field = ready[outcome.index].fields[outcome.field ?? "fromItem"];
      Object.assign(field, {reviewRequired: true, importReview: true,
        reviewReason: outcome.status === "conflict" ? "같은 섬·결과의 요구 품목이 다릅니다. 한 행을 제외하거나 품목을 수정하세요." : outcome.candidates?.length ? `마스터 후보: ${outcome.candidates.join(" / ")}` : "마스터에서 품목을 찾지 못했습니다. 이름을 수정하거나 행을 제외하세요."});
    }
  }
  const groups = new Map();
  const identities = new Map();
  for (const row of result.rows) {
    for (const field of Object.values(row.fields)) {
      if (field.conflictReview) { field.reviewRequired = false; delete field.conflictReview; delete field.reviewReason; }
    }
  }
  result.rows.forEach((row, index) => {
    if (row.excluded || ["island", "fromItem", "toItem"].some((name) => row.fields[name].reviewRequired)) return;
    const key = JSON.stringify(["island", "fromItem", "toItem"].map((name) => String(row.fields[name].corrected).replace(/\s+/g, "")));
    const peers = identities.get(key) ?? [];
    peers.push({row, index}); identities.set(key, peers);
  });
  for (const peers of identities.values()) {
    for (const name of ["reqAmount", "count", "yield"]) {
      const values = new Set(peers.map(({row}) => row.fields[name].corrected));
      if (values.size > 1) for (const {row} of peers) {
        Object.assign(row.fields[name], {reviewRequired: true, conflictReview: true, reviewReason: "겹친 캡처의 값이 다릅니다. 같은 값으로 수정하거나 한 행을 제외하세요."});
      }
    }
  }
  result.rows.forEach((row, index) => {
    if (row.excluded || ["island", "fromItem", "toItem"].some((name) => row.fields[name].reviewRequired)) return;
    applyLiveTradeRules(row, catalog);
    const key = JSON.stringify(["island", "fromItem", "toItem", "reqAmount", "count", "yield"].map((name) => typeof row.fields[name].corrected === "string" ? row.fields[name].corrected.replace(/\s+/g, "") : row.fields[name].corrected));
    if (groups.has(key)) row.duplicateOf = groups.get(key);
    else groups.set(key, index);
  });
  return result.rows.map((row, index) => ({row, index})).filter(({row}) => row.duplicateOf === undefined)
    .sort((left, right) => compareTradeOrder(left.row, right.row, catalog));
}

export function processParsedTrades(newTrades, existingTrades, catalog) {
  const { masterData, specialItems, islands, t6Islands, t7Islands } = catalog;
  const masterItems = [];
  for (let tier = 1; tier <= 7; tier++) masterItems.push(...(masterData[tier] || []));
  const allItems = [...masterItems, ...specialItems];
  const trades = (existingTrades || []).map((trade) => ({ ...trade, island: canonicalizeIslandName(trade.island) }));
  const outcomes = [];
  let addedCount = 0;
  let rejectedCount = 0;
  let conflictCount = 0;
  let reviewCount = 0;
  let duplicateCount = 0;

  newTrades.forEach((nt, index) => {
    if (!Object.hasOwn(nt, "island")) {
      outcomes.push({ index, status: "held", field: "island" });
      return;
    }
    const rawIsland = canonicalizeIslandName(nt.island);
    const rawFrom = String(nt.fromItem || "").replace(/\[.*?\]\s*/g, "").replace(/\s*x\s*\d+/gi, "").trim();
    const rawTo = String(nt.toItem || "").replace(/\[.*?\]\s*/g, "").replace(/\s*x\s*\d+/gi, "").trim();
    const toMatch = getSafeUniqueItemMatch(rawTo, allItems);
    const safeTo = toMatch.value;
    const rowYield = nt.yield;
    if (!safeTo) {
      rejectedCount++; reviewCount++;
      outcomes.push({ index, status: toMatch.status === "ambiguous" ? "ambiguous" : "unmatched", field: "toItem", candidates: toMatch.candidates || [] });
      return;
    }
    if (!Number.isInteger(rowYield) || rowYield <= 0) {
      rejectedCount++;
      outcomes.push({ index, status: "held", field: "yield" });
      return;
    }

    const toTier = getItemTier(safeTo, masterData, specialItems);
    let safeIsland = "";
    let safeFrom = "";
    let fromCandidates = [];
    if (toTier === 6) {
      safeIsland = getBestMatch(rawIsland, t6Islands, true);
      fromCandidates = masterData[5] || [];
    } else if (toTier === 7) {
      safeIsland = getBestMatch(rawIsland, t7Islands, true);
      fromCandidates = masterData[6] || [];
    } else {
      safeIsland = getBestMatch(rawIsland, islands, false);
      if (toTier === "mat" || toTier === "coin") fromCandidates = allItems;
      else if (toTier > 1) fromCandidates = masterData[toTier - 1] || [];
    }
    safeIsland = canonicalizeIslandName(safeIsland);

    if (toTier === 1 && masterData[0]) fromCandidates = masterData[0];
    if (toTier === 1 && rawFrom && !masterData[0]) safeFrom = rawFrom;
    else {
      const fromMatch = getSafeUniqueItemMatch(rawFrom, fromCandidates);
      safeFrom = fromMatch.value;
      if (!safeFrom) {
        rejectedCount++; reviewCount++;
        outcomes.push({ index, status: fromMatch.status === "ambiguous" ? "ambiguous" : "unmatched", field: "fromItem", candidates: fromMatch.candidates || [] });
        return;
      }
    }

    const trade = {
      island: safeIsland, fromItem: safeFrom, toItem: safeTo,
      reqAmount: parseInt(String(nt.reqAmount).replace(/[^0-9]/g, "")) || 1,
      count: parseInt(String(nt.count).replace(/[^0-9]/g, "")) || 0,
      yield: rowYield,
    };
    const sameIsland = (row) => !row.deleted && canonicalizeIslandName(row.island) === safeIsland;
    const sameValue = (left, right) => String(left || "").replace(/\s+/g, "") === String(right || "").replace(/\s+/g, "");
    const existing = trades.find(sameIsland);
    if (existing) {
      const isExactDuplicate = sameValue(existing.fromItem, trade.fromItem)
        && sameValue(existing.toItem, trade.toItem)
        && Number(existing.reqAmount ?? 1) === trade.reqAmount
        && Number(existing.count ?? 0) === trade.count
        && Number(existing.yield) === trade.yield;
      if (isExactDuplicate) {
        duplicateCount++;
        outcomes.push({ index, status: "duplicate" });
      } else {
        rejectedCount++; conflictCount++;
        outcomes.push({ index, status: "conflict" });
      }
      return;
    }
    trades.push(trade);
    addedCount++;
    outcomes.push({ index, status: "accepted", trade });
  });
  return { trades, addedCount, rejectedCount, conflictCount, reviewCount, duplicateCount, outcomes };
}
