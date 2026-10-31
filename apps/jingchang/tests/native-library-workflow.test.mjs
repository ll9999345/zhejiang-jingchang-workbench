import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inspectNativeLibraryWorkflow} from '../lib/native-library-workflow.mjs';
import {writeNativeZip} from '../lib/native-canvas-export.mjs';
import {projectBundleService} from '../lib/project-bundles.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const document=(url='/assets/library/素材/图.png')=>({format:'infinite-canvas-workflow',version:1,nodes:[{id:'p',type:'prompt',x:0,y:0,text:'保留文本'},{id:'i',type:'image',x:300,y:0,url}],connections:[{from:'p',to:'i'}],resources:[]});
const graph=()=>({'1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'model.safetensors'}},'2':{class_type:'CLIPTextEncode',inputs:{text:'文字 https://example.invalid 属于提示词',clip:['1',1]}},'3':{class_type:'KSampler',inputs:{seed:7,model:['1',0]}}});
async function fixture(){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'native-library-workflow-'))),sourceRoot=path.join(root,'source'),directory=path.join(root,'target','native-canvas','imports','stage');
 await fs.mkdir(path.join(sourceRoot,'assets','library','素材'),{recursive:true});await fs.mkdir(directory,{recursive:true});
 return {root,sourceRoot,directory,async json(value,filename='original.json'){const file=path.join(sourceRoot,'assets','library',filename);await fs.writeFile(file,JSON.stringify(value));return file;},async media(bytes=png,name='素材/图.png'){const file=path.join(sourceRoot,'assets','library',...name.split('/'));await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);return file;}};
}
const inspect=(f,file,options={})=>inspectNativeLibraryWorkflow({file,directory:f.directory,sourceRoot:f.sourceRoot,name:'本机工作流',...options});
async function zip(f,doc,bytes=[png]){
 const sources=[];for(const [index,content]of bytes.entries()){const file=path.join(f.root,'fixture-'+index+'.png');await fs.writeFile(file,content);sources.push({file});}
 const file=path.join(f.sourceRoot,'assets','library','original.zip');await writeNativeZip(file,doc,bytes.map((content,index)=>({id:'fixture-'+index,name:'图.png',type:'image/png',size:content.length,sha256:digest(content)})),sources);return file;
}

test('按内容识别 Comfy API 模板，不将模型文件名当作媒体资源',async()=>{
 const f=await fixture(),input=graph(),file=await f.json(input,'not-a-workflow.zip'),before=await fs.readFile(file),result=await inspect(f,file);
 assert.equal(result.kind,'comfy');assert.equal(result.sourceKind,'json');assert.equal(result.inspection.nodeCount,3);assert.deepEqual(result.fields,[]);assert.deepEqual(result.workflow,input);assert.equal(result.sha256,digest(before));assert.equal(result.size,before.length);assert.deepEqual(await fs.readFile(file),before);assert.deepEqual(await fs.readdir(f.directory),[]);assert.doesNotThrow(()=>JSON.stringify(result));
 const wrapped=await f.json({prompt:graph()},'wrapper.json');assert.equal((await inspect(f,wrapped)).kind,'comfy');
});

test('无素材原生文档解析为独立 fragment，文字 URL 保留且没有磁盘 JSON',async()=>{
 const f=await fixture(),doc=document();doc.nodes=[{id:'p',type:'prompt',x:0,y:0,text:'https://example.invalid 是文字'}];doc.connections=[];const file=await f.json(doc),result=await inspect(f,file);
 assert.equal(result.kind,'canvas-fragment');assert.equal(result.project.nodes.length,1);assert.deepEqual(result.resources,[]);assert.deepEqual(result.sourceFiles,[]);assert.equal(result.summary.issueCount,0);assert.equal(result.project.nodes[0].text,doc.nodes[0].text);assert.deepEqual(await fs.readdir(f.directory),[]);
});

