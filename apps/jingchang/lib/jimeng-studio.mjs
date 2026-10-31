import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';
import {atomicJson,readJson,userError,loadAsset,records,safeId,textValue,assertNoCredentials} from './workspace.mjs';
import {isJimengStudio,jimengStudioRequest,jimengStudioAuthorization,normalizeJimengStudioConfig} from '../public/jimeng-studio-core.js';

export function normalizeJimengStudio(input){
 assertNoCredentials(input);const config=normalizeJimengStudioConfig(input.config,input.mode),ids=['prompt','references','config','generate','output'];
 if(typeof input.prompt!=='string'||input.prompt.length>20000)throw userError('即梦提示词最多20000字');
 if(!Array.isArray(input.references)||input.references.length>20||input.references.some(ref=>!safeId(ref?.assetId)||ref.url))throw userError('即梦仅接受本机工程素材，最多20项');
 if(!Array.isArray(input.nodes)||input.nodes.length!==5||new Set(input.nodes.map(n=>n.id)).size!==5||input.nodes.some(n=>!ids.includes(n.id)||![n.x,n.y].every(v=>Number.isFinite(v)&&Math.abs(v)<1e6)))throw userError('创作节点位置无效');
 const v=input.viewport;if(!v||![v.x,v.y,v.zoom].every(Number.isFinite)||Math.abs(v.x)>1e6||Math.abs(v.y)>1e6||v.zoom<.15||v.zoom>3)throw userError('创作视图无效');
 return{name:textValue(input.name,120,'项目名称'),mode:input.mode,prompt:input.prompt,config,references:input.references.map(ref=>({assetId:ref.assetId})),nodes:input.nodes.map(({id,x,y})=>({id,x,y})),viewport:{x:v.x,y:v.y,zoom:v.zoom},view:input.view==='list'?'list':'canvas'};
}
export function validateJimengStudioAuthorization(studio,authorization,{sendOriginalMedia=false}={}){
 const expected=jimengStudioAuthorization(studio,{budget:authorization?.budget,consent:true,sendOriginalMedia});
 if(!isDeepStrictEqual(expected,authorization)||!Number.isFinite(authorization?.budget)||authorization.budget<=0||authorization.budget>1e6)throw userError('请确认即梦本机账号、命令、模型、原文件、生成预算及原编号查询范围');
 return structuredClone(expected);
}
export function jimengStudioAdapter({data,activeJobs,tasks,projects,pollInterval=150}){
 const file=id=>path.join(data,'jobs',id+'.json');
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),locks=new Map();
 async function refresh(job){const previous=locks.get(job.id)||Promise.resolve(),next=previous.catch(()=>{}).then(async()=>refreshUnlocked(await readJson(file(job.id))));locks.set(job.id,next);try{return await next;}finally{if(locks.get(job.id)===next)locks.delete(job.id);}}
 async function refreshUnlocked(job){
  if(!isJimengStudio(job.input?.studio))return job;
  let record;try{record=await tasks.get(job.jimengTaskId,job.projectId);}catch(error){if(error.code!=='ENOENT')throw error;const next={...job,status:'interrupted',message:'原CLI请求记录尚未完整建立；未自动重发，请核对原记录',uncertain:true};if(!same(job,next))await atomicJson(file(job.id),next);return next;}
  const live=['preparing','waiting','querying','stopping','finishing'].includes(record.resultQueries?.state)||record.status==='executing';
  const status=record.status==='completed'&&record.resultQueries?.state!=='finishing'?'completed':live?'running':record.status==='failed'?'failed':'awaiting_input';
  const next={...job,status,progress:status==='completed'?100:null,message:status==='completed'?'即梦媒体已校验并保存到本机':status==='running'?'即梦'+(({preparing:'准备原编号查询',waiting:'等待下一次原编号查询',querying:'查询原任务',stopping:'正在停止',finishing:'正在保存查询收据'})[record.resultQueries?.state]||'正在执行本机工具'):record.resultQueries?.remaining===0?'原查询次数已用完；请在即梦原任务页单独确认查询，再同步结果':'原任务查询已暂停；继续只使用原剩余范围，不重新生成',requestCount:record.requestCount,queryCount:record.queryCount,upstreamId:record.upstreamId||null,assets:record.assets,resultQueries:record.resultQueries,uncertain:record.status==='uncertain'};
  if(!same(job,next))await atomicJson(file(job.id),next);return next;
 }
 // Restore a missing parent link only from its deterministic, already-saved
 // child receipt. Reading never starts generation or resumes result queries.
 async function recoverCanvasLinks(input){
  if(input.kind!=='canvas-run'||activeJobs.has(input.id))return input;
  const job=structuredClone(input),jobs=await records(path.join(data,'jobs'));
  for(const [index,step]of (job.steps||[]).entries()){
   if(step.kind!=='studio'||!isJimengStudio(step.studio))continue;
   const requestId=job.executionMode==='native-cascade'?'cascade-child-'+createHash('sha256').update(job.id+'|'+step.executionId).digest('hex'):job.id+'-'+index;
   const matches=jobs.filter(child=>child.kind==='studio'&&child.parentId===job.id&&child.projectId===job.projectId&&child.nodeId===step.nodeId&&child.requestId===requestId&&isJimengStudio(child.input?.studio));
   if(matches.length>1||step.jobId&&matches.length&&step.jobId!==matches[0].id)throw userError('即梦原子任务链接冲突，未自动选择',409);
   if(!matches.length)continue;const child=await refresh(matches[0]);step.jobId=child.id;step.jimengTaskId=child.jimengTaskId;step.resultQueries=child.resultQueries;
   if(job.executionMode==='native-cascade')for(const round of job.cascadeState.rounds)for(const receipt of round.receipts)if(receipt.operationId===step.executionId){
    if(receipt.childJobId&&receipt.childJobId!==child.id)throw userError('智能串联原子任务链接冲突，未自动选择',409);receipt.childJobId=child.id;
   }
  }
  return job;
 }
 async function monitor(job){
  const controller=new AbortController(),parent=activeJobs.get(job.parentId)?.controller.signal,abort=()=>controller.abort();parent?.addEventListener('abort',abort,{once:true});if(parent?.aborted)controller.abort();activeJobs.set(job.id,{kind:'studio',projectId:job.projectId,studioId:job.studioId,parentId:job.parentId,controller});
  try{for(;;){if(controller.signal.aborted){await tasks.cancel(job.jimengTaskId,job.projectId);break;}job=await refresh(await readJson(file(job.id)));if(!['queued','running'].includes(job.status))break;await sleep(pollInterval,undefined,{signal:controller.signal});}}
  catch{if(controller.signal.aborted)await tasks.cancel(job.jimengTaskId,job.projectId).catch(()=>{});}
  finally{parent?.removeEventListener('abort',abort);await refresh(await readJson(file(job.id))).catch(()=>{});activeJobs.delete(job.id);}
 }
 async function prepare(studio,context){
  if(!tasks)throw userError('即梦执行器尚未连接');const project=structuredClone(context?.project||await projects.load(studio.projectId)),references=[];
  for(const ref of studio.references){if(!ref.assetId||ref.url)throw userError('即梦仅发送本次工程的本机参考文件；外链需先导入');const asset=await loadAsset(data,ref.assetId);references.push(asset);if(!project.assets.some(a=>a.id===asset.id))project.assets.push(asset);}
  return{project,references,request:jimengStudioRequest(studio,references)};
 }
 async function preview(studio){const prepared=await prepare(studio);return{...await tasks.previewForStudio(prepared.project,{projectId:prepared.project.id,request:prepared.request,resultQueries:studio.config.jimeng.resultQueries},undefined,undefined,studio.id),revision:studio.revision};}
 async function start(studio,body,context){
  const {project,references,request}=await prepare(studio,context),original=references.some(a=>/^(video|audio)\//.test(a.type)),authorization=validateJimengStudioAuthorization(studio,body.authorization,{sendOriginalMedia:original});
  if(body.apiKey||body.credentialSource!=='jimeng-local'||body.credentialConsent!==true)throw userError('请明确使用即梦本机登录；不需要也不能发送API密钥');
  const plan=await tasks.previewForStudio(project,{projectId:project.id,request,resultQueries:studio.config.jimeng.resultQueries},context?.parentId,context?.nodeId,studio.id);
  if(!context&&body.scopeFingerprint!==plan.fingerprint)throw userError('即梦发送范围或程序已变化，请重新预览',409);
  for(const ref of body.referenceInputs||[])if(ref.sourceSha256!==plan.plan.media.find(a=>a.assetId===ref.assetId)?.sourceSha256)throw userError('已确认的即梦原参考文件变化，未执行',409);
  const id=randomUUID(),rawId='studio-'+createHash('sha256').update(id).digest('hex').slice(0,48),job={id,kind:'studio',studioId:studio.id,projectId:project.id,name:studio.name+' · 即梦',createdAt:new Date().toISOString(),status:'queued',progress:0,message:'即梦原请求已准备',assets:[],items:[],requestId:body.requestId,requestCount:0,input:{studio},authorization,billingStatus:'unknown',credentialSource:'jimeng-local',credentialProvider:'local-dreamina-login',jimengTaskId:rawId,...(context?{parentId:context.parentId,nodeId:context.nodeId}:{})};
  await atomicJson(file(id),job);
  const raw={projectId:project.id,requestId:rawId,request,fingerprint:plan.fingerprint,resultQueries:studio.config.jimeng.resultQueries,consent:true,authorization:{service:'local-dreamina-login',action:'generate',command:request.command,model:request.model,requestLimit:1,useLocalLogin:true,sendPrompt:!!request.prompt,sendOriginalMedia:references.length>0,budget:authorization.budget,currency:authorization.currency,consent:true,resultQueriesConsent:true}};
  try{await tasks.startForStudio(project,raw,context?.parentId,context?.nodeId,studio.id);}catch(error){await atomicJson(file(id),{...job,status:'interrupted',message:'即梦原请求未完整建立；请按记录核对，不会自动重发',uncertain:true});throw error;}
  void monitor(job);return refresh(job);
 }
 async function resume(job,body){
  if(body.credentialSource!=='jimeng-local'||body.credentialConsent!==true||body.queryConsent!==true||body.originalJobId!==job.id||typeof body.requestId!=='string')throw userError('请明确确认此即梦原任务的剩余查询范围');
  const r=await tasks.get(job.jimengTaskId,job.projectId);
  if(r.status!=='completed'&&r.resultQueries?.remaining>0)await tasks.continueResultQueries(r.id,{projectId:r.projectId,requestId:body.requestId,scopeFingerprint:r.resultQueries.scopeFingerprint,consent:true});
  const next=await refresh(job);if(next.status==='running')void monitor(next);return next;
 }
 async function cancel(job){await tasks.cancel(job.jimengTaskId,job.projectId);activeJobs.get(job.id)?.controller.abort();return refresh(job);}
 async function verify(job){if(!isJimengStudio(job.input?.studio))return job;const r=await tasks.verifyResults(job.jimengTaskId,job.projectId);if(!same(job.assets.map(a=>[a.id,a.sha256,a.type]),r.assets.map(a=>[a.id,a.sha256,a.type])))throw userError('创作台结果与即梦原收据不符，未回填',409);return job;}
 return{start,resume,cancel,refresh,preview,verify,recoverCanvasLinks};
}
