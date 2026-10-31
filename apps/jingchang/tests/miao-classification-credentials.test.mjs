import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assetClassificationService} from '../lib/asset-classification.mjs';
const platform={id:'miao-test',protocol:'openai-compatible',baseUrl:'https://miaoapi.xyz/v1',models:[{id:'vision-test',category:'chat',referenceSupport:true}]};
const fakeKey='sk-test-private-classification';
async function setup(){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'miao-classification-test-'));
 await fs.mkdir(path.join(data,'assets'));const bytes=Buffer.from('89504e470d0a1a0a01020304','hex');
 await fs.writeFile(path.join(data,'assets','test-image'),bytes);
 await fs.writeFile(path.join(data,'assets','test-image.json'),JSON.stringify({id:'test-image',name:'test.png',type:'image/png',size:bytes.length}));
 let reads=0,calls=0;const seen=[];
 const service=assetClassificationService({data,platforms:{get:async()=>platform},miaoCredentials:{resolve:async(p,options)=>{reads++;assert.equal(p.baseUrl,platform.baseUrl);assert.equal(options.purpose,'chat');return{apiKey:fakeKey};}},apiCall:async request=>{calls++;seen.push(request);return{choices:[{finish_reason:'stop',message:{content:JSON.stringify({summary:'湖面 '+fakeKey,tags:['文旅']})}}]};}});
 const body=()=>({requestId:'request-test',platformId:platform.id,model:'vision-test',credentialSource:'miao-local',credentialConsent:true,consent:true,authorization:{origin:'https://miaoapi.xyz',model:'vision-test',sendImage:true,requestLimit:1,budget:1,currency:'CNY',consent:true}});
 return{data,service,body,seen,get reads(){return reads;},get calls(){return calls;}};
}
test('classification local credential resolves after validation, redacts output and never replays one request',async()=>{
 const f=await setup(),body=f.body();const result=await f.service.classify('test-image',body);
 assert.equal(f.reads,1);assert.equal(f.calls,1);assert.equal(f.seen[0].apiKey,fakeKey);
 assert.equal(f.seen[0].body.messages[0].content[1].type,'image_url');
 assert.equal(result.classification.summary,'湖面 [已隐藏密钥]');
 await f.service.classify('test-image',f.body());assert.equal(f.reads,1);assert.equal(f.calls,1);
 assert.equal(body.apiKey,'');assert(!JSON.stringify(result).includes(fakeKey));
 assert(!(await fs.readFile(path.join(f.data,'assets','test-image.json'),'utf8')).includes(fakeKey));
});
test('classification refuses missing consent, mixed key, wrong budget and unreadable media before secret access',async()=>{
 const f=await setup();
 for(const modify of [b=>{b.credentialConsent=false;},b=>{b.apiKey=fakeKey;},b=>{b.authorization.budget=0;},b=>{b.authorization.sendImage=false;}]){
  const b=f.body();modify(b);await assert.rejects(f.service.classify('test-image',b));
 }
 await assert.rejects(f.service.classify('missing-image',f.body()));assert.equal(f.reads,0);assert.equal(f.calls,0);
});
test('classification provider error is sanitized and retained idempotently without auto retry',async()=>{
 const f=await setup();let reads=0,calls=0;
 const service=assetClassificationService({data:f.data,platforms:{get:async()=>platform},miaoCredentials:{resolve:async()=>{reads++;return{apiKey:fakeKey};}},apiCall:async()=>{calls++;throw Object.assign(new Error('denied '+fakeKey),{publicMessage:'upstream '+fakeKey});}});
 const first=await service.classify('test-image',f.body()).catch(e=>e);
 assert(!first.message.includes(fakeKey));assert(!first.publicMessage.includes(fakeKey));
 await assert.rejects(service.classify('test-image',f.body()));assert.equal(reads,1);assert.equal(calls,1);
});
