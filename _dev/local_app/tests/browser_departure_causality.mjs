import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import {audit} from './scheduler_departure_causality.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = process.env.BDO_TEST_URL ?? "http://127.0.0.1:18768/";
const python = process.env.PYTHON ?? "python";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-spec005-browser-"));
const database = join(profile, "isolated.sqlite3");
const sitePackages = process.env.BDO_EXTRA_SITE_PACKAGES;
const pythonPrelude = sitePackages ? `import sys; p=${JSON.stringify(sitePackages)}; sys.path.remove(p); sys.path.append(p); ` : "";
const pythonCode = `${pythonPrelude}import os,threading; from local_app.backend.app import create_app; app=create_app(r'${database}', testing=True); app.add_url_rule('/__test__/shutdown',view_func=lambda:(threading.Timer(.2,lambda:os._exit(0)).start() or {'ok':True}),methods=['POST']); app.run(host='127.0.0.1', port=18768, use_reloader=False, threaded=True)`;
const external = process.env.BDO_EXTERNAL_APP === "1";
let server = external ? null : spawn(python, ["-c", pythonCode], { stdio: "ignore", windowsHide: true, cwd: root });
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
  const evaluate = async (expression) => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).catch(error=>{if(/navigated|context was destroyed/.test(error.message))return null;throw error}); if(!result)return null; if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value; };
  await send("Page.enable"); await send("Runtime.enable");
  await waitFor(async () => (await evaluate("document.querySelectorAll('.inventory-row').length")) === 70, "new app loaded");



  const evidence=resolve(root,'recognition-local/scheduler-improved');
  const earlier=JSON.parse((await readFile(resolve(evidence,'weights-live-before.json'),'utf8')).replace(/^\uFEFF/,''));
  const latest=JSON.parse(await readFile(resolve(evidence,'latest-live-input.json'),'utf8'));
  const restored=structuredClone(latest),byName=new Map(restored.inventory.map(x=>[x.programName,x]));let cost=0;
  for(const s of restored.workingSession.schedule?.speed||[])for(const t of s.trades){
    if(!t.completed||t.isWaypoint)continue;
    if(byName.has(t.fromClean))byName.get(t.fromClean).stock+=t.execC*t.reqA;
    if(byName.has(t.toClean))byName.get(t.toClean).stock-=t.execC*t.mult;
    const row=restored.workingSession.scannedTrades[t.originalIndex];if(row){row.count+=t.execC;row.deleted=false;}
    cost+=t.execC*(t.isCoin?restored.workingSession.config.parley.crowCost:restored.workingSession.config.parley.normalCost);
  }
  restored.workingSession.remainingParley+=cost;
  const results=process.env.BDO_CAUSALITY_SKIP_MATRIX==='1'?JSON.parse(await readFile(resolve(evidence,'causality-matrix.json'),'utf8')).results:[];
  for(const [label,boot] of (process.env.BDO_CAUSALITY_SKIP_MATRIX==='1'?[]:[['earlier-79',earlier],['latest-78-before-recorded-completions',restored]]))for(const mode of ['none','inner','ocean','t7_2region','t7_2region_south','t7_2region_arehazaX','t7_3region']){
    const start=Date.now();const state=await evaluate(`import('/assets/js/state.js').then(({state})=>{const boot=${JSON.stringify(boot)};state.settings=boot.settings;state.inventory=boot.inventory;state.session=boot.workingSession;state.session.config.ship.mode=${JSON.stringify(mode)};window.__bdoScheduleRuntime.generateSchedule(state,()=>{});return {session:state.session,settings:state.settings}})`);
    const initial=Object.fromEntries(boot.inventory.map(x=>[x.programName,x]));const ship=state.session.config.ship,parley=state.session.config.parley,modes={};
    for(const weightMode of ['speed','balance']){
      const sorties=state.session.schedule[weightMode];const summary=audit(sorties,initial,ship.normalWeight,ship.maxWeight,weightMode,parley.normalCost,parley.crowCost,boot.workingSession.remainingParley);
      const totals={};for(const s of sorties)for(const t of s.trades)if(!t.isWaypoint)totals[t.originalIndex]=(totals[t.originalIndex]||0)+t.execC;
      for(const [idx,count] of Object.entries(totals))if(count>boot.workingSession.scannedTrades[idx].count)throw Error('source count overallocated '+label+'/'+mode+'/'+weightMode);
      modes[weightMode]={departures:summary.departures,plannedCost:summary.plannedCost};
    }
    results.push({label,inputRows:boot.workingSession.scannedTrades.length,mode,modes,elapsedMs:Date.now()-start});console.log(JSON.stringify(results.at(-1)));
  }
  await writeFile(resolve(evidence,'causality-matrix.json'),JSON.stringify({ok:true,browser:'Chrome headless',independentWarehouseAndOnboardCargoAudit:true,scenarios:results.length,results},null,2));
  const setup=await evaluate(`(async()=>{const {state}=await import('/assets/js/state.js');const p=await import('/assets/js/persistence.js');await p.whenPersistenceIdle();await p.refreshPersistentState();await p.saveInventory(Object.fromEntries(state.inventory.map(x=>[x.programName,{stock:{'자수정 파편':6,'팔랑나비 박제품':5,'102년 묵은 황금초':10}[x.programName]||0}])));await p.whenPersistenceIdle();state.session.config=structuredClone({ship:state.settings.ship,parley:state.settings.parley,tuning:state.settings.tuning});Object.assign(state.session.config.ship,{normalWeight:22689,maxWeight:40259,mode:'t7_3region'});Object.assign(state.session.config.parley,{normalCost:10278,crowCost:15576,defaultBudget:1250000});state.session.remainingParley=1250000;state.session.schedule=null;state.session.scannedTrades=[{island:'하코번 섬',fromItem:'팔랑나비 박제품',toItem:'발렌시아 사막 보검',count:5},{island:'아지르 섬',fromItem:'자수정 파편',toItem:'102년 묵은 황금초',count:6},{island:'달래나루',fromItem:'102년 묵은 황금초',toItem:'최고급 감투 상자',count:5},{island:'할마드 섬',fromItem:'자수정 파편',toItem:'까마귀 주화',count:1,yield:171}].map(t=>({reqAmount:1,yield:1,disabled:false,deleted:false,...t}));window.__bdoScheduleRuntime.generateSchedule(state,()=>{});if(state.session.schedule.speed.length!==2)throw Error('expected two departures');return {schedule:state.session.schedule.speed,inventory:state.inventory}})()`);
  const summary=audit(setup.schedule,Object.fromEntries(setup.inventory.map(x=>[x.programName,x])),22689,40259,'speed',10278,15576,1250000);
  const blocked=await evaluate(`(async()=>{const {state}=await import('/assets/js/state.js');const p=await import('/assets/js/persistence.js');await p.whenPersistenceIdle();const before=await fetch('/api/bootstrap').then(r=>r.json()),n=state.session.remainingParley;window.completeTradeAndTimer(document.createElement('button'),'speed',1,0,state.session.schedule.speed[1].trades[0].originalIndex);await p.whenPersistenceIdle();const after=await fetch('/api/bootstrap').then(r=>r.json());if(state.session.schedule.speed[1].trades[0].completed||before.revision!==after.revision||JSON.stringify(before.inventory)!==JSON.stringify(after.inventory)||state.session.remainingParley!==n)throw Error('future departure mutated state');return true})()`);
  await evaluate(`(async()=>{const {state}=await import('/assets/js/state.js');const p=await import('/assets/js/persistence.js');for(let ti=0;ti<state.session.schedule.speed[0].trades.length;ti++){const t=state.session.schedule.speed[0].trades[ti];window.completeTradeAndTimer(document.createElement('button'),'speed',0,ti,t.originalIndex,t.island,t.toClean);await new Promise((ok,fail)=>{const end=Date.now()+10000;const poll=()=>window.__bdoScheduleRuntime.pending===null?ok():Date.now()>end?fail(Error('completion pending: '+document.querySelector('#schedule-status').textContent)):setTimeout(poll,50);poll()});await p.whenPersistenceIdle();if(!t.completed)throw Error('first departure not completed '+JSON.stringify({ti,pending:window.__bdoScheduleRuntime.pending,status:document.querySelector('#schedule-status').textContent,t}));}const b=await fetch('/api/bootstrap').then(r=>r.json());if(b.inventory.find(x=>x.programName==='자수정 파편').stock!==5)throw Error('first departure amethyst deduction');window.__beforeReloadMarker=true;return true})()`);
  await send('Page.reload',{ignoreCache:true});
  await waitFor(async()=>await evaluate("!window.__beforeReloadMarker && document.querySelector('#app-content')?.getAttribute('aria-busy')==='false' && window.__bdoAppState?.session?.schedule?.speed?.[0]?.trades?.every(t=>t.completed)"),'causal schedule restored');
  const completed=await evaluate(`(async()=>{const {state}=await import('/assets/js/state.js');const p=await import('/assets/js/persistence.js');for(let ti=0;ti<state.session.schedule.speed[1].trades.length;ti++){const t=state.session.schedule.speed[1].trades[ti];window.completeTradeAndTimer(document.createElement('button'),'speed',1,ti,t.originalIndex,t.island,t.toClean);await new Promise((ok,fail)=>{const end=Date.now()+10000;const poll=()=>window.__bdoScheduleRuntime.pending===null?ok():Date.now()>end?fail(Error('completion pending: '+document.querySelector('#schedule-status').textContent)):setTimeout(poll,50);poll()});await p.whenPersistenceIdle();if(!t.completed)throw Error('second departure not completed');}const b=await fetch('/api/bootstrap').then(r=>r.json());return {remaining:state.session.remainingParley,persisted:b.workingSession.remainingParley,amethyst:b.inventory.find(x=>x.programName==='자수정 파편').stock,golden:b.inventory.find(x=>x.programName==='102년 묵은 황금초').stock,allCompleted:b.workingSession.schedule.speed.every(s=>s.trades.every(t=>t.completed))}})()`);
  if(completed.amethyst!==5||completed.golden!==5||completed.remaining!==1250000-summary.plannedCost||completed.persisted!==completed.remaining||!completed.allCompleted)throw Error('causal persisted completion incorrect '+JSON.stringify(completed));
  const report={ok:true,browser:'Chrome headless',temporaryDatabase:true,matrixScenarios:results.length,alternativePlansAudited:results.length*2,futureDepartureBlockedWithoutMutation:blocked,previousDepartureRestoredAfterReload:true,completed};
  await writeFile(resolve(evidence,'browser-causality.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {
  if (!external) await fetch(`${baseUrl}__test__/shutdown`,{method:"POST"}).catch(()=>{});
  try { if(socket?.readyState===WebSocket.OPEN)await send("Browser.close"); } catch {} try { socket?.close(); } catch {} try { chrome?.kill(); } catch {} try { server?.kill(); } catch {}
  await delay(300); if (profile.startsWith(tmpdir())) await rm(profile, { recursive: true, force: true,maxRetries:10,retryDelay:500 });
}

async function waitFor(predicate, label, timeout = 20000) { const until = Date.now() + timeout; while (Date.now() < until) { const value = await predicate(); if (value) return value; await delay(100); } throw new Error(`Timed out waiting for ${label}`); }
