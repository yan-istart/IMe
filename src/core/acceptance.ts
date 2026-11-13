import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Runtime} from './runtime.js';
import {money} from './cost.js';
import {skillKey,textField} from './knowledge.js';

interface Sample {elapsedMs:number;rss:number;heapUsed:number;checkpointId:string;environmentHash:string;stateHash:string}
interface Job {id:string;taskId:string;status:'running'|'completed'|'cancelled'|'failed';samples:number;controller:AbortController;work:Promise<unknown>;stopRequestedAt?:number;error?:string}
const fingerprint=(value:string)=>createHash('sha256').update(value).digest('hex');
export class AcceptanceRunner {
  private jobs=new Map<string,Job>();
  constructor(private runtime:Runtime){
    this.runtime.store.transaction(()=>{
      const interrupted=this.runtime.store.db.prepare("SELECT id,task_id FROM acceptance_runs WHERE status='running'").all();
      this.runtime.store.db.prepare("UPDATE acceptance_runs SET status='interrupted',report=json_set(report,'$.status','interrupted'),updated_at=? WHERE status='running'").run(new Date().toISOString());
      for(const row of interrupted)this.runtime.store.event('ime.acceptance.interrupted',{reportId:row.id,taskId:row.task_id});
    });
  }
  start(taskId:string,options:{durationMs:number;intervalMs?:number}) {
    const duration=options?.durationMs,interval=options?.intervalMs??1000;
    if(!Number.isSafeInteger(duration)||duration<10||duration>7200000||!Number.isSafeInteger(interval)||interval<10||interval>60000)throw Error('INVALID_ACCEPTANCE_DURATION');
    if(this.runtime.isClosed||this.runtime.executionPaused||!this.runtime.tasks.executionAllowed(taskId))throw Error('TASK_NOT_RUNNING');
    if([...this.jobs.values()].some(job=>job.taskId===taskId&&job.status==='running'))throw Error('ACCEPTANCE_ALREADY_RUNNING');
    if(this.jobs.size>=100){const finished=[...this.jobs.values()].find(job=>job.status!=='running');if(finished)this.jobs.delete(finished.id);else throw Error('ACCEPTANCE_JOB_LIMIT');}
    const id=randomUUID(),controller=new AbortController();
    const job:Job={id,taskId,status:'running',samples:0,controller,work:Promise.resolve()};
    this.runtime.store.db.prepare('INSERT INTO acceptance_runs VALUES(?,?,?,?,?)').run(id,taskId,'running',JSON.stringify({version:1,id,taskId,kind:'read-only-observation-soak',status:'running',sampleCount:0,requestedDurationMs:duration,samples:[]}),new Date().toISOString());
    this.jobs.set(id,job);job.work=this.observe(job,duration,interval);
    void job.work.catch(()=>{job.status='failed';job.error='ACCEPTANCE_REPORT_FAILED';});return {id,taskId};
  }
  private async observe(job:Job,duration:number,interval:number) {
    const started=performance.now(),deadline=AbortSignal.timeout(duration),signal=AbortSignal.any([job.controller.signal,deadline]);
    const samples:Sample[]=[];let environmentChanges=0,previousEnvironment:string|undefined,lastSaved=0;
    try {
      while(!signal.aborted) {
        if(!this.runtime.tasks.executionAllowed(job.taskId))throw Error('TASK_NOT_RUNNING');
        const {observation,checkpointId}=await this.runtime.observe(job.taskId,signal);
        const memory=process.memoryUsage(),environmentHash=fingerprint(observation.fingerprint);
        if(previousEnvironment&&previousEnvironment!==environmentHash)environmentChanges++;previousEnvironment=environmentHash;
        samples.push({elapsedMs:performance.now()-started,rss:memory.rss,heapUsed:memory.heapUsed,checkpointId,environmentHash,stateHash:fingerprint(observation.state)});
        job.samples++;if(samples.length>1000)samples.shift();
        if(job.samples===1||performance.now()-lastSaved>=5000) {
          this.runtime.store.db.prepare('UPDATE acceptance_runs SET report=?,updated_at=? WHERE id=?').run(JSON.stringify(this.report(job,duration,started,samples,environmentChanges)),new Date().toISOString(),job.id);
          lastSaved=performance.now();
        }
        await new Promise<void>((resolve,reject)=>{
          const onAbort=()=>{clearTimeout(timer);reject(signal.reason);};
          const timer=setTimeout(()=>{signal.removeEventListener('abort',onAbort);resolve();},interval);
          signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();
        });
      }
    } catch {
      job.status=job.controller.signal.aborted?'cancelled':deadline.aborted?'completed':'failed';
    }
    if(job.status==='running')job.status=job.controller.signal.aborted?'cancelled':'completed';
    const report=this.report(job,duration,started,samples,environmentChanges);
    this.runtime.store.transaction(()=>{
      this.runtime.store.db.prepare('UPDATE acceptance_runs SET status=?,report=?,updated_at=? WHERE id=?').run(job.status,JSON.stringify(report),new Date().toISOString(),job.id);
      this.runtime.store.event('ime.acceptance.finished',{taskId:job.taskId,reportId:job.id,status:job.status,samples:job.samples});
    });
    try {
      const dir=join(this.runtime.store.dir,'acceptance');mkdirSync(dir,{recursive:true,mode:0o700});
      const destination=join(dir,job.id+'.json'),temp=destination+'.tmp';writeFileSync(temp,JSON.stringify(report,null,2)+'\n',{mode:0o600});renameSync(temp,destination);
    } catch {job.error='ACCEPTANCE_EXPORT_FAILED';this.runtime.store.event('ime.acceptance.export_failed',{reportId:job.id});}
    return report;
  }
  private report(job:Job,duration:number,started:number,samples:Sample[],environmentChanges:number) {
    const budget=this.runtime.store.db.prepare('SELECT currency,spent,reserved FROM budgets WHERE task_id=?').get(job.taskId)!;
    return {version:1,id:job.id,taskId:job.taskId,kind:'read-only-observation-soak',status:job.status,
      scope:'IMe observation/checkpoint/resource measurements; no business-success or account-debit claim',
      requestedDurationMs:duration,durationMs:performance.now()-started,sampleCount:job.samples,environmentChanges,
      stopLatencyMs:job.stopRequestedAt===undefined?null:performance.now()-job.stopRequestedAt,
      maxRss:samples.length?Math.max(...samples.map(sample=>sample.rss)):null,maxHeapUsed:samples.length?Math.max(...samples.map(sample=>sample.heapUsed)):null,
      budget:{currency:budget.currency,spentMicro:String(budget.spent),reservedMicro:String(budget.reserved)},samples,createdAt:new Date().toISOString()};
  }
  stop(id:string) {const job=this.jobs.get(id);if(!job)throw Error('ACCEPTANCE_NOT_FOUND');if(job.status==='running'){job.stopRequestedAt=performance.now();job.controller.abort(Error('STOPPED'));}}
  stopTask(taskId:string){for(const job of this.jobs.values())if(job.taskId===taskId)this.stop(job.id);}
  status(){return this.runtime.store.db.prepare('SELECT id,task_id,status,report FROM acceptance_runs ORDER BY updated_at DESC LIMIT 100').all().map(row=>{
    const job=this.jobs.get(String(row.id));return {id:String(row.id),taskId:String(row.task_id),status:job?.status??String(row.status),samples:job?.samples??Number(JSON.parse(String(row.report)).sampleCount??0),...job?.error?{error:job.error}:{}};
  });}
  async result(id:string):Promise<unknown> {
    const job=this.jobs.get(id);if(job)return job.work;
    if(!/^[a-f0-9-]{36}$/.test(id))throw Error('INVALID_REPORT_ID');
    const saved=this.runtime.store.db.prepare('SELECT report FROM acceptance_runs WHERE id=?').get(id);if(saved)return JSON.parse(String(saved.report)) as unknown;
    return JSON.parse(readFileSync(join(this.runtime.store.dir,'acceptance',id+'.json'),'utf8')) as unknown;
  }
  compare(baselineIds:string[],candidateIds:string[]) {
    if(!Array.isArray(baselineIds)||!Array.isArray(candidateIds)||baselineIds.length<3||baselineIds.length!==candidateIds.length||baselineIds.length>100
      ||new Set([...baselineIds,...candidateIds]).size!==baselineIds.length+candidateIds.length)throw Error('INDEPENDENT_ACCEPTANCE_TASKS_REQUIRED');
    const measure=(ids:string[])=>ids.map(id=>{
      const task=this.runtime.tasks.get(id);if(!['succeeded','failed','cancelled'].includes(task.status)||task.session_id==='ime:evaluation')throw Error('TERMINAL_PRODUCTION_TASKS_REQUIRED');
      const environments=this.runtime.store.db.prepare('SELECT DISTINCT fingerprint FROM checkpoints WHERE task_id=?').all(id);
      if(environments.length!==1)throw Error('ACCEPTANCE_ENVIRONMENT_MISMATCH');
      const rows=this.runtime.store.db.prepare(`WITH RECURSIVE family(id) AS (SELECT ? UNION SELECT c.child_id FROM task_children c JOIN family f ON c.parent_id=f.id)
        SELECT r.state,u.amount,u.certainty,u.usage,u.price,m.provider,m.model FROM reservations r JOIN family f ON f.id=r.task_id
        LEFT JOIN usage_entries u ON u.reservation_id=r.id LEFT JOIN model_requests m ON m.id=r.request_id WHERE r.state<>'released'`).all(id);
      const budget=this.runtime.store.db.prepare('SELECT currency FROM budgets WHERE task_id=?').get(id)!;
      return {id,workload:skillKey(task.app,task.goal)+':'+String(environments[0]!.fingerprint),success:task.status==='succeeded',currency:String(budget.currency),
        amount:rows.reduce((sum,row)=>sum+BigInt(String(row.amount??0)),0n),known:rows.every(row=>row.state==='settled'&&row.certainty==='actual'),
        inputTokens:rows.reduce((sum,row)=>sum+Number(JSON.parse(String(row.usage??'{}')).inputTokens??0),0),
        outputTokens:rows.reduce((sum,row)=>sum+Number(JSON.parse(String(row.usage??'{}')).outputTokens??0),0),
        tariffs:rows.flatMap(row=>{if(!row.price)return [];const price=JSON.parse(String(row.price)) as Record<string,unknown>;
          return [JSON.stringify([row.provider??null,row.model??null,price.version,price.currency,price.inputPerMillion,price.cachedPerMillion,price.outputPerMillion])];})};
    });
    const baseline=measure(baselineIds),candidate=measure(candidateIds);
    if(new Set([...baseline,...candidate].map(row=>row.currency)).size!==1)throw Error('ACCEPTANCE_CURRENCY_MISMATCH');
    const workloads=(group:typeof baseline)=>group.map(row=>row.workload).sort().join('\n');
    if(workloads(baseline)!==workloads(candidate))throw Error('ACCEPTANCE_ENVIRONMENT_MISMATCH');
    const tariffs=(group:typeof baseline)=>[...new Set(group.flatMap(row=>row.tariffs))].sort().join('\n');
    if(tariffs(candidate)&&tariffs(baseline)!==tariffs(candidate))throw Error('ACCEPTANCE_TARIFF_MISMATCH');
    const summarize=(group:typeof baseline)=>{const successes=group.filter(row=>row.success).length,amount=group.reduce((sum,row)=>sum+row.amount,0n);
      return {tasks:group.length,successes,successRate:successes/group.length,amountMicro:String(amount),costPerSuccessMicro:successes?Number(amount)/successes:null,
        inputTokens:group.reduce((sum,row)=>sum+row.inputTokens,0),outputTokens:group.reduce((sum,row)=>sum+row.outputTokens,0)};};
    const a=summarize(baseline),b=summarize(candidate),known=[...baseline,...candidate].every(row=>row.known);
    const reduction=known&&a.costPerSuccessMicro!==null&&a.costPerSuccessMicro>0&&b.costPerSuccessMicro!==null?1-b.costPerSuccessMicro/a.costPerSuccessMicro:null;
    const reducedEnough=BigInt(a.amountMicro)>0n&&a.successes>0&&b.successes>0&&BigInt(b.amountMicro)*BigInt(a.successes)*10n<=BigInt(a.amountMicro)*BigInt(b.successes)*7n;
    return {scope:'completed task evidence and IMe observed tariff ledger; not a bank/Provider account statement',currency:baseline[0]!.currency,
      certainty:known?'actual_usage':'unknown',baseline:a,candidate:b,costReduction:reduction,
      passed:known&&reducedEnough&&b.successes>=a.successes,baselineTaskIds:baselineIds,candidateTaskIds:candidateIds};
  }
  reconcileStatement(lines:{requestId:string;statementRef:string;currency:string;chargedAmount:string}[]) {
    if(!Array.isArray(lines)||!lines.length||lines.length>100)throw Error('INVALID_STATEMENT');
    return this.runtime.store.transaction(()=>lines.map(line=>{
      textField(line.requestId,200);textField(line.statementRef,200);const amount=money(line.chargedAmount);
      const entry=this.runtime.store.db.prepare('SELECT amount,certainty,price FROM usage_entries WHERE request_id=?').get(line.requestId);
      if(!entry)throw Error('BILL_NOT_FOUND');if(JSON.parse(String(entry.price)).currency!==line.currency)throw Error('CURRENCY_MISMATCH');
      const existing=this.runtime.store.db.prepare('SELECT currency,charged_amount FROM billing_reconciliations WHERE request_id=? AND statement_ref=?').get(line.requestId,line.statementRef);
      if(this.runtime.store.db.prepare('SELECT request_id FROM billing_reconciliations WHERE statement_ref=? AND request_id<>?').get(line.statementRef,line.requestId))throw Error('STATEMENT_ALREADY_ASSIGNED');
      if(existing&&(existing.currency!==line.currency||Number(existing.charged_amount)!==amount))throw Error('STATEMENT_CONFLICT');
      this.runtime.store.db.prepare('INSERT OR IGNORE INTO billing_reconciliations VALUES(?,?,?,?,?)').run(line.requestId,line.statementRef,line.currency,amount,new Date().toISOString());
      this.runtime.store.event('ime.billing.statement_reconciled',{requestId:line.requestId,statementRef:line.statementRef,currency:line.currency,chargedAmount:line.chargedAmount});
      return {requestId:line.requestId,currency:line.currency,chargedAmount:line.chargedAmount,ledgerAmount:String(entry.amount),differenceMicro:String(amount-Number(entry.amount)),ledgerCertainty:entry.certainty,verification:'user_supplied_statement'};
    }));
  }
  async close(){for(const job of this.jobs.values())if(job.status==='running')this.stop(job.id);await Promise.allSettled([...this.jobs.values()].map(job=>job.work));}
}
