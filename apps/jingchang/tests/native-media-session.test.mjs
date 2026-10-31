import './helpers/local-network-only.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {NATIVE_MEDIA_SESSION_HEADER as HEADER,nativeMediaSession,nativeMediaSessionToken,nativeMediaSessionFromHealth,assertNativeMediaSession,assertNativeMediaProjectSession,nativeMediaSessionRequired} from '../public/native-media-session-core.js';
import {createNativeMediaSession,getNativeMediaPageSession,nativeMediaFetch} from '../public/native-media-session.js';
const health=on=>({ok:true,nativeMediaSession:nativeMediaSession(on),capabilities:{smartGroupStoredMedia:on}}),token=on=>nativeMediaSessionToken(nativeMediaSession(on));
test('素材契约核对正反切换、缺失和未知版本，不回显任意头内容',()=>{
 for(const enabled of [false,true]){
  const context={enabled,pathname:'/api/projects/owned/canvas-run',method:'POST'};
  assert.doesNotThrow(()=>assertNativeMediaSession(token(enabled),context));
  assert.throws(()=>assertNativeMediaSession(token(!enabled),context),{status:409,code:'NATIVE_MEDIA_SESSION_CHANGED'});
  assert.throws(()=>assertNativeMediaSession('private-untrusted-value',context),e=>!e.message.includes('private-untrusted-value'));
  if(enabled)assert.throws(()=>assertNativeMediaSession(undefined,context));else assert.doesNotThrow(()=>assertNativeMediaSession(undefined,context));
 }
 assert.throws(()=>nativeMediaSessionFromHealth({...health(true),nativeMediaSession:{version:2,storedMedia:true}}));
 assert.throws(()=>nativeMediaSessionFromHealth({...health(true),nativeMediaSession:{version:1,storedMedia:false}}));
});
test('旧页面不能直接新建、编辑、计划、迁移或续跑；停止、任务读取和保全下载保持',()=>{
 for(const [pathname,method]of [['/api/projects','POST'],['/api/projects/owned','GET'],['/api/projects/owned','PUT'],['/api/projects/owned/canvas-run-plan','GET'],['/api/projects/owned/native-media-version/apply','POST'],['/api/jobs/owned/resume','POST'],['/api/project-bundles/owned/import','POST']]){assert(nativeMediaSessionRequired(pathname,method));assert.throws(()=>assertNativeMediaSession(undefined,{enabled:true,pathname,method}));}
 for(const [pathname,method]of [['/api/jobs','GET'],['/api/jobs/owned','GET'],['/api/jobs/owned/cancel','POST'],['/api/jimeng/account/requests/owned/stop','POST'],['/api/asset-library-backups/owned/cancel','POST'],['/api/projects','GET'],['/api/projects/owned/bundle','POST'],['/api/projects/owned/assets/archive','POST']])assert.doesNotThrow(()=>assertNativeMediaSession('stale',{enabled:true,pathname,method}));
 for(const [pathname,method]of [['/api/projects/owned/canvas-run/cancel','POST'],['/api/jobs/owned/resume/stop','POST'],['/api/projects/owned/native-flow/download','GET']])assert.throws(()=>assertNativeMediaSession('stale',{enabled:true,pathname,method}));
});
test('降级服务不能按旧规则解释新版工程；元数据和本机保全仍可读取',()=>{
 const context={pathname:'/api/projects/owned',method:'GET',header:token(false)};
 for(const project of [{settings:{nativeMediaVersion:2}},{nodes:[{params:{nativeMediaVersion:2}}]},{nodes:[{params:{nativeMediaMap:{version:1}}}]}]){
  assert.throws(()=>assertNativeMediaProjectSession(project,context,false),{code:'NATIVE_MEDIA_RULES_UNAVAILABLE'});
  assert.doesNotThrow(()=>assertNativeMediaProjectSession(project,{...context,pathname:'/api/projects/owned/bundle',method:'POST'},false));
 }
 assert.doesNotThrow(()=>assertNativeMediaProjectSession({settings:{},nodes:[]},context,false));
});
function mockedSession(initial=true){
 const state={on:initial,version:1,requests:[],notice:[],offline:false,forceError:false};
 const session=createNativeMediaSession({onMismatch:e=>state.notice.push(e),fetchImpl:async(url,options={})=>{
  state.requests.push({url,method:options.method||'GET',headers:new Headers(options.headers)});
  if(url==='/api/health'){if(state.offline)return new Response('{}',{status:503});const value=health(state.on);if(state.version===0)delete value.nativeMediaSession;else value.nativeMediaSession.version=state.version;return Response.json(value);}
  return Response.json(state.forceError?{error:'原规则不可用',code:'NATIVE_MEDIA_RULES_UNAVAILABLE'}:{ok:true},{status:state.forceError?409:200,headers:state.version===0?{}:{[HEADER]:token(state.on)}});
 }});return{state,session};
}
test('页面启动规则固定，提交前核对变化时没有发送原修改，也不会自动采用新能力',async()=>{
 for(const initial of [false,true]){
  const {state,session}=mockedSession(initial);await session.fetch('/api/projects/owned');state.on=!initial;
  await assert.rejects(session.fetch('/api/projects/owned',{method:'PUT',body:'original-draft'}),{code:'NATIVE_MEDIA_SESSION_CHANGED'});
  assert.equal(state.requests.filter(r=>r.method==='PUT').length,0);assert.equal(session.token,token(initial));
  await assert.rejects(session.fetch('/api/projects/owned/canvas-run',{method:'POST',body:'original-request'}));assert.equal(state.notice.length,1);
  await session.fetch('/api/jobs/owned');await session.fetch('/api/jobs/owned/cancel',{method:'POST',body:'{}'});
  assert.equal(state.requests.filter(r=>r.method==='POST').length,1);assert.equal(state.requests.at(-1).url,'/api/jobs/owned/cancel');
 }
});
test('响应错误和启动协议升级进入同一保留状态，不自动重试；原409工程冲突不误判版本变化',async()=>{
 const {state,session}=mockedSession();await session.fetch('/api/projects/owned');state.forceError=true;
 await assert.rejects(session.fetch('/api/projects/owned',{method:'PUT'}),{code:'NATIVE_MEDIA_RULES_UNAVAILABLE'});assert.equal(state.requests.filter(r=>r.method==='PUT').length,1);
 const notices=[];let calls=0;const normal=createNativeMediaSession({onMismatch:e=>notices.push(e),fetchImpl:async url=>url==='/api/health'?Response.json(health(false)):(calls++,Response.json({error:'项目已更新'},{status:409,headers:{[HEADER]:token(false)}}))});const r=await normal.fetch('/api/projects/x',{method:'PUT'});assert.equal(r.status,409);assert.equal(calls,1);assert.deepEqual(notices,[]);
 const future=mockedSession();future.state.version=2;await assert.rejects(future.session.fetch('/api/projects/x'));assert.equal(future.state.requests.length,1);
});
test('临时离线检查不发送内容；恢复后由调用者提交一次，原请求与头保持',async()=>{
 const {state,session}=mockedSession();await session.fetch('/api/projects/owned');state.offline=true;
 await assert.rejects(session.fetch('/api/projects/owned',{method:'PUT',body:'draft'}));assert.equal(state.requests.filter(r=>r.method==='PUT').length,0);assert.equal(session.locked,undefined);
 state.offline=false;await session.fetch('/api/projects/owned',{method:'PUT',headers:{'Content-Type':'application/json','x-test':'kept'},body:'draft'});assert.equal(state.requests.filter(r=>r.method==='PUT').length,1);assert.equal(state.requests.at(-1).headers.get(HEADER),token(true));assert.equal(state.requests.at(-1).headers.get('x-test'),'kept');
});
test('现正式无契约的旧服务保持可用；已核对的新协议退回无契约服务时先拒绝发送',async()=>{
 const legacy=mockedSession(false);legacy.state.version=0;await legacy.session.fetch('/api/projects/owned',{method:'PUT'});assert.equal(legacy.session.locked,undefined);
 for(const enabled of [false,true]){const current=mockedSession(enabled);await current.session.fetch('/api/projects/owned');current.state.version=0;await assert.rejects(current.session.fetch('/api/projects/owned',{method:'PUT'}));assert.equal(current.state.requests.filter(r=>r.method==='PUT').length,0);}
});
test('无契约旧服务也不能让新页面误读新版工程，或收到含新版规则的整工程覆盖',async()=>{
 const calls=[],project={id:'owned',settings:{nativeMediaVersion:2},nodes:[]};
 const make=()=>createNativeMediaSession({fetchImpl:async(url,options={})=>{calls.push({url,method:options.method||'GET'});return Response.json(url==='/api/health'?{ok:true,capabilities:{smartGroupStoredMedia:false}}:project);}});
 const read=make();await assert.rejects(read.fetch('/api/projects/owned'),{code:'NATIVE_MEDIA_RULES_UNAVAILABLE'});
 const write=make();await assert.rejects(write.fetch('/api/projects/owned',{method:'PUT',body:JSON.stringify(project)}),{code:'NATIVE_MEDIA_RULES_UNAVAILABLE'});assert.equal(calls.filter(r=>r.method==='PUT').length,0);
});
test('带进度的大文件通道先核对版本、复用请求头，并识别上传响应的版本错误，不重传文件',async()=>{
 const {state,session}=mockedSession(true),headers=await session.prepareUpload({'Content-Type':'application/octet-stream'});assert.equal(headers.get(HEADER),token(true));assert.equal(headers.get('content-type'),'application/octet-stream');
 assert.doesNotThrow(()=>session.checkResponse({header:token(true),status:201,body:{ok:true}}));
 assert.throws(()=>session.checkResponse({header:token(false),status:409,body:{error:'changed',code:'NATIVE_MEDIA_SESSION_CHANGED'}}));assert.equal(state.requests.filter(r=>r.method==='POST').length,0);await assert.rejects(session.prepareUpload());assert.equal(state.notice.length,1);
});
test('同页独立模块共用启动规则；仅本机API带版本头，媒体和外部资源不带头',async t=>{
 const original=globalThis.fetch,calls=[],notices=[];t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,options={})=>{calls.push({url,headers:new Headers(options.headers)});return Response.json(url==='/api/health'?health(true):{ok:true},{headers:{[HEADER]:token(true)}});};
 const a=getNativeMediaPageSession({onMismatch:e=>notices.push(e)}),b=getNativeMediaPageSession();assert.equal(a,b);await nativeMediaFetch('/api/asset-catalog');await nativeMediaFetch('/api/asset-library-backups');
 assert.equal(calls.filter(r=>r.url==='/api/health').length,1);assert(calls.filter(r=>r.url.startsWith('/api/')&&r.url!=='/api/health').every(r=>r.headers.get(HEADER)===token(true)));
 await nativeMediaFetch('/media/owned');await nativeMediaFetch('https://example.invalid/api/not-a-local-route');assert.equal(calls.at(-1).headers.get(HEADER),null);assert.equal(calls.at(-2).headers.get(HEADER),null);assert.deepEqual(notices,[]);
});
