import assert from 'node:assert/strict';
import vm from 'node:vm';
import {environment,audit} from './scheduler_departure_causality.mjs';

function ordinaryCandidate({distancePenalty = 0, pathBonus = 0, t1Priority = 0, landOutput = false,
  tier1Reserve = 20, sourceStock = 40} = {}) {
  const {ctx,elements} = environment();
  vm.runInContext(`
    APP_CONFIG.ALLOW_OCEAN='inner';
    APP_CONFIG.DISTANCE_PENALTY_WEIGHT=${distancePenalty};
    APP_CONFIG.PATH_EFFICIENCY_BONUS=${pathBonus};
    APP_CONFIG.tunePenW=9000;
    APP_CONFIG.tuneScore=9000000;
    APP_CONFIG.EFFICIENCY_THRESHOLD=999999;
    APP_CONFIG.TIER_PRIORITY.T1=${t1Priority};
    tierRules={1:${tier1Reserve},2:20,3:20,4:20,5:2};
    inventory=${landOutput
      ? `{'갈퀴 꽃 씨앗 주머니':{stock:0,target:20}}`
      : `{'갈퀴 꽃 씨앗 주머니':{stock:${sourceStock},target:0},'괴생물 촉수':{stock:0,target:20}}`};
    scannedTrades=[${landOutput
      ? `{island:'올비아 해안',fromItem:'대추야자',toItem:'갈퀴 꽃 씨앗 주머니',count:10,reqAmount:1,yield:1}`
      : `{island:'올비아 해안',fromItem:'갈퀴 꽃 씨앗 주머니',toItem:'괴생물 촉수',count:10,reqAmount:1,yield:2}`}];
    runAlgorithmAllModes(true);
    const item=sortiesSpeed.flatMap(s=>s.trades).find(t=>!t.isWaypoint);
    const candidate=sortiesSpeed[0]?.routingLogs?.[0]?.candidates?.find(t=>t.item===item?.toClean);
    globalThis.p1Measure={score:item?.debug?.score,fitness:candidate?.fitness,
      executions:sortiesSpeed.flatMap(s=>s.trades).filter(t=>!t.isWaypoint).reduce((sum,t)=>sum+t.execC,0),
      initialScore:window.ENGINE_DEBUG?.speed?.initialScores?.[0]?.score};
  `, ctx);
  return ctx.p1Measure;
}

// P1-1: a split trade is decremented once even when `picked` aliases `remaining`.
{
  const {ctx,elements} = environment();
  elements.normalWeight.value = 1500;
  elements.maxWeight.value = 1500;
  vm.runInContext(`
    APP_CONFIG.ALLOW_OCEAN='inner';
    inventory={
      '갈퀴 꽃 씨앗 주머니':{stock:40,target:0},
      '괴생물 촉수':{stock:0,target:20}
    };
    scannedTrades=[{island:'올비아 해안',fromItem:'갈퀴 꽃 씨앗 주머니',
      toItem:'괴생물 촉수',count:10,reqAmount:1,yield:2}];
    globalThis.genResult=runAlgorithmAllModes(true);
    const executions=sortiesSpeed.flatMap(s=>s.trades)
      .filter(t=>!t.isWaypoint&&t.originalIndex===0).reduce((n,t)=>n+t.execC,0);
    const countBound=sortiesSpeed.flatMap(s=>s.trades)
      .filter(t=>!t.isWaypoint&&t.originalIndex===0).every(t=>t.execC<=10);
    globalThis.splitP1={executions,countBound};
  `, ctx);
  assert.equal(ctx.splitP1.executions, 10, 'all ten requested executions must be scheduled');
  assert.equal(ctx.splitP1.countBound, true, 'scheduled executions must not exceed source count');
}

// P1-4: the canonical persistent keys drive the real candidate score calculation.
{
  const zeroDistance = ordinaryCandidate({distancePenalty:0});
  const highDistance = ordinaryCandidate({distancePenalty:1000});
  assert.notEqual(zeroDistance.fitness, highDistance.fitness,
    'DISTANCE_PENALTY_WEIGHT must affect candidate fitness');
  const zeroPath = ordinaryCandidate({pathBonus:0});
  const highPath = ordinaryCandidate({pathBonus:999999});
  assert.notEqual(zeroPath.fitness, highPath.fitness,
    'PATH_EFFICIENCY_BONUS must affect an efficient candidate');
}

