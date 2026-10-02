import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createTradeSourceEvidenceCache,
  locateTradeCropRef,
  projectTradeCropBoxToDisplay,
  TradeSourceEvidenceError,
} from "../frontend/js/trade-source-evidence.js";

const FIELDS = ["island", "fromItem", "reqAmount", "toItem", "count", "yield"];
const FRAME = { width: 12, height: 8 };
const BOXES = [
  { cropRefId: "crop-B", field: "island", box: { x: 0, y: 0, width: 3, height: 2 } },
  { cropRefId: "crop-A", field: "fromItem", box: { x: 4, y: 1, width: 2, height: 3 } },
  { cropRefId: "crop-C", field: "yield", box: { x: 9, y: 5, width: 3, height: 3 } },
];

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function rgbPattern() {
  const rgba = new Uint8Array(FRAME.width * FRAME.height * 4);
  for (let pixel = 0; pixel < FRAME.width * FRAME.height; pixel += 1) {
    const offset = pixel * 4;
    rgba[offset] = (pixel * 17 + 3) % 256;
    rgba[offset + 1] = (pixel * 29 + 7) % 256;
    rgba[offset + 2] = (pixel * 43 + 11) % 256;
    rgba[offset + 3] = 255;
  }
  return rgba;
}

function rgbaToRgb(rgba) {
  const rgb = new Uint8Array((rgba.length / 4) * 3);
  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
    rgb[target] = rgba[source];
    rgb[target + 1] = rgba[source + 1];
    rgb[target + 2] = rgba[source + 2];
  }
  return rgb;
}

function cropRgb(rgb, box) {
  const crop = new Uint8Array(box.width * box.height * 3);
  for (let y = 0; y < box.height; y += 1) {
    const start = ((box.y + y) * FRAME.width + box.x) * 3;
    crop.set(rgb.subarray(start, start + box.width * 3), y * box.width * 3);
  }
  return crop;
}

function makeFixture({ captureId = "capture-one", rgba = rgbPattern(),
  imageBytes = [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4],
  cropDefinitions = BOXES } = {}) {
  const blob = new Blob([new Uint8Array(imageBytes)], { type: "image/png" });
  const capture = {
    metadata: { captureId, frame: { ...FRAME }, sourceType: "file", fidelity: {
      sourceWidth: FRAME.width, sourceHeight: FRAME.height, rescaled: false, evidence: "file-metadata",
    } },
    blob,
    sha256: hash(new Uint8Array(imageBytes)),
    sourceSha256: null,
    reencoded: false,
    bytes: blob.size,
  };
  const rgb = rgbaToRgb(rgba);
  const cropByField = new Map(cropDefinitions.map((item) => [item.field, item]));
  const fields = FIELDS.map((field) => {
    const definition = cropByField.get(field);
    const cropRefs = definition ? [{
      cropRefId: definition.cropRefId,
      sourceRowId: "source-row-one",
      captureId,
      field,
      bitmapSha256: hash(rgb),
      frame: { ...FRAME },
      coordinateSpace: "CAPTURE_BITMAP_PIXELS",
      box: { ...definition.box },
      pixelHashBasis: "RGB8_ROW_MAJOR_V1",
      pixelSha256: hash(cropRgb(rgb, definition.box)),
      pngArtifactSha256: null,
    }] : [];
    return { field, rawText: field, rawNumeric: field === "yield" ? 48 : null,
      readerStatus: "READ", confidence: "0.9", cropRefs };
  });
  const rawEvidence = {
    schemaVersion: 2,
    recognitionBatchId: "batch-one",
    captures: [{ captureId, captureOrdinal: 1, imageSha256: hash(new Uint8Array(imageBytes)),
      bitmapSha256: hash(rgb), sourceType: "FILE", frame: { ...FRAME },
      sourceFidelity: { sourceWidth: null, sourceHeight: null, rescaled: null, evidence: "unknown" },
      reencoded: false, completeRowCount: 1 }],
    sourceRows: [{ sourceRowId: "source-row-one", captureId, ordinal: 0,
      rowBox: { x: 0, y: 0, width: FRAME.width, height: FRAME.height }, fields }],
    edgeSegments: [],
  };
  return { capture, rawEvidence, rgba, rgb };
}

