import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {randomUUID,createHash} from 'node:crypto';
import {libraryFixture,backupFixture,terminal,png} from './helpers/library-backup-fixture.mjs';
import {LIBRARY_MAGIC,MAX_LIBRARY_MANIFEST,portableLibraryCatalog,normalizeLibraryArchive} from '../lib/library-backups.mjs';
import {atomicJson,readJson,loadAsset,storeAsset} from '../lib/workspace.mjs';
import {taskPresentation} from '../public/task-state-core.js';
import {normalizeMinimaxTimeline,newMinimaxSegment} from '../public/minimax-h3-core.js';
import {makeNode} from '../lib/model.mjs';
import {h3Workflow} from './helpers/minimax-h3-fixture.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const decode=b=>JSON.parse(b.subarray(LIBRARY_MAGIC.length+4,LIBRARY_MAGIC.length+4+b.readUInt32BE(LIBRARY_MAGIC.length)).toString());
function archive(manifest,body=Buffer.alloc(0)){const json=Buffer.from(JSON.stringify(manifest)),n=Buffer.alloc(4);n.writeUInt32BE(json.length);return Buffer.concat([LIBRARY_MAGIC,n,json,body]);}
async function upload(dst,file,id=randomUUID()){return dst.service.upload(createReadStream(file),{requestId:id,projectId:dst.p.id});}
async function restore(dst,imported,id=randomUUID()){const started=await dst.service.start({requestId:id,projectId:dst.p.id,revision:(await dst.catalog.read()).revision},imported.id);return terminal(dst.service,started.id,dst.p.id);}

test('整库封装第33版H3工程与子图，恢复随机方式和单次参数，不改当前工程或执行模型',async()=>{
 const source=await libraryFixture({populated:true}),project=structuredClone(source.p),template=await source.generation.saveTemplate({name:'本机H3模板',workflow:h3Workflow}),video=project.assets.find(a=>a.type==='video/mp4'),h=normalizeMinimaxTimeline({version:1,segments:[newMinimaxSegment('clip',0,{duration:1,trimOut:1,prompt:'备份参数',seed:19,seedMode:'random',resultAssetId:video.id,resultAssetIds:[video.id],resultVariants:[{assetId:video.id,parameters:{prompt:'真实提交参数记录',duration:1,aspectRatio:'16:9',megapixels:.4,seed:456}}]})],selectedSegmentId:'clip',materials:[{assetId:video.id,segmentId:'clip'}]}),node=makeNode('video',200,100,{params:{workflowBinding:{workflowId:template.id,overrides:[],imageSources:[],count:1,minimaxH3:h}}});
 project.nodes.push(node);source.map.set(project.id,project);
 for(const kind of ['canvas','canvas-fragment']){const state=await source.catalog.read();await source.catalog.addWorkflow({requestId:randomUUID(),kind,name:'H3-'+kind,revision:state.revision,libraryId:'default',folderId:'workflows',projectId:project.id,projectRevision:project.revision,...(kind==='canvas-fragment'?{nodeIds:[node.id]}:{})});}
 const b=await backupFixture(source),dst=await libraryFixture(),before=structuredClone(dst.p),accepted=await upload(dst,b.file),j=await restore(dst,accepted);assert.equal(j.status,'completed',j.message);const restored=(await dst.catalog.read()).libraries.filter(l=>j.result.libraryIds.includes(l.id)).flatMap(l=>l.folders.flatMap(f=>f.items)).filter(i=>i.name.startsWith('H3-'));assert.equal(restored.length,2);
 for(const item of restored){const preview=await dst.bundles.previewLibraryPackage(item.bundleId);assert.equal(preview.formatVersion,33);}
 const full=restored.find(i=>i.kind==='canvas'),p=await dst.catalog.reuseCanvas(full.id,{requestId:randomUUID()}),next=p.nodes.find(n=>n.params.workflowBinding?.minimaxH3).params.workflowBinding.minimaxH3.segments[0];assert.equal(next.seedMode,'random');assert.equal(next.seed,19);assert.equal(next.resultVariants[0].parameters.seed,456);assert.equal(next.resultVariants[0].assetId,next.resultAssetId);assert.notEqual(next.resultAssetId,video.id);assert.deepEqual(dst.map.get(dst.p.id),before);assert.equal([...dst.activeJobs.values()].some(j=>['comfy','runninghub','studio','canvas-run'].includes(j.kind)),false);
});

