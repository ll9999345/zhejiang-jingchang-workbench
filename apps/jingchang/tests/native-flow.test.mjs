import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeNativeWorkflow,nativeToFragment,fragmentToNative} from '../lib/native-canvas-core.mjs';
import {nativeFlowPreview,nativeFlowDependencyOrder,orderedNativeInputIds,splitNativePrompt,splitNativeNumberedPrompts,nativeFlowOutputsFromJob} from '../lib/native-flow.mjs';
import {makeProject,makeNode,validateProject} from '../lib/model.mjs';

const picture=(id,name=id)=>({id,name,type:'image/png'}),video=id=>({id,name:id,type:'video/mp4'}),audio=id=>({id,name:id,type:'audio/wav'});
const source=(id,type,extra={})=>({id,type,x:0,y:0,...extra});
function fixture(nodes,edges=[],assets=[],smart=false){
 const resources=assets.map(asset=>({url:'/source/'+asset.id,archive:'resources/'+asset.id,portableUrl:'/media/'+asset.id,asset}));
 const doc=normalizeNativeWorkflow({format:smart?'infinite-smart-canvas-workflow':'infinite-canvas-workflow',version:1,nodes,connections:edges.map(([from,to])=>({from,to}))});
 const p=nativeToFragment(doc,resources,'原生数据流专项');
 const id=raw=>p.nodes.find(n=>n.params.nativeCanvas.node.id===raw).id;
 const value=(raw,options={})=>nativeFlowPreview(p,{nodeId:id(raw),...options});
 return{p,id,value};
}

test('智能分隔符为字面文本：多字符、中文、正则符号和空分隔符均保留源语义',()=>{
 assert.deepEqual(splitNativePrompt('甲||乙||丙',{enabled:true,separator:'||'}),['甲','乙','丙']);
 assert.deepEqual(splitNativePrompt('甲.乙',{enabled:true,separator:'.'}),['甲','乙']);
 assert.deepEqual(splitNativePrompt('甲；乙',{enabled:true,separator:'；'}),['甲','乙']);
 assert.deepEqual(splitNativePrompt(' 甲;乙 ',{enabled:true,separator:''}),['甲','乙']);
 assert.deepEqual(splitNativePrompt('甲;乙',{enabled:false}),['甲;乙']);
 assert.deepEqual(splitNativePrompt(' ; ; ',{enabled:true}),['; ;']);
 assert.deepEqual(splitNativePrompt('甲;', {enabled:true}),['甲;']);
 assert.deepEqual(splitNativePrompt('',{enabled:true}),[]);
 assert.throws(()=>splitNativePrompt('x',{enabled:true,separator:'123456789'}),/8/);
});

test('编号及逐行提示词兼容固定源算法，不把独立智能分隔符改成编号拆分',()=>{
 assert.deepEqual(splitNativeNumberedPrompts('1. 第一个\n2、 第二个'),['第一个','第二个']);
 assert.deepEqual(splitNativeNumberedPrompts('甲\r\n\r\n乙'),['甲','乙']);
 assert.deepEqual(splitNativeNumberedPrompts('甲;乙'),['甲;乙']);
});

test('提示词组按照成员顺序聚合，不受节点列表及连线次序影响，不修改源项目',()=>{
 const f=fixture([source('b','prompt',{text:'乙'}),source('a','prompt',{text:'甲'}),source('g','promptGroup',{items:['a','b']})]);
 const before=structuredClone(f.p),v=f.value('g');assert.deepEqual(v.nodes[0].promptItems,['甲','乙']);assert.equal(v.nodes[0].status,'resolved');assert.deepEqual(f.p,before);
 const order=nativeFlowDependencyOrder(f.p);assert.ok(order.indexOf(f.id('a'))<order.indexOf(f.id('g')));assert.ok(order.indexOf(f.id('b'))<order.indexOf(f.id('g')));
});

