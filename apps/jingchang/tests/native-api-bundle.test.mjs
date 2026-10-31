import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {nativeToFragment,normalizeNativeWorkflow} from '../lib/native-canvas-core.mjs';
import {nativeReferencePlan} from '../lib/native-flow-execution.mjs';
import {makeNode,validateProject} from '../lib/model.mjs';
import {atomicJson,readJson,storeAsset,userError} from '../lib/workspace.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {generationService} from '../lib/generation.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
const magic=Buffer.from('JINGCHANG-PACK-1\n');
async function workspace(){
 const data=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'jc-native-api-bundle-'))),activeJobs=new Map();
 let projectWrites=0;
 const projects={
  load:async id=>{try{return await readJson(path.join(data,'projects',id,'project.json'));}catch(e){if(e.code==='ENOENT')throw userError('项目不存在',404);throw e;}},
  save:async p=>{projectWrites++;await atomicJson(path.join(data,'projects',p.id,'project.json'),p);return p;}
 };
 return {data,activeJobs,projects,service:projectBundleService({data,activeJobs,projects}),writes:()=>projectWrites};
}
async function fixture(kind='image'){
 const f=await workspace(),a=await storeAsset(f.data,png,{name:'first.png',type:'image/png'}),b=await storeAsset(f.data,png,{name:'second.png',type:'image/png'});
 const raw=(id,type,extra={})=>({id,type,x:0,y:0,...extra});
 const doc=normalizeNativeWorkflow({nodes:[raw('group','group',{items:['second','first','words']}),raw('first','image',{url:'/source/a'}),raw('second','image',{url:'/source/b'}),raw('words','prompt',{text:'组内说明'})],connections:[]});
 const p=nativeToFragment(doc,[{url:'/source/a',portableUrl:a.url,archive:'resources/a.png',asset:a},{url:'/source/b',portableUrl:b.url,archive:'resources/b.png',asset:b}],'原生整组接口备份');
 const group=p.nodes.find(n=>n.params.nativeCanvas.node.id==='group'),node=makeNode(kind==='llm'?'script':'image',500,0,{text:'根据参考继续创作'});
 const category=kind==='llm'?'chat':'image',model=category==='chat'?'local-chat':'local-image';
 const platform={id:'synthetic-platform',name:'本机协议配置',protocol:'openai-compatible',baseUrl:'http://127.0.0.1:1/v1',models:[{id:model,category,referenceSupport:true}]};
 if(kind==='studio')node.params.studioBinding={mode:'image',config:{protocol:'studio',baseUrl:platform.baseUrl,model},referenceSources:[{sourceNodeId:group.id}]};
 else node.params[kind==='llm'?'llmBinding':'imageBinding']={platform,model,referenceSources:[{sourceNodeId:group.id}]};
 p.nodes.push(node);p.edges.push({id:'group-to-api',source:group.id,target:node.id});
 p.runs=[{id:'old-run',authorization:{origin:'http://127.0.0.1:1',budget:1,currency:'CNY',requestLimit:1,sendPrompt:true,sendReferences:true}}];
 await f.projects.save(p);return {...f,p,node,group,a,b};
}
function manifest(raw){const size=raw.readUInt32BE(magic.length);return JSON.parse(raw.subarray(magic.length+4,magic.length+4+size));}
function rewrite(raw,change){const size=raw.readUInt32BE(magic.length),m=manifest(raw);change(m);const json=Buffer.from(JSON.stringify(m)),length=Buffer.alloc(4);length.writeUInt32BE(json.length);return Buffer.concat([magic,length,json,raw.subarray(magic.length+4+size)]);}
async function entryCount(data,dir){return(await fs.readdir(path.join(data,dir)).catch(()=>[])).length;}
function planner(f){const never=()=>{throw Error('备份验证禁止提交任何模型任务');};return canvasRunner({...f,generation:generationService(f),directImages:{startFromCanvas:never},canvasLlm:{startFromCanvas:never},creationStudio:{startFromCanvas:never}});}

