import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { loadAsset, safeId, userError } from './workspace.mjs';

const MAX_FILES = 100;
const MAX_BYTES = 256 * 1024 * 1024;
const crcTable = Uint32Array.from({length:256},(_,n)=>{
  let value=n;
  for(let bit=0;bit<8;bit++)value=(value&1)?(0xedb88320^(value>>>1)):(value>>>1);
  return value>>>0;
});
function crcUpdate(crc,bytes){for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return crc>>>0;}
function dosDateTime(date=new Date()){
  const year=Math.max(1980,Math.min(2107,date.getFullYear()));
  return {date:((year-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate(),time:(date.getHours()<<11)|(date.getMinutes()<<5)|Math.floor(date.getSeconds()/2)};
}
function archiveName(name,id,used){
  let base=String(name||id).split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g,'_').trim();
  if(!base||base==='.'||base==='..')base=id;
  base=[...base].slice(0,160).join('');
  const ext=path.posix.extname(base),stem=ext?base.slice(0,-ext.length):base;
  let candidate=base,index=2;
  while(used.has(candidate.toLocaleLowerCase()))candidate=`${stem} (${index++})${ext}`;
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}
function localHeader(name,crc,size,date,time){
  const header=Buffer.alloc(30+name.length);
  header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x0800,6);
  header.writeUInt16LE(0,8);header.writeUInt16LE(time,10);header.writeUInt16LE(date,12);
  header.writeUInt32LE(crc,14);header.writeUInt32LE(size,18);header.writeUInt32LE(size,22);
  header.writeUInt16LE(name.length,26);header.writeUInt16LE(0,28);name.copy(header,30);return header;
}
function centralHeader(entry){
  const {nameBytes:name,crc,size,date,time,offset}=entry,header=Buffer.alloc(46+name.length);
  header.writeUInt32LE(0x02014b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(20,6);
  header.writeUInt16LE(0x0800,8);header.writeUInt16LE(0,10);header.writeUInt16LE(time,12);header.writeUInt16LE(date,14);
  header.writeUInt32LE(crc,16);header.writeUInt32LE(size,20);header.writeUInt32LE(size,24);
  header.writeUInt16LE(name.length,28);header.writeUInt16LE(0,30);header.writeUInt16LE(0,32);
  header.writeUInt16LE(0,34);header.writeUInt16LE(0,36);header.writeUInt32LE(0,38);header.writeUInt32LE(offset,42);
  name.copy(header,46);return header;
}
async function fingerprint(handle,file,id){
  let opened;try{opened=await handle.stat();}catch{throw userError(`素材「${id}」无法读取`);}
  const current=await fs.lstat(file).catch(()=>null);
  if(!opened.isFile()||!current?.isFile()||current.isSymbolicLink()||opened.dev!==current.dev||opened.ino!==current.ino||opened.size!==current.size)
    throw userError(`素材「${id}」文件已变化或不是普通文件`);
  return `${opened.dev}:${opened.ino}:${opened.size}:${opened.mtimeMs}:${opened.ctimeMs}`;
}

export async function createMediaArchive({data,project,assetIds}){
  if(!Array.isArray(assetIds)||assetIds.length<1||assetIds.length>MAX_FILES||assetIds.some(id=>!safeId(id)))
    throw userError(`请选择 1–${MAX_FILES} 份有效素材`);
  if(new Set(assetIds).size!==assetIds.length)throw userError('素材列表含重复项目');
  const owned=new Set((project.assets||[]).map(asset=>asset.id));
  if(assetIds.some(id=>!owned.has(id)))throw userError('只能下载当前项目中的素材');
  const rows=[];let total=0;
  for(const id of assetIds){
    const meta=await loadAsset(data,id);
    if(meta.id!==id||!Number.isSafeInteger(meta.size)||meta.size<1)throw userError(`素材「${id}」记录无效`);
    total+=meta.size;
    if(total>MAX_BYTES)throw userError('本组素材合计超过 256 MB，请分批下载');
    rows.push({id,meta,file:path.join(data,'assets',id)});
  }
  const used=new Set(),entries=rows.map(({id,meta})=>({id,name:archiveName(meta.name,id,used),size:meta.size})),sources=[],fingerprints=[];
  try{
    const {date,time}=dosDateTime();
    for(let index=0;index<rows.length;index++){
      const {id,meta,file}=rows[index],entry=entries[index];
      let source;
      try{source=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);}catch{throw userError(`素材「${id}」文件不存在或无法安全读取`);}
      sources.push({source,file,id,entry});
      const before=await fingerprint(source,file,id);fingerprints.push(before);
      if(meta.size!==entry.size||(await source.stat()).size!==entry.size)throw userError(`素材「${id}」大小与记录不一致`);
      let crc=0xffffffff,count=0;
      for await(const chunk of source.createReadStream({start:0,end:entry.size-1,autoClose:false})){count+=chunk.length;crc=crcUpdate(crc,chunk);}
      if(count!==entry.size||await fingerprint(source,file,id)!==before)throw userError(`素材「${id}」读取不完整或文件已变化`);
      entry.crc=(crc^0xffffffff)>>>0;entry.date=date;entry.time=time;entry.nameBytes=Buffer.from(entry.name,'utf8');
      if(entry.nameBytes.length>65535)throw userError('素材名称过长，无法打包');
    }
    let centralOffset=0;
    for(const entry of entries){entry.offset=centralOffset;centralOffset+=30+entry.nameBytes.length+entry.size;}
    const centralSize=entries.reduce((size,entry)=>size+46+entry.nameBytes.length,0),archiveSize=centralOffset+centralSize+22;
    if(archiveSize>0xffffffff)throw userError('本组素材超出 ZIP 格式支持范围');
    const closeSources=async()=>{await Promise.all(sources.map(({source})=>source.close().catch(()=>{})));};
    const content=(async function*(){
      try{
        for(let index=0;index<sources.length;index++){
          const {source,file,id,entry}=sources[index];
          yield localHeader(entry.nameBytes,entry.crc,entry.size,entry.date,entry.time);
          let copyCrc=0xffffffff,copyCount=0;
          for await(const chunk of source.createReadStream({start:0,end:entry.size-1,autoClose:false})){
            copyCount+=chunk.length;copyCrc=crcUpdate(copyCrc,chunk);yield chunk;
          }
          if(copyCount!==entry.size||((copyCrc^0xffffffff)>>>0)!==entry.crc||await fingerprint(source,file,id)!==fingerprints[index])
            throw userError(`素材「${id}」在下载时发生变化，请重试`);
        }
        for(const entry of entries)yield centralHeader(entry);
        const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(0,4);end.writeUInt16LE(0,6);
        end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(centralOffset,16);end.writeUInt16LE(0,20);yield end;
      }finally{await closeSources();}
    })();
    const stream=Readable.from(content);stream.once('close',()=>{void closeSources();});
    return {stream,size:archiveSize,count:entries.length};
  }catch(error){await Promise.all(sources.map(({source})=>source.close().catch(()=>{})));throw error;}
}

export const mediaArchiveLimits={files:MAX_FILES,bytes:MAX_BYTES};
