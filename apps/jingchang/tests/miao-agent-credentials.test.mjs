import './helpers/local-network-only.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {conversationService} from '../lib/conversations.mjs';
import {platformService} from '../lib/api-platforms.mjs';
import {makeProject} from '../lib/model.mjs';
import {readJson,atomicJson,storeAsset,userError} from '../lib/workspace.mjs';
import {isLocalMiaoTarget,MIAO_API_BASE} from '../public/miao-credential-core.js';

const routerSecret='synthetic-managed-agent-routing-secret';
const imageSecret='synthetic-managed-agent-image-secret';
const manualRouter='synthetic-manual-agent-routing-key';
const manualImage='synthetic-manual-agent-image-key';
const allSecrets=[routerSecret,imageSecret,manualRouter,manualImage];
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII=','base64');

async function fixture({routerBase=MIAO_API_BASE,imageBase=MIAO_API_BASE}={}){
 const prefix=process.env.JINGCHANG_AGENT_TEST_EVIDENCE||os.tmpdir();await fs.mkdir(prefix,{recursive:true});
 const data=await fs.mkdtemp(path.join(prefix,'jc-miao-agent-')),activeJobs=new Map(),calls=[],resolves=[],state={action:'generate_image',routeFailure:false,imageFailure:0,resolveFailure:null,holdRoute:false,echo:false};
 const platforms=platformService(data);
 let saved=await platforms.save({revision:0,platform:{name:'隔离判断服务',baseUrl:routerBase,protocol:'openai-compatible',models:[{id:'fixture-chat',category:'chat',referenceSupport:true}]}}),routerId=saved.platforms[0].id;
 saved=await platforms.save({revision:saved.revision,platform:{name:'隔离图片服务',baseUrl:imageBase,protocol:'openai-compatible',models:[{id:'fixture-image',category:'image',referenceSupport:true},{id:'fixture-no-reference',category:'image',referenceSupport:false}]}});
 const imageId=saved.platforms.find(p=>p.name==='隔离图片服务').id,project=makeProject('托管 Agent 隔离验收');
 const miaoCredentials={resolve:async(platform,{purpose})=>{assert.ok(isLocalMiaoTarget(platform,{purpose}));resolves.push({purpose,platformId:platform.id});if(state.resolveFailure===purpose)throw userError('模拟本机配置无法读取');return{apiKey:purpose==='chat'?routerSecret:imageSecret,source:'isolated-fixture'};}};
 const apiCall=async options=>{
  const route=options.body.messages[0]?.content?.includes?.('动作规划器'),kind=route?'route':'chat';calls.push({kind,options});assert.equal(options.baseUrl,routerBase);assert.equal(options.path,'chat/completions');
  if(route&&state.holdRoute)await new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});options.signal.throwIfAborted();});
  if(route&&state.routeFailure)throw userError('模拟判断失败 '+routerSecret+' '+imageSecret);
  if(route){const snapshot=JSON.parse(options.body.messages.at(-1).content),count=state.action==='edit_image'?1:snapshot.imageCount;return{choices:[{message:{content:JSON.stringify({action:state.action,prompts:Array.from({length:count},(_,i)=>'实际创作提示词 '+(i+1)+(state.echo?' '+routerSecret+' '+imageSecret:'')),reply:'模拟创作说明'+(state.echo?' '+routerSecret+' '+imageSecret:'')})},finish_reason:'stop'}]};}
  const text='模拟回答 '+routerSecret+' '+imageSecret;
  if(options.body.stream){await options.onDelta(text);return{text,complete:true,finishReason:'stop'};}
  return{choices:[{message:{content:text},finish_reason:'stop'}]};
 };
 const agentImageGenerator=async options=>{calls.push({kind:'image',options});assert.equal(options.baseUrl,imageBase);assert.equal(options.model,'fixture-image');if(calls.filter(c=>c.kind==='image').length===state.imageFailure)throw Object.assign(new Error('fake unconfirmed'),{publicMessage:'模拟图片结果不确定 '+imageSecret,uncertain:true});return{images:[{mime:'image/png',bytes:Buffer.from(png)}]};};
 const projects={load:async()=>project,apply:async(_c,m)=>m},service=conversationService({data,platforms,activeJobs,projects,miaoCredentials,apiCall,agentImageGenerator}),c=await service.create({projectId:project.id});
 async function body(conversation=c,extra={}){
  const b={revision:conversation.revision,requestId:randomUUID(),mode:'agent',platformId:routerId,model:'fixture-chat',text:'生成两张海报',assetIds:[],size:'1024x1024',quality:'medium',stream:false,maxTokens:512,systemPrompt:'使用中文描述',agent:{imagePlatformId:imageId,imageModel:'fixture-image',imageCount:'auto',inheritLastImage:true},...extra};
  const preview=await service.agentPreview(conversation.id,b);
  Object.assign(b,{apiKey:'',credentialSource:'miao-local',credentialConsent:true,authorization:{origin:new URL(routerBase).origin,model:b.model,sendPrompt:true,sendReferences:preview.context.images>0,requestLimit:2,budget:1,currency:'CNY'}});
  Object.assign(b.agent,{imageApiKey:'',credentialSource:'miao-local',credentialConsent:true,previewHash:preview.hash,imageAuthorization:{origin:new URL(imageBase).origin,model:b.agent.imageModel,sendPrompt:true,sendReferences:preview.image.referenceIds.length>0,requestLimit:preview.image.count,budget:2,currency:'CNY'}});
  return{b,preview};
 }
 return{data,activeJobs,calls,resolves,state,platforms,routerId,imageId,service,c,body};
}
async function done(f,id){for(let i=0;i<500;i++){const j=await readJson(path.join(f.data,'jobs',id+'.json'));if(!['queued','running'].includes(j.status)&&!f.activeJobs.has(id))return j;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('isolated Agent job timeout');}
async function until(predicate){for(let i=0;i<300;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('isolated Agent condition timeout');}
async function noSecrets(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())await noSecrets(file);else{const bytes=await fs.readFile(file);for(const secret of allSecrets)assert.equal(bytes.includes(Buffer.from(secret)),false,file);}}}
async function noAcceptedRequest(f){assert.equal(f.calls.length,0);assert.equal(f.resolves.length,0);assert.equal((await f.service.get(f.c.id)).requests.length,0);assert.deepEqual(await fs.readdir(path.join(f.data,'jobs')),[]);await noSecrets(f.data);}
function cleared(body){assert.equal(body.apiKey,'');assert.equal(body.credentialSource,undefined);assert.equal(body.credentialConsent,undefined);assert.equal(body.agent.imageApiKey,'');assert.equal(body.agent.credentialSource,undefined);assert.equal(body.agent.credentialConsent,undefined);}

