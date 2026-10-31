import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeToFragment,normalizeNativeWorkflow} from '../lib/native-canvas-core.mjs';
import {nativeFlowPreview} from '../lib/native-flow.mjs';
import {generationService} from '../lib/generation.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';
import {applyCanvasResults} from '../lib/generation-results.mjs';
import {readJson,storeAsset} from '../lib/workspace.mjs';
import {validateProject,makeNode} from '../lib/model.mjs';
import {normalizeMinimaxTimeline,newMinimaxSegment} from '../public/minimax-h3-core.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
const source=(id,type,extra={})=>({id,type,x:0,y:0,...extra});
async function fixture(t){
 const state={submitted:[],uploads:[],holdAt:0};
 const mock=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);res.setHeader('content-type','application/json');
  if(req.url==='/prompt'){state.submitted.push(JSON.parse(bytes));return res.end(JSON.stringify({prompt_id:'p-'+state.submitted.length}));}
  if(req.url==='/v1/images/generations'){state.apiRequests=(state.apiRequests||0)+1;return res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));}
  if(req.url==='/upload/image'){state.uploads.push(bytes);return res.end(JSON.stringify({name:'input-'+state.uploads.length+'.png',subfolder:'',type:'input'}));}
  if(req.url.startsWith('/history/')){const id=req.url.split('/').at(-1);if(Number(id.split('-').at(-1))===state.holdAt)return res.end('{}');return res.end(JSON.stringify({[id]:{status:{completed:true,status_str:'success'},outputs:{'3':{images:[{filename:id+'.png',type:'output',subfolder:''}]}}}}));}
  if(req.url.startsWith('/view')){res.setHeader('content-type','image/png');return res.end(png);}
  res.statusCode=404;res.end('{}');
 });mock.listen(0,'127.0.0.1');await once(mock,'listening');t.after(()=>new Promise(resolve=>mock.close(resolve)));
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-native-flow-')),activeJobs=new Map(),generation=generationService({data,activeJobs}),runner=canvasRunner({data,activeJobs,generation,pollInterval:10});
 const a=await storeAsset(data,png,{name:'甲参考.png',type:'image/png'}),b=await storeAsset(data,png,{name:'乙参考.png',type:'image/png'});
 const resources=[a,b].map((asset,index)=>({url:'/source/'+index,archive:'resources/'+index+'.png',portableUrl:asset.url,asset}));
 const document=normalizeNativeWorkflow({nodes:[source('last','output'),source('next','comfy',{text:'收尾'}),source('middle','output'),source('first','comfy',{text:'首步',inputs:['pg','mg:ib','mg:ia','mg:prompts']}),source('pg','promptGroup',{items:['tb','ta']}),source('ta','prompt',{text:'甲提示'}),source('tb','prompt',{text:'乙提示'}),source('mg','group',{items:['ib','ia','tp']}),source('ia','image',{url:'/source/0'}),source('ib','image',{url:'/source/1'}),source('tp','prompt',{text:'组内说明'})],connections:[{from:'pg',to:'first'},{from:'mg',to:'first'},{from:'first',to:'middle'},{from:'middle',to:'next'},{from:'first',to:'last'},{from:'next',to:'last'}]});
 const project=nativeToFragment(document,resources,'原生运行专项'),id=raw=>project.nodes.find(n=>n.params.nativeCanvas.node.id===raw).id,node=raw=>project.nodes.find(n=>n.id===id(raw));
 const template=await generation.saveTemplate({name:'本机双参考',workflow:{'1':{class_type:'Text',inputs:{text:'old'}},'2':{class_type:'LoadImage',inputs:{image:'old.png'}},'4':{class_type:'LoadImage',inputs:{image:'old.png'}},'3':{class_type:'SaveImage',inputs:{images:['2',0]}}}});
 node('first').params.nativeCanvas.adaptation='configured';node('first').params.workflowBinding={workflowId:template.id,overrides:[],imageSources:[{nodeId:'2',name:'image',sourceNodeId:id('mg'),sourceIndex:0},{nodeId:'4',name:'image',sourceNodeId:id('mg'),sourceIndex:1}],promptField:{nodeId:'1',name:'text'},count:2};
 node('next').params.nativeCanvas.adaptation='configured';node('next').params.workflowBinding={workflowId:template.id,overrides:[],imageSources:[{nodeId:'2',name:'image',sourceNodeId:id('middle')}],promptField:{nodeId:'1',name:'text'},count:1};
 return{state,data,activeJobs,generation,runner,project,id,node,a,b,endpoint:'http://127.0.0.1:'+mock.address().port};
}
async function wait(f,id,predicate){for(let i=0;i<700;i++){const job=await readJson(path.join(f.data,'jobs',id+'.json'));if(predicate(job))return job;await delay(10);}throw Error('原生运行等待超时');}
async function idle(f){for(let i=0;i<150&&f.activeJobs.size;i++)await delay(10);assert.equal(f.activeJobs.size,0);}
async function acceptedChild(f,jobId,stepIndex){
 const parent=await wait(f,jobId,job=>!!job.steps[stepIndex].jobId),childId=parent.steps[stepIndex].jobId;
 for(let i=0;i<700;i++){const child=await readJson(path.join(f.data,'jobs',childId+'.json'));if(child.items?.some(item=>item.promptId))return child;await delay(10);}
 throw Error('模拟上游尚未保存可恢复的任务编号');
}

