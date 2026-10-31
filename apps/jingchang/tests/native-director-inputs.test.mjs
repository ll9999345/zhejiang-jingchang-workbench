import {planNativeMediaMigration} from '../lib/native-media-migration.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {normalizeNativeWorkflow,nativeToFragment} from '../lib/native-canvas-core.mjs';
import {storeAsset,readJson,records} from '../lib/workspace.mjs';
import {generationService} from '../lib/generation.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';
import {cloudWorkflowService} from '../lib/cloud-workflows.mjs';
import {creationStudioService} from '../lib/creation-studio.mjs';
import {applyCanvasResults} from '../lib/generation-results.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {validateProject} from '../lib/model.mjs';
import {prepareNativeH3,prepareNativeLtx,prepareNativeEnhancement,verifyDirectorInputs} from '../lib/native-director-inputs.mjs';
import {nativeReferencePlan} from '../lib/native-flow-execution.mjs';
import {compileMinimaxH3,minimaxUpstreamRefs} from '../lib/minimax-h3.mjs';
import {normalizeStudioBinding} from '../lib/canvas-studio.mjs';
import {newMinimaxSegment,normalizeMinimaxTimeline,normalizeMinimaxRefs} from '../public/minimax-h3-core.js';
import {normalizeLtxTimeline,ltxDefaults} from '../public/ltx-director-core.js';
import {nativeLoopSettings} from '../public/native-loop-core.js';
import {applyNativeLoopSettings} from '../public/native-loop.js';
import {nativeReferenceChoices,nativeReferenceMarkup} from '../public/native-flow-ui.js';
import {cloudAuthorizationMarkup} from '../public/canvas-cloud.js';
import {sourceIndexFields} from '../public/source-index-core.js';
import {h3Mock,h3Workflow,png,wav} from './helpers/minimax-h3-fixture.mjs';
import {ltxMock,ltxWorkflow} from './helpers/ltx-fixture.mjs';
import {enhanceMock,enhanceWorkflow,enhanceRecipe} from './helpers/image-enhance-fixture.mjs';
import {h3RunningHubMock,h3RunningHubGraph} from './helpers/minimax-runninghub-fixture.mjs';

const h3=()=>normalizeMinimaxTimeline({version:1,segments:[newMinimaxSegment('clip',0,{duration:1,trimOut:1,prompt:''})],selectedSegmentId:'clip',autoUpstream:true});
async function fixture(t,{kind='h3',kinds=['image','image'],count=2,batch=1,loop=true,mode='serial',minimaxSeedDraw}={}){
 const mock=await (kind==='ltx'?ltxMock():kind==='enhance'||kind==='modelscope'?enhanceMock():kind==='rh'?h3RunningHubMock():h3Mock());t.after(mock.close);
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-native-director-')),activeJobs=new Map(),resources=[];
 for(const [index,kind]of kinds.entries()){const a=await storeAsset(data,kind==='audio'?wav():png,{name:'本机合成'+index+(kind==='audio'?'.wav':'.png'),type:kind==='audio'?'audio/wav':'image/png'});resources.push({url:'/synthetic/'+index,archive:'resources/'+index,portableUrl:a.url,asset:a});}
 const source=(id,type,extra={})=>({id,type,x:0,y:0,...extra}),nodes=[source('prompt','smart-prompt',{text:'主题《计数》/《总数》'}),...resources.map((r,index)=>source('media'+index,'smart-image',{images:[r.url]})),source('group','smart-group',{items:resources.map((r,index)=>'media'+index)}),...(loop?[source('loop','smart-loop',{count,loopStart:1,showPrompt:true,variablePrompt:''})]:[]),source('target',kind==='h3'||kind==='rh'?'smart-minimax':kind==='ltx'?'ltxDirector':'comfy',{text:'节点内容'}),source('output','output')],connections=loop?[{from:'prompt',to:'loop'},{from:'group',to:'loop'},{from:'loop',to:'target'}]:[{from:'prompt',to:'target'},{from:'group',to:'target'}];connections.push({from:'target',to:'output'});
 const project=nativeToFragment(normalizeNativeWorkflow({format:'infinite-smart-canvas-workflow',version:1,nodes,connections}),resources,'导演组合本机验收'),node=id=>project.nodes.find(n=>n.params.nativeCanvas.node.id===id),target=node('target'),sourceId=node(loop?'loop':'group').id;
 // This suite also verifies the pre-versioned saved-task and archive contract.
 delete project.settings.nativeMediaVersion;
 if(loop)applyNativeLoopSettings(node('loop'),{...nativeLoopSettings(node('loop')),enabled:true,mode,imageInput:true,imageBatchSize:batch});
 target.type=kind==='enhance'||kind==='modelscope'?'image':'video';target.params.nativeCanvas.adaptation='configured';
 const generation=generationService({data,activeJobs,minimaxSeedDraw}),projects={load:async()=>project,save:async p=>(Object.assign(project,p),project)},cloudWorkflows=cloudWorkflowService({data,activeJobs,projects,pollInterval:10}),creationStudio=creationStudioService({data,activeJobs,pollInterval:10});let template,recipe;
 if(kind==='rh'){
  recipe=await cloudWorkflows.create({projectId:project.id});recipe=await cloudWorkflows.save(recipe.id,{...recipe,name:'合成 RH H3',baseUrl:mock.endpoint,targetId:'2084608321469898754',fields:[],minimaxProfile:'h3',workflowJson:h3RunningHubGraph()});target.params.cloudBinding={recipeId:recipe.id,recipeRevision:recipe.revision,inputs:[],minimaxH3:{...h3(),engine:'runninghub'}};
 }else if(kind==='modelscope')target.params.studioBinding=normalizeStudioBinding({mode:'image',config:{protocol:'modelscope',baseUrl:mock.endpoint+'/v1',model:'synthetic-edit',imageAsync:true,count:1},referenceSources:[{sourceNodeId:sourceId,sourceIndex:0}],imageEnhance:{kind:'enhance',engine:'modelscope'}});
 else{
  template=await generation.saveTemplate({name:'本机合成导演',workflow:kind==='ltx'?ltxWorkflow:kind==='enhance'?enhanceWorkflow:h3Workflow});
  target.params.workflowBinding={workflowId:template.id,overrides:[],imageSources:[],count:1};
  if(kind==='h3')target.params.workflowBinding.minimaxH3=h3();
  if(kind==='ltx')target.params.workflowBinding.ltxDirector=normalizeLtxTimeline({...ltxDefaults,nodeId:'46',durationFrames:24,useCustomAudio:kinds.includes('audio'),segments:[{id:'image',type:'image',start:0,length:24,prompt:'镜头推进',guideStrength:1,sourceNodeId:sourceId,sourceIndex:0}],audioSegments:kinds.includes('audio')?[{id:'audio',type:'audio',start:0,length:24,trimStart:0,sourceNodeId:sourceId,sourceIndex:1}]:[]});
  if(kind==='enhance'){target.params.workflowBinding.imageEnhance=enhanceRecipe();target.params.workflowBinding.imageSources=[{nodeId:'15',name:'image',sourceNodeId:sourceId,sourceIndex:0}];}
 }
 const runner=canvasRunner({data,activeJobs,generation,cloudWorkflows,creationStudio,pollInterval:10,minimaxSeedDraw}),body=async(requestId='director-local')=>{
  const steps=await runner.plan(project);return{revision:0,requestId,consent:true,...(kind==='rh'?{cloudCredentials:steps.map(s=>({nodeId:s.executionId||s.nodeId,apiKey:'synthetic-director-only',authorization:{origin:mock.endpoint,kind:'workflow',targetId:recipe.targetId,requestLimit:1,sendFields:true,sendAssets:s.sendAssets,sendWorkflow:true,budget:1,currency:'CNY'}}))}:kind==='modelscope'?{studioCredentials:steps.map(s=>({nodeId:s.executionId||s.nodeId,apiKey:'synthetic-director-only',authorization:{origin:mock.endpoint,model:'synthetic-edit',sendPrompt:true,sendReferences:s.sendAssets,requestLimit:1,budget:1,currency:'CNY'}}))}:{})};
 };
 validateProject(project);return{...mock,data,activeJobs,project,node,target,sourceId,generation,runner,cloudWorkflows,creationStudio,projects,template,recipe,body,resources};
}
function changedManifest(bytes,change){const offset=Buffer.byteLength('JINGCHANG-PACK-1\n'),size=bytes.readUInt32BE(offset),manifest=JSON.parse(bytes.subarray(offset+4,offset+4+size));change(manifest);const json=Buffer.from(JSON.stringify(manifest)),length=Buffer.alloc(4);length.writeUInt32BE(json.length);return Buffer.concat([bytes.subarray(0,offset),length,json,bytes.subarray(offset+4+size)]);}
async function done(f,id){for(let i=0;i<1500;i++){const job=await readJson(path.join(f.data,'jobs',id+'.json'));if(['completed','cancelled','interrupted'].includes(job.status))return job;await delay(10);}throw Error('合成本机导演任务超时');}
async function idle(f){for(let i=0;i<500&&f.activeJobs.size;i++)await delay(10);assert.equal(f.activeJobs.size,0);}

