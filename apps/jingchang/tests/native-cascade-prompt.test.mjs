import test from 'node:test';
import assert from 'node:assert/strict';
import {cascadeFixture} from './helpers/native-cascade-fixture.mjs';
import {nativeCascadePromptParts,nativeCascadePromptText,buildNativeCascadePrompt} from '../lib/native-cascade-prompt.mjs';
import {cascadeReferenceResolver,uniqueCascadeRefs} from '../lib/native-cascade-media.mjs';

const markup=(url,name,extra='')=>'<span class="mention-image-token" data-url="'+url+'" data-name="'+name+'" '+extra+'><img src="https://example.invalid/never-fetch"><span>忽略的缩略图文字</span></span>';
const refs=(project,id)=>cascadeReferenceResolver(project,{round:{index:null,forceWorkflow:false}}).output(id);
const build=(f,id,options)=>buildNativeCascadePrompt(f.project,id,options);
test('发送方富文本保留换行和HTML实体，不把缩略图文字加入提示词',()=>{
 const f=cascadeFixture();f.node('A',{raw:{promptDraftHtml:'<div>山 &amp; 海</div><p>第二行<br>第三行&nbsp; &#x732B;</p>'}});
 const value=build(f,'A');assert.equal(value.prompt,'山 & 海\n第二行\n第三行\u00a0 猫');assert.equal(value.displayPrompt,value.prompt);assert.equal(value.mentioned,false);
});
test('只有直接input提示词和本次中继进入提示词，flow和祖先文字不混入',()=>{
 const f=cascadeFixture(),a=f.node('A'),p=f.node('P',{kind:'smart-prompt'}),q=f.node('Q',{kind:'smart-prompt'}),r=f.node('R',{kind:'smart-prompt'});
 p.text='直接';q.text='工作流文字';r.text='间接';f.edge(p,a,'input');f.edge(q,a,'flow');f.edge(r,p,'input');
 assert.equal(build(f,'A').prompt,'直接\n\n参数属于 A');assert.equal(build(f,'A',{context:{relayPromptNodeIds:['Q']}}).prompt,'直接\n\n工作流文字\n\n参数属于 A');
});
test('中继与直接提示词按完整文字去重，不对不同分段内容重排',()=>{
 const f=cascadeFixture(),a=f.node('A'),p=f.node('P',{kind:'smart-prompt'}),q=f.node('Q',{kind:'smart-prompt'});p.text='甲;乙';q.text='甲;乙';p.params.nativeCanvas.node.promptSplitEnabled=q.params.nativeCanvas.node.promptSplitEnabled=true;
 f.edge(p,a,'input');assert.equal(build(f,'A',{context:{relayPromptNodeIds:['Q','P']}}).prompt,'甲\n\n乙\n\n参数属于 A');
});
test('分组按原成员顺序展开提示词，排除自身、重复和嵌套组',()=>{
 const f=cascadeFixture(),a=f.node('A'),g=f.node('G',{kind:'smart-group'}),p=f.node('P',{kind:'smart-prompt'}),q=f.node('Q',{kind:'smart-prompt'}),nested=f.node('N',{kind:'smart-group'});
 p.text='第一';q.text='第二';g.params.nativeCanvas.members=[q,p,q,g,nested].map(n=>({sourceNodeId:n.id}));f.edge(g,a,'input');
 assert.equal(build(f,'A').prompt,'第二\n\n第一\n\n参数属于 A');
});
test('循环分别轮换上游段与本地段，使用实际计数和末轮总数',()=>{
 const f=cascadeFixture(),a=f.node('A'),l=f.node('L',{kind:'smart-loop',showPrompt:true,start:2,count:3}),p=f.node('P',{kind:'smart-prompt'});
 p.text='甲《计数》;乙《计数》;丙《计数》';p.params.nativeCanvas.node.promptSplitEnabled=true;l.params.nativeLoop.variablePrompts=['本地一[进度]','本地二《总数》'];f.edge(p,l,'input');f.edge(l,a,'input');
 assert.equal(build(f,'A',{context:{index:4,total:6}}).prompt,'甲4\n\n本地二6\n\n参数属于 A');
});
test('循环有上游时抑制源默认卖点文案，关闭传提示词不读取本地段',()=>{
 const f=cascadeFixture(),a=f.node('A'),l=f.node('L',{kind:'smart-loop',showPrompt:true}),p=f.node('P',{kind:'smart-prompt'});p.text='上游';f.edge(p,l,'input');f.edge(l,a,'input');l.params.nativeLoop.variablePrompt='现在生成第《计数》张卖点图片';
 assert.equal(build(f,'A').prompt,'上游\n\n参数属于 A');l.params.nativeLoop.showPrompt=false;assert.equal(build(f,'A').prompt,'参数属于 A');
});
test('媒体提及按原URL身份匹配默认参考，生成编号和角色保序',()=>{
 const f=cascadeFixture(),a=f.node('A'),r=f.node('R');a.params.nativeCanvas.node.promptDraftHtml='用'+markup('/api/assets/asset-R','山景')+'作背景';
 const value=build(f,'A',{referenceRefs:refs(f.project,'R')});assert.equal(value.referenceRefs.length,1);assert.match(value.prompt,/用图1作背景$/);assert.equal(value.displayPrompt,'用@山景作背景');assert.deepEqual(value.roles,[{assetId:'asset-R',kind:'image',role:'image_1'}]);
});
test('默认参考与新提及去重追加，提及引用只能来自已导入资源',()=>{
 const f=cascadeFixture(),a=f.node('A');f.node('R');a.params.nativeCanvas.node.promptDraftHtml=markup('/api/assets/asset-R','另一张')+markup('/api/assets/asset-R','另一个别名');
 const value=build(f,'A',{referenceRefs:refs(f.project,'A')});assert.equal(value.referenceRefs.length,2);assert.match(value.prompt,/图2图2$/);
 a.params.nativeCanvas.node.promptDraftHtml=markup('https://example.invalid/not-imported.png','未导入');assert.throws(()=>build(f,'A'),/尚未导入本机/);
});
test('被排除的提及保留@字面内容且不要求读取缺失资源',()=>{
 const f=cascadeFixture(),a=f.node('A');a.params.nativeCanvas.node.promptDraftHtml='保留'+markup('/not-imported.png','不可发送','data-node-id="old-node" data-image-index="2"');a.params.nativeCanvas.node.blockedInputRefs=['old-node|2'];
 const value=build(f,'A');assert.equal(value.prompt,'保留@不可发送');assert.equal(value.referenceRefs.length,0);
});
test('被排除的默认参考在角色编号前移除，源节点索引与URL阻止规则独立',()=>{
 const f=cascadeFixture(),a=f.node('A'),r=f.node('R');a.params.nativeCanvas.node.blockedInputRefs=['original-R|0'];
 assert.equal(build(f,'A',{referenceRefs:refs(f.project,'R')}).referenceRefs.length,0);
 a.params.nativeCanvas.node.blockedInputRefs=['url|/api/assets/asset-R'];assert.equal(build(f,'A',{referenceRefs:refs(f.project,'R')}).referenceRefs.length,1);
});
test('已满20参考时额外提及保留文字，不读取额外缺失文件',()=>{
 const f=cascadeFixture(),a=f.node('A'),references=[];for(let i=0;i<20;i++){f.node('R'+i);references.push(...refs(f.project,'R'+i));}
 a.params.nativeCanvas.node.promptDraftHtml=markup('/not-imported.png','第21张');const value=build(f,'A',{referenceRefs:references});assert.equal(value.referenceRefs.length,20);assert.match(value.prompt,/@第21张$/);
});
test('超过1000候选时依然按URL顺序取前20个独立参考',()=>{
 const candidates=Array.from({length:1100},(_,i)=>({assetId:'asset-'+i,name:'图'+i,kind:'image'}));const result=uniqueCascadeRefs(candidates,{limit:20});assert.equal(result.length,20);assert.equal(result.at(-1).assetId,'asset-19');
});
test('runPrompt媒体标记恢复按最长名称匹配，不损坏普通文字',()=>{
 const f=cascadeFixture(),a=f.node('A');f.node('R');a.params.nativeCanvas.node.promptDraftHtml='旧草稿';a.params.nativeCanvas.node.runPrompt='@长名字 和 @长';a.params.nativeCanvas.node.runPromptRefs=[{url:'/api/assets/asset-R',name:'长'},{url:'/api/assets/asset-R',name:'长名字'}];
 const value=build(f,'A');assert.match(value.prompt,/图1 和 图1$/);assert.equal(value.displayPrompt,'@长名字 和 @长');
});
test('HTML没有提及且runPrompt不能重建时，以保存的HTML为原草稿',()=>{
 const f=cascadeFixture(),a=f.node('A',{raw:{promptDraftHtml:'<b>原草稿</b>',runPrompt:'别的已运行文字',promptDraftText:'纯文字副本'}});assert.equal(build(f,'A').prompt,'原草稿');
 a.params.nativeCanvas.node.promptDraftHtml='';a.params.nativeCanvas.node.runPrompt='已运行文字';assert.equal(build(f,'A').prompt,'已运行文字');
 delete a.params.nativeCanvas.node.runPrompt;assert.equal(build(f,'A').prompt,'');
});
test('富文本解析是惰性读取，script和缩略图不会执行或发送网络请求',()=>{
 const f=cascadeFixture(),a=f.node('A',{raw:{promptDraftHtml:'<script>globalThis.unexpectedNativeExecution=true</script><img src="https://example.invalid"><template>不在DOM childNodes中</template>'}});
 assert.equal(build(f,'A').prompt,'globalThis.unexpectedNativeExecution=true');assert.equal(globalThis.unexpectedNativeExecution,undefined);
});
test('RunningHub空提示词可采用明确提供的默认值，不为其他引擎编造文案',()=>{
 const f=cascadeFixture(),a=f.node('A',{raw:{promptDraftHtml:'',promptDraftText:''}});assert.equal(build(f,'A',{rhFallbackPrompt:'默认'}).prompt,'');a.params.cloudBinding={recipeId:'recipe'};
 assert.equal(build(f,'A',{rhFallbackPrompt:'默认'}).prompt,'默认');
});
test('组合后超长提示词和无效中继引用在提交前拒绝',()=>{
 const f=cascadeFixture();f.node('A',{raw:{promptDraftHtml:'字'.repeat(32001)}});assert.throws(()=>build(f,'A'),/超过32000/);
 assert.throws(()=>nativeCascadePromptText(f.project,'A',{context:{relayPromptNodeIds:['not-present']}}),/中继提示词节点不存在/);
});
