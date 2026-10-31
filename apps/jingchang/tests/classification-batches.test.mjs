import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {storeAsset,loadAsset,atomicJson,readJson} from '../lib/workspace.mjs';
import {makeProject} from '../lib/model.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {taskHistoryArchiveService,TASK_HISTORY_MAGIC} from '../lib/task-history-archive.mjs';
import {assetClassificationService} from '../lib/asset-classification.mjs';
import {assetClassificationReceiptStore} from '../lib/asset-classification-receipts.mjs';
import {classificationBatchService,classificationBatchStore,classificationBatchHistory} from '../lib/classification-batches.mjs';
import './helpers/local-network-only.mjs';
const png=Buffer.from('89504e470d0a1a0a01020304','hex'),secret='sk-test-batch-never-persisted';
const answer=()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({summary:'本机分类',categories:{scene:['湖岸']},tags:['文旅']})}}]});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function fixture({call}={}){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-batch-'));await fs.mkdir(path.join(data,'assets'));
 const assets=[];for(let i=0;i<3;i++)assets.push(await storeAsset(data,png,{name:'图片'+i+'.png',type:'image/png'}));
 const unsupported=await storeAsset(data,Buffer.from('RIFFtest'),{name:'声音.wav',type:'audio/wav'});
 let platform={id:'local-vision',baseUrl:'http://127.0.0.1:18888/v1',protocol:'openai-compatible',models:[{id:'vision',category:'chat',referenceSupport:true}]},calls=0;
 const platforms={get:async id=>{assert.equal(id,platform.id);return structuredClone(platform);}},sharedFolders={get:async(id,project)=>{assert.equal(id,'source-import');if(project!=='project-one')throw Object.assign(new Error('wrong project'),{status:403});return{id,status:'completed',items:[...assets,unsupported].map(asset=>({status:'completed',asset}))};}};
 const classifier=assetClassificationService({data,platforms,apiCall:async options=>{calls++;return call?call(options,calls):answer();}}),batch=classificationBatchService({data,platforms,sharedFolders,classifier});
 async function body(requestId='batch-one'){const plan=await batch.preview({projectId:'project-one',sourceImportId:'source-import',assetIds:assets.map(a=>a.id)});return{...plan,assetIds:assets.map(a=>a.id),requestId,platformId:platform.id,model:'vision',apiKey:secret,prompt:'',consent:true,authorization:{origin:'http://127.0.0.1:18888',model:'vision',sendImage:true,requestLimit:3,budget:0,currency:'CNY',consent:true}};}
 return{data,assets,unsupported,classifier,batch,platforms,sharedFolders,body,get calls(){return calls;},changePlatform:p=>{platform={...platform,...p};}};
}
async function settle(f,id='batch-one'){for(let i=0;i<500;i++){const r=await f.batch.get(id,'project-one');if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,4));}throw Error('batch timeout');}
async function secretFree(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await secretFree(p);else assert.ok(!(await fs.readFile(p)).includes(Buffer.from(secret)),p);}}

