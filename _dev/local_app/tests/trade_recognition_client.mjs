import assert from "node:assert/strict";
import { getTradeRecognitionRuntime, recognizeTradeBatch, TradeRecognitionError } from "../frontend/js/trade-recognition-client.js";

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
    captures: captures.map((item) => ({ captureId: item.metadata.captureId })),
    draftRows: captures.map((item) => row(item.metadata.captureId)),
    approval: { production: false, HIGH: 0, importerIntegration: false, automationDecision: "REVIEW" },
    ...overrides,
  },
});
const successForRequest = (options, captures = [first, second], overrides = {}) => {
  const batch = JSON.parse(options.body.get("batch"));
  return success(captures, { batchId: batch.batchId, ...overrides });
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
  ];
  for (const body of malformedCases) {
    globalThis.fetch = async (_url, options) => {
      const validBatchId = JSON.parse(options.body.get("batch")).batchId;
      return Response.json({ ...body, result: { ...body.result, batchId: validBatchId } });
    };
    await assert.rejects(recognizeTradeBatch([first]), (error) => error.code === "contract_violation");
  }
  console.log("trade_recognition_client: PASS");
} finally {
  globalThis.fetch = originalFetch;
}
