import {createCanvas,loadImage} from '@napi-rs/canvas';
import {generationService} from '../lib/generation.mjs';
import './helpers/local-network-only.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {promises as fs,createReadStream} from 'node:fs';
import {execFileSync} from 'node:child_process';
import http from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {storeAsset,readJson,atomicJson} from '../lib/workspace.mjs';
import {sampleVideoUniformForChat} from '../lib/media-tools.mjs';
import {VIDEO_SAMPLING_METHOD,LEGACY_VIDEO_SAMPLING_METHOD} from '../public/video-sampling.js';
import {prepareChatMedia,chatReferenceParts,loadChatVideoSamples,normalizeVideoSample} from '../lib/chat-media.mjs';
import {conversationService} from '../lib/conversations.mjs';
import {canvasLlmService,llmStep} from '../lib/canvas-llm.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';
import {makeProject,makeNode} from '../lib/model.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {applyCanvasResults} from '../lib/generation-results.mjs';
import {Readable} from 'node:stream';
import {diagnostics} from '../lib/diagnostics.mjs';

const key='synthetic-chat-video-key',hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const mp4=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x96:rate=4','-t','2','-an','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-f','mp4','-movflags','frag_keyframe+empty_moov','pipe:1']);
const slow=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=red:size=32x48:rate=1','-t','1','-an','-c:v','libx264','-threads','1','-f','mp4','-movflags','frag_keyframe+empty_moov','pipe:1']);
const png=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=blue:size=16x16','-frames:v','1','-threads','1','-f','image2pipe','-c:v','png','pipe:1']);
async function fixture(t){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-video-chat-')),activeJobs=new Map(),calls=[],state={mode:'normal',held:[]};
 const mock=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));calls.push(body);if(state.mode==='network')return res.destroy();if(body.stream){res.setHeader('content-type','text/event-stream');res.write('data: '+JSON.stringify({choices:[{index:0,delta:{content:'抽样显示彩色画面'},finish_reason:null}]})+'\n\n');if(state.mode==='hold'){state.held.push(res);return;}if(state.mode==='broken')return res.end();return res.end('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');}res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'已分析画面 '+(state.mode==='key'?key:'')},finish_reason:'stop'}]}));});mock.listen(0,'127.0.0.1');await once(mock,'listening');t.after(()=>{mock.closeAllConnections();return new Promise(r=>mock.close(r));});
 const base='http://127.0.0.1:'+mock.address().port,platform={id:'video-chat-platform',name:'本地测试',protocol:'openai-compatible',baseUrl:base+'/v1',models:[{id:'vision',category:'chat',referenceSupport:true},{id:'text',category:'chat',referenceSupport:false}]},platforms={get:async()=>platform};
 const project=makeProject('视频理解测试'),projects={load:async()=>project,apply:async()=>project};
 const service=conversationService({data,activeJobs,platforms,projects});
 const video=await storeAsset(data,mp4,{name:'参考.mp4',type:'video/mp4'});project.assets.push(video);
 const auth={origin:base,model:'vision',sendPrompt:true,sendReferences:true,requestLimit:1,budget:1,currency:'CNY'};
 const body=(c,extra={})=>({revision:c.revision,requestId:'video-first',text:'比较视频开头和结尾',assetIds:[video.id],platformId:platform.id,model:'vision',apiKey:key,authorization:auth,...extra});
 return{generation:generationService({data,activeJobs}),data,activeJobs,calls,state,base,platform,platforms,project,projects,service,video,auth,body};
}
async function complete(data,id){for(let i=0;i<500;i++){const j=await readJson(path.join(data,'jobs',id+'.json'));if(!['queued','running'].includes(j.status))return j;await new Promise(r=>setTimeout(r,10));}throw Error('job timeout');}
const imageUrls=body=>body.messages.flatMap(m=>Array.isArray(m.content)?m.content.filter(c=>c.type==='image_url').map(c=>c.image_url.url):[]);
async function preview(f){return prepareChatMedia({data:f.data,assetIds:[f.video.id]});}
async function assertNoKey(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())await assertNoKey(file);else assert.equal((await fs.readFile(file)).includes(Buffer.from(key)),false,file);}}

