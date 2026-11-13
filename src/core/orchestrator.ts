import type { Runtime } from './runtime.js';
import { money } from './cost.js';
import { textField } from './knowledge.js';

export interface SubtaskSpec {goal:string;app:string;limit:string;dependsOn?:number[];skill?:{id:string;version:number;bindings?:Record<string,string>}}
export interface SkillAssignment {taskId:string;skillId:string;version:number;bindings?:Record<string,string>}
/** Dependency-aware bounded concurrency; desktop work still shares one lease. */
export class TaskOrchestrator {
  private runs=new Map<string,Promise<unknown>>();
  constructor(private runtime:Runtime){}
  create(parentId:string,specs:SubtaskSpec[]) {
    const parent=this.runtime.tasks.get(parentId);
    if(parent.status!=='running'||!Array.isArray(specs)||specs.length<1||specs.length>20)throw Error('INVALID_SUBTASKS');
    const budget=this.runtime.store.db.prepare('SELECT currency FROM budgets WHERE task_id=?').get(parentId)!;
    for(let i=0;i<specs.length;i++) {
      const spec=specs[i]!;
      if(!spec||!this.runtime.allowApps.includes(spec.app)||!Array.isArray(spec.dependsOn??[])||(spec.dependsOn??[]).some(index=>!Number.isSafeInteger(index)||index<0||index>=i))throw Error('INVALID_SUBTASK_DEPENDENCIES');
      textField(spec.goal);money(spec.limit);
    }
    const ids:string[]=[];
    // The durable graph is committed only after every spec validates.
    this.runtime.store.transaction(()=>{for(const spec of specs) {
      const child=this.runtime.tasks.create(parent.session_id,spec.goal,spec.app,spec.limit,String(budget.currency),(spec.dependsOn??[]).map(index=>ids[index]!));
      this.runtime.store.db.prepare('INSERT INTO task_children VALUES(?,?)').run(parentId,child.id);
      this.runtime.tasks.transition(child.id,'ready');ids.push(child.id);
    }});
    return ids;
  }
  descendants(parentId:string):string[] {
    return this.runtime.store.db.prepare(`WITH RECURSIVE children(id) AS (SELECT child_id FROM task_children WHERE parent_id=?
      UNION SELECT c.child_id FROM task_children c JOIN children p ON c.parent_id=p.id) SELECT id FROM children`).all(parentId).map(row=>String(row.id));
  }
  run(parentId:string,handler:(taskId:string)=>Promise<unknown>,concurrency=2):Promise<unknown> {
    if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>8)throw Error('INVALID_CONCURRENCY');
    if(this.runs.has(parentId))throw Error('TASK_GROUP_RUNNING');
    const work=this.execute(parentId,handler,concurrency);this.runs.set(parentId,work);
    void work.then(()=>this.runs.delete(parentId),()=>this.runs.delete(parentId));return work;
  }
  runSkills(parentId:string,assignments:SkillAssignment[],concurrency=2,signal?:AbortSignal) {
    const children=this.runtime.store.db.prepare('SELECT child_id FROM task_children WHERE parent_id=?').all(parentId).map(row=>String(row.child_id));
    if(!Array.isArray(assignments)||new Set(assignments.map(assignment=>assignment.taskId)).size!==assignments.length)throw Error('INVALID_SUBTASK_ASSIGNMENTS');
    const byTask=new Map(assignments.map(assignment=>{
      if(!children.includes(assignment.taskId)||this.runtime.knowledge.skill(assignment.skillId,assignment.version).status!=='published')throw Error('INVALID_SUBTASK_ASSIGNMENTS');
      return [assignment.taskId,assignment];
    }));
    if(children.some(id=>!['succeeded','failed','cancelled'].includes(this.runtime.tasks.get(id).status)&&!byTask.has(id)))throw Error('SUBTASK_SKILL_REQUIRED');
    return this.run(parentId,async taskId=>{
      const assignment=byTask.get(taskId)!;return this.runtime.skills.run(taskId,assignment.skillId,assignment.version,signal,assignment.bindings);
    },concurrency);
  }
  private async execute(parentId:string,handler:(taskId:string)=>Promise<unknown>,concurrency:number) {
    const children=this.runtime.store.db.prepare('SELECT child_id FROM task_children WHERE parent_id=? ORDER BY rowid').all(parentId).map(row=>String(row.child_id));
    if(!children.length)throw Error('SUBTASKS_REQUIRED');
    const pending=new Set(children),active=new Map<string,Promise<void>>();
    const outcomes:Record<string,string>={};
    while(pending.size||active.size) {
      const parent=this.runtime.tasks.get(parentId);
      if(!this.runtime.executionPaused&&parent.status==='running') {
        for(const id of pending) {
          if(active.size>=concurrency)break;
          const state=this.runtime.tasks.get(id).status;
          if(['succeeded','failed','cancelled'].includes(state)){pending.delete(id);outcomes[id]=state;continue;}
          if(state!=='ready'||this.runtime.tasks.blockers(id).length)continue;
          pending.delete(id);this.runtime.tasks.transition(id,'running');
          const work=Promise.resolve().then(()=>handler(id)).then(()=>{
            if(this.runtime.tasks.get(id).status==='running')this.runtime.tasks.transition(id,'succeeded');
          },()=>{if(this.runtime.tasks.get(id).status==='running')this.runtime.tasks.transition(id,'failed');}).finally(()=>{
            outcomes[id]=this.runtime.tasks.get(id).status;active.delete(id);
          });
          active.set(id,work);
        }
      }
      if(!active.size)break;
      await Promise.race(active.values());
    }
    return {outcomes,pending:[...pending],succeeded:children.every(id=>this.runtime.tasks.get(id).status==='succeeded')};
  }
  async close(){await Promise.allSettled([...this.runs.values()]);}
}
