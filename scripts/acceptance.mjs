import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

// Operates on the running plugin through its authenticated local console;
// never opens a second runtime or prints the console access token.
const [operation,...args]=process.argv.slice(2);
const options={};
try {
  for(let i=0;i<args.length;i++) {
    const key=args[i];if(!key?.startsWith('--'))throw Error('INVALID_ARGUMENT');
    if(key==='--wait'){options.wait=true;continue;}
    if(!['--data-dir','--task','--minutes','--interval','--id','--baseline','--candidate','--statement'].includes(key)||!args[i+1]||args[i+1].startsWith('--'))throw Error('INVALID_ARGUMENT');
    options[key.slice(2)]=args[++i];
  }
  if(!['status','observe','stop','report','compare','reconcile'].includes(operation))throw Error('ACCEPTANCE_USAGE');
  const input=options['data-dir']??join(homedir(),'.dsh','ime-v1'),directory=resolve(input.startsWith('~/')?join(homedir(),input.slice(2)):input);
  const url=new URL(readFileSync(join(directory,'dashboard.url'),'utf8').trim()),token=new URLSearchParams(url.hash.slice(1)).get('token');
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!token||!/^[a-f0-9]{64}$/.test(token))throw Error('INVALID_LOCAL_DASHBOARD');
  url.hash='';
  const api=async(path,body)=>{
    const response=await fetch(new URL('api/'+path,url),{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...body?{'Content-Type':'application/json'}:{}},
      ...body?{body:JSON.stringify(body)}:{},signal:AbortSignal.timeout(10000),redirect:'error'});
    const result=await response.json();if(!response.ok)throw Error(typeof result.error==='string'?result.error:'ACCEPTANCE_REQUEST_FAILED');return result;
  };
  const required=key=>{if(typeof options[key]!=='string'||!options[key].trim())throw Error('MISSING_'+key.toUpperCase().replaceAll('-','_'));return options[key];};
  let result;
  if(operation==='status')result=await api('acceptance');
  if(operation==='observe') {
    const minutes=Number(options.minutes??60),interval=Number(options.interval??1000);
    result=await api('command',{operation:'acceptance_start',taskId:required('task'),durationMs:minutes*60000,intervalMs:interval});
    if(options.wait) {
      const id=result.id;
      for(;;){const report=await api('acceptance?id='+encodeURIComponent(id));if(report.status!=='running'){result=report;break;}await delay(1000);}
    }
  }
  if(operation==='stop')result=await api('command',{operation:'acceptance_stop',id:required('id')});
  if(operation==='report')result=await api('acceptance?id='+encodeURIComponent(required('id')));
  if(operation==='compare')result=await api('command',{operation:'acceptance_compare',baselineTaskIds:required('baseline').split(',').map(id=>id.trim()),candidateTaskIds:required('candidate').split(',').map(id=>id.trim())});
  if(operation==='reconcile')result=await api('command',{operation:'statement_reconcile',lines:JSON.parse(readFileSync(required('statement'),'utf8'))});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
} catch(error) {
  // File and network error objects can include a URL or headers; print stable codes only.
  const message=error instanceof Error?error.message:'';
  process.stderr.write(message==='ACCEPTANCE_USAGE'?'Usage: npm run acceptance -- status|observe|stop|report|compare|reconcile [--data-dir DIR]\n':/^[A-Z0-9_: .,|?\[\]<>-]+$/.test(message)?message+'\n':'ACCEPTANCE_COMMAND_FAILED\n');process.exitCode=1;
}
