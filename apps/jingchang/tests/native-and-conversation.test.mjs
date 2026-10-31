import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {conversationService} from '../lib/conversations.mjs';
import {creationStudioService} from '../lib/creation-studio.mjs';
import {platformService} from '../lib/api-platforms.mjs';
import {readJson,storeAsset} from '../lib/workspace.mjs';
import {normalizeLoras} from '../lib/native-protocols.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64'),video=Buffer.from('000000186674797069736f6d0000020069736f6d69736f32','hex'),key='synthetic-private-chat-key';
async function fixture(t){
 const requests=[],state={fail:false,pending:false,echo:false};
 const server=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const bytes=Buffer.concat(chunks);let body;try{body=JSON.parse(bytes);}catch{}requests.push({url:req.url,headers:req.headers,body,method:req.method});res.setHeader('content-type','application/json');
  if(req.url==='/image'){res.setHeader('content-type','image/png');return res.end(png);}
  if(req.url==='/video'){res.setHeader('content-type','video/mp4');return res.end(video);}
  if(req.method==='POST'&&state.fail){res.destroy();return;}
  if(req.url.endsWith('/chat/completions'))return res.end(JSON.stringify({choices:[{message:{content:state.echo?'回答 '+key:'模型回答 '+requests.length}}]}));
  if(req.method==='POST'&&req.url==='/v1/images/generations')return res.end(JSON.stringify({task_id:'ms-1'}));
  if(req.url==='/v1/tasks/ms-1')return res.end(JSON.stringify({task_status:state.pending?'RUNNING':'SUCCEED',output_images:[base+'/image']}));
  if(req.method==='POST'&&req.url==='/api/v3/contents/generations/tasks')return res.end(JSON.stringify({id:'ark-1'}));
  if(req.url==='/api/v3/contents/generations/tasks/ark-1')return res.end(JSON.stringify({status:state.pending?'running':'succeeded',content:{video_url:base+'/video'}}));
  res.statusCode=404;res.end('{}');
 });server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;t.after(()=>new Promise(r=>server.close(r)));
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-05-')),activeJobs=new Map(),platforms=platformService(data);
 const saved=await platforms.save({revision:0,platform:{name:'local',protocol:'openai-compatible',baseUrl:base+'/v1',models:[{id:'chat',category:'chat',referenceSupport:true},{id:'text',category:'chat',referenceSupport:false}]}});
 const project={id:'project-1',name:'测试'},service=conversationService({data,activeJobs,platforms,projects:{load:async()=>project,apply:async()=>project}});
 return {data,activeJobs,platforms,platformId:saved.platforms[0].id,service,requests,state,base,project};
}
const authorization=(base,model,refs=false)=>({origin:base,model,sendPrompt:true,sendReferences:refs,requestLimit:1,budget:1,currency:'CNY'});
async function complete(data,id,states=['completed','failed']){for(let i=0;i<200;i++){const j=await readJson(path.join(data,'jobs',id+'.json'));if(states.includes(j.status))return j;await new Promise(r=>setTimeout(r,10));}throw new Error('timeout');}
async function assertSecretAbsent(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())await assertSecretAbsent(f);else assert.equal((await fs.readFile(f)).includes(Buffer.from(key)),false,f);}}
test('对话带图上下文、并发幂等、单次密钥不落盘和回答保留',async t=>{
 const f=await fixture(t),{data,service,platformId,base,requests,state}=f;
 const a=await storeAsset(data,png,{name:'图.png',type:'image/png'}),c=await service.create({projectId:'project-1'});
 const body={revision:c.revision,requestId:'chat-first',text:'看图写剧本',assetIds:[a.id],platformId,model:'chat',apiKey:key,authorization:authorization(base,'chat',true)};
 const pair=await Promise.all([service.send(c.id,structuredClone(body)),service.send(c.id,structuredClone(body))]);assert.equal(pair[0].id,pair[1].id);assert.equal((await complete(data,pair[0].id)).status,'completed');
 assert.equal(requests.length,1);assert.match(requests[0].body.messages[0].content[1].image_url.url,/^data:image\/png;base64,/);
 const updated=await service.get(c.id);assert.equal(updated.messages.length,2);
 state.echo=true;const next=await service.send(c.id,{...body,requestId:'chat-second',revision:updated.revision,text:'继续',assetIds:[]});await complete(data,next.id);
 assert.equal(requests[1].body.messages.length,3);assert.equal((await service.get(c.id)).messages.at(-1).text,'回答 [已隐藏密钥]');
 await assertSecretAbsent(data);
});
test('对话拒绝未授权历史图片、非图片模型、过期版本和正文密钥',async t=>{
 const {data,service,platformId,base,requests}=await fixture(t),c=await service.create({projectId:'project-1'}),a=await storeAsset(data,png,{name:'图.png',type:'image/png'});
 const b={revision:0,requestId:'blocked',text:'测试',assetIds:[a.id],platformId,model:'chat',apiKey:key,authorization:authorization(base,'chat',true)};
 await assert.rejects(service.send(c.id,{...b,authorization:{...b.authorization,sendReferences:false}}));
 await assert.rejects(service.send(c.id,{...b,model:'text',authorization:authorization(base,'text',true)}),/图片输入/);
 await assert.rejects(service.send(c.id,{...b,revision:99}),/更新/);
 await assert.rejects(service.send(c.id,{...b,text:key}),/API Key/);
 assert.equal(requests.length,0);assert.equal((await service.get(c.id)).messages.length,0);
});
test('对话网络不明保留请求编号，重复请求不重发',async t=>{
 const {service,data,base,platformId,state,requests}=await fixture(t);state.fail=true;const c=await service.create({projectId:'project-1'});
 const b={revision:0,requestId:'uncertain',text:'测试',assetIds:[],platformId,model:'chat',apiKey:key,authorization:authorization(base,'chat')};
 const j=await service.send(c.id,{...b}),done=await complete(data,j.id);assert.equal(done.status,'failed');assert.equal(done.uncertain,true);
 assert.equal((await service.send(c.id,b)).id,j.id);assert.equal(requests.length,1);
});
test('ModelScope 原生请求头、LoRA、任务查询及无密钥图片回收',async t=>{
 const {data,activeJobs,base,requests}=await fixture(t),s=creationStudioService({data,activeJobs,pollInterval:10});
 let c=await s.create({mode:'image'});c=await s.save(c.id,{...c,prompt:'水墨山水',config:{...c.config,protocol:'modelscope',baseUrl:base+'/v1',model:'Qwen/test',imageAsync:true,loras:{'author/style':1}}});
 const j=await s.start(c.id,{revision:c.revision,requestId:'ms-first',apiKey:key,authorization:authorization(base,c.config.model)});assert.equal((await complete(data,j.id)).status,'completed');
 assert.equal(requests[0].headers['x-modelscope-async-mode'],'true');assert.deepEqual(requests[0].body.loras,{'author/style':1});assert.equal(requests[1].headers['x-modelscope-task-type'],'image_generation');assert.equal(requests[2].headers.authorization,undefined);
 await assertSecretAbsent(data);assert.throws(()=>normalizeLoras({'a/b':.4}),/合计/);assert.throws(()=>normalizeLoras({'a/b':1,'b/c':1}),/合计/);
});
test('方舟两张图片映射首尾帧、原编号恢复、不重发或重复传图',async t=>{
 const {data,activeJobs,base,requests,state}=await fixture(t),s=creationStudioService({data,activeJobs,pollInterval:10});state.pending=true;
 const a=await storeAsset(data,png,{name:'图.png',type:'image/png'});let c=await s.create({mode:'video'});c=await s.save(c.id,{...c,prompt:'镜头前移',references:[{assetId:a.id},{assetId:a.id}],config:{...c.config,protocol:'ark',baseUrl:base+'/api/v3',model:'seedance-real-id'}});
 const j=await s.start(c.id,{revision:c.revision,requestId:'ark-first',apiKey:key,authorization:authorization(base,c.config.model,true)});
 for(let i=0;i<200;i++){if((await readJson(path.join(data,'jobs',j.id+'.json'))).upstreamId)break;await new Promise(r=>setTimeout(r,5));}
 await s.cancel(c.id,j.id);await complete(data,j.id,['cancelled']);state.pending=false;await s.resume(c.id,j.id,{apiKey:key});const done=await complete(data,j.id);assert.equal(done.status,'completed');
 const posts=requests.filter(r=>r.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].body.content[1].role,'first_frame');assert.equal(posts[0].body.content[2].role,'last_frame');assert.match(posts[0].body.content[1].image_url.url,/^data:image\/png/);
 assert.equal(requests.find(r=>r.url==='/video').headers.authorization,undefined);assert.equal(done.assets[0].type,'video/mp4');await assertSecretAbsent(data);
});