test('分组文本无重复、两份素材按序映射、本批所有结果收集，下游取最新，原项目待确认回填',async t=>{
 const f=await fixture(t),before=structuredClone(f.project),plan=await f.runner.plan(f.project,{nodeId:f.id('next')});assert.deepEqual(plan.map(s=>s.nodeId),[f.id('first'),f.id('next')]);assert.equal(plan[0].text,'乙提示\n\n甲提示\n\n组内说明\n\n首步');
 const started=await f.runner.start(f.project,{revision:0,requestId:'native-ordered',consent:true},f.endpoint),done=await wait(f,started.id,j=>['completed','interrupted'].includes(j.status));assert.equal(done.status,'completed',done.message);assert.equal(f.state.submitted.length,3);assert.equal(f.state.uploads.length,3);assert.equal(f.state.submitted[0].prompt['1'].inputs.text,plan[0].text);assert.equal(f.state.submitted[2].prompt['1'].inputs.text,'收尾');assert.deepEqual(f.project,before);
 const firstChild=await readJson(path.join(f.data,'jobs',done.steps[0].jobId+'.json')),nextChild=await readJson(path.join(f.data,'jobs',done.steps[1].jobId+'.json'));assert.deepEqual(firstChild.imageBindings.map(b=>b.assetId),[f.b.id,f.a.id]);assert.equal(nextChild.imageBindings[0].assetId,done.assets[1].id);
 const applied=await applyCanvasResults({...f,job:done,revision:0});assert.equal(applied.applied,true);assert.deepEqual(nativeFlowPreview(f.project,{nodeId:f.id('first')}).nodes[0].media.map(m=>m.assetId),done.assets.slice(0,2).map(a=>a.id));assert.deepEqual(nativeFlowPreview(f.project,{nodeId:f.id('middle')}).nodes[0].media.map(m=>m.assetId),done.assets.slice(0,2).map(a=>a.id));assert.deepEqual(nativeFlowPreview(f.project,{nodeId:f.id('last')}).nodes[0].media.map(m=>m.assetId),done.assets.map(a=>a.id));assert.equal(f.node('last').assetId,done.assets.at(-1).id);validateProject(f.project);
 await assert.rejects(applyCanvasResults({...f,job:done,revision:1}),/没有尚未/);assert.equal((await f.runner.start(f.project,{revision:0,requestId:'native-ordered',consent:true},f.endpoint)).id,done.id);assert.equal(f.state.submitted.length,3);
});

test('已知多素材缺序号、非法序号、类型错配和组合循环在任何提交前拒绝',async t=>{
 const f=await fixture(t),check=async(change,re)=>{const p=structuredClone(f.project);change(p);await assert.rejects(f.runner.plan(p),re);assert.equal(f.state.submitted.length,0);};
 const first=p=>p.nodes.find(n=>n.id===f.id('first'));
 await check(p=>delete first(p).params.workflowBinding.imageSources[0].sourceIndex,/明确选择/);
 await check(p=>first(p).params.workflowBinding.imageSources[0].sourceIndex=1000,/0–999/);
 await check(p=>first(p).params.workflowBinding.imageSources[0].sourceIndex=1.5,/整数/);
 await check(p=>first(p).params.workflowBinding.imageSources[0].sourceIndex=9,/不存在/);
 await check(p=>p.edges.push({id:'implicit-cycle',source:f.id('mg'),target:f.id('ia')}),/循环依赖/);
});

test('实际上游返回多份素材时不静默只取第一项，停止下游并保留已完成结果',async t=>{
 const f=await fixture(t);f.project.edges=f.project.edges.filter(e=>!(e.source===f.id('middle')&&e.target===f.id('next')));f.project.edges.push({id:'direct-all',source:f.id('first'),target:f.id('next')});f.node('next').params.workflowBinding.imageSources[0].sourceNodeId=f.id('first');
 const j=await f.runner.start(f.project,{revision:0,requestId:'native-no-drop',consent:true},f.endpoint),done=await wait(f,j.id,j=>j.status==='interrupted');assert.match(done.message,/明确选择/);assert.equal(f.state.submitted.length,2);assert.equal(done.assets.length,2);assert.equal(done.steps[0].status,'completed');assert.equal(done.steps[1].status,'pending');
});

