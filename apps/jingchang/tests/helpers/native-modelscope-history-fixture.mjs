import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {promises as fs} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {cascadeProtocolFixture} from './native-cascade-protocol-fixture.mjs';
import {creationStudioService} from '../../lib/creation-studio.mjs';
import {nativeCascadeRunner} from '../../lib/native-cascade-runner.mjs';
import {readJson,records} from '../../lib/workspace.mjs';

// Test-only, synthetic loopback capture. Nothing is loaded from formal data.
// Call from an async node:test with its TestContext; cleanup is registered on t.
// The returned receipts keep source runSettings and native node fields literal.
// Only credential source/provider labels are omitted, as the archive explicitly
// drops these labels. No credential value is persisted or included in capture.
export async function captureNativeModelscopeHistoryFixture(t,{count=3}={}){
 const f=await cascadeProtocolFixture(t,{pairs:[['A','B']]});f.activeJobs.delete(f.parentId);
 const png=await fs.readFile(path.join(f.data,'assets',f.project.assets[0].id)),key='native-modelscope-archive-fixture-key';let base,posts=0;
 const server=http.createServer(async(req,res)=>{
  for await(const _ of req){}res.setHeader('Content-Type','application/json');
  if(req.method==='POST'&&req.url==='/v1/images/generations')return res.end(JSON.stringify({task_id:'archive-modelscope-original-'+(++posts)}));
  if(req.method==='GET'&&req.url.startsWith('/v1/tasks/archive-modelscope-original-'))return res.end(JSON.stringify({task_status:'SUCCEED',output_images:[base+'/image']}));
  if(req.url==='/image'){res.setHeader('Content-Type','image/png');return res.end(png);}res.statusCode=404;res.end('{}');
 });server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{for(const active of f.activeJobs.values())active.controller.abort();for(let i=0;f.activeJobs.size&&i<1500;i++)await delay(5);await new Promise(resolve=>server.close(resolve));});
 const source=f.project.nodes.find(n=>n.id==='A'),receiver=f.project.nodes.find(n=>n.id==='B');delete source.params.workflowBinding;delete receiver.params.workflowBinding;
 const raw=source.params.nativeCanvas.node;
 Object.assign(raw,{msModel:'legacy/source-model',msSize:'513x1027',msLoraEnabled:true,msLoraId:'fixture/source-lora',msLoraStrength:.8});
 raw.runSettings={engine:'modelscope',msgenModel:'custom',msCustomModel:'fixture/explicit-model',count,msRatio:'custom',msResolution:'custom',msCustomRatio:'1:2',msCustomRatioWidth:1,msCustomRatioHeight:2,msCustomSize:'641x1279',msCustomWidth:641,msCustomHeight:1279};
 raw.promptDraftHtml='<p>synthetic archive input</p>';raw.promptDraftText='synthetic archive input';
 source.params.studioBinding={mode:'image',config:{protocol:'modelscope',baseUrl:base+'/v1',model:'fixture/explicit-model',imageAsync:true,quality:'auto',transparent:false,size:'641x1279',count,unitPrice:0,currency:'CNY',loras:{},nativeModelscope:{version:1,modelKey:'custom',acceptsImages:true}},referenceSources:[],includeUpstream:true};
 const creationStudio=creationStudioService({data:f.data,activeJobs:f.activeJobs,pollInterval:5}),runner=nativeCascadeRunner({...f,creationStudio,pollInterval:5}),preview=await runner.plan(f.project,{nodeId:'B'});
 const parent=await runner.start(f.project,{requestId:'synthetic-modelscope-history',nodeId:'B',consent:true,revision:f.project.revision,previewHash:preview.previewHash,studioCredentials:preview.steps.filter(s=>s.kind==='studio').map(s=>({nodeId:s.executionId,apiKey:key,authorization:{origin:base,model:s.studio.config.model,sendPrompt:true,sendReferences:s.sendAssets,requestLimit:s.count,budget:1,currency:'CNY'}}))},f.pool[0]);
 let completed;for(let i=0;i<1500;i++){const current=await readJson(path.join(f.data,'jobs',parent.id+'.json'));if(!['queued','running'].includes(current.status)&&!f.activeJobs.size){completed=current;break;}await delay(5);}
 if(completed?.status!=='completed'||posts!==count)throw Error('Synthetic ModelScope archive capture did not finish exactly its planned POST count');
 const jobs=(await records(path.join(f.data,'jobs'))).filter(j=>j.projectId===f.project.id).map(({credentialSource,credentialProvider,...job})=>job);
 const allAssets=new Map([...f.project.assets,...jobs.flatMap(j=>j.assets||[])].map(a=>[a.id,a]));
 const assets=await Promise.all([...allAssets.values()].map(async meta=>({meta:await readJson(path.join(f.data,'assets',meta.id+'.json')),base64:(await fs.readFile(path.join(f.data,'assets',meta.id))).toString('base64')})));
 const captured={scenario:'ModelScope smart-image literal source, actual multi-request receipts',project:structuredClone(f.project),jobs,assets,workflows:[]};
 if(JSON.stringify(captured).includes(key))throw Error('Synthetic credential was retained in a capture');
 return captured;
}
