import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adaptRegistrySnapshotV1ToMasterBundleV2,
  applyTradeMasterReferenceManifestToBundleV2,
  createMasterBundleV2,
  masterBundleContentHash,
  validateMasterBundleV2,
  validateTradeMasterReferenceManifest,
} from "../frontend/js/domain/trade-master-bundle.js";
import {
  adaptLegacyCatalog,
  registrySnapshotSha256,
  validateRegistrySnapshot,
} from "../frontend/js/domain/trade-master-registry.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = resolve(root, "frontend/js/domain/trade-master-bundle.js");
const moduleText = await readFile(modulePath, "utf8");
const exportsFound = [...moduleText.matchAll(/^export\s+function\s+(\w+)/gm)].map((match) => match[1]).sort();
assert.deepEqual(exportsFound, [
  "adaptRegistrySnapshotV1ToMasterBundleV2", "applyTradeMasterReferenceManifestToBundleV2", "createMasterBundleV2",
  "masterBundleContentHash", "validateMasterBundleV2", "validateTradeMasterReferenceManifest",
].sort());

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const catalogSha256 = "a".repeat(64);
const emptyCatalog = () => ({
  masterData: Object.fromEntries(["1", "2", "3", "4", "5", "6", "7"].map((tier) => [tier, []])),
  specialItems: [], islands: [], t6Islands: [], t7Islands: [],
});
const ref = (rawName, ...expectedLocators) => ({ rawName, expectedLocators });
const curatedEntity = (stableId, kind, legacyNames = [], extra = {}) => ({
  stableId,
  kind,
  canonicalName: null,
  status: "LEGACY_UNVERIFIED",
  legacyNames,
  displayNames: [],
  aliases: [],
  provenance: { evidenceRefs: [], note: null },
  replacedBy: null,
  ...extra,
});
const mappings = (...entities) => ({ schemaVersion: 1, mappingRevision: "m1-synthetic-v1", entities });

const curationCatalog = emptyCatalog();
curationCatalog.masterData["1"] = ["현재 항목"];
curationCatalog.specialItems = ["특수 항목"];
curationCatalog.islands = ["검수된 섬", "미연결 섬"];
curationCatalog.t6Islands = ["검수된 섬"];
const curationV1 = adaptLegacyCatalog(curationCatalog, {
  sourceRevision: "m1-curation-fixture-v1",
  sourceSha256: catalogSha256,
  curatedMappings: mappings(
    curatedEntity("opaque-item-001", "MASTER_ITEM", [ref("현재 항목", "/masterData/1/0")], {
      canonicalName: "내부 대표명",
      status: "VERIFIED",
      displayNames: [{ text: "게임 표시명", status: "VERIFIED", provenance: { evidenceRefs: ["owner:display"], note: null } }],
      aliases: [{ text: "이전 표기", status: "VERIFIED", provenance: { evidenceRefs: ["owner:alias"], note: "owner-approved in v1" } }],
    }),
    curatedEntity("opaque-special-002", "SPECIAL_ITEM", [ref("특수 항목", "/specialItems/0")]),
    curatedEntity("opaque-island-003", "ISLAND", [ref("검수된 섬", "/islands/0", "/t6Islands/0")], {
      canonicalName: "검수 섬 대표명", status: "VERIFIED",
    }),
    curatedEntity("retired-004", "ISLAND", [], { status: "DEPRECATED", replacedBy: "replacement-005" }),
    curatedEntity("replacement-005", "ISLAND", [], { status: "DISPUTED" }),
  ),
});
assert.equal(validateRegistrySnapshot(curationV1).ok, true);

