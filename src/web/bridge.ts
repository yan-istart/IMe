import type { Runtime, RuntimeConfig } from '../core/runtime.js';
import type { HostModelGateway } from '../adapters/model-gateway.js';
import type { Dashboard } from './dashboard.js';

/** The authenticated browser carrier's exact-route registry. */
export interface HostConnectionFetch {
  register(route: {
    path: string;
    methods: readonly ('GET' | 'HEAD' | 'POST')[];
    requestBody: 'buffered' | 'streaming';
    fetch(request: Request): Promise<Response>;
  }): () => Promise<void>;
}

type Row = Record<string, unknown>;

function row(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter(row) : [];
}

function text(value: unknown, max = 300): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function integer(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  return '0';
}

function number(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'OPERATION_FAILED';
}

function reply(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function documentOf(value: unknown): Row | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return row(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Host side of the visual interface.
 *
 * Routes ride the authenticated `/api` carrier, so the browser cookie and the
 * Host/Origin trust checks are applied before a handler runs. Commands here are
 * user-only: the agent has no tool that reaches this bridge.
 */
export class ImeWebBridge {
  private readonly disposers: (() => Promise<void>)[] = [];

  constructor(
    private readonly runtime: Runtime,
    private readonly config: RuntimeConfig,
    private readonly gateway: HostModelGateway | undefined,
    private readonly dashboard: Dashboard | undefined,
    private readonly capabilities: Record<string, unknown>,
  ) {}

  register(connection: HostConnectionFetch): void {
    this.disposers.push(connection.register({
      path: '/api/ime/state',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => this.stateReply(),
    }));
    this.disposers.push(connection.register({
      path: '/api/ime/command',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async request => this.command(request),
    }));
    this.disposers.push(connection.register({
      path: '/api/ime/turn-cost',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async request => this.turnCost(request),
    }));
  }

  async close(): Promise<void> {
    for (const dispose of this.disposers.splice(0).reverse()) {
      try { await dispose(); } catch { /* the carrier may already be gone */ }
    }
  }

  private async turnCost(request: Request): Promise<Response> {
    let body: unknown;
    try { body = await request.json(); }
    catch { return reply({ error: 'INVALID_JSON' }, 400); }
    if (!row(body)) return reply({ error: 'INVALID_REQUEST' }, 400);
    try {
      const sessionId = text(body.sessionId, 200);
      const turn = Number(body.turn);
      if (!sessionId || !Number.isSafeInteger(turn) || turn < 0) return reply({ error: 'INVALID_TURN' }, 400);
      return reply(this.runtime.turnCost(sessionId, turn));
    } catch (error) {
      return reply({ error: errorText(error) }, 400);
    }
  }

  private stateReply(): Response {
    try { return reply(this.state()); }
    catch (error) { return reply({ error: errorText(error) }, 500); }
  }

  private async command(request: Request): Promise<Response> {
    let body: unknown;
    try { body = await request.json(); }
    catch { return reply({ error: 'INVALID_JSON' }, 400); }
    if (!row(body) || typeof body.command !== 'string') return reply({ error: 'INVALID_COMMAND' }, 400);
    try {
      switch (body.command) {
        case 'pause_all': {
          this.runtime.executionPaused=true;
          this.gateway?.pause();
          this.runtime.desktop?.stop();
          for (const task of this.runtime.store.db.prepare("SELECT id FROM tasks WHERE status='running'").all()) {
            this.runtime.pause(String(task.id));
          }
          return reply({ ok: true });
        }
        case 'resume_all': {
          this.runtime.executionPaused=false;
          this.gateway?.resume();
          await this.runtime.desktop?.resumeAll();
          return reply({ ok: true });
        }
        case 'set_cap': {
          const scope = text(body.scope, 20);
          const key = text(body.key, 200).trim();
          const currency = text(body.currency, 3).trim().toUpperCase();
          const limit = text(body.limit, 30).trim();
          if (!['session', 'day', 'account'].includes(scope)) return reply({ error: 'INVALID_SCOPE' }, 400);
          if (!key) return reply({ error: 'INVALID_KEY' }, 400);
          if (!/^[A-Z]{3}$/.test(currency)) return reply({ error: 'INVALID_CURRENCY' }, 400);
          if (!/^\d+$/.test(limit)) return reply({ error: 'INVALID_CAP' }, 400);
          this.runtime.costs.setLimit(scope as 'session' | 'day' | 'account', key, currency, limit);
          return reply({ ok: true, caps: this.caps() });
        }
        case 'update_settings': {
          const settings = this.runtime.settings.update(body);
          this.gateway?.configure(this.runtime.settings.modelBudget);
          return reply({ ok: true, settings });
        }
        default:
          return reply({ error: 'UNKNOWN_COMMAND' }, 400);
      }
    } catch (error) {
      return reply({ error: errorText(error) }, 400);
    }
  }

  private state(): unknown {
    const status = this.runtime.status();
    const gateway = this.gateway?.status();
    const db = this.runtime.store.db;

    const taskCounts: Record<string, number> = {};
    for (const item of db.prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status').all() as { status: string; count: number }[]) {
      taskCounts[item.status] = number(item.count);
    }
    const totalTasks = Object.values(taskCounts).reduce((sum, value) => sum + value, 0);

    const memories = rows(status.memories);
    const skillVersions = rows(status.skillVersions);
    const approvals = rows(status.approvals);
    const budgets = rows(status.budgets);
    const caps = rows(status.budgetCaps);

    const trace = (db.prepare('SELECT type, created_at FROM audit_events ORDER BY seq DESC LIMIT 40').all() as Row[])
      .map(item => ({ type: text(item.type, 80), createdAt: text(item.created_at, 40) }));

    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      capabilities: {
        ...this.capabilities,
        desktop: Boolean(this.runtime.desktop),
        dashboard: Boolean(this.dashboard),
      },
      gateway: gateway ? {
        connected: gateway.connected,
        mode: gateway.mode,
        hardLimit: gateway.hardLimit,
        unknownPrices: gateway.unknownPrices,
        requests: rows(gateway.requests).slice(0, 12).map(item => ({
          id: text(item.id, 80),
          provider: text(item.provider, 80),
          model: text(item.model, 120),
          state: text(item.state, 40),
          certainty: text(item.certainty, 40),
          createdAt: text(item.created_at, 40),
        })),
      } : null,
      dashboard: { available: Boolean(this.dashboard), url: this.dashboard?.url ?? null },
      counts: {
        tasks: {
          total: totalTasks,
          running: taskCounts.running ?? 0,
          byStatus: taskCounts,
        },
        memories: {
          total: memories.length,
          active: memories.filter(item => item.status === 'active').length,
          candidate: memories.filter(item => item.status === 'candidate').length,
        },
        skills: {
          total: skillVersions.length,
          published: skillVersions.filter(item => item.status === 'published').length,
          candidate: skillVersions.filter(item => item.status === 'candidate').length,
        },
        approvals: {
          pending: approvals.filter(item => item.status === 'pending').length,
          open: approvals.length,
        },
      },
      tasks: rows(status.tasks).slice(0, 30).map(item => ({
        id: text(item.id, 80),
        sessionId: text(item.session_id, 80),
        goal: text(item.goal, 300),
        app: text(item.app, 120),
        status: text(item.status, 40),
        updatedAt: text(item.updated_at, 40),
      })),
      budgets: budgets.slice(0, 20).map(item => ({
        taskId: text(item.task_id, 80),
        currency: text(item.currency, 3),
        limit: integer(item.limit_amount),
        spent: integer(item.spent),
        reserved: integer(item.reserved),
      })),
      caps: caps.map(item => ({
        scope: text(item.scope, 20),
        key: text(item.key, 200),
        currency: text(item.currency, 3),
        limit: integer(item.limit_amount),
        spent: integer(item.spent),
        reserved: integer(item.reserved),
      })),
      memories: memories.slice(0, 12).map(item => ({
        id: text(item.id, 80),
        kind: text(item.kind, 40),
        app: text(item.app, 120),
        trust: text(item.trust, 40),
        status: text(item.status, 40),
        content: text(item.content, 300),
        updatedAt: text(item.updated_at, 40),
      })),
      skills: skillVersions.slice(0, 12).map(item => {
        const document = documentOf(item.document);
        return {
          id: text(item.skill_id, 80),
          version: number(item.version),
          status: text(item.status, 40),
          goal: text(document?.goal, 200),
          hash: text(item.hash, 80),
          success: number(item.success_count),
          failure: number(item.failure_count),
          createdAt: text(item.created_at, 40),
        };
      }),
      approvals: approvals.slice(0, 10).map(item => {
        const action = documentOf(item.action);
        return {
          id: text(item.id, 80),
          taskId: text(item.task_id, 80),
          status: text(item.status, 40),
          risk: text(action?.risk, 40),
          expiresAt: text(item.expires_at, 40),
        };
      }),
      trace,
      settings: {
        dataDir: this.runtime.store.dir,
        allowApps: [...this.runtime.settings.allowApps],
        taskDefaultLimit: this.runtime.settings.taskDefaultLimit ?? null,
        budgetTimezone: this.runtime.settings.budgetTimezone ?? null,
        editable: {
          allowApps: true,
          taskDefaultLimit: true,
          budgetTimezone: true,
          modelBudget: true,
        },
        modelBudget: this.runtime.settings.modelBudget ? {
          sessionLimit: this.runtime.settings.modelBudget.sessionLimit,
          routes: this.runtime.settings.modelBudget.routes.length,
          currencies: [...new Set(this.runtime.settings.modelBudget.routes.map(route => route.price.currency))],
          config: this.runtime.settings.modelBudget,
        } : null,
        dashboardEnabled: Boolean(this.dashboard),
      },
    };
  }

  private caps(): unknown[] {
    return (this.runtime.store.db.prepare('SELECT scope,key,currency,limit_amount,spent,reserved FROM budget_caps').all() as Row[])
      .map(item => ({
        scope: text(item.scope, 20),
        key: text(item.key, 200),
        currency: text(item.currency, 3),
        limit: integer(item.limit_amount),
        spent: integer(item.spent),
        reserved: integer(item.reserved),
      }));
  }
}
