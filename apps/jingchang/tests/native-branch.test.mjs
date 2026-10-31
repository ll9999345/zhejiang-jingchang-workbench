import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeBranchFixture} from './helpers/native-branch-fixture.mjs';
import {nativeBranchSettings,nativeBranchRound,nativeBranchCandidates,nativeBranchProjectFromStep,normalizeNativeBranch,nativeBranchMarkup} from '../public/native-branch-core.js';
import {nativeBranchPreviewMarkup} from '../public/native-branch-ui.js';
import {nativeLoopSettings} from '../public/native-loop-core.js';
import {validateProject,makeNode} from '../lib/model.mjs';
import {fragmentToNative} from '../lib/native-canvas-core.mjs';
import {nativeFlowPreview} from '../lib/native-flow.mjs';
import {nativeReferenceKinds,nativeReferenceChoices} from '../public/native-flow-ui.js';

const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

test('旧项目默认保持全部分支；新策略须严格启用且只属于原生智能循环',async t=>{
 const f=await nativeBranchFixture(t,{enabled:false,tails:false});delete f.loop.params.nativeBranch;
 assert.deepEqual(nativeBranchSettings(f.loop),{version:1,enabled:false});assert.equal((await f.runner.plan(f.project)).length,16);
 for(const value of [null,{version:2,enabled:true},{version:1,enabled:1},{version:1,enabled:true,mode:'random'}])assert.throws(()=>normalizeNativeBranch(value),/设置无效/);
 f.project.nodes.push(makeNode('text',0,0,{params:{nativeBranch:{version:1,enabled:true}}}));assert.throws(()=>validateProject(f.project),/原生智能循环/);assert.equal(f.state.prompts.length,0);
});
test('按真实横纵坐标和起始计数选择分支，不采用创建顺序或轮偏移',async t=>{
 const f=await nativeBranchFixture(t),before=structuredClone(f.project),candidate=nativeBranchCandidates(f.project,f.loop)[0];
 assert.deepEqual(candidate.targetNodeIds,f.targets.map(node=>node.id));
 for(let round=0;round<4;round++) {
  const {project,route}=f.branchRound(round),chosen=f.targets[(round+1)%3];assert.equal(route.choices[0].selectedNodeId,chosen.id);assert.equal(route.choices[0].index,round+2);
  assert.equal(project.nodes.some(node=>node.id===chosen.id),true);
  assert.equal(project.nodes.filter(node=>f.targets.some(target=>target.id===node.id)).length,1);
  assert.equal(project.nodes.filter(node=>f.leaves.some(leaf=>leaf.id===node.id)).length,1);validateProject(project);
 }
 assert.deepEqual(f.project,before);assert.equal(f.state.prompts.length,0);
});
test('图片批次步幅控制分支索引；总数和计数沿用原循环规则',async t=>{
 const f=await nativeBranchFixture(t,{count:3,start:2,media:6,batch:2,tails:false}),steps=await f.runner.plan(f.project);
 assert.deepEqual(steps.filter(step=>step.nodeId===f.root.id).map(step=>step.nativeLoop.index),[2,4,6]);
 assert.deepEqual(steps.filter(step=>step.nodeId===f.root.id).map(step=>step.nativeBranch.choices[0].selectedNodeId),[f.targets[1].id,f.targets[0].id,f.targets[2].id]);
 assert.ok(steps.every(step=>step.nativeLoop.total===6));assert.equal(steps.length,6);
});
test('工作流连线和历史节点不冒充提示词分支；关闭提示词开关不选择分支',async t=>{
 const f=await nativeBranchFixture(t,{tails:false});f.project.edges.find(edge=>edge.source===f.loop.id&&edge.target===f.root.id).nativeCanvasConnection.kind='flow';
 assert.deepEqual(nativeBranchCandidates(f.project,f.loop),[]);assert.equal((await f.runner.plan(f.project)).length,16);
 f.project.edges.find(edge=>edge.source===f.loop.id&&edge.target===f.root.id).nativeCanvasConnection.kind='input';
 f.targets[0].params.nativeCanvas.node.isHistoryGroup=true;assert.equal(nativeBranchCandidates(f.project,f.loop)[0].targetNodeIds.includes(f.targets[0].id),false);
 f.loop.params.nativeLoop.showPrompt=false;assert.deepEqual(nativeBranchCandidates(f.project,f.loop),[]);
});
test('分支额外连接循环提示词，不绕过已选分支；汇合只保留当前分支输入',async t=>{
 const f=await nativeBranchFixture(t,{count:1,start:1,tails:false});
 for(const target of f.targets)f.project.edges.push({id:'prompt-'+target.id,source:f.loop.id,target:target.id,nativeCanvasConnection:{kind:'input'}});
 const {project,route}=f.branchRound(0);assert.equal(route.choices[0].selectedNodeId,f.targets[0].id);assert.equal(project.nodes.filter(node=>f.targets.some(target=>target.id===node.id)).length,1);
 assert.deepEqual(project.edges.filter(edge=>edge.target===f.output.id).map(edge=>edge.source),[f.targets[0].id]);
 assert.equal((await f.runner.plan(f.project)).length,2);
});
test('运行某一链尾仍核对完整分支候选，不因缩小范围改变轮换顺序',async t=>{
 const f=await nativeBranchFixture(t),whole=await f.runner.plan(f.project),scoped=await f.runner.plan(f.project,{nodeId:f.leaves[0].id});
 assert.deepEqual(scoped.map(step=>[step.nodeId,step.roundIndex,step.nativeBranch]),whole.map(step=>[step.nodeId,step.roundIndex,step.nativeBranch]));
});
test('大量候选按本轮实际步骤计算容量，未选分支不算额外请求',async t=>{
 const f=await nativeBranchFixture(t,{count:2,start:1,branches:40,tails:false}),steps=await f.runner.plan(f.project);assert.equal(steps.length,4);assert.equal(steps.reduce((sum,step)=>sum+step.count,0),4);
 assert.equal(steps[0].nativeBranch.choices[0].targetNodeIds.length,40);assert.equal(f.state.prompts.length,0);
});
test('任务恢复严格核对分支、计数和原快照；伪造记录不能被采用',async t=>{
 const f=await nativeBranchFixture(t),step=(await f.runner.plan(f.project))[0];nativeBranchProjectFromStep(f.project,step);
 for(const change of [copy=>delete copy.nativeBranch,copy=>copy.nativeBranch.choices[0].selectedNodeId=f.targets[0].id,copy=>copy.nativeLoop.index++,copy=>copy.nativeLoop.contexts[f.loop.id].index++,copy=>copy.nativeBranch.excludedNodeIds=[]]) {
  const copy=structuredClone(step);change(copy);assert.throws(()=>nativeBranchProjectFromStep(f.project,copy),/不一致/);
 }
 assert.equal(f.state.prompts.length,0);
});
test('已确认迁移的智能素材可作为本轮生成来源，未迁移仍明确阻断',async t=>{
 const f=await nativeBranchFixture(t),routed=f.branchRound(0).project;
 assert.deepEqual(nativeFlowPreview(routed,{nodeId:f.root.id,execution:true}).nodes[0].issues,[]);
 f.root.params.nativeCanvas.adaptation='reference';assert.ok(nativeFlowPreview(f.project,{nodeId:f.root.id,execution:true}).nodes[0].issues.includes('智能素材原生生成设置尚未迁移'));
 await assert.rejects(f.runner.plan(f.project),/尚[待未]迁移|确认迁移/);assert.equal(f.state.prompts.length,0);
});
test('智能素材待生成状态在参考选择器和接收器中一致，不冒充已有媒体',async t=>{
 const f=await nativeBranchFixture(t,{tails:false}),routed=f.branchRound(0).project,chosen=f.branchRound(0).route.choices[0].selectedNodeId;
 const choices=nativeReferenceChoices(routed,f.output.id),branch=choices.find(choice=>choice.value==='node:'+chosen);
 assert.ok(branch);assert.equal(branch.dynamic,true);assert.equal(branch.grouped,true);assert.match(branch.label,/本轮待生成/);assert.doesNotMatch(branch.label,/已有素材/);
 assert.deepEqual(nativeReferenceKinds(routed,{sourceNodeId:f.output.id}),['image']);assert.equal(f.state.prompts.length,0);
});
test('分支配置与预览转义文本、使用实际计数，且预览不修改工程',async t=>{
 const f=await nativeBranchFixture(t);f.targets[1].title='<script>分支</script>';const before=structuredClone(f.project),html=nativeBranchPreviewMarkup(f.project,f.loop,nativeLoopSettings(f.loop),true,esc);
 assert.match(html,/第 4\/4 轮/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/计数 2/);
 assert.match(nativeBranchMarkup(f.branchRound(0).route,esc,id=>f.project.nodes.find(node=>node.id===id).title),/未选分支不提交/);
 assert.deepEqual(f.project,before);assert.equal(f.state.prompts.length,0);
});
test('启用的迁移执行策略不伪装成可运行原生JSON，完整工程另行保留',async t=>{
 const f=await nativeBranchFixture(t);assert.throws(()=>fragmentToNative(f.project,[]),/\.jingchang.*迁移设置/);assert.equal(f.state.prompts.length,0);
});
