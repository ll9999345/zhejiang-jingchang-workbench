import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {workspaceRoot} from './runtime-config.mjs';
import {atomicJson,readJson,safeId,userError} from './workspace.mjs';

const root=workspaceRoot();
const workbench=path.resolve(root,'../..');
const unavailable={configured:false,provider:'deepseek',model:'deepseek-flash',label:'DeepSeek V4.1 Flash',origin:'https://api.deepseek.com',remote:true,textOnly:true,error:'DeepSeek 本机接入不可读取，请检查文旅工作台配置'};
export const remoteDirector = provider => ['deepseek','miaoapi'].includes(provider);
const providerSpec = provider => provider==='miaoapi'?{provider,origin:'https://miaoapi.xyz',models:['gpt-5.4-mini','gpt-5.6-sol'],label:'GPT 模型服务'}:{provider:'deepseek',origin:'https://api.deepseek.com',models:['deepseek-flash'],label:'DeepSeek V4.1 Flash'};
export const directorRequestHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Only the server can choose this executable. No request can choose a path,
// URL, credential source or headers. The child returns answers, never keys.
export async function callDirectorHelper(body,{python=process.env.JINGCHANG_DIRECTOR_PYTHON||path.join(workbench,'.venv/bin/python'),helper=process.env.JINGCHANG_DIRECTOR_HELPER||path.join(workbench,'scripts/canvas_deepseek.py')}={}){
 const input=JSON.stringify(body);if(Buffer.byteLength(input)>256000)throw userError('本次画布文字过多，未发送到模型');
 return new Promise((resolve,reject)=>{
  const child=spawn(python,[helper],{stdio:['pipe','pipe','ignore']});let output='',finished=false;
  const fail=()=>{if(finished)return;finished=true;clearTimeout(timer);child.kill('SIGTERM');reject(userError('DeepSeek 请求未确认，请检查配置与账单；没有自动重试',502));};
  const timer=setTimeout(fail,120000);timer.unref();child.on('error',fail);
  child.stdout.on('data',chunk=>{output+=chunk.toString('utf8');if(Buffer.byteLength(output)>1200000)fail();});
  child.stdin.on('error',fail);child.stdin.end(input);
  child.on('close',code=>{if(finished)return;finished=true;clearTimeout(timer);if(code!==0)return reject(userError('DeepSeek 接入不可读取；没有自动重试',502));let envelope;try{envelope=JSON.parse(output);}catch{return reject(userError('DeepSeek 接入响应无效；没有自动重试',502));}if(envelope?.ok!==true)return reject(userError(typeof envelope?.error==='string'?envelope.error.slice(0,400):'DeepSeek 请求失败；没有自动重试',[400,409,502].includes(envelope?.status)?envelope.status:502));resolve(envelope.result);});
 });
}

