import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/core/runtime.js';
import { MockDesktop } from '../src/adapters/mock.js';
const dataDir = mkdtempSync(join(tmpdir(),'ime-demo-'));
const runtime = new Runtime({ dataDir,allowApps:['mock-app'] },new MockDesktop());
try {
  const task = runtime.tasks.create('demo-session','打开任务面板','mock-app','1000000');
  runtime.tasks.transition(task.id,'ready'); runtime.tasks.transition(task.id,'running');
  await runtime.costs.call(task.id,{ version:'mock-v1',currency:'USD',inputPerMillion:'1000000',cachedPerMillion:'100000',outputPerMillion:'2000000' },
    { inputUpperBound:100,maxOutput:50,toolAllowance:'0' },async () => ({ value:'task-panel',usage:{ inputTokens:80,cachedInputTokens:20,outputTokens:10 } }));
  await runtime.desktop!.run(task.id,{ id:randomUUID(),app:'mock-app',kind:'click',target:'task-panel',risk:'reversible_write',expectedFingerprint:'mock-app:v1:zh:1280x720',timeoutMs:1000 },o => o.state==='task-panel');
  runtime.tasks.transition(task.id,'succeeded');
  runtime.candidate(task.id);
  console.log(JSON.stringify({ dataDir,...runtime.status() },null,2));
} finally { await runtime.close(); }
