import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { adaptLegacyCatalog } from "../frontend/js/domain/trade-master-registry.js";
import { adaptRegistrySnapshotV1ToMasterBundleV2, applyTradeMasterReferenceManifestToBundleV2, createMasterBundleV2 } from "../frontend/js/domain/trade-master-bundle.js";
import { computeCatalogProvenanceV2 } from "../frontend/js/domain/trade-catalog-provenance.js";
import { validateReviewedTradeBatch } from "../frontend/js/domain/reviewed-trade-dto.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(appRoot, "..");
const port = Number(process.env.BDO_TEST_PORT ?? 18787);
const baseUrl = process.env.BDO_TEST_URL ?? `http://127.0.0.1:${port}/`;
const python = process.env.PYTHON ?? "python";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-arch-a1b-act1-"));
const database = join(profile, "isolated.sqlite3");
const masterDatabase = join(profile, "master", "master.sqlite3");
const catalogBytes = await readFile(resolve(appRoot, "frontend/data/trade-catalog.json"));
const provenance = computeCatalogProvenanceV2(catalogBytes);
const registry = adaptLegacyCatalog(provenance.catalog, { sourceRevision: `catalog-provenance-v2:${provenance.sha256}`,
  sourceSha256: provenance.sha256, curatedMappings: null });
const baseBundle = adaptRegistrySnapshotV1ToMasterBundleV2(registry, { createdAt: "2026-10-02T00:00:00Z",
  catalogProvenance: { schemaVersion: provenance.schemaVersion, hashBasis: provenance.hashBasis, sha256: provenance.sha256 } });
const manifest = JSON.parse(await readFile(resolve(appRoot, "frontend/data/trade-master-reference-manifest-v2.json"), "utf8"));
const bundleA = applyTradeMasterReferenceManifestToBundleV2(baseBundle, manifest, { createdAt: "2026-10-02T00:00:00Z", catalogBytes });
const bundleB = createMasterBundleV2({ createdAt: "2026-10-03T00:00:00Z", entities: bundleA.entities,
  compatibilityMappings: bundleA.compatibilityMappings, unresolvedLegacyNames: bundleA.unresolvedLegacyNames,
  sourceRevisions: bundleA.sourceRevisions, provenance: { ...bundleA.provenance, testPublishRevision: "owner-publish-during-review" } });