test('中断、取回部分结果、重建执行器继续原任务，输出收集追加且不重复提交',async t=>{
 const f=await fixture(t);f.state.holdAt=3;const j=await f.runner.start(f.project,{revision:0,requestId:'native-resume',consent:true},f.endpoint);
 await acceptedChild(f,j.id,1);f.activeJobs.get(j.id).controller.abort();const partial=await wait(f,j.id,job=>job.status==='cancelled');await idle(f);
 const first=await applyCanvasResults({...f,job:partial,revision:0,acceptPartial:true});assert.equal(first.applied,false);assert.equal(f.node('last').params.nativeCanvas.node.images.length,2);
 f.state.holdAt=0;const generation=generationService({data:f.data,activeJobs:f.activeJobs}),runner=canvasRunner({...f,generation,pollInterval:10});await runner.resume(j.id);const done=await wait(f,j.id,job=>['completed','interrupted'].includes(job.status));assert.equal(done.status,'completed',done.message);assert.equal(f.state.submitted.length,3);assert.equal(f.state.uploads.length,3);
 const second=await applyCanvasResults({...f,job:done,revision:1});assert.equal(second.applied,true);assert.equal(f.node('last').params.nativeCanvas.node.images.length,3);assert.equal(new Set(f.node('last').params.nativeCanvas.mediaAssetIds).size,3);assert.equal(f.project.runs.length,2);
});

test('运行中修改接收器、上游文字或连线，结果单独保存，原接收器不被覆盖',async t=>{
 for(const edit of ['receiver','source','edge']){const f=await fixture(t),j=await f.runner.start(f.project,{revision:0,requestId:'native-edited-'+edit,consent:true},f.endpoint),done=await wait(f,j.id,job=>['completed','interrupted'].includes(job.status));assert.equal(done.status,'completed',done.message);
  if(edit==='receiver')f.node('last').text='用户的新备注';else if(edit==='source')f.node('ta').text='用户新提示词';else f.project.edges=f.project.edges.filter(e=>!(e.source===f.id('next')&&e.target===f.id('last')));
  const result=await applyCanvasResults({...f,job:done,revision:0});assert.equal(result.applied,true);assert.equal(f.node('last').assetId,null);assert.equal(f.node('last').params.nativeCanvas.node.images?.length||0,0);assert.equal(f.project.assets.length,5);
 }
});

test('未配置的H3云执行器、未绑定的智能语言模型及镜场循环输出收集明确拒绝，不打开费用入口',async t=>{
 const f=await fixture(t),p=structuredClone(f.project),first=p.nodes.find(n=>n.id===f.id('first'));delete first.params.workflowBinding;first.type='video';first.params.cloudBinding={recipeId:'owned-placeholder',minimaxH3:normalizeMinimaxTimeline({version:1,engine:'runninghub',segments:[newMinimaxSegment('segment')],selectedSegmentId:'segment',autoUpstream:false})};await assert.rejects(f.runner.plan(p),/云工作流执行器未配置/);
 const split=structuredClone(f.project),prompt=split.nodes.find(n=>n.id===f.id('ta'));prompt.params.nativeCanvas.node.type='smart-prompt';prompt.params.nativeCanvas.node.promptSplitEnabled=true;prompt.params.nativeCanvas.node.llmEnabled=true;await assert.rejects(f.runner.plan(split),/尚未绑定/);
 const looped=structuredClone(f.project);looped.nodes=looped.nodes.filter(n=>!['pg','mg','ia','ib','ta','tb','tp','next'].includes(n.params.nativeCanvas.node.id));looped.edges=looped.edges.filter(e=>looped.nodes.some(n=>n.id===e.source)&&looped.nodes.some(n=>n.id===e.target));looped.groups=[];const generator=looped.nodes.find(n=>n.id===f.id('first'));generator.params.workflowBinding.imageSources=[];generator.params.workflowBinding.count=1;generator.params.nativeCanvas.inputOrder=[];generator.params.nativeCanvas.node.inputs=[];const loop=makeNode('loop',0,0);loop.params.loop={mode:'repeat',count:2};looped.nodes.push(loop);looped.edges.push({id:'own-loop',source:loop.id,target:generator.id});await assert.rejects(f.runner.plan(looped),/收集循环回合/);assert.equal(f.state.submitted.length,0);
});

