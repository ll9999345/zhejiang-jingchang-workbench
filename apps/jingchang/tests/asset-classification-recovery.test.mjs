import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {assetClassificationService} from '../lib/asset-classification.mjs';
import './helpers/local-network-only.mjs';

const fakeKey='sk-test-classification-durable-secret';
const fakeOther='sk-test-other-upstream-secret';
const png=Buffer.from('89504e470d0a1a0a01020304','hex');
const imageId='test-image',modelId='vision-test',platformId='classification-local';
const result={summary:'本机测试湖面',categories:{environment:['室外','湖边']},tags:['文旅']};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const answer=raw=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(raw)}}]});
const platform=url=>({id:platformId,protocol:'openai-compatible',baseUrl:url+'/v1',models:[{id:modelId,category:'chat',referenceSupport:true}]});
const body=(url,requestId='classification-request')=>({requestId,platformId,model:modelId,projectId:'demo-project',prompt:'只确认可见的环境',apiKey:fakeKey,consent:true,authorization:{origin:url,model:modelId,sendImage:true,requestLimit:1,budget:0,currency:'CNY',consent:true}});

async function fixture(){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-classification-recovery-'));
 await fs.mkdir(path.join(data,'assets'));await fs.writeFile(path.join(data,'assets',imageId),png);
 await fs.writeFile(path.join(data,'assets',imageId+'.json'),JSON.stringify({id:imageId,name:'fixture.png',type:'image/png',size:png.length}));
 return data;
}
async function savedFiles(dir){
 const entries=await fs.readdir(dir,{withFileTypes:true}),all=[];
 for(const e of entries){const file=path.join(dir,e.name);if(e.isDirectory())all.push(...await savedFiles(file));else all.push([file,await fs.readFile(file)]);}
 return all;
}
async function assertNoSecrets(data,extra=[]){
 for(const [file,bytes] of await savedFiles(data))for(const secret of [fakeKey,fakeOther,'data:image/','Authorization',...extra])assert.ok(!bytes.includes(Buffer.from(secret)),`${path.basename(file)} must not contain secret/request media`);
}
async function localStub(t,handler){
 let count=0;const observed=[];
 const server=http.createServer(async(req,res)=>{count++;const chunks=[];for await(const chunk of req)chunks.push(chunk);const payload=JSON.parse(Buffer.concat(chunks).toString());observed.push({payload,authorization:req.headers.authorization});await handler(req,res,payload);});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 return{url:'http://127.0.0.1:'+server.address().port,observed,get count(){return count;}};
}

