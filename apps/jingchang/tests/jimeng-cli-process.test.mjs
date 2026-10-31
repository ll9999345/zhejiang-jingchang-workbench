import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {runJimengProcess as run,parseJimengOutput as parse,jimengEnvironment} from '../lib/jimeng-cli-process.mjs';
const stage=path.resolve('artifacts/jimeng-cli-process-tests-'+Date.now());await fs.mkdir(stage,{recursive:true});
const fixture=path.join(stage,'fixture.mjs');await fs.writeFile(fixture,`#!${process.execPath}
import {writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';
const [mode,...args]=process.argv.slice(2);writeFileSync('call.json',JSON.stringify({mode,args,envKeys:Object.keys(process.env),cwd:process.cwd()}));
if(mode==='pending'){console.log('prefix '+JSON.stringify({data:{submit_id:'original-123',gen_status:'pending'}}));}
else if(mode==='nonzero'){console.log(JSON.stringify({submit_id:'original-123',gen_status:'pending'}));process.exitCode=3;}
else if(mode==='media'){console.log(JSON.stringify({data:{submit_id:'original-123',gen_status:'success',images:[{file_path:process.cwd()+'/output.png'}]}}));}
else if(mode==='split'){const b=Buffer.from(JSON.stringify({submit_id:'original-123',message:'中文'}));const i=b.indexOf(Buffer.from('中'))+1;process.stdout.write(b.subarray(0,i));setTimeout(()=>process.stdout.write(b.subarray(i)),10);}
else if(mode==='hang'){process.stdout.write(JSON.stringify({submit_id:'original-123',gen_status:'pending'}));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
else if(mode==='large'){process.stdout.write('x'.repeat(200000));setInterval(()=>{},1000);}
else if(mode==='secret'){process.stderr.write('sk-synthetic-never-return-123456');process.exitCode=2;}
else if(mode==='tree'){const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});writeFileSync('child.pid',String(c.pid));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);}
`);await fs.chmod(fixture,0o755);let index=0;
async function context(){const cwd=path.join(stage,'run-'+(++index));await fs.mkdir(cwd);return{cwd,env:{...process.env,SECRET_TEST_KEY:'do-not-forward',OPENAI_API_KEY:'do-not-forward',JIMENG_TOKEN:'do-not-forward'},timeoutMs:4000};}
const wait=async predicate=>{const end=Date.now()+4000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,20));}throw Error('condition timed out');};
test('parser accepts known async and media shapes; pending/failed outputs are not trusted',()=>{
 for(const status of ['pending','querying'])assert.equal(parse('warning\n'+JSON.stringify({data:{submit_id:'abc',gen_status:status,images:['/tmp/input.png']}})).status,'pending');assert.deepEqual(parse(JSON.stringify({submit_id:'a',gen_status:'fail',images:['/tmp/x.png']})).outputs,[]);
 const r=parse(JSON.stringify({data:{submit_id:'a',result_json:JSON.stringify({gen_status:'success',images:[{file_path:'/safe/result.png'}]})}}));assert.equal(r.status,'completed');assert.deepEqual(r.outputs,['/safe/result.png']);
 assert.equal(parse('{"submit_id":"a"}\n{"submit_id":"b"}').status,'uncertain');assert.equal(parse('{"submit_id":"b"}',{expectedId:'a'}).status,'uncertain');assert.equal(parse('{"submit_id":"../x"}').status,'uncertain');assert.equal(parse('no result').status,'uncertain');
 assert.equal(parse('{"code":403,"data":{"submit_id":"a"}}').status,'failed');
 const array=parse(JSON.stringify({data:[{submit_id:'a',gen_status:'success',images:[{file_path:'/isolated/out.png'}]}]}));assert.equal(array.status,'completed');assert.deepEqual(array.outputs,['/isolated/out.png']);assert.equal(parse(JSON.stringify({success:false,images:['/isolated/not-a-result.png']})).status,'failed');
});
test('real subprocess receives literal argument vector, restricted environment and dedicated working directory',async()=>{
 const c=await context(),literal='$(touch no); `whoami` 中文';const ids=[];const r=await run(fixture,['pending',literal],{...c,onTaskId:async id=>ids.push(id)});assert.equal(r.upstreamId,'original-123');assert.equal(r.exitCode,0);assert.deepEqual(ids,['original-123']);const call=JSON.parse(await fs.readFile(path.join(c.cwd,'call.json'),'utf8'));assert.deepEqual(call.args,[literal]);for(const k of ['SECRET_TEST_KEY','OPENAI_API_KEY','JIMENG_TOKEN'])assert.ok(!call.envKeys.includes(k));assert.equal(call.cwd,c.cwd);await assert.rejects(fs.access(path.join(c.cwd,'no')));
});
test('nonzero exit with original task ID is preserved and never auto-retried',async()=>{
 const c=await context(),r=await run(fixture,['nonzero'],c);assert.equal(r.exitCode,3);assert.equal(r.upstreamId,'original-123');assert.equal(r.status,'pending');
});
test('UTF-8 split streams and local result payload survive without persisting raw streams',async()=>{
 const c=await context();assert.equal((await run(fixture,['split'],c)).upstreamId,'original-123');const m=await context(),r=await run(fixture,['media'],m);assert.equal(r.status,'completed');assert.deepEqual(r.outputs,[m.cwd+'/output.png']);
});
test('task-ID callback must complete before resolution and persistence failures reject',async()=>{
 const c=await context();let saved=false;await run(fixture,['pending'],{...c,onTaskId:async()=>{await new Promise(r=>setTimeout(r,30));saved=true;}});assert.equal(saved,true);await assert.rejects(run(fixture,['pending'],{...await context(),onTaskId:async()=>{throw Error('private-path-secret');}}),e=>!e.message.includes('private-path-secret')&&/落盘/.test(e.message));
});
test('timeout retains already observed original ID and kills the actual process; abort never reruns',async()=>{
 const c=await context(),ids=[];await assert.rejects(run(fixture,['hang'],{...c,timeoutMs:250,onTaskId:async id=>ids.push(id)}),/超时/);assert.deepEqual(ids,['original-123']);const a=await context(),control=new AbortController(),p=run(fixture,['hang'],{...a,signal:control.signal});await wait(async()=>fs.access(path.join(a.cwd,'call.json')).then(()=>true,()=>false));control.abort();await assert.rejects(p,/停止/);
});
test('oversized output and stderr-only secrets yield fixed errors without raw private data',async()=>{
 await assert.rejects(run(fixture,['large'],{...await context(),maxBytes:1000}),/界限/);await assert.rejects(run(fixture,['secret'],await context()),e=>!e.message.includes('sk-')&&!e.message.includes('never-return'));
});
test('timeouts terminate a detached process tree, including a child whose leader exits on TERM',async()=>{
 const c=await context();await assert.rejects(run(fixture,['tree'],{...c,timeoutMs:300}),/超时/);const pid=Number(await fs.readFile(path.join(c.cwd,'child.pid'),'utf8'));await wait(()=>{try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}});
});
test('no inherited account or API variables except existing native-login home path',()=>{
 const e=jimengEnvironment({HOME:'/local-home',PATH:'/usr/bin',DREAMINA_TOKEN:'private',HTTPS_PROXY:'private-proxy',NODE_OPTIONS:'--require=bad'});assert.equal(e.HOME,'/local-home');assert.equal(e.DREAMINA_TOKEN,undefined);assert.equal(e.HTTPS_PROXY,undefined);assert.equal(e.NODE_OPTIONS,undefined);
});
console.log('Retained isolated CLI process evidence:',stage);