// P1-5: zero is a valid configured number for reserve, priority, and tuning.
{
  const noReserve = ordinaryCandidate({tier1Reserve:0,sourceStock:1});
  assert.equal(noReserve.executions, 1, 'zero T1 reserve exposes the one available input stock');
  const noT1Priority = ordinaryCandidate({t1Priority:0,landOutput:true});
  assert.equal(noT1Priority.score, 520000, 'zero T1 priority must not become the 5000 fallback');
  assert.equal(ordinaryCandidate({distancePenalty:0}).fitness,
    ordinaryCandidate({distancePenalty:0,pathBonus:0}).fitness, 'explicit tuning zero remains effective');
  const {ctx} = environment();
  assert.equal(vm.runInContext('schedulerNumberOrDefault(null,20)',ctx),20);
  assert.equal(vm.runInContext('schedulerNumberOrDefault(NaN,20)',ctx),20);
  assert.equal(vm.runInContext('schedulerNumberOrDefault(0,20)',ctx),0);
}

// P1-7: an unexecutable supplier cannot reserve projected demand ahead of a feasible supplier.
{
  function scheduleSupplierOrder(reverseSuppliers) {
    const {ctx} = environment();
    vm.runInContext(`
      APP_CONFIG.ALLOW_OCEAN='inner';
      tierRules={1:20,2:20,3:20,4:20,5:2};
      const tier1=masterData[1].map(x=>x.name), tier2=masterData[2].map(x=>x.name);
      const tier3=masterData[3][0].name;
      inventory={[tier1[0]]:{stock:40,target:0},[tier2[0]]:{stock:${reverseSuppliers==='below-reserve'?19:0},target:0},
        [tier2[1]]:{stock:0,target:0},[tier2[2]]:{stock:0,target:1},[tier3]:{stock:0,target:1}};
      const impossible={island:'베이루와 섬',fromItem:tier2[1],toItem:tier3,count:1,reqAmount:1,yield:1};
      const feasible={island:'나르보 섬',fromItem:tier2[0],toItem:tier3,count:1,reqAmount:1,yield:1};
      const chain={island:'타슈 섬',fromItem:tier1[0],toItem:tier2[0],count:1,reqAmount:1,yield:1};
      const support={island:'에버딘 섬',fromItem:tier1[0],toItem:tier2[2],count:1,reqAmount:1,yield:1};
      scannedTrades=${reverseSuppliers === 'impossible-first'
        ? `[impossible,feasible,chain,support]` : reverseSuppliers
        ? `[chain,feasible,impossible,support]`
        : `[chain,impossible,feasible,support]`};
      globalThis.supplierInitial=JSON.parse(JSON.stringify(inventory));
      const beforeInput=JSON.stringify({inventory,scannedTrades});
      const originalBuildSorties=buildSorties;
      globalThis.projectionRows=[];
      buildSorties=(trades,mode)=>{
        if(mode==='speed')globalThis.projectionRows=trades.map(t=>({island:t.island,currentC:t.currentC,count:t.count,origC:t.origC}));
        return originalBuildSorties(trades,mode);
      };
      runAlgorithmAllModes(true);
      buildSorties=originalBuildSorties;
      globalThis.supplierP1={inputUnchanged:beforeInput===JSON.stringify({inventory,scannedTrades}),
        impossibleProjection:projectionRows.find(t=>t.island==='베이루와 섬'),
        modes:[sortiesSpeed,sortiesBalance].map(plan=>({plan,
          feasible:plan.flatMap(s=>s.trades).some(t=>t.island==='나르보 섬'),
          impossible:plan.flatMap(s=>s.trades).some(t=>t.island==='베이루와 섬'),
          chain:plan.flatMap(s=>s.trades).some(t=>t.toClean===tier2[0]),
          support:plan.flatMap(s=>s.trades).some(t=>t.toClean===tier2[2]),
          seed:plan[0]?.seedIsland,
          valid:validateSortieSequence(plan,inventory).valid
        }))};
    `, ctx);
    return {outcome:ctx.supplierP1,initial:ctx.supplierInitial};
  }
  for (const order of [false,true,'impossible-first','below-reserve']) {
    const {outcome,initial} = scheduleSupplierOrder(order);
    assert.equal(outcome.inputUnchanged,true,'seed probes cannot mutate source inventory or trades');
    for (const [index,mode] of outcome.modes.entries()) {
      assert.equal(mode.feasible, true, `feasible supplier survives order=${order} mode=${index}`);
      assert.equal(mode.chain, true, `chain producer remains available order=${order} mode=${index}`);
      assert.equal(mode.support, true, `fourth fixture row remains schedulable order=${order} mode=${index}`);
      assert.equal(mode.impossible, false, `unexecutable supplier is not planned order=${order} mode=${index}`);
      assert.equal(mode.seed,'나르보 섬','zero warehouse source can still qualify through its producer chain');
      assert.equal(mode.valid,true,'supplier plans preserve sequential inventory validation');
      assert.ok(mode.plan.flatMap(s=>s.trades).every(t=>t.execC===1),'one-count input rows cannot be overallocated');
      audit(mode.plan,initial,22689,40259,index===0?'speed':'balance',10278,15576,1250000);
    }
    assert.deepEqual({...outcome.impossibleProjection}, {island:'베이루와 섬',currentC:1,count:1,origC:1},
      `projection must not erase the impossible final candidate order=${order}`);
  }
}

