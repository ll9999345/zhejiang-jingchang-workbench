import {nativeInputSourceFingerprint,nativeInputReviewFingerprint,checkedNativeInputReviews} from './native-input-review-proof.mjs';
import {nativeMediaMapScope,applyNativeMediaMaps,nativeMediaMappedStep} from './native-media-maps.mjs';
import {nativeReferencePlan,nativeStepOutputs} from './native-flow-execution.mjs';
import {nativeProducerIndices} from './native-producer-slots.mjs';
import {restoreNativeBranchProject} from './native-branch.mjs';
import {safeId,userError} from './workspace.mjs';

const adapters={'image-api':{key:'image',consumer:'generator'},studio:{key:'studio',consumer:'generator'},'canvas-llm':{key:'llm',consumer:'llm'}};
const scope=item=>JSON.stringify([item.sourceNodeId,item.originNodeId||'',item.kind]);
const mappedScopeCovered=(details,row)=>details.some(old=>old.kind===row.kind&&(old.originNodeId||'')===(row.originNodeId||'')&&(old.pending?old.sourceNodeId===(row.pending?row.sourceNodeId:row.producerNodeId):row.assetId?old.assetId===row.assetId:row.url&&old.url===row.url));
const bindingKeys=['workflowBinding','cloudBinding','imageBinding','llmBinding','studioBinding'];
function sourceFingerprint(job,step,stepIndex,project,node,adapter){
 return nativeInputSourceFingerprint({jobId:job.id,stepIndex,nodeId:step.nodeId,
  selectionScope:nativeMediaMapScope(project,node),
  bindings:project.nodes.map(n=>({id:n.id,mediaVersion:n.params?.nativeMediaVersion??project.settings?.nativeMediaVersion??1,
   bindings:Object.fromEntries(bindingKeys.filter(k=>n.params?.[k]!==undefined).map(k=>[k,n.params[k]]))})),
  command:step[adapter.key],nativeReferences:step.nativeReferences,nativeLoop:step.nativeLoop,nativeBranch:step.nativeBranch});
}
export const nativeInputReviewSelections=audit=>audit.entries.filter(row=>row.state==='requires_confirmation').map(row=>({stepIndex:row.stepIndex,detailIndex:row.detailIndex,sourceFingerprint:row.sourceFingerprint,outputFingerprint:row.outputFingerprint,producerNodeId:row.producerNodeId,originNodeId:row.originNodeId,kind:row.kind,indices:[...row.reconstructedIndices]}));
// This only audits an already saved plan. It never upgrades a receipt, writes
// the task, resolves provider jobs or grants permission to send new inputs.
export function legacyNativeInputAudit(job){
 const entries=[];let snapshot,reviews;
 if(job?.kind!=='canvas-run'||job.executionMode==='native-cascade'||!Array.isArray(job.steps))return{format:'jingchang.legacy-native-input-audit@1',state:'not_applicable',blocksResume:false,entries};
 for(const [stepIndex,step] of job.steps.entries()){
  if(step.status==='completed'||safeId(step.jobId))continue; // Already submitted children keep their existing query path.
  const details=step.nativeReferences?.details;
  if(!Array.isArray(details))continue;
  const legacy=details.flatMap((item,detailIndex)=>item?.pending===true&&item.producerIndices===undefined?[{item,detailIndex}]:[]);
  if(!legacy.length)continue;
  const base={stepIndex,nodeId:step.nodeId};
  const unable=reason=>entries.push({...base,state:'unverifiable',reason});
  if(step.nativeReferences.version!==1||!adapters[step.kind]||!job.snapshot?.nodes||!job.snapshot?.assets){unable('原任务缺少可核对的快照或接口计划，不能推测原素材。');continue;}
  try{
   snapshot??=structuredClone(job.snapshot);
   const project=restoreNativeBranchProject(snapshot,step),node=project.nodes.find(node=>node.id===step.nodeId),adapter=adapters[step.kind];
   if(!node)throw Error('missing consumer');
   for(const asset of job.assets||[])if(!project.assets.some(row=>row.id===asset.id))project.assets.push(structuredClone(asset));
   const outputs=nativeStepOutputs(project,job,step);
   // Reuse the same immutable mapping proof and per-round materialization as
   // execution. A missing/stale/ambiguous proof still fails closed; a valid
   // map on a fixed field must not hide a separate legacy collection choice.
   const effective=node.params?.nativeMediaMap?applyNativeMediaMaps(project,{proofProject:project,nodeId:node.id,loopId:step.loopId,roundIndex:step.roundIndex,loopContexts:step.nativeLoop?.contexts||{},outputs}):project;
   const mapped=effective===project?step:nativeMediaMappedStep(step,effective,project),binding=mapped[adapter.key];
   if(!binding||!Array.isArray(binding.referenceSources))throw Error('missing binding');
   const plan=nativeReferencePlan(effective,effective.nodes.find(n=>n.id===node.id),binding.referenceSources,{outputs,planning:true,consumer:adapter.consumer,loopContexts:step.nativeLoop?.contexts});
   if(node.params?.nativeMediaMap&&plan.details.some(row=>!mappedScopeCovered(details,row)))throw Error('mapped reference scope changed');
   const sourceProof=sourceFingerprint(job,step,stepIndex,project,node,adapter);
   reviews??=checkedNativeInputReviews(job.nativeInputReviews);
   for(const {item,detailIndex} of legacy){
    const authorizedIndices=nativeProducerIndices(item),output=outputs.find(row=>row.nodeId===item.sourceNodeId);
    if(details.filter(row=>row.pending===true&&scope(row)===scope(item)).length!==1){unable('原记录无法唯一对应这份生产者选择，请重新核对计划。');continue;}
    let reconstructedIndices,outputFingerprint=null;
    if(output){
     const actual=plan.details.filter(row=>!row.pending&&row.producerNodeId===item.sourceNodeId&&(row.originNodeId||'')===(item.originNodeId||'')&&row.kind===item.kind);
     reconstructedIndices=actual.map(row=>output.assetIds.indexOf(row.assetId));
     if(!reconstructedIndices.length||reconstructedIndices.some(index=>index<0||index>63)||new Set(reconstructedIndices).size!==reconstructedIndices.length){unable('已完成上游没有可唯一核对的原素材序号，请查看原结果。');continue;}
     outputFingerprint=nativeInputSourceFingerprint({sourceNodeId:item.sourceNodeId,assetIds:output.assetIds});
    }else{
     const matching=plan.details.filter(row=>row.pending===true&&scope(row)===scope(item));
     if(matching.length!==1){unable('原记录无法唯一对应这份生产者选择，请重新核对计划。');continue;}
     reconstructedIndices=nativeProducerIndices(matching[0]);
    }
    const compatible=reconstructedIndices.every(index=>authorizedIndices.includes(index));
    const review=reviews.find(record=>record.jobId===job.id&&record.selections.some(row=>row.stepIndex===stepIndex&&row.detailIndex===detailIndex&&row.sourceFingerprint===sourceProof&&(row.outputFingerprint===null||row.outputFingerprint===outputFingerprint)&&row.producerNodeId===item.sourceNodeId&&(row.originNodeId||'')===(item.originNodeId||'')&&row.kind===item.kind&&JSON.stringify(row.indices)===JSON.stringify(reconstructedIndices)));
    entries.push({...base,detailIndex,sourceFingerprint:sourceProof,outputFingerprint,producerNodeId:item.sourceNodeId,originNodeId:item.originNodeId||null,kind:item.kind,
     state:compatible?'compatible':review?'reviewed':'requires_confirmation',authorizedIndices,reconstructedIndices,...(review?{reviewId:review.id}:{}),
     reason:compatible?'任务快照所需序号仍在原确认范围内。':review?'已明确确认这份素材序号，仍需按原任务范围执行。':'任务快照所需生产序号超出旧记录的确认范围，不能自动补写或继续发送。'});
   }
  }catch{unable('无法从原任务快照可靠还原素材选择，请重新检查工作流与发送范围。');}
 }
 const state=entries.some(row=>row.state==='unverifiable')?'unverifiable':entries.some(row=>row.state==='requires_confirmation')?'requires_confirmation':entries.some(row=>row.state==='reviewed')?'reviewed':entries.length?'compatible':'not_needed';
 const blocksResume=['unverifiable','requires_confirmation'].includes(state);
 if(!entries.length)return{format:'jingchang.legacy-native-input-audit@1',state,blocksResume:false,entries};
 const fingerprint=nativeInputReviewFingerprint(job.id,nativeInputReviewSelections({entries}));
 return{format:'jingchang.legacy-native-input-audit@1',state,blocksResume,fingerprint,proofVersion:1,entries,
  summary:blocksResume?'旧任务的素材序号需重新核对；本次尚未继续，也没有重发生成请求。':state==='reviewed'?'已记录明确的素材序号确认；尚未继续，原任务执行检查和授权仍然适用。':'旧素材序号检查没有发现超出原确认范围的选择；其它授权与执行检查仍然适用。'};
}