test('普通素材组传递全部三类媒体及提示词，并保留成员顺序和来源',()=>{
 const f=fixture([source('a','image',{url:'/source/a'}),source('b','image',{url:'/source/b'}),source('c','image',{url:'/source/c'}),source('t','prompt',{text:'组提示词'}),source('g','group',{items:['c','a','t','b']})],[],[picture('a'),video('b'),audio('c')]);
 const v=f.value('g').nodes[0];assert.deepEqual(v.promptItems,['组提示词']);assert.deepEqual(v.media.map(a=>[a.assetId,a.kind]),[['c','audio'],['a','image'],['b','video']]);assert.deepEqual(v.media.map(a=>a.sourceNodeId),[f.id('c'),f.id('a'),f.id('b')]);
});

test('智能素材自身的重复条目不因素材库去重而丢失，同一文件两次仍保留位置',()=>{
 const f=fixture([source('a','smart-image',{images:[{url:'/source/a'},{url:'/source/b'},{url:'/source/a'}]})],[],[picture('a'),audio('b')],true);
 assert.deepEqual(f.value('a').nodes[0].media.map(m=>[m.assetId,m.index]),[['a',0],['b',1],['a',2]]);
});

test('首节点保管的未引用备份文件不会变成节点输出',()=>{
 const f=fixture([source('t','smart-prompt',{text:'甲'}),source('a','smart-image',{images:[{url:'/source/a'}]})],[],[picture('a'),picture('unused')],true);
 assert.equal(f.p.nodes[0].params.nativeCanvas.resources.length,2);assert.deepEqual(f.value('t').nodes[0].media,[]);assert.deepEqual(f.value('a').nodes[0].media.map(a=>a.assetId),['a']);
});

test('文件别名与节点编号或文字相同，导入导出仍保留标识、成员、输入和文字',()=>{
 const asset={...picture('a'),size:1},resources=[{url:'/source/a',archive:'resources/a',portableUrl:'/media/a',asset}];
 const document=normalizeNativeWorkflow({nodes:[source('a','image',{url:'/source/a',name:'a'}),source('p','prompt',{text:'a'}),source('g','group',{items:['a','p']}),source('c','comfy',{inputs:['a','p'],outputText:'a'})],connections:[{from:'a',to:'c'},{from:'p',to:'c'}]});
 const project=nativeToFragment(document,resources,'同名字段');
 assert.deepEqual(project.nodes.map(n=>n.params.nativeCanvas.node.id),['a','p','g','c']);
 assert.deepEqual(project.nodes[2].params.nativeCanvas.node.items,['a','p']);assert.deepEqual(project.nodes[3].params.nativeCanvas.node.inputs,['a','p']);
 assert.equal(project.nodes[1].text,'a');assert.equal(project.nodes[3].params.nativeCanvas.node.outputText,'a');assert.deepEqual(project.nodes[1].params.nativeCanvas.mediaAssetIds,[]);
 const exported=fragmentToNative(project,[asset],{withResources:true});assert.deepEqual(exported.nodes.map(n=>n.id),['a','p','g','c']);assert.equal(exported.nodes[0].name,'a');assert.equal(exported.nodes[1].text,'a');assert.equal(exported.nodes[3].outputText,'a');assert.deepEqual(exported.nodes[2].items,['a','p']);
 assert.equal(exported.nodes[0].url,exported.resources[0].url);
});

test('智能组展平全部成员文本和媒体，按固定源规则忽略嵌套智能组',()=>{
 const f=fixture([source('a','smart-prompt',{text:'甲;乙',promptSplitEnabled:true}),source('b','smart-image',{images:[{url:'/source/b'}]}),source('inner','smart-group',{items:['a']}),source('g','smart-group',{items:['inner','b']})],[],[picture('b')],true);
 assert.deepEqual(f.value('inner').nodes[0].promptItems,['甲','乙']);assert.deepEqual(f.value('g').nodes[0].promptItems,[]);assert.deepEqual(f.value('g').nodes[0].media.map(a=>a.assetId),['b']);
});

test('输入排序仅采用仍然相连的原生 inputs，新增连线追加且不重复',()=>{
 const f=fixture([source('a','prompt',{text:'甲'}),source('b','prompt',{text:'乙'}),source('c','prompt',{text:'丙'}),source('g','comfy',{inputs:['c','b','b','a']})],[['a','g'],['b','g']]);
 assert.deepEqual(orderedNativeInputIds(f.p,f.id('g')),[f.id('b'),f.id('a')]);assert.deepEqual(f.value('g').inputs.promptItems,['乙','甲']);
});

