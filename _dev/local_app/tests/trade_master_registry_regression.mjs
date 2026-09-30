import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adaptLegacyCatalog,
  registrySnapshotSha256,
  validateRegistrySnapshot,
} from "../frontend/js/domain/trade-master-registry.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const digest = (text) => createHash("sha256").update(text).digest("hex");
const sourceSha256 = "a".repeat(64);
const options = { sourceRevision: "r002-regression-v1", sourceSha256 };
const emptyCatalog = () => ({
  masterData: Object.fromEntries(["1", "2", "3", "4", "5", "6", "7"].map((tier) => [tier, []])),
  specialItems: [], islands: [], t6Islands: [], t7Islands: [],
});
const catalog = emptyCatalog();
catalog.masterData["1"] = ["tier-one", "cross-tier"];
catalog.masterData["2"] = ["cross-tier"];
catalog.islands = ["하코번 섬", "일리야"];
catalog.t6Islands = ["하코번 섬", "하코번"];
catalog.t7Islands = ["일리야 섬"];
const ref = (rawName, ...expectedLocators) => ({ rawName, expectedLocators });
const entity = (stableId, kind, legacyNames = [], extra = {}) => ({
  stableId, kind, canonicalName: null, status: "LEGACY_UNVERIFIED", legacyNames,
  displayNames: [], aliases: [], provenance: { evidenceRefs: [], note: null }, replacedBy: null,
  ...extra,
});
const mappings = (...entities) => ({ schemaVersion: 1, mappingRevision: "test-curation-v1", entities });
const build = (input = catalog, curatedMappings = null) => adaptLegacyCatalog(input, { ...options, curatedMappings });
const findName = (snapshot, rawName, kind = "ISLAND", tier = null) => snapshot.legacyNames.find((name) => name.rawName === rawName && name.kind === kind && name.tier === tier);

// Legacy-only adaptation keeps source facts and does not issue entity identity.
const beforeCatalog = structuredClone(catalog);
const legacyOnly = build(catalog);
assert.deepEqual(catalog, beforeCatalog, "catalog input must not be mutated");
assert.equal(validateRegistrySnapshot(legacyOnly).ok, true);
assert.equal(legacyOnly.entities.length, 0);
assert.equal(legacyOnly.legacyNames.every((name) => name.stableId === null && name.authorityStatus === "LEGACY_UNVERIFIED"), true);
assert.equal(legacyOnly.unresolvedMappings.length, legacyOnly.legacyNames.length);
assert.equal(legacyOnly.legacyNames.reduce((sum, name) => sum + name.occurrences.length, 0), 8);
assert.equal(Object.isFrozen(legacyOnly) && Object.isFrozen(legacyOnly.legacyNames[0].occurrences[0]), true, "snapshot must be deeply frozen");
assert.notEqual(findName(legacyOnly, "하코번 섬").legacyNameKey, "하코번 섬");
assert.match(findName(legacyOnly, "하코번 섬").legacyNameKey, /^legacy-name:v1:/);
assert.notEqual(findName(legacyOnly, "하코번 섬").legacyNameKey, findName(legacyOnly, "하코번").legacyNameKey, "near names remain distinct records");
assert.notEqual(findName(legacyOnly, "일리야").legacyNameKey, findName(legacyOnly, "일리야 섬").legacyNameKey, "near names remain distinct records");
assert.equal(findName(legacyOnly, "하코번 섬").occurrences.length, 2);
assert.deepEqual(findName(legacyOnly, "하코번 섬").occurrences.map((item) => item.locator), ["/islands/0", "/t6Islands/0"]);
assert.notEqual(findName(legacyOnly, "cross-tier", "MASTER_ITEM", 1).legacyNameKey, findName(legacyOnly, "cross-tier", "MASTER_ITEM", 2).legacyNameKey);

