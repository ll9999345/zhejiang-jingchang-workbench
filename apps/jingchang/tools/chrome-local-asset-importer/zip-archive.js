const UTF8=new TextEncoder();
const MAX_ARCHIVE_BYTES=256*1024*1024;
const CRC_TABLE=Uint32Array.from({length:256},(_,index)=>{
  let value=index;
  for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;
  return value>>>0;
});

function archivePath(value){
  const name=String(value||'').replace(/\\/g,'/');
  if(!name||name.startsWith('/')||/^[a-z]:/i.test(name))throw new Error('ZIP 内文件名必须是相对路径');
  const parts=name.split('/');
  if(parts.some(part=>!part||part==='.'||part==='..'||/[<>:"|?*\u0000-\u001f]/.test(part)))throw new Error('ZIP 内文件名包含不安全路径');
  const normalized=parts.join('/');
  if(UTF8.encode(normalized).length>65535)throw new Error('ZIP 内文件名过长');
  return normalized;
}

function crcUpdate(crc,bytes){
  for(const byte of bytes)crc=CRC_TABLE[(crc^byte)&0xff]^(crc>>>8);
  return crc>>>0;
}

async function crc32(blob){
  let crc=0xffffffff;
  const reader=blob.stream().getReader();
  try{
    while(true){const {done,value}=await reader.read();if(done)break;crc=crcUpdate(crc,value);}
  }finally{reader.releaseLock();}
  return (crc^0xffffffff)>>>0;
}

function dosTimestamp(date=new Date()){
  const year=Math.max(1980,Math.min(2107,date.getFullYear()));
  return {
    time:(date.getHours()<<11)|(date.getMinutes()<<5)|(Math.floor(date.getSeconds()/2)),
    date:((year-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate()
  };
}

function localHeader(name,crc,size,stamp){
  const header=new Uint8Array(30+name.length),view=new DataView(header.buffer);
  view.setUint32(0,0x04034b50,true);view.setUint16(4,20,true);view.setUint16(6,0x0800,true);view.setUint16(8,0,true);
  view.setUint16(10,stamp.time,true);view.setUint16(12,stamp.date,true);view.setUint32(14,crc,true);view.setUint32(18,size,true);view.setUint32(22,size,true);
  view.setUint16(26,name.length,true);view.setUint16(28,0,true);header.set(name,30);return header;
}

function centralHeader(name,crc,size,offset,stamp){
  const header=new Uint8Array(46+name.length),view=new DataView(header.buffer);
  view.setUint32(0,0x02014b50,true);view.setUint16(4,20,true);view.setUint16(6,20,true);view.setUint16(8,0x0800,true);view.setUint16(10,0,true);
  view.setUint16(12,stamp.time,true);view.setUint16(14,stamp.date,true);view.setUint32(16,crc,true);view.setUint32(20,size,true);view.setUint32(24,size,true);
  view.setUint16(28,name.length,true);view.setUint16(30,0,true);view.setUint16(32,0,true);view.setUint16(34,0,true);view.setUint16(36,0,true);view.setUint32(38,0,true);view.setUint32(42,offset,true);
  header.set(name,46);return header;
}

function endRecord(count,directorySize,directoryOffset){
  const record=new Uint8Array(22),view=new DataView(record.buffer);
  view.setUint32(0,0x06054b50,true);view.setUint16(4,0,true);view.setUint16(6,0,true);view.setUint16(8,count,true);view.setUint16(10,count,true);
  view.setUint32(12,directorySize,true);view.setUint32(16,directoryOffset,true);view.setUint16(20,0,true);return record;
}

export async function createZipArchive(entries,{maxTotalBytes=MAX_ARCHIVE_BYTES}={}){
  if(!Array.isArray(entries)||entries.length<1||entries.length>40)throw new Error('ZIP 项目数量必须在1到40份之间');
  if(!Number.isSafeInteger(maxTotalBytes)||maxTotalBytes<0||maxTotalBytes>MAX_ARCHIVE_BYTES)throw new Error('ZIP 大小上限无效');
  const seen=new Set(),files=[];let totalSize=0,localOffset=0;
  for(const entry of entries){
    const path=archivePath(entry?.name),key=path.toLowerCase();
    if(seen.has(key))throw new Error('ZIP 中存在重名文件');seen.add(key);
    const blob=entry.blob instanceof Blob?entry.blob:new Blob([entry.bytes??entry.blob]);
    const size=blob.size;if(!size)throw new Error('ZIP 不接受空文件');if(!Number.isSafeInteger(size)||size>0xffffffff)throw new Error('单份素材超过 ZIP 格式上限');
    totalSize+=size;if(totalSize>maxTotalBytes)throw new Error('所选素材总大小超过 ZIP 下载上限 256 MiB');
    const name=UTF8.encode(path),crc=await crc32(blob),stamp=dosTimestamp();
    if(localOffset+30+name.length+size>0xffffffff)throw new Error('ZIP 文件超过经典格式大小上限');
    files.push({name,blob,crc,size,stamp,offset:localOffset});
    localOffset+=30+name.length+size;
  }
  const localParts=[],centralParts=[];let directorySize=0;
  for(const file of files){
    localParts.push(localHeader(file.name,file.crc,file.size,file.stamp),file.blob);
    const central=centralHeader(file.name,file.crc,file.size,file.offset,file.stamp);centralParts.push(central);directorySize+=central.length;
  }
  if(localOffset+directorySize>0xffffffff)throw new Error('ZIP 索引超过格式大小上限');
  return new Blob([...localParts,...centralParts,endRecord(files.length,directorySize,localOffset)],{type:'application/zip'});
}
