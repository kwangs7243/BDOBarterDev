import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFinalReviewEvidencePreview } from "../frontend/js/trade-recognition-review.js";
import {
  buildFinalProjection3,
  buildFinalReviewCompletion,
  buildFinalReviewObservationRequest,
} from "../frontend/js/domain/trade-final-evidence.js";

const here=dirname(fileURLToPath(import.meta.url));
const contract=await readFile(resolve(here,"../../specs/008-capture-recognition-v2/EVIDENCE-V3-CONTRACT.md"),"utf8");
function jsonSection(title,nextTitle) {
  const start=contract.indexOf(title); assert.notEqual(start,-1,`missing contract section ${title}`);
  const end=nextTitle?contract.indexOf(nextTitle,start+title.length):contract.length;
  const section=contract.slice(start,end<0?contract.length:end);
  const match=section.match(/```json\s*([\s\S]*?)```/); assert.ok(match,`missing JSON in ${title}`);
  return JSON.parse(match[1]);
}
const expectedProjection=jsonSection("### 12.1 FinalProjection3","### 12.2 Completion3");
const expectedCompletion=jsonSection("### 12.2 Completion3","### 12.3 Observation3");
const expectedObservation=jsonSection("### 12.3 Observation3 (persisted record)","### 12.4");
const sourceContext=expectedObservation.sourceContext;

function projectionInput(projection=expectedProjection) {
  return {
    recognitionBatchId:projection.recognitionBatchId,rawEvidenceHash:projection.rawEvidenceHash,masterBinding:structuredClone(projection.masterBinding),
    correctionVersion:projection.correctionVersion,reconciliation:structuredClone(projection.reconciliation),pixelAvailability:structuredClone(projection.pixelAvailability),
    rows:structuredClone(projection.rows),edgeWorkItems:structuredClone(projection.edgeWorkItems),
  };
}
function completionInput(projection, completion=expectedCompletion) {
  return {
    projection,reviewRevision:completion.reviewRevision,confirmedAt:completion.batchConfirmation.confirmedAt,
    rows:completion.rows.map((row)=>({projectionRowId:row.projectionRowId,sourceRefs:row.sourceRefs,disposition:row.disposition,dispositionReason:row.dispositionReason,
      fields:row.fields.map((field)=>({field:field.field,finalValue:field.finalValue,unknown:field.operationalDecision==="USER_MARKED_UNKNOWN",...(field.userEditReason?{userEditReason:field.userEditReason}:{})}))})),
    workItems:completion.workItems,
  };
}
function buildFixture() {
  const projection=buildFinalProjection3(projectionInput());
  const completion=buildFinalReviewCompletion(completionInput(projection));
  const request=buildFinalReviewObservationRequest({projection,completion,sourceContext,mutationId:"00000000-0000-4000-8000-000000000001",createdAt:"2026-10-02T00:01:00Z"});
  return {projection,completion,request};
}

const {projection,completion,request}=buildFixture();
assert.deepEqual(projection,expectedProjection,"Projection3 must match the contract fixture, including Python-generated hash");
assert.deepEqual(completion,expectedCompletion,"Completion3 must match the contract fixture, including Python-generated hash");
assert.deepEqual(request.projection,expectedProjection);
assert.deepEqual(request.completion,expectedCompletion);
assert.equal(request.cropPlan.schemaVersion,3);
assert.equal(Object.keys(await import("../frontend/js/domain/trade-final-evidence.js")).length,3,"domain module must expose only its three contract builders");

const before=JSON.stringify({projection:projectionInput(),completion:completionInput(projection),sourceContext});
const again=buildFixture();
assert.equal(again.projection.projectionHash,projection.projectionHash);
assert.equal(again.completion.batchConfirmation.completionValuesHash,completion.batchConfirmation.completionValuesHash);
assert.deepEqual(again.request,request,"retry input must reproduce the same request body");
assert.equal(JSON.stringify({projection:projectionInput(),completion:completionInput(projection),sourceContext}),before,"builders must not mutate inputs");
assert.ok(Object.isFrozen(projection)&&Object.isFrozen(projection.rows[0].fields[0])&&Object.isFrozen(completion.rows[0].fields[0])&&Object.isFrozen(request.sourceContext));

