import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {cascadeProtocolFixture} from './helpers/native-cascade-protocol-fixture.mjs';
import {enhanceWorkflow,enhanceRecipe,upscaleRecipe,originalPng,enhancedPng} from './helpers/image-enhance-fixture.mjs';
import {nativeCascadeRunner,publicCascadeJob} from '../lib/native-cascade-runner.mjs';
import {generationService} from '../lib/generation.mjs';
import {applyNativeCascadeResults} from '../lib/native-cascade-results.mjs';
import {nativeScalarReference} from '../lib/native-director-inputs.mjs';
import {storeAsset,loadAsset,readJson,atomicJson,records} from '../lib/workspace.mjs';

// Every service is production code, but every request is to an isolated
// loopback Comfy fixture; no installed model, key, or formal project is used.
async function fixture(t,{seedMode='fixed'}={}){
 const f=await cascadeProtocolFixture(t,{pairs:[['A','B'],['A','C']]});f.activeJobs.delete(f.parentId);
 const source=f.project.nodes.find(node=>node.id==='A'),first=await storeAsset(f.data,originalPng,{name:'first.png',type:'image/png'}),second=await storeAsset(f.data,enhancedPng,{name:'second.png',type:'image/png'});
 f.project.assets.push(first,second);
 const native=source.params.nativeCanvas;
 native.node.images=[first,second].map((asset,index)=>({url:'/synthetic/enhance/'+index,name:asset.name,kind:'image'}));
 native.resources.push(...[first,second].map((asset,index)=>({url:'/synthetic/enhance/'+index,assetId:asset.id,archive:'synthetic/'+index+'.png'})));
 native.mediaAssetIds=[first.id,second.id];
 native.node.promptDraftText='';native.node.promptDraftHtml='';source.text='';
 const template=await f.generation.saveTemplate({name:'isolated cascade enhance',workflow:enhanceWorkflow});
 const recipe={...enhanceRecipe(),seedMode};if(seedMode!=='fixed')delete recipe.seed;
 source.params.workflowBinding={workflowId:template.id,overrides:[],imageSources:[{...recipe.imageField,sourceNodeId:'A'}],count:1,
  promptField:{nodeId:'23',name:'text'},imageEnhance:recipe,incrementSeeds:false};
 const runner=nativeCascadeRunner({...f,pollInterval:5}),file=id=>path.join(f.data,'jobs',id+'.json');
 async function wait(id,predicate=job=>!['queued','running'].includes(job.status)){
  for(let i=0;i<1200;i++){const job=await readJson(file(id));if(predicate(job))return job;await delay(5);}throw Error('isolated enhancement timeout');
 }
 async function idle(){for(let i=0;i<1200;i++){if(!f.activeJobs.size)return;await delay(5);}throw Error('isolated enhancement not idle');}
 const body=async(requestId='enhancement-parent')=>({requestId,nodeId:'C',revision:f.project.revision,consent:true,previewHash:(await runner.plan(f.project,{nodeId:'C'})).previewHash});
 async function launch(){const started=await runner.start(f.project,await body(),f.pool[0]);return wait(started.id);}
 async function stop(){f.state.hold=true;const started=await runner.start(f.project,await body(),f.pool[0]);
  const accepted=await wait(started.id,job=>job.steps[0].jobId&&f.state.prompts.length===1),childId=accepted.steps[0].jobId;
  await wait(childId,job=>job.items.some(item=>item.promptId));f.activeJobs.get(started.id).controller.abort();const stopped=await wait(started.id);await idle();
  assert.equal(stopped.status,'cancelled');assert.equal(publicCascadeJob(stopped).canResume,true);return{stopped,childId};
 }
 async function completeChild(stopped,childId){
  f.state.hold=false;f.activeJobs.set(stopped.id,{controller:new AbortController(),projectId:f.project.id,kind:'canvas-run'});
  try{await f.generation.resume(childId,{parentId:stopped.id});await wait(childId);for(let i=0;i<500&&f.activeJobs.has(childId);i++)await delay(5);assert.ok(!f.activeJobs.has(childId));}
  finally{f.activeJobs.delete(stopped.id);}
 }
 t.after(async()=>{for(const active of f.activeJobs.values())active.controller.abort();await idle();});
 return {...f,runner,source,first,second,template,recipe,file,wait,idle,body,launch,stop,completeChild};
}

