import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import { credential, endpoint, readJson } from '../adapters/network.js';

export interface TelemetryConfig {endpoint:string;serviceName?:string;authorizationEnv?:string;autoFlushMs?:number}
const identifier=(value:string,length:number)=>createHash('sha256').update(value).digest('hex').slice(0,length);
const attributes=new Set(['taskId','sessionId','turnId','stepId','actionId','requestId','skillId','version','provider','model','state','certainty','amount','reason','selected','passed']);
export class Telemetry {
  private pending:Promise<unknown>|undefined;
  private timer:ReturnType<typeof setInterval>|undefined;
  private closed=false;
  constructor(private store:Store,readonly config?:TelemetryConfig,private fetcher:typeof fetch=fetch) {
    if(!config)return;
    endpoint(config.endpoint);
    if(config.authorizationEnv&&!/^[A-Z][A-Z0-9_]{0,127}$/.test(config.authorizationEnv))throw Error('INVALID_CREDENTIAL_REFERENCE');
    if(config.autoFlushMs!==undefined&&(!Number.isSafeInteger(config.autoFlushMs)||config.autoFlushMs<1000))throw Error('INVALID_TELEMETRY_INTERVAL');
    if(config.autoFlushMs){this.timer=setInterval(()=>{void this.flush().catch(()=>{});},config.autoFlushMs);this.timer.unref();}
  }
  batch(after=0,limit=200) {
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw Error('INVALID_EXPORT_RANGE');
    const rows=this.store.db.prepare('SELECT * FROM audit_events WHERE seq>? ORDER BY seq LIMIT ?').all(after,limit);
    const spans=rows.map(row=>{
      const data=JSON.parse(String(row.data)) as Record<string,unknown>;
      const when=(BigInt(Date.parse(String(row.created_at)))*1000000n).toString();
      const request=typeof data.requestId==='string'?this.store.db.prepare('SELECT created_at FROM model_requests WHERE id=?').get(data.requestId):undefined;
      const attribution=typeof data.requestId==='string'?this.store.db.prepare('SELECT * FROM request_trace WHERE request_id=?').get(data.requestId):undefined;
      const start=request?(BigInt(Date.parse(String(request.created_at)))*1000000n).toString():when;
      return {traceId:identifier(String(attribution?.task_id??data.taskId??data.sessionId??row.id),32),spanId:identifier(String(row.id),16),name:String(row.type),
        kind:1,startTimeUnixNano:start,endTimeUnixNano:when,
        attributes:Object.entries(data).filter(([key,value])=>attributes.has(key)&&['string','number','boolean'].includes(typeof value))
          .map(([key,value])=>({key:'ime.'+key,value:typeof value==='boolean'?{boolValue:value}:typeof value==='number'?{doubleValue:value}:{stringValue:String(value).slice(0,200)}})),
        status:{code:/failed|denied|uncertain/.test(String(row.type))?2:1}};
    });
    return {cursor:rows.length?Number(rows.at(-1)!.seq):after,count:rows.length,payload:{resourceSpans:[{resource:{attributes:[
      {key:'service.name',value:{stringValue:this.config?.serviceName??'dsh-ime'}}]},scopeSpans:[{scope:{name:'ime',version:'0.2.0'},spans}]}]}};
  }
  status(){const cursor=Number(this.store.db.prepare("SELECT value FROM runtime_meta WHERE key='telemetry.cursor'").get()?.value??0);
    return {enabled:Boolean(this.config),cursor,pending:Number(this.store.db.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE seq>?').get(cursor)?.n??0)};}
  flush():Promise<unknown> {
    if(this.closed)return Promise.reject(Error('TELEMETRY_CLOSED'));
    if(!this.config)return Promise.reject(Error('TELEMETRY_NOT_CONFIGURED'));
    if(this.pending)return this.pending;
    const work=this.send();this.pending=work;
    void work.then(()=>{this.pending=undefined;},()=>{this.pending=undefined;});return work;
  }
  private async send() {
    const batch=this.batch(this.status().cursor);if(!batch.count)return {sent:0};
    const authorization=credential(this.config!.authorizationEnv);
    const response=await this.fetcher(this.config!.endpoint,{method:'POST',headers:{'Content-Type':'application/json',...authorization?{Authorization:authorization}:{}},
      body:JSON.stringify(batch.payload),signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!response.ok)throw Error('TELEMETRY_EXPORT_FAILED');
    const body=await readJson(response,65536) as {partialSuccess?:{rejectedSpans?:number|string}};
    if(!body||typeof body!=='object'||Array.isArray(body))throw Error('INVALID_TELEMETRY_RESPONSE');
    const rejected=Number(body.partialSuccess?.rejectedSpans??0);
    if(!Number.isSafeInteger(rejected)||rejected<0)throw Error('INVALID_TELEMETRY_RESPONSE');
    if(rejected>0)throw Error('TELEMETRY_PARTIAL_REJECTION');
    this.store.db.prepare("INSERT OR REPLACE INTO runtime_meta VALUES('telemetry.cursor',?)").run(String(batch.cursor));
    return {sent:batch.count,cursor:batch.cursor};
  }
  async close(){this.closed=true;if(this.timer)clearInterval(this.timer);await this.pending?.catch(()=>{});}
}
