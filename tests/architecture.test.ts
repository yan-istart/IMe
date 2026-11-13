import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Runtime } from '../src/core/runtime.js';
import { MockDesktop } from '../src/adapters/mock.js';
import { mountContext } from '../src/adapters/host-context.js';
import type { HostContext } from '../src/adapters/dsh.js';
import type { SkillDocument } from '../src/core/knowledge.js';
import { VisionPipeline } from '../src/core/vision-pipeline.js';
import { Dashboard } from '../src/web/dashboard.js';
import { bindSkill } from '../src/core/skill-parameters.js';

const document: SkillDocument = { goal:'打开任务面板',app:'mock-app',fingerprint:'mock-app:v1:zh:1280x720',precondition:'home',
  steps:[{kind:'click',target:'task-panel',risk:'reversible_write',expectedState:'task-panel',timeoutMs:1000}],evidenceRefs:['fixture://verified'] };

function setup(t: TestContext) {
  const dir=mkdtempSync(join(tmpdir(),'ime-architecture-'));
  const provider=new MockDesktop();
  const config={dataDir:dir,allowApps:['mock-app'],desktopLeasePath:join(dir,'desktop.lock'),
    evaluation:{app:'mock-app',cases:['baseline','restart','fresh-window']}};
  const runtime=new Runtime(config,provider);
  t.after(async()=>{await runtime.close();rmSync(dir,{recursive:true,force:true});});
  return {runtime,provider,dir,config};
}
function task(runtime:Runtime,session='session') {
  const created=runtime.tasks.create(session,document.goal,document.app,'1000');
  runtime.tasks.transition(created.id,'ready');runtime.tasks.transition(created.id,'running');return created;
}
async function trajectory(runtime:Runtime,provider:MockDesktop,target:string,session:string) {
  provider.state='home';const created=task(runtime,session);
  await runtime.desktop!.run(created.id,{...document.steps[0]!,id:randomUUID(),target,app:document.app,expectedFingerprint:document.fingerprint},o=>o.state==='task-panel');
  runtime.tasks.transition(created.id,'succeeded');return created.id;
}
async function published(runtime:Runtime) {
  const skill=runtime.knowledge.proposeSkill(document);
  await runtime.evaluateSkill(skill.id,skill.version);runtime.knowledge.publish(skill.id,skill.version);return skill;
}

test('distillation creates a finite parameter from independent verified trajectories and evaluates every variant',async t=>{
  const {runtime:r,provider}=setup(t);
  provider.execute=async(action,signal)=>{signal.throwIfAborted();provider.calls.push(action.target);provider.state='task-panel';};
  const ids=[await trajectory(r,provider,'panel-a','a'),await trajectory(r,provider,'panel-b','b'),await trajectory(r,provider,'panel-a','c')];
  const skill=r.distillSkill(ids),candidate=r.knowledge.skill(skill.id,skill.version);
  assert.deepEqual(candidate.document.parameters,{target1:{values:['panel-a','panel-b']}});
  assert.equal(candidate.document.steps[0]?.targetParameter,'target1');
  assert.throws(()=>r.knowledge.publishReviewed(skill.id,skill.version,'review'),/PARAMETER_EVALUATION_REQUIRED/);
  const evaluation=await r.evaluateSkill(skill.id,skill.version);
  assert.equal(evaluation.passed,true);assert.equal(evaluation.results.length,6);
  r.knowledge.publish(skill.id,skill.version);
  provider.state='home';const active=task(r,'reuse');
  await r.skills.run(active.id,skill.id,skill.version,undefined,{target1:'panel-b'});
  assert.equal(provider.calls.at(-1),'panel-b');
  const callCount=provider.calls.length;
  await assert.rejects(r.skills.run(active.id,skill.id,skill.version,undefined,{target1:'unseen-target'}),/INVALID_SKILL_BINDINGS/);
  assert.equal(provider.calls.length,callCount);assert.equal(r.knowledge.skill(skill.id,skill.version).status,'published');
});

