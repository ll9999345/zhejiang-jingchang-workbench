import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import vm from 'node:vm';
import {makeProject,makeNode,validateProject} from '../lib/model.mjs';
import {createInputGroup} from '../public/input-group-core.js';
import {planInputGroupMembership} from '../lib/input-group-membership.mjs';
import {nativeReferencePlan,nativeReferenceSelectionSlots} from '../lib/native-flow-execution.mjs';
import {nativeFlowPreview} from '../lib/native-flow.mjs';
import {nativeToFragment,normalizeNativeWorkflow,fragmentToNative} from '../lib/native-canvas-core.mjs';
import {arrangeCanvasSelection} from '../public/canvas-arrange-core.js';
import {mergeCanvasEdit} from '../public/canvas-edit-merge.js';
import {newMinimaxSegment,normalizeMinimaxTimeline} from '../public/minimax-h3-core.js';
import {normalizeLtxTimeline} from '../public/ltx-director-core.js';

import {membershipFixture} from './helpers/input-group-membership-fixture.mjs';

const edit=(p,groupId,memberIds,extra={})=>planInputGroupMembership(p,{mode:'manual',requestId:'edit-once',revision:p.revision,groupId,memberIds,title:p.nodes.find(n=>n.id===groupId).title,...extra});
const members=(p,id)=>p.nodes.find(n=>n.id===id).params.nativeCanvas.members.map(r=>r.sourceNodeId);
const field=p=>p.nodes.find(n=>n.id==='target').params.workflowBinding.imageSources[0];
const selected=p=>nativeReferencePlan(p,p.nodes.find(n=>n.id==='target'),[field(p)],{planning:true}).references;

