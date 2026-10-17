import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {prepareLiveTradeRows} from "../frontend/js/domain/trade-import.js";
import {applyUnusedTradePolicy, setTradeRowIncluded, validateUnusedTradePolicy} from "../frontend/js/domain/trade-unused-policy.js";

const load = async (name) => JSON.parse(await readFile(new URL(`../frontend/data/${name}`, import.meta.url), "utf8"));
const catalog = await load("trade-catalog.json");
const policy = validateUnusedTradePolicy(await load("trade-unused-policy.json"), catalog);
const coordinates = {"난파된 하란의 수송선": {isOcean:true}, "나르보 섬": {x:1,y:2}};
const field = (corrected) => ({corrected, rawOCR:String(corrected ?? ""), confidence:.99, reviewRequired:corrected === null});
const makeRow = (toItem, island = "나르보 섬") => ({captureId:"capture", ordinal:0, fields:Object.fromEntries(Object.entries({
  island, fromItem:catalog.masterData[5][0], toItem, reqAmount:1, count:null, yield:null,
}).map(([key, value]) => [key, field(value)]))});
const prepare = (rows) => prepareLiveTradeRows({rows}, catalog, {policy,coordinates});

for (const name of policy.excludedOutputs) {
  const row = makeRow(name), baseline=structuredClone(row);
  prepareLiveTradeRows({rows:[baseline]},catalog);
  prepare([row]);
  assert.equal(row.excluded, true);
  assert.equal(row.exclusionSource, "AUTO_UNUSED");
  assert.match(row.autoUnusedReason, /미사용 획득품/);
  assert.deepEqual(row.fields.count, baseline.fields.count, "ignored unknown count remains unknown with its original evidence");
  const once=structuredClone(row);prepare([row]);assert.deepEqual(row, once, "classification is idempotent");
  setTradeRowIncluded(row, true);prepare([row]);prepare([row]);
  assert.equal(row.excluded, false, "explicit include survives all rerenders and apply validation");
  assert.equal(row.fields.count.reviewRequired, true, "restoring cannot bypass unresolved numbers");
}
const ocean = makeRow(null, "난파된 하란의 수송선");
prepare([ocean]);assert.equal(ocean.excluded,true);
assert.match(ocean.autoUnusedReason,/미사용 대양/);
assert.equal(ocean.fields.toItem.corrected,null);
assert.equal(ocean.fields.toItem.reviewRequired,true);

for (const name of ["파도의 블랙스톤", "오킬루아의 꽃", "유실된 무역품 상자", "까마귀 주화", catalog.masterData[7][0]]) {
  const row=makeRow(name);prepare([row]);assert.notEqual(row.excluded,true,name+" must remain available");
}
const uncertain = makeRow("화려한 암염 주괴");
Object.assign(uncertain.fields.toItem,{rawOCR:"화려한 암염 주",reviewRequired:true});
prepare([uncertain]);assert.notEqual(uncertain.excluded,true,"partial/fuzzy names must not silently hide a row");
const uncertainOcean=makeRow(null,"난파된 하란의 수송선");
Object.assign(uncertainOcean.fields.island,{rawOCR:"",reviewRequired:true});
prepare([uncertainOcean]);assert.notEqual(uncertainOcean.excluded,true);

const verified=makeRow("화려한 진주 결정");
Object.assign(verified.fields.toItem,{rawOCR:"",confidence:null,valueSource:"VERIFIED_TEMPLATE",templateEvidence:{references:["verified"]}});
prepare([verified]);assert.equal(verified.excluded,true,"verified exact templates can establish identity without OCR");
verified.fields.toItem=field("파도의 블랙스톤");prepare([verified]);
assert.equal(verified.excluded,false,"changing the identity removes an automatic exclusion");
const manual=makeRow("화려한 진주 결정");manual.excluded=true;
prepare([manual]);manual.fields.toItem=field("파도의 블랙스톤");prepare([manual]);
assert.equal(manual.excluded,true,"a preexisting manual exclusion is never cleared by policy");
const disabledOcean=makeRow(null,"난파된 하란의 수송선");
applyUnusedTradePolicy([disabledOcean],{...policy,autoExcludeOcean:false},coordinates);
assert.notEqual(disabledOcean.excluded,true);
assert.throws(()=>validateUnusedTradePolicy({...policy,excludedOutputs:["unknown"]},catalog));
console.log("PASS: automatic unused classification, uncertain names, unchanged evidence, explicit overrides, and repeated preparation");
