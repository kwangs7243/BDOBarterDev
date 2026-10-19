import assert from 'node:assert/strict';

globalThis.window = {addEventListener(){}};
const {state,applyBootstrap} = await import('../frontend/js/state.js');
const {saveCompletionInventory,whenPersistenceIdle} = await import('../frontend/js/persistence.js');
const session = {id:'same-session'};
const snapshot = (revision,source,target=0,sessionRevision=1) => ({revision,sessionRevision,
  workingSession:session,inventory:[{programName:'source',stock:source},{programName:'target',stock:target}],settings:{},order:{}});

function setup() {
  applyBootstrap(snapshot(1,100));
  const request = {mutationId:crypto.randomUUID(),baseRevision:1,kind:'completion',
    patch:{items:{source:{stock:97},target:{stock:9}}},session};
  Object.defineProperty(request,'beforeInventory',{value:{source:100,target:0}});
  return request;
}
const response = (status,body) => ({ok:status===200,status,json:async()=>body});
const conflict = () => response(409,{error:{message:'revision conflict'}});
let bootstrap,requests;
function mock(send) {
  requests=[];
  globalThis.fetch=async(path,options={})=> {
    if (path==='/api/bootstrap') return response(200,bootstrap);
    assert.equal(path,'/api/working-session/completion');
    const body=JSON.parse(options.body);requests.push(body);
    return send(body,requests.length);
  };
}
{
  const request=setup();bootstrap=snapshot(2,200,10);
  mock((body,index)=>{
    if(index===1)return conflict();
    bootstrap=snapshot(3,body.patch.items.source.stock,body.patch.items.target.stock,3);
    return response(200,{revision:3});
  });
  await saveCompletionInventory(request);
  assert.deepEqual(requests[1].patch.items,{source:{stock:197},target:{stock:19}});
  assert.ok(!Object.hasOwn(requests[1],'inventoryDeltas'));
}
{
  const request=setup();bootstrap=snapshot(2,200,10);
  mock(()=>conflict());
  await assert.rejects(saveCompletionInventory(request),/revision conflict/);
  bootstrap=snapshot(3,300,20);
  await assert.rejects(saveCompletionInventory(request),/revision conflict/);
  assert.deepEqual(requests.at(-1).patch.items,{source:{stock:297},target:{stock:29}},'retry must preserve original -3/+9 deltas');
  bootstrap=snapshot(4,400,30);
  mock((body,index)=>{
    if(index===1)return conflict();
    bootstrap=snapshot(5,body.patch.items.source.stock,body.patch.items.target.stock,5);
    return response(200,{revision:5});
  });
  await saveCompletionInventory(request);
  assert.deepEqual(requests.at(-1).patch.items,{source:{stock:397},target:{stock:39}});
}
{
  const request=setup();bootstrap=snapshot(2,2,10);
  mock((body,index)=>index===1?conflict():response(200,{revision:3}));
  await assert.rejects(saveCompletionInventory(request),/재고.*부족/);
  assert.equal(requests.length,1,'shortage must not submit a clamped stock update');
  assert.equal(JSON.stringify(request),JSON.stringify(requests[0]),'failed rebase must retain the submitted request for recovery');
  bootstrap=snapshot(3,10,10);
  mock((body,index)=>{
    if(index===1)return conflict();
    bootstrap=snapshot(4,body.patch.items.source.stock,body.patch.items.target.stock,4);
    return response(200,{revision:4});
  });
  await saveCompletionInventory(request);
  assert.deepEqual(requests.at(-1).patch.items,{source:{stock:7},target:{stock:19}});
}
{
  const request=setup();bootstrap=snapshot(2,null,10);
  mock(()=>conflict());
  await assert.rejects(saveCompletionInventory(request),/미확인/);
  assert.equal(requests.length,1);
}
{
  const request=setup();bootstrap={...snapshot(2,200),workingSession:{id:'different-session'}};
  mock(()=>conflict());
  await assert.rejects(saveCompletionInventory(request),/다른 작업/);
  assert.equal(requests.length,1);
}
await whenPersistenceIdle();
assert.equal(state.persistencePending,0);
console.log('PASS: original completion deltas survive repeated conflicts; insufficient/unknown stock and changed sessions block writes; retry recovers without extra consumption');
