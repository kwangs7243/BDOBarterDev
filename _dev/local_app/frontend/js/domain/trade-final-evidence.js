import { masterBundleContentHash, validateMasterBundleV2 } from "./trade-master-bundle.js";

const PROJECTION_KEYS = ["schemaVersion", "reviewMode", "recognitionBatchId", "rawEvidenceHash", "masterBinding", "correctionVersion", "reconciliation", "pixelAvailability", "rows", "edgeWorkItems", "hashBasis", "projectionHash"];
const COMPLETION_KEYS = ["schemaVersion", "reviewMode", "recognitionBatchId", "projectionHash", "masterBinding", "correctionVersion", "reviewRevision", "rows", "workItems", "batchConfirmation"];
const FIELD_KEYS = Object.freeze(["island", "fromItem", "reqAmount", "toItem", "count", "yield"]);
const NUMERIC_MINIMUM = Object.freeze({ reqAmount: 1, count: 0, yield: 1 });
const DECISIONS = new Set(["CANDIDATE_RETAINED", "USER_EDITED", "USER_MARKED_UNKNOWN"]);
const CLASSIFICATIONS = new Set(["FINAL_READY", "NEEDS_REVIEW", "NEEDS_RECAPTURE", "CONFLICT"]);
const PIXEL_STATES = new Set(["IN_MEMORY", "DURABLE", "MISSING", "EXPIRED", "INVALID"]);
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const SHA256_ROUND = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
];

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function fail(message) { throw new TypeError(message); }
function exactKeys(value, keys, label) {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) fail(`${label} has an invalid shape`);
}
function exactKeysOptional(value, required, optional, label) {
  if (!isRecord(value)) fail(`${label} has an invalid shape`);
  const keys=Object.keys(value).sort().join("\0");
  const requiredKeys=[...required].sort().join("\0");
  const withOptional=[...required,...optional].sort().join("\0");
  if (keys!==requiredKeys&&keys!==withOptional) fail(`${label} has an invalid shape`);
}
function validUnicode(value) {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const next = value.charCodeAt(i + 1); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; i += 1; }
    else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
