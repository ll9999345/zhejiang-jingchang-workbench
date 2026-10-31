import path from 'node:path';
import {promises as fs,constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {atomicJson,readJson,safeId,userError,textValue,assertNoCredentials} from './workspace.mjs';
import {validateApiBaseUrl,validateSignedDestination} from './image-api.mjs';
import {MAX_STREAM_MEDIA_BYTES} from '../public/media-transfer-core.js';

const MB=1024*1024,limit=MAX_STREAM_MEDIA_BYTES,hours=72;
const stamp=()=>new Date().toISOString(),sha=x=>createHash('sha256').update(x).digest('hex');
const profiles={
 litterbox:{id:'litterbox',name:'Litterbox',maxBytes:150*MB,endpoint:'https://litterbox.catbox.moe/resources/internals/api.php',field:'fileToUpload',fields:{reqtype:'fileupload',time:'72h'},hosts:['litter.catbox.moe','litterbox.catbox.moe'],documentation:'https://litterbox.catbox.moe/'},
 temp:{id:'temp',name:'temp.sh',maxBytes:limit,endpoint:'https://temp.sh/upload',field:'file',fields:{},hosts:['temp.sh'],documentation:'https://temp.sh/'}
};
const purposes=new Set(['ark-material','apimart-material','generation-reference']);
const id=x=>{if(!safeId(x))throw userError('公网素材记录或本机素材编号无效');return x;};
export function publicMediaProfiles(){return Object.values(profiles).map(p=>({id:p.id,name:p.name,endpoint:p.endpoint,retentionHours:hours,maxBytes:p.maxBytes,documentation:p.documentation}));}
export function publicMediaEndpoint(service,value){
 const p=profiles[service];if(!p)throw userError('请选择 Litterbox 或 temp.sh，不能自动切换目的地');
 const endpoint=validateApiBaseUrl(value||p.endpoint),u=new URL(endpoint);
 const mock=u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&u.pathname===new URL(p.endpoint).pathname;
 if(endpoint!==p.endpoint&&!mock)throw userError('仅支持所选官方上传接口，或同路径的显式本机模拟接口');
 return endpoint;
}
function hostedUrl(value,service,endpoint){
 if(typeof value!=='string'||value.length>2048||/[\r\n\s]/.test(value))throw userError('托管返回的链接无效');
 const url=validateApiBaseUrl(value),u=new URL(url),e=new URL(endpoint);
 if(u.protocol==='http:'&&e.protocol==='http:'&&u.origin===e.origin)return url;
 if(u.protocol!=='https:'||!profiles[service].hosts.includes(u.hostname)||u.port)throw userError('托管返回的链接不属于所选服务');
 return url;
}
function sourceRecord(s){
 if(!s||!safeId(s.assetId)||!Number.isSafeInteger(s.size)||s.size<1||s.size>limit||!/^([a-f0-9]{64})$/.test(s.sourceSha256)||typeof s.type!=='string'||! /^(image\/(png|jpeg|webp|gif|avif)|video\/(mp4|webm|quicktime|x-flv)|audio\/[\w.+-]+)$/.test(s.type))throw userError('原文件记录无效，仅支持图片、视频和音频');
 return {assetId:s.assetId,name:textValue(s.name,200,'原文件名称'),type:s.type,size:s.size,sourceSha256:s.sourceSha256};
}
export function publicMediaRecord(value){
 if(!value||!['uploading','ready','expired','uncertain','rejected'].includes(value.status)||!purposes.has(value.purpose)||value.requestCount!==1||! /^[a-f0-9]{64}$/.test(value.fingerprint))throw userError('公网素材上传记录无效');
 const endpoint=publicMediaEndpoint(value.service,value.endpoint),createdAt=textValue(value.createdAt,40,'上传时间'),updatedAt=textValue(value.updatedAt,40,'更新时间');
 if(!Number.isFinite(Date.parse(createdAt))||!Number.isFinite(Date.parse(updatedAt)))throw userError('上传记录时间无效');
 const r={id:id(value.id),requestId:id(value.requestId),status:value.status,purpose:value.purpose,service:value.service,endpoint,retentionHours:hours,expiryEstimated:true,createdAt,updatedAt,expiresAt:new Date(Date.parse(createdAt)+hours*3600000).toISOString(),requestCount:1,fingerprint:value.fingerprint,source:sourceRecord(value.source),bytesSent:Number.isSafeInteger(value.bytesSent)&&value.bytesSent>=0&&value.bytesSent<=value.source.size?value.bytesSent:0};
 if(r.source.size>profiles[r.service].maxBytes)throw userError('原文件超过所选托管服务的本机容量限制',413);
 if(value.url)r.url=hostedUrl(value.url,r.service,endpoint);
 if(['ready','expired'].includes(r.status)&&(!r.url||r.bytesSent!==r.source.size))throw userError('成功上传记录缺少链接或完整传输字节');
 if(value.restored===true)r.restored=true;
 assertNoCredentials(r);return r;
}
const changed=()=>userError('本机原文件或记录变化、缺失或为符号链接，请重新预览');
const fileMark=s=>`${s.dev}/${s.ino}/${s.size}/${s.mtimeMs}/${s.ctimeMs}`;
// Read and transmit from one checked ordinary-file descriptor. Never accept a client file path.
async function openSource(data,assetId,maxBytes=limit){
 const root=await fs.realpath(data),dir=path.join(root,'assets'),file=path.join(dir,id(assetId)),metaFile=file+'.json';let handle;
 try{
  if(await fs.realpath(dir)!==dir||await fs.realpath(file)!==file||await fs.realpath(metaFile)!==metaFile)throw changed();
  const mst=await fs.lstat(metaFile);if(!mst.isFile()||mst.size>1024**2)throw changed();
  const meta=await readJson(metaFile),st=await fs.lstat(file);if(meta.id!==assetId||!st.isFile()||st.size!==meta.size||st.size<1||st.size>limit)throw changed();
  if(st.size>maxBytes)throw userError('原文件超过所选托管服务的容量限制',413);
  handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const mark=fileMark(st);if(fileMark(await handle.stat())!==mark)throw changed();
  const digest=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false,start:0,end:st.size-1}))digest.update(chunk);
  const check=async()=>{if(await fs.realpath(dir)!==dir||fileMark(await handle.stat())!==mark||fileMark(await fs.lstat(file))!==mark||!((await fs.lstat(file)).isFile()))throw changed();};
  await check();const source=sourceRecord({assetId,name:meta.name,type:meta.type.split(';')[0],size:st.size,sourceSha256:digest.digest('hex')});
  return {source,handle,check};
 }catch(e){await handle?.close();if(e.status)throw e;throw changed();}
}
export async function inspectPublicMediaSource(data,assetId,maxBytes=limit){const opened=await openSource(data,assetId,maxBytes);try{return opened.source;}finally{await opened.handle.close();}}
function multipartParts(profile,source,boundary){
 const ext=({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/avif':'avif','video/mp4':'mp4','video/quicktime':'mov','video/webm':'webm','video/x-flv':'flv','audio/mpeg':'mp3','audio/wav':'wav','audio/x-wav':'wav'})[source.type]||'audio';
 const fields=Object.entries(profile.fields).map(([key,value])=>`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`).join('');
 // The host receives an opaque media filename, not the user's original filename or folder.
 return {head:Buffer.from(fields+`--${boundary}\r\nContent-Disposition: form-data; name="${profile.field}"; filename="${source.assetId}.${ext}"\r\nContent-Type: ${source.type}\r\n\r\n`),tail:Buffer.from(`\r\n--${boundary}--\r\n`)};
}
async function uploadOnce({profile,endpoint,opened,signal,onProgress}){
 const destination=await validateSignedDestination(endpoint,endpoint);await opened.check();
 const boundary='jc-'+randomUUID(),{head,tail}=multipartParts(profile,opened.source,boundary),digest=createHash('sha256');let bytes=0,req;
 async function* chunks(){await opened.check();yield head;for await(const c of opened.handle.createReadStream({autoClose:false,start:0,end:opened.source.size-1})){bytes+=c.length;digest.update(c);onProgress(bytes);yield c;}if(bytes!==opened.source.size||digest.digest('hex')!==opened.source.sourceSha256)throw changed();await opened.check();yield tail;}
 const response=new Promise((resolve,reject)=>{
  req=(destination.url.protocol==='https:'?httpsRequest:httpRequest)(destination.url,{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary='+boundary,'Content-Length':head.length+opened.source.size+tail.length},signal,...(destination.pinned?{family:destination.pinned.family,autoSelectFamily:false,lookup:(_h,_o,cb)=>cb(null,destination.pinned.address,destination.pinned.family)}:{})},res=>{
   let size=0;const parts=[];res.on('data',c=>{size+=c.length;if(size>8192)res.destroy(Error('response-too-large'));else parts.push(c);});res.once('error',()=>{req.destroy();reject(userError('托管响应中断'));});res.once('end',()=>resolve({status:res.statusCode,text:Buffer.concat(parts).toString('utf8')}));
  });req.once('error',reject);
 });
 const transfer=pipeline(Readable.from(chunks()),req),settled=await Promise.allSettled([response,transfer]);
 if(settled.some(r=>r.status==='rejected'))return {status:'uncertain',bytesSent:bytes};
 const result=settled[0].value;
 if(result.status>=400&&result.status<500)return {status:'rejected',bytesSent:bytes};
 if(result.status<200||result.status>=300)return {status:'uncertain',bytesSent:bytes};
 try{return {status:'ready',url:hostedUrl(result.text.trim(),profile.id,endpoint),bytesSent:bytes};}catch{return {status:'uncertain',bytesSent:bytes};}
}
export function publicMediaService({data,projects,activeJobs,timeoutMs=3600000,now=()=>Date.now()}){
 const locks=new Map();
 async function locked(key,fn){const old=locks.get(key)||Promise.resolve(),task=old.catch(()=>{}).then(fn);locks.set(key,task);try{return await task;}finally{if(locks.get(key)===task)locks.delete(key);}}
 async function directory(){const root=await fs.realpath(data),dir=path.join(root,'public-media');await fs.mkdir(dir,{recursive:true});if(await fs.realpath(dir)!==dir)throw userError('上传记录目录不能是符号链接');return dir;}
 async function file(key){return path.join(await directory(),id(key)+'.json');}
 async function get(key,projectId){
  const f=await file(key),st=await fs.lstat(f);if(!st.isFile()||st.size>65536||await fs.realpath(f)!==f)throw userError('上传记录文件无效');
  const checkRecord=raw=>{if(raw.id!==key)throw userError('上传记录编号与文件不一致');if(raw.projectId!==projectId)throw userError('上传记录不属于当前项目');return publicMediaRecord(raw);};let r=checkRecord(await readJson(f));
  if(r.status==='uploading'){const running=activeJobs.get(r.id);if(!running){r=checkRecord(await readJson(f));if(r.status==='uploading')r.status='uncertain';}else r.bytesSent=running.bytesSent;}
  if(r.status==='ready'&&now()>=Date.parse(r.expiresAt))r.status='expired';
  return {...r,projectId,availabilityUnverified:true};
 }
 async function list(projectId){await projects.load(id(projectId));const dir=await directory(),files=(await fs.readdir(dir)).filter(f=>/^[\w-]+\.json$/.test(f)),rows=[];for(const f of files){const file=path.join(dir,f),st=await fs.lstat(file);if(!st.isFile()||st.size>65536||await fs.realpath(file)!==file)throw userError('上传记录文件无效');const record=await readJson(file);if(record.id!==f.slice(0,-5))throw userError('上传记录编号与文件不一致');if(record.projectId===projectId)rows.push(await get(record.id,projectId));}return rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
 async function preview(b){
  assertNoCredentials(b);await projects.load(id(b.projectId));if(!purposes.has(b.purpose))throw userError('请选择上传用途');
  const endpoint=publicMediaEndpoint(b.service,b.endpoint);
  const plan={projectId:b.projectId,purpose:b.purpose,service:b.service,endpoint,retentionHours:hours,expiryEstimated:true,requestLimit:1,source:await inspectPublicMediaSource(data,id(b.assetId),profiles[b.service].maxBytes)};
  assertNoCredentials(plan);return {...plan,fingerprint:sha(JSON.stringify(plan)),publicScope:'anyone-with-url',sendOriginalMedia:true};
 }
 async function start(b){return locked(id(b.projectId)+'/'+id(b.requestId),async()=>{
  assertNoCredentials(b);const old=(await list(b.projectId)).find(r=>r.requestId===b.requestId);
  if(old){if(old.fingerprint!==b.fingerprint)throw userError('此提交编号已用于另一发送范围，请查看原记录');return old;}
  const plan=await preview(b),c=b.consent;
  if(b.fingerprint!==plan.fingerprint||!c||c.fingerprint!==plan.fingerprint||c.endpoint!==plan.endpoint||c.service!==plan.service||c.purpose!==plan.purpose||c.retentionHours!==hours||c.requestLimit!==1||c.publicScope!=='anyone-with-url'||c.sendOriginalMedia!==true)throw userError('请重新预览并确认原文件、目的地、72小时保留和持链接者可访问的范围');
  await validateSignedDestination(plan.endpoint,plan.endpoint);
  const opened=await openSource(data,b.assetId);if(opened.source.sourceSha256!==plan.source.sourceSha256||opened.source.size!==plan.source.size){await opened.handle.close();throw changed();}
  const r=publicMediaRecord({...plan,id:randomUUID(),requestId:b.requestId,requestCount:1,status:'uploading',bytesSent:0,createdAt:stamp(),updatedAt:stamp(),fingerprint:plan.fingerprint}),recordFile=await file(r.id),controller=new AbortController();
  try{await atomicJson(recordFile,{...r,projectId:b.projectId});}catch(e){await opened.handle.close();throw e;}
  const running={projectId:b.projectId,kind:'public-media',controller,bytesSent:0};activeJobs.set(r.id,running);
  const task=(async()=>{
   try{Object.assign(r,await uploadOnce({profile:profiles[r.service],endpoint:r.endpoint,opened,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs)]),onProgress:bytes=>running.bytesSent=bytes}));}
   catch{r.status='uncertain';r.bytesSent=running.bytesSent;}
   finally{await opened.handle.close();r.updatedAt=stamp();try{await atomicJson(recordFile,{...publicMediaRecord(r),projectId:b.projectId});}finally{activeJobs.delete(r.id);}}
  })();task.catch(()=>activeJobs.delete(r.id));
  return {...r,projectId:b.projectId,availabilityUnverified:true};
 });}
 async function reference(key,projectId){
  await projects.load(id(projectId));const r=await get(key,projectId);if(r.status!=='ready')throw userError(r.status==='expired'?'链接预计已过期，请选择仍有效的地址；不会自动重新上传':'上传尚未明确成功，不能使用此记录；不会自动重发');
  const source=await inspectPublicMediaSource(data,r.source.assetId);if(source.sourceSha256!==r.source.sourceSha256||source.size!==r.source.size||source.type!==r.source.type)throw changed();
  return {id:r.id,url:r.url,source:r.source,purpose:r.purpose,service:r.service,expiresAt:r.expiresAt,expiryEstimated:true,availabilityUnverified:true,restored:r.restored===true};
 }
 return {list,get,preview,start,reference};
}