function makeAdapters(fixture, { onDecode, encodeDisplayCrop } = {}) {
  return {
    sha256Bytes: async (bytes) => hash(bytes),
    decodePngToRgba: async (blob) => {
      onDecode?.(blob);
      assert.equal(blob, fixture.capture.blob);
      return { width: FRAME.width, height: FRAME.height, rgbaBytes: new Uint8Array(fixture.rgba) };
    },
    encodeDisplayCrop: encodeDisplayCrop ?? (async ({ rgbBytes }) => new Blob([rgbBytes], { type: "image/png" })),
  };
}

function makeCache(fixture, options = {}) {
  return createTradeSourceEvidenceCache(makeAdapters(fixture, options));
}

function cloneRaw(rawEvidence) { return structuredClone(rawEvidence); }

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof TradeSourceEvidenceError && error.code === code);
}

{
  const fixture = makeFixture();
  let decodeCount = 0;
  const cache = makeCache(fixture, { onDecode: () => { decodeCount += 1; } });
  const inputQueue = [fixture.capture];
  cache.retainCaptures(inputQueue);
  inputQueue.length = 0;
  const rawBefore = cloneRaw(fixture.rawEvidence);
  const captureMetadataBefore = structuredClone(fixture.capture.metadata);
  const availability = await cache.verifyRawEvidence(fixture.rawEvidence);
  assert.deepEqual(availability, [
    { cropRefId: "crop-B", state: "IN_MEMORY" },
    { cropRefId: "crop-A", state: "IN_MEMORY" },
    { cropRefId: "crop-C", state: "IN_MEMORY" },
  ], "availability follows first crop occurrence rather than alphabetical order");
  assert.equal(decodeCount, 1, "one decode per capture for a full verification pass");
  assert.ok(availability.every((item) => Object.keys(item).join(",") === "cropRefId,state"));
  assert.ok(availability.every((item) => item.state !== "DURABLE"));
  assert.deepEqual(fixture.rawEvidence, rawBefore);
  assert.deepEqual(fixture.capture.metadata, captureMetadataBefore);
  assert.equal(fixture.capture.blob.type, "image/png");

  const located = locateTradeCropRef(fixture.rawEvidence, "crop-A");
  assert.equal(located.capture, fixture.rawEvidence.captures[0]);
  assert.equal(located.sourceRow, fixture.rawEvidence.sourceRows[0]);
  assert.equal(located.field.field, "fromItem");
  assert.equal(located.cropRef.cropRefId, "crop-A");
  await assert.rejects(async () => locateTradeCropRef(fixture.rawEvidence, "unknown"),
    (error) => error.code === "CROP_REF_NOT_FOUND");

  const crop = await cache.getVerifiedCrop("crop-A");
  assert.deepEqual(crop.rgbBytes, cropRgb(fixture.rgb, BOXES[1].box));
  assert.equal(crop.pixelSha256, fixture.rawEvidence.sourceRows[0].fields[1].cropRefs[0].pixelSha256);
  const display = await cache.createDisplayCrop("crop-A");
  assert.deepEqual({ cropRefId: display.cropRefId, captureId: display.captureId, field: display.field,
    width: display.width, height: display.height, pixelSha256: display.pixelSha256, displayOnly: display.displayOnly }, {
    cropRefId: "crop-A", captureId: "capture-one", field: "fromItem", width: 2, height: 3,
    pixelSha256: crop.pixelSha256, displayOnly: true,
  });
  assert.equal(display.blob.type, "image/png");
  assert.equal(fixture.rawEvidence.sourceRows[0].fields[1].cropRefs[0].pngArtifactSha256, null);
  assert.equal(decodeCount, 3, "each explicit crop fetch re-verifies pixels without retaining a decoded full frame");
}

{
  const fixture = makeFixture();
  let decodeCount = 0;
  const cache = makeCache(fixture, { onDecode: () => { decodeCount += 1; } });
  assert.ok((await cache.buildPixelAvailability(fixture.rawEvidence)).every((item) => item.state === "MISSING"));
  assert.equal(decodeCount, 0);
  await rejectsCode(cache.createDisplayCrop("crop-B"), "CROP_MISSING");
  cache.retainCapture(fixture.capture);
  assert.ok((await cache.buildPixelAvailability(fixture.rawEvidence)).every((item) => item.state === "IN_MEMORY"));
  assert.equal(decodeCount, 1, "MISSING is not tombstoned and becomes verifiable after retain");
}

