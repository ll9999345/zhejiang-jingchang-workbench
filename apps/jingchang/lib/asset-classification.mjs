import {withAssetMetadataLock} from './asset-metadata-lock.mjs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {safeApiCall,validateApiBaseUrl} from './image-api.mjs';
import {chatReply} from './chat-stream.mjs';
import {chatReferenceParts} from './chat-media.mjs';
import {atomicJson,loadAsset,safeId,userError} from './workspace.mjs';
import {localMiaoCredentialService,normalizeMiaoCredential,resolveMiaoCredential} from './miao-credentials.mjs';
import {assetClassificationReceiptStore} from './asset-classification-receipts.mjs';

export const CLASSIFICATION_DIMENSIONS={
 environment:'环境',scene:'场景',space:'空间',subject:'主体',model:'模特',people:'人物',style:'风格',lighting:'光影',color:'色彩',composition:'构图',mood:'氛围',use_case:'用途',objects:'物体',materials:'材质',quality:'质量'
};

export const DEFAULT_ASSET_CLASSIFICATION_PROMPT=`请为素材库识别这张图片，严格返回 JSON，不要 Markdown 或解释。只记录图中能确认的内容，不确定时省略，不要猜测人物身份。
JSON 结构：{"summary":"一句话描述","categories":{"environment":["环境"],"scene":["场景"],"space":["空间"],"subject":["主体"],"model":["模特"],"people":["人物"],"style":["风格"],"lighting":["光影"],"color":["色彩"],"composition":["构图"],"mood":["氛围"],"use_case":["用途"],"objects":["主要物体"],"materials":["材质"],"quality":["画质特征"]},"tags":["综合关键词"]}
类别键可省略；每个类别最多 8 个中文短标签，tags 最多 20 个。`;

