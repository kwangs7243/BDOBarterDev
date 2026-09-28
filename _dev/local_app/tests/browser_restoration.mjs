import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const port = 18771;
const baseUrl = `http://127.0.0.1:${port}/`;
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const pythonPath = process.env.PYTHON ?? "python";
const workspace = resolve(root, "specs/007-feature-restoration");
const evidenceDir = join(workspace, "evidence");
const profile = await mkdtemp(join(tmpdir(), "bdo-spec007-browser-"));
const database = join(profile, "isolated.sqlite3");
const pythonPrelude = process.env.BDO_EXTRA_SITE_PACKAGES
  ? `import sys; p=${JSON.stringify(process.env.BDO_EXTRA_SITE_PACKAGES)}; sys.path.remove(p); sys.path.append(p); `
  : "";
const pythonCode = `${pythonPrelude}from local_app.backend.app import create_app; create_app(r'${database}', testing=True).run(host='127.0.0.1', port=${port}, use_reloader=False, threaded=True)`;
let server;
let chrome;
let socket;
let targetId;
let activeEvaluate;
let activeSend;
const browserErrors = [];

try {
  await mkdir(evidenceDir, { recursive: true });
  server = startServer();
  await waitForHealth("temporary app startup");
  chrome = spawn(chromePath, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
    "--disable-extensions", "--disable-background-networking", "--remote-debugging-port=0",
    "--remote-allow-origins=*", `--user-data-dir=${join(profile, "chrome-profile")}`, "about:blank",
  ], { stdio: "ignore", windowsHide: true });
  const portFile = join(profile, "chrome-profile", "DevToolsActivePort");
  const portText = await waitFor(async () => { try { return await readFile(portFile, "utf8"); } catch { return false; } }, "Chrome DevTools port");
  const devtoolsPort = portText.trim().split(/\r?\n/)[0];
  const targetResponse = await fetch(`http://127.0.0.1:${devtoolsPort}/json/new?${encodeURIComponent(baseUrl)}`, { method: "PUT", signal: AbortSignal.timeout(10000) });
  if (!targetResponse.ok) throw new Error(`Chrome target create failed: ${targetResponse.status}`);
  const target = await targetResponse.json();
  targetId = target.id;
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await Promise.race([
    new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", reject, { once: true }); }),
    delay(10000).then(() => { throw new Error("Chrome DevTools socket did not open."); }),
  ]);
  const pending = new Map(); let nextId = 0;
  const send = (method, params = {}) => new Promise((resolveCall, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveCall, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
    if (message.method === "Runtime.exceptionThrown") { const details = message.params.exceptionDetails; browserErrors.push(JSON.stringify({ text: details?.text, url: details?.url, line: details?.lineNumber, column: details?.columnNumber, exception: details?.exception, stackTrace: details?.stackTrace?.callFrames?.slice(0, 4) })); }
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") browserErrors.push(JSON.stringify({ args: message.params.args?.map((arg) => arg.value ?? arg.description), stack: message.params.stackTrace?.callFrames?.slice(0, 4) }));
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id); pending.delete(message.id);
      message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
    }
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  activeEvaluate = evaluate;
  activeSend = send;
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  try {
    await waitFor(async () => (await evaluate("document.querySelectorAll('.inventory-row').length")) === 70, "initial inventory UI");
  } catch (error) {
    const startup = await evaluate("JSON.stringify({title:document.title,status:document.querySelector('#runtime-status')?.textContent,inventoryRows:document.querySelectorAll('.inventory-row').length,busy:document.querySelector('#app-content')?.getAttribute('aria-busy'),body:document.body.innerText.slice(0,900)})").catch((failure) => `diagnostic failed: ${failure.message}`);
    const servedMap = await fetch(`${baseUrl}assets/js/map-viewer.js`).then((response) => response.text()).catch(() => "unavailable");
    const diskMap = await readFile(resolve(root, "frontend/js/map-viewer.js"), "utf8").catch(() => "unavailable");
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    throw new Error(`${error.message}; startup=${startup}; pageErrors=${browserErrors.join(" | ")}; mapSource=${JSON.stringify({ servedSha256: digest(servedMap), diskSha256: digest(diskMap), servedLine92: servedMap.split(/\r?\n/)[91], diskLine92: diskMap.split(/\r?\n/)[91] })}`);
  }

  await clickSelector("#open-json-import");
  await setValue("#trade-json-input", "");
  const emptyWasOpen = await evaluate("document.querySelector('#json-import-dialog').open");
  await clickSelector("#apply-new-session");
  const emptyImport = await evaluate("JSON.stringify({dialogStillOpen:document.querySelector('#json-import-dialog').open,sessionCount:document.querySelectorAll('.trade-row').length,status:document.querySelector('#trade-import-status').textContent})");
  const emptyImportState = JSON.parse(emptyImport);
  if (!emptyWasOpen || emptyImportState.sessionCount !== 0 || !emptyImportState.dialogStillOpen || !emptyImportState.status.includes("JSON 파싱 실패")) throw new Error(`empty JSON submission changed the empty session or lost its correction state: ${emptyImport}`);
  await clickSelector("#json-import-dialog [data-close-dialog]");
  if (await evaluate("document.querySelector('#json-import-dialog').open")) throw new Error("cancel did not close the empty JSON dialog");

  const boot = await requestJson("/api/bootstrap");
  const seedResponse = await fetch(`${baseUrl}api/inventory`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mutationId: "spec007-browser-seed", baseRevision: boot.revision, kind: "manual", patch: { items: { "갈퀴 꽃 씨앗 주머니": { stock: 100 }, "괴생물 촉수": { stock: 0 } } } }) });
  if (!seedResponse.ok) throw new Error(`temporary inventory seed failed: ${seedResponse.status} ${await seedResponse.text()}`);
  await evaluate("import('/assets/js/persistence.js').then(({refreshPersistentState})=>refreshPersistentState())");
  await clickInputByLabel("갈퀴 꽃 씨앗 주머니 현재 재고", "101");
  await waitFor(async () => (await evaluate("document.querySelector('#runtime-status').textContent"))?.includes("재고 저장을 확인했습니다"), "inventory UI save");
  await setNumberAndSave("#ship-speed", "181", "#ship-root button");
  await evaluate("document.querySelector('#presets-root .preset-card button')?.click()");
  await waitFor(async () => (await evaluate("document.querySelector('#runtime-status').textContent"))?.includes("1번 프리셋 저장을 확인했습니다"), "ship preset UI save");
  await clickSelector("#open-map-tools");
  await waitFor(async () => (await evaluate("document.querySelector('#map-tools-dialog').open && !!document.querySelector('#viewer-zoom')")) === true, "map tools dialog");
  await setValue("#viewer-zoom", "130");
  await clickSelector("#viewer-root .actions button");
  try {
    await waitFor(async () => (await evaluate("document.documentElement.style.getPropertyValue('--app-zoom')")) === "1.3", "UI zoom saved and applied");
  } catch (error) {
    const zoomState = await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({status:document.querySelector('#runtime-status')?.textContent,input:document.querySelector('#viewer-zoom')?.value,setting:state.settings.viewer,rootZoom:document.documentElement.style.getPropertyValue('--app-zoom'),mainZoom:getComputedStyle(document.querySelector('#app-content')).zoom}))").catch((failure) => `diagnostic failed: ${failure.message}`);
    throw new Error(`${error.message}; zoomState=${zoomState}; pageErrors=${browserErrors.join(" | ")}`);
  }
  await waitPersistenceIdle(evaluate);
  await clickSelector("#map-tools-dialog [data-close-dialog]");
  await clickSelector("#open-json-import");
  const trade = { island: "베이루와 섬", fromItem: "갈퀴 꽃 씨앗 주머니", toItem: "괴생물 촉수", reqAmount: 1, count: 3, yield: 3, deleted: false, disabled: false };
  await setValue("#trade-json-input", JSON.stringify([trade]));
  await clickSelector("#apply-new-session");
  await waitFor(async () => (await evaluate("document.querySelectorAll('.trade-row').length")) === 1, "new working session from JSON UI");
  await waitPersistenceIdle(evaluate);

  await clickSelector("#toggle-all-trades");
  let tradeState = JSON.parse(await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({disabled:state.session.scannedTrades[0].disabled,deleted:state.session.scannedTrades[0].deleted}))"));
  if (!tradeState.disabled) throw new Error("toggle-all did not disable active trades");
  await clickSelector("#toggle-all-trades");
  await clickSelector(".trade-row input[type=checkbox]");
  await clickSelector(".trade-row button");
  tradeState = JSON.parse(await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({disabled:state.session.scannedTrades[0].disabled,deleted:state.session.scannedTrades[0].deleted}))"));
  if (!tradeState.disabled || !tradeState.deleted) throw new Error(`individual disable/delete UI did not update the session: ${JSON.stringify(tradeState)}`);
  await clickSelector(".trade-row button");
  await clickSelector(".trade-row input[type=checkbox]");
  await waitPersistenceIdle(evaluate);
  tradeState = JSON.parse(await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({disabled:state.session.scannedTrades[0].disabled,deleted:state.session.scannedTrades[0].deleted}))"));
  if (tradeState.disabled || tradeState.deleted) throw new Error(`trade row restore did not restore state: ${JSON.stringify(tradeState)}`);
  await waitFor(async () => (await evaluate("Promise.all([import('/assets/js/state.js'),fetch('/api/bootstrap').then(r=>r.json())]).then(([{state},snapshot])=>state.persistencePending===0&&snapshot.workingSession?.id===state.session.id)")) === true, "working session save confirmed before main screenshot");
  await waitFor(async () => (await evaluate("(()=>{const e=document.querySelector('#runtime-status');return e?.dataset.kind==='success'&&e.textContent==='현재 회차 저장을 확인했습니다.'})()")) === true, "working-session save confirmation status before main screenshot");
  await evaluate("document.querySelector('#mainPanel').scrollTop=0;document.querySelector('#trade-list-root').scrollLeft=0;document.querySelector('#trade-list-root').scrollTop=0");
  const mainCapture = JSON.parse(await evaluate("JSON.stringify({listScrollLeft:document.querySelector('#trade-list-root').scrollLeft,listScrollTop:document.querySelector('#trade-list-root').scrollTop,workingSessionRows:document.querySelectorAll('#trade-list-root .trade-row').length,firstRow:document.querySelector('#trade-list-root .trade-row')?.innerText,status:document.querySelector('#runtime-status')?.textContent,statusKind:document.querySelector('#runtime-status')?.dataset.kind})"));
  if (mainCapture.listScrollLeft !== 0 || mainCapture.listScrollTop !== 0 || mainCapture.workingSessionRows < 1 || !mainCapture.firstRow || mainCapture.status !== "현재 회차 저장을 확인했습니다." || mainCapture.statusKind !== "success") throw new Error(`main screenshot was not at a saved, horizontally reset trade list with a success status: ${JSON.stringify(mainCapture)}`);
  await screenshot("main130.png", send);
  await clickSelector("#add-manual-trade");
  await evaluate(`import('/assets/js/state.js').then(({state})=>{const all=state.session.scannedTrades;const active=all.find(row=>row.island==='베이루와 섬'&&row.fromItem==='갈퀴 꽃 씨앗 주머니'&&row.toItem==='괴생물 촉수');if(!active)throw Error('imported trade missing');const disabled=all.filter(row=>row!==active).map(row=>({...active,count:1,yield:1,disabled:true,deleted:false}));const fillers=Array.from({length:23},()=>({...active,count:1,yield:1,disabled:true,deleted:false}));state.session.scannedTrades=[...disabled,...fillers,{...active}];window.__bdoRenderTradeList();window.dispatchEvent(new CustomEvent('bdo:session-changed'))})`);
  await waitPersistenceIdle(evaluate);
  const sessionFlags = JSON.parse(await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({rows:state.session.scannedTrades.length,active:state.session.scannedTrades.filter(t=>!t.deleted&&!t.disabled).length,disabled:state.session.scannedTrades.filter(t=>t.disabled).length,valid:state.session.scannedTrades.filter(t=>t.island==='베이루와 섬'&&t.fromItem==='갈퀴 꽃 씨앗 주머니'&&t.toItem==='괴생물 촉수').length}))"));
  if (sessionFlags.rows !== 25 || sessionFlags.active !== 1 || sessionFlags.disabled !== 24 || sessionFlags.valid !== 25) throw new Error(`temporary browser rows do not isolate one active route: ${JSON.stringify(sessionFlags)}`);

  const mainLayout = JSON.parse(await evaluate(`JSON.stringify((()=>{const selectors=['#mainPanel','#trade-session-panel','#trade-list-root'];return {viewport:{w:innerWidth,h:innerHeight},zoom:getComputedStyle(document.documentElement).getPropertyValue('--app-zoom'),panels:selectors.map(s=>{const e=document.querySelector(s),r=e.getBoundingClientRect(),c=getComputedStyle(e);return {s,left:r.left,top:r.top,right:r.right,bottom:r.bottom,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,overflowY:c.overflowY}})}})())`));
  if (mainLayout.zoom.trim() !== "1.3") throw new Error(`UI zoom did not persist at 130%: ${JSON.stringify(mainLayout)}`);
  assertInsideViewport(mainLayout, "main panel");
  const sessionScroll = mainLayout.panels.find((item) => item.s === "#trade-list-root");
  if (sessionScroll.overflowY !== "auto" || sessionScroll.scrollHeight <= sessionScroll.clientHeight) throw new Error(`session list did not overflow inside its own scroll area at 130%: ${JSON.stringify(sessionScroll)}`);
  await evaluate("document.querySelector('#mainPanel').scrollTop=0;document.querySelector('#trade-list-root').scrollLeft=0;document.querySelector('#trade-list-root').scrollTop=0");

  await clickSelector("#open-schedule");
  await waitFor(async () => (await evaluate("document.querySelector('#schedule-dialog').open")) === true, "briefing dialog");
  await clickSelector("[data-brief-mode=both]");
  await clickSelector("#generate-schedule");
  try {
    await waitFor(async () => (await evaluate("document.querySelectorAll('#col-speed .sortie-card').length")) > 0, "speed and balance schedule generation");
  } catch (error) {
    const generation = await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({status:document.querySelector('#schedule-status')?.textContent,runtime:document.querySelector('#runtime-status')?.textContent,trade:state.session.scannedTrades,inventory:state.inventory.filter(x=>['갈퀴 꽃 씨앗 주머니','괴생물 촉수'].includes(x.programName)).map(x=>({name:x.programName,stock:x.stock})),schedule:state.session.schedule,routeMarkup:document.querySelector('#col-speed').innerHTML.slice(0,700)}))").catch((failure) => `diagnostic failed: ${failure.message}`);
    throw new Error(`${error.message}; generation=${generation}; pageErrors=${browserErrors.join(" | ")}`);
  }
  await waitFor(async () => (await evaluate("document.querySelectorAll('#col-balance .sortie-card').length")) > 0, "balance schedule generation");
  const dialogBeforeDrag = JSON.parse(await evaluate("(()=>{const r=document.querySelector('#schedule-dialog').getBoundingClientRect();return JSON.stringify({left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height})})()"));
  await dragBySelector("#schedule-dialog .dialog-titlebar", 90, 18, 24, 18);
  const dialogAfterDrag = JSON.parse(await evaluate("(()=>{const r=document.querySelector('#schedule-dialog').getBoundingClientRect();return JSON.stringify({left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height})})()"));
  if (dialogAfterDrag.left - dialogBeforeDrag.left < 12 || dialogAfterDrag.top - dialogBeforeDrag.top < 8) throw new Error(`briefing titlebar drag did not move the dialog at 130%: ${JSON.stringify({dialogBeforeDrag,dialogAfterDrag})}`);
  await dragResize("#schedule-dialog", 38, 32);
  const dialogAfterResize = JSON.parse(await evaluate("(()=>{const r=document.querySelector('#schedule-dialog').getBoundingClientRect();return JSON.stringify({left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height})})()"));
  if (dialogAfterResize.width - dialogAfterDrag.width < 15 || dialogAfterResize.height - dialogAfterDrag.height < 12) throw new Error(`briefing native resize handle did not resize the dialog at 130%: ${JSON.stringify({dialogAfterDrag,dialogAfterResize})}`);
  const briefingDialogInteraction = { before: dialogBeforeDrag, afterDrag: dialogAfterDrag, afterResize: dialogAfterResize };
  await screenshot("briefing130.png", send);
  await clickSelector("[data-brief-mode=speed]");
  await clickSelector("[data-brief-mode=balance]");
  await clickSelector("[data-brief-mode=both]");
  await clickSelector("#schedule-dialog [data-close-dialog]");
  await waitPersistenceIdle(evaluate);

  await clickSelector("#open-tuning");
  await waitFor(async () => (await evaluate("document.querySelector('#tuning-dialog').open && !!document.querySelector('#temp-tune-useClustering')")) === true, "temporary tuning dialog");
  await screenshot("tuning130.png", send);
  const tuningBefore = await evaluate("document.querySelector('#temp-tune-useClustering').value");
  await setValue("#temp-tune-useClustering", String(Number(tuningBefore) + 1));
  await clickSelector("#tuning-root [data-tuning-temporary] button");
  await waitPersistenceIdle(evaluate);
  const temporaryTuning = JSON.parse(await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({temporary:state.session.config.tuning.useClustering,durable:state.settings.tuning.useClustering}))"));
  if (temporaryTuning.temporary !== Number(tuningBefore) + 1 || temporaryTuning.durable === temporaryTuning.temporary) throw new Error(`temporary tuning was not session-only: ${JSON.stringify(temporaryTuning)}`);
  await clickSelector("[data-tuning-tab=durable]");
  await clickSelector("#tuning-dialog [data-close-dialog]");
  await setValue("#ship-mode", "inner", "change");
  await waitPersistenceIdle(evaluate);

  const scheduleState = JSON.parse(await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({session:window.__bdoScheduleRuntime.snapshotWorkingSession(state),speed:state.session.schedule.speed.length,balance:state.session.schedule.balance.length}))"));
  if (!scheduleState.speed || !scheduleState.balance || scheduleState.session.schedule === null) throw new Error(`schedule session state missing before slot save: ${JSON.stringify(scheduleState)}`);
  await clickSelector("#open-schedule");
  await waitFor(async () => (await evaluate("document.querySelector('#schedule-dialog').open")) === true, "briefing reopen for slot actions");
  await saveSlot(evaluate, 1);
  await evaluate("document.querySelector('#selected-schedule-slot').value='2';document.querySelector('#selected-schedule-slot').dispatchEvent(new Event('change',{bubbles:true}))");
  await clickRouteCountButton(evaluate, 1);
  await clickSelector("#col-speed .sortie-card .sortie-heading button");
  await waitFor(async () => (await evaluate("!document.querySelector('#waypointModal').classList.contains('hidden')")) === true, "waypoint dialog open");
  await evaluate("(()=>{document.querySelector('#wpIsland').value='인버넨 섬';document.querySelector('#wpAnchorSelect').value='0';document.querySelector('input[name=wpPos][value=after]').checked=true})()");
  await clickSelector("#confirm-waypoint");
  const waypointCount = await evaluate("import('/assets/js/state.js').then(({state})=>state.session.schedule.speed.flatMap(s=>s.trades).filter(t=>t.isWaypoint).length)");
  if (waypointCount !== 1) throw new Error(`waypoint was not inserted into the browser schedule: ${waypointCount}`);
  await waitPersistenceIdle(evaluate);
  await saveSlot(evaluate, 2);
  let slotState = await requestJson("/api/bootstrap");
  const slot1 = slotState.scheduleSlots["1"]?.session;
  const slot2 = slotState.scheduleSlots["2"]?.session;
  if (!slot1 || !slot2 || JSON.stringify(slot1) === JSON.stringify(slot2)) throw new Error("saved slots are missing or not independent snapshots");
  if (slot1.config.tuning.useClustering !== Number(tuningBefore) + 1) throw new Error("slot 1 did not preserve temporary tuning context");
  if (!slot2.schedule.speed.some((sortie) => sortie.trades.some((item) => item.isWaypoint))) throw new Error("slot 2 did not preserve the waypoint added through the UI");

  await setTimer(evaluate, true);
  const liveTimer = await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({timerCount:Object.keys(state.session.timers||{}).length,timerKeys:(state.session.schedule.speed.flatMap(s=>s.trades)).some(t=>t.timerActive||t.timerEnd||t.alarmPlayed),snapshot:(()=>{const x=window.__bdoScheduleRuntime.snapshotWorkingSession(state);return (x.schedule.speed.flatMap(s=>s.trades)).some(t=>t.timerActive||t.timerEnd||t.alarmPlayed)})()}))");
  const liveTimerState = JSON.parse(liveTimer);
  if (!liveTimerState.timerCount || !liveTimerState.timerKeys || liveTimerState.snapshot) throw new Error(`timer session / snapshot contract mismatch: ${liveTimer}`);
  await waitPersistenceIdle(evaluate);
  await evaluate("document.querySelector('#app-content').setAttribute('data-reload-test','pending')");
  await send("Page.reload", { ignoreCache: true });
  await waitFor(async () => (await evaluate("document.querySelector('#app-content')?.getAttribute('aria-busy')==='false'&&!document.querySelector('#app-content')?.hasAttribute('data-reload-test')&&document.querySelectorAll('.inventory-row').length===70&&document.querySelectorAll('.trade-row').length===25")) === true, "browser refresh restored current session");
  await waitFor(async () => (await evaluate("document.documentElement.style.getPropertyValue('--app-zoom')")) === "1.3", "UI zoom reload");
  const refreshed = JSON.parse(await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({session:state.session,inventory:state.inventory.find(x=>x.programName==='갈퀴 꽃 씨앗 주머니')?.stock,settings:state.settings,revision:state.revision}))"));
  if (refreshed.inventory !== 101 || refreshed.session.schedule === null || Object.keys(refreshed.session.timers || {}).length !== 0) throw new Error(`session / inventory / timer state did not restore as specified: ${JSON.stringify({stock:refreshed.inventory,timers:refreshed.session.timers,schedule:!!refreshed.session.schedule})}`);
  if (refreshed.session.schedule.speed.flatMap((s) => s.trades).some((item) => item.timerActive || item.timerEnd || item.alarmPlayed)) throw new Error("restored schedule contained a timer that must reset on refresh");
  await clickSelector("#open-schedule");
  await waitFor(async () => (await evaluate("document.querySelector('#schedule-dialog').open")) === true, "restored schedule dialog");
  const restoredScheduleDom = JSON.parse(await evaluate("JSON.stringify({speedCards:document.querySelectorAll('#col-speed .sortie-card').length,balanceCards:document.querySelectorAll('#col-balance .sortie-card').length,routeRows:document.querySelectorAll('#col-speed .schedule-route li').length,timerVisible:[...document.querySelectorAll('#col-speed .schedule-route li')].some(row=>row.querySelectorAll('button')[2]?.textContent.includes('취소'))})"));
  if (!restoredScheduleDom.speedCards || !restoredScheduleDom.balanceCards || !restoredScheduleDom.routeRows || restoredScheduleDom.timerVisible) throw new Error(`restored working session did not render schedule DOM / reset timer controls: ${JSON.stringify(restoredScheduleDom)}`);
  await clickSelector("#schedule-dialog [data-close-dialog]");
  await verifyPersistentIdle(evaluate);

  await stopServer();
  server = startServer();
  await waitForHealth("same temporary database after backend process restart");
  await evaluate("document.querySelector('#app-content').setAttribute('data-reload-test','pending')");
  await send("Page.reload", { ignoreCache: true });
  await waitFor(async () => (await evaluate("document.querySelector('#app-content')?.getAttribute('aria-busy')==='false'&&!document.querySelector('#app-content')?.hasAttribute('data-reload-test')&&document.querySelectorAll('.inventory-row').length===70&&document.querySelectorAll('.trade-row').length===25")) === true, "working session after app process restart");
  await clickSelector("#open-schedule");
  await waitFor(async () => (await evaluate("document.querySelector('#schedule-dialog').open")) === true, "briefing reopen after app process restart");
  const restarted = await requestJson("/api/bootstrap");
  if (restarted.inventory.find((item) => item.programName === "갈퀴 꽃 씨앗 주머니")?.stock !== 101 || !restarted.workingSession?.schedule || !restarted.scheduleSlots["1"] || !restarted.scheduleSlots["2"]) throw new Error("durable inventory, working session, or slots did not survive actual app process restart");
  if (JSON.stringify(restarted.scheduleSlots["1"].session) !== JSON.stringify(slot1) || JSON.stringify(restarted.scheduleSlots["2"].session) !== JSON.stringify(slot2)) throw new Error("slot snapshots changed across app restart");

  await loadSlot(evaluate, 1);
  const loadedSlot1 = JSON.parse(await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({tuning:state.session.config.tuning.useClustering,mode:state.session.selection.briefMode,selected:state.session.selection.selectedScheduleSlot,schedule:state.session.schedule!==null,timers:state.session.timers}))"));
  if (loadedSlot1.tuning !== Number(tuningBefore) + 1 || !loadedSlot1.schedule || Object.keys(loadedSlot1.timers || {}).length !== 0) throw new Error(`slot load did not restore context and reset timers: ${JSON.stringify(loadedSlot1)}`);
  await deleteSlot(evaluate, 1);
  const afterSlotDelete = await requestJson("/api/bootstrap");
  if (afterSlotDelete.scheduleSlots["1"] !== null || !afterSlotDelete.scheduleSlots["2"]) throw new Error("deleting slot 1 affected another slot or left slot 1 saved");

  await setTimer(evaluate, false);
  const preCompletion = await requestJson("/api/bootstrap");
  const stockBeforeCompletion = preCompletion.inventory.find((item) => item.programName === "갈퀴 꽃 씨앗 주머니")?.stock;
  await evaluate(`(()=>{const original=window.fetch.bind(window);window.__spec007CompletionBodies=[];window.fetch=async(input,options={})=>{if(String(input).includes('/api/working-session/completion')&&options.method==='POST'){window.__spec007CompletionBodies.push(options.body);const response=await original(input,options);if(window.__spec007CompletionBodies.length===1)throw new TypeError('SPEC-007 injected response loss after commit');return response}return original(input,options)}})()`);
  await clickFirstCompletion(evaluate);
  await waitFor(async () => (await evaluate("document.querySelector('#retry-completion-save').hidden")) === false, "completion response-loss retry button");
  const committedInventory = await requestJson("/api/bootstrap");
  const stockAfterFirstCommit = committedInventory.inventory.find((item) => item.programName === "갈퀴 꽃 씨앗 주머니")?.stock;
  if (stockAfterFirstCommit === stockBeforeCompletion) throw new Error("completion request did not commit an inventory mutation before response loss");
  await clickSelector("#retry-completion-save");
  await waitFor(async () => (await evaluate("window.__bdoScheduleRuntime.pending===null && document.querySelector('#retry-completion-save').hidden")) === true, "idempotent completion retry acknowledged");
  const retry = JSON.parse(await evaluate("JSON.stringify({bodies:window.__spec007CompletionBodies,invocations:window.__bdoCompletionInvocationCounts?.completeTrade,pending:window.__bdoScheduleRuntime.pending})"));
  if (retry.bodies.length !== 2 || retry.bodies[0] !== retry.bodies[1] || retry.pending !== null) throw new Error("completion retry did not resend the exact original request body");
  const completedBootstrap = await requestJson("/api/bootstrap");
  const finalStock = completedBootstrap.inventory.find((item) => item.programName === "갈퀴 꽃 씨앗 주머니")?.stock;
  if (finalStock !== stockAfterFirstCommit) throw new Error("completion retry applied the inventory change more than once");
  await evaluate("document.querySelector('#app-content').setAttribute('data-reload-test','pending')");
  await send("Page.reload", { ignoreCache: true });
  await waitFor(async () => (await evaluate("document.querySelector('#app-content')?.getAttribute('aria-busy')==='false'&&!document.querySelector('#app-content')?.hasAttribute('data-reload-test')&&document.querySelectorAll('.trade-row').length===25")) === true, "completed session reload");
  const completionRestored = JSON.parse(await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({stock:state.inventory.find(x=>x.programName==='갈퀴 꽃 씨앗 주머니')?.stock,completed:state.session.schedule.speed.flatMap(s=>s.trades).some(t=>t.completed),timers:state.session.timers}))"));
  if (!completionRestored.completed || completionRestored.stock !== finalStock || Object.keys(completionRestored.timers || {}).length) throw new Error(`completion did not persist exactly with timer reset: ${JSON.stringify(completionRestored)}`);
  await clickSelector("#open-schedule");
  await waitFor(async () => (await evaluate("document.querySelector('#schedule-dialog').open")) === true, "completed schedule after reload");
  const completedDom = JSON.parse(await evaluate("JSON.stringify({cards:document.querySelectorAll('#col-speed .sortie-card').length,routeRows:document.querySelectorAll('#col-speed .schedule-route li').length,completed:[...document.querySelectorAll('#col-speed .schedule-route li button')].some(button=>button.textContent.includes('완료됨')&&button.disabled),timerActive:[...document.querySelectorAll('#col-speed .schedule-route li button')].some(button=>button.textContent.includes('취소'))})"));
  if (!completedDom.cards || !completedDom.routeRows || !completedDom.completed || completedDom.timerActive) throw new Error(`completed trade was not rendered as completed in the browser DOM after restore: ${JSON.stringify(completedDom)}`);
  await clickSelector("#schedule-dialog [data-close-dialog]");

  await setTimer(evaluate, false);
  await clickSelector("#reset-session");
  await waitFor(async () => (await evaluate("document.querySelectorAll('.trade-row').length")) === 0 && (await evaluate("document.querySelector('#runtime-status').textContent"))?.includes("현재 회차를 초기화했습니다"), "explicit working-session reset");
  const afterReset = await requestJson("/api/bootstrap");
  if (afterReset.workingSession !== null || afterReset.inventory.find((item) => item.programName === "갈퀴 꽃 씨앗 주머니")?.stock !== finalStock || !afterReset.scheduleSlots["2"]) throw new Error("reset session removed durable inventory or a saved slot");
  await waitPersistenceIdle(evaluate);

  await clickSelector("#open-map-tools");
  await waitFor(async () => (await evaluate("document.querySelector('#map-tools-dialog').open")) === true, "map tools for viewer screenshot");
  await clickSelector("#viewer-root button");
  await waitFor(async () => (await evaluate("!!document.querySelector('.mv-window:modal')&&document.querySelectorAll('.mv-node').length>0")) === true, "actual map viewer");
  await selectOption('.mv-window:modal .mv-toolbar select.mv-select:nth-of-type(1)', "2");
  await waitFor(async () => (await evaluate("document.querySelector('.mv-window:modal .mv-toolbar select.mv-select:nth-of-type(1)')?.value")) === "2", "map viewer saved schedule slot 2 selection");
  await selectOption('.mv-window:modal .mv-toolbar select.mv-select:nth-of-type(2)', "balance");
  await waitFor(async () => (await evaluate("document.querySelector('.mv-window:modal .mv-toolbar select.mv-select:nth-of-type(2)')?.value")) === "balance", "map viewer balance mode selection");
  await selectOption('.mv-window:modal .mv-toolbar select.mv-select:nth-of-type(2)', "speed");
  await waitFor(async () => (await evaluate("document.querySelector('.mv-window:modal .mv-toolbar select.mv-select:nth-of-type(2)')?.value")) === "speed", "map viewer speed mode selection");
  await selectOption('.mv-window:modal .mv-toolbar select.mv-select:nth-of-type(3)', "0");
  const mapSelection = JSON.parse(await evaluate("JSON.stringify({slot:document.querySelector('.mv-window:modal .mv-toolbar select.mv-select:nth-of-type(1)')?.value,mode:document.querySelector('.mv-window:modal .mv-toolbar select.mv-select:nth-of-type(2)')?.value,trip:document.querySelector('.mv-window:modal .mv-toolbar select.mv-select:nth-of-type(3)')?.value,tripText:document.querySelector('.mv-window:modal .mv-toolbar select.mv-select:nth-of-type(3) option:checked')?.textContent})"));
  if (mapSelection.slot !== "2" || mapSelection.mode !== "speed" || !mapSelection.tripText?.includes("차 출항")) throw new Error(`map viewer slot/mode/sortie selection failed: ${JSON.stringify(mapSelection)}`);
  const loadButtonIndex = await evaluate("[...document.querySelectorAll('.mv-window:modal .mv-toolbar button')].findIndex(button=>button.textContent.includes('선택 출항 보기'))+1");
  if (loadButtonIndex < 1) throw new Error("map viewer did not render the selected-sortie route button");
  await clickSelector(`.mv-window:modal .mv-toolbar button:nth-of-type(${loadButtonIndex})`);
  const mapRoutes = JSON.parse(await evaluate("JSON.stringify({routeEdges:document.querySelectorAll('.mv-window:modal .mv-route').length,routeItems:document.querySelectorAll('.mv-window:modal #mv-routes-panel .mv-route-item').length,modeLabel:document.querySelector('.mv-window:modal .mv-mode-label')?.textContent,overview:document.querySelector('.mv-window:modal #mv-overview-panel .mv-panel-body')?.innerText})"));
  if (mapRoutes.routeEdges < 2 || !mapRoutes.modeLabel?.includes("저장 슬롯 2") || !mapRoutes.overview?.includes("저장 슬롯 2")) throw new Error(`saved-slot sortie did not render route and selected context in map viewer: ${JSON.stringify({mapSelection,mapRoutes})}`);
  const savedSlotMapScheduleView = { ...mapSelection, routeEdges: mapRoutes.routeEdges, modeLabel: mapRoutes.modeLabel, overview: mapRoutes.overview };
  const hideLabelsIndex = await evaluate("[...document.querySelectorAll('.mv-window:modal .mv-toolbar button')].findIndex(button=>button.textContent.trim()==='이름')+1");
  if (hideLabelsIndex < 1) throw new Error("map viewer label control was not rendered");
  await clickSelector(`.mv-window:modal .mv-toolbar button:nth-of-type(${hideLabelsIndex})`);
  const mapVisual = JSON.parse(await evaluate("JSON.stringify((()=>{const root=document.querySelector('.mv-window:modal'),workspace=root?.querySelector('.mv-workspace'),viewport=root?.querySelector('.mv-viewport'),v=viewport?.getBoundingClientRect(),routes=[...root.querySelectorAll('.mv-route')].map(path=>{const r=path.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,stroke:getComputedStyle(path).stroke,visibility:getComputedStyle(path).visibility}});return{workspaceDisplay:workspace?getComputedStyle(workspace).display:null,viewport:viewport&&v?{left:v.left,top:v.top,right:v.right,bottom:v.bottom,width:v.width,height:v.height,background:getComputedStyle(viewport).backgroundColor,visibility:getComputedStyle(viewport).visibility}:null,routePaths:routes,visibleRoutePaths:routes.filter(r=>r.visibility!=='hidden'&&r.stroke!=='none'&&r.width>0&&r.height>0&&r.right>v.left&&r.left<v.right&&r.bottom>v.top&&r.top<v.bottom).length,visibleNodeLabels:root.querySelectorAll('.mv-node-label').length}})())"));
  if (mapVisual.workspaceDisplay !== "grid" || !mapVisual.viewport || mapVisual.viewport.width <= 200 || mapVisual.viewport.height <= 200 || mapVisual.viewport.visibility === "hidden" || mapVisual.visibleRoutePaths < 1) throw new Error(`saved-slot map routes are present in state but not visibly laid out in the viewport: ${JSON.stringify({savedSlotMapScheduleView,mapVisual})}`);
  await screenshot("map130.png", send);
  const viewportErrors = browserErrors.slice();
  if (viewportErrors.length) throw new Error(`browser page errors: ${viewportErrors.join(" | ")}`);
  // Render the protected reference's initial UI without clicking its calculate
  // controls; block its only application API host before navigation.
  await send("Network.enable");
  await send("Network.setBlockedURLs", { urls: ["*generativelanguage.googleapis.com/*"] });
  await send("Emulation.setScriptExecutionDisabled", { value: false });
  const originalUrl = pathToFileURL(resolve(root, "inputs/ORIGINAL_v14_1.html")).href;
  await send("Page.navigate", { url: originalUrl });
  await waitFor(async () => await evaluate("document.readyState==='complete'&&location.href===`file:///${decodeURI(location.pathname).replace(/^\\//,'')}`&&document.querySelectorAll('#inventoryContainer .draggable-item').length>0"), "protected original initial UI");
  const originalState = JSON.parse(await evaluate("JSON.stringify({href:location.href,title:document.title,inventoryCards:document.querySelectorAll('#inventoryContainer .draggable-item').length,bodyBackground:getComputedStyle(document.body).backgroundColor,bodyText:document.body.innerText.slice(0,180)})"));
  if (!originalState.href.toLowerCase().endsWith("/inputs/original_v14_1.html") || !originalState.title || originalState.inventoryCards < 1 || originalState.bodyBackground === "rgba(0, 0, 0, 0)") throw new Error(`protected original initial UI failed visual preflight: ${JSON.stringify(originalState)}`);
  await send("DOM.enable");
  const { root: documentNode } = await send("DOM.getDocument", { depth: -1 });
  const { nodeId: bodyNodeId } = await send("DOM.querySelector", { nodeId: documentNode.nodeId, selector: "body" });
  if (!bodyNodeId) throw new Error("protected original HTML did not render a body for visual comparison");
  await send("DOM.setAttributeValue", { nodeId: bodyNodeId, name: "style", value: "zoom: 1.3; height: 76.923vh" });
  await screenshot("original130.png", send);
  const result = {
    ok: true,
    browser: "Chrome headless with CDP, 1920x1080",
    uiZoom: 130,
    emptyJsonDialog: true,
    inventoryAndShipPreset: true,
    workingSessionAcrossReloadAndProcessRestart: true,
    slotsIndependentAndAcrossRestart: true,
    modesTuningWaypointRouteCount: true,
    briefingDialogDragAndResize: briefingDialogInteraction,
    timerResetOnRestore: true,
    completionResponseLossExactBodyRetry: true,
    resetPreservedInventoryAndSlot: true,
    referencePngCaptured: true,
    referenceStyledVisualComparison: false,
    referenceCapture: "_dev/inputs/ORIGINAL_v14_1.html initial UI rendered at 1920x1080; calculate controls not clicked; generativelanguage.googleapis.com blocked; body zoom applied through CDP DOM only",
    referencePreflight: originalState,
    referenceVisualComparison: "Original PNG captured, but Tailwind CDN styles were unavailable in this browser run, so original remains a dark single-column default-HTML view and cannot validate the original two-column/compact-header layout.",
    savedSlotMapScheduleViewPass: true,
    mapRouteVisualScreenshotPass: true,
    mapVisual,
    savedSlotMapScheduleView,
    mainScreenshotPreflight: mainCapture,
    screenshots: ["main130.png", "briefing130.png", "tuning130.png", "map130.png", "original130.png"].map((name) => join(evidenceDir, name)),
    layout: mainLayout,
    pageErrors: browserErrors,
    database: "isolated temporary SQLite",
  };
  const resultJson = `${JSON.stringify(result, null, 2)}\n`;
  await writeFile(join(evidenceDir, "browser_restoration.json"), resultJson, "utf8");
  await writeFile(join(evidenceDir, "browser_restoration.log"), `SPEC-007 Chrome browser restoration validation\n${resultJson}`, "utf8");
  console.log(resultJson);
} finally {
  try { socket?.close(); } catch {}
  try { chrome?.kill(); } catch {}
  try { server?.kill(); } catch {}
  await delay(300);
  if (profile.startsWith(tmpdir())) await rm(profile, { recursive: true, force: true });
}

