import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {once} from 'node:events';
import {creationStudioService,normalizeStudio,validateStudioReferences} from '../lib/creation-studio.mjs';
import {prepareArkReferences,assertArkEncodedSize} from '../lib/ark-references.mjs';
import {normalizeStudioBinding,studioStep,resolveStudio,studioCredentials} from '../lib/canvas-studio.mjs';
import {makeProject,makeNode} from '../lib/model.mjs';
import {connectionMediaMapping} from '../lib/canvas-tools.mjs';
import {storeAsset,readJson,atomicJson,records} from '../lib/workspace.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';

const key='synthetic-ark-reference-key',sleep=ms=>new Promise(r=>setTimeout(r,ms));
const image=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:size=480x320','-frames:v','1','-f','image2pipe','-c:v','png','pipe:1']);
const audio=(duration=2,freq=440)=>execFileSync('ffmpeg',['-v','error','-f','lavfi','-i',`sine=frequency=${freq}:sample_rate=16000`,'-t',String(duration),'-c:a','pcm_s16le','-f','wav','pipe:1']);
const wav=audio(),mp4=Buffer.from('000000186674797069736f6d0000020069736f6d69736f32','hex');
const external=(type,url)=>({type,url});
async function fixture(t){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-ark-references-')),activeJobs=new Map(),calls=[];let base,pending=false;
 const mock=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);res.setHeader('content-type','application/json');
  if(req.method==='POST'){calls.push({url:req.url,body:JSON.parse(Buffer.concat(chunks))});return res.end(JSON.stringify({id:'ark-multi'}));}
  if(req.url==='/v1/contents/generations/tasks/ark-multi')return res.end(JSON.stringify({status:pending?'running':'succeeded',content:{video_url:base+'/video.mp4'}}));
  if(req.url==='/video.mp4'){res.setHeader('content-type','video/mp4');return res.end(mp4);}res.statusCode=404;res.end('{}');
 });mock.listen(0,'127.0.0.1');await once(mock,'listening');base='http://127.0.0.1:'+mock.address().port;t.after(()=>new Promise(r=>{mock.closeAllConnections();mock.close(r);}));
 const service=creationStudioService({data,activeJobs,pollInterval:10});let s=await service.create({mode:'video'});s=await service.save(s.id,{...s,prompt:'参考图1的蓝色，视频1的运动与音频1的节奏',config:{...s.config,baseUrl:base+'/v1',protocol:'ark',model:'doubao-seedance-2-0-260128',arkReferenceMode:'multimodal'}});
 const add=async(bytes,type,name)=>storeAsset(data,bytes,{type,name});const imageAsset=await add(image,'image/png','参考图.png'),audioAsset=await add(wav,'audio/wav','节奏.wav');
 const save=async refs=>(s=await service.save(s.id,{...s,references:refs}));
 const auth=sendOriginalMedia=>({origin:base,model:s.config.model,budget:3,currency:'CNY',sendPrompt:true,sendReferences:s.references.length>0,requestLimit:1,...(sendOriginalMedia!==undefined?{sendOriginalMedia}:{})});
 const start=async(id='once',extra={})=>service.start(s.id,{requestId:id,revision:s.revision,apiKey:key,authorization:auth(true),referenceFingerprint:(await service.preview(s.id)).fingerprint,...extra});
 return {data,service,activeJobs,calls,base,imageAsset,audioAsset,add,save,auth,start,get studio(){return s;},setPending:v=>pending=v};
}
async function wait(f,id,predicate){for(let i=0;i<500;i++){const j=await readJson(path.join(f.data,'jobs',id+'.json'));if(predicate(j))return j;await sleep(10);}throw Error('owned mock job timeout');}
async function noKey(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())await noKey(file);else assert.equal((await fs.readFile(file)).includes(Buffer.from(key)),false,file);}}