test('本机逐秒抽样实际JPEG可解码，并发及重启复用同一批帧',async t=>{
 const f=await fixture(t),[a,b]=await Promise.all([preview(f),preview(f)]);assert.deepEqual(a.videoSamples,b.videoSamples);assert.equal(f.calls.length,0);
 const s=a.videoSamples[0];assert.equal(s.duration,2);assert.equal(s.frames.length,2);assert.equal(s.frames[0].time,0);assert.ok(s.frames.at(-1).time===1);
 const refs=await chatReferenceParts({data:f.data,assetIds:[f.video.id],videoSamples:a.videoSamples});assert.equal(refs.parts.filter(p=>p.type==='image_url').length,2);assert.match(refs.parts[0].text,/未提供音频/);
 for(const frame of s.frames){const bytes=await fs.readFile(path.join(f.data,'assets',frame.assetId));assert.equal(hash(bytes),frame.sha256);const image=await loadImage(bytes);assert.equal(bytes[0],255);assert.equal(bytes[1],216);assert.equal(image.width,160);assert.equal(image.height,96);}
 const size=(await fs.readdir(path.join(f.data,'assets'))).length;assert.deepEqual(await preview(f),a);assert.equal((await fs.readdir(path.join(f.data,'assets'))).length,size);
});
test('一帧短视频按实际数量保留画面；MP4/MOV/WebM均本地处理',async t=>{
 const f=await fixture(t),single=await storeAsset(f.data,slow,{name:'短.mp4',type:'video/mp4'}),a=await prepareChatMedia({data:f.data,assetIds:[single.id]});assert.equal(a.videoSamples[0].frames.length,1);assert.equal(new Set(a.videoSamples[0].frames.map(f=>f.sha256)).size,1);
 const mov=await storeAsset(f.data,mp4,{name:'视频.mov',type:'video/quicktime'}),webmBytes=execFileSync('ffmpeg',['-v','error','-i','pipe:0','-an','-c:v','libvpx-vp9','-threads','1','-f','webm','pipe:1'],{input:mp4}),webm=await storeAsset(f.data,webmBytes,{name:'视频.webm',type:'video/webm'});assert.equal((await prepareChatMedia({data:f.data,assetIds:[mov.id,webm.id]})).videoSamples.length,2);
});
test('视频预览、模型图片能力、历史发送范围及数量校验均在零请求前拒绝',async t=>{
 const f=await fixture(t),c=await f.service.create({projectId:f.project.id});await assert.rejects(f.service.send(c.id,f.body(c)),/准备.*预览/);
 const p=await preview(f),extra={videoSampleIds:p.videoSamples.map(s=>s.id)};
 await assert.rejects(f.service.send(c.id,f.body(c,{...extra,model:'text',authorization:{...f.auth,model:'text'}})),/图片输入/);
 await assert.rejects(f.service.send(c.id,f.body(c,{...extra,authorization:{...f.auth,sendReferences:false}})),/确认/);
 await assert.rejects(loadChatVideoSamples({data:f.data,assetIds:[],videoSampleIds:extra.videoSampleIds}),/不匹配/);
 const copies=[];for(let i=0;i<3;i++)copies.push(await storeAsset(f.data,mp4,{name:'v.mp4',type:'video/mp4'}));await assert.rejects(prepareChatMedia({data:f.data,assetIds:[f.video.id,...copies.map(a=>a.id)]}),/最多3/);
 await assert.rejects(prepareChatMedia({data:f.data,assetIds:[f.video.id,f.video.id]}),/最多选择/);assert.equal(f.calls.length,0);assert.equal((await f.service.get(c.id)).messages.length,0);
});
test('一次提交只发送抽样图，历史多轮沿用同一批图；并发请求及重启不重发',async t=>{
 const f=await fixture(t),p=await preview(f),c=await f.service.create({projectId:f.project.id}),b=f.body(c,{videoSampleIds:p.videoSamples.map(s=>s.id),stream:true}),[one,two]=await Promise.all([f.service.send(c.id,structuredClone(b)),f.service.send(c.id,structuredClone(b))]);assert.equal(one.id,two.id);assert.equal((await complete(f.data,one.id)).status,'completed');assert.equal(f.calls.length,1);assert.equal(imageUrls(f.calls[0]).length,2);assert.equal(JSON.stringify(f.calls[0]).includes(mp4.toString('base64')),false);assert.equal(JSON.stringify(f.calls[0]).includes('video_url'),false);
 const current=await f.service.get(c.id);assert.deepEqual(current.messages[0].videoSamples,p.videoSamples);const restored=conversationService({...f});await restored.recover();f.state.mode='key';const next=await restored.send(c.id,f.body(current,{requestId:'video-next',assetIds:[],stream:false}));assert.equal((await complete(f.data,next.id)).status,'completed');assert.deepEqual(imageUrls(f.calls[1]),imageUrls(f.calls[0]));assert.equal(f.calls[1].messages.length,3);assert.equal((await restored.get(c.id)).messages.at(-1).text,'已分析画面 [已隐藏密钥]');await assertNoKey(f.data);
});
test('不完整片段不进入下次上下文，视频引用保留；断流和停止不自动重发',async t=>{
 const f=await fixture(t),p=await preview(f),c=await f.service.create({projectId:f.project.id}),b=f.body(c,{videoSampleIds:p.videoSamples.map(s=>s.id),stream:true});f.state.mode='broken';const j=await f.service.send(c.id,structuredClone(b));assert.equal((await complete(f.data,j.id)).status,'failed');assert.equal((await f.service.send(c.id,b)).id,j.id);f.state.mode='hold';const current=await f.service.get(c.id),next=await f.service.send(c.id,f.body(current,{requestId:'holding',assetIds:[],stream:true}));for(let i=0;i<200&&!f.state.held.length;i++)await new Promise(r=>setTimeout(r,10));assert.equal(f.calls[1].messages.length,2);assert.equal(imageUrls(f.calls[1]).length,2);f.activeJobs.get(next.id).controller.abort();assert.equal((await complete(f.data,next.id)).status,'cancelled');await f.service.recover();assert.equal(f.calls.length,2);
});
test('伪装视频、文件链接和抽样篡改均拒绝，原始素材保持不变',async t=>{
 const f=await fixture(t),fake=await storeAsset(f.data,Buffer.from('#EXTM3U\nhttp://127.0.0.1/private\n'),{name:'fake.mp4',type:'video/mp4'});await assert.rejects(prepareChatMedia({data:f.data,assetIds:[fake.id]}),/媒体处理失败/);
 const a=await preview(f),s=a.videoSamples[0],target=path.join(f.data,'assets',s.frames[0].assetId);await fs.writeFile(target,Buffer.alloc((await fs.stat(target)).size));await assert.rejects(chatReferenceParts({data:f.data,assetIds:[f.video.id],videoSamples:[s]}),/抽样图片已变化/);
 const linked='linked-source';await fs.symlink(path.join(f.data,'assets',f.video.id),path.join(f.data,'assets',linked));await atomicJson(path.join(f.data,'assets',linked+'.json'),{...f.video,id:linked});await assert.rejects(prepareChatMedia({data:f.data,assetIds:[linked]}),/本地文件/);assert.deepEqual(await fs.readFile(path.join(f.data,'assets',f.video.id)),mp4);assert.equal(f.calls.length,0);
});
test('备份v11包含未放入画布的视频及抽样，空白目录恢复继续追问保持相同图片',async t=>{
 const f=await fixture(t),p=await preview(f),c=await f.service.create({projectId:f.project.id}),job=await f.service.send(c.id,f.body(c,{videoSampleIds:p.videoSamples.map(s=>s.id)}));await complete(f.data,job.id);f.project.assets=[];
 const bundles=projectBundleService(f),out=await bundles.exportBundle(f.project.id,0);assert.equal(out.formatVersion,11);assert.equal(out.assets,3);
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-chat-video-import-'));let imported;const projects={load:async()=>{if(imported)return imported;throw Object.assign(Error('missing'),{status:404});},save:async p=>(imported=p)},target=projectBundleService({data,activeJobs:new Map(),projects}),inspection=await target.upload(createReadStream(await bundles.download(out.id)));await target.importBundle(inspection.id);
 const files=await fs.readdir(path.join(data,'conversations')),current=await readJson(path.join(data,'conversations',files[0]));assert.notEqual(current.messages[0].assetIds[0],f.video.id);assert.notEqual(current.messages[0].videoSamples[0].frames[0].assetId,p.videoSamples[0].frames[0].assetId);
 const service=conversationService({data,activeJobs:new Map(),platforms:f.platforms,projects}),next=await service.send(current.id,f.body(current,{requestId:'after-import',assetIds:[]}));assert.equal((await complete(data,next.id)).status,'completed');assert.deepEqual(imageUrls(f.calls.at(-1)),imageUrls(f.calls[0]));await assertNoKey(data);
});
test('画布静态视频预览、动态上游视频抽样、结果回填与原请求幂等',async t=>{
 const f=await fixture(t),source=makeNode('video',0,0,{assetId:f.video.id,title:'参考视频'}),target=makeNode('script',400,0,{text:'描述动作',title:'分析视频'});target.params.llmBinding={platform:f.platform,model:'vision',stream:true,referenceSources:[{sourceNodeId:source.id}]};f.project.nodes=[source,target];f.project.edges=[{id:'connected',source:source.id,target:target.id}];const canvasLlm=canvasLlmService(f),runner=canvasRunner({...f,canvasLlm,pollInterval:10}),steps=await runner.plan(f.project);assert.equal(steps[0].videoSamples.length,1);
 const b={revision:0,requestId:'canvas-video',consent:true,llmCredentials:[{nodeId:target.id,apiKey:key,authorization:f.auth}]},j=await runner.start(f.project,structuredClone(b),f.base),done=await complete(f.data,j.id);assert.equal(done.status,'completed',done.message);assert.equal(done.textResults.length,1);assert.equal(imageUrls(f.calls[0]).length,2);await applyCanvasResults({...f,job:done,revision:0});assert.equal(f.project.nodes.at(-1).text,'抽样显示彩色画面');assert.equal((await runner.start(f.project,b,f.base)).id,j.id);
 const dynamic=structuredClone(f.project);dynamic.nodes[0].params.studioBinding={};dynamic.nodes[0].assetId=null;const step=await llmStep({data:f.data,project:dynamic,node:target,binding:target.params.llmBinding,parents:new Set([source.id]),text:'本轮视频'});assert.equal(step.videoSamples.length,0);dynamic.nodes[0].assetId=f.video.id;step.authorization=f.auth;f.activeJobs.set('parent-test',{kind:'canvas-run',projectId:dynamic.id,controller:new AbortController()});const child=await canvasLlm.startFromCanvas(step,dynamic,{apiKey:key,requestId:'dynamic-video'},'parent-test');assert.equal((await complete(f.data,child.id)).status,'completed');assert.deepEqual(imageUrls(f.calls[1]),imageUrls(f.calls[0]));
});
test('画布拒绝非上游、非项目视频与已变化的静态预览，取消父任务不提交模型',async t=>{
 const f=await fixture(t),node=makeNode('script',0,0,{text:'分析'}),binding={platform:f.platform,model:'vision',referenceSources:[{assetId:f.video.id}]};const step=await llmStep({data:f.data,project:f.project,node,binding,parents:new Set(),text:'分析'});step.authorization=f.auth;
 await assert.rejects(llmStep({data:f.data,project:f.project,node,binding:{...binding,referenceSources:[{sourceNodeId:'missing'}]},parents:new Set(),text:'分析'}),/相连上游/);
 const service=canvasLlmService(f),controller=new AbortController();f.activeJobs.set('parent-stop',{kind:'canvas-run',projectId:f.project.id,controller});controller.abort();await assert.rejects(service.startFromCanvas(step,f.project,{apiKey:key,requestId:'cancelled-before-call'},'parent-stop'));
 const sample=step.videoSamples[0];await fs.writeFile(path.join(f.data,'assets',f.video.id),Buffer.alloc(mp4.length));await assert.rejects(chatReferenceParts({data:f.data,assetIds:[f.video.id],videoSamples:[sample]}),/原文件已变化/);assert.equal(f.calls.length,0);
});
test('视频备份拒绝版本降级、错配原片、缺少帧、重复样本，并诊断丢失引用',async t=>{
 const f=await fixture(t),prepared=await preview(f),c=await f.service.create({projectId:f.project.id}),j=await f.service.send(c.id,f.body(c,{videoSampleIds:prepared.videoSamples.map(s=>s.id)}));await complete(f.data,j.id);const bundles=projectBundleService(f),out=await bundles.exportBundle(f.project.id,0),bytes=await fs.readFile(await bundles.download(out.id)),magic=Buffer.from('JINGCHANG-PACK-1\n'),length=bytes.readUInt32BE(magic.length),original=JSON.parse(bytes.subarray(magic.length+4,magic.length+4+length));
 for(const mutate of [m=>m.version=10,m=>m.version=6,m=>m.conversations[0].messages[0].videoSamples[0].sourceSha256='0'.repeat(64),m=>m.conversations[0].messages[0].videoSamples[0].frames[0].assetId='missing-frame',m=>m.conversations[0].messages[0].videoSamples.push(m.conversations[0].messages[0].videoSamples[0]),m=>m.conversations[0].messages[0].videoSamples={length:1}]){const m=structuredClone(original);mutate(m);const json=Buffer.from(JSON.stringify(m)),size=Buffer.alloc(4);size.writeUInt32BE(json.length);await assert.rejects(bundles.upload(Readable.from([magic,size,json,bytes.subarray(magic.length+4+length)])),/备份|抽样|对话视频/);}
 const frame=prepared.videoSamples[0].frames[0].assetId,meta=await readJson(path.join(f.data,'assets',frame+'.json'));await atomicJson(path.join(f.data,'assets',frame+'.json'),{...meta,id:'changed-test-frame-index'});await atomicJson(path.join(f.data,'projects',f.project.id,'project.json'),f.project);const d=await diagnostics({root:process.cwd(),data:f.data,projects:[{id:f.project.id}]});assert.ok(d.missingReferences.some(r=>r.assetId===frame&&r.issue.includes('视频抽样')));assert.equal(f.calls.length,1);
});
test('图片与视频上下文共享24MB编码上限，超限时不产生新模型任务',async t=>{
 const f=await fixture(t),large=await storeAsset(f.data,Buffer.concat([png,Buffer.alloc(5*1024*1024)]),{name:'测试图片.png',type:'image/png'}),c=await f.service.create({projectId:f.project.id});const first=await f.service.send(c.id,f.body(c,{assetIds:[large.id]}));await complete(f.data,first.id);let current=await f.service.get(c.id);
 for(let i=0;i<2;i++){const j=await f.service.send(c.id,f.body(current,{requestId:'size-'+i,assetIds:[large.id]}));await complete(f.data,j.id);current=await f.service.get(c.id);}
 await assert.rejects(f.service.send(c.id,f.body(current,{requestId:'over-cap',assetIds:[large.id]})),/合计过大/);assert.equal(f.calls.length,3);assert.equal((await f.service.get(c.id)).messages.length,6);
});