function cloneJson(value, label = "value", seen = new Set(), depth = 0, budget = { count: 250000 }) {
  budget.count -= 1;
  if (budget.count < 0 || depth > 32) fail(`${label} exceeds structural limits`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") { if (!validUnicode(value)) fail(`${label} contains invalid Unicode`); return value; }
  if (typeof value === "number") { if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail(`${label} must contain safe integers`); return value; }
  if (!value || typeof value !== "object" || seen.has(value)) fail(`${label} is not plain JSON data`);
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || Object.getOwnPropertySymbols(value).length) fail(`${label} has unsupported array properties`);
    seen.add(value);
    const result = [];
    for (let i = 0; i < value.length; i += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail(`${label}[${i}] is not a data item`);
      result.push(cloneJson(descriptor.value, `${label}[${i}]`, seen, depth + 1, budget));
    }
    if (Object.getOwnPropertyNames(value).length !== value.length + 1) fail(`${label} has non-index properties`);
    seen.delete(value);
    return result;
  }
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) fail(`${label} is not a plain object`);
  seen.add(value);
  const result = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!validUnicode(key)) fail(`${label} contains an invalid key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail(`${label}.${key} is not a data property`);
    Object.defineProperty(result, key, { value: cloneJson(descriptor.value, `${label}.${key}`, seen, depth + 1, budget), enumerable: true, writable: true, configurable: true });
  }
  seen.delete(value);
  return result;
}
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); } return value; }
function compareCodePoints(a, b) {
  const left = Array.from(a, (char) => char.codePointAt(0)); const right = Array.from(b, (char) => char.codePointAt(0));
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
}
function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  return `{${Object.keys(value).sort(compareCodePoints).map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(",")}}`;
}
function sha256(text) {
  const input = new TextEncoder().encode(text); const paddedLength = Math.ceil((input.length + 9) / 64) * 64; const padded = new Uint8Array(paddedLength);
  padded.set(input); padded[input.length] = 0x80; const view = new DataView(padded.buffer); const bitLength = input.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false); view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const state = [...SHA256_INITIAL]; const words = new Uint32Array(64); const rr = (word, bits) => (word >>> bits) | (word << (32 - bits));
  for (let block = 0; block < paddedLength; block += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(block + i * 4, false);
    for (let i = 16; i < 64; i += 1) { const x=words[i-15],y=words[i-2]; words[i]=(words[i-16]+(rr(x,7)^rr(x,18)^(x>>>3))+words[i-7]+(rr(y,17)^rr(y,19)^(y>>>10)))>>>0; }
    let [a,b,c,d,e,f,g,h]=state;
    for (let i=0;i<64;i+=1) { const t1=(h+(rr(e,6)^rr(e,11)^rr(e,25))+((e&f)^(~e&g))+SHA256_ROUND[i]+words[i])>>>0; const t2=((rr(a,2)^rr(a,13)^rr(a,22))+((a&b)^(a&c)^(b&c)))>>>0; h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0; }
    state[0]=(state[0]+a)>>>0;state[1]=(state[1]+b)>>>0;state[2]=(state[2]+c)>>>0;state[3]=(state[3]+d)>>>0;state[4]=(state[4]+e)>>>0;state[5]=(state[5]+f)>>>0;state[6]=(state[6]+g)>>>0;state[7]=(state[7]+h)>>>0;
  }
  return state.map((word) => word.toString(16).padStart(8,"0")).join("");
}
function hash(value) { return sha256(canonicalStringify(value)); }
function hashShape(value, label) { if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} must be lowercase SHA-256`); }
function timestamp(value, label) { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${label} must be a UTC RFC3339 timestamp`); }
function validText(value, label) { if (typeof value !== "string" || !value || value.length > 128 || !validUnicode(value)) fail(`${label} must be nonempty text`); }
function validValue(field, value, nullable, label) {
  if (value === null && nullable) return;
  if (Object.hasOwn(NUMERIC_MINIMUM, field)) {
    if (!Number.isSafeInteger(value) || value < NUMERIC_MINIMUM[field]) fail(`${label} has an invalid numeric value`);
  } else if (typeof value !== "string" || !value || !validUnicode(value)) fail(`${label} has an invalid text value`);
}
function sameSourceRefs(left, right) { return canonicalStringify(left) === canonicalStringify(right); }
function expectedHash(value, key, label) { const basis = { ...value }; delete basis[key]; const actual = hash(basis); if (value[key] !== actual) fail(`${label} hash mismatch`); return actual; }

function validateProjectionField(field, expectedField, sourceIds) {
  exactKeys(field,["field","rawEvidenceRefs","normalizedValue","candidates","selectedCandidateIndex","correctedValue","finalValue","identity","valueState","riskReasons","correctionReasons","alternatives","cropRefs","stageTrace"],"projection field");
  if (field.field!==expectedField) fail("projection field order is invalid");
  for (const key of ["normalizedValue","correctedValue","finalValue"]) validValue(field.field,field[key],true,`${field.field}.${key}`);
  if (!Array.isArray(field.rawEvidenceRefs)||!sameSourceRefs(field.rawEvidenceRefs,sourceIds.map((sourceRowId)=>({sourceRowId,field:field.field})))
      ||!Array.isArray(field.candidates)||!Array.isArray(field.riskReasons)||!Array.isArray(field.correctionReasons)||!Array.isArray(field.alternatives)||!Array.isArray(field.cropRefs)||!Array.isArray(field.stageTrace)) fail("projection field trace is invalid");
  if (!new Set(["RESOLVED","UNRESOLVED","CONFLICT","CLIPPED"]).has(field.valueState)) fail("projection valueState is invalid");
  if (field.valueState==="CONFLICT"&&(field.finalValue!==null||field.selectedCandidateIndex!==null)) fail("conflict fields cannot have a selected value");
  if (field.selectedCandidateIndex!==null&&(!Number.isSafeInteger(field.selectedCandidateIndex)||field.selectedCandidateIndex<0||field.selectedCandidateIndex>=field.candidates.length)) fail("selected candidate index is invalid");
  if (field.candidates.some((candidate)=>{ exactKeys(candidate,["value","identity","reason"],"candidate"); return typeof candidate.reason!=="string"||!candidate.reason; })) fail("candidate reason is invalid");
  for (const identity of [field.identity,...field.candidates.map((candidate)=>candidate.identity)]) {
    if (identity===null) continue;
    exactKeys(identity,["kind","stableId","legacyNameKey","authorityStatus"],"identity");
    if (!new Set(["ITEM","ISLAND"]).has(identity.kind)||identity.stableId!==null&&!UUID.test(identity.stableId)||identity.legacyNameKey!==null&&(typeof identity.legacyNameKey!=="string"||!identity.legacyNameKey)
        ||!new Set(["OPEN_WORLD","LEGACY_UNVERIFIED","VERIFIED_REFERENCE","VERIFIED_CURATED","DISPUTED","DEPRECATED"]).has(identity.authorityStatus)) fail("identity is invalid");
    if (identity.authorityStatus==="OPEN_WORLD"&&(field.field!=="fromItem"||identity.stableId!==null||identity.legacyNameKey!==null)) fail("OPEN_WORLD identity is only allowed for raw fromItem");
  }
  if (Object.hasOwn(NUMERIC_MINIMUM,field.field)&&field.identity!==null) fail("numeric projection fields cannot carry identity");
  const unique=[...field.riskReasons,...field.correctionReasons];
  if (unique.some((reason)=>typeof reason!=="string"||!reason)||new Set(field.riskReasons).size!==field.riskReasons.length||new Set(field.correctionReasons).size!==field.correctionReasons.length) fail("risk or correction reason is invalid");
  for (const id of field.cropRefs) validText(id,"cropRefId");
  for (const alternative of field.alternatives) {
    exactKeys(alternative,["value","sourceRefs","riskReasons"],"alternative");
    validValue(field.field,alternative.value,true,"alternative value");
    if (!Array.isArray(alternative.sourceRefs)||!Array.isArray(alternative.riskReasons)) fail("alternative lineage is invalid");
  }
  let previous=-1;
  for (const trace of field.stageTrace) {
    exactKeys(trace,["stage","ruleVersion","inputValue","outputValue","reason"],"stage trace");
    if (!Number.isSafeInteger(trace.stage)||trace.stage<0||trace.stage>8||trace.stage<=previous||typeof trace.ruleVersion!=="string"||!trace.ruleVersion||trace.reason!==null&&typeof trace.reason!=="string") fail("stage trace is invalid");
    previous=trace.stage;
  }
}

function validateProjectionComponents(input) {
  if (!Array.isArray(input.rows) || !input.rows.length || !Array.isArray(input.edgeWorkItems)) fail("rows and edgeWorkItems must be arrays");
  const ledger = input.reconciliation;
  exactKeys(ledger, ["schemaVersion", "policyVersion", "captureOrder", "sourceRows", "groups", "sourceToLogical", "findings"], "reconciliation");
  if (ledger.schemaVersion !== 2 || !Array.isArray(ledger.captureOrder) || !Array.isArray(ledger.sourceRows) || !Array.isArray(ledger.groups) || !Array.isArray(ledger.sourceToLogical) || !Array.isArray(ledger.findings)) fail("reconciliation v2 is invalid");
  validText(ledger.policyVersion, "policyVersion");
  if (new Set(ledger.captureOrder).size !== ledger.captureOrder.length || ledger.captureOrder.some((id) => typeof id !== "string" || !id)) fail("captureOrder is invalid");
  const sourceIds = new Set(); const sourceMap = new Map();
  ledger.sourceRows.forEach((source, index) => {
    exactKeys(source, ["sourceRowId", "captureId", "ordinal", "projectionSourceIndex"], "source row");
    validText(source.sourceRowId, "sourceRowId"); validText(source.captureId, "captureId");
    if (!ledger.captureOrder.includes(source.captureId) || !Number.isSafeInteger(source.ordinal) || source.ordinal < 0 || source.projectionSourceIndex !== index || sourceIds.has(source.sourceRowId)) fail("source row ledger is invalid");
    const prior=ledger.sourceRows[index-1];
    if(prior&&(ledger.captureOrder.indexOf(source.captureId)<ledger.captureOrder.indexOf(prior.captureId)||source.captureId===prior.captureId&&source.ordinal<=prior.ordinal)) fail("source rows are not in capture/ordinal order");
    sourceIds.add(source.sourceRowId); sourceMap.set(source.sourceRowId, source);
  });
  const groupMap = new Map(); const assigned = [];
  ledger.groups.forEach((group) => {
    exactKeys(group, ["groupId", "status", "memberSourceRowIds", "representativeSourceRowId", "logicalRowId", "memberEvidence"], "reconciliation group");
    validText(group.groupId, "groupId"); validText(group.logicalRowId, "logicalRowId");
    if (!new Set(["SINGLE", "EXACT_OVERLAP", "CONFLICT"]).has(group.status) || !Array.isArray(group.memberSourceRowIds) || !group.memberSourceRowIds.length || !Array.isArray(group.memberEvidence)) fail("reconciliation group is invalid");
    if(group.status==="SINGLE"&&group.memberSourceRowIds.length!==1||group.status!=="SINGLE"&&group.memberSourceRowIds.length<2) fail("reconciliation group status disagrees with membership");
    if (group.representativeSourceRowId !== group.memberSourceRowIds[0] || group.memberSourceRowIds.some((id) => !sourceMap.has(id))) fail("group representative or membership is invalid");
    const sorted = [...group.memberSourceRowIds].sort((a,b) => ledger.captureOrder.indexOf(sourceMap.get(a).captureId)-ledger.captureOrder.indexOf(sourceMap.get(b).captureId) || sourceMap.get(a).ordinal-sourceMap.get(b).ordinal);
    if (!sameSourceRefs(sorted, group.memberSourceRowIds)) fail("group members are not in source order");
    if (group.memberSourceRowIds.length === 1 && group.memberEvidence.length !== 0 || group.memberSourceRowIds.length > 1 && group.memberEvidence.length !== group.memberSourceRowIds.length) fail("group source evidence is incomplete");
    if (group.memberEvidence.length) for (const member of group.memberEvidence) {
      exactKeys(member, ["sourceRowId", "fields"], "member evidence");
      if (!group.memberSourceRowIds.includes(member.sourceRowId) || !Array.isArray(member.fields) || member.fields.length !== 6 || !sameSourceRefs(member.fields.map((f) => f.field), FIELD_KEYS)) fail("member evidence is invalid");
      member.fields.forEach((field,index)=>validateProjectionField(field,FIELD_KEYS[index],[member.sourceRowId]));
    }
    if (groupMap.has(group.logicalRowId)) fail("logical row is mapped more than once");
    groupMap.set(group.logicalRowId, group); assigned.push(...group.memberSourceRowIds);
  });
  if (assigned.length !== sourceIds.size || new Set(assigned).size !== sourceIds.size || assigned.some((id) => !sourceIds.has(id))) fail("source rows must be accounted exactly once");
  if (!Array.isArray(ledger.sourceToLogical) || ledger.sourceToLogical.length !== sourceIds.size) fail("source mapping count is invalid");
  const mapping = new Map();
  ledger.sourceToLogical.forEach((item, index) => {
    exactKeys(item, ["sourceRowId", "logicalRowId"], "source mapping");
    if (item.sourceRowId !== ledger.sourceRows[index]?.sourceRowId || !sourceMap.has(item.sourceRowId) || !groupMap.has(item.logicalRowId) || mapping.has(item.sourceRowId)) fail("source mapping is invalid");
    mapping.set(item.sourceRowId,item.logicalRowId);
  });
  for (const group of ledger.groups) for (const sourceId of group.memberSourceRowIds) if (mapping.get(sourceId)!==group.logicalRowId) fail("source mapping disagrees with groups");
  if (input.rows.length !== ledger.groups.length) fail("logical rows do not match reconciliation groups");
  const sourcePosition=new Map(ledger.sourceRows.map((source,index)=>[source.sourceRowId,index]));
  const orderedGroups=[...ledger.groups].sort((a,b)=>sourcePosition.get(a.representativeSourceRowId)-sourcePosition.get(b.representativeSourceRowId));
  if(!sameSourceRefs(orderedGroups.map((group)=>group.logicalRowId),input.rows.map((row)=>row.projectionRowId))) fail("logical rows must follow representative source order");
  const rowIds = new Set();
  for (const row of input.rows) {
    exactKeys(row, ["projectionRowId", "captureId", "ordinal", "rowBox", "sourceRefs", "fields", "classification", "classificationReasons"], "projection row");
    const group=groupMap.get(row.projectionRowId); if (!group || rowIds.has(row.projectionRowId)) fail("projection row identity is invalid"); rowIds.add(row.projectionRowId);
    const rep=sourceMap.get(group.representativeSourceRowId);
    if (row.captureId!==rep.captureId || row.ordinal!==rep.ordinal || !sameSourceRefs(row.sourceRefs,group.memberSourceRowIds.map((id)=>({sourceRowId:id,captureId:sourceMap.get(id).captureId,ordinal:sourceMap.get(id).ordinal})))) fail("projection row source binding is invalid");
    if (row.rowBox !== null && !isRecord(row.rowBox)) fail("rowBox must be an object or null");
    if (!CLASSIFICATIONS.has(row.classification) || !Array.isArray(row.classificationReasons) || row.classificationReasons.some((r)=>typeof r!=="string"||!r)) fail("row classification is invalid");
    if (!Array.isArray(row.fields) || row.fields.length!==6 || !sameSourceRefs(row.fields.map((f)=>f.field),FIELD_KEYS)) fail("projection requires six ordered fields");
    row.fields.forEach((field,index)=>validateProjectionField(field,FIELD_KEYS[index],group.memberSourceRowIds));
  }
  const edgeIds = new Set();
  for (const item of input.edgeWorkItems) {
    exactKeys(item,["workItemId","edgeId","classification","reason","sourceRefs"],"edge work item");
    validText(item.workItemId,"workItemId"); validText(item.edgeId,"edgeId"); validText(item.reason,"edge reason");
    if (item.classification!=="NEEDS_RECAPTURE" || edgeIds.has(item.workItemId) || !Array.isArray(item.sourceRefs)) fail("edge work item is invalid"); edgeIds.add(item.workItemId);
  }
  return { sourceMap, groupMap, mapping };
}

function rawCropOrder(reconciliation, rows, groupMap) {
  const rowMap = new Map(rows.map((row)=>[row.projectionRowId,row])); const result=[]; const seen=new Set();
  for (const source of reconciliation.sourceRows) {
    const logicalId = reconciliation.sourceToLogical.find((entry)=>entry.sourceRowId===source.sourceRowId)?.logicalRowId;
    const group = groupMap.get(logicalId); const row=rowMap.get(logicalId);
    if (!group || !row) fail("crop source has no logical row");
    const member = group.memberEvidence.find((entry)=>entry.sourceRowId===source.sourceRowId);
    for (let fieldIndex=0;fieldIndex<FIELD_KEYS.length;fieldIndex+=1) {
      const ids = member ? member.fields[fieldIndex].cropRefs : row.fields[fieldIndex].cropRefs;
      if (!Array.isArray(ids)) fail("source crop lineage is invalid");
      for (const id of ids) if (!seen.has(id)) { seen.add(id); result.push(id); }
    }
  }
  return result;
}

export function buildFinalProjection3(input = {}) {
  exactKeys(input,["recognitionBatchId","rawEvidenceHash","masterBinding","correctionVersion","reconciliation","pixelAvailability","rows","edgeWorkItems"],"Projection3 builder input");
  const { recognitionBatchId, rawEvidenceHash, masterBinding, correctionVersion, reconciliation, pixelAvailability, rows, edgeWorkItems }=input;
  validText(recognitionBatchId,"recognitionBatchId"); hashShape(rawEvidenceHash,"rawEvidenceHash"); validText(correctionVersion,"correctionVersion");
  const binding=cloneJson(masterBinding,"masterBinding"); exactKeys(binding,["masterSchemaVersion","registryVersion","contentHash","hashBasis"],"masterBinding");
  if (binding.masterSchemaVersion!==2 || binding.hashBasis!=="MASTER_CANONICAL_JSON_V2" || typeof binding.registryVersion!=="string" || !binding.registryVersion) fail("Master Bundle2 binding is invalid"); hashShape(binding.contentHash,"Master contentHash");
  if(binding.registryVersion!==`registry-v2:${binding.contentHash}`) fail("Master registryVersion does not pin its contentHash");
  const cloned={reconciliation:cloneJson(reconciliation,"reconciliation"),rows:cloneJson(rows,"rows"),edgeWorkItems:cloneJson(edgeWorkItems,"edgeWorkItems")};
  const { groupMap }=validateProjectionComponents(cloned);
  if (!Array.isArray(pixelAvailability)) fail("pixelAvailability must be an array");
  const availability=cloneJson(pixelAvailability,"pixelAvailability"); const expected=rawCropOrder(cloned.reconciliation,cloned.rows,groupMap);
  if (availability.length!==expected.length || availability.some((item,index)=>!isRecord(item)||Object.keys(item).sort().join("\0")!==["cropRefId","state"].sort().join("\0")||item.cropRefId!==expected[index]||!PIXEL_STATES.has(item.state))) fail("pixelAvailability must cover all source crops in raw order");
  const projection={schemaVersion:3,reviewMode:"FINAL_CORRECTED_RESULT",recognitionBatchId,rawEvidenceHash,masterBinding:binding,correctionVersion,
    reconciliation:cloned.reconciliation,pixelAvailability:availability,rows:cloned.rows,edgeWorkItems:cloned.edgeWorkItems,hashBasis:"TRADE_FINAL_PROJECTION_JSON_V3",projectionHash:""};
  projection.projectionHash=hash(Object.fromEntries(Object.entries(projection).filter(([key])=>key!=="projectionHash")));
  return deepFreeze(projection);
}

function semanticValue(field, value) {
  if (!Object.hasOwn(NUMERIC_MINIMUM,field)) { if (typeof value!=="string"||!value||!validUnicode(value)) fail(`${field} must be nonempty text`); return value; }
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) value=Number(value);
  if (!Number.isSafeInteger(value)||value<NUMERIC_MINIMUM[field]) fail(`${field} must be a valid integer`);
  return value;
}

export function buildFinalReviewCompletion(input = {}) {
  exactKeys(input,["projection","reviewRevision","rows","workItems","confirmedAt"],"Completion3 builder input");
  const {projection,reviewRevision,rows,workItems,confirmedAt}=input;
  if (!isRecord(projection) || projection.schemaVersion!==3 || projection.reviewMode!=="FINAL_CORRECTED_RESULT") fail("Projection3 is required");
  expectedHash(projection,"projectionHash","projection");
  if (!Number.isSafeInteger(reviewRevision)||reviewRevision<0) fail("reviewRevision is invalid"); timestamp(confirmedAt,"confirmedAt");
  if (!Array.isArray(rows)||!Array.isArray(workItems)||rows.length!==projection.rows.length) fail("completion rows do not match Projection3");
  const outputRows=rows.map((submitted,index)=>{
    const projected=projection.rows[index];
    exactKeys(submitted,["projectionRowId","sourceRefs","fields","disposition","dispositionReason"],"completion row input");
    if (submitted.projectionRowId!==projected.projectionRowId || !sameSourceRefs(submitted.sourceRefs,projected.sourceRefs) || !Array.isArray(submitted.fields)||submitted.fields.length!==6) fail("completion row binding is invalid");
    const fields=submitted.fields.map((field,indexField)=>{
      exactKeysOptional(field,["field","finalValue","unknown"],["userEditReason"],"completion field input");
      const before=projected.fields[indexField]; if (field.field!==FIELD_KEYS[indexField]||field.field!==before.field||typeof field.unknown!=="boolean") fail("completion field order or unknown state is invalid");
      let value=null; let decision;
      if (field.unknown) { if (field.finalValue!==null) fail("unknown field must have null finalValue"); decision="USER_MARKED_UNKNOWN"; }
      else {
        const shown=before.finalValue===null?null:semanticValue(field.field,before.finalValue);
        if(field.finalValue===null&&shown===null) { value=null; decision="CANDIDATE_RETAINED"; }
        else {
          value=semanticValue(field.field,field.finalValue);
          decision=value===shown?"CANDIDATE_RETAINED":"USER_EDITED";
        }
        if (field.userEditReason!==undefined && (field.userEditReason!==null&&(typeof field.userEditReason!=="string"||!field.userEditReason.trim())||decision!=="USER_EDITED"&&field.userEditReason!==null)) fail("userEditReason is valid only for an edit or null");
      }
      const result={field:field.field,shownValueBefore:before.finalValue,finalValue:value,operationalDecision:decision,riskReasons:cloneJson(before.riskReasons),cropRefs:cloneJson(before.cropRefs)};
      if (field.userEditReason!==undefined) result.userEditReason=field.userEditReason;
      return result;
    });
    if (!new Set(["INCLUDE","EXCLUDE","RECAPTURE_REQUIRED"]).has(submitted.disposition)) fail("row disposition is invalid");
    if (submitted.disposition==="EXCLUDE" ? typeof submitted.dispositionReason!=="string"||!submitted.dispositionReason.trim() : submitted.dispositionReason!==null) fail("row dispositionReason is invalid");
    return {projectionRowId:projected.projectionRowId,sourceRefs:cloneJson(projected.sourceRefs),fields,disposition:submitted.disposition,dispositionReason:submitted.dispositionReason};
  });
  const expectedWorks=new Map(projection.edgeWorkItems.map((item)=>[item.workItemId,item]));
  if (workItems.length!==expectedWorks.size) fail("completion work item count is invalid");
  const outputWorks=workItems.map((work)=>{
    exactKeys(work,["workItemId","decision","reason"],"work item input");
    if (!expectedWorks.has(work.workItemId)||!new Set(["RECAPTURE_REQUIRED","EXPLICITLY_EXCLUDED"]).has(work.decision)||typeof work.reason!=="string"||!work.reason) fail("completion work item is invalid");
    expectedWorks.delete(work.workItemId); return {workItemId:work.workItemId,decision:work.decision,reason:work.reason};
  });
  if (expectedWorks.size) fail("completion omitted an edge work item");
  const completion={schemaVersion:3,reviewMode:"FINAL_CORRECTED_RESULT",recognitionBatchId:projection.recognitionBatchId,projectionHash:projection.projectionHash,
    masterBinding:cloneJson(projection.masterBinding),correctionVersion:projection.correctionVersion,reviewRevision,rows:outputRows,workItems:outputWorks,batchConfirmation:null};
  const completionValuesHash=hash(Object.fromEntries(Object.entries(completion).filter(([key])=>key!=="batchConfirmation")));
  completion.batchConfirmation={method:"USER_FINAL_LIST_CONFIRMED",confirmedAt,projectionHash:projection.projectionHash,reviewRevision,completionValuesHash};
  return deepFreeze(completion);
}

function sourceContextCheck(sourceContext, projection) {
  exactKeys(sourceContext,["schemaVersion","authority","rawEvidence","masterBundle","audit"],"sourceContext");
  if (sourceContext.schemaVersion!==3||sourceContext.authority!=="CLIENT_ATTESTED") fail("sourceContext version or authority is invalid");
  exactKeys(sourceContext.rawEvidence,["hashBasis","rawEvidenceHash","snapshot"],"rawEvidence");
  if (sourceContext.rawEvidence.hashBasis!=="TRADE_RAW_EVIDENCE_JSON_V2"||hash(sourceContext.rawEvidence.snapshot)!==sourceContext.rawEvidence.rawEvidenceHash||sourceContext.rawEvidence.rawEvidenceHash!==projection.rawEvidenceHash) fail("raw evidence binding is invalid");
  const snapshot=sourceContext.rawEvidence.snapshot;
  if (snapshot.schemaVersion!==2||snapshot.recognitionBatchId!==projection.recognitionBatchId||!Array.isArray(snapshot.captures)||!Array.isArray(snapshot.sourceRows)||!Array.isArray(snapshot.edgeSegments)) fail("RawEvidenceSnapshot2 is invalid");
  exactKeys(sourceContext.masterBundle,["binding","snapshot"],"masterBundle");
  if (!sameSourceRefs(sourceContext.masterBundle.binding,projection.masterBinding)) fail("Master binding does not match Projection3");
  const result=validateMasterBundleV2(sourceContext.masterBundle.snapshot);
  if (!result.ok || masterBundleContentHash(sourceContext.masterBundle.snapshot)!==projection.masterBinding.contentHash || sourceContext.masterBundle.snapshot.registryVersion!==projection.masterBinding.registryVersion) fail("pinned Master Bundle2 is invalid or mismatched");
  exactKeys(sourceContext.audit,["recognitionStartedAt","recognitionFinishedAt","latencyMs","gameVersion"],"audit");
  for (const key of ["recognitionStartedAt","recognitionFinishedAt"]) if (sourceContext.audit[key]!==null) timestamp(sourceContext.audit[key],key);
  if (sourceContext.audit.latencyMs!==null&&(!Number.isSafeInteger(sourceContext.audit.latencyMs)||sourceContext.audit.latencyMs<0)) fail("audit latencyMs is invalid");
  if (sourceContext.audit.gameVersion!==null&&typeof sourceContext.audit.gameVersion!=="string") fail("audit gameVersion is invalid");
  return snapshot;
}

function buildCropPlan(projection, completion, snapshot) {
  const sourceMap=new Map(snapshot.sourceRows.map((row)=>[row.sourceRowId,row])); const entries=[];
  for (let i=0;i<projection.rows.length;i+=1) {
    const row=projection.rows[i]; const completed=completion.rows[i]; const representative=sourceMap.get(row.sourceRefs[0]?.sourceRowId);
    if (!representative) fail("crop plan representative source is missing");
    for (let j=0;j<FIELD_KEYS.length;j+=1) {
      const field=FIELD_KEYS[j]; const projected=row.fields[j]; const reviewed=completed.fields[j];
      const sourceField=representative.fields.find((item)=>item.field===field); const cropRefId=sourceField?.cropRefs?.[0]?.cropRefId??null;
      const reasons=[];
      if (reviewed.operationalDecision==="USER_EDITED") reasons.push("USER_EDITED");
      if (reviewed.operationalDecision==="USER_MARKED_UNKNOWN") reasons.push("USER_MARKED_UNKNOWN");
      if (projected.riskReasons.length>0) reasons.push("RISKY_FIELD");
      const selected=reasons.length>0&&cropRefId!==null;
      const retentionClass=cropRefId===null||!selected?"NONE":reviewed.operationalDecision==="USER_MARKED_UNKNOWN"?"UNKNOWN_EVIDENCE":"OPERATIONAL_REVIEW_EVIDENCE";
      entries.push({projectionRowId:row.projectionRowId,field,cropRefId,selected,reasons,retentionClass});
    }
  }
  return {schemaVersion:3,policy:"C2_LOGICAL_REPRESENTATIVE_V3",entries};
}

export function buildFinalReviewObservationRequest(input = {}) {
  exactKeysOptional(input,["projection","completion","sourceContext","mutationId","createdAt"],["supersedesObservationId"],"Observation3 builder input");
  const {projection,completion,sourceContext,mutationId,createdAt,supersedesObservationId=null}=input;
  if (!isRecord(projection)||!isRecord(completion)) fail("Projection3 and Completion3 are required");
  exactKeys(completion,COMPLETION_KEYS,"Completion3");
  expectedHash(projection,"projectionHash","projection");
  if (!UUID.test(mutationId??"")) fail("mutationId must be a canonical UUID"); timestamp(createdAt,"createdAt");
  if (supersedesObservationId!==null&&!UUID.test(supersedesObservationId)) fail("supersedesObservationId must be null or UUID");
  if (completion.projectionHash!==projection.projectionHash||completion.recognitionBatchId!==projection.recognitionBatchId||completion.correctionVersion!==projection.correctionVersion||!sameSourceRefs(completion.masterBinding,projection.masterBinding)) fail("Completion3 binding mismatch");
  exactKeys(completion.batchConfirmation,["method","confirmedAt","projectionHash","reviewRevision","completionValuesHash"],"batch confirmation");
  if (completion.batchConfirmation.method!=="USER_FINAL_LIST_CONFIRMED"||completion.batchConfirmation.projectionHash!==projection.projectionHash||completion.batchConfirmation.reviewRevision!==completion.reviewRevision) fail("batch confirmation binding mismatch");
  const completionHash=hash(Object.fromEntries(Object.entries(completion).filter(([key])=>key!=="batchConfirmation")));
  if (completion.batchConfirmation.completionValuesHash!==completionHash) fail("Completion3 values hash mismatch");
  const snapshot=sourceContextCheck(sourceContext,projection);
  const captureIds=snapshot.captures.map((capture)=>capture.captureId);
  if(!sameSourceRefs(captureIds,projection.reconciliation.captureOrder)||snapshot.sourceRows.length!==projection.reconciliation.sourceRows.length) fail("raw source topology does not match the reconciliation ledger");
  const captureCounts=new Map(captureIds.map((id)=>[id,0]));
  snapshot.sourceRows.forEach((row,index)=>{
    const ledger=projection.reconciliation.sourceRows[index];
    if(!ledger||row.sourceRowId!==ledger.sourceRowId||row.captureId!==ledger.captureId||row.ordinal!==ledger.ordinal||ledger.projectionSourceIndex!==index) fail("raw source row mapping does not match the reconciliation ledger");
    captureCounts.set(row.captureId,(captureCounts.get(row.captureId)??0)+1);
  });
  if(snapshot.captures.some((capture)=>capture.completeRowCount!==captureCounts.get(capture.captureId))) fail("capture COMPLETE counts do not match source accounting");
  if(snapshot.edgeSegments.length!==projection.edgeWorkItems.length||snapshot.edgeSegments.some((edge,index)=>projection.edgeWorkItems[index]?.edgeId!==edge.edgeId)) fail("edge work items do not map every raw edge in order");
  return deepFreeze({schemaVersion:3,reviewMode:"FINAL_CORRECTED_RESULT",mutationId,createdAt,confirmationRevision:1,supersedesObservationId,
    projection:cloneJson(projection),completion:cloneJson(completion),sourceContext:cloneJson(sourceContext),cropPlan:buildCropPlan(projection,completion,snapshot)});
}
