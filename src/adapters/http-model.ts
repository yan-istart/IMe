import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import type {Runtime} from '../core/runtime.js';
import {BeforeDispatchError,type ModelPort,type ModelPortRequest,type ModelPortResult} from './host-model.js';
import {credential,endpoint} from './network.js';
import type {Quote,Usage} from '../core/cost.js';

export interface HttpModelRoute {provider:string;model:string;endpoint:string;credentialEnv?:string;inputOverheadTokens:number;maxResponseBytes?:number}
export function validateHttpModels(routes:unknown):asserts routes is HttpModelRoute[] {
  if(!Array.isArray(routes)||!routes.length||routes.length>20)throw Error('INVALID_HTTP_MODELS');
  const seen=new Set<string>();
  for(const route of routes as HttpModelRoute[]) {
    if(!route||typeof route!=='object'||Array.isArray(route)||Object.keys(route).some(key=>!['provider','model','endpoint','credentialEnv','inputOverheadTokens','maxResponseBytes'].includes(key))
      ||typeof route.provider!=='string'||!route.provider||typeof route.model!=='string'||!route.model||!Number.isSafeInteger(route.inputOverheadTokens)||route.inputOverheadTokens<1||route.inputOverheadTokens>100000
      ||route.maxResponseBytes!==undefined&&(!Number.isSafeInteger(route.maxResponseBytes)||route.maxResponseBytes<1024||route.maxResponseBytes>16*1024*1024)
      ||route.credentialEnv!==undefined&&!/^[A-Z][A-Z0-9_]{0,127}$/.test(route.credentialEnv))throw Error('INVALID_HTTP_MODEL_ROUTE');
    endpoint(route.endpoint);const key=JSON.stringify([route.provider,route.model]);if(seen.has(key))throw Error('DUPLICATE_HTTP_MODEL_ROUTE');seen.add(key);
  }
}
/** One native HTTP POST per reservation. No redirects, SDK retries or arbitrary URLs. */
export class HttpModelPort implements ModelPort {
  constructor(private runtime:Runtime,private routes:HttpModelRoute[]) {validateHttpModels(routes);this.routes=structuredClone(routes);}
  supports(provider:string,model:string){return this.routes.some(route=>route.provider===provider&&route.model===model);}
  async generate(input:ModelPortRequest):Promise<ModelPortResult> {
    const route=this.routes.find(route=>route.provider===input.provider&&route.model===input.model);
    let quote:Quote,authorization:string|undefined,body:Buffer;
    try {
      input.signal.throwIfAborted();if(!route)throw Error('HTTP_MODEL_ROUTE_UNAVAILABLE');
      if(input.image)throw Error('HTTP_IMAGE_BOUND_UNVERIFIED');
      if(this.runtime.store.db.prepare('SELECT reason FROM transport_blocks WHERE provider=? AND model=?').get(input.provider,input.model))throw Error('HTTP_MODEL_ROUTE_BLOCKED');
      const receipt=input.budget;if(!receipt)throw Error('HTTP_BUDGET_RECEIPT_REQUIRED');
      const reservation=this.runtime.store.db.prepare("SELECT * FROM reservations WHERE id=? AND request_id=? AND state='reserved'").get(receipt.reservationId,receipt.requestId);
      if(!reservation||!this.runtime.tasks.executionAllowed(String(reservation.task_id)))throw Error('HTTP_BUDGET_RECEIPT_INVALID');
      const task=this.runtime.tasks.get(String(reservation.task_id));if(task.session_id!==input.sessionId)throw Error('HTTP_BUDGET_SESSION_MISMATCH');
      const request=this.runtime.store.db.prepare('SELECT provider,model FROM model_requests WHERE id=? AND reservation_id=?').get(receipt.requestId,receipt.reservationId);
      if(request?.provider!==input.provider||request.model!==input.model)throw Error('HTTP_BUDGET_ROUTE_MISMATCH');
      quote=JSON.parse(String(reservation.quote)) as Quote;
      if(quote.request.maxOutput!==input.maxOutput||quote.amount!==this.runtime.costs.quote(quote.price,quote.request).amount
        ||Buffer.byteLength(input.prompt,'utf8')+route.inputOverheadTokens>quote.request.inputUpperBound)throw Error('HTTP_INPUT_BOUND_REQUIRED');
      const current=this.runtime.models.route(input.provider,input.model);
      if(JSON.stringify(current.price)!==JSON.stringify(quote.price))throw Error('HTTP_PRICE_CHANGED');
      const token=credential(route.credentialEnv);authorization=token?'Bearer '+token:undefined;
      body=Buffer.from(JSON.stringify({model:input.model,messages:[{role:'user',content:input.prompt}],max_tokens:input.maxOutput,stream:false}));
      // Consume a durable receipt before any request object or socket is created.
      this.runtime.store.transaction(()=>{
        if(this.runtime.store.db.prepare('SELECT request_id FROM transport_attempts WHERE reservation_id=?').get(receipt.reservationId))throw Error('HTTP_RECEIPT_ALREADY_USED');
        this.runtime.store.db.prepare('INSERT INTO transport_attempts VALUES(?,?,?,?,?,?)').run(receipt.requestId,receipt.reservationId,input.provider,input.model,'dispatching',new Date().toISOString());
        this.runtime.store.event('ime.transport.dispatching',{taskId:task.id,requestId:receipt.requestId,provider:input.provider,model:input.model});
      });
    } catch(error) {throw new BeforeDispatchError(error instanceof Error?error.message:'HTTP_PREFLIGHT_FAILED');}
    const id=input.budget!.requestId;
    try {
      const raw=await this.post(route!,body!,authorization,input.signal);
      const result=raw as {id?:unknown;choices?:{message?:{content?:unknown};finish_reason?:unknown}[];usage?:Record<string,unknown>};
      if(!result||!Array.isArray(result.choices)||result.choices.length!==1||typeof result.choices[0]?.message?.content!=='string')throw Error('HTTP_MODEL_RESPONSE_INVALID');
      if(typeof result.id==='string'&&/^[A-Za-z0-9._:-]{1,200}$/.test(result.id))this.runtime.store.db.prepare('INSERT OR IGNORE INTO provider_receipts VALUES(?,?,?)').run(id,input.provider,result.id);
      let usage:Usage|undefined;
      if(result.usage) {
        const u=result.usage,details=u.prompt_tokens_details as {cached_tokens?:unknown}|undefined;
        const cached=u.prompt_cache_hit_tokens??details?.cached_tokens??0;
        if(![u.prompt_tokens,u.completion_tokens,cached].every(value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)||Number(cached)>Number(u.prompt_tokens))throw Error('HTTP_MODEL_USAGE_INVALID');
        usage={inputTokens:Number(u.prompt_tokens),cachedInputTokens:Number(cached),outputTokens:Number(u.completion_tokens)};
        if(usage.inputTokens>quote!.request.inputUpperBound||usage.outputTokens>input.maxOutput) {
          this.runtime.store.db.prepare('INSERT OR REPLACE INTO transport_blocks VALUES(?,?,?,?)').run(input.provider,input.model,'PROVIDER_BOUND_VIOLATION',new Date().toISOString());
          this.runtime.store.event('ime.transport.bound_violation',{requestId:id,provider:input.provider,model:input.model});
        }
        if(Number((u.prompt_tokens_details as {cache_creation_tokens?:unknown}|undefined)?.cache_creation_tokens??0)>0)usage=undefined;
      }
      if(result.choices[0]!.finish_reason!=='stop'&&!(usage&&(usage.inputTokens>quote!.request.inputUpperBound||usage.outputTokens>input.maxOutput)))throw Error('HTTP_MODEL_RESPONSE_INCOMPLETE');
      this.runtime.store.db.prepare("UPDATE transport_attempts SET state='finished' WHERE request_id=?").run(id);
      return {text:result.choices[0]!.message!.content as string,...usage?{usage}:{}};
    } catch(error) {
      this.runtime.store.db.prepare("UPDATE transport_attempts SET state='unknown' WHERE request_id=?").run(id);throw error;
    }
  }
  private post(route:HttpModelRoute,body:Buffer,authorization:string|undefined,signal:AbortSignal):Promise<unknown> {
    const url=endpoint(route.endpoint),send=url.protocol==='https:'?httpsRequest:httpRequest,max=route.maxResponseBytes??4*1024*1024;
    return new Promise((resolve,reject)=>{
      const request=send(url,{method:'POST',agent:false,signal,headers:{'Content-Type':'application/json','Content-Length':body.length,...authorization?{Authorization:authorization}:{}}},response=>{
        if(response.statusCode!==200){response.resume();reject(Error('HTTP_MODEL_STATUS_'+String(response.statusCode)));return;}
        if(Number(response.headers['content-length']??0)>max){response.destroy();reject(Error('HTTP_MODEL_RESPONSE_TOO_LARGE'));return;}
        const chunks:Buffer[]=[];let size=0;
        response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>max){response.destroy();reject(Error('HTTP_MODEL_RESPONSE_TOO_LARGE'));}else chunks.push(chunk);});
        response.on('error',()=>reject(Error('HTTP_MODEL_TRANSPORT_FAILED')));
        response.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Error('HTTP_MODEL_RESPONSE_INVALID'));}});
      });
      request.on('error',()=>reject(signal.aborted?signal.reason:Error('HTTP_MODEL_TRANSPORT_FAILED')));
      request.setTimeout(30000,()=>request.destroy(Error('HTTP_MODEL_TIMEOUT')));request.end(body);
    });
  }
  reset(provider:string,model:string) {
    this.runtime.store.db.prepare('DELETE FROM transport_blocks WHERE provider=? AND model=?').run(provider,model);
    this.runtime.store.event('ime.transport.reset',{provider,model});
  }
  status(){return {configured:this.routes.length,scope:'ime-managed-http',requestBoundaryGuard:true,hardLimit:false,
    blocks:this.runtime.store.db.prepare('SELECT * FROM transport_blocks').all(),attempts:this.runtime.store.db.prepare(`SELECT a.*,p.provider_request_id FROM transport_attempts a
      LEFT JOIN provider_receipts p ON p.request_id=a.request_id ORDER BY a.rowid DESC LIMIT 30`).all()};}
}