test('no prompt + two images + two receivers uses the first image and one real child receipt',async t=>{
 const f=await fixture(t),before=structuredClone(f.project),preview=await f.runner.plan(f.project,{nodeId:'C'});
 assert.equal(preview.summary.requests,1);assert.equal(preview.summary.sharedCopies,1);assert.equal(preview.steps[0].imageEnhance.strength,.65);assert.equal(f.state.prompts.length,0);
 // The ordinary native scalar contract would reject this ambiguous mapping;
 // the pinned cascade contract deliberately selects the first actual image.
 const scalarProject=structuredClone(f.project),scalarSource=scalarProject.nodes.find(n=>n.id==='A');delete scalarSource.params.workflowBinding;scalarSource.params.nativeCanvas.adaptation='configured';
 assert.throws(()=>nativeScalarReference(scalarProject,scalarProject.nodes.find(n=>n.id==='B'),{sourceNodeId:'A'},'image'),/多份素材/);
 const job=await f.launch();await f.idle();assert.equal(job.status,'completed',job.message);
 assert.equal(f.state.prompts.length,1);assert.equal(f.state.uploads.length,1);assert.ok(f.state.uploads[0].bytes.includes(originalPng));assert.ok(!f.state.uploads[0].bytes.includes(enhancedPng));
 const submitted=f.state.prompts[0].body.prompt;assert.equal(submitted['204'].inputs.value,.65);assert.equal(submitted['23'].inputs.text,'details');assert.equal(submitted['146'].inputs.seed,1234);assert.equal(submitted['181'].inputs.seed,1234);
 const input=job.steps[0].actualInput;assert.equal(input.prompt,'');assert.deepEqual(input.promptFields,[]);assert.equal(input.enhancement.sourceAssetId,f.first.id);assert.equal(input.enhancement.sourceIdentity,input.referenceRefs[0].identity);assert.equal(input.unusedRefs[0].assetId,f.second.id);
 assert.ok(!Object.hasOwn(input,'overrides'));assert.ok(!Object.hasOwn(input,'apiKey'));
 const receipt=job.cascadeState.rounds[0].receipts[0],child=await readJson(f.file(receipt.childJobId));assert.equal(child.count,1);assert.equal(child.imageBindings[0].assetId,f.first.id);assert.deepEqual(child.cascadeEnhancement,input.enhancement);
 const asset=await loadAsset(f.data,job.assets[0].id);assert.deepEqual(asset.enhancement,{kind:'enhance',engine:'comfy',sourceAssetId:f.first.id,originalAssetId:f.first.id,strength:.65,seed:1234});assert.deepEqual(child.assets[0].enhancement,asset.enhancement);
 const applied=await applyNativeCascadeResults({data:f.data,project:f.project,job,revision:f.project.revision});assert.equal(applied.applied,true);assert.equal(applied.appliedAssetIds.length,1);
 assert.equal(applied.project.nodes.find(n=>n.id==='B').assetId,applied.project.nodes.find(n=>n.id==='C').assetId);assert.deepEqual(f.project,before);assert.deepEqual(applied.project.nodes.find(n=>n.id==='A'),before.nodes.find(n=>n.id==='A'));
 await assert.rejects(applyNativeCascadeResults({data:f.data,project:applied.project,job,revision:applied.project.revision}),/已经加入/);
 const replay=await f.runner.start(f.project,await f.body(),f.pool[0]);assert.equal(replay.id,job.id);assert.equal(f.state.prompts.length,1);
});
test('non-image first ref is filtered before choosing the first image',async t=>{
 const f=await fixture(t),audio=await storeAsset(f.data,Buffer.from('synthetic audio not sent'),{type:'audio/wav',name:'not-sent.wav'});f.project.assets.push(audio);
 const n=f.source.params.nativeCanvas;n.node.images.unshift({url:'/synthetic/audio',kind:'audio',name:'not-sent.wav'});n.resources.push({url:'/synthetic/audio',assetId:audio.id,archive:'synthetic/audio'});n.mediaAssetIds.unshift(audio.id);
 const job=await f.launch();assert.equal(job.status,'completed',job.message);assert.equal(job.steps[0].actualInput.enhancement.sourceAssetId,f.first.id);assert.equal(job.steps[0].actualInput.referenceRefs[0].kind,'audio');assert.equal(f.state.uploads.length,1);
});
test('same file with two source identities keeps the first identity in the actual ledger',async t=>{
 const f=await fixture(t),n=f.source.params.nativeCanvas;n.node.images[1]={url:'/synthetic/alias',kind:'image',name:'first alias'};n.resources.push({url:'/synthetic/alias',assetId:f.first.id,archive:'synthetic/alias'});
 const job=await f.launch();assert.equal(job.status,'completed',job.message);const input=job.steps[0].actualInput;
 assert.equal(input.referenceRefs.length,2);assert.equal(input.referenceRefs[0].assetId,input.referenceRefs[1].assetId);assert.notEqual(input.referenceRefs[0].identity,input.referenceRefs[1].identity);assert.equal(input.enhancement.sourceIdentity,input.referenceRefs[0].identity);assert.equal(input.unusedRefs.length,1);assert.equal(f.state.prompts.length,1);
});
test('enhancing an existing enhancement retains the original-image ancestry',async t=>{
 const f=await fixture(t),enhancement={kind:'enhance',engine:'comfy',sourceAssetId:f.second.id,originalAssetId:f.second.id,strength:.4,seed:12};
 await atomicJson(path.join(f.data,'assets',f.first.id+'.json'),{...f.first,enhancement});Object.assign(f.project.assets.find(asset=>asset.id===f.first.id),{enhancement});
 const job=await f.launch();assert.equal(job.status,'completed',job.message);assert.equal(job.assets[0].enhancement.sourceAssetId,f.first.id);assert.equal(job.assets[0].enhancement.originalAssetId,f.second.id);assert.equal(f.state.prompts.length,1);
});
test('workflow seed policy preserves the template seeds without inventing an actual seed',async t=>{
 const f=await fixture(t,{seedMode:'workflow'}),preview=await f.runner.plan(f.project,{nodeId:'C'});assert.equal(preview.steps[0].imageEnhance.seed,undefined);
 const job=await f.launch();assert.equal(job.status,'completed',job.message);assert.equal(f.state.prompts[0].body.prompt['146'].inputs.seed,10);assert.equal(f.state.prompts[0].body.prompt['181'].inputs.seed,20);
 assert.equal(job.steps[0].actualInput.enhancement.seedMode,'workflow');assert.equal(job.steps[0].actualInput.enhancement.seed,undefined);assert.equal(job.assets[0].enhancement.seed,undefined);assert.equal(f.state.prompts.length,1);
});
for(const [name,change]of [
 ['upscale',b=>{b.imageEnhance=upscaleRecipe();}],['ModelScope',b=>{b.imageEnhance={kind:'enhance',engine:'modelscope'};}],
 ['H3',b=>{b.minimaxH3={};}],['LTX',b=>{b.ltxDirector={};}],['prompt list',b=>{b.promptBatch={};}],['multiple count',b=>{b.count=2;}],['increment seeds',b=>{b.incrementSeeds=true;}],
 ['controlled field conflict',b=>{b.overrides=[{nodeId:'204',name:'value',value:.6}];}],['bad image mapping',b=>{b.imageEnhance.imageField={nodeId:'23',name:'text'};b.imageSources=[{nodeId:'23',name:'text',assetId:'absent'}];}]
])test(`${name} is rejected during preflight, with zero submissions`,async t=>{
 const f=await fixture(t);change(f.source.params.workflowBinding);await assert.rejects(f.runner.plan(f.project,{nodeId:'C'}));assert.equal(f.state.prompts.length,0);assert.equal(f.state.uploads.length,0);assert.equal((await records(path.join(f.data,'jobs'))).length,0);
});
test('hidden source mapping and ordinary random fields cannot bypass enhancement controls',async t=>{
 const f=await fixture(t);await f.generation.configure(f.template.id,{revision:f.template.revision,fields:[{nodeId:'15',name:'image',control:'text',exposed:false}]});
 await assert.rejects(f.runner.plan(f.project,{nodeId:'C'}),/隐藏/);assert.equal(f.state.prompts.length,0);
 const current=await f.generation.template(f.template.id);await f.generation.configure(current.id,{revision:current.revision,fields:[{nodeId:'146',name:'seed',control:'number',randomEnabled:true}]});
 await assert.rejects(f.runner.plan(f.project,{nodeId:'C'}),/普通随机/);assert.equal(f.state.prompts.length,0);
});
for(const [name,config]of [['positive minimum',{min:1,max:4294967295,step:1}],['small maximum',{min:0,max:20,step:1}],['stepped seeds',{min:0,max:4294967295,step:2}],['fractional steps',{min:0,max:4294967295,step:.5}],['select seeds',{control:'select',options:[0,10,20],defaultValue:10}]])
 test(`random ${name} is explicitly rejected before preview while a valid fixed seed remains available`,async t=>{
  const f=await fixture(t,{seedMode:'random'});await f.generation.configure(f.template.id,{revision:f.template.revision,fields:[{nodeId:'146',name:'seed',control:'number',...config}]});
  await assert.rejects(f.runner.plan(f.project,{nodeId:'C'}),/完整.*受限字段请改用固定种子或工作流种子/);assert.equal(f.state.prompts.length,0);assert.equal(f.state.uploads.length,0);
  f.source.params.workflowBinding.imageEnhance={...f.recipe,seedMode:'fixed',seed:10};const preview=await f.runner.plan(f.project,{nodeId:'C'});assert.equal(preview.steps[0].imageEnhance.seed,10);
 });
