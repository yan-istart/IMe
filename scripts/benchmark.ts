import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {Runtime} from '../src/core/runtime.js';
import {MockDesktop} from '../src/adapters/mock.js';
import {HostModelGateway,type HostChunk} from '../src/adapters/model-gateway.js';
const dir=mkdtempSync(join(tmpdir(),'ime-benchmark-'));
const provider=new MockDesktop();
const configuration={dataDir:dir,allowApps:['mock-app'],desktopLeasePath:join(dir,'desktop.lock'),evaluation:{app:'mock-app',cases:['reset-1','reset-2','reset-3']}};
let runtime=new Runtime(configuration,provider);
const price={version:'mock-benchmark-only',currency:'USD',inputPerMillion:'1000000',cachedPerMillion:'100000',outputPerMillion:'2000000'};
function task(goal:string){const t=runtime.tasks.create(randomUUID(),goal,'mock-app','1000000');runtime.tasks.transition(t.id,'ready');runtime.tasks.transition(t.id,'running');return t;}
function action(){return {id:randomUUID(),app:'mock-app',kind:'click' as const,target:'task-panel',risk:'reversible_write' as const,expectedFingerprint:'mock-app:v1:zh:1280x720',timeoutMs:1000};}
const started=performance.now();
try{
 const stress=task('1000 mock actions');
 for(let i=0;i<1000;i++){provider.state='home';await runtime.desktop!.run(stress.id,action(),o=>o.state==='task-panel');}
 const checkpointCount=runtime.store.db.prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE task_id=?').get(stress.id)?.n;assert.equal(checkpointCount,1000);
 const gateway=new HostModelGateway(runtime);
 for(let i=0;i<100;i++){
   async function* source():AsyncGenerator<HostChunk>{if(i%5!==0)yield {type:'usage',usage:{inputTokens:60,cacheReadTokens:20,outputTokens:10}};yield {type:'finish',reason:{kind:i%7===0?'error':'stop'}};}
   for await(const c of gateway.intercept({provider:'mock',model:'mixed',sessionId:'mixed'},()=>source())){}
 }
 await gateway.close();assert.equal(Number(runtime.store.db.prepare('SELECT COUNT(*) AS n FROM model_requests').get()?.n),100);
 const persisted=runtime.tasks.create('restarts','断点恢复','mock-app','1000');runtime.tasks.transition(persisted.id,'ready');runtime.tasks.transition(persisted.id,'running');
 for(let i=0;i<20;i++){
   await runtime.close();runtime=new Runtime(configuration,provider);
   assert.equal(runtime.tasks.get(persisted.id).status,'paused');await runtime.tasks.resume(persisted.id,async()=>true);
 }
 // Deterministic comparison uses the same authorized simulator/model tariffs. It does not measure real Provider savings.
 const rows:{task:number;measurements:{mode:string;success:boolean;amountMicro:number}[]}[]=[];let reusable:{id:string;version:number}|undefined;
 for(let i=0;i<20;i++){
   const measurements=[];
   for(const mode of ['A','B','C'] as const){
     provider.state='home';const t=task(`${mode}: task ${i+1}`);
     const before=Number(runtime.store.db.prepare('SELECT COALESCE(SUM(spent),0) AS n FROM budgets').get()?.n);
     if(mode==='C'&&reusable){await runtime.skills.run(t.id,reusable.id,reusable.version);}
     else{
       const input=mode==='A'?400:mode==='B'?300:200;
       await runtime.costs.call(t.id,price,{inputUpperBound:input,maxOutput:50,toolAllowance:'0'},async()=>({value:'task-panel',usage:{inputTokens:input,cachedInputTokens:0,outputTokens:20}}));
       await runtime.desktop!.run(t.id,action(),o=>o.state==='task-panel');
     }
     runtime.tasks.transition(t.id,'succeeded');
     if(mode==='C'&&!reusable){const id=runtime.candidate(t.id);reusable={id,version:1};await runtime.evaluateSkill(id,1);runtime.knowledge.publish(id,1);}
     const after=Number(runtime.store.db.prepare('SELECT COALESCE(SUM(spent),0) AS n FROM budgets').get()?.n);
     measurements.push({mode,success:true,amountMicro:after-before});
   }
   rows.push({task:i+1,measurements});
 }
 const totals=['A','B','C'].map(mode=>({mode,successes:rows.flatMap(r=>r.measurements).filter(m=>m.mode===mode&&m.success).length,costMicro:rows.flatMap(r=>r.measurements).filter(m=>m.mode===mode).reduce((sum,m)=>sum+m.amountMicro,0)}));
 const report={scope:'deterministic mock simulator only; B uses a configured context-size proxy, not real DSH compaction; prices are fixtures, not real quotes',verifiedAt:new Date().toISOString(),stress:{actions:1000,checkpoints:checkpointCount,modelRequests:100,gracefulRestarts:20},durationMs:Math.round(performance.now()-started),totals,rows};
 writeFileSync(join(process.cwd(),'docs','benchmark-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({stress:report.stress,totals,durationMs:report.durationMs},null,2));
}finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
