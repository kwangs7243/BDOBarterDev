import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptLegacyCatalog } from "../frontend/js/domain/trade-master-registry.js";
import { adaptRegistrySnapshotV1ToMasterBundleV2, applyTradeMasterReferenceManifestToBundleV2 } from "../frontend/js/domain/trade-master-bundle.js";
import { computeCatalogProvenanceV2 } from "../frontend/js/domain/trade-catalog-provenance.js";
import { adaptRawEvidenceSnapshot2ToCorrectionInput, buildTradeFinalPipeline, buildTradeFinalShadowPipeline } from "../frontend/js/domain/trade-final-pipeline.js";
import { hashRawEvidenceSnapshot2 } from "../frontend/js/domain/trade-final-evidence.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIELDS = ["island", "fromItem", "reqAmount", "toItem", "count", "yield"];
const correctionPolicy = { policyVersion: "trade-final-correction-v1", boundedMatchPolicy: "V1_UNIQUE_BOUNDED_0.75" };
const canonical = (value) => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).sort((a, b) => Array.from(a).map((c) => c.codePointAt(0)).join(",").localeCompare(Array.from(b).map((c) => c.codePointAt(0)).join(","))).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const catalogBytes = await readFile(resolve(root, "frontend/data/trade-catalog.json"));
const catalogProvenance = computeCatalogProvenanceV2(catalogBytes);
const registry = adaptLegacyCatalog(catalogProvenance.catalog, {
  sourceRevision: `catalog-provenance-v2:${catalogProvenance.sha256}`,
  sourceSha256: catalogProvenance.sha256,
  curatedMappings: null,
});
const baseBundle = adaptRegistrySnapshotV1ToMasterBundleV2(registry, {
  createdAt: "2026-10-02T00:00:00Z",
  catalogProvenance: { schemaVersion: catalogProvenance.schemaVersion,
    hashBasis: catalogProvenance.hashBasis, sha256: catalogProvenance.sha256 },
});
const referenceManifest = JSON.parse(await readFile(resolve(root, "frontend/data/trade-master-reference-manifest-v2.json"), "utf8"));
const masterBundle = applyTradeMasterReferenceManifestToBundleV2(baseBundle, referenceManifest, {
  createdAt: "2026-10-02T00:00:00Z", catalogBytes,
});
assert.deepEqual([masterBundle.entities.length, masterBundle.compatibilityMappings.length, masterBundle.unresolvedLegacyNames.length,
  masterBundle.entities.flatMap((entity) => entity.legacyNames).concat(masterBundle.unresolvedLegacyNames).reduce((sum, name) => sum + name.occurrences.length, 0),
  masterBundle.entities.flatMap((entity) => entity.legacyNames).concat(masterBundle.unresolvedLegacyNames).length], [87, 87, 143, 241, 230]);
assert.equal(masterBundle.contentHash, "ad0b6a929130dfeafd0f66bc5c302a7d2c60c400d5145cd16cd20b66bd3e652b");

function rawField(field, value, cropRefs = []) {
  const numeric = ["reqAmount", "count", "yield"].includes(field);
  return { field, rawText: value === null ? null : String(value), rawNumeric: numeric ? value : null,
    readerStatus: value === null ? "EMPTY_OCR" : "RAW_OCR_CANDIDATE", confidence: "0.91", cropRefs };
}
function sourceRow(captureId, ordinal, values, extra = {}) {
  return { sourceRowId: `${captureId}-row-${ordinal}`, captureId, ordinal,
    rowBox: { x: 2, y: (ordinal - 1) * 24 + 2, width: 160, height: 20 },
    fields: FIELDS.map((field) => rawField(field, values[field], extra[field] ?? [])) };
}
function capture(captureId, captureOrdinal, imageByte, completeRowCount) {
  return { captureId, captureOrdinal, imageSha256: imageByte.repeat(64), bitmapSha256: "b".repeat(64), sourceType: "STREAM",
    frame: { width: 180, height: 90 }, sourceFidelity: { sourceWidth: null, sourceHeight: null, rescaled: null, evidence: "unknown" },
    reencoded: false, completeRowCount };
}
const values = (toItem, yieldValue = 48) => ({ island: "하코번 섬", fromItem: "고대 잎", reqAmount: 10,
  toItem, count: 0, yield: yieldValue });
function snapshot(captures, sourceRows, edgeSegments = [], recognitionBatchId = "batch-pipeline-regression") {
  return { schemaVersion: 2, recognitionBatchId, captures, sourceRows, edgeSegments };
}

