import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {promises as fs,createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {creationStudioService} from '../lib/creation-studio.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {makeProject,makeNode} from '../lib/model.mjs';
import {applyCanvasResults} from '../lib/generation-results.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';
import {generationService} from '../lib/generation.mjs';
import {atomicJson,readJson,storeAsset,userError} from '../lib/workspace.mjs';
import {safeApiCall} from '../lib/image-api.mjs';
import {midjourneyMask} from '../lib/midjourney.mjs';
import {MJ_MODES,normalizeMidjourneyConfig} from '../public/midjourney-core.js';

const KEY='synthetic-midjourney-test-key',magic=Buffer.from('JINGCHANG-PACK-1\n');
const image=createCanvas(2,1),ctx=image.getContext('2d');ctx.fillStyle='black';ctx.fillRect(0,0,1,1);ctx.fillStyle='white';ctx.fillRect(1,0,1,1);const png=image.toBuffer('image/png');
async function fixture(t){
 const requests=[],state={pending:false,modal:false,wrongId:false,conflictingId:false,unknown:false,fail:false,submitLost:false,grid:false,style:'raw',count:4};let num=0;
 const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);let body;try{body=JSON.parse(Buffer.concat(chunks));}catch{}
  requests.push({path:req.url,method:req.method,authorization:req.headers.authorization,body});res.setHeader('content-type','application/json');
  if(req.url.startsWith('/v1/midjourney/generations')&&req.method==='POST'){
   num++;if(state.submitLost)return res.destroy();const value={task_id:'owned-task-'+num,status:req.url.endsWith('/inpaint')?'modal':'submitted'};return res.end(JSON.stringify({code:200,data:[value]}));
  }
  if(req.url.startsWith('/v1/midjourney/')){
   const id=decodeURIComponent(req.url.slice('/v1/midjourney/'.length));
   const value={id:state.wrongId?'other-task':id,status:state.unknown?'unexpected':state.modal?'MODAL':state.fail?'FAILURE':state.pending?'IN_PROGRESS':'SUCCESS',progress:'37%',buttons:[{label:'U1',customId:'MJ::JOB::upsample::1::owned'},{label:KEY,customId:'bad'}]};
   if(state.conflictingId)value.task_id='contradicting-task';
   if(state.grid){value.image_urls=[];value.grid_image_url=base+'/out/grid.png';}else value.image_urls=Array.from({length:state.count},(_,i)=>base+'/out/'+i+'.png');
   return res.end(JSON.stringify(state.style==='array'?{code:200,data:[value]}:state.style==='object'?{code:200,data:value}:value));
  }
  if(req.url.startsWith('/out/')){res.setHeader('content-type','image/png');return res.end(png);}
  res.statusCode=404;res.end('{}');
 });server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;t.after(()=>new Promise(r=>server.close(r)));
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-midjourney-')),activeJobs=new Map();
 const projects={load:async id=>{try{return await readJson(path.join(data,'projects',id,'project.json'));}catch(e){if(e.code==='ENOENT')throw userError('项目不存在',404);throw e;}},save:async p=>{await atomicJson(path.join(data,'projects',p.id,'project.json'),p);return p;},create:async name=>projects.save(makeProject(name))},f={data,activeJobs,projects};const service=creationStudioService({...f,pollInterval:10}),a=await storeAsset(data,png,{name:'owned-mask.png',type:'image/png'});
 return{...f,service,base,requests,state,a};
}
async function create(f,mode='imagine',refs=[],config={},prompt='测试水彩湖面'){
 let s=await f.service.create({mode:'image'});return f.service.save(s.id,{...s,prompt,references:refs,config:{...s.config,protocol:'midjourney',model:'midjourney',baseUrl:f.base+'/v1',imageAsync:true,count:1,quality:'auto',transparent:false,mjMode:mode,mjTaskId:['imagine','blend','edit'].includes(mode)?'':'owned-parent',...config}});
}
function auth(f,s,id){return{revision:s.revision,requestId:id,apiKey:KEY,authorization:{origin:f.base,model:'midjourney',budget:2,currency:'CNY',sendPrompt:true,sendReferences:!!s.references.length,requestLimit:1}};}
async function done(f,id){for(let i=0;i<500;i++){const j=await readJson(path.join(f.data,'jobs',id+'.json'));if(!['queued','running'].includes(j.status)&&!f.activeJobs.has(id))return j;await new Promise(r=>setTimeout(r,10));}throw Error('owned task timeout');}
async function noSecret(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())await noSecret(file);else assert.equal((await fs.readFile(file)).includes(Buffer.from(KEY)),false,file);}}
test('Midjourney生成/融合/编辑：原文件、4份结果、按钮及重复点击去重',async t=>{
 const f=await fixture(t);
 for(const mode of ['imagine','blend','edit']){
  const s=await create(f,mode,mode==='blend'?[{assetId:f.a.id},{assetId:f.a.id}]:[{assetId:f.a.id}],{mjSize:'7:5'},mode==='blend'?'':'测试水彩湖面');
  const a=auth(f,s,mode),[x,y]=await Promise.all([f.service.start(s.id,a),f.service.start(s.id,{...a})]);assert.equal(x.id,y.id);const j=await done(f,x.id);
  assert.equal(j.status,'completed');assert.equal(j.assets.length,4);assert.deepEqual(j.mjButtons,[{label:'U1',customId:'MJ::JOB::upsample::1::owned'}]);
  const post=f.requests.find(r=>r.method==='POST'&&r.path==='/v1/midjourney/generations'+({imagine:'',blend:'/blend',edit:'/edits'}[mode]));assert.equal(post.authorization,'Bearer '+KEY);assert.equal(post.body.image_urls[0],'data:image/png;base64,'+png.toString('base64'));
  assert.equal(post.body.size,'7:5');assert.equal(post.body.speed,'relax');assert.equal(post.body.prompt,mode==='blend'?undefined:'测试水彩湖面');assert.equal(post.body.version,mode==='imagine'?'6.1':undefined);
 }
 assert.equal(f.requests.filter(r=>r.method==='POST').length,3);assert.ok(f.requests.filter(r=>r.path.startsWith('/out/')).every(r=>!r.authorization));await noSecret(f.data);
});
test('所有二次操作使用显式原任务编号和专用字段，单次请求不混入图片',async t=>{
 const f=await fixture(t);f.state.count=1;
 for(const mode of Object.keys(MJ_MODES).filter(k=>!['imagine','blend','edit','modal'].includes(k))){
  const s=await create(f,mode,[],{mjTaskId:'owned:parent.1',mjIndex:3,mjDirection:'down',mjZoom:1.5}),j=await f.service.start(s.id,auth(f,s,mode));const finished=await done(f,j.id);assert.equal(finished.status,mode==='inpaint'?'awaiting_input':'completed');
  const post=f.requests.filter(r=>r.method==='POST').at(-1);assert.equal(post.body.task_id,'owned:parent.1');assert.equal(post.body.image_urls,undefined);assert.equal(post.body.prompt,mode.startsWith('remix_')?'测试水彩湖面':undefined);
  assert.equal(post.body.zoom_ratio,mode==='zoom'?1.5:undefined);assert.equal(post.body.direction,mode==='pan'?'down':undefined);assert.equal(post.body.index,['reroll','inpaint'].includes(mode)?undefined:3);
 }
 for(const mode of ['upscale','pan','zoom']){
  const s=await create(f,mode,[],{mjCustomId:'MJ::JOB::owned-button',mjZoom:1.5},''),j=await f.service.start(s.id,auth(f,s,'custom-'+mode));assert.equal((await done(f,j.id)).status,'completed');const post=f.requests.filter(r=>r.method==='POST').at(-1);assert.equal(post.body.custom_id,'MJ::JOB::owned-button');assert.equal(post.body.index,undefined);assert.equal(post.body.direction,undefined);assert.equal(post.body.zoom_ratio,mode==='zoom'?1.5:undefined);
 }
 await noSecret(f.data);
});
test('局部重绘只等待补参；新的遮罩授权转白色重绘为透明区域',async t=>{
 const f=await fixture(t),s=await create(f,'inpaint',[],{},''),first=await f.service.start(s.id,auth(f,s,'region-first')),waiting=await done(f,first.id);
 assert.equal(waiting.status,'awaiting_input');assert.equal(waiting.assets.length,0);assert.equal(waiting.uncertain,false);assert.equal(f.requests.length,1);
 const next=await create(f,'modal',[{assetId:f.a.id}],{mjTaskId:waiting.upstreamId,mjMaskConvention:'white-edit'},'替换白色区域'),job=await f.service.start(next.id,auth(f,next,'region-modal'));assert.equal((await done(f,job.id)).status,'completed');assert.equal(f.requests.filter(r=>r.method==='POST').length,2);
 const body=f.requests.filter(r=>r.method==='POST').at(-1).body;assert.equal(body.task_id,waiting.upstreamId);assert.equal(body.prompt,'替换白色区域');const masked=await loadImage(Buffer.from(body.mask_url.split(',')[1],'base64')),c=createCanvas(2,1),cx=c.getContext('2d');cx.drawImage(masked,0,0);const pixels=cx.getImageData(0,0,2,1).data;assert.equal(pixels[3],255);assert.equal(pixels[7],0);
 assert.equal(await midjourneyMask({bytes:png,mime:'image/png'},'alpha'),'data:image/png;base64,'+png.toString('base64'));await noSecret(f.data);
});
test('停查、重启和更改连接后只恢复原任务；MODAL查询也立即结束等待',async t=>{
 const f=await fixture(t);f.state.pending=true;let s=await create(f),j=await f.service.start(s.id,auth(f,s,'resume-original'));
 for(let i=0;i<200&&!f.requests.some(r=>r.method==='GET');i++)await new Promise(r=>setTimeout(r,5));await f.service.cancel(s.id,j.id);await done(f,j.id);
 s=await f.service.save(s.id,{...s,config:{...s.config,baseUrl:'https://changed.invalid/v1'}});f.state.pending=false;f.state.style='object';const restart=creationStudioService({...f,pollInterval:10});await restart.resume(s.id,j.id,{apiKey:KEY});const recovered=await done(f,j.id);assert.equal(recovered.status,'completed');assert.equal(f.requests.filter(r=>r.method==='POST').length,1);assert.equal(recovered.input.studio.config.baseUrl,f.base+'/v1');
 f.state.modal=true;s=await create(f);j=await f.service.start(s.id,auth(f,s,'late-modal'));assert.equal((await done(f,j.id)).status,'awaiting_input');assert.equal(f.requests.filter(r=>r.method==='POST').length,2);await noSecret(f.data);
});
test('错误编号、未知状态、失败及断流不自动重发或保存其他任务结果',async t=>{
 const f=await fixture(t);for(const flag of ['wrongId','conflictingId','unknown','fail','submitLost']){
  f.state[flag]=true;const s=await create(f),b=auth(f,s,flag),j=await f.service.start(s.id,b),end=await done(f,j.id);assert.equal(end.status,'failed');assert.equal(end.assets.length,0);await f.service.start(s.id,auth(f,s,flag));f.state[flag]=false;
 }
 assert.equal(f.requests.filter(r=>r.method==='POST').length,5);assert.equal(f.requests.filter(r=>r.path.startsWith('/out/')).length,0);await noSecret(f.data);
});
test('模式、引用、预算及密钥来源错误都在创建任务和请求前拒绝',async t=>{
 const f=await fixture(t);
 for(const [mode,refs,c,prompt] of [['blend',[{assetId:f.a.id}],{},''],['edit',[],{},''],['modal',[],{},''],['upscale',[{assetId:f.a.id}],{},''],['imagine',[],{model:'wrong'},'测试'],['imagine',[],{count:4},'测试'],['imagine',[],{transparent:true},'测试']]){
  const s=await create(f,mode,refs,c,prompt);await assert.rejects(f.service.start(s.id,auth(f,s,s.id)));
 }
 const s=await create(f);let b=auth(f,s,'no-budget');b.authorization.budget=0;await assert.rejects(f.service.start(s.id,b));b=auth(f,s,'ark-wrong-source');b.apiKey='';b.credentialSource='ark-local';b.credentialConsent=true;await assert.rejects(f.service.start(s.id,b),/官方视频/);
 for(const c of [{mjMode:'__proto__'},{mjSize:'0:1'},{mjSize:'1/2'},{mjTaskId:'../escape'},{mjIndex:0},{mjZoom:1},{mjCustomId:'\nunsafe'}])assert.throws(()=>normalizeMidjourneyConfig(c));
 for(const q of ['midjourney/../escape','midjourney/id%2Foutside','midjourney/id%3Fkey','midjourney/id:raw'])await assert.rejects(safeApiCall({baseUrl:f.base+'/v1',apiKey:KEY,path:q}));
 await assert.rejects(safeApiCall({baseUrl:f.base+'/v1',apiKey:KEY,path:'midjourney/id%3A1',method:'POST'}));assert.equal(f.requests.length,0);assert.equal((await fs.readdir(path.join(f.data,'jobs')).catch(()=>[])).length,0);
});
test('画布本机生成、4图回填和v19跨空白工作区恢复绑定可继续规划',async t=>{
 const f=await fixture(t);let s=await create(f,'blend',[{assetId:f.a.id},{assetId:f.a.id}],{},'');let p=await f.projects.load(s.projectId);p.assets=[f.a];const n=makeNode('image',300,100,{text:'',params:{studioBinding:{mode:'image',config:s.config,includeUpstream:false,referenceSources:[{assetId:f.a.id}]}}});
 // Two different assets ensure the canvas's unique-input rule is preserved.
 const a2=await storeAsset(f.data,png,{name:'second.png',type:'image/png'});p.assets.push(a2);n.params.studioBinding.referenceSources.push({assetId:a2.id});p.nodes=[n];p.edges=[];await f.projects.save(p);
 const runner=canvasRunner({...f,generation:generationService(f),creationStudio:f.service,pollInterval:10}),plan=await runner.plan(p);assert.equal(plan.length,1);assert.equal(plan[0].text,'');
 const run=await runner.start(p,{revision:p.revision,consent:true,requestId:'owned-canvas',studioCredentials:[{nodeId:n.id,apiKey:KEY,authorization:{origin:f.base,model:'midjourney',requestLimit:1,budget:2,currency:'CNY',sendPrompt:true,sendReferences:true}}]}),finished=await done(f,run.id);assert.equal(finished.status,'completed',finished.message);assert.equal(finished.assets.length,4);const {project:applied}=await applyCanvasResults({data:f.data,project:p,job:finished,revision:p.revision});await f.projects.save(applied);assert.equal(applied.assets.length,6);assert.equal(applied.nodes[0].id,n.id);
 const bundles=projectBundleService(f),e=await bundles.exportBundle(p.id,applied.revision),file=await bundles.download(e.id),raw=await fs.readFile(file),len=raw.readUInt32BE(magic.length),manifest=JSON.parse(raw.subarray(magic.length+4,magic.length+4+len));assert.equal(manifest.version,19);
 const target=await fixture(t),targetBundles=projectBundleService(target),receipt=await targetBundles.upload(createReadStream(file)),restored=await targetBundles.importBundle(receipt.id);assert.equal(restored.nodes[0].params.studioBinding.config.mjMode,'blend');assert.equal(restored.assets.length,6);assert.notEqual(restored.nodes[0].params.studioBinding.referenceSources[0].assetId,f.a.id);assert.equal((await canvasRunner({...target,generation:generationService(target),creationStudio:target.service}).plan(restored)).length,1);
 manifest.version=18;const json=Buffer.from(JSON.stringify(manifest)),head=Buffer.alloc(4);head.writeUInt32BE(json.length);await assert.rejects(targetBundles.upload(Readable.from([Buffer.concat([magic,head,json,raw.subarray(magic.length+4+len)])])),/第19版/);await noSecret(f.data);await noSecret(target.data);
});
test('单图和旧式四宫格返回都可保存，原编号的冒号与点仅用于GET查询',async t=>{
 const f=await fixture(t);f.state.grid=true;f.state.style='array';const s=await create(f),j=await f.service.start(s.id,auth(f,s,'grid'));assert.equal((await done(f,j.id)).assets.length,1);
 const module=await import('../lib/midjourney.mjs');const r=await module.queryMidjourney({baseUrl:f.base+'/v1',apiKey:KEY,studio:s,upstreamId:'owned:id.1'});assert.equal(r.images.length,1);assert.ok(f.requests.some(r=>r.path==='/v1/midjourney/owned%3Aid.1'));await noSecret(f.data);
});
test('画布局部重绘等待补参时停止下游，显式恢复仅查原任务',async t=>{
 const f=await fixture(t),s=await create(f,'inpaint',[],{},''),p=await f.projects.load(s.projectId),first=makeNode('image',0,0,{text:'',params:{studioBinding:{mode:'image',config:s.config,includeUpstream:false,referenceSources:[]}}}),tail=makeNode('image',400,0,{text:'用重绘结果继续创作',params:{studioBinding:{mode:'image',config:{...s.config,mjMode:'imagine',mjTaskId:''},includeUpstream:false,referenceSources:[{sourceNodeId:first.id}]}}});
 p.nodes=[first,tail];p.edges=[{id:'mask-to-next',source:first.id,target:tail.id}];await f.projects.save(p);f.state.modal=true;
 const runner=canvasRunner({...f,generation:generationService(f),creationStudio:f.service,pollInterval:10}),steps=await runner.plan(p),credentials=steps.map(step=>({nodeId:step.nodeId,apiKey:KEY,authorization:{origin:f.base,model:'midjourney',requestLimit:1,budget:2,currency:'CNY',sendPrompt:true,sendReferences:step.sendAssets}}));
 const j=await runner.start(p,{revision:p.revision,requestId:'canvas-two-stage-mask',consent:true,studioCredentials:structuredClone(credentials)}),waiting=await done(f,j.id);assert.equal(waiting.status,'interrupted');assert.match(waiting.message,/等待重绘补参/);assert.equal(f.requests.filter(r=>r.method==='POST').length,1);assert.equal(waiting.assets.length,0);const childId=waiting.steps[0].jobId;
 await runner.resume(j.id,{consent:true,studioCredentials:structuredClone(credentials)});const stillWaiting=await done(f,j.id);assert.equal(stillWaiting.status,'interrupted');assert.equal(f.requests.filter(r=>r.method==='POST').length,1);assert.ok(f.requests.some(r=>r.path==='/v1/midjourney/owned-task-1'));
 // The owned upstream fixture now reports that manual supplementary work finished.
 f.state.modal=false;await runner.resume(j.id,{consent:true,studioCredentials:structuredClone(credentials)});const completed=await done(f,j.id);assert.equal(completed.status,'completed',completed.message);assert.equal(completed.steps[0].jobId,childId);assert.equal(completed.assets.length,8);assert.equal(f.requests.filter(r=>r.method==='POST').length,2);assert.equal(f.requests.filter(r=>r.path.endsWith('/inpaint')).length,1);assert.equal(f.requests.filter(r=>r.path.endsWith('/modal')).length,0);await noSecret(f.data);
});
