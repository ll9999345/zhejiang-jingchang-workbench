import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeLoopFixture,waitLoop,idleLoop,chatText} from './helpers/native-loop-fixture.mjs';
import {applyCanvasResults} from '../lib/generation-results.mjs';
import {nativeFlowService} from '../lib/native-flow-service.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';
import {generationService} from '../lib/generation.mjs';
import {records,readJson} from '../lib/workspace.mjs';
import {validateProject} from '../lib/model.mjs';
import {nativeLoopSettings} from '../public/native-loop-core.js';
import {applyNativeLoopSettings} from '../public/native-loop.js';
import {taskPresentation,visibleTaskJobs} from '../public/task-state-core.js';

test('串行普通循环按计数替换上游，循环内两步使用各自当轮结果，回填收集全部轮次',async t=>{
 const f=await nativeLoopFixture(t,{stages:2}),original=structuredClone(f.project),steps=await f.runner.plan(f.project);assert.equal(steps.length,6);assert.deepEqual(steps.filter(s=>s.nodeId===f.node('generate0').id).map(s=>s.text),['上游2/4\n\n节点0','上游3/4\n\n节点0','上游4/4\n\n节点0']);
 f.node('generate1').params.workflowBinding.imageSources=[{nodeId:'3',name:'image',sourceNodeId:f.node('generate0').id,sourceIndex:0}];const job=await f.runner.start(f.project,await f.body(),f.endpoint),done=await waitLoop(f,job.id);assert.equal(done.status,'completed',done.message);assert.equal(f.state.prompts.length,6);assert.equal(f.state.uploads.length,3);assert.equal(f.state.maxActive,1);assert.deepEqual(done.assets.map(a=>a.roundIndex),[0,0,1,1,2,2]);assert.deepEqual(f.project,originalWithBinding(original,f));
 const output=f.node('output'),applied=await applyCanvasResults({...f,job:done,revision:0});assert.equal(applied.applied,true);assert.deepEqual(output.params.nativeCanvas.mediaAssetIds,done.assets.filter(a=>a.sourceNodeId===f.node('generate1').id).map(a=>a.id));assert.deepEqual(f.loop.params.nativeCanvas.node,original.nodes.find(n=>n.id===f.loop.id).params.nativeCanvas.node);validateProject(f.project);
 const inspection=await nativeFlowService(f).inspect(f.project,{nodeId:f.loop.id,jobId:job.id,loopId:f.loop.id,roundIndex:2});assert.deepEqual(inspection.nodes[0].promptItems,['上游4/4']);
});
function originalWithBinding(original,f){const p=structuredClone(original);p.nodes.find(n=>n.id===f.node('generate1').id).params.workflowBinding.imageSources=structuredClone(f.node('generate1').params.workflowBinding.imageSources);return p;}

