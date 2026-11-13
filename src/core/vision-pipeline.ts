import { mkdirSync,readFileSync,writeFileSync,readdirSync,statSync,unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { VisionFilter,type Frame,type ROI } from './vision.js';
import {grayscalePng} from './png.js';
export interface VisualStateRule {name:string;regions:{roi:ROI;mean:number;tolerance:number}[]}
export interface VisionConfig {threshold:number;maxKeyframesPerMinute:number;retentionMs:number;storeFrames:boolean;redact?:ROI[];roi?:ROI;
  sampleFps?:number;adaptive?:boolean;stableWindowMs?:number;states?:VisualStateRule[]}
export interface KeyframeSummary {app:string;timestamp:number;sequence:number;reason:string;change:number;evidenceRef:string;actionId?:string;state?:string}
export class VisionPipeline {
  private filter:VisionFilter;private selected:number[]=[];
  private history:KeyframeSummary[]=[];
  private sequence=0;
  private lastCleanup=0;
  private latest=new Map<string,{pixels:Uint8Array;width:number;height:number;timestamp:number;evidenceRef:string}>();
  private samples=new Map<string,{time:number;interval:number;hash:string;since:number;state?:string}>();
  constructor(private dir:string,private config:VisionConfig) {
    if(!Number.isSafeInteger(config.maxKeyframesPerMinute)||config.maxKeyframesPerMinute<1||!Number.isFinite(config.retentionMs)||config.retentionMs<0)throw Error('INVALID_VISION_CONFIG');
    this.filter=new VisionFilter(config.threshold);
    if(config.sampleFps!==undefined&&(!Number.isFinite(config.sampleFps)||config.sampleFps<=0||config.sampleFps>30)
      ||config.stableWindowMs!==undefined&&(!Number.isFinite(config.stableWindowMs)||config.stableWindowMs<0||config.stableWindowMs>60000)
      ||config.adaptive!==undefined&&typeof config.adaptive!=='boolean')throw Error('INVALID_VISION_CONFIG');
    if(config.states&&(!Array.isArray(config.states)||config.states.length>100||config.states.some(state=>!state.name||!Array.isArray(state.regions)||!state.regions.length
      ||state.regions.some(region=>!Number.isFinite(region.mean)||region.mean<0||region.mean>255||!Number.isFinite(region.tolerance)||region.tolerance<0||region.tolerance>255))))throw Error('INVALID_VISUAL_STATES');
  }
  process(frame:Frame,options:{roi?:ROI;redact?:ROI[];reason?:'change'|'verify'|'transition'|'popup';actionId?:string}={}) {
    if(!Number.isFinite(frame.timestamp)||frame.timestamp<0)throw Error('INVALID_FRAME_TIME');
    if(!Number.isSafeInteger(frame.width)||!Number.isSafeInteger(frame.height)||frame.width<1||frame.height<1
      ||frame.width*frame.height>10000000||!(frame.pixels instanceof Uint8Array)||frame.pixels.length!==frame.width*frame.height)throw Error('INVALID_FRAME_ROI');
    if(Date.now()-this.lastCleanup>=60000){this.cleanup();this.lastCleanup=Date.now();}
    const pixels=frame.pixels.slice();
    for(const r of options.redact ?? this.config.redact ?? []) {
      if(![r.x,r.y,r.width,r.height].every(Number.isSafeInteger)||r.x<0||r.y<0||r.width<1||r.height<1||r.x+r.width>frame.width||r.y+r.height>frame.height)throw Error('INVALID_REDACTION');
      for(let y=r.y;y<r.y+r.height;y++)pixels.fill(0,y*frame.width+r.x,y*frame.width+r.x+r.width);
    }
    const previous=this.samples.get(frame.app);
    const state=this.recognize(pixels,frame.width,frame.height);
    const transition=state!==undefined&&state!==previous?.state;
    const force=transition||options.reason!==undefined&&options.reason!=='change';
    const interval=previous?.interval??(this.config.sampleFps?1000/this.config.sampleFps:0);
    if(!force&&previous&&frame.timestamp-previous.time<interval)return {selected:false,reason:'sample_interval'};
    const hash=this.sampleHash(pixels),since=hash===previous?.hash?previous.since:frame.timestamp;
    const sample={time:frame.timestamp,interval,hash,since,...state?{state}:{}};
    this.samples.set(frame.app,sample);
    if(this.samples.size>100)this.samples.delete(this.samples.keys().next().value!);
    if(!force&&previous&&(this.config.stableWindowMs??0)>frame.timestamp-since)return {selected:false,reason:'unstable'};
    this.selected=this.selected.filter(t=>t>frame.timestamp-60000);
    if(!force&&this.selected.length>=this.config.maxKeyframesPerMinute)return {selected:false,reason:'rate_limit'};
    const result=this.filter.select({...frame,pixels},options.roi ?? this.config.roi,force);
    if(this.config.adaptive&&this.config.sampleFps)sample.interval=result.selected?1000/this.config.sampleFps:Math.min(10000,Math.max(interval,1000/this.config.sampleFps)*1.5);
    if(!result.selected)return result;
    this.selected.push(frame.timestamp);
    let evidenceRef='ime:keyframe:'+randomUUID();
    if(this.config.storeFrames) {
      mkdirSync(this.dir,{recursive:true,mode:0o700});
      const name=randomUUID()+'.pgm';writeFileSync(join(this.dir,name),Buffer.concat([Buffer.from(`P5\n${frame.width} ${frame.height}\n255\n`),pixels]),{mode:0o600});evidenceRef=name;
    }
    const summary:KeyframeSummary={app:frame.app,timestamp:frame.timestamp,sequence:++this.sequence,
      reason:transition?'transition':options.reason ?? 'change',change:result.change,evidenceRef,...options.actionId?{actionId:options.actionId}:{},...state?{state}:{}};
    this.history.push(summary);
    this.latest.delete(frame.app);this.latest.set(frame.app,{pixels,width:frame.width,height:frame.height,timestamp:frame.timestamp,evidenceRef});
    while(this.latest.size>4)this.latest.delete(this.latest.keys().next().value!);
    this.history=this.history.filter(item=>item.timestamp>=frame.timestamp-this.config.retentionMs).slice(-100);
    return {...result,evidenceRef,sequence:summary.sequence,reason:summary.reason};
  }
  image(app:string,now=Date.now()) {
    const frame=this.latest.get(app);if(!frame||frame.timestamp+this.config.retentionMs<now)throw Error('NO_RETAINED_FRAMES');
    const roi=this.config.roi??{x:0,y:0,width:frame.width,height:frame.height},pixels=new Uint8Array(roi.width*roi.height);
    for(let y=0;y<roi.height;y++)pixels.set(frame.pixels.subarray((roi.y+y)*frame.width+roi.x,(roi.y+y)*frame.width+roi.x+roi.width),y*roi.width);
    return {evidenceRef:frame.evidenceRef,data:grayscalePng(roi.width,roi.height,pixels),mediaType:'image/png' as const};
  }
  private sampleHash(pixels:Uint8Array) {
    // A bounded spatial signature ignores isolated cursor-level pixel noise.
    const bins=Array<number>(64).fill(0),counts=Array<number>(64).fill(0);
    for(let i=0;i<pixels.length;i++){const bin=Math.min(63,Math.floor(i*64/pixels.length));bins[bin]!+=pixels[i]!;counts[bin]!++;}
    return bins.map((sum,index)=>Math.round(sum/Math.max(1,counts[index]!)/16)).join(',');
  }
  private recognize(pixels:Uint8Array,width:number,height:number):string|undefined {
    for(const state of this.config.states??[]) {
      const matched=state.regions.every(({roi,mean,tolerance})=>{
        if(![roi.x,roi.y,roi.width,roi.height].every(Number.isSafeInteger)||roi.x<0||roi.y<0||roi.width<1||roi.height<1||roi.x+roi.width>width||roi.y+roi.height>height)return false;
        let sum=0;for(let y=roi.y;y<roi.y+roi.height;y++)for(let x=roi.x;x<roi.x+roi.width;x++)sum+=pixels[y*width+x]!;
        return Math.abs(sum/(roi.width*roi.height)-mean)<=tolerance;
      });if(matched)return state.name;
    }
    return undefined;
  }
  contactSheet(app:string,limit=6) {
    if(!this.config.storeFrames)throw Error('FRAME_STORAGE_DISABLED');
    const frames=this.summarize(app,Math.min(limit,12)).filter(frame=>/^[a-f0-9-]+\.pgm$/.test(frame.evidenceRef));
    if(!frames.length)throw Error('NO_RETAINED_FRAMES');
    const width=240,height=180,labelHeight=14,columns=Math.min(3,frames.length),rows=Math.ceil(frames.length/columns);
    const canvas=new Uint8Array(width*columns*(height+labelHeight)*rows).fill(32),canvasWidth=width*columns;
    const digits=['111101101101111','010110010010111','111001111100111','111001111001111','101101111001001','111100111001111','111100111101111','111001001001001','111101111101111','111101111001111'];
    frames.forEach((frame,index)=>{
      const file=readFileSync(join(this.dir,frame.evidenceRef)),header=file.toString('ascii',0,64).match(/^P5\n(\d+) (\d+)\n255\n/);
      if(!header)throw Error('INVALID_RETAINED_FRAME');const sourceWidth=Number(header[1]),sourceHeight=Number(header[2]),offset=header[0].length;
      const x0=(index%columns)*width,y0=Math.floor(index/columns)*(height+labelHeight);
      if(file.length-offset!==sourceWidth*sourceHeight)throw Error('INVALID_RETAINED_FRAME');
      for(let y=0;y<height;y++)for(let x=0;x<width;x++)canvas[(y0+labelHeight+y)*canvasWidth+x0+x]=file[offset+Math.floor(y*sourceHeight/height)*sourceWidth+Math.floor(x*sourceWidth/width)]!;
      const label=String(frame.sequence)+' '+String(Math.floor(frame.timestamp));
      [...label].forEach((digit,position)=>{const pattern=digits[Number(digit)];if(digit===' '||!pattern)return;for(let y=0;y<5;y++)for(let x=0;x<3;x++)if(pattern[y*3+x]==='1')canvas[(y0+y*2)*canvasWidth+x0+position*8+x*2]=255;});
    });
    const evidenceRef='collage-'+randomUUID()+'.pgm';writeFileSync(join(this.dir,evidenceRef),Buffer.concat([Buffer.from(`P5\n${canvasWidth} ${rows*(height+labelHeight)}\n255\n`),canvas]),{mode:0o600});
    return {evidenceRef,width:canvasWidth,height:rows*(height+labelHeight),frames};
  }
  /** Ordered evidence references only; no raw frame bytes enter model context. */
  summarize(app:string,limit=12) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('INVALID_LIMIT');
    return this.history.filter(item=>item.app===app).slice(-limit).map(item=>({...item}));
  }
  cleanup(now=Date.now()) {
    for(const [app,frame] of this.latest)if(frame.timestamp+this.config.retentionMs<=now)this.latest.delete(app);
    this.history=this.history.filter(item=>item.timestamp+this.config.retentionMs>now);
    mkdirSync(this.dir,{recursive:true,mode:0o700});let deleted=0;
    for(const entry of readdirSync(this.dir,{withFileTypes:true})) {
      if(entry.isFile()&&entry.name.endsWith('.pgm')&&now-statSync(join(this.dir,entry.name)).mtimeMs>=this.config.retentionMs){unlinkSync(join(this.dir,entry.name));deleted++;}
    }return deleted;
  }
  close(){this.latest.clear();this.samples.clear();this.history=[];this.filter.clear();}
}
