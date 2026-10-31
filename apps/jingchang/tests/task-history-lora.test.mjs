import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {makeProject} from '../lib/model.mjs';
import {atomicJson,readJson,records,userError} from '../lib/workspace.mjs';
import {importLoraFile} from '../lib/lora-files.mjs';
import {runningHubLoraService,resolveRhLoras} from '../lib/runninghub-loras.mjs';
import {loadLoraReceipt,readOnlyLoraReceipts,scanReadOnlyLoraReceipts} from '../lib/lora-receipt-store.mjs';
import {diagnostics} from '../lib/diagnostics.mjs';
import {cloudWorkflowService} from '../lib/cloud-workflows.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {taskHistoryArchiveService} from '../lib/task-history-archive.mjs';
import {tensorFile} from './helpers/lora-fixture.mjs';

async function fixture(){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-history-lora-')),activeJobs=new Map();
 const projects={load:async id=>{try{return await readJson(path.join(data,'projects',id,'project.json'));}catch(e){if(e.code==='ENOENT')throw userError('项目不存在',404);throw e;}},save:async p=>{await atomicJson(path.join(data,'projects',p.id,'project.json'),p);return p;}};
 const bundle=projectBundleService({data,projects,activeJobs});
 return {data,activeJobs,projects,bundle,history:taskHistoryArchiveService({data,projects,activeJobs,projectBundles:bundle})};
}
async function seeded(){
 const f=await fixture(),p=makeProject('LoRA留痕迁移'),bytes=tensorFile(),asset=await importLoraFile(f.data,Readable.from([bytes]),{name:'原模型.safetensors',size:bytes.length});
 p.assets.push(asset);await f.projects.save(p);
 const receipt={id:'accepted-lora',kind:'lora-upload',status:'completed',projectId:p.id,assetId:asset.id,name:'原模型',size:asset.size,sha256:asset.lora.sha256,md5Hex:asset.lora.md5Hex,baseUrl:'http://127.0.0.1:8188',fileName:'api-lora-cn/accepted.safetensors',createdAt:p.createdAt,completedAt:p.createdAt,uploadCount:1,assets:[],bytesSent:asset.size};
 await atomicJson(path.join(f.data,'jobs',receipt.id+'.json'),receipt);
 const cloud=cloudWorkflowService(f);let recipe=await cloud.create({projectId:p.id});
 recipe=await cloud.save(recipe.id,{...recipe,kind:'workflow',targetId:'1234',baseUrl:receipt.baseUrl,fields:[{nodeId:'7',fieldName:'lora_name',fieldValue:'original-placeholder',type:'text',nodeClass:'RHLoraLoader',label:'LoRA',source:'lora',assetId:asset.id,receiptId:receipt.id}]});
 p.nodes[0].params.cloudBinding={recipeId:recipe.id,recipeRevision:recipe.revision,inputs:[]};await f.projects.save(p);
 return {...f,p,asset,bytes,receipt,recipe};
}
async function archived(source,target){
 const out=await source.history.exportArchive(source.p.id,source.p.revision);assert.equal(out.complete,true,JSON.stringify(out.unsupported));
 const preview=await target.history.upload(createReadStream(await source.history.download(out.id)));
 const record=await target.history.importArchive(preview.id,{previewDigest:preview.previewDigest});
 const p=await target.projects.load(record.projectId),recipe=(await records(path.join(target.data,'cloud-workflows'))).find(r=>r.projectId===p.id),receipts=await readOnlyLoraReceipts(target.data);
 return {out,preview,record,p,recipe,receipt:receipts.find(r=>r.projectId===p.id)};
}
test('完整留痕携带LoRA原件和成功记录，只读恢复绑定、零jobs/零活动任务且重复导入幂等',async()=>{
 const source=await seeded(),before=await fs.readFile(path.join(source.data,'projects',source.p.id,'project.json')),target=await fixture(),copy=await archived(source,target);
 assert.deepEqual(await records(path.join(target.data,'jobs')),[]);assert.equal(target.activeJobs.size,0);
 assert.notEqual(copy.receipt.id,source.receipt.id);assert.notEqual(copy.receipt.assetId,source.asset.id);assert.equal(copy.receipt.originalReceiptId,source.receipt.id);
 assert.equal(copy.recipe.fields[0].receiptId,copy.receipt.id);assert.equal(copy.recipe.fields[0].assetId,copy.receipt.assetId);assert.equal(copy.p.nodes[0].params.cloudBinding.recipeId,copy.recipe.id);
 assert.equal((await resolveRhLoras({data:target.data,project:copy.p,recipe:copy.recipe})).fields[0].fieldValue,source.receipt.fileName);
 const service=runningHubLoraService(target),j=await service.get(copy.receipt.id);assert.equal(j.readOnly,true);assert.equal(j.canResume,false);assert.equal(j.canApply,false);assert.equal((await service.list(copy.p.id)).length,1);
 assert.deepEqual(await fs.readFile(path.join(target.data,'assets',copy.receipt.assetId)),source.bytes);
 assert.equal((await target.history.importArchive(copy.preview.id)).projectId,copy.p.id);assert.equal((await readOnlyLoraReceipts(target.data)).length,1);assert.equal((await fs.readdir(path.join(target.data,'projects'))).length,1);
 assert.deepEqual(await fs.readFile(path.join(source.data,'projects',source.p.id,'project.json')),before);
 const old=copy.record.manifest.jobs.find(j=>j.id===source.receipt.id);assert.deepEqual(old,source.receipt);assert.equal(copy.record.canResume,false);
});
test('只读恢复仍检查平台、工程和原文件散列；不能冒用旧成功记录',async()=>{
 const source=await seeded(),target=await fixture(),copy=await archived(source,target),args={data:target.data,project:copy.p,recipe:copy.recipe};
 await assert.rejects(resolveRhLoras({...args,project:{...copy.p,id:'wrong-project'}}),/不一致/);
 await assert.rejects(resolveRhLoras({...args,recipe:{...copy.recipe,baseUrl:'http://127.0.0.1:9191'}}),/不一致/);
 const changed=Buffer.from(source.bytes);changed[changed.length-1]^=1;await fs.writeFile(path.join(target.data,'assets',copy.receipt.assetId),changed);
 await assert.rejects(resolveRhLoras(args),/不一致/);assert.deepEqual(await records(path.join(target.data,'jobs')),[]);
});
test('只读LoRA项目可再次导出完整留痕和普通工程包，第二次迁移保持关联',async()=>{
 const source=await seeded(),first=await fixture(),copy=await archived(source,first),second=await fixture();
 const next=await archived({...first,p:copy.p},second);assert.equal(next.record.manifest.auxiliaryReceipts.filter(r=>r.source==='lora-receipts').length,1);assert.equal(next.out.complete,true);
 assert.equal((await resolveRhLoras({data:second.data,project:next.p,recipe:next.recipe})).fields[0].fieldValue,source.receipt.fileName);assert.deepEqual(await records(path.join(second.data,'jobs')),[]);
 const bundle=await first.bundle.exportBundle(copy.p.id,copy.p.revision);assert.equal(bundle.loraReceipts,1);assert.equal(bundle.loras,1);
});
test('普通工程备份默认恢复jobs，完整留痕只读选项不改变其原行为；同预览不能切换恢复方式',async()=>{
 const source=await seeded(),out=await source.bundle.exportBundle(source.p.id,source.p.revision),target=await fixture(),preview=await target.bundle.upload(createReadStream(await source.bundle.download(out.id))),p=await target.bundle.importBundle(preview.id);
 const legacy=(await records(path.join(target.data,'jobs'))).find(j=>j.kind==='lora-upload');assert.equal(legacy.projectId,p.id);assert.deepEqual(await readOnlyLoraReceipts(target.data),[]);assert.equal((await loadLoraReceipt(target.data,legacy.id)).readOnly,false);
 await assert.rejects(target.bundle.importBundle(preview.id,{loraReceiptStore:'lora-receipts'}),/另一种|不一致/);assert.equal((await fs.readdir(path.join(target.data,'projects'))).length,1);
});
test('只读LoRA目录/文件符号链接、身份错配及秘密字段均拒绝',async()=>{
 const source=await seeded(),outside=await fixture(),dirTarget=await fixture();await fs.mkdir(path.join(outside.data,'lora-receipts'));await fs.symlink(path.join(outside.data,'lora-receipts'),path.join(dirTarget.data,'lora-receipts'));
 await assert.rejects(readOnlyLoraReceipts(dirTarget.data),/符号链接/);
 const fileTarget=await fixture();await fs.mkdir(path.join(fileTarget.data,'lora-receipts'));await fs.symlink(path.join(source.data,'jobs',source.receipt.id+'.json'),path.join(fileTarget.data,'lora-receipts',source.receipt.id+'.json'));
 await assert.rejects(loadLoraReceipt(fileTarget.data,source.receipt.id),/无效/);
 for(const patch of [{kind:'image-api'},{status:'running'},{id:'different-id'},{apiKey:'LOCAL-TEST-DO-NOT-PERSIST'}]){
  const f=await fixture();await atomicJson(path.join(f.data,'lora-receipts',source.receipt.id+'.json'),{...source.receipt,...patch});await assert.rejects(loadLoraReceipt(f.data,source.receipt.id),/无效|秘密|凭据|密钥/);
 }
});
test('中断后重试不覆盖已变更的只读收据，失败原件保留；未改收据可按原计划恢复',async()=>{
 for(const tamper of [false,true]){
  const source=await seeded(),out=await source.bundle.exportBundle(source.p.id,source.p.revision),target=await fixture(),preview=await target.bundle.upload(createReadStream(await source.bundle.download(out.id))),save=target.projects.save;
  target.projects.save=async()=>{throw userError('测试：保存工程前中断',503);};
  await assert.rejects(target.bundle.importBundle(preview.id,{loraReceiptStore:'lora-receipts'}),/中断/);
  const [receipt]=await readOnlyLoraReceipts(target.data),file=path.join(target.data,'lora-receipts',receipt.id+'.json');assert.equal((await fs.stat(file)).mode&0o222,0);
  target.projects.save=save;
  if(tamper){await fs.chmod(file,0o644);await fs.writeFile(file,JSON.stringify({...receipt,name:'手动修改的原件'}));const before=await fs.readFile(file);await assert.rejects(target.bundle.importBundle(preview.id,{loraReceiptStore:'lora-receipts'}),/已修改|被占用/);assert.deepEqual(await fs.readFile(file),before);assert.deepEqual(await records(path.join(target.data,'projects')),[]);}
  else{const p=await target.bundle.importBundle(preview.id,{loraReceiptStore:'lora-receipts'});assert.equal(p.id,receipt.projectId);assert.equal((await readOnlyLoraReceipts(target.data)).length,1);}
  assert.deepEqual(await records(path.join(target.data,'jobs')),[]);
 }
});
test('其他工程坏收据不阻塞有效LoRA列表，诊断报告坏记录且直接读取拒绝',async()=>{
 const source=await seeded(),target=await fixture(),copy=await archived(source,target),badFile=path.join(target.data,'lora-receipts','unrelated-broken.json');await fs.writeFile(badFile,'{broken');
 const scan=await scanReadOnlyLoraReceipts(target.data);assert.equal(scan.records.length,1);assert.equal(scan.issues[0].receiptId,'unrelated-broken');assert.equal((await runningHubLoraService(target).list(copy.p.id)).length,1);
 await assert.rejects(loadLoraReceipt(target.data,'unrelated-broken'));
 const report=await diagnostics({root:path.resolve('.'),data:target.data,projects:[{id:copy.p.id}]});assert(report.missingReferences.some(r=>r.receiptId==='unrelated-broken'));assert(!report.missingReferences.some(r=>r.projectId===copy.p.id&&r.issue.includes('LoRA')));assert.equal(report.counts.jobs,0);
 const out=await target.bundle.exportBundle(copy.p.id,copy.p.revision);assert.equal(out.loraReceipts,1);
});
