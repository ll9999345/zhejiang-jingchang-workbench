import test from 'node:test';
import assert from 'node:assert/strict';
import {planNativeCascade,nativeCascadeGraph,validateNativeCascadeProgram,NATIVE_CASCADE_LIMITS} from '../lib/native-cascade-plan.mjs';
import {cascadeFixture,cascadeTrace} from './helpers/native-cascade-fixture.mjs';

test('A→B→C 用发送方参数生成到接收方，两条边而非三个逐节点生成',()=>{
 const f=cascadeFixture();for(const [i,id]of ['A','B','C'].entries())f.node(id,{x:i*300});f.edge('A','B');f.edge('B','C');
 const before=structuredClone(f.project),p=planNativeCascade(f.project,{nodeId:'C'});
 assert.deepEqual(cascadeTrace(p),[[['generate','A','B','A'],['generate','B','C','B']]]);
 assert.equal(p.generationOperationCount,2);assert.equal(p.operationCount,2);assert.equal(p.loop,null);assert.deepEqual(p.pathNodeIds,['A','B','C']);
 assert.deepEqual(p.rounds[0].operations.map(op=>op.resultPolicy),['replace-with-history','replace-with-history']);
 assert.ok(p.rounds[0].operations.every(op=>op.preserveTargetConfiguration));assert.deepEqual(f.project,before);
});
test('同级共享首份结果后，各分支继续用自身参数运行下游，保持深度优先',()=>{
 const f=cascadeFixture();f.node('A');f.node('B',{x:300});f.node('C',{x:400});f.node('D',{x:600});f.node('E',{x:700});
 for(const [a,b]of [['A','B'],['A','C'],['B','D'],['C','E']])f.edge(a,b);
 const p=planNativeCascade(f.project,{nodeId:'D'}),ops=p.rounds[0].operations;
 assert.deepEqual(cascadeTrace(p),[[['generate','A','B','A'],['generate','B','D','B'],['copy','A','C',null],['generate','C','E','C']]]);
 assert.equal(p.generationOperationCount,3);assert.deepEqual(ops[2].references,{kind:'operation-output',operationId:ops[0].id});
 assert.deepEqual(ops[3].references.incoming,{kind:'operation-output',operationId:ops[2].id});
});
test('菱形汇合重复访问接收方，不用全局去重吞掉第二条分支',()=>{
 const f=cascadeFixture();for(const [i,id]of ['A','B','C','D'].entries())f.node(id,{x:i*300});
 for(const [a,b]of [['A','B'],['A','C'],['B','D'],['C','D']])f.edge(a,b);
 const p=planNativeCascade(f.project,{nodeId:'D'});
 assert.deepEqual(cascadeTrace(p),[[['generate','A','B','A'],['generate','B','D','B'],['copy','A','C',null],['generate','C','D','C']]]);
 assert.equal(p.rounds[0].operations.filter(op=>op.targetNodeId==='D').length,2);
});
test('上游主图选择横坐标较右者，相同横坐标取较上者，不看创建顺序',()=>{
 const f=cascadeFixture();f.node('A',{x:100,y:100});f.node('B',{x:400,y:200});f.node('C',{x:400,y:100});f.node('D',{x:800});
 f.edge('B','D');f.edge('A','D');f.edge('C','D');
 assert.deepEqual(planNativeCascade(f.project,{nodeId:'D'}).pathNodeIds,['C','D']);
});
test('空上游素材不冒充可追溯主图；普通独立节点不能伪装成串联',()=>{
 const f=cascadeFixture();f.node('A',{stored:false});f.node('B',{stored:false,x:300});f.node('C',{x:600});f.edge('A','B');f.edge('B','C');
 assert.throws(()=>planNativeCascade(f.project,{nodeId:'C'}),/链尾|链路/);
 f.find('B').params.nativeCanvas.node.images=[{url:'/api/assets/synthetic-existing'}];
 assert.deepEqual(planNativeCascade(f.project,{nodeId:'C'}).pathNodeIds,['B','C']);
});
test('历史节点和历史连线不成为串联生成或共享目标',()=>{
 const f=cascadeFixture();f.node('A');f.node('B',{x:400});f.node('H',{raw:{isHistoryGroup:true,historyFor:'original-A'}});f.node('X');
 f.edge('A','B');f.edge('A','H');f.edge('A','X','history');
 assert.deepEqual(cascadeTrace(planNativeCascade(f.project,{nodeId:'B'})),[[['generate','A','B','A']]]);
});
test('带直接提示词输入的循环按真实计数选择分支，源串联无需旧分支开关',()=>{
 const f=cascadeFixture();f.node('L',{kind:'smart-loop',count:4,start:2,showPrompt:true});f.node('A');f.node('B',{x:600});f.node('C',{x:500,y:100});f.node('D',{x:500,y:0});
 f.edge('L','A','input');for(const id of ['B','C','D'])f.edge('A',id);
 const p=planNativeCascade(f.project,{nodeId:'B'});
 assert.deepEqual(p.rounds.map(r=>r.choices[0].selectedNodeId),['C','B','D','C']);
 assert.deepEqual(p.rounds.map(r=>r.choices[0].targetNodeIds),Array(4).fill(['D','C','B']));
 assert.equal(p.generationOperationCount,4);assert.ok(p.rounds.every(r=>r.operations.length===1));
 assert.deepEqual(p.rounds.map(r=>r.skippedNodeIds.length),[2,2,2,2]);
});
test('关闭提示词或flow连线不触发分支选择；同级复制仍替换历史而非循环追加',()=>{
 for(const [showPrompt,edgeKind]of [[false,'input'],[true,'flow']]){
  const f=cascadeFixture();f.node('L',{kind:'smart-loop',count:2,showPrompt});f.node('A');f.node('B',{x:400});f.node('C',{x:500});f.edge('L','A',edgeKind);f.edge('A','B');f.edge('A','C');
  const p=planNativeCascade(f.project,{nodeId:'B'});
  assert.equal(p.generationOperationCount,2);assert.ok(p.rounds.every(r=>r.choices.length===0));
  assert.deepEqual(p.rounds[0].operations.map(op=>[op.kind,op.resultPolicy]),[['generate','append-loop'],['copy','replace-with-history']]);
 }
});
test('图片批次步幅同时影响计数、总数和选中分支，不用回合偏移取模',()=>{
 const f=cascadeFixture();f.node('L',{kind:'smart-loop',count:3,start:2,imageInput:true,batch:2,showPrompt:true});f.node('A');for(const [i,id]of ['B','C','D'].entries()){f.node(id,{x:300+i*100});f.edge('A',id);}f.edge('L','A','input');
 const p=planNativeCascade(f.project,{nodeId:'B'});
 assert.deepEqual(p.rounds.map(r=>[r.index,r.total,r.choices[0].selectedNodeId]),[[2,6,'C'],[4,6,'B'],[6,6,'D']]);
 assert.deepEqual(p.loop,{nodeId:'L',count:3,mode:'serial',start:2,stride:2,endIndex:6});
});
test('loop→image 的首生成使用接收方参数，loop中继本身零生成',()=>{
 const f=cascadeFixture();f.node('L',{kind:'smart-loop',count:2});f.node('A');f.node('B',{x:600});f.node('R',{kind:'smart-loop',x:400,count:9});f.node('D',{x:500});
 f.edge('L','A');f.edge('A','R');f.edge('A','B');f.edge('R','D');
 const p=planNativeCascade(f.project,{nodeId:'B'}),ops=p.rounds[0].operations;
 assert.deepEqual(cascadeTrace(p)[0],[['relay','A','R',null],['generate','R','D','D'],['copy','A','B',null]]);
 assert.equal(p.generationOperationCount,2);assert.deepEqual(ops[2].references,{kind:'operation-output',operationId:ops[0].id});
 assert.equal(ops[1].references.selfNodeId,null);assert.equal(ops[1].references.defaultNodeId,'D');
});
test('同级中途遇到循环中继会重设共享引用，后续复制不沿用较早生成结果',()=>{
 const f=cascadeFixture();f.node('L',{kind:'smart-loop'});f.node('A');f.node('B',{x:300});f.node('R',{kind:'smart-loop',x:400});f.node('C',{x:500});f.node('D',{x:700});
 for(const [a,b]of [['L','A'],['A','B'],['A','R'],['A','C'],['R','D']])f.edge(a,b);
 const ops=planNativeCascade(f.project,{nodeId:'B'}).rounds[0].operations;
 assert.deepEqual(ops.map(op=>op.kind),['generate','relay','generate','copy']);
 assert.deepEqual(ops[3].references,{kind:'operation-output',operationId:ops[1].id});
});
test('最近的上游循环决定轮数，其他循环按同一计数中继，不展开笛卡尔积',()=>{
 const f=cascadeFixture();f.node('U');f.node('L1',{kind:'smart-loop',count:11,imageInput:true});f.node('A');f.node('L2',{kind:'smart-loop',count:3,start:4,imageInput:true});f.node('B');f.node('C');
 for(const [a,b]of [['U','L1'],['L1','A'],['A','L2'],['L2','B'],['B','C']])f.edge(a,b);
 const p=planNativeCascade(f.project,{nodeId:'C'});
 assert.equal(p.loop.nodeId,'L2');assert.equal(p.rootNodeId,'B');assert.equal(p.generationOperationCount,3);
 assert.deepEqual(p.rounds.map(r=>r.index),[4,5,6]);assert.deepEqual(p.rounds[0].loopContexts,{L1:{index:4,total:6},L2:{index:4,total:6}});
});
test('上游主图可穿过允许图片输入的循环，根从该循环的直接素材中选择',()=>{
 const f=cascadeFixture();f.node('U');f.node('L',{kind:'smart-loop',count:2,imageInput:true});f.node('A');f.node('B',{x:400});f.edge('U','L');f.edge('L','A');f.edge('A','B');
 const p=planNativeCascade(f.project,{nodeId:'B'});assert.deepEqual(p.pathNodeIds,['U','A','B']);assert.equal(p.rootNodeId,'A');
 assert.deepEqual(cascadeTrace(p)[0],[['generate','A','B','A']]);
});
test('单节点循环生成独立输出槽，原节点保持发送方配置且不变成自身接收方',()=>{
 const f=cascadeFixture();f.node('L',{kind:'smart-loop',count:3,start:2,imageInput:true,batch:2,mode:'parallel'});f.node('A');f.edge('L','A','input');
 const p=planNativeCascade(f.project,{nodeId:'A'});
 assert.equal(p.singleNodeLoopRun,true);assert.equal(p.generationOperationCount,3);assert.equal(p.scheduling.mode,'parallel');
 assert.deepEqual(p.rounds.map(r=>r.operations[0].target),[2,4,6].map((index,slotIndex)=>({kind:'loop-slot',nodeId:null,rootNodeId:'A',loopId:'L',index,slotIndex})));
 assert.ok(p.rounds.every(r=>r.operations[0].requestNodeId==='A'&&r.operations[0].references.kind==='loop-input'));
});
test('循环输出槽按原编号标签复用，排除其他循环和历史槽',()=>{
 const f=cascadeFixture();f.node('L',{kind:'smart-loop',count:2,start:3});f.node('A');f.edge('L','A');
 for(const [id,x,raw]of [['wrong',200,{sourceNodeId:'original-A',loopSourceId:'other-loop',loopRoundIndex:3}],['H',300,{sourceNodeId:'original-A',isHistoryGroup:true,historyFor:'original-A',loopRoundIndex:3}],['S1',600,{sourceNodeId:'original-A',loopSourceId:'original-L',loopRoundIndex:3}],['S2',700,{sourceNodeId:'original-A',loopSlotIndex:1}]]){f.node(id,{x,raw});f.edge('A',id);}
 const p=planNativeCascade(f.project,{nodeId:'A'});
 assert.equal(p.singleNodeLoopRun,true);assert.deepEqual(p.rounds.map(r=>r.operations[0].targetNodeId),['S1','S2']);
});
test('输出槽计数标签优先于回合标签，其次取按坐标排序的无标签槽',()=>{
 const f=cascadeFixture();f.node('L',{kind:'smart-loop',count:2,start:5});f.node('A');f.edge('L','A');
 for(const [id,x,raw]of [['offset',100,{loopSlotIndex:0}],['counter',500,{loopRoundIndex:5}],['untagged',800,{}]]){f.node(id,{x,raw:{sourceNodeId:'original-A',...raw}});f.edge('A',id);}
 const p=planNativeCascade(f.project,{nodeId:'A'});assert.deepEqual(p.rounds.map(r=>r.operations[0].targetNodeId),['counter',null]);
 f.find('offset').params.nativeCanvas.node.loopSlotIndex=1;
 assert.deepEqual(planNativeCascade(f.project,{nodeId:'A'}).rounds.map(r=>r.operations[0].targetNodeId),['counter','offset']);
});
test('从循环入口运行时选择最后的直接链尾，已有生成槽不冒充工作流下游',()=>{
 const f=cascadeFixture();f.node('L',{kind:'smart-loop',count:2});f.node('A',{x:100});f.node('B',{x:300});f.node('S',{x:500,raw:{sourceNodeId:'original-B'}});f.edge('L','A');f.edge('L','B');f.edge('B','S');
 const p=planNativeCascade(f.project,{nodeId:'L'});assert.equal(p.tailNodeId,'B');assert.equal(p.singleNodeLoopRun,true);assert.equal(p.generationOperationCount,2);
});
test('运行入口必须为合格链尾；未启用循环、错误节点和循环依赖均阻断',()=>{
 const f=cascadeFixture();f.node('L',{kind:'smart-loop',enabled:false});f.node('A');f.node('B');f.edge('L','A');f.edge('A','B');
 assert.throws(()=>planNativeCascade(f.project,{nodeId:'B'}),/明确启用/);assert.throws(()=>planNativeCascade(f.project,{nodeId:'A'}),/链尾/);
 assert.throws(()=>planNativeCascade(f.project,{nodeId:'missing'}),/不存在/);assert.throws(()=>planNativeCascade(f.project),/请选择/);
 f.edge('B','A');assert.throws(()=>planNativeCascade(f.project,{nodeId:'B'}),/循环依赖/);
});
test('直接提示词循环只在目标尚未直接连接该循环时加入本次请求的中继提示',()=>{
 const f=cascadeFixture();f.node('L',{kind:'smart-loop',showPrompt:true});f.node('A');f.node('B');f.node('C');f.edge('L','A','input');f.edge('A','B');f.edge('B','C');
 let p=planNativeCascade(f.project,{nodeId:'C'});assert.deepEqual(p.rounds[0].operations.map(op=>op.relayPromptNodeIds),[['L'],[]]);
 f.edge('L','B','input');p=planNativeCascade(f.project,{nodeId:'C'});assert.deepEqual(p.rounds[0].operations[0].relayPromptNodeIds,[]);
});
test('首生成保存自图→默认参考→入边引用优先级，缺提示时只允许入边复制回退',()=>{
 const f=cascadeFixture();f.node('A');f.node('B');f.node('C');f.edge('A','B');f.edge('B','C');
 const ops=planNativeCascade(f.project,{nodeId:'C'}).rounds[0].operations;
 assert.deepEqual(ops[0].references,{kind:'self-default-incoming',selfNodeId:'A',defaultNodeId:'A',incoming:{kind:'default',nodeId:'A'}});
 assert.deepEqual(ops[1].missingPromptFallback,{reference:{kind:'operation-output',operationId:ops[0].id},resultPolicy:'replace-with-history'});
});
test('不同kind的重复同向连线保持源遍历次数，不擅自把接收方全局去重',()=>{
 const f=cascadeFixture();f.node('A');f.node('B');f.edge('A','B','input');f.edge('A','B','flow');
 const p=planNativeCascade(f.project,{nodeId:'B'});assert.deepEqual(cascadeTrace(p),[[['generate','A','B','A'],['copy','A','B',null]]]);
 assert.equal(nativeCascadeGraph(f.project,{nodeId:'B'}).edges.length,1);
});
test('已展开执行清单逐字段复核原快照，错误请求归属或复制伪装生成不能恢复',()=>{
 const f=cascadeFixture();f.node('A');f.node('B');f.node('C',{x:300});f.edge('A','B');f.edge('A','C');
 const p=planNativeCascade(f.project,{nodeId:'B'});assert.deepEqual(validateNativeCascadeProgram(f.project,p),p);
 for(const mutate of [p=>p.rounds[0].operations[0].requestNodeId='B',p=>p.rounds[0].operations[1].kind='generate',p=>p.operationCount++,p=>p.rounds[0].operations[1].references.operationId='missing',p=>p.rounds[0].forceWorkflow=true,p=>p.version=2]){
  const copy=structuredClone(p);mutate(copy);assert.throws(()=>validateNativeCascadeProgram(f.project,copy),/不一致|版本无效/);
 }
});
test('分支坐标改变导致原执行清单复核失败，不沿用过期选择',()=>{
 const f=cascadeFixture();f.node('L',{kind:'smart-loop',showPrompt:true});f.node('A');f.node('B',{x:400});f.node('C',{x:500});f.edge('L','A','input');f.edge('A','B');f.edge('A','C');
 const p=planNativeCascade(f.project,{nodeId:'B'});f.find('C').x=300;
 assert.throws(()=>validateNativeCascadeProgram(f.project,p),/不一致/);
});
test('生成步骤上限与传递步骤上限分别计算，菱形展开也受限',()=>{
 const f=cascadeFixture();f.node('L',{kind:'smart-loop',count:100});f.node('A');f.edge('L','A');let parent='A';
 for(let i=0;i<11;i++){const id='n'+i;f.node(id,{x:(i+1)*300});f.edge(parent,id);parent=id;}
 assert.throws(()=>planNativeCascade(f.project,{nodeId:parent}),/1000个生成/);
 const d=cascadeFixture();d.node('A');let prev=['A'];
 for(let level=0;level<11;level++){const current=['l'+level+'a','l'+level+'b'];for(const id of current)d.node(id,{x:300*(level+1)});for(const from of prev)for(const to of current)d.edge(from,to);prev=current;}
 d.node('tail',{x:4000});for(const from of prev)d.edge(from,'tail');
 assert.throws(()=>planNativeCascade(d.project,{nodeId:'tail'}),/1000个生成|3200步/);assert.equal(NATIVE_CASCADE_LIMITS.operations,3200);
});
