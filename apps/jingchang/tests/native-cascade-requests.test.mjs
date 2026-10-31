import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {cascadeProtocolFixture} from './helpers/native-cascade-protocol-fixture.mjs';
import {nativeCascadeChildAdapter} from '../lib/native-cascade-children.mjs';
import {nativeCascadeRequestPreparer} from '../lib/native-cascade-requests.mjs';
import {executeNativeCascade} from '../lib/native-cascade-execution.mjs';
import {planNativeCascade} from '../lib/native-cascade-plan.mjs';
import {readJson} from '../lib/workspace.mjs';

const digest=url=>createHash('sha256').update(url).digest('hex');
async function fixture(t,options={}){
 const f=await cascadeProtocolFixture(t,options),node=f.project.nodes.find(node=>node.params.workflowBinding);
 if(node){
  const template=await f.generation.template(node.params.workflowBinding.workflowId);
  await f.generation.configure(template.id,{revision:template.revision,nativeConfig:{fields:[
   {id:'original-prompt',node:'1',input:'text',name:'正向提示词',type:'textarea',default:'原模板默认'},
   {id:'original-image',node:'3',input:'image',name:'参考图',type:'image',default:'未上传.png'}
  ]}});
 }
 const authorizationFor=async(request,step)=>({origin:f.endpoint,...(step.kind==='runninghub'?{kind:step.recipe.kind,targetId:step.recipe.targetId,sendFields:true,sendAssets:step.sendAssets}:{model:step.image?.model||step.studio.config.model,sendPrompt:true,sendReferences:step.sendAssets}),requestLimit:1,budget:1,currency:'CNY'});
 const preparer=(settings={})=>nativeCascadeRequestPreparer({...f,endpoint:f.pool[0],authorizationFor,...settings});
 const adapter=(settings={})=>nativeCascadeChildAdapter({...f,project:f.project,program:f.program,parentId:f.parentId,prepare:preparer(settings).prepare,
  credentialsFor:async()=>({apiKey:'synthetic-only-cascade-production'}),pollInterval:10});
 const execute=async(settings={})=>{const a=adapter(settings),state=await executeNativeCascade({project:f.project,program:f.program,generate:a.generate,persist:f.persist});await f.waitChildren();return state;};
 const request=(id='A',extra={})=>({project:f.project,requestNode:structuredClone(f.project.nodes.find(node=>node.id===id)),operation:{requestNodeId:id},referenceRefs:[],context:{roundIndex:0,index:1,total:1},...extra});
 return{...f,preparer,adapter,execute,request};
}

