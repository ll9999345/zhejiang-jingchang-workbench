import './helpers/local-network-only.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import {makeProject,makeNode} from '../lib/model.mjs';
import {generationService} from '../lib/generation.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';
import {canvasLlmService,normalizeLlmBinding} from '../lib/canvas-llm.mjs';
import {geminiChatReply} from '../lib/gemini-chat.mjs';
import {applyCanvasResults} from '../lib/generation-results.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {readJson,storeAsset} from '../lib/workspace.mjs';

const key='synthetic-canvas-gemini-key';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
function wav(size=16044){const b=Buffer.alloc(size);b.write('RIFF',0);b.writeUInt32LE(size-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(size-44,40);return b;}
async function fixture(t){
 const state={calls:[],finish:'STOP',echo:false,uncertain:false,prompts:[]};
 const mock=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);res.setHeader('content-type','application/json');
  if(req.url==='/v1beta/models/gemini-test:generateContent'){
   state.calls.push({body:JSON.parse(Buffer.concat(chunks)),headers:req.headers});if(state.uncertain)return res.destroy();
   const candidate={content:{parts:[{text:'内部草稿',thought:true},{text:'对白总结 '+state.calls.length+(state.echo?' '+key:'')}]},...(state.finish!==undefined?{finishReason:state.finish}:{})};
   return res.end(JSON.stringify({candidates:[candidate]}));
  }
  if(req.url==='/prompt'){state.prompts.push(JSON.parse(Buffer.concat(chunks)));return res.end(JSON.stringify({prompt_id:'audio-'+state.prompts.length}));}
  if(req.url.startsWith('/history/')){const id=req.url.split('/').at(-1);return res.end(JSON.stringify({[id]:{status:{completed:true,status_str:'success'},outputs:{'2':{audio:[{filename:'generated.wav',type:'output',subfolder:''}]}}}}));}
  if(req.url.startsWith('/view')){res.setHeader('content-type','audio/wav');return res.end(wav());}
  res.statusCode=404;res.end('{}');
 });
 mock.listen(0,'127.0.0.1');await once(mock,'listening');t.after(()=>{mock.closeAllConnections();return new Promise(r=>mock.close(r));});
 const endpoint='http://127.0.0.1:'+mock.address().port,data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-gemini-canvas-')),activeJobs=new Map(),generation=generationService({data,activeJobs}),canvasLlm=canvasLlmService({data,activeJobs});
 const project=makeProject('音频分析链'),asset=await storeAsset(data,wav(),{name:'对白.wav',type:'audio/wav'}),audio=makeNode('audio',0,0,{assetId:asset.id,title:'对白音频'}),text=makeNode('script',350,0,{title:'对白听写',text:'请听写并总结音频'}),next=makeNode('text',700,0,{title:'镜头规划',text:'根据听写制作镜头提纲'});
 const binding={platform:{id:'gemini-platform',name:'本机 Gemini',protocol:'gemini',baseUrl:endpoint+'/v1beta',models:[{id:'gemini-test',label:'原生对话测试',category:'chat',referenceSupport:true,audioSupport:true}]},model:'gemini-test',systemPrompt:'用中文回答',maxTokens:512,stream:true,includeUpstream:true,referenceSources:[{sourceNodeId:audio.id}]};
 text.params.llmBinding=structuredClone(binding);next.params.llmBinding={...structuredClone(binding),referenceSources:[]};project.nodes=[audio,text,next];project.assets=[asset];project.edges=[{id:'audio-text',source:audio.id,target:text.id},{id:'text-next',source:text.id,target:next.id}];
 return{state,endpoint,data,activeJobs,generation,canvasLlm,project,asset,audio,text,next,runner:canvasRunner({data,activeJobs,generation,canvasLlm,pollInterval:10})};
}
async function authorization(f,requestId='gemini-chain'){
 const steps=await f.runner.plan(f.project);return{requestId,revision:f.project.revision,consent:true,llmCredentials:steps.filter(s=>s.kind==='canvas-llm').map(s=>({nodeId:s.executionId||s.nodeId,apiKey:key,authorization:{origin:f.endpoint,model:s.llm.model,sendPrompt:true,sendReferences:s.sendAssets,requestLimit:1,budget:1,currency:'CNY'}}))};
}
async function finished(f,id){for(let i=0;i<500;i++){const j=await readJson(path.join(f.data,'jobs',id+'.json'));if(!['queued','running'].includes(j.status)&&f.activeJobs.size===0)return j;await new Promise(r=>setTimeout(r,10));}throw Error('task timeout');}
async function noSecret(data){for(const e of await fs.readdir(data,{withFileTypes:true})){const file=path.join(data,e.name);if(e.isDirectory())await noSecret(file);else assert.equal((await fs.readFile(file)).includes(Buffer.from(key)),false,file);}}

