import {geminiCliProgram as resolveGeminiCliProgram} from './gemini-cli-process.mjs';
import {codexChatProgram} from './codex-chat-process.mjs';
import {linkCanvasChild} from './canvas-child-scope.mjs';
import {CANVAS_LLM_REFERENCE_LIMIT,CANVAS_LLM_IMAGE_LIMIT,CANVAS_LLM_AUDIO_LIMIT,CHAT_VIDEO_LIMIT} from '../public/reference-limits.js';
import {CHAT_AUDIO_TYPES} from '../public/chat-audio-types.js';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateApiBaseUrl,safeApiCall} from './image-api.mjs';
import {prepareChatMedia,chatReferenceParts,CHAT_MEDIA_LIMIT} from './chat-media.mjs';
import {geminiChatModel,geminiChatPart,geminiChatBody,geminiChatReply} from './gemini-chat.mjs';
import {redactChatText,chatReply} from './chat-stream.mjs';
import {atomicJson,records,loadAsset,userError,assertNoCredentials,safeId} from './workspace.mjs';
import {appendPromptAssetSources} from './prompt-assets.mjs';
import {localMiaoCredentialService,normalizeMiaoCredential,resolveMiaoCredential} from './miao-credentials.mjs';
import {clearCanvasApiCredentialMap} from './canvas-images.mjs';

const cliExecutor=executor=>['codex','gemini-cli'].includes(executor);
const cliProof=step=>step.llm.executor==='gemini-cli'?step.geminiCliProgram:step.codexProgram;
const imageTypes=new Set(['image/png','image/jpeg','image/webp']);
const videoTypes=new Set(['video/mp4','video/webm','video/quicktime']);
const audioTypes=new Set(CHAT_AUDIO_TYPES);
const referenceLimitMessage='语言模型每次最多8张图片、3份视频及1份音频';