test('删掉前一张图仍保留原选中素材，序号准确迁移，输入项目不改变',()=>{
 const p=membershipFixture(),before=structuredClone(p),plan=edit(p,'a',['text','y']);validateProject(plan.project);assert.deepEqual(p,before);assert.deepEqual(members(plan.project,'a'),['text','y']);assert.equal(field(plan.project).sourceIndex,0);assert.deepEqual(selected(p),selected(plan.project));assert.equal(plan.effects.fieldChanges[0].action,'preserve-selected-slot');assert.deepEqual(plan.project.assets,p.assets);
});
test('移出被选图片时保留原生产节点和必要直连，不猜测新的首图',()=>{
 const p=membershipFixture(),plan=edit(p,'a',['text','x']);assert.deepEqual(field(plan.project),{nodeId:'1',name:'image',sourceNodeId:'y',sourceIndex:0});assert(plan.project.edges.some(e=>e.source==='y'&&e.target==='target'));assert.deepEqual(selected(p),selected(plan.project));assert.equal(plan.effects.fieldChanges[0].action,'preserve-original-producer');
});
test('同类型跨组移入同时移出旧组，其他类型的共享成员保持',()=>{
 const p=membershipFixture(),shared=edit(p,'pg',['text']).project,moved=edit(shared,'b',['text','y']).project;assert.deepEqual(members(moved,'a'),['x']);assert.deepEqual(members(moved,'b'),['text','y']);assert.deepEqual(members(moved,'pg'),['text']);assert.deepEqual(selected(moved),[{assetId:'asset-y'}]);
});
test('空组可填充、清空并再次编辑，保留原节点与素材',()=>{
 const p=membershipFixture(),filled=edit(p,'b',['x']).project,empty=edit(filled,'b',[]).project,again=edit(empty,'b',['x']).project;assert.deepEqual(members(empty,'b'),[]);assert.deepEqual(members(again,'b'),['x']);assert.equal(again.nodes.length,p.nodes.length);assert.deepEqual(again.assets,p.assets);
});
test('整组参考随成员变化，空组引用移除，单个明确素材字段仍保持',()=>{
 const p=membershipFixture();p.nodes.push(makeNode('image',1000,400,{id:'api-target',params:{imageBinding:{referenceSources:[{sourceNodeId:'a'}]}}}));p.edges.push({id:'a-api',source:'a',target:'api-target'});const plan=edit(p,'a',[]);assert.deepEqual(plan.project.nodes.find(n=>n.id==='api-target').params.imageBinding.referenceSources,[]);assert.deepEqual(selected(plan.project),[{assetId:'asset-y'}]);assert(plan.effects.fieldChanges.some(f=>f.action==='remove-empty-group-reference'));
});
test('新增多图后原单图字段补明确序号，尚未完成的生产节点序号保持',()=>{
 const p=membershipFixture();p.nodes.find(n=>n.id==='x').params.workflowBinding={workflowId:'future',count:2,overrides:[],imageSources:[]};field(p).sourceIndex=1;
 const before=nativeReferenceSelectionSlots(p,p.nodes.find(n=>n.id==='target'),'a');assert.deepEqual(before[1].selection,{sourceNodeId:'x',sourceIndex:1});const plan=edit(p,'a',['text','y']);assert.equal(field(plan.project).sourceNodeId,'x');assert.equal(field(plan.project).sourceIndex,1);assert(plan.project.edges.some(e=>e.source==='x'&&e.target==='target'));
});
test('私有选择快照可区分同一文件的不同节点，普通执行重复保护保持',()=>{
 const p=membershipFixture();p.nodes.find(n=>n.id==='y').assetId='asset-x';const target=p.nodes.find(n=>n.id==='target');assert.throws(()=>nativeReferencePlan(p,target,[{sourceNodeId:'a'}],{planning:true}),/重复素材/);const slots=nativeReferenceSelectionSlots(p,target,'a');assert.deepEqual(slots.map(s=>s.selection.sourceNodeId),['x','y']);const normal=nativeReferencePlan(p,target,[{sourceNodeId:'a',sourceIndex:1}],{planning:true});assert.equal(Object.hasOwn(normal.details[0],'selection'),false);
});
test('按中心点含边界，重叠时按源节点顺序选首组，提示词可进两种组',()=>{
 const p=membershipFixture(),draft=structuredClone(p);draft.nodes.find(n=>n.id==='text').x=250;draft.nodes.find(n=>n.id==='text').y=450;draft.nodes.find(n=>n.id==='x').x=250;draft.nodes.find(n=>n.id==='x').y=50;
 const body={mode:'drag',requestId:'drag-once',revision:0,draft,movedIds:['text','x'],rects:{text:{width:100,height:100},x:{width:100,height:100}}},plan=planInputGroupMembership(p,body);assert.deepEqual(members(plan.project,'pg'),['text']);assert(!members(plan.project,'a').includes('text'));assert(members(plan.project,'a').includes('x'));
 const overlap=structuredClone(p);overlap.nodes.find(n=>n.id==='b').x=100;overlap.nodes.find(n=>n.id==='x').x=150;const r=planInputGroupMembership(p,{...body,draft:overlap,movedIds:['x']});assert(members(r.project,'a').includes('x'));assert(!members(r.project,'b').includes('x'));
});
test('拖整个组（含成员）不重新入组，符合固定endDrag规则',()=>{
 const p=membershipFixture(),draft=structuredClone(p);for(const n of draft.nodes.filter(n=>['a','text','x','y'].includes(n.id))){n.x+=500;n.y+=20;}const plan=planInputGroupMembership(p,{mode:'drag',requestId:'drag-group',revision:0,draft,movedIds:['a','text','x','y']});assert.deepEqual(members(plan.project,'a'),members(p,'a'));assert.deepEqual(members(plan.project,'b'),[]);assert.deepEqual(plan.effects.memberships,[]);
});
test('拖入时交接直接生成边，即使成员原本已在组内也会整理连线',()=>{
 const p=membershipFixture();p.edges.push({id:'new-direct',source:'x',target:'target'});const plan=planInputGroupMembership(p,{mode:'drag',requestId:'handoff',revision:0,draft:structuredClone(p),movedIds:['x'],rects:{x:{width:100,height:100}}});assert(!plan.project.edges.some(e=>e.id==='new-direct'));assert.equal(plan.project.edges.filter(e=>e.source==='a'&&e.target==='target').length,1);assert(plan.effects.removedEdges.some(e=>e.id==='new-direct'));
});
test('新语义环整体拒绝，特殊旧成员可保留，原不相关记录不截断',()=>{
 const p=membershipFixture(),before=structuredClone(p);assert.throws(()=>edit(p,'a',['text','x','y','target']),/循环/);assert.deepEqual(p,before);p.messages=[{role:'user',text:'原消息'}];p.runs=[{id:'old-run',status:'completed'}];const result=edit(p,'b',['text']).project;assert.deepEqual(result.messages,p.messages);assert.deepEqual(result.runs,p.runs);
});
test('旧导入显示框跟随成员，清空/共享时保留其样式并可恢复',()=>{
 let p=nativeToFragment(normalizeNativeWorkflow({nodes:[{id:'t',type:'prompt',x:0,y:0,text:'t'},{id:'a',type:'group',x:0,y:0,items:['t']},{id:'b',type:'promptGroup',x:400,y:0,items:[]}],connections:[]}),[],'旧显示框');const [t,a,b]=p.nodes,frame=p.groups[0];frame.color='#123456';frame.collapsed=true;
 p=edit(p,a.id,[]).project;assert.equal(p.groups.length,0);assert.equal(p.nodes[1].params.nativeCanvas.groupDisplayState.color,'#123456');p=edit(p,a.id,[t.id]).project;assert.equal(p.groups[0].id,frame.id);assert.equal(p.groups[0].color,'#123456');assert.equal(p.groups[0].collapsed,true);
 p=edit(p,b.id,[t.id]).project;validateProject(p);assert.equal(p.groups.length,1);assert.deepEqual(members(p,a.id),[t.id]);assert.deepEqual(members(p,b.id),[t.id]);
});
test('两种共享组可原生导出再导入，实际成员与原始编号保持',()=>{
 const p=nativeToFragment(normalizeNativeWorkflow({nodes:[{id:'t',type:'prompt',x:60,y:70,text:'共享文本'},{id:'g',type:'group',x:0,y:0,items:['t']},{id:'pg',type:'promptGroup',x:400,y:0,items:['t']}],connections:[]}),[],'两类共享组');validateProject(p);assert.equal(p.nodes.length,3);assert.equal(p.groups.length,1);const raw=fragmentToNative(p,[]),restored=nativeToFragment(normalizeNativeWorkflow(raw),[],'重开');assert.deepEqual(raw.nodes.slice(1).map(n=>n.items),[['t'],['t']]);assert.deepEqual(restored.nodes.slice(1).map(n=>n.params.nativeCanvas.members.map(r=>r.sourceNodeId)),[[restored.nodes[0].id],[restored.nodes[0].id]]);
});
test('独立视觉组跨两个输入组保持，局部整理不再因双归属失败',()=>{
 const p=membershipFixture();p.groups=[{id:'visual',title:'独立视觉组',nodeIds:['x','y']}];const moved=edit(p,'b',['x']).project,arranged=arrangeCanvasSelection(moved,['a']);validateProject(arranged.project);assert.deepEqual(arranged.project.groups,p.groups);assert.deepEqual(arranged.project.nodes.find(n=>n.id==='b'),moved.nodes.find(n=>n.id==='b'));
});
test('同一文字属于两类组时，排布位移与固定源原子算法逐项一致',()=>{
 const source=readFileSync('tests/fixtures/reference/07-canvas.js','utf8');assert.equal(createHash('sha256').update(source).digest('hex'),'a1e2dd0ba845ededca8a4351d0889e3569bab46479715408d22d2512482de1ed');
 const code=source.slice(source.indexOf('function connectedClusterIds('),source.indexOf('function arrangeSelectedCanvasNodes('));
 const raw={nodes:[{id:'t',type:'prompt',x:50,y:100,text:'t'},{id:'g',type:'group',x:200,y:300,w:300,h:250,items:['t']},{id:'pg',type:'promptGroup',x:600,y:100,w:300,h:250,items:['t']},{id:'z',type:'prompt',x:0,y:0,text:'z'}],connections:[]};
 const p=nativeToFragment(normalizeNativeWorkflow(raw),[],'共享排布');p.groups=[];const rects=Object.fromEntries(p.nodes.map(n=>[n.id,{width:n.params.nativeCanvas.node.w||288,height:n.params.nativeCanvas.node.h||270}])),ids=[p.nodes[1].id,p.nodes[2].id,p.nodes[3].id],context=vm.createContext({nodes:structuredClone(raw.nodes),connections:[]},{codeGeneration:{strings:false,wasm:false}});vm.runInContext('function nodeRect(n){return{x:n.x,y:n.y,w:n.w||288,h:n.h||270}}\n'+code+'\narrangeIdsByConnections(["g","pg","z"]);',context,{timeout:200});const r=arrangeCanvasSelection(p,ids,{rects});assert.deepEqual(r.project.nodes.map(n=>[n.params.nativeCanvas.node.id,n.x,n.y]),JSON.parse(vm.runInContext('JSON.stringify(nodes.map(n=>[n.id,n.x,n.y]))',context)));
});
test('保存期间的新文字、素材和节点合并，冲突保留后来的本地编辑',()=>{
 const base=membershipFixture(),local=structuredClone(base),saved=edit(base,'a',['text','y']).project;saved.revision=1;local.nodes[0].text='较新的文字';local.nodes.push(makeNode('text',1,2,{id:'new-local',text:'保留新节点'}));const merged=mergeCanvasEdit(base,local,saved);assert.equal(merged.project.nodes[0].text,'较新的文字');assert(merged.project.nodes.some(n=>n.id==='new-local'));assert.equal(field(merged.project).sourceIndex,0);assert.deepEqual(merged.conflicts,[]);assert.equal(merged.dirty,true);
 const changed=structuredClone(base);field(changed).sourceIndex=7;const conflict=mergeCanvasEdit(base,changed,saved);assert.equal(field(conflict.project).sourceIndex,7);assert(conflict.conflicts.length);
});

