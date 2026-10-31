import './helpers/local-network-only.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {normalizeNativeWorkflow,nativeToFragment} from '../lib/native-canvas-core.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';
import {generationService} from '../lib/generation.mjs';
import {cloudWorkflowService} from '../lib/cloud-workflows.mjs';
import {resolveCloudRecipe} from '../lib/canvas-cloud.mjs';
import {storeAsset,readJson} from '../lib/workspace.mjs';
import {applyCanvasResults} from '../lib/generation-results.mjs';
import {nativeFlowPreview} from '../lib/native-flow.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {rhModelFields} from '../lib/runninghub-models.mjs';
import {imageModel} from './helpers/runninghub-model-fixture.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
const mp4=Buffer.from('000000186674797069736f6d0000020069736f6d69736f32','hex');
const wav=Buffer.from('524946461000000057415645666d74200400000000000000','hex');
const key='synthetic-local-rh-only';
const raw=(id,type,extra={})=>({id,type,x:0,y:0,...extra});

async function fixture(t,{dynamic=false}={}){
 const state={calls:[],uploads:[],comfy:[],creates:[],models:[],pending:false};
 const mock=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);let body;try{body=JSON.parse(bytes);}catch{}
  state.calls.push(req.url);res.setHeader('content-type','application/json');
  if(req.url==='/prompt'){state.comfy.push(body);return res.end(JSON.stringify({prompt_id:'local-'+state.comfy.length}));}
  if(req.url.startsWith('/history/')){const id=req.url.split('/').at(-1);return res.end(JSON.stringify({[id]:{status:{completed:true,status_str:'success'},outputs:{out:{images:[{filename:id+'.png',type:'output',subfolder:''}]}}}}));}
  if(req.url==='/task/openapi/upload'){state.uploads.push(bytes);return res.end(JSON.stringify({code:0,data:{fileName:'input/file-'+state.uploads.length+'.png'}}));}
  if(req.url==='/task/openapi/create'||req.url==='/task/openapi/ai-app/run'){state.creates.push(body);return res.end(JSON.stringify({code:0,data:{taskId:'12345'}}));}
  if(req.url==='/openapi/v2/media/upload/binary'){state.uploads.push(bytes);return res.end(JSON.stringify({code:0,data:{download_url:base+'/uploaded/'+state.uploads.length}}));}
  if(req.url==='/openapi/v2/'+imageModel){state.models.push(body);return res.end(JSON.stringify({taskId:'12345'}));}
  if(req.url==='/openapi/v2/query')return res.end(JSON.stringify({taskId:body.taskId,status:state.pending?'RUNNING':'SUCCESS',results:[{url:base+'/image/1',outputType:'png'},{url:base+'/image/2',outputType:'png'}]}));
  if(req.url.startsWith('/view')||req.url.startsWith('/image/')){res.setHeader('content-type','image/png');return res.end(png);}
  res.statusCode=404;res.end('{}');
 });mock.listen(0,'127.0.0.1');await once(mock,'listening');const base='http://127.0.0.1:'+mock.address().port;
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-native-cloud-')),activeJobs=new Map();
 t.after(async()=>{for(const value of activeJobs.values())value.controller.abort();for(let i=0;i<200&&activeJobs.size;i++)await delay(10);mock.closeAllConnections();await new Promise(resolve=>mock.close(resolve));});
 const a=await storeAsset(data,png,{name:'甲图片.png',type:'image/png'}),b=await storeAsset(data,png,{name:'乙图片.png',type:'image/png'}),video=await storeAsset(data,mp4,{name:'合成视频头.mp4',type:'video/mp4'}),audio=await storeAsset(data,wav,{name:'合成音频头.wav',type:'audio/wav'});
 const refs=[a,b,video,audio].map((asset,index)=>({url:'/fixture/'+index,archive:'resources/'+index,portableUrl:asset.url,asset}));
 const doc=normalizeNativeWorkflow({format:'infinite-smart-canvas-workflow',version:1,nodes:[raw('library','smart-image',{images:(dynamic?[refs[2]]:[refs[1],refs[2],refs[3],refs[0]]).map(ref=>({url:ref.url}))}),raw('words','smart-prompt',{text:'组内说明'}),...(dynamic?[raw('producer','comfy',{text:'本轮生成两份'})]:[]),raw('group','smart-group',{items:dynamic?['library','producer','words']:['library','words']}),raw('sink','rh',{text:'继续处理'}),raw('out','output')],connections:[{from:'group',to:'sink'},{from:'sink',to:'out'},...(dynamic?[{from:'producer',to:'out'}]:[])]});
 const project=nativeToFragment(doc,refs,'本机云字段专项'),node=id=>project.nodes.find(node=>node.params.nativeCanvas.node.id===id),generation=generationService({data,activeJobs});
 if(dynamic){const template=await generation.saveTemplate({name:'本机两份输出',workflow:{'1':{class_type:'SyntheticImage',inputs:{text:'local'}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}}}});node('producer').params.nativeCanvas.adaptation='configured';node('producer').params.workflowBinding={workflowId:template.id,overrides:[],imageSources:[],count:2};}
 // Keep this existing suite as the pre-versioned saved workflow contract.
 delete project.settings.nativeMediaVersion;
 const cloudWorkflows=cloudWorkflowService({data,activeJobs,projects:{load:async()=>project},pollInterval:10});let recipe=await cloudWorkflows.create({projectId:project.id});
 recipe=await cloudWorkflows.save(recipe.id,{...recipe,baseUrl:base,targetId:'9876',fields:[{nodeId:'1',fieldName:'prompt',type:'text',fieldValue:'original'},{nodeId:'2',fieldName:'image',type:'image',fieldValue:''},{nodeId:'3',fieldName:'image',type:'image',fieldValue:''},{nodeId:'4',fieldName:'video',type:'video',fieldValue:''},...(!dynamic?[{nodeId:'5',fieldName:'audio',type:'audio',fieldValue:''}]:[])]});
 node('sink').params.nativeCanvas.adaptation='configured';node('sink').params.cloudBinding={recipeId:recipe.id,recipeRevision:recipe.revision,inputs:[{nodeId:'1',fieldName:'prompt',useText:true},...recipe.fields.slice(1).map((field,index)=>({nodeId:field.nodeId,fieldName:field.fieldName,sourceNodeId:node('group').id,sourceIndex:(dynamic?[1,2,0]:[0,3,1,2])[index]}))]};
 const runner=canvasRunner({data,activeJobs,generation,cloudWorkflows,pollInterval:10}),body={revision:0,requestId:'synthetic-native-cloud',consent:true,cloudCredentials:[{nodeId:node('sink').id,apiKey:key,authorization:{origin:base,kind:recipe.kind,targetId:recipe.targetId,requestLimit:1,sendFields:true,sendAssets:true,budget:1,currency:'CNY'}}]};
 return{state,data,activeJobs,base,project,node,generation,cloudWorkflows,runner,body,recipe,a,b,video,audio};
}
async function wait(f,id,predicate){for(let i=0;i<800;i++){const job=await readJson(path.join(f.data,'jobs',id+'.json'));if(predicate(job))return job;await delay(10);}throw Error('本机云字段任务等待超时');}
async function idle(f){for(let i=0;i<200&&f.activeJobs.size;i++)await delay(10);assert.equal(f.activeJobs.size,0);}
async function finished(f,id){const job=await wait(f,id,job=>['completed','interrupted','cancelled'].includes(job.status));await idle(f);return job;}
async function noKey(directory){for(const e of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,e.name);if(e.isDirectory())await noKey(file);else assert.equal((await fs.readFile(file)).includes(Buffer.from(key)),false,file);}}

