import './helpers/local-network-only.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs, createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {makeProject, makeNode} from '../lib/model.mjs';
import {storeAsset, readJson, atomicJson, records, userError} from '../lib/workspace.mjs';
import {prepareChatMedia, chatReferenceParts, loadChatReferences} from '../lib/chat-media.mjs';
import {normalizeNativeVideo} from '../lib/chat-native-video.mjs';
import {platformService} from '../lib/api-platforms.mjs';
import {conversationService} from '../lib/conversations.mjs';
import {generationService} from '../lib/generation.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';
import {canvasLlmService} from '../lib/canvas-llm.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {applyCanvasResults} from '../lib/generation-results.mjs';
import {connectionMediaMapping} from '../lib/canvas-tools.mjs';

const key = 'synthetic-native-video-test-key';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=', 'base64');
const mp4 = execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=160x96:rate=4','-f','lavfi','-i','sine=frequency=440:sample_rate=8000','-t','2','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-f','mp4','-movflags','frag_keyframe+empty_moov','pipe:1']);
const silent = execFileSync('ffmpeg', ['-v','error','-i','pipe:0','-an','-c:v','copy','-f','mp4','-movflags','frag_keyframe+empty_moov','pipe:1'], {input: mp4});
const webm = execFileSync('ffmpeg', ['-v','error','-i','pipe:0','-an','-c:v','libvpx-vp9','-threads','1','-f','webm','pipe:1'], {input: silent});
function wav() {const b=Buffer.alloc(16044);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;}

