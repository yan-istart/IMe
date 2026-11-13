import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {Runtime} from '../src/core/runtime.js';
import type {Action,DesktopPort} from '../src/core/desktop.js';

// Twenty distinct deterministic UI state machines, never real applications.
const workflows=[
  ['任务面板',['open','filter','select']],['邮件草稿',['compose','recipient','body','preview']],
  ['日历查询',['month','date','details']],['表格筛选',['sheet','column','filter','results']],
  ['文档搜索',['search','query','result']],['文件归档',['folder','select','archive','verify']],
  ['图片浏览',['album','thumbnail','zoom']],['设置修改',['settings','section','toggle','verify']],
  ['离线报表',['reports','period','preview']],['联系人查询',['contacts','query','details']],
  ['音乐列表',['library','playlist','sort']],['购物清单',['list','item','check','summary']],
  ['库存查询',['warehouse','sku','quantity']],['工单检索',['tickets','query','priority','details']],
  ['离线笔记',['notebooks','note','outline']],['地图书签',['bookmarks','place','details']],
  ['课程浏览',['catalog','category','course','outline']],['仪表盘',['dashboard','date','metric']],
  ['离线账单',['invoices','month','preview']],['阅读进度',['library','book','chapter','bookmark']],
] as const;
const price={version:'workflow-fixture-only',currency:'USD',inputPerMillion:'1000000',cachedPerMillion:'100000',outputPerMillion:'2000000'};
class WorkflowDesktop implements DesktopPort {
  cursor=0;
  constructor(readonly app:string,readonly steps:readonly string[]){}
  async observe(app:string,signal:AbortSignal){signal.throwIfAborted();assert.equal(app,this.app);return {fingerprint:app+':semantic-v1',state:'state:'+this.cursor,evidenceRef:'fixture://'+app+'/'+this.cursor};}
  async execute(action:Action,signal:AbortSignal){signal.throwIfAborted();assert.equal(action.target,this.steps[this.cursor]);this.cursor++;}
  async reset(_app:string,_caseId:string,signal:AbortSignal){signal.throwIfAborted();this.cursor=0;}
}
const directory=mkdtempSync(join(tmpdir(),'ime-workflows-'));
const measurements=[];
try {
  for(const [index,[goal,steps]] of workflows.entries()) {
    const app='fixture-app-'+index,dir=join(directory,String(index)),desktop=new WorkflowDesktop(app,steps);
    let runtime=new Runtime({dataDir:dir,allowApps:[app],desktopLeasePath:join(dir,'desktop.lock'),evaluation:{app,cases:['fresh-window','moved-window','restart']}},desktop);
    const create=()=>{const task=runtime.tasks.create('workflow-'+index,goal,app,'100000');runtime.tasks.transition(task.id,'ready');runtime.tasks.transition(task.id,'running');return task;};
    try {
      const baseline=create(),started=performance.now();
      for(const [step,target] of steps.entries()) {
        await runtime.costs.call(baseline.id,price,{inputUpperBound:200+step*30,maxOutput:40,toolAllowance:'0'},async()=>({value:target,usage:{inputTokens:180+step*30,cachedInputTokens:0,outputTokens:20}}));
        const kind:Action['kind']=step%3===0?'click':step%3===1?'input':'scroll';
        await runtime.desktop!.run(baseline.id,{id:randomUUID(),app,kind,target,risk:'reversible_write',timeoutMs:1000,expectedFingerprint:app+':semantic-v1'},observation=>observation.state==='state:'+(step+1));
      }
      runtime.tasks.transition(baseline.id,'succeeded');const baselineLatencyMs=performance.now()-started;
      const id=runtime.candidate(baseline.id);assert.equal((await runtime.evaluateSkill(id,1)).passed,true);runtime.knowledge.publish(id,1);
      const baselineCost=Number(runtime.store.db.prepare('SELECT spent FROM budgets WHERE task_id=?').get(baseline.id)!.spent);
      await runtime.close();
      runtime=new Runtime({dataDir:dir,allowApps:[app],desktopLeasePath:join(dir,'desktop.lock')},desktop);
      desktop.cursor=0;const reused=create(),reuseStart=performance.now();
      await runtime.skills.run(reused.id,id,1);runtime.tasks.transition(reused.id,'succeeded');assert.equal(desktop.cursor,steps.length);
      const reuseCost=Number(runtime.store.db.prepare('SELECT spent FROM budgets WHERE task_id=?').get(reused.id)!.spent);
      measurements.push({workflow:goal,app,steps:steps.length,baselineSuccess:true,reuseSuccess:true,baselineCostMicro:baselineCost,reuseCostMicro:reuseCost,
        baselineLatencyMs,reuseLatencyMs:performance.now()-reuseStart});
    } finally {await runtime.close();}
  }
  const report={scope:'20 distinct deterministic mock UI workflows; synthetic usage and fixture prices; no real application or production savings claim',
    verifiedAt:new Date().toISOString(),workflows:measurements.length,baselineSuccesses:measurements.filter(row=>row.baselineSuccess).length,
    reuseSuccesses:measurements.filter(row=>row.reuseSuccess).length,measurements};
  assert.equal(report.workflows,20);assert.equal(report.reuseSuccesses,report.baselineSuccesses);
  writeFileSync(join(process.cwd(),'docs','workflow-benchmark-report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({workflows:report.workflows,baselineSuccesses:report.baselineSuccesses,reuseSuccesses:report.reuseSuccesses}));
} finally {rmSync(directory,{recursive:true,force:true});}