test('H3 与 LTX 素材序号保存而不静默丢弃，固定素材和错误范围拒绝',()=>{
 const refs=normalizeMinimaxRefs([{kind:'image',sourceNodeId:'group',sourceIndex:0},{kind:'image',sourceNodeId:'group',sourceIndex:1}]);assert.deepEqual(refs.map(r=>r.sourceIndex),[0,1]);assert.throws(()=>normalizeMinimaxRefs([...refs,refs[0]]),/重复/);
 for(const ref of [{assetId:'a',sourceIndex:0},{sourceNodeId:'group',sourceIndex:-1},{sourceNodeId:'group',sourceIndex:1000},{sourceNodeId:'group',sourceIndex:1.5},{url:'https://example.invalid',sourceIndex:0}])assert.throws(()=>sourceIndexFields(ref),/序号/);
 const timeline=normalizeLtxTimeline({...ltxDefaults,nodeId:'46',segments:[{id:'image',type:'image',start:0,length:24,prompt:'',sourceNodeId:'group',sourceIndex:7}],audioSegments:[]});assert.equal(timeline.segments[0].sourceIndex,7);assert.throws(()=>normalizeLtxTimeline({...timeline,segments:[{...timeline.segments[0],assetId:'a',sourceNodeId:undefined}]}),/序号/);
});
test('ModelScope 画布增强的序号归一化不丢失，H3 原生第100轮结果合法',()=>{
 const binding=normalizeStudioBinding({mode:'image',config:{protocol:'modelscope',baseUrl:'http://127.0.0.1:9999/v1',model:'synthetic-edit'},referenceSources:[{sourceNodeId:'group',sourceIndex:2}],imageEnhance:{kind:'enhance',engine:'modelscope'}});assert.equal(binding.referenceSources[0].sourceIndex,2);
 const timeline=h3(),segment=timeline.segments[0];segment.resultAssetIds=['result'];segment.resultVariants=[{assetId:'result',loopId:'native-loop',roundIndex:99,parameters:{prompt:'实测',duration:1,aspectRatio:'16:9',megapixels:.4,seed:1}}];assert.equal(normalizeMinimaxTimeline(timeline).segments[0].resultVariants[0].roundIndex,99);
});
test('H3 自动参考按分组顺序展开，明确选择第二项时不修改原时间轴',async t=>{
 const f=await fixture(t,{loop:false}),before=structuredClone(f.project),prepared=prepareNativeH3(f.project,f.target,h3(),{planning:true,text:'主题'});assert.deepEqual(prepared.timeline.segments[0].refs.map(r=>r.assetId),f.resources.map(r=>r.asset.id));
 const input=h3();input.segments[0].refs=[{kind:'image',sourceNodeId:f.sourceId,sourceIndex:1}];const selected=prepareNativeH3(f.project,f.target,input,{planning:true});assert.deepEqual(selected.timeline.segments[0].refs,[{kind:'image',assetId:f.resources[1].asset.id}]);assert.equal(input.segments[0].refs[0].sourceNodeId,f.sourceId);assert.deepEqual(f.project,before);
});
test('LTX 和增强对混合组使用完整序号，未指定多素材和错类型提前拒绝',async t=>{
 const f=await fixture(t,{kind:'ltx',loop:false,kinds:['image','audio']});const p=prepareNativeLtx(f.project,f.target,f.target.params.workflowBinding.ltxDirector,{planning:true});assert.equal(p.timeline.segments[0].assetId,f.resources[0].asset.id);assert.equal(p.timeline.audioSegments[0].assetId,f.resources[1].asset.id);
 assert.throws(()=>prepareNativeEnhancement(f.project,f.target,{sourceNodeId:f.sourceId},{planning:true}),/明确选择/);assert.throws(()=>prepareNativeEnhancement(f.project,f.target,{sourceNodeId:f.sourceId,sourceIndex:1},{planning:true}),/类型不匹配/);assert.throws(()=>prepareNativeEnhancement(f.project,f.target,{sourceNodeId:f.sourceId,sourceIndex:9},{planning:true}),/不存在/);
});
test('空循环回合不借用祖先参考；智能H3自动选择前9张而不改变原组',async t=>{
 const f=await fixture(t,{count:1});const empty=prepareNativeH3(f.project,f.target,h3(),{planning:true,text:'空回合',loopContexts:{[f.sourceId]:{index:9,total:9}}});assert.deepEqual(empty.timeline.segments[0].refs,[]);assert.equal(empty.timeline.autoUpstream,false);const compiled=compileMinimaxH3(empty.timeline,h3Workflow,{project:f.project,parents:new Set(f.project.nodes.map(n=>n.id)),text:'空回合',upstreamRefs:minimaxUpstreamRefs(f.project,new Set(f.project.nodes.map(n=>n.id)))});assert.equal(compiled.bindings.length,0);
 const many=await fixture(t,{loop:false,kinds:Array(10).fill('image')}),plan=await many.runner.plan(many.project);assert.equal(plan[0].nativeDirectorInputs.details.length,9);assert.equal(many.project.assets.length,10);assert.equal(many.state.submissions.length,0);
});
test('导演来源凭据区分固定文件与指定生成序号，不能消费另一来源的输出',()=>{
 const expected={version:1,kind:'ltx',details:[{slot:'segments:one',originNodeId:'group',sourceNodeId:'producer',kind:'image',pending:true,expectedCount:1,producerIndex:1}]},actual={version:1,kind:'ltx',details:[{slot:'segments:one',originNodeId:'group',assetId:'second',producerNodeId:'producer',kind:'image'}]};
 assert.doesNotThrow(()=>verifyDirectorInputs(expected,actual,[{nodeId:'producer',assetIds:['first','second']}])) ;assert.throws(()=>verifyDirectorInputs(expected,actual,[{nodeId:'other',assetIds:['first','second']}]),/来源不一致/);assert.throws(()=>verifyDirectorInputs(expected,{...actual,details:[{...actual.details[0],assetId:'first'}]},[{nodeId:'producer',assetIds:['first','second']}]),/来源不一致/);
 const fixed={version:1,kind:'h3',details:[{originNodeId:'group',assetId:'one',kind:'image'}]};assert.throws(()=>verifyDirectorInputs(fixed,{version:1,kind:'h3',details:[{originNodeId:'group',assetId:'two',kind:'image'}]}),/来源不一致/);
});
test('创作接口索引展开只发送所选文件，选择完整混合组中的音频保留类型',async t=>{
 const f=await fixture(t,{kind:'ltx',loop:false,kinds:['image','audio']});const plan=nativeReferencePlan(f.project,f.target,[{sourceNodeId:f.sourceId,sourceIndex:1}],{planning:true,consumer:'loop'});assert.deepEqual(plan.references,[{assetId:f.resources[1].asset.id}]);assert.deepEqual(plan.kinds,['audio']);
 const choices=nativeReferenceChoices(f.project,f.target.id,{consumer:'loop'});assert.ok(choices.some(c=>c.value==='node:'+f.sourceId&&c.kinds.includes('audio')&&c.grouped));
});
test('本机 H3 原生循环逐轮上传对应图、使用真实计数并回填全部结果',async t=>{
 const f=await fixture(t),original=structuredClone(f.project),job=await f.runner.start(f.project,await f.body(),f.endpoint),result=await done(f,job.id);assert.equal(result.status,'completed',result.message);assert.equal(f.state.submissions.length,2);assert.equal(f.state.uploads.length,2);assert.deepEqual(result.steps.map(s=>s.resolvedDirectorInputs.map(r=>r.assetId)),f.resources.map(r=>[r.asset.id]));assert.deepEqual(f.state.submissions.map(g=>g['138'].inputs.value),['主题1/2\n\n节点内容','主题2/2\n\n节点内容']);assert.deepEqual(f.project,original);
 const applied=await applyCanvasResults({...f,job:result,revision:0});assert.equal(applied.applied,true);assert.equal(f.target.params.workflowBinding.minimaxH3.segments[0].resultAssetIds.length,2);assert.deepEqual(f.node('output').params.nativeCanvas.mediaAssetIds,result.assets.map(a=>a.id));assert.equal(f.target.params.workflowBinding.minimaxH3.segments[0].resultVariants[1].roundIndex,1);validateProject(f.project);
});
test('两个本机 H3 后端并行停止后只查原任务，已接收任务不再展开上传',async t=>{
 const f=await fixture(t,{mode:'parallel'}),second=await h3Mock();t.after(second.close);f.state.pending=second.state.pending=true;const pool=[f.endpoint,second.endpoint].map((url,index)=>({id:'owned-h3-'+index,name:'本机合成'+index,url,network:'local'})),job=await f.runner.start(f.project,await f.body(),{...pool[0],parallelBackends:pool});
 for(let i=0;i<500;i++){const children=(await records(path.join(f.data,'jobs'))).filter(j=>j.parentId===job.id&&j.kind==='comfy');if(children.length===2&&children.every(j=>j.items[0]?.promptId))break;await delay(10);}assert.equal(f.state.submissions.length+second.state.submissions.length,2);f.activeJobs.get(job.id).controller.abort();const cancelled=await done(f,job.id);await idle(f);assert.equal(cancelled.status,'cancelled');const ids=cancelled.steps.map(s=>s.jobId),uploads=f.state.uploads.length+second.state.uploads.length;f.state.pending=second.state.pending=false;await f.runner.resume(job.id);const resumed=await done(f,job.id);await idle(f);assert.equal(resumed.status,'completed',resumed.message);assert.deepEqual(resumed.steps.map(s=>s.jobId),ids);assert.equal(f.state.submissions.length+second.state.submissions.length,2);assert.equal(f.state.uploads.length+second.state.uploads.length,uploads);assert.deepEqual(resumed.assets.map(a=>a.roundIndex),[0,1]);
});
test('LTX 混合分组在两轮里分别传入本轮图片与音频，工作流线上不泄露镜场编号',async t=>{
 const f=await fixture(t,{kind:'ltx',batch:2,kinds:['image','audio','image','audio']}),original=structuredClone(f.project),job=await f.runner.start(f.project,await f.body(),f.endpoint),result=await done(f,job.id);assert.equal(result.status,'completed',result.message);assert.equal(f.state.submissions.length,2);assert.equal(f.state.uploads.length,4);
 for(const [index,step]of result.steps.entries()){assert.deepEqual(step.resolvedDirectorInputs.map(r=>r.assetId),f.resources.slice(index*2,index*2+2).map(r=>r.asset.id));const v=f.state.submissions[index]['46'].inputs,timeline=JSON.parse(v.timeline_data);assert.match(v.global_prompt,new RegExp('主题'+(index*2+1)+'/3'));for(const ref of [...timeline.segments,...timeline.audioSegments]){assert.equal(ref.sourceIndex,undefined);assert.equal(ref.assetId,undefined);assert.equal(ref.sourceNodeId,undefined);}assert.ok(timeline.segments[0].imageFile);assert.ok(timeline.audioSegments[0].audioFile);}
 assert.deepEqual(f.project,original);assert.deepEqual(result.assets.map(a=>a.roundIndex),[0,1]);
});
test('增强明确选择组内第二张，增强前后追溯对应输入而不是首图',async t=>{
 const f=await fixture(t,{kind:'enhance',loop:false});f.target.params.workflowBinding.imageSources[0].sourceIndex=1;const job=await f.runner.start(f.project,await f.body(),f.endpoint),result=await done(f,job.id);assert.equal(result.status,'completed',result.message);assert.equal(result.assets[0].enhancement.sourceAssetId,f.resources[1].asset.id);assert.equal(result.assets[0].enhancement.originalAssetId,f.resources[1].asset.id);assert.equal(result.steps[0].enhanceSourceId,f.resources[1].asset.id);assert.equal(f.state.uploads.length,1);
});
test('ModelScope 合成本机异步增强同样按组内第二张发送并保存原图关系',async t=>{
 const f=await fixture(t,{kind:'modelscope',loop:false});f.target.params.studioBinding.referenceSources[0].sourceIndex=1;const job=await f.runner.start(f.project,await f.body(),f.endpoint),result=await done(f,job.id);assert.equal(result.status,'completed',result.message);assert.equal(f.state.cloud.length,1);assert.equal(result.assets[0].enhancement.sourceAssetId,f.resources[1].asset.id);const child=await readJson(path.join(f.data,'jobs',result.steps[0].jobId+'.json'));assert.deepEqual(child.input.studio.references,[{assetId:f.resources[1].asset.id}]);
});
test('RunningHub 合成本机 H3 逐轮独立编译参考槽位并保留原始云时间轴',async t=>{
 const f=await fixture(t,{kind:'rh'}),original=structuredClone(f.project),job=await f.runner.start(f.project,await f.body(),f.endpoint),result=await done(f,job.id);assert.equal(result.status,'completed',result.message);assert.equal(f.state.submissions.length,2);assert.equal(f.state.uploads.length,2);assert.deepEqual(result.steps.map(s=>s.resolvedDirectorInputs.map(r=>r.assetId)),f.resources.map(r=>[r.asset.id]));for(const [index,step]of result.steps.entries()){const child=await readJson(path.join(f.data,'jobs',step.jobId+'.json'));assert.equal(child.input.recipe.fields.find(f=>f.type==='image').assetId,f.resources[index].asset.id);assert.match(child.input.recipe.fields.find(f=>f.fieldName==='value'&&f.nodeId==='138').fieldValue,new RegExp('主题'+(index+1)+'/2'));}assert.deepEqual(f.project,original);
});
test('含原生导演组合与索引的备份升为32版，恢复保留索引且不启动任何任务',async t=>{
 const f=await fixture(t,{kind:'ltx',loop:false,kinds:['image','audio']}),bundles=projectBundleService(f),out=await bundles.exportBundle(f.project.id,0);assert.equal(out.formatVersion,32);const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-native-director-import-'));let restored;const projects={load:async()=>{if(restored)return restored;throw Object.assign(Error(),{status:404});},save:async p=>(restored=p)},imports=projectBundleService({data,activeJobs:new Map(),projects});const bytes=await fs.readFile(await bundles.download(out.id));for(const edit of [m=>m.version=31,m=>m.project.nodes.find(n=>n.params?.workflowBinding?.ltxDirector).params.workflowBinding.ltxDirector.segments[0].sourceIndex=1000]){await assert.rejects(imports.upload(Readable.from([changedManifest(bytes,edit)])),/第32版|序号/);assert.equal(restored,undefined);}const preview=await imports.upload(createReadStream(await bundles.download(out.id)));assert.equal(preview.formatVersion,32);const next=await imports.importBundle(preview.id),timeline=next.nodes.find(n=>n.params?.workflowBinding?.ltxDirector).params.workflowBinding.ltxDirector;assert.deepEqual([timeline.segments[0].sourceIndex,timeline.audioSegments[0].sourceIndex],[0,1]);assert.equal((await records(path.join(data,'jobs'))).length,0);assert.equal(f.state.submissions.length,0);validateProject(next);
});
test('用户改动时间轴后回填独立结果，旧 H3 执行不会覆盖新参数或分组',async t=>{
 const f=await fixture(t),job=await f.runner.start(f.project,await f.body(),f.endpoint),result=await done(f,job.id);f.target.params.workflowBinding.minimaxH3.segments[0].prompt='用户已改新提示词';const before=structuredClone(f.target.params.workflowBinding.minimaxH3),group=structuredClone(f.node('group'));await applyCanvasResults({...f,job:result,revision:0});assert.deepEqual(f.target.params.workflowBinding.minimaxH3,before);assert.deepEqual(f.node('group'),group);assert.ok(f.project.nodes.some(n=>n.assetId===result.assets[0].id));
});