export function directorProviderService({data,helperCall=callDirectorHelper}={}){
 const cache=new Map(),locks=new Map();
 async function status({refresh=false,provider='deepseek'}={}){
  if(!remoteDirector(provider))throw userError('助理服务无效');
  const previous=cache.get(provider),spec=providerSpec(provider);
  if(!refresh&&previous&&Date.now()-previous.at<3000)return structuredClone(previous.value);
  let cached;
  try{
   const value=await helperCall({operation:'status',provider});
   if(value?.provider!==provider||!spec.models.includes(value?.model)||value?.origin!==spec.origin)throw Error('invalid provider');
   cached=Object.fromEntries(['configured','provider','origin','model','label','remote','textOnly','pricing','sourceLabel','profileRevision','protocol','upstreamIdentityVerified','error'].filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));
  }catch{cached=provider==='deepseek'?{...unavailable}:{...unavailable,...spec,model:spec.models[0],error:'模型服务本机配置不可读取，请检查连接设置'};delete cached.models;}
  if(provider==='miaoapi')cached.label=cached.model;cache.set(provider,{at:Date.now(),value:cached});return structuredClone(cached);
 }
 async function health(config){
  if(remoteDirector(config.agentProvider)){const director=await status({provider:config.agentProvider});return {agentConfigured:director.configured===true,model:director.model,director};}
  const model=config.llmModel||process.env.JINGCHANG_LLM_MODEL||null,url=config.llmUrl||process.env.JINGCHANG_LLM_URL;
  return {agentConfigured:!!(url&&model),model,director:{provider:'local',model,remote:false,configured:!!(url&&model),label:model||'本机语言模型'}};
 }
 async function completeOnce({requestId,scope,messages,maxTokens,jsonOutput,consent,authorization,thinking='off',provider='deepseek'}){
  if(!remoteDirector(provider))throw userError('助理服务无效');
  const spec=providerSpec(provider);
  if(!safeId(requestId)||!/^[-a-f0-9]{36}$/i.test(requestId))throw userError('请使用新的请求编号检查本次模型调用');
  if(typeof scope!=='string'||!scope||scope.length>250)throw userError('模型调用范围无效');
  const fields=['provider','origin','model','sendText','sendMedia','requestLimit','currency','budget','profileRevision'];
  if(consent!==true||!authorization||Object.keys(authorization).some(k=>!fields.includes(k))||authorization.provider!==provider||authorization.origin!==spec.origin||!spec.models.includes(authorization.model)||authorization.sendText!==true||authorization.sendMedia!==false||authorization.requestLimit!==1||authorization.currency!=='USD'||!Number.isFinite(authorization.budget)||authorization.budget<=0||authorization.budget>100||!/^[a-f0-9]{64}$/.test(authorization.profileRevision||''))throw userError('请确认本次 '+spec.label+' 的服务、文字范围、1次请求和美元预算');
  if(provider==='miaoapi'&&thinking!=='off')throw userError('当前模型服务不能沿用 DeepSeek 思考参数');
  const signature=directorRequestHash({scope,messages,maxTokens,jsonOutput,authorization,thinking});
  const file=path.join(data,'director-requests',requestId+'.json');
  const work=async()=>{
   const old=await readJson(file,null);
   if(old){
    if(old.signature!==signature||old.scope!==scope)throw userError('请求编号已用于其他内容，请重新检查后提交新指令',409);
    if(old.status==='completed')return old.result;
    throw userError(old.status==='failed'?old.message:'原 DeepSeek 请求尚未确认，请先核对账单；不会重复提交',old.status==='failed'?502:409);
   }
   const record={id:requestId,scope,signature,provider,model:authorization.model,createdAt:new Date().toISOString(),status:'submitting',requestCount:1,authorization:{...authorization},thinking};
   await atomicJson(file,record);
   try{
    const result=await helperCall({operation:'complete',provider,messages,maxTokens,jsonOutput,consent,authorization,thinking});
    if(result?.model!==authorization.model||(provider==='miaoapi'&&result?.provider!==provider)||result?.finish_reason!=='stop'||typeof result?.content!=='string'||!result.content.trim())throw userError(spec.label+' 回答未完整结束，未应用；没有自动重试',502);
    record.status='completed';record.result={content:result.content,finish_reason:'stop',model:authorization.model,provider,usage:result.usage||{},estimatedMaximumUSD:result.estimatedMaximumUSD};record.completedAt=new Date().toISOString();await atomicJson(file,record);return record.result;
   }catch(error){record.status='failed';record.message=error.status?error.message:'DeepSeek 请求未确认，请核对官方账单；没有自动重试';record.uncertain=true;await atomicJson(file,record);throw userError(record.message,error.status||502);}
  };
  const previous=locks.get(requestId)||Promise.resolve();const next=previous.catch(()=>{}).then(work);locks.set(requestId,next);
  try{return await next;}finally{if(locks.get(requestId)===next)locks.delete(requestId);}
 }
 return {status,health,completeOnce};
}
