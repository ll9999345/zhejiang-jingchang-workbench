import './helpers/local-network-only.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {legacyNativeConfirmFixture} from './helpers/legacy-native-confirm-fixture.mjs';
import {localServer} from './helpers/library-backup-server.mjs';
import {legacyNativeInputAudit,reviewedNativeInputStep} from '../lib/legacy-native-input-audit.mjs';
import {checkedNativeInputReviews} from '../lib/native-input-review-proof.mjs';
import {nativeInputReviewService} from '../lib/native-input-review-service.mjs';
import {nativeStepOutputs} from '../lib/native-flow-execution.mjs';
import {readJson,atomicJson} from '../lib/workspace.mjs';
import {taskHistoryArchiveService} from '../lib/task-history-archive.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {libraryFixture} from './helpers/library-backup-fixture.mjs';
import {reviewedNativeInputDisplaySteps} from '../public/legacy-native-input-audit-ui.js';
async function setup(t,name){const f=await legacyNativeConfirmFixture({stage:path.resolve('artifacts','legacy-native-confirm-'+name+'-'+Date.now())});t.after(()=>f.close());return f;}
const service=f=>nativeInputReviewService({data:f.data,activeJobs:new Map(),exclusive:async(id,fn)=>fn()});

test('明确确认追加记录而不改原选择；实际五图不被一次请求数缩为一图',async t=>{
 const f=await setup(t,'proof'),svc=service(f),before=await fs.readFile(f.file),preview=await svc.preview(f.job.id);
 assert.equal(preview.canConfirm,true);assert.equal(preview.wouldWrite,false);assert.equal(preview.generationSubmitted,false);assert.deepEqual(await fs.readFile(f.file),before);
 const row=preview.audit.entries[0];assert.deepEqual(row.authorizedIndices,[0,1]);assert.deepEqual(row.reconstructedIndices,[2,3]);assert(row.outputFingerprint);
 const confirmed=await svc.confirm(f.job.id,{fingerprint:preview.audit.fingerprint,consent:true}),saved=await readJson(f.file);
 assert.equal(confirmed.generationSubmitted,false);assert.equal(legacyNativeInputAudit(saved).state,'reviewed');assert.deepEqual(saved.steps,f.job.steps);assert.deepEqual(saved.snapshot,f.job.snapshot);assert.equal(saved.nativeInputReviews.length,1);
 const duplicate=await svc.confirm(f.job.id,{fingerprint:preview.audit.fingerprint,consent:true});assert.equal(duplicate.alreadyConfirmed,true);assert.deepEqual(await readJson(f.file),saved);
 const outputs=nativeStepOutputs(saved.snapshot,saved,f.consumer),copy=reviewedNativeInputStep(saved,f.consumer,saved.steps.indexOf(saved.steps.find(s=>s.kind==='image-api')),outputs);
 assert.deepEqual(copy.nativeReferences.details[0].producerIndices,[2,3]);assert.equal(f.consumer.nativeReferences.details[0].producerIndices,undefined);assert.equal(f.state.calls.length,0);
 const display=reviewedNativeInputDisplaySteps(saved.steps,legacyNativeInputAudit(saved));assert.deepEqual(display.find(s=>s.kind==='image-api').nativeReferences.details[0].producerIndices,[2,3]);assert.equal(saved.steps.find(s=>s.kind==='image-api').nativeReferences.details[0].producerIndices,undefined);
 // Normal output caches, text/progress and status bookkeeping are not new choices.
 saved.steps[0].childMessage='original results';saved.progress=55;saved.snapshot.nodes.find(n=>n.id===f.producer.id).assetId=f.owned.entries[4].asset.id;
 assert.equal(legacyNativeInputAudit(saved).state,'reviewed');
 for(const transform of [j=>{j.snapshot.nodes.find(n=>n.id===f.producer.id).params.workflowBinding.count=2;},j=>{j.assets.reverse();},j=>{const s=j.steps.find(s=>s.kind==='image-api');s.nativeLoop.contexts[f.loop.id].index=4;}]){const changed=structuredClone(saved);transform(changed);assert.equal(legacyNativeInputAudit(changed).blocksResume,true);}
});

