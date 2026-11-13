import type { HostContext } from './dsh.js';
import type { Runtime } from '../core/runtime.js';
interface CompactionAgent {ctx:{get(name:string):unknown};session:{id:string}}
interface NativeCompaction {compactNow(agent:CompactionAgent,signal:AbortSignal):Promise<{compactionId:string;summary:{type:string;text?:string}[]}|null>}
export async function compactNative(ctx:HostContext,runtime:Runtime,sessionId:string) {
  const registry=ctx.get('agents') as {get?(id:string):CompactionAgent|undefined}|undefined;
  const agent=registry?.get?.(sessionId);
  const native=agent?.ctx.get('compaction') as NativeCompaction|undefined;
  if(!agent||!native||typeof native.compactNow!=='function')throw Error('NATIVE_COMPACTION_UNAVAILABLE');
  const result=await native.compactNow(agent,new AbortController().signal);
  const task=runtime.store.db.prepare("SELECT * FROM tasks WHERE session_id=? AND app<>'ime:model' ORDER BY updated_at DESC LIMIT 1").get(sessionId);
  let restored=false;
  if(task&&result) {
    const checkpoint=runtime.tasks.latest(String(task.id));
    const state={goal:String(task.goal),constraints:['动作必须验证；预算和权限不可由记忆修改'],permissions:[`仅允许应用 ${String(task.app)}`],checkpointId:String(checkpoint?.id ?? ''),fingerprint:String(checkpoint?.fingerprint ?? ''),app:String(task.app)};
    const summary=result.summary.filter(b=>b.type==='text').map(b=>b.text ?? '').join('\n');
    restored=!runtime.context.checkSummary(summary,state);
    // Native history is never rewritten a second time. The independent task snapshot is re-injected on next pre-step.
    runtime.store.event('ime.context.native_compacted',{sessionId,compactionId:result.compactionId,invariantsReinjected:restored});
  }
  return {compacted:Boolean(result),compactionId:result?.compactionId ?? null,invariantsReinjected:restored};
}
