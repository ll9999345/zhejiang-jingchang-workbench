import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {makeProject,makeNode,validateProject} from '../lib/model.mjs';
import {normalizeLoop} from '../lib/loop-core.mjs';
import {normalizeMinimaxTimeline,newMinimaxSegment,applyMinimaxLoopValues,minimaxSegmentSignature} from '../public/minimax-h3-core.js';
import {captureMinimaxResultTarget,attachMinimaxResults,minimaxExportProject} from '../lib/minimax-h3.mjs';
import {generationService} from '../lib/generation.mjs';
import {cloudWorkflowService} from '../lib/cloud-workflows.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';
import {applyCanvasResults} from '../lib/generation-results.mjs';
import {copySelectedNodes} from '../lib/canvas-tools.mjs';
import {selectCanvasFragment,fragmentMaps,mergeCanvasFragment} from '../lib/canvas-fragments.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {renderService} from '../lib/render-service.mjs';
import {readJson,storeAsset} from '../lib/workspace.mjs';
import {h3Workflow,h3Mock,png} from './helpers/minimax-h3-fixture.mjs';
import {h3RunningHubGraph,h3RunningHubMock} from './helpers/minimax-runninghub-fixture.mjs';
const auth='owned-h3-loop-authorization',sleep=ms=>new Promise(r=>setTimeout(r,ms));
const timeline=(engine='comfyui')=>normalizeMinimaxTimeline({version:1,engine,autoUpstream:false,segments:[newMinimaxSegment('first',0,{duration:1,trimOut:1,prompt:'原片段',seed:10}),newMinimaxSegment('second',1.25,{duration:1,trimOut:1,prompt:'保留第二段',seed:11})],selectedSegmentId:'first'});
const field=(n,name,values)=>({targetNodeId:n.id,kind:'minimax',name,values});
async function fixture(t,{single=false,cloudOnly=false}={}){
 const local=await h3Mock(),rh=await h3RunningHubMock();t.after(local.close);t.after(rh.close);
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-h3-loops-')),activeJobs=new Map(),project=makeProject('H3逐轮本机验收');project.nodes=[];
 const image=await storeAsset(data,png,{name:'owned-reference.png',type:'image/png'});project.assets=[image];
 const projects={load:async id=>{assert.equal(id,project.id);return project;},save:async p=>p,apply:async()=>project},generation=generationService({data,activeJobs}),cloudWorkflows=cloudWorkflowService({data,projects,activeJobs,pollInterval:5});
 const template=await generation.saveTemplate({name:'owned H3 loop',workflow:h3Workflow});
 async function cloudBinding(){const created=await cloudWorkflows.create({projectId:project.id});const r=await cloudWorkflows.save(created.id,{...created,name:'owned RH H3 loop',baseUrl:rh.endpoint,kind:'workflow',targetId:'2084608321469898754',fields:[],workflowJson:h3RunningHubGraph(),minimaxProfile:'h3'});return {recipeId:r.id,recipeRevision:r.revision,inputs:[],minimaxH3:timeline('runninghub')};}
 const a=makeNode('video',300,0,{title:cloudOnly?'云H3':'本机H3',params:cloudOnly?{cloudBinding:await cloudBinding()}:{workflowBinding:{workflowId:template.id,overrides:[],imageSources:[],count:1,incrementSeeds:false,minimaxH3:timeline()}}});
 const loop=makeNode('loop',0,0,{title:'H3逐轮',text:'共用背景'}),aTimeline=a.params.workflowBinding?.minimaxH3||a.params.cloudBinding.minimaxH3;aTimeline.refs=[{kind:'image',assetId:image.id}];loop.params.loop={mode:'repeat',count:2,fieldValues:[field(a,'prompt',['第一轮镜头','第二轮镜头']),field(a,'duration',[1,1.5]),field(a,'aspectRatio',['9:16','16:9']),field(a,'megapixels',[.4,.8]),field(a,'seed',[71,72])]};
 project.nodes=[loop,a];project.edges=[{id:'loop-a',source:loop.id,target:a.id}];let b;
 if(!single){b=makeNode('video',650,0,{title:'云H3后续',params:{cloudBinding:await cloudBinding()}});b.params.cloudBinding.minimaxH3.segments[0].refs=[{kind:'video',sourceNodeId:a.id}];project.nodes.push(b);project.edges.push({id:'a-b',source:a.id,target:b.id});loop.params.loop.fieldValues.push(field(b,'prompt',['后续第一轮','后续第二轮']),field(b,'duration',[1,.5]),field(b,'seed',[81,82]));}
 const runner=canvasRunner({data,activeJobs,generation,cloudWorkflows,pollInterval:5});return {data,activeJobs,project,projects,generation,cloudWorkflows,runner,template,a,b,loop,local,rh,image,endpoint:local.endpoint};
}
const h3=n=>n.params.workflowBinding?.minimaxH3||n.params.cloudBinding?.minimaxH3;
const signature=n=>minimaxSegmentSignature(h3(n).segments[0]);
async function body(f,requestId='owned-loop-'+Math.random().toString(36).slice(2)){
 const steps=await f.runner.plan(f.project);
 return {revision:f.project.revision,consent:true,requestId,cloudCredentials:steps.filter(s=>s.kind==='runninghub').map(s=>({nodeId:s.executionId||s.nodeId,apiKey:auth,authorization:{origin:f.rh.endpoint,kind:'workflow',targetId:s.recipe.targetId,requestLimit:1,sendFields:true,sendAssets:s.sendAssets,sendWorkflow:true,budget:1,currency:'CNY'}}))};
}
async function wait(f,id,check){for(let i=0;i<1000;i++){const j=await readJson(path.join(f.data,'jobs',id+'.json'));if(check(j))return j;await sleep(10);}throw Error('owned H3 loop timed out');}
const done=(f,id)=>wait(f,id,j=>!['queued','running'].includes(j.status)&&!f.activeJobs.has(id));
async function noAuth(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await noAuth(p);else assert.equal((await fs.readFile(p)).includes(Buffer.from(auth)),false,'owned authorization must not persist');}}
async function complete(f){const j=await f.runner.start(f.project,await body(f),f.endpoint),result=await done(f,j.id);assert.equal(result.status,'completed',result.message);return result;}
async function pausedAt(f,count){Object.defineProperty(f.rh.state,'pending',{configurable:true,get:()=>f.rh.state.submissions.length>=count});const j=await f.runner.start(f.project,await body(f),f.endpoint);await wait(f,j.id,()=>f.rh.state.queries.includes(String(123456788+count)));f.activeJobs.get(j.id).controller.abort();const paused=await done(f,j.id);assert.equal(paused.status,'cancelled');return paused;}
async function resume(f,job){Object.defineProperty(f.rh.state,'pending',{configurable:true,writable:true,value:false});const cloudWorkflows=cloudWorkflowService({...f,pollInterval:5}),runner=canvasRunner({...f,generation:generationService(f),cloudWorkflows,pollInterval:5});await runner.resume(job.id,{cloudCredentials:job.steps.filter(s=>s.kind==='runninghub'&&s.status!=='completed').map(s=>({nodeId:s.executionId,apiKey:auth}))});return done(f,job.id);}

