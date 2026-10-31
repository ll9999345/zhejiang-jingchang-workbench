import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {nativeBranchFixture} from './helpers/native-branch-fixture.mjs';
import {libraryFixture,backupFixture,terminal} from './helpers/library-backup-fixture.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {normalizeLibraryArchive,LIBRARY_MAGIC} from '../lib/library-backups.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';
import {waitLoop,idleLoop} from './helpers/native-loop-fixture.mjs';

function rewrite(bytes,magic,change) {
 const offset=magic.length,size=bytes.readUInt32BE(offset),manifest=JSON.parse(bytes.subarray(offset+4,offset+4+size));change(manifest);
 const json=Buffer.from(JSON.stringify(manifest)),length=Buffer.alloc(4);length.writeUInt32BE(json.length);
 return Buffer.concat([bytes.subarray(0,offset),length,json,bytes.subarray(offset+4+size)]);
}
const bundleMagic=Buffer.from('JINGCHANG-PACK-1\n');
const decode=(b,magic)=>JSON.parse(b.subarray(magic.length+4,magic.length+4+b.readUInt32BE(magic.length)));

test('第36版跨工作区恢复智能分支设置、坐标和模板，当前工程不被覆盖且恢复不执行',async t=>{
 const f=await nativeBranchFixture(t,{count:2,tails:false}),bundles=projectBundleService({...f,projects:{load:async()=>f.project}}),dst=await libraryFixture(),before=structuredClone(dst.p),out=await bundles.exportBundle(f.project.id,0);
 assert.equal(out.formatVersion,36);const preview=await dst.bundles.upload(createReadStream(await bundles.download(out.id))),p=await dst.bundles.importBundle(preview.id),loop=p.nodes.find(node=>node.params.nativeBranch);
 assert.deepEqual(loop.params.nativeBranch,{version:1,enabled:true});assert.deepEqual(p.nodes.map(node=>[node.title,node.x,node.y]),f.project.nodes.map(node=>[node.title,node.x,node.y]));assert.deepEqual(dst.map.get(dst.p.id),before);assert.equal(dst.activeJobs.size,0);
 const runner=canvasRunner({data:dst.data,activeJobs:dst.activeJobs,generation:dst.generation,pollInterval:10}),plan=await runner.plan(p);assert.equal(plan.length,4);assert.equal(f.state.prompts.length,0);
 const job=await runner.start(p,{revision:p.revision,requestId:randomUUID(),consent:true},f.pool[0]),done=await waitLoop(dst,job.id);await idleLoop(dst);assert.equal(done.status,'completed',done.message);assert.equal(f.state.prompts.length,4);
});
test('分支工程拒绝伪装第35版；已关闭策略仍携带新格式且旧原生循环继续兼容',async t=>{
 const f=await nativeBranchFixture(t,{enabled:false}),bundles=projectBundleService({...f,projects:{load:async()=>f.project}}),out=await bundles.exportBundle(f.project.id,0),bytes=await fs.readFile(await bundles.download(out.id)),dst=await libraryFixture();
 assert.equal(out.formatVersion,36);for(const version of [31,34,35])await assert.rejects(dst.bundles.upload(Readable.from(rewrite(bytes,bundleMagic,m=>m.version=version))),/第36版/);
 const old=rewrite(bytes,bundleMagic,m=>{m.version=31;delete m.project.nodes.find(node=>node.params.nativeBranch).params.nativeBranch;});const accepted=await dst.bundles.upload(Readable.from(old));assert.equal(accepted.formatVersion,31);assert.equal(f.state.prompts.length,0);
});
test('整库第4版保留完整工程与子图分支策略，降级清单和缺失版本声明均拒绝',async t=>{
 const f=await nativeBranchFixture(t,{count:2,tails:false}),src=await libraryFixture(),dst=await libraryFixture(),p=structuredClone(f.project),oldCurrent=structuredClone(dst.p);
 const old=await f.generation.template(f.root.params.workflowBinding.workflowId),w=await src.generation.saveTemplate({name:old.name,workflow:old.workflow,fields:old.fields});
 for(const node of p.nodes)if(node.params.workflowBinding)node.params.workflowBinding.workflowId=w.id;
 src.map.set(p.id,p);
 for(const kind of ['canvas','canvas-fragment'])await src.catalog.addWorkflow({requestId:randomUUID(),kind,name:'智能分支-'+kind,revision:(await src.catalog.read()).revision,libraryId:'default',folderId:'workflows',projectId:p.id,projectRevision:0,...(kind==='canvas-fragment'?{nodeIds:p.nodes.map(node=>node.id)}:{})});
 const b=await backupFixture(src),bytes=await fs.readFile(b.file),m=decode(bytes,LIBRARY_MAGIC);assert.equal(m.version,4);assert.deepEqual(m.bundles.map(bundle=>bundle.projectFormatVersion),[36,36]);assert.throws(()=>normalizeLibraryArchive({...m,version:3}),/第4版/);
 const before=await dst.catalog.read();await assert.rejects(dst.service.upload(Readable.from(rewrite(bytes,LIBRARY_MAGIC,m=>{m.version=3;for(const bundle of m.bundles)delete bundle.projectFormatVersion;})),{requestId:randomUUID(),projectId:dst.p.id}),/第4版/);assert.deepEqual(await dst.catalog.read(),before);
 const accepted=await dst.service.upload(createReadStream(b.file),{requestId:randomUUID(),projectId:dst.p.id}),job=await dst.service.start({requestId:randomUUID(),projectId:dst.p.id,revision:0},accepted.id),done=await terminal(dst.service,job.id,dst.p.id);assert.equal(done.status,'completed',done.message);assert.deepEqual(dst.map.get(dst.p.id),oldCurrent);
 const entries=(await dst.catalog.read()).libraries.flatMap(l=>l.folders.flatMap(folder=>folder.items));
 for(const entry of entries.filter(entry=>['canvas','canvas-fragment'].includes(entry.kind)))assert.equal((await dst.bundles.previewLibraryPackage(entry.bundleId)).formatVersion,36);
 const restored=await dst.catalog.reuseCanvas(entries.find(entry=>entry.kind==='canvas').id,{requestId:randomUUID()});assert.deepEqual(restored.nodes.find(node=>node.params.nativeBranch).params.nativeBranch,{version:1,enabled:true});assert.deepEqual(restored.runs,[]);assert.equal(f.state.prompts.length,0);
});