async function fixture(t) {
  const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-native-video-')),activeJobs=new Map();
  const state={calls:[],prompts:[],finish:'STOP',echo:false,uncertain:false,output:mp4};
  const mock=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    res.setHeader('content-type','application/json');
    if(req.url==='/v1beta/models/gemini-test:generateContent'){
      state.calls.push({url:req.url,headers:req.headers,body:JSON.parse(Buffer.concat(chunks))});
      if(state.uncertain)return res.destroy();
      return res.end(JSON.stringify({candidates:[{...(state.finish===undefined?{}:{finishReason:state.finish}),content:{parts:[{text:'本机视频理解 '+state.calls.length+(state.echo?' '+key:'')}]}}]}));
    }
    if(req.url==='/prompt'){state.prompts.push(JSON.parse(Buffer.concat(chunks)));return res.end(JSON.stringify({prompt_id:'video-'+state.prompts.length}));}
    if(req.url.startsWith('/history/')){const id=req.url.split('/').at(-1);return res.end(JSON.stringify({[id]:{status:{completed:true,status_str:'success'},outputs:{'2':{videos:[{filename:'generated.mp4',type:'output',subfolder:''}]}}}}));}
    if(req.url.startsWith('/view')){res.setHeader('content-type','video/mp4');return res.end(state.output);}
    res.statusCode=404;res.end('{}');
  });
  mock.listen(0,'127.0.0.1');await once(mock,'listening');
  t.after(()=>{mock.closeAllConnections();return new Promise(resolve=>mock.close(resolve));});
  const endpoint='http://127.0.0.1:'+mock.address().port,platforms=platformService(data);
  const platform=(await platforms.save({revision:0,platform:{name:'本机原视频测试',protocol:'gemini',baseUrl:endpoint+'/v1beta',models:[{id:'gemini-test',category:'chat',referenceSupport:true,audioSupport:true,videoSupport:true}]}})).platforms[0];
  const projects={load:async id=>{try{return await readJson(path.join(data,'projects',id,'project.json'));}catch(e){if(e.code==='ENOENT')throw userError('项目不存在',404);throw e;}},save:async p=>{await atomicJson(path.join(data,'projects',p.id,'project.json'),p);return p;},apply:async(_c,m)=>m};
  const project=makeProject('原视频理解与恢复'),video=await storeAsset(data,mp4,{name:'带声音.mp4',type:'video/mp4'});project.assets=[video];await projects.save(project);
  const service=conversationService({data,activeJobs,platforms,projects}),generation=generationService({data,activeJobs}),canvasLlm=canvasLlmService({data,activeJobs});
  return {data,activeJobs,state,endpoint,platforms,platform,projects,project,video,service,generation,canvasLlm,runner:canvasRunner({data,activeJobs,generation,canvasLlm,pollInterval:10})};
}
const preview=(f,ids=[f.video.id],mode='native')=>prepareChatMedia({data:f.data,assetIds:ids,videoInputMode:mode});
function messageBody(f,c,p,extra={}) {return {revision:c.revision,requestId:'native-'+c.revision,platformId:f.platform.id,model:'gemini-test',mode:'chat',text:'请描述画面和实际声音',systemPrompt:'只描述文件中存在的内容',assetIds:p.assets.map(a=>a.id),nativeVideoIds:p.nativeVideos.map(v=>v.id),videoSampleIds:p.videoSamples.map(v=>v.id),documentSampleIds:p.documentSamples.map(v=>v.id),apiKey:key,authorization:{origin:f.endpoint,model:'gemini-test',sendPrompt:true,sendReferences:true,sendNativeVideo:true,requestLimit:1,budget:1,currency:'CNY'},...extra};}
async function finished(f,id) {for(let i=0;i<500;i++){const job=await readJson(path.join(f.data,'jobs',id+'.json'));if(!['queued','running'].includes(job.status)&&f.activeJobs.size===0)return job;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('task timeout');}
const nativeParts=body=>body.contents.flatMap(m=>m.parts.filter(p=>p.inlineData?.mimeType?.startsWith('video/')));
async function scanSecrets(data) {for(const entry of await fs.readdir(data,{withFileTypes:true})){const file=path.join(data,entry.name);if(entry.isDirectory())await scanSecrets(file);else assert.equal((await fs.readFile(file)).includes(Buffer.from(key)),false,file);}}
async function canvasAuthorization(f,id='native-chain') {return {revision:f.project.revision,requestId:id,consent:true,llmCredentials:(await f.runner.plan(f.project)).filter(s=>s.kind==='canvas-llm').map(s=>({nodeId:s.executionId||s.nodeId,apiKey:key,authorization:{origin:f.endpoint,model:'gemini-test',sendPrompt:true,sendReferences:s.sendAssets,...(s.sendNativeVideo?{sendNativeVideo:true}:{}),requestLimit:1,budget:1,currency:'CNY'}}))};}
function setupCanvas(f) {
  const source=makeNode('video',0,0,{title:'待理解视频',assetId:f.video.id}),target=makeNode('script',350,0,{title:'视频理解',text:'分析原视频与声音'}),next=makeNode('text',700,0,{title:'后续镜头',text:'根据视频理解编排镜头'});
  target.params.llmBinding={platform:f.platform,model:'gemini-test',videoInputMode:'native',stream:true,referenceSources:[{sourceNodeId:source.id}]};
  next.params.llmBinding={...structuredClone(target.params.llmBinding),videoInputMode:'frames',referenceSources:[]};
  f.project.nodes=[source,target,next];f.project.edges=[{id:'video-edge',source:source.id,target:target.id},{id:'text-edge',source:target.id,target:next.id}];return {source,target,next};
}

test('原视频本地预览校验 MP4/WebM/MOV 与真实音轨，不抽帧、不调用模型、并发复用',async t=>{
  const f=await fixture(t),before=(await fs.readdir(path.join(f.data,'assets'))).length;
  const [a,b]=await Promise.all([preview(f),preview(f)]);assert.deepEqual(a,b);assert.deepEqual(a.videoSamples,[]);assert.equal(a.nativeVideos[0].hasAudio,true);assert.ok(a.nativeVideos[0].duration>=2);assert.equal(a.nativeVideos[0].width,160);assert.equal(a.nativeVideos[0].height,96);assert.equal((await fs.readdir(path.join(f.data,'assets'))).length,before);assert.equal(f.state.calls.length,0);
  const mov=await storeAsset(f.data,silent,{name:'静音.mov',type:'video/quicktime'}),web=await storeAsset(f.data,webm,{name:'静音.webm',type:'video/webm'}),p=await preview(f,[mov.id,web.id]);
  assert.deepEqual(p.nativeVideos.map(v=>v.mimeType),['video/quicktime','video/webm']);assert.ok(p.nativeVideos.every(v=>!v.hasAudio));
  const parts=await chatReferenceParts({data:f.data,assetIds:[f.video.id],nativeVideos:a.nativeVideos,protocol:'gemini'});assert.equal(parts.parts.at(-1).data,mp4.toString('base64'));assert.equal(parts.parts.at(-1).mimeType,'video/mp4');assert.match(parts.parts[0].text,/文件含音轨/);
  await assert.rejects(loadChatReferences({data:f.data,assetIds:[f.video.id],nativeVideoIds:[a.nativeVideos[0].id]}),/Gemini 原生/);
});

test('原视频、图片、音频、文档一次内嵌发送；幂等提交与重启后历史沿用原文件',async t=>{
  const f=await fixture(t),audio=await storeAsset(f.data,wav(),{name:'音频.wav',type:'audio/wav'}),image=await storeAsset(f.data,png,{name:'图.png',type:'image/png'}),document=await storeAsset(f.data,Buffer.from('本机文档正文'),{name:'提示.txt',type:'text/plain'});
  const p=await preview(f,[f.video.id,image.id,audio.id,document.id]),c=await f.service.create({projectId:f.project.id}),body=messageBody(f,c,p),[one,two]=await Promise.all([f.service.send(c.id,structuredClone(body)),f.service.send(c.id,structuredClone(body))]);
  assert.equal(one.id,two.id);assert.equal((await finished(f,one.id)).status,'completed');assert.equal(f.state.calls.length,1);
  const call=f.state.calls[0],parts=call.body.contents[0].parts;assert.equal(call.headers['x-goog-api-key'],key);assert.equal(call.headers.authorization,undefined);assert.deepEqual(nativeParts(call.body),[{inlineData:{mimeType:'video/mp4',data:mp4.toString('base64')}}]);assert.ok(parts.some(p=>p.inlineData?.mimeType==='audio/wav'));assert.ok(parts.some(p=>p.inlineData?.mimeType==='image/png'));assert.match(JSON.stringify(parts),/本机文档正文/);assert.equal(call.body.stream,undefined);
  const current=await f.service.get(c.id);assert.deepEqual(current.messages[0].nativeVideos,p.nativeVideos);assert.equal((await records(path.join(f.data,'jobs')))[0].authorization.sendNativeVideo,true);
  const recovered=conversationService(f);await recovered.recover();const j=await recovered.send(c.id,messageBody(f,current,await preview(f,[])));assert.equal((await finished(f,j.id)).status,'completed');assert.equal(f.state.calls.length,2);assert.deepEqual(nativeParts(f.state.calls[1].body),nativeParts(call.body));await scanSecrets(f.data);
});

test('旧视频消息保留抽样、新消息选择原文件，切换模型不重解释既有历史',async t=>{
  const f=await fixture(t),frames=await preview(f,[f.video.id],'frames'),c=await f.service.create({projectId:f.project.id});
  const first=await f.service.send(c.id,messageBody(f,c,frames));await finished(f,first.id);assert.equal(nativeParts(f.state.calls[0].body).length,0);
  const current=await f.service.get(c.id),original=await preview(f),second=await f.service.send(c.id,messageBody(f,current,original));await finished(f,second.id);
  assert.equal(nativeParts(f.state.calls[1].body).length,1);assert.equal(f.state.calls[1].body.contents[0].parts.filter(p=>p.inlineData?.mimeType==='image/jpeg').length,frames.videoSamples[0].frames.length);
  const unsupported=(await f.platforms.save({revision:1,platform:{name:'文本兼容',protocol:'openai-compatible',baseUrl:f.endpoint+'/v1',models:[{id:'vision',category:'chat',referenceSupport:true}]}})).platforms.at(-1);
  const latest=await f.service.get(c.id);await assert.rejects(f.service.send(c.id,messageBody(f,latest,await preview(f,[]),{platformId:unsupported.id,model:'vision',authorization:{origin:f.endpoint,model:'vision',sendPrompt:true,sendReferences:true,requestLimit:1,budget:1,currency:'CNY'}})),/历史中的原视频不会自动/);
  assert.equal(f.state.calls.length,2);assert.equal((await f.service.get(c.id)).revision,latest.revision);
});

test('缺少模型能力、原视频确认或已保存预览，以及重复/错配预览均零提交',async t=>{
  const f=await fixture(t),p=await preview(f),c=await f.service.create({projectId:f.project.id}),body=messageBody(f,c,p);
  await assert.rejects(f.service.send(c.id,{...structuredClone(body),nativeVideoIds:[]}),/准备.*预览/);
  const denied=structuredClone(body);delete denied.authorization.sendNativeVideo;await assert.rejects(f.service.send(c.id,denied),/明确确认/);
  const disabled=(await f.platforms.save({revision:1,platform:{...f.platform,models:[{...f.platform.models[0],videoSupport:false}]}})).platforms[0];assert.equal(disabled.models[0].videoSupport,false);await assert.rejects(f.service.send(c.id,structuredClone(body)),/未启用原视频理解/);
  await assert.rejects(loadChatReferences({data:f.data,assetIds:[],nativeVideoIds:[p.nativeVideos[0].id],protocol:'gemini'}),/不匹配/);
  const frames=await preview(f,[f.video.id],'frames');await assert.rejects(loadChatReferences({data:f.data,assetIds:[f.video.id],nativeVideoIds:p.nativeVideos.map(v=>v.id),videoSampleIds:frames.videoSamples.map(v=>v.id),protocol:'gemini'}),/不匹配/);
  await assert.rejects(preview(f,[f.video.id],'automatic'),/输入方式/);assert.equal(f.state.calls.length,0);assert.deepEqual((await f.service.get(c.id)).messages,[]);assert.deepEqual(await records(path.join(f.data,'jobs')),[]);
});

test('原文件、伪装视频、符号链接及声音记录篡改在本机拒绝，文件大小与总上下文限制不产生任务',async t=>{
  const f=await fixture(t),p=await preview(f),v=p.nativeVideos[0];
  const fake=await storeAsset(f.data,Buffer.from('#EXTM3U\nhttp://127.0.0.1/private'),{name:'假.mp4',type:'video/mp4'});await assert.rejects(preview(f,[fake.id]),/媒体处理失败/);
  const huge=await storeAsset(f.data,Buffer.concat([mp4,Buffer.alloc(10*1024*1024)]),{name:'过大.mp4',type:'video/mp4'});await assert.rejects(preview(f,[huge.id]),/不能超过10MB/);
  await fs.symlink(path.join(f.data,'assets',f.video.id),path.join(f.data,'assets','linked'));await atomicJson(path.join(f.data,'assets','linked.json'),{...f.video,id:'linked'});await assert.rejects(preview(f,['linked']),/本地文件/);
  await assert.rejects(chatReferenceParts({data:f.data,assetIds:[f.video.id],nativeVideos:[{...v,hasAudio:false}],protocol:'gemini'}),/声音记录/);
  for(const mutate of [v=>v.mimeType='video/mov',v=>v.size=0,v=>v.sourceType='constructor',v=>v.duration=Infinity,v=>v.hasAudio='false']){const bad=structuredClone(v);mutate(bad);assert.throws(()=>normalizeNativeVideo(bad),/预览记录/);}
  await fs.writeFile(path.join(f.data,'assets',f.video.id),Buffer.alloc(mp4.length));await assert.rejects(chatReferenceParts({data:f.data,assetIds:[f.video.id],nativeVideos:[v],protocol:'gemini'}),/原视频文件已变化/);
  const bytes=Buffer.concat([mp4,Buffer.alloc(7*1024*1024-mp4.length)]),large=await storeAsset(f.data,bytes,{name:'长数据.mp4',type:'video/mp4'}),largePreview=await preview(f,[large.id]),c=await f.service.create({projectId:f.project.id}),first=await f.service.send(c.id,messageBody(f,c,largePreview));assert.equal((await finished(f,first.id)).status,'completed');
  const current=await f.service.get(c.id);await assert.rejects(f.service.send(c.id,messageBody(f,current,largePreview)),/18MB/);assert.equal((await f.service.get(c.id)).revision,current.revision);assert.equal((await records(path.join(f.data,'jobs'))).length,1);assert.equal(f.state.calls.length,1);
});

test('画布原视频支持仅开启视频能力的模型、自动连线、动态生成和完整文字下传',async t=>{
  for(const dynamic of [false,true]){
    const f=await fixture(t),{source,target,next}=setupCanvas(f);target.params.llmBinding.platform=structuredClone(f.platform);target.params.llmBinding.platform.models[0].referenceSupport=false;
    target.params.llmBinding.referenceSources=[];assert.deepEqual(connectionMediaMapping(f.project,source.id,target.id),{targetId:target.id,bindingKey:'llmBinding',reference:{sourceNodeId:source.id}});target.params.llmBinding.referenceSources=[{sourceNodeId:source.id}];
    if(dynamic){const template=await f.generation.saveTemplate({name:'本轮视频',workflow:{'1':{class_type:'Text',inputs:{text:'生成本机测试视频'}},'2':{class_type:'SaveVideo',inputs:{video:['1',0]}}}});source.assetId=null;source.text='生成视频';source.params.workflowBinding={workflowId:template.id,overrides:[],imageSources:[],promptField:{nodeId:'1',name:'text'}};}
    const plan=await f.runner.plan(f.project),step=plan.find(s=>s.nodeId===target.id);assert.equal(step.sendNativeVideo,true);assert.equal(step.llm.stream,false);assert.equal(step.nativeVideos.length,dynamic?0:1);if(dynamic)assert.ok(step.referenceDetails[0].dynamic);assert.equal(f.state.calls.length,0);
    const body=await canvasAuthorization(f),denied=structuredClone(body);delete denied.llmCredentials[0].authorization.sendNativeVideo;await assert.rejects(f.runner.start(f.project,denied,f.endpoint),/明确确认/);
    const job=await f.runner.start(f.project,structuredClone(body),f.endpoint),done=await finished(f,job.id);assert.equal(done.status,'completed',done.message);assert.equal(f.state.calls.length,2);assert.deepEqual(nativeParts(f.state.calls[0].body),[{inlineData:{mimeType:'video/mp4',data:mp4.toString('base64')}}]);assert.match(f.state.calls[1].body.contents[0].parts[0].text,/本机视频理解 1/);assert.equal(nativeParts(f.state.calls[1].body).length,0);
    if(dynamic)assert.equal(f.state.prompts.length,1);const applied=await applyCanvasResults({...f,job:done,revision:0});assert.equal(applied.applied,true);assert.equal(target.text,'分析原视频与声音');assert.equal(next.text,'根据视频理解编排镜头');assert.equal((await f.runner.start(f.project,structuredClone(body),f.endpoint)).id,job.id);assert.equal(f.state.calls.length,2);await scanSecrets(f.data);
  }
});

test('原视频画布不完整回答或不确定请求停止下游，恢复只查询原记录',async t=>{
  for(const mode of [undefined,'MAX_TOKENS','disconnect']){
    const f=await fixture(t);setupCanvas(f);f.state.finish=mode;f.state.echo=true;f.state.uncertain=mode==='disconnect';const body=await canvasAuthorization(f),job=await f.runner.start(f.project,structuredClone(body),f.endpoint),done=await finished(f,job.id);
    assert.notEqual(done.status,'completed');assert.equal(f.state.calls.length,1);assert.equal(done.textResults.length,0);const child=await readJson(path.join(f.data,'jobs',done.steps[0].jobId+'.json'));if(mode!=='disconnect'){assert.equal(child.status,'incomplete');assert.match(child.outputText,/本机视频理解/);assert.doesNotMatch(child.outputText,/synthetic-native/);}else assert.equal(child.uncertain,true);
    await f.runner.resume(job.id,{llmCredentials:structuredClone(body.llmCredentials.slice(1))});await finished(f,job.id);assert.equal(f.state.calls.length,1);await scanSecrets(f.data);
  }
});

test('第13版备份跨工作区重映射原视频历史及绑定，恢复可继续对话和画布链',async t=>{
  const f=await fixture(t),p=await preview(f),c=await f.service.create({projectId:f.project.id}),first=await f.service.send(c.id,messageBody(f,c,p));await finished(f,first.id);const {target}=setupCanvas(f);target.params.llmBinding.referenceSources=[{assetId:f.video.id}];await f.projects.save(f.project);
  const bundles=projectBundleService(f),pack=await bundles.exportBundle(f.project.id,0);assert.equal(pack.formatVersion,13);
  const other=await fixture(t),restore=projectBundleService(other),inspection=await restore.upload(createReadStream(await bundles.download(pack.id))),restored=await restore.importBundle(inspection.id),record=(await records(path.join(other.data,'conversations')))[0];
  assert.notEqual(record.messages[0].nativeVideos[0].assetId,f.video.id);assert.equal(record.messages[0].nativeVideos[0].hasAudio,true);assert.equal(restored.nodes.find(n=>n.id===target.id).params.llmBinding.referenceSources[0].assetId,record.messages[0].nativeVideos[0].assetId);assert.equal(restored.nodes.find(n=>n.id===target.id).params.llmBinding.videoInputMode,'native');
  const j=await other.service.send(record.id,messageBody(other,record,await preview(other,[])));assert.equal((await finished(other,j.id)).status,'completed');assert.deepEqual(nativeParts(other.state.calls[0].body),nativeParts(f.state.calls[0].body));
  other.project=restored;const body=await canvasAuthorization(other);for(const credential of body.llmCredentials)credential.authorization.origin=f.endpoint;const chain=await other.runner.start(restored,body,other.endpoint);assert.equal((await finished(other,chain.id)).status,'completed');assert.equal(f.state.calls.length,3);await scanSecrets(other.data);
});

test('原视频备份拒绝降级、丢失预览、错配校验、双重视频记录与非法元数据',async t=>{
  const f=await fixture(t),p=await preview(f),c=await f.service.create({projectId:f.project.id}),j=await f.service.send(c.id,messageBody(f,c,p));await finished(f,j.id);
  const bundles=projectBundleService(f),pack=await bundles.exportBundle(f.project.id,0),raw=await fs.readFile(await bundles.download(pack.id)),magic=Buffer.from('JINGCHANG-PACK-1\n'),length=raw.readUInt32BE(magic.length),manifest=JSON.parse(raw.subarray(magic.length+4,magic.length+4+length)),frames=await preview(f,[f.video.id],'frames');
  for(const change of [m=>m.version=12,m=>m.conversations[0].messages[0].nativeVideos=[],m=>m.conversations[0].messages[0].nativeVideos[0].sourceSha256='0'.repeat(64),m=>m.conversations[0].messages[0].nativeVideos[0].mimeType='video/webm',m=>m.conversations[0].messages[0].nativeVideos.push(m.conversations[0].messages[0].nativeVideos[0]),m=>m.conversations[0].messages[0].videoSamples=frames.videoSamples]){
    const next=structuredClone(manifest);change(next);const json=Buffer.from(JSON.stringify(next)),header=Buffer.alloc(4);header.writeUInt32BE(json.length);await assert.rejects(bundles.upload(Readable.from([magic,header,json,raw.subarray(magic.length+4+length)])),/备份|预览/);
  }
  const {target}=setupCanvas(f);await f.projects.save(f.project);const withBinding=await bundles.exportBundle(f.project.id,0),bindingBytes=await fs.readFile(await bundles.download(withBinding.id)),bindingLength=bindingBytes.readUInt32BE(magic.length),bindingManifest=JSON.parse(bindingBytes.subarray(magic.length+4,magic.length+4+bindingLength));bindingManifest.version=12;bindingManifest.conversations=[];
  const json=Buffer.from(JSON.stringify(bindingManifest)),header=Buffer.alloc(4);header.writeUInt32BE(json.length);await assert.rejects(bundles.upload(Readable.from([magic,header,json,bindingBytes.subarray(magic.length+4+bindingLength)])),/第13版/);assert.equal(target.params.llmBinding.videoInputMode,'native');assert.equal(f.state.calls.length,1);
});