test('preview is local-only, skips unsupported media, and requires exact completed import scope',async()=>{
 const f=await fixture(),p=await f.batch.preview({projectId:'project-one',sourceImportId:'source-import'});assert.equal(p.items.length,3);assert.equal(p.skipped.length,1);assert.equal(f.calls,0);
 await assert.rejects(f.batch.preview({projectId:'project-one',sourceImportId:'source-import',assetIds:[f.assets[0].id,f.assets[0].id]}));await assert.rejects(f.batch.preview({projectId:'project-one',sourceImportId:'source-import',assetIds:['unrelated']}));assert.equal(f.calls,0);
});
test('one immutable batch sends each selected image once, backfills metadata, and replay/reopen never sends',async()=>{
 const f=await fixture(),b=await f.body();await f.batch.start(b);assert.equal(b.apiKey,'');const r=await settle(f);assert.equal(r.status,'completed');assert.equal(r.counts.completed,3);assert.equal(f.calls,3);for(const a of f.assets)assert.equal((await loadAsset(f.data,a.id)).classification.summary,'本机分类');
 const replay=await f.batch.start(await f.body());assert.equal(replay.status,'completed');assert.equal(f.calls,3);
 const reopened=classificationBatchService({data:f.data,platforms:f.platforms,sharedFolders:f.sharedFolders,classifier:f.classifier});assert.equal((await reopened.list({projectId:'project-one'})).length,1);assert.equal((await reopened.get(r.id,'project-one')).counts.completed,3);assert.equal(f.calls,3);await secretFree(f.data);
});
test('same ID changed authorization, selection or media is rejected before another call',async()=>{
 const f=await fixture();await f.batch.start(await f.body());await settle(f);
 for(const change of [b=>b.authorization.budget=3,b=>b.consent=false,b=>b.prompt='变更要求',b=>b.assetIds.pop()]){const b=await f.body();change(b);await assert.rejects(f.batch.start(b));assert.equal(f.calls,3);}
 await fs.writeFile(path.join(f.data,'assets',f.assets[0].id),Buffer.from('89504e470d0a1a0a09080706','hex'));await assert.rejects(f.batch.start(await f.body()));assert.equal(f.calls,3);
});
test('all images/config are checked again before subsequent calls; changed service stops the remainder',async()=>{
 let f;f=await fixture({call:async()=>{f.changePlatform({baseUrl:'http://127.0.0.1:18888/other'});return answer();}});await f.batch.start(await f.body());const r=await settle(f);assert.equal(f.calls,1);assert.equal(r.counts.completed,1);assert.equal(r.counts.unsent,2);assert.equal(r.status,'interrupted');
});
test('a future image changed after confirmation is not sent; successful earlier classification remains',async()=>{
 let f;f=await fixture({call:async()=>{await fs.writeFile(path.join(f.data,'assets',f.assets[1].id),Buffer.from('89504e470d0a1a0a09080706','hex'));return answer();}});await f.batch.start(await f.body());const r=await settle(f);assert.equal(f.calls,1);assert.equal(r.counts.completed,1);assert.equal(r.counts.unsent,2);assert.equal((await loadAsset(f.data,f.assets[0].id)).classification.summary,'本机分类');
});
test('completed receipt can repair a lost local backfill without inference and rejects changed original bytes',async()=>{
 const f=await fixture();await f.batch.start(await f.body());await settle(f);const a=await loadAsset(f.data,f.assets[0].id);delete a.classification;await atomicJson(path.join(f.data,'assets',a.id+'.json'),a);assert.equal((await f.batch.apply('batch-one','project-one')).applied,3);assert.equal(f.calls,3);assert.ok((await loadAsset(f.data,a.id)).classification);
 await fs.writeFile(path.join(f.data,'assets',a.id),Buffer.from('89504e470d0a1a0a09080706','hex'));await assert.rejects(f.batch.apply('batch-one','project-one'),e=>e.status===409);assert.equal(f.calls,3);
});
test('unknown outcome stops later images and cannot be resumed or replayed as another attempt',async()=>{
 const f=await fixture({call:async()=>{throw Error(secret);}});await f.batch.start(await f.body());const r=await settle(f);assert.equal(f.calls,1);assert.equal(r.status,'uncertain');assert.equal(r.canResume,false);assert.equal(r.counts.unsent,2);await assert.rejects(f.batch.resume(r.id,{...await f.body(),resumeUnsent:true}));await f.batch.start(await f.body());assert.equal(f.calls,1);await secretFree(f.data);
});
test('explicit failure stops later images; explicit resume sends only unsent originals within original total budget',async()=>{
 const f=await fixture({call:async(_o,n)=>{if(n===1)throw Object.assign(Error(secret),{upstreamStatus:400});return answer();}}),b=await f.body();b.authorization.budget=3;
 await f.batch.start(b);let r=await settle(f);assert.equal(r.status,'failed');assert.equal(f.calls,1);assert.equal(r.counts.unsent,2);assert.equal(r.canResume,true);
 const changed=await f.body();changed.authorization.budget=6;await assert.rejects(f.batch.resume(r.id,{...changed,resumeUnsent:true}));assert.equal(f.calls,1);
 const resume=await f.body();resume.authorization.budget=3;await f.batch.resume(r.id,{...resume,resumeUnsent:true});r=await settle(f);assert.equal(r.counts.completed,2);assert.equal(r.counts.failed,1);assert.equal(r.counts.unsent,0);assert.equal(f.calls,3);assert.equal(r.runs.length,2);for(const child of await f.classifier.list({projectId:'project-one'}))assert.equal(child.authorization.budget,1);await secretFree(f.data);
});
test('stop during send persists uncertainty, retains earlier results, and never dispatches later images',async()=>{
 const entered=deferred(),release=deferred(),f=await fixture({call:async()=>{entered.resolve();await release.promise;return answer();}});await f.batch.start(await f.body());await entered.promise;
 await f.batch.cancel('batch-one','project-one');release.resolve();const r=await settle(f);assert.equal(r.status,'uncertain');assert.equal(r.counts.unsent,2);assert.equal(f.calls,1);assert.equal(r.items[0].task.result,undefined);assert.ok(r.runs[0].stoppedAt);await secretFree(f.data);
});
test('parallel service instances and double-clicks cannot claim a second execution',async()=>{
 const f=await fixture(),second=classificationBatchService({data:f.data,platforms:f.platforms,sharedFolders:f.sharedFolders,classifier:f.classifier});await Promise.allSettled([f.batch.start(await f.body()),second.start(await f.body()),f.batch.start(await f.body())]);const r=await settle(f);assert.equal(r.status,'completed');assert.equal(f.calls,3);assert.equal(r.runs.length,1);
});
test('dead-owner run is query-only after recovery, and explicit resume only sends truly unsent items',async()=>{
 const f=await fixture(),b=await f.body();await f.batch.start(b);const r=await settle(f),dir=await f.batch.store.directory();
 // Create a separate interrupted fixture manifest with fresh child IDs and a
 // real missing PID. No receipt exists, so querying cannot authorize a send.
 const original=await f.batch.store.read(r.id),m={...original,id:'interrupted-batch',items:original.items.map(i=>({...i,requestId:'placeholder'}))};
 const {createHash}=await import('node:crypto');m.items=m.items.map(i=>({...i,requestId:'bc-'+createHash('sha256').update(m.id+':'+i.assetId).digest('hex').slice(0,48)}));
 await f.batch.store.publish(m.id+'.json',m);await f.batch.store.publish(m.id+'.run-1.json',{batchId:m.id,number:1,pid:2147483646,createdAt:m.createdAt});
 const before=f.calls,row=await f.batch.get(m.id,'project-one');assert.equal(row.status,'interrupted');assert.equal(row.canResume,true);assert.equal(f.calls,before);await f.batch.resume(m.id,{...await f.body(m.id),resumeUnsent:true});assert.equal((await settle(f,m.id)).status,'completed');assert.equal(f.calls,before+3);assert.ok(dir);
});
test('portable batch history is strict, strips live ownership, and does not grant resume',async()=>{
 const f=await fixture();await f.batch.start(await f.body());await settle(f);const h=await f.batch.history('batch-one','project-one');assert.equal(h.status,'completed');assert.equal(h.manifest.authorization.requestLimit,3);assert.equal(JSON.stringify(h).includes('pid'),false);assert.equal(JSON.stringify(h).includes('apiKey'),false);assert.deepEqual(classificationBatchHistory(h),h);
 for(const bad of [v=>v.resume=true,v=>v.manifest.authorization.requestLimit=4,v=>v.items[0].requestId='forged',v=>v.runs[0].pid=1]){const v=structuredClone(h);bad(v);assert.throws(()=>classificationBatchHistory(v));}await assert.rejects(f.batch.get('batch-one','other-project'));await secretFree(f.data);
});
test('tampered manifests, symlink records and colliding child identities fail closed',async()=>{
 const f=await fixture();await f.batch.start(await f.body());await settle(f);const dir=await f.batch.store.directory(),m=await f.batch.store.read('batch-one');
 await fs.symlink(path.join(dir,'batch-one.json'),path.join(dir,'linked-batch.json'));await assert.rejects(f.batch.store.read('linked-batch'));
 const child=assetClassificationReceiptStore(f.data),r=await child.read(m.items[0].requestId);r.media.sha256='0'.repeat(64);await fs.writeFile(path.join(f.data,'asset-classification-tasks',r.id+'.terminal'),JSON.stringify(r));await assert.rejects(f.batch.get(m.id,'project-one'));
});

