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
import {applyCanvasResults} from '../lib/generation-results.mjs';
import {readJson} from '../lib/workspace.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
async function fixture(t){
 const state={submitted:[],uploads:0,failed:false,pending:false};
 const mock=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);res.setHeader('content-type','application/json');
  if(req.url==='/prompt'){state.submitted.push(JSON.parse(Buffer.concat(chunks)));return res.end(JSON.stringify({prompt_id:'p-'+state.submitted.length}));}
  if(req.url==='/upload/image'){state.uploads++;return res.end(JSON.stringify({name:'upstream.png',subfolder:'',type:'input'}));}
  if(req.url.startsWith('/history/')){if(state.pending)return res.end('{}');const id=req.url.split('/').at(-1);return res.end(JSON.stringify({[id]:{status:{completed:!state.failed,status_str:state.failed?'error':'success'},outputs:state.failed?{}:{'3':{images:[{filename:'out.png',type:'output',subfolder:''}]}}}}));}
  if(req.url.startsWith('/view')){res.setHeader('content-type','image/png');return res.end(png);}res.statusCode=404;res.end('{}');
 });mock.listen(0,'127.0.0.1');await once(mock,'listening');t.after(()=>new Promise(r=>mock.close(r)));
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-graph-')),activeJobs=new Map(),generation=generationService({data,activeJobs}),runner=canvasRunner({data,activeJobs,generation,pollInterval:10});
 const source=await generation.saveTemplate({name:'第一步',workflow:{'1':{class_type:'Text',inputs:{text:'original'}},'3':{class_type:'SaveImage',inputs:{images:['1',0]}}}}),next=await generation.saveTemplate({name:'第二步',workflow:{'1':{class_type:'Text',inputs:{text:'original'}},'2':{class_type:'LoadImage',inputs:{image:'none.png'}},'3':{class_type:'SaveImage',inputs:{images:['2',0]}}}});
 const project=makeProject('流水线'),script=makeNode('script',0,0,{text:'故事背景'}),a=project.nodes[0],b=makeNode('image',350,0,{text:'后续镜头'});a.text='第一镜头';project.nodes=[script,a,b];project.edges=[{id:'edge-1',source:script.id,target:a.id},{id:'edge-2',source:a.id,target:b.id}];
 a.params.workflowBinding={workflowId:source.id,overrides:[],imageSources:[],promptField:{nodeId:'1',name:'text'}};
 b.params.workflowBinding={workflowId:next.id,overrides:[],imageSources:[{nodeId:'2',name:'image',sourceNodeId:a.id}],promptField:{nodeId:'1',name:'text'}};
 return {data,activeJobs,generation,runner,state,project,endpoint:'http://127.0.0.1:'+mock.address().port};
}
async function wait(data,id,fn){for(let i=0;i<500;i++){const job=await readJson(path.join(data,'jobs',id+'.json'));if(fn(job))return job;await new Promise(r=>setTimeout(r,10));}throw new Error('timeout');}
test('画布按依赖顺序执行、传递文本与生成图片、重复请求不重跑',async t=>{
 const {data,runner,state,project,endpoint}=await fixture(t),body={requestId:'run-1',revision:0,consent:true};
 const job=await runner.start(project,body,endpoint),done=await wait(data,job.id,j=>j.status==='completed'||j.status==='interrupted');assert.equal(done.status,'completed',done.message);
 assert.equal(state.submitted.length,2);assert.equal(state.uploads,1);assert.equal(state.submitted[0].prompt['1'].inputs.text,'故事背景\n\n第一镜头');assert.equal(state.submitted[1].prompt['1'].inputs.text,'故事背景\n\n第一镜头\n\n后续镜头');assert.equal(state.submitted[1].prompt['2'].inputs.image,'upstream.png');assert.equal(done.assets.length,2);assert.equal(project.assets.length,0);assert.deepEqual(done.assets[1].referenceAssetIds,[done.assets[0].id]);
 const applied=await applyCanvasResults({data,project,job:done,revision:project.revision});assert.deepEqual(applied.project.runs.at(-1).assetIds,done.assets.map(a=>a.id));assert.deepEqual(applied.project.runs.at(-1).assetReferences,[{assetId:done.assets[1].id,referenceAssetIds:[done.assets[0].id]}]);
 assert.equal((await runner.start(project,body,endpoint)).id,job.id);assert.equal(state.submitted.length,2);
});
test('上游失败停止后续；非法映射在执行前被拒绝',async t=>{
 const {data,runner,state,project,endpoint}=await fixture(t);const bad=structuredClone(project);bad.nodes[2].params.workflowBinding.imageSources[0].sourceNodeId=bad.nodes[2].id;
 await assert.rejects(runner.plan(bad),/上游/);assert.equal(state.submitted.length,0);
 state.failed=true;const job=await runner.start(project,{requestId:'failed-run',revision:0,consent:true},endpoint);await wait(data,job.id,j=>j.status==='interrupted');assert.equal(state.submitted.length,1);assert.equal(state.uploads,0);
});
test('取消后恢复原子任务编号，再执行剩余节点，不重复提交上游',async t=>{
 const {data,runner,state,project,endpoint,activeJobs}=await fixture(t);state.pending=true;
 const job=await runner.start(project,{requestId:'cancelled-run',revision:0,consent:true},endpoint);
 await wait(data,job.id,j=>!!j.steps[0].jobId);await new Promise(r=>setTimeout(r,40));activeJobs.get(job.id).controller.abort();await wait(data,job.id,j=>j.status==='cancelled');
 for(let i=0;i<100&&activeJobs.size;i++)await new Promise(r=>setTimeout(r,10));assert.equal(activeJobs.size,0);state.pending=false;await runner.resume(job.id);
 const done=await wait(data,job.id,j=>j.status==='completed'||j.status==='interrupted');assert.equal(done.status,'completed',done.message);assert.equal(state.submitted.length,2);assert.equal(state.uploads,1);
});
