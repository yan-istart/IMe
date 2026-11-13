import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/core/runtime.js';
import { HostModelGateway, normalizeUsage, type ModelBudgetConfig, type HostChunk } from '../src/adapters/model-gateway.js';
const config: ModelBudgetConfig={sessionLimit:'200',routes:[{provider:'mock',model:'text',inputUpperBound:100,maxOutput:50,
  price:{version:'test-only',currency:'USD',inputPerMillion:'1000000',cachedPerMillion:'100000',outputPerMillion:'2000000'}}]};
const request={provider:'mock',model:'text',sessionId:'test-session',maxTokens:50};
const usage={inputTokens:60,cacheReadTokens:20,outputTokens:10};
async function* success(): AsyncGenerator<HostChunk> {yield {type:'usage',usage};yield {type:'finish',reason:{kind:'stop'}};}
async function consume(stream:AsyncIterable<HostChunk>) {const result=[];for await(const c of stream) result.push(c);return result;}
function setup(t:TestContext,policy?:ModelBudgetConfig) {
  const dir=mkdtempSync(join(tmpdir(),'ime-gateway-'));const r=new Runtime({dataDir:dir});const gateway=new HostModelGateway(r,policy);
  t.after(async()=>{await gateway.close();await r.close();rmSync(dir,{recursive:true,force:true});});return {r,gateway,dir};
}
test('DSH disjoint cache counters normalize without double charging',()=>{
  assert.deepEqual(normalizeUsage(usage),{inputTokens:80,cachedInputTokens:20,outputTokens:10});
  assert.deepEqual(normalizeUsage({...usage,cacheWriteTokens:5}),{inputTokens:85,cachedInputTokens:20,outputTokens:10});
  assert.throws(()=>normalizeUsage({inputTokens:-1,outputTokens:0}),/INVALID_HOST_USAGE/);
});
test('observe captures cumulative usage without fabricating a price or storing prompts',async t=>{
  const {r,gateway,dir}=setup(t);
  await consume(gateway.intercept({...request,system:'SECRET'} as typeof request,()=>success()));
  const rows=gateway.status().requests;
  assert.equal(rows.length,1);assert.equal(rows[0]?.certainty,'unpriced');
  assert.deepEqual(JSON.parse(String(rows[0]?.usage)),{inputTokens:80,cachedInputTokens:20,outputTokens:10});
  assert.equal(r.store.db.prepare('SELECT COUNT(*) AS n FROM usage_entries').get()?.n,0);
  r.store.exportAudit();assert.ok(!readFileSync(join(dir,'audit.jsonl'),'utf8').includes('SECRET'));
});
test('guard reserves before next and reconciles actual usage; each invocation charges separately',async t=>{
  const {r,gateway}=setup(t,config);let calls=0;
  const next=()=>{calls++;assert.equal(r.store.db.prepare('SELECT reserved FROM budgets').get()?.reserved,200);return success();};
  await consume(gateway.intercept(request,next));
  assert.equal(r.store.db.prepare('SELECT spent,reserved FROM budgets').get()?.spent,82);
  await assert.rejects(consume(gateway.intercept(request,next)),/BUDGET_DENIED/);
  assert.equal(calls,1);assert.equal(r.store.db.prepare('SELECT status FROM tasks').get()?.status,'paused');
});
test('concurrent streams cannot double spend',async t=>{
  const {gateway}=setup(t,config);let calls=0;
  async function* slow(){calls++;await new Promise(resolve=>setTimeout(resolve,10));yield* success();}
  const results=await Promise.allSettled([consume(gateway.intercept(request,()=>slow())),consume(gateway.intercept(request,()=>slow()))]);
  assert.equal(calls,1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
test('expired tariff blocks dispatch without reserving or spending',async t=>{
  const {gateway,r}=setup(t,{...config,routes:config.routes.map(route=>({...route,validUntil:'2020-01-01T00:00:00Z'}))});let calls=0;
  await assert.rejects(consume(gateway.intercept(request,()=>{calls++;return success();})),/IME_PRICE_EXPIRED/);
  assert.equal(calls,0);assert.equal(r.store.db.prepare('SELECT COUNT(*) AS n FROM reservations').get()?.n,0);
  assert.throws(()=>new HostModelGateway(r,{...config,routes:config.routes.map(route=>({...route,validUntil:'invalid'}))}),/INVALID_PRICE_EXPIRY/);
});
test('unknown route and absent/excess output bounds deny without dispatch',async t=>{
  const {gateway}=setup(t,config);let calls=0;const next=()=>{calls++;return success();};
  await assert.rejects(consume(gateway.intercept({...request,provider:'other'},next)),/IME_UNPRICED_ROUTE/);
  await assert.rejects(consume(gateway.intercept({...request,maxTokens:51},next)),/IME_OUTPUT_BOUND_REQUIRED/);
  const {maxTokens,...missing}=request;
  await assert.rejects(consume(gateway.intercept(missing,next)),/IME_OUTPUT_BOUND_REQUIRED/);assert.equal(calls,0);
});
test('failure finish with partial usage remains unknown and consumes full reservation',async t=>{
  const {r,gateway}=setup(t,config);
  async function* failure(){yield {type:'usage',usage};yield {type:'finish',reason:{kind:'error'}};}
  await consume(gateway.intercept(request,()=>failure()));
  assert.equal(gateway.status().requests[0]?.state,'failed');
  assert.equal(r.store.db.prepare('SELECT certainty,amount FROM usage_entries').get()?.certainty,'unknown');
  assert.equal(r.store.db.prepare('SELECT spent FROM budgets').get()?.spent,200);
});
test('iterator throw and consumer abandonment close streams and retain conservative bill',async t=>{
  const {r,gateway}=setup(t,{...config,sessionLimit:'1000'});let closed=false;
  async function* source(){try{yield {type:'text-delta',text:'private'};throw Error('network');}finally{closed=true;}}
  const stream=gateway.intercept(request,()=>source());await stream.next();await stream.return(undefined);
  assert.equal(closed,true);assert.equal(gateway.status().requests[0]?.state,'interrupted');
  await assert.rejects(consume(gateway.intercept(request,()=>source())),/network/);
  assert.equal(r.store.db.prepare('SELECT spent FROM budgets').get()?.spent,400);
});
test('gateway shutdown closes suspended generators before database closure',async t=>{
  const {gateway}=setup(t,config);const stream=gateway.intercept(request,()=>success());await stream.next();
  await gateway.close();assert.equal(gateway.status().requests[0]?.certainty,'unknown');
  await assert.rejects(consume(gateway.intercept(request,()=>success())),/IME_GATEWAY_STOPPED/);
});
test('cache writes with no separate verified price retain unknown charge',async t=>{
  const {gateway,r}=setup(t,config);
  async function* source(){yield {type:'usage',usage:{...usage,cacheWriteTokens:3}};yield {type:'finish',reason:{kind:'stop'}};}
  await consume(gateway.intercept(request,()=>source()));
  assert.equal(r.store.db.prepare('SELECT certainty FROM usage_entries').get()?.certainty,'unknown');
});
test('configuration rejects mixed currencies and duplicate routes',t=>{
  const {r}=setup(t);
  assert.throws(()=>new HostModelGateway(r,{...config,routes:[config.routes[0]!,config.routes[0]!]}),/DUPLICATE_MODEL_ROUTE/);
  assert.throws(()=>new HostModelGateway(r,{...config,routes:[config.routes[0]!,{...config.routes[0]!,model:'other',price:{...config.routes[0]!.price,currency:'CNY'}}]}),/MIXED_BUDGET_CURRENCIES/);
});
test('reported token bound violation pauses task even when final cost fits reservation',async t=>{
  const {gateway,r}=setup(t,config);
  async function* source(){yield {type:'usage',usage:{inputTokens:101,outputTokens:0}};yield {type:'finish',reason:{kind:'stop'}};}
  await consume(gateway.intercept(request,()=>source()));
  assert.equal(r.store.db.prepare('SELECT spent FROM budgets').get()?.spent,101);
  assert.equal(r.store.db.prepare('SELECT status FROM tasks').get()?.status,'paused');
});
