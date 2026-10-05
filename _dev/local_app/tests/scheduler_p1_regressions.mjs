import assert from 'node:assert/strict';
import vm from 'node:vm';
import {environment} from './scheduler_departure_causality.mjs';

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
      inventory={[tier1[0]]:{stock:40,target:0},[tier2[0]]:{stock:0,target:0},
        [tier2[1]]:{stock:0,target:0},[tier2[2]]:{stock:0,target:1},[tier3]:{stock:0,target:1}};
      const impossible={island:'베이루와 섬',fromItem:tier2[1],toItem:tier3,count:1,reqAmount:1,yield:1};
      const feasible={island:'나르보 섬',fromItem:tier2[0],toItem:tier3,count:1,reqAmount:1,yield:1};
      const chain={island:'타슈 섬',fromItem:tier1[0],toItem:tier2[0],count:1,reqAmount:1,yield:1};
      const support={island:'에버딘 섬',fromItem:tier1[0],toItem:tier2[2],count:1,reqAmount:1,yield:1};
      scannedTrades=${reverseSuppliers
        ? `[chain,feasible,impossible,support]`
        : `[chain,impossible,feasible,support]`};
      runAlgorithmAllModes(true);
      globalThis.supplierP1={
        feasible:sortiesSpeed.flatMap(s=>s.trades).some(t=>t.island==='나르보 섬'),
        impossible:sortiesSpeed.flatMap(s=>s.trades).some(t=>t.island==='베이루와 섬'),
        chain:sortiesSpeed.flatMap(s=>s.trades).some(t=>t.toClean===tier2[0]),
        support:sortiesSpeed.flatMap(s=>s.trades).some(t=>t.toClean===tier2[2])
      };
    `, ctx);
    return ctx.supplierP1;
  }
  for (const order of [false,true]) {
    const outcome = scheduleSupplierOrder(order);
    assert.equal(outcome.feasible, true, `feasible supplier survives order=${order}`);
    assert.equal(outcome.chain, true, `chain producer remains available order=${order}`);
    assert.equal(outcome.support, true, `fourth fixture row remains schedulable order=${order}`);
    assert.equal(outcome.impossible, false, `unexecutable supplier is not planned order=${order}`);
  }
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
