import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeToFragment,normalizeNativeWorkflow} from '../lib/native-canvas-core.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';
import {generationService} from '../lib/generation.mjs';
import {canvasLlmService} from '../lib/canvas-llm.mjs';
import {applyCanvasResults} from '../lib/generation-results.mjs';
import {readJson,storeAsset} from '../lib/workspace.mjs';
import {applyNativePromptSettings} from '../public/native-prompt.js';
import {nativePromptSettings,nativePromptSystemDefault} from '../public/native-prompt-core.js';
import {nativeFlowPreview} from '../lib/native-flow.mjs';
import {validateProject} from '../lib/model.mjs';
import {nativeReferenceChoices} from '../public/native-flow-ui.js';
import {projectBundleService} from '../lib/project-bundles.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
const source=(id,type,extra={})=>({id,type,x:0,y:0,...extra});
async function fixture(t,{media=false}={}){
 const state={chats:[],prompts:[],finish:'stop',text:'第一段;第二段;'};
 const mock=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);res.setHeader('content-type','application/json');
  if(req.url==='/v1/chat/completions'){state.chats.push(JSON.parse(Buffer.concat(chunks)));return res.end(JSON.stringify({choices:[{message:{content:state.text},finish_reason:state.finish}]}));}
  if(req.url==='/prompt'){state.prompts.push(JSON.parse(Buffer.concat(chunks)));return res.end(JSON.stringify({prompt_id:'fixture-'+state.prompts.length}));}
  if(req.url.startsWith('/history/')){const id=req.url.split('/').at(-1);return res.end(JSON.stringify({[id]:{status:{completed:true,status_str:'success'},outputs:{'2':{images:[{filename:id+'.png',type:'output',subfolder:''}]}}}}));}
  if(req.url.startsWith('/view')){res.setHeader('content-type','image/png');return res.end(png);}
  res.statusCode=404;res.end('{}');
 });mock.listen(0,'127.0.0.1');await once(mock,'listening');t.after(()=>new Promise(resolve=>mock.close(resolve)));
 const endpoint='http://127.0.0.1:'+mock.address().port,data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-native-prompt-')),activeJobs=new Map(),generation=generationService({data,activeJobs}),canvasLlm=canvasLlmService({data,activeJobs}),runner=canvasRunner({data,activeJobs,generation,canvasLlm,pollInterval:10});
 const resources=[];if(media)for(let index=0;index<2;index++){const asset=await storeAsset(data,png,{type:'image/png',name:'本机合成参考'+index+'.png'});resources.push({url:'/fixture/'+index,archive:'resources/'+index+'.png',portableUrl:asset.url,asset});}
 const project=nativeToFragment(normalizeNativeWorkflow({format:'infinite-smart-canvas-workflow',version:1,nodes:[source('in','smart-prompt',{text:'甲;乙;甲',promptSplitEnabled:true}),source('model','smart-prompt',{text:'旧预览;不能用作本轮结果',promptSplitEnabled:true,llmEnabled:true,llmInstruction:'改写成两段镜头',llmSystemEnabled:true,llmSystemPrompt:'本机合成系统指令',foreign:'保留源参数'}),source('next','comfy',{text:'收尾'}),...(media?[source('references','smart-group',{items:['a','b']}),source('a','smart-image',{images:['/fixture/0']}),source('b','smart-image',{images:['/fixture/1']})]:[])],connections:[{from:'in',to:'model'},{from:'model',to:'next'},...(media?[{from:'references',to:'model'}]:[])]}),resources,'智能提示词本机协议样本');
 const node=raw=>project.nodes.find(node=>node.params?.nativeCanvas?.node.id===raw),model=node('model'),next=node('next');
 model.params.nativeCanvas.adaptation='configured';model.params.llmBinding={platform:{id:'local-fixture-chat',name:'本机合成模型',protocol:'openai-compatible',baseUrl:endpoint+'/v1',models:[{id:'local-chat',category:'chat',referenceSupport:true}]},model:'local-chat',maxTokens:512,systemPrompt:nativePromptSystemDefault(model),includeUpstream:true,stream:false,referenceSources:media?[{sourceNodeId:node('references').id}]:[]};
 const template=await generation.saveTemplate({name:'本机合成输出',workflow:{'1':{class_type:'CLIPTextEncode',inputs:{text:'旧字段'}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}}}});
 next.params.nativeCanvas.adaptation='configured';next.params.workflowBinding={workflowId:template.id,promptField:{nodeId:'1',name:'text'},overrides:[],imageSources:[],count:1};
 const body=async(requestId='local-prompt-chain')=>({revision:project.revision,requestId,consent:true,llmCredentials:(await runner.plan(project)).filter(step=>step.kind==='canvas-llm').map(step=>({nodeId:step.nodeId,apiKey:'synthetic-fixture-only',authorization:{origin:endpoint,model:step.llm.model,sendPrompt:true,sendReferences:step.sendAssets,requestLimit:1,budget:1,currency:'CNY'}}))});
 return{data,activeJobs,generation,canvasLlm,runner,project,state,endpoint,node,model,next,body};
}
async function wait(f,id){for(let i=0;i<700;i++){const job=await readJson(path.join(f.data,'jobs',id+'.json'));if(['completed','interrupted','cancelled'].includes(job.status))return job;await delay(10);}throw Error('智能提示词本机任务等待超时');}
async function idle(f){for(let i=0;i<200&&f.activeJobs.size;i++)await delay(10);assert.equal(f.activeJobs.size,0);}
const userText=chat=>{const content=chat.messages.find(message=>message.role==='user').content;return typeof content==='string'?content:content.filter(part=>part.type==='text').map(part=>part.text).join('\n');};

