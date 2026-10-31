import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream,mkdtempSync,readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {arkAssetService,arkAssetEndpoint,signArkAssetRequest,inspectArkAssetSource,arkMaterialRecord} from '../lib/ark-assets.mjs';
import {makeProject} from '../lib/model.mjs';
import {storeAsset,atomicJson,readJson} from '../lib/workspace.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';

const ak='SYNTHETICARKACCESS082',sk='synthetic-local-ark-secret-082';
const sha=b=>createHash('sha256').update(b).digest('hex');
const video=(size='720x576',rate=24,duration=2)=>{const file=path.join(mkdtempSync(path.join(os.tmpdir(),'jc-synthetic-mp4-')),'video.mp4');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i',`color=c=blue:size=${size}:rate=${rate}`,'-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t',String(duration),'-c:v','libx264','-preset','ultrafast','-c:a','aac','-pix_fmt','yuv420p','-movflags','+faststart',file]);return readFileSync(file);};
const clip=video();
async function fixture(t,options={}){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-ark-assets-')),project=makeProject('素材库'),activeJobs=new Map(),calls=[];let base,status='Processing',mode='normal';
 const mock=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const action=new URL(req.url,'http://localhost').searchParams.get('Action');calls.push({action,body:chunks.length?JSON.parse(Buffer.concat(chunks)):null,headers:req.headers,url:req.url});res.setHeader('content-type','application/json');
  if(mode==='drop')return req.socket.destroy();if(mode==='html'){res.setHeader('content-type','text/html');return res.end('<html>'+ak+sk+'</html>');}if(mode==='redirect'){res.statusCode=302;res.setHeader('Location','https://untrusted.example.test/?'+sk);return res.end();}if(mode==='reject'){res.statusCode=400;return res.end(JSON.stringify({ResponseMetadata:{Error:{Message:sk}}}));}
  let result;if(action==='CreateAssetGroup')result={Id:'group-owned'};if(action==='CreateAsset')result={Id:'asset-owned'};
  if(action==='GetAsset')result={Id:'asset-owned',GroupId:'group-owned',Name:'视频',ProjectName:'default',AssetType:'Video',Status:status,URL:'https://untrusted.example.test/signed?X-Amz-Signature='+sk,Error:{Message:ak+sk}};
  if(action==='ListAssetGroups')result={Items:[{Id:'group-owned',Name:'合成素材组',GroupType:'AIGC',ProjectName:'default',Description:sk}],TotalCount:1};
  if(action==='ListAssets')result={Items:[{Id:'asset-owned',GroupId:'group-owned',Name:'视频',AssetType:'Video',ProjectName:'default',Status:status,URL:'https://untrusted.example.test/signed?X-Amz-Signature='+sk}],TotalCount:21};
  if(!result){res.statusCode=404;return res.end('{}');}res.end(JSON.stringify({ResponseMetadata:{},Result:result}));
 });mock.listen(0,'127.0.0.1');await once(mock,'listening');base='http://127.0.0.1:'+mock.address().port;t.after(()=>new Promise(r=>{mock.closeAllConnections();mock.close(r);}));
 const projects={load:async id=>{if(id!==project.id)throw Error('wrong project');return project;},save:async p=>{await atomicJson(path.join(data,'projects',p.id,'project.json'),p);return p;}};
 const service=arkAssetService({data,projects,activeJobs,...options});const asset=await storeAsset(data,clip,{type:'video/mp4',name:'本机合成.mp4'});project.assets=[asset];await projects.save(project);
 const spec={projectId:project.id,endpoint:base,cloudProject:'default',kind:'ark-material',name:'视频',assetType:'Video',groupId:'group-owned',sourceUrl:base+'/owned.mp4',localAssetId:asset.id};
 const credentials=()=>({accessKeyId:ak,secretAccessKey:sk});
 const consent=action=>({endpoint:base,cloudProject:'default',action,sendCredentials:true,requestLimit:1});
 async function request(input=spec,requestId='once'){const preview=await service.preview(input);return{...input,...credentials(),fingerprint:preview.fingerprint,requestId,consent:{...consent(input.kind==='ark-group'?'CreateAssetGroup':'CreateAsset'),fingerprint:preview.fingerprint,consoleAuthorizationAccepted:true,sendPublicUrl:true,sendOriginalMedia:true}};}
 return{data,project,projects,activeJobs,service,calls,base,asset,spec,credentials,consent,request,setStatus:v=>status=v,setMode:v=>mode=v};
}
async function noSecrets(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await noSecrets(p);else{const bytes=await fs.readFile(p);for(const value of [ak,sk,'X-Amz-Signature'])assert.equal(bytes.includes(Buffer.from(value)),false,p);}}}