const sample=completion.rows[0].fields;
assert.deepEqual(sample.map((field)=>field.operationalDecision),["CANDIDATE_RETAINED","CANDIDATE_RETAINED","CANDIDATE_RETAINED","CANDIDATE_RETAINED","USER_MARKED_UNKNOWN","USER_EDITED"]);
assert.equal(sample[2].finalValue,1);
assert.equal(sample[4].finalValue,null);
assert.equal(sample[5].finalValue,148);
assert.equal(sample.some((field)=>Object.hasOwn(field,"truthEvidence")),false,"operational completion must not mint crop truth");
assert.equal(request.completion.batchConfirmation.method,"USER_FINAL_LIST_CONFIRMED");
assert.equal(request.cropPlan.entries.length,6);
assert.equal(request.cropPlan.entries.find((entry)=>entry.field==="count").retentionClass,"UNKNOWN_EVIDENCE");

for (const classification of ["FINAL_READY","NEEDS_REVIEW","NEEDS_RECAPTURE","CONFLICT"]) {
  const changed=projectionInput(); changed.rows[0].classification=classification;
  assert.equal(buildFinalProjection3(changed).rows[0].classification,classification);
}

const reordered=projectionInput();
reordered.rows=[{...reordered.rows[0],classificationReasons:[...reordered.rows[0].classificationReasons]}];
reordered.masterBinding=Object.fromEntries(Object.entries(reordered.masterBinding).reverse());
assert.equal(buildFinalProjection3(reordered).projectionHash,projection.projectionHash,"object key order must not affect canonical hash");

const zeroCount=completionInput(projection);
zeroCount.rows[0].fields[4]={field:"count",finalValue:0,unknown:false};
assert.equal(buildFinalReviewCompletion(zeroCount).rows[0].fields[4].operationalDecision,"CANDIDATE_RETAINED");
const editedZero=completionInput(projection);
editedZero.rows[0].fields[4]={field:"count",finalValue:1,unknown:false};
assert.equal(buildFinalReviewCompletion(editedZero).rows[0].fields[4].operationalDecision,"USER_EDITED");

for (const invalid of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,"",null]) {
  const bad=completionInput(projection); bad.rows[0].fields[2]={field:"reqAmount",finalValue:invalid,unknown:false};
  assert.throws(()=>buildFinalReviewCompletion(bad),TypeError,`reqAmount ${String(invalid)} must reject`);
}
for (const invalid of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1]) {
  const bad=completionInput(projection); bad.rows[0].fields[5]={field:"yield",finalValue:invalid,unknown:false};
  assert.throws(()=>buildFinalReviewCompletion(bad),TypeError,`yield ${String(invalid)} must reject`);
}
for (const invalid of [-1,1.5,Number.MAX_SAFE_INTEGER+1]) {
  const bad=completionInput(projection); bad.rows[0].fields[4]={field:"count",finalValue:invalid,unknown:false};
  assert.throws(()=>buildFinalReviewCompletion(bad),TypeError,`count ${String(invalid)} must reject`);
}

const missing=projectionInput(); missing.reconciliation.sourceToLogical.pop();
assert.throws(()=>buildFinalProjection3(missing),TypeError,"missing source mapping must reject");
const duplicate=projectionInput(); duplicate.reconciliation.groups[0].memberSourceRowIds.push(duplicate.reconciliation.groups[0].memberSourceRowIds[0]);
assert.throws(()=>buildFinalProjection3(duplicate),TypeError,"duplicate source accounting must reject");
const invalidPixels=projectionInput(); invalidPixels.pixelAvailability[0].state="AVAILABLE";
assert.throws(()=>buildFinalProjection3(invalidPixels),TypeError,"uncontracted pixel state must reject");
const unavailablePixels=projectionInput(); unavailablePixels.pixelAvailability[0].state="MISSING";
assert.equal(buildFinalProjection3(unavailablePixels).pixelAvailability[0].state,"MISSING");
const tamperedMaster=structuredClone(sourceContext); tamperedMaster.masterBundle.binding.contentHash="0".repeat(64);
assert.throws(()=>buildFinalReviewObservationRequest({projection,completion,sourceContext:tamperedMaster,mutationId:"00000000-0000-4000-8000-000000000001",createdAt:"2026-10-02T00:01:00Z"}),TypeError);
const changedMaster=projectionInput(); changedMaster.masterBinding.contentHash="1".repeat(64); changedMaster.masterBinding.registryVersion=`registry-v2:${changedMaster.masterBinding.contentHash}`;
assert.notEqual(buildFinalProjection3(changedMaster).projectionHash,projection.projectionHash,"a pinned Master Bundle2 change must change the projection hash");
const changedArray=projectionInput(); changedArray.rows[0].classificationReasons=["FIRST","SECOND"];
const reverseArray=projectionInput(); reverseArray.rows[0].classificationReasons=["SECOND","FIRST"];
assert.notEqual(buildFinalProjection3(changedArray).projectionHash,buildFinalProjection3(reverseArray).projectionHash,"array order must remain semantic");

