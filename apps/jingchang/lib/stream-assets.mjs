import path from 'node:path';
import {promises as fs,constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {MAX_STREAM_MEDIA_BYTES,streamMediaType} from '../public/media-transfer-core.js';
import {atomicJson,readJson,safeId,textValue,userError} from './workspace.mjs';

const stamp=()=>new Date().toISOString(),id=value=>{if(!safeId(value))throw userError('本机导入编号无效');return value;};
const fileMark=stat=>`${stat.dev}/${stat.ino}/${stat.size}/${stat.mtimeMs}/${stat.ctimeMs}`;
const mediaType=value=>{const type=String(value||'').split(';')[0].trim().toLowerCase();if(!streamMediaType(type))throw userError('大文件导入只支持常见图片、视频和音频格式',415);return type;};
export function streamMediaSize(value,contentLength){
 if(typeof value!=='string'||!/^\d{1,10}$/.test(value))throw userError('请提供原文件的准确字节数');
 const size=Number(value);if(!Number.isSafeInteger(size)||size<1||size>MAX_STREAM_MEDIA_BYTES)throw userError('媒体大小须为1字节至4GB（4,000,000,000字节）',413);
 if(contentLength!==undefined&&(typeof contentLength!=='string'||!/^\d{1,10}$/.test(contentLength)||Number(contentLength)!==size))throw userError('原文件字节数与请求长度不一致');
 return size;
}
// Check only a small container header; complete decodability is checked by the tool that uses it.
export function checkMediaHeader(bytes,type){
 const text=(start,length)=>bytes.subarray(start,start+length).toString('latin1'),magic=(values,start=0)=>values.every((v,i)=>bytes[start+i]===v);
 const mp4=bytes.length>=16&&text(4,4)==='ftyp',riff=bytes.length>=12&&text(0,4)==='RIFF',ogg=text(0,4)==='OggS',webm=magic([0x1a,0x45,0xdf,0xa3]);
 let ok=false;
 if(type==='image/png')ok=magic([137,80,78,71,13,10,26,10]);
 else if(type==='image/jpeg')ok=magic([255,216,255]);
 else if(type==='image/gif')ok=['GIF87a','GIF89a'].includes(text(0,6));
 else if(type==='image/webp')ok=riff&&text(8,4)==='WEBP';
 else if(type==='image/avif')ok=mp4&&/avif|avis/.test(text(8,Math.min(bytes.length-8,56)));
 else if(type==='image/bmp')ok=bytes.length>=26&&text(0,2)==='BM'&&[12,16,40,52,56,64,108,124].includes(bytes.readUInt32LE(14));
 else if(['video/mp4','video/quicktime','audio/mp4','audio/x-m4a'].includes(type))ok=mp4;
 else if(['video/webm','audio/webm'].includes(type))ok=webm;
 else if(type==='video/x-matroska')ok=webm&&text(0,bytes.length).includes('matroska');
 else if(type==='video/x-flv')ok=text(0,3)==='FLV';
 else if(['audio/wav','audio/x-wav','audio/wave'].includes(type))ok=riff&&text(8,4)==='WAVE';
 else if(['audio/ogg','audio/opus'].includes(type))ok=ogg;
 else if(['audio/flac','audio/x-flac'].includes(type))ok=text(0,4)==='fLaC';
 else if(['audio/mpeg','audio/mp3'].includes(type))ok=text(0,3)==='ID3'||bytes[0]===255&&(bytes[1]&0xe0)===0xe0;
 else if(type==='audio/aac')ok=bytes[0]===255&&(bytes[1]&0xf6)===0xf0;
 if(!ok)throw userError('文件头与所选媒体格式不一致；未加入素材库',415);
}
async function ordinaryDirectory(root,name){const dir=path.join(root,name);await fs.mkdir(dir,{recursive:true});if(await fs.realpath(dir)!==dir||(await fs.lstat(dir)).isSymbolicLink())throw userError('导入目录不能是符号链接');return dir;}
async function writeAll(handle,bytes){let offset=0;while(offset<bytes.length){const {bytesWritten}=await handle.write(bytes,offset,bytes.length-offset);if(!bytesWritten)throw userError('媒体写入中断');offset+=bytesWritten;}}

export function streamAssetService({data,projects,activeJobs,maxBytes=MAX_STREAM_MEDIA_BYTES,diskInfo=fs.statfs}){
 const starting=new Set();
 async function recordPath(requestId){const root=await fs.realpath(data),base=await ordinaryDirectory(root,'asset-imports');return {root,base,dir:path.join(base,id(requestId)),file:path.join(base,id(requestId),'record.json')};}
 async function readRecord(requestId,projectId){
  const p=await recordPath(requestId);if(await fs.realpath(p.dir)!==p.dir||await fs.realpath(p.file)!==p.file)throw userError('导入记录不是普通本机文件');
  const stat=await fs.lstat(p.file);if(!stat.isFile()||stat.size>65536)throw userError('导入记录无效');const owned=r=>{if(r.requestId!==requestId||r.projectId!==projectId)throw userError('导入记录不属于当前项目');return r;};let r=owned(await readJson(p.file));
  if(r.status==='importing'){const running=activeJobs.get('asset-import-'+requestId);if(running)return {...r,bytesReceived:running.bytesReceived};r=owned(await readJson(p.file));if(r.status==='importing'){const partial=path.join(p.dir,'original.bin');let bytesReceived=0;try{const st=await fs.lstat(partial);if(!st.isFile()||st.isSymbolicLink()||await fs.realpath(partial)!==partial||st.size>r.size)throw userError('未完成的本机媒体与记录不一致');bytesReceived=st.size;}catch(e){if(e.code!=='ENOENT')throw e;}return {...r,status:'interrupted',bytesReceived};}}
  if(r.status==='completed'){const file=path.join(p.root,'assets',id(r.asset.id)),metaFile=file+'.json';if(await fs.realpath(file)!==file||await fs.realpath(metaFile)!==metaFile)throw userError('已导入素材不是普通文件');const stat=await fs.lstat(file),index=await fs.lstat(metaFile);if(!index.isFile()||index.size>65536)throw userError('已导入素材索引无效');const meta=await readJson(metaFile);if(!stat.isFile()||meta.id!==r.asset.id||meta.size!==r.size||stat.size!==r.size||meta.sha256!==r.sha256||fileMark(stat)!==r.fileMark)throw userError('已导入素材与记录不一致');}
  return r;
 }
 async function get(requestId,projectId){await projects.load(id(projectId));return readRecord(id(requestId),projectId);}
 async function importFile(stream,input){
  const requestId=id(input.requestId),projectId=id(input.projectId),name=textValue(input.name,200,'素材名称'),type=mediaType(input.type),size=streamMediaSize(String(input.size),input.contentLength);
  if(size>maxBytes)throw userError('媒体超过本机导入容量限制',413);await projects.load(projectId);
  if(starting.has(requestId)||activeJobs.has('asset-import-'+requestId))throw userError('此文件仍在本机导入，请读取原导入记录',409);
  starting.add(requestId);let p,record,handle,running;
  try{
   p=await recordPath(requestId);try{const old=await readRecord(requestId,projectId);if(old.name!==name||old.type!==type||old.size!==size)throw userError('此导入编号已用于另一文件',409);if(old.status==='completed')return old.asset;throw userError('此导入未完成；已保留收到的文件，重新导入须使用新编号',409);}catch(e){if(e.code!=='ENOENT')throw e;}
   const disk=await diskInfo(p.root);if(disk.bavail*disk.bsize<size+64*1024*1024)throw userError('可用空间不足以导入原文件并保留64MiB余量',507);
   await fs.mkdir(p.dir);if(await fs.realpath(p.dir)!==p.dir)throw userError('导入目录不能是符号链接');
   record={requestId,projectId,name,type,size,status:'importing',bytesReceived:0,createdAt:stamp(),updatedAt:stamp()};await atomicJson(p.file,record);
   const assets=await ordinaryDirectory(p.root,'assets');handle=await fs.open(path.join(p.dir,'original.bin'),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
   const digest=createHash('sha256');let prefix=Buffer.alloc(0),checked=false;
   running={kind:'asset-import',projectId,bytesReceived:0};activeJobs.set('asset-import-'+requestId,running);starting.delete(requestId);
   for await(const value of stream){
    const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);if(running.bytesReceived+chunk.length>size)throw userError('收到的媒体超过预告字节数',413);
    if(!checked){const count=Math.min(64-prefix.length,chunk.length);prefix=Buffer.concat([prefix,chunk.subarray(0,count)]);if(prefix.length>=Math.min(64,size)){checkMediaHeader(prefix,type);checked=true;}}
    await writeAll(handle,chunk);digest.update(chunk);running.bytesReceived+=chunk.length;
   }
   if(running.bytesReceived!==size)throw userError('原文件传输中断或字节数不足，未加入素材库');if(!checked)checkMediaHeader(prefix,type);
   await handle.sync();const originalFile=path.join(p.dir,'original.bin'),written=await handle.stat();if(!written.isFile()||written.size!==size||await fs.realpath(p.dir)!==p.dir||await fs.realpath(originalFile)!==originalFile||fileMark(await fs.lstat(originalFile))!==fileMark(written))throw userError('导入期间原文件或目录发生变化，未加入素材库');await handle.close();handle=null;
   const sha256=digest.digest('hex'),assetId=randomUUID(),meta={id:assetId,name,type,size,sha256,category:'',tags:[],source:'stream-import',createdAt:stamp(),url:'/media/'+assetId};
   if(await fs.realpath(assets)!==assets)throw userError('素材目录已变化');
   // Link an exclusive completed file. The staged original remains recoverable, without a second copy.
   const target=path.join(assets,assetId);await fs.link(originalFile,target);const linked=await fs.lstat(target);if(!linked.isFile()||linked.ino!==written.ino||linked.dev!==written.dev||linked.size!==size||linked.mtimeMs!==written.mtimeMs||await fs.realpath(target)!==target)throw userError('完成的媒体文件发生变化，未加入素材库');await atomicJson(target+'.json',meta);
   Object.assign(record,{status:'completed',bytesReceived:size,sha256,asset:meta,fileMark:fileMark(await fs.lstat(path.join(assets,assetId))),updatedAt:stamp()});await atomicJson(p.file,record);return meta;
  }catch(e){if(record){Object.assign(record,{status:'incomplete',bytesReceived:running?.bytesReceived||0,updatedAt:stamp()});await atomicJson(p.file,record).catch(()=>{});}throw e.status?e:userError('本机导入未完成；收到的部分原文件已保留');}
  finally{await handle?.close();starting.delete(requestId);activeJobs.delete('asset-import-'+requestId);}
 }
 return {importFile,get};
}
