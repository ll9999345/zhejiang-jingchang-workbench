import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {spawn} from 'node:child_process';
import {makeProject,makeNode,validateProject} from '../lib/model.mjs';
import {atomicJson,readJson,userError,storeAsset} from '../lib/workspace.mjs';
import {assetCatalogService} from '../lib/asset-catalog.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';
import {nativeCanvasService} from '../lib/native-canvas.mjs';
import {readNativeArchive} from '../lib/native-canvas-archive.mjs';
import {writeNativeZip} from '../lib/native-canvas-export.mjs';
import {normalizeNativeWorkflow,nativeToFragment,fragmentToNative} from '../lib/native-canvas-core.mjs';
import {selectCanvasFragment,fragmentMaps,mergeCanvasFragment} from '../lib/canvas-fragments.mjs';
import {nativeNodeIssues} from '../public/native-canvas-core.js';
import {canvasRunner} from '../lib/canvas-runner.mjs';
import {generationService} from '../lib/generation.mjs';
import {applyCanvasResults,captureNativeResultTargets} from '../lib/generation-results.mjs';
import {directImageService} from '../lib/direct-images.mjs';
import {copySelectedNodes,removeSelectedNodes,removeConnection} from '../lib/canvas-tools.mjs';

const root=path.join(process.cwd(),'artifacts','native-canvas-unit-'+Date.now());await fs.mkdir(root,{recursive:true});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
const wav=Buffer.alloc(46);wav.write('RIFF',0);wav.writeUInt32LE(38,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(2,40);
const sha=b=>createHash('sha256').update(b).digest('hex'),jsonStream=v=>Readable.from([Buffer.from(JSON.stringify(v))]);
const baseDocument=()=>({format:'infinite-canvas-workflow',version:1,customHeader:{edition:'固定参考版本'},nodes:[{id:'prompt-1',type:'prompt',x:-50,y:80,text:'蓝色背景与暖色主体',custom:{keep:true}},{id:'media-1',type:'image',x:300,y:80,url:'/assets/input/原图.png',name:'原图'}],connections:[{id:'edge-1',from:'prompt-1',to:'media-1',custom:'retain'}],resources:[{url:'/assets/input/原图.png',archive:'resources/原图.png',name:'原图.png',size:png.length}]});
async function fixture(){
 const data=path.join(root,randomUUID());await fs.mkdir(data);const activeJobs=new Map(),projects={load:async id=>{try{return await readJson(path.join(data,'projects',id,'project.json'));}catch(e){if(e.code==='ENOENT')throw userError('项目不存在',404);throw e;}},save:async p=>{await atomicJson(path.join(data,'projects',p.id,'project.json'),p);return p;}};
 const target=makeProject('原有目标项目');target.nodes=[makeNode('text',80,150,{text:'原文保留'})];target.messages=[{role:'user',text:'原消息保留'}];await projects.save(target);let bundles;
 const catalog=assetCatalogService({data,activeJobs,projects,bundles:{download:(...args)=>bundles.download(...args),upload:(...args)=>bundles.upload(...args),import:(...args)=>bundles.importBundle(...args),insert:(...args)=>bundles.insertBundle(...args),package:(...args)=>bundles.libraryPackage(...args),export:(...args)=>bundles.exportBundle(...args),nativeSourceFromExport:(...args)=>bundles.nativeSourceFromExport(...args)}});bundles=projectBundleService({data,activeJobs,projects,assetCatalog:catalog});
 const service=nativeCanvasService({data,bundles,catalog}),generation=generationService({data,activeJobs});return {data,activeJobs,projects,target,bundles,catalog,service,generation};
}
async function zipFixture(f,document=baseDocument(),bytes=[png],options={}){
 const dir=path.join(f.data,'fixture-'+randomUUID());await fs.mkdir(dir);const files=[];for(const [i,b]of bytes.entries()){const file=path.join(dir,'source-'+i);await fs.writeFile(file,b);files.push(file);}
 const zip=path.join(dir,'source.zip');
 if(options.python){const code="import sys,json,zipfile,base64\nx=json.load(sys.stdin)\nwith zipfile.ZipFile(x['file'],'w',compression=zipfile.ZIP_DEFLATED,allowZip64=True) as z:\n for i,r in enumerate(x['document']['resources']):\n  if x.get('force64'):\n   with z.open(r['archive'],'w',force_zip64=True) as w: w.write(base64.b64decode(x['bytes'][i]))\n  else: z.writestr(r['archive'],base64.b64decode(x['bytes'][i]))\n z.writestr('workflow.json',json.dumps(x['document'],ensure_ascii=False).encode('utf-8'))\n";await new Promise((resolve,reject)=>{const child=spawn('python3',['-c',code],{stdio:['pipe','ignore','pipe']});let error='';child.stderr.on('data',c=>error+=c);child.once('error',reject);child.once('exit',exit=>exit?reject(Error('Python ZIP fixture failed: '+error)):resolve());child.stdin.end(JSON.stringify({file:zip,document,bytes:bytes.map(b=>b.toString('base64')),force64:options.force64}));});}
 else await writeNativeZip(zip,document,document.resources.map((r,i)=>({id:'test-'+i,name:r.name,type:i?'audio/wav':'image/png',size:bytes[i].length,sha256:sha(bytes[i])})),files.map(file=>({file})));
 return zip;
}
async function inspectFile(f,file,requestId=randomUUID(),name='原生工作流'){return f.service.inspect(createReadStream(file),{requestId,name});}
async function savePreview(f,preview){return f.service.save(preview.id,{requestId:preview.id,revision:(await f.catalog.read()).revision,libraryId:'default',folderId:'workflows',name:preview.name});}

test('固定参考的 Deflate ZIP 接收真实资源，预览不创建项目、素材库条目或生成任务',async()=>{
 const f=await fixture(),file=await zipFixture(f,baseDocument(),[png],{python:true}),original=await fs.readFile(path.join(f.data,'projects',f.target.id,'project.json')),preview=await inspectFile(f,file);
 assert.equal(preview.nodes,2);assert.equal(preview.edges,1);assert.equal(preview.assets,1);assert.equal(preview.pendingNodes,0);assert.equal(preview.sourceFormat,'infinite-canvas-workflow');assert.equal((await f.catalog.read()).revision,0);assert.equal((await fs.readdir(path.join(f.data,'projects'))).length,1);assert.equal(f.activeJobs.size,0);assert.deepEqual(await fs.readFile(path.join(f.data,'projects',f.target.id,'project.json')),original);
 assert.deepEqual(await f.service.get(preview.id),preview);assert.equal((await f.service.list()).length,1);
 const source=await f.bundles.nativeSourceFromExport(preview.exported.id);assert.equal(source.project.nodes[0].params.nativeCanvas.node.custom.keep,true);assert.equal(source.project.nodes[0].params.nativeCanvas.header.customHeader.edition,'固定参考版本');assert.equal(source.assets[0].sha256,sha(png));
});
test('保存后可插入已有项目，所有节点、连线、素材映射独立，原文本与消息保留',async()=>{
 const f=await fixture(),preview=await inspectFile(f,await zipFixture(f)),saved=await savePreview(f,preview),payload={requestId:randomUUID(),projectId:f.target.id,revision:0,x:700,y:120},result=await f.catalog.insertCanvas(saved.item.id,payload),p=result.project;
 assert.equal(saved.item.summary.formatVersion,23);assert.equal(p.nodes.length,3);assert.equal(p.edges.length,1);assert.equal(p.messages[0].text,'原消息保留');assert.equal(p.nodes[0].text,'原文保留');const nodes=p.nodes.slice(1);assert.equal(nodes[0].x,700);assert.equal(nodes[0].y,120);assert.notEqual(nodes[1].id,'media-1');assert.equal(nodes[1].assetId,nodes[1].params.nativeCanvas.mediaAssetIds[0]);assert.equal(nodes[1].assetId,nodes[1].params.nativeCanvas.resources[0].assetId);assert.equal(p.edges[0].source,nodes[0].id);assert.equal(p.edges[0].target,nodes[1].id);assert.deepEqual(await fs.readFile(path.join(f.data,'assets',nodes[1].assetId)),png);validateProject(p);
 const again=await f.catalog.insertCanvas(saved.item.id,{...payload,revision:1});assert.equal(again.alreadyInserted,true);assert.deepEqual(again.nodeIds,result.nodeIds);assert.equal(again.project.nodes.length,3);
});
test('原生 ZIP 导出再导入保留未知字段、连接附加参数及媒体原字节，不读取外部文件',async()=>{
 const f=await fixture(),preview=await inspectFile(f,await zipFixture(f)),saved=await savePreview(f,preview),exported=await f.service.exportFile({itemId:saved.item.id,type:'zip'}),file=(await f.service.download(exported.id)).file,g=await fixture(),two=await inspectFile(g,file),source=await g.bundles.nativeSourceFromExport(two.exported.id);
 assert.equal(source.project.nodes.length,2);assert.equal(source.project.nodes[0].text,'蓝色背景与暖色主体');assert.equal(source.project.nodes[0].params.nativeCanvas.node.custom.keep,true);assert.equal(source.project.edges[0].nativeCanvasConnection.custom,'retain');assert.equal(source.assets[0].sha256,sha(png));assert.equal(two.pendingNodes,0);assert.equal(exported.type,'zip');
 await assert.rejects(f.service.exportFile({itemId:saved.item.id,type:'json'}),/本机素材/);
});
test('智能画布多图片、音频、输出数组与未引用资源全部保留，向下游传整组时明确阻断',async()=>{
 const f=await fixture(),doc=baseDocument();doc.format='infinite-smart-canvas-workflow';doc.canvas_type='smart';doc.resources.push({url:'/assets/input/原音.wav',archive:'resources/原音.wav',name:'原音.wav',size:wav.length});doc.nodes=[{id:'smart-a',type:'smart-image',x:0,y:0,title:'多素材',images:[{url:doc.resources[0].url,kind:'image',natural_w:1},{url:doc.resources[1].url,kind:'audio',notes:'不可丢失'}]},{id:'smart-b',type:'smart-prompt',x:400,y:0,text:'智能提示词',promptSeparator:';',promptSplitEnabled:false,llmEnabled:false},{id:'smart-g',type:'smart-group',x:0,y:-160,items:['smart-a','smart-b'],w:800,h:600,customLayout:44}];doc.connections=[];
 const preview=await inspectFile(f,await zipFixture(f,doc,[png,wav],{python:true,force64:true}));assert.equal(preview.assets,2);assert.equal(preview.groups,1);assert.equal(preview.pendingNodes,0);assert.equal(preview.sourceFormat,'infinite-smart-canvas-workflow');const saved=await savePreview(f,preview),inserted=await f.catalog.insertCanvas(saved.item.id,{requestId:randomUUID(),projectId:f.target.id,revision:0}),p=inserted.project,media=p.nodes.find(n=>n.title==='多素材');assert.equal(media.params.nativeCanvas.mediaAssetIds.length,2);assert.ok(media.params.nativeCanvas.mediaAssetIds.every(id=>p.assets.some(a=>a.id===id)));assert.equal(p.groups[0].nodeIds.length,2);assert.ok(p.groups[0].nodeIds.every(id=>inserted.nodeIds.includes(id)));
 const zip=await f.service.exportFile({projectId:p.id,revision:1,nodeIds:inserted.nodeIds,type:'zip'}),g=await fixture(),twice=await inspectFile(g,(await f.service.download(zip.id)).file),raw=await g.bundles.nativeSourceFromExport(twice.exported.id),image=raw.project.nodes.find(n=>n.params.nativeCanvas.node.type==='smart-image');assert.equal(image.params.nativeCanvas.node.images[1].notes,'不可丢失');assert.equal(raw.project.nodes.find(n=>n.params.nativeCanvas.node.type==='smart-group').params.nativeCanvas.node.customLayout,44);
 image.params.nativeCanvas.outgoingMedia=true;assert.match(nativeNodeIssues(image).join(''),/整组素材/);
});
test('裸数组、嵌套 workflow 和 BOM JSON 可导入，纯文字 JSON 往返保留文字编辑',async()=>{
 for(const shape of ['array','nested','bom']){const f=await fixture(),nodes=[{id:'prompt',type:'prompt',x:0,y:0,text:'纯文本原件'}],doc=shape==='array'?nodes:shape==='nested'?{workflow:{nodes,connections:[]}}:{nodes,connections:[]},stream=shape==='bom'?Readable.from([Buffer.from('\uFEFF'+JSON.stringify(doc))]):jsonStream(doc),preview=await f.service.inspect(stream,{requestId:randomUUID(),name:'纯文本'});assert.equal(preview.pendingNodes,0);assert.equal(preview.assets,0);const saved=await savePreview(f,preview),result=await f.service.exportFile({itemId:saved.item.id,type:'json'}),raw=JSON.parse(await fs.readFile((await f.service.download(result.id)).file));assert.equal(raw.nodes[0].text,'纯文本原件');assert.equal(raw.format,'infinite-canvas-workflow');}
});
test('JSON 内嵌 PNG 保存本机字节；缺失本地、公网和 blob 素材不会联网读取',async()=>{
 const f=await fixture(),doc={nodes:[{id:'inline',type:'image',x:0,y:0,url:'data:image/png;base64,'+png.toString('base64')},{id:'remote',type:'image',x:400,y:0,url:'https://never-send.invalid/source.png'},{id:'blob',type:'image',x:800,y:0,url:'blob:owned'}],connections:[]},preview=await f.service.inspect(jsonStream(doc),{requestId:randomUUID(),name:'素材边界'});assert.equal(preview.assets,1);assert.equal(preview.pendingNodes,2);assert.equal(preview.issues.length,2);const source=await f.bundles.nativeSourceFromExport(preview.exported.id);assert.equal(source.assets[0].sha256,sha(png));assert.equal(source.project.nodes[0].params.nativeCanvas.missingResources.length,0);assert.ok(source.project.nodes[1].params.nativeCanvas.missingResources.includes('https://never-send.invalid/source.png'));
});
test('外部平台编号不自动复用；MiniMax、循环及未迁移生成仍阻止整体运行，本地提示词拆分可预览',async()=>{
 const f=await fixture(),doc={nodes:[{id:'g',type:'generator',x:0,y:0,apiProvider:'foreign-platform',model:'foreign-model'},{id:'m',type:'minimax',x:400,y:0,segments:[{prompt:'保留片段',start:0,duration:8}]},{id:'l',type:'loop',x:0,y:400,count:3,mode:'parallel'},{id:'s',type:'smart-prompt',x:400,y:400,text:'一;二',promptSplitEnabled:true},{id:'group',type:'group',x:-200,y:-200,items:['g']},{id:'out',type:'output',x:800,y:0,images:[]}],connections:[{from:'group',to:'g'},{from:'g',to:'out'}]},preview=await f.service.inspect(jsonStream(doc),{requestId:randomUUID(),name:'待适配工作流'});assert.equal(preview.pendingNodes,5);assert.ok(preview.issues.some(i=>i.detail.includes('MiniMax')));const source=await f.bundles.nativeSourceFromExport(preview.exported.id),smart=source.project.nodes.find(n=>n.params.nativeCanvas.node.id==='s'),runner=canvasRunner({data:f.data,activeJobs:f.activeJobs,generation:f.generation});assert.deepEqual(nativeNodeIssues(smart,source.project),[]);await assert.rejects(runner.plan(source.project),/尚不能完整执行/);assert.equal(f.activeJobs.size,0);assert.equal(source.project.nodes[0].params.imageBinding,undefined);assert.equal(source.project.nodes[1].params.nativeCanvas.node.segments[0].prompt,'保留片段');
});
test('明确迁移普通生成节点后，原生提示词真实进入本机 ComfyUI 执行计划；无确认仍拒绝',async()=>{
 const f=await fixture(),doc={nodes:[{id:'p',type:'prompt',x:0,y:0,text:'真正进入提示词字段的文字'},{id:'g',type:'comfy',x:400,y:0,comfyWorkflow:'foreign.json',comfyParams:{foreign:42}}],connections:[{from:'p',to:'g'}]},preview=await f.service.inspect(jsonStream(doc),{requestId:randomUUID(),name:'迁移 Comfy'}),saved=await savePreview(f,preview),result=await f.catalog.insertCanvas(saved.item.id,{requestId:randomUUID(),projectId:f.target.id,revision:0}),p=result.project,n=p.nodes.find(n=>n.params?.nativeCanvas?.node.type==='comfy'),template=await f.generation.saveTemplate({name:'本机模板',workflow:{'1':{class_type:'CLIPTextEncode',inputs:{text:'原字段'}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}}}});n.params.workflowBinding={workflowId:template.id,promptField:{nodeId:'1',name:'text'},overrides:[],imageSources:[],count:1};const runner=canvasRunner({data:f.data,activeJobs:f.activeJobs,generation:f.generation});await assert.rejects(runner.plan(p),/重新绑定/);n.params.nativeCanvas.adaptation='configured';validateProject(p);const steps=await runner.plan(p);assert.equal(steps.length,1);assert.equal(steps[0].workflowId,template.id);assert.equal(steps[0].text,'真正进入提示词字段的文字');assert.equal(n.params.nativeCanvas.node.comfyParams.foreign,42);await f.projects.save(p);await assert.rejects(f.service.exportFile({projectId:p.id,revision:1,nodeIds:result.nodeIds,type:'zip'}),/迁移/).catch(e=>{throw e;});
});
test('重复接收编号和保存编号幂等，服务重建后读取不发布或自动插入',async()=>{
 const f=await fixture(),file=await zipFixture(f),requestId=randomUUID(),one=await inspectFile(f,file,requestId),two=await inspectFile(f,file,requestId);assert.deepEqual(two,one);const item=await savePreview(f,one),again=await savePreview(f,one);assert.equal(again.item.id,item.item.id);assert.equal((await f.catalog.read()).revision,1);const fresh=nativeCanvasService({data:f.data,bundles:f.bundles,catalog:f.catalog});assert.deepEqual(await fresh.get(requestId),one);assert.equal((await fresh.list()).length,1);assert.equal((await f.projects.load(f.target.id)).nodes.length,1);await assert.rejects(fresh.inspect(jsonStream({nodes:[{id:'new',type:'prompt',x:0,y:0,text:'不同内容'}]}),{requestId,name:one.name}),e=>e.status===409);
});
test('库修订冲突、错误分组和破损包在发布前拒绝，原项目保留',async()=>{
 const f=await fixture(),preview=await inspectFile(f,await zipFixture(f)),payload={requestId:randomUUID(),revision:8,libraryId:'default',folderId:'workflows',name:preview.name};await assert.rejects(f.service.save(preview.id,payload),e=>e.status===409);assert.equal((await f.catalog.read()).revision,0);await assert.rejects(f.service.save(preview.id,{...payload,revision:0,folderId:'characters'}),/工作流分组/);const file=await f.bundles.download(preview.exported.id),bytes=await fs.readFile(file);bytes[bytes.length-2]^=1;await fs.writeFile(file,bytes);await assert.rejects(f.service.save(preview.id,{...payload,revision:0}),/校验失败/);assert.equal((await f.catalog.read()).revision,0);assert.equal((await f.projects.load(f.target.id)).nodes[0].text,'原文保留');
});
test('ZIP CRC、目录元数据、截断、重复路径和穿越路径损坏均拒绝',async()=>{
 const f=await fixture(),file=await zipFixture(f),original=await fs.readFile(file),cases=[];
 const badCrc=Buffer.from(original);badCrc[30+badCrc.readUInt16LE(26)]^=1;cases.push(badCrc);
 const badDirectory=Buffer.from(original),central=badDirectory.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));badDirectory.writeUInt32LE(1,central+42);cases.push(badDirectory);cases.push(original.subarray(0,original.length-10));cases.push(Buffer.concat([original,Buffer.from('trailing')]));
 for(const bytes of cases){const dir=path.join(f.data,'corrupt-'+randomUUID());await fs.mkdir(dir);await assert.rejects(readNativeArchive(Readable.from([bytes]),{directory:dir}),/ZIP/);}
 const invalid=baseDocument();invalid.resources[0].archive='../原图.png';const unsafe=await zipFixture(f,invalid,[png],{python:true});await assert.rejects(inspectFile(f,unsafe),/不安全/);
 const duplicate=baseDocument();duplicate.resources.push({...duplicate.resources[0]});const dup=await zipFixture(f,duplicate,[png,png],{python:true});await assert.rejects(inspectFile(f,dup),/重复/);
});
test('ZIP 不接受符号链接、加密或数据描述符；图片假扩展名不能发布',async()=>{
 const f=await fixture(),original=await fs.readFile(await zipFixture(f)),central=original.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
 for(const kind of ['symlink','encrypted','descriptor']){const bytes=Buffer.from(original);if(kind==='symlink')bytes.writeUInt32LE((0xa1ff<<16)>>>0,central+38);else{bytes.writeUInt16LE(bytes.readUInt16LE(6)|(kind==='encrypted'?1:8),6);bytes.writeUInt16LE(bytes.readUInt16LE(central+8)|(kind==='encrypted'?1:8),central+8);}const dir=path.join(f.data,'invalid-'+randomUUID());await fs.mkdir(dir);await assert.rejects(readNativeArchive(Readable.from([bytes]),{directory:dir}),/ZIP/);}
 const bad=Buffer.from('this is not a PNG'),doc=baseDocument();doc.resources[0].size=bad.length;await assert.rejects(inspectFile(f,await zipFixture(f,doc,[bad])),/格式/);assert.equal((await f.catalog.read()).revision,0);
});
test('JSON 凭据和带认证 URL 在写入任何 JSON 或发布工作流之前拒绝',async()=>{
 for(const value of [{apiKey:'owned-invalid-fixture'}, {url:'https://example.invalid/image.png?access_token=owned-invalid-fixture'},JSON.parse('{"constructor":{"value":true}}')]){const f=await fixture(),doc={nodes:[{id:'a',type:'image',x:0,y:0,...value}],connections:[]};await assert.rejects(f.service.inspect(jsonStream(doc),{requestId:randomUUID(),name:'拒绝凭据'}));const staging=path.join(f.data,'native-canvas','imports');for(const name of await fs.readdir(staging))assert.deepEqual(await fs.readdir(path.join(staging,name)),[]);assert.equal((await f.catalog.read()).revision,0);}
});
test('无效图、错误版本、循环连线、无效 UTF-8 和过大的配置清楚拒绝',async()=>{
 assert.throws(()=>normalizeNativeWorkflow({format:'jingchang-bundle',nodes:[{id:'a',type:'prompt',x:0,y:0}]}),/格式/);assert.throws(()=>normalizeNativeWorkflow({version:2,nodes:[{id:'a',type:'prompt',x:0,y:0}]}),/版本/);assert.throws(()=>normalizeNativeWorkflow({nodes:[{id:'a',type:'prompt',x:0,y:0},{id:'a',type:'prompt',x:0,y:0}]}),/重复/);
 const f=await fixture();await assert.rejects(f.service.inspect(Readable.from([Buffer.from([0xff,0xfe,0,0])]),{requestId:randomUUID(),name:'无效 UTF-8'}),/UTF-8/);await assert.rejects(f.service.inspect(Readable.from([Buffer.alloc(12*1024**2+1,32)]),{requestId:randomUUID(),name:'超限配置'}),/12MiB/);
 const cyclic={nodes:[{id:'a',type:'prompt',x:0,y:0,text:''},{id:'b',type:'prompt',x:400,y:0,text:''}],connections:[{from:'a',to:'b'},{from:'b',to:'a'}]};await assert.rejects(f.service.inspect(jsonStream(cyclic),{requestId:randomUUID(),name:'循环图'}),/循环依赖/);
});
test('子图导出与插入跟随原生成组成员和所有媒体依赖，缺失依赖明确拒绝',async()=>{
 const p=nativeToFragment(normalizeNativeWorkflow({nodes:[{id:'a',type:'prompt',x:0,y:0,text:'组成员'},{id:'g',type:'group',x:-200,y:-200,items:['a']}],connections:[]}),[],'组节点');assert.throws(()=>selectCanvasFragment(p,[p.nodes[1].id]),/未选中/);const fragment=selectCanvasFragment(p,p.nodes.map(n=>n.id)),target=makeProject('目标');target.nodes=[];const maps=fragmentMaps(fragment),merged=mergeCanvasFragment(target,fragment,maps,{x:80,y:100});assert.equal(merged.project.nodes[1].params.nativeCanvas.members[0].sourceNodeId,merged.project.nodes[0].id);const exported=fragmentToNative(merged.project,[]);assert.deepEqual(exported.nodes[1].items,[exported.nodes[0].id]);
});

