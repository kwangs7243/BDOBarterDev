import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { getItemTier as importTier } from "../frontend/js/domain/trade-import.js";

const catalog = JSON.parse(await readFile(new URL("../frontend/data/trade-catalog.json", import.meta.url), "utf8"));
const expected = { "순수한 진주 결정": 0.30, "화려한 진주 결정": 0.10, "화려한 암염 주괴": 0.30,
  "빛나는 코발트 주괴": 0.30, "오킬루아의 꽃": 0, "파도의 블랙스톤": 0.01,
  "대양의 견고한 현철": 0.30, "유실된 무역품 상자": 50 };
for (const [name, weight] of Object.entries(expected)) assert.equal(catalog.itemWeights[name], weight);
const elements = Object.fromEntries(Object.entries({normalWeight:100, maxWeight:200, maxParley:1000000,
  parleyPerTrade:10000, parleyCrow:10000}).map(([key,value]) => [key,{value}]));
const context = { console, document:{getElementById:id=>elements[id] || null, querySelector:()=>null},
  alert:message=>{throw Error(message)}, CustomEvent:class{}, dispatchEvent(){}, renderModeColumn(){},
  openModal(){}, crypto:globalThis.crypto, setTimeout, clearTimeout, setInterval(){}, clearInterval(){} };
context.window = context;
vm.createContext(context);
for (const name of ["constants", "routing", "scheduler", "tier7", "schedule-edit", "timer-ui", "completion", "scheduler-runtime"]) {
  vm.runInContext(await readFile(new URL(`../frontend/js/domain/${name}.js`, import.meta.url), "utf8"), context, {filename:name});
}
for (const [name,weight] of Object.entries(expected)) {
  assert.ok(catalog.specialItems.includes(name));
  assert.equal(context.getItemTier(name), "mat");
  assert.equal(context.getItemWeight("mat", name), weight);
  assert.equal(context.getItemWeight("mat", `[특수] ${name.replaceAll(" ", "")}`), weight);
  const trade = {island:"베이루와 섬", fromTier:1, fromClean:"갈퀴 꽃 씨앗 주머니", toTier:"mat",
    toClean:name, execC:4, reqA:1, mult:name === "파도의 블랙스톤" ? 200 : 1};
  const result = context.simulateWeightsTemp([trade], 1000);
  assert.equal(result.startW, 400);
  assert.ok(Math.abs(result.stepData[0].afterW - 4*trade.mult*weight) < 1e-8);
}
assert.ok(!catalog.specialItems.includes("흑수정 장식 팔찌"));
assert.equal(context.getItemTier("흑수정 장식 팔찌"), 0);
assert.equal(importTier("흑수정 장식 팔찌", catalog.masterData, catalog.specialItems), 0);
const chained = context.simulateWeightsTemp([
  {island:"베이루와 섬", fromTier:1,fromClean:"갈퀴 꽃 씨앗 주머니",toTier:"mat",toClean:"유실된 무역품 상자",execC:2,reqA:1,mult:1},
  {island:"나르보 섬",fromTier:"mat",fromClean:"유실된 무역품 상자",toTier:1,toClean:"말린 푸른 장미",isChained:true,execC:1,reqA:1,mult:1}
], 1000);
assert.equal(chained.startW, 200);
assert.equal(chained.stepData[0].afterW, 100);
assert.equal(chained.stepData[1].afterW, 150);
const waypoint = context.simulateWeightsTemp([{isWaypoint:true,island:"베이루와 섬",consumed:{name:"유실된 무역품 상자",tier:"mat",count:3}}],1000);
assert.equal(waypoint.startW,150);
assert.equal(waypoint.stepData[0].afterW,0);
vm.runInContext(`APP_CONFIG.ALLOW_OCEAN='inner';
  inventory={'갈퀴 꽃 씨앗 주머니':{stock:20,target:20}};
  scannedTrades=[{island:'베이루와 섬',fromItem:'갈퀴 꽃 씨앗 주머니',toItem:'파도의 블랙스톤',count:1,reqAmount:1,yield:11000}];
  runAlgorithmAllModes(true);`,context);
assert.equal(vm.runInContext("sortiesSpeed.flatMap(s=>s.trades).filter(t=>!t.isWaypoint).length",context),0);
assert.equal(vm.runInContext("sortiesBalance.flatMap(s=>s.trades).filter(t=>!t.isWaypoint).length",context),1);
assert.equal(vm.runInContext("sortiesBalance[0].trades[0].afterW",context),110);
console.log("PASS: 8 special weights, exclusion, cargo consumption, waypoint, and scheduler overload limits");
export {context, catalog, elements};
