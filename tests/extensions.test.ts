import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {Runtime,type RuntimeConfig} from '../src/core/runtime.js';
import {MockDesktop} from '../src/adapters/mock.js';
import {HostModelPort} from '../src/adapters/host-model.js';
import {HostModelGateway} from '../src/adapters/model-gateway.js';
import type {HostContext} from '../src/adapters/dsh.js';
import {localEmbedding} from '../src/core/hybrid-search.js';
import {Telemetry} from '../src/core/telemetry.js';
import {SyncManager} from '../src/core/sync.js';
import {VisionPipeline} from '../src/core/vision-pipeline.js';
import {DesktopProviderPool} from '../src/adapters/desktop-pool.js';
import type {DesktopToolConfig,HostTools} from '../src/adapters/desktop-tools.js';
import type {SkillDocument} from '../src/core/knowledge.js';
import {inflateSync} from 'node:zlib';
import {mountContext} from '../src/adapters/host-context.js';

const price={version:'fixture',currency:'USD',inputPerMillion:'1000000',cachedPerMillion:'100000',outputPerMillion:'1000000'};
const route={provider:'fixture',model:'cheap',price,inputUpperBound:1000,maxOutput:100};
const capabilities={provider:'fixture',model:'cheap',tier:'cheap' as const,vision:false,tools:false,contextLimit:10000,maxOutput:100,privacyRegion:'local',price};
const document:SkillDocument={goal:'打开任务面板',app:'mock-app',fingerprint:'mock-app:v1:zh:1280x720',precondition:'home',steps:[{kind:'click',target:'task-panel',expectedState:'task-panel',risk:'reversible_write',timeoutMs:1000}],evidenceRefs:['fixture://source']};
function setup(t:TestContext,extra:RuntimeConfig={}) {
  const dir=mkdtempSync(join(tmpdir(),'ime-extensions-')),provider=new MockDesktop();
  const config:RuntimeConfig={dataDir:dir,allowApps:['mock-app'],desktopLeasePath:join(dir,'desktop.lock'),modelBudget:{sessionLimit:'100000',routes:[route]},
    routes:[capabilities],models:{enabled:true,maxAttempts:1},...extra};
  const runtime=new Runtime(config,provider);
  t.after(async()=>{await runtime.close();rmSync(dir,{recursive:true,force:true});});return {runtime,provider,dir,config};
}
function task(r:Runtime,limit='100000') {const task=r.tasks.create('session','fixture task','mock-app',limit);r.tasks.transition(task.id,'ready');r.tasks.transition(task.id,'running');return task;}
async function listen(t:TestContext,server:Server) {
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  const address=server.address();assert.ok(address&&typeof address!=='string');return 'http://127.0.0.1:'+address.port;
}

test('hybrid retrieval combines FTS and vector similarity while preserving trust, application and TTL isolation',t=>{
  const {runtime:r}=setup(t);
  const id=r.knowledge.propose({kind:'fact',app:'mock-app',content:'打开面板查看任务列表',trust:'user',sourceEventIds:[]});
  r.knowledge.propose({kind:'fact',app:'mock-app',content:'打开面板查看任务列表',trust:'model_inferred',sourceEventIds:[]});
  r.knowledge.propose({kind:'fact',app:'other',content:'打开面板查看任务列表',trust:'user',sourceEventIds:[]});
  assert.equal(r.knowledge.retrieve('任务面板','mock-app')[0]?.id,id,'non-contiguous Chinese terms can be recalled by the local vector index');
  assert.equal(r.knowledge.retrieve('任务面板','mock-app').length,1);
  assert.equal(localEmbedding('same').length,256);
  r.store.db.prepare('UPDATE memories SET expires_at=? WHERE id=?').run('2000-01-01',id);assert.equal(r.knowledge.retrieve('任务面板','mock-app').length,0);
  r.knowledge.deleteMemory(id);assert.equal(r.store.db.prepare('SELECT COUNT(*) AS n FROM memory_vectors WHERE memory_id=?').get(id)?.n,0);
});