// Similar names can be deliberately curated to one ID or to distinct IDs; spelling has no authority.
const sameIdInput = mappings(entity("opaque-island-id", "ISLAND", [
  ref("하코번 섬", "/islands/0", "/t6Islands/0"), ref("하코번", "/t6Islands/1"),
]));
const sameIdBefore = structuredClone(sameIdInput);
const sameId = build(catalog, sameIdInput);
assert.deepEqual(sameIdInput, sameIdBefore, "curated input must not be mutated");
assert.equal(sameId.entities.length, 1);
assert.equal(sameId.curation.revision, "test-curation-v1");
assert.equal(sameId.entities[0].legacyNameKeys.length, 2);
assert.equal(sameId.compatibilityMappings[0].legacyNameKeys.length, 2);
assert.equal(findName(sameId, "하코번 섬").stableId, "opaque-island-id");
assert.equal(validateRegistrySnapshot(sameId).ok, true);
const distinctId = build(catalog, mappings(
  entity("island-a", "ISLAND", [ref("하코번 섬", "/islands/0", "/t6Islands/0")]),
  entity("island-b", "ISLAND", [ref("하코번", "/t6Islands/1")]),
));
assert.equal(distinctId.entities.length, 2);
assert.notEqual(findName(distinctId, "하코번 섬").stableId, findName(distinctId, "하코번").stableId);

// Mapping selector and authority failures are rejected instead of silently remapped.
assert.throws(() => build(catalog, mappings(
  entity("stable-a", "ISLAND", [ref("하코번", "/t6Islands/1")]),
  entity("stable-b", "ISLAND", [ref("하코번", "/t6Islands/1")]),
)), /conflicting stableId mapping/);
assert.throws(() => build(catalog, mappings(entity("missing", "ISLAND", [ref("ghost", "/ghost/0")]))), /nonexistent locator/);
assert.throws(() => build(catalog, mappings(entity("raw-mismatch", "ISLAND", [ref("wrong", "/t6Islands/1")]))), /rawName mismatch/);
assert.throws(() => build(catalog, mappings(entity("kind-mismatch", "MASTER_ITEM", [ref("하코번", "/t6Islands/1")]))), /kind mismatch/);
assert.throws(() => build(catalog, mappings(
  entity("duplicate", "ISLAND"), entity("duplicate", "ISLAND", [], { canonicalName: "conflict" }),
)), /duplicate stableId definition/);
assert.throws(() => build(catalog, mappings(entity("cross-tier", "MASTER_ITEM", [
  ref("cross-tier", "/masterData/1/1"), ref("cross-tier", "/masterData/2/0"),
]))), /across tiers/);
assert.throws(() => build(catalog, mappings(entity("partial-island", "ISLAND", [ref("하코번 섬", "/islands/0")]))), /every occurrence/);

// Island scopes can be explicitly mapped together; display evidence remains separate from canonical text.
const lifecycle = build(catalog, mappings(
  entity("island-verified", "ISLAND", [ref("하코번 섬", "/islands/0", "/t6Islands/0")], {
    canonicalName: "Curated canonical", status: "VERIFIED",
    displayNames: [{ text: "Observed display A", status: "LEGACY_UNVERIFIED", provenance: { evidenceRefs: ["capture:1"], note: "observation" } }],
    aliases: [{ text: "Unverified alias", status: "DISPUTED", provenance: { evidenceRefs: [], note: null } }],
  }),
  entity("old-id", "ISLAND", [], { status: "DEPRECATED", replacedBy: "new-id" }),
  entity("new-id", "ISLAND", [], { status: "DISPUTED" }),
));
assert.equal(validateRegistrySnapshot(lifecycle).ok, true);
assert.equal(lifecycle.entities.find((item) => item.stableId === "island-verified").displayNames[0].text, "Observed display A");
assert.equal(lifecycle.entities.find((item) => item.stableId === "island-verified").canonicalName, "Curated canonical");
assert.equal(lifecycle.entities.find((item) => item.stableId === "old-id").replacedBy, "new-id");
for (const status of ["LEGACY_UNVERIFIED", "VERIFIED", "DISPUTED", "DEPRECATED"]) {
  const statusEntity = entity(`status-${status}`, "ISLAND", [], { status, canonicalName: status === "VERIFIED" ? "verified" : null });
  assert.equal(validateRegistrySnapshot(build(catalog, mappings(statusEntity))).ok, true, `${status} is valid`);
}
assert.throws(() => build(catalog, mappings(entity("unknown-status", "ISLAND", [], { status: "UNKNOWN" }))), /lifecycle/);
assert.throws(() => build(catalog, mappings(entity("bad-self", "ISLAND", [], { replacedBy: "bad-self" }))), /replace itself/);
assert.throws(() => build(catalog, mappings(
  entity("cycle-a", "ISLAND", [], { replacedBy: "cycle-b" }), entity("cycle-b", "ISLAND", [], { replacedBy: "cycle-a" }),
)), /cycle/);
assert.throws(() => build(catalog, mappings(entity("unknown-target", "ISLAND", [], { replacedBy: "absent" }))), /target does not exist/);

