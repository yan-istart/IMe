import type {Store} from './store.js';
export function migrateV7(store:Store) {
  store.transaction(()=>store.db.exec(`
    CREATE TABLE IF NOT EXISTS transport_attempts(request_id TEXT PRIMARY KEY,reservation_id TEXT UNIQUE NOT NULL,
      provider TEXT NOT NULL,model TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS transport_blocks(provider TEXT NOT NULL,model TEXT NOT NULL,reason TEXT NOT NULL,
      created_at TEXT NOT NULL,PRIMARY KEY(provider,model));
    CREATE TABLE IF NOT EXISTS provider_receipts(request_id TEXT PRIMARY KEY,provider TEXT NOT NULL,provider_request_id TEXT NOT NULL,
      UNIQUE(provider,provider_request_id));
    CREATE TABLE IF NOT EXISTS billing_reconciliations(request_id TEXT NOT NULL,statement_ref TEXT NOT NULL,currency TEXT NOT NULL,
      charged_amount INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(request_id,statement_ref));
    CREATE TABLE IF NOT EXISTS acceptance_runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),status TEXT NOT NULL,
      report TEXT NOT NULL,updated_at TEXT NOT NULL);
    UPDATE transport_attempts SET state='unknown' WHERE state='dispatching';
    INSERT OR IGNORE INTO migrations VALUES(7);
  `));
}
