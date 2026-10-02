import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptLegacyCatalog } from "../frontend/js/domain/trade-master-registry.js";
import { getSafeUniqueItemMatch } from "../frontend/js/domain/trade-import.js";
import { adaptRegistrySnapshotV1ToMasterBundleV2, applyTradeMasterReferenceManifestToBundleV2, createMasterBundleV2, masterBundleContentHash, validateMasterBundleV2 } from "../frontend/js/domain/trade-master-bundle.js";
import { buildFinalTradeProjection } from "../frontend/js/domain/trade-final-correction.js";
import { buildTradeReviewProjection } from "../frontend/js/domain/trade-review-projection.js";
import { buildTradeBatchReconciliation } from "../frontend/js/domain/trade-batch-reconciliation.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fields = (values, overrides = {}) => Object.fromEntries(["island", "fromItem", "reqAmount", "toItem", "count", "yield"].map((key) => {
  const text = values[key] ?? null;
  return [key, { rawText: text, normalizedText: text, rawNumericCandidate: null, value: null,
    status: text === null ? "EMPTY_OCR" : "RAW_OCR_CANDIDATE", reasonCodes: [], ...(overrides[key] ?? {}) }];
}));
const row = (captureId, ordinal, values, overrides = {}) => ({ captureId, ordinal, rowId: `${captureId}-r${ordinal}`,
  status: "DRAFT_UNVERIFIED", automationDecision: "REVIEW", sourceRefs: [{ captureId, ordinal, draftRowId: `${captureId}-r${ordinal}` }], fields: fields(values, overrides) });
const names = [
  ["island", "ISLAND", "아지르 섬", null, "GENERAL_ISLANDS"],
  ["input", "MASTER_ITEM", "고대 잎", 1, "MASTER_TIER_1"],
  ["output-a", "MASTER_ITEM", "산호 상자", 2, "MASTER_TIER_2"],
  ["output-b", "MASTER_ITEM", "푸른 상자", 2, "MASTER_TIER_2"],
  ["output-c", "MASTER_ITEM", "은빛 상자", 2, "MASTER_TIER_2"],
  ["output-d", "MASTER_ITEM", "금빛 상자", 2, "MASTER_TIER_2"],
];
const syntheticBundle = () => {
  const entities = names.map(([key, legacyKind, rawName, tier]) => {
    const kind = legacyKind === "ISLAND" ? "ISLAND" : "ITEM";
    return { stableId: `curated-${key}`, kind, canonicalName: rawName, displayNames: [], aliases: [],
      legacyNames: [{ legacyNameKey: `legacy-${key}`, legacyKind, rawName, tier, occurrences: [{ locator: `/synthetic/${key}`, scope: names.find((entry) => entry[0] === key)[4], tier }], authorityStatus: "VERIFIED_CURATED" }],
      tier, category: null, status: "VERIFIED_CURATED", provenance: { ownerNote: "synthetic regression fixture" }, replacedBy: null };
  });
  return createMasterBundleV2({ createdAt: "2026-10-02T00:00:00Z", entities,
    compatibilityMappings: entities.map((entity) => ({ stableId: entity.stableId, legacyNameKeys: entity.legacyNames.map((name) => name.legacyNameKey), sourceLocators: entity.legacyNames.flatMap((name) => name.occurrences.map((occurrence) => occurrence.locator)) })),
    unresolvedLegacyNames: [], sourceRevisions: [{ sourceType: "TEST", revision: "synthetic-v1", sha256: "a".repeat(64) }], provenance: { purpose: "ARCH-C1 regression" } });
};
const bundle = syntheticBundle();
assert.equal(validateMasterBundleV2(bundle).ok, true);
assert.equal(masterBundleContentHash(bundle), bundle.contentHash);
const basePolicy = { policyVersion: "correction-shadow-fixture-v1", boundedMatchPolicy: "V1_UNIQUE_BOUNDED_0.75" };
const observation = (draftRows, extras = {}) => ({ recognitionBatchId: "batch-shadow-1", draftRows, edgeSegments: [], ...extras });
const build = (draftRows, extras = {}, config = {}) => buildFinalTradeProjection({ rawObservation: observation(draftRows, extras), masterBundle: config.masterBundle ?? bundle,
  correctionPolicy: config.correctionPolicy ?? basePolicy, reconciliationPolicyVersion: config.reconciliationPolicyVersion, pixelAvailability: config.pixelAvailability });

