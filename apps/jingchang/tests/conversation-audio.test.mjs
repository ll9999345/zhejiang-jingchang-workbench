import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {conversationService} from '../lib/conversations.mjs';
import {platformService} from '../lib/api-platforms.mjs';
import {makeProject} from '../lib/model.mjs';
import {readJson,storeAsset} from '../lib/workspace.mjs';
import {prepareChatMedia} from '../lib/chat-media.mjs';

const key='synthetic-gemini-audio-key';
function wav(){const b=Buffer.alloc(46);b.write('RIFF',0);b.writeUInt32LE(38,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(2,40);return b;}
async function fixture(t){
 const calls=[],state={finish:'STOP'},mock=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks).toString();calls.push({url:req.url,raw,headers:req.headers});res.setHeader('content-type','application/json');res.end(JSON.stringify({candidates:[{...(state.finish!==undefined?{finishReason:state.finish}:{}),content:{parts:[{text:'音频里有人说：欢迎来到嘉兴。'}]}}]}));});
 mock.listen(0,'127.0.0.1');await once(mock,'listening');t.after(()=>{mock.closeAllConnections();return new Promise(resolve=>mock.close(resolve));});
 const base='http://127.0.0.1:'+mock.address().port,data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-conversation-audio-')),activeJobs=new Map(),platforms=platformService(data),project=makeProject('音频对话测试');
 const configured=await platforms.save({revision:0,platform:{name:'本机 Gemini 测试',protocol:'gemini',baseUrl:base+'/v1beta',models:[{id:'gemini-3-flash',category:'chat',audioSupport:true}]}});
 const projects={load:async()=>project,save:async p=>p,apply:async(_c,m)=>m},service=conversationService({data,platforms,activeJobs,projects}),conversation=await service.create({projectId:project.id}),asset=await storeAsset(data,wav(),{name:'对白.wav',type:'audio/wav'});
 return{data,base,calls,state,activeJobs,platforms,projects,project,service,conversation,platform:configured.platforms[0],asset};
}
async function waitJob(f,id){for(let i=0;i<300;i++){const job=await readJson(path.join(f.data,'jobs',id+'.json'));if(['completed','incomplete','failed','cancelled'].includes(job.status)&&!f.activeJobs.has(id))return job;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('task timeout');}

test('Gemini 原生文字对话能在明确启用后理解本地音频，且密钥不落盘',async t=>{
 const f=await fixture(t),prepared=await prepareChatMedia({data:f.data,assetIds:[f.asset.id]});assert.equal(prepared.assets[0].id,f.asset.id);assert.equal(prepared.assets[0].type,'audio/wav');assert.equal(f.calls.length,0);
 const auth={origin:f.base,model:'gemini-3-flash',sendPrompt:true,sendReferences:true,requestLimit:1,budget:1,currency:'CNY'};
 const job=await f.service.send(f.conversation.id,{revision:0,requestId:'audio-one',platformId:f.platform.id,model:'gemini-3-flash',mode:'chat',text:'请听写并总结这段音频。',assetIds:[f.asset.id],apiKey:key,stream:true,systemPrompt:'用简体中文回答。',authorization:auth});
 const finished=await waitJob(f,job.id);assert.equal(finished.status,'completed');assert.equal(finished.stream,false);assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'/v1beta/models/gemini-3-flash:generateContent');assert.equal(f.calls[0].headers['x-goog-api-key'],key);assert.equal(f.calls[0].headers.authorization,undefined);
 const request=JSON.parse(f.calls[0].raw);assert.equal(request.systemInstruction.parts[0].text,'用简体中文回答。');assert.equal(request.contents.at(-1).role,'user');assert.equal(request.contents.at(-1).parts[0].text,'请听写并总结这段音频。');assert.deepEqual(request.contents.at(-1).parts[1].inlineData,{mimeType:'audio/wav',data:wav().toString('base64')});assert.equal(request.generationConfig.maxOutputTokens,4096);
 const restored=await f.service.get(f.conversation.id);assert.equal(restored.messages.at(-1).text,'音频里有人说：欢迎来到嘉兴。');assert.deepEqual(restored.messages[0].assetIds,[f.asset.id]);
 async function noSecret(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())await noSecret(file);else assert.equal((await fs.readFile(file)).includes(Buffer.from(key)),false,file);}}await noSecret(f.data);
});