test('混合媒体组按指定序号分配云字段，文字不重复，完整输出回填且原数据待确认',async t=>{
 const f=await fixture(t),before=structuredClone(f.project),plan=await f.runner.plan(f.project);assert.equal(plan.length,1);assert.equal(plan[0].text,'组内说明\n\n继续处理');assert.deepEqual(plan[0].nativeInputs.fields.map(input=>input.assetId),[f.b.id,f.a.id,f.video.id,f.audio.id]);assert.equal(f.state.calls.length,0);
 const started=await f.runner.start(f.project,structuredClone(f.body),f.base),done=await finished(f,started.id);assert.equal(done.status,'completed',done.message);assert.equal(f.state.creates.length,1);assert.equal(f.state.uploads.length,4);assert.equal(done.assets.length,2);assert.deepEqual(f.project,before);
 const child=await readJson(path.join(f.data,'jobs',done.steps[0].jobId+'.json'));assert.deepEqual(child.input.recipe.fields.slice(1).map(field=>field.assetId),[f.b.id,f.a.id,f.video.id,f.audio.id]);assert.equal(f.state.creates[0].nodeInfoList[0].fieldValue,plan[0].text);
 await applyCanvasResults({data:f.data,project:f.project,job:done,revision:0});assert.equal(nativeFlowPreview(f.project,{nodeId:f.node('out').id}).nodes[0].media.length,2);assert.deepEqual(f.node('sink').params.cloudBinding.inputs,before.nodes.find(n=>n.id===f.node('sink').id).params.cloudBinding.inputs);await noKey(f.data);
});