test('输出节点保留历史并接收本次所有生成媒体；普通生成器取最新，循环取图片组',()=>{
 const f=fixture([source('c','comfy',{generatedOutputs:['/source/a','/source/b']}),source('o','output',{images:['/source/a']}),source('g','generator'),source('l','loop',{count:3,loopStart:1,imageInput:true,imageBatchSize:2})],[['c','o'],['o','g'],['o','l']],[picture('a'),picture('b'),video('c')]);
 const outputs=[{nodeId:f.id('c'),assetIds:['b','c'],promptItems:[]}];
 assert.deepEqual(f.value('o',{outputs}).nodes[0].media.map(m=>m.assetId),['a','b','c']);assert.deepEqual(f.value('g',{outputs}).inputs.media.map(m=>m.assetId),['c']);assert.deepEqual(f.value('l',{outputs}).nodes[0].media.map(m=>m.assetId),['a','b']);
});

test('原生语言模型使用输出文字；输入素材组不额外发送组内提示词，输出选最新各类',()=>{
 const f=fixture([source('t','prompt',{text:'提示'}),source('a','image',{url:'/source/a'}),source('g','group',{items:['t','a']}),source('o','output',{images:['/source/a','/source/b','/source/c']}),source('l','llm',{text:'原指令',outputText:'旧结果'})],[['g','l'],['o','l']],[picture('a'),picture('b'),audio('c')]);
 const v=f.value('l');assert.deepEqual(v.nodes[0].promptItems,['旧结果']);assert.deepEqual(v.inputs.promptItems,[]);assert.deepEqual(v.inputs.media.map(m=>m.assetId),['a','b','c']);
});

test('普通循环从起始计数取上游提示词和图片滑动批次，计数替换与末尾不足保留',()=>{
 const f=fixture([source('a','prompt',{text:'甲《计数》/《总数》'}),source('b','prompt',{text:'乙[进度]'}),source('pg','promptGroup',{items:['a','b']}),source('o','output',{images:['/source/p','/source/q','/source/r']}),source('l','loop',{count:100,loopStart:2,imageBatchSize:2,imageInput:true,showPrompt:true,variablePrompt:'本地被上游替代'})],[['pg','l'],['o','l']],[picture('p'),picture('q'),picture('r')]);
 const v=f.value('l').nodes[0];assert.deepEqual(v.promptItems,['乙2/100']);assert.deepEqual(v.media.map(a=>a.assetId),['q','r']);assert.equal(v.loop.count,100);
 const options={loopContexts:{[f.id('l')]:{index:3,total:100}}},last=f.value('l',options).nodes[0];assert.deepEqual(last.promptItems,['甲3/100']);assert.deepEqual(last.media.map(a=>a.assetId),['r']);assert.deepEqual(f.value('l',{loopContexts:{[f.id('l')]:{index:4,total:100}}}).nodes[0].media,[]);
});

test('智能循环本地字段与上游条目按计数轮换，默认占位提示词不重复拼接',()=>{
 const f=fixture([source('p','smart-prompt',{text:'甲;乙',promptSplitEnabled:true}),source('l','smart-loop',{count:5,loopStart:2,showPrompt:true,variablePrompts:['现在生成第《计数》张卖点图片','自定义《计数》']})],[['p','l']],[],true);
 assert.deepEqual(f.value('l').nodes[0].promptItems,['乙\n\n自定义2']);assert.deepEqual(f.value('l',{loopContexts:{[f.id('l')]:{index:1,total:5}}}).nodes[0].promptItems,['甲']);
});

