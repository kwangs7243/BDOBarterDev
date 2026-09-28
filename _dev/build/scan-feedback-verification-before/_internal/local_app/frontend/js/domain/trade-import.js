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

export function getSafeUniqueItemMatch(target, candidates) {
  const normalizedTarget = String(target || "").replace(/\s+/g, "");
  if (!normalizedTarget) return { value: "", status: "unmatched" };
  const uniqueCandidates = [...new Set((candidates || []).filter(Boolean))];
  const exact = uniqueCandidates.find((candidate) => candidate.replace(/\s+/g, "") === normalizedTarget);
  if (exact) return { value: exact, status: "exact", distance: 0 };
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
    if ((masterData[tier] || []).some((name) => name === cleanName)) return tier;
  }
  if (cleanName.includes("진주 결정") || cleanName.includes("암염 주괴") || cleanName.includes("코발트 주괴") || cleanName.includes("오킬루아의 꽃") || cleanName.includes("파도의 블랙스톤") || cleanName.includes("대양의 견고한 현철") || cleanName.includes("유실된 무역품 상자") || cleanName.includes("흑수정 장식 팔찌")) return "mat";
  if (cleanName.includes(specialItems[8])) return "coin";
  return 0;
}

export function processParsedTrades(newTrades, existingTrades, catalog) {
  const { masterData, specialItems, islands, t6Islands, t7Islands } = catalog;
  const masterItems = [];
  for (let tier = 1; tier <= 7; tier++) masterItems.push(...(masterData[tier] || []));
  const allItems = [...masterItems, ...specialItems];
  const trades = (existingTrades || []).map((trade) => ({ ...trade }));
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
    const rawIsland = String(nt.island || "").trim();
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

    // 0→1 교환의 육지 재료는 마스터 품목 목록에 없으므로 원문 이름을 그대로 보존합니다.
    if (toTier === 1 && rawFrom) safeFrom = rawFrom;
    else {
      const fromMatch = getSafeUniqueItemMatch(rawFrom, fromCandidates);
      safeFrom = fromMatch.value;
      if (!safeFrom) {
        rejectedCount++; reviewCount++;
        outcomes.push({ index, status: fromMatch.status === "ambiguous" ? "ambiguous" : "unmatched", field: "fromItem", candidates: fromMatch.candidates || [] });
        return;
      }
    }

    const sameIslandAndOutput = (trade) => !trade.deleted && String(trade.island || "").trim() === safeIsland && String(trade.toItem || "").replace(/\s+/g, "") === safeTo.replace(/\s+/g, "");
    const isDuplicate = trades.some((trade) => sameIslandAndOutput(trade) && String(trade.fromItem || "").replace(/\s+/g, "") === safeFrom.replace(/\s+/g, ""));
    const hasInputConflict = trades.some((trade) => sameIslandAndOutput(trade) && String(trade.fromItem || "").replace(/\s+/g, "") !== safeFrom.replace(/\s+/g, ""));
    if (hasInputConflict) {
      rejectedCount++; conflictCount++;
      outcomes.push({ index, status: "conflict" });
      return;
    }
    if (isDuplicate) {
      duplicateCount++;
      outcomes.push({ index, status: "duplicate" });
      return;
    }
    const trade = {
      island: safeIsland, fromItem: safeFrom, toItem: safeTo,
      reqAmount: parseInt(String(nt.reqAmount).replace(/[^0-9]/g, "")) || 1,
      count: parseInt(String(nt.count).replace(/[^0-9]/g, "")) || 0,
      yield: rowYield,
    };
    trades.push(trade);
    addedCount++;
    outcomes.push({ index, status: "accepted", trade });
  });
  return { trades, addedCount, rejectedCount, conflictCount, reviewCount, duplicateCount, outcomes };
}
