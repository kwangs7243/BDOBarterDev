import assert from "node:assert/strict";
import vm from "node:vm";
import {context, catalog, elements} from "./special_item_weights.mjs";
import {prepareLiveTradeRows, processParsedTrades} from "../frontend/js/domain/trade-import.js";

assert.equal(catalog.masterData[0].length,86);
for (const name of catalog.masterData[0]) {
  const weight=catalog.itemWeights[name];
  assert.ok(Number.isFinite(weight) && weight>0);
  assert.equal(context.getItemWeight(0,name),weight);
  assert.equal(context.getItemTier(name),0);
  const sim=context.simulateWeightsTemp([{island:"베이루와 섬",fromTier:0,fromClean:name,toTier:1,toClean:"갈퀴 꽃 씨앗 주머니",execC:3,reqA:100,mult:1}],10000);
  assert.ok(Math.abs(sim.startW-300*weight)<1e-8);
  assert.ok(Math.abs(sim.stepData[0].afterW-300)<1e-8);
  const imported=processParsedTrades([{island:"베이루와 섬",fromItem:name.replaceAll(" ",""),toItem:"갈퀴 꽃 씨앗 주머니",count:3,reqAmount:100,yield:1}],[],catalog);
  assert.equal(imported.trades[0].fromItem,name);
  assert.equal(imported.trades[0].reqAmount,100);
}
for (const [name,weight] of [["코코넛",.1],["가시나무 합판",.5],["닭고기",.03],["식초",.01],["녹 주괴",.3]]) assert.equal(context.getItemWeight(0,name),weight);
assert.ok(Number.isNaN(context.getItemWeight(0,"미등록 육지품")));
const partial=context.simulateWeightsTemp([
  {island:"베이루와 섬",fromTier:1,fromClean:"갈퀴 꽃 씨앗 주머니",toTier:2,toClean:"괴생물 촉수",execC:1,reqA:1,mult:2},
  {island:"나르보 섬",fromTier:2,fromClean:"괴생물 촉수",toTier:3,toClean:"종유석 파편",execC:3,reqA:1,mult:1}
],10000);
assert.equal(partial.startW,1300);
assert.equal(partial.stepData[1].afterW,3500);
assert.equal(Object.hasOwn(partial,"reqItems"),false);
const chained=context.simulateWeightsTemp([
  {island:"베이루와 섬",fromTier:1,fromClean:"갈퀴 꽃 씨앗 주머니",toTier:2,toClean:"괴생물 촉수",execC:1,reqA:1,mult:2,isChained:false},
  {island:"나르보 섬",fromTier:2,fromClean:"괴생물 촉수",toTier:3,toClean:"종유석 파편",execC:2,reqA:1,mult:1,isChained:true}
],10000);
assert.equal(chained.startW,100);
assert.equal(chained.stepData[1].afterW,1800);
const row=(from,to,req=null,yieldValue=null)=>({fields:Object.fromEntries(Object.entries({island:"베이루와 섬",fromItem:from,toItem:to,reqAmount:req,count:10,yield:yieldValue}).map(([key,value])=>[key,{rawOCR:["fromItem","toItem","island"].includes(key)?value:"",corrected:value,reviewRequired:key!=="count"}]))});
const complete=row("종유석 파핀","굳어진 용암 액");
prepareLiveTradeRows({rows:[complete]},catalog);
assert.equal(complete.fields.fromItem.corrected,"종유석 파편");
assert.equal(complete.fields.reqAmount.corrected,1);
assert.equal(complete.fields.yield.corrected,2);
assert.ok(Object.values(complete.fields).every(f=>!f.reviewRequired));
for (const [from,to,key] of [["코코넛","갈퀴 꽃 씨앗 주머니","reqAmount"],["갈퀴 꽃 씨앗 주머니","괴생물 촉수","yield"],["괴생물 촉수","종유석 파편","yield"],["굳어진 용암 액","까마귀 주화","yield"]]) {
  const candidate=row(from,to);
  prepareLiveTradeRows({rows:[candidate]},catalog);
  assert.deepEqual(Object.entries(candidate.fields).filter(([,f])=>f.reviewRequired).map(([name])=>name),[key]);
}
const conflict=row("종유석 파편","굳어진 용암 액");
conflict.fields.fromItem.variants=[{text:"해골무늬 카페트",confidence:.99}];
prepareLiveTradeRows({rows:[conflict]},catalog);
assert.equal(conflict.fields.fromItem.reviewRequired,true);
const unresolved=row("알 수 없는 육지 재료","갈퀴 꽃 씨앗 주머니",300,1);
prepareLiveTradeRows({rows:[unresolved]},catalog);
assert.equal(unresolved.fields.fromItem.reviewRequired,true);
assert.equal(unresolved.fields.reqAmount.reviewRequired,true);

elements.normalWeight.value=1000; elements.maxWeight.value=1700;
vm.runInContext(`inventory={'갈퀴 꽃 씨앗 주머니':{stock:0,target:20}};
 scannedTrades=[{island:'베이루와 섬',fromItem:'가시나무 합판',toItem:'갈퀴 꽃 씨앗 주머니',count:10,reqAmount:1000,yield:1}];
 runAlgorithmAllModes(true);`,context);
for (const mode of ["speed","balance"]) {
  const sorties=vm.runInContext(mode === "speed" ? "sortiesSpeed" : "sortiesBalance",context);
  assert.ok(sorties.length);
  for (const sortie of sorties) {
    assert.ok(sortie.startWeight<=1000);
    assert.equal(sortie.startWeight,sortie.reqItems["가시나무 합판"].count*.5);
    assert.ok(sortie.trades.every(t=>t.afterW>=0 && t.afterW<=(mode==="speed"?1000:1700)));
  }
}
const manual=vm.runInContext("sortiesSpeed[0].trades[0]",context);
const old=manual.execC;
assert.equal(old,2);
context.adjustTradeCount({stopPropagation(){}},"speed",0,0,1);
assert.equal(manual.execC,old,"manual increase must respect land cargo departure limit");
context.adjustTradeCount({stopPropagation(){}},"speed",0,0,-1);
assert.equal(manual.execC,1);
assert.equal(vm.runInContext("sortiesSpeed[0].startWeight",context),500);
assert.equal(manual.afterW,100);
const button={classList:{replace(){},remove(){},add(){}},closest(){return null}};
const before=Number(elements.maxParley.value);
context.completeTrade(button,"speed",0,0,manual.originalIndex);
assert.equal(manual.completed,true);
assert.equal(manual.afterW,100);
assert.equal(Number(elements.maxParley.value),before-10000);
console.log("PASS: 86 land weights/imports, completed master rows, variable numeric review, name conflicts, scheduling, manual limits, and completion");
