import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
const file=process.argv[2] ?? join(homedir(),'.dsh','ime-v1','dashboard.url');
const url=new URL(readFileSync(file,'utf8').trim());
if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw Error('INVALID_LOCAL_DASHBOARD');
const command=process.platform==='darwin'?'open':process.platform==='win32'?'explorer':'xdg-open';
const child=spawn(command,[url.href],{stdio:'ignore'});child.on('error',error=>{console.error(error.message);process.exitCode=1;});
