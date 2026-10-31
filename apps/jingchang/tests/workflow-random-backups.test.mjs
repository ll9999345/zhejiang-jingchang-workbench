import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {libraryFixture,backupFixture,terminal} from './helpers/library-backup-fixture.mjs';
import {workflow,fields} from './helpers/workflow-random-fixture.mjs';
import {normalizeLibraryArchive,LIBRARY_MAGIC} from '../lib/library-backups.mjs';
import {makeNode} from '../lib/model.mjs';
const decode=b=>JSON.parse(b.subarray(LIBRARY_MAGIC.length+4,LIBRARY_MAGIC.length+4+b.readUInt32BE(LIBRARY_MAGIC.length)).toString());
function encode(m,body){const json=Buffer.from(JSON.stringify(m)),length=Buffer.alloc(4);length.writeUInt32BE(json.length);return Buffer.concat([LIBRARY_MAGIC,length,json,body]);}
async function addRandom(f,{templateOnly=false}={}){
 const w=await f.generation.saveTemplate({name:'随机字段模板',workflow,fields}),state=await f.catalog.read();await f.catalog.addWorkflow({requestId:randomUUID(),kind:'comfy',name:'随机模板原件',revision:state.revision,libraryId:'default',folderId:'workflows',workflowId:w.id});
 if(templateOnly)return w;
 const node=makeNode('image',100,100,{params:{workflowBinding:{workflowId:w.id,overrides:[],imageSources:[],count:2,randomFields:[{nodeId:'1',name:'seed'}]}}});f.p.nodes=[node];f.map.set(f.p.id,f.p);
 for(const kind of ['canvas','canvas-fragment']){const state=await f.catalog.read();await f.catalog.addWorkflow({requestId:randomUUID(),kind,name:'随机-'+kind,revision:state.revision,libraryId:'default',folderId:'workflows',projectId:f.p.id,projectRevision:0,...(kind==='canvas-fragment'?{nodeIds:[node.id]}:{})});}return w;
}
test('模板单独收藏采用第2版整库，跨工作区保留数字随机及原范围；旧模板仍第1版',async()=>{
 const src=await libraryFixture(),dst=await libraryFixture(),legacy=await backupFixture(dst);assert.equal(decode(await fs.readFile(legacy.file)).version,1);await addRandom(src,{templateOnly:true});const b=await backupFixture(src),m=decode(await fs.readFile(b.file));assert.equal(m.version,2);assert.equal(m.workflows[0].fields[0].randomEnabled,true);assert.throws(()=>normalizeLibraryArchive({...m,version:1}),/第2版/);
 const accepted=await dst.service.upload(createReadStream(b.file),{requestId:randomUUID(),projectId:dst.p.id}),j=await dst.service.start({requestId:randomUUID(),projectId:dst.p.id,revision:0},accepted.id),done=await terminal(dst.service,j.id,dst.p.id);assert.equal(done.status,'completed',done.message);const item=(await dst.catalog.read()).libraries.flatMap(l=>l.folders.flatMap(f=>f.items)).find(i=>i.name==='随机模板原件'),w=await dst.generation.template(item.workflowId);assert.deepEqual(w.fields,m.workflows[0].fields);assert.equal(dst.map.get(dst.p.id).nodes[0].params.workflowBinding,undefined);assert.equal(dst.activeJobs.size,0);
});
test('第34版工程与子图均可嵌入第2版整库；恢复、复用保留逐节点选择',async()=>{
 const src=await libraryFixture(),dst=await libraryFixture(),before=structuredClone(dst.p);await addRandom(src);const b=await backupFixture(src),m=decode(await fs.readFile(b.file));assert.equal(m.version,2);assert.deepEqual(m.bundles.map(b=>b.projectFormatVersion),[34,34]);
 const accepted=await dst.service.upload(createReadStream(b.file),{requestId:randomUUID(),projectId:dst.p.id}),j=await dst.service.start({requestId:randomUUID(),projectId:dst.p.id,revision:0},accepted.id);assert.equal((await terminal(dst.service,j.id,dst.p.id)).status,'completed');const items=(await dst.catalog.read()).libraries.flatMap(l=>l.folders.flatMap(f=>f.items));for(const item of items.filter(i=>i.name.startsWith('随机-'))){assert.equal((await dst.bundles.previewLibraryPackage(item.bundleId)).formatVersion,34);}const p=await dst.catalog.reuseCanvas(items.find(i=>i.name==='随机-canvas').id,{requestId:randomUUID()});assert.deepEqual(p.nodes[0].params.workflowBinding.randomFields,[{nodeId:'1',name:'seed'}]);assert.notEqual(p.nodes[0].params.workflowBinding.workflowId,src.p.nodes[0].params.workflowBinding.workflowId);assert.deepEqual(dst.map.get(dst.p.id),before);
});
test('整库降级及画布格式标签篡改都在发布目录前拒绝；不覆盖现有条目',async()=>{
 const src=await libraryFixture(),dst=await libraryFixture();await addRandom(src);const b=await backupFixture(src),bytes=await fs.readFile(b.file),m=decode(bytes),body=bytes.subarray(LIBRARY_MAGIC.length+4+bytes.readUInt32BE(LIBRARY_MAGIC.length)),before=await dst.catalog.read();
 for(const value of [{...m,version:1},{...m,bundles:m.bundles.map(b=>({...b,projectFormatVersion:33}))}])await assert.rejects(dst.service.upload(Readable.from(encode(value,body)),{requestId:randomUUID(),projectId:dst.p.id}),/第2版|版本与文件内容/);
 const withoutTemplate={...m,version:1,workflows:[],bundles:m.bundles.map(({projectFormatVersion,...b})=>b),catalog:{...m.catalog,libraries:m.catalog.libraries.map(l=>({...l,folders:l.folders.map(f=>({...f,items:f.items.filter(i=>i.kind!=='comfy')}))}))}};await assert.rejects(dst.service.upload(Readable.from(encode(withoutTemplate,body)),{requestId:randomUUID(),projectId:dst.p.id}),/第2版/);assert.deepEqual(await dst.catalog.read(),before);
});
test('第34版拒绝降级标识；第1至33版没有新字段时继续兼容',async()=>{
 const f=await libraryFixture(),w=await addRandom(f),base={format:'jingchang-bundle',version:34,project:f.p,assets:[],workflows:[{...w,id:w.id}],cloudWorkflows:[],studios:[],conversations:[],imageEdits:[]};const magic=Buffer.from('JINGCHANG-PACK-1\n'),pack=m=>{const json=Buffer.from(JSON.stringify(m)),length=Buffer.alloc(4);length.writeUInt32BE(json.length);return Buffer.concat([magic,length,json]);};assert.equal((await f.bundles.upload(Readable.from(pack(base)))).formatVersion,34);for(const version of [1,23,32,33])await assert.rejects(f.bundles.upload(Readable.from(pack({...base,version}))),/第34版/);
 const p=structuredClone(f.p);delete p.nodes[0].params.workflowBinding;for(let version=1;version<=33;version++)assert.equal((await f.bundles.upload(Readable.from(pack({...base,version,project:p,workflows:[]})))).formatVersion,version);
});