const firstCapture = capture("capture-a", 1, "a", 1);
const cropRefs = FIELDS.map((field, index) => ({ cropRefId: `crop-${field}`, sourceRowId: "capture-a-row-1", captureId: "capture-a", field,
  bitmapSha256: firstCapture.bitmapSha256, frame: structuredClone(firstCapture.frame), coordinateSpace: "CAPTURE_BITMAP_PIXELS",
  box: { x: index, y: 1, width: 1, height: 1 }, pixelHashBasis: "RGB8_ROW_MAJOR_V1", pixelSha256: String(index + 1).repeat(64), pngArtifactSha256: null }));
const edge = { edgeId: "edge-a", captureId: "capture-a", ordinal: 2, reason: "EDGE_SEGMENT_UNCERTAIN",
  rowBox: { x: 0, y: 78, width: 180, height: 12 }, sourceRefs: [{ sourceRowId: "edge-a", captureId: "capture-a", ordinal: 2 }] };
const rawOne = snapshot([firstCapture], [sourceRow("capture-a", 1, values("산호 상자"), Object.fromEntries(FIELDS.map((field, index) => [field, [cropRefs[index]]])))], [edge]);
const rawOneBefore = structuredClone(rawOne);
const adapted = adaptRawEvidenceSnapshot2ToCorrectionInput(rawOne);
assert.deepEqual(rawOne, rawOneBefore, "adapter leaves RawEvidenceSnapshot2 unchanged");
assert.deepEqual(adapted.captures, [{ captureId: "capture-a", captureOrdinal: 1, imageHash: firstCapture.imageSha256 }]);
assert.equal(adapted.recognitionBatchId, rawOne.recognitionBatchId);
assert.equal(adapted.draftRows.length, rawOne.sourceRows.length);
assert.equal(adapted.draftRows[0].rowId, rawOne.sourceRows[0].sourceRowId);
assert.equal(adapted.draftRows[0].ordinal, rawOne.sourceRows[0].ordinal);
assert.deepEqual(adapted.draftRows[0].rowBox, rawOne.sourceRows[0].rowBox);
assert.deepEqual(adapted.draftRows[0].cropRefs, cropRefs);
assert.equal(adapted.draftRows[0].fields.count.rawNumericCandidate, 0, "numeric zero is preserved");
assert.equal(adapted.draftRows[0].fields.count.rawText, "0");
assert.equal(adapted.draftRows[0].fields.count.normalizedText, null);
assert.equal(adapted.draftRows[0].fields.count.value, null);
assert.equal(adapted.draftRows[0].fields.count.status, "RAW_OCR_CANDIDATE");
assert.deepEqual(adapted.draftRows[0].fields.count.reasonCodes, []);
assert.deepEqual(adapted.edgeSegments, [edge]);
assert.equal(Object.isFrozen(adapted) && Object.isFrozen(adapted.draftRows[0].fields.count), true);
assert.throws(() => { adapted.draftRows[0].fields.count.value = 9; }, TypeError);

const pixelAvailability = cropRefs.map((item) => ({ cropRefId: item.cropRefId, state: "IN_MEMORY" }));
const pipeline = buildTradeFinalShadowPipeline({ rawEvidence: rawOne, masterBundle, pixelAvailability, correctionPolicy });
assert.equal(pipeline.activation, "SHADOW_ONLY");
assert.equal(pipeline.pipelineKind, "TRADE_FINAL_SHADOW_PIPELINE");
assert.equal(pipeline.preliminaryReconciliation.sourceRows.length, 1);
assert.equal(pipeline.correctionResult.pipelineKind, "TRADE_FINAL_CORRECTION_SHADOW");
assert.equal(pipeline.correctionResult.truthGenerated, false);
assert.equal(pipeline.correctionResult.sessionWrites, false);
assert.equal(pipeline.projection.schemaVersion, 3);
assert.equal(pipeline.projection.rawEvidenceHash, hashRawEvidenceSnapshot2(rawOne));
assert.equal(pipeline.projection.pixelAvailability.length, cropRefs.length);
assert.deepEqual(pipeline.projection.rows[0].fields.map((field) => field.field), FIELDS);
assert.equal(pipeline.projection.rows[0].fields.find((field) => field.field === "count").finalValue, 0);
assert.deepEqual(pipeline, buildTradeFinalShadowPipeline({ rawEvidence: rawOne, masterBundle, pixelAvailability, correctionPolicy }), "shadow output is deterministic");
assert.equal(Object.isFrozen(pipeline) && Object.isFrozen(pipeline.projection.rows[0]), true);
const activePipeline = buildTradeFinalPipeline({ rawEvidence: rawOne, masterBundle, pixelAvailability, correctionPolicy });
assert.equal(activePipeline.pipelineKind, "TRADE_FINAL_PIPELINE");
assert.equal(activePipeline.activation, "ACTIVE");
assert.equal(activePipeline.projection.projectionHash, pipeline.projection.projectionHash, "active and shadow wrappers share identical semantic output");

