import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {cascadeProtocolFixture} from './helpers/native-cascade-protocol-fixture.mjs';
import {nativeCascadeRunner,publicCascadeJob} from '../lib/native-cascade-runner.mjs';
import {applyNativeCascadeResults} from '../lib/native-cascade-results.mjs';
import {nativeCascadePlanMarkup} from '../public/native-cascade-ui.js';
import {atomicJson,readJson,records} from '../lib/workspace.mjs';

const key='synthetic-only-product-admission';
const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
async function fixture(t,options={}){
 const f=await cascadeProtocolFixture(t,options);f.activeJobs.delete(f.parentId);
 const node=f.project.nodes.find(node=>node.params.workflowBinding);
 if(node){const template=await f.generation.template(node.params.workflowBinding.workflowId);
  await f.generation.configure(template.id,{revision:template.revision,nativeConfig:{fields:[
   {id:'prompt',node:'1',input:'text',name:'提示词',type:'textarea',default:'原模板默认'},
   {id:'reference',node:'3',input:'image',name:'参考图',type:'image',default:'未上传.png'}]}});
 }
 const runner=nativeCascadeRunner({...f,pollInterval:10}),target=options.target||options.pairs?.at(-1)[1]||'C';
 const body=async(requestId='native-cascade-product')=>{
  const preview=await runner.plan(f.project,{nodeId:target});
  const authorize=step=>({origin:new URL(f.endpoint).origin,requestLimit:1,budget:1,currency:step.studio?.config.currency||'CNY',
   ...(step.kind==='runninghub'?{kind:step.recipe.kind,targetId:step.recipe.targetId,sendFields:true,sendAssets:step.sendAssets}:
    {model:step.image?.model||step.studio.config.model,sendPrompt:true,sendReferences:step.sendAssets,...(step.sendOriginalMedia?{sendOriginalMedia:true}:{})})});
  return{nodeId:target,revision:f.project.revision,consent:true,requestId,previewHash:preview.previewHash,
   ...Object.fromEntries([['runninghub','cloudCredentials'],['image-api','imageCredentials'],['studio','studioCredentials']].map(([kind,name])=>[name,preview.steps.filter(step=>step.kind===kind).map(step=>({nodeId:step.executionId,apiKey:key,authorization:authorize(step)}))]))};
 };
 const jobFile=id=>path.join(f.data,'jobs',id+'.json');
 async function wait(id,predicate=job=>!['queued','running'].includes(job.status)){
  for(let i=0;i<1200;i++){const job=await readJson(jobFile(id));if(predicate(job))return job;await delay(10);}
  throw Error('本机智能串联等待超时：'+JSON.stringify(await readJson(jobFile(id))));
 }
 async function idle(){for(let i=0;i<1200;i++){if(!f.activeJobs.size)return;await delay(10);}throw Error('本机任务未停止');}
 t.after(async()=>{for(const active of f.activeJobs.values())active.controller.abort();await idle();});
 return{...f,runner,target,body,wait,idle,jobFile};
}