test('已知多份缺序号、越界、类型错配和断开的来源在任何调用前拒绝',async t=>{
 const f=await fixture(t),mapping=f.node('sink').params.cloudBinding.inputs[1];
 for(const [index,re]of [[undefined,/明确选择/],[-1,/0–999/],[1000,/0–999/],[1.5,/整数/],[9,/不存在/],[1,/类型不匹配/]]){if(index===undefined)delete mapping.sourceIndex;else mapping.sourceIndex=index;await assert.rejects(f.runner.plan(f.project),re);}
 mapping.sourceIndex=0;f.project.edges=f.project.edges.filter(edge=>edge.target!==f.node('sink').id);await assert.rejects(f.runner.plan(f.project),/上游/);assert.equal(f.state.calls.length,0);
});

test('分组内生成两份后准确使用本轮第1/2份，旧预览不代替本轮结果',async t=>{
 const f=await fixture(t,{dynamic:true});f.node('producer').assetId=f.a.id;
 const plan=await f.runner.plan(f.project);assert.equal(plan[1].nativeInputs.fields[0].assetId,undefined);assert.deepEqual(plan[1].nativeInputs.fields[0].pendingNodeIds,[f.node('producer').id]);
 const started=await f.runner.start(f.project,structuredClone(f.body),f.base),done=await finished(f,started.id);assert.equal(done.status,'completed',done.message);assert.equal(f.state.comfy.length,2);assert.equal(f.state.creates.length,1);assert.equal(f.state.uploads.length,3);
 const child=await readJson(path.join(f.data,'jobs',done.steps[1].jobId+'.json'));assert.deepEqual(child.input.recipe.fields.slice(1).map(field=>field.assetId),[done.assets[0].id,done.assets[1].id,f.video.id]);assert.notEqual(child.input.recipe.fields[1].assetId,f.a.id);await noKey(f.data);
});

test('标准模型的数组槽位保持分组素材顺序，重复字段引用只上传一次',async t=>{
 const f=await fixture(t),fields=rhModelFields(imageModel);fields.find(field=>field.fieldName==='prompt').fieldValue='本机数组样本';
 f.recipe=await f.cloudWorkflows.save(f.recipe.id,{...f.recipe,kind:'model',targetId:imageModel,fields});
 const refs=f.recipe.fields.filter(field=>field.type==='image').slice(0,3),indices=[3,0,3];
 f.node('sink').params.cloudBinding={recipeId:f.recipe.id,recipeRevision:f.recipe.revision,inputs:[{nodeId:'model',fieldName:'prompt',useText:true},...refs.map((field,index)=>({nodeId:field.nodeId,fieldName:field.fieldName,sourceNodeId:f.node('group').id,sourceIndex:indices[index]}))]};
 Object.assign(f.body.cloudCredentials[0].authorization,{kind:'model',targetId:imageModel});
 const started=await f.runner.start(f.project,structuredClone(f.body),f.base),done=await finished(f,started.id);assert.equal(done.status,'completed',done.message);assert.equal(f.state.models.length,1);assert.equal(f.state.uploads.length,2);
 assert.deepEqual(f.state.models[0].imageUrls,[f.base+'/uploaded/1',f.base+'/uploaded/2',f.base+'/uploaded/1']);assert.equal(f.state.creates.length,0);const child=await readJson(path.join(f.data,'jobs',done.steps[0].jobId+'.json'));assert.deepEqual(child.input.recipe.fields.filter(field=>field.source==='asset').map(field=>field.assetId),[f.a.id,f.b.id,f.a.id]);await noKey(f.data);
});

