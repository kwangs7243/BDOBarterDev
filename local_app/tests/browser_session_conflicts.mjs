import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.BDO_NODE_MODULES?require.resolve('playwright',{paths:[process.env.BDO_NODE_MODULES]}):'playwright');

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const temp=await mkdtemp(join(tmpdir(),'bdo-session-conflicts-'));
const database=join(temp,'isolated.sqlite3');
const code=`from local_app.backend.app import create_app; from werkzeug.serving import make_server; server=make_server('127.0.0.1',0,create_app(r'${database}',testing=True),threaded=True); print(server.server_port,flush=True); server.serve_forever()`;
const external=process.env.BDO_EXTERNAL_APP==='1';
if(external&&!process.env.BDO_TEST_URL)throw Error('External tests require an explicit isolated BDO_TEST_URL');
const server=external?null:spawn(process.env.PYTHON||'python',['-B','-c',code],{cwd:root,windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','pipe']});
let browser;
try {
  const port=external?null:await new Promise((resolve,reject)=>{
    let stdout='',stderr='';
    const timer=setTimeout(()=>reject(Error('isolated server startup timed out: '+stderr.slice(-500))),15000);
    server.stdout.on('data',data=>{stdout+=data;if(/^\d+\r?\n/.test(stdout)){clearTimeout(timer);resolve(Number(stdout.trim()));}});
    server.stderr.on('data',data=>{stderr+=data;});
    server.on('error',error=>{clearTimeout(timer);reject(error);});
    server.on('exit',code=>{clearTimeout(timer);reject(Error(`isolated server exited ${code}: ${stderr.slice(-500)}`));});
  });
  const url=external?process.env.BDO_TEST_URL.replace(/\/$/,''):`http://127.0.0.1:${port}`;
  browser=await chromium.launch({executablePath:process.env.BDO_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const context=await browser.newContext();
  const open=async()=>{const page=await context.newPage();await page.goto(url+'/barter/');await page.waitForFunction(()=>document.querySelector('#app-content')?.getAttribute('aria-busy')==='false');return page;};
  const first=await open();
  await first.evaluate(async()=>{
    const {state}=await import('/assets/js/state.js');
    const p=await import('/assets/js/persistence.js');
    await p.saveInventory({'갈퀴 꽃 씨앗 주머니':{stock:100},'괴생물 촉수':{stock:0}});
    state.session.scannedTrades=[{island:'베이루와 섬',fromItem:'갈퀴 꽃 씨앗 주머니',toItem:'괴생물 촉수',reqAmount:1,count:3,yield:3}];
    state.session.remainingParley=1500000;
    window.__bdoScheduleRuntime.generateSchedule(state,()=>{});
    await p.whenPersistenceIdle();
  });
  const second=await open();
  const boot=()=>fetch(url+'/api/bootstrap').then(r=>r.json());
  const loaded=await boot();
  await first.evaluate(async()=>{
    window.completeTrade(document.createElement('button'),'speed',0,0,0);
    await (await import('/assets/js/persistence.js')).whenPersistenceIdle();
  });
  const completed=await boot();
  assert.ok(completed.workingSession.schedule.speed[0].trades[0].completed);
  assert.equal(completed.inventory.find(i=>i.programName==='갈퀴 꽃 씨앗 주머니').stock,97);
  const stale=await second.evaluate(async()=>{
    const {state}=await import('/assets/js/state.js');
    const p=await import('/assets/js/persistence.js');
    await p.refreshPersistentState();
    window.completeTradeAndTimer(document.createElement('button'),'speed',0,0,0,'베이루와 섬','괴생물 촉수');
    if(window.__bdoScheduleRuntime.pending||state.session.schedule.speed[0].trades[0].completed)throw Error('known stale completion mutated local state');
    const errors=[];
    for(const action of [()=>p.saveWorkingSession(),()=>p.resetWorkingSession()]) {
      try{await action();errors.push(null);}catch(e){errors.push(e.status);}
    }
    const request={mutationId:crypto.randomUUID(),kind:'completion',patch:{items:{'갈퀴 꽃 씨앗 주머니':{stock:94}}},
      session:window.__bdoScheduleRuntime.snapshotWorkingSession(state)};
    Object.defineProperty(request,'beforeInventory',{value:{'갈퀴 꽃 씨앗 주머니':97}});
    try{await p.saveCompletionInventory(request);errors.push(null);}catch(e){errors.push(e.message);}
    return {errors,base:state.sessionBaseRevision,durable:state.sessionRevision,localCompleted:!!state.session.schedule.speed[0].trades[0].completed};
  });
  assert.deepEqual(stale.errors.slice(0,2),[409,409]);
  assert.match(stale.errors[2],/다른 작업/);
  assert.equal(stale.base,loaded.sessionRevision);
  assert.equal(stale.durable,completed.sessionRevision);
  assert.equal(stale.localCompleted,false,'conflict must preserve local edits until explicit reload');
  assert.deepEqual(await boot(),completed,'stale save/reset/completion must not touch inventory or session');
  await second.reload();
  await second.waitForFunction(()=>document.querySelector('#app-content')?.getAttribute('aria-busy')==='false');
  await second.waitForFunction(async()=>{
    const {state}=await import('/assets/js/state.js');
    return state.session.schedule.speed[0].trades[0].completed&&state.sessionBaseRevision===state.sessionRevision;
  });
  await second.evaluate(async()=>{
    window.completeTrade(document.createElement('button'),'speed',0,0,0);
    await (await import('/assets/js/persistence.js')).whenPersistenceIdle();
  });
  assert.deepEqual(await boot(),completed,'reloading completed rows cannot deduct twice');
  await second.evaluate(async()=>{
    const {state}=await import('/assets/js/state.js');
    const p=await import('/assets/js/persistence.js');
    state.session.diagnostics={sequence:1};const one=p.saveWorkingSession();
    state.session.diagnostics={sequence:2};const two=p.saveWorkingSession();
    await Promise.all([one,two]);
    await p.saveScheduleSlot(1);
    await p.loadScheduleSlot(1);
    if(state.sessionBaseRevision!==state.sessionRevision)throw Error('slot load base is stale');
  });
  assert.equal((await boot()).workingSession.diagnostics.sequence,2);
  // Another tab changes the session between our successful PUT and its metadata refresh.
  let intercepted=false;
  await second.route('**/api/bootstrap',async route=>{
    if(!intercepted){
      intercepted=true;
      await first.evaluate(async()=>{
        const p=await import('/assets/js/persistence.js');
        await p.refreshPersistentState({restoreSession:true});
        const {state}=await import('/assets/js/state.js');state.session.diagnostics={sequence:4};await p.saveWorkingSession();
      });
    }
    await route.continue();
  });
  const raced=await second.evaluate(async()=>{
    const p=await import('/assets/js/persistence.js');
    const {state}=await import('/assets/js/state.js');state.session.diagnostics={sequence:3};
    await p.saveWorkingSession();
    return {base:state.sessionBaseRevision,durable:state.sessionRevision};
  });
  assert.ok(intercepted);assert.ok(raced.base<raced.durable,'metadata refresh must not advance the local session base');
  const error=await second.evaluate(async()=>{
    try{await (await import('/assets/js/persistence.js')).saveWorkingSession();return null;}catch(e){return e.status;}
  });
  assert.equal(error,409);assert.equal((await boot()).workingSession.diagnostics.sequence,4);
  await second.unroute('**/api/bootstrap');
  const resetQueue=await second.evaluate(async()=>{
    const p=await import('/assets/js/persistence.js');await p.refreshPersistentState({restoreSession:true});
    const reset=p.resetWorkingSession(),oldEdit=p.saveWorkingSession();
    return (await Promise.allSettled([reset,oldEdit])).map(r=>r.status);
  });
  assert.deepEqual(resetQueue,['fulfilled','rejected']);
  assert.equal((await boot()).workingSession,null,'an edit queued before reset must not resurrect the old session');
  console.log('PASS: real two-tab stale save/reset/completion blocked after refresh; explicit reload, once-only completion, queued saves, slot load and post-commit refresh race verified against isolated SQLite');
} finally {
  await browser?.close();
  if(server&&server.exitCode===null){server.kill();await new Promise(resolve=>server.once('exit',resolve));}
  await rm(temp,{recursive:true,force:true});
}
