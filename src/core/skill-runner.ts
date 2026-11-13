import { randomUUID } from 'node:crypto';
import type { Runtime } from './runtime.js';
import type { SkillDocument } from './knowledge.js';
export class SkillRunner {
  constructor(private runtime:Runtime){}
  private observe(taskId:string,id:string,version:number,outcome:'success'|'failure') {
    try {
      const task=this.runtime.tasks.get(taskId);
      if(task.session_id==='ime:evaluation')return;
      this.runtime.knowledge.recordObservation({skillId:id,version,taskId,sessionId:task.session_id,outcome,evidenceRefs:[]});
    } catch { /* learning statistics must never change task execution */ }
  }
  async run(taskId:string,id:string,version:number,signal?:AbortSignal) {
    const skill=this.runtime.knowledge.skill(id,version);
    if(skill.status!=='published')throw new Error('SKILL_NOT_PUBLISHED');
    try{const result=await this.execute(taskId,skill.document,signal);this.runtime.store.db.prepare('INSERT INTO skill_runs VALUES(?,?,?,?,?,?)').run(randomUUID(),id,version,taskId,'success',new Date().toISOString());this.observe(taskId,id,version,'success');return result;}
    catch(error){this.runtime.store.db.prepare('INSERT INTO skill_runs VALUES(?,?,?,?,?,?)').run(randomUUID(),id,version,taskId,'failure',new Date().toISOString());this.observe(taskId,id,version,'failure');this.runtime.knowledge.rollback(id,version);throw error;}
  }
  async execute(taskId:string,skill:SkillDocument,signal?:AbortSignal) {
    const desktop=this.runtime.desktop;
    if(!desktop)throw new Error('DESKTOP_UNAVAILABLE');
    const task=this.runtime.tasks.get(taskId);
    if(task.app!==skill.app)throw new Error('SKILL_APP_MISMATCH');
    const before=await desktop.observe(task.app,signal ?? new AbortController().signal);
    if(!this.runtime.knowledge.verifyObservation(skill,before))throw new Error('SKILL_PRECONDITION_FAILED');
    let precondition=skill.precondition;
    for(const step of skill.steps) {
      await desktop.run(taskId,{...step,id:randomUUID(),app:skill.app,expectedFingerprint:skill.fingerprint,precondition,assertState:step.expectedState},observation=>observation.fingerprint===skill.fingerprint&&observation.state===step.expectedState,signal);
      precondition=step.expectedState;
    }
    return this.runtime.tasks.latest(taskId);
  }
}
