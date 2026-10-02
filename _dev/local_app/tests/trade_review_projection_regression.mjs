import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptLegacyCatalog } from "../frontend/js/domain/trade-master-registry.js";
import { getSafeUniqueItemMatch } from "../frontend/js/domain/trade-import.js";
import { buildTradeReviewProjection } from "../frontend/js/domain/trade-review-projection.js";
import { buildTradeBatchReconciliation } from "../frontend/js/domain/trade-batch-reconciliation.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const emptyCatalog = () => ({
  masterData: Object.fromEntries(["1", "2", "3", "4", "5", "6", "7"].map((tier) => [tier, []])),
  specialItems: [], islands: [], t6Islands: [], t7Islands: [],
});
const catalog = emptyCatalog();
catalog.masterData["1"] = ["보리", "고대 잎", "초원 씨앗", "초원씨앗"];
catalog.masterData["2"] = ["고대 목걸이", "금빛 목걸이", "푸른 결정", "푸른결정", "바다의 보석"];
catalog.masterData["3"] = ["푸른 결정"];
catalog.masterData["6"] = ["tier six output"];
catalog.masterData["7"] = ["tier seven output"];
catalog.islands = ["하코번 섬", "일리야", "아지르 섬", "아지르섬"];
catalog.t6Islands = ["하코번 섬", "하코번"];
catalog.t7Islands = ["일리야 섬"];
const sourceSha256 = createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
const pointer = (path) => path.split("/").slice(1).reduce((value, key) => value[key], catalog);
const ref = (rawName, locator) => ({ rawName, expectedLocators: [locator] });
const entity = (stableId, rawName, locator, canonicalName) => ({
  stableId, kind: "MASTER_ITEM", canonicalName, status: "VERIFIED",
  legacyNames: [ref(rawName, locator)],
  displayNames: [], aliases: [],
  provenance: { evidenceRefs: ["curation:test-r003"], note: "synthetic contract coverage" },
  replacedBy: null,
});
const goldNecklace = entity("item-gold-necklace", "금빛 목걸이", "/masterData/2/1", "금빛 목걸이 canonical");
goldNecklace.displayNames = [{
  text: "금 목걸이", status: "VERIFIED", provenance: { evidenceRefs: ["capture:verified-display"], note: "synthetic verified display" },
}];
const mapping = {
  schemaVersion: 1,
  mappingRevision: "r003-test-curation-v1",
  entities: [
    entity("item-necklace", "고대 목걸이", "/masterData/2/0", "고대 목걸이 canonical"),
    goldNecklace,
  ],
};
const registrySnapshot = adaptLegacyCatalog(catalog, {
  sourceRevision: "r003-synthetic-catalog-v1", sourceSha256, curatedMappings: mapping,
});
const fieldsFor = (values, overrides = {}) => Object.fromEntries(
  ["island", "fromItem", "reqAmount", "toItem", "count", "yield"].map((key) => {
    const override = overrides[key];
    const value = Object.hasOwn(overrides, key) && (!override || typeof override !== "object") ? override : values[key];
    return [key, {
      rawText: value ?? null,
      normalizedText: value ?? null,
      rawNumericCandidate: null,
      value: null,
      status: value === null || value === undefined ? "EMPTY_OCR" : "RAW_OCR_CANDIDATE",
      reasonCodes: value === null || value === undefined ? ["EMPTY_OCR"] : [],
      confidence: 0.91,
      evidence: { cropId: `crop-${key}`, box: { x: 1, y: 2, width: 3, height: 4 } },
      ...(override && typeof override === "object" ? override : {}),
    }];
  }),
);
const makeRow = (captureId, ordinal, values, overrides = {}) => ({
  captureId, ordinal, status: "DRAFT_UNVERIFIED", automationDecision: "REVIEW", fields: fieldsFor(values, overrides),
});
const rows = [
  makeRow("capture-a", 1, {
    island: "하코번...", fromItem: "보리", reqAmount: "수 : 10회",
    toItem: "[2단계] 고대 목걸이", count: "0회", yield: "48",
  }, { yield: { ...fieldsFor({ yield: "48" }).yield, rawNumericCandidate: 48, status: "FIELD_CLIPPED", reasonCodes: ["FIELD_CLIPPED"] } }),
  makeRow("capture-a", 2, {
    island: "아지르 섬", fromItem: "보리", reqAmount: null,
    toItem: "푸른 결정", count: "10회 / 20회", yield: "2",
  }, {
    toItem: { ...fieldsFor({ toItem: "푸른 결정" }).toItem, normalizedText: "푸른 결정" },
    yield: { ...fieldsFor({ yield: "2" }).yield, rawNumericCandidate: 3 },
  }),
  makeRow("capture-b", 1, {
    island: "일리야", fromItem: "벼", reqAmount: null,
    toItem: "[1단계] 보리", count: "1회", yield: "5",
  }),
  makeRow("capture-c", 1, {
    island: "일리야", fromItem: "고대 잎s", reqAmount: "3",
    toItem: "금빛 목걸이", count: "1회", yield: "4",
  }),
  makeRow("capture-d", 1, {
    island: "일리야", fromItem: "고대 잎", reqAmount: "3",
    toItem: "금 목걸이", count: "1회", yield: "4",
  }),
  makeRow("capture-e", 1, {
    island: "일리야", fromItem: "보리", reqAmount: "3",
    toItem: "바다의 보적", count: "1회", yield: "4",
  }),
];
const input = { draftRows: rows, registrySnapshot, correctionPolicyVersion: "r003-correction-v1" };
const inputBefore = structuredClone(input);
const projection = buildTradeReviewProjection(input);
const baselineTopology = buildTradeBatchReconciliation({
  captures: [...new Set(rows.map((row) => row.captureId))].map((captureId) => ({ captureId })),
  draftRows: rows,
  policyVersion: "trade-batch-reconciliation-v1",
});
const baselineProjectionV2 = buildTradeReviewProjection({ ...input, reconciliation: baselineTopology });
assert.equal(projection.projectionHash, "94a8e9823c46d0ad529ac2dea0b51f367306aa9a582405c5ae705476a290a769", "REVIEW_FIRST schema 1 pre-C2 golden hash");
assert.equal(baselineProjectionV2.projectionHash, "011f0bb0df113beb3642841f33992cc84962f382d388445c5db7296604ba63c7", "REVIEW_FIRST schema 2 pre-C2 golden hash");
assert.deepEqual(input, inputBefore, "draft rows, reconciliation, and registry inputs are not mutated");
assert.equal(Object.isFrozen(projection) && Object.isFrozen(projection.rows[0].fields.island.rawEvidence.evidence.box), true);
assert.equal(projection.correctionVersion, "r003-correction-v1");
assert.equal(projection.masterVersion, registrySnapshot.registryVersion);
assert.equal(projection.masterSnapshotSha256.length, 64);
assert.equal(projection.rows[0].sourceIndex, 0);
assert.equal(projection.rows.length, rows.length, "every structurally complete draft row is projected");
assert.deepEqual(projection.rows.map((row) => [row.captureId, row.ordinal]), [["capture-a", 1], ["capture-a", 2], ["capture-b", 1], ["capture-c", 1], ["capture-d", 1], ["capture-e", 1]], "row/source order is preserved");
assert.equal(projection.reviewMode, "REVIEW_FIRST");
assert.equal(projection.reconciliation, null);
for (const row of projection.rows) {
  assert.deepEqual(Object.keys(row.fields), ["island", "fromItem", "reqAmount", "toItem", "count", "yield"]);
  assert.equal(row.rowStatus, "COMPLETE");
  assert.equal(row.reviewState, "SYSTEM_PREDICTION_UNREVIEWED");
  for (const key of Object.keys(row.fields)) {
    assert.equal(row.fields[key].reviewState, "SYSTEM_PREDICTION_UNREVIEWED");
    assert.equal(row.fields[key].editable, true);
    assert.ok(Object.hasOwn(row.fields[key], "rawEvidence"));
    assert.ok(Object.hasOwn(row.fields[key], "candidate"));
    assert.ok(Array.isArray(row.fields[key].alternatives));
    assert.ok(Array.isArray(row.fields[key].riskReasons));
  }
}