test('RunningHub应用使用相同明确序号，服务类型与目标授权仍独立核对',async t=>{
 const f=await fixture(t);f.recipe=await f.cloudWorkflows.save(f.recipe.id,{...f.recipe,kind:'app'});f.node('sink').params.cloudBinding.recipeRevision=f.recipe.revision;
 await assert.rejects(f.runner.start(f.project,structuredClone(f.body),f.base),/确认/);assert.equal(f.state.calls.length,0);f.body.cloudCredentials[0].authorization.kind='app';
 const started=await f.runner.start(f.project,structuredClone(f.body),f.base),done=await finished(f,started.id);assert.equal(done.status,'completed',done.message);assert.equal(f.state.creates.length,1);assert.equal(f.state.creates[0].webappId,f.recipe.targetId);assert.equal(f.state.uploads.length,4);await noKey(f.data);
});

test('动态整组映射的每个序号都计入允许发送数量，超过8份在上游执行前拒绝',async t=>{
 const f=await fixture(t,{dynamic:true});f.node('producer').params.workflowBinding.count=8;
 const fields=[...Array.from({length:8},(_,index)=>({nodeId:String(index+1),fieldName:'image',type:'image',fieldValue:''})),{nodeId:'9',fieldName:'video',type:'video',fieldValue:''}];f.recipe=await f.cloudWorkflows.save(f.recipe.id,{...f.recipe,fields});
 f.node('sink').params.cloudBinding={recipeId:f.recipe.id,recipeRevision:f.recipe.revision,inputs:fields.map((field,index)=>({nodeId:field.nodeId,fieldName:field.fieldName,sourceNodeId:f.node('group').id,sourceIndex:index<8?index+1:0}))};
 await assert.rejects(f.runner.plan(f.project),/参考素材数量超过/);assert.equal(f.state.calls.length,0);
});

test('动态来源实际越界、未明确序号或错类型时保留上游结果，下游零上传零提交',async t=>{
 for(const [index,re]of [[9,/不存在/],[undefined,/明确选择/],[0,/类型不匹配/]])await t.test(String(index),async t=>{
  const f=await fixture(t,{dynamic:true}),mapping=f.node('sink').params.cloudBinding.inputs[1];if(index===undefined)delete mapping.sourceIndex;else mapping.sourceIndex=index;
  await f.runner.plan(f.project);const started=await f.runner.start(f.project,structuredClone(f.body),f.base),done=await finished(f,started.id);
  assert.equal(done.status,'interrupted');assert.match(done.message,re);assert.equal(done.steps[0].status,'completed');assert.equal(done.assets.length,2);assert.equal(f.state.comfy.length,2);assert.equal(f.state.uploads.length,0);assert.equal(f.state.creates.length,0);assert.equal(done.steps[1].jobId,undefined);
 });
});

test('发送素材授权和已知文件验证在上游提交前完成',async t=>{
 const f=await fixture(t,{dynamic:true}),body=structuredClone(f.body);body.cloudCredentials[0].authorization.sendAssets=false;
 await assert.rejects(f.runner.start(f.project,body,f.base),/确认/);await fs.writeFile(path.join(f.data,'assets',f.video.id),Buffer.from('invalid'));
 await assert.rejects(f.runner.plan(f.project),/类型或大小不匹配/);assert.equal(f.state.calls.length,0);
});

