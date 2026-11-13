import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,unlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Runtime} from '../src/core/runtime.js';
test('real process SIGKILL preserves uncertain action and outstanding budget; restart never replays',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ime-crash-'));
 try{
  const child=spawnSync(process.execPath,['--import','tsx','scripts/crash-fixture.ts',dir],{cwd:process.cwd(),timeout:10000});assert.equal(child.signal,'SIGKILL',child.stderr.toString());
  const lock=JSON.parse(readFileSync(join(dir,'runtime.lock'),'utf8'));assert.throws(()=>process.kill(lock.pid,0));
  unlinkSync(join(dir,'runtime.lock'));unlinkSync(join(dir,'desktop.lock'));
  const r=new Runtime({dataDir:dir});
  try{
   const task=r.store.db.prepare('SELECT id,status FROM tasks LIMIT 1').get()!;assert.equal(task.status,'paused');
   assert.equal(r.store.db.prepare('SELECT state FROM actions').get()?.state,'uncertain');
   assert.equal(r.store.db.prepare('SELECT reserved FROM budgets').get()?.reserved,200);
   await assert.rejects(r.tasks.resume(String(task.id),async()=>true),/RECONCILIATION_REQUIRED/);
  }finally{await r.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