test('固定源updateGroupMembership的80组中心命中/重叠/交接结果逐项对照',()=>{
 const source=readFileSync('tests/fixtures/reference/07-canvas.js','utf8');assert.equal(createHash('sha256').update(source).digest('hex'),'a1e2dd0ba845ededca8a4351d0889e3569bab46479715408d22d2512482de1ed');const fn=source.slice(source.indexOf('function updateGroupMembership('),source.indexOf('\nfunction portPoint(',source.indexOf('function updateGroupMembership(')));
 for(let seed=0;seed<80;seed++){
  const raw={nodes:[{id:'i',type:'image',x:(seed%10)*60-60,y:(seed%4)*110,w:100,h:100},{id:'t',type:'prompt',x:(seed%7)*65,y:(seed%5)*90,text:'完整文字',w:100,h:100},{id:'a',type:'group',x:0,y:0,w:300,h:300,items:['i','t']},{id:'b',type:'group',x:200,y:100,w:300,h:300,items:[]},{id:'pg',type:'promptGroup',x:100,y:200,w:300,h:300,items:[]},{id:'sink',type:'comfy',x:900,y:0,w:300,h:200}],connections:[{id:'it',from:'i',to:'sink'},{id:'at',from:'a',to:'sink'}]};
  const p=nativeToFragment(normalizeNativeWorkflow(raw),[],'固定源对照'),ids=new Map(p.nodes.map(n=>[String(n.params.nativeCanvas.node.id),n.id])),rects=Object.fromEntries(p.nodes.map(n=>[n.id,{width:n.params.nativeCanvas.node.w,height:n.params.nativeCanvas.node.h}]));
  const context=vm.createContext({nodes:structuredClone(raw.nodes),connections:structuredClone(raw.connections),CANVAS_GENERATOR_TYPES:['generator','midjourney','msgen','comfy','ltxDirector','video','rh','minimax'],canConnect:()=>true,uid:()=> 'new-edge',syncGeneratorInputs:()=>{},refreshGeneratorInputViews:()=>{},render:()=>{},scheduleSave:()=>{}},{codeGeneration:{strings:false,wasm:false}});
  vm.runInContext('function nodeRect(n){return{x:n.x,y:n.y,w:n.w,h:n.h,cx:n.x+n.w/2,cy:n.y+n.h/2}}\n'+fn+'\nupdateGroupMembership(nodes.slice(0,2));',context,{timeout:200});
  const plan=planInputGroupMembership(p,{mode:'drag',requestId:'oracle-'+seed,revision:p.revision,draft:structuredClone(p),movedIds:[ids.get('i'),ids.get('t')],rects}),actual=fragmentToNative(plan.project,[]),expected=JSON.parse(vm.runInContext('JSON.stringify({members:nodes.filter(n=>n.type.includes("roup")).map(n=>[n.id,n.items]),edges:connections.map(e=>[e.from,e.to])})',context));
  assert.deepEqual(actual.nodes.filter(n=>n.type.includes('roup')).map(n=>[n.id,n.items]),expected.members,'members '+seed);assert.deepEqual(actual.connections.map(e=>[e.from,e.to]),expected.edges,'edges '+seed);
 }
});
test('失败拖动撤回位置时保留提交后的文字/新节点，删除与排序冲突有明确结果',()=>{
 const base=membershipFixture(),moved=structuredClone(base);moved.nodes[1].x+=400;const later=structuredClone(moved);later.nodes[0].text='请求期间的较新正文';later.nodes.push(makeNode('text',20,20,{id:'late-node',text:'后来的节点'}));const restored=mergeCanvasEdit(moved,later,base);assert.equal(restored.project.nodes[1].x,base.nodes[1].x);assert.equal(restored.project.nodes[0].text,later.nodes[0].text);assert(restored.project.nodes.some(n=>n.id==='late-node'));assert.equal(restored.dirty,true);
 const local=structuredClone(base),saved=structuredClone(base);local.nodes=local.nodes.filter(n=>n.id!=='x').reverse();saved.nodes.find(n=>n.id==='x').title='远端改名';saved.revision=1;const conflict=mergeCanvasEdit(base,local,saved);assert(!conflict.project.nodes.some(n=>n.id==='x'));assert(conflict.conflicts.some(v=>v.includes('[x]')));assert.deepEqual(conflict.project.nodes.map(n=>n.id),local.nodes.map(n=>n.id));assert.equal(conflict.project.revision,1);
});
test('H3独立/本机/云绑定的全局与片段明确素材序号均保留原图',()=>{
 for(const placement of ['standalone','workflowBinding','cloudBinding']){
  const p=membershipFixture(),target=p.nodes.find(n=>n.id==='target');target.type='video';const timeline=normalizeMinimaxTimeline({version:1,engine:placement==='cloudBinding'?'runninghub':'comfyui',selectedSegmentId:'s',refs:[{kind:'image',sourceNodeId:'a',sourceIndex:1}],segments:[newMinimaxSegment('s',0,{refs:[{kind:'image',sourceNodeId:'a',sourceIndex:1}]})]});
  if(placement==='standalone')target.params.minimaxH3=timeline;else if(placement==='cloudBinding'){delete target.params.workflowBinding;target.params.cloudBinding={recipeId:'cloud-fixture',recipeRevision:0,inputs:[],minimaxH3:timeline};}else target.params.workflowBinding.minimaxH3=timeline;
  for(const ids of [['text','y'],['text','x']]){const result=edit(p,'a',ids).project,n=result.nodes.find(n=>n.id==='target'),t=placement==='standalone'?n.params.minimaxH3:n.params[placement].minimaxH3;for(const ref of [t.refs[0],t.segments[0].refs[0]])assert.deepEqual(ref,{kind:'image',sourceNodeId:ids.includes('y')?'a':'y',sourceIndex:0},placement);validateProject(result);}
 }
});
test('LTX图像片段的单张选择在清空来源组后仍指向原生产节点',()=>{
 const p=membershipFixture(),target=p.nodes.find(n=>n.id==='target');target.type='video';target.params.workflowBinding.ltxDirector=normalizeLtxTimeline({nodeId:'ltx',segments:[{id:'segment',type:'image',start:0,length:120,sourceNodeId:'a',sourceIndex:1,prompt:'保留原片段'}],audioSegments:[]});const result=edit(p,'a',[]).project,segment=result.nodes.find(n=>n.id==='target').params.workflowBinding.ltxDirector.segments[0];assert.equal(segment.sourceNodeId,'y');assert.equal(segment.sourceIndex,0);assert.equal(segment.prompt,'保留原片段');assert(result.edges.some(e=>e.source==='y'&&e.target==='target'));validateProject(result);
});
