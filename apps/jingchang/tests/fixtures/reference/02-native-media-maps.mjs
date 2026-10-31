import {createHash} from 'node:crypto';
import {nativeMediaReferenceDescriptors,nativeMediaPathKey,validateNativeMediaMap} from '../public/native-media-map-core.js';
import {nativeExecutionAncestors,nativeReferenceSelectionSlots} from './native-flow-execution.mjs';
import {nativeLoopSettings,nativeLoopEnabled} from '../public/native-loop-core.js';
import {nativeBranchCandidates} from '../public/native-branch-core.js';
import {userError} from './workspace.mjs';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,canonical(v[k])])):v;
export function nativeMediaMapScope(project,node){
 const parents=nativeExecutionAncestors(project,node.id),ids=new Set([...parents,node.id]),shape=n=>{const v=n.params?.nativeCanvas,b=n.params||{},raw=v?.node||{};const bound=['workflowBinding','cloudBinding','imageBinding','llmBinding','studioBinding'].some(k=>b[k]),position=n.id!==node.id&&raw.type==='smart-image';return{id:n.id,type:n.type,...(position?{x:n.x,y:n.y}:{}),assetId:!v&&!bound?n.assetId:undefined,native:v?{type:raw.type,format:v.format,adaptation:v.adaptation,mode:raw.mode,images:!bound?raw.images:undefined,generatedOutputs:!bound?raw.generatedOutputs:undefined,url:!bound?raw.url:undefined,members:v.members,inputOrder:v.inputOrder,resources:!bound?v.resources:undefined,mediaAssetIds:!bound?v.mediaAssetIds:undefined,missingResources:v.missingResources}:null,bindings:['workflowBinding','cloudBinding','imageBinding','llmBinding','studioBinding'].filter(k=>b[k]).map(k=>({kind:k,count:b[k].count??b[k].promptBatch?.values?.length??b[k].config?.count??1})),loop:['loop','smart-loop'].includes(raw.type)?Object.fromEntries(Object.entries(nativeLoopSettings(n)).filter(([k])=>!['variablePrompt','variablePrompts'].includes(k))):null,branch:b.nativeBranch};};
 const value={nodeId:node.id,mapping:node.params?.nativeMediaMap?{version:node.params.nativeMediaMap.version,loopId:node.params.nativeMediaMap.loopId,fields:node.params.nativeMediaMap.fields}:undefined,fields:nativeMediaReferenceDescriptors(node).map(d=>({path:d.path,sourceNodeId:d.ref.sourceNodeId,sourceIndex:d.ref.sourceIndex,target:Object.fromEntries(['nodeId','name','fieldName','id','kind','type'].filter(k=>d.ref[k]!==undefined).map(k=>[k,d.ref[k]]))})),nodes:project.nodes.filter(n=>ids.has(n.id)).map(shape),edges:project.edges.filter(e=>ids.has(e.source)&&ids.has(e.target)).map(e=>({source:e.source,target:e.target,kind:e.nativeCanvasConnection?.kind})),assets:project.assets.filter(a=>project.nodes.filter(n=>ids.has(n.id)&&!['workflowBinding','cloudBinding','imageBinding','llmBinding','studioBinding'].some(k=>n.params?.[k])).some(n=>n.assetId===a.id||n.params?.nativeCanvas?.resources?.some(r=>r.assetId===a.id))).map(a=>({id:a.id,type:a.type})),branches:project.nodes.filter(n=>ids.has(n.id)&&n.params?.nativeBranch?.enabled).map(loop=>({id:loop.id,candidates:nativeBranchCandidates(project,loop)}))};
 return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
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