test('并行 ComfyUI 用两个已选后端，完成顺序不改变结果轮次，恢复仍记录各轮地址',async t=>{
 const f=await nativeLoopFixture(t,{mode:'parallel',count:4,start:1});f.state.delayMs=40;const job=await f.runner.start(f.project,await f.body(),{...f.pool[0],parallelBackends:f.pool}),done=await waitLoop(f,job.id);assert.equal(done.status,'completed',done.message);assert.equal(f.state.maxActive,2);assert.deepEqual(new Set(f.state.prompts.map(p=>p.backend)),new Set([0,1]));assert.deepEqual(done.assets.map(a=>a.roundIndex),[0,1,2,3]);assert.equal(new Set(done.steps.map(s=>s.nativeBackend.url)).size,2);assert.deepEqual(done.loopBackends,f.pool);assert.equal(f.state.prompts.length,4);
});
test('循环父任务岛按真正完成步骤计数，取消保留进度，六个子任务不重复占位',()=>{
 const parent={id:'parallel-parent',projectId:'local-project',kind:'canvas-run',status:'running',steps:Array.from({length:100},(_,index)=>({status:index<7?'completed':index<13?'running':'pending',nativeLoop:{mode:'parallel'}})),progress:92},children=Array.from({length:6},(_,index)=>({id:'child-'+index,projectId:parent.projectId,kind:'canvas-llm',status:'running',parentId:parent.id,progress:99}));
 assert.deepEqual(taskPresentation(parent).progress,{value:7,total:100,unit:'步',ratio:.07});assert.deepEqual(visibleTaskJobs([parent,...children]).map(j=>j.id),[parent.id]);const stopped=taskPresentation({...parent,status:'cancelled'});assert.equal(stopped.label,'已停止');assert.deepEqual(stopped.progress,taskPresentation(parent).progress);assert.equal(stopped.active,false);
});
test('并行本机语言模型支持六轮，各轮下游只取对应完整文字，零跨轮拼接',async t=>{
 const f=await nativeLoopFixture(t,{chat:true,imageApi:true,mode:'parallel',count:7,start:1});f.state.delayMs=25;const job=await f.runner.start(f.project,await f.body(),f.endpoint),done=await waitLoop(f,job.id);assert.equal(done.status,'completed',done.message);assert.equal(f.state.chats.length,7);assert.ok(f.state.maxActive>=2);assert.ok(f.state.maxActive<=6);assert.deepEqual(done.textResults.map(r=>r.roundIndex),[0,1,2,3,4,5,6]);
 for(const step of done.steps.filter(s=>s.kind==='image-api')){const result=done.textResults.find(r=>r.roundIndex===step.roundIndex);assert.equal(step.text,result.text+'\n\n节点0');assert.match(step.text,new RegExp('上游'+step.nativeLoop.index+'/7'));assert.equal((step.text.match(/已改写/g)||[]).length,1);}assert.ok(f.state.chats.every(c=>chatText(c).endsWith('每轮指令')));
});
test('无 ComfyUI 的图片接口循环也允许所属父任务的兄弟子任务并行，独立运行仍受阻',async t=>{
 const f=await nativeLoopFixture(t,{imageApi:true,mode:'parallel',count:4,start:1});f.state.delayMs=40;const job=await f.runner.start(f.project,await f.body(),f.endpoint),done=await waitLoop(f,job.id);assert.equal(done.status,'completed',done.message);assert.equal(f.state.images.length,4);assert.ok(f.state.maxActive>=2);assert.deepEqual(done.assets.map(a=>a.roundIndex),[0,1,2,3]);
});
test('普通并行循环存在 ComfyUI 时单后端限一轮，其他项目活动不能冒充所属子任务',async t=>{
 const f=await nativeLoopFixture(t,{mode:'parallel'});f.state.delayMs=15;const job=await f.runner.start(f.project,await f.body(),f.endpoint),done=await waitLoop(f,job.id);assert.equal(done.status,'completed',done.message);assert.equal(f.state.maxActive,1);await idleLoop(f);f.activeJobs.set('unrelated',{controller:new AbortController(),kind:'image-api',projectId:f.project.id});await assert.rejects(f.runner.start(f.project,await f.body('another-start'),f.endpoint),/已有运行任务/);f.activeJobs.clear();
});
test('取消两后端并行保留已接收 promptId，刷新服务后继续查询不重复提交',async t=>{
 const f=await nativeLoopFixture(t,{mode:'parallel',count:2,start:1});f.state.hold=true;const job=await f.runner.start(f.project,await f.body(),{...f.pool[0],parallelBackends:f.pool});for(let i=0;i<300&&f.state.prompts.length<2;i++)await delay(10);assert.equal(f.state.prompts.length,2);for(let i=0;i<300;i++){const children=(await records(path.join(f.data,'jobs'))).filter(j=>j.parentId===job.id&&j.kind==='comfy');if(children.length===2&&children.every(j=>j.items[0]?.promptId))break;await delay(10);}f.activeJobs.get(job.id).controller.abort();const cancelled=await waitLoop(f,job.id);await idleLoop(f);assert.equal(cancelled.status,'cancelled');assert.ok(cancelled.steps.every(s=>s.jobId));const ids=cancelled.steps.map(s=>s.jobId);for(const id of ids)assert.ok((await readJson(path.join(f.data,'jobs',id+'.json'))).items[0].promptId);
 f.state.hold=false;const generation=generationService(f),runner=canvasRunner({...f,generation,pollInterval:10});await runner.resume(job.id);const resumed=await waitLoop(f,job.id);await idleLoop(f);assert.equal(resumed.status,'completed',resumed.message);assert.deepEqual(resumed.steps.map(s=>s.jobId),ids);assert.equal(f.state.prompts.length,2);assert.deepEqual(resumed.steps.map(s=>s.nativeBackend.url),cancelled.steps.map(s=>s.nativeBackend.url));
});
test('未完整语言模型回答停止同轮下游，恢复原同步请求不自动重发',async t=>{
 const f=await nativeLoopFixture(t,{chat:true,count:2});f.state.finish='length';const job=await f.runner.start(f.project,await f.body(),f.endpoint),done=await waitLoop(f,job.id);await idleLoop(f);assert.equal(done.status,'interrupted');assert.equal(f.state.chats.length,1);assert.equal(f.state.prompts.length,0);assert.equal(done.textResults.length,0);assert.ok(done.steps[0].outputText);
 const body=await f.body('unused');body.llmCredentials=body.llmCredentials.filter(item=>item.nodeId===done.steps.find(s=>s.kind==='canvas-llm'&&s.roundIndex===1).executionId);await f.runner.resume(job.id,body);const repeated=await waitLoop(f,job.id);await idleLoop(f);assert.equal(repeated.status,'interrupted');assert.equal(f.state.chats.length,1);assert.equal(f.state.prompts.length,0);assert.equal(repeated.steps[0].jobId,done.steps[0].jobId);
});
test('循环外动态生成只运行一次；各回合选择对应输出而非上轮预览',async t=>{
 const f=await nativeLoopFixture(t,{upstream:true,count:2,start:1,batch:2});f.comfy(f.node('generate0'),{reference:true});const plan=await f.runner.plan(f.project);assert.equal(plan.length,3);assert.equal(plan[0].loopId,undefined);const job=await f.runner.start(f.project,await f.body(),f.endpoint),done=await waitLoop(f,job.id);assert.equal(done.status,'completed',done.message);assert.equal(f.state.prompts.length,6);assert.equal(f.state.uploads.length,2);assert.deepEqual(done.steps.filter(s=>s.nativeLoop).map(s=>s.nativeLoop.index),[1,3]);assert.equal(done.assets.filter(a=>!a.loopId).length,4);assert.equal(f.state.prompts[0].body.prompt['1'].inputs.text,'循环外只运行一次');
});
test('回填时用户改动过接收器或上游循环配置，旧结果仍独立保留而不覆盖节点',async t=>{
 const f=await nativeLoopFixture(t),job=await f.runner.start(f.project,await f.body(),f.endpoint),done=await waitLoop(f,job.id);applyNativeLoopSettings(f.loop,{...nativeLoopSettings(f.loop),count:4,variablePrompt:'用户新参数'});const outputBefore=structuredClone(f.node('output')),loopBefore=structuredClone(f.loop);const result=await applyCanvasResults({...f,job:done,revision:0});assert.equal(result.applied,true);assert.deepEqual(f.node('output'),outputBefore);assert.deepEqual(f.loop,loopBefore);assert.ok(f.project.nodes.some(n=>n.assetId===done.assets[0].id));
});

