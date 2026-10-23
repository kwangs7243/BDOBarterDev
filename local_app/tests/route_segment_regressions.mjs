import assert from 'node:assert/strict';
import vm from 'node:vm';
import {environment, audit} from './scheduler_departure_causality.mjs';

function row(island, fromClean, toClean, fromTier, toTier, count = 1) {
  return {island, fromClean, toClean, fromTier, toTier, count, origC:count, currentC:count,
    execC:count, reqA:1, mult:1, isCoin:toTier === 'coin', isSpec:false, isRandomCoin:false,
    isChained:false, score:200000, lack:1000};
}
function coords(ctx, name, x, y = 0) {
  ctx.islandCoordinates[name] = {x,y};
  ctx.islandCoordinates[name.replace(/ 섬$/, '')] = {x,y};
}
const plain = x => JSON.parse(JSON.stringify(x));
const names = arr => Array.from(arr, t => t.island);
const results = [];

for (const mode of ['t7_2region','t7_2region_south','t7_2region_arehazaX','t7_3region']) {
  for (const weightMode of ['speed','balance']) for (const reverse of [false,true]) {
    const {ctx} = environment();
    const regions = [
      [['하코번 섬','아레하자 마을'],['소산 주둔지 선착장','성전 해안 정찰지']],
      [['해모 섬','달래나루'],['올비아 해안','에페리아 초소']],
      [['그란디하','깊은 밤의 항구'],['일리야 섬','레마 섬']]
    ];
    const initial = {}, six = [], seven = [];
    regions.forEach(([sources, destinations], r) => sources.forEach((island, i) => {
      const f = `source-${r}-${i}`, s = `six-${r}-${i}`, t = `seven-${r}-${i}`;
      initial[f] = {stock:5,target:5};
      six.push(row(island,f,s,5,6,5));
      seven.push(row(destinations[i],s,t,6,7,5));
    }));
    ctx.initial = initial; ctx.input = [...six,...(reverse ? seven.reverse() : seven)];
    ctx.testMode = mode; ctx.weightMode = weightMode;
    vm.runInContext(`inventory=initial;APP_CONFIG.ALLOW_OCEAN=testMode;
      plan=buildTier7Sorties(input,testMode,weightMode).sorties;`,ctx);
    const checked = audit(ctx.plan,initial,22689,40259,weightMode,10278,15576,1250000);
    assert.equal(checked.plannedCost,ctx.plan.length*20*10278);
    for (const s of ctx.plan) {
      const split = s.trades.findIndex(t => t.toTier === 7), prefix = s.trades.slice(0,split), tail = s.trades.slice(split);
      assert.equal(prefix.length,2); assert.equal(tail.length,2);
      assert.ok(s.trades.every(t => t.execC === 5));
      for (const order of ctx.getPermutations(tail)) {
        assert.ok(s.totalTime <= ctx.simulateWeightsTemp([...prefix,...order],22689).totalTime+1e-9,
          `${mode}/${weightMode}/${s.seedRegion}: destination order must use the actual entry and return`);
      }
      assert.deepEqual(plain(s.reqItems),Object.fromEntries(prefix.map(t => [t.fromClean,{count:5,isBase:false,tier:5}])));
    }
    results.push({mode,weightMode,reverse,departures:ctx.plan.length});
  }
}

{
  const {ctx} = environment();
  const prefix = [row('해모 섬','stock','six',5,6,5)];
  const suffix = [row('일리야 섬','other-six','result',6,7,1)];
  const first = row('올비아 해안','six','result-a',6,7,2), second = row('에페리아 초소','six','result-b',6,7,3);
  first.isChained = second.isChained = true;
  const before = plain([prefix,first,second,suffix]);
  const order = ctx.optimizeRouteSegment([first,second],{prefix,suffix,normalWeight:22689,weightLimit:22689});
  assert.deepEqual(names(order),['에페리아 초소','올비아 해안']);
  assert.deepEqual(plain([prefix,first,second,suffix]),before,'ordering cannot mutate trades, prefix, suffix or flags');
  assert.equal(ctx.simulateWeightsTemp([...prefix,...order,...suffix],22689).startW,
    ctx.simulateWeightsTemp([...prefix,first,second,...suffix],22689).startW);
  results.push({test:'real west entry, supplied six-tier cargo and fixed suffix'});
}