test('原生输入次序和分组在复制、断线、移出与导出后仍对应实际节点',()=>{
 const p=nativeToFragment(normalizeNativeWorkflow({nodes:[{id:'a',type:'prompt',x:0,y:0,text:'第一项'},{id:'b',type:'prompt',x:0,y:200,text:'第二项'},{id:'g',type:'comfy',x:400,y:0,inputs:['b','a'],opaque:{referenceNodeId:'a'}},{id:'group',type:'group',x:-100,y:-100,items:['a','b']}],connections:[{from:'a',to:'g'},{from:'b',to:'g'}]}),[],'有次序的原生节点');
 const [a,b,g,group]=p.nodes,copied=copySelectedNodes(p,p.nodes.map(n=>n.id),{copyGroups:true}),copies=copied.nodes.slice(4);
 assert.deepEqual(copies[2].params.nativeCanvas.inputOrder.map(r=>r.sourceNodeId),[copies[1].id,copies[0].id]);assert.deepEqual(copies[3].params.nativeCanvas.members.map(r=>r.sourceNodeId),[copies[0].id,copies[1].id]);validateProject(copied);
 assert.throws(()=>fragmentToNative(copied,[]),/重复的原生节点编号/);
 const raw=fragmentToNative(p,[]);assert.deepEqual(raw.nodes.map(n=>n.id),['a','b','g','group']);assert.deepEqual(raw.nodes[2].inputs,['b','a']);assert.equal(raw.nodes[2].opaque.referenceNodeId,'a');assert.equal(raw.connections[0].from,'a');assert.equal(raw.connections[0].to,'g');
 const disconnected=removeConnection(p,p.edges.find(e=>e.source===b.id).id);validateProject(disconnected);assert.deepEqual(fragmentToNative(disconnected,[]).nodes[2].inputs,['a']);assert.deepEqual(p.nodes[2].params.nativeCanvas.node.inputs,['b','a']);
 const removed=removeSelectedNodes(p,[a.id,b.id]);validateProject(removed);assert.deepEqual(removed.nodes.find(n=>n.id===g.id).params.nativeCanvas.inputOrder,[]);assert.deepEqual(removed.nodes.find(n=>n.id===group.id).params.nativeCanvas.members,[]);assert.deepEqual(fragmentToNative(removed,[]).nodes.find(n=>n.id==='group').items,[]);assert.equal(p.nodes.length,4);
});

