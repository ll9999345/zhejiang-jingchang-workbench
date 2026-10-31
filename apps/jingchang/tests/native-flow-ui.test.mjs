import test from 'node:test';
import assert from 'node:assert/strict';
import {semanticAncestors,nativeReferenceChoices,nativeReferenceKinds,nativeReferenceMarkup,nativeFlowNodeIssues} from '../public/native-flow-ui.js';
import {nativeExecutionAncestors} from '../lib/native-flow-execution.mjs';
import {normalizeNativeWorkflow,nativeToFragment} from '../lib/native-canvas-core.mjs';
import {nativeInspector} from '../public/native-canvas.js';

const source=(id,type,extra={})=>({id,type,x:0,y:0,...extra});
const asset=(id,type='image/png',name=id)=>({id,type,name});
function fixture(nodes,edges=[],assets=[]){
 const resources=assets.map(asset=>({url:'/source/'+asset.id,archive:'resources/'+asset.id,portableUrl:'/media/'+asset.id,asset}));
 const project=nativeToFragment(normalizeNativeWorkflow({nodes,connections:edges.map(([from,to])=>({from,to}))}),resources,'原生参考界面');
 const node=id=>project.nodes.find(node=>node.params.nativeCanvas.node.id===id);
 return{project,node,id:id=>node(id).id};
}
function bind(node,binding={workflowBinding:{count:1}}){node.params.nativeCanvas.adaptation='configured';Object.assign(node.params,binding);}

test('显示状态放行整组聚合与本地智能拆分，未绑定的生成或模型改写仍受阻',()=>{
 const f=fixture([source('a','image',{url:'/source/a'}),source('g','group',{items:['a']}),source('prompt-group','promptGroup'),source('unconfigured','generator'),source('split','smart-prompt',{text:'甲;乙',promptSplitEnabled:true}),source('target','generator')],[['g','target'],['prompt-group','target']],[asset('a')]);
 assert.deepEqual(nativeFlowNodeIssues(f.node('g'),f.project),[]);
 assert.deepEqual(nativeFlowNodeIssues(f.node('prompt-group'),f.project),[]);
 assert.ok(nativeFlowNodeIssues(f.node('unconfigured'),f.project).some(issue=>issue.includes('重新绑定')));
 assert.deepEqual(nativeFlowNodeIssues(f.node('split'),f.project),[]);
 const markup=nativeInspector(f.node('split'),f.project,String);assert.match(markup,/data-action="edit-native-prompt"/);assert.match(markup,/当前拆分预览（2段）/);assert.doesNotMatch(markup,/data-native-configure/);
 f.node('split').params.nativeCanvas.node.llmEnabled=true;assert.ok(nativeFlowNodeIssues(f.node('split'),f.project).some(issue=>issue.includes('尚未绑定')));
});

test('语义祖先与后端一致，包含分组成员并忽略普通组生成节点及嵌套智能组',()=>{
 const f=fixture([source('image','image'),source('prompt','prompt'),source('generated','comfy'),source('ignored','comfy'),source('group','group',{items:['image','prompt','generated']}),source('inner','smart-group',{items:['ignored']}),source('smart','smart-group',{items:['group','inner']}),source('target','generator')],[['smart','target']]);
 const before=structuredClone(f.project),actual=semanticAncestors(f.project,f.id('target'));
 assert.deepEqual(actual,nativeExecutionAncestors(f.project,f.id('target')));
 assert.deepEqual([...actual].map(id=>f.project.nodes.find(n=>n.id===id).params.nativeCanvas.node.id),['smart','group','image','prompt']);
 assert.deepEqual(f.project,before);
});

test('语义循环和丢失成员拒绝，不无限递归或给出可选来源',()=>{
 const f=fixture([source('a','image'),source('g','group',{items:['a']}),source('target','generator')],[['g','target']]);
 f.project.edges.push({id:'cycle',source:f.id('g'),target:f.id('a')});
 assert.throws(()=>semanticAncestors(f.project,f.id('target')),/循环依赖/);
 f.project.edges.pop();f.node('g').params.nativeCanvas.members[0].sourceNodeId='missing';
 assert.throws(()=>nativeReferenceChoices(f.project,f.id('target')),/成员缺失/);
});

test('选择器按静态素材 MIME 判断混合组，图片目的地整体排除音频混合组',()=>{
 const f=fixture([source('picture','image',{url:'/source/a'}),source('sound','image',{url:'/source/b'}),source('g','group',{items:['sound','picture']}),source('target','generator'),source('unrelated','image',{url:'/source/a'})],[['g','target']],[asset('a'),asset('b','audio/wav')]);
 const all=nativeReferenceChoices(f.project,f.id('target'));
 const group=all.find(choice=>choice.value==='node:'+f.id('g'));
 assert.deepEqual(group.kinds,['audio','image']);assert.equal(group.grouped,true);assert.equal(group.dynamic,false);
 assert.deepEqual(nativeReferenceKinds(f.project,{sourceNodeId:f.id('sound')}),['audio']);
 const images=nativeReferenceChoices(f.project,f.id('target'),{kinds:['image']});
 assert.deepEqual(images.map(choice=>choice.value),['node:'+f.id('picture')]);
 assert.ok(!all.some(choice=>choice.value==='node:'+f.id('unrelated')));
});