// A real committed catalog and reference manifest are the source for runtime Bundle2 accounting.
const catalogBytes = await readFile(resolve(root, "frontend/data/trade-catalog.json"));
const catalog = JSON.parse(catalogBytes.toString("utf8"));
const catalogHash = createHash("sha256").update(catalogBytes).digest("hex");
const v1 = adaptLegacyCatalog(catalog, { sourceRevision: "current-trade-catalog", sourceSha256: catalogHash, curatedMappings: null });
const baseBundle = adaptRegistrySnapshotV1ToMasterBundleV2(v1, { createdAt: "2026-10-02T00:00:00Z" });
const manifest = JSON.parse(await readFile(resolve(root, "frontend/data/trade-master-reference-manifest.json"), "utf8"));
const referenceBundle = applyTradeMasterReferenceManifestToBundleV2(baseBundle, manifest, { createdAt: "2026-10-02T00:00:00Z" });
assert.deepEqual([referenceBundle.entities.length, referenceBundle.compatibilityMappings.length, referenceBundle.unresolvedLegacyNames.length,
  referenceBundle.entities.flatMap((entry) => entry.legacyNames).concat(referenceBundle.unresolvedLegacyNames).reduce((sum, entry) => sum + entry.occurrences.length, 0),
  referenceBundle.entities.flatMap((entry) => entry.legacyNames).concat(referenceBundle.unresolvedLegacyNames).length], [87, 87, 143, 241, 230]);

const one = row("capture-one", 1, { island: "아지르 섬", fromItem: "고대 잎", reqAmount: "수 : 10회", toItem: "[2단계] 산호 상자", count: "0회", yield: "48" });
const before = structuredClone({ one, bundle, policy: basePolicy });
const result = build([one]);
assert.deepEqual({ one, bundle, policy: basePolicy }, before, "pipeline inputs remain unchanged");
assert.equal(result.activation, "SHADOW_ONLY");
assert.equal(result.isFinalProjection3, false);
assert.equal(result.sessionCompatible, false);
assert.equal(result.masterBinding.contentHash, bundle.contentHash);
assert.equal(result.sourceRows[0].fields.toItem.selectedCandidate.value, "산호 상자");
assert.equal(result.sourceRows[0].fields.toItem.normalized.value, "산호 상자");
assert.equal(result.sourceRows[0].fields.toItem.raw.text, "[2단계] 산호 상자");
assert.equal(result.sourceRows[0].fields.reqAmount.finalValue, 10);
assert.equal(result.sourceRows[0].fields.count.finalValue, 0);
assert.equal(result.sourceRows[0].fields.yield.finalValue, 48);
assert.equal(Object.isFrozen(result) && Object.isFrozen(result.sourceRows[0].fields.toItem.stageTrace), true);
assert.deepEqual(result, build([one]), "same input is deterministic");
const reorderedRow = Object.fromEntries(Object.entries(one).reverse().map(([key, value]) => [key,
  key === "fields" ? Object.fromEntries(Object.entries(value).reverse().map(([field, evidence]) => [field, Object.fromEntries(Object.entries(evidence).reverse())])) : value]));
assert.deepEqual(result, build([reorderedRow]), "input object key insertion order does not alter semantic output");
assert.equal(masterBundleContentHash(bundle), before.bundle.contentHash, "shadow execution does not generate or mutate Master entities");

