import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeIslandName, getBestMatch, getItemTier, getSafeUniqueItemMatch, parseTradeJsonText, processParsedTrades,
} from "../frontend/js/domain/trade-import.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const catalog = JSON.parse(await readFile(resolve(root, "local_app/frontend/data/trade-catalog.json"), "utf8"));
// Expected results were executed against V1 before removing the migration source.
const baseline = JSON.parse(await readFile(resolve(root, "local_app/tests/fixtures/import-expected.json"), "utf8"));
const correctedBaseline = structuredClone(baseline.catalog);
correctedBaseline.masterData[6] = correctedBaseline.masterData[6].map(name => name === "고급 묵양함 상자" ? "고급 묵향함" : name);
for (let tier = 1; tier <= 7; tier++) assert.deepEqual(catalog.masterData[tier], correctedBaseline.masterData[tier]);
for (const key of ["islands", "t6Islands", "t7Islands"]) {
  const canonicalBaseline = [...new Set(correctedBaseline[key].map(canonicalizeIslandName))];
  assert.deepEqual(catalog[key], canonicalBaseline, `${key} stores canonical island names only`);
}
assert.ok(baseline.catalog.specialItems.filter(name => name !== "흑수정 장식 팔찌").every((name) => catalog.specialItems.includes(name)), "unrequested special items were removed");
assert.ok(!catalog.specialItems.includes("흑수정 장식 팔찌"));

assert.equal(parseTradeJsonText("```json\n[{\"island\":\"A\"}]\n```").ok, true);
assert.equal(parseTradeJsonText("[{bad json]").kind, "json_parse");
assert.equal(parseTradeJsonText("{\"not\":\"a trade array\"}").kind, "unsupported_structure");
assert.equal(parseTradeJsonText("[null]").kind, "unsupported_structure");
assert.equal(getSafeUniqueItemMatch("갈퀴꽃씨앗주머니", catalog.masterData["1"]).value, "갈퀴 꽃 씨앗 주머니");
assert.equal(getSafeUniqueItemMatch("대상미등록품", catalog.masterData["1"]).status, "unmatched");
assert.equal(getSafeUniqueItemMatch("abcdef", ["abcdeg", "abcdeh"]).status, "ambiguous");
assert.equal(getBestMatch("소산 선착장", catalog.t7Islands, true), "소산 주둔지 선착장");
for (const [name, expected] of Object.entries(baseline.tiers)) {
  assert.equal(getItemTier(name, catalog.masterData, catalog.specialItems), name === "흑수정 장식 팔찌" ? 0 : expected);
}

let comparedRows = 0;
for (const fixtureName of ["KNOWN_CORRECT_SPECIAL_IMPORT_4.json", "KNOWN_YIELD_MISMATCHES_8.json", "USER_CAPTURE_20260923_74_ROWS.json"]) {
  const input = JSON.parse(await readFile(resolve(root, "local_app/tests/fixtures", fixtureName), "utf8"));
  const expected = baseline.fixtures[fixtureName];
  const actual = processParsedTrades(input, [], catalog);
  const addedKnownItem = actual.trades.filter((row) => row.toItem === "순수한 진주 결정");
  const unknownLand = expected.trades.filter(row => catalog.masterData[1].includes(row.toItem) && !catalog.masterData[0].includes(row.fromItem));
  assert.deepEqual(actual.trades.filter((row) => row.toItem !== "순수한 진주 결정"), expected.trades.filter(row => !unknownLand.includes(row)), `${fixtureName}: existing accepted rows differ from reference`);
  assert.equal(actual.rejectedCount, expected.rejectedCount - addedKnownItem.length + unknownLand.length, `${fixtureName}: held row count differs from reference`);
  for (const row of unknownLand) assert.ok(actual.outcomes.some(outcome => input[outcome.index].fromItem === row.fromItem && outcome.status === "unmatched"));
  if (addedKnownItem.length) assert.deepEqual(addedKnownItem, [{island:"에버딘 섬",fromItem:"해골무늬 카페트",toItem:"순수한 진주 결정",reqAmount:1,count:3,yield:1}]);
  comparedRows += input.length;
}

const landInput = [{ island: "베이루와 섬", fromItem: "[육지] 코코넛 x 2", toItem: "갈퀴 꽃 씨앗 주머니", reqAmount: 2, count: 3, yield: 1 }];
const landResult = processParsedTrades(landInput, [], catalog);
assert.equal(landResult.trades[0].fromItem, "코코넛");
assert.equal(landResult.trades[0].reqAmount, 2);
assert.equal(landResult.trades[0].count, 3);
assert.equal(landResult.trades[0].yield, 1);

const seed = JSON.parse(await readFile(resolve(root, "local_app/tests/fixtures/KNOWN_CORRECT_SPECIAL_IMPORT_4.json"), "utf8"))[0];
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