// Repeated exact input is deterministic; unknown raw material is open-world and gets no fabricated entity.
const first = build(catalog);
const second = build(catalog);
assert.deepEqual(first, second);
assert.equal(registrySnapshotSha256(first), registrySnapshotSha256(second));
assert.equal(first.registryVersion, second.registryVersion);
assert.equal(findName(first, "outside-catalog-material"), undefined);
assert.equal(first.entities.some((item) => item.stableId === "outside-catalog-material"), false);
const badSnapshot = structuredClone(first);
badSnapshot.legacyNames[0].stableId = "invented-id";
assert.equal(validateRegistrySnapshot(badSnapshot).ok, false);
const badVersion = structuredClone(first);
badVersion.registryVersion = "registry-v1:" + "0".repeat(64);
assert.equal(validateRegistrySnapshot(badVersion).ok, false);

// The actual catalog remains legacy-only: every exact source location is retained and nothing is auto-verified.
const realCatalogPath = resolve(root, "local_app/frontend/data/trade-catalog.json");
const sourceBytes = await readFile(realCatalogPath);
const sourceCatalog = JSON.parse(sourceBytes.toString("utf8"));
const real = adaptLegacyCatalog(sourceCatalog, {
  sourceRevision: "current-trade-catalog",
  sourceSha256: digest(sourceBytes),
  curatedMappings: null,
});
const sourceOccurrences = real.legacyNames.reduce((sum, name) => sum + name.occurrences.length, 0);
assert.equal(sourceOccurrences, 241);
assert.equal(real.entities.length, 0);
assert.equal(real.legacyNames.every((name) => name.stableId === null), true);
assert.equal(real.legacyNames.every((name) => name.authorityStatus === "LEGACY_UNVERIFIED"), true);
assert.equal(real.legacyNames.some((name) => name.authorityStatus === "VERIFIED"), false);
assert.equal(real.entities.reduce((sum, entityRecord) => sum + entityRecord.aliases.filter((alias) => alias.status === "VERIFIED").length, 0), 0);
assert.equal(/\b(reqAmount|count|yield)\b/.test(JSON.stringify(real)), false, "registry stores no dynamic exchange numeric fields");
const overlappingIslandNames = real.legacyNames.filter((name) => name.kind === "ISLAND" && new Set(name.occurrences.map((item) => item.scope)).size > 1);
assert.equal(overlappingIslandNames.length, 11, "R001 island scope overlaps remain represented");
assert.equal(real.unresolvedMappings.length, real.legacyNames.length);
assert.equal(validateRegistrySnapshot(real).ok, true);
assert.equal(real.registryVersion.startsWith("registry-v1:"), true);
assert.match(registrySnapshotSha256(real), /^[a-f\d]{64}$/);

const invalidCatalog = structuredClone(catalog);
invalidCatalog.masterData["8"] = [];
assert.throws(() => build(invalidCatalog), /masterData/);
assert.throws(() => adaptLegacyCatalog(catalog, { ...options, sourceRevision: " " }), /sourceRevision/);
assert.throws(() => adaptLegacyCatalog(catalog, { ...options, sourceSha256: "bad" }), /sourceSha256/);

console.log(`PASS trade_master_registry_regression: synthetic 8 occurrences; actual 241 occurrences, ${real.legacyNames.length} legacy-name records, ${overlappingIslandNames.length} island scope overlaps`);
