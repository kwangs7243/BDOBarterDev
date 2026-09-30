import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = process.env.BDO_TEST_URL ?? "http://127.0.0.1:18772/";
const python = process.env.PYTHON ?? "python";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-t010p3b2-browser-"));
const database = join(profile, "isolated.sqlite3");
const port = new URL(baseUrl).port || "18772";
const pythonCode = `
import time
from flask import jsonify
from local_app.backend.app import create_app
from local_app.backend.services.trade_batch_runtime import TradeBatchRuntimeError

class FakeRuntime:
    def __init__(self): self.mode = "success"; self.calls = []
    def status(self): return {"available": True, "modelReady": True, "reason": None, "engineId": "test-only"}
    def recognize(self, batch_id, captures):
        self.calls.append({"batchId": batch_id, "captureIds": [item["captureId"] for item in captures],
                           "metadataBatchIds": [item["metadata"].get("batchId") for item in captures]})
        if self.mode == "delay": time.sleep(1.0)
        if self.mode == "busy": raise TradeBatchRuntimeError("engine_busy", "busy", 409, retryable=True)
        fields = ("island", "fromItem", "reqAmount", "toItem", "count", "yield")
        rows = []
        for ordinal, item in enumerate(captures, 1):
            values = {}
            for field in fields:
                raw = "10회" if field == "count" else field + " raw"
                values[field] = {"rawText": raw, "normalizedText": raw + " normalized" if field == "island" else None,
                                 "rawNumericCandidate": None, "value": None, "status": "RAW_OCR_CANDIDATE",
                                 "reasonCodes": ["NEEDS_REVIEW"]}
            rows.append({"captureId": item["captureId"], "ordinal": ordinal, "fields": values,
                         "status": "DRAFT_UNVERIFIED", "automationDecision": "REVIEW"})
        capture_evidence = [{"captureId": captures[0]["captureId"], "detectedCandidateCount": 2,
                             "completeRowCount": 1, "edgeSegmentCount": 1},
                            {"captureId": captures[1]["captureId"], "detectedCandidateCount": 1,
                             "completeRowCount": 1, "edgeSegmentCount": 0}]
        return {"captures": capture_evidence, "draftRows": rows,
                "edgeSegments": [{"captureId": captures[0]["captureId"], "rowBox": {"x": 0, "y": 0, "width": 20, "height": 12},
                                  "boundarySide": "top", "classification": "EDGE_SEGMENT_UNCERTAIN"}],
                "metrics": {"boundaryPolicy": "edge-segments-evidence-only-v1", "detectedCandidateCount": 3,
                            "completeRowCount": 2, "edgeSegmentCount": 1, "draftRowCount": 2},
                "runtime": {"available": True, "engineId": "test-only"}}

app = create_app(r'${database}', testing=True)
fake = FakeRuntime()
app.extensions["trade_batch_runtime"] = fake
@app.get("/__test__/trade-runtime")
def read_fake_state(): return jsonify({"calls": fake.calls, "mode": fake.mode})
@app.post("/__test__/trade-runtime/<mode>")
def set_fake_mode(mode):
    fake.mode = mode
    return jsonify({"ok": True})
app.run(host="127.0.0.1", port=${Number(port)}, use_reloader=False, threaded=True)
`;
let server; let chrome; let socket; let send;
async function waitFor(predicate, label, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate(); if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill();
  await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 3000))]);
}
try {
  server = spawn(python, ["-B", "-c", pythonCode], { cwd: root, stdio: "ignore", windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: profile, PYTHONDONTWRITEBYTECODE: "1" } });
  await waitFor(async () => { try { return (await fetch(`${baseUrl}api/health`)).ok; } catch { return false; } }, "isolated app server");
  chrome = spawn(chromePath, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-crash-reporter", "--disable-breakpad",
    "--disable-background-networking", "--window-size=1200,900", "--remote-debugging-port=0", "--remote-allow-origins=*",
    `--user-data-dir=${join(profile, "chrome-profile")}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  const activePortPath = join(profile, "chrome-profile", "DevToolsActivePort");
  const activePortText = await waitFor(async () => { try { return await readFile(activePortPath, "utf8"); } catch { return false; } }, "Chrome DevTools endpoint");
  const debugPort = activePortText.trim().split(/\r?\n/)[0];
  const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(baseUrl)}`, { method: "PUT" });
  assert.equal(targetResponse.ok, true);
  const target = await targetResponse.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const pending = new Map(); let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data); if (!message.id || !pending.has(message.id)) return;
    const waiter = pending.get(message.id); pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  });
  send = (method, params = {}) => new Promise((resolveMessage, reject) => {
    const id = ++nextId; pending.set(id, { resolve: resolveMessage, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("DOM.enable");
  await waitFor(async () => (await evaluate("document.querySelector('#app-content')?.getAttribute('aria-busy')")) === "false", "app bootstrap");
  const initial = await (await fetch(`${baseUrl}api/bootstrap`)).json();
  const tradeListBefore = await evaluate("document.querySelector('#trade-list-root').textContent");
  await evaluate(`(() => {
    const source=document.createElement('canvas'); source.width=640; source.height=360;
    const context=source.getContext('2d'); let frame=0;
    const paint=()=>{context.fillStyle=frame++%2?'#183448':'#9a351e';context.fillRect(0,0,640,360);context.fillStyle='#fff';context.fillRect(80,60,170,90);}; paint();
    const timer=setInterval(paint,100); const streams=[];
    Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{configurable:true,value:async options=>{window.__screenRequestOptions=options;const stream=source.captureStream(30);streams.push(stream);return stream;}});
    window.__recognitionMock={source,streams,timer};
  })()`);
  await evaluate("document.querySelector('#connect-screen-capture').click()");
  await waitFor(async () => evaluate("document.querySelector('#screen-capture-session')?.dataset.state==='CONNECTED'"), "synthetic stream connection");
  await evaluate("document.querySelector('#open-trade-capture').click()");
  await waitFor(async () => evaluate("document.querySelector('#trade-capture-dialog')?.open && document.querySelector('[data-role=trade-runtime-status]').textContent==='로컬 인식 사용 가능'"), "runtime status");
  assert.equal(await evaluate("document.querySelector('[data-action=recognize-trade]').disabled"), true, "empty queue keeps recognition disabled");
  const captureButton = "document.querySelector('[data-action=capture-trade-roi]')";
  await evaluate(`${captureButton}.click()`);
  await waitFor(async () => evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength==='1'"), "first capture");
  await evaluate(`${captureButton}.click()`);
  await waitFor(async () => evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength==='2'"), "second capture");
  assert.equal(await evaluate("document.querySelector('[data-action=recognize-trade]').disabled"), false);
  const queueIds = await evaluate("JSON.stringify([...document.querySelectorAll('.capture-draft-item')].map(item=>item.dataset.captureId))").then(JSON.parse);
  const queueBatchIds = await evaluate("JSON.stringify([...document.querySelectorAll('.capture-draft-item')].map(item=>item.dataset.batchId))").then(JSON.parse);
  const beforeRecognition = await (await fetch(`${baseUrl}api/bootstrap`)).json();
  await evaluate("document.querySelector('[data-action=recognize-trade]').click()");
  await waitFor(async () => evaluate("(() => { const region=document.querySelector('[data-role=trade-recognition-result]'); const summary=region?.querySelector('.trade-review-summary'); return region?.hidden===false && Boolean(summary) && summary.textContent.includes('로컬 인식 초안 · 2행 · 이미지 2장 · 경계 후보 1행 제외 · 목록 미적용'); })()"), "recognition review summary");
  assert.equal(await evaluate("document.querySelector('[data-role=trade-recognition-result]').textContent.includes('로컬 인식 초안 · 2행 · 이미지 2장 · 경계 후보 1행 제외 · 목록 미적용')"), true);
  assert.deepEqual(await evaluate("JSON.stringify([...document.querySelectorAll('.trade-recognition-table thead th')].map(cell=>cell.textContent))").then(JSON.parse),
    ["행", "섬", "소모품", "필요 수량", "획득품", "남은 교환 횟수", "수율", "상태"]);
  assert.equal(await evaluate("document.querySelector('.trade-recognition-table tbody').textContent.includes('10회')"), true, "raw numeric text is displayed without parsing");
  assert.equal(await evaluate("document.querySelector('.trade-recognition-table tbody').textContent.includes('인식 초안 · 검토 필요')"), true);
  assert.equal(await evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength"), "2", "success retains queue");
  assert.equal(await evaluate("document.querySelector('#screen-capture-session').dataset.state"), "CONNECTED", "recognition keeps screen stream connected");
  const fakeState = await (await fetch(`${baseUrl}__test__/trade-runtime`)).json();
  assert.equal(fakeState.calls.length, 1);
  assert.deepEqual(fakeState.calls[0].captureIds, queueIds, "POST capture order matches queue order");
  assert.deepEqual(fakeState.calls[0].metadataBatchIds, queueBatchIds, "capture batch metadata is preserved");
  assert.deepEqual(await (await fetch(`${baseUrl}api/bootstrap`)).json(), beforeRecognition, "main DB semantic bootstrap unchanged");
  assert.equal(await evaluate("document.querySelector('#trade-list-root').textContent"), tradeListBefore, "trade list unchanged");

  await evaluate("document.querySelector('[data-close-trade-capture]').click()");
  await waitFor(async () => evaluate("!document.querySelector('#trade-capture-dialog').open"), "dialog close");
  await evaluate("document.querySelector('#open-trade-capture').click()");
  await waitFor(async () => evaluate("document.querySelector('#trade-capture-dialog').open && document.querySelector('[data-role=trade-runtime-status]').textContent==='로컬 인식 사용 가능'"), "dialog reopen and runtime refresh");
  assert.equal(await evaluate("document.querySelector('[data-role=trade-recognition-result]').hidden"), false, "result remains in memory across dialog close");

  await evaluate("document.querySelector('[data-action=clear-trade-recognition-result]').click()");
  assert.equal(await evaluate("document.querySelector('[data-role=trade-recognition-result]').hidden"), true);
  assert.equal(await evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength"), "2", "clear result retains queue");
  assert.equal(await evaluate("document.querySelector('#screen-capture-session').dataset.state"), "CONNECTED", "clear result retains stream");
  await evaluate(`fetch('/__test__/trade-runtime/delay',{method:'POST'})`);
  await evaluate(`new Promise(resolve=>{
    const canvas=document.createElement('canvas');canvas.width=100;canvas.height=60;
    canvas.getContext('2d').fillRect(0,0,100,60);
    canvas.toBlob(blob=>{
      const transfer=new DataTransfer();transfer.items.add(new File([blob],'pending-capture.png',{type:'image/png'}));
      const input=document.querySelector('#trade-capture-files');Object.defineProperty(input,'files',{configurable:true,value:transfer.files});
      input.dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('[data-action=recognize-trade]').click();resolve(true);
    },'image/png');
  })`);
  await waitFor(async () => evaluate("document.querySelector('[data-role=trade-recognition]').getAttribute('aria-busy')==='true'"), "pending state");
  assert.equal(await evaluate("document.querySelector('[data-action=recognize-trade]').textContent"), "로컬 인식 중…");
  assert.equal(await evaluate("document.querySelector('[data-action=recognize-trade]').disabled"), true);
  await evaluate("document.querySelector('[data-action=recognize-trade]').click()");
  await waitFor(async () => evaluate("document.querySelector('[data-role=trade-recognition-status]').textContent==='대기 이미지가 변경되어 인식 결과를 사용하지 않았습니다. 다시 인식하세요.'"), "stale response discard");
  assert.equal(await evaluate("document.querySelector('[data-role=trade-recognition]').getAttribute('aria-busy')"), "false");
  assert.equal(await evaluate("document.querySelector('[data-role=trade-recognition-result]').hidden"), true, "stale result is not rendered");
  assert.equal(await evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength"), "3", "in-flight capture is retained");
  const afterDelay = await (await fetch(`${baseUrl}__test__/trade-runtime`)).json();
  assert.equal(afterDelay.calls.length, 2, "duplicate click does not send a second pending request");

  await evaluate("document.querySelector('.capture-draft-item:last-child button').click()");
  assert.equal(await evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength"), "2", "removing in-flight capture restores original queue size");
  await evaluate(`fetch('/__test__/trade-runtime/success',{method:'POST'})`);
  await evaluate("document.querySelector('[data-action=recognize-trade]').click()");
  await waitFor(async () => evaluate("document.querySelector('[data-role=trade-recognition-result]').hidden===false"), "result for queue mutation test");
  await evaluate("document.querySelector('.capture-draft-item button').click()");
  assert.equal(await evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength"), "1");
  assert.equal(await evaluate("document.querySelector('[data-role=trade-recognition-result]').hidden"), true, "queue mutation invalidates rendered result");
  assert.equal(await evaluate("document.querySelector('[data-role=trade-recognition-status]').textContent"), "대기 이미지가 변경되었습니다. 다시 인식하세요.");

  await evaluate(`fetch('/__test__/trade-runtime/busy',{method:'POST'})`);
  await evaluate("document.querySelector('[data-action=recognize-trade]').click()");
  await waitFor(async () => evaluate("document.querySelector('[data-role=trade-recognition-status]').textContent.includes('다른 인식 작업')"), "mapped busy error");
  assert.equal(await evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength"), "1", "failure retains queue");
  assert.equal(await evaluate("document.querySelectorAll('.capture-draft-item').length"), 1, "failure retains preview");
  assert.equal(await evaluate("document.querySelector('#trade-list-root').textContent"), tradeListBefore);
  assert.deepEqual(await (await fetch(`${baseUrl}api/bootstrap`)).json(), beforeRecognition);
  await evaluate("document.querySelector('[data-action=clear-trade-queue]').click()");
  assert.equal(await evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength"), "0");
  assert.equal(await evaluate("document.querySelector('[data-role=trade-recognition-result]').hidden"), true);
  assert.equal(await evaluate("document.querySelector('#screen-capture-session').dataset.state"), "CONNECTED", "clear queue keeps stream connected");
  assert.deepEqual(await (await fetch(`${baseUrl}api/bootstrap`)).json(), initial, "Main DB unchanged across capture and recognition flow");
  console.log("browser_trade_batch_recognition: PASS");
} finally {
  try { socket?.close(); } catch {}
  await Promise.all([stopChild(chrome), stopChild(server)]);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { await rm(profile, { recursive: true, force: true }); break; }
    catch (error) { if (error.code !== "EBUSY" || attempt === 7) throw error; await new Promise((resolveWait) => setTimeout(resolveWait, 150)); }
  }
}
