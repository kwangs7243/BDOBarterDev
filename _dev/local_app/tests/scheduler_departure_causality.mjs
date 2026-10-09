import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import vm from 'node:vm';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const out=resolve(root,'_dev/recognition-local/scheduler-improved');
const catalog=JSON.parse(readFileSync(resolve(root,'_dev/local_app/frontend/data/trade-catalog.json'),'utf8'));
const weights={1:100,2:400,3:900,4:1000,5:1000,6:2000,7:2000,coin:0};
const weight=(tier,name)=>tier===0||tier==='mat'?catalog.itemWeights[name]:weights[tier];
export function environment(){
 const elements=Object.fromEntries(Object.entries({normalWeight:22689,maxWeight:40259,maxParley:1250000,parleyPerTrade:10278,parleyCrow:15576,'retry-completion-save':0}).map(([k,v])=>[k,{value:v,hidden:true}]));
 const messages=[];const ctx={console:{log(){},warn(){}},document:{getElementById:id=>elements[id]||null,querySelector:()=>null,querySelectorAll:()=>[]},alert:m=>messages.push(m),renderModeColumn(){},CustomEvent:class{},dispatchEvent(){},crypto:globalThis.crypto,setTimeout,clearTimeout,setInterval(){},clearInterval(){}};ctx.window=ctx;vm.createContext(ctx);
 for(const name of ['constants','routing','scheduler','tier7','schedule-edit','timer-ui','completion','scheduler-runtime'])vm.runInContext(readFileSync(resolve(root,'_dev/local_app/frontend/js/domain/'+name+'.js'),'utf8'),ctx,{filename:name});
 ctx.showToast=m=>messages.push(m);return {ctx,elements,messages};
}
export function audit(sorties,initial,normal,max,mode,normalCost,coinCost,budget){
 const stock=Object.fromEntries(Object.entries(initial).map(([name,x])=>[name,x.stock]));let totalCost=0;
 for(const [si,s] of sorties.entries()){
  const cargo={},tiers={};let w=0;
  for(const [name,req] of Object.entries(s.reqItems)){
   cargo[name]=req.count;tiers[name]=req.tier;w+=req.count*weight(req.tier,name);
   if(Number.isInteger(req.tier)&&req.tier>=1&&req.tier<=7){assert.ok(Number.isSafeInteger(stock[name]??0)&&req.count<=(stock[name]??0),`departure ${si+1}: ${name} ${req.count} > ${stock[name]??0}`);stock[name]=(stock[name]??0)-req.count;}
  }
  assert.ok(Math.abs(w-s.startWeight)<1e-6);assert.ok(w<=normal+1e-6);
  let cost=0;
  for(const [ti,t] of s.trades.entries()){
   const before=w,x=t.isWaypoint?t.consumed:{name:t.fromClean,tier:t.fromTier,count:t.execC*t.reqA};
   if(x){assert.ok((cargo[x.name]||0)>=x.count,`boat ${si+1}/${ti+1}: ${x.name}`);cargo[x.name]-=x.count;w-=x.count*weight(x.tier,x.name);tiers[x.name]=x.tier;}
   if(!t.isWaypoint){cargo[t.toClean]=(cargo[t.toClean]||0)+t.execC*t.mult;tiers[t.toClean]=t.toTier;w+=t.execC*t.mult*weight(t.toTier,t.toClean);cost+=t.execC*(t.isCoin?coinCost:normalCost);}
   assert.ok(w>=-1e-6&&w<=(mode==='speed'?normal:max)+1e-6);assert.ok(Math.abs(w-t.afterW)<1e-6);assert.equal(t.over,before>normal);
  }
  assert.equal(cost,s.parleyUsed);totalCost+=cost;assert.ok(totalCost<=budget);assert.equal(s.returnOver,w>normal);
  for(const [name,count] of Object.entries(cargo))if(Number.isInteger(tiers[name])&&tiers[name]>=1&&tiers[name]<=7)stock[name]=(stock[name]??0)+count;
 }
 return {departures:sorties.length,plannedCost:totalCost,endingStock:stock};
}
export function runRegression(){
const results=[];
{
 const {ctx}=environment();
 vm.runInContext(`APP_CONFIG.ALLOW_OCEAN='t7_3region';inventory={'자수정 파편':{stock:6,target:80},'팔랑나비 박제품':{stock:5,target:5},'102년 묵은 황금초':{stock:10,target:5}};
 function sample(island,fromClean,toClean,fromTier,toTier,count,mult=1){return {island,fromClean,toClean,fromTier,toTier,count,currentC:count,reqA:1,mult,isCoin:toTier==='coin',isSpec:false,isRandomCoin:false,score:100000,lack:99};}
 initial=JSON.parse(JSON.stringify(inventory));
 const rows=[sample('하코번 섬','팔랑나비 박제품','발렌시아 사막 보검',5,6,5),sample('아지르 섬','자수정 파편','102년 묵은 황금초',4,5,6),sample('달래나루','102년 묵은 황금초','최고급 감투 상자',5,6,5),sample('할마드 섬','자수정 파편','까마귀 주화',4,'coin',1,171)];
 plan=buildTier7Sorties(rows,'t7_3region','speed').sorties;`,ctx);
 const amethyst=ctx.plan.reduce((n,s)=>n+(s.reqItems['자수정 파편']?.count||0),0);
 assert.ok(amethyst<=6);assert.equal(ctx.plan[0].reqItems['자수정 파편'].count,1);
 assert.ok(!ctx.plan[1].trades.some(t=>t.fromClean==='자수정 파편'&&t.execC===6));
 assert.ok(ctx.plan[1].trades.some(t=>t.fromClean==='102년 묵은 황금초'&&t.execC===5));
 results.push({test:'amethyst earlier-departure deduction',...audit(ctx.plan,ctx.initial,22689,40259,'speed',10278,15576,1250000)});
}
{
 const {ctx,elements}=environment();elements.normalWeight.value=800;elements.maxWeight.value=800;
 vm.runInContext(`APP_CONFIG.ALLOW_OCEAN='inner';inventory={'갈퀴 꽃 씨앗 주머니':{stock:23,target:0},'괴생물 촉수':{stock:0,target:20},'정제된 식수':{stock:0,target:20},'성게 가시':{stock:0,target:20}};initial=JSON.parse(JSON.stringify(inventory));
 scannedTrades=[{island:'베이루와 섬',fromItem:'갈퀴 꽃 씨앗 주머니',toItem:'괴생물 촉수',count:1,reqAmount:1,yield:2},{island:'나르보 섬',fromItem:'갈퀴 꽃 씨앗 주머니',toItem:'정제된 식수',count:1,reqAmount:1,yield:2},{island:'타슈 섬',fromItem:'갈퀴 꽃 씨앗 주머니',toItem:'성게 가시',count:1,reqAmount:1,yield:2}];runAlgorithmAllModes(true);plan=sortiesSpeed;`,ctx);
 assert.equal(ctx.plan.length,3);results.push({test:'ordinary previous consumption counted once',...audit(ctx.plan,ctx.initial,800,800,'speed',10278,15576,1250000)});
}
{
 const {ctx}=environment();vm.runInContext(`
 a={island:'베이루와 섬',fromTier:1,fromClean:'갈퀴 꽃 씨앗 주머니',toTier:2,toClean:'괴생물 촉수',execC:1,reqA:1,mult:2,originalIndex:0};
 b={island:'나르보 섬',fromTier:2,fromClean:'괴생물 촉수',toTier:3,toClean:'종유석 파편',execC:3,reqA:1,mult:1,originalIndex:1};
 s={trades:[a,b]};rebuildSortieReq(s);sim=simulateWeightsTemp(s.trades,22689);
 forecast=forecastWarehouseInventory([{trades:[a,{...b,execC:2}]}],{'갈퀴 꽃 씨앗 주머니':{stock:1},'괴생물 촉수':{stock:0}});
 invalid=validateSortieSequence([{trades:[a,{...b,execC:2}]},{trades:[{...b,execC:1}]}],{'갈퀴 꽃 씨앗 주머니':{stock:1},'괴생물 촉수':{stock:0}});`,ctx);
 assert.equal(ctx.sim.startW,1300);assert.equal(ctx.s.reqItems['괴생물 촉수'].count,3);assert.equal(ctx.forecast['괴생물 촉수'].stock,0);assert.equal(ctx.invalid.valid,false);
 results.push({test:'whole-batch chain weight and earlier generated material actually consumed',startW:ctx.sim.startW});
}
{
 const {ctx,messages}=environment();vm.runInContext(`inventory={'갈퀴 꽃 씨앗 주머니':{stock:1},'괴생물 촉수':{stock:0},'종유석 파편':{stock:0}};
 a={island:'베이루와 섬',fromTier:1,fromClean:'갈퀴 꽃 씨앗 주머니',toTier:2,toClean:'괴생물 촉수',execC:1,reqA:1,mult:2,originalIndex:0};
 b={island:'나르보 섬',fromTier:2,fromClean:'괴생물 촉수',toTier:3,toClean:'종유석 파편',execC:2,reqA:1,mult:1,originalIndex:1};
 scannedTrades=[{count:10},{count:10}];sortiesSpeed=[{trades:[a,b]}];rebuildSortieReq(sortiesSpeed[0]);
 draggedRoute={sortieIdx:0,tradeIdx:1,mode:'speed'};routeDrop({preventDefault(){},currentTarget:{classList:{remove(){}}}},0,0,'speed');
 routeFirst=sortiesSpeed[0].trades[0].fromClean;
 sortiesSpeed=[{trades:[a]},{trades:[b]}];sortiesSpeed.forEach(rebuildSortieReq);
 draggedSortie={sortieIdx:1,mode:'speed'};sortieDrop({preventDefault(){}},0,'speed');departureFirst=sortiesSpeed[0].trades[0].fromClean;`,ctx);
 assert.equal(ctx.routeFirst,'갈퀴 꽃 씨앗 주머니');assert.equal(ctx.departureFirst,'갈퀴 꽃 씨앗 주머니');assert.equal(messages.length,2);
 results.push({test:'route and departure reorder cannot use future cargo'});
}
{
 const {ctx,messages}=environment();vm.runInContext(`inventory={'자수정 파편':{stock:6,target:0},'102년 묵은 황금초':{stock:0,target:0}};
 scannedTrades=[{count:10},{count:10}];
 a={island:'할마드 섬',fromTier:4,fromClean:'자수정 파편',toTier:'coin',toClean:'까마귀 주화',execC:1,reqA:1,mult:171,originalIndex:0,isCoin:true};
 b={island:'아지르 섬',fromTier:4,fromClean:'자수정 파편',toTier:5,toClean:'102년 묵은 황금초',execC:5,reqA:1,mult:1,originalIndex:1};
 sortiesSpeed=[{trades:[a]},{trades:[b]}];sortiesSpeed.forEach(rebuildSortieReq);adjustTradeCount({stopPropagation(){}},'speed',1,0,1);`,ctx);
 assert.equal(vm.runInContext('b.execC',ctx),5);assert.ok(messages.some(m=>m.includes('재료')));results.push({test:'manual count cannot allocate prior departure stock twice'});
}
{
 const {ctx}=environment();vm.runInContext(`
 producer={island:'하코번 섬',fromTier:5,fromClean:'정체불명의 암석',toTier:6,toClean:'발렌시아 사막 보검',execC:1,reqA:1,mult:1,originalIndex:0};
 consumer={island:'올비아 해안',fromTier:6,fromClean:'발렌시아 사막 보검',toTier:7,toClean:'최고급 하이델산 포도주',execC:1,reqA:1,mult:1,originalIndex:1};
 const schedule=[{trades:[producer,consumer]}];before=canCompleteScheduleStep(schedule,0,1);producer.completed=true;after=canCompleteScheduleStep(schedule,0,1);
 producer.completed=false;nextDeparture=canCompleteScheduleStep([{trades:[producer]},{trades:[consumer]}],1,0);`,ctx);
 assert.equal(ctx.before,false);assert.equal(ctx.after,true);assert.equal(ctx.nextDeparture,false);results.push({test:'completion requires preceding producer and departure'});
}
{
 const {ctx,messages}=environment();vm.runInContext(`inventory={'갈퀴 꽃 씨앗 주머니':{stock:3,target:0},'괴생물 촉수':{stock:0,target:0}};
 a={island:'베이루와 섬',fromTier:1,fromClean:'갈퀴 꽃 씨앗 주머니',toTier:2,toClean:'괴생물 촉수',execC:1,reqA:1,mult:2,originalIndex:0};
 const waypoint={isWaypoint:true,island:'일리야 섬',completed:true};
 c={...a,island:'나르보 섬',originalIndex:1};sortiesSpeed=[{trades:[a,waypoint,c]}];rebuildSortieReq(sortiesSpeed[0]);
 draggedRoute={sortieIdx:0,tradeIdx:2,mode:'speed'};routeDrop({preventDefault(){},currentTarget:{classList:{remove(){}}}},0,0,'speed');
 firstIsland=sortiesSpeed[0].trades[0].island;`,ctx);
 assert.equal(ctx.firstIsland,'베이루와 섬');assert.ok(messages.some(m=>m.includes('완료한 교환')));results.push({test:'route edits cannot cross already completed steps'});
}
for(const initial5 of [5,8,20]){
 const {ctx}=environment();ctx.initial5=initial5;vm.runInContext(`APP_CONFIG.ALLOW_OCEAN='t7_3region';inventory={'자수정 파편':{stock:6,target:80},'102년 묵은 황금초':{stock:initial5,target:5}};
 const rows=[{island:'아지르 섬',fromClean:'자수정 파편',toClean:'102년 묵은 황금초',fromTier:4,toTier:5,count:6,origC:6,reqA:1,mult:1,score:100000},
 {island:'달래나루',fromClean:'102년 묵은 황금초',toClean:'최고급 감투 상자',fromTier:5,toTier:6,count:5,reqA:1,mult:1,score:999999}];
 plan=buildTier7Sorties(rows,'t7_3region','speed').sorties;`,ctx);
 assert.ok(!ctx.plan[0].trades.some(t=>t.toTier===5));
 assert.equal(ctx.plan[0].reqItems['102년 묵은 황금초'].count,5);
 const replenished=ctx.plan.slice(1).flatMap(s=>s.trades).filter(t=>t.toTier===5);
 assert.equal(replenished.length,initial5-5<5?1:0);
 if(replenished.length)assert.equal(replenished[0].execC,6);
 results.push({test:'tier5 target consumption and whole-batch replenishment',initial5});
}
{
 const {ctx}=environment();vm.runInContext(`
 const next={fromClean:'갈퀴 꽃 씨앗 주머니',fromTier:1,toClean:'괴생물 촉수',toTier:2,execC:1,reqA:1,mult:2};
 const cancelled={execC:0,completed:false};
 zeroCountAllowed=canCompleteScheduleStep([{trades:[cancelled]},{trades:[next]}],1,0);
 activeCountBlocked=canCompleteScheduleStep([{trades:[{...cancelled,execC:1}]},{trades:[next]}],1,0);
 waypointBlocked=canCompleteScheduleStep([{trades:[{isWaypoint:true,completed:false}]},{trades:[next]}],1,0);`,ctx);
 assert.equal(ctx.zeroCountAllowed,true);assert.equal(ctx.activeCountBlocked,false);assert.equal(ctx.waypointBlocked,false);
 results.push({test:'zero-count trades do not block later departures while real trades and waypoints still do'});
}
mkdirSync(out,{recursive:true});
writeFileSync(resolve(out,'causality-regression.json'),JSON.stringify({ok:true,results},null,2));console.log(JSON.stringify({ok:true,tests:results.length,results},null,2));

}
if(resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) runRegression();
