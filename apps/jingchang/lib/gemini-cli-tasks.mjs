import {validateGeminiConversation,geminiConversationWire} from './gemini-conversation-context.mjs';
import {geminiChatModel,geminiChatBody} from './gemini-chat.mjs';
import path from 'node:path';
import {promises as fs,constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {safeId,userError,atomicJson} from './workspace.mjs';
import {guardArchiveSecrets} from './task-history-schema.mjs';
import {inspectPublicMediaSource} from './public-media.mjs';
import {validateApiBaseUrl} from './image-api.mjs';
import {cleanCliInfo} from './local-cli-info.mjs';
import {geminiCliProgram,geminiCliInvocation,runGeminiCliProcess} from './gemini-cli-process.mjs';
import {geminiCliBroker} from './gemini-cli-broker.mjs';

export const GEMINI_CLI_SOURCE='gemini-cli-tasks';
const sha=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
const stamp=()=>new Date().toISOString(),locks=new Map();
const id=v=>{if(!safeId(v)||['__proto__','constructor','prototype'].includes(v))throw userError('CLI任务编号无效');return v;};
const text=(v,max,label,empty=false)=>{if(typeof v!=='string'||v.length>max||!empty&&!v.trim()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))throw userError(label+'无效或超限');guardArchiveSecrets(v);return v;};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===keys.sort().join('|');
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
function validPlan(p){
 if(!exact(p,['version','projectId','platform','model','systemPrompt','text','maxTokens','history','currentAssetIds','images','program',...(p?.target?['target']:[]),...(p?.conversation?['conversation']:[])])||p.version!==1)throw userError('CLI计划字段无效');id(p.projectId);
 if(!exact(p.platform,['id','name','protocol','baseUrl'])||p.platform.protocol!=='gemini'||validateApiBaseUrl(p.platform.baseUrl)!==p.platform.baseUrl)throw userError('CLI模型服务无效');id(p.platform.id);text(p.platform.name,80,'服务名称');text(p.model,200,'模型');if(!geminiChatModel(p.model))throw userError('请选择Gemini普通对话型号');text(p.text,32000,'消息');text(p.systemPrompt,16000,'系统指令',true);
 if(!Number.isInteger(p.maxTokens)||p.maxTokens<128||p.maxTokens>8192||!Array.isArray(p.history)||p.history.length>19||!Array.isArray(p.images)||p.images.length>20||!Array.isArray(p.currentAssetIds)||p.currentAssetIds.length>20||new Set(p.currentAssetIds).size!==p.currentAssetIds.length)throw userError('CLI计划范围无效');
 const refs=new Set(p.currentAssetIds.map(id)),seen=new Set();let chars=p.conversation?0:p.text.length,total=0;
 for(const row of p.history){if(!exact(row,['requestId','text','answer','assetIds'])||!Array.isArray(row.assetIds)||row.assetIds.length>20||new Set(row.assetIds).size!==row.assetIds.length)throw userError('CLI上下文结构无效');id(row.requestId);if(seen.has(row.requestId))throw userError('CLI上下文编号重复');seen.add(row.requestId);text(row.text,32000,'上下文问题');text(row.answer,200000,'上下文回答');chars+=row.text.length+row.answer.length;for(const a of row.assetIds)refs.add(id(a));}
 if(p.conversation){
  validateGeminiConversation(p.conversation);if(p.history.length||p.target)throw userError('原会话CLI记录不能混入独立续聊或画布取回目标');
  const last=p.conversation.messages.at(-1),first=last.parts[0],current=[...new Set(last.parts.filter(x=>x.type==='input_image').map(x=>x.assetId))];
  if(first?.type!=='input_text'||first.text!==p.text||!isDeepStrictEqual(current,p.currentAssetIds))throw userError('Gemini本次问题或图片与会话快照不符');
  for(const m of p.conversation.messages)for(const part of m.parts)if(part.type==='input_image')refs.add(id(part.assetId));else chars+=part.text.length;
 }
 if(chars>100000||refs.size>20)throw userError('CLI上下文超过10万字或20张图');
 const images=new Set();for(const img of p.images){if(!exact(img,['assetId','name','type','size','sha256'])||!hash(img.sha256)||!['image/png','image/jpeg','image/webp'].includes(img.type)||!Number.isSafeInteger(img.size)||img.size<1||img.size>10*1024**2||images.has(id(img.assetId)))throw userError('CLI参考图记录无效');text(img.name,200,'图片名称');images.add(img.assetId);total+=img.size;}if(total>18*1024**2||refs.size!==images.size||[...refs].some(a=>!images.has(a)))throw userError('CLI参考图与上下文不对应');
 const sizes=new Map(p.images.map(i=>[i.assetId,i.size]));let encoded=Buffer.byteLength(p.systemPrompt)+4096;
 if(p.conversation){for(const m of p.conversation.messages)for(const part of m.parts)encoded+=part.type==='input_text'?Buffer.byteLength(part.text):4*Math.ceil(sizes.get(part.assetId)/3)+100;}
 else for(const row of [...p.history,{text:p.text,answer:'',assetIds:p.currentAssetIds}]){encoded+=Buffer.byteLength(row.text+row.answer);for(const assetId of row.assetIds)encoded+=4*Math.ceil(sizes.get(assetId)/3)+100;}if(encoded>18*1024**2)throw userError('Gemini本次完整上下文超过18MiB，未发送');
 if(!exact(p.program,['available','id','name','version','protocol','sha256','entrySha256','message'])||p.program.available!==true||p.program.id!=='gemini-cli'||p.program.protocol!=='gemini-plain-v1'||!hash(p.program.sha256)||!hash(p.program.entrySha256))throw userError('CLI程序证明无效');text(p.program.version,80,'程序版本');text(p.program.name,80,'程序名称');text(p.program.message,500,'程序说明');
 if(p.target&&(!exact(p.target,['nodeId','sourceNodeDigest','title'])||!safeId(p.target.nodeId)||!hash(p.target.sourceNodeDigest)||typeof p.target.title!=='string'||p.target.title.length>200))throw userError('CLI原节点证明无效');guardArchiveSecrets(p);return p;
}
export const geminiCliTargetDigest=n=>sha({type:n.type,text:n.text,params:n.params});
async function lock(key,fn){const before=locks.get(key)||Promise.resolve();const task=before.catch(()=>{}).then(fn);locks.set(key,task);try{return await task;}finally{if(locks.get(key)===task)locks.delete(key);}}
export function geminiCliStore(data){
 async function directory(){const root=await fs.realpath(data),dir=path.join(root,GEMINI_CLI_SOURCE);await fs.mkdir(dir,{recursive:true,mode:0o700});if(await fs.realpath(dir)!==dir||!(await fs.lstat(dir)).isDirectory())throw userError('CLI记录目录异常');return dir;}
 function name(v){if(typeof v!=='string'||!/^[-\w]+(?:\.[-\w]+)*\.json$/.test(v))throw userError('CLI记录名称无效');return v;}
 async function read(key,{optional=false}={}){const file=path.join(await directory(),name(key));let h;try{if(await fs.realpath(file)!==file)throw userError('CLI记录路径异常');h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const st=await h.stat();if(!st.isFile()||st.size>16*1024**2)throw userError('CLI记录不是受支持普通文件');let out;try{out=JSON.parse(await h.readFile('utf8'));}catch{throw userError('CLI记录损坏，原文件保留');}guardArchiveSecrets(out);return out;}catch(e){if(optional&&e.code==='ENOENT')return null;throw e;}finally{await h?.close();}}
 async function publish(key,value){guardArchiveSecrets(value);const dir=await directory(),file=path.join(dir,name(key)),pending=path.join(dir,'.pending-'+randomUUID());const h=await fs.open(pending,'wx',0o600);try{await h.writeFile(JSON.stringify(value));await h.sync();}finally{await h.close();}try{await fs.link(pending,file);}catch(e){if(e.code!=='EEXIST')throw e;const old=await read(key);if(!isDeepStrictEqual(old,value))throw userError('CLI记录编号已占用，原记录保留',409);}return value;}
 async function ids(){return(await fs.readdir(await directory())).filter(n=>/^[-\w]+\.json$/.test(n)).map(n=>n.slice(0,-5));}
 return{directory,read,publish,ids};
}
export function geminiCliService({data,platforms,projects,activeJobs=new Map(),resolveProgram=geminiCliProgram,runProcess=runGeminiCliProcess,brokerFactory=geminiCliBroker,apiCall,timeoutMs=180000}={}){
 const store=geminiCliStore(data),live=new Map();
 async function manifest(key){const m=await store.read(id(key)+'.json');validateManifest(m);if(m.id!==key)throw userError('CLI任务计划编号不符');return m;}
 async function get(key,projectId,{ignoreLive=false}={}){const m=await manifest(key);if(projectId!==undefined&&m.projectId!==projectId)throw userError('CLI任务不属于本工程',403);const [sent,response,processResult,end,stop]=await Promise.all(['sent','response','process','end','stop'].map(part=>store.read(key+'.'+part+'.json',{optional:true})));if(sent&&(!exact(sent,['createdAt','fingerprint'])||!time(sent.createdAt)||sent.fingerprint!==m.fingerprint))throw userError('CLI原提交记录无效');if(stop&&(!exact(stop,['createdAt'])||!time(stop.createdAt)))throw userError('CLI停止记录无效');if(end&&(!exact(end,['status','finishedAt'])||!time(end.finishedAt)))throw userError('CLI结束记录无效');const running=live.has(key)&&!ignoreLive;let status=running?'running':response?.complete?'completed':response?.text?'incomplete':sent?'uncertain':'interrupted';if(end&&!running)status=end.status;if(stop&&status==='running')status='stopping';const out={id:key,...(m.parentId?{parentId:m.parentId}:{}),projectId:m.projectId,createdAt:m.createdAt,plan:m.plan,fingerprint:m.fingerprint,authorization:m.authorization,status,requestCount:sent?1:0,response,process:processResult,stopped:!!stop,canApply:!running&&status==='completed'&&response?.complete===true&&processResult?.toolAttempt!==true,canResume:false,readOnly:true};validateState({status:out.status,requestCount:out.requestCount,response,process:processResult,stopped:!!stop},{live:live.has(key)});return out;}
 async function list(projectId){await projects.load(id(projectId));const rows=[];for(const key of await store.ids()){const m=await manifest(key);if(m.projectId===projectId)rows.push(await get(key,projectId));}return rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
 async function imagesFor(project,assetIds){
  if(!Array.isArray(assetIds)||assetIds.length>20||new Set(assetIds).size!==assetIds.length)throw userError('CLI看图最多20张，不可重复');
  const images=[];let bytes=0;for(const assetId of assetIds){id(assetId);if(!project.assets.some(a=>a.id===assetId))throw userError('CLI参考图片不属于当前工程');const s=await inspectPublicMediaSource(data,assetId,10*1024**2);if(!['image/png','image/jpeg','image/webp'].includes(s.type))throw userError('CLI看图只接受PNG、JPEG和WebP');bytes+=s.size;if(bytes>18*1024**2)throw userError('CLI参考图原字节合计超过18MiB');images.push({assetId:s.assetId,name:s.name,type:s.type,size:s.size,sha256:s.sourceSha256});}return images;
 }
 async function preview(body,linked={}){
  if(!body||typeof body!=='object'||Array.isArray(body))throw userError('CLI计划无效');const p=linked.project??await projects.load(id(body.projectId));if(p.id!==body.projectId)throw userError('CLI工程范围不符');
  const currentText=text(body.text,linked.project?32000:20000,'消息'),systemPrompt=text(body.systemPrompt??'',16000,'系统指令',true),maxTokens=body.maxTokens??4096;if(!Number.isSafeInteger(maxTokens)||maxTokens<128||maxTokens>8192)throw userError('输出上限须为128–8192');
  const platform=linked.platform??await platforms.get(body.platformId),model=platform.models.find(m=>m.id===body.model&&m.category==='chat');if(platform.protocol!=='gemini'||!model||!geminiChatModel(model.id))throw userError('请选择已保存的Gemini原生普通对话模型');
  const history=[];if(body.previousTaskId){const previous=await get(id(body.previousTaskId),p.id);if(previous.plan.conversation)throw userError('请在原普通对话中继续本记录，不能遗漏原消息');if(!previous.canApply)throw userError('仅能沿用已完整返回的CLI会话');history.push(...previous.plan.history,{requestId:previous.id,text:previous.plan.text,answer:previous.response.text,assetIds:previous.plan.currentAssetIds});}
  if(history.length>19||history.reduce((n,r)=>n+r.text.length+r.answer.length,0)+currentText.length>100000)throw userError('CLI上下文最多20轮、10万字，请开始新会话');
  const currentAssetIds=body.assetIds??[];if(!Array.isArray(currentAssetIds)||currentAssetIds.length>20||new Set(currentAssetIds).size!==currentAssetIds.length)throw userError('CLI当前图片范围无效');const ids=[...new Set([...history.flatMap(r=>r.assetIds),...currentAssetIds])],images=await imagesFor(p,ids);if(images.length&&model.referenceSupport!==true)throw userError('请先在模型设置明确启用图片输入');
  const program=await resolveProgram();if(program.public.available!==true)throw userError(program.public.message);
  let target;if(body.nodeId){const node=p.nodes.find(n=>n.id===id(body.nodeId));if(!node||node.type==='loop')throw userError('原目标节点不存在或不支持正文取回');target={nodeId:node.id,sourceNodeDigest:geminiCliTargetDigest(node),title:node.title};}
  const plan=validPlan({version:1,projectId:p.id,platform:{id:platform.id,name:platform.name,protocol:platform.protocol,baseUrl:validateApiBaseUrl(platform.baseUrl)},model:model.id,systemPrompt,text:currentText,maxTokens,history,currentAssetIds:[...currentAssetIds],images,program:program.public,...(target?{target}:{})});return{plan,fingerprint:sha(plan),requestLimit:1,programInvocations:1,requiresGemini:true};
 }
 async function summary(key,{terminal=false}={}){const state=await get(key,undefined,{ignoreLive:terminal}),m=await manifest(key);return{id:key,...(m.parentId?{parentId:m.parentId}:{}),kind:'gemini-cli-chat',...(m.plan.conversation?{conversationId:m.plan.conversation.id}:{}),canResume:false,projectId:m.projectId,requestId:key,name:'Gemini · '+m.plan.text.slice(0,40),createdAt:m.createdAt,status:['completed','incomplete','uncertain','interrupted','stopped','failed','stopping'].includes(state.status)?state.status:'running',progress:state.status==='completed'?1:0,message:state.status==='stopping'?'正在停止本机等待；原请求不会重发':state.status==='running'?'正在等待CLI与本次唯一模型回答':state.response?.complete?'完整回答已保存；可主动取回到画布':'原记录保留；不会自动重发',assets:[],requestCount:state.requestCount,outputText:state.response?.text||'',authorization:m.authorization};}
 async function jobDirectory(){const root=await fs.realpath(data),dir=path.join(root,'jobs');await fs.mkdir(dir,{recursive:true});if(await fs.realpath(dir)!==dir||!(await fs.lstat(dir)).isDirectory())throw userError('任务目录异常，未覆盖原记录');return dir;}
 async function persistSummary(key,options){const j=await summary(key,options),file=path.join(await jobDirectory(),key+'.json');try{if(await fs.realpath(file)!==file||!(await fs.lstat(file)).isFile())throw userError('任务摘要路径异常');const old=JSON.parse(await fs.readFile(file,'utf8'));if(old.id!==key||old.kind!=='gemini-cli-chat'||old.projectId!==j.projectId)throw userError('此编号属于其他任务，未覆盖',409);}catch(e){if(e.code!=='ENOENT')throw e;}await atomicJson(file,j);return j;}
 async function start(body,linked={}){try{id(body?.requestId);return await lock(data+':gemini-cli-chat-start',async()=>{
  const key=body.requestId,old=await store.read(key+'.json',{optional:true});if(old){if(old.fingerprint!==body.fingerprint||old.projectId!==body.projectId||old.parentId!==linked.parentId)throw userError('此CLI请求编号已被另一计划使用',409);return get(key,body.projectId);}
  try{await fs.lstat(path.join(await jobDirectory(),key+'.json'));throw userError('此编号属于已有任务，未覆盖',409);}catch(e){if(e.code!=='ENOENT')throw e;}
  const checked=linked.checked??await preview(body,linked);validPlan(checked.plan);if(checked.fingerprint!==sha(checked.plan))throw userError('CLI原范围指纹不符');if(checked.fingerprint!==body.fingerprint)throw userError('CLI程序、输入或模型已变化，请重新预览',409);
  const a=body.authorization,origin=new URL(checked.plan.platform.baseUrl).origin,local=new URL(checked.plan.platform.baseUrl).protocol==='http:';
  if(body.consent!==true||!a||a.origin!==origin||a.model!==checked.plan.model||a.sendPrompt!==true||a.sendReferences!==(checked.plan.images.length>0)||a.requestLimit!==1||!Number.isFinite(a.budget)||a.budget<(local?0:0.01)||!['CNY','USD'].includes(a.currency))throw userError('请确认本次服务、模型、上下文、图片、一次请求和预算');
  const apiKey=typeof body.apiKey==='string'?body.apiKey:'';if(apiKey.length>4096||/[\r\n\0]/.test(apiKey)||!local&&!apiKey.trim())throw userError('请填写仅本次使用的API Key');if(apiKey&&JSON.stringify(checked.plan).includes(apiKey))throw userError('消息含本次密钥，请移除');
  linked.signal?.throwIfAborted();if(live.size>=2)throw userError('已有两条CLI回答在等待，请完成或停止后再提交',409);
  const authorization={origin,model:a.model,sendPrompt:true,sendReferences:a.sendReferences,requestLimit:1,budget:a.budget,currency:a.currency},m={version:1,id:key,projectId:body.projectId,createdAt:stamp(),plan:checked.plan,fingerprint:checked.fingerprint,authorization,...(linked.parentId?{parentId:linked.parentId}:{})};await store.publish(key+'.json',m);
  const controller=new AbortController(),abortLinked=()=>controller.abort();linked.signal?.addEventListener('abort',abortLinked,{once:true});if(linked.signal?.aborted)controller.abort();live.set(key,{controller});let job;try{job={...await persistSummary(key),status:'running',controller};activeJobs.set(key,job);}catch(e){live.delete(key);throw e;}
  void run(m,apiKey,controller,linked.project).finally(()=>{linked.signal?.removeEventListener('abort',abortLinked);live.delete(key);activeJobs.delete(key);}).catch(()=>{});return get(key,body.projectId);
 });}finally{if(body)body.apiKey='';}}
 async function previewConversation({project,platform,model,text:message,systemPrompt='',maxTokens=4096,context}){
  const program=await resolveProgram();if(!program.public.available)throw userError(program.public.message);
  const plan=validPlan({version:1,projectId:project.id,platform:{id:platform.id,name:platform.name,protocol:platform.protocol,baseUrl:validateApiBaseUrl(platform.baseUrl)},model,systemPrompt,text:message,maxTokens,history:[],currentAssetIds:context.currentAssetIds,images:context.images,program:program.public,conversation:context.conversation});
  const actual=await imagesFor(project,plan.images.map(x=>x.assetId));if(!isDeepStrictEqual(actual,plan.images))throw userError('Gemini原会话图片已变化，请重新检查');
  return{plan,fingerprint:sha(plan),requestLimit:1,programInvocations:1,requiresGemini:true};
 }
 async function startFromConversation(checked,project,body,wrapperId){
  try{
   const wrapper=activeJobs.get(wrapperId);validPlan(checked.plan);
   if(wrapper?.kind!=='conversation'||wrapper.projectId!==project.id||wrapper.conversationId!==checked.plan.conversation?.id||checked.plan.projectId!==project.id||checked.fingerprint!==sha(checked.plan))throw userError('Gemini CLI只接受活动对话的已确认原范围');
   wrapper.controller.signal.throwIfAborted();const program=await resolveProgram(),images=await imagesFor(project,checked.plan.images.map(x=>x.assetId));
   if(!isDeepStrictEqual(program.public,checked.plan.program)||!isDeepStrictEqual(images,checked.plan.images))throw userError('Gemini程序或原会话图片与检查时不同，尚未发送');
   return await start({projectId:project.id,requestId:'gemini-cli-'+id(wrapperId),fingerprint:checked.fingerprint,authorization:body.authorization,consent:true,apiKey:body.apiKey},{project:structuredClone(project),checked,parentId:wrapperId,signal:wrapper.controller.signal});
  }finally{body.apiKey='';}
 }
 async function startFromCanvas(step,project,body,parentId,wrapperId){
  try{
   const parent=activeJobs.get(parentId),wrapper=activeJobs.get(wrapperId);
   if(parent?.kind!=='canvas-run'||parent.projectId!==project.id||wrapper?.kind!=='canvas-llm'||wrapper.parentId!==parentId||wrapper.projectId!==project.id||step.llm?.executor!=='gemini-cli')throw userError('CLI只接受活动画布语言节点的已确认范围');
   parent.controller.signal.throwIfAborted();wrapper.controller.signal.throwIfAborted();
   const input={projectId:project.id,platformId:step.llm.platform.id,model:step.llm.model,text:step.text,systemPrompt:step.llm.systemPrompt,maxTokens:step.llm.maxTokens,assetIds:[...new Set(step.llm.referenceSources.map(r=>r.assetId||project.nodes.find(n=>n.id===r.sourceNodeId)?.assetId))]};
   const linked={project:structuredClone(project),platform:step.llm.platform,parentId:wrapperId,signal:AbortSignal.any([parent.controller.signal,wrapper.controller.signal])},checked=await preview(input,linked);
   if(!isDeepStrictEqual(checked.plan.program,step.geminiCliProgram))throw userError('本机Gemini程序与画布预览不同，尚未发送，请重新检查');
   return await start({...input,requestId:'gemini-cli-'+id(wrapperId),fingerprint:checked.fingerprint,authorization:step.authorization,consent:true,apiKey:body.apiKey},linked);
  }finally{body.apiKey='';}
 }
 async function run(m,apiKey,controller,approvedProject){let broker,end='interrupted';try{
  const program=await resolveProgram();if(!isDeepStrictEqual(program.public,m.plan.program))throw userError('CLI程序发生变化，未提交');
  const p=approvedProject??await projects.load(m.projectId),images=await imagesFor(p,m.plan.images.map(r=>r.assetId));if(!isDeepStrictEqual(images,m.plan.images))throw userError('图片发生变化，未提交');
  const base=await store.directory(),work=path.join(base,'work-'+m.id);await fs.mkdir(work,{mode:0o700});if(await fs.realpath(work)!==work)throw userError('CLI工作目录异常');
  const parts=new Map();for(const img of images){
   const bytes=await fs.readFile(path.join(await fs.realpath(data),'assets',img.assetId));if(sha(bytes)!==img.sha256||bytes.length!==img.size)throw userError('CLI图片与预览不符');parts.set(img.assetId,{inlineData:{mimeType:img.type,data:bytes.toString('base64')}});
  }
  const contents=m.plan.conversation?geminiConversationWire(m.plan.conversation,parts):[];for(const row of m.plan.history){contents.push({role:'user',parts:[{text:row.text},...row.assetIds.map(k=>parts.get(k))]});contents.push({role:'model',parts:[{text:row.answer}]});}if(!m.plan.conversation)contents.push({role:'user',parts:[{text:m.plan.text},...m.plan.currentAssetIds.map(k=>parts.get(k))]});
  const body=geminiChatBody(contents,m.plan.systemPrompt,m.plan.maxTokens);
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs)]);
  broker=await brokerFactory({baseUrl:m.plan.platform.baseUrl,model:m.plan.model,apiKey,body,signal,apiCall,onSent:async()=>{await store.publish(m.id+'.sent.json',{createdAt:stamp(),fingerprint:m.fingerprint});await persistSummary(m.id);},onReply:async reply=>{const safe={...reply,text:cleanCliInfo(reply.text),finishedAt:stamp()};guardArchiveSecrets(safe);await store.publish(m.id+'.response.json',safe);}});
  const call=await geminiCliInvocation(program,{cwd:work,port:broker.port,brokerUrl:broker.baseUrl,token:broker.token,model:m.plan.model});
  const result=await runProcess(call,{prompt:'请回答这次用户问题。禁止执行工具、命令或修改文件。\n\n'+m.plan.text,signal,timeoutMs});
  const reply=await store.read(m.id+'.response.json',{optional:true});await store.publish(m.id+'.process.json',{finishedAt:stamp(),exitCode:result.exitCode,complete:result.complete,toolAttempt:result.toolAttempt,warnings:result.warnings,...(result.threadId?{threadId:result.threadId}:{}),textMatches:!!reply&&result.text.trim()===reply.text.trim(),broker:broker.stats()});
  end=reply?.complete?'completed':reply?.text?'incomplete':broker.stats().forwarded?'uncertain':'failed';
 }catch{const response=await store.read(m.id+'.response.json',{optional:true});end=response?.complete?'completed':response?.text?'incomplete':controller.signal.aborted?'stopped':(await store.read(m.id+'.sent.json',{optional:true}))?'uncertain':'failed';}
 finally{apiKey='';controller.abort();await broker?.stop();await store.publish(m.id+'.end.json',{status:end,finishedAt:stamp()});await persistSummary(m.id,{terminal:true});}}
 async function stop(key,projectId){const m=await manifest(key);if(m.projectId!==projectId)throw userError('CLI任务不属于本工程',403);if(live.has(key)){const previous=await store.read(key+'.stop.json',{optional:true});if(!previous)await store.publish(key+'.stop.json',{createdAt:stamp()});live.get(key).controller.abort();}return get(key,projectId);}
 async function apply(key,body){const r=await get(key,body?.projectId);if(!r.canApply)throw userError('仅可取回原记录中的完整普通回答');if(!['bound','new'].includes(body.placement))throw userError('请选择取回原节点或另存新节点');return projects.apply(r,body);}
 async function history(key,projectId){const r=await get(key,projectId);if(['running','stopping'].includes(r.status))throw userError('CLI仍在运行，请先停止再归档',409);return geminiCliHistory({manifest:await manifest(key),state:{status:r.status,requestCount:r.requestCount,response:r.response,process:r.process,stopped:r.stopped}},{projectId});}
 return{preview,previewConversation,start,startFromConversation,startFromCanvas,get,list,stop,apply,summary,persistSummary,history,store,program:async()=>(await resolveProgram()).public};
}
export function geminiCliHistory(value,{projectId}={}){
 if(!exact(value,['manifest','state']))throw userError('Gemini留痕字段无效');const m=value.manifest;validateManifest(m);if(projectId!==undefined&&projectId!==m.projectId)throw userError('Gemini留痕归属不符');validateState(value.state);guardArchiveSecrets(value);return structuredClone(value);
}
function validateManifest(m){
 if(!exact(m,['version','id','projectId','createdAt','plan','fingerprint','authorization',...(m?.parentId?['parentId']:[])])||m.version!==1||!time(m.createdAt))throw userError('CLI原计划字段无效');id(m.id);id(m.projectId);if(m.parentId)id(m.parentId);validPlan(m.plan);if(m.plan.projectId!==m.projectId||m.fingerprint!==sha(m.plan))throw userError('CLI原计划指纹不符');
 const a=m.authorization;if(!exact(a,['origin','model','sendPrompt','sendReferences','requestLimit','budget','currency'])||a.origin!==new URL(m.plan.platform.baseUrl).origin||a.model!==m.plan.model||a.sendPrompt!==true||a.sendReferences!==(m.plan.images.length>0)||a.requestLimit!==1||!Number.isFinite(a.budget)||a.budget<0||!['CNY','USD'].includes(a.currency))throw userError('CLI原授权范围无效');guardArchiveSecrets(m);
}
function validateState(s,{live=false}={}){
 if(!exact(s,['status','requestCount','response','process','stopped'])||!['completed','incomplete','uncertain','interrupted','failed','stopped',...(live?['running','stopping']:[])].includes(s.status)||![0,1].includes(s.requestCount)||typeof s.stopped!=='boolean')throw userError('CLI运行留痕无效');
 const r=s.response;if(r){if(!exact(r,['text','complete','finishedAt',...(r.upstreamId!==undefined?['upstreamId']:[]),...(r.usage!==undefined?['usage']:[])])||typeof r.complete!=='boolean'||!time(r.finishedAt))throw userError('CLI回答留痕无效');text(r.text,200000,'CLI回答');if(r.upstreamId!==undefined&&!/^[-\w]{1,160}$/.test(r.upstreamId))throw userError('CLI上游编号无效');if(r.usage&&(!Object.keys(r.usage).every(k=>['input_tokens','output_tokens','total_tokens'].includes(k))||Object.values(r.usage).some(v=>!Number.isSafeInteger(v)||v<0)))throw userError('CLI用量字段无效');if(s.requestCount!==1)throw userError('CLI回答缺少原请求记录');}
 const p=s.process;if(p&&(!exact(p,['finishedAt','exitCode','complete','toolAttempt','warnings','textMatches','broker',...(p.threadId?['threadId']:[])])||!time(p.finishedAt)||p.exitCode!==null&&!Number.isInteger(p.exitCode)||typeof p.complete!=='boolean'||typeof p.toolAttempt!=='boolean'||typeof p.textMatches!=='boolean'||!Number.isSafeInteger(p.warnings)||p.warnings<0||!exact(p.broker,['claimed','forwarded','denied'])||typeof p.broker.claimed!=='boolean'||![0,1].includes(p.broker.forwarded)||!Number.isSafeInteger(p.broker.denied)||p.broker.denied<0||p.threadId!==undefined&&!/^[-\w]{1,160}$/.test(p.threadId)))throw userError('CLI程序结果无效');
 if(s.status==='completed'&&r?.complete!==true)throw userError('CLI完整状态缺少完整回答');guardArchiveSecrets(s);
}