test('固定来源身份或文件在确认后变化，执行前停止而不扩大发送范围',async t=>{
 const f=await fixture(t),[step]=await f.runner.plan(f.project),library=f.node('library'),resource=library.params.nativeCanvas.resources.find(resource=>resource.assetId===f.b.id);
 resource.assetId=f.a.id;await assert.rejects(resolveCloudRecipe(step,f.project,{data:f.data}),/固定素材发生变化/);resource.assetId=f.b.id;
 await fs.writeFile(path.join(f.data,'assets',f.b.id),Buffer.alloc(png.length));await assert.rejects(resolveCloudRecipe(step,f.project,{data:f.data}),/PNG|图片|格式|内容/);assert.equal(f.state.calls.length,0);
});

test('已接受的云任务恢复只查询原编号，不重新展开失效素材或重复上传生成',async t=>{
 const f=await fixture(t);f.state.pending=true;const started=await f.runner.start(f.project,structuredClone(f.body),f.base);
 await wait(f,started.id,()=>f.state.calls.includes('/openapi/v2/query'));f.activeJobs.get(started.id).controller.abort();await finished(f,started.id);
 await fs.writeFile(path.join(f.data,'assets',f.b.id),Buffer.from('no longer required to query an accepted task'));f.state.pending=false;
 const restored=canvasRunner({...f,pollInterval:10});await restored.resume(started.id,{cloudCredentials:[{nodeId:f.node('sink').id,apiKey:key}]});const done=await finished(f,started.id);
 assert.equal(done.status,'completed',done.message);assert.equal(f.state.creates.length,1);assert.equal(f.state.uploads.length,4);assert.equal(done.assets.length,2);await noKey(f.data);
});

test('RunningHub整组序号以v29备份恢复，降级和非法序号在写入项目之前拒绝',async t=>{
 const f=await fixture(t),source=projectBundleService({...f,projects:{load:async()=>f.project}}),exported=await source.exportBundle(f.project.id,0);assert.equal(exported.formatVersion,29);
 const bytes=await fs.readFile(await source.download(exported.id)),magic=Buffer.byteLength('JINGCHANG-PACK-1\n'),size=bytes.readUInt32BE(magic),manifest=JSON.parse(bytes.subarray(magic+4,magic+4+size));
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-native-cloud-import-')),activeJobs=new Map();let project,writes=0;const projects={load:async()=>{if(project)return project;throw Object.assign(Error('missing'),{status:404});},save:async p=>{writes++;project=p;return p;}},target=projectBundleService({data,activeJobs,projects});
 for(const change of [m=>m.version=28,m=>m.project.nodes.find(n=>n.params.cloudBinding).params.cloudBinding.inputs[1].sourceIndex=-1]){
  const m=structuredClone(manifest);change(m);const json=Buffer.from(JSON.stringify(m)),length=Buffer.alloc(4);length.writeUInt32BE(json.length);
  await assert.rejects(target.upload(Readable.from([Buffer.concat([bytes.subarray(0,magic),length,json,bytes.subarray(magic+4+size)])])),/第29版|序号无效/);assert.equal(writes,0);
 }
 const preview=await target.upload(Readable.from([bytes]));await target.importBundle(preview.id);const sink=project.nodes.find(n=>n.id===f.node('sink').id);assert.deepEqual(sink.params.cloudBinding.inputs.map(input=>input.sourceIndex),[undefined,0,3,1,2]);assert.equal(sink.params.cloudBinding.recipeRevision,0);assert.notEqual(sink.params.cloudBinding.recipeId,f.recipe.id);
 const cloudWorkflows=cloudWorkflowService({data,activeJobs,projects}),runner=canvasRunner({data,activeJobs,generation:generationService({data,activeJobs}),cloudWorkflows});assert.equal((await runner.plan(project))[0].nativeInputs.fields.length,4);assert.deepEqual(project.runs,[]);assert.equal(f.state.calls.length,0);
});
