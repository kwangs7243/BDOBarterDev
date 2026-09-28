import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  findFunctionDefinitions,
  findVariableDeclaration,
  normalizeFunctionBody,
  sha256,
  sha256Bytes,
  sha256TextEol,
} from "./source-tools.mjs";

const root = resolve(import.meta.dirname, "../../..");
const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, "baseline-manifest.json"), "utf8"));
const spec000 = JSON.parse(await readFile(resolve(root, "specs/000-baseline/baseline-manifest.json"), "utf8"));
const TEXT_HASH_BASIS = "sha256-utf8-crlf-to-lf-only";
const RAW_HASH_BASIS = "sha256-raw-bytes";

assert.equal(manifest.hashBasis.source, TEXT_HASH_BASIS, "equivalence text hash basis must be explicit");
assert.equal(manifest.hashBasis.functionBodies, TEXT_HASH_BASIS, "function hash basis must be explicit");
assert.equal(manifest.hashBasis.constantDeclarations, TEXT_HASH_BASIS, "constant hash basis must be explicit");
assert.equal(manifest.hashBasis.timerTick, TEXT_HASH_BASIS, "timer hash basis must be explicit");
assert.equal(manifest.hashBasis.protectedRegions, TEXT_HASH_BASIS, "protected-region hash basis must be explicit");
assert.equal(spec000.hashBasis.text, TEXT_HASH_BASIS, "SPEC-000 text hash basis must be explicit");
assert.equal(spec000.hashBasis.binary, RAW_HASH_BASIS, "SPEC-000 binary hash basis must remain raw bytes");

const decodeUtf8 = (bytes, label) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label}: expected valid UTF-8 text`, { cause: error });
  }
};
const hashRecord = async (record) => {
  const bytes = await readFile(resolve(root, record.path));
  if (record.hashBasis === TEXT_HASH_BASIS) return sha256TextEol(decodeUtf8(bytes, record.path));
  if (record.hashBasis === RAW_HASH_BASIS) return sha256Bytes(bytes);
  throw new Error(`${record.path}: unsupported or missing hashBasis ${record.hashBasis}`);
};

const reference = await readFile(resolve(root, manifest.source), "utf8");
assert.equal(sha256TextEol(reference), manifest.sourceSha256, "reference HTML changed beyond CRLF/LF line endings");
assert.equal(manifest.baselineSourceSha256, spec000.referenceImplementation.sha256,
  "equivalence and SPEC-000 normalized source hashes must agree");

const protectedFiles = [
  spec000.referenceImplementation,
  spec000.warehouseScanner,
  {
    path: spec000.referenceData.itemsPath,
    sha256: spec000.referenceData.itemsSha256,
    hashBasis: spec000.referenceData.itemsHashBasis,
  },
  {
    path: spec000.referenceData.checksumsPath,
    sha256: spec000.referenceData.checksumsSha256,
    hashBasis: spec000.referenceData.checksumsHashBasis,
  },
  ...spec000.regressionFixtures,
];
for (const record of protectedFiles) {
  assert.equal(await hashRecord(record), record.sha256.toLowerCase(), `${record.path}: SPEC-000 hash mismatch`);
}
assert.ok(spec000.localExcluded.some((record) => record.path === "inputs/ORIGINAL_user_backup_20260923.json"
  && record.requiredInFreshClone === false), "local user backup must remain outside fresh-clone requirements");

const files = ["constants.js", "scheduler.js", "tier7.js", "routing.js", "schedule-edit.js", "completion.js", "timer-ui.js", "scheduler-runtime.js"];
const migrated = await Promise.all(files.map((file) => readFile(resolve(root, "local_app/frontend/js/domain", file), "utf8")));
const allMigrated = migrated.join("\n");
for (const expected of manifest.definitions) {
  const defs = findFunctionDefinitions(allMigrated, expected.name);
  assert.ok(defs.length, `${expected.name}: missing in migrated domain files`);
  const hashes = defs.map((definition) => sha256(normalizeFunctionBody(definition.body)));
  assert.ok(hashes.includes(expected.bodyNormalizedSha256), `${expected.name}: original EOL-normalized body hash missing`);
}

const constants = await readFile(resolve(root, "local_app/frontend/js/domain/constants.js"), "utf8");
for (const expected of manifest.constants) {
  const actual = findVariableDeclaration(constants, expected.name);
  assert.equal(sha256TextEol(actual.source), expected.sourceSha256, `${expected.name}: constant source hash mismatch`);
}

const timerMarker = manifest.timerTick.sourceStart;
const timerEnd = "}, 1000);";
const extractTimerTick = (text) => {
  const start = text.indexOf(timerMarker);
  const end = text.indexOf(timerEnd, start);
  assert.ok(start >= 0 && end > start, "timer tick block markers missing");
  return text.slice(start, end + timerEnd.length);
};
assert.equal(sha256TextEol(extractTimerTick(migrated[6])), manifest.timerTick.sha256,
  "timer tick block changed beyond CRLF/LF line endings");

for (const region of manifest.protectedRegions) {
  assert.equal(region.hashBasis, TEXT_HASH_BASIS, `${region.id}: protected-region hash basis must be explicit`);
  const specRegion = spec000.protectedRegions.find((candidate) => candidate.id === region.id);
  assert.ok(specRegion, `${region.id}: missing corresponding SPEC-000 protected region`);
  assert.equal(specRegion.hashBasis, TEXT_HASH_BASIS, `${region.id}: SPEC-000 region hash basis must be explicit`);
  assert.equal(region.sha256, specRegion.sha256, `${region.id}: SPEC-000 and equivalence hashes differ`);
  const start = reference.indexOf(region.start);
  const end = reference.indexOf(region.endExclusive, start);
  assert.ok(start >= 0 && end > start, `${region.id}: protected region markers missing`);
  assert.equal(sha256TextEol(reference.slice(start, end)), region.sha256,
    `${region.id}: protected region changed beyond CRLF/LF line endings`);
}

console.log(JSON.stringify({
  ok: true,
  hashBasis: TEXT_HASH_BASIS,
  binaryHashBasis: RAW_HASH_BASIS,
  sourceSha256: manifest.sourceSha256,
  protectedFunctions: manifest.definitions.length,
  constants: manifest.constants.length,
  timerTick: true,
  protectedRegions: manifest.protectedRegions.length,
  protectedFiles: protectedFiles.length,
  localExcludedFixtures: spec000.localExcluded.length,
}, null, 2));
