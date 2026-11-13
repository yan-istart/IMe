import { migrateV3 } from './schema-v3.js';
import { migrateV4 } from './schema-v4.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** SQLite is authoritative; audit JSONL is a recoverable projection of its outbox. */
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, 'ime.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, goal TEXT NOT NULL,
        app TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budgets(task_id TEXT PRIMARY KEY REFERENCES tasks(id), currency TEXT NOT NULL,
        limit_amount INTEGER NOT NULL CHECK(limit_amount>=0), spent INTEGER NOT NULL DEFAULT 0,
        reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0));
      CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        request_id TEXT UNIQUE NOT NULL, amount INTEGER NOT NULL, state TEXT NOT NULL, quote TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_entries(request_id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL,
        amount INTEGER NOT NULL, certainty TEXT NOT NULL, usage TEXT, price TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        cursor INTEGER NOT NULL, fingerprint TEXT NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        state TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skills(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL,
        version INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT OR IGNORE INTO migrations VALUES(1);`);
    this.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS model_requests(
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        state TEXT NOT NULL, task_id TEXT, reservation_id TEXT, usage TEXT, certainty TEXT NOT NULL DEFAULT 'unknown',
        created_at TEXT NOT NULL, finished_at TEXT);
        CREATE TABLE IF NOT EXISTS model_sessions(session_id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id));
        CREATE INDEX IF NOT EXISTS model_requests_session ON model_requests(session_id,created_at);
        INSERT OR IGNORE INTO migrations VALUES(2);`);
      this.db.prepare("UPDATE model_requests SET state='interrupted',certainty='unknown' WHERE state IN ('pending','streaming')").run();
    });
    migrateV3(this);
    migrateV4(this);
    this.exportAudit();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(type: string, data: unknown): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO audit_events(id,type,data,created_at) VALUES(?,?,?,?)')
      .run(id, type, JSON.stringify(data), new Date().toISOString());
    return id;
  }
  exportAudit(): void {
    // Atomic replacement allows rebuilding after a crash without duplicate JSONL events.
    const lines = this.db.prepare('SELECT * FROM audit_events ORDER BY seq').all().map(row =>
      JSON.stringify({ schemaVersion: 1, ...row, data: JSON.parse(String(row.data)) }));
    const target = join(this.dir, 'audit.jsonl');
    const temp = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temp, lines.length ? lines.join('\n') + '\n' : '', { mode: 0o600 });
    renameSync(temp, target);
  }
  close(): void { try { this.exportAudit(); } finally { this.db.close(); } }
}
