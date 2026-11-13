import type { Store } from './store.js';

export function migrateV5(store: Store): void {
  store.transaction(() => {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_comparisons(
        id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, baseline_version INTEGER NOT NULL,
        candidate_version INTEGER NOT NULL, report TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_dependencies(
        task_id TEXT NOT NULL REFERENCES tasks(id), depends_on TEXT NOT NULL REFERENCES tasks(id),
        PRIMARY KEY(task_id,depends_on), CHECK(task_id<>depends_on)
      );
      INSERT OR IGNORE INTO migrations VALUES(5);
    `);
    // Interrupted evaluations must be explicitly rerun after restart.
    store.db.exec(`UPDATE skill_evaluations SET report=json_set(report,'$.state','interrupted','$.passed',json('false'))
      WHERE json_extract(report,'$.state')='running';
      UPDATE skill_comparisons SET report=json_set(report,'$.state','interrupted','$.passed',json('false'))
      WHERE json_extract(report,'$.state')='running';`);
  });
}
