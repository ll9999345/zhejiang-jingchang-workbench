import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createMediaArchive,mediaArchiveLimits} from '../lib/media-archive.mjs';
import {makeProject} from '../lib/model.mjs';
import {storeAsset} from '../lib/workspace.mjs';

const crcTable=Uint32Array.from({length:256},(_,n)=>{let x=n;for(let i=0;i<8;i++)x=(x&1)?0xedb88320^(x>>>1):x>>>1;return x>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const b of bytes)crc=crcTable[(crc^b)&255]^(crc>>>8);return(crc^0xffffffff)>>>0;}
async function fixture(t){const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-media-archive-'));t.after(()=>fs.rm(data,{recursive:true,force:true}));await fs.mkdir(path.join(data,'assets'),{recursive:true});return data;}
function entriesFromZip(zip){
  const entries=[];let offset=0;
  while(zip.readUInt32LE(offset)===0x04034b50){
    const flags=zip.readUInt16LE(offset+6),method=zip.readUInt16LE(offset+8),crc=zip.readUInt32LE(offset+14),size=zip.readUInt32LE(offset+18),nameLength=zip.readUInt16LE(offset+26),extraLength=zip.readUInt16LE(offset+28);
    assert.equal(flags&0x0800,0x0800);assert.equal(method,0);
    const name=zip.subarray(offset+30,offset+30+nameLength).toString('utf8'),start=offset+30+nameLength+extraLength,payload=zip.subarray(start,start+size);
    assert.equal(payload.length,size);assert.equal(crc32(payload),crc);entries.push({name,payload});offset=start+size;
  }
  const end=zip.length-22;assert.equal(zip.readUInt32LE(end),0x06054b50);assert.equal(zip.readUInt32LE(end+16),offset);assert.equal(zip.readUInt16LE(end+10),entries.length);return entries;
}
async function collect(stream){const chunks=[];for await(const chunk of stream)chunks.push(chunk);return Buffer.concat(chunks);}

test('media archive writes original bytes, UTF-8 names and safe duplicate filenames',async t=>{
  const data=await fixture(t),project=makeProject('压缩验收'),a=Buffer.from('image-one'),b=Buffer.from('image-two');
  const first=await storeAsset(data,a,{name:'../雾气.png',type:'image/png'}),second=await storeAsset(data,b,{name:'..\\雾气.png',type:'image/png'});project.assets=[first,second];
  const archive=await createMediaArchive({data,project,assetIds:[first.id,second.id]});
  const entries=entriesFromZip(await collect(archive.stream));
  assert.deepEqual(entries.map(item=>item.name),['雾气.png','雾气 (2).png']);
  assert.deepEqual(entries.map(item=>item.payload),[a,b]);
  assert.equal(archive.count,2);
});

test('media archive rejects foreign, repeated, oversized, over-count and symlink assets',async t=>{
  const data=await fixture(t),project=makeProject('边界验收'),bytes=Buffer.from('original');
  const own=await storeAsset(data,bytes,{name:'原图.png',type:'image/png'}),foreign=await storeAsset(data,bytes,{name:'外部.png',type:'image/png'});project.assets=[own];
  await assert.rejects(createMediaArchive({data,project,assetIds:[foreign.id]}),/只能下载当前项目/);
  await assert.rejects(createMediaArchive({data,project,assetIds:[own.id,own.id]}),/重复项目/);
  await assert.rejects(createMediaArchive({data,project,assetIds:Array.from({length:mediaArchiveLimits.files+1},(_,i)=>`asset${i}`)}),/1–100 份/);
  const oversized=randomUUID();project.assets.push({id:oversized});await fs.writeFile(path.join(data,'assets',oversized+'.json'),JSON.stringify({id:oversized,name:'超大.bin',size:mediaArchiveLimits.bytes+1}));
  await assert.rejects(createMediaArchive({data,project,assetIds:[oversized]}),/超过 256 MB/);
  const source=path.join(data,'outside.bin');await fs.writeFile(source,bytes);await fs.unlink(path.join(data,'assets',own.id));await fs.symlink(source,path.join(data,'assets',own.id));
  await assert.rejects(createMediaArchive({data,project,assetIds:[own.id]}),/无法安全读取/);
  assert.deepEqual(await fs.readFile(source),bytes);
});
