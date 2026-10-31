import './helpers/local-network-only.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';import path from 'node:path';import {randomUUID,createHash} from 'node:crypto';
import {nativeRoundMediaFixture} from './helpers/native-round-media-fixture.mjs';
import {nativeReferencePlan} from '../lib/native-flow-execution.mjs';
import {legacyNativeInputAudit,assertLegacyNativeInputResume} from '../lib/legacy-native-input-audit.mjs';
import {legacyNativeInputAuditMarkup} from '../public/legacy-native-input-audit-ui.js';
import {publicJob} from '../lib/generation.mjs';import {canvasRunner} from '../lib/canvas-runner.mjs';
import {localServer,persistFixture} from './helpers/library-backup-server.mjs';

function fixture(index=3){
 const f=nativeRoundMediaFixture({start:1,batch:2,count:2,producerCount:5}),node=f.node('target');
 const referenceSources=[{sourceNodeId:f.loop.id}],contexts={[f.loop.id]:{index,total:4}};
 const plan=nativeReferencePlan(f.p,node,referenceSources,{planning:true,loopContexts:contexts});
 assert.equal(plan.details.length,1);
 const details=structuredClone(plan.details);delete details[0].producerIndices;
 const step={kind:'image-api',nodeId:node.id,status:'pending',title:'旧切片消费者',nativeLoop:{contexts},
  image:{referenceSources},nativeReferences:{version:1,kinds:plan.kinds,details}};
 return{...f,job:{id:randomUUID(),projectId:f.p.id,kind:'canvas-run',status:'interrupted',createdAt:new Date().toISOString(),message:'旧任务',assets:[],steps:[step],snapshot:f.p}};
}

