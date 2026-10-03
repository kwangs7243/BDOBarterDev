import assert from "node:assert/strict";
import { getTradeRecognitionRuntime, recognizeTradeLiveList, saveTradeCorrections, TradeRecognitionError } from "../frontend/js/trade-recognition-client.js";

const capture = (captureId) => ({ blob: new Blob(["png"], {type:"image/png"}), metadata:{captureId,taskType:"trade"} });
const first=capture(crypto.randomUUID()), second=capture(crypto.randomUUID());
let seen;
globalThis.fetch=async(url,options)=>{
  seen={url,options};
  const batch=JSON.parse(options.body.get("batch"));
  return Response.json({ok:true,result:{version:3,batchId:batch.batchId,
    captures:batch.captures,rows:batch.captures.map((c)=>({captureId:c.captureId,fields:
      Object.fromEntries(["island","fromItem","toItem","reqAmount","count","yield"].map(key=>[key,{rawOCR:"raw",reviewRequired:false}]))}))}});
};
const result=await recognizeTradeLiveList([first,second]);
assert.equal(seen.url,"/api/recognition/trade-live-list");
assert.equal(seen.options.credentials,"same-origin");
assert.equal(seen.options.body.getAll("image").length,2);
assert.deepEqual(result.captures.map(c=>c.captureId),[first.metadata.captureId,second.metadata.captureId]);
await assert.rejects(()=>recognizeTradeLiveList([]),TradeRecognitionError);
await assert.rejects(()=>recognizeTradeLiveList([{...first,blob:new Blob(["jpg"],{type:"image/jpeg"})}]),TradeRecognitionError);
globalThis.fetch=async()=>Response.json({ok:false,error:{code:"engine_busy"}},{status:409});
await assert.rejects(()=>recognizeTradeLiveList([first]),error=>error.code==="engine_busy");
globalThis.fetch=async()=>Response.json({ok:true,runtime:{available:true}});
assert.equal((await getTradeRecognitionRuntime()).available,true);
globalThis.fetch=async(url,options)=>{seen={url,options};return Response.json({ok:true,created:true});};
await saveTradeCorrections([first,second],{runtime:{engineId:"engine",workerVersion:"worker",modelBundleSha256:"model"}},
  [{captureId:second.metadata.captureId,field:"island",finalValue:"섬"}],crypto.randomUUID());
assert.equal(seen.url,"/api/recognition/trade-corrections");
assert.equal(seen.options.body.getAll("image").length,1);
assert.equal(JSON.parse(seen.options.body.get("feedback")).captures[0].captureId,second.metadata.captureId);
console.log(JSON.stringify({ok:true,liveOnly:true,affectedCaptureOnly:true,errorPropagation:true}));
