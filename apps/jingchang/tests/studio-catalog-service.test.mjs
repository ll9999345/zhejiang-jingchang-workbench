import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {once} from 'node:events';
import {creationStudioService} from '../lib/creation-studio.mjs';
import {platformService} from '../lib/api-platforms.mjs';
const secret='synthetic-studio-catalog-key';
const fixed={id:'9ce79a6e-5796-4904-9b05-2f069e046f1a',name:'模型服务',protocol:'openai-compatible',baseUrl:'https://miaoapi.xyz/v1',models:[{id:'gpt-image-2.5-flare',category:'image'}]};
async function fixture(t,{modelLister,platform=fixed}={}){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-studio-catalog-'));let resolves=0,modelRequests=0;
 const credentials={status:async()=>({configured:true,source:'test-metadata',checkedWithoutReadingSecret:true}),resolve:async()=>{resolves++;return {apiKey:secret,source:'test-only'};}};
 const platforms=platformService(data,{miaoCredentials:credentials,openAIModelLister:async opts=>{modelRequests++;assert.equal(opts.apiKey,secret);return modelLister?modelLister(opts):{models:[{id:'gpt-image-2.5-sunburst'},{id:'seedance-2.0-fast'},{id:'MiniMax-H3'},{id:secret,label:secret}]};}});
 await fs.writeFile(path.join(data,'api-platforms.json'),JSON.stringify({revision:1,platforms:[platform]}));
 const service=creationStudioService({data,activeJobs:new Map(),platforms,miaoCredentials:credentials});
 t.after(()=>{}); // Evidence data deliberately retained; user policy forbids deletion.
 return {data,service,platforms,state:()=>({resolves,modelRequests})};
}
const discoverBody=()=>({platformId:fixed.id,consent:true,credentialSource:'miao-local',credentialConsent:true,apiKey:''});
test('GET目录只读取本机保存信息和凭据元数据，不读取秘密或调用上游',async t=>{
 const f=await fixture(t),before=await fs.readFile(path.join(f.data,'api-platforms.json'),'utf8');const value=await f.service.catalog();assert.equal(value.platforms[0].models[0].id,'gpt-image-2.5-flare');assert.equal(value.generationVerified,false);assert.equal(value.credentialStatus.checkedWithoutReadingSecret,true);assert.deepEqual(f.state(),{resolves:0,modelRequests:0});assert.equal(await fs.readFile(path.join(f.data,'api-platforms.json'),'utf8'),before);assert.doesNotMatch(JSON.stringify(value),new RegExp(secret));
});
test('已登记服务发现复用服务端凭据、保留准确ID并过滤秘密，不写用户平台文件',async t=>{
 const f=await fixture(t),before=await fs.readFile(path.join(f.data,'api-platforms.json'),'utf8'),body=discoverBody();const result=await f.service.discover(body);assert.equal(result.platformId,fixed.id);assert.ok(result.models.some(m=>m.id==='MiniMax-H3'));assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));const catalog=await f.service.catalog();assert.equal(catalog.discoveredByPlatform[fixed.id][0].id,'gpt-image-2.5-sunburst');assert.equal(catalog.discoveredByPlatform[fixed.id][1].category,undefined,'name evidence must not become explicit provider category');assert.equal(await fs.readFile(path.join(f.data,'api-platforms.json'),'utf8'),before);assert.deepEqual(f.state(),{resolves:1,modelRequests:1});assert.equal(body.apiKey,'');
});
test('目录失败不会重试、替换已保存型号或生成任务',async t=>{
 let fail=false;const f=await fixture(t,{modelLister:async()=>{if(fail)throw Object.assign(Error('synthetic catalog failure'),{status:502});return {models:[{id:'gpt-image-2.5-sunburst'}]};}});await f.service.discover(discoverBody());fail=true;await assert.rejects(f.service.discover(discoverBody()),/catalog failure/);const catalog=await f.service.catalog();assert.equal(catalog.discoveredByPlatform[fixed.id][0].id,'gpt-image-2.5-sunburst');assert.deepEqual(f.state(),{resolves:2,modelRequests:2});assert.deepEqual(await fs.readdir(path.join(f.data,'studios')).catch(()=>[]),[]);
});
test('未核实视频在读取密钥前拒绝，不能通过直接POST绕过下拉禁用',async t=>{
 const f=await fixture(t);await f.service.discover(discoverBody());let studio=await f.service.create({mode:'video'});studio=await f.service.save(studio.id,{...studio,prompt:'湖面晨光',config:{...studio.config,platformId:fixed.id,baseUrl:fixed.baseUrl,model:'MiniMax-H3'}});const before=f.state().resolves;await assert.rejects(f.service.start(studio.id,{revision:studio.revision,requestId:randomUUID(),credentialSource:'miao-local',credentialConsent:true,apiKey:'',authorization:{origin:'https://miaoapi.xyz',model:'MiniMax-H3',budget:1,currency:'CNY',sendPrompt:true,sendReferences:false,requestLimit:1}}),/接口待核实/);assert.equal(f.state().resolves,before);assert.deepEqual(await f.service.jobs(studio.id),[]);
});
test('绑定模型与目的地址/协议必须一起匹配，参数失败不读取本机密钥',async t=>{
 const f=await fixture(t);let studio=await f.service.create({mode:'image'});studio=await f.service.save(studio.id,{...studio,prompt:'湖面晨光',config:{...studio.config,platformId:fixed.id,baseUrl:'https://different.example/v1',model:'gpt-image-2.5-flare'}});await assert.rejects(f.service.start(studio.id,{revision:studio.revision,requestId:randomUUID(),credentialSource:'miao-local',credentialConsent:true}),/服务地址或接口不一致/);assert.equal(f.state().resolves,0);
});
test('自定义连接不能通过移除platformId绕过固定服务的视频契约校验',async t=>{
 const f=await fixture(t);let studio=await f.service.create({mode:'video'});studio=await f.service.save(studio.id,{...studio,prompt:'湖面晨光',config:{...studio.config,baseUrl:fixed.baseUrl,model:'MiniMax-H3'}});assert.equal(studio.config.platformId,undefined);await assert.rejects(f.service.start(studio.id,{revision:studio.revision,requestId:randomUUID(),credentialSource:'miao-local',credentialConsent:true,apiKey:'',authorization:{origin:'https://miaoapi.xyz',model:studio.config.model,budget:1,currency:'CNY',sendPrompt:true,sendReferences:false,requestLimit:1}}),/视频接口尚未核实/);assert.equal(f.state().resolves,0);assert.deepEqual(await f.service.jobs(studio.id),[]);
});
test('准确目录图片ID通过兼容接口发送并回收，完全本地HTTP mock',async t=>{
 const calls=[];const server=http.createServer(async(req,res)=>{let chunks=[];for await(const chunk of req)chunks.push(chunk);calls.push({url:req.url,body:JSON.parse(Buffer.concat(chunks))});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3O8AAAAASUVORK5CYII='}]}));});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));const baseUrl='http://127.0.0.1:'+server.address().port+'/v1';const f=await fixture(t,{platform:{...fixed,baseUrl}});let studio=await f.service.create({mode:'image'});studio=await f.service.save(studio.id,{...studio,prompt:'湖面晨光',config:{...studio.config,platformId:fixed.id,baseUrl,model:'gpt-image-2.5-flare'}});const job=await f.service.start(studio.id,{revision:studio.revision,requestId:randomUUID(),apiKey:'',authorization:{origin:new URL(baseUrl).origin,model:studio.config.model,budget:1,currency:'CNY',sendPrompt:true,sendReferences:false,requestLimit:1}});const until=Date.now()+5000;let final;while(Date.now()<until){final=(await f.service.jobs(studio.id)).find(j=>j.id===job.id);if(final.status==='completed'||final.status==='failed')break;await new Promise(r=>setTimeout(r,10));}assert.equal(final.status,'completed',final.message);assert.equal(calls.length,1);assert.equal(calls[0].url,'/v1/images/generations');assert.equal(calls[0].body.model,'gpt-image-2.5-flare');assert.equal(final.assets.length,1);assert.equal(f.state().resolves,0);assert.doesNotMatch(await fs.readFile(path.join(f.data,'jobs',job.id+'.json'),'utf8'),new RegExp(secret));
});