const curationV2 = adaptRegistrySnapshotV1ToMasterBundleV2(curationV1, { createdAt: "2026-10-01T00:00:00.000Z" });
assert.equal(validateMasterBundleV2(curationV2).ok, true);
assert.equal(curationV2.entities.length, 5);
assert.equal(curationV2.entities.find((entity) => entity.stableId === "opaque-item-001").stableId, "opaque-item-001");
assert.equal(curationV2.entities.find((entity) => entity.stableId === "opaque-item-001").kind, "ITEM");
assert.equal(curationV2.entities.find((entity) => entity.stableId === "opaque-item-001").tier, 1);
assert.equal(curationV2.entities.find((entity) => entity.stableId === "opaque-item-001").status, "LEGACY_UNVERIFIED");
assert.equal(curationV2.entities.find((entity) => entity.stableId === "opaque-item-001").displayNames[0].status, "LEGACY_UNVERIFIED");
assert.equal(curationV2.entities.find((entity) => entity.stableId === "opaque-item-001").aliases[0].status, "LEGACY_UNVERIFIED");
assert.equal(curationV2.entities.find((entity) => entity.stableId === "opaque-special-002").kind, "ITEM");
assert.equal(curationV2.entities.find((entity) => entity.stableId === "opaque-special-002").category, "LEGACY_SPECIAL_ITEM");
assert.equal(curationV2.entities.find((entity) => entity.stableId === "opaque-island-003").kind, "ISLAND");
assert.equal(curationV2.entities.find((entity) => entity.stableId === "opaque-island-003").status, "LEGACY_UNVERIFIED");
assert.equal(curationV2.entities.find((entity) => entity.stableId === "opaque-island-003").legacyNames[0].occurrences.length, 2);
assert.equal(curationV2.entities.find((entity) => entity.stableId === "retired-004").replacedBy, "replacement-005");
assert.equal(curationV2.unresolvedLegacyNames.length, 1);
assert.equal(curationV2.unresolvedLegacyNames[0].rawName, "미연결 섬");
assert.equal(curationV2.unresolvedLegacyNames[0].reason, "NO_CURATED_IDENTITY");
assert.equal(curationV2.unresolvedLegacyNames[0].authorityStatus, "LEGACY_UNVERIFIED");
assert.equal(curationV2.sourceRevisions[0].revision, "m1-curation-fixture-v1");
assert.equal(curationV2.provenance.sourceSnapshotSha256, registrySnapshotSha256(curationV1));
assert.equal(curationV2.compatibilityMappings.length, curationV1.compatibilityMappings.length);
assert.deepEqual(curationV2.compatibilityMappings[0], curationV1.compatibilityMappings[0]);
assert.equal(curationV2.entities.reduce((sum, entity) => sum + entity.legacyNames.reduce((n, name) => n + name.occurrences.length, 0), 0)
  + curationV2.unresolvedLegacyNames.reduce((sum, name) => sum + name.occurrences.length, 0), 5);
assert.equal(curationV2.entities.some((entity) => entity.status === "VERIFIED_CURATED"), false);
assert.equal(curationV2.entities.some((entity) => entity.displayNames.some((name) => name.status === "VERIFIED_CURATED")
  || entity.aliases.some((name) => name.status === "VERIFIED_CURATED")), false);

