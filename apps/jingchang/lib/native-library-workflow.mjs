import {promises as fs,constants} from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createHash,randomUUID} from 'node:crypto';
import {readNativeArchive,nativeArchiveLimits} from './native-canvas-archive.mjs';
import {guardNativeTree,parseNativeJson,nodeMediaUrls,resourceAliases,nativeToFragment,nativeFragmentSummary} from './native-canvas-core.mjs';
import {inspectWorkflow} from './providers.mjs';
import {normalizeFields} from './workflow-fields.mjs';
import {fileMediaType,streamMediaType,MAX_STREAM_MEDIA_BYTES} from '../public/media-transfer-core.js';
import {checkMediaHeader} from './stream-assets.mjs';
import {assertNoCredentials,textValue,userError} from './workspace.mjs';
import {validateNativeUrls} from '../public/native-canvas-core.js';

const mark=s=>`${s.dev}/${s.ino}/${s.size}/${s.mtimeMs}/${s.ctimeMs}`;
const directoryMark=s=>`${s.dev}/${s.ino}`;
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const literalFields=new Set(['id','type','class_type','text','prompt','negative_prompt','outputText','title','name','llmInstruction','variablePrompt','variablePrompts','promptSeparator']);
const maxInput=nativeArchiveLimits.media+nativeArchiveLimits.manifest+8*1024**2;

