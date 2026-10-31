import path from 'node:path';import {randomUUID} from 'node:crypto';
import {atomicJson,readJson,safeId,userError} from './workspace.mjs';
import {legacyNativeInputAudit,nativeInputReviewSelections} from './legacy-native-input-audit.mjs';
import {checkedNativeInputReviews} from './native-input-review-proof.mjs';
const stale=()=>{const e=userError('旧任务或素材范围已变化，请重新查看并确认；本次没有继续任务。',409);e.code='NATIVE_INPUT_REVIEW_STALE';return e;};
export function nativeInputReviewService({data,activeJobs,exclusive}){
 const file=id=>{if(!safeId(id))throw userError('任务编号无效');return path.join(data,'jobs',id+'.json');};
 const eligible=job=>{
  if(job.kind!=='canvas-run'||job.executionMode==='native-cascade'||job.readOnly===true||!['interrupted','cancelled'].includes(job.status))throw userError('仅能核对已中断或已停止的原画布任务。',409);
  if([...activeJobs.values()].some(row=>row.projectId===job.projectId))throw userError('项目仍有任务运行，请停止后再核对。',409);
 };
 const load=async id=>{const job=await readJson(file(id));if(job.id!==id)throw userError('任务记录编号不一致。',409);eligible(job);return job;};
 return{
  preview:(id,body={})=>exclusive(id,async()=>{
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)throw userError('预览不接受新的素材或执行参数。');
   const job=await load(id),audit=legacyNativeInputAudit(job);
   return{format:'jingchang.native-input-review-preview@1',jobId:id,projectId:job.projectId,audit,
    canConfirm:audit.state==='requires_confirmation',wouldWrite:false,generationSubmitted:false,
    message:audit.state==='requires_confirmation'?'请核对原序号与实际需要的序号。确认只保存选择，不启动生成。':audit.summary};
  }),
  confirm:(id,body={})=>exclusive(id,async()=>{
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['fingerprint','consent'].includes(key))||body.consent!==true||typeof body.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(body.fingerprint))throw userError('请先查看当前差异并明确确认；不能直接指定新序号。',409);
   const job=await load(id),audit=legacyNativeInputAudit(job),history=checkedNativeInputReviews(job.nativeInputReviews);
   const previous=history.find(record=>record.jobId===id&&record.fingerprint===body.fingerprint);
   if(previous&&!audit.blocksResume&&audit.entries.some(row=>row.reviewId===previous.id))return{job,alreadyConfirmed:true,generationSubmitted:false};
   if(audit.state!=='requires_confirmation'||body.fingerprint!==audit.fingerprint)throw stale();
   if(history.length>=128)throw userError('该任务的确认记录已达上限，请保留记录并新建计划。',409);
   const selections=nativeInputReviewSelections(audit);if(selections.length>512)throw userError('本次需要核对的选择过多，请按范围新建计划。',409);
   const receipt={format:'jingchang.native-input-review@1',id:randomUUID(),jobId:id,fingerprint:body.fingerprint,createdAt:new Date().toISOString(),consent:true,selections};
   checkedNativeInputReviews([...history,receipt]);
   // Resume and metadata-link recovery use the same owned-job lock. The
   // worker is excluded by activeJobs before this append-only decision write.
   job.nativeInputReviews=[...history,receipt];await atomicJson(file(id),job);
   return{job,alreadyConfirmed:false,generationSubmitted:false};
  })
 };
}
