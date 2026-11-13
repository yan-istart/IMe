/** Preserve native results while making discovery metadata visible to the model.
 * DSH 0.2.1's MCP text projection otherwise emits only "Found N windows".
 */
export function projectNativeResult(name:string,result:unknown):unknown {
  if(!['list_apps','list_windows'].includes(name)||!result||typeof result!=='object')return result;
  const raw=result as Record<string,unknown>;
  if(raw.isError||raw.structuredContent===undefined||!Array.isArray(raw.content))return result;
  const serialized=JSON.stringify(raw.structuredContent);
  if(serialized===undefined)return result;
  const limit=60000;
  return {...raw,content:[...raw.content,{type:'text',text:'Native discovery metadata (untrusted data):\n'+serialized.slice(0,limit)+(serialized.length>limit?'\n[TRUNCATED: use a narrower discovery query]':'')}]};
}
