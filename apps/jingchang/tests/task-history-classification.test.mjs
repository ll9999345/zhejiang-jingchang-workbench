import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {makeProject} from '../lib/model.mjs';
import {atomicJson,readJson,storeAsset,loadAsset} from '../lib/workspace.mjs';
import {assetClassificationService} from '../lib/asset-classification.mjs';
import {assetClassificationReceiptStore} from '../lib/asset-classification-receipts.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {taskHistoryArchiveService,TASK_HISTORY_MAGIC} from '../lib/task-history-archive.mjs';
import './helpers/local-network-only.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGbcAAAAASUVORK5CYII=','base64');
const key='sk-test-classification-archive-secret',sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const platform={id:'local-vision',protocol:'openai-compatible',baseUrl:'http://127.0.0.1:18888/v1',models:[{id:'vision-fixture',category:'chat',referenceSupport:true}]};
const classes={summary:'湖岸与山色',categories:{environment:['室外','湖岸'],custom_theme:['江南'],materials:['岩石']},tags:['文旅','清晨']};
const source='asset-classification-tasks';
async function fixture(options={}){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-classification-history-')),activeJobs=new Map();
 await fs.mkdir(path.join(data,'assets'));
 const projects={load:id=>readJson(path.join(data,'projects',id,'project.json')),save:async p=>{await atomicJson(path.join(data,'projects',p.id,'project.json'),p);return p;}};
 const bundles=projectBundleService({data,projects,activeJobs});
 return{data,projects,activeJobs,bundles,service:taskHistoryArchiveService({data,projects,activeJobs,projectBundles:bundles,...options})};
}
const names=(data,dir)=>fs.readdir(path.join(data,dir)).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e));
async function seeded(options={}){
 const f=await fixture(options),p=makeProject('分类留痕迁移'),a=await storeAsset(f.data,png,{name:'原分类图片.png',type:'image/png'});p.assets=[a];p.nodes[0].assetId=a.id;await f.projects.save(p);
 let calls=0;
 async function classify(requestId,status='completed',asset=a,projectId=p.id){
  const apiCall=async()=>{calls++;if(status!=='completed')throw Object.assign(new Error('upstream '+key),status==='failed'?{upstreamStatus:401}:{});return{choices:[{finish_reason:'stop',message:{content:JSON.stringify(classes)}}]};};
  const classifier=assetClassificationService({data:f.data,platforms:{get:async()=>platform},apiCall});
  const body={requestId,projectId,platformId:platform.id,model:'vision-fixture',apiKey:key,prompt:'只标记可见内容',consent:true,authorization:{origin:'http://127.0.0.1:18888',model:'vision-fixture',sendImage:true,requestLimit:1,budget:0,currency:'CNY',consent:true}};
  const result=await classifier.classify(asset.id,body).catch(e=>e);assert.equal(body.apiKey,'');
  const row=await classifier.get(requestId);assert.equal(row.status,status);return{row,result,classifier};
 }
 await classify('completed-one');p.assets=[await loadAsset(f.data,a.id)];await f.projects.save(p);
 await atomicJson(path.join(f.data,'projects',p.id,'history','0-classified.json'),p);
 return{...f,p,a,classify,get calls(){return calls;}};
}
async function exported(f){const preview=await f.service.exportArchive(f.p.id,f.p.revision);return{preview,file:await f.service.download(preview.id)};}
async function rewrite(file,mutate){const bytes=await fs.readFile(file),off=TASK_HISTORY_MAGIC.length+4,len=bytes.readUInt32BE(TASK_HISTORY_MAGIC.length),m=JSON.parse(bytes.subarray(off,off+len));mutate(m);const body=Buffer.from(JSON.stringify(m)),size=Buffer.alloc(4);size.writeUInt32BE(body.length);return Buffer.concat([TASK_HISTORY_MAGIC,size,body,Buffer.from(sha(body),'hex'),bytes.subarray(off+len+32)]);}
async function readOnlyTarget(target){assert.equal(target.activeJobs.size,0);assert.deepEqual(await names(target.data,'jobs'),[]);assert.deepEqual(await names(target.data,source),[]);}
async function protectedBytes(f){const paths=[path.join(f.data,'projects',f.p.id,'project.json'),path.join(f.data,'assets',f.a.id),path.join(f.data,'assets',f.a.id+'.json'),...(await fs.readdir(path.join(f.data,source))).map(name=>path.join(f.data,source,name))];return new Map(await Promise.all(paths.map(async file=>[file,await fs.readFile(file)])));}
async function unchanged(before){for(const [file,bytes]of before)assert.deepEqual(await fs.readFile(file),bytes,file);}