test('external embeddings validate dimensions and models without replacing trust checks',t=>{
  const {runtime:r}=setup(t);const id=r.knowledge.propose({kind:'fact',app:'mock-app',content:'mail draft',trust:'user',sourceEventIds:[]});
  const vector=[1,0,0,0,0,0,0,0];r.knowledge.hybrid.index(id,'mail draft',vector,'semantic-fixture');
  assert.equal(r.knowledge.retrieve('邮件草稿','mock-app',5,{model:'semantic-fixture',vector})[0]?.id,id);
  assert.throws(()=>r.knowledge.hybrid.index(id,'mail draft',[NaN],'invalid'),/INVALID_EMBEDDING/);
});

test('dynamic routing learns task outcomes, persists feedback and never bypasses capability or budget filters',async t=>{
  const strong={...capabilities,model:'strong',tier:'strong' as const};
  const {runtime:r,config,provider}=setup(t,{routes:[capabilities,strong]});
  const request={tokens:10,output:10,vision:false,tools:false,currency:'USD',remaining:1000,failures:0,category:'test'};
  assert.equal(r.router.select(request).kind,'model');
  for(let i=0;i<5;i++)r.router.feedback({requestId:'cheap-'+i,provider:'fixture',model:'cheap',category:'test',success:false,amount:20,currency:'USD',latencyMs:10});
  for(let i=0;i<5;i++)r.router.feedback({requestId:'strong-'+i,provider:'fixture',model:'strong',category:'test',success:true,amount:20,currency:'USD',latencyMs:10});
  const choice=r.router.select(request);assert.equal(choice.kind==='model'&&choice.route.model,'strong');
  assert.throws(()=>r.router.select({...request,vision:true}),/NO_ELIGIBLE_MODEL/);
  assert.throws(()=>r.router.select({...request,remaining:0}),/NO_ELIGIBLE_MODEL/);
  await r.close();const restarted=new Runtime(config,provider);try{assert.equal(restarted.router.history('fixture','cheap','test','USD').samples,5);}finally{await restarted.close();}
});

test('managed model calls reserve before dispatch, settle usage and learn only after task verification',async t=>{
  const {runtime:r}=setup(t);const active=task(r);let calls=0;
  r.models.bind({async generate(){calls++;assert.equal(r.store.db.prepare('SELECT reserved FROM budgets WHERE task_id=?').get(active.id)?.reserved,1020);return {text:'answer',usage:{inputTokens:10,cachedInputTokens:0,outputTokens:5}};}});
  const result=await r.models.call(active.id,'question',{maxOutput:20});assert.equal(result.text,'answer');assert.equal(calls,1);
  assert.equal(r.store.db.prepare('SELECT spent FROM budgets WHERE task_id=?').get(active.id)?.spent,15);
  assert.equal(r.router.history('fixture','cheap','general','USD').samples,0);
  r.tasks.transition(active.id,'succeeded');assert.equal(r.router.history('fixture','cheap','general','USD').samples,1);
  const tiny=task(r,'1');await assert.rejects(r.models.call(tiny.id,'question',{maxOutput:20}),/NO_ELIGIBLE_MODEL|BUDGET_DENIED/);assert.equal(calls,1);
});

test('host prepared calls pass through the normal middleware exactly once without duplicate reservation',async t=>{
  const {runtime:r}=setup(t);const active=task(r),gateway=new HostModelGateway(r,r.settings.modelBudget);
  const ctx={get:()=>({prepareCall:async(config:Record<string,unknown>)=>({config,stream:(options:Record<string,unknown>)=>gateway.intercept(options as never,async function*(){
    yield {type:'text-delta',text:'one'};yield {type:'usage',usage:{inputTokens:10,outputTokens:2}};yield {type:'finish',reason:{kind:'stop'}};
  })})})} as unknown as HostContext;
  r.models.bind(new HostModelPort(ctx));
  assert.equal((await r.models.call(active.id,'question',{maxOutput:20})).text,'one');
  assert.equal(r.store.db.prepare('SELECT COUNT(*) AS n FROM reservations').get()?.n,1);
  assert.equal(r.store.db.prepare('SELECT COUNT(*) AS n FROM model_requests').get()?.n,1);await gateway.close();
});