function startServer() {
  return spawn(pythonPath, ["-c", pythonCode], { stdio: "ignore", windowsHide: true, cwd: root });
}

async function stopServer() {
  if (!server) return;
  const child = server; server = null;
  child.kill();
  await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), delay(5000).then(() => { throw new Error("temporary server process did not exit"); })]);
}

async function waitForHealth(label) {
  return waitFor(async () => { try { const response = await fetch(`${baseUrl}api/health`, { signal: AbortSignal.timeout(1000) }); return response.ok; } catch { return false; } }, label, 30000);
}

async function requestJson(path) {
  const response = await fetch(`${baseUrl}${path.replace(/^\//, "")}`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

async function waitFor(predicate, label, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await predicate(); if (result) return result; await delay(100); }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitPersistenceIdle(evaluate) {
  await evaluate("import('/assets/js/persistence.js').then(({whenPersistenceIdle})=>whenPersistenceIdle())");
  await waitFor(async () => (await evaluate("import('/assets/js/state.js').then(({state})=>state.persistencePending===0)")) === true, "persistence queue idle");
}

async function verifyPersistentIdle(evaluate) {
  await waitPersistenceIdle(evaluate);
  const pending = await evaluate("import('/assets/js/state.js').then(({state})=>state.persistencePending)");
  if (pending !== 0) throw new Error(`persistencePending remains ${pending}`);
}

async function setValue(selector, value) {
  const literal = JSON.stringify(String(value));
  await activeEvaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});e.value=${literal};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
}

