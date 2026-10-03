import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadyV3Batch } from "./reviewed_trade_dto_v3_regression.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = process.env.BDO_TEST_URL ?? "http://127.0.0.1:18778/";
const python = process.env.PYTHON ?? "python";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-r009-review-session-"));
const database = join(profile, "isolated.sqlite3");
const port = new URL(baseUrl).port || "18778";
const pythonCode = `
from flask import jsonify, request
import hashlib
import sqlite3
from local_app.backend.app import create_app
from local_app.backend.services.trade_batch_runtime import TradeBatchRuntimeError

FIELD_KEYS = ("island", "fromItem", "reqAmount", "toItem", "count", "yield")
class FakeRuntime:
    def status(self): return {"available": True, "modelReady": True, "reason": None, "engineId": "r005-test-only"}
    def recognize(self, batch_id, captures):
        rows=[]
        row_values=[
            [
                {"island":"달래나루","fromItem":"갈퀴 꽃 씨앗 주머니x","reqAmount":"10","toItem":"괴생물 촉수","count":"0","yield":"48"},
                {"island":"해모 섬","fromItem":"갈퀴 꽃 씨앗 주머니x","reqAmount":None,"toItem":"괴생물 촉수","count":"0","yield":"48"},
                {"island":"그란디하","fromItem":"갈퀴 꽃 씨앗 주머니x","reqAmount":"10","toItem":"괴생물 촉수","count":"0","yield":"48"},
            ],
            [
                {"island":"해모 섬","fromItem":"갈퀴 꽃 씨앗 주머니x","reqAmount":None,"toItem":"괴생물 촉수","count":"0","yield":"48"},
                {"island":"그란디하","fromItem":"갈퀴 꽃 씨앗 주머니x","reqAmount":"10","toItem":"괴생물 촉수","count":"1","yield":"148"},
                {"island":"깊은 밤의 항구","fromItem":"갈퀴 꽃 씨앗 주머니x","reqAmount":"10","toItem":"괴생물 촉수","count":"0","yield":"48"},
            ],
        ]
        for capture_index,capture in enumerate(captures):
            for ordinal,values in enumerate(row_values[capture_index],1):
                fields={}
                for index,key in enumerate(FIELD_KEYS):
                    raw=values[key]
                    numeric=int(raw) if key in ("reqAmount","count","yield") and raw is not None else None
                    fields[key]={"value":None,"rawText":raw,"normalizedText":raw,"rawNumericCandidate":numeric,
                        "status":"EMPTY_OCR" if raw is None else ("FIELD_CLIPPED" if key == "yield" else "RAW_OCR_CANDIDATE"),
                        "reasonCodes":["EMPTY_OCR"] if raw is None else (["FIELD_CLIPPED"] if key == "yield" else []),
                        "readerEvidence":{"readerId":"test-only","geometry":{"box":{"x":index*10,"y":4,"width":8,"height":8}}}}
                rows.append({"captureId":capture["captureId"],"ordinal":ordinal,"rowBox":{"x":0,"y":(ordinal-1)*20,"width":80,"height":20},
                    "rowCropHash":hashlib.sha256(f"{capture['captureId']}-{ordinal}".encode()).hexdigest(),"sourceRefs":[{"captureId":capture["captureId"],"ordinal":ordinal}],
                    "fields":fields,"status":"DRAFT_UNVERIFIED","automationDecision":"REVIEW"})
        captures_out=[{"captureId":c["captureId"],"batchId":c["metadata"]["batchId"],"captureOrdinal":index+1,"imageHash":hashlib.sha256(c["imageBytes"]).hexdigest(),"imageDimensions":{"width":100,"height":80},"detectedCandidateCount":3,"completeRowCount":3,"edgeSegmentCount":0} for index,c in enumerate(captures)]
        captures_out[0]["detectedCandidateCount"]=4; captures_out[0]["edgeSegmentCount"]=1
        return {"captures":captures_out,"draftRows":rows,
            "edgeSegments":[{"captureId":captures[0]["captureId"],"rowBox":{"x":0,"y":0,"width":80,"height":20},"boundarySide":"bottom","classification":"EDGE_SEGMENT_UNCERTAIN","reasonCodes":["ROW_BOUNDARY_CONTACT"]}],
            "metrics":{"boundaryPolicy":"edge-segments-evidence-only-v1","detectedCandidateCount":3*len(captures)+1,"completeRowCount":3*len(captures),"edgeSegmentCount":1,"draftRowCount":len(rows)},
            "runtime":{"available":True,"engineId":"r005-test-only"}}
app=create_app(r'${database}', testing=True)
fake=FakeRuntime(); app.extensions["trade_batch_runtime"]=fake
requests=[]
@app.before_request
def record_request(): requests.append({"method":request.method,"path":request.path,"body":request.get_json(silent=True) if request.path=="/api/working-session" else None})
@app.get("/__test__/trade-runtime")
def runtime_state(): return jsonify({"ok":True})
@app.get("/__test__/db")
def db_probe():
    from pathlib import Path
    return jsonify({"databaseExists":Path(r'${database}').exists(),"appDbPath":str(Path(r'${database}').resolve())})
@app.get("/__test__/requests")
def request_probe(): return jsonify(requests)
@app.get("/__test__/observation-count")
def observation_count():
    path=r'${database}'.replace('isolated.sqlite3','recognition/recognition.sqlite3')
    with sqlite3.connect(path) as db: return jsonify({"count":db.execute("SELECT count(*) FROM trade_review_observation").fetchone()[0]})
@app.get("/__test__/observation-v3-count")
def observation_v3_count():
    path=r'${database}'.replace('isolated.sqlite3','recognition/recognition.sqlite3')
    with sqlite3.connect(path) as db: return jsonify({"count":db.execute("SELECT count(*) FROM trade_review_observation_v3").fetchone()[0]})
app.run(host="127.0.0.1",port=${Number(port)},use_reloader=False,threaded=True)
`;
let server; let chrome; let socket; let send;
async function waitFor(predicate, label, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { const value = await predicate(); if (value) return value; await new Promise((resolveWait) => setTimeout(resolveWait, 80)); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit)); child.kill();
  await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 3000))]);
}
try {
  server = spawn(python, ["-B", "-c", pythonCode], { cwd: root, stdio: "ignore", windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: profile, PYTHONDONTWRITEBYTECODE: "1" } });
  await waitFor(async () => { try { return (await fetch(`${baseUrl}api/health`)).ok; } catch { return false; } }, "isolated app server");
  chrome = spawn(chromePath, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-crash-reporter", "--disable-breakpad",
    "--disable-background-networking", "--window-size=1920,1080", "--remote-debugging-port=0", "--remote-allow-origins=*",
    `--user-data-dir=${join(profile, "chrome-profile")}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  const activePortPath = join(profile, "chrome-profile", "DevToolsActivePort");
  const activePortText = await waitFor(async () => { try { return await readFile(activePortPath, "utf8"); } catch { return false; } }, "Chrome DevTools endpoint");
  const debugPort = activePortText.trim().split(/\r?\n/)[0];
  const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`${baseUrl}?tradeCompatibility=REVIEW_FIRST`)}`, { method: "PUT" });
  assert.equal(targetResponse.ok, true);
  const target = await targetResponse.json(); socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const pending = new Map(); let nextId = 0;
  socket.addEventListener("message", (event) => { const message = JSON.parse(event.data); if (!message.id || !pending.has(message.id)) return; const waiter = pending.get(message.id); pending.delete(message.id); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result); });
  send = (method, params = {}) => new Promise((resolveMessage, reject) => { const id = ++nextId; pending.set(id, { resolve: resolveMessage, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result?.value; };
  let reloadSequence = 0;
  const reloadAndWait = async (label) => {
    const marker = `review-session-reload-${++reloadSequence}`;
    await evaluate(`window.__reviewSessionReloadMarker=${JSON.stringify(marker)}`);
    try { await send("Page.reload", { ignoreCache: true }); }
    catch (error) { if (!error.message.includes("Inspected target navigated or closed")) throw error; }
    await waitFor(async () => evaluate(`window.__reviewSessionReloadMarker!==${JSON.stringify(marker)} && document.querySelector('#app-content')?.getAttribute('aria-busy')==='false'`), label);
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("DOM.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1.3, mobile: false });
  await waitFor(async () => evaluate("document.querySelector('#app-content')?.getAttribute('aria-busy')==='false'"), "app bootstrap");
  const bootstrapBefore = await (await fetch(`${baseUrl}api/bootstrap`)).json();
  const sessionTextBefore = await evaluate("document.querySelector('#trade-list-root').textContent");
  await evaluate("document.querySelector('#open-trade-capture').click()");
  await waitFor(async () => evaluate("document.querySelector('#trade-capture-dialog')?.open && document.querySelector('[data-role=trade-runtime-status]').textContent==='로컬 인식 사용 가능'"), "recognition runtime");
  await evaluate(`new Promise(async (resolve,reject)=>{
    try {
      const input=document.querySelector('#trade-capture-files');
      for(const [name,color] of [['first.png','#e02020'],['second.png','#2040e0']]){
        const canvas=document.createElement('canvas');canvas.width=100;canvas.height=80;const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,100,80);
        const blob=await new Promise(done=>canvas.toBlob(done,'image/png'));const transfer=new DataTransfer();transfer.items.add(new File([blob],name,{type:'image/png'}));
        Object.defineProperty(input,'files',{configurable:true,value:transfer.files});input.dispatchEvent(new Event('change',{bubbles:true}));
        await new Promise(done=>setTimeout(done,120));
      } resolve(true);
    }catch(error){reject(error)}
  })`);
  await waitFor(async () => evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength==='2'"), "two captures queued");
  const tradeListBefore = await evaluate("document.querySelector('#trade-list-root').textContent");
  await evaluate("document.querySelector('[data-action=recognize-trade]').click()");
  await waitFor(async () => evaluate("document.querySelectorAll('.trade-review-table tbody tr[data-capture-id]').length===4"), "all logical review rows");
  assert.equal(await evaluate("document.querySelectorAll('.trade-review-table tbody tr[data-capture-id]').length"), 4);
  assert.equal(await evaluate("document.querySelectorAll('.trade-review-input').length"), 24, "four logical rows expose all six editable values");
  const reconciliationSummary = await evaluate("document.querySelector('.trade-review-summary').textContent");
  assert.match(reconciliationSummary, /원본 COMPLETE 6/);
  assert.match(reconciliationSummary, /검수 행 4/);
  assert.match(reconciliationSummary, /겹침 통합 2/);
  assert.match(reconciliationSummary, /충돌 1/);
  assert.equal(await evaluate("document.querySelectorAll('.trade-review-conflict-badge').length"), 1, "conflict row is visibly labelled");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"행 3 수율\"]').value"), "", "48/148 conflict is not prefilled");
  assert.equal(await evaluate("document.querySelector('.trade-review-table').textContent.includes('48')&&document.querySelector('.trade-review-table').textContent.includes('148')"), true, "both conflict alternatives are visible");
  assert.equal(await evaluate("document.querySelectorAll('.trade-review-source-details').length"), 2, "all merged source evidence remains reachable");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"행 1 획득품\"]').value"), "괴생물 촉수", "R003 candidate prefilled");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"행 1 소모품\"]').value"), "갈퀴 꽃 씨앗 주머니", "bounded correction candidate prefilled");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"행 1 남은 교환 횟수\"]').value"), "0", "zero remains an editable nonempty value");
  assert.equal(await evaluate("[...document.querySelectorAll('.trade-review-table tbody tr[data-capture-id]')].every(row=>row.textContent.includes('검수 대기'))"), true);
  assert.equal(await evaluate("document.querySelector('.trade-review-table').textContent.includes('정답')"), false);
  assert.equal(await evaluate("document.querySelector('.trade-review-table').textContent.includes('SAFE')"), false);
  assert.equal(await evaluate("document.querySelector('.trade-review-edge-title').textContent.includes('1행')"), true);
  assert.equal(await evaluate("document.querySelector('.trade-review-table').textContent.includes('숫자 후보는 있지만 원래 숫자 전체가 잘리지 않았는지는 확인되지 않았습니다.')"), true, "numeric completeness risk is visible");
  await evaluate("document.querySelectorAll('.trade-review-evidence summary')[0].click()");
  assert.equal(await evaluate("document.querySelector('.trade-review-table').textContent.includes('갈퀴 꽃 씨앗 주머니x')"), true, "OCR raw text remains available");
  await evaluate("document.querySelectorAll('.trade-review-crop-button')[0].click()");
  await waitFor(async () => evaluate("document.querySelectorAll('.trade-review-crop:not([hidden])').length===1"), "lazy source crop");
  const firstCrop = await evaluate(`(()=>{const image=document.querySelector('.trade-review-crop:not([hidden])');const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;const context=canvas.getContext('2d');context.drawImage(image,0,0,1,1);return [...context.getImageData(0,0,1,1).data].slice(0,3)})()`);
  assert.ok(firstCrop[0] > firstCrop[2] * 2, `first capture crop should be red, got ${firstCrop}`);
  await evaluate("document.querySelectorAll('.trade-review-crop-button')[6].click()");
  await waitFor(async () => evaluate("document.querySelectorAll('.trade-review-crop:not([hidden])').length===2"), "second capture crop");
  const secondCrop = await evaluate(`(()=>{const image=document.querySelectorAll('.trade-review-crop:not([hidden])')[1];const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;const context=canvas.getContext('2d');context.drawImage(image,0,0,1,1);return [...context.getImageData(0,0,1,1).data].slice(0,3)})()`);
  assert.ok(secondCrop[0] > secondCrop[2] * 2, `representative crop should remain the first capture, got ${secondCrop}`);
  await evaluate("document.querySelectorAll('.trade-review-source-details')[0].open=true;document.querySelectorAll('.trade-review-source-details')[0].querySelectorAll('.trade-review-member-crop-button')[6].click()");
  await waitFor(async () => evaluate("document.querySelectorAll('.trade-review-member-crop:not([hidden])').length===1"), "alternate source crop preview");
  const alternateCrop = await evaluate(`(()=>{const image=document.querySelector('.trade-review-member-crop:not([hidden])');const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;const context=canvas.getContext('2d');context.drawImage(image,0,0,1,1);return [...context.getImageData(0,0,1,1).data].slice(0,3)})()`);
  assert.ok(alternateCrop[2] > alternateCrop[0] * 2, `alternate source should use its own blue capture, got ${alternateCrop}`);

  await evaluate(`(()=>{const input=document.querySelector('[aria-label="행 1 섬"]');input.value='달래나루 수정';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const editedSummary = await evaluate("document.querySelector('.trade-review-summary').textContent");
  assert.equal(editedSummary.includes("수정 1"), true, editedSummary);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"표시된 모든 행과 경계 경고를 확인했습니다.\"]').checked"), false);
  assert.equal(await evaluate("document.querySelector('.trade-review-complete').disabled"), true, "batch confirmation is required");
  assert.equal(await evaluate("window.__r005CompletionEvents||0"), 0, "predictions do not become review truth before confirmation");
  await evaluate("document.querySelector('[aria-label=\"표시된 모든 행과 경계 경고를 확인했습니다.\"]').click()");
  assert.equal(await evaluate("document.querySelector('.trade-review-complete').disabled"), true, "blank non-unknown fields block completion");
  await evaluate("document.querySelector('[aria-label=\"행 2 필요 수량 모름으로 표시\"]').click()");
  await evaluate("(()=>{const input=document.querySelector('[aria-label=\"행 3 수율\"]');input.value='148';input.dispatchEvent(new Event('input',{bubbles:true}));})()");
  assert.equal(await evaluate("document.querySelector('.trade-review-complete').disabled"), true, "other conflict remains blocked until explicitly resolved");
  await evaluate("document.querySelector('[aria-label=\"행 3 남은 교환 횟수 모름으로 표시\"]').click()");
  assert.equal(await evaluate("document.querySelector('.trade-review-summary').textContent.includes('모름 2')"), true);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"행 2 필요 수량\"]').disabled"), true);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"행 2 필요 수량\"]').value"), "", "unknown preserves the blank evidence state");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"행 3 남은 교환 횟수\"]').disabled"), true, "conflicting count can be explicitly marked unknown");
  assert.equal(await evaluate("document.querySelector('.trade-review-complete').disabled"), false, "explicit unknown allows review completion");
  const writesBeforeCompletion = await (await fetch(`${baseUrl}__test__/requests`)).json();
  assert.equal(writesBeforeCompletion.filter((item) => item.method === "POST" && item.path.includes("trade-review-observations")).length, 0, "completion is the first persistence boundary");
  await evaluate(`(()=>{window.__r005Payload=null;window.__r005CompletionEvents=0;window.addEventListener('bdo:trade-review-completed',event=>{window.__r005CompletionEvents++;window.__r005Payload=event.detail;});})()`);
  await evaluate("document.querySelector('[data-close-trade-review]').click()");
  await waitFor(async () => evaluate("!document.querySelector('#trade-capture-dialog').open"), "dialog close");
  await evaluate("document.querySelector('#open-trade-capture').click()");
  await waitFor(async () => evaluate("document.querySelector('#trade-capture-dialog').open"), "dialog reopen");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"행 1 섬\"]').value"), "달래나루 수정", "pending edit persists across close/reopen");
  await evaluate("document.querySelector('[data-action=open-trade-review]').click()");
  assert.equal(await evaluate("document.querySelector('.trade-review-complete').disabled"), false);
  await evaluate("(()=>{window.__r005ButtonClicks=0;window.__r005Errors=[];window.addEventListener('error',event=>window.__r005Errors.push(event.message));document.querySelector('.trade-review-complete').addEventListener('click',()=>window.__r005ButtonClicks++,true)})()");
  await evaluate(`(()=>{window.__observationReceipt=null;window.__observationBodies=[];window.__parentFailures=['503','offline'];window.__lostObservationResponse=false;window.__cropAttempts=[];window.__cropFailureUsed=false;const original=window.fetch.bind(window);window.fetch=async(input,init={})=>{const url=typeof input==='string'?input:input.url;if(url.includes('/trade-review-observations')&&init.method==='POST'&&!url.includes('/crops')){window.__observationBodies.push(init.body);if(window.__rejectNextObservation){window.__rejectNextObservation=false;return new Response(JSON.stringify({ok:false,error:{code:'invalid_contract',message:'invalid_contract',retryable:false}}),{status:422,headers:{'Content-Type':'application/json'}})}const failure=window.__parentFailures.shift();if(failure==='503')return new Response(JSON.stringify({ok:false,error:{code:'temporary',message:'temporary outage',retryable:true}}),{status:503,headers:{'Content-Type':'application/json'}});if(failure==='offline')throw new TypeError('simulated offline');const response=await original(input,init);window.__observationReceipt=await response.clone().json();if(!window.__lostObservationResponse){window.__lostObservationResponse=true;throw new TypeError('simulated response loss after server commit')}return response}if(url.includes('/trade-review-observations')&&url.includes('/crops')&&init.method==='POST'){const metadata=JSON.parse(init.body.get('metadata'));window.__cropAttempts.push(metadata);if(!window.__cropFailureUsed){window.__cropFailureUsed=true;return new Response(JSON.stringify({ok:false,error:{code:'temporary',message:'temporary crop outage',retryable:true}}),{status:503,headers:{'Content-Type':'application/json'}})}}return original(input,init)}})()`);
  await evaluate("(()=>{const button=document.querySelector('.trade-review-complete');button.click();button.click()})()");
  await waitFor(async () => evaluate("!document.querySelector('.trade-review-storage-actions button:first-child').hidden"), "retry after committed response loss");
  assert.equal((await (await fetch(`${baseUrl}__test__/requests`)).json()).filter((item) => item.method === "POST" && item.path === "/api/recognition/trade-review-observations").length, 0, "synthetic 503 does not reach the server");
  assert.equal(await evaluate("window.__r005CompletionEvents"), 1, "double click emits only one completion event");
  await evaluate("document.querySelector('.trade-review-storage-actions button:first-child').click()");
  await waitFor(async () => evaluate("document.querySelector('[data-role=trade-recognition-status]').textContent.includes('같은 요청 ID')"), "offline retry state");
  assert.equal((await (await fetch(`${baseUrl}__test__/requests`)).json()).filter((item) => item.method === "POST" && item.path === "/api/recognition/trade-review-observations").length, 0, "offline attempt does not reach the server");
  await evaluate("document.querySelector('.trade-review-storage-actions button:first-child').click()");
  await waitFor(async () => evaluate("!document.querySelector('.trade-review-storage-actions button:first-child').hidden"), "retry after committed response loss");
  assert.equal((await (await fetch(`${baseUrl}__test__/observation-count`)).json()).count, 1, "first observation is committed before response loss");
  const observationReceipt = await evaluate("JSON.stringify(window.__observationReceipt)").then(JSON.parse);
  assert.equal(observationReceipt.ok, true);
  const storedResponse = await fetch(`${baseUrl}api/recognition/trade-review-observations/${observationReceipt.receipt.observationId}`);
  assert.equal(storedResponse.status, 200, "reconciled observation is readable from the unchanged R006 endpoint");
  const stored = (await storedResponse.json()).observation;
  const storedProjection = stored.sourceContext.projection.snapshot;
  assert.equal(storedProjection.reconciliation.sourceRows.length, 6);
  assert.equal(storedProjection.reconciliation.captureOrder.length, 2);
  assert.deepEqual(storedProjection.reconciliation.sourceRows.reduce((counts, row) => { counts[row.captureId] = (counts[row.captureId] || 0) + 1; return counts; }, {}),
    { [storedProjection.reconciliation.captureOrder[0].captureId]: 3, [storedProjection.reconciliation.captureOrder[1].captureId]: 3 });
  assert.equal(stored.completion.rows.length, 4);
  assert.equal(stored.completion.summary.fieldCount, 24);
  assert.equal(storedProjection.reconciliation.sourceProjectionEvidence.length, 4);
  const conflictProjectionRow = storedProjection.rows.find((row) => row.reconciliationStatus === "CONFLICT");
  assert.deepEqual(conflictProjectionRow.fields.yield.alternatives.map((item) => item.value), [48, 148]);
  const exportResponse = await fetch(`${baseUrl}api/recognition/trade-review-observations/${observationReceipt.receipt.observationId}/export`);
  assert.equal(exportResponse.status, 200, "reconciled observation export uses the unchanged R006 endpoint");
  const exportedObservation = await exportResponse.json();
  assert.equal(exportedObservation.schemaVersion, 1);
  assert.equal(exportedObservation.semantic.observation.sourceContext.projection.snapshot.reconciliation.sourceRows.length, 6);
  assert.equal(exportedObservation.semantic.dataset.fields.length, 24, "export contains logical human fields, not multiplied source truths");
  await evaluate("document.querySelector('[data-close-trade-review]').click()");
  await evaluate("document.querySelector('#open-trade-capture').click()");
  await waitFor(async () => evaluate("document.querySelector('#trade-capture-dialog').open"), "reopen while persistence retry is pending");
  await evaluate("document.querySelector('[data-action=open-trade-review]').click()");
  await evaluate("document.querySelector('.trade-review-storage-actions button:first-child').click()");
  await waitFor(async () => evaluate("document.querySelector('[data-role=trade-recognition-status]').textContent.includes('원본 영역은 아직 연결되지 않았습니다')"), "partial crop retry state");
  assert.equal(await evaluate("window.__observationBodies.length"), 4, "503, offline, response-loss, and replay attempts reuse one observation job");
  assert.equal(await evaluate("window.__observationBodies.slice(0,4).every(body=>body===window.__observationBodies[0])"), true, "every parent retry reuses identical serialized bytes and mutation ID");
  const partialCropAttempts = await evaluate("JSON.stringify(window.__cropAttempts.map(item=>item.cropMutationId))").then(JSON.parse);
  assert.ok(partialCropAttempts.length >= 2, "selected crops were attempted");
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  assert.equal(await evaluate("window.__r005CompletionEvents===1"), true, await evaluate("JSON.stringify({message:document.querySelector('.trade-review-message').textContent,disabled:document.querySelector('.trade-review-complete').disabled,checked:document.querySelector('[aria-label=\"표시된 모든 행과 경계 경고를 확인했습니다.\"]').checked,eventCount:window.__r005CompletionEvents,clicks:window.__r005ButtonClicks,errors:window.__r005Errors,summary:document.querySelector('.trade-review-summary').textContent})"));
  const payload = await evaluate("JSON.stringify(window.__r005Payload)").then(JSON.parse);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.reviewMode, "REVIEW_FIRST");
  assert.equal(payload.rows.length, 4);
  assert.equal(payload.summary.fieldCount, 24);
  assert.equal(payload.edgeSegments.length, 1);
  assert.equal(payload.summary.unknownFieldCount, 2);
  assert.equal(payload.rows[0].fields.find(field=>field.field==='island').verificationMethod, "USER_EDITED");
  assert.equal(payload.rows[0].fields.find(field=>field.field==='count').verificationMethod, "USER_BATCH_CONFIRMED_UNCHANGED");
  assert.equal(payload.rows[0].fields.find(field=>field.field==='count').finalValue, 0);
  assert.equal(payload.rows[1].fields.find(field=>field.field==='toItem').verificationMethod, "USER_BATCH_CONFIRMED_UNCHANGED", "merged exact row has one human confirmation");
  assert.equal(payload.rows[1].fields.find(field=>field.field==='reqAmount').verificationMethod, "USER_MARKED_UNKNOWN");
  assert.equal(payload.rows[2].fields.find(field=>field.field==='yield').verificationMethod, "USER_EDITED", "yield conflict requires explicit user value");
  assert.equal(payload.rows[2].fields.find(field=>field.field==='count').verificationMethod, "USER_MARKED_UNKNOWN", "count conflict can be explicitly unknown");
  assert.equal(await evaluate("Object.isFrozen(window.__r005Payload)&&Object.isFrozen(window.__r005Payload.rows)&&Object.isFrozen(window.__r005Payload.rows[0].fields[0])"), true, "completion payload is deeply frozen");
  assert.equal(await evaluate("document.querySelector('.trade-review-message').textContent"), "검수를 완료했습니다. 아직 현재 회차에는 적용하지 않았습니다.");
  assert.equal(await evaluate("document.body.textContent.includes('현재 회차에 적용 완료')"), false);
  assert.deepEqual(await (await fetch(`${baseUrl}api/bootstrap`)).json(), bootstrapBefore, "isolated DB bootstrap unchanged");
  assert.equal(await evaluate("document.querySelector('#trade-list-root').textContent"), tradeListBefore, "current trade list unchanged");
  await evaluate("document.querySelector('.trade-review-footer').scrollIntoView({block:'end'})");
  const viewport = await evaluate("JSON.stringify({innerWidth,innerHeight,devicePixelRatio,dialog:(()=>{const r=document.querySelector('#trade-recognition-review-dialog').getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}})(),footerVisible:(()=>{const r=document.querySelector('.trade-review-footer').getBoundingClientRect();return r.bottom<=innerHeight&&r.top>=0})(),reviewScrollable:document.querySelector('.trade-review-table-wrap').scrollHeight>=document.querySelector('.trade-review-table-wrap').clientHeight})").then(JSON.parse);
  assert.ok(Math.abs(viewport.devicePixelRatio - 1.3) < 0.001);
  assert.ok(viewport.dialog.left >= 0 && viewport.dialog.top >= 0 && viewport.dialog.right <= viewport.innerWidth && viewport.dialog.bottom <= viewport.innerHeight, `dialog should fit viewport: ${JSON.stringify(viewport)}`);
  assert.equal(viewport.footerVisible, true, JSON.stringify(viewport));
  assert.equal(viewport.reviewScrollable, true);

  await evaluate("document.querySelector('.capture-draft-item button').click()");
  assert.equal(await evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength"), "1", "queue can change while the immutable crop job remains pending");
  assert.equal(await evaluate("!document.querySelector('.trade-review-storage-actions button:first-child').hidden"), true, "queue mutation preserves the pending crop retry");
  await evaluate("document.querySelector('.trade-review-storage-actions button:first-child').click()");
  await waitFor(async () => evaluate("document.querySelector('[data-role=trade-recognition-status]').textContent.includes('저장')&&document.querySelector('[data-role=trade-recognition-status]').textContent.includes('완료')"), "partial crop retry completion");
  await waitFor(async () => evaluate("Boolean(document.querySelector('[data-role=session-apply-status]')?.textContent) && document.querySelector('[data-role=session-apply-status]').textContent !== '저장된 검수 자료를 확인하는 중입니다.'"), "R008 validation handoff");
  const initialApplyStatus = await evaluate("document.querySelector('[data-role=session-apply-status]')?.textContent||''");
  if (initialApplyStatus.includes("최종 DTO를 만들 수 없어")) throw new Error(`R008 should validate for the session bridge: ${initialApplyStatus}`);
  const heldCheckboxes = await evaluate("document.querySelectorAll('.trade-review-held-exclusion input[type=checkbox]').length");
  if (heldCheckboxes) {
    await evaluate("document.querySelectorAll('.trade-review-held-exclusion input[type=checkbox]').forEach(input=>{if(!input.checked)input.click()})");
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  const readyStatus = await evaluate("document.querySelector('[data-role=session-apply-status]').textContent");
  if (!readyStatus.includes("최종 목록")) throw new Error(`expected ready reviewed DTO after explicit exclusions: ${JSON.stringify({readyStatus,checks:await evaluate("JSON.stringify([...document.querySelectorAll('.trade-review-held-exclusion input')].map(input=>input.checked))")})}`);
  const writesBeforeApply = (await (await fetch(`${baseUrl}__test__/requests`)).json()).filter((item) => item.method === "PUT" && item.path === "/api/working-session");
  assert.equal(writesBeforeApply.length, 0, "R006 evidence and R008 validation do not mutate the session");
  await evaluate("document.querySelector('[data-action=apply-reviewed-new]').click()");
  await waitFor(async () => evaluate("!document.querySelector('[data-action=commit-session-stage]').hidden"), "explicit NEW candidate stage");
  const beforePutState = await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({local:state.session.scannedTrades,durable:state.workingSession}))").then(JSON.parse);
  assert.equal(beforePutState.durable, null, "candidate staging does not mutate local or durable session");
  assert.deepEqual(beforePutState.local, null);
  await evaluate(`(()=>{window.__sessionPutBodies=[];window.__sessionPutResponses=[];window.__loseNextSessionPut=true;window.__failNextSessionBootstrap=true;const original=window.fetch.bind(window);window.fetch=async(input,init={})=>{const url=typeof input==='string'?input:input.url;if(url.endsWith('/api/working-session')&&init.method==='PUT'){window.__sessionPutBodies.push(init.body);const response=await original(input,init);window.__sessionPutResponses.push(await response.clone().json());if(window.__loseNextSessionPut){window.__loseNextSessionPut=false;throw new TypeError('simulated committed response loss')}return response}if(url.endsWith('/api/bootstrap')&&window.__failNextSessionBootstrap){window.__failNextSessionBootstrap=false;throw new TypeError('simulated readback outage')}return original(input,init)}})()`);
  await evaluate("(()=>{window.__sessionChangedEvents=0;window.addEventListener('bdo:session-changed',()=>window.__sessionChangedEvents++)})()");
  await evaluate("(()=>{const button=document.querySelector('[data-action=commit-session-stage]');button.click();button.click()})()");
  await waitFor(async () => evaluate("document.querySelector('[data-role=session-apply-status]')?.dataset.state==='COMMIT_RESPONSE_UNKNOWN'"), "session response-loss state");
  const unknownState = await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({local:state.session.scannedTrades,durable:state.workingSession,pending:window.__bdoScheduleRuntime.pending}))").then(JSON.parse);
  assert.equal(unknownState.local, null, "response loss never applies the session locally");
  assert.equal(unknownState.durable, null, "ordinary local state remains at the last confirmed bootstrap");
  assert.equal(unknownState.pending, true, "external pending guard remains active during response uncertainty");
  assert.ok((await (await fetch(`${baseUrl}api/bootstrap`)).json()).workingSession, "server committed despite lost response");
  await evaluate("document.querySelector('[data-action=retry-session-commit]').click()");
  await waitFor(async () => evaluate("document.querySelector('[data-role=session-apply-status]')?.dataset.state==='COMMIT_CONFIRMED_READBACK_PENDING'"), "committed readback-pending state");
  const pendingReadbackState = await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({local:state.session.scannedTrades,durable:state.workingSession,pending:window.__bdoScheduleRuntime.pending}))").then(JSON.parse);
  assert.equal(pendingReadbackState.local, null, "idempotent PUT replay does not apply before successful readback");
  assert.equal(pendingReadbackState.pending, true);
  const putBodies = await evaluate("JSON.stringify(window.__sessionPutBodies)").then(JSON.parse);
  assert.equal(putBodies.length, 2, "one lost response is recovered by exactly one same-body replay");
  assert.equal(putBodies[0], putBodies[1], "retry reuses exact serialized PUT body and mutation ID");
  assert.equal(await evaluate("window.__sessionPutResponses[1].idempotent"), true, "backend idempotency receipt handles replay");
  await evaluate("document.querySelector('[data-action=retry-session-readback]').click()");
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  const readbackStatus = await evaluate("document.querySelector('[data-role=session-apply-status]')?.textContent||''");
  if (!readbackStatus.includes("회차에 저장했고 다시 읽어 확인했습니다")) throw new Error(`verified readback did not apply: ${readbackStatus}`);
  const firstApplied = await (await fetch(`${baseUrl}api/bootstrap`)).json();
  assert.ok(firstApplied.workingSession && firstApplied.workingSession.scannedTrades.length > 0);
  assert.equal(firstApplied.workingSession.schedule, null);
  assert.equal(firstApplied.workingSession.completed, null);
  assert.equal(firstApplied.workingSession.diagnostics.type, "TRADE_REVIEW_SESSION_APPLY");
  assert.equal(firstApplied.workingSession.diagnostics.mode, "NEW");
  assert.equal(await evaluate("window.__sessionChangedEvents"), 0, "readback apply does not trigger a duplicate session save");
  let sessionWriteRequests = (await (await fetch(`${baseUrl}__test__/requests`)).json()).filter((item) => item.method === "PUT" && item.path === "/api/working-session");
  assert.equal(sessionWriteRequests.length, 2, "double click plus explicit response-loss replay produces only two identical PUT attempts");
  assert.equal(sessionWriteRequests[0].body.baseRevision, bootstrapBefore.revision);
  assert.equal(Object.keys(sessionWriteRequests[0].body).sort().join(","), "baseRevision,mutationId,session");
  assert.deepEqual(sessionWriteRequests[0].body, sessionWriteRequests[1].body, "request retry does not change candidate");
  await evaluate("document.querySelector('[data-action=cancel-session-stage]').click()");
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  const appendControlState = await evaluate("Promise.all([import('/assets/js/state.js'),Promise.resolve()]).then(([{state}])=>JSON.stringify({disabled:document.querySelector('[data-action=apply-reviewed-append]')?.disabled,pending:window.__bdoScheduleRuntime.pending,local:state.session.scannedTrades?.length,durable:state.workingSession?.scannedTrades?.length,status:document.querySelector('[data-role=session-apply-status]')?.textContent}))").then(JSON.parse);
  if (appendControlState.disabled) throw new Error(`APPEND unavailable after NEW: ${JSON.stringify(appendControlState)}`);
  await evaluate("document.querySelector('[data-action=apply-reviewed-append]').click()");
  await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
  const duplicateApplyStatus = await evaluate("document.querySelector('[data-role=session-apply-status]')?.textContent||''");
  if ((await evaluate("document.querySelector('[data-role=session-apply-status]')?.dataset.state")) !== "NO_CHANGE") throw new Error(`same-batch APPEND did not become NO_CHANGE: ${duplicateApplyStatus}`);
  sessionWriteRequests = (await (await fetch(`${baseUrl}__test__/requests`)).json()).filter((item) => item.method === "PUT" && item.path === "/api/working-session");
  assert.equal(sessionWriteRequests.length, 2, "all exact6 duplicates add no new PUT beyond the response-loss replay");
  await evaluate("document.querySelector('[data-action=cancel-session-stage]').click()");
  await evaluate("window.confirm=()=>false;document.querySelector('[data-action=apply-reviewed-new]').click()");
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  assert.equal(await evaluate("document.querySelector('[data-action=commit-session-stage]')?.hidden"), true, "cancelled NEW replacement does not create a request candidate");
  assert.equal((await (await fetch(`${baseUrl}api/bootstrap`)).json()).workingSession.id, firstApplied.workingSession.id, "cancelled replacement leaves durable session unchanged");
  await evaluate("window.confirm=()=>true;document.querySelector('[data-action=apply-reviewed-new]').click()");
  await waitFor(async () => evaluate("document.querySelector('[data-action=commit-session-stage]')?.hidden===false"), "confirmed NEW replacement stage");
  await evaluate("document.querySelector('[data-action=cancel-session-stage]').click()");
  const beforeStaleStage = await (await fetch(`${baseUrl}api/bootstrap`)).json();
  await evaluate("document.querySelector('[data-action=apply-reviewed-new]').click()");
  await waitFor(async () => evaluate("document.querySelector('[data-action=commit-session-stage]')?.hidden===false"), "stale-test replacement candidate");
  const settingsBump = await fetch(`${baseUrl}api/settings`, { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mutationId: "r009-stale-settings-bump", baseRevision: beforeStaleStage.revision, settings: { parley: beforeStaleStage.settings.parley } }) });
  assert.equal(settingsBump.status, 200, "isolated settings revision advances after staging");
  await evaluate("document.querySelector('[data-action=commit-session-stage]').click()");
  await waitFor(async () => evaluate("document.querySelector('[data-role=session-apply-status]')?.dataset.state==='STALE'"), "first-attempt 409 stale status");
  const staleLocal = await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({local:state.session.id,durable:state.workingSession.id,pending:window.__bdoScheduleRuntime.pending}))").then(JSON.parse);
  assert.equal(staleLocal.local, firstApplied.workingSession.id);
  assert.equal(staleLocal.durable, firstApplied.workingSession.id);
  assert.equal(staleLocal.pending, null, "409 clears pending without auto-rebase");
  assert.equal((await (await fetch(`${baseUrl}__test__/requests`)).json()).filter((item) => item.method === "PUT" && item.path === "/api/working-session").length, 3,
    "cancelled replacement was not sent and first-attempt 409 is not automatically retried");
  await evaluate("document.querySelector('[data-action=cancel-session-stage]').click()");
  const cropMutationIds = await evaluate("JSON.stringify(window.__cropAttempts.map(item=>item.cropMutationId))").then(JSON.parse);
  const cropCounts = cropMutationIds.reduce((counts,id)=>counts.set(id,(counts.get(id)||0)+1),new Map());
  assert.equal([...cropCounts.values()].filter(count=>count===2).length, 1, "only the crop that failed is retried");
  assert.equal([...cropCounts.values()].filter(count=>count===1).length, cropCounts.size-1, "successful crop uploads are not repeated");

  assert.equal(await evaluate("document.querySelector('[data-role=trade-recognition-result]').hidden"), true, "queue mutation clears the stale review state");
  assert.equal(await evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength"), "1", "clear keeps the mutated queue");
  await evaluate("document.querySelector('[data-action=recognize-trade]').click()");
  await waitFor(async () => evaluate("document.querySelectorAll('.trade-review-input').length===18"), "review for queue mutation check");
  await evaluate(`(()=>{window.__rejectNextObservation=true;window.__downloads=[];const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=create(blob);if(blob instanceof Blob)blob.text().then(text=>window.__downloads.push({text}));return url};HTMLAnchorElement.prototype.click=function(){window.__downloads.push({name:this.download,href:this.href})}})()`);
  await evaluate("document.querySelector('[aria-label=\"행 2 필요 수량 모름으로 표시\"]').click()");
  await evaluate("document.querySelector('[aria-label=\"표시된 모든 행과 경계 경고를 확인했습니다.\"]').click()");
  await evaluate("document.querySelector('.trade-review-complete').click()");
  await waitFor(async () => evaluate("document.querySelector('[data-role=trade-recognition-status]').textContent.includes('invalid_contract')"), "nonretryable observation rejection");
  assert.equal(await evaluate("document.querySelector('.trade-review-storage-actions button:first-child').hidden"), true, "nonretryable rejection does not offer retry");
  assert.equal(await evaluate("document.querySelector('.trade-review-storage-actions button:last-child').hidden"), false, "nonretryable rejection offers local export");
  await evaluate("document.querySelector('.trade-review-storage-actions button:last-child').click()");
  await waitFor(async () => evaluate("window.__downloads.some(item=>item.text&&item.text.includes('sourceContext'))"), "download rejected observation payload");
  assert.equal(await evaluate("window.__downloads.some(item=>item.name&&item.name.startsWith('trade-review-'))"), true, "download has a review JSON filename");
  await evaluate("document.querySelector('.capture-draft-item button').click()");
  assert.equal(await evaluate("document.querySelector('[data-role=trade-recognition-result]').hidden"), true, "queue mutation invalidates review and edits");
  assert.equal(await evaluate("document.querySelectorAll('.trade-review-input').length"), 0);
  assert.equal(await evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength"), "0");
  assert.equal(await evaluate("window.__r005CompletionEvents"), 2, "queue mutation cannot emit another completion");
  await reloadAndWait("reload restores staged reviewed session");
  const reloaded = await (await fetch(`${baseUrl}api/bootstrap`)).json();
  await waitFor(async () => evaluate(`document.querySelectorAll('.trade-row').length===${reloaded.workingSession.scannedTrades.length}`), "trade list after session reload");
  assert.equal(reloaded.workingSession.id, firstApplied.workingSession.id);
  assert.deepEqual(reloaded.workingSession.scannedTrades, firstApplied.workingSession.scannedTrades);
  assert.equal(await evaluate("document.querySelectorAll('.trade-row').length"), firstApplied.workingSession.scannedTrades.length, "reload restores trade list");

  const v3Inputs = [
    createReadyV3Batch({ mutationId: "00000000-0000-4000-8000-000000000021" }),
    createReadyV3Batch({ mutationId: "00000000-0000-4000-8000-000000000022", values: { island: "다른 섬", fromItem: "재료", reqAmount: 1, toItem: "교환품", count: 0, yield: 48 } }),
    createReadyV3Batch({ mutationId: "00000000-0000-4000-8000-000000000023", values: { island: "섬", fromItem: "재료", reqAmount: 1, toItem: "교환품", count: 1, yield: 48 } }),
    createReadyV3Batch({ mutationId: "00000000-0000-4000-8000-000000000024", values: { island: "섬", fromItem: "다른 재료", reqAmount: 1, toItem: "교환품", count: 0, yield: 48 } }),
  ].map((fixture) => ({ request: fixture.request, expectedReview: fixture.expectedReview }));
  await evaluate(`window.__v3Inputs=${JSON.stringify(v3Inputs)}`);
  const v3NewResult = await evaluate(`(async()=>{
    const {validateReviewedTradeBatch}=await import('/assets/js/domain/reviewed-trade-dto.js');
    const {buildReviewedTradeSessionStage}=await import('/assets/js/domain/trade-session-staging.js');
    const {state}=await import('/assets/js/state.js');
    const saved=[];
    for(const fixture of window.__v3Inputs){
      const post=await fetch('/api/recognition/trade-review-observations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(fixture.request)});
      const postBody=await post.json();if(post.status!==201)throw new Error('v3 observation POST '+post.status+' '+JSON.stringify(postBody));
      const receipt=postBody.receipt;const read=await fetch('/api/recognition/trade-review-observations/'+receipt.observationId+'?schemaVersion=3');
      const readBody=await read.json();if(!read.ok)throw new Error('v3 observation readback failed '+JSON.stringify(readBody));
      const batch=validateReviewedTradeBatch({storedObservation:readBody.observation,evidenceReceipt:receipt,expectedReview:fixture.expectedReview,mappingPolicyVersion:'reviewed-trade-dto-mapping-v3'});
      if(batch.status!=='READY'||batch.schemaVersion!==1)throw new Error('v3 DTO not READY '+JSON.stringify(batch.batchErrors));
      saved.push({batch,receipt});
    }
    const boot=await (await fetch('/api/bootstrap')).json();const localBefore=JSON.stringify(state.session.scannedTrades);
    const staged=buildReviewedTradeSessionStage({mode:'NEW',validatedBatch:saved[0].batch,currentWorkingSession:null,localSession:null,settings:boot.settings,
      baseRevision:boot.revision,sessionRevision:null,mutationId:'50000000-0000-4000-8000-000000000001',newSessionId:'50000000-0000-4000-8000-000000000011'});
    if(staged.status!=='READY')throw new Error('v3 NEW stage blocked '+JSON.stringify(staged.reasons));
    if(JSON.stringify(state.session.scannedTrades)!==localBefore)throw new Error('stage mutated local session before durable commit');
    const put=await fetch('/api/working-session',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(staged.request)});const putBody=await put.json();
    if(!put.ok)throw new Error('v3 NEW durable commit failed '+JSON.stringify(putBody));
    const readback=await (await fetch('/api/bootstrap')).json();
    const canonicalRow=row=>Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]]));
    if(JSON.stringify(readback.workingSession.scannedTrades.map(canonicalRow))!==JSON.stringify([saved[0].batch.rows[0].dto].map(canonicalRow)))throw new Error('v3 NEW readback mismatch '+JSON.stringify({actual:readback.workingSession.scannedTrades,expected:[saved[0].batch.rows[0].dto]}));
    window.__v3Batches=saved.map(item=>item.batch);window.__v3Receipts=saved.map(item=>item.receipt);window.__v3NewReadback=readback;
    return {status:staged.status,receiptSessionApplied:saved[0].receipt.sessionApplied,row:readback.workingSession.scannedTrades[0],observationRef:saved[0].batch.observationRef};
  })()`);
  assert.equal(v3NewResult.status, "READY"); assert.equal(v3NewResult.receiptSessionApplied, false);
  assert.deepEqual(Object.keys(v3NewResult.row).sort(), ["count", "fromItem", "island", "reqAmount", "toItem", "yield"].sort());
  assert.equal(v3NewResult.row.count, 0); assert.equal(v3NewResult.observationRef.schemaVersion, 3);
  const v3BatchesForAppend = await evaluate("JSON.stringify(window.__v3Batches)").then(JSON.parse);
  await reloadAndWait("v3 NEW durable session reload");
  let v3Bootstrap = await (await fetch(`${baseUrl}api/bootstrap`)).json();
  await waitFor(async () => evaluate("document.querySelectorAll('.trade-row').length===1"), "v3 NEW rendered session row");
  assert.equal(v3Bootstrap.workingSession.id, "50000000-0000-4000-8000-000000000011");
  assert.equal(await evaluate("document.querySelectorAll('.trade-row').length"), 1);
  await evaluate(`window.__v3Batches=${JSON.stringify(v3BatchesForAppend)}`);
  const v3AppendResults = await evaluate(`(async()=>{
    const {buildReviewedTradeSessionStage}=await import('/assets/js/domain/trade-session-staging.js');
    const {state}=await import('/assets/js/state.js');
    const before=(await fetch('/api/bootstrap')).json();const boot=await before;let current=boot.workingSession;
    const stage=(batch,mutationId)=>buildReviewedTradeSessionStage({mode:'APPEND',validatedBatch:batch,currentWorkingSession:current,localSession:current,
      settings:boot.settings,baseRevision:boot.revision,sessionRevision:current.revision??boot.revision,mutationId,newSessionId:null});
    const appended=stage(window.__v3Batches[1],'50000000-0000-4000-8000-000000000002');if(appended.status!=='READY')throw new Error('v3 APPEND stage blocked '+JSON.stringify(appended.reasons));
    const put=await fetch('/api/working-session',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(appended.request)});const putBody=await put.json();
    if(!put.ok)throw new Error('v3 APPEND commit failed '+JSON.stringify(putBody));
    const after=await (await fetch('/api/bootstrap')).json();if(after.workingSession.scannedTrades.length!==2)throw new Error('v3 APPEND readback row count mismatch');current=after.workingSession;
    const duplicate=stage(window.__v3Batches[1],'browser-v3-session-duplicate');if(duplicate.status!=='NO_CHANGE')throw new Error('v3 exact duplicate should be NO_CHANGE');
    const numeric=stage(window.__v3Batches[2],'browser-v3-session-numeric');if(numeric.status!=='BLOCKED'||numeric.request!==null)throw new Error('v3 numeric conflict must block without a request');
    const input=stage(window.__v3Batches[3],'browser-v3-session-input');if(input.status!=='BLOCKED'||input.request!==null)throw new Error('v3 input conflict must block without a request');
    window.__v3AppendReadback=after;return {status:appended.status,rows:after.workingSession.scannedTrades,duplicate:duplicate.status,numeric:numeric.status,input:input.status};
  })()`);
  assert.equal(v3AppendResults.status, "READY"); assert.equal(v3AppendResults.rows.length, 2);
  assert.equal(v3AppendResults.duplicate, "NO_CHANGE"); assert.equal(v3AppendResults.numeric, "BLOCKED"); assert.equal(v3AppendResults.input, "BLOCKED");
  await reloadAndWait("v3 APPEND durable session reload");
  v3Bootstrap = await (await fetch(`${baseUrl}api/bootstrap`)).json();
  await waitFor(async () => evaluate("document.querySelectorAll('.trade-row').length===2"), "v3 APPEND rendered rows");
  assert.equal(v3Bootstrap.workingSession.scannedTrades.length, 2);
  assert.deepEqual(v3Bootstrap.workingSession.scannedTrades, v3AppendResults.rows);
  const requests = await (await fetch(`${baseUrl}__test__/requests`)).json();
  const sessionWrites = requests.filter((item) => ["POST", "PUT", "PATCH", "DELETE"].includes(item.method) && item.path.startsWith("/api/working-session"));
  const observationPosts = requests.filter((item) => item.method === "POST" && item.path === "/api/recognition/trade-review-observations");
  assert.equal(sessionWrites.length, 5, "only three legacy attempts and explicit v3 NEW/APPEND commits reach the session endpoint");
  assert.equal(observationPosts.length, 6, "legacy replay and four stored v3 observations are accounted");
  assert.equal(requests.filter((item) => item.method === "POST" && item.path.endsWith("/truth-labels")).length, 0, "DTO/session apply never creates crop truth");
  assert.equal((await (await fetch(`${baseUrl}__test__/observation-count`)).json()).count, 1, "idempotent retry retains one immutable observation");
  assert.equal((await (await fetch(`${baseUrl}__test__/observation-v3-count`)).json()).count, 4, "v3 evidence is persisted separately and remains immutable");
  const testDb = await (await fetch(`${baseUrl}__test__/db`)).json();
  assert.equal(testDb.databaseExists, true);
  assert.ok(testDb.appDbPath.startsWith(profile), "only the temporary test DB was accessed");
  console.log("browser_trade_review_session: PASS · legacy REVIEW_FIRST preserved; Observation3→schema1 DTO→v3 NEW/APPEND, duplicate/conflict holds, DB-first PUT/readback/reload; truth POST 0 · Chrome 1920×1080 + CDP deviceScaleFactor 1.3");
} finally {
  try { socket?.close(); } catch {}
  await Promise.all([stopChild(chrome), stopChild(server)]);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { await rm(profile, { recursive: true, force: true }); break; }
    catch (error) { if (error.code !== "EBUSY" || attempt === 7) throw error; await new Promise((resolveWait) => setTimeout(resolveWait, 150)); }
  }
}