test('distillation rejects duplicate, unrelated, uncertain and structurally different trajectories',async t=>{
  const {runtime:r,provider}=setup(t);
  provider.execute=async()=>{provider.state='task-panel';};
  const ids=[await trajectory(r,provider,'panel-a','a'),await trajectory(r,provider,'panel-b','b'),await trajectory(r,provider,'panel-a','c')];
  assert.throws(()=>r.distillSkill([ids[0]!,ids[0]!,ids[1]!]),/INDEPENDENT_TRAJECTORIES_REQUIRED/);
  r.store.db.prepare("UPDATE tasks SET goal='另一个目标' WHERE id=?").run(ids[2]!);
  assert.throws(()=>r.distillSkill(ids),/TRAJECTORY_GOAL_MISMATCH/);
  r.store.db.prepare('UPDATE tasks SET goal=? WHERE id=?').run(document.goal,ids[2]!);
  const row=r.store.db.prepare('SELECT id,data FROM actions WHERE task_id=?').get(ids[2]!)!;
  const action=JSON.parse(String(row.data));action.verifiedState='other-panel';
  r.store.db.prepare('UPDATE actions SET data=? WHERE id=?').run(JSON.stringify(action),String(row.id));
  assert.throws(()=>r.distillSkill(ids),/TRAJECTORY_STRUCTURE_MISMATCH/);
  r.store.db.prepare("UPDATE actions SET state='uncertain' WHERE id=?").run(String(row.id));
  assert.throws(()=>r.distillSkill(ids),/VERIFIED_EVIDENCE_REQUIRED/);
});

test('parameter schemas reject unknown references and excessive combinations before creating a version',t=>{
  const {runtime:r}=setup(t);
  assert.throws(()=>r.knowledge.proposeSkill({...document,steps:[{...document.steps[0]!,targetParameter:'missing'}]}),/INVALID_SKILL_PARAMETER_TARGET/);
  const parameters={one:{values:['a','b','c','d','e']},two:{values:['a','b','c','d','e']}};
  assert.throws(()=>r.knowledge.proposeSkill({...document,parameters,steps:[{...document.steps[0]!,target:'a',targetParameter:'one'},{...document.steps[0]!,target:'a',targetParameter:'two'}]}),/TOO_MANY_SKILL_VARIANTS/);
  const shared={...document,parameters:{target:{values:['task-panel','alternate']}},steps:[{...document.steps[0]!,targetParameter:'target'},
    {...document.steps[0]!,target:'alternate',targetParameter:'target'}]};
  assert.deepEqual(bindSkill(shared).steps.map(step=>step.target),['task-panel','task-panel'],'the default must be one evaluated binding, not a mixture of variant values');
});

test('one failing parameter variant prevents publication even when the default target succeeds',async t=>{
  const {runtime:r}=setup(t);
  const skill=r.knowledge.proposeSkill({...document,parameters:{target:{values:['task-panel','broken']}},
    steps:[{...document.steps[0]!,targetParameter:'target'}]});
  const evaluation=await r.evaluateSkill(skill.id,skill.version);
  assert.equal(evaluation.results.length,6);assert.equal(evaluation.passed,false);
  assert.throws(()=>r.knowledge.publish(skill.id,skill.version),/SKILL_NOT_VERIFIED/);
});

test('A/B replays reset cases independently, alternate order, persist evidence and leave publication to the user',async t=>{
  const {runtime:r,provider,config}=setup(t);
  const stable=await published(r);
  const candidate=r.knowledge.proposeSkill({...document,steps:[{...document.steps[0]!,timeoutMs:2000}]},stable.id);
  const resets:string[]=[];
  provider.reset=async(_app,caseId)=>{provider.state='home';resets.push(caseId);};
  const report=await r.compareSkills(stable.id,stable.version,candidate.version);
  assert.equal(report.passed,true);assert.equal(report.pairs.length,3);
  assert.deepEqual(resets,['baseline','baseline','restart','restart','fresh-window','fresh-window']);
  assert.equal(r.knowledge.skill(stable.id,stable.version).status,'published');
  assert.equal(r.knowledge.skill(stable.id,candidate.version).status,'verified');
  assert.equal(r.status().skillComparisons.length,1);
  await r.close();
  const restarted=new Runtime(config,provider);
  try {assert.equal(restarted.status().skillComparisons.length,1);assert.equal(restarted.knowledge.skill(stable.id,stable.version).status,'published');}
  finally {await restarted.close();}
});

test('a failing A/B candidate cannot publish and the stable version remains available',async t=>{
  const {runtime:r}=setup(t);const stable=await published(r);
  const candidate=r.knowledge.proposeSkill({...document,steps:[{...document.steps[0]!,target:'broken'}]},stable.id);
  const report=await r.compareSkills(stable.id,stable.version,candidate.version);
  assert.equal(report.passed,false);assert.equal(report.baselineSuccessRate,1);assert.equal(report.candidateSuccessRate,0);
  assert.throws(()=>r.knowledge.publish(stable.id,candidate.version),/SKILL_NOT_VERIFIED/);
  assert.equal(r.knowledge.skill(stable.id,stable.version).status,'published');
});

