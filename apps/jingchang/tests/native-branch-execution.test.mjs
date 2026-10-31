import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeBranchFixture} from './helpers/native-branch-fixture.mjs';
import {waitLoop,idleLoop} from './helpers/native-loop-fixture.mjs';
import {readJson,atomicJson} from '../lib/workspace.mjs';
import {applyCanvasResults} from '../lib/generation-results.mjs';
import {nativeFlowService} from '../lib/native-flow-service.mjs';

test('串行智能分支每轮只运行选中链，传递该轮实际媒体，输出收集和原画布保留',async t=>{
 const f=await nativeBranchFixture(t),original=structuredClone(f.project),job=await f.runner.start(f.project,await f.branchBody(),f.pool[0]),done=await waitLoop(f,job.id);await idleLoop(f);
 assert.equal(done.status,'completed',done.message);assert.equal(f.state.prompts.length,12);assert.equal(f.state.uploads.length,8);assert.equal(done.assets.length,12);
 for(let round=0;round<4;round++){const expected=f.branchRound(round).route.choices[0].selectedNodeId,steps=done.steps.filter(step=>step.roundIndex===round);assert.equal(steps.length,3);assert.equal(steps[1].nodeId,expected);assert.equal(done.assets.filter(asset=>asset.roundIndex===round).length,3);assert.ok(steps.every(step=>step.status==='completed'));}
 assert.deepEqual(f.project,original);const result=await applyCanvasResults({...f,job:done,revision:0});assert.equal(result.applied,true);assert.equal(f.output.params.nativeCanvas.mediaAssetIds.length,4);
 assert.deepEqual(f.loop.params.nativeCanvas.node,original.nodes.find(node=>node.id===f.loop.id).params.nativeCanvas.node);assert.deepEqual(f.root.params.nativeCanvas,original.nodes.find(node=>node.id===f.root.id).params.nativeCanvas);
});
test('并行各轮独立路由和后端，完成顺序不改变轮次结果排序',async t=>{
 const f=await nativeBranchFixture(t,{mode:'parallel',tails:false});f.state.delayMs=30;
 const job=await f.runner.start(f.project,await f.branchBody(),{...f.pool[0],parallelBackends:f.pool}),done=await waitLoop(f,job.id);await idleLoop(f);
 assert.equal(done.status,'completed',done.message);assert.equal(f.state.prompts.length,8);assert.ok(f.state.maxActive>=2);assert.deepEqual(done.assets.map(asset=>asset.roundIndex),[0,0,1,1,2,2,3,3]);
 for(let round=0;round<4;round++)assert.equal(done.steps.filter(step=>step.roundIndex===round)[1].nodeId,f.branchRound(round).route.choices[0].selectedNodeId);
});
test('Comfy与RunningHub混合分支仅向所选服务提交，保留实际发送范围和编号',async t=>{
 const f=await nativeBranchFixture(t,{cloud:true,tails:false}),job=await f.runner.start(f.project,await f.branchBody('mixed-native-branch'),f.pool[0]),done=await waitLoop(f,job.id);await idleLoop(f);
 assert.equal(done.status,'completed',done.message);assert.equal(f.state.prompts.length,4);assert.equal(f.state.rhCreates.length,4);assert.equal(f.state.uploads.length,4);
 assert.equal(done.steps.filter(step=>step.kind==='runninghub').length,4);assert.ok(done.steps.filter(step=>step.kind==='runninghub').every(step=>step.authorization.sendAssets===true));
 const again=await f.runner.start(f.project,await f.branchBody('mixed-native-branch'),f.pool[0]);assert.equal(again.id,job.id);assert.equal(f.state.rhCreates.length,4);
});
test('停止与重启执行器恢复原子任务编号和旧分支快照，不随当前画布坐标变化重选',async t=>{
 const f=await nativeBranchFixture(t,{count:2,tails:false});f.state.hold=true;
 const job=await f.runner.start(f.project,await f.branchBody('resume-native-branch'),f.pool[0]);let confirmed;for(let i=0;i<500;i++){const parent=await readJson(path.join(f.data,'jobs',job.id+'.json')),childId=parent.steps[0].jobId;if(childId){const child=await readJson(path.join(f.data,'jobs',childId+'.json'),null);if(child?.items?.[0]?.promptId){confirmed=child;break;}}await delay(10);}assert(confirmed,'Wait for the durable upstream receipt before testing confirmed recovery');assert.equal(f.state.prompts.length,1);assert.equal(confirmed.items[0].promptId,f.state.prompts[0].id);
 f.activeJobs.get(job.id).controller.abort();const stopped=await waitLoop(f,job.id);await idleLoop(f);assert.equal(stopped.status,'cancelled');
 const firstId=stopped.steps[0].jobId,choice=stopped.steps[0].nativeBranch.choices[0].selectedNodeId;f.targets[0].x=0;f.loop.params.nativeLoop.start=9;f.state.hold=false;
 const {canvasRunner}=await import('../lib/canvas-runner.mjs'),runner=canvasRunner({...f,pollInterval:10});await runner.resume(job.id,{consent:true});const done=await waitLoop(f,job.id);await idleLoop(f);
 assert.equal(done.status,'completed',done.message);assert.equal(done.steps[0].jobId,firstId);assert.equal(done.steps[0].nativeBranch.choices[0].selectedNodeId,choice);assert.equal(f.state.prompts.length,4);
});
test('已接收但编号未确认的分支任务保持中断；继续查询不重发、不改选分支',async t=>{
 const f=await nativeBranchFixture(t,{count:2,tails:false});f.state.hold=true;const job=await f.runner.start(f.project,await f.branchBody('uncertain-native-branch'),f.pool[0]);let childId;
 for(let i=0;i<500;i++){const parent=await readJson(path.join(f.data,'jobs',job.id+'.json'));if(parent.steps[0].jobId){const child=await readJson(path.join(f.data,'jobs',parent.steps[0].jobId+'.json'),null);if(child?.items?.[0]?.promptId){childId=child.id;break;}}await delay(10);}assert(childId);assert.equal(f.state.prompts.length,1);
 f.activeJobs.get(job.id).controller.abort();const stopped=await waitLoop(f,job.id);await idleLoop(f);assert.equal(stopped.status,'cancelled');const childFile=path.join(f.data,'jobs',childId+'.json'),child=await readJson(childFile);child.items[0].promptId=null;child.items[0].status='submitting';await atomicJson(childFile,child);const choice=stopped.steps[0].nativeBranch.choices[0].selectedNodeId;f.state.hold=false;
 const {canvasRunner}=await import('../lib/canvas-runner.mjs'),runner=canvasRunner({...f,pollInterval:10});await runner.resume(job.id,{consent:true});const uncertain=await waitLoop(f,job.id);await idleLoop(f);assert.equal(uncertain.status,'interrupted');assert.match(uncertain.message,/未确认|没有可恢复/);assert.equal(uncertain.steps[0].jobId,childId);assert.equal(uncertain.steps[0].nativeBranch.choices[0].selectedNodeId,choice);assert.equal(f.state.prompts.length,1);assert.equal(uncertain.assets.length,0);
});
test('篡改路由或计数时，恢复在任务和请求写入前拒绝',async t=>{
 const f=await nativeBranchFixture(t,{count:1,tails:false}),job=await f.runner.start(f.project,await f.branchBody(),f.pool[0]),done=await waitLoop(f,job.id);await idleLoop(f);
 done.status='interrupted';done.steps[0].nativeBranch.choices[0].selectedNodeId='unknown';const file=path.join(f.data,'jobs',done.id+'.json');await atomicJson(file,done);const before=await readJson(file),requests=f.state.prompts.length;
 await assert.rejects(f.runner.resume(done.id,{consent:true}),/分支.*不一致/);assert.deepEqual(await readJson(file),before);assert.equal(f.state.prompts.length,requests);assert.equal(f.activeJobs.size,0);
});
test('任务回合检查只解释当轮选中分支，不显示旧预览作为当轮结果',async t=>{
 const f=await nativeBranchFixture(t,{tails:false}),job=await f.runner.start(f.project,await f.branchBody(),f.pool[0]),done=await waitLoop(f,job.id);await idleLoop(f);assert.equal(done.status,'completed',done.message);
 const route=f.branchRound(0).route,chosen=route.choices[0].selectedNodeId,service=nativeFlowService(f),inspection=await service.inspect(f.project,{jobId:job.id,loopId:f.loop.id,roundIndex:0,nodeId:chosen});
 assert.equal(inspection.nodes[0].media.length,1);assert.deepEqual(inspection.resultJob.nativeBranch,route);assert.equal(inspection.resultJob.completedOutputNodes,2);
 await assert.rejects(service.inspect(f.project,{jobId:job.id,loopId:f.loop.id,roundIndex:0,nodeId:f.targets.find(node=>node.id!==chosen).id}),/未选分支/);
});
test('完成部分取回后编辑分支，保留当前编辑并把旧结果作为独立节点取回',async t=>{
 const f=await nativeBranchFixture(t,{tails:false}),job=await f.runner.start(f.project,await f.branchBody(),f.pool[0]),done=await waitLoop(f,job.id);await idleLoop(f);
 f.targets[0].x=10;const outputBefore=structuredClone(f.output),result=await applyCanvasResults({...f,job:done,revision:0});assert.equal(result.applied,true);assert.deepEqual(f.output,outputBefore);assert.ok(f.project.nodes.some(node=>node.assetId===done.assets[0].id));
});