{
  const {ctx} = environment(); coords(ctx,'일리야 섬',0); coords(ctx,'far',-1000); coords(ctx,'near',-100);
  ctx.routeCalibrations['일리야 섬_far'] = {multiplier:10};
  const unload = row('far','heavy','coin',4,'coin'), pickup = row('near','light','six',1,6);
  assert.ok(ctx.simulateWeightsTemp([pickup,unload],2000).totalTime<ctx.simulateWeightsTemp([unload,pickup],2000).totalTime);
  const order = ctx.optimizeRouteSegment([unload,pickup],{normalWeight:2000,weightLimit:2000});
  assert.deepEqual(names(order),['far','near'],'a faster order cannot break the weight limit');
  assert.equal(ctx.simulateWeightsTemp([pickup,unload],2000).peakW,3000);
  results.push({test:'reject overload even when nearest-first is faster'});
}

{
  const {ctx} = environment();
  for (const [name,x] of [['일리야 섬',0],['entry',-1000],['producer',-900],['consumer',-100]]) coords(ctx,name,x);
  const prefix = [row('entry','ballast','coin',4,'coin')];
  const producer = row('producer','raw','middle',4,5), consumer = row('consumer','middle','final',5,6);
  const original = [consumer,producer];
  assert.notDeepEqual(plain(ctx.getSortieCargoPlan([...prefix,...original]).reqItems),
    plain(ctx.getSortieCargoPlan([...prefix,producer,consumer]).reqItems));
  assert.deepEqual(names(ctx.optimizeRouteSegment(original,{prefix,normalWeight:22689})),names(original),
    'a new order cannot silently change the departure stock allocation');
  results.push({test:'reject a faster order that changes warehouse loads'});
}

{
  const {ctx} = environment();
  for (const [name,x,y] of [['일리야 섬',0,0],['entry',-500,1000],['a',-900,0],['b',-200,0],['next-fixed',-1000,0]]) coords(ctx,name,x,y);
  const prefix = [row('entry','ballast','coin',4,'coin')];
  const a = row('a','a-stock','coin',1,'coin'), b = row('b','b-stock','coin',1,'coin');
  const suffix = [row('next-fixed','next-stock','coin',1,'coin')];
  assert.deepEqual(names(ctx.optimizeRouteSegment([b,a],{prefix,normalWeight:22689})),['a','b']);
  assert.deepEqual(names(ctx.optimizeRouteSegment([a,b],{prefix,suffix,normalWeight:22689})),['b','a']);
  results.push({test:'use the next fixed stop rather than premature return to Ilya'});
}

{
  const {ctx} = environment(); coords(ctx,'a',-100); coords(ctx,'b',-100);
  const original = [row('b','b-stock','coin',1,'coin'),row('a','a-stock','coin',1,'coin')];
  assert.equal(ctx.optimizeRouteSegment(original,{normalWeight:22689}),original,'equal times retain the existing order');
  results.push({test:'no improvement retains the original array and tie order'});
}

{
  const {ctx} = environment();
  for (const [name,x] of [['일리야 섬',0],['entry',-1000],['a',-900],['b',-200]]) coords(ctx,name,x);
  const prefix = [row('entry','ballast','coin',4,'coin')];
  const original = [row('b','unregistered-land-item','coin',0,'coin'),row('a','other-unregistered-land-item','coin',0,'coin')];
  assert.ok(Number.isNaN(ctx.simulateWeightsTemp([...prefix,...original],22689).startW));
  assert.equal(ctx.optimizeRouteSegment(original,{prefix,normalWeight:22689}),original,'unknown weights cannot pass the reorder safety check');
  results.push({test:'unknown weights retain the existing order'});
}

{
  const {ctx} = environment(); coords(ctx,'일리야 섬',0); coords(ctx,'entry',-1000);
  const prefix = [row('entry','ballast','coin',4,'coin')];
  const tail = Array.from({length:8},(_,i) => {coords(ctx,`tail-${i}`,-100*(i+1)); return row(`tail-${i}`,`stock-${i}`,'coin',1,'coin');});
  const order = ctx.optimizeRouteSegment(tail,{prefix,normalWeight:22689});
  assert.equal(order.length,8);
  assert.deepEqual(names(order),names(tail).reverse());
  assert.ok(ctx.simulateWeightsTemp([...prefix,...order],22689).totalTime<ctx.simulateWeightsTemp([...prefix,...tail],22689).totalTime);
  results.push({test:'bounded long-segment search uses the actual entry'});
}

{
  const {ctx} = environment();
  for (const [name,x] of [['일리야 섬',0],['jit',-1100],['난파된 콕스해적선',-1000],['오르프스 섬',-900],['아지르 섬',-200]]) coords(ctx,name,x);
  const prefix = [row('jit','raw','supplied',4,5,2)];
  const fixed = row('난파된 콕스해적선','supplied','까마귀 주화',5,'coin'); fixed.isChained = true;
  const nearEntry = row('오르프스 섬','supplied','까마귀 주화',5,'coin'); nearEntry.isChained = true;
  const nearHome = row('아지르 섬','stock','까마귀 주화',4,'coin');
  const order = ctx.sortFixedOcean([nearHome,fixed,nearEntry],{prefix,normalWeight:22689,weightLimit:22689});
  assert.deepEqual(names(order),['난파된 콕스해적선','오르프스 섬','아지르 섬']);
  results.push({test:'fixed ocean order and JIT prefix remain intact; others start at its last stop'});
}

