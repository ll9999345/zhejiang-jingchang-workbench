import path from 'node:path';
import {promises as fs,constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {safeId,userError,loadAsset} from './workspace.mjs';
import {chatReferenceParts} from './chat-media.mjs';
import {validateApiBaseUrl} from './image-api.mjs';
import {normalizeMiaoCredential} from './miao-credentials.mjs';
import {DEFAULT_ASSET_CLASSIFICATION_PROMPT} from './asset-classification.mjs';
import {assetClassificationReceiptStore} from './asset-classification-receipts.mjs';
import {guardArchiveSecrets} from './task-history-schema.mjs';

export const CLASSIFICATION_BATCH_SOURCE='classification-batches';
const sha=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const stamp=()=>new Date().toISOString();
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const fail=()=>userError('批量分类记录损坏或范围不一致，已停止发送；请保留原记录',409);
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
const live=new Map();
const types=['image/png','image/jpeg','image/webp'];
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.slice().sort().join(',');
function validateManifest(m){
 if(!exact(m,['version','kind','id','projectId','sourceImportId','createdAt','planDigest','items','platform','model','promptDigest','authorization'])||m.version!==1||m.kind!=='asset-classification-batch'||![m.id,m.projectId,m.sourceImportId].every(safeId)||!time(m.createdAt)||!hash(m.planDigest)||!hash(m.promptDigest)||!Array.isArray(m.items)||!m.items.length||m.items.length>200)throw fail();
 const ids=new Set();for(const item of m.items){if(!exact(item,['assetId','requestId','name','media'])||!safeId(item.assetId)||!safeId(item.requestId)||ids.has(item.assetId)||item.requestId!=='bc-'+sha(m.id+':'+item.assetId).slice(0,48)||typeof item.name!=='string'||!item.name.length||item.name.length>300||!exact(item.media,['sha256','type','size'])||!hash(item.media.sha256)||!types.includes(item.media.type)||!Number.isSafeInteger(item.media.size)||item.media.size<1||item.media.size>10*1024**2)throw fail();ids.add(item.assetId);}
 if(m.planDigest!==sha({projectId:m.projectId,sourceImportId:m.sourceImportId,items:m.items.map(({assetId,name,media})=>({assetId,name,media}))}))throw fail();
 const p=m.platform,a=m.authorization;
 if(!exact(p,['id','origin','protocol','baseUrlDigest'])||!safeId(p.id)||p.protocol!=='openai-compatible'||!hash(p.baseUrlDigest)||typeof p.origin!=='string'||!/^https?:\/\//.test(p.origin)||new URL(p.origin).origin!==p.origin||typeof m.model!=='string'||!m.model.trim()||m.model.length>200)throw fail();
 if(!exact(a,['origin','model','sendImage','requestLimit','budget','currency','consent'])||a.origin!==p.origin||a.model!==m.model||a.sendImage!==true||a.requestLimit!==m.items.length||a.consent!==true||!Number.isFinite(a.budget)||a.budget<0||a.budget>1e6||!['CNY','USD'].includes(a.currency))throw fail();
 const u=new URL(p.origin);if(!(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname))&&a.budget<=0)throw fail();
 guardArchiveSecrets(m);return m;
}

// Immutable manifest and numbered run claims. A new process never infers send
// permission from a saved row: only start/resume with fresh transient credentials
// launches work. Child receipts decide which images have already been attempted.
export function classificationBatchStore(data){
 let dirPromise;
 async function directory(){return dirPromise??=(async()=>{const root=await fs.realpath(data),dir=path.join(root,CLASSIFICATION_BATCH_SOURCE);await fs.mkdir(dir,{recursive:true,mode:0o700});if(await fs.realpath(dir)!==dir||(await fs.lstat(dir)).isSymbolicLink())throw fail();return dir;})();}
 async function readFile(name,{missing=false}={}){
  const file=path.join(await directory(),name);let h;
  try{h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const s=await h.stat();if(!s.isFile()||s.size<1||s.size>1024**2)throw fail();return JSON.parse(await h.readFile('utf8'));}catch(e){if(e.code==='ENOENT'&&missing)return null;throw fail();}finally{await h?.close();}
 }
 async function publish(name,value){
  const dir=await directory(),tmp=path.join(dir,name+'.pending-'+randomUUID());let h;
  try{h=await fs.open(tmp,'wx',0o600);await h.writeFile(JSON.stringify(value));await h.sync();await h.close();h=null;await fs.link(tmp,path.join(dir,name));const d=await fs.open(dir,'r');try{await d.sync();}finally{await d.close();}}finally{await h?.close();}
 }
 async function read(id){if(!safeId(id))throw userError('批量分类编号无效');const m=await readFile(id+'.json',{missing:true});if(!m)throw userError('找不到批量分类记录',404);if(m.id!==id)throw fail();return validateManifest(m);}
 async function ids(){return (await fs.readdir(await directory())).filter(n=>/^[\w-]+\.json$/.test(n)).map(n=>n.slice(0,-5));}
 async function runs(id){const names=(await fs.readdir(await directory())).filter(n=>n.startsWith(id+'.run-')&&/\.json$/.test(n));const rows=[];for(const name of names){const r=await readFile(name);if(!exact(r,['batchId','number','pid','createdAt'])||r.batchId!==id||!Number.isSafeInteger(r.number)||r.number<1||r.number>1000||!Number.isSafeInteger(r.pid)||r.pid<1||!time(r.createdAt)||name!==id+'.run-'+r.number+'.json')throw fail();const end=await readFile(id+'.end-'+r.number+'.json',{missing:true}),stop=await readFile(id+'.stop-'+r.number+'.json',{missing:true});for(const marker of [end,stop])if(marker&&(!exact(marker,['batchId','number','createdAt'])||marker.batchId!==id||marker.number!==r.number||!time(marker.createdAt)))throw fail();rows.push({...r,end,stop});}return rows.sort((a,b)=>a.number-b.number);}
 async function marker(id,kind,number){try{await publish(id+'.'+kind+'-'+number+'.json',{batchId:id,number,createdAt:stamp()});}catch(e){if(e.code!=='EEXIST')throw e;}}
 return{directory,read,ids,runs,publish,marker};
}

// Portable batch history never contains owner PID, credentials, raw prompts or
// executable permission. Importing this object cannot instantiate a live batch.
export function classificationBatchHistory(value,{projectId}={}){
 if(!exact(value,['manifest','status','items','runs'])||!['completed','stopped','interrupted','failed','uncertain'].includes(value.status))throw fail();
 const m=validateManifest(value.manifest);if(projectId&&m.projectId!==projectId||!Array.isArray(value.items)||value.items.length!==m.items.length||!Array.isArray(value.runs)||value.runs.length>1000)throw fail();
 for(let i=0;i<value.items.length;i++){const item=value.items[i],original=m.items[i];if(!exact(item,['assetId','requestId','status'])||item.assetId!==original.assetId||item.requestId!==original.requestId||!['unsent','completed','failed','cancelled','uncertain'].includes(item.status))throw fail();}
 for(let i=0;i<value.runs.length;i++){const r=value.runs[i];if(!exact(r,['number','createdAt','endedAt','stoppedAt'])||r.number!==i+1||!time(r.createdAt)||r.endedAt!==null&&!time(r.endedAt)||r.stoppedAt!==null&&!time(r.stoppedAt))throw fail();}
 const expected=value.items.some(i=>i.status==='uncertain')?'uncertain':value.items.every(i=>i.status==='completed')?'completed':value.runs.at(-1)?.stoppedAt?'stopped':value.items.some(i=>i.status==='failed')?'failed':'interrupted';
 if(value.status!==expected)throw fail();guardArchiveSecrets(value);return structuredClone(value);
}

export function classificationBatchService({data,sharedFolders,platforms,classifier}){
 const store=classificationBatchStore(data),children=assetClassificationReceiptStore(data),key=id=>path.resolve(data)+':'+id;
 async function preview({projectId,sourceImportId,assetIds}={}){
  if(!safeId(projectId)||!safeId(sourceImportId))throw userError('请选择当前项目的共享文件夹导入记录');
  const source=await sharedFolders.get(sourceImportId,projectId);if(['queued','running'].includes(source.status))throw userError('请先停止或完成本机导入，再确认分类范围',409);
  const complete=source.items.filter(i=>i.status==='completed'&&i.asset),available=new Map(complete.map(i=>[i.asset.id,i.asset]));
  if(assetIds!==undefined&&(!Array.isArray(assetIds)||!assetIds.length||assetIds.length>200||assetIds.some(id=>!safeId(id)||!available.has(id))||new Set(assetIds).size!==assetIds.length))throw userError('分类范围须为本批已完成副本，最多200张且不能重复');
  const chosen=assetIds??[...available.keys()],items=[],skipped=[];
  for(const assetId of chosen){const a=await loadAsset(data,assetId);if(!types.includes(a.type)||!Number.isSafeInteger(a.size)||a.size<1||a.size>10*1024**2){skipped.push({assetId,name:a.name,reason:'仅支持1字节至10MB的PNG/JPEG/WebP图片'});continue;}const part=(await chatReferenceParts({data,assetIds:[assetId]})).parts[0];if(part?.type!=='image_url')throw userError('导入副本无法读取',409);const url=part.image_url.url,bytes=Buffer.from(url.slice(url.indexOf(',')+1),'base64');items.push({assetId,name:a.name,media:{sha256:createHash('sha256').update(bytes).digest('hex'),type:a.type,size:bytes.length}});}
  const plan={projectId,sourceImportId,items};return{...plan,planDigest:sha(plan),skipped};
 }
 async function get(id,projectId){
  const m=await store.read(id);if(!safeId(projectId)||m.projectId!==projectId)throw userError('批量分类不属于当前项目',403);
  const items=[];for(const item of m.items){const row=await children.read(item.requestId,{missing:true});if(row&&(row.assetId!==item.assetId||row.projectId!==m.projectId||!isDeepStrictEqual(row.media,item.media)||!isDeepStrictEqual(row.platform,m.platform)||row.model!==m.model||row.promptDigest!==m.promptDigest||row.authorization.budget!==m.authorization.budget/m.items.length||row.authorization.currency!==m.authorization.currency))throw fail();items.push({...item,status:row?.status||'unsent',...(row?{task:children.visible(row)}:{})});}
  const runs=await store.runs(id),last=runs.at(-1),active=!!last&&!last.end&&alive(last.pid),unknown=items.some(i=>i.status==='uncertain'),pending=items.some(i=>['queued','sending'].includes(i.status));
  const status=active?'running':unknown?'uncertain':pending?'interrupted':items.every(i=>i.status==='completed')?'completed':last?.stop?'stopped':items.some(i=>i.status==='failed')?'failed':'interrupted';
  return{...m,status,items,runs:runs.map(r=>({number:r.number,createdAt:r.createdAt,endedAt:r.end?.createdAt||null,stoppedAt:r.stop?.createdAt||null})),counts:Object.fromEntries(['unsent','queued','sending','completed','failed','cancelled','uncertain'].map(s=>[s,items.filter(i=>i.status===s).length])),canResume:!active&&!unknown&&!pending&&items.some(i=>i.status==='unsent')&&runs.length<1000};
 }
 async function prepare(body,id){
  if(!safeId(id)||body.consent!==true)throw userError('请确认本批图片、服务、模型、次数和总预算');
  const plan=await preview(body);if(!plan.items.length||plan.skipped.length||body.planDigest!==plan.planDigest)throw userError('图片范围或副本已变化，请重新检查清单后确认',409);
  const p=await platforms.get(body.platformId),baseUrl=validateApiBaseUrl(p.baseUrl),origin=new URL(baseUrl).origin;
  if(p.protocol!=='openai-compatible'||!p.models.some(m=>m.id===body.model&&m.category==='chat'&&m.referenceSupport===true))throw userError('请选择已开启图片输入的OpenAI兼容对话模型');
  normalizeMiaoCredential(body,p);
  if(body.prompt!==undefined&&(typeof body.prompt!=='string'||body.prompt.length>4000))throw userError('分类说明不能超过4000字');
  const extra=String(body.prompt||'').trim(),prompt=DEFAULT_ASSET_CLASSIFICATION_PROMPT+(extra?'\n\n用户补充的分类要求：\n'+extra:'');
  return validateManifest({version:1,kind:'asset-classification-batch',id,projectId:plan.projectId,sourceImportId:plan.sourceImportId,createdAt:stamp(),planDigest:plan.planDigest,items:plan.items.map(i=>({assetId:i.assetId,requestId:'bc-'+sha(id+':'+i.assetId).slice(0,48),name:i.name,media:i.media})),platform:{id:p.id,origin,protocol:p.protocol,baseUrlDigest:sha(baseUrl)},model:body.model,promptDigest:sha(prompt),authorization:structuredClone(body.authorization)});
 }
 async function launch(m,body,number){
  if(number>1000)throw userError('批次继续次数已达上限',409);
  // Atomic no-overwrite claim serializes real processes and duplicate clicks.
  await store.publish(m.id+'.run-'+number+'.json',{batchId:m.id,number,pid:process.pid,createdAt:stamp()});
  const controller=new AbortController(),entry={controller};live.set(key(m.id),entry);
  const credentials={apiKey:body.apiKey??'',...(body.credentialSource?{credentialSource:body.credentialSource,credentialConsent:body.credentialConsent}:{})},prompt=body.prompt||'';
  entry.promise=(async()=>{
   try{
    for(const item of m.items){
     const run=(await store.runs(m.id)).at(-1);if(run.number!==number||run.stop||controller.signal.aborted)break;
     const old=await children.read(item.requestId,{missing:true});if(old){if(['queued','sending','uncertain'].includes(old.status))break;continue;}
     // The classifier hashes this image and snapshots the saved service itself,
     // comparing both against the confirmed manifest before any send. Do not
     // reread the entire 200-image selection for every individual request.
     const request={projectId:m.projectId,requestId:item.requestId,platformId:m.platform.id,model:m.model,prompt,...credentials,consent:true,authorization:{...m.authorization,requestLimit:1,budget:m.authorization.budget/m.items.length}};
     try{await classifier.classify(item.assetId,request,{expectedBinding:{media:item.media,platform:m.platform,promptDigest:m.promptDigest},signal:controller.signal,beforeSend:async()=>{if((await store.runs(m.id)).at(-1).stop)throw userError('批量分类已停止',409);}});}finally{request.apiKey='';}
    }
   }catch{/* Child receipts retain the outcome; no exception text or key is persisted. */}
   finally{credentials.apiKey='';body.apiKey='';body.prompt='';try{await store.marker(m.id,'end',number);}finally{if(live.get(key(m.id))===entry)live.delete(key(m.id));}}
  })();
  // Avoid leaking an unhandled rejection if local disk becomes unavailable.
  entry.promise.catch(()=>{});return get(m.id,m.projectId);
 }
 async function start(body){
  const id=body.requestId;if(!safeId(id))throw userError('请提供固定批量请求编号');
  try{const m=await prepare(body,id);try{await store.publish(id+'.json',m);}catch(e){if(e.code!=='EEXIST')throw e;const original=await store.read(id);m.createdAt=original.createdAt;if(!isDeepStrictEqual(m,original))throw userError('同一批量编号的图片或授权已变化，已拒绝发送',409);return get(id,m.projectId);}return await launch(m,{...body},1);}finally{body.apiKey='';}
 }
 async function resume(id,body){
  try{const original=await store.read(id),row=await get(id,body.projectId);if(!row.canResume||body.resumeUnsent!==true)throw userError('仅可在重新确认后继续未发送项；不确定结果须先在平台核对',409);const fresh=await prepare({...body,requestId:id},id);fresh.createdAt=original.createdAt;if(!isDeepStrictEqual(fresh,original))throw userError('图片、服务、说明或原预算范围已变化，不能继续本批',409);return await launch(original,{...body},row.runs.length+1);}finally{body.apiKey='';}
 }
 async function cancel(id,projectId){
  const row=await get(id,projectId),runs=await store.runs(id),run=runs.at(-1);if(!run||row.status!=='running')return row;
  await store.marker(id,'stop',run.number);live.get(key(id))?.controller.abort();
  for(const item of row.items){try{const current=await children.read(item.requestId,{missing:true});if(current&&['queued','sending'].includes(current.status))await classifier.cancel(item.requestId);}catch(e){if(e.status!==404)throw e;}}
  return get(id,projectId);
 }
 async function list({projectId,sourceImportId}={}){if(!safeId(projectId)||sourceImportId!==undefined&&!safeId(sourceImportId))throw userError('项目或导入编号无效');const result=[];for(const id of await store.ids()){const m=await store.read(id);if(m.projectId===projectId&&(!sourceImportId||m.sourceImportId===sourceImportId))result.push(await get(id,projectId));}return result.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
 async function apply(id,projectId){const row=await get(id,projectId);if(row.status==='running')throw userError('请等本批完成或停止后核对回填',409);let applied=0;for(const item of row.items)if(item.status==='completed'){await classifier.applyReceipt(item.requestId);applied++;}return{batch:await get(id,projectId),applied};}
 async function history(id,projectId){const row=await get(id,projectId);if(row.status==='running'||row.items.some(i=>['queued','sending'].includes(i.status)))throw userError('批量分类仍在执行，请先完成或停止后归档',409);const manifest=await store.read(id);return classificationBatchHistory({manifest,status:row.status,items:row.items.map(i=>({assetId:i.assetId,requestId:i.requestId,status:i.status})),runs:row.runs},{projectId});}
 return{preview,start,resume,cancel,list,get,history,store,apply};
}
