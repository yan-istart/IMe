import { openSync,closeSync,unlinkSync,mkdirSync,writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
/** Cross-process lock has no automatic expiry: a long action must never outlive its lease. */
export class DesktopLease {
  private held=false;
  constructor(readonly path:string){}
  acquire() {
    mkdirSync(dirname(this.path),{recursive:true,mode:0o700});
    let fd:number;
    try{fd=openSync(this.path,'wx',0o600);}catch(error){
      // Only an existing lock means another owner. Permission errors must not be
      // hidden as DESKTOP_BUSY, because that turns a misconfigured path into a
      // misleading concurrency message.
      if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('DESKTOP_BUSY');
      throw error;
    }
    try{writeFileSync(fd,JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));this.held=true;}finally{closeSync(fd);}
  }
  release(){if(this.held){this.held=false;unlinkSync(this.path);}}
}
