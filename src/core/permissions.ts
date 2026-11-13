import { randomUUID } from 'node:crypto';
import { digest } from './knowledge.js';
import type { Action } from './desktop.js';
import type { Store } from './store.js';
export class Permissions {
  constructor(private store:Store){}
  request(taskId:string,action:Action): string {
    const hash=digest({taskId,action});
    const existing=this.store.db.prepare("SELECT id FROM approvals WHERE task_id=? AND action_hash=? AND status IN ('pending','approved') AND expires_at>?").get(taskId,hash,new Date().toISOString());
    if(existing)return String(existing.id);
    const id=randomUUID();this.store.db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?,?,?)')
      .run(id,taskId,hash,'pending',new Date(Date.now()+300000).toISOString(),JSON.stringify(action),new Date().toISOString());
    this.store.event('ime.approval.requested',{approvalId:id,taskId});return id;
  }
  decide(id:string,allow:boolean) {
    const row=this.store.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);
    if(!row||row.status!=='pending'||String(row.expires_at)<=new Date().toISOString())throw new Error('APPROVAL_EXPIRED');
    this.store.db.prepare('UPDATE approvals SET status=? WHERE id=?').run(allow?'approved':'denied',id);
    this.store.event('ime.approval.decided',{approvalId:id,approved:allow});return row;
  }
  consume(taskId:string,action:Action):boolean {
    const hash=digest({taskId,action});
    const row=this.store.db.prepare("SELECT id FROM approvals WHERE task_id=? AND action_hash=? AND status='approved' AND expires_at>?").get(taskId,hash,new Date().toISOString());
    if(!row)return false;
    return Boolean(this.store.db.prepare("UPDATE approvals SET status='consumed' WHERE id=? AND status='approved'").run(String(row.id)).changes);
  }
  approved(taskId:string,action:Action):boolean {
    return Boolean(this.store.db.prepare("SELECT id FROM approvals WHERE task_id=? AND action_hash=? AND status='approved' AND expires_at>?").get(taskId,digest({taskId,action}),new Date().toISOString()));
  }
}
