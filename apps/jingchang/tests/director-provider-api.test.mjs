import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import http from 'node:http';
import {randomUUID} from 'node:crypto';

import {directorTestServer} from './helpers/director-test-server.mjs';

test('真实本机路由：配置、检查、授权、唯一请求、逐镜应用及恢复',async t=>{
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-director-api-')),s=await directorTestServer(data);t.after(()=>s.stop());
 let config=(await s.request('/api/config')).body;
 assert.equal((await s.request('/api/config','PUT',{...config,agentProvider:'deepseek'})).status,200);
 const health=(await s.request('/api/health')).body;assert.equal(health.agentConfigured,true);assert.equal(health.model,'deepseek-flash');assert.equal(health.director.remote,true);
 let p=(await s.request('/api/projects','POST',{name:'虚构助理测试'})).body;p.shots=[{id:'shot-a',title:'镜头A',description:'原画面',duration:5,dialogue:'原字幕',camera:'固定',size:'中景',sound:'',assetId:null,audioId:null,sourceNodeId:null}];p=(await s.request('/api/projects/'+p.id,'PUT',p)).body;
 const message='让开头更紧凑，保留已有素材',preview=(await s.request('/api/projects/'+p.id+'/agent-preview','POST',{message})).body;
 assert.equal(preview.projectRevision,p.revision);assert.equal(preview.scope.shots,1);assert.ok(preview.estimatedMaximumUSD<.10);assert.equal((await s.calls()).length,0);
 const body={message,mode:'model',consent:true,thinking:'off',requestId:randomUUID(),projectRevision:p.revision,previewHash:preview.previewHash,authorization:{provider:'deepseek',origin:'https://api.deepseek.com',model:'deepseek-flash',sendText:true,sendMedia:false,requestLimit:1,budget:.10,currency:'USD',profileRevision:preview.director.profileRevision}};
 const unconfirmed=await s.request('/api/projects/'+p.id+'/agent-plan','POST',{...body,consent:false});assert.equal(unconfirmed.status,400);assert.equal((await s.calls()).length,0);
 const crossOrigin=await s.request('/api/projects/'+p.id+'/agent-plan','POST',body,{Origin:'https://other.test'});assert.equal(crossOrigin.status,403);assert.equal((await s.calls()).length,0);
 const [a,b]=await Promise.all([s.request('/api/projects/'+p.id+'/agent-plan','POST',body),s.request('/api/projects/'+p.id+'/agent-plan','POST',body)]);assert.equal(a.status,200,JSON.stringify(a.body));assert.deepEqual(a.body,b.body);assert.equal((await s.calls()).length,1);assert.equal((await s.request('/api/projects/'+p.id)).body.shots[0].duration,5);
 const changed=await s.request('/api/projects/'+p.id+'/agent-plan','POST',{...body,message:'另一条指令'});assert.equal(changed.status,409);assert.equal((await s.calls()).length,1);
 const applied=await s.request('/api/projects/'+p.id+'/apply-plan','POST',{planId:a.body.id});assert.equal(applied.status,200);assert.equal(applied.body.shots[0].duration,3);assert.equal(applied.body.shots[0].dialogue,'更简洁的测试字幕');assert.equal((await s.request('/api/projects/'+p.id+'/apply-plan','POST',{planId:a.body.id})).status,409);
 const stale=await s.request('/api/projects/'+p.id+'/agent-plan','POST',{...body,requestId:randomUUID()});assert.equal(stale.status,409);assert.equal((await s.calls()).length,1);
 await s.stop();const resumed=await directorTestServer(data);t.after(()=>resumed.stop());const recovered=await resumed.request('/api/projects/'+p.id+'/agent-plan','POST',body);assert.equal(recovered.status,200);assert.equal(recovered.body.applied,true);assert.equal((await resumed.calls()).length,1);
 const disk=await fs.readFile(path.join(data,'director-requests',body.requestId+'.json'),'utf8');assert.equal(disk.includes('apiKey'),false);assert.equal(disk.includes('虚构助理测试'),false);
});

test('提示词改写使用同一连接，原文保留，设置和服务变化不会静默续用授权',async t=>{
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-director-rewrite-')),s=await directorTestServer(data);t.after(()=>s.stop());const c=(await s.request('/api/config')).body;await s.request('/api/config','PUT',{...c,agentProvider:'deepseek'});
 const d=(await s.request('/api/director/status')).body,p=(await s.request('/api/prompts','POST',{title:'测试提示词',text:'虚构原提示词',category:''})).body;
 const body={revision:p.revision,instruction:'优化光线',consent:true,requestId:randomUUID(),thinking:'off',authorization:{provider:'deepseek',origin:d.origin,model:d.model,sendText:true,sendMedia:false,requestLimit:1,budget:.10,currency:'USD',profileRevision:d.profileRevision}};
 const result=await s.request('/api/prompts/'+p.id+'/rewrite','POST',body);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.text,'电影感改写后的测试提示词');assert.equal((await s.request('/api/prompts/'+p.id)).body.text,'虚构原提示词');await s.request('/api/prompts/'+p.id+'/rewrite','POST',body);assert.equal((await s.calls()).length,1);
 const config=(await s.request('/api/config')).body;assert.equal((await s.request('/api/config','PUT',{...config,agentProvider:'other'})).status,400);assert.equal((await s.request('/api/config','PUT',{...config,revision:0})).status,409);
 await fs.writeFile(path.join(data,'director-mock-state.json'),JSON.stringify({configured:false,error:'原 DeepSeek 配置已变化'}));assert.equal((await s.request('/api/director/status')).body.configured,false);assert.equal((await s.request('/api/health')).body.agentConfigured,false);
});