// Tier, stage-prefix, whitespace, and bounded V1 correction produce review candidates with provenance.
const row1 = projection.rows[0];
assert.equal(row1.fields.toItem.status, "MATCHED");
assert.equal(row1.fields.toItem.candidate.value, "고대 목걸이");
assert.equal(row1.fields.toItem.candidate.stableId, "item-necklace");
assert.equal(row1.fields.toItem.candidate.nameSource, "LEGACY_NAME");
assert.equal(row1.fields.toItem.rawEvidence.rawText, "[2단계] 고대 목걸이");
assert.equal(row1.fields.toItem.normalizationSteps.some((step) => step.operation === "REMOVE_DISPLAY_PREFIX"), true);
assert.equal(row1.fields.fromItem.status, "MATCHED");
assert.equal(row1.fields.fromItem.candidate.value, "보리", "toItem tier 2 limits fromItem to tier 1");
assert.equal(row1.fields.fromItem.riskReasons.some((risk) => risk.code === "LEGACY_UNVERIFIED"), false, "null stableId alone adds no generic uncertainty risk");
assert.equal(row1.fields.island.status, "UNMATCHED", "island normalization trims only and does not infer an ellipsis completion");
assert.equal(row1.fields.island.shownValue, "하코번...");
assert.equal(row1.fields.reqAmount.candidate.value, 10, "bounded label/unit parser reads a single quantity");
assert.equal(row1.fields.count.candidate.value, 0, "zero is distinct from missing");
assert.equal(row1.fields.yield.candidate.value, 48, "partial numeric candidate remains 48, never inferred as 148");
assert.equal(row1.fields.yield.riskReasons.some((risk) => risk.code === "FIELD_CLIPPED"), true);
assert.equal(row1.fields.yield.riskReasons.some((risk) => risk.code === "NUMERIC_COMPLETENESS_UNVERIFIED"), true);