test('音频格式、大小、协议和模型能力未通过时不会调用服务',async t=>{
 const f=await fixture(t),auth={origin:f.base,model:'gemini-3-flash',sendPrompt:true,sendReferences:true,requestLimit:1,budget:1,currency:'CNY'};
 const bad=await storeAsset(f.data,Buffer.from('not audio'),{name:'bad.wav',type:'audio/wav'}),large=await storeAsset(f.data,Buffer.alloc(10*1024*1024+1,0),{name:'large.wav',type:'audio/wav'});
 await assert.rejects(prepareChatMedia({data:f.data,assetIds:[bad.id]}),/格式不符/);
 await assert.rejects(prepareChatMedia({data:f.data,assetIds:[large.id]}),/不能超过10MB/);
 await assert.rejects(f.service.send(f.conversation.id,{revision:0,requestId:'audio-disabled',platformId:f.platform.id,model:'gemini-3-flash',mode:'chat',text:'总结',assetIds:[f.asset.id],apiKey:key,authorization:{...auth,sendReferences:false}}),/确认本次服务/);
 const disabled=await f.platforms.save({revision:1,platform:{name:'Gemini 无音频',protocol:'gemini',baseUrl:f.base+'/v1beta',models:[{id:'gemini-3-text-only',category:'chat',audioSupport:false}]}}),plain=disabled.platforms.at(-1);
 await assert.rejects(f.service.send(f.conversation.id,{revision:0,requestId:'audio-model-disabled',platformId:plain.id,model:'gemini-3-text-only',mode:'chat',text:'总结',assetIds:[f.asset.id],apiKey:key,authorization:{...auth,model:'gemini-3-text-only'}}),/模型未启用音频理解/);
 assert.equal(f.calls.length,0);assert.equal((await f.service.get(f.conversation.id)).messages.length,0);
});

test('缺失或不完整结束状态保存片段且不自动重发，未知状态不写入平台原文',async t=>{
 for(const reason of [undefined,'MAX_TOKENS',key]){
  const f=await fixture(t);f.state.finish=reason;
  const body={revision:0,requestId:'audio-incomplete',platformId:f.platform.id,model:'gemini-3-flash',mode:'chat',text:'听写',assetIds:[f.asset.id],apiKey:key,authorization:{origin:f.base,model:'gemini-3-flash',sendPrompt:true,sendReferences:true,requestLimit:1,budget:1,currency:'CNY'}};
  const job=await f.service.send(f.conversation.id,structuredClone(body)),done=await waitJob(f,job.id);assert.equal(done.status,'incomplete');assert.equal(done.finishReason,reason==='MAX_TOKENS'?'MAX_TOKENS':'UNKNOWN');
  const c=await f.service.get(f.conversation.id);assert.equal(c.messages.at(-1).state,'incomplete');await assert.rejects(f.service.apply(c.id,{messageId:c.messages.at(-1).id,revision:0}),/未完成片段/);
  assert.equal((await f.service.send(c.id,structuredClone(body))).id,job.id);assert.equal(f.calls.length,1);
  assert.equal((await fs.readFile(path.join(f.data,'jobs',job.id+'.json'),'utf8')).includes(key),false);
 }
});

test('直接对话接口也拒绝两份音频，不依赖前端预览校验',async t=>{
 const f=await fixture(t),second=await storeAsset(f.data,wav(),{name:'另一段.wav',type:'audio/wav'});
 await assert.rejects(f.service.send(f.conversation.id,{revision:0,requestId:'audio-too-many',platformId:f.platform.id,model:'gemini-3-flash',mode:'chat',text:'听写',assetIds:[f.asset.id,second.id],apiKey:key,authorization:{origin:f.base,model:'gemini-3-flash',sendPrompt:true,sendReferences:true,requestLimit:1,budget:1,currency:'CNY'}}),/最多附加1份音频/);
 assert.equal(f.calls.length,0);assert.equal((await f.service.get(f.conversation.id)).messages.length,0);
});

test('Gemini 整份对话超出编码大小上限时不创建任务或追加消息',async t=>{
 const f=await fixture(t),large=Buffer.alloc(10*1024*1024);wav().copy(large);
 const audio=await storeAsset(f.data,large,{name:'large.wav',type:'audio/wav'}),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64'),image=await storeAsset(f.data,Buffer.concat([png,Buffer.alloc(4*1024*1024)]),{name:'large.png',type:'image/png'});
 await f.platforms.save({revision:1,platform:{...f.platform,models:[{...f.platform.models[0],referenceSupport:true}]}});
 await assert.rejects(f.service.send(f.conversation.id,{revision:0,requestId:'audio-total-large',platformId:f.platform.id,model:'gemini-3-flash',mode:'chat',text:'总结这段音频与图片',assetIds:[audio.id,image.id],apiKey:key,authorization:{origin:f.base,model:'gemini-3-flash',sendPrompt:true,sendReferences:true,requestLimit:1,budget:1,currency:'CNY'}}),/18MB/);
 assert.equal(f.calls.length,0);assert.equal((await f.service.get(f.conversation.id)).messages.length,0);assert.deepEqual(await fs.readdir(path.join(f.data,'jobs')).catch(()=>[]),[]);
});
