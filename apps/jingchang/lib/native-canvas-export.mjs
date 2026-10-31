import {promises as fs,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {crc32Update,nativeArchiveLimits} from './native-canvas-archive.mjs';
import {userError} from './workspace.mjs';

const mark=s=>`${s.dev}/${s.ino}/${s.size}/${s.mtimeMs}/${s.ctimeMs}`;
async function sourceHandle(source,size){
 const file=source.file,st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||await fs.realpath(file)!==file)throw userError('原生导出素材不是普通本机文件');
 const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW),opened=await handle.stat(),start=source.start??0;
 if(mark(opened)!==mark(st)||!Number.isSafeInteger(start)||start<0||start+size>st.size||source.end!==undefined&&source.end!==start+size-1){await handle.close();throw userError('原生导出素材范围或文件已变化');}
 return {handle,start,fingerprint:mark(st),stable:async()=>mark(await handle.stat())===mark(await fs.lstat(file))&&await fs.realpath(file)===file&&mark(await handle.stat())===mark(st)};
}
async function* chunks(opened,size){let read=0;while(read<size){const bytes=Buffer.alloc(Math.min(65536,size-read)),r=await opened.handle.read(bytes,0,bytes.length,opened.start+read);if(!r.bytesRead)throw userError('原生导出素材读取中断');read+=r.bytesRead;yield bytes.subarray(0,r.bytesRead);}}
async function writeAll(handle,bytes){let offset=0;while(offset<bytes.length){const r=await handle.write(bytes,offset,bytes.length-offset);if(!r.bytesWritten)throw userError('原生导出写入中断');offset+=r.bytesWritten;}}
function local(entry){
 const big=entry.size>=0xffffffff,name=entry.nameBytes,extra=big?Buffer.alloc(20):Buffer.alloc(0);if(big){extra.writeUInt16LE(1,0);extra.writeUInt16LE(16,2);extra.writeBigUInt64LE(BigInt(entry.size),4);extra.writeBigUInt64LE(BigInt(entry.size),12);}
 const header=Buffer.alloc(30+name.length+extra.length);header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(big?45:20,4);header.writeUInt16LE(0x0800,6);header.writeUInt16LE(0,8);header.writeUInt16LE(0,10);header.writeUInt16LE(33,12);header.writeUInt32LE(entry.crc,14);header.writeUInt32LE(big?0xffffffff:entry.size,18);header.writeUInt32LE(big?0xffffffff:entry.size,22);header.writeUInt16LE(name.length,26);header.writeUInt16LE(extra.length,28);name.copy(header,30);extra.copy(header,30+name.length);return header;
}
function central(entry){
 const bigSize=entry.size>=0xffffffff,bigOffset=entry.offset>=0xffffffff,values=[...(bigSize?[entry.size,entry.size]:[]),...(bigOffset?[entry.offset]:[])],extra=values.length?Buffer.alloc(4+8*values.length):Buffer.alloc(0),name=entry.nameBytes;
 if(values.length){extra.writeUInt16LE(1,0);extra.writeUInt16LE(8*values.length,2);values.forEach((v,i)=>extra.writeBigUInt64LE(BigInt(v),4+8*i));}
 const h=Buffer.alloc(46+name.length+extra.length);h.writeUInt32LE(0x02014b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(values.length?45:20,6);h.writeUInt16LE(0x0800,8);h.writeUInt16LE(0,10);h.writeUInt16LE(0,12);h.writeUInt16LE(33,14);h.writeUInt32LE(entry.crc,16);h.writeUInt32LE(bigSize?0xffffffff:entry.size,20);h.writeUInt32LE(bigSize?0xffffffff:entry.size,24);h.writeUInt16LE(name.length,28);h.writeUInt16LE(extra.length,30);h.writeUInt32LE(bigOffset?0xffffffff:entry.offset,42);name.copy(h,46);extra.copy(h,46+name.length);return h;
}
export async function writeNativeZip(file,document,assets,sources){
 if(assets.length!==sources.length||assets.length>nativeArchiveLimits.files||assets.reduce((n,a)=>n+a.size,0)>nativeArchiveLimits.media)throw userError('原生导出素材超过数量或大小限制');
 const json=Buffer.from(JSON.stringify(document));if(json.length>nativeArchiveLimits.manifest)throw userError('原生工作流配置超过12MiB');
 const entries=[];
 for(const [index,a]of assets.entries()){
  const opened=await sourceHandle(sources[index],a.size);let crc=0xffffffff;const hash=createHash('sha256');
  try{for await(const chunk of chunks(opened,a.size)){crc=crc32Update(crc,chunk);hash.update(chunk);}if(hash.digest('hex')!==a.sha256||!await opened.stable())throw userError('原生导出素材校验失败或已变化');entries.push({nameBytes:Buffer.from(document.resources[index].archive),size:a.size,crc:(crc^0xffffffff)>>>0,asset:a,source:sources[index],fingerprint:opened.fingerprint});}finally{await opened.handle.close();}
 }
 entries.push({nameBytes:Buffer.from('workflow.json'),size:json.length,crc:(crc32Update(0xffffffff,json)^0xffffffff)>>>0,bytes:json});
 let offset=0;for(const entry of entries){entry.offset=offset;offset+=local(entry).length+entry.size;}
 const centralBytes=entries.map(central),centralSize=centralBytes.reduce((n,b)=>n+b.length,0),zip64=offset>=0xffffffff||centralSize>=0xffffffff,archiveSize=offset+centralSize+(zip64?76:0)+22,disk=await fs.statfs(file.slice(0,file.lastIndexOf('/')));
 if(disk.bavail*disk.bsize<archiveSize+64*1024**2)throw userError('可用空间不足以导出 ZIP 并保留64MiB余量',507);
 const output=await fs.open(file,'wx');
 try{
  for(const entry of entries){await writeAll(output,local(entry));if(entry.bytes){await writeAll(output,entry.bytes);continue;}const opened=await sourceHandle(entry.source,entry.size),hash=createHash('sha256');let crc=0xffffffff;
   try{if(opened.fingerprint!==entry.fingerprint)throw userError('原生导出期间素材已变化');for await(const chunk of chunks(opened,entry.size)){crc=crc32Update(crc,chunk);hash.update(chunk);await writeAll(output,chunk);}if(hash.digest('hex')!==entry.asset.sha256||((crc^0xffffffff)>>>0)!==entry.crc||!await opened.stable())throw userError('原生导出期间素材已变化');}finally{await opened.handle.close();}
  }
  for(const bytes of centralBytes)await writeAll(output,bytes);
  if(zip64){const end64=Buffer.alloc(56),locator=Buffer.alloc(20);end64.writeUInt32LE(0x06064b50,0);end64.writeBigUInt64LE(44n,4);end64.writeUInt16LE(45,12);end64.writeUInt16LE(45,14);end64.writeBigUInt64LE(BigInt(entries.length),24);end64.writeBigUInt64LE(BigInt(entries.length),32);end64.writeBigUInt64LE(BigInt(centralSize),40);end64.writeBigUInt64LE(BigInt(offset),48);locator.writeUInt32LE(0x07064b50,0);locator.writeBigUInt64LE(BigInt(offset+centralSize),8);locator.writeUInt32LE(1,16);await writeAll(output,end64);await writeAll(output,locator);}
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralSize>=0xffffffff?0xffffffff:centralSize,12);end.writeUInt32LE(offset>=0xffffffff?0xffffffff:offset,16);await writeAll(output,end);
 }finally{await output.close();}
 return {size:archiveSize};
}
