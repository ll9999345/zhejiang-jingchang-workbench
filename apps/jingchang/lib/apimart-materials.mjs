import {MAX_STREAM_MEDIA_BYTES} from '../public/media-transfer-core.js';
import path from 'node:path';
import {promises as fs,constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {safeApiCall,validateApiBaseUrl} from './image-api.mjs';
import {safeId,userError,textValue} from './workspace.mjs';
import {inspectPublicMediaSource} from './public-media.mjs';
import {guardArchiveSecrets} from './task-history-schema.mjs';
import {apimartAssetUrl} from '../public/apimart-reference-core.js';

export const APIMART_MATERIAL_SOURCE='apimart-materials';
export const APIMART_MATERIAL_API='https://api.apimart.ai/v1';
const sha=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex'),stamp=()=>new Date().toISOString();
const bad=()=>userError('APIMart素材原记录损坏或范围不一致，请保留记录并检查；不会自动重提',409);
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const cloudId=v=>{if(typeof v!=='string'||!/^[-\w]{1,128}$/.test(v))throw bad();return v;};
const keys=(v,names)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>names.includes(k));
const local=u=>u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname);
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
function queryAuthorization(a,r){return keys(a,['origin','action','requestLimit','upstreamId','budget','currency','consent'])&&a?.origin===new URL(r.endpoint).origin&&a.action==='query'&&a.requestLimit===1&&a.upstreamId===r.upstreamId&&a.consent===true&&Number.isFinite(a.budget)&&a.budget>=0&&a.budget<=1e6&&['CNY','USD'].includes(a.currency);}
export function apimartMaterialEndpoint(value){const base=validateApiBaseUrl(value||APIMART_MATERIAL_API).replace(/\/$/,'');return /\/v1$/.test(base)?base:base+'/v1';}
function publicUrl(value,endpoint){const url=validateApiBaseUrl(value),u=new URL(url),e=new URL(endpoint);if(u.protocol!=='https:'&&!(local(e)&&u.origin===e.origin))throw userError('入库素材需要公网HTTPS地址；不会自动上传本机文件');return url;}
function validatePlan(p){
 if(!keys(p,['version','id','requestId','projectId','endpoint','cloudProject','name','assetType','groupName','groupId','sourceUrl','localSource','publicMediaId','fingerprint','authorization','createdAt'])||p.version!==1||![p.id,p.projectId].every(safeId)||p.requestId!==p.id||apimartMaterialEndpoint(p.endpoint)!==p.endpoint||!time(p.createdAt)||!['Image','Video','Audio'].includes(p.assetType)||typeof p.cloudProject!=='string'||!p.cloudProject.length||p.cloudProject.length>64||typeof p.name!=='string'||!p.name.length||p.name.length>60||typeof p.groupName!=='string'||p.groupName.length>60||p.groupId!==undefined&&!/^[-\w]{1,128}$/.test(p.groupId)||p.groupId&&p.groupName||publicUrl(p.sourceUrl,p.endpoint)!==p.sourceUrl)throw bad();
 if(p.localSource){const s=p.localSource;if(!keys(s,['assetId','name','type','size','sourceSha256'])||!safeId(s.assetId)||!Number.isSafeInteger(s.size)||s.size<1||s.size>MAX_STREAM_MEDIA_BYTES||! /^[a-f0-9]{64}$/.test(s.sourceSha256)||!String(s.type).startsWith({Image:'image/',Video:'video/',Audio:'audio/'}[p.assetType])||typeof s.name!=='string')throw bad();}
 if(p.publicMediaId!==undefined&&(!safeId(p.publicMediaId)||!p.localSource))throw bad();
 const auth=p.authorization;if(!keys(auth,['origin','action','requestLimit','sendPublicUrl','sendOriginalMedia','budget','currency','consent'])||auth?.origin!==new URL(p.endpoint).origin||auth.action!=='register'||auth.requestLimit!==1||auth.sendPublicUrl!==true||auth.sendOriginalMedia!==true||auth.consent!==true||!Number.isFinite(auth.budget)||auth.budget<0||auth.budget>1e6||!['CNY','USD'].includes(auth.currency)||!local(new URL(p.endpoint))&&auth.budget<=0)throw bad();
 const {version,id,requestId,fingerprint,authorization,createdAt,...content}=p;if(fingerprint!==sha(content))throw bad();guardArchiveSecrets(p);return p;
}
export function apimartMaterialRecord(value){
 const derived=['status','upstreamId','assetUri','checkedAt','queryCount','requestCount','message','taskStatus','queries'];if(!keys(value,['version','id','requestId','projectId','endpoint','cloudProject','name','assetType','groupName','groupId','sourceUrl','localSource','publicMediaId','fingerprint','authorization','createdAt',...derived]))throw bad();
 const plan=Object.fromEntries(Object.entries(value).filter(([k])=>!derived.includes(k)));validatePlan(plan);
 if(!['unsubmitted','submitting','Processing','Active','Failed','uncertain'].includes(value.status)||![0,1].includes(value.requestCount)||!Number.isInteger(value.queryCount)||value.queryCount<0||value.queryCount>1000||typeof value.message!=='string'||value.message.length>180||value.upstreamId!==undefined&&!/^[-\w]{1,128}$/.test(value.upstreamId)||value.checkedAt!==undefined&&!time(value.checkedAt)||value.assetUri!==undefined&&!apimartAssetUrl(value.assetUri)||value.taskStatus!==undefined&&(!['processing','pending','submitted','completed','failed','cancelled'].includes(value.taskStatus)))throw bad();
 if(!Array.isArray(value.queries)||value.queries.length!==value.queryCount)throw bad();const queryIds=new Set();for(let i=0;i<value.queries.length;i++){const q=value.queries[i];if(!keys(q,['number','requestId','createdAt','checkedAt','authorization','status','assetUri','taskStatus','message'])||q.number!==i+1||!safeId(q.requestId)||queryIds.has(q.requestId)||!time(q.createdAt)||!queryAuthorization(q.authorization,value)||q.checkedAt!==undefined&&!time(q.checkedAt)||!['Processing','Active','Failed','uncertain'].includes(q.status)||q.assetUri!==undefined&&!apimartAssetUrl(q.assetUri)||typeof q.message!=='string'||q.message.length>180||q.status==='Active'&&(!q.assetUri||!q.checkedAt)||q.assetUri&&q.status!=='Active')throw bad();queryIds.add(q.requestId);}
 const last=value.queries.at(-1);if(last&&['status','assetUri','checkedAt','message','taskStatus'].some(k=>value[k]!==last[k])||value.status==='Active'&&!last||['Processing','Active'].includes(value.status)&&!value.upstreamId)throw bad();
 if(value.status==='Active'&&(!value.upstreamId||!value.assetUri||!value.checkedAt)||value.assetUri&&value.status!=='Active')throw bad();guardArchiveSecrets(value);return structuredClone(value);
}