test('every model retry consumes a new reservation and unknown failures are never released',async t=>{
  const {runtime:r}=setup(t,{models:{enabled:true,maxAttempts:2}});const active=task(r);let calls=0;
  r.models.bind({async generate(){if(++calls===1)throw Error('fixture network failure');return {text:'retry',usage:{inputTokens:10,cachedInputTokens:0,outputTokens:2}};}});
  assert.equal((await r.models.call(active.id,'question',{maxOutput:20})).text,'retry');
  assert.equal(r.store.db.prepare('SELECT COUNT(*) AS n FROM reservations').get()?.n,2);
  assert.equal(r.store.db.prepare('SELECT spent FROM budgets WHERE task_id=?').get(active.id)?.spent,1032);
  assert.equal(r.store.db.prepare("SELECT COUNT(*) AS n FROM usage_entries WHERE certainty='unknown'").get()?.n,1);
});

test('pausing a managed model task aborts the provider and retains the uncertain bill without retrying',async t=>{
  const {runtime:r}=setup(t,{models:{enabled:true,maxAttempts:3}}),active=task(r);let calls=0;
  r.models.bind({generate(request){calls++;return new Promise((_resolve,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true}));}});
  const pending=r.models.call(active.id,'question',{maxOutput:20});r.pause(active.id);
  await assert.rejects(pending,/STOPPED/);assert.equal(calls,1);assert.equal(r.tasks.get(active.id).status,'paused');
  assert.equal(r.store.db.prepare('SELECT spent FROM budgets WHERE task_id=?').get(active.id)?.spent,1020);
});

test('model review uses the bound production adapter and enforces the independent ten-percent quota',async t=>{
  const {runtime:r}=setup(t,{models:{enabled:true,maxAttempts:1,review:{provider:'fixture',model:'cheap',maxOutput:100}}});
  const report={failureCategory:'success',evidenceRefs:[],rootCauseHypothesis:'verified',proposedChange:'candidate only',risk:'review_only',verificationPlan:'three independent cases'};
  let calls=0;r.models.bind({async generate(){calls++;return {text:JSON.stringify(report),usage:{inputTokens:20,cachedInputTokens:0,outputTokens:30}};}});
  const active=task(r,'20000');r.tasks.transition(active.id,'succeeded');assert.deepEqual(await r.review.review(active.id),report);assert.equal(calls,1);
  assert.equal(r.store.db.prepare('SELECT amount FROM review_costs WHERE task_id=?').get(active.id)?.amount,50);
  const tiny=task(r,'100');r.tasks.transition(tiny.id,'succeeded');await assert.rejects(r.review.review(tiny.id),/REVIEW_BUDGET_DENIED/);assert.equal(calls,1);
});

test('parallel children cannot double-spend their common parent budget and cancellation propagates',async t=>{
  const {runtime:r}=setup(t);const parent=task(r,'100');const children=r.orchestrator.create(parent.id,[{goal:'one',app:'mock-app',limit:'100'},{goal:'two',app:'mock-app',limit:'100'}]);
  children.forEach(id=>r.tasks.transition(id,'running'));
  const quote=r.costs.quote(price,{inputUpperBound:50,maxOutput:10,toolAllowance:'0'});
  const first=r.costs.reserve(children[0]!,'first',quote);
  assert.throws(()=>r.costs.reserve(children[1]!,'second',quote),/BUDGET_DENIED/);
  assert.equal(r.store.db.prepare('SELECT reserved FROM budgets WHERE task_id=?').get(parent.id)?.reserved,60);
  r.costs.settle(first,{inputTokens:20,cachedInputTokens:0,outputTokens:10});
  assert.equal(r.store.db.prepare('SELECT spent FROM budgets WHERE task_id=?').get(parent.id)?.spent,30);
  r.cancel(parent.id);assert.ok(children.every(id=>r.tasks.get(id).status==='cancelled'));
});

test('uncertain child costs remain charged to every ancestor and reconciliation updates the whole family',t=>{
  const {runtime:r}=setup(t),parent=task(r,'1000'),child=r.orchestrator.create(parent.id,[{goal:'child',app:'mock-app',limit:'1000'}])[0]!;
  r.tasks.transition(child,'running');const reservation=r.costs.reserve(child,'family-unknown',r.costs.quote(price,{inputUpperBound:50,maxOutput:10,toolAllowance:'0'}));
  r.costs.settle(reservation);assert.equal(r.store.db.prepare('SELECT spent FROM budgets WHERE task_id=?').get(parent.id)?.spent,60);
  r.costs.reconcile(reservation,{inputTokens:10,cachedInputTokens:0,outputTokens:10});
  assert.equal(r.store.db.prepare('SELECT spent FROM budgets WHERE task_id=?').get(parent.id)?.spent,20);
  assert.equal(r.store.db.prepare('SELECT spent FROM budgets WHERE task_id=?').get(child)?.spent,20);
  r.pause(parent.id);assert.equal(r.tasks.executionAllowed(child),false);
});