test('H3逐轮映射不借用Comfy节点编号，拒绝未知类型、重复字段、失效编号和错误轮数',()=>{
 const c={mode:'repeat',count:2,fieldValues:[{targetNodeId:'video',kind:'minimax',name:'seed',values:[1,2]}]};assert.deepEqual(normalizeLoop(c),c);
 for(const edit of [c=>c.fieldValues[0].kind='unknown',c=>c.fieldValues[0].nodeId='129',c=>c.fieldValues[0].name='reference',c=>c.fieldValues[0].targetNodeId='../../bad',c=>c.fieldValues.push({...c.fieldValues[0]}),c=>c.fieldValues[0].values=[1],c=>c.fieldValues[0].values=[1,NaN]]){const x=structuredClone(c);edit(x);assert.throws(()=>normalizeLoop(x));}
});
test('逐轮时长只调整运行快照，保留后段间隔、已有结果和原时间轴',()=>{
 const original=timeline(),before=JSON.stringify(original),next=applyMinimaxLoopValues(original,{prompt:'逐轮镜头',duration:1.5,aspectRatio:'9:16',megapixels:.8,seed:78});assert.equal(next.segments[1].start,1.75);assert.equal(next.segments[0].seed,78);assert.equal(JSON.stringify(original),before);
 const short=applyMinimaxLoopValues(original,{duration:.5});assert.equal(short.segments[0].trimOut,.5);assert.equal(short.segments[1].start,.75);
 for(const values of [{duration:'2'},{duration:61},{aspectRatio:'2:3'},{megapixels:0},{seed:-1},{seed:Number.MAX_SAFE_INTEGER+1},{prompt:false},{unknown:1}])assert.throws(()=>applyMinimaxLoopValues(original,values));
});
test('本机H3到云H3逐轮传参数及当前视频，原片段不改；两个节点都回填逐轮结果',async t=>{
 const f=await fixture(t),aInput=signature(f.a),bInput=signature(f.b),loopConfig=JSON.stringify(f.loop.params.loop),r=await complete(f);
 assert.deepEqual(f.local.state.submissions.map(g=>g['129'].inputs.noise_seed),[71,72]);assert.deepEqual(f.local.state.submissions.map(g=>g['132'].inputs.value),[1,1.5]);assert.deepEqual(f.local.state.submissions.map(g=>g['115'].inputs.aspect_ratio),['9:16 (Portrait)','16:9 (Widescreen)']);assert.deepEqual(f.local.state.submissions.map(g=>g['115'].inputs.megapixels),[.4,.8]);assert.deepEqual(f.local.state.submissions.map(g=>g['138'].inputs.value),['第一轮镜头','第二轮镜头']);
 const cloudGraphs=f.rh.state.submissions.map(s=>JSON.parse(s.workflow));assert.deepEqual(cloudGraphs.map(g=>g['129'].inputs.noise_seed),[81,82]);assert.deepEqual(cloudGraphs.map(g=>g['132'].inputs.value),[1,.5]);assert.deepEqual(r.assets.map(a=>a.minimaxParameters.seed),[71,81,72,82]);assert.equal(r.assets[1].referenceAssetIds[0],r.assets[0].id);assert.equal(r.assets[3].referenceAssetIds[0],r.assets[2].id);
 await applyCanvasResults({...f,job:r,revision:0});assert.equal(signature(f.a),aInput);assert.equal(signature(f.b),bInput);assert.equal(JSON.stringify(f.loop.params.loop),loopConfig);assert.equal(h3(f.a).segments[0].resultVariants.length,2);assert.equal(h3(f.b).segments[0].resultVariants.length,2);assert.equal(h3(f.a).segments[0].resultAssetId,r.assets[2].id);assert.equal(h3(f.b).segments[0].resultAssetId,r.assets[3].id);assert.equal(h3(f.b).segments[0].trimOut,.5);assert.equal(h3(f.a).segments[1].resultAssetId,null);assert.equal(f.project.runs[0].minimaxAttachments.length,2);await noAuth(f.data);validateProject(f.project);
});
test('仅RunningHub的H3也按五个参数逐轮编译，整图与字段均保持类型和实际槽位',async t=>{
 const f=await fixture(t,{single:true,cloudOnly:true}),r=await complete(f),graphs=f.rh.state.submissions.map(s=>JSON.parse(s.workflow));assert.equal(f.local.state.submissions.length,0);assert.deepEqual(graphs.map(g=>g['129'].inputs.noise_seed),[71,72]);assert.deepEqual(graphs.map(g=>g['132'].inputs.value),[1,1.5]);assert.deepEqual(graphs.map(g=>g['138'].inputs.value),['第一轮镜头','第二轮镜头']);assert.deepEqual(graphs.map(g=>g['115'].inputs.megapixels),[.4,.8]);assert.ok(graphs.every(g=>g['image-0'].inputs.image.startsWith('api/owned-')));assert.ok(graphs.every(g=>!g['audio-0']));assert.deepEqual(r.assets.map(a=>a.roundIndex),[0,1]);await applyCanvasResults({...f,job:r,revision:0});assert.equal(h3(f.a).segments[0].resultVariants[1].parameters.seed,72);await noAuth(f.data);
});
test('混合链第二轮停下并分次取回后，重建服务按原编号恢复，不重复提交或错误回填',async t=>{
 const f=await fixture(t),paused=await pausedAt(f,2);assert.equal(paused.assets.length,3);await applyCanvasResults({...f,job:paused,revision:0,acceptPartial:true});assert.equal(h3(f.a).segments[0].resultVariants.length,2);assert.equal(h3(f.b).segments[0].resultVariants.length,1);
 const r=await resume(f,paused);assert.equal(r.status,'completed',r.message);assert.equal(f.local.state.submissions.length,2);assert.equal(f.rh.state.submissions.length,2);await applyCanvasResults({...f,job:r,revision:1});assert.equal(h3(f.a).segments[0].resultVariants.length,2);assert.equal(h3(f.b).segments[0].resultVariants.length,2);assert.equal(f.project.assets.length,5);assert.equal(f.project.runs.length,2);assert.equal(new Set(h3(f.b).segments[0].resultAssetIds).size,2);await assert.rejects(applyCanvasResults({...f,job:r,revision:2}),/没有尚未/);await noAuth(f.data);
});
test('分次取回间编辑循环输入后，不覆盖分镜选择；后续生成文件仍加入独立节点',async t=>{
 const f=await fixture(t),paused=await pausedAt(f,2);await applyCanvasResults({...f,job:paused,revision:0,acceptPartial:true});const before=JSON.stringify(h3(f.b));f.loop.params.loop.fieldValues[0].values[1]='新编辑的循环';const r=await resume(f,paused);assert.equal(r.status,'completed');await applyCanvasResults({...f,job:r,revision:1});assert.equal(JSON.stringify(h3(f.b)),before);assert.ok(f.project.nodes.some(n=>n.assetId===r.assets[3].id));
});
test('用户改选已取回的另一轮结果，后续取回保持该选择和已有历史',async t=>{
 const f=await fixture(t,{single:true,cloudOnly:true});f.loop.params.loop={mode:'repeat',count:3};const paused=await pausedAt(f,3);await applyCanvasResults({...f,job:paused,revision:0,acceptPartial:true});const s=h3(f.a).segments[0];s.resultAssetId=s.resultAssetIds[0];f.a.assetId=s.resultAssetId;const before=JSON.stringify(h3(f.a));const r=await resume(f,paused);assert.equal(r.status,'completed');await applyCanvasResults({...f,job:r,revision:1});assert.equal(JSON.stringify(h3(f.a)),before);assert.ok(f.project.nodes.some(n=>n.assetId===r.assets[2].id));assert.equal(f.rh.state.submissions.length,3);
});
test('H3结果列表或素材抽屉满时仅跳过关联，保留原历史及独立结果',async t=>{
 for(const capacity of ['results','drawer']){const f=await fixture(t,{single:true}),r=await complete(f),s=h3(f.a).segments[0];const old=await storeAsset(f.data,await fs.readFile(path.join(f.data,'assets',r.assets[0].id)),{name:'owned-old.mp4',type:'video/mp4'});f.project.assets.push(old);
  if(capacity==='results'){s.resultAssetIds=Array.from({length:100},(_,i)=>'old-video-'+i);for(const id of s.resultAssetIds)f.project.assets.push({...old,id});s.resultAssetId=s.resultAssetIds[0];}else h3(f.a).materials=Array.from({length:1000},()=>({assetId:old.id,segmentId:s.id}));
  const target=captureMinimaxResultTarget(f.a,h3(f.a),{project:f.project,parents:new Set([f.loop.id])});for(const step of r.steps)step.minimaxResultTarget=target;const before=JSON.stringify(h3(f.a));await applyCanvasResults({...f,job:r,revision:0});assert.equal(JSON.stringify(h3(f.a)),before);assert.ok(f.project.nodes.some(n=>n.assetId===r.assets[1].id));validateProject(f.project);
 }
});
test('所有轮次在第一次提交前预检，包括种子溢出、非法H3映射和云提示词上限',async t=>{
 const f=await fixture(t);const invalid=[p=>p.nodes[0].params.loop.fieldValues[0].values[1]=false,p=>p.nodes[0].params.loop.fieldValues.find(f=>f.name==='duration').values[1]=61,p=>p.nodes[0].params.loop.fieldValues.find(v=>v.targetNodeId===f.b.id&&v.name==='prompt').values[1]='长'.repeat(20001),p=>p.nodes[0].params.loop.fieldValues[0].targetNodeId='missing'];
 for(const edit of invalid){const p=structuredClone(f.project);edit(p);await assert.rejects(f.runner.plan(p));}
 f.loop.params.loop.fieldValues=[];f.a.params.workflowBinding.incrementSeeds=true;h3(f.a).segments[0].seed=Number.MAX_SAFE_INTEGER;await assert.rejects(f.runner.plan(f.project),/种子/);assert.equal(f.local.state.submissions.length,0);assert.equal(f.rh.state.submissions.length,0);
});
test('显式逐轮种子与递增种子互斥，未绑定时间轴和通用媒体字段不能绕过参数验证',async t=>{
 const f=await fixture(t,{single:true});f.a.params.workflowBinding.incrementSeeds=true;await assert.rejects(f.runner.plan(f.project),/关闭.*递增/);f.a.params.workflowBinding.incrementSeeds=false;delete f.a.params.workflowBinding.minimaxH3;await assert.rejects(f.runner.plan(f.project),/已绑定.*H3/);
 f.loop.params.loop.fieldValues=[{targetNodeId:f.a.id,nodeId:'137',name:'image',values:['a','b']}];await assert.rejects(f.runner.plan(f.project),/媒体输入/);assert.equal(f.local.state.submissions.length,0);
});
test('H3留空片段提示词时列表逐轮进入真实提交；记录实际提示词而非原背景',async t=>{
 const f=await fixture(t,{single:true});h3(f.a).autoUpstream=true;h3(f.a).segments[0].prompt='';f.loop.params.loop={mode:'list',values:['清晨的湖面','夜晚的灯会']};const r=await complete(f);assert.match(f.local.state.submissions[0]['138'].inputs.value,/清晨的湖面/);assert.doesNotMatch(f.local.state.submissions[1]['138'].inputs.value,/清晨的湖面/);assert.match(f.local.state.submissions[1]['138'].inputs.value,/夜晚的灯会/);assert.equal(r.assets[1].minimaxParameters.prompt,f.local.state.submissions[1]['138'].inputs.value);await applyCanvasResults({...f,job:r,revision:0});assert.equal(h3(f.a).segments[0].prompt,'');assert.equal(h3(f.a).segments[0].resultVariants.length,2);
});
test('列表被H3片段提示词遮住时明确阻止，而不是执行重复的旧提示词',async t=>{
 const f=await fixture(t,{single:true});f.loop.params.loop={mode:'list',values:['第一轮','第二轮']};await assert.rejects(f.runner.plan(f.project),/留空/);h3(f.a).autoUpstream=true;h3(f.a).segments[0].prompt='';f.loop.params.loop.fieldValues=[field(f.a,'prompt',['','覆盖列表'])];await assert.rejects(f.runner.plan(f.project),/部分循环轮次/);assert.equal(f.local.state.submissions.length,0);
});
test('云H3仍须逐轮确认整图、素材和预算；少一项不提交',async t=>{
 const f=await fixture(t,{single:true,cloudOnly:true}),b=await body(f);delete b.cloudCredentials[1].authorization.sendWorkflow;await assert.rejects(f.runner.start(f.project,b,f.endpoint),/整图/);assert.equal(f.rh.state.submissions.length,0);assert.equal(f.rh.state.uploads.length,0);
});
test('复制及子图插入重映射H3逐轮目标和已有结果来源循环，未选目标不能丢失',async t=>{
 const f=await fixture(t,{single:true}),r=await complete(f);await applyCanvasResults({...f,job:r,revision:0});const copied=copySelectedNodes(f.project,[f.loop.id,f.a.id]),loop=copied.nodes.at(-2),a=copied.nodes.at(-1);assert.notEqual(loop.id,f.loop.id);assert.equal(loop.params.loop.fieldValues[0].targetNodeId,a.id);assert.equal(h3(a).segments[0].resultVariants[0].loopId,loop.id);assert.throws(()=>selectCanvasFragment(f.project,[f.loop.id]),/依赖节点/);
 const fragment=selectCanvasFragment(f.project,[f.loop.id,f.a.id]),p=mergeCanvasFragment(makeProject('target'),fragment,fragmentMaps(fragment),{x:100,y:100}).project;assert.equal(p.nodes[1].params.loop.fieldValues[0].targetNodeId,p.nodes[2].id);assert.equal(h3(p.nodes[2]).segments[0].resultVariants[0].loopId,p.nodes[1].id);validateProject(p);
});
test('v26备份恢复逐轮配置、两引擎绑定、所有结果原件与参数，拒绝降级为v25',async t=>{
 const f=await fixture(t),r=await complete(f);await applyCanvasResults({...f,job:r,revision:0});const source=JSON.stringify(f.project),bundles=projectBundleService(f),out=await bundles.exportBundle(f.project.id,f.project.revision),file=await bundles.download(out.id),data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-h3-loop-import-'));let restored;
 const imports=projectBundleService({data,activeJobs:new Map(),projects:{load:async()=>{if(restored)return restored;throw Object.assign(Error(),{status:404});},save:async p=>(restored=p)}}),preview=await imports.upload(createReadStream(file));assert.equal(preview.formatVersion,26);const p=await imports.importBundle(preview.id);assert.deepEqual(p.nodes[0].params.loop.fieldValues,f.loop.params.loop.fieldValues);assert.equal(h3(p.nodes[1]).segments[0].resultVariants[1].parameters.seed,72);assert.equal(h3(p.nodes[2]).segments[0].resultVariants[1].parameters.seed,82);assert.notEqual(h3(p.nodes[1]).segments[0].resultVariants[0].assetId,h3(f.a).segments[0].resultVariants[0].assetId);assert.equal(h3(p.nodes[1]).segments[0].resultVariants[0].assetId,h3(p.nodes[1]).segments[0].resultAssetIds[0]);validateProject(p);assert.equal(JSON.stringify(f.project),source);
 const bytes=await fs.readFile(file),needle=Buffer.from('"version":26'),offset=bytes.indexOf(needle);assert.ok(offset>=0);Buffer.from('"version":25').copy(bytes,offset);const downgraded=path.join(data,'owned-downgraded.jingchang');await fs.writeFile(downgraded,bytes);await assert.rejects(imports.upload(createReadStream(downgraded)),/第26版/);await noAuth(data);
});
test('H3逐轮视频可真实本机裁切导出，片段原参数和原分镜保持不变',async t=>{
 const f=await fixture(t),r=await complete(f);await applyCanvasResults({...f,job:r,revision:0});const before=JSON.stringify(f.project),snapshot=minimaxExportProject(f.project,{nodeId:f.b.id,selectedOnly:true}),renderer=renderService(f),j=await renderer.start(snapshot,{revision:snapshot.revision,requestId:'owned-loop-export'}),finished=await done(f,j.id);assert.equal(finished.status,'completed',finished.message);const output=path.join(f.data,'renders',finished.id,finished.result.attempt,'final.mp4'),info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','json',output]));assert.ok(Math.abs(Number(info.format.duration)-.5)<.08);assert.equal(JSON.stringify(f.project),before);
});
test('逐轮历史必须指向已有结果且保留有效参数，非法来源、时长和重复记录不能保存',()=>{
 const t=timeline(),s=t.segments[0];s.resultAssetIds=['video-a'];s.resultAssetId='video-a';s.resultVariants=[{assetId:'video-a',loopId:'loop-a',roundIndex:0,parameters:{prompt:'a',duration:1,aspectRatio:'16:9',megapixels:.4,seed:1}}];assert.equal(normalizeMinimaxTimeline(t).segments[0].resultVariants[0].parameters.seed,1);
 for(const edit of [t=>t.segments[0].resultVariants[0].assetId='missing',t=>t.segments[0].resultVariants[0].loopId='bad/path',t=>t.segments[0].resultVariants[0].roundIndex=100,t=>t.segments[0].resultVariants[0].parameters.duration=Infinity,t=>t.segments[0].resultVariants.push(t.segments[0].resultVariants[0])]){const v=structuredClone(t);edit(v);assert.throws(()=>normalizeMinimaxTimeline(v));}
});