if(process.env.CLASSIFICATION_RECOVERY_CHILD==='1'){
 const config=JSON.parse(await fs.readFile(process.env.CLASSIFICATION_RECOVERY_CONFIG,'utf8'));
 const service=assetClassificationService({data:config.data,platforms:{get:async()=>platform(config.url)},miaoCredentials:{resolve:async()=>{throw new Error('Local fixture must never access keychain');}}});
 await service.recover();
 process.on('message',async message=>{
  try{let value;
   if(message.method==='classify')value=await service.classify(message.assetId||imageId,{...message.body,apiKey:fakeKey});
   else if(message.method==='list')value=await service.list(message.query||{});
   else if(message.method==='recover')value=await service.recover();
   else value=await service[message.method](message.taskId);
   process.send({id:message.id,value});
  }catch(error){process.send({id:message.id,error:{message:error.message,status:error.status,code:error.code,classificationTask:error.classificationTask,publicMessage:error.publicMessage}});}
 });
 process.send({ready:true,pid:process.pid});
}else{
 async function child(t,data,url){
  const configFile=path.join(data,'fixture-config.json');await fs.writeFile(configFile,JSON.stringify({data,url}));
  const proc=fork(fileURLToPath(import.meta.url),[],{cwd:path.resolve(fileURLToPath(new URL('..',import.meta.url))),env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'en_US.UTF-8',CLASSIFICATION_RECOVERY_CHILD:'1',CLASSIFICATION_RECOVERY_CONFIG:configFile},execArgv:['--import',fileURLToPath(new URL('./helpers/local-network-only.mjs',import.meta.url))],silent:true});
  const pending=new Map(),ready=deferred();let serial=0,output='';
  proc.stdout.on('data',v=>output+=v);proc.stderr.on('data',v=>output+=v);
  proc.on('message',m=>{if(m.ready)return ready.resolve(m);const wait=pending.get(m.id);if(wait){pending.delete(m.id);wait.resolve(m);}});
  proc.on('exit',()=>{for(const wait of pending.values())wait.reject(new Error('Fixture process exited'));pending.clear();});
  t.after(async()=>{if(proc.exitCode===null&&proc.signalCode===null){proc.kill('SIGTERM');await once(proc,'exit');}assert.ok(!output.includes(fakeKey));});
  await Promise.race([ready.promise,once(proc,'exit').then(()=>{throw new Error('Fixture exited before ready: '+output);}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Fixture startup timeout')),15000).unref())]);
  return{proc,call:async(method,args={})=>{const id=++serial,wait=deferred();pending.set(id,wait);proc.send({id,method,...args});return wait.promise;},stop:async(signal='SIGTERM')=>{if(proc.exitCode===null&&proc.signalCode===null){proc.kill(signal);await once(proc,'exit');}}};
 }

 test('completed classification is replayed by a genuinely new Node process without a second API request',{timeout:30000},async t=>{
  const data=await fixture(),stub=await localStub(t,(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(answer({...result,summary:'湖面 '+fakeKey,tags:['文旅',fakeOther]})));});
  const first=await child(t,data,stub.url),submitted=body(stub.url);
  const response=await first.call('classify',{body:submitted});assert.equal(response.error,undefined);assert.equal(response.value.classificationTask.status,'completed');assert.equal(response.value.classificationTask.replayed,false);assert.equal(stub.count,1);
  assert.equal(stub.observed[0].authorization,'Bearer '+fakeKey);assert.match(stub.observed[0].payload.messages[0].content[1].image_url.url,/^data:image\/png;base64,/);
  assert.equal(response.value.classification.summary,'湖面 [已隐藏密钥]');assert.ok(!JSON.stringify(response).includes(fakeOther));
  await first.stop();const second=await child(t,data,stub.url);
  const replay=await second.call('classify',{body:submitted});assert.equal(replay.error,undefined);assert.equal(replay.value.classificationTask.replayed,true);assert.deepEqual(replay.value.classification,response.value.classification);assert.equal(stub.count,1);
  const rows=await second.call('list',{query:{assetId:imageId,projectId:'demo-project'}});assert.equal(rows.value.length,1);assert.equal(rows.value[0].owner,undefined);
  const stored=JSON.parse(await fs.readFile(path.join(data,'assets',imageId+'.json'),'utf8'));assert.equal(stored.classificationTask,undefined);
  const receipt=JSON.parse(await fs.readFile(path.join(data,'asset-classification-tasks',submitted.requestId+'.json'),'utf8'));
  assert.match(receipt.media.sha256,/^[a-f0-9]{64}$/);assert.match(receipt.promptDigest,/^[a-f0-9]{64}$/);assert.equal(receipt.authorization.requestLimit,1);assert.ok(receipt.sendIntentAt);await assertNoSecrets(data);
 });

 test('SIGKILL after durable send intent recovers uncertain and never resends the original request',{timeout:30000},async t=>{
  const accepted=deferred(),data=await fixture(),stub=await localStub(t,(_req,_res)=>accepted.resolve());
  const first=await child(t,data,stub.url),submitted=body(stub.url,'killed-request');
  const pending=first.call('classify',{body:submitted}).catch(()=>null);await accepted.promise;
  const before=await first.call('get',{taskId:submitted.requestId});assert.equal(before.value.status,'sending');assert.ok(before.value.sendIntentAt);
  await first.stop('SIGKILL');await pending;
  const second=await child(t,data,stub.url),recovered=await second.call('get',{taskId:submitted.requestId});assert.equal(recovered.value.status,'uncertain');assert.equal(recovered.value.error.code,'classification_interrupted');
  const retry=await second.call('classify',{body:submitted});assert.equal(retry.error.status,409);assert.equal(retry.error.classificationTask.status,'uncertain');assert.equal(stub.count,1);
  const cancel=await second.call('cancel',{taskId:submitted.requestId});assert.equal(cancel.value.status,'uncertain');assert.equal(stub.count,1);await assertNoSecrets(data);
 });

 test('the same request ID rejects every changed binding, including image bytes, origin, protocol, model, prompt and authorization',async()=>{
  const data=await fixture(),url='http://127.0.0.1:8199';let calls=0,p=platform(url);
  const service=assetClassificationService({data,platforms:{get:async()=>p},apiCall:async()=>{calls++;return answer(result);}});
  await service.classify(imageId,body(url));
  for(const change of [b=>b.prompt='不同要求',b=>b.model='another-model',b=>b.authorization.budget=1,b=>b.authorization.currency='USD',b=>b.authorization.sendImage=false,b=>b.consent=false,b=>b.projectId='another-project',b=>b.credentialSource='miao-local']){
   const next=body(url);change(next);await assert.rejects(service.classify(imageId,next),e=>e.status===409);
  }
  p={...p,baseUrl:'http://127.0.0.1:8200/v1'};await assert.rejects(service.classify(imageId,body(url)),e=>e.status===409);
  p={...platform(url),baseUrl:url+'/other-v1'};await assert.rejects(service.classify(imageId,body(url)),e=>e.status===409);
  p={...platform(url),protocol:'gemini'};await assert.rejects(service.classify(imageId,body(url)),e=>e.status===409);p=platform(url);
  await fs.writeFile(path.join(data,'assets',imageId),Buffer.from('89504e470d0a1a0a09080706','hex'));
  await assert.rejects(service.classify(imageId,body(url)),e=>e.status===409);assert.equal(calls,1);await assertNoSecrets(data);
 });

 test('two live Node processes cannot send the same ID twice; cancellation is terminal even in the other process',{timeout:30000},async t=>{
  const accepted=deferred(),release=deferred(),data=await fixture(),stub=await localStub(t,async(_req,res)=>{accepted.resolve();await release.promise;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(answer(result)));});
  const a=await child(t,data,stub.url),b=await child(t,data,stub.url),submitted=body(stub.url,'multi-process-request');
  const first=a.call('classify',{body:submitted});await accepted.promise;
  const duplicate=await b.call('classify',{body:submitted});assert.equal(duplicate.error.status,409);assert.equal(stub.count,1);
  const cancelled=await b.call('cancel',{taskId:submitted.requestId});assert.equal(cancelled.value.status,'uncertain');release.resolve();
  assert.equal((await first).error.classificationTask.status,'uncertain');
  assert.equal((await a.call('get',{taskId:submitted.requestId})).value.status,'uncertain');assert.equal(stub.count,1);
  const saved=JSON.parse(await fs.readFile(path.join(data,'assets',imageId+'.json'),'utf8'));assert.equal(saved.classification,undefined);await assertNoSecrets(data);
 });

 test('simultaneous same-process submissions before disk creation still share one request',async()=>{
  const data=await fixture(),url='http://127.0.0.1:8199';let calls=0;
  const service=assetClassificationService({data,platforms:{get:async()=>platform(url)},apiCall:async()=>{calls++;return answer(result);}});
  const outputs=await Promise.all(Array.from({length:10},()=>service.classify(imageId,body(url))));
  assert.equal(calls,1);for(const output of outputs)assert.equal(output.classificationTask.status,'completed');await assertNoSecrets(data);
 });

 test('same-process concurrent callers share one durable classification and another request cannot race the asset',async()=>{
  const data=await fixture(),url='http://127.0.0.1:8199',entered=deferred(),release=deferred();let calls=0;
  const service=assetClassificationService({data,platforms:{get:async()=>platform(url)},apiCall:async()=>{calls++;entered.resolve();await release.promise;return answer(result);}});
  const first=service.classify(imageId,body(url));await entered.promise;
  const duplicate=service.classify(imageId,body(url));
  await assert.rejects(service.classify(imageId,body(url,'other-request')),e=>e.status===409);
  const changed=body(url);changed.prompt='changed';await assert.rejects(service.classify(imageId,changed),e=>e.status===409);
  release.resolve();const [a,b]=await Promise.all([first,duplicate]);assert.equal(calls,1);assert.deepEqual(a.classification,b.classification);assert.equal(b.classificationTask.replayed,true);await assertNoSecrets(data);
 });

 test('explicit upstream rejection is final and sanitized across a new service, with no original exception text saved or exposed',async()=>{
  const data=await fixture(),url='http://127.0.0.1:8199';let calls=0;
  const options={data,platforms:{get:async()=>platform(url)},apiCall:async()=>{calls++;throw Object.assign(new Error('RAW-UPSTREAM Authorization: Bearer '+fakeKey+' '+fakeOther),{upstreamStatus:401,publicMessage:'RAW-UPSTREAM '+fakeKey});}};
  const service=assetClassificationService(options),error=await service.classify(imageId,body(url)).catch(e=>e);
  assert.equal(error.classificationTask.status,'failed');assert.equal(error.classificationTask.error.upstreamStatus,401);assert.ok(!JSON.stringify(error).includes('RAW-UPSTREAM'));assert.ok(!error.message.includes(fakeKey));
  const second=assetClassificationService(options);await assert.rejects(second.classify(imageId,body(url)),e=>e.classificationTask.status==='failed');assert.equal(calls,1);await assertNoSecrets(data,['RAW-UPSTREAM']);
 });

 test('cancelling after send is uncertain even if the upstream ignores abort and later returns a success',async()=>{
  const data=await fixture(),url='http://127.0.0.1:8199',entered=deferred(),release=deferred();let calls=0;
  const service=assetClassificationService({data,platforms:{get:async()=>platform(url)},apiCall:async()=>{calls++;entered.resolve();await release.promise;return answer(result);}});
  const pending=service.classify(imageId,body(url)).catch(e=>e);await entered.promise;
  assert.equal((await service.cancel('classification-request')).status,'uncertain');release.resolve();assert.equal((await pending).classificationTask.status,'uncertain');
  await assert.rejects(service.classify(imageId,body(url)),e=>e.classificationTask.status==='uncertain');assert.equal(calls,1);
  const saved=JSON.parse(await fs.readFile(path.join(data,'assets',imageId+'.json'),'utf8'));assert.equal(saved.classification,undefined);await assertNoSecrets(data);
 });

 test('cancelling while local credentials are resolving remains unsent and clears transient credentials',async()=>{
  const data=await fixture(),entered=deferred(),release=deferred();let calls=0,reads=0;
  const p={...platform('https://miaoapi.xyz'),baseUrl:'https://miaoapi.xyz/v1'};
  const service=assetClassificationService({data,platforms:{get:async()=>p},miaoCredentials:{resolve:async()=>{reads++;entered.resolve();await release.promise;return{apiKey:fakeKey};}},apiCall:async()=>{calls++;return answer(result);}});
  const input=body('https://miaoapi.xyz');input.apiKey='';input.authorization.budget=1;input.credentialSource='miao-local';input.credentialConsent=true;
  const pending=service.classify(imageId,input).catch(e=>e);await entered.promise;
  assert.equal((await service.cancel(input.requestId)).status,'cancelled');release.resolve();assert.equal((await pending).classificationTask.status,'cancelled');assert.equal(calls,0);assert.equal(reads,1);assert.equal(input.apiKey,'');await assertNoSecrets(data);
 });

 test('missing consent or invalid authorization never reads a local credential or creates a receipt',async()=>{
  const data=await fixture();let reads=0,calls=0;
  const p={...platform('https://miaoapi.xyz'),baseUrl:'https://miaoapi.xyz/v1'};
  const service=assetClassificationService({data,platforms:{get:async()=>p},miaoCredentials:{resolve:async()=>{reads++;return{apiKey:fakeKey};}},apiCall:async()=>{calls++;return answer(result);}});
  for(const mutate of [b=>b.consent=false,b=>b.authorization.budget=0,b=>b.authorization.requestLimit=2,b=>b.authorization.origin='https://other.example',b=>b.authorization.sendImage=false]){
   const input=body('https://miaoapi.xyz');input.apiKey='';input.authorization.budget=1;input.credentialSource='miao-local';input.credentialConsent=true;mutate(input);
   await assert.rejects(service.classify(imageId,input));assert.equal(input.apiKey,'');
  }
  assert.equal(reads,0);assert.equal(calls,0);assert.equal((await service.list()).length,0);await assertNoSecrets(data);
 });

 test('JSON-escaped credentials echoed in a successful classification are removed after parsing',async()=>{
  const data=await fixture(),url='http://127.0.0.1:8199',escapedKey='private"credential\\alpha',input=body(url);input.apiKey=escapedKey;
  const service=assetClassificationService({data,platforms:{get:async()=>platform(url)},apiCall:async()=>answer({summary:'场景 '+escapedKey,categories:{subject:[escapedKey]},tags:[escapedKey]})});
  const response=await service.classify(imageId,input);assert.equal(response.classification.summary,'场景 [已隐藏密钥]');assert.ok(!JSON.stringify(response).includes('alpha'));
  await assertNoSecrets(data,[escapedKey,'private\\"credential']);
 });

 test('an image changed while the request is in flight never receives classification for the previous bytes',async()=>{
  const data=await fixture(),url='http://127.0.0.1:8199',entered=deferred(),release=deferred();let calls=0;
  const service=assetClassificationService({data,platforms:{get:async()=>platform(url)},apiCall:async()=>{calls++;entered.resolve();await release.promise;return answer(result);}});
  const pending=service.classify(imageId,body(url)).catch(e=>e);await entered.promise;
  await fs.writeFile(path.join(data,'assets',imageId),Buffer.from('89504e470d0a1a0a0a0b0c0d','hex'));release.resolve();
  assert.equal((await pending).classificationTask.status,'failed');
  assert.equal(JSON.parse(await fs.readFile(path.join(data,'assets',imageId+'.json'),'utf8')).classification,undefined);
  await assert.rejects(service.classify(imageId,body(url)),e=>e.status===409);assert.equal(calls,1);await assertNoSecrets(data);
 });
}