// Before the fix, a one-exchange budget chose the first equally scored feasible supplier.
// Preserve that baseline in both input orders and both weight modes.
for (const reverse of [false,true]) {
  const {ctx,elements} = environment();
  elements.maxParley.value=10278;
  vm.runInContext(`
    APP_CONFIG.ALLOW_OCEAN='inner';
    tierRules={1:20,2:20,3:20,4:20,5:2};
    const sourceA=masterData[2][1].name,sourceB=masterData[2][0].name,output=masterData[3][0].name;
    inventory={[sourceA]:{stock:40,target:0},[sourceB]:{stock:40,target:0},[output]:{stock:0,target:1}};
    const a={island:'베이루와 섬',fromItem:sourceA,toItem:output,count:1,reqAmount:1,yield:1};
    const b={island:'나르보 섬',fromItem:sourceB,toItem:output,count:1,reqAmount:1,yield:1};
    scannedTrades=${reverse?'[b,a]':'[a,b]'};
    runAlgorithmAllModes(true);
    globalThis.feasibleTie=[sortiesSpeed,sortiesBalance].map(plan=>({
      seed:plan[0]?.seedIsland,islands:plan.flatMap(s=>s.trades).map(t=>t.island)
    }));
  `,ctx);
  const first=reverse?'나르보 섬':'베이루와 섬';
  for (const mode of ctx.feasibleTie) {
    assert.equal(mode.seed,first,'feasible ties retain the existing stable seed order');
    assert.deepEqual([...mode.islands],[first],'feasible supplier selection retains the pre-fix baseline');
  }
}

// The existing JIT producer still precedes and supplies the coin exchange in both modes.
{
  const {ctx} = environment();
  vm.runInContext(`
    APP_CONFIG.ALLOW_OCEAN='inner';
    APP_CONFIG.EFFICIENCY_THRESHOLD=999999;
    const source=masterData[1][0].name,intermediate=masterData[2][0].name;
    inventory={[source]:{stock:40,target:0},[intermediate]:{stock:0,target:0}};
    globalThis.jitInitial=JSON.parse(JSON.stringify(inventory));
    scannedTrades=[
      {island:'타슈 섬',fromItem:source,toItem:intermediate,count:1,reqAmount:1,yield:2},
      {island:'까마귀의 둥지',fromItem:intermediate,toItem:'까마귀 주화',count:1,reqAmount:1,yield:100}
    ];
    runAlgorithmAllModes(true);
    globalThis.jitP1=[sortiesSpeed,sortiesBalance];
  `,ctx);
  for (const [index,plan] of ctx.jitP1.entries()) {
    assert.equal(plan[0]?.seedIsland,'타슈 섬','JIT seed remains identical to the pre-fix baseline');
    const rows=plan.flatMap(s=>s.trades);
    assert.deepEqual([...rows].map(t=>t.island),['타슈 섬','까마귀의 둥지']);
    assert.equal(rows[0].isJit,true);
    assert.equal(rows[1].isChained,true);
    assert.ok(rows.every(t=>t.execC===1));
    audit(plan,ctx.jitInitial,22689,40259,index===0?'speed':'balance',10278,15576,1250000);
  }
}