async function bindUpstream(f,count=2){
 const source=f.node('media0'),template=await f.generation.saveTemplate({name:'本机前置生成',workflow:{'text':{class_type:'CLIPTextEncode',inputs:{text:'合成输入'}},'out':{class_type:'SaveImage',inputs:{images:['text',0]}}}});
 source.params.nativeCanvas.node.type='comfy';source.params.nativeCanvas.adaptation='configured';source.params.workflowBinding={workflowId:template.id,overrides:[],imageSources:[],...(count>8?{promptBatch:{nodeId:'text',name:'text',values:Array.from({length:count},(_,i)=>'合成输入'+i)}}:{count})};return source;
}
test('H3 静态与待生成混合分组规划全部数量，完整输出替换旧预览并按序发送',async t=>{
 const f=await fixture(t,{loop:false}),source=await bindUpstream(f),plan=await f.runner.plan(f.project);assert.equal(plan[1].nativeDirectorInputs.details.length,3);assert.deepEqual(plan[1].nativeDirectorInputs.details.filter(r=>r.pending).map(r=>r.producerIndex),[0,1]);
 const job=await f.runner.start(f.project,await f.body(),f.endpoint),result=await done(f,job.id);assert.equal(result.status,'completed',result.message);assert.equal(f.state.submissions.length,3);assert.equal(f.state.uploads.length,3);const generated=result.assets.filter(a=>a.sourceNodeId===source.id).map(a=>a.id);assert.equal(generated.length,2);assert.deepEqual(result.steps[1].resolvedDirectorInputs.map(r=>r.assetId),[...generated,f.resources[1].asset.id]);assert.ok(!result.steps[1].resolvedDirectorInputs.some(r=>r.assetId===f.resources[0].asset.id));
});
test('H3 实际生成数量超出确认范围时保留上游结果并在上传或生成前停下',async t=>{
 const f=await fixture(t,{loop:false});await bindUpstream(f,1);f.state.imageOutputs=2;const job=await f.runner.start(f.project,await f.body(),f.endpoint),result=await done(f,job.id);assert.equal(result.status,'interrupted');assert.match(result.message,/数量或生成来源不一致/);assert.equal(f.state.submissions.length,1);assert.equal(f.state.uploads.length,0);assert.equal(result.assets.length,2);assert.equal(result.steps[1].jobId,undefined);
});
test('LTX 待生成组里第二张图片按生产者序号传递，后面的音频仍用完整组序号',async t=>{
 const f=await fixture(t,{kind:'ltx',loop:false,kinds:['image','audio']}),source=await bindUpstream(f,2),timeline=f.target.params.workflowBinding.ltxDirector;timeline.segments[0].sourceIndex=1;timeline.audioSegments[0].sourceIndex=2;
 const plan=await f.runner.plan(f.project);assert.equal(plan[1].nativeDirectorInputs.details[0].producerIndex,1);const job=await f.runner.start(f.project,await f.body(),f.endpoint),result=await done(f,job.id);assert.equal(result.status,'completed',result.message);const generated=result.assets.filter(a=>a.sourceNodeId===source.id);assert.equal(result.steps[1].resolvedDirectorInputs[0].assetId,generated[1].id);assert.equal(result.steps[1].resolvedDirectorInputs[1].assetId,f.resources[1].asset.id);assert.equal(f.state.submissions.length,3);
});
test('H3 RunningHub 原生并行任务停止后恢复原编号，参考素材不会再次上传',async t=>{
 const f=await fixture(t,{kind:'rh',mode:'parallel'});f.state.pending=true;const job=await f.runner.start(f.project,await f.body(),f.endpoint);
 for(let i=0;i<500;i++){const children=(await records(path.join(f.data,'jobs'))).filter(j=>j.parentJobId===job.id&&j.kind==='runninghub');if(children.length===2&&children.every(j=>j.upstreamId))break;await delay(10);}assert.equal(f.state.submissions.length,2);f.activeJobs.get(job.id).controller.abort();const cancelled=await done(f,job.id);await idle(f);assert.equal(cancelled.status,'cancelled');const ids=cancelled.steps.map(s=>s.jobId),uploads=f.state.uploads.length;f.state.pending=false;await f.runner.resume(job.id,await f.body('rh-resume'));const result=await done(f,job.id);await idle(f);assert.equal(result.status,'completed',result.message);assert.deepEqual(result.steps.map(s=>s.jobId),ids);assert.equal(f.state.submissions.length,2);assert.equal(f.state.uploads.length,uploads);
});