{
  const {ctx} = environment();
  const f='젊음을 담은 비약',six='대나무 수액 상자',seven='금빛 밀가루 포대';
  const a='해적의 화약',b='성게 가시',c='오색 구슬',d='푸른 양초 더미';
  const initial = {[f]:{stock:5,target:5},[a]:{stock:100,target:0},[b]:{stock:0,target:2000},[c]:{stock:100,target:0},[d]:{stock:0,target:2000}};
  for (const [name,x,y] of [['일리야 섬',0,0],['해모 섬',-1000,1000],['올비아 해안',-1000,0],['오르프스 섬',-900,0],['아지르 섬',-200,0]]) coords(ctx,name,x,y);
  ctx.initial = initial;ctx.input = [row('해모 섬',f,six,5,6,5),row('올비아 해안',six,seven,6,7,5),row('오르프스 섬',a,b,1,2),row('아지르 섬',c,d,2,3)];
  vm.runInContext("inventory=initial;APP_CONFIG.ALLOW_OCEAN='t7_2region';plan=buildTier7Sorties(input,'t7_2region','speed').sorties;",ctx);
  const host = ctx.plan.find(s => s.seedRegion === '서부 7단');
  assert.deepEqual(names(host.trades),['해모 섬','올비아 해안','오르프스 섬','아지르 섬']);
  audit(ctx.plan,initial,22689,40259,'speed',10278,15576,1250000);
  results.push({test:'generated T7 return pickups do not travel backwards'});
}

for (const mode of ['inner','ocean']) for (const weightMode of ['speed','balance']) {
  const {ctx} = environment();
  for (const [name,x] of [['일리야 섬',0],['난파된 콕스해적선',-1000],['오르프스 섬',-900],['아지르 섬',-200]]) coords(ctx,name,x);
  ctx.islandCoordinates['난파된 콕스해적선'].isOcean = true;
  const initial = {'청동 촛대':{stock:100,target:0}};
  ctx.initial = initial;ctx.input = ['난파된 콕스해적선','아지르 섬','오르프스 섬'].map(island => row(island,'청동 촛대','까마귀 주화',4,'coin'));
  ctx.testMode = mode;ctx.weightMode = weightMode;
  vm.runInContext('inventory=initial;APP_CONFIG.ALLOW_OCEAN=testMode;plan=buildSorties(input,weightMode);',ctx);
  assert.equal(ctx.plan.length,1);
  assert.deepEqual(names(ctx.plan[0].trades),['난파된 콕스해적선','오르프스 섬','아지르 섬']);
  audit(ctx.plan,initial,22689,40259,weightMode,10278,15576,1250000);
  results.push({test:'generated fixed ocean plus other coins',mode,weightMode});
}

for (const weightMode of ['speed','balance']) {
  const {ctx} = environment();
  const initial = {'west-a':{stock:5,target:5},'west-b':{stock:5,target:5},'coin-stock':{stock:1,target:0}};
  ctx.initial = initial;ctx.weightMode = weightMode;
  ctx.input = [row('해모 섬','west-a','six-a',5,6,5),row('달래나루','west-b','six-b',5,6,5),
    row('올비아 해안','six-a','seven-a',6,7,5),row('에페리아 초소','six-b','seven-b',6,7,5),
    row('난파된 콕스해적선','coin-stock','까마귀 주화',4,'coin')];
  vm.runInContext("inventory=initial;APP_CONFIG.ALLOW_OCEAN='t7_2region';plan=buildTier7Sorties(input,'t7_2region',weightMode).sorties;",ctx);
  const host = ctx.plan.find(s => s.seedRegion === '서부 7단');
  assert.deepEqual(names(host.trades),['난파된 콕스해적선','달래나루','해모 섬','에페리아 초소','올비아 해안']);
  for (const six of ctx.getPermutations(host.trades.filter(t => t.toTier === 6))) {
    for (const seven of ctx.getPermutations(host.trades.filter(t => t.toTier === 7))) {
      assert.ok(host.totalTime<=ctx.simulateWeightsTemp([host.trades[0],...six,...seven],22689).totalTime+1e-9,
        'repairing the six-tier group must not optimize against the old, wrong seven-tier order');
    }
  }
  audit(ctx.plan,initial,22689,40259,weightMode,10278,15576,1250000);
  results.push({test:'six- and seven-tier group interaction after fixed ocean prefix',weightMode});
}

console.log(JSON.stringify({ok:true,tests:results.length,results},null,2));
