import './helpers/local-network-only.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {execFileSync} from 'node:child_process';
import {createCanvas} from '@napi-rs/canvas';
import {makeProject,makeNode} from '../lib/model.mjs';
import {storeAsset,readJson,atomicJson,records,userError} from '../lib/workspace.mjs';
import {platformService} from '../lib/api-platforms.mjs';
import {conversationService} from '../lib/conversations.mjs';
import {creationStudioService,validateStudioReferences} from '../lib/creation-studio.mjs';
import {generateImage} from '../lib/image-api.mjs';
import {generateStudioImages} from '../lib/studio-protocol.mjs';
import {directImageService} from '../lib/direct-images.mjs';
import {imageStep} from '../lib/canvas-images.mjs';
import {llmStep,canvasLlmService} from '../lib/canvas-llm.mjs';
import {studioStep,resolveStudio} from '../lib/canvas-studio.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';

const key='synthetic-reference-capacity-key',magic=Buffer.from('JINGCHANG-PACK-1\n');
function png(i){const c=createCanvas(24,16),x=c.getContext('2d');x.fillStyle=`rgb(${i*11%256},${i*23%256},${i*37%256})`;x.fillRect(0,0,24,16);return c.toBuffer('image/png');}
async function fixture(t){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-reference-capacity-')),activeJobs=new Map(),calls=[],state={action:'edit_image'},assets=[],buffers=Array.from({length:21},(_,i)=>png(i));
 const server=http.createServer(async(req,res)=>{try{const chunks=[];for await(const b of req)chunks.push(b);const raw=Buffer.concat(chunks);let body,images=[];
  if(req.headers['content-type']?.startsWith('multipart/form-data')){const form=await new Request('http://127.0.0.1/mock',{method:'POST',headers:{'content-type':req.headers['content-type']},body:raw}).formData();for(const item of form.getAll('image[]'))images.push(Buffer.from(await item.arrayBuffer()));body={prompt:form.get('prompt')};}else body=JSON.parse(raw);
  const route=body.messages?.[0]?.content?.includes?.('动作规划器');calls.push({url:req.url,body,images});res.setHeader('content-type','application/json');
  if(req.url.endsWith('/chat/completions'))return res.end(JSON.stringify({choices:[{message:{content:route?JSON.stringify({action:state.action,prompts:['保留参考顺序并改为夜景']}):'已分析全部参考素材'},finish_reason:'stop'}]}));
  res.end(JSON.stringify({data:[{b64_json:buffers[0].toString('base64')}]}));
 }catch(e){res.statusCode=500;res.end(JSON.stringify({error:'local mock parse error'}));}});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const base='http://127.0.0.1:'+server.address().port,platforms=platformService(data),saved=await platforms.save({revision:0,platform:{name:'本机多参考测试',protocol:'openai-compatible',baseUrl:base+'/v1',models:[{id:'image-test',category:'image',referenceSupport:true},{id:'chat-test',category:'chat',referenceSupport:true}]}}),platform=saved.platforms[0];
 const project=makeProject('多参考素材测试');for(const [i,b] of buffers.entries())assets.push(await storeAsset(data,b,{name:'参考-'+i+'.png',type:'image/png'}));project.assets=assets.slice();
 const projects={load:async id=>{if(id===project.id)return project;throw userError('项目不存在',404);},save:async p=>p};
 const common={data,activeJobs,platforms,projects},conversations=conversationService(common),studios=creationStudioService(common);
 const refs=assets.slice(0,20).map(a=>({assetId:a.id})),binding=category=>({platform:structuredClone(platform),model:category==='image'?'image-test':'chat-test',referenceSources:refs,size:'auto',quality:'auto',maxTokens:512,stream:false});
 return {...common,conversations,studios,project,assets,buffers,refs,binding,platform,calls,state,base};
}
async function done(f,id){for(let i=0;i<800;i++){const j=await readJson(path.join(f.data,'jobs',id+'.json'));if(!f.activeJobs.has(id)&&!['queued','running'].includes(j.status))return j;await new Promise(r=>setTimeout(r,10));}throw Error('local job timeout');}
function auth(f,model,limit=1){return {origin:f.base,model,sendPrompt:true,sendReferences:true,requestLimit:limit,budget:1,currency:'CNY'};}
async function send(f,mode,assetIds=f.refs.map(r=>r.assetId),c){c??=await f.conversations.create({projectId:f.project.id});const b={revision:c.revision,requestId:randomUUID(),mode,platformId:f.platform.id,model:mode==='image'?'image-test':'chat-test',text:'请根据参考图片创作',assetIds,apiKey:key,stream:false,authorization:auth(f,mode==='image'?'image-test':'chat-test',mode==='agent'?2:1)};
 if(mode==='agent'){b.agent={imagePlatformId:f.platform.id,imageModel:'image-test',imageCount:1,inheritLastImage:false};const p=await f.conversations.agentPreview(c.id,b);assert.equal(p.image.referenceIds.length,20);b.agent={...b.agent,previewHash:p.hash,imageApiKey:key,imageAuthorization:auth(f,'image-test')};}
 const j=await done(f,(await f.conversations.send(c.id,b)).id);assert.equal(j.status,'completed',j.message);return await f.conversations.get(c.id);
}
function encodedImages(call){return call.body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='image_url').map(p=>Buffer.from(p.image_url.url.split(',')[1],'base64'));}