// Name normalization collisions and ambiguous numeric sources stay visible and unselected.
const row2 = projection.rows[1];
assert.equal(row2.fields.toItem.status, "AMBIGUOUS", "whitespace-normalized collision does not use first match");
assert.equal(row2.fields.toItem.candidate, null);
assert.equal(row2.fields.toItem.alternatives.length, 3, "same raw in multiple tiers and whitespace collision are preserved");
assert.equal(row2.fields.island.status, "MATCHED", "the exact island candidate remains preferred before safe correction");
assert.equal(row2.fields.island.candidate.value, "아지르 섬", "exact island identity wins before bounded correction");
assert.equal(row2.fields.reqAmount.candidate, null, "missing reqAmount receives no default");
assert.equal(row2.fields.reqAmount.status, "UNMATCHED");
assert.equal(row2.fields.count.status, "AMBIGUOUS", "multiple numeric groups are not arbitrarily selected");
assert.equal(row2.fields.count.candidate, null);
assert.equal(row2.fields.yield.status, "MATCHED", "valid raw numeric candidate takes precedence over text parsing");
assert.equal(row2.fields.yield.candidate.value, 3);
assert.equal(row2.fields.fromItem.status, "AMBIGUOUS", "ambiguous output tiers do not silently select an input tier");
assert.equal(row2.fields.fromItem.candidate, null);
assert.equal(row2.fields.fromItem.riskReasons.some((risk) => risk.code === "TO_ITEM_DEPENDENCY_UNRESOLVED"), true);
assert.equal(row2.fields.island.riskReasons.some((risk) => risk.code === "TO_ITEM_TIER_UNRESOLVED"), true);

// Tier-1 input is preserved as open-world, while catalog identity remains absent.
const row3 = projection.rows[2];
assert.equal(row3.fields.toItem.status, "MATCHED");
assert.equal(row3.fields.toItem.candidate.tier, 1);
assert.equal(row3.fields.fromItem.status, "OPEN_WORLD");
assert.equal(row3.fields.fromItem.candidate.value, "벼");
assert.equal(row3.fields.fromItem.candidate.stableId, null);

