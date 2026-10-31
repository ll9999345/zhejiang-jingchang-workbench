import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {creationStudioService} from '../lib/creation-studio.mjs';
import {safeApiCall} from '../lib/image-api.mjs';
import {readJson,storeAsset} from '../lib/workspace.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
const video=Buffer.from('000000186674797069736f6d0000020069736f6d69736f32','hex'),key='synthetic-protocol-secret';
async function fixture(t){
 const requests=[],state={pending:false,fail:false,textOnly:false,blocked:false,wrongId:false,failed:false,count:1};
 const server=http.createServer(async(req,res)=>{const parts=[];for await(const c of req)parts.push(c);let body;try{body=JSON.parse(Buffer.concat(parts));}catch{}requests.push({url:req.url,method:req.method,headers:req.headers,body});res.setHeader('content-type','application/json');
  if(state.fail&&req.method==='POST')return res.destroy();
  if(req.url==='/v1beta/models')return res.end(JSON.stringify({models:[{name:'models/gemini-test-image',supportedGenerationMethods:['generateContent']},{name:'models/gemini-text',supportedGenerationMethods:['generateContent']},{name:'models/embedding',supportedGenerationMethods:['embedContent']}],nextPageToken:'next'}));
  if(req.url==='/v1beta/models/gemini-test-image:generateContent')return res.end(JSON.stringify(state.blocked?{promptFeedback:{blockReason:'SAFETY'}}:{candidates:[{finishReason:'STOP',content:{parts:state.textOnly?[{text:'text '+key}]:[{thought:true,inlineData:{mimeType:'image/png',data:'invalid-internal-preview'}},{text:'text '+key},{inlineData:{mimeType:'image/png',data:png.toString('base64')}}]}}]}));
  if(['/v1/images/generations','/v1/videos/generations'].includes(req.url)){state.count=body.n||1;return res.end(JSON.stringify({code:200,data:[{status:'submitted',task_id:body.n?'image-task':'video-task'}]}));}
  if(req.url.startsWith('/v1/tasks/')){const id=req.url.split('/').at(-1);return res.end(JSON.stringify({code:200,data:{id:state.wrongId?'different-task':id,status:state.failed?'failed':state.pending?'processing':'completed',progress:23,result:id==='image-task'?{images:[{url:Array(state.count).fill(base+'/image')}]}:{videos:[{url:[base+'/video']}]}}}));}
  if(req.url==='/image'){res.setHeader('content-type','image/png');return res.end(png);}
  if(req.url==='/video'){res.setHeader('content-type','video/mp4');return res.end(video);}
  res.statusCode=404;res.end('{}');
 });server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;t.after(()=>new Promise(r=>server.close(r)));
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-protocols-')),activeJobs=new Map();const service=creationStudioService({data,activeJobs,pollInterval:10});
 const asset=await storeAsset(data,png,{name:'picture.png',type:'image/png'});
 return {base,data,requests,state,service,asset};
}
async function create(f,protocol,mode='image',config={},references=[]){let s=await f.service.create({mode});return f.service.save(s.id,{...s,prompt:'创作测试',references,config:{...s.config,protocol,baseUrl:f.base+(protocol==='gemini'?'/v1beta':'/v1'),model:protocol==='gemini'?'gemini-test-image':mode==='image'?'gpt-image-2':'doubao-seedance-2.0',imageAsync:protocol==='apimart'&&mode==='image',duration:5,...config}});}
const body=(f,s,id)=>({revision:s.revision,requestId:id,apiKey:key,authorization:{origin:f.base,model:s.config.model,sendPrompt:true,sendReferences:s.references.length>0,requestLimit:1,budget:1,currency:'CNY'}});
async function settled(f,id,states=['completed','failed','cancelled']){for(let i=0;i<300;i++){const j=await readJson(path.join(f.data,'jobs',id+'.json'));if(states.includes(j.status))return j;await new Promise(r=>setTimeout(r,10));}throw Error('timeout');}
async function noSecret(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await noSecret(p);else assert.equal((await fs.readFile(p)).includes(Buffer.from(key)),false,p);}}
test('Gemini 原生图生图、专用鉴权、跳过思考图、重复请求只提交一次',async t=>{
 const f=await fixture(t),s=await create(f,'gemini','image',{},[{assetId:f.asset.id}]);
 const [a,b]=await Promise.all([f.service.start(s.id,body(f,s,'gemini-once')),f.service.start(s.id,body(f,s,'gemini-once'))]);assert.equal(a.id,b.id);
 const done=await settled(f,a.id);assert.equal(done.status,'completed');assert.equal(done.assets.length,1);
 const r=f.requests[0];assert.equal(r.headers['x-goog-api-key'],key);assert.equal(r.headers.authorization,undefined);assert.equal(r.body.contents[0].parts[1].inlineData.data,png.toString('base64'));assert.equal(r.body.generationConfig.responseFormat.image.aspectRatio,'16:9');assert.equal(f.requests.length,1);await noSecret(f.data);
});
test('Gemini 无图、受阻和网络不明均不自动重试；模型发现使用原生格式',async t=>{
 const f=await fixture(t);const models=await f.service.discover({protocol:'gemini',baseUrl:f.base+'/v1beta',apiKey:key,consent:true});assert.deepEqual(models.models,[{id:'gemini-test-image',category:'image'},{id:'gemini-text',category:'chat'}]);assert.equal(models.partial,true);assert.equal(f.requests[0].headers['x-goog-api-key'],key);
 for(const kind of ['textOnly','blocked','fail']){f.state[kind]=true;const s=await create(f,'gemini'),j=await f.service.start(s.id,body(f,s,kind)),done=await settled(f,j.id);assert.equal(done.status,'failed');assert.equal(done.uncertain,kind!=='blocked');await f.service.start(s.id,body(f,s,kind));f.state[kind]=false;}
 assert.equal(f.requests.filter(r=>r.method==='POST').length,3);await noSecret(f.data);
});
test('APIMart 异步参考图与多图回收，停后按原编号恢复',async t=>{
 const f=await fixture(t);f.state.pending=true;const s=await create(f,'apimart','image',{count:2,imageResolution:'2k'},[{assetId:f.asset.id}]);const j=await f.service.start(s.id,body(f,s,'apimart-image'));
 for(let i=0;i<200&&!f.requests.some(r=>r.url.startsWith('/v1/tasks/'));i++)await new Promise(r=>setTimeout(r,5));
 await f.service.cancel(s.id,j.id);await settled(f,j.id);f.state.pending=false;await f.service.resume(s.id,j.id,{apiKey:key});const done=await settled(f,j.id);assert.equal(done.status,'completed');assert.equal(done.assets.length,2);
 const posts=f.requests.filter(r=>r.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].body.n,2);assert.equal(posts[0].body.resolution,'2k');assert.equal(posts[0].body.size,'16:9');assert.match(posts[0].body.image_urls[0],/^data:image\/png;base64,/);assert.ok(f.requests.filter(r=>r.url==='/image').every(r=>!r.headers.authorization));await noSecret(f.data);
});
test('APIMart 视频首尾帧字段、原任务结果下载不带密钥',async t=>{
 const f=await fixture(t),s=await create(f,'apimart','video',{},[{url:'https://example.com/first.png'},{url:'https://example.com/last.png'}]);const j=await f.service.start(s.id,body(f,s,'apimart-video')),done=await settled(f,j.id);assert.equal(done.status,'completed');assert.equal(done.assets[0].type,'video/mp4');assert.deepEqual(f.requests[0].body.image_with_roles.map(r=>r.role),['first_frame','last_frame']);assert.equal(f.requests.find(r=>r.url==='/video').headers.authorization,undefined);assert.equal(f.requests.filter(r=>r.method==='POST').length,1);await noSecret(f.data);
});
test('协议能力不符在提交前拒绝，不使用不匹配任务结果或失败结果',async t=>{
 const f=await fixture(t);
 for(const [protocol,mode,config,refs] of [['gemini','video',{},[]],['gemini','image',{model:'gemini/escape'},[]],['gemini','image',{count:2},[]],['apimart','image',{model:'other'},[]],['apimart','video',{duration:4},[]],['apimart','video',{},[{assetId:f.asset.id}]]]){const s=await create(f,protocol,mode,config,refs);await assert.rejects(f.service.start(s.id,body(f,s,s.id)));}
 assert.equal(f.requests.length,0);
 f.state.wrongId=true;let s=await create(f,'apimart'),j=await f.service.start(s.id,body(f,s,'wrong-id'));assert.equal((await settled(f,j.id)).assets.length,0);assert.equal(f.requests.filter(r=>r.url==='/image').length,0);
 f.state.wrongId=false;f.state.failed=true;s=await create(f,'apimart');j=await f.service.start(s.id,body(f,s,'failed'));assert.equal((await settled(f,j.id)).status,'failed');assert.equal(f.requests.filter(r=>r.method==='POST').length,2);
});
test('专用鉴权不扩大路径范围，也不跟随携带密钥的重定向',async t=>{
 const f=await fixture(t);
 for(const p of ['https://example.com','models/gemini-test:other','models/../gemini-test:generateContent','models/gemini-test:generateContent?key=secret'])await assert.rejects(safeApiCall({baseUrl:f.base,path:p,apiKey:key,authMode:'gemini'}));
 await assert.rejects(safeApiCall({baseUrl:f.base,path:'models/gemini-test:generateContent',apiKey:key}));assert.equal(f.requests.length,0);
 const redirect=http.createServer((req,res)=>{res.writeHead(302,{Location:f.base+'/image'});res.end();});redirect.listen(0,'127.0.0.1');await once(redirect,'listening');t.after(()=>new Promise(r=>redirect.close(r)));
 await assert.rejects(safeApiCall({baseUrl:'http://127.0.0.1:'+redirect.address().port,path:'models',apiKey:key,authMode:'gemini'}));assert.equal(f.requests.length,0);
});
