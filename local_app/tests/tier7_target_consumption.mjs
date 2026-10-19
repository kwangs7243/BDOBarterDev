import assert from 'node:assert/strict';
import vm from 'node:vm';
import {environment, audit} from './scheduler_departure_causality.mjs';
const A='102년 묵은 황금초', B='팔랑나비 박제품', T4='자수정 파편';
function row(island, fromClean, toClean, fromTier, toTier, count) {
  return {island, fromClean, toClean, fromTier, toTier, count, origC:count, currentC:count,
    reqA:1, mult:1, isCoin:false, isSpec:false, isRandomCoin:false, score:100000};
}
function run(stock, {target=8, demand=5, mode='speed', budget=1250000, normal=22689, extra=[], chain=true}={}) {
  const {ctx,elements}=environment(); elements.maxParley.value=budget; elements.normalWeight.value=normal;
  ctx.initialInventory={[T4]:{stock:50,target:0},[A]:{stock,target},[B]:{stock:3,target:8}};
  ctx.input=[...(chain?[row('아지르 섬',T4,A,4,5,6)]:[]),
    row('하코번 섬',A,'발렌시아 사막 보검',5,6,demand),
    row('일리야 섬','발렌시아 사막 보검','최고급 하이델산 포도주',6,7,demand),...extra];
  ctx.weightMode=mode;
  vm.runInContext(`APP_CONFIG.ALLOW_OCEAN='t7_3region'; inventory=JSON.parse(JSON.stringify(initialInventory));
    plan=buildTier7Sorties(input,'t7_3region',weightMode).sorties;
    forecast=forecastWarehouseInventory(plan); validation=validateSortieSequence(plan); unchanged=inventory;`,ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.unchanged)),ctx.initialInventory,'planning cannot change inventory');
  assert.equal(ctx.validation.valid,true);
  const checked=audit(ctx.plan,ctx.initialInventory,normal,40259,mode,10278,15576,budget);
  assert.equal(checked.endingStock[A],ctx.forecast[A].stock);
  return {...{ctx,elements}, plan:ctx.plan, checked};
}
for(const mode of ['speed','balance']) {
  for(const [stock,phase1End,finalStock,produces] of [[7,8,8,true],[8,3,9,false],[13,8,8,false],[20,15,15,false]]) {
    const {plan,checked}=run(stock,{mode}); const first=plan[0];
    assert.equal(first.trades.some(t=>t.toTier===5),produces);
    assert.equal(first.trades.find(t=>t.toTier===6).execC,5);
    assert.equal(first.trades.find(t=>t.toTier===7).execC,5);
    assert.equal(first.reqItems[produces?T4:A].count,produces?6:5);
    assert.equal(first.startWeight,produces?6000:5000);
    assert.equal(first.parleyUsed,(produces?16:10)*10278);
    const replenishment=plan.slice(1).flatMap(s=>s.trades).filter(t=>t.toTier===5);
    assert.equal(replenishment.length,stock===8?1:0);
    if(replenishment.length)assert.equal(replenishment[0].execC,6);
    assert.equal(checked.endingStock[A],finalStock);
    console.log(JSON.stringify({mode,target:8,stock,phase1End,finalStock}));
  }
}
{
 const extra=[row('푸자라 섬',T4,B,4,5,6),row('아레하자 마을',B,'최고급 감투 상자',5,6,5)];
 const {plan}=run(10,{extra}); const first=plan[0];
 assert.ok(!first.trades.some(t=>t.toTier===5&&t.toClean===A));
 assert.equal(first.trades.find(t=>t.toTier===5&&t.toClean===B).execC,6);
 assert.equal(first.reqItems[A].count,5);
}
{
 const {plan}=run(8,{extra:[row('달래나루',A,'최고급 감투 상자',5,6,5)]});
 assert.ok(!plan[0].trades.some(t=>t.toTier===5));
 assert.equal(plan[1].trades.find(t=>t.toTier===5).execC,6,'west sees east forecast=3 and may produce');
 assert.equal(plan[0].reqItems[A].count,5);
 assert.equal(plan[1].reqItems[A],undefined);
}
{
 const {plan}=run(8,{demand:10});
 assert.equal(plan[0].trades.find(t=>t.toTier===6).execC,8,'stock caps demand without hybrid production');
 assert.ok(!plan[0].trades.some(t=>t.toTier===5));
}
for(const stock of [0,4])assert.equal(run(stock).plan[0].trades.find(t=>t.toTier===5).execC,6);
assert.equal(run(0,{target:0}).plan[0].trades.find(t=>t.toTier===5).execC,6,"zero stock has no cargo to consume; preserve feasible chain fallback");
assert.ok(!run(4,{target:0}).plan[0].trades.some(t=>t.toTier===5));
assert.equal(run(4,{chain:false}).plan[0].trades.find(t=>t.toTier===6).execC,4);
run(8,{normal:10000});run(8,{normal:9999});
assert.equal(run(8,{budget:10*10278}).plan[0].trades.find(t=>t.toTier===7).execC,5);
assert.ok(run(8,{budget:10*10278-1}).plan[0].trades.find(t=>t.toTier===7).execC<5);
{
 const {ctx,plan,elements}=run(20); ctx.btn={classList:{replace(){},remove(){},add(){}},closest(){return null}};
 ctx.direct=plan[0];
 vm.runInContext(`sortiesSpeed=[direct];scannedTrades=[{count:5}];completeTrade(btn,'speed',0,0,0);
   completedStock=inventory['102년 묵은 황금초'].stock;completeTrade(btn,'speed',0,0,0);
   duplicateStock=inventory['102년 묵은 황금초'].stock;`,ctx);
 assert.equal(ctx.completedStock,15);assert.equal(ctx.duplicateStock,15);
 assert.equal(Number(elements.maxParley.value),1250000-5*10278);
}
{
 let stock=8;const seen=[];
 for(let i=0;i<12;i++){stock=run(stock).checked.endingStock[A];seen.push(stock);}
 assert.deepEqual(seen,[9,10,11,12,13,8,9,10,11,12,13,8]);
}
console.log('PASS: T7 target consumption, replenishment, causality, weights, parley and completion');