// Correction disagreements preserve the screen text and the curated internal identity together.
const row4 = projection.rows[3];
assert.equal(row4.fields.toItem.status, "MATCHED", "canonical/display difference alone is not a Master disagreement");
assert.equal(row4.fields.toItem.candidate.value, "금빛 목걸이");
assert.equal(row4.fields.toItem.candidate.canonicalName, "금빛 목걸이 canonical");
assert.equal(row4.fields.toItem.rawEvidence.rawText, "금빛 목걸이");
assert.equal(row4.fields.toItem.riskReasons.some((risk) => risk.code === "MASTER_DISAGREEMENT"), false);
assert.equal(row4.fields.fromItem.status, "MATCHED");
assert.equal(row4.fields.fromItem.candidate.value, "고대 잎");
assert.equal(row4.fields.fromItem.correctionReason.some((reason) => reason.code === "BOUNDED_UNIQUE_MATCH"), true);

// A curated, verified display name maps to the canonical entity without rewriting the observed display.
const row5 = projection.rows[4];
assert.equal(row5.fields.toItem.status, "MATCHED");
assert.equal(row5.fields.toItem.candidate.value, "금 목걸이");
assert.equal(row5.fields.toItem.candidate.canonicalName, "금빛 목걸이 canonical");
assert.equal(row5.fields.toItem.candidate.stableId, "item-gold-necklace");

// Unique fuzzy correction uses the existing bounded 0.75 helper policy and remains visibly risky.
const row6 = projection.rows[5];
assert.equal(row6.fields.toItem.status, "MATCHED");
assert.equal(row6.fields.toItem.candidate.value, "바다의 보석");
assert.equal(row6.fields.toItem.riskReasons.some((risk) => risk.code === "BOUNDED_UNIQUE_MATCH"), true);
assert.equal(row6.fields.toItem.correctionReason.some((reason) => reason.code === "BOUNDED_UNIQUE_MATCH"), true);
assert.equal(getSafeUniqueItemMatch("바다의 보적", ["바다의 보석"]).status, "corrected");

// Hashing is deterministic, output is prediction-only, and errors never silently filter rows.
const projectionAgain = buildTradeReviewProjection(input);
assert.deepEqual(projection, projectionAgain);
assert.equal(projection.projectionHash, projectionAgain.projectionHash);
assert.equal(JSON.stringify(projection).includes("SAFE_ACCEPT"), false);
assert.equal(JSON.stringify(projection).includes("HIGH"), false);
const allUnknownRows = Array.from({ length: 11 }, (_, index) => makeRow(`hold-${index}`, 1, {
  island: null, fromItem: null, reqAmount: null, toItem: null, count: null, yield: null,
}));
delete allUnknownRows[0].fields.island.rawText;
delete allUnknownRows[0].fields.island.normalizedText;
delete allUnknownRows[0].fields.island.status;
delete allUnknownRows[0].fields.island.reasonCodes;
const allUnknownProjection = buildTradeReviewProjection({ draftRows: allUnknownRows, registrySnapshot, correctionPolicyVersion: "r003-correction-v1" });
assert.equal(allUnknownProjection.rows.length, 11, "all-unknown drafts still produce every review row");
assert.equal(allUnknownProjection.rows.every((row) => Object.values(row.fields).length === 6), true);
assert.equal(allUnknownProjection.rows.every((row) => row.fields.reqAmount.shownValue === null && row.fields.count.shownValue === null && row.fields.yield.shownValue === null), true, "missing numeric fields receive no defaults");
assert.equal(Object.hasOwn(allUnknownProjection.rows[0].fields.island.rawEvidence, "rawText"), false, "missing raw evidence stays missing, not fabricated");
assert.equal(allUnknownProjection.rows[0].fields.island.riskReasons.some((risk) => risk.code === "FIELD_STATUS_MISSING"), true);
const invalidDraft = structuredClone(input);
invalidDraft.draftRows[1].fields.count.value = 0;
assert.throws(() => buildTradeReviewProjection(invalidDraft), /raw recognition draft contract/);
const missingSource = structuredClone(input);
delete missingSource.draftRows[0].captureId;
assert.throws(() => buildTradeReviewProjection(missingSource), /captureId or positive ordinal/);
assert.throws(() => buildTradeReviewProjection({ ...input, correctionPolicyVersion: " " }), /correctionPolicyVersion/);
assert.throws(() => buildTradeReviewProjection({ ...input, registrySnapshot: null }), /registrySnapshot is invalid/);
assert.throws(() => buildTradeReviewProjection({ ...input, reconciliation: {} }), /PRELIMINARY/);
const invalidRawNumeric = makeRow("invalid-raw-number", 1, {
  island: "아지르 섬", fromItem: "보리", reqAmount: "필요 수량: 3개", toItem: "고대 목걸이", count: "0회", yield: "4",
}, { reqAmount: { ...fieldsFor({ reqAmount: "필요 수량: 3개" }).reqAmount, rawNumericCandidate: 0 } });
const invalidRawProjection = buildTradeReviewProjection({ draftRows: [invalidRawNumeric], registrySnapshot, correctionPolicyVersion: "r003-correction-v1" });
assert.equal(invalidRawProjection.rows[0].fields.reqAmount.candidate, null, "invalid present reader candidate is not replaced by text parsing");
assert.equal(invalidRawProjection.rows[0].fields.reqAmount.riskReasons.some((risk) => risk.code === "NUMERIC_MISSING_OR_INVALID"), true);

