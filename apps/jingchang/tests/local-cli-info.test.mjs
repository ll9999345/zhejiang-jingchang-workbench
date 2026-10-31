import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {localCliFixture} from './helpers/local-cli-fixture.mjs';
import {localCliStatus} from '../lib/local-cli-status.mjs';
import {localCliInfoService,cleanCliInfo} from '../lib/local-cli-info.mjs';
import {localCliHelpTopics} from '../public/local-cli-core.js';
async function fixture(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-cli-info-test-'));const f=await localCliFixture(path.join(dir,'programs with spaces'));return {...f,service:localCliInfoService({env:{...f.env,OPENAI_API_KEY:'synthetic-environment-secret',ANTHROPIC_AUTH_TOKEN:'synthetic-other-secret',NODE_OPTIONS:'--invalid-test-flag'},workingDirectory:dir})};}
const payload={consent:true};
test('默认CLI状态仍只检查文件，即使存在程序也不执行版本或帮助',async()=>{const f=await fixture(),status=await localCliStatus('codex',{env:f.env});assert.equal(status.version,null);assert.equal(status.loggedIn,null);assert.equal(status.accountChecked,false);assert.equal(status.helpTopics.length,8);assert.equal((await f.calls()).length,0);});
test('Codex版本与每个帮助主题都是分离参数，空间路径不经shell，环境无Key或Node注入',async()=>{const f=await fixture(),result=await f.service.read('codex','version',payload);assert.equal(result.version,'synthetic-cli 1.4.2');assert.equal(result.accountChecked,false);assert.equal(result.loggedIn,null);for(const topic of localCliHelpTopics('codex'))await f.service.read('codex','help',{...payload,command:topic.command});const calls=await f.calls();assert.equal(calls.length,9);assert.deepEqual(calls[0].args,['--version']);for(const [i,topic] of localCliHelpTopics('codex').entries())assert.deepEqual(calls[i+1].args,[...(topic.command?[topic.command]:[]),'--help']);assert.ok(calls.every(c=>!c.envKeys.includes('OPENAI_API_KEY')&&!c.envKeys.includes('ANTHROPIC_AUTH_TOKEN')&&!c.envKeys.includes('NODE_OPTIONS')));assert.ok(calls.every(c=>c.cwd!==process.cwd()));assert.ok(!JSON.stringify(result).includes(f.directory));});
test('Gemini与Antigravity按显式配置区分主题和程序，不混用命令',async()=>{const f=await fixture();const agy=await localCliStatus('gemini-cli',{env:f.env});assert.equal(agy.variant,'antigravity');await f.service.read('gemini-cli','help',{...payload,command:'install'});const env={...f.env,ANTIGRAVITY_BIN:undefined,AGY_BIN:undefined},gemini=localCliInfoService({env});assert.equal((await localCliStatus('gemini-cli',{env})).variant,'gemini');await gemini.read('gemini-cli','help',{...payload,command:'extensions'});await assert.rejects(gemini.read('gemini-cli','help',{...payload,command:'install'}),/不允许/);assert.deepEqual((await f.calls()).map(c=>[c.executable,c.args]),[['agy.mjs',['install','--help']],['gemini.mjs',['extensions','--help']]]);});
test('即梦全部帮助加-h，包括积分和登录说明；不进行积分、登录或生成操作',async()=>{const f=await fixture();for(const topic of localCliHelpTopics('jimeng'))await f.service.read('jimeng','help',{...payload,command:topic.command});assert.ok((await f.calls()).every(c=>c.args.at(-1)==='-h'));assert.deepEqual((await f.calls()).find(c=>c.args[0]==='user_credit').args,['user_credit','-h']);});
test('缺少同意、参数注入、不支持字段和真正任务命令在启动前拒绝',async()=>{const f=await fixture();for(const [action,b] of [['help',{}],['help',{...payload,command:'exec; touch sentinel'}],['help',{...payload,command:'--version'}],['help',{...payload,command:['login']}],['help',{...payload,command:' exec'}],['help',{...payload,command:'login',args:['--with-api-key']}],['version',{...payload,command:'login'}],['login',payload]])await assert.rejects(f.service.read('codex',action,b));assert.equal((await f.calls()).length,0);});
test('帮助纯文字过滤控制码和常见凭据，失败不泄漏stderr；分块中文保留',async()=>{const f=await fixture();await f.mode('secret');const result=await f.service.read('codex','help',payload);for(const bad of ['synthetic-test-key','synthetic-bearer-token','synthetic-password','sk-synthetic-cli-secret','eyJhbG','\x1b'])assert.ok(!result.text.includes(bad),bad);assert.ok(result.text.includes('[已隐藏'));await f.mode('error');await assert.rejects(f.service.read('codex','version',payload),e=>e.status===502&&!e.message.includes('sk-'));await f.mode('split');assert.equal((await f.service.read('codex','help',payload)).text,'中文帮助');await f.mode('empty');await assert.rejects(f.service.read('codex','help',payload),/没有返回/);assert.equal(cleanCliInfo('normal help'),'normal help');});
test('超量输出、超时和取消结束子进程；失败不自动重试且后续仍可查看',async()=>{const f=await fixture();await f.mode('large');await assert.rejects(f.service.read('codex','help',payload),/64KB/);await f.mode('hang');const service=localCliInfoService({env:f.env,timeoutMs:80}),beforeTimeout=(await f.calls()).length;await assert.rejects(service.read('codex','version',payload),e=>e.status===504);assert.ok((await f.calls()).length<=beforeTimeout+1);const beforeCancel=(await f.calls()).length,controller=new AbortController(),pending=f.service.read('codex','help',payload,{signal:controller.signal});for(let i=0;i<1000&&(await f.calls()).length===beforeCancel;i++)await new Promise(r=>setTimeout(r,10));assert.equal((await f.calls()).length,beforeCancel+1);controller.abort();await assert.rejects(pending,e=>e.status===499);assert.equal((await f.calls()).length,beforeCancel+1);await f.mode('normal');assert.equal((await f.service.read('codex','version',payload)).version,'synthetic-cli 1.4.2');});
test('并行重复请求拒绝且取消整个同组进程树，预先取消不启动程序',async()=>{
 if(process.platform==='win32')return;
 const f=await fixture();await f.mode('tree');
 const controller=new AbortController(),pending=f.service.read('codex','help',payload,{signal:controller.signal});
 // Handle early rejection while polling; assertions below still inspect the
 // original promise and verify the cancellation status.
 void pending.catch(()=>{});
 try{
  let pid;
  for(let i=0;i<100;i++){
   try{
    const candidate=Number((await fs.readFile(path.join(f.directory,'child-pid.txt'),'utf8')).trim());
    // writeFileSync creates the file before its PID contents are visible.
    if(Number.isSafeInteger(candidate)&&candidate>0){pid=candidate;break;}
   }catch{}
   await new Promise(r=>setTimeout(r,10));
  }
  assert.ok(pid);
  await assert.rejects(f.service.read('codex','version',payload),e=>e.status===409);
  controller.abort();await assert.rejects(pending,e=>e.status===499);
  let gone=false;
  for(let i=0;i<100;i++){
   try{process.kill(pid,0);}catch{gone=true;break;}
   await new Promise(r=>setTimeout(r,10));
  }
  assert.ok(gone,'child tree must terminate');
  await assert.rejects(f.service.read('codex','help',payload,{signal:controller.signal}),e=>e.status===499);
  assert.equal((await f.calls()).length,1);
 }finally{
  controller.abort();await pending.catch(()=>{});
 }
});
test('缺失、WSL和Windows脚本入口不会启动shell或后台安装',async()=>{const f=await fixture();await assert.rejects(localCliInfoService({env:{PATH:''}}).read('codex','version',payload),e=>e.status===404);await assert.rejects(localCliInfoService({env:{...f.env,JIMENG_USE_WSL:'1'}}).read('jimeng','help',payload),e=>e.status===501);const win=localCliInfoService({platform:'win32',resolveTool:async()=>({executable:'C:\\tools\\codex.cmd'})});await assert.rejects(win.read('codex','help',payload),e=>e.status===501);assert.equal((await f.calls()).length,0);});