test('整库备份包含全部媒体、空分组、回收记录及三类工作流，不改变工程',async()=>{
  const f=await libraryFixture({populated:true}),before=structuredClone(f.p),state=await f.catalog.read(),b=await backupFixture(f),bytes=await fs.readFile(b.file),m=normalizeLibraryArchive(decode(bytes));
  assert.deepEqual(m.catalog,portableLibraryCatalog(state));assert.equal(m.assets.length,3);assert.equal(m.workflows.length,1);assert.deepEqual(m.bundles.map(x=>x.kind),['canvas','canvas-fragment']);
  assert.equal(b.job.result.archivedLibraries,1);assert.equal(b.job.result.archivedItems,1);assert.equal(b.job.result.folders,5);assert.equal(b.job.plan,undefined);assert.equal(b.job.result.sha256,sha(bytes));assert.deepEqual(f.map.get(f.p.id),before);assert.equal(f.activeJobs.size,0);
  assert.ok(!JSON.stringify(m).includes(f.data));assert.equal(m.assets.find(a=>a.type==='image/png').classification.summary,'测试角色');
});
test('跨工作区整库恢复新增所有库；原条目、选择、工程与文件保持，模板和画布可复用',async()=>{
  const source=await libraryFixture({populated:true}),b=await backupFixture(source),dst=await libraryFixture({populated:true});
  const before=await dst.catalog.read(),project=structuredClone(dst.map.get(dst.p.id)),oldImage=await fs.readFile(path.join(dst.data,'assets',dst.image.id));
  const accepted=await upload(dst,b.file);assert.equal(accepted.status,'checked');assert.equal(accepted.canvases,1);assert.equal(accepted.fragments,1);
  const j=await restore(dst,accepted);assert.equal(j.status,'completed',j.message);const after=await dst.catalog.read();assert.deepEqual(after.libraries.slice(0,before.libraries.length),before.libraries);assert.equal(after.activeLibraryId,before.activeLibraryId);assert.deepEqual(dst.map.get(dst.p.id),project);assert.deepEqual(await fs.readFile(path.join(dst.data,'assets',dst.image.id)),oldImage);
  const added=after.libraries.filter(l=>j.result.libraryIds.includes(l.id));assert.equal(added.length,2);assert.equal(added[1].archived,true);assert.deepEqual(added[0].folders.map(f=>[f.name,f.archived]),source ? (await source.catalog.read()).libraries[0].folders.map(f=>[f.name,f.archived]):[]);
  for(const l of added)for(const f of l.folders)for(const i of f.items){assert.ok(i.file);if(i.kind==='media'){const a=await loadAsset(dst.data,i.assetId);assert.notEqual(a.id,source.mediaEntries.find(e=>e.name===i.name)?.assetId);assert.equal(a.sha256,sha(await fs.readFile(path.join(dst.data,'assets',a.id))));}if(i.kind==='comfy'){const w=await dst.generation.template(i.workflowId);assert.equal(w.fields[0].mediaKind,'image');}if(['canvas','canvas-fragment'].includes(i.kind)){const preview=await dst.bundles.previewLibraryPackage(i.bundleId);assert.equal(preview.canvasFragment,i.kind==='canvas-fragment');assert.equal(i.summary.nodes,1);}}
  const full=added[0].folders.flatMap(f=>f.items).find(i=>i.kind==='canvas'),newProject=await dst.catalog.reuseCanvas(full.id,{requestId:randomUUID()});assert.equal(newProject.nodes.length,1);assert.equal(newProject.assets.length,3);assert.notEqual(newProject.id,dst.p.id);
  assert.equal((await dst.service.start({requestId:j.id,projectId:dst.p.id,revision:0},accepted.id)).id,j.id);assert.equal((await dst.catalog.read()).libraries.length,after.libraries.length);
});
test('同一接收编号幂等，换文件冲突；预览和重新读取不会恢复目录',async()=>{
  const f=await libraryFixture({populated:true}),b=await backupFixture(f),dst=await libraryFixture(),id=randomUUID(),before=await dst.catalog.read();
  const first=await upload(dst,b.file,id),second=await upload(dst,b.file,id);assert.deepEqual(first,second);assert.equal((await dst.service.listImports(dst.p.id)).length,1);assert.deepEqual(await dst.catalog.read(),before);
  const empty=await backupFixture(dst);await assert.rejects(upload(dst,empty.file,id),e=>e.status===409);assert.deepEqual(await dst.service.getImport(id,dst.p.id),first);
});
test('损坏、截断、尾部多余字节与伪造画布文件均不能发布整库',async()=>{
  const f=await libraryFixture({populated:true}),b=await backupFixture(f),bytes=await fs.readFile(b.file),dst=await libraryFixture(),before=await dst.catalog.read();
  const broken=Buffer.from(bytes);broken[broken.length-1]^=1;
  for(const input of [broken,bytes.subarray(0,bytes.length-1),Buffer.concat([bytes,Buffer.from('x')])])await assert.rejects(dst.service.upload(Readable.from(input),{requestId:randomUUID(),projectId:dst.p.id}),/不完整|未完整|校验|长度/);
  const m=decode(bytes),body=bytes.subarray(LIBRARY_MAGIC.length+4+bytes.readUInt32BE(LIBRARY_MAGIC.length)),start=m.assets.reduce((n,a)=>n+a.size,0),changed=Buffer.from(body);changed[start]=0;m.bundles[0].sha256=sha(changed.subarray(start,start+m.bundles[0].size));
  await assert.rejects(dst.service.upload(Readable.from(archive(m,changed)),{requestId:randomUUID(),projectId:dst.p.id}),/画布文件不是/);assert.deepEqual(await dst.catalog.read(),before);
  assert.ok((await dst.service.listImports(dst.p.id)).every(r=>r.status==='interrupted'));
});
test('密钥和危险 JSON 字段在清单写入前拒绝；清单、引用、数量和容量边界验证',async()=>{
  const f=await libraryFixture(),b=await backupFixture(f),m=decode(await fs.readFile(b.file)),id=randomUUID();
  await assert.rejects(f.service.upload(Readable.from(archive({...m,apiKey:'synthetic-value'})),{requestId:id,projectId:f.p.id}),/密钥/);
  const received=await fs.readdir(path.join(f.data,'library-backups','imports',id));const file=received.find(n=>n.endsWith('.received'));assert.equal((await fs.stat(path.join(f.data,'library-backups','imports',id,file))).size,0);
  const dangerous=JSON.parse(JSON.stringify(m).replace('"version":1','"version":1,"__proto__":{"unsafe":true}'));assert.throws(()=>normalizeLibraryArchive(dangerous),/不支持/);
  const invalid=structuredClone(m);invalid.catalog.libraries[0].folders[0].items=[{id:'missing',kind:'media',name:'缺失文件',archived:false,assetId:'absent'}];assert.throws(()=>normalizeLibraryArchive(invalid),/缺少/);
  const head=Buffer.alloc(4);head.writeUInt32BE(MAX_LIBRARY_MANIFEST+1);await assert.rejects(f.service.upload(Readable.from(Buffer.concat([LIBRARY_MAGIC,head])),{requestId:randomUUID(),projectId:f.p.id}),/清单长度/);
  const tooLarge={...m,assets:[{id:'too-big',type:'image/png',size:4*1024**3+1,name:'超限',sha256:'0'.repeat(64)}]};assert.throws(()=>normalizeLibraryArchive(tooLarge),/记录无效/);
});
test('接收中断可按同一编号重新选择原文件；服务重启保留接收证据',async()=>{
  const f=await libraryFixture({populated:true}),b=await backupFixture(f),dst=await libraryFixture(),id=randomUUID(),bytes=await fs.readFile(b.file);
  await assert.rejects(dst.service.upload(Readable.from(bytes.subarray(0,100)),{requestId:id,projectId:dst.p.id}),/未完整/);
  const receipt=await readJson(path.join(dst.data,'library-backups','imports',id,'record.json'));receipt.status='receiving';await atomicJson(path.join(dst.data,'library-backups','imports',id,'record.json'),receipt);
  const fresh=dst.reloadService();await fresh.recover();assert.equal((await fresh.getImport(id,dst.p.id)).status,'interrupted');assert.equal((await fresh.upload(createReadStream(b.file),{requestId:id,projectId:dst.p.id})).status,'checked');
  assert.equal((await fs.readdir(path.join(dst.data,'library-backups','imports',id))).filter(n=>n.endsWith('.received')).length,2);
});
test('停止后的恢复按原资源计划续接，不重复发布目录',async()=>{
  const f=await libraryFixture({populated:true}),b=await backupFixture(f),dst=await libraryFixture(),accepted=await upload(dst,b.file),id=randomUUID();
  const original=dst.bundles.restoreLibraryPackage;let entered,release;const inside=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let hold=true;
  dst.bundles.restoreLibraryPackage=async(...args)=>{if(hold){entered();await gate;}return original(...args);};
  await dst.service.start({requestId:id,projectId:dst.p.id,revision:0},accepted.id);await inside;await dst.service.cancel(id,dst.p.id);hold=false;release();const stopped=await terminal(dst.service,id,dst.p.id);assert.equal(stopped.status,'cancelled');assert.equal((await dst.catalog.read()).libraries.length,1);
  const beforePlan=await readJson(path.join(dst.data,'jobs',id+'.json')),fresh=dst.reloadService();await fresh.recover();await fresh.resume(id,{projectId:dst.p.id,revision:0});const j=await terminal(fresh,id,dst.p.id);assert.equal(j.status,'completed',j.message);
  const afterPlan=await readJson(path.join(dst.data,'jobs',id+'.json'));assert.deepEqual(afterPlan.plan.assets,beforePlan.plan.assets);assert.deepEqual(afterPlan.plan.bundles,beforePlan.plan.bundles);assert.equal((await dst.catalog.read()).libraries.length,3);assert.equal(j.completedSteps,j.totalSteps);
});
test('目录在复制期间更新会阻止发布；明确继续原记录后保留新编辑',async()=>{
  const f=await libraryFixture({populated:true}),b=await backupFixture(f),dst=await libraryFixture(),accepted=await upload(dst,b.file),id=randomUUID();
  const original=dst.bundles.restoreLibraryPackage;let entered,release;const inside=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let hold=true;
  dst.bundles.restoreLibraryPackage=async(...args)=>{if(hold){entered();await gate;}return original(...args);};await dst.service.start({requestId:id,projectId:dst.p.id,revision:0},accepted.id);await inside;
  await dst.catalog.renameLibrary('default',{name:'用户的新名字',revision:0});hold=false;release();let j=await terminal(dst.service,id,dst.p.id);assert.equal(j.status,'interrupted');assert.match(j.message,/已更新/);assert.equal((await dst.catalog.read()).libraries.length,1);
  await dst.service.resume(id,{projectId:dst.p.id,revision:1});j=await terminal(dst.service,id,dst.p.id);assert.equal(j.status,'completed',j.message);assert.equal((await dst.catalog.read()).libraries[0].name,'用户的新名字');
});
test('目录发布后响应丢失与重启恢复不覆盖后来改名的库',async()=>{
  const f=await libraryFixture({populated:true}),b=await backupFixture(f),dst=await libraryFixture(),accepted=await upload(dst,b.file),j=await restore(dst,accepted);assert.equal(j.status,'completed',j.message);
  const state=await dst.catalog.read();await dst.catalog.renameLibrary(j.result.libraryIds[0],{name:'用户后来编辑的资料库',revision:state.revision});const record=await readJson(path.join(dst.data,'jobs',j.id+'.json'));record.status='running';delete record.result;await atomicJson(path.join(dst.data,'jobs',j.id+'.json'),record);
  const fresh=dst.reloadService();await fresh.recover();assert.equal((await fresh.get(j.id,dst.p.id)).status,'interrupted');await fresh.resume(j.id,{projectId:dst.p.id,revision:(await dst.catalog.read()).revision});const done=await terminal(fresh,j.id,dst.p.id);assert.equal(done.status,'completed');assert.equal(done.result.alreadyPublished,true);assert.equal((await dst.catalog.read()).libraries.find(l=>l.id===j.result.libraryIds[0]).name,'用户后来编辑的资料库');assert.equal((await dst.catalog.read()).libraries.length,3);
});
test('旧备份目录改变后不能复用原任务号重导；篡改已完成文件阻止下载',async()=>{
  const f=await libraryFixture({populated:true}),b=await backupFixture(f);const state=await f.catalog.read();await f.catalog.renameLibrary('default',{name:'新目录',revision:state.revision});
  const record=await readJson(path.join(f.data,'jobs',b.job.id+'.json'));record.status='interrupted';await atomicJson(path.join(f.data,'jobs',b.job.id+'.json'),record);await assert.rejects(f.service.resume(b.job.id,{projectId:f.p.id}),/创建新备份/);
  record.status='completed';await atomicJson(path.join(f.data,'jobs',b.job.id+'.json'),record);const h=await fs.open(b.file,'r+');try{await h.write(Buffer.from([0]),0,1,0);}finally{await h.close();}await assert.rejects(f.service.download(b.job.id),/校验失败/);
});
test('恢复中的媒体元数据被改动时不覆盖已有内容',async()=>{
  const f=await libraryFixture({populated:true}),b=await backupFixture(f),dst=await libraryFixture(),accepted=await upload(dst,b.file),id=randomUUID();
  const original=dst.bundles.restoreLibraryPackage;let entered,release;const inside=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let hold=true;
  dst.bundles.restoreLibraryPackage=async(...args)=>{if(hold){entered();await gate;}return original(...args);};await dst.service.start({requestId:id,projectId:dst.p.id,revision:0},accepted.id);await inside;await dst.service.cancel(id,dst.p.id);hold=false;release();await terminal(dst.service,id,dst.p.id);
  const job=await readJson(path.join(dst.data,'jobs',id+'.json')),assetId=Object.values(job.plan.assets)[0],meta=await loadAsset(dst.data,assetId);meta.name='用户改过，保留';await atomicJson(path.join(dst.data,'assets',assetId+'.json'),meta);await dst.service.resume(id,{projectId:dst.p.id,revision:0});const j=await terminal(dst.service,id,dst.p.id);assert.equal(j.status,'interrupted');assert.match(j.message,/已修改|占用/);assert.equal((await loadAsset(dst.data,assetId)).name,meta.name);assert.equal((await dst.catalog.read()).libraries.length,1);
});
test('工程归属、并行收藏与符号链接边界，不调用任何生成接口',async()=>{
  const f=await libraryFixture({populated:true}),b=await backupFixture(f),other=await libraryFixture();await assert.rejects(f.service.get(b.job.id,other.p.id),/项目不存在/);
  f.activeJobs.set('copy-running',{kind:'library-copy',projectId:f.p.id,controller:new AbortController()});const started=await f.service.start({requestId:randomUUID(),projectId:f.p.id,revision:(await f.catalog.read()).revision}),j=await terminal(f.service,started.id,f.p.id);assert.equal(j.status,'interrupted');assert.match(j.message,/收藏仍在运行/);f.activeJobs.delete('copy-running');
  const id=randomUUID(),state=await f.catalog.read(),original=state.libraries[0].folders[0].items[0].assetId,meta=await loadAsset(f.data,original);await fs.symlink(path.join(f.data,'assets',original),path.join(f.data,'assets',id));await atomicJson(path.join(f.data,'assets',id+'.json'),{...meta,id});state.libraries[0].folders[0].items[0].assetId=id;await atomicJson(path.join(f.data,'asset-catalog','catalog.json'),state);
  const linked=await f.service.start({requestId:randomUUID(),projectId:f.p.id,revision:state.revision}),bad=await terminal(f.service,linked.id,f.p.id);assert.equal(bad.status,'interrupted');assert.match(bad.message,/普通文件/);
});
test('图片编辑三输出与原图依赖随独立库恢复，保留可编辑操作关系',async()=>{
  const f=await libraryFixture(),a=await storeAsset(f.data,png,{name:'原图',type:'image/png'}),editId=randomUUID(),outputs={};
  for(const kind of ['image','mask','input']){const out=await storeAsset(f.data,png,{name:kind,type:'image/png'});Object.assign(out,{editId,editOutput:kind,sourceAssetId:a.id,operation:'image-edit',width:1,height:1});await atomicJson(path.join(f.data,'assets',out.id+'.json'),out);outputs[kind]=out.id;}
  await atomicJson(path.join(f.data,'image-edits',editId+'.json'),{id:editId,version:1,sourceAssetId:a.id,sourceWidth:1,sourceHeight:1,width:1,height:1,operations:[],outputs});const c=await f.catalog.read();c.libraries[0].folders[0].items.push({id:randomUUID(),name:'可编辑结果',kind:'media',assetId:outputs.image,archived:false});await atomicJson(path.join(f.data,'asset-catalog','catalog.json'),c);
  const b=await backupFixture(f);assert.equal(b.job.result.assets,4);assert.equal(b.job.result.imageEdits,1);const dst=await libraryFixture(),accepted=await upload(dst,b.file),j=await restore(dst,accepted);assert.equal(j.status,'completed',j.message);const after=await dst.catalog.read(),item=after.libraries.find(l=>j.result.libraryIds.includes(l.id)).folders[0].items[0],meta=await loadAsset(dst.data,item.assetId),edit=await readJson(path.join(dst.data,'image-edits',meta.editId+'.json'));assert.equal(edit.outputs.image,meta.id);assert.equal(edit.sourceAssetId,meta.sourceAssetId);assert.deepEqual(edit.operations,[]);
});
test('整库任务进度只显示实际完成单位，排队无虚假百分比',()=>{
  assert.equal(taskPresentation({id:'job',kind:'library-backup',status:'queued',completedSteps:0,totalSteps:8}).progress,null);
  const p=taskPresentation({id:'job',kind:'library-restore',status:'running',completedSteps:3,totalSteps:8});assert.equal(p.name,'素材库整库恢复');assert.deepEqual(p.progress,{value:3,total:8,unit:'步',ratio:3/8});
  assert.equal(taskPresentation({id:'job',kind:'library-restore',status:'running',completedSteps:20,totalSteps:8}).progress,null);
});