test('智能语言模型需本机绑定，保留 llmInstruction；输出后才拆分真实返回文本',()=>{
 const f=fixture([source('p','smart-prompt',{text:'上游'}),source('l','smart-prompt',{text:'旧文本',llmEnabled:true,llmInstruction:'请整理',promptSplitEnabled:true})],[['p','l']],[],true);
 assert.equal(f.value('l',{execution:true}).nodes[0].status,'blocked');assert.equal(f.value('l').nodes[0].llmInput,'上游\n\n请整理');
 f.p.nodes.find(n=>n.id===f.id('l')).params.llmBinding={model:'owned-placeholder'};assert.deepEqual(f.value('l',{execution:true}).nodes[0].pendingNodeIds,[f.id('l')]);
 const v=f.value('l',{execution:true,outputs:[{nodeId:f.id('l'),assetIds:[],promptItems:['新甲;新乙']}]});assert.equal(v.nodes[0].status,'resolved');assert.deepEqual(v.nodes[0].promptItems,['新甲','新乙']);
});

test('执行态不能把先前素材预览当作本轮完成；待生成状态经组和输出传递',()=>{
 const f=fixture([source('a','smart-image',{images:[{url:'/source/a'}]}),source('g','smart-group',{items:['a']}),source('o','output')],[['a','o']],[picture('a'),picture('new')],true);
 f.p.nodes.find(n=>n.id===f.id('a')).params.imageBinding={model:'owned-placeholder'};
 assert.deepEqual(f.value('g',{execution:true}).nodes[0].pendingNodeIds,[f.id('a')]);assert.equal(f.value('o',{execution:true}).nodes[0].status,'pending');
 const done=f.value('g',{execution:true,outputs:[{nodeId:f.id('a'),assetIds:['new'],promptItems:[]}]});assert.equal(done.nodes[0].status,'resolved');assert.deepEqual(done.nodes[0].media.map(m=>m.assetId),['new']);
});

test('分组成员形成的隐式循环及成员/连线组合循环发送前拒绝',()=>{
 const f=fixture([source('a','promptGroup',{items:['b']}),source('b','promptGroup',{items:['a']})]);assert.throws(()=>nativeFlowPreview(f.p),/循环依赖/);
 const g=fixture([source('a','image',{url:'/source/a'}),source('g','group',{items:['a']})],[['g','a']],[picture('a')]);assert.throws(()=>nativeFlowPreview(g.p),/循环依赖/);
});

test('生成条目和组成员的细项排序保留；已换掉的旧生成条目按源规则追加',()=>{
 const f=fixture([source('a','image',{url:'/source/a'}),source('b','image',{url:'/source/b'}),source('t','prompt',{text:'组文字'}),source('g','group',{items:['a','b','t']}),source('c','comfy',{generatedOutputs:['/source/c','/source/d']}),source('run','generator',{inputs:['c:generated:1:/source/d','g:b','g:prompts','g:a','c:generated:0:/source/c']})],[['g','run'],['c','run']],[picture('a'),picture('b'),picture('c'),picture('d'),picture('fresh')]);
 const v=f.value('run');assert.deepEqual(v.inputs.media.map(m=>m.assetId),['d','b','a','c']);assert.deepEqual(v.inputs.promptItems,['组文字']);assert.deepEqual(v.inputs.sources.map(s=>s.itemType),['generated','group-media','group-prompts','group-media','generated']);
 const actual=f.value('run',{outputs:[{nodeId:f.id('c'),assetIds:['fresh'],promptItems:[]}]});assert.deepEqual(actual.inputs.media.map(m=>m.assetId),['b','a','fresh']);
 const exported=fragmentToNative(f.p,f.p.assets.map(a=>({...a,size:1})),{withResources:true});assert.equal(exported.nodes.at(-1).inputs[0],'c:generated:1:'+exported.resources.find(r=>r.name==='d').url);assert.equal(exported.nodes.at(-1).inputs[1],'g:b');
});

test('普通分组的生成及嵌套成员按固定源排除，不引入额外生成或旧预览',()=>{
 const f=fixture([source('c','comfy',{generatedOutputs:['/source/a']}),source('other','comfy'),source('inner','group',{items:['other']}),source('g','group',{items:['c','inner']})],[],[picture('a')]);
 f.p.nodes.find(n=>n.id===f.id('c')).params.workflowBinding={workflowId:'owned-placeholder'};
 const v=f.value('g',{execution:true}).nodes[0];assert.deepEqual(v.media,[]);assert.deepEqual(v.pendingNodeIds,[]);assert.equal(v.status,'resolved');
});

