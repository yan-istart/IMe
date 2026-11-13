import type { HostContext } from './dsh.js';
import { normalizeUsage } from './model-gateway.js';
import type { Usage } from '../core/cost.js';

export interface ModelPortRequest {provider:string;model:string;maxOutput:number;prompt:string;sessionId:string;signal:AbortSignal;image?:{data:Uint8Array;mediaType:'image/png'};budget?:{requestId:string;reservationId:string}}
/** Only authoritative preflight checks may classify a request as never dispatched. */
export class BeforeDispatchError extends Error {readonly dispatched=false;}
export interface ModelPortResult {text:string;usage?:Usage}
export interface ModelPort {generate(request:ModelPortRequest):Promise<ModelPortResult>;owns?(request:unknown):boolean}
interface Prepared {config:Record<string,unknown>;stream(options:Record<string,unknown>):AsyncIterable<Record<string,unknown>>}
interface HostLlm {prepareCall(config:{provider:string;model:string;maxTokens:number},signal:AbortSignal):Promise<Prepared>}
/** Calls the pinned, existing LLM service. No second provider or request mutation. */
export class HostModelPort implements ModelPort {
  private owned=new WeakSet<object>();
  constructor(private ctx:HostContext){}
  owns(request:unknown){return request!==null&&typeof request==='object'&&this.owned.has(request);}
  async generate(request:ModelPortRequest):Promise<ModelPortResult> {
    const llm=this.ctx.get('llm') as HostLlm|undefined;if(!llm?.prepareCall)throw Error('MODEL_SERVICE_UNAVAILABLE');
    const prepared=await llm.prepareCall({provider:request.provider,model:request.model,maxTokens:request.maxOutput},request.signal);
    const content:unknown[]=[{type:'text',text:request.prompt}];
    if(request.image) {
      const attachments=this.ctx.get('attachments') as {saveImage?:(input:{data:Uint8Array;mediaType:string;name:string})=>Promise<unknown>}|undefined;
      if(!attachments?.saveImage)throw Error('IMAGE_ATTACHMENT_SERVICE_UNAVAILABLE');
      const attachment=await attachments.saveImage({...request.image,name:'IMe redacted keyframe.png'});content.push({type:'image',attachment});
    }
    const options={...prepared.config,messages:[{role:'user',content}],sessionId:request.sessionId,signal:request.signal};
    this.owned.add(options);let text='',usage:Usage|undefined,finished=false,cacheWrites=false;
    try {
      for await(const chunk of prepared.stream(options)) {
        request.signal.throwIfAborted();
        if(finished)throw Error('MODEL_CHUNK_AFTER_FINISH');
        if(chunk.type==='text-delta')text+=String(chunk.text??'');
        if(text.length>200000)throw Error('MODEL_RESPONSE_TOO_LARGE');
        if(chunk.type==='usage'){usage=normalizeUsage(chunk.usage);cacheWrites ||= Number((chunk.usage as Record<string,unknown>).cacheWriteTokens??0)>0;}
        if(chunk.type==='finish') {
          finished=true;const reason=chunk.reason as {kind?:string};if(reason?.kind!=='stop')throw Error('MODEL_RESPONSE_INCOMPLETE');
        }
      }
      if(!finished)throw Error('MODEL_RESPONSE_INCOMPLETE');
      return {text,...usage&&!cacheWrites?{usage}:{}};
    } finally {this.owned.delete(options);}
  }
}
