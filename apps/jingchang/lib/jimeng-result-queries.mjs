import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';
import {safeId,userError} from './workspace.mjs';
import {normalizeJimengResultQueries,jimengScopedQueryAuthorization} from '../public/jimeng-query-scope.js';

const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
const time=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const broken=()=>userError('原编号限额查询记录不完整或范围不符；已暂停，原件保留',409);
const stamp=()=>new Date().toISOString();
const live=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
const sessionEndStates=['completed','exhausted','paused','stopped'];
const activeSessions=new Map();
export const resultQueryFingerprint=task=>sha({taskId:task.id,projectId:task.projectId,planFingerprint:task.fingerprint,upstreamId:task.upstreamId,policy:normalizeJimengResultQueries(task.plan.resultQueries)});
export const resultQueryRequestId=(id,index)=>'rq-'+sha(id+':'+index).slice(0,48);
export function automaticQueryCount(task){
 const policy=normalizeJimengResultQueries(task.plan.resultQueries),expected=new Map(Array.from({length:policy.requestLimit},(_,i)=>[resultQueryRequestId(task.id,i+1),i+1]));
 const auto=task.queries.filter(query=>expected.has(query.requestId));
 if(auto.some(query=>!isDeepStrictEqual(query.authorization,jimengScopedQueryAuthorization(task.plan,task.upstreamId))))throw broken();
 return auto.length;
}
function validateSession(value,number){
 if(!exact(value,['requestId','scopeFingerprint','createdAt','pid'])||!safeId(value.requestId)||!/^\w{64}$/.test(value.scopeFingerprint)||!time(value.createdAt)||!Number.isInteger(value.pid)||value.pid<1)throw broken();
 return{number,requestId:value.requestId,scopeFingerprint:value.scopeFingerprint,createdAt:value.createdAt};
}
function validateEnd(value){if(!exact(value,['status','createdAt'])||!sessionEndStates.includes(value.status)||!time(value.createdAt))throw broken();return value;}
export function validateResultQueryHistory(task){
 const value=task.resultQueries;if(!task.plan.resultQueries){if(value!==undefined)throw broken();return;}
 if(!exact(value,['scopeFingerprint','used','remaining','state','sessions',...(value.initialStoppedAt!==undefined?['initialStoppedAt']:[])])||value.scopeFingerprint!==resultQueryFingerprint(task)||!Array.isArray(value.sessions)||value.sessions.length>1000||!sessionEndStates.includes(value.state))throw broken();
 if(value.initialStoppedAt!==undefined&&!time(value.initialStoppedAt))throw broken();const used=automaticQueryCount(task);if(value.used!==used||value.remaining!==task.plan.resultQueries.requestLimit-used)throw broken();
 const seen=new Set();for(const [i,s]of value.sessions.entries()){
  if(!exact(s,['number','requestId','scopeFingerprint','createdAt',...(s.result?['result']:[]),...(s.stoppedAt?['stoppedAt']:[])])||s.number!==i+1||!safeId(s.requestId)||seen.has(s.requestId)||s.scopeFingerprint!==value.scopeFingerprint||!time(s.createdAt))throw broken();
  if(s.result)validateEnd(s.result);if(s.stoppedAt!==undefined&&!time(s.stoppedAt))throw broken();seen.add(s.requestId);
 }
 const expected=task.status==='completed'?'completed':!value.remaining?'exhausted':(value.sessions.at(-1)?.stoppedAt||value.sessions.at(-1)?.result?.status==='stopped'||!value.sessions.length&&value.initialStoppedAt)?'stopped':'paused';
 if(value.state!==expected)throw broken();
}

