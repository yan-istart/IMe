import type { Store } from './store.js';
/**
 * Learning accumulation tables.
 *
 * `skill_observations` is evidence from real task runs, kept separately from
 * immutable skill documents. A skill version becomes reviewable only when
 * several independent successful runs agree on the same stable signature.
 * `experience_traces` stores metadata-only traces from host computer-use
 * tools, never screenshots, prompts or input text.
 */
export function migrateV4(store: Store) {
  store.transaction(() => store.db.exec(`
    CREATE TABLE IF NOT EXISTS skill_observations(
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      evidence_refs TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(skill_id,version,task_id)
    );
    CREATE INDEX IF NOT EXISTS skill_observations_version
      ON skill_observations(skill_id,version,outcome);
    CREATE TABLE IF NOT EXISTS experience_traces(
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn INTEGER,
      app TEXT NOT NULL,
      outcome TEXT NOT NULL,
      tool_count INTEGER NOT NULL,
      failure_count INTEGER NOT NULL,
      steps TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS experience_traces_app
      ON experience_traces(app,created_at);
    CREATE TABLE IF NOT EXISTS skill_reviews(
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      decision TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO migrations VALUES(4);
  `));
}
