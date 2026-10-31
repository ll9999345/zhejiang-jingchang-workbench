import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {normalizeJimengResultQueries,jimengScopedQueryAuthorization} from '../public/jimeng-query-scope.js';
import {resultQueryRequestId} from '../lib/jimeng-result-queries.mjs';
import {jimengTaskService,jimengTaskHistory} from '../lib/jimeng-cli-tasks.mjs';
import {streamAssetService} from '../lib/stream-assets.mjs';
import {jimengFixture} from './helpers/jimeng-generation-fixture.mjs';

const stage=path.resolve('artifacts/jimeng-result-queries-tests-'+Date.now());await fs.mkdir(stage,{recursive:true});
const policy={requestLimit:2,budget:2,currency:'credits',intervalSeconds:5};
const until=async fn=>{const end=Date.now()+8000;while(Date.now()<end){const value=await fn();if(value)return value;await sleep(15);}throw Error('condition timed out');};
async function setup({interval=100}={}){
 const dir=path.join(stage,randomUUID()),data=path.join(dir,'data');await fs.mkdir(data,{recursive:true});const fixture=await jimengFixture(path.join(dir,'bin')),project={id:randomUUID(),assets:[],revision:0},activeJobs=new Map(),projects={load:async id=>{assert.equal(id,project.id);return project;}},waits=[];
 const options={data,projects,activeJobs,streamAssets:streamAssetService({data,projects,activeJobs}),env:{PATH:process.env.PATH,JIMENG_BIN:fixture.file},timeoutMs:1600,resultQueryWait:async(ms,signal)=>{waits.push(ms);return sleep(ms>=5000?interval:10,undefined,{signal});}},service=jimengTaskService(options);
 const prepare=async(scope=policy)=>{const preview=await service.preview({projectId:project.id,request:{command:'text2image',prompt:'限额查询本地夹具'},...(scope?{resultQueries:scope}:{})});return{projectId:project.id,requestId:randomUUID(),request:preview.plan.request,...(scope?{resultQueries:scope}:{}),fingerprint:preview.fingerprint,consent:true,authorization:{service:'local-dreamina-login',action:'generate',command:'text2image',model:'5.0',requestLimit:1,useLocalLogin:true,sendPrompt:true,sendOriginalMedia:false,budget:1,currency:'credits',consent:true,...(scope?{resultQueriesConsent:true}:{})}};};
 const settled=async id=>until(async()=>{const r=await service.get(id,project.id);return r.status!=='executing'&&!['preparing','waiting','querying','stopping','finishing'].includes(r.resultQueries?.state)?r:null;});return{dir,data,fixture,project,options,service,prepare,settled,waits};
}
test('query policy is an exact bounded scope; derived query grants cannot round the total upwards',()=>{
 assert.deepEqual(normalizeJimengResultQueries(policy),policy);
 for(const patch of [{requestLimit:0},{requestLimit:31},{requestLimit:1.5},{intervalSeconds:4},{intervalSeconds:301},{budget:-1},{budget:Infinity},{currency:'unknown'},{command:'login'}])assert.throws(()=>normalizeJimengResultQueries({...policy,...patch}));
 const p={request:{command:'text2image',model:'5.0'},resultQueries:{...policy,requestLimit:3,budget:.1}},a=jimengScopedQueryAuthorization(p,'original');assert.ok(a.budget*3<=.1);assert.equal(a.sendPrompt,false);assert.equal(a.sendOriginalMedia,false);assert.equal(a.upstreamId,'original');
});
test('reads without an opt-in scope never schedule a query; adding a scope needs its separate generation consent',async()=>{
 const c=await setup(),plain=await c.prepare(null);await c.service.start(plain);let r=await c.settled(plain.requestId);assert.equal(r.resultQueries,undefined);await sleep(200);await c.service.get(r.id,c.project.id);await c.service.list(c.project.id);assert.equal((await c.fixture.calls()).length,1);
 const scoped=await c.prepare();delete scoped.authorization.resultQueriesConsent;await assert.rejects(c.service.start(scoped),/确认/);assert.equal((await c.fixture.calls()).length,1);
});
test('one generation and its approved original query save real PNG, retain session/query receipts and never regenerate',async()=>{
 const c=await setup(),body=await c.prepare();await c.service.start(body);await c.service.start(body);const r=await c.settled(body.requestId);assert.equal(r.status,'completed');assert.equal(r.resultQueries.state,'completed');assert.equal(r.resultQueries.used,1);assert.equal(r.resultQueries.remaining,1);assert.equal(r.resultQueries.sessions.length,1);assert.ok(c.waits.includes(5000));assert.equal((await c.fixture.calls()).length,2);
 const history=await c.service.history(r.id,c.project.id);assert.deepEqual(jimengTaskHistory(history),history);assert.ok(!JSON.stringify(history.resultQueries).includes('"pid"'));
 for(const mutate of [x=>x.resultQueries.used=2,x=>x.resultQueries.remaining=2,x=>x.resultQueries.sessions[0].scopeFingerprint='0'.repeat(64),x=>x.resultQueries.state='waiting']){const bad=structuredClone(history);mutate(bad);assert.throws(()=>jimengTaskHistory(bad));}
});
test('pending results exhaust the exact query count and preserve the aggregate budget without a third query',async()=>{
 const c=await setup();await c.fixture.mode('pending');const body=await c.prepare();await c.service.start(body);const r=await c.settled(body.requestId);assert.equal(r.status,'pending');assert.equal(r.resultQueries.state,'exhausted');assert.equal(r.resultQueries.used,2);assert.equal(r.queryCount,2);assert.equal(r.resultQueries.remaining,0);assert.ok(r.queries.every(q=>q.authorization.upstreamId===r.upstreamId));assert.ok(r.queries.reduce((n,q)=>n+q.authorization.budget,0)<=policy.budget);await sleep(250);assert.equal((await c.fixture.calls()).length,3);
 await c.service.continueResultQueries(r.id,{projectId:c.project.id,requestId:randomUUID(),scopeFingerprint:r.resultQueries.scopeFingerprint,consent:true});assert.equal((await c.fixture.calls()).length,3);jimengTaskHistory(await c.service.history(r.id,c.project.id));
});
test('explicit stop pauses before a query; continuation preserves the same envelope and is idempotent',async()=>{
 const c=await setup({interval:600}),body=await c.prepare();await c.service.start(body);await until(async()=>{const r=await c.service.get(body.requestId,c.project.id);return r.resultQueries?.state==='waiting';});await c.service.cancel(body.requestId,c.project.id);let r=await c.settled(body.requestId);assert.equal(r.resultQueries.state,'stopped');assert.equal(r.resultQueries.used,0);assert.equal((await c.fixture.calls()).length,1);jimengTaskHistory(await c.service.history(r.id,c.project.id));
 const resume={projectId:c.project.id,requestId:randomUUID(),scopeFingerprint:r.resultQueries.scopeFingerprint,consent:true};await assert.rejects(c.service.continueResultQueries(r.id,{...resume,budget:100}),/确认/);await assert.rejects(c.service.continueResultQueries(r.id,{...resume,consent:false}),/确认/);await c.service.continueResultQueries(r.id,resume);await c.service.continueResultQueries(r.id,resume);r=await c.settled(r.id);assert.equal(r.status,'completed');assert.equal(r.resultQueries.sessions.length,2);assert.equal(r.resultQueries.used,1);assert.equal((await c.fixture.calls()).length,2);jimengTaskHistory(await c.service.history(r.id,c.project.id));
});
test('a failed original query pauses with remaining scope and never automatically retries an error',async()=>{
 const c=await setup({interval:400}),body=await c.prepare();await c.service.start(body);await until(async()=>{const r=await c.service.get(body.requestId,c.project.id);return r.resultQueries?.state==='waiting';});await c.fixture.mode('failed');const r=await c.settled(body.requestId);assert.equal(r.status,'failed');assert.equal(r.resultQueries.state,'paused');assert.equal(r.resultQueries.used,1);assert.equal(r.resultQueries.remaining,1);await sleep(600);assert.equal((await c.fixture.calls()).length,2);assert.ok(!JSON.stringify(r).includes('sk-synthetic'));
});
test('a corrupted or enlarged automatic-query grant is rejected before another process starts',async()=>{
 const c=await setup({interval:600}),body=await c.prepare();await c.service.start(body);const r=await until(async()=>{const r=await c.service.get(body.requestId,c.project.id);return r.resultQueries?.state==='waiting'?r:null;});await c.service.cancel(r.id,c.project.id);await c.settled(r.id);
 await assert.rejects(c.service.query(r.id,{projectId:c.project.id,requestId:resultQueryRequestId(r.id,1),consent:true,authorization:{...jimengScopedQueryAuthorization(r.plan,r.upstreamId),budget:100}}),/预算/);assert.equal((await c.fixture.calls()).length,1);
 const file=path.join(c.data,'jimeng-cli-tasks',r.id+'.result-session-1.json'),original=await fs.readFile(file),value=JSON.parse(original);value.scopeFingerprint='0'.repeat(64);await fs.writeFile(file,JSON.stringify(value));await assert.rejects(c.service.get(r.id,c.project.id),/不完整/);assert.equal((await c.fixture.calls()).length,1);await fs.writeFile(file,original);
});
test('real SIGKILL while waiting leaves a paused session; reads and a new service do not query until explicit continuation',async()=>{
 const c=await setup(),body=await c.prepare();await fs.writeFile(path.join(c.data,'test-project.json'),JSON.stringify(c.project));const child=fork(new URL('./helpers/jimeng-task-child.mjs',import.meta.url),[c.data,c.fixture.file],{stdio:['ignore','ignore','pipe','ipc'],env:{PATH:process.env.PATH}});assert.equal((await once(child,'message'))[0].ready,true);
 try{const answer=once(child,'message');child.send({action:'start',body});assert.equal((await answer)[0].ok,true);await until(async()=>{const r=await c.service.get(body.requestId,c.project.id);return r.resultQueries?.state==='waiting';});child.kill('SIGKILL');await once(child,'exit');let r=await c.service.get(body.requestId,c.project.id);assert.equal(r.resultQueries.state,'paused');assert.equal(r.requestCount,1);assert.equal(r.resultQueries.used,0);const restarted=jimengTaskService(c.options);await restarted.list(c.project.id);await sleep(200);assert.equal((await c.fixture.calls()).length,1);
 await restarted.continueResultQueries(r.id,{projectId:c.project.id,requestId:randomUUID(),scopeFingerprint:r.resultQueries.scopeFingerprint,consent:true});r=await c.settled(r.id);assert.equal(r.status,'completed');assert.equal(r.resultQueries.sessions.length,2);assert.equal(r.resultQueries.used,1);assert.equal((await c.fixture.calls()).length,2);jimengTaskHistory(await restarted.history(r.id,c.project.id));
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}}
});
test('two actual service processes replay one continuation claim and run only one original-ID query',async()=>{
 const c=await setup({interval:600}),body=await c.prepare();await c.service.start(body);const r=await until(async()=>{const r=await c.service.get(body.requestId,c.project.id);return r.resultQueries?.state==='waiting'?r:null;});await c.service.cancel(r.id,c.project.id);await c.settled(r.id);await fs.writeFile(path.join(c.data,'test-project.json'),JSON.stringify(c.project));
 const children=[],resume={projectId:c.project.id,requestId:randomUUID(),scopeFingerprint:r.resultQueries.scopeFingerprint,consent:true};
 try{for(let i=0;i<2;i++){const child=fork(new URL('./helpers/jimeng-result-queries-child.mjs',import.meta.url),[c.data,c.fixture.file],{stdio:['ignore','ignore','pipe','ipc'],env:{PATH:process.env.PATH}});children.push(child);assert.equal((await once(child,'message'))[0].ready,true);}const replies=await Promise.all(children.map(async child=>{const answer=once(child,'message');child.send({id:r.id,body:resume});return(await answer)[0];}));assert.ok(replies.every(r=>r.ok),JSON.stringify(replies));const final=await c.settled(r.id);assert.equal(final.status,'completed');assert.equal(final.resultQueries.sessions.length,2);assert.equal(final.resultQueries.used,1);assert.equal((await c.fixture.calls()).length,2);
 }finally{for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}}
});
test('stop during the initial claim prevents late automatic startup; manual queries cannot race a live bounded session',async()=>{
 const c=await setup({interval:600}),body=await c.prepare(),publish=c.service.store.publish;let entered=false,release;const gate=new Promise(resolve=>release=resolve);
 c.service.store.publish=async(name,value)=>{if(name.endsWith('.result-session-1.json')){entered=true;await gate;}return publish(name,value);};
 await c.service.start(body);await until(()=>entered);await c.service.cancel(body.requestId,c.project.id);release();let r=await c.settled(body.requestId);assert.equal(r.resultQueries.state,'stopped');assert.equal(r.queryCount,0);assert.equal((await c.fixture.calls()).length,1);
 const resume={projectId:c.project.id,requestId:randomUUID(),scopeFingerprint:r.resultQueries.scopeFingerprint,consent:true};await c.service.continueResultQueries(r.id,resume);await assert.rejects(c.service.query(r.id,{projectId:c.project.id,requestId:randomUUID(),consent:true,authorization:jimengScopedQueryAuthorization(r.plan,r.upstreamId)}),/先停止/);r=await c.settled(r.id);assert.equal(r.status,'completed');assert.equal((await c.fixture.calls()).length,2);jimengTaskHistory(await c.service.history(r.id,c.project.id));
});
test('a continuation confirmation is bound to its original task and cannot be replayed on another task with the same policy',async()=>{
 const c=await setup({interval:800});const rows=[];
 for(let i=0;i<2;i++){const body=await c.prepare();await c.service.start(body);const r=await until(async()=>{const r=await c.service.get(body.requestId,c.project.id);return r.resultQueries?.state==='waiting'?r:null;});await c.service.cancel(r.id,c.project.id);rows.push(await c.settled(r.id));}
 assert.notEqual(rows[0].resultQueries.scopeFingerprint,rows[1].resultQueries.scopeFingerprint);await assert.rejects(c.service.continueResultQueries(rows[1].id,{projectId:c.project.id,requestId:randomUUID(),scopeFingerprint:rows[0].resultQueries.scopeFingerprint,consent:true}),/确认/);assert.equal((await c.fixture.calls()).length,2);
});
test('a failed session-end write does not leave a finished in-process scheduler looking live forever',async()=>{
 const c=await setup(),body=await c.prepare(),publish=c.service.store.publish;
 c.service.store.publish=async(name,value)=>{if(name.endsWith('.result-session-1-result.json'))throw Object.assign(Error('synthetic session-end disk failure'),{code:'EIO'});return publish(name,value);};
 await c.service.start(body);const r=await c.settled(body.requestId);assert.equal(r.status,'completed');assert.equal(r.resultQueries.state,'completed');assert.equal(r.resultQueries.sessions[0].result,undefined);assert.equal((await c.fixture.calls()).length,2);assert.deepEqual(jimengTaskHistory(await c.service.history(r.id,c.project.id)).resultQueries,r.resultQueries);c.service.store.publish=publish;
});
console.log('Retained bounded-query fixtures:',stage);
