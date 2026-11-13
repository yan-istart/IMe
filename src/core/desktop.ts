import type {Frame} from './vision.js';
import type { Permissions } from './permissions.js';
import type { DesktopLease } from './lease.js';
import { Store } from './store.js';
import { Tasks } from './tasks.js';
export interface Observation { fingerprint: string; state: string; evidenceRef: string;frame?:Frame }
export interface Action {
  id: string; app: string; kind: 'click'|'input'|'scroll'; target: string;
  risk: 'read_only'|'reversible_write'|'sensitive_write'|'irreversible';
  expectedFingerprint: string; timeoutMs: number;precondition?:string;assertState?:string;
  skillRef?:{id:string;version:number};
}
export interface DesktopPort {
  observe(app: string, signal: AbortSignal): Promise<Observation>;
  execute(action: Action, signal: AbortSignal): Promise<void>;
  canonical?(action:Action):Action;
  reset?(app:string,caseId:string,signal:AbortSignal):Promise<void>;
}
/** One controller per runtime. Queue retains the lease until the provider has actually settled. */
export class DesktopController {
  private tail: Promise<unknown> = Promise.resolve();
  private active = new Map<string, AbortController>();
  private observing=new Map<AbortController,string|undefined>();
  private stopped = false;
  constructor(private store: Store, private tasks: Tasks, private provider: DesktopPort, private allowApps: readonly string[],private permissions?:Permissions,private lease?:DesktopLease,private onFailure?:(taskId:string)=>void,private processFrame?:(frame:Frame,reason:'change'|'verify',actionId?:string)=>string|undefined,private validateAction?:(action:Action)=>void) {}
  observe(app:string,signal:AbortSignal,taskId?:string) {
    if(!this.allowApps.includes(app))throw new Error('APP_DENIED');
    // A bare observation also joins the serial queue: it must not interleave
    // with an action or hold a stale view across another session's click.
    const work=this.tail.then(async()=>{
      if(this.stopped)throw new Error('STOPPED');
      signal.throwIfAborted();
      const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);
      this.observing.set(controller,taskId);
      try{this.lease?.acquire();return await this.observeState(app,combined,'change');}
      finally{this.observing.delete(controller);this.lease?.release();}
    });
    this.tail=work.catch(()=>{});
    return work;
  }
  private async observeState(app:string,signal:AbortSignal,reason:'change'|'verify',actionId?:string):Promise<Observation> {
    const raw=await this.provider.observe(app,signal);
    const reference=raw.frame?this.processFrame?.(raw.frame,reason,actionId):undefined;
    return {fingerprint:raw.fingerprint,state:raw.state,evidenceRef:reference ?? raw.evidenceRef};
  }
  stop(taskId?: string): void {
    if (taskId === undefined) this.stopped = true;
    for (const [id, controller] of this.active) if (!taskId || taskId === id) controller.abort(new Error('STOPPED'));
    for(const [controller,id] of this.observing)if(!taskId||taskId===id)controller.abort(new Error('STOPPED'));
  }
  async run(taskId: string, action: Action, verify: (observation: Observation) => boolean,externalSignal?:AbortSignal): Promise<Observation> {
    const work = this.tail.then(async () => {
      externalSignal?.throwIfAborted();
      if (this.stopped || !this.tasks.executionAllowed(taskId)) throw new Error('STOPPED');
      if (!this.allowApps.includes(action.app) || this.tasks.get(taskId).app !== action.app) throw new Error('APP_DENIED');
      action=this.provider.canonical?.(action) ?? action;
      this.validateAction?.(action);
      const sensitive=action.risk==='sensitive_write'||action.risk==='irreversible';
      if(!['read_only','reversible_write','sensitive_write','irreversible'].includes(action.risk))throw new Error('INVALID_RISK');
      if(sensitive&&!this.permissions?.approved(taskId,action)) {
        this.permissions?.request(taskId,action);this.tasks.transition(taskId,'waiting_approval');throw new Error('APPROVAL_REQUIRED');
      }
      if (!Number.isSafeInteger(action.timeoutMs) || action.timeoutMs <= 0) throw new Error('INVALID_TIMEOUT');
      if (this.store.db.prepare('SELECT id FROM actions WHERE id=?').get(action.id)) throw new Error('ACTION_ALREADY_ATTEMPTED');
      this.lease?.acquire();
      const controller = new AbortController();
      const signal=externalSignal?AbortSignal.any([controller.signal,externalSignal]):controller.signal;
      this.active.set(taskId,controller);
      const timer = setTimeout(() => controller.abort(new Error('ACTION_TIMEOUT')),action.timeoutMs);
      let dispatched = false;
      try {
        const before = await this.observeState(action.app,signal,'change',action.id);
        signal.throwIfAborted();
        if (before.fingerprint !== action.expectedFingerprint || (action.precondition!==undefined&&action.precondition!==before.state)) throw new Error('ENVIRONMENT_MISMATCH');
        if (!this.tasks.executionAllowed(taskId)) throw new Error('STOPPED');
        this.validateAction?.(action);
        this.store.transaction(() => {
          if(sensitive&&!this.permissions?.consume(taskId,action))throw new Error('APPROVAL_REQUIRED');
          this.store.db.prepare('INSERT INTO actions VALUES(?,?,?,?)').run(action.id,taskId,'executing',JSON.stringify({...action,beforeState:before.state}));
          this.store.event('ime.action.started', { taskId, actionId: action.id });
        });
        dispatched = true;
        await this.provider.execute(action,signal);
        signal.throwIfAborted();
        const after = await this.observeState(action.app,signal,'verify',action.id);
        signal.throwIfAborted();
        if (!this.tasks.executionAllowed(taskId)) throw new Error('STOPPED');
        if ((action.assertState!==undefined&&after.state!==action.assertState)||!verify(after)) throw new Error('VERIFICATION_FAILED');
        this.store.transaction(() => {
          this.store.db.prepare("UPDATE actions SET state='verified',data=? WHERE id=?").run(JSON.stringify({...action,beforeState:before.state,verifiedState:after.state}),action.id);
          const cursor = Number(this.tasks.latest(taskId)?.cursor ?? 0) + 1;
          this.tasks.checkpoint(taskId,cursor,after.fingerprint,after.evidenceRef);
          this.store.event('ime.action.finished', { taskId, actionId: action.id, evidenceRef: after.evidenceRef });
        });
        return after;
      } catch (error) {
        this.store.transaction(() => {
          if (dispatched) this.store.db.prepare("UPDATE actions SET state='uncertain' WHERE id=?").run(action.id);
        });
        if (this.tasks.get(taskId).status === 'running') this.tasks.transition(taskId,'paused');
        if(dispatched){this.store.event('ime.action.failed',{taskId,actionId:action.id});this.onFailure?.(taskId);}
        throw error;
      } finally { clearTimeout(timer); this.active.delete(taskId);this.lease?.release(); }
    });
    this.tail = work.catch(() => {});
    return work;
  }
  async resumeAll(){await this.tail;this.stopped=false;}
  async reset(app:string,caseId:string,signal:AbortSignal) {
    if(!this.provider.reset||!this.allowApps.includes(app))throw new Error('TEST_ENVIRONMENT_UNAVAILABLE');
    const work=this.tail.then(async()=>{
      if(this.stopped)throw Error('STOPPED');const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);this.observing.set(controller,undefined);
      try{this.lease?.acquire();await this.provider.reset!(app,caseId,combined);}finally{this.observing.delete(controller);this.lease?.release();}
    });
    this.tail=work.catch(()=>{});return work;
  }
  async drain(): Promise<void> { await this.tail; }
}
