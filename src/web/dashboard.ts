import { createServer,type Server,type IncomingMessage,type ServerResponse } from 'node:http';
import { randomBytes,timingSafeEqual } from 'node:crypto';
import { writeFileSync,unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Runtime } from '../core/runtime.js';
import type { HostModelGateway } from '../adapters/model-gateway.js';
import { DeepSeekBalance } from '../adapters/balance.js';
import { dashboardHtml } from './page.js';
import { textField } from '../core/knowledge.js';
export class Dashboard {
  private server:Server;
  readonly token=randomBytes(32).toString('hex');
  readonly ready:Promise<void>;
  url='';
  private balance=new DeepSeekBalance(()=>process.env.DEEPSEEK_API_KEY);
  constructor(private runtime:Runtime,private gateway:HostModelGateway|undefined,private capabilities:unknown,port=0,private nativeCompact?:(sessionId:string)=>Promise<unknown>) {
    if(!Number.isSafeInteger(port)||port<0||port>65535)throw new Error('INVALID_DASHBOARD_PORT');
    this.server=createServer((req,res)=>void this.handle(req,res));
    this.server.requestTimeout=10000;this.server.headersTimeout=10000;
    this.ready=new Promise((resolve,reject)=>{
      this.server.once('error',reject);
      this.server.listen(port,'127.0.0.1',()=>{
        const address=this.server.address();if(!address||typeof address==='string'){reject(new Error('DASHBOARD_START_FAILED'));return;}
        this.url=`http://127.0.0.1:${address.port}/`;
        writeFileSync(join(runtime.store.dir,'dashboard.url'),this.url+'#token='+this.token,{mode:0o600});resolve();
      });
    });
  }
  private json(res:ServerResponse,status:number,value:unknown) {
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));
  }
  private async handle(req:IncomingMessage,res:ServerResponse) {
    try{
      const url=new URL(req.url ?? '/','http://127.0.0.1');
      const authority=new URL(this.url||'http://127.0.0.1').host;
      if(req.headers.host!==authority){this.json(res,403,{error:'HOST_DENIED'});return;}
      if(url.pathname==='/'&&req.method==='GET') {
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
          'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
          'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});res.end(dashboardHtml);return;
      }
      const auth=req.headers.authorization?.replace(/^Bearer /,'') ?? '';
      if(auth.length!==this.token.length||!timingSafeEqual(Buffer.from(auth),Buffer.from(this.token))) {this.json(res,401,{error:'AUTH_REQUIRED'});return;}
      if(req.headers.origin&&req.headers.origin!==this.url.slice(0,-1)){this.json(res,403,{error:'ORIGIN_DENIED'});return;}
      if(req.method==='GET') {
        const db=this.runtime.store.db;
        if(url.pathname==='/api/state') {this.json(res,200,{...this.runtime.status(),hostCapabilities:this.capabilities,modelGateway:this.gateway?.status(),trace:db.prepare('SELECT * FROM audit_events ORDER BY seq DESC LIMIT 100').all(),reviews:db.prepare('SELECT * FROM reviews ORDER BY created_at DESC LIMIT 50').all(),metrics:this.metrics()});return;}
        if(url.pathname==='/api/memory'){this.json(res,200,this.runtime.knowledge.retrieve(url.searchParams.get('q') ?? '',textField(url.searchParams.get('app'),300)));return;}
        if(url.pathname==='/api/timeline'){this.json(res,200,{actions:db.prepare('SELECT * FROM actions ORDER BY rowid DESC LIMIT 100').all(),checkpoints:db.prepare('SELECT * FROM checkpoints ORDER BY rowid DESC LIMIT 100').all()});return;}
        if(url.pathname==='/api/balance'){this.json(res,200,await this.balance.get());return;}
        if(url.pathname==='/api/export'){
          const kind=url.searchParams.get('kind');
          const value=kind==='memory'?this.runtime.knowledge.listMemories():kind==='skills'?this.runtime.knowledge.listSkills():kind==='experience'?this.runtime.experience.recent(200):kind==='ledger'?db.prepare('SELECT * FROM usage_entries').all():{capabilities:this.capabilities,metrics:this.metrics(),schemaVersions:db.prepare('SELECT version FROM migrations').all(),trace:db.prepare('SELECT type,created_at FROM audit_events ORDER BY seq DESC LIMIT 200').all()};
          this.json(res,200,value);return;
        }
      }
      if(req.method==='POST'&&url.pathname==='/api/command') {
        if(!req.headers['content-type']?.startsWith('application/json')){this.json(res,415,{error:'JSON_REQUIRED'});return;}
        let size=0;const chunks:Buffer[]=[];
        for await(const chunk of req){size+=chunk.length;if(size>65536){this.json(res,413,{error:'BODY_TOO_LARGE'});return;}chunks.push(Buffer.from(chunk));}
        const body=JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>;
        const result=await this.command(body);this.json(res,200,result ?? {ok:true});return;
      }
      this.json(res,404,{error:'NOT_FOUND'});
    }catch(error){this.json(res,400,{error:error instanceof Error?error.message:'OPERATION_FAILED'});}
  }
  async command(b:Record<string,unknown>):Promise<unknown> {
    const id=()=>textField(b.id,200),r=this.runtime,db=r.store.db;
    switch(b.operation) {
      case 'pause_all':r.executionPaused=true;this.gateway?.pause();r.desktop?.stop(); for(const t of db.prepare("SELECT id FROM tasks WHERE status='running'").all())r.pause(String(t.id));return;
      case 'resume_all':r.executionPaused=false;this.gateway?.resume();await r.desktop?.resumeAll();return;
      case 'task_create':if(!r.allowApps.includes(String(b.app)))throw Error('APP_DENIED');return r.tasks.create(textField(b.sessionId,200),textField(b.goal),textField(b.app,300),textField(b.limit,30),'USD');
      case 'task_start':r.tasks.transition(id(),'ready');r.tasks.transition(id(),'running');return;
      case 'task_pause':r.pause(id());return;
      case 'task_cancel':r.cancel(id());return;
      case 'task_resume':return r.tasks.resume(id(),async checkpoint=>{
        const task=r.tasks.get(id());
        if(task.app==='ime:model')return true;
        if(!r.desktop||!checkpoint)return false;
        const now=await r.desktop.observe(task.app,new AbortController().signal);return now.fingerprint===checkpoint.fingerprint;
      });
      case 'reconcile_action':if(typeof b.occurred!=='boolean')throw Error('INVALID_RECONCILIATION');return r.tasks.reconcile(textField(b.taskId,200),textField(b.actionId,200),b.occurred,textField(b.evidence));
      case 'approve':if(typeof b.allow!=='boolean')throw Error('INVALID_APPROVAL');{
        const row=r.permissions.decide(id(),b.allow);const task=r.tasks.get(String(row.task_id));
        if(task.status==='waiting_approval')r.tasks.transition(task.id,'paused');return {approvalId:row.id,status:b.allow?'approved':'denied'};
      }
      case 'execute_approval':{
        const row=db.prepare("SELECT * FROM approvals WHERE id=? AND status='approved'").get(id());if(!row||!r.desktop)throw Error('APPROVAL_UNAVAILABLE');
        const action=JSON.parse(String(row.action));const taskId=String(row.task_id);
        if(!action.assertState)throw Error('TRUSTED_ASSERTION_REQUIRED');
        await r.tasks.resume(taskId,async()=>{const now=await r.desktop!.observe(action.app,new AbortController().signal);return now.fingerprint===action.expectedFingerprint;});
        return r.desktop.run(taskId,action,o=>o.state===action.assertState);
      }
      case 'reconcile_cost':return r.costs.reconcile(id(),{inputTokens:Number(b.inputTokens),cachedInputTokens:Number(b.cachedInputTokens),outputTokens:Number(b.outputTokens)});
      case 'skill_revise':{
        const previous=r.knowledge.skill(id(),this.version(b.version));return r.knowledge.proposeSkill({...previous.document,goal:textField(b.goal),precondition:textField(b.precondition),steps:b.steps as typeof previous.document.steps},id());
      }
      case 'cap':return r.costs.setLimit(textField(b.scope,30) as 'session'|'day'|'account',textField(b.key,200),textField(b.currency,3),textField(b.limit,30));
      case 'memory_create':return {id:r.knowledge.propose({kind:'fact',content:textField(b.content),app:textField(b.app,300),trust:'user',sourceEventIds:[],...typeof b.factKey==='string'&&b.factKey.trim()?{factKey:b.factKey}:{}})};
      case 'memory_resolve':return r.knowledge.resolveConflict(textField(b.first,200),textField(b.second,200),textField(b.winner,200));
      case 'memory_approve':return r.knowledge.approve(id());
      case 'memory_archive':return r.knowledge.archive(id());
      case 'memory_delete':return r.knowledge.deleteMemory(id());
      case 'skill_publish':return r.knowledge.publish(id(),this.version(b.version));
      case 'skill_review_publish':{
        const note=typeof b.note==='string'&&b.note.trim()?textField(b.note,2000):'用户在控制台复核后发布';
        return r.knowledge.publishReviewed(id(),this.version(b.version),note,r.learning.minSuccesses);
      }
      case 'skill_rollback':return r.knowledge.rollback(id(),this.version(b.version));
      case 'skill_evaluate':return r.evaluateSkill(id(),this.version(b.version));
      case 'compact':if(!this.nativeCompact)throw Error('NATIVE_COMPACTION_UNAVAILABLE');return this.nativeCompact(r.tasks.get(id()).session_id);
      case 'review':return r.review.review(id());
      default:throw Error('UNKNOWN_OPERATION');
    }
  }
  private version(v:unknown):number{if(!Number.isSafeInteger(v)||Number(v)<1)throw Error('INVALID_VERSION');return Number(v);}
  private metrics() {
    return {tasks:this.runtime.store.db.prepare('SELECT status,COUNT(*) AS count FROM tasks GROUP BY status').all(),costByCurrency:this.runtime.store.db.prepare('SELECT b.currency,SUM(b.spent) AS amountMicro,COUNT(CASE WHEN t.status=\'succeeded\' THEN 1 END) AS successes FROM budgets b JOIN tasks t ON t.id=b.task_id GROUP BY b.currency').all(),modelRequests:this.runtime.store.db.prepare('SELECT state,certainty,COUNT(*) AS count FROM model_requests GROUP BY state,certainty').all(),denials:this.runtime.store.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE type='ime.model.denied'").get()};
  }
  async close(){await this.ready.catch(()=>{});this.server.closeIdleConnections();await new Promise<void>(resolve=>this.server.close(()=>resolve()));try{unlinkSync(join(this.runtime.store.dir,'dashboard.url'));}catch{}}
}