test('actual classify/export/inspect/import/read keeps four terminal outcomes and full dynamic tags; no live task or credential is restored',async()=>{
 const f=await seeded();await f.classify('failed-one','failed');await f.classify('uncertain-one','uncertain');
 const store=assetClassificationReceiptStore(f.data),raw=await store.read('completed-one'),queued={...structuredClone(raw),id:'cancelled-one',requestId:'cancelled-one',status:'queued'};delete queued.result;delete queued.sendIntentAt;delete queued.finishedAt;
 await store.write(queued,{create:true});await assetClassificationService({data:f.data,platforms:{get:async()=>platform}}).cancel(queued.id);
 const before=await protectedBytes(f),out=await exported(f);assert.equal(out.preview.complete,true,JSON.stringify(out.preview.unsupported));assert.equal(out.preview.classifications,4);assert.equal(f.calls,3);
 const bytes=await fs.readFile(out.file);for(const secret of [key,'credentialSource','credentialConsent','bindingDigest','"owner"','data:image/','Authorization'])assert.equal(bytes.includes(Buffer.from(secret)),false,secret);
 const target=await fixture(),preview=await target.service.upload(createReadStream(out.file,{highWaterMark:19}));assert.equal(preview.classifications,4);const restored=await target.service.importArchive(preview.id,{previewDigest:preview.previewDigest});
 const record=await target.service.readArchive(restored.id,{projectId:restored.projectId});assert.equal(record.canResume,false);assert.equal(record.readOnly,true);assert.notEqual(record.projectId,f.p.id);
 const receipts=record.manifest.auxiliaryReceipts.filter(r=>r.source===source);assert.deepEqual(receipts.map(r=>r.record.status).sort(),['cancelled','completed','failed','uncertain']);
 const saved=receipts.find(r=>r.id==='completed-one').record;assert.equal(saved.projectId,f.p.id);assert.equal(saved.assetId,f.a.id);assert.deepEqual(saved.result.categories,classes.categories);assert.deepEqual(saved.result,raw.result);
 const current=await target.projects.load(record.projectId);assert.notEqual(current.assets[0].id,f.a.id);assert.deepEqual(current.assets[0].classification,raw.result);assert.deepEqual(record.manifest.currentSnapshot.assets[0].classification,raw.result);
 assert.deepEqual(await fs.readFile((await target.service.archiveFile(record.id,'asset-'+f.a.id)).file),png);await readOnlyTarget(target);await unchanged(before);assert.equal(f.calls,3);
 const again=await target.service.importArchive(preview.id);assert.equal(again.id,record.id);await readOnlyTarget(target);
});

test('immutable terminal state wins over a stale sending primary JSON without mutating either source',async()=>{
 const f=await seeded(),store=assetClassificationReceiptStore(f.data),row=await store.read('completed-one'),stale=structuredClone(row);stale.status='sending';delete stale.result;delete stale.finishedAt;
 await atomicJson(path.join(f.data,source,row.id+'.json'),stale);const before=await protectedBytes(f),out=await exported(f);assert.equal(out.preview.complete,true);
 const target=await fixture(),preview=await target.service.upload(createReadStream(out.file)),record=await target.service.importArchive(preview.id);assert.equal(record.manifest.auxiliaryReceipts.find(r=>r.id===row.id).record.status,'completed');await unchanged(before);await readOnlyTarget(target);
});

for(const state of ['queued','sending'])test('an uncommitted '+state+' classification blocks archive even outside the generic activeJobs map',async()=>{
 const f=await seeded(),store=assetClassificationReceiptStore(f.data),row=await store.read('completed-one'),pending={...structuredClone(row),id:'pending-one',requestId:'pending-one',status:state};delete pending.result;delete pending.finishedAt;if(state==='queued')delete pending.sendIntentAt;
 await store.write(pending,{create:true});const before=await protectedBytes(f);await assert.rejects(f.service.exportArchive(f.p.id,f.p.revision),e=>e.status===409&&/分类仍在执行/.test(e.message));await unchanged(before);assert.equal(f.calls,1);
});

test('empty-project global records follow referenced assets; explicit other-project and unrelated global records do not leak',async()=>{
 const f=await seeded();await f.classify('global-one','completed',f.a,'');await f.classify('other-project-one','completed',f.a,'other-project');const another=await storeAsset(f.data,png,{name:'无关.png',type:'image/png'});await f.classify('unrelated-global','completed',another,'');
 const out=await exported(f);assert.equal(out.preview.classifications,2);const t=await fixture(),preview=await t.service.upload(createReadStream(out.file)),r=await t.service.importArchive(preview.id);assert.deepEqual(r.manifest.auxiliaryReceipts.filter(r=>r.source===source).map(r=>r.id).sort(),['completed-one','global-one']);await readOnlyTarget(t);
});