// Exercise the current catalog: legacy-only names remain usable even though every stableId is null.
const catalogPath = resolve(root, "local_app/frontend/data/trade-catalog.json");
const catalogBytes = await readFile(catalogPath);
const sourceCatalog = JSON.parse(catalogBytes.toString("utf8"));
const currentSourceSha256 = createHash("sha256").update(catalogBytes).digest("hex");
const legacyRegistry = adaptLegacyCatalog(sourceCatalog, { sourceRevision: "current-catalog", sourceSha256: currentSourceSha256 });
const currentRow = makeRow("actual-capture", 1, {
  island: "하코번 섬", fromItem: "육지 재료", reqAmount: null,
  toItem: "최고급 굴 상자", count: null, yield: "48",
});
const actualProjection = buildTradeReviewProjection({
  draftRows: [currentRow], registrySnapshot: legacyRegistry, correctionPolicyVersion: "r003-correction-v1",
});
assert.equal(actualProjection.rows.length, 1);
assert.equal(actualProjection.rows[0].fields.toItem.candidate.value, "최고급 굴 상자");
assert.equal(actualProjection.rows[0].fields.toItem.candidate.stableId, null);
assert.equal(actualProjection.rows[0].fields.fromItem.status, "UNMATCHED", "tier-2 output uses tier-1 input scope; unmatched raw remains reviewable");
assert.equal(actualProjection.rows[0].fields.reqAmount.candidate, null);
assert.equal(actualProjection.rows[0].fields.yield.candidate.value, 48);
assert.equal(actualProjection.rows[0].fields.yield.riskReasons.some((risk) => risk.code === "NUMERIC_COMPLETENESS_UNVERIFIED"), true);
assert.equal(actualProjection.rows[0].fields.toItem.riskReasons.some((risk) => risk.code === "LEGACY_UNVERIFIED"), false);
assert.equal(legacyRegistry.legacyNames.reduce((sum, name) => sum + name.occurrences.length, 0), 241);
assert.equal(legacyRegistry.legacyNames.length, 230);
assert.equal(legacyRegistry.unresolvedMappings.length, 230);
assert.equal(legacyRegistry.entities.length, 0);
const separateNearNames = legacyRegistry.legacyNames.filter((name) => name.kind === "ISLAND" && ["하코번", "하코번 섬", "일리야", "일리야 섬"].includes(name.rawName));
assert.equal(new Set(separateNearNames.map((name) => name.rawName)).size, 4, "near-name tokens remain separate legacy records");
assert.equal(separateNearNames.every((name) => name.stableId === null), true);
const nearNameRow = makeRow("near-name", 1, { island: "하코번", fromItem: "unknown", reqAmount: null, toItem: sourceCatalog.masterData["6"][0], count: null, yield: null });
const nearNameProjection = buildTradeReviewProjection({ draftRows: [nearNameRow], registrySnapshot: legacyRegistry, correctionPolicyVersion: "r003-correction-v1" });
assert.equal(nearNameProjection.rows[0].fields.island.candidate.value, "하코번", "exact near-name token is not promoted to its suffixed neighbor");

