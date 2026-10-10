import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(require.resolve('playwright',{paths:[process.env.BDO_NODE_MODULES ?? 'C:/Users/kwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules']}));
const frontend=resolve(dirname(fileURLToPath(import.meta.url)),'../frontend');
const server=createServer(async(req,res)=>{
 try{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const path=pathname==='/'?resolve(frontend,'index.html'):resolve(frontend,pathname.replace(/^\/assets\//,''));
  if(!path.startsWith(frontend+sep))throw Error('outside frontend');
  let body=await readFile(path);
  if(pathname==='/')body=body.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
  res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.json')?'application/json':'text/html');res.end(body);
 }catch{res.writeHead(404);res.end();}
});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const browser=await chromium.launch({executablePath:process.env.BDO_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1920,height:1080}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let revision=1,saved=null,failOCR=false,emptyOCR=false,failSave=false,feedback=[],writes=0;
 const settings={ship:{normalWeight:22689,maxWeight:40259,speed:170,mode:'none'},parley:{defaultBudget:1000000,normalCost:10247,crowCost:15529},tuning:{},tierRules:{1:20,2:20,3:20,4:20,5:2}};
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;
  const send=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(path==='/api/native-capture')return send({available:true,windows:[],state:'IDLE'});
  if(path==='/api/recognition/trade-runtime')return send({ok:true,runtime:{available:true}});
  if(path==='/api/recognition/trade-live-list'){
   if(failOCR)return send({error:{code:'recognition_worker_failed'}},503);
   const batch=JSON.parse(req.postData().match(/name="batch"\r\n\r\n([^\r]+)/)[1]);
   const fields=Object.fromEntries(Object.entries({island:'아지르 섬',fromItem:'자수정 파편',toItem:'102년 묵은 황금초',reqAmount:1,count:6,yield:1}).map(([k,v])=>[k,{corrected:v,rawOCR:String(v),reviewRequired:k==='count'}]));
   return send({ok:true,result:{version:3,batchId:batch.batchId,captures:batch.captures,rows:emptyOCR?[]:[{captureId:batch.captures[0].captureId,ordinal:0,rowBox:{x:0,y:0,width:320,height:200},fields}],runtime:{engineId:'test',workerVersion:'test',modelBundleSha256:'test'}}});
  }
  if(path==='/api/recognition/trade-corrections'){const data=JSON.parse(req.postData().match(/name="feedback"\r\n\r\n([^\r]+)/)[1]);feedback.push(data.captures.length);assert.ok(data.captures.length>0,'review keeps source capture after queue clearing');return send({ok:true});}
  if(path==='/api/working-session'){if(failSave)return send({error:{message:'test save failed'}},503);saved=req.postDataJSON().session;writes++;return send({revision:++revision});}
  if(path==='/api/bootstrap')return send({revision,sessionRevision:revision,settings,inventory:[],order:{},workingSession:saved,scheduleSlots:{}});
  return send({error:{message:'unexpected '+path}},404);
 });
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.evaluate(async settings=>{
  document.body.style.zoom='1.3';window.confirm=()=>true;
  const {state}=await import('/assets/js/state.js');Object.assign(state,{revision:1,settings});
  window.__bdoScheduleRuntime={pending:null,snapshotWorkingSession:s=>({...s.session,version:1})};
  const {initTradeSessionUI}=await import('/assets/js/trade-ui.js');await initTradeSessionUI(()=>{});
  const {initWarehouseScanUI}=await import('/assets/js/warehouse-scan-ui.js');const warehouse=initWarehouseScanUI({setStatus(){},onPatch(){}});
  const {initRecognitionUI}=await import('/assets/js/recognition-ui.js');window.testUI=initRecognitionUI({warehouseCaptureUI:warehouse});
 },settings);
 const image=await page.screenshot({clip:{x:0,y:0,width:320,height:200}});
 const dialog=page.locator('#trade-capture-dialog');
 const open=async()=>{await page.locator('#open-trade-capture').click();await page.waitForFunction(()=>document.querySelector('[data-role=trade-runtime-status]').textContent==='로컬 인식 사용 가능');};
 const add=async()=>{await page.locator('#trade-capture-files').setInputFiles({name:'test.png',mimeType:'image/png',buffer:image});await page.waitForFunction(()=>window.testUI.getTradeDraftCount()===1);};
 const recognize=async()=>{await page.locator('[data-action=recognize-trade]').click();await page.waitForFunction(()=>document.querySelector('[data-role=trade-recognition]').getAttribute('aria-busy')==='false');};
 await open();await add();assert.equal(await page.locator('[data-action=clear-trade-queue]').isVisible(),true,'clear button visible with native capture');
 await page.locator('[data-action=clear-trade-queue]').click();assert.equal(await page.evaluate(()=>window.testUI.getTradeDraftCount()),0);
 await add();failOCR=true;await recognize();assert.equal(await page.evaluate(()=>window.testUI.getTradeDraftCount()),1,'failed OCR retains screenshots');
 failOCR=false;emptyOCR=true;await recognize();assert.equal(await page.evaluate(()=>window.testUI.getTradeDraftCount()),1,'empty OCR retains retry input');
 emptyOCR=false;await recognize();assert.equal(await page.evaluate(()=>window.testUI.getTradeDraftCount()),0);assert.equal(await page.locator('[data-role=capture-list] li').count(),0);assert.equal(await dialog.evaluate(d=>d.open),true);
 assert.equal(await page.locator('.trade-review-source img').count(),1,'review source remains available');
 await page.locator('[data-role=live-list-review] input[data-field=count]').fill('6');await page.locator('[data-role=live-list-review] form').evaluate(f=>f.requestSubmit());await page.waitForFunction(()=>!document.querySelector('[data-action=apply-live-new]').disabled);
 failSave=true;await page.locator('[data-action=apply-live-new]').click();await page.waitForFunction(()=>document.querySelector('[data-role=trade-recognition-status]').textContent.includes('test save failed'));assert.equal(await dialog.evaluate(d=>d.open),true,'save failure keeps dialog');assert.equal(await page.locator('[data-role=trade-live-list]').isVisible(),true);
 failSave=false;await page.locator('[data-action=apply-live-new]').click();await page.waitForFunction(()=>!document.querySelector('#trade-capture-dialog').open);assert.equal(saved.scannedTrades.length,1);assert.equal(writes,1);assert.equal(await page.locator('[data-role=trade-live-list]').evaluate(d=>d.childElementCount),0);
 await open();assert.equal(await page.locator('[data-role=trade-live-list]').isVisible(),false,'reopen has no old review');await add();await recognize();await page.locator('[data-role=live-list-review] input[data-field=count]').fill('6');await page.locator('[data-role=live-list-review] form').evaluate(f=>f.requestSubmit());await page.waitForFunction(()=>!document.querySelector('[data-action=apply-live-append]').disabled);await page.locator('[data-action=apply-live-append]').click();await page.waitForFunction(()=>!document.querySelector('#trade-capture-dialog').open);assert.equal(writes,2);assert.equal(saved.scannedTrades.length,1);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({status:'PASS',nativeClearVisible:true,manualClear:true,recognitionQueueCleared:true,reviewSourceAndFeedbackPreserved:true,failedAndEmptyRecognitionPreserved:true,saveFailureKeptDialog:true,newAndAppendCloseAfterSave:true,reopenClean:true,viewport:'1920x1080',zoom:'130%',backend:'mocked',realOCR:'NOT_RUN',userDataWrites:0}));
}finally{await browser.close();await new Promise(ok=>server.close(ok));}
