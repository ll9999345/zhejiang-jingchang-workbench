import './helpers/local-network-only.mjs';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {publicMediaService} from '../lib/public-media.mjs';
import {makeProject} from '../lib/model.mjs';
import {atomicJson} from '../lib/workspace.mjs';
import {MAX_STREAM_MEDIA_BYTES} from '../public/media-transfer-core.js';
import {ownedLargeVideo} from './helpers/owned-large-media.mjs';

const artifacts=path.join(process.cwd(),'artifacts','media-transfer-4gb-'+Date.now()),data=path.join(artifacts,'data');await fs.mkdir(data,{recursive:true});
const fixture=await ownedLargeVideo(artifacts,MAX_STREAM_MEDIA_BYTES),p=makeProject('4GB仅本机协议验收'),asset={id:'owned-max-video',name:'本机4GB合成视频.mp4',type:'video/mp4',size:fixture.size,url:'/media/owned-max-video'},activeJobs=new Map();
await fs.mkdir(path.join(data,'assets'));await fs.link(fixture.file,path.join(data,'assets',asset.id));await atomicJson(path.join(data,'assets',asset.id+'.json'),asset);p.assets=[asset];
let base,received=null;const checks=[],startRss=process.memoryUsage().rss;let peakRss=startRss;const sampler=setInterval(()=>peakRss=Math.max(peakRss,process.memoryUsage().rss),20);
const mock=http.createServer({requestTimeout:3600000},async(req,res)=>{
 try{
  assert.equal(req.url,'/upload');assert.equal(req.headers.authorization,undefined);let prefix=Buffer.alloc(0),headerDone=false,bodyCount=0,remaining=fixture.size,ending=Buffer.alloc(0),total=0;const digest=createHash('sha256');
  for await(const raw of req){total+=raw.length;let chunk=raw;if(!headerDone){prefix=Buffer.concat([prefix,chunk]);assert.ok(prefix.length<128*1024);const end=prefix.indexOf('\r\n\r\n');if(end<0)continue;assert.match(prefix.subarray(0,end).toString(),/name="file"; filename="owned-max-video\.mp4"/);assert.equal(prefix.subarray(0,end).toString().includes(asset.name),false);chunk=prefix.subarray(end+4);headerDone=true;}
   const count=Math.min(remaining,chunk.length);if(count){digest.update(chunk.subarray(0,count));remaining-=count;bodyCount+=count;}if(count<chunk.length){ending=Buffer.concat([ending,chunk.subarray(count)]);assert.ok(ending.length<256);}
  }
  assert.equal(remaining,0);assert.equal(total,Number(req.headers['content-length']));assert.match(ending.toString(),/^\r\n--jc-[\w-]+--\r\n$/);received={bodyCount,total,sha256:digest.digest('hex'),requestHeaders:req.headers};res.end(base+'/owned-max.mp4\n');
 }catch(e){res.statusCode=500;res.end('owned check failed');received={error:e.message};}
});mock.listen(0,'127.0.0.1');await once(mock,'listening');base='http://127.0.0.1:'+mock.address().port;
try{
 const service=publicMediaService({data,projects:{load:async id=>{assert.equal(id,p.id);return p;}},activeJobs,timeoutMs:120000}),input={projectId:p.id,assetId:asset.id,service:'temp',endpoint:base+'/upload',purpose:'generation-reference'};
 await assert.rejects(service.preview({...input,service:'litterbox',endpoint:base+'/resources/internals/api.php'}),/容量/);checks.push('4GB rejected for the capped Litterbox profile without a request');
 const plan=await service.preview(input),request={...input,requestId:'owned-max-once',fingerprint:plan.fingerprint,consent:{fingerprint:plan.fingerprint,endpoint:plan.endpoint,service:plan.service,purpose:plan.purpose,retentionHours:72,requestLimit:1,publicScope:'anyone-with-url',sendOriginalMedia:true}},started=await service.start(request);
 let record;const deadline=Date.now()+120000;while(Date.now()<deadline){record=await service.get(started.id,p.id);if(record.status!=='uploading')break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(record.status,'ready',JSON.stringify(received));assert.equal(received.bodyCount,MAX_STREAM_MEDIA_BYTES);assert.equal(record.bytesSent,MAX_STREAM_MEDIA_BYTES);assert.equal(received.sha256,plan.source.sourceSha256);assert.equal((await service.start(request)).id,record.id);assert.equal((await service.list(p.id)).length,1);checks.push('exact 4,000,000,000 original bytes streamed once through multipart and matched the full SHA256');
 const physical=(await fs.stat(fixture.file)).blocks*512;assert.ok(physical<1024*1024);assert.ok(peakRss-startRss<512*1024*1024);checks.push('sparse synthetic fixture occupies under 1MiB; process RSS growth remained below 512MiB');
 const result={ok:true,localOnly:true,checks,sourceBytes:fixture.size,sourcePhysicalBytes:physical,receiver:received,record,startRss,peakRss,rssGrowth:peakRss-startRss,productionUpload:false,paidGeneration:false};await atomicJson(path.join(artifacts,'result.json'),result);console.log(JSON.stringify({ok:true,artifacts,bytes:fixture.size,sha256:received.sha256,rssGrowth:result.rssGrowth,checks:checks.length}));
}finally{clearInterval(sampler);await new Promise(r=>{mock.closeAllConnections();mock.close(r);});}
