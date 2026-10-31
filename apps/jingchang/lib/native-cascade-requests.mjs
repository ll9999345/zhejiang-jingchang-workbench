import {isJimengStudio} from '../public/jimeng-studio-core.js';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import {assertNoCredentials,loadAsset,userError} from './workspace.mjs';
import {cascadeChildKind} from './native-cascade-children.mjs';
import {buildNativeCascadePrompt} from './native-cascade-prompt.mjs';
import {configuredGraph,fieldKey} from './workflow-fields.mjs';
import {normalizePromptBatch,batchCount,batchGraph,validateBatchGraphs} from './prompt-batch.mjs';
import {comfyRandomFields,chooseWorkflowRandom} from './workflow-random.mjs';
import {comfyMediaField,supportsComfyAsset} from '../public/comfy-media.js';
import {validateComfyEndpoint,validateInputMedia} from './providers.mjs';
import {normalizeCloudOverrides} from './native-workflow-config.mjs';
import {normalizeCloudRecipe} from './cloud-recipes.mjs';
import {activeRhFields} from './runninghub-models.mjs';
import {cloudStep,cloudCredentials} from './canvas-cloud.mjs';
import {imageStep,imageCredentials} from './canvas-images.mjs';
import {studioStep,studioCredentials,resolveStudio} from './canvas-studio.mjs';
import {compileEnhancement} from './image-enhance.mjs';
import {prepareNativeEnhancement} from './native-director-inputs.mjs';
import {normalizeEnhancement} from '../public/image-enhance-core.js';
import {studioRequestCount,studioModelscopeReferenceLimit} from '../public/native-modelscope-core.js';
import {normalizeLoras} from './native-protocols.mjs';

const mediaKinds=new Set(['image','video','audio']);
const cloudKey=field=>field.nodeId+':'+field.fieldName;
const promptPattern=/prompt|positive|negative|text|caption|description|关键词|提示词|正向|负向/i;

// Single-image Comfy enhancement and SeedVR2 upscale share the original compiler.
// Planning validates a private seed
// placeholder; only execution may choose and record a random seed.
export function compileCascadeEnhancement(binding,template,{planning=false}={}){
 let policy;try{policy=normalizeEnhancement(binding.imageEnhance);}catch(error){throw userError('智能串联专用导演/增强参数无效：'+error.message);}
 if(policy.engine!=='comfy'||(binding.count??1)!==1||binding.minimaxH3||binding.ltxDirector||binding.promptBatch||binding.incrementSeeds===true)
  throw userError('智能串联仅支持单图 Comfy 细节增强或2K / 4K放大；导演、混合列表和递增种子尚不支持');
 if(comfyRandomFields(template,binding.randomFields).length)throw userError('串联增强请仅使用增强面板种子策略，不能混用普通随机字段');
 if(policy.seedMode==='random')for(const seedField of policy.seedFields){
  const field=template.fields.find(field=>fieldKey(field)===fieldKey(seedField));
  // compileEnhancement draws every UInt32 integer. A seed-zero placeholder
  // alone cannot prove that every later draw fits a bounded/stepped control.
  if(field&&(field.exposed===false||!['number','slider'].includes(field.control)||field.min!=null&&field.min>0||field.max!=null&&field.max<4294967295
   ||field.step!=null&&(field.step!==1||!Number.isInteger(field.min??0))))
   throw userError('串联增强随机种子字段须支持完整 0–4294967295 整数范围，步长须为1或未设；受限字段请改用固定种子或工作流种子');
 }
 const graph=configuredGraph(template,binding.overrides||[]);
 const checked=planning&&policy.seedMode==='random'?{...binding,imageEnhance:{...policy,seedMode:'fixed',seed:0}}:binding;
 const compiled=compileEnhancement(checked,graph,template.fields);
 if(template.fields.find(field=>fieldKey(field)===fieldKey(policy.imageField))?.exposed===false)throw userError('增强图片字段已隐藏，请重新映射');
 const overrides=[...(binding.overrides||[]),...compiled.overrides];configuredGraph(template,overrides);
 if(planning){compiled.recipe=policy;if(policy.seedMode==='random')delete compiled.recipe.seed;}
 return {...compiled,overrides};
}

// These classifications follow the pinned source's field-role rules. Only
// imported Comfy fields are inferred; unrelated string settings stay settings.
export function cascadeComfyFieldRole(field){
 if(mediaKinds.has(field.mediaKind))return field.mediaKind;
 if(field.nativeFieldId&&(field.control==='textarea'||/prompt|text|提示词|正向|负向/i.test(field.name+' '+field.label)))return 'prompt';
 return 'setting';
}
export function cascadeRhPromptField(field){
 return field.type==='text'&&field.source!=='lora'&&promptPattern.test(field.fieldName+' '+(field.label||''));
}