test('空组、仅文字组、未迁移生成配置、智能拆分和不完整素材来源不显示',()=>{
 const f=fixture([source('empty','group'),source('text','prompt',{text:'说明'}),source('text-group','promptGroup',{items:['text']}),source('unconfigured','generator',{generatedOutputs:['/source/a']}),source('split','smart-prompt',{text:'a;b',promptSplitEnabled:true}),source('split-group','smart-group',{items:['split']}),source('broken','smart-image',{images:[{url:'/source/a'},{url:'/missing'}]}),source('target','generator')],[['empty','target'],['text-group','target'],['unconfigured','target'],['split-group','target'],['broken','target']],[asset('a')]);
 assert.deepEqual(nativeReferenceChoices(f.project,f.id('target')),[]);
 assert.deepEqual(nativeReferenceKinds(f.project,{sourceNodeId:f.id('unconfigured')}),[]);
 assert.deepEqual(nativeReferenceKinds(f.project,{sourceNodeId:f.id('broken')}),[]);
});

test('已绑定动态来源按本轮声明类型判断，不把旧视频预览当作本轮图片结果',()=>{
 const f=fixture([source('generated','comfy',{generatedOutputs:['/source/old']}),source('target','generator')],[['generated','target']],[asset('old','video/mp4')]);
 const generated=f.node('generated');generated.type='image';generated.assetId='old';bind(generated,{workflowBinding:{count:3}});
 const before=structuredClone(f.project),choices=nativeReferenceChoices(f.project,f.id('target'),{kinds:['image']});
 assert.equal(choices.length,1);assert.deepEqual(choices[0].kinds,['image']);assert.equal(choices[0].dynamic,true);assert.equal(choices[0].grouped,true);
 assert.match(choices[0].label,/本轮待生成/);assert.doesNotMatch(choices[0].label,/已有素材/);
 assert.deepEqual(nativeReferenceKinds(f.project,{sourceNodeId:generated.id}),['image']);assert.deepEqual(f.project,before);
});

test('单请求动态来源仍标记动态，提示词列表数量和创作台数量识别为整组',()=>{
 const f=fixture([source('single','comfy'),source('batch','comfy'),source('studio','generator'),source('target','generator')],[['single','target'],['batch','target'],['studio','target']]);
 bind(f.node('single'));bind(f.node('batch'),{workflowBinding:{promptBatch:{values:['a','b']}}});bind(f.node('studio'),{studioBinding:{mode:'image',config:{count:4}}});
 const choices=nativeReferenceChoices(f.project,f.id('target'));
 assert.ok(choices.every(choice=>choice.dynamic));assert.equal(choices.find(choice=>choice.value==='node:'+f.id('single')).grouped,true);
 assert.equal(choices.find(choice=>choice.value==='node:'+f.id('batch')).grouped,true);assert.equal(choices.find(choice=>choice.value==='node:'+f.id('studio')).grouped,true);
});

test('输出接收器按消费者选择已有素材与待生成输入，空输出不显示',()=>{
 const f=fixture([source('video','video'),source('out','output',{images:['/source/a']}),source('empty','output'),source('target','llm')],[['video','out'],['out','target'],['empty','target']],[asset('a')]);
 bind(f.node('video'),{studioBinding:{mode:'video',config:{}}});
 const choices=nativeReferenceChoices(f.project,f.id('target'),{consumer:'llm'}),out=choices.find(choice=>choice.value==='node:'+f.id('out'));
 assert.deepEqual(out.kinds,['image','video']);assert.equal(out.grouped,true);assert.equal(out.dynamic,true);
 assert.deepEqual(nativeReferenceKinds(f.project,{sourceNodeId:f.id('out')}),['video']);
 assert.deepEqual(nativeReferenceKinds(f.project,{sourceNodeId:f.id('out')},{consumer:'llm'}),['image','video']);
 assert.ok(!choices.some(choice=>choice.value==='node:'+f.id('empty')));
});

