import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {cascadeSpecializedFixture} from './helpers/native-cascade-specialized-fixture.mjs';
import {nativeCascadeChildAdapter} from '../lib/native-cascade-children.mjs';
import {atomicJson,readJson,records} from '../lib/workspace.mjs';
import path from 'node:path';

const batch={nodeId:'1',name:'text',values:['原条目一','原条目二','原条目三']};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
async function bounded(promise){const controller=new AbortController();try{return await Promise.race([promise,delay(8000,undefined,{signal:controller.signal}).then(()=>{throw Error('batch audit barrier not reached');})]);}finally{controller.abort();}}

// First let the real production parent/Comfy service persist one original
// upstream ID. Then drive the production child adapter with a frozen active
// child so the test, rather than a timing race with its writer, controls exactly
// when that local receipt changes. No mock transport or generator is called
// during the audit phase; the initial transport is isolated loopback only.
async function auditSession(t){
 const f=await cascadeSpecializedFixture(t,{batch}),{stopped,childId}=await f.stop();
 const child=await readJson(f.file(childId)),originalId=child.items[0].promptId;
 assert.ok(originalId);assert.equal(stopped.steps[0].childRequests.items[0].promptId,originalId);
 assert.equal(f.state.prompts.length,1);assert.equal(f.state.uploads.length,1);
 const projection=structuredClone(stopped),operation=projection.cascadeProgram.rounds[0].operations.find(op=>op.kind==='generate');
 const step=projection.steps.find(item=>item.executionId===operation.id),initialProgress=structuredClone(step.childRequests);
 projection.status='running';await atomicJson(f.file(projection.id),projection);
 await atomicJson(f.file(childId),{...child,status:'running'});
 const controller=new AbortController(),childController=new AbortController();
 f.activeJobs.set(projection.id,{controller,projectId:f.project.id,kind:'canvas-run'});
 f.activeJobs.set(childId,{controller:childController,projectId:f.project.id,parentId:projection.id,kind:'comfy'});
 const reported=deferred(),release=deferred(),reports=[],calls={prepare:0,start:0,resume:0,credential:0,accepted:0};
 const adapter=nativeCascadeChildAdapter({data:f.data,project:f.project,program:projection.cascadeProgram,parentId:projection.id,activeJobs:f.activeJobs,pollInterval:1,
  enhancementFor:op=>{assert.equal(op.id,operation.id);return step.actualInput;},
  batchProgressFor:op=>{assert.equal(op.id,operation.id);return step.childRequests;},
  prepare:async()=>{calls.prepare++;throw Error('audit must not prepare another request');},
  generation:{start:async()=>{calls.start++;throw Error('audit must not submit');},resume:async()=>{calls.resume++;throw Error('already-active child must not be resumed');}},
  credentialsFor:async()=>{calls.credential++;throw Error('audit must not request credentials');},
  onBatchProgress:async(op,value)=>{
   assert.equal(op.id,operation.id);reports.push(structuredClone(value));step.childRequests=structuredClone(value);
   await atomicJson(f.file(projection.id),projection);
   // Make a pre-fix overwrite fail promptly instead of waiting on an arbitrary
   // polling timeout. It still writes the invalid progress just as the parent
   // callback would, so the immutable original-receipt assertions can detect it.
   if(value.items.some(item=>item.promptId&&item.promptId!==originalId))throw Error('audit detected unvalidated upstream ID being reported');
   if(reports.length===1){reported.resolve();await release.promise;}
  }});
 const running=adapter.generate({operation,resume:true,childJobId:childId,signal:controller.signal,
  referenceRefs:projection.cascadeState.rounds[0].receipts[0].inputRefs,context:{roundIndex:0},
  onAccepted:async id=>{calls.accepted++;assert.equal(id,childId);}});
 // Attach rejection handling immediately; mutation is intentionally performed
 // while generate is suspended at the persisted-progress callback barrier.
 const outcome=running.then(value=>({value}),error=>({error}));
 async function mutate(){const latest=await readJson(f.file(childId));latest.items[0].promptId='tampered-original-upstream-id';await atomicJson(f.file(childId),latest);}
 async function cleanup(){release.resolve();controller.abort();await outcome;f.activeJobs.delete(childId);f.activeJobs.delete(projection.id);}
 async function verifyRejected(result,{cancelled=false}={}){
  assert.ok(result.error);assert.match(result.error.message,/已记录的上游编号已变化/);assert.equal(controller.signal.aborted,cancelled);
  assert.equal(reports.length,1,'conflicting child ID must be rejected before a second progress callback');
  assert.deepEqual(reports[0],initialProgress);assert.deepEqual(step.childRequests,initialProgress);
  const persisted=await readJson(f.file(projection.id));assert.deepEqual(persisted.steps.find(item=>item.executionId===operation.id).childRequests,initialProgress);
  assert.equal(persisted.steps[0].childRequests.items[0].promptId,originalId);
  assert.equal(persisted.cascadeState.completedOperationCount,0);assert.deepEqual(persisted.cascadeState.completedOrder,[]);assert.deepEqual(persisted.cascadeState.receivers,{});
  assert.deepEqual(calls,{prepare:0,start:0,resume:0,credential:0,accepted:1});
  assert.equal(f.state.prompts.length,1);assert.equal(f.state.uploads.length,1);assert.equal(f.state.images.length,0);assert.equal(f.state.rhCreates.length,0);assert.equal(f.state.studioCreates.length,0);
  assert.equal((await records(path.join(f.data,'jobs'))).length,2,'the original parent and child are the only jobs');
  assert.equal((await readJson(f.file(childId))).items[0].promptId,'tampered-original-upstream-id','the rejected child evidence must not be rewritten');
 }
 return {...f,projection,operation,step,controller,childController,reported,release,outcome,mutate,cleanup,verifyRejected};
}

test('running batch polling rejects a changed upstream ID before overwriting the saved parent progress',async t=>{
 const f=await auditSession(t);
 try{
  await bounded(f.reported.promise);await f.mutate();f.release.resolve();
  await f.verifyRejected(await bounded(f.outcome));
 }finally{await f.cleanup();}
});

test('cancelled batch finally rejects a changed upstream ID without reporting conflicting progress',async t=>{
 const f=await auditSession(t);
 try{
  await bounded(f.reported.promise);await f.mutate();f.controller.abort();f.release.resolve();
  await f.verifyRejected(await bounded(f.outcome),{cancelled:true});assert.equal(f.childController.signal.aborted,true);
 }finally{await f.cleanup();}
});