async function clickInputByLabel(label, value) {
  const expression = `(()=>{const e=[...document.querySelectorAll('input')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(label)});if(!e)throw Error('missing input '+${JSON.stringify(label)});e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`;
  await activeEvaluate(expression);
}

async function setNumberAndSave(selector, value, saveSelector) {
  await setValue(selector, value);
  await activeEvaluate(`document.querySelector(${JSON.stringify(saveSelector)})?.click()`);
}

async function saveSlot(evaluate, slot) {
  await evaluate(`(()=>{const s=document.querySelector('#selected-schedule-slot');s.value=${JSON.stringify(String(slot))};s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await clickSelector("#schedule-slot-controls button:nth-of-type(1)");
  await waitFor(async () => (await evaluate("document.querySelector('#schedule-status').textContent"))?.includes(`${slot}번 회차 스케줄을 저장했습니다`), `${slot} schedule slot save`);
  await waitPersistenceIdle(evaluate);
}

async function loadSlot(evaluate, slot) {
  await evaluate(`(()=>{const s=document.querySelector('#selected-schedule-slot');s.value=${JSON.stringify(String(slot))};s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await clickSelector("#schedule-slot-controls button:nth-of-type(2)");
  await waitFor(async () => (await evaluate("document.querySelector('#schedule-status').textContent"))?.includes(`${slot}번 스케줄 회차를 불러왔습니다`), `${slot} slot load`);
  await waitPersistenceIdle(evaluate);
}

async function deleteSlot(evaluate, slot) {
  await evaluate(`(()=>{const s=document.querySelector('#selected-schedule-slot');s.value=${JSON.stringify(String(slot))};s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await clickSelector("#schedule-slot-controls button:nth-of-type(3)");
  await waitFor(async () => (await evaluate("document.querySelector('#schedule-status').textContent"))?.includes(`${slot}번 슬롯을 삭제했습니다`), `${slot} slot delete`);
  await waitPersistenceIdle(evaluate);
}

async function clickRouteCountButton(evaluate, delta) {
  const info = await evaluate(`(()=>{const row=document.querySelector('#col-speed .schedule-route li');if(!row)throw Error('no speed route trade');const buttons=[...row.querySelectorAll('button')];return JSON.stringify({count:row.textContent,buttonCount:buttons.length,disabled:buttons.map(b=>b.disabled)})})()`);
  if (!JSON.parse(info).buttonCount) throw new Error(`route count controls missing: ${info}`);
  const before = await evaluate("import('/assets/js/state.js').then(({state})=>state.session.schedule.speed[0].trades.find(t=>!t.isWaypoint)?.execC)");
  const index = delta >= 0 ? 1 : 0;
  await clickSelector(`#col-speed .schedule-route li button:nth-of-type(${index + 1})`);
  await waitFor(async () => (await evaluate("import('/assets/js/state.js').then(({state})=>state.session.schedule.speed[0].trades.find(t=>!t.isWaypoint)?.execC)")) === before + Math.sign(delta), "manual route count update");
}

async function setTimer(evaluate, start) {
  const before = await evaluate("import('/assets/js/state.js').then(({state})=>Object.keys(state.session.timers||{}).length)");
  const rowIndex = await evaluate("[...document.querySelectorAll('#col-speed .schedule-route li')].findIndex(x=>x.querySelectorAll('button').length>=4)");
  if (rowIndex < 0) throw new Error("no speed trade timer controls");
  if (start || before) await clickSelector(`#col-speed .schedule-route li:nth-child(${rowIndex + 1}) button:nth-of-type(3)`);
  await waitFor(async () => (await evaluate("import('/assets/js/state.js').then(({state})=>Object.keys(state.session.timers||{}).length)")) === (start ? 1 : 0), start ? "active timer" : "timer stop");
}

async function clickFirstCompletion(evaluate) {
  const rowIndex = await evaluate("[...document.querySelectorAll('#col-speed .schedule-route li')].findIndex(x=>x.querySelectorAll('button').length>=4)");
  if (rowIndex < 0) throw new Error("completion route row not found");
  await clickSelector(`#col-speed .schedule-route li:nth-child(${rowIndex + 1}) button:nth-of-type(4)`);
}

async function clickSelector(selector) {
  const rect = JSON.parse(await activeEvaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing clickable '+${JSON.stringify(selector)});e.scrollIntoView({block:'center',inline:'nearest'});const r=e.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return JSON.stringify({x,y,width:r.width,height:r.height,hit:hit?.outerHTML?.slice(0,180),targeted:hit===e||e.contains(hit)})})()`));
  if (rect.width <= 0 || rect.height <= 0 || rect.x < 0 || rect.y < 0 || rect.x > 1920 || rect.y > 1080) throw new Error(`click target is outside visible viewport: ${selector} ${JSON.stringify(rect)}`);
  if (!rect.targeted) throw new Error(`browser hit-test is intercepted for ${selector}: ${JSON.stringify(rect)}`);
  await activeSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
  await activeSend("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await activeSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await delay(60);
}

async function selectOption(selector, value) {
  await clickSelector(selector);
  await activeEvaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing select '+${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await delay(80);
}

async function dragBySelector(selector, offsetX, offsetY, deltaX, deltaY) {
  const point = JSON.parse(await activeEvaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing drag target '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return JSON.stringify({x:r.left+${offsetX},y:r.top+${offsetY}})})()`));
  await activeSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await activeSend("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  for (let step = 1; step <= 4; step++) {
    await activeSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x + deltaX * step / 4, y: point.y + deltaY * step / 4, button: "left" });
    await delay(20);
  }
  await activeSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x + deltaX, y: point.y + deltaY, button: "left", clickCount: 1 });
  await delay(80);
}

async function dragResize(selector, deltaX, deltaY) {
  const point = JSON.parse(await activeEvaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing resize target '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return JSON.stringify({x:r.right-3,y:r.bottom-3})})()`));
  await activeSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await activeSend("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  for (let step = 1; step <= 4; step++) {
    await activeSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x + deltaX * step / 4, y: point.y + deltaY * step / 4, button: "left" });
    await delay(20);
  }
  await activeSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x + deltaX, y: point.y + deltaY, button: "left", clickCount: 1 });
  await delay(100);
}

async function screenshot(name, send) {
  const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  await writeFile(join(evidenceDir, name), Buffer.from(result.data, "base64"));
}

function assertInsideViewport(layout, target) {
  const panel = layout.panels.find((item) => item.s === "#mainPanel");
  if (!panel || panel.left < 0 || panel.top < 0 || panel.right > layout.viewport.w || panel.bottom > layout.viewport.h) throw new Error(`${target} overflows 1920x1080 at 130%: ${JSON.stringify(layout)}`);
  if (panel.overflowY === "visible" || panel.scrollHeight < panel.clientHeight) throw new Error(`${target} does not provide its own vertical scroll area: ${JSON.stringify(panel)}`);
  const session = layout.panels.find((item) => item.s === "#trade-session-panel");
  if (!session || session.left < 0 || session.top < 0 || session.right > layout.viewport.w || session.bottom > layout.viewport.h) throw new Error(`session panel overflows 1920x1080 at 130%: ${JSON.stringify(session)}`);
}