test('内嵌生成条目地址含认证信息时，在导入前拒绝而不写入排序记录',()=>{
 assert.throws(()=>normalizeNativeWorkflow({nodes:[source('c','comfy'),source('run','generator',{inputs:['c:generated:0:https://never-send.invalid/a.png?access_token=not-real']})],connections:[]}),/认证/);
 const f=fixture([source('c','comfy'),source('run','generator',{inputs:['c:generated:0:https://never-send.invalid/a.png']})],[['c','run']]);f.p.nodes.at(-1).params.nativeCanvas.inputOrder[0].itemUrl='https://never-send.invalid/a.png?token=not-real';assert.throws(()=>validateProject(f.p),/认证/);
});

test('结果编号及上下文严格属于当前项目，非法回合、缺失节点和秘密明确拒绝',()=>{
 const f=fixture([source('p','prompt',{text:'原文'})]);assert.throws(()=>f.value('p',{outputs:[{nodeId:'absent',assetIds:[],promptItems:[]}]}),/当前节点/);
 assert.throws(()=>f.value('p',{outputs:[{nodeId:f.id('p'),assetIds:['absent'],promptItems:[]}]}),/当前节点/);
 assert.throws(()=>f.value('p',{loopContexts:{[f.id('p')]:{index:1}}}),/上下文/);
 assert.throws(()=>f.value('p',{outputs:[{nodeId:f.id('p'),assetIds:[],promptItems:[],apiKey:'not-a-real-credential'}]}),/密钥|凭据/);
});

test('完成步骤的任务输出保留所有文件；未完成步骤、其他轮次不冒充当前完成结果',()=>{
 const p=makeProject('独立结果集合');p.nodes=[makeNode('image',0,0,{id:'a'}),makeNode('image',0,0,{id:'b'})];p.assets=[picture('one'),video('two'),{id:'text',name:'文字文件',type:'text/plain'}];
 const job={projectId:p.id,kind:'canvas-run',steps:[{nodeId:'a',status:'completed'},{nodeId:'b',status:'running'}],assets:[{id:'one',sourceNodeId:'a'},{id:'two',sourceNodeId:'a'},{id:'text',sourceNodeId:'a'},{id:'one',sourceNodeId:'b'}],textResults:[]};
 const outputs=nativeFlowOutputsFromJob(p,job);assert.deepEqual(outputs,[{nodeId:'a',assetIds:['one','two','text'],promptItems:[]}]);assert.deepEqual(nativeFlowPreview(p,{outputs}).nodes[0].media.map(a=>a.kind),['image','video','text']);
 assert.throws(()=>nativeFlowOutputsFromJob(p,{...job,projectId:'another'}),/不属于/);
 const looped={...job,steps:[{nodeId:'a',status:'completed',loopId:'l',roundIndex:0},{nodeId:'a',status:'completed',loopId:'l',roundIndex:1}],assets:[{id:'one',sourceNodeId:'a',loopId:'l',roundIndex:0},{id:'two',sourceNodeId:'a',loopId:'l',roundIndex:1}]};
 assert.deepEqual(nativeFlowOutputsFromJob(p,looped),[]);assert.deepEqual(nativeFlowOutputsFromJob(p,looped,{loopId:'l',roundIndex:1})[0].assetIds,['two']);
});

test('源原生 runSettings 和未知节点仍标阻断；解析通过不开放生成执行',()=>{
 const f=fixture([source('a','smart-image',{runSettings:{model:'source-model'}}),source('b','not-adapted')],[],[],true),v=nativeFlowPreview(f.p);
 assert.equal(v.executionEnabled,false);assert.ok(v.nodes.every(n=>n.status==='blocked'));
});

test('聚合容量及非法循环标量拒绝，不截断源文本或媒体',()=>{
 const f=fixture([source('p','smart-prompt',{text:Array(1001).fill('条目').join(';'),promptSplitEnabled:true})],[],[],true);assert.throws(()=>nativeFlowPreview(f.p),/1000项/);
 assert.throws(()=>fixture([source('l','loop',{count:1.5})]),/整数/);
});
