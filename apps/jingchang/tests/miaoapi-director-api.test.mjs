// Local protocol fixture only. No Miao account, credential or generation call.
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {directorTestServer} from './helpers/director-test-server.mjs';

test('喵喵助理：选择服务、确认、规划、只应用一次，DeepSeek授权不可串用',async t=>{
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-miao-api-')),s=await directorTestServer(data);t.after(()=>s.stop());
 const config=(await s.request('/api/config')).body;
 assert.equal((await s.request('/api/config','PUT',{...config,agentProvider:'miaoapi'})).status,200);
 const health=(await s.request('/api/health')).body;
 assert.equal(health.director.provider,'miaoapi');assert.equal(health.model,'gpt-5.4-mini');
 let p=(await s.request('/api/projects','POST',{name:'虚构喵喵验收'})).body;
 const message='创作一份短片剧本',preview=(await s.request('/api/projects/'+p.id+'/agent-preview','POST',{message})).body;
 assert.equal(preview.director.origin,'https://miaoapi.xyz');assert.equal((await s.calls()).length,0);
 const authorization={provider:'miaoapi',origin:'https://miaoapi.xyz',model:'gpt-5.4-mini',profileRevision:preview.director.profileRevision,sendText:true,sendMedia:false,requestLimit:1,currency:'USD',budget:.1};
 const body={message,mode:'model',consent:true,thinking:'off',requestId:randomUUID(),projectRevision:p.revision,previewHash:preview.previewHash,authorization};
 const invalid=await s.request('/api/projects/'+p.id+'/agent-plan','POST',{...body,authorization:{...authorization,provider:'deepseek',origin:'https://api.deepseek.com',model:'deepseek-flash'}});
 assert.equal(invalid.status,400);assert.equal((await s.calls()).length,0);
 const [a,b]=await Promise.all([s.request('/api/projects/'+p.id+'/agent-plan','POST',body),s.request('/api/projects/'+p.id+'/agent-plan','POST',body)]);
 assert.equal(a.status,200,JSON.stringify(a.body));assert.deepEqual(a,b);assert.equal(a.body.provider,'miaoapi');assert.equal((await s.calls()).length,1);
 assert.equal((await s.request('/api/projects/'+p.id)).body.nodes.length,p.nodes.length);
 assert.equal((await s.request('/api/projects/'+p.id+'/apply-plan','POST',{planId:a.body.id})).status,200);
 assert.equal((await s.request('/api/projects/'+p.id+'/apply-plan','POST',{planId:a.body.id})).status,409);
 p=(await s.request('/api/projects/'+p.id)).body;assert.equal(p.nodes.at(-1).title,'测试剧本');
 assert.equal((await s.request('/api/director/status?provider=deepseek')).body.provider,'deepseek');
});

test('喵喵提示词改写保持草稿，沿用DeepSeek思考参数被拒绝',async t=>{
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-miao-rewrite-')),s=await directorTestServer(data);t.after(()=>s.stop());
 const c=(await s.request('/api/config')).body;await s.request('/api/config','PUT',{...c,agentProvider:'miaoapi'});
 const d=(await s.request('/api/director/status')).body,p=(await s.request('/api/prompts','POST',{title:'虚构标题',text:'虚构原文'})).body;
 const body={revision:p.revision,instruction:'优化',consent:true,requestId:randomUUID(),thinking:'high',authorization:{provider:'miaoapi',origin:d.origin,model:d.model,profileRevision:d.profileRevision,sendText:true,sendMedia:false,requestLimit:1,currency:'USD',budget:.1}};
 assert.equal((await s.request('/api/prompts/'+p.id+'/rewrite','POST',body)).status,400);assert.equal((await s.calls()).length,0);
 const result=await s.request('/api/prompts/'+p.id+'/rewrite','POST',{...body,thinking:'off'});
 assert.equal(result.status,200);assert.equal(result.body.model,'gpt-5.4-mini');assert.equal((await s.calls()).length,1);
 assert.equal((await s.request('/api/prompts/'+p.id)).body.text,'虚构原文');
});
