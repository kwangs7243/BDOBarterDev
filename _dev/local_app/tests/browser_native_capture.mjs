import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = process.env.BDO_TEST_URL ?? "http://127.0.0.1:18786/";
const python = process.env.PYTHON ?? "python";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-native-capture-browser-"));
const database = join(profile, "isolated.sqlite3");
const fixture = resolve(root, "local_app/tests/fixtures/warehouse_patch/barter_only.png");
const port = new URL(baseUrl).port || "18768";
const pythonCode = `
from local_app.backend.app import create_app
from local_app.native_capture import NativeCaptureController
from local_app.tests.backend.test_native_capture import FakePlatform
from pathlib import Path
from flask import jsonify
import threading
platform=FakePlatform()
platform.hotkey_registered=True
controller=NativeCaptureController(platform,Path(r'${profile}')/'profiles.json')
def select(target,generation):
    threading.Timer(.05,lambda:controller.selected(generation,{'x':100,'y':80,'width':80,'height':50},dict(platform.geo))).start()
platform.select=select
app=create_app(r'${database}',testing=True,native_capture=controller)
ignore_ack=[True]
original_ack=controller.acknowledge
def ack(receiver,generation,capture_id):
    if ignore_ack[0]: ignore_ack[0]=False
    else: original_ack(receiver,generation,capture_id)
controller.acknowledge=ack
@app.post('/__test__/hotkey')
def hotkey(): return jsonify({'captured':controller.on_hotkey()})
@app.post('/__test__/finish')
def finish(): controller.finish(); return jsonify(ok=True)
@app.post('/__test__/maintenance')
def maintenance(): controller.maintenance(); return jsonify(controller.snapshot())
@app.post('/__test__/context-change')
def context_change():
    changed={**controller.context,'baseRevision':controller.context['baseRevision']+1}
    return jsonify(controller.heartbeat(controller.receiver,controller.generation,0,0,False,changed))
app.run(host='127.0.0.1',port=${Number(port)},use_reloader=False,threaded=True)
`;
let server;
let chrome;
let socket;
let send;