test('10秒视频的6张JPEG与基准fps=1/宽度缩放逐像素一致，不采片尾；竖屏保留基准高度',async t=>{
 const f=await fixture(t),bytes=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x96:rate=20','-t','10','-an','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-f','mp4','-movflags','frag_keyframe+empty_moov','pipe:1']),video=await storeAsset(f.data,bytes,{name:'十秒.mp4',type:'video/mp4'}),preview=await prepareChatMedia({data:f.data,assetIds:[video.id]}),s=preview.videoSamples[0];assert.equal(s.method,VIDEO_SAMPLING_METHOD);assert.deepEqual(s.frames.map(f=>f.time),[0,1,2,3,4,5]);assert.equal(s.fallback,undefined);
 const expected=await fs.mkdtemp(path.join(os.tmpdir(),'jc-fps-reference-'));
 // The reference filter, not our sampler implementation, is the pixel oracle.
 // yuvj420p makes its JPEG output valid on this FFmpeg 9 installation.
 execFileSync('ffmpeg',['-v','error','-threads','1','-i',path.join(f.data,'assets',video.id),'-vf',"fps=1,scale='min(768,iw)':-2",'-frames:v','6','-pix_fmt','yuvj420p','-threads','1',path.join(expected,'frame_%03d.jpg')]);
 async function pixels(file){const im=await loadImage(await fs.readFile(file)),c=createCanvas(im.width,im.height),ctx=c.getContext('2d');ctx.drawImage(im,0,0);return {width:im.width,height:im.height,rgba:Buffer.from(ctx.getImageData(0,0,im.width,im.height).data)};}
 for(let i=0;i<6;i++)assert.deepEqual(await pixels(path.join(f.data,'assets',s.frames[i].assetId)),await pixels(path.join(expected,`frame_${String(i+1).padStart(3,'0')}.jpg`)));
 const portrait=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=960x1600:rate=2','-t','1','-an','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-f','mp4','-movflags','frag_keyframe+empty_moov','pipe:1']),p=await storeAsset(f.data,portrait,{name:'竖屏.mp4',type:'video/mp4'}),sample=(await prepareChatMedia({data:f.data,assetIds:[p.id]})).videoSamples[0],im=await loadImage(await fs.readFile(path.join(f.data,'assets',sample.frames[0].assetId)));assert.equal(im.width,768);assert.equal(im.height,1280);assert.equal(f.calls.length,0);
});

