import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {directorTestServer} from './helpers/director-test-server.mjs';
// Deliberately excluded from npm test. A real request needs direct user consent.
if(process.env.JINGCHANG_LIVE_DIRECTOR_AUTH!=='one-fictional-text-request-USD0.10')throw Error('Real DeepSeek test has no scoped authorization');
const stage=process.env.DIRECTOR_LIVE_OUTPUT;if(!stage||!path.isAbsolute(stage))throw Error('An explicit evidence directory is required');
await fs.mkdir(stage,{recursive:true});const marker=path.join(stage,'submission-intent.json');
try{await fs.access(marker);throw Error('This authorized test was already submitted; do not resubmit');}catch(e){if(e.code!=='ENOENT')throw e;}
const server=await directorTestServer(path.join(stage,'data'),{live:true});let report={passed:false,provider:'DeepSeek official',model:'deepseek-flash',requestLimit:1,budgetUSD:.10,mediaSent:false,fictionalProjectOnly:true};
const api=async(route,method='GET',body)=>{const r=await server.request(route,method,body);assert.ok(r.status<300,JSON.stringify(r.body));return r.body;};
try{
 const config=await api('/api/config');await api('/api/config','PUT',{...config,agentProvider:'deepseek'});
 let project=await api('/api/projects','POST',{name:'虚构接入验收 · 不是真实作品'});project.shots=[{id:'qa-shot-1',title:'虚构湖面',description:'虚构湖面在清晨出现薄雾',duration:5,dialogue:'测试原字幕',camera:'固定',size:'远景',sound:'',assetId:null,audioId:null,sourceNodeId:null}];project=await api('/api/projects/'+project.id,'PUT',project);
 const message='这是接入验收用的虚构画布。请只使用 edit_shots 修改 qa-shot-1：时长从5秒改为3秒，dialogue 改为“山水之间”。其余字段不变，返回恰好1项操作，不添加节点，不生成或发送任何媒体。';
 const preview=await api('/api/projects/'+project.id+'/agent-preview','POST',{message});assert.ok(preview.estimatedMaximumUSD<=.10);const requestId=randomUUID();report.requestId=requestId;report.estimatedMaximumUSD=preview.estimatedMaximumUSD;
 await fs.writeFile(marker,JSON.stringify({requestId,provider:'deepseek',budgetUSD:.10,createdAt:new Date().toISOString(),scope:'one fictional text-only plan',autoRetry:false},null,2),{flag:'wx'});
 const plan=await api('/api/projects/'+project.id+'/agent-plan','POST',{message,mode:'model',consent:true,thinking:'off',requestId,projectRevision:project.revision,previewHash:preview.previewHash,authorization:{provider:'deepseek',origin:preview.director.origin,model:preview.director.model,sendText:true,sendMedia:false,requestLimit:1,currency:'USD',budget:.10,profileRevision:preview.director.profileRevision}});
 assert.equal(plan.provider,'deepseek');assert.equal(plan.model,'deepseek-flash');assert.equal(plan.actions.length,1);assert.equal(plan.actions[0].tool,'edit_shots');assert.equal(plan.actions[0].args.shots[0].id,'qa-shot-1');assert.equal(plan.actions[0].args.shots[0].duration,3);assert.equal(plan.actions[0].args.shots[0].dialogue,'山水之间');
 assert.equal((await api('/api/projects/'+project.id)).shots[0].duration,5);
 const applied=await api('/api/projects/'+project.id+'/apply-plan','POST',{planId:plan.id});assert.equal(applied.shots[0].duration,3);assert.equal(applied.shots[0].dialogue,'山水之间');assert.equal(applied.assets.length,0);
 const receipt=JSON.parse(await fs.readFile(path.join(stage,'data/director-requests',requestId+'.json')));assert.equal(receipt.requestCount,1);assert.equal(receipt.status,'completed');report={...report,passed:true,usage:plan.usage,planId:plan.id,checks:['official model returns a complete structured plan','exact requested edit','nothing changes before apply','native application changes the fictional shot','no real project or media sent','one upstream request, no retry'],billing:'usage verified; actual official bill was not read'};
}catch(error){report.error=error.message;throw error;}
finally{await server.stop();await fs.writeFile(path.join(stage,'result.json'),JSON.stringify(report,null,2));process.stdout.write(JSON.stringify(report)+'\n');}
