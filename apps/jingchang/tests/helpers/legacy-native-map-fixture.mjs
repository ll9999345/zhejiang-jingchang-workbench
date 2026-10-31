import {promises as fs} from 'node:fs';import path from 'node:path';import http from 'node:http';import {once} from 'node:events';import {randomUUID} from 'node:crypto';
import {deflateSync,crc32} from 'node:zlib';
import {ownedNativeRoundMapFixture} from './owned-native-round-map-fixture.mjs';
import {persistFixture} from './library-backup-server.mjs';
import {canvasRunner} from '../../lib/canvas-runner.mjs';
import {creationStudioService} from '../../lib/creation-studio.mjs';
import {normalizeStudioBinding} from '../../lib/canvas-studio.mjs';
import {captureNativeResultTargets,captureNativeOutputTargets} from '../../lib/generation-results.mjs';
import {readJson,atomicJson,storeAsset} from '../../lib/workspace.mjs';
function sourcePng(index){
 const chunk=(name,data)=>{const type=Buffer.from(name),length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([length,type,data,sum]);},head=Buffer.alloc(13);head.writeUInt32BE(1,0);head.writeUInt32BE(1,4);head[8]=8;head[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(Buffer.from([0,15+index*33,80,210,255]))),chunk('IEND',Buffer.alloc(0))]);
}
export async function legacyNativeMapFixture(stage){
 const data=path.join(stage,'data'),state={requests:[]};let f;
 const mock=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks),row={method:req.method,path:req.url,images:[]};state.requests.push(row);res.setHeader('content-type','application/json');
  if(req.method==='POST'&&req.url==='/v1/images/edits'){
   const form=await new Response(body,{headers:{'content-type':req.headers['content-type']}}).formData();for(const [,v]of form)if(typeof v!=='string')row.images.push(Buffer.from(await v.arrayBuffer()));
   return res.end(JSON.stringify({data:[{b64_json:f.owned.entries[state.requests.length-1].bytes.toString('base64')}]}));
  }res.statusCode=404;res.end('{}');
 });mock.listen(0,'127.0.0.1');await once(mock,'listening');const endpoint='http://127.0.0.1:'+mock.address().port,close=()=>{mock.closeAllConnections();return new Promise(r=>mock.close(r));};
 try{
  f=await ownedNativeRoundMapFixture(data,{configure:async({f,target})=>{
   delete target.params.workflowBinding;target.params.studioBinding=normalizeStudioBinding({mode:'image',config:{protocol:'studio',baseUrl:endpoint+'/v1',model:'owned-image',count:1},includeUpstream:false,referenceSources:[{sourceNodeId:f.id('group'),sourceIndex:0},{sourceNodeId:f.loop.id}]});
  }});
  const creationStudio=creationStudioService({data,activeJobs:f.activeJobs,pollInterval:10}),runner=canvasRunner({data,activeJobs:f.activeJobs,generation:f.generation,creationStudio,pollInterval:10}),steps=await runner.plan(f.p),consumers=steps.filter(s=>s.kind==='studio');
  for(const step of steps){if(step.nodeId===f.producer.id){step.status='completed';step.jobId='owned-original-map-source';}else if(step.kind==='studio'){
   step.authorization={origin:endpoint,model:'owned-image',sendPrompt:true,sendReferences:true,requestLimit:1,budget:1,currency:'CNY'};
   for(const row of step.nativeReferences.details)if(row.pending)delete row.producerIndices;
  }}
  f.p.name='逐轮固定图与整组参考 · 旧任务隔离恢复';
  const produced=await Promise.all(Array.from({length:5},async(_,i)=>{const bytes=sourcePng(i);return{bytes,asset:await storeAsset(data,bytes,{name:'original-output-'+i+'.png',type:'image/png'})};}));
  const job={id:randomUUID(),kind:'canvas-run',projectId:f.p.id,name:'逐轮旧任务',requestId:'owned-map-legacy',createdAt:new Date().toISOString(),status:'interrupted',progress:33,message:'上游五张原结果保留，核对后继续两轮。',assets:produced.map(row=>({...row.asset,sourceNodeId:f.producer.id})),steps,snapshot:structuredClone(f.p),textResults:[],originalTexts:Object.fromEntries(f.p.nodes.map(n=>[n.id,n.text])),nativeResultTargets:captureNativeResultTargets(f.p),nativeOutputTargets:captureNativeOutputTargets(f.p),endpoint};
  await persistFixture({data,p:f.p});const file=path.join(data,'jobs',job.id+'.json');await atomicJson(file,job);
  await atomicJson(path.join(data,'jobs','owned-original-map-source.json'),{id:'owned-original-map-source',kind:'comfy',projectId:f.p.id,parentId:job.id,nodeId:f.producer.id,requestId:job.id+'-0',name:'原三次请求实际五图',createdAt:job.createdAt,status:'completed',progress:100,count:3,assets:produced.map(row=>row.asset),workflowId:steps[0].workflowId,workflowRevision:steps[0].workflowRevision});
  const credentials=(rows=consumers)=>({consent:true,studioCredentials:rows.map(step=>({nodeId:step.executionId||step.nodeId,apiKey:'synthetic-local-only'}))});
  const wait=async()=>{const until=Date.now()+30000;while(Date.now()<until){const current=await readJson(file);if(!['queued','running'].includes(current.status))return current;await new Promise(r=>setTimeout(r,25));}throw Error('Owned map resume timeout');};
  return{...f,stage,data,state,endpoint,job,file,consumers,produced,credentials,wait,close};
 }catch(error){await close();throw error;}
}
