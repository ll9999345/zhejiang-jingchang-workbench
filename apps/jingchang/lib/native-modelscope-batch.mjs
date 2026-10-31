import {setTimeout as delay} from 'node:timers/promises';
import {studioRequestCount} from '../public/native-modelscope-core.js';
import {assertNoCredentials,safeId,userError} from './workspace.mjs';

const statuses=new Set(['unsubmitted','submitting','pending','completed','failed']);
const upstreamId=value=>typeof value==='string'&&/^[-\w]{1,128}$/.test(value);
export function isNativeModelscopeJob(job){return job?.kind==='studio'&&job.input?.studio?.config?.protocol==='modelscope'&&job.input.studio.config.nativeModelscope!==undefined;}
export function validateNativeModelscopeBatch(job){
 if(!isNativeModelscopeJob(job))throw userError('不是原生 ModelScope 多份任务');
 const count=studioRequestCount(job.input.studio),c=job.input.studio.config,a=job.authorization;assertNoCredentials(job.input);
 let origin;try{origin=new URL(c.baseUrl).origin;}catch{throw userError('原生 ModelScope 服务收据缺失');}
 if(a?.origin!==origin||a?.model!==c.model||a?.currency!==c.currency||a?.sendPrompt!==true||a?.sendReferences!==(job.input.studio.references.length>0)||!Number.isFinite(a?.budget)||a.budget<=0)throw userError('原生 ModelScope 服务、模型、素材或预算授权收据不一致');
 if(job.authorization?.requestLimit!==count||!Array.isArray(job.items)||job.items.length!==count||!Number.isSafeInteger(job.requestCount)||job.requestCount<0||job.requestCount>count)throw userError('原生 ModelScope 份数、授权或尝试收据不完整，不会重新提交');
 const seen=new Set();for(const [index,item]of job.items.entries()){
  if(item.index!==index||!statuses.has(item.status)||!Array.isArray(item.assets)||item.assets.length>1
   ||item.upstreamId!==undefined&&!upstreamId(item.upstreamId)||['pending','completed'].includes(item.status)&&!item.upstreamId
   ||item.status==='unsubmitted'&&item.upstreamId||item.status!=='completed'&&item.assets.length||item.status==='completed'&&item.assets.length!==1
   ||item.assets.some(a=>!safeId(a.id)||!a.type?.startsWith('image/')))throw userError('原生 ModelScope 原编号或逐份结果收据无效');
  if(item.upstreamId){if(seen.has(item.upstreamId))throw userError('原生 ModelScope 逐份任务编号重复');seen.add(item.upstreamId);}
 }
 if(job.requestCount!==job.items.filter(item=>item.status!=='unsubmitted').length||JSON.stringify(job.assets)!==JSON.stringify(job.items.flatMap(item=>item.assets)))throw userError('原生 ModelScope 尝试次数或结果次序与收据不一致');
 if(job.status==='completed'&&job.items.some(item=>item.status!=='completed'))throw userError('原生 ModelScope 仍有未完成份数');
 return count;
}
export function nativeModelscopeHasOriginalIds(job){return isNativeModelscopeJob(job)&&Array.isArray(job.items)&&job.items.some(item=>upstreamId(item.upstreamId));}

// Each saved count is an independent provider request, as in the pinned smart
// canvas. Resume polls only recorded IDs; it never fills unsubmitted slots.
export async function runNativeModelscopeBatch({job,studio,images,signal,resuming,pollInterval,persist,submit,query,store}){
 const count=studioRequestCount(studio);let queue=Promise.resolve();
 const save=()=>{job.assets=job.items.flatMap(item=>item.assets);const snapshot=structuredClone(job);queue=queue.then(()=>persist(snapshot));return queue;};
 if(resuming)validateNativeModelscopeBatch(job);
 else{if(job.requestCount||job.items?.some(item=>item.status!=='unsubmitted'))throw userError('ModelScope 请求已开始，不会重复提交');job.items=Array.from({length:count},(_,index)=>({index,status:'unsubmitted',assets:[]}));await save();}
 const outcomes=await Promise.allSettled(job.items.map(async item=>{
  if(item.status==='completed')return;
  try{
   signal.throwIfAborted();
   if(!resuming){
    if(item.status!=='unsubmitted')throw userError('ModelScope 原请求状态不明确，不会重复提交');
    item.status='submitting';job.requestCount++;await save();signal.throwIfAborted();
    const task=await submit({...studio,config:{...studio.config,count:1}},images,signal);
    if(!upstreamId(task.upstreamId)||job.items.some(other=>other!==item&&other.upstreamId===task.upstreamId))throw userError('ModelScope 未返回独立有效任务编号');
    item.upstreamId=task.upstreamId;item.status='pending';if(count===1)job.upstreamId=task.upstreamId;await save();
   }else if(!item.upstreamId)throw userError('此份 ModelScope 没有原任务编号，无法查询；不会补发');
   for(;;){
    signal.throwIfAborted();const result=await query(item.upstreamId,signal);
    if(result.status==='completed'){
     if(result.images?.length!==1)throw userError('ModelScope 单次没有返回一张可保存图片');
     const asset=await store(result.images[0],item.index);item.assets=[asset];item.status='completed';await save();return;
    }
    if(['failed','cancelled'].includes(result.status))throw userError('ModelScope 原任务未完成；不会自动重新生成');
    item.status='pending';job.progress=Math.round(job.items.filter(x=>x.status==='completed').length/count*100);await save();await delay(pollInterval,undefined,{signal});
   }
  }catch(error){if(!['unsubmitted','completed'].includes(item.status))item.status='failed';await save();throw error;}
 }));
 await queue;validateNativeModelscopeBatch(job);
 const failed=outcomes.find(result=>result.status==='rejected');if(failed)throw failed.reason;
 if(job.items.some(item=>item.status!=='completed'))throw userError('ModelScope 仍有未完成原请求，不会补发');
 return job.assets;
}