test('原生 JSON 只复制显式源根 assets/library，改写素材引用并记录源校验信息',async()=>{
 const f=await fixture(),mediaFile=await f.media(),doc=document('/assets/library/%E7%B4%A0%E6%9D%90/%E5%9B%BE.png'),file=await f.json(doc),before=await fs.readFile(file),result=await inspect(f,file);
 assert.equal(result.kind,'canvas-fragment');assert.equal(result.resources.length,1);const resource=result.resources[0];assert.deepEqual(await fs.readFile(resource.file),png);assert.equal(resource.type,'image/png');assert.equal(resource.size,png.length);assert.equal(resource.sha256,digest(png));assert.match(resource.asset.id,/^[\da-f-]{36}$/);assert.equal(resource.sourceFile,mediaFile);assert.deepEqual(result.sourceFiles,[{file:mediaFile,size:png.length,sha256:digest(png),fingerprint:resource.sourceFingerprint,directoryMarks:resource.directoryMarks}]);assert.match(resource.sourceFingerprint,/^\d+\/\d+\/\d+\//);
 assert.deepEqual(resource.directoryMarks.map(record=>record.directory),[f.sourceRoot,path.join(f.sourceRoot,'assets'),path.join(f.sourceRoot,'assets','library'),path.join(f.sourceRoot,'assets','library','素材')]);assert.ok(resource.directoryMarks.every(record=>/^\d+\/\d+$/.test(record.fingerprint)));
 assert.equal(result.project.nodes[1].params.nativeCanvas.node.url,resource.portableUrl);assert.equal(result.project.nodes[1].assetId,resource.asset.id);assert.equal(result.project.assets[0].id,resource.asset.id);assert.deepEqual(await fs.readFile(file),before);assert.deepEqual(await fs.readFile(mediaFile),png);assert.doesNotThrow(()=>JSON.stringify(result));
});

test('清单资源与生成结果 input 的映射均保留，重复 URL 只复制一次',async()=>{
 const f=await fixture();await f.media();const doc=document();doc.resources=[{url:doc.nodes[1].url,archive:'resources/图.png',name:'图.png',size:png.length}];doc.nodes.push({id:'o',type:'output',x:600,y:0,inputs:['i:generated:0:'+doc.nodes[1].url]});const result=await inspect(f,await f.json(doc));
 assert.equal(result.kind,'canvas-fragment');assert.equal(result.resources.length,1);assert.equal(result.project.nodes[2].params.nativeCanvas.inputOrder[0].itemUrl,result.resources[0].portableUrl);assert.deepEqual(result.project.nodes[0].params.nativeCanvas.missingResources,[]);
});

test('JSON 缺资源、未给源根和其他本机目录均明确返回 unsupported',async()=>{
 const f=await fixture();await f.media();
 const none=await inspect(f,await f.json(document('/assets/library/none.png')));assert.equal(none.kind,'unsupported');assert.equal(none.missingResources[0].reason,'missing-library-file');assert.equal(none.project,undefined);
 const noRoot=await inspect(f,await f.json(document()),{sourceRoot:undefined});assert.equal(noRoot.missingResources[0].reason,'source-root-required');
 for(const url of ['/assets/input/a.png','/assets/output/a.png','/output/a.png','/uploads/a.png']){
  const result=await inspect(f,await f.json(document(url)));assert.equal(result.kind,'unsupported');assert.equal(result.missingResources[0].reason,'outside-library-scope');
 }
 assert.deepEqual(await fs.readdir(f.directory),[]);
});

test('未打包的外部媒体与节点服务 URL 不联网并标明缺失',async()=>{
 const f=await fixture(),doc=document('https://example.invalid/image.png');doc.nodes.push({id:'c',type:'comfy',x:0,y:300,comfyAddress:'http://127.0.0.1:8188'});
 const result=await inspect(f,await f.json(doc));assert.equal(result.kind,'unsupported');assert.deepEqual(new Set(result.missingResources.map(record=>record.reference)),new Set(['https://example.invalid/image.png','http://127.0.0.1:8188']));assert.ok(result.missingResources.every(record=>record.reason==='external-url'));assert.deepEqual(await fs.readdir(f.directory),[]);
 const comfy=graph();comfy['4']={class_type:'LoadImage',inputs:{image:'https://example.invalid/image.png'}};const api=await inspect(f,await f.json(comfy));assert.equal(api.kind,'unsupported');assert.equal(api.format,'comfy');assert.equal(api.missingResources[0].reason,'unsupported-comfy-resource-url');
});

test('真实 native ZIP 校验后可生成现有 bundles 兼容 fragment，不建项目',async()=>{
 const f=await fixture(),doc=document('/assets/input/original.png');doc.resources=[{url:doc.nodes[1].url,archive:'resources/图.png',name:'图.png',size:png.length}];const file=await zip(f,doc),before=await fs.readFile(file),result=await inspect(f,file);
 assert.equal(result.kind,'canvas-fragment');assert.equal(result.sourceKind,'zip');assert.equal(result.sha256,digest(before));assert.deepEqual(result.sourceFiles,[]);assert.equal(result.resources[0].sha256,digest(png));assert.deepEqual(await fs.readFile(file),before);assert.equal(result.project.nodes[1].params.nativeCanvas.node.url,result.resources[0].portableUrl);
 const data=path.join(f.root,'target'),bundles=projectBundleService({data,activeJobs:new Map(),projects:{load(){throw Error('Unexpected project load');},save(){throw Error('Unexpected project write');}}});
 const exported=await bundles.exportPreparedFragment(result.project,result.resources);assert.ok(exported.id);assert.equal((await bundles.nativeSourceFromExport(exported.id)).project.nodes.length,2);await assert.rejects(fs.lstat(path.join(data,'projects')),{code:'ENOENT'});assert.deepEqual(await fs.readFile(file),before);
});

test('ZIP 缺清单素材返回 missing；未列清单、大小不符和 CRC 损坏拒绝',async()=>{
 const f=await fixture(),doc=document('/assets/input/a.png');doc.resources=[{url:doc.nodes[1].url,archive:'resources/a.png',name:'a.png',size:png.length}];let file=await zip(f,doc,[]);const missing=await inspect(f,file);assert.equal(missing.kind,'unsupported');assert.equal(missing.missingResources[0].reason,'missing-zip-resource');
 const f2=await fixture(),mismatched=structuredClone(doc);mismatched.resources[0].size=png.length+1;await assert.rejects(inspect(f2,await zip(f2,mismatched)),/大小不一致/);
 const f3=await fixture(),noList=structuredClone(doc);noList.nodes=[{id:'p',type:'prompt',x:0,y:0,text:'空资源'}];noList.connections=[];noList.resources=[{url:'/assets/input/other.png',archive:'resources/a.png',name:'a.png',size:png.length}];const unlistedFile=await zip(f3,noList);const raw=await fs.readFile(unlistedFile);const from=Buffer.from('resources/a.png'),to=Buffer.from('resources/b.png');to.copy(raw,raw.indexOf(from));to.copy(raw,raw.lastIndexOf(from));await fs.writeFile(path.join(f3.root,'unlisted.zip'),raw);await assert.rejects(inspect(f3,path.join(f3.root,'unlisted.zip')),/未列入/);
 const f4=await fixture(),corruptFile=await zip(f4,doc),original=await fs.readFile(corruptFile),corrupt=Buffer.from(original);corrupt[30+Buffer.byteLength('resources/a.png')+20]^=1;const broken=path.join(f4.root,'crc.zip');await fs.writeFile(broken,corrupt);await assert.rejects(inspect(f4,broken),/CRC/);assert.deepEqual(await fs.readFile(corruptFile),original);
});

test('凭据、坏 JSON 和 native 版本拒绝，源 JSON 从不写接收目录',async()=>{
 for(const value of [{apiKey:'fixture-key',nodes:document().nodes},{...document(),version:2},{nodes:[{id:1,type:'image'}]}]){const f=await fixture(),file=await f.json(value),before=await fs.readFile(file);await assert.rejects(inspect(f,file));assert.deepEqual(await fs.readFile(file),before);assert.deepEqual(await fs.readdir(f.directory),[]);}
 const f=await fixture(),input=graph();input['1'].inputs.password='fixture-secret';await assert.rejects(inspect(f,await f.json(input)),/密钥/);assert.deepEqual(await fs.readdir(f.directory),[]);
 const invalid=path.join(f.root,'invalid.json');await fs.writeFile(invalid,'{invalid');await assert.rejects(inspect(f,invalid),/UTF-8 JSON/);
});

test('有效 JSON 的未知顶层结构与超限 Comfy 模板返回 unsupported 收据',async()=>{
 const f=await fixture(),file=await f.json({hello:'world'}),result=await inspect(f,file);assert.equal(result.kind,'unsupported');assert.equal(result.format,'unknown');assert.match(result.reason,/顶层结构/);assert.equal(result.sha256,digest(await fs.readFile(file)));assert.equal(result.project,undefined);
 const many=Object.fromEntries(Array.from({length:501},(_,index)=>[String(index),{class_type:'CLIPTextEncode',inputs:{text:'文字'}}]));const overNodes=await inspect(f,await f.json(many));assert.equal(overNodes.kind,'unsupported');assert.equal(overNodes.format,'comfy');assert.match(overNodes.reason,/500/);
 const large={'1':{class_type:'CLIPTextEncode',inputs:{text:'字'.repeat(2_000_000)}}};const overChars=await inspect(f,await f.json(large));assert.equal(overChars.kind,'unsupported');assert.equal(overChars.format,'comfy');assert.match(overChars.reason,/字符/);assert.deepEqual(await fs.readdir(f.directory),[]);
});

test('拒绝源文件、源素材、源根和接收目录符号链接',async()=>{
 const f=await fixture(),file=await f.json(graph()),linked=path.join(f.root,'linked.json');await fs.symlink(file,linked);await assert.rejects(inspect(f,linked),/普通文件/);
 const outLink=path.join(f.root,'linked-target');await fs.symlink(f.directory,outLink);await assert.rejects(inspect(f,file,{directory:outLink}),/普通本机目录/);
 await f.media();const mediaLink=path.join(f.sourceRoot,'assets','library','linked.png');await fs.symlink(path.join(f.sourceRoot,'assets','library','素材','图.png'),mediaLink);await assert.rejects(inspect(f,await f.json(document('/assets/library/linked.png'))),/普通文件/);
 const rootLink=path.join(f.root,'linked-source');await fs.symlink(f.sourceRoot,rootLink);await assert.rejects(inspect(f,await f.json(document()),{sourceRoot:rootLink}),/源项目根目录/);
});

test('library URL 路径注入和双重编码均拒绝，其他目录不能扩大读取',async()=>{
 for(const url of ['/assets/library/../escape.png','/assets/library/%2e%2e/escape.png','/assets/library/a%2fb.png','/assets/library/%252e%252e/escape.png','/assets/library/file.png?token=x','/assets/library/./file.png','/assets/library/a\\b.png']){const f=await fixture();await assert.rejects(inspect(f,await f.json(document(url))),/路径|编码/);assert.deepEqual(await fs.readdir(f.directory),[]);}
 const f=await fixture();await fs.mkdir(path.join(f.sourceRoot,'assets','input'));await fs.writeFile(path.join(f.sourceRoot,'assets','input','exists.png'),png);const result=await inspect(f,await f.json(document('/assets/input/exists.png')));assert.equal(result.kind,'unsupported');assert.equal(result.missingResources[0].reason,'outside-library-scope');
});

test('JSON 清单大小、资源类型和真实媒体文件头必须相符',async()=>{
 const f=await fixture();await f.media();const doc=document();doc.resources=[{url:doc.nodes[1].url,archive:'resources/a.png',name:'a.png',size:png.length+1}];await assert.rejects(inspect(f,await f.json(doc)),/大小不一致/);
 const f2=await fixture();await f2.media(Buffer.from('not a PNG'));await assert.rejects(inspect(f2,await f2.json(document())),/文件头/);
 const f3=await fixture();await f3.media(png,'file.exe');await assert.rejects(inspect(f3,await f3.json(document('/assets/library/file.exe'))),/不是支持/);
});

test('AbortSignal 中止保留原文件和已建立的 partial 素材',async()=>{
 const f=await fixture(),content=Buffer.alloc(16*1024**2);png.copy(content);const source=await f.media(content),file=await f.json(document()),controller=new AbortController();let finished=false;
 const rejected=assert.rejects(inspect(f,file,{signal:controller.signal}),error=>error.name==='AbortError'&&error.code==='ABORT_ERR');rejected.then(()=>{finished=true;},()=>{finished=true;});
 while(!finished){if((await fs.readdir(f.directory)).some(name=>name.endsWith('.media'))){controller.abort();break;}await new Promise(resolve=>setTimeout(resolve,1));}
 await rejected;
 assert.deepEqual(await fs.readFile(source),content);assert.ok((await fs.readdir(f.directory)).some(name=>name.endsWith('.media')));assert.equal((await fs.readFile(file,'utf8')),JSON.stringify(document()));
 const f2=await fixture(),already=new AbortController();already.abort();await assert.rejects(inspect(f2,await f2.json(graph()),{signal:already.signal}),{name:'AbortError'});assert.deepEqual(await fs.readdir(f2.directory),[]);
});

test('读取中替换源素材父目录，即使文件完整指纹未变也拒绝',async()=>{
 const f=await fixture(),content=Buffer.alloc(16*1024**2);png.copy(content);const source=await f.media(content),file=await f.json(document()),parent=path.dirname(source),replacement=path.join(f.root,'replacement-directory'),preserved=path.join(f.root,'preserved-directory');
 await fs.mkdir(replacement);await fs.link(source,path.join(replacement,path.basename(source)));const before=await fs.lstat(source),fileMark=stat=>`${stat.dev}/${stat.ino}/${stat.size}/${stat.mtimeMs}/${stat.ctimeMs}`;let finished=false,replaced=false;
 const rejected=assert.rejects(inspect(f,file),/源目录身份发生变化/);rejected.then(()=>{finished=true;},()=>{finished=true;});
 while(!finished){if((await fs.readdir(f.directory)).some(name=>name.endsWith('.media'))){await fs.rename(parent,preserved);await fs.rename(replacement,parent);replaced=true;break;}await new Promise(resolve=>setTimeout(resolve,1));}
 await rejected;assert.equal(replaced,true);assert.equal(fileMark(await fs.lstat(source)),fileMark(before));assert.deepEqual(await fs.readFile(source),content);assert.deepEqual(await fs.readFile(path.join(preserved,path.basename(source))),content);assert.ok((await fs.readdir(f.directory)).some(name=>name.endsWith('.media')));
});

test('素材读取结束后的同步点替换源父目录仍被最后复验拒绝',async()=>{
 const f=await fixture(),source=await f.media(),file=await f.json(document()),parent=path.dirname(source),replacement=path.join(f.root,'replacement-after-read'),preserved=path.join(f.root,'preserved-after-read');
 await fs.mkdir(replacement);await fs.link(source,path.join(replacement,path.basename(source)));const before=await fs.lstat(source),fileMark=stat=>`${stat.dev}/${stat.ino}/${stat.size}/${stat.mtimeMs}/${stat.ctimeMs}`,originalOpen=fs.open;let replaced=false;
 fs.open=async function(...args){const handle=await originalOpen.apply(this,args);if(String(args[0]).startsWith(f.directory+path.sep)&&String(args[0]).endsWith('.media')){const sync=handle.sync.bind(handle);handle.sync=async()=>{await sync();await fs.rename(parent,preserved);await fs.rename(replacement,parent);replaced=true;};}return handle;};
 try{await assert.rejects(inspect(f,file),/源目录身份发生变化/);}finally{fs.open=originalOpen;}
 assert.equal(replaced,true);assert.equal(fileMark(await fs.lstat(source)),fileMark(before));assert.deepEqual(await fs.readFile(source),png);assert.deepEqual(await fs.readFile(path.join(preserved,path.basename(source))),png);assert.ok((await fs.readdir(f.directory)).some(name=>name.endsWith('.media')));
});
