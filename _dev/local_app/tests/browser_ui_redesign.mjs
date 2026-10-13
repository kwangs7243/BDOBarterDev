import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(require.resolve('playwright',{paths:[process.env.BDO_NODE_MODULES ?? 'C:/Users/kwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules']}));
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const out=resolve(root,'recognition-local/ui-redesign-20261013'); await mkdir(out,{recursive:true});
const phase=process.env.UI_AUDIT_PHASE ?? 'after';
const temp=await mkdtemp(join(tmpdir(),'bdo-ui-design-'));
const port=18692, url=`http://127.0.0.1:${port}`;
const server=spawn(process.env.PYTHON ?? 'python',['-B','-c',`from local_app.backend.app import create_app; create_app(r'${join(temp,'test.sqlite3')}',testing=True).run(host='127.0.0.1',port=${port},use_reloader=False,threaded=True)`],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
let browser;
try {
 for(let attempt=0;attempt<100;attempt++){try{if((await fetch(url+'/api/health')).ok)break;}catch{} await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1920,height:1080}}), errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(url); await page.waitForFunction(()=>document.querySelectorAll('.inventory-row').length===70);
 await page.evaluate(async()=>{
   const {state}=await import('/assets/js/state.js'); const p=await import('/assets/js/persistence.js');
   await p.saveSettings({viewer:{...state.settings.viewer,uiZoom:100}});
   await p.saveInventory(Object.fromEntries(state.inventory.map((v,i)=>[v.programName,{stock:i%4===0?3:80}])));
   window.__bdoRenderAll();
 });
 const catalog=JSON.parse(await readFile(resolve(root,'local_app/frontend/data/trade-catalog.json'),'utf8'));
 const islands=['아지르 섬','나르보 섬','바레미 섬','웨이타 섬','오스트라 섬','이리야 섬'];
 const trades=islands.map((island,i)=>({island,fromItem:catalog.masterData[(i%4)+1][i],toItem:catalog.masterData[(i%4)+2][i],reqAmount:1,count:6,yield:(i%4)===3?1:3}));
 await page.locator('#open-json-import').click(); await page.locator('#trade-json-input').fill(JSON.stringify(trades)); await page.locator('#apply-new-session').click();
 await page.waitForFunction(()=>!document.querySelector('#json-import-dialog').open);
 const shot=async(name)=>page.screenshot({path:join(out,`${phase}-${name}.png`)});
 await shot('main-1920');
 const idsBefore=await page.locator('[id]').evaluateAll(ns=>ns.map(n=>n.id).sort());
 await page.locator('#open-schedule').click(); await page.locator('#generate-schedule').click();
 await page.waitForFunction(()=>document.querySelectorAll('.sortie-card').length>0);
 const schedule=await page.evaluate(async()=>JSON.stringify((await import('/assets/js/state.js')).state.session.schedule,(k,v)=>k==='timerEnd'?undefined:v));
 await writeFile(join(out,`${phase}-schedule.json`),schedule);
 await shot('schedule-1920');
 await page.locator('#schedule-dialog [data-close-dialog]').click();
 if(phase==='after')await page.locator('[data-workspace-view="inventory"]').click();
 await shot('inventory-1920');
 await page.locator('#open-warehouse-scan').click(); await shot('warehouse-1920');
 if(phase==='before')await page.keyboard.press('Escape'); // Baseline close button clips at 130%; preserve evidence.
 else await page.locator('#warehouse-scan-dialog [data-action="close"]').click();
 if(phase==='after')await page.locator('[data-workspace-view="session"]').click();
 await page.locator('#open-trade-capture').click(); await shot('trade-1920'); await page.locator('#trade-capture-dialog [data-close-trade-capture]').first().click();
 await page.locator('.header-tools>summary').click(); await page.locator('#open-tuning').click(); await shot('settings-1920'); await page.locator('#tuning-dialog [data-close-dialog]').click();
 if(phase==='after')await page.locator('.header-tools>summary').click();
 await page.locator('#open-map-tools').click(); await shot('map-1920'); await page.locator('#map-tools-dialog [data-close-dialog]').click();
 const actions=await page.locator('button[id],button[data-action]').evaluateAll(ns=>ns.map(n=>({id:n.id,action:n.dataset.action,text:n.textContent.trim()})));
 await writeFile(join(out,`${phase}-actions.json`),JSON.stringify({ids:idsBefore,actions},null,2));
 if(phase==='after'){
   assert.deepEqual(errors,[]);
   const baseline=await readFile(join(out,'before-actions.json'),'utf8').then(JSON.parse).catch(()=>null);
   if(baseline){
     const missing=baseline.ids.filter(id=>!idsBefore.includes(id)); assert.deepEqual(missing,[],'existing action and field IDs preserved');
     assert.equal(schedule,await readFile(join(out,'before-schedule.json'),'utf8'),'same synthetic inputs produce identical schedules');
   }
   await page.locator('#open-settings').click(); await shot('ship-settings-1920');
   await page.keyboard.press('Escape'); assert.equal(await page.locator('#open-settings').evaluate(n=>document.activeElement===n),true,'Escape returns focus');
   await page.locator('[data-workspace-view="inventory"]').click();
   await page.locator('#inventory-search').fill('씨앗');
   assert.equal(await page.locator('.inventory-row:visible').count(),3);
   await page.locator('#inventory-stock-filter').selectOption('short');
   assert.equal(await page.locator('.inventory-row:visible').count(),1);
   const stock=page.locator('.inventory-row:visible input[data-value="stock"]');
   await stock.fill('81'); await stock.press('Tab');
   await page.waitForFunction(()=>document.getElementById('inventory-filter-summary').textContent.startsWith('0 /'));
   assert.equal(await page.locator('#inventory-search').inputValue(),'씨앗','filter survives save/render');
   await page.locator('#inventory-search').fill(''); await page.locator('#inventory-stock-filter').selectOption('all');
   await page.locator('[data-inventory-tier="5"]').click(); assert.equal(await page.locator('.inventory-row:visible').count(),14);
   await page.locator('[data-inventory-tier="all"]').click();
   const boxes=await page.locator('#inventory-root .tier-section').evaluateAll(ns=>ns.map(n=>({x:n.offsetLeft,y:n.offsetTop,w:n.offsetWidth,h:n.offsetHeight})));
   for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
     const a=boxes[i],b=boxes[j]; assert.ok(a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y,'tier tables never overlap');
   }
   await page.locator('[data-workspace-view="session"]').click(); await page.locator('#trade-search').fill('바레미');
   assert.equal(await page.locator('.trade-row:visible').count(),1);
   await page.locator('#trade-search').fill('없는섬'); assert.equal(await page.locator('#trade-filter-empty').isVisible(),true);
   await page.locator('#trade-search').fill('');
   await page.locator('#open-map-speed').click(); await page.locator('.mv-window').waitFor({state:'visible'}); await shot('map-viewer-1920');
   await page.locator('.mv-header').getByRole('button',{name:'닫기',exact:true}).click();
   assert.equal(await page.locator('.mv-window').isVisible(),false,'closed map cannot intercept input');
   await page.locator('#map-tools-dialog [data-close-dialog]').click();
   // Fixture-backed UI review only; OCR responses are mocked, no recognition accuracy claim.
   await page.route('**/api/recognition/trade-runtime',route=>route.fulfill({json:{ok:true,runtime:{available:true}}}));
   await page.route('**/api/recognition/trade-live-list',route=>{
     const batch=JSON.parse(route.request().postData().match(/name="batch"\r\n\r\n([^\r]+)/)[1]);
     const values={island:'파라타마 섬',fromItem:'대추야자',toItem:'고대 항아리 파편',reqAmount:500,count:10,yield:1};
     const fields=Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{corrected:value,rawOCR:String(value),reviewRequired:key==='count',confidence:.82,...(key==='count'?{box:{x:65,y:35,width:151,height:30}}:{})}]));
     return route.fulfill({json:{ok:true,result:{version:3,batchId:batch.batchId,captures:batch.captures,rows:[{captureId:batch.captures[0].captureId,ordinal:0,rowBox:{x:0,y:0,width:982,height:77},fields}],runtime:{engineId:'ui-fixture',workerVersion:'test',modelBundleSha256:'test'}}}});
   });
   await page.locator('#open-trade-capture').click();
   await page.locator('#trade-capture-files').setInputFiles(resolve(root,'local_app/tests/fixtures/trade-recognition/Codex 이미지 2026년 9월 25일 오후 08_43_53.png'));
   await page.locator('[data-action="recognize-trade"]').click();
   await page.locator('.trade-review-row').waitFor();
   assert.equal(await page.locator('.trade-review-row input[data-field="count"]').isVisible(),true);
   await shot('ocr-review-1920');
   await page.locator('#trade-capture-dialog [data-close-trade-capture]').first().click();
   await page.locator('[data-workspace-view="inventory"]').click(); await page.locator('#open-warehouse-scan').click();
   await page.locator('#warehouse-image').setInputFiles(resolve(root,'local_app/tests/fixtures/warehouse_patch/barter_only.png'));
   await page.evaluate(async imageBytes=>{
     const {openPatchReview}=await import('/assets/js/patch-review.js');
     const slots=[{slot:'A1',tier:1,x:206,y:263,width:50,height:50,bestCandidate:'로아 꽃 씨앗 주머니',bestScore:.96,decision:'QUANTITY_UNKNOWN',quantity:{status:'UNKNOWN',value:null}},{slot:'A2',tier:1,x:52,y:211,width:50,height:50,bestCandidate:'떼 묻은 비단',bestScore:.89,decision:'ICON_MATCH_UNKNOWN',quantity:{status:'QUANTITY_MATCH',value:71}}];
     openPatchReview({type:'master_inventory_patch',version:1,items:{}},{slots,grid:{slotWidth:50}},{setStatus(){},onApplied(){},imageFile:new File([new Uint8Array(imageBytes)],'fixture.png',{type:'image/png'})});
   },[...await readFile(resolve(root,'local_app/tests/fixtures/warehouse_patch/barter_only.png'))]);
   await page.waitForFunction(()=>document.querySelector('.patch-slot-preview')?.getContext('2d').getImageData(30,30,1,1).data[3]>0);
   await shot('warehouse-review-1920');
   await page.locator('.patch-review-header [data-action="cancel"]').click(); await page.locator('#warehouse-scan-dialog [data-action="close"]').click();
   await page.locator('[data-workspace-view="session"]').click();
   for(const size of [{width:1440,height:900},{width:2560,height:1440}]){
     await page.setViewportSize(size);
     await page.waitForFunction(()=>Math.abs(document.body.getBoundingClientRect().width-innerWidth)<2,{},{timeout:3000}).catch(async error=>{console.log(await page.evaluate(()=>({width:innerWidth,body:document.body.getBoundingClientRect().toJSON(),style:document.body.getAttribute('style'),zoom:getComputedStyle(document.body).zoom,root:getComputedStyle(document.documentElement).getPropertyValue('--app-zoom')})));throw error;});
     const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,wide:[...document.querySelectorAll('body *')].filter(n=>n.getBoundingClientRect().right>innerWidth+2&&n.getBoundingClientRect().width>0).slice(0,10).map(n=>({tag:n.tagName,id:n.id,class:n.className,right:n.getBoundingClientRect().right}))}));
     assert.ok(overflow.scroll<=overflow.width+2,`no page horizontal overflow: ${JSON.stringify(overflow)}`);
     await shot(`main-${size.width}`);
     await page.locator('[data-workspace-view="inventory"]').click(); await shot(`inventory-${size.width}`);
     await page.locator('#open-warehouse-scan').click();
     const close=await page.locator('#warehouse-scan-dialog [data-action="close"]').boundingBox();
     assert.ok(close.y>=0&&close.y+close.height<=size.height,'warehouse close inside viewport');
     await shot(`warehouse-${size.width}`); await page.locator('#warehouse-scan-dialog [data-action="close"]').click();
     await page.locator('[data-workspace-view="session"]').click(); await page.locator('#open-schedule').click();
     await shot(`schedule-${size.width}`); await page.locator('#schedule-dialog [data-close-dialog]').click();
   }
   await page.setViewportSize({width:1920,height:1080});
   const denseTrades=JSON.parse(await readFile(resolve(root,'local_app/tests/fixtures/USER_CAPTURE_20260923_74_ROWS.json'),'utf8'));
   await page.evaluate(async trades=>{
     const {state}=await import('/assets/js/state.js');
     state.session.scannedTrades=trades;
     const {renderTradeList}=await import('/assets/js/trade-ui.js'); renderTradeList();
   },denseTrades);
   await shot('dense-session-1920');
   assert.deepEqual(errors,[]);
 }
 await writeFile(join(out,`${phase}-audit.json`),JSON.stringify({status:'PASS',phase,errors,viewports:(phase==='before'?[[1920,1080]]:[[1920,1080],[1440,900],[2560,1440]]).map(([width,height])=>({width,height,zoom:100})),database:temp,ocr:'mocked fixture for visual review',userDataWrites:0},null,2));
 console.log(JSON.stringify({status:'PASS',phase,errors,output:out}));
}finally{await browser?.close();server.kill();}
