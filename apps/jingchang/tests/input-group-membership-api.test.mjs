import './helpers/local-network-only.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {localServer,persistFixture} from './helpers/library-backup-server.mjs';
import {membershipFixture} from './helpers/input-group-membership-fixture.mjs';
import {applyMembershipEdit} from '../public/input-group-membership.js';
import {makeNode} from '../lib/model.mjs';

async function setup(t){const stage=path.resolve('artifacts','input-group-members-api-'+Date.now()+'-'+randomUUID().slice(0,6)),data=path.join(stage,'data'),p=membershipFixture();await persistFixture({data,p});let current=await localServer(data);t.after(()=>current.stop());return{stage,data,p,get server(){return current;},restart:async()=>{await current.stop();current=await localServer(data);}};}
const body=(p,extra={})=>({mode:'manual',requestId:randomUUID(),revision:p.revision,groupId:'a',title:'A组',memberIds:['text','y'],...extra});
const endpoint=p=>'/api/projects/'+p.id+'/input-groups/';
async function snapshot(dir){const rows={};async function walk(d){for(const entry of await fs.readdir(d,{withFileTypes:true})){const file=path.join(d,entry.name);if(entry.isDirectory())await walk(file);else rows[path.relative(dir,file)]=createHash('sha256').update(await fs.readFile(file)).digest('hex');}}await walk(dir);return rows;}
async function rejected(server,url,b,status=409){const r=await fetch(server.base+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});assert.equal(r.status,status,JSON.stringify(await r.clone().json()));return r.json();}

test('真实接口预览不写项目/历史/任务，精确计划确认并发只保存一次，错误路径不接受',async t=>{
 const f=await setup(t),s=f.server,b=body(f.p),before=await snapshot(f.data),preview=await s.api(endpoint(f.p)+'preview','POST',b);assert.equal(preview.changed,true);assert.equal(preview.effects.fieldChanges[0].action,'preserve-selected-slot');assert.deepEqual(await snapshot(f.data),before);
 await rejected(s,endpoint(f.p)+'apply',b);await rejected(s,endpoint(f.p)+'apply',{...b,planHash:'wrong'});assert.deepEqual(await snapshot(f.data),before);
 const request={...b,planHash:preview.planHash},[a,c]=await Promise.all([s.api(endpoint(f.p)+'apply','POST',request),s.api(endpoint(f.p)+'apply','POST',request)]);assert.deepEqual(a,c);assert.equal(a.revision,1);assert.equal((await fs.readdir(path.join(f.data,'projects',f.p.id,'history'))).length,1);assert.deepEqual(await s.api('/api/jobs?projectId='+f.p.id),[]);
 const saved=await snapshot(f.data);await rejected(s,endpoint(f.p)+'apply',{...request,title:'不同内容'});await rejected(s,endpoint(f.p)+'apply',{...request,planHash:'changed-hash'});assert.deepEqual(await snapshot(f.data),saved);
 const wrong=await fetch(s.base+'/api/cloud-workflows/'+f.p.id+'/input-groups/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});assert.equal(wrong.status,404);
 await fs.writeFile(path.join(f.stage,'result.json'),JSON.stringify({ok:true,previewWrites:0,concurrentApplies:2,revisionsAdded:1,paidCalls:0,thirdPartyUploads:0},null,2));
});
test('真实Node重启后回执仍可识别同一次修改，过期版本及循环没有部分保存',async t=>{
 const f=await setup(t),b=body(f.p),preview=await f.server.api(endpoint(f.p)+'preview','POST',b),request={...b,planHash:preview.planHash},saved=await f.server.api(endpoint(f.p)+'apply','POST',request);await f.restart();
 assert.deepEqual(await f.server.api(endpoint(f.p)+'apply','POST',request),saved);const before=await snapshot(f.data);await rejected(f.server,endpoint(f.p)+'preview',{...b,requestId:randomUUID()});
 await rejected(f.server,endpoint(f.p)+'preview',body(saved,{memberIds:['text','x','y','target']}),400);await rejected(f.server,endpoint(f.p)+'reconcile',{mode:'drag',requestId:randomUUID(),revision:saved.revision,draft:saved,movedIds:['x'],rects:{x:{width:-1,height:20}}},400);assert.deepEqual(await snapshot(f.data),before);
});
test('拖入接口一次提交完整草稿、Alt副本和新文字，重试不产生第二次历史',async t=>{
 const f=await setup(t),draft=structuredClone(f.p);draft.nodes[0].text='等待保存期间的新文字';draft.nodes.push(makeNode('image',410,30,{id:'alt-copy',assetId:'asset-x'}));
 const b={mode:'drag',requestId:randomUUID(),revision:f.p.revision,draft,movedIds:['alt-copy'],rects:{'alt-copy':{width:100,height:100}}};const saved=await f.server.api(endpoint(f.p)+'reconcile','POST',b);assert.equal(saved.revision,1);assert.equal(saved.nodes[0].text,draft.nodes[0].text);assert.deepEqual(saved.nodes.find(n=>n.id==='b').params.nativeCanvas.members,[{sourceNodeId:'alt-copy'}]);assert.deepEqual(saved.assets,f.p.assets);assert.deepEqual(await f.server.api(endpoint(f.p)+'reconcile','POST',b),saved);assert.equal((await fs.readdir(path.join(f.data,'projects',f.p.id,'history'))).length,1);
});
test('真实提交成功但回应丢失时只GET回执恢复，不重发POST；新版回执明确标识',async t=>{
 const f=await setup(t),b=body(f.p),preview=await f.server.api(endpoint(f.p)+'preview','POST',b),request={...b,planHash:preview.planHash},calls=[];
 const api=async(url,options={})=>{calls.push(options.method||'GET');const p=await f.server.api(url,options.method||'GET',options.body?JSON.parse(options.body):undefined);if(options.method==='POST')throw Error('Owned simulated response loss after successful commit');return p;};
 const result=await applyMembershipEdit(api,f.p.id,request);assert.equal(result.recovered,true);assert.equal(result.project.revision,1);assert.deepEqual(calls,['POST','GET']);assert.equal((await fs.readdir(path.join(f.data,'projects',f.p.id,'history'))).length,1);
 const updated=structuredClone(result.project);updated.nodes[0].text='后来保存的新内容';const latest=await f.server.api('/api/projects/'+f.p.id,'PUT',updated);calls.length=0;const recovered=await applyMembershipEdit(api,f.p.id,request);assert.equal(recovered.newer,true);assert.equal(recovered.project.revision,latest.revision);assert.equal(recovered.project.nodes[0].text,updated.nodes[0].text);assert.deepEqual(calls,['POST','GET']);
});
test('未知结果及错误回执不恢复、不自动再次提交，也不凭GET项目存在判成功',async()=>{
 const b={mode:'manual',requestId:'wanted',planHash:'wanted-plan'},calls=[];
 await assert.rejects(applyMembershipEdit(async(url,options={})=>{calls.push(options.method||'GET');if(options.method)throw Error('unknown-result');return{settings:{inputGroupEditReceipt:{requestId:'other',mode:'manual',planHash:'wanted-plan'}}};},'p',b),/unknown-result/);assert.deepEqual(calls,['POST','GET']);
});