test('原生连接改动按实际画布检查，旧标记不能绕过多素材与分组聚合阻断',()=>{
 const p=nativeToFragment(normalizeNativeWorkflow({nodes:[{id:'a',type:'smart-image',x:0,y:0},{id:'b',type:'smart-prompt',x:400,y:0,text:'下游'},{id:'g',type:'smart-group',x:-100,y:-100,items:['a']}],connections:[]}),[],'动态连接');
 const [a,b,g]=p.nodes;a.params.nativeCanvas.mediaAssetIds=['fixture-one','fixture-two'];p.edges=[{id:randomUUID(),source:a.id,target:b.id}];assert.equal(a.params.nativeCanvas.outgoingMedia,false);assert.match(nativeNodeIssues(a,p).join(''),/整组素材/);
 p.edges=[{id:randomUUID(),source:g.id,target:b.id}];assert.match(nativeNodeIssues(g,p).join(''),/聚合语义/);p.edges=[];g.params.nativeCanvas.connectedGroup=true;assert.deepEqual(nativeNodeIssues(g,p),[]);
});

test('待适配原生节点不能绕过画布计划直接提交本机或图片生成接口',async()=>{
 const f=await fixture(),p=nativeToFragment(normalizeNativeWorkflow({nodes:[{id:'unmapped',type:'comfy',x:0,y:0,comfyWorkflow:'foreign.json'}],connections:[]}),[],'直接提交防护'),n=p.nodes[0];let platformReads=0;
 const images=directImageService({data:f.data,activeJobs:f.activeJobs,platforms:{get:async()=>{platformReads++;throw Error('must not read');}}});
 await assert.rejects(f.generation.start(p,{nodeId:n.id,revision:p.revision,requestId:randomUUID()},'http://never-send.invalid'),/重新绑定/);
 await assert.rejects(images.start(p,{nodeId:n.id,revision:p.revision,requestId:randomUUID()}),/重新绑定/);assert.equal(platformReads,0);assert.equal(f.activeJobs.size,0);
});

