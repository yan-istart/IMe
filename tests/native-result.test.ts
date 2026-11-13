import{test}from'node:test';
import assert from'node:assert/strict';
import{projectNativeResult}from'../src/adapters/native-result.js';
test('native discovery exposes canonical window identities without changing image projection or action results',()=>{
 const image={type:'image',mimeType:'image/png',data:'unchanged'};
 const raw={content:[{type:'text',text:'Found 1 window(s)'},image],structuredContent:{windows:[{pid:123,window_id:'456',app:'WeChat'}]}};
 const projected=projectNativeResult('list_windows',raw) as typeof raw;
 assert.deepEqual(projected.structuredContent,raw.structuredContent);
 assert.equal(projected.content[1],image);
 assert.match(JSON.stringify(projected.content.at(-1)),/window_id/);
 assert.equal(raw.content.length,2);
 assert.equal(projectNativeResult('get_window_state',raw),raw);
 assert.equal(projectNativeResult('click',raw),raw);
 const large=projectNativeResult('list_apps',{content:[],structuredContent:{items:'x'.repeat(61000)}}) as {content:{text:string}[]};
 assert.match(large.content[0]!.text,/TRUNCATED/);assert.ok(large.content[0]!.text.length<60200);
});