async function archiveFixture(f){
 const p=makeProject('批量分类归档');p.id='project-one';p.assets=f.assets;p.nodes=[];
 const projects={load:id=>readJson(path.join(f.data,'projects',id,'project.json')),save:async project=>{await atomicJson(path.join(f.data,'projects',project.id,'project.json'),project);return project;}};
 await projects.save(p);const now=new Date().toISOString();
 await atomicJson(path.join(f.data,'jobs','source-import.json'),{id:'source-import',requestId:'source-import',kind:'folder-import',projectId:p.id,folderId:'folder-one',name:'共享文件夹导入',category:'',status:'completed',message:'本机复制已完成',signature:'a'.repeat(64),items:f.assets.map((a,i)=>({relativePath:i+'.png',name:a.name,type:a.type,size:a.size,status:'completed',bytesReceived:a.size,attempt:1,streamRequestId:'local-import-'+i,asset:a})),snapshot:{paths:f.assets.map((_,i)=>({path:i+'.png',fingerprint:'b'.repeat(64)}))},createdAt:now,updatedAt:now,applied:false});
 const activeJobs=new Map(),bundles=projectBundleService({data:f.data,projects,activeJobs});return{p,service:taskHistoryArchiveService({data:f.data,projects,activeJobs,projectBundles:bundles})};
}
test('real export/inspect/import retains batch scope and child results in a read-only archive, no live batches or grants',async()=>{
 const f=await fixture();await f.batch.start(await f.body());await settle(f);const a=await archiveFixture(f),out=await a.service.exportArchive(a.p.id,a.p.revision);assert.equal(out.complete,true,JSON.stringify(out.unsupported));assert.equal(out.classificationBatches,1);assert.equal(out.classifications,3);
 const target=await fixture(),t=await archiveFixture(target),preview=await t.service.upload(createReadStream(await a.service.download(out.id)));assert.equal(preview.complete,true);const imported=await t.service.importArchive(preview.id),record=await t.service.readArchive(imported.id,{projectId:imported.projectId});assert.equal(record.classificationBatches,1);assert.equal(record.manifest.auxiliaryReceipts.filter(r=>r.source==='classification-batches').length,1);assert.equal(record.readOnly,true);
 assert.equal((await target.batch.list({projectId:'project-one'})).length,0);assert.equal((await target.classifier.list()).length,0);assert.equal(target.calls,0);await secretFree(f.data);await secretFree(target.data);
});
test('active batch blocks archive; an unsent stopped batch retains its selected original image scope',async()=>{
 const entered=deferred(),release=deferred(),f=await fixture({call:async()=>{entered.resolve();await release.promise;return answer();}});const a=await archiveFixture(f);await f.batch.start(await f.body());await entered.promise;await assert.rejects(a.service.exportArchive(a.p.id,a.p.revision),e=>e.status===409);await f.batch.cancel('batch-one','project-one');release.resolve();const row=await settle(f);assert.equal(row.counts.unsent,2);const out=await a.service.exportArchive(a.p.id,a.p.revision);assert.equal(out.complete,true,JSON.stringify(out.unsupported));assert.equal(out.classificationBatches,1);assert.equal(out.classifications,1);
});
test('recomputed archive headers cannot forge batch scope, total budget, terminal state or omit original child receipts',async()=>{
 const f=await fixture();await f.batch.start(await f.body());await settle(f);const a=await archiveFixture(f),out=await a.service.exportArchive(a.p.id,a.p.revision),file=await a.service.download(out.id),raw=await fs.readFile(file),offset=TASK_HISTORY_MAGIC.length+4,length=raw.readUInt32BE(TASK_HISTORY_MAGIC.length),original=JSON.parse(raw.subarray(offset,offset+length));
 for(const change of [m=>m.auxiliaryReceipts.find(r=>r.source==='classification-batches').record.manifest.planDigest='0'.repeat(64),m=>m.auxiliaryReceipts.find(r=>r.source==='classification-batches').record.manifest.authorization.budget=9,m=>m.auxiliaryReceipts.find(r=>r.source==='classification-batches').record.status='failed',m=>m.auxiliaryReceipts.splice(m.auxiliaryReceipts.findIndex(r=>r.source==='asset-classification-tasks'),1)]){
  const m=structuredClone(original);change(m);const json=Buffer.from(JSON.stringify(m)),size=Buffer.alloc(4);size.writeUInt32BE(json.length);const forged=Buffer.concat([TASK_HISTORY_MAGIC,size,json,createHash('sha256').update(json).digest(),raw.subarray(offset+length+32)]);await assert.rejects(a.service.upload(Readable.from([forged])));
 }
 assert.equal(f.calls,3);
});

