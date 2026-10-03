import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = process.env.BDO_TEST_URL ?? "http://127.0.0.1:18767/";
const python = process.env.PYTHON ?? "python";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-spec003-browser-"));
const database = join(profile, "isolated.sqlite3");
const fixture = resolve(root, "local_app/tests/fixtures/warehouse_patch/barter_only.png");
const reviewFixture = resolve(root, "local_app/tests/fixtures/warehouse_patch/mixed.png");
const sitePackages = process.env.BDO_EXTRA_SITE_PACKAGES;
const prelude = sitePackages ? `import sys; sys.path.append(${JSON.stringify(sitePackages)}); ` : "";
const pythonCode = `${prelude}import os,threading; from local_app.backend.app import create_app; app=create_app(r'${database}', testing=True); app.add_url_rule('/__test__/shutdown',view_func=lambda:(threading.Timer(.2,lambda:os._exit(0)).start() or {'ok':True}),methods=['POST']); app.run(host='127.0.0.1', port=18767, use_reloader=False, threaded=True)`;
const external = process.env.BDO_EXTERNAL_APP === "1";
let server = external ? null : spawn(python, ["-c", pythonCode], { cwd: root, stdio: "ignore", windowsHide: true });
let chrome;
let socket;
let send;
try {
  await waitFor(async () => { try { return (await fetch(`${baseUrl}api/health`)).ok; } catch { return false; } }, "isolated localhost server");
  chrome = spawn(chromePath, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking", "--remote-debugging-port=0", "--remote-allow-origins=*", `--user-data-dir=${join(profile, "chrome-profile")}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  const activePortPath = join(profile, "chrome-profile", "DevToolsActivePort");
  const activePortText = await waitFor(async () => { try { return await readFile(activePortPath, "utf8"); } catch { return false; } }, "Chrome DevTools endpoint");
  const debugPort = activePortText.trim().split(/\r?\n/)[0];
  const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(baseUrl)}`, { method: "PUT" });
  if (!targetResponse.ok) throw new Error(`Chrome target create failed: ${targetResponse.status}`);
  const target = await targetResponse.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const pending = new Map(); let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve: resolveMessage, reject } = pending.get(message.id); pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolveMessage(message.result);
  });
  send = (method, params = {}) => new Promise((resolveMessage, reject) => {
    const id = ++nextId; pending.set(id, { resolve: resolveMessage, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression: "(()=>eval("+JSON.stringify(expression)+"))()", awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("DOM.enable");
  await waitFor(async () => (await evaluate("document.querySelectorAll('.inventory-row').length")) === 70, "inventory UI loaded");

  const bootstrap = async () => (await fetch(`${baseUrl}api/bootstrap`)).json();
  const before = await bootstrap();
  await uploadAndScan();
  if (await evaluate("document.querySelectorAll('.patch-confirmed-row').length") !== 0) throw Error('MATCH rows still require review');
  if (!await evaluate("document.querySelectorAll('.patch-correction-row').length>0")) throw Error('uncertain rows missing');
  const scan = await evaluate(`(async()=>{const f=window.__warehouseTestFile;const d=new FormData();d.append('image',f);return fetch('/api/warehouse-scan',{method:'POST',body:d}).then(r=>r.json())})()`);
  const uncertain = scan.report.slots.filter(s=>!['MATCH','EMPTY','TIER5_IGNORE'].includes(s.decision));
  if (await evaluate("document.querySelectorAll('.patch-correction-row').length") !== uncertain.length) throw Error('review does not contain exactly uncertain slots');
  const seeds=scan.report.slots.filter(s=>String(s.bestCandidate).includes('씨앗 주머니'));
  const afterScan = await bootstrap();
  if (afterScan.revision!==before.revision) throw Error('scan changed inventory');
  await evaluate("document.querySelector('.patch-review-footer [data-action=cancel]').click()");
  if ((await bootstrap()).revision!==before.revision) throw Error('cancel changed inventory');
  await uploadAndScan();
  await evaluate("[...document.querySelectorAll('.patch-correction-row')].forEach(row=>row.querySelector('.patch-correction-exclude').click())");
  await evaluate("document.querySelector('.patch-review-footer [data-action=apply]').click()");
  await waitFor(async()=>!(await evaluate("document.querySelector('.patch-review-dialog').open")), 'automatic MATCH patch saved');
  const saved=await bootstrap();
  for(const [name,stock] of Object.entries(scan.patch.items)) if(saved.inventory.find(i=>i.programName===name).stock!==stock) throw Error(`automatic stock lost: ${name}`);
  if(saved.revision!==before.revision+1) throw Error('inventory saved more than once');
  await uploadAndScan();
  await evaluate("[...document.querySelectorAll('.patch-correction-row')].forEach(row=>{const input=row.querySelector('.patch-correction-quantity');input.value=Number(input.value)+1;input.dispatchEvent(new Event('input'));const agreement=row.querySelector('.patch-item-check');agreement.value='item_only';agreement.dispatchEvent(new Event('change'))})");
  await evaluate("window.__warehouseWrites=[];window.__warehouseOriginalFetch=window.fetch.bind(window);window.fetch=(url,options)=>{if(String(url)==='/api/inventory'&&options?.method==='PATCH')window.__warehouseWrites.push(JSON.parse(options.body));return window.__warehouseOriginalFetch(url,options)};document.querySelector('.patch-review-footer [data-action=apply]').click()");
  await waitFor(async()=>!(await evaluate("document.querySelector('.patch-review-dialog').open")),'only uncertain edits saved');
  const writes=await evaluate('window.__warehouseWrites');
  if(writes.length!==1||writes[0].feedback.rows.filter(r=>r.agreement==='item_only').length!==3||writes[0].feedback.rows.filter(r=>r.agreement==='unchecked').length!==50)throw Error('automatic MATCH treated as user verified truth');
  const edited=await bootstrap();
  for(const seed of seeds)if(edited.inventory.find(i=>i.programName===seed.bestCandidate).stock!==seed.quantity.value+1)throw Error('selective edit missing');
  await evaluate('window.fetch=window.__warehouseOriginalFetch');
  await evaluate(`navigator.mediaDevices.getDisplayMedia=async()=>{const c=document.createElement('canvas');c.width=1000;c.height=700;const x=c.getContext('2d');x.fillStyle='red';x.fillRect(0,0,1000,700);window.__warehouseStream=c.captureStream(30);window.__warehouseFrame=setInterval(()=>x.fillRect(0,0,1000,700),30);return window.__warehouseStream};document.querySelector('#open-warehouse-scan').click();document.querySelector('#warehouse-scan-dialog [data-action=connect-screen]').click()`);
  await waitFor(async()=>await evaluate("!document.querySelector('#warehouse-scan-dialog .trade-roi-box').hidden"),'warehouse ROI connected');
  const roiBefore=await evaluate("document.querySelector('#warehouse-scan-dialog .trade-roi-box').dataset.normalized");
  await evaluate(`(()=>{const b=document.querySelector('#warehouse-scan-dialog .trade-roi-box'),h=b.querySelector('[data-roi-handle=se]');h.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,clientX:500,clientY:400}));b.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:1,clientX:460,clientY:360}));b.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1}));})()`);
  const roiAfter=await evaluate("document.querySelector('#warehouse-scan-dialog .trade-roi-box').dataset.normalized");
  if(roiBefore===roiAfter) throw Error('ROI drag did not resize');
  await evaluate("document.querySelector('#warehouse-scan-dialog [data-action=capture-roi]').click()");
  await waitFor(async()=>await evaluate("Number(document.querySelector('#warehouse-scan-dialog').dataset.queueLength)>0"),'ROI capture queued');
  await evaluate("document.querySelector('#warehouse-scan-dialog [data-action=cancel]').click();clearInterval(window.__warehouseFrame)");
  await waitFor(async()=>await evaluate("window.__warehouseStream.getTracks().every(t=>t.readyState==='ended')"),'warehouse stream disconnected after dialog close');
  console.log(JSON.stringify({ok:true,selectiveReview:uncertain.length,automaticMatches:Object.keys(scan.patch.items).length,seedDiagnostics:seeds.map(s=>({name:s.bestCandidate,decision:s.decision,gap:s.scoreGap})),inventorySavedOnce:true,roiResizeAndCapture:true,streamClosed:true},null,2));

  async function uploadAndScan(viaDrop = false, imagePath = fixture) {
    const queuedBefore = Number(await evaluate("document.querySelector('#warehouse-scan-dialog')?.dataset.queueLength ?? 0"));
    await evaluate("document.querySelector('#open-warehouse-scan').click()");
    const doc = await send("DOM.getDocument", { depth: -1, pierce: true });
    const node = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#warehouse-image" });
    await evaluate("window.__warehouseTestFile=null; document.querySelector('#warehouse-image').addEventListener('change',event=>{window.__warehouseTestFile=event.target.files[0]??window.__warehouseTestFile;},{capture:true,once:true})");
    await send("DOM.setFileInputFiles", { files: [imagePath], nodeId: node.nodeId });
    await evaluate("document.querySelector('#warehouse-image').dispatchEvent(new Event('change',{bubbles:true}))");
    if (viaDrop) {
      await evaluate("(() => { const transfer=new DataTransfer(); transfer.items.add(window.__warehouseTestFile); document.querySelector('.warehouse-drop-zone').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer})); })()");
    }
    const expectedQueue = queuedBefore + (viaDrop ? 2 : 1);
    await waitFor(async () => Number(await evaluate("document.querySelector('#warehouse-scan-dialog')?.dataset.queueLength ?? 0")) >= expectedQueue, "new capture normalized before scan");
    const queueAfterCapture = Number(await evaluate("document.querySelector('#warehouse-scan-dialog')?.dataset.queueLength ?? 0"));
    if (queueAfterCapture < expectedQueue) throw new Error(`capture input failed: ${await evaluate("document.querySelector('.warehouse-scan-message')?.textContent")}`);
    await evaluate("document.querySelector('.warehouse-dialog [data-action=scan]').click()");
    await waitFor(async () => (await evaluate("document.querySelector('.patch-review-dialog')?.open")) === true, "scanner result opens PATCH review", 60000);
  }

  async function completeCorrections() {
    return evaluate("JSON.stringify((() => [...document.querySelectorAll('.patch-correction-row')].map(row => { const item=row.querySelector('.patch-correction-item'); const control=item.closest('.autocomplete-control'); control.querySelector('.autocomplete-toggle').click(); control.querySelector('.autocomplete-option').click(); const quantity=row.querySelector('.patch-correction-quantity'); if(quantity.value===''){quantity.value='0';quantity.dispatchEvent(new Event('input',{bubbles:true}));} return item.value; }))())").then(JSON.parse);
  }
} finally {
  if (!external) await fetch(`${baseUrl}__test__/shutdown`,{method:"POST"}).catch(()=>{});
  try { if (socket?.readyState === WebSocket.OPEN) await Promise.race([send("Browser.close"), delay(1000)]); } catch {}
  try { socket?.close(); } catch {}
  for (const process of [chrome, server]) {
    if (process?.pid) {
      try {
        process.kill();
        await Promise.race([new Promise((resolveExit) => process.once("exit", resolveExit)), delay(1500)]);
      } catch {}
    }
  }
  await delay(500);
  if (profile.startsWith(tmpdir())) {
    try { await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); } catch {}
  }
}

async function waitFor(predicate, label, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await predicate(); if (result) return result; await delay(100); }
  throw new Error(`Timed out waiting for ${label}`);
}