test('原生父任务的第65轮种子偏移可执行；独立请求仍限制旧范围',async t=>{
 const f=await fixture(t,{count:1,kinds:[]}),body={workflowId:f.template.id,overrides:[],minimaxH3:h3(),minimaxText:'高轮次合成',nodeId:f.target.id,count:1,seedOffset:64,incrementSeeds:true};
 await assert.rejects(f.generation.start(f.project,body,f.endpoint,{nativeFlow:true}),/0–63/);assert.equal(f.state.submissions.length,0);
 const parentId='owned-high-round-parent';f.activeJobs.set(parentId,{projectId:f.project.id,kind:'canvas-run',controller:new AbortController()});
 try{const job=await f.generation.start(f.project,{...body,requestId:'owned-high-round'},f.endpoint,{nativeFlow:true,parentId}),result=await done(f,job.id);assert.equal(result.status,'completed',result.message);assert.equal(f.state.submissions[0]['129'].inputs.noise_seed,65);assert.equal(result.parentId,parentId);}finally{f.activeJobs.delete(parentId);}
});

test('H3 发送清单来自真实计划，显示静态文件和对应待生成序号并转义名称',async t=>{
 const f=await fixture(t,{loop:false}),source=await bindUpstream(f);source.title='<img src=x onerror=bad()>上游';const plan=await f.runner.plan(f.project),markup=nativeReferenceMarkup(plan[1]);assert.match(markup,/最多 3 份/);assert.match(markup,/上游第1份/);assert.match(markup,/上游第2份/);assert.ok(markup.includes(f.resources[1].asset.name));assert.ok(markup.includes('&lt;img'));assert.ok(!markup.includes('<img'));assert.equal(f.state.submissions.length,0);
});
test('LTX 发送清单仅展示输出范围内的媒体，关闭的音频不误列为待发送',async t=>{
 const f=await fixture(t,{kind:'ltx',loop:false,kinds:['image','audio']}),timeline=f.target.params.workflowBinding.ltxDirector;timeline.useCustomAudio=false;timeline.segments.push({...timeline.segments[0],id:'outside',start:24,length:24});const step=(await f.runner.plan(f.project))[0],markup=nativeReferenceMarkup(step);assert.equal(step.nativeDirectorInputs.details.length,3);assert.match(markup,/最多 1 份/);assert.ok(markup.includes(f.resources[0].asset.name));assert.ok(!markup.includes(f.resources[1].asset.name));assert.equal(f.state.submissions.length,0);
});

