import {assertCanvasParent,conflictingCanvasChild,linkCanvasChild} from './canvas-child-scope.mjs';
import {withLegacyNativeInputAudit} from './legacy-native-input-audit.mjs';
import {assertNativeNodeReady} from './native-canvas-core.mjs';
import {compileMinimaxH3,rejectMinimaxConflicts,captureMinimaxResultTarget,minimaxUpstreamRefs} from './minimax-h3.mjs';
import {materializeMinimaxSeed,minimaxRandomMode,minimaxSubmittedParameters} from './minimax-seed.mjs';
import {normalizeMinimaxTimeline} from '../public/minimax-h3-core.js';
import {compileLtxTimeline,rejectLtxConflicts,assignLtxMedia,checkLtxAudio} from './ltx-director.mjs';
import {normalizePromptBatch,batchCount,batchGraph,validateBatchGraphs,canResumeGeneration} from './prompt-batch.mjs';
import {comfyMediaField,comfyMediaTypes,supportsComfyAsset} from '../public/comfy-media.js';
import {normalizeFields,configuredGraph,verifyConfiguredGraph} from './workflow-fields.mjs';
import {comfyRandomFields,chooseWorkflowRandom,validateSavedWorkflowRandom} from './workflow-random.mjs';
import {applyWorkflowRandom,randomFieldKey} from '../public/workflow-random-core.js';
import {importNativeComfyFields} from './native-workflow-config.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promises as fs } from 'node:fs';
import { inspectWorkflow, submitWorkflow, queryWorkflow, downloadOutput, uploadInputMedia, validateInputMedia, validateComfyEndpoint } from './providers.mjs';
import { atomicJson, readJson, records, textValue, assertNoCredentials, safeId, userError, storeAsset } from './workspace.mjs';

