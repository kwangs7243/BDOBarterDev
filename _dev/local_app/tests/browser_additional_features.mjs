import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = process.env.BDO_TEST_URL ?? "http://127.0.0.1:18771/";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-spec004-browser-"));
const database = join(profile, "isolated.sqlite3");
const pythonPrelude = process.env.BDO_EXTRA_SITE_PACKAGES ? `import sys; p=${JSON.stringify(process.env.BDO_EXTRA_SITE_PACKAGES)}; sys.path.remove(p); sys.path.append(p); ` : "";
const pythonCode = `${pythonPrelude}from local_app.backend.app import create_app; create_app(r'${database}', testing=True).run(host='127.0.0.1', port=18771, use_reloader=False, threaded=True)`;
let server = spawn(process.env.PYTHON ?? "python", ["-c", pythonCode], { stdio: "ignore", windowsHide: true, cwd: root });
let chrome;
let socket;
try {
  await waitFor(async () => { try { return (await fetch(`${baseUrl}api/health`)).ok; } catch { return false; } }, "temporary localhost app");
  chrome = spawn(chromePath, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking", "--remote-debugging-port=0", "--remote-allow-origins=*", `--user-data-dir=${join(profile, "chrome-profile")}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  const portFile = join(profile, "chrome-profile", "DevToolsActivePort");
  const portText = await waitFor(async () => { try { return await readFile(portFile, "utf8"); } catch { return false; } }, "Chrome DevTools endpoint");
  const port = portText.trim().split(/\r?\n/)[0];
  const targetResponse = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(baseUrl)}`, { method: "PUT", signal: AbortSignal.timeout(10000) });
  if (!targetResponse.ok) throw new Error(`Chrome target create failed: ${targetResponse.status}`);
  const target = await targetResponse.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await Promise.race([
    new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", reject, { once: true }); }),
    delay(10000).then(() => { throw new Error("Chrome DevTools WebSocket did not open."); }),
  ]);
  const pending = new Map(); let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
    if (message.id && pending.has(message.id)) { const { resolve: resolveCall, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolveCall(message.result); }
  });
  const send = (method, params = {}) => new Promise((resolveCall, reject) => { const id = ++nextId; pending.set(id, { resolve: resolveCall, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const result = await send("Runtime.evaluate", { expression: `(()=>eval(${JSON.stringify(expression)}))()`, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value; };
  await send("Page.enable"); await send("Runtime.enable");
  await waitFor(async () => (await evaluate("document.querySelectorAll('.inventory-row').length")) === 70, "SPEC-002 UI and trade panel");
  const fixture = JSON.parse(await readFile(resolve(root, "fixtures/KNOWN_CORRECT_SPECIAL_IMPORT_4.json"), "utf8"));
  const [seed, second, third] = fixture;
  const input = async (rows, mode="new") => evaluate(`document.querySelector('#trade-json-input').value=${JSON.stringify(JSON.stringify(rows))}; document.querySelector('${mode === "new" ? "#apply-new-session" : "#append-current-trades"}').click()`);
  const snapshot = () => evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify(state.session.scannedTrades))");
  await input([{...seed,toItem:"완전 미인식 품목"}]);
  if (await snapshot() !== "null") throw Error("rejected-only import mutated session");
  if (!await evaluate("document.querySelector('.trade-import-review')?.open && !document.querySelector('.trade-review-include').checked")) throw Error("excluded-only review missing or not default-exclude");
  await evaluate(`const section=document.querySelector('.trade-import-review section'); const field=section.querySelector('[data-field=toItem]');field.value=${JSON.stringify(seed.toItem)};field.dispatchEvent(new Event('input'));section.querySelector('.trade-review-include').click();document.querySelector('.trade-import-review [data-action=apply]').click()`);
  await waitFor(async () => (await evaluate("document.querySelectorAll('.trade-row').length")) === 1, "repair rejected-only input");
  const original = await snapshot();
  const mixed = [seed, {...second,yield:0}, {...third,toItem:"품목 확인 불가"}];
  await input(mixed);
  if (!await evaluate("document.querySelectorAll('.trade-review-include').length===2 && [...document.querySelectorAll('.trade-review-include')].every(n=>!n.checked)")) throw Error("mixed rejected rows missing");
  await evaluate("document.body.style.zoom='1.3';document.querySelector('.trade-import-review').style.setProperty('--review-zoom','1.3')");
  await send("Emulation.setDeviceMetricsOverride",{width:1440,height:1080,deviceScaleFactor:1,mobile:false});
  const jsonShot = await send("Page.captureScreenshot",{format:"png"});
  await writeFile(resolve(root,"test_results/additional_features/json-review130.png"),Buffer.from(jsonShot.data,"base64"));
  await evaluate("document.body.style.zoom=''");
  await evaluate("document.querySelector('.trade-import-review button').click()");
  if (await snapshot() !== original) throw Error("review cancel mutated session");
  await input(mixed);
  await evaluate("const section=document.querySelector('.trade-import-review section'); section.querySelector('.trade-review-include').click();const field=section.querySelector('[data-field=yield]');field.value='1.5';field.dispatchEvent(new Event('input'));document.querySelector('.trade-import-review [data-action=apply]').click()");
  if (await snapshot() !== original || !await evaluate("document.querySelector('.trade-import-review [role=alert]').textContent.includes('정수')")) throw Error("invalid numeric correction escaped validation");
  await evaluate("const field=document.querySelector('.trade-import-review [data-field=yield]');field.value='2';field.dispatchEvent(new Event('input'));document.querySelector('.trade-import-review [data-action=apply]').click()");
  await waitFor(async () => (await evaluate("document.querySelectorAll('.trade-row').length")) === 2, "include repaired row and exclude unselected row");
  const conflict = {...seed,fromItem:second.fromItem};
  await input([conflict],"append");
  await evaluate("document.querySelector('.trade-review-include').click();document.querySelector('.trade-import-review [data-action=apply]').click()");
  if (!await evaluate("document.querySelector('.trade-import-review [role=alert]').textContent.includes('충돌')")) throw Error("review bypassed existing conflict protection");
  await evaluate("document.querySelector('.trade-import-review button').click()");
  const durations = await evaluate("import('/assets/js/duration.js').then(({totalDepartureDuration:f})=>[f([{totalTime:59.75},{totalTime:.5}]),f([{totalTime:.009},{totalTime:.009}]),f([{totalTime:1500}]),f([{totalTime:null}])])");
  if (JSON.stringify(durations)!==JSON.stringify(["1시간 0분 15초","0시간 0분 1초","25시간 0분 0초","미확인"])) throw Error(`clock sum mismatch ${JSON.stringify(durations)}`);
  await evaluate("window.renderModeColumn('col-speed',[{totalTime:59.75,trades:[]},{totalTime:.5,trades:[]}],'speed');window.renderModeColumn('col-balance',[{totalTime:1500,trades:[]}],'balance')");
  if (!await evaluate("document.querySelector('#header-speed').textContent.includes('총 1시간 0분 15초') && document.querySelector('#header-balance').textContent.includes('총 25시간 0분 0초')")) throw Error("mode total duration header missing");
  await evaluate("import('/assets/js/persistence.js').then(({whenPersistenceIdle})=>whenPersistenceIdle())");
  const image = await readFile(resolve(root,"../마스터창고.png"));
  await evaluate(`(async()=>{await import('/assets/js/persistence.js').then(m=>m.refreshPersistentState());const bytes=Uint8Array.from(atob(${JSON.stringify(image.toString("base64"))}),c=>c.charCodeAt(0));const file=new File([bytes],'master.png',{type:'image/png'});const data=new FormData();data.append('image',file);const result=await fetch('/api/warehouse-scan',{method:'POST',body:data}).then(r=>r.json());window.__scanResult=result;const {openPatchReview}=await import('/assets/js/patch-review.js');openPatchReview(result.patch,result.report,{imageFile:file,setStatus:()=>{},onApplied:()=>{window.__applied=true}})})()`);
  if (!await evaluate("document.querySelectorAll('.patch-item-check').length===11 && document.querySelector('[data-slot=R5C8] .patch-correction-hint').textContent.includes('갈퀴 꽃 씨앗 주머니')")) throw Error("original guess/check controls missing");
  await evaluate("document.body.style.zoom='1.3';document.querySelector('.patch-review-dialog').style.setProperty('--review-zoom','1.3');document.querySelector('.patch-review-body').scrollTop=document.querySelector('.patch-review-body').scrollHeight");
  if (!await evaluate("(()=>{const dialog=document.querySelector('.patch-review-dialog'),button=dialog.querySelector('[data-action=apply]'),r=dialog.getBoundingClientRect(),b=button.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight})()")) throw Error("warehouse header/footer outside viewport at 130% zoom");
  const warehouseShot=await send("Page.captureScreenshot",{format:"png"});
  await writeFile(resolve(root,"test_results/additional_features/warehouse-review130.png"),Buffer.from(warehouseShot.data,"base64"));
  await evaluate("document.body.style.zoom=''");
  await evaluate("for(const row of document.querySelectorAll('.patch-correction-row')){ if(row.dataset.slot==='R5C8'){ const check=row.querySelector('.patch-item-check');check.value='match';check.dispatchEvent(new Event('change')); }else if(row.dataset.slot==='R6C4'){const item=row.querySelector('.patch-correction-item');item.value='갈퀴 꽃 씨앗 주머니';item.dispatchEvent(new Event('input'));const check=row.querySelector('.patch-item-check');check.value='different';check.dispatchEvent(new Event('change'));}else{row.querySelector('.patch-correction-exclude').click();}}window.__warehouseCalls=0;const originalFetch=window.fetch;window.fetch=(url,options)=>{if(String(url)==='/api/inventory' && options?.method==='PATCH')window.__warehouseCalls++;return originalFetch(url,options)};document.querySelector('.patch-review-dialog [data-action=apply]').click()");
  await waitFor(async()=>await evaluate("window.__applied===true"),"atomic stock and labels apply");
  if (await evaluate("window.__warehouseCalls") !== 1) throw Error("multiple warehouse writes");
  await evaluate("fetch('/api/warehouse-dataset').then(r=>{if(!r.ok)throw Error('dataset export failed');return r.arrayBuffer()}).then(bytes=>Array.from(new Uint8Array(bytes)))").then(async bytes=>{const {writeFile}=await import('node:fs/promises');await writeFile(join(profile,'dataset.zip'),new Uint8Array(bytes));});
  const check = spawnSync(process.env.PYTHON ?? 'python',['-c',`import json,zipfile,sys; z=zipfile.ZipFile(sys.argv[1]);s=[json.loads(x) for x in z.read('samples.jsonl').splitlines()]; print(json.dumps({'count':len(s),'verified':[(r['modelOutput']['slot'],f['user']['itemCheck'],f['user']['quantity']) for r in s for f in r['humanFeedback'] if f['verifiedItemLabel']],'autoLabeled':any(r['humanFeedback'] for r in s if r['modelOutput']['decision']=='MATCH')}))`,join(profile,'dataset.zip')],{encoding:'utf8',windowsHide:true});
  if(check.status!==0)throw Error(check.stderr);
  const dataset=JSON.parse(check.stdout);
  if(dataset.count!==54 || dataset.autoLabeled || JSON.stringify(dataset.verified)!==JSON.stringify([['R5C8','match',23],['R6C4','different',53]]))throw Error(`dataset label mismatch ${check.stdout}`);
  console.log(JSON.stringify({ok:true,browser:'Chrome headless',rejectedOnlyRepair:true,defaultExclude:true,cancelPreservedSession:true,invalidCorrectionBlocked:true,selectedRepairInserted:true,conflictCannotBeForced:true,durationCarryAnd24HourPlus:true,modeHeaders:true,guessMatchAndDifference:true,warehouseSingleApply:true,dataset},null,2));

} finally {
  try { socket?.close(); } catch {}
  try { chrome?.kill(); } catch {}
  try { server?.kill(); } catch {}
  await delay(300);
  if (profile.startsWith(tmpdir())) await rm(profile, { recursive: true, force: true });
}

async function waitFor(predicate, label, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await predicate(); if (result) return result; await delay(100); }
  throw new Error(`Timed out waiting for ${label}`);
}
