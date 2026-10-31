import {isJimengStudio} from '../public/jimeng-studio-core.js';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {atomicJson,readJson,records,safeId,assertNoCredentials,userError,loadAsset} from './workspace.mjs';
import {planNativeCascade,validateNativeCascadeProgram} from './native-cascade-plan.mjs';
import {createNativeCascadeState,executeNativeCascade,validateNativeCascadeState} from './native-cascade-execution.mjs';
import {cascadeChildKind,nativeCascadeChildAdapter} from './native-cascade-children.mjs';
import {nativeCascadeRequestPreparer,compileCascadeEnhancement} from './native-cascade-requests.mjs';
import {configuredGraph,fieldKey} from './workflow-fields.mjs';
import {comfyRandomFields} from './workflow-random.mjs';
import {normalizePromptBatch,batchCount,batchGraph,validateBatchGraphs} from './prompt-batch.mjs';
import {normalizeImageBinding,imageCredentials,clearImageCredentials,imageCredentialPayload,clearCanvasApiCredentialMap,clearCanvasMiaoChoices} from './canvas-images.mjs';
import {normalizeStudioBinding,studioCredentials,clearStudioCredentials,studioCredentialPayload} from './canvas-studio.mjs';
import {cloudCredentials,clearCloudCredentials} from './canvas-cloud.mjs';
import {validateComfyEndpoint} from './providers.mjs';
import {isArkMultimodal} from '../public/ark-reference-core.js';
import {studioRequestCount,studioModelscopeReferenceLimit} from '../public/native-modelscope-core.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const credentialError=()=>userError('请重新核对此智能串联步骤的服务、素材发送范围和预算');
export function publicCascadeJob(job){
 const {snapshot,endpoint,loopBackends,cascadeProgram,cascadeState,...visible}=job;
 const uncertain=cascadeState?.rounds.some(round=>round.receipts.some(receipt=>receipt.kind==='generate'&&receipt.status!=='completed'&&!receipt.childJobId));
 return {...visible,canResume:['cancelled','interrupted'].includes(job.status)&&!uncertain};
}

