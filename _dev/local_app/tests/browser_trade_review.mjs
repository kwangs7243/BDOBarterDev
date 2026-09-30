import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = process.env.BDO_TEST_URL ?? "http://127.0.0.1:18773/";
const python = process.env.PYTHON ?? "python";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-r005-review-"));
const database = join(profile, "isolated.sqlite3");
const port = new URL(baseUrl).port || "18773";
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
        for ordinal, capture in enumerate(captures, 1):
            fields={}
            values={"island":"달래나루", "fromItem":"갈퀴 꽃 씨앗 주머니x", "reqAmount":"10", "toItem":"괴생물 촉수", "count":"0", "yield":"48"}
            if ordinal == 2: values["reqAmount"] = None
            for index, key in enumerate(FIELD_KEYS):
                raw=values[key]
                fields[key]={"value":None,"rawText":raw,"normalizedText":raw,"rawNumericCandidate":48 if key == "yield" else (0 if key == "count" else None),
                    "status":"EMPTY_OCR" if raw is None else ("FIELD_CLIPPED" if key == "yield" else "RAW_OCR_CANDIDATE"),
                    "reasonCodes":["EMPTY_OCR"] if raw is None else (["FIELD_CLIPPED"] if key == "yield" else []),
                    "readerEvidence":{"readerId":"test-only","geometry":{"box":{"x":index*10,"y":4,"width":8,"height":8}}}}
            rows.append({"captureId":capture["captureId"],"ordinal":ordinal,"rowBox":{"x":0,"y":0,"width":80,"height":60},
                "rowCropHash":hashlib.sha256(f"row-{ordinal}".encode()).hexdigest(),"sourceRefs":[{"captureId":capture["captureId"],"ordinal":ordinal}],
                "fields":fields,"status":"DRAFT_UNVERIFIED","automationDecision":"REVIEW"})
        captures_out=[{"captureId":c["captureId"],"batchId":c["metadata"]["batchId"],"captureOrdinal":index+1,"imageHash":hashlib.sha256(c["imageBytes"]).hexdigest(),"imageDimensions":{"width":100,"height":80},"detectedCandidateCount":1,"completeRowCount":1,"edgeSegmentCount":0} for index,c in enumerate(captures)]
        captures_out[0]["detectedCandidateCount"]=2; captures_out[0]["edgeSegmentCount"]=1
        return {"captures":captures_out,"draftRows":rows,
            "edgeSegments":[{"captureId":captures[0]["captureId"],"rowBox":{"x":0,"y":0,"width":80,"height":20},"boundarySide":"bottom","classification":"EDGE_SEGMENT_UNCERTAIN","reasonCodes":["ROW_BOUNDARY_CONTACT"]}],
            "metrics":{"boundaryPolicy":"edge-segments-evidence-only-v1","detectedCandidateCount":len(captures)+1,"completeRowCount":len(captures),"edgeSegmentCount":1,"draftRowCount":len(captures)},
            "runtime":{"available":True,"engineId":"r005-test-only"}}
