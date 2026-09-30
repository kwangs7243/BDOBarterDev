import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditTradeCatalog,
  semanticAuditSha256,
} from "../tools/audit_trade_catalog.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceSha256 = "a".repeat(64);
const options = { sourceRevision: "r001-test-revision", sourceSha256 };
const emptyCatalog = () => ({
  masterData: Object.fromEntries(["1", "2", "3", "4", "5", "6", "7"].map((tier) => [tier, []])),
  specialItems: [],
  islands: [],
  t6Islands: [],
  t7Islands: [],
});
const pointerValue = (catalog, locator) => locator.split("/").slice(1).reduce((value, segment) => value[segment], catalog);
const finding = (audit, type) => audit.findings.filter((item) => item.type === type);

// A valid empty source is still a valid and deterministic audit.
const empty = emptyCatalog();
const emptyAudit = auditTradeCatalog(empty, options);
assert.deepEqual(emptyAudit.counts, {
  sourceEntries: 0,
  masterItems: 0,
  masterItemsByTier: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 },
  specialItems: 0,
  generalIslands: 0,
  t6IslandEntries: 0,
  t7IslandEntries: 0,
  exactDuplicateGroups: 0,
  whitespaceCollisionGroups: 0,
  crossTierRepeatGroups: 0,
  islandScopeOverlapGroups: 0,
  nearNameCandidatePairs: 0,
  invalidEntries: 0,
});
assert.equal(emptyAudit.schemaVersion, 1);

const synthetic = emptyCatalog();
synthetic.masterData["1"] = ["해모 섬", "해모섬", "중복", "중복", "알파 항구", "알파 함구", "aaaa", "abbb"];
synthetic.masterData["2"] = ["중복"];
synthetic.islands = ["중첩 섬", "긴 이름 항구"];
synthetic.t6Islands = ["중첩 섬", "긴 이름 항구"];
synthetic.t7Islands = ["중첩 섬", "긴이름 항구"];
const before = structuredClone(synthetic);
const audit = auditTradeCatalog(synthetic, options);
assert.deepEqual(synthetic, before, "input must not be mutated");
assert.deepEqual(audit, auditTradeCatalog(synthetic, options), "same input yields identical output");
assert.equal(semanticAuditSha256(audit), semanticAuditSha256(auditTradeCatalog(synthetic, options)));

assert.equal(audit.entries.length, 15);
assert.equal(new Set(audit.entries.map((entry) => entry.locator)).size, audit.entries.length);
for (const entry of audit.entries) {
  assert.equal(pointerValue(synthetic, entry.locator), entry.raw, `round trip ${entry.locator}`);
  assert.equal(entry.provenanceStatus, "LEGACY_UNVERIFIED");
  assert.equal(Object.hasOwn(entry, "stableId"), false);
  assert.equal(Object.hasOwn(entry, "alias"), false);
}
assert.deepEqual(audit.entries[0], {
  locator: "/islands/0", raw: "중첩 섬", kind: "ISLAND", tier: null,
  scope: "GENERAL_ISLANDS", provenanceStatus: "LEGACY_UNVERIFIED",
});
assert.equal(audit.counts.sourceEntries, 15);
assert.equal(audit.counts.masterItems, 9);
assert.deepEqual(audit.counts.masterItemsByTier, { 1: 8, 2: 1, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 });
assert.equal(audit.counts.specialItems, 0);
assert.equal(audit.counts.generalIslands, 2);
assert.equal(audit.counts.t6IslandEntries, 2);
assert.equal(audit.counts.t7IslandEntries, 2);

const exact = finding(audit, "EXACT_DUPLICATE");
assert.equal(exact.length, 1);
assert.deepEqual(exact[0].locators, ["/masterData/1/2", "/masterData/1/3"]);
assert.equal(exact[0].rawKey, "중복");
assert.equal(exact[0].severity, "REVIEW_REQUIRED");

const whitespace = finding(audit, "WHITESPACE_NORMALIZED_COLLISION");
assert.equal(whitespace.length, 2);
const itemWhitespace = whitespace.find((item) => item.scopes.includes("MASTER_TIER_1"));
assert.deepEqual(itemWhitespace.locators, ["/masterData/1/0", "/masterData/1/1"]);
assert.equal(itemWhitespace.normalizedKey, "해모섬");
assert.equal(itemWhitespace.rawValues[0], "해모 섬");
assert.equal(itemWhitespace.rawValues[1], "해모섬");
assert.equal(itemWhitespace.type, "WHITESPACE_NORMALIZED_COLLISION");

assert.equal(finding(audit, "CROSS_TIER_NAME_REPEAT").length, 1);
assert.deepEqual(finding(audit, "CROSS_TIER_NAME_REPEAT")[0].locators, ["/masterData/1/2", "/masterData/1/3", "/masterData/2/0"]);
const overlaps = finding(audit, "ISLAND_SCOPE_OVERLAP");
assert.equal(overlaps.length, 2);
assert(overlaps.every((item) => item.severity === "INFO"));
assert(overlaps.some((item) => item.rawKey === "중첩 섬" && item.scopes.length === 3));

