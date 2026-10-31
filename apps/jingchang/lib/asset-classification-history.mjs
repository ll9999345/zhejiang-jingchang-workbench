import {isDeepStrictEqual} from 'node:util';
import {normalizeAssetClassification} from './asset-classification.mjs';
import {safeId,userError} from './workspace.mjs';

export const CLASSIFICATION_HISTORY_SOURCE='asset-classification-tasks';
const digest=/^[a-f0-9]{64}$/;
const fail=message=>{throw userError('分类留痕'+message);};
function keys(value,allowed,label){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail(label+'字段无效');}
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));

// Classification dimensions are a bounded dictionary, not arbitrary receipt
// fields. Preserve the exact normalized snapshot, including its original time.
export function classificationSnapshot(value){
 keys(value,['summary','categories','tags','flat','providerId','model','updatedAt'],'结果');
 if(!date(value.updatedAt)||typeof value.providerId!=='string'||typeof value.model!=='string')fail('结果身份或时间无效');
 let normalized;
 try{normalized=normalizeAssetClassification(value,{providerId:value.providerId,model:value.model});}catch{fail('结果无效');}
 normalized.updatedAt=value.updatedAt;
 if(!isDeepStrictEqual(normalized,value))fail('结果与规范分类标签不一致');
 return structuredClone(value);
}

// This portable contract deliberately has no owner, credential-source consent,
// execution binding or live recovery capability. Import keeps it in the archive.
export function classificationHistoryReceipt(value,{projectId}={}){
 keys(value,['version','id','kind','requestId','projectId','assetId','media','platform','model','promptDigest','authorization','consent','status','createdAt','updatedAt','sendIntentAt','finishedAt','result','error'],'收据');
 if(value.version!==1||value.kind!=='asset-classification'||!safeId(value.id)||value.id!==value.requestId||!safeId(value.assetId)||value.projectId!==''&&!safeId(value.projectId)||projectId!==undefined&&value.projectId!==''&&value.projectId!==projectId)fail('身份无效');
 if(!['completed','failed','cancelled','uncertain'].includes(value.status))fail('尚未结束，请先停止或完成分类');
 if(!date(value.createdAt)||!date(value.updatedAt)||!date(value.finishedAt)||value.sendIntentAt!==undefined&&!date(value.sendIntentAt))fail('时间无效');
 if(['completed','uncertain'].includes(value.status)&&!value.sendIntentAt)fail('缺少原发送意图');
 keys(value.media,['sha256','size','type'],'图片');
 if(!digest.test(value.media.sha256)||!Number.isSafeInteger(value.media.size)||value.media.size<1||value.media.size>10*1024**2||!['image/png','image/jpeg','image/webp'].includes(value.media.type))fail('图片指纹无效');
 keys(value.platform,['id','origin','protocol','baseUrlDigest'],'服务');
 let parsed;try{parsed=new URL(value.platform.origin);}catch{fail('服务地址无效');}
 if(!['http:','https:'].includes(parsed.protocol)||parsed.origin!==value.platform.origin||!safeId(value.platform.id)||value.platform.protocol!=='openai-compatible'||!digest.test(value.platform.baseUrlDigest)||typeof value.model!=='string'||!value.model.trim()||value.model.length>200||!digest.test(value.promptDigest))fail('服务或模型无效');
 const a=value.authorization;keys(a,['origin','model','sendImage','requestLimit','budget','currency','consent'],'授权');
 if(value.consent!==true||a.consent!==true||a.origin!==value.platform.origin||a.model!==value.model||a.sendImage!==true||a.requestLimit!==1||!['CNY','USD'].includes(a.currency)||!Number.isFinite(a.budget)||a.budget<0||a.budget>1_000_000)fail('授权绑定无效');
 const local=parsed.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(parsed.hostname);
 if(!local&&a.budget<=0)fail('远程预算授权无效');
 if(value.status==='completed'){
  classificationSnapshot(value.result);
  if(value.error!==undefined||value.result.providerId!==value.platform.id||value.result.model!==value.model)fail('结果与原服务模型不对应');
 }else{
  if(value.result!==undefined)fail('未完成收据不应包含成功结果');
  keys(value.error,['code','message','status','upstreamStatus'],'错误');
  const e=value.error;
  if(typeof e.code!=='string'||!/^[a-z0-9_-]{1,100}$/i.test(e.code)||typeof e.message!=='string'||!e.message||e.message.length>1000||!Number.isInteger(e.status)||e.status<400||e.status>599||e.upstreamStatus!==undefined&&(!Number.isInteger(e.upstreamStatus)||e.upstreamStatus<400||e.upstreamStatus>599))fail('错误记录无效');
 }
 return structuredClone(value);
}

export function classificationHistoryFromTask(row){
 const {owner,bindingDigest,...receipt}=row;
 const {credentialSource,credentialConsent,...authorization}=row.authorization;
 return classificationHistoryReceipt({...receipt,authorization});
}
