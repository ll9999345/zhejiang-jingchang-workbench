import test from 'node:test';
import assert from 'node:assert/strict';
import {DirectorChatAllowance} from '../public/director-ui.js';
import {directorTestServer} from './helpers/director-test-server.mjs';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
test('聊天额度绑定项目和服务、预扣、过期、结束，无默认授权',()=>{
 const a=new DirectorChatAllowance(),d={provider:'deepseek',origin:'https://api.deepseek.com',model:'deepseek-flash',profileRevision:'a'.repeat(64)};
 assert.equal(a.available('p',d,.01),false);a.approve('p',d,.03,'off');assert.equal(a.available('other',d,.01),false);assert.equal(a.available('p',{...d,model:'other'},.01),false);
 assert.equal(a.reserve('p',d,.02).authorization.requestLimit,1);assert.equal(a.available('p',d,.02),false);assert.throws(()=>a.reserve('p',d,.02));a.until=0;assert.equal(a.available('p',d,.001),false);a.clear();assert.equal(a.remaining,0);
});
test('回答直接持久化、无画布改动、应用不重复聊天、重复保存幂等',async t=>{
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-inline-answer-')),s=await directorTestServer(data);t.after(()=>s.stop());
 let p=(await s.request('/api/projects','POST',{name:'虚构聊天验收'})).body;
 const plan=(await s.request(`/api/projects/${p.id}/agent-plan`,'POST',{message:'整理画布',mode:'local'})).body;
 const answer=await s.request(`/api/projects/${p.id}/record-plan-answer`,'POST',{planId:plan.id});assert.equal(answer.status,200);assert.equal(answer.body.messages.length,2);assert.deepEqual(answer.body.nodes,p.nodes);
 const again=await s.request(`/api/projects/${p.id}/record-plan-answer`,'POST',{planId:plan.id});assert.equal(again.body.revision,answer.body.revision);
 const applied=await s.request(`/api/projects/${p.id}/apply-plan`,'POST',{planId:plan.id});assert.equal(applied.status,200);assert.equal(applied.body.messages.length,2);
 const other=(await s.request('/api/projects','POST',{name:'另一个虚构项目'})).body;assert.equal((await s.request(`/api/projects/${other.id}/record-plan-answer`,'POST',{planId:plan.id})).status,403);
});
