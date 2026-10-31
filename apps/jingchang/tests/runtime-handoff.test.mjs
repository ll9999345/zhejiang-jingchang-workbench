import './helpers/local-network-only.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {captureRuntime} from '../tools/runtime-releases.mjs';
import {startWorkspaceRuntime} from '../tools/start-runtime.mjs';
import {handoffRuntime, inspectOwnedServer, listenerPids, workspaceDataState} from '../tools/runtime-handoff.mjs';

const wait = ms => new Promise(r => setTimeout(r, ms));
async function fixture(t) {
  const workspace=path.resolve('artifacts','handoff-unit-'+randomUUID());await fs.mkdir(workspace,{recursive:true});
  for(const name of ['lib','public','resources','node_modules','releases','data/projects/owned','data/jobs'])await fs.mkdir(path.join(workspace,name),{recursive:true});
  const project=path.join(workspace,'data/projects/owned/project.json');await fs.writeFile(project,JSON.stringify({id:'owned',settings:{nativeMediaVersion:2},text:'synthetic file kept through failed startup'}));
  const code=`import http from 'node:http';import {readFileSync} from 'node:fs';const version=JSON.parse(readFileSync(new URL('./package.json',import.meta.url))).version;if(process.env.OWNED_FAIL_VERSION===version)process.exit(3);http.createServer((_q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({ok:true,version,runtimeInstance:process.env.JINGCHANG_RUNTIME_INSTANCE,capabilities:{smartGroupStoredMedia:process.env.JINGCHANG_NATIVE_MEDIA_MODE==='versioned'}}));}).listen(Number(process.env.PORT),'127.0.0.1');`;
  await fs.writeFile(path.join(workspace,'server.mjs'),code);
  const setVersion=async version=>{for(const name of ['package.json','package-lock.json'])await fs.writeFile(path.join(workspace,name),JSON.stringify({version,type:'module'}));};
  await setVersion('owned-fallback');const kept=await captureRuntime({source:workspace,destination:path.join(workspace,'releases/kept'),nativeMediaMode:'versioned'});
  await setVersion('owned-candidate');const next=await captureRuntime({source:workspace,destination:path.join(workspace,'releases/next'),nativeMediaMode:'versioned'});
  await setVersion('owned-prior');
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const initial=await startWorkspaceRuntime({workspace,port,env:{...process.env,JINGCHANG_NATIVE_MEDIA_MODE:'legacy',JINGCHANG_SMART_GROUP_MEDIA_TEST:'0'}}),ownedPids=new Set([initial.pid]);
  t.after(async()=>{for(const pid of await listenerPids(port)){assert(ownedPids.has(pid),'Never stop an unexpected process');process.kill(pid,'SIGTERM');}const deadline=Date.now()+10000;while((await listenerPids(port)).length&&Date.now()<deadline)await wait(50);assert.deepEqual(await listenerPids(port),[]);});
  const expected=await inspectOwnedServer({pid:initial.pid,port,cwd:workspace,entry:path.join(workspace,'server.mjs')}),selection=r=>({version:1,runtime:path.relative(workspace,r.directory),manifestSha256:r.manifestSha256});
  const options={workspace,port,expected,expectedVersion:'owned-prior',candidate:selection(next),fallback:selection(kept),evidence:path.join(workspace,'handoff'),env:{...process.env},startupTimeout:4000};
  return{workspace,project,initial,expected,port,options,ownedPids};
}
test('实际停止核实进程并启动候选，旧数据不改，选择/PID/审计记录一致',async t=>{
  const f=await fixture(t),before=await fs.readFile(f.project);const result=await handoffRuntime(f.options);f.ownedPids.add(result.runtime.pid);
  assert.equal(result.status,'completed');assert.equal(result.runtime.version,'owned-candidate');assert.equal(result.runtime.storedMedia,true);assert.equal(result.businessDataUnchanged,true);assert.deepEqual(await fs.readFile(f.project),before);
  assert.equal(Number(await fs.readFile(path.join(f.workspace,'data/server.pid'),'utf8')),result.runtime.pid);assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.workspace,'runtime-selection.json'))),f.options.candidate);
  await assert.rejects(fs.stat(path.join(f.workspace,'.runtime-handoff.lock')),{code:'ENOENT'});assert((await fs.readdir(f.workspace)).some(x=>x.endsWith('.completed.json')));
});
test('真实候选子进程启动失败后恢复保留版本，版本2工程字节保持且不回退数据',async t=>{
  const f=await fixture(t),before=await fs.readFile(f.project);const result=await handoffRuntime({...f.options,env:{...process.env,OWNED_FAIL_VERSION:'owned-candidate'}});f.ownedPids.add(result.runtime.pid);
  assert.equal(result.status,'restored');assert.equal(result.runtime.version,'owned-fallback');assert.equal(result.runtime.storedMedia,true);assert.equal(result.latestDataPreserved,true);assert.deepEqual(await fs.readFile(f.project),before);assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.workspace,'runtime-selection.json'))),f.options.fallback);
  assert.equal((await listenerPids(f.port)).length,1);assert((await fs.readdir(f.workspace)).some(x=>x.endsWith('.restored.json')));
});
test('活跃任务拒绝切换，不改原PID或版本选择，不向任务端点发请求',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.workspace,'data/jobs/active.json'),JSON.stringify({status:'receiving'}));await assert.rejects(handoffRuntime(f.options),/未结束/);
  assert.deepEqual(await listenerPids(f.port),[f.initial.pid]);assert.equal((await workspaceDataState(path.join(f.workspace,'data'))).activeRecords.length,1);await assert.rejects(fs.stat(path.join(f.workspace,'runtime-selection.json')),{code:'ENOENT'});
});
test('错误PID或启动时间不停止原服务；被改动的快照也在停止前拒绝',async t=>{
  const f=await fixture(t);await assert.rejects(handoffRuntime({...f.options,expected:{...f.expected,startedAt:'not the same process'}}),/身份/);assert.deepEqual(await listenerPids(f.port),[f.initial.pid]);
  await fs.appendFile(path.join(f.workspace,'releases/next/server.mjs'),'\n// changed');await assert.rejects(handoffRuntime({...f.options,evidence:path.join(f.workspace,'second-check')}),/改变/);assert.deepEqual(await listenerPids(f.port),[f.initial.pid]);
});
test('正常启动与第二次交接不能越过已有切换锁，也不会移走其他操作的锁',async t=>{
  const f=await fixture(t),file=path.join(f.workspace,'.runtime-handoff.lock'),bytes=JSON.stringify({id:'other-owned-lease',pid:process.pid});await fs.writeFile(file,bytes);
  await assert.rejects(startWorkspaceRuntime({workspace:f.workspace,port:f.port}),/正在切换/);await assert.rejects(handoffRuntime(f.options),/切换锁/);assert.equal(await fs.readFile(file,'utf8'),bytes);assert.deepEqual(await listenerPids(f.port),[f.initial.pid]);
});
test('保留版本不能使用legacy规则来冒充新版工程可用的回退',async t=>{
  const f=await fixture(t);const legacy=await captureRuntime({source:f.workspace,destination:path.join(f.workspace,'releases/legacy'),nativeMediaMode:'legacy'});await assert.rejects(handoffRuntime({...f.options,fallback:{version:1,runtime:'releases/legacy',manifestSha256:legacy.manifestSha256}}),/支持新版工程/);assert.deepEqual(await listenerPids(f.port),[f.initial.pid]);
});