{
  const fixture = makeFixture();
  const cache = makeCache(fixture);
  cache.retainCapture(fixture.capture);
  await cache.verifyRawEvidence(fixture.rawEvidence);
  assert.equal(cache.releaseCapture("capture-one"), true);
  assert.ok((await cache.buildPixelAvailability(fixture.rawEvidence)).every((item) => item.state === "EXPIRED"));
  await rejectsCode(Promise.resolve().then(() => cache.retainCapture(fixture.capture)), "CAPTURE_ID_EXPIRED");
  await rejectsCode(cache.createDisplayCrop("crop-A"), "CROP_EXPIRED");
}

{
  const fixture = makeFixture({ imageBytes: [1, 2, 3, 4] });
  let decodeCount = 0;
  const cache = makeCache(fixture, { onDecode: () => { decodeCount += 1; } });
  cache.retainCapture(fixture.capture);
  assert.ok((await cache.verifyRawEvidence(fixture.rawEvidence)).every((item) => item.state === "INVALID"),
    "an image/png MIME claim without a PNG file signature is invalid");
  assert.equal(decodeCount, 0);
}

{
  const fixture = makeFixture();
  const cache = makeCache(fixture);
  cache.retainCapture(fixture.capture);
  cache.clear();
  assert.ok((await cache.buildPixelAvailability(fixture.rawEvidence)).every((item) => item.state === "EXPIRED"));
  assert.equal(cache.releaseCapture("never-retained"), false);
}

{
  const fixture = makeFixture();
  const wrongBlob = new Blob(["wrong"], { type: "image/png" });
  const other = { ...fixture.capture, blob: wrongBlob, bytes: wrongBlob.size };
  let decodeCount = 0;
  const cache = makeCache(fixture, { onDecode: () => { decodeCount += 1; } });
  cache.retainCapture(other);
  assert.ok((await cache.verifyRawEvidence(fixture.rawEvidence)).every((item) => item.state === "INVALID"));
  assert.equal(decodeCount, 0, "a raw PNG hash mismatch blocks decode from becoming evidence");
  await rejectsCode(Promise.resolve().then(() => cache.retainCapture(fixture.capture)), "CAPTURE_ID_INVALID");
}

{
  const fixture = makeFixture();
  fixture.rawEvidence.captures[0].bitmapSha256 = "0".repeat(64);
  for (const field of fixture.rawEvidence.sourceRows[0].fields) {
    for (const cropRef of field.cropRefs) cropRef.bitmapSha256 = "0".repeat(64);
  }
  let decodeCount = 0;
  const cache = makeCache(fixture, { onDecode: () => { decodeCount += 1; } });
  cache.retainCapture(fixture.capture);
  assert.ok((await cache.verifyRawEvidence(fixture.rawEvidence)).every((item) => item.state === "INVALID"));
  assert.equal(decodeCount, 1);
}

{
  const fixture = makeFixture();
  const fields = fixture.rawEvidence.sourceRows[0].fields;
  fields[0].cropRefs[0].pixelSha256 = "0".repeat(64);
  const cache = makeCache(fixture);
  cache.retainCapture(fixture.capture);
  const availability = await cache.verifyRawEvidence(fixture.rawEvidence);
  assert.deepEqual(availability, [
    { cropRefId: "crop-B", state: "INVALID" },
    { cropRefId: "crop-A", state: "IN_MEMORY" },
    { cropRefId: "crop-C", state: "IN_MEMORY" },
  ], "one bad crop hash does not invalidate sibling crops from a verified bitmap");
}

{
  const fixture = makeFixture();
  fixture.rgba[3] = 254;
  const cache = makeCache(fixture);
  cache.retainCapture(fixture.capture);
  assert.ok((await cache.verifyRawEvidence(fixture.rawEvidence)).every((item) => item.state === "INVALID"));
}

{
  const fixture = makeFixture();
  const cache = makeCache(fixture);
  cache.retainCapture({ ...fixture.capture, metadata: { ...fixture.capture.metadata,
    frame: { width: FRAME.width + 1, height: FRAME.height } } });
  assert.ok((await cache.verifyRawEvidence(fixture.rawEvidence)).every((item) => item.state === "INVALID"));
}

