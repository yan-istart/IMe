import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer,type Server} from 'node:http';
import {deflateSync} from 'node:zlib';
import {Runtime,type RuntimeConfig} from '../src/core/runtime.js';
import {MockDesktop} from '../src/adapters/mock.js';
import {decodePng,grayscalePng} from '../src/core/png.js';
import {ToolDesktopPort,type DesktopToolConfig} from '../src/adapters/desktop-tools.js';
import type {SkillDocument} from '../src/core/knowledge.js';
import {Dashboard} from '../src/web/dashboard.js';
import {mount,type HostContext,type ToolDefinition} from '../src/adapters/dsh.js';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const price={version:'test-only',currency:'USD',inputPerMillion:'1000000',cachedPerMillion:'100000',outputPerMillion:'1000000'};
const route={provider:'test-http',model:'test',price,inputUpperBound:1000,maxOutput:100};
const capability={provider:route.provider,model:route.model,tier:'cheap' as const,vision:false,tools:false,contextLimit:10000,maxOutput:100,privacyRegion:'local',price};
const doc:SkillDocument={goal:'open panel',app:'mock-app',fingerprint:'mock-app:v1:zh:1280x720',precondition:'home',steps:[{kind:'click',target:'task-panel',expectedState:'task-panel',risk:'read_only',timeoutMs:1000}],evidenceRefs:['fixture://verified']};
function setup(t:TestContext,extra:RuntimeConfig={}) {
  const dir=mkdtempSync(join(tmpdir(),'ime-remaining-')),provider=new MockDesktop();
  const config:RuntimeConfig={dataDir:dir,allowApps:['mock-app'],desktopLeasePath:join(dir,'desktop.lock'),modelBudget:{sessionLimit:'100000',routes:[route]},routes:[capability],...extra};
  const r=new Runtime(config,provider);t.after(async()=>{await r.close();rmSync(dir,{recursive:true,force:true});});return {r,dir,provider,config};
}
function task(r:Runtime,limit='10000'){const task=r.tasks.create('session','open panel','mock-app',limit);r.tasks.transition(task.id,'ready');r.tasks.transition(task.id,'running');return task;}
async function listen(t:TestContext,server:Server) {
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  const address=server.address();assert.ok(address&&typeof address!=='string');return 'http://127.0.0.1:'+address.port+'/chat/completions';
}
function httpConfig(url:string,maxAttempts=1):RuntimeConfig{return {models:{enabled:true,maxAttempts,http:[{provider:route.provider,model:route.model,endpoint:url,inputOverheadTokens:32}]}};}
async function publish(r:Runtime,document:SkillDocument,id?:string){const skill=r.knowledge.proposeSkill(document,id);await r.knowledge.evaluate(skill.id,skill.version,['one','two','three'],async()=>true);r.knowledge.publish(skill.id,skill.version);return skill;}
function png(width:number,height:number,color:number,scanlines:number[],extra:{type:string;bytes:number[]}[]=[]) {
  const crc=(data:Buffer)=>{let value=0xffffffff;for(const byte of data){value^=byte;for(let i=0;i<8;i++)value=value>>>1^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;};
  const chunk=(type:string,data:Buffer)=>{const size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);const payload=Buffer.concat([Buffer.from(type),data]);checksum.writeUInt32BE(crc(payload));return Buffer.concat([size,payload,checksum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=color;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),...extra.map(item=>chunk(item.type,Buffer.from(item.bytes))),chunk('IDAT',deflateSync(Buffer.from(scanlines))),chunk('IEND',Buffer.alloc(0))]);
}

