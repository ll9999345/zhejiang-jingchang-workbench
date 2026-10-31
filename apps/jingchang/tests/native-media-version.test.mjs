import './helpers/local-network-only.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {smartGroupMediaFixture} from './helpers/smart-group-media-fixture.mjs';
import {nativeMediaVersion,hasNativeMediaVersion} from '../public/native-media-version.js';
import {validateProject,makeProject,makeNode} from '../lib/model.mjs';
import {nativeReferencePlan,nativeExecutionMedia} from '../lib/native-flow-execution.mjs';
import {nativeReferenceChoices,nativeReferenceKinds} from '../public/native-flow-ui.js';
import {nativeFlowPreview} from '../lib/native-flow.mjs';
import {selectCanvasFragment,mergeCanvasFragment,fragmentMaps} from '../lib/canvas-fragments.mjs';
import {fragmentToNative} from '../lib/native-canvas-core.mjs';
import {planNativeMediaMigration,nativeMediaMigrationService} from '../lib/native-media-migration.mjs';
const media=(f,node=f.node('target'))=>nativeReferencePlan(f.p,node,[{sourceNodeId:f.id('group')}],{planning:true}).references.map(r=>r.assetId);
const oldFixture=()=>{const f=smartGroupMediaFixture();delete f.p.settings.nativeMediaVersion;return f;};
const req=(p,extra={})=>({mode:'project',requestId:'version-local-request',revision:p.revision,...extra});
test('缺失版本的旧工程与快照恒为1，新智能组导入为2；非法版本在模型验证处拒绝',()=>{
 const f=smartGroupMediaFixture();assert.equal(nativeMediaVersion(f.p),2);assert(hasNativeMediaVersion(f.p));delete f.p.settings.nativeMediaVersion;assert.equal(nativeMediaVersion(f.p),1);assert(!hasNativeMediaVersion(f.p));assert.deepEqual(media(f),['right','left']);
 for(const value of [0,3,'2',null,true]){f.p.settings.nativeMediaVersion=value;assert.throws(()=>validateProject(f.p),/版本/);assert.throws(()=>nativeMediaVersion(f.p),/版本/);delete f.p.settings.nativeMediaVersion;f.node('target').params.nativeMediaVersion=value;assert.throws(()=>validateProject(f.p),/版本/);delete f.node('target').params.nativeMediaVersion;}
});
test('同一工程两个消费者同时读取1和2版，后端与前端按消费者匹配且不借用来源节点版本',async()=>{
 const f=smartGroupMediaFixture(),old=f.node('target'),fresh=makeNode('image',0,0,{title:'新节点'});old.params.nativeMediaVersion=1;f.node('group').params.nativeMediaVersion=1;f.p.nodes.push(fresh);f.p.edges.push({id:'new-edge',source:f.id('group'),target:fresh.id});f.p.assets.find(a=>a.id==='own-b').type='audio/wav';
 await Promise.all(Array.from({length:20},async(_,i)=>{const node=i%2?old:fresh,version=i%2?1:2;assert.deepEqual(media(f,node),version===1?['right','left']:['own-a','own-b','left','right']);const choice=nativeReferenceChoices(f.p,node.id).find(c=>c.value==='node:'+f.id('group'));assert.match(choice.label,version===1?/2 份/:/4 份/);assert.deepEqual(nativeReferenceKinds(f.p,{sourceNodeId:f.id('group')},{nodeId:node.id}),version===1?['image']:['image','audio']);}));
 assert.deepEqual(nativeExecutionMedia(f.p,f.id('group'),{mediaVersion:2}).media.map(r=>r.assetId),['own-a','own-b','left','right']);assert.deepEqual(nativeFlowPreview(f.p,{nodeId:old.id}).inputs.media.map(r=>r.assetId),['right','left']);
});
test('子图提取保留版本，插入两种默认规则的工程均保留来源输入，目标已有节点与设置不变',()=>{
 for(const [from,to]of [[1,2],[2,1]]){const f=smartGroupMediaFixture();f.p.settings.nativeMediaVersion=from;const fragment=selectCanvasFragment(f.p,f.p.nodes.map(n=>n.id));assert.equal(fragment.settings.nativeMediaVersion,from);const target=makeProject('已有画布');target.settings.nativeMediaVersion=to;const before=structuredClone(target),maps=fragmentMaps(fragment),merged=mergeCanvasFragment(target,fragment,maps,{x:2000,y:2000}).project;assert.deepEqual(target,before);assert.deepEqual(merged.nodes[0],before.nodes[0]);assert.deepEqual(merged.settings,before.settings);const consumer=merged.nodes.find(n=>n.id===maps.nodes[f.id('target')]);assert.equal(nativeMediaVersion(merged,consumer),from);assert.deepEqual(nativeReferencePlan(merged,consumer,[{sourceNodeId:maps.nodes[f.id('group')]}],{planning:true}).references.map(r=>r.assetId),from===1?['right','left']:['own-a','own-b','left','right']);}
});
test('升级工程默认值时所有旧节点保持旧规则，旧字段、整组范围和原工程不变',()=>{
 const f=oldFixture(),target=f.node('target');target.params.workflowBinding={imageSources:[{nodeId:'load',name:'image',sourceNodeId:f.id('group'),sourceIndex:0}]};const before=structuredClone(f.p),plan=planNativeMediaMigration(f.p,req(f.p));assert(plan.canApply);assert(plan.changed);assert.equal(plan.project.settings.nativeMediaVersion,2);for(const n of plan.project.nodes)assert.equal(n.params.nativeMediaVersion,1);assert.deepEqual(plan.project.nodes.map(n=>n.params.workflowBinding),before.nodes.map(n=>n.params.workflowBinding));assert.deepEqual(nativeReferencePlan(plan.project,plan.project.nodes.find(n=>n.id===target.id),[{sourceNodeId:f.id('group')}],{planning:true}).references.map(r=>r.assetId),['right','left']);assert.deepEqual(f.p,before);
 const added=makeNode('image');assert.equal(nativeMediaVersion(plan.project,added),2);
});
test('单节点保留原图把旧第1格映射为新第4格；原素材身份和项目原件均不变',()=>{
 const f=oldFixture(),n=f.node('target');n.params.workflowBinding={imageSources:[{nodeId:'load',name:'image',sourceNodeId:f.id('group'),sourceIndex:0}]};const before=structuredClone(f.p),plan=planNativeMediaMigration(f.p,req(f.p,{mode:'node',nodeId:n.id,selection:'preserve'})),next=plan.project.nodes.find(x=>x.id===n.id);assert(plan.canApply);assert.equal(next.params.workflowBinding.imageSources[0].sourceIndex,3);assert.deepEqual(nativeReferencePlan(plan.project,next,[next.params.workflowBinding.imageSources[0]],{planning:true}).references,[{assetId:'right'}]);assert.deepEqual(plan.effects.fields[0].before.map(s=>s.assetId),['right','left']);assert.deepEqual(plan.effects.fields[0].after.map(s=>s.assetId),['own-a','own-b','left','right']);assert.deepEqual(f.p,before);
});
test('整组参考不能伪造索引保留范围，须明确采用新范围；固定接收器可在核对后迁移',()=>{
 const f=oldFixture(),n=f.node('target');n.params.imageBinding={referenceSources:[{sourceNodeId:f.id('group')}]};const body=req(f.p,{mode:'node',nodeId:n.id,selection:'preserve'}),blocked=planNativeMediaMigration(f.p,body);assert.equal(blocked.canApply,false);assert(blocked.effects.blocked.some(s=>s.includes('整组')));const adopted=planNativeMediaMigration(f.p,{...body,selection:'adopt'});assert(adopted.canApply);const next=adopted.project.nodes.find(x=>x.id===n.id);assert.deepEqual(next.params.imageBinding.referenceSources,[{sourceNodeId:f.id('group')}]);assert.deepEqual(nativeReferencePlan(adopted.project,next,next.params.imageBinding.referenceSources,{planning:true}).references.map(r=>r.assetId),['own-a','own-b','left','right']);
 f.node('group').params.nativeCanvas.node.type='output';f.node('group').params.nativeCanvas.members=[];const complex=planNativeMediaMigration(f.p,{...body,selection:'adopt'});assert.equal(complex.canApply,true);assert.deepEqual(complex.effects.fields[0].before,complex.effects.fields[0].after);
});
test('旧规则智能组原生格式导出明确拒绝，不能把规则静默丢掉；完整版本允许',()=>{
 const f=oldFixture();assert.throws(()=>fragmentToNative(f.p,f.p.assets,{withResources:true}),/完整备份/);f.p.settings.nativeMediaVersion=2;assert.equal(fragmentToNative(f.p,f.p.assets,{withResources:true}).format,'infinite-smart-canvas-workflow');f.node('target').params.nativeMediaVersion=1;assert.throws(()=>fragmentToNative(f.p,f.p.assets,{withResources:true}),/完整备份/);
});
test('本地保存服务要求准确预览摘要、版本一致、同编号重试幂等，旧预览和改范围拒绝',async()=>{
 const f=oldFixture();let current=structuredClone(f.p),writes=0;const service=nativeMediaMigrationService({projects:{load:async()=>structuredClone(current),save:async p=>{writes++;current=structuredClone(p);return p;}},exclusive:async(id,fn)=>fn()}),body=req(f.p),preview=await service.preview(f.p.id,body);assert(preview.canApply);assert.equal(writes,0);await assert.rejects(service.apply(f.p.id,{...body,planHash:'wrong'}),/重新检查/);const saved=await service.apply(f.p.id,{...body,planHash:preview.planHash});assert.equal(writes,1);assert.equal(saved.revision,1);assert.deepEqual(await service.apply(f.p.id,{...body,planHash:preview.planHash}),saved);assert.equal(writes,1);await assert.rejects(service.apply(f.p.id,{...body,mode:'node',nodeId:f.id('target'),selection:'adopt',planHash:preview.planHash}),/另一份/);await assert.rejects(service.apply(f.p.id,{...body,requestId:'other-request',planHash:preview.planHash}),/已更新/);
});
