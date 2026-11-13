import { randomUUID } from 'node:crypto';
import type { Runtime } from '../core/runtime.js';
import { money, type Price, type Usage } from '../core/cost.js';
export interface HostRequest {
  provider: string; model: string; sessionId?: string; maxTokens?: number;
  purpose?: string; signal?: AbortSignal;
}
export interface HostChunk { type: string; usage?: unknown; [key: string]: unknown }
export interface RouteBudget {
  provider: string; model: string; price: Price;
  inputUpperBound: number; maxOutput: number;
  validUntil?: string;
}
export interface ModelBudgetConfig { sessionLimit: string; routes: RouteBudget[] }
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_HOST_USAGE');
  return value;
}
/** DSH counters are disjoint, unlike IMe's total input plus cached subset. */
export function normalizeUsage(raw: unknown): Usage {
  if (!raw || typeof raw !== 'object') throw new Error('INVALID_HOST_USAGE');
  const u = raw as Record<string,unknown>;
  const input = count(u.inputTokens), read = count(u.cacheReadTokens ?? 0), write = count(u.cacheWriteTokens ?? 0);
  const total = count(input + read + write);
  return { inputTokens:total,cachedInputTokens:read,outputTokens:count(u.outputTokens) };
}
export function validateModelBudget(value: ModelBudgetConfig | undefined): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || !Array.isArray(value.routes) || !value.routes.length) throw new Error('INVALID_MODEL_BUDGET');
  money(value.sessionLimit);
  const seen = new Set<string>();
  for (const route of value.routes) {
    if (!route || typeof route.provider !== 'string' || !route.provider || typeof route.model !== 'string' || !route.model
      || !Number.isSafeInteger(route.inputUpperBound) || route.inputUpperBound <= 0
      || !Number.isSafeInteger(route.maxOutput) || route.maxOutput <= 0 || !route.price
      || typeof route.price.version !== 'string' || !route.price.version.trim()
      || typeof route.price.currency !== 'string' || !/^[A-Z]{3}$/.test(route.price.currency)) throw new Error('INVALID_MODEL_ROUTE');
    [route.price.inputPerMillion,route.price.cachedPerMillion,route.price.outputPerMillion].forEach(money);
    if(route.validUntil!==undefined&&(typeof route.validUntil!=='string'||!Number.isFinite(Date.parse(route.validUntil))))throw new Error('INVALID_PRICE_EXPIRY');
    const key=JSON.stringify([route.provider,route.model]);
    if (seen.has(key)) throw new Error('DUPLICATE_MODEL_ROUTE');
    seen.add(key);
  }
  if (new Set(value.routes.map(r=>r.price.currency)).size !== 1) throw new Error('MIXED_BUDGET_CURRENCIES');
}

