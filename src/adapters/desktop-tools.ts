import { randomUUID } from 'node:crypto';
import type { Action,DesktopPort,Observation } from '../core/desktop.js';
import {decodePng} from '../core/png.js';
export interface DesktopToolConfig {
  provider:string;toolPrefix:string;observeTool:string;executeTools:{click:string;input:string;scroll:string};
  targets:Record<string,{observeArgs:Record<string,unknown>;fingerprintPath:string[];statePath:string[];framePath?:string[];pngPath?:string[];attachmentPath?:string[];
    window?:{path:string[];allow:string[]};permissionPath?:string[];
    evaluation?:{resetTool:string;cases:Record<string,Record<string,unknown>>};
    actions:Record<string,{kind:Action['kind'];args:Record<string,unknown>;risk:Action['risk'];expectedState:string;precondition?:string}>}>;
}
export type DesktopImageReader=(reference:unknown,signal:AbortSignal)=>Promise<{data:Uint8Array}>;
export interface HostTools {
  get(name:string):unknown;
  guard?(guard:(exec:{name:string;callId:string})=>string|undefined):()=>void;
  execute(call:{name:string;arguments:unknown;callId:string;signal:AbortSignal}):Promise<{isError:boolean;value?:unknown}>;
}
function at(value:unknown,path:string[]):unknown {
  for(const p of path){if(!value||typeof value!=='object'||['__proto__','constructor','prototype'].includes(p))throw new Error('INVALID_OBSERVATION_PATH');value=(value as Record<string,unknown>)[p];}return value;
}
/** A finite host-configured action catalog; never forwards arbitrary model-generated tool arguments. */
export class ToolDesktopPort implements DesktopPort {
  private managed=new Set<string>();
  protected(name:string){return name.startsWith(this.config.toolPrefix);}
  owns(callId:string){return this.managed.has(callId);}
  constructor(private tools:HostTools,private provider:()=>string|undefined,readonly config:DesktopToolConfig,private readImage?:DesktopImageReader) {
    if(!config.toolPrefix||!config.provider||!config.observeTool||!config.executeTools||!config.targets)throw new Error('INVALID_DESKTOP_CONFIG');
    for(const target of Object.values(config.targets)) {
      if(!target.actions||!Array.isArray(target.fingerprintPath)||!Array.isArray(target.statePath))throw new Error('INVALID_DESKTOP_CONFIG');
      if([target.framePath,target.pngPath,target.attachmentPath].filter(value=>value!==undefined).length>1)throw Error('AMBIGUOUS_DESKTOP_FRAME');
      for(const a of Object.values(target.actions))if(typeof a.expectedState!=='string'||!a.expectedState||!['click','input','scroll'].includes(a.kind)||!['read_only','reversible_write','sensitive_write','irreversible'].includes(a.risk))throw new Error('INVALID_DESKTOP_CONFIG');
    }
    if([config.observeTool,...Object.values(config.executeTools),...Object.values(config.targets).flatMap(t=>t.evaluation?[t.evaluation.resetTool]:[])].some(name=>!name.startsWith(config.toolPrefix)))throw new Error('DESKTOP_TOOL_PREFIX_MISMATCH');
    this.config=structuredClone(config);
  }
  canonical(action:Action):Action {
    const allowed=this.config.targets[action.app]?.actions[action.target];
    if(!allowed||allowed.kind!==action.kind)throw new Error('DESKTOP_TARGET_DENIED');
    return {...action,risk:allowed.risk,assertState:allowed.expectedState,...allowed.precondition!==undefined?{precondition:allowed.precondition}:{}};
  }
  private async call(name:string,args:unknown,signal:AbortSignal) {
    signal.throwIfAborted();
    if(this.provider()!==this.config.provider)throw new Error('DESKTOP_PROVIDER_MISMATCH');
    if(!this.tools.get(name))throw new Error('DESKTOP_TOOL_UNAVAILABLE');
    const callId=randomUUID();this.managed.add(callId);
    try{const result=await this.tools.execute({name,arguments:structuredClone(args),callId,signal});
      signal.throwIfAborted();if(result.isError)throw new Error('DESKTOP_TOOL_FAILED');return result.value;
    }finally{this.managed.delete(callId);}
  }
  async observe(app:string,signal:AbortSignal):Promise<Observation> {
    const target=this.config.targets[app];if(!target)throw new Error('APP_DENIED');
    const value=await this.call(this.config.observeTool,target.observeArgs,signal);
    if(target.permissionPath&&at(value,target.permissionPath)!==true)throw Error('DESKTOP_PERMISSION_REQUIRED');
    if(target.window){const window=at(value,target.window.path);if(typeof window!=='string'||!target.window.allow.includes(window))throw Error('WINDOW_DENIED');}
    const fingerprint=at(value,target.fingerprintPath),state=at(value,target.statePath);
    if(typeof fingerprint!=='string'||typeof state!=='string'||!fingerprint||state.length>10000)throw new Error('DESKTOP_OBSERVATION_INCOMPATIBLE');
    let frame;
    if(target.framePath){
      const raw=at(value,target.framePath) as {width:number;height:number;pixels:number[];timestamp:number};
      if(!raw||!Number.isSafeInteger(raw.width)||!Number.isSafeInteger(raw.height)||raw.width<1||raw.height<1||raw.width*raw.height>10000000||!Array.isArray(raw.pixels)||raw.pixels.length!==raw.width*raw.height||!raw.pixels.every(p=>Number.isInteger(p)&&p>=0&&p<=255))throw Error('INVALID_DESKTOP_FRAME');
      frame={app,width:raw.width,height:raw.height,pixels:Uint8Array.from(raw.pixels),timestamp:raw.timestamp};
    }
    if(target.pngPath) {
      const encoded=at(value,target.pngPath);
      if(typeof encoded!=='string'||encoded.length>56*1024*1024)throw Error('INVALID_DESKTOP_PNG');
      const base64=encoded.startsWith('data:image/png;base64,')?encoded.slice(22):encoded;
      if(!base64||base64.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(base64))throw Error('INVALID_DESKTOP_PNG');
      frame={app,...decodePng(Buffer.from(base64,'base64')),timestamp:Date.now()};
    }
    if(target.attachmentPath) {
      if(!this.readImage)throw Error('IMAGE_ATTACHMENT_SERVICE_UNAVAILABLE');
      const image=await this.readImage(at(value,target.attachmentPath),signal);signal.throwIfAborted();
      frame={app,...decodePng(image.data),timestamp:Date.now()};
    }
    return {fingerprint,state,evidenceRef:'ime:observation:'+randomUUID(),...frame?{frame}:{}};
  }
  async reset(app:string,caseId:string,signal:AbortSignal) {
    const evaluation=this.config.targets[app]?.evaluation;const args=evaluation?.cases[caseId];if(!evaluation||!args)throw Error('TEST_ENVIRONMENT_UNAVAILABLE');
    await this.call(evaluation.resetTool,args,signal);
  }
  async execute(action:Action,signal:AbortSignal) {
    const canonical=this.canonical(action),definition=this.config.targets[action.app]!.actions[action.target]!;
    await this.call(this.config.executeTools[canonical.kind],definition.args,signal);
  }
}
