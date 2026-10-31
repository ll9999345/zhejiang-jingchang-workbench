import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeFlowResultMarkup} from '../public/native-flow-panel.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const value=(extra={})=>({promptItems:[],media:[],pendingNodeIds:[],issues:[],...extra});
function fixture(){
 const project={revision:99,nodes:[{id:'target',title:'当前编辑的生成节点'},{id:'first',title:'来源甲'},{id:'second',title:'来源乙'}]};
 const result={revision:17,source:'saved-project',inputs:value(),nodes:[value({nodeId:'target',status:'resolved'})]};
 const render=(selected=result)=>nativeFlowResultMarkup(selected,{nodeId:'target',project,esc});
 return{project,result,render};
}
function inOrder(text,items){
 let previous=-1;
 for(const item of items){const index=text.indexOf(item,previous+1);assert.ok(index>previous,`Missing or out of order: ${item}`);previous=index;}
}

test('已保存画布检查标明响应版本，不冒称当前未保存编辑或任务快照',()=>{
 const f=fixture(),html=f.render();
 assert.match(html,/已保存项目版本 17/);
 assert.match(html,/下方内容按已保存的画布解析/);
 assert.doesNotMatch(html,/任务快照版本|已保存项目版本 99|任务原始快照/);
 assert.match(html,/是否能够执行，以画布运行前的检查为准/);
});

test('任务结果同时展示原快照和当前保存版本，回合使用人类可读序号',()=>{
 const f=fixture();
 f.result.source='job-snapshot';
 f.result.resultJob={id:'job-keep-original',status:'interrupted',projectRevision:3,currentProjectRevision:24,completedOutputNodes:2,loopId:'loop-a',roundIndex:1};
 f.result.nodes[0].promptItems=['原任务已完成的文字'];
 const html=f.render();
 assert.match(html,/任务快照版本 3 · 当前已保存项目版本 24/);
 assert.match(html,/job-keep-original/);assert.match(html,/中断/);
 assert.match(html,/2 个已完成结果节点/);assert.match(html,/循环第 2 回合/);
 assert.match(html,/下方内容按任务原始快照解析/);
 assert.match(html,/原任务已完成的文字/);
 assert.doesNotMatch(html,/下方内容按已保存的画布解析|已保存项目版本 99/);
});

test('输入文字、素材、来源明细与节点输出各自保留服务端给出的顺序',()=>{
 const f=fixture();
 f.result.inputs=value({
  promptItems:['输入文字乙\n仍在同一项','输入文字甲'],
  media:[{assetId:'input-b',name:'输入素材乙',kind:'image',sourceNodeId:'second'},{assetId:'input-a',name:'输入素材甲',kind:'video',sourceNodeId:'first'}],
  sources:[{sourceNodeId:'second',itemType:'generated',...value({promptItems:['来源明细乙']})},{sourceNodeId:'first',itemType:'group-prompts',...value({promptItems:['来源明细甲']})}]
 });
 f.result.nodes[0]=value({nodeId:'target',status:'resolved',promptItems:['输出文字二','输出文字一'],media:[{assetId:'output-b',name:'输出素材二',kind:'audio',sourceNodeId:'second'},{assetId:'output-a',name:'输出素材一',kind:'image',sourceNodeId:'first'}]});
 const html=f.render(),inputs=html.slice(html.indexOf('有序输入'),html.indexOf('节点输出')),sources=inputs.slice(inputs.indexOf('按来源查看')),outputs=html.slice(html.indexOf('节点输出'));
 inOrder(inputs,['输入文字乙\n仍在同一项','输入文字甲']);
 inOrder(inputs,['输入素材乙','输入素材甲']);
 inOrder(sources,['来源乙','生成结果','来源明细乙','来源甲','组内提示词','来源明细甲']);
 inOrder(outputs,['输出文字二','输出文字一']);inOrder(outputs,['输出素材二','输出素材一']);
 assert.match(inputs,/素材 · 2 项/);assert.match(outputs,/素材 · 2 项/);
});

test('等待的上游、输入问题、输出问题和中文状态均可见，不仅展示空列表',()=>{
 const f=fixture();
 f.result.inputs=value({pendingNodeIds:['second','first'],issues:['素材序号还未选择']});
 f.result.nodes[0]=value({nodeId:'target',status:'blocked',pendingNodeIds:['first'],issues:['本轮结果缺少必需音频']});
 const html=f.render();
 assert.match(html,/等待上游：来源乙、来源甲/);
 assert.match(html,/素材序号还未选择/);assert.match(html,/本轮结果缺少必需音频/);
 assert.match(html,/节点输出 · 存在待处理项/);
 f.result.nodes[0].status='pending';assert.match(f.render(),/节点输出 · 等待上游/);
 f.result.nodes[0].status='resolved';assert.match(f.render(),/节点输出 · 已解析/);
});

test('节点名、素材名、提示词、问题和未知状态均转义，媒体地址只编码为本机路径',()=>{
 const f=fixture(),nodeName='<svg onload="bad()">&来源',assetName='<img src=x onerror="bad()">',prompt='<a href="javascript:bad()">提示&词</a>',assetId='folder/"><script>bad</script>?x=1&y=2';
 f.project.nodes[1].title=nodeName;
 f.result.resultJob={id:'<script>task</script>',status:'<b>unknown</b>',projectRevision:4,currentProjectRevision:5,completedOutputNodes:1};
 f.result.inputs=value({pendingNodeIds:['first'],issues:['<iframe src="bad">'],promptItems:[prompt],media:[{assetId,name:assetName,kind:'<style>bad</style>',sourceNodeId:'first'}],sources:[{sourceNodeId:'first',itemType:'<img src=x>',...value()}]});
 const html=f.render();
 for(const text of [nodeName,assetName,prompt,'<iframe src="bad">','<script>task</script>','<b>unknown</b>','<style>bad</style>'])assert.ok(html.includes(esc(text)),`Expected escaped text: ${text}`);
 assert.ok(html.includes(`href="/media/${encodeURIComponent(assetId)}"`));
 assert.doesNotMatch(html,/<(?:script|svg|img|iframe|style|a href="javascript:)/i);
 assert.doesNotMatch(html,/href="folder\/|href="javascript:/);
 assert.match(html,/target="_blank" rel="noopener"/);
});

test('快照不含选中节点时说明缺失，而非把其它节点输出误当当前结果',()=>{
 const f=fixture();
 f.result.nodes=[value({nodeId:'other',status:'completed',promptItems:['其它节点的私人结果']})];
 const html=f.render();
 assert.match(html,/此快照中没有当前节点/);
 assert.doesNotMatch(html,/其它节点的私人结果/);
 assert.match(html,/没有文字项/);assert.match(html,/没有素材项/);
 delete f.result.nodes;assert.match(f.render(),/此快照中没有当前节点/);
});

test('渲染不修改传入快照、项目或有序来源数组',()=>{
 const f=fixture();
 f.result.inputs=value({promptItems:['乙','甲'],media:[{assetId:'b',name:'乙',kind:'image',sourceNodeId:'second'},{assetId:'a',name:'甲',kind:'image',sourceNodeId:'first'}],sources:[{sourceNodeId:'second',...value()},{sourceNodeId:'first',...value()}]});
 const before=structuredClone({result:f.result,project:f.project});
 f.render();
 assert.deepEqual({result:f.result,project:f.project},before);
});
