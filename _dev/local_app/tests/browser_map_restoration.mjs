import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const port = 18772;
const baseUrl = `http://127.0.0.1:${port}/`;
const pythonPath = process.env.BDO_TEST_PYTHON ?? process.env.PYTHON ?? "python";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const evidenceDir = join(root, "specs", "007-feature-restoration", "evidence");
const profile = await mkdtemp(join(tmpdir(), "bdo-map-restoration-"));
const database = join(profile, "isolated-map.sqlite3");
const pythonPrelude = process.env.BDO_EXTRA_SITE_PACKAGES
  ? `import sys; p=${JSON.stringify(process.env.BDO_EXTRA_SITE_PACKAGES)}; sys.path.remove(p); sys.path.append(p); ` : "";
const pythonCode = `import sys; sys.path.insert(0, ${JSON.stringify(root)}); ${pythonPrelude}from local_app.backend.app import create_app; create_app(r'${database}', testing=True).run(host='127.0.0.1', port=${port}, use_reloader=False, threaded=True)`;
const checks = {};
const pageErrors = [];
let server, chrome, socket, send, evaluate;
let pending = new Map();
let nextId = 0;

try {
  await mkdir(evidenceDir, { recursive: true });
  if (await portIsBusy()) throw new Error(`Port ${port} is already in use; refusing to attach to another server.`);
  server = spawn(pythonPath, ["-c", pythonCode], { stdio: "ignore", windowsHide: true, cwd: root });
  await waitFor(async () => { try { return (await fetch(`${baseUrl}api/health`)).ok; } catch { return false; } }, "temporary local server", 30000);
  chrome = spawn(chromePath, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking", "--remote-debugging-port=0", "--remote-allow-origins=*", `--user-data-dir=${join(profile, "chrome-profile")}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  const portFile = join(profile, "chrome-profile", "DevToolsActivePort");
  const devtoolsPort = (await waitFor(async () => { try { return (await readFile(portFile, "utf8")).trim().split(/\r?\n/)[0]; } catch { return false; } }, "Chrome CDP port")).trim();
  const targetResponse = await fetch(`http://127.0.0.1:${devtoolsPort}/json/new?${encodeURIComponent(baseUrl)}`, { method: "PUT" });
  if (!targetResponse.ok) throw new Error(`Chrome target create failed: HTTP ${targetResponse.status}`);
  const target = await targetResponse.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await Promise.race([new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", reject, { once: true }); }), delay(10000).then(() => { throw new Error("Chrome CDP socket timeout"); })]);
  send = (method, params = {}) => new Promise((resolveCall, reject) => { const id = ++nextId; pending.set(id, { resolve: resolveCall, reject }); socket.send(JSON.stringify({ id, method, params })); });
  socket.addEventListener("message", event => {
    const msg = JSON.parse(event.data);
    if (msg.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
    if (msg.method === "Runtime.exceptionThrown") pageErrors.push(`${msg.params.exceptionDetails?.text} ${msg.params.exceptionDetails?.url}:${msg.params.exceptionDetails?.lineNumber}`);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") pageErrors.push(msg.params.args?.map(a => a.value ?? a.description).join(" "));
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
  });
  evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await waitFor(async () => (await evaluate("document.querySelectorAll('.inventory-row').length")) === 70, "app bootstrap");

  await click("#open-map-tools");
  await waitFor(async () => await evaluate("document.querySelector('#map-tools-dialog').open && !!document.querySelector('#map-root .mv-open-button')"), "map tools dialog");
  await setValue("#viewer-zoom", "130"); await click("#viewer-root .actions button");
  await waitFor(async () => await evaluate("document.documentElement.style.getPropertyValue('--app-zoom')==='1.3'"), "global 130% UI zoom");
  checks.zoom130 = "PASS";

  await click("#map-root .mv-open-button");
  await waitFor(async () => await evaluate("!!document.querySelector('.mv-window[open] .mv-viewport')"), "native map dialog");
  const modalHit = JSON.parse(await evaluate("(()=>{const d=document.querySelector('.mv-window'),r=d.getBoundingClientRect(),x=r.left+Math.min(100,r.width/2),y=r.top+20,e=document.elementFromPoint(x,y);return JSON.stringify({native:d instanceof HTMLDialogElement,open:d.open,topLayer:d.matches(':modal'),hit:e?.closest('.mv-window')===d,rect:{x:r.x,y:r.y,w:r.width,h:r.height}})})()"));
  if (!modalHit.native || !modalHit.open || !modalHit.topLayer || !modalHit.hit) throw new Error(`map dialog hit-test failed: ${JSON.stringify(modalHit)}`);
  checks.modalHitTest = "PASS";

  const zoomBefore = await evaluate("document.querySelector('.mv-zoom').textContent");
  await clickByText(".mv-toolbar button", "+");
  const zoomAfter = await evaluate("document.querySelector('.mv-zoom').textContent");
  if (zoomBefore === zoomAfter) throw new Error(`zoom button did not change map zoom (${zoomBefore})`);
  const panBefore = await evaluate("document.querySelector('.mv-svg > g:last-child').style.transform");
  await dragViewport(60, 30);
  const panAfter = await evaluate("document.querySelector('.mv-svg > g:last-child').style.transform");
  if (panBefore === panAfter) throw new Error("map pan did not change the map transform");
  checks.zoomPan = "PASS";

  const firstNode = await evaluate("(()=>{const n=[...document.querySelectorAll('.mv-node')].find(e=>{const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return r.width>0&&r.height>0&&x>=0&&y>=0&&x<innerWidth&&y<innerHeight&&document.elementFromPoint(x,y)?.closest('.mv-node')===e});if(!n)throw Error('no visible hit-testable map node');return n.querySelector('.mv-node-label')?.textContent})()");
  await clickNode(firstNode);
  if (!firstNode) throw new Error("map node selection did not identify a node");
  const selected = await evaluate("document.querySelector('.mv-node.selected .mv-node-label')?.textContent");
  if (selected !== firstNode) throw new Error(`node selection mismatch: ${selected} vs ${firstNode}`);
  await clickByText(".mv-toolbar button", "노드 이동");
  const original = JSON.parse(await evaluate(`JSON.stringify(window.islandCoordinates[${JSON.stringify(firstNode)}])`));
  await dragFirstNode(18, 15);
  await waitFor(async () => (await readBootstrapCoords(firstNode))?.x !== original.x, "node coordinate persisted to SQLite");
  const moved = await readBootstrapCoords(firstNode);
  await clickByText(".mv-toolbar button", "되돌리기");
  await waitFor(async () => { const c = await readBootstrapCoords(firstNode); return c?.x === original.x && c?.y === original.y; }, "node undo persisted");
  checks.nodeDragAndUndo = { status: "PASS", node: firstNode, original, moved, restored: await readBootstrapCoords(firstNode) };

  await evaluate("window.__mapRealScheduleRuntime=window.__bdoScheduleRuntime;window.__bdoScheduleRuntime=Object.create(window.__mapRealScheduleRuntime);Object.defineProperty(window.__bdoScheduleRuntime,'pending',{value:{test:true},configurable:true})");
  await dragFirstNode(24, 18);
  await delay(250);
  const blockedMemory = JSON.parse(await evaluate(`JSON.stringify(window.islandCoordinates[${JSON.stringify(firstNode)}])`));
  const blockedDatabase = await readBootstrapCoords(firstNode);
  await evaluate("window.__bdoScheduleRuntime=window.__mapRealScheduleRuntime;delete window.__mapRealScheduleRuntime");
  if (blockedMemory.x !== original.x || blockedMemory.y !== original.y || blockedDatabase.x !== original.x || blockedDatabase.y !== original.y) throw new Error(`pending completion allowed a map coordinate mutation: ${JSON.stringify({blockedMemory,blockedDatabase,original})}`);
  checks.pendingCompletionGuard = { status: "PASS", memoryUnchanged: true, sqliteUnchanged: true };

  await dragFirstNode(14, 10);
  await waitFor(async () => (await readBootstrapCoords(firstNode))?.x !== original.x, "temporary node move before reset");
  await clickByText("#mv-nodes-panel button", "원좌표");
  await waitFor(async () => { const c=await readBootstrapCoords(firstNode);return c?.x===original.x&&c?.y===original.y; }, "node reset to original coordinates");
  checks.coordinateReset = "PASS";

  await clickByText(".mv-toolbar button", "거리 측정");
  const nodes = await evaluate("JSON.stringify([...document.querySelectorAll('.mv-node')].filter(e=>{const r=e.querySelector('circle').getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return r.width>0&&x>=0&&y>=0&&x<innerWidth&&y<innerHeight&&document.elementFromPoint(x,y)?.closest('.mv-node')===e}).slice(0,2).map(e=>e.querySelector('.mv-node-label')?.textContent))");
  const pair = JSON.parse(nodes);
  if (pair.length < 2) throw new Error("two visible nodes required for route measurement");
  await clickNode(pair[0]); await clickNode(pair[1]);
  await waitFor(async () => await evaluate("document.querySelectorAll('.mv-route-item').length>0"), "measured route in route panel");
  const rawRoute = JSON.parse(await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify(state.mapRouteDraft))"));
  if (!rawRoute.length) throw new Error("measurement did not create an in-memory map route");
  const routeRow = "#mv-routes-panel .mv-route-item";
  await evaluate("window.__mapPromptValues=['240']");
  await evaluate("window.prompt=()=>window.__mapPromptValues.shift()??null");
  await click(`${routeRow} button`);
  await waitFor(async () => Object.keys(await readCalibrations()).length > 0, "directional route calibration saved");
  const calibration = await readCalibrations();
  const customRoutes = JSON.parse(await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify(state.mapRouteDraft))"));
  const customRoute = customRoutes.find(route=>route.start===rawRoute[0].start&&route.end===rawRoute[0].end);
  if (customRoute?.customSeconds !== 240) throw new Error(`route customSeconds was not retained in the snapshot model: ${JSON.stringify(customRoutes)}`);
  const expectedMultiplier=await evaluate(`import('/assets/js/state.js').then(({state})=>{const a=window.islandCoordinates[${JSON.stringify(rawRoute[0].start)}],b=window.islandCoordinates[${JSON.stringify(rawRoute[0].end)}],speed=Number(state.session.config?.ship?.speed||state.settings.ship?.speed||window.APP_CONFIG?.SHIP_SPEED||170),raw=Math.hypot(b.x-a.x,b.y-a.y),base=Math.round(raw/speed*60);return 240/base})`);
  const actualMultiplier=calibration[`${rawRoute[0].start}_${rawRoute[0].end}`]?.multiplier;
  if(!Number.isFinite(actualMultiplier)||Math.abs(actualMultiplier-expectedMultiplier)>1e-9)throw new Error(`calibration multiplier differs from original rounded raw-straight-time denominator: ${actualMultiplier} vs ${expectedMultiplier}`);
  checks.measurementAndCalibration = { status: "PASS", routeCount: rawRoute.length, customSeconds: customRoute.customSeconds, actualMultiplier, expectedMultiplier };

  await clickByText(".mv-toolbar button", "같은 거리 이동");
  await clickNode(pair[0]); await clickNode(pair[1]);
  await waitFor(async()=>await evaluate("document.querySelector('.mv-mode-info')?.textContent.includes('선택 노드를 끌기')"),"arc move setup");
  const arcBefore=JSON.parse(await evaluate(`import('/assets/js/state.js').then(({state})=>JSON.stringify({a:window.islandCoordinates[${JSON.stringify(pair[0])}],b:window.islandCoordinates[${JSON.stringify(pair[1])}]}))`));
  await dragNode(pair[1], 18, 12);
  await waitFor(async()=>JSON.stringify(await readBootstrapCoords(pair[1]))!==JSON.stringify(arcBefore.b),"arc movement saved");
  const arcAfter=JSON.parse(await evaluate(`import('/assets/js/state.js').then(({state})=>JSON.stringify({a:window.islandCoordinates[${JSON.stringify(pair[0])}],b:window.islandCoordinates[${JSON.stringify(pair[1])}]}))`));
  const beforeRadius=Math.hypot(arcBefore.a.x-arcBefore.b.x,arcBefore.a.y-arcBefore.b.y),afterRadius=Math.hypot(arcAfter.a.x-arcAfter.b.x,arcAfter.a.y-arcAfter.b.y);
  if(Math.abs(beforeRadius-afterRadius)>2)throw new Error(`arc move changed its radius: ${beforeRadius} -> ${afterRadius}`);
  await clickByText(".mv-toolbar button", "되돌리기");
  checks.arcMove = { status: "PASS", beforeRadius, afterRadius };

  await evaluate("window.__mapPromptValues=['Test Harbor','Test Island','map restoration note']");
  await evaluate("window.prompt=()=>window.__mapPromptValues.shift()??null");
  await clickByText("#mv-memos-panel button", "메모 추가");
  await waitFor(async () => (await evaluate("document.querySelector('#mv-memos-panel')?.innerText.includes('map restoration note')")), "memo saved");
  await evaluate("window.__mapPromptValues=['Test Harbor','Test Island','edited restoration note']");
  await evaluate("window.prompt=()=>window.__mapPromptValues.shift()??null");
  await clickByText("#mv-memos-panel button", "수정");
  await waitFor(async () => await evaluate("document.querySelector('#mv-memos-panel')?.innerText.includes('edited restoration note')"), "memo edit saved");
  await clickByText("#mv-memos-panel button", "삭제");
  await waitFor(async () => !(await evaluate("document.querySelector('#mv-memos-panel')?.innerText.includes('edited restoration note')")), "memo delete saved");
  checks.memo = "PASS: add, edit, delete";

  await evaluate("window.confirm=()=>true");
  await clickByText("#mv-slots-panel .mv-row button", "저장");
  await waitFor(async () => (await readMapSlot("1"))?.routes?.length > 0, "map slot saved");
  await clickByText("#mv-slots-panel .mv-row button", "불러오기");
  await waitFor(async () => await evaluate("document.querySelector('.mv-mode-label')?.textContent"), "map slot loaded");
  await clickByText("#mv-slots-panel button", "기본 지도 저장");
  await waitFor(async () => (await readMapBase())?.routes?.length > 0, "base map saved");
  await clickByText("#mv-slots-panel button", "기본 지도 불러오기");
  await waitFor(async () => await evaluate("document.querySelector('.mv-window[open] .mv-viewport')"), "base map loaded");
  checks.mapSlotAndBase = "PASS";

  const panel = await evaluate("(()=>{const p=document.querySelector('#mv-overview-panel');return JSON.stringify({left:p.offsetLeft,top:p.offsetTop,width:p.offsetWidth,height:p.offsetHeight})})()");
  const resized = await resizePanel("#mv-overview-panel", 32, 24);
  if(resized.before.width===resized.after.width&&resized.before.height===resized.after.height)throw new Error(`explicit resize handle did not change panel geometry: ${JSON.stringify(resized)}`);
  await movePanel("#mv-overview-panel .mv-panel-head", 24, 18);
  await click("#mv-overview-panel .mv-panel-head button");
  if(!await evaluate("document.querySelector('#mv-overview-panel').classList.contains('collapsed')"))throw new Error("overview panel did not collapse");
  await clickByText(".mv-toolbar button", "패널 저장");
  await waitFor(async () => !!(await readViewerPanels())?.mainPanel, "panel layout persisted");
  await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }).then(async shot => await writeFile(join(evidenceDir, "map-edit130.png"), Buffer.from(shot.data, "base64")));
  const savedPanel = (await readViewerPanels()).mainPanel;
  await click(".mv-header button");
  await click("#map-tools-dialog [data-close-dialog]");
  await waitFor(async () => await evaluate("!document.querySelector('#map-tools-dialog').open"), "map tools close");
  await reloadPage("page reload after layout save");

  const beforeRestart = await readViewerPanels();
  if (!beforeRestart?.mainPanel || JSON.stringify(beforeRestart.mainPanel) !== JSON.stringify(savedPanel)) throw new Error(`panel layout did not survive browser reload: ${JSON.stringify({savedPanel,beforeRestart})}`);
  await stopServer();
  server = spawn(pythonPath, ["-c", pythonCode], { stdio: "ignore", windowsHide: true, cwd: root });
  await waitFor(async () => { try { return (await fetch(`${baseUrl}api/health`)).ok; } catch { return false; } }, "same temporary database after backend restart", 30000);
  await reloadPage("app after backend restart");
  const afterRestart = await readViewerPanels();
  if (!afterRestart?.mainPanel || JSON.stringify(afterRestart.mainPanel) !== JSON.stringify(savedPanel)) throw new Error(`panel layout did not survive process restart: ${JSON.stringify({savedPanel,afterRestart})}`);
  await click("#open-map-tools"); await waitFor(async () => await evaluate("document.querySelector('#map-tools-dialog').open"), "map tools after process restart"); await click("#map-root .mv-open-button");
  await waitFor(async () => await evaluate("!!document.querySelector('.mv-window[open]')"), "map viewer after process restart");
  await clickByText("#mv-slots-panel .mv-row button", "불러오기");
  await waitFor(async()=>await evaluate("import('/assets/js/state.js').then(({state})=>state.mapRouteDraft?.some(route=>route.customSeconds===240))"),"slot restores route customSeconds");
  const restoredPanel = JSON.parse(await evaluate("(()=>{const p=document.querySelector('#mv-overview-panel');return JSON.stringify({left:p.offsetLeft,top:p.offsetTop,width:p.offsetWidth,height:p.offsetHeight,collapsed:p.classList.contains('collapsed'),expandedHeight:p.dataset.expandedHeight})})()"));
  if (restoredPanel.left !== savedPanel.left || restoredPanel.top !== savedPanel.top || restoredPanel.width !== savedPanel.width || Number(restoredPanel.expandedHeight) !== savedPanel.height || !restoredPanel.collapsed || !savedPanel.collapsed) throw new Error(`panel geometry/collapse failed actual viewer restoration: ${JSON.stringify({savedPanel,restoredPanel})}`);
  await click("#mv-overview-panel .mv-panel-head button");
  const expandedHeight=await evaluate("document.querySelector('#mv-overview-panel').offsetHeight");
  if(expandedHeight!==savedPanel.height)throw new Error(`expanded panel height was not restored: ${JSON.stringify({saved:savedPanel.height,actual:expandedHeight})}`);
  checks.panelPersistenceAndProcessRestore = { status: "PASS", before: JSON.parse(panel), resized, saved: savedPanel, restored: restoredPanel, expandedHeight };

  const downloadDir = join(profile, "downloads"); await mkdir(downloadDir, { recursive: true });
  await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
  await clickByText(".mv-toolbar button", "JSON 내보내기");
  const exportPath = join(downloadDir, "bdo-map.json");
  const exported = await waitFor(async () => { try { return await readFile(exportPath, "utf8"); } catch { return false; } }, "map-only JSON download");
  const containsReplacementCode = exported.includes("REPLACEMENT_CODE");
  if (containsReplacementCode) throw new Error("map-only JSON included REPLACEMENT_CODE");
  const importPayload=JSON.parse(exported);
  const baselineRoutes=JSON.parse(await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify(state.mapRouteDraft))"));
  const baselineCoords=await readBootstrapCoords(firstNode);
  const invalidImport=structuredClone(importPayload);invalidImport.snapshot.coords.__invalidProbe={x:9999999999999999,y:1};
  await setImportFile(invalidImport);
  await waitFor(async()=>await evaluate("document.querySelector('#runtime-status')?.textContent.includes('지도 JSON 불러오기 실패')"),"invalid map import rejected");
  const routesAfterInvalid=JSON.parse(await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify(state.mapRouteDraft))"));
  const coordsAfterInvalid=await readBootstrapCoords(firstNode);
  if(JSON.stringify(routesAfterInvalid)!==JSON.stringify(baselineRoutes)||JSON.stringify(coordsAfterInvalid)!==JSON.stringify(baselineCoords))throw new Error("invalid map import changed the existing route/coordinate state");
  importPayload.snapshot.routeCalibrations.__mapImportProbe={multiplier:1.234,REPLACEMENT_CODE:"must be stripped"};
  await setImportFile(importPayload);
  await waitFor(async()=>await evaluate("document.querySelector('#runtime-status')?.textContent.includes('지도 전용 JSON을 불러왔습니다')"),"map-only JSON import");
  const importedCalibrations=await readCalibrations();
  const importedRoutes=JSON.parse(await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify(state.mapRouteDraft))"));
  if(importedCalibrations.__mapImportProbe?.multiplier!==1.234||"REPLACEMENT_CODE" in (importedCalibrations.__mapImportProbe||{})||!importedRoutes.some(route=>route.customSeconds===240))throw new Error("map JSON import did not round-trip custom route and strip REPLACEMENT_CODE");
  checks.mapOnlyJson = { status: "PASS", invalidImportPreservedPriorMap: true, replacementCodeIncluded: false, importRoundTrip: true, importStrippedReplacementCode: true, customSeconds: 240, snapshotKind: JSON.parse(exported).kind };

  await click(".mv-header button"); await click("#map-tools-dialog [data-close-dialog]"); await click("#open-schedule");
  await waitFor(async()=>await evaluate("document.querySelector('#schedule-dialog').open&&!!document.querySelector('#free-route-root .mv-free-route')"),"schedule free-route host");
  await setValue("#free-route-root input:nth-of-type(1)",pair[0]);await setValue("#free-route-root input:nth-of-type(2)",pair[1]);
  const freeResult=await evaluate("document.querySelector('#free-route-root .mv-free-result').textContent");
  if(!freeResult.includes('거리'))throw new Error(`free route did not calculate distance and time: ${freeResult}`);
  await setValue("#free-route-root input:nth-of-type(1)","");
  if(await evaluate("document.querySelector('#free-route-root .mv-free-result').textContent")!=="섬 이름을 선택하세요.")throw new Error("empty free-route start silently fell back to an unrelated island");
  await clickByText("#free-route-root .mv-free-actions button","출항");
  if(await evaluate("document.querySelector('#free-route-root .mv-free-actions button').textContent")!=="출항")throw new Error("free-route departure accepted an empty start island");
  await setValue("#free-route-root input:nth-of-type(1)",pair[0].slice(0,1));
  if(await evaluate("document.querySelector('#free-route-root .mv-free-result').textContent")!=="섬 이름을 선택하세요.")throw new Error("partial free-route island name silently selected a different island");
  await clickByText("#free-route-root .mv-free-actions button","출항");
  if(await evaluate("document.querySelector('#free-route-root .mv-free-actions button').textContent")!=="출항")throw new Error("free-route departure accepted a partial island name");
  await setValue("#free-route-root input:nth-of-type(1)",pair[0]);
  const timersBefore=JSON.parse(await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify(state.session.timers||{}))"));
  await clickByText("#free-route-root .mv-free-actions button","출항");
  if(await evaluate("document.querySelector('#free-route-root .mv-free-actions button').textContent")!=="취소")throw new Error("free route departure did not start transient timer");
  await evaluate("window.dispatchEvent(new Event('bdo:timers-reset'))");
  if(await evaluate("document.querySelector('#free-route-root .mv-free-actions button').textContent")!=="출항")throw new Error("free route did not reset when the session timer-reset event fired");
  await clickByText("#free-route-root .mv-free-actions button","출항");
  await clickByText("#free-route-root .mv-free-actions button","취소");
  if(await evaluate("document.querySelector('#free-route-root .mv-free-actions button').textContent")!=="출항")throw new Error("free route cancel did not stop timer");
  const timersAfter=JSON.parse(await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify(state.session.timers||{}))"));
  if(JSON.stringify(timersBefore)!==JSON.stringify(timersAfter))throw new Error("free route timer changed the persistent session timer model");
  checks.freeRouteTimer="PASS: computed duration, departed, reset event, cancelled without session persistence";

  checks.pageErrors = pageErrors;
  checks.pythonRuntime = await pythonRuntimeSummary();
  checks.database = "isolated temporary SQLite; backend restarted against same DB";
  checks.browser = "Chrome CDP, 1920x1080, UI zoom 130%";
  checks.unrun = ["free-route alarm audio (audible output)", "mobile viewport", "original BDO HTML UI comparison"];
  checks.ok = Object.values(checks).every(v => typeof v !== "object" || v?.status !== "FAIL") && !pageErrors.length;
  if (pageErrors.length) throw new Error(`browser reported page errors: ${pageErrors.join(" | ")}`);
} catch (error) {
  checks.ok = false; checks.failure = error?.stack ?? String(error); checks.pageErrors = pageErrors;
} finally {
  try { socket?.close(); } catch {}
  try { chrome?.kill(); } catch {}
  await stopServer().catch(() => {});
  await delay(800);
  const resultPath = join(evidenceDir, "map-restoration-results.json");
  await mkdir(evidenceDir, { recursive: true }).catch(() => {});
  await writeFile(resultPath, JSON.stringify({ ...checks, port, temporaryDatabase: true }, null, 2), "utf8");
  if (profile.startsWith(tmpdir())) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(error => { checks.cleanupWarning = error.message; });
}
console.log(JSON.stringify(checks, null, 2));
if (!checks.ok) process.exitCode = 1;

async function click(selector) {
  const point = JSON.parse(await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return JSON.stringify({x,y,w:r.width,h:r.height,hit:h===e||e.contains(h),tag:h?.tagName,cls:h?.className?.baseVal||h?.className})})()`));
  if (!point.hit || point.w <= 0 || point.h <= 0) throw new Error(`actual click hit-test failed for ${selector}: ${JSON.stringify(point)}`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }); await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 }); await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 }); await delay(120);
}
async function clickByText(selector, text) {
  const selectorJson = JSON.stringify(selector), textJson = JSON.stringify(text);
  const actual = await evaluate(`(()=>{const e=[...document.querySelectorAll(${selectorJson})].find(x=>x.textContent.trim()===${textJson});if(!e)throw Error('missing button '+${textJson});return e.matches('button')?${selectorJson}+':has-text-placeholder':e.outerHTML})()`);
  if (typeof actual !== "string") throw new Error(`button lookup failed: ${text}`);
  const point = JSON.parse(await evaluate(`(()=>{const e=[...document.querySelectorAll(${selectorJson})].find(x=>x.textContent.trim()===${textJson});if(!e)throw Error('missing '+${textJson});e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return JSON.stringify({x,y,w:r.width,h:r.height,hit:h===e||e.contains(h)})})()`));
  if (!point.hit) throw new Error(`text button hit-test failed for ${text}`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }); await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 }); await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 }); await delay(140);
}
async function setValue(selector, value) { await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`); }
async function setImportFile(value) { await evaluate(`(()=>{const i=document.querySelector('.mv-toolbar input[type=file]'),d=new DataTransfer();d.items.add(new File([${JSON.stringify(JSON.stringify(value))}],'map-import.json',{type:'application/json'}));i.files=d.files;i.dispatchEvent(new Event('change',{bubbles:true}))})()`); }
async function dragViewport(dx,dy) { const r=JSON.parse(await evaluate("(()=>{const r=document.querySelector('.mv-viewport').getBoundingClientRect();return JSON.stringify({x:r.left+r.width*.78,y:r.top+r.height*.76})})()"));await mouseDrag(r.x,r.y,r.x+dx,r.y+dy); }
async function dragFirstNode(dx,dy) { const r=JSON.parse(await evaluate("(()=>{const r=document.querySelector('.mv-node.selected circle').getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2})})()"));await mouseDrag(r.x,r.y,r.x+dx,r.y+dy); }
async function dragNode(name,dx,dy) { const n=JSON.stringify(name),r=JSON.parse(await evaluate(`(()=>{const e=[...document.querySelectorAll('.mv-node')].find(x=>x.querySelector('.mv-node-label')?.textContent===${n}),r=e.querySelector('circle').getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2})})()`));await mouseDrag(r.x,r.y,r.x+dx,r.y+dy); }
async function clickNode(name) { const n=JSON.stringify(name),p=JSON.parse(await evaluate(`(()=>{const e=[...document.querySelectorAll('.mv-node')].find(x=>x.querySelector('.mv-node-label')?.textContent===${n});if(!e)throw Error('missing node '+${n});const r=e.querySelector('circle').getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return JSON.stringify({x,y,visible:r.width>0&&r.height>0&&x>=0&&y>=0&&x<innerWidth&&y<innerHeight,hit:h?.closest('.mv-node')===e})})()`));if(!p.visible||!p.hit)throw Error(`node hit-test failed for ${name}: ${JSON.stringify(p)}`);await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:p.x,y:p.y});await send("Input.dispatchMouseEvent",{type:"mousePressed",x:p.x,y:p.y,button:"left",clickCount:1});await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:p.x,y:p.y,button:"left",clickCount:1});await delay(100); }
async function mouseDrag(x,y,x2,y2) { await send("Input.dispatchMouseEvent",{type:"mouseMoved",x,y});await send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1});for(let i=1;i<=5;i++){await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:x+(x2-x)*i/5,y:y+(y2-y)*i/5,buttons:1});}await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:x2,y:y2,button:"left",clickCount:1});await delay(250); }
async function movePanel(selector,dx,dy) { const r=JSON.parse(await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2})})()`));await mouseDrag(r.x,r.y,r.x+dx,r.y+dy); }
async function resizePanel(selector,dx,dy) { const r=JSON.parse(await evaluate(`(()=>{const p=document.querySelector(${JSON.stringify(selector)}),g=p.querySelector('.mv-resize-handle'),b=g.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2,h=document.elementFromPoint(x,y),s=getComputedStyle(g),ps=getComputedStyle(p);return JSON.stringify({x,y,before:{width:p.offsetWidth,height:p.offsetHeight,clientWidth:p.clientWidth,clientHeight:p.clientHeight},panelOverflow:ps.overflow,bodyOverflow:getComputedStyle(p.querySelector('.mv-panel-body')).overflow,handleRect:{x:b.x,y:b.y,w:b.width,h:b.height,display:s.display,position:s.position,z:s.zIndex,pointerEvents:s.pointerEvents},hit:h===g||g.contains(h),hitTag:h?.tagName,hitId:h?.id,hitClass:h?.className})})()`));if(!r.hit)throw new Error(`resize handle hit-test was intercepted: ${JSON.stringify(r)}`);await mouseDrag(r.x,r.y,r.x+dx,r.y+dy);const after=JSON.parse(await evaluate(`(()=>{const p=document.querySelector(${JSON.stringify(selector)});return JSON.stringify({width:p.offsetWidth,height:p.offsetHeight})})()`));return{before:r.before,after,handleRect:r.handleRect,hit:{tag:r.hitTag,id:r.hitId,class:r.hitClass}}; }
async function readBootstrapCoords(name) { const body=await (await fetch(`${baseUrl}api/bootstrap`)).json();return body.settings?.navigation?.coords?.[name]??null; }
async function readCalibrations() { const body=await (await fetch(`${baseUrl}api/bootstrap`)).json();return body.settings?.navigation?.routeCalibrations??{}; }
async function readMapSlot(key) { const body=await (await fetch(`${baseUrl}api/bootstrap`)).json();return body.settings?.mapSlots?.[key]??null; }
async function readMapBase() { const body=await (await fetch(`${baseUrl}api/bootstrap`)).json();return body.settings?.mapBase??null; }
async function readViewerPanels() { const body=await (await fetch(`${baseUrl}api/bootstrap`)).json();return body.settings?.viewer?.panels??{}; }
async function pythonRuntimeSummary() { const { spawnSync }=await import("node:child_process");const p=spawnSync(pythonPath,["-c","import sys,importlib.util;print(sys.version.split()[0]);print('Pillow='+str(bool(importlib.util.find_spec('PIL'))))"],{encoding:"utf8",cwd:root,windowsHide:true});return p.status===0?p.stdout.trim().replace(/\r/g,"").split("\n"):p.error?.message??p.stderr; }
async function portIsBusy() { try { return (await fetch(`${baseUrl}api/health`,{signal:AbortSignal.timeout(500)})).ok; } catch { return false; } }
async function waitFor(predicate,label,timeout=20000) { const until=Date.now()+timeout;while(Date.now()<until){const result=await predicate();if(result)return result;await delay(120);}throw new Error(`Timed out waiting for ${label}`); }
async function reloadPage(label) { const marker=crypto.randomUUID();await evaluate(`window.__mapReloadMarker=${JSON.stringify(marker)}`);await send("Page.reload",{ignoreCache:true});await waitFor(async()=>await evaluate(`window.__mapReloadMarker!==${JSON.stringify(marker)}&&document.readyState==='complete'&&document.querySelectorAll('.inventory-row').length===70&&document.querySelector('#app-content')?.getAttribute('aria-busy')==='false'`),label,30000); }
async function stopServer() { if(!server)return;const child=server;server=null;child.kill();await Promise.race([new Promise(resolveExit=>child.once("exit",resolveExit)),delay(5000)]); }