const makeIslandRegistry = ({ general = [], tier6 = [], tier7 = [], baseCatalog = catalog, curatedMappings = null, revision = "island-test" } = {}) => {
  const islandCatalog = structuredClone(baseCatalog);
  islandCatalog.islands = general;
  islandCatalog.t6Islands = tier6;
  islandCatalog.t7Islands = tier7;
  const islandSha256 = createHash("sha256").update(JSON.stringify(islandCatalog)).digest("hex");
  return adaptLegacyCatalog(islandCatalog, { sourceRevision: revision, sourceSha256: islandSha256, curatedMappings });
};
const projectIsland = (registry, { island, tier = 2, captureId = "island-case" }) => {
  const output = catalog.masterData[String(tier)][0];
  return buildTradeReviewProjection({
    draftRows: [makeRow(captureId, 1, { island, fromItem: "보리", reqAmount: null, toItem: output, count: null, yield: null })],
    registrySnapshot: registry, correctionPolicyVersion: "r003-correction-v1",
  }).rows[0].fields.island;
};

// Whitespace-equivalent matching uses the V1 helper but does not promote the name to an alias.
const whitespaceRegistry = makeIslandRegistry({ general: ["아지르 섬"], revision: "island-whitespace" });
const whitespaceIsland = projectIsland(whitespaceRegistry, { island: "아지르섬", captureId: "island-whitespace" });
assert.equal(whitespaceIsland.status, "MATCHED");
assert.equal(whitespaceIsland.candidate.value, "아지르 섬");
assert.equal(whitespaceIsland.correctionReason.some((reason) => reason.code === "EXACT_MATCH"), true);
assert.equal(whitespaceIsland.candidate.nameSource, "LEGACY_NAME");
assert.equal(whitespaceIsland.rawEvidence.rawText, "아지르섬");
assert.equal(whitespaceIsland.rawEvidence.normalizedText, "아지르섬");

// A single bounded typo is corrected; multiple safe candidates remain explicitly ambiguous.
const oneTypoRegistry = makeIslandRegistry({ general: ["가나다라나"], revision: "island-one-typo" });
const oneTypo = projectIsland(oneTypoRegistry, { island: "가나다라마", captureId: "island-one-typo" });
assert.equal(oneTypo.status, "MATCHED");
assert.equal(oneTypo.candidate.value, "가나다라나");
assert.equal(oneTypo.correctionReason.some((reason) => reason.code === "BOUNDED_UNIQUE_MATCH"), true);
assert.equal(oneTypo.riskReasons.some((risk) => risk.code === "BOUNDED_UNIQUE_MATCH"), true);
assert.equal(oneTypo.rawEvidence.rawText, "가나다라마");
const twoTypoRegistry = makeIslandRegistry({ general: ["가나다라나", "가나다라바"], revision: "island-two-typos" });
const twoTypo = projectIsland(twoTypoRegistry, { island: "가나다라마", captureId: "island-two-typos" });
assert.equal(twoTypo.status, "AMBIGUOUS");
assert.equal(twoTypo.candidate, null);
assert.equal(twoTypo.alternatives.length, 2);
assert.equal(twoTypo.shownValue, "가나다라마");

// Tier-specific candidate pools allow bounded matches only within their own scope.
for (const tier of [6, 7]) {
  const key = tier === 6 ? "tier6" : "tier7";
  const scoped = makeIslandRegistry({ [key]: ["가나다라나"], revision: `island-${key}` });
  const output = catalog.masterData[String(tier)][0];
  const scopedRow = makeRow(`island-${key}`, 1, { island: "가나다라마", fromItem: "unused", reqAmount: null, toItem: output, count: null, yield: null });
  const scopedResult = buildTradeReviewProjection({ draftRows: [scopedRow], registrySnapshot: scoped, correctionPolicyVersion: "r003-correction-v1" }).rows[0].fields.island;
  assert.equal(scopedResult.status, "MATCHED", `${key} allows a safe correction within scope`);
  assert.equal(scopedResult.correctionReason.some((reason) => reason.code === "BOUNDED_UNIQUE_MATCH"), true);

  const leakage = makeIslandRegistry({ general: ["가나다라나"], revision: `island-${key}-leak` });
  const leakageRow = makeRow(`island-${key}-leak`, 1, { island: "가나다라마", fromItem: "unused", reqAmount: null, toItem: output, count: null, yield: null });
  const leakageResult = buildTradeReviewProjection({ draftRows: [leakageRow], registrySnapshot: leakage, correctionPolicyVersion: "r003-correction-v1" }).rows[0].fields.island;
  assert.equal(leakageResult.status, "UNMATCHED", `${key} never borrows a candidate from GENERAL_ISLANDS`);
}

