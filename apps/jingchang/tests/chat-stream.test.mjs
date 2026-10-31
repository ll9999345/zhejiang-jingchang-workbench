import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {consumeChatStream,redactChatText} from '../lib/chat-stream.mjs';
import {conversationService} from '../lib/conversations.mjs';
import {platformService} from '../lib/api-platforms.mjs';
import {atomicJson,readJson} from '../lib/workspace.mjs';
const key='synthetic-stream-secret',event=(text,reason=null)=>'data: '+JSON.stringify({choices:[{index:0,delta:{content:text},finish_reason:reason}]})+'\r\n\r\n';
const wire=text=>({body:Readable.from(Array.from(Buffer.from(text),x=>Buffer.from([x])))});
test('流式解析跨UTF8字节与CRLF分块、注释/usage、结束原因和密钥片段',async()=>{
 const updates=[];const result=await consumeChatStream(wire(': ping\r\n\r\n'+event('你好')+event('世界','stop')+'data: {"choices":[],"usage":{"total_tokens":12}}\n\ndata: [DONE]\n\n'),{onDelta:async x=>updates.push(x)});assert.deepEqual(updates,['你好','你好世界']);assert.equal(result.complete,true);assert.equal(result.text,'你好世界');
 assert.equal((await consumeChatStream(wire(event('不足','length')+'data: [DONE]\n\n'))).complete,false);
 assert.equal(redactChatText('prefix '+key.slice(0,10),key),'prefix ');assert.equal(redactChatText('prefix '+key.slice(0,10),key,true),'prefix [已隐藏密钥片段]');assert.equal(redactChatText('prefix '+key+' end',key),'prefix [已隐藏密钥] end');
});
test('断流、畸形数据、工具调用和超限响应不能伪装为完整回答',async()=>{
 for(const text of [event('一半'),event('一半')+'data: not-json\n\n',event('一半')+'data: {"error":{"message":"secret"}}\n\n','data: {"choices":[{"index":0,"delta":{"tool_calls":[{}]}}]}\n\n'])await assert.rejects(consumeChatStream(wire(text)));
 await assert.rejects(consumeChatStream({body:Readable.from([Buffer.from(event('x'.repeat(200001),'stop'))])}),/20万字/);
 await assert.rejects(consumeChatStream({body:Readable.from([Buffer.alloc(4*1024*1024+1)])}),/4MB/);
});
async function fixture(t){const calls=[],state={mode:'normal',release:null},server=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));calls.push(body);if(['json','envelope','envelope-error','envelope-unknown'].includes(state.mode)){res.setHeader('content-type','application/json');const value={choices:[{message:{content:'JSON '+key},finish_reason:state.mode==='envelope-unknown'?'provider_interrupted':'stop'}]};return res.end(JSON.stringify(state.mode==='json'?value:{code:state.mode==='envelope-error'?403:200,data:value,message:key}));}res.setHeader('content-type','text/event-stream');res.flushHeaders();res.write(event('开场，'));if(state.mode==='pending'){state.release=()=>{if(!res.destroyed)res.end(event('结束','stop')+'data: [DONE]\n\n');};return;}
 res.write(event(key.slice(0,10)));await new Promise(r=>setTimeout(r,10));res.write(event(key.slice(10)));res.write(event('结尾'));if(state.mode==='broken')return res.end();res.end(event('',state.mode==='length'?'length':'stop')+'data: [DONE]\n\n');});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const base='http://127.0.0.1:'+server.address().port,data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-stream-')),activeJobs=new Map(),platforms=platformService(data),saved=await platforms.save({revision:0,platform:{name:'local stream',protocol:'openai-compatible',baseUrl:base+'/v1',models:[{id:'chat',category:'chat',referenceSupport:true}]}}),projects={load:async()=>({id:'project-1'}),apply:async(c,m)=>m};const service=conversationService({data,activeJobs,platforms,projects});const c=await service.create({projectId:'project-1'}),body={revision:0,requestId:'first-stream',text:'请回答',assetIds:[],platformId:saved.platforms[0].id,model:'chat',apiKey:key,stream:true,authorization:{origin:base,model:'chat',sendPrompt:true,sendReferences:true,requestLimit:1,budget:1,currency:'CNY'}};return{calls,state,data,activeJobs,platforms,projects,service,c,body};}
