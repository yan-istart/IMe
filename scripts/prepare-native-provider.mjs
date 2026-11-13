// DSH desktop bundles scope identities inside app.asar. External peer copies
// must not replace those singletons. Reuse the host's exact runtime modules.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const profile=process.argv[2]??join(homedir(),'.dsh/profiles/desktop');
const app=process.argv[3]??'/Applications/DeepSeek Harness.app';
const host=join(app,'Contents/Resources/app.asar/dsh/node_modules');
const modules=join(profile,'node_modules');
const version='0.2.1-rc.5';
const pkg='@deepseek-ai/dsh-experimental-computer-use-cua-driver-native';
if(JSON.parse(readFileSync(join(modules,pkg,'package.json'),'utf8')).version!==version)throw Error('UNVERIFIED_PROVIDER_VERSION');
const output=join(profile,'ime-provider-bridge');mkdirSync(output,{recursive:true,mode:0o700});
const projection=pathToFileURL(fileURLToPath(new URL('../dist/adapters/native-result.js',import.meta.url))).href;
const records=[];
function rewire(packageName,filename,mappings,target){
 const original=readFileSync(join(modules,packageName,filename),'utf8');let code=original;
 for(const [specifier,path] of mappings){const key=JSON.stringify(specifier);if(!code.includes(key))throw Error('UPSTREAM_IMPORT_CHANGED:'+specifier);code=code.replaceAll(key,JSON.stringify(pathToFileURL(path).href));}
 if(packageName===pkg){
   const originalReturn='return JSON.parse(result.rawJson);';
   if(!code.includes(originalReturn))throw Error('UPSTREAM_RESULT_ADAPTER_CHANGED');
   code='import {projectNativeResult} from '+JSON.stringify(projection)+';\n'+code.replace(originalReturn,'return projectNativeResult(tool.name, JSON.parse(result.rawJson));');
 }
 writeFileSync(join(output,target),'// Generated from official '+packageName+'@'+version+'; host imports and discovery text projection adapted.\n'+code,{mode:0o600});
 records.push({package:packageName,version,sourceHash:createHash('sha256').update(original).digest('hex'),target,mappings});
}
rewire('@deepseek-ai/dsh-computer-use','lib/index.js',[
 ['@deepseek-ai/cordis',join(host,'@deepseek-ai/cordis/lib/index.js')],
],'registry.mjs');
rewire(pkg,'lib/index.js',[
 ['@deepseek-ai/schemastery',join(host,'@deepseek-ai/schemastery/lib/index.mjs')],
 ['@deepseek-ai/dsh-mcp-client',join(host,'@deepseek-ai/dsh-mcp-client/lib/index.js')],
 ['@deepseek-ai/dsh-computer-use/brand',join(modules,'@deepseek-ai/dsh-computer-use/lib/types/brand.js')],
 ['@trycua/cua-driver',join(modules,'@trycua/cua-driver/dist/index.js')],
],'provider-host-projected.mjs');
writeFileSync(join(output,'manifest.json'),JSON.stringify({generatedAt:new Date().toISOString(),hostApp:app,records},null,2)+'\n',{mode:0o600});
console.log('Prepared host-sharing Provider modules:',output);
