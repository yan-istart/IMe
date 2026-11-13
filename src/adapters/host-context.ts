import type { Runtime } from '../core/runtime.js';
import type { HostContext } from './dsh.js';
export function mountContext(ctx:HostContext,runtime:Runtime) {
  let disposed=false;
  const detach=ctx.on('agent/pre-step',async (raw,next)=>{
    const payload=raw as {agent?:{session?:{id?:string};options?:{provider?:string;model?:string};ctx?:{get:(name:string)=>unknown}};signal?:AbortSignal};
    const downstream=await (next as ()=>Promise<{kind:string;messages?:unknown[]}>)();
    if(disposed||runtime.isClosed)return downstream;
    if(downstream.kind!=='enter')return downstream;
    const sessionId=payload.agent?.session?.id;if(!sessionId)return downstream;
    const task=runtime.store.db.prepare("SELECT * FROM tasks WHERE session_id=? AND status IN ('running','paused','waiting_approval') AND app<>'ime:model' ORDER BY updated_at DESC LIMIT 1").get(sessionId);
    if(!task) {
      const app=runtime.experience.contextApp(sessionId);
      if(!app||!runtime.allowApps.includes(app))return downstream;
      return {...downstream,messages:[...(downstream.messages ?? []),runtime.context.message(runtime.context.buildHost(app))]};
    }
    const checkpoint=runtime.tasks.latest(String(task.id));
    const state={goal:String(task.goal),app:String(task.app),fingerprint:String(checkpoint?.fingerprint ?? ''),checkpointId:String(checkpoint?.id ?? ''),
      permissions:[`仅允许应用 ${String(task.app)}`],constraints:[`任务状态 ${String(task.status)}`,`动作必须验证；预算和权限不可由记忆修改`]};
    const meter=payload.agent?.ctx?.get('tokenMeter') as {estimateMessage?:(message:unknown)=>number;measure?:(session:unknown)=>{totalTokens:number}}|undefined;
    const estimator=meter?.estimateMessage?(text:string)=>{
      try {const tokens=meter.estimateMessage!({role:'user',content:[{type:'text',text}]});if(Number.isFinite(tokens)&&tokens>=0)return tokens;}catch{/* bounded local estimate remains available */}
      return Math.ceil(Buffer.byteLength(text,'utf8')/2);
    }:undefined;
    const route=payload.agent?.options?.provider&&payload.agent.options.model?runtime.router.describe(payload.agent.options.provider,payload.agent.options.model):undefined;
    let available:number|undefined;
    if(route&&meter?.measure)try {
      const pressure=meter.measure(payload.agent?.session).totalTokens;
      if(Number.isFinite(pressure)&&pressure>=0)available=Math.max(0,route.contextLimit-pressure-route.maxOutput);
    } catch {runtime.store.event('ime.context.meter_unavailable',{sessionId});}
    const text=runtime.context.build(state,String(task.id),estimator,available);
    // Non-authoritative recalled context is appended as a user-role data message, never a system policy.
    return {...downstream,messages:[...(downstream.messages ?? []),runtime.context.message(text)]};
  });
  return ()=>{disposed=true;detach();};
}
