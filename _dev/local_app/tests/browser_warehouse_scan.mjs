import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
const pythonCode = `${prelude}from local_app.backend.app import create_app; create_app(r'${database}', testing=True).run(host='127.0.0.1', port=18767, use_reloader=False, threaded=True)`;
let server = spawn(python, ["-c", pythonCode], { cwd: root, stdio: "ignore", windowsHide: true });
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
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("DOM.enable");
  await waitFor(async () => (await evaluate("document.querySelectorAll('.inventory-row').length")) === 70, "inventory UI loaded");

  const orderNamesByTier = async () => evaluate("JSON.stringify([...document.querySelectorAll('.tier-section')].map(section=>[...section.querySelectorAll('.inventory-row')].map(row=>row.dataset.name)))").then(JSON.parse);
  const defaultOrders = await orderNamesByTier();
  const defaultSnapshot = await (await fetch(`${baseUrl}api/bootstrap`)).json();
  await uploadAndScan(true);
  let defaultReview = JSON.parse(await evaluate("JSON.stringify({rows:[...document.querySelectorAll('.patch-confirmed-row')].map(r=>({name:r.querySelector('.patch-correction-item').value,tier:Number(r.dataset.tier)}))})"));
  for (let tier = 1; tier <= 4; tier += 1) {
    const observed = defaultReview.rows.filter((row) => row.tier === tier).map((row) => row.name);
    const expected = defaultOrders[tier - 1].filter((name) => observed.includes(name));
    if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error(`default order mismatch in tier ${tier}: observed=${JSON.stringify(observed)} expected=${JSON.stringify(expected)}`);
  }
  await evaluate("document.querySelector('.patch-review-footer [data-action=cancel]').click()");
  await waitFor(async () => (await evaluate("!document.querySelector('.patch-review-dialog')?.open")), "default-order review cancellation");
  const afterDefaultCancel = await (await fetch(`${baseUrl}api/bootstrap`)).json();
  if (afterDefaultCancel.revision !== defaultSnapshot.revision || JSON.stringify(afterDefaultCancel.inventory) !== JSON.stringify(defaultSnapshot.inventory)) throw new Error("default-order scan or cancel changed persistent inventory");

  // Reorder tier 4 in the same UI source of truth that the review modal must consume.
  await evaluate("(() => { const rows=[...document.querySelectorAll('.tier-section')[3].querySelectorAll('.inventory-row')]; const transfer=new DataTransfer(); transfer.setData('text/plain',rows[0].dataset.name); rows[2].dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer})); })()");
  await waitFor(async () => (await evaluate("document.querySelector('#runtime-status').textContent")).includes("단계별 표시 순서를 저장했습니다"), "custom tier-4 inventory order saved");
  const order = (await orderNamesByTier())[3];

  const bootstrap = async () => (await fetch(`${baseUrl}api/bootstrap`)).json();
  const beforeScan = await bootstrap();
  await uploadAndScan();
  const reviewInfo = await evaluate("JSON.stringify({open:document.querySelector('.patch-review-dialog')?.open,rows:[...document.querySelectorAll('.patch-confirmed-row')].map(r=>({name:r.querySelector('.patch-correction-item').value,tier:Number(r.dataset.tier)})),tiers:[...document.querySelectorAll('.patch-review-tier h3')].map(x=>Number((x.textContent.match(/^(\\d+)단/)||[])[1])).filter(Number.isFinite)})");
  const parsedReview = JSON.parse(reviewInfo);
  if (!parsedReview.open || !parsedReview.rows.length) throw new Error("PATCH review dialog did not open with confirmed rows");
  if (parsedReview.tiers.some((tier, index, all) => index && all[index - 1] < tier)) throw new Error(`tier sections are not descending: ${parsedReview.tiers}`);
  const reviewTier4 = parsedReview.rows.filter((row) => row.tier === 4).map((row) => row.name);
  if (!reviewTier4.every((name, index) => !index || order.indexOf(reviewTier4[index - 1]) < order.indexOf(name))) throw new Error("review order did not preserve the current tier-4 inventory order");
  const reviewedNames = parsedReview.rows.map((row) => row.name);
  const correctionNames = await completeCorrections();
  reviewedNames.push(...correctionNames);
  const allCurrentOrders = await orderNamesByTier();
  for (let tier = 1; tier <= 4; tier += 1) {
    const observed = parsedReview.rows.filter((row) => row.tier === tier).map((row) => row.name);
    const expected = allCurrentOrders[tier - 1].filter((name) => observed.includes(name));
    if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error(`inventoryOrder mismatch in tier ${tier} after reorder`);
  }
  const afterReview = await bootstrap();
  if (JSON.stringify(afterReview.inventory) !== JSON.stringify(beforeScan.inventory) || afterReview.revision !== beforeScan.revision) throw new Error("database changed before the user selected Apply");
  await evaluate("document.querySelector('.patch-review-footer [data-action=cancel]').click()");
  await waitFor(async () => (await evaluate("!document.querySelector('.patch-review-dialog')?.open")), "review cancellation");
  const afterCancel = await bootstrap();
  if (JSON.stringify(afterCancel.inventory) !== JSON.stringify(beforeScan.inventory) || afterCancel.revision !== beforeScan.revision) throw new Error("cancelling review changed persistent data");

  await uploadAndScan();
  await completeCorrections();
  const beforeConflict = await bootstrap();
  const changedSettings = await fetch(`${baseUrl}api/settings`).then((response) => response.json());
  const settingResponse = await fetch(`${baseUrl}api/settings`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mutationId: "browser-external-revision", baseRevision: changedSettings.revision, settings: { viewer: { uiZoom: 101 } } }) });
  if (!settingResponse.ok) throw new Error("test could not advance the server revision");
  await evaluate("document.querySelector('.patch-review-footer [data-action=apply]').click()");
  await waitFor(async () => (await evaluate("document.querySelector('#runtime-status').textContent")).includes("저장 버전이 바뀌어"), "stale review is refreshed before applying");
  const afterConflict = await bootstrap();
  if (afterConflict.revision !== beforeConflict.revision + 1 || JSON.stringify(afterConflict.inventory) !== JSON.stringify(beforeConflict.inventory)) throw new Error("stale PATCH applied during revision conflict");
  await evaluate("(() => { window.__warehouseFetch = window.fetch; window.fetch = async (input, init={}) => { if (String(input).includes('/api/inventory') && init.method === 'PATCH' && JSON.parse(init.body).kind === 'warehouse') return Response.json({ok:false,error:{code:'storage_error',message:'forced browser save failure'}},{status:503}); return window.__warehouseFetch(input, init); }; })()");
  await evaluate("document.querySelector('.patch-review-footer [data-action=apply]').click()");
  await waitFor(async () => (await evaluate("document.querySelector('#runtime-status').textContent")).includes("저장하지 못했습니다"), "warehouse save failure shown without success");
  if (!(await evaluate("document.querySelector('.patch-review-dialog')?.open"))) throw new Error("review closed after a failed save");
  const afterFailedSave = await bootstrap();
  if (afterFailedSave.revision !== afterConflict.revision || JSON.stringify(afterFailedSave.inventory) !== JSON.stringify(afterConflict.inventory)) throw new Error("failed save changed inventory or revision");
  await evaluate("window.fetch = window.__warehouseFetch; delete window.__warehouseFetch");
  await evaluate("(() => { window.__warehouseFetch = window.fetch; window.__failNextBootstrap = false; window.fetch = async (input, init={}) => { if (String(input).includes('/api/inventory') && init.method === 'PATCH' && JSON.parse(init.body).kind === 'warehouse') { const response=await window.__warehouseFetch(input,init); window.__failNextBootstrap=true; return response; } if (String(input).includes('/api/bootstrap') && window.__failNextBootstrap) { window.__failNextBootstrap=false; return Response.json({ok:false,error:{code:'temporary_read_failure',message:'forced one-time read failure'}},{status:503}); } return window.__warehouseFetch(input,init); }; })()");
  await evaluate("document.querySelector('.patch-review-footer [data-action=apply]').click()");
  await waitFor(async () => (await evaluate("document.querySelector('#runtime-status').textContent")).includes("재고 저장은 완료됐고 최신 상태를 다시 불러왔습니다"), "committed write recovered from one-time refresh failure");
  await evaluate("window.fetch = window.__warehouseFetch; delete window.__warehouseFetch; delete window.__failNextBootstrap");
  await waitFor(async () => (await evaluate("document.querySelectorAll('.inventory-row').length")) === 70, "inventory UI refreshed after apply");
  const afterApply = await bootstrap();
  if (afterApply.revision !== afterConflict.revision + 1) throw new Error("confirmed warehouse PATCH did not increment revision exactly once");
  const oldInventory = Object.fromEntries(beforeConflict.inventory.map((item) => [item.programName, item]));
  const newInventory = Object.fromEntries(afterApply.inventory.map((item) => [item.programName, item]));
  for (const item of afterApply.inventory) {
    if (!reviewedNames.includes(item.programName) && (item.stock !== oldInventory[item.programName].stock || item.target !== oldInventory[item.programName].target)) throw new Error(`non-PATCH item changed: ${item.programName}`);
    if (item.target !== oldInventory[item.programName].target) throw new Error(`target changed during warehouse apply: ${item.programName}`);
  }
  if (JSON.stringify(afterApply.order) !== JSON.stringify(afterConflict.order) || JSON.stringify(afterApply.settings) !== JSON.stringify(afterConflict.settings)) throw new Error("order or settings changed during warehouse apply");
  await uploadAndScan(false, reviewFixture);
  await waitFor(async () => evaluate("[...document.querySelectorAll('.patch-correction-row canvas')].length>0 && [...document.querySelectorAll('.patch-correction-row canvas')].every(canvas=>canvas.getContext('2d').getImageData(0,0,120,120).data.some(x=>x))"), "all tracked fixture slot previews rendered");
  const masterReview = JSON.parse(await evaluate("JSON.stringify({rows:[...document.querySelectorAll('.patch-correction-row')].map(r=>({slot:r.dataset.slot,name:r.querySelector('.patch-correction-item').value,quantity:r.querySelector('.patch-correction-quantity').value,preview:!!r.querySelector('canvas').getContext('2d').getImageData(0,0,120,120).data.some(x=>x)})),disabled:document.querySelector('.patch-review-footer [data-action=apply]').disabled})"));
  if (!masterReview.rows.length || !masterReview.rows.every(row => row.preview)) throw new Error(`tracked review fixture did not expose all cropped correction rows: ${JSON.stringify(masterReview)}`);
  if (!masterReview.disabled) throw new Error("Apply was enabled before all unrecognized slots were corrected");
  const beforeMasterApply = await bootstrap();
  const correctionItem = await evaluate("(() => { const item=document.querySelector('.patch-correction-item'); const control=item.closest('.autocomplete-control'); control.querySelector('.autocomplete-toggle').click(); return control.querySelector('.autocomplete-option').textContent; })()");
  const correctionTotals = await evaluate(`(() => {const rows=[...document.querySelectorAll('.patch-correction-row')]; let total=0; for(const [index,row] of rows.entries()){const exclude=row.querySelector('.patch-correction-exclude'); const item=row.querySelector('.patch-correction-item'); const quantity=row.querySelector('.patch-correction-quantity'); if(index===0){item.value=${JSON.stringify(correctionItem)};item.dispatchEvent(new Event('input',{bubbles:true}));quantity.value='97';quantity.dispatchEvent(new Event('input',{bubbles:true}));exclude.checked=true;exclude.dispatchEvent(new Event('change',{bubbles:true}));continue;} item.value=${JSON.stringify(correctionItem)}; item.dispatchEvent(new Event('input',{bubbles:true})); if(quantity.value===''){quantity.value='0';quantity.dispatchEvent(new Event('input',{bubbles:true}));} total+=Number(quantity.value);} window.__manualCorrectionTotal=total; return {total,enabled:!document.querySelector('.patch-review-footer [data-action=apply]').disabled,excluded:rows[0].dataset.slot};})()`);
  if (!correctionTotals.enabled) throw new Error("Apply stayed disabled after all correction fields were completed");
  await evaluate("(() => { window.__warehousePatchCalls=[]; window.__warehouseFetch=window.fetch; window.fetch=async(input,init={})=>{if(String(input).includes('/api/inventory')&&init.method==='PATCH'&&JSON.parse(init.body).kind==='warehouse') window.__warehousePatchCalls.push(JSON.parse(init.body)); return window.__warehouseFetch(input,init); }; })()");
  await evaluate("document.querySelector('.patch-review-footer [data-action=apply]').click()");
  await waitFor(async () => (await evaluate("document.querySelector('#runtime-status').textContent")).includes("한 번에 저장했습니다"), "tracked review fixture corrections saved in one request");
  const afterMasterApply = await bootstrap();
  const manualWrite = JSON.parse(await evaluate("JSON.stringify(window.__warehousePatchCalls)"));
  if (manualWrite.length !== 1 || afterMasterApply.revision !== beforeMasterApply.revision + 1) throw new Error("tracked-fixture corrections were not saved through exactly one inventory write");
  if (!Object.hasOwn(manualWrite[0].patch.items, correctionItem)) throw new Error("manual item selection was missing from the single inventory write");
  const savedManual = afterMasterApply.inventory.find(item => item.programName === correctionItem).stock;
  if (savedManual === null || savedManual !== correctionTotals.total) throw new Error(`manual correction quantities did not reach inventory: item=${correctionItem} expected=${correctionTotals.total} saved=${savedManual}`);
  console.log(JSON.stringify({ ok: true, browser: "Chrome headless", upload: "tracked fixtures: barter_only.png and mixed.png", manualCorrectionSlots: masterReview.rows.length, slotPreviews: "all rendered", incompleteApplyBlocked: true, correctionsAppliedInSingleInventoryMutation: true, correctionItem: correctionItem, correctionQuantity: correctionTotals.total, customTier4Order: reviewTier4, reviewRows: reviewedNames.length, applyCancelledWithoutWrite: true, staleRevisionRequiredReconfirmation: true, failedSaveKeptReviewAndDatabaseUnchanged: true, committedWriteRecoveredAfterRefreshError: true, applyChangedPatchStocksOnly: true, targetsOrderSettingsPreserved: true, temporaryDatabase: true }, null, 2));

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
