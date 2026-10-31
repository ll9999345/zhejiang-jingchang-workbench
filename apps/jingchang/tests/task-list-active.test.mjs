import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash,randomUUID} from 'node:crypto';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const activeStates=['queued','running','preparing','pending','submitting','awaiting_input','awaiting-confirmation'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function inventory(directory){
 const result={};
 for(const entry of await fs.readdir(directory,{withFileTypes:true})){
  const file=path.join(directory,entry.name),stat=await fs.stat(file);
  result[entry.name]={size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs};
  if(entry.isDirectory())for(const [key,value]of Object.entries(await inventory(file)))result[entry.name+'/'+key]=value;
  else if(entry.isFile())result[entry.name].sha256=hash(await fs.readFile(file));
 }
 return result;
}

test('本机任务列表可额外发现最近200条之外的活动任务，GET不执行或改写记录',async t=>{
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-task-list-active-'));
 const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
 const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const child=spawn(process.execPath,['--import','./tests/helpers/local-network-only.mjs','server.mjs'],{
  cwd:root,env:{PATH:process.env.PATH,PORT:String(port),JINGCHANG_DATA_DIR:data,JINGCHANG_LLM_URL:'',JINGCHANG_LLM_MODEL:'',ARK_API_KEY:'',OPENAI_API_KEY:''},stdio:['ignore','pipe','pipe']
 });
 let output='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>output+=bytes);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}});
 const base='http://127.0.0.1:'+port;
 let ready=false;
 for(let i=0;i<200;i++){
  if(child.exitCode!==null||child.signalCode!==null)throw Error('隔离服务启动失败：'+output);
  try{ready=(await fetch(base+'/api/health',{signal:AbortSignal.timeout(1000)})).ok;if(ready)break;}catch{}
  await delay(25);
 }
 assert.equal(ready,true,'隔离服务应启动成功');

 // Seed after startup, which correctly marks persisted running work interrupted.
 // These synthetic records have no live runner or provider credentials.
 const a=randomUUID(),b=randomUUID(),records=[];
 const add=(projectId,status,createdAt,extra={})=>{const job={id:randomUUID(),kind:'studio',projectId,status,createdAt,name:'本机合成任务记录',message:'仅测试本机记录查询',requestCount:0,assets:[],...extra};records.push(job);return job;};
 const baseTime=Date.parse('2026-10-01T00:00:00Z');
 for(let i=0;i<205;i++)add(a,'completed',new Date(baseTime+i*1000).toISOString());
 for(let i=0;i<210;i++)add(b,'completed',new Date(baseTime+1000000+i*1000).toISOString());
 const recent=add(a,'queued',new Date(baseTime+500000).toISOString());
 const oldA=activeStates.map((status,index)=>add(a,status,new Date(baseTime-1000000-index*1000).toISOString(),{upstreamId:'synthetic-original-task',snapshot:{test:'not-public'},workflow:{test:'not-public'},endpoint:'http://127.0.0.1:1'}));
 const oldB=['running','awaiting_input'].map((status,index)=>add(b,status,new Date(baseTime-2000000-index*1000).toISOString()));
 const excluded=['completed','failed','cancelled','interrupted','partial','incomplete','expired'].map((status,index)=>add(a,status,new Date(baseTime-3000000-index*1000).toISOString()));
 await Promise.all(records.map(job=>fs.writeFile(path.join(data,'jobs',job.id+'.json'),JSON.stringify(job))));
 const before=await inventory(data);
 const request=async query=>{const response=await fetch(base+'/api/jobs'+query,{signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);return response.json();};
 const sorted=projectId=>records.filter(job=>!projectId||job.projectId===projectId).sort((x,y)=>y.createdAt.localeCompare(x.createdAt));
 const ids=jobs=>jobs.map(job=>job.id);

 await t.test('旧GET与非true选项保持最多200条、倒序及项目过滤',async()=>{
  const expected=ids(sorted(a).slice(0,200));
  for(const suffix of ['','&includeActive=false','&includeActive=1']){
   const jobs=await request('?projectId='+a+suffix);assert.equal(jobs.length,200);assert.deepEqual(ids(jobs),expected);
  }
  const global=await request('');assert.equal(global.length,200);assert.deepEqual(ids(global),ids(sorted().slice(0,200)));
 });

 await t.test('includeActive补齐所有旧活动和待处理状态，保留排序且不重复近期活动',async()=>{
  const jobs=await request('?projectId='+a+'&includeActive=true');
  const expected=sorted(a).filter((job,index)=>index<200||activeStates.includes(job.status));
  assert.deepEqual(ids(jobs),ids(expected));assert.equal(jobs.length,207);assert.equal(jobs.filter(job=>job.id===recent.id).length,1);
  for(const original of oldA){const job=jobs.find(job=>job.id===original.id);assert.equal(job?.status,original.status);assert.equal(job?.requestCount,0);assert.equal(job?.upstreamId,'synthetic-original-task');for(const field of ['snapshot','workflow','endpoint'])assert.equal(Object.hasOwn(job,field),false);}
  for(const job of excluded)assert.equal(jobs.some(row=>row.id===job.id),false);
 });

 await t.test('扩展列表严格隔离项目，全局查询仍包含两边活动任务',async()=>{
  const foreign=await request('?projectId='+b+'&includeActive=true');
  assert.equal(foreign.length,202);assert.ok(foreign.every(job=>job.projectId===b));for(const job of oldB)assert.ok(foreign.some(row=>row.id===job.id));
  assert.deepEqual(await request('?projectId='+randomUUID()+'&includeActive=true'),[]);
  const global=await request('?includeActive=true');assert.deepEqual(ids(global),ids(sorted().filter((job,index)=>index<200||activeStates.includes(job.status))));
  for(const job of [...oldA,...oldB,recent])assert.ok(global.some(row=>row.id===job.id));
 });

 await t.test('查询前后所有本机文件集合、内容与修改时间均不变',async()=>{
  assert.deepEqual(await inventory(data),before);
 });
});
