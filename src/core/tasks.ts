import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { money } from './cost.js';
export type Status = 'created'|'ready'|'running'|'waiting_approval'|'paused'|'recovering'|'succeeded'|'failed'|'cancelled';
export interface Task { id: string; session_id: string; goal: string; app: string; status: Status; updated_at: string }
const transitions: Record<Status, Status[]> = {
  created: ['ready','cancelled'], ready: ['running','cancelled'],
  running: ['waiting_approval','paused','recovering','succeeded','failed','cancelled'],
  waiting_approval: ['paused','cancelled'], paused: ['recovering','cancelled'],
  recovering: ['running','paused','failed','cancelled'], succeeded: [], failed: [], cancelled: [],
};
export class Tasks {
  constructor(private readonly store: Store) {}
  create(sessionId: string, goal: string, app: string, limit: string, currency = 'USD'): Task {
    if (!sessionId.trim() || !goal.trim() || !app.trim() || !/^[A-Z]{3}$/.test(currency)) throw new Error('INVALID_TASK');
    const id = randomUUID();
    this.store.transaction(() => {
      this.store.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(id,sessionId,goal,app,'created',new Date().toISOString());
      this.store.db.prepare('INSERT INTO budgets(task_id,currency,limit_amount) VALUES(?,?,?)').run(id,currency,money(limit));
      this.store.event('ime.task.created', { taskId: id, sessionId });
    });
    return this.get(id);
  }
  get(id: string): Task {
    const row = this.store.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!row) throw new Error('TASK_NOT_FOUND');
    return row as unknown as Task;
  }
  transition(id: string, to: Status): void {
    this.store.transaction(() => {
      const task = this.get(id);
      if (!transitions[task.status].includes(to)) throw new Error(`INVALID_TRANSITION:${task.status}:${to}`);
      this.store.db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run(to,new Date().toISOString(),id);
      this.store.event('ime.task.status', { taskId: id, from: task.status, to });
    });
  }
  checkpoint(taskId: string, cursor: number, fingerprint: string, evidence: string): string {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !evidence || !fingerprint) throw new Error('INVALID_CHECKPOINT');
    const id = randomUUID();
    this.store.db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?,?,?)').run(id,taskId,cursor,fingerprint,evidence,new Date().toISOString());
    this.store.event('ime.checkpoint.saved', { taskId, checkpointId: id, stepCursor: cursor });
    return id;
  }
  latest(taskId: string) {
    return this.store.db.prepare('SELECT * FROM checkpoints WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId);
  }
  recoverAfterCrash(): void {
    this.store.transaction(() => {
      for (const row of this.store.db.prepare("SELECT id FROM tasks WHERE status IN ('running','recovering')").all()) {
        this.store.db.prepare("UPDATE tasks SET status='paused' WHERE id=?").run(String(row.id));
        this.store.event('ime.task.interrupted', { taskId: row.id });
      }
      // Outstanding calls may have reached a Provider; never release these funds automatically.
      this.store.db.prepare("UPDATE actions SET state='uncertain' WHERE state='executing'").run();
    });
  }
  reconcile(taskId:string,actionId:string,occurred:boolean,evidence:string):void {
    if(this.get(taskId).status!=='paused')throw new Error('TASK_MUST_BE_PAUSED');
    if(!evidence.trim())throw new Error('EVIDENCE_REQUIRED');
    this.store.transaction(()=>{
      const row=this.store.db.prepare("SELECT * FROM actions WHERE id=? AND task_id=? AND state='uncertain'").get(actionId,taskId);
      if(!row)throw new Error('ACTION_NOT_UNCERTAIN');
      this.store.db.prepare('UPDATE actions SET state=? WHERE id=?').run(occurred?'reconciled':'not_applied',actionId);
      this.store.event('ime.action.reconciled',{taskId,actionId,occurred,evidence});
    });
  }
  async resume(id: string, verify: (checkpoint: ReturnType<Tasks['latest']>) => Promise<boolean>): Promise<void> {
    this.transition(id, 'recovering');
    try {
      if (this.store.db.prepare("SELECT id FROM actions WHERE task_id=? AND state IN ('executing','uncertain')").get(id)) throw new Error('ACTION_RECONCILIATION_REQUIRED');
      if (!await verify(this.latest(id))) throw new Error('ENVIRONMENT_MISMATCH');
      // Cancellation during async verification must not resurrect the task.
      if (this.get(id).status === 'recovering') this.transition(id,'running');
    } catch (error) { if (this.get(id).status === 'recovering') this.transition(id,'paused'); throw error; }
  }
}
