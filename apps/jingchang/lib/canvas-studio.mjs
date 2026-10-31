import {isJimengStudio,jimengStudioAuthorization} from '../public/jimeng-studio-core.js';
import {validateJimengStudioAuthorization} from './jimeng-studio.mjs';
import {inspectPublicMediaSource} from './public-media.mjs';
import {MAX_STREAM_MEDIA_BYTES} from '../public/media-transfer-core.js';
import {isApimartMultimodal} from '../public/apimart-reference-core.js';
import {sourceIndexFields} from '../public/source-index-core.js';
import {assertImageRequestSize} from './image-api.mjs';
import {studioReferenceLimit} from '../public/reference-limits.js';
import {isArkMultimodal,arkSendsOriginalMedia} from '../public/ark-reference-core.js';
import {mjPromptOptional} from '../public/midjourney-core.js';
import {inspectArkLocalReference} from './ark-references.mjs';
import {normalizeCloudEnhancement} from './image-enhance.mjs';
import {cameraNodeText} from '../public/camera-angle-core.js';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {normalizeStudio,validateStudioReferences} from './creation-studio.mjs';
import {normalizeStudioCredential} from './ark-credentials.mjs';
import {safeId,userError,assertNoCredentials,loadAsset} from './workspace.mjs';
import {appendPromptAssetSources} from './prompt-assets.mjs';
import {studioRequestCount} from '../public/native-modelscope-core.js';