// The reference bundle is the only new correction authority; unresolved exact names remain unverified.
const referenceItems = referenceBundle.entities.filter((entity) => entity.kind === "ITEM" && entity.status === "VERIFIED_REFERENCE");
const referenceName = referenceItems[0].legacyNames[0];
const exactReference = build([row("reference", 1, { island: "아지르 섬", fromItem: "원료", reqAmount: "1", toItem: referenceName.rawName, count: "0", yield: "1" })], {}, { masterBundle: referenceBundle });
assert.equal(exactReference.sourceRows[0].fields.toItem.selectedCandidate.authorityStatus, "VERIFIED_REFERENCE");
const referenceParityRow = row("reference-parity", 1, { island: "알마이 섬", fromItem: "원료", reqAmount: "1", toItem: referenceName.rawName, count: "0", yield: "1" });
const referenceLegacyOracle = buildTradeReviewProjection({ draftRows: [referenceParityRow], registrySnapshot: v1, correctionPolicyVersion: "r003-correction-v1" }).rows[0];
const referenceShadow = build([referenceParityRow], {}, { masterBundle: referenceBundle }).sourceRows[0];
assert.equal(referenceShadow.fields.toItem.finalValue, referenceLegacyOracle.fields.toItem.candidate.value, "M4 authority upgrade keeps the observed candidate text");
assert.equal(referenceLegacyOracle.fields.toItem.candidate.stableId, null);
assert.equal(referenceShadow.fields.toItem.selectedCandidate.authorityStatus, "VERIFIED_REFERENCE");
const verifiedItemNames = referenceItems.flatMap((entity) => [entity.canonicalName, ...entity.displayNames.map((name) => name.text), ...entity.aliases.map((name) => name.text), ...entity.legacyNames.map((name) => name.rawName)]);
const referenceTypo = verifiedItemNames.map((name) => `${name.slice(0, -1)}${name.endsWith("가") ? "나" : "가"}`)
  .find((candidate, index) => candidate.length > 2 && getSafeUniqueItemMatch(candidate, verifiedItemNames).status === "corrected"
    && getSafeUniqueItemMatch(candidate, verifiedItemNames).value === verifiedItemNames[index]);
assert.ok(referenceTypo, "reference master contains a deterministic unique bounded-correction fixture");
const referenceCorrection = build([row("reference-fuzzy", 1, { island: "아지르 섬", fromItem: "원료", reqAmount: "1", toItem: referenceTypo, count: "0", yield: "1" })], {}, { masterBundle: referenceBundle });
assert.equal(referenceCorrection.sourceRows[0].fields.toItem.selectedCandidate.authorityStatus, "VERIFIED_REFERENCE");
assert.equal(referenceCorrection.sourceRows[0].fields.toItem.selectedCandidate.matchKind, "BOUNDED_UNIQUE_MATCH");
const unresolved = referenceBundle.unresolvedLegacyNames.find((entry) => entry.legacyKind !== "ISLAND");
const unresolvedExact = build([row("unresolved", 1, { island: "아지르 섬", fromItem: "원료", reqAmount: "1", toItem: unresolved.rawName, count: "0", yield: "1" })], {}, { masterBundle: referenceBundle });
assert.equal(unresolvedExact.sourceRows[0].fields.toItem.selectedCandidate.authorityStatus, "LEGACY_UNVERIFIED");
assert.equal(unresolvedExact.sourceRows[0].fields.toItem.riskReasons.some((entry) => entry.code === "MASTER_UNRESOLVED"), true);
assert.equal(unresolvedExact.sourceRows[0].fields.toItem.correctionCandidates.length, 0, "unverified exact candidate never enters bounded correction authority");
const sourceConflictFinding = referenceBundle.provenance.referenceFindings.find((entry) => entry.status === "SOURCE_CONFLICT");
assert.ok(sourceConflictFinding, "the committed M4 reference bundle retains its source conflict finding");
const sourceConflictName = referenceBundle.unresolvedLegacyNames.find((entry) => entry.legacyNameKey === sourceConflictFinding.legacyNameKey);
assert.ok(sourceConflictName);
const sourceConflictResult = build([row("source-conflict", 1, { island: "아지르 섬", fromItem: "원료", reqAmount: "1", toItem: sourceConflictName.rawName, count: "0", yield: "1" })], {}, { masterBundle: referenceBundle });
assert.equal(sourceConflictResult.sourceRows[0].fields.toItem.selectedCandidate.authorityStatus, "LEGACY_UNVERIFIED");
assert.equal(sourceConflictResult.sourceRows[0].fields.toItem.riskReasons.some((entry) => entry.code === "SOURCE_CONFLICT"), true);
const unresolvedTypo = `${unresolved.rawName.slice(0, -1)}${unresolved.rawName.endsWith("가") ? "나" : "가"}`;
const unresolvedFuzzy = build([row("unresolved-fuzzy", 1, { island: "아지르 섬", fromItem: "원료", reqAmount: "1", toItem: unresolvedTypo, count: "0", yield: "1" })], {}, { masterBundle: referenceBundle });
assert.equal(unresolvedFuzzy.sourceRows[0].fields.toItem.selectedCandidate?.authorityStatus === "LEGACY_UNVERIFIED", false,
  "unverified legacy names are excluded from fuzzy selection");

