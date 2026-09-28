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
let server = process.env.BDO_TEST_URL ? null : spawn(process.env.PYTHON ?? "python", ["-c", pythonCode], { stdio: "ignore", windowsHide: true, cwd: root });
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
  await send('Emulation.setDeviceMetricsOverride', {width:1440,height:1080,deviceScaleFactor:1,mobile:false});
  await evaluate(`window.renderModeColumn('col-speed',[{totalTime:1,trades:[{isCoin:true,toTier:'coin',fromTier:4,fromClean:'테스트',toClean:'까마귀 주화',execC:3,mult:129,reqA:1,island:'테스트 섬'},{isCoin:true,toTier:'coin',execC:2,mult:5,reqA:1,island:'테스트 섬'}]}],'speed');window.renderModeColumn('col-balance',[{totalTime:1,trades:[{isCoin:true,toTier:'coin',execC:2,mult:129,reqA:1,island:'테스트 섬'}]}],'balance')`);
  if (!await evaluate("document.querySelector('#header-speed').textContent.includes('까마귀주화 총획득397개') && document.querySelector('#header-balance').textContent.includes('까마귀주화 총획득258개')")) throw Error('mode coin aggregation mismatch');
  const image = await readFile(resolve(root,'../마스터창고.png'));
  await evaluate(`(async()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(image.toString('base64'))}),c=>c.charCodeAt(0));const file=new File([bytes],'master.png',{type:'image/png'});const data=new FormData();data.append('image',file);const result=await fetch('/api/warehouse-scan',{method:'POST',body:data}).then(r=>r.json());window.__scanResult=result;const {openPatchReview}=await import('/assets/js/patch-review.js');openPatchReview(result.patch,result.report,{imageFile:file,setStatus:message=>{window.__reviewMessage=message},onApplied:()=>{window.__applied=true}})})()`);
  if (!await evaluate("document.querySelectorAll('.patch-confirmed-row .patch-correction-item').length>4 && document.querySelectorAll('.patch-correction-row').length>0 && [...document.querySelectorAll('.patch-item-check')].every(s=>JSON.stringify([...s.options].map(o=>o.textContent))===JSON.stringify(['일치 여부 미확인','품목명만 일치','숫자만 일치','둘 다 일치','둘 다 다름']))")) throw Error('editable groups or four-way choices missing');
  await waitFor(async()=>await evaluate("[...document.querySelectorAll('[data-slot-preview]')].every(c=>c.getContext('2d').getImageData(0,0,120,120).data.some(x=>x))"),'all slot previews');
  await evaluate(`(()=>{const rows=[...document.querySelectorAll('.patch-confirmed-row')];const names=rows.map(r=>r.querySelector('.patch-correction-item').value);rows.slice(0,4).forEach((row,i)=>{const item=row.querySelector('.patch-correction-item'),q=row.querySelector('.patch-correction-quantity'),check=row.querySelector('.patch-item-check');if(i>=2){item.value=names.find(n=>n!==item.value);item.dispatchEvent(new Event('input'));}if(i===1||i===3){q.value=Number(q.value)+1;q.dispatchEvent(new Event('input'));}check.value=['both_match','item_only','quantity_only','both_different'][i];check.dispatchEvent(new Event('change'));});[...document.querySelectorAll('.patch-correction-row')].forEach((row,i)=>{if(i){row.querySelector('.patch-correction-exclude').click();return;}const slot=window.__scanResult.report.slots.find(s=>s.slot===row.dataset.slot),item=row.querySelector('.patch-correction-item'),q=row.querySelector('.patch-correction-quantity'),check=row.querySelector('.patch-item-check');item.value=names.find(n=>n!==(slot.finalItem??slot.bestCandidate));item.dispatchEvent(new Event('input'));q.value=Number.isSafeInteger(slot.quantity?.value)?slot.quantity.value:23;q.dispatchEvent(new Event('input'));check.value=Number.isSafeInteger(slot.quantity?.value)?'quantity_only':'both_different';check.dispatchEvent(new Event('change'));});})()`);
  if (!await evaluate("!document.querySelector('.patch-review-footer [data-action=apply]').disabled")) throw Error('valid edits blocked');
  await evaluate("const first=document.querySelector('.patch-confirmed-row .patch-item-check');first.value='both_different';first.dispatchEvent(new Event('change'))");
  if (!await evaluate("document.querySelector('.patch-review-footer [data-action=apply]').disabled")) throw Error('contradiction not blocked');
  await evaluate("const first=document.querySelector('.patch-confirmed-row .patch-item-check');first.value='both_match';first.dispatchEvent(new Event('change'))");
  await writeFile(resolve(root,'test_results/scan-feedback-v2.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evaluate("window.__warehouseCalls=0;const originalFetch=window.fetch;window.fetch=(url,options)=>{if(String(url)==='/api/inventory'&&options?.method==='PATCH'){window.__warehouseCalls++;window.__warehouseBody=JSON.parse(options.body);}return originalFetch(url,options)};document.querySelector('.patch-review-footer [data-action=apply]').click()");
  await waitFor(async()=>await evaluate('window.__applied===true'),'atomic stock and labels apply');
  if(await evaluate('window.__warehouseCalls')!==1) throw Error('multiple writes');
  const payload=await evaluate('window.__warehouseBody');
  if(payload.feedback.version!==2 || !payload.feedback.rows.some(r=>r.agreement==='quantity_only')) throw Error('v2 payload missing');
  console.log(JSON.stringify({ok:true,browser:'Chrome headless',modeCoins:[397,258],editableBothGroups:true,fourWayChecks:true,contradictionBlocked:true,allSlotPreviews:true,singleApply:true,feedbackRows:payload.feedback.rows.length},null,2));

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
