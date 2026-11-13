import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { Knowledge, MemoryKind, SkillDocument } from './knowledge.js';
import { credential, endpoint, readJson } from '../adapters/network.js';

export interface SyncConfig {namespace:string;keyEnv:string;endpoint?:string;authorizationEnv?:string}
interface SyncRecord {origin:string;kind:'memory'|'skill'|'delete';sourceId:string;revision:string;payload:Record<string,unknown>}
interface Snapshot {version:1;namespace:string;records:SyncRecord[]}
interface Envelope {version:1;namespace:string;iv:string;tag:string;ciphertext:string}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const recordKey=(record:SyncRecord)=>hash([record.origin,record.kind,record.sourceId,record.revision]);
export class SyncManager {
  readonly deviceId:string;
  private pending:Promise<unknown>|undefined;
  private closed=false;
  constructor(private store:Store,private knowledge:Knowledge,readonly config?:SyncConfig,private fetcher:typeof fetch=fetch) {
    const existing=store.db.prepare("SELECT value FROM runtime_meta WHERE key='sync.device'").get();
    this.deviceId=existing?String(existing.value):randomUUID();
    if(!existing)store.db.prepare("INSERT INTO runtime_meta VALUES('sync.device',?)").run(this.deviceId);
    if(config) {
      if(!/^[A-Za-z0-9_-]{1,100}$/.test(config.namespace)||!/^[A-Z][A-Z0-9_]{0,127}$/.test(config.keyEnv))throw Error('INVALID_SYNC_CONFIG');
      if(config.endpoint)endpoint(config.endpoint);
      if(config.authorizationEnv&&!/^[A-Z][A-Z0-9_]{0,127}$/.test(config.authorizationEnv))throw Error('INVALID_CREDENTIAL_REFERENCE');
    }
  }
  private key() {const value=credential(this.config?.keyEnv);const key=Buffer.from(value??'','base64');if(key.length!==32)throw Error('SYNC_KEY_REQUIRED');return key;}
  private snapshot():Snapshot {
    if(!this.config)throw Error('SYNC_NOT_CONFIGURED');
    const records:SyncRecord[]=this.store.db.prepare('SELECT payload FROM sync_records').all().map(row=>JSON.parse(String(row.payload)) as SyncRecord);
    const imported=new Set(this.store.db.prepare('SELECT local_id FROM sync_records WHERE local_id IS NOT NULL').all().map(row=>String(row.local_id)));
    for(const memory of this.store.db.prepare('SELECT * FROM memories').all()) {
      if(imported.has(String(memory.id)))continue;
      const payload={kind:memory.kind,app:memory.app,content:memory.content,expiresAt:memory.expires_at,status:memory.status};
      records.push({origin:this.deviceId,kind:'memory',sourceId:String(memory.id),revision:hash(payload),payload});
    }
    for(const skill of this.store.db.prepare('SELECT * FROM skill_versions').all()) {
      const sourceId=String(skill.skill_id)+':'+String(skill.version);if(imported.has(sourceId))continue;
      const document=this.knowledge.skill(String(skill.skill_id),Number(skill.version)).document;
      const payload={document};records.push({origin:this.deviceId,kind:'skill',sourceId,revision:hash(payload),payload});
    }
    for(const row of this.store.db.prepare("SELECT data FROM audit_events WHERE type='ime.memory.deleted'").all()) {
      const id=String((JSON.parse(String(row.data)) as {memoryId:string}).memoryId);
      const payload={kind:'memory',id};records.push({origin:this.deviceId,kind:'delete',sourceId:id,revision:hash(payload),payload});
    }
    const unique=[...new Map(records.map(record=>[recordKey(record),record])).values()];
    if(unique.length>5000)throw Error('SYNC_RECORD_LIMIT');
    return {version:1,namespace:this.config.namespace,records:unique};
  }
  export():Envelope {
    const snapshot=this.snapshot(),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key(),iv);
    cipher.setAAD(Buffer.from('ime-sync-v1:'+snapshot.namespace));
    const encrypted=Buffer.concat([cipher.update(JSON.stringify(snapshot)),cipher.final()]);
    return {version:1,namespace:snapshot.namespace,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')};
  }
  import(raw:unknown) {
    if(!this.config)throw Error('SYNC_NOT_CONFIGURED');
    const envelope=raw as Envelope;
    if(!envelope||envelope.version!==1||envelope.namespace!==this.config.namespace||typeof envelope.ciphertext!=='string'||envelope.ciphertext.length>16*1024*1024
      ||typeof envelope.iv!=='string'||typeof envelope.tag!=='string')throw Error('INVALID_SYNC_ENVELOPE');
    let snapshot:Snapshot;
    try {
      const decipher=createDecipheriv('aes-256-gcm',this.key(),Buffer.from(envelope.iv,'base64'));
      decipher.setAAD(Buffer.from('ime-sync-v1:'+this.config.namespace));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
      snapshot=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString()) as Snapshot;
    } catch {throw Error('SYNC_AUTHENTICATION_FAILED');}
    if(snapshot.version!==1||snapshot.namespace!==this.config.namespace||!Array.isArray(snapshot.records)||snapshot.records.length>5000)throw Error('INVALID_SYNC_SNAPSHOT');
    let added=0;
    this.store.transaction(()=>{
      for(const record of snapshot.records) {
        if(!record||!['memory','skill','delete'].includes(record.kind)||typeof record.origin!=='string'||!record.origin||record.origin.length>100
          ||typeof record.sourceId!=='string'||!record.sourceId||record.sourceId.length>300||!record.payload||Array.isArray(record.payload)||hash(record.payload)!==record.revision)throw Error('INVALID_SYNC_RECORD');
        if(record.origin===this.deviceId)continue;
        added+=Number(this.store.db.prepare('INSERT OR IGNORE INTO sync_records VALUES(?,?,?,?,?,?,?,NULL)').run(recordKey(record),record.origin,record.kind,
          record.sourceId,record.revision,JSON.stringify(record),'pending').changes);
      }
      if(Number(this.store.db.prepare('SELECT COUNT(*) AS n FROM sync_records').get()!.n)>5000)throw Error('SYNC_RECORD_LIMIT');
      this.store.event('ime.sync.imported',{records:added});
    });
    return {added};
  }
  /** Only authenticated local user commands can apply remote knowledge. */
  apply(key:string,allow:boolean) {
    return this.store.transaction(()=>{
    const row=this.store.db.prepare("SELECT * FROM sync_records WHERE record_key=? AND status='pending'").get(key);if(!row)throw Error('SYNC_RECORD_NOT_PENDING');
    const record=JSON.parse(String(row.payload)) as SyncRecord;let localId:string|null=null;
    if(allow) {
      if(record.kind==='memory') {
        const p=record.payload;
        localId=this.knowledge.propose({kind:p.kind as MemoryKind,content:p.content as string,app:p.app as string,trust:'model_inferred',sourceEventIds:[],
          ...typeof p.expiresAt==='string'&&Date.parse(p.expiresAt)>Date.now()?{expiresAt:p.expiresAt}:{}});
        // Applying admits a candidate; the usual memory review is still required.
      } else if(record.kind==='skill') {
        const document=structuredClone(record.payload.document) as SkillDocument;
        if(document.dependencies)document.dependencies=document.dependencies.map(dependency=>{
          const mapped=this.store.db.prepare("SELECT local_id FROM sync_records WHERE origin=? AND kind='skill' AND source_id=? AND status='applied' AND local_id IS NOT NULL ORDER BY rowid DESC LIMIT 1")
            .get(record.origin,dependency.id+':'+dependency.version);
          if(!mapped)throw Error('SYNC_DEPENDENCY_REVIEW_REQUIRED');
          const value=String(mapped.local_id),separator=value.lastIndexOf(':');return {id:value.slice(0,separator),version:Number(value.slice(separator+1))};
        });
        const skill=this.knowledge.proposeSkill(document);
        localId=skill.id+':'+skill.version;
      } else {
        for(const mapping of this.store.db.prepare("SELECT local_id FROM sync_records WHERE origin=? AND source_id=? AND kind='memory' AND local_id IS NOT NULL").all(record.origin,record.sourceId))this.knowledge.deleteMemory(String(mapping.local_id));
      }
    }
    this.store.db.prepare('UPDATE sync_records SET status=?,local_id=? WHERE record_key=?').run(allow?'applied':'rejected',localId,key);
    this.store.event('ime.sync.reviewed',{recordKey:key,allowed:allow});return {localId};
    });
  }
  status(){return {configured:Boolean(this.config),deviceId:this.deviceId,pending:this.store.db.prepare("SELECT record_key,origin,kind,source_id,revision,payload FROM sync_records WHERE status='pending' ORDER BY rowid LIMIT 200").all()};}
  exchange():Promise<unknown> {
    if(this.closed)return Promise.reject(Error('SYNC_CLOSED'));
    if(!this.config?.endpoint)return Promise.reject(Error('SYNC_ENDPOINT_REQUIRED'));
    if(this.pending)return this.pending;
    const work=this.transfer();this.pending=work;void work.then(()=>{this.pending=undefined;},()=>{this.pending=undefined;});return work;
  }
  private async transfer() {
    const authorization=credential(this.config!.authorizationEnv),headers:Record<string,string>={...authorization?{Authorization:authorization}:{}};
    const response=await this.fetcher(this.config!.endpoint!,{headers,signal:AbortSignal.timeout(10000),redirect:'error'});
    let etag:string|undefined;
    if(response.status===200){etag=response.headers.get('etag')??undefined;if(!etag)throw Error('SYNC_ETAG_REQUIRED');this.import(await readJson(response,16*1024*1024));}
    else if(response.status!==404)throw Error('SYNC_DOWNLOAD_FAILED');
    const upload=await this.fetcher(this.config!.endpoint!,{method:'PUT',headers:{...headers,'Content-Type':'application/json',...etag?{'If-Match':etag}:{'If-None-Match':'*'}},
      body:JSON.stringify(this.export()),signal:AbortSignal.timeout(10000),redirect:'error'});
    if(upload.status===412||upload.status===409)throw Error('SYNC_CONCURRENT_UPDATE');
    if(!upload.ok)throw Error('SYNC_UPLOAD_FAILED');return {ok:true,...this.status()};
  }
  async close(){this.closed=true;await this.pending?.catch(()=>{});}
}