test('不足半秒视频明确首帧回退，不复制成六帧；预览、发送、v11备份保留回退标志',async t=>{
 const f=await fixture(t),bytes=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=blue:size=48x32:rate=20','-t','0.2','-an','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-f','mp4','-movflags','frag_keyframe+empty_moov','pipe:1']),video=await storeAsset(f.data,bytes,{name:'极短.mp4',type:'video/mp4'}),p=await prepareChatMedia({data:f.data,assetIds:[video.id]}),s=p.videoSamples[0];assert.equal(s.frames.length,1);assert.equal(s.fallback,'first-frame');assert.equal(s.frames[0].time,0);const c=await f.service.create({projectId:f.project.id}),j=await f.service.send(c.id,f.body(c,{assetIds:[video.id],videoSampleIds:[s.id]}));assert.equal((await complete(f.data,j.id)).status,'completed');assert.equal(imageUrls(f.calls[0]).length,1);assert.match(JSON.stringify(f.calls[0]),/逐秒抽样无画面，使用首帧/);const b=projectBundleService(f),e=await b.exportBundle(f.project.id,0),bytesOut=await fs.readFile(await b.download(e.id));assert.equal(e.formatVersion,11);assert.ok(bytesOut.includes(Buffer.from('first-frame')));assert.equal(f.calls.length,1);
});