const sourceCatalogBytes = await readFile(resolve(root, "frontend/data/trade-catalog.json"));
const sourceCatalog = JSON.parse(sourceCatalogBytes.toString("utf8"));
const sourceSha256 = digest(sourceCatalogBytes);
assert.equal(sourceSha256, "8183b03e6aa0ee354142cf9720b401494bec365e528632f3c0c84ec11b46b4b3");
const currentV1 = adaptLegacyCatalog(sourceCatalog, {
  sourceRevision: "current-trade-catalog",
  sourceSha256,
  curatedMappings: null,
});
const currentV1RegistryHash = registrySnapshotSha256(currentV1);
assert.equal(currentV1.registryVersion, "registry-v1:945c2783ef60038074414c11747152bb17f2a9032c4e19c7a1832996bac762da");
assert.equal(currentV1RegistryHash, "e7b6b9e19db555c4549199ad71a98e7d34802f77151b3bddb0fef65a8d6e4ee4");
const currentV2 = adaptRegistrySnapshotV1ToMasterBundleV2(currentV1, { createdAt: "2026-10-01T12:00:00.000Z" });
const currentV2BeforeReferenceImport = structuredClone(currentV2);
assert.equal(validateMasterBundleV2(currentV2).ok, true);
assert.equal(currentV2.entities.length, 0);
assert.equal(currentV2.unresolvedLegacyNames.length, 230);
assert.equal(currentV2.compatibilityMappings.length, 0);
assert.equal(currentV2.unresolvedLegacyNames.reduce((sum, name) => sum + name.occurrences.length, 0), 241);
assert.equal(currentV2.unresolvedLegacyNames.every((name) => name.authorityStatus === "LEGACY_UNVERIFIED"), true);
assert.equal(currentV2.unresolvedLegacyNames.every((name) => name.reason === "NO_CURATED_IDENTITY"), true);
assert.equal(currentV2.entities.some((entity) => entity.status === "VERIFIED_CURATED"), false);
assert.equal(currentV2.entities.reduce((sum, entity) => sum + entity.aliases.filter((entry) => entry.status === "VERIFIED_CURATED").length, 0), 0);
assert.equal(/\b(reqAmount|count|yield)\b/.test(JSON.stringify(currentV2)), false);
const referenceManifest = JSON.parse(await readFile(resolve(root, "frontend/data/trade-master-reference-manifest.json"), "utf8"));
assert.equal(validateTradeMasterReferenceManifest(referenceManifest).ok, true);
assert.equal(referenceManifest.claims.length + referenceManifest.unresolved.length, 230);
assert.equal(referenceManifest.claims.some((claim) => claim.legacyNameKey === "missing"), false);
assert.equal(new Set(referenceManifest.claims.map((claim) => claim.stableId)).size, referenceManifest.claims.length);
assert.equal(referenceManifest.claims.every((claim) => /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/.test(claim.stableId)), true);
assert.equal(referenceManifest.unresolved.some((entry) => entry.status === "NOT_RESEARCHED"), false);
const referenceBundle = applyTradeMasterReferenceManifestToBundleV2(currentV2, referenceManifest, { createdAt: "2026-10-02T07:20:43Z" });
const referenceBundleAgain = applyTradeMasterReferenceManifestToBundleV2(currentV2, referenceManifest, { createdAt: "2026-10-02T07:20:43Z" });
assert.equal(validateMasterBundleV2(referenceBundle).ok, true);
assert.equal(referenceBundle.schemaVersion, 2, "VERIFIED_REFERENCE remains Bundle2-compatible");
assert.deepEqual(currentV2, currentV2BeforeReferenceImport, "reference adaptation does not mutate its source Bundle2");
assert.equal(referenceBundle.entities.filter((entity) => entity.status === "VERIFIED_REFERENCE").length, referenceManifest.claims.length);
assert.equal(referenceBundle.unresolvedLegacyNames.length, referenceManifest.unresolved.length);
assert.equal(referenceBundle.compatibilityMappings.length, referenceManifest.claims.length);
assert.equal(referenceBundle.provenance.referenceAuditHash, referenceManifest.referenceAuditHash);
assert.equal(referenceBundle.contentHash, referenceBundleAgain.contentHash, "same pinned manifest produces the same semantic Bundle2 hash");
const referenceBundleDifferentTimestamp = applyTradeMasterReferenceManifestToBundleV2(currentV2, referenceManifest,
  { createdAt: "2026-10-03T07:20:43Z" });
assert.equal(referenceBundle.contentHash, referenceBundleDifferentTimestamp.contentHash,
  "createdAt does not affect the semantic Bundle2 hash");
assert.equal(referenceBundle.entities.flatMap((entity) => entity.legacyNames).reduce((n, record) => n + record.occurrences.length, 0)
  + referenceBundle.unresolvedLegacyNames.reduce((n, record) => n + record.occurrences.length, 0), 241);