test('两个通用图片协议发送全部20张参考且顺序一致，21张零提交拒绝',async t=>{
 const f=await fixture(t),references=f.buffers.slice(0,20).map((bytes,i)=>({bytes,mime:'image/png',name:'ordered-'+i+'.png'})),studio=await f.studios.create({projectId:f.project.id,mode:'image'});studio.prompt='图片参考';studio.config.model='image-test';
 await generateImage({baseUrl:f.base+'/v1',apiKey:key,model:'image-test',prompt:'图片参考',references});await generateStudioImages({baseUrl:f.base+'/v1',apiKey:key,studio,references});
 for(const c of f.calls){assert.equal(c.url,'/v1/images/edits');assert.deepEqual(c.images,f.buffers.slice(0,20));}
 const tooMany=[...references,{bytes:f.buffers[20],mime:'image/png'}];await assert.rejects(generateImage({baseUrl:f.base+'/v1',apiKey:key,model:'image-test',prompt:'图片参考',references:tooMany}),/20/);await assert.rejects(generateStudioImages({baseUrl:f.base+'/v1',apiKey:key,studio,references:tooMany}),/20/);assert.equal(f.calls.length,2);
});
test('图片对话、普通对话与自有Agent全程保留20张参考，超过上限不创建任务',async t=>{
 const f=await fixture(t);await send(f,'image');assert.deepEqual(f.calls.at(-1).images,f.buffers.slice(0,20));await send(f,'chat');assert.deepEqual(encodedImages(f.calls.at(-1)),f.buffers.slice(0,20));const c=await send(f,'agent');assert.deepEqual(encodedImages(f.calls.at(-2)),f.buffers.slice(0,20));assert.deepEqual(f.calls.at(-1).images,f.buffers.slice(0,20));assert.deepEqual(c.messages.at(-1).usedReferenceIds,f.refs.map(r=>r.assetId));
 const before=f.calls.length,jobs=(await records(path.join(f.data,'jobs'))).length;for(const mode of ['chat','image','agent'])await assert.rejects(send(f,mode,f.assets.map(a=>a.id)),/20/);assert.equal(f.calls.length,before);assert.equal((await records(path.join(f.data,'jobs'))).length,jobs);
});
test('画布图片绑定与创作台绑定可执行20张，原生平台限制仍生效',async t=>{
 const f=await fixture(t),node=f.project.nodes[0];node.text='画布多图';node.params.imageBinding=f.binding('image');const input={data:f.data,project:f.project,node,binding:node.params.imageBinding,parents:new Set(),text:node.text},step=await imageStep(input);step.authorization=auth(f,'image-test');
 const parent='parent-images';f.activeJobs.set(parent,{kind:'canvas-run',projectId:f.project.id,controller:new AbortController()});const direct=directImageService(f),j=await direct.startFromCanvas(step,f.project,{apiKey:key,requestId:randomUUID()},parent);assert.equal((await done(f,j.id)).status,'completed');assert.deepEqual(f.calls.at(-1).images,f.buffers.slice(0,20));
 node.params={studioBinding:{mode:'image',config:{protocol:'studio',baseUrl:f.base+'/v1',model:'image-test'},referenceSources:f.refs}};const s=await studioStep({...input,binding:node.params.studioBinding}),studio=resolveStudio(s,f.project),run=await f.studios.startFromCanvas(studio,f.project,{apiKey:key,requestId:randomUUID(),authorization:auth(f,'image-test')},parent,node.id);assert.equal((await done(f,run.id)).status,'completed');assert.deepEqual(f.calls.at(-1).images,f.buffers.slice(0,20));f.activeJobs.delete(parent);
 for(const protocol of ['gemini','apimart','modelscope'])assert.throws(()=>validateStudioReferences({...studio,config:{...studio.config,protocol}},f.assets.slice(0,20)),/数量|参考/);
 await assert.rejects(imageStep({...input,binding:{...f.binding('image'),referenceSources:f.assets.map(a=>({assetId:a.id}))}}),/20/);await assert.rejects(studioStep({...input,binding:{...node.params.studioBinding,referenceSources:f.assets.map(a=>({assetId:a.id}))}}),/20/);assert.equal(f.calls.length,2);
});
test('画布语言模型接受8图加3视频并发送26张画面，静态/动态超限都在计划时拒绝',async t=>{
 const f=await fixture(t),mp4=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=48x32:rate=6','-t','6','-an','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-f','mp4','-movflags','frag_keyframe+empty_moov','pipe:1']),videos=[];
 for(let i=0;i<4;i++)videos.push(await storeAsset(f.data,mp4,{name:'视频'+i+'.mp4',type:'video/mp4'}));f.project.assets.push(...videos);const node=makeNode('text',0,0,{text:'概括素材'}),refs=[...f.refs.slice(0,8),...videos.slice(0,3).map(a=>({assetId:a.id}))],binding={...f.binding('chat'),referenceSources:refs};f.project.nodes.push(node);
 const input={data:f.data,project:f.project,node,binding,parents:new Set(),text:node.text},step=await llmStep(input);assert.equal(step.videoSamples.length,3);step.authorization=auth(f,'chat-test');const parent='parent-llm';f.activeJobs.set(parent,{kind:'canvas-run',projectId:f.project.id,controller:new AbortController()});const service=canvasLlmService(f),j=await service.startFromCanvas(step,f.project,{apiKey:key,requestId:randomUUID()},parent);assert.equal((await done(f,j.id)).status,'completed');assert.equal(encodedImages(f.calls[0]).length,26);assert.deepEqual(encodedImages(f.calls[0]).slice(0,8),f.buffers.slice(0,8));
 await assert.rejects(llmStep({...input,binding:{...binding,referenceSources:f.refs.slice(0,9)}}),/8张/);await assert.rejects(llmStep({...input,binding:{...binding,referenceSources:videos.map(a=>({assetId:a.id}))}}),/3份/);
 const dynamic=Array.from({length:9},(_,i)=>makeNode('image',i*50,0,{params:{imageBinding:f.binding('image')}}));f.project.nodes.push(...dynamic);await assert.rejects(llmStep({...input,parents:new Set(dynamic.map(n=>n.id)),binding:{...binding,referenceSources:dynamic.map(n=>({sourceNodeId:n.id}))}}),/8张/);assert.equal(f.calls.length,1);f.activeJobs.delete(parent);
});
test('完整备份v9迁移20图绑定/创作台/Agent并可继续编辑；旧版8参考草稿仍可读',async t=>{
 const f=await fixture(t),c=await send(f,'agent'),node=f.project.nodes[0];node.text='继续创作';node.params.imageBinding=f.binding('image');const llm=makeNode('text',500,0,{text:'概括图片',params:{llmBinding:{...f.binding('chat'),referenceSources:f.refs.slice(0,8)}}}),studioNode=makeNode('image',900,0,{text:'整合参考',params:{studioBinding:{mode:'image',config:{protocol:'studio',baseUrl:f.base+'/v1',model:'image-test'},referenceSources:f.refs}}});f.project.nodes.push(llm,studioNode);
 let studio=await f.studios.create({projectId:f.project.id,mode:'image'});studio=await f.studios.save(studio.id,{...studio,prompt:'全部参考',references:f.refs,config:{...studio.config,baseUrl:f.base+'/v1',model:'image-test'}});const bundles=projectBundleService(f),out=await bundles.exportBundle(f.project.id,0);assert.equal(out.formatVersion,9);const raw=await fs.readFile(await bundles.download(out.id));
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-reference-restored-'));let imported;const projects={load:async id=>{if(imported?.id===id)return imported;throw userError('项目不存在',404);},save:async p=>(imported=p)},target=projectBundleService({data,activeJobs:new Map(),projects}),preview=await target.upload(Readable.from([raw]));await target.importBundle(preview.id);
 const expected=f.refs.map(r=>imported.assets.find(a=>a.name===f.assets.find(a=>a.id===r.assetId).name).id);assert.deepEqual(imported.nodes[0].params.imageBinding.referenceSources.map(r=>r.assetId),expected);assert.equal(imported.nodes[1].params.llmBinding.referenceSources.length,8);assert.deepEqual(imported.nodes[2].params.studioBinding.referenceSources.map(r=>r.assetId),expected);
 const activeJobs=new Map(),restored={...f,data,project:imported,projects,activeJobs};restored.conversations=conversationService(restored);const list=await restored.conversations.list(imported.id),chat=await restored.conversations.get(list[0].id);assert.notEqual(chat.id,c.id);assert.deepEqual(chat.messages.at(-1).usedReferenceIds,expected);await send(restored,'image',expected,chat);assert.deepEqual(f.calls.at(-1).images,f.buffers.slice(0,20));const studios=creationStudioService(restored),saved=await studios.get((await studios.list(imported.id))[0].id);assert.deepEqual(saved.references.map(r=>r.assetId),expected);
 const length=raw.readUInt32BE(magic.length),manifest=JSON.parse(raw.subarray(magic.length+4,magic.length+4+length));manifest.version=8;const json=Buffer.from(JSON.stringify(manifest)),len=Buffer.alloc(4);len.writeUInt32BE(json.length);await assert.rejects(target.upload(Readable.from([magic,len,json,raw.subarray(magic.length+4+length)])),/第9版/);
 const legacy=await fixture(t);let old=await legacy.studios.create({projectId:legacy.project.id,mode:'video'});await legacy.studios.save(old.id,{...old,references:legacy.refs.slice(0,8)});const oldBundles=projectBundleService(legacy),e=await oldBundles.exportBundle(legacy.project.id,0);assert.equal(e.formatVersion,1);const check=await target.upload(Readable.from([await fs.readFile(await oldBundles.download(e.id))]));assert.equal(check.studios,1);
});
test('20张数量扩容不放宽合计大小，过大图片对话/画布/创作台均零提交拒绝',async t=>{
 const f=await fixture(t),large=Buffer.alloc(10*1024*1024);f.buffers[0].copy(large);const assets=[];for(let i=0;i<5;i++)assets.push(await storeAsset(f.data,large,{name:'合计限制'+i+'.png',type:'image/png'}));f.project.assets.push(...assets);const refs=assets.map(a=>({assetId:a.id}));
 await assert.rejects(send(f,'image',assets.map(a=>a.id)),/合计过大/);await assert.rejects(send(f,'chat',assets.map(a=>a.id)),/合计过大/);await assert.rejects(send(f,'agent',assets.map(a=>a.id)),/合计过大/);
 const node=f.project.nodes[0];node.text='检查过大参考';await assert.rejects(imageStep({data:f.data,project:f.project,node,binding:{...f.binding('image'),referenceSources:refs},parents:new Set(),text:node.text}),/合计过大/);await assert.rejects(studioStep({data:f.data,project:f.project,node,binding:{mode:'image',config:{protocol:'studio',baseUrl:f.base+'/v1',model:'image-test'},referenceSources:refs},parents:new Set(),text:node.text}),/合计过大/);
 let studio=await f.studios.create({projectId:f.project.id,mode:'image'});studio=await f.studios.save(studio.id,{...studio,prompt:'太大的参考',references:refs,config:{...studio.config,baseUrl:f.base+'/v1',model:'image-test'}});await assert.rejects(f.studios.start(studio.id,{revision:studio.revision,requestId:randomUUID(),apiKey:key,authorization:auth(f,'image-test')}),/合计过大/);assert.equal(f.calls.length,0);assert.equal((await records(path.join(f.data,'jobs'))).length,0);
});
