import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = process.env.BDO_TEST_URL ?? "http://127.0.0.1:18788/";
const python = process.env.PYTHON ?? resolve(root,"recognition-local/r006-env-recovery/venv314/Scripts/python.exe");
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-hotfix-ocr-"));
const database = join(profile, "isolated.sqlite3");
const port = new URL(baseUrl).port || "18788";
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

  const trace = await evaluate(`(async () => {
    const {ScreenCaptureSession,CaptureQueue} = await import('/assets/js/capture.js');
    const {recognizeTradeBatchV2} = await import('/assets/js/trade-recognition-client.js');
    const source=document.createElement('canvas'); source.width=2000;source.height=1000;
    const ctx=source.getContext('2d');ctx.fillStyle='#27384a';ctx.fillRect(0,0,source.width,source.height);
    const paint=setInterval(()=>ctx.fillRect(0,0,source.width,source.height),30);
    const session=new ScreenCaptureSession({mediaDevices:{getDisplayMedia:async()=>source.captureStream(30)}});
    await session.connectScreen();
    const queue=new CaptureQueue(),trace={captures:[],requests:[],errors:[]};
    const originalFetch=window.fetch.bind(window); window.fetch=async(...args)=>{const response=await originalFetch(...args); if(args[0]==='/api/recognition/trade-batch'){const body=await response.clone().json();trace.requests.push({http:response.status,code:body.error?.code,message:body.error?.message,version:body.result?.version,status:body.result?.status,schemaVersion:body.result?.rawEvidence?.schemaVersion,frames:body.result?.rawEvidence?.captures.map(c=>c.frame),rows:body.result?.rawEvidence?.sourceRows.length});}return response;};
    try {
      for(const [width,height] of [[997,466],[1301,777],[811,503]]){
        const capture=await session.captureRegion({taskType:'trade',baseRevision:0,sessionId:null,sessionRevision:null,profileId:null,profileVersion:1},{x:0,y:0,width:width/source.width,height:height/source.height});
        queue.append([capture]);const decoded=await createImageBitmap(capture.blob);
        trace.captures.push({captureId:capture.metadata.captureId,sourceType:capture.metadata.sourceType,blobType:capture.blob.type,blobSize:capture.blob.size,frame:capture.metadata.frame,decoded:{width:decoded.width,height:decoded.height},fidelity:capture.metadata.fidelity});decoded.close();
        await recognizeTradeBatchV2([capture]);
      }
      await recognizeTradeBatchV2(queue.items);
      const first=queue.items[0];
      for(const capture of [{...first,reencoded:null},{...first,metadata:{...first.metadata,frame:{width:1000,height:466}}}]){
        try{await recognizeTradeBatchV2([capture]);throw new Error('expected rejection');}
        catch(error){trace.errors.push({code:error.code,stage:error.stage,diagnostics:error.diagnostics});}
      }
      trace.queueLength=queue.length;
    }
    finally{window.fetch=originalFetch;session.disconnectScreen();clearInterval(paint);}
    return trace;
  })()`);
  console.log(JSON.stringify(trace,null,2));
  const sizes = [{width:997,height:466},{width:1301,height:777},{width:811,height:503}];
  assert.deepEqual(trace.captures.map(c=>c.frame),sizes);
  assert.deepEqual(trace.captures.map(c=>c.decoded),sizes);
  assert.equal(trace.queueLength,3);
  for(const request of trace.requests.slice(0,4)){
    assert.equal(request.http,200);assert.equal(request.version,2);assert.equal(request.status,'RAW_EVIDENCE_ONLY');assert.equal(request.schemaVersion,2);
  }
  assert.deepEqual(trace.requests[3].frames,sizes);
  assert.deepEqual(trace.errors.map(e=>[e.code,e.stage]),[['invalid_image','REQUEST_BUILD'],['frame_mismatch','SERVER_IMAGE_VALIDATE']]);
  assert.deepEqual(trace.errors[1].diagnostics.decodedFrame,sizes[0]);

  const activeBefore = await (await fetch(`${baseUrl}api/master/active`)).json();
  assert.equal(activeBefore.bundle,null);
  const fixtureDir=resolve(root,'local_app/tests/fixtures/trade-recognition');
  const fixtureName=(await readdir(fixtureDir)).filter(name=>name.endsWith('.png')).sort()[0];
  const fixture=(await readFile(join(fixtureDir,fixtureName))).toString('base64');
  await send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1.3,mobile:false});
  await evaluate(`(() => {
    const originalFetch=window.fetch.bind(window);
    window.__hotfix={originalFetch,masterGate:new Promise(resolve=>window.__releaseMaster=resolve),responses:[]};
    window.fetch=async(...args)=>{
      if(args[0]==='/api/master/active') await window.__hotfix.masterGate;
      const response=await originalFetch(...args);
      if(args[0]==='/api/recognition/trade-batch')window.__hotfix.responses.push(await response.clone().json());
      return response;
    };
    document.querySelector('#open-trade-capture').click();
    const file=new File([Uint8Array.from(atob('${fixture}'),c=>c.charCodeAt(0))],'real-bdo.png',{type:'image/png'});
    const transfer=new DataTransfer();transfer.items.add(file);
    const input=document.querySelector('#trade-capture-files');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await waitFor(()=>evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength==='1'"),'actual BDO file capture');
  await waitFor(()=>evaluate("!document.querySelector('[data-action=recognize-trade]').disabled"),'recognition available');
  await evaluate("document.querySelector('[data-action=recognize-trade]').click()");
  await waitFor(()=>evaluate("document.querySelector('[data-role=trade-raw-ocr] table tbody tr')"),'real raw OCR visible before Master',120000);
  const rawText=await evaluate("document.querySelector('[data-role=trade-raw-ocr]').innerText");
  assert.match(rawText,/rawText:/);assert.match(rawText,/confidence:/);
  assert.ok(await evaluate("document.querySelector('[data-role=trade-recognition-result]').getBoundingClientRect().height>150"),'raw result viewport must not collapse under the capture controls');
  assert.equal(await evaluate("document.querySelector('#trade-capture-dialog').open"),true);
  assert.equal(await evaluate("document.querySelector('#trade-recognition-review-dialog').open"),false);
  await evaluate("window.__releaseMaster()");
  await waitFor(()=>evaluate("!document.querySelector('[data-action=recognize-trade]').disabled"),'baseline correction settled',60000);
  const correctedText=await evaluate("document.querySelector('[data-role=trade-corrected-result]').innerText");
  assert.match(correctedText,/보정 결과/);assert.match(correctedText,/기본 Master 사용 중/);assert.match(correctedText,/classification/);
  assert.ok(!correctedText.includes('[object Object]'),'Master status must be readable');
  assert.ok(await evaluate("document.querySelector('[data-role=trade-corrected-result] table tbody tr')?.textContent"),correctedText);
  const actual=await evaluate("(() => {const r=window.__hotfix.responses[0].result;return {version:r.version,status:r.status,schemaVersion:r.rawEvidence.schemaVersion,rows:r.rawEvidence.sourceRows.length,textFields:r.rawEvidence.sourceRows.flatMap(row=>row.fields).filter(f=>f.rawText).length,runtime:r.runtime};})()");
  console.log(JSON.stringify({fixture:fixtureName,actual,rawBeforeMaster:'PASS',baselineMissingMaster:'PASS'}));
  assert.equal(actual.version,2);assert.equal(actual.status,'RAW_EVIDENCE_ONLY');assert.ok(actual.textFields>0);
  assert.deepEqual(await (await fetch(`${baseUrl}api/master/active`)).json(),activeBefore,'read-only fallback does not activate/persist a user Master');
  if(process.env.BDO_HOTFIX_SCREENSHOT_DIR){
    const screenshotDir=resolve(process.env.BDO_HOTFIX_SCREENSHOT_DIR);
    await mkdir(screenshotDir,{recursive:true});
    await evaluate("document.querySelector('[data-role=trade-recognition-result]').scrollTop=0");
    const rawScreenshot=await send('Page.captureScreenshot',{format:'png'});
    await writeFile(join(screenshotDir,'raw-result.png'),Buffer.from(rawScreenshot.data,'base64'));
    await evaluate("document.querySelector('[data-role=trade-corrected-result]').scrollIntoView({block:'nearest'})");
    const correctedScreenshot=await send('Page.captureScreenshot',{format:'png'});
    await writeFile(join(screenshotDir,'corrected-result.png'),Buffer.from(correctedScreenshot.data,'base64'));
  }
  await evaluate("document.querySelector('[data-action=open-trade-review]').click()");
  assert.equal(await evaluate("document.querySelector('#trade-recognition-review-dialog').open"),true);
  await evaluate("document.querySelector('[data-action=return-trade-capture]').click()");
  await waitFor(()=>evaluate("!document.querySelector('[data-action=recognize-trade]').disabled"),'returned capture ready');

  // Replay the real response with its new request ID only to isolate downstream failure from another OCR execution.
  await evaluate(`(() => {
    const originalFetch=window.fetch.bind(window);
    window.fetch=async(url,options)=>{
      if(url==='/api/master/active')return new Response('{}',{status:503,headers:{'Content-Type':'application/json'}});
      if(url==='/api/recognition/trade-batch'){
        const batch=JSON.parse(options.body.get('batch')),body=structuredClone(window.__hotfix.responses[0]);
        body.result.batchId=batch.batchId;body.result.rawEvidence.recognitionBatchId=batch.batchId;
        return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
      }
      return originalFetch(url,options);
    };
    document.querySelector('[data-action=recognize-trade]').click();
  })()`);
  await waitFor(()=>evaluate("document.querySelector('[data-role=trade-recognition-diagnostics]').textContent.includes('MASTER_CORRECTION')"),'Master error diagnosed');
  assert.equal(await evaluate("document.querySelector('[data-role=trade-raw-ocr]').innerText"),rawText);
  assert.equal(await evaluate("document.querySelector('[data-role=trade-recognition-result]').hidden"),false);
  await evaluate(`(() => {
    window.fetch=async(url,options)=>{
      if(url==='/api/recognition/trade-batch'){
        const batch=JSON.parse(options.body.get('batch')),body=structuredClone(window.__hotfix.responses[0]);
        body.result.batchId=batch.batchId;body.result.rawEvidence.recognitionBatchId=batch.batchId;
        body.result.rawEvidence.sourceRows=[];body.result.rawEvidence.edgeSegments=[];
        body.result.rawEvidence.captures.forEach(c=>c.completeRowCount=0);
        return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
      }
      return window.__hotfix.originalFetch(url,options);
    };
    document.querySelector('[data-action=recognize-trade]').click();
  })()`);
  await waitFor(()=>evaluate("!document.querySelector('[data-action=recognize-trade]').disabled"),'zero-row response settled');
  assert.match(await evaluate("document.querySelector('[data-role=trade-recognition-status]').textContent"),/이미지는 정상 처리했습니다/);
  assert.match(await evaluate("document.querySelector('[data-role=trade-recognition-diagnostics]').textContent"),/ROW_DETECTION.*no_rows/s);
  for(const code of ['invalid_image','frame_mismatch']){
    await evaluate(`(() => {
      window.fetch=async(url,options)=>url==='/api/recognition/trade-batch'?new Response(JSON.stringify({ok:false,error:{code:'${code}',message:'test validation error'},diagnostics:{stage:'SERVER_IMAGE_VALIDATE'}}),{status:422,headers:{'Content-Type':'application/json'}}):window.__hotfix.originalFetch(url,options);
      document.querySelector('[data-action=recognize-trade]').click();
    })()`);
    await waitFor(()=>evaluate(`document.querySelector('[data-role=trade-recognition-diagnostics]').textContent.includes('"code": "${code}"')`),`${code} visible in diagnostics`);
    assert.match(await evaluate("document.querySelector('[data-role=trade-recognition-diagnostics]').textContent"),/SERVER_IMAGE_VALIDATE/);
  }
  const after=await (await fetch(`${baseUrl}api/bootstrap`)).json();
  assert.equal(after.revision,initial.revision);
  console.log(JSON.stringify({ok:true,fixture:fixtureName,actual,rawBeforeMaster:'PASS',baselineMissingMaster:'PASS',rawSurvivesMasterFailure:'PASS',reviewOptional:'PASS',permissionPicker:'NOT_RUN'},null,2));
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