test('RunningHub H3 授权面板接入实际发送清单，恢复已接收任务不显示重新发送清单',async t=>{
 const f=await fixture(t,{kind:'rh',loop:false}),step=(await f.runner.plan(f.project))[0],esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),markup=cloudAuthorizationMarkup([step],esc);assert.match(markup,/最多 2 份/);for(const r of f.resources)assert.ok(markup.includes(r.asset.name));assert.match(markup,/cloud-consent/);assert.equal(f.state.submissions.length,0);
 const resumed=cloudAuthorizationMarkup([{...step,jobId:'accepted-owned',authorization:{budget:1,currency:'CNY'}}],esc,true);assert.ok(!resumed.includes('本次整组参考发送清单'));assert.match(resumed,/只查询/);
});

test('H3 自动参考去重相互重叠的分组与直连，手动整组引用仍严格拒绝',async t=>{
 const f=await fixture(t,{loop:false});f.project.edges.push({id:'overlap-direct',source:f.node('media0').id,target:f.target.id});
 const prepared=prepareNativeH3(f.project,f.target,h3(),{planning:true});assert.equal(prepared.ledger.version,2);assert.equal(prepared.ledger.automatic.duplicates,1);assert.deepEqual(prepared.timeline.segments[0].refs.map(r=>r.assetId),f.resources.map(r=>r.asset.id));
 assert.throws(()=>nativeReferencePlan(f.project,f.target,[{sourceNodeId:f.sourceId},{sourceNodeId:f.node('media0').id}],{planning:true,consumer:'loop'}),/重复素材/);
 assert.throws(()=>prepareNativeH3(f.project,f.target,h3(),{planning:true,h3Automatic:false}),/重复素材/);
});
test('智能 H3 自动素材按类型去重并取前9图3音频，原分组与时间轴不修改',async t=>{
 const f=await fixture(t,{loop:false,kinds:[...Array(12).fill('image'),...Array(5).fill('audio')]}),before=structuredClone(f.project),prepared=prepareNativeH3(f.project,f.target,h3(),{planning:true,text:'自动参考'}),refs=prepared.timeline.segments[0].refs;
 assert.deepEqual(refs.filter(r=>r.kind==='image').map(r=>r.assetId),f.resources.slice(0,9).map(r=>r.asset.id));assert.deepEqual(refs.filter(r=>r.kind==='audio').map(r=>r.assetId),f.resources.slice(12,15).map(r=>r.asset.id));assert.equal(prepared.ledger.automatic.excluded,5);assert.deepEqual(f.project,before);
 const input=h3();input.segments[0].refs=f.resources.slice(0,10).map(r=>({kind:'image',assetId:r.asset.id}));assert.throws(()=>prepareNativeH3(f.project,f.target,input,{planning:true}),/超过9/);
});
test('普通 H3 先取前15份而不冒充智能按类型裁切，超9图仍预检拒绝',async t=>{
 const f=await fixture(t,{loop:false,kinds:Array(17).fill('image')});f.target.params.nativeCanvas.node.type='minimax';assert.throws(()=>prepareNativeH3(f.project,f.target,h3(),{planning:true}),/超过9/);
});
test('H3 自动忽略非媒体文件，手动引用同一文件仍拒绝',async t=>{
 const f=await fixture(t,{loop:false}),extra=await storeAsset(f.data,Buffer.from('本机独立说明'),{name:'说明.txt',type:'text/plain'});f.project.assets.push(extra);
 const source={id:'own-text-file',type:'text',title:'纯文字文件',text:'',x:0,y:0,assetId:extra.id,params:{}};f.project.nodes.push(source);f.project.edges.push({id:'own-text-edge',source:source.id,target:f.target.id});
 const prepared=prepareNativeH3(f.project,f.target,h3(),{planning:true});assert.deepEqual(prepared.timeline.segments[0].refs.map(r=>r.assetId),f.resources.map(r=>r.asset.id));
 assert.throws(()=>nativeReferencePlan(f.project,f.target,[{assetId:extra.id}],{planning:true,consumer:'loop'}),/图片、视频或音频/);
});
test('H3 自动候选覆盖未选生成结果，返回数量超范围不能被前9裁切隐藏',async t=>{
 const f=await fixture(t,{loop:false}),source=await bindUpstream(f,9),planned=prepareNativeH3(f.project,f.target,h3(),{planning:true});assert.equal(planned.ledger.details.length,9);
 const generated=[];for(let i=0;i<10;i++){const a=await storeAsset(f.data,png,{name:'自动候选'+i+'.png',type:'image/png'});f.project.assets.push(a);generated.push(a.id);}
 const outputs=[{nodeId:source.id,assetIds:generated,promptItems:[]}],actual=prepareNativeH3(f.project,f.target,h3(),{outputs});assert.equal(actual.ledger.details.length,9);assert.throws(()=>verifyDirectorInputs(planned.ledger,actual.ledger,outputs),/数量或生成来源不一致/);assert.equal(f.state.submissions.length,0);
});
test('动态数量减少不允许把未确认的后续静态图片补入发送范围',async t=>{
 const f=await fixture(t,{loop:false}),source=await bindUpstream(f,10),planned=prepareNativeH3(f.project,f.target,h3(),{planning:true}),generated=[];
 for(let i=0;i<3;i++){const a=await storeAsset(f.data,png,{name:'已完成'+i+'.png',type:'image/png'});f.project.assets.push(a);generated.push(a.id);}
 const outputs=[{nodeId:source.id,assetIds:generated,promptItems:[]}],actual=prepareNativeH3(f.project,f.target,h3(),{outputs});assert.ok(actual.ledger.details.some(r=>r.assetId===f.resources[1].asset.id));assert.throws(()=>verifyDirectorInputs(planned.ledger,actual.ledger,outputs),/数量或生成来源不一致/);
});
test('智能 H3 实际执行仅上传前9张自动参考并保留全部上游结果',async t=>{
 const f=await fixture(t,{loop:false}),source=await bindUpstream(f,12),job=await f.runner.start(f.project,await f.body(),f.endpoint),result=await done(f,job.id);assert.equal(result.status,'completed',result.message);assert.equal(f.state.submissions.length,13);assert.equal(f.state.uploads.length,9);assert.equal(result.assets.filter(a=>a.sourceNodeId===source.id).length,12);assert.equal(result.steps[1].resolvedDirectorInputs.length,9);
});