test('subtask scheduling overlaps independent work, honors dependency order and refuses malformed graphs atomically',async t=>{
  const {runtime:r}=setup(t);const parent=task(r),ids=r.orchestrator.create(parent.id,[{goal:'a',app:'mock-app',limit:'100'},
    {goal:'b',app:'mock-app',limit:'100'},{goal:'c',app:'mock-app',limit:'100',dependsOn:[0,1]}]);
  let active=0,peak=0;const finished=new Set<string>();
  const report=await r.orchestrator.run(parent.id,async id=>{if(id===ids[2])assert.equal(finished.size,2);active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5));active--;finished.add(id);},2) as {succeeded:boolean};
  assert.equal(peak,2);assert.equal(report.succeeded,true);
  const before=r.status().tasks.length;
  assert.throws(()=>r.orchestrator.create(parent.id,[{goal:'valid',app:'mock-app',limit:'1'},{goal:'invalid',app:'mock-app',limit:'x'}]),/INVALID_MONEY/);
  assert.equal(r.status().tasks.length,before);
});

test('encrypted multi-device exchange preserves conflicts and imports only reviewed candidates',t=>{
  process.env.IME_TEST_SYNC_KEY=randomBytes(32).toString('base64');t.after(()=>{delete process.env.IME_TEST_SYNC_KEY;});
  const a=setup(t,{sync:{namespace:'team',keyEnv:'IME_TEST_SYNC_KEY'}}).runtime,b=setup(t,{sync:{namespace:'team',keyEnv:'IME_TEST_SYNC_KEY'}}).runtime;
  const id=a.knowledge.propose({kind:'fact',app:'mock-app',content:'private task knowledge',trust:'user',sourceEventIds:[]});
  a.knowledge.proposeSkill(document);
  const envelope=a.sync.export();assert.ok(!JSON.stringify(envelope).includes('private task knowledge'));
  assert.equal(b.sync.import(envelope).added,2);assert.equal(b.sync.import(envelope).added,0);
  for(const record of b.sync.status().pending)b.sync.apply(String(record.record_key),true);
  assert.equal(b.knowledge.retrieve('private','mock-app').length,0);assert.equal(b.knowledge.listMemories()[0]?.trust,'model_inferred');
  assert.equal(b.knowledge.listSkills()[0]?.status,'candidate');
  const localId=String(b.knowledge.listMemories()[0]?.id);b.knowledge.approve(localId);assert.equal(b.knowledge.retrieve('private','mock-app').length,1);
  a.knowledge.deleteMemory(id);b.sync.import(a.sync.export());
  const deletion=b.sync.status().pending.find(record=>record.kind==='delete')!;
  assert.equal(b.knowledge.listMemories().length,1,'remote deletion needs local approval');b.sync.apply(String(deletion.record_key),true);assert.equal(b.knowledge.listMemories().length,0);
  assert.throws(()=>b.sync.import({...envelope,namespace:'other'}),/INVALID_SYNC_ENVELOPE/);
  assert.throws(()=>b.sync.import({...envelope,tag:randomBytes(16).toString('base64')}),/SYNC_AUTHENTICATION_FAILED/);
});

