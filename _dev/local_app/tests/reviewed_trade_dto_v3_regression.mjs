import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { adaptLegacyCatalog } from "../frontend/js/domain/trade-master-registry.js";
import { adaptRegistrySnapshotV1ToMasterBundleV2 } from "../frontend/js/domain/trade-master-bundle.js";
import { buildFinalProjection3, buildFinalReviewCompletion, buildFinalReviewObservationRequest } from "../frontend/js/domain/trade-final-evidence.js";
import { validateReviewedTradeBatch } from "../frontend/js/domain/reviewed-trade-dto.js";

const POLICY = "reviewed-trade-dto-mapping-v3";
const IDS = { mutation: "00000000-0000-4000-8000-000000000001", observation: "00000000-0000-4000-8000-000000000002" };
const SHA = (letter) => letter.repeat(64);

function syntheticBundle(status = "VERIFIED") {
  const catalog = { masterData: { 1: ["재료", "다른 재료"], 2: ["교환품"], 3: [], 4: [], 5: [], 6: [], 7: [] }, specialItems: [],
    islands: ["섬", "다른 섬"], t6Islands: [], t7Islands: [] };
  const definitions = [
    ["00000000-0000-4000-8000-000000000011", "ISLAND", "섬", "/islands/0"],
    ["00000000-0000-4000-8000-000000000015", "ISLAND", "다른 섬", "/islands/1"],
    ["00000000-0000-4000-8000-000000000012", "MASTER_ITEM", "재료", "/masterData/1/0"],
    ["00000000-0000-4000-8000-000000000013", "MASTER_ITEM", "교환품", "/masterData/2/0"],
    ["00000000-0000-4000-8000-000000000014", "MASTER_ITEM", "다른 재료", "/masterData/1/1"],
  ];
  const curated = { schemaVersion: 1, mappingRevision: "dto-v3-test", entities: definitions.map(([stableId, kind, rawName, locator]) => ({
    stableId, kind, canonicalName: rawName, status, legacyNames: [{ rawName, expectedLocators: [locator] }], displayNames: [], aliases: [],
    provenance: { evidenceRefs: ["synthetic"], note: null }, replacedBy: null,
  })) };
  const registry = adaptLegacyCatalog(catalog, { sourceRevision: "dto-v3-fixture", sourceSha256: SHA("a"), curatedMappings: curated });
  const bundle = adaptRegistrySnapshotV1ToMasterBundleV2(registry, { createdAt: "2026-10-02T00:00:00Z" });
  return { bundle, registry };
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const compare = (a, b) => { const x = Array.from(a, (c) => c.codePointAt(0)); const y = Array.from(b, (c) => c.codePointAt(0));
    for (let i = 0; i < Math.min(x.length, y.length); i += 1) if (x[i] !== y[i]) return x[i] - y[i]; return x.length - y.length; };
  return `{${Object.keys(value).sort(compare).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function sha(value) { return createHash("sha256").update(canonical(value), "utf8").digest("hex"); }

const contractText = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../../specs/008-capture-recognition-v2/EVIDENCE-V3-CONTRACT.md", import.meta.url), "utf8"));
function section(title, next) { const start = contractText.indexOf(title); assert.notEqual(start, -1); const end = contractText.indexOf(next, start + title.length);
  return JSON.parse(contractText.slice(start, end < 0 ? undefined : end).match(/```json\s*([\s\S]*?)```/)[1]); }
const sampleProjection = section("### 12.1 FinalProjection3", "### 12.2 Completion3");
const sampleCompletion = section("### 12.2 Completion3", "### 12.3 Observation3");
const sampleObservation = section("### 12.3 Observation3 (persisted record)", "### 12.4");

function inputs({ classification = "FINAL_READY", values = { island: "섬", fromItem: "재료", reqAmount: 1, toItem: "교환품", count: 0, yield: 48 }, unknown = [], identityOverrides = {}, status = "VERIFIED", disposition = "INCLUDE", editedConflictField = null, mutationId = IDS.mutation } = {}) {
  const { bundle, registry } = syntheticBundle(status);
  const binding = { masterSchemaVersion: 2, registryVersion: bundle.registryVersion, contentHash: bundle.contentHash, hashBasis: bundle.hashBasis };
  const identityByField = Object.fromEntries(["island", "fromItem", "toItem"].map((field) => {
    const raw = values[field]; const record = registry.legacyNames.find((item) => item.rawName === raw);
    const entity = record?.stableId ? bundle.entities.find((item) => item.stableId === record.stableId) : null;
    return [field, record ? { kind: field === "island" ? "ISLAND" : "ITEM", stableId: record.stableId, legacyNameKey: record.legacyNameKey, authorityStatus: entity?.status ?? "LEGACY_UNVERIFIED" }
      : { kind: field === "island" ? "ISLAND" : "ITEM", stableId: null, legacyNameKey: null, authorityStatus: "LEGACY_UNVERIFIED" }];
  }));
  for (const [field, override] of Object.entries(identityOverrides)) identityByField[field] = { ...identityByField[field], ...override };
  const p = structuredClone(sampleProjection);
  p.masterBinding = binding; p.rows[0].classification = classification; p.rows[0].classificationReasons = classification === "FINAL_READY" ? [] : [classification];
  for (const field of p.rows[0].fields) {
    if (Object.hasOwn(values, field.field)) field.finalValue = field.correctedValue = field.normalizedValue = values[field.field];
    if (Object.hasOwn(identityByField, field.field)) {
      field.identity = identityByField[field.field];
      if (field.selectedCandidateIndex !== null) field.candidates[field.selectedCandidateIndex].identity = structuredClone(field.identity);
      field.riskReasons = [];
    }
    field.valueState = "RESOLVED";
  }
  if (editedConflictField) {
    const field = p.rows[0].fields.find((item) => item.field === editedConflictField);
    assert.ok(field); field.valueState = "CONFLICT"; field.finalValue = field.correctedValue = field.normalizedValue = null;
    field.selectedCandidateIndex = null; field.alternatives = [48, 148].map((value) => ({ value, sourceRefs: [], riskReasons: [] }));
  }
  const projectionInput = { recognitionBatchId: p.recognitionBatchId, rawEvidenceHash: p.rawEvidenceHash, masterBinding: binding,
    correctionVersion: p.correctionVersion, reconciliation: p.reconciliation, pixelAvailability: p.pixelAvailability, rows: p.rows, edgeWorkItems: p.edgeWorkItems };
  const projection = buildFinalProjection3(projectionInput);
  const completionRows = structuredClone(sampleCompletion.rows).map((row) => ({
    ...row, disposition, dispositionReason: disposition === "EXCLUDE" ? "USER_EXPLICIT_EXCLUSION" : null,
    fields: row.fields.map((field) => ({ field: field.field, finalValue: unknown.includes(field.field) ? null : field.field === editedConflictField ? 148 : values[field.field], unknown: unknown.includes(field.field) })),
  }));
  const completion = buildFinalReviewCompletion({ projection, reviewRevision: 4, confirmedAt: "2026-10-02T00:01:00Z", rows: completionRows, workItems: [] });
  const sourceContext = structuredClone(sampleObservation.sourceContext); sourceContext.masterBundle = { binding, snapshot: bundle };
  const request = buildFinalReviewObservationRequest({ projection, completion, sourceContext, mutationId, createdAt: "2026-10-02T00:01:00Z" });
  const payloadHash = sha(request);
  const persistedAt = "2026-10-02T00:01:01Z";
  const hashBasis = "TRADE_OBSERVATION_JSON_V3";
  const observationId = mutationId === IDS.mutation ? IDS.observation : `00000000-0000-4000-8000-${mutationId.slice(-12)}`;
  const observationHash = sha({ ...request, observationId, persistedAt, hashBasis, payloadHash });
  const observation = { ...request, observationId, persistedAt, hashBasis, payloadHash, observationHash };
  const receipt = { schemaVersion: 3, observationId, mutationId, payloadHash, observationHash, persistedAt, duplicate: false,
    evidenceSaved: true, sessionApplied: false, reviewMode: "FINAL_CORRECTED_RESULT", projectionHash: projection.projectionHash,
    masterBinding: binding, reviewRevision: completion.reviewRevision, cropPolicy: "C2_LOGICAL_REPRESENTATIVE_V3" };
  const expectedReview = { schemaVersion: 3, recognitionBatchId: projection.recognitionBatchId, projectionHash: projection.projectionHash,
    reviewRevision: completion.reviewRevision, masterBinding: binding, correctionVersion: projection.correctionVersion,
    completionValuesHash: completion.batchConfirmation.completionValuesHash, pixelAvailability: projection.pixelAvailability };
  return { projectionInput, projection, completion, sourceContext, request, observation, receipt, expectedReview, bundle, registry };
}

export function createReadyV3Batch(options = {}) {
  const fixture = inputs(options);
  const batch = validateReviewedTradeBatch({ storedObservation: fixture.observation, evidenceReceipt: fixture.receipt,
    expectedReview: fixture.expectedReview, mappingPolicyVersion: POLICY });
  return { ...fixture, batch };
}

async function run() {
  const ready = createReadyV3Batch();
  assert.equal(ready.batch.status, "READY", JSON.stringify(ready.batch.batchErrors));
  assert.equal(ready.batch.schemaVersion, 1);
  assert.equal(ready.batch.mappingPolicyVersion, POLICY);
  assert.deepEqual(Object.keys(ready.batch.rows[0].dto).sort(), ["count", "fromItem", "island", "reqAmount", "toItem", "yield"].sort());
  assert.deepEqual(ready.batch.rows[0].dto, { island: "섬", fromItem: "재료", reqAmount: 1, toItem: "교환품", count: 0, yield: 48 });
  assert.equal(ready.batch.observationRef.schemaVersion, 3);
  assert.equal(ready.batch.observationRef.completionValuesHash, ready.completion.batchConfirmation.completionValuesHash);
  assert.deepEqual(ready.batch.observationRef.masterBinding, ready.projection.masterBinding);
  assert.equal(JSON.stringify(ready.batch).includes("knownTruthEligible"), false);
  const duplicateReceipt = structuredClone(ready.receipt); duplicateReceipt.duplicate = true;
  const replay = validateReviewedTradeBatch({ storedObservation: ready.observation, evidenceReceipt: duplicateReceipt, expectedReview: ready.expectedReview, mappingPolicyVersion: POLICY });
  assert.equal(replay.status, "READY"); assert.equal(replay.semanticHash, ready.batch.semanticHash, "transport duplicate flag must not change semanticHash");

  const edited = createReadyV3Batch({ values: { island: "섬", fromItem: "재료", reqAmount: 1, toItem: "교환품", count: 0, yield: 148 } });
  assert.equal(edited.batch.status, "READY"); assert.equal(edited.batch.rows[0].dto.yield, 148);
  const forgedIdentity = inputs({ identityOverrides: { fromItem: { authorityStatus: "DISPUTED" } } });
  const forgedIdentityResult = validateReviewedTradeBatch({ storedObservation: forgedIdentity.observation, evidenceReceipt: forgedIdentity.receipt,
    expectedReview: forgedIdentity.expectedReview, mappingPolicyVersion: POLICY });
  assert.equal(forgedIdentityResult.status, "NOT_READY", "retained pinned identity authority must match exact Bundle2 mapping");
  assert.equal(forgedIdentityResult.heldRows[0].heldReasons.some((reason) => reason.detail?.reason === "PINNED_IDENTITY_MISMATCH"), true);
  const unknown = inputs({ unknown: ["count"] });
  const unknownResult = validateReviewedTradeBatch({ storedObservation: unknown.observation, evidenceReceipt: unknown.receipt, expectedReview: unknown.expectedReview, mappingPolicyVersion: POLICY });
  assert.equal(unknownResult.status, "NOT_READY"); assert.equal(unknownResult.heldRows[0].heldReasons.some((reason) => reason.code === "UNKNOWN_FIELD"), true);
  const missingNumeric = inputs({ values: { island: "섬", fromItem: "재료", reqAmount: 1, toItem: "교환품", count: 0, yield: null } });
  const missingResult = validateReviewedTradeBatch({ storedObservation: missingNumeric.observation, evidenceReceipt: missingNumeric.receipt, expectedReview: missingNumeric.expectedReview, mappingPolicyVersion: POLICY });
  assert.equal(missingResult.status, "NOT_READY"); assert.equal(missingResult.heldRows[0].heldReasons.some((reason) => reason.code === "INVALID_NUMERIC"), true);
  const unmatched = inputs({ values: { island: "섬", fromItem: "목록에 없는 원료", reqAmount: 1, toItem: "교환품", count: 0, yield: 48 } });
  const unmatchedResult = validateReviewedTradeBatch({ storedObservation: unmatched.observation, evidenceReceipt: unmatched.receipt, expectedReview: unmatched.expectedReview, mappingPolicyVersion: POLICY });
  assert.equal(unmatchedResult.status, "NOT_READY"); assert.equal(unmatchedResult.heldRows[0].heldReasons.some((reason) => reason.code === "UNRESOLVED_MAPPING"), true);
  for (const status of ["DISPUTED", "DEPRECATED"]) {
    const fixture = inputs({ status });
    const result = validateReviewedTradeBatch({ storedObservation: fixture.observation, evidenceReceipt: fixture.receipt, expectedReview: fixture.expectedReview, mappingPolicyVersion: POLICY });
    assert.equal(result.status, "NOT_READY", `${status} cannot grant automatic DTO authority`);
  }
  for (const classification of ["NEEDS_RECAPTURE", "CONFLICT"]) {
    const fixture = inputs({ classification });
    const result = validateReviewedTradeBatch({ storedObservation: fixture.observation, evidenceReceipt: fixture.receipt, expectedReview: fixture.expectedReview, mappingPolicyVersion: POLICY });
    assert.equal(result.status, "NOT_READY", classification);
  }
  const resolvedConflict = inputs({ classification: "CONFLICT", editedConflictField: "yield" });
  const resolvedConflictResult = validateReviewedTradeBatch({ storedObservation: resolvedConflict.observation, evidenceReceipt: resolvedConflict.receipt,
    expectedReview: resolvedConflict.expectedReview, mappingPolicyVersion: POLICY });
  assert.equal(resolvedConflictResult.status, "READY", "a conflict row is eligible only after the conflicting field receives USER_EDITED final value");
  const needsReview = inputs({ classification: "NEEDS_REVIEW" });
  assert.equal(validateReviewedTradeBatch({ storedObservation: needsReview.observation, evidenceReceipt: needsReview.receipt, expectedReview: needsReview.expectedReview, mappingPolicyVersion: POLICY }).status, "READY",
    "only contract-permitted, exactly mapped NEEDS_REVIEW candidates may proceed after whole-list confirmation");
  const finalReadyExcluded = inputs({ disposition: "EXCLUDE" });
  const forbiddenExclusion = validateReviewedTradeBatch({ storedObservation: finalReadyExcluded.observation, evidenceReceipt: finalReadyExcluded.receipt,
    expectedReview: finalReadyExcluded.expectedReview, mappingPolicyVersion: POLICY });
  assert.notEqual(forbiddenExclusion.status, "READY"); assert.ok(forbiddenExclusion.batchErrors.some((error) => error.code === "INVALID_EXCLUSION"));
  const heldExcluded = inputs({ classification: "NEEDS_RECAPTURE", disposition: "EXCLUDE" });
  const heldExcludedResult = validateReviewedTradeBatch({ storedObservation: heldExcluded.observation, evidenceReceipt: heldExcluded.receipt,
    expectedReview: heldExcluded.expectedReview, mappingPolicyVersion: POLICY });
  assert.notEqual(heldExcludedResult.status, "READY"); assert.equal(heldExcludedResult.summary.explicitlyExcludedRowCount, 1);

  for (const mutate of [
    (x) => { x.receipt.observationHash = SHA("f"); },
    (x) => { x.expectedReview.projectionHash = SHA("e"); },
    (x) => { x.expectedReview.reviewRevision += 1; },
    (x) => { x.expectedReview.completionValuesHash = SHA("d"); },
    (x) => { x.expectedReview.masterBinding.contentHash = SHA("c"); },
    (x) => { x.expectedReview.pixelAvailability[0].state = "EXPIRED"; },
  ]) {
    const fixture = createReadyV3Batch(); fixture.receipt = structuredClone(fixture.receipt); fixture.expectedReview = structuredClone(fixture.expectedReview); mutate(fixture);
    const result = validateReviewedTradeBatch({ storedObservation: fixture.observation, evidenceReceipt: fixture.receipt, expectedReview: fixture.expectedReview, mappingPolicyVersion: POLICY });
    assert.notEqual(result.status, "READY");
    assert.equal(result.batchErrors.some((error) => error.code === "STALE_REVIEW"), true);
  }
  const badObservation = createReadyV3Batch(); badObservation.observation = structuredClone(badObservation.observation); badObservation.observation.projection.rows[0].fields[0].finalValue = "바뀐 이름";
  assert.equal(validateReviewedTradeBatch({ storedObservation: badObservation.observation, evidenceReceipt: badObservation.receipt, expectedReview: badObservation.expectedReview, mappingPolicyVersion: POLICY }).batchErrors[0].code, "INVALID_OBSERVATION");
  const wrongPolicy = validateReviewedTradeBatch({ ...ready, mappingPolicyVersion: "reviewed-trade-dto-mapping-v1" });
  assert.equal(wrongPolicy.status, "NOT_READY");
  assert.ok(Object.isFrozen(ready.batch));
  console.log("reviewed_trade_dto_v3_regression: PASS · v3 bindings/receipt/hash, exact Bundle2 identity, retained/edit/count=0 READY, unknown/recapture/conflict/stale HOLD, schema1 six-field output, no truth claim");
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) await run();
