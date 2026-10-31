import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {makeProject,makeNode} from '../lib/model.mjs';
import {atomicJson,readJson,records,storeAsset} from '../lib/workspace.mjs';
import {llmCredentials,clearLlmCredentials,llmCredentialPayload,canvasLlmService} from '../lib/canvas-llm.mjs';
import {imageCredentials,clearImageCredentials,imageCredentialPayload,clearCanvasApiCredentialMap} from '../lib/canvas-images.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';
import {nativeCascadeRunner} from '../lib/native-cascade-runner.mjs';
import {directImageService} from '../lib/direct-images.mjs';
import {cascadeFixture} from './helpers/native-cascade-fixture.mjs';
import {MIAO_API_BASE,isLocalMiaoTarget} from '../public/miao-credential-core.js';

// All credential reads and transports below are injected, synthetic and local.
// No system keychain, provider HTTP, model generation or formal data is used.
const SECRET='synthetic-native-managed-miao-secret';
const MANUAL='synthetic-native-manual-key';
const PNG=createCanvas(4,3).toBuffer('image/png');
const chosen=()=>({apiKey:'',credentialSource:'miao-local',credentialConsent:true});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function binding(category='chat',baseUrl=MIAO_API_BASE,protocol='openai-compatible'){
 const model=protocol==='gemini'?'gemini-synthetic-chat':'native-owned-'+category;
 return{platform:{id:'miao-native-'+category,name:'本机注入测试',protocol,baseUrl,models:[{id:model,category,referenceSupport:true}]},model,referenceSources:[],includeUpstream:true,...(category==='chat'?{systemPrompt:'本机测试编剧',maxTokens:256,stream:false}:{size:'auto',quality:'auto'})};
}
function step(kind='canvas-llm',id='native-llm'){
 const b=binding(kind==='canvas-llm'?'chat':'image');
 return{kind,nodeId:id,executionId:id,title:id,count:1,status:'pending',text:'测试镜头文字',sendAssets:false,[kind==='canvas-llm'?'llm':'image']:b};
}
function authorize(s,extra={}){
 const b=s.llm||s.image;
 return{origin:new URL(b.platform.baseUrl).origin,model:b.model,sendPrompt:true,sendReferences:s.sendAssets,requestLimit:1,budget:1,currency:'CNY',...extra};
}
async function noSecrets(directory){
 for(const entry of await fs.readdir(directory,{withFileTypes:true})){
  const file=path.join(directory,entry.name);if(entry.isDirectory())await noSecrets(file);
  else{const bytes=await fs.readFile(file);for(const secret of [SECRET,MANUAL])assert.equal(bytes.includes(Buffer.from(secret)),false,file);
   if(file.endsWith('.json')){const text=bytes.toString();assert.equal(/"credential(?:Source|Consent)"/.test(text),false,file);assert.equal(text.includes('miao-local'),false,file);}}
 }
}
async function fixture(t,{reply='本机完成的完整镜头',onResolve,onChat}={}){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-miao-native-')),project=makeProject('原生托管凭据测试'),node=makeNode('script',0,0,{id:'native-llm',text:'测试镜头文字'});
 node.params.llmBinding=binding();project.nodes=[node];project.edges=[];
 const activeJobs=new Map(),calls={resolve:[],chat:[],image:[]},parentId='synthetic-native-parent';
 activeJobs.set(parentId,{kind:'canvas-run',projectId:project.id,controller:new AbortController()});
 await atomicJson(path.join(data,'projects',project.id,'project.json'),project);
 await atomicJson(path.join(data,'projects',project.id,'history','0.json'),project);
 const miaoCredentials={resolve:async(target,options)=>{
  assert.ok(isLocalMiaoTarget(target,options));calls.resolve.push({purpose:options.purpose,baseUrl:target.baseUrl});
  await onResolve?.({activeJobs,parentId});return{apiKey:SECRET,source:'macos-keychain'};
 }};
 const apiCall=async options=>{
  calls.chat.push({apiKey:options.apiKey,baseUrl:options.baseUrl,body:structuredClone(options.body),path:options.path});
  if(onChat)return onChat(options);
  return{choices:[{message:{role:'assistant',content:reply},finish_reason:'stop'}]};
 };
 const imageGenerator=async options=>{
  calls.image.push({apiKey:options.apiKey,baseUrl:options.baseUrl,prompt:options.prompt,references:options.references.map(ref=>({mime:ref.mime,bytes:Buffer.from(ref.bytes)}))});
  return{images:[{mime:'image/png',bytes:PNG}],usage:{synthetic:1}};
 };
 const llm=canvasLlmService({data,activeJobs,miaoCredentials,apiCall}),images=directImageService({data,activeJobs,miaoCredentials,imageGenerator,platforms:{get:async()=>{throw Error('bound snapshot required');}}});
 async function done(id){
  for(let i=0;i<1000;i++){const job=await readJson(path.join(data,'jobs',id+'.json'));if(!activeJobs.has(id)&&!['queued','running'].includes(job.status))return job;await sleep(5);}
  throw Error('isolated native test timed out');
 }
 const newStep=()=>{const s=step();s.authorization=authorize(s);return s;};
 const credential=(extra={})=>({...chosen(),requestId:'native-child-once',...extra});
 async function rejected(s=newStep(),body=credential(),target=project,parent=parentId){
  await assert.rejects(llm.startFromCanvas(s,target,body,parent));
  assert.equal(calls.resolve.length,0);assert.equal(calls.chat.length,0);assert.equal((await records(path.join(data,'jobs'))).length,0);
  assert.equal(body.apiKey,'');assert.equal('credentialSource'in body,false);assert.equal('credentialConsent'in body,false);await noSecrets(data);
 }
 t.after(()=>{for(const active of activeJobs.values())active.controller.abort();});
 return{data,project,node,activeJobs,parentId,calls,miaoCredentials,llm,images,done,newStep,credential,rejected};
}

