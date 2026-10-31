import {conflictingCanvasChild} from './canvas-child-scope.mjs';
import {resolveRhLoras} from './runninghub-loras.mjs';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {atomicJson,readJson,records,safeId,userError,loadAsset,storeAsset,assertNoCredentials} from './workspace.mjs';
import {rhId,rhBase,discoverRh,uploadRh,submitRh,queryRh,downloadRh,checkRhMedia} from './runninghub.mjs';
import {normalizeCloudRecipe} from './cloud-recipes.mjs';
import {minimaxLimits} from '../public/minimax-h3-core.js';
import {cloudRandomFields,chooseWorkflowRandom,applyCloudRandom,validateSavedCloudRandom} from './workflow-random.mjs';
import {activeRhFields,compileRhModel,checkRhModelMedia,uploadRhModel,submitRhModel,queryRhAccount} from './runninghub-models.mjs';
const id=x=>{if(!safeId(x))throw userError('编号无效');return x;};
const checkKey=key=>{if(typeof key!=='string'||!key.trim()||key.length>4096||/[\r\n]/.test(key))throw userError('请输入本次 RunningHub API Key');return key.trim();};
const pause=(ms,signal)=>new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(Error('stopped'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
export function cloudWorkflowService({data,projects,activeJobs,pollInterval=2500,workflowRandomDraw}){
 const dir=path.join(data,'cloud-workflows'),file=key=>path.join(dir,id(key)+'.json'),jobFile=key=>path.join(data,'jobs',id(key)+'.json'),locks=new Map();
 async function locked(key,fn){const previous=locks.get(key)||Promise.resolve(),task=previous.catch(()=>{}).then(fn);locks.set(key,task);try{return await task;}finally{if(locks.get(key)===task)locks.delete(key);}}
 const normalize=normalizeCloudRecipe;
 const get=key=>readJson(file(key));
 const list=async projectId=>(await records(dir)).filter(r=>r.projectId===projectId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
 async function persist(r){await atomicJson(path.join(dir,'history',r.id,r.revision+'-'+randomUUID()+'.json'),r);await atomicJson(file(r.id),r);return r;}
 async function create(b){await projects.load(id(b.projectId));return persist({id:randomUUID(),projectId:b.projectId,revision:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),...normalize({name:b.name||'RunningHub 工作流',kind:'workflow',baseUrl:'https://www.runninghub.cn',fields:[]})});}
 async function save(key,b){return locked(key,async()=>{const old=await get(key);if(old.revision!==b.revision)throw userError('配置已在另一窗口修改，请重新打开',409);const normalized=normalize(b),next={...old,...normalized,revision:old.revision+1,updatedAt:new Date().toISOString()};if(!normalized.workflowJson)delete next.workflowJson;if(!normalized.minimaxProfile)delete next.minimaxProfile;if(next.kind!=='model'){delete next.catalogVersion;delete next.outputType;}return persist(next);});}
 async function discover(b){if(b.consent!==true)throw userError('请确认向所填平台发送字段查询');if(b.includeWorkflow!==undefined&&typeof b.includeWorkflow!=='boolean')throw userError('整图查询选项无效');return discoverRh({baseUrl:rhBase(b.baseUrl),apiKey:checkKey(b.apiKey),kind:b.kind,targetId:rhId(b.targetId),includeWorkflow:b.includeWorkflow===true,signal:AbortSignal.timeout(30000)});}
 const jobs=async key=>(await records(path.join(data,'jobs'))).filter(j=>j.kind==='runninghub'&&j.recipeId===key).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
 async function start(key,b,context){return locked('run-'+key,async()=>{
  id(b.requestId);const prior=(await jobs(key)).find(j=>j.requestId===b.requestId);if(prior)return prior;
  const rawRecipe=context?.recipe||await get(key),recipe={...rawRecipe,...normalize(rawRecipe)};if(context)assertParent(context.parentJobId,recipe.projectId);if(recipe.revision!==b.revision)throw userError('配置已更新，请重新检查参数',409);
  if(conflictingCanvasChild(activeJobs,recipe.projectId,context?.parentJobId))throw userError('当前项目还有运行中的任务',409);
  if(recipe.kind==='model')compileRhModel(recipe,{allowAssets:true});else rhId(recipe.targetId);const apiKey=checkKey(b.apiKey),a=b.authorization;
  if(!a||a.origin!==new URL(recipe.baseUrl).origin||a.targetId!==recipe.targetId||a.kind!==recipe.kind||a.requestLimit!==1||a.sendFields!==true||a.sendAssets!==(activeRhFields(recipe).some(f=>f.source==='asset'))||!Number.isFinite(a.budget)||a.budget<=0||!['CNY','USD'].includes(a.currency))throw userError('请确认本次平台、应用/工作流、字段、素材与预算');
  if(recipe.workflowJson?a.sendWorkflow!==true:a.sendWorkflow===true)throw userError('请单独确认本次发送 RunningHub API 整图');
  if(JSON.stringify(recipe).includes(apiKey))throw userError('配置内容包含本次密钥，请移除后再运行');
  const project=context?.project||await projects.load(recipe.projectId),assetIds=[...new Set(activeRhFields(recipe).filter(f=>f.source==='asset').map(f=>f.assetId))];if(assetIds.length>(recipe.minimaxProfile==='h3'?15:recipe.kind==='model'?32:8))throw userError('参考素材数量超过本次允许范围');
  if(recipe.minimaxProfile==='h3'){const counts={image:0,video:0,audio:0};for(const f of activeRhFields(recipe).filter(f=>f.source==='asset'))if(++counts[f.type]>minimaxLimits[f.type])throw userError('H3 RunningHub 参考素材最多9图3视频3音频');}
  for(const assetId of assetIds){if(!project.assets.some(a=>a.id===assetId))throw userError('请先把参考素材加入当前项目');const meta=await loadAsset(data,assetId),bytes=await fs.readFile(path.join(data,'assets',assetId));checkRhMedia(bytes,meta.type);for(const f of activeRhFields(recipe).filter(f=>f.assetId===assetId)){if(recipe.kind==='model')checkRhModelMedia(bytes,meta.type,f);else if(meta.type.split('/')[0]!==f.type)throw userError('字段类型与素材类型不一致');}}
  await resolveRhLoras({data,project,recipe});
  const randomFields=cloudRandomFields(recipe,b.randomFields??(recipe.minimaxProfile==='h3'?[]:undefined));if(recipe.minimaxProfile==='h3'&&randomFields.length)throw userError('H3 随机由片段管理，请关闭通用字段随机');const randomRecord=chooseWorkflowRandom(randomFields,1,{record:context?.workflowRandom,draw:workflowRandomDraw});
  const job={id:randomUUID(),kind:'runninghub',recipeId:recipe.id,projectId:recipe.projectId,name:recipe.name,createdAt:new Date().toISOString(),status:'queued',progress:0,message:'准备上传及运行',assets:[],textResults:[],processedResults:[],requestId:b.requestId,requestCount:0,uploadCount:0,input:{recipe},authorization:{origin:a.origin,targetId:recipe.targetId,kind:recipe.kind,requestLimit:1,sendFields:true,sendAssets:assetIds.length>0,...(recipe.workflowJson?{sendWorkflow:true}:{}),budget:a.budget,currency:a.currency},billingStatus:'unknown',...(context?{parentJobId:context.parentJobId}:{})};
  if(randomRecord)job.workflowRandom=randomRecord;if(randomRecord||b.randomFields!==undefined||recipe.fields.some(f=>f.randomEnabled))job.randomFields=randomFields.map(({nodeId,name})=>({nodeId,name}));
  await atomicJson(jobFile(job.id),job);launch(job,apiKey,false,context?.parentJobId);return structuredClone(job);
 });}
 function launch(job,key,resuming,parentJobId){const controller=new AbortController(),parentSignal=activeJobs.get(parentJobId)?.controller.signal,stop=()=>controller.abort();parentSignal?.addEventListener('abort',stop,{once:true});if(parentSignal?.aborted)controller.abort();activeJobs.set(job.id,{controller,projectId:job.projectId,recipeId:job.recipeId,kind:'runninghub',...(parentJobId?{parentId:parentJobId}:{})});
  void(async()=>{const recipe=job.input.recipe,signal=AbortSignal.any([controller.signal,AbortSignal.timeout(1800000)]),opts={baseUrl:recipe.baseUrl,apiKey:key,signal};try{
   validateSavedCloudRandom(job);const executable=applyCloudRandom(recipe,job.workflowRandom);
   job.status='running';await atomicJson(jobFile(job.id),job);
   if(!resuming){const fields=structuredClone(executable.fields),uploaded=new Map();for(const f of fields.filter(f=>f.source==='asset'&&f.enabled!==false)){signal.throwIfAborted();if(!uploaded.has(f.assetId)){const meta=await loadAsset(data,f.assetId);job.message='正在上传已授权的项目素材';job.uploadCount++;await atomicJson(jobFile(job.id),job);const token=await (recipe.kind==='model'?uploadRhModel:uploadRh)({...opts,bytes:await fs.readFile(path.join(data,'assets',f.assetId)),mime:meta.type});uploaded.set(f.assetId,token);}f.fieldValue=uploaded.get(f.assetId);f.source='value';delete f.assetId;}
    signal.throwIfAborted();job.message='正在提交 RunningHub 任务';job.requestCount=1;await atomicJson(jobFile(job.id),job);job.upstreamId=recipe.kind==='model'?await submitRhModel({...opts,recipe:{...recipe,fields}}):await submitRh({...opts,kind:recipe.kind,targetId:recipe.targetId,fields,workflowJson:recipe.workflowJson});await atomicJson(jobFile(job.id),job);
   }
   let result;while(true){signal.throwIfAborted();result=await queryRh({...opts,taskId:job.upstreamId});if(result.status==='completed')break;if(result.status==='failed'){job.status='failed';job.uncertain=false;job.message='RunningHub 原任务失败，请到平台查看原因';return;}job.progress=20;job.message='正在查询 RunningHub 原任务';await atomicJson(jobFile(job.id),job);await pause(pollInterval,signal);}
   for(const [index,r] of result.results.entries()){signal.throwIfAborted();if(Array.isArray(job.processedResults)?job.processedResults.includes(index):index<job.assets.length)continue;job.message='正在保存第 '+(index+1)+' 项结果';const output=await downloadRh(r,opts),ext={'image/jpeg':'jpg','audio/mpeg':'mp3','text/plain':'txt','model/gltf-binary':'glb'}[output.mime]||output.mime.split('/')[1],asset=await storeAsset(data,output.bytes,{name:recipe.name.slice(0,80)+'-'+(index+1)+'.'+ext,type:output.mime,source:'runninghub'});job.assets.push(asset);if(output.mime==='text/plain')job.textResults.push({id:asset.id,assetId:asset.id,title:asset.name,text:output.text});job.processedResults=[...(job.processedResults||[]),index];await atomicJson(jobFile(job.id),job);}
   job.status='completed';job.progress=100;job.message='结果已保存到本机，可放入画布';job.uncertain=false;
  }catch(e){job.status=controller.signal.aborted?'cancelled':'failed';job.uncertain=!!job.upstreamId||job.requestCount>0&&e.uncertain!==false;job.message=controller.signal.aborted?'已停止本机等待，平台可能仍在运行；不会自动重发':e.publicMessage||'任务未完成，请核对平台记录和原任务；不会自动重发';}
  finally{parentSignal?.removeEventListener('abort',stop);key='';opts.apiKey='';await atomicJson(jobFile(job.id),job);activeJobs.delete(job.id);}})();
 }
 async function resume(recipeId,jobId,b,context){return locked('run-'+recipeId,async()=>{const job=await readJson(jobFile(jobId));if(job.kind!=='runninghub'||job.recipeId!==recipeId||!job.upstreamId)throw userError('没有属于此配置的原任务编号');if(job.status==='completed')return job;if(context)assertParent(context.parentJobId,job.projectId);if(context&&job.parentJobId!==context.parentJobId)throw userError('云子任务不属于当前画布运行');if(conflictingCanvasChild(activeJobs,job.projectId,context?.parentJobId))throw userError('当前项目已有运行中的任务',409);validateSavedCloudRandom(job);const key=checkKey(b.apiKey);job.status='running';await atomicJson(jobFile(job.id),job);launch(job,key,true,context?.parentJobId);return structuredClone(job);});}
 async function apply(recipeId,jobId,b){const job=await readJson(jobFile(jobId));if(job.kind!=='runninghub'||job.recipeId!==recipeId||job.status!=='completed')throw userError('结果未完成或不属于当前配置');return projects.apply(job,b.revision);}
 function assertParent(parentId,projectId){const p=activeJobs.get(parentId);if(!p||p.kind!=='canvas-run'||p.projectId!==projectId||p.controller.signal.aborted)throw userError('没有正在执行的所属画布任务');}
 async function preview(key){const recipe=normalize(await get(key));return recipe.kind==='model'?{kind:recipe.kind,payload:compileRhModel(recipe,{allowAssets:true})}:{kind:recipe.kind,fields:recipe.fields,...(recipe.workflowJson?{workflowJson:recipe.workflowJson,minimaxProfile:recipe.minimaxProfile}: {})};}
 async function account(b){if(b.consent!==true)throw userError('请确认向所填平台查询账户余额');return queryRhAccount({baseUrl:rhBase(b.baseUrl),apiKey:checkKey(b.apiKey),signal:AbortSignal.timeout(30000)});}
 return {preview,account,get,list,create,save,discover,jobs,start,resume,apply,startFromCanvas:(recipe,project,b,parentJobId,{workflowRandom}={})=>start(recipe.id,b,{recipe,project,parentJobId,workflowRandom}),resumeFromCanvas:(recipeId,jobId,b,parentJobId)=>resume(recipeId,jobId,b,{parentJobId})};
}
