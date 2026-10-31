import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {makeProject,makeNode,validateProject} from '../lib/model.mjs';
import {normalizeEnhancement,enhancementMetadata} from '../public/image-enhance-core.js';
import {compileEnhancement,validateEnhancementLinks} from '../lib/image-enhance.mjs';
import {generationService} from '../lib/generation.mjs';
import {creationStudioService} from '../lib/creation-studio.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';
import {copySelectedNodes} from '../lib/canvas-tools.mjs';
import {applyCanvasResults} from '../lib/generation-results.mjs';
import {storeAsset,readJson} from '../lib/workspace.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {enhanceMock,enhanceWorkflow,upscaleWorkflow,enhanceRecipe,upscaleRecipe,originalPng,enhancedPng,upscaledPng} from './helpers/image-enhance-fixture.mjs';
const key='synthetic-enhance-test-key',sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(f,id,check){for(let i=0;i<900;i++){const j=await readJson(path.join(f.data,'jobs',id+'.json'));if(check(j))return j;await sleep(15);}throw Error('enhance timeout');}
const done=(f,id)=>wait(f,id,j=>!['queued','running'].includes(j.status));
async function idle(f){for(let i=0;i<100&&f.activeJobs.size;i++)await sleep(15);assert.equal(f.activeJobs.size,0);}
async function fixture(t,cloud=false){
 const mock=await enhanceMock();t.after(mock.close);const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-enhance-')),activeJobs=new Map(),generation=generationService({data,activeJobs}),creationStudio=creationStudioService({data,activeJobs,pollInterval:10}),runner=canvasRunner({data,activeJobs,generation,creationStudio,pollInterval:10}),asset=await storeAsset(data,originalPng,{type:'image/png',name:'原图.png'}),project=makeProject('增强验收'),source=makeNode('image',0,0,{assetId:asset.id}),enhance=makeNode('image',350,0,{text:'丰富的细节'}),upscale=makeNode('image',700,0);
 const local=await generation.saveTemplate({name:'增强模拟工作流',workflow:enhanceWorkflow}),up=await generation.saveTemplate({name:'放大模拟工作流',workflow:upscaleWorkflow});
 if(cloud)enhance.params.studioBinding={mode:'image',config:{protocol:'modelscope',baseUrl:mock.endpoint+'/v1',model:'black-forest-labs/FLUX.2-klein-9B',imageAsync:true,loras:{'author/details':.8,'author/color':.2}},referenceSources:[{assetId:asset.id}],imageEnhance:{engine:'modelscope',kind:'enhance'}};
 else enhance.params.workflowBinding={workflowId:local.id,overrides:[],imageSources:[{nodeId:'15',name:'image',sourceNodeId:source.id}],promptField:{nodeId:'23',name:'text'},count:1,imageEnhance:enhanceRecipe()};
 upscale.params.workflowBinding={workflowId:up.id,overrides:[],imageSources:[{nodeId:'15',name:'image',sourceNodeId:enhance.id}],count:1,imageEnhance:upscaleRecipe()};project.nodes=[source,enhance,upscale];project.edges=[{id:'source-enhance',source:source.id,target:enhance.id},{id:'enhance-upscale',source:enhance.id,target:upscale.id}];project.assets=[asset];const projects={load:async()=>project,save:async p=>(Object.assign(project,p),project)};
 return{...mock,data,activeJobs,generation,creationStudio,runner,asset,project,source,enhance,upscale,local,up,projects};
}
function credentials(f,steps){return{requestId:crypto.randomUUID(),revision:f.project.revision,consent:true,studioCredentials:steps.filter(s=>s.kind==='studio'&&s.status!=='completed').map(s=>({nodeId:s.nodeId,apiKey:key,authorization:{origin:f.endpoint,model:s.studio.config.model,sendPrompt:true,sendReferences:true,requestLimit:1,budget:1,currency:'CNY'}}))};}
const start=async f=>f.runner.start(f.project,credentials(f,await f.runner.plan(f.project)),f.endpoint);
test('增强强度与种子范围、重复字段、非法尺寸在执行前拒绝',()=>{
 for(const change of [r=>r.strength=0,r=>r.strength=1.01,r=>r.strength='0.5',r=>r.seed=-1,r=>r.seed=4294967296,r=>r.seedFields=[],r=>r.seedFields[0].name='denoise',r=>r.seedFields.push(r.seedFields[0])]){const r=enhanceRecipe();change(r);assert.throws(()=>normalizeEnhancement(r));}
 for(const change of [r=>r.resolution=1024,r=>r.maxResolution=8192,r=>r.engine='modelscope']){const r=upscaleRecipe();change(r);assert.throws(()=>normalizeEnhancement(r));}
 assert.throws(()=>enhancementMetadata({id:'result',type:'video/mp4',enhancement:{engine:'modelscope',kind:'enhance',sourceAssetId:'original',originalAssetId:'original'}}));
});
test('增强→放大确实传递中间图片、强度和种子，连线不被覆盖，回填一次且原图不变',async t=>{
 const f=await fixture(t),j=await start(f),r=await done(f,j.id);assert.equal(r.status,'completed',r.message);assert.equal(f.state.submissions.length,2);assert.equal(f.state.uploads.length,2);assert.ok(f.state.uploads[0].bytes.includes(originalPng));assert.ok(f.state.uploads[1].bytes.includes(enhancedPng));assert.ok(!f.state.uploads[1].bytes.includes(originalPng));
 const [a,b]=f.state.submissions;assert.equal(a['204'].inputs.value,.65);assert.deepEqual(a['146'].inputs.denoise,['202',0]);assert.equal(a['146'].inputs.seed,1234);assert.equal(a['181'].inputs.seed,1234);assert.equal(b['172'].inputs.resolution,4096);assert.equal(b['172'].inputs.max_resolution,4096);assert.equal(b['172'].inputs.seed,5678);assert.match(b['15'].inputs.image,new RegExp(r.assets[0].id));
 assert.equal(r.assets[1].enhancement.sourceAssetId,r.assets[0].id);assert.equal(r.assets[1].enhancement.originalAssetId,f.asset.id);assert.deepEqual(await fs.readFile(path.join(f.data,'assets',r.assets[1].id)),upscaledPng);await applyCanvasResults({...f,job:r,revision:0});assert.equal(f.project.assets.length,3);assert.equal(f.project.assets.at(-1).enhancement.sourceAssetId,r.assets[0].id);await assert.rejects(applyCanvasResults({...f,job:r,revision:f.project.revision}),/尚未加入/);assert.deepEqual(await fs.readFile(path.join(f.data,'assets',f.asset.id)),originalPng);
});
test('随机种子只在新任务产生并持久化，同请求编号不重启流程',async t=>{
 const f=await fixture(t);f.enhance.params.workflowBinding.imageEnhance.seedMode='random';const body=credentials(f,await f.runner.plan(f.project)),j=await f.runner.start(f.project,body,f.endpoint),r=await done(f,j.id),again=await f.runner.start(f.project,body,f.endpoint);assert.equal(again.id,j.id);assert.equal(f.state.submissions.length,2);const seed=r.steps[0].imageEnhance.seed;assert.equal(f.state.submissions[0]['146'].inputs.seed,seed);assert.equal(r.assets[0].enhancement.seed,seed);assert.ok(Number.isSafeInteger(seed)&&seed>=0&&seed<=4294967295);
});
test('第二步停止并重建执行器后仅查询原编号；中间源文件缺失也不重新上传或生成',async t=>{
 const f=await fixture(t);f.state.pendingUpscale=true;const j=await start(f);await wait(f,j.id,()=>f.state.queries.includes('enhance-2'));f.activeJobs.get(j.id).controller.abort();await done(f,j.id);await idle(f);const partial=await readJson(path.join(f.data,'jobs',j.id+'.json'));assert.equal(partial.assets.length,1);await fs.rename(path.join(f.data,'assets',partial.assets[0].id),path.join(f.data,'assets',partial.assets[0].id+'.preserved'));f.state.pendingUpscale=false;const runner=canvasRunner({...f,generation:generationService(f),pollInterval:10});await runner.resume(j.id);const r=await done(f,j.id);assert.equal(r.status,'completed',r.message);assert.equal(f.state.submissions.length,2);assert.equal(f.state.uploads.length,2);assert.equal(new Set(f.state.queries).size,2);assert.equal(r.assets[1].enhancement.originalAssetId,f.asset.id);
});
test('第二步失败可取回增强结果，恢复不重新提交失败请求',async t=>{
 const f=await fixture(t);f.state.failUpscale=true;const j=await start(f),r=await done(f,j.id);assert.equal(r.status,'interrupted');assert.equal(r.assets.length,1);await applyCanvasResults({...f,job:r,revision:0,acceptPartial:true});assert.equal(f.project.assets.length,2);await idle(f);await f.runner.resume(j.id);const again=await done(f,j.id);assert.equal(again.status,'interrupted');assert.equal(f.state.submissions.length,2);
});
test('ModelScope LoRA 混合与原图字节正确传输，云端增强结果交给本地放大',async t=>{
 const f=await fixture(t,true),j=await start(f),r=await done(f,j.id);assert.equal(r.status,'completed',r.message);assert.equal(f.state.cloud.length,1);assert.deepEqual(f.state.cloud[0].loras,{'author/details':.8,'author/color':.2});assert.deepEqual(f.state.cloud[0].image_url,['data:image/png;base64,'+originalPng.toString('base64')]);assert.equal(f.state.submissions.length,1);assert.ok(f.state.uploads[0].bytes.includes(enhancedPng));assert.equal(r.assets[0].enhancement.engine,'modelscope');assert.equal(r.assets[1].enhancement.originalAssetId,f.asset.id);
 async function check(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await check(p);else if(e.name.endsWith('.json'))assert.ok(!(await fs.readFile(p,'utf8')).includes(key));}}await check(f.data);
});
test('预检拒绝隐藏字段、错误映射、重复覆盖、非SeedVR2工作流及失去连线的输入',async t=>{
 const f=await fixture(t);for(const change of [p=>p.nodes[1].params.workflowBinding.overrides=[{nodeId:'204',name:'value',value:.7}],p=>p.nodes[1].params.workflowBinding.count=2,p=>p.nodes[1].params.workflowBinding.imageSources=[],p=>p.nodes[1].params.workflowBinding.imageEnhance.strengthField={nodeId:'146',name:'denoise'},p=>p.edges=[]]){const p=structuredClone(f.project);change(p);await assert.rejects(f.runner.plan(p));}
 const graph=structuredClone(upscaleWorkflow);graph['172'].class_type='ImageResize';assert.throws(()=>compileEnhancement(f.upscale.params.workflowBinding,graph),/SeedVR2/);
 await f.generation.configure(f.local.id,{revision:0,fields:[{nodeId:'204',name:'value',control:'slider',min:.1,max:1,step:.01,defaultValue:.5,exposed:false}]});await assert.rejects(f.runner.plan(f.project),/隐藏/);assert.equal(f.state.submissions.length,0);assert.equal(f.state.uploads.length,0);
});
test('云端不合法权重、无本地来源和不确定提交在上游调用前或恢复时停止',async t=>{
 const f=await fixture(t,true),b=f.enhance.params.studioBinding;for(const change of [b=>b.config.loras={'a/b':.8},b=>b.referenceSources=[{url:'https://example.com/image.png'}],b=>b.config.protocol='openai-compatible']){const p=structuredClone(f.project);change(p.nodes[1].params.studioBinding);await assert.rejects(f.runner.plan(p));}assert.equal(f.state.cloud.length,0);f.state.cloudUncertain=true;const j=await start(f),r=await done(f,j.id);assert.equal(r.status,'interrupted');await idle(f);await f.runner.resume(j.id,credentials(f,r.steps));const next=await done(f,j.id);assert.equal(next.status,'interrupted');assert.equal(f.state.cloud.length,1);assert.equal(f.state.submissions.length,0);
});
test('复制双节点重映射内部来源，固定原图不变，缺失动态来源仍允许保存再修复',async t=>{
 const f=await fixture(t),copy=copySelectedNodes(f.project,[f.enhance.id,f.upscale.id]);assert.equal(copy.nodes[4].params.workflowBinding.imageSources[0].sourceNodeId,copy.nodes[3].id);assert.equal(copy.nodes[3].params.workflowBinding.imageSources[0].sourceNodeId,f.source.id);validateProject(copy);f.project.nodes=f.project.nodes.filter(n=>n.id!==f.source.id);f.project.edges=f.project.edges.filter(e=>e.source!==f.source.id);validateProject(f.project);await assert.rejects(f.runner.plan(f.project),/动态素材/);
});
test('备份第4版包含未放入项目的原图依赖，重导入后来源与工作流均可用',async t=>{
 const f=await fixture(t),j=await start(f),r=await done(f,j.id);await applyCanvasResults({...f,job:r,revision:0});f.project.nodes=f.project.nodes.filter(n=>n.assetId===r.assets[1].id);f.project.edges=[];f.project.assets=f.project.assets.filter(a=>a.id===r.assets[1].id);const bundle=projectBundleService(f),out=await bundle.exportBundle(f.project.id,f.project.revision);assert.equal(out.assets,3);assert.equal(out.formatVersion,4);assert.equal(out.enhancements,2);
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-enhance-import-')),activeJobs=new Map();let imported;const projects={load:async()=>{if(imported)return imported;throw Object.assign(Error('missing'),{status:404});},save:async p=>(imported=p)},target=projectBundleService({data,activeJobs,projects}),preview=await target.upload(createReadStream(await bundle.download(out.id))),p=await target.importBundle(preview.id),last=p.assets.find(a=>a.enhancement?.kind==='upscale'),input=p.assets.find(a=>a.id===last.enhancement.sourceAssetId),original=p.assets.find(a=>a.id===last.enhancement.originalAssetId);assert.ok(input&&original);assert.notEqual(original.id,f.asset.id);assert.equal(input.enhancement.originalAssetId,original.id);assert.deepEqual(await fs.readFile(path.join(data,'assets',original.id)),originalPng);assert.equal((await target.importBundle(preview.id)).id,p.id);
});
test('完整流程备份重导入后保留受控参数并可再运行',async t=>{
 const f=await fixture(t,true),bundle=projectBundleService(f),out=await bundle.exportBundle(f.project.id,0),data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-enhance-config-')),activeJobs=new Map();let p;const projects={load:async()=>{if(p)return p;throw Object.assign(Error('missing'),{status:404});},save:async x=>(p=x)},target=projectBundleService({data,activeJobs,projects}),preview=await target.upload(createReadStream(await bundle.download(out.id)));await target.importBundle(preview.id);assert.notEqual(p.nodes[1].params.studioBinding.referenceSources[0].assetId,f.asset.id);assert.equal(p.nodes[1].params.studioBinding.imageEnhance.engine,'modelscope');assert.notEqual(p.nodes[2].params.workflowBinding.workflowId,f.up.id);const runner=canvasRunner({data,activeJobs,generation:generationService({data,activeJobs}),creationStudio:creationStudioService({data,activeJobs,pollInterval:10}),pollInterval:10}),ff={...f,data,activeJobs,project:p,runner},j=await start(ff),r=await done(ff,j.id);assert.equal(r.status,'completed',r.message);
});
test('增强来源循环、错误原图、缺失原图与旧格式不得导入',()=>{
 const source={id:'a',type:'image/png'},result={id:'b',type:'image/png',enhancement:{kind:'enhance',engine:'modelscope',sourceAssetId:'a',originalAssetId:'a'}};assert.throws(()=>validateEnhancementLinks([source,result],3),/第4版/);assert.throws(()=>validateEnhancementLinks([result],4),/缺少/);assert.throws(()=>validateEnhancementLinks([source,{...result,enhancement:{...result.enhancement,originalAssetId:'b'}}],4),/不一致/);assert.throws(()=>validateEnhancementLinks([{...source,editId:'edit',sourceAssetId:'b'},result],4),/循环/);
});
