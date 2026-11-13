import { randomUUID } from 'node:crypto';
import type { Runtime } from './runtime.js';
import { BeforeDispatchError,type ModelPort } from '../adapters/host-model.js';
import {HttpModelPort,validateHttpModels,type HttpModelRoute} from '../adapters/http-model.js';
import type { RouteBudget } from '../adapters/model-gateway.js';

export interface ModelExecutionConfig {enabled?:boolean;maxAttempts?:number;privacyRegion?:string;vision?:boolean;http?:HttpModelRoute[];review?:{provider:string;model:string;maxOutput:number}}
interface ExecutionOptions {category?:string;maxOutput?:number;provider?:string;model?:string;signal?:AbortSignal;image?:{data:Uint8Array;mediaType:'image/png'}}
export class ModelExecutor {
  private port:ModelPort|undefined;
  private active=new Map<string,{taskId:string;controller:AbortController;work:Promise<unknown>}>();
  private stopped=false;
  readonly http:HttpModelPort|undefined;
  constructor(private runtime:Runtime,readonly config:ModelExecutionConfig={}) {
    if(config.enabled!==undefined&&typeof config.enabled!=='boolean'||config.maxAttempts!==undefined&&(!Number.isSafeInteger(config.maxAttempts)||config.maxAttempts<1||config.maxAttempts>3))throw Error('INVALID_MODEL_EXECUTION_CONFIG');
    if(config.review&&(!config.review.provider||!config.review.model||!Number.isSafeInteger(config.review.maxOutput)||config.review.maxOutput<1))throw Error('INVALID_REVIEW_MODEL');
    if(config.http)validateHttpModels(config.http);
    this.http=config.http?new HttpModelPort(runtime,config.http):undefined;
  }
  bind(port:ModelPort){this.port=port;}
  owns(request:unknown){return this.port?.owns?.(request)??false;}
  route(provider:string,model:string):RouteBudget {
    const route=this.runtime.settings.modelBudget?.routes.find(route=>route.provider===provider&&route.model===model);
    if(!route)throw Error('IME_UNPRICED_ROUTE');
    if(route.validUntil&&Date.now()>=Date.parse(route.validUntil))throw Error('IME_PRICE_EXPIRED');return route;
  }
  call(taskId:string,prompt:string,options:ExecutionOptions={}) {
    if(!this.config.enabled||(!this.port&&!this.http))return Promise.reject(Error('MODEL_EXECUTION_DISABLED'));
    if(this.stopped||this.runtime.executionPaused)return Promise.reject(Error('STOPPED'));
    if(typeof prompt!=='string'||!prompt.trim()||prompt.length>100000)return Promise.reject(Error('INVALID_PROMPT'));
    const controller=new AbortController(),id=randomUUID();
    const work=this.perform(taskId,prompt,options,controller.signal);
    this.active.set(id,{taskId,controller,work});void work.then(()=>this.active.delete(id),()=>this.active.delete(id));return work;
  }
  private async perform(taskId:string,prompt:string,options:ExecutionOptions,cancel:AbortSignal) {
    const task=this.runtime.tasks.get(taskId),signal=AbortSignal.any([cancel,AbortSignal.timeout(60000),...options.signal?[options.signal]:[]]);
    const maxOutput=options.maxOutput??1024,category=options.category??'general';let last:unknown;
    for(let attempt=0;attempt<(this.config.maxAttempts??2);attempt++) {
      signal.throwIfAborted();if(this.runtime.executionPaused||this.stopped)throw Error('STOPPED');
      const budget=this.runtime.store.db.prepare('SELECT * FROM budgets WHERE task_id=?').get(taskId)!;
      const selected=options.provider&&options.model?{provider:options.provider,model:options.model}:(()=>{
        const selection=this.runtime.router.select({tokens:Buffer.byteLength(prompt,'utf8'),output:maxOutput,vision:Boolean(options.image),tools:false,
          remaining:Number(budget.limit_amount)-Number(budget.spent)-Number(budget.reserved),currency:String(budget.currency),failures:attempt,category,
          ...this.config.privacyRegion?{privacyRegion:this.config.privacyRegion}:{}});
        if(selection.kind!=='model')throw Error('MODEL_ROUTE_REQUIRED');return selection.route;
      })();
      const route=this.route(selected.provider,selected.model);
      const port=this.http?.supports(selected.provider,selected.model)?this.http:this.port;
      if(!port)throw Error('MODEL_SERVICE_UNAVAILABLE');
      const capabilities=this.runtime.router.describe(selected.provider,selected.model);
      if(this.config.privacyRegion&&capabilities?.privacyRegion!==this.config.privacyRegion)throw Error('MODEL_PRIVACY_REGION_DENIED');
      if(options.image&&(!this.config.vision||!capabilities?.vision))throw Error('MODEL_VISION_DISABLED');
      if(maxOutput>route.maxOutput||Buffer.byteLength(prompt,'utf8')>route.inputUpperBound)throw Error('MODEL_INPUT_OR_OUTPUT_BOUND');
      const requestId=randomUUID(),started=performance.now(),db=this.runtime.store.db;
      const reservation=this.runtime.costs.reserve(taskId,requestId,this.runtime.costs.quote(route.price,{inputUpperBound:route.inputUpperBound,maxOutput,toolAllowance:'0'}));
      db.prepare('INSERT INTO model_requests(id,session_id,provider,model,state,task_id,reservation_id,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(requestId,task.session_id,selected.provider,selected.model,'streaming',taskId,reservation,new Date().toISOString());
      db.prepare('INSERT INTO request_trace(request_id,task_id) VALUES(?,?)').run(requestId,taskId);
      let success=false,dispatched=true;
      try {
        const result=await port.generate({provider:selected.provider,model:selected.model,maxOutput,prompt,sessionId:task.session_id,signal,budget:{requestId,reservationId:reservation},...options.image?{image:options.image}:{}});
        this.runtime.costs.settle(reservation,result.usage);
        if(result.usage&&(result.usage.inputTokens>route.inputUpperBound||result.usage.outputTokens>maxOutput)) {
          if(this.runtime.tasks.get(taskId).status==='running')this.runtime.pause(taskId);throw Error('MODEL_BOUND_EXCEEDED');
        }
        db.prepare("UPDATE model_requests SET state='finished',usage=?,certainty=?,finished_at=? WHERE id=?")
          .run(result.usage?JSON.stringify(result.usage):null,result.usage?'actual':'unknown',new Date().toISOString(),requestId);
        success=true;return {text:result.text,requestId,provider:selected.provider,model:selected.model};
      } catch(error) {
        const notDispatched=error instanceof BeforeDispatchError&&!db.prepare('SELECT request_id FROM transport_attempts WHERE reservation_id=?').get(reservation);
        dispatched=!notDispatched;
        if(notDispatched)this.runtime.costs.release(reservation);else this.runtime.costs.settle(reservation);
        const billed=db.prepare('SELECT certainty,usage FROM usage_entries WHERE request_id=?').get(requestId);
        db.prepare('UPDATE model_requests SET state=?,certainty=?,usage=?,finished_at=? WHERE id=?').run(notDispatched?'denied':'failed',notDispatched?'none':String(billed?.certainty??'unknown'),billed?.usage??null,new Date().toISOString(),requestId);
        if(notDispatched)throw error;
        last=error;
      } finally {
        const amount=Number(db.prepare('SELECT amount FROM usage_entries WHERE request_id=?').get(requestId)?.amount??0);
        if(dispatched)this.runtime.router.feedback({requestId,taskId,provider:selected.provider,model:selected.model,category,success:success?null:false,amount,
          currency:route.price.currency,latencyMs:performance.now()-started});
        this.runtime.store.event('ime.model.managed_finished',{taskId,requestId,provider:selected.provider,model:selected.model,attempt,success,dispatched});
      }
    }
    throw last;
  }
  stop(taskId?:string){for(const pending of this.active.values())if(!taskId||pending.taskId===taskId)pending.controller.abort(Error('STOPPED'));}
  status(){return {enabled:Boolean(this.config.enabled),connected:Boolean(this.port||this.http),active:this.active.size,history:this.runtime.router.statistics(),transport:this.http?.status()??null};}
  async close(){this.stopped=true;this.stop();await Promise.allSettled([...this.active.values()].map(work=>work.work));}
}
