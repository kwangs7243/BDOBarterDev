import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function environment({failStart=false,rejectClose=false}={}) {
  const contexts=[],timers=new Map();let nextTimer=0;
  class AudioContext {
    constructor(){this.currentTime=0;this.state='running';this.nodes=[];this.closed=0;contexts.push(this);}
    createOscillator(){const node={disconnected:false,frequency:{setValueAtTime(){}},connect(){},
      start(){if(failStart)throw Error('start failed');},stop(){},disconnect(){this.disconnected=true;}};this.nodes.push(node);return node;}
    createGain(){const node={disconnected:false,gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},
      connect(){},disconnect(){this.disconnected=true;}};this.nodes.push(node);return node;}
    close(){this.closed++;this.state='closed';return rejectClose?Promise.reject(Error('close failed')):Promise.resolve();}
  }
  const ctx={AudioContext,console:{warn(){}},setTimeout:callback=>{const id=++nextTimer;timers.set(id,callback);return id;},clearTimeout:id=>timers.delete(id)};
  ctx.window=ctx;vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../frontend/js/domain/completion.js',import.meta.url),'utf8'),ctx);
  return {ctx,contexts,timers};
}
{
  const {ctx,contexts,timers}=environment();
  for(let i=0;i<50;i++)ctx.playAlarmSound();
  for(const audio of contexts){
    const oscillators=audio.nodes.filter(node=>node.frequency);
    oscillators[0].onended?.();assert.equal(audio.closed,0,'first tone must not silence the second');
    oscillators[1].onended?.();assert.equal(audio.closed,1,'finished alarms must release their contexts');
    assert.ok(audio.nodes.every(node=>node.disconnected));
    oscillators[1].onended?.();assert.equal(audio.closed,1,'cleanup must be idempotent');
  }
  assert.equal(timers.size,0);
}
{
  const {ctx,contexts,timers}=environment();ctx.playAlarmSound();
  for(const callback of [...timers.values()])callback();
  assert.equal(contexts[0].closed,1,'suspended/blocked audio must also release its context');
  assert.equal(timers.size,0);
}
{
  const {ctx,contexts,timers}=environment({failStart:true});ctx.playAlarmSound();
  assert.equal(contexts[0].closed,1);assert.equal(timers.size,0);
  assert.ok(contexts[0].nodes.every(node=>node.disconnected));
}
{
  const {ctx,contexts,timers}=environment({rejectClose:true});ctx.playAlarmSound();
  for(const callback of [...timers.values()])callback();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(contexts[0].closed,1);assert.equal(timers.size,0);
}
console.log('PASS: 50 repeated alarms release audio nodes, contexts and timers; blocked playback, exceptions and rejected close are handled');
