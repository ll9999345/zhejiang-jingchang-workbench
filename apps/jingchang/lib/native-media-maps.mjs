import {nativeMediaScopeText} from '../public/native-media-scope-core.js';
import {createHash} from 'node:crypto';
import {nativeMediaReferenceDescriptors,nativeMediaPathKey,validateNativeMediaMap} from '../public/native-media-map-core.js';
import {nativeReferenceSelectionSlots} from './native-flow-execution.mjs';
import {nativeLoopEnabled} from '../public/native-loop-core.js';
import {userError} from './workspace.mjs';
export function nativeMediaMapScope(project,node){return createHash('sha256').update(nativeMediaScopeText(project,node)).digest('hex');}
export function assertNativeMediaMapScopes(project){for(const node of project.nodes)if(node.params?.nativeMediaMap){validateNativeMediaMap(node,project);if(nativeMediaMapScope(project,node)!==node.params.nativeMediaMap.scopeHash)throw userError('逐轮选图的上游或字段已变化，请重新检查或取消逐轮选图');}}
export function applyNativeMediaMaps(project,{proofProject=project,nodeId,nodeIds,loopId,roundIndex,loopContexts={},outputs=[]}={}){
 const nodes=project.nodes.filter(n=>n.params?.nativeMediaMap&&(!nodeId||n.id===nodeId)&&(!nodeIds||nodeIds.has(n.id)));if(!nodes.length)return project;
 const next=structuredClone(project);
 for(const node of nodes){const original=proofProject.nodes.find(n=>n.id===node.id),map=original?.params?.nativeMediaMap;validateNativeMediaMap(original,proofProject);if(!map||nativeMediaMapScope(proofProject,original)!==map.scopeHash)throw userError('逐轮选图的上游或字段已变化，请重新检查或取消逐轮选图');
  if(map.loopId!==loopId||!Number.isSafeInteger(roundIndex)||!nativeLoopEnabled(proofProject.nodes.find(n=>n.id===loopId)))throw userError('逐轮选图缺少对应回合，未沿用第一轮选择');
  const target=next.nodes.find(n=>n.id===node.id),descriptors=nativeMediaReferenceDescriptors(target);
  for(const field of map.fields){const r=field.rounds.find(r=>r.roundIndex===roundIndex);if(!r||r.index!==loopContexts[loopId]?.index)throw userError('逐轮选图计数与已核对范围不一致');const d=descriptors.find(d=>nativeMediaPathKey(d.path)===nativeMediaPathKey(field.path)),slots=nativeReferenceSelectionSlots(project,node,field.sourceNodeId,{consumer:'loop',mediaVersion:2,loopContexts,outputs}),matches=slots.flatMap((slot,i)=>slot.selection?.sourceNodeId===r.selection.sourceNodeId&&slot.selection?.sourceIndex===r.selection.sourceIndex&&(r.selection.kind===undefined||slot.kind===r.selection.kind)&&(r.selection.assetId===undefined||r.selection.assetId===slot.assetId)?[i]:[]);
   if(matches.length!==1)throw userError('本轮原素材不存在或不唯一，后续未提交；上游结果保留');d.ref.sourceIndex=matches[0];
  }
  // The execution copy has numeric bindings; its original proof remains only
  // in the immutable task snapshot, not on a rewritten transient node.
  delete target.params.nativeMediaMap;
 }
 return next;
}

export function nativeMediaMappedStep(step,materialized,proofProject){
 const original=proofProject.nodes.find(n=>n.id===step.nodeId),map=original?.params?.nativeMediaMap;if(!map)return step;
 const node=materialized.nodes.find(n=>n.id===step.nodeId),out=structuredClone(step),current=nativeMediaReferenceDescriptors(node);out.nativeMappedFields=[];
 for(const field of map.fields){const d=current.find(d=>nativeMediaPathKey(d.path)===nativeMediaPathKey(field.path)),path=field.path,root=path[0];let target;
  if(root==='workflowBinding'&&path[1]==='imageSources')target=out.imageSources?.[path[2]];
  else if(root==='cloudBinding'&&path[1]==='inputs'){target=out.inputs?.[path[2]];const receipt=out.nativeInputs?.fields.find(f=>f.nodeId===target?.nodeId&&f.fieldName===target?.fieldName);if(receipt)receipt.sourceIndex=d.ref.sourceIndex;}
  else if(['studioBinding','imageBinding','llmBinding'].includes(root))target=out[{studioBinding:'studio',imageBinding:'image',llmBinding:'llm'}[root]]?.referenceSources?.[path[2]];
  else if(path.includes('minimaxH3')||root==='minimaxH3'){out.minimaxH3=structuredClone(node.params.minimaxH3||node.params.workflowBinding?.minimaxH3||node.params.cloudBinding?.minimaxH3);}
  else if(path.includes('ltxDirector'))out.ltxDirector=structuredClone(node.params.workflowBinding?.ltxDirector);
  if(target)target.sourceIndex=d.ref.sourceIndex;
  out.nativeMappedFields.push({path:field.path,sourceNodeId:field.sourceNodeId,sourceIndex:d.ref.sourceIndex,loopId:map.loopId,roundIndex:step.roundIndex});
 }
 return out;
}

export function refreshNativeMediaMapScopes(project,nodeIds){for(const n of project.nodes)if(n.params?.nativeMediaMap&&(!nodeIds||nodeIds.has(n.id)))n.params.nativeMediaMap.scopeHash=nativeMediaMapScope(project,n);}
export function validNativeMediaMapIds(project){return new Set(project.nodes.filter(n=>n.params?.nativeMediaMap&&nativeMediaMapScope(project,n)===n.params.nativeMediaMap.scopeHash).map(n=>n.id));}
