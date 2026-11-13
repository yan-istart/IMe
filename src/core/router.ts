import { cost,type Price } from './cost.js';
export interface ModelRoute {provider:string;model:string;tier:'cheap'|'standard'|'strong';vision:boolean;tools:boolean;contextLimit:number;maxOutput:number;privacyRegion:string;price:Price}
export class ModelRouter {
  constructor(private routes:ModelRoute[]) {
    if(!Array.isArray(routes))throw new Error('INVALID_ROUTES');
    for(const r of routes)if(!r.provider||!r.model||!['cheap','standard','strong'].includes(r.tier)||!Number.isSafeInteger(r.contextLimit)||r.contextLimit<1||!Number.isSafeInteger(r.maxOutput)||r.maxOutput<1)throw new Error('INVALID_ROUTE');
    this.routes=structuredClone(routes);
  }
  select(input:{tokens:number;output:number;vision:boolean;tools:boolean;currency:string;remaining:number;failures:number;privacyRegion?:string;localResult?:string}) {
    if(input.localResult!==undefined)return {kind:'local' as const,value:input.localResult};
    if(![input.tokens,input.output,input.remaining,input.failures].every(n=>Number.isSafeInteger(n)&&n>=0))throw new Error('INVALID_ROUTE_REQUEST');
    const tier=input.failures>=2?'strong':input.failures===1?'standard':'cheap';
    const ranks={cheap:0,standard:1,strong:2};
    const candidates=this.routes.filter(r=>(!input.vision||r.vision)&&(!input.tools||r.tools)&&input.tokens+input.output<=r.contextLimit&&input.output<=r.maxOutput&&r.price.currency===input.currency&&(!input.privacyRegion||r.privacyRegion===input.privacyRegion))
      .map(r=>({route:r,amount:cost({...r.price,inputPerMillion:String(Math.max(Number(r.price.inputPerMillion),Number(r.price.cachedPerMillion)))},{inputTokens:input.tokens,cachedInputTokens:0,outputTokens:input.output})})).filter(r=>r.amount<=input.remaining)
      .sort((a,b)=>Math.abs(ranks[a.route.tier]-ranks[tier])-Math.abs(ranks[b.route.tier]-ranks[tier])||a.amount-b.amount);
    if(!candidates.length)throw new Error('NO_ELIGIBLE_MODEL');
    return {kind:'model' as const,...candidates[0]!};
  }
}