export function normalizeLlmBinding(b){
 assertNoCredentials(b);
 const p=b?.platform,m=Array.isArray(p?.models)?p.models.find(x=>x?.id===b.model&&x.category==='chat'):null;
 if(!p||!['openai-compatible','gemini'].includes(p.protocol)||!safeId(p.id)||typeof p.name!=='string'||!p.name||p.name.length>80||!m||typeof m.id!=='string'||!m.id||m.id.length>200)throw userError('语言模型绑定缺少有效平台与对话模型');
 if(p.protocol==='gemini'&&!geminiChatModel(m.id))throw userError('Gemini 语言模型须选择有效的原生对话模型');
 const baseUrl=validateApiBaseUrl(p.baseUrl),systemPrompt=b.systemPrompt??'',maxTokens=b.maxTokens??4096,stream=b.stream??true;
 if(typeof systemPrompt!=='string'||systemPrompt.length>16000||!Number.isInteger(maxTokens)||maxTokens<128||maxTokens>8192||typeof stream!=='boolean')throw userError('系统指令最多16000字，输出上限须为128–8192，流式开关须为布尔值');
 const executor=b.executor??'api';if(!['api','codex','gemini-cli'].includes(executor)||executor==='codex'&&p.protocol!=='openai-compatible')throw userError('Codex执行需要OpenAI兼容的Responses服务；原API绑定保持');
 if(executor==='gemini-cli'&&p.protocol!=='gemini')throw userError('本机Gemini执行需要Gemini原生普通对话服务');
 const refs=b.referenceSources??[];
 if(!Array.isArray(refs)||refs.length>CANVAS_LLM_REFERENCE_LIMIT)throw userError(referenceLimitMessage);
 const seen=new Set();
 for(const r of refs){
  if(!r||!!r.sourceNodeId===!!r.assetId||!safeId(r.sourceNodeId||r.assetId))throw userError('语言模型参考素材映射无效');
  const id=JSON.stringify([r.sourceNodeId,r.assetId]);if(seen.has(id))throw userError('语言模型参考素材重复');seen.add(id);
 }
 const videoInputMode=b.videoInputMode??'frames';
 if(!['frames','native'].includes(videoInputMode))throw userError('语言模型视频输入方式无效');
 if(executor==='gemini-cli'&&videoInputMode==='native')throw userError('Gemini CLI语言节点仅发送文字与图片；原视频请保留原API方式');
 if(videoInputMode==='native'&&(p.protocol!=='gemini'||m.videoSupport!==true))throw userError('原视频参考要求 Gemini 原生对话模型，并在 API 设置明确开启原视频理解');
 if(refs.length&&m.referenceSupport!==true&&!(p.protocol==='gemini'&&(m.audioSupport===true||videoInputMode==='native'&&m.videoSupport===true)))throw userError('对话模型未开启图片、原视频或音频输入能力');
 const model={id:m.id,label:String(m.label||m.id).slice(0,120),category:'chat',referenceSupport:m.referenceSupport===true,...(p.protocol==='gemini'?{audioSupport:m.audioSupport===true,videoSupport:m.videoSupport===true}:{})};
 return{...(b.executor===undefined?{}:{executor}),platform:{id:p.id,name:p.name,protocol:p.protocol,baseUrl,models:[model]},model:m.id,systemPrompt,maxTokens,...(b.videoInputMode===undefined?{}:{videoInputMode}),stream:p.protocol==='gemini'||cliExecutor(executor)?false:stream,includeUpstream:b.includeUpstream!==false,referenceSources:refs.map(r=>r.sourceNodeId?{sourceNodeId:r.sourceNodeId}:{assetId:r.assetId})};
}
function projectReference(project,id){if(!id||!project.assets.some(a=>a.id===id))throw userError('语言模型参考素材不属于当前项目');return id;}
function mediaKind(asset){
 if(imageTypes.has(asset.type))return 'image';
 if(videoTypes.has(asset.type))return 'video';
 if(audioTypes.has(asset.type))return 'audio';
 throw userError('语言模型参考仅支持 PNG/JPEG/WebP 图片、MP4/WebM/MOV 视频及受支持的音频');
}
function allowMedia(binding,kind){
 if(binding.executor==='gemini-cli'&&kind!=='image')throw userError('Gemini CLI语言节点当前接受文字和PNG/JPEG/WebP图片；视频/音频请保留原API执行方式');
 if(binding.executor==='codex'&&kind!=='image')throw userError('Codex语言节点当前接受文字和PNG/JPEG/WebP图片；视频/音频请保留原API执行方式');
 const model=binding.platform.models[0];
 if(kind==='audio'){
  if(binding.platform.protocol!=='gemini'||model.audioSupport!==true)throw userError('音频参考要求 Gemini 原生对话模型，并在 API 设置明确开启音频理解');
 }else if(kind==='video'&&binding.videoInputMode==='native'){
  if(binding.platform.protocol!=='gemini'||model.videoSupport!==true)throw userError('原视频参考要求 Gemini 原生对话模型，并在 API 设置明确开启原视频理解');
 }else if(model.referenceSupport!==true)throw userError('对话模型未开启图片或视频抽样输入能力');
}
function countMedia(counts,kind,count=1){
 counts[kind]+=count;
 if(counts.image>CANVAS_LLM_IMAGE_LIMIT||counts.video>CHAT_VIDEO_LIMIT||counts.audio>CANVAS_LLM_AUDIO_LIMIT)throw userError(referenceLimitMessage);
}
function geminiRequest(binding,text,parts){return geminiChatBody([{role:'user',parts:[{text},...parts.map(geminiChatPart)]}],binding.systemPrompt,binding.maxTokens);}

