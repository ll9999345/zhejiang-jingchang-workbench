import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeToFragment,normalizeNativeWorkflow} from '../lib/native-canvas-core.mjs';
import {nativeReferencePlan,needsNativeFlow} from '../lib/native-flow-execution.mjs';
import {planNativeApiStep,resolveNativeApiStep} from '../lib/native-api-inputs.mjs';
import {generationService} from '../lib/generation.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';
import {directImageService} from '../lib/direct-images.mjs';
import {canvasLlmService} from '../lib/canvas-llm.mjs';
import {creationStudioService} from '../lib/creation-studio.mjs';
import {readJson,storeAsset,atomicJson} from '../lib/workspace.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
const source=(id,type,extra={})=>({id,type,x:0,y:0,...extra});
const dummy='synthetic-native-adapter-test-only';
async function fixture(t,{network=true}={}){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-native-api-')),activeJobs=new Map(),state={calls:[],extra:0,uncertain:false};let endpoint='http://127.0.0.1:1';
 if(network){const mock=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks).toString();res.setHeader('content-type','application/json');
  if(req.method==='POST')state.calls.push({url:req.url,raw});
  if(req.url==='/prompt')return res.end(JSON.stringify({prompt_id:'p-'+state.calls.filter(c=>c.url==='/prompt').length}));
  if(req.url.startsWith('/history/')){const id=req.url.split('/').at(-1);return res.end(JSON.stringify({[id]:{status:{completed:true,status_str:'success'},outputs:{'3':{images:Array.from({length:1+state.extra},(_,i)=>({filename:id+'-'+i+'.png',type:'output',subfolder:''}))}}}}));}
  if(req.url.startsWith('/view')){res.setHeader('content-type','image/png');return res.end(png);}
  if(req.url==='/v1/chat/completions')return res.end(JSON.stringify({choices:[{message:{content:'完整的后续镜头描述'},finish_reason:'stop'}]}));
  if(['/v1/images/edits','/v1/images/generations'].includes(req.url)){if(state.uncertain)return res.destroy();return res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));}
  res.statusCode=404;res.end('{}');
 });mock.listen(0,'127.0.0.1');await once(mock,'listening');endpoint='http://127.0.0.1:'+mock.address().port;t.after(()=>new Promise(resolve=>mock.close(resolve)));}
 const a=await storeAsset(data,png,{name:'甲.png',type:'image/png'}),b=await storeAsset(data,png,{name:'乙.png',type:'image/png'}),c=await storeAsset(data,png,{name:'丙.png',type:'image/png'});
 const resources=[a,b,c].map((asset,i)=>({url:'/source/'+i,archive:'resources/'+i+'.png',portableUrl:asset.url,asset}));
 const p=nativeToFragment(normalizeNativeWorkflow({nodes:[source('a','image',{url:'/source/0'}),source('b','image',{url:'/source/1'}),source('c','image',{url:'/source/2'}),source('group','group',{items:['b','a']}),source('prompt','prompt',{text:'场景背景'}),source('pg','promptGroup',{items:['prompt']}),source('first','generator',{text:'首镜头'}),source('second','llm',{text:'只看本镜头'}),source('last','generator',{text:'末镜头'})],connections:[{from:'group',to:'first'},{from:'pg',to:'first'},{from:'first',to:'second'},{from:'group',to:'second'},{from:'second',to:'last'},{from:'group',to:'last'}]}),resources,'原生接口整合样本');
 const node=id=>p.nodes.find(n=>n.params.nativeCanvas.node.id===id);
 for(const id of ['first','second','last'])node(id).params.nativeCanvas.adaptation='configured';
 const platform=(category)=>({id:'local-native-test',name:'本机协议样本',protocol:'openai-compatible',baseUrl:endpoint+'/v1',models:[{id:category+'-test',category,referenceSupport:true}]});
 node('first').params.imageBinding={platform:platform('image'),model:'image-test',referenceSources:[{sourceNodeId:node('group').id}]};
 node('second').params.llmBinding={platform:platform('chat'),model:'chat-test',stream:false,includeUpstream:false,referenceSources:[{sourceNodeId:node('group').id}]};
 node('last').params.studioBinding={mode:'image',config:{protocol:'studio',baseUrl:endpoint+'/v1',model:'studio-test',count:1},referenceSources:[{sourceNodeId:node('group').id}]};
 const generation=generationService({data,activeJobs}),directImages=directImageService({data,activeJobs,platforms:{get:async()=>{throw Error('use saved binding');}}}),canvasLlm=canvasLlmService({data,activeJobs}),creationStudio=creationStudioService({data,activeJobs,pollInterval:10}),runner=canvasRunner({data,activeJobs,generation,directImages,canvasLlm,creationStudio,pollInterval:10});
 return{data,activeJobs,p,project:p,node,a,b,c,endpoint,state,generation,directImages,canvasLlm,creationStudio,runner};
}
function auth(f,steps,requestId='native-api-chain'){
 const body={revision:0,consent:true,requestId,imageCredentials:[],llmCredentials:[],studioCredentials:[]};
 for(const s of steps){if(s.kind==='comfy')continue;const key={'image-api':'image','canvas-llm':'llm',studio:'studio'}[s.kind],b=s[key],model=b.model||b.config.model;body[key+'Credentials'].push({nodeId:s.nodeId,apiKey:dummy,authorization:{origin:f.endpoint,model,sendPrompt:true,sendReferences:s.sendAssets,requestLimit:1,budget:1,currency:b.config?.currency||'CNY'}});}
 return body;
}
async function wait(f,id){for(let i=0;i<900;i++){const job=await readJson(path.join(f.data,'jobs',id+'.json'));if(['completed','interrupted','cancelled'].includes(job.status)&&!f.activeJobs.size)return job;await delay(10);}throw Error('native API timeout');}

