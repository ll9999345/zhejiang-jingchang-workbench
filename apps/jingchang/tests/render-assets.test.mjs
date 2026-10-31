import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {promises as fs,createReadStream} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {makeProject} from '../lib/model.mjs';
import {atomicJson,readJson,records,userError} from '../lib/workspace.mjs';
import {renderService} from '../lib/render-service.mjs';
import {importRenderAsset} from '../lib/render-assets.mjs';
import {MAX_STREAM_MEDIA_BYTES} from '../public/media-transfer-core.js';

async function digest(file){const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');}
async function fixture(size=0){
 const data=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'jc-render-stream-'))),project=makeProject('成片留存'),job={id:randomUUID(),projectId:project.id,kind:'render',status:'completed',createdAt:new Date().toISOString(),snapshot:structuredClone(project),result:{attempt:'attempt-fixture'}};
 const output=path.join(data,'renders',job.id,job.result.attempt,'final.mp4');await fs.mkdir(path.dirname(output),{recursive:true});
 const bytes=execFileSync('ffmpeg',['-v','error','-nostdin','-f','lavfi','-i','color=c=blue:s=32x32:d=0.1','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-f','mp4','-movflags','frag_keyframe+empty_moov','pipe:1']);await fs.writeFile(output,bytes);
 if(size>bytes.length+8){const free=Buffer.alloc(8);free.writeUInt32BE(size-bytes.length);free.write('free',4);const h=await fs.open(output,'r+');try{await h.write(free,0,8,bytes.length);await h.truncate(size);}finally{await h.close();}}
 const activeJobs=new Map(),projects={apply:async(j,asset,revision)=>{if(project.runs.some(r=>r.jobId===j.id))return structuredClone(project);if(project.revision!==revision)throw userError('revision changed',409);project.assets.push(asset);project.runs.push({jobId:j.id});project.revision++;return structuredClone(project);}};
 await atomicJson(path.join(data,'jobs',job.id+'.json'),job);return{data,project,job,output,activeJobs,service:renderService({data,activeJobs,projects}),persist:j=>atomicJson(path.join(data,'jobs',j.id+'.json'),j)};
}
test('真实超过150MiB的MP4以流式方式加入画布，保留原文件、摘要及重复点击同一素材',async()=>{
 const f=await fixture(150*1024*1024+1024),before=await digest(f.output),readFile=fs.readFile;
 fs.readFile=async function(file,...args){assert.notEqual(String(file),f.output,'成片不能整个读入内存');return readFile.call(this,file,...args);};
 let result;try{result=await f.service.apply(f.project.id,f.job.id,{revision:0});}finally{fs.readFile=readFile;}
 const asset=result.assets[0];assert.equal(asset.size,150*1024*1024+1024);assert.equal(asset.sha256,before);assert.equal(asset.source,'local-render');assert.equal(asset.renderJobId,f.job.id);assert.equal(await digest(path.join(f.data,'assets',asset.id)),before);assert.equal(await digest(f.output),before);
 execFileSync('ffmpeg',['-v','error','-nostdin','-i',path.join(f.data,'assets',asset.id),'-f','null','-']);
 await f.service.apply(f.project.id,f.job.id,{revision:0});assert.equal(f.project.runs.length,1);assert.equal((await records(path.join(f.data,'assets'))).length,1);assert.equal(f.activeJobs.size,0);
});
test('媒体复制完成但任务索引未保存时，按持久导入收据恢复同一素材而不再复制',async()=>{
 const f=await fixture(),asset=await importRenderAsset({data:f.data,activeJobs:f.activeJobs,job:f.job,persist:f.persist});assert.equal(f.job.assetId,undefined);
 const recorded=await readJson(path.join(f.data,'jobs',f.job.id+'.json'));assert.equal(recorded.renderAssetImport.requestId,f.job.renderAssetImport.requestId);
 const restored=await f.service.apply(f.project.id,f.job.id,{revision:0});assert.equal(restored.assets[0].id,asset.id);assert.equal((await records(path.join(f.data,'assets'))).length,1);
 assert.equal((await fs.readdir(path.join(f.data,'asset-imports'))).length,1);
});
test('成片修改后不得冒用原导入收据，原件与已导入副本都保留',async()=>{
 const f=await fixture(),asset=await importRenderAsset({data:f.data,activeJobs:f.activeJobs,job:f.job,persist:f.persist});const old=await digest(path.join(f.data,'assets',asset.id));
 const h=await fs.open(f.output,'r+');try{await h.write(Buffer.from([0]),0,1,0);}finally{await h.close();}
 await assert.rejects(f.service.apply(f.project.id,f.job.id,{revision:0}),/发生变化/);assert.equal(await digest(path.join(f.data,'assets',asset.id)),old);assert.equal(f.project.assets.length,0);assert.equal((await records(path.join(f.data,'assets'))).length,1);
});
test('超过4GB的成片明确拒绝，文件不删，画布不加空素材',async()=>{
 const f=await fixture(MAX_STREAM_MEDIA_BYTES+1);await assert.rejects(f.service.apply(f.project.id,f.job.id,{revision:0}),/4GB/);assert.equal((await fs.stat(f.output)).size,MAX_STREAM_MEDIA_BYTES+1);assert.equal(f.project.assets.length,0);assert.equal((await records(path.join(f.data,'assets'))).length,0);
});
test('成片目录符号链接不能导入；原修订冲突后可使用已复制素材而不会重复副本',async()=>{
 const f=await fixture(),original=f.output,alias=path.join(f.data,'renders','linked-job'),outside=path.dirname(path.dirname(original));await fs.symlink(outside,alias);const linked={...f.job,id:'linked-job'};
 await assert.rejects(importRenderAsset({data:f.data,activeJobs:f.activeJobs,job:linked,persist:async()=>{}}),/不可用/);
 f.project.revision=1;await assert.rejects(f.service.apply(f.project.id,f.job.id,{revision:0}),/revision changed/);const first=await readJson(path.join(f.data,'jobs',f.job.id+'.json'));assert.ok(first.assetId);
 await f.service.apply(f.project.id,f.job.id,{revision:1});assert.equal(f.project.assets[0].id,first.assetId);assert.equal((await records(path.join(f.data,'assets'))).length,1);assert.ok((await fs.stat(original)).isFile());
});
test('检查与打开之间替换成片又恢复原路径时，固定文件句柄拒绝复制被调包的文件',async()=>{
 const f=await fixture(),originalOpen=fs.open,held=path.join(path.dirname(f.output),'retained-original.mp4'),replacement=path.join(path.dirname(f.output),'retained-replacement.mp4');let swapped=false;
 fs.open=async function(file,...args){
  if(String(file)===f.output&&args[0]!==undefined&&typeof args[0]==='number'&&!swapped){
   swapped=true;await fs.rename(f.output,held);await fs.copyFile(held,f.output);const handle=await originalOpen.call(this,file,...args);
   await fs.rename(f.output,replacement);await fs.rename(held,f.output);return handle;
  }
  return originalOpen.call(this,file,...args);
 };
 try{await assert.rejects(f.service.apply(f.project.id,f.job.id,{revision:0}),/打开期间发生变化/);}finally{fs.open=originalOpen;}
 assert.equal(swapped,true);assert.equal(f.project.assets.length,0);assert.equal((await records(path.join(f.data,'assets'))).length,0);assert.ok((await fs.stat(f.output)).isFile());assert.ok((await fs.stat(replacement)).isFile());
});
test('复制后因修订冲突未加入画布，已导入副本被修改时重试必须核对原收据',async()=>{
 const f=await fixture();f.project.revision=1;await assert.rejects(f.service.apply(f.project.id,f.job.id,{revision:0}),/revision changed/);
 const job=await readJson(path.join(f.data,'jobs',f.job.id+'.json')),output=path.join(f.data,'assets',job.assetId),h=await fs.open(output,'r+');try{await h.write(Buffer.from([0]),0,1,0);}finally{await h.close();}
 await assert.rejects(f.service.apply(f.project.id,f.job.id,{revision:1}),/素材与记录不一致/);assert.equal(f.project.assets.length,0);assert.equal((await records(path.join(f.data,'assets'))).length,1);assert.ok((await fs.stat(f.output)).isFile());
});
