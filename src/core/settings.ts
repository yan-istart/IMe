import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { money } from './cost.js';
import { validateModelBudget, type ModelBudgetConfig } from '../adapters/model-gateway.js';

/** Values a human may change from the IMe settings page and that survive a restart. */
export interface SettingsSeed { allowApps?: string[]; taskDefaultLimit?: string; budgetTimezone?: string; modelBudget?: ModelBudgetConfig }

export interface SettingsSnapshot {
  allowApps: string[];
  taskDefaultLimit: string | null;
  budgetTimezone: string | null;
  modelBudget: ModelBudgetConfig | null;
}

const MAX_APPS = 50;
const MAX_APP_LENGTH = 200;

function apps(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_APPS) throw new Error('INVALID_ALLOW_APPS');
  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('INVALID_ALLOW_APPS');
    const app = item.trim();
    if (!app || app.length > MAX_APP_LENGTH) throw new Error('INVALID_ALLOW_APPS');
    if (!list.includes(app)) list.push(app);
  }
  return list;
}

function limit(value: unknown): string {
  if (typeof value !== 'string') throw new Error('INVALID_TASK_LIMIT');
  money(value);
  return value;
}

function timezone(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) throw new Error('INVALID_TIMEZONE');
  new Intl.DateTimeFormat('en-CA', { timeZone: value }).format();
  return value;
}

function budget(value: unknown): ModelBudgetConfig {
  if (value === null) throw new Error('INVALID_MODEL_BUDGET');
  validateModelBudget(value as ModelBudgetConfig);
  return structuredClone(value as ModelBudgetConfig);
}

/**
 * Human-owned overrides for the few host settings the settings page may edit.
 *
 * The override file beats the plugin configuration and is re-read on startup, so a
 * change made in the UI survives a Harness restart. Only the browser bridge, which
 * is user-authenticated, reaches this class; the agent has no tool for it.
 */
export class RuntimeSettings {
  private readonly allow: string[];
  private taskLimit: string | undefined;
  private zone: string | undefined;
  private budget: ModelBudgetConfig | undefined;
  private readonly seedBudget: ModelBudgetConfig | undefined;

  constructor(private readonly dir: string, seed: SettingsSeed) {
    const stored = this.read();
    this.allow = apps(stored?.allowApps ?? seed.allowApps ?? []);
    this.taskLimit = stored?.taskDefaultLimit !== undefined ? limit(stored.taskDefaultLimit) : seed.taskDefaultLimit;
    this.zone = stored?.budgetTimezone !== undefined ? timezone(stored.budgetTimezone) : seed.budgetTimezone;
    this.seedBudget = seed.modelBudget === undefined ? undefined : budget(seed.modelBudget);
    this.budget = stored?.modelBudget !== undefined ? budget(stored.modelBudget) : this.seedBudget;
    if (this.taskLimit !== undefined) limit(this.taskLimit);
    if (this.zone !== undefined) timezone(this.zone);
  }

  get file(): string { return join(this.dir, 'settings.json'); }

  /** The same array instance the desktop controller holds, so edits apply immediately. */
  get allowApps(): string[] { return this.allow; }

  get taskDefaultLimit(): string | undefined { return this.taskLimit; }

  get budgetTimezone(): string | undefined { return this.zone; }

  get modelBudget(): ModelBudgetConfig | undefined {
    return this.budget === undefined ? undefined : structuredClone(this.budget);
  }

  snapshot(): SettingsSnapshot {
    return {
      allowApps: [...this.allow],
      taskDefaultLimit: this.taskLimit ?? null,
      budgetTimezone: this.zone ?? null,
      modelBudget: this.modelBudget ?? null,
    };
  }

  update(patch: unknown): SettingsSnapshot {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new Error('INVALID_SETTINGS');
    const input = patch as Record<string, unknown>;
    const nextAllow = input.allowApps === undefined ? [...this.allow] : apps(input.allowApps);
    const nextLimit = input.taskDefaultLimit === undefined ? this.taskLimit : limit(input.taskDefaultLimit);
    const nextZone = input.budgetTimezone === undefined ? this.zone : timezone(input.budgetTimezone);
    const nextBudget = input.modelBudget === undefined
      ? this.budget
      : input.modelBudget === null ? this.seedBudget : budget(input.modelBudget);
    this.allow.splice(0, this.allow.length, ...nextAllow);
    this.taskLimit = nextLimit;
    this.zone = nextZone;
    this.budget = nextBudget;
    this.write();
    return this.snapshot();
  }

  private read(): SettingsSeed | undefined {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
      const record = parsed as Record<string, unknown>;
      const seed: SettingsSeed = {};
      if (record.allowApps !== undefined) seed.allowApps = apps(record.allowApps);
      if (record.taskDefaultLimit !== undefined) seed.taskDefaultLimit = limit(record.taskDefaultLimit);
      if (record.budgetTimezone !== undefined) seed.budgetTimezone = timezone(record.budgetTimezone);
      if (record.modelBudget !== undefined && record.modelBudget !== null) seed.modelBudget = budget(record.modelBudget);
      return seed;
    } catch { return undefined; }
  }

  private write(): void {
    const temp = join(this.dir, `.settings-${process.pid}.tmp`);
    writeFileSync(temp, JSON.stringify({ version: 1, ...this.snapshot() }, null, 2), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.file);
  }
}
