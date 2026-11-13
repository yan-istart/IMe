import { ToolDesktopPort,type DesktopToolConfig,type HostTools,type DesktopImageReader } from './desktop-tools.js';
import type { Action,DesktopPort } from '../core/desktop.js';

/** Different installed drivers, with exactly one active host provider at a time. */
export class DesktopProviderPool implements DesktopPort {
  private ports:Map<string,ToolDesktopPort>;
  private selected=new WeakMap<Action,string>();
  constructor(tools:HostTools,private provider:()=>string|undefined,configs:DesktopToolConfig[],readImage?:DesktopImageReader) {
    if(!Array.isArray(configs)||!configs.length||configs.length>10||new Set(configs.map(config=>config.provider)).size!==configs.length)throw Error('INVALID_DESKTOP_ADAPTERS');
    this.ports=new Map(configs.map(config=>[config.provider,new ToolDesktopPort(tools,provider,config,readImage)]));
  }
  protected(name:string){return [...this.ports.values()].some(port=>port.protected(name));}
  owns(callId:string){return [...this.ports.values()].some(port=>port.owns(callId));}
  private current(){const port=this.ports.get(this.provider()??'');if(!port)throw Error('DESKTOP_PROVIDER_MISMATCH');return port;}
  canonical(action:Action){const port=this.current(),canonical=port.canonical(action);this.selected.set(canonical,port.config.provider);return canonical;}
  observe(app:string,signal:AbortSignal){return this.current().observe(app,signal);}
  execute(action:Action,signal:AbortSignal){const port=this.current();if(this.selected.get(action)!==port.config.provider)throw Error('DESKTOP_PROVIDER_CHANGED');return port.execute(action,signal);}
  reset(app:string,caseId:string,signal:AbortSignal){return this.current().reset(app,caseId,signal);}
}