test('原生H3串行与并行每个新请求独立选择种子，编辑片段保持，结果记录实际图参数',async t=>{
 for(const mode of ['serial','parallel']){
  let draws=0;const f=await fixture(t,{mode,minimaxSeedDraw:()=>1000+draws++}),h=f.target.params.workflowBinding.minimaxH3;h.segments[0].seedMode='random';const before=structuredClone(h);
  await f.runner.plan(f.project);assert.equal(draws,0);const job=await f.runner.start(f.project,await f.body('native-random-'+mode),f.endpoint),result=await done(f,job.id);await idle(f);assert.equal(result.status,'completed',result.message);assert.equal(draws,2);
  assert.deepEqual(result.steps.map(s=>s.minimaxSeed.seed).sort(),[1000,1001]);assert.deepEqual(f.state.submissions.map(g=>g['129'].inputs.noise_seed).sort(),[1000,1001]);assert.deepEqual(result.assets.map(a=>a.minimaxParameters.seed).sort(),[1000,1001]);assert.deepEqual(h,before);
  await applyCanvasResults({...f,job:result,revision:0});assert.equal(h.segments[0].seedMode,'random');assert.equal(h.segments[0].seed,before.segments[0].seed);assert.deepEqual(h.segments[0].resultVariants.map(r=>r.parameters.seed).sort(),[1000,1001]);
 }
});

