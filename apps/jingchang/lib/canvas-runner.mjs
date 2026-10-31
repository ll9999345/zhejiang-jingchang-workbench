import {applyNativeMediaMaps,assertNativeMediaMapScopes,nativeMediaMappedStep} from './native-media-maps.mjs';
import {nativeMediaVersion} from '../public/native-media-version.js';
import {prepareNativeH3,prepareNativeLtx,prepareNativeEnhancement,resolveNativeDirectorStep} from './native-director-inputs.mjs';
import {materializeMinimaxSeed,minimaxRandomMode,minimaxSubmittedParameters,MINIMAX_RANDOM_SEED_MAX} from './minimax-seed.mjs';
import {comfyRandomFields,chooseWorkflowRandom} from './workflow-random.mjs';
import {randomFieldKey} from '../public/workflow-random-core.js';
import {hasEnabledNativeLoops,planNativeLoops,nativeExecutionUnits} from './native-loop-plan.mjs';
import {sortNativeLoopResults} from './native-loop-results.mjs';
import {captureNativeResultTargets,captureNativeOutputTargets} from './generation-results.mjs';
import {compileMinimaxH3,rejectMinimaxConflicts,minimaxUpstreamRefs,captureMinimaxResultTarget} from './minimax-h3.mjs';
import {compileEnhancement,annotateEnhancement} from './image-enhance.mjs';
import {compileLtxTimeline,rejectLtxConflicts} from './ltx-director.mjs';
import {ltxReferences} from '../public/ltx-director-core.js';
import {cameraNodeText} from '../public/camera-angle-core.js';
import {studioStep,resolveStudio,studioCredentials,clearStudioCredentials,studioCredentialPayload} from './canvas-studio.mjs';
import {llmStep,llmCredentials,clearLlmCredentials,llmCredentialPayload} from './canvas-llm.mjs';
import {imageStep,imageCredentials,clearImageCredentials,imageCredentialPayload,clearCanvasApiCredentialMap,clearCanvasMiaoChoices} from './canvas-images.mjs';
import {planCanvasLoops} from './canvas-loops.mjs';
import {normalizePromptBatch,batchCount,batchGraph,validateBatchGraphs} from './prompt-batch.mjs';
import {cloudStep,resolveCloudRecipe,cloudCredentials,clearCloudCredentials} from './canvas-cloud.mjs';
import {jobReferenceAssetIds} from './media-lineage.mjs';
import {comfyMediaField,supportsComfyAsset} from '../public/comfy-media.js';
import {configuredGraph,verifyConfiguredGraph} from './workflow-fields.mjs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {executionOrder,validateProject} from './model.mjs';
import {atomicJson,readJson,records,safeId,userError,assertNoCredentials} from './workspace.mjs';
import {validateComfyEndpoint} from './providers.mjs';
import {promptAssetIds} from './prompt-assets.mjs';
import {nativeFlowDependencyOrder} from './native-flow.mjs';
import {nativeExecutionNodeIssues,nativeExecutionDependencies,nativeExecutionAncestors,needsNativeFlow,nativeExecutionText,nativeExecutionMedia,selectNativeExecutionMedia,nativeStepOutputs} from './native-flow-execution.mjs';
import {planNativeApiStep,resolveNativeApiStep} from './native-api-inputs.mjs';
import {selectedMinimaxSegment,minimaxParameters} from '../public/minimax-h3-core.js';
import {isNativePrompt,nativePromptLlmEnabled} from '../public/native-prompt-core.js';
import {nativeBranchEnabled} from '../public/native-branch-core.js';
import {restoreNativeBranchProject,validateNativeBranchJob} from './native-branch.mjs';
import {assertLegacyNativeInputResume,withLegacyNativeInputAudit,reviewedNativeInputStep} from './legacy-native-input-audit.mjs';

