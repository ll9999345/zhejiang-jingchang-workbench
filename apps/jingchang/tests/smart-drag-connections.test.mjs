import './helpers/local-network-only.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {smartDragFixture,smartDragRequest} from './helpers/smart-drag-fixture.mjs';
import {smartGroupMediaFixture} from './helpers/smart-group-media-fixture.mjs';
import {planSmartGroupLifecycle,smartGroupLifecycleService,smartGroupRequest} from '../lib/smart-group-lifecycle.mjs';
import {smartDragTarget,canSmartDragConnect,smartLoopInsertion,connectSmartDragInput} from '../public/smart-drag-connections.js';
import {validateProject} from '../lib/model.mjs';
import {nativeFlowPreview} from '../lib/native-flow.mjs';
import {nativeLoopSettings} from '../public/native-loop-core.js';
import {applyNativeLoopSettings} from '../public/native-loop.js';
import {fragmentToNative,nativeToFragment,normalizeNativeWorkflow} from '../lib/native-canvas-core.mjs';
const must=p=>{assert(p.canApply,JSON.stringify(p.effects.blocked));validateProject(p.project);return p;};
test('提示词指针命中连接后复位，原始ID、输入次序和一次回执保存一致',async()=>{
 const f=smartDragFixture(),before=structuredClone(f.p),request=smartDragRequest(f,'prompt',700,0),plan=must(planSmartGroupLifecycle(f.p,request)),n=plan.project.nodes.find(n=>n.id===f.id('prompt')),target=plan.project.nodes.find(n=>n.id===f.id('image'));
 assert.equal(n.x,0);assert.equal(n.params.nativeCanvas.node.x,0);assert.deepEqual(plan.selection,[]);assert.deepEqual(target.params.nativeCanvas.node.inputNodeIds,['prompt']);assert.deepEqual(target.params.nativeCanvas.inputOrder,[{sourceNodeId:n.id,index:0}]);assert.equal(plan.project.edges[0].nativeCanvasConnection.kind,'input');assert.deepEqual(f.p,before);
 let p=f.p,writes=0;const service=smartGroupLifecycleService({projects:{load:async()=>structuredClone(p),save:async next=>(writes++,p=next)},exclusive:async(_,fn)=>fn()});await service.apply(p.id,request,{automatic:true});await service.apply(p.id,request,{automatic:true});assert.equal(writes,1);assert.equal(p.revision,1);await assert.rejects(service.apply(p.id,{...request,requestId:'stale-new-id'},{automatic:true}),/另一窗口/);
});
test('Ctrl 在请求中明确；未按 Ctrl 或多选时仅移动，不自动连接',()=>{
 for(const extra of [{ctrlDrag:false},{positions:null}]){const f=smartDragFixture(),body=smartDragRequest(f,'prompt',700,0,extra);if(extra.positions===null)body.positions=[{id:f.id('prompt'),x:700,y:0},{id:f.id('loop'),x:900,y:300}];const p=must(planSmartGroupLifecycle(f.p,body));assert.equal(p.project.edges.length,0);assert.equal(p.project.nodes.find(n=>n.id===f.id('prompt')).x,700);}
 assert.throws(()=>smartGroupRequest({...smartDragRequest(smartDragFixture(),'prompt',0,0),pointer:{x:Infinity,y:0}}),/指针/);
});
test('循环插入保留原连线类型、删除旧直连并添加输入边；输入索引不残留',()=>{
 for(const kind of ['flow','input']){const f=smartDragFixture();f.p.edges=[{id:'original',source:f.id('prompt'),target:f.id('image'),nativeCanvasConnection:{from:'prompt',to:'image',kind}}];f.node('image').params.nativeCanvas.node.inputNodeIds=['prompt'];f.node('image').params.nativeCanvas.inputOrder=[{sourceNodeId:f.id('prompt'),index:0}];const p=must(planSmartGroupLifecycle(f.p,smartDragRequest(f,'loop',350,0))),n=p.project.nodes.find(n=>n.id===f.id('image'));
 assert.deepEqual(p.project.edges.map(e=>e.nativeCanvasConnection),[{from:'prompt',to:'loop',kind},{from:'loop',to:'image',kind:'input'}]);assert.deepEqual(n.params.nativeCanvas.node.inputNodeIds,['loop']);assert.deepEqual(n.params.nativeCanvas.inputOrder,[{sourceNodeId:f.id('loop'),index:0}]);assert.equal(p.effects.connectionGesture.kind,'insert-loop');assert.equal(p.project.nodes.find(n=>n.id===f.id('loop')).x,350);}
});
test('96世界单位边界、首条平局、历史边与自连排除；指针优先和中心命中区分',()=>{
 const f=smartDragFixture();f.p.edges=[{id:'first',source:f.id('prompt'),target:f.id('image')},{id:'second',source:f.id('prompt'),target:f.id('image')}];Object.assign(f.node('loop'),{x:446,y:0});assert.equal(smartLoopInsertion(f.p,f.id('loop')).edgeId,'first');f.node('loop').x+=.001;assert.equal(smartLoopInsertion(f.p,f.id('loop')),null);f.node('loop').x=350;f.p.edges.forEach(e=>e.nativeCanvasConnection={kind:'history'});assert.equal(smartLoopInsertion(f.p,f.id('loop')),null);
 assert.equal(smartDragTarget(f.p,f.id('prompt'),[f.id('prompt')],{x:701,y:1}).id,f.id('image'));assert.equal(smartDragTarget(f.p,f.id('image'),[f.id('image')],{x:1,y:1}),null);f.node('image').params.nativeCanvas.node.isHistoryGroup=true;assert.equal(canSmartDragConnect(f.node('prompt'),f.node('image')),false);
});
test('重复连接不重复边、已有反向路径拒绝保存',()=>{
 const f=smartDragFixture(),body=smartDragRequest(f,'prompt',700,0),first=must(planSmartGroupLifecycle(f.p,body));const again=must(planSmartGroupLifecycle(first.project,body));assert.equal(again.project.edges.length,1);f.p.edges=[{id:'reverse',source:f.id('image'),target:f.id('prompt')}];const refused=planSmartGroupLifecycle(f.p,body);assert.equal(refused.canApply,false);assert.match(refused.effects.blocked[0].message,/循环/);assert.equal(f.p.edges.length,1);
});
test('直接连接循环启用对应输入，但不启用执行、不改轮数与批次',()=>{
 const f=smartDragFixture();f.node('loop').params.nativeCanvas.node.imageInput=false;const result=must(planSmartGroupLifecycle(f.p,smartDragRequest(f,'prompt',0,500))),loop=result.project.nodes.find(n=>n.id===f.id('loop'));assert.equal(loop.params.nativeCanvas.node.showPrompt,true);assert.equal(loop.params.nativeCanvas.node.count,2);assert.equal(loop.params.nativeCanvas.node.imageInput,false);assert.equal(loop.params.nativeLoop,undefined);
});
test('Ctrl 图片多图合并保留所有文件，原目标固定字段不误选新增素材',()=>{
 const f=smartGroupMediaFixture(),g=f.node('group'),left=f.node('left'),right=f.node('right');g.params.nativeCanvas.node.type='smart-image';g.params.nativeCanvas.members=[];g.params.nativeCanvas.node.items=[];f.p.groups=[];for(const n of f.p.nodes)if(n!==g&&n!==right)n.x=2000;const target=f.node('target');target.params.nativeCanvas.adaptation='configured';target.params.workflowBinding={workflowId:'owned',overrides:[],count:1,imageSources:[{nodeId:'1',name:'image',sourceNodeId:g.id,sourceIndex:1}]};
 const plan=must(planSmartGroupLifecycle(f.p,smartDragRequest(f,'right',50,50))),merged=plan.project.nodes.find(n=>n.id===g.id);assert(!plan.project.nodes.some(n=>n.id===right.id));assert.deepEqual(merged.params.nativeCanvas.mediaAssetIds,['own-a','own-b','right']);assert.equal(merged.title,'Group');assert.deepEqual(plan.project.assets,f.p.assets);assert.equal(plan.project.nodes.find(n=>n.id===target.id).params.workflowBinding.imageSources[0].assetId,'own-b');assert.equal(plan.effects.connectionGesture.kind,'merge-images');assert(plan.project.nodes.some(n=>n.id===left.id));
});
test('循环插入优先于落入智能组，非插入时智能组吸收优先于自动连接',()=>{
 const f=smartDragFixture(),extra=smartGroupMediaFixture().node('group');extra.id='owned-group';extra.params.nativeCanvas.node.id='owned-group';extra.params.nativeCanvas.resources=[];extra.params.nativeCanvas.mediaAssetIds=[];extra.params.nativeCanvas.members=[];extra.params.nativeCanvas.node.images=[];extra.params.nativeCanvas.node.items=[];Object.assign(extra,{x:300,y:0});Object.assign(extra.params.nativeCanvas.node,{x:300,y:0,w:500,h:400});f.p.nodes.push(extra);f.p.edges=[{id:'original',source:f.id('prompt'),target:f.id('image')}];const plan=must(planSmartGroupLifecycle(f.p,smartDragRequest(f,'loop',350,0)));assert.equal(plan.effects.connectionGesture.kind,'insert-loop');assert.deepEqual(plan.effects.addedMemberIds,[]);
 const next=must(planSmartGroupLifecycle(f.p,smartDragRequest(f,'prompt',350,50)));assert.deepEqual(next.effects.addedMemberIds,[f.id('prompt')]);assert.equal(next.effects.connectionGesture,undefined);
});
test('插入后的真实数据流按轮传递文字，原生导出再导入保留边与输入顺序',()=>{
 const f=smartDragFixture();f.node('prompt').text='镜头一;镜头二';f.node('prompt').params.nativeCanvas.node.promptSplitEnabled=true;f.node('prompt').params.nativeCanvas.node.promptSeparator=';';applyNativeLoopSettings(f.node('loop'),{...nativeLoopSettings(f.node('loop')),enabled:true,imageInput:false,showPrompt:true,variablePrompts:['第《计数》轮'],variablePrompt:''});f.p.edges=[{id:'original',source:f.id('prompt'),target:f.id('image'),nativeCanvasConnection:{from:'prompt',to:'image',kind:'input'}}];const plan=must(planSmartGroupLifecycle(f.p,smartDragRequest(f,'loop',350,0))),expected=['镜头一\n\n第1轮','镜头二\n\n第2轮'];
 for(const index of [1,2]){const view=nativeFlowPreview(plan.project,{nodeId:f.id('image'),execution:true,loopContexts:{[f.id('loop')]:{index,total:2}}});assert.deepEqual(view.inputs.issues,[]);assert.deepEqual(view.inputs.promptItems,[expected[index-1]]);}
 const exported=fragmentToNative(plan.project,[]),restored=nativeToFragment(normalizeNativeWorkflow(exported.document||exported),[],'再次导入'),loop=restored.nodes.find(n=>n.params.nativeCanvas.node.id==='loop'),image=restored.nodes.find(n=>n.params.nativeCanvas.node.id==='image');assert.deepEqual(restored.edges.map(e=>e.nativeCanvasConnection.kind),['input','input']);assert.deepEqual(nativeFlowPreview(restored,{nodeId:image.id,loopContexts:{[loop.id]:{index:2,total:2}}}).inputs.promptItems,[expected[1]]);
});
test('智能组循环成员的文字与已清空提示词按当前内容判定，不使用过期导入文字',()=>{
 const f=smartDragFixture(),group=structuredClone(f.node('image'));group.id='owned-group';Object.assign(group.params.nativeCanvas.node,{id:'owned-group',type:'smart-group',images:[]});group.params.nativeCanvas.members=[{sourceNodeId:f.id('prompt')}];f.p.nodes.push(group);f.node('prompt').text='';f.node('loop').params.nativeCanvas.node.imageInput=false;assert.equal(connectSmartDragInput(f.p,group,f.node('loop'),()=> 'edge-empty'),false);assert.equal(f.p.edges.length,0);
 const member=structuredClone(f.node('loop'));member.id='member-loop';Object.assign(member.params.nativeCanvas.node,{id:'member-loop',showPrompt:true,variablePrompt:'第《计数》张'});f.p.nodes.push(member);group.params.nativeCanvas.members=[{sourceNodeId:member.id}];assert.equal(connectSmartDragInput(f.p,group,f.node('loop'),()=> 'edge-group'),true);assert.equal(f.node('loop').params.nativeCanvas.node.showPrompt,true);assert.equal(f.p.edges.length,1);
});
