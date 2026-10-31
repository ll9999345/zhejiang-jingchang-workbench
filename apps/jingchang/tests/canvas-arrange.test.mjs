import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {arrangeCanvasSelection as arrange} from '../public/canvas-arrange-core.js';
import {normalizeNativeWorkflow,nativeToFragment,fragmentToNative} from '../lib/native-canvas-core.mjs';
import {validateProject} from '../lib/model.mjs';

const node=(id,x,y,extra={})=>({id,type:'text',x,y,title:id,text:'保留内容',params:{model:'未调用模型',seed:42},...extra});
const edge=(source,target)=>({id:source+'-'+target,source,target});
const project=(nodes,edges=[],groups=[])=>({nodes,edges,groups,assets:[{id:'original'}],viewport:{zoom:.7,x:99,y:10},runs:[{status:'running',taskId:'unchanged'}],messages:[{text:'原记录'}]});
const xy=p=>p.nodes.map(({id,x,y})=>({id,x,y}));
function preserved(before,after){const strip=p=>({...p,nodes:p.nodes.map(({x,y,...n})=>n)});assert.deepEqual(strip(after),strip(before));}

// Only these five reviewed, local geometry functions are evaluated. The full
// upstream application is never loaded or run. The fixture has no I/O bindings.
const source=readFileSync('tests/fixtures/reference/07-canvas.js','utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'a1e2dd0ba845ededca8a4351d0889e3569bab46479715408d22d2512482de1ed');
const geometry=source.slice(source.indexOf('function connectedClusterIds('),source.indexOf('function arrangeSelectedCanvasNodes('));
// Supply the same rendered geometry to both implementations; the two UIs
// intentionally use different fallback card sizes.
function reference(p,ids,rects={}){
 const nodes=structuredClone(p.nodes).map(n=>({...n,type:n.params?.nativeCanvas?.node?.type||n.type,items:n.params?.nativeCanvas?.members?.map(m=>m.sourceNodeId)}));
 const context=vm.createContext({nodes,connections:p.edges.map(e=>({from:e.source,to:e.target})),explicit:ids,rects},{codeGeneration:{strings:false,wasm:false}});
 vm.runInContext('function nodeRect(n){const r=rects[n.id]||{};return{x:n.x,y:n.y,w:r.width||n.w||288,h:r.height||n.h||270};}\n'+geometry+'\narrangeIdsByConnections(explicit.length>1?explicit:connectedClusterIds(explicit[0]));',context,{timeout:200});
 return nodes.map(({id,x,y})=>({id,x,y}));
}

test('多选仅整理选区，连线分列，真实尺寸决定间隔，内容及任务保持',()=>{
 const p=project([node('a',300,600),node('b',100,100),node('c',50,800),node('outside',900,11)],[edge('a','b'),edge('b','outside')]),before=structuredClone(p);
 const r=arrange(p,['a','b','c'],{rects:{a:{width:400,height:200},b:{width:100,height:100},c:{width:300,height:150}}});
 assert.deepEqual(xy(r.project),[{id:'a',x:50,y:100},{id:'b',x:630,y:100},{id:'c',x:50,y:356},{id:'outside',x:900,y:11}]);
 assert.deepEqual(p,before);preserved(p,r.project);assert.equal(r.mode,'selected');assert.equal(r.changed,true);
});
test('单选同时扩展上游下游，断开的节点不移动',()=>{
 const p=project([node('a',400,300),node('b',20,500),node('c',200,20),node('d',5,5)],[edge('a','b'),edge('b','c')]);
 const r=arrange(p,['b']);assert.deepEqual(new Set(r.scopeNodeIds),new Set(['a','b','c']));assert.deepEqual(r.project.nodes[3],p.nodes[3]);assert.equal(r.mode,'connected');assert.deepEqual(r.columns.map(c=>c.atomIds),[['a'],['b'],['c']]);
});
test('空选区、单个孤立节点及已经排好均不产生变更',()=>{
 const p=project([node('a',10,20),node('b',478,20)],[edge('a','b')]);
 for(const ids of [[],['missing'],['a','b']])assert.equal(arrange(p,ids).changed,false);
 const isolated=project([node('a',10,20)]);assert.equal(arrange(isolated,['a']).changed,false);assert.notEqual(arrange(isolated,[]).project,isolated);
});
test('同列按Y及编号排序；最小行高、列宽与缺失连线处理',()=>{
 const p=project([node('z',30,30),node('a',30,30),node('b',700,70)],[edge('z','b'),edge('ghost','a')]);
 const r=arrange(p,['z','a','b','z'],{rects:{z:{width:10,height:10},a:{width:10,height:10},b:{width:10,height:10}}});
 assert.deepEqual(r.columns.map(c=>c.atomIds),[['a','z'],['b']]);assert.equal(r.project.nodes[0].y,206);assert.equal(r.project.nodes[2].x,430);
});
test('原生组及其镜场显示框仅提升一次，保留组员相对位置',()=>{
 const g=node('g',100,100,{w:500,h:400,params:{nativeCanvas:{node:{type:'group'},members:[{sourceNodeId:'a'},{sourceNodeId:'b'}]}}});
 const p=project([g,node('a',120,150),node('b',180,260),node('c',0,0),node('out',20,20)],[],[{id:'mirror',title:'原生组',nodeIds:['a','b']}]);
 const r=arrange(p,['a','c']);assert.deepEqual(xy(r.project),reference(p,['a','c']));preserved(p,r.project);assert.equal(r.scopeNodeIds.filter(k=>k==='a').length,1);
 const da=r.project.nodes[1].x-p.nodes[1].x,db=r.project.nodes[2].x-p.nodes[2].x;assert.equal(da,db);assert.deepEqual(r.project.nodes[4],p.nodes[4]);
});
test('单选先按原始连线找簇，不经未选组员继续扩展',()=>{
 const p=project([node('g',100,100,{params:{nativeCanvas:{node:{type:'group'},members:[{sourceNodeId:'a'},{sourceNodeId:'b'}]}}}),node('a',120,150),node('b',180,260),node('c',0,0),node('out',20,20)],[edge('a','c'),edge('b','out')]);
 const r=arrange(p,['a']);assert.deepEqual(new Set(r.scopeNodeIds),new Set(['g','a','b','c']));assert.deepEqual(r.project.nodes[4],p.nodes[4]);assert.deepEqual(xy(r.project),reference(p,['a']));
});
test('镜场普通组与折叠组作为整体，所有组员同量平移',()=>{
 for(const collapsed of [false,true]){
  const p=project([node('a',120,150),node('b',180,260),node('c',0,0)],[],[{id:'local',title:'本机组',collapsed,nodeIds:['a','b']}]),r=arrange(p,['a','c']);
  assert.equal(r.project.nodes[1].x-r.project.nodes[0].x,60);assert.equal(r.project.nodes[1].y-r.project.nodes[0].y,110);preserved(p,r.project);
  assert.deepEqual(r.columns[0].atomIds,['c','group:local']);assert.equal(r.project.nodes[0].y,370);
 }
});
test('嵌套组递归移动一次，循环、重叠、失效成员阻止移动',()=>{
 const group=(id,members)=>node(id,30,30,{params:{nativeCanvas:{node:{type:'group'},members:members.map(sourceNodeId=>({sourceNodeId}))}}});
 const p=project([group('outer',['inner']),group('inner',['a']),node('a',50,80),node('z',0,0)]),r=arrange(p,['a','z']);assert.equal(r.project.nodes[2].x-r.project.nodes[1].x,20);
 for(const bad of [project([group('g',['a']),group('h',['a']),node('a',0,0)]),project([group('g',['h']),group('h',['g'])]),project([group('g',['missing'])])]){const old=structuredClone(bad);assert.throws(()=>arrange(bad,bad.nodes.map(n=>n.id)),/分组/);assert.deepEqual(bad,old);}
});
test('有向环及非拓扑遍历顺序忠实对齐固定源算法',()=>{
 for(const edges of [[edge('a','b'),edge('b','a')],[edge('a','b'),edge('c','d'),edge('d','c')],[edge('a','b'),edge('b','d'),edge('a','c'),edge('c','e'),edge('e','d')]]){
  const p=project(['a','b','c','d','e'].map((id,i)=>node(id,100*i,20*i,{w:260,h:200})),edges),ids=p.nodes.map(n=>n.id);assert.deepEqual(xy(arrange(p,ids).project),reference(p,ids));
 }
});
test('80组确定性几何与单选/多选结果同固定源独立对照',()=>{
 let seed=123;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
 for(let k=0;k<80;k++){
  const nodes=Array.from({length:8},(_,i)=>node('n'+i,Math.floor(random()*1400)-300,Math.floor(random()*900)-100,{w:220+Math.floor(random()*200),h:120+Math.floor(random()*250)})),edges=[];
  for(let i=0;i<8;i++)for(let j=i+1;j<8;j++)if(random()<.25)edges.push(edge('n'+i,'n'+j));
  const p=project(nodes,edges),ids=k%2?['n3']:['n0','n2','n3','n5','n7'];assert.deepEqual(xy(arrange(p,ids).project),reference(p,ids),'fixture '+k);preserved(p,arrange(p,ids).project);
 }
});
test('坐标越界阻止整个操作，输入保持；缺省尺寸无NaN',()=>{
 const p=project([node('a',1e7,0),node('b',1e7,50)],[edge('a','b')]),old=structuredClone(p);assert.throws(()=>arrange(p,['a','b']),/超出/);assert.deepEqual(p,old);
 const r=arrange(project([node('a',10,90),node('b',20,40)]),['a','b'],{rects:{a:{width:NaN,height:Infinity}}});assert.ok(r.project.nodes.every(n=>Number.isFinite(n.x)&&Number.isFinite(n.y)));
});
test('实际原生导入、整理、校验及导出保留编号、组成员、原始字段和连线',()=>{
 const raw={format:'infinite-canvas-workflow',version:1,nodes:[{id:'a',type:'prompt',x:120,y:240,text:'原始文本',custom:{keep:true}},{id:'g',type:'group',x:100,y:100,w:420,h:340,items:['a']},{id:'b',type:'prompt',x:0,y:0,text:'独立文本'}],connections:[{from:'g',to:'b',custom:'original-edge'}]};
 const p=nativeToFragment(normalizeNativeWorkflow(raw),[],'原生局部整理'),r=arrange(p,[p.nodes[0].id,p.nodes[2].id]);validateProject(r.project);preserved(p,r.project);
 const out=fragmentToNative(r.project,[]);assert.deepEqual(out.nodes.map(n=>n.id),['a','g','b']);assert.deepEqual(out.nodes[1].items,['a']);assert.deepEqual(out.nodes[0].custom,{keep:true});assert.equal(out.nodes[0].text,'原始文本');assert.equal(out.connections[0].custom,'original-edge');
 assert.equal(out.nodes[0].x-out.nodes[1].x,20);assert.equal(out.nodes[0].y-out.nodes[1].y,140);assert.equal(out.nodes[1].x,0);assert.equal(out.nodes[1].y,0);assert.equal(out.nodes[2].x,600);
});