test('PNG decoding accepts grayscale, RGB filters, RGBA and indexed transparency with explicit pixels',()=>{
  assert.deepEqual([...decodePng(grayscalePng(2,1,new Uint8Array([10,200]))).pixels],[10,200]);
  const filtered=png(2,4,2,[1,255,0,0,1,255,0,2,1,0,255,255,0,255,3,10,20,159,164,169,174,4,0,0,0,0,0,0]);
  assert.deepEqual([...decodePng(filtered).pixels],[76,150,29,255,18,48,18,48]);
  assert.deepEqual([...decodePng(png(1,1,6,[0,255,0,0,128])).pixels],[165]);
  assert.deepEqual([...decodePng(png(2,1,3,[0,0,1],[{type:'PLTE',bytes:[255,0,0,0,0,255]},{type:'tRNS',bytes:[0,255]}])).pixels],[255,29]);
});
test('PNG decoding rejects corruption, pixel bombs, invalid filters and trailing content',()=>{
  const corrupted=grayscalePng(1,1,new Uint8Array([0]));corrupted[40]=corrupted[40]!^1;assert.throws(()=>decodePng(corrupted),/PNG/);
  assert.throws(()=>decodePng(png(100000,100000,0,[0,0])),/INVALID_PNG_DIMENSIONS/);
  assert.throws(()=>decodePng(png(1,1,0,[5,0])),/INVALID_PNG_FILTER/);
  assert.throws(()=>decodePng(png(1,1,0,Array<number>(1000000).fill(0))),/INVALID_PNG_PIXELS/);
  assert.throws(()=>decodePng(Buffer.concat([grayscalePng(1,1,new Uint8Array([0])),Buffer.from([0])])),/INVALID_PNG_END/);
});
test('provider PNG output enters the managed grayscale and redaction pipeline without exposing raw pixels',async t=>{
  const {r}=setup(t),config:DesktopToolConfig={provider:'image',toolPrefix:'image_',observeTool:'image_observe',executeTools:{click:'image_click',input:'image_input',scroll:'image_scroll'},targets:{'mock-app':{observeArgs:{},fingerprintPath:['fingerprint'],statePath:['state'],pngPath:['png'],actions:{}}}};
  const port=new ToolDesktopPort({get:()=>true,async execute(){return {isError:false,value:{fingerprint:doc.fingerprint,state:'home',png:'data:image/png;base64,'+grayscalePng(2,1,new Uint8Array([255,100])).toString('base64')}};}},()=> 'image',config);
  const observed=await port.observe('mock-app',new AbortController().signal);assert.deepEqual([...observed.frame!.pixels],[255,100]);
  r.vision.process(observed.frame!,{redact:[{x:0,y:0,width:1,height:1}]});assert.deepEqual([...decodePng(r.vision.image('mock-app').data).pixels],[0,100]);
  const {pngPath:_pngPath,...attachmentTarget}=config.targets['mock-app']!;
  const attached=new ToolDesktopPort({get:()=>true,async execute(){return {isError:false,value:{fingerprint:doc.fingerprint,state:'home',image:{id:'attachment-fixture'}}};}},()=> 'image',
    {...config,targets:{'mock-app':{...attachmentTarget,attachmentPath:['image']}}},
    async reference=>{assert.deepEqual(reference,{id:'attachment-fixture'});return {data:grayscalePng(1,1,new Uint8Array([80]))};});
  assert.deepEqual([...(await attached.observe('mock-app',new AbortController().signal)).frame!.pixels],[80]);
  assert.throws(()=>new ToolDesktopPort({get:()=>true,execute:async()=>({isError:false})},()=> 'image',{...config,targets:{'mock-app':{...config.targets['mock-app']!,framePath:['frame']}}}),/AMBIGUOUS_DESKTOP_FRAME/);
});