{
  const fixture = makeFixture();
  const cache = makeCache(fixture);
  cache.retainCapture(fixture.capture);
  fixture.rawEvidence.sourceRows[0].fields[0].cropRefs[0].box.x = -1;
  const availability = await cache.verifyRawEvidence(fixture.rawEvidence);
  assert.equal(availability[0].state, "INVALID");
  assert.deepEqual(availability.slice(1).map((item) => item.state), ["IN_MEMORY", "IN_MEMORY"]);
  await rejectsCode(cache.createDisplayCrop("crop-B"), "CROP_INVALID");
}

{
  const fixture = makeFixture();
  const cache = makeCache(fixture);
  const invalidSecond = { ...fixture.capture, metadata: { ...fixture.capture.metadata, captureId: "capture-two" },
    blob: new Blob(["invalid"], { type: "image/jpeg" }) };
  await rejectsCode(Promise.resolve().then(() => cache.retainCaptures([fixture.capture, invalidSecond])), "INVALID_CAPTURE_INPUT");
  assert.ok((await cache.buildPixelAvailability(fixture.rawEvidence)).every((item) => item.state === "MISSING"),
    "failed retainCaptures does not partially retain earlier queue entries");
}

{
  const fixture = makeFixture();
  const cache = makeCache(fixture);
  cache.retainCapture(fixture.capture);
  await cache.verifyRawEvidence(fixture.rawEvidence);
  fixture.rawEvidence.sourceRows[0].fields[0].cropRefs[0].box.x = 1;
  await rejectsCode(cache.createDisplayCrop("crop-B"), "RAW_EVIDENCE_CHANGED_REVERIFY_REQUIRED");
}

{
  const fixture = makeFixture();
  const duplicateCrop = cloneRaw(fixture.rawEvidence);
  duplicateCrop.sourceRows[0].fields[1].cropRefs[0].cropRefId = "crop-B";
  const cache = makeCache(fixture);
  await rejectsCode(cache.verifyRawEvidence(duplicateCrop), "INVALID_RAW_EVIDENCE");

  const duplicateSource = cloneRaw(fixture.rawEvidence);
  duplicateSource.sourceRows.push(structuredClone(duplicateSource.sourceRows[0]));
  duplicateSource.captures[0].completeRowCount = 2;
  await rejectsCode(cache.verifyRawEvidence(duplicateSource), "INVALID_RAW_EVIDENCE");
}

{
  const fixture = makeFixture();
  const raw = cloneRaw(fixture.rawEvidence);
  raw.sourceRows[0].fields[0].cropRefs[0].sourceRowId = "other-row";
  const cache = makeCache(fixture);
  cache.retainCapture(fixture.capture);
  assert.equal((await cache.verifyRawEvidence(raw))[0].state, "INVALID", "crop owner mismatch is invalid");
}

{
  const fixture = makeFixture();
  const raw = cloneRaw(fixture.rawEvidence);
  raw.sourceRows[0].fields[0].cropRefs[0].bitmapSha256 = "0".repeat(64);
  const cache = makeCache(fixture);
  cache.retainCapture(fixture.capture);
  assert.equal((await cache.verifyRawEvidence(raw))[0].state, "INVALID", "CropRef bitmap binding is enforced");
}

{
  const fixture = makeFixture();
  const cache = makeCache(fixture);
  cache.retainCaptures([fixture.capture]);
  const alternateBlob = new Blob(["different"], { type: "image/png" });
  const alternate = { ...fixture.capture, blob: alternateBlob, bytes: alternateBlob.size };
  await rejectsCode(Promise.resolve().then(() => cache.retainCapture(alternate)), "CAPTURE_ID_ALREADY_BOUND");
  assert.ok((await cache.verifyRawEvidence(fixture.rawEvidence)).every((item) => item.state === "IN_MEMORY"));
}

{
  const left = { frame: { width: 1200, height: 800 }, coordinateSpace: "CAPTURE_BITMAP_PIXELS",
    box: { x: 300, y: 200, width: 240, height: 160 } };
  const original = structuredClone(left.box);
  assert.deepEqual(projectTradeCropBoxToDisplay(left, { width: 600, height: 400 }),
    { x: 150, y: 100, width: 120, height: 80 });
  assert.deepEqual(left.box, original, "display projection never mutates evidence geometry");
}

console.log("trade_source_evidence_regression: PASS · real-byte hash binding, one decode per capture, crop parity, lifecycle, tamper rejection, display-only crop");