test('生产请求准备接实际Comfy链，精确提示词无普通上下文前缀，结果归接收节点',async t=>{
 const f=await fixture(t),before=structuredClone(f.project),state=await f.execute();
 assert.equal(state.status,'completed',state.error);assert.deepEqual(f.state.prompts.map(record=>record.body.prompt['1'].inputs.text),['参数属于 A','参数属于 B']);
 assert.equal(f.state.uploads.length,2);assert.deepEqual(f.project,before);
 const children=await Promise.all(state.rounds[0].receipts.map(receipt=>readJson(path.join(f.data,'jobs',receipt.childJobId+'.json'))));
 assert.deepEqual(children.map(child=>child.target.id),['A','B']);assert.equal(state.receivers.B.currentRefs[0].assetId,children[0].assets[0].id);assert.equal(state.receivers.C.currentRefs[0].assetId,children[1].assets[0].id);
 assert.ok(!JSON.stringify(await f.readState()).includes('synthetic-only-cascade-production'));
});
test('生产同级共享只生成一次，共享后的两条子链分别使用自身配置',async t=>{
 const f=await fixture(t,{pairs:[['A','B'],['A','C'],['B','D'],['C','E']]}),state=await f.execute();
 assert.equal(state.status,'completed',state.error);assert.equal(f.state.prompts.length,3);
 assert.deepEqual(f.state.prompts.map(record=>record.body.prompt['1'].inputs.text),['参数属于 A','参数属于 B','参数属于 C']);
 assert.equal(state.receivers.B.currentRefs[0].assetId,state.receivers.C.currentRefs[0].assetId);
});
test('生产Comfy→RunningHub按字段角色送提示词和素材，正常字符串设置保持',async t=>{
 const f=await fixture(t,{kinds:{B:'runninghub'}}),binding=f.project.nodes.find(node=>node.id==='B').params.cloudBinding,recipe=await f.cloudWorkflows.get(binding.recipeId);
 const updated=await f.cloudWorkflows.save(recipe.id,{...recipe,fields:[...recipe.fields,{nodeId:'3',fieldName:'checkpoint_name',type:'text',fieldValue:'fixed.safetensors'}]});binding.recipeRevision=updated.revision;
 f.program=planNativeCascade(f.project,{nodeId:'C'});const state=await f.execute();
 assert.equal(state.status,'completed',state.error);assert.equal(f.state.rhCreates.length,1);
 const fields=f.state.rhCreates[0].body.nodeInfoList;assert.equal(fields.find(field=>field.fieldName==='text').fieldValue,'参数属于 B');assert.equal(fields.find(field=>field.fieldName==='checkpoint_name').fieldValue,'fixed.safetensors');
 assert.equal(f.state.prompts.length,1);assert.equal(f.state.uploads.length,2);
});
test('RunningHub明确固定提示词参数优先，自动组合不覆盖它',async t=>{
 const f=await fixture(t,{kinds:{A:'runninghub'}}),binding=f.project.nodes.find(node=>node.id==='A').params.cloudBinding;
 binding.overrides=[{nodeId:'1',fieldName:'text',fieldValue:'明确固定值'}];f.program=planNativeCascade(f.project,{nodeId:'C'});
 const state=await f.execute();assert.equal(state.status,'completed',state.error);assert.equal(f.state.rhCreates[0].body.nodeInfoList.find(field=>field.fieldName==='text').fieldValue,'明确固定值');
});
test('RunningHub空编辑器只使用已保存提示词字段的默认建议',async t=>{
 const f=await fixture(t,{kinds:{A:'runninghub'}}),node=f.project.nodes.find(node=>node.id==='A');node.params.nativeCanvas.node.promptDraftHtml='';node.params.nativeCanvas.node.promptDraftText='';
 const prepared=await f.preparer().prepare(f.request());assert.equal(prepared.ledger.prompt,'old');assert.equal(prepared.recipe.fields.find(field=>field.fieldName==='text').fieldValue,'old');assert.equal(f.state.rhCreates.length,0);
});
test('Comfy→方舟视频生产准备保持视频参数，图片结果进入对应接收方',async t=>{
 const f=await fixture(t,{kinds:{B:'studio'}}),state=await f.execute();
 assert.equal(state.status,'completed',state.error);assert.equal(f.state.studioCreates.length,1);
 const body=f.state.studioCreates[0].body;assert.equal(body.content.find(item=>item.type==='text').text,'参数属于 B');assert.equal(body.duration,5);assert.equal(body.model,'synthetic-ark-video');
 assert.equal(state.receivers.C.currentRefs[0].kind,'video');assert.equal(state.receivers.B.currentRefs[0].kind,'image');
});
test('图片API的两个URL角色共用本机文件时实际发送两份，提示词编号仍为图1/图2',async t=>{
 const f=await fixture(t,{pairs:[['A','B']],kinds:{A:'image-api'}}),node=f.project.nodes.find(node=>node.id==='A'),native=node.params.nativeCanvas,url=native.resources[0].url;
 native.node.images=[{url,name:'第一引用',kind:'image'},{url:url+'-alias',name:'第二引用',kind:'image'}];native.resources.push({...native.resources[0],url:url+'-alias'});
 native.node.promptDraftHtml=`<span class="mention-image-token" data-url="${url}" data-name="第一引用">@第一引用</span>与<span class="mention-image-token" data-url="${url}-alias" data-name="第二引用">@第二引用</span>`;
 f.program=planNativeCascade(f.project,{nodeId:'B'});const state=await f.execute();
 assert.equal(state.status,'completed',state.error);assert.equal(f.state.images.length,1);assert.equal(f.state.images[0].images.length,2);
 const wirePrompt=f.state.images[0].prompt.replaceAll('\r\n','\n');
 assert.deepEqual(f.state.images[0].images[0].bytes,f.state.images[0].images[1].bytes);assert.match(wirePrompt,/下面是参考图编号：\n图1：第一引用\n图2：第二引用/);assert.match(wirePrompt,/用户需求：\n图1与图2$/);
 const child=await readJson(path.join(f.data,'jobs',state.rounds[0].receipts[0].childJobId+'.json'));assert.equal(child.input.prompt,wirePrompt);assert.equal(child.input.referenceIds.length,2);assert.equal(child.input.referenceIds[0],child.input.referenceIds[1]);
});
test('明确绑定的includeUpstream关闭不移除源串联当前输入文字，原绑定保持',async t=>{
 const f=await fixture(t,{pairs:[['A','B']],kinds:{A:'image-api'}}),node=f.project.nodes.find(node=>node.id==='A');node.params.imageBinding.includeUpstream=false;
 const input=f.graph.node('P',{kind:'smart-prompt',stored:false,raw:{text:'直接输入'}});input.text='直接输入';f.graph.edge(input,node,'input');
 const prepared=await f.preparer().prepare(f.request());assert.equal(prepared.step.text,'直接输入\n\n参数属于 A');assert.equal(node.params.imageBinding.includeUpstream,false);assert.equal(f.state.images.length,0);
});
test('原生Comfy配置首个提示词角色接组合，后续角色恢复默认，固定设置保持',async t=>{
 const f=await fixture(t),node=f.project.nodes.find(node=>node.id==='A'),original=await f.generation.template(node.params.workflowBinding.workflowId);
 const template=await f.generation.saveTemplate({name:'原字段角色协议',workflow:{...original.workflow,'4':{class_type:'CLIPTextEncode',inputs:{text:'原始负向'}},'5':{class_type:'Setting',inputs:{checkpoint_name:'原模型',steps:20}}},nativeConfig:{fields:[
  {id:'first',node:'1',input:'text',name:'正向',type:'textarea',default:'默认正向'},
  {id:'second',node:'4',input:'text',name:'负向',type:'textarea',default:'默认负向'},
  {id:'model',node:'5',input:'checkpoint_name',name:'模型',type:'text',default:'已选模型'},
  {id:'steps',node:'5',input:'steps',name:'步数',type:'number',default:20}
 ]}});
 node.params.workflowBinding={...node.params.workflowBinding,workflowId:template.id,promptField:null,overrides:[{nodeId:'4',name:'text',value:'原节点负向'},{nodeId:'5',name:'steps',value:25}]};
 const prepared=await f.preparer().prepare(f.request()),values=prepared.body.overrides;
 assert.equal(values.find(field=>field.nodeId==='1').value,'参数属于 A');assert.equal(values.find(field=>field.nodeId==='4').value,'默认负向');assert.equal(values.find(field=>field.nodeId==='5').value,25);
 assert.equal(prepared.ledger.promptFields.length,2);assert.equal((await f.generation.template(template.id)).workflow['5'].inputs.checkpoint_name,'原模型');assert.equal(f.state.prompts.length,0);
});
test('智能串联20个媒体角色可实际提交，普通生成16字段限制保持',async t=>{
 const f=await fixture(t,{pairs:[['A','B']]}),node=f.project.nodes.find(node=>node.id==='A'),old=await f.generation.template(node.params.workflowBinding.workflowId),workflow={...old.workflow},fields=[{id:'prompt',node:'1',input:'text',name:'提示词',type:'textarea',default:'原值'}];
 for(let i=0;i<20;i++){const id=String(10+i);workflow[id]={class_type:'LoadImage',inputs:{image:'未上传.png'}};fields.push({id:'image-'+i,node:id,input:'image',name:'图'+i,type:'image',default:'未上传.png'});}
 const template=await f.generation.saveTemplate({name:'二十引用字段',workflow,nativeConfig:{fields}});node.params.workflowBinding={...node.params.workflowBinding,workflowId:template.id};
 const native=node.params.nativeCanvas,base=native.resources[0];native.node.images=[];native.resources=[];
 for(let i=0;i<20;i++){const url=base.url+'-'+i;native.node.images.push({url,name:'图'+i,kind:'image'});native.resources.push({...base,url});}
 f.program=planNativeCascade(f.project,{nodeId:'B'});const state=await f.execute();assert.equal(state.status,'completed',state.error);assert.equal(f.state.prompts.length,1);assert.equal(f.state.uploads.length,1);
 const child=await readJson(path.join(f.data,'jobs',state.rounds[0].receipts[0].childJobId+'.json'));assert.equal(child.imageBindings.length,20);
 const ordinaryProject=(await f.preparer().prepare(f.request('A',{referenceRefs:state.rounds[0].receipts[0].inputRefs}))).project;
 await assert.rejects(f.generation.start(ordinaryProject,{workflowId:template.id,overrides:[],imageBindings:child.imageBindings,nodeId:'A'},f.pool[0],{nativeFlow:true,parentId:f.parentId}),/最多16项/);assert.equal(f.state.prompts.length,1);
});
test('工作流只有一个媒体槽时按源顺序使用首项，并明确记录未使用引用',async t=>{
 const f=await fixture(t),node=f.project.nodes.find(node=>node.id==='A'),assets=f.project.assets.slice(0,2),refs=assets.map((asset,i)=>({assetId:asset.id,kind:'image',name:asset.name,identity:digest('/selection/'+i)}));
 const prepared=await f.preparer().prepare(f.request('A',{referenceRefs:refs}));assert.equal(prepared.body.imageBindings.length,1);assert.equal(prepared.body.imageBindings[0].assetId,assets[0].id);assert.equal(prepared.ledger.unusedRefs[0].assetId,assets[1].id);assert.equal(prepared.ledger.roles.length,2);assert.equal(f.state.uploads.length,0);
});
test('直接输入和本次中继保留计数，不纳入其他普通上游节点文字',async t=>{
 const f=await fixture(t),node=f.project.nodes.find(node=>node.id==='A');const loop=f.graph.node('L',{kind:'smart-loop',stored:false,showPrompt:true,count:9,start:1}),foreign=f.graph.node('F',{stored:false,raw:{promptDraftHtml:'普通上游不混入'}});
 loop.params.nativeLoop.variablePrompt='轮《计数》/《总数》/《进度》';f.graph.edge(loop,node,'input');f.graph.edge(foreign,node);
 const prepared=await f.preparer().prepare(f.request('A',{context:{roundIndex:4,index:5,total:9,loopContexts:{L:{index:5,total:9}},relayPromptNodeIds:['L']}}));assert.equal(prepared.ledger.prompt,'轮5/9/5/9\n\n参数属于 A');assert.ok(!prepared.ledger.prompt.includes('普通上游'));
});
test('原绑定每子任务批次保持，逻辑生成数和实际请求数分别可核对',async t=>{
 const f=await fixture(t);for(const node of f.project.nodes)node.params.workflowBinding.count=2;f.program=planNativeCascade(f.project,{nodeId:'C'});
 const state=await f.execute();assert.equal(state.status,'completed',state.error);assert.equal(f.program.generationOperationCount,2);assert.equal(f.state.prompts.length,4);assert.equal(state.receivers.C.currentRefs.length,2);
 const child=await readJson(path.join(f.data,'jobs',state.rounds[0].receipts[0].childJobId+'.json'));assert.equal(child.count,2);assert.equal(child.items.length,2);
});
test('缺少具体授权或服务范围错误时生产准备不提交云任务',async t=>{
 const f=await fixture(t,{pairs:[['A','B']],kinds:{A:'runninghub'}});
 await assert.rejects(f.preparer({authorizationFor:undefined}).prepare(f.request()),/尚未确认/);
 await assert.rejects(f.preparer({authorizationFor:async()=>({origin:'https://wrong.example',kind:'app',targetId:'12345',sendFields:true,sendAssets:false,requestLimit:1,budget:1,currency:'CNY'})}).prepare(f.request()),/确认/);
 assert.equal(f.state.rhCreates.length,0);assert.equal(f.state.uploads.length,0);
});
test('准备前再次检查实际文件类型与来源，无法用视频角色发送图片文件',async t=>{
 const f=await fixture(t),node=f.project.nodes.find(node=>node.id==='A'),old=await f.generation.template(node.params.workflowBinding.workflowId);
 const template=await f.generation.saveTemplate({name:'视频角色',workflow:{...old.workflow,'4':{class_type:'LoadVideo',inputs:{file:'原片.mp4'}}},nativeConfig:{fields:[{id:'v',node:'4',input:'file',name:'视频',type:'video',default:'原片.mp4'}]}});node.params.workflowBinding.workflowId=template.id;node.params.workflowBinding.promptField=null;
 await assert.rejects(f.preparer().prepare(f.request('A',{referenceRefs:[{assetId:f.project.assets[0].id,kind:'video',name:'伪视频'}]})),/格式不匹配/);assert.equal(f.state.prompts.length,0);assert.equal(f.state.uploads.length,0);
});
test('原节点配置版本或发送方快照变化时拒绝准备，导演参数不被压平成普通请求',async t=>{
 const f=await fixture(t),request=f.request();request.requestNode.title='伪发送方';await assert.rejects(f.preparer().prepare(request),/原参数快照/);
 const node=f.project.nodes.find(node=>node.id==='A');node.params.workflowBinding.imageEnhance={version:1};await assert.rejects(f.preparer().prepare(f.request()),/专用导演/);
 assert.equal(f.state.prompts.length,0);assert.equal(f.state.uploads.length,0);
});
