import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getBestMatch, getItemTier, getSafeUniqueItemMatch, processParsedTrades,
} from "../frontend/js/domain/trade-import.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const catalog = JSON.parse(await readFile(resolve(root, "local_app/frontend/data/trade-catalog.json"), "utf8"));
const fields = ["island", "fromItem", "reqAmount", "toItem", "count", "yield"];
const allItems = [...new Set([...Object.values(catalog.masterData).flat(), ...catalog.specialItems])];
const validTrade = (overrides = {}) => ({
  island: catalog.islands[0], fromItem: catalog.masterData["1"][0], reqAmount: 1,
  toItem: catalog.masterData["2"][0], count: 4, yield: 2, ...overrides,
});
const normalize = (row, existing = [], sourceCatalog = catalog) => processParsedTrades([row], existing, sourceCatalog);

// A-B: exact normalization takes precedence; one safe candidate may be corrected.
assert.deepEqual(getSafeUniqueItemMatch(catalog.masterData["1"][0], allItems).status, "exact");
const uniqueCorrection = getSafeUniqueItemMatch("갈퀴龘꽃 씨앗 주머니", allItems);
assert.equal(uniqueCorrection.status, "corrected");
assert.equal(uniqueCorrection.value, "갈퀴 꽃 씨앗 주머니");
const correctedTrade = normalize(validTrade({ fromItem: "코코넛", toItem: "[4단계] 갈퀴龘꽃 씨앗 주머니 x 2" }));
assert.equal(correctedTrade.outcomes[0].status, "accepted");
assert.equal(correctedTrade.trades[0].toItem, "갈퀴 꽃 씨앗 주머니");

// C-D: ambiguous and unmatched toItem candidates never enter scannedTrades.
const ambiguousCatalog = { masterData: { 1: ["abcdefX", "abcdefY"] }, specialItems: [], islands: ["섬"], t6Islands: [], t7Islands: [] };
const ambiguous = normalize({ ...validTrade(), toItem: "abcdefZ" }, [], ambiguousCatalog);
assert.equal(ambiguous.outcomes[0].status, "ambiguous");
assert.equal(ambiguous.trades.length, 0);
const unmatched = normalize({ ...validTrade(), toItem: "unlisted-output-with-no-candidate" });
assert.equal(unmatched.outcomes[0].status, "unmatched");
assert.equal(unmatched.trades.length, 0);

// E-H: fromItem candidates are selected only after toItem is canonicalized to its tier.
for (const [toTier, fromTier] of [[2, 1], [3, 2], [6, 5], [7, 6]]) {
  const row = validTrade({ toItem: catalog.masterData[String(toTier)][0], fromItem: catalog.masterData[String(fromTier)][0] });
  const result = normalize(row);
  assert.equal(result.outcomes[0].status, "accepted", `tier ${toTier} accepts a tier ${fromTier} input`);
  assert.equal(result.trades[0].fromItem, row.fromItem);
  const wrongTier = normalize({ ...row, fromItem: "not-a-real-item-outside-the-allowed-tier" });
  assert.equal(wrongTier.outcomes[0].status, "unmatched", `tier ${toTier} does not force a global item match`);
}

// I: tier-1 output resolves a registered land material after display decoration is removed.
const land = normalize(validTrade({
  toItem: catalog.masterData["1"][0], fromItem: "[육지] 코코넛 x 2", reqAmount: 2,
}));
assert.equal(land.outcomes[0].status, "accepted");
assert.equal(land.trades[0].fromItem, "코코넛");
assert.equal(normalize(validTrade({toItem:catalog.masterData[1][0],fromItem:"미등록 육지품"})).outcomes[0].status,"unmatched");