const sixToFour=(()=>{
  const captureOrder=["cap-a","cap-b"];
  const sourceRows=[0,1,2,3,4,5].map((index)=>({sourceRowId:`source-${index}`,captureId:index<3?"cap-a":"cap-b",ordinal:index%3,projectionSourceIndex:index}));
  const specs=[{id:"logical-0",members:[0],status:"SINGLE"},{id:"logical-1",members:[1,3],status:"EXACT_OVERLAP"},{id:"logical-2",members:[2,4],status:"CONFLICT"},{id:"logical-3",members:[5],status:"SINGLE"}];
  const cropIds=[];
  const memberFields=(sourceIndex)=>expectedProjection.rows[0].fields.map((field,fieldIndex)=>({
    ...structuredClone(field),rawEvidenceRefs:[{sourceRowId:`source-${sourceIndex}`,field:field.field}],cropRefs:[`crop-${sourceIndex}-${fieldIndex}`],
  }));
  const groups=specs.map((spec,index)=>{
    const ids=spec.members.map((member)=>`source-${member}`);
    const memberEvidence=spec.members.length===1?[]:spec.members.map((member)=>({sourceRowId:`source-${member}`,fields:memberFields(member)}));
    return {groupId:`group-${index}`,status:spec.status,memberSourceRowIds:ids,representativeSourceRowId:ids[0],logicalRowId:spec.id,memberEvidence};
  });
  const rows=specs.map((spec,index)=>{
    const members=spec.members; const first=members[0];
    const fields=expectedProjection.rows[0].fields.map((field,fieldIndex)=>{
      const result={...structuredClone(field),rawEvidenceRefs:members.map((member)=>({sourceRowId:`source-${member}`,field:field.field})),
        cropRefs:members.map((member)=>`crop-${member}-${fieldIndex}`)};
      if(spec.status==="CONFLICT"&&field.field==="yield") { result.finalValue=null; result.selectedCandidateIndex=null; result.valueState="CONFLICT"; result.alternatives=members.map((member)=>({value:48+member,sourceRefs:[{sourceRowId:`source-${member}`,captureId:member<3?"cap-a":"cap-b",ordinal:member%3}],riskReasons:["RECONCILIATION_CONFLICT"]})); }
      return result;
    });
    const sourceRefs=members.map((member)=>({sourceRowId:`source-${member}`,captureId:member<3?"cap-a":"cap-b",ordinal:member%3}));
    return {projectionRowId:spec.id,captureId:first<3?"cap-a":"cap-b",ordinal:first%3,rowBox:expectedProjection.rows[0].rowBox,sourceRefs,fields,
      classification:spec.status==="CONFLICT"?"CONFLICT":"NEEDS_REVIEW",classificationReasons:spec.status==="CONFLICT"?["RECONCILIATION_CONFLICT"]:["MASTER_UNRESOLVED"]};
  });
  const sourceToLogical=specs.flatMap((spec,index)=>spec.members.map((member)=>({sourceRowId:`source-${member}`,logicalRowId:spec.id}))).sort((a,b)=>Number(a.sourceRowId.slice(7))-Number(b.sourceRowId.slice(7)));
  for(const source of sourceRows) for(let fieldIndex=0;fieldIndex<6;fieldIndex+=1) cropIds.push(`crop-${Number(source.sourceRowId.slice(7))}-${fieldIndex}`);
  return {recognitionBatchId:"batch-example-1",rawEvidenceHash:expectedProjection.rawEvidenceHash,masterBinding:structuredClone(expectedProjection.masterBinding),correctionVersion:expectedProjection.correctionVersion,
    reconciliation:{schemaVersion:2,policyVersion:"trade-batch-reconciliation-v1",captureOrder,sourceRows,groups,sourceToLogical,findings:[]},
    pixelAvailability:cropIds.map((cropRefId)=>({cropRefId,state:"IN_MEMORY"})),rows,edgeWorkItems:[]};
})();
const sixToFourProjection=buildFinalProjection3(sixToFour);
assert.equal(sixToFourProjection.reconciliation.sourceRows.length,6);
assert.equal(sixToFourProjection.rows.length,4);
assert.equal(sixToFourProjection.reconciliation.sourceToLogical.length,6);
assert.equal(sixToFourProjection.rows[2].classification,"CONFLICT");

