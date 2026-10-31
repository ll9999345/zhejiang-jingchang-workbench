import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {creationStudioService} from '../lib/creation-studio.mjs';
import {readJson,storeAsset,atomicJson} from '../lib/workspace.mjs';
import {studioRequestCount,nativeModelscopeModel} from '../public/native-modelscope-core.js';
import {submitModelScope} from '../lib/native-protocols.mjs';
import {validateNativeModelscopeBatch} from '../lib/native-modelscope-batch.mjs';
import {cascadeProtocolFixture} from './helpers/native-cascade-protocol-fixture.mjs';
import {nativeCascadeRunner,publicCascadeJob} from '../lib/native-cascade-runner.mjs';
import {applyNativeCascadeResults} from '../lib/native-cascade-results.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64'),key='isolated-native-modelscope-key';
async function fixture(t){
 const state={requests:[],hold:false,loseId:false,posts:0};let base;
 const server=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);let body;try{body=JSON.parse(Buffer.concat(chunks));}catch{}state.requests.push({method:req.method,url:req.url,body});res.setHeader('Content-Type','application/json');
  if(req.method==='POST'&&req.url==='/v1/images/generations'){const index=++state.posts;if(state.loseId&&index===2)return res.destroy();return res.end(JSON.stringify({task_id:'original-modelscope-'+index}));}
  if(req.method==='GET'&&req.url.startsWith('/v1/tasks/original-modelscope-'))return res.end(JSON.stringify(state.hold?{task_status:'RUNNING'}:{task_status:'SUCCEED',output_images:[base+'/image']}));
  if(req.url==='/image'){res.setHeader('Content-Type','image/png');return res.end(png);}res.statusCode=404;res.end('{}');
 });server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-native-modelscope-')),activeJobs=new Map(),service=creationStudioService({data,activeJobs,pollInterval:5});
 async function settled(id,predicate=j=>!['queued','running'].includes(j.status)){for(let i=0;i<1000;i++){const j=await readJson(path.join(data,'jobs',id+'.json'));if(predicate(j))return j;await delay(5);}throw Error('native ModelScope fixture timeout');}
 t.after(async()=>{for(const active of activeJobs.values())active.controller.abort();for(let i=0;activeJobs.size&&i<1000;i++)await delay(5);await new Promise(r=>server.close(r));});
 async function make(count=3,{references=[],modelKey='custom',native=true,size='641x1279',unitPrice=0}={}){const s=await service.create({mode:'image',name:'隔离ModelScope'}),marker={version:1,modelKey,acceptsImages:modelKey!=='zimage'};return service.save(s.id,{...s,prompt:'literal request',references,config:{...s.config,protocol:'modelscope',baseUrl:base+'/v1',model:native?(nativeModelscopeModel(marker).modelId||'test/explicit'):'test/explicit',imageAsync:true,quality:'auto',transparent:false,size,count,unitPrice,...(native?{nativeModelscope:marker}:{})}});}
 const body=(s,id='once',overrides={})=>({requestId:id,revision:s.revision,apiKey:key,authorization:{origin:base,model:s.config.model,sendPrompt:true,sendReferences:s.references.length>0,requestLimit:studioRequestCount(s),budget:100,currency:'CNY',...overrides}});
 async function noSecrets(){async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const f=path.join(dir,entry.name);if(entry.isDirectory())await walk(f);else assert.equal((await fs.readFile(f)).includes(Buffer.from(key)),false);}}await walk(data);}
 return{state,base,data,activeJobs,service,settled,make,body,noSecrets};
}
test('原生1/3/8份是真实独立POST，WxH进入协议，逐原编号/结果顺序可核对',async t=>{
 const f=await fixture(t);
 for(const count of [1,3,8]){const s=await f.make(count),before=f.state.posts,j=await f.service.start(s.id,f.body(s)),done=await f.settled(j.id);assert.equal(done.status,'completed');assert.equal(f.state.posts-before,count);assert.equal(done.requestCount,count);assert.equal(done.assets.length,count);assert.equal(done.items.length,count);assert.equal(done.authorization.requestLimit,count);validateNativeModelscopeBatch(done);assert.deepEqual(done.assets,done.items.flatMap(item=>item.assets));assert.equal(new Set(done.items.map(item=>item.upstreamId)).size,count);const again=await f.service.start(s.id,f.body(s));assert.equal(again.id,j.id);assert.equal(f.state.posts-before,count);}
 for(const request of f.state.requests.filter(r=>r.method==='POST')){assert.equal(request.body.size,'641x1279');assert.equal(request.body.count,undefined);assert.equal(request.body.n,undefined);assert.equal(request.body.loras,undefined);}await f.noSecrets();
});
test('20张原生本机参考实际入协议；第21张和legacy第4张在POST前拒绝',async t=>{
 const f=await fixture(t),refs=[];for(let i=0;i<21;i++)refs.push({assetId:(await storeAsset(f.data,png,{name:'synthetic-'+i+'.png',type:'image/png'})).id});
 const s=await f.make(1,{references:refs.slice(0,20)}),j=await f.service.start(s.id,f.body(s)),done=await f.settled(j.id);assert.equal(done.status,'completed');assert.equal(f.state.requests.find(r=>r.method==='POST').body.image_url.length,20);
 const n=f.state.posts;await assert.rejects(f.make(1,{references:refs}),/参考/);const legacy=await f.make(1,{native:false,references:refs.slice(0,4)});await assert.rejects(f.service.start(legacy.id,f.body(legacy)),/参考/);assert.equal(f.state.posts,n);await f.noSecrets();
});
test('授权份数和预算在任何提交前校验，legacy多张输出仍不冒充多个ModelScope请求',async t=>{
 const f=await fixture(t),s=await f.make(3,{unitPrice:2});await assert.rejects(f.service.start(s.id,f.body(s,'wrong-limit',{requestLimit:1})),/次数|预算/);await assert.rejects(f.service.start(s.id,f.body(s,'under-budget',{budget:5})),/预算/);const old=await f.make(2,{native:false});await assert.rejects(f.service.start(old.id,f.body(old)),/份数|协议/);assert.equal(f.state.posts,0);await f.noSecrets();
});
test('停止三份后只查询原编号恢复，不重新提交、不重复保存已有结果',async t=>{
 const f=await fixture(t);f.state.hold=true;const s=await f.make(3),j=await f.service.start(s.id,f.body(s));await f.settled(j.id,j=>j.items.every(item=>item.upstreamId));await f.service.cancel(s.id,j.id);const stopped=await f.settled(j.id);assert.equal(stopped.status,'cancelled');assert.equal(f.state.posts,3);const original=stopped.items.map(item=>item.upstreamId);f.state.hold=false;await f.service.resume(s.id,j.id,{apiKey:key});const done=await f.settled(j.id);assert.equal(done.status,'completed');assert.equal(f.state.posts,3);assert.deepEqual(done.items.map(item=>item.upstreamId),original);assert.equal(done.assets.length,3);await f.service.resume(s.id,j.id,{apiKey:key});assert.equal(f.state.posts,3);validateNativeModelscopeBatch(done);await f.noSecrets();
});
test('未知提交/缺编号拒绝补发，仍保存其他已接收原任务的结果',async t=>{
 const f=await fixture(t);f.state.loseId=true;const s=await f.make(3),j=await f.service.start(s.id,f.body(s)),failed=await f.settled(j.id);assert.equal(failed.status,'failed');assert.equal(f.state.posts,3);assert.equal(failed.items.filter(item=>item.upstreamId).length,2);assert.equal(failed.assets.length,2);await f.service.resume(s.id,j.id,{apiKey:key});const again=await f.settled(j.id);assert.equal(again.status,'failed');assert.equal(again.assets.length,2);assert.equal(f.state.posts,3);await f.noSecrets();
});
test('逐份编号重复/计数篡改在恢复前拒绝，零补发',async t=>{
 const f=await fixture(t);f.state.hold=true;const s=await f.make(3),j=await f.service.start(s.id,f.body(s));await f.settled(j.id,j=>j.items.every(item=>item.upstreamId));await f.service.cancel(s.id,j.id);const stopped=await f.settled(j.id);stopped.items[1].upstreamId=stopped.items[0].upstreamId;await atomicJson(path.join(f.data,'jobs',j.id+'.json'),stopped);await assert.rejects(f.service.resume(s.id,j.id,{apiKey:key}),/重复/);assert.equal(f.state.posts,3);
});
test('固定模型标记与实际model对应，编辑模型无参考图在任何POST前拒绝',async t=>{
 const f=await fixture(t),reference={assetId:(await storeAsset(f.data,png,{name:'synthetic-edit.png',type:'image/png'})).id};
 for(const modelKey of ['qwen_edit','klein_edit']){const s=await f.make(1,{modelKey});await assert.rejects(f.service.start(s.id,f.body(s)),/至少.*参考图/);await assert.rejects(f.service.save(s.id,{...s,config:{...s.config,model:'wrong/model'}}),/模型编号/);await assert.rejects(submitModelScope({baseUrl:f.base+'/v1',apiKey:key,studio:s,references:[],signal:AbortSignal.timeout(1000)}),/参考图/);assert.equal(f.state.posts,0);}
 const valid=await f.make(1,{modelKey:'qwen_edit',references:[reference]}),j=await f.service.start(valid.id,f.body(valid));assert.equal((await f.settled(j.id)).status,'completed');assert.equal(f.state.posts,1);assert.equal(f.state.requests.find(r=>r.method==='POST').body.model,'Qwen/Qwen-Image-Edit-2511');await f.noSecrets();
});
async function cascade(t,{count=3,loop=false,zimage=false}={}){
 const f=await fixture(t),g=await cascadeProtocolFixture(t,{pairs:[['A','B'],['A','C']]});g.activeJobs.delete(g.parentId);
 const source=g.project.nodes.find(n=>n.id==='A');delete source.params.workflowBinding;source.text='literal smart input';source.params.nativeCanvas.node.promptDraftHtml='<p>literal smart input</p>';source.params.nativeCanvas.node.promptDraftText=source.text;
 const config={protocol:'modelscope',model:zimage?'Tongyi-MAI/Z-Image-Turbo':'test/explicit',baseUrl:f.base+'/v1',count,size:'641x1279',imageAsync:true,quality:'auto',transparent:false,unitPrice:0,currency:'CNY',loras:{},nativeModelscope:{version:1,modelKey:zimage?'zimage':'custom',acceptsImages:!zimage}};
 source.params.studioBinding={mode:'image',config,referenceSources:[],includeUpstream:true};source.params.nativeCanvas.node.runSettings={engine:'modelscope',msgenModel:zimage?'zimage':'custom',msCustomModel:'test/explicit',count,msResolution:'custom',msCustomSize:'641x1279'};
 if(loop){g.project.nodes=g.project.nodes.filter(n=>n.id==='A');g.project.edges=[];const node=g.graph.node('L',{kind:'smart-loop',stored:false,count:2,start:4});g.graph.edge(node,'A');}
 const service=creationStudioService({data:g.data,activeJobs:g.activeJobs,pollInterval:5}),runner=nativeCascadeRunner({...g,creationStudio:service,pollInterval:5}),target=loop?'A':'C',file=id=>path.join(g.data,'jobs',id+'.json');
 async function wait(id,predicate=j=>!['queued','running'].includes(j.status)){for(let i=0;i<1600;i++){const j=await readJson(file(id));if(predicate(j))return j;await delay(5);}throw Error('ModelScope cascade timeout');}
 async function idle(){for(let i=0;g.activeJobs.size&&i<1600;i++)await delay(5);assert.equal(g.activeJobs.size,0);}
 const body=async(id='modelscope-cascade')=>{const preview=await runner.plan(g.project,{nodeId:target});return{requestId:id,nodeId:target,consent:true,revision:g.project.revision,previewHash:preview.previewHash,studioCredentials:preview.steps.filter(s=>s.kind==='studio').map(s=>({nodeId:s.executionId,apiKey:key,authorization:{origin:f.base,model:s.studio.config.model,sendPrompt:true,sendReferences:s.sendAssets,requestLimit:studioRequestCount(s.studio),budget:100,currency:'CNY'}}))};};
 t.after(async()=>{for(const active of g.activeJobs.values())active.controller.abort();await idle();});return{...f,...g,state:f.state,service,source,runner,target,body,file,wait,idle};
}
test('真实native-cascade接ModelScope多份、同级共享不多付费、actualInput记录尺寸数量，编辑保护',async t=>{
 const f=await cascade(t),original=structuredClone(f.project),preview=await f.runner.plan(f.project,{nodeId:f.target});assert.equal(preview.summary.requests,3);assert.equal(preview.summary.sharedCopies,1);assert.equal(f.state.posts,0);
 const visible=await f.runner.start(f.project,await f.body(),f.pool[0]),done=await f.wait(visible.id);await f.idle();assert.equal(done.status,'completed',done.message);assert.equal(f.state.posts,3);assert.equal(done.assets.length,3);
 const input=done.steps[0].actualInput;assert.equal(input.modelscope.count,3);assert.equal(input.modelscope.size,'641x1279');assert.equal(input.providerRequestCount,3);assert.equal(input.modelscope.referenceAssetIds.length,1);assert.equal(done.steps[0].childRequests.submitted,3);
 const child=await readJson(f.file(done.steps[0].jobId));assert.deepEqual(child.cascadeModelscope,input.modelscope);assert.equal(child.parentId,done.id);assert.equal(child.requestCount,3);assert.deepEqual(f.project,original);
 const applied=await applyNativeCascadeResults({data:f.data,project:f.project,job:done,revision:f.project.revision});assert.equal(applied.applied,true);assert.equal(applied.project.nodes.find(n=>n.id==='B').params.nativeCanvas.node.generatedOutputs.length,3);assert.deepEqual(applied.project.nodes.find(n=>n.id==='B').params.nativeCanvas.node.generatedOutputs,applied.project.nodes.find(n=>n.id==='C').params.nativeCanvas.node.generatedOutputs);
 const edited=structuredClone(original);edited.nodes.find(n=>n.id==='B').title='my edit';edited.revision++;const kept=await applyNativeCascadeResults({data:f.data,project:edited,job:done,revision:edited.revision});assert.equal(kept.project.nodes.find(n=>n.id==='B').title,'my edit');assert.equal(kept.project.runs.at(-1).cascadeTargets.length,0);assert.equal(f.state.posts,3);assert.equal(JSON.stringify(done).includes(key),false);
});
test('原生循环每轮强制一份，原保存count=8不改，循环两轮仅2个实际POST',async t=>{
 const f=await cascade(t,{count:8,loop:true}),before=structuredClone(f.project),preview=await f.runner.plan(f.project,{nodeId:f.target});assert.equal(preview.summary.requests,2);assert.deepEqual(preview.steps.filter(s=>s.kind==='studio').map(s=>s.studio.config.count),[1,1]);
 const visible=await f.runner.start(f.project,await f.body(),f.pool[0]),done=await f.wait(visible.id);await f.idle();assert.equal(done.status,'completed',done.message);assert.equal(f.state.posts,2);assert.deepEqual(done.steps.filter(s=>s.kind==='studio').map(s=>s.actualInput.modelscope.count),[1,1]);assert.equal(f.source.params.studioBinding.config.count,8);assert.deepEqual(f.project,before);
});
test('ZImage原生不发送图片，实际unusedRefs清楚且授权只含文字',async t=>{
 const f=await cascade(t,{count:1,zimage:true}),body=await f.body();assert.equal(body.studioCredentials[0].authorization.sendReferences,false);const visible=await f.runner.start(f.project,body,f.pool[0]),done=await f.wait(visible.id);await f.idle();assert.equal(done.status,'completed',done.message);assert.equal(f.state.requests.find(r=>r.method==='POST').body.image_url,undefined);assert.equal(done.steps[0].actualInput.modelscope.referenceAssetIds.length,0);assert.equal(done.steps[0].actualInput.unusedRefs.length,1);
});
test('cascade停止恢复查询3个原ID，mirror篡改拒绝零查询/补发',async t=>{
 const f=await cascade(t);f.state.hold=true;const visible=await f.runner.start(f.project,await f.body(),f.pool[0]);await f.wait(visible.id,j=>j.steps[0].childRequests?.submitted===3);f.activeJobs.get(visible.id).controller.abort();const stopped=await f.wait(visible.id);await f.idle();assert.equal(stopped.status,'cancelled');assert.equal(publicCascadeJob(stopped).canResume,true);const childId=stopped.steps[0].jobId,child=await readJson(f.file(childId)),ids=child.items.map(item=>item.upstreamId);f.state.hold=false;
 await f.runner.resume(stopped.id,{studioCredentials:[{nodeId:stopped.steps[0].executionId,apiKey:key}]});const done=await f.wait(stopped.id);await f.idle();assert.equal(done.status,'completed',done.message);assert.equal(f.state.posts,3);assert.deepEqual((await readJson(f.file(childId))).items.map(item=>item.upstreamId),ids);
 const changed=await readJson(f.file(childId));changed.items[0].upstreamId='different-original';await atomicJson(f.file(childId),changed);const requestCount=f.state.requests.length;await assert.rejects(applyNativeCascadeResults({data:f.data,project:f.project,job:done,revision:f.project.revision}),/已接收编号|原编号|收据/);assert.equal(f.state.requests.length,requestCount);assert.equal(f.state.posts,3);
});
test('cascade原任务服务路径被改动时恢复在任何查询前拒绝，不向替换服务发送密钥',async t=>{
 const f=await cascade(t);f.state.hold=true;const visible=await f.runner.start(f.project,await f.body(),f.pool[0]);await f.wait(visible.id,j=>j.steps[0].childRequests?.submitted===3);f.activeJobs.get(visible.id).controller.abort();const stopped=await f.wait(visible.id);await f.idle();const child=await readJson(f.file(stopped.steps[0].jobId));child.input.studio.config.baseUrl=f.base+'/different-api';await atomicJson(f.file(child.id),child);const count=f.state.requests.length;
 await f.runner.resume(stopped.id,{studioCredentials:[{nodeId:stopped.steps[0].executionId,apiKey:key}]});const done=await f.wait(stopped.id);await f.idle();assert.equal(done.status,'failed');assert.match(done.message,/实际收据/);assert.equal(f.state.requests.length,count);assert.equal(f.state.posts,3);assert.equal(JSON.stringify(done).includes(key),false);
});
