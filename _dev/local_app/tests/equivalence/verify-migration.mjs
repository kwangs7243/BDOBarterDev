import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { findFunctionDefinitions, findVariableDeclaration, normalizeFunctionBody, sha256 } from "./source-tools.mjs";

const root = resolve(import.meta.dirname, "../../..");
const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, "baseline-manifest.json"), "utf8"));
const spec000 = JSON.parse(await readFile(resolve(root, "specs/000-baseline/baseline-manifest.json"), "utf8"));
const reference = await readFile(resolve(root, "BDO_물교_v1.0.html"), "utf8");
assert.equal(sha256(reference), manifest.sourceSha256, "reference HTML changed after baseline capture");
const protectedFiles = [
  [spec000.warehouseScanner.path, spec000.warehouseScanner.sha256],
  [spec000.referenceData.itemsPath, spec000.referenceData.itemsSha256],
  [spec000.referenceData.checksumsPath, spec000.referenceData.checksumsSha256],
  ...spec000.regressionFixtures.map((fixture) => [fixture.path, fixture.sha256]),
];
for (const [path, expected] of protectedFiles) assert.equal(sha256(await readFile(resolve(root, path)), "hex"), expected.toLowerCase(), `${path}: SPEC-000 hash mismatch`);
const files = ["constants.js", "scheduler.js", "tier7.js", "routing.js", "schedule-edit.js", "completion.js", "timer-ui.js", "scheduler-runtime.js"];
const migrated = await Promise.all(files.map((file) => readFile(resolve(root, "local_app/frontend/js/domain", file), "utf8")));
const allMigrated = migrated.join("\n");
for (const expected of manifest.definitions) {
  const defs = findFunctionDefinitions(allMigrated, expected.name);
  assert.ok(defs.length, `${expected.name}: missing in migrated domain files`);
  const hashes = defs.map((definition) => sha256(normalizeFunctionBody(definition.body)));
  assert.ok(hashes.includes(expected.bodyNormalizedSha256), `${expected.name}: original normalized body hash missing`);
}
const constants = await readFile(resolve(root, "local_app/frontend/js/domain/constants.js"), "utf8");
for (const expected of manifest.constants) {
  const actual = findVariableDeclaration(constants, expected.name);
  assert.equal(sha256(actual.source), expected.sourceSha256, `${expected.name}: constant source hash mismatch`);
}
const timerUi = migrated[6];
const tickStart = timerUi.indexOf("// ⏱️ 전역 타이머 틱 (1초마다 무한 루프)");
const tickEnd = timerUi.indexOf("}, 1000);", tickStart);
assert.ok(tickStart >= 0 && tickEnd > tickStart, "timer tick block missing");
assert.equal(sha256(timerUi.slice(tickStart, tickEnd + "}, 1000);".length).trim()), manifest.timerTick.sha256, "timer tick block hash mismatch");
for (const region of manifest.protectedRegions) {
  const start = reference.indexOf(region.start);
  const end = reference.indexOf(region.endExclusive, start);
  assert.equal(sha256(reference.slice(start, end)), region.sha256, `${region.id}: protected region hash mismatch`);
}
console.log(JSON.stringify({ ok: true, sourceSha256: manifest.sourceSha256, protectedFunctions: manifest.definitions.length, constants: manifest.constants.length, timerTick: true, protectedRegions: manifest.protectedRegions.length, protectedFiles: protectedFiles.length }, null, 2));
