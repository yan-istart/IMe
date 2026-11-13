import { randomUUID } from 'node:crypto';
import type { HostContext } from './dsh.js';
import type { Runtime } from '../core/runtime.js';

export interface RecoveryConfig { enabled?: boolean; maxConsecutive?: number; minIntervalMs?: number }
interface Agent {
  session: { id: string };
  inbox: { nextTurn: readonly unknown[]; nextStep: readonly unknown[] };
  whenIdle(): Promise<void>;
  followup(message: unknown): void;
}
interface State { turn: number; sent: number; lastSentAt: number; generation: number; pending: boolean }
/** Host events only. Does not replay tools, retry errors, or grant human authority. */
export class HostRecovery {
  readonly config: Required<RecoveryConfig>;
  private states = new Map<string, State>();
  private closed = false;
  private disposers: (() => void)[] = [];
  constructor(private ctx: HostContext, private runtime: Runtime, config: RecoveryConfig = {}, private stopped: () => boolean = () => false) {
    this.config = { enabled: true, maxConsecutive: 3, minIntervalMs: 1500, ...config };
    this.disposers.push(ctx.on('session/event', (session, event) => this.event(session, event)));
    this.disposers.push(ctx.on('session/disposed', session => {
      const id = (session as {id:string}).id;
      const state = this.states.get(id); if (state) state.generation++;
      this.states.delete(id);
    }));
  }
  status() { return { ...this.config, trigger: 'max-tokens', conflict: this.conflict() ?? null, pending: [...this.states.values()].filter(s => s.pending).length }; }
  close() { this.closed = true; for (const dispose of this.disposers.splice(0)) dispose(); this.states.clear(); }
  private state(id: string): State {
    let state = this.states.get(id);
    if (!state) {
      const row = this.runtime.store.db.prepare("SELECT data FROM audit_events WHERE type='ime.recovery.state' AND json_extract(data,'$.sessionId')=? ORDER BY seq DESC LIMIT 1").get(id);
      const saved = row ? JSON.parse(String(row.data)) : {};
      state = { turn: saved.turn ?? -1, sent: saved.sent ?? 0, lastSentAt: saved.lastSentAt ?? 0, generation: 0, pending: false };
      this.states.set(id, state);
    }
    return state;
  }
  private save(id: string, state: State) {
    this.runtime.store.event('ime.recovery.state', { sessionId: id, turn: state.turn, sent: state.sent, lastSentAt: state.lastSentAt });
  }
  private conflict(): string | undefined {
    const loader = this.ctx.get('loader') as {entries?():Iterable<{options:{name?:string;id?:string;disabled?:boolean;config?:{enabled?:boolean}}}>}|undefined;
    for (const entry of loader?.entries?.() ?? []) {
      const o=entry.options;
      if (!o.disabled && o.config?.enabled !== false && (['dsh-continue-on-limit','dsh-plugin-continue-on-limit','dsh-continue'].includes(o.name ?? '') || ['ui-continue-on-limit','continue-on-limit'].includes(o.id ?? ''))) return 'external-auto-continue';
    }
    return undefined;
  }
  private blocked(id: string, agent: Agent): string | undefined {
    if (this.closed || this.stopped() || this.runtime.executionPaused) return 'stopped';
    if (this.conflict()) return 'external-auto-continue';
    const registry = this.ctx.get('agents') as {get?(id:string):Agent|undefined}|undefined;
    if (registry?.get?.(id) !== agent) return 'agent-unavailable';
    if (!agent.inbox || !Array.isArray(agent.inbox.nextTurn) || !Array.isArray(agent.inbox.nextStep)) return 'inbox-unavailable';
    if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length) return 'input-pending';
    const db = this.runtime.store.db;
    if (db.prepare("SELECT id FROM tasks WHERE session_id=? AND status IN ('paused','recovering','waiting_approval') LIMIT 1").get(id)) return 'task-blocked';
    if (db.prepare("SELECT a.id FROM actions a JOIN tasks t ON t.id=a.task_id WHERE t.session_id=? AND a.state NOT IN ('verified','reconciled','not_applied') LIMIT 1").get(id)) return 'action-unverified';
    if (db.prepare("SELECT t.id FROM tasks t JOIN budgets b ON b.task_id=t.id WHERE t.session_id=? AND t.status='running' AND b.spent+b.reserved>=b.limit_amount LIMIT 1").get(id)) return 'budget-exhausted';
    return undefined;
  }
  private event(rawSession: unknown, rawEvent: unknown) {
    if (this.closed || !this.config.enabled) return;
    const session = rawSession as { id?: string } | null;
    const event = rawEvent as { type?: string; data?: { turn?: number; reason?: {kind?:string}; inserted?: unknown[] } } | null;
    if (!session?.id || !event?.type) return;
    const state = this.state(session.id);
    // New input or a new turn invalidates a send waiting for idle, even if input
    // is consumed before the wait resolves. An automatic prompt is never authority.
    if (event.type === 'turn/start' || event.type === 'user/message' || (event.type === 'agent/inbox/spliced' && event.data?.inserted?.length)) state.generation++;
    if (event.type !== 'turn/end') return;
    const turn = event.data?.turn;
    if (!Number.isSafeInteger(turn) || turn! < 0 || turn! <= state.turn) return;
    state.turn = turn!; state.generation++;
    if (event.data?.reason?.kind !== 'max-tokens') { state.sent = 0; this.save(session.id, state); return; }
    this.save(session.id, state);
    const registry = this.ctx.get('agents') as {get?(id:string):Agent|undefined}|undefined;
    const agent = registry?.get?.(session.id);
    if (!agent || agent.session !== session || typeof agent.whenIdle !== 'function' || typeof agent.followup !== 'function') return;
    const why = state.pending ? 'pending' : state.sent >= this.config.maxConsecutive ? 'cap-reached' :
      state.lastSentAt && Date.now() - state.lastSentAt < this.config.minIntervalMs ? 'cooldown' : this.blocked(session.id, agent);
    if (why) { this.runtime.store.event('ime.recovery.skipped', {sessionId:session.id,turn,reason:why}); return; }
    state.pending = true;
    void this.send(session.id, agent, state, state.generation);
  }
  private async send(id: string, agent: Agent, state: State, generation: number) {
    try {
      await agent.whenIdle();
      if (this.closed) return;
      const why = state.generation !== generation ? 'superseded' : this.blocked(id, agent);
      if (why) { this.runtime.store.event('ime.recovery.skipped', {sessionId:id,turn:state.turn,reason:why}); return; }
      // Commit the allowance before dispatch: an uncertain dispatch consumes it.
      state.sent++; state.lastSentAt = Date.now(); this.save(id, state);
      agent.followup(Object.freeze({ id:randomUUID(), role:'user',
        content:Object.freeze([Object.freeze({type:'text',text:'继续完成尚未完成的内容；沿用现有预算、权限和任务检查点，先核对不确定动作，不重复已完成操作。'})]),
        source:Object.freeze({kind:'cordis-host-runner'}) }));
      this.runtime.store.event('ime.recovery.sent', {sessionId:id,turn:state.turn,sent:state.sent});
    } catch {
      if (!this.closed) this.runtime.store.event('ime.recovery.failed', {sessionId:id,turn:state.turn,reason:'DISPATCH_FAILED'});
    } finally { state.pending = false; }
  }
}
