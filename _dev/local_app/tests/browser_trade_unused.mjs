import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,readFile,writeFile,mkdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const temporary=await mkdtemp(join(tmpdir(),"bdo-unused-trade-"));
const base="http://127.0.0.1:18784/";
const output=resolve(process.env.BDO_LIVE_REPORT_DIR ?? join(temporary,"report"));
const delay=ms=>new Promise(done=>setTimeout(done,ms));
let server,chrome,socket,send;
async function waitFor(fn){for(let i=0;i<200;i++){try{const value=await fn();if(value)return value;}catch{}await delay(100);}throw Error("Unused-trade test readiness timed out");}
try {
  assert.notEqual(process.env.BDO_EXTERNAL_APP,"1","This test requires its own isolated database");
  assert.equal(await fetch(base+"api/health",{signal:AbortSignal.timeout(2000)}).then(()=>true).catch(()=>false),false,"test port is occupied");
  server=spawn(process.env.PYTHON ?? "python",["-B","-c",`from local_app.backend.app import create_app; create_app(r'${join(temporary,"test.sqlite3")}',testing=True).run(host='127.0.0.1',port=18784,use_reloader=False)`],{cwd:root,env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"},windowsHide:true,stdio:"ignore"});
  await waitFor(()=>fetch(base+"api/health",{signal:AbortSignal.timeout(2000)}).then(r=>r.ok));
  const before=await (await fetch(base+"api/bootstrap")).json();
  chrome=spawn(process.env.BDO_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",["--headless=new","--no-sandbox","--disable-gpu","--no-first-run","--disable-extensions","--disable-background-networking","--remote-debugging-port=0","--remote-allow-origins=*",`--user-data-dir=${join(temporary,"chrome")}`,"about:blank"],{windowsHide:true,stdio:"ignore"});
  const port=Number((await waitFor(()=>readFile(join(temporary,"chrome/DevToolsActivePort"),"utf8"))).split(/\r?\n/)[0]);
  const target=await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base)}`,{method:"PUT",signal:AbortSignal.timeout(5000)})).json();
  socket=new WebSocket(target.webSocketDebuggerUrl);
  await Promise.race([new Promise((ok,fail)=>{socket.addEventListener("open",ok,{once:true});socket.addEventListener("error",fail,{once:true});}),delay(5000).then(()=>{throw Error("DevTools connection timed out");})]);
  let next=0;const pending=new Map();
  send=(method,params={})=>new Promise((ok,fail)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);fail(Error(method+" timed out"));},10000);pending.set(id,{ok,fail,timer});socket.send(JSON.stringify({id,method,params}));});
  socket.addEventListener("message",({data})=>{const value=JSON.parse(data);if(pending.has(value.id)){const task=pending.get(value.id);pending.delete(value.id);clearTimeout(task.timer);value.error?task.fail(Error(value.error.message)):task.ok(value.result);}});
  const evaluate=async expression=>{const value=await send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});if(value.exceptionDetails)throw Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);return value.result.value;};
  await waitFor(()=>evaluate("document.querySelector('#app-content')?.getAttribute('aria-busy')==='false'"));
  const report=await evaluate(`(async()=>{
    const {createTradeLiveListUI}=await import('/assets/js/trade-live-list-ui.js');
    const catalog=await fetch('/assets/data/trade-catalog.json').then(r=>r.json());
    const policy=await fetch('/assets/data/trade-unused-policy.json').then(r=>r.json());
    const dialog=document.querySelector('#trade-capture-dialog');dialog.showModal();
    const host=document.createElement('section');dialog.append(host);
    const elements=Object.fromEntries(['liveListSection','tradeRecognitionStatus','tradeRecognitionRegion','tradeRecognitionResultRegion','recognitionDiagnostics'].map(key=>[key,document.createElement('section')]));
    for(const element of Object.values(elements))host.append(element);
    let current;
    const ui=createTradeLiveListUI({elements,getCatalog:()=>catalog,getUnusedPolicy:()=>policy,getPending:()=>false,setPending:()=>{},onResult:value=>current=value,onApplied:()=>{}});
    const f=value=>({corrected:value,rawOCR:String(value ?? ''),confidence:.99,reviewRequired:value===null});
    const row=(ordinal,island,toItem,fromItem=catalog.masterData[5][0],count=null,amount=null)=>({captureId:'test',ordinal,fields:Object.fromEntries(Object.entries({island,fromItem,toItem,reqAmount:1,count,yield:amount}).map(([key,value])=>[key,f(value)]))});
    const fresh=()=>({version:3,batchId:'test',rows:[
      row(0,'나르보 섬',catalog.masterData[2][0],catalog.masterData[1][0],1,3),
      row(1,'인버넨 섬','화려한 암염 주괴'),row(2,'마르카 섬','화려한 진주 결정'),
      row(3,'난파된 하란의 수송선',null),row(4,'베이루와 섬','파도의 블랙스톤',catalog.masterData[5][0],1,5),
      row(5,'바레미 섬','화려한 암염 주괴')
    ]});
    const payload=fresh();payload.rows[5].fields.toItem.rawOCR='화려한암염주거';
    const section=elements.liveListSection;
    const check=(ok,message)=>{if(!ok)throw Error(message);};
    ui.render(payload);
    check(current.rows.filter(r=>r.excluded&&r.autoUnusedReason).length===3,'known unused rows not excluded');
    check(section.querySelector('[data-role=live-list-auto-unused]')?.open===false,'unused group must start folded');
    check(section.querySelectorAll('.trade-review-row').length===1,'only the uncertain identity belongs in review');
    check(section.querySelector('[data-action=apply-live-new]').disabled,'uncertain active row must block apply');
    const uncertain=section.querySelector('input[aria-label="6행 목록 포함"]');uncertain.checked=false;uncertain.dispatchEvent(new Event('change'));
    check(!section.querySelector('[data-action=apply-live-new]').disabled,'unused unknown numbers must not block apply');
    section.querySelector('[data-action=include-auto-unused][data-row="1"]').click();
    check(current.rows[1].excluded===false&&current.rows[1].fields.count.reviewRequired,'restored row must retain unknown count');
    check(section.querySelector('[data-action=apply-live-new]').disabled,'restored unknown count must block apply');
    ui.render(current);check(current.rows[1].excluded===false,'explicit include lost on rerender');
    const included=section.querySelector('input[aria-label="2행 목록 포함"]');included.checked=false;included.dispatchEvent(new Event('change'));
    check(!section.querySelector('[data-action=apply-live-new]').disabled,'re-exclusion must release apply');
    const nextBatch=fresh();nextBatch.rows[5].fields.toItem.rawOCR='화려한암염주거';ui.render(nextBatch);
    check(current.rows[1].excluded===true,'new batch must apply default again without manual selection');
    const onlyUnused=fresh();onlyUnused.rows=onlyUnused.rows.slice(1,4);ui.render(onlyUnused);
    check(section.querySelector('[data-action=apply-live-new]').disabled,'all-unused input must not replace current session with an empty list');
    check(!section.querySelector('[data-role=live-list-review]'),'unused rows must never request numeric review');
    check(current.rows.every(r=>r.fields.count.corrected===null&&r.fields.count.reviewRequired),'source uncertainty was changed');
    const result={autoUnusedRows:3,uncertainIdentityReviewed:true,otherSpecialsPreserved:true,restoreRequiresReview:true,overrideSurvivesRerender:true,nextBatchAutomatic:true,allUnusedCannotApplyEmpty:true,originalUnknownsPreserved:true};
    ui.dispose();host.remove();dialog.close();return result;
  })()`);
  assert.deepEqual(await (await fetch(base+"api/bootstrap")).json(),before,"UI classification must not mutate inventory or working session");
  await mkdir(output,{recursive:true});
  await writeFile(join(output,"unused-trade-ui.json"),JSON.stringify({ok:true,isolatedDatabase:true,...report},null,2));
  console.log(JSON.stringify({ok:true,...report}));
} finally {
  socket?.close();chrome?.kill();server?.kill();await delay(400);
  if(dirname(temporary)!==resolve(tmpdir()))throw Error("Unsafe temporary cleanup path");
  await rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:300});
}