// Immutable complete files are published with no-overwrite links; .pending
// originals remain retained. Merely reading a ledger never performs an API call.
export function apimartMaterialStore(data){
 let base;
 async function directory(){const dir=await(base??=(async()=>{const root=await fs.realpath(data),dir=path.join(root,APIMART_MATERIAL_SOURCE);await fs.mkdir(dir,{recursive:true,mode:0o700});return dir;})());const st=await fs.lstat(dir);if(!st.isDirectory()||st.isSymbolicLink()||await fs.realpath(dir)!==dir)throw bad();return dir;}
 async function read(name,{missing=false}={}){let h;try{h=await fs.open(path.join(await directory(),name),constants.O_RDONLY|constants.O_NOFOLLOW);const st=await h.stat();if(!st.isFile()||st.size<1||st.size>128*1024)throw bad();return JSON.parse(await h.readFile('utf8'));}catch(e){if(e.code==='ENOENT'&&missing)return null;throw bad();}finally{await h?.close();}}
 async function publish(name,value){guardArchiveSecrets(value);const encoded=JSON.stringify(value);if(Buffer.byteLength(encoded)>128*1024)throw bad();const dir=await directory(),tmp=path.join(dir,name+'.pending-'+randomUUID());let h;try{h=await fs.open(tmp,'wx',0o600);await h.writeFile(encoded);await h.sync();await h.close();h=null;await directory();await fs.link(tmp,path.join(dir,name));const d=await fs.open(dir,'r');try{await d.sync();}finally{await d.close();}}finally{await h?.close();}}
 async function ids(){return(await fs.readdir(await directory())).filter(n=>/^[\w-]+\.json$/.test(n)).map(n=>n.slice(0,-5));}
 return{directory,read,publish,ids};
}
const runtimes=new Map();
function parseReview(raw,upstreamId,key){
 const d=raw?.data;if(raw?.code!==200||!d||d.id!==upstreamId)throw bad();
 const taskStatus=String(d.status||'').toLowerCase();if(['pending','processing','submitted'].includes(taskStatus))return{status:'Processing',taskStatus,message:'平台审核中；再次查询需要单独确认'};
 if(!['completed','failed','cancelled'].includes(taskStatus))throw bad();
 const result=d.result||{},usable=Array.isArray(result.usable_assets)?result.usable_assets:Array.isArray(result.assets)?result.assets.filter(a=>a.status==='Active'):[];
 if(usable.length===1&&usable[0].status==='Active'){
  const a=usable[0],uri=a.asset_url||a.assetUrl||a.uri||(a.asset_id?'asset://'+a.asset_id:'');
  if(!apimartAssetUrl(uri)||a.asset_id&&uri!=='asset://'+a.asset_id||key&&uri.includes(key))throw bad();
  return{status:'Active',taskStatus,assetUri:uri,message:taskStatus==='failed'?'任务报告部分失败；本项在平台可用素材列表中':'平台返回本项可用，引用仍受账户和平台权限限制'};
 }
 if(usable.length)throw bad();return{status:'Failed',taskStatus,message:taskStatus==='completed'?'审核结束但没有本项唯一可用素材，请在平台核对':'本项未通过审核；原任务不会重新提交'};
}
export function apimartMaterialService({data,projects,publicMedia,apiCall=safeApiCall}){
 const store=apimartMaterialStore(data),runtimeKey=id=>path.resolve(data)+':'+id;
 async function preview(b){
  if(!safeId(b.projectId))throw userError('项目编号无效');const p=await projects.load(b.projectId),endpoint=apimartMaterialEndpoint(b.endpoint),plan={projectId:p.id,endpoint,cloudProject:textValue(b.cloudProject||'default',64,'平台项目'),name:textValue(b.name,60,'素材名称'),assetType:b.assetType,groupName:b.groupId?'':textValue(b.groupName||b.name,60,'素材组名称'),...(b.groupId?{groupId:cloudId(b.groupId)}:{}),sourceUrl:publicUrl(b.sourceUrl,endpoint)};
  if(!['Image','Video','Audio'].includes(plan.assetType))throw userError('请选择图片、视频或音频');
  if(b.localAssetId){if(!p.assets.some(a=>a.id===b.localAssetId)&&!b.publicMediaId)throw userError('本机素材须属于当前项目或本项目已授权的上传记录');plan.localSource=await inspectPublicMediaSource(data,b.localAssetId,MAX_STREAM_MEDIA_BYTES);if(!plan.localSource.type.startsWith({Image:'image/',Video:'video/',Audio:'audio/'}[plan.assetType]))throw userError('本机素材与入库类型不符');}
  if(b.publicMediaId){if(!plan.localSource||!publicMedia)throw userError('上传记录需关联本机原文件');const r=await publicMedia.reference(b.publicMediaId,p.id);if(r.purpose!=='apimart-material'||r.url!==plan.sourceUrl||r.source.sourceSha256!==plan.localSource.sourceSha256||r.source.assetId!==plan.localSource.assetId)throw userError('上传用途、链接或原文件指纹不匹配');plan.publicMediaId=r.id;}
  guardArchiveSecrets(plan);return{...plan,fingerprint:sha(plan),remoteContentUnverified:true};
 }
 async function manifest(id){if(!safeId(id))throw userError('素材请求编号无效');const p=await store.read(id+'.json',{missing:true});if(!p)throw userError('没有这条APIMart素材原记录',404);if(p.id!==id)throw bad();return validatePlan(p);}
 async function marker(id,name){const allowed=name.startsWith('query-intent-')?['authorization','requestId']:name.startsWith('query-')?['status','assetUri','message','taskStatus']:name==='submitted'?['upstreamId']:[];const v=await store.read(id+'.'+name+'.json',{missing:true});if(v){if(!keys(v,['id','createdAt','pid',...allowed])||v.id!==id||!time(v.createdAt)||v.pid!==undefined&&(!Number.isInteger(v.pid)||v.pid<1))throw bad();guardArchiveSecrets(v);}return v;}
 async function get(id,projectId){
  const p=await manifest(id);if(p.projectId!==projectId)throw userError('素材记录不属于当前项目',403);const intent=await marker(id,'intent'),submitted=await marker(id,'submitted'),rejected=await marker(id,'rejected'),finished=await marker(id,'finished'),stopped=await marker(id,'stopped');let r={...p,status:intent?'uncertain':'unsubmitted',requestCount:intent?1:0,queryCount:0,message:intent?'提交结果不确定，请先在平台核对；不会自动重提':'本次尚未提交；读取记录不会恢复发送'};
  if(!stopped&&(runtimes.has(runtimeKey(id))||intent?.pid&&intent.pid!==process.pid&&alive(intent.pid)&&!finished)&&!submitted&&!rejected)Object.assign(r,{status:'submitting',message:'本机正在等待注册返回'});
  if(rejected)Object.assign(r,{status:'Failed',message:'平台明确拒绝本次注册；原编号不会重新提交'});
  if(submitted)Object.assign(r,{status:'Processing',upstreamId:cloudId(submitted.upstreamId),message:'已保存注册任务编号；查询原任务不会重新注册'});
  const names=await fs.readdir(await store.directory()),queries=names.filter(n=>n.startsWith(id+'.query-intent-')&&/\.json$/.test(n));r.queryCount=queries.length;r.queries=[];if(r.queryCount>1000)throw bad();
  for(let number=1;number<=queries.length;number++){const intent=await marker(id,'query-intent-'+number),q=await marker(id,'query-'+number);if(!intent||!safeId(intent.requestId)||!queryAuthorization(intent.authorization,r))throw bad();const result=q?{status:q.status,message:q.message,checkedAt:q.createdAt,...(q.assetUri?{assetUri:q.assetUri}:{}),...(q.taskStatus?{taskStatus:q.taskStatus}:{})}:{status:'uncertain',message:'原任务查询未完整保存，可单独确认后再查原编号，不会重新注册'};delete r.assetUri;delete r.taskStatus;delete r.checkedAt;Object.assign(r,result);r.queries.push({number,requestId:intent.requestId,createdAt:intent.createdAt,authorization:intent.authorization,...result});}
  return apimartMaterialRecord(r);
 }
 async function list(projectId){if(!safeId(projectId))throw userError('项目编号无效');await projects.load(projectId);const rows=[];for(const id of await store.ids()){const m=await manifest(id);if(m.projectId===projectId)rows.push(await get(id,projectId));}return rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
 function key(b){if(typeof b.apiKey!=='string'||b.apiKey.length>4096||/[\r\n]/.test(b.apiKey))throw userError('请提供仅本次使用的API Key');const k=b.apiKey.trim();return k;}
 async function start(b){let apiKey='';try{
  const id=b.requestId;if(!safeId(id))throw userError('请提供固定请求编号');const plan=await preview(b);if(plan.fingerprint!==b.fingerprint||b.consent!==true)throw userError('请重新预览并确认这份素材及服务范围');apiKey=key(b);if(!local(new URL(plan.endpoint))&&!apiKey)throw userError('远程服务需要本次API Key');
  const {remoteContentUnverified,...content}=plan,p=validatePlan({version:1,id,requestId:id,...content,authorization:structuredClone(b.authorization),createdAt:stamp()});if(apiKey&&JSON.stringify(p).includes(apiKey))throw userError('素材信息包含本次密钥，已拒绝保存与发送');
  try{await store.publish(id+'.json',p);}catch(e){if(e.code!=='EEXIST')throw e;const previous=await manifest(id);p.createdAt=previous.createdAt;if(!isDeepStrictEqual(p,previous))throw userError('同一请求编号的素材、地址或授权已变化',409);return get(id,p.projectId);}
  const controller=new AbortController(),entry={controller};runtimes.set(runtimeKey(id),entry);const transientKey=apiKey;apiKey='';
  entry.promise=(async()=>{let secret=transientKey;try{if(await marker(id,'stopped'))return;await store.publish(id+'.intent.json',{id,createdAt:stamp(),pid:process.pid});if(await marker(id,'stopped'))return;const body={project_name:p.cloudProject,asset_type:p.assetType,...(p.groupId?{group_id:p.groupId}:{group:{name:p.groupName}}),assets:[{url:p.sourceUrl,name:p.name}]};const result=await apiCall({baseUrl:p.endpoint,path:'seedance2/private-avatar',method:'POST',apiKey:secret,body,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120000)])});
    const upstreamId=cloudId(result?.data?.id||'');if(result.code!==200||secret&&upstreamId.includes(secret))throw bad();await store.publish(id+'.submitted.json',{id,upstreamId,createdAt:stamp()});
   }catch(e){if(Number.isInteger(e.upstreamStatus)&&e.upstreamStatus>=400&&e.upstreamStatus<500||e.uncertain===false)await store.publish(id+'.rejected.json',{id,createdAt:stamp()}).catch(()=>{});}
   finally{secret='';await store.publish(id+'.finished.json',{id,createdAt:stamp()}).catch(()=>{});if(runtimes.get(runtimeKey(id))===entry)runtimes.delete(runtimeKey(id));}})();entry.promise.catch(()=>{});return get(id,p.projectId);
 }finally{apiKey='';b.apiKey='';}}
 async function query(id,b){let secret='';try{
  const r=await get(id,b.projectId);if(!r.upstreamId)throw userError('没有原注册任务编号，不能查询；请先在平台核对，不能自动重提',409);secret=key(b);const a=b.authorization;
  if(b.consent!==true||!queryAuthorization(a,r)||!local(new URL(r.endpoint))&&!secret)throw userError('请确认向原服务查询一次原注册任务');
  if(!safeId(b.requestId))throw userError('请为本次查询提供固定请求编号');const previousRequest=r.queries.find(q=>q.requestId===b.requestId);if(previousRequest){if(!isDeepStrictEqual(previousRequest.authorization,a))throw userError('同一查询编号的服务、任务或预算范围已变化',409);return r;}
  if(r.queryCount>=1000)throw userError('本机原任务查询记录达到1000次上限',409);const number=r.queryCount+1;
  if(r.queryCount){const previous=await marker(id,'query-intent-'+r.queryCount),done=await marker(id,'query-'+r.queryCount);if(previous&&!done&&alive(previous.pid))throw userError('上一次原任务查询仍在等待，请稍后读取记录',409);}
  if(secret&&JSON.stringify(a).includes(secret))throw userError('查询范围中含本次密钥，请移除后继续');guardArchiveSecrets(a);
  try{await store.publish(id+'.query-intent-'+number+'.json',{id,requestId:b.requestId,createdAt:stamp(),pid:process.pid,authorization:structuredClone(a)});}catch(e){if(e.code==='EEXIST'){const existing=await get(id,b.projectId),same=existing.queries.find(q=>q.requestId===b.requestId);if(same&&isDeepStrictEqual(same.authorization,a))return existing;throw userError('另一个查询已使用本次编号，请读取记录后再确认',409);}throw e;}
  let result;try{const raw=await apiCall({baseUrl:r.endpoint,path:'tasks/'+r.upstreamId,apiKey:secret,signal:AbortSignal.timeout(60000)});result=parseReview(raw,r.upstreamId,secret);}catch{result={status:'uncertain',message:'这次查询未能确认唯一可用结果；可重新确认后只查原任务，不会重新注册'};}
  await store.publish(id+'.query-'+number+'.json',{id,createdAt:stamp(),...result});return get(id,b.projectId);
 }finally{secret='';b.apiKey='';}}
 async function cancel(id,projectId){const r=await get(id,projectId);if(r.status!=='submitting')return r;try{await store.publish(id+'.stopped.json',{id,createdAt:stamp()});}catch(e){if(e.code!=='EEXIST')throw e;}runtimes.get(runtimeKey(id))?.controller.abort();return get(id,projectId);}
 async function history(id,projectId){const r=await get(id,projectId);if(r.status==='submitting')throw userError('素材注册仍在提交，请先结束本机等待',409);return r;}
 return{preview,start,query,get,list,cancel,history,store};
}
