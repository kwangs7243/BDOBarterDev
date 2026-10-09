import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { NativeCaptureReceiver } from "../frontend/js/native-capture-ui.js";
import { CaptureQueue, captureFromNative } from "../frontend/js/capture.js";

const blob = new Blob([Uint8Array.of(137,80,78,71,13,10,26,10,0,0,0,0,73,69,78,68,0,0,0,0)], { type: "image/png" });
const sha256 = createHash("sha256").update(Buffer.from(await blob.arrayBuffer())).digest("hex");
const context = { taskType: "trade", baseRevision: 7, sessionId: null, sessionRevision: null };
const packet = (generation=1, task="trade") => ({ generation, bytes: blob.size, sha256,
  metadata: { version: 1, sourceType: "native-screen", taskType: task, captureId: randomUUID(),
    context: { baseRevision: 7, sessionId: null, sessionRevision: null },
    frame: { width: 80, height: 50 }, fidelity: { evidence: "native-pixels", rescaled: false },
    nativeEvidence: { provider: "gdi" }, capturedAt: "2026-10-09T00:00:00Z" } });
const decode = { decode: async () => ({ width: 80, height: 50, close() {} }) };
let active = true, busy = false;
const trade = new CaptureQueue(), warehouse = new CaptureQueue();
const adapter = { isActive: () => active, getState: () => ({ busy }), getContext: () => context, accept: captures => trade.append(captures) };
const receiver = new NativeCaptureReceiver(); receiver.activate("trade", 1);
let reads = 0; const getBlob = async () => { reads++; return blob; };
const first = packet();
assert.equal(await receiver.receive(first, getBlob, adapter, decode), true);
assert.equal(trade.length, 1); assert.equal(warehouse.length, 0);
assert.deepEqual(await trade.items[0].blob.arrayBuffer(), await blob.arrayBuffer()); assert.equal(trade.items[0].metadata.captureId, first.metadata.captureId);
assert.equal(trade.items[0].metadata.sourceType, "native-screen");
assert.equal(await receiver.receive(first, getBlob, adapter, decode), true);
assert.equal(trade.length, 1); assert.equal(reads, 1, "retry acknowledges without decoding or inserting again");
assert.equal(await receiver.receive(packet(0), getBlob, adapter, decode), false);
assert.equal(await receiver.receive(packet(1,"warehouse"), getBlob, adapter, decode), false);
busy = true; assert.equal(await receiver.receive(packet(), getBlob, adapter, decode), false); busy = false;
active = false; const closedPacket = packet(); assert.equal(await receiver.receive(closedPacket, getBlob, adapter, decode), true); trade.remove(closedPacket.metadata.captureId); active = true;
let resolveBlob;
const delayed = receiver.receive(packet(), () => new Promise(resolve => { resolveBlob = resolve; }), adapter, decode);
receiver.activate("warehouse", 2); resolveBlob(blob);
assert.equal(await delayed, false); assert.equal(trade.length, 1);
const warehouseAdapter = { ...adapter, getContext: () => ({ ...context, taskType: "warehouse" }), accept: captures => warehouse.append(captures) };
assert.equal(await receiver.receive(packet(2,"warehouse"), getBlob, warehouseAdapter, decode), true);
assert.equal(warehouse.length, 1); assert.equal(trade.length, 1);
await assert.rejects(captureFromNative(blob, { ...packet(), sha256: "wrong" }, context, decode), { code: "invalid_native_image" });
await assert.rejects(captureFromNative(blob, packet(), { ...context, baseRevision: 8 }, decode), { code: "stale_capture" });
await assert.rejects(captureFromNative(blob, packet(), context, { decode: async () => ({ width: 79, height: 50 }) }), { code: "invalid_native_image" });
receiver.deactivate(); assert.equal(await receiver.receive(packet(2,"warehouse"), getBlob, warehouseAdapter, decode), false);
const full = new CaptureQueue(); full.append(Array.from({ length: 100 }, () => trade.items[0]));
receiver.activate("trade", 3);
const overflow = packet(3);
await assert.rejects(receiver.receive(overflow, getBlob, { ...adapter, accept: captures => full.append(captures) }, decode), { code: "queue_full" });
assert.equal(full.length, 100); assert.equal(receiver.seen.has(overflow.metadata.captureId), false);
console.log("PASS native capture receiver: queue routing, PNG identity, duplicate/stale/busy/closed/overflow");