// Product admission is deliberately separate from the edge interpreter. A GET
// only reads templates. A POST needs an unchanged preview and per-step consent;
// keys stay in the launch closure and never enter a job, snapshot or receipt.
export function nativeCascadeRunner({data,activeJobs,generation,cloudWorkflows,directImages,creationStudio,pollInterval=100}){
 const file=id=>{if(!safeId(id))throw userError('任务编号无效');return path.join(data,'jobs',id+'.json');};
 async function plan(project,{nodeId}={}){
  const program=planNativeCascade(project,{nodeId}),steps=[];
  for(const round of program.rounds)for(const operation of round.operations){
   const sender=project.nodes.find(node=>node.id===operation.sourceNodeId),receiver=project.nodes.find(node=>node.id===operation.targetNodeId);
   const step={executionId:operation.id,nodeId:operation.requestNodeId||operation.sourceNodeId,
    title:`${sender.title} → ${receiver?.title||'本轮新素材'}`,cascadeKind:operation.kind,sourceNodeId:sender.id,targetNodeId:operation.targetNodeId,
    count:0,status:'pending',roundIndex:round.roundIndex,roundCount:program.rounds.length,
    ...(program.loop?{loopId:program.loop.nodeId,loopTitle:project.nodes.find(node=>node.id===program.loop.nodeId).title,
     nativeLoop:{version:1,mode:program.loop.mode,index:round.index,total:round.total}}:{})};
   if(operation.kind!=='generate'){steps.push({...step,kind:'cascade-'+operation.kind});continue;}
   const node=project.nodes.find(node=>node.id===operation.requestNodeId),kind=cascadeChildKind(node);
   const binding=node.params[{comfy:'workflowBinding',runninghub:'cloudBinding','image-api':'imageBinding',studio:'studioBinding'}[kind]];
   if(binding.minimaxH3||binding.ltxDirector||(binding.promptBatch||binding.imageEnhance)&&kind!=='comfy')throw userError(`“${node.title}”的H3、LTX或非Comfy专用参数尚不支持智能串联；原配置保留，未提交任务`);
   Object.assign(step,{kind,text:node.params.nativeCanvas.node.promptDraftText||node.text||'',sendAssets:true,count:1});
   if(kind==='comfy'){
    const template=await generation.template(binding.workflowId),random=comfyRandomFields(template,binding.randomFields),randomKeys=new Set(random.map(fieldKey)),graph=configuredGraph(template,(binding.overrides||[]).filter(field=>!randomKeys.has(fieldKey(field)))),promptBatch=normalizePromptBatch(template,binding.promptBatch),count=batchCount(binding.count,promptBatch);
    if(promptBatch&&binding.promptField?.nodeId===promptBatch.nodeId&&binding.promptField?.name===promptBatch.name)throw userError('同一文字字段不能同时使用上游文字和提示词列表');
    if(binding.imageEnhance){const compiled=compileCascadeEnhancement(binding,template,{planning:true});step.imageEnhance=compiled.recipe;step.text='';}
    else validateBatchGraphs(template,batchGraph(graph,round.roundIndex*count,null,binding.incrementSeeds===true,random),count,promptBatch,binding.incrementSeeds===true,random);
    if(promptBatch)step.promptBatch=promptBatch;
    Object.assign(step,{workflowId:template.id,workflowRevision:template.revision,count});
   }else if(kind==='runninghub'){
    const recipe=await cloudWorkflows.get(binding.recipeId);
    if(recipe.projectId!==project.id||recipe.revision!==binding.recipeRevision)throw userError('串联云工作流归属或版本已变化');
    Object.assign(step,{recipe:structuredClone(recipe),outputType:recipe.outputType});
   }else if(kind==='image-api'){
    const image=normalizeImageBinding(binding);
    if(image.platform.models[0]?.referenceSupport!==true)throw userError('串联图片模型需要支持参考图；请先核对模型能力');
    step.image=image;
   }else{
    step.studio=normalizeStudioBinding(binding);
    if(step.studio.config.nativeModelscope){if(program.loop)step.studio.config.count=1;step.count=studioRequestCount(step.studio);step.sendAssets=studioModelscopeReferenceLimit(step.studio)>0;}
    // Later steps may receive fresh media. Only the protocol that can actually
    // send audio/video originals asks for that additional scope.
    step.sendOriginalMedia=isArkMultimodal(step.studio)||isJimengStudio(step.studio)&&step.studio.config.jimeng.command==='multimodal2video';if(isJimengStudio(step.studio))step.projectId=project.id;
   }
   steps.push(step);
  }
  const requestCount=steps.reduce((total,step)=>total+step.count,0);
  if(requestCount>1000)throw userError('展开后的实际生成请求超过1000次，请减少轮数或单节点批次');
  assertNoCredentials(steps);
  return {steps,program,previewHash:hash({revision:project.revision,project,program,steps}),summary:{
   operations:program.operationCount,generations:program.generationOperationCount,requests:requestCount,
   sharedCopies:steps.filter(step=>step.cascadeKind==='copy').length,relays:steps.filter(step=>step.cascadeKind==='relay').length}};
 }
 function clear(body){clearCloudCredentials(body);clearImageCredentials(body);clearStudioCredentials(body);}
 function keysFor(steps,body,resume=false){
  const keys=new Map();
  try{for(const collect of [cloudCredentials,imageCredentials,studioCredentials]){
   const partial=collect(steps,body,{resume});for(const [id,value]of partial)keys.set(id,value);partial.clear();
  }return keys;}
  catch(error){clearCanvasApiCredentialMap(keys);throw error;}
  finally{clear(body);}
 }
 async function start(project,body,endpoint){try{return await startPrepared(project,body,endpoint);}finally{clearCanvasMiaoChoices(body);}}
 async function startPrepared(project,body,endpoint){
  if(!safeId(body.requestId))throw userError('请求编号无效');
  const old=(await records(path.join(data,'jobs'))).find(job=>job.kind==='canvas-run'&&job.projectId===project.id&&job.requestId===body.requestId);
  if(old){clear(body);if(old.executionMode!=='native-cascade')throw userError('请求编号已用于另一种画布执行');return publicCascadeJob(old);}
  if(body.consent!==true||body.revision!==project.revision)throw userError('画布已更新或尚未确认执行范围',409);
  if([...activeJobs.values()].some(job=>job.projectId===project.id))throw userError('项目已有运行任务，请先完成或停止',409);
  const preview=await plan(project,{nodeId:body.nodeId});
  if(body.previewHash!==preview.previewHash)throw userError('串联或工作流已更新，请重新检查后运行',409);
  const pool=endpoint?.parallelBackends||[endpoint];
  if(preview.steps.some(step=>step.kind==='comfy')){
   for(const backend of pool)validateComfyEndpoint(backend);
   if(pool.length>6||new Set(pool.map(backend=>validateComfyEndpoint(backend).href)).size!==pool.length)throw userError('串联请选择1–6个不同后端');
   if(pool.length>1&&preview.program.scheduling.mode!=='parallel')throw userError('多个后端仅用于并行智能循环');
  }
  const keys=keysFor(preview.steps,body);
  try{
  for(const value of keys.values())if(typeof value==='string'&&JSON.stringify({project,steps:preview.steps}).includes(value))throw userError('项目内容包含本次密钥，请先移除');
  const job={id:randomUUID(),kind:'canvas-run',executionMode:'native-cascade',projectId:project.id,nodeId:body.nodeId,
   requestId:body.requestId,revision:project.revision,name:project.name+' · 智能串联',createdAt:new Date().toISOString(),
   status:'queued',progress:0,message:'等待按连线传递素材',assets:[],textResults:[],steps:preview.steps,summary:preview.summary,
   snapshot:structuredClone(project),cascadeProgram:preview.program,cascadeState:createNativeCascadeState(project,preview.program),
   endpoint,loopBackends:pool,backend:typeof endpoint==='object'?{id:endpoint.id,name:endpoint.name,url:endpoint.url}:null};
  assertNoCredentials({...job,steps:job.steps.map(({authorization,...step})=>step)});
  await atomicJson(file(job.id),job);launch(job,keys);return publicCascadeJob(job);
  }catch(error){clearCanvasApiCredentialMap(keys);throw error;}
 }
 function launch(job,keys){
  const controller=new AbortController();activeJobs.set(job.id,{controller,projectId:job.projectId,kind:'canvas-run'});
  void run(job,controller,keys);
 }
 async function run(job,controller,keys){
  const known=new Map(job.snapshot.assets.map(asset=>[asset.id,asset]));let writeQueue=Promise.resolve();
  const save=async()=>{const copy=structuredClone(job);writeQueue=writeQueue.then(()=>atomicJson(file(job.id),copy));return writeQueue;};
  try{
   validateNativeCascadeProgram(job.snapshot,job.cascadeProgram);validateNativeCascadeState(job.snapshot,job.cascadeProgram,job.cascadeState);
   const byId=new Map(job.steps.map(step=>[step.executionId,step]));
   const preparer=nativeCascadeRequestPreparer({data,generation,cloudWorkflows,
    endpoint:request=>job.loopBackends[request.context.roundIndex%job.loopBackends.length],
    authorizationFor:async(request,actual)=>{
     const expected=byId.get(request.operation.id),a=expected.authorization;
     if(!a||expected.kind!==actual.kind)throw credentialError();
     if(actual.sendAssets&&!expected.sendAssets||actual.sendOriginalMedia&&!a.sendOriginalMedia)throw credentialError();
     const returned={...a,...(isJimengStudio(actual.studio)?{sendOriginalMedia:actual.sendOriginalMedia===true}:{}),...(actual.kind==='runninghub'?{sendAssets:actual.sendAssets}:{sendReferences:actual.sendAssets})};
     return returned;
    }});
   const adapter=nativeCascadeChildAdapter({data,project:job.snapshot,program:job.cascadeProgram,parentId:job.id,
    activeJobs,generation,cloudWorkflows,directImages,creationStudio,pollInterval,
    enhancementFor:operation=>byId.get(operation.id)?.actualInput,
    batchProgressFor:operation=>byId.get(operation.id)?.childRequests,
    onBatchProgress:async(operation,value)=>{const step=byId.get(operation.id);if(JSON.stringify(step.childRequests)!==JSON.stringify(value)){step.childRequests=structuredClone(value);await save();}},
    credentialsFor:request=>{const value=keys.get(request.operation.id);return byId.get(request.operation.id)?.kind==='image-api'?imageCredentialPayload(value):typeof value==='string'?{apiKey:value}:studioCredentialPayload(value||{});},
    prepare:async request=>{
     const step=byId.get(request.operation.id);
     if(step.kind==='comfy'&&(await generation.template(step.workflowId)).revision!==step.workflowRevision)throw userError('本次串联工作流已修改，停止后续步骤，请重新检查');
     const prepared=await preparer.prepare(request);
     if(step.imageEnhance&&(prepared.body?.workflowId!==step.workflowId||prepared.body?.workflowRevision!==step.workflowRevision
      ||prepared.ledger?.enhancement?.workflowId!==step.workflowId||prepared.ledger?.enhancement?.workflowRevision!==step.workflowRevision))
      throw userError('本次串联增强工作流在准备期间已修改，停止后续步骤，请重新检查');
     if(step.promptBatch&&(prepared.body?.workflowId!==step.workflowId||prepared.body?.workflowRevision!==step.workflowRevision
      ||prepared.ledger?.batchExecution?.workflowRevision!==step.workflowRevision||JSON.stringify(prepared.ledger?.promptBatch)!==JSON.stringify(step.promptBatch)))
      throw userError('本次串联列表工作流在准备期间已修改，停止后续步骤，请重新检查');
     assertNoCredentials(prepared.ledger);
     step.actualInput=structuredClone(prepared.ledger);await save();
     return prepared;
    }});
   job.cascadeState=(await adapter.reconcile(job.cascadeState)).state;job.status='running';await save();
   await executeNativeCascade({project:job.snapshot,program:job.cascadeProgram,state:job.cascadeState,
    generate:adapter.generate,signal:controller.signal,comfyInstanceCount:job.loopBackends.length,
    persist:async state=>{
     job.cascadeState=state;
     for(const round of state.rounds)for(const receipt of round.receipts){
      const step=byId.get(receipt.operationId);step.status=receipt.status;
      if(receipt.childJobId)step.jobId=receipt.childJobId;
      if(receipt.status==='completed')for(const ref of receipt.outputRefs)if(!known.has(ref.assetId))known.set(ref.assetId,await loadAsset(data,ref.assetId));
     }
     const generated=new Set(state.rounds.flatMap(round=>round.receipts.filter(receipt=>receipt.kind==='generate'&&receipt.status==='completed'&&!receipt.usedFallback).flatMap(receipt=>receipt.outputRefs.map(ref=>ref.assetId))));
     job.assets=[...generated].map(id=>known.get(id));
     job.progress=Math.round(state.completedOperationCount/job.cascadeProgram.operationCount*100);
     job.message=`已完成 ${state.completedOperationCount}/${job.cascadeProgram.operationCount} 步 · ${job.assets.length} 份素材`;
     await save();
    }});
   job.status=job.cascadeState.status==='stopped'?'cancelled':job.cascadeState.status;
   if(job.status==='completed')job.message=`智能串联完成：${job.assets.length} 份新素材，传递记录已保留，可检查后加入画布`;
   else job.message=job.status==='cancelled'?'已停止后续串联，原任务和已完成结果保留':job.cascadeState.error||'智能串联未完成';
  }catch(error){job.status=controller.signal.aborted?'cancelled':'failed';job.message=String(error.message||error).slice(0,1000);}
  finally{try{await save();}finally{clearCanvasApiCredentialMap(keys);activeJobs.delete(job.id);}}
 }
 async function resume(id,body={}){try{return await resumePrepared(id,body);}finally{clearCanvasMiaoChoices(body);}}
 async function resumePrepared(id,body={}){
  let job=await readJson(file(id));if(creationStudio?.recoverCanvasLinks)job=await creationStudio.recoverCanvasLinks(job);
  if(job.executionMode!=='native-cascade'||!['cancelled','interrupted'].includes(job.status))throw userError('此智能串联任务不能继续，请读取原任务状态');
  if([...activeJobs.values()].some(item=>item.projectId===job.projectId))throw userError('项目仍有任务运行',409);
  validateNativeCascadeProgram(job.snapshot,job.cascadeProgram);validateNativeCascadeState(job.snapshot,job.cascadeProgram,job.cascadeState);
  const keys=keysFor(job.steps,body,true);job.status='queued';try{await atomicJson(file(id),job);launch(job,keys);return publicCascadeJob(job);}catch(error){clearCanvasApiCredentialMap(keys);throw error;}
 }
 return {plan,start,resume};
}