export function canvasRunner({data,activeJobs,generation,cloudWorkflows,directImages,canvasLlm,creationStudio,pollInterval=300,minimaxSeedDraw,workflowRandomDraw}){
 const file=id=>{if(!safeId(id))throw userError('任务编号无效');return path.join(data,'jobs',id+'.json');};
 async function plan(project,{nodeId}={}){
  validateProject(project);assertNativeMediaMapScopes(project);
  if(nodeId!==undefined){
   if(!safeId(nodeId)||!project.nodes.some(n=>n.id===nodeId))throw userError('执行目标节点不存在');
   const included=new Set([nodeId]);function walk(id){for(const source of nativeExecutionDependencies(project,id))if(!included.has(source)){included.add(source);walk(source);}}walk(nodeId);
   const branchLoops=project.nodes.filter(node=>included.has(node.id)&&nativeBranchEnabled(node));
   for(const node of project.nodes)if(branchLoops.some(loop=>nativeExecutionAncestors(project,node.id).has(loop.id))){included.add(node.id);walk(node.id);}
   if(project.nodes.some(n=>n.type==='loop'&&included.has(n.id)))throw userError('此执行范围包含循环，请使用完整画布运行检查');
   project=structuredClone(project);project.nodes=project.nodes.filter(n=>included.has(n.id));project.edges=project.edges.filter(e=>included.has(e.source)&&included.has(e.target));project.groups=(project.groups||[]).map(g=>({...g,nodeIds:g.nodeIds.filter(id=>included.has(id))})).filter(g=>g.nodeIds.length);
  }
  const pending=project.nodes.flatMap(n=>nativeExecutionNodeIssues(n,project).map(issue=>'“'+n.title+'”：'+issue));if(pending.length)throw userError('原生工作流尚不能完整执行；'+pending.slice(0,8).join('；'));
  const steps=hasEnabledNativeLoops(project)?await planNativeLoops(project,singlePlan):await planCanvasLoops(project,singlePlan,generation.template),looped=new Set(steps.filter(step=>step.loopId).map(step=>step.nodeId));
  if(project.nodes.some(node=>node.params?.nativeCanvas?.node.type==='output'&&project.edges.some(edge=>edge.target===node.id&&looped.has(edge.source)&&!steps.some(step=>step.nodeId===edge.source&&step.nativeLoop))))throw userError('原生输出节点收集循环回合结果尚待接入');
  return steps;
 }
 async function singlePlan(project,rounds=new Map(),loopContexts={},onlyNodeIds){
  const order=project.nodes.some(n=>n.params?.nativeCanvas)?nativeFlowDependencyOrder(project):executionOrder(project),steps=[];
  const ancestors=id=>nativeExecutionAncestors(project,id);
  for(const id of order){
   if(onlyNodeIds&&!onlyNodeIds.has(id))continue;
   const node=project.nodes.find(n=>n.id===id),binding=node.params?.workflowBinding,cloud=node.params?.cloudBinding,image=node.params?.imageBinding,llm=node.params?.llmBinding,studio=node.params?.studioBinding;if([binding,cloud,image,llm,studio].filter(Boolean).length>1)throw userError('一个节点只能绑定一种执行方式');if(!binding&&!cloud&&!image&&!llm&&!studio)continue;if(isNativePrompt(node)&&!nativePromptLlmEnabled(node))continue;if(isNativePrompt(node)&&llm?.includeUpstream===false)throw userError('智能提示词语言模型须保留上游文字范围，请重新绑定');const parents=ancestors(id),flow=needsNativeFlow(project,node,parents);
   if(flow&&project.nodes.some(n=>n.type==='loop'))throw userError('原生分组数据流与镜场循环的组合执行尚待接入');
   const text=flow?nativeExecutionText(project,node,{execution:true,planning:true,loopContexts}):order.filter(n=>parents.has(n)||n===id).map(id=>cameraNodeText(project.nodes.find(n=>n.id===id))).filter(Boolean).join('\n\n'),promptReferences=promptAssetIds(project,node);if(studio){if(!creationStudio)throw userError('创作接口执行器未配置');steps.push(await (flow?planNativeApiStep('studio',{data,project,node,binding:studio,parents,text,promptReferences,loopContexts}):studioStep({data,project,node,binding:studio,parents,text,promptReferences})));continue;}if(llm){if(!canvasLlm)throw userError('语言模型执行器未配置');steps.push(await (flow?planNativeApiStep('canvas-llm',{data,project,node,binding:llm,parents,text,promptReferences,loopContexts}):llmStep({data,project,node,binding:llm,parents,text,promptReferences})));continue;}if(image){if(!directImages)throw userError('图片接口执行器未配置');steps.push(await (flow?planNativeApiStep('image-api',{data,project,node,binding:image,parents,text,promptReferences,loopContexts}):imageStep({data,project,node,binding:image,parents,text,promptReferences})));continue;}if(cloud){steps.push(await cloudStep({data,project,node,binding:cloud,parents,text,promptReferences,cloudWorkflows,loopContexts}));continue;}
   if(!['image','video','audio'].includes(node.type))throw userError('仅图片、视频、音频节点可绑定生成工作流');
   const template=await generation.template(binding.workflowId),graph=configuredGraph(template),seen=new Set();
   if(binding.minimaxH3){
    if(minimaxRandomMode(binding.minimaxH3)&&binding.incrementSeeds===true)throw userError('H3 每次随机与递增种子不能同时启用');
    if(node.type!=='video'||binding.ltxDirector||binding.promptBatch||binding.imageEnhance||binding.imageSources?.length||binding.promptField)throw userError('H3 视频时间轴不能混用其它导演、提示词或媒体输入配置');
    if(!Array.isArray(binding.overrides))throw userError('H3 工作流参数无效');if(binding.randomFields?.length)throw userError('H3 随机由片段管理，请关闭通用字段随机');
    const nativeH3=flow?prepareNativeH3(project,node,binding.minimaxH3,{planning:true,loopContexts,text}):null,h3=compileMinimaxH3(nativeH3?.timeline||binding.minimaxH3,graph,{project,parents,text,upstreamRefs:nativeH3?[]:minimaxUpstreamRefs(project,parents)});rejectMinimaxConflicts(h3.contract,binding.overrides);
    const configured=configuredGraph(template,[...binding.overrides,...h3.overrides]);for(const f of [...binding.overrides,...h3.overrides])h3.graph[f.nodeId].inputs[f.name]=configured[f.nodeId].inputs[f.name];
    const count=batchCount(binding.count,null);if(count!==1)throw userError('H3 每次只生成当前片段一次');const seedOffset=(rounds.get(id)||0)*count;validateBatchGraphs(template,batchGraph(h3.graph,seedOffset,null,binding.incrementSeeds===true),count,null,binding.incrementSeeds===true);
    const step={kind:'comfy',nodeId:id,title:node.title,workflowId:template.id,workflowRevision:template.revision,minimaxH3:nativeH3?.original||h3.timeline,...(nativeH3?{nativeDirectorInputs:nativeH3.ledger}:{}),minimaxResultTarget:captureMinimaxResultTarget(node,nativeH3?.original||h3.timeline,{project,parents}),overrides:binding.overrides,imageSources:[],promptField:null,text,count,seedOffset,incrementSeeds:binding.incrementSeeds===true,status:'pending'};assertNoCredentials(step);steps.push(step);continue;
   }
   if(binding.ltxDirector&&node.type!=='video')throw userError('LTX 导演绑定只用于视频节点');
   const nativeLtx=flow&&binding.ltxDirector?prepareNativeLtx(project,node,binding.ltxDirector,{planning:true,loopContexts}):null,ltx=binding.ltxDirector?compileLtxTimeline(nativeLtx?.timeline||binding.ltxDirector,graph,{project,parents,text}):null;
   const check=(field,type)=>{const key=JSON.stringify([field.nodeId,field.name]),n=graph[field.nodeId];if(seen.has(key)||!n||!Object.hasOwn(n.inputs||{},field.name)||typeof n.inputs[field.name]!==type||Array.isArray(n.inputs[field.name]))throw userError('工作流字段重复、不存在或类型不匹配');seen.add(key);return n;};
   if(!Array.isArray(binding.overrides)||!Array.isArray(binding.imageSources)||binding.imageSources.length>16)throw userError('节点工作流参数无效');
   const enhancement=binding.imageEnhance?compileEnhancement(binding,graph,template.fields):null,nativeEnhance=flow&&enhancement?prepareNativeEnhancement(project,node,enhancement.source,{planning:true,loopContexts}):null;
   const random=comfyRandomFields(template,binding.randomFields??(ltx||enhancement?[]:undefined)),randomKeys=new Set(random.map(randomFieldKey));if((ltx||enhancement)&&random.length)throw userError('导演或增强参数由专用配置管理，请关闭通用字段随机');
   const overrides=binding.overrides.map(f=>{if(!['string','number','boolean'].includes(typeof f.value)||typeof f.value==='number'&&!Number.isFinite(f.value))throw userError('工作流参数类型无效');check(f,typeof f.value);return {nodeId:f.nodeId,name:f.name,value:f.value};});
   const promptField=binding.promptField?{nodeId:binding.promptField.nodeId,name:binding.promptField.name}:null;
   if(promptField)check(promptField,'string');
   const imageSources=binding.imageSources.map(f=>{const n=check(f,'string');const mediaField=comfyMediaField(n.class_type,f.name,template.fields?.find(x=>x.nodeId===f.nodeId&&x.name===f.name));if(!mediaField)throw userError('不支持该媒体输入节点或字段');
    if(f.sourceIndex!==undefined&&!f.sourceNodeId)throw userError('素材序号只可用于上游节点映射');
    if(f.sourceNodeId){const source=project.nodes.find(n=>n.id===f.sourceNodeId);if(!parents.has(f.sourceNodeId)||!source)throw userError('动态素材必须来自相连的上游节点');
     if(source.params?.nativeCanvas||f.sourceIndex!==undefined){
      const value=nativeExecutionMedia(project,source.id,{execution:true,loopContexts,mediaVersion:nativeMediaVersion(project,node)}),selected=selectNativeExecutionMedia(value,f.sourceIndex,{planning:true});
      // Pending members may change positions and counts. Keep both verified
      // static files and declared pending types in the planning candidates;
      // execution still resolves the exact index and checks its actual file.
      const compatible=selected?project.assets.some(a=>a.id===selected.assetId&&supportsComfyAsset(mediaField,a)):value.media.some(item=>project.assets.some(a=>a.id===item.assetId&&supportsComfyAsset(mediaField,a)))||value.pendingNodeIds.some(id=>mediaField.kinds.includes(project.nodes.find(n=>n.id===id)?.type));
      if(!compatible)throw userError('原生素材条目与工作流字段类型不匹配');
      return{nodeId:f.nodeId,name:f.name,sourceNodeId:source.id,...(f.sourceIndex!==undefined?{sourceIndex:f.sourceIndex}:{})};
     }
     if(!mediaField.kinds.includes(source.type))throw userError('动态素材必须来自类型匹配的上游节点');if(!source.assetId&&!source.params?.workflowBinding&&!source.params?.cloudBinding&&!source.params?.imageBinding&&!source.params?.studioBinding)throw userError('上游节点没有素材或生成配置');return {nodeId:f.nodeId,name:f.name,sourceNodeId:source.id};}
    if(!project.assets.some(a=>a.id===f.assetId&&supportsComfyAsset(mediaField,a)))throw userError('固定素材不属于当前项目或格式不匹配');return {nodeId:f.nodeId,name:f.name,assetId:f.assetId};
   });
   for(const assetId of promptReferences){if(imageSources.some(source=>source.assetId===assetId))continue;const candidate=(template.fields||[]).find(field=>{const key=JSON.stringify([field.nodeId,field.name]),input=graph[field.nodeId],mediaField=input&&comfyMediaField(input.class_type,field.name,field);return field.exposed!==false&&!seen.has(key)&&mediaField?.kinds.includes('image')&&project.assets.some(asset=>asset.id===assetId&&supportsComfyAsset(mediaField,asset));});if(!candidate)throw userError('提示词中的 @ 图片需要工作流有尚未映射且已显示的图片输入字段');const key=JSON.stringify([candidate.nodeId,candidate.name]);check(candidate,'string');seen.add(key);imageSources.push({nodeId:candidate.nodeId,name:candidate.name,assetId});}
   if(imageSources.length>16)throw userError('工作流最多映射16个图片或媒体输入字段');
   if(enhancement)for(const f of enhancement.overrides){check(f,'number');overrides.push(f);}
   const promptBatch=normalizePromptBatch(template,binding.promptBatch),count=batchCount(binding.count,promptBatch);if(promptBatch&&promptField?.nodeId===promptBatch.nodeId&&promptField?.name===promptBatch.name)throw userError('同一文字字段不能同时使用上游文字和提示词列表');
   if(promptField&&(!text||text.length>32000))throw userError('传递的上游文字须为1–32000字');
   rejectLtxConflicts(ltx?.timeline,[...overrides,...imageSources,promptField,promptBatch]);
   const configured=configuredGraph(template,[...overrides.filter(f=>!randomKeys.has(randomFieldKey(f))),...(promptField?[{...promptField,value:text}]:[]),...(ltx?.overrides||[])]);for(const f of imageSources)if(template.fields?.some(x=>x.nodeId===f.nodeId&&x.name===f.name&&!x.exposed))throw userError('图片字段已隐藏，请重新配置节点');const seedOffset=(rounds.get(id)||0)*count;validateBatchGraphs(template,batchGraph(configured,seedOffset,null,binding.incrementSeeds===true,random),count,promptBatch,binding.incrementSeeds===true,random);
   const step={...(enhancement?{imageEnhance:enhancement.recipe,enhanceSource:enhancement.source}:{}),kind:'comfy',nodeId:id,title:node.title,workflowId:template.id,workflowRevision:template.revision,...(ltx?{ltxDirector:nativeLtx?.original||ltx.timeline}:{}),...(nativeLtx||nativeEnhance?{nativeDirectorInputs:(nativeLtx||nativeEnhance).ledger}:{}),...(promptBatch?{promptBatch}:{}),overrides,imageSources,promptField,text,count,seedOffset,incrementSeeds:binding.incrementSeeds===true,status:'pending',...(random.length||binding.randomFields!==undefined||template.fields?.some(f=>f.randomEnabled)?{randomFields:random.map(({nodeId,name})=>({nodeId,name})),randomDescriptors:random}:{})};assertNoCredentials(step);steps.push(step);
  }
  if(!steps.length)throw userError('先为节点绑定生成工作流或语言模型，再运行画布');
  if(steps.length>32||steps.reduce((n,s)=>n+s.count,0)>64)throw userError('最多32个生成节点、合计64次生成');
  const textOutputNodes=new Set(steps.filter(step=>step.kind==='canvas-llm'||step.kind==='runninghub'&&step.outputType==='string').map(step=>step.nodeId));
  return steps.map(step=>{const parents=ancestors(step.nodeId),node=project.nodes.find(n=>n.id===step.nodeId),flow=needsNativeFlow(project,node,parents),mediaFlow=step.imageSources?.some(ref=>ref.sourceNodeId&&(ref.sourceIndex!==undefined||project.nodes.find(n=>n.id===ref.sourceNodeId)?.params?.nativeCanvas))||!!step.nativeInputs?.fields.length,only=step.image?.includeUpstream===false||step.llm?.includeUpstream===false||step.studio?.includeUpstream===false;return{...step,...(flow||mediaFlow?{nativeFlow:{version:1,text:flow&&!only,ownText:cameraNodeText(node)}}:{}),textInputs:order.filter(id=>id===step.nodeId||!only&&parents.has(id)).map(id=>{const n=project.nodes.find(n=>n.id===id);return{nodeId:id,text:cameraNodeText(n),generated:textOutputNodes.has(id)&&id!==step.nodeId};})};});
 }
 function keysFor(steps,body,resume=false){
  const keys=new Map();
  try{
   for(const collect of [cloudCredentials,imageCredentials,llmCredentials,studioCredentials]){
    const partial=collect(steps,body,{resume});for(const [id,value]of partial)keys.set(id,value);partial.clear();
   }
   return keys;
  }catch(error){clearCanvasApiCredentialMap(keys);throw error;}
 }
 async function start(project,body,endpoint){
  try{return await startPrepared(project,body,endpoint);}
  finally{clearCanvasMiaoChoices(body);}
 }
 async function startPrepared(project,body,endpoint){
  if(!safeId(body.requestId))throw userError('请求编号无效');const previous=(await records(path.join(data,'jobs'))).find(j=>j.kind==='canvas-run'&&j.projectId===project.id&&j.requestId===body.requestId);if(previous)return publicRun(previous);
  if(body.revision!==project.revision||body.consent!==true)throw userError('请确认当前版本及工作流执行范围',409);
  if([...activeJobs.values()].some(j=>j.projectId===project.id))throw userError('项目已有运行任务，请先完成或停止',409);
  validateComfyEndpoint(endpoint);const steps=await plan(project,{nodeId:body.nodeId});const loopBackends=endpoint?.parallelBackends;if(loopBackends!==undefined){if(!steps.some(step=>step.nativeLoop?.mode==='parallel'&&step.kind==='comfy')||!Array.isArray(loopBackends)||loopBackends.length<1||loopBackends.length>6)throw userError('多后端仅用于原生并行循环');for(const backend of loopBackends)validateComfyEndpoint(backend);if(new Set(loopBackends.map(backend=>validateComfyEndpoint(backend).href)).size!==loopBackends.length)throw userError('并行循环后端地址不能重复');}const keys=keysFor(steps,body);for(const key of keys.values())if(typeof key==='string'&&key&&JSON.stringify({steps,project}).includes(key)){clearCanvasApiCredentialMap(keys);throw userError('项目内容含本次密钥，请移除后执行');}clearCloudCredentials(body);clearImageCredentials(body);clearLlmCredentials(body);clearStudioCredentials(body);const job={id:randomUUID(),kind:'canvas-run',projectId:project.id,requestId:body.requestId,...(body.nodeId?{nodeId:body.nodeId}:{}),name:project.name+' · 画布执行',createdAt:new Date().toISOString(),status:'queued',progress:0,message:steps.some(step=>step.nativeLoop?.mode==='parallel')?'等待按循环模式执行':'等待按连线顺序执行',assets:[],textResults:[],originalTexts:Object.fromEntries(project.nodes.map(n=>[n.id,n.text])),steps,nativeResultTargets:captureNativeResultTargets(project),nativeOutputTargets:captureNativeOutputTargets(project),snapshot:structuredClone(project),...(loopBackends?{loopBackends:structuredClone(loopBackends)}:{}),backend:typeof endpoint==='object'?{id:endpoint.id,name:endpoint.name,url:endpoint.url}:null,endpoint};
  try{await atomicJson(file(job.id),job);launch(job,keys);return publicRun(job);}catch(error){clearCanvasApiCredentialMap(keys);throw error;}
 }
 function publicRun(job){const {snapshot,endpoint,nativeResultTargets,...rest}=job;return withLegacyNativeInputAudit(job,rest);}
 function launch(job,keys=new Map()){const controller=new AbortController();activeJobs.set(job.id,{controller,projectId:job.projectId,kind:'canvas-run'});void run(job,controller,keys);}
 async function executeStep(job,signal,keys,step,i,p,outputs,save,executionEndpoint=job.endpoint){let childId;
  try{
   signal.throwIfAborted();

    if(step.nativeFlow?.text)step.text=nativeExecutionText(p,p.nodes.find(n=>n.id===step.nodeId),{outputs,execution:true,ownText:step.nativeFlow.ownText,loopContexts:step.nativeLoop?.contexts});
    else if(step.textInputs)step.text=step.textInputs.map(f=>(f.generated?p.nodes.find(n=>n.id===f.nodeId)?.text:f.text)||'').map(s=>s.trim()).filter(Boolean).join('\n\n');
    if((step.promptField||['canvas-llm','image-api','studio'].includes(step.kind)||step.inputs?.some(f=>f.useText))&&step.text.length>(step.kind==='runninghub'?20000:step.kind==='studio'?(step.studio.config.protocol==='jimeng'?20000:5000):32000))throw userError('上游生成文字超出下游输入上限，后续尚未提交；请缩短输出后重新规划');
    const overrides=[...(step.overrides||[]),...(step.promptField?[{...step.promptField,value:step.text}]:[])];
    // Persistent child request IDs close the crash window between child creation and parent recording.
    const childRequestId=job.id+'-'+i;let child=step.jobId?await readJson(file(step.jobId)):(await records(path.join(data,'jobs'))).find(j=>j.projectId===job.projectId&&j.kind===(['runninghub','image-api','canvas-llm','studio'].includes(step.kind)?step.kind:'comfy')&&j.requestId===childRequestId);
    if(child&&step.kind==='studio'&&creationStudio.refresh)child=await creationStudio.refresh(child);
    if(child&&step.kind==='canvas-llm'&&canvasLlm.refresh)child=await canvasLlm.refresh(child);
    if(!child){const mappedStep=nativeMediaMappedStep(step,p,job.snapshot);if(mappedStep.nativeMappedFields)step.nativeMappedFields=mappedStep.nativeMappedFields;let reviewedStep=reviewedNativeInputStep(job,mappedStep,i,outputs);if(reviewedStep.nativeInputReviewApplied){step.nativeInputReviewApplied=structuredClone(reviewedStep.nativeInputReviewApplied);reviewedStep={...reviewedStep};delete reviewedStep.nativeInputReviewApplied;}let directorStep=resolveNativeDirectorStep(p,reviewedStep,outputs);
     if(step.minimaxH3&&minimaxRandomMode(step.minimaxH3)){
      if(step.minimaxSeed&&(step.minimaxSeed.version!==1||step.minimaxSeed.mode!=='random'||step.minimaxSeed.segmentId!==step.minimaxH3.selectedSegmentId||!Number.isSafeInteger(step.minimaxSeed.seed)||step.minimaxSeed.seed<0||step.minimaxSeed.seed>=MINIMAX_RANDOM_SEED_MAX))throw userError('H3 原随机种子记录与片段不一致');
      const choice=materializeMinimaxSeed(directorStep.minimaxH3,{seed:step.minimaxSeed?.seed,draw:minimaxSeedDraw});
      if(!step.minimaxSeed){step.minimaxSeed=choice.record;await save();}
      directorStep={...directorStep,minimaxH3:choice.timeline};
     }
     if(step.randomDescriptors?.length){const choice=chooseWorkflowRandom(step.randomDescriptors,step.kind==='comfy'?step.count:1,{record:step.workflowRandom,draw:workflowRandomDraw});if(!step.workflowRandom){step.workflowRandom=choice;await save();}}
     const executionStep=await resolveNativeApiStep(data,p,directorStep,outputs);if(executionStep.resolvedDirectorInputs)step.resolvedDirectorInputs=executionStep.resolvedDirectorInputs;if(executionStep.resolvedReferences)step.resolvedReferences=executionStep.resolvedReferences;if(step.imageEnhance){step.enhanceSourceId=executionStep.enhanceSourceId||step.enhanceSource.assetId||p.nodes.find(n=>n.id===step.enhanceSource.sourceNodeId)?.assetId;if(!step.enhanceSourceId)throw userError('增强上游尚未生成图片');}   const images=(executionStep.imageSources||[]).map(f=>({nodeId:f.nodeId,name:f.name,assetId:(step.imageEnhance?executionStep.enhanceSourceId:null)||f.assetId||(step.nativeFlow&&f.sourceNodeId&&(f.sourceIndex!==undefined||p.nodes.find(n=>n.id===f.sourceNodeId)?.params?.nativeCanvas)?selectNativeExecutionMedia(nativeExecutionMedia(p,f.sourceNodeId,{outputs,execution:true,loopContexts:step.nativeLoop?.contexts,mediaVersion:nativeMediaVersion(p,p.nodes.find(n=>n.id===step.nodeId))}),f.sourceIndex).assetId:p.nodes.find(n=>n.id===f.sourceNodeId)?.assetId)}));;const ltxDirector=executionStep.ltxDirector?structuredClone(executionStep.ltxDirector):null;if(ltxDirector)for(const ref of ltxReferences(ltxDirector))if(ref.sourceNodeId){ref.assetId=p.nodes.find(n=>n.id===ref.sourceNodeId)?.assetId;if(!ref.assetId)throw userError('LTX 上游素材尚未生成');delete ref.sourceNodeId;}signal.throwIfAborted();step.status='submitting';await save();signal.throwIfAborted();child=step.kind==='studio'?await creationStudio.startFromCanvas(resolveStudio(executionStep,p),p,{...studioCredentialPayload(keys.get(step.executionId||step.nodeId)),requestId:childRequestId,authorization:step.authorization,referenceInputs:step.referenceInputs},job.id,step.nodeId):step.kind==='canvas-llm'?await canvasLlm.startFromCanvas(executionStep,p,{...llmCredentialPayload(keys.get(step.executionId||step.nodeId)),requestId:childRequestId},job.id):step.kind==='image-api'?await directImages.startFromCanvas(executionStep,p,{...imageCredentialPayload(keys.get(step.executionId||step.nodeId)),requestId:childRequestId},job.id):step.kind==='runninghub'?await cloudWorkflows.startFromCanvas(await resolveCloudRecipe(executionStep,p,{data,outputs}),p,{revision:step.recipe.revision,requestId:childRequestId,apiKey:keys.get(step.executionId||step.nodeId),authorization:step.authorization,randomFields:step.randomFields},job.id,{workflowRandom:step.workflowRandom}):await generation.start(p,{workflowId:step.workflowId,workflowRevision:step.workflowRevision,promptBatch:step.promptBatch,ltxDirector,ltxText:step.text,minimaxH3:executionStep.minimaxH3,minimaxText:step.text,randomFields:step.randomFields,overrides,imageBindings:images,count:step.count,seedOffset:step.seedOffset,incrementSeeds:step.incrementSeeds,nodeId:step.nodeId,requestId:childRequestId},executionEndpoint,{nativeFlow:!!step.nativeFlow,parentId:job.id,workflowRandom:step.workflowRandom});}
    if(step.workflowRandom&&JSON.stringify(step.workflowRandom)!==JSON.stringify(child.workflowRandom))throw userError('原子任务随机参数与画布记录不一致，后续未继续');
    childId=child.id;signal.throwIfAborted();step.jobId=child.id;step.status='running';if(step.kind==='canvas-llm')step.outputText=child.outputText||'';job.message=`正在执行 ${i+1}/${job.steps.length}：${step.title}`;await save();
    if(step.kind==='canvas-llm'&&['cancelled','interrupted','failed','incomplete'].includes(child.status))throw userError('语言模型原请求未完整完成，没有可查询编号；片段已保留，不会自动重发');
    if(step.kind==='image-api'&&['cancelled','interrupted','failed'].includes(child.status))throw userError('图片接口原请求没有可查询任务编号，不会自动重发；请先核对原任务与账单');
    if(step.kind==='studio'&&['cancelled','interrupted','failed','awaiting_input'].includes(child.status)){if(!child.upstreamId)throw userError('创作接口原请求没有可查询编号，不会自动重发；请核对平台任务与账单');await creationStudio.resumeFromCanvas(child.id,studioCredentialPayload(keys.get(step.executionId||step.nodeId)),job.id);}else if(step.kind==='runninghub'&&['cancelled','interrupted','failed'].includes(child.status)){if(!child.upstreamId)throw userError('云节点没有可恢复的原任务编号，不会重新提交');await cloudWorkflows.resumeFromCanvas(step.recipeId,child.id,{apiKey:keys.get(step.executionId||step.nodeId)},job.id);}else if(['cancelled','interrupted'].includes(child.status))await generation.resume(child.id,{parentId:job.id});
    for(;;){signal.throwIfAborted();child=step.kind==='studio'&&creationStudio.refresh?await creationStudio.refresh(await readJson(file(child.id))):step.kind==='canvas-llm'&&canvasLlm.refresh?await canvasLlm.refresh(await readJson(file(child.id))):await readJson(file(child.id));if(step.kind==='studio'&&(step.upstreamId!==child.upstreamId||step.childProgress!==child.progress||step.childMessage!==child.message||child.jimengTaskId&&(step.jimengTaskId!==child.jimengTaskId||JSON.stringify(step.resultQueries)!==JSON.stringify(child.resultQueries)))){step.upstreamId=child.upstreamId||null;step.childProgress=child.progress;step.childMessage=child.message;if(child.jimengTaskId){step.jimengTaskId=child.jimengTaskId;step.resultQueries=child.resultQueries;}await save();}if(step.kind==='canvas-llm'&&step.outputText!==child.outputText){step.outputText=child.outputText||'';await save();}if(child.status==='completed')break;if(!['queued','running'].includes(child.status))throw userError(child.status==='awaiting_input'&&step.studio?.config.protocol==='jimeng'?'即梦原查询暂停或额度已用完；请核对原任务，后续未提交，不会重新生成':child.status==='awaiting_input'?'Midjourney等待重绘补参，原任务编号：'+child.upstreamId+'。请单独确认遮罩请求；已停止下游，恢复只查询原任务。':step.kind==='canvas-llm'?'语言模型未完整完成，片段已保留；下游未提交，不会自动重发':step.kind==='image-api'?'图片请求未确认完成，后续节点已停止；同步接口没有可查询编号，不会自动重发。请检查原任务与账单。':'上游节点未完成，已停止后续执行；请检查原任务');await delay(pollInterval,undefined,{signal:signal});}
    if(step.kind==='canvas-llm'){if(!child.outputText?.trim())throw userError('语言模型未返回文字');const target=p.nodes.find(n=>n.id===step.nodeId);target.text=child.outputText;job.textResults??=[];if(!job.textResults.some(r=>r.id===child.id))job.textResults.push({id:child.id,sourceNodeId:step.nodeId,title:step.title,type:target.type,text:child.outputText,...(step.loopId?{loopId:step.loopId,roundIndex:step.roundIndex}:{})});step.status='completed';job.progress=Math.round(job.steps.filter(step=>step.status==='completed').length/job.steps.length*100);await save();childId=null;return;}
    if(step.kind==='runninghub'&&step.outputType==='string'){
     const target=p.nodes.find(n=>n.id===step.nodeId),textResults=(child.textResults||[]).filter(r=>typeof r.text==='string'&&r.text.trim()),outputText=textResults.map(r=>r.text).join('\n\n');
     if(!['text','script'].includes(target?.type)||!outputText||outputText.length>200_000)throw userError('RunningHub 未返回画布可用的文字结果，或结果超过画布字数上限');
     const childReferenceAssetIds=jobReferenceAssetIds(child);for(const a of child.assets){if(!p.assets.some(x=>x.id===a.id))p.assets.push(a);if(!job.assets.some(x=>x.id===a.id))job.assets.push({...a,sourceNodeId:step.nodeId,...(step.loopId?{loopId:step.loopId,roundIndex:step.roundIndex}:{}),...(childReferenceAssetIds.length?{referenceAssetIds:childReferenceAssetIds}:{})});}
     target.text=outputText;step.outputText=outputText;job.textResults??=[];if(!job.textResults.some(r=>r.id===child.id))job.textResults.push({id:child.id,sourceNodeId:step.nodeId,title:step.title,type:target.type,text:outputText,...(step.loopId?{loopId:step.loopId,roundIndex:step.roundIndex}:{})});step.status='completed';job.progress=Math.round(job.steps.filter(step=>step.status==='completed').length/job.steps.length*100);await save();childId=null;return;
    }
    if(!child.assets.length)throw userError('节点未返回素材');
    if(step.imageEnhance)child.assets=await annotateEnhancement(data,child.assets,step);
    const target=p.nodes.find(n=>n.id===step.nodeId),first=child.assets.find(a=>step.outputType==='3d'&&target.type==='scene'?a.type==='model/gltf-binary':a.type.startsWith(target.type+'/'));if(!first)throw userError('工作流输出类型与画布节点类型不符，后续节点未执行');
    const childReferenceAssetIds=jobReferenceAssetIds(child);
    let h3Parameters;
    if(step.minimaxH3){const graph=child.workflow||child.input?.recipe?.workflowJson;const segment=selectedMinimaxSegment(step.minimaxH3);h3Parameters=graph?minimaxSubmittedParameters(graph,step.minimaxH3.referenceNodeId):minimaxParameters({...segment,seed:step.minimaxSeed?.seed??segment.seed+(step.incrementSeeds?step.seedOffset||0:0)},segment.prompt.trim()||step.text.trim());}
    for(const a of child.assets){if(!p.assets.some(x=>x.id===a.id))p.assets.push(a);if(!job.assets.some(x=>x.id===a.id))job.assets.push({...a,sourceNodeId:step.nodeId,...(step.minimaxH3?{minimaxSegmentId:step.minimaxH3.selectedSegmentId,minimaxParameters:h3Parameters}:{}),...(childReferenceAssetIds.length?{referenceAssetIds:childReferenceAssetIds}:{}),...(['image-api','studio'].includes(step.kind)?{sourcePrompt:step.text}:{}),...(step.loopId?{loopId:step.loopId,roundIndex:step.roundIndex,sourcePrompt:h3Parameters?.prompt||step.text,...(h3Parameters?{minimaxParameters:h3Parameters}:{})}:{}),...(child.promptBatch?{sourcePrompt:child.promptBatch.values[a.batchIndex]||''}:{})});}
    target.assetId=first.id;step.status='completed';job.progress=Math.round(job.steps.filter(step=>step.status==='completed').length/job.steps.length*100);await save();childId=null;
  }catch(error){if(signal.aborted&&childId)activeJobs.get(childId)?.controller.abort();throw error;}
 }
 function nativeRoundProject(job,step){
  const p=structuredClone(restoreNativeBranchProject(job.snapshot,step)),matching=value=>!value.loopId||value.loopId===step.loopId&&value.roundIndex===step.roundIndex;
  const completed=new Set(job.steps.filter(other=>other.status==='completed'&&matching(other)).map(other=>other.nodeId));
  for(const asset of job.assets.filter(matching)){if(!p.assets.some(other=>other.id===asset.id))p.assets.push(asset);if(completed.has(asset.sourceNodeId)){const node=p.nodes.find(node=>node.id===asset.sourceNodeId);if(node&&asset.type.startsWith(node.type+'/'))node.assetId=asset.id;}}
  for(const text of (job.textResults||[]).filter(matching))if(completed.has(text.sourceNodeId))p.nodes.find(node=>node.id===text.sourceNodeId).text=text.text;
  return applyNativeMediaMaps(p,{proofProject:job.snapshot,nodeId:step.nodeId,loopId:step.loopId,roundIndex:step.roundIndex,loopContexts:step.nativeLoop?.contexts||{},outputs:nativeStepOutputs(p,job,step)});
 }
 async function executeNativeUnits(job,controller,keys,save){
  for(const unit of nativeExecutionUnits(job.steps)){
   controller.signal.throwIfAborted();const rounds=[...unit.rounds.values()],hasComfy=rounds.flat().some(({step})=>step.kind==='comfy'),pool=job.loopBackends?.length?job.loopBackends:[job.endpoint],limit=unit.mode==='parallel'?Math.min(rounds.length,hasComfy?pool.length:6,6):1,failed=new AbortController(),signal=AbortSignal.any([controller.signal,failed.signal]);let next=0,firstError;
   const workers=Array.from({length:Math.max(1,limit)},async(_,worker)=>{
    while(next<rounds.length&&!signal.aborted){const entries=rounds[next++];
     try{for(const {step,index}of entries){signal.throwIfAborted();if(step.status==='completed')continue;const p=nativeRoundProject(job,step),outputs=step.nativeFlow?nativeStepOutputs(p,job,step):[];if(step.kind==='comfy'){step.nativeBackend??=structuredClone(pool[worker%pool.length]);await save();}await executeStep(job,signal,keys,step,index,p,outputs,save,step.nativeBackend||job.endpoint);}}
     catch(error){firstError??=error;failed.abort();}
    }
   });
   await Promise.allSettled(workers);if(firstError)throw firstError;controller.signal.throwIfAborted();
  }
 }
 async function run(job,controller,keys){let queue=Promise.resolve();const save=()=>{sortNativeLoopResults(job);queue=queue.then(()=>atomicJson(file(job.id),job));return queue;};
  try{
   validateNativeBranchJob(job);
   job.status='running';await save();
   if(job.steps.some(step=>step.nativeLoop))await executeNativeUnits(job,controller,keys,save);
   else for(const [i,step]of job.steps.entries()){
    controller.signal.throwIfAborted();if(step.status==='completed')continue;const p=job.snapshot;
    if(step.roundStart){const key=step.loopId+':'+step.roundIndex;if(!(job.startedRounds||[]).includes(key)){for(const id of step.roundStart){const node=p.nodes.find(node=>node.id===id);node.assetId=null;if(node.params?.llmBinding)node.text=job.originalTexts?.[id]??node.text;}(job.startedRounds??=[]).push(key);await save();}}
    await executeStep(job,controller.signal,keys,step,i,p,step.nativeFlow?nativeStepOutputs(p,job,step):[],save);
   }
   job.status='completed';job.message='画布执行完成，结果可加入项目';
  }catch(error){job.status=controller.signal.aborted?'cancelled':'interrupted';job.message=controller.signal.aborted?'已停止后续执行，可继续原任务；上游服务可能仍在计算':error.status?error.message:'执行中断，后续节点未提交；检查原任务后再继续';}
  finally{clearCanvasApiCredentialMap(keys);await save();activeJobs.delete(job.id);}
 }
 async function resume(id,body={}){try{return await resumePrepared(id,body);}finally{clearCanvasMiaoChoices(body);}}
 async function resumePrepared(id,body={}){let job=await readJson(file(id));assertLegacyNativeInputResume(job);if(creationStudio?.recoverCanvasLinks)job=await creationStudio.recoverCanvasLinks(job);if(job.kind!=='canvas-run'||!['interrupted','cancelled'].includes(job.status))throw userError('此画布任务无法继续');if([...activeJobs.values()].some(j=>j.projectId===job.projectId))throw userError('项目仍有任务运行，请稍后再继续',409);validateNativeBranchJob(job);const keys=keysFor(job.steps,body,true);clearCloudCredentials(body);clearImageCredentials(body);clearLlmCredentials(body);clearStudioCredentials(body);job.status='running';try{await atomicJson(file(job.id),job);launch(job,keys);return publicRun(job);}catch(error){clearCanvasApiCredentialMap(keys);throw error;}}
 return {plan,start,resume,publicRun};
}