test('异步小分片 ZIP 和大段 Deflate 配置按原字节接收，超出声明大小及时拒绝',async()=>{
 const f=await fixture(),doc=baseDocument();doc.customHeader.longSource='保留完整原件'.repeat(10000);const original=await fs.readFile(await zipFixture(f,doc,[png],{python:true}));
 async function* chunks(bytes){for(let i=0;i<bytes.length;i+=17){await Promise.resolve();yield bytes.subarray(i,i+17);}}
 const preview=await f.service.inspect(Readable.from(chunks(original)),{requestId:randomUUID(),name:'异步分片'}),source=await f.bundles.nativeSourceFromExport(preview.exported.id);assert.equal(source.project.nodes[0].params.nativeCanvas.header.customHeader.longSource,doc.customHeader.longSource);assert.equal(source.assets[0].sha256,sha(png));
 const bad=Buffer.from(original),name=Buffer.from('workflow.json'),nameAt=bad.indexOf(name),local=nameAt-30;assert.equal(bad.readUInt32LE(local),0x04034b50);bad.writeUInt32LE(16,local+22);const dir=path.join(f.data,'bounded-'+randomUUID());await fs.mkdir(dir);await assert.rejects(readNativeArchive(Readable.from(chunks(bad)),{directory:dir}),/超过声明大小/);
});