const zeroOrdinal = structuredClone(rawOne);
zeroOrdinal.sourceRows[0].ordinal = 0;
const zeroOrdinalPipeline = buildTradeFinalShadowPipeline({ rawEvidence: zeroOrdinal, masterBundle, pixelAvailability, correctionPolicy });
assert.equal(zeroOrdinalPipeline.projection.reconciliation.sourceRows[0].ordinal, 0, "RawEvidence2 ordinal zero is preserved through correction/reconciliation");
const negativeOrdinal = structuredClone(rawOne);
negativeOrdinal.sourceRows[0].ordinal = -1;
assert.throws(() => buildTradeFinalShadowPipeline({ rawEvidence: negativeOrdinal, masterBundle, pixelAvailability, correctionPolicy }), /identity\/order/);
const duplicateOrdinal = structuredClone(rawOne);
duplicateOrdinal.sourceRows.push({ ...structuredClone(duplicateOrdinal.sourceRows[0]), sourceRowId: "capture-a-row-duplicate" });
assert.throws(() => buildTradeFinalShadowPipeline({ rawEvidence: duplicateOrdinal, masterBundle, pixelAvailability, correctionPolicy }), /invalid identity\/order|duplicate captureId\/ordinal/);
const reversedOrdinal = structuredClone(rawOne);
reversedOrdinal.sourceRows.push({ ...structuredClone(reversedOrdinal.sourceRows[0]), sourceRowId: "capture-a-row-2", ordinal: 2 });
reversedOrdinal.sourceRows.reverse();
assert.throws(() => buildTradeFinalShadowPipeline({ rawEvidence: reversedOrdinal, masterBundle, pixelAvailability, correctionPolicy }), /identity\/order/);

const captureB = capture("capture-b", 2, "c", 3);
const overlapRows = [
  sourceRow("capture-a", 1, values("말린 푸른 장미")),
  sourceRow("capture-a", 2, values("로아 꽃 씨앗 주머니")),
  sourceRow("capture-a", 3, values("해상 전투 식량", 48)),
  sourceRow("capture-b", 1, values("로아 꽃 씨앗 주머니")),
  sourceRow("capture-b", 2, values("해상 전투 식량", 148)),
  sourceRow("capture-b", 3, values("알 수 없는 고대 벽화")),
];
const overlapRaw = snapshot([capture("capture-a", 1, "a", 3), captureB], overlapRows, [], "batch-overlap-regression");
const overlapPipeline = buildTradeFinalShadowPipeline({ rawEvidence: overlapRaw, masterBundle, pixelAvailability: [], correctionPolicy });
assert.equal(overlapPipeline.preliminaryReconciliation.sourceRows.length, 6);
assert.equal(overlapPipeline.correctionResult.sourceRows.length, 6);
assert.equal(overlapPipeline.correctionResult.logicalRows.length, 4);
assert.equal(overlapPipeline.projection.reconciliation.sourceRows.length, 6);
assert.equal(overlapPipeline.projection.rows.length, 4);
assert.equal(overlapPipeline.projection.reconciliation.sourceToLogical.length, 6);
const conflictRow = overlapPipeline.projection.rows.find((row) => row.sourceRefs.length === 2 && row.fields.find((field) => field.field === "yield")?.valueState === "CONFLICT");
assert.ok(conflictRow, "overlap yield conflict remains a logical review row");
assert.equal(conflictRow.fields.find((field) => field.field === "yield").finalValue, null);
assert.equal(conflictRow.fields.find((field) => field.field === "yield").alternatives.length, 2);
assert.deepEqual(conflictRow.sourceRefs.map((ref) => ref.sourceRowId), ["capture-a-row-3", "capture-b-row-2"]);
assert.equal(overlapPipeline.correctionResult.truthGenerated, false);
assert.equal(overlapPipeline.correctionResult.sessionWrites, false);

const badFieldOrder = structuredClone(rawOne);
[badFieldOrder.sourceRows[0].fields[0], badFieldOrder.sourceRows[0].fields[1]] = [badFieldOrder.sourceRows[0].fields[1], badFieldOrder.sourceRows[0].fields[0]];
assert.throws(() => adaptRawEvidenceSnapshot2ToCorrectionInput(badFieldOrder), /field order/);
const duplicateCapture = structuredClone(rawOne); duplicateCapture.captures.push(structuredClone(duplicateCapture.captures[0]));
assert.throws(() => adaptRawEvidenceSnapshot2ToCorrectionInput(duplicateCapture), /capture order/);

console.log("trade_final_pipeline_regression: PASS · exact RawEvidence2 adapter, zero/lineage preservation, M4 Bundle2 pin, R007 6→4 reconciliation conflict, C3, determinism, immutability");