test('cloud exchange uses conditional updates and keeps the inbox after an upload conflict',async t=>{
  process.env.IME_TEST_SYNC_KEY=randomBytes(32).toString('base64');t.after(()=>{delete process.env.IME_TEST_SYNC_KEY;});
  let payload:unknown;let version=0;
  const server=createServer(async(req,res)=>{
    if(req.method==='GET'){if(!payload){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':'application/json',ETag:'"'+version+'"'});res.end(JSON.stringify(payload));return;}
    assert.equal(payload?req.headers['if-match']:req.headers['if-none-match'],payload?'"'+version+'"':'*');
    let body='';for await(const chunk of req)body+=chunk;payload=JSON.parse(body);version++;res.writeHead(204);res.end();
  });
  const url=await listen(t,server),a=setup(t,{sync:{namespace:'cloud',keyEnv:'IME_TEST_SYNC_KEY',endpoint:url}}).runtime,b=setup(t,{sync:{namespace:'cloud',keyEnv:'IME_TEST_SYNC_KEY',endpoint:url}}).runtime;
  a.knowledge.propose({kind:'fact',app:'mock-app',content:'cloud candidate',trust:'user',sourceEventIds:[]});
  await a.sync.exchange();await b.sync.exchange();assert.equal(b.sync.status().pending.length,1);
  let calls=0;const rejecting=new SyncManager(b.store,b.knowledge,{namespace:'cloud',keyEnv:'IME_TEST_SYNC_KEY',endpoint:url},async()=>++calls===1?new Response(JSON.stringify(payload),{headers:{ETag:'"2"','Content-Type':'application/json'}}):new Response('',{status:412}));
  await assert.rejects(rejecting.exchange(),/SYNC_CONCURRENT_UPDATE/);assert.equal(b.sync.status().pending.length,1);
});

test('OTLP export strips payload secrets and advances its durable cursor only after collector acceptance',async t=>{
  const {runtime:r}=setup(t);r.store.event('ime.test',{taskId:'task',password:'secret-value',prompt:'private text',amount:'5'});
  let calls=0;const collector=async()=>{calls++;return new Response(JSON.stringify(calls===1?{partialSuccess:{rejectedSpans:1}}:{}),{headers:{'Content-Type':'application/json'}});};
  const telemetry=new Telemetry(r.store,{endpoint:'http://127.0.0.1:4318/v1/traces'},collector);
  const payload=JSON.stringify(telemetry.batch().payload);assert.ok(!payload.includes('secret-value'));assert.ok(!payload.includes('private text'));assert.ok(payload.includes('ime.taskId'));
  await assert.rejects(telemetry.flush(),/TELEMETRY_PARTIAL_REJECTION/);assert.equal(telemetry.status().cursor,0);
  await telemetry.flush();assert.ok(telemetry.status().cursor>0);await telemetry.close();
});

test('visual state transitions force evidence, adaptive sampling suppresses duplicates and collages carry ordered labels',t=>{
  const {dir}=setup(t);const vision=new VisionPipeline(join(dir,'visual'),{threshold:0.1,maxKeyframesPerMinute:10,retentionMs:10000,storeFrames:true,
    sampleFps:1,adaptive:true,states:[{name:'dialog',regions:[{roi:{x:0,y:0,width:1,height:1},mean:255,tolerance:0}]}]});
  const frame={app:'mock-app',width:2,height:1,pixels:new Uint8Array([0,0]),timestamp:1000};
  assert.equal(vision.process(frame).selected,true);assert.equal(vision.process({...frame,timestamp:1100}).selected,false);
  assert.equal(vision.process({...frame,timestamp:1200,pixels:new Uint8Array([255,0])}).selected,true);
  const summaries=vision.summarize('mock-app');assert.equal(summaries[1]?.state,'dialog');assert.equal(summaries[1]?.reason,'transition');
  const collage=vision.contactSheet('mock-app');assert.equal(collage.frames.length,2);assert.ok(readFileSync(join(dir,'visual',collage.evidenceRef)).subarray(0,2).toString()==='P5');
});

test('on-demand vision sends only a redacted ROI PNG, counts its budget and reuses unchanged evidence',async t=>{
  const {runtime:r,provider}=setup(t,{models:{enabled:true,vision:true,maxAttempts:1},routes:[{...capabilities,vision:true}],
    vision:{redact:[{x:0,y:0,width:1,height:1}],roi:{x:0,y:0,width:1,height:1}}});
  provider.observe=async(app,signal)=>{signal.throwIfAborted();return {fingerprint:document.fingerprint,state:'home',evidenceRef:'fixture',frame:{app,width:2,height:1,pixels:new Uint8Array([255,255]),timestamp:Date.now()}};};
  let calls=0;r.models.bind({async generate(request){calls++;assert.ok(request.image);const png=Buffer.from(request.image.data);assert.equal(png.readUInt32BE(16),1);
    const length=png.readUInt32BE(33);assert.deepEqual([...inflateSync(png.subarray(41,41+length))],[0,0]);
    return {text:'masked panel',usage:{inputTokens:20,cachedInputTokens:0,outputTokens:10}};
  }});
  const active=task(r);const result=await r.inspectVision(active.id,'describe this panel');assert.equal(result.source,'model');
  assert.equal((await r.inspectVision(active.id,'describe this panel')).source,'cache');assert.equal(calls,1);
  assert.equal(r.store.db.prepare('SELECT spent FROM budgets WHERE task_id=?').get(active.id)?.spent,30);
  assert.ok(!JSON.stringify(result).includes('pixels'));
});

test('local visual classification avoids a model call when it already identifies the state',async t=>{
  const {runtime:r,provider}=setup(t,{models:{enabled:true,vision:true},vision:{states:[{name:'known-panel',regions:[{roi:{x:0,y:0,width:1,height:1},mean:255,tolerance:0}]}]}});
  provider.observe=async(app)=>({fingerprint:document.fingerprint,state:'home',evidenceRef:'fixture',frame:{app,width:1,height:1,pixels:new Uint8Array([255]),timestamp:Date.now()}});
  r.models.bind({async generate(){throw Error('must not dispatch');}});
  const active=task(r),result=await r.inspectVision(active.id);assert.equal(result.source,'local');
  assert.equal(r.store.db.prepare('SELECT COUNT(*) AS n FROM model_requests').get()?.n,0);
});

test('audit rotation preserves committed order and rebuilds bounded segments from SQLite',async t=>{
  const {runtime:r,dir}=setup(t,{audit:{maxBytes:600,retainedFiles:2}});
  for(let i=0;i<20;i++)r.store.event('ime.rotation',{index:i});r.store.flushAudit();
  assert.ok(readdirSync(dir).includes('audit.1.jsonl'));assert.ok(readdirSync(dir).includes('audit.2.jsonl'));
  assert.ok(!readdirSync(dir).includes('audit.3.jsonl'));
  r.store.exportAudit();
  const rows=readFileSync(join(dir,'audit.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(rows.at(-1)?.data.index,19);assert.equal(r.store.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE type='ime.rotation'").get()?.n,20);
});

test('multiple desktop adapters honor the active slot, window whitelist and permission state',async()=>{
  let active='one',window='allowed',permitted=true;const calls:string[]=[];
  const tools:HostTools={get:()=>true,async execute(call){calls.push(call.name);return {isError:false,value:call.name.endsWith('observe')?{fingerprint:'v1',state:'home',window,permitted}:{ok:true}};}};
  const config=(provider:string):DesktopToolConfig=>({provider,toolPrefix:provider+'_',observeTool:provider+'_observe',executeTools:{click:provider+'_click',input:provider+'_input',scroll:provider+'_scroll'},targets:{'mock-app':{
    observeArgs:{},fingerprintPath:['fingerprint'],statePath:['state'],permissionPath:['permitted'],window:{path:['window'],allow:['allowed']},actions:{panel:{kind:'click',args:{target:'panel'},risk:'read_only',expectedState:'panel'}}}}});
  const pool=new DesktopProviderPool(tools,()=>active,[config('one'),config('two')]);
  await pool.observe('mock-app',new AbortController().signal);assert.equal(calls.at(-1),'one_observe');
  active='two';await pool.observe('mock-app',new AbortController().signal);assert.equal(calls.at(-1),'two_observe');
  window='denied';await assert.rejects(pool.observe('mock-app',new AbortController().signal),/WINDOW_DENIED/);window='allowed';permitted=false;
  await assert.rejects(pool.observe('mock-app',new AbortController().signal),/DESKTOP_PERMISSION_REQUIRED/);
});

test('skill maintenance merges identical executable graphs and retires unused old candidates without publishing',t=>{
  const {runtime:r}=setup(t);r.knowledge.proposeSkill(document);r.knowledge.proposeSkill({...document,evidenceRefs:['other']});
  const old=r.knowledge.proposeSkill({...document,goal:'unused'});r.store.db.prepare('UPDATE skill_versions SET created_at=? WHERE skill_id=?').run('2000-01-01',old.id);
  const result=r.knowledge.maintainSkills();assert.equal(result.merged,1);assert.equal(result.retired,1);
  assert.equal(r.knowledge.listSkills().filter(row=>row.status==='published').length,0);
});

test('a normal approval wait does not withdraw a published sensitive skill or count as a quality failure',async t=>{
  const {runtime:r}=setup(t),skill=r.knowledge.proposeSkill({...document,steps:[{...document.steps[0]!,risk:'sensitive_write'}]});
  await r.knowledge.evaluate(skill.id,1,['one','two','three'],async()=>true);r.knowledge.publish(skill.id,1);
  const active=task(r);await assert.rejects(r.skills.run(active.id,skill.id,1),/APPROVAL_REQUIRED/);
  assert.equal(r.knowledge.skill(skill.id,1).status,'published');assert.equal(r.knowledge.skillStats(skill.id,1).failures,0);
  assert.equal(r.tasks.get(active.id).status,'waiting_approval');
});

test('external capabilities reject insecure endpoints, literal credentials and unknown configuration fields',t=>{
  const {dir}=setup(t);
  assert.throws(()=>new Runtime({dataDir:join(dir,'bad'),sync:{namespace:'x',keyEnv:'LITERAL KEY',endpoint:'https://example.invalid'}}),/INVALID_SYNC_CONFIG/);
  assert.throws(()=>new Runtime({dataDir:join(dir,'bad'),telemetry:{endpoint:'http://example.invalid'}}),/INSECURE_ENDPOINT/);
  assert.throws(()=>new Runtime({dataDir:join(dir,'bad'),models:{enabled:true,unknown:true} as never}),/INVALID_MODEL_EXECUTION_CONFIG/);
  assert.throws(()=>new Runtime({dataDir:join(dir,'bad'),audit:{maxBytes:1}}),/INVALID_AUDIT_CONFIG/);
});

test('a broken scoped token meter degrades to bounded context without dropping mandatory task constraints',async t=>{
  const {runtime:r}=setup(t);const active=task(r);let hook!:(...args:unknown[])=>unknown;
  mountContext({on(_event:string,listener:(...args:unknown[])=>unknown){hook=listener;return()=>{};}} as HostContext,r);
  const agent={session:{id:active.session_id},options:{provider:'fixture',model:'cheap'},ctx:{get:()=>({measure(){throw Error('fixture meter unavailable');},estimateMessage(){throw Error('fixture estimator unavailable');}})}};
  const result=await hook({agent},()=>Promise.resolve({kind:'enter',messages:[]})) as {messages:{content:{text:string}[]}[]};
  const context=JSON.parse(result.messages[0]!.content[0]!.text);assert.equal(context.L1.goal,active.goal);assert.ok(context.L1.constraints.length);
  assert.equal(r.store.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE type='ime.context.meter_unavailable'").get()?.n,1);
});

test('unloading during a downstream pre-step does not read the closed database',async t=>{
  const {runtime:r}=setup(t);let hook!:(...args:unknown[])=>unknown;
  const detach=mountContext({on(_event:string,listener:(...args:unknown[])=>unknown){hook=listener;return()=>{};}} as HostContext,r);
  let release!:(value:unknown)=>void;const gate=new Promise(resolve=>release=resolve);
  const pending=hook({agent:{session:{id:'session'}}},()=>gate);
  detach();await r.close();const downstream={kind:'enter',messages:[]};release(downstream);
  assert.equal(await pending,downstream);
});

test('task pause cancels an in-flight read-only observation before a checkpoint can be written',async t=>{
  const {runtime:r,provider}=setup(t);const active=task(r);
  let started!:()=>void;const entered=new Promise<void>(resolve=>started=resolve);
  provider.observe=async(_app,signal)=>{started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  const pending=r.observe(active.id);await entered;r.pause(active.id);
  await assert.rejects(pending,/STOPPED/);assert.equal(r.tasks.latest(active.id),undefined);
});

test('budget predictions use settled successes and automatic allocation stays below the configured ceiling',t=>{
  const {runtime:r}=setup(t,{adaptiveTaskBudget:true,taskDefaultLimit:'1000'});
  for(let i=0;i<5;i++){const active=task(r);const id=r.costs.reserve(active.id,'forecast-'+i,r.costs.quote(price,{inputUpperBound:20,maxOutput:10,toolAllowance:'0'}));r.costs.settle(id,{inputTokens:10,cachedInputTokens:0,outputTokens:10});r.tasks.transition(active.id,'succeeded');}
  assert.equal(r.costs.forecast('mock-app','USD').samples,5);assert.equal(r.taskLimit('mock-app'), '25');
  assert.equal(r.taskLimit('unknown'),'1000');assert.equal(r.costs.forecast('mock-app','CNY').samples,0);
});
