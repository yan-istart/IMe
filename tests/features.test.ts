import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Runtime} from '../src/core/runtime.js';
import {MockDesktop} from '../src/adapters/mock.js';
import type {SkillDocument} from '../src/core/knowledge.js';
import {DesktopLease} from '../src/core/lease.js';
import {Dashboard} from '../src/web/dashboard.js';
import {DeepSeekBalance} from '../src/adapters/balance.js';
import {ToolDesktopPort} from '../src/adapters/desktop-tools.js';
import {mount,type HostContext,type ToolDefinition} from '../src/adapters/dsh.js';
const price={version:'fixture',currency:'USD',inputPerMillion:'1000000',cachedPerMillion:'100000',outputPerMillion:'2000000'};
const req={inputUpperBound:100,maxOutput:50,toolAllowance:'0'};
const document:SkillDocument={goal:'打开任务面板',app:'mock-app',fingerprint:'mock-app:v1:zh:1280x720',precondition:'home',steps:[{kind:'click',target:'task-panel',risk:'reversible_write',expectedState:'task-panel',timeoutMs:1000}],evidenceRefs:['fixture://independent']};
function setup(t:TestContext) {
 const dir=mkdtempSync(join(tmpdir(),'ime-feature-'));const provider=new MockDesktop();
 const r=new Runtime({dataDir:dir,allowApps:['mock-app'],desktopLeasePath:join(dir,'desktop.lock'),evaluation:{app:'mock-app',cases:['baseline','restart','fresh-window']}},provider);
 t.after(async()=>{await r.close();rmSync(dir,{recursive:true,force:true});});return {r,provider,dir};
}
function task(r:Runtime,limit='1000'){const task=r.tasks.create('session','打开任务面板','mock-app',limit);r.tasks.transition(task.id,'ready');r.tasks.transition(task.id,'running');return task;}
function action(){return {id:randomUUID(),app:'mock-app',kind:'click' as const,target:'task-panel',risk:'reversible_write' as const,expectedFingerprint:document.fingerprint,timeoutMs:1000};}
async function publish(r:Runtime){const s=r.knowledge.proposeSkill(document);await r.evaluateSkill(s.id,s.version);r.knowledge.publish(s.id,s.version);return s;}