export function generationService({data,activeJobs,minimaxSeedDraw,workflowRandomDraw}){
  const file=id=>path.join(data,'jobs',id+'.json');
  const persist=job=>atomicJson(file(job.id),job);
  async function template(id){if(!safeId(id))throw userError('工作流编号无效');const t=await readJson(path.join(data,'workflows',id+'.json'));return {...t,revision:t.revision??0,fields:t.fields||[]};}
  const admissions=new Map();
  async function admit(key,fn){const task=(admissions.get(key)||Promise.resolve()).catch(()=>{}).then(fn);admissions.set(key,task);try{return await task;}finally{if(admissions.get(key)===task)admissions.delete(key);}}
  const configLocks=new Map();
  const fieldsFor=(workflow,body)=>{if(body.nativeConfig!==undefined&&body.fields!==undefined)throw userError('原生字段配置与镜场字段设置不能同时提供');return body.nativeConfig!==undefined?importNativeComfyFields(workflow,body.nativeConfig):normalizeFields(workflow,body.fields||[]);};
  async function previewNativeConfig(body){const workflow=body.workflowId?(await template(body.workflowId)).workflow:body.workflow;assertNoCredentials(workflow);if(!workflow||JSON.stringify(workflow).length>2_000_000)throw userError('请提供不超过2MB的本机工作流');const inspection=inspectWorkflow(workflow);if(inspection.nodeCount>500)throw userError('工作流最多500节点');return {fields:importNativeComfyFields(workflow,body.nativeConfig),inspection,persisted:false};}
  async function configure(id,body){const old=configLocks.get(id)||Promise.resolve(),task=old.catch(()=>{}).then(async()=>{const t=await template(id);if(body.revision!==t.revision)throw userError('字段配置已更新，请重新打开',409);const fields=fieldsFor(t.workflow,body);const next={...t,fields,revision:t.revision+1,updatedAt:new Date().toISOString()};await atomicJson(path.join(data,'workflows','history',id,t.revision+'-'+randomUUID()+'.json'),t);await atomicJson(path.join(data,'workflows',id+'.json'),next);return next;});configLocks.set(id,task);try{return await task;}finally{if(configLocks.get(id)===task)configLocks.delete(id);}}
  async function saveTemplate(body){
    const name=textValue(body.name,120,'工作流名称');assertNoCredentials(body.workflow);
    if(JSON.stringify(body.workflow).length>2_000_000)throw userError('工作流文件超过 2 MB');
    let inspection;try{inspection=inspectWorkflow(body.workflow);}catch{throw userError('请导入 ComfyUI 的 API 格式 JSON，而不是界面布局文件');}
    if(inspection.nodeCount>500)throw userError('工作流最多 500 个节点');
    const graph=structuredClone(body.workflow.prompt||body.workflow);
    const record={id:randomUUID(),name,workflow:graph,inspection,revision:0,fields:fieldsFor(graph,body),createdAt:new Date().toISOString()};
    await atomicJson(path.join(data,'workflows',record.id+'.json'),record);return record;
  }
  async function prepareBindings(project, bindings, graph, overridden, fieldConfigs=[]) {
    if (bindings === undefined) return { bindings: [], images: new Map() };
    if (!Array.isArray(bindings) || bindings.length > 96) throw userError('媒体映射须为数组，最多 96 项');
    const images = new Map(), fields = new Set(), checked = [];
    let total = 0;
    for (const binding of bindings) {
      if (!binding || typeof binding.nodeId !== 'string' || typeof binding.name !== 'string' || !safeId(binding.assetId)) throw userError('媒体映射参数无效');
      const key = JSON.stringify([binding.nodeId, binding.name, ...(binding.ltxTrack?[binding.ltxTrack,binding.segmentId]:[])]);
      if (fields.has(key) || overridden.has(key)) throw userError('工作流字段不能重复设置或同时覆盖与映射素材');
      fields.add(key);
      const node = Object.hasOwn(graph, binding.nodeId) ? graph[binding.nodeId] : null;
      const mediaField=binding.ltxTrack&&node?.class_type==='LTXDirector'?{kinds:[binding.ltxTrack==='segments'?'image':'audio']}:node&&comfyMediaField(node.class_type,binding.name,fieldConfigs.find(f=>f.nodeId===binding.nodeId&&f.name===binding.name));
      if(!mediaField||typeof node.inputs?.[binding.name]!=='string')throw userError('媒体映射仅支持模板中设为图片、视频或音频的字符串字段');
      const projectAsset = project.assets?.find(asset => asset.id === binding.assetId);
      if (!projectAsset) throw userError('映射素材不属于当前项目');
      if(!supportsComfyAsset(mediaField,projectAsset))throw userError('映射素材类型、大小与输入字段不符');
      if (!images.has(binding.assetId)) {
        const root = await fs.realpath(data), directory = path.join(root, 'assets');
        const source = path.join(directory, binding.assetId), metaPath = `${source}.json`;
        let meta, bytes;
        try {
          if (await fs.realpath(directory) !== directory) throw userError('媒体素材目录不能是符号链接');
          const [stat, metaStat] = await Promise.all([fs.lstat(source), fs.lstat(metaPath)]);
          if (!stat.isFile() || !metaStat.isFile() || metaStat.size > 1024**2 || stat.size < 1 || stat.size > comfyMediaTypes[projectAsset.type].limit * 1024 * 1024) throw userError('映射素材须为本地普通文件且在对应格式大小限制内');
          meta = await readJson(metaPath);
          if (meta.id !== binding.assetId || meta.size !== stat.size || meta.type !== projectAsset.type || !supportsComfyAsset(mediaField,meta)) throw userError('映射素材的素材记录或格式不匹配');
          total += stat.size;
          if (total > 300 * 1024 * 1024) throw userError('映射素材总大小不能超过 300 MB');
          bytes = await fs.readFile(source);
        } catch (error) {
          if (error.status) throw error;
          throw userError('找不到有效的本地映射素材');
        }
        const extension = comfyMediaTypes[meta.type].extension;
        try { images.set(binding.assetId, validateInputMedia({ bytes, mime: meta.type, name: `jingchang-${binding.assetId}.${extension}` })); }
        catch (error) { throw userError(error.message); }
      }
      checked.push({ nodeId: binding.nodeId, name: binding.name, assetId: binding.assetId, ...(binding.ltxTrack?{ltxTrack:binding.ltxTrack,segmentId:binding.segmentId}:{}) });
    }
    return { bindings: checked, images };
  }
  async function start(project,body,endpoint,{nativeFlow=false,parentId,workflowRandom,nativeCascade=false}={}){if(parentId)assertCanvasParent(activeJobs,parentId,project.id);if(nativeCascade&&(!parentId||!nativeFlow))throw userError('智能串联媒体映射仅用于已确认的画布父任务');return admit(project.id,()=>startUnlocked(project,body,endpoint,nativeFlow,parentId,workflowRandom,nativeCascade));}
  async function startUnlocked(project,body,endpoint,nativeFlow=false,parentId,workflowRandom,nativeCascade=false){
    if(body.requestId!==undefined){if(!safeId(body.requestId))throw userError('请求编号无效');const previous=(await records(path.join(data,'jobs'))).find(j=>j.kind==='comfy'&&j.projectId===project.id&&j.requestId===body.requestId);if(previous)return publicJob(previous);}
    assertNativeNodeReady(project,body.nodeId,{flow:nativeFlow});
    if(body.revision!==undefined&&body.revision!==project.revision)throw userError('项目已更新，请重新打开运行参数',409);
    if(conflictingCanvasChild(activeJobs,project.id,parentId,'comfy'))throw userError('当前项目已有生成任务，请等待其完成',409);
    if(body.mediaBindings!==undefined&&body.imageBindings!==undefined)throw userError('不能同时设置两组媒体映射');
    const directBindings=body.mediaBindings??body.imageBindings;
    const mediaLimit=nativeCascade?20:16;
    if(directBindings!==undefined&&(!Array.isArray(directBindings)||directBindings.length>mediaLimit||directBindings.some(b=>!b||b.ltxTrack!==undefined||b.segmentId!==undefined)))throw userError('普通媒体映射最多'+mediaLimit+'项；时间线媒体请通过 LTX 导演配置');
    const t=await template(body.workflowId),graph=configuredGraph(t),promptBatch=normalizePromptBatch(t,body.promptBatch),count=batchCount(body.count,promptBatch);
    if(body.workflowRevision!==undefined&&body.workflowRevision!==t.revision)throw userError('工作流字段已更新，请重新打开运行表单',409);
    const specialized=!!(body.ltxDirector||body.minimaxH3),randomFields=comfyRandomFields(t,body.randomFields??(specialized?[]:undefined)),randomKeys=new Set(randomFields.map(randomFieldKey));
    if(specialized&&randomFields.length)throw userError('时间轴参数由片段管理，请关闭通用字段随机');
    if(!Array.isArray(body.overrides)||body.overrides.length>5000)throw userError('工作流参数无效');
    const overridden=new Set();
    for(const entry of body.overrides){if(!entry||typeof entry.nodeId!=='string'||typeof entry.name!=='string')throw userError('工作流参数无效');const key=JSON.stringify([entry.nodeId,entry.name]);if(overridden.has(key))throw userError('工作流字段不能重复设置');overridden.add(key);const node=Object.hasOwn(graph,entry.nodeId)?graph[entry.nodeId]:null;if(!node||!Object.hasOwn(node.inputs||{},entry.name))throw userError('工作流参数不存在');const previous=node.inputs[entry.name];if(!['string','number','boolean'].includes(typeof previous)||typeof entry.value!==typeof previous||(typeof previous==='number'&&!Number.isFinite(entry.value)))throw userError('工作流参数类型不匹配');node.inputs[entry.name]=entry.value;}
    if(body.ltxText!==undefined&&(typeof body.ltxText!=='string'||body.ltxText.length>32000))throw userError('LTX 上游文字无效');
    const ltx=body.ltxDirector?compileLtxTimeline(body.ltxDirector,t.workflow,{project,text:body.ltxText}):null;
    if(body.minimaxH3?.engine&&body.minimaxH3.engine!=='comfyui')throw userError('RunningHub H3 请通过已绑定的云时间轴运行');
    if(body.minimaxH3&&(ltx||promptBatch))throw userError('H3 时间轴不能与 LTX 导演或提示词列表同时执行');
    if(body.minimaxH3&&count!==1)throw userError('H3 每次生成当前片段一次，变体请单独确认后再次生成');
    const parents=new Set();function visit(id){for(const edge of project.edges.filter(e=>e.target===id))if(!parents.has(edge.source)){parents.add(edge.source);visit(edge.source);}}if(body.nodeId)visit(body.nodeId);
    if(body.minimaxH3&&minimaxRandomMode(body.minimaxH3)&&body.incrementSeeds===true)throw userError('H3 每次随机与递增种子不能同时启用');
    const seedChoice=body.minimaxH3?materializeMinimaxSeed(body.minimaxH3,{draw:minimaxSeedDraw}):null;
    const h3=body.minimaxH3?compileMinimaxH3(seedChoice.timeline,graph,{project,parents,resolve:true,text:body.minimaxText??'',upstreamRefs:minimaxUpstreamRefs(project,parents)}):null;
    if(h3)rejectMinimaxConflicts(h3.contract,[...body.overrides,...(directBindings||[])]);
    rejectLtxConflicts(ltx?.timeline,[...body.overrides,...(directBindings||[]),promptBatch]);
    const bindings=[...(directBindings||[]),...(ltx?.bindings||[]),...(h3?.bindings||[])];
    const configured=configuredGraph(t,[...body.overrides.filter(f=>!randomKeys.has(randomFieldKey(f))),...(ltx?.overrides||[]),...(h3?.overrides||[])]);Object.assign(graph,configured);
    if(h3){Object.assign(graph,h3.graph);for(const f of h3.overrides)graph[f.nodeId].inputs[f.name]=configured[f.nodeId].inputs[f.name];if(Object.keys(graph).length>500)throw userError('H3 添加参考素材后工作流超过500节点');}
    for(const f of bindings||[])if(t.fields.some(x=>x.nodeId===f.nodeId&&x.name===f.name&&!x.exposed))throw userError('图片字段已隐藏，请重新配置节点');
    const seedOffset=body.seedOffset??0,maxSeedOffset=parentId&&nativeFlow?999:63;if(!Number.isInteger(seedOffset)||seedOffset<0||seedOffset>maxSeedOffset)throw userError('循环种子偏移须为0–'+maxSeedOffset);Object.assign(graph,batchGraph(graph,seedOffset,null,body.incrementSeeds===true,randomFields));
    validateBatchGraphs(t,graph,count,promptBatch,body.incrementSeeds===true,randomFields);
    assertNoCredentials(graph);
    validateComfyEndpoint(endpoint);
    const prepared=await prepareBindings(project,bindings,graph,overridden,t.fields);
    if(ltx)await checkLtxAudio(data,ltx.timeline,project);
    const target=body.nodeId?project.nodes.find(n=>n.id===body.nodeId):null;if(body.nodeId&&!target)throw userError('目标节点不存在');
    const randomRecord=chooseWorkflowRandom(randomFields,count,{record:workflowRandom,draw:workflowRandomDraw});
    const job={id:randomUUID(),kind:'comfy',projectId:project.id,...(parentId?{parentId}:{}),...(body.requestId?{requestId:body.requestId}:{}),revision:project.revision,name:t.name,workflowId:t.id,backend:typeof endpoint==='object'?{id:endpoint.id,name:endpoint.name,url:endpoint.url}:null,workflow:graph,endpoint,count,...(promptBatch?{promptBatch}:{}),incrementSeeds:body.incrementSeeds===true,target:target?{id:target.id,assetId:target.assetId,text:target.text}:null,createdAt:new Date().toISOString(),status:'queued',progress:0,message:'等待提交本机工作流',items:[],assets:[],applied:false};
    if(ltx)job.ltxDirector=ltx.timeline;
    if(randomRecord){job.randomFields=randomFields.map(({nodeId,name})=>({nodeId,name}));job.workflowRandom=randomRecord;}
    if(h3){job.minimaxH3=h3.timeline;if(seedChoice.record)job.minimaxSeed=seedChoice.record;if(target?.params?.workflowBinding?.minimaxH3)job.minimaxResultTarget=captureMinimaxResultTarget(target,normalizeMinimaxTimeline(body.minimaxH3),{project,parents});}
    if(prepared.bindings.length)Object.assign(job,{imageBindings:prepared.bindings,inputMappings:[],inputPrepared:false,inputPreparation:'pending'});
    await persist(job);launch(job,prepared.images);return publicJob(job);
  }
  function launch(job,images){const controller=new AbortController(),unlink=linkCanvasChild(activeJobs,job.parentId,controller);activeJobs.set(job.id,{controller,projectId:job.projectId,kind:'comfy',...(job.parentId?{parentId:job.parentId}:{})});void run(job,controller,images).finally(unlink);}
  async function run(job,controller,images){
    try{
      validateSavedWorkflowRandom(job);
      job.status='running';await persist(job);
      if(job.imageBindings?.length&&!job.inputPrepared&&!job.items.some(item=>item.promptId)){
        if(job.inputPreparation!=='pending'||!images)throw userError('素材提交结果不确定，请先检查本机 ComfyUI；不会重复上传。');
        job.inputPreparation='uploading';job.message='正在上传项目素材到本机 ComfyUI';await persist(job);
        const uploaded=new Map();
        for(const binding of job.imageBindings){
          controller.signal.throwIfAborted();
          if(!uploaded.has(binding.assetId))uploaded.set(binding.assetId,await uploadInputMedia(job.endpoint,images.get(binding.assetId),{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120000)])}));
          const location=uploaded.get(binding.assetId),value=location.subfolder?`${location.subfolder}/${location.name}`:location.name;
          if(binding.ltxTrack)assignLtxMedia(job.workflow,binding,value);else job.workflow[binding.nodeId].inputs[binding.name]=value;
          job.inputMappings.push({...binding,uploaded:location,value});await persist(job);
        }
        job.inputPrepared=true;job.inputPreparation='completed';await persist(job);
      }
      for(let i=0;i<job.count;i++){
        controller.signal.throwIfAborted();let item=job.items[i];
        if(item?.status==='completed')continue;
        if(!item){if(job.imageBindings?.length&&!job.inputPrepared)throw userError('媒体映射记录未完成，不能提交新的批次。');item={index:i,status:'submitting',promptId:null,assets:[],...(job.promptBatch?{prompt:job.promptBatch.values[i]}:{})};job.items.push(item);job.message=`提交第 ${i+1} / ${job.count} 次生成`;await persist(job);
          const graph=applyWorkflowRandom(batchGraph(job.workflow,i,job.promptBatch,job.incrementSeeds,job.randomFields),job.workflowRandom,i);
          const submitted=await submitWorkflow(job.endpoint,graph,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});item.promptId=submitted.promptId;item.status='pending';await persist(job);
        }
        if(!item.promptId)throw userError('提交结果不确定；请先在 ComfyUI 检查队列。本任务不会自动重复提交。');
        const deadline=Date.now()+6*60*60*1000;
        for(;;){controller.signal.throwIfAborted();if(Date.now()>deadline)throw userError('等待超过 6 小时，已停止查询；可稍后继续查询原任务。');
          const state=await queryWorkflow(job.endpoint,item.promptId,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])});
          if(state.status==='failed'){item.status='failed';throw userError('ComfyUI 执行失败，请在该服务查看缺失模型或节点等原因。');}
          if(state.status==='completed'){
            if(!state.outputs.length)throw userError('工作流完成但没有可导入的媒体输出，请检查保存图片、视频或音频节点。');
            if(state.outputs.length>100)throw userError('单次输出超过 100 份，请在 ComfyUI 缩小批次。');
            const seen=new Set(item.assets.map(a=>a.outputKey));
            for(const output of state.outputs){const key=JSON.stringify([output.nodeId,output.filename,output.subfolder,output.type]);if(seen.has(key))continue;
              const chunks=[];const downloaded=await downloadOutput(job.endpoint,output,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120000)]),onChunk(chunk,{size}){if(size>150*1024*1024)throw userError('生成素材超过 150 MB，请在 ComfyUI 导出后手动处理');chunks.push(chunk);}});
              const type=downloaded.mime==='application/octet-stream'?output.mime:downloaded.mime;
              const asset=await storeAsset(data,Buffer.concat(chunks),{name:downloaded.fileName.slice(0,200),type,source:'comfy',category:'生成素材',tags:[job.name.slice(0,40)]});
              item.assets.push({id:asset.id,outputKey:key});job.assets.push({...asset,...(job.minimaxH3?{minimaxParameters:minimaxSubmittedParameters(job.workflow,job.minimaxH3.referenceNodeId)}:{}),...(job.promptBatch?{batchIndex:i}:{})});await persist(job);
            }
            item.status='completed';job.progress=Math.round((i+1)/job.count*100);await persist(job);break;
          }
          job.message=`第 ${i+1} / ${job.count} 次：等待本机 ComfyUI 完成`;await persist(job);await delay(1500,undefined,{signal:controller.signal});
        }
      }
      job.status='completed';job.progress=100;job.message=`已生成 ${job.assets.length} 份素材，可加入项目`;
    }catch(e){
      const current=job.items.find(x=>x.status!=='completed');
      job.status=controller.signal.aborted?'cancelled':current?.promptId&&current.status!=='failed'?'interrupted':'failed';
      job.message=controller.signal.aborted?'已停止接收结果；ComfyUI 中已提交的计算可能仍在运行，可继续查询。':e.status===400?e.message:current?.promptId?'暂时无法取得生成结果，可继续查询原任务；不会重复提交。':'提交未确认，请先检查本机 ComfyUI 服务及队列，避免重复运行。';
    }finally{await persist(job);activeJobs.delete(job.id);}
  }
  async function resume(id,{parentId}={}){if(!safeId(id))throw userError('任务编号无效');const initial=await readJson(file(id));return admit(initial.projectId,async()=>{const job=await readJson(file(id));if(job.kind!=='comfy'||!['interrupted','cancelled'].includes(job.status))throw userError('此任务不支持继续查询');if(job.parentId&&job.parentId!==parentId)throw userError('请从所属画布任务继续此步骤');if(parentId)assertCanvasParent(activeJobs,parentId,job.projectId);if(conflictingCanvasChild(activeJobs,job.projectId,parentId,'comfy'))throw userError('项目已有生成任务运行',409);validateSavedWorkflowRandom(job);if(!canResumeGeneration(job))throw userError('没有可恢复的生成编号或输入记录，请先检查 ComfyUI 队列；不会重新提交未确认项');job.status='running';await persist(job);launch(job);return publicJob(job);});}

  return {start,resume,template,saveTemplate,configure,previewNativeConfig,list:async()=>records(path.join(data,'workflows'))};
}
export function publicJob(job){const {workflow,endpoint,snapshot,...visible}=job;return withLegacyNativeInputAudit(job,{...visible,...(job.kind==='comfy'?{canResume:canResumeGeneration(job)}:job.kind==='render'?{canResume:!!job.snapshot&&['cancelled','interrupted','failed'].includes(job.status)}:{})});}