test('确认尚未完成的上游原序号后等待实际输出；缺项仍停止而不改选第一张',async t=>{
 const f=await setup(t,'pending'),pending=structuredClone(f.job);pending.assets=[];pending.steps[0].status='pending';delete pending.steps[0].jobId;pending.snapshot.nodes.find(n=>n.id===f.producer.id).params.workflowBinding.count=5;await atomicJson(f.file,pending);
 const svc=service(f),preview=await svc.preview(pending.id);assert.equal(preview.canConfirm,true);assert.equal(preview.audit.entries[0].outputFingerprint,null);const result=await svc.confirm(pending.id,{fingerprint:preview.audit.fingerprint,consent:true});
 const ready=structuredClone(result.job);ready.steps[0].status='completed';ready.assets=f.job.assets;assert.equal(legacyNativeInputAudit(ready).state,'reviewed');const outputs=nativeStepOutputs(ready.snapshot,ready,ready.steps.find(s=>s.kind==='image-api'));assert.deepEqual(reviewedNativeInputStep(ready,ready.steps[1],1,outputs).nativeReferences.details[0].producerIndices,[2,3]);
 ready.assets=f.job.assets.slice(0,2);assert.equal(legacyNativeInputAudit(ready).blocksResume,true);assert.throws(()=>reviewedNativeInputStep(ready,ready.steps[1],1,outputs));assert.equal(f.state.calls.length,0);
});