for (const mutate of [
  (candidate, entity) => { entity.canonicalName = null; },
  (candidate, entity) => { entity.provenance = {}; },
]) {
  const malformed = structuredClone(referenceBundle);
  mutate(malformed, malformed.entities.find((entity) => entity.status === "VERIFIED_REFERENCE"));
  const result = validateMasterBundleV2(malformed);
  assert.equal(result.ok, false, "VERIFIED_REFERENCE requires a canonical name and direct evidence provenance");
  assert.equal(result.errors.some((message) => message.includes("VERIFIED_REFERENCE")), true);
}
const protectedClaim = referenceManifest.claims[0];
const protectedSource = currentV2.unresolvedLegacyNames.find((record) => record.legacyNameKey === protectedClaim.legacyNameKey);
for (const status of ["VERIFIED_CURATED", "DISPUTED", "DEPRECATED"]) {
  const protectedRecord = structuredClone(protectedSource);
  delete protectedRecord.reason;
  if (status === "VERIFIED_CURATED") protectedRecord.authorityStatus = status;
  const protectedEntity = {
    stableId: `owner-preserved-${status.toLowerCase()}`,
    kind: protectedClaim.kind,
    canonicalName: "소유자 보존 이름",
    displayNames: [], aliases: [], legacyNames: [protectedRecord],
    tier: protectedClaim.kind === "ITEM" ? protectedClaim.tier : null,
    category: protectedClaim.category,
    status,
    provenance: { ownerNote: "must survive reference import" },
    replacedBy: null,
  };
  const protectedBase = createMasterBundleV2({
    createdAt: "2026-10-02T07:20:43Z",
    entities: [protectedEntity],
    compatibilityMappings: [{ stableId: protectedEntity.stableId,
      legacyNameKeys: [protectedRecord.legacyNameKey],
      sourceLocators: protectedRecord.occurrences.map((occurrence) => occurrence.locator) }],
    unresolvedLegacyNames: currentV2.unresolvedLegacyNames.filter((record) => record.legacyNameKey !== protectedRecord.legacyNameKey),
    sourceRevisions: currentV2.sourceRevisions,
    provenance: currentV2.provenance,
  });
  const protectedResult = applyTradeMasterReferenceManifestToBundleV2(protectedBase, referenceManifest,
    { createdAt: "2026-10-02T07:20:43Z" });
  const preserved = protectedResult.entities.find((entity) => entity.stableId === protectedEntity.stableId);
  assert.equal(preserved.status, status, `${status} owner state remains protected`);
  assert.equal(preserved.canonicalName, "소유자 보존 이름");
  assert.equal(protectedResult.entities.some((entity) => entity.stableId === protectedClaim.stableId), false,
    `${status} does not silently fall back to the bundled reference claim`);
}
const forgedUrl = structuredClone(referenceManifest);
forgedUrl.claims[0].evidence[0].sourceUrl = "https://example.invalid/kr/fake";
const canonicalJson = (value) => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
const manifestHash = (value) => {
  const { referenceAuditHash: _hash, ...semantic } = value;
  return createHash("sha256").update(canonicalJson(semantic), "utf8").digest("hex");
};
for (const mutate of [
  (candidate) => { candidate.claims[0].evidence[0].sourceUrl = "https://bdocodex.com/us/item/800001/"; },
  (candidate) => { candidate.claims[0].evidence[0].sourceKind = "BDOCODEX_EN"; },
  (candidate) => { candidate.claims[0].evidence[0].verifiedProperties = []; },
]) {
  const malformed = structuredClone(referenceManifest);
  mutate(malformed);
  malformed.referenceAuditHash = manifestHash(malformed);
  assert.equal(validateTradeMasterReferenceManifest(malformed).ok, false,
    "re-sealing cannot legitimize unsupported source evidence");
}
forgedUrl.referenceAuditHash = manifestHash(forgedUrl);
assert.equal(validateTradeMasterReferenceManifest(forgedUrl).ok, false, "an audit hash cannot legitimize a forged reference URL");
const duplicateGroup = structuredClone(referenceManifest);
duplicateGroup.unresolved[0].legacyNameKey = duplicateGroup.claims[0].legacyNameKey;
duplicateGroup.referenceAuditHash = manifestHash(duplicateGroup);
assert.equal(validateTradeMasterReferenceManifest(duplicateGroup).ok, false, "a source group cannot be both claimed and unresolved");
const currentOverlaps = currentV2.unresolvedLegacyNames.filter((name) => name.legacyKind === "ISLAND"
  && new Set(name.occurrences.map((occurrence) => occurrence.scope)).size > 1);