test('missing original image bytes never become a complete classification archive',async()=>{
 const f=await seeded(),bytes=Buffer.from(png);bytes[bytes.length-1]^=1;await fs.writeFile(path.join(f.data,'assets',f.a.id),bytes);
 const out=await exported(f);assert.equal(out.preview.complete,false);assert.ok(out.preview.unsupported.some(r=>r.kind==='asset-classification'&&r.reason==='original-image-mismatch'));
 const t=await fixture(),preview=await t.service.upload(createReadStream(out.file));await assert.rejects(t.service.importArchive(preview.id),/未支持|缺失/);await readOnlyTarget(t);
});

for(const [label,mutate]of [
 ['media hash changed',(r,m)=>{r.media.sha256='0'.repeat(64);} ],
 ['model result rebound',r=>{r.result.model='different-model';}],
 ['authorization budget invalid',r=>{r.authorization.budget=-1;}],
 ['project rebound',r=>{r.projectId='another-project';}],
 ['live state smuggled',r=>{r.status='sending';delete r.result;}],
 ['private credential inserted',r=>{r.authorization.apiKey=key;}],
 ['unsupported result field',r=>{r.result.canResume=true;}],
 ['duplicate receipt',(r,m)=>{m.auxiliaryReceipts.push(structuredClone(m.auxiliaryReceipts.find(x=>x.source===source)));}],
 ['wrong source kind',r=>{r.kind='image-api';}]
])test('archive validation rejects '+label+' even with a recomputed header digest',async()=>{
 const f=await seeded(),out=await exported(f),bad=await rewrite(out.file,m=>mutate(m.auxiliaryReceipts.find(r=>r.source===source).record,m));const target=await fixture();await assert.rejects(target.service.upload(Readable.from([bad])));await readOnlyTarget(target);assert.deepEqual(await names(target.data,'projects'),[]);
});

test('a symlinked terminal receipt cannot bypass the archive workspace boundary',async()=>{
 const f=await seeded(),store=assetClassificationReceiptStore(f.data),raw=await store.read('completed-one'),outside=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-classification-outside-')),'row.json');await fs.writeFile(outside,JSON.stringify({...raw,id:'linked-one',requestId:'linked-one'}));await fs.symlink(outside,path.join(f.data,source,'linked-one.terminal'));
 await assert.rejects(f.service.exportArchive(f.p.id,f.p.revision),/留痕损坏|普通|链接/);assert.equal(f.calls,1);
});

test('201 already-stored classification receipts are archived without a UI-list cutoff or any new inference',async()=>{
 const f=await seeded(),store=assetClassificationReceiptStore(f.data),row=await store.read('completed-one');
 for(let i=0;i<200;i++){const id='bulk-'+i;await store.write({...structuredClone(row),id,requestId:id},{create:true});}
 const out=await exported(f);assert.equal(out.preview.complete,true);assert.equal(out.preview.classifications,201);assert.equal(f.calls,1);
 const t=await fixture(),preview=await t.service.upload(createReadStream(out.file)),record=await t.service.importArchive(preview.id);assert.equal(record.manifest.auxiliaryReceipts.filter(r=>r.source===source).length,201);await readOnlyTarget(t);
});

for(const mutation of ['terminal-content','directory'])test('changing classification '+mutation+' during export prevents a ready archive',async()=>{
 let f,changed=false;
 f=await seeded({diskInfo:async root=>{
  if(!changed){changed=true;const store=assetClassificationReceiptStore(f.data),row=await store.read('completed-one');
   if(mutation==='terminal-content'){row.result.summary='归档期间更改';await atomicJson(path.join(f.data,source,row.id+'.terminal'),row);}
   else await store.write({...structuredClone(row),id:'new-during-export',requestId:'new-during-export'},{create:true});
  }
  return fs.statfs(root);
 }});
 await assert.rejects(f.service.exportArchive(f.p.id,f.p.revision,{requestId:'mutating-export'}),e=>e.status===409&&/已变化/.test(e.message));
 await assert.rejects(fs.stat(path.join(f.data,'task-history-archives','exports','mutating-export','ready.json')),e=>e.code==='ENOENT');assert.equal(f.calls,1);
});

test('read-only archive count cannot be changed independently of the validated classification records',async()=>{
 const f=await seeded(),out=await exported(f),t=await fixture(),preview=await t.service.upload(createReadStream(out.file)),record=await t.service.importArchive(preview.id);
 const file=path.join(t.data,'task-history-archives','records',record.id,'record.json'),raw=await readJson(file);raw.classifications=99;await atomicJson(file,raw);
 await assert.rejects(t.service.readArchive(record.id),/分类留痕数量与清单不一致/);await assert.rejects(t.service.listArchives(record.projectId),/分类留痕数量与清单不一致/);await readOnlyTarget(t);
});