test('independent evaluations cannot interleave resets across two candidates',async t=>{
  const {runtime:r,provider}=setup(t);const one=r.knowledge.proposeSkill(document),two=r.knowledge.proposeSkill(document);
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  const reset=provider.reset.bind(provider);provider.reset=async(...args)=>{await gate;await reset(...args);};
  const running=r.evaluateSkill(one.id,1);
  await assert.rejects(r.evaluateSkill(two.id,1),/EVALUATION_IN_PROGRESS/);
  release();assert.equal((await running).passed,true);
});

test('rolling regression monitoring withdraws a degraded version and restores its stable predecessor',async t=>{
  const {runtime:r}=setup(t);const stable=await published(r);
  const candidate=r.knowledge.proposeSkill({...document,goal:'新的任务目标'},stable.id);
  await r.evaluateSkill(candidate.id,candidate.version);r.knowledge.publish(candidate.id,candidate.version);
  for(let i=0;i<5;i++)r.knowledge.recordObservation({skillId:candidate.id,version:candidate.version,taskId:'observed-'+i,sessionId:'session-'+i,outcome:i<3?'success':'failure',evidenceRefs:[]});
  assert.equal(r.knowledge.skill(candidate.id,candidate.version).status,'rolled_back');
  assert.equal(r.knowledge.skill(stable.id,stable.version).status,'published');
  assert.equal(r.store.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE type='ime.skill.regression'").get()?.n,1);
});

test('ordinary host sessions recall bounded L3/L4 using only their own allowed app hint',async t=>{
  const {runtime:r}=setup(t);const stable=await published(r);
  r.knowledge.propose({kind:'procedure',app:document.app,content:'任务面板操作参考',trust:'user',sourceEventIds:[]});
  let hook!:(...args:unknown[])=>unknown;
  const ctx={on(_event:string,listener:(...args:unknown[])=>unknown){hook=listener;return()=>{};}} as HostContext;
  mountContext(ctx,r);
  r.experience.capture('host',{name:'cua_driver_native__click',arguments:{app:document.app},result:{isError:false}});
  const next=()=>Promise.resolve({kind:'enter',messages:[]});
  const result=await hook({agent:{session:{id:'host'}}},next) as {messages:{content:{text:string}[]}[]};
  const context=JSON.parse(result.messages[0]!.content[0]!.text);
  assert.equal(context.L4[0].id,stable.id);assert.equal(context.L4[0].requiresObservation,true);
  assert.equal(context.L3.length,1);
  const unrelated=await hook({agent:{session:{id:'other'}}},next) as {messages:unknown[]};assert.equal(unrelated.messages.length,0);
  r.allowApps.splice(0);
  const denied=await hook({agent:{session:{id:'host'}}},next) as {messages:unknown[]};assert.equal(denied.messages.length,0);
});

test('a completed host turn with failed tool results is retained as failure evidence',t=>{
  const {runtime:r}=setup(t);
  r.experience.capture('partial',{name:'cua_driver_native__click',arguments:{app:document.app},result:{isError:true}});
  r.experience.finalize('partial',{type:'turn/end',data:{reason:'completed'}});
  assert.equal(r.experience.recent()[0]?.outcome,'failure');
  assert.equal(r.knowledge.listMemories()[0]?.kind,'failure');
  assert.match(String(r.knowledge.listMemories()[0]?.content),/1 次失败/);
});

test('dependency queue respects order, session isolation, cycles, failed dependencies and human pause',async t=>{
  const {runtime:r}=setup(t);
  const a=r.tasks.create('queue','first','mock-app','1');r.tasks.transition(a.id,'ready');
  const b=r.tasks.create('queue','second','mock-app','1','USD',[a.id]);r.tasks.transition(b.id,'ready');
  assert.throws(()=>r.tasks.depend(a.id,b.id),/TASK_DEPENDENCY_CYCLE/);
  assert.throws(()=>r.tasks.transition(b.id,'running'),/TASK_DEPENDENCIES_PENDING/);
  const foreign=r.tasks.create('other','foreign','mock-app','1');
  assert.throws(()=>r.tasks.depend(b.id,foreign.id),/TASK_SESSION_DENIED/);
  assert.equal(r.nextTask('queue')?.id,a.id);assert.equal(r.nextTask('queue'),null);
  r.pause(a.id);assert.equal(r.nextTask('queue'),null);
  await r.tasks.resume(a.id,async()=>true);r.tasks.transition(a.id,'succeeded');
  r.executionPaused=true;assert.throws(()=>r.nextTask('queue'),/STOPPED/);r.executionPaused=false;
  assert.equal(r.nextTask('queue')?.id,b.id);
  r.tasks.transition(b.id,'failed');
  const c=r.tasks.create('queue','third','mock-app','1','USD',[b.id]);r.tasks.transition(c.id,'ready');
  assert.equal(r.nextTask('queue'),null);assert.equal(r.tasks.blockers(c.id)[0]?.status,'failed');
});

test('schema migration preserves pending dependencies and marks interrupted validation as failed on restart',async t=>{
  const {runtime:r,config,provider}=setup(t);
  const a=r.tasks.create('q','a','mock-app','1');const b=r.tasks.create('q','b','mock-app','1','USD',[a.id]);
  const skill=r.knowledge.proposeSkill(document);
  r.store.db.prepare('INSERT INTO skill_evaluations VALUES(?,?,?,?,?)').run('interrupted',skill.id,1,JSON.stringify({state:'running',hash:r.knowledge.skill(skill.id,1).hash}),new Date().toISOString());
  await r.close();
  const restarted=new Runtime(config,provider);
  try {
    assert.equal(restarted.tasks.blockers(b.id)[0]?.id,a.id);
    const report=JSON.parse(String(restarted.store.db.prepare("SELECT report FROM skill_evaluations WHERE id='interrupted'").get()!.report));
    assert.equal(report.state,'interrupted');assert.equal(report.passed,false);
    assert.equal((await restarted.evaluateSkill(skill.id,1)).passed,true);
  } finally {await restarted.close();}
});

test('live JSONL includes only committed events and handles rollback sequence reuse without duplicates',async t=>{
  const {runtime:r,dir}=setup(t);
  r.store.event('ime.test.committed',{});
  assert.throws(()=>r.store.transaction(()=>{r.store.event('ime.test.rolled_back',{});r.store.flushAudit();throw Error('rollback');}));
  r.store.event('ime.test.after',{});
  await new Promise<void>(resolve=>queueMicrotask(resolve));
  const lines=readFileSync(join(dir,'audit.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(lines.some(line=>line.type==='ime.test.committed'));assert.ok(lines.some(line=>line.type==='ime.test.after'));
  assert.ok(!lines.some(line=>line.type==='ime.test.rolled_back'));
  r.store.flushAudit();assert.equal(readFileSync(join(dir,'audit.jsonl'),'utf8').trim().split('\n').length,lines.length);
});

test('visual summaries retain frame order and use configured masking even without per-call overrides',t=>{
  const {dir}=setup(t);
  const vision=new VisionPipeline(join(dir,'visual'),{threshold:0.1,maxKeyframesPerMinute:12,retentionMs:1000,storeFrames:true,redact:[{x:0,y:0,width:1,height:1}]});
  const first={app:'mock-app',width:2,height:1,pixels:new Uint8Array([255,0]),timestamp:100};
  vision.process(first,{reason:'transition',actionId:'first'});
  vision.process({...first,timestamp:200,pixels:new Uint8Array([0,255])},{reason:'verify',actionId:'second'});
  const summaries=vision.summarize('mock-app');
  assert.deepEqual(summaries.map(frame=>frame.sequence),[1,2]);assert.deepEqual(summaries.map(frame=>frame.actionId),['first','second']);
  assert.equal(readFileSync(join(dir,'visual',summaries[0]!.evidenceRef)).at(-2),0);
  assert.ok(summaries.every(frame=>!('pixels' in frame)));
  vision.process({...first,timestamp:2000},{reason:'verify'});assert.equal(vision.summarize('mock-app').length,1);
  vision.cleanup(4000);assert.equal(vision.summarize('mock-app').length,0);
});

test('new management commands are authenticated and comparisons are included in dashboard state',async t=>{
  const {runtime:r}=setup(t);const stable=await published(r);
  const candidate=r.knowledge.proposeSkill({...document,goal:'修订目标'},stable.id);
  const dashboard=new Dashboard(r,undefined,{});await dashboard.ready;t.after(()=>dashboard.close());
  const body=JSON.stringify({operation:'skill_compare',id:stable.id,baselineVersion:stable.version,version:candidate.version});
  assert.equal((await fetch(dashboard.url+'api/command',{method:'POST',headers:{'Content-Type':'application/json'},body})).status,401);
  const headers={Authorization:'Bearer '+dashboard.token,'Content-Type':'application/json'};
  assert.equal((await fetch(dashboard.url+'api/command',{method:'POST',headers,body})).status,200);
  const state=await (await fetch(dashboard.url+'api/state',{headers})).json() as {skillComparisons:unknown[]};assert.equal(state.skillComparisons.length,1);
});