assert.equal(currentOverlaps.length, 11);

const goldenInput = {
  createdAt: "2026-10-01T12:00:00.000Z",
  entities: [{
    stableId: "opaque-unicode-01", kind: "ISLAND", canonicalName: "가", displayNames: [], aliases: [], legacyNames: [],
    tier: null, category: null, status: "LEGACY_UNVERIFIED", provenance: { evidenceRefs: [], note: "공백 포함 한글" }, replacedBy: null,
  }],
  compatibilityMappings: [],
  unresolvedLegacyNames: [],
  sourceRevisions: [{ sourceType: "TEST", revision: "test-v1", sha256: "b".repeat(64) }],
  provenance: { purpose: "golden vector", label: "한글 이름 😀" },
};
const makeBundle = (overrides = {}) => createMasterBundleV2({ ...goldenInput, ...overrides });
const golden = makeBundle();
assert.equal(validateMasterBundleV2(golden).ok, true);
assert.equal(masterBundleContentHash(golden), golden.contentHash);
assert.match(golden.registryVersion, new RegExp(`^registry-v2:${golden.contentHash}$`));
assert.equal(golden.contentHash, "8f0d11ac5b2fd05a40837cbc8f89296fb8b687e9b097129bb198526436c33868");
const canonicalForTest = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalForTest).join(",")}]`;
  const compareCodePoints = (a, b) => {
    const left = Array.from(a, (character) => character.codePointAt(0));
    const right = Array.from(b, (character) => character.codePointAt(0));
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      if (left[index] !== right[index]) return left[index] - right[index];
    }
    return left.length - right.length;
  };
  return `{${Object.keys(value).sort(compareCodePoints)
    .map((key) => `${JSON.stringify(key)}:${canonicalForTest(value[key])}`).join(",")}}`;
};
const goldenSemantic = { ...golden };
delete goldenSemantic.createdAt;
delete goldenSemantic.registryVersion;
delete goldenSemantic.contentHash;
assert.equal(golden.contentHash, digest(Buffer.from(canonicalForTest(goldenSemantic), "utf8")), "pure JS SHA-256 matches Node SHA-256 golden bytes");

const createdAtVariant = makeBundle({ createdAt: "2026-10-02T00:00:00.000Z" });
assert.equal(createdAtVariant.contentHash, golden.contentHash, "createdAt is excluded from semantic hash");
assert.equal(createdAtVariant.registryVersion, golden.registryVersion);
const keyOrderVariant = makeBundle({ provenance: { label: "한글 이름 😀", purpose: "golden vector" } });
assert.equal(keyOrderVariant.contentHash, golden.contentHash, "object key insertion order is irrelevant");
const unicodeNormalizationVariant = makeBundle({
  entities: [{ ...goldenInput.entities[0], canonicalName: "\u1100\u1161" }],
});
assert.notEqual(unicodeNormalizationVariant.contentHash, golden.contentHash, "visually equivalent Unicode byte sequences remain distinct");
assert.equal(golden.provenance.label, "한글 이름 😀");

const reorderedNestedKeys = JSON.parse(JSON.stringify(goldenInput));
reorderedNestedKeys.provenance = Object.fromEntries(Object.entries(reorderedNestedKeys.provenance).reverse());
assert.equal(makeBundle(reorderedNestedKeys).contentHash, golden.contentHash);

const inputForIsolation = structuredClone(goldenInput);
const frozenBundle = createMasterBundleV2(inputForIsolation);
inputForIsolation.entities[0].provenance.note = "mutated outside";
inputForIsolation.provenance.label = "mutated outside";
assert.equal(frozenBundle.entities[0].provenance.note, "공백 포함 한글");
assert.equal(frozenBundle.provenance.label, "한글 이름 😀");
assert.ok(Object.isFrozen(frozenBundle));
assert.ok(Object.isFrozen(frozenBundle.entities));
assert.ok(Object.isFrozen(frozenBundle.entities[0]));
assert.ok(Object.isFrozen(frozenBundle.entities[0].provenance));
assert.ok(Object.isFrozen(frozenBundle.sourceRevisions));
assert.ok(Object.isFrozen(frozenBundle.provenance));

const changedCanonical = makeBundle({ entities: [{ ...goldenInput.entities[0], canonicalName: "다른 이름" }] });
const changedProvenance = makeBundle({ provenance: { purpose: "changed", label: "한글 이름 😀" } });
const changedSourceRevision = makeBundle({ sourceRevisions: [{ ...goldenInput.sourceRevisions[0], revision: "test-v2" }] });
assert.notEqual(changedCanonical.contentHash, golden.contentHash);
assert.notEqual(changedProvenance.contentHash, golden.contentHash);
assert.notEqual(changedSourceRevision.contentHash, golden.contentHash);

const makeLegacyName = (key, rawName, tier, locator, scope, legacyKind = "MASTER_ITEM") => ({
  legacyNameKey: key, legacyKind, rawName, tier,
  occurrences: [{ locator, scope, tier }], authorityStatus: "LEGACY_UNVERIFIED",
});
const oneMappedItem = (extra = {}) => makeBundle({
  entities: [{
    stableId: "opaque-owner-id", kind: "ITEM", canonicalName: "공통 이름", displayNames: [], aliases: [],
    legacyNames: [makeLegacyName("legacy-a", "A", 1, "/masterData/1/0", "MASTER_TIER_1")],
    tier: 1, category: null, status: "LEGACY_UNVERIFIED", provenance: {}, replacedBy: null,
  }],
  compatibilityMappings: [{ stableId: "opaque-owner-id", legacyNameKeys: ["legacy-a"], sourceLocators: ["/masterData/1/0"] }],
  ...extra,
});
assert.equal(validateMasterBundleV2(oneMappedItem()).ok, true);
assert.throws(() => makeBundle({ entities: [goldenInput.entities[0], goldenInput.entities[0]] }), /duplicate/);
assert.throws(() => oneMappedItem({
  unresolvedLegacyNames: [{
    ...makeLegacyName("legacy-a", "A", 1, "/masterData/1/0", "MASTER_TIER_1"), reason: "NO_CURATED_IDENTITY",
  }],
}), /assigned to a resolved entity/, "one source identity cannot be both resolved and unresolved");
assert.throws(() => makeBundle({
  entities: [{ ...goldenInput.entities[0], replacedBy: "unknown-target" }],
}), /unknown stableId/);
assert.throws(() => makeBundle({
  entities: [{ ...goldenInput.entities[0], stableId: "self", replacedBy: "self" }],
}), /cannot reference itself/);
assert.throws(() => makeBundle({
  entities: [
    { ...goldenInput.entities[0], stableId: "cycle-a", replacedBy: "cycle-b" },
    { ...goldenInput.entities[0], stableId: "cycle-b", replacedBy: "cycle-a" },
  ],
}), /cycle/);
assert.throws(() => makeBundle({
  entities: [{
    ...oneMappedItem().entities[0],
    legacyNames: [
      makeLegacyName("tier-a", "A", 1, "/masterData/1/0", "MASTER_TIER_1"),
      makeLegacyName("tier-b", "B", 2, "/masterData/2/0", "MASTER_TIER_2"),
    ],
  }],
  compatibilityMappings: [{
    stableId: "opaque-owner-id", legacyNameKeys: ["tier-a", "tier-b"],
    sourceLocators: ["/masterData/1/0", "/masterData/2/0"],
  }],
}), /does not match entity tier|across tiers/);
assert.equal(validateMasterBundleV2(makeBundle({
  entities: [
    goldenInput.entities[0],
    { ...goldenInput.entities[0], stableId: "opaque-unicode-02" },
  ],
})).ok, true, "the schema preserves same-text collision candidates as distinct identities");
assert.equal(validateMasterBundleV2(makeBundle({
  entities: [{ ...goldenInput.entities[0], status: "VERIFIED_CURATED", canonicalName: "확정 대표명" }],
})).ok, true, "the schema supports explicit VERIFIED_CURATED input");
assert.equal(validateMasterBundleV2({ ...golden, hashBasis: "wrong" }).ok, false);
assert.throws(() => makeBundle({ provenance: { unsafe: 1.5 } }), /safe integers/);
assert.throws(() => makeBundle({ provenance: { unsafe: -0 } }), /safe integers/);
assert.throws(() => makeBundle({ provenance: { unsafe: Number.MAX_SAFE_INTEGER + 1 } }), /safe integers/);
assert.throws(() => makeBundle({ provenance: { sourcePath: "D:\\private\\catalog.json" } }), /absolute|machine|path/i);
assert.throws(() => makeBundle({
  entities: [{ ...goldenInput.entities[0], displayNames: [{ text: "표시명", status: "LEGACY_UNVERIFIED", provenance: { evidenceRefs: ["C:\\private\\evidence.png"] } }] }],
}), /absolute filesystem paths/);
assert.throws(() => createMasterBundleV2({ ...goldenInput, unexpected: true }), /exactly/);
assert.throws(() => makeBundle({ sourceRevisions: [{ ...goldenInput.sourceRevisions[0], revision: "C:\\Users\\kwang\\catalog.json" }] }), /revision|absolute|path/i);
assert.throws(() => makeBundle({ sourceRevisions: [{ ...goldenInput.sourceRevisions[0], sourceType: "D:\\private\\source" }] }), /sourceType|revision|portable/i);
assert.equal(validateMasterBundleV2({ ...golden, provenance: { invalid: Number.NaN } }).ok, false);
assert.equal(validateMasterBundleV2({ ...golden, provenance: { invalid: "\ud800" } }).ok, false);
assert.throws(() => adaptRegistrySnapshotV1ToMasterBundleV2({ ...currentV1, registryVersion: "bad" }, { createdAt: "now" }), /invalid registry snapshot v1/);
assert.throws(() => adaptRegistrySnapshotV1ToMasterBundleV2(currentV1, {}), /createdAt/);

const runtimeFiles = [
  "frontend/js/app.js", "frontend/js/trade-recognition-review.js",
  "frontend/js/domain/trade-review-projection.js", "backend/recognition_contracts.py", "backend/app.py",
];
for (const relativePath of runtimeFiles) {
  const source = await readFile(resolve(root, relativePath), "utf8");
  assert.equal(source.includes("trade-master-bundle.js"), false, `${relativePath} must not import or wire M1`);
}
const primaryRecognitionSource = await readFile(resolve(root, "frontend/js/recognition-ui.js"), "utf8");
assert.equal(primaryRecognitionSource.includes("trade-master-bundle.js"), true, "activated primary recognition pins a validated Master Bundle2");
assert.equal(primaryRecognitionSource.includes("validateMasterBundleV2"), true, "primary recognition validates the pinned Master Bundle2");

console.log(`PASS trade_master_bundle_regression: 241 occurrences, 230 source groups, ${referenceManifest.claims.length} reference claims, ${referenceManifest.unresolved.length} documented unresolved, ${currentOverlaps.length} island scope overlaps`);