test('分组、素材序号、细项排序及完整结果经过备份恢复后可重新规划',async t=>{
 const f=await fixture(t),j=await f.runner.start(f.project,{revision:0,requestId:'native-bundle',consent:true},f.endpoint),done=await wait(f,j.id,job=>['completed','interrupted'].includes(job.status));assert.equal(done.status,'completed',done.message);await applyCanvasResults({...f,job:done,revision:0});
 const {projectBundleService}=await import('../lib/project-bundles.mjs'),{createReadStream}=await import('node:fs'),bundles=projectBundleService({...f,projects:{load:async()=>f.project}}),exported=await bundles.exportBundle(f.project.id,f.project.revision),data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-native-flow-bundle-')),activeJobs=new Map();let restored;const receiver=projectBundleService({data,activeJobs,projects:{load:async()=>{if(restored)return restored;throw Object.assign(Error('not-found'),{status:404});},save:async p=>(restored=p)}});
 assert.equal(exported.formatVersion,27);const bytes=await fs.readFile(await bundles.download(exported.id)),offset=Buffer.byteLength('JINGCHANG-PACK-1\n'),size=bytes.readUInt32BE(offset),manifest=JSON.parse(bytes.subarray(offset+4,offset+4+size));manifest.version=26;const downgradedJson=Buffer.from(JSON.stringify(manifest)),length=Buffer.alloc(4);length.writeUInt32BE(downgradedJson.length);await assert.rejects(receiver.upload(Readable.from([Buffer.concat([bytes.subarray(0,offset),length,downgradedJson,bytes.subarray(offset+4+size)])])),/第27版/);assert.equal(restored,undefined);
 const uploaded=await receiver.upload(createReadStream(await bundles.download(exported.id)));await receiver.importBundle(uploaded.id);
 const generation=generationService({data,activeJobs}),runner=canvasRunner({data,activeJobs,generation}),first=restored.nodes.find(n=>n.params?.nativeCanvas?.node.id==='first'),last=restored.nodes.find(n=>n.params?.nativeCanvas?.node.id==='last');assert.deepEqual(first.params.workflowBinding.imageSources.map(r=>r.sourceIndex),[0,1]);assert.equal(first.params.nativeCanvas.inputOrder.filter(r=>r.itemType==='group-media').length,2);assert.equal(nativeFlowPreview(restored,{nodeId:last.id}).nodes[0].media.length,3);assert.equal((await runner.plan(restored)).length,2);assert.equal(restored.runs.length,0);validateProject(restored);
});

test('已有多结果缓存的原生图片接口节点仍可运行，旧输出不成为输入组',async t=>{
 const f=await fixture(t),{directImageService}=await import('../lib/direct-images.mjs'),resources=[f.a,f.b].map(asset=>({url:asset.url,portableUrl:asset.url,archive:'resources/'+asset.id+'.png',asset})),history=resources.map(r=>r.url),project=nativeToFragment(normalizeNativeWorkflow({nodes:[source('g','generator',{text:'本机协议样本',generatedOutputs:history}),source('o','output',{images:history})],connections:[{from:'g',to:'o'}]}),resources,'单节点结果收集'),[g,o]=project.nodes;
 g.params.nativeCanvas.adaptation='configured';g.params.imageBinding={platform:{id:'owned-fixture',name:'本机协议样本',protocol:'openai-compatible',baseUrl:f.endpoint+'/v1',models:[{id:'fixture-image',category:'image',referenceSupport:true}]},model:'fixture-image',referenceSources:[]};
 const directImages=directImageService({...f,platforms:{get:async()=>{throw Error('本机测试只能使用已保存配置');}}}),runner=canvasRunner({...f,directImages,pollInterval:10});
 for(let round=0;round<2;round++){const job=await runner.start(project,{revision:project.revision,requestId:'owned-image-round-'+round,consent:true,imageCredentials:[{nodeId:g.id,apiKey:'fixture-only-not-real',authorization:{origin:f.endpoint,model:'fixture-image',sendPrompt:true,sendReferences:false,requestLimit:1,budget:1,currency:'CNY'}}]},f.endpoint),done=await wait(f,job.id,j=>['completed','interrupted'].includes(j.status));assert.equal(done.status,'completed',done.message);assert.equal(done.assets.length,1);await applyCanvasResults({data:f.data,project,job:done,revision:project.revision});}
 assert.equal(f.state.apiRequests,2);assert.equal(o.params.nativeCanvas.node.images.length,4);assert.equal(g.params.nativeCanvas.node.generatedOutputs.length,1);validateProject(project);
});