// Name status and entity lifecycle block automatic choice while keeping evidence visible.
for (const status of ["DISPUTED", "DEPRECATED"]) {
  const blocked = createMasterBundleV2({ createdAt: "2026-10-02T00:00:00Z", entities: bundle.entities.map((entity) => entity.stableId === "curated-output-a" ? { ...entity, status,
    legacyNames: entity.legacyNames.map((name) => ({ ...name, authorityStatus: status })) } : entity),
    compatibilityMappings: bundle.compatibilityMappings, unresolvedLegacyNames: [], sourceRevisions: bundle.sourceRevisions, provenance: bundle.provenance });
  const blockedResult = build([row(`blocked-${status}`, 1, { island: "아지르 섬", fromItem: "고대 잎", reqAmount: "1", toItem: "산호 상자", count: "0", yield: "1" })], {}, { masterBundle: blocked });
  assert.equal(blockedResult.sourceRows[0].fields.toItem.selectedCandidate, null, `${status} is not auto-selected`);
  assert.equal(blockedResult.sourceRows[0].fields.toItem.finalStatus, status === "DISPUTED" ? "MASTER_DISAGREEMENT" : "MASTER_DEPRECATED");
}

// Bounded matching delegates to the existing helper and restricts the pool to verified authority.
const typo = build([row("bounded", 1, { island: "아지르 섬", fromItem: "고대 잎", reqAmount: "1", toItem: "산호 상쟈", count: "0", yield: "1" })]);
assert.equal(typo.sourceRows[0].fields.toItem.selectedCandidate.value, "산호 상자");
assert.equal(typo.sourceRows[0].fields.toItem.selectedCandidate.matchKind, "BOUNDED_UNIQUE_MATCH");
assert.equal(typo.sourceRows[0].fields.toItem.riskReasons.some((entry) => entry.code === "BOUNDED_UNIQUE_MATCH"), true);
const low = build([row("low-score", 1, { island: "아지르 섬", fromItem: "고대 잎", reqAmount: "1", toItem: "아아아아아아아", count: "0", yield: "1" })]);
assert.equal(low.sourceRows[0].fields.toItem.selectedCandidate, null);
const ambiguousBundle = createMasterBundleV2({ createdAt: "2026-10-02T00:00:00Z", entities: [...bundle.entities,
  { ...bundle.entities.find((entity) => entity.stableId === "curated-output-a"), stableId: "curated-output-a2", legacyNames: [{ ...bundle.entities.find((entity) => entity.stableId === "curated-output-a").legacyNames[0], legacyNameKey: "legacy-output-a2", occurrences: [{ locator: "/synthetic/output-a2", scope: "MASTER_TIER_2", tier: 2 }] }] }],
  compatibilityMappings: [...bundle.compatibilityMappings, { stableId: "curated-output-a2", legacyNameKeys: ["legacy-output-a2"], sourceLocators: ["/synthetic/output-a2"] }], unresolvedLegacyNames: [], sourceRevisions: bundle.sourceRevisions, provenance: bundle.provenance });
const ambiguous = build([row("ambiguous", 1, { island: "아지르 섬", fromItem: "고대 잎", reqAmount: "1", toItem: "산호 상자", count: "0", yield: "1" })], {}, { masterBundle: ambiguousBundle });
assert.equal(ambiguous.sourceRows[0].fields.toItem.selectedCandidate, null);
assert.equal(ambiguous.sourceRows[0].fields.toItem.finalStatus, "AMBIGUOUS");

