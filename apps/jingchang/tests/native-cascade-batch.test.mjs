import test from 'node:test';
import assert from 'node:assert/strict';
import {cascadeSpecializedFixture} from './helpers/native-cascade-specialized-fixture.mjs';
import {nativeCascadeRunner} from '../lib/native-cascade-runner.mjs';
import {generationService} from '../lib/generation.mjs';
import {applyNativeCascadeResults} from '../lib/native-cascade-results.mjs';
import {nativeCascadePlanMarkup,nativeCascadeRequestMarkup} from '../public/native-cascade-ui.js';
import {atomicJson,readJson,records} from '../lib/workspace.mjs';
import path from 'node:path';

const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const values=['第一条《计数》与 @原图','第二条 <literal>','第三条《总数》'];
const fixture=(t,options={})=>cascadeSpecializedFixture(t,{batch:{nodeId:'1',name:'text',values},...options});

test('literal list preflight counts requests and production child sends each saved item once to loopback',async t=>{
 const f=await fixture(t),before=structuredClone(f.project),preview=await f.runner.plan(f.project,{nodeId:'C'});
 assert.equal(preview.summary.requests,3);assert.equal(preview.summary.generations,1);assert.equal(preview.summary.sharedCopies,1);assert.deepEqual(preview.steps[0].promptBatch.values,values);assert.equal(f.state.prompts.length,0);
 const job=await f.launch();assert.equal(job.status,'completed',job.message);assert.equal(f.state.prompts.length,3);assert.equal(f.state.uploads.length,1);
 assert.deepEqual(f.state.prompts.map(item=>item.body.prompt['1'].inputs.text),values);assert.equal(job.assets.length,3);
 const input=job.steps[0].actualInput,child=await readJson(f.file(job.steps[0].jobId));assert.deepEqual(input.promptBatch.values,values);assert.equal(input.providerRequestCount,3);assert.equal(input.batchExecution.count,3);assert.equal(child.count,3);
 assert.deepEqual(child.cascadeBatch.promptBatch,input.promptBatch);assert.deepEqual(child.items.map(item=>item.prompt),values);assert.deepEqual(child.assets.map(asset=>asset.batchIndex),[0,1,2]);assert.deepEqual(f.project,before);
 const applied=await applyNativeCascadeResults({data:f.data,project:f.project,job,revision:f.project.revision});assert.equal(applied.applied,true);assert.equal(applied.appliedAssetIds.length,3);
 assert.deepEqual(applied.project.nodes.find(node=>node.id==='B').params.nativeCanvas.node.generatedOutputs,applied.project.nodes.find(node=>node.id==='C').params.nativeCanvas.node.generatedOutputs);
 const replay=await f.runner.start(f.project,await f.body(),f.pool[0]);assert.equal(replay.id,job.id);assert.equal(f.state.prompts.length,3);
 assert.match(nativeCascadePlanMarkup(preview,esc),/3 条 · 最多 3 次请求/);const html=nativeCascadeRequestMarkup(job.steps[0],esc);assert.match(html,/3 条 · 已提交 3 \/ 3 次请求/);assert.match(html,/原编号 fixture-/);assert.match(html,/《计数》/);assert.match(html,/&lt;literal&gt;/);
});
test('saved nine-item list exceeds ordinary batch limit without truncating or multiplying sibling requests',async t=>{
 const list=Array.from({length:9},(_,i)=>'literal '+i),f=await fixture(t,{batch:{nodeId:'1',name:'text',values:list}});
 const job=await f.launch();assert.equal(job.status,'completed',job.message);assert.equal(job.summary.requests,9);assert.deepEqual(f.state.prompts.map(item=>item.body.prompt['1'].inputs.text),list);assert.equal(job.assets.length,9);
});
test('random values are materialized into actual input once; stop/replacement runner queries original child then runs remaining list items',async t=>{
 const f=await fixture(t),old=await f.generation.template(f.template.id),template=await f.generation.configure(old.id,{revision:old.revision,fields:[...old.fields.filter(field=>field.nodeId!=='4'),{nodeId:'4',name:'seed',control:'number',min:1,max:100,randomEnabled:true}]});
 const a=await f.runner.plan(f.project,{nodeId:'C'}),b=await f.runner.plan(f.project,{nodeId:'C'});assert.equal(a.previewHash,b.previewHash);assert.equal(a.steps[0].workflowRandom,undefined);
 const {stopped,childId}=await f.stop(),actual=structuredClone(stopped.steps[0].actualInput),child=await readJson(f.file(childId)),promptId=child.items[0].promptId;
 assert.equal(stopped.steps[0].childRequests.submitted,1);assert.match(nativeCascadeRequestMarkup(stopped.steps[0],esc),/已提交 1 \/ 3 次请求/);
 assert.equal(actual.workflowRandom.batches.length,3);assert.deepEqual(actual.workflowRandom,child.workflowRandom);assert.equal(f.state.prompts[0].body.prompt['4'].inputs.seed,actual.workflowRandom.batches[0].values[0].value);
 await f.generation.configure(template.id,{revision:template.revision,fields:template.fields.map(field=>field.nodeId==='4'?{...field,randomEnabled:false}:field)});
 f.state.hold=false;const replacement=nativeCascadeRunner({...f,generation:generationService({data:f.data,activeJobs:f.activeJobs}),pollInterval:5});await replacement.resume(stopped.id,{});
 const job=await f.wait(stopped.id);assert.equal(job.status,'completed',job.message);assert.equal(job.steps[0].jobId,childId);assert.deepEqual(job.steps[0].actualInput,actual);assert.equal(f.state.prompts.length,3);assert.equal(f.state.uploads.length,1);
 const completed=await readJson(f.file(childId));assert.equal(completed.items[0].promptId,promptId);assert.deepEqual(completed.workflowRandom,actual.workflowRandom);
 assert.deepEqual(f.state.prompts.map(item=>item.body.prompt['4'].inputs.seed),actual.workflowRandom.batches.map(batch=>batch.values[0].value));
});
for(const [name,change]of [
 ['empty',b=>{b.promptBatch.values=[];}],['too many',b=>{b.promptBatch.values=Array(65).fill('x');}],['wrong count',b=>{b.count=2;}],
 ['media field',b=>{b.promptBatch={nodeId:'3',name:'image',values:['bad']};}],['same automatic prompt field',b=>{b.promptField={nodeId:'1',name:'text'};}],
 ['H3',b=>{b.minimaxH3={};}],['LTX',b=>{b.ltxDirector={};}]
])test(`invalid ${name} is rejected in preflight with no child or local upload`,async t=>{
 const f=await fixture(t);change(f.source.params.workflowBinding);await assert.rejects(f.runner.plan(f.project,{nodeId:'C'}));assert.equal(f.state.prompts.length,0);assert.equal(f.state.uploads.length,0);assert.equal((await records(path.join(f.data,'jobs'))).length,0);
});
test('hidden list field is rejected before submission',async t=>{
 const f=await fixture(t);await f.generation.configure(f.template.id,{revision:f.template.revision,fields:[{nodeId:'1',name:'text',control:'textarea',exposed:false}]});
 await assert.rejects(f.runner.plan(f.project,{nodeId:'C'}),/隐藏/);assert.equal(f.state.prompts.length,0);
});
for(const [name,change]of [
 ['literal values',child=>{child.promptBatch.values[0]='tampered';}],['seed baseline',child=>{child.workflow['4'].inputs.seed++;}],
 ['upload path',child=>{child.workflow['3'].inputs.image='another.png';}],['item prompt',child=>{child.items[0].prompt='tampered';}],
 ['missing original id',child=>{child.items[0].promptId=null;}],['changed original id',child=>{child.items[0].promptId='another-original-id';}]
])test(`resume rejects changed ${name} without another submission`,async t=>{
 const f=await fixture(t),{stopped,childId}=await f.stop(),child=await readJson(f.file(childId));change(child);await atomicJson(f.file(childId),child);
 f.state.hold=false;await f.runner.resume(stopped.id,{});const job=await f.wait(stopped.id);assert.equal(job.status,'failed');assert.equal(f.state.prompts.length,1);assert.equal(f.state.uploads.length,1);assert.equal(job.assets.length,0);
});
test('edited receiver is preserved and completed list results are recovered independently',async t=>{
 const f=await fixture(t),job=await f.launch(),edited=structuredClone(f.project);edited.nodes.find(node=>node.id==='B').title='用户新编辑';edited.revision++;
 const result=await applyNativeCascadeResults({data:f.data,project:edited,job,revision:edited.revision});assert.equal(result.project.nodes.find(node=>node.id==='B').title,'用户新编辑');assert.equal(result.appliedAssetIds.length,3);assert.equal(result.project.nodes.find(node=>node.id==='B').assetId,edited.nodes.find(node=>node.id==='B').assetId);assert.equal(f.state.prompts.length,3);
});
test('workflow revision race is refused before recording actual list or starting the child',async t=>{
 const f=await fixture(t),original=await f.generation.template(f.template.id);let reads=0,starts=0;
 const generation={...f.generation,template:async()=>{reads++;return structuredClone({...original,revision:original.revision+(reads>=3?1:0)});},start:async(...args)=>{starts++;return f.generation.start(...args);}};
 const runner=nativeCascadeRunner({...f,generation,pollInterval:5}),body=await f.body('batch-revision-race'),started=await runner.start(f.project,body,f.pool[0]),job=await f.wait(started.id);
 assert.equal(job.status,'failed');assert.match(job.message,/列表工作流在准备期间已修改/);assert.equal(job.steps[0].actualInput,undefined);assert.equal(starts,0);assert.equal(f.state.prompts.length,0);
});
test('two loop rounds retain literal list values and the real nonrandom seed offsets',async t=>{
 const f=await fixture(t),loop=f.graph.node('L',{kind:'smart-loop',stored:false,count:2,start:4});f.graph.edge(loop,'A');f.source.params.workflowBinding.incrementSeeds=true;
 const preview=await f.runner.plan(f.project,{nodeId:'C'});assert.equal(preview.summary.requests,6);assert.equal(preview.summary.generations,2);
 const job=await f.launch();assert.equal(job.status,'completed',job.message);assert.equal(f.state.prompts.length,6);assert.deepEqual(f.state.prompts.map(item=>item.body.prompt['1'].inputs.text),[...values,...values]);
 assert.deepEqual(f.state.prompts.map(item=>item.body.prompt['4'].inputs.seed),[30,31,32,33,34,35]);assert.deepEqual(job.steps.filter(step=>step.kind==='comfy').map(step=>step.actualInput.batchExecution.seedOffset),[0,3]);
 assert.equal(job.assets.length,6);
});
test('changed parent offset is rejected before querying the saved child',async t=>{
 const f=await fixture(t),{stopped}=await f.stop();stopped.steps[0].actualInput.batchExecution.seedOffset=1;await atomicJson(f.file(stopped.id),stopped);
 f.state.hold=false;await f.runner.resume(stopped.id,{});const job=await f.wait(stopped.id);assert.equal(job.status,'failed');assert.equal(f.state.prompts.length,1);
});
test('literal list preserves separate text settings and an explicit different prompt field receives upstream text',async t=>{
 const workflow={'1':{class_type:'CLIPTextEncode',inputs:{text:'original list target'}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}},'3':{class_type:'LoadImage',inputs:{image:'original.png'}},'4':{class_type:'KSampler',inputs:{seed:30}},'5':{class_type:'CLIPTextEncode',inputs:{text:'separate original'}},'6':{class_type:'CLIPTextEncode',inputs:{text:'negative original'}}};
 const f=await fixture(t,{workflow}),old=await f.generation.template(f.template.id);await f.generation.configure(old.id,{revision:old.revision,fields:[...old.fields.filter(field=>!['5','6'].includes(field.nodeId)),
  {nodeId:'5',name:'text',control:'textarea',nativeFieldId:'independent',defaultValue:'independent default'},
  {nodeId:'6',name:'text',control:'textarea',nativeFieldId:'negative',defaultValue:'negative default'}]});
 f.source.params.workflowBinding.promptField={nodeId:'5',name:'text'};f.source.params.workflowBinding.overrides=[{nodeId:'6',name:'text',value:'saved negative override'}];
 const prompt=f.graph.node('P',{kind:'smart-prompt',stored:false,raw:{text:'independent composed text'}});prompt.text='independent composed text';f.graph.edge(prompt,'A','input');
 const job=await f.launch();assert.equal(job.status,'completed',job.message);assert.deepEqual(f.state.prompts.map(item=>item.body.prompt['1'].inputs.text),values);
 assert.ok(f.state.prompts.every(item=>item.body.prompt['5'].inputs.text==='independent composed text'&&item.body.prompt['6'].inputs.text==='saved negative override'));
 assert.deepEqual(job.steps[0].actualInput.promptFields,[{nodeId:'5',name:'text'}]);
});
test('selected random field ignores stale out-of-range manual override exactly as the existing generator',async t=>{
 const f=await fixture(t),old=await f.generation.template(f.template.id);await f.generation.configure(old.id,{revision:old.revision,fields:[...old.fields.filter(field=>field.nodeId!=='4'),{nodeId:'4',name:'seed',control:'number',min:1,max:100,randomEnabled:true}]});
 f.source.params.workflowBinding.overrides=[{nodeId:'4',name:'seed',value:10000}];const preview=await f.runner.plan(f.project,{nodeId:'C'});assert.equal(preview.summary.requests,3);
 const job=await f.launch();assert.equal(job.status,'completed',job.message);assert.ok(f.state.prompts.every(item=>item.body.prompt['4'].inputs.seed>=1&&item.body.prompt['4'].inputs.seed<100));assert.equal(f.state.uploads.length,1);
});