test('random seed controls spanning all UInt32 integers can preview and execute safely',async t=>{
 const f=await fixture(t,{seedMode:'random'});await f.generation.configure(f.template.id,{revision:f.template.revision,fields:[{nodeId:'146',name:'seed',control:'number',min:0,max:4294967295,step:1}]});
 const a=await f.runner.plan(f.project,{nodeId:'C'}),b=await f.runner.plan(f.project,{nodeId:'C'});assert.equal(a.previewHash,b.previewHash);assert.equal(a.steps[0].imageEnhance.seed,undefined);
 const job=await f.launch();assert.equal(job.status,'completed',job.message);assert.ok(Number.isInteger(job.steps[0].actualInput.enhancement.seed));assert.equal(f.state.prompts.length,1);
});
test('template revision changing between parent check and request preparation is rejected before saving actual input or starting a child',async t=>{
 const f=await fixture(t);let reads=0,starts=0;const original=await f.generation.template(f.template.id),generation={...f.generation,
  template:async()=>{reads++;return structuredClone({...original,revision:original.revision+(reads>=3?1:0)});},
  start:async(...args)=>{starts++;return f.generation.start(...args);}};
 const runner=nativeCascadeRunner({...f,generation,pollInterval:5}),submitted=await runner.start(f.project,await f.body('enhancement-revision-race'),f.pool[0]),job=await f.wait(submitted.id);
 assert.equal(reads,3);assert.equal(job.status,'failed');assert.match(job.message,/增强工作流在准备期间已修改/);assert.equal(job.steps[0].actualInput,undefined);assert.equal(starts,0);assert.equal(f.state.prompts.length,0);assert.equal(f.state.uploads.length,0);
});
test('no image is a real failure rather than missing-prompt fallback',async t=>{
 const f=await fixture(t),n=f.source.params.nativeCanvas,audio=await storeAsset(f.data,Buffer.from('not sent'),{type:'audio/wav',name:'only-audio.wav'});f.project.assets.push(audio);
 n.node.images=[{url:'/synthetic/only-audio',kind:'audio',name:'only-audio.wav'}];n.mediaAssetIds=[audio.id];n.resources=[{url:'/synthetic/only-audio',assetId:audio.id,archive:'synthetic/audio'}];
 const job=await f.launch();assert.equal(job.status,'failed');assert.match(job.message,/至少一张图片/);assert.equal(job.assets.length,0);assert.equal(f.state.prompts.length,0);assert.equal(f.state.uploads.length,0);assert.equal(job.steps[0].actualInput,undefined);
});
test('mismatched image bytes are rejected before upload or actual seed selection',async t=>{
 const f=await fixture(t,{seedMode:'random'});await fs.writeFile(path.join(f.data,'assets',f.first.id),Buffer.alloc(f.first.size,1));
 const job=await f.launch();assert.equal(job.status,'failed');assert.equal(f.state.uploads.length,0);assert.equal(f.state.prompts.length,0);assert.equal(job.steps[0].actualInput,undefined);
});
test('two random previews agree, execution records one seed, cancellation resumes the same upstream job',async t=>{
 const f=await fixture(t,{seedMode:'random'}),a=await f.runner.plan(f.project,{nodeId:'C'}),b=await f.runner.plan(f.project,{nodeId:'C'});
 assert.equal(a.previewHash,b.previewHash);assert.equal(a.steps[0].imageEnhance.seedMode,'random');assert.ok(!Object.hasOwn(a.steps[0].imageEnhance,'seed'));assert.equal(a.steps[0].actualInput,undefined);
 const {stopped,childId}=await f.stop(),actual=structuredClone(stopped.steps[0].actualInput),seed=actual.enhancement.seed;
 assert.ok(Number.isSafeInteger(seed));assert.equal(f.state.prompts[0].body.prompt['146'].inputs.seed,seed);assert.equal(f.state.prompts[0].body.prompt['181'].inputs.seed,seed);
 f.state.hold=false;const replacement=nativeCascadeRunner({...f,generation:generationService({data:f.data,activeJobs:f.activeJobs}),pollInterval:5});await replacement.resume(stopped.id,{});
 const completed=await f.wait(stopped.id);await f.idle();assert.equal(completed.status,'completed',completed.message);assert.deepEqual(completed.steps[0].actualInput,actual);assert.equal(completed.steps[0].jobId,childId);assert.equal(f.state.prompts.length,1);assert.equal(f.state.uploads.length,1);assert.equal(completed.assets[0].enhancement.seed,seed);
});
test('already-completed child is annotated from the original ledger on resume without another submission',async t=>{
 const f=await fixture(t,{seedMode:'random'}),{stopped,childId}=await f.stop(),actual=structuredClone(stopped.steps[0].actualInput);
 await f.completeChild(stopped,childId);const completedChild=await readJson(f.file(childId));assert.equal(completedChild.status,'completed');assert.equal(completedChild.cascadeEnhancement,undefined);assert.equal((await loadAsset(f.data,completedChild.assets[0].id)).enhancement,undefined);
 await f.runner.resume(stopped.id,{});const job=await f.wait(stopped.id);assert.equal(job.status,'completed',job.message);assert.equal(job.steps[0].jobId,childId);assert.deepEqual(job.steps[0].actualInput,actual);assert.equal(f.state.prompts.length,1);assert.equal(f.state.uploads.length,1);assert.equal(job.assets[0].enhancement.seed,actual.enhancement.seed);
});
test('annotation conflict preserves the completed child and blocks downstream without retry',async t=>{
 const f=await fixture(t),{stopped,childId}=await f.stop();await f.completeChild(stopped,childId);const child=await readJson(f.file(childId)),asset=await loadAsset(f.data,child.assets[0].id),conflict={kind:'enhance',engine:'comfy',sourceAssetId:f.second.id,originalAssetId:f.second.id,strength:.8,seed:55};
 await atomicJson(path.join(f.data,'assets',asset.id+'.json'),{...asset,enhancement:conflict});await f.runner.resume(stopped.id,{});const job=await f.wait(stopped.id);
 assert.equal(job.status,'failed');assert.match(job.message,/来源记录冲突/);assert.equal(job.assets.length,0);assert.equal(f.state.prompts.length,1);assert.equal((await readJson(f.file(childId))).status,'completed');assert.deepEqual((await loadAsset(f.data,asset.id)).enhancement,conflict);assert.ok((await fs.stat(path.join(f.data,'assets',asset.id))).size>0);
});
test('a completed child with another parent cannot be annotated or adopted',async t=>{
 const f=await fixture(t),{stopped,childId}=await f.stop();await f.completeChild(stopped,childId);const child=await readJson(f.file(childId));await atomicJson(f.file(childId),{...child,parentId:'other-parent'});
 await f.runner.resume(stopped.id,{});const job=await f.wait(stopped.id);assert.equal(job.status,'failed');assert.match(job.message,/不属于原发送方/);assert.equal((await loadAsset(f.data,child.assets[0].id)).enhancement,undefined);assert.equal(f.state.prompts.length,1);
});
test('changed actual random seed is refused rather than choosing or resending another seed',async t=>{
 const f=await fixture(t,{seedMode:'random'}),{stopped,childId}=await f.stop();await f.completeChild(stopped,childId);const changed=structuredClone(stopped);changed.steps[0].actualInput.enhancement.seed=(changed.steps[0].actualInput.enhancement.seed+1)%4294967296;await atomicJson(f.file(stopped.id),changed);
 await f.runner.resume(stopped.id,{});const job=await f.wait(stopped.id);assert.equal(job.status,'failed');assert.match(job.message,/种子与实际收据不一致/);assert.equal(f.state.prompts.length,1);assert.equal(f.state.uploads.length,1);
});
test('result writeback checks persisted lineage and remains read-only on rejection',async t=>{
 const f=await fixture(t),job=await f.launch();assert.equal(job.status,'completed',job.message);const asset=await loadAsset(f.data,job.assets[0].id),changed={...asset,enhancement:{...asset.enhancement,strength:.7}};await atomicJson(path.join(f.data,'assets',asset.id+'.json'),changed);
 await assert.rejects(applyNativeCascadeResults({data:f.data,project:f.project,job,revision:f.project.revision}),/来源记录缺失或冲突/);assert.deepEqual(await loadAsset(f.data,asset.id),changed);assert.equal(f.state.prompts.length,1);
});