// Numeric rules preserve zero, reject defaults, and surface reader/text disagreement.
const numeric = build([row("numeric", 1, { island: "아지르 섬", fromItem: "고대 잎", reqAmount: "", toItem: "산호 상자", count: "0회", yield: "48" }, {
  reqAmount: { rawText: null, normalizedText: null, rawNumericCandidate: null },
  yield: { rawText: "148", normalizedText: "148", rawNumericCandidate: 48 },
})]);
assert.equal(numeric.sourceRows[0].fields.count.finalValue, 0);
assert.equal(numeric.sourceRows[0].fields.reqAmount.finalValue, null);
assert.equal(numeric.sourceRows[0].fields.yield.finalValue, 48, "R003 reader candidate remains the selected candidate");
assert.equal(numeric.sourceRows[0].fields.yield.parse.disagreement, true);
assert.equal(numeric.sourceRows[0].fields.yield.riskReasons.some((entry) => entry.code === "NUMERIC_READER_TEXT_DISAGREEMENT"), true);
const multiNumeric = build([row("multi", 1, { island: "아지르 섬", fromItem: "고대 잎", reqAmount: "1/2", toItem: "산호 상자", count: "0", yield: "1" })]);
assert.equal(multiNumeric.sourceRows[0].fields.reqAmount.finalValue, null);
assert.equal(multiNumeric.sourceRows[0].fields.reqAmount.finalStatus, "AMBIGUOUS");

// OPEN_WORLD is limited to tier-1 fromItem and never receives a generated identity.
const openWorld = build([row("open-world", 1, { island: "아지르 섬", fromItem: "  벼  ", reqAmount: "1", toItem: "고대 잎", count: "0", yield: "1" })]);
assert.equal(openWorld.sourceRows[0].fields.fromItem.finalStatus, "OPEN_WORLD");
assert.equal(openWorld.sourceRows[0].fields.fromItem.selectedCandidate.stableId, null);
assert.equal(openWorld.sourceRows[0].fields.fromItem.raw.text, "  벼  ");

const specialSource = bundle.entities.find((entity) => entity.stableId === "curated-output-a");
const specialEntity = { ...specialSource, stableId: "curated-crow-token", canonicalName: "까마귀 주화", tier: null, category: "LEGACY_SPECIAL_ITEM",
  legacyNames: [{ ...specialSource.legacyNames[0], legacyNameKey: "legacy-crow-token", legacyKind: "SPECIAL_ITEM", rawName: "까마귀 주화", tier: null,
    occurrences: [{ locator: "/synthetic/special/0", scope: "SPECIAL_ITEMS", tier: null }] }] };
const specialBundle = createMasterBundleV2({ createdAt: "2026-10-02T00:00:00Z", entities: [...bundle.entities, specialEntity],
  compatibilityMappings: [...bundle.compatibilityMappings, { stableId: specialEntity.stableId, legacyNameKeys: ["legacy-crow-token"], sourceLocators: ["/synthetic/special/0"] }],
  unresolvedLegacyNames: [], sourceRevisions: bundle.sourceRevisions, provenance: bundle.provenance });
const specialOutput = build([row("special-output", 1, { island: "아지르 섬", fromItem: "고대 잎", reqAmount: "1", toItem: "까마귀 주화", count: "0", yield: "1" })], {}, { masterBundle: specialBundle });
assert.equal(specialOutput.sourceRows[0].fields.toItem.selectedCandidate.kind, "SPECIAL_ITEM");
assert.equal(specialOutput.sourceRows[0].fields.fromItem.selectedCandidate.value, "고대 잎", "special output retains the existing broad input pool");

// R007 finalizer is reused without changing topology: six source rows map to four logical rows.
const values = (toItem) => ({ island: "아지르 섬", fromItem: "고대 잎", reqAmount: "1", toItem, count: "0", yield: "2" });
const scrollRows = [row("scroll-a", 1, values("산호 상자")), row("scroll-a", 2, values("푸른 상자")), row("scroll-a", 3, values("은빛 상자")),
  row("scroll-b", 1, values("푸른 상자")), row("scroll-b", 2, values("은빛 상자")), row("scroll-b", 3, values("금빛 상자"))];