test('含凭据的打包清单不会写入接收记录或工作流 JSON，媒体原件保持隔离',async()=>{
 const f=await fixture(),doc=baseDocument();doc.nodes[0].apiKey='owned-invalid-fixture';const file=await zipFixture(f,doc,[png]);await assert.rejects(inspectFile(f,file));const root=path.join(f.data,'native-canvas','imports');for(const stage of await fs.readdir(root)){const files=await fs.readdir(path.join(root,stage));assert.ok(files.every(name=>name.endsWith('.media')));for(const name of files)assert.deepEqual(await fs.readFile(path.join(root,stage,name)),png);}assert.deepEqual(await f.service.list(),[]);assert.equal((await f.catalog.read()).revision,0);
});


test('明确迁移的原生生成结果回填原节点，已有文字和运行期间改动保留',async()=>{
 for(const edit of [false,true]){const f=await fixture(),p=nativeToFragment(normalizeNativeWorkflow({nodes:[{id:'g',type:'comfy',x:0,y:0,text:'保留输入文字',comfyWorkflow:'foreign.json'}],connections:[]}),[],'结果回填'),n=p.nodes[0];n.params.nativeCanvas.adaptation='configured';n.params.workflowBinding={workflowId:'owned-template',overrides:[],imageSources:[],count:1};const nativeResultTargets=captureNativeResultTargets(p),snapshot=structuredClone(p),a=await storeAsset(f.data,png,{name:'本机结果.png',type:'image/png'});if(edit)n.text='执行期间用户继续编辑';const job={id:randomUUID(),kind:'canvas-run',projectId:p.id,status:'completed',nativeResultTargets,snapshot,assets:[{...a,sourceNodeId:n.id}],textResults:[]};snapshot.nodes[0].assetId=a.id;const result=await applyCanvasResults({data:f.data,project:p,job,revision:p.revision});assert.equal(result.project.nodes[0].assetId,edit?null:a.id);assert.equal(result.project.nodes[0].text,edit?'执行期间用户继续编辑':'保留输入文字');assert.equal(result.project.nodes.at(-1).assetId,a.id);assert.equal(result.project.runs.length,1);assert.equal(result.applied,true);validateProject(result.project);}
});

