import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {libraryFixture,backupFixture} from './helpers/library-backup-fixture.mjs';
import {localServer,waitFile,persistFixture} from './helpers/library-backup-server.mjs';
async function finish(server,id,projectId){const deadline=Date.now()+20000;while(Date.now()<deadline){const j=await server.api('/api/jobs/'+id);if(!['queued','running'].includes(j.status))return j;await new Promise(r=>setTimeout(r,20));}throw Error('HTTP local file task timed out');}
async function receive(server,file,projectId,id=randomUUID()){const r=await fetch(server.base+'/api/asset-library-backups/imports?'+new URLSearchParams({projectId,requestId:id}),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:createReadStream(file),duplex:'half'}),p=await r.json();assert.ok(r.ok,p.error);return p;}

test('实际 HTTP 整库备份/检查/恢复与任务中心接口，原工程保持',async t=>{
 const f=await libraryFixture({populated:true});await persistFixture(f);const server=await localServer(f.data);t.after(()=>server.stop());const before=await server.api('/api/projects/'+f.p.id),revision=(await server.api('/api/asset-catalog')).revision;
 const job=await server.api('/api/asset-library-backups','POST',{requestId:randomUUID(),projectId:f.p.id,revision}),done=await finish(server,job.id,f.p.id);assert.equal(done.status,'completed',done.message);assert.equal(done.plan,undefined);
 const download=await fetch(server.base+done.result.url);assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/jingchang-library/);const file=path.join(f.data,'test-http.jingchang-library');await fs.writeFile(file,Buffer.from(await download.arrayBuffer()));
 const accepted=await receive(server,file,f.p.id);assert.equal(accepted.status,'checked');assert.equal(accepted.file,undefined);const inspect=await server.api('/api/asset-library-backups/imports/'+accepted.id+'?projectId='+f.p.id);assert.equal(inspect.id,accepted.id);
 const restore=await server.api('/api/asset-library-backups/imports/'+accepted.id+'/restore','POST',{requestId:randomUUID(),projectId:f.p.id,revision});const result=await finish(server,restore.id,f.p.id);assert.equal(result.status,'completed',result.message);assert.equal((await server.api('/api/asset-catalog')).libraries.length,4);assert.deepEqual(await server.api('/api/projects/'+f.p.id),before);
 const tasks=await server.api('/api/jobs?projectId='+f.p.id);assert.ok(tasks.some(j=>j.kind==='library-backup'));assert.ok(tasks.some(j=>j.kind==='library-restore'));assert.ok(tasks.filter(j=>['library-backup','library-restore'].includes(j.kind)).every(j=>j.plan===undefined));
 assert.equal((await server.api('/api/asset-library-backups?projectId='+f.p.id)).length,2);assert.equal((await server.api('/api/asset-library-backups/imports?projectId='+f.p.id)).length,1);
});
test('真实进程在目录发布前中止，重启只继续原资源计划并保护最新目录',async t=>{
 const source=await libraryFixture({populated:true}),backup=await backupFixture(source),dst=await libraryFixture();await persistFixture(dst);const gate=path.join(dst.data,'test-owned-gate');let server=await localServer(dst.data,{gate});t.after(async()=>{await server.stop();});
 const accepted=await receive(server,backup.file,dst.p.id),id=randomUUID();await server.api('/api/asset-library-backups/imports/'+accepted.id+'/restore','POST',{requestId:id,projectId:dst.p.id,revision:0});await waitFile(path.join(gate,'entered.json'));
 const running=await server.api('/api/jobs/'+id);assert.equal(running.status,'running');assert.ok(running.completedSteps>0);assert.ok(running.completedSteps<running.totalSteps);assert.equal((await server.api('/api/asset-catalog')).libraries.length,1);const before=await server.api('/api/projects/'+dst.p.id);await server.stop();
 await fs.writeFile(path.join(gate,'release.json'),JSON.stringify({release:true}));server=await localServer(dst.data,{gate});const interrupted=await server.api('/api/jobs/'+id);assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.canResume,true);
 await server.api('/api/asset-catalog/libraries/default','PATCH',{revision:0,name:'重启后的新名字'});await server.api('/api/jobs/'+id+'/resume','POST',{revision:1});const done=await finish(server,id,dst.p.id);assert.equal(done.status,'completed',done.message);
 const catalog=await server.api('/api/asset-catalog');assert.equal(catalog.libraries.length,3);assert.equal(catalog.libraries[0].name,'重启后的新名字');assert.deepEqual(await server.api('/api/projects/'+dst.p.id),before);
 await server.api('/api/jobs/'+id+'/resume','POST',{revision:2});assert.equal((await server.api('/api/asset-catalog')).libraries.length,3);
});
