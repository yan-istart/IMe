import { migrateV3 } from './schema-v3.js';
import { migrateV4 } from './schema-v4.js';
import { migrateV5 } from './schema-v5.js';
import { migrateV6 } from './schema-v6.js';
import { migrateV7 } from './schema-v7.js';
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** SQLite is authoritative; audit JSONL is a recoverable projection of its outbox. */
export interface AuditConfig {maxBytes?:number;retainedFiles?:number}
export class Store {
  readonly db: DatabaseSync;
  private auditCursor = 0;
  private auditScheduled = false;
  private closed = false;
  private transactionDepth = 0;
  auditProjectionError = false;
  constructor(readonly dir: string,private audit:AuditConfig={}) {
    if(audit.maxBytes!==undefined&&(!Number.isSafeInteger(audit.maxBytes)||audit.maxBytes<256)
      ||audit.retainedFiles!==undefined&&(!Number.isSafeInteger(audit.retainedFiles)||audit.retainedFiles<0||audit.retainedFiles>20))throw Error('INVALID_AUDIT_CONFIG');
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
    migrateV5(this);
    migrateV6(this);
    migrateV7(this);
    this.exportAudit();
  }
  transaction<T>(fn: () => T): T {
    const savepoint=this.transactionDepth?`ime_${this.transactionDepth}`:undefined;
    this.db.exec(savepoint?`SAVEPOINT ${savepoint}`:'BEGIN IMMEDIATE');this.transactionDepth++;
    try {const value=fn();this.db.exec(savepoint?`RELEASE SAVEPOINT ${savepoint}`:'COMMIT');return value;}
    catch(error){this.db.exec(savepoint?`ROLLBACK TO SAVEPOINT ${savepoint}`:'ROLLBACK');if(savepoint)this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);throw error;}
    finally{this.transactionDepth--;}
  }
  event(type: string, data: unknown): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO audit_events(id,type,data,created_at) VALUES(?,?,?,?)')
      .run(id, type, JSON.stringify(data), new Date().toISOString());
    if (!this.auditScheduled) {
      this.auditScheduled = true;
      queueMicrotask(() => {
        this.auditScheduled = false;
        if (this.closed) return;
        try { this.flushAudit(); }
        catch { this.auditProjectionError = true; }
      });
    }
    return id;
  }
  /** Flush committed outbox rows only; rolled-back events never reach JSONL. */
  flushAudit(): void {
    if(this.transactionDepth)return;
    if (this.auditProjectionError) { this.exportAudit(); return; }
    const rows = this.db.prepare('SELECT * FROM audit_events WHERE seq>? ORDER BY seq').all(this.auditCursor);
    if (!rows.length) return;
    const lines = rows.map(row => JSON.stringify({schemaVersion:1,...row,data:JSON.parse(String(row.data))}));
    try {
      const target=join(this.dir,'audit.jsonl');let size=existsSync(target)?statSync(target).size:0;
      for(const line of lines) {
        const bytes=Buffer.byteLength(line+'\n');
        if(size&&size+bytes>(this.audit.maxBytes??8388608)) {
          const keep=this.audit.retainedFiles??3;
          for(let index=keep;index>=1;index--){const old=join(this.dir,`audit.${index}.jsonl`);if(existsSync(old)){if(index===keep)unlinkSync(old);else renameSync(old,join(this.dir,`audit.${index+1}.jsonl`));}}
          if(keep)renameSync(target,join(this.dir,'audit.1.jsonl'));else unlinkSync(target);size=0;
        }
        appendFileSync(target,line+'\n',{mode:0o600});size+=bytes;
      }
      this.auditCursor=Number(rows.at(-1)!.seq);
    } catch(error) { this.auditProjectionError=true; throw error; }
  }
  exportAudit(): void {
    // Atomic replacement allows rebuilding after a crash without duplicate JSONL events.
    const chunks:string[][]=[[]];let size=0;
    for(const row of this.db.prepare('SELECT * FROM audit_events ORDER BY seq').iterate()) {
      const line=JSON.stringify({schemaVersion:1,...row,data:JSON.parse(String(row.data))});const bytes=Buffer.byteLength(line+'\n');
      if(size&&size+bytes>(this.audit.maxBytes??8388608)){chunks.push([]);size=0;}
      chunks.at(-1)!.push(line);size+=bytes;
      if(chunks.length>(this.audit.retainedFiles??3)+1)chunks.shift();
    }
    const target = join(this.dir, 'audit.jsonl');
    for(let i=0;i<chunks.length;i++) {
      const destination=i===0?target:join(this.dir,`audit.${i}.jsonl`),temp=`${destination}.${randomUUID()}.tmp`;
      const lines=chunks[chunks.length-i-1]!;
      writeFileSync(temp,lines.length?lines.join('\n')+'\n':'',{mode:0o600});renameSync(temp,destination);
    }
    for(let index=chunks.length;index<=20;index++){const old=join(this.dir,`audit.${index}.jsonl`);if(existsSync(old))unlinkSync(old);}
    this.auditCursor=Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM audit_events').get()!.seq);
    this.auditProjectionError=false;
  }
  close(): void { if(this.closed)return;this.closed=true;try { this.exportAudit(); } finally { this.db.close(); } }
}
