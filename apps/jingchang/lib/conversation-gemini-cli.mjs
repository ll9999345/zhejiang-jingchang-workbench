import {isDeepStrictEqual} from 'node:util';
import {geminiConversationContext} from './gemini-conversation-context.mjs';
import {loadAsset,userError} from './workspace.mjs';

export async function prepareConversationGeminiCli({data,conversation,user,messages,project,platform,model,systemPrompt,maxTokens,geminiCliChats}){
 if(!geminiCliChats||platform.protocol!=='gemini'||user.mode!=='chat')throw userError('Gemini CLI只用于Gemini原生文字对话；原图片和Agent模式保持原执行方式');
 const sourceMessages=[...conversation.messages,user].filter(m=>m.state!=='incomplete').slice(-20).map(m=>m===user?{...m,id:'current'}:m);
 const context=await geminiConversationContext({data,id:conversation.id,revision:conversation.revision,sourceMessages,wireMessages:messages,systemPrompt});
 if(context.images.length&&model.referenceSupport!==true)throw userError('请先明确开启此对话模型的图片能力');
 const approved=structuredClone(project);
 // Existing conversation validation checked document/video-derived image
 // bytes. These images may legitimately not be attached to the canvas yet.
 for(const image of context.images)if(!approved.assets.some(a=>a.id===image.assetId))approved.assets.push(await loadAsset(data,image.assetId));
 const checked=await geminiCliChats.previewConversation({project:approved,platform,model:model.id,text:user.text,systemPrompt,maxTokens,context});
 return{checked,project:approved};
}

export function geminiConversationAuthorization(checked,authorization){
 const p=checked.plan;
 if(authorization?.programSha256!==p.program.sha256||authorization?.programEntrySha256!==p.program.entrySha256||authorization?.programVersion!==p.program.version)throw userError('Gemini CLI程序与本次预览未对应，请重新检查');
}

export async function runConversationGeminiCli({job,checked,project,key,controller,geminiCliChats,persist,saveAnswer}){
 let child,last,unlink;
 try{
  controller.signal.throwIfAborted();job.status='running';job.message='正在准备本次已确认的Gemini CLI对话';await persist(job);
  const abort=()=>{void geminiCliChats.stop(job.geminiCliTaskId,job.projectId).catch(()=>{});};controller.signal.addEventListener('abort',abort,{once:true});unlink=()=>controller.signal.removeEventListener('abort',abort);
  child=await geminiCliChats.startFromConversation(checked,project,{apiKey:key,authorization:job.authorization},job.id);key='';
  for(;;){
   child=await geminiCliChats.get(child.id,job.projectId);const state={requestCount:child.requestCount,outputText:child.response?.text||'',message:child.status==='running'?'本机Gemini CLI正在等待本次唯一回答':'正在保存原Gemini CLI回答'};
   if(!isDeepStrictEqual(state,last)){Object.assign(job,state);await persist(job);last=state;}
   if(!['running','stopping'].includes(child.status))break;
   await new Promise(r=>setTimeout(r,80));
  }
  updateConversationGeminiCli(job,child);
 }catch{
  if(job.geminiCliTaskId)try{child=await geminiCliChats.get(job.geminiCliTaskId,job.projectId);}catch{}
  if(child)updateConversationGeminiCli(job,child);else{job.status=controller.signal.aborted?'cancelled':'failed';job.uncertain=false;job.message='Gemini CLI未完成准备，原请求未重发';}
 }finally{
  key='';unlink?.();
  try{await saveAnswer(job,job.status==='completed'?'complete':'incomplete');}catch{job.status='failed';job.message='原Gemini CLI文字保留在任务记录，对话保存未完成；不会重发';}
  await persist(job);
 }
}

export function updateConversationGeminiCli(job,child){
 job.requestCount=child.requestCount;job.outputText=child.response?.text||'';job.finishReason=child.canApply?'stop':'incomplete';job.status=child.canApply?'completed':child.response?.text?'incomplete':child.status==='stopped'?'cancelled':child.status==='uncertain'?'interrupted':'failed';job.progress=child.canApply?100:0;job.uncertain=child.status==='uncertain';job.message=child.canApply?'Gemini CLI完整回答已保存，可放入画布':'原Gemini CLI记录保留；不会自动续写或重发';return job;
}