test('正式串联预检无副作用，提交后新结果确实传递、加入接收方并保留原图',async t=>{
 const f=await fixture(t),before=structuredClone(f.project),preview=await f.runner.plan(f.project,{nodeId:'C'});
 assert.equal(preview.summary.requests,2);assert.equal(f.state.prompts.length,0);
 const visible=await f.runner.start(f.project,await f.body(),f.pool[0]);assert.equal(visible.executionMode,'native-cascade');assert.equal(visible.snapshot,undefined);assert.equal(visible.cascadeState,undefined);
 const job=await f.wait(visible.id);assert.equal(job.status,'completed',job.message);assert.equal(f.state.prompts.length,2);
 assert.deepEqual(f.state.prompts.map(r=>r.body.prompt['1'].inputs.text),['参数属于 A','参数属于 B']);
 const receipts=job.cascadeState.rounds[0].receipts,second=await readJson(f.jobFile(receipts[1].childJobId));
 assert.equal(receipts[1].inputRefs[0].assetId,receipts[0].outputRefs[0].assetId);
 assert.equal(second.imageBindings[0].assetId,receipts[0].outputRefs[0].assetId);
 assert.notEqual(second.imageBindings[0].assetId,before.nodes.find(n=>n.id==='B').params.nativeCanvas.mediaAssetIds[0]);
 assert.equal(job.steps[1].actualInput.referenceRefs[0].assetId,receipts[0].outputRefs[0].assetId);
 assert.equal(job.steps[1].actualInput.prompt,'参数属于 B');
 assert.equal(f.state.uploads.length,2);assert.deepEqual(f.project,before);
 const applied=await applyNativeCascadeResults({data:f.data,project:f.project,job,revision:f.project.revision});
 assert.equal(applied.applied,true);assert.equal(applied.project.assets.length,before.assets.length+2);
 for(const id of ['B','C']){
  const receiver=applied.project.nodes.find(n=>n.id===id),refs=job.cascadeState.receivers[id].currentRefs;
  assert.equal(receiver.assetId,refs.at(-1).assetId);assert.ok(receiver.params.nativeCanvas.mediaAssetIds.includes(before.nodes.find(n=>n.id===id).params.nativeCanvas.mediaAssetIds[0]));
 }
 assert.equal(applied.project.nodes.find(n=>n.id==='A').params.workflowBinding.workflowId,before.nodes.find(n=>n.id==='A').params.workflowBinding.workflowId);
 await assert.rejects(applyNativeCascadeResults({data:f.data,project:applied.project,job,revision:applied.project.revision}),/已经加入/);
});
test('同级共享不多提交，同一请求ID重复点击也不提交第二批',async t=>{
 const f=await fixture(t,{pairs:[['A','B'],['A','C'],['B','D'],['C','E']]}),preview=await f.runner.plan(f.project,{nodeId:'E'});
 assert.equal(preview.summary.sharedCopies,1);assert.equal(preview.summary.requests,3);
 const submitted=await f.runner.start(f.project,await f.body(),f.pool[0]),job=await f.wait(submitted.id);
 assert.equal(job.status,'completed',job.message);assert.equal(f.state.prompts.length,3);
 const duplicate=await f.runner.start(f.project,await f.body(),f.pool[0]);assert.equal(duplicate.id,job.id);assert.equal(f.state.prompts.length,3);
 const applied=await applyNativeCascadeResults({data:f.data,project:f.project,job,revision:f.project.revision});
 assert.equal(applied.project.nodes.find(n=>n.id==='B').assetId,applied.project.nodes.find(n=>n.id==='C').assetId);
});
test('展开批量的实际生成次数进入网页预览，文本被转义',async t=>{
 const f=await fixture(t);for(const node of f.project.nodes)node.params.workflowBinding.count=2;
 f.project.nodes[0].title='<script>bad</script>';
 const preview=await f.runner.plan(f.project,{nodeId:'C'}),html=nativeCascadePlanMarkup(preview,esc);
 assert.equal(preview.summary.requests,4);assert.match(html,/最多 4 次生成请求/);assert.ok(!html.includes('<script>bad'));
 const submitted=await f.runner.start(f.project,await f.body(),f.pool[0]),job=await f.wait(submitted.id);
 assert.equal(job.status,'completed',job.message);assert.equal(f.state.prompts.length,4);assert.equal(job.assets.length,4);
});
test('画布或模板修改后的旧检查不能直接提交',async t=>{
 const f=await fixture(t),body=await f.body();f.project.nodes[0].text+=' changed';
 await assert.rejects(f.runner.start(f.project,body,f.pool[0]),/重新检查/);assert.equal(f.state.prompts.length,0);
 const next=await f.body(),template=await f.generation.template(f.project.nodes[0].params.workflowBinding.workflowId);
 await f.generation.configure(template.id,{revision:template.revision,nativeConfig:{fields:[]}});
 await assert.rejects(f.runner.start(f.project,next,f.pool[0]),/重新检查/);assert.equal(f.state.prompts.length,0);
});
test('运行时编辑接收方受到保护，结果仍能作为独立节点取回',async t=>{
 const f=await fixture(t),submitted=await f.runner.start(f.project,await f.body(),f.pool[0]),job=await f.wait(submitted.id);
 assert.equal(job.status,'completed',job.message);const edited=structuredClone(f.project);edited.nodes.find(n=>n.id==='B').title='保留我的编辑';edited.revision++;
 const applied=await applyNativeCascadeResults({data:f.data,project:edited,job,revision:edited.revision});
 assert.equal(applied.project.nodes.find(n=>n.id==='B').title,'保留我的编辑');assert.equal(applied.project.nodes.find(n=>n.id==='B').assetId,edited.nodes.find(n=>n.id==='B').assetId);
 assert.equal(applied.project.runs.at(-1).cascadeTargets.length,0);assert.equal(applied.project.nodes.length,edited.nodes.length+2);
});
test('加入结果重新核对原子任务，伪造父任务完成状态不能通过',async t=>{
 const f=await fixture(t),submitted=await f.runner.start(f.project,await f.body(),f.pool[0]),job=await f.wait(submitted.id);
 assert.equal(job.status,'completed',job.message);const id=job.cascadeState.rounds[0].receipts[0].childJobId,child=await readJson(f.jobFile(id));
 await atomicJson(f.jobFile(id),{...child,status:'failed'});
 await assert.rejects(applyNativeCascadeResults({data:f.data,project:f.project,job,revision:f.project.revision}),/实际结果不一致/);
});
test('停止后查询原Comfy任务，不重复已提交生成，余下串联正常完成',async t=>{
 const f=await fixture(t);f.state.hold=true;
 const submitted=await f.runner.start(f.project,await f.body(),f.pool[0]);
 await f.wait(submitted.id,job=>job.steps[0].jobId&&f.state.prompts.length===1);
 const childId=(await readJson(f.jobFile(submitted.id))).steps[0].jobId;
 for(let i=0;i<500;i++){const child=await readJson(f.jobFile(childId));if(child.items?.some(item=>item.promptId))break;await delay(10);}
 f.activeJobs.get(submitted.id).controller.abort();const stopped=await f.wait(submitted.id);await f.idle();
 assert.equal(stopped.status,'cancelled');assert.equal(publicCascadeJob(stopped).canResume,true);assert.equal(f.state.prompts.length,1);
 f.state.hold=false;await f.runner.resume(stopped.id,{});const completed=await f.wait(stopped.id);await f.idle();
 assert.equal(completed.status,'completed',completed.message);assert.equal(f.state.prompts.length,2);assert.equal(completed.steps[0].jobId,childId);
});
for(const kind of ['runninghub','image-api','studio'])test(`正式串联接${kind}协议，每步单独授权且密钥不落盘`,async t=>{
 const f=await fixture(t,{kinds:{B:kind}}),body=await f.body(),name={runninghub:'cloudCredentials','image-api':'imageCredentials',studio:'studioCredentials'}[kind];
 const submitted=await f.runner.start(f.project,body,f.pool[0]),job=await f.wait(submitted.id);await f.idle();
 assert.equal(job.status,'completed',job.message);assert.equal(body[name][0].apiKey,'');
 assert.equal(f.state.prompts.length,1);assert.equal({runninghub:f.state.rhCreates,'image-api':f.state.images,studio:f.state.studioCreates}[kind].length,1);
 assert.ok(!JSON.stringify(await records(path.join(f.data,'jobs'))).includes(key));assert.ok(!JSON.stringify(f.project).includes(key));
 const applied=await applyNativeCascadeResults({data:f.data,project:f.project,job,revision:f.project.revision});assert.equal(applied.applied,true);
 assert.equal(applied.project.nodes.find(n=>n.id==='C').type,kind==='studio'?'video':'image');
});
test('缺少具体接口授权在任何生成前阻止执行',async t=>{
 const f=await fixture(t,{kinds:{B:'image-api'}}),body=await f.body();body.imageCredentials[0].authorization.origin='https://wrong.invalid';
 await assert.rejects(f.runner.start(f.project,body,f.pool[0]),/逐个确认/);assert.equal(body.imageCredentials[0].apiKey,'');assert.equal(f.state.prompts.length,0);assert.equal(f.state.images.length,0);
});
test('智能循环按轮生成独立素材槽，原循环和源节点不被改写',async t=>{
 const f=await fixture(t,{pairs:[['A','B']],target:'A'});
 f.project.nodes=f.project.nodes.filter(node=>node.id!=='B');f.project.edges=[];
 const loop=f.graph.node('L',{kind:'smart-loop',stored:false,count:2,start:3});f.graph.edge(loop,'A');
 const before=structuredClone(f.project),preview=await f.runner.plan(f.project,{nodeId:'A'});assert.equal(preview.summary.requests,2);
 const submitted=await f.runner.start(f.project,await f.body(),f.pool[0]),job=await f.wait(submitted.id);
 assert.equal(job.status,'completed',job.message);assert.equal(job.cascadeState.slots.length,2);
 const applied=await applyNativeCascadeResults({data:f.data,project:f.project,job,revision:f.project.revision});
 assert.deepEqual(applied.project.nodes.find(node=>node.id==='A'),before.nodes.find(node=>node.id==='A'));
 assert.deepEqual(applied.project.nodes.find(node=>node.id==='L'),before.nodes.find(node=>node.id==='L'));
 assert.deepEqual(applied.project.nodes.filter(node=>node.params.nativeCanvas?.node.loopRoundIndex).map(node=>node.params.nativeCanvas.node.loopRoundIndex),[3,4]);
 for(const slot of job.cascadeState.slots){const node=applied.project.nodes.find(n=>n.id===slot.nodeId);assert.ok(node.assetId);assert.equal(node.params.workflowBinding,undefined);}
});
test('并行串联按所选本机后端数运行，新增结果与串行规则一致',async t=>{
 const f=await fixture(t),loop=f.graph.node('L',{kind:'smart-loop',stored:false,count:2,mode:'parallel'});f.graph.edge(loop,'A');f.state.delayMs=25;
 const preview=await f.runner.plan(f.project,{nodeId:'C'});assert.equal(preview.program.scheduling.mode,'parallel');
 const submitted=await f.runner.start(f.project,await f.body(),{...f.pool[0],parallelBackends:f.pool}),job=await f.wait(submitted.id);
 assert.equal(job.status,'completed',job.message);assert.equal(f.state.prompts.length,4);assert.equal(f.state.maxActive,2);assert.equal(new Set(f.state.prompts.map(record=>record.backend)).size,2);
 const applied=await applyNativeCascadeResults({data:f.data,project:f.project,job,revision:f.project.revision});assert.equal(applied.appliedAssetIds.length,4);
});
test('缺少提示词时按原生规则只传已有素材，不把旧图记作新生成',async t=>{
 const f=await fixture(t);
 for(const node of f.project.nodes){node.params.nativeCanvas.node.promptDraftText='';node.params.nativeCanvas.node.promptDraftHtml='';node.text='';}
 const submitted=await f.runner.start(f.project,await f.body(),f.pool[0]),job=await f.wait(submitted.id);
 assert.equal(job.status,'completed',job.message);assert.equal(job.assets.length,0);assert.equal(f.state.prompts.length,0);assert.equal(f.state.uploads.length,0);
 const result=await applyNativeCascadeResults({data:f.data,project:f.project,job,revision:f.project.revision});
 assert.equal(result.project.assets.length,f.project.assets.length);assert.equal(result.project.nodes.length,f.project.nodes.length);assert.equal(result.applied,true);
 assert.equal(result.project.nodes.find(n=>n.id==='B').assetId,f.project.nodes.find(n=>n.id==='A').params.nativeCanvas.mediaAssetIds[0]);
 await assert.rejects(applyNativeCascadeResults({data:f.data,project:result.project,job,revision:result.project.revision}),/已经加入/);
});
test('分步取回后继续只追加余下结果，保留前次接收方及素材历史',async t=>{
 const f=await fixture(t),runner=nativeCascadeRunner({...f,pollInterval:10,generation:{...f.generation,
  start:async(...args)=>{if(args[1].nodeId==='B')f.state.hold=true;return f.generation.start(...args);}}});
 const submitted=await runner.start(f.project,await f.body(),f.pool[0]);
 await f.wait(submitted.id,job=>job.assets.length===1&&job.steps[1].jobId&&f.state.prompts.length===2);
 const held=(await readJson(f.jobFile(submitted.id))).steps[1].jobId;
 for(let i=0;i<500;i++){if((await readJson(f.jobFile(held))).items.some(item=>item.promptId))break;await delay(10);}
 f.activeJobs.get(submitted.id).controller.abort();const stopped=await f.wait(submitted.id);await f.idle();
 assert.equal(stopped.status,'cancelled');
 await assert.rejects(applyNativeCascadeResults({data:f.data,project:f.project,job:stopped,revision:f.project.revision}),/确认/);
 const first=await applyNativeCascadeResults({data:f.data,project:f.project,job:stopped,revision:f.project.revision,acceptPartial:true});assert.equal(first.applied,false);assert.equal(first.appliedAssetIds.length,1);
 f.state.hold=false;await runner.resume(stopped.id,{});const completed=await f.wait(stopped.id);await f.idle();assert.equal(completed.status,'completed',completed.message);assert.equal(f.state.prompts.length,2);
 const final=await applyNativeCascadeResults({data:f.data,project:first.project,job:completed,revision:first.project.revision});
 assert.equal(final.applied,true);assert.equal(final.appliedAssetIds.length,2);assert.equal(final.project.assets.length,f.project.assets.length+2);assert.equal(final.project.nodes.length,f.project.nodes.length+2);
 assert.equal(final.project.nodes.find(n=>n.id==='B').assetId,first.project.nodes.find(n=>n.id==='B').assetId);
});