test('智能模型去重上游并追加改写指令，完整回答拆分后进入下游，原项目待确认回填',async t=>{
 const f=await fixture(t),original=structuredClone(f.project),steps=await f.runner.plan(f.project);assert.equal(steps.length,2);assert.equal(steps[0].kind,'canvas-llm');assert.equal(steps[0].text,'甲\n\n乙\n\n改写成两段镜头');
 const job=await f.runner.start(f.project,await f.body(),f.endpoint),done=await wait(f,job.id);assert.equal(done.status,'completed',done.message);assert.equal(f.state.chats.length,1);assert.equal(userText(f.state.chats[0]),steps[0].text);assert.equal(f.state.chats[0].messages[0].content,'本机合成系统指令');assert.equal(f.state.prompts.length,1);assert.equal(f.state.prompts[0].prompt['1'].inputs.text,'第一段\n\n第二段\n\n收尾');assert.equal(done.textResults[0].text,'第一段;第二段;');assert.deepEqual(f.project,original);
 const applied=await applyCanvasResults({...f,job:done,revision:0});assert.equal(applied.applied,true);assert.equal(f.model.text,'第一段;第二段;');assert.deepEqual(f.model.params.nativeCanvas.node,original.nodes.find(node=>node.id===f.model.id).params.nativeCanvas.node);assert.deepEqual(nativeFlowPreview(f.project,{nodeId:f.model.id}).nodes[0].promptItems,['第一段','第二段']);validateProject(f.project);
});

test('关闭模型改写保留绑定但零模型提交；本地拆分直接进入下游',async t=>{
 const f=await fixture(t),binding=structuredClone(f.model.params.llmBinding);applyNativePromptSettings(f.model,{...nativePromptSettings(f.model),llmEnabled:false});
 const plan=await f.runner.plan(f.project);assert.equal(plan.length,1);assert.equal(plan[0].kind,'comfy');assert.equal(plan[0].text,'旧预览\n\n不能用作本轮结果\n\n收尾');
 const job=await f.runner.start(f.project,await f.body('local-only-disabled'),f.endpoint),done=await wait(f,job.id);assert.equal(done.status,'completed',done.message);assert.equal(f.state.chats.length,0);assert.equal(f.state.prompts[0].prompt['1'].inputs.text,plan[0].text);assert.deepEqual(f.model.params.llmBinding,binding);assert.equal(done.textResults.length,0);
});

test('空改写指令使用当前拆分文字，孤立智能模型也能按本机绑定规划',async t=>{
 const f=await fixture(t);applyNativePromptSettings(f.model,{...nativePromptSettings(f.model),instruction:''});assert.equal((await f.runner.plan(f.project))[0].text,'甲\n\n乙\n\n旧预览\n\n不能用作本轮结果');
 f.project.edges=f.project.edges.filter(edge=>edge.target!==f.model.id);const plan=await f.runner.plan(f.project);assert.equal(plan[0].text,'旧预览\n\n不能用作本轮结果');assert.equal(plan[0].nativeFlow.text,true);assert.equal(f.state.chats.length,0);
});