test('智能H3按类型全局优先时，未继承的图片不算自动发送候选或截取数量',async t=>{
 const f=await fixture(t,{loop:false,kinds:[...Array(12).fill('image'),'audio']}),h=f.target.params.workflowBinding.minimaxH3;h.fallbackByKind=true;h.refs=[{kind:'image',assetId:f.resources[0].asset.id}];
 const prepared=prepareNativeH3(f.project,f.target,h,{planning:true,text:'合成'});assert.deepEqual(prepared.ledger.details.map(r=>r.kind),['image','audio']);assert.deepEqual(prepared.ledger.automatic.candidates.map(r=>r.kind),['audio']);assert.equal(prepared.ledger.automatic.excluded,0);assert.equal(prepared.ledger.automatic.details.length,1);
});

test('旧版简单原生H3固定时间轴仍可用原备份格式，不因新执行选择器升级而拒绝',async t=>{
 const f=await fixture(t,{loop:false,kinds:[]}),h=f.target.params.workflowBinding.minimaxH3;h.autoUpstream=false;h.segments[0].prompt='固定片段';f.project.nodes=[f.target];f.project.edges=[];f.target.params.nativeCanvas.inputOrder=[];
 const bundle=projectBundleService(f),out=await bundle.exportBundle(f.project.id,0),preview=await bundle.upload(createReadStream(await bundle.download(out.id)));assert.equal(preview.formatVersion,24);assert.equal(f.state.submissions.length,0);
});

test('RunningHub显式随机设置随真实字段与整图提交，停止继续不重选种子或重复上传',async t=>{
 let draws=0;const f=await fixture(t,{kind:'rh',mode:'parallel',minimaxSeedDraw:()=>1100+draws++});f.target.params.cloudBinding.minimaxH3.segments[0].seedMode='random';f.state.pending=true;
 const job=await f.runner.start(f.project,await f.body('rh-random-once'),f.endpoint);
 for(let i=0;i<500;i++){const children=(await records(path.join(f.data,'jobs'))).filter(j=>j.parentJobId===job.id&&j.kind==='runninghub');if(children.length===2&&children.every(j=>j.upstreamId))break;await delay(10);}
 assert.equal(draws,2);assert.equal(f.state.submissions.length,2);const submitted=f.state.submissions.map(b=>JSON.parse(b.workflow)['129'].inputs.noise_seed).sort();assert.deepEqual(submitted,[1100,1101]);
 f.activeJobs.get(job.id).controller.abort();const paused=await done(f,job.id);await idle(f);const ids=paused.steps.map(s=>s.jobId),uploads=f.state.uploads.length;f.state.pending=false;
 const runner=canvasRunner({...f,pollInterval:10,minimaxSeedDraw:()=>assert.fail('RH recovery must not draw')});await runner.resume(job.id,await f.body('rh-random-resume'));const result=await done(f,job.id);await idle(f);assert.equal(result.status,'completed',result.message);assert.deepEqual(result.steps.map(s=>s.jobId),ids);assert.equal(f.state.submissions.length,2);assert.equal(f.state.uploads.length,uploads);assert.deepEqual(result.assets.map(a=>a.minimaxParameters.seed).sort(),submitted);
});

