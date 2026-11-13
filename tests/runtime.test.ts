import { test,type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Runtime } from '../src/core/runtime.js';
import { MockDesktop } from '../src/adapters/mock.js';
import { VisionFilter } from '../src/core/vision.js';
import { mount, type HostContext, type ToolDefinition } from '../src/adapters/dsh.js';
import { cost } from '../src/core/cost.js';
const price = { version:'v1',currency:'USD',inputPerMillion:'1000000',cachedPerMillion:'100000',outputPerMillion:'2000000' };
const request = { inputUpperBound:100,maxOutput:50,toolAllowance:'0' };
function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(),'ime-test-'));
  const provider = new MockDesktop();
  const r = new Runtime({ dataDir:dir,allowApps:['mock-app'],desktopLeasePath:join(dir,'desktop.lock') },provider);
  t.after(async () => { await r.close(); rmSync(dir,{ recursive:true,force:true }); });
  return { r,dir,provider };
}
function running(r: Runtime,limit='1000') {
  const task = r.tasks.create('s','打开任务面板','mock-app',limit);
  r.tasks.transition(task.id,'ready'); r.tasks.transition(task.id,'running'); return task;
}
function action() { return { id:randomUUID(),app:'mock-app',kind:'click' as const,target:'task-panel',risk:'reversible_write' as const,expectedFingerprint:'mock-app:v1:zh:1280x720',timeoutMs:1000 }; }

