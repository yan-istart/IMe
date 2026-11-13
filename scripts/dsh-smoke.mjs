/** Real-host smoke plugin: mounted only by the explicit smoke overlay, never by the shipping bundle. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
export const name = 'ime-host-smoke';
export const inject = ['tools','llm'];
export function apply(ctx, config) {
  const exit = ctx.get('appExit');
  const run = async () => {
    const checks = [];
    const wait = async (predicate) => {
      for (let i=0;i<100;i++) { if(predicate()) return; await delay(50); }
      throw new Error('HOST_SMOKE_TIMEOUT');
    };
    await wait(()=>ctx.tools.get('ime_status'));
    const logEntry=[...ctx.get('loader').entries()].find(e=>e.options.id==='session-log-deepseek');
    assert.equal(logEntry?.options.config?.enabled,false,'product-improvement session logs must be opt-in');
    checks.push('product-improvement session log upload defaults to disabled');
    const invoke = () => ctx.tools.execute({ name:'ime_status',arguments:{},callId:'ime-smoke-'+Date.now(),signal:new AbortController().signal });
    const result = await invoke();
    assert.equal(result.isError,false,JSON.stringify(result));
    assert.ok(Array.isArray(result.value.tasks));
    assert.equal(result.value.hostCapabilities.modelGateway,true);
    assert.equal(result.value.modelGateway.mode,'observe');
    checks.push('real tool dispatch + canonical output validation');
    let recoverySession='',recoveryCalls=0;
    let modelCalls=0;let scripted=false,scriptedSessionId='',agentStep=0,createdTaskId='',uiState='home';
    if(ctx.get('computerUse'))throw Error('SMOKE_DESKTOP_PROVIDER_CONFLICT');
    ctx.provide('computerUse',{providerName:'ime-smoke-desktop'});
    const fixtureTool=(name,execute)=>ctx.tools.register({name,description:'Isolated IMe test fixture',parameters:{type:'object',additionalProperties:true},output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},execute});
    fixtureTool('ime_fixture_observe',async()=>({fingerprint:'smoke:v1',state:uiState}));
    fixtureTool('ime_fixture_click',async()=>{uiState='task-panel';return {ok:true};});
    ctx.on('tools/result',(exec,result)=>{if(result.isError&&exec.name.startsWith('ime_'))console.log('IME_FIXTURE_TOOL_ERROR',exec.name,result.error?.message);if(exec.name==='ime_task_create'&&!result.isError)createdTaskId=result.value.task.id;});
    const metadata=(provider,model)=>({provider,id:model,name:model,defaultMaxTokens:50});
    ctx.llm.registerAdapter(['ime-smoke-model'],{
      providerInfo:provider=>({id:provider,name:'IMe integration fixture'}),
      providerRetryPolicy:()=>undefined,
      imageRequestPricing:()=>undefined,
      resolveModel:async(provider,model)=>metadata(provider,model),
      prepareCall:async(provider,model)=>({model:metadata(provider,model),stream:async function* (options) {
        modelCalls++;
        if(options.sessionId===recoverySession&&!options.purpose){
          recoveryCalls++;
          const block={type:'text',text:'partial fixture'};
          yield {type:'block-start',index:0,blockType:'text'};
          yield {type:'text-delta',index:0,text:block.text};
          yield {type:'block-end',index:0,block};
          yield {type:'usage',usage:{inputTokens:10,outputTokens:50}};
          yield {type:'finish',reason:{kind:'max-tokens'}};return;
        }
        if(scripted&&options.sessionId===scriptedSessionId&&!options.purpose){
          agentStep++;
          const call=agentStep===1?{name:'ime_task_create',arguments:{app:'smoke-app',goal:'打开模拟面板'}}:
            agentStep===2?{name:'ime_execute',arguments:{taskId:createdTaskId,actionId:'host-e2e-action',target:'open-panel',kind:'click',fingerprint:'smoke:v1',expectedState:'task-panel'}}:
            agentStep===3?{name:'ime_task_finish',arguments:{taskId:createdTaskId}}:null;
          const block=call?{type:'tool-call',id:'ime-e2e-'+agentStep,name:call.name,arguments:JSON.stringify(call.arguments)}:{type:'text',text:'IMe e2e passed'};
          yield {type:'block-start',index:0,blockType:block.type};
          if(call)yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};
          else yield {type:'text-delta',index:0,text:block.text};
          yield {type:'block-end',index:0,block};
          yield {type:'usage',usage:{inputTokens:60,cacheReadTokens:20,outputTokens:10}};
          yield {type:'finish',reason:{kind:call?'tool-calls':'stop'}};return;
        }
        yield {type:'usage',usage:{inputTokens:60,cacheReadTokens:20,outputTokens:10}};
        yield {type:'finish',reason:{kind:'stop'}};
      }}),
    });
    const modelCall=async()=>{
      const prepared=await ctx.llm.prepareCall({provider:'ime-smoke-model',model:'fixture',maxTokens:50});
      for await (const chunk of prepared.stream({...prepared.config,messages:[],sessionId:'smoke-model-budget'})) {}
    };
    await modelCall();
    const observed=await invoke();
    assert.equal(observed.value.modelGateway.requests[0].certainty,'unpriced');
    assert.equal(modelCalls,1);
    checks.push('real prepared LLM stream observed with disjoint cache usage');
    let contextSeen=false;ctx.on('session/event',(_session,event)=>{if(event.type==='user/message'&&event.data?.source?.kind==='ime-context')contextSeen=true;});
    scripted=true;
    scriptedSessionId='ime-e2e-'+randomUUID();
    const {agent}=await ctx.get('agents').create({sessionId:scriptedSessionId,agentOptions:{provider:'ime-smoke-model',model:'fixture',maxTokens:50}});
    let agentError;
    const stopError=ctx.on('agent/error',event=>{if(event.agent===agent)agentError=event.error;});
    agent.followup({id:randomUUID(),role:'user',content:[{type:'text',text:'打开已授权模拟面板并验证'}],source:{kind:'user'}});
    await agent.whenIdle();stopError();scripted=false;
    if(agentError)throw agentError;
    assert.equal(agentStep,4,'agent must complete all three IMe tools and final response');
    const completed=await invoke();
    assert.ok(completed.value.tasks.some(t=>t.id===createdTaskId&&t.status==='succeeded'));
    assert.ok(completed.value.skillVersions.some(s=>s.status==='candidate'));
    assert.ok(completed.value.memories.some(m=>m.trust==='tool_verified'));
    assert.ok(contextSeen,'L1-L4 context was persisted through actual Agent Loop');
    const bypass=await ctx.tools.execute({name:'ime_fixture_click',arguments:{target:'panel'},callId:'unmanaged-call',signal:new AbortController().signal});assert.equal(bypass.isError,true);
    checks.push('monotonic tools.guard blocks direct Provider tool bypass');
    checks.push('real Agent Loop executes task-create/action/verify/finish against isolated desktop tools');
    checks.push('real pre-step persists IMe context; successful task proposes memory, candidate skill and review');

    recoverySession='ime-recovery-'+randomUUID();
    const {agent:recoveryAgent}=await ctx.get('agents').create({sessionId:recoverySession,agentOptions:{provider:'ime-smoke-model',model:'fixture',maxTokens:50}});
    recoveryAgent.followup({id:randomUUID(),role:'user',content:[{type:'text',text:'fixture truncation'}],source:{kind:'user'}});
    await wait(()=>recoveryCalls>=3);
    await recoveryAgent.whenIdle();await delay(100);
    assert.equal(recoveryCalls,3,'burst cap must stop after two automatic followups');
    checks.push('real max-tokens turn/end resumes from idle twice, then stops at durable burst cap');
    const officialEntries=[...ctx.get('loader').entries()];
    for(const id of ['session-checkpoint-policy','token-meter']) {
      assert.ok(officialEntries.some(e=>e.options.id===id&&!e.options.disabled),id+' must be supplied by host');
    }
    checks.push('official checkpoint policy and token meter already supplied by host composition');

    const entries = [...ctx.get('loader').entries()].filter(e=>e.options.id==='ime-core');
    const entry = entries.find(e=>e.fiber?.state===2) ?? entries[0];
    assert.ok(entry);
    const dataDir = entry.options.config.dataDir;
    assert.ok(existsSync(join(dataDir,'runtime.lock')));
    await entry.update({disabled:true});
    await entry.fiber?.await();
    await wait(()=>!existsSync(join(dataDir,'runtime.lock')));
    assert.equal(ctx.tools.get('ime_status'),undefined);
    checks.push('real loader disable unregisters tool and releases runtime lock');
    const audit = readFileSync(join(dataDir,'audit.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
    assert.ok(audit.some(e=>e.type==='ime.host.tool_result' && e.data.name==='ime_status'));
    checks.push('real tools/result hook persisted in audit');
    await entry.update({disabled:false,config:{...entry.options.config,models:{enabled:true,maxAttempts:1},routes:[{
      provider:'ime-smoke-model',model:'fixture',tier:'cheap',vision:false,tools:false,contextLimit:10000,maxOutput:50,privacyRegion:'local',
      price:{version:'integration-fixture-only',currency:'USD',inputPerMillion:'1000000',cachedPerMillion:'100000',outputPerMillion:'2000000'},
    }],modelBudget:{sessionLimit:'200',routes:[{
      provider:'ime-smoke-model',model:'fixture',inputUpperBound:100,maxOutput:50,
      price:{version:'integration-fixture-only',currency:'USD',inputPerMillion:'1000000',cachedPerMillion:'100000',outputPerMillion:'2000000'},
    }]}}});
    await entry.fiber?.await();
    await wait(()=>ctx.tools.get('ime_status'));
    const reloaded = await invoke();
    assert.equal(reloaded.isError,false,JSON.stringify(reloaded));
    checks.push('real loader reload and second dispatch');
    assert.equal(reloaded.value.modelGateway.mode,'guarded');
    const beforeGuard=modelCalls;
    await modelCall();
    assert.equal(modelCalls,beforeGuard+1);
    const settled=await invoke();
    assert.ok(settled.value.budgets.some(b=>b.spent===82));
    await assert.rejects(modelCall(),/BUDGET_DENIED/);
    assert.equal(modelCalls,beforeGuard+1,'denied request must not enter the adapter');
    const denied=await invoke();
    assert.equal(denied.value.modelGateway.requests[0].state,'denied');
    assert.ok(denied.value.tasks.some(t=>t.app==='ime:model'&&t.status==='paused'));
    checks.push('real prepared LLM stream reserves and settles 82 micro-units');
    checks.push('budget denial blocks actual adapter dispatch and pauses session budget');
    const managedAgent=ctx.get('agents').get(scriptedSessionId);
    const managedCreate=await ctx.tools.execute({name:'ime_task_create',arguments:{app:'smoke-app',goal:'受管模型预算验证'},agent:managedAgent,callId:'ime-managed-create',signal:new AbortController().signal});
    assert.equal(managedCreate.isError,false,JSON.stringify(managedCreate));
    const managedTaskId=managedCreate.value.task.id,beforeManaged=modelCalls;
    const managed=await ctx.tools.execute({name:'ime_model_call',arguments:{taskId:managedTaskId,prompt:'fixture',maxOutput:50},agent:managedAgent,callId:'ime-managed-model',signal:new AbortController().signal});
    assert.equal(managed.isError,false,JSON.stringify(managed));assert.equal(modelCalls,beforeManaged+1);
    const managedState=await invoke();
    assert.equal(managedState.value.budgets.find(b=>b.task_id===managedTaskId)?.spent,82);
    assert.equal(managedState.value.modelGateway.requests.filter(request=>request.id===managed.value.requestId).length,1);
    checks.push('managed adaptive model tool uses the real prepared service and charges exactly once');
    await entry.update({disabled:true});
    await entry.fiber?.await();
    await wait(()=>!existsSync(join(dataDir,'runtime.lock')));
    const report = { passed:true,hostVersion:config.hostVersion,checks,hostCapabilities:result.value.hostCapabilities,verifiedAt:new Date().toISOString() };
    writeFileSync(config.reportPath,JSON.stringify(report,null,2)+'\n');
    console.log('IME_HOST_SMOKE_PASS '+JSON.stringify(report));
    await exit(0);
  };
  // Let the profile finish mounting before exercising its loader entries.
  const timer=setTimeout(()=>run().catch(async error=>{ console.error('IME_HOST_SMOKE_FAIL',error);await exit(1); }),100);
  ctx.effect(()=>()=>clearTimeout(timer));
}
