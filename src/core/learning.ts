import { randomUUID } from 'node:crypto';
import type { Runtime } from './runtime.js';
import { textField } from './knowledge.js';
import type { Price,ModelRequest } from './cost.js';
export interface ReviewReport {failureCategory:string;evidenceRefs:string[];rootCauseHypothesis:string;proposedChange:string;risk:string;verificationPlan:string}
export class SelfReview {
  constructor(private runtime:Runtime){}
  async review(taskId:string,reporter?:()=>Promise<ReviewReport>,pricing?:{price:Price;request:ModelRequest}) {
    const task=this.runtime.tasks.get(taskId);
    const previous=this.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE task_id=?').get(taskId);
    if(Number(previous?.n)>=2)throw new Error('REVIEW_LIMIT');
    const failures=this.runtime.store.db.prepare("SELECT id FROM actions WHERE task_id=? AND state='uncertain'").all(taskId);
    if(!failures.length&&task.status!=='succeeded'&&task.status!=='failed')throw new Error('REVIEW_NOT_TRIGGERED');
    // Reserve review quota before awaiting a model so concurrent callers cannot bypass the count.
    const id=randomUUID();
    this.runtime.store.db.prepare('INSERT INTO reviews VALUES(?,?,?,?,?)').run(id,taskId,'pending','{}',new Date().toISOString());
    let report:ReviewReport;
    try {
      if(reporter) {
        if(!pricing)throw new Error('REVIEW_PRICE_REQUIRED');
        const budget=this.runtime.store.db.prepare('SELECT * FROM budgets WHERE task_id=?').get(taskId)!;
        const amount=Number(this.runtime.costs.quote(pricing.price,pricing.request).amount);
        const spent=this.runtime.store.db.prepare("SELECT COALESCE(SUM(amount),0) AS spent FROM review_costs WHERE task_id=?").get(taskId)!;
        if(amount+Number(spent.spent)>Math.floor(Number(budget.limit_amount)*0.1))throw new Error('REVIEW_BUDGET_DENIED');
        // Reviews use a separate child task to avoid reopening a completed production task.
        const child=this.runtime.tasks.create(task.session_id,'受限自审','ime:review',String(amount),String(budget.currency));
        this.runtime.tasks.transition(child.id,'ready');this.runtime.tasks.transition(child.id,'running');
        this.runtime.store.db.prepare('INSERT INTO review_costs VALUES(?,?,?)').run(id,taskId,amount);
        report=await this.runtime.costs.call(child.id,pricing.price,pricing.request,async()=>({value:await reporter()}));
        this.runtime.tasks.transition(child.id,'succeeded');
      } else {
        report={failureCategory:failures.length?'uncertain_action':'success_sample',evidenceRefs:failures.map(f=>String(f.id)),
          rootCauseHypothesis:failures.length?'动作结果尚未验证，先核对环境和证据':'已完成任务，建议独立回归后提炼技能',
          proposedChange:'保持候选状态；不修改权限或预算',risk:'review_only',verificationPlan:'独立环境至少三次验证，并覆盖环境变化和失败输入'};
      }
      for(const field of ['failureCategory','rootCauseHypothesis','proposedChange','risk','verificationPlan'] as const)textField(report[field],4000);
      if(!Array.isArray(report.evidenceRefs)||!report.evidenceRefs.every(e=>typeof e==='string'))throw new Error('INVALID_REVIEW');
      this.runtime.store.db.prepare('UPDATE reviews SET category=?,report=? WHERE id=?').run(report.failureCategory,JSON.stringify(report),id);
      this.runtime.store.event('ime.review.proposed',{reviewId:id,taskId});return report;
    }catch(error){this.runtime.store.db.prepare("UPDATE reviews SET category='failed' WHERE id=?").run(id);throw error;}
  }
}