test('memory candidate cannot enter retrieval until confirmed; FTS handles Chinese and operators safely',t=>{
 const {r}=setup(t);const id=r.knowledge.propose({kind:'fact',app:'mock-app',content:'任务面板 located in task panel',trust:'model_inferred',sourceEventIds:[]});
 assert.equal(r.knowledge.retrieve('面板','mock-app').length,0);r.knowledge.approve(id);
 assert.equal(r.knowledge.retrieve('面板','mock-app')[0]?.id,id);assert.equal(r.knowledge.retrieve('task','other').length,0);
 assert.doesNotThrow(()=>r.knowledge.retrieve('" OR NEAR(*)','mock-app'));
 r.knowledge.archive(id);assert.equal(r.knowledge.retrieve('task','mock-app').length,0);
});
test('memory trust requires verified action evidence; expired records and deleted FTS entries are excluded',t=>{
 const {r}=setup(t);r.store.event('ime.host.mounted',{});const evidence=String(r.store.db.prepare('SELECT id FROM audit_events LIMIT 1').get()!.id);
 assert.throws(()=>r.knowledge.propose({kind:'fact',content:'secret',app:'mock-app',trust:'tool_verified',sourceEventIds:[evidence]}),/VERIFIED_EVIDENCE/);
 const id=r.knowledge.propose({kind:'fact',content:'task panel',app:'mock-app',trust:'user',sourceEventIds:[]});
 r.store.db.prepare('UPDATE memories SET expires_at=? WHERE id=?').run('2000-01-01',id);assert.equal(r.knowledge.retrieve('task','mock-app').length,0);
 r.knowledge.deleteMemory(id);assert.equal(r.store.db.prepare('SELECT COUNT(*) AS n FROM memory_fts').get()?.n,0);
});
test('T-02 independent skill evaluation, manual publication, signature and restart reuse',async t=>{
 const {r,dir}=setup(t);const s=await publish(r);
 assert.equal(r.knowledge.match('mock-app',document.fingerprint).length,1);
 assert.equal(readdirSync(join(dir,'skills')).length,1);
 await r.close();const reopened=new Runtime({dataDir:dir,allowApps:['mock-app'],desktopLeasePath:join(dir,'desktop.lock')},new MockDesktop());
 try{const active=task(reopened);await reopened.skills.run(active.id,s.id,s.version);assert.equal(reopened.tasks.latest(active.id)?.cursor,1);}finally{await reopened.close();}
});
test('T-10 failing evaluations cannot publish; versions are immutable and rollback restores prior version',async t=>{
 const {r}=setup(t);const first=await publish(r);const second=r.knowledge.proposeSkill({...document,goal:'new goal'},first.id);
 await r.knowledge.evaluate(second.id,second.version,['a','b','c'],async(_s,id)=>id!=='c');
 assert.throws(()=>r.knowledge.publish(second.id,second.version),/SKILL_NOT_VERIFIED/);
 await r.evaluateSkill(second.id,second.version);r.knowledge.publish(second.id,second.version);r.knowledge.rollback(second.id,second.version);
 assert.equal(r.knowledge.skill(first.id,first.version).status,'published');
 r.store.db.prepare('UPDATE skill_versions SET document=? WHERE skill_id=? AND version=?').run(JSON.stringify({...document,goal:'tamper'}),first.id,first.version);
 assert.throws(()=>r.knowledge.skill(first.id,first.version),/SIGNATURE_MISMATCH/);
});
test('T-03 changed app layout stops skill before any replay and withdraws published version',async t=>{
 const {r,provider}=setup(t);const s=await publish(r);provider.calls=[];
 provider.observe=async()=>({fingerprint:'changed-layout',state:'home',evidenceRef:'fixture://changed'});
 await assert.rejects(r.skills.run(task(r).id,s.id,s.version),/PRECONDITION/);assert.equal(provider.calls.length,0);assert.equal(r.knowledge.skill(s.id,s.version).status,'rolled_back');
});
test('sensitive approval binds exact action and is consumed only once; uncertain outcome requires reconciliation',async t=>{
 const {r}=setup(t),active=task(r),a={...action(),risk:'irreversible' as const};
 await assert.rejects(r.desktop!.run(active.id,a,()=>true),/APPROVAL_REQUIRED/);
 const pending=r.store.db.prepare('SELECT id FROM approvals').get()!;r.permissions.decide(String(pending.id),true);
 r.tasks.transition(active.id,'paused');await r.tasks.resume(active.id,async()=>true);
 await assert.rejects(r.desktop!.run(active.id,{...a,target:'other'},()=>true),/APPROVAL_REQUIRED/);
 r.tasks.transition(active.id,'paused');await r.tasks.resume(active.id,async()=>true);
 await r.desktop!.run(active.id,a,()=>true);
 assert.equal(r.permissions.approved(active.id,a),false);
});
test('uncertain action reconciliation preserves recovery barrier until human evidence is supplied',async t=>{
 const {r}=setup(t),active=task(r),a=action();await assert.rejects(r.desktop!.run(active.id,a,()=>false),/VERIFICATION_FAILED/);
 assert.throws(()=>r.tasks.reconcile(active.id,a.id,true,''),/EVIDENCE_REQUIRED/);
 r.tasks.reconcile(active.id,a.id,true,'operator checked current panel');await r.tasks.resume(active.id,async()=>true);
 assert.equal(r.tasks.get(active.id).status,'running');await assert.rejects(r.desktop!.run(active.id,a,()=>true),/ALREADY_ATTEMPTED/);
});
test('cross-runtime desktop lock cannot expire during active work',t=>{
 const {dir}=setup(t);const one=new DesktopLease(join(dir,'global.lock')),two=new DesktopLease(join(dir,'global.lock'));one.acquire();assert.throws(()=>two.acquire(),/DESKTOP_BUSY/);one.release();two.acquire();two.release();
});
test('aggregate caps atomically stop another task and unknown settlement can be reconciled',async t=>{
 const {r}=setup(t);r.costs.setLimit('account','*','USD','200');const one=task(r),two=task(r);
 const id=r.costs.reserve(one.id,'one',r.costs.quote(price,req));assert.throws(()=>r.costs.reserve(two.id,'two',r.costs.quote(price,req)),/BUDGET_DENIED/);
 r.costs.settle(id);assert.equal(r.store.db.prepare("SELECT spent FROM budget_caps WHERE scope='account'").get()?.spent,200);
 r.costs.reconcile(id,{inputTokens:80,cachedInputTokens:20,outputTokens:10});
 assert.equal(r.store.db.prepare("SELECT spent FROM budget_caps WHERE scope='account'").get()?.spent,82);
 assert.throws(()=>r.costs.setLimit('account','*','USD','1'),/BELOW_COMMITMENTS/);
});
test('session/day caps are separate currencies and survive restart without releasing reservations',async t=>{
 const {r,dir}=setup(t);r.costs.setLimit('session','session','USD','200');r.costs.setLimit('day','*','USD','200');const active=task(r);
 r.costs.reserve(active.id,'pending',r.costs.quote(price,req));await r.close();const reopened=new Runtime({dataDir:dir});
 try{assert.equal(reopened.store.db.prepare('SELECT reserved FROM budgets WHERE task_id=?').get(active.id)?.reserved,200);assert.equal(reopened.store.db.prepare("SELECT COUNT(*) AS n FROM reservation_caps").get()?.n,2);}finally{await reopened.close();}
});
test('T-08 L1 constraints survive trimming and compaction that loses invariants is rejected',async t=>{
 const {r}=setup(t);for(let i=0;i<5;i++)r.knowledge.propose({kind:'fact',content:'任务'.repeat(1000),app:'mock-app',trust:'user',sourceEventIds:[]});
 const state={goal:'任务',constraints:['不得发送'],permissions:['应用白名单'],checkpointId:'checkpoint-1',fingerprint:document.fingerprint,app:'mock-app'};
 const context=r.context.build(state);assert.ok(context.length<=8000);assert.ok(context.includes('不得发送'));assert.ok(context.includes('引用数据'));
 await assert.rejects(r.context.compact(state,800,1000,async()=>({summary:'forgot everything'})),/INVARIANT/);
 assert.equal(await r.context.compact(state,1,1000,async()=>{throw Error('should not call');}),null);
});
test('router honors vision/tools/context/currency/privacy and can use a local result',t=>{
 const {r}=setup(t);const router=new (r.router.constructor as typeof import('../src/core/router.js').ModelRouter)([{provider:'mock',model:'cheap',tier:'cheap',vision:false,tools:true,contextLimit:1000,maxOutput:50,privacyRegion:'local',price}]);
 assert.equal(router.select({tokens:100,output:20,vision:false,tools:true,currency:'USD',remaining:1000,failures:0}).kind,'model');
 assert.throws(()=>router.select({tokens:100,output:20,vision:true,tools:true,currency:'USD',remaining:1000,failures:0}),/NO_ELIGIBLE/);
 assert.equal(router.select({tokens:0,output:0,vision:false,tools:false,currency:'USD',remaining:0,failures:0,localResult:'known'}).kind,'local');
});
test('review emits proposals only and enforces count and separate 10% budget',async t=>{
 const {r}=setup(t),active=task(r);r.tasks.transition(active.id,'succeeded');
 await assert.rejects(r.review.review(active.id,async()=>{throw Error('not called');},{price,request:req}),/REVIEW_BUDGET_DENIED/);
 const report=await r.review.review(active.id);assert.equal(report.risk,'review_only');await assert.rejects(r.review.review(active.id),/REVIEW_LIMIT/);
 assert.equal(r.knowledge.listSkills().length,0);
});
test('vision masks sensitive regions before filtering/storage and applies TTL and forced-frame rules',t=>{
 const {r,dir}=setup(t);const pipeline=new (r.vision.constructor as typeof import('../src/core/vision-pipeline.js').VisionPipeline)(join(dir,'images'),{threshold:0.1,maxKeyframesPerMinute:1,retentionMs:0,storeFrames:true});
 const frame={app:'mock',width:2,height:2,pixels:new Uint8Array([255,255,255,255]),timestamp:100};
 const result=pipeline.process(frame,{redact:[{x:0,y:0,width:1,height:1}]});assert.equal(result.selected,true);
 assert.ok('evidenceRef' in result);const file=readFileSync(join(dir,'images',result.evidenceRef));assert.equal(file[file.length-4],0);
 assert.equal(pipeline.process({...frame,timestamp:200}).selected,false);assert.equal(pipeline.process({...frame,timestamp:300},{reason:'verify'}).selected,true);
 assert.equal(pipeline.cleanup(Date.now()+1000),2);
});
test('balance adapter preserves unavailable/actual distinction without exposing credentials',async()=>{
 assert.equal((await new DeepSeekBalance(()=>undefined).get()).state,'unavailable');
 let calls=0;const balance=new DeepSeekBalance(()=> 'fixture-key',async()=>{calls++;return new Response(JSON.stringify({is_available:true,balance_infos:[{currency:'USD',total_balance:'2.00'}]}));});
 const result=await balance.get();await balance.get();assert.equal(result.state,'actual');assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes('fixture-key'));
});
test('configured desktop catalog overrides model risk and never forwards raw model arguments',async()=>{
 const calls:unknown[]=[];const adapter=new ToolDesktopPort({get:()=>({}),execute:async call=>{calls.push(call.arguments);return {isError:false,value:{fingerprint:'fixed',state:'home'}};}},()=> 'fixture',{
 provider:'fixture',toolPrefix:'fixture_',observeTool:'fixture_observe',executeTools:{click:'fixture_click',input:'fixture_type',scroll:'fixture_scroll'},targets:{mock:{observeArgs:{window:1},fingerprintPath:['fingerprint'],statePath:['state'],actions:{send:{kind:'click',args:{element:'known'},risk:'irreversible',expectedState:'sent'}}}}});
 assert.equal(adapter.canonical({...action(),app:'mock',target:'send',risk:'read_only'}).risk,'irreversible');
 await adapter.execute({...action(),app:'mock',target:'send'},new AbortController().signal);assert.deepEqual(calls,[{element:'known'}]);
});
test('dashboard auth/origin checks, memory management, export, XSS-safe document and lifecycle',async t=>{
 const {r}=setup(t);const dashboard=new Dashboard(r,undefined,{});await dashboard.ready;t.after(()=>dashboard.close());
 assert.equal((await fetch(dashboard.url+'api/state')).status,401);
 const headers={Authorization:'Bearer '+dashboard.token,'Content-Type':'application/json'};
 assert.equal((await fetch(dashboard.url+'api/command',{method:'POST',headers:{...headers,Origin:'https://untrusted.invalid'},body:'{}'})).status,403);
 const command=async(body:unknown)=>{const response=await fetch(dashboard.url+'api/command',{method:'POST',headers,body:JSON.stringify(body)});return {status:response.status,value:await response.json()};};
 const created=await command({operation:'memory_create',app:'mock-app',content:'<img src=x onerror=alert(1)> task panel'});assert.equal(created.status,200);
 const state=await (await fetch(dashboard.url+'api/state',{headers})).json();assert.equal(state.memories.length,1);
 const html=await (await fetch(dashboard.url)).text();assert.ok(!html.includes('innerHTML'));assert.ok(!html.includes('<img src=x'));
 assert.equal((await command({operation:'skill_publish',id:'nonexistent',version:1})).status,400);
 const exportResponse=await fetch(dashboard.url+'api/export?kind=memory',{headers});assert.equal(exportResponse.status,200);
});
test('T-11 model tools cannot grant approvals, raise budget, publish skills or cross sessions',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ime-tools-'));const tools=new Map<string,ToolDefinition>();
 const ctx:HostContext={get:()=>undefined,effect:()=>undefined,on:()=>()=>{},tools:{register(tool){tools.set(tool.name,tool);return()=>{tools.delete(tool.name);};}}};
 const m=mount(ctx,{dataDir:dir,allowApps:['mock-app'],taskDefaultLimit:'50',dashboard:{enabled:false}});t.after(async()=>{await m.dispose();rmSync(dir,{recursive:true,force:true});});
 assert.ok(!tools.has('ime_approve'));assert.ok(!tools.has('ime_skill_publish'));
 const created=await tools.get('ime_task_create')!.execute({goal:'test',app:'mock-app',limit:'99999'},{agent:{session:{id:'actual'}}}) as {task:{id:string}};
 assert.equal(m.runtime.store.db.prepare('SELECT limit_amount FROM budgets').get()?.limit_amount,50);
 await assert.rejects(tools.get('ime_task_finish')!.execute({taskId:created.task.id},{agent:{session:{id:'other'}}}),/TASK_SESSION_DENIED/);
});
test('memory conflicts only compare the same declared subject and require explicit resolution',t=>{
 const {r}=setup(t);
 const first=r.knowledge.propose({kind:'fact',app:'mock-app',content:'任务入口 A',factKey:'task-entry',trust:'user',sourceEventIds:[]});
 const second=r.knowledge.propose({kind:'fact',app:'mock-app',content:'任务入口 B',factKey:'task-entry',trust:'user',sourceEventIds:[]});
 r.knowledge.propose({kind:'fact',app:'mock-app',content:'其他事实',factKey:'other',trust:'user',sourceEventIds:[]});
 assert.equal(r.status().memoryConflicts.length,1);r.knowledge.resolveConflict(first,second,second);
 assert.equal(r.status().memoryConflicts.length,0);assert.equal(r.knowledge.listMemories().find(m=>m.id===first)?.status,'archived');
 assert.throws(()=>r.knowledge.propose({kind:'fact',app:'mock-app',content:'sk-123456789012345678901234567890',trust:'user',sourceEventIds:[]}),/CONTAINS_SECRET/);
});
test('a skill cannot publish or begin another evaluation while validation is still running',async t=>{
 const {r}=setup(t),skill=r.knowledge.proposeSkill(document);let release!:()=>void;const wait=new Promise<void>(resolve=>release=resolve);
 const pending=r.knowledge.evaluate(skill.id,1,['first','second','third'],async()=>{await wait;return true;});
 assert.throws(()=>r.knowledge.publish(skill.id,1),/SKILL_NOT_VERIFIED/);
 await assert.rejects(r.knowledge.evaluate(skill.id,1,['a','b','c'],async()=>true),/EVALUATION_IN_PROGRESS/);
 release();await pending;r.knowledge.publish(skill.id,1);assert.equal(r.knowledge.skill(skill.id,1).status,'published');
});
test('native compaction uses the scoped host service and relies on the separate task snapshot for invariants',async t=>{
 const {r}=setup(t),active=task(r);let called=false;
 const {compactNative}=await import('../src/adapters/compaction.js');
 const ctx={get:()=>({get:(id:string)=>id==='session'?{session:{id},ctx:{get:()=>({compactNow:async()=>{called=true;return {compactionId:'test-compact',summary:[{type:'text',text:'partial summary'}]};}})}}:undefined})} as unknown as HostContext;
 const result=await compactNative(ctx,r,'session');assert.equal(called,true);assert.equal(result.invariantsReinjected,true);assert.equal(r.tasks.get(active.id).goal,'打开任务面板');
});
test('invalid config is rejected and constructor failure releases runtime lock and SQLite handle',async t=>{
 const {dir}=setup(t);const child=join(dir,'invalid');
 assert.throws(()=>new Runtime({dataDir:child,dashboard:{port:-1}}),/INVALID_DASHBOARD_PORT/);
 assert.throws(()=>new Runtime({dataDir:child,context:{maxCharacters:1}}),/INVALID_CONTEXT_CONFIG/);
 const valid=new Runtime({dataDir:child});await valid.close();
});
test('dashboard client script parses and all dynamically displayed data uses text nodes',async()=>{
 const {Script}=await import('node:vm');const {dashboardHtml}=await import('../src/web/page.js');
 const script=dashboardHtml.match(/<script>([\s\S]*)<\/script>/)![1]!;assert.doesNotThrow(()=>new Script(script));
 assert.ok(dashboardHtml.includes('[hidden]{display:none!important}'));assert.ok(!script.includes('innerHTML'));
});
test('desktop observations feed redacted visual filtering and never expose raw frames to tools',async t=>{
 const {r,provider}=setup(t);provider.observe=async(app,signal)=>{signal.throwIfAborted();return {fingerprint:document.fingerprint,state:provider.state,evidenceRef:'fixture',frame:{app,width:1,height:1,pixels:new Uint8Array([255]),timestamp:Date.now()}};};
 const active=task(r);const observation=await r.desktop!.run(active.id,action(),o=>o.state==='task-panel');
 assert.ok(!('frame' in observation));assert.equal(r.store.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE type='ime.vision.frame'").get()?.n,2);
});
