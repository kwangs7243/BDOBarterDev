import assert from "node:assert/strict";
import { CaptureError, CaptureQueue, ScreenCaptureSession } from "../frontend/js/capture.js";

class EventHub {
  #listeners = new Map();
  addEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }
  removeEventListener(type, listener) { this.#listeners.get(type)?.delete(listener); }
  get listenerCount() { return [...this.#listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
  dispatch(type) { for (const listener of [...(this.#listeners.get(type) ?? [])]) listener({ type }); }
}

const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
let nextId = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;

function makeRig({ settings = { width: 1920, height: 1080 }, resizeOnDraw = false, rejectPermission = false, includeAudio = false, supportsFrameCallback = true, frameCallbackStalls = false, frameTimeoutMs = 100 } = {}) {
  const states = [];
  const tracks = [];
  const videos = [];
  const canvases = [];
  const requestOptions = [];
  const lifecycle = new EventHub();
  const document = { body: { append(video) { video.attached = true; } }, createElement(kind) {
    if (kind === "video") {
      const callbacks = new Map();
      let callbackId = 0;
      const video = {
        readyState: 2, paused: false, videoWidth: 640, videoHeight: 360, muted: false,
        style: {}, srcObject: null,
        setAttribute() {}, play: async () => {}, pause() { this.paused = true; }, remove() { this.removed = true; },
        ...(supportsFrameCallback ? { requestVideoFrameCallback(callback) {
          const id = ++callbackId;
          if (!frameCallbackStalls) {
            const timer = setTimeout(() => { callbacks.delete(id); callback(performance.now(), { mediaTime: 7.25, presentedFrames: 42 }); }, 0);
            callbacks.set(id, timer);
          }
          return id;
        } } : {}),
        cancelVideoFrameCallback(id) { clearTimeout(callbacks.get(id)); callbacks.delete(id); },
      };
      videos.push(video);
      return video;
    }
    if (kind === "canvas") {
      const canvas = {
        width: 0, height: 0,
        getContext(type) {
          assert.equal(type, "2d");
          return { drawImage(...args) {
            canvas.draw = args;
            if (resizeOnDraw) videos.at(-1).videoWidth += 1;
          } };
        },
        toBlob(callback, type) { canvas.outputType = type; callback(new Blob([pngBytes], { type })); },
      };
      canvases.push(canvas);
      return canvas;
    }
    throw new Error(`unexpected element: ${kind}`);
  } };
  const mediaDevices = { getDisplayMedia(options) {
    requestOptions.push(options);
    if (rejectPermission) return Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    const videoTrack = {
      kind: "video", readyState: "live", muted: false, stopped: 0, listeners: new Map(),
      getSettings: () => settings ?? {},
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      removeEventListener(type, listener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); },
      stop() { this.stopped += 1; this.readyState = "ended"; },
      end() { this.readyState = "ended"; this.listeners.get("ended")?.(); },
    };
    tracks.push(videoTrack);
    const allTracks = includeAudio ? [videoTrack, { kind: "audio", stopped: 0, stop() { this.stopped += 1; } }] : [videoTrack];
    return Promise.resolve({ getTracks: () => allTracks, getVideoTracks: () => [videoTrack], getAudioTracks: () => allTracks.filter((track) => track.kind === "audio") });
  } };
  const session = new ScreenCaptureSession({ mediaDevices, document, lifecycleTarget: lifecycle, uuid, now: () => new Date("2026-09-29T00:00:00.000Z"), frameTimeoutMs });
  session.subscribe((snapshot) => states.push(snapshot.state));
  return { session, states, tracks, videos, canvases, requestOptions, lifecycle };
}

const warehouseContext = { taskType: "warehouse", baseRevision: 7, sessionId: null, sessionRevision: null, profileId: null, profileVersion: 1 };
const tradeContext = { ...warehouseContext, taskType: "trade" };

const disconnectedRig = makeRig();
await assert.rejects(disconnectedRig.session.captureFrame(warehouseContext), (error) => error instanceof CaptureError && error.code === "screen_not_connected");

const rig = makeRig();
const connectPromise = rig.session.connectScreen();
assert.deepEqual(rig.states, ["CONNECTING"], "connect enters CONNECTING while permission request is pending");
await connectPromise;
assert.equal(rig.session.state, "CONNECTED");
assert.deepEqual(rig.requestOptions, [{ video: { displaySurface: "window" }, audio: false }]);
assert.deepEqual(rig.states.slice(0, 2), ["CONNECTING", "CONNECTED"]);

const warehouseCapture = await rig.session.captureFrame(warehouseContext);
assert.deepEqual(rig.states.slice(2, 4), ["CAPTURING", "CONNECTED"]);
assert.equal(warehouseCapture.metadata.taskType, "warehouse");
assert.equal(warehouseCapture.metadata.sourceType, "browser-stream");
assert.deepEqual(warehouseCapture.metadata.frame, { width: 640, height: 360 });
assert.deepEqual(warehouseCapture.metadata.fidelity, { sourceWidth: 1920, sourceHeight: 1080, rescaled: true, evidence: "track-settings" });
assert.equal(warehouseCapture.blob.type, "image/png");
assert.deepEqual([rig.canvases[0].width, rig.canvases[0].height], [0, 0], "canvas backing store is cleared after encoding");
assert.deepEqual(rig.canvases[0].draw.slice(1), [0, 0, 640, 360], "the exact decoded video dimensions are drawn without scaling");
assert.deepEqual(warehouseCapture.observation, {
  freshnessEvidence: "request-video-frame-callback", mediaTime: 7.25, presentedFrames: 42,
  elapsedMs: warehouseCapture.observation.elapsedMs,
});
assert.equal(Number.isFinite(warehouseCapture.observation.elapsedMs), true);
assert.equal(rig.session.state, "CONNECTED", "capture returns to CONNECTED");
const tradeCapture = await rig.session.captureFrame(tradeContext);
assert.equal(tradeCapture.metadata.taskType, "trade");
assert.notEqual(tradeCapture.metadata.captureId, warehouseCapture.metadata.captureId);
const queue = new CaptureQueue();
queue.append([warehouseCapture]);
const beforeResizeLength = queue.length;
rig.videos[0].videoWidth = 640;
const resizingRig = makeRig({ resizeOnDraw: true });
await resizingRig.session.connectScreen();
await assert.rejects(resizingRig.session.captureFrame(warehouseContext), (error) => error instanceof CaptureError && error.code === "STREAM_RESIZING");
assert.equal(queue.length, beforeResizeLength, "a rejected resizing frame is never appended");
assert.equal(resizingRig.session.state, "CONNECTED", "resize rejection allows a deliberate later retry");

const unknownSettingsRig = makeRig({ settings: {} });
await unknownSettingsRig.session.connectScreen();
const unknownSettingsCapture = await unknownSettingsRig.session.captureFrame(tradeContext);
assert.deepEqual(unknownSettingsCapture.metadata.fidelity, { sourceWidth: null, sourceHeight: null, rescaled: null, evidence: "unknown" });
assert.deepEqual(unknownSettingsCapture.metadata.frame, { width: 640, height: 360 });

const fallbackRig = makeRig({ supportsFrameCallback: false });
await fallbackRig.session.connectScreen();
const fallbackCapture = await fallbackRig.session.captureFrame(warehouseContext);
assert.deepEqual(fallbackCapture.observation, {
  freshnessEvidence: "video-state", mediaTime: null, presentedFrames: null,
  elapsedMs: fallbackCapture.observation.elapsedMs,
});
assert.equal(Number.isFinite(fallbackCapture.observation.elapsedMs), true);

const staleFrameRig = makeRig({ frameCallbackStalls: true, frameTimeoutMs: 20 });
await staleFrameRig.session.connectScreen();
await assert.rejects(staleFrameRig.session.captureFrame(warehouseContext), (error) => error instanceof CaptureError && error.code === "screen_frame_stale");
assert.equal(staleFrameRig.session.state, "CONNECTED", "a freshness timeout does not create or queue a frame");

const deniedRig = makeRig({ rejectPermission: true });
await assert.rejects(deniedRig.session.connectScreen(), (error) => error.name === "NotAllowedError");
assert.equal(deniedRig.session.state, "DISCONNECTED");
assert.equal(deniedRig.session.reason, "permission-denied");
assert.equal(deniedRig.requestOptions.length, 1, "permission rejection does not retry automatically");
assert.deepEqual(deniedRig.requestOptions[0], { video: { displaySurface: "window" }, audio: false });

const audioRig = makeRig({ includeAudio: true });
await assert.rejects(audioRig.session.connectScreen(), (error) => error.code === "audio_track_unexpected");
assert.equal(audioRig.session.state, "DISCONNECTED", "an unexpected audio track is rejected");

const lifecycleRig = makeRig();
await lifecycleRig.session.connectScreen();
const oldTrack = lifecycleRig.tracks[0];
lifecycleRig.session.disconnectScreen("user");
assert.equal(oldTrack.stopped, 1);
assert.equal(lifecycleRig.videos[0].srcObject, null);
assert.equal(lifecycleRig.videos[0].removed, true);
lifecycleRig.session.disconnectScreen("user");
assert.equal(oldTrack.stopped, 1, "repeated disconnect is idempotent for tracks");
await lifecycleRig.session.connectScreen();
assert.equal(lifecycleRig.session.state, "CONNECTED", "explicit disconnect permits reconnect");
lifecycleRig.tracks[1].end();
assert.equal(lifecycleRig.session.state, "DISCONNECTED");
assert.equal(lifecycleRig.session.reason, "track-ended");
assert.equal(lifecycleRig.tracks[1].stopped, 1);
await lifecycleRig.session.connectScreen();
lifecycleRig.lifecycle.dispatch("pagehide");
assert.equal(lifecycleRig.session.state, "DISCONNECTED");
assert.equal(lifecycleRig.session.reason, "pagehide");
assert.equal(lifecycleRig.tracks[2].stopped, 1);
await lifecycleRig.session.connectScreen();
lifecycleRig.lifecycle.dispatch("beforeunload");
assert.equal(lifecycleRig.session.state, "DISCONNECTED");
assert.equal(lifecycleRig.session.reason, "beforeunload");
assert.equal(lifecycleRig.tracks[3].stopped, 1);

const disposedRig = makeRig();
const preview = { srcObject: null, play: async () => {}, pause() {} };
disposedRig.session.attachPreview(preview);
await disposedRig.session.connectScreen();
assert.equal(disposedRig.lifecycle.listenerCount, 2);
disposedRig.session.dispose();
assert.equal(disposedRig.lifecycle.listenerCount, 0, "dispose releases global lifecycle handlers");
assert.equal(disposedRig.tracks[0].stopped, 1);
assert.equal(preview.srcObject, null);
assert.equal(disposedRig.tracks[0].listeners.size, 0);
const disposedStateCount = disposedRig.states.length;
disposedRig.session.disconnectScreen();
assert.equal(disposedRig.states.length, disposedStateCount, "disposed subscriptions cannot retain UI callbacks");
disposedRig.session.dispose();
assert.equal(disposedRig.tracks[0].stopped, 1, "dispose is idempotent");
await assert.rejects(disposedRig.session.connectScreen(), { code: "screen_disposed" });
assert.equal(disposedRig.requestOptions.length, 1, "disposed sessions cannot request sharing again");
const pendingRig = makeRig();
const pendingConnect = pendingRig.session.connectScreen();
pendingRig.session.dispose();
await assert.rejects(pendingConnect, { code: "screen_disconnected" });
assert.equal(pendingRig.tracks[0].stopped, 1, "late permission result cannot keep a disposed stream alive");
assert.equal(pendingRig.lifecycle.listenerCount, 0);

console.log(JSON.stringify({
  ok: true,
  disposeHandlersPreviewsSubscriptionsAndPendingShare: "PASS",
  userInitiatedConnectRequest: "PASS",
  audioFalse: "PASS",
  connectAndPermissionLifecycle: "PASS",
  explicitWarehouseAndTradeFrameCapture: "PASS",
  deliveredSettingsFidelity: "PASS",
  unknownSettingsFidelity: "PASS",
  freshnessCallbackAndFrameDimensions: "PASS",
  freshnessFallbackRemainsUnclaimed: "PASS",
  stalledFrameCallbackRejected: "PASS",
  noFrameScaling: "PASS",
  canvasCleanup: "PASS",
  resizeRejectedWithoutQueueAppend: "PASS",
  explicitDisconnectTrackEndedPagehideBeforeunload: "PASS",
  idempotentDisconnectAndReconnect: "PASS",
  unexpectedAudioTrackRejected: "PASS",
}, null, 2));
