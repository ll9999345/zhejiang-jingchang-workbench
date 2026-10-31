// Browser acceptance uses synthetic loopback generation, never a real model.
// Data remains in a fresh temporary folder for inspection; nothing is deleted.
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {cascadeProtocolFixture} from './native-cascade-protocol-fixture.mjs';
import {localServer} from './library-backup-server.mjs';
import {atomicJson,readJson,records} from '../../lib/workspace.mjs';

const evidence=process.env.NATIVE_CASCADE_EVIDENCE;
if(!evidence)throw Error('Specify a new acceptance evidence directory');
const callbacks=[],t={after:callback=>callbacks.push(callback)},f=await cascadeProtocolFixture(t,{pairs:[['A','B'],['A','C'],['B','D'],['C','E']]});
f.activeJobs.delete(f.parentId);f.project.name='智能串联 · 本机合成验收';f.project.viewport={x:120,y:180,zoom:0.66};
const positions={A:[80,70],B:[440,0],C:[440,320],D:[800,0],E:[800,320]};
for(const node of f.project.nodes){[node.x,node.y]=positions[node.id];node.title={A:'输入图 · 生成构图',B:'共享结果 · 延展',C:'共享结果 · 光影',D:'延展结果',E:'光影结果'}[node.id];
 node.params.nativeCanvas.adaptation='configured';node.assetId=node.params.nativeCanvas.mediaAssetIds[0];}
const template=await f.generation.template(f.project.nodes[0].params.workflowBinding.workflowId);
await f.generation.configure(template.id,{revision:template.revision,nativeConfig:{fields:[
 {id:'prompt',node:'1',input:'text',name:'提示词',type:'textarea',default:'默认文字'},
 {id:'image',node:'3',input:'image',name:'参考图',type:'image',default:'未上传.png'}]}});
await atomicJson(path.join(f.data,'projects',f.project.id,'project.json'),f.project);
const app=await localServer(f.data,{log:path.join(evidence,'browser-server.log')});
const backends=await app.api('/api/comfy-backends');await app.api('/api/comfy-backends','PUT',{revision:backends.revision,backends:f.pool,activeId:f.pool[0].id});
await atomicJson(path.join(evidence,'browser-fixture.json'),{base:app.base,url:app.base+'/?project='+f.project.id+'&view=canvas',data:f.data,projectId:f.project.id,scope:'isolated synthetic loopback services',originalProjectsTouched:false,paidCalls:0,externalCalls:0});
process.stdout.write(JSON.stringify({url:app.base+'/?project='+f.project.id+'&view=canvas',data:f.data})+'\n');
let closing=false;
async function finish(){if(closing)return;closing=true;
 const jobs=await records(path.join(f.data,'jobs')),project=await readJson(path.join(f.data,'projects',f.project.id,'project.json'));
 await atomicJson(path.join(evidence,'browser-fixture-result.json'),{date:new Date().toISOString(),scope:'synthetic loopback; browser interaction',
  requests:f.state.prompts.map(record=>({id:record.id,backend:record.backend,text:record.body.prompt['1'].inputs.text})),
  jobs:jobs.filter(job=>job.kind==='canvas-run').map(job=>({id:job.id,status:job.status,executionMode:job.executionMode,assets:job.assets.length,applied:job.applied===true})),
  project:{id:project.id,revision:project.revision,assets:project.assets.length,runs:project.runs.length},data:f.data,paidCalls:0,externalCalls:0});
 await app.stop();for(const callback of callbacks.reverse())await callback();process.exit(0);
}
process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{if(data.includes('stop'))void finish();});
process.on('SIGTERM',()=>void finish());process.on('SIGINT',()=>void finish());
while(!closing)await delay(1000);
