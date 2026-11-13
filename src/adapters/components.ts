import type { HostContext } from './dsh.js';
const components = {
  checkpoint: ['session-checkpoint-policy'], tokenMeter: ['token-meter'],
  compaction: ['compaction-basic'], toolResultPruner: ['tool-result-pruner'],
  imageOffload: ['image-offload'], sessionQuery: ['session-query-sqlite'],
  loopGuard: ['repeat-tool-reminder','tool-call-timeout-policy'],
  approval: ['user-approval'], sandbox: ['sandbox-policy','fs-sandbox'], subagent: ['subagent'],
};
/** Composition presence is distinct from a live service in the current agent scope. */
export function hostComponents(ctx: HostContext) {
  const loader=ctx.get('loader') as {entries?():Iterable<{options:{id?:string;disabled?:boolean}}> }|undefined;
  const entries=[...(loader?.entries?.() ?? [])];
  return Object.fromEntries(Object.entries(components).map(([key,ids])=>[key,{
    entries:ids.map(id=>({id,configured:entries.some(e=>e.options.id===id),enabled:entries.some(e=>e.options.id===id&&!e.options.disabled)})),
  }]));
}