export async function llmStep({data,project,node,binding,parents,text,promptReferences=[],nativeReferences}){
 if(!['text','script'].includes(node.type))throw userError('语言模型仅可绑定文本或剧本节点');
 const llm=normalizeLlmBinding({...binding,referenceSources:appendPromptAssetSources(binding.referenceSources,promptReferences)}),prompt=llm.includeUpstream?text:node.text.trim();
 if(!prompt||prompt.length>32000)throw userError('语言模型输入须为1–32000字');
 let codexProgram;if(llm.executor==='codex'){codexProgram=(await codexChatProgram()).public;if(!codexProgram.available)throw userError(codexProgram.message);}
 const references=nativeReferences??llm.referenceSources;
 if(!Array.isArray(references)||references.length>CANVAS_LLM_REFERENCE_LIMIT)throw userError(referenceLimitMessage);
 let geminiCliProgram;if(llm.executor==='gemini-cli'){geminiCliProgram=(await resolveGeminiCliProgram()).public;if(!geminiCliProgram.available)throw userError(geminiCliProgram.message);}
 let codexKnownBytes=0;const codexKnownIds=new Set(),staticIds=[],audioReferences=[],referenceDetails=[],counts={image:0,video:0,audio:0},seenReferences=new Set();
 for(const r of references){
  if(!r||!!r.sourceNodeId===!!r.assetId||!safeId(r.sourceNodeId||r.assetId)||r.expectedCount!==undefined&&(!r.sourceNodeId||!Number.isInteger(r.expectedCount)||r.expectedCount<1||r.expectedCount>64))throw userError('语言模型展开参考素材映射无效');
  const referenceKey=JSON.stringify([r.sourceNodeId,r.assetId]);if(nativeReferences!==undefined&&seenReferences.has(referenceKey))throw userError('语言模型展开参考素材重复');seenReferences.add(referenceKey);
  let id=r.assetId;
  if(r.sourceNodeId){
   const n=project.nodes.find(n=>n.id===r.sourceNodeId);
   if(!n||!['image','video','audio'].includes(n.type)||!parents.has(n.id))throw userError('语言模型动态参考必须来自相连上游图片、视频或音频节点');
   if(n.params?.workflowBinding||n.params?.cloudBinding||n.params?.imageBinding||n.params?.studioBinding){
    const count=nativeReferences===undefined?1:r.expectedCount??1;allowMedia(llm,n.type);countMedia(counts,n.type,count);
    referenceDetails.push({sourceNodeId:n.id,name:n.title,kind:n.type,dynamic:true,...(nativeReferences===undefined?{}:{expectedCount:count})});
    if(n.type==='audio')audioReferences.push({sourceNodeId:n.id,name:n.title,dynamic:true});
    continue;
   }
   if(r.expectedCount!==undefined)throw userError('语言模型待生成参考必须来自已绑定的上游节点');
   id=n.assetId;
  }
  staticIds.push(projectReference(project,id));
  const a=await loadAsset(data,id),kind=mediaKind(a);if(cliExecutor(llm.executor)&&!codexKnownIds.has(a.id)){codexKnownIds.add(a.id);if((codexKnownBytes+=a.size)>18*1024**2)throw userError('CLI已知参考图原字节合计超过18MiB，尚未运行');}allowMedia(llm,kind);countMedia(counts,kind);
  if(r.sourceNodeId&&project.nodes.find(n=>n.id===r.sourceNodeId)?.type!==kind)throw userError('语言模型参考文件类型与上游节点类型不一致');
  referenceDetails.push({assetId:a.id,name:a.name,kind,...(r.sourceNodeId?{sourceNodeId:r.sourceNodeId}:{})});
  if(kind==='audio')audioReferences.push({assetId:a.id,name:a.name,type:a.type,size:a.size});
 }
 const uniqueIds=[...new Set(staticIds)],preview=await prepareChatMedia({data,assetIds:uniqueIds,videoInputMode:llm.videoInputMode});
 // Reject oversized known inputs before authorization and before creating a job.
 if(llm.platform.protocol==='gemini'){
  const refs=await chatReferenceParts({data,assetIds:uniqueIds,videoSamples:preview.videoSamples,nativeVideos:preview.nativeVideos,multimodal:llm.platform.models[0].referenceSupport,protocol:'gemini'});
  geminiRequest(llm,prompt,refs.parts);
 }
 return{...(codexProgram?{codexProgram}:{}),...(geminiCliProgram?{geminiCliProgram}:{}),kind:'canvas-llm',nodeId:node.id,title:node.title,llm,text:prompt,count:1,status:'pending',sendAssets:references.length>0,sendNativeVideo:llm.videoInputMode==='native'&&counts.video>0,videoSamples:preview.videoSamples,nativeVideos:preview.nativeVideos,audioReferences,referenceDetails};
}