const nodes=['prompt','references','config','generate','output'].map((id,i)=>({id,x:i*300,y:0}));
const studio=(binding,name,prompt,references)=>normalizeStudio({name,mode:binding.mode,config:binding.config,prompt,references,nodes,viewport:{x:0,y:0,zoom:1},view:'canvas'});
export function normalizeStudioBinding(b){
 assertNoCredentials(b);if(!b||!['image','video'].includes(b.mode))throw userError('创作接口绑定需要图片或视频模式');
 const normalized=studio(b,'画布创作','',[]);if(!isJimengStudio(normalized)&&!normalized.config.baseUrl)throw userError('请先填写创作接口地址');
 const refs=b.referenceSources??[];if(!Array.isArray(refs)||refs.length>studioReferenceLimit(normalized))throw userError('图片创作接口最多20项参考；当前视频最多'+studioReferenceLimit(normalized)+'项');const used=new Set();
 const referenceSources=refs.map(r=>{if(!r||[r.assetId,r.sourceNodeId,r.url].filter(Boolean).length!==1)throw userError('参考素材映射无效');let value;if(r.url){sourceIndexFields(r);value=studio(b,'画布创作','',[r]).references[0];}else{if(!safeId(r.sourceNodeId||r.assetId))throw userError('参考素材编号无效');value={...(r.sourceNodeId?{sourceNodeId:r.sourceNodeId}:{assetId:r.assetId}),...sourceIndexFields(r)};}const key=value.url||JSON.stringify(value);if(used.has(key))throw userError('参考素材不能重复');used.add(key);return value;});
 const imageEnhance=normalizeCloudEnhancement({...b,config:normalized.config,referenceSources});
 return{mode:normalized.mode,config:normalized.config,includeUpstream:b.includeUpstream!==false,referenceSources,...(imageEnhance?{imageEnhance}:{})};
}
export async function studioStep({data,project,node,binding,parents,text,promptReferences=[],nativeReferences}){
 const b=normalizeStudioBinding({...binding,referenceSources:appendPromptAssetSources(binding.referenceSources,promptReferences)});if(node.type!==b.mode)throw userError('创作接口的输出类型与画布节点不匹配');const prompt=(b.includeUpstream?text:cameraNodeText(node))||'';if((!prompt&&!mjPromptOptional(b)&&!(isJimengStudio(b)&&['image_upscale','image2image'].includes(b.config.jimeng.command)))||prompt.length>(isJimengStudio(b)?20000:5000))throw userError('创作接口提示词须为1–5000字');
 const sources=nativeReferences??b.referenceSources;assertNoCredentials(sources);if(!Array.isArray(sources)||sources.length>studioReferenceLimit(b))throw userError('图片创作接口最多20项参考；当前视频最多'+studioReferenceLimit(b)+'项');
 const refs=[];for(const ref of sources){if(!ref||[ref.assetId,ref.sourceNodeId,ref.url].filter(Boolean).length!==1)throw userError('参考素材映射无效');if(ref.expectedCount!==undefined&&(!ref.sourceNodeId||!Number.isInteger(ref.expectedCount)||ref.expectedCount<1||ref.expectedCount>64))throw userError('待生成素材数量须为1–64的整数');if(ref.url){refs.push(studio(b,'画布创作','',[ref]).references[0]);continue;}if(!safeId(ref.sourceNodeId||ref.assetId))throw userError('参考素材编号无效');let id=ref.assetId;
  if(ref.sourceNodeId){const n=project.nodes.find(n=>n.id===ref.sourceNodeId);if(!n||!parents.has(n.id)||!['image','video','audio'].includes(n.type))throw userError('动态素材必须来自相连的上游媒体节点');if(n.params?.workflowBinding||n.params?.cloudBinding||n.params?.imageBinding||n.params?.studioBinding){for(let i=0;i<(ref.expectedCount??1);i++)refs.push({type:{image:'image/png',video:'video/mp4',audio:'audio/wav'}[n.type]});continue;}if(ref.expectedCount!==undefined)throw userError('待生成素材数量只能用于已配置的生成节点');id=n.assetId;}
  if(!id||!project.assets.some(a=>a.id===id))throw userError('参考素材不属于当前项目或上游未配置');if(isJimengStudio(b)){const a=await inspectPublicMediaSource(data,id,MAX_STREAM_MEDIA_BYTES);refs.push({assetId:id,type:a.type,size:a.size});continue;}const a=await loadAsset(data,id),st=await fs.lstat(path.join(data,'assets',id)),limit={image:10,video:32,audio:20}[a.type.split('/')[0]];
  if(!limit||!['image/png','image/jpeg','image/webp','video/mp4','video/quicktime','audio/mpeg','audio/wav','audio/x-wav','audio/mp4'].includes(a.type)||!st.isFile()||st.size!==a.size||st.size>limit*1024*1024)throw userError('参考素材格式或文件大小不符合创作接口要求');refs.push({assetId:id,type:a.type,size:st.size});
 }
 validateStudioReferences(studio(b,node.title,prompt,[]),refs);
 const referenceInputs=[];if(isJimengStudio(b)){for(const r of refs)if(r.assetId)referenceInputs.push(await inspectPublicMediaSource(data,r.assetId,MAX_STREAM_MEDIA_BYTES));}if(isArkMultimodal(b)){for(const r of refs)if(r.assetId)referenceInputs.push((await inspectArkLocalReference(data,r,AbortSignal.timeout(30000))).input);if(referenceInputs.filter(r=>r.type.startsWith('audio/')).reduce((n,r)=>n+r.duration,0)>15)throw userError('方舟参考音频总时长超过15秒');}
 if(b.mode==='image'&&b.config.protocol==='studio')assertImageRequestSize(refs.reduce((sum,r)=>sum+(r.size||0),0),prompt,b.config.model);
 return{...(isJimengStudio(b)?{projectId:project.id}:{}),...(b.imageEnhance?{imageEnhance:b.imageEnhance,enhanceSource:b.referenceSources[0]}:{}),kind:'studio',nodeId:node.id,title:node.title,studio:b,text:prompt,count:studioRequestCount(b),status:'pending',sendAssets:refs.length>0,...(isJimengStudio(b)?{sendOriginalMedia:refs.some(r=>/^(video|audio)\//.test(r.type||'')),referenceInputs}:isArkMultimodal(b)?{sendOriginalMedia:arkSendsOriginalMedia(b,refs),referenceInputs}:isApimartMultimodal(b)?{sendOriginalMedia:refs.some(r=>/^(video|audio)\//.test(r.type||''))}:{} )};
}
export function resolveStudio(step,project){const b=step.studio,references=b.referenceSources.map(r=>{if(r.url)return{url:r.url,type:r.type||'image/png'};const assetId=r.assetId||project.nodes.find(n=>n.id===r.sourceNodeId)?.assetId;if(!assetId||!project.assets.some(a=>a.id===assetId))throw userError('上游没有生成可用素材');return{assetId};});return studio(b,step.title,step.text,references);}
export function studioCredentials(steps,body,{resume=false}={}){
 const required=steps.filter(s=>s.kind==='studio'&&s.status!=='completed'),provided=body.studioCredentials??[];
 if(!Array.isArray(provided)||provided.length!==required.length||new Set(provided.map(x=>x?.nodeId)).size!==provided.length)throw userError('请为每个待执行创作接口节点分别确认密钥与授权');
 const keys=new Map();for(const s of required){const id=s.executionId||s.nodeId,item=provided.find(x=>x?.nodeId===id);if(!item)throw userError('创作接口节点本次密钥无效');if(isJimengStudio(s.studio)){if(item.credentialSource!=='jimeng-local'||item.credentialConsent!==true||item.apiKey)throw userError('请明确使用即梦本机登录，不填写API密钥');if(resume&&s.jobId){if(item.queryConsent!==true||item.originalJobId!==s.jobId)throw userError('请确认此即梦原任务剩余查询');keys.set(id,{credentialSource:'jimeng-local',credentialConsent:true,queryConsent:true,originalJobId:s.jobId,requestId:item.requestId});continue;}s.authorization=validateJimengStudioAuthorization({...s.studio,references:s.sendAssets?[{assetId:'scope'}]:[]},item.authorization,{sendOriginalMedia:s.sendOriginalMedia===true});keys.set(id,{credentialSource:'jimeng-local',credentialConsent:true});continue;}const credential=normalizeStudioCredential(item,s.studio,{allowEmptyLocal:false});keys.set(id,credential.credentialSource==='manual'?credential.apiKey:credential);if(resume)continue;
  const c=s.studio.config,a=item.authorization,origin=new URL(c.baseUrl).origin;if(!a||a.origin!==origin||a.model!==c.model||a.sendPrompt!==true||a.sendReferences!==s.sendAssets||a.requestLimit!==studioRequestCount(s.studio)||!Number.isFinite(a.budget)||a.budget<=0||a.currency!==c.currency)throw userError('请逐个确认创作接口的服务、模型、发送范围、预算和一次生成');if(s.sendOriginalMedia&&a.sendOriginalMedia!==true)throw userError('请单独确认该节点发送视频与音频原文件（包括声音）');if(c.unitPrice>0&&a.budget<c.unitPrice*(s.studio.mode==='video'?c.duration:c.count))throw userError('节点预算低于已填写的参考价格估算');s.authorization={origin,model:c.model,sendPrompt:true,sendReferences:s.sendAssets,requestLimit:studioRequestCount(s.studio),budget:a.budget,currency:a.currency,...((isArkMultimodal(s.studio)||isApimartMultimodal(s.studio))?{sendOriginalMedia:s.sendOriginalMedia===true}:{})};
 }return keys;
}
export function clearStudioCredentials(body){if(Array.isArray(body?.studioCredentials))for(const item of body.studioCredentials)if(item&&typeof item==='object')item.apiKey='';}
export function studioCredentialPayload(value){return typeof value==='string'?{apiKey:value}:{...value};}
