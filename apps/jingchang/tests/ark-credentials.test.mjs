import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ARK_API_BASE,isLocalArkTarget} from '../public/ark-credential-core.js';
import {localArkCredentialService,normalizeStudioCredential} from '../lib/ark-credentials.mjs';
import {creationStudioService} from '../lib/creation-studio.mjs';
import {studioCredentials,studioCredentialPayload,clearStudioCredentials} from '../lib/canvas-studio.mjs';
import {readJson,records} from '../lib/workspace.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {makeProject} from '../lib/model.mjs';

const KEY='synthetic-existing-ark-key';
const target={mode:'video',config:{protocol:'ark',baseUrl:ARK_API_BASE}};
const selected={apiKey:'',credentialSource:'ark-local',credentialConsent:true};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function fixture(t,{resolve}={}) {
  const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-existing-ark-')),activeJobs=new Map(),calls={resolve:0,submit:0,query:0,download:0};
  let pending=false;
  const credentials={resolve:async studio=>{assert.ok(isLocalArkTarget(studio));calls.resolve++;return resolve?resolve():{apiKey:KEY,source:'macos-keychain'};}};
  const arkTransport={
    submit:async options=>{calls.submit++;assert.equal(options.apiKey,KEY);assert.equal(options.baseUrl,ARK_API_BASE);return{upstreamId:'owned-existing-ark-task'};},
    query:async options=>{calls.query++;assert.equal(options.apiKey,KEY);assert.equal(options.upstreamId,'owned-existing-ark-task');return pending?{status:'running',progress:20}:{status:'completed',videoUrl:'https://owned.invalid/test.mp4'};},
    download:async options=>{calls.download++;assert.equal(options.apiKey,KEY);return{bytes:Buffer.from('000000186674797069736f6d0000020069736f6d69736f32','hex'),mime:'video/mp4'};}
  };
  const service=creationStudioService({data,activeJobs,pollInterval:10,arkCredentials:credentials,arkTransport});
  let studio=await service.create({mode:'video'});
  studio=await service.save(studio.id,{...studio,prompt:'镜头缓缓推近湖面',config:{...studio.config,protocol:'ark',baseUrl:ARK_API_BASE,model:'ep-owned-seedance',duration:5,resolution:'480p'}});
  const authorization=()=>({origin:new URL(ARK_API_BASE).origin,model:studio.config.model,budget:3,currency:'CNY',requestLimit:1,sendPrompt:true,sendReferences:false});
  const start=(requestId='owned-once',extra={})=>service.start(studio.id,{...selected,requestId,revision:studio.revision,authorization:authorization(),...extra});
  async function wait(id,predicate){for(let i=0;i<400;i++){const j=await readJson(path.join(data,'jobs',id+'.json'));if(predicate(j))return j;await sleep(10);}throw Error('owned credential fixture timed out');}
  t.after(()=>{for(const job of activeJobs.values())job.controller.abort();});
  return{data,activeJobs,calls,service,studio,start,wait,authorization,credentials,arkTransport,setPending:value=>pending=value};
}
async function noKey(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())await noKey(file);else assert.equal((await fs.readFile(file)).includes(Buffer.from(KEY)),false,file);}}