function abort(signal){
 if(signal?.aborted)throw Object.assign(userError('本机工作流导入已中止；原文件及已接收内容保留',499),{name:'AbortError',code:'ABORT_ERR'});
}
function absolute(value,label){
 if(typeof value!=='string'||!path.isAbsolute(value)||path.resolve(value)!==value||/[\u0000-\u001f\u007f]/.test(value))throw userError(label+'须为明确的本机绝对路径');
 return value;
}
async function ordinaryDirectory(value){
 const dir=absolute(value,'接收目录'),stat=await fs.lstat(dir);
 if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(dir)!==dir)throw userError('接收目录不是普通本机目录');
 const fingerprint=directoryMark(stat);
 return {dir,async stable(){const current=await fs.lstat(dir);if(!current.isDirectory()||current.isSymbolicLink()||directoryMark(current)!==fingerprint||await fs.realpath(dir)!==dir)throw userError('本机工作流接收目录已变化');}};
}
async function stableSourceDirectories(directoryMarks){
 for(const record of directoryMarks){let stat;try{stat=await fs.lstat(record.directory);}catch(error){if(error.code==='ENOENT')throw userError('原生库素材源目录身份发生变化');throw error;}
  if(!stat.isDirectory()||stat.isSymbolicLink()||directoryMark(stat)!==record.fingerprint||await fs.realpath(record.directory)!==record.directory)throw userError('原生库素材源目录身份发生变化');
 }
}
async function ordinaryFile(value,limit){
 const file=absolute(value,'源文件'),stat=await fs.lstat(file);
 if(!stat.isFile()||stat.isSymbolicLink()||await fs.realpath(file)!==file||stat.size<1||stat.size>limit)throw userError('本机工作流源文件不是普通文件或超过容量限制');
 const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  if(mark(await handle.stat())!==mark(stat)||await fs.realpath(file)!==file)throw userError('本机工作流源文件在打开时发生变化');
  const fingerprint=mark(stat);
  return {file,handle,size:stat.size,fingerprint,async stable(){const current=await fs.lstat(file);if(!current.isFile()||current.isSymbolicLink()||mark(current)!==fingerprint||mark(await handle.stat())!==fingerprint||await fs.realpath(file)!==file)throw userError('本机工作流源文件在读取时发生变化');}};
 }catch(error){await handle.close();throw error;}
}
async function* chunks(opened,signal){
 let at=0;
 while(at<opened.size){abort(signal);const bytes=Buffer.alloc(Math.min(65536,opened.size-at)),result=await opened.handle.read(bytes,0,bytes.length,at);if(!result.bytesRead)throw userError('本机工作流源文件读取不完整');at+=result.bytesRead;yield bytes.subarray(0,result.bytesRead);}
 abort(signal);await opened.stable();
}
function decodeJson(bytes){
 let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,''));}catch{throw userError('本机工作流不是有效的 UTF-8 JSON');}
 guardNativeTree(value);assertNoCredentials(value);try{validateNativeUrls(value);}catch(error){throw userError(error.message);}return value;
}
function archiveName(value){
 if(typeof value!=='string'||!value||Buffer.byteLength(value)>512||value.startsWith('/')||/[\\\u0000-\u001f\u007f]/.test(value)||/^[a-z]:/i.test(value)||value.split('/').some(part=>!part||part==='.'||part==='..'))throw userError('原生素材清单包含不安全路径');
 return value;
}
function resourceUrls(document){
 const aliases=new Set(document.resources.flatMap(resourceAliases)),urls=new Set(document.resources.map(record=>record.url));
 function walk(value,key=''){
  if(literalFields.has(key))return;
  if(typeof value==='string'){
   if(/^(?:https?:\/\/|\/\/|file:|data:|blob:|\/(?:assets|output|uploads)\/)/i.test(value))urls.add(value);
  }else if(Array.isArray(value))for(const child of value)walk(child,key);
  else if(plain(value))for(const [name,child]of Object.entries(value))walk(child,name);
 }
 for(const node of document.nodes){for(const url of nodeMediaUrls(node,aliases))urls.add(url);walk(node);for(const input of Array.isArray(node.inputs)?node.inputs:[]){const generated=typeof input==='string'&&input.match(/^[\w-]+:generated:\d+:(.+)$/);if(generated)urls.add(generated[1]);}}
 return [...urls];
}
function unresolvedReason(url,sourceRoot){
 if(/^https?:\/\/|^\/\//i.test(url))return 'external-url';
 if(url.startsWith('/assets/library/'))return sourceRoot?'missing-library-file':'source-root-required';
 if(/^\/(assets|output|uploads)\//.test(url))return 'outside-library-scope';
 return 'unsupported-resource-reference';
}
function unsupported(name,parsed,size,missingResources,reason='原生工作流含缺失或不支持的素材引用',format='canvas-fragment'){
 return {kind:'unsupported',format,name,size,sha256:parsed.sha256,sourceKind:parsed.kind,reason,missingResources:missingResources.map(record=>({...record,reference:record.reference?.length>2048?'未打包的内嵌或过长素材引用':record.reference}))};
}
function assetRecord(source,record){
 const id=randomUUID(),extension=path.posix.extname(source.name||record.name).toLowerCase();
 const name=textValue(record.name||source.name,200,'素材名称');
 const asset={id,name,type:source.type,size:source.size,category:'原生工作流',tags:[]};
 return {...source,name,url:record.url,archive:record.archive,portableUrl:'/assets/input/'+id+extension,asset};
}
async function libraryFile(url,sourceRoot){
 const root=absolute(sourceRoot,'源项目根目录'),rootStat=await fs.lstat(root);
 if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||await fs.realpath(root)!==root)throw userError('源项目根目录不是普通本机目录');
 // Decode once, reject encoded separators and every path-navigation component.
 // Neither other assets directories nor URL query strings are in this scope.
 const raw=url.slice('/assets/library/'.length);
 if(!raw||/%(?:2f|5c)/i.test(raw)||/[?#\\\u0000-\u001f\u007f]/.test(raw))throw userError('原生库素材 URL 包含不安全路径');
 let relative;try{relative=decodeURIComponent(raw);}catch{throw userError('原生库素材 URL 编码无效');}
 if(/[?#%\\\u0000-\u001f\u007f]/.test(relative)||relative.split('/').some(part=>!part||part==='.'||part==='..')||/^[a-z]:/i.test(relative)||Buffer.byteLength(relative)>512)throw userError('原生库素材 URL 包含不安全路径');
 const base=path.join(root,'assets','library'),file=path.join(base,...relative.split('/'));
 if(!file.startsWith(base+path.sep))throw userError('原生库素材路径超出范围');
 const directoryMarks=[{directory:root,fingerprint:directoryMark(rootStat)}];let directory=root;
 for(const part of ['assets','library',...relative.split('/').slice(0,-1)]){
  directory=path.join(directory,part);const stat=await fs.lstat(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(directory)!==directory)throw userError('原生库素材源目录不是普通本机目录');
  directoryMarks.push({directory,fingerprint:directoryMark(stat)});
 }
 const stableDirectories=()=>stableSourceDirectories(directoryMarks);
 const opened=await ordinaryFile(file,MAX_STREAM_MEDIA_BYTES);
 const type=fileMediaType({name:relative});
 if(!streamMediaType(type)){await opened.handle.close();throw userError('原生库素材不是支持的图片、视频或音频',415);}
 try{await stableDirectories();}catch(error){await opened.handle.close();throw error;}
 return {...opened,name:path.basename(relative),type,directoryMarks,async stable(){await stableDirectories();await opened.stable();}};
}
async function stageLibraryResource(opened,record,target,signal){
 const name=textValue(record?.name||opened.name,200,'素材名称'),assetId=randomUUID(),extension=path.extname(opened.name).toLowerCase(),file=path.join(target.dir,assetId+'.media');
 if(record&&opened.size!==record.size)throw userError('原生素材清单与文件大小不一致');
 await target.stable();abort(signal);
 const disk=await fs.statfs(target.dir);if(disk.bavail*disk.bsize<opened.size+64*1024**2)throw userError('可用空间不足以接收素材并保留64MiB余量',507);
 const output=await fs.open(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600),hash=createHash('sha256');let prefix=Buffer.alloc(0),size=0;
 try{
  for await(const bytes of chunks(opened,signal)){
   if(prefix.length<64){prefix=Buffer.concat([prefix,bytes.subarray(0,64-prefix.length)]);if(prefix.length===Math.min(64,opened.size))checkMediaHeader(prefix,opened.type);}
   let offset=0;while(offset<bytes.length){abort(signal);const written=await output.write(bytes,offset,bytes.length-offset);if(!written.bytesWritten)throw userError('原生库素材写入中断');offset+=written.bytesWritten;}
   size+=bytes.length;hash.update(bytes);
  }
  checkMediaHeader(prefix,opened.type);await output.sync();abort(signal);await opened.stable();await target.stable();
  const stat=await output.stat();if(!stat.isFile()||stat.size!==size||await fs.realpath(file)!==file||mark(await fs.lstat(file))!==mark(stat))throw userError('原生库素材接收文件已变化');
 }finally{await output.close();}
 const asset={id:assetId,name,type:opened.type,size,category:'原生工作流',tags:[]};
 return {file,name,type:opened.type,size,sha256:hash.digest('hex'),url:record.url,archive:record.archive,portableUrl:'/assets/input/'+assetId+extension,asset,sourceFile:opened.file,sourceFingerprint:opened.fingerprint,directoryMarks:opened.directoryMarks};
}

/** Inspect only the named file. Media is staged into an existing, service-owned
 * directory; no project, catalog entry, network request, or source JSON is written.
 * Unsupported dependencies return a serializable `kind: 'unsupported'` result.
 * Invalid files, unsafe paths, credentials, and corrupt ZIPs throw a user error.
 */
export async function inspectNativeLibraryWorkflow({file,directory,name,sourceRoot,signal}={}){
 abort(signal);const workflowName=textValue(name,120,'工作流名称');assertNoCredentials({name:workflowName});
 const target=await ordinaryDirectory(directory),opened=await ordinaryFile(file,maxInput),stream=Readable.from(chunks(opened,signal));let parsed;
 try{
  parsed=await readNativeArchive(stream,{directory:target.dir});abort(signal);await opened.stable();await target.stable();
 }catch(error){abort(signal);throw error;}finally{stream.destroy();await opened.handle.close();}
 const value=decodeJson(parsed.json);abort(signal);
 const graph=plain(value)&&Object.keys(value).length===1&&plain(value.prompt)?value.prompt:value;
 if(parsed.kind==='json'&&plain(graph)&&Object.keys(graph).length&&Object.values(graph).every(node=>plain(node)&&typeof node.class_type==='string'&&plain(node.inputs))){
  if(Object.keys(graph).length>500||JSON.stringify(graph).length>2_000_000)return unsupported(workflowName,parsed,opened.size,[],'ComfyUI API 模板超过500节点或2,000,000字符限制','comfy');
  const workflow=structuredClone(graph),inspection=inspectWorkflow(workflow),fields=normalizeFields(workflow,[]),missing=[];
  function inputUrls(item,id,field,key=field){if(literalFields.has(key))return;if(typeof item==='string'&&/^(?:https?:\/\/|\/\/|file:|data:|blob:|\/(?:assets|output|uploads)\/)/i.test(item))missing.push({nodeId:id,field,reference:item,reason:'unsupported-comfy-resource-url'});else if(Array.isArray(item))for(const child of item)inputUrls(child,id,field,key);else if(plain(item))for(const [name,child]of Object.entries(item))inputUrls(child,id,field,name);}
  for(const [id,node]of Object.entries(workflow))for(const [field,item]of Object.entries(node.inputs))inputUrls(item,id,field);
  if(missing.length)return unsupported(workflowName,parsed,opened.size,missing,'ComfyUI API 模板含尚未迁移的媒体 URL','comfy');
  abort(signal);return {kind:'comfy',workflow,inspection,fields,name:workflowName,size:opened.size,sha256:parsed.sha256,sourceKind:parsed.kind};
 }
 if(!Array.isArray(value)&&!(plain(value)&&(Object.hasOwn(value,'nodes')||Object.hasOwn(value,'format')||plain(value.workflow)&&Object.hasOwn(value.workflow,'nodes'))))return unsupported(workflowName,parsed,opened.size,[],'JSON 顶层结构不是已支持的 ComfyUI API 模板或 Infinite Canvas 原生文档','unknown');
 const document=parseNativeJson(parsed.json),resources=[],missingResources=[],used=new Set(),byArchive=new Map(parsed.resources.map(record=>[record.archive,record]));
 let total=0;
 if(parsed.kind==='zip'){
  for(const record of document.resources){
   archiveName(record.archive);
   const source=byArchive.get(record.archive)||byArchive.get(path.posix.join(path.posix.dirname(parsed.manifestName),record.archive));
   if(!source){missingResources.push({reference:record.url,archive:record.archive,reason:'missing-zip-resource'});continue;}
   if(used.has(source.archive))throw userError('多个原生素材清单记录指向同一 ZIP 文件');
   if(source.size!==record.size)throw userError('原生素材清单与文件大小不一致');
   used.add(source.archive);resources.push(assetRecord(source,record));total+=source.size;
  }
  if(parsed.resources.some(record=>!used.has(record.archive)))throw userError('ZIP 中存在未列入 resources 清单的素材');
 }
 const aliases=new Set(resources.flatMap(resourceAliases)),recordAliases=new Map();
 for(const record of document.resources)for(const alias of resourceAliases(record)){if(recordAliases.has(alias)&&recordAliases.get(alias)!==record)throw userError('原生素材清单别名重复');recordAliases.set(alias,record);}
 for(const url of resourceUrls(document)){
  abort(signal);if(aliases.has(url)||missingResources.some(record=>record.reference===url))continue;
  const record=recordAliases.get(url),reference=record?.url||url;
  if(parsed.kind==='json'&&sourceRoot&&reference.startsWith('/assets/library/')){
   let source;
   try{source=await libraryFile(reference,sourceRoot);total+=source.size;if(total>nativeArchiveLimits.media||resources.length>=nativeArchiveLimits.files)throw userError('原生素材总量或数量超过上限');const archive=record?.archive||'resources/'+randomUUID()+path.extname(source.name);archiveName(archive);const resource=await stageLibraryResource(source,record||{url:reference,archive,name:source.name,size:source.size},target,signal);resources.push(resource);for(const alias of resourceAliases(resource))aliases.add(alias);}
   catch(error){if(error.code!=='ENOENT')throw error;missingResources.push({reference,reason:'missing-library-file'});}
   finally{await source?.handle.close();}
  }else missingResources.push({reference,reason:unresolvedReason(reference,sourceRoot)});
 }
 abort(signal);await target.stable();
 if(missingResources.length)return unsupported(workflowName,parsed,opened.size,missingResources);
 const project=nativeToFragment(document,resources,workflowName),summary=nativeFragmentSummary(project);assertNoCredentials(project);
 const unresolved=project.nodes.flatMap(node=>node.params.nativeCanvas.missingResources);
 if(unresolved.length)return unsupported(workflowName,parsed,opened.size,[...new Set(unresolved)].map(reference=>({reference,reason:unresolvedReason(reference,sourceRoot)})));
 const sourceFiles=resources.filter(resource=>resource.sourceFile).map(resource=>({file:resource.sourceFile,size:resource.size,sha256:resource.sha256,fingerprint:resource.sourceFingerprint,directoryMarks:resource.directoryMarks}));
 for(const source of sourceFiles)await stableSourceDirectories(source.directoryMarks);
 abort(signal);return {kind:'canvas-fragment',project,resources,sourceFiles,summary,name:workflowName,size:opened.size,sha256:parsed.sha256,sourceKind:parsed.kind,bytes:total};
}