test('原生组→图片→语言模型→创作台传递全部素材，文字不重复且includeUpstream=false保持自身提示',async t=>{
 const f=await fixture(t),before=structuredClone(f.p),plan=await f.runner.plan(f.p);
 assert.deepEqual(plan.map(s=>s.kind),['image-api','canvas-llm','studio']);assert.equal(plan[0].text,'场景背景\n\n首镜头');
 for(const step of plan)assert.deepEqual(step.nativeReferences.details.map(r=>r.assetId),[f.b.id,f.a.id]);
 const body=auth(f,plan),j=await f.runner.start(f.p,structuredClone(body),f.endpoint),done=await wait(f,j.id);assert.equal(done.status,'completed',done.message);assert.deepEqual(f.p,before);
 const image=await readJson(path.join(f.data,'jobs',done.steps[0].jobId+'.json')),llm=await readJson(path.join(f.data,'jobs',done.steps[1].jobId+'.json')),studio=await readJson(path.join(f.data,'jobs',done.steps[2].jobId+'.json'));
 assert.deepEqual(image.input.referenceIds,[f.b.id,f.a.id]);assert.deepEqual(llm.input.referenceIds,[f.b.id,f.a.id]);assert.equal(llm.input.text,'只看本镜头');assert.deepEqual(studio.input.studio.references.map(r=>r.assetId),[f.b.id,f.a.id]);assert.match(studio.input.studio.prompt,/完整的后续镜头描述/);
 assert.equal(f.state.calls.length,3);assert.equal((await f.runner.start(f.p,structuredClone(body),f.endpoint)).id,j.id);assert.equal(f.state.calls.length,3);
 for(const name of await fs.readdir(path.join(f.data,'jobs')))assert.equal((await fs.readFile(path.join(f.data,'jobs',name),'utf8')).includes(dummy),false);
});

test('Comfy双结果完整传入图片接口；真实数量超过确认范围时保留结果并停止下游',async t=>{
 for(const extra of [0,1]){const f=await fixture(t),first=f.node('first'),second=f.node('second'),last=f.node('last');delete first.params.imageBinding;
  const template=await f.generation.saveTemplate({name:'本机输出',workflow:{'1':{class_type:'Text',inputs:{text:'x'}},'3':{class_type:'SaveImage',inputs:{images:['1',0]}}}});first.params.workflowBinding={workflowId:template.id,overrides:[],imageSources:[],count:2};
  // Keep a native image API consumer without the unrelated LLM/studio steps.
  f.p.nodes=f.p.nodes.filter(n=>n.id!==second.id&&n.id!==last.id);f.p.edges=f.p.edges.filter(e=>f.p.nodes.some(n=>n.id===e.source)&&f.p.nodes.some(n=>n.id===e.target));
  last.params={nativeCanvas:last.params.nativeCanvas,imageBinding:{platform:{id:'native-test',name:'本机样本',protocol:'openai-compatible',baseUrl:f.endpoint+'/v1',models:[{id:'image-test',category:'image',referenceSupport:true}]},model:'image-test',referenceSources:[{sourceNodeId:first.id}]}};f.p.nodes.push(last);f.p.edges.push({id:'first-last',source:first.id,target:last.id});f.state.extra=extra;
  const steps=await f.runner.plan(f.p),j=await f.runner.start(f.p,auth(f,steps,'native-batch-'+extra),f.endpoint),done=await wait(f,j.id);
  assert.equal(done.assets.filter(a=>a.sourceNodeId===first.id).length,extra?4:2);
  if(extra){assert.equal(done.status,'interrupted');assert.match(done.message,/超过已确认范围/);assert.equal(f.state.calls.filter(c=>c.url.includes('/images/')).length,0);}else{assert.equal(done.status,'completed',done.message);const child=await readJson(path.join(f.data,'jobs',done.steps[1].jobId+'.json'));assert.deepEqual(child.input.referenceIds,done.assets.filter(a=>a.sourceNodeId===first.id).map(a=>a.id));}
 }
});