test('双托管用途预览零读取，真实 Agent 路径逐张执行，幂等与授权不持久化',async()=>{
 const f=await fixture(),{b,preview}=await f.body();assert.equal(preview.image.count,2);assert.equal(f.calls.length,0);assert.equal(f.resolves.length,0);
 const [a,replay]=await Promise.all([f.service.send(f.c.id,structuredClone(b)),f.service.send(f.c.id,structuredClone(b))]);assert.equal(a.id,replay.id);const result=await done(f,a.id);assert.equal(result.status,'completed',result.message);assert.deepEqual(f.calls.map(c=>c.kind),['route','image','image']);assert.deepEqual(f.resolves.map(c=>c.purpose),['chat','image']);assert.equal(f.calls[0].options.apiKey,routerSecret);assert.ok(f.calls.slice(1).every(c=>c.options.apiKey===imageSecret));assert.equal(result.requestCount,3);assert.equal(result.assets.length,2);assert.ok(result.requests.every(r=>r.status==='completed'));
 const c=await f.service.get(f.c.id);assert.equal(c.messages.at(-1).agentAction,'generate_image');assert.equal(c.agentSettings.size,'1024x1024');assert.equal(c.agentSettings.quality,'medium');assert.equal(JSON.stringify(c).includes('credentialConsent'),false);assert.equal(JSON.stringify(c).includes('credentialSource'),false);
 // A replay is a read of the existing result, even without credentials or consent.
 const bare={requestId:b.requestId};assert.equal((await f.service.send(c.id,bare)).id,a.id);const consentReplay=structuredClone(b);assert.equal((await f.service.send(c.id,consentReplay)).id,a.id);cleared(consentReplay);assert.equal(f.resolves.length,2);assert.equal(f.calls.length,3);await noSecrets(f.data);
 // A genuinely new request must receive fresh consent; the preceding send cannot grant it.
 const next=await f.body(c);delete next.b.agent.credentialConsent;await assert.rejects(f.service.send(c.id,next.b),/明确选择/);assert.equal(f.resolves.length,2);
});