test('真实HTTP并发确认只追加一次，与任务列表刷新共存，旧页面会话不能确认',async t=>{
 const f=await setup(t,'concurrency'),server=await localServer(f.data,{envOverrides:{JINGCHANG_SMART_GROUP_MEDIA_TEST:'1'}});t.after(()=>server.stop());const url='/api/jobs/'+f.job.id,preview=await server.api(url+'/native-input-review/preview','POST',{}),body={fingerprint:preview.audit.fingerprint,consent:true},before=await fs.readFile(f.file);
 const old=await fetch(server.base+url+'/native-input-review/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(old.status,409);assert.deepEqual(await fs.readFile(f.file),before);
 const [a,b]=await Promise.all([server.api(url+'/native-input-review/confirm','POST',body),server.api(url+'/native-input-review/confirm','POST',body),server.api(url),server.api('/api/jobs?projectId='+f.p.id)]);assert.equal([a,b].filter(row=>row.alreadyConfirmed).length,1);const saved=await readJson(f.file);assert.equal(saved.nativeInputReviews.length,1);assert.deepEqual(saved.snapshot,f.job.snapshot);assert.equal(f.state.calls.length,0);
});

test('过期范围、任意新序号、只读导入和未停止项目不能确认，不写文件不提交',async t=>{
 const f=await setup(t,'stale'),svc=service(f),preview=await svc.preview(f.job.id);const changed=structuredClone(f.job);changed.assets.reverse();await atomicJson(f.file,changed);const before=await fs.readFile(f.file);
 await assert.rejects(svc.confirm(f.job.id,{fingerprint:preview.audit.fingerprint,consent:true}),e=>e.code==='NATIVE_INPUT_REVIEW_STALE');
 await assert.rejects(svc.confirm(f.job.id,{fingerprint:preview.audit.fingerprint,consent:true,indices:[0,1]}));await assert.rejects(svc.preview(f.job.id,{indices:[0]}));assert.deepEqual(await fs.readFile(f.file),before);
 changed.readOnly=true;await atomicJson(f.file,changed);await assert.rejects(svc.preview(f.job.id),/仅能核对/);delete changed.readOnly;await atomicJson(f.file,changed);
 const busy=nativeInputReviewService({data:f.data,activeJobs:new Map([['busy',{projectId:f.p.id}]]),exclusive:async(id,fn)=>fn()});await assert.rejects(busy.preview(f.job.id),/仍有任务/);assert.equal(f.state.calls.length,0);
});

test('真实HTTP确认后同任务续跑只发送第三第四张原PNG，上游零重发并可归档',async t=>{
 const f=await setup(t,'execution'),server=await localServer(f.data,{envOverrides:{JINGCHANG_SMART_GROUP_MEDIA_TEST:'1'}});t.after(()=>server.stop());const url='/api/jobs/'+f.job.id,projectFile=path.join(f.data,'projects',f.p.id,'project.json'),projectBefore=await fs.readFile(projectFile);
 const preview=await server.api(url+'/native-input-review/preview','POST',{});assert.equal(preview.canConfirm,true);
 const confirmed=await server.api(url+'/native-input-review/confirm','POST',{fingerprint:preview.audit.fingerprint,consent:true});assert.equal(confirmed.generationSubmitted,false);assert.equal(confirmed.job.legacyNativeInputAudit.state,'reviewed');assert.equal(f.state.calls.length,0);
 const noKeys=await fetch(server.base+url+'/resume',{method:'POST',headers:{...server.headers,'Content-Type':'application/json'},body:JSON.stringify({consent:true})});assert.equal(noKeys.status,400);assert.equal(f.state.calls.length,0);
 const resumed=await server.api(url+'/resume','POST',f.credentials());assert.equal(resumed.id,f.job.id);const result=await f.wait();assert.equal(result.status,'completed',result.message);
 assert.equal(f.state.calls.length,1);assert.equal(f.state.calls[0].url,'/v1/images/edits');assert.deepEqual(f.state.calls[0].images,[f.owned.entries[2].bytes,f.owned.entries[3].bytes]);assert.deepEqual(result.snapshot,f.job.snapshot);
 const target=result.steps.find(s=>s.kind==='image-api');assert.equal(target.nativeReferences.details[0].producerIndices,undefined);assert.equal(target.nativeInputReviewApplied[0].reviewId,result.nativeInputReviews[0].id);assert.deepEqual(result.steps[0],f.job.steps[0]);
 const child=await readJson(path.join(f.data,'jobs',target.jobId+'.json'));assert.deepEqual(child.input.referenceIds,[f.owned.entries[2].asset.id,f.owned.entries[3].asset.id]);assert.deepEqual(await fs.readFile(projectFile),projectBefore);
 // Parent lost its completed child ID: query deterministic original child,
 // retain confirmation, and never send the consumer request a second time.
 const lost=structuredClone(result);lost.status='interrupted';target.status='interrupted';const index=lost.steps.findIndex(s=>s.kind==='image-api');lost.steps[index].status='interrupted';delete lost.steps[index].jobId;lost.assets=lost.assets.filter(a=>a.sourceNodeId!==f.consumer.nodeId);await atomicJson(f.file,lost);await server.api(url+'/resume','POST',f.credentials());const recovered=await f.wait();assert.equal(recovered.status,'completed',recovered.message);assert.equal(f.state.calls.length,1);assert.deepEqual(recovered.assets.map(a=>a.id),result.assets.map(a=>a.id));
 const activeJobs=new Map(),projects={load:async()=>f.p,save:async p=>p},bundles=projectBundleService({data:f.data,activeJobs,projects}),source=taskHistoryArchiveService({data:f.data,activeJobs,projects,projectBundles:bundles}),archive=await source.exportArchive(f.p.id,f.p.revision,{requestId:randomUUID()});assert.equal(archive.complete,true,JSON.stringify(archive.unsupported));
 const dst=await libraryFixture({dir:path.join(f.stage,'archive-target')}),history=taskHistoryArchiveService({...dst,projectBundles:dst.bundles}),checked=await history.upload(createReadStream(await source.download(archive.id))),record=await history.importArchive(checked.id,{previewDigest:checked.previewDigest}),restored=record.manifest.jobs.find(j=>j.id===f.job.id);assert.equal(record.readOnly,true);assert.deepEqual(restored.nativeInputReviews,recovered.nativeInputReviews);assert.deepEqual(restored.steps[index].nativeInputReviewApplied,recovered.steps[index].nativeInputReviewApplied);
 for(const file of await fs.readdir(path.join(f.data,'jobs')))assert.equal((await fs.readFile(path.join(f.data,'jobs',file),'utf8')).includes('synthetic-local-only'),false);
 await fs.writeFile(path.join(f.stage,'receipt.json'),JSON.stringify({status:'passed',scope:'Owned real loopback HTTP and PNG bytes, not model inference',parentId:f.job.id,confirmedWithoutGeneration:true,oldZeroBasedIndices:[0,1],approvedZeroBasedIndices:[2,3],actualProducerOutputs:5,originalProducerRequestCount:1,consumerRequests:1,upstreamResubmissions:0,recoveredOriginalChildWithoutResubmit:true,originalSelectionPreserved:true,projectUnchanged:true,readOnlyArchivePreservesDecision:true,paidCalls:0,thirdPartyUploads:0},null,2));
});

test('确认凭据严格校验未知字段、指纹和跨任务复用',async t=>{
 const f=await setup(t,'validation'),svc=service(f),preview=await svc.preview(f.job.id);const confirmed=await svc.confirm(f.job.id,{fingerprint:preview.audit.fingerprint,consent:true}),record=confirmed.job.nativeInputReviews[0];assert.deepEqual(checkedNativeInputReviews([record]),[record]);
 const extra=structuredClone(record);extra.selections[0].anything='unexpected';assert.throws(()=>checkedNativeInputReviews([extra]));const edited=structuredClone(record);edited.selections[0].indices=[0];assert.throws(()=>checkedNativeInputReviews([edited]));
 const other=structuredClone(confirmed.job);other.id=randomUUID();assert.equal(legacyNativeInputAudit(other).blocksResume,true);
});