for(const [kind,name,normalize,payload,clear]of [['canvas-llm','llmCredentials',llmCredentials,llmCredentialPayload,clearLlmCredentials],['image-api','imageCredentials',imageCredentials,imageCredentialPayload,clearImageCredentials]]){
 test(kind+' 按节点保留本机描述与手填字符串，仅记录服务/预算范围',()=>{
  const local=step(kind,'local-node'),manual=step(kind,'manual-node'),steps=[local,manual];
  const body={[name]:[{nodeId:local.nodeId,...chosen(),authorization:authorize(local)},{nodeId:manual.nodeId,apiKey:MANUAL,authorization:authorize(manual)}]};
  const keys=normalize(steps,body),descriptor=keys.get(local.nodeId);
  assert.deepEqual(descriptor,{credentialSource:'miao-local',credentialConsent:true});assert.equal(keys.get(manual.nodeId),MANUAL);
  assert.deepEqual(payload(descriptor),descriptor);assert.deepEqual(payload(MANUAL),{apiKey:MANUAL});
  assert.equal(JSON.stringify(steps).includes('credentialSource'),false);assert.equal(JSON.stringify(steps).includes('miao-local'),false);assert.equal(JSON.stringify(steps).includes(MANUAL),false);
  clear(body);for(const item of body[name]){assert.equal(item.apiKey,'');assert.equal('credentialSource'in item,false);assert.equal('credentialConsent'in item,false);}
  clearCanvasApiCredentialMap(keys);assert.equal(keys.size,0);assert.equal('credentialSource'in descriptor,false);assert.equal('credentialConsent'in descriptor,false);
 });
 test(kind+' 缺本机 consent、混合密钥、错误目标和独立预算均不准入',()=>{
  for(const extra of [{credentialConsent:false},{credentialConsent:'true'},{credentialSource:'ark-local'},{apiKey:MANUAL}]){
   const s=step(kind);assert.throws(()=>normalize([s],{[name]:[{nodeId:s.nodeId,...chosen(),...extra,authorization:authorize(s)}]}));
  }
  for(const baseUrl of ['https://other.invalid/v1','http://miaoapi.xyz/v1','https://miaoapi.xyz/other','https://miaoapi.xyz:444/v1','https://miaoapi.xyz/v1?x=1']){
   const s=step(kind);(s.llm||s.image).platform.baseUrl=baseUrl;
   assert.throws(()=>normalize([s],{[name]:[{nodeId:s.nodeId,...chosen(),authorization:authorize(s)}]}));
  }
  for(const extra of [{budget:0},{origin:'https://other.invalid'},{model:'wrong'},{sendPrompt:false},{sendReferences:true},{requestLimit:2},{currency:'EUR'}]){
   const s=step(kind);assert.throws(()=>normalize([s],{[name]:[{nodeId:s.nodeId,...chosen(),authorization:authorize(s,extra)}]}));
  }
 });
 test(kind+' 恢复只用原服务/预算范围，未提交节点仍需新的本机 consent',()=>{
  const s=step(kind);s.authorization=authorize(s);const before=structuredClone(s.authorization);
  assert.throws(()=>normalize([s],{[name]:[{nodeId:s.nodeId,credentialSource:'miao-local'}]},{resume:true}));
  const keys=normalize([s],{[name]:[{nodeId:s.nodeId,...chosen(),authorization:{budget:999}}]},{resume:true});
  assert.deepEqual(s.authorization,before);assert.equal(keys.get(s.nodeId).credentialConsent,true);clearCanvasApiCredentialMap(keys);
  s.authorization.budget=0;assert.throws(()=>normalize([s],{[name]:[{nodeId:s.nodeId,...chosen()}]},{resume:true}));
  s.jobId='existing-child';assert.equal(normalize([s],{[name]:[]},{resume:true}).size,0);
 });
}

