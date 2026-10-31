import path from 'node:path';
import {promises as fs,constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {atomicJson,readJson,safeId,textValue,userError,loadAsset} from './workspace.mjs';
import {checkMediaHeader} from './stream-assets.mjs';
import {MAX_STREAM_MEDIA_BYTES,fileMediaType} from '../public/media-transfer-core.js';

export const SHARED_SCAN_MAX_ENTRIES=8000,SHARED_IMPORT_MAX_FILES=200;
const extensions=new Set(['.png','.jpg','.jpeg','.webp','.gif','.bmp','.mp4','.webm','.mov','.m4v','.mkv','.mp3','.wav','.m4a','.aac','.ogg','.flac']);
const stamp=()=>new Date().toISOString();
const id=value=>{if(!safeId(value))throw userError('共享文件夹或导入编号无效');return value;};
const mark=stat=>`${stat.dev}/${stat.ino}/${stat.size}/${stat.mtimeMs}/${stat.ctimeMs}`;
const identity=stat=>`${stat.dev}/${stat.ino}`;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inside=(root,file)=>file!==root&&file.startsWith(root+path.sep);
const publicJob=({snapshot,...job})=>job;
const stopped=signal=>{if(signal?.aborted)throw userError('本机导入已停止',409);};
function relativeFile(value){
 if(typeof value!=='string'||!value||value.length>2048||/[\x00-\x1f\x7f]/.test(value))throw userError('媒体相对路径无效');
 const normalized=value.replace(/\\/g,'/');
 if(path.posix.isAbsolute(normalized)||/^[a-z]:/i.test(normalized)||normalized.split('/').some(part=>!part||part==='..'||part==='.'||part.startsWith('.')))throw userError('只允许文件夹内不含隐藏目录的媒体路径');
 return normalized;
}
function selection(payload){
 if(!Array.isArray(payload.paths)||!payload.paths.length||payload.paths.length>SHARED_IMPORT_MAX_FILES)throw userError('每批请选择1–200份媒体');
 const items=payload.paths.map(value=>{const item=typeof value==='string'?{path:value}:value;if(!item||typeof item!=='object')throw userError('媒体路径无效');const file=relativeFile(item.path);if(!extensions.has(path.extname(file).toLowerCase()))throw userError('仅支持共享文件夹中的图片、视频和音频',415);if(item.fingerprint!==undefined&&!/^[a-f0-9]{64}$/.test(item.fingerprint))throw userError('文件预览校验无效');return {path:file,...(item.fingerprint?{fingerprint:item.fingerprint}:{})};});
 if(new Set(items.map(item=>item.path)).size!==items.length)throw userError('本批媒体路径重复');
 return {projectId:id(payload.projectId),folderId:id(payload.folderId),category:payload.category===undefined||payload.category===''?'':textValue(payload.category,80,'素材分类'),paths:items};
}

// A grant applies to one ordinary project subfolder, not to the rest of the computer.
export function sharedFolderService({root,data,activeJobs,streamAssets,projects,maxEntries=SHARED_SCAN_MAX_ENTRIES}){
 const preparing=new Set();let registryQueue=Promise.resolve();
 const serialize=fn=>{const task=registryQueue.catch(()=>{}).then(fn);registryQueue=task;return task;};
 async function base(){const canonical=await fs.realpath(data),dir=path.join(canonical,'shared-folders');await fs.mkdir(dir,{recursive:true});if(await fs.realpath(dir)!==dir||(await fs.lstat(dir)).isSymbolicLink())throw userError('共享文件夹记录目录不是普通目录');return dir;}
 async function registryRead(folderId){const dir=await base(),file=path.join(dir,id(folderId)+'.json');if(await fs.realpath(file)!==file)throw userError('共享文件夹记录不是普通文件');const stat=await fs.lstat(file);if(!stat.isFile()||stat.size>16384)throw userError('共享文件夹记录无效');const row=await readJson(file);if(row.id!==folderId||typeof row.name!=='string'||!row.name||row.name.length>80||!/^\d+\/\d+$/.test(row.identity))throw userError('共享文件夹记录无效');relativeFile(row.rel);return row;}
 async function registryRows(){const dir=await base(),names=(await fs.readdir(dir)).filter(name=>/^[\w-]+\.json$/.test(name));if(names.length>1000)throw userError('共享文件夹记录过多');return Promise.all(names.map(name=>registryRead(name.slice(0,-5))));}
 async function putFolder(row){await atomicJson(path.join(await base(),row.id+'.json'),row);}
 async function ordinaryChain(start,target){
  const parts=path.relative(start,target).split(path.sep).filter(Boolean);if(target!==start&&!inside(start,target)||parts.length>64)throw userError('文件夹路径超出已允许范围');
  let current=start;const chain=[];
  for(const part of ['',...parts]){if(part)current=path.join(current,part);const stat=await fs.lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(current)!==current)throw userError('文件夹及其父目录不能是符号链接');chain.push({path:current,identity:identity(stat)});}
  return chain;
 }
 async function resolveFolder(row){
  if(row.disabledAt)throw userError('此共享文件夹已停用；重新添加后才能读取',409);
  const canonical=await fs.realpath(root),rel=relativeFile(row.rel),absolute=path.resolve(canonical,rel);if(!inside(canonical,absolute))throw userError('共享文件夹不在项目目录内');
  const chain=await ordinaryChain(canonical,absolute);if(chain.at(-1).identity!==row.identity)throw userError('共享文件夹已被替换，请重新添加并核对',409);
  return {row,absolute,chain};
 }
 async function folderView(row){const absolute=path.resolve(await fs.realpath(root),row.rel);let exists=false,changed=false;try{const stat=await fs.lstat(absolute);exists=stat.isDirectory();changed=!exists||stat.isSymbolicLink()||await fs.realpath(absolute)!==absolute||identity(stat)!==row.identity;}catch{}return {id:row.id,name:row.name,rel:row.rel,path:absolute,exists,changed,disabled:!!row.disabledAt,createdAt:row.createdAt,updatedAt:row.updatedAt};}
 async function list(){return {root:await fs.realpath(root),maxFiles:SHARED_IMPORT_MAX_FILES,maxEntries:SHARED_SCAN_MAX_ENTRIES,folders:await Promise.all((await registryRows()).map(folderView))};}
 async function register(payload){return serialize(async()=>{
  const canonical=await fs.realpath(root),raw=textValue(payload.path,2048,'项目子文件夹路径').replace(/^(["'])(.*)\1$/,'$2');
  if(/[\x00-\x1f\x7f]/.test(raw))throw userError('文件夹路径无效');const logical=path.resolve(root),candidate=path.resolve(logical,raw),from=inside(logical,candidate)?logical:inside(canonical,candidate)?canonical:null;
  if(!from)throw userError('只能添加项目目录内的子文件夹，不能添加项目根目录');const rel=path.relative(from,candidate).split(path.sep).join('/'),absolute=path.resolve(canonical,rel);relativeFile(rel);const chain=await ordinaryChain(canonical,absolute),rows=await registryRows(),old=rows.find(item=>item.rel===rel);
  if(!old&&rows.length>=100)throw userError('最多添加100个共享文件夹');const name=payload.name===undefined||payload.name===''?path.basename(absolute).slice(0,80):textValue(payload.name,80,'文件夹名称');
  const row={id:old?.id||randomUUID(),rel,name,identity:chain.at(-1).identity,createdAt:old?.createdAt||stamp(),updatedAt:stamp()};await putFolder(row);return {folder:await folderView(row)};
 });}
 async function disable(folderId){return serialize(async()=>{const row=await registryRead(id(folderId));row.disabledAt=stamp();row.updatedAt=stamp();await putFolder(row);for(const job of activeJobs.values())if(job.kind==='folder-import'&&job.folderId===folderId)job.controller.abort();return {folder:await folderView(row)};});}
 async function openFile(folderId,file,fingerprint){
  const resolved=await resolveFolder(await registryRead(id(folderId))),relative=relativeFile(file),absolute=path.resolve(resolved.absolute,relative);
  if(!inside(resolved.absolute,absolute)||!extensions.has(path.extname(absolute).toLowerCase()))throw userError('文件不属于此共享媒体文件夹',415);
  const chain=await ordinaryChain(resolved.absolute,path.dirname(absolute));let handle;
  try{
   const before=await fs.lstat(absolute);if(!before.isFile()||before.isSymbolicLink()||await fs.realpath(absolute)!==absolute)throw userError('媒体必须是普通文件，不能是符号链接');if(before.size<1||before.size>MAX_STREAM_MEDIA_BYTES)throw userError('共享媒体须为1字节至4GB',413);
   handle=await fs.open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await handle.stat();if(mark(stat)!==mark(before))throw userError('打开时媒体发生变化，请刷新文件列表',409);
   const token=digest([folderId,resolved.row.identity,relative,mark(stat)]);if(fingerprint&&fingerprint!==token)throw userError('媒体已变化，请刷新列表并重新选择',409);
   const type=fileMediaType({name:relative,type:''}),prefix=Buffer.alloc(Math.min(64,stat.size)),read=await handle.read(prefix,0,prefix.length,0);checkMediaHeader(prefix.subarray(0,read.bytesRead),type);
   async function assertStable(){const current=await resolveFolder(await registryRead(folderId));if(current.row.identity!==resolved.row.identity)throw userError('共享文件夹已变化，未加入素材库',409);for(const part of [...resolved.chain,...chain]){const st=await fs.lstat(part.path);if(!st.isDirectory()||st.isSymbolicLink()||identity(st)!==part.identity||await fs.realpath(part.path)!==part.path)throw userError('读取期间文件夹发生变化，未加入素材库',409);}const st=await fs.lstat(absolute);if(!st.isFile()||st.isSymbolicLink()||await fs.realpath(absolute)!==absolute||mark(st)!==mark(stat)||mark(await handle.stat())!==mark(stat))throw userError('读取期间媒体发生变化，未加入素材库',409);}
   await assertStable();return {handle,stat,type,name:path.basename(relative).slice(0,200),relativePath:relative,fingerprint:token,assertStable};
  }catch(error){await handle?.close();if(error.code==='ENOENT')throw userError('媒体或共享文件夹已不存在',404);throw error.status?error:userError('无法读取此本机媒体');}
 }
 async function tree(folderId){
  const resolved=await resolveFolder(await registryRead(id(folderId)));let visited=0,mediaCount=0,skipped=0,truncated=false;
  async function scan(absolute,relative,name,depth=0){const node={id:folderId+':'+(relative||'__root__'),name,path:relative,items:[],children:[]};if(depth>64){truncated=true;return node;}let entries;
   try{await ordinaryChain(resolved.absolute,absolute);entries=await fs.readdir(absolute,{withFileTypes:true});}catch{skipped++;return node;}
   entries.sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name,'zh-CN'));
   for(const entry of entries){if(visited>=maxEntries){truncated=true;break;}visited++;if(entry.name.startsWith('.')||entry.isSymbolicLink()){skipped++;continue;}const file=relative?relative+'/'+entry.name:entry.name,target=path.join(absolute,entry.name);
    if(entry.isDirectory()){const child=await scan(target,file,entry.name,depth+1);if(child.items.length||child.children.length)node.children.push(child);}
    else if(entry.isFile()&&extensions.has(path.extname(entry.name).toLowerCase())){try{const stat=await fs.lstat(target);if(!stat.isFile()||stat.isSymbolicLink()||await fs.realpath(target)!==target){skipped++;continue;}const type=fileMediaType({name:file,type:''});mediaCount++;node.items.push({id:folderId+':'+file,name:entry.name,relativePath:file,folderId,kind:type.split('/')[0],type,size:stat.size,lastModified:stat.mtimeMs,fingerprint:digest([folderId,resolved.row.identity,file,mark(stat)]),url:'/api/shared-folders/'+folderId+'/file?path='+encodeURIComponent(file)});}catch{skipped++;}}
   }return node;
  }
  const tree=await scan(resolved.absolute,'',resolved.row.name);await resolveFolder(resolved.row);return {folder:await folderView(resolved.row),tree,mediaCount,visited,skipped,truncated,maxEntries};
 }
 async function jobPath(jobId){const canonical=await fs.realpath(data),dir=path.join(canonical,'jobs');await fs.mkdir(dir,{recursive:true});if(await fs.realpath(dir)!==dir)throw userError('导入任务目录不是普通目录');return path.join(dir,id(jobId)+'.json');}
 async function readJob(jobId,projectId){await projects.load(id(projectId));const file=await jobPath(jobId);if(await fs.realpath(file)!==file)throw userError('导入记录不是普通文件');const stat=await fs.lstat(file);if(!stat.isFile()||stat.size>2*1024*1024)throw userError('导入记录无效');const job=await readJson(file);if(job.kind!=='folder-import'||job.id!==jobId||job.projectId!==projectId)throw userError('导入记录不属于当前项目',403);if(!Array.isArray(job.items)||!job.items.length||job.items.length>SHARED_IMPORT_MAX_FILES||!Array.isArray(job.snapshot?.paths)||job.snapshot.paths.length!==job.items.length||!safeId(job.folderId))throw userError('导入记录内容无效');for(let index=0;index<job.items.length;index++){const item=job.items[index],source=job.snapshot.paths[index];if(relativeFile(item.relativePath)!==relativeFile(source.path)||! /^[a-f0-9]{64}$/.test(source.fingerprint))throw userError('导入文件记录无效');}return job;}
 const writeJob=async job=>{job.updatedAt=stamp();await atomicJson(await jobPath(job.id),job);};
 async function finalize(job,item,asset){const file=path.join(await fs.realpath(data),'assets',asset.id+'.json');const current=await loadAsset(data,asset.id);if(current.source==='stream-import'){current.source='shared-folder';current.category=job.category;await atomicJson(file,current);}Object.assign(item,{status:'completed',asset:current,bytesReceived:current.size,error:''});return current;}
 async function reconcile(job,persist=true){let changed=false;for(const item of job.items){if(item.status==='completed'||!item.streamRequestId)continue;try{const receipt=await streamAssets.get(item.streamRequestId,job.projectId);if(receipt.status==='completed'){await finalize(job,item,receipt.asset);changed=true;}else if(item.status==='importing'){item.status='interrupted';item.bytesReceived=receipt.bytesReceived;changed=true;}}catch(e){if(item.status==='importing'){item.status='interrupted';changed=true;}}}if(job.items.every(item=>item.status==='completed')&&job.status!=='completed'){job.status='completed';job.message=`已保存 ${job.items.length}/${job.items.length} 份本机副本，原记录已恢复`;changed=true;}if(changed&&persist)await writeJob(job);return job;}
 async function get(jobId,projectId){let job=await readJob(id(jobId),projectId),running=activeJobs.get(jobId);if(!running&&!preparing.has(jobId)){job=await readJob(jobId,projectId);running=activeJobs.get(jobId);}if(running?.kind==='folder-import'){job=structuredClone(running.job);for(const item of job.items)if(item.status==='importing')item.bytesReceived=activeJobs.get('asset-import-'+item.streamRequestId)?.bytesReceived||0;}else if(!preparing.has(jobId)){if(['queued','running'].includes(job.status)){job.status='interrupted';job.message='服务已中断。完成的本机副本保留，继续导入只处理未完成项。';}job=await reconcile(job,false);}return {...publicJob(job),canResume:['interrupted','cancelled','partial','failed'].includes(job.status)&&job.items.some(item=>item.status!=='completed')};}
 async function listImports(projectId){await projects.load(id(projectId));const dir=path.dirname(await jobPath('probe')),names=(await fs.readdir(dir)).filter(file=>/^[\w-]+\.json$/.test(file)),rows=[];for(const name of names){const row=await readJson(path.join(dir,name)).catch(()=>null);if(row?.kind==='folder-import'&&row.projectId===projectId)rows.push(row);}rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));return Promise.all(rows.slice(0,200).map(row=>get(row.id,projectId)));}
 async function copyFile(opened,signal){return (async function*(){try{let position=0;while(position<opened.stat.size){stopped(signal);const bytes=Buffer.alloc(Math.min(65536,opened.stat.size-position)),read=await opened.handle.read(bytes,0,bytes.length,position);if(!read.bytesRead)throw userError('媒体读取中断，未加入素材库');position+=read.bytesRead;yield bytes.subarray(0,read.bytesRead);}stopped(signal);await opened.assertStable();stopped(signal);}finally{await opened.handle.close();}})();}
 function launch(job){const controller=new AbortController(),running={kind:'folder-import',projectId:job.projectId,folderId:job.folderId,controller,job};activeJobs.set(job.id,running);Promise.resolve().then(async()=>{
   try{job.status='running';job.message='正在复制所选本机媒体';await writeJob(job);
    for(let index=0;index<job.items.length;index++){const item=job.items[index];if(item.status==='completed')continue;stopped(controller.signal);let opened;
     try{opened=await openFile(job.folderId,item.relativePath,job.snapshot.paths[index].fingerprint);stopped(controller.signal);item.attempt=(item.attempt||0)+1;item.streamRequestId=randomUUID();item.status='importing';item.bytesReceived=0;item.error='';await writeJob(job);
      const stream=await copyFile(opened,controller.signal);const asset=await streamAssets.importFile(stream,{requestId:item.streamRequestId,projectId:job.projectId,name:opened.name,type:opened.type,size:opened.stat.size});await finalize(job,item,asset);await writeJob(job);
     }catch(error){if(controller.signal.aborted)throw error;item.status='failed';item.error=error.status?error.message:'此媒体未导入，请刷新列表核对文件';await writeJob(job);}finally{await opened?.handle.close().catch(()=>{});}
    }
    const complete=job.items.filter(item=>item.status==='completed').length;job.status=complete===job.items.length?'completed':complete?'partial':'failed';job.message=`已保存 ${complete}/${job.items.length} 份本机副本${complete===job.items.length?'':'；未完成项保留具体原因'}`;await writeJob(job);
   }catch(error){job.status=controller.signal.aborted?'cancelled':'interrupted';for(const item of job.items)if(item.status==='importing')item.status='interrupted';job.message=controller.signal.aborted?'本机导入已停止；完成副本和收到的部分文件保留。':'本机导入中断；完成副本和收到的部分文件保留。';await writeJob(job).catch(()=>{});}
   finally{activeJobs.delete(job.id);}
  });}
 async function start(payload){const selected=selection(payload),jobId=id(payload.requestId),signature=digest(selected);await projects.load(selected.projectId);
  if(preparing.has(jobId))throw userError('本批正在准备，请读取原编号',409);preparing.add(jobId);
  try{try{const old=await readJob(jobId,selected.projectId);if(old.signature!==signature)throw userError('此导入编号已用于另一批媒体',409);return get(jobId,selected.projectId);}catch(e){if(e.code!=='ENOENT')throw e;}
   const folder=await registryRead(selected.folderId);await resolveFolder(folder);const snapshots=[],items=[];
   for(const value of selected.paths){const opened=await openFile(selected.folderId,value.path,value.fingerprint);try{snapshots.push({path:value.path,fingerprint:opened.fingerprint});items.push({relativePath:value.path,name:opened.name,type:opened.type,size:opened.stat.size,status:'pending',bytesReceived:0,attempt:0});}finally{await opened.handle.close();}}
   const job={id:jobId,requestId:jobId,kind:'folder-import',projectId:selected.projectId,folderId:selected.folderId,name:'共享文件夹导入 · '+folder.name,category:selected.category,status:'queued',message:'已记录本批媒体，等待本机复制',signature,items,snapshot:{paths:snapshots},createdAt:stamp(),updatedAt:stamp(),applied:false};await writeJob(job);launch(job);return publicJob(job);
  }finally{preparing.delete(jobId);}
 }
 async function resume(jobId,payload){const projectId=id(payload.projectId);if(preparing.has(jobId)||activeJobs.has(jobId))throw userError('本批仍在运行，请读取原记录',409);preparing.add(jobId);try{const job=await reconcile(await readJob(id(jobId),projectId));if(['queued','running'].includes(job.status))job.status='interrupted';if(!['interrupted','cancelled','partial','failed'].includes(job.status))throw userError('这批导入无需继续',409);await resolveFolder(await registryRead(job.folderId));if(job.items.every(item=>item.status==='completed')){job.status='completed';job.message='原导入已完成，已恢复本机副本记录';await writeJob(job);return publicJob(job);}job.status='queued';job.message='继续处理未完成媒体，已完成副本不会重新复制';await writeJob(job);launch(job);return publicJob(job);}finally{preparing.delete(jobId);}}
 async function cancel(jobId,projectId){await readJob(id(jobId),id(projectId));activeJobs.get(jobId)?.controller.abort();return get(jobId,projectId);}
 async function apply(jobId,payload){if(activeJobs.has(jobId)||preparing.has(jobId))throw userError('请等待本批完成或停止，再加入项目',409);preparing.add(jobId);try{const job=await readJob(id(jobId),id(payload.projectId));await reconcile(job);const completed=job.items.filter(item=>item.status==='completed');if(!completed.length)throw userError('本批还没有完成的本机副本');for(const item of completed){const receipt=await streamAssets.get(item.streamRequestId,job.projectId);if(receipt.status!=='completed'||receipt.asset.id!==item.asset.id)throw userError('已完成媒体与导入记录不一致');}const project=await projects.attach(job,completed.map(item=>item.asset),payload.revision);job.applied=true;await writeJob(job);return project;}finally{preparing.delete(jobId);}}
 async function recover(){const dir=path.dirname(await jobPath('probe'));for(const name of (await fs.readdir(dir)).filter(name=>/^[\w-]+\.json$/.test(name))){const saved=await readJson(path.join(dir,name)).catch(()=>null);if(saved?.kind!=='folder-import')continue;try{const job=await readJob(saved.id,saved.projectId);if(['running','queued'].includes(job.status)){job.status='interrupted';job.message='服务重启，完成副本保留；继续导入只处理未完成项。';await writeJob(job);}await reconcile(job);}catch{/* Preserve unreadable records; they must not stop the local service. */}}}

 return {list,register,disable,tree,openFile,start,get,listImports,resume,cancel,apply,recover};
}

// Serve the already checked descriptor: never reopen a source path after validation.
export async function serveSharedMedia(req,res,opened){
 try{const size=opened.stat.size;let start=0,end=size-1,status=200;res.setHeader('Content-Type',opened.type);res.setHeader('Cache-Control','no-store');res.setHeader('Accept-Ranges','bytes');res.setHeader('X-Content-Type-Options','nosniff');
  if(req.headers.range){const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);if(!match||!match[1]&&!match[2])throw userError('媒体范围无效',416);start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));end=match[1]&&match[2]?Math.min(Number(match[2]),size-1):size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size){res.setHeader('Content-Range',`bytes */${size}`);throw userError('媒体范围无效',416);}status=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${size}`);}
  await opened.assertStable();res.setHeader('Content-Length',end-start+1);res.writeHead(status);if(req.method==='HEAD'){res.end();return;}await pipeline(opened.handle.createReadStream({start,end,autoClose:false}),res);
 }finally{await opened.handle.close().catch(()=>{});}
}