export function llmCredentials(steps,body,{resume=false}={}){
 const required=steps.filter(s=>s.kind==='canvas-llm'&&s.status!=='completed'&&(!resume||!s.jobId)),provided=body.llmCredentials??[];
 if(!Array.isArray(provided)||provided.length!==required.length||new Set(provided.map(x=>x?.nodeId)).size!==provided.length)throw userError('请为每个待提交语言模型节点分别填写密钥和授权');
 const keys=new Map();
 try{for(const s of required){
  const id=s.executionId||s.nodeId,item=provided.find(x=>x?.nodeId===id);
  if(!item)throw userError('本次语言模型密钥无效');
  const credential=normalizeMiaoCredential(item,s.llm.platform,{purpose:'chat',allowEmptyLocal:false});
  const a=resume?s.authorization:item.authorization,origin=new URL(s.llm.platform.baseUrl).origin;
  if(!a||a.origin!==origin||a.model!==s.llm.model||a.sendPrompt!==true||a.sendReferences!==s.sendAssets||a.requestLimit!==1||!Number.isFinite(a.budget)||a.budget<=0||!['CNY','USD'].includes(a.currency))throw userError('请逐个确认语言模型服务、模型、文字/图片/视频抽样/音频范围、正预算和一次调用');
  if(s.sendNativeVideo&&a.sendNativeVideo!==true)throw userError('请明确确认此语言模型节点发送原视频文件及其声音范围');
  if(cliExecutor(s.llm.executor)&&(a.programSha256!==cliProof(s)?.sha256||a.programEntrySha256!==cliProof(s)?.entrySha256||a.programVersion!==cliProof(s)?.version))throw userError('请确认本机CLI程序版本与文件指纹，程序变化后须重新检查');
  if(!resume)s.authorization={...(cliExecutor(s.llm.executor)?{programSha256:a.programSha256,programEntrySha256:a.programEntrySha256,programVersion:a.programVersion}:{}),origin,model:s.llm.model,sendPrompt:true,sendReferences:s.sendAssets,requestLimit:1,budget:a.budget,currency:a.currency,...(s.sendNativeVideo?{sendNativeVideo:true}:{})};
  keys.set(id,credential.credentialSource==='manual'?credential.apiKey:credential);
 }
 return keys;}catch(error){clearCanvasApiCredentialMap(keys);throw error;}
}
export function llmCredentialPayload(value){return typeof value==='string'?{apiKey:value}:{...value};}
export function clearLlmCredentials(body){if(Array.isArray(body?.llmCredentials))for(const item of body.llmCredentials)if(item&&typeof item==='object'){item.apiKey='';delete item.credentialSource;delete item.credentialConsent;}}