test('RunningHub 并行每轮仅发送对应素材，恢复已接收任务不重复上传或提交',async t=>{
 const f=await nativeLoopFixture(t,{count:3,start:1,media:3,mode:'parallel'});Object.assign(f,await f.useCloud({reference:true}));f.state.hold=true;const job=await f.runner.start(f.project,await f.body(),f.endpoint);
 for(let i=0;i<300;i++){const children=(await records(path.join(f.data,'jobs'))).filter(j=>j.parentJobId===job.id);if(children.length===3&&children.every(j=>j.upstreamId))break;await delay(10);}assert.equal(f.state.rhCreates.length,3);f.activeJobs.get(job.id).controller.abort();const cancelled=await waitLoop(f,job.id);await idleLoop(f);assert.equal(cancelled.status,'cancelled');const uploads=f.state.uploads.length,ids=cancelled.steps.map(s=>s.jobId);assert.equal(uploads,3);
 f.state.hold=false;const body=await f.body('unused-resume');await f.runner.resume(job.id,body);const done=await waitLoop(f,job.id);await idleLoop(f);assert.equal(done.status,'completed',done.message);assert.equal(f.state.rhCreates.length,3);assert.equal(f.state.uploads.length,uploads);assert.deepEqual(done.steps.map(s=>s.jobId),ids);assert.deepEqual(done.assets.map(a=>a.roundIndex),[0,1,2]);assert.ok(f.state.maxActive>=2);
 const sourceIds=f.node('pictures').params.nativeCanvas.mediaAssetIds;for(const [round,step]of done.steps.entries()){const child=await readJson(path.join(f.data,'jobs',step.jobId+'.json'));assert.equal(child.input.recipe.fields[1].assetId,sourceIds[round]);assert.equal(child.input.recipe.fields[0].fieldValue,'上游'+(round+1)+'/3\n\n节点0');}
 const result=await applyCanvasResults({...f,job:done,revision:0});assert.equal(result.applied,true);assert.deepEqual(f.node('output').params.nativeCanvas.mediaAssetIds,done.assets.map(a=>a.id));
});
test('创作接口并行异步视频各有任务编号，停止后恢复只查询对应原编号',async t=>{
 const f=await nativeLoopFixture(t,{count:3,start:1,mode:'parallel'});Object.assign(f,f.useStudio());f.state.hold=true;const job=await f.runner.start(f.project,await f.body(),f.endpoint);
 for(let i=0;i<300;i++){const children=(await records(path.join(f.data,'jobs'))).filter(j=>j.parentId===job.id&&j.kind==='studio');if(children.length===3&&children.every(j=>j.upstreamId))break;await delay(10);}assert.equal(f.state.studioCreates.length,3);f.activeJobs.get(job.id).controller.abort();const cancelled=await waitLoop(f,job.id);await idleLoop(f);assert.equal(cancelled.status,'cancelled');const ids=cancelled.steps.map(s=>s.jobId);f.state.hold=false;await f.runner.resume(job.id,await f.body('unused-studio'));const done=await waitLoop(f,job.id);await idleLoop(f);assert.equal(done.status,'completed',done.message);assert.equal(f.state.studioCreates.length,3);assert.deepEqual(done.steps.map(s=>s.jobId),ids);assert.equal(done.assets.length,3);assert.ok(done.assets.every(a=>a.type==='video/mp4'));assert.deepEqual(done.assets.map(a=>a.roundIndex),[0,1,2]);assert.ok(f.state.maxActive>=2);
});
test('分步取回后继续未执行回合，只追加新结果且不丢失接收器原素材',async t=>{
 const f=await nativeLoopFixture(t,{count:3,start:1});const job=await f.runner.start(f.project,await f.body(),f.endpoint),done=await waitLoop(f,job.id),first={...structuredClone(done),status:'cancelled',steps:done.steps.map((s,i)=>({...s,status:i===0?'completed':'pending'})),assets:done.assets.slice(0,1)};
 const partial=await applyCanvasResults({...f,job:first,revision:0,acceptPartial:true});assert.equal(partial.applied,false);assert.deepEqual(f.node('output').params.nativeCanvas.mediaAssetIds,[done.assets[0].id]);const after=await applyCanvasResults({...f,job:done,revision:1});assert.equal(after.applied,true);assert.deepEqual(f.node('output').params.nativeCanvas.mediaAssetIds,done.assets.map(a=>a.id));await assert.rejects(applyCanvasResults({...f,job:done,revision:2}),/没有尚未/);validateProject(f.project);
});
test('原生智能循环按上游及本地列表轮换，多字占位符采用实际末轮计数',async t=>{
 const f=await nativeLoopFixture(t,{smart:true,count:3,start:2,media:5,batch:2});applyNativeLoopSettings(f.loop,{...nativeLoopSettings(f.loop),variablePrompts:['本地甲[Counter]/[Total]','本地乙[Progress]']});const job=await f.runner.start(f.project,await f.body(),f.endpoint),done=await waitLoop(f,job.id);assert.equal(done.status,'completed',done.message);assert.deepEqual(done.steps.map(s=>s.nativeLoop.index),[2,4,6]);assert.deepEqual(done.steps.map(s=>s.text),['乙2\n\n本地乙2/6\n\n节点0','乙4\n\n本地乙4/6\n\n节点0','乙6\n\n本地乙6/6\n\n节点0']);
});