test('固定与连线音频经 Gemini 原生请求进入文字链，完整回答传给下游并安全回填',async t=>{
 for(const fixed of [false,true]){
  const f=await fixture(t);if(fixed)f.text.params.llmBinding.referenceSources=[{assetId:f.asset.id}];
  const plan=await f.runner.plan(f.project);assert.equal(plan[0].llm.stream,false);assert.deepEqual(plan[0].audioReferences,[{assetId:f.asset.id,name:'对白.wav',type:'audio/wav',size:wav().length}]);assert.equal(f.state.calls.length,0);
  const auth=await authorization(f),j=await f.runner.start(f.project,structuredClone(auth),f.endpoint),done=await finished(f,j.id);assert.equal(done.status,'completed',done.message);assert.equal(f.state.calls.length,2);
  const first=f.state.calls[0];assert.equal(first.headers['x-goog-api-key'],key);assert.equal(first.headers.authorization,undefined);assert.equal(first.body.stream,undefined);assert.equal(first.body.systemInstruction.parts[0].text,'用中文回答');assert.equal(first.body.generationConfig.maxOutputTokens,512);assert.deepEqual(first.body.contents[0].parts[1].inlineData,{mimeType:'audio/wav',data:wav().toString('base64')});
  assert.match(f.state.calls[1].body.contents[0].parts[0].text,/对白总结 1/);assert.doesNotMatch(f.state.calls[1].body.contents[0].parts[0].text,/请听写并总结音频/);assert.equal(done.textResults.length,2);assert.equal(done.assets.length,0);
  assert.equal((await f.runner.start(f.project,structuredClone(auth),f.endpoint)).id,j.id);assert.equal(f.state.calls.length,2);
  const result=await applyCanvasResults({...f,job:done,revision:0});assert.equal(result.applied,true);assert.equal(f.text.text,'请听写并总结音频');assert.equal(f.project.nodes.filter(n=>n.text==='对白总结 1').length,1);await assert.rejects(applyCanvasResults({...f,job:done,revision:1}),/没有尚未/);await noSecret(f.data);
 }
});

test('音频能力、授权、数量、格式、来源和模型路径在提交前严格校验',async t=>{
 const f=await fixture(t),auth=await authorization(f),bad=await storeAsset(f.data,Buffer.from('bad audio'),{name:'bad.wav',type:'audio/wav'}),second=await storeAsset(f.data,wav(),{name:'second.wav',type:'audio/wav'});f.project.assets.push(bad,second);
 for(const edit of [
  b=>b.platform.models[0].audioSupport=false,
  b=>b.platform.protocol='openai-compatible',
  b=>b.referenceSources=[{assetId:f.asset.id},{assetId:second.id}],
  b=>b.referenceSources=[{assetId:bad.id}],
  b=>b.referenceSources=[{assetId:'not-in-project'}],
  b=>b.model=b.platform.models[0].id='gemini-../private',
  b=>b.model=b.platform.models[0].id='gemini-test-tts'
 ]){
  const original=structuredClone(f.text.params.llmBinding);edit(f.text.params.llmBinding);await assert.rejects(f.runner.plan(f.project));f.text.params.llmBinding=original;
 }
 await assert.rejects(f.runner.start(f.project,{...structuredClone(auth),llmCredentials:[]},f.endpoint),/授权/);
 const denied=structuredClone(auth);denied.llmCredentials[0].authorization.sendReferences=false;await assert.rejects(f.runner.start(f.project,denied,f.endpoint),/确认/);
 f.text.params.llmBinding.platform.models[0].referenceSupport=false;assert.equal((await f.runner.plan(f.project))[0].audioReferences.length,1,'audio-only model does not require visual capability');
 const image=await storeAsset(f.data,png,{name:'图.png',type:'image/png'});f.project.assets.push(image);f.text.params.llmBinding.referenceSources.push({assetId:image.id});await assert.rejects(f.runner.plan(f.project),/未开启图片/);
 assert.equal(f.state.calls.length,0);assert.equal(f.activeJobs.size,0);
});

test('达到上限、缺失/未知结束状态或断连接保留片段并停止下游，继续原任务不重发',async t=>{
 for(const mode of ['MAX_TOKENS',undefined,key,'disconnect']){
  const f=await fixture(t);f.state.finish=mode;f.state.echo=true;f.state.uncertain=mode==='disconnect';
  const body=await authorization(f),j=await f.runner.start(f.project,structuredClone(body),f.endpoint),done=await finished(f,j.id);assert.notEqual(done.status,'completed');assert.equal(f.state.calls.length,1);assert.equal(done.textResults.length,0);
  const child=await readJson(path.join(f.data,'jobs',done.steps[0].jobId+'.json'));
  if(mode!=='disconnect'){assert.match(child.outputText,/对白总结 1/);assert.doesNotMatch(child.outputText,/内部草稿|synthetic-canvas/);assert.equal(child.finishReason,mode==='MAX_TOKENS'?'MAX_TOKENS':'UNKNOWN');assert.equal(child.status,'incomplete');}else assert.equal(child.uncertain,true);
  await f.runner.resume(j.id,{llmCredentials:structuredClone(body.llmCredentials.slice(1))});await finished(f,j.id);assert.equal(f.state.calls.length,1);await noSecret(f.data);
 }
});

