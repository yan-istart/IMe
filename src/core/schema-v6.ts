import type { Store } from './store.js';

export function migrateV6(store: Store): void {
  store.transaction(() => store.db.exec(`
    CREATE TABLE IF NOT EXISTS memory_vectors(memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      model TEXT NOT NULL, content_hash TEXT NOT NULL, vector TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS route_feedback(request_id TEXT PRIMARY KEY,task_id TEXT,provider TEXT NOT NULL,
      model TEXT NOT NULL,category TEXT NOT NULL,success INTEGER,amount INTEGER NOT NULL,currency TEXT NOT NULL,
      latency_ms REAL NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS route_feedback_lookup ON route_feedback(provider,model,category,created_at);
    CREATE TABLE IF NOT EXISTS runtime_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sync_records(record_key TEXT PRIMARY KEY,origin TEXT NOT NULL,kind TEXT NOT NULL,
      source_id TEXT NOT NULL,revision TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,local_id TEXT);
    CREATE TABLE IF NOT EXISTS task_children(parent_id TEXT NOT NULL REFERENCES tasks(id),child_id TEXT PRIMARY KEY REFERENCES tasks(id));
    CREATE TABLE IF NOT EXISTS reservation_parents(reservation_id TEXT NOT NULL,parent_id TEXT NOT NULL REFERENCES tasks(id),PRIMARY KEY(reservation_id,parent_id));
    CREATE TABLE IF NOT EXISTS skill_dependencies(skill_id TEXT NOT NULL,version INTEGER NOT NULL,
      depends_on TEXT NOT NULL,depends_version INTEGER NOT NULL,PRIMARY KEY(skill_id,version,depends_on,depends_version));
    INSERT OR IGNORE INTO migrations VALUES(6);
  `));
}