test('两种混合来源保留手填 Key，并只为指定用途读取托管配置',async()=>{
 for(const manualSide of ['router','image']){
  const f=await fixture(),{b}=await f.body();if(manualSide==='router'){b.apiKey=manualRouter;delete b.credentialSource;delete b.credentialConsent;}else{b.agent.imageApiKey=manualImage;delete b.agent.credentialSource;delete b.agent.credentialConsent;}
  const result=await done(f,(await f.service.send(f.c.id,b)).id);assert.equal(result.status,'completed',result.message);assert.deepEqual(f.resolves.map(c=>c.purpose),[manualSide==='router'?'image':'chat']);assert.equal(f.calls[0].options.apiKey,manualSide==='router'?manualRouter:routerSecret);assert.ok(f.calls.filter(c=>c.kind==='image').every(c=>c.options.apiKey===(manualSide==='image'?manualImage:imageSecret)));assert.equal(b.apiKey,'');assert.equal(b.agent.imageApiKey,'');await noSecrets(f.data);
 }
});

test('双预算、服务、模型、数量、预览、媒体授权及来源全部验证后才读取 Key',async()=>{
 const f=await fixture(),{b}=await f.body();
 const changes=[x=>delete x.credentialConsent,x=>x.credentialConsent='true',x=>delete x.agent.credentialConsent,x=>x.agent.credentialConsent=false,x=>x.agent.credentialConsent='true',x=>x.credentialSource='ark-local',x=>x.agent.credentialSource='other',x=>x.apiKey=manualRouter,x=>x.agent.imageApiKey=manualImage,x=>x.authorization.origin='https://evil.invalid',x=>x.authorization.model='different-chat',x=>x.authorization.requestLimit=1,x=>x.authorization.budget=0,x=>x.agent.imageAuthorization.origin='https://evil.invalid',x=>x.agent.imageAuthorization.model='different-image',x=>x.agent.imageAuthorization.requestLimit=4,x=>x.agent.imageAuthorization.budget=0,x=>x.agent.imageAuthorization.sendReferences=true,x=>x.agent.previewHash='stale',x=>x.text='已改变提示',x=>x.agent.imageCount=5,x=>x.maxTokens=9000,x=>x.stream='yes',x=>x.nativeVideoIds=[randomUUID()]];
 for(const mutate of changes){const bad=structuredClone(b);mutate(bad);await assert.rejects(f.service.send(f.c.id,bad));if(bad.agent.credentialSource===undefined&&bad.credentialSource===undefined)cleared(bad);}
 await noAcceptedRequest(f);
});