// J-K: general islands use safe nearest correction; tier 6/7 use their dedicated forced lists.
const generalIsland = catalog.islands.find((name) => /\s/.test(name));
assert.ok(generalIsland, "catalog includes an island name with whitespace");
assert.equal(getBestMatch(generalIsland.replace(/\s+/g, ""), catalog.islands, false), generalIsland);
const general = normalize(validTrade({ island: generalIsland.replace(/\s+/g, "") }));
assert.equal(general.trades[0].island, generalIsland);
let fuzzyIslandCase = null;
for (const name of catalog.islands) {
  const chars = [...name];
  for (let index = 0; index < chars.length; index += 1) {
    const changed = [...chars]; changed[index] = "龘";
    const raw = changed.join("");
    if (raw !== name && getBestMatch(raw, catalog.islands, false) === name) {
      fuzzyIslandCase = { raw, canonical: name }; break;
    }
  }
  if (fuzzyIslandCase) break;
}
assert.ok(fuzzyIslandCase, "catalog supports a bounded general-island correction case");
assert.equal(normalize(validTrade({ island: fuzzyIslandCase.raw })).trades[0].island, fuzzyIslandCase.canonical);
for (const [tier, fromTier, islandList] of [[6, 5, catalog.t6Islands], [7, 6, catalog.t7Islands]]) {
  const result = normalize(validTrade({ toItem: catalog.masterData[String(tier)][0],
    fromItem: catalog.masterData[String(fromTier)][0], island: "unreadable-island-token" }));
  assert.equal(result.outcomes[0].status, "accepted");
  assert.equal(result.trades[0].island, getBestMatch("unreadable-island-token", islandList, true));
}

// L-M: preserve legacy digit stripping and fallback; reqAmount and count are not re-derived here.
for (const [input, expected] of [[5, 5], ["요구 3개", 3], [0, 1], ["invalid", 1], [undefined, 1], ["2.5", 25]]) {
  assert.equal(normalize(validTrade({ reqAmount: input })).trades[0].reqAmount, expected);
}
for (const [input, expected] of [[4, 4], ["남은 교환 횟수 : 7회", 7], [0, 0], ["invalid", 0], [undefined, 0], ["-2", 2]]) {
  assert.equal(normalize(validTrade({ count: input })).trades[0].count, expected);
}

// N-O: a positive integer yield is accepted; zero, fractional, and non-numeric values are held.
assert.equal(normalize(validTrade({ yield: 1 })).outcomes[0].status, "accepted");
for (const value of [0, -1, 1.5, "2", null]) {
  const held = normalize(validTrade({ yield: value }));
  assert.deepEqual(held.outcomes, [{ index: 0, status: "held", field: "yield" }]);
  assert.equal(held.trades.length, 0);
}

// P-Q: duplicates are skipped; same island/output with a different input is a conflict.
const duplicate = processParsedTrades([validTrade(), validTrade()], [], catalog);
assert.deepEqual(duplicate.outcomes.map((item) => item.status), ["accepted", "duplicate"]);
assert.equal(duplicate.trades.length, 1);
const conflict = normalize(validTrade(), [{ island: catalog.islands[0], toItem: catalog.masterData["2"][0], fromItem: "different canonical input" }]);
assert.equal(conflict.outcomes[0].status, "conflict");
assert.equal(conflict.trades.length, 1, "existing row is retained on conflict");

// R-S: count retains its compatibility key but denotes remaining exchanges; accepted DTO stays six-field.
const accepted = normalize(validTrade()).trades[0];
assert.deepEqual(Object.keys(accepted).sort(), [...fields].sort());
assert.equal(accepted.count, 4);
assert.equal(getItemTier("순수한 진주 결정", catalog.masterData, catalog.specialItems), "mat");
assert.equal(getItemTier("까마귀 주화", catalog.masterData, catalog.specialItems), "coin");
for (const special of ["화려한 진주 결정", "까마귀 주화"]) {
  const result = normalize(validTrade({ toItem: special, fromItem: catalog.masterData["7"][0] }));
  assert.equal(result.outcomes[0].status, "accepted", `${special} keeps the current all-item input candidate path`);
  assert.equal(result.trades[0].fromItem, catalog.masterData["7"][0]);
}

console.log(JSON.stringify({ ok: true, cases: 19, exactUniqueAmbiguousUnmatched: true,
  tierConstrainedInputs: [2, 3, 6, 7], landMaterialPreserved: true,
  islandModes: ["general", "tier6", "tier7"], legacyAmounts: true,
  positiveYieldOnly: true, duplicateConflict: true, sixFieldKeys: fields,
  countSemantic: "remainingExchangeCount" }, null, 2));