export function canvasLlmService({data,activeJobs,miaoCredentials=localMiaoCredentialService(),apiCall=safeApiCall,codexChats,geminiCliChats}){
 const file=id=>path.join(data,'jobs',id+'.json');
 const submissionLocks=new Map();
 async function startFromCanvas(step,project,credentialBody,parentId){
  const previous=submissionLocks.get(project.id)||Promise.resolve();let release;
  const current=new Promise(resolve=>{release=resolve;});submissionLocks.set(project.id,current);await previous;
  try{return await startUnlocked(step,project,credentialBody,parentId);}
  finally{credentialBody.apiKey='';delete credentialBody.credentialSource;delete credentialBody.credentialConsent;release();if(submissionLocks.get(project.id)===current)submissionLocks.delete(project.id);}
 }
 async function startUnlocked(step,project,credentialBody,parentId){
  let credential;
  try{
  const {requestId}=credentialBody;
  if(activeJobs.get(parentId)?.kind!=='canvas-run'||activeJobs.get(parentId)?.projectId!==project.id||!safeId(requestId))throw userError('语言模型子任务缺少活动画布任务');
  const previous=(await records(path.join(data,'jobs'))).find(j=>j.kind==='canvas-llm'&&j.projectId===project.id&&j.requestId===requestId);if(previous)return previous;
  const node=project.nodes.find(node=>node.id===step.nodeId);
  if(!node||!['text','script'].includes(node.type)||step.kind!=='canvas-llm'||step.count!==1||typeof step.sendAssets!=='boolean')throw userError('语言模型子任务节点或执行范围无效');
  const b=normalizeLlmBinding(step.llm);if(!step.text?.trim()||step.text.length>32000)throw userError('语言模型输入须为1–32000字');
  credential=normalizeMiaoCredential(credentialBody,b.platform,{purpose:'chat',allowEmptyLocal:false});
  const a=step.authorization,origin=new URL(b.platform.baseUrl).origin;
  if(!a||a.origin!==origin||a.model!==b.model||a.sendPrompt!==true||a.sendReferences!==step.sendAssets||a.requestLimit!==1||!Number.isFinite(a.budget)||a.budget<=0||!['CNY','USD'].includes(a.currency))throw userError('此语言模型节点缺少服务、模型、发送范围、正预算或一次调用授权');
  if(cliExecutor(b.executor)&&(a.programSha256!==cliProof(step)?.sha256||a.programEntrySha256!==cliProof(step)?.entrySha256||a.programVersion!==cliProof(step)?.version))throw userError('CLI程序缺少本次指纹确认');
  const ids=b.referenceSources.map(r=>projectReference(project,r.assetId||project.nodes.find(n=>n.id===r.sourceNodeId)?.assetId)),media=await Promise.all(ids.map(id=>loadAsset(data,id))),counts={image:0,video:0,audio:0};
  for(const a of media){const kind=mediaKind(a);allowMedia(b,kind);countMedia(counts,kind);}
  const uniqueIds=[...new Set(ids)],videoSamples=(step.videoSamples||[]).filter(s=>uniqueIds.includes(s.assetId)),nativeVideos=(step.nativeVideos||[]).filter(s=>uniqueIds.includes(s.assetId));
  if(uniqueIds.length&&!a.sendReferences)throw userError('此语言模型节点未授权发送参考素材');
  if(b.videoInputMode==='native'&&videoSamples.length||b.videoInputMode!=='native'&&nativeVideos.length)throw userError('视频输入方式与已确认的预览不一致，请重新检查画布计划');
  if(b.videoInputMode==='native'&&counts.video>0&&step.authorization?.sendNativeVideo!==true)throw userError('此节点缺少原视频文件及声音范围授权，请重新检查画布计划');
  // Fixed video previews remain stable; generated upstream media is checked only
  // after generation completes. Audio bytes are sent inline with the request.
  const unprepared=uniqueIds.filter(id=>![...videoSamples,...nativeVideos].some(s=>s.assetId===id));
  const fresh=await prepareChatMedia({data,assetIds:unprepared,videoInputMode:b.videoInputMode});videoSamples.push(...fresh.videoSamples);nativeVideos.push(...fresh.nativeVideos);
  const refs=cliExecutor(b.executor)?{parts:[],encodedBytes:0}:await chatReferenceParts({data,assetIds:uniqueIds,videoSamples,nativeVideos,multimodal:b.platform.models[0].referenceSupport,protocol:b.platform.protocol});
  if(refs.encodedBytes>CHAT_MEDIA_LIMIT)throw userError('语言模型参考素材合计过大');
  const content=[{type:'text',text:step.text},...refs.parts],native=b.platform.protocol==='gemini';
  const body=native?geminiRequest(b,step.text,refs.parts):{model:b.model,messages:[...(b.systemPrompt?[{role:'system',content:b.systemPrompt}]:[]),{role:'user',content:content.length===1?step.text:content}],max_tokens:b.maxTokens,stream:b.stream};
  activeJobs.get(parentId)?.controller?.signal.throwIfAborted();
  let key='';
  try{
   const resolved=await resolveMiaoCredential(credential,b.platform,miaoCredentials,{purpose:'chat'});key=resolved.apiKey;resolved.apiKey='';
  }finally{credential.apiKey='';delete credential.credentialSource;delete credential.credentialConsent;}
  if(typeof key!=='string'||!key||key.length>4096||/[\r\n]/.test(key)||JSON.stringify({project,step,body}).includes(key)){key='';throw userError('语言模型本次密钥无效或输入中含密钥');}
  try{activeJobs.get(parentId)?.controller?.signal.throwIfAborted();}catch(error){key='';throw error;}
  const audioReferences=media.filter(a=>audioTypes.has(a.type)).map(a=>({assetId:a.id,name:a.name,type:a.type,size:a.size}));
  const job={id:randomUUID(),kind:'canvas-llm',parentId,projectId:project.id,requestId,nodeId:step.nodeId,name:step.title,createdAt:new Date().toISOString(),status:'queued',progress:0,message:'等待语言模型回答',outputText:'',assets:[],requestCount:0,input:{...(b.executor==='codex'?{executor:'codex',codexProgram:step.codexProgram}:{}),...(b.executor==='gemini-cli'?{executor:'gemini-cli',geminiCliProgram:step.geminiCliProgram}:{}),model:b.model,platform:b.platform,text:step.text,systemPrompt:b.systemPrompt,maxTokens:b.maxTokens,stream:b.stream,referenceIds:uniqueIds,videoInputMode:b.videoInputMode,videoSamples,nativeVideos,audioReferences},authorization:{...(cliExecutor(b.executor)?{programSha256:a.programSha256,programEntrySha256:a.programEntrySha256,programVersion:a.programVersion}:{}),origin,model:b.model,sendPrompt:true,sendReferences:a.sendReferences,requestLimit:1,budget:a.budget,currency:a.currency,...(step.sendNativeVideo?{sendNativeVideo:true}:{})}};
  try{await atomicJson(file(job.id),job);}catch(error){key='';throw error;}
  const controller=new AbortController(),unlink=linkCanvasChild(activeJobs,parentId,controller);activeJobs.set(job.id,{controller,projectId:project.id,kind:'canvas-llm',parentId});
  void(async()=>{
   let received='',lastSave=0;
   try{
    controller.signal.throwIfAborted();job.status='running';job.requestCount=cliExecutor(b.executor)?0:1;job.message='正在接收语言模型回答';await atomicJson(file(job.id),job);
    if(b.executor==='codex'){
     if(!codexChats)throw userError('画布Codex执行器尚未接通，未发送');
     // The linked immutable record is the authority after restart. Its ID is
     // deterministic and recorded before either the CLI or provider can start.
     job.codexTaskId='codex-'+job.id;job.requestCount=0;job.message='正在准备已确认的Codex语言任务';await atomicJson(file(job.id),job);
     let child;
     const abort=()=>{void codexChats.stop(job.codexTaskId,job.projectId).catch(()=>{});};controller.signal.addEventListener('abort',abort,{once:true});
     try{
      controller.signal.throwIfAborted();child=await codexChats.startFromCanvas(step,project,{apiKey:key},parentId,job.id);key='';
      if(controller.signal.aborted)await codexChats.stop(child.id,job.projectId);
      for(;;){child=await codexChats.get(child.id,job.projectId);job.requestCount=child.requestCount;job.outputText=child.response?.text||'';job.message=child.status==='running'?'本机Codex正在等待本次唯一回答':'原Codex收据已保存';await atomicJson(file(job.id),job);if(!['running','stopping'].includes(child.status))break;await new Promise(r=>setTimeout(r,80));}
     }finally{controller.signal.removeEventListener('abort',abort);}
     received=child.response?.text||'';job.outputText=received;job.finishReason=child.canApply?'stop':'incomplete';job.status=child.canApply?'completed':child.status==='stopped'?'cancelled':child.response?.text?'incomplete':'failed';job.progress=child.canApply?100:0;job.uncertain=child.status==='uncertain';job.message=child.canApply?'Codex完整回答已保存，可用于当前画布流程':'Codex原收据保留，后续未提交，不会自动重发';return;
    }
    if(b.executor==='gemini-cli'){
     if(!geminiCliChats)throw userError('画布Gemini执行器尚未接通，未发送');
     // The linked immutable record is the authority after restart. Its ID is
     // deterministic and recorded before either the CLI or provider can start.
     job.geminiCliTaskId='gemini-cli-'+job.id;job.requestCount=0;job.message='正在准备已确认的Gemini语言任务';await atomicJson(file(job.id),job);
     let child;
     const abort=()=>{void geminiCliChats.stop(job.geminiCliTaskId,job.projectId).catch(()=>{});};controller.signal.addEventListener('abort',abort,{once:true});
     try{
      controller.signal.throwIfAborted();child=await geminiCliChats.startFromCanvas(step,project,{apiKey:key},parentId,job.id);key='';
      if(controller.signal.aborted)await geminiCliChats.stop(child.id,job.projectId);
      for(;;){child=await geminiCliChats.get(child.id,job.projectId);job.requestCount=child.requestCount;job.outputText=child.response?.text||'';job.message=child.status==='running'?'本机Gemini正在等待本次唯一回答':'原Gemini收据已保存';await atomicJson(file(job.id),job);if(!['running','stopping'].includes(child.status))break;await new Promise(r=>setTimeout(r,80));}
     }finally{controller.signal.removeEventListener('abort',abort);}
     received=child.response?.text||'';job.outputText=received;job.finishReason=child.canApply?'stop':'incomplete';job.status=child.canApply?'completed':child.status==='stopped'?'cancelled':child.response?.text?'incomplete':'failed';job.progress=child.canApply?100:0;job.uncertain=child.status==='uncertain';job.message=child.canApply?'Gemini完整回答已保存，可用于当前画布流程':'Gemini原收据保留，后续未提交，不会自动重发';return;
    }
    const response=await apiCall({baseUrl:b.platform.baseUrl,path:native?'models/'+b.model+':generateContent':'chat/completions',method:'POST',apiKey:key,...(native?{authMode:'gemini'}:{}),body,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(180000)]),responseType:!native&&b.stream?'chat-stream':'json',onDelta:async text=>{
     received=text;job.outputText=redactChatText(text,key);if(Date.now()-lastSave>=250){await atomicJson(file(job.id),job);lastSave=Date.now();}
    }});
    const result=native?geminiChatReply(response):b.stream?response:chatReply(response);
    received=result.text;job.outputText=redactChatText(received,key,true);job.finishReason=result.finishReason;controller.signal.throwIfAborted();
    job.status=result.complete?'completed':'incomplete';job.progress=100;job.uncertain=false;job.message=result.complete?'完整回答已保存':'回答未完成，片段已保留；不会传给下游或自动续写';
   }catch(e){
    job.outputText=redactChatText(received,key,true);job.status=controller.signal.aborted?'cancelled':'failed';job.uncertain=job.requestCount>0&&e.uncertain!==false;
    job.message=controller.signal.aborted?'已停止等待，片段保留；不会自动重发':redactChatText(typeof e.publicMessage==='string'?e.publicMessage:'语言模型请求未确认；不会自动重发',key,true);
   }finally{
    unlink();key='';try{await atomicJson(file(job.id),job);}finally{activeJobs.delete(job.id);}
   }
  })();
  return structuredClone(job);
  }finally{if(credential){credential.apiKey='';delete credential.credentialSource;delete credential.credentialConsent;}}
 }
 async function refresh(job){
  if(job.kind==='canvas-llm'&&job.input?.executor==='gemini-cli'&&job.geminiCliTaskId&&!activeJobs.has(job.id)){
   try{const child=await geminiCliChats.get(job.geminiCliTaskId,job.projectId);
    if(child.parentId!==job.id||child.plan.text!==job.input.text||child.plan.model!==job.input.model||child.plan.systemPrompt!==job.input.systemPrompt||child.plan.program.sha256!==job.input.geminiCliProgram?.sha256)throw userError('Gemini原收据与语言节点不对应');
    job.requestCount=child.requestCount;job.outputText=child.response?.text||'';job.status=child.canApply?'completed':child.response?.text?'incomplete':child.status==='stopped'?'cancelled':'interrupted';job.progress=child.canApply?100:0;job.uncertain=child.status==='uncertain';job.finishReason=child.canApply?'stop':'incomplete';job.message=child.canApply?'已读取原Gemini完整回答；没有重启程序或重发':'原Gemini记录保留，未重发；请核对原任务';return job;
   }catch(e){if(e.code==='ENOENT')return job;throw e;}
  }

  if(job.kind!=='canvas-llm'||job.input?.executor!=='codex'||!job.codexTaskId||activeJobs.has(job.id))return job;
  try{const child=await codexChats.get(job.codexTaskId,job.projectId);job.requestCount=child.requestCount;job.outputText=child.response?.text||'';job.status=child.canApply?'completed':child.response?.text?'incomplete':child.status==='stopped'?'cancelled':'interrupted';job.progress=child.canApply?100:0;job.uncertain=child.status==='uncertain';job.finishReason=child.canApply?'stop':'incomplete';job.message=child.canApply?'已读取原Codex完整回答；没有重启程序或重发':'原Codex记录保留，未重发；请核对原任务';return job;}catch(e){if(e.code==='ENOENT')return job;throw e;}
 }
 async function recover(){for(const j of await records(path.join(data,'jobs')))if(j.kind==='canvas-llm'&&cliExecutor(j.input?.executor)){const before=JSON.stringify(j),after=await refresh(j);if(JSON.stringify(after)!==before)await atomicJson(file(j.id),after);}}
 return{startFromCanvas,refresh,recover};
}