test('原生分组接入图片、语言模型和创作接口使用v28，恢复映射及整组计划且不恢复执行授权',async()=>{
 for(const kind of ['image','llm','studio']){
  const s=await fixture(kind),before=await fs.readFile(path.join(s.data,'projects',s.p.id,'project.json')),exported=await s.service.exportBundle(s.p.id,0);
  assert.equal(exported.formatVersion,28);
  const bytes=await fs.readFile(await s.service.download(exported.id)),m=manifest(bytes);assert.equal(m.version,28);assert.deepEqual(m.project.runs,[]);
  const t=await workspace(),preview=await t.service.upload(Readable.from([bytes])),restored=await t.service.importBundle(preview.id),node=restored.nodes.find(n=>n.id===s.node.id);
  const binding=node.params[kind==='image'?'imageBinding':kind==='llm'?'llmBinding':'studioBinding'];
  assert.deepEqual(binding.referenceSources,[{sourceNodeId:s.group.id}]);
  assert.deepEqual(nativeReferencePlan(restored,node,binding.referenceSources,{planning:true,consumer:kind==='llm'?'llm':'generator'}).references.map(r=>restored.assets.find(a=>a.id===r.assetId)?.name),['second.png','first.png']);
  const plan=await planner(t).plan(restored);assert.equal(plan.length,1);assert.match(plan[0].text,/组内说明/);assert.equal(plan[0].sendAssets,true);
  assert.equal(plan[0].authorization,undefined);assert.deepEqual(restored.runs,[]);assert.equal(await entryCount(t.data,'jobs'),0);assert.equal(t.activeJobs.size,0);
  assert.equal(JSON.stringify(restored).includes('authorization'),false);assert.equal(t.writes(),1);validateProject(restored);
  assert.deepEqual(await fs.readFile(path.join(s.data,'projects',s.p.id,'project.json')),before);
 }
});

test('v28整组接口备份降级到v27在写入项目、媒体或导入包前拒绝',async()=>{
 const s=await fixture(),exported=await s.service.exportBundle(s.p.id,0),bytes=await fs.readFile(await s.service.download(exported.id)),t=await workspace();
 for(const version of [27,26,23,1])await assert.rejects(t.service.upload(Readable.from([rewrite(bytes,m=>m.version=version)])),/第28版备份格式/);
 assert.equal(t.writes(),0);
 for(const dir of ['projects','assets','jobs','bundles/imports'])assert.equal(await entryCount(t.data,dir),0,dir);
});

test('原生中间子图导出同样使用v28并能恢复完整分组引用',async()=>{
 const s=await fixture(),records=[];await fs.mkdir(path.join(s.data,'native-canvas','prepared'),{recursive:true});
 for(const asset of s.p.assets){const bytes=await fs.readFile(path.join(s.data,'assets',asset.id)),file=path.join(s.data,'native-canvas','prepared',asset.id);await fs.writeFile(file,bytes,{flag:'wx'});records.push({asset,file,sha256:createHash('sha256').update(bytes).digest('hex')});}
 const prepared=structuredClone(s.p);prepared.runs=[];
 const exported=await s.service.exportPreparedFragment(prepared,records);assert.equal(exported.formatVersion,28);assert.equal(exported.canvasFragment,true);
 const t=await workspace(),preview=await t.service.upload(createReadStream(await s.service.download(exported.id))),restored=await t.service.importBundle(preview.id),plan=await planner(t).plan(restored);
 assert.equal(plan.length,1);assert.deepEqual(plan[0].image.referenceSources,[{sourceNodeId:s.group.id}]);assert.equal(plan[0].authorization,undefined);
});

test('无原生整组输入的普通图片绑定和仅输出缓存不强制升级到v28',async()=>{
 const s=await fixture();s.p.edges=[];s.node.params.imageBinding.referenceSources=[];await s.projects.save(s.p);
 assert.equal((await s.service.exportBundle(s.p.id,0)).formatVersion,23);
 const native=s.p.nodes.find(n=>n.params?.nativeCanvas?.node.id==='first');native.params.nativeCanvas.node.type='generator';native.params.nativeCanvas.adaptation='configured';native.params.imageBinding=structuredClone(s.node.params.imageBinding);native.params.nativeCanvas.mediaAssetIds=[s.a.id,s.b.id];
 await s.projects.save(s.p);assert.equal((await s.service.exportBundle(s.p.id,0)).formatVersion,23);
});
