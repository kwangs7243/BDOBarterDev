import assert from "node:assert/strict";
import { CaptureError, DEFAULT_TRADE_ROI, ScreenCaptureSession, displayedVideoContentRect, moveNormalizedRegion, normalizeRegion, regionToSourceRect, resizeNormalizedRegion } from "../frontend/js/capture.js";

assert.deepEqual(regionToSourceRect({ x: .1, y: .2, width: .3, height: .4 }, 1920, 1080), { x: 192, y: 216, width: 576, height: 433 }, "fractional bottom edge uses ceil");
assert.deepEqual(regionToSourceRect({ x: .999, y: .999, width: .001, height: .001 }, 3, 3), { x: 2, y: 2, width: 1, height: 1 }, "minor edge rounding clamps inside the frame");
for (const invalid of [{ x: 0, y: 0, width: 0, height: 1 }, { x: 0, y: 0, width: 1, height: 0 }, { x: -.1, y: 0, width: .2, height: .2 }, { x: 0, y: 0, width: 1.1, height: .2 }, { x: NaN, y: 0, width: .2, height: .2 }, { x: 0, y: 0, width: Infinity, height: .2 }]) {
  assert.throws(() => normalizeRegion(invalid), (error) => error instanceof CaptureError && error.code === "invalid_capture_region");
}
assert.deepEqual(regionToSourceRect({ x: 0, y: 0, width: .00001, height: .00001 }, 1, 1), { x: 0, y: 0, width: 1, height: 1 }, "pixel mapping preserves a rounded 1px extent; capture policy applies the minimum");
assert.deepEqual(DEFAULT_TRADE_ROI, { x: .1, y: .1, width: .8, height: .8 });
const stage = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 600, height: 600 }) };
const video = { videoWidth: 1920, videoHeight: 1080 };
assert.deepEqual(displayedVideoContentRect(video, stage), { left: 10, top: 151.25, width: 600, height: 337.5 }, "contain letterbox content is centered vertically and independent of DPR");
let roi = { x: .1, y: .1, width: .8, height: .8 };
roi = moveNormalizedRegion(roi, .5, -.5, .1, .1);
assert.ok(Math.abs(roi.x - .2) < 1e-12 && roi.y === 0 && roi.width === .8 && roi.height === .8, "move clamps inside normalized content bounds");
for (const handle of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
  const result = resizeNormalizedRegion({ x: .2, y: .2, width: .6, height: .6 }, handle, .1, .1, .15, .15);
  assert.ok(result.width >= .15 && result.height >= .15, `${handle} retains minimum size`);
  assert.ok(result.x >= 0 && result.y >= 0 && result.x + result.width <= 1 && result.y + result.height <= 1, `${handle} clamps to bounds`);
}
const corner = resizeNormalizedRegion({ x: .2, y: .2, width: .6, height: .6 }, "nw", .9, .9, .15, .15); assert.ok(Math.abs(corner.x - .65) < 1e-12 && Math.abs(corner.y - .65) < 1e-12 && Math.abs(corner.width - .15) < 1e-12 && Math.abs(corner.height - .15) < 1e-12, "corner resize holds opposite edge and enforces minimum");

class Hub { addEventListener() {} removeEventListener() {} }
const png = new Blob([Uint8Array.from([137,80,78,71,13,10,26,10,1,2,3])], { type: "image/png" });
const videos = []; const canvases = []; let dimensionRace = false;
const document = { body: { append() {} }, createElement(kind) {
  if (kind === "video") { const video = { videoWidth: 101, videoHeight: 51, readyState: 2, paused: false, muted: false, style: {}, srcObject: null, setAttribute() {}, play: async () => {}, pause() {}, remove() {}, requestVideoFrameCallback(callback) { setTimeout(() => callback(1, { mediaTime: 2, presentedFrames: 3 }), 0); return 1; }, cancelVideoFrameCallback() {} }; videos.push(video); return video; }
  if (kind === "canvas") { const canvas = { width: 0, height: 0, getContext() { return { drawImage(...args) { canvas.draw = args; if (dimensionRace) videos[0].videoWidth++; } }; }, toBlob(callback, type) { canvas.outputType = type; callback(new Blob([png], { type })); } }; canvases.push(canvas); return canvas; }
  throw new Error(kind);
} };
const track = { kind: "video", readyState: "live", getSettings: () => ({ width: 202, height: 102 }), addEventListener() {}, removeEventListener() {}, stop() { this.readyState = "ended"; } };
const stream = { getTracks: () => [track] };
let id = 0; const session = new ScreenCaptureSession({ mediaDevices: { getDisplayMedia: async () => stream }, document, lifecycleTarget: new Hub(), uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`, frameTimeoutMs: 100 });
const preview = { srcObject: null, play: async () => {}, pause() {} };
assert.equal(session.attachPreview(preview), false);
await session.connectScreen();
assert.equal(preview.srcObject, stream, "preview attaches to the exact shared stream");
const context = { taskType: "trade", baseRevision: 0, sessionId: null, sessionRevision: null, profileId: null, profileVersion: 1 };
const region = { x: .1, y: .2, width: .3, height: .4 };
const batchId = "same-screen-batch";
const capture = await session.captureRegion(context, region, batchId);
assert.deepEqual(capture.metadata.frame, { width: 31, height: 21 });
assert.equal(capture.metadata.batchId, batchId);
assert.equal(capture.metadata.sourceType, "browser-stream");
assert.deepEqual(capture.regionEvidence, { normalized: region, sourceRect: { x: 10, y: 10, width: 31, height: 21 }, sourceFrame: { width: 101, height: 51 } });
assert.deepEqual(canvases[0].draw, [videos[0], 10, 10, 31, 21, 0, 0, 31, 21], "source and destination dimensions match; no scaling");
assert.equal(canvases[0].outputType, "image/png");
assert.equal(capture.blob.type, "image/png");
const second = await session.captureRegion(context, { x: 0, y: 0, width: .5, height: .5 }, batchId);
assert.notEqual(second.metadata.captureId, capture.metadata.captureId);
assert.equal(second.metadata.batchId, capture.metadata.batchId);
assert.equal(session.state, "CONNECTED");
await assert.rejects(session.captureRegion(context, { x: 0, y: 0, width: .01, height: .01 }, batchId), (error) => error.code === "capture_region_too_small");
const full = await session.captureFrame({ ...context, taskType: "warehouse" });
assert.deepEqual(full.metadata.frame, { width: 101, height: 51 }, "full-frame API still captures the complete source frame");
assert.deepEqual(canvases[2].draw.slice(1), [0, 0, 101, 51]);
dimensionRace = true;
await assert.rejects(session.captureRegion(context, region, batchId), (error) => error.code === "STREAM_RESIZING");
assert.equal(session.state, "CONNECTED", "resize race rejects this capture but preserves the connection");
dimensionRace = false;
session.detachPreview(preview);
assert.equal(preview.srcObject, null);
session.disconnectScreen("user");
console.log(JSON.stringify({ ok: true, regionConversion: "PASS", fractionalFloorCeilAndClamp: "PASS", invalidRegions: "PASS", letterboxMapping: "PASS", normalizedRoiMoveAndEightWayResize: "PASS", minimumAndBounds: "PASS", sharedPreviewAndStream: "PASS", roiOnlyLosslessPngNoScaling: "PASS", repeatedBatchIdentity: "PASS", fullFrameWarehousePreserved: "PASS", resizingRejected: "PASS" }, null, 2));
