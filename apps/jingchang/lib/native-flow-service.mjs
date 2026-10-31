import path from 'node:path';
import {readJson,loadAsset,safeId,userError} from './workspace.mjs';
import {nativeFlowPreview,nativeFlowOutputsFromJob} from './native-flow.mjs';
import {nativeExecutionUnits} from './native-loop-plan.mjs';
import {restoreNativeBranchProject,validateNativeBranchJob} from './native-branch.mjs';

// A GET-only inspection service. Job results are resolved against the saved
// job snapshot, never grafted onto a canvas that was edited after submission.
export function nativeFlowService({data,assertProject=()=>{}}){
 async function inspect(project,{nodeId,jobId,loopId,roundIndex}={}){
  assertProject(project);
  if(jobId===undefined){
   if(loopId!==undefined||roundIndex!==undefined)throw userError('回合筛选需要指定画布任务');
   return{...nativeFlowPreview(project,{nodeId}),source:'saved-project',resultJob:null};
  }
  if(!safeId(jobId))throw userError('数据流任务编号无效');
  if((loopId===undefined)!==(roundIndex===undefined)||loopId!==undefined&&(!safeId(loopId)||!Number.isSafeInteger(roundIndex)||roundIndex<0||roundIndex>99))throw userError('数据流回合筛选无效');
  let job;try{job=await readJson(path.join(data,'jobs',jobId+'.json'));}catch(e){if(e.code==='ENOENT')throw userError('数据流任务不存在',404);throw e;}
  if(job.kind!=='canvas-run'||job.projectId!==project.id||job.snapshot?.id!==project.id)throw userError('数据流任务不属于当前项目或缺少原始快照');
  assertProject(job.snapshot);
  if(!Array.isArray(job.steps)||!Array.isArray(job.assets)||job.steps.length>3200||job.assets.length>1000)throw userError('数据流任务结果记录无效');
  if(job.steps.some(step=>step.nativeLoop)){
   nativeExecutionUnits(job.steps);
   if(job.steps.some(step=>step.nativeLoop&&(step.nativeLoop.version!==1||!['serial','parallel'].includes(step.nativeLoop.mode)||!safeId(step.loopId)||!Number.isSafeInteger(step.roundIndex)||step.roundIndex<0||step.roundIndex>=100||!Number.isSafeInteger(step.roundCount)||step.roundCount<1||step.roundCount>100||step.roundIndex>=step.roundCount)))throw userError('原生循环任务回合记录无效');
  }else if(job.steps.length>64)throw userError('数据流任务结果记录无效');
  if(loopId!==undefined&&!job.steps.some(step=>step.loopId===loopId&&step.roundIndex===roundIndex))throw userError('数据流任务没有此回合');
  validateNativeBranchJob(job);
  const roundStep=loopId===undefined?null:job.steps.find(step=>step.loopId===loopId&&step.roundIndex===roundIndex);
  const snapshot=structuredClone(roundStep?restoreNativeBranchProject(job.snapshot,roundStep):job.snapshot),matches=value=>!value.loopId||loopId!==undefined&&value.loopId===loopId&&value.roundIndex===roundIndex;
  if(nodeId!==undefined&&!snapshot.nodes.some(node=>node.id===nodeId))throw userError('此节点属于本轮未选分支，没有本轮生成结果');
  const completed=new Set(job.steps.filter(step=>step.status==='completed'&&matches(step)).map(step=>step.nodeId));
  for(const asset of job.assets)if(completed.has(asset.sourceNodeId)&&matches(asset)){
   if(!safeId(asset.id))throw userError('数据流任务素材编号无效');
   if(!snapshot.assets.some(a=>a.id===asset.id))snapshot.assets.push(await loadAsset(data,asset.id));
  }
  const outputs=nativeFlowOutputsFromJob(snapshot,job),loopContexts=loopId===undefined?{}:job.steps.find(step=>step.loopId===loopId&&step.roundIndex===roundIndex)?.nativeLoop?.contexts||{};
  if(loopId!==undefined){const actual=new Map(outputs.map(output=>[output.nodeId,output]));for(const output of nativeFlowOutputsFromJob(snapshot,job,{loopId,roundIndex}))actual.set(output.nodeId,output);outputs.splice(0,outputs.length,...actual.values());}
  for(const output of outputs)if(!output.assetIds.length&&!output.promptItems.length)throw userError('已完成步骤没有可验证的文字或素材结果');
  return{...nativeFlowPreview(snapshot,{nodeId,outputs,loopContexts}),source:'job-snapshot',resultJob:{id:job.id,status:job.status,projectRevision:snapshot.revision,currentProjectRevision:project.revision,completedOutputNodes:outputs.length,...(loopId!==undefined?{loopId,roundIndex}:{}),...(roundStep?.nativeBranch?{nativeBranch:structuredClone(roundStep.nativeBranch)}:{})}};
 }
 return{inspect};
}
