import { createHash } from 'node:crypto';
import type { Store } from './store.js';

export const localEmbeddingModel = 'ime-ngram-256-v1';
export function localEmbedding(text: string): number[] {
  const normalized = text.normalize('NFKC').toLowerCase().slice(0,20000);
  const features: string[] = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const chars = [...normalized.replace(/\s/gu,'')];
  for(let size=1;size<=3;size++)for(let i=0;i+size<=chars.length;i++)features.push(chars.slice(i,i+size).join(''));
  const vector = Array<number>(256).fill(0);
  for(const feature of features) {
    const hash=createHash('sha256').update(feature).digest();
    vector[hash.readUInt16BE(0)%256]! += hash[2]!%2 ? 1 : -1;
  }
  const length=Math.hypot(...vector);
  return length ? vector.map(value=>value/length) : vector;
}
export function validateVector(vector: unknown): asserts vector is number[] {
  if(!Array.isArray(vector)||vector.length<8||vector.length>4096||!vector.every(v=>typeof v==='number'&&Number.isFinite(v))
    || Math.hypot(...vector)===0)throw Error('INVALID_EMBEDDING');
}
export class HybridSearch {
  constructor(private store:Store) {}
  index(id:string,content:string,vector=localEmbedding(content),model=localEmbeddingModel):void {
    validateVector(vector);
    if(typeof model!=='string'||!model||model.length>200)throw Error('INVALID_EMBEDDING_MODEL');
    this.store.db.prepare('INSERT OR REPLACE INTO memory_vectors VALUES(?,?,?,?)')
      .run(id,model,createHash('sha256').update(content).digest('hex'),JSON.stringify(vector));
  }
  retrieve(query:string,app:string,lexical:Record<string,unknown>[],limit:number,embedding?:{model:string;vector:number[]}) {
    const model=embedding?.model ?? localEmbeddingModel, vector=embedding?.vector ?? localEmbedding(query);
    if(!query.trim())return lexical.slice(0,limit);
    if(embedding)validateVector(vector);
    const now=new Date().toISOString();
    // Backfill old databases locally; no network embedding requests occur during retrieval.
    for(const row of this.store.db.prepare(`SELECT m.id,m.content FROM memories m LEFT JOIN memory_vectors v ON v.memory_id=m.id
      WHERE m.app=? AND m.status='active' AND (m.expires_at IS NULL OR m.expires_at>?) AND v.memory_id IS NULL`).all(app,now)) {
      this.index(String(row.id),String(row.content));
    }
    const candidates=this.store.db.prepare(`SELECT m.*,v.vector FROM memories m JOIN memory_vectors v ON v.memory_id=m.id
      WHERE m.app=? AND m.status='active' AND (m.expires_at IS NULL OR m.expires_at>?) AND v.model=?`).all(app,now,model);
    const scored=candidates.flatMap(row=>{
      const other=JSON.parse(String(row.vector)) as number[];
      if(other.length!==vector.length)return [];
      const similarity=other.reduce((sum,value,i)=>sum+value*vector[i]!,0)/(Math.hypot(...other)*Math.hypot(...vector));
      const {vector:_stored,...memory}=row;
      return similarity>=0.12?[{memory,similarity}]:[];
    }).sort((a,b)=>b.similarity-a.similarity).slice(0,50);
    const fused=new Map<string,{memory:Record<string,unknown>;score:number}>();
    const add=(memory:Record<string,unknown>,rank:number)=>{
      const id=String(memory.id),entry=fused.get(id) ?? {memory,score:0};entry.score+=1/(60+rank);fused.set(id,entry);
    };
    lexical.forEach((memory,i)=>add(memory,i+1));scored.forEach((entry,i)=>add(entry.memory,i+1));
    return [...fused.values()].sort((a,b)=>b.score-a.score||String(a.memory.id).localeCompare(String(b.memory.id))).slice(0,limit).map(entry=>entry.memory);
  }
}