test('方舟旧项目保持首尾帧；多参考限制、类型、模型系列和URL按契约检查',async t=>{
 const f=await fixture(t),legacy=normalizeStudio({...f.studio,config:{...f.studio.config,arkReferenceMode:undefined}});assert.equal(legacy.config.arkReferenceMode,'frames');validateStudioReferences(legacy,[{type:'image/png'},{type:'image/png'}]);assert.throws(()=>validateStudioReferences(legacy,[{type:'audio/wav'}]),/首尾帧/);
 const full=[...Array.from({length:9},(_,i)=>external('image/png','https://media.example.test/i'+i)),...Array.from({length:3},(_,i)=>external('video/mp4','asset://video-'+i)),...Array.from({length:3},(_,i)=>external('audio/wav','asset://audio-'+i))];validateStudioReferences(f.studio,full);assert.equal(normalizeStudio({...f.studio,references:full}).references.length,15);
 assert.throws(()=>validateStudioReferences(f.studio,[...full,external('audio/wav','asset://extra')]));assert.throws(()=>validateStudioReferences(f.studio,[{type:'audio/wav'}]),/不能仅/);assert.throws(()=>validateStudioReferences(f.studio,[{type:'video/mp4',assetId:'local'}]),/公网/);assert.throws(()=>validateStudioReferences({...f.studio,config:{...f.studio.config,model:'doubao-seedance-2-5-260928'}},full),/2.0/);validateStudioReferences({...f.studio,config:{...f.studio.config,model:'ep-owned-model'}},full);
 for(const url of ['http://127.0.0.1/clip','https://127.0.0.1/clip','https://192.168.1.1/clip','https://media.example.test/clip?token=secret','https://user:pw@media.example.test/clip','asset://x/y','asset://x?key=secret','blob:clip'])assert.throws(()=>normalizeStudio({...f.studio,references:[external('video/mp4',url)]}));
 assert.throws(()=>normalizeStudio({...f.studio,references:[full[0],full[0]]}),/重复/);assert.equal(f.calls.length,0);
});
test('混合原文件本机预览、独立发送授权、角色顺序与音频字节，双击只提交一次',async t=>{
 const f=await fixture(t);await f.save([{assetId:f.imageAsset.id},external('video/mp4','asset://owned-video'),{assetId:f.audioAsset.id}]);const preview=await f.service.preview(f.studio.id);assert.equal(f.calls.length,0);assert.equal((await records(path.join(f.data,'jobs'))).length,0);assert.deepEqual(preview.counts,{image:1,video:1,audio:1});assert.equal(preview.knownAudioDuration,2);assert.equal(preview.inputs[0].width,480);assert.equal(preview.inputs[2].size,wav.length);assert.equal(preview.inputs[1].verified,false);assert.ok(preview.sendOriginalMedia);assert.ok(!JSON.stringify(preview).includes('base64'));
 await assert.rejects(f.start('bad-preview',{referenceFingerprint:'old'}),/重新预览/);await assert.rejects(f.start('no-original',{authorization:f.auth(false)}),/单独确认/);assert.equal(f.calls.length,0);
 const [a,b]=await Promise.all([f.start(),f.start()]);assert.equal(a.id,b.id);const j=await wait(f,a.id,j=>j.status==='completed'||j.status==='failed');assert.equal(j.status,'completed',j.message);assert.equal(f.calls.length,1);const content=f.calls[0].body.content;assert.deepEqual(content.map(x=>x.type),['text','image_url','video_url','audio_url']);assert.deepEqual(content.slice(1).map(x=>x.role),['reference_image','reference_video','reference_audio']);assert.equal(content[2].video_url.url,'asset://owned-video');assert.deepEqual(Buffer.from(content[1].image_url.url.split(',')[1],'base64'),image);assert.deepEqual(Buffer.from(content[3].audio_url.url.split(',')[1],'base64'),wav);assert.match(content[3].audio_url.url,/^data:audio\/wav;base64,/);assert.equal(j.requestCount,1);assert.equal(j.referencePlan.fingerprint,preview.fingerprint);assert.equal(j.authorization.sendOriginalMedia,true);assert.equal(j.assets.length,1);await noKey(f.data);
});
test('真实音频时长、总时长、图片尺寸、伪造媒体和符号链接在生成前拒绝',async t=>{
 const f=await fixture(t),check=async a=>{await f.save([{assetId:f.imageAsset.id},{assetId:a.id}]);await assert.rejects(f.service.preview(f.studio.id));};
 await check(await f.add(audio(1),'audio/wav','太短.wav'));await check(await f.add(audio(16),'audio/wav','太长.wav'));await check(await f.add(Buffer.from('RIFF-invalid'),'audio/wav','损坏.wav'));await check(await f.add(wav,'audio/mp4','错误格式.m4a'));
 const audios=[];for(let i=0;i<3;i++)audios.push(await f.add(audio(6,440+i*100),'audio/wav','六秒'+i+'.wav'));await f.save([{assetId:f.imageAsset.id},...audios.map(a=>({assetId:a.id}))]);await assert.rejects(f.service.preview(f.studio.id),/总时长/);
 const small=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=size=150x150','-frames:v','1','-f','image2pipe','-c:v','png','pipe:1']);const a=await f.add(small,'image/png','太小.png');await f.save([{assetId:a.id}]);await assert.rejects(f.service.preview(f.studio.id),/300/);
 const linked='link-audio';await fs.symlink(path.join(f.data,'assets',f.audioAsset.id),path.join(f.data,'assets',linked));await atomicJson(path.join(f.data,'assets',linked+'.json'),{...f.audioAsset,id:linked});await f.save([{assetId:f.imageAsset.id},{assetId:linked}]);await assert.rejects(f.service.preview(f.studio.id),/符号链接/);assert.equal(f.calls.length,0);assert.equal((await records(path.join(f.data,'jobs'))).length,0);
});
test('同大小文件替换使发送确认失效；已知编码大小在48MB上限前拒绝',async t=>{
 const f=await fixture(t);await f.save([{assetId:f.imageAsset.id},{assetId:f.audioAsset.id}]);const preview=await f.service.preview(f.studio.id),changed=audio(2,880);assert.equal(changed.length,wav.length);await fs.writeFile(path.join(f.data,'assets',f.audioAsset.id),changed);await assert.rejects(f.start('changed',{referenceFingerprint:preview.fingerprint}),/内容已变化/);assert.equal(f.calls.length,0);
 assert.ok(assertArkEncodedSize([{size:1},{url:'asset://x'}])<48*1024*1024);assert.throws(()=>assertArkEncodedSize(Array.from({length:9},()=>({size:5*1024*1024}))),/48 MB/);assert.throws(()=>assertArkEncodedSize([{size:-1}]));
});
test('停止后重建执行器按原编号恢复，不重新读取参考或生成',async t=>{
 const f=await fixture(t);await f.save([{assetId:f.imageAsset.id},{assetId:f.audioAsset.id}]);f.setPending(true);const j=await f.start();await wait(f,j.id,j=>!!j.upstreamId);f.activeJobs.get(j.id).controller.abort();await wait(f,j.id,j=>j.status==='cancelled');while(f.activeJobs.size)await sleep(10);await fs.writeFile(path.join(f.data,'assets',f.audioAsset.id),'owned fixture now missing original audio');f.setPending(false);
 const restored=creationStudioService({data:f.data,activeJobs:f.activeJobs,pollInterval:10});await restored.resume(f.studio.id,j.id,{apiKey:key});const result=await wait(f,j.id,j=>j.status==='completed');assert.equal(result.upstreamId,'ark-multi');assert.equal(f.calls.length,1);assert.equal(result.requestCount,1);await noKey(f.data);
});
test('画布静态与动态原音频映射、已知文件检查、自动连线分类和独立授权',async t=>{
 const f=await fixture(t),project=makeProject('混合画布'),a=makeNode('audio',0,0,{title:'音频',text:'节奏'}),n=makeNode('video',400,0,{title:'方舟',text:'推近'});a.assetId=f.audioAsset.id;project.nodes=[a,n];project.assets=[f.imageAsset,f.audioAsset];project.edges=[{id:'a-n',source:a.id,target:n.id}];const b=normalizeStudioBinding({mode:'video',config:f.studio.config,referenceSources:[{assetId:f.imageAsset.id},{sourceNodeId:a.id},external('video/mp4','asset://clip')]});n.params.studioBinding=structuredClone(b);
 const step=await studioStep({data:f.data,project,node:n,binding:b,parents:new Set([a.id]),text:'推近'});assert.ok(step.sendOriginalMedia);assert.equal(step.referenceInputs.length,2);const resolved=resolveStudio(step,project);assert.equal(resolved.references[1].assetId,f.audioAsset.id);assert.deepEqual(resolved.references[2],external('video/mp4','asset://clip'));
 const credentials=sendOriginalMedia=>({studioCredentials:[{nodeId:n.id,apiKey:key,authorization:{...f.auth(sendOriginalMedia),sendReferences:true}}]});assert.throws(()=>studioCredentials([structuredClone(step)],credentials(false)),/单独确认/);const copy=structuredClone(step);assert.equal(studioCredentials([copy],credentials(true)).get(n.id),key);assert.ok(copy.authorization.sendOriginalMedia);
 n.params.studioBinding.referenceSources=[];assert.deepEqual(connectionMediaMapping(project,a.id,n.id),{targetId:n.id,bindingKey:'studioBinding',reference:{sourceNodeId:a.id}});n.params.studioBinding.referenceSources=Array.from({length:3},(_,i)=>external('audio/wav','asset://a'+i));assert.equal(connectionMediaMapping(project,a.id,n.id),null);
 a.params.workflowBinding={workflowId:'will-generate-audio'};const dynamic=await studioStep({data:f.data,project,node:n,binding:b,parents:new Set([a.id]),text:'动态音频'});assert.equal(dynamic.referenceInputs.length,1);assert.ok(dynamic.sendOriginalMedia);assert.equal(f.calls.length,0);
});
test('第15版备份跨工作区恢复多素材类型、平台编号与本机映射，伪造旧版本拒绝',async t=>{
 const f=await fixture(t),p=makeProject('便携多参考'),projects={load:async()=>p,save:async v=>atomicJson(path.join(f.data,'projects',v.id,'project.json'),v)};p.assets=[f.imageAsset,f.audioAsset];p.nodes[0].type='video';p.nodes[0].params.studioBinding=normalizeStudioBinding({mode:'video',config:f.studio.config,referenceSources:[{assetId:f.imageAsset.id},{assetId:f.audioAsset.id},external('video/mp4','asset://clip')]});await projects.save(p);
 await f.save([{assetId:f.imageAsset.id},{assetId:f.audioAsset.id},external('audio/mpeg','asset://music')]);const file=path.join(f.data,'studios',f.studio.id,'studio.json'),s=await readJson(file);s.projectId=p.id;await atomicJson(file,s);
 const service=projectBundleService({data:f.data,activeJobs:f.activeJobs,projects}),pack=await service.exportBundle(p.id,p.revision),exported=await service.download(pack.id),bytes=await fs.readFile(exported),magic=Buffer.from('JINGCHANG-PACK-1\n'),length=bytes.readUInt32BE(magic.length),manifest=JSON.parse(bytes.subarray(magic.length+4,magic.length+4+length));assert.equal(manifest.version,15);
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-ark-restored-')),targetProjects={load:async id=>readJson(path.join(data,'projects',id,'project.json')),save:async v=>{await atomicJson(path.join(data,'projects',v.id,'project.json'),v);return v;}},target=projectBundleService({data,activeJobs:new Map(),projects:targetProjects});const preview=await target.upload(createReadStream(exported)),restored=await target.importBundle(preview.id);assert.notEqual(restored.id,p.id);const refs=restored.nodes[0].params.studioBinding.referenceSources;assert.notEqual(refs[1].assetId,f.audioAsset.id);assert.deepEqual(refs[2],external('video/mp4','asset://clip'));const studios=creationStudioService({data,activeJobs:new Map(),projects:targetProjects});const list=await studios.list(restored.id),restoredStudio=await studios.get(list[0].id);assert.equal(restoredStudio.config.arkReferenceMode,'multimodal');assert.deepEqual(restoredStudio.references[2],external('audio/mpeg','asset://music'));
 manifest.version=14;const json=Buffer.from(JSON.stringify(manifest)),head=Buffer.alloc(4);head.writeUInt32BE(json.length);await assert.rejects(target.upload(Readable.from([Buffer.concat([magic,head,json,bytes.subarray(magic.length+4+length)])])),/15版/);await noKey(f.data);
});