const topology = buildTradeBatchReconciliation({ captures: [{ captureId: "scroll-a", imageHash: "image-a" }, { captureId: "scroll-b", imageHash: "image-b" }], draftRows: scrollRows, policyVersion: "trade-batch-reconciliation-v1" });
const reconciled = build(scrollRows, { reconciliation: topology }, { reconciliationPolicyVersion: "trade-batch-reconciliation-v1" });
assert.equal(reconciled.sourceRows.length, 6);
assert.equal(reconciled.logicalRows.length, 4);
assert.equal(reconciled.reconciliation.finalized.reconciliation.sourceToLogical.length, 6);
assert.equal(new Set(reconciled.reconciliation.finalized.reconciliation.sourceToLogical.map((entry) => entry.sourceRowId)).size, 6);
assert.throws(() => build(scrollRows.slice(1), { reconciliation: topology }, { reconciliationPolicyVersion: "trade-batch-reconciliation-v1" }), /one-to-one|source ledger/);

// REVIEW_FIRST oracle comparison on shared exact/number/open-world behavior.
const parityCatalog = { masterData: { 1: ["고대 잎"], 2: ["산호 상자", "푸른 상자", "은빛 상자", "금빛 상자"], 3: [], 4: [], 5: [], 6: [], 7: [] },
  specialItems: [], islands: ["아지르 섬"], t6Islands: [], t7Islands: [] };
const parityHash = createHash("sha256").update(JSON.stringify(parityCatalog)).digest("hex");
const registry = adaptLegacyCatalog(parityCatalog, { sourceRevision: "parity-fixture", sourceSha256: parityHash, curatedMappings: null });
const parityRow = row("parity", 1, values("산호 상자"));
const old = buildTradeReviewProjection({ draftRows: [parityRow], registrySnapshot: registry, correctionPolicyVersion: "r003-correction-v1" }).rows[0];
const shadow = build([parityRow]).sourceRows[0];
for (const key of ["island", "fromItem", "toItem"]) assert.equal(shadow.fields[key].finalValue, old.fields[key].shownValue, `${key} candidate display parity`);
for (const key of ["reqAmount", "count", "yield"]) assert.equal(shadow.fields[key].finalValue, old.fields[key].candidate?.value ?? null, `${key} numeric parity`);
assert.equal(shadow.fields.count.finalValue, 0);
const boundedRow = row("parity-bounded", 1, values("산호 상쟈"));
const oldBounded = buildTradeReviewProjection({ draftRows: [boundedRow], registrySnapshot: registry, correctionPolicyVersion: "r003-correction-v1" }).rows[0];
const newBounded = build([boundedRow]).sourceRows[0];
assert.equal(newBounded.fields.toItem.finalValue, oldBounded.fields.toItem.candidate?.value ?? oldBounded.fields.toItem.shownValue);
assert.equal(newBounded.fields.toItem.selectedCandidate.matchKind, "BOUNDED_UNIQUE_MATCH");
const unmatchedRow = row("parity-unmatched", 1, values("완전히 다른 미등록 품목"));
const oldUnmatched = buildTradeReviewProjection({ draftRows: [unmatchedRow], registrySnapshot: registry, correctionPolicyVersion: "r003-correction-v1" }).rows[0];
const newUnmatched = build([unmatchedRow]).sourceRows[0];
assert.equal(newUnmatched.fields.toItem.selectedCandidate, null);
assert.equal(newUnmatched.fields.toItem.finalValue, oldUnmatched.fields.toItem.shownValue);
const openWorldRow = row("parity-open-world", 1, { island: "아지르 섬", fromItem: "  벼  ", reqAmount: "1", toItem: "고대 잎", count: "0", yield: "1" });
const oldOpenWorld = buildTradeReviewProjection({ draftRows: [openWorldRow], registrySnapshot: registry, correctionPolicyVersion: "r003-correction-v1" }).rows[0];
const newOpenWorld = build([openWorldRow]).sourceRows[0];
assert.equal(newOpenWorld.fields.fromItem.finalStatus, oldOpenWorld.fields.fromItem.status);
assert.equal(newOpenWorld.fields.fromItem.finalValue, oldOpenWorld.fields.fromItem.candidate.value);
const missingNumericRow = row("parity-missing-number", 1, { island: "아지르 섬", fromItem: "고대 잎", reqAmount: null, toItem: "산호 상자", count: "0", yield: "1" });
const oldMissing = buildTradeReviewProjection({ draftRows: [missingNumericRow], registrySnapshot: registry, correctionPolicyVersion: "r003-correction-v1" }).rows[0];
const newMissing = build([missingNumericRow]).sourceRows[0];
assert.equal(newMissing.fields.reqAmount.finalValue, oldMissing.fields.reqAmount.candidate?.value ?? null);
assert.equal(newMissing.fields.count.finalValue, oldMissing.fields.count.candidate.value);

