import type { Store } from './store.js';
export function migrateV3(store: Store) {
  store.transaction(()=>store.db.exec(`
    CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,kind TEXT NOT NULL,content TEXT NOT NULL,app TEXT NOT NULL,
      trust TEXT NOT NULL,status TEXT NOT NULL,source_ids TEXT NOT NULL,expires_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,uses INTEGER NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED,content,app,tokenize='trigram');
    CREATE TABLE IF NOT EXISTS memory_subjects(memory_id TEXT PRIMARY KEY,subject TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_conflicts(first_id TEXT,second_id TEXT,status TEXT,PRIMARY KEY(first_id,second_id));
    CREATE TABLE IF NOT EXISTS skill_versions(skill_id TEXT,version INTEGER,status TEXT NOT NULL,document TEXT NOT NULL,hash TEXT NOT NULL,
      report TEXT,created_at TEXT NOT NULL,PRIMARY KEY(skill_id,version));
    CREATE TABLE IF NOT EXISTS skill_runs(id TEXT PRIMARY KEY,skill_id TEXT,version INTEGER,task_id TEXT,outcome TEXT,created_at TEXT);
    CREATE TABLE IF NOT EXISTS skill_evaluations(id TEXT PRIMARY KEY,skill_id TEXT,version INTEGER,report TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,action_hash TEXT NOT NULL,status TEXT NOT NULL,
      expires_at TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,category TEXT NOT NULL,report TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS budget_caps(scope TEXT,key TEXT,currency TEXT,limit_amount INTEGER,spent INTEGER DEFAULT 0,reserved INTEGER DEFAULT 0,
      PRIMARY KEY(scope,key,currency));
    CREATE TABLE IF NOT EXISTS reservation_caps(reservation_id TEXT,scope TEXT,key TEXT,currency TEXT,PRIMARY KEY(reservation_id,scope,key,currency));
    CREATE TABLE IF NOT EXISTS request_trace(request_id TEXT PRIMARY KEY,task_id TEXT,turn_id INTEGER,step_id INTEGER,action_id TEXT,skill_version INTEGER);
    CREATE TABLE IF NOT EXISTS review_costs(review_id TEXT PRIMARY KEY,task_id TEXT,amount INTEGER);
    CREATE TABLE IF NOT EXISTS desktop_lease(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT,acquired_at TEXT);
    INSERT OR IGNORE INTO migrations VALUES(3);
  `));
}