test('输出历史旧音频不隐藏最新图片，LLM 每类只选择最新一份',()=>{
 const f=fixture([source('out','output',{images:['/source/sound','/source/a','/source/video','/source/b']}),source('target','generator')],[['out','target']],[asset('sound','audio/wav'),asset('a'),asset('video','video/mp4'),asset('b')]);
 const before=structuredClone(f.project),generator=nativeReferenceChoices(f.project,f.id('target'),{kinds:['image']});
 assert.equal(generator.length,1);assert.deepEqual(generator[0].kinds,['image']);assert.equal(generator[0].dynamic,false);assert.match(generator[0].label,/1 份已有素材/);
 const llm=nativeReferenceChoices(f.project,f.id('target'),{consumer:'llm'});
 assert.deepEqual(llm[0].kinds,['image','video','audio']);assert.match(llm[0].label,/3 份已有素材/);
 assert.deepEqual(nativeReferenceKinds(f.project,{sourceNodeId:f.id('out')}),['image']);
 assert.deepEqual(nativeReferenceKinds(f.project,{sourceNodeId:f.id('out')},{consumer:'llm'}),['image','video','audio']);
 assert.deepEqual(f.project,before);
});

test('待生成输出按保存输入顺序选最后来源且只计一份，旧预览不决定类型',()=>{
 const f=fixture([source('image','comfy',{generatedOutputs:['/source/old-video']}),source('video','video'),source('out','output',{images:['/source/old-audio'],inputs:['video','image']}),source('target','generator')],[['image','out'],['video','out'],['out','target']],[asset('old-video','video/mp4'),asset('old-audio','audio/wav')]);
 bind(f.node('image'),{workflowBinding:{count:6}});bind(f.node('video'),{studioBinding:{mode:'video',config:{}}});
 const reference={sourceNodeId:f.id('out')};
 assert.deepEqual(nativeReferenceKinds(f.project,reference),['image']);
 const out=nativeReferenceChoices(f.project,f.id('target'),{kinds:['image']}).find(choice=>choice.value==='node:'+f.id('out'));
 assert.ok(out);assert.equal(out.dynamic,true);assert.match(out.label,/本轮待生成/);assert.doesNotMatch(out.label,/已有素材/);
 const llm=nativeReferenceChoices(f.project,f.id('target'),{consumer:'llm'}).find(choice=>choice.value==='node:'+f.id('out'));
 assert.deepEqual(llm.kinds,['image','video','audio']);assert.equal(llm.dynamic,true);
 assert.deepEqual(nativeReferenceKinds(f.project,reference,{consumer:'llm'}),['image','video','audio']);
});

test('嵌套接收器的待生成祖先不成为当前接收器的新素材，仍只使用自身历史',()=>{
 const f=fixture([source('image','comfy'),source('video','video'),source('upstream','output',{inputs:['video','image']}),source('out','output',{images:['/source/old-image','/source/old-audio']}),source('target','llm')],[['image','upstream'],['video','upstream'],['upstream','out'],['out','target']],[asset('old-image'),asset('old-audio','audio/wav')]);
 bind(f.node('image'),{workflowBinding:{count:3}});bind(f.node('video'),{studioBinding:{mode:'video',config:{}}});
 const before=structuredClone(f.project),reference={sourceNodeId:f.id('out')};
 assert.deepEqual(nativeReferenceKinds(f.project,reference),['audio']);
 assert.deepEqual(nativeReferenceKinds(f.project,reference,{consumer:'llm'}),['image','audio']);
 const out=nativeReferenceChoices(f.project,f.id('target'),{consumer:'llm'}).find(choice=>choice.value==='node:'+f.id('out'));
 assert.equal(out.dynamic,false);assert.match(out.label,/2 份已有素材/);assert.doesNotMatch(out.label,/本轮待生成/);
 assert.deepEqual(f.project,before);
});

test('没有自身历史且只连接另一个接收器时不提供参考，不能借用祖先历史或新结果',()=>{
 const f=fixture([source('generated','comfy'),source('upstream','output',{images:['/source/upstream-image']}),source('out','output'),source('target','generator')],[['generated','upstream'],['upstream','out'],['out','target']],[asset('upstream-image')]);
 bind(f.node('generated'));
 for(const consumer of ['generator','llm']){
  assert.deepEqual(nativeReferenceKinds(f.project,{sourceNodeId:f.id('out')},{consumer}),[]);
  assert.ok(!nativeReferenceChoices(f.project,f.id('target'),{consumer}).some(choice=>choice.value==='node:'+f.id('out')));
 }
});

test('同时有直接生成输入和嵌套接收器时只用直接来源替换对应类型历史',()=>{
 const f=fixture([source('indirect','comfy'),source('upstream','output',{images:['/source/upstream-audio']}),source('direct','video'),source('out','output',{images:['/source/own-image'],inputs:['direct','upstream']}),source('target','llm')],[['indirect','upstream'],['upstream','out'],['direct','out'],['out','target']],[asset('upstream-audio','audio/wav'),asset('own-image')]);
 bind(f.node('indirect'),{workflowBinding:{count:4}});bind(f.node('direct'),{studioBinding:{mode:'video',config:{}}});
 const reference={sourceNodeId:f.id('out')};
 assert.deepEqual(nativeReferenceKinds(f.project,reference),['video']);
 assert.deepEqual(nativeReferenceKinds(f.project,reference,{consumer:'llm'}),['image','video']);
 const out=nativeReferenceChoices(f.project,f.id('target'),{consumer:'llm'}).find(choice=>choice.value==='node:'+f.id('out'));
 assert.equal(out.dynamic,true);assert.deepEqual(out.kinds,['image','video']);
});