// Ambiguous bounded matches remain unselected in both the old oracle and shadow path.
const ambiguousNames = ["가나다라", "가나다마"];
const ambiguousEntities = ambiguousNames.map((name, index) => ({ ...bundle.entities.find((entity) => entity.stableId === "curated-output-a"),
  stableId: `ambiguous-${index}`, canonicalName: name, legacyNames: [{ ...bundle.entities.find((entity) => entity.stableId === "curated-output-a").legacyNames[0], legacyNameKey: `ambiguous-key-${index}`, rawName: name,
    occurrences: [{ locator: `/synthetic/ambiguous/${index}`, scope: "MASTER_TIER_2", tier: 2 }] }] }));
const ambiguousMaster = createMasterBundleV2({ createdAt: "2026-10-02T00:00:00Z", entities: [...bundle.entities, ...ambiguousEntities],
  compatibilityMappings: [...bundle.compatibilityMappings, ...ambiguousEntities.map((entity) => ({ stableId: entity.stableId, legacyNameKeys: entity.legacyNames.map((name) => name.legacyNameKey), sourceLocators: entity.legacyNames.map((name) => name.occurrences[0].locator) }))],
  unresolvedLegacyNames: [], sourceRevisions: bundle.sourceRevisions, provenance: bundle.provenance });
const ambiguousCatalog = structuredClone(parityCatalog);
ambiguousCatalog.masterData["2"].push(...ambiguousNames);
const ambiguousRegistry = adaptLegacyCatalog(ambiguousCatalog, { sourceRevision: "ambiguous-parity", sourceSha256: createHash("sha256").update(JSON.stringify(ambiguousCatalog)).digest("hex") });
const ambiguousParityRow = row("parity-ambiguous", 1, values("가나다바"));
const oldAmbiguous = buildTradeReviewProjection({ draftRows: [ambiguousParityRow], registrySnapshot: ambiguousRegistry, correctionPolicyVersion: "r003-correction-v1" }).rows[0];
const newAmbiguous = build([ambiguousParityRow], {}, { masterBundle: ambiguousMaster }).sourceRows[0];
assert.equal(oldAmbiguous.fields.toItem.status, "AMBIGUOUS");
assert.equal(newAmbiguous.fields.toItem.finalStatus, "AMBIGUOUS");
assert.equal(newAmbiguous.fields.toItem.selectedCandidate, null);
assert.equal(build([row("punctuation", 1, { island: "하코번...", fromItem: "고대 잎", reqAmount: "1", toItem: "산호 상자", count: "0", yield: "1" })]).sourceRows[0].fields.island.finalValue, "하코번...",
  "punctuation is not normalized away");

// No automatic truth, classifier, or session artifact is created by the shadow pipeline.
assert.equal(JSON.stringify(result).includes("HUMAN_CROP_VERIFIED"), false);
assert.equal(result.truthGenerated, false);
assert.equal(result.sessionWrites, false);
assert.equal(JSON.stringify(result).includes("FINAL_READY"), false);
assert.throws(() => build([one], {}, { correctionPolicy: { policyVersion: " " } }), /policyVersion/);
assert.throws(() => build([one], {}, { masterBundle: { ...bundle, contentHash: "0".repeat(64) } }), /invalid Master bundle|contentHash/);

console.log("PASS trade_final_correction_regression: Bundle2 authority; R003 exact/bounded/ambiguous/unmatched/open-world/numeric parity; 1 intentional reference authority upgrade; immutable deterministic output; R007 source 6 -> logical 4");
