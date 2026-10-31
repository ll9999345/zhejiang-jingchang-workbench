import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {makeProject,makeNode} from '../lib/model.mjs';
import {generationService} from '../lib/generation.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';
import {applyLoopResults} from '../lib/generation-results.mjs';
import {readJson} from '../lib/workspace.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
async function fixture(t){
 const state={submitted:[],uploads:0,failed:false,pending:false,holdAt:0};
 const mock=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);res.setHeader('content-type','application/json');
  if(req.url==='/prompt'){state.submitted.push(JSON.parse(Buffer.concat(chunks)));return res.end(JSON.stringify({prompt_id:'p-'+state.submitted.length}));}
  if(req.url==='/upload/image'){state.uploads++;return res.end(JSON.stringify({name:'upstream-'+state.uploads+'.png',subfolder:'',type:'input'}));}
  if(req.url.startsWith('/history/')){if(state.pending||state.holdAt&&Number(req.url.split('-').at(-1))===state.holdAt)return res.end('{}');const id=req.url.split('/').at(-1);return res.end(JSON.stringify({[id]:{status:{completed:!state.failed,status_str:state.failed?'error':'success'},outputs:state.failed?{}:{'3':{images:[{filename:'out.png',type:'output',subfolder:''}]}}}}));}
  if(req.url.startsWith('/view')){res.setHeader('content-type','image/png');return res.end(png);}res.statusCode=404;res.end('{}');
 });mock.listen(0,'127.0.0.1');await once(mock,'listening');t.after(()=>new Promise(r=>mock.close(r)));
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-graph-')),activeJobs=new Map(),generation=generationService({data,activeJobs}),runner=canvasRunner({data,activeJobs,generation,pollInterval:10});
 const source=await generation.saveTemplate({name:'第一步',workflow:{'1':{class_type:'Text',inputs:{text:'original',seed:20}},'3':{class_type:'SaveImage',inputs:{images:['1',0]}}}}),next=await generation.saveTemplate({name:'第二步',workflow:{'1':{class_type:'Text',inputs:{text:'original',seed:20}},'2':{class_type:'LoadImage',inputs:{image:'none.png'}},'3':{class_type:'SaveImage',inputs:{images:['2',0]}}}});
 const project=makeProject('流水线'),script=makeNode('script',0,0,{text:'故事背景'}),a=project.nodes[0],b=makeNode('image',350,0,{text:'后续镜头'});a.text='第一镜头';project.nodes=[script,a,b];project.edges=[{id:'edge-1',source:script.id,target:a.id},{id:'edge-2',source:a.id,target:b.id}];
 a.params.workflowBinding={workflowId:source.id,overrides:[],imageSources:[],promptField:{nodeId:'1',name:'text'},incrementSeeds:true};
 b.params.workflowBinding={workflowId:next.id,overrides:[],imageSources:[{nodeId:'2',name:'image',sourceNodeId:a.id}],promptField:{nodeId:'1',name:'text'},incrementSeeds:true};
 const loop=makeNode('loop',-350,0,{title:'逐镜循环',text:'共用描述'});loop.params.loop={mode:'list',values:['白天','夜晚']};project.nodes.unshift(loop);project.edges.push({id:'loop-a',source:loop.id,target:a.id});
 return {loop,a,b,data,activeJobs,generation,runner,state,project,endpoint:'http://127.0.0.1:'+mock.address().port};
}
async function wait(data,id,fn){for(let i=0;i<500;i++){const job=await readJson(path.join(data,'jobs',id+'.json'));if(fn(job))return job;await new Promise(r=>setTimeout(r,10));}throw new Error('timeout');}
async function idle(f){for(let i=0;i<100&&f.activeJobs.size;i++)await new Promise(r=>setTimeout(r,10));assert.equal(f.activeJobs.size,0);}
test('列表循环逐轮执行整条链，传本轮图片、文字及递增种子，结果保留轮次',async t=>{
 const f=await fixture(t),{runner,project,state,endpoint,loop,a,b,data}=f,plan=await runner.plan(project);
 assert.deepEqual(plan.map(s=>s.nodeId),[a.id,b.id,a.id,b.id]);assert.deepEqual(plan.map(s=>s.seedOffset),[0,0,1,1]);assert.equal(new Set(plan.map(s=>s.executionId)).size,4);
 const j=await runner.start(project,{revision:0,consent:true,requestId:'loop-list'},endpoint),done=await wait(data,j.id,j=>['completed','interrupted'].includes(j.status));assert.equal(done.status,'completed',done.message);
 assert.deepEqual(state.submitted.map(x=>x.prompt['1'].inputs.seed),[20,20,21,21]);assert.match(state.submitted[0].prompt['1'].inputs.text,/白天/);assert.match(state.submitted[2].prompt['1'].inputs.text,/夜晚/);assert.doesNotMatch(state.submitted[2].prompt['1'].inputs.text,/白天/);
 assert.equal(state.submitted[1].prompt['2'].inputs.image,'upstream-1.png');assert.equal(state.submitted[3].prompt['2'].inputs.image,'upstream-2.png');assert.deepEqual(done.assets.map(x=>x.roundIndex),[0,0,1,1]);assert.equal(project.assets.length,0);
 const children=await Promise.all(done.steps.map(s=>readJson(path.join(data,'jobs',s.jobId+'.json'))));assert.equal(children[1].imageBindings[0].assetId,done.assets[0].id);assert.equal(children[3].imageBindings[0].assetId,done.assets[2].id);
 const result=await applyLoopResults({data,project,job:done,revision:0});assert.equal(result.applied,true);assert.equal(project.assets.length,4);assert.equal(project.nodes.filter(n=>n.title.startsWith('第 2 轮')).length,2);assert.equal(a.assetId,null);await assert.rejects(applyLoopResults({data,project,job:done,revision:1}),/没有尚未/);
});
test('第二轮中断后取回第一轮，重建执行器恢复原编号，最终回填不重复',async t=>{
 const f=await fixture(t);f.state.holdAt=3;const j=await f.runner.start(f.project,{revision:0,consent:true,requestId:'loop-resume'},f.endpoint);
 await wait(f.data,j.id,()=>f.state.submitted.length===3);await new Promise(r=>setTimeout(r,25));f.activeJobs.get(j.id).controller.abort();const paused=await wait(f.data,j.id,j=>j.status==='cancelled');await idle(f);
 assert.equal(paused.assets.length,2);await assert.rejects(applyLoopResults({...f,job:paused,revision:0}),/确认/);const partial=await applyLoopResults({...f,job:paused,revision:0,acceptPartial:true});assert.equal(partial.applied,false);
 const generation=generationService({data:f.data,activeJobs:f.activeJobs}),runner=canvasRunner({...f,generation,pollInterval:10});f.state.holdAt=0;await runner.resume(j.id);const done=await wait(f.data,j.id,j=>['completed','interrupted'].includes(j.status));assert.equal(done.status,'completed',done.message);assert.equal(f.state.submitted.length,4);assert.deepEqual(f.state.submitted.map(x=>x.prompt['1'].inputs.seed),[20,20,21,21]);const result=await applyLoopResults({...f,job:done,revision:1});assert.equal(result.applied,true);assert.equal(f.project.assets.length,4);assert.equal(f.project.runs.length,2);assert.equal(new Set(result.appliedAssetIds).size,4);
});
test('外部生成依赖在循环前执行一次；两条独立循环各自展开',async t=>{
 const f=await fixture(t),x=makeNode('image',0,0,{text:'公共参考'});x.params.workflowBinding=structuredClone(f.a.params.workflowBinding);f.project.nodes.push(x);f.project.edges.push({id:'x-b',source:x.id,target:f.b.id});const plan=await f.runner.plan(f.project);assert.deepEqual(plan.map(s=>s.nodeId),[x.id,f.a.id,f.b.id,f.a.id,f.b.id]);
 const l2=makeNode('loop',0,0);l2.params.loop={mode:'repeat',count:3};f.project.nodes.push(l2);f.project.edges.push({id:'l2-x',source:l2.id,target:x.id});await assert.rejects(f.runner.plan(f.project),/同时属于两个循环/);
 f.project.edges=f.project.edges.filter(e=>e.id!=='x-b');const independent=await f.runner.plan(f.project);assert.equal(independent.length,7);assert.equal(independent.filter(s=>s.nodeId===x.id).length,3);
});
test('循环边界和参数错误在任何提交前阻止执行',async t=>{
 const f=await fixture(t),check=async(mut,re)=>{const p=structuredClone(f.project);mut(p);await assert.rejects(f.runner.plan(p),re);assert.equal(f.state.submitted.length,0);};
 await check(p=>p.nodes[0].params.loop={mode:'repeat',count:33},/1–32/);
 await check(p=>p.nodes[0].params.loop={mode:'list',values:['']},/循环列表/);
 await check(p=>{p.nodes[0].params.loop={mode:'repeat',count:32};p.nodes[2].params.workflowBinding.count=2;},/64次/);
 await check(p=>p.edges=[],/下游没有/);
 await check(p=>{for(const n of p.nodes)if(n.params.workflowBinding)delete n.params.workflowBinding.promptField;},/文字字段/);
 await check(p=>{const l=makeNode('loop',0,0);p.nodes.push(l);p.edges.push({id:'nested',source:f.loop.id,target:l.id});},/嵌套/);
 await check(p=>p.edges.push({id:'cycle',source:f.b.id,target:f.a.id}),/循环|环/);
 await check(p=>{for(const n of p.nodes)if(n.params.workflowBinding)n.params.workflowBinding.overrides=[{nodeId:'1',name:'seed',value:Number.MAX_SAFE_INTEGER}];},/种子/);
});
test('循环与工作流完整备份可恢复配置及动态引用并重新规划',async t=>{
 const f=await fixture(t),{projectBundleService}=await import('../lib/project-bundles.mjs'),{createReadStream}=await import('node:fs');const bundles=projectBundleService({...f,projects:{load:async()=>f.project}}),out=await bundles.exportBundle(f.project.id,0),file=await bundles.download(out.id),data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-loop-import-')),activeJobs=new Map();let imported;const projects={load:async()=>{if(imported)return imported;throw Object.assign(Error('missing'),{status:404});},save:async p=>(imported=p)},target=projectBundleService({data,activeJobs,projects}),preview=await target.upload(createReadStream(file)),p=await target.importBundle(preview.id),generation=generationService({data,activeJobs}),runner=canvasRunner({data,activeJobs,generation});assert.deepEqual(p.nodes.find(n=>n.type==='loop').params.loop,f.loop.params.loop);assert.equal((await runner.plan(p)).length,4);assert.notEqual(p.nodes[2].params.workflowBinding.workflowId,f.a.params.workflowBinding.workflowId);
});
async function variableFixture(t){const f=await fixture(t),template=await f.generation.saveTemplate({name:'逐轮字段',workflow:{'1':{class_type:'Example',inputs:{text:'base',steps:20,enabled:true,seed:5,style:'euler'}},'3':{class_type:'SaveImage',inputs:{images:['1',0]}}},fields:[{nodeId:'1',name:'steps',control:'slider',min:2,max:50,step:2,defaultValue:20},{nodeId:'1',name:'style',control:'select',options:['euler','dpmpp'],defaultValue:'euler'}]});f.a.params.workflowBinding={workflowId:template.id,overrides:[{nodeId:'1',name:'steps',value:8}],imageSources:[],incrementSeeds:false};f.loop.params.loop={mode:'repeat',count:2,fieldValues:[['text',['清晨\n远景','傍晚\n特写']],['steps',[10,30]],['enabled',[false,true]],['seed',[100,500]],['style',['euler','dpmpp']]].map(([name,values])=>({targetNodeId:f.a.id,nodeId:'1',name,values}))};return {...f,template};}
test('逐轮多字段同步覆盖文字/数字/开关/种子/下拉，保留原绑定及模板',async t=>{const f=await variableFixture(t),before=structuredClone(f.a.params.workflowBinding),j=await f.runner.start(f.project,{revision:0,consent:true,requestId:'loop-fields'},f.endpoint),done=await wait(f.data,j.id,j=>['completed','interrupted'].includes(j.status));assert.equal(done.status,'completed',done.message);assert.deepEqual(f.state.submitted[0].prompt['1'].inputs,{text:'清晨\n远景',steps:10,enabled:false,seed:100,style:'euler'});assert.deepEqual(f.state.submitted[2].prompt['1'].inputs,{text:'傍晚\n特写',steps:30,enabled:true,seed:500,style:'dpmpp'});assert.equal(done.steps[2].loopFields.find(f=>f.name==='seed').value,500);assert.deepEqual(f.a.params.workflowBinding,before);assert.equal((await f.generation.template(f.template.id)).workflow['1'].inputs.steps,20);});
test('逐轮变量类型/后轮约束/重复/范围/输入映射冲突均在零提交时拒绝',async t=>{const f=await variableFixture(t),check=async(mut,re)=>{const p=structuredClone(f.project);mut(p);await assert.rejects(f.runner.plan(p),re);assert.equal(f.state.submitted.length,0);};await check(p=>p.nodes[0].params.loop.fieldValues[1].values=[10,51],/范围/);await check(p=>p.nodes[0].params.loop.fieldValues[1].values=[10,'30'],/类型/);await check(p=>p.nodes[0].params.loop.fieldValues[1].values=[10],/数量/);await check(p=>p.nodes[0].params.loop.fieldValues.push(p.nodes[0].params.loop.fieldValues[0]),/重复/);await check(p=>p.nodes[0].params.loop.fieldValues[0].targetNodeId=p.nodes[1].id,/循环内/);await check(p=>p.nodes[2].params.workflowBinding.promptField={nodeId:'1',name:'text'},/冲突/);await check(p=>p.nodes[2].params.workflowBinding.incrementSeeds=true,/关闭/);await check(p=>p.nodes[0].params.loop.fieldValues[4].values=['euler','unknown'],/选项/);await check(p=>p.nodes[0].params.loop.fieldValues=[{targetNodeId:f.b.id,nodeId:'2',name:'image',values:['a.png','b.png']}],/媒体/);await f.generation.configure(f.template.id,{revision:0,fields:[...f.template.fields,{nodeId:'1',name:'text',control:'textarea',exposed:false,defaultValue:'hidden'}]});await assert.rejects(f.runner.plan(f.project),/隐藏/);assert.equal(f.state.submitted.length,0);});
test('整组复制重映射逐轮变量目标，完整备份恢复全部变量',async t=>{const f=await variableFixture(t),{copySelectedNodes}=await import('../lib/canvas-tools.mjs'),copy=copySelectedNodes(f.project,f.project.nodes.map(n=>n.id));const p=copy.project||copy;const copies=p.nodes.filter(n=>!f.project.nodes.some(x=>x.id===n.id)),l=copies.find(n=>n.type==='loop'),a=copies.find(n=>n.params?.workflowBinding?.workflowId===f.template.id);assert.equal(l.params.loop.fieldValues[0].targetNodeId,a.id);assert.equal((await f.runner.plan(p)).length,8);
 const {projectBundleService}=await import('../lib/project-bundles.mjs'),{createReadStream}=await import('node:fs'),bundles=projectBundleService({...f,projects:{load:async()=>f.project}}),out=await bundles.exportBundle(f.project.id,0),data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-loop-fields-import-')),activeJobs=new Map();let imported;const projects={load:async()=>{if(imported)return imported;throw Object.assign(Error('missing'),{status:404});},save:async p=>(imported=p)},target=projectBundleService({data,activeJobs,projects}),preview=await target.upload(createReadStream(await bundles.download(out.id))),restored=await target.importBundle(preview.id),generation=generationService({data,activeJobs}),runner=canvasRunner({data,activeJobs,generation});assert.deepEqual(restored.nodes.find(n=>n.type==='loop').params.loop.fieldValues,f.loop.params.loop.fieldValues);const plan=await runner.plan(restored);assert.equal(plan[2].overrides.find(f=>f.name==='steps').value,30);
});
