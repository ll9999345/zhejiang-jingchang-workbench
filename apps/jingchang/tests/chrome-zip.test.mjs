import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createZipArchive} from '../tools/chrome-local-asset-importer/zip-archive.js';

test('多选网页素材生成标准 UTF-8 ZIP，系统解压工具可验证并读取原始文件',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-chrome-zip-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const archivePath=path.join(directory,'网页素材.zip');
  const sourceA=Buffer.from([0,1,2,255,65]),sourceB=Buffer.from('中文图片来源');
  const archive=await createZipArchive([
    {name:'旅行相册/山水.png',blob:new Blob([sourceA],{type:'image/png'})},
    {name:'旅行相册/说明.txt',blob:new Blob([sourceB],{type:'text/plain'})}
  ]);
  const zipBytes=Buffer.from(await archive.arrayBuffer());await fs.writeFile(archivePath,zipBytes);
  const check=spawnSync('/usr/bin/unzip',['-t',archivePath],{encoding:'utf8'});assert.equal(check.status,0,check.stderr||check.stdout);
  const extracted=spawnSync('/usr/bin/unzip',['-p',archivePath]);assert.equal(extracted.status,0);assert.deepEqual(extracted.stdout,Buffer.concat([sourceA,sourceB]));
  const central=zipBytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));assert.ok(central>0);const view=new DataView(zipBytes.buffer,zipBytes.byteOffset,zipBytes.byteLength),names=[];let offset=central;
  while(view.getUint32(offset,true)===0x02014b50){const flags=view.getUint16(offset+8,true),nameLength=view.getUint16(offset+28,true),extraLength=view.getUint16(offset+30,true),commentLength=view.getUint16(offset+32,true);assert.ok(flags&0x0800);names.push(zipBytes.subarray(offset+46,offset+46+nameLength).toString('utf8'));offset+=46+nameLength+extraLength+commentLength;}
  assert.deepEqual(names,['旅行相册/山水.png','旅行相册/说明.txt']);
});

test('ZIP 拒绝路径穿越、大小写重名、超量素材和超过下载上限的批次',async()=>{
  const blob=new Blob(['test']);
  await assert.rejects(createZipArchive([{name:'../outside.txt',blob}]),/相对路径|不安全路径/);
  await assert.rejects(createZipArchive([{name:'page/a.png',blob},{name:'PAGE/A.PNG',blob}]),/重名/);
  await assert.rejects(createZipArchive([{name:'a.txt',blob},{name:'b.txt',blob}],{maxTotalBytes:7}),/超过 ZIP 下载上限/);
  await assert.rejects(createZipArchive(Array.from({length:41},(_,index)=>({name:`${index}.txt`,blob}))),/1到40/);
});
