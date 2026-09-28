import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  getBestMatch, getItemTier, getSafeUniqueItemMatch, parseTradeJsonText, processParsedTrades,
} from "../frontend/js/domain/trade-import.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const catalog = JSON.parse(await readFile(resolve(root, "local_app/frontend/data/trade-catalog.json"), "utf8"));
const source = await readFile(resolve(root, "BDO_물교_v1.0.html"), "utf8");
const between = (startToken, endToken) => {
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start);
  assert.ok(start >= 0 && end > start, `reference section missing: ${startToken}`);
  return source.slice(start, end);
};
const matcherSource = between("function levenshtein(a, b)", "async function compressImage");
const tierSource = between("function getItemTier(itemName)", "function getItemWeight(tier)");
const processSource = between("function processParsedTrades(newTrades)", "// ⭐ 실시간 캡처 스튜디오");
const masterSection = between("const masterData = {", "const rawData = {");
const referenceMasterData = {};
for (let tier = 1; tier <= 7; tier++) {
  const match = masterSection.match(new RegExp(`(?:^|\\n)\\s*${tier}:\\s*\\[([\\s\\S]*?)(?=\\n\\s*[1-7]:|$)`));
  assert.ok(match, `reference masterData tier ${tier} missing`);
  referenceMasterData[String(tier)] = [...match[1].matchAll(/name:\s*"([^"]+)"/g)].map((entry) => entry[1]);
  assert.deepEqual(catalog.masterData[String(tier)], referenceMasterData[String(tier)], `catalog tier ${tier} differs from reference`);
}
const rawDataSection = between("const rawData = {", "// 메모리 DB");
const referenceIslands = [...rawDataSection.matchAll(/"([^"]+)":\s*\{/g)].map((entry) => entry[1]);
assert.deepEqual(catalog.islands, referenceIslands, "catalog island candidates differ from reference order");
const getCandidateList = (name) => [...processSource.matchAll(new RegExp(`const ${name} = \\[([^\\]]*)\\]`, "g"))][0]?.[1]?.match(/"([^"]+)"/g)?.map((value) => value.slice(1, -1));
assert.deepEqual(catalog.t6Islands, getCandidateList("t6Islands"), "6-tier island candidates differ from reference");
assert.deepEqual(catalog.t7Islands, getCandidateList("t7Islands"), "7-tier island candidates differ from reference");
const legacyMasterData = Object.fromEntries(Object.entries(referenceMasterData).map(([tier, names]) => [tier, names.map((name) => ({ name }))]));
const legacyIslands = Object.fromEntries(referenceIslands.map((name) => [name, {}]));

function runReference(rows, existing = []) {
  const warnings = [];
  const context = {
    masterData: legacyMasterData,
    islandCoordinates: legacyIslands,
    scannedTrades: existing.map((trade) => ({ ...trade })),
    console: { warn: (...args) => warnings.push(args) },
    saveScannedTradesSilent() {},
    renderTrades() {},
    showToast() {},
  };
  vm.runInNewContext(`${matcherSource}\n${tierSource}\n${processSource}\nprocessParsedTrades(input);`, { ...context, input: rows });
  return { trades: JSON.parse(JSON.stringify(context.scannedTrades)), warnings };
}

assert.equal(parseTradeJsonText("```json\n[{\"island\":\"A\"}]\n```").ok, true);
assert.equal(parseTradeJsonText("[{bad json]").kind, "json_parse");
assert.equal(parseTradeJsonText("{\"not\":\"a trade array\"}").kind, "unsupported_structure");
assert.equal(parseTradeJsonText("[null]").kind, "unsupported_structure");
assert.equal(getSafeUniqueItemMatch("갈퀴꽃씨앗주머니", catalog.masterData["1"]).value, "갈퀴 꽃 씨앗 주머니");
assert.equal(getSafeUniqueItemMatch("대상미등록품", catalog.masterData["1"]).status, "unmatched");
assert.equal(getSafeUniqueItemMatch("abcdef", ["abcdeg", "abcdeh"]).status, "ambiguous");
assert.equal(getBestMatch("소산 선착장", catalog.t7Islands, true), "소산 주둔지 선착장");
const legacyGetItemTier = new Function("masterData", `return (${tierSource.match(/function getItemTier\(itemName\)[\s\S]*?\n}/)[0]});`);
for (const name of ["순수한 진주 결정", "오킬루아의 꽃", "까마귀 주화", "비옥한 흙", "발렌시아 모래 방패"]) {
  assert.equal(getItemTier(name, referenceMasterData, catalog.specialItems), legacyGetItemTier(legacyMasterData)(name), `${name}: tier classification differs from reference`);
}

let comparedRows = 0;
for (const fixtureName of ["KNOWN_CORRECT_SPECIAL_IMPORT_4.json", "KNOWN_YIELD_MISMATCHES_8.json", "USER_CAPTURE_20260923_74_ROWS.json"]) {
  const input = JSON.parse(await readFile(resolve(root, "fixtures", fixtureName), "utf8"));
  const expected = runReference(input);
  const actual = processParsedTrades(input, [], catalog);
  assert.deepEqual(actual.trades, expected.trades, `${fixtureName}: accepted rows differ from reference`);
  assert.equal(actual.rejectedCount, expected.warnings.length, `${fixtureName}: held row count differs from reference`);
  comparedRows += input.length;
}

const landInput = [{ island: "베이루와 섬", fromItem: "[육지] 원문 육지품 x 2", toItem: "갈퀴 꽃 씨앗 주머니", reqAmount: 2, count: 3, yield: 1 }];
const landResult = processParsedTrades(landInput, [], catalog);
assert.equal(landResult.trades[0].fromItem, "원문 육지품");
assert.equal(landResult.trades[0].reqAmount, 2);
assert.equal(landResult.trades[0].count, 3);
assert.equal(landResult.trades[0].yield, 1);

const seed = JSON.parse(await readFile(resolve(root, "fixtures/KNOWN_CORRECT_SPECIAL_IMPORT_4.json"), "utf8"))[0];
const duplicate = processParsedTrades([seed, seed], [], catalog);
assert.equal(duplicate.addedCount, 1);
assert.equal(duplicate.duplicateCount, 1);
const conflictPrior = { island: seed.island, fromItem: "다른 기존 소모품", toItem: seed.toItem };
const conflict = processParsedTrades([seed], [conflictPrior], catalog);
assert.equal(conflict.conflictCount, 1);
assert.equal(conflict.trades.length, 1);
const missing = processParsedTrades([{ toItem: seed.toItem, fromItem: seed.fromItem, yield: seed.yield }], [], catalog);
assert.deepEqual(missing.outcomes, [{ index: 0, status: "held", field: "island" }]);

console.log(JSON.stringify({ ok: true, comparedRows, fixtures: 3, exactAcceptedRows: true, heldCountsMatch: true, markdownFence: true, parseAndShapeErrors: true, exactCorrection: true, ambiguousAndUnmatched: true, specialAndLandRawName: true, yieldCountReqAmount: true, duplicateConflictAndMissingField: true }, null, 2));
