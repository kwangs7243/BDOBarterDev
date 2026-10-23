import assert from 'node:assert/strict';
import vm from 'node:vm';
import {environment} from './scheduler_departure_causality.mjs';

const button = () => ({innerHTML:'',classList:{replace(){},remove(){},add(){}},closest(){return null}});
const plain = value => JSON.parse(JSON.stringify(value));
for (const stock of [2, null, undefined, 0, 5, 9]) {
  const {ctx} = environment();
  ctx.stock = stock; ctx.btn = button();
  vm.runInContext(`
    waypoint={isWaypoint:true,island:'일리야 섬',toClean:'wp-test',timerActive:true,
      consumed:{name:'갈퀴 꽃 씨앗 주머니',tier:1,count:5},completed:false};
    appState={revision:1,inventory:stock===undefined?[]:[{programName:'갈퀴 꽃 씨앗 주머니',tier:1,stock,target:0}],
      settings:{ship:{},parley:{},tuning:{}},session:{id:'test',scannedTrades:[],remainingParley:100,
        schedule:{speed:[{trades:[waypoint]}],balance:[]},timers:{'일리야 섬_wp-test':{endTime:123}}}};
    syncLegacyState(appState);saved=[];
    installCompletionAdapters(async p=>{saved.push(p);},appState,()=>{});
    // Legacy stock is stale; the adapter must re-read appState before validating.
    inventory['갈퀴 꽃 씨앗 주머니']={stock:100};
    completeWaypoint(btn,'speed',0,0);
    completeWaypoint(btn,'speed',0,0);
    result={completed:waypoint.completed,stock:inventory['갈퀴 꽃 씨앗 주머니']?.stock,
      timerActive:waypoint.timerActive,timerPresent:!!ACTIVE_TIMERS['일리야 섬_wp-test'],saved};`,ctx);
  const ok = Number.isSafeInteger(stock) && stock >= 5;
  assert.equal(ctx.result.completed,ok,`stock=${stock}`);
  assert.equal(ctx.result.saved.length,ok?1:0);
  assert.equal(ctx.result.stock,ok?stock-5:stock);
  if (!ok) {
    assert.equal(ctx.result.timerActive,true,'rejection must preserve the running timer');
    assert.equal(ctx.result.timerPresent,true);
    assert.equal(ctx.btn.innerHTML,'');
  } else assert.equal(ctx.result.saved[0].patch.items['갈퀴 꽃 씨앗 주머니'].stock,stock-5);
}
for (const consumed of [null,{name:'육지품',tier:0,count:5}]) {
  const {ctx} = environment(); ctx.consumed=consumed;ctx.btn=button();
  vm.runInContext(`
    waypoint={isWaypoint:true,island:'일리야 섬',toClean:'wp',consumed,completed:false};
    appState={revision:1,inventory:[],settings:{ship:{},parley:{},tuning:{}},
      session:{id:'test',scannedTrades:[],remainingParley:100,schedule:{speed:[{trades:[waypoint]}],balance:[]}}};
    syncLegacyState(appState);saved=[];
    installCompletionAdapters(async p=>{saved.push(p);},appState,()=>{});
    completeWaypoint(btn,'speed',0,0);`,ctx);
  assert.equal(ctx.waypoint.completed,true);
  assert.deepEqual(plain(ctx.saved[0].patch.items),{});
}

for (const [normalCost,crowCost] of [[0,0],[0,15576],[10278,0],[10278,15576]]) {
  for (const mode of ['speed','balance']) {
    const {ctx,elements} = environment();
    elements.parleyPerTrade.value=String(normalCost);elements.parleyCrow.value=String(crowCost);
    vm.runInContext(`
      inventory={'팔랑나비 박제품':{stock:20,target:8},'청동 촛대':{stock:10,target:0}};
      APP_CONFIG.ALLOW_OCEAN='t7_2region';
      function row(island,fromClean,toClean,fromTier,toTier,count,mult=1){return {island,fromClean,toClean,fromTier,toTier,
        count,currentC:count,reqA:1,mult,isCoin:toTier==='coin',isSpec:false,isRandomCoin:false,score:200000,lack:100};}
      input=[row('하코번 섬','팔랑나비 박제품','발렌시아 사막 보검',5,6,5),
        row('일리야 섬','발렌시아 사막 보검','최고급 하이델산 포도주',6,7,5),
        row('할마드 섬','청동 촛대','까마귀 주화',4,'coin',1,171)];`,ctx);
    ctx.mode=mode;
    vm.runInContext(`plan=buildTier7Sorties(input,'t7_2region',mode).sorties;`,ctx);
    const trades=ctx.plan.flatMap(s=>s.trades);
    assert.equal(trades.filter(t=>t.toTier===6||t.toTier===7).reduce((sum,t)=>sum+t.execC,0),10);
    assert.ok(trades.some(t=>t.isCoin),'coin fixture must exercise crow cost');
    for (const sortie of ctx.plan) {
      const expected=sortie.trades.reduce((sum,t)=>sum+t.execC*(t.isCoin?crowCost:normalCost),0);
      assert.equal(sortie.parleyUsed,expected);
      ctx.sortie=sortie;vm.runInContext('rebuildSortieReq(sortie);',ctx);
      assert.equal(sortie.parleyUsed,expected,'route editing must keep the configured zero cost');
    }
    for (const isCoin of [false,true]) {
      ctx.isCoin=isCoin;ctx.btn=button();
      elements.maxParley.value=1250000;
      vm.runInContext(`
        inventory={'청동 촛대':{stock:10}};
        sortiesSpeed=[{trades:[{island:'할마드 섬',fromClean:'청동 촛대',fromTier:4,
          toClean:isCoin?'까마귀 주화':'test',toTier:isCoin?'coin':6,execC:2,reqA:1,mult:1,isCoin}]}];
        scannedTrades=[];completeTrade(btn,'speed',0,0);`,ctx);
      assert.equal(Number(elements.maxParley.value),1250000-2*(isCoin?crowCost:normalCost));
    }
  }
}
console.log('PASS: waypoint shortage/unknown stock reject without mutations, exact deduction is once-only, no-material/land waypoints work; T7 generation, editing and completion retain zero normal/crow costs');
