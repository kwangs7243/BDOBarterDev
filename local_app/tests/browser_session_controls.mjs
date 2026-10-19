import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = process.env.BDO_TEST_URL ?? "http://127.0.0.1:18773/";
const python = process.env.PYTHON ?? "python";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-session-controls-"));
const database = join(profile, "isolated.sqlite3");
const sitePackages = process.env.BDO_EXTRA_SITE_PACKAGES;
const pythonPrelude = sitePackages ? `import sys; p=${JSON.stringify(sitePackages)}; sys.path.remove(p); sys.path.append(p); ` : "";
const pythonCode = `${pythonPrelude}from local_app.backend.app import create_app; create_app(r'${database}', testing=True).run(host='127.0.0.1', port=18773, use_reloader=False, threaded=True)`;
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
  const evaluate = async (expression) => { const result = await send("Runtime.evaluate", { expression: "(()=>eval("+JSON.stringify(expression)+"))()", awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value; };
  await send("Page.enable"); await send("Runtime.enable");
  await waitFor(async () => (await evaluate("document.querySelectorAll('.inventory-row').length")) === 70, "new app loaded");

  await send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1.3,mobile:false});
  const idle = () => evaluate("import('/assets/js/persistence.js').then(m=>m.whenPersistenceIdle())");
  const boot = async () => (await fetch(`${baseUrl}api/bootstrap`)).json();
  const selectSlot = n => evaluate(`const s=document.querySelector('#selected-schedule-slot');s.value='${n}';s.dispatchEvent(new Event('change',{bubbles:true}))`);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const saveSlot = async n => {
    await selectSlot(n); await idle();
    await click('#schedule-slot-controls button:nth-of-type(1)');
    await waitFor(async () => (await boot()).scheduleSlots[String(n)] != null, `slot ${n} saved`);
    await idle();
  };
  const reload = async () => {
    await evaluate("window.__oldDocument=true"); await send('Page.reload',{ignoreCache:true});
    await waitFor(async()=>await evaluate("!window.__oldDocument&&document.querySelector('#app-content')?.getAttribute('aria-busy')==='false'&&document.querySelectorAll('.inventory-row').length===70"),'new initialized document');
  };
  const s=await boot();
  const seeded=await fetch(`${baseUrl}api/inventory`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({mutationId:'controls-seed',baseRevision:s.revision,kind:'manual',patch:{items:{'갈퀴 꽃 씨앗 주머니':{stock:100},'괴생물 촉수':{stock:0}}}})});
  if (!seeded.ok) throw Error('temporary inventory seed failed');
  await evaluate("import('/assets/js/persistence.js').then(m=>m.refreshPersistentState())");
  const trade={island:'베이루와 섬',fromItem:'갈퀴 꽃 씨앗 주머니',toItem:'괴생물 촉수',reqAmount:1,count:3,yield:3};
  await evaluate(`document.querySelector('#trade-json-input').value=${JSON.stringify(JSON.stringify([trade]))};document.querySelector('#apply-new-session').click()`);
  await idle();await click('#open-schedule');await click('#generate-schedule');
  await waitFor(async()=>await evaluate("document.querySelectorAll('#col-speed .sortie-card').length>0&&document.querySelectorAll('#col-balance .sortie-card').length>0"),'schedule generated');
  const rectangle=()=>evaluate("(()=>{const r=document.querySelector('#schedule-dialog').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()");
  const drag=async(x,y,dx,dy)=>{
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
    for(let i=1;i<=5;i++){await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+dx*i/5,y:y+dy*i/5,button:'left',buttons:1});await delay(20);}
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+dx,y:y+dy,button:'left',clickCount:1});await delay(100);
  };
  await evaluate("document.querySelector('#schedule-dialog').scrollTop=0");
  const before=await rectangle();
  const title=await evaluate("(()=>{const r=document.querySelector('#schedule-dialog .dialog-titlebar').getBoundingClientRect();return {x:r.x+90,y:r.y+18}})()");
  await drag(title.x,title.y,24,18);
  const moved=await rectangle();
  if(moved.x-before.x<12||moved.y-before.y<8)throw Error('briefing title drag stopped working: '+JSON.stringify({before,moved,title,hit:await evaluate(`document.elementFromPoint(${title.x},${title.y})?.outerHTML`)}));
  await drag(moved.x+moved.width-3,moved.y+moved.height-3,38,32);
  const resized=await rectangle();
  if(resized.width-moved.width<15||resized.height-moved.height<12)throw Error('briefing native resize stopped working: '+JSON.stringify({moved,resized}));
  for(const mode of ['speed','balance','both']) {
    await click(`[data-brief-mode=${mode}]`);
    if(!await evaluate(`import('/assets/js/state.js').then(({state})=>state.session.selection.briefMode==='${mode}')`))throw Error('briefing mode did not select');
  }
  await click('#schedule-dialog [data-close-dialog]');await click('#open-tuning');
  const tuningBefore=Number(await evaluate("document.querySelector('#temp-tune-useClustering').value"));
  await evaluate(`const input=document.querySelector('#temp-tune-useClustering');input.value='${tuningBefore+1}';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#tuning-root [data-tuning-temporary] button').click()`);
  await idle();
  if(!await evaluate(`import('/assets/js/state.js').then(({state})=>state.session.config.tuning.useClustering===${tuningBefore+1}&&state.settings.tuning.useClustering===${tuningBefore})`))throw Error('temporary tuning changed durable settings');
  await click('#tuning-dialog [data-close-dialog]');await click('#open-schedule');
  await saveSlot(1);
  await click('#col-speed .schedule-route li button:nth-of-type(1)');await idle();
  await saveSlot(2);
  const slotsBefore=(await boot()).scheduleSlots;
  if(JSON.stringify(slotsBefore['1'].session)===JSON.stringify(slotsBefore['2'].session)||slotsBefore['1'].session.config.tuning.useClustering!==tuningBefore+1)throw Error('independent slots/context not preserved');
  await click('#col-speed .route-depart-button');
  await waitFor(async()=>await evaluate("import('/assets/js/state.js').then(({state})=>Object.keys(state.session.timers||{}).length===1)"),'transient timer running');
  if(!await evaluate("import('/assets/js/state.js').then(({state})=>{const raw=state.session.schedule.speed.flatMap(s=>s.trades);const saved=window.__bdoScheduleRuntime.snapshotWorkingSession(state).schedule.speed.flatMap(s=>s.trades);return raw.some(t=>t.timerActive||t.timerEnd)&&!saved.some(t=>t.timerActive||t.timerEnd||t.alarmPlayed)})"))throw Error('timer leaked to persistent snapshot');
  await idle();await reload();
  if(!await evaluate("import('/assets/js/state.js').then(({state})=>!!state.session.schedule&&!Object.keys(state.session.timers||{}).length&&!state.session.schedule.speed.flatMap(s=>s.trades).some(t=>t.timerActive||t.timerEnd||t.alarmPlayed))"))throw Error('reload failed to restore schedule/reset timers');
  await click('#open-schedule');
  if(!await evaluate("document.querySelectorAll('#col-speed .sortie-card').length>0&&![...document.querySelectorAll('#col-speed .route-depart-button')].some(b=>b.textContent.includes('취소'))"))throw Error('restored schedule/timer DOM incorrect');
  await idle();
  const stopped=server;server=null;stopped.kill();await new Promise(r=>stopped.once('exit',r));
  server=spawn(python,['-B','-c',pythonCode],{cwd:root,stdio:'ignore',windowsHide:true});
  await waitFor(async()=>{try{return(await fetch(`${baseUrl}api/health`)).ok}catch{return false}},'same DB process restart');
  await reload();
  if(JSON.stringify((await boot()).scheduleSlots)!==JSON.stringify(slotsBefore))throw Error('slots changed after process restart');
  await click('#open-schedule');await selectSlot(1);await idle();await click('#schedule-slot-controls button:nth-of-type(2)');
  await waitFor(async()=>await evaluate("document.querySelector('#schedule-status').textContent.includes('1번 스케줄 회차를 불러왔습니다')"),'slot load');
  if(!await evaluate(`import('/assets/js/state.js').then(({state})=>state.session.config.tuning.useClustering===${tuningBefore+1}&&!Object.keys(state.session.timers||{}).length&&!!state.session.schedule)`))throw Error('slot context/timer restore failed');
  await click('#schedule-slot-controls button:nth-of-type(3)');
  await waitFor(async()=>!(await boot()).scheduleSlots['1'],'slot 1 delete');
  if(!(await boot()).scheduleSlots['2'])throw Error('slot deletion changed other slot');
  await click('#schedule-dialog [data-close-dialog]');
  const resetBefore=await boot();await click('#reset-session');
  await waitFor(async()=>(await boot()).workingSession===null,'session reset');
  const resetAfter=await boot();
  if(JSON.stringify(resetBefore.inventory)!==JSON.stringify(resetAfter.inventory)||!resetAfter.scheduleSlots['2'])throw Error('session reset removed inventory or saved slot');
  await click('#open-map-tools');await click('#viewer-root button');
  await waitFor(async()=>await evaluate("!!document.querySelector('.mv-window:modal')&&document.querySelectorAll('.mv-node').length>0"),'map viewer');
  await evaluate("const s=document.querySelector('.mv-window:modal .mv-toolbar select.mv-select:nth-of-type(1)');s.value='2';s.dispatchEvent(new Event('change',{bubbles:true}))");
  for(const mode of ['balance','speed'])await evaluate(`const s=document.querySelector('.mv-window:modal .mv-toolbar select.mv-select:nth-of-type(2)');s.value='${mode}';s.dispatchEvent(new Event('change',{bubbles:true}))`);
  await evaluate("const s=document.querySelector('.mv-window:modal .mv-toolbar select.mv-select:nth-of-type(3)');s.value='0';s.dispatchEvent(new Event('change',{bubbles:true}));const b=[...document.querySelectorAll('.mv-window:modal .mv-toolbar button')].find(b=>b.textContent.includes('선택 출항 보기'));if(!b)throw Error('selected sortie button missing');b.click()");
  if(!await evaluate("document.querySelector('.mv-mode-label').textContent.includes('저장 슬롯 2')&&document.querySelectorAll('.mv-route').length>=2&&document.querySelector('#mv-overview-panel').innerText.includes('저장 슬롯 2')"))throw Error('saved-slot map context/route missing');
  console.log('browser_session_controls: PASS · drag/resize, temporary tuning, independent slots, timer reset, process restart, load/delete, reset, saved-slot map');
} finally {
  try { } catch {} try { socket?.close(); } catch {} try { chrome?.kill(); } catch {} try { server?.kill(); } catch {}
  await delay(300); if (profile.startsWith(tmpdir())) await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(error=>console.warn('Temporary Chrome profile cleanup: '+error.message));
}

async function waitFor(predicate, label, timeout = 20000) { const until = Date.now() + timeout; while (Date.now() < until) { const value = await predicate(); if (value) return value; await delay(100); } throw new Error(`Timed out waiting for ${label}`); }
