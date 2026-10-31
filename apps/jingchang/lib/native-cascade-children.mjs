import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {atomicJson,readJson,records,safeId,userError,loadAsset,assertNoCredentials} from './workspace.mjs';
import {assertCanvasParent} from './canvas-child-scope.mjs';
import {validateNativeCascadeState} from './native-cascade-execution.mjs';
import {stripCascadeRefs} from './native-cascade-media.mjs';
import {annotateEnhancement} from './image-enhance.mjs';
import {normalizeEnhancement} from '../public/image-enhance-core.js';
import {validateSavedWorkflowRandom} from './workflow-random.mjs';
import {normalizeNativeModelscopeConfig,studioRequestCount} from '../public/native-modelscope-core.js';
import {validateNativeModelscopeBatch,nativeModelscopeHasOriginalIds} from './native-modelscope-batch.mjs';
import {normalizeStudioBinding} from './canvas-studio.mjs';
import {normalizeLoras} from './native-protocols.mjs';

export const cascadeChildRequestId=(parentId,operationId)=>'cascade-child-'+createHash('sha256').update(parentId+'|'+operationId).digest('hex');
export function cascadeChildKind(node){
 const kinds=[['workflowBinding','comfy'],['cloudBinding','runninghub'],['imageBinding','image-api'],['studioBinding','studio']].filter(([field])=>node.params?.[field]);
 if(kinds.length!==1)throw userError('智能串联发送方须明确绑定一种本机工作流、云工作流或媒体接口');
 return kinds[0][1];
}
const assetRefs=child=>stripCascadeRefs((child.assets||[]).map(asset=>({assetId:asset.id,name:asset.name,kind:['image','video','audio','text'].includes(asset.type?.split('/')[0])?asset.type.split('/')[0]:'file'})));