// Explicitly curated same-stableId island names collapse to one identity after normalized matching.
const sameIslandIdentity = {
  schemaVersion: 1, mappingRevision: "same-island-identity-v1",
  entities: [{
    stableId: "curated-island-1", kind: "ISLAND", canonicalName: "대표 섬", status: "VERIFIED",
    legacyNames: [ref("가나다라나", "/t6Islands/0"), ref("가나다 라나", "/t6Islands/1")],
    displayNames: [], aliases: [], provenance: { evidenceRefs: ["test"], note: null }, replacedBy: null,
  }],
};
const sameIslandRegistry = makeIslandRegistry({ tier6: ["가나다라나", "가나다 라나"], curatedMappings: sameIslandIdentity, revision: "same-island-identity" });
const sameIslandRow = makeRow("same-island-identity", 1, { island: "가나다라 나", fromItem: "unused", reqAmount: null, toItem: catalog.masterData["6"][0], count: null, yield: null });
const sameIslandResult = buildTradeReviewProjection({ draftRows: [sameIslandRow], registrySnapshot: sameIslandRegistry, correctionPolicyVersion: "r003-correction-v1" }).rows[0].fields.island;
assert.equal(sameIslandResult.status, "MATCHED");
assert.equal(sameIslandResult.candidate.stableId, "curated-island-1");

// Curated same-entity names collapse identity ambiguity; different IDs remain ambiguous.
const sameIdMapping = {
  schemaVersion: 1, mappingRevision: "same-id-test",
  entities: [{
    stableId: "same-entity", kind: "MASTER_ITEM", canonicalName: "대표 이름", status: "VERIFIED",
    legacyNames: [ref("푸른 결정", "/masterData/2/2"), ref("푸른결정", "/masterData/2/3")],
    displayNames: [], aliases: [], provenance: { evidenceRefs: ["test"], note: null }, replacedBy: null,
  }],
};
const collisionCatalog = structuredClone(catalog);
collisionCatalog.masterData["3"] = [];
const collisionSourceSha256 = createHash("sha256").update(JSON.stringify(collisionCatalog)).digest("hex");
const sameIdRegistry = adaptLegacyCatalog(collisionCatalog, { sourceRevision: "same-id", sourceSha256: collisionSourceSha256, curatedMappings: sameIdMapping });
const sameIdProjection = buildTradeReviewProjection({
  draftRows: [makeRow("same-id", 1, { island: "아지르 섬", fromItem: "보리", reqAmount: null, toItem: "푸른 결정", count: null, yield: null })],
  registrySnapshot: sameIdRegistry, correctionPolicyVersion: "r003-correction-v1",
});
assert.equal(sameIdProjection.rows[0].fields.toItem.status, "MATCHED");
assert.equal(sameIdProjection.rows[0].fields.toItem.candidate.stableId, "same-entity");

