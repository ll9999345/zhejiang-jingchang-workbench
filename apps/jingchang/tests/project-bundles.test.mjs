import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {makeProject,makeNode} from '../lib/model.mjs';
import {atomicJson,readJson,storeAsset,records,userError} from '../lib/workspace.mjs';
import {generationService} from '../lib/generation.mjs';
import {creationStudioService} from '../lib/creation-studio.mjs';
import {cloudWorkflowService} from '../lib/cloud-workflows.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';
const magic=Buffer.from('JINGCHANG-PACK-1\n');
async function fixture(){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-bundle-')),activeJobs=new Map();
 const projects={load:async id=>{try{return await readJson(path.join(data,'projects',id,'project.json'));}catch(e){if(e.code==='ENOENT')throw userError('项目不存在',404);throw e;}},save:async p=>{await atomicJson(path.join(data,'projects',p.id,'project.json'),p);return p;}};
 const service=projectBundleService({data,activeJobs,projects});return{data,activeJobs,projects,service};
}
async function seeded(){
 const f=await fixture(),p=makeProject('完整备份验收'),a=await storeAsset(f.data,Buffer.from('reference-media'),{name:'图片.png',type:'image/png'}),audio=await storeAsset(f.data,Buffer.from('audio-data'),{name:'声音.wav',type:'audio/wav'});p.assets=[a,audio];p.nodes[0].assetId=a.id;p.nodes.push(makeNode('image',500,200,{text:'下游',params:{}}));p.edges=[{id:'edge-one',source:p.nodes[0].id,target:p.nodes[1].id}];p.shots=[{id:'shot-one',description:'分镜',duration:2,assetId:a.id,audioId:audio.id,sourceNodeId:p.nodes[0].id}];p.groups=[{id:'group-one',title:'分组',nodeIds:p.nodes.map(n=>n.id)}];p.messages=[{role:'user',content:'原有创作内容'}];p.runs=[{id:'old-run',jobId:'not-portable'}];await f.projects.save(p);
 const generation=generationService(f),w=await generation.saveTemplate({name:'测试工作流',workflow:{'1':{class_type:'LoadImage',inputs:{image:'original.png'}}}});p.nodes[1].params.workflowBinding={workflowId:w.id,overrides:[],imageSources:[{nodeId:'1',name:'image',assetId:a.id}],count:1,incrementSeeds:false};
 const rh=cloudWorkflowService(f);let r=await rh.create({projectId:p.id});r=await rh.save(r.id,{...r,targetId:'123456',fields:[{nodeId:'1',fieldName:'image',type:'image',source:'asset',assetId:a.id,fieldValue:''}]});p.nodes[0].params.cloudWorkflowId=r.id;await f.projects.save(p);
 const studios=creationStudioService(f);let studio=await studios.create({projectId:p.id,mode:'image'});studio=await studios.save(studio.id,{...studio,references:[{assetId:a.id}],prompt:'保留人物'});
 await atomicJson(path.join(f.data,'conversations','conversation-one.json'),{id:'conversation-one',projectId:p.id,name:'讨论镜头',revision:1,requests:[{requestId:'old',jobId:'oldjob'}],messages:[{id:'message-one',role:'user',text:'图里的构图',assetIds:[a.id],jobId:'oldjob'},{id:'partial-one',role:'assistant',text:'未完的镜头描述',assetIds:[],state:'incomplete',jobId:'oldjob'}]});return{...f,p,a,audio,w,r,studio};
}
async function rewrite(file,fn){const raw=await fs.readFile(file),length=raw.readUInt32BE(magic.length),m=JSON.parse(raw.subarray(magic.length+4,magic.length+4+length));fn(m);const json=Buffer.from(JSON.stringify(m)),head=Buffer.alloc(4);head.writeUInt32BE(json.length);return Buffer.concat([magic,head,json,raw.subarray(magic.length+4+length)]);}
async function counts(f){const count=async relative=>(await fs.readdir(path.join(f.data,relative)).catch(()=>[])).length;return Promise.all(['projects','assets','workflows','cloud-workflows','studios','conversations'].map(count));}
test('完整备份跨空白工作区恢复媒体、工作流、创作台、对话并可继续规划执行',async()=>{
 const source=await seeded(),exported=await source.service.exportBundle(source.p.id,0),file=await source.service.download(exported.id),target=await fixture(),preview=await target.service.upload(createReadStream(file));assert.equal(preview.assets,2);assert.equal(preview.workflows,1);assert.equal(preview.cloudWorkflows,1);assert.equal(preview.studios,1);assert.equal(preview.conversations,1);
 const [p,again]=await Promise.all([target.service.importBundle(preview.id),target.service.importBundle(preview.id)]);assert.equal(p.id,again.id);assert.notEqual(p.id,source.p.id);assert.equal(p.runs.length,0);assert.equal((await fs.readdir(path.join(target.data,'projects'))).length,1);assert.equal(p.nodes[0].id,source.p.nodes[0].id);assert.deepEqual(p.groups,source.p.groups);
 for(const original of [source.a,source.audio]){const restored=p.assets.find(a=>a.name===original.name);assert.notEqual(restored.id,original.id);assert.deepEqual(await fs.readFile(path.join(source.data,'assets',original.id)),await fs.readFile(path.join(target.data,'assets',restored.id)));}assert.equal(p.shots[0].audioId,p.assets.find(a=>a.type==='audio/wav').id);
 const generation=generationService(target),plan=await canvasRunner({...target,generation}).plan(p);assert.equal(plan.length,1);assert.notEqual(plan[0].workflowId,source.w.id);assert.equal(plan[0].imageSources[0].assetId,p.nodes[0].assetId);
 const rh=(await records(path.join(target.data,'cloud-workflows')))[0];assert.equal(rh.projectId,p.id);assert.equal(rh.fields[0].assetId,p.nodes[0].assetId);assert.equal(p.nodes[0].params.cloudWorkflowId,rh.id);
 const studios=creationStudioService(target),list=await studios.list(p.id),studio=await studios.get(list[0].id);assert.equal(studio.references[0].assetId,p.nodes[0].assetId);const c=(await records(path.join(target.data,'conversations')))[0];assert.equal(c.projectId,p.id);assert.equal(c.messages[0].assetIds[0],p.nodes[0].assetId);assert.deepEqual(c.requests,[]);assert.equal(c.messages[0].jobId,undefined);assert.equal(c.messages[1].state,'incomplete');assert.deepEqual(await source.projects.load(source.p.id),source.p);assert.equal(target.activeJobs.size,0);
});
test('完整备份损坏、截断、额外数据、路径及缺失引用均在创建项目或媒体前拒绝',async()=>{
 const s=await seeded(),e=await s.service.exportBundle(s.p.id,0),file=await s.service.download(e.id),raw=await fs.readFile(file),target=await fixture(),before=await counts(target),corrupt=Buffer.from(raw);corrupt[corrupt.length-1]^=255;
 for(const bytes of [corrupt,raw.subarray(0,raw.length-1),Buffer.concat([raw,Buffer.from('extra')]),await rewrite(file,m=>{m.assets[0].id='../escape';}),await rewrite(file,m=>{m.project.nodes[0].assetId='missing';}),await rewrite(file,m=>{m.workflows=[];})])await assert.rejects(target.service.upload(Readable.from([bytes])));
 assert.deepEqual(await counts(target),before);
});
test('完整备份拒绝凭据字段、重复编号、未知版本与不安全对象字段',async()=>{
 const s=await seeded(),e=await s.service.exportBundle(s.p.id,0),file=await s.service.download(e.id),target=await fixture();
 for(const change of [m=>{m.project.nodes[0].params.apiKey='not-to-be-saved';},m=>{m.assets.push(m.assets[0]);},m=>{m.version=999;},m=>{m.project=null;},m=>{m.assets=Array.from({length:4},(_,i)=>({...m.assets[0],id:'big-'+i,size:150*1024*1024}));},m=>{m.project.nodes[0].params.constructor={value:1};},m=>{m.project.nodes[0].params.cloudWorkflowId='unknown';}])await assert.rejects(target.service.upload(Readable.from([await rewrite(file,change)])));
 assert.deepEqual(await counts(target),[0,0,0,0,0,0]);assert.deepEqual(await fs.readdir(path.join(target.data,'bundles','imports')).catch(()=>[]),[]);
});
test('导出检查版本和运行任务，缺失素材拒绝；重复导入不改原项目和素材',async()=>{
 const f=await seeded();await assert.rejects(f.service.exportBundle(f.p.id,9),/已更新/);f.activeJobs.set('busy',{projectId:f.p.id});await assert.rejects(f.service.exportBundle(f.p.id,0),/任务运行/);f.activeJobs.clear();const before=await fs.readFile(path.join(f.data,'projects',f.p.id,'project.json')),e=await f.service.exportBundle(f.p.id,0),preview=await f.service.upload(createReadStream(await f.service.download(e.id)));await f.service.importBundle(preview.id);await f.service.importBundle(preview.id);assert.deepEqual(await fs.readFile(path.join(f.data,'projects',f.p.id,'project.json')),before);
 const p=await f.projects.load(f.p.id);p.assets.push({id:'missing-file',name:'missing.png',type:'image/png'});await f.projects.save(p);await assert.rejects(f.service.exportBundle(p.id,0),/缺少/);
});
test('导出不跟随素材符号链接，导入中断后重复确认不重复项目',async()=>{
 const f=await fixture(),p=makeProject('链接检查');await fs.mkdir(path.join(f.data,'assets'),{recursive:true});const outside=path.join(f.data,'outside.png');await fs.writeFile(outside,'hello');await fs.symlink(outside,path.join(f.data,'assets','linked'));const meta={id:'linked',name:'linked.png',type:'image/png',size:5};await atomicJson(path.join(f.data,'assets','linked.json'),meta);p.assets=[meta];await f.projects.save(p);await assert.rejects(f.service.exportBundle(p.id,0),/无法读取/);
 const source=await seeded(),target=await fixture(),e=await source.service.exportBundle(source.p.id,0),preview=await target.service.upload(createReadStream(await source.service.download(e.id)));const save=target.projects.save;let fail=true;target.projects.save=async p=>{await save(p);if(fail){fail=false;throw Error('simulated interruption after project save');}return p;};await assert.rejects(target.service.importBundle(preview.id),/simulated/);const recovered=await target.service.importBundle(preview.id);assert.equal((await fs.readdir(path.join(target.data,'projects'))).length,1);assert.equal(recovered.assets.length,2);
});

test('备份上传支持任意网络分片，并在确认导入时重新校验',async()=>{
 const s=await seeded(),e=await s.service.exportBundle(s.p.id,0),raw=await fs.readFile(await s.service.download(e.id)),t=await fixture();const chunks=[];for(let i=0;i<raw.length;i+=17)chunks.push(raw.subarray(i,i+17));const preview=await t.service.upload(Readable.from(chunks));const file=path.join(t.data,'bundles','imports',preview.id,'project.jingchang'),bytes=await fs.readFile(file);bytes[bytes.length-1]^=255;await fs.writeFile(file,bytes);await assert.rejects(t.service.importBundle(preview.id),/校验失败/);assert.deepEqual(await counts(t),[0,0,0,0,0,0]);
});
