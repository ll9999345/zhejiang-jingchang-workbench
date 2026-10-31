import {promises as fs} from 'node:fs';
import path from 'node:path';import http from 'node:http';import {once} from 'node:events';import {randomUUID} from 'node:crypto';
import {ownedSmartFixture} from './smart-group-owned-fixture.mjs';
import {nativeRoundMediaFixture} from './native-round-media-fixture.mjs';
import {persistFixture} from './library-backup-server.mjs';
import {generationService} from '../../lib/generation.mjs';
import {canvasRunner} from '../../lib/canvas-runner.mjs';
import {directImageService} from '../../lib/direct-images.mjs';
import {atomicJson,readJson} from '../../lib/workspace.mjs';
export async function legacyNativeConfirmFixture({stage}){
 const data=path.join(stage,'data'),owned=await ownedSmartFixture(data),f=nativeRoundMediaFixture({start:3,batch:2,count:1,producerCount:5}),state={calls:[]};f.p.assets=owned.p.assets;
 for(const n of f.p.nodes){if(n.assetId)n.assetId=owned.mapping.get(n.assetId);const v=n.params.nativeCanvas;v.mediaAssetIds=v.mediaAssetIds.map(id=>owned.mapping.get(id));for(const r of v.resources)r.assetId=owned.mapping.get(r.assetId);}
 const mock=http.createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);const bytes=Buffer.concat(chunks);state.calls.push({method:req.method,url:req.url,images:[]});res.setHeader('content-type','application/json');
  if(req.method==='POST'&&req.url==='/v1/images/edits'){
   const form=await new Response(bytes,{headers:{'content-type':req.headers['content-type']}}).formData();for(const [,v]of form)if(typeof v!=='string')state.calls.at(-1).images.push(Buffer.from(await v.arrayBuffer()));
   return res.end(JSON.stringify({data:[{b64_json:owned.entries[0].bytes.toString('base64')}]}));
  }res.statusCode=404;res.end('{}');
 });mock.listen(0,'127.0.0.1');await once(mock,'listening');const endpoint='http://127.0.0.1:'+mock.address().port;
 const close=()=>{mock.closeAllConnections();return new Promise(r=>mock.close(r));};
 try{
  const activeJobs=new Map(),generation=generationService({data,activeJobs}),template=await generation.saveTemplate({name:'保留的已完成上游',workflow:{'1':{class_type:'SyntheticImage',inputs:{}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}}}});f.producer.params.workflowBinding.workflowId=template.id;
  const target=f.node('target');delete target.params.workflowBinding;target.params.nativeCanvas.adaptation='configured';target.params.imageBinding={platform:{id:'owned-api',name:'本机隔离协议',protocol:'openai-compatible',baseUrl:endpoint+'/v1',models:[{id:'owned-image',category:'image',referenceSupport:true}]},model:'owned-image',includeUpstream:false,referenceSources:[{sourceNodeId:f.loop.id}]};
  const directImages=directImageService({data,activeJobs,platforms:{get:async()=>{throw Error('Only owned saved platform');}}}),runner=canvasRunner({data,activeJobs,generation,directImages}),steps=await runner.plan(f.p),consumer=steps.find(s=>s.kind==='image-api');
  if(!consumer)throw Error('Fixture did not plan consumer');
  consumer.authorization={origin:endpoint,model:'owned-image',sendPrompt:true,sendReferences:true,requestLimit:1,budget:1,currency:'CNY'};
  for(const s of steps)if(s.nodeId===f.producer.id){s.status='completed';s.jobId='owned-completed-source';s.count=1;}else if(s===consumer){for(const d of s.nativeReferences.details)if(d.pending)delete d.producerIndices;}
  // One original source request returned five media items; request count is
  // deliberately different from actual output count.
  f.producer.params.workflowBinding.count=1;f.p.name='旧任务确认与续跑 · 隔离样本';
  const job={id:randomUUID(),projectId:f.p.id,kind:'canvas-run',name:'旧切片任务确认',requestId:'owned-legacy-confirm',status:'interrupted',createdAt:new Date().toISOString(),progress:50,message:'已完成上游保留，核对后继续。',assets:owned.entries.map(row=>({...row.asset,sourceNodeId:f.producer.id})),textResults:[],originalTexts:Object.fromEntries(f.p.nodes.map(n=>[n.id,n.text])),snapshot:structuredClone(f.p),endpoint,steps};
  await persistFixture({data,p:f.p});await fs.mkdir(path.join(data,'jobs'),{recursive:true});const file=path.join(data,'jobs',job.id+'.json');await atomicJson(file,job);
  await atomicJson(path.join(data,'jobs','owned-completed-source.json'),{id:'owned-completed-source',kind:'comfy',projectId:f.p.id,parentId:job.id,nodeId:f.producer.id,requestId:job.id+'-0',name:'保留的已完成原请求',createdAt:job.createdAt,status:'completed',progress:100,count:1,assets:owned.entries.map(row=>row.asset),workflowId:template.id,workflowRevision:template.revision,workflow:template.workflow});
  const credentials=()=>({consent:true,imageCredentials:[{nodeId:consumer.executionId||consumer.nodeId,apiKey:'synthetic-local-only',authorization:{origin:endpoint,model:'owned-image',sendPrompt:true,sendReferences:true,requestLimit:1,budget:1,currency:'CNY'}}]});
  const wait=async()=>{const until=Date.now()+25000;while(Date.now()<until){const row=await readJson(file);if(!['running','queued'].includes(row.status))return row;await new Promise(r=>setTimeout(r,25));}throw Error('Owned resume timeout');};
  return{...f,stage,data,owned,state,endpoint,job,file,consumer,credentials,wait,close};
 }catch(error){await close();throw error;}
}
