import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {libraryFixture,backupFixture,terminal} from './helpers/library-backup-fixture.mjs';
import {LIBRARY_MAGIC,normalizeLibraryArchive} from '../lib/library-backups.mjs';
import {editingSrt} from '../public/editing-core.js';

function decode(bytes){const n=bytes.readUInt32BE(LIBRARY_MAGIC.length);return{manifest:JSON.parse(bytes.subarray(LIBRARY_MAGIC.length+4,LIBRARY_MAGIC.length+4+n)),body:bytes.subarray(LIBRARY_MAGIC.length+4+n)};}
function archive(manifest,body){const json=Buffer.from(JSON.stringify(manifest)),length=Buffer.alloc(4);length.writeUInt32BE(json.length);return Buffer.concat([LIBRARY_MAGIC,length,json,body]);}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function editedBackup(){
 const source=await libraryFixture({populated:true}),project=structuredClone(source.p);
 const image=project.assets.find(a=>a.type==='image/png'),audio=project.assets.find(a=>a.type==='audio/wav');
 project.shots=[{id:'edited-shot',title:'逐句字幕',description:'保留剪辑',duration:2,assetId:image.id,dialogue:'整句备用',edit:{fit:'cover',subtitleCues:[{start:0,end:.75,text:'先看见山'},{start:.8,end:2,text:'再听见水'}]}}];
 project.settings.edit={burnSubtitles:true,duckMusic:true,transition:{mode:'crossfade',seconds:.25},subtitle:{font:'PingFang SC',position:'top',color:'#ffeecc',outlineColor:'#102030',fontSize:40},music:[{id:'bg',assetId:audio.id,duration:2,volume:.2,loop:true}]};
 source.map.set(project.id,project);const state=await source.catalog.read();
 await source.catalog.addWorkflow({requestId:randomUUID(),kind:'canvas',name:'剪辑完整快照',revision:state.revision,libraryId:'default',folderId:'workflows',projectId:project.id,projectRevision:project.revision});
 return{source,project,backup:await backupFixture(source)};
}
test('剪辑37工程按整库5真实备份、跨空白工作区恢复与再次备份，字幕/转场/避让和原件保持',async()=>{
 const {source,project,backup}=await editedBackup(),bytes=await fs.readFile(backup.file),{manifest}=decode(bytes);
 assert.equal(manifest.version,5);assert.equal(manifest.bundles.filter(b=>b.projectFormatVersion===37).length,1);
 const destination=await libraryFixture({populated:true}),before=structuredClone(destination.p),catalogBefore=await destination.catalog.read();
 const accepted=await destination.service.upload(createReadStream(backup.file),{projectId:destination.p.id,requestId:randomUUID()});assert.equal(accepted.version,5);
 const started=await destination.service.start({projectId:destination.p.id,requestId:randomUUID(),revision:catalogBefore.revision},accepted.id),done=await terminal(destination.service,started.id,destination.p.id);assert.equal(done.status,'completed',done.message);
 const catalog=await destination.catalog.read();assert.deepEqual(catalog.libraries.slice(0,catalogBefore.libraries.length),catalogBefore.libraries);assert.deepEqual(destination.map.get(destination.p.id),before);
 const item=catalog.libraries.filter(l=>done.result.libraryIds.includes(l.id)).flatMap(l=>l.folders.flatMap(f=>f.items)).find(i=>i.name==='剪辑完整快照');
 assert.equal((await destination.bundles.previewLibraryPackage(item.bundleId)).formatVersion,37);
 const restored=await destination.catalog.reuseCanvas(item.id,{requestId:randomUUID()});
 assert.deepEqual(restored.shots[0].edit,project.shots[0].edit);assert.equal(editingSrt(restored),editingSrt(project));
 const settings=structuredClone(project.settings.edit);settings.music[0].assetId=restored.settings.edit.music[0].assetId;assert.deepEqual(restored.settings.edit,settings);assert.notEqual(settings.music[0].assetId,project.settings.edit.music[0].assetId);
 for(const old of project.assets){const next=restored.assets.find(a=>a.name===old.name);assert.equal(digest(await fs.readFile(path.join(source.data,'assets',old.id))),digest(await fs.readFile(path.join(destination.data,'assets',next.id))));}
 assert.equal(decode(await fs.readFile((await backupFixture(destination)).file)).manifest.version,5);
 assert.deepEqual(source.map.get(project.id),project);assert.equal(source.activeJobs.size,0);assert.equal(destination.activeJobs.size,0);
});
test('低版本整库不能伪装承载37工程；省略或伪造版本记录仍核对内部真实字节',async()=>{
 const {backup}=await editedBackup(),{manifest,body}=decode(await fs.readFile(backup.file)),destination=await libraryFixture(),before=await destination.catalog.read();
 for(const version of [1,2,3,4]){const m={...structuredClone(manifest),version};assert.throws(()=>normalizeLibraryArchive(m),/第5版/);}
 for(const advertised of [undefined,36]){const m=structuredClone(manifest);m.version=4;for(const b of m.bundles){if(advertised===undefined)delete b.projectFormatVersion;else if(b.projectFormatVersion===37)b.projectFormatVersion=advertised;}
  await assert.rejects(destination.service.upload(Readable.from(archive(m,body)),{projectId:destination.p.id,requestId:randomUUID()}),/第5版/);assert.deepEqual(await destination.catalog.read(),before);
 }
 const mismatch=structuredClone(manifest);mismatch.bundles.find(b=>b.projectFormatVersion===37).projectFormatVersion=36;
 await assert.rejects(destination.service.upload(Readable.from(archive(mismatch,body)),{projectId:destination.p.id,requestId:randomUUID()}),/版本与文件内容不一致/);
});
test('整库1至8的既有版本继续可读，未知未来版本拒绝',async()=>{
 const f=await libraryFixture({populated:true}),b=await backupFixture(f),{manifest}=decode(await fs.readFile(b.file));
 assert.equal(manifest.version,1);for(const version of [1,2,3,4,5,6,7,8])assert.equal(normalizeLibraryArchive({...manifest,version}).version,version);
 assert.throws(()=>normalizeLibraryArchive({...manifest,version:9}),/请选择/);
});
