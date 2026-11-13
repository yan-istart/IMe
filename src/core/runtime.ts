import type { RecoveryConfig } from '../adapters/recovery.js';
import {validateConfig} from './config.js';
import { VisionPipeline,type VisionConfig } from './vision-pipeline.js';
import { Knowledge, skillKey, skillSignature, type SkillDocument } from './knowledge.js';
import { Permissions } from './permissions.js';
import { ContextOptimizer,type ContextConfig } from './context.js';
import { SelfReview } from './learning.js';
import { ModelRouter,type ModelRoute } from './router.js';
import { SkillRunner } from './skill-runner.js';
import { DesktopLease } from './lease.js';
import type { DesktopToolConfig } from '../adapters/desktop-tools.js';
import type { ModelBudgetConfig } from '../adapters/model-gateway.js';
import { mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Store } from './store.js';
import { Tasks } from './tasks.js';
import { CostGateway } from './cost.js';
import { RuntimeSettings, type SettingsSeed } from './settings.js';
import { DesktopController, type DesktopPort } from './desktop.js';
import { ExperienceRecorder } from './experience.js';
export interface LearningConfig {
  minSuccesses: number;
  autoPublish: boolean;
  captureHostExperience: boolean;
  captureToolPrefixes: string[];
}
export interface RuntimeConfig { dataDir?: string; allowApps?: string[]; modelBudget?: ModelBudgetConfig;
  desktopAdapter?:DesktopToolConfig;context?:Partial<ContextConfig>;routes?:ModelRoute[];
  budgetCaps?:{scope:'session'|'day'|'account';key:string;currency:string;limit:string}[];
  budgetTimezone?:string;desktopLeasePath?:string;vision?:Partial<VisionConfig>; dashboard?:{enabled?:boolean;port?:number};taskDefaultLimit?:string;evaluation?:{app:string;cases:string[]};
  learning?:Partial<LearningConfig>;
  recovery?:RecoveryConfig;
}
export class Runtime {
  readonly allowApps:string[];
  readonly settings: RuntimeSettings;
  readonly store: Store;
  readonly tasks: Tasks;
  readonly knowledge:Knowledge;
  readonly permissions:Permissions;
  readonly context:ContextOptimizer;
  readonly review:SelfReview;
  readonly router:ModelRouter;
  readonly skills:SkillRunner;
  readonly vision:VisionPipeline;
  readonly costs: CostGateway;
  readonly desktop: DesktopController | undefined;
  readonly evaluation:RuntimeConfig['evaluation'];
  readonly learning: LearningConfig;
  readonly experience: ExperienceRecorder;
  private lockPath: string;
  private closed = false;
  executionPaused = false;
  constructor(config: RuntimeConfig = {}, provider?: DesktopPort) {
    config=validateConfig(config);
    if (config.allowApps !== undefined && (!Array.isArray(config.allowApps) || !config.allowApps.every(a => typeof a === 'string' && a.trim()))) throw new Error('INVALID_ALLOW_APPS');
    this.evaluation=config.evaluation?structuredClone(config.evaluation):undefined;
    this.learning={minSuccesses:3,autoPublish:false,captureHostExperience:true,captureToolPrefixes:[],
      ...config.learning,...config.learning?.captureToolPrefixes?{captureToolPrefixes:[...config.learning.captureToolPrefixes]}:{}};
    const path = config.dataDir ?? '~/.dsh/ime-v1';
    if (typeof path !== 'string' || !path) throw new Error('INVALID_DATA_DIR');
    const dir = resolve(path.startsWith('~/') ? join(homedir(),path.slice(2)) : path);
    mkdirSync(dir,{ recursive:true, mode:0o700 });
    const seed: SettingsSeed = {};
    if (config.allowApps !== undefined) seed.allowApps = config.allowApps;
    if (config.taskDefaultLimit !== undefined) seed.taskDefaultLimit = config.taskDefaultLimit;
    if (config.budgetTimezone !== undefined) seed.budgetTimezone = config.budgetTimezone;
    if (config.modelBudget !== undefined) seed.modelBudget = config.modelBudget;
    this.settings = new RuntimeSettings(dir, seed);
    this.allowApps = this.settings.allowApps;
    this.lockPath = join(dir,'runtime.lock');
    // Exclusive ownership prevents one runtime's startup recovery from changing another's live tasks.
    // Crash leaves the lock intact: operator must confirm old process is stopped before removal.
    const fd = openSync(this.lockPath,'wx',0o600);
    try { writeFileSync(fd,JSON.stringify({ pid:process.pid,startedAt:new Date().toISOString() })); }
    finally { closeSync(fd); }
    let opened:Store|undefined;
    try {
      this.store = opened = new Store(dir);
      this.tasks = new Tasks(this.store);
      this.costs = new CostGateway(this.store,() => this.settings.budgetTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
      for(const cap of config.budgetCaps ?? [])this.costs.setLimit(cap.scope,cap.key,cap.currency,cap.limit);
      this.knowledge=new Knowledge(this.store);this.permissions=new Permissions(this.store);
      this.context=new ContextOptimizer(this,config.context);this.review=new SelfReview(this);
      this.router=new ModelRouter(config.routes ?? []);this.skills=new SkillRunner(this);
      this.experience=new ExperienceRecorder(this,{enabled:this.learning.captureHostExperience,
        prefixes:config.desktopAdapter?[config.desktopAdapter.toolPrefix,...this.learning.captureToolPrefixes]:[...this.learning.captureToolPrefixes]});
      this.vision=new VisionPipeline(join(dir,'frames'),{threshold:0.12,maxKeyframesPerMinute:12,retentionMs:86400000,storeFrames:false,...config.vision});this.vision.cleanup();
      this.tasks.recoverAfterCrash();
      this.desktop = provider ? new DesktopController(this.store,this.tasks,provider,this.allowApps,this.permissions,new DesktopLease(config.desktopLeasePath ?? join(homedir(),'.dsh','ime-desktop.lock')),taskId=>{
        const count=this.store.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE type='ime.action.failed' AND json_extract(data,'$.taskId')=?").get(taskId);
        if(Number(count?.n)>=2)void this.review.review(taskId).catch(()=>{});
        // Persist a verified failure experience once per task, not once per failed action.
        if(Number(count?.n)===2) {
          try {
            const task=this.tasks.get(taskId);
            const failed=this.store.db.prepare("SELECT id FROM audit_events WHERE type='ime.action.failed' AND json_extract(data,'$.taskId')=? ORDER BY seq DESC LIMIT 1").get(taskId);
            const content=`应用 ${task.app} 的任务「${task.goal}」出现未验证动作，需要重新核对环境、前置条件和业务断言。`;
            if(failed&&!this.store.db.prepare('SELECT id FROM memories WHERE app=? AND content=? LIMIT 1').get(task.app,content))
              this.knowledge.propose({kind:'failure',content,app:task.app,trust:'tool_verified',sourceEventIds:[String(failed.id)]});
          } catch { /* failure learning must not change task execution */ }
        }
      },(frame,reason)=>{
        const selected=this.vision.process(frame,{reason,...config.vision?.roi?{roi:config.vision.roi}:{},...config.vision?.redact?{redact:config.vision.redact}:{}});
        this.store.event('ime.vision.frame',{app:frame.app,selected:selected.selected,reason});
        return 'evidenceRef' in selected?selected.evidenceRef:undefined;
      }) : undefined;
    } catch (error) { try{opened?.close();}finally{unlinkSync(this.lockPath);}throw error; }
  }
  /**
   * Turn one successful managed task into accumulation evidence.
   *
   * The skill id is derived from app + normalized goal, so a repeated task
   * updates the same skill instead of creating unrelated one-off candidates.
   * A version is only added when the executable step graph changes; otherwise
   * the run is recorded as an observation against the existing version.
   */
  candidate(taskId: string): string {
    const task = this.tasks.get(taskId);
    if (task.status !== 'succeeded') throw new Error('SUCCESS_REQUIRED');
    const steps = this.store.db.prepare("SELECT id,data FROM actions WHERE task_id=? AND state='verified' ORDER BY rowid").all(taskId);
    if (!steps.length) throw new Error('VERIFIED_EVIDENCE_REQUIRED');
    const id = skillKey(task.app, task.goal);
    const latest = this.tasks.latest(taskId);
    if (!latest) throw new Error('VERIFIED_EVIDENCE_REQUIRED');
    const evidenceRefs = this.store.db.prepare('SELECT evidence FROM checkpoints WHERE task_id=? ORDER BY rowid').all(taskId).map(r => String(r.evidence));
    let version = 1;
    let recorded = false;
    const first = JSON.parse(String(steps[0]!.data));
    if (first.beforeState && steps.every(s => JSON.parse(String(s.data)).verifiedState)) {
      const document: SkillDocument = { goal:task.goal,app:task.app,fingerprint:String(latest.fingerprint),precondition:first.beforeState,
        steps:steps.map(s=>{const a=JSON.parse(String(s.data));return {kind:a.kind,target:a.target,risk:a.risk,timeoutMs:a.timeoutMs,expectedState:a.verifiedState};}),
        evidenceRefs };
      const latestVersion = this.store.db.prepare('SELECT version,document,status FROM skill_versions WHERE skill_id=? ORDER BY version DESC LIMIT 1').get(id);
      if (latestVersion) {
        const previous = JSON.parse(String(latestVersion.document)) as SkillDocument;
        const reusable = ['candidate','verified','published'].includes(String(latestVersion.status));
        version = reusable && skillSignature(previous) === skillSignature(document)
          ? Number(latestVersion.version) : this.knowledge.proposeSkill(document,id).version;
      } else {
        version = this.knowledge.proposeSkill(document,id).version;
      }
      recorded = this.knowledge.recordObservation({ skillId:id,version,taskId,sessionId:task.session_id,
        outcome:'success',evidenceRefs }).recorded;
    }
    this.store.transaction(() => {
      const data = { goal:task.goal,appFingerprint:latest.fingerprint,skillKey:id,version,
        steps: steps.map(row => ({ actionId:row.id, action:JSON.parse(String(row.data)) })),evidenceRefs };
      this.store.db.prepare('INSERT OR REPLACE INTO skills VALUES(?,?,?,?,?)').run(id,taskId,'candidate',version,JSON.stringify(data));
      this.store.event('ime.skill.proposed',{ taskId,skillId:id,status:'candidate',version,recorded });
    });
    if (recorded && this.learning.autoPublish) {
      try {
        const eligibility = this.knowledge.reviewEligibility(id,version,this.learning.minSuccesses);
        if (eligibility.eligible) this.knowledge.publishReviewed(id,version,'自动发布策略：已累积多次独立成功运行',this.learning.minSuccesses);
      } catch (error) {
        this.store.event('ime.skill.auto_publish_failed',{skillId:id,version,message:error instanceof Error?error.message:'AUTO_PUBLISH_FAILED'});
      }
    }
    const evidence=this.store.db.prepare("SELECT id FROM audit_events WHERE type='ime.action.finished' AND json_extract(data,'$.taskId')=? ORDER BY seq DESC LIMIT 1").get(taskId);
    const episode=task.goal+'；完成验证的步骤：'+steps.length;
    if(evidence&&!this.store.db.prepare('SELECT id FROM memories WHERE app=? AND content=? LIMIT 1').get(task.app,episode)) {
      this.knowledge.propose({kind:'episode',content:episode,app:task.app,trust:'tool_verified',sourceEventIds:[String(evidence.id)]});
    }
    void this.review.review(taskId).catch(()=>{});
    return id;
  }
  async evaluateSkill(id:string,version:number) {
    const config=this.evaluation,skill=this.knowledge.skill(id,version);
    if(!config||config.app!==skill.document.app||!this.desktop)throw Error('INDEPENDENT_TEST_ENVIRONMENT_REQUIRED');
    return this.knowledge.evaluate(id,version,config.cases,async(document,caseId)=>{
      await this.desktop!.reset(config.app,caseId,new AbortController().signal);
      const task=this.tasks.create('ime:evaluation',document.goal,config.app,'0');this.tasks.transition(task.id,'ready');this.tasks.transition(task.id,'running');
      try{await this.skills.execute(task.id,document);this.tasks.transition(task.id,'succeeded');return {passed:true,evidenceRefs:[task.id,String(this.tasks.latest(task.id)?.id)]};}
      catch{if(this.tasks.get(task.id).status==='running')this.tasks.transition(task.id,'failed');return false;}
    });
  }
  /**
   * Read the current app state without acting. The checkpoint is what lets the
   * next pre-step match L4 skills before the first action of a fresh task.
   */
  async observe(taskId: string, signal?: AbortSignal) {
    const task = this.tasks.get(taskId);
    if (!this.desktop) throw new Error('DESKTOP_UNAVAILABLE');
    if (task.status !== 'running') throw new Error('TASK_NOT_RUNNING');
    const observation = await this.desktop.observe(task.app, signal ?? new AbortController().signal);
    const cursor = Number(this.tasks.latest(taskId)?.cursor ?? 0);
    const checkpointId = this.tasks.checkpoint(taskId, cursor, observation.fingerprint, observation.evidenceRef || 'ime:observation');
    return { observation, checkpointId };
  }
  pause(taskId: string): void { this.tasks.transition(taskId,'paused'); this.desktop?.stop(taskId); }
  cancel(taskId: string): void { this.tasks.transition(taskId,'cancelled'); this.desktop?.stop(taskId); }
  status() {
    return {
      tasks: this.store.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 100').all(),
      budgets: this.store.db.prepare('SELECT * FROM budgets ORDER BY rowid DESC LIMIT 100').all(),
      memories:this.knowledge.listMemories(),
      memoryConflicts:this.store.db.prepare("SELECT * FROM memory_conflicts WHERE status='unreviewed'").all(),
      skillVersions:this.knowledge.listSkills(),
      approvals:this.store.db.prepare("SELECT * FROM approvals WHERE status IN ('pending','approved') ORDER BY rowid DESC LIMIT 100").all(),
      budgetCaps:this.store.db.prepare('SELECT * FROM budget_caps').all(),
      skills: this.store.db.prepare(`SELECT s.id,COALESCE(v.status,s.status) AS status,s.version
        FROM skills s LEFT JOIN skill_versions v ON v.skill_id=s.id AND v.version=s.version`).all(),
      experiences: this.experience.recent(50),
      experienceSummary: this.experience.summary(),
      learning: { ...this.learning },
      capabilities: { desktop: Boolean(this.desktop), hostModelBudget: 'unavailable', balance: 'unavailable' },
      monetaryUnit: 'micro-currency (1 currency unit = 1000000)',
    };
  }
  /**
   * Cost and tokens IMe observed for one assistant turn of one host session.
   *
   * Turns are matched through `request_trace.turn_id`, which the Agent
   * pre-step hook records before each model call. Amounts are micro-units of the
   * quote currency; `reserved` keeps the worst-case remainder of an open request.
   */
  turnCost(sessionId: string, turn: number) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error('INVALID_SESSION');
    if (!Number.isSafeInteger(turn) || turn < 0) throw new Error('INVALID_TURN');
    const rows = this.store.db.prepare(`SELECT m.state, m.usage AS request_usage,
        r.state AS reservation_state, r.amount AS reservation_amount, r.quote AS reservation_quote,
        u.amount, u.certainty AS entry_certainty, u.usage AS entry_usage, u.price
      FROM model_requests m
      LEFT JOIN request_trace t ON t.request_id = m.id
      LEFT JOIN reservations r ON r.id = m.reservation_id
      LEFT JOIN usage_entries u ON u.request_id = m.id
      WHERE m.session_id = ? AND t.turn_id = ?
      ORDER BY m.created_at`).all(sessionId, turn) as Record<string, unknown>[];
    let spent = 0;
    let reserved = 0;
    let input = 0;
    let cached = 0;
    let output = 0;
    let priced = false;
    let unknown = false;
    let pending = false;
    const currencies = new Set<string>();
    for (const row of rows) {
      if (row.amount !== null && row.amount !== undefined) {
        spent += Number(row.amount);
        priced = true;
        if (row.entry_certainty !== 'actual') unknown = true;
        if (typeof row.price === 'string') {
          try {
            const price = JSON.parse(row.price) as { currency?: unknown };
            if (typeof price.currency === 'string' && /^[A-Z]{3}$/.test(price.currency)) currencies.add(price.currency);
          } catch { unknown = true; }
        }
      }
      if (row.reservation_state === 'reserved') {
        reserved += Number(row.reservation_amount ?? 0);
        pending = true;
        if (typeof row.reservation_quote === 'string') {
          try {
            const quote = JSON.parse(row.reservation_quote) as { price?: { currency?: unknown } };
            const currency = quote.price?.currency;
            if (typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)) currencies.add(currency);
          } catch { /* a damaged quote keeps the currency unknown */ }
        }
      }
      const raw = row.entry_usage ?? row.request_usage;
      if (typeof raw === 'string') {
        try {
          const usage = JSON.parse(raw) as { inputTokens?: unknown; cachedInputTokens?: unknown; outputTokens?: unknown };
          input += Number(usage.inputTokens ?? 0);
          cached += Number(usage.cachedInputTokens ?? 0);
          output += Number(usage.outputTokens ?? 0);
        } catch { /* an unreadable snapshot leaves the token totals lower */ }
      }
    }
    const currency = currencies.size === 1 ? String(currencies.values().next().value) : null;
    const certainty = pending ? 'pending' : unknown ? 'unknown' : priced ? 'actual' : rows.length ? 'unpriced' : 'none';
    return {
      available: rows.length > 0,
      turn,
      requests: rows.length,
      currency,
      spent: String(spent),
      reserved: String(reserved),
      total: String(spent + reserved),
      certainty,
      priced,
      tokens: { input, cached, output },
    };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.desktop?.stop();
    await Promise.all([this.desktop?.drain(),this.costs.stopAndDrain()]);
    try { this.store.close(); } finally { unlinkSync(this.lockPath); }
  }
}
