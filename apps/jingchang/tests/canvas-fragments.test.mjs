import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {makeProject,makeNode,validateProject} from '../lib/model.mjs';
import {atomicJson,readJson,storeAsset,userError} from '../lib/workspace.mjs';
import {selectCanvasFragment,fragmentMaps,mergeCanvasFragment} from '../lib/canvas-fragments.mjs';
import {assetCatalogService} from '../lib/asset-catalog.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {generationService} from '../lib/generation.mjs';
import {cloudWorkflowService} from '../lib/cloud-workflows.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
async function fixture(){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-fragments-')),activeJobs=new Map();
 const projects={load:async id=>{try{return await readJson(path.join(data,'projects',id,'project.json'));}catch(e){if(e.code==='ENOENT')throw userError('项目不存在',404);throw e;}},save:async p=>{await atomicJson(path.join(data,'projects',p.id,'project.json'),p);return p;}};
 const generation=generationService({data,activeJobs}),cloudWorkflows=cloudWorkflowService({data,activeJobs,projects});
 const a=await storeAsset(data,png,{type:'image/png',name:'已选择.png',tags:['原件']}),b=await storeAsset(data,png,{type:'image/png',name:'未选择.png'});
 const template=await generation.saveTemplate({name:'动态参考模板',workflow:{'1':{class_type:'LoadImage',inputs:{image:'source.png'}},'2':{class_type:'SaveImage',inputs:{images:['1',0],filename_prefix:'owned'}}}});
 const p=makeProject('选区来源'),source=makeNode('image',-180,40,{title:'已选参考图',assetId:a.id}),generated=makeNode('image',180,240,{title:'已选生成节点',text:'选区提示词',params:{workflowBinding:{workflowId:template.id,imageSources:[{nodeId:'1',name:'image',sourceNodeId:source.id}],overrides:[]}}}),unselected=makeNode('text',900,100,{text:'未选私有文字'});
 p.nodes=[source,generated,unselected];p.assets=[a,b];p.edges=[{id:'inside',source:source.id,target:generated.id},{id:'outside',source:generated.id,target:unselected.id}];p.groups=[{id:'original-group',title:'原有组',nodeIds:p.nodes.map(n=>n.id),color:'#123456',collapsed:false}];p.shots=[{id:'original-shot',assetId:b.id,description:'原有剪辑',duration:3}];p.messages=[{role:'user',text:'原有对话'}];p.runs=[{id:'original-run',kind:'history'}];p.settings.edit={music:[]};
 await projects.save(p);
 const target=makeProject('已有项目');target.nodes=[makeNode('text',30,90,{text:'当前项目原有文字'})];target.groups=[{id:'target-group',title:'当前组',nodeIds:target.nodes.map(n=>n.id)}];target.messages=[{role:'user',text:'当前消息'}];target.shots=[{id:'target-shot',description:'当前分镜',duration:4}];target.settings={ratio:'9:16',fps:30};target.viewport={x:40,y:70,zoom:.75};await projects.save(target);
 let bundles;const config={data,activeJobs,projects,workflows:generation,bundles:{export:(...args)=>bundles.exportBundle(...args),download:(...args)=>bundles.download(...args),upload:(...args)=>bundles.upload(...args),import:(...args)=>bundles.importBundle(...args),insert:(...args)=>bundles.insertBundle(...args),package:(...args)=>bundles.libraryPackage(...args)}},catalog=assetCatalogService(config);
 bundles=projectBundleService({data,activeJobs,projects,assetCatalog:catalog});
 return {data,activeJobs,projects,generation,cloudWorkflows,p,target,source,generated,unselected,template,a,b,config,catalog,bundles};
}
async function saved(f,nodeIds=[f.source.id,f.generated.id]){
 return f.catalog.addWorkflow({requestId:randomUUID(),revision:(await f.catalog.read()).revision,libraryId:'default',folderId:'workflows',name:'可复用选区',kind:'canvas-fragment',projectId:f.p.id,projectRevision:0,nodeIds});
}
const insertPayload=f=>({requestId:randomUUID(),projectId:f.target.id,revision:0,x:650,y:100});
async function pack(f,item){const file=(await f.catalog.download(item.id)).file,bytes=await fs.readFile(file),magic=Buffer.from('JINGCHANG-PACK-1\n'),size=bytes.readUInt32BE(magic.length);return {file,bytes,manifest:JSON.parse(bytes.subarray(magic.length+4,magic.length+4+size)),payload:bytes.subarray(magic.length+4+size)};}

