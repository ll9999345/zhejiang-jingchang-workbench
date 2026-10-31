import './helpers/local-network-only.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {normalizeNativeWorkflow,nativeToFragment} from '../lib/native-canvas-core.mjs';
import {nativeExecutionMedia} from '../lib/native-flow-execution.mjs';
import {generationService} from '../lib/generation.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';
import {storeAsset,readJson} from '../lib/workspace.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
const mp4=Buffer.from('000000186674797069736f6d0000020069736f6d69736f32','hex');
const raw=(id,type,extra={})=>({id,type,x:0,y:0,...extra});
async function fixture(t){
 const state={submissions:[],uploads:[]},mock=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);res.setHeader('content-type','application/json');
  if(req.url==='/prompt'){state.submissions.push(JSON.parse(bytes));return res.end(JSON.stringify({prompt_id:'mixed-'+state.submissions.length}));}
  if(req.url==='/upload/image'){state.uploads.push(bytes);return res.end(JSON.stringify({name:'mixed-input.mp4',subfolder:'',type:'input'}));}
  if(req.url.startsWith('/history/')){const id=req.url.split('/').at(-1),first=id==='mixed-1';return res.end(JSON.stringify({[id]:{status:{completed:true,status_str:'success'},outputs:{out:{[first?'images':'videos']:[{filename:id+(first?'.png':'.mp4'),type:'output',subfolder:''}]}}}}));}
  if(req.url.startsWith('/view')){const video=new URL(req.url,'http://127.0.0.1').searchParams.get('filename')?.endsWith('.mp4');res.setHeader('content-type',video?'video/mp4':'image/png');return res.end(video?mp4:png);}
  res.statusCode=404;res.end('{}');
 });
 mock.listen(0,'127.0.0.1');await once(mock,'listening');t.after(()=>{mock.closeAllConnections();return new Promise(resolve=>mock.close(resolve));});
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-native-comfy-mixed-')),activeJobs=new Map(),generation=generationService({data,activeJobs}),runner=canvasRunner({data,activeJobs,generation,pollInterval:10});
 const video=await storeAsset(data,mp4,{name:'本机合成视频头.mp4',type:'video/mp4'}),resources=[{url:'/fixture/video',archive:'resources/video.mp4',portableUrl:video.url,asset:video}];
 const project=nativeToFragment(normalizeNativeWorkflow({format:'infinite-smart-canvas-workflow',version:1,nodes:[raw('v','smart-image',{images:[{url:'/fixture/video'}]}),raw('g','comfy',{text:'本机生成图'}),raw('group','smart-group',{items:['v','g']}),raw('sink','comfy',{text:'处理指定视频'})],connections:[{from:'group',to:'sink'}]}),resources,'混合组单字段专项');
 const node=id=>project.nodes.find(n=>n.params.nativeCanvas.node.id===id);
 const upstream=await generation.saveTemplate({name:'合成图输出',workflow:{'1':{class_type:'SyntheticImage',inputs:{text:'fixture'}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}}}});
 const downstream=await generation.saveTemplate({name:'视频单字段',workflow:{'1':{class_type:'LoadVideo',inputs:{file:'old.mp4'}},'2':{class_type:'SaveVideo',inputs:{video:['1',0]}}}});
 node('g').params.nativeCanvas.adaptation='configured';node('g').params.workflowBinding={workflowId:upstream.id,overrides:[],imageSources:[],count:1};
 node('sink').type='video';node('sink').params.nativeCanvas.adaptation='configured';node('sink').params.workflowBinding={workflowId:downstream.id,overrides:[],imageSources:[{nodeId:'1',name:'file',sourceNodeId:node('group').id,sourceIndex:0}],count:1};
 return{data,state,activeJobs,generation,runner,project,node,video,downstream,endpoint:'http://127.0.0.1:'+mock.address().port};
}
async function finish(f,id){for(let i=0;i<500;i++){const job=await readJson(path.join(f.data,'jobs',id+'.json'));if(!['queued','running'].includes(job.status)&&!f.activeJobs.size)return job;await delay(10);}throw Error('本机混合组回归等待超时');}

test('混合组的静态视频在待生成图片旁仍可规划，序号0执行准确上传视频',async t=>{
 const f=await fixture(t),before=structuredClone(f.project),value=nativeExecutionMedia(f.project,f.node('group').id,{execution:true});
 assert.deepEqual(value.media.map(item=>item.kind),['video']);assert.deepEqual(value.pendingNodeIds,[f.node('g').id]);
 const steps=await f.runner.plan(f.project);assert.deepEqual(steps.map(step=>step.nodeId),[f.node('g').id,f.node('sink').id]);assert.equal(steps[1].imageSources[0].sourceIndex,0);assert.equal(f.state.submissions.length,0);
 const started=await f.runner.start(f.project,{revision:0,requestId:'mixed-video-index-zero',consent:true},f.endpoint),done=await finish(f,started.id);
 assert.equal(done.status,'completed',done.message);assert.equal(f.state.submissions.length,2);assert.equal(f.state.uploads.length,1);assert.ok(f.state.uploads[0].includes(mp4));assert.equal(f.state.submissions[1].prompt['1'].inputs.file,'mixed-input.mp4');
 const child=await readJson(path.join(f.data,'jobs',done.steps[1].jobId+'.json'));assert.deepEqual(child.imageBindings.map(ref=>ref.assetId),[f.video.id]);assert.deepEqual(f.project,before);
});

test('混合组没有兼容类型或序号格式非法仍在任何发送前拒绝',async t=>{
 const f=await fixture(t),binding=f.node('sink').params.workflowBinding;
 for(const sourceIndex of [-1,1000,1.5]){binding.imageSources[0].sourceIndex=sourceIndex;await assert.rejects(f.runner.plan(f.project),/序号|整数/);}
 binding.imageSources[0].sourceIndex=0;
 await f.generation.configure(f.downstream.id,{revision:0,fields:[{nodeId:'1',name:'file',mediaKind:'audio',control:'text',exposed:true}]});
 await assert.rejects(f.runner.plan(f.project),/类型不匹配/);assert.equal(f.state.submissions.length,0);assert.equal(f.state.uploads.length,0);
});

test('实际结果重新核对类型、越界和未明确序号，下游零上传零提交',async t=>{
 for(const [label,sourceIndex,error] of [['错误类型',1,/类型.*输入字段不符/],['越界',9,/序号不存在/],['未选择',undefined,/明确选择/]])await t.test(label,async t=>{
  const f=await fixture(t),mapping=f.node('sink').params.workflowBinding.imageSources[0];if(sourceIndex===undefined)delete mapping.sourceIndex;else mapping.sourceIndex=sourceIndex;
  await f.runner.plan(f.project);const started=await f.runner.start(f.project,{revision:0,requestId:'mixed-runtime-guard',consent:true},f.endpoint),done=await finish(f,started.id);
  assert.equal(done.status,'interrupted');assert.match(done.message,error);assert.equal(done.steps[0].status,'completed');assert.equal(done.assets.length,1);assert.equal(done.assets[0].type,'image/png');assert.equal(f.state.submissions.length,1);assert.equal(f.state.uploads.length,0);assert.equal(done.steps[1].jobId,undefined);
 });
});