for(const kind of ['h3','ltx','enhance'])test(`逐轮${kind}经过待生成切片仍实际取原生产者第2张，不把切片第1项重编号`,async t=>{
 const f=await fixture(t,{kind,count:1,batch:1}),source=await bindUpstream(f,3),loop=f.node('loop');applyNativeLoopSettings(loop,{...nativeLoopSettings(loop),start:2,count:1});const plan=await f.runner.plan(f.project),step=plan.find(s=>s.nodeId===f.target.id);assert.equal(step.nativeDirectorInputs.details[0].producerIndex,1);const before=structuredClone(f.project),job=await f.runner.start(f.project,await f.body(),f.endpoint),result=await done(f,job.id);assert.equal(result.status,'completed',result.message);const generated=result.assets.filter(a=>a.sourceNodeId===source.id);assert.equal(generated.length,3);const actual=result.steps.find(s=>s.nodeId===f.target.id);assert.equal(actual.resolvedDirectorInputs[0].assetId,generated[1].id);assert.equal(f.state.uploads.length,1);assert.deepEqual(f.project,before);await fs.mkdir(path.resolve('artifacts/native-round-media-1792824546958'),{recursive:true});await fs.writeFile(path.resolve('artifacts/native-round-media-1792824546958/director-'+kind+'-result.json'),JSON.stringify({ok:true,kind,producerOutputs:3,selectedProducerIndex:1,actualSelectedAssetId:generated[1].id,paidCalls:0,thirdPartyUploads:0,modelCalls:0,scope:'Owned loopback protocol fixture; no AI model or GPU'},null,2));
});

for(const kind of ['h3','ltx','enhance'])test(`逐轮差异映射${kind}的第8/7格实际使用同一原图，结果回填保持原时间轴输入`,async t=>{
 const f=await fixture(t,{kind,count:2,batch:2}),source=await bindUpstream(f,3),group=f.node('group'),right=f.node('media1'),loop=f.node('loop');source.params.nativeCanvas.node.type='smart-image';source.params.nativeCanvas.node.runSettings={engine:'comfy'};source.x=100;right.x=500;source.y=right.y=0;group.params.nativeCanvas.members=[{sourceNodeId:right.id},{sourceNodeId:loop.id},{sourceNodeId:source.id}];group.params.nativeCanvas.node.items=['media1','loop','media0'];group.params.nativeCanvas.node.images=f.resources.map(r=>({url:r.portableUrl}));group.params.nativeCanvas.resources=f.resources.map(r=>({url:r.portableUrl,archive:r.archive,assetId:r.asset.id}));group.params.nativeCanvas.mediaAssetIds=f.resources.map(r=>r.asset.id);f.project.edges=f.project.edges.filter(e=>!(e.source===group.id&&e.target===loop.id)&&!(e.source===loop.id&&e.target===f.target.id));f.project.edges.push({id:'source-loop-map',source:source.id,target:loop.id},{id:'group-target-map',source:group.id,target:f.target.id});
 if(kind==='h3'){const h=f.target.params.workflowBinding.minimaxH3;h.autoUpstream=false;h.refs=[{kind:'image',sourceNodeId:group.id,sourceIndex:0}];h.segments[0].prompt='保留原图镜头';}
 else if(kind==='ltx'){f.target.params.workflowBinding.ltxDirector.segments[0].sourceNodeId=group.id;f.target.params.workflowBinding.ltxDirector.segments[0].sourceIndex=0;}
 else f.target.params.workflowBinding.imageSources[0].sourceNodeId=group.id;
 const plan=planNativeMediaMigration(f.project,{mode:'node',nodeId:f.target.id,selection:'preserve',requestId:'owned-mapped-'+kind,revision:0});assert(plan.canApply,plan.effects.blocked.join('；'));const target=plan.project.nodes.find(n=>n.id===f.target.id);assert.deepEqual(target.params.nativeMediaMap.fields[0].rounds.map(r=>r.sourceIndex),[7,6]);const before=structuredClone(plan.project),job=await f.runner.start(plan.project,await f.body(),f.endpoint),result=await done(f,job.id);assert.equal(result.status,'completed',result.message);const steps=result.steps.filter(s=>s.nodeId===f.target.id);assert.equal(steps.length,2);assert(steps.every(s=>s.resolvedDirectorInputs[0].assetId===f.resources[1].asset.id));assert.equal(f.state.uploads.length,2);assert.deepEqual(plan.project,before);await applyCanvasResults({...f,project:plan.project,job:result,revision:0});assert.deepEqual(target.params.nativeMediaMap,before.nodes.find(n=>n.id===f.target.id).params.nativeMediaMap);if(kind==='h3'){assert.equal(target.params.workflowBinding.minimaxH3.refs[0].sourceIndex,7);assert.equal(target.params.workflowBinding.minimaxH3.segments[0].resultAssetIds.length,2);}await fs.mkdir(path.resolve('artifacts/native-round-map-1792827750299'),{recursive:true});await fs.writeFile(path.resolve('artifacts/native-round-map-1792827750299/'+kind+'-actual-result.json'),JSON.stringify({ok:true,kind,rounds:2,savedIndices:[7,6],sameOriginalAssetId:f.resources[1].asset.id,applyPreservesMap:true,paidCalls:0,thirdPartyUploads:0,modelCalls:0,scope:'Owned loopback protocol fixture; no model or GPU'},null,2));
});
