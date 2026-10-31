import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {streamAssetService,streamMediaSize,checkMediaHeader} from '../lib/stream-assets.mjs';
import {MAX_STREAM_MEDIA_BYTES,fileMediaType} from '../public/media-transfer-core.js';
import {makeProject} from '../lib/model.mjs';
import {atomicJson,readJson,userError} from '../lib/workspace.mjs';
import {publicMediaProfiles,publicMediaService,publicMediaRecord} from '../lib/public-media.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {ownedLargeVideo,fileSha} from './helpers/owned-large-media.mjs';

const media=Buffer.alloc(128,1);media.writeUInt32BE(24);media.write('ftypisom',4);media.write('isom',16);
async function fixture(options={}){const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-stream-assets-')),p=makeProject('本机大文件'),activeJobs=new Map(),projects={load:async id=>{try{return await readJson(path.join(data,'projects',id,'project.json'));}catch(e){if(e.code==='ENOENT')throw userError('项目不存在',404);throw e;}},save:async p=>{await atomicJson(path.join(data,'projects',p.id,'project.json'),p);return p;}};await projects.save(p);const service=streamAssetService({data,projects,activeJobs,...options}),input={projectId:p.id,requestId:'owned-once',name:'原文件.mp4',type:'video/mp4',size:media.length};return {data,p,projects,activeJobs,service,input};}
const metadataFiles=async f=>(await fs.readdir(path.join(f.data,'assets')).catch(()=>[])).filter(x=>x.endsWith('.json'));
const header=(manifest)=>{const json=Buffer.from(JSON.stringify(manifest)),len=Buffer.alloc(4);len.writeUInt32BE(json.length);return Buffer.concat([Buffer.from('JINGCHANG-PACK-1\n'),len,json]);};
async function manifestFrom(file){const h=await fs.open(file,'r');try{const magic=Buffer.from('JINGCHANG-PACK-1\n'),head=Buffer.alloc(magic.length+4);await h.read(head,0,head.length,0);const size=head.readUInt32BE(magic.length),json=Buffer.alloc(size);await h.read(json,0,size,magic.length+4);return JSON.parse(json);}finally{await h.close();}}

test('4GB按十进制字节限制，并核对浏览器预告大小和实际请求长度',()=>{
 assert.equal(streamMediaSize('4000000000','4000000000'),MAX_STREAM_MEDIA_BYTES);assert.equal(publicMediaProfiles().find(p=>p.id==='temp').maxBytes,MAX_STREAM_MEDIA_BYTES);assert.equal(publicMediaProfiles().find(p=>p.id==='litterbox').maxBytes,150*1024*1024);
 for(const size of ['0','4000000001','4294967296','-1','1.5','Infinity','1e9','9007199254740992'])assert.throws(()=>streamMediaSize(size));assert.throws(()=>streamMediaSize('100','99'),/不一致/);assert.throws(()=>streamMediaSize(undefined));assert.equal(fileMediaType({name:'音频.m4a',type:''}),'audio/mp4');
});
test('媒体类型与容器头对应，HTML、SVG及伪装文件不能进入大文件素材库',()=>{
 assert.doesNotThrow(()=>checkMediaHeader(media,'video/mp4'));assert.doesNotThrow(()=>checkMediaHeader(Buffer.from([137,80,78,71,13,10,26,10]),'image/png'));assert.doesNotThrow(()=>checkMediaHeader(Buffer.from('RIFF0000WAVE'),'audio/wav'));assert.doesNotThrow(()=>checkMediaHeader(Buffer.from('OggSowned'),'audio/opus'));
 for(const type of ['image/png','video/mp4','audio/wav'])assert.throws(()=>checkMediaHeader(Buffer.from('<html><script>test</script></html>'),type),/文件头/);
});
test('任意分片按原字节导入，校验后返回素材；原始暂存与素材共享文件而不重复占空间',async()=>{
 const f=await fixture(),a=await f.service.importFile(Readable.from([media.subarray(0,3),media.subarray(3,17),media.subarray(17)]),f.input),record=await f.service.get(f.input.requestId,f.p.id);
 assert.equal(record.status,'completed');assert.equal(record.bytesReceived,media.length);assert.equal(a.sha256,createHash('sha256').update(media).digest('hex'));assert.deepEqual(await fs.readFile(path.join(f.data,'assets',a.id)),media);const source=await fs.stat(path.join(f.data,'asset-imports',f.input.requestId,'original.bin')),target=await fs.stat(path.join(f.data,'assets',a.id));assert.equal(source.ino,target.ino);assert.equal(f.activeJobs.size,0);assert.equal((await metadataFiles(f)).length,1);
});
test('丢失回复后按原导入编号读取和重复提交，只返回原素材，不重新读取正文',async()=>{
 const f=await fixture(),a=await f.service.importFile(Readable.from([media]),f.input);let read=false;async function* again(){read=true;yield media;}
 assert.equal((await f.service.importFile(again(),f.input)).id,a.id);assert.equal(read,false);assert.equal((await f.service.get('owned-once',f.p.id)).asset.id,a.id);assert.equal((await metadataFiles(f)).length,1);await assert.rejects(f.service.importFile(Readable.from([media]),{...f.input,name:'another.mp4'}),/另一文件/);
});
test('传输不足、超过预告或中途报错，保留部分原文件且不产生可用素材',async()=>{
 for(const mode of ['short','long','throw']){const f=await fixture();async function* body(){yield media.subarray(0,64);if(mode==='long')yield Buffer.alloc(media.length);if(mode==='throw')throw Error('synthetic internal detail');}
  await assert.rejects(f.service.importFile(body(),f.input));assert.deepEqual(await metadataFiles(f),[]);const r=await f.service.get('owned-once',f.p.id);assert.equal(r.status,'incomplete');assert.equal(r.bytesReceived,64);assert.equal(JSON.stringify(r).includes('synthetic internal detail'),false);const original=await fs.readFile(path.join(f.data,'asset-imports','owned-once','original.bin'));assert.equal(original.length,64);await assert.rejects(f.service.importFile(Readable.from([media]),f.input),/新编号/);assert.deepEqual(await fs.readFile(path.join(f.data,'asset-imports','owned-once','original.bin')),original);assert.equal(f.activeJobs.size,0);
 }
});
test('格式不匹配、非媒体、容量和空间不足在加入素材库前拒绝',async()=>{
 const f=await fixture({maxBytes:media.length});await assert.rejects(f.service.importFile(Readable.from([media]),{...f.input,type:'text/plain'}),/格式/);await assert.rejects(f.service.importFile(Readable.from([media]),{...f.input,size:media.length+1}),/容量/);await assert.rejects(f.service.importFile(Readable.from([Buffer.alloc(media.length)]),f.input),/文件头/);assert.deepEqual(await metadataFiles(f),[]);
 const disk=await fixture({diskInfo:async()=>({bavail:0,bsize:4096})});await assert.rejects(disk.service.importFile(Readable.from([media]),disk.input),e=>e.status===507);assert.deepEqual(await fs.readdir(path.join(disk.data,'asset-imports')),[]);
});
test('素材目录、导入目录符号链接及跨项目读取不能绕过普通文件约束',async()=>{
 const f=await fixture(),outside=await fs.mkdtemp(path.join(os.tmpdir(),'jc-stream-outside-'));await fs.symlink(outside,path.join(f.data,'assets'));await assert.rejects(f.service.importFile(Readable.from([media]),f.input),/符号链接/);assert.deepEqual(await fs.readdir(outside),[]);
 const g=await fixture();await g.service.importFile(Readable.from([media]),g.input);const other=makeProject('另一项目');await g.projects.save(other);await assert.rejects(g.service.get('owned-once',other.id),/不属于/);await assert.rejects(g.service.get('../escape',g.p.id),/编号/);
});
test('导入进行中可读接收进度，阻止项目备份；重启后只显示中断状态',async()=>{
 const f=await fixture();let release;const gate=new Promise(r=>release=r);async function* body(){yield media.subarray(0,64);await gate;yield media.subarray(64);}
 const work=f.service.importFile(body(),f.input);try{let r;for(let i=0;i<100;i++){try{r=await f.service.get('owned-once',f.p.id);if(r.bytesReceived===64)break;}catch{}await new Promise(r=>setTimeout(r,5));}assert.equal(r.status,'importing');assert.equal(r.bytesReceived,64);await assert.rejects(projectBundleService(f).exportBundle(f.p.id,0),/任务运行/);const restarted=streamAssetService({...f,activeJobs:new Map()});assert.equal((await restarted.get('owned-once',f.p.id)).status,'interrupted');}finally{release();await work;}
 assert.equal(f.activeJobs.size,0);
});
test('原工作区普通文件被替换或索引不一致时，完成记录不能恢复为可用素材',async()=>{
 const f=await fixture(),a=await f.service.importFile(Readable.from([media]),f.input);await atomicJson(path.join(f.data,'assets',a.id+'.json'),{...a,size:a.size-1});await assert.rejects(f.service.get('owned-once',f.p.id),/不一致/);
});
test('读到完成前的旧本机导入记录时，再读已完成记录，不误报中断或重新接收',async()=>{
 const f=await fixture(),a=await f.service.importFile(Readable.from([media]),f.input),file=path.join(f.data,'asset-imports','owned-once','record.json'),original=fs.readFile;let stale=true;
 fs.readFile=async function(name,...args){const value=await original.call(this,name,...args);if(name===file&&stale){stale=false;const snapshot=JSON.parse(value);snapshot.status='importing';return typeof value==='string'?JSON.stringify(snapshot):Buffer.from(JSON.stringify(snapshot));}return value;};
 try{const r=await f.service.get('owned-once',f.p.id);assert.equal(r.status,'completed');assert.equal(r.asset.id,a.id);assert.equal((await metadataFiles(f)).length,1);}finally{fs.readFile=original;}
});
test('超过150MiB的实际可播放视频能完整导入、用v18备份恢复，旧格式与非媒体不能借此扩容',async()=>{
 const f=await fixture(),owned=await ownedLargeVideo(path.join(f.data,'fixture'),152*1024*1024),a=await f.service.importFile(createReadStream(owned.file),{...f.input,size:owned.size});f.p.assets=[a];f.p.nodes[0].type='video';f.p.nodes[0].assetId=a.id;await f.projects.save(f.p);assert.equal(a.sha256,await fileSha(owned.file));
 const hosts=publicMediaService(f);await assert.rejects(hosts.preview({projectId:f.p.id,assetId:a.id,purpose:'generation-reference',service:'litterbox'}),/容量/);
 const source=projectBundleService(f),pack=await source.exportBundle(f.p.id,0),file=await source.download(pack.id);assert.equal(pack.formatVersion,18);const target=await fixture(),bundle=projectBundleService(target),preview=await bundle.upload(createReadStream(file)),p=await bundle.importBundle(preview.id);assert.equal(p.assets[0].size,owned.size);assert.notEqual(p.assets[0].id,a.id);assert.equal(await fileSha(path.join(target.data,'assets',p.assets[0].id)),a.sha256);assert.equal((await bundle.importBundle(preview.id)).id,p.id);
 const m=await manifestFrom(file);for(const version of [1,16,17])await assert.rejects(bundle.upload(Readable.from([header({...m,version})])),/第18版/);const nonmedia=structuredClone(m);nonmedia.assets[0].type='text/plain';await assert.rejects(bundle.upload(Readable.from([header(nonmedia)])),/素材记录/);const over=structuredClone(m);over.assets[0].size=MAX_STREAM_MEDIA_BYTES+1;await assert.rejects(bundle.upload(Readable.from([header(over)])),/素材记录/);
});
test('v18仍拒绝超过4GiB的总量；旧格式不能混入新增大文件托管记录',async()=>{
 const f=await fixture(),p=f.p,a={id:'owned-asset',name:'large.mp4',type:'video/mp4',size:MAX_STREAM_MEDIA_BYTES,sha256:'a'.repeat(64)},m={format:'jingchang-bundle',version:18,project:p,assets:[a,{...a,id:'another',size:400_000_000}],workflows:[],cloudWorkflows:[],studios:[],conversations:[]};await assert.rejects(projectBundleService(f).upload(Readable.from([header(m)])),/4GiB/);
 const r={id:'receipt',requestId:'req',status:'ready',purpose:'generation-reference',service:'temp',endpoint:'https://temp.sh/upload',requestCount:1,fingerprint:'b'.repeat(64),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),bytesSent:MAX_STREAM_MEDIA_BYTES,url:'https://temp.sh/owned.mp4',source:{assetId:a.id,name:a.name,type:a.type,size:a.size,sourceSha256:a.sha256}};assert.equal(publicMediaRecord(r).source.size,MAX_STREAM_MEDIA_BYTES);assert.throws(()=>publicMediaRecord({...r,service:'litterbox',endpoint:'https://litterbox.catbox.moe/resources/internals/api.php',url:'https://litter.catbox.moe/owned.mp4'}),/容量/);
});
