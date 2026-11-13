import type { Runtime } from '../core/runtime.js';
import type { HostContext } from './dsh.js';
export function mountContext(ctx:HostContext,runtime:Runtime) {
  return ctx.on('agent/pre-step',async (raw,next)=>{
    const payload=raw as {agent?:{session?:{id?:string};ctx?:{get:(name:string)=>unknown}};signal?:AbortSignal};
    const downstream=await (next as ()=>Promise<{kind:string;messages?:unknown[]}>)();
    if(downstream.kind!=='enter')return downstream;
    const sessionId=payload.agent?.session?.id;if(!sessionId)return downstream;
    const task=runtime.store.db.prepare("SELECT * FROM tasks WHERE session_id=? AND status IN ('running','paused','waiting_approval') AND app<>'ime:model' ORDER BY updated_at DESC LIMIT 1").get(sessionId);
    if(!task)return downstream;
    const checkpoint=runtime.tasks.latest(String(task.id));
    const state={goal:String(task.goal),app:String(task.app),fingerprint:String(checkpoint?.fingerprint ?? ''),checkpointId:String(checkpoint?.id ?? ''),
      permissions:[`仅允许应用 ${String(task.app)}`],constraints:[`任务状态 ${String(task.status)}`,`动作必须验证；预算和权限不可由记忆修改`]};
    const text=runtime.context.build(state,String(task.id));
    // Non-authoritative recalled context is appended as a user-role data message, never a system policy.
    return {...downstream,messages:[...(downstream.messages ?? []),runtime.context.message(text)]};
  });
}