test('AK/SK V4 固定多字节向量及目的地限制',()=>{
 const s=signArkAssetRequest({action:'CreateAssetGroup',body:{Name:'测试素材组',Description:'本机合成素材',GroupType:'AIGC',ProjectName:'default'},accessKeyId:ak,secretAccessKey:sk,date:new Date('2026-09-30T01:02:03Z')});
 assert.equal(s.headers['X-Content-Sha256'],'81748d22fb591ef73370fb34dc26786902befbcf2800e667af99ae1ed02353e2');assert.equal(s.headers['X-Date'],'20260930T010203Z');assert.ok(s.headers.Authorization.endsWith('Signature=993bbedb1b4b6ef1c0835430f52bc3485010239ec10f6bfbf6d405ddc538f5b8'));assert.ok(!JSON.stringify(s).includes(sk));
 for(const url of ['https://proxy.example.test','https://ark.cn-beijing.volcengineapi.com/api/v3','http://192.168.1.1','https://127.0.0.1','https://ark.cn-beijing.volcengineapi.com/?key=value'])assert.throws(()=>arkAssetEndpoint(url));
 assert.throws(()=>signArkAssetRequest({action:'DeleteAsset',body:{},accessKeyId:ak,secretAccessKey:sk}));
});
test('本机视频预览检查原文件与声音，不上传或创建记录；独立授权与指纹必需',async t=>{
 const f=await fixture(t),p=await f.service.preview(f.spec);assert.equal(f.calls.length,0);assert.equal((await f.service.list(f.project.id)).length,0);assert.equal(p.localSource.duration,2);assert.equal(p.localSource.width,720);assert.equal(p.localSource.height,576);assert.equal(p.localSource.fps,24);assert.equal(p.localSource.hasAudio,true);assert.equal(p.localSource.sourceSha256,sha(clip));assert.ok(p.publicFileUnverified);assert.ok(p.sendOriginalMedia);
 const b=await f.request();await assert.rejects(f.service.create({...b,fingerprint:'changed'}),/变化/);await assert.rejects(f.service.create({...b,consent:{...b.consent,sendOriginalMedia:false}}),/原有声音/);await assert.rejects(f.service.create({...b,consent:{...b.consent,consoleAuthorizationAccepted:false}}),/授权函/);assert.equal(f.calls.length,0);assert.equal((await f.service.list(f.project.id)).length,0);
 await assert.rejects(f.service.preview({...f.spec,endpoint:undefined,sourceUrl:f.spec.sourceUrl}),/公网/);await assert.rejects(f.service.preview({...f.spec,sourceUrl:'https://public.example.test/file?token=abc'}));
});
test('素材组单次创建、并发去重，元数据含本次凭据时在写入前拒绝',async t=>{
 const f=await fixture(t),input={...f.spec,kind:'ark-group',name:'合成素材组',description:'本机素材'},b=await f.request(input);
 const [a,c]=await Promise.all([f.service.create(structuredClone(b)),f.service.create(structuredClone(b))]);assert.equal(a.id,c.id);assert.equal(a.status,'Created');assert.equal(a.cloudId,'group-owned');assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body,{Name:'合成素材组',Description:'本机素材',GroupType:'AIGC',ProjectName:'default'});assert.ok(!f.calls[0].headers.authorization.includes(sk));
 await assert.rejects(f.service.create(await f.request({...input,name:ak},'key-name')),/凭据/);await assert.rejects(f.service.create(await f.request(input,ak)),/凭据/);assert.equal(f.calls.length,1);await noSecrets(f.data);
});
test('素材入库只提交URL，重建后按原编号检查Processing/Active/Failed，不重新提交',async t=>{
 const f=await fixture(t),r=await f.service.create(await f.request());assert.equal(r.status,'Processing');assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body,{GroupId:'group-owned',URL:f.spec.sourceUrl,Name:'视频',AssetType:'Video',ProjectName:'default'});assert.ok(!JSON.stringify(f.calls[0].body).includes('base64'));
 const restored=arkAssetService({data:f.data,projects:f.projects,activeJobs:f.activeJobs});f.setStatus('Active');const active=await restored.refresh(r.id,{projectId:f.project.id,...f.credentials(),consent:f.consent('GetAsset')});assert.equal(active.status,'Active');assert.equal(active.cloudId,'asset-owned');assert.ok(!JSON.stringify(active).includes('X-Amz'));f.setStatus('Failed');assert.equal((await restored.refresh(r.id,{projectId:f.project.id,...f.credentials(),consent:f.consent('GetAsset')})).status,'Failed');assert.equal(f.calls.filter(x=>x.action==='CreateAsset').length,1);assert.equal(f.calls.filter(x=>x.action==='GetAsset').length,2);await noSecrets(f.data);
});
test('平台分页、AIGC列表与本机选取，不读取签名URL，重复选择更新状态',async t=>{
 const f=await fixture(t),browse=action=>f.service.browse({projectId:f.project.id,endpoint:f.base,cloudProject:'default',action,pageNumber:2,...f.credentials(),consent:f.consent(action)});
 const groups=await browse('ListAssetGroups');const g=await f.service.remember({projectId:f.project.id,selectionId:groups.items[0].selectionId});assert.equal(g.kind,'ark-group');assert.equal(g.cloudId,'group-owned');assert.equal(groups.pageNumber,2);assert.deepEqual(f.calls[0].body,{Filter:{GroupType:'AIGC'},ProjectName:'default',PageNumber:2,PageSize:20});
 f.setStatus('Active');const page=await browse('ListAssets');assert.equal(page.totalCount,21);assert.ok(!JSON.stringify(page).includes(sk));const a=await f.service.remember({projectId:f.project.id,selectionId:page.items[0].selectionId});assert.equal(a.status,'Active');assert.equal(f.calls.length,2);await assert.rejects(f.service.remember({projectId:'another-project',selectionId:page.items[0].selectionId}),/项目不匹配/);await assert.rejects(f.service.remember({projectId:f.project.id,selectionId:'forged-id'}),/过期/);
 f.setStatus('Processing');const second=await browse('ListAssets');const b=await f.service.remember({projectId:f.project.id,selectionId:second.items[0].selectionId});assert.equal(a.id,b.id);assert.equal(b.status,'Processing');await assert.rejects(f.service.browse({projectId:f.project.id,endpoint:f.base,action:'ListAssetGroups',pageNumber:501,...f.credentials(),consent:f.consent('ListAssetGroups')}),/500/);await noSecrets(f.data);
});
test('提交丢失、非JSON与重定向标待确认，明确拒绝标失败；不自动补发或跟随',async t=>{
 for(const mode of ['drop','html','redirect','reject']){const f=await fixture(t);f.setMode(mode);const b=await f.request(),r=await f.service.create(structuredClone(b));assert.equal(r.status,mode==='reject'?'Failed':'uncertain');assert.equal((await f.service.create(structuredClone(b))).id,r.id);assert.equal(f.calls.length,1);await assert.rejects(f.service.refresh(r.id,{projectId:f.project.id,...f.credentials(),consent:f.consent('GetAsset')}),/原平台/);await noSecrets(f.data);}
 const f=await fixture(t);const b=await f.request(),r=await f.service.create(b),file=path.join(f.data,'ark-materials',r.id+'.json'),raw=await readJson(file);raw.status='submitting';await atomicJson(file,raw);assert.equal((await f.service.get(r.id,f.project.id)).status,'uncertain');assert.equal(f.calls.length,1);
});
test('真实视频尺寸、帧率、时长、内容替换与符号链接在请求前拒绝',async t=>{
 const f=await fixture(t);for(const bytes of [video('480x320'),video('720x576',12),video('720x576',24,1),Buffer.from('invalid mp4')]){const a=await storeAsset(f.data,bytes,{type:'video/mp4',name:'无效.mp4'});await assert.rejects(inspectArkAssetSource(f.data,a.id));}
 const before=await f.request();await fs.writeFile(path.join(f.data,'assets',f.asset.id),video('720x576',24,3));await assert.rejects(f.service.create(before));assert.equal(f.calls.length,0);
 const linked='linked-video';await fs.symlink(path.join(f.data,'assets',f.asset.id),path.join(f.data,'assets',linked));await atomicJson(path.join(f.data,'assets',linked+'.json'),{...f.asset,id:linked});await assert.rejects(inspectArkAssetSource(f.data,linked),/符号链接/);
});
test('第16版完整备份保留平台原编号、状态与本机依赖，恢复后标记需重新查询',async t=>{
 const f=await fixture(t),r=await f.service.create(await f.request());f.setStatus('Active');await f.service.refresh(r.id,{projectId:f.project.id,...f.credentials(),consent:f.consent('GetAsset')});const bundles=projectBundleService({data:f.data,projects:f.projects,activeJobs:f.activeJobs}),pack=await bundles.exportBundle(f.project.id,f.project.revision),file=await bundles.download(pack.id),bytes=await fs.readFile(file),magic=Buffer.from('JINGCHANG-PACK-1\n'),size=bytes.readUInt32BE(magic.length),manifest=JSON.parse(bytes.subarray(magic.length+4,magic.length+4+size));assert.equal(manifest.version,16);assert.equal(pack.arkMaterials,1);
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-ark-library-restore-')),projects={load:async id=>readJson(path.join(data,'projects',id,'project.json')),save:async p=>{await atomicJson(path.join(data,'projects',p.id,'project.json'),p);return p;}},target=projectBundleService({data,projects,activeJobs:new Map()}),uploaded=await target.upload(createReadStream(file)),p=await target.importBundle(uploaded.id),library=arkAssetService({data,projects,activeJobs:new Map()}),list=await library.list(p.id);assert.equal(list.length,1);assert.notEqual(list[0].id,r.id);assert.notEqual(list[0].localSource.assetId,f.asset.id);assert.equal(list[0].cloudId,'asset-owned');assert.equal(list[0].restored,true);assert.equal(list[0].sourceUrl,f.spec.sourceUrl);
 manifest.version=15;const j=Buffer.from(JSON.stringify(manifest)),n=Buffer.alloc(4);n.writeUInt32BE(j.length);await assert.rejects(target.upload(Readable.from([Buffer.concat([magic,n,j,bytes.subarray(magic.length+4+size)])])),/16版/);assert.throws(()=>arkMaterialRecord({...list[0],status:'Active',cloudId:''}),/缺少/);await noSecrets(data);await noSecrets(f.data);
});
