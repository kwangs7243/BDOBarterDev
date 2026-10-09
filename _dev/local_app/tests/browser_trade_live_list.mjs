import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.env.BDO_LIVE_REPORT_DIR ?? join(root, "recognition-local/hotfix-live-list"));
const baseUrl = process.env.BDO_TEST_URL ?? "http://127.0.0.1:18783/";
const external = process.env.BDO_EXTERNAL_APP === "1";
const profile = await mkdtemp(join(tmpdir(), "bdo-live-list-"));
const mapping = JSON.parse(await readFile(join(root, "local_app/tests/fixtures/trade-recognition/live-list-mapping.json"), "utf8"));
const pythonCode = `
from pathlib import Path
import sqlite3,hashlib,json,os,threading
from flask import jsonify
from local_app.backend.app import create_app
app=create_app(r'${join(profile, "main.sqlite3")}',testing=True)
@app.get('/__test__/database-snapshot')
def snapshot():
    result={}
    for path in sorted(Path(r'${profile}').rglob('*.sqlite3')):
        with sqlite3.connect(path) as conn:
            result[str(path.relative_to(Path(r'${profile}')))]=hashlib.sha256('\\n'.join(conn.iterdump()).encode()).hexdigest()
    return jsonify(result)
@app.post('/__test__/shutdown')
def shutdown_test_server():
    threading.Timer(.2, lambda: os._exit(0)).start()
    return jsonify(ok=True)
app.run(host='127.0.0.1',port=18783,use_reloader=False,threaded=True)
`;
let server, chrome, socket, send;
const waitFor = async (predicate, label, timeout = 45000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await predicate(); if (value) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${label}`);
};
const stop = async (child) => {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((resolveExit) => child.once("exit", resolveExit)); child.kill();
  await Promise.race([done, new Promise((resolveWait) => setTimeout(resolveWait, 3000))]);
};
try {
  await mkdir(output, { recursive: true });
  if (!external) server = spawn(process.env.PYTHON ?? "python", ["-B", "-c", pythonCode], {
    cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, LOCALAPPDATA: profile, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" },
  });
  let serverErrors = ""; server?.stderr.on("data", (data) => { serverErrors += data.toString(); });
  await waitFor(async () => { if (server && server.exitCode !== null) throw new Error(serverErrors); try { return (await fetch(`${baseUrl}api/health`)).ok; } catch { return false; } }, "server");
  chrome = spawn(process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking",
    "--disable-crash-reporter", "--disable-breakpad",
    "--window-size=1920,1080", "--remote-debugging-port=0", "--remote-allow-origins=*",
    `--user-data-dir=${join(profile, "chrome")}`, "about:blank",
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let chromeErrors = ""; chrome.stderr.on("data", (data) => { chromeErrors += data.toString(); });
  const portText = await waitFor(async () => { try { return await readFile(join(profile, "chrome/DevToolsActivePort"), "utf8"); } catch { return false; } }, "Chrome");
  const target = await (await fetch(`http://127.0.0.1:${portText.trim().split(/\r?\n/)[0]}/json/new?${encodeURIComponent(baseUrl)}`, { method: "PUT", signal: AbortSignal.timeout(10000) })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, reject) => {
    const timer=setTimeout(()=>reject(new Error(`Chrome connection timeout: ${chromeErrors}`)),10000);
    socket.addEventListener("open", ()=>{clearTimeout(timer);done();}, { once: true }); socket.addEventListener("error", reject, { once: true });
  });
  const pending = new Map(); let id = 0;
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(event.data); const task = pending.get(value.id); if (!task) return;
    pending.delete(value.id); value.error ? task.reject(new Error(value.error.message)) : task.resolve(value.result);
  });
  send = (method, params = {}) => new Promise((resolveResult, reject) => {
    const requestId = ++id;
    const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error(`Chrome command timeout: ${method}; ${chromeErrors}`));},15000);
    pending.set(requestId, { resolve:(value)=>{clearTimeout(timer);resolveResult(value);}, reject:(error)=>{clearTimeout(timer);reject(error);} });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async (expression) => {
    const value = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
    return value.result.value;
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("DOM.enable");
  const crashes = [];
  socket.addEventListener("message", (event) => { const data = JSON.parse(event.data); if (data.method === "Runtime.exceptionThrown") crashes.push(data.params); });
  await waitFor(async () => (await evaluate("document.querySelector('#app-content')?.getAttribute('aria-busy')")) === "false", "app ready");
  await evaluate("document.body.style.zoom='1.3'; document.querySelector('#open-trade-capture').click()");
  await waitFor(async () => evaluate("document.querySelector('[data-role=trade-runtime-status]').textContent==='로컬 인식 사용 가능'"), "real local OCR runtime");
  assert.equal((await fetch(`${baseUrl}api/master/active`)).status, 404);
  assert.equal(await evaluate("document.querySelector('#open-trade-master')"), null);
  const snapshotUrl = `${baseUrl}api/bootstrap`;
  const before = await (await fetch(snapshotUrl)).json();
  const recognize = async (imageIndex, expectedRows) => {
    const document = await send("DOM.getDocument");
    const input = await send("DOM.querySelector", { nodeId: document.root.nodeId, selector: "#trade-capture-files" });
    await send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [join(root, "local_app/tests/fixtures/trade-recognition", mapping[imageIndex].image)] });
    await waitFor(async () => evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength==='1'"), "real PNG input");
    await evaluate("document.querySelector('[data-action=recognize-trade]').click()");
    try {
      await waitFor(async () => evaluate(`document.querySelector('[data-role=trade-live-list] > .trade-recognition-table-wrap tbody, [data-role=trade-live-list] > .trade-ready-list > .trade-recognition-table-wrap tbody')?.rows.length===${expectedRows} && !document.querySelector('[data-action=recognize-trade]').disabled`), "visible six-field table");
    } catch (error) {
      const diagnostic = await evaluate(`({status:document.querySelector('[data-role=trade-recognition-status]').textContent, table:document.querySelector('[data-role=trade-live-list]').innerText, busy:document.querySelector('[data-action=recognize-trade]').disabled, crashes:${JSON.stringify(crashes)}})`);
      await writeFile(join(output, 'recognition-timeout.json'), JSON.stringify(diagnostic, null, 2));
      throw new Error(`${error.message}; ${JSON.stringify(diagnostic)}`, {cause:error});
    }
    const visible = await evaluate(`(() => {
      const section=document.querySelector('[data-role=trade-live-list]'); const ready=section.querySelector(':scope > .trade-ready-list'); if(ready)ready.open=true; const table=section.querySelector(':scope > .trade-recognition-table-wrap table, :scope > .trade-ready-list > .trade-recognition-table-wrap table');
      return {visible:section.checkVisibility() && table.checkVisibility(),rows:[...table.tBodies[0].rows].map(row=>[...row.cells].map(cell=>cell.innerText)), headers:[...table.tHead.rows[0].cells].map(cell=>cell.innerText),status:document.querySelector('[data-role=trade-recognition-status]').innerText};
    })()`);
    assert.equal(visible.visible, true); assert.equal(visible.rows.length, expectedRows); assert.equal(visible.headers.length, 6);
    return visible;
  };
  const first = await recognize(0, 6);
  assert.deepEqual(first.rows[0].map((text) => text.split("\n")[0]), ["파라타마 섬", "대추야자", "500", "고대 항아리 파편", "10", "1"]);
  assert.doesNotMatch(first.rows[0][1], /확인 필요/, "verified land name is automatically confirmed");
  assert.equal(await evaluate(`(() => {
    const review=document.querySelector('[data-role=live-list-review]');
    const region=review.parentElement.parentElement.getBoundingClientRect();
    const card=review.querySelector('.trade-review-row').getBoundingClientRect();
    return Boolean(review.compareDocumentPosition(review.parentElement.querySelector('.trade-recognition-table-wrap')) & Node.DOCUMENT_POSITION_FOLLOWING) && card.top>=region.top && card.bottom<=region.bottom;
  })()`),true,'first review card is visible before the full list at 130% zoom');

  assert.equal(await evaluate("document.querySelector('[data-role=trade-live-list]').parentElement.scrollTop"), 0);
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(output, "visible-table.png"), Buffer.from(screenshot.data, "base64"));
  assert.equal(await evaluate("document.querySelector('[data-role=live-list-review] input[data-row=\"0\"][data-field=\"reqAmount\"]')===null"),true,'automatic requirement needs no initial review');
  await evaluate("document.querySelector('[data-action=review-live-requirement][data-row=\"0\"]').click()");
  assert.equal(await evaluate("document.querySelector('[data-role=live-list-review] input[data-row=\"0\"][data-field=\"reqAmount\"]').value"),'500','automatic requirement can be reopened');
  await evaluate("const input=document.querySelector('[data-role=live-list-review] input[data-row=\"0\"][data-field=\"reqAmount\"]');input.value='600';input.dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await evaluate("document.querySelector('[data-role=live-list-review] input[data-row=\"0\"][data-field=\"reqAmount\"]').value"),'600');
  await evaluate(`window.__masterCalls=0; window.__originalFetch=window.fetch.bind(window); window.fetch=(url,options)=>{if(String(url).includes('/api/master/active')){window.__masterCalls++; return Promise.reject(new Error('Master unavailable'));} return window.__originalFetch(url,options);}; document.querySelector('[data-action=clear-trade-queue]').click();`);
  assert.equal(await evaluate("document.querySelector('[data-role=trade-live-list]').checkVisibility()"), false, "cleared inputs invalidate their visible result");
  const second = await recognize(1, 4);
  assert.equal(await evaluate("window.__masterCalls"), 0, "display does not depend on Master API");
  await evaluate("document.querySelector('[data-role=trade-live-list] details').open=true");
  assert.equal(await evaluate("document.querySelector('[data-role=trade-live-list] details section').checkVisibility()"), true);
  await evaluate("document.querySelector('[data-action=clear-trade-queue]').click()");
  const fixed = await recognize(7, 5);
  for (const row of fixed.rows) {
    assert.equal(row[2], "1"); assert.equal(row[5], "2");
  }
  await evaluate("document.querySelector('[data-action=clear-trade-queue]').click()");
  const variable = await recognize(5, 5);
  assert.deepEqual(variable.rows.map((row) => row[5].split("\n")[0]), ["2", "2", "2", "2", "2"]);
  await evaluate("document.querySelector('[data-action=clear-trade-queue]').click()");
  const highStage = await recognize(11, 6);
  for (const row of highStage.rows) {
    assert.equal(row[2], "1"); assert.equal(row[5], "1");
  }
  const rulesScreenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(output, "rules-table.png"), Buffer.from(rulesScreenshot.data, "base64"));
  assert.deepEqual(await (await fetch(snapshotUrl)).json(), before, "main/master/sidecar DBs unchanged");
  assert.equal(await evaluate("document.querySelectorAll('[data-role=live-list-review] input').length"),0,'automatic fixed rows do not need editing');
  await evaluate("document.querySelector('[data-action=apply-live-new]').click()");
  await waitFor(async()=>evaluate("document.querySelector('[data-role=trade-recognition-status]').textContent.includes('현재 회차에 적용했습니다')"),'final live list applied');
  const persisted=await (await fetch(`${baseUrl}api/bootstrap`)).json();
  assert.equal(persisted.workingSession.scannedTrades.length,6);
  assert.ok(persisted.workingSession.scannedTrades.every(row=>row.reqAmount===1&&row.yield===1));
  await evaluate("document.querySelector('[data-action=clear-trade-queue]').click()");
  // Replay the historical name uncertainty to test review/storage independently of OCR improvements.
  await evaluate(`window.__reviewFetch=window.fetch.bind(window); window.fetch=async(url,options)=>{
    const response=await window.__reviewFetch(url,options);
    if(url!=='/api/recognition/trade-live-list'||!response.ok)return response;
    const payload=await response.json();
    for(const index of [0,1,5])Object.assign(payload.result.rows[index].fields.fromItem,{reviewRequired:true,valueSource:'USER_EDIT'});
    payload.result.rows[5].fields.fromItem.corrected='영롱한비취';
    return new Response(JSON.stringify(payload),{status:response.status,headers:response.headers});
  }`);
  await recognize(0,6);
  const oracle = JSON.parse(await readFile(join(root,"local_app/tests/fixtures/trade-recognition/정답.json"),"utf8"));
  const truth = mapping[0].oracleRows.map((i)=>oracle[i]);
  // Open quantities explicitly so even confirmed rows participate in the all-excluded UI case.
  await evaluate(`for(let row=0;row<6;row++){
    document.querySelector('[data-action=review-live-requirement][data-row="'+row+'"]').click();
  }`);
  await evaluate("document.querySelectorAll('[data-action=include-live-row]').forEach(input=>input.click())");
  assert.equal(await evaluate("document.querySelector('[data-action=apply-live-new]').disabled"),true,'empty final list cannot be applied');
  assert.match(await evaluate("document.querySelector('.trade-review-counts').textContent"),/포함 0행 · 제외 6행/);
  await evaluate("document.querySelectorAll('[data-action=include-live-row]').forEach(input=>input.click())");
  await evaluate(`window.__correctionWrites=[]; window.__correctionOriginal=window.fetch.bind(window); window.fetch=(url,options)=>{if(url==='/api/recognition/trade-corrections')window.__correctionWrites.push(JSON.parse(options.body.get('feedback')));return window.__correctionOriginal(url,options)};
    [...document.querySelectorAll('[data-role=live-list-review] input[data-field]')].forEach(input=>{input.value=${JSON.stringify(truth)}[Number(input.dataset.row)][input.dataset.field];input.dispatchEvent(new Event('input',{bubbles:true}));});`);
  assert.equal(await evaluate("document.querySelector('[data-action=apply-live-new]').disabled"),true);
  const selectiveCount=await evaluate("document.querySelectorAll('[data-role=live-list-review] input[data-field]').length");
  assert.ok(selectiveCount>0&&selectiveCount<36);
  await evaluate(`const excludedField=document.querySelector('[data-role=live-list-review] input[data-row="0"][data-field="reqAmount"]');
    excludedField.value='600';excludedField.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('[data-action=include-live-row][data-row="0"]').click();`);
  assert.equal(await evaluate("document.querySelector('[data-role=live-list-review] input[data-row=\"0\"][data-field=\"reqAmount\"]').disabled"),true);
  await evaluate("document.querySelector('[data-action=include-live-row][data-row=\"0\"]').click()");
  assert.equal(await evaluate("document.querySelector('[data-role=live-list-review] input[data-row=\"0\"][data-field=\"reqAmount\"]').value"),'600');
  await evaluate(`excludedField.value='';excludedField.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('[data-action=include-live-row][data-row="0"]').click();`);
  await evaluate("document.querySelector('[data-role=live-list-review] form').requestSubmit()");
  await waitFor(async()=>evaluate("!document.querySelector('[data-action=apply-live-new]').disabled"),'selective fields confirmed');
  assert.equal(await evaluate("document.querySelector('[data-action=include-live-row][data-row=\"0\"]').checked"),false,'excluded choice survives confirmation');
  assert.equal(await evaluate("document.querySelector('[data-role=live-list-review] input[data-row=\"0\"][data-field=\"reqAmount\"]').value"),'','excluded draft survives rerender');
  assert.ok(await evaluate("document.querySelectorAll('[data-role=live-list-review] input[data-field]').length")<selectiveCount,'confirmed rows disappear from the review list');
  const correctionWrites=await evaluate("window.__correctionWrites");
  assert.equal(correctionWrites.length,1);
  assert.ok(correctionWrites[0].corrections.some(row=>row.field==='fromItem'&&row.finalValue==='영롱한 비취'));
  assert.ok(correctionWrites[0].corrections.every(row=>row.automaticCorrected!==row.finalValue&&row.box.width>0));
  assert.ok(correctionWrites[0].corrections.every(row=>row.finalValue!==600&&row.finalValue!==''),'excluded fields are not correction samples');
  await evaluate("document.querySelector('[data-action=include-live-row][data-row=\"0\"]').click()");
  assert.equal(await evaluate("document.querySelector('[data-action=apply-live-new]').disabled"),true,'reincluded unresolved row requires confirmation');
  await evaluate(`document.querySelectorAll('[data-role=live-list-review] input[data-row="0"][data-field]').forEach(input=>{
    input.value=${JSON.stringify(truth)}[0][input.dataset.field];input.dispatchEvent(new Event('input',{bubbles:true}));
  }); document.querySelector('[data-role=live-list-review] form').requestSubmit();`);
  await waitFor(async()=>evaluate("!document.querySelector('[data-action=apply-live-new]').disabled"),'reincluded row confirmed');
  await evaluate("document.querySelector('[data-action=include-live-list-row][aria-label=\"1행 목록 포함\"]').click()");
  assert.match(await evaluate("document.querySelector('[data-role=live-list-blockers]').textContent"),/최종 리스트 5행 준비 완료/);
  const exclusionScreenshot=await send('Page.captureScreenshot',{format:'png'});
  await writeFile(join(output,'review-excluded.png'),Buffer.from(exclusionScreenshot.data,'base64'));
  await evaluate(`(async()=>{const {applyLiveTradeRows}=await import('/assets/js/trade-ui.js');return applyLiveTradeRows([${JSON.stringify(truth[1])}],'append');})()`);
  await evaluate("document.querySelector('[data-action=review-live-requirement][data-row=\"1\"]').click()");
  await evaluate(`const rejectedInput=document.querySelector('[data-role=live-list-review] input[data-row="1"][data-field="reqAmount"]');
    rejectedInput.value='600';rejectedInput.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('[data-role=live-list-review] form').requestSubmit();`);
  await waitFor(async()=>evaluate("!document.querySelector('[data-action=apply-live-append]').disabled"),'conflicting quantity submitted for importer check');
  await evaluate("document.querySelector('[data-action=apply-live-append]').click()");
  await waitFor(async()=>evaluate("document.querySelector('[data-role=trade-recognition-status]').textContent.includes('리스트 생성 보류')"),'importer rejects conflicting included row');
  assert.match(await evaluate("document.querySelector('[data-role=trade-recognition-status]').textContent"),/2행 기존 목록 충돌/,'filtered importer index is reported as the original row');
  assert.equal(await evaluate("document.querySelector('.trade-review-row[data-row=\"1\"] .trade-review-row-status').textContent"),'값 확인 필요','importer flags the correct included row');
  assert.equal(await evaluate("document.querySelector('[data-action=include-live-list-row][aria-label=\"1행 목록 포함\"]').checked"),false,'importer preserves the excluded row');
  await evaluate(`document.querySelector('[data-action=review-live-requirement][data-row="1"]').click();
    document.querySelectorAll('[data-role=live-list-review] input[data-row="1"][data-field]').forEach(input=>{
      input.value=${JSON.stringify(truth[1])}[input.dataset.field];input.dispatchEvent(new Event('input',{bubbles:true}));
    }); document.querySelector('[data-role=live-list-review] form').requestSubmit();`);
  await waitFor(async()=>evaluate("!document.querySelector('[data-action=apply-live-append]').disabled"),'importer-rejected row corrected');
  await evaluate("document.querySelector('[data-action=apply-live-append]').click()");
  await waitFor(async()=>evaluate("document.querySelector('[data-role=trade-recognition-status]').textContent.includes('현재 회차에 적용했습니다')"),'corrected list appended');
  const appended=await (await fetch(`${baseUrl}api/bootstrap`)).json();
  assert.equal(appended.workingSession.scannedTrades.length,11);
  assert.ok(!appended.workingSession.scannedTrades.some(row=>row.island===truth[0].island&&row.fromItem===truth[0].fromItem),'excluded row is absent from appended list');
  await evaluate("window.confirm=()=>true; document.querySelector('[data-action=apply-live-new]').click()");
  await waitFor(async()=> (await (await fetch(`${baseUrl}api/bootstrap`)).json()).workingSession.scannedTrades.length===5,'included rows used for new session');
  const replaced=await (await fetch(`${baseUrl}api/bootstrap`)).json();
  assert.ok(!replaced.workingSession.scannedTrades.some(row=>row.island===truth[0].island&&row.fromItem===truth[0].fromItem));
  await send('Page.reload');
  await waitFor(async()=>{
    try { return await evaluate("document.querySelector('#app-content')?.getAttribute('aria-busy')==='false'"); }
    catch(error) { if(/navigated|Execution context was destroyed|Cannot find context/.test(error.message))return false; throw error; }
  },'reload saved session');
  assert.deepEqual((await (await fetch(`${baseUrl}api/bootstrap`)).json()).workingSession,replaced.workingSession);
  assert.equal(crashes.length, 0); assert.equal((await fetch(`${baseUrl}api/health`)).ok, true);
  const report = { browserRealImageVisibleTable: "PASS", missingActiveMaster: "PASS", masterApiFailure: "PASS",
    rawOCRVisibleIfCorrectionFails: "PASS", fixedQuantitiesWithoutReview: "PASS", twoOrThreeRecognition: "PASS",
    databaseSessionModified: "YES_IN_ISOLATED_DB_AFTER_APPLY", finalLiveListPersisted: "PASS", selectiveReview: selectiveCount, appCrash: "NO", images: 5, correctionFeedback: "PASS", appendAndReload: "PASS",
    reviewVisibility: "PASS", rowIncludeExclude: "PASS", excludedDraftAndValidation: "PASS", excludedFeedback: "PASS",
    includedNewAndAppend: "PASS", reinclusion: "PASS", emptyListBlocked: "PASS", filteredImporterReview: "PASS",
    viewport: "1920x1080", bodyZoom: "130%", first, second, fixed, variable, highStage };
  await writeFile(join(output, "browser.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (!external) await fetch(`${baseUrl}__test__/shutdown`, { method: "POST", signal: AbortSignal.timeout(3000) }).catch(() => {});
  if (socket?.readyState === WebSocket.OPEN && send) await send("Browser.close").catch(() => {});
  socket?.close();
  await new Promise((done) => setTimeout(done, 500));
  await stop(chrome); await stop(server);
  if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith("bdo-live-list-")) throw new Error("Unsafe test cleanup path");
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
