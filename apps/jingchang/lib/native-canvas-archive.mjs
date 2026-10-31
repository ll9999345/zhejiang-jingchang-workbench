import {promises as fs} from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createInflateRaw} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {createHash,randomUUID} from 'node:crypto';
import {checkMediaHeader} from './stream-assets.mjs';
import {fileMediaType,streamMediaType,MAX_STREAM_MEDIA_BYTES} from '../public/media-transfer-core.js';
import {userError} from './workspace.mjs';

export const nativeArchiveLimits={manifest:12*1024**2,media:4*1024**3,files:1000,entries:2001};
const TAIL=8*1024**2,MAX_INPUT=nativeArchiveLimits.media+nativeArchiveLimits.manifest+TAIL;
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function crc32Update(crc,bytes){for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return crc>>>0;}
const zipError=message=>userError('原生 ZIP：'+message);
function archivePath(bytes){
 let name;try{name=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw zipError('文件名须使用 UTF-8');}
 const parts=name.endsWith('/')?name.slice(0,-1).split('/'):name.split('/');
 if(!name||bytes.length>512||/[\\\u0000-\u001f\u007f]/.test(name)||name.startsWith('/')||/^[a-z]:/i.test(name)||parts.some(x=>x==='.'||x==='..'||x===''))throw zipError('包含不安全的文件路径');
 return name;
}
function zip64(extra,size,compressed,offset){
 let values=null;
 for(let at=0;at<extra.length;){if(at+4>extra.length)throw zipError('扩展字段不完整');const tag=extra.readUInt16LE(at),length=extra.readUInt16LE(at+2);at+=4;if(at+length>extra.length)throw zipError('扩展字段不完整');if(tag===1){if(values)throw zipError('ZIP64 字段重复');values=extra.subarray(at,at+length);}at+=length;}
 let at=0;const read=()=>{if(!values||at+8>values.length)throw zipError('ZIP64 大小或偏移缺失');const value=Number(values.readBigUInt64LE(at));at+=8;if(!Number.isSafeInteger(value))throw zipError('大小超出支持范围');return value;};
 return {size:size===0xffffffff?read():size,compressed:compressed===0xffffffff?read():compressed,offset:offset===0xffffffff?read():offset};
}
function centralDirectory(tail,total,entries){
 const tailStart=total-tail.length;let end=-1;
 for(let i=tail.length-22;i>=Math.max(0,tail.length-65557);i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break;}
 if(end<0)throw zipError('结尾缺失或包含多余数据');
 if(tail.readUInt16LE(end+4)||tail.readUInt16LE(end+6)||tail.readUInt16LE(end+8)!==tail.readUInt16LE(end+10))throw zipError('不接受分卷 ZIP');
 let count=tail.readUInt16LE(end+10),length=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16),centralEnd=tailStart+end;
 if(count===0xffff||length===0xffffffff||offset===0xffffffff){
  const locator=end-20;if(locator<0||tail.readUInt32LE(locator)!==0x07064b50||tail.readUInt32LE(locator+4)||tail.readUInt32LE(locator+16)!==1)throw zipError('ZIP64 结尾无效');
  const pos=Number(tail.readBigUInt64LE(locator+8))-tailStart;if(!Number.isSafeInteger(pos)||pos<0||pos+56>locator||tail.readUInt32LE(pos)!==0x06064b50||Number(tail.readBigUInt64LE(pos+4))+12!==locator-pos||tail.readUInt32LE(pos+16)||tail.readUInt32LE(pos+20)||tail.readBigUInt64LE(pos+24)!==tail.readBigUInt64LE(pos+32))throw zipError('ZIP64 目录无效');
  count=Number(tail.readBigUInt64LE(pos+32));length=Number(tail.readBigUInt64LE(pos+40));offset=Number(tail.readBigUInt64LE(pos+48));centralEnd=tailStart+pos;
 }
 if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||count!==entries.length||offset<tailStart||offset+length!==centralEnd)throw zipError('目录数量、长度或偏移不一致');
 let at=offset-tailStart,localOffset=0;
 for(const actual of entries){
  if(at+46>tail.length||tail.readUInt32LE(at)!==0x02014b50)throw zipError('目录记录不完整');
  const flags=tail.readUInt16LE(at+8),method=tail.readUInt16LE(at+10),crc=tail.readUInt32LE(at+16),nameLength=tail.readUInt16LE(at+28),extraLength=tail.readUInt16LE(at+30),commentLength=tail.readUInt16LE(at+32),external=tail.readUInt32LE(at+38);
  if(at+46+nameLength+extraLength+commentLength>tail.length||extraLength>4096||commentLength>1024||tail.readUInt16LE(at+34))throw zipError('目录字段无效或过大');
  const name=archivePath(tail.subarray(at+46,at+46+nameLength)),values=zip64(tail.subarray(at+46+nameLength,at+46+nameLength+extraLength),tail.readUInt32LE(at+24),tail.readUInt32LE(at+20),tail.readUInt32LE(at+42)),fileMode=external>>>16&0xf000;
  if(fileMode===0xa000||fileMode&&![0x8000,0x4000].includes(fileMode)||fileMode===0x4000&&!name.endsWith('/'))throw zipError('不接受符号链接或特殊文件');
  if(name!==actual.name||flags!==actual.flags||method!==actual.method||crc!==actual.crc||values.size!==actual.size||values.compressed!==actual.compressed||values.offset!==localOffset)throw zipError('文件 CRC、大小或头部与目录不一致：'+name);
  localOffset+=30+actual.nameLength+actual.extraLength+actual.compressed;at+=46+nameLength+extraLength+commentLength;
 }
 if(localOffset!==offset||at!==offset-tailStart+length)throw zipError('文件区存在缺失或未识别数据');
}
async function writeAll(handle,chunk){let offset=0;while(offset<chunk.length){const r=await handle.write(chunk,offset,chunk.length-offset);if(!r.bytesWritten)throw zipError('素材写入中断');offset+=r.bytesWritten;}}

