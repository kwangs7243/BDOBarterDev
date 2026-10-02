import assert from "node:assert/strict";
import { getTradeRecognitionRuntime, recognizeTradeBatch, recognizeTradeBatchV2, TradeRecognitionError } from "../frontend/js/trade-recognition-client.js";

const fieldNames = ["island", "fromItem", "reqAmount", "toItem", "count", "yield"];
const makeFields = () => Object.fromEntries(fieldNames.map((name) => [name, {
  rawText: name === "count" ? "10회" : `${name}-raw`, normalizedText: `${name}-normalized`,
  rawNumericCandidate: null, value: null, status: "RAW_OCR_CANDIDATE", reasonCodes: [],
}]));
const capture = (captureId, marker) => ({
  blob: new Blob([marker], { type: "image/png" }),
  metadata: { version: 1, captureId, batchId: `capture-batch-${marker}`, taskType: "trade", marker },
});
const first = capture("10000000-0000-4000-8000-000000000001", "first");
const second = capture("10000000-0000-4000-8000-000000000002", "second");
const metadataBefore = structuredClone([first.metadata, second.metadata]);
const row = (captureId) => ({ captureId, ordinal: 1, status: "DRAFT_UNVERIFIED", automationDecision: "REVIEW", fields: makeFields() });
const success = (captures = [first, second], overrides = {}) => ({
  ok: true,
  result: {
    version: 1, batchId: "recognition-request-id", status: "DRAFT_UNVERIFIED",
    captures: captures.map((item) => ({ captureId: item.metadata.captureId,
      detectedCandidateCount: 1, completeRowCount: 1, edgeSegmentCount: 0 })),
    draftRows: captures.map((item) => row(item.metadata.captureId)),
    edgeSegments: [],
    metrics: { boundaryPolicy: "edge-segments-evidence-only-v1", detectedCandidateCount: captures.length,
      completeRowCount: captures.length, edgeSegmentCount: 0, draftRowCount: captures.length },
    approval: { production: false, HIGH: 0, importerIntegration: false, automationDecision: "REVIEW" },
    ...overrides,
  },
});
const successForRequest = (options, captures = [first, second], overrides = {}) => {
  const batch = JSON.parse(options.body.get("batch"));
  return success(captures, { batchId: batch.batchId, ...overrides });
};
const v2Capture = (base, sourceType, reencoded = false) => ({
  ...base,
  reencoded,
  metadata: { ...base.metadata, sourceType, fidelity: sourceType === "file"
    ? { sourceWidth: 80, sourceHeight: 50, rescaled: false, evidence: "file-metadata" }
    : { sourceWidth: null, sourceHeight: null, rescaled: null, evidence: "unknown" } },
});
const rawSnapshot = (batchId, captures) => ({
  schemaVersion: 2, recognitionBatchId: batchId,
  captures: captures.map((item, index) => ({ captureId: item.metadata.captureId, captureOrdinal: index + 1,
    imageSha256: "a".repeat(64), bitmapSha256: "b".repeat(64),
    sourceType: ({ file: "FILE", clipboard: "CLIPBOARD", "browser-stream": "STREAM" })[item.metadata.sourceType],
    frame: { width: 80, height: 50 }, sourceFidelity: item.metadata.fidelity, reencoded: item.reencoded, completeRowCount: 1 })),
  sourceRows: captures.map((item) => ({ sourceRowId: `source-${item.metadata.captureId}`, captureId: item.metadata.captureId,
    ordinal: 0, rowBox: { x: 0, y: 0, width: 80, height: 20 }, fields: fieldNames.map((field) => ({
      field, rawText: null, rawNumeric: null, readerStatus: "OCR_ERROR", confidence: null, cropRefs: [],
    })) })),
  edgeSegments: [],
});
const successV2ForRequest = (options, captures) => {
  const batch = JSON.parse(options.body.get("batch"));
  return { ok: true, result: { version: 2, batchId: batch.batchId, status: "RAW_EVIDENCE_ONLY",
    rawEvidence: rawSnapshot(batch.batchId, captures), runtime: { available: true, engineId: "test-engine",
      modelBundleSha256: "c".repeat(64), workerVersion: "test-v2", durationMs: 0, captureCount: captures.length } } };
};
const originalFetch = globalThis.fetch;
let observedRequest;
globalThis.fetch = async (url, options) => {
  observedRequest = { url, options };
  if (url.endsWith("trade-runtime")) return Response.json({ ok: true, runtime: { available: true, reason: null } });
  return Response.json(success());
};
try {
  assert.deepEqual(await getTradeRecognitionRuntime(), { available: true, reason: null });
  const runtimeUnavailable = { ok: true, runtime: { available: false, reason: "python_missing" } };
  globalThis.fetch = async () => Response.json(runtimeUnavailable);
  assert.equal((await getTradeRecognitionRuntime()).available, false);

  globalThis.fetch = async (url, options) => { observedRequest = { url, options }; return Response.json(successForRequest(options)); };
  const result = await recognizeTradeBatch([first, second]);
  assert.equal(observedRequest.url, "/api/recognition/trade-batch");
  assert.equal(observedRequest.options.method, "POST");
  assert.equal(observedRequest.options.credentials, "same-origin");
  assert.equal(observedRequest.options.headers, undefined, "browser supplies multipart Content-Type boundary");
  assert.ok(observedRequest.options.body instanceof FormData);
  const entries = [...observedRequest.options.body.entries()];
  assert.equal(entries[0][0], "batch");
  const batch = JSON.parse(entries[0][1]);
  assert.equal(batch.version, 1);
  assert.match(batch.batchId, /^[0-9a-f-]{36}$/i, "each request gets a new UUID");
  assert.deepEqual(batch.captures.map((item) => item.captureId), [first.metadata.captureId, second.metadata.captureId]);
  assert.deepEqual(batch.captures.map((item) => item.metadata), metadataBefore);
  assert.deepEqual(entries.slice(1).map(([name, file]) => [name, file.name, file.type]), [
    ["image", "capture-0001.png", "image/png"], ["image", "capture-0002.png", "image/png"],
  ]);
  assert.deepEqual([first.metadata, second.metadata], metadataBefore, "capture metadata remains unchanged");
  assert.equal(result.draftRows.length, 2);

  let called = false;
  globalThis.fetch = async () => { called = true; return Response.json(success()); };
  await assert.rejects(recognizeTradeBatch([{ ...first, blob: new Blob(["bad"], { type: "image/jpeg" }) }]), TradeRecognitionError);
  await assert.rejects(recognizeTradeBatch([{ ...first, metadata: { ...first.metadata, taskType: "warehouse" } }]), TradeRecognitionError);
  assert.equal(called, false, "invalid captures are rejected before request");

  globalThis.fetch = async () => Response.json({ ok: false, error: { code: "engine_busy" } }, { status: 409 });
  await assert.rejects(recognizeTradeBatch([first]), (error) => error.code === "engine_busy" && error.message.includes("다른 인식 작업"));
  globalThis.fetch = async () => Response.json({ ok: false, error: { code: "recognition_timeout" } }, { status: 504 });
  await assert.rejects(recognizeTradeBatch([first]), (error) => error.code === "recognition_timeout");

  const malformedCases = [
    success([first], { status: "READY" }),
    success([first], { approval: { production: false, HIGH: 1, importerIntegration: false, automationDecision: "REVIEW" } }),
    success([first], { draftRows: [{ ...row(first.metadata.captureId), fields: { ...makeFields(), extra: { value: null } } }] }),
    success([first], { draftRows: [{ ...row(first.metadata.captureId), fields: Object.fromEntries(fieldNames.slice(0, -1).map((name) => [name, makeFields()[name]])) }] }),
    success([first], { draftRows: [{ ...row(first.metadata.captureId), fields: { ...makeFields(), island: { ...makeFields().island, value: "canonical" } } }] }),
    success([first], { draftRows: [{ ...row(first.metadata.captureId), automationDecision: "APPLY" }] }),
    success([first], { edgeSegments: [{ captureId: first.metadata.captureId, rowBox: {}, boundarySide: "left",
      classification: "EDGE_SEGMENT_UNCERTAIN" }], metrics: { boundaryPolicy: "edge-segments-evidence-only-v1",
      detectedCandidateCount: 1, completeRowCount: 1, edgeSegmentCount: 1, draftRowCount: 1 } }),
    success([first], { edgeSegments: [{ captureId: first.metadata.captureId, rowBox: {}, boundarySide: "top",
      classification: "EDGE_SEGMENT_UNCERTAIN", fields: {} }], metrics: { boundaryPolicy: "edge-segments-evidence-only-v1",
      detectedCandidateCount: 2, completeRowCount: 1, edgeSegmentCount: 1, draftRowCount: 1 } }),
  ];
  for (const body of malformedCases) {
    globalThis.fetch = async (_url, options) => {
      const validBatchId = JSON.parse(options.body.get("batch")).batchId;
      return Response.json({ ...body, result: { ...body.result, batchId: validBatchId } });
    };
    await assert.rejects(recognizeTradeBatch([first]), (error) => error.code === "contract_violation");
  }

  const v2Inputs = [v2Capture(first, "file", false), v2Capture(second, "clipboard", true),
    v2Capture(capture("10000000-0000-4000-8000-000000000003", "stream"), "browser-stream", false)];
  const v2MetadataBefore = structuredClone(v2Inputs.map((item) => item.metadata));
  globalThis.fetch = async (url, options) => {
    observedRequest = { url, options };
    return Response.json(successV2ForRequest(options, v2Inputs));
  };
  const v2Result = await recognizeTradeBatchV2(v2Inputs);
  const v2Entries = [...observedRequest.options.body.entries()];
  const v2Batch = JSON.parse(v2Entries[0][1]);
  assert.equal(v2Batch.version, 2);
  assert.equal(v2Batch.captures[0].metadata.version, 1);
  assert.deepEqual(v2Batch.captures.map((item) => item.metadata.sourceType), ["file", "clipboard", "browser-stream"]);
  assert.deepEqual(v2Batch.captures.map((item) => item.reencoded), [false, true, false]);
  assert.deepEqual(Object.keys(v2Batch.captures[0]).sort(), ["captureId", "metadata", "reencoded"]);
  assert.deepEqual(v2Entries.slice(1).map(([name, file]) => [name, file.name]), [
    ["image", "capture-0001.png"], ["image", "capture-0002.png"], ["image", "capture-0003.png"],
  ]);
  assert.equal(v2Result.status, "RAW_EVIDENCE_ONLY");
  assert.equal(v2Result.rawEvidence.recognitionBatchId, v2Batch.batchId);
  assert.equal(v2Result.runtime.engineId, "test-engine");
  assert.deepEqual(v2Inputs.map((item) => item.metadata), v2MetadataBefore, "v2 leaves capture metadata unchanged");

  called = false;
  globalThis.fetch = async () => { called = true; return Response.json({}); };
  await assert.rejects(recognizeTradeBatchV2([{ ...v2Inputs[0], reencoded: undefined }]), TradeRecognitionError);
  assert.equal(called, false, "missing reencoded is rejected before request");
  for (const sourceType of ["FILE", "unknown"]) {
    await assert.rejects(recognizeTradeBatchV2([v2Capture(first, sourceType)]), TradeRecognitionError);
  }

  const v2InvalidMutations = [
    (raw) => { raw.schemaVersion = 1; },
    (raw) => { raw.recognitionBatchId = "wrong"; },
    (raw) => { raw.captures[0].captureOrdinal = 2; },
    (raw) => { raw.sourceRows[0].fields[0].field = "fromItem"; },
    (raw) => { raw.sourceRows[1].sourceRowId = raw.sourceRows[0].sourceRowId; },
    (raw) => { raw.sourceRows[0].fields[0].cropRefs = [{ cropRefId: "crop", sourceRowId: "other",
      captureId: v2Inputs[0].metadata.captureId, field: "island", bitmapSha256: "b".repeat(64),
      frame: { width: 80, height: 50 }, coordinateSpace: "LANE_PIXELS", box: {}, pixelHashBasis: "RGB8_ROW_MAJOR_V1",
      pixelSha256: "d".repeat(64), pngArtifactSha256: null }]; },
  ];
  for (const mutate of v2InvalidMutations) {
    globalThis.fetch = async (_url, options) => {
      const body = successV2ForRequest(options, v2Inputs);
      mutate(body.result.rawEvidence);
      return Response.json(body);
    };
    await assert.rejects(recognizeTradeBatchV2(v2Inputs), (error) => error.code === "contract_violation");
  }
  console.log("trade_recognition_client: PASS");
} finally {
  globalThis.fetch = originalFetch;
}