test('选区只保存所选节点、内部连线及部分组成员，排除未选素材、剪辑、消息与运行记录',async()=>{
 const f=await fixture(),before=JSON.stringify(f.p),fragment=selectCanvasFragment(f.p,[f.source.id,f.generated.id]);
 assert.deepEqual(fragment.nodes.map(n=>n.id),[f.source.id,f.generated.id]);assert.equal(fragment.edges.length,1);assert.deepEqual(fragment.groups[0].nodeIds,[f.source.id,f.generated.id]);assert.deepEqual(fragment.assets.map(a=>a.id),[f.a.id]);assert.deepEqual(fragment.shots,[]);assert.deepEqual(fragment.messages,[]);assert.deepEqual(fragment.runs,[]);assert.equal(fragment.settings.edit,undefined);assert.equal(JSON.stringify(f.p),before);validateProject(fragment);
});
test('缺失节点、重复选择和未选动态依赖明确拒绝，不生成可复用包',async()=>{
 const f=await fixture();assert.throws(()=>selectCanvasFragment(f.p,[]),/请选择/);assert.throws(()=>selectCanvasFragment(f.p,[f.source.id,f.source.id]),/不同/);assert.throws(()=>selectCanvasFragment(f.p,['missing']),/不存在/);
 await assert.rejects(saved(f,[f.generated.id]),/未选中的节点/);assert.equal((await f.catalog.read()).revision,0);assert.equal(await fs.stat(path.join(f.data,'bundles','exports')).then(()=>true).catch(()=>false),false);
});
test('节点、循环逐轮目标和对话动态参考跟随插入编号，内层Comfy节点字段编号保留',async()=>{
 const f=await fixture(),p=structuredClone(f.p);p.nodes=[f.source,makeNode('loop',0,0,{params:{loop:{mode:'repeat',count:2,fieldValues:[{targetNodeId:f.source.id,nodeId:'1',name:'seed',values:[2,3]}]}}}),makeNode('text',300,0,{params:{llmBinding:{referenceSources:[{sourceNodeId:f.source.id}]}}})];p.edges=[];p.groups=[];p.shots=[];p.messages=[];p.runs=[];p.settings={ratio:'16:9',fps:24};
 const fragment=selectCanvasFragment(p,p.nodes.map(n=>n.id)),maps=fragmentMaps(fragment),result=mergeCanvasFragment(f.target,fragment,maps,{x:500,y:400}),copied=result.project.nodes.slice(1);assert.equal(copied[1].params.loop.fieldValues[0].targetNodeId,copied[0].id);assert.equal(copied[1].params.loop.fieldValues[0].nodeId,'1');assert.equal(copied[2].params.llmBinding.referenceSources[0].sourceNodeId,copied[0].id);assert.equal(copied[2].x-copied[0].x,p.nodes[2].x-p.nodes[0].x);assert.equal(copied[0].x,500);assert.equal(Math.min(...copied.map(n=>n.y)),400);assert.equal(copied[0].y,440);
});
test('v22选区包含实际原字节及绑定模板，原项目不改写；可在空白工作区恢复',async()=>{
 const f=await fixture(),original=await fs.readFile(path.join(f.data,'projects',f.p.id,'project.json')),added=await saved(f),raw=await pack(f,added.item);assert.equal(raw.manifest.version,22);assert.deepEqual(raw.manifest.canvasFragment,{version:1});assert.equal(raw.manifest.assets.length,1);assert.equal(raw.manifest.workflows.length,1);assert.equal(raw.manifest.project.nodes.length,2);assert.equal(raw.bytes.includes(Buffer.from('未选私有文字')),false);assert.equal(raw.bytes.includes(Buffer.from('原有对话')),false);assert.deepEqual(raw.payload,png);assert.equal(added.item.summary.edges,1);assert.equal(added.item.summary.groups,1);
 const g=await fixture(),preview=await g.bundles.upload(createReadStream(raw.file)),restored=await g.bundles.importBundle(preview.id);assert.equal(restored.nodes.length,2);assert.notEqual(restored.assets[0].id,f.a.id);assert.deepEqual(await fs.readFile(path.join(g.data,'assets',restored.assets[0].id)),png);assert.deepEqual(await fs.readFile(path.join(f.data,'projects',f.p.id,'project.json')),original);
 raw.manifest.version=21;const json=Buffer.from(JSON.stringify(raw.manifest)),length=Buffer.alloc(4);length.writeUInt32BE(json.length);await assert.rejects(g.bundles.upload(Readable.from([Buffer.from('JINGCHANG-PACK-1\n'),length,json,raw.payload])),/第22版/);
});
test('插入当前项目重新映射所有编号与依赖，保留原节点、分镜、设置、视图和素材原字节',async()=>{
 const f=await fixture(),added=await saved(f),input=insertPayload(f),result=await f.catalog.insertCanvas(added.item.id,input),p=result.project;assert.equal(p.id,f.target.id);assert.equal(p.revision,1);assert.equal(p.nodes.length,3);assert.equal(p.edges.length,1);assert.equal(p.groups.length,2);assert.deepEqual(p.nodes[0],f.target.nodes[0]);assert.deepEqual(p.messages,f.target.messages);assert.deepEqual(p.shots,f.target.shots);assert.deepEqual(p.settings,f.target.settings);assert.deepEqual(p.viewport,f.target.viewport);
 const [a,b]=p.nodes.slice(1);assert.notEqual(a.id,f.source.id);assert.notEqual(b.id,f.generated.id);assert.equal(a.x,650);assert.equal(a.y,100);assert.equal(b.x-a.x,360);assert.equal(b.y-a.y,200);assert.equal(b.params.workflowBinding.imageSources[0].sourceNodeId,a.id);assert.notEqual(b.params.workflowBinding.workflowId,f.template.id);assert.equal(b.params.workflowBinding.imageSources[0].nodeId,'1');assert.equal(p.edges[0].source,a.id);assert.equal(p.edges[0].target,b.id);assert.notEqual(p.groups[1].id,'original-group');assert.deepEqual(p.groups[1].nodeIds,[a.id,b.id]);assert.deepEqual(await fs.readFile(path.join(f.data,'assets',a.assetId)),png);assert.deepEqual(await fs.readFile(path.join(f.data,'assets',f.a.id)),png);
 assert.equal((await f.catalog.getInsertion(input.requestId,f.target.id)).status,'completed');assert.equal((await f.catalog.listInsertions(f.target.id)).length,1);assert.equal((await fs.readdir(path.join(f.data,'projects'))).length,2);assert.equal(f.activeJobs.size,0);
});
test('重复插入编号幂等；新编号可再插入，原编号不能改用其它目标或位置',async()=>{
 const f=await fixture(),added=await saved(f),input=insertPayload(f),one=await f.catalog.insertCanvas(added.item.id,input),again=await f.catalog.insertCanvas(added.item.id,{...input,revision:1});assert.equal(again.alreadyInserted,true);assert.deepEqual(again.nodeIds,one.nodeIds);assert.equal(again.project.revision,1);assert.equal(again.project.nodes.length,3);
 await assert.rejects(f.catalog.insertCanvas(added.item.id,{...input,x:800}),/另一目标/);await assert.rejects(f.catalog.insertCanvas(added.item.id,{...input,projectId:f.p.id}),/不属于/);
 const two=await f.catalog.insertCanvas(added.item.id,{...input,requestId:randomUUID(),revision:1,x:1100});assert.equal(two.project.nodes.length,5);assert.equal(two.project.revision,2);assert.ok(two.nodeIds.every(id=>!one.nodeIds.includes(id)));assert.equal(two.project.runs.filter(r=>r.kind==='canvas-fragment').length,2);
});
test('修订冲突、活动任务、容量及位置错误在新增素材和目标改写前拒绝',async()=>{
 const f=await fixture(),added=await saved(f),input=insertPayload(f),count=await fs.readdir(path.join(f.data,'assets')),before=await fs.readFile(path.join(f.data,'projects',f.target.id,'project.json'));
 await assert.rejects(f.catalog.insertCanvas(added.item.id,{...input,revision:9}),e=>e.status===409);assert.deepEqual(await fs.readdir(path.join(f.data,'assets')),count);assert.deepEqual(await fs.readFile(path.join(f.data,'projects',f.target.id,'project.json')),before);
 f.activeJobs.set('active',{projectId:f.target.id});await assert.rejects(f.catalog.insertCanvas(added.item.id,insertPayload(f)),/仍有任务/);f.activeJobs.clear();await assert.rejects(f.catalog.insertCanvas(added.item.id,{...insertPayload(f),x:1e8}),/位置/);
 const full=structuredClone(f.target);full.nodes=Array.from({length:1499},(_,i)=>makeNode('text',i,0));full.groups=[];await f.projects.save(full);await assert.rejects(f.catalog.insertCanvas(added.item.id,insertPayload(f)),/超过画布容量/);assert.deepEqual(await fs.readdir(path.join(f.data,'assets')),count);
});
test('目标已保存但回复丢失，重启读取原插入记录并确认原节点，不重新复制或添加',async()=>{
 const f=await fixture(),added=await saved(f),input=insertPayload(f),originalSave=f.projects.save;let lose=true;
 f.projects.save=async p=>{await originalSave(p);if(lose&&p.id===f.target.id&&p.runs.some(r=>r.kind==='canvas-fragment')){lose=false;throw userError('模拟保存后回复丢失');}return p;};
 await assert.rejects(f.catalog.insertCanvas(added.item.id,input),/回复丢失/);const stored=await f.projects.load(f.target.id),names=await fs.readdir(path.join(f.data,'assets'));assert.equal(stored.nodes.length,3);const restarted=assetCatalogService(f.config);assert.equal((await restarted.getInsertion(input.requestId,f.target.id)).status,'interrupted');const recovered=await restarted.insertCanvas(added.item.id,{...input,revision:stored.revision});assert.equal(recovered.project.revision,1);assert.equal(recovered.alreadyInserted,true);assert.deepEqual(recovered.project,stored);assert.deepEqual(await fs.readdir(path.join(f.data,'assets')),names);assert.equal((await restarted.getInsertion(input.requestId,f.target.id)).status,'completed');
});
test('资源已落盘但目标未保存，明确继续复用同一计划与资源编号；改变过的部分模板不被覆盖',async()=>{
 const f=await fixture(),added=await saved(f),input=insertPayload(f),save=f.projects.save;let fail=true;
 f.projects.save=async p=>{if(fail&&p.id===f.target.id&&p.runs.some(r=>r.kind==='canvas-fragment'))throw userError('模拟目标保存前中断');return save(p);};
 await assert.rejects(f.catalog.insertCanvas(added.item.id,input),/保存前中断/);assert.equal((await f.projects.load(f.target.id)).nodes.length,1);const files=await fs.readdir(path.join(f.data,'assets'));fail=false;const done=await f.catalog.insertCanvas(added.item.id,input);assert.equal(done.project.nodes.length,3);assert.deepEqual(await fs.readdir(path.join(f.data,'assets')),files);
 const next={...input,requestId:randomUUID(),revision:1,x:1100};fail=true;await assert.rejects(f.catalog.insertCanvas(added.item.id,next),/保存前中断/);const receipt=await readJson(path.join(f.data,'asset-catalog','insertions',next.requestId+'.json')),plan=await readJson(path.join(f.data,'bundles','imports',receipt.bundleId,'plan.json')),file=path.join(f.data,'workflows',Object.values(plan.workflows)[0]+'.json'),template=await readJson(file);template.name='用户改过的部分副本';await atomicJson(file,template);const preserved=await fs.readFile(file);fail=false;await assert.rejects(f.catalog.insertCanvas(added.item.id,next),/已修改|被占用/);assert.deepEqual(await fs.readFile(file),preserved);assert.equal((await f.projects.load(f.target.id)).revision,1);
});
test('同一目标的并发插入按修订串行；失效请求重新读取修订后继续原计划',async()=>{
 const f=await fixture(),added=await saved(f),a=insertPayload(f),b={...insertPayload(f),x:1000},settled=await Promise.allSettled([f.catalog.insertCanvas(added.item.id,a),f.catalog.insertCanvas(added.item.id,b)]);assert.equal(settled.filter(r=>r.status==='fulfilled').length,1);assert.equal(settled.find(r=>r.status==='rejected').reason.status,409);const retry=settled[0].status==='rejected'?a:b,done=await f.catalog.insertCanvas(added.item.id,{...retry,revision:1});assert.equal(done.project.nodes.length,5);assert.equal(done.project.revision,2);
});
test('选区内RunningHub配置及固定媒体随包恢复到目标项目，可与动态Comfy节点重新规划',async()=>{
 const f=await fixture();let recipe=await f.cloudWorkflows.create({projectId:f.p.id});recipe=await f.cloudWorkflows.save(recipe.id,{...recipe,baseUrl:'http://127.0.0.1:9',targetId:'1234',fields:[{nodeId:'1',fieldName:'image',type:'image',fieldValue:'',source:'asset',assetId:f.b.id}]});
 const rh=makeNode('image',550,100,{title:'云端节点',text:'处理',params:{cloudBinding:{recipeId:recipe.id,recipeRevision:recipe.revision,inputs:[]}}});f.p.nodes.push(rh);f.p.edges.push({id:'comfy-rh',source:f.generated.id,target:rh.id});await f.projects.save(f.p);
 const added=await saved(f,[f.source.id,f.generated.id,rh.id]),raw=await pack(f,added.item);assert.equal(raw.manifest.cloudWorkflows.length,1);assert.equal(raw.manifest.assets.length,2);const result=await f.catalog.insertCanvas(added.item.id,insertPayload(f)),node=result.project.nodes.find(n=>n.title==='云端节点'),copied=await f.cloudWorkflows.get(node.params.cloudBinding.recipeId);assert.equal(copied.projectId,f.target.id);assert.equal(copied.revision,0);assert.notEqual(copied.fields[0].assetId,f.b.id);assert.ok(result.project.assets.some(a=>a.id===copied.fields[0].assetId));
 const runner=canvasRunner({data:f.data,activeJobs:f.activeJobs,generation:f.generation,cloudWorkflows:f.cloudWorkflows}),steps=await runner.plan(result.project);assert.deepEqual(steps.map(s=>s.kind),['comfy','runninghub']);assert.equal(f.activeJobs.size,0);
});
test('凭据或包变更不进入插入流程；原模板、项目与素材保留',async()=>{
 const f=await fixture(),added=await saved(f),input=insertPayload(f);
 await assert.rejects(f.catalog.insertCanvas(added.item.id,{...input,apiKey:'synthetic-fragment-key'}),/密钥/);assert.equal(await fs.stat(path.join(f.data,'asset-catalog','insertions',input.requestId+'.json')).then(()=>true).catch(()=>false),false);
 const file=(await f.catalog.download(added.item.id)).file;await fs.appendFile(file,'changed');await assert.rejects(f.catalog.insertCanvas(added.item.id,input),/文件已变化/);assert.equal((await f.projects.load(f.target.id)).nodes.length,1);assert.deepEqual(await fs.readFile(path.join(f.data,'assets',f.a.id)),png);assert.deepEqual((await f.generation.template(f.template.id)).workflow,f.template.workflow);
});
test('下载的画布子图可独立导入另一工作区的分组并插入当前项目，重复文件请求不增加条目',async()=>{
 const f=await fixture(),added=await saved(f),raw=await pack(f,added.item),g=await fixture(),payload={requestId:randomUUID(),libraryId:'default',folderId:'workflows',revision:0,name:'跨工作区选区'};
 const imported=await g.catalog.importWorkflow(createReadStream(raw.file),payload);assert.equal(imported.item.kind,'canvas-fragment');assert.equal(imported.item.summary.nodes,2);assert.equal((await g.projects.load(g.target.id)).nodes.length,1);
 const again=await g.catalog.importWorkflow(createReadStream(raw.file),payload);assert.equal(again.item.id,imported.item.id);assert.equal(again.catalog.revision,1);assert.equal((await g.catalog.read()).libraries[0].folders.find(f=>f.id==='workflows').items.length,1);
 const result=await g.catalog.insertCanvas(imported.item.id,insertPayload(g));assert.equal(result.project.nodes.length,3);const copied=result.project.nodes.find(n=>n.title==='已选参考图');assert.notEqual(copied.assetId,f.a.id);assert.deepEqual(await fs.readFile(path.join(g.data,'assets',copied.assetId)),png);assert.equal((await fs.readdir(path.join(g.data,'projects'))).length,2);assert.equal(g.activeJobs.size,0);
 const read=await g.catalog.download(imported.item.id);assert.deepEqual(await fs.readFile(read.file),raw.bytes);
});
test('文件工作流入口拒绝完整工程、媒体分组、旧修订及错误格式；插入收据不能跨项目读取',async()=>{
 const f=await fixture(),added=await saved(f),raw=await pack(f,added.item),input={requestId:randomUUID(),libraryId:'default',folderId:'characters',revision:1,name:'拒绝测试'};
 await assert.rejects(f.catalog.importWorkflow(createReadStream(raw.file),input),/工作流分组/);await assert.rejects(f.catalog.importWorkflow(createReadStream(raw.file),{...input,folderId:'workflows',revision:99}),e=>e.status===409);
 await assert.rejects(f.catalog.importWorkflow(Readable.from([Buffer.from('{}')]),{...input,folderId:'workflows'}),/不完整|请选择/);
 const whole=await f.bundles.exportBundle(f.p.id,0);await assert.rejects(f.catalog.importWorkflow(createReadStream(await f.bundles.download(whole.id)),{...input,folderId:'workflows'}),/完整工程/);assert.equal((await f.catalog.read()).revision,1);
 const payload=insertPayload(f);await f.catalog.insertCanvas(added.item.id,payload);await assert.rejects(f.catalog.getInsertion(payload.requestId,f.p.id),/不属于/);assert.equal((await f.catalog.listInsertions(f.p.id)).length,0);
 const file=(await f.catalog.download(added.item.id)).file,owned=path.join(f.data,'preserved-fragment.jingchang');await fs.rename(file,owned);await fs.symlink(owned,file);await assert.rejects(f.catalog.insertCanvas(added.item.id,{...payload,requestId:randomUUID(),revision:1}),/普通文件|符号链接/);assert.equal((await f.projects.load(f.target.id)).revision,1);assert.deepEqual(await fs.readFile(owned),raw.bytes);
});
test('图片、语言、创作台、RunningHub及LTX音画动态引用全部指向新节点，内层字段与片段编号保持',async()=>{
 const f=await fixture(),audio=makeNode('audio',0,200),image=makeNode('image',300,0,{params:{imageBinding:{referenceSources:[{sourceNodeId:f.source.id}]}}}),text=makeNode('text',300,300,{params:{llmBinding:{referenceSources:[{sourceNodeId:f.source.id},{sourceNodeId:audio.id}]}}}),studio=makeNode('video',600,0,{params:{studioBinding:{referenceSources:[{sourceNodeId:f.source.id},{sourceNodeId:audio.id}]}}}),cloud=makeNode('image',600,300,{params:{cloudBinding:{inputs:[{nodeId:'inner-5',fieldName:'image',sourceNodeId:f.source.id}]}}}),ltx=makeNode('video',900,0,{params:{workflowBinding:{workflowId:'ltx-template',imageSources:[],overrides:[],ltxDirector:{nodeId:'inner-9',useCustomAudio:true,segments:[{id:'image-segment',type:'image',start:0,length:120,sourceNodeId:f.source.id,prompt:'图像'}],audioSegments:[{id:'audio-segment',type:'audio',start:0,length:120,sourceNodeId:audio.id}]}}}});
 const p={...structuredClone(f.p),nodes:[f.source,audio,image,text,studio,cloud,ltx],edges:[],groups:[],shots:[],messages:[],runs:[],settings:{ratio:'16:9',fps:24}},fragment=selectCanvasFragment(p,p.nodes.map(n=>n.id)),maps=fragmentMaps(fragment),result=mergeCanvasFragment(f.target,fragment,maps,{x:0,y:0}),byTitle=new Map(result.project.nodes.slice(1).map(n=>[n.id,n]));
 for(const old of [image,text,studio])for(const ref of byTitle.get(maps.nodes[old.id]).params[old===image?'imageBinding':old===text?'llmBinding':'studioBinding'].referenceSources)assert.ok([maps.nodes[f.source.id],maps.nodes[audio.id]].includes(ref.sourceNodeId));
 const c=byTitle.get(maps.nodes[cloud.id]);assert.equal(c.params.cloudBinding.inputs[0].sourceNodeId,maps.nodes[f.source.id]);assert.equal(c.params.cloudBinding.inputs[0].nodeId,'inner-5');
 const timeline=byTitle.get(maps.nodes[ltx.id]).params.workflowBinding.ltxDirector;assert.equal(timeline.nodeId,'inner-9');assert.equal(timeline.segments[0].sourceNodeId,maps.nodes[f.source.id]);assert.equal(timeline.audioSegments[0].sourceNodeId,maps.nodes[audio.id]);assert.equal(timeline.segments[0].id,'image-segment');assert.equal(timeline.audioSegments[0].id,'audio-segment');
});
test('已有不同集合可复用同一编号，未完成的旧绑定不妨碍插入独立有效选区',async()=>{
 const f=await fixture(),target=structuredClone(f.target),second=makeNode('text',400,90);target.nodes.push(second);target.edges=[{id:target.nodes[0].id,source:target.nodes[0].id,target:second.id}];target.groups[0].id=target.nodes[0].id;target.nodes[0].params.llmBinding={referenceSources:[{sourceNodeId:'old-missing-reference'}]};
 const fragment=selectCanvasFragment(f.p,[f.source.id,f.generated.id]),merged=mergeCanvasFragment(target,fragment,fragmentMaps(fragment),{x:800,y:0});assert.equal(merged.project.nodes.length,4);assert.deepEqual(merged.project.nodes[0],target.nodes[0]);assert.equal(merged.project.edges[0].id,target.nodes[0].id);validateProject(merged.project);
});