const pythonCode = `
import hashlib, time
from io import BytesIO
from PIL import Image
from flask import jsonify
from local_app.backend.app import create_app
from local_app.backend.services.trade_batch_runtime import TradeBatchRuntimeError

FIELDS = ("island", "fromItem", "reqAmount", "toItem", "count", "yield")
TO = (("말린 푸른 장미", "로아 꽃 씨앗 주머니", "해상 전투 식량"),
      ("로아 꽃 씨앗 주머니", "해상 전투 식량", "알 수 없는 고대 벽화"))
YIELD = ((48, 48, 48), (48, 148, 48))
class Runtime:
    def __init__(self): self.mode = "error"; self.v1 = 0; self.v2 = 0
    def status(self): return {"available": True, "modelReady": True, "reason": None, "engineId": "act1-test"}
    def recognize(self, batch_id, captures):
        self.v1 += 1
        raise AssertionError("v1 recognition must never be called by the primary flow")
    def recognize_raw_v2(self, batch_id, captures):
        self.v2 += 1
        if self.mode == "error": raise TradeBatchRuntimeError("recognition_worker_failed", "test v2 failure", 502, retryable=True)
        if self.mode == "malformed": return {"rawEvidence": {"schemaVersion": 2}, "runtime": {}}
        raw_captures, rows = [], []
        for capture_index, capture in enumerate(captures):
            meta = capture["metadata"]; image_bytes = capture["imageBytes"]
            image = Image.open(BytesIO(image_bytes)).convert("RGB"); rgb = image.tobytes(); frame = {"width": image.width, "height": image.height}
            raw_captures.append({"captureId": capture["captureId"], "captureOrdinal": capture_index+1,
                "imageSha256": hashlib.sha256(image_bytes).hexdigest(), "bitmapSha256": hashlib.sha256(rgb).hexdigest(),
                "sourceType": {"file":"FILE","clipboard":"CLIPBOARD","browser-stream":"STREAM"}[meta["sourceType"]],
                "frame": frame, "sourceFidelity": meta["fidelity"], "reencoded": capture["reencoded"], "completeRowCount": 3})
        base_yield = 48
        capture_yields = ((base_yield, base_yield, base_yield), (base_yield, base_yield + (0 if self.mode == "append" else 100), base_yield))
        for capture_index, capture in enumerate(captures):
          meta = capture["metadata"]; image_bytes = capture["imageBytes"]
          image = Image.open(BytesIO(image_bytes)).convert("RGB"); frame = {"width": image.width, "height": image.height}
          for ordinal in range(3):
                source_id = f"{capture['captureId']}-row-{ordinal}"
                to_item = ("알 수 없는 고대 벽화" if ordinal == 2 else TO[0][ordinal]) if self.mode == "append" else TO[capture_index][ordinal]
                values = {"island":"하코번 섬", "fromItem":"말린 푸른 장미", "reqAmount":10, "toItem":to_item,
                          "count":0, "yield":capture_yields[capture_index][ordinal]}
                fields = []
                for field_index, field in enumerate(FIELDS):
                    box = {"x": 8 + field_index*18, "y": 12 + ordinal*42, "width": 8, "height": 8}
                    pixels = bytearray()
                    for y in range(box["y"], box["y"]+box["height"]):
                        for x in range(box["x"], box["x"]+box["width"]): pixels.extend(image.getpixel((x,y)))
                    numeric = field in ("reqAmount", "count", "yield")
                    crop_id = f"{source_id}-{field}"
                    fields.append({"field":field, "rawText":str(values[field]), "rawNumeric":values[field] if numeric else None,
                        "readerStatus":"RAW_OCR_CANDIDATE", "confidence":"0.91", "cropRefs":[{
                          "cropRefId":crop_id,"sourceRowId":source_id,"captureId":capture["captureId"],"field":field,
                          "bitmapSha256":raw_captures[capture_index]["bitmapSha256"],"frame":frame,"coordinateSpace":"CAPTURE_BITMAP_PIXELS",
                          "box":box,"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":hashlib.sha256(pixels).hexdigest(),"pngArtifactSha256":None}]})
                rows.append({"sourceRowId":source_id,"captureId":capture["captureId"],"ordinal":ordinal,
                    "rowBox":{"x":0,"y":10+ordinal*42,"width":620,"height":34},"fields":fields})
        return {"rawEvidence":{"schemaVersion":2,"recognitionBatchId":batch_id,"captures":raw_captures,"sourceRows":rows,"edgeSegments":[]},
                "runtime":{"available":True,"engineId":"act1-test","modelBundleSha256":"a"*64,"workerVersion":"test-v2",
                           "durationMs":1,"captureCount":len(captures)}}

app = create_app(r'${database}', master_database_path=r'${masterDatabase}', testing=True)
runtime = Runtime(); app.extensions["trade_batch_runtime"] = runtime
@app.post("/__test__/mode/<mode>")
def set_mode(mode): runtime.mode = mode; return jsonify({"ok":True})
@app.get("/__test__/state")
def state(): return jsonify({"v1":runtime.v1,"v2":runtime.v2,"mode":runtime.mode})
app.run(host="127.0.0.1",port=${port},use_reloader=False,threaded=True)
`;
let server; let chrome; let socket;
async function waitFor(predicate, label, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) { const result = await predicate(); if (result) return result; await new Promise((r) => setTimeout(r, 80)); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function publishBundle(bundle, expectedRegistryVersion) {
  const proposalResponse = await fetch(`${baseUrl}api/master/proposal`, { method: "POST", headers: { "Content-Type":"application/json", Origin:baseUrl.replace(/\/$/, "") },
    body: JSON.stringify({ version:1, expectedRegistryVersion, bundle }) });
  const proposal = await proposalResponse.json(); assert.equal(proposalResponse.ok, true, JSON.stringify(proposal));
  const publishResponse = await fetch(`${baseUrl}api/master/publish`, { method:"POST", headers:{"Content-Type":"application/json", Origin:baseUrl.replace(/\/$/, "")},
    body:JSON.stringify({ version:1, mutationId:randomUUID(), expectedRegistryVersion, ownerApproved:true,
      proposalHash:proposal.proposal.proposalHash, bundle }) });
  const published = await publishResponse.json(); assert.equal(publishResponse.ok,true,JSON.stringify(published));
  return published.receipt;
}
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((resolveExit) => child.once("exit", resolveExit)); child.kill();
  await Promise.race([done,new Promise((resolveWait)=>setTimeout(resolveWait,3000))]);
}
try {
  server = spawn(python,["-B","-c",pythonCode],{cwd:root,stdio:"ignore",windowsHide:true,
    env:{...process.env,LOCALAPPDATA:profile,PYTHONDONTWRITEBYTECODE:"1"}});
  await waitFor(async()=>{try{return(await fetch(`${baseUrl}api/health`)).ok}catch{return false}},"isolated app server");
  const publishedA = await publishBundle(bundleA,null);
  chrome = spawn(chromePath,["--headless=new","--no-sandbox","--disable-gpu","--no-first-run","--disable-extensions",
    "--disable-background-networking","--remote-debugging-port=0","--remote-allow-origins=*",`--user-data-dir=${join(profile,"chrome")}`,"about:blank"],
    {stdio:"ignore",windowsHide:true});
  const activeText = await waitFor(async()=>{try{return await readFile(join(profile,"chrome","DevToolsActivePort"),"utf8")}catch{return false}},"Chrome CDP");
  const targetResponse = await fetch(`http://127.0.0.1:${activeText.trim().split(/\r?\n/)[0]}/json/new?${encodeURIComponent(baseUrl)}`,{method:"PUT"});
  assert.equal(targetResponse.ok,true); const target=await targetResponse.json(); socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen,reject)=>{socket.addEventListener("open",resolveOpen,{once:true});socket.addEventListener("error",reject,{once:true})});
  const pending=new Map();let nextId=0;
  socket.addEventListener("message",(event)=>{const msg=JSON.parse(event.data);if(!msg.id||!pending.has(msg.id))return;const item=pending.get(msg.id);pending.delete(msg.id);msg.error?item.reject(new Error(msg.error.message)):item.resolve(msg.result)});
  const send=(method,params={})=>new Promise((resolveMessage,reject)=>{const id=++nextId;pending.set(id,{resolve:resolveMessage,reject});socket.send(JSON.stringify({id,method,params}))});
  const evaluate=async(expression)=>{const out=await send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});if(out.exceptionDetails)throw new Error(out.exceptionDetails.exception?.description??out.exceptionDetails.text);return out.result?.value};
  await send("Page.enable");await send("Runtime.enable");await send("DOM.enable");
  await waitFor(async()=>evaluate("document.querySelector('#app-content')?.getAttribute('aria-busy')==='false'"),"app bootstrap");
  await evaluate(`(()=>{window.__act1={blockMaster:true,failObservation:false,masterGets:0,v1:0,v2:0,observationBodies:[],cropMetadata:[],truth:0,receipt:null,batchResponse:null};const original=window.fetch.bind(window);window.fetch=async(input,init={})=>{const url=String(input);if(url.endsWith('/api/master/active')){window.__act1.masterGets++;if(window.__act1.blockMaster)return new Response(JSON.stringify({ok:false}),{status:503,headers:{'Content-Type':'application/json'}})}if(url.endsWith('/api/recognition/trade-batch')){const batch=JSON.parse(init.body.get('batch'));if(batch.version===1)window.__act1.v1++;if(batch.version===2)window.__act1.v2++}if(url.endsWith('/api/recognition/trade-review-observations')&&init.method==='POST'){window.__act1.observationBodies.push(init.body);if(window.__act1.failObservation){window.__act1.failObservation=false;return new Response(JSON.stringify({ok:false,error:{message:'test retry',retryable:true}}),{status:503,headers:{'Content-Type':'application/json'}})}}if(url.includes('/crops')&&init.method==='POST')window.__act1.cropMetadata.push(JSON.parse(init.body.get('metadata')));if(url.includes('/truth-labels'))window.__act1.truth++;const response=await original(input,init);if(url.endsWith('/api/recognition/trade-batch'))window.__act1.batchResponse={status:response.status,body:await response.clone().json().catch(()=>null)};if(url.endsWith('/api/recognition/trade-review-observations')&&init.method==='POST'&&response.ok){const body=await response.clone().json();window.__act1.receipt=body.receipt}return response}})()`);
  await evaluate("document.querySelector('#open-trade-capture').click()");
  await waitFor(async()=>evaluate("document.querySelector('[data-role=trade-runtime-status]')?.textContent==='로컬 인식 사용 가능'"),"trade runtime status");
  const input="document.querySelector('#trade-capture-files')";
  const addCaptures=async(seed)=>{
    await evaluate(`(async()=>{const input=${input};const transfer=new DataTransfer();for(let i=0;i<2;i++){const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const ctx=canvas.getContext('2d');ctx.fillStyle=${seed}===120?'rgb(30,50,70)':(i?'rgb(20,40,60)':'rgb(30,50,70)');ctx.fillRect(0,0,640,360);ctx.fillStyle='rgb(${seed},90,110)';ctx.fillRect(620,340,8,8);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));transfer.items.add(new File([blob],'capture-${seed}-'+i+'.png',{type:'image/png'}))}input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await waitFor(async()=>evaluate("document.querySelector('#trade-capture-dialog')?.dataset.queueLength==='2'"),"two queued captures");
  };
  await addCaptures(90);
  await evaluate("document.querySelector('[data-action=recognize-trade]').click()");
  await waitFor(async()=>evaluate("document.querySelector('[data-role=trade-recognition-status]')?.textContent && !document.querySelector('[data-role=trade-recognition-status]').textContent.includes('로컬 인식 중')"),"Master failure settled");
  const masterFailureStatus=await evaluate("document.querySelector('[data-role=trade-recognition-status]').textContent");
  assert.match(masterFailureStatus,/활성 Master/,JSON.stringify({status:masterFailureStatus,ui:await evaluate("window.__act1"),runtime:await(await fetch(`${baseUrl}__test__/state`)).json()}));
  assert.equal(await evaluate("document.querySelector('#trade-capture-dialog').dataset.queueLength"),"2");
  assert.deepEqual(await (await fetch(`${baseUrl}__test__/state`)).json(),{v1:0,v2:0,mode:"error"});
  await evaluate("window.__act1.blockMaster=false;document.querySelector('[data-action=recognize-trade]').click()");
  await waitFor(async()=>evaluate("document.querySelector('[data-role=trade-recognition-status]')?.textContent && !document.querySelector('[data-role=trade-recognition-status]').textContent.includes('로컬 인식 중')"),"v2 error settled");
  let runtimeState=await(await fetch(`${baseUrl}__test__/state`)).json();assert.equal(runtimeState.v1,0);assert.equal(runtimeState.v2,1);
  assert.match(await evaluate("document.querySelector('[data-role=trade-recognition-status]').textContent"),/실패/);
  assert.equal(await evaluate("window.__act1.v1"),0);assert.equal(await evaluate("window.__act1.observationBodies.length"),0);

  await fetch(`${baseUrl}__test__/mode/success`,{method:"POST"});
  await evaluate("document.querySelector('[data-action=recognize-trade]').click()");
  await waitFor(async()=>evaluate("document.querySelector('.trade-final-review-shell') && document.querySelector('#trade-recognition-review-dialog')?.open"),"FinalReview3 primary mount");
  assert.equal(await evaluate("window.__act1.v2"),2);assert.equal(await evaluate("window.__act1.v1"),0);
  assert.equal(await evaluate("document.querySelectorAll('.trade-final-review-summary-item')[0].innerText.includes('2')"),true);
  assert.equal(await evaluate("document.querySelectorAll('.trade-final-review-summary-item')[1].innerText.includes('6')"),true);
  const summaryText=await evaluate("JSON.stringify([...document.querySelectorAll('.trade-final-review-summary-item')].map(x=>x.innerText))").then(JSON.parse);
  assert.ok(summaryText.some((text)=>text.includes("최종 행")&&text.includes("4")),JSON.stringify(summaryText));
  const currentActive=(await(await fetch(`${baseUrl}api/master/active`)).json()).activeRegistryVersion;
  assert.equal(currentActive,bundleA.registryVersion);
  const publishedB=await publishBundle(bundleB,bundleA.registryVersion);
  assert.notEqual(bundleB.registryVersion,bundleA.registryVersion);
  assert.equal(await evaluate("window.__act1.masterGets"),3,"one failed plus one pin per successful/attempted recognition; review must not re-fetch active Master");

  const rows=await evaluate("JSON.stringify([...document.querySelectorAll('.trade-final-review-list-item')].map(x=>({id:x.dataset.itemId,text:x.innerText})))").then(JSON.parse);
  const conflict=rows.find((row)=>row.text.includes('해상 전투 식량'));
  assert.ok(conflict,"overlap conflict row is visible in the initial problem tab");
  await evaluate(`document.querySelector('[data-item-id="${conflict.id}"]').click()`);
  await waitFor(async()=>evaluate("document.querySelector('[data-field=yield] [data-action=choose-alternative]')"),"yield conflict alternatives");
  await evaluate("document.querySelector('[data-field=yield] [data-action=choose-alternative]').click()");
  const unique=(await evaluate("document.querySelector('[role=tab][data-tab=all]').click();JSON.stringify([...document.querySelectorAll('.trade-final-review-list-item')].map(x=>({id:x.dataset.itemId,text:x.innerText})))").then(JSON.parse)).find((row)=>row.text.includes('알 수 없는 고대 벽화'));
  assert.ok(unique,"unique row is available for unknown review");
  await evaluate(`document.querySelector('[role=tab][data-tab=all]').click();document.querySelector('[data-item-id="${unique.id}"]').click()`);
  const toggle=await evaluate("document.querySelector('[data-action=toggle-edit]')");if(toggle)await evaluate("document.querySelector('[data-action=toggle-edit]').click()");
  const markUnknown=await evaluate("[...document.querySelectorAll('[data-field=count] [data-action=mark-unknown]')].length>0");
  if(markUnknown) await evaluate("document.querySelector('[data-field=count] [data-action=mark-unknown]').click()");
  await evaluate("document.querySelector('[data-action=exclude-row]').click();const reason=document.querySelector('[data-action=row-exclusion-reason]');reason.value='synthetic test: field intentionally unknown';reason.dispatchEvent(new Event('input',{bubbles:true}))");
  await evaluate("window.__act1.failObservation=true;document.querySelector('[data-action=confirm]').click()");
  await waitFor(async()=>evaluate("document.querySelector('.trade-review-storage-actions button')?.hidden===false"),"save retry control");
  assert.equal(await evaluate("window.__act1.observationBodies.length"),1);
  const firstBody=await evaluate("window.__act1.observationBodies[0]");const parsedRequest=JSON.parse(firstBody);
  assert.equal(parsedRequest.schemaVersion,3);assert.equal(parsedRequest.reviewMode,"FINAL_CORRECTED_RESULT");
  assert.equal(parsedRequest.projection.rows.length,4);assert.equal(parsedRequest.projection.reconciliation.sourceRows.length,6);
  assert.equal(parsedRequest.sourceContext.masterBundle.binding.registryVersion,bundleA.registryVersion);
  assert.equal(parsedRequest.sourceContext.masterBundle.binding.contentHash,bundleA.contentHash);
  assert.equal(parsedRequest.projection.rows.some((r)=>r.fields.some((f)=>f.valueState==="CONFLICT"&&f.finalValue!==null)),false);
  assert.ok(parsedRequest.completion.rows.some((row)=>row.disposition==="EXCLUDE"&&row.dispositionReason),"human exclusion is bound before final confirmation");
  await evaluate("document.querySelector('.trade-review-storage-actions button').click()");
  await waitFor(async()=>evaluate("window.__act1.observationBodies.length===2 && document.querySelector('[data-action=apply-reviewed-new]')"),"saved Observation3 and DTO refresh");
  assert.equal(await evaluate("window.__act1.observationBodies[0]===window.__act1.observationBodies[1]"),true,"retry reuses exact immutable Observation3 body");
  assert.equal(await evaluate("Boolean(document.querySelector('[data-action=apply-reviewed-new]'))"),true,"v3 DTO control is present after save");
  const receipt=await evaluate("JSON.stringify(window.__act1.receipt)").then(JSON.parse);
  const stored=await(await fetch(`${baseUrl}api/recognition/trade-review-observations/${receipt.observationId}`)).json();
  assert.equal(stored.ok,true);
  const expectedReview={schemaVersion:3,recognitionBatchId:parsedRequest.projection.recognitionBatchId,
    projectionHash:parsedRequest.projection.projectionHash,reviewRevision:parsedRequest.completion.reviewRevision,
    masterBinding:parsedRequest.projection.masterBinding,correctionVersion:parsedRequest.projection.correctionVersion,
    completionValuesHash:parsedRequest.completion.batchConfirmation.completionValuesHash,pixelAvailability:parsedRequest.projection.pixelAvailability};
  const heldDto=validateReviewedTradeBatch({storedObservation:stored.observation,evidenceReceipt:receipt,expectedReview,
    mappingPolicyVersion:"reviewed-trade-dto-mapping-v3"});
  assert.equal(heldDto.mappingPolicyVersion,"reviewed-trade-dto-mapping-v3");
  const persisted=await evaluate("window.__act1.observationBodies.length");assert.equal(persisted,2);
  const cropCount=await evaluate("window.__act1.cropMetadata.length");assert.ok(cropCount>0,"selected source crops upload with v3 metadata");
  const cropMeta=await evaluate("JSON.stringify(window.__act1.cropMetadata)").then(JSON.parse);
  assert.ok(cropMeta.every((item)=>item.schemaVersion===3&&item.cropRefId&&item.pixelSha256&&item.sha256));
  assert.equal(await evaluate("window.__act1.truth"),0);
  try { await waitFor(async()=>evaluate("document.querySelector('[data-action=apply-reviewed-new]')?.disabled===false"),"DTO ready after completion-bound explicit exclusion"); }
  catch(error) { throw new Error(`${error.message}; session=${await evaluate("document.querySelector('[data-role=session-apply-status]')?.textContent")}; held=${await evaluate("JSON.stringify([...document.querySelectorAll('.trade-review-held-exclusion')].map(x=>x.innerText))")}; disabled=${await evaluate("document.querySelector('[data-action=apply-reviewed-new]')?.disabled")}`); }
  await evaluate("document.querySelector('[data-action=apply-reviewed-new]').click()");
  await waitFor(async()=>evaluate("document.querySelector('[data-action=commit-session-stage]')?.hidden===false"),"NEW stage ready");
  await evaluate("document.querySelector('[data-action=commit-session-stage]').click()");
  try { await waitFor(async()=>evaluate("document.querySelector('[data-role=session-apply-status]')?.textContent.includes('APPLIED')"),"NEW DB-first commit and readback",15000); }
  catch(error) { throw new Error(`${error.message}; session=${await evaluate("document.querySelector('[data-role=session-apply-status]')?.textContent")}; job=${await evaluate("JSON.stringify(document.querySelector('.trade-review-session-apply')?.innerText)")}`); }
  const firstReceipt=await evaluate("JSON.stringify(window.__act1.receipt)").then(JSON.parse);
  const firstBootstrap=await(await fetch(`${baseUrl}api/bootstrap`)).json();
  assert.equal(firstBootstrap.workingSession?.diagnostics?.mode,"NEW");
  assert.equal(firstBootstrap.workingSession?.scannedTrades?.length,3,"the held/unknown row is explicitly excluded from the committed NEW session");
  await evaluate("window.__act1.reloadMarker='NEW'");
  try { await send("Page.reload",{ignoreCache:true}); } catch(error) { if(!error.message.includes("Inspected target navigated or closed")) throw error; }
  await waitFor(async()=>evaluate("typeof window.__act1==='undefined' && document.querySelector('#app-content')?.getAttribute('aria-busy')==='false'"),"NEW session durable reload");
  const reloadedNew=await(await fetch(`${baseUrl}api/bootstrap`)).json();
  assert.equal(reloadedNew.workingSession.id,firstBootstrap.workingSession.id);
  assert.deepEqual(reloadedNew.workingSession.scannedTrades,firstBootstrap.workingSession.scannedTrades);
  const beforeAppendOpen=await evaluate("JSON.stringify({button:!!document.querySelector('#open-trade-capture'),disabled:document.querySelector('#open-trade-capture')?.disabled,tradeDialog:document.querySelector('#trade-capture-dialog')?.open,reviewDialog:document.querySelector('#trade-recognition-review-dialog')?.open,dialogs:[...document.querySelectorAll('dialog')].map(d=>[d.id,d.open])})");
  await evaluate(`(()=>{window.__act1={blockMaster:false,failObservation:false,masterGets:0,v1:0,v2:0,observationBodies:[],cropMetadata:[],truth:0,receipt:null};const original=window.fetch.bind(window);window.fetch=async(input,init={})=>{const url=String(input);if(url.endsWith('/api/master/active'))window.__act1.masterGets++;if(url.endsWith('/api/recognition/trade-batch')){const batch=JSON.parse(init.body.get('batch'));if(batch.version===1)window.__act1.v1++;if(batch.version===2)window.__act1.v2++}if(url.endsWith('/api/recognition/trade-review-observations')&&init.method==='POST')window.__act1.observationBodies.push(init.body);if(url.includes('/crops')&&init.method==='POST')window.__act1.cropMetadata.push(JSON.parse(init.body.get('metadata')));if(url.includes('/truth-labels'))window.__act1.truth++;const response=await original(input,init);if(url.endsWith('/api/recognition/trade-review-observations')&&init.method==='POST'&&response.ok){const body=await response.clone().json();window.__act1.receipt=body.receipt}return response}})()`);
  await fetch(`${baseUrl}__test__/mode/append`,{method:"POST"});
  await evaluate("document.querySelector('#open-trade-capture').click()");
  try { await waitFor(async()=>evaluate("document.querySelector('#trade-capture-dialog')?.open"),"APPEND capture dialog after reload"); }
  catch(error) { throw new Error(`${error.message}; before=${beforeAppendOpen}; after=${await evaluate("JSON.stringify({button:!!document.querySelector('#open-trade-capture'),disabled:document.querySelector('#open-trade-capture')?.disabled,tradeDialog:document.querySelector('#trade-capture-dialog')?.open,reviewDialog:document.querySelector('#trade-recognition-review-dialog')?.open,dialogs:[...document.querySelectorAll('dialog')].map(d=>[d.id,d.open]),session:document.querySelector('[data-role=session-apply-status]')?.textContent})")}`); }
  await waitFor(async()=>evaluate("!document.querySelector('[data-role=trade-runtime-status]').textContent.includes('확인 중')"),"APPEND runtime status after reload");
  const appendRuntime=await evaluate("JSON.stringify({status:document.querySelector('[data-role=trade-runtime-status]').textContent,buttonDisabled:document.querySelector('[data-action=recognize-trade]').disabled,queue:document.querySelector('#trade-capture-dialog').dataset.queueLength})");
  assert.equal(await evaluate("document.querySelector('[data-role=trade-runtime-status]').textContent==='로컬 인식 사용 가능'"),true,appendRuntime);
  await addCaptures(120);
  await evaluate("document.querySelector('[data-action=recognize-trade]').click()");
  await waitFor(async()=>evaluate("document.querySelector('.trade-final-review-shell') && document.querySelector('#trade-recognition-review-dialog')?.open"),"second final review for APPEND");
  const rows2=await evaluate("JSON.stringify([...document.querySelectorAll('.trade-final-review-list-item')].map(x=>({id:x.dataset.itemId,text:x.innerText})))").then(JSON.parse);
  assert.equal(rows2.length,3,"duplicate-image ordinal mapping produces three logical rows for APPEND");
  await evaluate("document.querySelector('[data-action=confirm]').click()");
  try { await waitFor(async()=>evaluate("window.__act1.observationBodies.length===1 && document.querySelector('[data-action=apply-reviewed-append]')?.disabled===false"),"second v3 observation DTO for APPEND",45000); }
  catch(error) { throw new Error(`${error.message}; review=${await evaluate("JSON.stringify({saveStatus:document.querySelector('[data-role=trade-review-storage-status]')?.textContent,storage:document.querySelector('.trade-review-storage')?.innerText,apply:document.querySelector('[data-role=session-apply-status]')?.textContent,rows:[...document.querySelectorAll('.trade-final-review-list-item')].map(x=>x.innerText),buttons:[...document.querySelectorAll('[data-action^=apply-reviewed]')].map(b=>[b.dataset.action,b.disabled])})")}; posts=${await evaluate("window.__act1.observationBodies.length")}`); }
  await evaluate("document.querySelector('[data-action=apply-reviewed-append]').click()");
  try { await waitFor(async()=>evaluate("document.querySelector('[data-action=commit-session-stage]')?.hidden===false"),"APPEND stage ready"); }
  catch(error) { throw new Error(`${error.message}; status=${await evaluate("JSON.stringify({apply:document.querySelector('[data-role=session-apply-status]')?.textContent,buttons:[...document.querySelectorAll('[data-action^=apply-reviewed]')].map(b=>[b.dataset.action,b.disabled,b.hidden]),stage:document.querySelector('[data-action=commit-session-stage]')?.hidden,job:document.querySelector('.trade-review-session-apply')?.innerText,review:document.querySelector('#trade-final-review-dialog')?.open})")}`); }
  await evaluate("document.querySelector('[data-action=commit-session-stage]').click()");
  await waitFor(async()=>evaluate("document.querySelector('[data-role=session-apply-status]')?.textContent.includes('APPLIED')"),"APPEND DB-first commit and readback",45000);
  const secondReceipt=await evaluate("JSON.stringify(window.__act1.receipt)").then(JSON.parse);
  const appendedBootstrap=await(await fetch(`${baseUrl}api/bootstrap`)).json();
  assert.equal(appendedBootstrap.workingSession?.diagnostics?.mode,"APPEND");
  assert.equal(appendedBootstrap.workingSession?.scannedTrades?.length,4);
  assert.ok((await(await fetch(`${baseUrl}api/recognition/trade-review-observations/${firstReceipt.observationId}`)).json()).ok);
  assert.ok((await(await fetch(`${baseUrl}api/recognition/trade-review-observations/${secondReceipt.observationId}`)).json()).ok);
  runtimeState=await(await fetch(`${baseUrl}__test__/state`)).json();assert.equal(runtimeState.v1,0);assert.equal(runtimeState.v2,3);
  assert.equal(await evaluate("window.__act1.v1"),0);assert.equal(await evaluate("window.__act1.truth"),0);
  assert.equal(await evaluate("window.__act1.masterGets"),1,"no active Master re-fetch after the single pin for APPEND");
  assert.equal(await evaluate("window.__act1.cropMetadata.every(item=>item.schemaVersion===3&&item.cropRefId&&item.pixelSha256&&item.sha256)"),true);
  const reloadedAppend=await(await fetch(`${baseUrl}api/bootstrap`)).json();
  assert.equal(reloadedAppend.workingSession.id,appendedBootstrap.workingSession.id);
  assert.deepEqual(reloadedAppend.workingSession.scannedTrades,appendedBootstrap.workingSession.scannedTrades);
  console.log("browser_trade_final_flow: PASS · primary v2-only, fail-closed, pinned Bundle2, source 6→logical 4, conflict review, Observation3/crop/DTO, NEW+APPEND DB-first paths, no truth writes");
} finally {
  try { socket?.close(); } catch {}
  await stopChild(chrome); await stopChild(server);
}
