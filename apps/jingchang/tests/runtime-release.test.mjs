import './helpers/local-network-only.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {nativeMediaRuntime, workspaceRoot} from '../lib/runtime-config.mjs';
import {captureRuntime, verifyRuntime, runtimeLaunchPlan} from '../tools/runtime-releases.mjs';
import {readRuntimeSelection, startWorkspaceRuntime} from '../tools/start-runtime.mjs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {localMiaoCredentialService} from '../lib/miao-credentials.mjs';

async function fixture() {
  const workspace = path.resolve('artifacts/runtime-unit-' + randomUUID()), source = path.join(workspace, 'source');
  await fs.mkdir(source, {recursive:true});
  for (const name of ['lib','public','resources','node_modules']) {await fs.mkdir(path.join(source,name)); await fs.writeFile(path.join(source,name,'owned.txt'),'owned '+name);}
  for (const name of ['package.json','package-lock.json']) await fs.writeFile(path.join(source,name), JSON.stringify({version:'test-only',type:'module'}));
  await fs.writeFile(path.join(source,'server.mjs'),'// synthetic snapshot, never executed');
  return {workspace, source, destination:path.join(workspace,'frozen')};
}
const hash = b => createHash('sha256').update(b).digest('hex');
test('运行规则有明确优先级，缺配置不升级旧工程，非法配置不静默降级',async()=>{
  const f=await fixture(), mode=env=>nativeMediaRuntime({root:f.source,env});
  assert.equal((await mode({})).mode,'legacy');
  await fs.writeFile(path.join(f.source,'runtime-config.json'),JSON.stringify({version:1,nativeMediaMode:'versioned'}));
  assert.equal((await mode({})).storedMedia,true);
  assert.equal((await mode({JINGCHANG_SMART_GROUP_MEDIA_TEST:'0'})).storedMedia,false);
  assert.equal((await mode({JINGCHANG_SMART_GROUP_MEDIA_TEST:'0',JINGCHANG_NATIVE_MEDIA_MODE:'versioned'})).storedMedia,true);
  for(const env of [{JINGCHANG_NATIVE_MEDIA_MODE:'auto'},{JINGCHANG_SMART_GROUP_MEDIA_TEST:'maybe'}])await assert.rejects(mode(env));
  await fs.writeFile(path.join(f.source,'runtime-config.json'),'{bad');await assert.rejects(mode({JINGCHANG_NATIVE_MEDIA_MODE:'legacy'}));
  assert.throws(()=>workspaceRoot({JINGCHANG_WORKSPACE_ROOT:'../data'}));
  assert.equal(workspaceRoot({JINGCHANG_WORKSPACE_ROOT:f.workspace}),f.workspace);
});
test('快照不含原数据和环境文件，无硬链接，内容及执行权限改变均拒绝启动',async()=>{
  const f=await fixture();await fs.mkdir(path.join(f.source,'data'));await fs.writeFile(path.join(f.source,'data','owned.json'),'private fixture');await fs.writeFile(path.join(f.source,'.env'),'synthetic-do-not-copy');
  await fs.chmod(path.join(f.source,'server.mjs'),0o755);
  const receipt=await captureRuntime({...f,nativeMediaMode:'versioned'}),verify=()=>verifyRuntime({directory:f.destination,manifestSha256:receipt.manifestSha256});
  assert.equal((await verify()).nativeMediaMode,'versioned');
  await assert.rejects(fs.stat(path.join(f.destination,'data')),{code:'ENOENT'});await assert.rejects(fs.stat(path.join(f.destination,'.env')),{code:'ENOENT'});
  assert.notEqual((await fs.stat(path.join(f.source,'server.mjs'))).ino,(await fs.stat(path.join(f.destination,'server.mjs'))).ino);
  await assert.rejects(captureRuntime({...f,nativeMediaMode:'legacy'}),{code:'EEXIST'});
  await fs.chmod(path.join(f.destination,'server.mjs'),0o644);await assert.rejects(verify(),/执行权限/);
  assert.equal((await fs.stat(path.join(f.source,'server.mjs'))).mode&0o777,0o755);
  await fs.chmod(path.join(f.destination,'server.mjs'),0o755);await fs.writeFile(path.join(f.destination,'server.mjs'),'changed');await assert.rejects(verify(),/内容/);
});
test('封存清单或新增文件被改动时停止，保留坏副本用于检查',async()=>{
  const f=await fixture(),receipt=await captureRuntime({...f,nativeMediaMode:'legacy'});
  await fs.writeFile(path.join(f.destination,'extra.txt'),'extra');await assert.rejects(verifyRuntime({directory:f.destination,manifestSha256:receipt.manifestSha256}),/增减/);
  const file=path.join(f.destination,'runtime-manifest.json'),bytes=await fs.readFile(file);await fs.writeFile(file,Buffer.concat([bytes,Buffer.from(' ')]));
  await assert.rejects(verifyRuntime({directory:f.destination,manifestSha256:receipt.manifestSha256}),/清单已经改变/);
  assert.equal((await fs.readFile(path.join(f.destination,'extra.txt'),'utf8')),'extra');
});
test('链接和代码目录内私密配置阻止封存，工作区外路径不能作为运行选择',async()=>{
  for(const kind of ['link','secret']){
    const f=await fixture();if(kind==='link')await fs.symlink(path.join(f.source,'server.mjs'),path.join(f.source,'lib','linked.mjs'));else await fs.writeFile(path.join(f.source,'lib','.env.local'),'synthetic');
    await assert.rejects(captureRuntime({...f,nativeMediaMode:'versioned'}),kind==='link'?/链接/:/私密/);
    await assert.rejects(fs.stat(f.destination),{code:'ENOENT'});
  }
  const f=await fixture();await assert.rejects(runtimeLaunchPlan({workspace:f.workspace,selection:{version:1,runtime:'../other',manifestSha256:'a'.repeat(64)}}),/选择无效/);
});
test('启动计划固定工作区与数据路径，封存规则覆盖残留测试开关，不写选择或数据',async()=>{
  const f=await fixture(),receipt=await captureRuntime({...f,nativeMediaMode:'versioned'}),selection={version:1,runtime:'frozen',manifestSha256:receipt.manifestSha256};
  const plan=await runtimeLaunchPlan({workspace:f.workspace,selection,port:19731,env:{JINGCHANG_SMART_GROUP_MEDIA_TEST:'0',JINGCHANG_NATIVE_MEDIA_MODE:'legacy'}});
  assert.equal(plan.env.JINGCHANG_NATIVE_MEDIA_MODE,'versioned');assert.equal(plan.env.JINGCHANG_SMART_GROUP_MEDIA_TEST,undefined);assert.equal(plan.env.JINGCHANG_WORKSPACE_ROOT,f.workspace);assert.equal(plan.data,path.join(f.workspace,'data'));assert.equal(plan.directory,f.destination);
  await assert.rejects(runtimeLaunchPlan({workspace:f.workspace,selection,dataDir:path.join(f.destination,'data')}),/用户数据/);
  assert.equal(await readRuntimeSelection(f.workspace),undefined);
  await fs.writeFile(path.join(f.workspace,'runtime-selection.json'),'not json');await assert.rejects(readRuntimeSelection(f.workspace));await assert.rejects(fs.stat(plan.data),{code:'ENOENT'});
});
test('端口已被占用时不改PID、不停止原服务，也不新建用户目录',async t=>{
  const f=await fixture(),server=createServer((_q,s)=>s.end('owned existing service'));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
  const data=path.join(f.workspace,'unused-data');await assert.rejects(startWorkspaceRuntime({workspace:f.source,port:server.address().port,dataDir:data,env:{}}),{code:'EADDRINUSE'});
  assert.equal(await(await fetch('http://127.0.0.1:'+server.address().port)).text(),'owned existing service');await assert.rejects(fs.stat(data),{code:'ENOENT'});
});
test('篡改清单后即使自己重算摘要，越界文件和不匹配环境仍被校验拒绝',async()=>{
  const f=await fixture(),receipt=await captureRuntime({...f,nativeMediaMode:'legacy'}),file=path.join(f.destination,'runtime-manifest.json'),m=JSON.parse(await fs.readFile(file));
  m.files['../outside']={sha256:'0'.repeat(64),size:1,mode:0o600};let bytes=JSON.stringify(m);await fs.writeFile(file,bytes);await assert.rejects(verifyRuntime({directory:f.destination,manifestSha256:hash(bytes)}),/非运行文件/);
  delete m.files['../outside'];m.arch='other';bytes=JSON.stringify(m);await fs.writeFile(file,bytes);await assert.rejects(verifyRuntime({directory:f.destination,manifestSha256:hash(bytes)}),/运行环境/);
});
test('独立程序目录仍从指定工作区定位文旅助手及密钥读取运行时，仅用本机假助手验证路径',async()=>{
  const f=await fixture(),ownedWorkspace=path.join(f.workspace,'workbench/apps/jingchang'),v2=path.join(f.workspace,'workbench'),python=path.join(v2,'.venv/bin/python'),helper=path.join(v2,'scripts/canvas_deepseek.py');
  await fs.mkdir(path.dirname(python),{recursive:true});
  await fs.writeFile(python,'#!'+process.execPath+'\nlet input="";process.stdin.on("data",b=>input+=b);process.stdin.on("end",()=>console.log(JSON.stringify({ok:true,result:{helper:process.argv[2],operation:JSON.parse(input).operation}})));',{mode:0o755});
  const code="import {callDirectorHelper} from './lib/director-provider.mjs';console.log(JSON.stringify(await callDirectorHelper({operation:'status'})));";
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env,JINGCHANG_WORKSPACE_ROOT:ownedWorkspace,JINGCHANG_DIRECTOR_PYTHON:'',JINGCHANG_DIRECTOR_HELPER:''}});
  assert.deepEqual(JSON.parse(stdout),{helper,operation:'status'});
  const executions=[],service=localMiaoCredentialService({env:{JINGCHANG_WORKSPACE_ROOT:ownedWorkspace},platform:'darwin',execFileImpl:async(...args)=>{executions.push(args);return{stdout:'{"configured":true}',stderr:''};}});
  assert.equal((await service.status()).configured,true);assert.equal(executions[0][0],python);assert.equal(executions[0][1].at(-1),'metadata');
});
