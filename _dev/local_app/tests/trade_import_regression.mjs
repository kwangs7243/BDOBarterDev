import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getBestMatch, getItemTier, getSafeUniqueItemMatch, parseTradeJsonText, processParsedTrades,
} from "../frontend/js/domain/trade-import.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const catalog = JSON.parse(await readFile(resolve(root, "local_app/frontend/data/trade-catalog.json"), "utf8"));
// Expected results were executed against V1 before removing the migration source.
const baseline = JSON.parse(await readFile(resolve(root, "local_app/tests/fixtures/import-expected.json"), "utf8"));
assert.deepEqual(catalog, baseline.catalog, "compatibility catalog differs from frozen baseline");

assert.equal(parseTradeJsonText("```json\n[{\"island\":\"A\"}]\n```").ok, true);
assert.equal(parseTradeJsonText("[{bad json]").kind, "json_parse");
assert.equal(parseTradeJsonText("{\"not\":\"a trade array\"}").kind, "unsupported_structure");
assert.equal(parseTradeJsonText("[null]").kind, "unsupported_structure");
assert.equal(getSafeUniqueItemMatch("갈퀴꽃씨앗주머니", catalog.masterData["1"]).value, "갈퀴 꽃 씨앗 주머니");
assert.equal(getSafeUniqueItemMatch("대상미등록품", catalog.masterData["1"]).status, "unmatched");
assert.equal(getSafeUniqueItemMatch("abcdef", ["abcdeg", "abcdeh"]).status, "ambiguous");
assert.equal(getBestMatch("소산 선착장", catalog.t7Islands, true), "소산 주둔지 선착장");
for (const [name, expected] of Object.entries(baseline.tiers)) {
  assert.equal(getItemTier(name, catalog.masterData, catalog.specialItems), expected);
}

let comparedRows = 0;
for (const fixtureName of ["KNOWN_CORRECT_SPECIAL_IMPORT_4.json", "KNOWN_YIELD_MISMATCHES_8.json", "USER_CAPTURE_20260923_74_ROWS.json"]) {
  const input = JSON.parse(await readFile(resolve(root, "local_app/tests/fixtures", fixtureName), "utf8"));
  const expected = baseline.fixtures[fixtureName];
  const actual = processParsedTrades(input, [], catalog);
  assert.deepEqual(actual.trades, expected.trades, `${fixtureName}: accepted rows differ from reference`);
  assert.equal(actual.rejectedCount, expected.rejectedCount, `${fixtureName}: held row count differs from reference`);
  comparedRows += input.length;
}

const landInput = [{ island: "베이루와 섬", fromItem: "[육지] 원문 육지품 x 2", toItem: "갈퀴 꽃 씨앗 주머니", reqAmount: 2, count: 3, yield: 1 }];
const landResult = processParsedTrades(landInput, [], catalog);
assert.equal(landResult.trades[0].fromItem, "원문 육지품");
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
