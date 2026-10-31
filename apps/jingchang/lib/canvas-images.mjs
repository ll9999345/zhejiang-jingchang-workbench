import {IMAGE_REFERENCE_LIMIT} from '../public/reference-limits.js';
import {cameraNodeText} from '../public/camera-angle-core.js';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {validateApiBaseUrl,assertImageRequestSize} from './image-api.mjs';
import {userError,assertNoCredentials,safeId,loadAsset} from './workspace.mjs';
import {appendPromptAssetSources} from './prompt-assets.mjs';
import {normalizeMiaoCredential} from './miao-credentials.mjs';
export function normalizeImageBinding(b){
 assertNoCredentials(b);const p=b?.platform,m=Array.isArray(p?.models)?p.models.find(m=>m?.id===b.model&&m.category==='image'):null;if(!p||p.protocol!=='openai-compatible'||!safeId(p.id)||typeof p.name!=='string'||!p.name||p.name.length>80||!m||typeof m.id!=='string'||!m.id||m.id.length>200)throw userError('图片绑定缺少有效平台与图片模型，请重新绑定');const baseUrl=validateApiBaseUrl(p.baseUrl),size=b.size||'auto',quality=b.quality||'auto';if(!/^(auto|[1-9]\d{1,4}x[1-9]\d{1,4})$/.test(size)||!['auto','low','medium','high'].includes(quality))throw userError('图片绑定尺寸或质量无效');
 const refs=b.referenceSources??[];if(!Array.isArray(refs)||refs.length>IMAGE_REFERENCE_LIMIT)throw userError('每个图片节点最多20张参考图');const used=new Set();for(const r of refs){if(!r||!!r.sourceNodeId===!!r.assetId||!safeId(r.sourceNodeId||r.assetId))throw userError('图片绑定参考图无效');const key=(r.sourceNodeId?'node:':'asset:')+(r.sourceNodeId||r.assetId);if(used.has(key))throw userError('图片绑定参考图重复');used.add(key);}if(refs.length&&m.referenceSupport!==true)throw userError('绑定模型未开启参考图支持');return{platform:{id:p.id,name:p.name,protocol:p.protocol,baseUrl,models:[{id:m.id,label:String(m.label||m.id).slice(0,120),category:'image',referenceSupport:m.referenceSupport===true}]},model:m.id,size,quality,includeUpstream:b.includeUpstream!==false,referenceSources:refs.map(r=>r.sourceNodeId?{sourceNodeId:r.sourceNodeId}:{assetId:r.assetId})};
}
export async function imageStep({data,project,node,binding,parents,text,promptReferences=[],nativeReferences}){
 if(node.type!=='image')throw userError('图片接口仅可绑定图片节点');const image=normalizeImageBinding({...binding,referenceSources:appendPromptAssetSources(binding.referenceSources,promptReferences)}),prompt=image.includeUpstream?text:cameraNodeText(node);if(!prompt||prompt.length>32000)throw userError('图片节点提示词须为1–32000字');
 let referenceBytes=0,referenceCount=0;const refs=nativeReferences??image.referenceSources;
 if(!Array.isArray(refs))throw userError('图片参考列表无效');
 for(const r of refs){const count=r?.expectedCount??1;if(!Number.isSafeInteger(count)||count<1||count>64||r.expectedCount!==undefined&&!r.sourceNodeId)throw userError('待生成参考图数量无效');referenceCount+=count;if(referenceCount>IMAGE_REFERENCE_LIMIT)throw userError('每个图片节点最多20张参考图，整组展开后已超出');let id=r.assetId;if(r.sourceNodeId){const n=project.nodes.find(n=>n.id===r.sourceNodeId);if(!n||n.type!=='image'||!parents.has(n.id))throw userError('动态参考图必须来自相连的上游图片节点');if(n.params?.workflowBinding||n.params?.cloudBinding||n.params?.imageBinding||n.params?.studioBinding)continue;id=n.assetId;}if(!id||!project.assets.some(a=>a.id===id))throw userError('参考图不属于当前项目或上游尚未配置');const a=await loadAsset(data,id),st=await fs.stat(path.join(data,'assets',id));if(!['image/png','image/jpeg','image/webp'].includes(a.type)||!st.isFile()||st.size!==a.size||st.size>10*1024*1024)throw userError('参考图须为不超过10MB的PNG、JPEG或WebP');referenceBytes+=st.size;assertImageRequestSize(referenceBytes,prompt,image.model);}
 return{kind:'image-api',nodeId:node.id,title:node.title,image,text:prompt,count:1,status:'pending',sendAssets:image.referenceSources.length>0};
}
export function imageCredentials(steps,body,{resume=false}={}){
 const required=steps.filter(s=>s.kind==='image-api'&&s.status!=='completed'&&(!resume||!s.jobId)),provided=body.imageCredentials??[];
 if(!Array.isArray(provided)||provided.length!==required.length||new Set(provided.map(x=>x?.nodeId)).size!==provided.length)throw userError('请为每个待提交图片节点分别确认本次密钥和授权');
 const keys=new Map();
 try{for(const s of required){
  const id=s.executionId||s.nodeId,item=provided.find(x=>x?.nodeId===id);if(!item)throw userError('图片节点本次密钥无效');
  const credential=normalizeMiaoCredential(item,s.image.platform,{purpose:'image',allowEmptyLocal:false});
  const a=resume?s.authorization:item.authorization,origin=new URL(s.image.platform.baseUrl).origin;
  if(!a||a.origin!==origin||a.model!==s.image.model||a.sendPrompt!==true||a.sendReferences!==s.sendAssets||a.requestLimit!==1||!Number.isFinite(a.budget)||a.budget<=0||!['CNY','USD'].includes(a.currency))throw userError('请逐个确认图片节点服务、模型、发送范围、预算和一次生成');
  if(!resume)s.authorization={origin,model:s.image.model,sendPrompt:true,sendReferences:s.sendAssets,budget:a.budget,currency:a.currency,requestLimit:1};
  keys.set(id,credential.credentialSource==='manual'?credential.apiKey:credential);
 }return keys;}catch(error){clearCanvasApiCredentialMap(keys);throw error;}
}
export function imageCredentialPayload(value){return typeof value==='string'?{apiKey:value}:{...value};}
export function clearCanvasApiCredentialMap(keys){
 for(const value of keys.values())if(value&&typeof value==='object'){value.apiKey='';delete value.credentialSource;delete value.credentialConsent;}
 keys.clear();
}
// A rejected legacy manual request may be corrected and resubmitted by its
// caller. A managed source and its consent are always single-request choices.
export function clearCanvasMiaoChoices(body){
 for(const name of ['imageCredentials','llmCredentials'])if(Array.isArray(body?.[name]))for(const item of body[name])if(item&&typeof item==='object'){
  if(item.credentialSource!==undefined&&item.credentialSource!=='manual')item.apiKey='';
  delete item.credentialSource;delete item.credentialConsent;
 }
}
export function clearImageCredentials(body){if(Array.isArray(body?.imageCredentials))for(const item of body.imageCredentials)if(item&&typeof item==='object'){item.apiKey='';delete item.credentialSource;delete item.credentialConsent;}}