test('旧uniform缓存及v7备份继续使用原6张PNG，新逐秒缓存独立；混合历史恢复保留8张实际画面',async t=>{
 const f=await fixture(t),old=await sampleVideoUniformForChat({data:f.data,assetId:f.video.id}),sourceSha256=hash(mp4),legacy={id:hash(LEGACY_VIDEO_SAMPLING_METHOD+':'+f.video.id+':'+sourceSha256),assetId:f.video.id,method:LEGACY_VIDEO_SAMPLING_METHOD,sourceSha256,duration:old.duration,frames:[]};
 for(const frame of old.frames)legacy.frames.push({...frame,sha256:hash(await fs.readFile(path.join(f.data,'assets',frame.assetId)))});const cache=path.join(f.data,'chat-video-samples',legacy.id+'.json');await atomicJson(cache,legacy);const original=await fs.readFile(cache);const c=await f.service.create({projectId:f.project.id}),first=await f.service.send(c.id,f.body(c,{requestId:'legacy-video',videoSampleIds:[legacy.id]}));assert.equal((await complete(f.data,first.id)).status,'completed');assert.equal(imageUrls(f.calls[0]).length,6);assert.ok(imageUrls(f.calls[0]).every(s=>s.startsWith('data:image/png')));
 const bundles=projectBundleService(f),legacyExport=await bundles.exportBundle(f.project.id,0);assert.equal(legacyExport.formatVersion,7);assert.equal((await bundles.upload(createReadStream(await bundles.download(legacyExport.id)))).formatVersion,7);
 const p=await preview(f),fresh=p.videoSamples[0];assert.equal(fresh.method,VIDEO_SAMPLING_METHOD);assert.notEqual(fresh.id,legacy.id);assert.deepEqual(await fs.readFile(cache),original);for(const frame of legacy.frames)assert.equal(hash(await fs.readFile(path.join(f.data,'assets',frame.assetId))),frame.sha256);
 const second=await f.service.send(c.id,f.body(await f.service.get(c.id),{requestId:'head-video',videoSampleIds:[fresh.id]}));assert.equal((await complete(f.data,second.id)).status,'completed');assert.equal(imageUrls(f.calls[1]).length,8);assert.ok(imageUrls(f.calls[1]).slice(-2).every(s=>s.startsWith('data:image/jpeg')));const e=await bundles.exportBundle(f.project.id,0);assert.equal(e.formatVersion,11);
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-mixed-video-import-'));let imported;const projects={load:async()=>{if(imported)return imported;throw Object.assign(Error('missing'),{status:404});},save:async p=>(imported=p)},activeJobs=new Map(),target=projectBundleService({data,activeJobs,projects}),inspection=await target.upload(createReadStream(await bundles.download(e.id)));await target.importBundle(inspection.id);const files=await fs.readdir(path.join(data,'conversations')),current=await readJson(path.join(data,'conversations',files[0]));assert.deepEqual(current.messages.filter(m=>m.role==='user').map(m=>m.videoSamples[0].method),[LEGACY_VIDEO_SAMPLING_METHOD,VIDEO_SAMPLING_METHOD]);const service=conversationService({data,activeJobs,platforms:f.platforms,projects}),job=await service.send(current.id,f.body(current,{requestId:'mixed-restored',assetIds:[]}));assert.equal((await complete(data,job.id)).status,'completed');assert.deepEqual(imageUrls(f.calls[2]),imageUrls(f.calls[1]));
});

test('视频算法、帧数、逐秒时间及回退标志不可随意拼接，坏预览在模型提交前拒绝',async t=>{
 const f=await fixture(t),p=await preview(f),s=p.videoSamples[0];for(const mutation of [v=>v.method='unknown',v=>v.frames=[],v=>v.frames=Array(7).fill(v.frames[0]),v=>v.frames[1].time=.5,v=>v.frames[1].time=0,v=>v.fallback='first-frame',v=>{v.method=LEGACY_VIDEO_SAMPLING_METHOD;},v=>{v.frames=v.frames.slice(0,1);v.fallback='unknown';}]){const v=structuredClone(s);mutation(v);assert.throws(()=>normalizeVideoSample(v),/抽样/);}const c=await f.service.create({projectId:f.project.id}),bad=structuredClone(s);bad.frames[1].time=.5;await atomicJson(path.join(f.data,'chat-video-samples',s.id+'.json'),bad);await assert.rejects(f.service.send(c.id,f.body(c,{videoSampleIds:[s.id]})),/抽样/);assert.equal(f.calls.length,0);
});