test('托管来源不能发送到非喵喵图片或判断目的地，另一侧也不提前读取',async()=>{
 for(const options of [{imageBase:'https://other.invalid/v1'},{routerBase:'https://other.invalid/v1'},{imageBase:'http://127.0.0.1:8188/v1'}]){const f=await fixture(options),{b}=await f.body();await assert.rejects(f.service.send(f.c.id,b),/已登记的 HTTPS 模型服务地址/);await noAcceptedRequest(f);}
});

test('选定参考文件在预览后损坏，双托管读取和图片提交仍为零',async()=>{
 const f=await fixture(),asset=await storeAsset(f.data,png,{name:'本次参考.png',type:'image/png'}),{b}=await f.body(f.c,{assetIds:[asset.id]});await fs.writeFile(path.join(f.data,'assets',asset.id),Buffer.alloc(png.length,0));await assert.rejects(f.service.send(f.c.id,b));await noAcceptedRequest(f);
});

test('继承上一张图片在预览后缺失，未新增任务且不再次读取任何 Key',async()=>{
 const f=await fixture(),first=await f.body(f.c,{text:'生成一张图'});await done(f,(await f.service.send(f.c.id,first.b)).id);const c=await f.service.get(f.c.id),{b,preview}=await f.body(c,{text:'把上一张改成夜景'}),id=preview.image.inheritAssetId;assert.ok(id);const resolves=f.resolves.length,calls=f.calls.length;
 // Preserve the fixture bytes while making the asset path unavailable.
 await fs.rename(path.join(f.data,'assets',id),path.join(f.data,'assets',id+'.preserved'));
 await assert.rejects(f.service.send(c.id,b));assert.equal(f.resolves.length,resolves);assert.equal(f.calls.length,calls);assert.equal((await f.service.get(c.id)).requests.length,1);await noSecrets(f.data);
});

test('模型未开启编辑能力时保留判断/问答兼容，图片操作停在提交之前',async()=>{
 const f=await fixture(),asset=await storeAsset(f.data,png,{name:'原图.png',type:'image/png'}),{b}=await f.body(f.c,{assetIds:[asset.id],agent:{imagePlatformId:f.imageId,imageModel:'fixture-no-reference',imageCount:1,inheritLastImage:false}});f.state.action='edit_image';const result=await done(f,(await f.service.send(f.c.id,b)).id);assert.equal(result.status,'failed');assert.match(result.message,/参考图支持/);assert.deepEqual(f.calls.map(c=>c.kind),['route']);await noSecrets(f.data);
});

test('本机配置解析失败无请求、无任务、无重试，手填仍可另开一次授权',async()=>{
 const f=await fixture(),{b}=await f.body();f.state.resolveFailure='image';await assert.rejects(f.service.send(f.c.id,b),/模拟本机配置/);assert.deepEqual(f.resolves.map(c=>c.purpose),['chat','image']);assert.equal(f.calls.length,0);assert.equal((await f.service.get(f.c.id)).requests.length,0);assert.deepEqual(await fs.readdir(path.join(f.data,'jobs')),[]);cleared(b);await noSecrets(f.data);
 Object.assign(b,{credentialSource:'miao-local',credentialConsent:true});b.agent.imageApiKey=manualImage;b.agent.credentialSource='manual';const result=await done(f,(await f.service.send(f.c.id,b)).id);assert.equal(result.status,'completed',result.message);assert.deepEqual(f.resolves.map(c=>c.purpose),['chat','image','chat']);assert.ok(f.calls.filter(c=>c.kind==='image').every(c=>c.options.apiKey===manualImage));cleared(b);await noSecrets(f.data);
});

test('托管图片 Key 混入当前文字或系统指令，在任何文件写入前拒绝',async()=>{
 for(const extra of [{text:'生成图片 '+imageSecret},{systemPrompt:'本次系统指令 '+imageSecret},{text:'回答问题 '+routerSecret}]){const f=await fixture(),{b}=await f.body(f.c,extra);await assert.rejects(f.service.send(f.c.id,b),/API Key/);assert.equal(f.calls.length,0);assert.equal((await f.service.get(f.c.id)).messages.length,0);cleared(b);await noSecrets(f.data);}
});