test('原生 LLM 校验后读假密钥，回答回显脱敏，任务/项目/历史不存来源授权',async t=>{
 const f=await fixture(t,{reply:'完整回答 '+SECRET}),body=f.credential();
 const j=await f.llm.startFromCanvas(f.newStep(),f.project,body,f.parentId),done=await f.done(j.id);
 assert.equal(done.status,'completed',done.message);assert.equal(done.outputText,'完整回答 [已隐藏密钥]');assert.equal(done.requestCount,1);
 assert.deepEqual(f.calls.resolve,[{purpose:'chat',baseUrl:MIAO_API_BASE}]);assert.equal(f.calls.chat.length,1);assert.equal(f.calls.chat[0].apiKey,SECRET);
 assert.equal(f.calls.chat[0].path,'chat/completions');assert.equal(f.calls.chat[0].body.messages[0].content,'本机测试编剧');assert.equal(body.apiKey,'');assert.equal('credentialSource'in body,false);
 await noSecrets(f.data);
});
test('原生 LLM 并发与已完成同 requestId 去重发生在 resolve 之前',async t=>{
 const f=await fixture(t),bodies=[f.credential(),f.credential()];
 const jobs=await Promise.all(bodies.map(body=>f.llm.startFromCanvas(f.newStep(),f.project,body,f.parentId)));
 assert.equal(jobs[0].id,jobs[1].id);await f.done(jobs[0].id);
 const duplicate=f.credential({credentialConsent:false});assert.equal((await f.llm.startFromCanvas(f.newStep(),f.project,duplicate,f.parentId)).id,jobs[0].id);
 assert.equal(f.calls.resolve.length,1);assert.equal(f.calls.chat.length,1);assert.equal((await records(path.join(f.data,'jobs'))).length,1);await noSecrets(f.data);
});
test('原生 LLM 的预算、服务、文字/素材范围错误均零 resolve、零任务',async t=>{
 const f=await fixture(t);
 for(const extra of [{budget:0},{budget:NaN},{budget:Infinity},{origin:'https://other.invalid'},{model:'wrong'},{sendPrompt:false},{sendReferences:true},{requestLimit:2},{currency:'EUR'}]){
  const s=f.newStep();s.authorization={...s.authorization,...extra};await f.rejected(s);
 }
 const absent=f.newStep();delete absent.authorization;await f.rejected(absent);
});
test('原生 LLM 的来源、目标、协议、模型、节点和输入错误均零 resolve',async t=>{
 const f=await fixture(t);
 for(const extra of [{credentialConsent:false},{credentialConsent:'true'},{credentialSource:'ark-local'},{credentialSource:'unknown'},{apiKey:MANUAL}])await f.rejected(f.newStep(),f.credential(extra));
 for(const baseUrl of ['https://other.invalid/v1','https://miaoapi.xyz:444/v1','https://miaoapi.xyz/other']){
  const s=f.newStep();s.llm.platform.baseUrl=baseUrl;s.authorization=authorize(s);await f.rejected(s);
 }
 for(const edit of [s=>s.llm.platform.protocol='gemini',s=>s.llm.model='missing',s=>s.llm.maxTokens=0,s=>s.text='',s=>s.text='x'.repeat(32001),s=>s.nodeId='missing-node',s=>s.count=2,s=>s.sendAssets=undefined]){
  const s=f.newStep();edit(s);await f.rejected(s);
 }
 await f.rejected(f.newStep(),f.credential(),f.project,'missing-parent');
});
test('原生 LLM 项目外素材、伪图片字节和未授权参考在 resolve 前拒绝',async t=>{
 const f=await fixture(t),s=f.newStep();s.llm.referenceSources=[{assetId:'outside-project'}];s.sendAssets=true;s.authorization=authorize(s);await f.rejected(s);
 const forged=await storeAsset(f.data,Buffer.from('not-a-png'),{type:'image/png',name:'forged.png'});
 f.project.assets.push(forged);s.llm.referenceSources=[{assetId:forged.id}];await f.rejected(s);
 const valid=await storeAsset(f.data,PNG,{type:'image/png',name:'valid.png'});f.project.assets.push(valid);
 s.llm.referenceSources=[{assetId:valid.id}];s.sendAssets=false;s.authorization=authorize(s);await f.rejected(s);
});
test('原生 LLM 父任务取消前后停止读取或提交，取消后不创建子任务',async t=>{
 const f=await fixture(t);f.activeJobs.get(f.parentId).controller.abort();await f.rejected();
 const g=await fixture(t,{onResolve:({activeJobs,parentId})=>activeJobs.get(parentId).controller.abort()});
 await assert.rejects(g.llm.startFromCanvas(g.newStep(),g.project,g.credential(),g.parentId));assert.equal(g.calls.resolve.length,1);assert.equal(g.calls.chat.length,0);assert.equal((await records(path.join(g.data,'jobs'))).length,0);await noSecrets(g.data);
});
test('假密钥出现在项目输入时，本机校验停止提交且零任务写入',async t=>{
 const f=await fixture(t),s=f.newStep();s.text+=' '+SECRET;
 await assert.rejects(f.llm.startFromCanvas(s,f.project,f.credential(),f.parentId),/输入中含密钥/);
 assert.equal(f.calls.resolve.length,1);assert.equal(f.calls.chat.length,0);assert.equal((await records(path.join(f.data,'jobs'))).length,0);await noSecrets(f.data);
});
test('原生 LLM 上游错误不重试且错误消息中的假密钥不落盘',async t=>{
 const f=await fixture(t,{onChat:()=>{throw Object.assign(Error('synthetic'),{publicMessage:'上游拒绝 '+SECRET});}}),j=await f.llm.startFromCanvas(f.newStep(),f.project,f.credential(),f.parentId),done=await f.done(j.id);
 assert.equal(done.status,'failed');assert.equal(done.requestCount,1);assert.equal(done.message,'上游拒绝 [已隐藏密钥]');
 assert.equal((await f.llm.startFromCanvas(f.newStep(),f.project,f.credential(),f.parentId)).id,j.id);assert.equal(f.calls.resolve.length,1);assert.equal(f.calls.chat.length,1);await noSecrets(f.data);
});
test('旧手填 localhost 原生 LLM 路径保持兼容，不读取本机凭据',async t=>{
 const f=await fixture(t),s=f.newStep();s.llm.platform.baseUrl='http://127.0.0.1:1/v1';s.authorization=authorize(s);
 const body={apiKey:MANUAL,requestId:'manual-native'};const j=await f.llm.startFromCanvas(s,f.project,body,f.parentId),done=await f.done(j.id);
 assert.equal(done.status,'completed');assert.equal(f.calls.resolve.length,0);assert.equal(f.calls.chat[0].apiKey,MANUAL);assert.equal(body.apiKey,'');await noSecrets(f.data);
});
async function ordinary(t){
 const f=await fixture(t);f.activeJobs.delete(f.parentId);const image=makeNode('image',400,0,{id:'native-image',text:'根据编剧画面生成'});image.params.imageBinding=binding('image');
 f.project.nodes.push(image);f.project.edges=[{id:'text-image',source:f.node.id,target:image.id}];
 const runner=canvasRunner({data:f.data,activeJobs:f.activeJobs,generation:{},canvasLlm:f.llm,directImages:f.images,pollInterval:5});
 const body=async(requestId='native-parent-once')=>{const steps=await runner.plan(f.project);return{requestId,revision:f.project.revision,consent:true,...Object.fromEntries([['canvas-llm','llmCredentials'],['image-api','imageCredentials']].map(([kind,name])=>[name,steps.filter(s=>s.kind===kind).map(s=>({nodeId:s.executionId||s.nodeId,...chosen(),authorization:authorize(s)}))]))};};
 return{...f,image,runner,body};
}
test('画布父任务把两类描述传入真实子服务，LLM 完整文字实际传给图片生成器',async t=>{
 const f=await ordinary(t),before=structuredClone(f.project),body=await f.body();
 const j=await f.runner.start(f.project,body,'http://127.0.0.1:1'),done=await f.done(j.id);
 assert.equal(done.status,'completed',done.message);assert.deepEqual(f.calls.resolve.map(x=>x.purpose),['chat','image']);assert.equal(f.calls.image.length,1);assert.equal(f.calls.image[0].apiKey,SECRET);
 assert.match(f.calls.image[0].prompt,/本机完成的完整镜头/);assert.equal(done.textResults.length,1);assert.equal(done.assets.length,1);assert.deepEqual(f.project,before);
 for(const name of ['llmCredentials','imageCredentials'])for(const item of body[name]){assert.equal(item.apiKey,'');assert.equal('credentialSource'in item,false);assert.equal('credentialConsent'in item,false);}
 const duplicate=await f.body();assert.equal((await f.runner.start(f.project,duplicate,'http://127.0.0.1:1')).id,j.id);assert.equal(f.calls.resolve.length,2);assert.equal(f.calls.chat.length,1);assert.equal(f.calls.image.length,1);assert.equal('credentialSource'in duplicate.llmCredentials[0],false);await noSecrets(f.data);
});
test('画布批量授权必须逐节点确认，失败仍清除所有来源/consent 且零 resolve',async t=>{
 const f=await ordinary(t),body=await f.body();body.imageCredentials[0].credentialConsent=false;
 await assert.rejects(f.runner.start(f.project,body,'http://127.0.0.1:1'));assert.equal(f.calls.resolve.length,0);assert.equal((await records(path.join(f.data,'jobs'))).length,0);
 for(const name of ['llmCredentials','imageCredentials']){assert.equal(body[name][0].apiKey,'');assert.equal('credentialSource'in body[name][0],false);assert.equal('credentialConsent'in body[name][0],false);}await noSecrets(f.data);
});
test('恢复原画布只向尚未提交图片传新描述，LLM 原结果不重读密钥或重发',async t=>{
 const f=await ordinary(t),seen=[];let blocked=true;
 const runner=canvasRunner({data:f.data,activeJobs:f.activeJobs,generation:{},canvasLlm:f.llm,directImages:{startFromCanvas:async(...args)=>{
  seen.push(structuredClone(args[2]));if(blocked)throw Object.assign(Error('本机模拟图片准入暂时阻断'),{status:400});return f.images.startFromCanvas(...args);
 }},pollInterval:5});
 const body=await f.body(),j=await runner.start(f.project,body,'http://127.0.0.1:1'),paused=await f.done(j.id);
 assert.equal(paused.status,'interrupted');assert.equal(paused.steps[0].status,'completed');assert.equal(paused.steps[1].jobId,undefined);
 assert.equal(f.calls.resolve.length,1);assert.equal(f.calls.chat.length,1);assert.equal(f.calls.image.length,0);
 const imageStep=paused.steps.find(s=>s.kind==='image-api'),denied={imageCredentials:[{nodeId:imageStep.executionId||imageStep.nodeId,credentialSource:'miao-local',credentialConsent:false}]};
 await assert.rejects(runner.resume(j.id,denied));assert.equal(f.calls.resolve.length,1);assert.equal('credentialSource'in denied.imageCredentials[0],false);assert.equal('credentialConsent'in denied.imageCredentials[0],false);
 blocked=false;const next={imageCredentials:[{nodeId:imageStep.executionId||imageStep.nodeId,...chosen()}]};
 assert.equal((await runner.resume(j.id,next)).id,j.id);const done=await f.done(j.id);
 assert.equal(done.status,'completed',done.message);assert.equal(f.calls.chat.length,1);assert.equal(f.calls.image.length,1);assert.deepEqual(f.calls.resolve.map(c=>c.purpose),['chat','image']);
 assert.equal(seen.length,2);for(const value of seen){assert.equal(value.credentialSource,'miao-local');assert.equal(value.credentialConsent,true);assert.equal(value.apiKey,undefined);}
 assert.equal('credentialSource'in next.imageCredentials[0],false);assert.equal('credentialConsent'in next.imageCredentials[0],false);await noSecrets(f.data);
});
async function cascade(t){
 const f=await fixture(t);f.activeJobs.delete(f.parentId);const g=cascadeFixture();
 for(const id of ['A','B','C'])g.node(id);g.edge('A','B');g.edge('B','C');
 for(const node of g.project.nodes){
  const a=await storeAsset(f.data,PNG,{type:'image/png',name:node.id+'.png'}),native=node.params.nativeCanvas;
  g.project.assets=g.project.assets.filter(x=>x.id!=='asset-'+node.id);g.project.assets.push(a);native.resources[0].assetId=a.id;native.mediaAssetIds=[a.id];
  node.params.imageBinding=binding('image');native.node.runSettings={engine:'api',apiKind:'image'};
 }
 const runner=nativeCascadeRunner({data:f.data,activeJobs:f.activeJobs,generation:{},directImages:f.images,pollInterval:5});
 const body=async(requestId='native-cascade-once')=>{const preview=await runner.plan(g.project,{nodeId:'C'});return{nodeId:'C',requestId,revision:g.project.revision,consent:true,previewHash:preview.previewHash,imageCredentials:preview.steps.filter(s=>s.kind==='image-api').map(s=>({nodeId:s.executionId,...chosen(),authorization:authorize(s)}))};};
 return{...f,project:g.project,runner,body};
}
test('智能串联各步骤透传本机描述，实际参考继承新结果且去重不再 resolve',async t=>{
 const f=await cascade(t),body=await f.body(),before=structuredClone(f.project),j=await f.runner.start(f.project,body,'http://127.0.0.1:1'),done=await f.done(j.id);
 assert.equal(done.status,'completed',done.message);assert.equal(f.calls.image.length,2);assert.deepEqual(f.calls.resolve.map(x=>x.purpose),['image','image']);
 const receipts=done.cascadeState.rounds[0].receipts;assert.equal(receipts[1].inputRefs[0].assetId,receipts[0].outputRefs[0].assetId);
 assert.deepEqual(f.calls.image[1].references[0].bytes,PNG);assert.deepEqual(f.project,before);
 for(const item of body.imageCredentials){assert.equal(item.apiKey,'');assert.equal('credentialSource'in item,false);assert.equal('credentialConsent'in item,false);}
 const duplicate=await f.body();assert.equal((await f.runner.start(f.project,duplicate,'http://127.0.0.1:1')).id,j.id);assert.equal(f.calls.resolve.length,2);assert.equal('credentialSource'in duplicate.imageCredentials[0],false);await noSecrets(f.data);
});
test('智能串联第二节点缺预算或 consent 时第一节点也不能自动读取密钥',async t=>{
 const f=await cascade(t);
 for(const edit of [b=>b.imageCredentials[1].credentialConsent=false,b=>b.imageCredentials[1].authorization.budget=0]){
  const body=await f.body();edit(body);await assert.rejects(f.runner.start(f.project,body,'http://127.0.0.1:1'));assert.equal(f.calls.resolve.length,0);assert.equal(f.calls.image.length,0);assert.equal((await records(path.join(f.data,'jobs'))).length,0);
  for(const item of body.imageCredentials){assert.equal(item.apiKey,'');assert.equal('credentialSource'in item,false);assert.equal('credentialConsent'in item,false);}
 }await noSecrets(f.data);
});
