import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const desktopCLI='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const binary=process.env.DSH_BIN ?? (existsSync(desktopCLI)?desktopCLI:'dsh');
const version=execFileSync(binary,['--version'],{encoding:'utf8'}).trim();
const dir=mkdtempSync(join(tmpdir(),'ime-host-smoke-'));
const environment={...process.env,DSH_HOME:join(dir,'dsh-home')};
try{execFileSync(binary,['plugin','--profile','ime-smoke','add',root],{stdio:'inherit',env:environment});}catch(error){rmSync(dir,{recursive:true,force:true});throw error;}
const patch=join(dir,'smoke.patch.yml');
const report=join(root,'docs','host-smoke-report.json');
// JSON is valid YAML; JSON serialization avoids path quoting and shell interpolation problems.
writeFileSync(patch,JSON.stringify([
  {id:'ime-core',config:{recovery:{minIntervalMs:0,maxConsecutive:2},dataDir:join(dir,'data'),allowApps:['smoke-app'],desktopLeasePath:join(dir,'desktop.lock'),desktopAdapter:{provider:'ime-smoke-desktop',toolPrefix:'ime_fixture_',observeTool:'ime_fixture_observe',executeTools:{click:'ime_fixture_click',input:'ime_fixture_input',scroll:'ime_fixture_scroll'},targets:{'smoke-app':{observeArgs:{},fingerprintPath:['fingerprint'],statePath:['state'],actions:{'open-panel':{kind:'click',args:{target:'panel'},risk:'reversible_write',expectedState:'task-panel',precondition:'home'}}}}}}},
  {insert:[{id:'ime-host-smoke',name:join(root,'scripts','dsh-smoke.mjs'),config:{hostVersion:version,reportPath:report}}]},
],null,2));
const child=spawn(binary,['--profile','ime-smoke','--patch',patch],{cwd:root,env:environment,stdio:['ignore','pipe','pipe']});
const redact=text=>String(text).replace(/([?&]token=)[^\s]+/g,'$1[redacted]');
child.stdout.on('data',chunk=>process.stdout.write(redact(chunk)));
child.stderr.on('data',chunk=>process.stderr.write(redact(chunk)));
const timer=setTimeout(()=>{console.error('DSH integration timed out');child.kill('SIGTERM');},30_000);
child.on('error',error=>{clearTimeout(timer);console.error(error.message);rmSync(dir,{recursive:true,force:true});process.exitCode=1;});
child.on('exit',(code)=>{clearTimeout(timer);rmSync(dir,{recursive:true,force:true});process.exitCode=code ?? 1;});