test('旧切片缺生产序号时报告具体越界，不改任务、快照或旧确认范围',()=>{
 const {job}=fixture(),before=JSON.stringify(job),audit=legacyNativeInputAudit(job);
 assert.equal(audit.state,'requires_confirmation');assert.equal(audit.blocksResume,true);
 assert.deepEqual(audit.entries[0].authorizedIndices,[0,1]);assert.deepEqual(audit.entries[0].reconstructedIndices,[2,3]);
 assert.throws(()=>assertLegacyNativeInputResume(job),e=>e.code==='NATIVE_LEGACY_INPUT_REVIEW_REQUIRED'&&e.status===409);
 assert.equal(JSON.stringify(job),before);assert.match(audit.fingerprint,/^[a-f0-9]{64}$/);
 const visible=publicJob(job);assert.equal(visible.canResume,false);assert.equal(visible.snapshot,undefined);assert.equal(visible.legacyNativeInputAudit.state,'requires_confirmation');
});
test('明确首批、已确认更大范围、显式原序号及已提交子任务不被整类阻断',()=>{
 const prefix=fixture(1).job;assert.equal(legacyNativeInputAudit(prefix).state,'compatible');assert.doesNotThrow(()=>assertLegacyNativeInputResume(prefix));
 const full=fixture().job;full.steps[0].nativeReferences.details[0].expectedCount=5;assert.equal(legacyNativeInputAudit(full).state,'compatible');
 const explicit=fixture().job;explicit.steps[0].nativeReferences.details[0].producerIndices=[2,3];assert.equal(legacyNativeInputAudit(explicit).state,'not_needed');
 const submitted=fixture().job;submitted.steps[0].jobId='original-child';assert.equal(legacyNativeInputAudit(submitted).state,'not_needed');assert.doesNotThrow(()=>assertLegacyNativeInputResume(submitted));
 const completed=fixture().job;completed.steps[0].status='completed';assert.equal(legacyNativeInputAudit(completed).state,'not_needed');
});
test('缺快照、同一范围多条旧选择、无法核对的逐轮映射不猜测，快照变化使检查指纹改变',()=>{
 const missing=fixture().job;delete missing.snapshot;assert.equal(legacyNativeInputAudit(missing).state,'unverifiable');
 const duplicate=fixture().job;duplicate.steps[0].nativeReferences.details.push(structuredClone(duplicate.steps[0].nativeReferences.details[0]));assert.equal(legacyNativeInputAudit(duplicate).state,'unverifiable');
 const mapped=fixture().job;mapped.snapshot.nodes.find(n=>n.id===mapped.steps[0].nodeId).params.nativeMediaMap={version:1};assert.equal(legacyNativeInputAudit(mapped).state,'unverifiable');
 const changed=fixture().job,first=legacyNativeInputAudit(changed).fingerprint;changed.steps[0].nativeLoop.contexts[Object.keys(changed.steps[0].nativeLoop.contexts)[0]].index=4;assert.notEqual(legacyNativeInputAudit(changed).fingerprint,first);
});
test('续跑入口在恢复子任务、读取授权和保存状态之前拒绝，已有记录字节不变',async()=>{
 const {job}=fixture(),stage=path.resolve('artifacts','legacy-native-resume-'+Date.now()),data=path.join(stage,'data');await fs.mkdir(path.join(data,'jobs'),{recursive:true});
 const file=path.join(data,'jobs',job.id+'.json'),before=JSON.stringify(job);await fs.writeFile(file,before);
 let recoveries=0;const activeJobs=new Map(),runner=canvasRunner({data,activeJobs,generation:{},creationStudio:{recoverCanvasLinks(){recoveries++;throw Error('must not recover');}}});
 await assert.rejects(runner.resume(job.id,{}),e=>e.code==='NATIVE_LEGACY_INPUT_REVIEW_REQUIRED');
 assert.equal(await fs.readFile(file,'utf8'),before);assert.equal(recoveries,0);assert.equal(activeJobs.size,0);
});
test('实际HTTP查询说明旧序号问题，续跑409且任务/原工程保留',async t=>{
 const f=fixture(),stage=path.resolve('artifacts','legacy-native-input-api-'+Date.now()),data=path.join(stage,'data');await persistFixture({data,p:f.p});await fs.mkdir(path.join(data,'jobs'),{recursive:true});
 const file=path.join(data,'jobs',f.job.id+'.json');await fs.writeFile(file,JSON.stringify(f.job));const before=await fs.readFile(file),projectFile=path.join(data,'projects',f.p.id,'project.json'),pBefore=await fs.readFile(projectFile);
 const server=await localServer(data,{envOverrides:{JINGCHANG_SMART_GROUP_MEDIA_TEST:'1'}});t.after(()=>server.stop());
 const row=await server.api('/api/jobs/'+f.job.id);assert.equal(row.legacyNativeInputAudit.state,'requires_confirmation');assert.equal(row.canResume,false);
 const response=await fetch(server.base+'/api/jobs/'+f.job.id+'/resume',{method:'POST',headers:{...server.headers,'Content-Type':'application/json'},body:JSON.stringify({consent:true})});
 assert.equal(response.status,409);const error=await response.json();assert.equal(error.code,'NATIVE_LEGACY_INPUT_REVIEW_REQUIRED');
 assert.deepEqual(await fs.readFile(file),before);assert.deepEqual(await fs.readFile(projectFile),pBefore);
 await fs.writeFile(path.join(stage,'receipt.json'),JSON.stringify({state:row.legacyNativeInputAudit.state,code:error.code,status:response.status,taskUnchanged:true,projectUnchanged:true,newGenerationRequests:0,taskSha256:createHash('sha256').update(before).digest('hex')},null,2));
});
test('旧任务提示显示人类序号且转义文本，不声称已完成确认或生成',()=>{
 const audit=legacyNativeInputAudit(fixture().job),esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 const html=legacyNativeInputAuditMarkup(audit,esc);assert.match(html,/旧确认序号：1、2/);assert.match(html,/快照所需序号：3、4/);
 audit.entries[0].reason='<img src=x>';assert(!legacyNativeInputAuditMarkup(audit,esc).includes('<img'));
 assert.equal(legacyNativeInputAuditMarkup({format:audit.format,blocksResume:false},esc),'');
});
