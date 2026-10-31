import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {cascadeProtocolFixture} from './helpers/native-cascade-protocol-fixture.mjs';
import {executeNativeCascade,validateNativeCascadeState} from '../lib/native-cascade-execution.mjs';
import {cascadeChildRequestId} from '../lib/native-cascade-children.mjs';
import {readJson,atomicJson} from '../lib/workspace.mjs';
import {generationService} from '../lib/generation.mjs';

test('实际Comfy服务收到A→B→C两次提交及正确发送方文字，结果归接收方',async t=>{
 const f=await cascadeProtocolFixture(t),adapter=f.adapter(),before=structuredClone(f.project);
 const state=await executeNativeCascade({project:f.project,program:f.program,generate:adapter.generate,persist:f.persist});await f.waitChildren();
 assert.equal(state.status,'completed',state.error);assert.equal(f.state.prompts.length,2);assert.equal(f.state.uploads.length,2);
 assert.deepEqual(f.state.prompts.map(record=>record.body.prompt['1'].inputs.text),['发送参数 A；参数属于 A','发送参数 B；参数属于 B']);
 const children=await Promise.all(state.rounds[0].receipts.map(receipt=>readJson(path.join(f.data,'jobs',receipt.childJobId+'.json'))));
 assert.deepEqual(children.map(child=>child.target.id),['A','B']);assert.equal(state.receivers.B.currentRefs[0].assetId,children[0].assets[0].id);assert.equal(state.receivers.C.currentRefs[0].assetId,children[1].assets[0].id);
 assert.deepEqual(f.project,before);validateNativeCascadeState(f.project,f.program,await f.readState());
});
test('实际同级共享不额外提交，子链仍按各自参数请求且原字节已保存',async t=>{
 const f=await cascadeProtocolFixture(t,{pairs:[['A','B'],['A','C'],['B','D'],['C','E']]}),adapter=f.adapter();
 const state=await executeNativeCascade({project:f.project,program:f.program,generate:adapter.generate,persist:f.persist});await f.waitChildren();
 assert.equal(state.status,'completed',state.error);assert.equal(f.state.prompts.length,3);assert.equal(f.state.uploads.length,3);
 assert.deepEqual(f.state.prompts.map(record=>record.body.prompt['1'].inputs.text),['发送参数 A；参数属于 A','发送参数 B；参数属于 B','发送参数 C；参数属于 C']);
 assert.equal(state.receivers.B.currentRefs[0].assetId,state.receivers.C.currentRefs[0].assetId);
 const a=await readJson(path.join(f.data,'assets',state.receivers.B.currentRefs[0].assetId+'.json'));assert.equal(a.type,'image/png');assert.ok(a.size>0);
});
test('Comfy→RunningHub使用原生成模块，任务ID和返回素材都归同一父串联',async t=>{
 const f=await cascadeProtocolFixture(t,{kinds:{B:'runninghub'}}),adapter=f.adapter();
 const state=await executeNativeCascade({project:f.project,program:f.program,generate:adapter.generate,persist:f.persist});await f.waitChildren();
 assert.equal(state.status,'completed',state.error);assert.equal(f.state.prompts.length,1);assert.equal(f.state.rhCreates.length,1);assert.equal(f.state.uploads.length,2);
 assert.equal(f.state.rhCreates[0].body.nodeInfoList.find(field=>field.fieldName==='text').fieldValue,'发送参数 B；参数属于 B');
 const receipt=state.rounds[0].receipts[1],child=await readJson(path.join(f.data,'jobs',receipt.childJobId+'.json'));assert.equal(child.parentJobId,f.parentId);assert.equal(child.upstreamId,f.state.rhCreates[0].id);
 assert.equal(state.receivers.C.currentRefs[0].assetId,child.assets[0].id);assert.ok(!JSON.stringify(state).includes('synthetic-only-cascade'));
});
test('图片API实际编辑请求一次，结果共享给同级，密钥不进入串联收据',async t=>{
 const f=await cascadeProtocolFixture(t,{pairs:[['A','B'],['A','C']],kinds:{A:'image-api'}}),adapter=f.adapter();
 const state=await executeNativeCascade({project:f.project,program:f.program,generate:adapter.generate,persist:f.persist});await f.waitChildren();
 assert.equal(state.status,'completed',state.error);assert.equal(f.state.images.length,1);assert.equal(f.state.prompts.length,0);
 assert.equal(f.state.images[0].prompt,'发送参数 A；参数属于 A');assert.equal(f.state.images[0].images.length,1);
 assert.equal(f.state.images[0].images[0].type,'image/png');assert.ok(f.state.images[0].images[0].bytes.length>0);
 assert.equal(state.receivers.B.currentRefs[0].assetId,state.receivers.C.currentRefs[0].assetId);assert.ok(!JSON.stringify(await f.readState()).includes('synthetic-only-cascade'));
});
test('Comfy→方舟视频模拟服务保持发送方参数及返回的视频类型',async t=>{
 const f=await cascadeProtocolFixture(t,{kinds:{B:'studio'}}),adapter=f.adapter();
 const state=await executeNativeCascade({project:f.project,program:f.program,generate:adapter.generate,persist:f.persist});await f.waitChildren();
 assert.equal(state.status,'completed',state.error);assert.equal(f.state.prompts.length,1);assert.equal(f.state.studioCreates.length,1);
 assert.equal(f.state.studioCreates[0].body.content.find(item=>item.type==='text').text,'发送参数 B；参数属于 B');
 assert.equal(state.receivers.C.currentRefs[0].kind,'video');assert.equal(state.receivers.B.currentRefs[0].kind,'image');
});
test('已提交的实际Comfy任务停止后重建服务查询原编号，首提交不会重发',async t=>{
 const f=await cascadeProtocolFixture(t),adapter=f.adapter(),controller=new AbortController();f.state.hold=true;
 const running=executeNativeCascade({project:f.project,program:f.program,generate:adapter.generate,persist:f.persist,signal:controller.signal});
 await f.waitPrompt();controller.abort();const stopped=await running;await f.waitChildren();assert.equal(stopped.status,'stopped');assert.equal(f.state.prompts.length,1);
 const firstChild=stopped.rounds[0].receipts[0].childJobId;assert.ok(firstChild);f.state.hold=false;
 const replacement=generationService({data:f.data,activeJobs:f.activeJobs}),again=f.adapter({generation:replacement}),restored=await again.reconcile(await f.readState());
 const completed=await executeNativeCascade({project:f.project,program:f.program,state:restored.state,generate:again.generate,persist:f.persist});await f.waitChildren();
 assert.equal(completed.status,'completed',completed.error);assert.equal(completed.rounds[0].receipts[0].childJobId,firstChild);assert.equal(f.state.prompts.length,2);
 const child=await readJson(path.join(f.data,'jobs',firstChild+'.json'));assert.equal(child.items[0].promptId,f.state.prompts[0].id);
});
test('父收据丢失接受编号时，按稳定请求ID只读找回已存子任务，不重交请求',async t=>{
 const f=await cascadeProtocolFixture(t),adapter=f.adapter(),controller=new AbortController();f.state.hold=true;
 const running=executeNativeCascade({project:f.project,program:f.program,generate:adapter.generate,persist:f.persist,signal:controller.signal});await f.waitPrompt();controller.abort();const stopped=await running;await f.waitChildren();
 const originalId=stopped.rounds[0].receipts[0].childJobId,lost=structuredClone(stopped);lost.rounds[0].receipts[0].childJobId=null;
 const again=f.adapter(),restored=await again.reconcile(lost);assert.equal(restored.adopted,1);assert.equal(restored.state.rounds[0].receipts[0].childJobId,originalId);assert.equal(lost.rounds[0].receipts[0].childJobId,null);
 f.state.hold=false;const completed=await executeNativeCascade({project:f.project,program:f.program,state:restored.state,generate:again.generate,persist:f.persist});await f.waitChildren();
 assert.equal(completed.status,'completed',completed.error);assert.equal(f.state.prompts.length,2);
});
test('已完成收据必须匹配实际子任务结果，篡改不能继续或覆盖已存记录',async t=>{
 const f=await cascadeProtocolFixture(t),adapter=f.adapter(),state=await executeNativeCascade({project:f.project,program:f.program,generate:adapter.generate,persist:f.persist});await f.waitChildren();
 const childId=state.rounds[0].receipts[0].childJobId,file=path.join(f.data,'jobs',childId+'.json'),child=await readJson(file);child.assets[0].id='forged-result';await atomicJson(file,child);
 const before=await f.readState();await assert.rejects(adapter.reconcile(state),/实际结果不一致/);assert.equal(f.state.prompts.length,2);assert.deepEqual(await f.readState(),before);
});
test('原子任务属于其他父任务时拒绝采用；稳定请求ID不受长编号限制',async t=>{
 const f=await cascadeProtocolFixture(t),adapter=f.adapter(),state=await executeNativeCascade({project:f.project,program:f.program,generate:adapter.generate,persist:f.persist});await f.waitChildren();
 const childId=state.rounds[0].receipts[0].childJobId,file=path.join(f.data,'jobs',childId+'.json'),child=await readJson(file);child.parentId='another-parent';await atomicJson(file,child);
 await assert.rejects(adapter.reconcile(state),/不属于原发送方/);const id=cascadeChildRequestId('a'.repeat(100),'b'.repeat(100));assert.ok(id.length<=100);assert.match(id,/^[a-z0-9-]+$/);
});
test('本机子任务失去上游编号时停止恢复，已收到的请求不重新提交',async t=>{
 const f=await cascadeProtocolFixture(t),adapter=f.adapter(),controller=new AbortController();f.state.hold=true;
 const running=executeNativeCascade({project:f.project,program:f.program,generate:adapter.generate,persist:f.persist,signal:controller.signal});
 await f.waitPrompt();controller.abort();const stopped=await running;await f.waitChildren();
 const childId=stopped.rounds[0].receipts[0].childJobId,file=path.join(f.data,'jobs',childId+'.json'),child=await readJson(file);
 for(const item of child.items)delete item.promptId;
 await atomicJson(file,child);const again=f.adapter(),restored=await again.reconcile(stopped);
 const result=await executeNativeCascade({project:f.project,program:f.program,state:restored.state,generate:again.generate,persist:f.persist});
 assert.equal(result.status,'failed');assert.match(result.error,/不会重新提交未确认项/);assert.equal(f.state.prompts.length,1);
});
