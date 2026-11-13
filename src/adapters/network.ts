/** Network destinations are host configuration, never supplied by model tools. */
export function endpoint(value:string):URL {
  let url:URL;try{url=new URL(value);}catch{throw Error('INVALID_ENDPOINT');}
  if(url.username||url.password||url.hash||!['https:','http:'].includes(url.protocol)
    ||(url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw Error('INSECURE_ENDPOINT');
  return url;
}
export function credential(name:string|undefined):string|undefined {
  if(name===undefined)return undefined;
  if(!/^[A-Z][A-Z0-9_]{0,127}$/.test(name))throw Error('INVALID_CREDENTIAL_REFERENCE');
  const value=process.env[name]?.trim();if(!value)throw Error('CREDENTIAL_UNAVAILABLE');
  if(/[^\x20-\x7e]/.test(value))throw Error('INVALID_CREDENTIAL_VALUE');return value;
}
export async function readJson(response:Response,maxBytes=4*1024*1024):Promise<unknown> {
  if(Number(response.headers.get('content-length') ?? 0)>maxBytes)throw Error('RESPONSE_TOO_LARGE');
  const reader=response.body?.getReader();if(!reader)throw Error('EMPTY_RESPONSE');
  const buffers:Uint8Array[]=[];let size=0;
  try {
    for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes)throw Error('RESPONSE_TOO_LARGE');buffers.push(value);}
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(buffers).toString('utf8')) as unknown;}catch{throw Error('INVALID_JSON_RESPONSE');}
}
