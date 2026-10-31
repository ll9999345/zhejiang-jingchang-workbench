import './helpers/local-network-only.mjs';import test from 'node:test';import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {ownedNativeRoundMapFixture} from './helpers/owned-native-round-map-fixture.mjs';import {localServer,persistFixture} from './helpers/library-backup-server.mjs';
import {ownedMediaSessionProxy} from './helpers/native-media-session-proxy.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
test('实际HTTP版本正反切换、无头旧页面和新版工程降级均保留文件，任务状态与停止不被误挡',async t=>{
 const stage=path.resolve('artifacts','native-media-session-api-'+Date.now()),data=path.join(stage,'data'),f=await ownedNativeRoundMapFixture(data);await persistFixture({data,p:f.p});let server; t.after(()=>server?.stop());
 const url='/api/projects/'+f.p.id,file=path.join(data,'projects',f.p.id,'project.json'),before=await fs.readFile(file),jobId=randomUUID();await fs.mkdir(path.join(data,'jobs'),{recursive:true});
 await fs.writeFile(path.join(data,'jobs',jobId+'.json'),JSON.stringify({id:jobId,projectId:f.p.id,kind:'canvas-run',status:'stopped',steps:[],assets:[],snapshot:f.p,createdAt:new Date().toISOString(),message:'owned stopped fixture'}));
 const request=async(pathname,method='GET',headers={},body)=>{const response=await fetch(server.base+pathname,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};
 server=await localServer(data,{envOverrides:{JINGCHANG_SMART_GROUP_MEDIA_TEST:'1'}});const health=await server.api('/api/health');assert.deepEqual(health.nativeMediaSession,{version:1,storedMedia:true});
 const onHeaders=server.headers,port=new URL(server.base).port;
 for(const [route,method,body]of [[url,'GET'],[url,'PUT',f.p],[url+'/canvas-run-plan','GET'],[url+'/canvas-run','POST',{requestId:'must-not-start',revision:0,consent:false}],[url+'/canvas-run/cancel','POST',{consent:false}],[url+'/native-flow/download','GET'],['/api/projects','POST',{}],['/api/jobs/'+jobId+'/resume','POST',{}]]){
  const noHeader=await request(route,method,{},body);assert.equal(noHeader.status,409,route);assert.equal(noHeader.body.code,'NATIVE_MEDIA_SESSION_CHANGED');
 }
 assert.deepEqual(await server.api(url),f.p);assert.equal((await server.api(url+'/canvas-run-plan')).steps.filter(s=>s.nodeId===f.target.id).length,2);
 assert.equal((await request('/api/jobs/'+jobId,'GET')).status,200);assert.equal((await request('/api/jobs/'+jobId+'/cancel','POST',{},{})).status,200);
 assert.equal(digest(await fs.readFile(file)),digest(before));assert.equal((await server.api('/api/projects')).length,1);
 await server.stop();server=await localServer(data,{ownedPort:Number(port),envOverrides:{JINGCHANG_SMART_GROUP_MEDIA_TEST:'0'}});
 assert.equal((await request(url,'GET',onHeaders)).body.code,'NATIVE_MEDIA_SESSION_CHANGED');
 const unsupported=await request(url,'GET',server.headers);assert.equal(unsupported.status,409);assert.equal(unsupported.body.code,'NATIVE_MEDIA_RULES_UNAVAILABLE');
 assert.equal((await request('/api/jobs/'+jobId+'/resume','POST',server.headers,{})).body.code,'NATIVE_MEDIA_RULES_UNAVAILABLE');
 const p2=structuredClone(f.original);p2.settings.nativeMediaVersion=2;await persistFixture({data,p:f.original});
 assert.deepEqual(await server.api(url),f.original);const unsupportedSnapshotView=await request(url+'/native-flow?jobId='+jobId,'GET',server.headers);assert.equal(unsupportedSnapshotView.status,409);assert.equal(unsupportedSnapshotView.body.code,'NATIVE_MEDIA_RULES_UNAVAILABLE');const invalidSave=await request(url,'PUT',server.headers,p2);assert.equal(invalidSave.body.code,'NATIVE_MEDIA_RULES_UNAVAILABLE');assert.deepEqual(await server.api(url),f.original);
 const legacy=await request('/api/projects','POST',{},{});assert.equal(legacy.status,201);assert.equal(legacy.body.settings.nativeMediaVersion,undefined);
 await fs.writeFile(path.join(stage,'result.json'),JSON.stringify({ok:true,actualSamePortNodeRestart:true,onToOffStaleHeaderBlocked:true,missingHeaderBlockedOnCandidate:true,unsupportedModernProjectBlocked:true,unsupportedModernSnapshotResumeBlocked:true,unsupportedModernSnapshotViewBlocked:true,legacyProjectAndCreationKept:true,originalProjectUnchangedUntilOwnedFixtureReplacement:true,jobStatusAndCancelAvailable:true,modelCalls:0,paidCalls:0,thirdPartyUploads:0},null,2));
});
test('真实隔离V2代理往返素材版本头和409代码，匹配页面只保存一次，不重启正式V2',async t=>{
 const stage=path.resolve('artifacts','native-media-session-proxy-'+Date.now()),data=path.join(stage,'data'),f=await ownedNativeRoundMapFixture(data);await persistFixture({data,p:f.p});const server=await localServer(data,{envOverrides:{JINGCHANG_SMART_GROUP_MEDIA_TEST:'1'}});t.after(()=>server.stop());const proxy=await ownedMediaSessionProxy(server);t.after(()=>proxy.stop());const url='/api/projects/'+f.p.id,header='x-jingchang-media-session';
 const healthResponse=await fetch(proxy.base+'/api/health'),health=await healthResponse.json();assert.deepEqual(health.nativeMediaSession,{version:1,storedMedia:true});assert.equal(healthResponse.headers.get(header),server.headers[header]);
 const stale=await fetch(proxy.base+url,{headers:{[header]:'1;smart=0'}});assert.equal(stale.status,409);assert.equal((await stale.json()).code,'NATIVE_MEDIA_SESSION_CHANGED');const absent=await fetch(proxy.base+url);assert.equal(absent.status,409);
 const response=await fetch(proxy.base+url,{headers:server.headers});assert.equal(response.status,200);const p=await response.json();p.name='V2代理匹配规则本机保存';const savedResponse=await fetch(proxy.base+url,{method:'PUT',headers:{...server.headers,'Content-Type':'application/json'},body:JSON.stringify(p)});assert.equal(savedResponse.status,200);assert.equal(savedResponse.headers.get(header),server.headers[header]);const saved=await savedResponse.json();assert.equal(saved.revision,p.revision+1);assert.equal((await server.api(url)).name,p.name);assert.deepEqual(saved.nodes.find(n=>n.id===f.target.id).params.nativeMediaMap,f.p.nodes.find(n=>n.id===f.target.id).params.nativeMediaMap);assert.deepEqual(await server.api('/api/jobs'),[]);
 await fs.writeFile(path.join(stage,'result.json'),JSON.stringify({ok:true,realV2Router:true,requestHeaderForwarded:true,responseHeaderForwarded:true,missingAndStaleHeaderRejected:true,modernProjectAndMapPreserved:true,localProjectWrites:1,formalV2Reloaded:false,modelCalls:0,paidCalls:0,thirdPartyUploads:0},null,2));
});
