import test from 'node:test';
import assert from 'node:assert/strict';
import {isNativePrompt,nativePromptSettings,nativePromptItems,nativePromptLlmEnabled,nativePromptSystemDefault,normalizeNativePromptSettings,nativePromptSuggestedReferences} from '../public/native-prompt-core.js';
import {applyNativePromptSettings,readNativePromptForm,nativePromptPreviewMarkup} from '../public/native-prompt.js';
import {nativeToFragment,normalizeNativeWorkflow,fragmentToNative} from '../lib/native-canvas-core.mjs';
import {nativeNodeIssues} from '../public/native-canvas-core.js';
import {nativeFlowPreview} from '../lib/native-flow.mjs';
import {copySelectedNodes} from '../lib/canvas-tools.mjs';
import {validateProject,makeNode} from '../lib/model.mjs';

const settings=(extra={})=>({version:1,splitEnabled:true,separator:';',llmEnabled:false,instruction:'',previewHeight:70,...extra});
const project=(extra={})=>nativeToFragment(normalizeNativeWorkflow({format:'infinite-smart-canvas-workflow',version:1,nodes:[{id:'prompt',type:'smart-prompt',x:0,y:0,text:'甲;乙',promptSplitEnabled:true,...extra}],connections:[]}),[],'智能提示词设置');
const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

test('原生智能提示词按字面分隔符拆分；单段和全空分段仍保留整段源文字',()=>{
 for(const [text,separator,expected] of [[' 甲;乙; ', ';',['甲','乙']],['甲||乙\n丙','||',['甲','乙\n丙']],['甲.*乙','.*',['甲','乙']],['甲；乙','；',['甲','乙']],['甲;乙','',['甲','乙']],['甲;',';',['甲;']],[' ; ; ',';',['; ;']],['   ',';',[]]]){
  const n=project({text,promptSeparator:separator}).nodes[0];assert.deepEqual(nativePromptItems(n),expected);
 }
 const n=project({text:'甲;乙',promptSplitEnabled:false}).nodes[0];assert.deepEqual(nativePromptItems(n),['甲;乙']);assert.deepEqual(nativeNodeIssues(n),[]);
});

test('编辑本机设置保留唯一原始参数、文字和已有模型绑定，关闭改写不会移除绑定',()=>{
 const p=project({llmEnabled:true,llmInstruction:'原指令',custom:{keep:'源参数'}}),n=p.nodes[0],original=structuredClone(n.params.nativeCanvas.node);n.params.llmBinding={fixture:'保留未执行绑定'};
 applyNativePromptSettings(n,settings({separator:'||',instruction:'新指令'}));assert.equal(nativePromptLlmEnabled(n),false);assert.equal(n.text,'甲;乙');assert.deepEqual(n.params.nativeCanvas.node,original);assert.deepEqual(n.params.llmBinding,{fixture:'保留未执行绑定'});assert.deepEqual(nativePromptSettings(n),settings({separator:'||',instruction:'新指令'}));
 const view=nativeFlowPreview(p,{nodeId:n.id,execution:true});assert.deepEqual(view.nodes[0].pendingNodeIds,[]);assert.deepEqual(view.nodes[0].promptItems,['甲;乙']);assert.deepEqual(n.params.nativeCanvas.node,original);
});

test('表单只读取拆分设置，预览转义用户文字并随真实拆分条数及高度变化',()=>{
 const n=project({text:'<img src=x onerror="x">||第二段'}).nodes[0],form={elements:{splitEnabled:{checked:true},separator:{value:'||'},llmEnabled:{checked:false},instruction:{value:'本地编辑'},previewHeight:{value:'120'}}},value=readNativePromptForm(form),html=nativePromptPreviewMarkup(n,value,esc);
 assert.deepEqual(value,settings({separator:'||',instruction:'本地编辑',previewHeight:120}));assert.match(html,/2 段/);assert.match(html,/height:120px/);assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);assert.equal((html.match(/<li>/g)||[]).length,2);assert.match(nativePromptPreviewMarkup(n,{...value,splitEnabled:false},esc),/1 段/);
});

test('非法拆分版本、类型、长度、额外字段和预览高度在保存前拒绝',()=>{
 for(const value of [null,settings({version:2}),settings({splitEnabled:'true'}),settings({llmEnabled:1}),settings({separator:'123456789'}),settings({instruction:'x'.repeat(32001)}),settings({previewHeight:39}),settings({previewHeight:221}),settings({previewHeight:70.5}),settings({unknown:true})])assert.throws(()=>normalizeNativePromptSettings(value),/设置无效/);
 const p=project();p.nodes[0].params.nativePrompt=settings({separator:'123456789'});assert.throws(()=>validateProject(p),/设置无效/);
 const normal=makeNode('text',0,0);normal.params.nativePrompt=settings();p.nodes=[normal];assert.throws(()=>validateProject(p),/原生智能提示词/);
});

test('语言模型系统指令按原生开关提议，显式关闭时不偷偷启用默认指令',()=>{
 assert.equal(nativePromptSystemDefault(project({llmSystemEnabled:true,llmSystemPrompt:' 你是导演 '}).nodes[0]),'你是导演');
 assert.equal(nativePromptSystemDefault(project({llmSystemEnabled:true}).nodes[0]),'You are a helpful prompt assistant.');
 assert.equal(nativePromptSystemDefault(project({llmSystemEnabled:false,llmSystemPrompt:'旧指令'}).nodes[0]),'');
 assert.equal(nativePromptSystemDefault(makeNode('text',0,0)),'');
});

test('首次模型绑定只提议直接相连的媒体来源，避免自动选取重复的组成员或其它素材',()=>{
 const p=project(),n=p.nodes[0];p.edges=[{id:'direct',source:'group-id',target:n.id},{id:'other',source:'image-id',target:'group-id'}];
 const choices=[{value:'node:group-id'},{value:'node:image-id'},{value:'asset:fixed-id'},{value:'node:group-id'}];assert.deepEqual(nativePromptSuggestedReferences(p,n,choices),[{sourceNodeId:'group-id'}]);assert.deepEqual(nativePromptSuggestedReferences(p,makeNode('text',0,0),choices),[]);
});

test('文字拆分配置经过复制和原生 JSON 导出可用，原导入参数保持不变',()=>{
 const p=project({custom:{preserve:true}}),n=p.nodes[0],original=structuredClone(n.params.nativeCanvas.node);applyNativePromptSettings(n,settings({separator:'||',instruction:'本机指令',previewHeight:100}));n.text='新甲||新乙';
 const copied=copySelectedNodes(p,[n.id]),clone=copied.nodes.find(node=>node.id!==n.id);assert.deepEqual(clone.params.nativePrompt,n.params.nativePrompt);assert.deepEqual(clone.params.nativeCanvas.node,original);
 const raw=fragmentToNative(p,[]).nodes[0];assert.equal(raw.promptSeparator,'||');assert.equal(raw.promptSplitPreviewHeight,100);assert.equal(raw.llmInstruction,'本机指令');assert.equal(raw.text,'新甲||新乙');assert.deepEqual(raw.custom,{preserve:true});assert.deepEqual(n.params.nativeCanvas.node,original);assert.deepEqual(nativePromptItems(nativeToFragment(normalizeNativeWorkflow({nodes:[raw],connections:[]}),[],'恢复').nodes[0]),['新甲','新乙']);
});