test('分组图片按已选择映射展开，并需要明确媒体发送范围；未确认零提交',async t=>{
 const f=await fixture(t,{media:true}),plan=await f.runner.plan(f.project);assert.equal(plan[0].referenceDetails.length,2);assert.equal(plan[0].sendAssets,true);assert.ok(nativeReferenceChoices(f.project,f.model.id,{consumer:'llm'}).some(choice=>choice.value==='node:'+f.node('references').id));
 const body=await f.body('local-group-permission');body.llmCredentials[0].authorization.sendReferences=false;await assert.rejects(f.runner.start(f.project,body,f.endpoint),/确认/);assert.equal(f.state.chats.length,0);assert.equal(f.state.prompts.length,0);
 const job=await f.runner.start(f.project,await f.body('local-group-complete'),f.endpoint),done=await wait(f,job.id);assert.equal(done.status,'completed',done.message);const user=f.state.chats[0].messages.find(message=>message.role==='user');assert.equal(user.content.filter(part=>part.type==='image_url').length,2);assert.equal(userText(f.state.chats[0]),'甲\n\n乙\n\n改写成两段镜头');
});

test('缺少模型绑定、未经迁移确认及缩小文字范围均在任何提交前拒绝',async t=>{
 const f=await fixture(t);for(const [change,match] of [[n=>delete n.params.llmBinding,/尚未绑定/],[n=>n.params.nativeCanvas.adaptation='reference',/重新绑定|确认/],[n=>n.params.llmBinding.includeUpstream=false,/保留上游文字范围/]]){const p=structuredClone(f.project);change(p.nodes.find(node=>node.id===f.model.id));await assert.rejects(f.runner.plan(p),match);}
 assert.equal(f.state.chats.length,0);assert.equal(f.state.prompts.length,0);await assert.rejects(fs.stat(path.join(f.data,'jobs')),error=>error.code==='ENOENT');
});

test('回答达到输出上限保留片段，停止下游；恢复原任务不重复提交模型',async t=>{
 const f=await fixture(t);f.state.finish='length';const job=await f.runner.start(f.project,await f.body('local-prompt-incomplete'),f.endpoint),done=await wait(f,job.id);await idle(f);assert.equal(done.status,'interrupted');assert.equal(done.steps[0].outputText,'第一段;第二段;');assert.equal(done.textResults.length,0);assert.equal(f.state.prompts.length,0);assert.equal(f.model.text,'旧预览;不能用作本轮结果');
 await f.runner.resume(job.id);const repeated=await wait(f,job.id);await idle(f);assert.equal(repeated.status,'interrupted');assert.equal(f.state.chats.length,1);assert.equal(f.state.prompts.length,0);assert.equal(repeated.steps[0].jobId,done.steps[0].jobId);assert.match(repeated.message,/不会自动重发/);
});

test('运行后修改拆分参数时，旧回答作为独立结果保存，不覆盖当前智能提示词',async t=>{
 const f=await fixture(t),job=await f.runner.start(f.project,await f.body('local-prompt-edit-guard'),f.endpoint),done=await wait(f,job.id);assert.equal(done.status,'completed',done.message);applyNativePromptSettings(f.model,{...nativePromptSettings(f.model),separator:'||',instruction:'用户新改写指令'});const before=structuredClone(f.model);
 const applied=await applyCanvasResults({...f,job:done,revision:0});assert.equal(applied.applied,true);assert.deepEqual(f.model,before);assert.ok(f.project.nodes.some(node=>node.id!==f.model.id&&node.text==='第一段;第二段;'));validateProject(f.project);
});

