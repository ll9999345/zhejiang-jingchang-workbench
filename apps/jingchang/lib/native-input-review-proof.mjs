import {safeId,userError} from './workspace.mjs';
import {createHash} from 'node:crypto';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,canonical(v[k])])):v;
export const nativeInputSourceFingerprint=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const nativeInputReviewFingerprint=(jobId,selections)=>nativeInputSourceFingerprint({jobId,selections});
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v),hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const keys=(value,names)=>plain(value)&&Object.keys(value).every(key=>names.includes(key));
export function checkedNativeInputReviews(value=[]){
 if(!Array.isArray(value)||value.length>128)throw userError('旧任务素材确认记录数量无效');
 for(const record of value){
  if(!keys(record,['format','id','jobId','fingerprint','createdAt','consent','selections'])||record.format!=='jingchang.native-input-review@1'||!safeId(record.id)||!safeId(record.jobId)||!hex(record.fingerprint)||record.consent!==true||typeof record.createdAt!=='string'||!Number.isFinite(Date.parse(record.createdAt))||!Array.isArray(record.selections)||!record.selections.length||record.selections.length>512)throw userError('旧任务素材确认记录无效');
  const seen=new Set();
  for(const row of record.selections){
   if(!keys(row,['stepIndex','detailIndex','sourceFingerprint','outputFingerprint','producerNodeId','originNodeId','kind','indices'])||!Number.isSafeInteger(row.stepIndex)||row.stepIndex<0||row.stepIndex>10000||!Number.isSafeInteger(row.detailIndex)||row.detailIndex<0||row.detailIndex>999||!hex(row.sourceFingerprint)||row.outputFingerprint!==null&&!hex(row.outputFingerprint)||!safeId(row.producerNodeId)||row.originNodeId!==null&&!safeId(row.originNodeId)||!['image','video','audio'].includes(row.kind)||!Array.isArray(row.indices)||!row.indices.length||row.indices.length>64||new Set(row.indices).size!==row.indices.length||row.indices.some(i=>!Number.isSafeInteger(i)||i<0||i>63))throw userError('旧任务素材确认范围无效');
   const key=row.stepIndex+':'+row.detailIndex;if(seen.has(key))throw userError('旧任务素材确认范围重复');seen.add(key);
  }
  if(record.fingerprint!==nativeInputReviewFingerprint(record.jobId,record.selections))throw userError('旧任务素材确认记录校验不一致');
 }
 return value;
}
