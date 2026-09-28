import assert from "node:assert/strict";
import {
  CaptureError,
  CaptureQueue,
  PreviewRegistry,
  captureFromFile,
  captureFromPaste,
  captureLimits,
  isEditableTarget,
} from "../frontend/js/capture.js";

const pngSignature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(name, data = new Uint8Array()) {
  const result = new Uint8Array(12 + data.length);
  new DataView(result.buffer).setUint32(0, data.length, false);
  result.set(new TextEncoder().encode(name), 4);
  result.set(data, 8);
  return result;
}
function makePng(marker = 0) {
  const ihdrData = new Uint8Array(13);
  new DataView(ihdrData.buffer).setUint32(0, 4, false);
  new DataView(ihdrData.buffer).setUint32(4, 3, false);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  const chunks = [chunk("IHDR", ihdrData), chunk("IDAT", Uint8Array.of(marker)), chunk("IEND")];
  const size = chunks.reduce((sum, item) => sum + item.length, 0);
  const bytes = new Uint8Array(pngSignature.length + size);
  bytes.set(pngSignature);
  let offset = pngSignature.length;
  for (const item of chunks) { bytes.set(item, offset); offset += item.length; }
  return bytes;
}
const context = { taskType: "warehouse", baseRevision: 7, sessionId: null, sessionRevision: null };
let uuidCount = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidCount).padStart(12, "0")}`;
const adapters = {
  uuid,
  now: () => "2026-09-28T12:00:00.000Z",
  hash: async (blob) => `hash-${blob.size}`,
  decode: async (blob, options) => {
    assert.equal(options.orientation, "from-image");
    if (blob.failDecode) throw new Error("invalid bitmap");
    return { width: blob.testWidth ?? 4, height: blob.testHeight ?? 3, pixels: blob.testPixels ?? [1, 2, 3], close() { this.closed = true; } };
  },
  encodePng: async (bitmap) => {
    adapters.lastEncodedPixels = [...bitmap.pixels];
    return new Blob([makePng(9)], { type: "image/png" });
  },
};
const blob = (bytes, type = "application/octet-stream") => new Blob([bytes], { type });
const clipboardEvent = (files) => {
  let prevented = false;
  return {
    clipboardData: { items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })) },
    preventDefault() { prevented = true; },
    wasPrevented: () => prevented,
  };
};
async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof CaptureError && error.code === code);
}

const pngBytes = makePng(4);
const pngFile = blob(pngBytes, "image/png");
const firstPng = await captureFromFile(pngFile, context, adapters);
const secondPng = await captureFromFile(pngFile, context, adapters);
assert.deepEqual(new Uint8Array(await firstPng.blob.arrayBuffer()), pngBytes, "PNG source bytes are retained exactly");
assert.equal(firstPng.metadata.sourceType, "file");
assert.deepEqual(firstPng.metadata.frame, { width: 4, height: 3 });
assert.deepEqual(firstPng.metadata.fidelity, {
  sourceWidth: 4,
  sourceHeight: 3,
  rescaled: false,
  evidence: "file-metadata",
}, "file PNG records decoded source dimensions and file metadata evidence");
assert.equal(firstPng.reencoded, false);
assert.equal(firstPng.sha256, firstPng.sourceSha256);
assert.notEqual(firstPng.metadata.captureId, secondPng.metadata.captureId);
assert.equal(firstPng.metadata.batchId, null);
assert.equal(firstPng.metadata.context.baseRevision, 7);
assert.deepEqual(Object.keys(firstPng.metadata).sort(), ["batchId", "captureId", "capturedAt", "context", "fidelity", "frame", "observed", "profileId", "profileVersion", "sourceType", "taskType", "version"].sort());

await rejectsCode(captureFromFile(blob([], "image/png"), context, adapters), "empty_image");
await rejectsCode(captureFromFile(blob([1, 2, 3], "image/png"), context, adapters), "invalid_image");
const malformed = blob(pngBytes, "image/png");
malformed.failDecode = true;
await rejectsCode(captureFromFile(malformed, context, adapters), "invalid_image");
const animatedPng = blob(new Uint8Array([...pngSignature, ...chunk("acTL", new Uint8Array(8)), ...chunk("IEND")]), "image/png");
await rejectsCode(captureFromFile(animatedPng, context, adapters), "animated_image");
const animatedGifBytes = new Uint8Array(38);
animatedGifBytes.set(new TextEncoder().encode("GIF89a"));
animatedGifBytes[13] = 0x2c;
animatedGifBytes[23] = 2; animatedGifBytes[24] = 0;
animatedGifBytes[25] = 0x2c;
animatedGifBytes[35] = 2; animatedGifBytes[36] = 0;
animatedGifBytes[37] = 0x3b;
await rejectsCode(captureFromFile(blob(animatedGifBytes, "image/gif"), context, adapters), "animated_image");
const oversized = blob(new Uint8Array(captureLimits.MAX_IMAGE_BYTES + 1), "image/png");
await rejectsCode(captureFromFile(oversized, context, adapters), "image_too_large");
const tooManyPixels = blob(pngBytes, "image/png");
tooManyPixels.testWidth = captureLimits.MAX_IMAGE_PIXELS;
tooManyPixels.testHeight = 2;
await rejectsCode(captureFromFile(tooManyPixels, context, adapters), "image_too_large");

const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x01, 0x02]);
const jpegFile = blob(jpegBytes, "image/jpeg");
jpegFile.testPixels = [17, 28, 39, 40];
const jpegCapture = await captureFromFile(jpegFile, { ...context, taskType: "trade" }, adapters);
assert.equal(jpegCapture.metadata.taskType, "trade");
assert.equal(jpegCapture.metadata.sourceType, "file");
assert.deepEqual(jpegCapture.metadata.frame, { width: 4, height: 3 });
assert.deepEqual(jpegCapture.metadata.fidelity, {
  sourceWidth: 4,
  sourceHeight: 3,
  rescaled: false,
  evidence: "file-metadata",
}, "non-PNG file retains file-metadata fidelity after PNG normalization");
assert.equal(jpegCapture.blob.type, "image/png");
assert.equal(jpegCapture.reencoded, true);
assert.deepEqual(adapters.lastEncodedPixels, jpegFile.testPixels, "lossless PNG adapter receives the decoded bitmap unchanged");

const noImage = clipboardEvent([]);
assert.deepEqual(await captureFromPaste(noImage, context, adapters), { handled: false, inputs: [] });
assert.equal(noImage.wasPrevented(), false, "text-only clipboard remains available to the browser");
const inactiveImage = clipboardEvent([pngFile]);
assert.deepEqual(await captureFromPaste(inactiveImage, null, adapters), { handled: false, inputs: [] });
assert.equal(inactiveImage.wasPrevented(), false, "inactive capture context preserves image paste for the browser");
const clipboardPng = clipboardEvent([pngFile]);
const pastedPng = await captureFromPaste(clipboardPng, context, adapters);
assert.equal(clipboardPng.wasPrevented(), true);
assert.equal(pastedPng.inputs[0].metadata.sourceType, "clipboard");
assert.deepEqual(pastedPng.inputs[0].metadata.frame, { width: 4, height: 3 });
assert.deepEqual(pastedPng.inputs[0].metadata.fidelity, {
  sourceWidth: null,
  sourceHeight: null,
  rescaled: null,
  evidence: "unknown",
}, "clipboard PNG keeps decoded dimensions separate from unknown source fidelity");
assert.match(pastedPng.inputs[0].metadata.batchId, /^[0-9a-f-]{36}$/i);
assert.deepEqual(new Uint8Array(await pastedPng.inputs[0].blob.arrayBuffer()), pngBytes);

const clipboardJpeg = clipboardEvent([jpegFile]);
const pastedJpeg = await captureFromPaste(clipboardJpeg, { ...context, taskType: "trade" }, adapters);
assert.equal(pastedJpeg.inputs[0].metadata.sourceType, "clipboard");
assert.deepEqual(pastedJpeg.inputs[0].metadata.frame, { width: 4, height: 3 });
assert.deepEqual(pastedJpeg.inputs[0].metadata.fidelity, {
  sourceWidth: null,
  sourceHeight: null,
  rescaled: null,
  evidence: "unknown",
}, "clipboard non-PNG remains unknown after PNG normalization");
assert.equal(pastedJpeg.inputs[0].blob.type, "image/png");
assert.equal(pastedJpeg.inputs[0].reencoded, true);
assert.deepEqual(adapters.lastEncodedPixels, jpegFile.testPixels, "clipboard normalization keeps decoded bitmap pixels unchanged");

const order = [];
const serialAdapters = {
  ...adapters,
  uuid: () => `00000000-0000-4000-8000-${String(++uuidCount).padStart(12, "0")}`,
  decode: async (entry, options) => { order.push(`start-${entry.marker}`); await new Promise((resolve) => setTimeout(resolve, entry.delay)); order.push(`end-${entry.marker}`); return adapters.decode(entry, options); },
};
const imageA = blob(pngBytes, "image/png"); imageA.marker = "a"; imageA.delay = 4;
const imageB = blob(makePng(5), "image/png"); imageB.marker = "b"; imageB.delay = 0;
const multiPaste = clipboardEvent([imageA, imageB]);
const multi = await captureFromPaste(multiPaste, context, serialAdapters);
assert.deepEqual(order, ["start-a", "end-a", "start-b", "end-b"], "multi-image decoding remains serial and in clipboard order");
assert.equal(multi.inputs.length, 2);
assert.notEqual(multi.inputs[0].metadata.captureId, multi.inputs[1].metadata.captureId);
assert.equal(multi.inputs[0].metadata.batchId, multi.inputs[1].metadata.batchId);

const tooManyPaste = clipboardEvent(Array.from({ length: captureLimits.MAX_BATCH_FRAMES + 1 }, () => pngFile));
await rejectsCode(captureFromPaste(tooManyPaste, context, adapters), "batch_too_large");
assert.equal(tooManyPaste.wasPrevented(), true);
const tooLargeBatch = clipboardEvent([oversized, oversized]);
await rejectsCode(captureFromPaste(tooLargeBatch, context, adapters), "batch_bytes_exceeded");

const queue = new CaptureQueue();
queue.append([firstPng]);
assert.equal(queue.length, 1);
assert.throws(() => queue.append(Array.from({ length: captureLimits.MAX_BATCH_FRAMES }, () => secondPng)), (error) => error.code === "queue_full");
assert.equal(queue.length, 1, "rejecting a new over-limit batch preserves existing drafts");
assert.equal(queue.remove(firstPng.metadata.captureId), true);
assert.equal(queue.length, 0);

const revoked = [];
let objectUrlId = 0;
const registry = new PreviewRegistry({ createObjectURL: () => `blob:test-${++objectUrlId}`, revokeObjectURL: (url) => revoked.push(url) });
const url = registry.create(pngFile);
assert.equal(registry.revoke(url), true);
assert.deepEqual(revoked, [url]);
registry.create(pngFile); registry.create(jpegFile); registry.clear();
assert.equal(registry.size, 0);
assert.equal(revoked.length, 3, "preview URLs are released on removal/cleanup");

const target = (kind) => ({ closest: (selector) => {
  if (kind === "input" && selector.includes("input")) return {};
  if (kind === "textarea" && selector.includes("textarea")) return {};
  if (kind === "contenteditable" && selector.includes("[contenteditable]")) return {};
  if (kind === "textbox" && selector.includes("[role='textbox']")) return {};
  return null;
} });
assert.equal(isEditableTarget(target("button")), false);
for (const kind of ["input", "textarea", "contenteditable", "textbox"]) {
  assert.equal(isEditableTarget(target(kind)), true, `${kind} focus keeps normal paste routing`);
}

console.log(JSON.stringify({
  ok: true,
  filePngBytesUnchanged: true,
  fileFidelityMetadata: true,
  nonPngToLosslessPng: true,
  clipboardPngFidelityUnknown: true,
  clipboardNonPngFidelityUnknown: true,
  dimensionsAndMetadata: true,
  multiImageSerial: true,
  maxFrames: captureLimits.MAX_BATCH_FRAMES,
  maxBatchBytes: captureLimits.MAX_BATCH_BYTES,
  queuePreservesExistingOnOverflow: true,
  previewCleanup: true,
  ordinaryPasteRouting: true,
  inactiveContextPastePreserved: true,
}, null, 2));
