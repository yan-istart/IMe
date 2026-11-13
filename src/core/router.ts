import { cost,type Price } from './cost.js';
import type { Store } from './store.js';
export interface ModelRoute {provider:string;model:string;tier:'cheap'|'standard'|'strong';vision:boolean;tools:boolean;contextLimit:number;maxOutput:number;privacyRegion:string;price:Price;requestsPerMinute?:number}
export interface RouteInput {tokens:number;output:number;vision:boolean;tools:boolean;currency:string;remaining:number;failures:number;privacyRegion?:string;localResult?:string;category?:string}
export interface RouteFeedback {requestId:string;taskId?:string;provider:string;model:string;category:string;success:boolean|null;amount:number;currency:string;latencyMs:number}
export class ModelRouter {
  constructor(private routes:ModelRoute[],private store?:Store) {
    if(!Array.isArray(routes))throw new Error('INVALID_ROUTES');
    for(const r of routes)if(!r.provider||!r.model||!['cheap','standard','strong'].includes(r.tier)||!Number.isSafeInteger(r.contextLimit)||r.contextLimit<1||!Number.isSafeInteger(r.maxOutput)||r.maxOutput<1
      ||(r.requestsPerMinute!==undefined&&(!Number.isSafeInteger(r.requestsPerMinute)||r.requestsPerMinute<1)))throw new Error('INVALID_ROUTE');
    this.routes=structuredClone(routes);
  }
  select(input:RouteInput) {
    if(input.localResult!==undefined)return {kind:'local' as const,value:input.localResult};
    if(![input.tokens,input.output,input.remaining,input.failures].every(n=>Number.isSafeInteger(n)&&n>=0))throw new Error('INVALID_ROUTE_REQUEST');
    const tier=input.failures>=2?'strong':input.failures===1?'standard':'cheap';
    const ranks={cheap:0,standard:1,strong:2};
    const candidates=this.routes.filter(r=>(!input.vision||r.vision)&&(!input.tools||r.tools)&&input.tokens+input.output<=r.contextLimit&&input.output<=r.maxOutput&&r.price.currency===input.currency&&(!input.privacyRegion||r.privacyRegion===input.privacyRegion))
      .filter(r=>!this.store?.db.prepare('SELECT 1 FROM transport_blocks WHERE provider=? AND model=?').get(r.provider,r.model))
      .filter(r=>!r.requestsPerMinute||!this.store||Number(this.store.db.prepare('SELECT COUNT(*) AS n FROM route_feedback WHERE provider=? AND model=? AND created_at>?').get(r.provider,r.model,new Date(Date.now()-60000).toISOString())?.n)<r.requestsPerMinute)
      .map(r=>{
        const amount=cost({...r.price,inputPerMillion:String(Math.max(Number(r.price.inputPerMillion),Number(r.price.cachedPerMillion)))},{inputTokens:input.tokens,cachedInputTokens:0,outputTokens:input.output});
        const history=this.history(r.provider,r.model,input.category ?? 'general',input.currency);
        const quality=history.samples>=3?history.successRate:0.8;
        return {route:r,amount,history,score:(amount||1)/Math.max(quality,0.05)*(1+0.15*Math.abs(ranks[r.tier]-ranks[tier]))};
      }).filter(r=>r.amount<=input.remaining)
      .sort((a,b)=>a.history.samples>=3||b.history.samples>=3?a.score-b.score:
        Math.abs(ranks[a.route.tier]-ranks[tier])-Math.abs(ranks[b.route.tier]-ranks[tier])||a.amount-b.amount);
    if(!candidates.length)throw new Error('NO_ELIGIBLE_MODEL');
    return {kind:'model' as const,...candidates[0]!};
  }
  feedback(input:RouteFeedback) {
    if(!this.store)throw Error('ROUTE_HISTORY_UNAVAILABLE');
    if(!input.requestId||!input.provider||!input.model||!input.category||input.category.length>100
      || !/^[A-Z]{3}$/.test(input.currency)||!(input.success===null||typeof input.success==='boolean')
      ||!Number.isSafeInteger(input.amount)||input.amount<0||!Number.isFinite(input.latencyMs)||input.latencyMs<0)throw Error('INVALID_ROUTE_FEEDBACK');
    this.store.db.prepare('INSERT OR IGNORE INTO route_feedback VALUES(?,?,?,?,?,?,?,?,?,?)').run(input.requestId,input.taskId??null,
      input.provider,input.model,input.category,input.success===null?null:Number(input.success),input.amount,input.currency,input.latencyMs,new Date().toISOString());
  }
  completeTask(taskId:string,success:boolean) {
    this.store?.db.prepare('UPDATE route_feedback SET success=? WHERE task_id=? AND success IS NULL').run(Number(success),taskId);
  }
  history(provider:string,model:string,category:string,currency:string) {
    const rows=this.store?.db.prepare(`SELECT success,amount,latency_ms FROM route_feedback WHERE provider=? AND model=? AND category=? AND currency=? AND success IS NOT NULL ORDER BY rowid DESC LIMIT 100`).all(provider,model,category,currency) ?? [];
    const successes=rows.filter(row=>Number(row.success)===1).length;
    return {samples:rows.length,successRate:(successes+1)/(rows.length+2),
      costPerSuccess:successes?rows.reduce((sum,row)=>sum+Number(row.amount),0)/successes:null,
      latencyMs:rows.length?rows.reduce((sum,row)=>sum+Number(row.latency_ms),0)/rows.length:null};
  }
  statistics(){return this.store?.db.prepare('SELECT provider,model,category,currency,COUNT(*) AS samples,AVG(success) AS successRate,SUM(amount) AS amountMicro FROM route_feedback GROUP BY provider,model,category,currency').all() ?? [];}
  describe(provider:string,model:string){return this.routes.find(route=>route.provider===provider&&route.model===model);}
}