// Scheduling never runs from reads or process startup. Each new session has an
// immutable disk claim; a dead owner permits an explicit, bounded continuation.
export function jimengResultQueries({store,getTask,queryTask,activeJobs,scopeKey,wait=(ms,signal)=>sleep(ms,undefined,{signal}),operationGuard}){
 const sessionKey=(task,number)=>scopeKey+':'+task.id+':'+number;
 const sessionAlive=(task,session)=>session.pid===process.pid?!!activeSessions.get(sessionKey(task,session.number))?.size:live(session.pid);
 function reserve(task,number,controller){const key=sessionKey(task,number),owners=activeSessions.get(key)||new Set();owners.add(controller);activeSessions.set(key,owners);}
 function release(task,number,controller){const key=sessionKey(task,number),owners=activeSessions.get(key);owners?.delete(controller);if(!owners?.size)activeSessions.delete(key);}
 async function readSessions(task){
  const sessions=[],fingerprint=resultQueryFingerprint(task);
  for(let number=1;number<=1001;number++){
   const value=await store.read(task.id+'.result-session-'+number+'.json',{missing:true});if(!value)break;if(number===1001)throw broken();
   const session=validateSession(value,number);if(session.scopeFingerprint!==fingerprint)throw broken();
   const result=await store.read(task.id+'.result-session-'+number+'-result.json',{missing:true});if(result)session.result=validateEnd(result);
   const stop=await store.read(task.id+'.result-session-'+number+'-stop.json',{missing:true});if(stop&&(!exact(stop,['createdAt'])||!time(stop.createdAt)))throw broken();
   sessions.push({...session,pid:value.pid,stopped:!!stop,...(stop?{stoppedAt:stop.createdAt}:{})});
  }
  if(new Set(sessions.map(s=>s.requestId)).size!==sessions.length)throw broken();return sessions;
 }
 async function initialStop(id){const value=await store.read(id+'.result-queries-stopped.json',{missing:true});if(value&&(!exact(value,['createdAt'])||!time(value.createdAt)))throw broken();return value;}
 async function state(task){
  if(!task.plan.resultQueries)return undefined;
  const stopped=await initialStop(task.id),sessions=await readSessions(task),used=automaticQueryCount(task),remaining=task.plan.resultQueries.requestLimit-used,last=sessions.at(-1),stoppedInitial=!!stopped&&last?.requestId==='initial-'+sha(task.id).slice(0,48),active=last&&!last.result&&!last.stopped&&!stoppedInitial&&sessionAlive(task,last);
  const status=task.status==='completed'?(last&&!last.result&&sessionAlive(task,last)?'finishing':'completed'):active?(task.status==='executing'?'querying':'waiting'):last&&!last.result&&(last.stopped||stoppedInitial)&&sessionAlive(task,last)?'stopping':!remaining?'exhausted':last?.stopped||last?.result?.status==='stopped'||!last&&stopped?'stopped':'paused';
  return{scopeFingerprint:resultQueryFingerprint(task),used,remaining,state:status,sessions:sessions.map(({pid,stopped,...session})=>session),...(stopped?{initialStoppedAt:stopped.createdAt}:{})};
 }
 async function finish(id,number,status){try{await store.publish(id+'.result-session-'+number+'-result.json',{status,createdAt:stamp()});}catch(error){if(error.code!=='EEXIST')throw error;}}
 async function run(task,number,controller,explicit){
  let end='paused',releaseAccount=()=>{};const key='jimeng-result-queries-'+scopeKey+':'+task.id;
  activeJobs.set(key,{kind:'jimeng-result-queries',projectId:task.projectId,controller});
  try{
   releaseAccount=operationGuard?.acquire()||(()=>{});let permitUncertain=explicit;
   for(;;){
    controller.signal.throwIfAborted();if(!explicit&&await initialStop(task.id)){end='stopped';break;}let current=await getTask(task.id,task.projectId);
    if(current.status==='completed'){end='completed';break;}
    const used=automaticQueryCount(current);if(used>=task.plan.resultQueries.requestLimit){end='exhausted';break;}
    if(current.status!=='pending'&&!(permitUncertain&&current.status==='uncertain'))break;
    await wait(task.plan.resultQueries.intervalSeconds*1000,controller.signal);controller.signal.throwIfAborted();
    if(await store.read(task.id+'.result-session-'+number+'-stop.json',{missing:true})){end='stopped';break;}
    current=await getTask(task.id,task.projectId);
    if(current.status==='completed'){end='completed';break;}
    if(current.status!=='pending'&&!(permitUncertain&&current.status==='uncertain'))break;
    const index=Array.from({length:task.plan.resultQueries.requestLimit},(_,i)=>i+1).find(index=>!current.queries.some(query=>query.requestId===resultQueryRequestId(task.id,index)));
    if(index===undefined){end='exhausted';break;}
    controller.signal.throwIfAborted();if(!explicit&&await initialStop(task.id)){end='stopped';break;}if(await store.read(task.id+'.result-session-'+number+'-stop.json',{missing:true})){end='stopped';break;}
    await queryTask(task.id,{projectId:task.projectId,requestId:resultQueryRequestId(task.id,index),consent:true,authorization:jimengScopedQueryAuthorization(task.plan,current.upstreamId)});
    permitUncertain=false;
    for(;;){controller.signal.throwIfAborted();current=await getTask(task.id,task.projectId);if(current.status!=='executing')break;await wait(40,controller.signal);}
    // A provider/CLI error, incomplete response or import error is a pause,
    // never an automatic retry even if there is budget left in the envelope.
    if(!['pending','completed'].includes(current.status))break;
   }
  }catch{end=controller.signal.aborted?'stopped':'paused';}
  finally{try{await finish(task.id,number,end);}finally{release(task,number,controller);activeJobs.delete(key);releaseAccount();}}
 }
 async function start(id,projectId,body,options){const releaseAccount=operationGuard?.acquire()||(()=>{});try{return await startPrepared(id,projectId,body,options);}finally{releaseAccount();}}
 async function startPrepared(id,projectId,body,{initial=false}={}){
  const task=await getTask(id,projectId);if(!task.plan.resultQueries)return task;if(initial&&await initialStop(id))return task;
  const scopeFingerprint=resultQueryFingerprint(task),requestId=initial?'initial-'+sha(id).slice(0,48):body?.requestId;
  if(!initial&&(!exact(body,['projectId','requestId','scopeFingerprint','consent'])||!safeId(requestId)||body?.consent!==true||body.scopeFingerprint!==scopeFingerprint))throw userError('请明确确认原编号剩余查询范围；不会增加次数或预算');
  if(!task.upstreamId)throw userError('没有原任务编号，不能继续查询或重提生成',409);
  for(;;){
   const sessions=await readSessions(task),replay=sessions.find(session=>session.requestId===requestId);if(replay)return getTask(id,projectId);
   const last=sessions.at(-1);if(last&&!last.result&&sessionAlive(task,last))throw userError('已有原编号查询会话，请读取原记录',409);
   if(task.status==='executing')throw userError('原CLI操作尚未结束，请先读取原记录',409);
   if(task.status==='completed'||automaticQueryCount(task)>=task.plan.resultQueries.requestLimit)return task;
   if(initial&&(sessions.length||task.status!=='pending'))return task;
   if(!initial&&!['pending','uncertain'].includes(task.status))throw userError('原任务已失败或状态不允许继续，请在平台核对',409);
   const number=sessions.length+1;if(number>1000)throw broken();
   const controller=new AbortController();reserve(task,number,controller);
   try{await store.publish(id+'.result-session-'+number+'.json',{requestId,scopeFingerprint,createdAt:stamp(),pid:process.pid});}catch(error){release(task,number,controller);if(error.code==='EEXIST')continue;throw error;}
   void run(task,number,controller,!initial).catch(()=>{});return getTask(id,projectId);
  }
 }
 async function stop(id,projectId){
  const task=await getTask(id,projectId);if(!task.plan.resultQueries)return;
  try{await store.publish(id+'.result-queries-stopped.json',{createdAt:stamp()});}catch(error){if(error.code!=='EEXIST')throw error;}
  const sessions=await readSessions(task),last=sessions.at(-1);if(!last||last.result)return;
  try{await store.publish(id+'.result-session-'+last.number+'-stop.json',{createdAt:stamp()});}catch(error){if(error.code!=='EEXIST')throw error;}
  for(const controller of activeSessions.get(sessionKey(task,last.number))||[])controller.abort();
 }
 return{state,start,stop,busy:async task=>{if(!task.plan.resultQueries)return false;const last=(await readSessions(task)).at(-1);return!!(last&&!last.result&&sessionAlive(task,last));}};
}