function executionProject(project,nodeId,prompt){
 const result=structuredClone(project),node=result.nodes.find(node=>node.id===nodeId);
 // This is a disposable request graph. The parent snapshot keeps all original
 // nodes, edges, groups and settings; fully composed input must not be expanded
 // a second time by the ordinary generation modules.
 result.edges=[];result.groups=[];
 for(const name of ['nativeCanvas','nativeLoop','nativePrompt','nativeBranch','promptAssetIds'])delete node.params[name];
 node.text=prompt;return {project:result,node};
}
const ledger=(composed,mappings,extra={})=>({version:1,prompt:composed.prompt,displayPrompt:composed.displayPrompt,
 roles:composed.roles,referenceRefs:composed.referenceRefs,mappings,
 unusedRefs:composed.referenceRefs.filter(ref=>!mappings.some(mapping=>mapping.identity===ref.identity)),...extra});

async function checkComfyMedia(data,project,template,bindings){
 let total=0;const seen=new Set();
 for(const binding of bindings){
  const config=template.fields.find(field=>fieldKey(field)===fieldKey(binding)),n=template.workflow[binding.nodeId];
  const descriptor=n&&comfyMediaField(n.class_type,binding.name,config),asset=project.assets.find(asset=>asset.id===binding.assetId);
  if(!descriptor||!asset||config?.exposed===false||!supportsComfyAsset(descriptor,asset))throw userError('智能串联工作流素材字段或格式不匹配');
  if(seen.has(asset.id))continue;seen.add(asset.id);
  const meta=await loadAsset(data,asset.id),file=path.join(data,'assets',asset.id),stat=await fs.lstat(file);
  if(!stat.isFile()||meta.id!==asset.id||meta.type!==asset.type||meta.size!==stat.size||!supportsComfyAsset(descriptor,meta))throw userError('智能串联工作流素材文件或记录已变化');
  total+=stat.size;if(total>300*1024*1024)throw userError('智能串联工作流素材合计超过300MB');
  try{validateInputMedia({bytes:await fs.readFile(file),mime:meta.type,name:meta.name});}catch(error){throw userError(error.message);}
 }
}