test('首次单请求原生生成也启用整组路径，不依据旧缓存推断只会返回一张',async t=>{
 const f=await fixture(t,{network:false}),first=f.node('first'),second=f.node('second');first.params.workflowBinding={workflowId:'test',count:1};delete first.params.imageBinding;second.params.llmBinding.referenceSources=[{sourceNodeId:first.id}];
 assert.equal(needsNativeFlow(f.p,second),true);const plan=nativeReferencePlan(f.p,second,second.params.llmBinding.referenceSources,{planning:true,consumer:'llm'});assert.equal(plan.references[0].expectedCount,1);assert.equal(plan.references[0].assetId,undefined);
});

test('重复整组来源、超额待生成组和不相连来源在任何提交前拒绝',async t=>{
 const f=await fixture(t),first=f.node('first');first.params.imageBinding.referenceSources.push({assetId:f.a.id});await assert.rejects(f.runner.plan(f.p),/重复素材/);first.params.imageBinding.referenceSources=[{sourceNodeId:f.node('c').id}];await assert.rejects(f.runner.plan(f.p),/相连/);assert.equal(f.state.calls.length,0);
});

test('同步子任务结果不确定，恢复只读取原任务，不重复发送整组素材',async t=>{
 const f=await fixture(t);f.state.uncertain=true;const steps=await f.runner.plan(f.p),j=await f.runner.start(f.p,auth(f,steps),f.endpoint),done=await wait(f,j.id);assert.equal(done.status,'interrupted');assert.equal(f.state.calls.length,1);
 const body=auth(f,done.steps);body.imageCredentials=[];await f.runner.resume(j.id,body);const resumed=await wait(f,j.id);assert.match(resumed.message,/不会自动重发/);assert.equal(f.state.calls.length,1);
 // Simulate the crash window before the parent had persisted its child's ID.
 delete resumed.steps[0].jobId;await atomicJson(path.join(f.data,'jobs',j.id+'.json'),resumed);await f.runner.resume(j.id,auth(f,resumed.steps));await wait(f,j.id);assert.equal(f.state.calls.length,1);
});

test('运行前拒绝新增媒体类型，并与预览保持跨来源细项交错排序',async t=>{
 const f=await fixture(t,{network:false}),first=f.node('first'),last=f.node('last'),group=f.node('group');
 const plan=await planNativeApiStep('studio',{data:f.data,project:f.p,node:last,binding:last.params.studioBinding,parents:new Set([group.id]),text:'样本'});plan.authorization={sendReferences:true};
 const audio=await storeAsset(f.data,Buffer.from('synthetic audio'),{name:'音频.wav',type:'audio/wav'});f.p.assets.push(audio);f.node('a').params.nativeCanvas.resources.push({url:'/new-audio',archive:'resources/audio.wav',assetId:audio.id});f.node('a').params.nativeCanvas.node.url='/new-audio';f.node('a').params.nativeCanvas.mediaAssetIds=[audio.id];
 await assert.rejects(resolveNativeApiStep(f.data,f.p,plan,[]),/未确认的媒体类型/);
 const ordered=nativeToFragment(normalizeNativeWorkflow({nodes:[source('gen','generator',{generatedOutputs:['/source/0','/source/1']}),source('other','image',{url:'/source/2'}),source('dst','generator',{inputs:['gen:generated:0:/source/0','other','gen:generated:1:/source/1']})],connections:[{from:'gen',to:'dst'},{from:'other',to:'dst'}]}),[f.a,f.b,f.c].map((asset,i)=>({url:'/source/'+i,archive:'resources/'+i+'.png',portableUrl:asset.url,asset})),'排序测试');
 const get=id=>ordered.nodes.find(n=>n.params.nativeCanvas.node.id===id),expanded=nativeReferencePlan(ordered,get('dst'),[{sourceNodeId:get('gen').id},{sourceNodeId:get('other').id}],{planning:true});assert.deepEqual(expanded.references.map(r=>r.assetId),[f.a.id,f.c.id,f.b.id]);
});