test('智能分组内生成节点只形成接收器依赖，不会作为直接收集来源',()=>{
 const f=fixture([source('generated','comfy'),source('group','smart-group',{items:['generated']}),source('out','output',{images:['/source/own-audio']}),source('target','llm')],[['group','out'],['out','target']],[asset('own-audio','audio/wav')]);
 bind(f.node('generated'),{workflowBinding:{count:2}});
 for(const consumer of ['generator','llm']){
  assert.deepEqual(nativeReferenceKinds(f.project,{sourceNodeId:f.id('out')},{consumer}),['audio']);
  const out=nativeReferenceChoices(f.project,f.id('target'),{consumer}).find(choice=>choice.value==='node:'+f.id('out'));
  assert.equal(out.dynamic,false);assert.match(out.label,/1 份已有素材/);
 }
});

test('固定素材与显式地址按 MIME 返回类型，缺失和非媒体文件不获选',()=>{
 const project={nodes:[],edges:[],assets:[asset('image'),asset('video','video/mp4'),asset('file','application/pdf')]};
 assert.deepEqual(nativeReferenceKinds(project,{assetId:'video'}),['video']);assert.deepEqual(nativeReferenceKinds(project,{assetId:'file'}),[]);
 assert.deepEqual(nativeReferenceKinds(project,{assetId:'missing'}),[]);assert.deepEqual(nativeReferenceKinds(project,{url:'https://example.invalid/reference',type:'audio/mpeg'}),['audio']);
 assert.deepEqual(nativeReferenceKinds(project,{url:'https://example.invalid/reference'}),['image']);
});

test('发送清单按计划顺序显示名称与动态数量上限，并说明超过范围停止',()=>{
 const step={nativeReferences:{version:1,details:[{assetId:'fixed',name:'先参考图',kind:'image'},{sourceNodeId:'pending',name:'后生成图',kind:'image',pending:true,expectedCount:3},{assetId:'audio',name:'声音参考',kind:'audio'}]}};
 const before=structuredClone(step),html=nativeReferenceMarkup(step);
 assert.ok(html.indexOf('先参考图')<html.indexOf('后生成图'));assert.ok(html.indexOf('后生成图')<html.indexOf('声音参考'));
 assert.match(html,/最多 5 份/);assert.match(html,/本轮待生成 · 最多 3 份/);assert.match(html,/旧预览不会代替新结果/);assert.match(html,/超出确认范围时停止下游提交/);
 assert.deepEqual(step,before);
});

test('素材与节点恶意名字被转义，编号回退也不产生标签或请求',()=>{
 const step={nativeReferences:{details:[{assetId:'asset',name:'<img src=x onerror="alert(1)">&',kind:'image'},{sourceNodeId:'<script>bad</script>',pending:true,expectedCount:2,kind:'audio'}]}};
 const html=nativeReferenceMarkup(step);
 assert.doesNotMatch(html,/<img|<script/);assert.match(html,/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;&amp;/);assert.match(html,/&lt;script&gt;bad&lt;\/script&gt;/);
 assert.equal(nativeReferenceMarkup({}), '');assert.equal(nativeReferenceMarkup({nativeReferences:{details:[]}}),'');
});

test('不合法待生成计数不渲染成已确认上限',()=>{
 const html=nativeReferenceMarkup({nativeReferences:{details:[{sourceNodeId:'pending',kind:'image',pending:true,expectedCount:'<img>'}]}});
 assert.match(html,/数量待重新检查/);assert.doesNotMatch(html,/最多|<img>/);
});

test('H3自动清单说明去重和未选入数量，只显示实际确认参考，保留普通与智能规则',()=>{
 const step={nativeDirectorInputs:{version:2,kind:'h3',details:[{assetId:'selected',name:'已选参考',kind:'image'}],automatic:{policy:'smart',duplicates:2,excluded:3,candidates:[{assetId:'other',name:'未批准图片',kind:'image'}]}}};
 const before=structuredClone(step),html=nativeReferenceMarkup(step);assert.match(html,/前9图／3视频／3音频/);assert.match(html,/合并重复 2 份/);assert.match(html,/3 份未选入/);assert.doesNotMatch(html,/未批准图片/);assert.deepEqual(step,before);
 step.nativeDirectorInputs.automatic.policy='ordinary';assert.match(nativeReferenceMarkup(step),/原顺序取前15份/);
});