// Prepares real requests for the existing production generators. This function
// performs local reads/validation only. It neither submits nor invents consent,
// credentials, budgets or provider defaults. authorizationFor supplies already
// reviewed per-operation authorization; the ordinary service checks it again.
export function nativeCascadeRequestPreparer({data,generation,cloudWorkflows,endpoint,authorizationFor,prepareSpecialized}={}){
 if(typeof data!=='string'||!data)throw userError('智能串联请求准备缺少本机数据目录');
 async function authorize(request,step){
  if(typeof authorizationFor!=='function')throw userError('智能串联尚未确认本次服务、模型、素材范围和预算');
  const authorization=await authorizationFor(request,structuredClone(step));assertNoCredentials(authorization);
  const body={authorization:structuredClone(authorization)};
  // Validate authorization with the same contract as ordinary canvas runs.
  // The dummy credential is never returned, submitted, recorded or persisted.
  const item={nodeId:step.nodeId,...(isJimengStudio(step.studio)?{credentialSource:'jimeng-local',credentialConsent:true}:{apiKey:'local-validation-placeholder'}),authorization:body.authorization};
  if(step.kind==='image-api')imageCredentials([step],{imageCredentials:[item]});
  else if(step.kind==='studio')studioCredentials([step],{studioCredentials:[item]});
  else cloudCredentials([step],{cloudCredentials:[item]});
  return body;
 }
 async function prepare(request){
  const {project,requestNode,operation,context={}}=request;assertNoCredentials(project);
  const node=project?.nodes?.find(node=>node.id===operation?.requestNodeId);
  if(!node||node.id!==requestNode?.id||JSON.stringify(node)!==JSON.stringify(requestNode))throw userError('智能串联发送方与原参数快照不一致');
  const kind=cascadeChildKind(node),binding=node.params[kind==='comfy'?'workflowBinding':kind==='runninghub'?'cloudBinding':kind==='image-api'?'imageBinding':'studioBinding'];
  let recipe;
  if(kind==='runninghub'){
   if(!cloudWorkflows)throw userError('智能串联云工作流执行器未配置');
   recipe=structuredClone(await cloudWorkflows.get(binding.recipeId));
   if(recipe.projectId!==project.id||recipe.revision!==binding.recipeRevision)throw userError('智能串联云工作流归属或版本已变化');
   Object.assign(recipe,normalizeCloudRecipe(recipe));
  }
  const fallback=recipe?activeRhFields(recipe).filter(cascadeRhPromptField).map(field=>String(field.fieldValue||'').trim()).find(Boolean)||'':'';
  const composed=buildNativeCascadePrompt(project,node.id,{referenceRefs:request.referenceRefs,context,rhFallbackPrompt:fallback});
  const enhancement=kind==='comfy'&&binding.imageEnhance;
  if(!enhancement&&!(kind==='comfy'&&binding.promptBatch)&&!composed.prompt.trim())throw userError('缺少提示词');
  const execution=executionProject(project,node.id,enhancement?'':composed.prompt),refs=composed.referenceRefs;
  if(enhancement){
   if(!generation)throw userError('智能串联本机工作流执行器未配置');
   const template=await generation.template(binding.workflowId);
   // Validate all settings before choosing a random seed or opening a socket.
   compileCascadeEnhancement(binding,template,{planning:true});
   const ref=refs.find(ref=>ref.kind==='image');if(!ref)throw userError('智能串联增强需要至少一张图片');
   const selected=prepareNativeEnhancement(execution.project,execution.node,{assetId:ref.assetId});
   const imageBindings=[{...binding.imageEnhance.imageField,assetId:selected.source.assetId}];
   await checkComfyMedia(data,execution.project,template,imageBindings);
   const actualEndpoint=typeof endpoint==='function'?await endpoint(request):endpoint;validateComfyEndpoint(actualEndpoint);
   const compiled=compileCascadeEnhancement(binding,template),r=compiled.recipe;
   const actual={kind:r.kind,engine:r.engine,...(r.kind==='upscale'?{resolution:r.resolution,maxResolution:r.maxResolution}:{strength:r.strength}),seedMode:r.seedMode,sourceAssetId:ref.assetId,
    sourceIdentity:ref.identity,workflowId:template.id,workflowRevision:template.revision,...(r.seed!==undefined?{seed:r.seed}:{})};
   return {kind,project:execution.project,endpoint:actualEndpoint,body:{nodeId:node.id,revision:project.revision,workflowId:template.id,workflowRevision:template.revision,
    overrides:compiled.overrides,imageBindings,count:1,seedOffset:0,incrementSeeds:false,randomFields:[]},
    ledger:ledger({...composed,prompt:'',displayPrompt:''},[{...r.imageField,kind:'image',assetId:ref.assetId,identity:ref.identity}],
     {promptFields:[],providerRequestCount:1,enhancement:actual})};
  }
  if(binding.minimaxH3||binding.ltxDirector||binding.imageEnhance||binding.promptBatch&&kind!=='comfy'){
   if(typeof prepareSpecialized!=='function')throw userError('智能串联专用导演、增强或列表参数尚待接线；原配置保留，未改用普通请求');
   return prepareSpecialized({...request,...execution,composed,kind});
  }
  if(kind==='comfy'){
   if(!generation)throw userError('智能串联本机工作流执行器未配置');
   const template=await generation.template(binding.workflowId),random=comfyRandomFields(template,binding.randomFields),randomKeys=new Set(random.map(fieldKey)),graph=configuredGraph(template,(binding.overrides||[]).filter(field=>!randomKeys.has(fieldKey(field)))),promptBatch=normalizePromptBatch(template,binding.promptBatch);
   if(promptBatch&&binding.promptField&&fieldKey(promptBatch)===fieldKey(binding.promptField))throw userError('同一文字字段不能同时使用上游文字和提示词列表');
   // Literal batches preserve other saved text settings. An explicitly bound,
   // separate promptField can still receive the composed upstream draft.
   const promptFields=promptBatch?(binding.promptField?[binding.promptField]:[]):template.fields.filter(field=>field.exposed!==false&&cascadeComfyFieldRole(field)==='prompt');
   if(binding.promptField&&!promptFields.some(field=>fieldKey(field)===fieldKey(binding.promptField)))promptFields.unshift(binding.promptField);
   const overrides=new Map((binding.overrides||[]).map(field=>[fieldKey(field),structuredClone(field)]));
   for(const [index,field]of promptFields.entries()){
    // A saved list is literal, including mentions and loop tokens. The ordinary
    // generator alone replaces this field for each item; never compose it here.
    if(promptBatch&&fieldKey(field)===fieldKey(promptBatch))continue;
    const target=graph[field.nodeId],config=template.fields.find(item=>fieldKey(item)===fieldKey(field));
    if(!target||typeof target.inputs?.[field.name]!=='string'||config?.exposed===false||comfyMediaField(target.class_type,field.name,config))throw userError('智能串联提示词字段无效或已隐藏');
    overrides.set(fieldKey(field),{nodeId:field.nodeId,name:field.name,value:index===0?composed.prompt:config.defaultValue});
   }
   const fields=template.fields.filter(field=>field.exposed!==false&&mediaKinds.has(cascadeComfyFieldRole(field))).map(field=>({nodeId:field.nodeId,name:field.name,kind:cascadeComfyFieldRole(field)}));
   for(const field of binding.imageSources||[]){
    if(fields.some(item=>fieldKey(item)===fieldKey(field)))continue;
    const config=template.fields.find(item=>fieldKey(item)===fieldKey(field)),n=graph[field.nodeId],descriptor=n&&comfyMediaField(n.class_type,field.name,config);
    if(!descriptor)throw userError('智能串联原媒体映射字段已变化');fields.push({nodeId:field.nodeId,name:field.name,kind:descriptor.kind});
   }
   const positions={image:0,video:0,audio:0},mappings=[],imageBindings=[];
   for(const field of fields){
    const ref=refs.filter(ref=>ref.kind===field.kind)[positions[field.kind]++];if(!ref)continue;
    const {nodeId,name}=field;overrides.delete(fieldKey(field));imageBindings.push({nodeId,name,assetId:ref.assetId});mappings.push({...field,assetId:ref.assetId,identity:ref.identity});
   }
   if(imageBindings.length>20)throw userError('智能串联实际工作流媒体映射超过20项');
   await checkComfyMedia(data,execution.project,template,imageBindings);
   const values=[...overrides.values()],count=batchCount(binding.count,promptBatch),seedOffset=(context.roundIndex||0)*count;
   const configured=configuredGraph(template,values.filter(field=>!randomKeys.has(fieldKey(field)))),baseline=batchGraph(configured,seedOffset,null,binding.incrementSeeds===true,random);
   validateBatchGraphs(template,baseline,count,promptBatch,binding.incrementSeeds===true,random);
   const actualEndpoint=typeof endpoint==='function'?await endpoint(request):endpoint;validateComfyEndpoint(actualEndpoint);
   const workflowRandom=promptBatch?chooseWorkflowRandom(random,count):null;
   const batchExecution=promptBatch?{workflowId:template.id,workflowRevision:template.revision,count,seedOffset,incrementSeeds:binding.incrementSeeds===true,
    randomFields:random.map(({nodeId,name})=>({nodeId,name})),imageBindings:structuredClone(imageBindings),
    mediaDefaults:imageBindings.map(({nodeId,name})=>({nodeId,name,value:baseline[nodeId].inputs[name]})),
    workflowHash:createHash('sha256').update(JSON.stringify(baseline)).digest('hex')}:null;
   return{kind,project:execution.project,endpoint:actualEndpoint,body:{nodeId:node.id,revision:project.revision,workflowId:template.id,workflowRevision:template.revision,
    overrides:values,imageBindings,count,seedOffset,incrementSeeds:binding.incrementSeeds===true,
    ...(promptBatch?{promptBatch,randomFields:batchExecution.randomFields}:binding.randomFields!==undefined?{randomFields:structuredClone(binding.randomFields)}:{})},
    ...(promptBatch?{workflowRandom}:{}),
    ledger:ledger(composed,mappings,{promptFields:promptFields.filter(field=>!promptBatch||fieldKey(field)!==fieldKey(promptBatch)).map(field=>({nodeId:field.nodeId,name:field.name})),providerRequestCount:count,
     ...(promptBatch?{promptBatch:structuredClone(promptBatch),batchExecution,...(workflowRandom?{workflowRandom}:{})}:{})})};
  }
  if(kind==='runninghub'){
   const overrides=normalizeCloudOverrides(binding.overrides,recipe),fixed=new Set(overrides.map(cloudKey));
   for(const item of overrides)recipe.fields.find(field=>cloudKey(field)===cloudKey(item)).fieldValue=item.fieldValue;
   const explicit=new Set();
   if(!Array.isArray(binding.inputs))throw userError('智能串联原云字段映射无效');
   for(const input of binding.inputs){
    const key=cloudKey(input),field=recipe.fields.find(field=>cloudKey(field)===key);
    if(!field||explicit.has(key)||field.source==='lora'||fixed.has(key))throw userError('智能串联云映射字段重复、冲突或不存在');explicit.add(key);field.enabled=true;
    if(input.useText&&field.type!=='text'||!input.useText&&!mediaKinds.has(field.type))throw userError('智能串联云映射字段类型不匹配');
   }
   const positions={image:0,video:0,audio:0},mappings=[];
   for(const field of activeRhFields(recipe)){
    const key=cloudKey(field),isPrompt=cascadeRhPromptField(field)||binding.inputs.some(input=>cloudKey(input)===key&&input.useText===true);
    if(isPrompt&&!fixed.has(key)){field.source='value';field.fieldValue=composed.prompt;delete field.assetId;}
    if(!mediaKinds.has(field.type)||field.source==='lora')continue;
    const ref=refs.filter(ref=>ref.kind===field.type)[positions[field.type]++];if(!ref)continue;
    field.source='asset';field.assetId=ref.assetId;field.fieldValue='';mappings.push({nodeId:field.nodeId,fieldName:field.fieldName,kind:field.type,assetId:ref.assetId,identity:ref.identity});
   }
   const step=await cloudStep({data,project:execution.project,node:execution.node,binding:{...binding,inputs:[],overrides:[]},parents:new Set(),text:composed.prompt,
    cloudWorkflows:{get:async id=>{if(id!==recipe.id)throw userError('智能串联云配置编号不一致');return structuredClone(recipe);}}});
   const body=await authorize(request,step);
   return{kind,project:execution.project,recipe:step.recipe,body:{...body,revision:recipe.revision,...(step.randomFields?{randomFields:step.randomFields}:{})},ledger:ledger(composed,mappings,{providerRequestCount:1})};
  }
  if(kind==='image-api'){
   const selected=refs.filter(ref=>ref.kind==='image'),sources=selected.map(ref=>({assetId:ref.assetId}));
   // The normal saved binding rejects duplicate asset IDs. Validate the ordered
   // expansion separately, then keep aliases for the private cascade call.
   const step=await imageStep({data,project:execution.project,node:execution.node,binding:{...binding,includeUpstream:true,referenceSources:[]},parents:new Set(),text:composed.prompt,nativeReferences:sources});
   if(sources.length&&step.image.platform.models[0].referenceSupport!==true)throw userError('智能串联图片模型未开启参考图支持');
   step.image.referenceSources=sources;step.sendAssets=sources.length>0;
   await authorize(request,step);
   return{kind,project:execution.project,step,ledger:ledger(composed,selected.map(ref=>({assetId:ref.assetId,kind:ref.kind,identity:ref.identity})),{providerRequestCount:1})};
  }
  const nativeModelscope=binding.config?.protocol==='modelscope'&&binding.config.nativeModelscope!==undefined;
  const scoped=structuredClone(binding);if(nativeModelscope&&Object.keys(context.loopContexts||{}).length)scoped.config.count=1;
  const limit=nativeModelscope?studioModelscopeReferenceLimit(scoped):null;
  const selected=refs.filter(ref=>binding.mode==='video'?mediaKinds.has(ref.kind):ref.kind==='image').slice(0,limit??undefined),sources=selected.map(ref=>({assetId:ref.assetId}));
  const step=await studioStep({data,project:execution.project,node:execution.node,binding:{...scoped,includeUpstream:true,referenceSources:[]},parents:new Set(),text:composed.prompt,nativeReferences:sources});
  step.studio.referenceSources=sources;step.sendAssets=sources.length>0;
  const body=await authorize(request,step),studio=resolveStudio(step,execution.project);
  const requestCount=studioRequestCount(studio),modelscope=nativeModelscope?{version:1,nativeModelscope:structuredClone(studio.config.nativeModelscope),model:studio.config.model,size:studio.config.size,count:requestCount,loras:normalizeLoras(studio.config.loras),referenceAssetIds:sources.map(ref=>ref.assetId),referenceIdentities:selected.map(ref=>ref.identity)}:null;
  return{kind,project:execution.project,studio,body:{...body,...(step.referenceInputs?{referenceInputs:step.referenceInputs}:{})},
   ledger:ledger(composed,selected.map(ref=>({assetId:ref.assetId,kind:ref.kind,identity:ref.identity})),{providerRequestCount:requestCount,outputCount:binding.mode==='image'?studio.config.count:1,...(modelscope?{modelscope}:{})})};
 }
 return{prepare};
}