test('本机配置严格绑定官方北京视频地址；自定义站点、路径与协议均不能接收它',()=>{
  assert.ok(isLocalArkTarget(target));assert.ok(isLocalArkTarget({...target,config:{...target.config,baseUrl:ARK_API_BASE+'/'}}));
  for(const baseUrl of ['http://ark.cn-beijing.volces.com/api/v3','https://ark.cn-beijing.volces.com.evil.test/api/v3','https://ark.cn-beijing.volces.com:444/api/v3','https://ark.cn-beijing.volces.com/v1','https://ark.cn-beijing.volces.com/api/v3?x=1','https://a:b@ark.cn-beijing.volces.com/api/v3','http://127.0.0.1:8188/api/v3']){
    const bad={...target,config:{...target.config,baseUrl}};assert.equal(isLocalArkTarget(bad),false);assert.throws(()=>normalizeStudioCredential(selected,bad),/官方视频接口/);
  }
  assert.throws(()=>normalizeStudioCredential(selected,{...target,mode:'image'}));assert.throws(()=>normalizeStudioCredential(selected,{...target,config:{...target.config,protocol:'studio'}}));
  assert.throws(()=>normalizeStudioCredential({...selected,credentialConsent:false},target),/明确选择/);assert.throws(()=>normalizeStudioCredential({...selected,apiKey:KEY},target),/同时/);assert.throws(()=>normalizeStudioCredential({apiKey:KEY,credentialSource:'invented'},target),/来源/);
});
test('配置状态只检查环境变量或钥匙串元数据，响应没有密钥或属性',async()=>{
  const executions=[];const service=localArkCredentialService({env:{},platform:'darwin',execFileImpl:async(...args)=>{executions.push(args);return{stdout:'untrusted metadata '+KEY};}});
  const result=await service.status();assert.deepEqual(result,{configured:true,source:'macos-keychain',checkedWithoutReadingSecret:true});assert.equal(executions.length,1);assert.deepEqual(executions[0][1],['find-generic-password','-s','ARK_API_KEY']);assert.equal(JSON.stringify(result).includes(KEY),false);
  const environment=localArkCredentialService({env:{ARK_API_KEY:KEY},platform:'darwin',execFileImpl:()=>{throw Error('must not execute');}});assert.equal((await environment.status()).source,'environment');assert.equal(JSON.stringify(await environment.status()).includes(KEY),false);
});
test('钥匙串缺失、超时、权限问题及非macOS均返回明确配置状态',async()=>{
  for(const [code,status] of [[44,'missing'],['ETIMEDOUT','unavailable'],[36,'unavailable']]){
    const s=localArkCredentialService({env:{},platform:'darwin',execFileImpl:async()=>{throw Object.assign(Error(KEY),{code,stdout:KEY,stderr:KEY});}});
    const result=await s.status();assert.equal(result.status,status);assert.equal(result.configured,false);assert.equal(JSON.stringify(result).includes(KEY),false);
  }
  const s=localArkCredentialService({env:{},platform:'linux',execFileImpl:()=>{throw Error('must not execute');}});assert.equal((await s.status()).status,'missing');await assert.rejects(s.resolve(target),/未找到/);
});
test('显式执行才读取固定钥匙串服务；失败及错误输出不传播秘密',async()=>{
  const executions=[];const s=localArkCredentialService({env:{},platform:'darwin',execFileImpl:async(...args)=>{executions.push(args);return{stdout:KEY+'\n'};}});
  const result=await s.resolve(target);assert.equal(result.apiKey,KEY);assert.deepEqual(executions[0][1],['find-generic-password','-s','ARK_API_KEY','-w']);assert.equal(executions[0][2].timeout,2500);
  await assert.rejects(s.resolve({...target,config:{...target.config,baseUrl:'https://evil.invalid/api/v3'}}));assert.equal(executions.length,1);
  for(const output of ['',KEY+'\nextra', 'x'.repeat(5000)]){const bad=localArkCredentialService({env:{},platform:'darwin',execFileImpl:async()=>({stdout:output})});await assert.rejects(bad.resolve(target),/配置无效/);}
  const bad=localArkCredentialService({env:{},platform:'darwin',execFileImpl:async()=>{throw Object.assign(Error(KEY),{stdout:KEY,stderr:KEY});}});await assert.rejects(bad.resolve(target),e=>!JSON.stringify(e).includes(KEY)&&!e.message.includes(KEY));
});
test('服务端环境变量优先；实际读取不改写环境或存储其他凭据',async()=>{
  const env={ARK_API_KEY:' '+KEY+' '};const s=localArkCredentialService({env,platform:'darwin',execFileImpl:()=>{throw Error('must not execute');}});assert.deepEqual(await s.resolve(target),{apiKey:KEY,source:'environment'});assert.equal(env.ARK_API_KEY,' '+KEY+' ');
  assert.throws(()=>normalizeStudioCredential({apiKey:KEY+'\n'},target));assert.deepEqual(normalizeStudioCredential({apiKey:''},{...target,config:{...target.config,baseUrl:'http://127.0.0.1:8188/v1'}}),{credentialSource:'manual',apiKey:''});
});
test('预算、选择、参数版本或参考文件无效时，先拒绝再读取本机密钥',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.start('no-budget',{authorization:{...f.authorization(),budget:0}}),/预算/);
  await assert.rejects(f.start('no-consent',{credentialConsent:false}),/明确选择/);
  await assert.rejects(f.start('old-revision',{revision:-1}),/项目已更新/);
  const changed=await f.service.save(f.studio.id,{...f.studio,references:[{assetId:'missing-owned-reference'}]});
  await assert.rejects(f.service.start(changed.id,{...selected,requestId:'missing',revision:changed.revision,authorization:{...f.authorization(),sendReferences:true}}));
  assert.deepEqual(f.calls,{resolve:0,submit:0,query:0,download:0});assert.equal((await records(path.join(f.data,'jobs'))).length,0);
});
test('本机配置完成提交、结果保存与同编号去重，密钥不进入持久化',async t=>{
  const f=await fixture(t);const [a,b]=await Promise.all([f.start(),f.start()]);assert.equal(a.id,b.id);const result=await f.wait(a.id,j=>['completed','failed'].includes(j.status));assert.equal(result.status,'completed',result.message);assert.equal(f.calls.resolve,1);assert.equal(f.calls.submit,1);assert.equal(result.requestCount,1);assert.equal(result.credentialSource,'ark-local');assert.equal(result.credentialProvider,'macos-keychain');assert.equal(result.assets.length,1);await noKey(f.data);
});
test('停止并重建服务后显式选择本机配置，仅按原编号查询，不读取原参考或再生成',async t=>{
  const f=await fixture(t);f.setPending(true);const a=await f.start();await f.wait(a.id,j=>!!j.upstreamId);f.activeJobs.get(a.id).controller.abort();await f.wait(a.id,j=>j.status==='cancelled');while(f.activeJobs.size)await sleep(10);
  const restored=creationStudioService({data:f.data,activeJobs:f.activeJobs,pollInterval:10,arkCredentials:f.credentials,arkTransport:f.arkTransport});
  await assert.rejects(restored.resume(f.studio.id,a.id,{...selected,credentialConsent:false}),/明确选择/);assert.equal(f.calls.resolve,1);
  f.setPending(false);await restored.resume(f.studio.id,a.id,{...selected});const result=await f.wait(a.id,j=>j.status==='completed');assert.equal(result.upstreamId,'owned-existing-ark-task');assert.equal(f.calls.submit,1);assert.equal(f.calls.resolve,2);await noKey(f.data);
});
test('缺失或无法读取配置时，不创建生成任务或隐式改用其他来源',async t=>{
  const f=await fixture(t,{resolve:()=>{throw Object.assign(Error('本机配置读取失败'),{status:400});}});await assert.rejects(f.start(),/读取失败/);assert.equal(f.calls.submit,0);assert.equal((await records(path.join(f.data,'jobs'))).length,0);
});
test('每个画布节点独立选择本机来源与预算；源描述不包含密钥且能原样传给子任务',()=>{
  const step={kind:'studio',nodeId:'owned-node',studio:{...target,config:{...target.config,model:'ep-owned-seedance',currency:'CNY'}},status:'pending',sendAssets:false};
  const body={studioCredentials:[{nodeId:step.nodeId,...selected,authorization:{origin:new URL(ARK_API_BASE).origin,model:'ep-owned-seedance',sendPrompt:true,sendReferences:false,requestLimit:1,budget:2,currency:'CNY'}}]};
  const keys=studioCredentials([step],body);assert.deepEqual(studioCredentialPayload(keys.get(step.nodeId)),{credentialSource:'ark-local',credentialConsent:true});assert.equal(JSON.stringify(keys.get(step.nodeId)).includes(KEY),false);assert.equal(step.authorization.budget,2);
  assert.deepEqual(studioCredentials([step],body,{resume:true}).get(step.nodeId),{credentialSource:'ark-local',credentialConsent:true});
  const wrong=structuredClone(step);wrong.studio.config.baseUrl='https://evil.invalid/api/v3';assert.throws(()=>studioCredentials([wrong],body),/官方视频接口/);
  const manual={studioCredentials:[{nodeId:step.nodeId,apiKey:KEY,authorization:body.studioCredentials[0].authorization}]};assert.equal(studioCredentials([step],manual).get(step.nodeId),KEY);assert.deepEqual(studioCredentialPayload(KEY),{apiKey:KEY});clearStudioCredentials(manual);assert.equal(manual.studioCredentials[0].apiKey,'');
});
test('创作台完整备份不携带本机来源选择、密钥或执行授权',async t=>{
  const f=await fixture(t),p=makeProject('本机配置备份');await f.start();while(f.activeJobs.size)await sleep(10);
  const file=path.join(f.data,'studios',f.studio.id,'studio.json'),s=await readJson(file);s.projectId=p.id;await fs.writeFile(file,JSON.stringify(s));
  const bundles=projectBundleService({data:f.data,activeJobs:f.activeJobs,projects:{load:async()=>p}}),pack=await bundles.exportBundle(p.id,p.revision),bytes=await fs.readFile(await bundles.download(pack.id));
  assert.equal(bytes.includes(Buffer.from(KEY)),false);assert.equal(bytes.includes(Buffer.from('ark-local')),false);assert.equal(bytes.includes(Buffer.from('credentialConsent')),false);assert.equal(bytes.includes(Buffer.from('authorization')),false);await noKey(f.data);
});
