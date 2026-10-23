import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyLiveTradeRules, prepareLiveTradeRows, getItemTier, processParsedTrades, compareTradeOrder } from "../../barter/frontend/js/domain/trade-import.js";
const catalog = JSON.parse(await readFile(new URL("../../barter/frontend/data/trade-catalog.json", import.meta.url), "utf8"));
assert.equal(getItemTier("까마귀 주화", catalog.masterData, ["추가 품목", ...catalog.specialItems]), "coin");
const fields = (fromItem, toItem, reqAmount = null, amount = null) => Object.fromEntries(Object.entries({island:"나르보 섬", fromItem, toItem, reqAmount, count:1, yield:amount}).map(([name, corrected]) => [name, {corrected, rawOCR:String(corrected ?? ""), reviewRequired:corrected === null}]));
for (const [source, destination, amount] of [[1,2,null],[2,3,null],[3,4,2],[4,5,1],[5,6,1],[6,7,1]]) {
  const row = {fields:fields(catalog.masterData[source][0], catalog.masterData[destination][0])};
  applyLiveTradeRules(row, catalog);
  assert.equal(row.fields.reqAmount.corrected, 1);
  assert.equal(row.fields.yield.corrected, amount);
}
const land = {fields:fields(catalog.masterData[1][0], catalog.masterData[1][1], 100)};
land.fields.reqAmount.reviewRequired = true;
applyLiveTradeRules(land, catalog);
assert.equal(land.fields.reqAmount.corrected, 100);
assert.equal(land.fields.reqAmount.reviewRequired, true);
for (const name of ["화려한 진주 결정", "화려한 암염 주괴", "유실된 무역품 상자", "파도의 블랙스톤", "까마귀 주화"]) {
  const row = {fields:fields(catalog.masterData[4][0], name)};
  applyLiveTradeRules(row, catalog);
  assert.equal(row.fields.reqAmount.corrected, 1);
  assert.equal(row.fields.yield.corrected, name === "파도의 블랙스톤" || name === "까마귀 주화" ? null : 1);
}
const correctedName = {fields:fields(catalog.masterData[3][0], "품목 미인식"), reviewFields:["toItem","yield"]};
correctedName.fields.toItem.corrected = catalog.masterData[4][0];
correctedName.fields.toItem.reviewRequired = false;
applyLiveTradeRules(correctedName, catalog);
assert.equal(correctedName.fields.yield.corrected, 2);
assert.equal(correctedName.fields.yield.reviewRequired, false);
assert.ok(!correctedName.reviewFields.includes("yield"));
for (const [source, destination, amount] of [[1,1,1],[3,4,2],[5,6,1],[6,7,1]]) {
  const uncertain = {fields:fields(catalog.masterData[source][0],catalog.masterData[destination][0]),reviewFields:["toItem","reqAmount","yield"]};
  uncertain.fields.toItem.reviewRequired = true;
  uncertain.fields.yield.importReview = uncertain.fields.yield.conflictReview = true;
  applyLiveTradeRules(uncertain,catalog);
  assert.equal(uncertain.fields.toItem.reviewRequired,true);
  assert.equal(uncertain.fields.yield.corrected,amount);
  assert.equal(uncertain.fields.yield.reviewRequired,false);
  assert.ok(!uncertain.reviewFields.includes("yield"));
  assert.equal(uncertain.fields.yield.conflictReview,undefined);
}
assert.equal(getItemTier("고급 묵향함",catalog.masterData,catalog.specialItems),6);
const row = {fields:fields(catalog.masterData[4][0], "까마귀 주화",1,134)};
const duplicate = structuredClone(row);
const result = {rows:[row,duplicate]};
assert.equal(prepareLiveTradeRows(result,catalog).length,1);
assert.equal(duplicate.duplicateOf,0);
assert.equal(processParsedTrades([Object.fromEntries(Object.entries(row.fields).map(([k,v])=>[k,v.corrected]))],[],catalog).rejectedCount,0);
duplicate.fields.yield.corrected=383;
assert.equal(prepareLiveTradeRows(result,catalog).length,2);
assert.equal(row.fields.yield.reviewRequired,true);
assert.equal(duplicate.fields.yield.reviewRequired,true);
assert.equal(row.fields.fromItem.reviewRequired,false);
assert.equal(duplicate.fields.fromItem.reviewRequired,false);
duplicate.excluded=true;
prepareLiveTradeRows(result,catalog);
assert.equal(row.fields.yield.reviewRequired,false);
console.log("PASS: fixed rules, edited-name rules, coin classification, duplicate sources and quantity conflicts");
const ordered = ["까마귀 주화", "파도의 블랙스톤", ...[7,6,5,4,3,2,1].map(t=>catalog.masterData[t][0])].map(toItem=>({toItem}));
ordered.sort((left,right)=>compareTradeOrder(left,right,catalog));
assert.deepEqual(ordered.map(r=>r.toItem), [...[1,2,3,4,5,6,7].map(t=>catalog.masterData[t][0]),"파도의 블랙스톤","까마귀 주화"]);
console.log("PASS: fixed display order, including stage 3 to 4, special exchanges and crow coins");

