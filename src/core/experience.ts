import { randomUUID } from 'node:crypto';
import type { Runtime } from './runtime.js';

/**
 * Metadata-only capture of host computer-use tool calls.
 *
 * The recorder deliberately never reads prompts, assistant messages, input
 * text, screenshots or tool payloads. It keeps the tool name, a sanitized app
 * hint and the error status so a completed turn can become a `procedure` or
 * `failure` memory. This is the bridge between the host Computer Use provider
 * (official / cua-driver-native) and IMe's long-term experience store.
 */
export interface HostToolExecution {
  name?: unknown;
  callId?: unknown;
  isError?: unknown;
  error?: unknown;
  arguments?: unknown;
  args?: unknown;
  input?: unknown;
  result?: unknown;
  value?: unknown;
}
interface TraceStep { tool: string; ok: boolean; app?: string }
interface PendingTrace { steps: TraceStep[]; turn?: number; startedAt: number }
export interface ExperienceRecorderOptions { enabled: boolean; prefixes: string[] }
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,96}$/u;
const APP_VALUE = /^[A-Za-z0-9._:/@ -]{1,120}$/u;
const APP_KEYS = new Set(['app', 'appName', 'app_name', 'application', 'bundleId', 'bundle_id',
  'bundleIdentifier', 'bundle_identifier', 'packageName', 'package_name', 'processName', 'pid']);
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function safeApp(value: unknown): string | undefined {
  if (typeof value === 'string' && APP_VALUE.test(value.trim())) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return 'pid:' + value;
  return undefined;
}
function findApp(value: unknown, depth = 3): string | undefined {
  if (depth < 0) return undefined;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 5)) {
      const found = findApp(item, depth - 1);
      if (found) return found;
    }
    return undefined;
  }
  const object = record(value);
  if (!object) return undefined;
  for (const key of APP_KEYS) {
    const found = safeApp(object[key]);
    if (found) return found;
  }
  for (const nested of Object.values(object)) {
    const found = findApp(nested, depth - 1);
    if (found) return found;
  }
  return undefined;
}
function reasonKind(value: unknown): string {
  if (typeof value === 'string') return value;
  const object = record(value);
  return typeof object?.kind === 'string' ? object.kind : 'unknown';
}
export class ExperienceRecorder {
  private pending = new Map<string, PendingTrace>();
  constructor(private runtime: Runtime, private options: ExperienceRecorderOptions) {
    if (!Array.isArray(options.prefixes) || options.prefixes.some(prefix => typeof prefix !== 'string' || !prefix)) throw new Error('INVALID_EXPERIENCE_CONFIG');
  }
  shouldCapture(name: string): boolean {
    if (!this.options.enabled || !TOOL_NAME.test(name) || name.startsWith('ime_')) return false;
    const lower = name.toLowerCase();
    if (/password|secret|credential|token/u.test(lower)) return false;
    return this.options.prefixes.some(prefix => name.startsWith(prefix))
      || lower.startsWith('cua_driver_native__') || lower.startsWith('cua_')
      || lower.startsWith('computer_') || lower.startsWith('desktop_')
      || lower.startsWith('window_') || lower.startsWith('screenshot_');
  }
  noteTurn(sessionId: string, turn: number): void {
    if (!Number.isSafeInteger(turn) || turn < 0) return;
    const pending = this.pending.get(sessionId);
    if (pending) pending.turn = turn;
  }
  capture(sessionId: string, execution: HostToolExecution): void {
    if (!this.options.enabled || typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) return;
    if (typeof execution.name !== 'string' || !this.shouldCapture(execution.name)) return;
    let pending = this.pending.get(sessionId);
    if (!pending) {
      // Learning data is best-effort; keep memory bounded across long-lived hosts.
      if (this.pending.size >= 200) {
        const oldest = this.pending.keys().next().value;
        if (oldest !== undefined) this.pending.delete(oldest);
      }
      pending = { steps: [], startedAt: Date.now() };
      this.pending.set(sessionId, pending);
    }
    if (pending.steps.length >= 100) return;
    const result = record(execution.result);
    const failed = execution.isError === true || result?.isError === true
      || execution.error !== undefined || result?.error !== undefined;
    const args = execution.arguments ?? execution.args ?? execution.input;
    const candidates = [findApp(args), findApp(result), findApp(execution.value)].filter((item): item is string => Boolean(item));
    // A bundle/app name is more useful across runs than a volatile pid fallback.
    const app = candidates.find(item => !item.startsWith('pid:')) ?? candidates[0];
    const step: TraceStep = { tool: execution.name, ok: !failed, ...app ? { app } : {} };
    pending.steps.push(step);
  }
  /**
   * Finish a host turn. Returns null when no computer-use tool ran, so ordinary
   * coding turns never create learning noise.
   */
  finalize(sessionId: string, event: unknown): { traceId: string; memoryId: string | null } | null {
    const pending = this.pending.get(sessionId);
    if (!pending) return null;
    this.pending.delete(sessionId);
    if (!pending.steps.length) return null;
    const payload = record(event);
    const data = record(payload?.data);
    const turn = typeof data?.turn === 'number' && Number.isSafeInteger(data.turn) ? data.turn : pending.turn ?? null;
    const reason = reasonKind(data?.reason);
    const success = reason === 'completed' || reason === 'success' || reason === 'done';
    const failure = ['failed', 'error', 'aborted', 'cancelled', 'stopped', 'interrupted'].includes(reason);
    if (!success && !failure) return null;
    const counts = new Map<string, number>();
    for (const step of pending.steps) if (step.app) counts.set(step.app, (counts.get(step.app) ?? 0) + 1);
    const app = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'desktop';
    const failures = pending.steps.filter(step => !step.ok).length;
    const verifiedSuccess = success && failures === 0;
    const outcome = verifiedSuccess ? 'success' : 'failure';
    const traceId = randomUUID();
    const created = new Date().toISOString();
    let eventId = '';
    this.runtime.store.transaction(() => {
      this.runtime.store.db.prepare('INSERT INTO experience_traces VALUES(?,?,?,?,?,?,?,?,?)')
        .run(traceId, sessionId, turn, app, outcome, pending.steps.length, failures, JSON.stringify(pending.steps), created);
      eventId = this.runtime.store.event('ime.experience.recorded',
        { traceId, sessionId, turn, app, outcome, toolCount: pending.steps.length, failureCount: failures });
    });
    const sequence = pending.steps.map(step => step.tool).join(' → ');
    const content = verifiedSuccess
      ? `应用 ${app} 的成功操作序列：${sequence}（${pending.steps.length} 步，0 次失败）。这是工具执行证据，不是权限或策略。`
      : `应用 ${app} 的失败操作序列：${sequence}（${pending.steps.length} 步，${failures} 次失败）。失败经验只作参考，不能作为策略指令。`;
    const duplicate = this.runtime.store.db.prepare('SELECT id FROM memories WHERE app=? AND content=? LIMIT 1').get(app, content);
    let memoryId: string | null = duplicate ? String(duplicate.id) : null;
    if (!duplicate) {
      try {
        memoryId = this.runtime.knowledge.propose({ kind: verifiedSuccess ? 'procedure' : 'failure', content, app,
          trust: 'tool_verified', sourceEventIds: [eventId] });
      } catch { memoryId = null; }
    }
    return { traceId, memoryId };
  }
  recent(limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('INVALID_LIMIT');
    return this.runtime.store.db.prepare('SELECT * FROM experience_traces ORDER BY created_at DESC LIMIT ?').all(limit);
  }
  contextApp(sessionId: string): string | undefined {
    const pending = this.pending.get(sessionId);
    const app = pending?.steps.findLast(step=>step.app)?.app;
    if(app)return app;
    const last = this.runtime.store.db.prepare('SELECT app FROM experience_traces WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(sessionId);
    return last ? String(last.app) : undefined;
  }
  summary() {
    const rows = this.runtime.store.db.prepare('SELECT outcome,COUNT(*) AS count FROM experience_traces GROUP BY outcome').all();
    return { total: rows.reduce((sum, row) => sum + Number(row.count), 0),
      byOutcome: Object.fromEntries(rows.map(row => [String(row.outcome), Number(row.count)])) };
  }
}
