import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {cascadeSpecializedFixture} from './helpers/native-cascade-specialized-fixture.mjs';
import {upscaleWorkflow,upscaleRecipe,originalPng} from './helpers/image-enhance-fixture.mjs';
import {nativeCascadeRunner} from '../lib/native-cascade-runner.mjs';
import {generationService} from '../lib/generation.mjs';
import {applyNativeCascadeResults} from '../lib/native-cascade-results.mjs';
import {nativeCascadePlanMarkup,nativeCascadeRequestMarkup} from '../public/native-cascade-ui.js';
import {atomicJson,readJson,loadAsset,storeAsset,records} from '../lib/workspace.mjs';

const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const fixture=(t,options={})=>cascadeSpecializedFixture(t,{workflow:upscaleWorkflow,recipe:upscaleRecipe(),...options});
for(const resolution of [2048,4096])test(`single-image ${resolution===2048?'2K':'4K'} uses SeedVR2 resolution fields, one child, provenance and shared receivers`,async t=>{
 const f=await fixture(t,{recipe:{...upscaleRecipe(),resolution}}),before=structuredClone(f.project),preview=await f.runner.plan(f.project,{nodeId:'C'});
 assert.equal(preview.summary.requests,1);assert.equal(preview.summary.generations,1);assert.equal(preview.summary.sharedCopies,1);assert.equal(preview.steps[0].imageEnhance.kind,'upscale');assert.equal(preview.steps[0].imageEnhance.strength,undefined);assert.equal(f.state.prompts.length,0);
 const job=await f.launch();assert.equal(job.status,'completed',job.message);assert.equal(job.assets.length,1);assert.equal(f.state.prompts.length,1);assert.equal(f.state.uploads.length,1);
 const graph=f.state.prompts[0].body.prompt;assert.equal(graph['172'].inputs.resolution,resolution);assert.equal(graph['172'].inputs.max_resolution,4096);assert.equal(graph['172'].inputs.seed,5678);
 const input=job.steps[0].actualInput;assert.equal(input.prompt,'');assert.equal(input.enhancement.kind,'upscale');assert.equal(input.enhancement.strength,undefined);assert.equal(input.enhancement.resolution,resolution);
 const child=await readJson(f.file(job.steps[0].jobId)),asset=await loadAsset(f.data,job.assets[0].id);assert.deepEqual(child.cascadeEnhancement,input.enhancement);assert.equal(asset.enhancement.kind,'upscale');assert.equal(asset.enhancement.resolution,resolution);assert.equal(asset.enhancement.maxResolution,4096);assert.equal(asset.enhancement.sourceAssetId,input.referenceRefs[0].assetId);assert.equal(asset.enhancement.originalAssetId,input.referenceRefs[0].assetId);assert.equal(asset.enhancement.strength,undefined);
 const applied=await applyNativeCascadeResults({data:f.data,project:f.project,job,revision:f.project.revision});assert.equal(applied.appliedAssetIds.length,1);assert.equal(applied.project.nodes.find(node=>node.id==='B').assetId,applied.project.nodes.find(node=>node.id==='C').assetId);assert.deepEqual(f.project,before);
 const html=nativeCascadePlanMarkup(preview,esc)+nativeCascadeRequestMarkup(job.steps[0],esc);assert.match(html,new RegExp('单图放大 · '+(resolution===2048?'2K':'4K')));assert.ok(!html.includes('强度 undefined'));
});
test('first image selection leaves a second image unused and keeps ancestry from an earlier enhancement',async t=>{
 const f=await fixture(t),native=f.source.params.nativeCanvas,first=f.project.assets.find(asset=>asset.id===native.mediaAssetIds[0]),original=await storeAsset(f.data,originalPng,{name:'original.png',type:'image/png'}),second=await storeAsset(f.data,originalPng,{name:'unused.png',type:'image/png'});
 const enhancement={kind:'enhance',engine:'comfy',sourceAssetId:original.id,originalAssetId:original.id,strength:.65,seed:20};await atomicJson(path.join(f.data,'assets',first.id+'.json'),{...first,enhancement});Object.assign(first,{enhancement});f.project.assets.push(original,second);
 native.node.images.push({url:'/synthetic/unused',kind:'image',name:second.name});native.resources.push({url:'/synthetic/unused',assetId:second.id,archive:'synthetic/unused.png'});native.mediaAssetIds.push(second.id);
 const job=await f.launch();assert.equal(job.status,'completed',job.message);assert.equal(job.steps[0].actualInput.enhancement.sourceAssetId,first.id);assert.equal(job.steps[0].actualInput.unusedRefs[0].assetId,second.id);assert.equal(job.assets[0].enhancement.originalAssetId,original.id);assert.equal(f.state.uploads.length,1);assert.equal(f.state.prompts.length,1);
});
test('random previews are stable, actual seed is recorded once and replacement runner queries the same child',async t=>{
 const f=await fixture(t,{seedMode:'random'}),a=await f.runner.plan(f.project,{nodeId:'C'}),b=await f.runner.plan(f.project,{nodeId:'C'});assert.equal(a.previewHash,b.previewHash);assert.equal(a.steps[0].imageEnhance.seed,undefined);
 const {stopped,childId}=await f.stop(),actual=structuredClone(stopped.steps[0].actualInput),child=await readJson(f.file(childId)),promptId=child.items[0].promptId;
 assert.ok(Number.isInteger(actual.enhancement.seed));assert.equal(child.workflow['172'].inputs.seed,actual.enhancement.seed);
 f.state.hold=false;const replacement=nativeCascadeRunner({...f,generation:generationService({data:f.data,activeJobs:f.activeJobs}),pollInterval:5});await replacement.resume(stopped.id,{});
 const job=await f.wait(stopped.id);assert.equal(job.status,'completed',job.message);assert.equal(job.steps[0].jobId,childId);assert.deepEqual(job.steps[0].actualInput,actual);assert.equal(f.state.prompts.length,1);assert.equal(f.state.uploads.length,1);assert.equal(job.assets[0].enhancement.seed,actual.enhancement.seed);assert.equal((await readJson(f.file(childId))).items[0].promptId,promptId);
});
test('workflow seed remains unchanged and has no invented actual seed',async t=>{
 const f=await fixture(t,{seedMode:'workflow'}),job=await f.launch();assert.equal(job.status,'completed',job.message);assert.equal(f.state.prompts[0].body.prompt['172'].inputs.seed,30);assert.equal(job.steps[0].actualInput.enhancement.seed,undefined);assert.equal(job.assets[0].enhancement.seed,undefined);
});
for(const [name,change]of [
 ['ModelScope',b=>{b.imageEnhance.engine='modelscope';}],['invalid resolution',b=>{b.imageEnhance.resolution=3072;}],['invalid maximum',b=>{b.imageEnhance.maxResolution=8192;}],
 ['H3',b=>{b.minimaxH3={};}],['LTX',b=>{b.ltxDirector={};}],['mixed list',b=>{b.promptBatch={nodeId:'15',name:'image',values:['x']};}],
 ['multiple images per request',b=>{b.count=2;}],['increment seed',b=>{b.incrementSeeds=true;}],
 ['wrong resolution node',b=>{b.imageEnhance.resolutionField={nodeId:'15',name:'image'};}],['conflicting resolution override',b=>{b.overrides=[{nodeId:'172',name:'resolution',value:2048}];}]
])test(`upscale preflight refuses ${name} with no upload or child`,async t=>{
 const f=await fixture(t);change(f.source.params.workflowBinding);await assert.rejects(f.runner.plan(f.project,{nodeId:'C'}));assert.equal(f.state.prompts.length,0);assert.equal(f.state.uploads.length,0);assert.equal((await records(path.join(f.data,'jobs'))).length,0);
});
test('SeedVR2 class and exposed resolution fields are required',async t=>{
 const f=await fixture(t),bad=await f.generation.saveTemplate({name:'wrong upscale class',workflow:{...upscaleWorkflow,'172':{...upscaleWorkflow['172'],class_type:'OrdinaryResizer'}}});f.source.params.workflowBinding.workflowId=bad.id;
 await assert.rejects(f.runner.plan(f.project,{nodeId:'C'}),/SeedVR2/);f.source.params.workflowBinding.workflowId=f.template.id;
 await f.generation.configure(f.template.id,{revision:f.template.revision,fields:[{nodeId:'172',name:'resolution',control:'number',exposed:false}]});await assert.rejects(f.runner.plan(f.project,{nodeId:'C'}),/隐藏/);assert.equal(f.state.prompts.length,0);
});
test('no actual image is rejected rather than degrading to an ordinary prompt request',async t=>{
 const f=await fixture(t),native=f.source.params.nativeCanvas,audio=await storeAsset(f.data,Buffer.from('synthetic unsent audio'),{name:'only-audio.wav',type:'audio/wav'});f.project.assets.push(audio);
 native.node.images=[{url:'/synthetic/audio',kind:'audio',name:audio.name}];native.mediaAssetIds=[audio.id];native.resources=[{url:'/synthetic/audio',assetId:audio.id,archive:'synthetic/audio.wav'}];
 const job=await f.launch();assert.equal(job.status,'failed');assert.match(job.message,/至少一张图片/);assert.equal(job.steps[0].actualInput,undefined);assert.equal(f.state.prompts.length,0);assert.equal(f.state.uploads.length,0);
});
for(const [name,change]of [
 ['actual resolution',job=>{job.steps[0].actualInput.enhancement.resolution=2048;}],
 ['actual seed',job=>{job.steps[0].actualInput.enhancement.seed++;}]
])test(`resume refuses changed ${name} and preserves original local child`,async t=>{
 const f=await fixture(t),{stopped,childId}=await f.stop(),original=await readJson(f.file(childId));change(stopped);await atomicJson(f.file(stopped.id),stopped);
 f.state.hold=false;await f.runner.resume(stopped.id,{});const job=await f.wait(stopped.id);assert.equal(job.status,'failed');assert.equal(f.state.prompts.length,1);assert.equal(f.state.uploads.length,1);assert.deepEqual((await readJson(f.file(childId))).workflow,original.workflow);
});
test('edit protection retains receiver changes while making upscale result independently recoverable',async t=>{
 const f=await fixture(t),job=await f.launch(),edited=structuredClone(f.project);edited.revision++;edited.nodes.find(node=>node.id==='B').title='保留编辑';
 const result=await applyNativeCascadeResults({data:f.data,project:edited,job,revision:edited.revision});assert.equal(result.project.nodes.find(node=>node.id==='B').title,'保留编辑');assert.equal(result.appliedAssetIds.length,1);assert.equal(f.state.prompts.length,1);
});
