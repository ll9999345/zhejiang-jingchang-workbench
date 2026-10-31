import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {cascadeProtocolFixture} from './helpers/native-cascade-protocol-fixture.mjs';
import {localServer} from './helpers/library-backup-server.mjs';
import {atomicJson,readJson} from '../lib/workspace.mjs';

test('隔离网页API的串联预检、拒绝旧检查、真实本机提交、取回和幂等',async t=>{
 const f=await cascadeProtocolFixture(t);f.activeJobs.delete(f.parentId);
 const template=await f.generation.template(f.project.nodes[0].params.workflowBinding.workflowId);
 await f.generation.configure(template.id,{revision:template.revision,nativeConfig:{fields:[
  {id:'prompt',node:'1',input:'text',name:'提示词',type:'textarea',default:'原默认'},
  {id:'image',node:'3',input:'image',name:'图',type:'image',default:'未上传.png'}]}});
 await atomicJson(path.join(f.data,'projects',f.project.id,'project.json'),f.project);
 const app=await localServer(f.data);t.after(app.stop);const {api}=app;
 const health=await api('/api/health');assert.equal(health.capabilities.nativeCascade,true);
 const backends=await api('/api/comfy-backends');await api('/api/comfy-backends','PUT',{revision:backends.revision,backends:f.pool,activeId:f.pool[0].id});
 const route='/api/projects/'+f.project.id,preview=await api(route+'/native-cascade-plan?nodeId=C');
 assert.equal(preview.summary.requests,2);assert.equal(f.state.prompts.length,0);
 const body={executionMode:'native-cascade',nodeId:'C',revision:f.project.revision,consent:true,requestId:'api-cascade',previewHash:preview.previewHash,backendId:f.pool[0].id};
 const stale=await fetch(app.base+route+'/canvas-run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,previewHash:'stale'})});assert.equal(stale.status,409);assert.equal(f.state.prompts.length,0);
 const submitted=await api(route+'/canvas-run','POST',body);assert.equal(submitted.executionMode,'native-cascade');assert.equal(submitted.cascadeState,undefined);assert.equal(submitted.snapshot,undefined);
 let job;for(let i=0;i<1200;i++){job=await api('/api/jobs/'+submitted.id);if(!['queued','running'].includes(job.status))break;await delay(10);}
 assert.equal(job.status,'completed',job.message);assert.equal(f.state.prompts.length,2);assert.equal(job.assets.length,2);
 const duplicate=await api(route+'/canvas-run','POST',body);assert.equal(duplicate.id,submitted.id);assert.equal(f.state.prompts.length,2);
 const listed=await api('/api/jobs?projectId='+f.project.id),listedJob=listed.find(j=>j.id===job.id);assert.equal(listedJob.snapshot,undefined);assert.equal(listedJob.cascadeProgram,undefined);
 const applied=await api(route+'/apply-generation','POST',{jobId:job.id,revision:f.project.revision});assert.equal(applied.assets.length,f.project.assets.length+2);assert.ok(applied.nodes.find(n=>n.id==='B').assetId);
 const twice=await fetch(app.base+route+'/apply-generation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId:job.id,revision:applied.revision})});assert.equal(twice.status,409);
 const script=await fetch(app.base+'/native-cascade-ui.js');assert.equal(script.status,200);assert.match(await script.text(),/nativeCascadePlanMarkup/);
 const inspector=await fetch(app.base+'/native-canvas.js');assert.match(await inspector.text(),/run-native-cascade/);
 const saved=await readJson(path.join(f.data,'projects',f.project.id,'project.json'));assert.deepEqual(saved,applied);
 const evidence=process.env.NATIVE_CASCADE_EVIDENCE;
 if(evidence){await fs.mkdir(evidence,{recursive:true});await atomicJson(path.join(evidence,'api-receipt.json'),{passed:true,date:new Date().toISOString(),scope:'isolated loopback HTTP API; synthetic PNG output',requests:f.state.prompts.length,externalCalls:0,paidCalls:0,projectId:f.project.id,jobId:job.id,appliedAssets:job.assets.length,data:f.data});}
});
