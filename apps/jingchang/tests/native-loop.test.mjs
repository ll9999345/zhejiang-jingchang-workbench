import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {nativeToFragment,normalizeNativeWorkflow,fragmentToNative} from '../lib/native-canvas-core.mjs';
import {nativeLoopSettings,normalizeNativeLoopSettings,nativeLoopRoundContext,nativeLoopLocalPromptFields} from '../public/native-loop-core.js';
import {applyNativeLoopSettings,readNativeLoopForm,nativeLoopPreviewMarkup} from '../public/native-loop.js';
import {nativeFlowPreview} from '../lib/native-flow.mjs';
import {nativeReferenceChoices} from '../public/native-flow-ui.js';
import {validateProject,makeNode} from '../lib/model.mjs';
import {selectCanvasBackends} from '../lib/comfy-backends.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {nativeLoopFixture,source} from './helpers/native-loop-fixture.mjs';

function fixture(type='smart-loop',extra={}){const p=nativeToFragment(normalizeNativeWorkflow({nodes:[source('loop',type,extra)],connections:[]}),[],'循环设置样本');return{p,node:p.nodes[0]};}
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

test('导入循环默认未启用；设置保存只新增覆盖参数，源原始字段不变',()=>{
 const {p,node}=fixture('loop',{count:100,loopStart:9999,imageBatchSize:100,foreign:'保留源参数',variablePrompt:'源文字'}),original=structuredClone(node.params.nativeCanvas.node),settings=nativeLoopSettings(node);
 assert.equal(settings.enabled,false);applyNativeLoopSettings(node,{...settings,enabled:true,mode:'parallel',imageInput:true});assert.deepEqual(nativeLoopRoundContext(node,99),{index:19899,total:19899});assert.deepEqual(node.params.nativeCanvas.node,original);assert.deepEqual(p.runs,[]);validateProject(p);
});
test('轮数、计数、媒体批次、枚举、提示词容量与未知字段严格拒绝',()=>{
 const {node}=fixture(),s=nativeLoopSettings(node);
 for(const change of [{count:101},{count:1.5},{start:0},{start:10000},{imageBatchSize:101},{videoBatchSize:0},{mode:'random'},{enabled:'true'},{version:2},{variablePrompts:Array(101).fill('a')},{variablePrompts:['x'.repeat(32001)]},{variablePrompt:'x'.repeat(200001)},{unknown:true}])assert.throws(()=>normalizeNativeLoopSettings({...s,...change}),/设置无效/);
 applyNativeLoopSettings(node,{...s,enabled:true,count:2});assert.throws(()=>nativeLoopRoundContext(node,2),/不存在/);const ordinary=makeNode('text',0,0,{params:{nativeLoop:s}});const {p}=fixture();p.nodes.push(ordinary);assert.throws(()=>validateProject(p),/原生循环/);
});
test('智能循环数组空条目和空数组分别保留原始优先规则，编号或逐行备用文字兼容',()=>{
 const {node}=fixture('smart-loop',{variablePrompt:'1. 甲\n2、 乙',variablePrompts:['']});let s=nativeLoopSettings(node);assert.deepEqual(nativeLoopLocalPromptFields(s),[]);
 assert.deepEqual(nativeLoopLocalPromptFields({...s,variablePrompts:[]}),['甲','乙']);assert.deepEqual(nativeLoopLocalPromptFields({...s,variablePrompts:null,variablePrompt:'甲\r\n\r\n乙'}),['甲','乙']);assert.deepEqual(nativeLoopLocalPromptFields({...s,variablePrompts:[' a ','','b']}),['a','b']);
});
test('表单保存显式启用、串并行和列表，预览转义源文本而不产生任务',()=>{
 const {node}=fixture('smart-loop',{variablePrompt:'旧参数'}),elements=Object.fromEntries(Object.entries({mode:'parallel',count:'3',start:'2',imageBatchSize:'2',videoBatchSize:'1',variablePrompt:'<script>合成</script>',variablePrompts:'甲《计数》\n乙'}).map(([key,value])=>[key,{value}]));Object.assign(elements,{enabled:{checked:true},showPrompt:{checked:true},imageInput:{checked:true}});
 const s=readNativeLoopForm({elements},node);assert.equal(s.videoInput,false);assert.deepEqual(s.variablePrompts,['甲《计数》','乙']);assert.equal(s.enabled,true);const html=nativeLoopPreviewMarkup(node,{...s,variablePrompts:null},esc);assert.match(html,/计数 2 → 6/);assert.match(html,/总数占位符 6/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.equal(node.params.nativeLoop,undefined);
});
test('智能循环以混合媒体整体批次轮换，普通循环分别切图片和视频',()=>{
 const media=[{id:'a',type:'image/png',name:'甲'},{id:'b',type:'audio/wav',name:'乙'},{id:'c',type:'video/mp4',name:'丙'},{id:'d',type:'image/png',name:'丁'}],resources=media.map(a=>({asset:a,url:'/fixture/'+a.id,archive:'resources/'+a.id,portableUrl:'/media/'+a.id}));
 for(const smart of [false,true]){
  const p=nativeToFragment(normalizeNativeWorkflow({nodes:[source('all','output',{images:resources.map(r=>r.url)}),source('loop',smart?'smart-loop':'loop',{loopStart:2,count:2,imageInput:true,imageBatchSize:2,videoInput:true,videoBatchSize:1})],connections:[{from:'all',to:'loop'}]}),resources,'混合媒体'),node=p.nodes[1];applyNativeLoopSettings(node,{...nativeLoopSettings(node),enabled:true});const value=nativeFlowPreview(p,{nodeId:node.id,loopContexts:{[node.id]:nativeLoopRoundContext(node,0)}}).nodes[0];assert.deepEqual(value.media.map(m=>m.assetId),smart?['b','c']:['d']);
  const target=makeNode('image',0,0);p.nodes.push(target);p.edges.push({id:'to-generator',source:node.id,target:target.id});const choice=nativeReferenceChoices(p,target.id).find(c=>c.value==='node:'+node.id);assert.deepEqual(choice.kinds,smart?['audio','video']:['image']);
 }
});
test('并行后端只接收已保存编号，重复、未知、超量及未授权局域网在提交前拒绝',()=>{
 const config={comfyBackends:[{id:'local-a',name:'甲',url:'http://127.0.0.1:8188'},{id:'local-b',name:'乙',url:'http://127.0.0.1:8189'},{id:'lan',name:'局域网',url:'http://192.168.1.2:8188'}],activeComfyBackendId:'local-a'};
 assert.deepEqual(selectCanvasBackends(config,{parallelBackendIds:['local-a','local-b']}).parallelBackends.map(b=>b.id),['local-a','local-b']);
 for(const ids of [[],['local-a','local-a'],['unknown'],['lan'],Array(7).fill('local-a'),'http://localhost:8188'])assert.throws(()=>selectCanvasBackends(config,{parallelBackendIds:ids}),/后端|授权/);assert.equal(selectCanvasBackends(config,{}).parallelBackends,undefined);
});
test('100轮规划保留起始计数、步幅和占位符；禁用或绑定在循环自身的请求提前拒绝',async t=>{
 const f=await nativeLoopFixture(t,{count:100,start:9999,media:1,batch:100}),steps=await f.runner.plan(f.project);assert.equal(steps.length,100);assert.equal(steps.at(-1).nativeLoop.index,19899);assert.match(steps[0].text,/9999\/19899/);assert.match(steps.at(-1).text,/19899\/19899/);assert.equal(f.state.prompts.length,0);
 applyNativeLoopSettings(f.loop,{...nativeLoopSettings(f.loop),enabled:false});await assert.rejects(f.runner.plan(f.project),/尚未启用/);applyNativeLoopSettings(f.loop,{...nativeLoopSettings(f.loop),enabled:true});f.loop.params.workflowBinding=structuredClone(f.node('generate0').params.workflowBinding);await assert.rejects(f.runner.plan(f.project),/下游节点/);assert.equal(f.state.prompts.length,0);
});
test('嵌套与双循环重叠仍有明确阻断，不默认运行部分链路',async t=>{
 const f=await nativeLoopFixture(t),second=structuredClone(f.loop);second.id='second-native-loop';second.params.nativeCanvas.node.id='second';f.project.nodes.push(second);f.project.edges.push({id:'nested-loop',source:f.loop.id,target:second.id},{id:'second-generator',source:second.id,target:f.node('generate0').id});await assert.rejects(f.runner.plan(f.project),/嵌套/);f.project.edges=f.project.edges.filter(edge=>edge.id!=='nested-loop');await assert.rejects(f.runner.plan(f.project),/两条原生循环/);assert.equal(f.state.prompts.length,0);
});
test('无模型绑定的纯原生 JSON 导出当前循环参数，内部源记录保持不变，再导入仍需启用',()=>{
 const {p,node}=fixture('smart-loop',{count:2,foreign:'源参数',variablePrompt:'原文'}),raw=structuredClone(node.params.nativeCanvas.node);applyNativeLoopSettings(node,{...nativeLoopSettings(node),enabled:true,count:3,start:4,mode:'parallel',variablePrompts:['甲','乙']});const exported=fragmentToNative(p,[]),roundTrip=nativeToFragment(exported,[],'再导入');assert.equal(exported.nodes[0].count,3);assert.equal(exported.nodes[0].loopStart,4);assert.equal(exported.nodes[0].mode,'parallel');assert.deepEqual(exported.nodes[0].variablePrompts,['甲','乙']);assert.equal(nativeLoopSettings(roundTrip.nodes[0]).enabled,false);assert.deepEqual(node.params.nativeCanvas.node,raw);
});

function changedManifest(bytes,change){const offset=Buffer.byteLength('JINGCHANG-PACK-1\n'),size=bytes.readUInt32BE(offset),manifest=JSON.parse(bytes.subarray(offset+4,offset+4+size));change(manifest);const json=Buffer.from(JSON.stringify(manifest)),length=Buffer.alloc(4);length.writeUInt32BE(json.length);return Buffer.concat([bytes.subarray(0,offset),length,json,bytes.subarray(offset+4+size)]);}
async function receiver(){const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-loop-bundle-')),activeJobs=new Map();let restored;const projects={load:async()=>{if(restored)return restored;throw Object.assign(Error('missing'),{status:404});},save:async project=>(restored=project)};return{data,activeJobs,bundles:projectBundleService({data,activeJobs,projects}),restored:()=>restored};}
test('第31版备份包含执行设置、分组映射和原参数；降级或损坏参数在写入项目前拒绝',async t=>{
 const f=await nativeLoopFixture(t,{media:3,smart:true,mode:'parallel'}),original=structuredClone(f.project),bundles=projectBundleService({...f,projects:{load:async()=>f.project}}),out=await bundles.exportBundle(f.project.id,0);assert.equal(out.formatVersion,31);const bytes=await fs.readFile(await bundles.download(out.id)),target=await receiver();
 for(const change of [m=>m.version=30,m=>m.project.nodes.find(n=>n.params.nativeLoop).params.nativeLoop.count=101]){await assert.rejects(target.bundles.upload(Readable.from([changedManifest(bytes,change)])),/第31版|设置无效/);assert.equal(target.restored(),undefined);}
 const preview=await target.bundles.upload(createReadStream(await bundles.download(out.id))),restored=await target.bundles.importBundle(preview.id),loop=restored.nodes.find(n=>n.params.nativeLoop);assert.deepEqual(loop.params.nativeLoop,f.loop.params.nativeLoop);assert.deepEqual(loop.params.nativeCanvas.node,f.loop.params.nativeCanvas.node);assert.deepEqual(restored.runs,[]);assert.equal(target.activeJobs.size,0);validateProject(restored);assert.deepEqual(f.project,original);
});
test('第23版仅含原始循环的旧备份继续恢复为未启用状态',async()=>{
 const {p,node}=fixture('loop',{count:100,loopStart:7}),data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-loop-legacy-')),bundles=projectBundleService({data,activeJobs:new Map(),projects:{load:async()=>p}}),out=await bundles.exportBundle(p.id,0);assert.equal(out.formatVersion,23);const target=await receiver(),preview=await target.bundles.upload(createReadStream(await bundles.download(out.id))),restored=await target.bundles.importBundle(preview.id);assert.equal(nativeLoopSettings(restored.nodes[0]).enabled,false);assert.equal(restored.nodes[0].params.nativeLoop,undefined);assert.deepEqual(restored.nodes[0].params.nativeCanvas.node,node.params.nativeCanvas.node);
});