app=create_app(r'${database}', testing=True)
fake=FakeRuntime(); app.extensions["trade_batch_runtime"]=fake
requests=[]
@app.before_request
def record_request(): requests.append({"method":request.method,"path":request.path})
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
  const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(baseUrl)}`, { method: "PUT" });
  assert.equal(targetResponse.ok, true);
  const target = await targetResponse.json(); socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const pending = new Map(); let nextId = 0;
  socket.addEventListener("message", (event) => { const message = JSON.parse(event.data); if (!message.id || !pending.has(message.id)) return; const waiter = pending.get(message.id); pending.delete(message.id); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result); });
  send = (method, params = {}) => new Promise((resolveMessage, reject) => { const id = ++nextId; pending.set(id, { resolve: resolveMessage, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.result?.description ?? result.exceptionDetails.text); return result.result?.value; };
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
  await waitFor(async () => evaluate("document.querySelectorAll('.trade-review-table tbody tr[data-capture-id]').length===2"), "all-row review projection");
  assert.equal(await evaluate("document.querySelectorAll('.trade-review-table tbody tr[data-capture-id]').length"), 2);
  assert.equal(await evaluate("document.querySelectorAll('.trade-review-input').length"), 12, "two rows expose all six editable values");
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
  assert.ok(secondCrop[2] > secondCrop[0] * 2, `second row should use its matching blue capture, got ${secondCrop}`);

  await evaluate(`(()=>{const input=document.querySelector('[aria-label="행 1 섬"]');input.value='달래나루 수정';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const editedSummary = await evaluate("document.querySelector('.trade-review-summary').textContent");
  assert.equal(editedSummary.includes("수정 1"), true, editedSummary);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"표시된 모든 행과 경계 경고를 확인했습니다.\"]').checked"), false);
  assert.equal(await evaluate("document.querySelector('.trade-review-complete').disabled"), true, "batch confirmation is required");
  assert.equal(await evaluate("window.__r005CompletionEvents||0"), 0, "predictions do not become review truth before confirmation");
  await evaluate("document.querySelector('[aria-label=\"표시된 모든 행과 경계 경고를 확인했습니다.\"]').click()");
  assert.equal(await evaluate("document.querySelector('.trade-review-complete').disabled"), true, "blank non-unknown fields block completion");
  await evaluate("document.querySelector('[aria-label=\"행 2 필요 수량 모름으로 표시\"]').click()");
  assert.equal(await evaluate("document.querySelector('.trade-review-summary').textContent.includes('모름 1')"), true);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"행 2 필요 수량\"]').disabled"), true);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"행 2 필요 수량\"]').value"), "", "unknown preserves the blank evidence state");
  assert.equal(await evaluate("document.querySelector('.trade-review-complete').disabled"), false, "explicit unknown allows review completion");
  const writesBeforeCompletion = await (await fetch(`${baseUrl}__test__/requests`)).json();
  assert.equal(writesBeforeCompletion.filter((item) => item.method === "POST" && item.path.includes("trade-review-observations")).length, 0, "completion is the first persistence boundary");
  await evaluate(`(()=>{window.__r005Payload=null;window.__r005CompletionEvents=0;window.addEventListener('bdo:trade-review-completed',event=>{window.__r005CompletionEvents++;window.__r005Payload=event.detail;});})()`);
  await evaluate("document.querySelector('[data-close-trade-capture]').click()");
  await waitFor(async () => evaluate("!document.querySelector('#trade-capture-dialog').open"), "dialog close");
  await evaluate("document.querySelector('#open-trade-capture').click()");
  await waitFor(async () => evaluate("document.querySelector('#trade-capture-dialog').open"), "dialog reopen");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"행 1 섬\"]').value"), "달래나루 수정", "pending edit persists across close/reopen");
  assert.equal(await evaluate("document.querySelector('.trade-review-complete').disabled"), false);
  await evaluate("(()=>{window.__r005ButtonClicks=0;window.__r005Errors=[];window.addEventListener('error',event=>window.__r005Errors.push(event.message));document.querySelector('.trade-review-complete').addEventListener('click',()=>window.__r005ButtonClicks++,true)})()");
  await evaluate(`(()=>{window.__observationBodies=[];window.__parentFailures=['503','offline'];window.__lostObservationResponse=false;window.__cropAttempts=[];window.__cropFailureUsed=false;const original=window.fetch.bind(window);window.fetch=async(input,init={})=>{const url=typeof input==='string'?input:input.url;if(url.includes('/trade-review-observations')&&init.method==='POST'&&!url.includes('/crops')){window.__observationBodies.push(init.body);if(window.__rejectNextObservation){window.__rejectNextObservation=false;return new Response(JSON.stringify({ok:false,error:{code:'invalid_contract',message:'invalid_contract',retryable:false}}),{status:422,headers:{'Content-Type':'application/json'}})}const failure=window.__parentFailures.shift();if(failure==='503')return new Response(JSON.stringify({ok:false,error:{code:'temporary',message:'temporary outage',retryable:true}}),{status:503,headers:{'Content-Type':'application/json'}});if(failure==='offline')throw new TypeError('simulated offline');const response=await original(input,init);if(!window.__lostObservationResponse){window.__lostObservationResponse=true;throw new TypeError('simulated response loss after server commit')}return response}if(url.includes('/trade-review-observations')&&url.includes('/crops')&&init.method==='POST'){const metadata=JSON.parse(init.body.get('metadata'));window.__cropAttempts.push(metadata);if(!window.__cropFailureUsed){window.__cropFailureUsed=true;return new Response(JSON.stringify({ok:false,error:{code:'temporary',message:'temporary crop outage',retryable:true}}),{status:503,headers:{'Content-Type':'application/json'}})}}return original(input,init)}})()`);
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
  await evaluate("document.querySelector('[data-close-trade-capture]').click()");
  await evaluate("document.querySelector('#open-trade-capture').click()");
  await waitFor(async () => evaluate("document.querySelector('#trade-capture-dialog').open"), "reopen while persistence retry is pending");
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
  assert.equal(payload.rows.length, 2);
  assert.equal(payload.edgeSegments.length, 1);
  assert.equal(payload.summary.unknownFieldCount, 1);
  assert.equal(payload.rows[0].fields.find(field=>field.field==='island').verificationMethod, "USER_EDITED");
  assert.equal(payload.rows[0].fields.find(field=>field.field==='count').verificationMethod, "USER_BATCH_CONFIRMED_UNCHANGED");
  assert.equal(payload.rows[0].fields.find(field=>field.field==='count').finalValue, 0);
  assert.equal(payload.rows[1].fields.find(field=>field.field==='reqAmount').verificationMethod, "USER_MARKED_UNKNOWN");
  assert.equal(await evaluate("Object.isFrozen(window.__r005Payload)&&Object.isFrozen(window.__r005Payload.rows)&&Object.isFrozen(window.__r005Payload.rows[0].fields[0])"), true, "completion payload is deeply frozen");
  assert.equal(await evaluate("document.querySelector('.trade-review-message').textContent"), "검수를 완료했습니다. 아직 현재 회차에는 적용하지 않았습니다.");
  assert.equal(await evaluate("document.body.textContent.includes('현재 회차에 적용 완료')"), false);
  assert.deepEqual(await (await fetch(`${baseUrl}api/bootstrap`)).json(), bootstrapBefore, "isolated DB bootstrap unchanged");
  assert.equal(await evaluate("document.querySelector('#trade-list-root').textContent"), tradeListBefore, "current trade list unchanged");
  await evaluate("document.querySelector('.trade-review-footer').scrollIntoView({block:'end'})");
  const viewport = await evaluate("JSON.stringify({innerWidth,innerHeight,devicePixelRatio,dialog:(()=>{const r=document.querySelector('#trade-capture-dialog').getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}})(),footerVisible:(()=>{const r=document.querySelector('.trade-review-footer').getBoundingClientRect();return r.bottom<=innerHeight&&r.top>=0})(),reviewScrollable:document.querySelector('.trade-review-table-wrap').scrollHeight>=document.querySelector('.trade-review-table-wrap').clientHeight})").then(JSON.parse);
  assert.ok(Math.abs(viewport.devicePixelRatio - 1.3) < 0.001);
  assert.ok(viewport.dialog.left >= 0 && viewport.dialog.top >= 0 && viewport.dialog.right <= viewport.innerWidth && viewport.dialog.bottom <= viewport.innerHeight, `dialog should fit viewport: ${JSON.stringify(viewport)}`);
  assert.equal(viewport.footerVisible, true, JSON.stringify(viewport));
  assert.equal(viewport.reviewScrollable, true);

  await evaluate("document.querySelector('.capture-draft-item button').click()");
  assert.equal(await evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength"), "1", "queue can change while the immutable crop job remains pending");
  assert.equal(await evaluate("!document.querySelector('.trade-review-storage-actions button:first-child').hidden"), true, "queue mutation preserves the pending crop retry");
  await evaluate("document.querySelector('.trade-review-storage-actions button:first-child').click()");
  await waitFor(async () => evaluate("document.querySelector('[data-role=trade-recognition-status]').textContent.includes('저장')&&document.querySelector('[data-role=trade-recognition-status]').textContent.includes('완료')"), "partial crop retry completion");
  const cropMutationIds = await evaluate("JSON.stringify(window.__cropAttempts.map(item=>item.cropMutationId))").then(JSON.parse);
  const cropCounts = cropMutationIds.reduce((counts,id)=>counts.set(id,(counts.get(id)||0)+1),new Map());
  assert.equal([...cropCounts.values()].filter(count=>count===2).length, 1, "only the crop that failed is retried");
  assert.equal([...cropCounts.values()].filter(count=>count===1).length, cropCounts.size-1, "successful crop uploads are not repeated");

  assert.equal(await evaluate("document.querySelector('[data-role=trade-recognition-result]').hidden"), true, "queue mutation clears the stale review state");
  assert.equal(await evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength"), "1", "clear keeps the mutated queue");
  await evaluate("document.querySelector('[data-action=recognize-trade]').click()");
  await waitFor(async () => evaluate("document.querySelectorAll('.trade-review-input').length===6"), "review for queue mutation check");
  await evaluate(`(()=>{window.__rejectNextObservation=true;window.__downloads=[];const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=create(blob);if(blob instanceof Blob)blob.text().then(text=>window.__downloads.push({text}));return url};HTMLAnchorElement.prototype.click=function(){window.__downloads.push({name:this.download,href:this.href})}})()`);
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
  assert.deepEqual(await (await fetch(`${baseUrl}api/bootstrap`)).json(), bootstrapBefore);
  assert.equal(await evaluate("document.querySelector('#trade-list-root').textContent"), sessionTextBefore);
  const requests = await (await fetch(`${baseUrl}__test__/requests`)).json();
  const sessionWrites = requests.filter((item) => ["POST", "PUT", "PATCH", "DELETE"].includes(item.method) && item.path.startsWith("/api/working-session"));
  const observationPosts = requests.filter((item) => item.method === "POST" && item.path === "/api/recognition/trade-review-observations");
  assert.deepEqual(sessionWrites, [], "review persistence never writes session state");
  assert.equal(observationPosts.length, 2, "synthetic failures never persist and same-body replay creates one observation");
  assert.equal((await (await fetch(`${baseUrl}__test__/observation-count`)).json()).count, 1, "idempotent retry retains one immutable observation");
  const testDb = await (await fetch(`${baseUrl}__test__/db`)).json();
  assert.equal(testDb.databaseExists, true);
  assert.ok(testDb.appDbPath.startsWith(profile), "only the temporary test DB was accessed");
  console.log("browser_trade_review: PASS · Chrome 1920×1080 + CDP deviceScaleFactor 1.3");
} finally {
  try { socket?.close(); } catch {}
  await Promise.all([stopChild(chrome), stopChild(server)]);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { await rm(profile, { recursive: true, force: true }); break; }
    catch (error) { if (error.code !== "EBUSY" || attempt === 7) throw error; await new Promise((resolveWait) => setTimeout(resolveWait, 150)); }
  }
}