const quantityRow = {fields:fields(catalog.masterData[4][0], "까마귀 주화",1,134)};
const quantityPeer = structuredClone(quantityRow);
quantityPeer.fields.count.corrected=2;
prepareLiveTradeRows({rows:[quantityRow,quantityPeer]},catalog);
assert.equal(quantityRow.fields.count.reviewRequired,true);
assert.equal(quantityPeer.fields.count.reviewRequired,true);
assert.equal(quantityPeer.fields.fromItem.reviewRequired,false);
const namePeer=structuredClone(quantityRow);
namePeer.fields.fromItem.corrected=catalog.masterData[4][1];
namePeer.fields.fromItem.rawOCR=catalog.masterData[4][1];
prepareLiveTradeRows({rows:[quantityRow,namePeer]},catalog);
assert.equal(namePeer.fields.fromItem.reviewRequired,true,'different required items retain import holds');
console.log('PASS: yield/count conflicts review both rows without replacing name-conflict holds');

const unregistered = () => {
  const row={fields:fields(catalog.masterData[4][0], '흑수정 장식 팔찌', 1, 100)};
  Object.assign(row.fields.toItem,{reviewRequired:true,confidence:.99,
    variants:[{text:'흑수정 장식 팔찌',confidence:.99},{text:'흑수정 장식팔짜',confidence:.9}]});
  return row;
};
const originalCatalog=JSON.stringify(catalog);
const unknown=unregistered(),unknownPeer=unregistered();
const unknownResult={rows:[unknown,unknownPeer]};
assert.equal(prepareLiveTradeRows(unknownResult,catalog).length,1);
assert.equal(unknown.fields.toItem.supportStatus,'UNREGISTERED_CANDIDATE');
assert.equal(unknown.fields.toItem.reviewRequired,true);
assert.deepEqual(unknown.reviewGroupIndices,[0,1]);
assert.equal(unknownResult.rows.length,2,'both original sources retained');
assert.equal(unknown.excluded,undefined,'no automatic exclusion');
unknown.excluded=true;
assert.equal(prepareLiveTradeRows(unknownResult,catalog).length,2,'different existing choices remain independent');
assert.equal(unknownPeer.excluded,undefined);
unknownPeer.excluded=true;
assert.equal(prepareLiveTradeRows(unknownResult,catalog).length,1);
unknown.excluded=unknownPeer.excluded=false;
unknownPeer.fields.yield.corrected=101;
assert.equal(prepareLiveTradeRows(unknownResult,catalog).length,2,'different quantities are never hidden');
unknownPeer.fields.yield.corrected=100;
for(const source of unknownResult.rows) Object.assign(source.fields.toItem,
  {corrected:catalog.masterData[5][0],reviewRequired:false,valueSource:'USER_REVIEW'});
assert.equal(prepareLiveTradeRows(unknownResult,catalog).length,1);
assert.equal(unknown.fields.toItem.supportStatus,undefined,'supported correction clears label');
assert.equal(unknown.fields.toItem.reviewRequired,false);
const weakUnknown=unregistered();weakUnknown.fields.toItem.variants=[{text:'흑수정 장식 팔찌',confidence:.4}];
prepareLiveTradeRows({rows:[weakUnknown]},catalog);
assert.equal(weakUnknown.fields.toItem.supportStatus,undefined,'weak OCR stays a normal recognition hold');
const oceanUnknown=unregistered();
Object.assign(oceanUnknown.fields.toItem,{corrected:'[대양] 해달족 낚시 바늘',rawOCR:'[대양] 해달족 낚시 바늘',
  variants:[{text:'[대양] 해달족 낚시 바늘',confidence:.98},{text:'[대양1 해달족 낚시 비능',confidence:.75},
    {text:'[대양] 해달족 낚시 바늘',confidence:.83}]});
prepareLiveTradeRows({rows:[oceanUnknown]},catalog);
assert.equal(oceanUnknown.fields.toItem.supportStatus,'UNREGISTERED_CANDIDATE','a majority supports the candidate label');
assert.equal(JSON.stringify(catalog),originalCatalog,'master stays unchanged');
console.log('PASS: unregistered candidates, grouped sources, existing choices and quantity differences');
