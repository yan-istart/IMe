import { mkdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { Store } from './store.js';
import type { Action, Observation } from './desktop.js';
import { bindSkill, skillVariants, validateParameters } from './skill-parameters.js';
import { HybridSearch } from './hybrid-search.js';
export type MemoryKind = 'fact'|'episode'|'failure'|'procedure'|'preference';
export interface MemoryInput {
  kind: MemoryKind; content: string; app: string; sourceEventIds: string[];
  trust: 'user'|'tool_verified'|'model_inferred'; expiresAt?: string;factKey?:string;
}
export interface SkillDocument {
  goal: string; app: string; fingerprint: string; precondition: string;
  steps: { kind: Action['kind']; target: string; targetParameter?: string; expectedState: string; risk: Action['risk']; timeoutMs: number }[];
  parameters?: Record<string, { values: string[] }>;
  dependencies?: {id:string;version:number}[];
  evidenceRefs: string[];
}
export function digest(data: unknown) { return createHash('sha256').update(JSON.stringify(data)).digest('hex'); }
export function textField(value: unknown, max=20000): string {
  if (typeof value !== 'string' || !value.trim() || value.length>max) throw new Error('INVALID_TEXT');
  return value;
}
/** Stable identity for accumulating different runs of the same app + goal. */
export function skillKey(app: string, goal: string): string {
  const normalized = textField(goal, 20000).normalize('NFKC').toLowerCase()
    .replace(/\s+/gu, ' ').replace(/[。.!！?？:：;；,，]+$/u, '').trim();
  return 'sk-' + digest({ v: 1, app: textField(app, 300), goal: normalized }).slice(0, 32);
}
/**
 * Signature used to decide whether a new successful run belongs to the same
 * executable step graph. Evidence references are intentionally excluded: they
 * change on every run and are tracked as observations instead.
 */
export function skillSignature(document: SkillDocument): string {
  return digest({ goal: document.goal, app: document.app, fingerprint: document.fingerprint,
    precondition: document.precondition, steps: document.steps, parameters: document.parameters,dependencies:document.dependencies });
}
export interface SkillObservationInput {
  skillId: string; version: number; taskId: string; sessionId: string;
  outcome: 'success' | 'failure'; evidenceRefs: string[];
}
export interface SkillStats { successes: number; failures: number; sessions: number; lastSuccessAt: string | null }
export class Knowledge {
  readonly hybrid:HybridSearch;
  constructor(private store: Store) {this.hybrid=new HybridSearch(store);}
  propose(input: MemoryInput): string {
    if (!['fact','episode','failure','procedure','preference'].includes(input.kind)
      || !['user','tool_verified','model_inferred'].includes(input.trust)) throw new Error('INVALID_MEMORY');
    textField(input.content);
    if(/\bsk-[a-zA-Z0-9_-]{16,}|\bBearer\s+[a-zA-Z0-9_.-]{16,}|api[_-]?key\s*[:=]\s*[a-zA-Z0-9_-]{16,}/i.test(input.content))throw new Error('MEMORY_CONTAINS_SECRET');textField(input.app,300);
    if (!Array.isArray(input.sourceEventIds) || !input.sourceEventIds.every(id=>typeof id==='string')) throw new Error('INVALID_EVIDENCE');
    const verifiedTypes = ["'ime.action.finished'", "'ime.action.reconciled'", "'ime.action.failed'", "'ime.experience.recorded'"].join(',');
    if (input.trust==='tool_verified' && (!input.sourceEventIds.length || input.sourceEventIds.some(id=>!this.store.db.prepare(`SELECT id FROM audit_events WHERE id=? AND type IN (${verifiedTypes})`).get(id)))) throw new Error('VERIFIED_EVIDENCE_REQUIRED');
    if (input.expiresAt && (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt)<=Date.now())) throw new Error('INVALID_EXPIRY');
    const id=randomUUID(), now=new Date().toISOString();
    this.store.transaction(()=>{
      this.store.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,input.kind,input.content,input.app,input.trust,
        input.trust==='model_inferred'?'candidate':'active',JSON.stringify(input.sourceEventIds),input.expiresAt ?? null,now,now,0);
      this.store.db.prepare('INSERT INTO memory_fts(id,content,app) VALUES(?,?,?)').run(id,input.content,input.app);
      if(input.factKey){textField(input.factKey,200);this.store.db.prepare('INSERT INTO memory_subjects VALUES(?,?)').run(id,input.factKey);}
      if (input.kind==='fact'&&input.factKey) {
        for (const old of this.store.db.prepare("SELECT m.id FROM memories m JOIN memory_subjects s ON s.memory_id=m.id WHERE m.app=? AND m.kind='fact' AND m.status='active' AND m.id<>? AND m.content<>? AND s.subject=?").all(input.app,id,input.content,input.factKey)) {
          this.store.db.prepare('INSERT OR IGNORE INTO memory_conflicts VALUES(?,?,?)').run(String(old.id),id,'unreviewed');
        }
      }
      this.store.event('ime.memory.proposed',{memoryId:id,trust:input.trust});
    });return id;
  }
  approve(id: string): void {
    if (!this.store.db.prepare("UPDATE memories SET status='active',updated_at=? WHERE id=? AND status='candidate'").run(new Date().toISOString(),id).changes) throw new Error('MEMORY_NOT_CANDIDATE');
    this.store.event('ime.memory.approved',{memoryId:id});
  }
  retrieve(query: string, app: string, limit=5, embedding?:{model:string;vector:number[]}) {
    textField(app,300);
    if (!Number.isSafeInteger(limit) || limit<1 || limit>20) throw new Error('INVALID_LIMIT');
    // FTS query operators never come from model/user text.
    const words=query.match(/[\p{L}\p{N}_]+/gu)?.slice(0,12) ?? [];
    const now=new Date().toISOString();
    const short=words.length>0&&words.every(w=>w.length<3);
    const rows=short?this.store.db.prepare("SELECT * FROM memories WHERE app=? AND status='active' AND (expires_at IS NULL OR expires_at>?) AND content LIKE ? ESCAPE '\\' LIMIT ?").all(app,now,'%'+query.replace(/[\\%_]/g,'\\$&')+'%',limit):words.length ? this.store.db.prepare(`SELECT m.* FROM memory_fts f JOIN memories m ON m.id=f.id
      WHERE memory_fts MATCH ? AND m.app=? AND m.status='active' AND (m.expires_at IS NULL OR m.expires_at>?)
      ORDER BY bm25(memory_fts),m.created_at DESC LIMIT ?`).all(words.map(w=>'"'+w.replaceAll('"','')+'"').join(' OR '),app,now,limit)
      : this.store.db.prepare("SELECT * FROM memories WHERE app=? AND status='active' AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC LIMIT ?").all(app,now,limit);
    const result=this.hybrid.retrieve(query,app,rows,limit,embedding);
    for (const row of result) this.store.db.prepare('UPDATE memories SET uses=uses+1 WHERE id=?').run(String(row.id));
    return result;
  }
  listMemories() {return this.store.db.prepare('SELECT * FROM memories ORDER BY created_at DESC LIMIT 500').all();}
  archive(id:string) {this.store.db.prepare("UPDATE memories SET status='archived' WHERE id=?").run(id);this.store.event('ime.memory.archived',{memoryId:id});}
  resolveConflict(first:string,second:string,winner:string) {
    if(winner!==first&&winner!==second)throw new Error('INVALID_CONFLICT_WINNER');
    this.store.transaction(()=>{
      if(!this.store.db.prepare("SELECT 1 FROM memory_conflicts WHERE first_id=? AND second_id=? AND status='unreviewed'").get(first,second))throw new Error('CONFLICT_NOT_FOUND');
      this.store.db.prepare("UPDATE memories SET status='archived' WHERE id=?").run(winner===first?second:first);
      this.store.db.prepare("UPDATE memory_conflicts SET status='resolved' WHERE first_id=? AND second_id=?").run(first,second);
      this.store.event('ime.memory.conflict_resolved',{first,second,winner});
    });
  }
  deleteMemory(id:string) {
    this.store.transaction(()=>{
      this.store.db.prepare('DELETE FROM memory_subjects WHERE memory_id=?').run(id);
      this.store.db.prepare('DELETE FROM memory_fts WHERE id=?').run(id);
      this.store.db.prepare('DELETE FROM memory_conflicts WHERE first_id=? OR second_id=?').run(id,id);
      this.store.db.prepare('DELETE FROM memories WHERE id=?').run(id);
      this.store.event('ime.memory.deleted',{memoryId:id});
    });
  }
  proposeSkill(document: SkillDocument, skillId:string=randomUUID()): {id:string;version:number} {
    textField(document.goal);textField(document.app,300);textField(document.fingerprint,500);textField(document.precondition,2000);
    if (!Array.isArray(document.steps) || !document.steps.length || document.steps.length>100 || !Array.isArray(document.evidenceRefs) || !document.evidenceRefs.length) throw new Error('INVALID_SKILL');
    for(const s of document.steps) {
      if (!['click','input','scroll'].includes(s.kind) || !['read_only','reversible_write','sensitive_write','irreversible'].includes(s.risk)
        || !Number.isSafeInteger(s.timeoutMs) || s.timeoutMs<1 || s.timeoutMs>60000) throw new Error('INVALID_SKILL_STEP');
      textField(s.target,2000);textField(s.expectedState,2000);
    }
    if (document.evidenceRefs.some(e=>typeof e!=='string'||!e)) throw new Error('INVALID_EVIDENCE');
    validateParameters(document);
    skillVariants(document);
    const dependencies=document.dependencies??[];
    if(!Array.isArray(dependencies)||dependencies.length>20||new Set(dependencies.map(dependency=>JSON.stringify(dependency))).size!==dependencies.length)throw Error('INVALID_SKILL_DEPENDENCIES');
    for(const dependency of dependencies) {
      if(!dependency||typeof dependency.id!=='string'||!Number.isSafeInteger(dependency.version)||dependency.version<1)throw Error('INVALID_SKILL_DEPENDENCIES');
      if(dependency.id===skillId)throw Error('SKILL_SELF_DEPENDENCY');
      this.skill(dependency.id,dependency.version);
    }
    const version=Number(this.store.db.prepare('SELECT MAX(version) AS version FROM skill_versions WHERE skill_id=?').get(skillId)?.version ?? 0)+1;
    this.store.transaction(()=>{
      this.store.db.prepare('INSERT INTO skill_versions VALUES(?,?,?,?,?,?,?)').run(skillId,version,'candidate',JSON.stringify(document),digest(document),null,new Date().toISOString());
      for(const dependency of dependencies)this.store.db.prepare('INSERT INTO skill_dependencies VALUES(?,?,?,?)').run(skillId,version,dependency.id,dependency.version);
      this.store.event('ime.skill.proposed',{skillId,version});
    });return {id:skillId,version};
  }
  /**
   * Record one real run against a skill version. The unique key makes a
   * repeated callback for the same task idempotent, so a retry cannot inflate
   * the accumulated success count.
   */
  recordObservation(input: SkillObservationInput): { recorded: boolean; stats: SkillStats } {
    textField(input.skillId, 200);textField(input.taskId, 200);textField(input.sessionId, 200);
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw new Error('INVALID_VERSION');
    if (!['success', 'failure'].includes(input.outcome)) throw new Error('INVALID_OBSERVATION');
    if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length > 100 || input.evidenceRefs.some(ref => typeof ref !== 'string' || !ref)) throw new Error('INVALID_EVIDENCE');
    const inserted = this.store.db.prepare('INSERT OR IGNORE INTO skill_observations VALUES(?,?,?,?,?,?,?,?)')
      .run(randomUUID(), input.skillId, input.version, input.taskId, input.sessionId, input.outcome, JSON.stringify(input.evidenceRefs), new Date().toISOString());
    const recorded = Number(inserted.changes) > 0;
    if (recorded) {
      this.store.event('ime.skill.observed', { skillId: input.skillId, version: input.version, taskId: input.taskId, outcome: input.outcome });
      this.monitor(input.skillId, input.version);
    }
    return { recorded, stats: this.skillStats(input.skillId, input.version) };
  }
  skillStats(id: string, version: number): SkillStats {
    textField(id, 200);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('INVALID_VERSION');
    const row = this.store.db.prepare(`SELECT
        SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN outcome='failure' THEN 1 ELSE 0 END) AS failures,
        COUNT(DISTINCT session_id) AS sessions,
        MAX(CASE WHEN outcome='success' THEN created_at END) AS last_success_at
      FROM skill_observations WHERE skill_id=? AND version=?`).get(id, version);
    return { successes: Number(row?.successes ?? 0), failures: Number(row?.failures ?? 0),
      sessions: Number(row?.sessions ?? 0), lastSuccessAt: row?.last_success_at ? String(row.last_success_at) : null };
  }
  /**
   * Publication without the independent test harness requires accumulated real
   * evidence: several successful runs from at least two sessions and a high
   * success rate. It still must be an explicit user review; the model has no
   * tool for this operation.
   */
  reviewEligibility(id: string, version: number, minSuccesses = 3) {
    if (!Number.isSafeInteger(minSuccesses) || minSuccesses < 2 || minSuccesses > 20) throw new Error('INVALID_MIN_SUCCESSES');
    const skill = this.skill(id, version);
    const stats = this.skillStats(id, version);
    const evaluation = this.store.db.prepare('SELECT report FROM skill_evaluations WHERE skill_id=? AND version=? ORDER BY rowid DESC LIMIT 1').get(id, version);
    const evaluationReport = evaluation ? JSON.parse(String(evaluation.report)) as { passed?: unknown; state?: unknown } : null;
    const failedEvaluation = evaluationReport?.passed === false;
    const evaluationRunning = evaluationReport?.state === 'running';
    const parameterized = Object.keys(skill.document.parameters ?? {}).length > 0;
    const eligible = skill.status === 'candidate' && !parameterized && !evaluationRunning && !failedEvaluation
      && stats.successes >= minSuccesses && stats.sessions >= 2
      && stats.failures * 5 <= stats.successes + stats.failures;
    return { eligible, reason: eligible ? null : skill.status !== 'candidate' ? 'SKILL_NOT_CANDIDATE'
      : parameterized ? 'PARAMETER_EVALUATION_REQUIRED'
      : evaluationRunning ? 'EVALUATION_IN_PROGRESS'
      : failedEvaluation ? 'EVALUATION_FAILED'
      : stats.successes < minSuccesses ? 'INSUFFICIENT_SUCCESSES'
      : stats.sessions < 2 ? 'INSUFFICIENT_SESSIONS' : 'FAILURE_RATE_TOO_HIGH', stats };
  }
  publishReviewed(id: string, version: number, note: string, minSuccesses = 3) {
    const skill = this.skill(id, version);
    const eligibility = this.reviewEligibility(id, version, minSuccesses);
    if (!eligibility.eligible) throw new Error(eligibility.reason ?? 'SKILL_NOT_ELIGIBLE');
    this.assertDependencies(id,version);
    const reviewNote = textField(note, 2000);
    this.store.transaction(() => {
      this.store.db.prepare('INSERT INTO skill_reviews VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), id, version, 'published', reviewNote, new Date().toISOString());
      this.retirePublished(id);
      this.store.db.prepare("UPDATE skill_versions SET status='published' WHERE skill_id=? AND version=?").run(id, version);
      this.store.event('ime.skill.review_published', { skillId: id, version, hash: skill.hash,
        successes: eligibility.stats.successes, sessions: eligibility.stats.sessions, note: reviewNote });
    });
    this.exportPublished(id, version);
    return this.skill(id, version);
  }
  skill(id:string,version?:number): {id:string;version:number;status:string;document:SkillDocument;hash:string} {
    const row=version ? this.store.db.prepare('SELECT * FROM skill_versions WHERE skill_id=? AND version=?').get(id,version)
      : this.store.db.prepare('SELECT * FROM skill_versions WHERE skill_id=? ORDER BY version DESC LIMIT 1').get(id);
    if(!row) throw new Error('SKILL_NOT_FOUND');
    const document=JSON.parse(String(row.document)) as SkillDocument;
    if(digest(document)!==row.hash) throw new Error('SKILL_SIGNATURE_MISMATCH');
    return {id,version:Number(row.version),status:String(row.status),document,hash:String(row.hash)};
  }
  listSkills() {return this.store.db.prepare(`SELECT s.*,
      (SELECT COUNT(*) FROM skill_runs r WHERE r.skill_id=s.skill_id AND r.version=s.version AND outcome='success') AS success_count,
      (SELECT COUNT(*) FROM skill_runs r WHERE r.skill_id=s.skill_id AND r.version=s.version AND outcome='failure') AS failure_count,
      (SELECT COUNT(*) FROM skill_observations o WHERE o.skill_id=s.skill_id AND o.version=s.version AND o.outcome='success') AS observation_success_count,
      (SELECT COUNT(*) FROM skill_observations o WHERE o.skill_id=s.skill_id AND o.version=s.version AND o.outcome='failure') AS observation_failure_count,
      (SELECT COUNT(DISTINCT o.session_id) FROM skill_observations o WHERE o.skill_id=s.skill_id AND o.version=s.version) AS observation_session_count,
      (SELECT report FROM skill_evaluations e WHERE e.skill_id=s.skill_id AND e.version=s.version ORDER BY rowid DESC LIMIT 1) AS evaluation
      FROM skill_versions s ORDER BY created_at DESC LIMIT 500`).all();}
  match(app:string,fingerprint:string) {
    return this.store.db.prepare("SELECT * FROM skill_versions WHERE status='published' ORDER BY version DESC").all().flatMap(row=>{
      const s=this.skill(String(row.skill_id),Number(row.version));
      try{this.assertDependencies(s.id,s.version);}catch{return [];}
      return s.document.app===app&&s.document.fingerprint===fingerprint?[s]:[];
    }).slice(0,2);
  }
  suggest(app: string, limit = 2) {
    textField(app,300);
    if(!Number.isSafeInteger(limit)||limit<1||limit>5)throw Error('INVALID_LIMIT');
    return this.store.db.prepare("SELECT * FROM skill_versions WHERE status='published' AND json_extract(document,'$.app')=? ORDER BY created_at DESC LIMIT ?")
      .all(app,limit).map(row=>this.skill(String(row.skill_id),Number(row.version))).filter(skill=>{try{this.assertDependencies(skill.id,skill.version);return true;}catch{return false;}});
  }
  async evaluate(id:string,version:number,cases: readonly string[],run:(s:SkillDocument,caseId:string)=>Promise<boolean|{passed:boolean;evidenceRefs:string[]}>) {
    const skill=this.skill(id,version);
    if(!['candidate','verified'].includes(skill.status) || cases.length<3 || new Set(cases).size!==cases.length || cases.length>20) throw new Error('INVALID_EVALUATION');
    for(const caseId of cases)textField(caseId,200);
    const variants = skillVariants(skill.document);
    const pending=this.store.db.prepare('SELECT report FROM skill_evaluations WHERE skill_id=? AND version=? ORDER BY rowid DESC LIMIT 1').get(id,version);
    if(pending&&JSON.parse(String(pending.report)).state==='running')throw new Error('EVALUATION_IN_PROGRESS');
    const evaluationId=randomUUID();
    this.store.db.prepare('INSERT INTO skill_evaluations VALUES(?,?,?,?,?)').run(evaluationId,id,version,JSON.stringify({state:'running',hash:skill.hash}),new Date().toISOString());
    const results=[];
    for(const caseId of cases) {
      textField(caseId,200);
      for (const bindings of variants) {
        let passed=false;let evidenceRefs:string[]=[];
        try{const result=await run(structuredClone(bindSkill(skill.document,bindings)),caseId);if(typeof result==='boolean')passed=result;else{passed=result.passed;evidenceRefs=result.evidenceRefs;if(!Array.isArray(evidenceRefs)||!evidenceRefs.every(r=>typeof r==='string'))throw Error('INVALID_EVALUATION_EVIDENCE');}}catch{passed=false;}
        results.push({caseId,bindings,passed,evidenceRefs});
      }
    }
    const passed=results.every(r=>r.passed);
    this.store.db.prepare('UPDATE skill_evaluations SET report=? WHERE id=?').run(JSON.stringify({hash:skill.hash,results,passed,state:'finished'}),evaluationId);
    this.store.db.prepare('UPDATE skill_versions SET status=? WHERE skill_id=? AND version=?').run(passed?'verified':'candidate',id,version);
    this.store.event('ime.skill.evaluated',{skillId:id,version,passed});return {passed,results};
  }
  publish(id:string,version:number) {
    const skill=this.skill(id,version);if(skill.status!=='verified') throw new Error('SKILL_NOT_VERIFIED');
    const row=this.store.db.prepare('SELECT report FROM skill_evaluations WHERE skill_id=? AND version=? ORDER BY rowid DESC LIMIT 1').get(id,version);
    const report=row?JSON.parse(String(row.report)):null;
    if(!report?.passed||report.hash!==skill.hash)throw new Error('VERIFIED_EVIDENCE_REQUIRED');
    this.assertDependencies(id,version);
    this.store.transaction(()=>{
      this.retirePublished(id);
      this.store.db.prepare("UPDATE skill_versions SET status='published' WHERE skill_id=? AND version=?").run(id,version);
      this.store.event('ime.skill.published',{skillId:id,version,hash:skill.hash});
    });
    this.exportPublished(id,version);
    return this.skill(id,version);
  }
  private exportPublished(id:string,version:number) {
    const dir=join(this.store.dir,'skills');mkdirSync(dir,{recursive:true,mode:0o700});
    writeFileSync(join(dir,digest(id)+'-v'+version+'.json'),JSON.stringify(this.skill(id,version)),{mode:0o600});
  }
  private retirePublished(id:string) {
    const previous=this.store.db.prepare("SELECT version FROM skill_versions WHERE skill_id=? AND status='published'").all(id);
    this.store.db.prepare("UPDATE skill_versions SET status='deprecated' WHERE skill_id=? AND status='published'").run(id);
    for(const version of previous)this.blockDependents(id,Number(version.version));
  }
  private blockDependents(id:string,version:number) {
    const dependents=this.store.db.prepare(`WITH RECURSIVE affected(skill_id,version) AS (
      SELECT skill_id,version FROM skill_dependencies WHERE depends_on=? AND depends_version=? UNION
      SELECT d.skill_id,d.version FROM skill_dependencies d JOIN affected a ON d.depends_on=a.skill_id AND d.depends_version=a.version
    ) SELECT skill_id,version FROM affected`).all(id,version);
    for(const dependent of dependents) {
      const changed=this.store.db.prepare("UPDATE skill_versions SET status='deprecated' WHERE skill_id=? AND version=? AND status='published'").run(String(dependent.skill_id),Number(dependent.version));
      if(changed.changes)this.store.event('ime.skill.dependency_blocked',{skillId:dependent.skill_id,version:dependent.version,dependencyId:id,dependencyVersion:version});
    }
  }
  rollback(id:string,version:number) {
    const current=this.skill(id,version);if(current.status!=='published')throw new Error('SKILL_NOT_PUBLISHED');
    const previous=this.store.db.prepare("SELECT version FROM skill_versions WHERE skill_id=? AND version<? AND status='deprecated' ORDER BY version DESC").all(id,version)
      .find(row=>{try{this.assertDependencies(id,Number(row.version));return true;}catch{return false;}});
    this.store.transaction(()=>{
      this.store.db.prepare("UPDATE skill_versions SET status='rolled_back' WHERE skill_id=? AND version=?").run(id,version);
      if(previous)this.store.db.prepare("UPDATE skill_versions SET status='published' WHERE skill_id=? AND version=?").run(id,Number(previous.version));
      this.blockDependents(id,version);
      this.store.event('ime.skill.rolled_back',{skillId:id,version,restored:previous?.version ?? null});
    });
    this.exportPublished(id,version);
    if(previous)this.exportPublished(id,Number(previous.version));
  }
  assertDependencies(id:string,version:number):void {
    const visiting=new Set<string>(),visited=new Set<string>();
    const walk=(skillId:string,skillVersion:number,depth:number)=>{
      if(depth&&skillId===id)throw Error('SKILL_SELF_DEPENDENCY');
      const key=JSON.stringify([skillId,skillVersion]);if(visiting.has(key))throw Error('SKILL_DEPENDENCY_CYCLE');if(visited.has(key))return;
      if(depth>20||visited.size>100)throw Error('SKILL_DEPENDENCY_LIMIT');visiting.add(key);
      const skill=this.skill(skillId,skillVersion);
      if(depth&&skill.status!=='published')throw Error('SKILL_DEPENDENCY_UNAVAILABLE');
      for(const dependency of skill.document.dependencies??[])walk(dependency.id,dependency.version,depth+1);
      visiting.delete(key);visited.add(key);
    };
    walk(id,version,0);
  }
  /** A rolling window also catches regressions reported outside SkillRunner. */
  private monitor(id: string, version: number): void {
    const row = this.store.db.prepare('SELECT status FROM skill_versions WHERE skill_id=? AND version=?').get(id, version);
    if (row?.status !== 'published') return;
    const recent = this.store.db.prepare('SELECT outcome FROM skill_observations WHERE skill_id=? AND version=? ORDER BY rowid DESC LIMIT 20').all(id, version);
    const successes = recent.filter(item => item.outcome === 'success').length;
    if (recent.length >= 5 && successes / recent.length < 0.8) {
      this.rollback(id, version);
      this.store.event('ime.skill.regression', { skillId: id, version, samples: recent.length, successes });
    }
  }
  maintainSkills(now=Date.now()) {
    const groups=new Map<string,ReturnType<Knowledge['skill']>[]>();let merged=0,retired=0;
    for(const row of this.store.db.prepare("SELECT skill_id,version,created_at FROM skill_versions WHERE status IN ('candidate','verified','published') ORDER BY rowid DESC").all()) {
      const skill=this.skill(String(row.skill_id),Number(row.version));
      if(skill.status==='candidate'&&now-Date.parse(String(row.created_at))>30*86400000&&this.skillStats(skill.id,skill.version).successes===0) {
        this.store.db.prepare("UPDATE skill_versions SET status='deprecated' WHERE skill_id=? AND version=?").run(skill.id,skill.version);retired++;continue;
      }
      const signature=skillSignature(skill.document),group=groups.get(signature)??[];group.push(skill);groups.set(signature,group);
    }
    for(const group of groups.values()) {
      const priority:Record<string,number>={published:3,verified:2,candidate:1};group.sort((a,b)=>priority[b.status]!-priority[a.status]!);
      const keep=group[0]!;
      for(const duplicate of group.slice(1)) {
        this.store.db.prepare("UPDATE skill_versions SET status='deprecated' WHERE skill_id=? AND version=?").run(duplicate.id,duplicate.version);merged++;
        if(duplicate.status==='published')this.blockDependents(duplicate.id,duplicate.version);
        this.store.event('ime.skill.merged',{skillId:duplicate.id,version:duplicate.version,keptSkillId:keep.id,keptVersion:keep.version});
      }
    }
    this.store.event('ime.skill.maintenance',{merged,retired});return {merged,retired};
  }
  verifyObservation(skill:SkillDocument,observation:Observation) {return observation.fingerprint===skill.fingerprint&&observation.state===skill.precondition;}
}