// Only media bytes are staged. The workflow stays in memory until its schema and
// credential checks pass; archive paths are never used as filesystem paths.
export async function readNativeArchive(stream,{directory}){
 const iterator=stream[Symbol.asyncIterator]();let head=Buffer.alloc(0),done=false;
 while(head.length<4&&!done){const result=await iterator.next();done=result.done;if(!done)head=Buffer.concat([head,Buffer.from(result.value)]);if(head.length>MAX_INPUT)throw zipError('文件超过容量限制');}
 async function* source(){if(head.length)yield head;while(!done){const r=await iterator.next();done=r.done;if(!done)yield Buffer.from(r.value);}}
 if(head.length<4||head.readUInt32LE(0)!==0x04034b50){const chunks=[];let size=0;for await(const chunk of source()){size+=chunk.length;if(size>nativeArchiveLimits.manifest)throw userError('原生 JSON 配置超过12MiB',413);chunks.push(chunk);}return {kind:'json',json:Buffer.concat(chunks),resources:[],sha256:createHash('sha256').update(Buffer.concat(chunks)).digest('hex')};}
 const inputHash=createHash('sha256');let received=0,position=0,buffer=Buffer.alloc(0),bufferAt=0,mediaTotal=0,json=null,manifestName=null;
 const input=source()[Symbol.asyncIterator](),names=new Set(),entries=[],resources=[];
 async function fill(){if(bufferAt<buffer.length)return true;const r=await input.next();if(r.done)return false;buffer=Buffer.from(r.value);bufferAt=0;received+=buffer.length;if(received>MAX_INPUT)throw zipError('文件超过4GiB素材及配置上限');inputHash.update(buffer);return true;}
 async function exact(size){const parts=[];let remaining=size;while(remaining){if(!await fill())throw zipError('文件不完整');const length=Math.min(remaining,buffer.length-bufferAt);parts.push(buffer.subarray(bufferAt,bufferAt+length));bufferAt+=length;position+=length;remaining-=length;}return Buffer.concat(parts,size);}
 async function* take(size){let remaining=size;while(remaining){if(!await fill())throw zipError('文件不完整');const length=Math.min(remaining,buffer.length-bufferAt,65536),chunk=buffer.subarray(bufferAt,bufferAt+length);bufferAt+=length;position+=length;remaining-=length;yield chunk;}}
 while(true){
  const signature=await exact(4);
  if(signature.readUInt32LE(0)!==0x04034b50){
   if(signature.readUInt32LE(0)!==0x02014b50)throw zipError('缺少目录或包含未识别记录');
   const parts=[signature];let length=4;
   while(await fill()){const chunk=buffer.subarray(bufferAt);length+=chunk.length;if(length>TAIL)throw zipError('目录字段过大');parts.push(chunk);position+=chunk.length;bufferAt=buffer.length;}
   centralDirectory(Buffer.concat(parts,length),position,entries);if(!json)throw zipError('缺少 workflow.json');
   return {kind:'zip',json,resources,manifestName,sha256:inputHash.digest('hex')};
  }
  const header=await exact(26),flags=header.readUInt16LE(2),method=header.readUInt16LE(4),declaredCrc=header.readUInt32LE(10),nameLength=header.readUInt16LE(22),extraLength=header.readUInt16LE(24);
  if(flags&~0x0806||![0,8].includes(method)||method===0&&flags&6||nameLength<1||nameLength>512||extraLength>4096)throw zipError('只接受未加密、已写入大小的 Stored/Deflate ZIP；请用原项目导出 ZIP');
  const name=archivePath(await exact(nameLength)),extra=await exact(extraLength),values=zip64(extra,header.readUInt32LE(18),header.readUInt32LE(14),0),isDirectory=name.endsWith('/'),isManifest=path.posix.basename(name)==='workflow.json';
  if(names.has(name)||names.size>=nativeArchiveLimits.entries)throw zipError('文件名重复或条目过多');names.add(name);
  if(isManifest&&json!==null)throw zipError('存在多个 workflow.json');
  if(!isDirectory&&!isManifest&&!streamMediaType(fileMediaType({name})))throw zipError('包含不支持的素材类型：'+name);
  const limit=isDirectory?0:isManifest?nativeArchiveLimits.manifest:MAX_STREAM_MEDIA_BYTES;
  if(!Number.isSafeInteger(values.size)||values.size>limit||!Number.isSafeInteger(values.compressed)||values.compressed>MAX_INPUT||values.compressed<0||method===0&&values.compressed!==values.size)throw zipError('文件大小无效或超过上限：'+name);
  let handle=null,size=0,crc=0xffffffff,prefix=Buffer.alloc(0),chunks=[],file,inflate,pumping;
  if(!isDirectory&&!isManifest){if(resources.length>=nativeArchiveLimits.files)throw zipError('素材超过1000份');const disk=await fs.statfs(directory);if(disk.bavail*disk.bsize<values.size+64*1024**2)throw userError('可用空间不足以接收素材并保留64MiB余量',507);file=path.join(directory,randomUUID()+'.media');handle=await fs.open(file,'wx');}
  const hash=createHash('sha256'),compressed=take(values.compressed);let content=compressed,inputError;
  if(method===8){inflate=createInflateRaw();pumping=pipeline(Readable.from(compressed),inflate).catch(error=>{inputError=error;inflate.destroy(error);});content=inflate;}
  try{
   for await(const chunk of content){size+=chunk.length;if(size>limit||size>values.size)throw zipError('解压后的文件超过声明大小：'+name);if(!isDirectory&&!isManifest){mediaTotal+=chunk.length;if(mediaTotal>nativeArchiveLimits.media)throw zipError('素材总量超过4GiB');}crc=crc32Update(crc,chunk);hash.update(chunk);if(prefix.length<64)prefix=Buffer.concat([prefix,chunk.subarray(0,64-prefix.length)]);if(handle)await writeAll(handle,chunk);else if(isManifest)chunks.push(chunk);}
   await pumping;if(inputError||inflate&&inflate.bytesWritten!==values.compressed)throw zipError('压缩数据不完整或包含多余数据');
  }catch(error){inflate?.destroy();await pumping;throw error.status?error:zipError('文件不完整或压缩数据损坏');}finally{await handle?.close();}
  crc=(crc^0xffffffff)>>>0;if(size!==values.size||crc!==declaredCrc)throw zipError('素材 CRC 或长度校验失败：'+name);
  entries.push({name,flags,method,crc,size,compressed:values.compressed,nameLength,extraLength});
  if(isManifest){json=Buffer.concat(chunks);manifestName=name;}else if(!isDirectory){if(!size)throw zipError('素材为空：'+name);const type=fileMediaType({name});checkMediaHeader(prefix,type);resources.push({archive:name,file,size,type,sha256:hash.digest('hex'),name:path.posix.basename(name)});}
 }
}