test('ComfyUI 本轮生成音频在生成完成后进入 Gemini，预览明确动态原文件范围',async t=>{
 const f=await fixture(t),template=await f.generation.saveTemplate({name:'本机测试声音',workflow:{'1':{class_type:'Text',inputs:{text:'测试对白'}},'2':{class_type:'SaveAudio',inputs:{audio:['1',0]}}}});
 f.audio.assetId=null;f.audio.params.workflowBinding={workflowId:template.id,overrides:[],imageSources:[],promptField:{nodeId:'1',name:'text'}};f.audio.text='生成测试声音';
 const plan=await f.runner.plan(f.project);assert.deepEqual(plan[1].audioReferences,[{sourceNodeId:f.audio.id,name:'对白音频',dynamic:true}]);assert.equal(f.state.calls.length,0);
 const j=await f.runner.start(f.project,await authorization(f),f.endpoint),done=await finished(f,j.id);assert.equal(done.status,'completed',done.message);assert.equal(f.state.prompts.length,1);assert.equal(f.state.calls.length,2);assert.equal(done.assets[0].type,'audio/wav');assert.equal(f.state.calls[0].body.contents[0].parts.at(-1).inlineData.data,wav().toString('base64'));await noSecret(f.data);
});

test('Gemini 画布完整备份v12恢复音频和模型快照，更换素材ID后仍可执行',async t=>{
 const f=await fixture(t);f.text.params.llmBinding=normalizeLlmBinding(f.text.params.llmBinding);f.next.params.llmBinding=normalizeLlmBinding(f.next.params.llmBinding);f.text.params.llmBinding.referenceSources=[{assetId:f.asset.id}];
 const bundles=projectBundleService({...f,projects:{load:async()=>f.project}}),pack=await bundles.exportBundle(f.project.id,0);assert.equal(pack.formatVersion,12);
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-gemini-import-')),activeJobs=new Map();let project;
 const projects={load:async()=>{if(project)return project;throw Object.assign(Error('missing'),{status:404});},save:async p=>(project=p)};
 const target=projectBundleService({data,activeJobs,projects}),file=await bundles.download(pack.id),raw=await fs.readFile(file),header=Buffer.byteLength('JINGCHANG-PACK-1\n'),size=raw.readUInt32BE(header),manifest=JSON.parse(raw.subarray(header+4,header+4+size));
 manifest.version=11;const legacy=Buffer.from(JSON.stringify(manifest)),length=Buffer.alloc(4);length.writeUInt32BE(legacy.length);
 await assert.rejects(target.upload(Readable.from([Buffer.concat([raw.subarray(0,header),length,legacy,raw.subarray(header+4+size)])])),/第12版/);
 assert.equal(project,undefined,'invalid legacy Gemini manifest must not create a project');
 const preview=await target.upload(createReadStream(file));project=await target.importBundle(preview.id);
 const binding=project.nodes.find(n=>n.id===f.text.id).params.llmBinding,newId=binding.referenceSources[0].assetId;assert.notEqual(newId,f.asset.id);assert.equal(binding.platform.models[0].audioSupport,true);assert.equal(binding.stream,false);assert.deepEqual(await fs.readFile(path.join(data,'assets',newId)),wav());
 const generation=generationService({data,activeJobs}),canvasLlm=canvasLlmService({data,activeJobs}),restored={...f,data,activeJobs,project,runner:canvasRunner({data,activeJobs,generation,canvasLlm,pollInterval:10})};
 const job=await restored.runner.start(project,await authorization(restored),f.endpoint),done=await finished(restored,job.id);assert.equal(done.status,'completed',done.message);assert.equal(f.state.calls.length,2);await noSecret(data);
});

test('Gemini 编码请求超过18MB和单份音频超过10MB时零提交拒绝',async t=>{
 const f=await fixture(t),audio=await storeAsset(f.data,wav(10*1024*1024),{name:'large.wav',type:'audio/wav'}),image=await storeAsset(f.data,Buffer.concat([png,Buffer.alloc(4*1024*1024)]),{name:'large.png',type:'image/png'});f.project.assets.push(audio,image);
 f.text.params.llmBinding.referenceSources=[{assetId:audio.id},{assetId:image.id}];await assert.rejects(f.runner.plan(f.project),/18MB/);
 const tooLarge=await storeAsset(f.data,wav(10*1024*1024+1),{name:'too-large.wav',type:'audio/wav'});f.project.assets.push(tooLarge);f.text.params.llmBinding.referenceSources=[{assetId:tooLarge.id}];await assert.rejects(f.runner.plan(f.project),/不能超过10MB/);assert.equal(f.state.calls.length,0);
});

test('Gemini 回答只认显式STOP，过滤思考段并拒绝被平台阻止的响应',()=>{
 assert.equal(geminiChatReply({candidates:[{content:{parts:[{text:'内部',thought:true},{text:'答案'}]}}]}).complete,false);
 assert.deepEqual(geminiChatReply({candidates:[{finishReason:'STOP',content:{parts:[{text:'内部',thought:true},{text:'答案'}]}}]}),{text:'答案',finishReason:'STOP',complete:true});
 assert.throws(()=>geminiChatReply({promptFeedback:{blockReason:'SAFETY'}}),/未接受/);
});