test('T-01 observed action is verified, checkpointed, and becomes candidate only',async t => {
  const { r } = setup(t); const task=running(r);
  await r.desktop!.run(task.id,action(),o=>o.state==='task-panel');
  assert.equal(r.tasks.latest(task.id)?.cursor,1);
  assert.throws(()=>r.candidate(task.id),/SUCCESS_REQUIRED/);
  r.tasks.transition(task.id,'succeeded');
  const id=r.candidate(task.id);
  assert.equal(r.store.db.prepare('SELECT status FROM skills WHERE id=?').get(id)?.status,'candidate');
});
test('T-05 concurrent reservations cannot double spend; provider is never called on denial',async t=>{
  const { r }=setup(t); const task=running(r,'200'); let calls=0;
  const responses = await Promise.allSettled(Array.from({length:10},()=>r.costs.call(task.id,price,request,async()=>{ calls++; await new Promise(resolve=>setTimeout(resolve,10)); return {value:1}; })));
  assert.equal(calls,1); assert.equal(responses.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(r.store.db.prepare('SELECT spent,reserved FROM budgets').get()?.spent,200);
});
test('T-06 unknown failure and retry attempts remain fully charged; settlement idempotent',async t=>{
  const { r }=setup(t); const task=running(r);
  await assert.rejects(r.costs.call(task.id,price,request,async()=>{ throw Error('network'); }),/network/);
  await r.costs.call(task.id,price,request,async()=>({value:1,usage:{inputTokens:80,cachedInputTokens:20,outputTokens:10}}));
  const rows=r.store.db.prepare('SELECT * FROM usage_entries ORDER BY rowid').all();
  assert.deepEqual(rows.map(r=>r.certainty),['unknown','actual']);
  assert.equal(rows[1]?.amount,82);
  r.costs.settle(String(rows[1]!.reservation_id));
  assert.equal(r.store.db.prepare('SELECT spent FROM budgets').get()?.spent,282);
});
test('T-04 sessions share desktop queue without interleaved observations/actions',async t=>{
  const { r,provider }=setup(t); let active=0,max=0;
  provider.execute=async(_a,signal)=>{ active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,10));signal.throwIfAborted();active--;provider.state='task-panel'; };
  await Promise.all([running(r),running(r)].map(task=>r.desktop!.run(task.id,action(),()=>true)));
  assert.equal(max,1);
});
test('T-12 stop cancels in-flight work and blocks queued actions',async t=>{
  const { r,provider }=setup(t);const task=running(r);let entered!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve);
  provider.execute=async(_a,signal)=>{ entered(); await new Promise<void>((resolve,reject)=>{ signal.addEventListener('abort',()=>reject(signal.reason),{once:true}); }); };
  const first=r.desktop!.run(task.id,action(),()=>true);
  const second=r.desktop!.run(task.id,action(),()=>true);
  await started; r.cancel(task.id);
  await assert.rejects(first,/STOPPED/);await assert.rejects(second,/STOPPED/);
  assert.equal(r.tasks.get(task.id).status,'cancelled');
});
test('T-09 restart pauses interrupted tasks and requires environment verification',async t=>{
  const { r,dir }=setup(t);const task=running(r);await r.close();
  const reopened=new Runtime({dataDir:dir});
  try {
    assert.equal(reopened.tasks.get(task.id).status,'paused');
    await assert.rejects(reopened.tasks.resume(task.id,async()=>false),/ENVIRONMENT_MISMATCH/);
    await reopened.tasks.resume(task.id,async()=>true);
    assert.equal(reopened.tasks.get(task.id).status,'running');
  } finally { await reopened.close(); }
});
test('uncertain dispatched action cannot replay or auto resume',async t=>{
  const { r }=setup(t);const task=running(r);const a=action();
  await assert.rejects(r.desktop!.run(task.id,a,()=>false),/VERIFICATION_FAILED/);
  await assert.rejects(r.tasks.resume(task.id,async()=>true),/ACTION_RECONCILIATION_REQUIRED/);
});
test('permissions deny unlisted apps and require approval for irreversible actions',async t=>{
  const { r,provider }=setup(t);const task=running(r);
  await assert.rejects(r.desktop!.run(task.id,{...action(),app:'other'},()=>true),/APP_DENIED/);
  await assert.rejects(r.desktop!.run(task.id,{...action(),risk:'irreversible'},()=>true),/APPROVAL_REQUIRED/);
  assert.equal(provider.calls.length,0);assert.equal(r.tasks.get(task.id).status,'waiting_approval');
});
test('T-07 unchanged frames suppressed for 30 seconds; ROI excludes unrelated animation',()=>{
  const vision=new VisionFilter();
  const frame={app:'mock',width:2,height:2,pixels:new Uint8Array([0,0,0,0]),timestamp:0};
  assert.equal(vision.select(frame).selected,true);
  for(let i=1;i<=30;i++) assert.equal(vision.select({...frame,timestamp:i*1000}).selected,false);
  const roi={x:0,y:0,width:1,height:1};vision.select(frame,roi);
  assert.equal(vision.select({...frame,pixels:new Uint8Array([0,255,255,255])},roi).selected,false);
  assert.equal(vision.select(frame,roi,true).selected,true);
});
test('audit projection rebuilt deterministically after damaged export',async t=>{
  const {r,dir}=setup(t);running(r);await r.close();writeFileSync(join(dir,'audit.jsonl'),'incomplete');
  const reopened=new Runtime({dataDir:dir});
  try { const events=readFileSync(join(dir,'audit.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s));assert.ok(events.length>=3);assert.ok(events.every(e=>e.schemaVersion===1)); }
  finally {await reopened.close();}
});
test('second runtime cannot recover or control live runtime data',t=>{
  const {dir}=setup(t);assert.throws(()=>new Runtime({dataDir:dir}),/EEXIST/);
});
test('price snapshot immutable; cached inputs not double counted; currency mismatch rejected',t=>{
  const {r}=setup(t);const task=running(r);assert.equal(cost(price,{inputTokens:100,cachedInputTokens:100,outputTokens:0}),10);
  const p={...price};const q=r.costs.quote(p,request);p.inputPerMillion='99999999';assert.equal(q.price.inputPerMillion,'1000000');
  assert.throws(()=>r.costs.reserve(task.id,'req',{...q,price:{...q.price,currency:'CNY'}}),/BUDGET_DENIED/);
  assert.throws(()=>r.costs.quote(price,{...request,maxOutput:-1}),/INVALID_TOKEN_COUNT/);
});
test('host contract registers canonical output, records only metadata, unloads cleanly',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'ime-host-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const tools=new Map<string,ToolDefinition>(); const events=new Map<string, (...args:unknown[])=>unknown>();
  const effects: (()=>Promise<void>)[]=[];
  const ctx:HostContext={ effect:setup=>{effects.push(setup());}, get:()=>undefined, tools:{register(tool){assert.ok(tool.output.schema);tools.set(tool.name,tool);return()=>{tools.delete(tool.name);};}},on(event,fn){events.set(event,fn);return()=>{events.delete(event);};}};
  const mounted=mount(ctx,{dataDir:dir});
  assert.equal(mounted.capabilities.modelGateway,false);
  events.get('session/event')!({id:'s'},{type:'message',content:'SECRET'});
  const result=await tools.get('ime_status')!.execute({});assert.ok(result);
  assert.equal(effects.length,1);
  await effects[0]!();assert.equal(tools.size,0);assert.equal(events.size,0);
  await mounted.dispose();
  assert.ok(!readFileSync(join(dir,'audit.jsonl'),'utf8').includes('SECRET'));
});
test('shutdown waits for usage settlement and rejects subsequent model requests',async t=>{
  const {r}=setup(t);const task=running(r);let finish!:()=>void;
  const wait=new Promise<void>(resolve=>finish=resolve);
  const call=r.costs.call(task.id,price,request,async()=>{await wait;return {value:7};});
  const closing=r.close();
  await assert.rejects(r.costs.call(task.id,price,request,async()=>({value:0})),/GATEWAY_STOPPED/);
  finish();assert.equal(await call,7);await closing;
});
test('forged quote cannot underreserve the model maximum',t=>{
  const {r}=setup(t);const task=running(r);const quote=r.costs.quote(price,request);
  assert.throws(()=>r.costs.reserve(task.id,'forged',{...quote,amount:'0'}),/INVALID_QUOTE/);
});