const near = finding(audit, "NEAR_NAME_CANDIDATE");
assert(near.some((item) => item.leftRaw === "알파 항구" && item.rightRaw === "알파 함구"));
assert(near.every((item) => item.distance >= 1 && item.distance <= 3 && item.similarity >= 0.75));
assert(near.every((item) => item.diagnosticOnly === true));
assert(near.every((item) => item.scopeRelation !== "CROSS_SCOPE" || item.severity === "SCHEMA_AUTHORITY_REVIEW"));
assert(near.every((item) => item.scopeRelation !== "SAME_SCOPE" || item.severity === "INFO"));
assert(!near.some((item) => item.leftRaw === "aaaa" && item.rightRaw === "abbb"), "below-bound pair must not be emitted");
assert.equal(audit.counts.exactDuplicateGroups, exact.length);
assert.equal(audit.counts.whitespaceCollisionGroups, whitespace.length);
assert.equal(audit.counts.crossTierRepeatGroups, 1);
assert.equal(audit.counts.islandScopeOverlapGroups, overlaps.length);
assert.equal(audit.counts.nearNameCandidatePairs, near.length);
assert.equal(audit.findings.map((item) => `${item.type}\0${item.leftLocator ?? item.locators?.[0] ?? ""}\0${item.rightLocator ?? item.locators?.[1] ?? ""}`).join("\n"),
  [...audit.findings].map((item) => `${item.type}\0${item.leftLocator ?? item.locators?.[0] ?? ""}\0${item.rightLocator ?? item.locators?.[1] ?? ""}`).sort().join("\n"),
  "findings use deterministic lexical order");

const invalidCatalogs = [];
invalidCatalogs.push(["null catalog", null]);
invalidCatalogs.push(["masterData missing", (() => { const value = emptyCatalog(); delete value.masterData; return value; })()]);
invalidCatalogs.push(["masterData not object", { ...emptyCatalog(), masterData: [] }]);
invalidCatalogs.push(["tier missing", (() => { const value = emptyCatalog(); delete value.masterData["4"]; return value; })()]);
invalidCatalogs.push(["unexpected tier", (() => { const value = emptyCatalog(); value.masterData["8"] = []; return value; })()]);
invalidCatalogs.push(["tier non-array", (() => { const value = emptyCatalog(); value.masterData["3"] = {}; return value; })()]);
invalidCatalogs.push(["specialItems missing", (() => { const value = emptyCatalog(); delete value.specialItems; return value; })()]);
invalidCatalogs.push(["specialItems non-array", { ...emptyCatalog(), specialItems: {} }]);
invalidCatalogs.push(["islands missing", (() => { const value = emptyCatalog(); delete value.islands; return value; })()]);
invalidCatalogs.push(["islands non-array", { ...emptyCatalog(), islands: {} }]);
invalidCatalogs.push(["t6Islands missing", (() => { const value = emptyCatalog(); delete value.t6Islands; return value; })()]);
invalidCatalogs.push(["t6Islands non-array", { ...emptyCatalog(), t6Islands: {} }]);
invalidCatalogs.push(["t7Islands missing", (() => { const value = emptyCatalog(); delete value.t7Islands; return value; })()]);
invalidCatalogs.push(["t7Islands non-array", { ...emptyCatalog(), t7Islands: {} }]);
invalidCatalogs.push(["non-string entry", (() => { const value = emptyCatalog(); value.specialItems = [7]; return value; })()]);
invalidCatalogs.push(["empty entry", (() => { const value = emptyCatalog(); value.islands = [""]; return value; })()]);
invalidCatalogs.push(["whitespace-only entry", (() => { const value = emptyCatalog(); value.islands = ["  "]; return value; })()]);
invalidCatalogs.push(["unexpected top-level key", { ...emptyCatalog(), metadata: {} }]);
for (const [label, value] of invalidCatalogs) assert.throws(() => auditTradeCatalog(value, options), TypeError, label);
assert.throws(() => auditTradeCatalog(emptyCatalog(), { ...options, sourceSha256: "bad" }), /sourceSha256/);
assert.throws(() => auditTradeCatalog(emptyCatalog(), { ...options, sourceRevision: " " }), /sourceRevision/);

// The current production catalog is audited from its bytes without importer execution.
const realCatalogPath = resolve(root, "local_app/frontend/data/trade-catalog.json");
const sourceBytes = await readFile(realCatalogPath);
const realCatalog = JSON.parse(sourceBytes.toString("utf8"));
const realSourceHash = (await import("node:crypto")).createHash("sha256").update(sourceBytes).digest("hex");
const realAudit = auditTradeCatalog(realCatalog, { sourceRevision: "test-source-revision", sourceSha256: realSourceHash });
assert.equal(realAudit.entries.length, realAudit.counts.sourceEntries);
assert(realAudit.entries.length > 0);
for (const entry of realAudit.entries) assert.equal(pointerValue(realCatalog, entry.locator), entry.raw);

const repoRoot = resolve(root, "..");
const cliPath = resolve(root, "local_app/tools/audit_trade_catalog.mjs");
const catalogRelativePath = "_dev/local_app/frontend/data/trade-catalog.json";
const runCli = (input, output) => spawnSync(process.execPath, [
  cliPath,
  "--input", input,
  "--out", output,
  "--source-revision", "r001-overwrite-guard-test",
], { cwd: repoRoot, encoding: "utf8" });
const samePath = runCli(catalogRelativePath, catalogRelativePath);
assert.notEqual(samePath.status, 0);
assert.match(samePath.stderr, /must not overwrite the input source/);
const protectedPath = runCli("_dev/local_app/tests/trade_catalog_audit_regression.mjs", catalogRelativePath);
assert.notEqual(protectedPath.status, 0);
assert.match(protectedPath.stderr, /protected trade catalog source/);

console.log(`PASS trade_catalog_audit_regression: ${invalidCatalogs.length} invalid shapes; synthetic ${audit.entries.length} entries; real catalog ${realAudit.entries.length} entries`);