test('第23版完整工程迁移原生素材、成员与本机绑定，保留来源参数且不携带运行授权',async()=>{
 const f=await fixture(),doc=baseDocument();doc.nodes.push({id:'g',type:'comfy',x:700,y:80,inputs:['prompt-1'],comfyWorkflow:'foreign-template.json'},{id:'group',type:'group',x:-150,y:-120,items:['media-1','g']});doc.connections.push({from:'prompt-1',to:'g'});
 const preview=await inspectFile(f,await zipFixture(f,doc)),saved=await savePreview(f,preview),inserted=await f.catalog.insertCanvas(saved.item.id,{requestId:randomUUID(),projectId:f.target.id,revision:0}),p=inserted.project,n=p.nodes.find(n=>n.params?.nativeCanvas?.node.type==='comfy'),template=await f.generation.saveTemplate({name:'本机迁移模板',workflow:{'1':{class_type:'CLIPTextEncode',inputs:{text:'可覆盖'}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}}}});
 n.params.nativeCanvas.adaptation='configured';n.params.workflowBinding={workflowId:template.id,promptField:{nodeId:'1',name:'text'},overrides:[],imageSources:[],count:1};await f.projects.save(p);
 const exported=await f.bundles.exportBundle(p.id,p.revision);assert.equal(exported.formatVersion,23);assert.equal(exported.canvasFragment,false);
 const g=await fixture(),received=await g.bundles.upload(createReadStream(await f.bundles.download(exported.id))),restored=await g.bundles.importBundle(received.id),m=restored.nodes.find(node=>node.params?.nativeCanvas?.node.type==='comfy'),media=restored.nodes.find(node=>node.params?.nativeCanvas?.node.type==='image');
 assert.notEqual(restored.id,p.id);assert.notEqual(m.params.workflowBinding.workflowId,template.id);assert.equal(m.params.nativeCanvas.node.comfyWorkflow,'foreign-template.json');assert.equal(m.params.nativeCanvas.adaptation,'configured');assert.notEqual(media.assetId,p.nodes.find(node=>node.params?.nativeCanvas?.node.type==='image').assetId);assert.equal(media.params.nativeCanvas.resources[0].assetId,media.assetId);assert.equal(media.params.nativeCanvas.mediaAssetIds[0],media.assetId);assert.deepEqual(await fs.readFile(path.join(g.data,'assets',media.assetId)),png);
 const loaded=await g.generation.template(m.params.workflowBinding.workflowId);assert.equal(loaded.workflow['1'].inputs.text,'可覆盖');assert.equal(restored.messages[0].text,'原消息保留');assert.equal(restored.nodes[0].text,'原文保留');assert.ok(restored.nodes.find(node=>node.params?.nativeCanvas?.node.type==='group').params.nativeCanvas.members.every(ref=>restored.nodes.some(node=>node.id===ref.sourceNodeId)));assert.deepEqual(restored.runs,[]);assert.equal(g.activeJobs.size,0);validateProject(restored);await assert.rejects(g.service.exportFile({projectId:restored.id,revision:restored.revision,nodeIds:restored.nodes.filter(node=>node.params?.nativeCanvas).map(node=>node.id),type:'zip'}),/迁移/);
});
