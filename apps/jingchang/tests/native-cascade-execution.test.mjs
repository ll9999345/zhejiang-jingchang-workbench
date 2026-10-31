import test from 'node:test';
import assert from 'node:assert/strict';
import {cascadeFixture} from './helpers/native-cascade-fixture.mjs';
import {planNativeCascade} from '../lib/native-cascade-plan.mjs';
import {createNativeCascadeState,executeNativeCascade,validateNativeCascadeState} from '../lib/native-cascade-execution.mjs';

const result=id=>[{assetId:id,kind:'image',name:id+'.png'}];
function graph(pairs,options={}){
 const f=cascadeFixture(),ids=[...new Set(pairs.flat())];for(const [i,id]of ids.entries())f.node(id,{x:i*300,...options[id]});for(const [a,b]of pairs)f.edge(a,b);return f;
}
function harness(){
 const calls=[],saved=[];
 return{calls,saved,persist:async state=>saved.push(structuredClone(state)),generate:async request=>{
  calls.push(request);await request.onAccepted(request.childJobId||'child-'+calls.length);return result('result-'+calls.length);
 }};
}

test('串联真正按发送方生成、接收方落结果；参数和原工程不被改写',async()=>{
 const f=graph([['A','B'],['B','C']]),program=planNativeCascade(f.project,{nodeId:'C'}),before=structuredClone(f.project),h=harness();
 const state=await executeNativeCascade({project:f.project,program,...h});
 assert.equal(state.status,'completed');assert.deepEqual(h.calls.map(call=>[call.requestNode.id,call.targetNodeId,call.referenceRefs.map(ref=>ref.assetId)]),[['A','B',['asset-A']],['B','C',['result-1']]]);
 assert.deepEqual(h.calls.map(call=>call.requestNode.params.nativeCanvas.node.promptDraftText),['参数属于 A','参数属于 B']);
 assert.deepEqual(state.receivers.B.currentRefs.map(ref=>ref.assetId),['result-1']);assert.deepEqual(state.receivers.C.currentRefs.map(ref=>ref.assetId),['result-2']);
 assert.deepEqual(f.project,before);validateNativeCascadeState(f.project,program,state);assert.ok(h.saved.every(state=>JSON.stringify(state).includes('snapshotDigest')));
});
test('分叉只生成首份，再复制到同级；复制后的分支用自己的参数继续',async()=>{
 const f=graph([['A','B'],['A','C'],['B','D'],['C','E']]),program=planNativeCascade(f.project,{nodeId:'D'}),h=harness();
 const state=await executeNativeCascade({project:f.project,program,...h});
 assert.deepEqual(h.calls.map(call=>[call.requestNode.id,call.targetNodeId]),[['A','B'],['B','D'],['C','E']]);
 assert.deepEqual(h.calls.map(call=>call.referenceRefs.map(ref=>ref.assetId)),[['asset-A'],['result-1'],['result-1']]);
 assert.deepEqual(state.receivers.C.currentRefs.map(ref=>ref.assetId),['result-1']);assert.equal(state.completedOperationCount,4);assert.equal(state.rounds[0].receipts[2].childJobId,null);
});
test('菱形接收方的后次结果替换前次，前次进入历史，配置仍属于原接收方',async()=>{
 const f=graph([['A','B'],['A','C'],['B','D'],['C','D']]),program=planNativeCascade(f.project,{nodeId:'D'}),h=harness();
 const state=await executeNativeCascade({project:f.project,program,...h});
 assert.deepEqual(h.calls.map(call=>call.requestNode.id),['A','B','C']);assert.deepEqual(state.receivers.D.currentRefs.map(ref=>ref.assetId),['result-3']);
 assert.deepEqual(state.receivers.D.historyRefs.map(ref=>ref.assetId),['result-2','asset-D']);
 assert.equal(f.find('D').params.nativeCanvas.node.promptDraftText,'参数属于 D');
 assert.deepEqual(state.rounds[0].nodeOutputs.D.map(ref=>ref.assetId),['result-3']);
});
test('循环叶子首次归档旧结果，后续追加；同级复制各轮仍替换历史',async()=>{
 const f=graph([['L','A'],['A','B'],['A','C']],{L:{kind:'smart-loop',count:3}}),program=planNativeCascade(f.project,{nodeId:'B'}),h=harness();
 const state=await executeNativeCascade({project:f.project,program,...h});
 assert.equal(h.calls.length,3);assert.deepEqual(state.receivers.B.currentRefs.map(ref=>ref.assetId),['result-1','result-2','result-3']);
 assert.deepEqual(state.receivers.B.historyRefs.map(ref=>ref.assetId),['asset-B']);assert.deepEqual(state.receivers.C.currentRefs.map(ref=>ref.assetId),['result-3']);
 assert.deepEqual(state.receivers.C.historyRefs.map(ref=>ref.assetId),['result-2','result-1','asset-C']);
});
test('loop中继零调用，循环到图片使用接收方配置，不抹掉原loop数据',async()=>{
 const f=graph([['L','A'],['A','R'],['A','B'],['R','D']],{L:{kind:'smart-loop',count:2},R:{kind:'smart-loop',x:100},B:{x:500}}),program=planNativeCascade(f.project,{nodeId:'B'}),h=harness();
 const state=await executeNativeCascade({project:f.project,program,...h});
 assert.deepEqual(h.calls.map(call=>call.requestNode.id),['D','D']);assert.equal(state.receivers.R,undefined);
 assert.deepEqual(state.receivers.B.currentRefs.map(ref=>ref.assetId),['asset-A']);assert.equal(state.rounds[0].receipts[0].kind,'relay');
});
test('空的同级分享不擦除原接收图，下游可以继续读取自己的旧图',async()=>{
 const f=graph([['L','A'],['A','R'],['R','S'],['R','B'],['S','D'],['B','E']],{L:{kind:'smart-loop'},R:{kind:'smart-loop',x:100},S:{kind:'smart-loop',x:200},B:{x:400}});
 // R has no image input: R→S resets shared refs to empty, then R→B copies
 // nothing. A still has the stored media required to locate the source root.
 f.node('T',{x:2000});f.edge('A','T');
 const program=planNativeCascade(f.project,{nodeId:'T'}),h=harness(),state=await executeNativeCascade({project:f.project,program,...h});
 assert.equal(state.status,'completed');assert.deepEqual(h.calls.map(call=>call.requestNode.id),['D','B']);
 assert.deepEqual(h.calls.find(call=>call.requestNode.id==='B').referenceRefs.map(ref=>ref.assetId),['asset-B']);
 assert.equal(state.rounds[0].nodeOutputs.B,undefined);assert.equal(state.receivers.B,undefined);
});
test('素材种类不被复制操作改成图片，视频可共享给同级接收器',async()=>{
 const f=graph([['A','B'],['A','C']]),program=planNativeCascade(f.project,{nodeId:'B'}),h=harness();
 const state=await executeNativeCascade({project:f.project,program,...h,generate:async call=>{await call.onAccepted('video-child');return[{assetId:'video-result',kind:'video',name:'result.mp4'}];}});
 assert.deepEqual(state.receivers.C.currentRefs.map(ref=>[ref.assetId,ref.kind]),[['video-result','video']]);
});
test('单节点循环有稳定独立槽编号，按本轮循环输入生成且不覆盖发送方',async()=>{
 const f=graph([['U','L'],['L','A']],{L:{kind:'smart-loop',count:2,imageInput:true,start:1}});f.project.edges[0].nativeCanvasConnection.kind='input';
 const program=planNativeCascade(f.project,{nodeId:'A'}),h=harness(),initial=createNativeCascadeState(f.project,program),slotIds=initial.slots.map(slot=>slot.nodeId);
 const state=await executeNativeCascade({project:f.project,program,state:initial,...h});
 assert.deepEqual(state.slots.map(slot=>slot.nodeId),slotIds);assert.equal(state.receivers.A,undefined);
 assert.deepEqual(h.calls.map(call=>[call.requestNode.id,call.targetNodeId]),slotIds.map(id=>['A',id]));
 assert.deepEqual(h.calls.map(call=>call.referenceRefs.map(ref=>ref.assetId)),[['asset-U'],[]]);
});
test('并行回合按后端数量限流，下游只使用本轮的生成结果',async()=>{
 const f=graph([['L','A'],['A','B'],['B','C']],{L:{kind:'smart-loop',count:4,mode:'parallel'}}),program=planNativeCascade(f.project,{nodeId:'C'}),h=harness();let active=0,peak=0;const refs=[];
 const state=await executeNativeCascade({project:f.project,program,...h,comfyInstanceCount:2,generate:async call=>{
  active++;peak=Math.max(peak,active);await call.onAccepted('child-'+call.context.roundIndex+'-'+call.requestNode.id);
  refs.push([call.context.roundIndex,call.requestNode.id,call.referenceRefs.map(ref=>ref.assetId)]);
  await new Promise(resolve=>setTimeout(resolve,call.context.roundIndex===0?20:3));active--;
  return result('r'+call.context.roundIndex+'-'+call.requestNode.id);
 }});
 assert.equal(state.status,'completed');assert.equal(peak,2);assert.equal(refs.length,8);
 assert.deepEqual(refs.filter(([,id])=>id==='B').sort((a,b)=>a[0]-b[0]),[0,1,2,3].map(index=>[index,'B',['r'+index+'-A']]));
 assert.equal(state.receivers.C.currentRefs.length,4);assert.equal(state.receivers.C.historyRefs.length,1);
});
test('已接受步骤中断后查询同一子任务，不重新提交；完成步骤也不再调用',async()=>{
 const f=graph([['A','B'],['B','C']]),program=planNativeCascade(f.project,{nodeId:'C'}),h=harness(),controller=new AbortController();let submits=0,resumes=0;
 const generate=async call=>{if(call.resume){resumes++;assert.equal(call.childJobId,'original-child');return result('restored-result');}submits++;await call.onAccepted(submits===1?'original-child':'second-child');if(submits===1){controller.abort();call.signal.throwIfAborted();}return result('second-result');};
 const stopped=await executeNativeCascade({project:f.project,program,...h,generate,signal:controller.signal});
 assert.equal(stopped.status,'stopped');assert.equal(stopped.rounds[0].receipts[0].childJobId,'original-child');
 const completed=await executeNativeCascade({project:f.project,program,state:structuredClone(stopped),...h,generate});
 assert.equal(completed.status,'completed');assert.equal(submits,2);assert.equal(resumes,1);
 await executeNativeCascade({project:f.project,program,state:completed,...h,generate});assert.equal(submits,2);assert.equal(resumes,1);
});
test('没有确认子任务编号的中断不能自动重发',async()=>{
 const f=graph([['A','B']]),program=planNativeCascade(f.project,{nodeId:'B'}),h=harness();let attempts=0;
 const generate=async()=>{attempts++;throw Error('连接断开，提交状态未知');};
 const failed=await executeNativeCascade({project:f.project,program,...h,generate});assert.equal(failed.status,'failed');assert.equal(attempts,1);
 const resumed=await executeNativeCascade({project:f.project,program,state:failed,...h,generate});assert.equal(resumed.status,'failed');assert.equal(attempts,1);assert.match(resumed.error,/不会自动重发/);
});
test('缺少提示词时复制入边素材并继续，记录回退，不冒充成功的生成请求',async()=>{
 const f=graph([['A','B'],['B','C']]),program=planNativeCascade(f.project,{nodeId:'C'}),h=harness();let calls=0;
 const state=await executeNativeCascade({project:f.project,program,...h,generate:async call=>{
  if(++calls===1)throw Error('链路节点缺少提示词');await call.onAccepted('child-after-copy');return result('after-copy');
 }});
 assert.equal(state.status,'completed');assert.equal(state.rounds[0].receipts[0].usedFallback,true);assert.equal(state.rounds[0].receipts[0].childJobId,null);
 assert.deepEqual(state.receivers.B.currentRefs.map(ref=>ref.assetId),['asset-A']);assert.deepEqual(state.receivers.C.currentRefs.map(ref=>ref.assetId),['after-copy']);
});
test('停止发生在完成步骤之后，保存部分结果，下次仅执行未完成操作',async()=>{
 const f=graph([['A','B'],['B','C']]),program=planNativeCascade(f.project,{nodeId:'C'}),h=harness(),controller=new AbortController();
 const stopped=await executeNativeCascade({project:f.project,program,...h,signal:controller.signal,persist:async state=>{h.saved.push(structuredClone(state));if(state.completedOperationCount===1)controller.abort();}});
 assert.equal(stopped.status,'stopped');assert.equal(stopped.completedOperationCount,1);assert.equal(h.calls.length,1);
 const state=await executeNativeCascade({project:f.project,program,state:stopped,...h});assert.equal(state.status,'completed');assert.equal(h.calls.length,2);
});
test('子任务编号改变、缺少接收回执或空结果均阻断下游',async()=>{
 for(const generate of [async call=>{await call.onAccepted('one');await call.onAccepted('another');return result('x');},async()=>result('x'),async call=>{await call.onAccepted('one');return[];}]){
  const f=graph([['A','B'],['B','C']]),program=planNativeCascade(f.project,{nodeId:'C'}),h=harness(),state=await executeNativeCascade({project:f.project,program,...h,generate});
  assert.equal(state.status,'failed');assert.equal(state.completedOperationCount,0);assert.equal(state.rounds[0].receipts.length,1);
 }
});
test('恢复前复核原配置和结果投影，篡改记录不得写入或调用适配器',async()=>{
 const f=graph([['A','B']]),program=planNativeCascade(f.project,{nodeId:'B'}),h=harness(),state=await executeNativeCascade({project:f.project,program,...h});
 const originals=h.calls.length,writes=h.saved.length;
 for(const mutate of [s=>s.receivers.B.currentRefs[0].assetId='forged',s=>s.completedOperationCount++,s=>s.completedOrder=[],s=>s.rounds[0].receipts[0].requestNodeId='B',s=>s.rounds[0].receipts[0].childJobId=null]){
  const copy=structuredClone(state);mutate(copy);await assert.rejects(executeNativeCascade({project:f.project,program,state:copy,...h}),/不一致|缺少原子任务/);
 }
 f.find('A').params.nativeCanvas.node.promptDraftText='运行中另改参数';
 await assert.rejects(executeNativeCascade({project:f.project,program,state,...h}),/不一致/);
 assert.equal(h.calls.length,originals);assert.equal(h.saved.length,writes);
});
test('收据先持久化才调用生成；存储失败时不能开始新提交',async()=>{
 const f=graph([['A','B']]),program=planNativeCascade(f.project,{nodeId:'B'});let called=0;
 await assert.rejects(executeNativeCascade({project:f.project,program,generate:async()=>{called++;return result('x');},persist:async()=>{throw Error('本机存储失败');}}),/本机存储失败/);assert.equal(called,0);
});