function changedManifest(bytes,change){const offset=Buffer.byteLength('JINGCHANG-PACK-1\n'),size=bytes.readUInt32BE(offset),manifest=JSON.parse(bytes.subarray(offset+4,offset+4+size));change(manifest);const json=Buffer.from(JSON.stringify(manifest)),length=Buffer.alloc(4);length.writeUInt32BE(json.length);return Buffer.concat([bytes.subarray(0,offset),length,json,bytes.subarray(offset+4+size)]);}
async function bundleReceiver(){const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-native-prompt-bundle-')),activeJobs=new Map();let restored;const projects={load:async()=>{if(restored)return restored;throw Object.assign(Error('missing'),{status:404});},save:async project=>(restored=project)};return{data,activeJobs,bundles:projectBundleService({data,activeJobs,projects}),restored:()=>restored};}

test('第40版智能素材备份恢复拆分、绑定、源参数及分组参考；第30版旧规则仍可恢复',async t=>{
 const f=await fixture(t,{media:true});applyNativePromptSettings(f.model,{...nativePromptSettings(f.model),separator:'||',instruction:'恢复后的改写指令',previewHeight:110});const original=structuredClone(f.project),bundles=projectBundleService({...f,projects:{load:async()=>f.project}}),out=await bundles.exportBundle(f.project.id,0);assert.equal(out.formatVersion,40);const bytes=await fs.readFile(await bundles.download(out.id)),target=await bundleReceiver();
 for(const change of [manifest=>manifest.version=29,manifest=>manifest.project.nodes.find(node=>node.id===f.model.id).params.nativePrompt.version=2]){await assert.rejects(target.bundles.upload(Readable.from([changedManifest(bytes,change)])),/第30版|第40版|设置无效/);assert.equal(target.restored(),undefined);assert.equal(target.activeJobs.size,0);}
 const preview=await target.bundles.upload(createReadStream(await bundles.download(out.id))),restored=await target.bundles.importBundle(preview.id),model=restored.nodes.find(node=>node.params?.nativeCanvas?.node.id==='model'),references=restored.nodes.find(node=>node.params?.nativeCanvas?.node.id==='references');assert.notEqual(restored.id,f.project.id);assert.deepEqual(model.params.nativePrompt,f.model.params.nativePrompt);assert.deepEqual(model.params.nativeCanvas.node,f.model.params.nativeCanvas.node);assert.deepEqual(model.params.llmBinding.referenceSources,[{sourceNodeId:references.id}]);assert.deepEqual(restored.runs,[]);assert.equal(target.activeJobs.size,0);assert.deepEqual(f.project,original);validateProject(restored);
 const generation=generationService(target),canvasLlm=canvasLlmService(target),runner=canvasRunner({...target,generation,canvasLlm}),plan=await runner.plan(restored);assert.equal(plan[0].text,'甲\n\n乙\n\n恢复后的改写指令');assert.equal(plan[0].referenceDetails.length,2);assert.equal(f.state.chats.length,0);assert.equal(f.state.prompts.length,0);
 const legacy=structuredClone(f.project);delete legacy.settings.nativeMediaVersion;for(const n of legacy.nodes)delete n.params.nativeMediaVersion;const oldBundles=projectBundleService({...f,projects:{load:async()=>legacy}}),oldOut=await oldBundles.exportBundle(legacy.id,0);assert.equal(oldOut.formatVersion,30);const oldTarget=await bundleReceiver(),oldPreview=await oldTarget.bundles.upload(createReadStream(await oldBundles.download(oldOut.id))),oldRestored=await oldTarget.bundles.importBundle(oldPreview.id);assert.deepEqual(oldRestored.nodes.find(n=>n.params?.nativeCanvas?.node.id==='model').params.nativePrompt,f.model.params.nativePrompt);const oldBytes=await fs.readFile(await oldBundles.download(oldOut.id));await assert.rejects(oldTarget.bundles.upload(Readable.from([changedManifest(oldBytes,m=>m.version=29)])),/第30版/);assert.deepEqual(f.project,original);
});

test('已有第23版纯文字原生备份继续可恢复，不强迫原始分隔符数据升级',async()=>{
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-native-prompt-legacy-')),activeJobs=new Map(),project=nativeToFragment(normalizeNativeWorkflow({nodes:[source('literal','smart-prompt',{text:'甲;乙',promptSplitEnabled:true})],connections:[]}),[],'旧格式原生拆分'),bundles=projectBundleService({data,activeJobs,projects:{load:async()=>project}}),out=await bundles.exportBundle(project.id,0);assert.equal(out.formatVersion,23);const target=await bundleReceiver(),preview=await target.bundles.upload(createReadStream(await bundles.download(out.id))),restored=await target.bundles.importBundle(preview.id);assert.deepEqual(nativeFlowPreview(restored).nodes[0].promptItems,['甲','乙']);assert.equal(restored.nodes[0].params.nativePrompt,undefined);validateProject(restored);
});
