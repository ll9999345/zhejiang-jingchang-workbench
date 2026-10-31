import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream,mkdtempSync,readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {publicMediaService,publicMediaEndpoint,publicMediaRecord,inspectPublicMediaSource,publicMediaProfiles} from '../lib/public-media.mjs';
import {arkAssetService} from '../lib/ark-assets.mjs';
import {makeProject} from '../lib/model.mjs';
import {storeAsset,atomicJson,readJson} from '../lib/workspace.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';

const bytes=Buffer.from('owned original video bytes with audio and no cloud request');
async function fixture(t,options={}){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-public-media-')),p=makeProject('公网素材'),activeJobs=new Map(),calls=[];let base,mode='normal';
 const mock=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);calls.push({url:req.url,headers:req.headers,body});
  if(mode==='drop')return req.socket.destroy();if(mode==='redirect'){res.statusCode=302;res.setHeader('location',base+'/follow');return res.end();}if(mode==='html')return res.end('<html>do-not-persist-secret</html>');if(mode==='signed')return res.end(base+'/video?signature=do-not-persist-secret');if(mode==='wrong-host')return res.end('https://wrong.example.test/video.mp4');if(mode==='large')return res.end('x'.repeat(9000));if(mode==='reject'){res.statusCode=400;return res.end('do-not-persist-secret');}if(mode==='server-error'){res.statusCode=503;return res.end('do-not-persist-secret');}
  if(req.url==='/'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({Result:{Id:'owned-ark-material'}}));}
  res.setHeader('content-type','text/plain');res.end(base+'/owned.mp4\n');
 });mock.listen(0,'127.0.0.1');await once(mock,'listening');base='http://127.0.0.1:'+mock.address().port;
 t.after(()=>new Promise(r=>{mock.closeAllConnections();mock.close(r);}));
 const projects={load:async id=>{if(id!==p.id)throw Error('project mismatch');return p;},save:async project=>{await atomicJson(path.join(data,'projects',project.id,'project.json'),project);return project;}};
 const asset=await storeAsset(data,bytes,{name:'私有原文件名.mp4',type:'video/mp4'});p.assets=[asset];await projects.save(p);
 const service=publicMediaService({data,projects,activeJobs,timeoutMs:1000,...options}),spec={projectId:p.id,purpose:'ark-material',assetId:asset.id,service:'temp',endpoint:base+'/upload'};
 async function request(input=spec,requestId='once'){const plan=await service.preview(input);return {...input,requestId,fingerprint:plan.fingerprint,consent:{fingerprint:plan.fingerprint,endpoint:plan.endpoint,service:plan.service,purpose:plan.purpose,retentionHours:72,requestLimit:1,publicScope:'anyone-with-url',sendOriginalMedia:true}};}
 async function done(r){for(let i=0;i<100;i++){if(!activeJobs.has(r.id))return service.get(r.id,p.id);await new Promise(r=>setTimeout(r,10));}throw Error('owned upload did not settle');}
 return {data,p,projects,activeJobs,calls,asset,service,spec,request,done,base,setMode:v=>mode=v};
}
test('两种官方上传地址固定，不能指定代理、私网、凭据或错误路径',()=>{
 assert.equal(publicMediaProfiles().length,2);assert.equal(publicMediaEndpoint('temp'),'https://temp.sh/upload');assert.equal(publicMediaEndpoint('litterbox'),'https://litterbox.catbox.moe/resources/internals/api.php');
 for(const [service,url] of [['auto','https://temp.sh/upload'],['temp','https://evil.example.test/upload'],['temp','http://192.168.1.1/upload'],['temp','http://127.0.0.1/wrong'],['temp','https://user:password@temp.sh/upload'],['temp','https://temp.sh/upload?api_key=x']])assert.throws(()=>publicMediaEndpoint(service,url));
});
test('本机预览绑定完整原文件内容；没有确认不创建记录或发送',async t=>{
 const f=await fixture(t),p=await f.service.preview(f.spec);assert.equal(p.source.size,bytes.length);assert.equal(p.source.name,f.asset.name);assert.equal(p.sendOriginalMedia,true);assert.equal(p.publicScope,'anyone-with-url');assert.equal(f.calls.length,0);assert.deepEqual(await f.service.list(f.p.id),[]);
 const r=await f.request();delete r.consent;await assert.rejects(f.service.start(r),/重新预览/);assert.equal(f.calls.length,0);assert.deepEqual(await f.service.list(f.p.id),[]);
});
test('目的地、用途、时限、公开范围和原文件均须与预览一致',async t=>{
 const f=await fixture(t);for(const [key,value] of [['endpoint',f.base+'/wrong'],['service','litterbox'],['purpose','generation-reference'],['retentionHours',24],['requestLimit',2],['publicScope','private'],['sendOriginalMedia',false],['fingerprint','0'.repeat(64)]]){const r=await f.request(f.spec,'bad-'+key);r.consent[key]=value;await assert.rejects(f.service.start(r),/确认|预览/);}
 assert.equal(f.calls.length,0);assert.deepEqual(await f.service.list(f.p.id),[]);
});
test('temp.sh multipart发送原字节和类型；隐去原文件名，双击与原编号重试仅发送一次',async t=>{
 const f=await fixture(t),request=await f.request(),[a,b]=await Promise.all([f.service.start(structuredClone(request)),f.service.start(structuredClone(request))]);assert.equal(a.id,b.id);const r=await f.done(a);assert.equal(r.status,'ready');assert.equal(r.bytesSent,bytes.length);assert.equal(r.retentionHours,72);assert.equal(r.availabilityUnverified,true);assert.equal(f.calls.length,1);
 const call=f.calls[0];assert.equal(call.url,'/upload');assert.match(call.headers['content-type'],/^multipart\/form-data; boundary=jc-/);assert.equal(Number(call.headers['content-length']),call.body.length);assert.equal(call.headers.authorization,undefined);assert.ok(call.body.includes(bytes));assert.match(call.body.toString(),/name="file"; filename="[\w-]+\.mp4"/);assert.match(call.body.toString(),/Content-Type: video\/mp4/);assert.equal(call.body.includes(Buffer.from(f.asset.name)),false);
 assert.equal((await f.service.start(request)).id,r.id);assert.equal(f.calls.length,1);await assert.rejects(f.service.start({...request,fingerprint:'0'.repeat(64)}),/另一发送范围/);
});
test('Litterbox按固定版本发送fileToUpload、reqtype及72h，失败不回退另一服务',async t=>{
 const f=await fixture(t),spec={...f.spec,service:'litterbox',endpoint:f.base+'/resources/internals/api.php'},r=await f.done(await f.service.start(await f.request(spec)));assert.equal(r.status,'ready');assert.equal(f.calls.length,1);const body=f.calls[0].body.toString();assert.match(body,/name="reqtype"\r\n\r\nfileupload/);assert.match(body,/name="time"\r\n\r\n72h/);assert.match(body,/name="fileToUpload"/);
});
test('断流、HTML、签名链接、错误主机、超大响应、重定向及5xx结果待确认，不自动再发',async t=>{
 const f=await fixture(t);for(const mode of ['drop','html','signed','wrong-host','large','redirect','server-error']){f.setMode(mode);const r=await f.done(await f.service.start(await f.request(f.spec,mode)));assert.equal(r.status,'uncertain',mode);assert.equal(r.url,undefined,mode);const before=f.calls.length;await f.service.start(await f.request(f.spec,mode));assert.equal(f.calls.length,before);assert.equal(JSON.stringify(r).includes('do-not-persist-secret'),false);}
 assert.equal(f.calls.length,7);assert.equal(f.calls.filter(c=>c.url==='/follow').length,0);
});
test('明确4xx保留拒绝记录；上传处理中阻止备份，重启只读取原记录',async t=>{
 const f=await fixture(t);f.setMode('reject');const r=await f.service.start(await f.request());assert.equal(f.activeJobs.has(r.id),true);const bundles=projectBundleService({data:f.data,projects:f.projects,activeJobs:f.activeJobs});await assert.rejects(bundles.exportBundle(f.p.id,f.p.revision),/任务运行/);const rejected=await f.done(r);assert.equal(rejected.status,'rejected');
 const raw=await readJson(path.join(f.data,'public-media',r.id+'.json'));raw.status='uploading';await atomicJson(path.join(f.data,'public-media',r.id+'.json'),raw);
 const recovered=publicMediaService({data:f.data,projects:f.projects,activeJobs:new Map()});assert.equal((await recovered.get(r.id,f.p.id)).status,'uncertain');assert.equal(f.calls.length,1);await assert.rejects(recovered.reference(r.id,f.p.id),/不能使用/);
});
test('完成写盘与活动任务移除之间读到旧上传快照，再读原记录返回成功而不重发',async t=>{
 const f=await fixture(t),r=await f.done(await f.service.start(await f.request())),file=path.join(f.data,'public-media',r.id+'.json'),original=fs.readFile;let stale=true;
 fs.readFile=async function(name,...args){const value=await original.call(this,name,...args);if(name===file&&stale){stale=false;const snapshot=JSON.parse(value);snapshot.status='uploading';return typeof value==='string'?JSON.stringify(snapshot):Buffer.from(JSON.stringify(snapshot));}return value;};
 try{const current=await f.service.get(r.id,f.p.id);assert.equal(current.status,'ready');assert.equal(current.bytesSent,bytes.length);assert.equal(f.calls.length,1);}finally{fs.readFile=original;}
});
test('原文件更改或符号链接不能绕过内容确认；非媒体不能上传',async t=>{
 const f=await fixture(t),r=await f.request();await fs.writeFile(path.join(f.data,'assets',f.asset.id),Buffer.from('changed bytes, different file'));await assert.rejects(f.service.start(r),/变化|重新预览/);assert.equal(f.calls.length,0);
 const other=await storeAsset(f.data,bytes,{name:'other.mp4',type:'video/mp4'}),linked=path.join(f.data,'assets','link-owned');await fs.symlink(path.join(f.data,'assets',other.id),linked);await atomicJson(linked+'.json',{...other,id:'link-owned'});await assert.rejects(inspectPublicMediaSource(f.data,'link-owned'),/符号链接/);
 const text=await storeAsset(f.data,Buffer.from('not media'),{name:'not media.txt',type:'text/plain'});await assert.rejects(f.service.preview({...f.spec,assetId:text.id}),/仅支持/);
});
test('预计到期后禁用记录引用；本机内容变化及跨项目不能借记录入库',async t=>{
 let clock=Date.now();const f=await fixture(t,{now:()=>clock}),r=await f.done(await f.service.start(await f.request()));assert.equal((await f.service.reference(r.id,f.p.id)).url,r.url);await assert.rejects(f.service.get(r.id,'another-project'),/不属于/);
 clock=Date.parse(r.expiresAt);assert.equal((await f.service.get(r.id,f.p.id)).status,'expired');await assert.rejects(f.service.reference(r.id,f.p.id),/过期/);clock=Date.now();await fs.writeFile(path.join(f.data,'assets',f.asset.id),Buffer.alloc(bytes.length,1));await assert.rejects(f.service.reference(r.id,f.p.id),/变化/);assert.equal(f.calls.length,1);
});
test('已上传的真实本机视频关联火山入库，内容或链接不匹配就停止',async t=>{
 const f=await fixture(t),dir=mkdtempSync(path.join(os.tmpdir(),'jc-owned-host-video-')),file=path.join(dir,'video.mp4');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:size=720x576:rate=24','-t','2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',file]);
 const asset=await storeAsset(f.data,readFileSync(file),{name:'owned valid.mp4',type:'video/mp4'}),uploaded=await f.done(await f.service.start(await f.request({...f.spec,assetId:asset.id}))),ark=arkAssetService({data:f.data,projects:f.projects,activeJobs:f.activeJobs,publicMedia:f.service});
 const spec={projectId:f.p.id,kind:'ark-material',endpoint:f.base,cloudProject:'default',name:'素材',groupId:'group-owned',assetType:'Video',sourceUrl:uploaded.url,localAssetId:asset.id,publicMediaId:uploaded.id},plan=await ark.preview(spec);assert.equal(plan.publicMediaId,uploaded.id);assert.equal(plan.localSource.sourceSha256,uploaded.source.sourceSha256);assert.equal(f.calls.length,1);
 await assert.rejects(ark.preview({...spec,sourceUrl:f.base+'/other.mp4'}),/不一致/);
});
test('v17备份保留上传记录与原文件，恢复新编号、原过期时限且不会联网上传',async t=>{
 const f=await fixture(t),r=await f.done(await f.service.start(await f.request())),bundles=projectBundleService({data:f.data,projects:f.projects,activeJobs:f.activeJobs}),pack=await bundles.exportBundle(f.p.id,f.p.revision),file=await bundles.download(pack.id);assert.equal(pack.formatVersion,17);assert.equal(pack.publicMedia,1);
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-host-restore-')),projects={load:async id=>readJson(path.join(data,'projects',id,'project.json')),save:async p=>{await atomicJson(path.join(data,'projects',p.id,'project.json'),p);return p;}},target=projectBundleService({data,projects,activeJobs:new Map()}),uploaded=await target.upload(createReadStream(file)),p=await target.importBundle(uploaded.id),service=publicMediaService({data,projects,activeJobs:new Map()}),rows=await service.list(p.id);assert.equal(rows.length,1);assert.notEqual(rows[0].id,r.id);assert.notEqual(rows[0].source.assetId,r.source.assetId);assert.equal(rows[0].url,r.url);assert.equal(rows[0].expiresAt,r.expiresAt);assert.equal(rows[0].restored,true);assert.equal(f.calls.length,1);assert.equal((await service.reference(rows[0].id,p.id)).availabilityUnverified,true);
 const bytes=await fs.readFile(file),magic=Buffer.from('JINGCHANG-PACK-1\n'),size=bytes.readUInt32BE(magic.length),m=JSON.parse(bytes.subarray(magic.length+4,magic.length+4+size));m.version=16;const json=Buffer.from(JSON.stringify(m)),length=Buffer.alloc(4);length.writeUInt32BE(json.length);await assert.rejects(target.upload(Readable.from([Buffer.concat([magic,length,json,bytes.subarray(magic.length+4+size)])])),/17版/);
 assert.throws(()=>publicMediaRecord({...r,url:'https://temp.sh/private?token=secret'}));
});