/** Official middleware seam, not a replacement Provider. Never changes prepared call controls. */
export class HostModelGateway {
  private contexts=new Map<string,{taskId?:string;turn:number;step:number;actionId?:string}>();
  setContext(sessionId:string,context:{taskId?:string;turn:number;step:number;actionId?:string}){
    if(this.contexts.size>=1000)this.contexts.delete(this.contexts.keys().next().value!);
    this.contexts.set(sessionId,context);
  }
  clearContext(sessionId:string){this.contexts.delete(sessionId);}
  private config: ModelBudgetConfig | undefined;
  private stopped = false;
  private streams = new Set<AsyncGenerator<HostChunk>>();
  constructor(private runtime: Runtime, config?: ModelBudgetConfig) {
    validateModelBudget(config);
    this.config = config === undefined ? undefined : structuredClone(config);
  }
  status() {
    return { connected:true, paused:this.stopped, mode:this.config ? 'guarded' : 'observe', hardLimit:false,
      scope:'llm/stream', unknownPrices:this.config === undefined,
      requests:this.runtime.store.db.prepare('SELECT * FROM model_requests ORDER BY rowid DESC LIMIT 50').all() };
  }
  /** Replace the price catalogue at runtime; existing reservations keep their quote snapshot. */
  configure(config?: ModelBudgetConfig): void {
    validateModelBudget(config);
    this.config = config === undefined ? undefined : structuredClone(config);
  }
  intercept(request: HostRequest, next: () => AsyncIterable<HostChunk>): AsyncGenerator<HostChunk> {
    const gateway=this;
    let stream!: AsyncGenerator<HostChunk>;
    stream=(async function* () {
      gateway.streams.add(stream);
      try { yield* gateway.run(request,next); }
      finally { gateway.streams.delete(stream); }
    })();
    return stream;
  }
  private async *run(request: HostRequest, next: () => AsyncIterable<HostChunk>): AsyncGenerator<HostChunk> {
    if(this.runtime.models.owns(request)){yield* next();return;}
    if (this.stopped) throw new Error('IME_GATEWAY_STOPPED');
    request.signal?.throwIfAborted();
    if (!request.provider || !request.model) throw new Error('IME_INVALID_ROUTE');
    const id=randomUUID();
    const session = request.sessionId ?? 'ime:auxiliary';
    let reservation: string | undefined;
    let taskId: string | undefined;
    const route = this.config?.routes.find(r=>r.provider===request.provider && r.model===request.model);
    const db=this.runtime.store.db;
    db.prepare('INSERT INTO model_requests(id,session_id,provider,model,state,created_at) VALUES(?,?,?,?,?,?)')
      .run(id,session,request.provider,request.model,'pending',new Date().toISOString());
    const trace=request.purpose?undefined:this.contexts.get(session);
    db.prepare('INSERT INTO request_trace(request_id,task_id,turn_id,step_id,action_id) VALUES(?,?,?,?,?)').run(id,trace?.taskId ?? null,trace?.turn ?? null,trace?.step ?? null,trace?.actionId ?? null);
    // Keep only request identity. No prompts, tool args, response text or credentials.
    try {
      if (this.config) {
        if (!route) throw new Error('IME_UNPRICED_ROUTE');
        if(route.validUntil!==undefined&&Date.now()>=Date.parse(route.validUntil))throw new Error('IME_PRICE_EXPIRED');
        if (!Number.isSafeInteger(request.maxTokens) || request.maxTokens! <= 0 || request.maxTokens! > route.maxOutput) throw new Error('IME_OUTPUT_BOUND_REQUIRED');
        taskId=this.sessionTask(session,route.price.currency);
        reservation=this.runtime.costs.reserve(taskId,id,this.runtime.costs.quote(route.price,
          {inputUpperBound:route.inputUpperBound,maxOutput:request.maxTokens!,toolAllowance:'0'}));
      }
    } catch(error) {
      db.prepare("UPDATE model_requests SET state='denied',finished_at=? WHERE id=?").run(new Date().toISOString(),id);
      this.runtime.store.event('ime.model.denied',{ requestId:id,sessionId:session,code:error instanceof Error ? error.message : 'IME_DENIED' });
      if (taskId && error instanceof Error && error.message==='BUDGET_DENIED' && this.runtime.tasks.get(taskId).status==='running') this.runtime.pause(taskId);
      throw error;
    }
    db.prepare("UPDATE model_requests SET state='streaming',task_id=?,reservation_id=? WHERE id=?").run(taskId ?? null,reservation ?? null,id);
    let usage: Usage | undefined;
    let state='interrupted';
    let invalidUsage=false;
    let finished=false;
    let cacheWrites=false;
    const started=performance.now();
    try {
      for await (const chunk of next()) {
        if (this.stopped) throw new Error('IME_GATEWAY_STOPPED');
        request.signal?.throwIfAborted();
        if (finished) throw new Error('IME_CHUNK_AFTER_FINISH');
        if (chunk.type==='usage') {
          // Usage snapshots are cumulative, not deltas. Invalid snapshots invalidate the bill.
          try { usage=normalizeUsage(chunk.usage); cacheWrites ||= Number((chunk.usage as Record<string,unknown>).cacheWriteTokens ?? 0)>0; } catch { usage=undefined;invalidUsage=true; }
        }
        if (chunk.type==='finish') {
          finished=true;
          const finish=chunk.reason as {kind?: string} | undefined;
          state=finish && ['stop','tool-calls','max-tokens'].includes(finish.kind ?? '') ? 'finished' : 'failed';
        }
        yield chunk;
      }
      if (!finished) state='interrupted';
    } catch(error) { state='failed'; throw error; }
    finally {
      // Partial or aborted requests may have unseen billed output. Retain full reservation.
      const actual = state==='finished' && usage !== undefined && !invalidUsage && !(route && cacheWrites);
      if (reservation) this.runtime.costs.settle(reservation,actual ? usage : undefined);
      if (route && usage && (usage.inputTokens>route.inputUpperBound || usage.outputTokens>request.maxTokens!)) {
        this.runtime.store.event('ime.model.bound_exceeded',{requestId:id,taskId});
        if (taskId && this.runtime.tasks.get(taskId).status==='running') this.runtime.pause(taskId);
      }
      db.prepare('UPDATE model_requests SET state=?,usage=?,certainty=?,finished_at=? WHERE id=?')
        .run(state,usage ? JSON.stringify(usage) : null,actual ? (route ? 'actual' : 'unpriced') : 'unknown',new Date().toISOString(),id);
      this.runtime.store.event('ime.model.finished',{ requestId:id,sessionId:session,provider:request.provider,model:request.model,state,certainty:actual ? (route ? 'actual' : 'unpriced') : 'unknown' });
      if(route) {
        const verdict=trace?.taskId?this.runtime.tasks.get(trace.taskId).status:undefined;
        this.runtime.router.feedback({requestId:id,...trace?.taskId?{taskId:trace.taskId}:{},provider:request.provider,model:request.model,category:request.purpose??'general',
          success:state!=='finished'?false:verdict==='succeeded'?true:verdict==='failed'?false:null,
          amount:Number(db.prepare('SELECT amount FROM usage_entries WHERE request_id=?').get(id)?.amount??0),currency:route.price.currency,latencyMs:performance.now()-started});
      }
    }
  }
  private sessionTask(sessionId: string, currency: string): string {
    const db=this.runtime.store.db;
    const existing=db.prepare('SELECT task_id FROM model_sessions WHERE session_id=?').get(sessionId);
    if (existing) return String(existing.task_id);
    const task=this.runtime.tasks.create(sessionId,'DSH 会话模型预算','ime:model',this.config!.sessionLimit,currency);
    this.runtime.tasks.transition(task.id,'ready');this.runtime.tasks.transition(task.id,'running');
    db.prepare('INSERT INTO model_sessions VALUES(?,?)').run(sessionId,task.id);
    return task.id;
  }
  pause(){this.stopped=true;}
  resume(){this.stopped=false;}
  async close(): Promise<void> {
    this.stopped=true;
    await Promise.allSettled([...this.streams].map(stream=>stream.return(undefined)));
  }
}