export function reviewedNativeInputStep(job,step,stepIndex,outputs=[]){
 // Newly planned runs and steps without an explicit legacy decision retain
 // their existing strict resolver, including its actual-output count checks.
 if(!job.nativeInputReviews?.some(record=>record.jobId===job.id&&record.selections?.some(row=>row.stepIndex===stepIndex)))return step;
 const audit=assertLegacyNativeInputResume(job),approved=audit.entries.filter(row=>row.stepIndex===stepIndex&&row.state==='reviewed');
 if(!approved.length)return step;
 const out=structuredClone(step),applied=[];
 for(const row of approved){
  const source=outputs.find(output=>output.nodeId===row.producerNodeId);
  if(!source||!Array.isArray(source.assetIds)||row.reconstructedIndices.some(index=>!safeId(source.assetIds[index])))throw userError('已确认序号对应的上游输出尚不完整，后续未提交；已有产物保留。',409);
  const target=out.nativeReferences?.details?.[row.detailIndex];
  if(!target||target.sourceNodeId!==row.producerNodeId)throw userError('素材确认与实际执行字段不一致，后续未提交。',409);
  target.expectedCount=row.reconstructedIndices.length;target.producerIndices=[...row.reconstructedIndices];
  applied.push({reviewId:row.reviewId,detailIndex:row.detailIndex,sourceFingerprint:row.sourceFingerprint});
 }
 out.nativeInputReviewApplied=applied;
 return out;
}

export function assertLegacyNativeInputResume(job){
 const audit=legacyNativeInputAudit(job);
 if(audit.blocksResume){const error=userError(audit.summary,409);error.code='NATIVE_LEGACY_INPUT_REVIEW_REQUIRED';throw error;}
 return audit;
}

export function withLegacyNativeInputAudit(job,visible){
 if(job?.kind!=='canvas-run'||job.executionMode==='native-cascade')return visible;
 const audit=legacyNativeInputAudit(job);
 return audit.entries.length?{...visible,legacyNativeInputAudit:audit,...(audit.blocksResume?{canResume:false}:{})}:visible;
}