test('双托管解析后本地保存失败仍清除临时Key和同意，未提交任何上游请求',async()=>{
 const f=await fixture(),{b}=await f.body(),history=path.join(f.data,'conversations','history',f.c.id);await fs.rename(history,history+'.preserved');await fs.writeFile(history,'fixture: force history write failure');await assert.rejects(f.service.send(f.c.id,b));cleared(b);assert.deepEqual(f.resolves.map(c=>c.purpose),['chat','image']);assert.equal(f.calls.length,0);assert.equal((await f.service.get(f.c.id)).requests.length,0);const jobs=await fs.readdir(path.join(f.data,'jobs'));assert.equal(jobs.length,1);const job=await readJson(path.join(f.data,'jobs',jobs[0]));assert.equal(job.status,'failed');assert.equal(job.requestCount,0);assert.equal(job.uncertain,false);await noSecrets(f.data);
});

test('动作计划与流式问答回显的双托管 Key 在任务、对话和历史文件均隐藏',async()=>{
 const f=await fixture();f.state.echo=true;let {b}=await f.body(),result=await done(f,(await f.service.send(f.c.id,b)).id);assert.equal(result.status,'completed',result.message);assert.ok(result.decision.reply.includes('[已隐藏密钥]'));assert.ok(f.calls.filter(c=>c.kind==='image').every(c=>!allSecrets.some(s=>c.options.prompt.includes(s))));await noSecrets(f.data);
 f.state.action='chat';const c=await f.service.get(f.c.id);({b}=await f.body(c,{text:'分析已生成画面',stream:true}));result=await done(f,(await f.service.send(c.id,b)).id);assert.equal(result.status,'completed',result.message);assert.equal(result.outputText,'模拟回答 [已隐藏密钥] [已隐藏密钥]');assert.deepEqual(f.calls.map(c=>c.kind),['route','image','image','route','chat']);await noSecrets(f.data);
});

test('判断失败和第二张不确定均不自动重发；部分结果和幂等记录保存',async()=>{
 for(const failure of ['route','image']){const f=await fixture();f.state.routeFailure=failure==='route';f.state.imageFailure=failure==='image'?2:0;const {b}=await f.body(f.c,{text:'生成三张图'}),result=await done(f,(await f.service.send(f.c.id,structuredClone(b))).id);assert.equal(result.status,'failed');assert.equal(result.assets.length,failure==='image'?1:0);assert.equal(f.calls.length,failure==='image'?3:1);assert.equal(result.uncertain,true);if(failure==='image'){assert.equal((await f.service.get(f.c.id)).messages.at(-1).state,'incomplete');assert.equal(result.requests.at(-1).status,'unconfirmed');}assert.equal((await f.service.send(f.c.id,b)).id,result.id);assert.equal(f.resolves.length,2);assert.equal(f.calls.length,failure==='image'?3:1);await noSecrets(f.data);}
});

test('判断中停止后不再提交，孤儿任务恢复和重放不读取凭据',async()=>{
 const f=await fixture();f.state.holdRoute=true;const {b}=await f.body(),job=await f.service.send(f.c.id,structuredClone(b));await until(()=>f.calls.length===1);f.activeJobs.get(job.id).controller.abort();const result=await done(f,job.id);assert.equal(result.status,'cancelled');assert.deepEqual(f.calls.map(c=>c.kind),['route']);const c=await f.service.get(f.c.id);c.requests=[];c.messages=[];await atomicJson(path.join(f.data,'conversations',c.id+'.json'),c);const before=f.resolves.length;assert.equal((await f.service.send(c.id,{requestId:b.requestId})).id,job.id);assert.equal(f.resolves.length,before);assert.equal(f.calls.length,1);assert.equal((await f.service.get(c.id)).requests.length,1);await noSecrets(f.data);
});
