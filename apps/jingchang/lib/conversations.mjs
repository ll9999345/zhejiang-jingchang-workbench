import {prepareConversationGeminiCli,geminiConversationAuthorization,runConversationGeminiCli,updateConversationGeminiCli} from './conversation-gemini-cli.mjs';
import {prepareConversationCodex,codexConversationAuthorization,runConversationCodex,updateConversationCodex} from './conversation-codex.mjs';
import {localMiaoCredentialService,normalizeMiaoCredential,resolveMiaoCredential} from './miao-credentials.mjs';
import {prepareAgent,agentAuthorization,agentImageCredential,runConversationAgent,conversationSystemPrompt} from './conversation-agent.mjs';
import {prepareConversationImage,runConversationImage} from './conversation-images.mjs';
import {redactChatText,chatReply} from './chat-stream.mjs';
import {geminiChatPart,geminiChatBody,geminiChatReply} from './gemini-chat.mjs';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {safeApiCall,generateImage} from './image-api.mjs';
import {chatAssetIds,chatReferenceParts,loadChatReferences,CHAT_MEDIA_LIMIT} from './chat-media.mjs';
import {atomicJson,readJson,records,safeId,textValue,userError,loadAsset} from './workspace.mjs';

// Conversational routing only permits validated chat/image actions. Canvas
// operation plans remain separate and require their own application flow.
export function conversationService({data,platforms,activeJobs,projects,miaoCredentials=localMiaoCredentialService(),apiCall=safeApiCall,agentImageGenerator=generateImage,codexChats,geminiCliChats}) {
 const directory=path.join(data,'conversations'),locks=new Map();
 const id=value=>{if(!safeId(value))throw userError('编号无效');return value;};
 const file=value=>path.join(directory,id(value)+'.json');
 const jobFile=value=>path.join(data,'jobs',id(value)+'.json');
 async function lock(key,fn){const task=(locks.get(key)||Promise.resolve()).catch(()=>{}).then(fn);locks.set(key,task);try{return await task;}finally{if(locks.get(key)===task)locks.delete(key);}}
 const get=value=>readJson(file(value));
 async function persist(c){await atomicJson(path.join(directory,'history',c.id,`${c.revision}-${randomUUID()}.json`),c);await atomicJson(file(c.id),c);return c;}
 async function create(body){await projects.load(id(body.projectId));const now=new Date().toISOString();return persist({id:randomUUID(),projectId:body.projectId,name:textValue(body.name||'新对话',120,'对话名称'),revision:0,createdAt:now,updatedAt:now,messages:[],requests:[]});}
 async function list(projectId){id(projectId);return (await records(directory)).filter(c=>c.projectId===projectId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(({id,name,revision,updatedAt})=>({id,name,revision,updatedAt}));}
 async function rename(value,body){return lock(value,async()=>{const c=await get(value);if(c.revision!==body.revision)throw userError('对话已更新，请刷新',409);if(body.name!==undefined)c.name=textValue(body.name,120,'对话名称');if(body.systemPrompt!==undefined)c.systemPrompt=conversationSystemPrompt(body.systemPrompt);c.revision++;c.updatedAt=new Date().toISOString();return persist(c);});}
 async function context(messages,multimodal,protocol='openai-compatible'){
  const sent=messages.filter(m=>m.state!=='incomplete').slice(-20),cache=new Map();let size=0,textSize=0;
  const result=[];
  for(const m of sent){
   textSize+=m.text.length;if(textSize>100000)throw userError('最近20条对话超过10万字，请新建对话');
   const key=JSON.stringify([m.assetIds||[],m.videoSamples||[],m.nativeVideos||[],m.documentSamples||[],protocol]);
   if(!cache.has(key))cache.set(key,await chatReferenceParts({data,assetIds:m.assetIds||[],videoSamples:m.videoSamples||[],nativeVideos:m.nativeVideos||[],documentSamples:m.documentSamples||[],multimodal,protocol}));
   const refs=cache.get(key);size+=refs.encodedBytes;if(size>CHAT_MEDIA_LIMIT)throw userError('本次上下文图片及视频抽样合计过大，请新建对话或减少素材');
   if(protocol==='gemini')result.push({role:m.role==='assistant'&&m.mode==='image'?'user':m.role==='assistant'?'model':'user',parts:[{text:m.text},...refs.parts.map(geminiChatPart)]});
   else result.push({role:m.role==='assistant'&&m.mode==='image'?'user':m.role,content:refs.parts.some(p=>p.type==='image_url')?[{type:'text',text:m.text},...refs.parts]:[m.text,...refs.parts.map(p=>p.text)].join('\n\n')});
  }
  return result;
 }
 async function agentPreview(value,body){const c=await get(value);if(c.revision!==body.revision)throw userError('对话已更新，请重新检查',409);const text=textValue(body.text,20000,'消息');chatAssetIds(body.assetIds||[]);const platform=await platforms.get(body.platformId),model=platform.models.find(m=>m.id===body.model&&m.category==='chat');if(!model||platform.protocol!=='openai-compatible')throw userError('请选择兼容对话模型');const systemPrompt=conversationSystemPrompt(body.systemPrompt??c.systemPrompt??''),{videoSamples,documentSamples}=await loadChatReferences({data,assetIds:body.assetIds||[],videoSampleIds:body.videoSampleIds,documentSampleIds:body.documentSampleIds}),user={role:'user',text,assetIds:body.assetIds||[],videoSamples,documentSamples},messages=await context([...c.messages,user],model.referenceSupport),prepared=await prepareAgent({data,platforms,conversation:c,body,text,platform,model,systemPrompt});return {hash:prepared.hash,revision:c.revision,router:{baseUrl:platform.baseUrl,model:model.id,requestLimit:2},image:prepared.image,context:{messages:messages.length,images:messages.reduce((n,m)=>n+(Array.isArray(m.content)?m.content.filter(p=>p.type==='image_url').length:0),0),documentSamples:[...new Map([...c.messages,user].filter(m=>m.state!=='incomplete').slice(-20).flatMap(m=>m.documentSamples||[]).map(s=>[s.id,s])).values()],videoSamples:[...new Map([...c.messages,user].filter(m=>m.state!=='incomplete').slice(-20).flatMap(m=>m.videoSamples||[]).map(s=>[s.id,s])).values()]},systemPrompt};}
 async function codexPreview(value,body){
  const c=await get(value);if(c.revision!==body.revision)throw userError('对话已更新，请重新检查',409);
  if((body.mode??'chat')!=='chat'||body.executor!=='codex')throw userError('请选择Codex文字对话执行方式');
  const text=textValue(body.text,20000,'消息'),assetIds=body.assetIds||[];chatAssetIds(assetIds);
  const platform=await platforms.get(body.platformId),model=platform.models.find(m=>m.id===body.model&&m.category==='chat');if(!model||platform.protocol!=='openai-compatible')throw userError('请选择支持Responses的兼容对话模型');
  const systemPrompt=conversationSystemPrompt(body.systemPrompt??c.systemPrompt??''),refs=await loadChatReferences({data,assetIds,videoSampleIds:body.videoSampleIds,nativeVideoIds:body.nativeVideoIds,documentSampleIds:body.documentSampleIds,protocol:platform.protocol}),user={id:'current',role:'user',mode:'chat',text,assetIds,...refs},messages=await context([...c.messages,user],model.referenceSupport,platform.protocol),prepared=await prepareConversationCodex({data,conversation:c,user,messages,project:await projects.load(c.projectId),platform,model,systemPrompt,maxTokens:body.maxTokens??4096,codexChats});return prepared.checked;
 }
 async function geminiCliPreview(value,body){
  const c=await get(value);if(c.revision!==body.revision)throw userError('对话已更新，请重新检查',409);
  if((body.mode??'chat')!=='chat'||body.executor!=='gemini-cli')throw userError('请选择Gemini CLI文字对话执行方式');
  const text=textValue(body.text,20000,'消息'),assetIds=body.assetIds||[];chatAssetIds(assetIds);
  const platform=await platforms.get(body.platformId),model=platform.models.find(m=>m.id===body.model&&m.category==='chat');if(!model||platform.protocol!=='gemini')throw userError('请选择Gemini原生普通对话模型');
  const systemPrompt=conversationSystemPrompt(body.systemPrompt??c.systemPrompt??''),refs=await loadChatReferences({data,assetIds,videoSampleIds:body.videoSampleIds,nativeVideoIds:body.nativeVideoIds,documentSampleIds:body.documentSampleIds,protocol:platform.protocol}),user={id:'current',role:'user',mode:'chat',text,assetIds,...refs},messages=await context([...c.messages,user],model.referenceSupport,platform.protocol),prepared=await prepareConversationGeminiCli({data,conversation:c,user,messages,project:await projects.load(c.projectId),platform,model,systemPrompt,maxTokens:body.maxTokens??4096,geminiCliChats});return prepared.checked;
 }
 async function send(value,body){
  const managed=body?.credentialSource==='miao-local'||body?.agent?.credentialSource==='miao-local';let routerKey='',resolvedImageKey='';
  try{return await lock(value,async()=>{
  id(body.requestId);const c=await get(value),previous=c.requests.find(r=>r.requestId===body.requestId);if(previous)return readJson(jobFile(previous.jobId));
  const orphan=(await records(path.join(data,'jobs'))).find(j=>(['conversation-image','conversation-agent'].includes(j.kind)||j.kind==='conversation'&&['codex','gemini-cli'].includes(j.input?.executor))&&j.conversationId===value&&j.requestId===body.requestId);
  if(orphan){if((orphan.kind==='conversation-agent'?mergeAgentJob:orphan.kind==='conversation'&&orphan.input?.executor==='gemini-cli'?mergeGeminiCliJob:orphan.kind==='conversation'&&orphan.input?.executor==='codex'?mergeCodexJob:mergeImageJob)(c,orphan)){c.revision++;c.updatedAt=new Date().toISOString();await persist(c);}return orphan;}
  if(c.revision!==body.revision)throw userError('对话已更新，请刷新后发送',409);
  if([...activeJobs.values()].some(j=>j.conversationId===value))throw userError('请等待当前回答完成',409);
  if(c.messages.length>=199)throw userError('当前对话已达200条，请新建对话');
  const text=textValue(body.text,20000,'消息'),assetIds=body.assetIds||[];
  chatAssetIds(assetIds);
  const mode=body.mode??'chat';if(!['chat','image','agent'].includes(mode))throw userError('对话模式无效');if(body.includeGeminiHistory!==undefined&&typeof body.includeGeminiHistory!=='boolean')throw userError('Gemini 连续会话开关无效');
  const platform=await platforms.get(body.platformId),model=platform.models.find(m=>m.id===body.model&&m.category===(mode==='agent'?'chat':mode));
  if(!model)throw userError(mode==='image'?'请选择已保存的图片模型':'请选择已保存的对话模型');
  if(mode==='image'? !['openai-compatible','gemini'].includes(platform.protocol):mode==='agent'?platform.protocol!=='openai-compatible':!['openai-compatible','gemini'].includes(platform.protocol))throw userError(mode==='image'?'图片模式当前不支持此协议':mode==='agent'?'Agent 路由当前要求 Chat Completions 兼容平台':'当前对话协议不支持');
  const executor=body.executor??'api';if(!['api','codex','gemini-cli'].includes(executor)||executor==='codex'&&(mode!=='chat'||platform.protocol!=='openai-compatible'))throw userError('Codex只用于支持Responses的兼容文字对话，原图片/Agent执行方式保持');
  if(executor==='gemini-cli'&&(mode!=='chat'||platform.protocol!=='gemini'))throw userError('Gemini CLI只用于Gemini原生普通文字对话');
  const systemPrompt=conversationSystemPrompt(body.systemPrompt??c.systemPrompt??'');
  if(mode!=='chat'&&(body.nativeVideoIds!==undefined&&(!Array.isArray(body.nativeVideoIds)||body.nativeVideoIds.length)))throw userError('原视频输入仅支持 Gemini 文字对话');
  const {videoSamples,nativeVideos,documentSamples}=mode!=='image'?await loadChatReferences({data,assetIds,videoSampleIds:body.videoSampleIds,nativeVideoIds:body.nativeVideoIds,documentSampleIds:body.documentSampleIds,protocol:platform.protocol}):{videoSamples:[],nativeVideos:[],documentSamples:[]};
  const user={id:randomUUID(),role:'user',mode,text,assetIds,...(platform.protocol==='gemini'&&mode==='image'?{nativeImage:{protocol:'gemini',baseUrl:platform.baseUrl,modelId:model.id}}:{}),...(videoSamples.length?{videoSamples}:{}),...(nativeVideos.length?{nativeVideos}:{}),...(documentSamples.length?{documentSamples}:{}),createdAt:new Date().toISOString()},prepared=mode==='image'?await prepareConversationImage({data,platform,model,text,assetIds,body,conversation:c,includeGeminiHistory:body.includeGeminiHistory===true}):null,messages=mode!=='image'?await context([...c.messages,user],model.referenceSupport,platform.protocol):[];
  const agent=mode==='agent'?await prepareAgent({data,platforms,conversation:c,body,text,platform,model,systemPrompt}):null,imageAuthorization=agent?agentAuthorization(agent,body):null;
  const origin=new URL(platform.baseUrl).origin,a=body.authorization,historyImages=prepared?.input.geminiHistory?.reduce((n,m)=>n+(m.parts||[]).filter(p=>p.type==='image').length,0)||0,hasReferences=mode==='image'?assetIds.length+historyImages>0:messages.some(m=>Array.isArray(m.content)||Array.isArray(m.parts)&&m.parts.length>1),hasAudio=mode==='chat'&&messages.some(m=>m.parts?.some(p=>p.inlineData?.mimeType?.startsWith('audio/')));
  if(hasAudio&&(platform.protocol!=='gemini'||model.audioSupport!==true))throw userError('当前模型未启用音频理解；请在 API 设置核对模型文档后明确开启');
  const hasNativeVideo=mode==='chat'&&messages.some(m=>m.parts?.some(p=>p.inlineData?.mimeType?.startsWith('video/')));
  if(hasNativeVideo&&(platform.protocol!=='gemini'||model.videoSupport!==true))throw userError('当前模型未启用原视频理解；请在 API 设置核对模型文档后明确开启');
  if(hasNativeVideo&&a?.sendNativeVideo!==true)throw userError('请明确确认向此 Gemini 服务发送原视频文件及其声音范围');
  if(!a||a.origin!==origin||a.model!==model.id||a.sendPrompt!==true||(hasReferences&&a.sendReferences!==true)||a.requestLimit!==(agent?2:1)||!Number.isFinite(a.budget)||a.budget<=0||!['CNY','USD'].includes(a.currency))throw userError('请确认本次服务、对话上下文、图片/视频抽样/音频/文档发送范围和正预算');
  const credential=normalizeMiaoCredential(body,platform,{purpose:mode==='image'?'image':'chat'}),imageCredential=agent?agentImageCredential(agent,body):null;let inputSnapshot=JSON.stringify({text,systemPrompt,messages,image:agent?.image});
  for(const secret of [credential.apiKey,imageCredential?.apiKey].filter(Boolean))if(inputSnapshot.includes(secret))throw userError('消息或系统指令中含本次 API Key，请移除后再发送');
  if(body.stream!==undefined&&typeof body.stream!=='boolean')throw userError('流式开关须为布尔值');
  const maxTokens=body.maxTokens??4096;if(!Number.isInteger(maxTokens)||maxTokens<128||maxTokens>8192)throw userError('输出上限须为128–8192');
  const nativeBody=mode==='chat'&&platform.protocol==='gemini'?geminiChatBody(messages,systemPrompt,maxTokens):null;
  const codex=executor==='codex'?await prepareConversationCodex({data,conversation:c,user,messages,project:await projects.load(c.projectId),platform,model,systemPrompt,maxTokens,codexChats}):null;
  if(codex){if(codex.checked.fingerprint!==body.codexFingerprint)throw userError('Codex上下文、程序或模型已变化，请重新检查',409);codexConversationAuthorization(codex.checked,a);inputSnapshot+=JSON.stringify(codex.checked.plan);}
  const geminiCli=executor==='gemini-cli'?await prepareConversationGeminiCli({data,conversation:c,user,messages,project:await projects.load(c.projectId),platform,model,systemPrompt,maxTokens,geminiCliChats}):null;
  if(geminiCli){if(geminiCli.checked.fingerprint!==body.geminiCliFingerprint)throw userError('Gemini CLI上下文、程序或模型已变化，请重新检查',409);geminiConversationAuthorization(geminiCli.checked,a);inputSnapshot+=JSON.stringify(geminiCli.checked.plan);}
  // Both destinations, budgets, media and the idempotency record are checked
  // before resolving either private key. Consent belongs only to this send.
  routerKey=(await resolveMiaoCredential(credential,platform,miaoCredentials,{purpose:mode==='image'?'image':'chat'})).apiKey;
  if(agent)resolvedImageKey=(await resolveMiaoCredential(imageCredential,agent.imagePlatform,miaoCredentials,{purpose:'image'})).apiKey;
  for(const secret of [routerKey,resolvedImageKey].filter(Boolean))if(inputSnapshot.includes(secret))throw userError('消息或系统指令中含本次 API Key，请移除后再发送');
  body.apiKey=routerKey;if(agent)body.agent.imageApiKey=resolvedImageKey;
  const job={id:randomUUID(),kind:agent?'conversation-agent':mode==='image'?'conversation-image':'conversation',conversationId:value,projectId:c.projectId,name:c.name,requestId:body.requestId,createdAt:new Date().toISOString(),status:'queued',progress:0,message:mode==='image'?'等待生成图片':'等待模型回答',assets:[],authorization:{origin,model:model.id,protocol:platform.protocol,budget:a.budget,currency:a.currency,sendPrompt:true,sendReferences:hasReferences,requestLimit:agent?2:1,...(hasNativeVideo?{sendNativeVideo:true}:{})},...(agent?{imageAuthorization}:{}),requestCount:0,stream:mode!=='image'&&platform.protocol==='openai-compatible'&&body.stream===true,outputText:'',...(prepared?{input:prepared.input,userMessage:user}:{input:{referenceIds:assetIds,videoSamples,nativeVideos,documentSamples,systemPrompt}})};
  if(codex){job.codexTaskId='codex-'+job.id;job.stream=false;job.userMessage=user;job.input={...job.input,executor:'codex',model:model.id,text,maxTokens,codexPlan:structuredClone(codex.checked.plan),codexFingerprint:codex.checked.fingerprint};Object.assign(job.authorization,{sendReferences:codex.checked.plan.images.length>0,programSha256:a.programSha256,programEntrySha256:a.programEntrySha256,programVersion:a.programVersion});}
  if(geminiCli){job.geminiCliTaskId='gemini-cli-'+job.id;job.stream=false;job.userMessage=user;job.input={...job.input,executor:'gemini-cli',model:model.id,text,maxTokens,geminiCliPlan:structuredClone(geminiCli.checked.plan),geminiCliFingerprint:geminiCli.checked.fingerprint};Object.assign(job.authorization,{sendReferences:geminiCli.checked.plan.images.length>0,programSha256:a.programSha256,programEntrySha256:a.programEntrySha256,programVersion:a.programVersion});}
  if(agent){c.agentSettings={imagePlatformId:agent.image.platformId,imageModel:agent.image.model,imageCount:body.agent.imageCount??'auto',inheritLastImage:body.agent.inheritLastImage===true,size:agent.image.size,quality:agent.image.quality};job.input={...job.input,text,maxTokens,image:agent.image};job.userMessage=user;job.requests=[];job.imageResults=[];}
  if(systemPrompt||c.systemPrompt)c.systemPrompt=systemPrompt;
  c.messages.push({...user,jobId:job.id});c.requests.push({requestId:body.requestId,jobId:job.id});c.revision++;c.updatedAt=user.createdAt;
  await atomicJson(jobFile(job.id),job);try{await persist(c);}catch(e){job.status='failed';job.uncertain=false;job.message='本地对话保存失败，尚未发送至模型';await atomicJson(jobFile(job.id),job);throw e;}
  const controller=new AbortController();activeJobs.set(job.id,{controller,projectId:c.projectId,conversationId:value,kind:job.kind});
  let key=routerKey;routerKey='';body.apiKey='';
  if(agent){let imageKey=resolvedImageKey;resolvedImageKey='';body.agent.imageApiKey='';void runConversationAgent({data,job,platform,imagePlatform:agent.imagePlatform,imageModel:agent.imageModel,messages,routerKey:key,imageKey,controller,persist:j=>atomicJson(jobFile(j.id),j),saveAnswer:saveAgentAnswer,apiCall,imageGenerator:agentImageGenerator}).finally(()=>activeJobs.delete(job.id)).catch(()=>{});imageKey='';}
  else if(prepared)void runConversationImage({data,job,platform,key,references:prepared.references,historyContents:prepared.historyContents,controller,persist:j=>atomicJson(jobFile(j.id),j),saveAnswer:saveImageAnswer}).finally(()=>activeJobs.delete(job.id)).catch(()=>{});
  else if(codex)void runConversationCodex({job,checked:codex.checked,project:codex.project,key,controller,codexChats,persist:j=>atomicJson(jobFile(j.id),j),saveAnswer}).finally(()=>activeJobs.delete(job.id)).catch(()=>{});
  else if(geminiCli)void runConversationGeminiCli({job,checked:geminiCli.checked,project:geminiCli.project,key,controller,geminiCliChats,persist:j=>atomicJson(jobFile(j.id),j),saveAnswer}).finally(()=>activeJobs.delete(job.id)).catch(()=>{});
  else if(platform.protocol==='gemini')void runGemini(job,platform.baseUrl,key,nativeBody,controller).catch(()=>activeJobs.delete(job.id));
  else void run(job,platform.baseUrl,key,[...(systemPrompt?[{role:'system',content:systemPrompt}]:[]),...messages],maxTokens,controller).catch(()=>activeJobs.delete(job.id));
  key='';return job;
  });}finally{
   routerKey='';resolvedImageKey='';
   if(managed){body.apiKey='';delete body.credentialSource;delete body.credentialConsent;if(body.agent&&typeof body.agent==='object'){body.agent.imageApiKey='';delete body.agent.credentialSource;delete body.agent.credentialConsent;}}
  }
 }
 async function saveAnswer(job,state){
  if(!job.outputText?.trim())return;
  await lock(job.conversationId,async()=>{const c=await get(job.conversationId);if(c.messages.some(m=>m.role==='assistant'&&m.jobId===job.id))return;
   c.messages.push({id:job.input?.executor==='gemini-cli'?'gemini-cli-answer-'+job.id:job.input?.executor==='codex'?'codex-answer-'+job.id:randomUUID(),role:'assistant',text:job.outputText,assetIds:[],jobId:job.id,state,finishReason:job.finishReason||null,createdAt:new Date().toISOString()});c.revision++;c.updatedAt=new Date().toISOString();await persist(c);
  });
 }
 function mergeCodexJob(c,job){let changed=false;
  if(c.projectId!==job.projectId)throw userError('Codex原对话归属不匹配');
  if(!c.requests.some(r=>r.requestId===job.requestId)){c.requests.push({requestId:job.requestId,jobId:job.id});changed=true;}
  if(job.userMessage&&!c.messages.some(m=>m.role==='user'&&m.jobId===job.id)){c.messages.push({...job.userMessage,jobId:job.id});changed=true;}
  const old=c.messages.find(m=>m.role==='assistant'&&m.jobId===job.id);
  if(job.outputText?.trim()&&!old){c.messages.push({id:'codex-answer-'+job.id,role:'assistant',text:job.outputText,assetIds:[],jobId:job.id,state:job.status==='completed'?'complete':'incomplete',finishReason:job.finishReason||null,createdAt:new Date().toISOString()});changed=true;}
  else if(old&&job.status==='completed'&&old.state==='incomplete'&&old.text===job.outputText){old.state='complete';old.finishReason='stop';changed=true;}
  return changed;
 }
 function mergeGeminiCliJob(c,job){let changed=false;
  if(c.projectId!==job.projectId)throw userError('Gemini CLI原对话归属不匹配');
  if(!c.requests.some(r=>r.requestId===job.requestId)){c.requests.push({requestId:job.requestId,jobId:job.id});changed=true;}
  if(job.userMessage&&!c.messages.some(m=>m.role==='user'&&m.jobId===job.id)){c.messages.push({...job.userMessage,jobId:job.id});changed=true;}
  const old=c.messages.find(m=>m.role==='assistant'&&m.jobId===job.id);
  if(job.outputText?.trim()&&!old){c.messages.push({id:'gemini-cli-answer-'+job.id,role:'assistant',text:job.outputText,assetIds:[],jobId:job.id,state:job.status==='completed'?'complete':'incomplete',finishReason:job.finishReason||null,createdAt:new Date().toISOString()});changed=true;}
  else if(old&&job.status==='completed'&&old.state==='incomplete'&&old.text===job.outputText){old.state='complete';old.finishReason='stop';changed=true;}
  return changed;
 }
 async function refresh(job){
  if(job.kind==='conversation'&&job.input?.executor==='gemini-cli'&&job.geminiCliTaskId&&!activeJobs.has(job.id)){
   let child;try{child=await geminiCliChats.get(job.geminiCliTaskId,job.projectId);}catch(e){if(e.code==='ENOENT')return job;throw e;}
   if(child.parentId!==job.id||child.fingerprint!==job.input.geminiCliFingerprint||child.plan.conversation?.id!==job.conversationId)throw userError('Gemini原收据与普通对话不对应');
   return updateConversationGeminiCli(job,child);
  }

  if(job.kind!=='conversation'||job.input?.executor!=='codex'||!job.codexTaskId||activeJobs.has(job.id))return job;
  let child;try{child=await codexChats.get(job.codexTaskId,job.projectId);}catch(e){if(e.code==='ENOENT')return job;throw e;}
  if(child.parentId!==job.id||child.fingerprint!==job.input.codexFingerprint||child.plan.conversation?.id!==job.conversationId)throw userError('Codex原收据与普通对话不对应');
  return updateConversationCodex(job,child);
 }
 async function recoverOriginal(value,body){
  if(!body||Object.keys(body).join(',')!=='scope'||body.scope!=='codex-original-records')throw userError('请明确读取本对话Codex原记录，不执行新请求');
  return lock(value,async()=>{const c=await get(value);if([...activeJobs.values()].some(j=>j.conversationId===value))throw userError('本机对话仍在收尾，请先完成或停止后读取恢复',409);let changed=false;const found=[];
   for(const j of await records(path.join(data,'jobs')))if(j.kind==='conversation'&&j.input?.executor==='codex'&&j.conversationId===value&&j.projectId===c.projectId){const before=JSON.stringify(j);await refresh(j);changed=mergeCodexJob(c,j)||changed;if(JSON.stringify(j)!==before)await atomicJson(jobFile(j.id),j);found.push({id:j.id,status:j.status,requestCount:j.requestCount,hasAnswer:!!j.outputText});}
   if(changed){c.revision++;c.updatedAt=new Date().toISOString();await persist(c);}return{conversation:c,records:found,changed,readOriginalOnly:true,modelRequests:0};
  });
 }
 async function recoverOriginalGeminiCli(value,body){
  if(!body||Object.keys(body).join(',')!=='scope'||body.scope!=='gemini-cli-original-records')throw userError('请明确读取本对话Gemini CLI原记录，不执行新请求');
  return lock(value,async()=>{const c=await get(value);if([...activeJobs.values()].some(j=>j.conversationId===value))throw userError('本机对话仍在收尾，请先完成或停止后读取恢复',409);let changed=false;const found=[];
   for(const j of await records(path.join(data,'jobs')))if(j.kind==='conversation'&&j.input?.executor==='gemini-cli'&&j.conversationId===value&&j.projectId===c.projectId){const before=JSON.stringify(j);await refresh(j);changed=mergeGeminiCliJob(c,j)||changed;if(JSON.stringify(j)!==before)await atomicJson(jobFile(j.id),j);found.push({id:j.id,status:j.status,requestCount:j.requestCount,hasAnswer:!!j.outputText});}
   if(changed){c.revision++;c.updatedAt=new Date().toISOString();await persist(c);}return{conversation:c,records:found,changed,readOriginalOnly:true,modelRequests:0};
  });
 }
 function mergeImageJob(c,job){let changed=false;
  if(!c.requests.some(r=>r.requestId===job.requestId)){c.requests.push({requestId:job.requestId,jobId:job.id});changed=true;}
  if(job.userMessage&&!c.messages.some(m=>m.role==='user'&&m.jobId===job.id)){c.messages.push({...job.userMessage,jobId:job.id});changed=true;}
  if(job.assets?.length&&!c.messages.some(m=>m.role==='assistant'&&m.jobId===job.id)){c.messages.push({id:randomUUID(),role:'assistant',mode:'image',text:job.status==='completed'?'图片已生成':'已保存的图片结果',assetIds:job.assets.map(a=>a.id),...(job.userMessage?.nativeImage?{nativeImage:job.userMessage.nativeImage}:{}),...(job.geminiParts?.length?{geminiParts:job.geminiParts}:{}),jobId:job.id,state:job.status==='completed'?'complete':'incomplete',createdAt:new Date().toISOString()});changed=true;}
  return changed;
 }
 async function saveImageAnswer(job){await lock(job.conversationId,async()=>{const c=await get(job.conversationId);if(mergeImageJob(c,job)){c.revision++;c.updatedAt=new Date().toISOString();await persist(c);}});}
 function mergeAgentJob(c,job){let changed=false;
  if(!c.requests.some(r=>r.requestId===job.requestId)){c.requests.push({requestId:job.requestId,jobId:job.id});changed=true;}
  if(job.userMessage&&!c.messages.some(m=>m.role==='user'&&m.jobId===job.id)){c.messages.push({...job.userMessage,jobId:job.id});changed=true;}
  if((job.assets?.length||job.outputText?.trim())&&!c.messages.some(m=>m.role==='assistant'&&m.jobId===job.id)){
   const image=job.assets?.length>0;c.messages.push({id:randomUUID(),role:'assistant',mode:image?'image':'agent',text:image?(job.decision?.reply||'图片结果已保存'):job.outputText,assetIds:image?job.assets.map(a=>a.id):[],agentAction:job.decision?.action||'chat',...(image?{imagePrompts:job.assets.map(a=>job.imageResults.find(x=>x.assetId===a.id)?.prompt||job.input.text),usedReferenceIds:job.usedReferenceIds||[]}:{}),jobId:job.id,state:job.status==='completed'?'complete':'incomplete',createdAt:new Date().toISOString()});changed=true;
  }return changed;
 }
 async function saveAgentAnswer(job){await lock(job.conversationId,async()=>{const c=await get(job.conversationId);if(mergeAgentJob(c,job)){c.revision++;c.updatedAt=new Date().toISOString();await persist(c);}});}
 async function recover(){for(const j of await records(path.join(data,'jobs')))if(['conversation','conversation-image','conversation-agent'].includes(j.kind)&&!activeJobs.has(j.id)&&['interrupted','failed','cancelled','completed','incomplete'].includes(j.status)){try{if(j.kind==='conversation'&&['codex','gemini-cli'].includes(j.input?.executor)){await refresh(j);await lock(j.conversationId,async()=>{const c=await get(j.conversationId);if((j.input.executor==='gemini-cli'?mergeGeminiCliJob:mergeCodexJob)(c,j)){c.revision++;c.updatedAt=new Date().toISOString();await persist(c);}});await atomicJson(jobFile(j.id),j);}else if(j.kind==='conversation-agent')await saveAgentAnswer(j);else if(j.kind==='conversation-image')await saveImageAnswer(j);else await saveAnswer(j,j.status==='completed'?'complete':'incomplete');}catch{j.message='结果保留在任务记录，对话历史无法恢复；请检查本地对话文件';await atomicJson(jobFile(j.id),j);}}}

 async function runGemini(job,baseUrl,key,body,controller){
  try{
   job.status='running';job.requestCount=1;job.message='正在发送 Gemini 原生对话请求';await atomicJson(jobFile(job.id),job);
   const response=await apiCall({baseUrl,authMode:'gemini',path:'models/'+job.authorization.model+':generateContent',method:'POST',apiKey:key,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(180000)]),body});
   const result=geminiChatReply(response);
   if(controller.signal.aborted)throw new Error('cancelled');
   job.outputText=redactChatText(result.text,key,true);job.finishReason=result.finishReason;job.status=result.complete?'completed':'incomplete';job.progress=100;job.uncertain=false;
   job.message=job.status==='completed'?'回答已保存，可放入画布':'Gemini 未完整回答；已保存文字片段，不会自动续写';
  }catch(e){job.status=controller.signal.aborted?'cancelled':'failed';job.uncertain=job.requestCount>0&&e.uncertain!==false;job.message=controller.signal.aborted?'已停止本机等待，上游可能仍在处理；不会自动重发':e.publicMessage||'未取得有效 Gemini 回答，请检查平台任务和账单；不会自动重发';}
  finally{key='';try{try{await saveAnswer(job,job.status==='completed'?'complete':'incomplete');}catch{job.status='failed';job.message='已收到的回答保留在任务记录，对话历史保存失败；不会自动重发';}await atomicJson(jobFile(job.id),job);}finally{activeJobs.delete(job.id);}}
 }

 async function run(job,baseUrl,key,messages,maxTokens,controller){
  let received='',lastSave=0;
  const capture=async text=>{received=text;job.outputText=redactChatText(text,key);job.message='正在接收回答';if(Date.now()-lastSave>=250){await atomicJson(jobFile(job.id),job);lastSave=Date.now();}};
  try{
   job.status='running';job.requestCount=1;await atomicJson(jobFile(job.id),job);
   const response=await apiCall({baseUrl,path:'chat/completions',method:'POST',apiKey:key,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(180000)]),body:{model:job.authorization.model,messages,max_tokens:maxTokens,stream:job.stream},responseType:job.stream?'chat-stream':'json',onDelta:capture});
   const result=job.stream?response:chatReply(response);received=result.text;job.outputText=redactChatText(received,key,true);job.finishReason=result.finishReason;
   if(controller.signal.aborted)throw new Error('cancelled');
   job.status=result.complete?'completed':'incomplete';job.progress=100;job.uncertain=false;
   job.message=result.complete?'回答已保存，可放入画布':result.finishReason==='length'?'回答达到输出上限，片段已保存；不会自动续写':'模型未给出完整回答，片段已保存；不会自动续写';
  }catch(e){job.outputText=redactChatText(received,key,true);job.status=controller.signal.aborted?'cancelled':'failed';job.uncertain=job.requestCount>0&&e.uncertain!==false;job.message=controller.signal.aborted?'已停止本机等待，上游可能仍在处理；不会自动重发':e.publicMessage||'未取得有效回答，请检查平台任务和账单；不会自动重发';}
  finally{key='';try{try{await saveAnswer(job,job.status==='completed'?'complete':'incomplete');}catch{job.status='failed';job.message='已收到的回答保留在任务记录，对话历史保存失败；不会自动重发';}await atomicJson(jobFile(job.id),job);}finally{activeJobs.delete(job.id);}}
 }
 async function apply(value,body){const c=await get(value),m=c.messages.find(m=>m.id===body.messageId&&m.role==='assistant');if(!m)throw userError('请选择已保存的模型回答');if(m.state==='incomplete'&&body.acceptIncomplete!==true)throw userError('这是未完成片段，请明确确认后再放入画布');return projects.apply(c,m,body.revision);}
 return {get,list,create,rename,send,apply,recover,agentPreview,codexPreview,geminiCliPreview,refresh,recoverOriginal,recoverOriginalGeminiCli};
}
