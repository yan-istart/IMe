import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Runtime} from '../src/core/runtime.js';
import {MockDesktop} from '../src/adapters/mock.js';
import {Dashboard} from '../src/web/dashboard.js';
import {randomUUID} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'ime-dashboard-demo-'));
const runtime=new Runtime({dataDir:dir,allowApps:['mock-app'],desktopLeasePath:join(dir,'desktop.lock'),evaluation:{app:'mock-app',cases:['fresh','restarted','independent']}},new MockDesktop());
const task=runtime.tasks.create('demo','打开模拟任务面板','mock-app','1000000');runtime.tasks.transition(task.id,'ready');runtime.tasks.transition(task.id,'running');
await runtime.desktop!.run(task.id,{id:randomUUID(),app:'mock-app',kind:'click',target:'task-panel',risk:'reversible_write',expectedFingerprint:'mock-app:v1:zh:1280x720',timeoutMs:1000},o=>o.state==='task-panel');
runtime.tasks.transition(task.id,'succeeded');runtime.candidate(task.id);
const dashboard=new Dashboard(runtime,undefined,{desktop:'mock'},Number(process.env.IME_DEMO_PORT ?? 0));await dashboard.ready;
console.log('Demo dashboard ready. Authentication link saved at '+join(dir,'dashboard.url'));
let closing=false;
async function close(){if(closing)return;closing=true;await dashboard.close();await runtime.close();process.exit(0);}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
