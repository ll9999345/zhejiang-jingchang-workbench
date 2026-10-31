import path from 'node:path';
import {promises as fs,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {atomicJson,readJson,records,safeId,userError,loadAsset,assertNoCredentials} from './workspace.mjs';
import {imageDimensions,cropImage} from './media-tools.mjs';
const stamp=()=>new Date().toISOString(),digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const types=new Set(['image/png','image/jpeg','image/webp','image/gif','image/avif','image/bmp']);
const active=new Set(['queued','running']),terminal=new Set(['completed','partial','failed','cancelled','interrupted']);
const validId=v=>{if(!safeId(v))throw userError('裁剪任务或素材编号无效');return v;};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
const cropEntryId=(id,n)=>'crop-'+createHash('sha256').update(id+'/'+n).digest('hex').slice(0,48);
const mark=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join('/');
export function libraryCropReceipt(j){
 const bad=()=>{throw userError('批量裁剪留痕无效');};
 if(!j||j.kind!=='library-crop'||!safeId(j.id)||j.requestId!==j.id||!safeId(j.projectId)||!active.has(j.status)&&!terminal.has(j.status)||!exact(j.snapshot,['projectId','mode','items'])||j.snapshot.projectId!==j.projectId||j.snapshot.mode!=='center-square'||j.signature!==digest(j.snapshot)||!Array.isArray(j.items)||!j.items.length||j.items.length>200||j.items.length!==j.snapshot.items?.length)bad();
 const seen=new Set();for(const [n,s]of j.snapshot.items.entries()){
  if(!exact(s,['sourceItemId','sourceAssetId','name','libraryId','folderId','type','size','sha256','width','height','crop'])||!['sourceItemId','sourceAssetId','libraryId','folderId'].every(k=>safeId(s[k]))||seen.has(s.sourceItemId)||!types.has(s.type)||typeof s.name!=='string'||!s.name.length||s.name.length>200||!Number.isSafeInteger(s.size)||s.size<1||s.size>150*1024**2||!(/^[a-f0-9]{64}$/).test(s.sha256)||![s.width,s.height].every(v=>Number.isSafeInteger(v)&&v>0)||s.width*s.height>16777216)bad();seen.add(s.sourceItemId);
  const side=Math.min(s.width,s.height),crop={x:Math.floor((s.width-side)/2),y:Math.floor((s.height-side)/2),width:side,height:side};if(JSON.stringify(s.crop)!==JSON.stringify(crop))bad();
  const i=j.items[n];if(i.sourceItemId!==s.sourceItemId||i.sourceAssetId!==s.sourceAssetId||i.entryId!==cropEntryId(j.id,n)||!['pending','cropping','ready','completed','failed'].includes(i.status)||!Number.isSafeInteger(i.attempt)||i.attempt<0)bad();if(i.asset&&(!safeId(i.asset.id)||i.asset.type!=='image/png'||!(/^[a-f0-9]{64}$/).test(i.asset.sha256)||!Number.isSafeInteger(i.asset.size)||i.asset.size<1||i.asset.width!==side||i.asset.height!==side||i.asset.sourceAssetId!==s.sourceAssetId||i.asset.operation!=='crop'||JSON.stringify(i.asset.crop)!==JSON.stringify(crop)))bad();if(['ready','completed'].includes(i.status)&&!i.asset)bad();
 }
 if(j.status==='completed'&&j.items.some(i=>i.status!=='completed'))bad();return j;
}
export function libraryCropService({data,activeJobs,catalog,projects,dimensions=imageDimensions,crop=cropImage}){
 const preparing=new Set(),locks=new Map();
 const serialized=(key,fn)=>{if(locks.has(key))throw userError('本批操作正在处理，请读取原编号',409);const p=Promise.resolve().then(fn);locks.set(key,p);return p.finally(()=>locks.delete(key));};
 const file=id=>path.join(data,'jobs',validId(id)+'.json');
 async function read(id,projectId){const j=await readJson(file(id));if(j.kind!=='library-crop'||j.projectId!==validId(projectId))throw userError('裁剪任务不存在',404);return libraryCropReceipt(j);}
 async function write(j){j.updatedAt=stamp();j.progress=Math.round(j.items.filter(i=>i.status==='completed').length/j.items.length*100);await atomicJson(file(j.id),libraryCropReceipt(j));}
 async function fingerprint(assetId){
  validId(assetId);const root=await fs.realpath(data),dir=path.join(root,'assets'),metaFile=path.join(dir,assetId+'.json'),source=path.join(dir,assetId);
  if(await fs.realpath(dir)!==dir||await fs.realpath(metaFile)!==metaFile||!(await fs.lstat(metaFile)).isFile()||(await fs.stat(metaFile)).size>1024**2||await fs.realpath(source)!==source)throw userError('裁剪只读取普通本机素材文件');
  const a=await loadAsset(root,assetId);if(a.id!==assetId||!types.has(a.type))throw userError('本批只支持PNG/JPEG/WebP/GIF/AVIF/BMP图片；请取消非图片选择');
  const h=await fs.open(source,constants.O_RDONLY|constants.O_NOFOLLOW);try{const before=await h.stat();if(!before.isFile()||before.size<1||before.size>150*1024**2||a.size!==before.size)throw userError('图片大小或记录已变化，请重新检查');const hash=createHash('sha256');for await(const b of h.createReadStream({autoClose:false}))hash.update(b);const after=await fs.lstat(source);if(mark(before)!==mark(after)||await fs.realpath(source)!==source)throw userError('图片在检查期间发生变化',409);return {asset:a,sha256:hash.digest('hex'),size:before.size};}finally{await h.close();}
 }
 async function preview(payload){
  assertNoCredentials(payload);const projectId=validId(payload.projectId);await projects.load(projectId);if(!Array.isArray(payload.ids)||!payload.ids.length||payload.ids.length>200||new Set(payload.ids).size!==payload.ids.length)throw userError('请选择1–200份不同的图片条目');
  const state=await catalog.read();if(payload.revision!==state.revision)throw userError('素材库已更新，请刷新后检查',409);
  let target;if(payload.libraryId!==undefined||payload.folderId!==undefined){validId(payload.libraryId);validId(payload.folderId);const l=state.libraries.find(l=>l.id===payload.libraryId&&!l.archived),f=l?.folders.find(f=>f.id===payload.folderId&&!f.archived&&f.type==='media');if(!f)throw userError('目标媒体分组不存在');target={libraryId:l.id,folderId:f.id};}
  const items=[];for(const itemId of payload.ids){const d=await catalog.details(validId(itemId));if(d.item.kind!=='media'||!d.asset?.type?.startsWith('image/'))throw userError('请只选择有效图片条目');const first=await fingerprint(d.item.assetId),size=await dimensions({data,assetId:d.item.assetId}),last=await fingerprint(d.item.assetId);if(first.sha256!==last.sha256||first.size!==last.size)throw userError('图片在检查期间发生变化',409);const side=Math.min(size.width,size.height);items.push({sourceItemId:itemId,sourceAssetId:d.item.assetId,name:d.item.name,libraryId:target?.libraryId||d.library.id,folderId:target?.folderId||d.folder.id,type:first.asset.type,size:first.size,sha256:first.sha256,width:size.width,height:size.height,crop:{x:Math.floor((size.width-side)/2),y:Math.floor((size.height-side)/2),width:side,height:side}});}
  if((await catalog.read()).revision!==state.revision)throw userError('素材库在检查期间更新，请重新检查',409);
  const plan={projectId,mode:'center-square',items};return {plan,fingerprint:digest(plan),revision:state.revision,localOnly:true,paidCalls:0};
 }
 async function get(id,projectId){let j=await read(id,projectId),live=activeJobs.get(id);if(!live){j=await read(id,projectId);live=activeJobs.get(id);}if(live?.kind==='library-crop'){const current=structuredClone(live.job);if(terminal.has(current.status)){current.status='running';current.message='图片处理已结束，正在保存批次原记录';}return current;}if(active.has(j.status)){j.status='interrupted';j.message='服务已中断；原图和已完成副本保留，明确继续才处理未完成项';}return j;}
 async function verifySource(s){const d=await catalog.details(s.sourceItemId);if(d.item.assetId!==s.sourceAssetId)throw userError('原条目已更换图片，请重新创建批次',409);const f=await fingerprint(s.sourceAssetId);if(f.sha256!==s.sha256||f.size!==s.size||f.asset.type!==s.type)throw userError('原图片已变化，本批不再处理此项',409);}
 async function verifyResult(i,s){const f=await fingerprint(i.asset.id);if(f.sha256!==i.asset.sha256||f.asset.width!==s.crop.width||f.asset.height!==s.crop.height||f.asset.sourceAssetId!==s.sourceAssetId)throw userError('裁剪副本已变化，保留原文件但不发布',409);}
 async function publish(j,i,s){await verifyResult(i,s);await catalog.publishCrop({jobId:j.id,entryId:i.entryId,sourceItemId:s.sourceItemId,sourceAssetId:s.sourceAssetId,assetId:i.asset.id,sha256:i.asset.sha256,libraryId:s.libraryId,folderId:s.folderId,name:(s.name.replace(/\.[^.]+$/,'').slice(0,180)||'图片')+'_crop.png'});i.status='completed';delete i.error;await write(j);}
 function launch(j){const controller=new AbortController();activeJobs.set(j.id,{kind:'library-crop',controller,projectId:j.projectId,job:j});Promise.resolve().then(async()=>{
  try{j.status='running';j.message='正在逐张居中裁剪；原图保留';await write(j);
   for(const [n,i]of j.items.entries()){if(i.status==='completed')continue;if(controller.signal.aborted)break;const s=j.snapshot.items[n];try{
    if(!i.asset){await verifySource(s);i.status='cropping';i.attempt++;delete i.error;await write(j);const a=await crop({data,assetId:s.sourceAssetId,...s.crop});const actual=await fingerprint(a.id);a.sha256=actual.sha256;a.name=(s.name.replace(/\.[^.]+$/,'').slice(0,180)||'图片')+'_crop.png';a.sourceJobId=j.id;await atomicJson(path.join(data,'assets',a.id+'.json'),a);i.asset=a;i.status='ready';await write(j);await verifySource(s);}
    await publish(j,i,s);
   }catch(error){i.status='failed';i.error=error.status?error.message:'本机图片裁剪未完成；原文件与已有副本保留';await write(j);}}
   const done=j.items.filter(i=>i.status==='completed').length;j.status=controller.signal.aborted?'cancelled':done===j.items.length?'completed':done?'partial':'failed';j.message=`已完成 ${done}/${j.items.length} 张；原图保留${controller.signal.aborted?'，已停止后续处理':''}`;await write(j);
  }catch{j.status='interrupted';j.message='本批中断，原文件与已完成副本保留；请读取原记录';await write(j).catch(()=>{});}finally{activeJobs.delete(j.id);}
 });}
 async function start(payload){const id=validId(payload.requestId);assertNoCredentials(payload);return serialized(id,async()=>{if(preparing.size>=1)throw userError('另一批图片正在检查，请稍后再试',429);preparing.add(id);try{
   try{const old=await readJson(file(id));if(old.kind!=='library-crop'||old.projectId!==payload.projectId||old.signature!==payload.fingerprint)throw userError('该编号已用于另一任务或范围',409);return get(id,payload.projectId);}catch(e){if(e.code!=='ENOENT')throw e;}
   if([...activeJobs.values()].some(j=>j.kind==='library-crop'))throw userError('已有一批裁剪正在进行，请先完成或停止',429);
   const p=await preview(payload);if(p.fingerprint!==payload.fingerprint)throw userError('原图片或目标范围已变化，请重新检查并确认',409);if(payload.consent!==true)throw userError('请检查图片、裁剪和目标分组并明确确认',409);
   const j={id,kind:'library-crop',requestId:id,projectId:payload.projectId,name:'素材库批量居中裁剪',signature:p.fingerprint,snapshot:p.plan,status:'queued',createdAt:stamp(),items:p.plan.items.map((s,n)=>({sourceItemId:s.sourceItemId,sourceAssetId:s.sourceAssetId,entryId:cropEntryId(id,n),status:'pending',attempt:0})),progress:0,message:'等待本机逐张裁剪'};await write(j);launch(j);return structuredClone(j);
  }finally{preparing.delete(id);}});}
 async function resume(id,payload){assertNoCredentials(payload);return serialized(id,async()=>{let j=await get(id,payload.projectId);if(activeJobs.has(id))return j;if(j.status==='completed')return j;if(payload.consent!==true)throw userError('请明确继续原批次的未完成图片');if(preparing.size||[...activeJobs.values()].some(j=>j.kind==='library-crop'))throw userError('已有一批裁剪正在进行或检查',429);for(const [n,i]of j.items.entries())if(i.status!=='completed'){await verifySource(j.snapshot.items[n]);if(i.asset)await verifyResult(i,j.snapshot.items[n]);}launch(j);return structuredClone(j);});}
 async function cancel(id,projectId){const j=await read(id,projectId);activeJobs.get(id)?.controller.abort();return get(id,projectId);}
 async function list(projectId){validId(projectId);return Promise.all((await records(path.join(data,'jobs'))).filter(j=>j.kind==='library-crop'&&j.projectId===projectId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(j=>get(j.id,projectId)));}
 async function recover(){for(const raw of await records(path.join(data,'jobs'))){if(raw.kind!=='library-crop')continue;const j=libraryCropReceipt(raw);if(active.has(j.status)){j.status='interrupted';j.message='服务重启，读取原副本；未自动重新裁剪';for(const i of j.items)if(i.status==='cropping')i.status='pending';await write(j);}}}
 async function apply(id,payload){assertNoCredentials(payload);return serialized(id,async()=>{const j=await get(id,payload.projectId);if(activeJobs.has(id)||active.has(j.status))throw userError('请先完成或停止本批再加入项目',409);const assets=j.items.filter(i=>i.status==='completed').map(i=>i.asset);if(!assets.length)throw userError('本批暂无完成副本');for(const [n,i]of j.items.entries())if(i.status==='completed')await verifyResult(i,j.snapshot.items[n]);return projects.attach(j,assets,payload.revision);});}
 return {preview,start,get,list,resume,cancel,recover,apply};
}