const localOrigin=url=>url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname);
const safeTag=value=>String(value??'').replace(/\s+/gu,' ').replace(/^[#＃]+/u,'').trim().replace(/[,，、;；|/]+$/u,'').slice(0,24);

export function normalizeAssetClassification(raw,{providerId='',model=''}={}){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw userError('模型没有返回有效的分类对象');
 const input=raw.categories&&typeof raw.categories==='object'&&!Array.isArray(raw.categories)?raw.categories:{};
 const categories={},flat=[],seenFlat=new Set();
 for(const [rawKey,rawValues] of Object.entries(input).slice(0,40)){
  const dimension=String(rawKey).trim().toLowerCase().replace(/[^a-z0-9_-]+/g,'_').slice(0,40);if(!dimension)continue;
  const values=Array.isArray(rawValues)?rawValues:typeof rawValues==='string'?rawValues.split(/[,，、/|;；\n]+/u):[];
  const seen=new Set(),clean=[];
  for(const value of values){const tag=safeTag(value);if(!tag||seen.has(tag))continue;seen.add(tag);clean.push(tag);const key=dimension+'::'+tag;if(!seenFlat.has(key)){flat.push({dimension,label:CLASSIFICATION_DIMENSIONS[dimension]||dimension,tag});seenFlat.add(key);}if(clean.length>=8)break;}
  if(clean.length)categories[dimension]=clean;
 }
 const tags=[],tagSeen=new Set();
 for(const value of (Array.isArray(raw.tags)?raw.tags:[])){const tag=safeTag(value);if(!tag||tagSeen.has(tag))continue;tagSeen.add(tag);tags.push(tag);const key='tags::'+tag;if(!seenFlat.has(key)){flat.push({dimension:'tags',label:'标签',tag});seenFlat.add(key);}if(tags.length>=20)break;}
 const summary=String(raw.summary||'').replace(/[\u0000-\u001f]/gu,' ').trim().slice(0,240);
 if(!summary&&!flat.length)throw userError('模型没有返回可用的图片描述或分类标签');
 return {summary,categories,tags,flat,providerId:String(providerId).slice(0,100),model:String(model).slice(0,200),updatedAt:new Date().toISOString()};
}

function parseClassification(text){
 let value=String(text||'').trim().replace(/^```(?:json)?\s*/iu,'').replace(/\s*```$/u,'').trim();
 try{return JSON.parse(value);}catch{}
 const start=value.indexOf('{'),end=value.lastIndexOf('}');
 if(start<0||end<=start)throw userError('模型没有返回可解析的分类 JSON');
 try{return JSON.parse(value.slice(start,end+1));}catch{throw userError('模型返回的分类 JSON 格式无效');}
}

const runtimes=new Map();
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const stamp=()=>new Date().toISOString();
const secretLike=value=>/Bearer\s+\S+|\bsk-[a-z0-9_-]{8,}|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*\S+/iu.test(String(value));
function redactClassification(value,key=''){
 if(typeof value==='string')return (key?value.split(key).join('[已隐藏密钥]'):value).replace(/Bearer\s+[^\s"\\]+|\bsk-[a-z0-9_-]{8,}/giu,'[已隐藏密钥]');
 if(Array.isArray(value))return value.map(item=>redactClassification(item,key));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[redactClassification(name,key),redactClassification(item,key)]));
 return value;
}
function taskError(row,message=row.error?.message||'图片分类已停止；请检查原任务，不会自动重发',status=row.error?.status||409){
 const error=userError(message,status);error.code=row.error?.code||'classification_not_resendable';
 error.uncertain=row.status==='uncertain';error.classificationTask=row;error.publicMessage=message;return error;
}

export function assetClassificationService({data,platforms,miaoCredentials=localMiaoCredentialService(),apiCall=safeApiCall}){
 const store=assetClassificationReceiptStore(data),instanceId=randomUUID();
 // Shared only for live work. Disk receipts, rather than this map, decide if a
 // request has already been sent after a new process or service is created.
 const runtimeKey=path.resolve(data);if(!runtimes.has(runtimeKey))runtimes.set(runtimeKey,{byAsset:new Map(),byRequest:new Map()});
 const runtime=runtimes.get(runtimeKey);
 let recovery;
 const ready=()=>recovery??=(store.recover({instanceId,active:runtime.byRequest}));
 async function recover(){await ready();return store.recover({instanceId,active:runtime.byRequest});}
 async function get(taskId){await ready();const row=await store.read(taskId,{missing:true});if(!row)throw userError('找不到图片分类任务',404);return store.visible(row);}
 async function list({assetId,projectId}={}){
  await ready();if(assetId!==undefined&&!safeId(assetId)||projectId!==undefined&&!safeId(projectId))throw userError('图片分类筛选编号无效');
  return (await store.all()).filter(row=>(!assetId||row.assetId===assetId)&&(!projectId||row.projectId===projectId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id)).map(store.visible);
 }
 async function cancel(taskId){
  await ready();const row=await store.read(taskId,{missing:true});if(!row)throw userError('找不到图片分类任务',404);
  const changed=await store.update(taskId,current=>{
   if(!['queued','sending'].includes(current.status))return false;
   const sent=current.status==='sending';current.status=sent?'uncertain':'cancelled';current.updatedAt=stamp();current.finishedAt=current.updatedAt;
   current.error={code:sent?'classification_cancelled_after_send':'classification_cancelled',message:sent?'已停止等待图片分类；发送可能已被上游接受，结果与费用待确认，不会自动重发':'已在发送前取消图片分类，未发送图片',status:409};
  });
  if(['cancelled','uncertain'].includes(changed.status))runtime.byRequest.get(taskId)?.controller.abort();return store.visible(changed);
 }
 async function response(row,{replayed=false,key=''}={}){return withAssetMetadataLock(data,row.assetId,async()=>{
  const asset=await loadAsset(data,row.assetId);
  // If the response-to-disk commit was interrupted, a completed receipt can
  // finish the local-only write. An older receipt never rolls back newer tags.
  if(!asset.classification||Date.parse(asset.classification.updatedAt)<=Date.parse(row.result.updatedAt)){
   asset.classification=structuredClone(row.result);await atomicJson(path.join(data,'assets',row.assetId+'.json'),asset);
  }
  return {...redactClassification(structuredClone(asset),key),classificationTask:{...store.visible(row),replayed}};
 });}
 async function applyReceipt(taskId){
  await ready();const row=await store.read(taskId);if(row.status!=='completed')throw taskError(store.visible(row));
  const part=(await chatReferenceParts({data,assetIds:[row.assetId]})).parts[0],url=part?.image_url?.url||'';
  if(createHash('sha256').update(Buffer.from(url.slice(url.indexOf(',')+1),'base64')).digest('hex')!==row.media.sha256)throw userError('原分类图片已经变化，不能回填旧结果',409);
  return response(row,{replayed:true});
 }
 async function classify(assetId,body,{expectedBinding,beforeSend,signal:batchSignal}={}){
  let credential,apiKey='';
  try{
   await ready();
   if(!safeId(assetId))throw userError('素材编号无效');
   if(!body||typeof body!=='object')throw userError('请明确同意向所选模型发送这张图片进行一次分类');
   if(body.requestId!==undefined&&!safeId(body.requestId))throw userError('图片分类请求编号无效');
   const requestId=body.requestId||randomUUID();
   if(!safeId(body.platformId)||typeof body.model!=='string'||!body.model.trim()||body.model.length>200)throw userError('请指定已保存的平台和对话模型');
   if(body.prompt!==undefined&&(typeof body.prompt!=='string'||body.prompt.length>4000))throw userError('分类补充说明不能超过 4000 个字符');
   if(body.projectId!==undefined&&body.projectId!==''&&!safeId(body.projectId))throw userError('项目编号无效');
   const stored=await platforms.get(body.platformId),baseUrl=validateApiBaseUrl(stored.baseUrl),origin=new URL(baseUrl).origin,local=localOrigin(new URL(baseUrl));
   const asset=await loadAsset(data,assetId);
   if(!['image/png','image/jpeg','image/webp'].includes(asset.type))throw userError('图片智能分类只支持 PNG、JPEG、WebP');
   if(!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>10*1024*1024)throw userError('图片须为 1 字节至 10 MB');
   const media=await chatReferenceParts({data,assetIds:[assetId]});
   if(media.parts.length!==1||media.parts[0].type!=='image_url')throw userError('无法读取这张本地图片');
   const imageUrl=media.parts[0].image_url.url,bytes=Buffer.from(imageUrl.slice(imageUrl.indexOf(',')+1),'base64');
   const extra=String(body.prompt||'').trim(),prompt=DEFAULT_ASSET_CLASSIFICATION_PROMPT+(extra?'\n\n用户补充的分类要求：\n'+extra:'');
   const auth=body.authorization,authorization={origin:auth?.origin,model:auth?.model,sendImage:auth?.sendImage,requestLimit:auth?.requestLimit,budget:auth?.budget,currency:auth?.currency,consent:auth?.consent,credentialSource:body.credentialSource??'manual',credentialConsent:body.credentialConsent===true};
   const binding={assetId,projectId:body.projectId||'',media:{sha256:createHash('sha256').update(bytes).digest('hex'),type:asset.type,size:bytes.length},platform:{id:body.platformId,origin,protocol:stored.protocol,baseUrlDigest:digest(baseUrl)},model:body.model,promptDigest:digest(prompt),authorization,consent:body.consent===true};
   if(expectedBinding&&(JSON.stringify(binding.media)!==JSON.stringify(expectedBinding.media)||JSON.stringify(binding.platform)!==JSON.stringify(expectedBinding.platform)||binding.promptDigest!==expectedBinding.promptDigest))throw userError('批量确认后的图片或服务配置已变化，已停止发送',409);
   const bindingDigest=digest(binding);let existing;
   try{existing=runtime.byRequest.has(requestId)?null:await store.read(requestId,{missing:true});}
   catch(error){if(!runtime.byRequest.has(requestId))throw error;existing=null;}
   if(existing&&existing.bindingDigest!==bindingDigest)throw taskError(store.visible(existing),'同一分类编号的图片、平台、模型、要求或授权已变化；已拒绝发送',409);
   if(body.consent!==true)throw userError('请明确同意向所选模型发送这张图片进行一次分类');
   if(stored.protocol!=='openai-compatible')throw userError('图片智能分类当前需要 OpenAI 兼容对话平台');
   const model=stored.models.find(item=>item.id===body.model&&item.category==='chat'&&item.referenceSupport===true);
   if(!model)throw userError('所选对话模型未在 API 设置中开启图片输入能力');
   if(auth?.origin!==origin||auth?.model!==model.id||auth?.sendImage!==true||auth?.requestLimit!==1||auth?.consent!==true||!['CNY','USD'].includes(auth.currency)||!Number.isFinite(auth.budget)||auth.budget<0||auth.budget>1_000_000||(!local&&auth.budget<=0))throw userError('本次服务地址、模型、图片发送范围或预算授权无效');
   credential=normalizeMiaoCredential(body,stored);
   if(secretLike([requestId,assetId,binding.projectId,body.platformId,origin,model.id].join('\n')))throw userError('分类编号或平台模型字段疑似包含密钥，请移除秘密后继续');
   if(existing){
    if(existing.status==='completed')return await response(existing,{replayed:true,key:credential.apiKey});
    const running=runtime.byRequest.get(requestId);
    if(running){await running.promise;return response(await store.read(requestId),{replayed:true,key:credential.apiKey});}
    throw taskError(store.visible(existing));
   }
   const inFlight=runtime.byRequest.get(requestId);
   if(inFlight){
    if(inFlight.bindingDigest!==bindingDigest)throw userError('同一分类编号的图片、平台、模型、要求或授权已变化；已拒绝发送',409);
    await inFlight.promise;return response(await store.read(requestId),{replayed:true,key:credential.apiKey});
   }
   if(runtime.byAsset.has(assetId))throw userError('这份图片正在分类，请等待当前请求结束',409);
   const controller=new AbortController(),live={controller,promise:null,bindingDigest};
   // Claim the live asset before the first disk await; the wx receipt creation
   // also arbitrates the same request ID between actual Node processes.
   runtime.byAsset.set(assetId,requestId);runtime.byRequest.set(requestId,live);
   live.promise=(async()=>{
    const now=stamp();let row={version:1,id:requestId,kind:'asset-classification',requestId,...binding,bindingDigest,status:'queued',createdAt:now,updatedAt:now,owner:{pid:process.pid,instanceId}};
    try{
     try{await store.write(row,{create:true});}catch(error){
      if(error.code!=='EEXIST')throw error;
      const claimed=await store.read(requestId);
      if(claimed.bindingDigest!==bindingDigest)throw taskError(store.visible(claimed),'同一分类编号已绑定另一项图片或授权；已拒绝发送',409);
      if(claimed.status==='completed')return response(claimed,{replayed:true,key:credential.apiKey});
      throw taskError(store.visible(claimed));
     }
     try{
      ({apiKey}=await resolveMiaoCredential(credential,stored,miaoCredentials));
      // Resolve may pause on the system keychain. A cancellation during that
      // wait must stay unsent, even if the keychain eventually returns a key.
      if(apiKey&&JSON.stringify(binding).includes(apiKey))throw userError('分类配置中含本次密钥，已阻止发送与结果保存');
      batchSignal?.throwIfAborted();await beforeSend?.();batchSignal?.throwIfAborted();
      row=await store.update(requestId,current=>{
       if(current.status!=='queued')throw taskError(store.visible(current));
       current.status='sending';current.sendIntentAt=stamp();current.updatedAt=current.sendIntentAt;
      }); // Durable send intent MUST precede the API call.
      if(row.status!=='sending')throw taskError(store.visible(row));
      batchSignal?.throwIfAborted();
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(120000),...(batchSignal?[batchSignal]:[])]);
      const upstream=await apiCall({baseUrl,path:'chat/completions',method:'POST',apiKey,signal,body:{model:model.id,messages:[{role:'user',content:[{type:'text',text:prompt},media.parts[0]]}],max_tokens:1800,temperature:0,stream:false}});
      const answer=chatReply(upstream);
      if(!answer.complete)throw Object.assign(new Error('incomplete'),{classificationCode:'classification_incomplete',uncertain:true});
      const classification=normalizeAssetClassification(redactClassification(parseClassification(answer.text),apiKey),{providerId:body.platformId,model:model.id});
      const latestMedia=await chatReferenceParts({data,assetIds:[assetId]}),url=latestMedia.parts[0]?.image_url?.url||'';
      if(createHash('sha256').update(Buffer.from(url.slice(url.indexOf(',')+1),'base64')).digest('hex')!==binding.media.sha256)throw Object.assign(new Error('media changed'),{classificationCode:'classification_media_changed'});
      row=await store.update(requestId,current=>{
       if(current.status!=='sending')throw taskError(store.visible(current));
       current.status='completed';current.result=classification;current.updatedAt=stamp();current.finishedAt=current.updatedAt;
      });
      if(row.status!=='completed')throw taskError(store.visible(row));
      return await response(row,{key:apiKey});
     }catch(error){
      row=await store.update(requestId,current=>{
       if(!['queued','sending'].includes(current.status))return false;
       const sent=current.status==='sending';
       const explicitFailure=Number.isInteger(error.upstreamStatus)&&error.upstreamStatus>=400&&error.upstreamStatus<600||error.classificationCode==='classification_media_changed';
       const uncertain=sent&&!explicitFailure;
       current.status=uncertain?'uncertain':'failed';current.updatedAt=stamp();current.finishedAt=current.updatedAt;
       current.error={code:uncertain?'classification_outcome_uncertain':sent?'classification_upstream_failed':'classification_preparation_failed',message:uncertain?'图片分类发送后的结果无法确认；请检查平台任务和账单，不会自动重发':sent?'本次图片分类失败；请检查平台任务和输入，原编号不会自动重发':'本次图片分类在发送前准备失败，未发送图片；请检查本机配置',status:uncertain?409:502};
       if(explicitFailure&&Number.isInteger(error.upstreamStatus))current.error.upstreamStatus=error.upstreamStatus;
      });
      if(row.status==='completed')throw taskError(store.visible(row),'分类结果已保存，素材回填未完成；可读取原编号恢复本机回填',409);
      throw taskError(store.visible(row));
     }
    }finally{runtime.byAsset.delete(assetId);runtime.byRequest.delete(requestId);}
   })();
   return await live.promise;
  }finally{apiKey='';if(credential)credential.apiKey='';if(body&&typeof body==='object')body.apiKey='';}
 }
 return {classify,recover,list,get,cancel,applyReceipt};
}