async function waitFor(predicate, label, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

try {
  server = spawn(python, ["-B", "-c", pythonCode], { cwd: root, stdio: "ignore", windowsHide: true, env: { ...process.env, LOCALAPPDATA: profile, PYTHONDONTWRITEBYTECODE: "1" } });
  await waitFor(async () => { try { return (await fetch(`${baseUrl}api/health`)).ok; } catch { return false; } }, "isolated localhost server");
  chrome = spawn(chromePath, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking", "--remote-debugging-port=0", "--remote-allow-origins=*", `--user-data-dir=${join(profile, "chrome-profile")}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  const activePortPath = join(profile, "chrome-profile", "DevToolsActivePort");
  const activePortText = await waitFor(async () => { try { return await readFile(activePortPath, "utf8"); } catch { return false; } }, "Chrome DevTools endpoint");
  const debugPort = activePortText.trim().split(/\r?\n/)[0];
  const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(baseUrl)}`, { method: "PUT" });
  assert.equal(targetResponse.ok, true, "Chrome creates the app target");
  const target = await targetResponse.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve: resolveMessage, reject, timer } = pending.get(message.id);
    clearTimeout(timer);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolveMessage(message.result);
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Chrome connection closed")); }
    pending.clear();
  });
  send = (method, params = {}) => new Promise((resolveMessage, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome command timed out: ${method}`)); }, 10000);
    pending.set(id, { resolve: resolveMessage, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  if (process.env.BDO_NATIVE_SCREENSHOT) await send("Emulation.setDeviceMetricsOverride", { width: 1477, height: 831, deviceScaleFactor: 1.3, mobile: false });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");
  await waitFor(async () => (await evaluate("document.querySelector('#app-content')?.getAttribute('aria-busy')")) === "false", "app bootstrap");
  const initial = await (await fetch(`${baseUrl}api/bootstrap`)).json();
  const nativeStatus = async () => (await fetch(`${baseUrl}api/native-capture`)).json();
  const hotkey = async () => evaluate("fetch('/__test__/hotkey',{method:'POST'}).then(r=>r.json())");
  assert.equal((await hotkey()).captured, false, "NONE cannot capture");
  await evaluate("document.querySelector('#open-trade-capture').click(); document.querySelector('[data-native-capture=trade] [data-native=refresh]').click()");
  await waitFor(async () => evaluate("!document.querySelector('[data-native-capture=trade] [data-native=select]').disabled"), "native target list");
  await evaluate("document.querySelector('[data-native-capture=trade] [data-native=select]').click()");
  await waitFor(async () => (await nativeStatus()).state === "READY", "native trade ROI prepared");
  assert.equal((await hotkey()).captured, true);
  await waitFor(async () => evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength==='1'"), "native PNG delivered to trade queue");
  await waitFor(async () => (await nativeStatus()).pending === 0, "retried packet acknowledged");
  assert.equal(await evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength"), "1", "duplicate heartbeat packet was inserted once");
  assert.match(await evaluate("document.querySelector('.capture-draft-item').textContent"), /게임 캡처/);
  assert.match(await evaluate("document.querySelector('[data-role=trade-queue-summary]').textContent"), /게임 캡처/);
  if (process.env.BDO_NATIVE_SCREENSHOT) {
    const screenshot = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(process.env.BDO_NATIVE_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
  }
  for (let i=0;i<3;i++) {
    assert.equal((await hotkey()).captured, true);
    await waitFor(async () => evaluate(`document.querySelector('#trade-capture-dialog').dataset.queueLength==='${i+2}'`), "repeated native PNG");
    await waitFor(async () => (await nativeStatus()).pending === 0, "native ACK");
  }
  await evaluate("document.querySelector('#trade-capture-dialog').close()");
  assert.equal((await nativeStatus()).state, "READY", "dialog close preserves native capture");
  assert.equal((await hotkey()).captured, true);
  await waitFor(async () => evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength==='5'"), "closed trade dialog receives native captures");
  await waitFor(async () => (await nativeStatus()).pending === 0, "closed dialog ACK");
  await evaluate("document.querySelector('#open-warehouse-scan').click(); document.querySelector('[data-native-capture=warehouse] [data-native=refresh]').click()");
  await waitFor(async () => evaluate("!document.querySelector('[data-native-capture=warehouse] [data-native=prepare]').disabled"), "warehouse native target");
  await evaluate("document.querySelector('[data-native-capture=warehouse] [data-native=prepare]').click()");
  await waitFor(async () => (await nativeStatus()).mode === "WAREHOUSE" && (await nativeStatus()).state === "READY", "native warehouse ROI prepared");
  assert.equal((await nativeStatus()).captured, 0, "ROI confirmation does not capture");
  assert.equal((await hotkey()).captured, true);
  await waitFor(async () => evaluate("document.querySelector('#warehouse-scan-dialog').dataset.queueLength==='1'"), "native PNG delivered to warehouse queue");
  assert.match(await evaluate("document.querySelector('.capture-queue-item').textContent"), /게임 캡처/);
  assert.equal(await evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength"), "5", "warehouse input preserves trade queue");
  await evaluate("document.querySelector('#warehouse-scan-dialog').close()");
  assert.equal((await nativeStatus()).state, "READY");
  assert.equal((await hotkey()).captured, true);
  await waitFor(async () => evaluate("document.querySelector('#warehouse-scan-dialog').dataset.queueLength==='2'"), "closed warehouse dialog preserves and receives captures");
  await waitFor(async () => (await nativeStatus()).pending === 0, "warehouse ACK before mode switch");
  await send('Page.setWebLifecycleState', {state:'frozen'});
  for (let i=0;i<3;i++) {
    assert.equal((await (await fetch(`${baseUrl}__test__/hotkey`,{method:'POST'})).json()).captured,true);
    await waitFor(async () => !(await nativeStatus()).busy,'frozen warehouse capture finishes');
  }
  assert.equal((await nativeStatus()).pending,3);
  await send('Page.setWebLifecycleState',{state:'active'});
  await waitFor(async () => evaluate("document.querySelector('#warehouse-scan-dialog').dataset.queueLength==='5'"),'closed warehouse dialog drains three frozen captures');
  await waitFor(async () => (await nativeStatus()).pending===0,'frozen warehouse captures ACK');
  await evaluate("document.querySelector('#open-trade-capture').click(); document.querySelector('[data-native-capture=trade] [data-native=prepare]').click()");
  await waitFor(async () => (await nativeStatus()).mode === "TRADE" && (await nativeStatus()).state === "READY", "saved trade ROI reused");
  assert.equal((await nativeStatus()).captured, 0, "saved ROI waits for F10");
  const generation = (await nativeStatus()).generation;
  await evaluate(`navigator.mediaDevices.getDisplayMedia=async()=>{const c=document.createElement('canvas');c.width=640;c.height=360;const x=c.getContext('2d');x.fillStyle='green';x.fillRect(0,0,640,360);window.__nativeSharePaint=setInterval(()=>x.fillRect(0,0,640,360),30);return c.captureStream(30)};document.querySelector('#connect-screen-capture').click()`);
  await waitFor(async () => evaluate("!document.querySelector('#disconnect-screen-capture').disabled"), "legacy browser sharing connects");
  await evaluate("document.querySelector('#disconnect-screen-capture').click()");
  await waitFor(async () => evaluate("document.querySelector('#disconnect-screen-capture').disabled"), "legacy browser sharing disconnects");
  assert.equal((await nativeStatus()).state, "READY", "screen-share disconnect cannot stop native capture");
  assert.equal((await nativeStatus()).generation, generation, "screen-share changes cannot reset native generation");
  assert.equal((await nativeStatus()).captured, 0, "screen sharing cannot implicitly capture");
  assert.equal(await evaluate("document.querySelector('#trade-capture-dialog .trade-preview-stage').hidden"), true);
  await evaluate("document.querySelector('#trade-capture-dialog').close()");
  await send('Page.setWebLifecycleState', {state:'frozen'});
  assert.equal((await (await fetch(`${baseUrl}__test__/maintenance`, {method:'POST'})).json()).state, 'READY', 'game input survives a paused browser');
  for (let i = 0; i < 3; i++) {
    assert.equal((await (await fetch(`${baseUrl}__test__/hotkey`, {method:'POST'})).json()).captured, true);
    await waitFor(async () => !(await nativeStatus()).busy, 'background capture finishes');
  }
  assert.equal((await nativeStatus()).pending, 3, "browser freeze retains three native frames");
  await fetch(`${baseUrl}__test__/finish`, {method:'POST'});
  assert.equal((await nativeStatus()).state, 'STOPPED');
  assert.equal((await nativeStatus()).pending, 3, "explicit stop preserves completed frames");
  await send('Page.setWebLifecycleState', {state:'active'});
  await waitFor(async () => evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength==='8'"), 'finished captures drain while dialog remains closed');
  await waitFor(async () => (await nativeStatus()).mode === 'NONE', 'finished capture disarms only after ACK');
  assert.equal(await evaluate("document.querySelector('#warehouse-scan-dialog').dataset.queueLength"), "5", "trade input preserves warehouse queue");
  await evaluate("document.querySelector('#open-trade-capture').click(); document.querySelector('[data-native-capture=trade] [data-native=prepare]').click()");
  await waitFor(async () => (await nativeStatus()).state === "READY", "explicit start without screen sharing");
  await evaluate("document.querySelector('#trade-capture-dialog').close()");
  await send('Page.setWebLifecycleState',{state:'frozen'});
  for (let i=0;i<3;i++) {
    assert.equal((await (await fetch(`${baseUrl}__test__/hotkey`,{method:'POST'})).json()).captured,true);
    await waitFor(async () => !(await nativeStatus()).busy,'pre-context-change capture completes');
  }
  const oldGeneration=(await nativeStatus()).generation;
  assert.equal((await nativeStatus()).pending,3);
  const changed=await (await fetch(`${baseUrl}__test__/context-change`,{method:'POST'})).json();
  assert.equal(changed.owned,false);assert.equal(changed.pending,0);assert.equal(changed.mode,'NONE');
  assert.ok(changed.generation>oldGeneration);
  const diagnostics=await (await fetch(`${baseUrl}api/native-capture/diagnostics`)).json();
  const discarded=diagnostics.recent.findLast(e=>e.event==='stale_frames_discarded');
  assert.equal(discarded.discardedCount,3);assert.ok(discarded.discardedBytes>0);
  await send('Page.setWebLifecycleState',{state:'active'});
  await evaluate("import('/assets/js/state.js').then(({state})=>{state.revision+=1})");
  await waitFor(async () => evaluate("document.querySelector('[data-native-capture=trade] [role=status]').textContent.includes('미수신 이미지를 폐기')"),'frontend reports context reset');
  assert.equal(await evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength"),'8','ACKed trade captures survive context reset');
  assert.equal(await evaluate("document.querySelector('#warehouse-scan-dialog').dataset.queueLength"),'5','ACKed warehouse captures survive context reset');
  await evaluate("document.querySelector('#open-trade-capture').click();document.querySelector('[data-native-capture=trade] [data-native=prepare]').click()");
  await waitFor(async () => (await nativeStatus()).state==='READY' && (await nativeStatus()).context.baseRevision===initial.revision+1,'new context immediately restarts capture');
  assert.equal((await hotkey()).captured,true);
  await waitFor(async () => evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength==='9'"),'only fresh-context image is appended');
  await waitFor(async () => (await nativeStatus()).pending===0,'fresh-context ACK');
  await evaluate("document.querySelector('[data-native-capture=trade] [data-native=stop]').click()");
  await waitFor(async () => (await nativeStatus()).mode === "NONE", "explicit UI stop");
  const after = await (await fetch(`${baseUrl}api/bootstrap`)).json();
  assert.deepEqual(after, initial, "native capture-only flow leaves all durable state unchanged");
  const cleanupCheck = await evaluate(`(async () => {
    const { initNativeCaptureUI } = await import('/assets/js/native-capture-ui.js');
    const originalFetch = window.fetch;
    const dialog = document.createElement('dialog');
    dialog.innerHTML = '<div class="trade-preview-stage"></div><div class="trade-roi-panel"></div>';
    document.body.append(dialog);
    const legacy = [...dialog.children];
    let resolveStatus, requests = 0;
    window.fetch = () => { requests++; return new Promise(resolve => { resolveStatus = resolve; }); };
    try {
      const adapter = { dialog, getContext: () => ({}), getState: () => ({busy:false}), accept() {} };
      const ui = initNativeCaptureUI({trade: adapter});
      const removedButton = dialog.querySelector('[data-native="refresh"]');
      window.dispatchEvent(new Event('beforeunload'));
      if (dialog.querySelectorAll('[data-native-capture]').length !== 1) throw new Error('cancelled unload must keep UI alive');
      const cachedHide = new Event('pagehide'); Object.defineProperty(cachedHide, 'persisted', {value:true});
      window.dispatchEvent(cachedHide);
      if (dialog.querySelectorAll('[data-native-capture]').length !== 1) throw new Error('cached page must keep UI alive');
      window.dispatchEvent(new Event('pagehide'));
      ui.cleanup(); ui.cleanup();
      removedButton.click();
      dialog.setAttribute('open','');
      resolveStatus({ok:true,json:async()=>({mode:'TRADE',context:{},generation:1})});
      await new Promise(resolve => setTimeout(resolve, 20));
      return {requests, panels:dialog.querySelectorAll('[data-native-capture]').length, hidden:legacy.map(node=>node.hidden)};
    } finally { window.fetch = originalFetch; dialog.remove(); }
  })()`);
  assert.deepEqual(cleanupCheck, {requests:1,panels:0,hidden:[false,false]}, 'cleanup removes handlers, observers and panels; delayed status cannot reattach');
  console.log(JSON.stringify({ok:true,actualChrome:true,cleanupLifecycle:"PASS",actualGame:false,nativeProvider:'fake',tradeQueue:'PASS',warehouseQueue:'PASS',duplicatePacket:'PASS',repeatCapture:'PASS',savedRoi:'PASS',closedDialog:'PASS',screenShareIndependence:'PASS',frozenBrowserBuffer:'PASS',frozenWarehouseBuffer:'PASS',contextResetAndRestart:'PASS',noStaleInjection:'PASS',ackedQueuesPreserved:'PASS',explicitStop:'PASS',noAutomaticOCRApply:'PASS'}));

} finally {
  try { if (socket?.readyState === WebSocket.OPEN) await send("Browser.close"); } catch {}
  try { socket?.close(); } catch {}
  for (const process of [chrome, server]) {
    if (process?.pid) {
      try {
        process.kill();
        await Promise.race([new Promise((resolveExit) => process.once("exit", resolveExit)), new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1500))]);
      } catch {}
    }
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  try { await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); } catch {}
}