const distinctIdMapping = {
  schemaVersion: 1, mappingRevision: "distinct-id-test",
  entities: [
    { ...sameIdMapping.entities[0], stableId: "blue-separated-a", canonicalName: "푸른 결정", legacyNames: [ref("푸른 결정", "/masterData/2/2")] },
    { ...sameIdMapping.entities[0], stableId: "blue-separated-b", canonicalName: "푸른결정", legacyNames: [ref("푸른결정", "/masterData/2/3")] },
  ],
};
const distinctIdRegistry = adaptLegacyCatalog(collisionCatalog, { sourceRevision: "distinct-id", sourceSha256: collisionSourceSha256, curatedMappings: distinctIdMapping });
const distinctIdProjection = buildTradeReviewProjection({
  draftRows: [makeRow("distinct-id", 1, { island: "아지르 섬", fromItem: "보리", reqAmount: null, toItem: "푸른 결정", count: null, yield: null })],
  registrySnapshot: distinctIdRegistry, correctionPolicyVersion: "r003-correction-v1",
});
assert.equal(distinctIdProjection.rows[0].fields.toItem.status, "AMBIGUOUS");
assert.equal(distinctIdProjection.rows[0].fields.toItem.alternatives.some((candidate) => candidate.stableId === "blue-separated-b"), true);

// A disputed mapped identity is visible as Master disagreement, not silently accepted.
const disputedMapping = structuredClone(mapping);
disputedMapping.entities[0].status = "DISPUTED";
const disputedRegistry = adaptLegacyCatalog(catalog, { sourceRevision: "disputed", sourceSha256, curatedMappings: disputedMapping });
const disputedProjection = buildTradeReviewProjection({
  draftRows: [makeRow("disputed", 1, { island: "아지르 섬", fromItem: "보리", reqAmount: null, toItem: "고대 목걸이", count: null, yield: null })],
  registrySnapshot: disputedRegistry, correctionPolicyVersion: "r003-correction-v1",
});
assert.equal(disputedProjection.rows[0].fields.toItem.status, "MASTER_DISAGREEMENT");
assert.equal(disputedProjection.rows[0].fields.toItem.riskReasons.some((risk) => risk.code === "MASTER_DISAGREEMENT"), true);

// Exact special outputs use the full V1-compatible fromItem candidate universe.
const specialRaw = sourceCatalog.specialItems[0];
const specialRow = makeRow("special-output", 1, { island: "하코번 섬", fromItem: sourceCatalog.masterData["1"][0], reqAmount: null, toItem: specialRaw, count: null, yield: null });
const specialProjection = buildTradeReviewProjection({ draftRows: [specialRow], registrySnapshot: legacyRegistry, correctionPolicyVersion: "r003-correction-v1" });
assert.equal(specialProjection.rows[0].fields.toItem.candidate.kind, "SPECIAL_ITEM");
assert.equal(specialProjection.rows[0].fields.fromItem.status, "MATCHED", "special output keeps the V1-compatible full candidate pool");

// A completely unrelated island does not get a forced tier-6 or tier-7 match.
for (const tier of [6, 7]) {
  const output = sourceCatalog.masterData[String(tier)][0];
  const forcedMatchRow = makeRow(`tier-${tier}-island`, 1, { island: "not-a-real-island-token", fromItem: "anything", reqAmount: null, toItem: output, count: null, yield: null });
  const forcedMatchProjection = buildTradeReviewProjection({ draftRows: [forcedMatchRow], registrySnapshot: legacyRegistry, correctionPolicyVersion: "r003-correction-v1" });
  assert.equal(forcedMatchProjection.rows[0].fields.island.status, "UNMATCHED");
}

// Runtime module delegates all correction parsing/matching to the shared kernel.
const runtimeSource = await readFile(resolve(root, "local_app/frontend/js/domain/trade-review-projection.js"), "utf8");
assert.match(runtimeSource, /resolveTradeIdentityCorrection/);
assert.match(runtimeSource, /resolveTradeNumericCorrection/);
assert.match(runtimeSource, /deriveTradeDomainConstraints/);
assert.doesNotMatch(runtimeSource, /getSafeUniqueItemMatch|matchAll\(\/\[0-9\]|allowedNumericDecoration|function numericToken|function normalizeName/);
assert.doesNotMatch(runtimeSource, /processParsedTrades|node:|\bBuffer\b|\bprocess\s*\.|\brequire\s*\(/);
assert.doesNotMatch(runtimeSource, /getBestMatch|forceMatch/);

console.log(`PASS trade_review_projection_regression: ${projection.rows.length} COMPLETE rows x 6 fields; all prediction-only; actual legacy-only registry supported`);
