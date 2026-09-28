import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = process.env.BDO_TEST_URL ?? "http://127.0.0.1:18768/";
const python = process.env.PYTHON ?? "python";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-t004-screen-browser-"));
const database = join(profile, "isolated.sqlite3");
const port = new URL(baseUrl).port || "18768";
const pythonCode = `from local_app.backend.app import create_app; create_app(r'${database}', testing=True).run(host='127.0.0.1', port=${Number(port)}, use_reloader=False, threaded=True)`;
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
  assert.equal(targetResponse.ok, true, "Chrome creates the application target");
  const target = await targetResponse.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve: resolveMessage, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolveMessage(message.result);
  });
  send = (method, params = {}) => new Promise((resolveMessage, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveMessage, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");
  await waitFor(async () => (await evaluate("document.querySelector('#app-content')?.getAttribute('aria-busy')")) === "false", "application bootstrap");
  const initial = await (await fetch(`${baseUrl}api/bootstrap`)).json();

  // This is a mock browser stream for lifecycle/UI coverage. It intentionally does not invoke or bypass the real permission picker.
  await evaluate(`(() => {
    const source=document.createElement('canvas'); source.width=640; source.height=360;
    const context=source.getContext('2d'); context.fillStyle='#27384a'; context.fillRect(0,0,source.width,source.height);
    let frame=0; const paint=setInterval(()=>{context.fillStyle=frame++%2?'#27384a':'#28394b';context.fillRect(0,0,source.width,source.height);},33);
    let calls=0; const streams=[];
    Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{configurable:true,value:async options=>{
      window.__screenRequestOptions=(window.__screenRequestOptions||[]).concat([options]); calls+=1;
      const stream=source.captureStream(30); streams.push(stream); return stream;
    }});
    window.__screenMock={source,streams,paint,get calls(){return calls;}};
  })()`);

  await evaluate("document.querySelector('#connect-screen-capture').click()");
  await waitFor(async () => evaluate("document.querySelector('#screen-capture-session')?.dataset.state==='CONNECTED' || document.querySelector('#screen-capture-session')?.dataset.state==='DISCONNECTED'"), "mocked stream connection result");
  const connectionResult = await evaluate("JSON.stringify({state:document.querySelector('#screen-capture-session')?.dataset.state,status:document.querySelector('#screen-capture-status')?.textContent,calls:window.__screenMock.calls,requestOptions:window.__screenRequestOptions})").then(JSON.parse);
  assert.equal(connectionResult.state, "CONNECTED", `mocked stream connect failed: ${JSON.stringify(connectionResult)}`);
  assert.deepEqual(await evaluate("JSON.stringify(window.__screenRequestOptions)").then(JSON.parse), [{ video: { displaySurface: "window" }, audio: false }]);
  assert.equal(await evaluate("window.__screenMock.streams[0].getAudioTracks().length"), 0, "the accepted stream has no audio track");
  assert.equal(await evaluate("document.querySelector('[data-screen-capture=warehouse]').disabled"), false);

  await evaluate("document.querySelector('#open-warehouse-scan').click()");
  await waitFor(async () => evaluate("document.querySelector('#warehouse-scan-dialog')?.open"), "warehouse capture context");
  await evaluate("document.querySelector('[data-screen-capture=warehouse]').click()");
  await waitFor(async () => evaluate("document.querySelector('#warehouse-scan-dialog')?.dataset.queueLength==='1'"), "one explicit warehouse frame captured");
  const warehouseState = await evaluate("JSON.stringify({message:document.querySelector('.warehouse-scan-message').textContent,state:document.querySelector('#screen-capture-session').dataset.state,video:window.__screenMock.streams[0].getVideoTracks()[0].readyState})").then(JSON.parse);
  assert.match(warehouseState.message, /화면 640×360 프레임을 대기열에 추가했습니다/);
  assert.match(warehouseState.message, /선택 이미지 판독/);
  assert.equal(warehouseState.state, "CONNECTED", "a single capture returns to the shared connected session");
  assert.equal(warehouseState.video, "live");
  await evaluate("document.querySelector('#warehouse-scan-dialog [data-action=close]').click()");
  await waitFor(async () => evaluate("!document.querySelector('#warehouse-scan-dialog')?.open"), "warehouse dialog closed");
  assert.equal(await evaluate("document.querySelector('#screen-capture-session').dataset.state"), "CONNECTED", "closing Warehouse keeps the shared screen stream");
  assert.equal(await evaluate("window.__screenMock.streams[0].getVideoTracks()[0].readyState"), "live");

  const tradeRowsBefore = await evaluate("document.querySelector('#trade-list-root').textContent");
  await evaluate("document.querySelector('#open-trade-capture').click()");
  await waitFor(async () => evaluate("document.querySelector('#trade-capture-dialog')?.open"), "Trade capture context");
  await evaluate("document.querySelector('[data-screen-capture=trade]').click()");
  await waitFor(async () => evaluate("document.querySelector('#trade-capture-dialog')?.dataset.queueLength==='1'"), "one explicit Trade draft captured");
  const tradeState = await evaluate("JSON.stringify({label:document.querySelector('.capture-draft-item').textContent,draft:document.querySelector('.capture-draft-item [class=capture-draft-state]').textContent,rows:document.querySelector('#trade-list-root').textContent})").then(JSON.parse);
  assert.match(tradeState.label, /화면/);
  assert.match(tradeState.draft, /OCR 미실행/);
  assert.equal(tradeState.rows, tradeRowsBefore, "Trade capture does not create or modify trade rows");
  await evaluate("document.querySelector('#trade-capture-dialog [data-close-trade-capture]').click()");
  assert.equal(await evaluate("document.querySelector('#screen-capture-session').dataset.state"), "CONNECTED", "closing Trade keeps the shared screen stream");

  const after = await (await fetch(`${baseUrl}api/bootstrap`)).json();
  assert.equal(after.revision, initial.revision, "connect and captures do not write the main DB");
  assert.deepEqual(after.inventory, initial.inventory, "connect and captures preserve inventory");
  await evaluate("document.querySelector('#disconnect-screen-capture').click()");
  assert.equal(await evaluate("document.querySelector('#screen-capture-session').dataset.state"), "DISCONNECTED");
  assert.equal(await evaluate("window.__screenMock.streams[0].getVideoTracks()[0].readyState"), "ended", "explicit disconnect stops the track");
  await evaluate("document.querySelector('#connect-screen-capture').click()");
  await waitFor(async () => evaluate("document.querySelector('#screen-capture-session')?.dataset.state==='CONNECTED' && window.__screenMock.calls===2"), "reconnected mock stream");
  assert.deepEqual(await evaluate("JSON.stringify(window.__screenRequestOptions)").then(JSON.parse), [
    { video: { displaySurface: "window" }, audio: false }, { video: { displaySurface: "window" }, audio: false },
  ]);
  console.log(JSON.stringify({
    ok: true,
    browser: "Chrome headless",
    stream: "synthetic canvas captureStream mock",
    permissionPicker: "NOT_RUN",
    actualBDOWindow: "NOT_RUN",
    userClickHandlerInvokesScreenRequest: "PASS (mocked API)",
    audioFalseAndNoAudioTrack: "PASS",
    warehouseExplicitFrameNoScanOrWrite: "PASS",
    tradeExplicitDraftNoOCROrRows: "PASS",
    dialogCloseKeepsConnection: "PASS",
    disconnectStopsTracksAndReconnects: "PASS",
    mainDbSemanticStateUnchanged: "PASS",
  }, null, 2));
} finally {
  try {
    if (socket?.readyState === WebSocket.OPEN) {
      await Promise.race([send("Browser.close"), new Promise((resolveWait) => setTimeout(resolveWait, 1000))]);
    }
  } catch {}
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
