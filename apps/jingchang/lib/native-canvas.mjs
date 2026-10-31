import {promises as fs,constants} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {atomicJson,readJson,safeId,userError,textValue,assertNoCredentials} from './workspace.mjs';
import {readNativeArchive,nativeArchiveLimits} from './native-canvas-archive.mjs';
import {parseNativeJson,nodeMediaUrls,nativeToFragment,nativeFragmentSummary,fragmentToNative} from './native-canvas-core.mjs';
import {fileMediaType,streamMediaType} from '../public/media-transfer-core.js';
import {checkMediaHeader} from './stream-assets.mjs';
import {writeNativeZip} from './native-canvas-export.mjs';

const checked=id=>{if(!safeId(id))throw userError('原生工作流请求编号无效');return id;};
function archiveName(value){if(typeof value!=='string'||!value||Buffer.byteLength(value)>512||value.startsWith('/')||/[\\\u0000-\u001f\u007f]/.test(value)||/^[a-z]:/i.test(value)||value.split('/').some(x=>!x||x==='.'||x==='..'))throw userError('原生素材清单包含不安全路径');return value;}
export function nativeCanvasService({data,bundles,catalog}){
 const pending=new Set();
 async function directory(...parts){const root=await fs.realpath(data);let dir=root;for(const part of ['native-canvas',...parts]){dir=path.join(dir,part);await fs.mkdir(dir,{recursive:true});if(await fs.realpath(dir)!==dir||(await fs.lstat(dir)).isSymbolicLink())throw userError('原生工作流接收目录不是普通目录');}return dir;}
 async function safeJson(file,limit=2*1024**2){const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||await fs.realpath(file)!==file||st.size>limit)throw userError('原生工作流记录无效');const value=await readJson(file);assertNoCredentials(value);return value;}
 async function get(requestId){checked(requestId);let result;try{result=await safeJson(path.join(await directory('requests'),requestId+'.json'));}catch(e){if(e.code==='ENOENT')throw userError('原生工作流尚未接收完成，请用原编号重新选择同一文件',404);throw e;}if(result.id!==requestId||!safeId(result.exported?.id)||!safeId(result.stageId)||!/^[a-f0-9]{64}$/.test(result.sha256))throw userError('原生工作流接收记录无效');return result;}
 async function list(){const dir=await directory('requests'),out=[];for(const name of await fs.readdir(dir)){if(!/^[\w-]+\.json$/.test(name))continue;out.push(await get(name.slice(0,-5)));}return out.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,200);}
 async function inspect(stream,payload){
  checked(payload.requestId);assertNoCredentials(payload);if(pending.has(payload.requestId))throw userError('此原生工作流正在接收，请读取原编号',409);pending.add(payload.requestId);
  try{
   const name=textValue(payload.name,120,'工作流名称'),stageId=randomUUID(),dir=await directory('imports',stageId),parsed=await readNativeArchive(stream,{directory:dir}),document=parseNativeJson(parsed.json);
   let previous;try{previous=await get(payload.requestId);}catch(e){if(e.status!==404)throw e;}
   if(previous){if(previous.sha256!==parsed.sha256||previous.name!==name)throw userError('此接收编号已用于另一文件或名称，已接收文件保留',409);return previous;}
   const resources=[],byArchive=new Map(parsed.resources.map(r=>[r.archive,r])),used=new Set(),allUrls=new Set(document.nodes.flatMap(n=>nodeMediaUrls(n)));let total=0;
   for(const record of document.resources){
    archiveName(record.archive);const source=byArchive.get(record.archive)||byArchive.get(path.posix.join(path.posix.dirname(parsed.manifestName||''),record.archive));if(!source)continue;
    if(source.size!==record.size)throw userError('原生素材清单与文件大小不一致：'+record.name);used.add(source.archive);total+=source.size;
    const asset={id:randomUUID(),name:textValue(record.name,200,'素材名称'),type:source.type,size:source.size,category:'原生工作流',tags:[]};resources.push({...source,url:record.url,archive:record.archive,asset});
   }
   if(parsed.resources.some(r=>!used.has(r.archive)))throw userError('ZIP 中存在未列入 resources 清单的素材');
   for(const url of allUrls){
    if(!url.startsWith('data:'))continue;const match=/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);if(!match||!streamMediaType(match[1]))throw userError('不支持原生内嵌素材的格式');const bytes=Buffer.from(match[2],'base64');if(!bytes.length||bytes.toString('base64')!==match[2])throw userError('原生内嵌素材编码无效');checkMediaHeader(bytes.subarray(0,64),match[1]);total+=bytes.length;if(total>nativeArchiveLimits.media||resources.length>=nativeArchiveLimits.files)throw userError('原生素材总量或数量超过上限');const assetId=randomUUID(),extension=fileMediaType({name:'inline.'+match[1].split('/')[1]})===match[1]?match[1].split('/')[1]:match[1]==='image/jpeg'?'jpg':match[1]==='audio/mpeg'?'mp3':'media',file=path.join(dir,assetId+'.media');const disk=await fs.statfs(dir);if(disk.bavail*disk.bsize<bytes.length+64*1024**2)throw userError('可用空间不足以接收内嵌素材并保留64MiB余量',507);await fs.writeFile(file,bytes,{flag:'wx'});const asset={id:assetId,name:'内嵌素材.'+extension,type:match[1],size:bytes.length,category:'原生工作流',tags:[]};resources.push({url,portableUrl:'/assets/input/'+assetId+'.'+extension,archive:'resources/'+assetId+'.'+extension,file,size:bytes.length,type:match[1],sha256:createHash('sha256').update(bytes).digest('hex'),asset});
   }
   const project=nativeToFragment(document,resources,name),unpacked=document.resources.filter(r=>!resources.some(x=>x.archive===r.archive)).map(r=>r.url);if(unpacked.length)project.nodes[0].params.nativeCanvas.missingResources=[...new Set([...project.nodes[0].params.nativeCanvas.missingResources,...unpacked])];
   // Schema and credential checks have completed before any JSON reaches disk.
   await fs.writeFile(path.join(dir,'workflow.json'),JSON.stringify(document),{flag:'wx'});
   const exported=await bundles.exportPreparedFragment(project,resources),preview={id:payload.requestId,name,stageId,sha256:parsed.sha256,kind:parsed.kind,nodes:project.nodes.length,edges:project.edges.length,groups:project.nodes.filter(n=>['group','promptGroup','smart-group'].includes(n.params?.nativeCanvas?.node.type)).length,assets:project.assets.length,bytes:total,...nativeFragmentSummary(project),exported,createdAt:new Date().toISOString()};
   await fs.writeFile(path.join(await directory('requests'),payload.requestId+'.json'),JSON.stringify(preview),{flag:'wx'});return preview;
  }finally{pending.delete(payload.requestId);}
 }
 async function save(requestId,payload){const preview=await get(requestId);await bundles.nativeSourceFromExport(preview.exported.id);return catalog.importPreparedWorkflow(preview.exported,payload);}
 async function exportFile(payload){
  assertNoCredentials(payload);if(!['json','zip'].includes(payload.type))throw userError('请选择原生 JSON 或 ZIP');
  const source=payload.itemId?await catalog.nativeSource(checked(payload.itemId)):await bundles.nativeSource(checked(payload.projectId),payload.revision,payload.nodeIds);
  if(source.assets.some(a=>!streamMediaType(a.type)))throw userError('原生导出支持图片、视频和音频；其它文件请使用 .jingchang 导出');
  const document=fragmentToNative(source.project,source.assets,{withResources:payload.type==='zip'}),id=randomUUID(),dir=await directory('exports',id),file=path.join(dir,'workflow.'+payload.type);
  let size;if(payload.type==='zip')({size}=await writeNativeZip(file,document,source.assets,source.sources));else{const bytes=Buffer.from(JSON.stringify(document,null,2));if(bytes.length>nativeArchiveLimits.manifest)throw userError('原生 JSON 配置超过12MiB');await fs.writeFile(file,bytes,{flag:'wx'});size=bytes.length;}
  const result={id,name:source.project.name,type:payload.type,size,nodes:document.nodes.length,edges:document.connections.length,assets:source.assets.length,url:'/api/native-canvas/exports/'+id+'/download',...nativeFragmentSummary(source.project)};await atomicJson(path.join(dir,'ready.json'),result);return result;
 }
 async function download(id){checked(id);const dir=await directory('exports',id),result=await safeJson(path.join(dir,'ready.json'));if(result.id!==id||!['json','zip'].includes(result.type))throw userError('原生导出记录无效');const file=path.join(dir,'workflow.'+result.type),st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||await fs.realpath(file)!==file||st.size!==result.size)throw userError('原生导出文件已变化');return {file,name:result.name+'.'+result.type,type:result.type==='zip'?'application/zip':'application/json'};}
 return {inspect,get,list,save,exportFile,download};
}