// Projection cannot pre-judge a T5 candidate before final urgent/VIP rules make its source usable.
{
  const {ctx} = environment();
  vm.runInContext(`
    APP_CONFIG.ALLOW_OCEAN='inner';
    tierRules={1:20,2:20,3:20,4:20,5:2};
    const source=masterData[4][0].name, output=masterData[5][0].name;
    inventory={[source]:{stock:1,target:0},[output]:{stock:0,target:5}};
    scannedTrades=[{island:'베이루와 섬',fromItem:source,toItem:output,count:1,reqAmount:1,yield:1}];
    const originalBuildSorties=buildSorties;
    globalThis.urgentCandidate=[];
    buildSorties=(trades,mode)=>{
      if(mode==='speed')urgentCandidate=trades.map(t=>({currentC:t.currentC,count:t.count,origC:t.origC,isUrgent:t.isUrgent,toTier:t.toTier}));
      return originalBuildSorties(trades,mode);
    };
    runAlgorithmAllModes(true);
    buildSorties=originalBuildSorties;
    globalThis.urgentP1={
      candidate:urgentCandidate.find(t=>t.toTier===5),
      scheduled:sortiesSpeed.flatMap(s=>s.trades).some(t=>t.toTier===5)
    };
  `, ctx);
  assert.deepEqual({...ctx.urgentP1.candidate}, {currentC:1,count:1,origC:1,isUrgent:true,toTier:5});
  assert.equal(ctx.urgentP1.scheduled, true, 'existing final urgent/VIP logic can select the feasible T5 trade');
}

// A stored pre-canonicalization T6 island alias remains accepted by scheduler and T7 routing.
{
  const {ctx} = environment();
  vm.runInContext(`
    APP_CONFIG.ALLOW_OCEAN='t7_2region';
    const source=masterData[5][0].name, output=masterData[6][0].name;
    inventory={[source]:{stock:10,target:0},[output]:{stock:0,target:1}};
    scannedTrades=[{island:'하코번',fromItem:source,toItem:output,count:1,reqAmount:1,yield:1}];
    runAlgorithmAllModes(true);
    globalThis.legacyAliasP1=sortiesSpeed.flatMap(s=>s.trades).some(t=>t.island==='하코번'&&t.toTier===6);
  `, ctx);
  assert.equal(ctx.legacyAliasP1, true, 'legacy stored T6 alias remains within the existing east-region policy');
}

// P1-2: the balance-mode return pool reaches its max-weight validation without a ReferenceError.
{
  const {ctx,elements} = environment();
  elements.normalWeight.value = 22000;
  elements.maxWeight.value = 35000;
  vm.runInContext(`
    APP_CONFIG.ALLOW_OCEAN='t7_3region';
    APP_CONFIG.EFFICIENCY_THRESHOLD=999999;
    inventory={
      'T4 source':{stock:50,target:0}, 'T5 source':{stock:0,target:0},
      'T3 source':{stock:50,target:0}, 'T4 product':{stock:0,target:2000}
    };
    const trades=[
      {island:'아지르 섬',fromTier:4,fromClean:'T4 source',toTier:5,toClean:'T5 source',count:1,reqA:1,mult:1,score:100000},
      {island:'하코번 섬',fromTier:5,fromClean:'T5 source',toTier:6,toClean:'T6 product',count:1,reqA:1,mult:1,score:999999},
      {island:'알 수 없는 섬',fromTier:3,fromClean:'T3 source',toTier:4,toClean:'T4 product',count:1,reqA:1,mult:1,score:100000}
    ];
    globalThis.t7Return=buildTier7Sorties(trades,'t7_3region','balance').sorties;
  `, ctx);
  assert.ok(ctx.t7Return.flatMap(sortie => sortie.trades).some(trade => trade.toClean === 'T4 product'),
    'the fixture must enter and accept a return-pool candidate');
}

console.log('PASS: scheduler P1 regression tests');