// Reuses existing generation services. prepare supplies a validated, ephemeral
// request; credentialsFor is private to the parent run and never enters state.
// Admission/authorization remain enforced by the original service methods.
export function nativeCascadeChildAdapter({data,project,program,parentId,activeJobs,generation,cloudWorkflows,directImages,creationStudio,prepare,credentialsFor=async()=>({}),enhancementFor=()=>null,batchProgressFor=()=>null,onBatchProgress=async()=>{},pollInterval=100}){
 if(!safeId(parentId)||typeof prepare!=='function'||typeof credentialsFor!=='function'||typeof enhancementFor!=='function'||!Number.isSafeInteger(pollInterval)||pollInterval<1||pollInterval>30000)throw userError('智能串联子任务适配器配置无效');
 const byId=new Map(project.nodes.map(node=>[node.id,node])),knownAssets=new Map(project.assets.map(asset=>[asset.id,asset]));
 const file=id=>{if(!safeId(id))throw userError('智能串联子任务编号无效');return path.join(data,'jobs',id+'.json');};
 function verify(child,operation){
  const node=byId.get(operation.requestNodeId),kind=cascadeChildKind(node),parent=kind==='runninghub'?child.parentJobId:child.parentId;
  if(child.kind!==kind||child.projectId!==project.id||parent!==parentId||child.requestId!==cascadeChildRequestId(parentId,operation.id)
   ||['comfy','image-api'].includes(kind)&&child.target?.id!==operation.requestNodeId||kind==='studio'&&child.nodeId!==operation.requestNodeId
   ||kind==='runninghub'&&child.recipeId!==node.params.cloudBinding.recipeId)throw userError('智能串联原子任务不属于原发送方或父任务');
  return kind;
 }
 function remember(child){for(const asset of child.assets||[])knownAssets.set(asset.id,structuredClone(asset));}
 function enhancementRecord(child,operation,{stored=false}={}){
  const binding=byId.get(operation.requestNodeId).params.workflowBinding;
  if(!binding?.imageEnhance)return null;
  let policy;try{policy=normalizeEnhancement(binding.imageEnhance);}catch(error){throw userError(error.message);}
  const input=enhancementFor(operation),record=input?.enhancement||child.cascadeEnhancement;
  if(!record||stored&&!child.cascadeEnhancement)throw userError('原增强任务实际参数收据缺失，不会重新生成');
  assertNoCredentials(record);
  const {kind,engine,strength,resolution,maxResolution,seedMode,sourceAssetId,sourceIdentity,workflowId,workflowRevision,seed}=record;
  const parametersMatch=kind===policy.kind&&(kind==='enhance'?policy.strength===strength&&resolution===undefined&&maxResolution===undefined&&child.workflow?.[policy.strengthField.nodeId]?.inputs?.[policy.strengthField.name]===strength
   :kind==='upscale'&&strength===undefined&&policy.resolution===resolution&&policy.maxResolution===maxResolution
    &&child.workflow?.[policy.resolutionField.nodeId]?.class_type==='SeedVR2VideoUpscaler'
    &&child.workflow?.[policy.resolutionField.nodeId]?.inputs?.[policy.resolutionField.name]===resolution
    &&child.workflow?.[policy.maxResolutionField.nodeId]?.inputs?.[policy.maxResolutionField.name]===maxResolution);
  if(engine!=='comfy'||policy.kind!==kind||policy.engine!==engine||!parametersMatch||policy.seedMode!==seedMode
   ||binding.minimaxH3||binding.ltxDirector||binding.promptBatch||(binding.count??1)!==1||binding.incrementSeeds===true
   ||workflowId!==binding.workflowId||workflowId!==child.workflowId||!Number.isSafeInteger(workflowRevision)||workflowRevision<0
   ||!safeId(sourceAssetId)||typeof sourceIdentity!=='string'||!/^[a-f0-9]{64}$/.test(sourceIdentity)
   ||child.count!==1||child.incrementSeeds===true||child.randomFields?.length
   ||child.imageBindings?.length!==1||child.imageBindings[0].nodeId!==policy.imageField.nodeId||child.imageBindings[0].name!==policy.imageField.name||child.imageBindings[0].assetId!==sourceAssetId)
   throw userError('原增强任务的图片、强度、分辨率或工作流与实际收据不一致，后续未提交');
  if(seedMode==='workflow'?seed!==undefined:!Number.isSafeInteger(seed)||seed<0||seed>4294967295||seedMode==='fixed'&&seed!==policy.seed
   ||seedMode!=='workflow'&&policy.seedFields.some(field=>child.workflow?.[field.nodeId]?.inputs?.[field.name]!==seed))
   throw userError('原增强任务种子与实际收据不一致，不会重新选择');
  if(input&&(!input.referenceRefs?.some(ref=>ref.identity===sourceIdentity&&ref.assetId===sourceAssetId&&ref.kind==='image')
   ||!input.mappings?.some(ref=>ref.identity===sourceIdentity&&ref.assetId===sourceAssetId)))throw userError('原增强任务来源身份与实际素材映射不一致');
  const exact={kind,engine,...(kind==='upscale'?{resolution,maxResolution}:{strength}),seedMode,sourceAssetId,sourceIdentity,workflowId,workflowRevision,...(seed!==undefined?{seed}:{})};
  if(JSON.stringify(record)!==JSON.stringify(exact)||child.cascadeEnhancement&&JSON.stringify(child.cascadeEnhancement)!==JSON.stringify(exact))throw userError('原增强任务实际参数记录冲突');
  return {record:exact,recipe:{...policy,...(seed!==undefined?{seed}:{})}};
 }
 async function validateEnhancementAssets(child,operation){
  const value=enhancementRecord(child,operation,{stored:true});if(!value)return;
  const source=await loadAsset(data,value.record.sourceAssetId),expected={kind:value.record.kind,engine:'comfy',sourceAssetId:source.id,originalAssetId:source.enhancement?.originalAssetId||source.id,
   ...(value.record.kind==='upscale'?{resolution:value.record.resolution,maxResolution:value.record.maxResolution}:{strength:value.record.strength}),...(value.record.seed!==undefined?{seed:value.record.seed}:{})};
  if(!source.type.startsWith('image/')||!child.assets?.length||child.assets.some(asset=>!asset.type?.startsWith('image/')))throw userError('原增强任务没有有效图片结果');
  for(const asset of child.assets){const meta=await loadAsset(data,asset.id);if(JSON.stringify(asset.enhancement)!==JSON.stringify(expected)||JSON.stringify(meta.enhancement)!==JSON.stringify(expected))throw userError('原增强结果来源记录缺失或冲突，已保留原结果');}
 }
 async function finishEnhancement(child,operation){
  const value=enhancementRecord(child,operation);if(!value)return child;
  if(!child.assets?.length||child.assets.some(asset=>!asset.type?.startsWith('image/')))throw userError('原增强任务没有有效图片结果');
  // Wait for the production child writer to leave activeJobs before updating
  // its completed receipt. Resume uses the original actual seed, never compile.
  const assets=await annotateEnhancement(data,child.assets,{imageEnhance:value.recipe,enhanceSourceId:value.record.sourceAssetId});
  const result={...child,assets,cascadeEnhancement:value.record};await atomicJson(file(child.id),result);return result;
 }
 function batchRecord(child,operation,{stored=false}={}){
  const binding=byId.get(operation.requestNodeId).params.workflowBinding;if(!binding?.promptBatch)return null;
  const input=enhancementFor(operation),record=input?{promptBatch:input.promptBatch,batchExecution:input.batchExecution,...(input.workflowRandom?{workflowRandom:input.workflowRandom}:{})}:child.cascadeBatch;
  if(!record||stored&&!child.cascadeBatch)throw userError('原列表任务实际参数收据缺失，不会重新生成');
  assertNoCredentials(record);
  const {promptBatch,batchExecution:b,workflowRandom}=record,expected={nodeId:binding.promptBatch.nodeId,name:binding.promptBatch.name,values:binding.promptBatch.values?.map(value=>typeof value==='string'?value.trim():value)};
  const round=program.rounds.find(round=>round.operations.some(item=>item.id===operation.id));
  if(!b||JSON.stringify(promptBatch)!==JSON.stringify(expected)||JSON.stringify(child.promptBatch)!==JSON.stringify(promptBatch)
   ||!Array.isArray(promptBatch?.values)||promptBatch.values.length<1||promptBatch.values.length>64||b.count!==promptBatch.values.length||child.count!==b.count
   ||b.workflowId!==binding.workflowId||child.workflowId!==b.workflowId||!Number.isSafeInteger(b.workflowRevision)||b.workflowRevision<0
   ||!Number.isSafeInteger(b.seedOffset)||b.seedOffset<0||b.seedOffset>999||b.seedOffset!==round?.roundIndex*b.count||b.incrementSeeds!==(binding.incrementSeeds===true)||child.incrementSeeds!==b.incrementSeeds
   ||JSON.stringify(child.randomFields||[])!==JSON.stringify(b.randomFields)||JSON.stringify(child.workflowRandom||null)!==JSON.stringify(workflowRandom||null)
   ||JSON.stringify(child.imageBindings||[])!==JSON.stringify(b.imageBindings)||!Array.isArray(b.mediaDefaults)||b.mediaDefaults.length!==b.imageBindings?.length
   ||typeof b.workflowHash!=='string'||!/^[a-f0-9]{64}$/.test(b.workflowHash))throw userError('原列表任务条目、随机参数或工作流与实际收据不一致，不会重新抽样或提交');
  validateSavedWorkflowRandom(child);
  const graph=structuredClone(child.workflow);
  const mappings=child.inputMappings||[];
  if(mappings.length>b.imageBindings.length||child.inputPrepared&&mappings.length!==b.imageBindings.length)throw userError('原列表上传映射记录不完整');
  for(const [index,mapping]of mappings.entries()){
   const binding=b.imageBindings[index],uploaded=mapping.uploaded,value=uploaded?.subfolder?uploaded.subfolder+'/'+uploaded.name:uploaded?.name;
   if(mapping.nodeId!==binding.nodeId||mapping.name!==binding.name||mapping.assetId!==binding.assetId||typeof value!=='string'||!value||mapping.value!==value
    ||graph?.[mapping.nodeId]?.inputs?.[mapping.name]!==value)throw userError('原列表上传图片与实际素材映射不一致');
  }
  for(const [index,field]of b.mediaDefaults.entries()){
   const mapped=b.imageBindings[index];if(field.nodeId!==mapped.nodeId||field.name!==mapped.name||typeof field.value!=='string'||typeof graph?.[field.nodeId]?.inputs?.[field.name]!=='string')throw userError('原列表媒体映射与实际收据不一致');
   graph[field.nodeId].inputs[field.name]=field.value;
  }
  if(createHash('sha256').update(JSON.stringify(graph)).digest('hex')!==b.workflowHash)throw userError('原列表工作流参数与实际收据不一致，不会重新提交');
  if(!Array.isArray(child.items)||child.items.length>b.count||child.items.some((item,index)=>item.index!==index||item.prompt!==promptBatch.values[index]
   ||!['submitting','pending','completed','failed'].includes(item.status)||item.promptId!=null&&(typeof item.promptId!=='string'||!item.promptId||item.promptId.length>200||/[\x00-\x1f\x7f/\\]/.test(item.promptId))
   ||['pending','completed'].includes(item.status)&&!item.promptId)
   ||child.status==='completed'&&(child.items.length!==b.count||child.items.some(item=>item.status!=='completed')))throw userError('原列表上游编号或逐项收据不完整，不会重新提交');
  const observed=batchProgressFor(operation);if(observed?.items?.some(item=>item.promptId&&child.items[item.index]?.promptId!==item.promptId))throw userError('原列表已记录的上游编号已变化，不会查询或重新提交');
  if(child.cascadeBatch&&JSON.stringify(child.cascadeBatch)!==JSON.stringify(record))throw userError('原列表任务实际参数记录冲突');
  return record;
 }
 async function reportBatch(child,operation){
  if(byId.get(operation.requestNodeId).params.studioBinding?.config?.nativeModelscope){
   const count=validateNativeModelscopeBatch(child),items=child.items.map(({index,status,upstreamId})=>({index,status,...(upstreamId?{upstreamId}:{})}));
   await onBatchProgress(operation,{kind:'modelscope',count,submitted:items.filter(item=>item.upstreamId).length,attempted:child.requestCount,completed:items.filter(item=>item.status==='completed').length,items});return;
  }
  if(!byId.get(operation.requestNodeId).params.workflowBinding?.promptBatch)return;
  const items=child.items.map(({index,status,promptId})=>({index,status,promptId}));
  await onBatchProgress(operation,{count:child.count,submitted:items.filter(item=>item.promptId).length,completed:items.filter(item=>item.status==='completed').length,items});
 }
 async function finishBatch(child,operation){
  const record=batchRecord(child,operation);if(!record)return child;
  const result={...child,cascadeBatch:record};await atomicJson(file(child.id),result);return result;
 }
 function modelscopeRecord(child,operation,{stored=false}={}){
  const binding=byId.get(operation.requestNodeId).params.studioBinding;if(!binding?.config?.nativeModelscope)return null;
  const input=enhancementFor(operation),record=input?.modelscope||child.cascadeModelscope,c=child.input?.studio?.config;
  const approved=normalizeStudioBinding(binding).config,policy=normalizeNativeModelscopeConfig(approved.nativeModelscope),expectedCount=program.loop?1:studioRequestCount(binding);
  // Older records do not list LoRA separately, but their immutable parent
  // binding remains the authority. Never accept a replaced child's parameters.
  const canonicalLoras=value=>Object.fromEntries(Object.entries(normalizeLoras(value)).sort(([a],[b])=>a.localeCompare(b)));
  const loraIdentity=value=>JSON.stringify(canonicalLoras(value));
  const expectedLoras=loraIdentity(approved.loras);
  if(loraIdentity(c?.loras)!==expectedLoras||record?.loras!==undefined&&loraIdentity(record.loras)!==expectedLoras)
   throw userError('原 ModelScope LoRA 参数与原绑定或实际收据不一致，不会查询或重新提交');
  if(!record||stored&&!child.cascadeModelscope||record.version!==1||record.count!==expectedCount||record.model!==binding.config.model||record.size!==binding.config.size
   ||JSON.stringify(record.nativeModelscope)!==JSON.stringify(policy)||JSON.stringify(c?.nativeModelscope)!==JSON.stringify(policy)
   ||c?.count!==record.count||c?.model!==record.model||c?.size!==record.size||c?.protocol!=='modelscope'||c?.baseUrl!==approved.baseUrl||c?.currency!==approved.currency
   ||child.authorization?.origin!==new URL(approved.baseUrl).origin||child.authorization?.model!==approved.model||child.authorization?.currency!==approved.currency
   ||input&&input.prompt!==child.input.studio.prompt||!Array.isArray(record.referenceAssetIds)||!Array.isArray(record.referenceIdentities)
   ||record.referenceIdentities.length!==record.referenceAssetIds.length||JSON.stringify(child.input.studio.references)!==JSON.stringify(record.referenceAssetIds.map(assetId=>({assetId}))))
   throw userError('原 ModelScope 请求的尺寸、份数、模型或参考图与实际收据不一致，不会重新提交');
  validateNativeModelscopeBatch(child);
  for(const [index,assetId]of record.referenceAssetIds.entries())if(input&&!input.referenceRefs?.some(ref=>ref.identity===record.referenceIdentities[index]&&ref.assetId===assetId&&ref.kind==='image'))throw userError('原 ModelScope 参考图来源收据不一致');
  const observed=batchProgressFor(operation);if(observed?.items?.some(item=>item.upstreamId&&child.items[item.index]?.upstreamId!==item.upstreamId))throw userError('原 ModelScope 已接收编号发生变化，不会重新查询或提交');
  const receiptValue=value=>value.loras===undefined?value:{...value,loras:canonicalLoras(value.loras)};
  if(child.cascadeModelscope&&JSON.stringify(receiptValue(child.cascadeModelscope))!==JSON.stringify(receiptValue(record)))throw userError('原 ModelScope 实际参数收据冲突');return record;
 }
 async function finishModelscope(child,operation){const record=modelscopeRecord(child,operation);if(!record)return child;const result={...child,cascadeModelscope:record};await atomicJson(file(child.id),result);return result;}
 async function reconcile(state){
  validateNativeCascadeState(project,program,state);const next=structuredClone(state),jobs=await records(path.join(data,'jobs'));let adopted=0;
  for(const round of next.rounds)for(const receipt of round.receipts){
   if(receipt.kind!=='generate')continue;const operation=program.rounds[round.roundIndex].operations.find(op=>op.id===receipt.operationId);
   let child;
   if(receipt.childJobId)child=await readJson(file(receipt.childJobId));
   else if(receipt.status!=='completed'){
    const matches=jobs.filter(job=>job.requestId===cascadeChildRequestId(parentId,operation.id)&&job.projectId===project.id&&(job.parentId===parentId||job.parentJobId===parentId));
    if(matches.length>1)throw userError('智能串联同一请求存在多个原子任务，未自动选择');
    if(matches.length){child=matches[0];verify(child,operation);receipt.childJobId=child.id;adopted++;}
   }
   if(!child)continue;verify(child,operation);batchRecord(child,operation,{stored:receipt.status==='completed'&&!receipt.usedFallback});modelscopeRecord(child,operation,{stored:receipt.status==='completed'&&!receipt.usedFallback});
   if(receipt.status==='completed'&&!receipt.usedFallback&&(child.status!=='completed'||JSON.stringify(assetRefs(child))!==JSON.stringify(receipt.outputRefs)))throw userError('智能串联完成收据与原子任务实际结果不一致');
   if(receipt.status==='completed'&&!receipt.usedFallback)await validateEnhancementAssets(child,operation);
   if(child.status==='completed')remember(child);
  }
  validateNativeCascadeState(project,program,next);return{state:next,adopted};
 }
 const credentialPayload=value=>typeof value==='string'?{apiKey:value}:{...value};
 async function runGeneration(request){
  const {operation,signal,onAccepted}=request,kind=cascadeChildKind(byId.get(operation.requestNodeId));
  assertCanvasParent(activeJobs,parentId,project.id);signal.throwIfAborted();let child;
  if(request.resume){
   child=await readJson(file(request.childJobId));if(kind==='studio'&&creationStudio.refresh)child=await creationStudio.refresh(child);verify(child,operation);batchRecord(child,operation);enhancementRecord(child,operation);modelscopeRecord(child,operation);await onAccepted(child.id);
   if(child.status!=='completed'&&!activeJobs.has(child.id)){
    if(kind==='comfy')await generation.resume(child.id,{parentId});
    else if(kind==='runninghub'){
     if(!child.upstreamId)throw userError('云串联原任务没有可查询编号，不会重新提交');
     const credential=credentialPayload(await credentialsFor(request,structuredClone(child)));signal.throwIfAborted();await cloudWorkflows.resumeFromCanvas(child.recipeId,child.id,credential,parentId);
    }else if(kind==='studio'){
     if(!child.upstreamId&&!nativeModelscopeHasOriginalIds(child))throw userError('媒体串联原任务没有可查询编号，不会重新提交');
     const credential=credentialPayload(await credentialsFor(request,structuredClone(child)));signal.throwIfAborted();await creationStudio.resumeFromCanvas(child.id,credential,parentId);
    }else throw userError('同步图片原任务未完整完成，没有可查询编号，不会自动重发');
   }
  }else{
   const p=structuredClone(project);p.assets=[...knownAssets.values()].map(asset=>structuredClone(asset));
   if(request.referenceRefs.some(ref=>!knownAssets.has(ref.assetId)))throw userError('智能串联参考不属于原工程或已核实的原子任务结果');
   const prepared=await prepare({...request,project:p});signal.throwIfAborted();
   if(!prepared||prepared.kind!==kind||!prepared.project||prepared.project.id!==project.id)throw userError('智能串联准备结果与发送方绑定不一致');
   const requestId=cascadeChildRequestId(parentId,operation.id),credential=credentialPayload(await credentialsFor(request,null));signal.throwIfAborted();
   if(kind==='comfy')child=await generation.start(prepared.project,{...prepared.body,requestId},prepared.endpoint,{nativeFlow:true,nativeCascade:true,parentId,...(prepared.workflowRandom?{workflowRandom:prepared.workflowRandom}:{})});
   else if(kind==='runninghub')child=await cloudWorkflows.startFromCanvas(prepared.recipe,prepared.project,{...prepared.body,...credential,requestId},parentId);
   else if(kind==='image-api')child=await directImages.startFromCanvas(prepared.step,prepared.project,{...credential,requestId},parentId,{exactPrompt:true});
   else child=await creationStudio.startFromCanvas(prepared.studio,prepared.project,{...prepared.body,...credential,requestId},parentId,operation.requestNodeId);
   verify(child,operation);await onAccepted(child.id);
  }
  const stop=()=>activeJobs.get(child.id)?.controller.abort();signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
  try{
   for(;;){
    signal.throwIfAborted();child=await readJson(file(child.id));if(kind==='studio'&&creationStudio.refresh)child=await creationStudio.refresh(child);verify(child,operation);batchRecord(child,operation);modelscopeRecord(child,operation);await reportBatch(child,operation);
    if(child.status==='completed'){
     const binding=byId.get(operation.requestNodeId).params.workflowBinding;
     if((binding?.imageEnhance||binding?.promptBatch||byId.get(operation.requestNodeId).params.studioBinding?.config?.nativeModelscope)&&activeJobs.has(child.id)){await delay(pollInterval,undefined,{signal});continue;}
     child=await finishModelscope(await finishBatch(await finishEnhancement(child,operation),operation),operation);signal.throwIfAborted();remember(child);return assetRefs(child);
    }
    if(!['queued','running'].includes(child.status))throw userError('智能串联原子任务未完整完成，已停止下游；'+String(child.message||child.status).slice(0,200));
    await delay(pollInterval,undefined,{signal});
   }
  }finally{signal.removeEventListener('abort',stop);if(signal.aborted){stop();const latest=await readJson(file(child.id));verify(latest,operation);batchRecord(latest,operation);modelscopeRecord(latest,operation);await reportBatch(latest,operation);}}
 }
 async function generate(request){
  const stop=()=>{for(const child of activeJobs.values())if(child.parentId===parentId&&child.projectId===project.id)child.controller.abort();};
  request.signal.addEventListener('abort',stop,{once:true});
  try{return await runGeneration(request);}finally{request.signal.removeEventListener('abort',stop);if(request.signal.aborted)stop();}
 }
 return{generate,reconcile};
}
