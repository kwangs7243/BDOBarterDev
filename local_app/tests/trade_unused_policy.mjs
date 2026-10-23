import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {runInNewContext} from "node:vm";
import {prepareLiveTradeRows} from "../../barter/frontend/js/domain/trade-import.js";
import {applyUnusedTradePolicy, setTradeRowIncluded, validateUnusedTradePolicy} from "../../barter/frontend/js/domain/trade-unused-policy.js";

const load = async (name) => JSON.parse(await readFile(new URL(`../../barter/frontend/data/${name}`, import.meta.url), "utf8"));
const catalog = await load("trade-catalog.json");
const policy = validateUnusedTradePolicy(await load("trade-unused-policy.json"), catalog);
const coordinates = runInNewContext(`${await readFile(new URL("../../barter/frontend/js/domain/constants.js", import.meta.url), "utf8")}\nislandCoordinates;`, {window:{}});
const field = (corrected) => ({corrected, rawOCR:String(corrected ?? ""), confidence:.99, reviewRequired:corrected === null});
const makeRow = (toItem, island = "나르보 섬") => ({captureId:"capture", ordinal:0, fields:Object.fromEntries(Object.entries({
  island, fromItem:catalog.masterData[5][0], toItem, reqAmount:1, count:null, yield:null,
}).map(([key, value]) => [key, field(value)]))});
const prepare = (rows) => prepareLiveTradeRows({rows}, catalog, {policy});

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
prepare([ocean]);assert.notEqual(ocean.excluded,true,"location cannot establish an unused output");
assert.equal(ocean.fields.toItem.corrected,null);
assert.equal(ocean.fields.toItem.reviewRequired,true);

for (const island of ["나르보 섬", ...Object.keys(coordinates).filter(name=>coordinates[name].isOcean)]) {
  for (const name of [...Object.values(catalog.masterData).flat(), ...catalog.specialItems].filter(name=>!policy.excludedOutputs.includes(name))) {
    const row=makeRow(name,island);prepare([row]);assert.notEqual(row.excluded,true,island+" / "+name+" must remain available");
  }
}
const staleCoin=makeRow("까마귀 주화","난파된 하란의 수송선");
Object.assign(staleCoin,{excluded:true,exclusionSource:"AUTO_UNUSED",autoUnusedReason:"미사용 대양 교환"});
prepare([staleCoin]);assert.equal(staleCoin.excluded,false,"previous location exclusions are removed on preparation");
assert.equal(staleCoin.autoUnusedReason,undefined);

const unregistered = (name) => {
  const row=makeRow(name);
  Object.assign(row.fields.toItem,{reviewRequired:true,variants:[{text:name,confidence:.97},{text:name,confidence:.95}]});
  return row;
};
for(const name of ["[대양] 관측 보고서","[대양] 오색빛 산호 노리개","심해의 기억이 담긴 아교","콕스해적단의 유물(협상 하급)"]) {
  const row=unregistered(name), baseline=structuredClone(row);
  prepareLiveTradeRows({rows:[baseline]},catalog);
  prepare([row]);assert.equal(row.excluded,true,name+" is a confirmed unsupported output");
  assert.match(row.autoUnusedReason,/미지원 획득품/);
  assert.deepEqual(row.fields,baseline.fields,"classification preserves all source values and review flags");
  const once=structuredClone(row);prepare([row]);assert.deepEqual(row,once);
  setTradeRowIncluded(row,true);prepare([row]);assert.equal(row.excluded,false);
  assert.equal(row.fields.toItem.reviewRequired,true,"restoring an unsupported output requires review");
}
const weak=makeRow("[대양] 관측 보고서");prepare([weak]);assert.notEqual(weak.excluded,true,"one reading is not sufficient evidence");
const draft=unregistered("[대양] 관측 보고서");draft.fields.toItem.reviewDraft="까마귀 주화";
prepare([draft]);assert.notEqual(draft.excluded,true,"an in-progress edit cannot be excluded automatically");
const typo=unregistered("파도의 블랙스든");prepare([typo]);assert.notEqual(typo.excluded,true,"a supported-item typo is corrected rather than excluded");
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
const disabledUnregistered=unregistered("[대양] 관측 보고서");
prepareLiveTradeRows({rows:[disabledUnregistered]},catalog);
applyUnusedTradePolicy([disabledUnregistered],{...policy,autoExcludeUnregisteredOutputs:false});
assert.notEqual(disabledUnregistered.excluded,true);
assert.throws(()=>validateUnusedTradePolicy({version:1,autoExcludeOcean:true,excludedOutputs:[]},catalog));
assert.throws(()=>validateUnusedTradePolicy({...policy,excludedOutputs:["unknown"]},catalog));
console.log("PASS: automatic unused classification, uncertain names, unchanged evidence, explicit overrides, and repeated preparation");