async function wait(f,id,predicate){for(let i=0;i<500;i++){const j=await readJson(path.join(f.data,'jobs',id+'.json'));if(predicate(j)&&!(['completed','failed','cancelled','incomplete'].includes(j.status)&&f.activeJobs.has(id)))return j;await new Promise(r=>setTimeout(r,10));}throw Error('wait timeout');}
async function scan(data){for(const e of await fs.readdir(data,{withFileTypes:true})){const f=path.join(data,e.name);if(e.isDirectory())await scan(f);else assert.equal((await fs.readFile(f)).includes(Buffer.from(key)),false,f);}}
test('流式单次提交、逐步保存、刷新可读、停止保留片段且不得自动重发',async t=>{
 const f=await fixture(t);f.state.mode='pending';const j=await f.service.send(f.c.id,structuredClone(f.body));await wait(f,j.id,j=>j.outputText==='开场，');assert.equal((await readJson(path.join(f.data,'jobs',j.id+'.json'))).status,'running');assert.equal(f.calls[0].stream,true);assert.equal(f.calls.length,1);f.activeJobs.get(j.id).controller.abort();const end=await wait(f,j.id,j=>j.status==='cancelled');assert.equal(end.outputText,'开场，');const c=await f.service.get(f.c.id),m=c.messages.at(-1);assert.equal(m.state,'incomplete');await assert.rejects(f.service.apply(c.id,{messageId:m.id}),/未完成片段/);assert.equal((await f.service.apply(c.id,{messageId:m.id,acceptIncomplete:true})).text,'开场，');assert.equal((await f.service.send(c.id,structuredClone(f.body))).id,j.id);assert.equal(f.calls.length,1);await scan(f.data);
});
test('跨分块密钥不落盘，完整回答进入历史；JSON兼容回退不产生第二次请求',async t=>{
 const f=await fixture(t);const j=await f.service.send(f.c.id,structuredClone(f.body));assert.equal((await wait(f,j.id,j=>j.status==='completed')).outputText,'开场，[已隐藏密钥]结尾');let c=await f.service.get(f.c.id);assert.equal(c.messages.at(-1).state,'complete');f.state.mode='json';const next=await f.service.send(c.id,{...f.body,revision:c.revision,requestId:'json-fallback'});assert.equal((await wait(f,next.id,j=>j.status==='completed')).outputText,'JSON [已隐藏密钥]');assert.equal(f.calls.length,2);assert.equal(f.calls[1].messages.length,3);await scan(f.data);
});
test('输出上限和断流保留但排除未完成上下文；原请求编号仍幂等',async t=>{
 const f=await fixture(t);f.state.mode='length';const first=await f.service.send(f.c.id,structuredClone(f.body));assert.equal((await wait(f,first.id,j=>j.status==='incomplete')).uncertain,false);let c=await f.service.get(f.c.id);assert.equal(c.messages.at(-1).state,'incomplete');f.state.mode='broken';const second=await f.service.send(c.id,{...f.body,revision:c.revision,requestId:'broken-stream'});const end=await wait(f,second.id,j=>j.status==='failed');assert.equal(end.uncertain,true);assert.equal(f.calls[1].messages.filter(m=>m.role==='assistant').length,0);assert.ok(end.outputText.includes('[已隐藏密钥]'));await scan(f.data);
});
test('重启协调将持久片段恢复到历史一次，不重新提交；原有完整回答不被降级',async t=>{
 const f=await fixture(t);const now=new Date().toISOString(),j={id:'interrupted-job',kind:'conversation',conversationId:f.c.id,projectId:'project-1',status:'interrupted',outputText:'重启前已收到',createdAt:now};await atomicJson(path.join(f.data,'jobs',j.id+'.json'),j);const restored=conversationService(f);await restored.recover();await restored.recover();const c=await restored.get(f.c.id);assert.equal(c.messages.length,1);assert.equal(c.messages[0].state,'incomplete');assert.equal(f.calls.length,0);const complete={...j,id:'complete-job',status:'completed',outputText:'完整回答'};await atomicJson(path.join(f.data,'jobs',complete.id+'.json'),complete);await restored.recover();await atomicJson(path.join(f.data,'jobs',complete.id+'.json'),{...complete,status:'interrupted'});await restored.recover();assert.equal((await restored.get(f.c.id)).messages.find(m=>m.jobId===complete.id).state,'complete');const orphan={...j,id:'orphan',conversationId:'missing'};await atomicJson(path.join(f.data,'jobs','orphan.json'),orphan);await restored.recover();assert.equal((await readJson(path.join(f.data,'jobs','orphan.json'))).outputText,orphan.outputText);
});

test('APIMart 普通对话与流式请求收到完整JSON时均只提交一次，历史和重启可继续',async t=>{
 for(const stream of [false,true]){
  const f=await fixture(t);f.state.mode='envelope';const b={...f.body,stream},j=await f.service.send(f.c.id,structuredClone(b));
  const result=await wait(f,j.id,j=>j.status==='completed');assert.equal(result.outputText,'JSON [已隐藏密钥]');assert.equal(f.calls.length,1);assert.equal(f.calls[0].stream,stream);
  let c=await f.service.get(f.c.id);assert.equal(c.messages.at(-1).state,'complete');assert.equal((await f.service.apply(c.id,{messageId:c.messages.at(-1).id})).text,result.outputText);
  const restored=conversationService(f);await restored.recover();assert.equal((await restored.send(c.id,structuredClone(b))).id,j.id);assert.equal(f.calls.length,1);
  f.state.mode='json';const next=await restored.send(c.id,{...b,revision:c.revision,requestId:'after-envelope',text:'接着刚才的回答'});await wait(f,next.id,j=>j.status==='completed');assert.equal(f.calls.length,2);assert.equal(f.calls[1].messages[1].content,result.outputText);await scan(f.data);
 }
});
test('APIMart HTTP成功中的错误不保存伪回答，未知结束状态保留片段且不自动重发',async t=>{
 const f=await fixture(t);f.state.mode='envelope-error';const body=structuredClone(f.body),j=await f.service.send(f.c.id,structuredClone(body));const result=await wait(f,j.id,j=>j.status==='failed');assert.equal(result.outputText,'');assert.equal((await f.service.get(f.c.id)).messages.filter(m=>m.role==='assistant').length,0);assert.equal((await f.service.send(f.c.id,body)).id,j.id);assert.equal(f.calls.length,1);
 f.state.mode='envelope-unknown';const c=await f.service.get(f.c.id),next=await f.service.send(c.id,{...f.body,revision:c.revision,requestId:'unknown-envelope',stream:false});const incomplete=await wait(f,next.id,j=>j.status==='incomplete');assert.equal(incomplete.finishReason,'unknown');assert.equal(incomplete.outputText,'JSON [已隐藏密钥]');const saved=await f.service.get(c.id);await assert.rejects(f.service.apply(c.id,{messageId:saved.messages.at(-1).id}),/未完成/);assert.equal(f.calls.length,2);await scan(f.data);
});
