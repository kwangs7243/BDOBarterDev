import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = process.env.BDO_TEST_URL ?? "http://127.0.0.1:18768/";
const python = process.env.PYTHON ?? "python";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-spec005-browser-"));
const database = join(profile, "isolated.sqlite3");
const sitePackages = process.env.BDO_EXTRA_SITE_PACKAGES;
const pythonPrelude = sitePackages ? `import sys; p=${JSON.stringify(sitePackages)}; sys.path.remove(p); sys.path.append(p); ` : "";
const pythonCode = `${pythonPrelude}from local_app.backend.app import create_app; create_app(r'${database}', testing=True).run(host='127.0.0.1', port=18768, use_reloader=False, threaded=True)`;
let server = spawn(python, ["-c", pythonCode], { stdio: "ignore", windowsHide: true, cwd: root });
let chrome; let socket;
try {
  await waitFor(async () => { try { return (await fetch(`${baseUrl}api/health`)).ok; } catch { return false; } }, "isolated local server");
  chrome = spawn(chromePath, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking", "--remote-debugging-port=0", "--remote-allow-origins=*", `--user-data-dir=${join(profile, "chrome-profile")}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  const portText = await waitFor(async () => { try { return await readFile(join(profile, "chrome-profile", "DevToolsActivePort"), "utf8"); } catch { return false; } }, "Chrome DevTools");
  const debugPort = portText.trim().split(/\r?\n/)[0];
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(baseUrl)}`, { method: "PUT" });
  if (!response.ok) throw new Error(`Chrome target create failed: ${response.status}`);
  const target = await response.json(); socket = new WebSocket(target.webSocketDebuggerUrl);
  await Promise.race([new Promise((ok, fail) => { socket.addEventListener("open", ok, { once: true }); socket.addEventListener("error", fail, { once: true }); }), delay(10000).then(() => { throw new Error("DevTools connection timed out"); })]);
  const pending = new Map(); let nextId = 0;
  const send = (method, params = {}) => new Promise((ok, fail) => { const id = ++nextId; pending.set(id, { ok, fail }); socket.send(JSON.stringify({ id, method, params })); });
  socket.addEventListener("message", (event) => { const message = JSON.parse(event.data); if (message.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {}); if (message.id && pending.has(message.id)) { const item = pending.get(message.id); pending.delete(message.id); message.error ? item.fail(new Error(message.error.message)) : item.ok(message.result); } });
  const evaluate = async (expression) => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value; };
  await send("Page.enable"); await send("Runtime.enable");
  await waitFor(async () => (await evaluate("document.querySelectorAll('.inventory-row').length")) === 70, "new app loaded");

  const seeded = await evaluate(`(async()=>{const s=await fetch('/api/bootstrap').then(r=>r.json()); const items=Object.fromEntries(s.inventory.map(i=>[i.programName,{stock:i.programName==='갈퀴 꽃 씨앗 주머니'?100:0,target:i.target}])); const r=await fetch('/api/inventory',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({mutationId:'spec005-seed',baseRevision:s.revision,kind:'manual',patch:{items}})}); if(!r.ok)throw Error(await r.text()); return fetch('/api/bootstrap').then(r=>r.json()).then(x=>({revision:x.revision,from:x.inventory.find(i=>i.programName==='갈퀴 꽃 씨앗 주머니').stock,to:x.inventory.find(i=>i.programName==='괴생물 촉수').stock}));})()`);
  if (seeded.from !== 100 || seeded.to !== 0) throw new Error(`test inventory seed mismatch ${JSON.stringify(seeded)}`);
  await evaluate(`import('/assets/js/persistence.js').then(async({refreshPersistentState})=>{await refreshPersistentState();return import('/assets/js/state.js')}).then(({state})=>{state.session.scannedTrades=[{island:'베이루와 섬',fromItem:'갈퀴 꽃 씨앗 주머니',toItem:'괴생물 촉수',reqAmount:1,count:3,yield:3,deleted:false,disabled:false}];state.session.remainingParley=1500000})`);
  await evaluate("document.querySelector('#generate-schedule').click()");
  await delay(800);
  const cardCount = await evaluate("document.querySelectorAll('.sortie-card').length");
  if (!cardCount) throw new Error(`algorithm did not generate a sortie: ${await evaluate("JSON.stringify({status:document.querySelector('#schedule-status').textContent, app:document.querySelector('#runtime-status').textContent, session:window.__bdoAppState.session.diagnostics, config:window.APP_CONFIG.ALLOW_OCEAN})")}`);
  const generated = await evaluate(`import('/assets/js/state.js').then(({state})=>JSON.stringify({speed:state.session.schedule.speed.length,balance:state.session.schedule.balance.length,mode:state.session.diagnostics.mode,route:state.session.schedule.speed[0]?.trades.length}))`);
  const generatedState = JSON.parse(generated);
  if (!generatedState.speed || !generatedState.balance || generatedState.mode !== "inner") throw new Error(`unexpected schedule output ${generated}`);

  const summaryExpression = `const pack=xs=>xs.map(s=>({parleyUsed:s.parleyUsed,totalTime:s.totalTime,startWeight:s.startWeight,returnTime:s.returnTime,returnOver:s.returnOver,reqItems:s.reqItems,trades:s.trades.map(t=>({island:t.island,fromClean:t.fromClean,toClean:t.toClean,execC:t.execC,reqA:t.reqA,mult:t.mult,afterW:t.afterW,estT:t.estT,over:t.over,toTier:t.toTier,fromTier:t.fromTier,isCoin:t.isCoin,isSpec:t.isSpec,isRandomCoin:t.isRandomCoin,score:t.score,lack:t.lack}))}));`;
  const appResult = await evaluate(`import('/assets/js/state.js').then(({state})=>{${summaryExpression}return JSON.stringify({speed:pack(state.session.schedule.speed),balance:pack(state.session.schedule.balance)})})`);
  const baseline = JSON.parse(await readFile(resolve(root, "local_app/tests/fixtures/scheduler-expected.json"), "utf8"));
  const referenceResult = JSON.stringify(baseline.scenarios.initial);
  if (appResult !== referenceResult) throw new Error(`same-input reference result mismatch. app=${appResult} reference=${referenceResult}`);

  async function compareScenario(mode, trade, label) {
    const encodedTrade = JSON.stringify(JSON.stringify(Array.isArray(trade) ? trade : [trade]));
    const app = await evaluate(`import('/assets/js/state.js').then(({state})=>{state.settings.ship.mode=${JSON.stringify(mode)};if(state.session.config)state.session.config.ship.mode=${JSON.stringify(mode)};state.session.scannedTrades=JSON.parse(${encodedTrade});state.session.schedule=null;state.session.remainingParley=1500000;if(${JSON.stringify(label)}==='tier-7 scenario')state.inventory.find(i=>i.programName==='정체불명의 암석').stock=100;window.__bdoScheduleRuntime.generateSchedule(state,()=>{});${summaryExpression}return JSON.stringify({speed:pack(state.session.schedule.speed),balance:pack(state.session.schedule.balance)})})`);
    const referenceValue = JSON.stringify(baseline.scenarios[label]);
    const result = JSON.parse(app);
    if (app !== referenceValue) throw new Error(`${label} same-input output mismatch. app=${app} reference=${referenceValue}`);
    if (result.speed.length + result.balance.length === 0) throw new Error(`${label} produced no comparable sorties.`);
    return result;
  }
  await compareScenario("inner", { island: "까마귀의 둥지", fromItem: "갈퀴 꽃 씨앗 주머니", toItem: "까마귀 주화", reqAmount: 1, count: 1, yield: 1, deleted: false, disabled: false }, "crow-coin scenario");
  await compareScenario("t7_2region", [
    { island: "하코번 섬", fromItem: "정체불명의 암석", toItem: "발렌시아 모래 방패", reqAmount: 1, count: 1, yield: 1, deleted: false, disabled: false },
    { island: "올비아 해안", fromItem: "발렌시아 모래 방패", toItem: "최고급 하이델산 포도주", reqAmount: 1, count: 1, yield: 1, deleted: false, disabled: false },
  ], "tier-7 scenario");
  await evaluate(`import('/assets/js/state.js').then(({state})=>{state.settings.ship.mode='inner';if(state.session.config)state.session.config.ship.mode='inner';state.session.scannedTrades=[{island:'베이루와 섬',fromItem:'갈퀴 꽃 씨앗 주머니',toItem:'괴생물 촉수',reqAmount:1,count:3,yield:3,deleted:false,disabled:false}];state.session.schedule=null;state.session.remainingParley=1500000;window.__bdoScheduleRuntime.generateSchedule(state,()=>{})})`);

  await evaluate("document.querySelector('.schedule-route li').querySelectorAll('button')[2].click(); document.querySelector('.schedule-route li').querySelectorAll('button')[2].click(); document.querySelector('.sortie-footer button').click(); document.querySelector('.sortie-footer button').click()");
  const timerState = await evaluate("JSON.stringify({trade:sortiesSpeed[0].trades[0].timerActive,returnTimer:!!window.ACTIVE_TIMERS['return_speed_0']})");
  if (JSON.parse(timerState).trade || JSON.parse(timerState).returnTimer) throw new Error(`timer toggle did not return to inactive state: ${timerState}`);

  await evaluate("document.querySelector('.sortie-card .sortie-heading button').click()");
  await evaluate("document.querySelector('#wpIsland').value='인버넨 섬'; document.querySelector('#wpAnchorSelect').value='0'; document.querySelector('input[name=wpPos][value=after]').checked=true; document.querySelector('#wpUseMat').checked=true; document.querySelector('#wpMatName').value='갈퀴 꽃 씨앗 주머니'; document.querySelector('#wpMatCount').value='1'; document.querySelector('#confirm-waypoint').click()");
  const waypointCount = await evaluate("import('/assets/js/state.js').then(({state})=>state.session.schedule.speed[0].trades.filter(t=>t.isWaypoint).length)");
  if (waypointCount !== 1) throw new Error(`waypoint was not added: ${waypointCount}`);
  await evaluate("window.adjustTradeCount({stopPropagation(){}},'speed',0,0,-1); draggedRoute={sortieIdx:0,tradeIdx:1,mode:'speed'}; window.routeDrop({preventDefault(){},currentTarget:{classList:{remove(){}}}},0,0,'speed')");
  const routeOrder = await evaluate("sortiesSpeed[0].trades.map(t=>t.isWaypoint?'waypoint':'trade').join(',')");
  if (routeOrder !== "waypoint,trade") throw new Error(`manual route reorder was not preserved: ${routeOrder}`);
  await evaluate("window.__bdoCompletionInvocationCounts={completeTrade:0,completeWaypoint:0};window.__bdoCompletionInvocationObserver=(name)=>{window.__bdoCompletionInvocationCounts[name]++}");
  await evaluate("document.querySelectorAll('.schedule-route li')[0].querySelectorAll('button')[1].click()");
  await waitFor(async () => (await evaluate("window.__bdoScheduleRuntime.pending===null && window.__bdoAppState.inventory.find(i=>i.programName==='갈퀴 꽃 씨앗 주머니').stock===99")) === true, "waypoint material persisted");

  await evaluate(`(()=>{const original=window.fetch.bind(window); window.__completionRequests=[]; window.fetch=async(input,options={})=>{if(String(input).includes('/api/working-session/completion')&&options.method==='POST'){const body=JSON.parse(options.body);if(body.kind==='completion'){window.__completionRequests.push(options.body);const response=await original(input,options);if(window.__completionRequests.length===1)throw new TypeError('simulated response loss after commit');return response}}return original(input,options)}})()`);
  await evaluate("document.querySelectorAll('.schedule-route li')[1].querySelectorAll('button')[3].click()");
  await waitFor(async () => (await evaluate("document.querySelector('#retry-completion-save').hidden")) === false, "completion saved with recoverable pending request");
  const firstCommit = await evaluate("fetch('/api/bootstrap').then(r=>r.json()).then(s=>JSON.stringify({from:s.inventory.find(i=>i.programName==='갈퀴 꽃 씨앗 주머니').stock,to:s.inventory.find(i=>i.programName==='괴생물 촉수').stock,revision:s.revision}))");
  const committed = JSON.parse(firstCommit);
  if (committed.from >= 99 || committed.to <= 0) throw new Error(`completion patch did not change stock: ${firstCommit}`);
  await evaluate("document.querySelector('#retry-completion-save').click()");
  await waitFor(async () => (await evaluate("window.__bdoScheduleRuntime.pending === null && document.querySelector('#retry-completion-save').hidden")) === true, "idempotent completion retry");
  const retryState = await evaluate("JSON.stringify({requests:window.__completionRequests, pending:window.__bdoScheduleRuntime.pending, from:window.__bdoAppState.inventory.find(i=>i.programName==='갈퀴 꽃 씨앗 주머니').stock, to:window.__bdoAppState.inventory.find(i=>i.programName==='괴생물 촉수').stock})");
  const recovered = JSON.parse(retryState);
  if (recovered.requests.length !== 2 || recovered.requests[0] !== recovered.requests[1] || recovered.pending !== null || recovered.from !== committed.from || recovered.to !== committed.to) throw new Error(`response-loss retry was not idempotent: ${retryState}`);
  if (await evaluate("window.__bdoCompletionInvocationCounts.completeTrade") !== 1) throw new Error("response-loss retry reran completeTrade calculation");
  const sessionResult = await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({completed:state.session.schedule.speed[0].trades[1].completed,waypointCompleted:state.session.schedule.speed[0].trades[0].completed,deleted:state.session.scannedTrades[0].deleted,count:state.session.scannedTrades[0].count,remaining:state.session.remainingParley}))");
  if (!JSON.parse(sessionResult).completed || JSON.parse(sessionResult).deleted || JSON.parse(sessionResult).count !== 1) throw new Error(`completion session output incorrect: ${sessionResult}`);
  await evaluate("window.completeTrade(null,'speed',0,1,0)");
  if (await evaluate("window.__completionRequests.length") !== 2) throw new Error("duplicate completion attempted another atomic completion POST");
  if (await evaluate("window.__bdoCompletionInvocationCounts.completeTrade") !== 1) throw new Error("duplicate completion reran completeTrade calculation");
  if (await evaluate("window.__bdoCompletionInvocationCounts.completeWaypoint") !== 1) throw new Error("waypoint completion was not calculated exactly once");

  const conflictScenario = await evaluate(`(async()=>{const {state}=await import('/assets/js/state.js');const s=await fetch('/api/bootstrap').then(r=>r.json());const source='갈퀴 꽃 씨앗 주머니',target='괴생물 촉수';const items=Object.fromEntries(s.inventory.map(i=>[i.programName,{stock:i.programName===source?100:i.programName===target?0:(i.stock??0),target:i.target}]));const seed=await fetch('/api/inventory',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({mutationId:'spec006-conflict-seed',baseRevision:s.revision,kind:'manual',patch:{items}})});if(!seed.ok)throw Error(await seed.text());await import('/assets/js/persistence.js').then(({refreshPersistentState})=>refreshPersistentState());state.settings.ship.mode='inner';if(state.session.config)state.session.config.ship.mode='inner';state.session.scannedTrades=[{island:'베이루와 섬',fromItem:source,toItem:target,reqAmount:1,count:3,yield:3,deleted:false,disabled:false}];state.session.schedule=null;state.session.remainingParley=1500000;window.__bdoScheduleRuntime.syncLegacyState(state);window.__bdoScheduleRuntime.generateSchedule(state,()=>{});window.renderModeColumn('col-speed',state.session.schedule.speed,'speed');window.__bdoCompletionInvocationCounts.completeTrade=0;window.__409CompletionRequests=[];const original=window.fetch.bind(window);let injected=false;window.fetch=async(input,options={})=>{if(!injected&&String(input).includes('/api/working-session/completion')&&options.method==='POST'&&JSON.parse(options.body).kind==='completion'){injected=true;window.__409CompletionRequests.push(options.body);const before=await original('/api/bootstrap').then(r=>r.json());const concurrent={items:{[source]:{stock:200},[target]:{stock:10}}};const external=await original('/api/inventory',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({mutationId:'spec006-concurrent-write',baseRevision:before.revision,kind:'manual',patch:concurrent})});if(!external.ok)throw Error(await external.text());const conflict=await original(input,options);if(conflict.status!==409)throw Error('completion did not receive an actual 409');return conflict;}if(String(input).includes('/api/working-session/completion')&&options.method==='POST'&&JSON.parse(options.body).kind==='completion')window.__409CompletionRequests.push(options.body);return original(input,options)};const tradeRow=[...document.querySelectorAll('.schedule-route li')].find(x=>x.querySelectorAll('button').length===4);if(!tradeRow)throw Error('trade completion button missing');tradeRow.querySelectorAll('button')[3].click();return true})()`);
  if (!conflictScenario) throw new Error("revision-conflict scenario did not start");
  await waitFor(async () => (await evaluate("window.__bdoScheduleRuntime.pending===null")) === true, "completion rebased after a real revision conflict");
  const conflictResult = JSON.parse(await evaluate(`(async()=>{const {state}=await import('/assets/js/state.js');const b=await fetch('/api/bootstrap').then(r=>r.json());return JSON.stringify({calls:window.__bdoCompletionInvocationCounts.completeTrade,requests:window.__409CompletionRequests.map(x=>JSON.parse(x)),completed:state.session.schedule.speed[0].trades.find(t=>!t.isWaypoint)?.completed,remaining:state.session.remainingParley,source:b.inventory.find(i=>i.programName==='갈퀴 꽃 씨앗 주머니').stock,target:b.inventory.find(i=>i.programName==='괴생물 촉수').stock})})()`));
  const firstDelta = conflictResult.requests.length === 2 ? conflictResult.requests[0].patch.items : {};
  const sourceDelta = (firstDelta["갈퀴 꽃 씨앗 주머니"]?.stock ?? 100) - 100;
  const targetDelta = (firstDelta["괴생물 촉수"]?.stock ?? 0) - 0;
  if (conflictResult.calls !== 1 || conflictResult.requests.length !== 2 || conflictResult.requests[0].baseRevision === conflictResult.requests[1].baseRevision || conflictResult.source !== 200 + sourceDelta || conflictResult.target !== 10 + targetDelta || sourceDelta >= 0 || targetDelta <= 0 || !conflictResult.completed || conflictResult.remaining >= 1500000) throw new Error(`409 rebase/completion invocation mismatch: ${JSON.stringify(conflictResult)}`);
  await evaluate("window.__beforeReloadMarker = true");
  await send("Page.reload", { ignoreCache: true });
  await waitFor(async () => (await evaluate("!window.__beforeReloadMarker && document.querySelector('#app-content')?.getAttribute('aria-busy')==='false' && document.querySelectorAll('.inventory-row').length===70")) === true, "new document initialized after reload");
  await waitFor(async () => (await evaluate("document.querySelectorAll('.inventory-row').length")) === 70, "reload");
  const reload = await evaluate("Promise.all([import('/assets/js/state.js'),fetch('/api/bootstrap').then(r=>r.json())]).then(([{state},s])=>JSON.stringify({session:state.session.scannedTrades,from:s.inventory.find(i=>i.programName==='갈퀴 꽃 씨앗 주머니').stock,to:s.inventory.find(i=>i.programName==='괴생물 촉수').stock}))");
  if (!Array.isArray(JSON.parse(reload).session) || JSON.parse(reload).from !== conflictResult.source || JSON.parse(reload).to !== conflictResult.target) throw new Error(`session/persistent reload boundary incorrect: ${reload}`);
  console.log(JSON.stringify({ ok: true, browser: "Chrome headless", sameInputReferenceOutputExact: true, comparedScenarios: ["inner trade", "crow coin", "tier 7"], scheduleGenerated: generatedState, timerToggle: true, manualRouteReorder: true, manualCountAdjustment: true, waypointAddedAndCompletedWithMaterialPatch: true, completionResult: JSON.parse(sessionResult), lostResponseRetryUsedSameRequest: true, duplicateCompletionBlocked: true, inventoryUpdatedOnce: true, completionInvocationCounts: { waypoint: 1, tradeAfterResponseLossAndDuplicateClick: 1, tradeAfter409Rebase: conflictResult.calls }, actual409RebasedDelta: { source: conflictResult.source, target: conflictResult.target }, sessionRestoredOnReload: true, persistentInventorySurvivedReload: true, temporaryDatabase: true }, null, 2));
} finally {
  try { } catch {} try { socket?.close(); } catch {} try { chrome?.kill(); } catch {} try { server?.kill(); } catch {}
  await delay(300); if (profile.startsWith(tmpdir())) await rm(profile, { recursive: true, force: true });
}

async function waitFor(predicate, label, timeout = 20000) { const until = Date.now() + timeout; while (Date.now() < until) { const value = await predicate(); if (value) return value; await delay(100); } throw new Error(`Timed out waiting for ${label}`); }
