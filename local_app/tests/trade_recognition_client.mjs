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

let finishRecognition, requestBatch, pollCalls = 0;
let progressReceived;
const progressReady = new Promise((resolve) => { progressReceived = resolve; });
globalThis.fetch = async (url, options) => {
  if (url.startsWith('/api/recognition/trade-progress/')) {
    pollCalls++;
    assert.equal(options.cache, 'no-store');
    return Response.json({ok:true,progress:{stage:'recognizing',totalCaptures:1,
      completedCaptures:0,currentRowsCompleted:2,currentRowsTotal:6}});
  }
  requestBatch = JSON.parse(options.body.get('batch'));
  return new Promise((resolve) => { finishRecognition = resolve; });
};
const pendingResult = recognizeTradeLiveList([first], { onProgress: progressReceived });
const deadline = setTimeout(() => progressReceived(null), 3000);
const progress = await progressReady;
clearTimeout(deadline);
assert.equal(progress?.currentRowsCompleted, 2);
finishRecognition(Response.json({ok:true,result:{version:3,batchId:requestBatch.batchId,
  captures:requestBatch.captures,rows:[]}}));
await pendingResult;
const callsAtCompletion = pollCalls;
await new Promise((resolve) => setTimeout(resolve, 650));
assert.equal(pollCalls, callsAtCompletion);

globalThis.fetch = async (url, options) => {
  if (url.startsWith('/api/recognition/trade-progress/')) throw new Error('progress offline');
  const batch = JSON.parse(options.body.get('batch'));
  await new Promise((resolve) => setTimeout(resolve, 650));
  return Response.json({ok:true,result:{version:3,batchId:batch.batchId,captures:batch.captures,rows:[]}});
};
assert.equal((await recognizeTradeLiveList([first], {onProgress:()=>{throw new Error('display failure');}})).version, 3);
console.log(JSON.stringify({ok:true,liveOnly:true,affectedCaptureOnly:true,errorPropagation:true}));
