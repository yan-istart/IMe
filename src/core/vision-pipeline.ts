import { mkdirSync,writeFileSync,readdirSync,statSync,unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { VisionFilter,type Frame,type ROI } from './vision.js';
export interface VisionConfig {threshold:number;maxKeyframesPerMinute:number;retentionMs:number;storeFrames:boolean;redact?:ROI[];roi?:ROI}
export class VisionPipeline {
  private filter:VisionFilter;private selected:number[]=[];
  constructor(private dir:string,private config:VisionConfig) {
    if(!Number.isSafeInteger(config.maxKeyframesPerMinute)||config.maxKeyframesPerMinute<1||!Number.isFinite(config.retentionMs)||config.retentionMs<0)throw Error('INVALID_VISION_CONFIG');
    this.filter=new VisionFilter(config.threshold);
  }
  process(frame:Frame,options:{roi?:ROI;redact?:ROI[];reason?:'change'|'verify'|'transition'|'popup'}={}) {
    if(!Number.isFinite(frame.timestamp)||frame.timestamp<0)throw Error('INVALID_FRAME_TIME');
    const pixels=frame.pixels.slice();
    for(const r of options.redact ?? []) {
      if(![r.x,r.y,r.width,r.height].every(Number.isSafeInteger)||r.x<0||r.y<0||r.width<1||r.height<1||r.x+r.width>frame.width||r.y+r.height>frame.height)throw Error('INVALID_REDACTION');
      for(let y=r.y;y<r.y+r.height;y++)pixels.fill(0,y*frame.width+r.x,y*frame.width+r.x+r.width);
    }
    const force=options.reason!==undefined&&options.reason!=='change';
    this.selected=this.selected.filter(t=>t>frame.timestamp-60000);
    if(!force&&this.selected.length>=this.config.maxKeyframesPerMinute)return {selected:false,reason:'rate_limit'};
    const result=this.filter.select({...frame,pixels},options.roi,force);
    if(!result.selected)return result;
    this.selected.push(frame.timestamp);
    let evidenceRef='ime:keyframe:'+randomUUID();
    if(this.config.storeFrames) {
      mkdirSync(this.dir,{recursive:true,mode:0o700});
      const name=randomUUID()+'.pgm';writeFileSync(join(this.dir,name),Buffer.concat([Buffer.from(`P5\n${frame.width} ${frame.height}\n255\n`),pixels]),{mode:0o600});evidenceRef=name;
    }
    return {...result,evidenceRef,reason:options.reason ?? 'change'};
  }
  cleanup(now=Date.now()) {
    mkdirSync(this.dir,{recursive:true,mode:0o700});let deleted=0;
    for(const entry of readdirSync(this.dir,{withFileTypes:true})) {
      if(entry.isFile()&&entry.name.endsWith('.pgm')&&now-statSync(join(this.dir,entry.name)).mtimeMs>=this.config.retentionMs){unlinkSync(join(this.dir,entry.name));deleted++;}
    }return deleted;
  }
}
