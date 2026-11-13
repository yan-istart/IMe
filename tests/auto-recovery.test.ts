import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/core/runtime.js';
import { HostRecovery, type RecoveryConfig } from '../src/adapters/recovery.js';
import type { HostContext } from '../src/adapters/dsh.js';
import { validateConfig } from '../src/core/config.js';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function setup(t: TestContext, config: RecoveryConfig = {}) {
  const dir=mkdtempSync(join(tmpdir(),'ime-auto-recovery-'));
  const runtime=new Runtime({dataDir:dir,dashboard:{enabled:false}});
  const listeners=new Map<string,Set<(...args:unknown[])=>unknown>>();
  const emit=(name:string,...args:unknown[])=>{for(const fn of listeners.get(name) ?? [])fn(...args);};
  const session={id:'s'};const messages:unknown[]=[];
  let idle=Promise.resolve();let current=true;
  const entries:{options:{name:string;disabled?:boolean}}[]=[];
  const agent={session,inbox:{nextTurn:[] as unknown[],nextStep:[] as unknown[]},whenIdle:()=>idle,followup:(m:unknown)=>{messages.push(m);}};
  const ctx={get:(name:string)=>name==='agents'?{get:()=>current?agent:undefined}:name==='loader'?{entries:()=>entries}:undefined,
    on:(name:string,fn:(...args:unknown[])=>unknown)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name)!.add(fn);return ()=>{listeners.get(name)!.delete(fn);};}} as HostContext;
  let recovery=new HostRecovery(ctx,runtime,{minIntervalMs:0,...config});
  t.after(async()=>{recovery.close();await runtime.close();rmSync(dir,{recursive:true,force:true});});
  const end=(turn:number,kind='max-tokens')=>emit('session/event',session,{type:'turn/end',data:{turn,reason:{kind}}});
  return {runtime,session,agent,messages,entries,end,emit,recovery,unregister:()=>{current=false;},wait:()=>{let resolve!:()=>void;idle=new Promise<void>(r=>{resolve=r;});return resolve;},
    reload:()=>{recovery.close();recovery=new HostRecovery(ctx,runtime,{minIntervalMs:0,...config});return recovery;}};
}
test('only max-tokens queues a host-authored followup, once per turn, after idle',async t=>{
  const f=setup(t);const done=f.wait();f.end(0);f.end(0);
  assert.equal(f.messages.length,0);done();await tick();assert.equal(f.messages.length,1);
  assert.equal((f.messages[0] as {source:{kind:string}}).source.kind,'cordis-host-runner');
  for(const [i,reason] of ['completed','error','aborted','blocked'].entries())f.end(i+1,reason);
  await tick();assert.equal(f.messages.length,1);
});
test('burst cap and duplicate suppression survive adapter reload; normal stop resets chain',async t=>{
  const f=setup(t,{maxConsecutive:2});f.end(0);await tick();f.reload();f.end(0);f.end(1);await tick();f.end(2);await tick();
  assert.equal(f.messages.length,2);f.end(3,'completed');f.end(4);await tick();assert.equal(f.messages.length,3);
});
test('cooldown, disabled option and another continuation plugin suppress sends',async t=>{
  const f=setup(t,{minIntervalMs:600000});f.end(0);await tick();f.end(1);await tick();assert.equal(f.messages.length,1);
  const off=setup(t,{enabled:false});off.end(0);await tick();assert.equal(off.messages.length,0);
  const other=setup(t);other.entries.push({options:{name:'dsh-continue-on-limit'}});other.end(0);await tick();assert.equal(other.messages.length,0);
});
test('input, stop, agent replacement, disposal and new turns invalidate an idle wait',async t=>{
  for(const change of ['input','stop','replacement','close','turn','disposed']){
    const f=setup(t);const done=f.wait();f.end(0);
    if(change==='input')f.emit('session/event',f.session,{type:'agent/inbox/spliced',data:{inserted:[{}]}});
    if(change==='stop')f.runtime.executionPaused=true;
    if(change==='replacement')f.unregister();
    if(change==='close')f.recovery.close();
    if(change==='turn')f.emit('session/event',f.session,{type:'turn/start',data:{turn:1}});
    if(change==='disposed')f.emit('session/disposed',f.session);
    done();await tick();assert.equal(f.messages.length,0,change);
  }
});
test('queued input, paused task, unresolved side effect and spent budget block recovery',async t=>{
  for(const condition of ['input','paused','uncertain','budget']){
    const f=setup(t);
    if(condition==='input')f.agent.inbox.nextTurn.push({});
    else {
      const task=f.runtime.tasks.create('s','goal','app','10');f.runtime.tasks.transition(task.id,'ready');f.runtime.tasks.transition(task.id,'running');
      if(condition==='paused')f.runtime.pause(task.id);
      if(condition==='uncertain')f.runtime.store.db.prepare('INSERT INTO actions VALUES(?,?,?,?)').run('action',task.id,'uncertain','{}');
      if(condition==='budget')f.runtime.store.db.prepare('UPDATE budgets SET spent=10 WHERE task_id=?').run(task.id);
    }
    f.end(0);await tick();assert.equal(f.messages.length,0,condition);
  }
});
test('rechecks task state after idle and never leaks followup errors into session event dispatch',async t=>{
  const f=setup(t);const done=f.wait();f.end(0);f.runtime.executionPaused=true;done();await tick();assert.equal(f.messages.length,0);
  const fail=setup(t);fail.agent.followup=()=>{throw Error('private');};assert.doesNotThrow(()=>fail.end(0));await tick();
  assert.ok(fail.runtime.store.db.prepare("SELECT id FROM audit_events WHERE type='ime.recovery.failed'").get());
});
test('recovery options enforce a finite cap and known fields',()=>{
  for(const recovery of [{maxConsecutive:0},{maxConsecutive:17},{minIntervalMs:-1},{enabled:'yes'},{unknown:true}])assert.throws(()=>validateConfig({recovery}));
  assert.deepEqual(validateConfig({recovery:{enabled:false,maxConsecutive:2}}).recovery,{enabled:false,maxConsecutive:2});
});