console.log("trade_final_evidence_regression: PASS · contract/Python hash parity, retained/edit/unknown, count zero, immutable inputs, exact source accounting, Master pin, retry-stable request");

function canonical(value) {
  if (value===null||typeof value!=="object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const compare=(a,b)=>{const x=Array.from(a,c=>c.codePointAt(0)),y=Array.from(b,c=>c.codePointAt(0));for(let i=0;i<Math.min(x.length,y.length);i+=1)if(x[i]!==y[i])return x[i]-y[i];return x.length-y.length;};
  return `{${Object.keys(value).sort(compare).map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function hash(value) { return createHash("sha256").update(canonical(value),"utf8").digest("hex"); }
async function freePort() { const server=createServer(); await new Promise((resolvePort)=>server.listen(0,"127.0.0.1",resolvePort)); const port=server.address().port; await new Promise((resolveClose)=>server.close(resolveClose)); return port; }
async function waitForHealth(url, child) {
  const start=Date.now();
  while(Date.now()-start<30000) {
    if(child.exitCode!==null) throw new Error(`isolated E1-A server exited (${child.exitCode})`);
    try { const response=await fetch(`${url}api/health`); if(response.ok)return; } catch {}
    await new Promise((resolveWait)=>setTimeout(resolveWait,100));
  }
  throw new Error("isolated E1-A server health timeout");
}
async function runApiIntegration() {
  const temp=await mkdtemp(join(tmpdir(),"bdo-e1b-preview-")); const port=await freePort(); const base=`http://127.0.0.1:${port}/`;
  const pythonCode=`
import base64, hashlib, io, os
from flask import jsonify, request
from PIL import Image
from local_app.backend.app import create_app
root=os.environ['E1B_TEST_ROOT']; port=int(os.environ['E1B_TEST_PORT'])
app=create_app(os.path.join(root,'main.sqlite3'),recognition_database_path=os.path.join(root,'recognition','recognition.sqlite3'),testing=True)
requests=[]
@app.before_request
def record_request(): requests.append({'method':request.method,'path':request.path})
@app.get('/__test__/crop')
def test_crop():
 image=Image.new('RGB',(10,10),(17,34,51)); output=io.BytesIO(); image.save(output,format='PNG'); data=output.getvalue()
 return jsonify({'png':base64.b64encode(data).decode('ascii'),'sha256':hashlib.sha256(data).hexdigest(),'pixelSha256':hashlib.sha256(image.tobytes()).hexdigest()})
@app.get('/__test__/requests')
def test_requests(): return jsonify(requests)
app.run(host='127.0.0.1',port=port,use_reloader=False,threaded=True)
`;
  const python=process.env.PYTHON??"python";
  const server=spawn(python,["-B","-c",pythonCode],{cwd:resolve(here,"../.."),windowsHide:true,stdio:["ignore","ignore","pipe"],env:{...process.env,E1B_TEST_ROOT:temp,E1B_TEST_PORT:String(port),LOCALAPPDATA:temp,PYTHONDONTWRITEBYTECODE:"1"}});
  let stderr=""; server.stderr.on("data",chunk=>{stderr+=chunk.toString();});
  try {
    await waitForHealth(base,server);
    const cropData=await (await fetch(`${base}__test__/crop`)).json(); const png=Buffer.from(cropData.png,"base64");
    const inputSnapshot=structuredClone(sourceContext.rawEvidence.snapshot);
    const firstCrop=inputSnapshot.sourceRows[0].fields.find(field=>field.field==="island").cropRefs[0];
    firstCrop.pixelSha256=cropData.pixelSha256; firstCrop.pngArtifactSha256=cropData.sha256;
    const updatedRawHash=hash(inputSnapshot);
    const integrationContext=structuredClone(sourceContext); integrationContext.rawEvidence.snapshot=inputSnapshot; integrationContext.rawEvidence.rawEvidenceHash=updatedRawHash;
    const projectionArgs=projectionInput(); projectionArgs.rawEvidenceHash=updatedRawHash;
    const integrationCompletion=completionInput(projection,expectedCompletion);
    const preview=buildFinalReviewEvidencePreview({projectionInput:projectionArgs,completionInput:integrationCompletion,sourceContext:integrationContext,
      mutationId:"10000000-0000-4000-8000-000000000001",createdAt:"2026-10-02T00:01:00Z"});
    assert.equal(preview.request.projection.rawEvidenceHash,updatedRawHash);
    const requestBody=JSON.stringify(preview.request); const url=`${base}api/recognition/trade-review-observations`;
    const headers={"Content-Type":"application/json","Origin":base.slice(0,-1),"Sec-Fetch-Site":"same-origin"};
    const first=await fetch(url,{method:"POST",headers,body:requestBody}); const firstJson=await first.json();
    assert.equal(first.status,201,JSON.stringify(firstJson));
    const retry=await fetch(url,{method:"POST",headers,body:requestBody}); const retryJson=await retry.json();
    assert.equal(retry.status,200,JSON.stringify(retryJson)); assert.equal(retryJson.receipt.duplicate,true);
    const id=firstJson.receipt.observationId;
    const get=await fetch(`${url}/${id}?schemaVersion=3`); const saved=await get.json(); assert.equal(get.status,200); assert.equal(saved.observation.projection.projectionHash,preview.projection.projectionHash);
    const exportedResponse=await fetch(`${url}/${id}/export?schemaVersion=3`); const exported=await exportedResponse.json(); assert.equal(exportedResponse.status,200); assert.equal(exported.exportType,"TRADE_FINAL_REVIEW_OBSERVATION");
    const cropRef=firstCrop; const cropMetadata={schemaVersion:3,cropMutationId:"20000000-0000-4000-8000-000000000001",projectionRowId:preview.projection.rows[0].projectionRowId,
      field:"island",cropRefId:cropRef.cropRefId,sha256:cropData.sha256,pixelSha256:cropData.pixelSha256,width:10,height:10};
    const form=new FormData(); form.append("metadata",JSON.stringify(cropMetadata)); form.append("image",new Blob([png],{type:"image/png"}),"crop.png");
    const cropPost=await fetch(`${url}/${id}/crops`,{method:"POST",headers:{Origin:base.slice(0,-1),"Sec-Fetch-Site":"same-origin"},body:form});
    const cropReceipt=await cropPost.json(); assert.equal(cropPost.status,201,JSON.stringify(cropReceipt));
    const cropGet=await fetch(`${url}/${id}/export/crops/${cropData.sha256}`); assert.equal(cropGet.status,200); assert.deepEqual(Buffer.from(await cropGet.arrayBuffer()),png);
    const requestLog=await (await fetch(`${base}__test__/requests`)).json();
    assert.equal(requestLog.filter(item=>item.method==="POST"&&item.path.endsWith("/truth-labels")).length,0,"operational preview must make zero truth-label POSTs");
    assert.equal(requestLog.filter(item=>item.method==="POST"&&item.path.startsWith("/api/working-session")).length,0,"preview must make zero session writes");
    console.log("E1-A preview integration: PASS · first POST 201, identical retry 200 duplicate, GET, Export3, real Pillow-validated crop save/readback, truth POST 0, session POST 0");
  } finally {
    if(server.exitCode===null) { server.kill(); await new Promise(resolveExit=>server.once("exit",resolveExit)); }
    await rm(temp,{recursive:true,force:true});
    if(server.exitCode!==null&&server.exitCode!==0&&server.signalCode===null&&stderr.trim()) throw new Error(stderr.trim());
  }
}
if (process.argv.includes("--api-integration")) await runApiIntegration();