test('two actual processes racing a batch publish and later reopening send each child at most once',{timeout:30000},async t=>{
 const f=await fixture();let sends=0;const upstream=http.createServer(async(req,res)=>{sends++;for await(const _ of req){}await new Promise(r=>setTimeout(r,20));res.setHeader('content-type','application/json');res.end(JSON.stringify(answer()));});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const origin='http://127.0.0.1:'+upstream.address().port;
 t.after(async()=>{upstream.closeAllConnections();await new Promise(r=>upstream.close(r));});
 f.changePlatform({baseUrl:origin+'/v1'});const config=path.join(f.data,'process-fixture.json'),platform=await f.platforms.get('local-vision');await fs.writeFile(config,JSON.stringify({data:f.data,platform,source:await f.sharedFolders.get('source-import','project-one'),projectId:'project-one'}));
 async function child(){const proc=fork(fileURLToPath(new URL('./helpers/classification-batch-child.mjs',import.meta.url)),[],{env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'en_US.UTF-8',JINGCHANG_BATCH_FIXTURE:config},execArgv:['--import',fileURLToPath(new URL('./helpers/local-network-only.mjs',import.meta.url))],silent:true});let next=0;const pending=new Map(),ready=deferred();proc.on('message',m=>{if(m.ready)ready.resolve();else{pending.get(m.serial)?.resolve(m);pending.delete(m.serial);}});t.after(async()=>{if(proc.exitCode===null&&proc.signalCode===null){const done=once(proc,'exit');proc.kill();await done;}});await Promise.race([ready.promise,once(proc,'exit').then(()=>{throw Error('Batch fixture exited');})]);return{call:async(method,body,id='batch-one')=>{const serial=++next,d=deferred();pending.set(serial,d);proc.send({serial,method,body,id});return d.promise;}};}
 const a=await child(),b=await child(),body=await f.body();body.authorization.origin=origin;
 const both=await Promise.all([a.call('start',structuredClone(body)),b.call('start',structuredClone(body))]);assert.ok(both.some(r=>r.value));
 for(let i=0;i<500;i++){const r=await a.call('get');if(r.value?.status==='completed')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal((await a.call('get')).value.status,'completed');assert.equal(sends,3);assert.equal((await b.call('get')).value.runs.length,1);const again=await b.call('start',body);assert.equal(again.value.status,'completed');assert.equal(sends,3);
});