test('HTTP requests consume one durable receipt, use the exact output cap and settle once',async t=>{
  let count=0;const server=createServer(async(req,res)=>{count++;let body='';for await(const chunk of req)body+=chunk;const payload=JSON.parse(body);assert.equal(payload.max_tokens,20);assert.equal(payload.stream,false);
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'provider-'+count,choices:[{message:{content:'answer'},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:5,prompt_cache_hit_tokens:2}}));});
  const url=await listen(t,server),{r}=setup(t,httpConfig(url)),active=task(r);
  const result=await r.models.call(active.id,'hello',{maxOutput:20});assert.equal(result.text,'answer');assert.equal(count,1);
  assert.equal(r.store.db.prepare('SELECT COUNT(*) AS n FROM transport_attempts').get()?.n,1);
  assert.equal(r.store.db.prepare('SELECT COUNT(*) AS n FROM usage_entries').get()?.n,1);
  assert.equal(r.store.db.prepare('SELECT spent FROM budgets WHERE task_id=?').get(active.id)?.spent,16);
  const reservation=r.store.db.prepare('SELECT id,request_id FROM reservations').get()!;
  await assert.rejects(r.models.http!.generate({provider:route.provider,model:route.model,maxOutput:20,prompt:'hello',sessionId:'session',signal:new AbortController().signal,budget:{requestId:String(reservation.request_id),reservationId:String(reservation.id)}}),/HTTP_BUDGET_RECEIPT_INVALID/);
  assert.equal(count,1);assert.equal(r.models.http!.status().attempts[0]?.provider_request_id,'provider-1');
});
test('the HTTP boundary refuses unreserved requests and an exhausted budget before any socket dispatch',async t=>{
  let count=0;const url=await listen(t,createServer((_req,res)=>{count++;res.end('{}');})),{r}=setup(t,httpConfig(url)),active=task(r,'1');
  await assert.rejects(r.models.http!.generate({provider:route.provider,model:route.model,maxOutput:20,prompt:'hello',sessionId:'session',signal:new AbortController().signal}),/HTTP_BUDGET_RECEIPT_REQUIRED/);
  await assert.rejects(r.models.call(active.id,'hello',{maxOutput:20}),/NO_ELIGIBLE_MODEL|BUDGET_DENIED/);assert.equal(count,0);
});
test('a proven preflight rejection releases task, ancestor and aggregate reservations without inventing a bill',async t=>{
  let count=0;const url=await listen(t,createServer((_req,res)=>{count++;res.end('{}');}));
  const {r}=setup(t,{...httpConfig(url),modelBudget:{sessionLimit:'10000',routes:[{...route,inputUpperBound:32}]}});
  r.costs.setLimit('account','*','USD','10000');const parent=task(r),child=r.orchestrator.create(parent.id,[{goal:'child',app:'mock-app',limit:'10000'}])[0]!;r.tasks.transition(child,'running');
  await assert.rejects(r.models.call(child,'too many bytes',{maxOutput:20}),/HTTP_INPUT_BOUND_REQUIRED/);
  assert.equal(count,0);assert.equal(r.store.db.prepare('SELECT reserved FROM budgets WHERE task_id=?').get(child)?.reserved,0);
  assert.equal(r.store.db.prepare('SELECT reserved FROM budgets WHERE task_id=?').get(parent.id)?.reserved,0);
  assert.equal(r.store.db.prepare('SELECT reserved FROM budget_caps WHERE scope=\'account\'').get()?.reserved,0);
  assert.equal(r.store.db.prepare('SELECT COUNT(*) AS n FROM usage_entries').get()?.n,0);
  assert.equal(r.store.db.prepare('SELECT state FROM reservations').get()?.state,'released');
});
test('an in-flight HTTP receipt prevents releasing a reservation that may already be billed',async t=>{
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  const url=await listen(t,createServer(async(req,res)=>{req.resume();entered();await gate;res.end(JSON.stringify({choices:[{message:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:5}}));}));
  const {r}=setup(t,httpConfig(url)),active=task(r),pending=r.models.call(active.id,'hello',{maxOutput:20});await started;
  try{const reservation=r.store.db.prepare('SELECT id FROM reservations').get()!;assert.throws(()=>r.costs.release(String(reservation.id)),/REQUEST_MAY_HAVE_DISPATCHED/);}
  finally{release();}
  await pending;
});
test('HTTP redirects are never followed and every explicit retry has its own retained charge',async t=>{
  let first=0,second=0;const secondUrl=await listen(t,createServer((_req,res)=>{second++;res.end('{}');}));
  const firstUrl=await listen(t,createServer((_req,res)=>{first++;res.writeHead(307,{Location:secondUrl});res.end();}));
  const {r}=setup(t,httpConfig(firstUrl,2)),active=task(r);await assert.rejects(r.models.call(active.id,'hello',{maxOutput:20}),/HTTP_MODEL_STATUS_307/);
  assert.equal(first,2);assert.equal(second,0);assert.equal(r.store.db.prepare('SELECT spent FROM budgets WHERE task_id=?').get(active.id)?.spent,2040);
  assert.equal(r.store.db.prepare('SELECT COUNT(*) AS n FROM transport_attempts').get()?.n,2);
});
test('a Provider bound violation blocks future route dispatch until an authenticated user resets it',async t=>{
  let count=0;const url=await listen(t,createServer((_req,res)=>{count++;res.end(JSON.stringify({choices:[{message:{content:'overrun'},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:21}}));}));
  const {r}=setup(t,httpConfig(url)),first=task(r);await assert.rejects(r.models.call(first.id,'hello',{maxOutput:20}),/MODEL_BOUND_EXCEEDED/);
  const second=task(r);await assert.rejects(r.models.call(second.id,'hello',{maxOutput:20}),/NO_ELIGIBLE_MODEL/);assert.equal(count,1);
  assert.equal(r.models.http!.status().blocks.length,1);r.models.http!.reset(route.provider,route.model);assert.equal(r.models.http!.status().blocks.length,0);
  const reservation=r.store.db.prepare('SELECT id FROM reservations LIMIT 1').get()!;assert.throws(()=>r.costs.release(String(reservation.id)),/RESERVATION_NOT_OPEN/);
});

test('unpublished skill dependencies block publication and rollback invalidates transitive consumers',async t=>{
  const {r}=setup(t);const library=r.knowledge.proposeSkill({...doc,goal:'library'}),consumer=r.knowledge.proposeSkill({...doc,goal:'consumer',dependencies:[library]});
  await r.knowledge.evaluate(consumer.id,consumer.version,['one','two','three'],async()=>true);assert.throws(()=>r.knowledge.publish(consumer.id,consumer.version),/SKILL_DEPENDENCY_UNAVAILABLE/);
  await r.knowledge.evaluate(library.id,library.version,['one','two','three'],async()=>true);r.knowledge.publish(library.id,library.version);r.knowledge.publish(consumer.id,consumer.version);
  const child=await publish(r,{...doc,goal:'transitive consumer',dependencies:[consumer]});r.knowledge.rollback(library.id,library.version);
  assert.equal(r.knowledge.skill(consumer.id,consumer.version).status,'deprecated');assert.equal(r.knowledge.skill(child.id,child.version).status,'deprecated');
  const active=task(r);await assert.rejects(r.skills.run(active.id,child.id,child.version),/SKILL_NOT_PUBLISHED/);
});
test('a skill dependency withdrawn while observation awaits stops execution before dispatch',async t=>{
  const {r,provider}=setup(t);const dependency=await publish(r,{...doc,goal:'library'}),consumer=await publish(r,{...doc,dependencies:[dependency]});
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  provider.observe=async()=>{entered();await gate;return {fingerprint:doc.fingerprint,state:'home',evidenceRef:'fixture'};};
  const active=task(r),running=r.skills.run(active.id,consumer.id,consumer.version);await started;r.knowledge.rollback(dependency.id,dependency.version);release();
  await assert.rejects(running,/SKILL_NOT_PUBLISHED|SKILL_DEPENDENCY_UNAVAILABLE/);assert.equal(provider.calls.length,0);
});
test('cross-device skill dependencies are remapped to locally reviewed candidate versions',t=>{
  process.env.IME_DEPENDENCY_SYNC_KEY=randomBytes(32).toString('base64');t.after(()=>{delete process.env.IME_DEPENDENCY_SYNC_KEY;});
  const sync={namespace:'dependency-test',keyEnv:'IME_DEPENDENCY_SYNC_KEY'},a=setup(t,{sync}).r,b=setup(t,{sync}).r;
  const library=a.knowledge.proposeSkill({...doc,goal:'library'}),consumer=a.knowledge.proposeSkill({...doc,dependencies:[library]});
  b.sync.import(a.sync.export());const pending=b.sync.status().pending;
  const source=pending.find(row=>row.source_id===library.id+':'+library.version)!,dependent=pending.find(row=>row.source_id===consumer.id+':'+consumer.version)!;
  assert.throws(()=>b.sync.apply(String(dependent.record_key),true),/SYNC_DEPENDENCY_REVIEW_REQUIRED/);
  const accepted=b.sync.apply(String(source.record_key),true),mapped=b.sync.apply(String(dependent.record_key),true);
  const split=String(accepted.localId).lastIndexOf(':'),id=String(accepted.localId).slice(0,split),version=Number(String(accepted.localId).slice(split+1));
  const localConsumer=String(mapped.localId).slice(0,String(mapped.localId).lastIndexOf(':'));
  assert.deepEqual(b.knowledge.skill(localConsumer).document.dependencies,[{id,version}]);assert.equal(b.knowledge.skill(localConsumer).status,'candidate');
});

test('read-only acceptance monitoring records measured evidence and responds to task pause',async t=>{
  const {r}=setup(t),active=task(r),job=r.acceptance.start(active.id,{durationMs:1000,intervalMs:10});
  await new Promise(resolve=>setTimeout(resolve,30));r.pause(active.id);
  const report=await r.acceptance.result(job.id) as {status:string;sampleCount:number;stopLatencyMs:number;samples:unknown[]};
  assert.equal(report.status,'cancelled');assert.ok(report.sampleCount>0);assert.ok(report.stopLatencyMs>=0);assert.ok(!JSON.stringify(report).includes('home'));
  assert.equal(r.tasks.get(active.id).status,'paused');
});
test('acceptance A/B uses completed task evidence and rejects unknown cost or unmatched environments',async t=>{
  const {r}=setup(t),baseline:string[]=[],candidate:string[]=[];
  for(let i=0;i<3;i++)for(const ids of [baseline,candidate]) {
    const active=task(r);await r.observe(active.id);if(ids===baseline)await r.costs.call(active.id,price,{inputUpperBound:20,maxOutput:10,toolAllowance:'0'},async()=>({value:'fixture',usage:{inputTokens:10,cachedInputTokens:0,outputTokens:5}}));
    r.tasks.transition(active.id,'succeeded');ids.push(active.id);
  }
  const report=r.acceptance.compare(baseline,candidate);assert.equal(report.passed,true);assert.equal(report.costReduction,1);assert.equal(report.baseline.amountMicro,'45');
  const changed=candidate[0]!;r.store.db.prepare('UPDATE checkpoints SET fingerprint=? WHERE task_id=?').run('changed',changed);
  assert.throws(()=>r.acceptance.compare(baseline,candidate),/ACCEPTANCE_ENVIRONMENT_MISMATCH/);
  r.store.db.prepare('UPDATE checkpoints SET fingerprint=? WHERE task_id=?').run(doc.fingerprint,changed);
  r.store.db.prepare("UPDATE usage_entries SET certainty='unknown'").run();assert.equal(r.acceptance.compare(baseline,candidate).passed,false);
});
test('account statement reconciliation preserves tariff history and refuses conflicting or mixed-currency evidence',async t=>{
  const {r}=setup(t),active=task(r);await r.costs.call(active.id,price,{inputUpperBound:20,maxOutput:10,toolAllowance:'0'},async()=>({value:'fixture',usage:{inputTokens:10,cachedInputTokens:0,outputTokens:5}}));
  const entry=r.store.db.prepare('SELECT * FROM usage_entries').get()!;
  const line={requestId:String(entry.request_id),statementRef:'provider-export-row-1',currency:'USD',chargedAmount:'12'};
  assert.equal(r.acceptance.reconcileStatement([line])[0]?.differenceMicro,'-3');assert.equal(r.acceptance.reconcileStatement([line]).length,1);
  assert.equal(r.store.db.prepare('SELECT amount FROM usage_entries').get()?.amount,15);
  assert.throws(()=>r.acceptance.reconcileStatement([{...line,chargedAmount:'13'}]),/STATEMENT_CONFLICT/);
  assert.throws(()=>r.acceptance.reconcileStatement([{...line,currency:'CNY'}]),/CURRENCY_MISMATCH/);
  await r.costs.call(active.id,price,{inputUpperBound:20,maxOutput:10,toolAllowance:'0'},async()=>({value:'fixture',usage:{inputTokens:10,cachedInputTokens:0,outputTokens:5}}));
  const second=r.store.db.prepare('SELECT request_id FROM usage_entries WHERE request_id<>?').get(line.requestId)!;
  assert.throws(()=>r.acceptance.reconcileStatement([{...line,requestId:String(second.request_id)}]),/STATEMENT_ALREADY_ASSIGNED/);
});
test('acceptance starts and transport resets require dashboard authentication and never appear as model tools',async t=>{
  const {r,dir}=setup(t),active=task(r),dashboard=new Dashboard(r,undefined,{});await dashboard.ready;t.after(()=>dashboard.close());
  const body=JSON.stringify({operation:'acceptance_start',taskId:active.id,durationMs:20,intervalMs:10});
  assert.equal((await fetch(dashboard.url+'api/command',{method:'POST',headers:{'Content-Type':'application/json'},body})).status,401);
  const headers={Authorization:'Bearer '+dashboard.token,'Content-Type':'application/json'},response=await fetch(dashboard.url+'api/command',{method:'POST',headers,body});assert.equal(response.status,200);
  const job=await response.json() as {id:string};await r.acceptance.result(job.id);
  assert.equal((await fetch(dashboard.url+'api/acceptance?id='+job.id,{headers})).status,200);
  const registered=new Map<string,ToolDefinition>(),ctx:HostContext={get:()=>undefined,effect:()=>undefined,on:()=>()=>{},tools:{register(tool){registered.set(tool.name,tool);return()=>registered.delete(tool.name);}}};
  const mounted=mount(ctx,{dataDir:join(dir,'tool-policy'),dashboard:{enabled:false}});
  try{for(const name of ['ime_acceptance_start','ime_transport_reset','ime_statement_reconcile'])assert.equal(registered.has(name),false);}
  finally{await mounted.dispose();}
});
test('the acceptance CLI reads the protected local URL and never prints its access token',async t=>{
  const {r,dir}=setup(t),active=task(r),dashboard=new Dashboard(r,undefined,{});await dashboard.ready;t.after(()=>dashboard.close());
  const output=await promisify(execFile)(process.execPath,['scripts/acceptance.mjs','observe','--task',active.id,'--minutes','0.001','--interval','10','--data-dir',dir],{cwd:process.cwd(),timeout:10000});
  const result=JSON.parse(output.stdout) as {id:string};assert.ok(result.id);assert.ok(!output.stdout.includes(dashboard.token));assert.ok(!output.stderr.includes(dashboard.token));
  const report=await r.acceptance.result(result.id) as {status:string};assert.equal(report.status,'completed');
});
