import {sourceIndexFields} from '../public/source-index-core.js';
import {nativeNodeIssues} from '../public/native-canvas-core.js';
import {cameraNodeText} from '../public/camera-angle-core.js';
import {nativeFlowPreview,nativeFlowOutputsFromJob,orderedNativeInputIds,nativeSmartGroupStoredMediaEnabled} from './native-flow.mjs';
import {userError} from './workspace.mjs';
import {isNativePrompt,nativePromptSettings,nativePromptItems,nativePromptLlmEnabled} from '../public/native-prompt-core.js';
import {isNativeLoop,nativeLoopSettings} from '../public/native-loop-core.js';
import {smartGroupMediaMembers} from '../public/smart-group-media-core.js';
import {nativeMediaVersion} from '../public/native-media-version.js';

const supportedIssues=new Set(['原生输出节点接收并展示整组生成结果尚待迁移','原生多素材节点向下游传递整组素材尚待迁移','原生提示词组的聚合语义尚待迁移','原生分组作为输入输出的聚合语义尚待迁移']);
const groups=new Set(['group','promptGroup','smart-group']);
const typeOf=node=>node.params?.nativeCanvas?.node.type||node.type;
const generationTypes=new Set(['generator','midjourney','msgen','comfy','ltxDirector','video','rh','minimax','smart-minimax','smart-image']);
// Private, read-only provenance for canvas edits. Normal execution retains
// its existing duplicate checks and its exact ledger shape.
const selectionSnapshot=Symbol('canvas-selection-snapshot');
export function nativeExecutionNodeIssues(node,project){return nativeNodeIssues(node,project).filter(issue=>!supportedIssues.has(issue));}
export function nativeExecutionDependencies(project,id){
 const node=project.nodes.find(n=>n.id===id);if(!node)throw userError('执行依赖节点不存在');
 const members=groups.has(typeOf(node))?(node.params.nativeCanvas.members||[]).map(ref=>ref.sourceNodeId).filter(id=>{
  const member=project.nodes.find(n=>n.id===id),type=typeOf(member);
  return typeOf(node)==='smart-group'?type!=='smart-group':typeOf(node)==='group'?['image','prompt','text','script'].includes(type)||!member.params?.nativeCanvas&&['image','video','audio'].includes(member.type):true;
 }):[];
 return[...new Set([...project.edges.filter(e=>e.target===id).map(e=>e.source),...members])];
}
export function nativeExecutionAncestors(project,id){const found=new Set(),visit=id=>{for(const parent of nativeExecutionDependencies(project,id))if(!found.has(parent)){found.add(parent);visit(parent);}};visit(id);return found;}
export function needsNativeFlow(project,node,parents=nativeExecutionAncestors(project,node.id),{simpleH3=true}={}){
 // Native H3 execution uses direct ordered inputs even without a group.
 // Archive classification can retain the older format for unchanged fields.
 if(simpleH3&&['minimax','smart-minimax'].includes(typeOf(node))&&(node.params?.workflowBinding?.minimaxH3||node.params?.cloudBinding?.minimaxH3))return true;
 if(isNativePrompt(node)&&nativePromptLlmEnabled(node))return true;
 if([...(node.params?.workflowBinding?.imageSources||[]),...(node.params?.studioBinding?.referenceSources||[]),...(node.params?.workflowBinding?.ltxDirector?.segments||[]),...(node.params?.workflowBinding?.ltxDirector?.audioSegments||[]),...(node.params?.workflowBinding?.minimaxH3?.refs||[]),...(node.params?.cloudBinding?.minimaxH3?.refs||[]),...(node.params?.workflowBinding?.minimaxH3?.segments||[]).flatMap(s=>s.refs||[]),...(node.params?.cloudBinding?.minimaxH3?.segments||[]).flatMap(s=>s.refs||[])].some(r=>r.sourceIndex!==undefined))return true;
 if((node.params?.imageBinding||node.params?.llmBinding||node.params?.studioBinding||node.params?.cloudBinding&&!node.params.cloudBinding.minimaxH3)&&project.nodes.some(n=>parents.has(n.id)&&n.params?.nativeCanvas))return true;
 return project.nodes.some(n=>parents.has(n.id)&&n.params?.nativeCanvas&&(groups.has(typeOf(n))||isNativeLoop(n)||typeOf(n)==='smart-prompt'||typeOf(n)==='output'||n.params.nativeCanvas.mediaAssetIds.length>1&&!n.params?.workflowBinding?.minimaxH3&&!n.params?.cloudBinding?.minimaxH3||n.params?.workflowBinding?.count>1||n.params?.workflowBinding?.promptBatch?.values?.length>1));
}
export function nativeExecutionText(project,node,{outputs=[],execution=false,planning=false,only=false,ownText=cameraNodeText(node),loopContexts={}}={}){
 if(only)return ownText.trim();
 const preview=nativeFlowPreview(project,{nodeId:node.id,outputs,execution,loopContexts,mediaVersion:nativeMediaVersion(project,node)}),input=preview.inputs;
 if(input.issues.length)throw userError('原生输入不能执行：'+input.issues.slice(0,5).join('；'));
 if(execution&&!planning&&input.pendingNodeIds.length)throw userError('原生输入的上游步骤尚未完整完成');
 const text=isNativePrompt(node)&&nativePromptLlmEnabled(node)?[...new Set(input.promptItems.map(s=>s.trim()).filter(Boolean)),nativePromptSettings(node).instruction.trim()||nativePromptItems(node).join('\n\n')].filter(Boolean).join('\n\n'):[...input.promptItems,ownText].map(s=>s.trim()).filter(Boolean).join('\n\n');
 if(!text&&planning&&input.pendingNodeIds.some(id=>['text','script'].includes(project.nodes.find(n=>n.id===id)?.type)))return'[等待上游完整文字结果]';
 return text;
}
export function nativeExecutionMedia(project,sourceNodeId,{outputs=[],execution=false,consumer='generator',loopContexts={},mediaVersion}={}){
 const value=nativeFlowPreview(project,{nodeId:sourceNodeId,outputs,execution,loopContexts,mediaVersion}).nodes[0];
 if(value.issues.length)throw userError('原生素材不能执行：'+value.issues.slice(0,5).join('；'));
 let media=value.media;
 if(value.type==='output'&&consumer!=='loop')media=consumer==='llm'?['image','video','audio'].flatMap(kind=>{const item=media.findLast(m=>m.kind===kind);return item?[item]:[];}):media.length?[media.at(-1)]:[];
 else if(consumer!=='llm'&&generationTypes.has(value.type))media=media.filter(item=>['rh','ltxDirector','video','minimax','smart-minimax','smart-image'].includes(value.type)?['image','video','audio'].includes(item.kind):item.kind==='image');
 return{...value,media};
}

// Keep the saved source mapping intact. Only this ephemeral plan contains the
// expanded files; execution resolves it again from completed child results.
export function nativeReferencePlan(project,node,references,{outputs=[],planning=false,consumer='generator',loopContexts={},h3Automatic=false,mediaVersion=nativeMediaVersion(project,node),[selectionSnapshot]:trackSelection=false}={}){
 const parents=nativeExecutionAncestors(project,node.id),byId=new Map(project.nodes.map(n=>[n.id,n]));
 const assets=new Map(project.assets.map(a=>[a.id,a])),assetKinds=new Map(project.assets.map(a=>[a.id,a.type.split('/')[0]]));
 const mediaKinds=new Set(['image','video','audio']);
 const checked=item=>{
  if(item.assetId&&!assets.has(item.assetId))throw userError('原生参考素材不属于当前项目');
  const kind=item.url?String(item.type||'image/png').split('/')[0]:assetKinds.get(item.assetId);
  if(h3Automatic&&!mediaKinds.has(kind))return null;
  if(!mediaKinds.has(kind))throw userError('原生参考素材必须是当前项目的图片、视频或音频');
  return{...item,kind,...(item.assetId?{name:assets.get(item.assetId).name}:{})};
 };
 const fromMedia=item=>checked({assetId:item.assetId,...(trackSelection?{selection:{sourceNodeId:item.sourceNodeId,sourceIndex:item.index}}:{}),...(outputs.some(output=>output.nodeId===item.sourceNodeId&&output.assetIds?.includes(item.assetId))?{producerNodeId:item.sourceNodeId}:{})});
 const pending=(source,{single=false}={})=>{
  if(!planning)throw userError('上游整组素材尚未完整生成，后续未提交');
  if(!mediaKinds.has(source.type))return[];
  const count=single?1:source.params?.workflowBinding?.count??source.params?.workflowBinding?.promptBatch?.values?.length??(source.params?.studioBinding?.mode==='image'?source.params.studioBinding.config?.count:1)??1;
  if(!Number.isSafeInteger(count)||count<1||count>64)throw userError('上游整组参考数量无效');
  return[{sourceNodeId:source.id,name:source.title,expectedCount:count,kind:source.type,pending:true}];
 };
 function resolve(id,mode=consumer){
  const source=byId.get(id),type=typeOf(source),value=nativeExecutionMedia(project,id,{outputs,execution:true,consumer:mode,loopContexts,mediaVersion});
  if(value.pendingNodeIds.includes(id))return pending(source);
  if(isNativeLoop(source)){
   if(!value.pendingNodeIds.length)return value.media.map(fromMedia).filter(Boolean);
   if(!planning)throw userError('原生循环的上游尚未完整生成');
   const settings=nativeLoopSettings(source),ctx=loopContexts[id]||{index:settings.start},all=orderedNativeInputIds(project,id).flatMap(parent=>resolve(parent,'loop')),slots=all.flatMap(item=>Array.from({length:item.pending?item.expectedCount:1},()=>({...item}))),slice=(values,size)=>values.slice(ctx.index-1,ctx.index-1+size);
   const selected=[...(settings.imageInput?slice(type==='smart-loop'?slots:slots.filter(item=>item.kind==='image'),settings.imageBatchSize):[]),...(type!=='smart-loop'&&settings.videoInput?slice(slots.filter(item=>item.kind==='video'),settings.videoBatchSize):[])],result=[];
   for(const item of selected){if(!item.pending){result.push(item);continue;}const prior=result.find(value=>value.pending&&value.sourceNodeId===item.sourceNodeId&&value.kind===item.kind);if(prior)prior.expectedCount++;else result.push({...item,expectedCount:1});}
   return result;
  }
  if(groups.has(type)){
   if(type==='promptGroup')return[];
   let members=(source.params.nativeCanvas.members||[]).map(r=>byId.get(r.sourceNodeId)).filter(member=>type==='smart-group'?typeOf(member)!=='smart-group':['image','prompt','text','script'].includes(typeOf(member))||!member.params?.nativeCanvas&&mediaKinds.has(member.type));
   // Ordinary group inputOrder can refer to individual original member IDs.
   const saved=(node.params?.nativeCanvas?.inputOrder||[]).filter(r=>r.sourceNodeId===id&&r.itemType==='group-media').sort((a,b)=>a.index-b.index);
   const rank=member=>{const index=saved.findIndex(r=>r.memberId===String(member.params?.nativeCanvas?.node.id??member.id));return index<0?saved.length:index;};
   members=members.map((member,index)=>({member,index})).sort((a,b)=>rank(a.member)-rank(b.member)||a.index-b.index).map(x=>x.member);
   const own=type==='smart-group'?value.media.filter(item=>item.sourceNodeId===id).map(fromMedia).filter(Boolean):[];
   if(type==='smart-group'&&nativeSmartGroupStoredMediaEnabled()&&mediaVersion===2)members=smartGroupMediaMembers(members);
   return [...own,...members.flatMap(member=>resolve(member.id,mode))];
  }
  if(type==='output'&&value.pendingNodeIds.length){
   if(!planning)throw userError('输出接收器的上游尚未完整生成');
   // The receiver appends only direct generation results. Pending ancestors
   // reached through another receiver remain dependencies, not new contents.
   const next=orderedNativeInputIds(project,id).filter(id=>value.pendingNodeIds.includes(id)).map(id=>byId.get(id)).filter(n=>generationTypes.has(typeOf(n))&&mediaKinds.has(n.type));
   if(!next.length)return value.media.map(fromMedia).filter(Boolean);
   if(mode==='loop')return[...value.media.map(fromMedia).filter(Boolean),...next.flatMap(source=>pending(source))];
   if(mode!=='llm')return pending(next.at(-1),{single:true});
   return ['image','video','audio'].flatMap(kind=>{const source=next.findLast(n=>n.type===kind);if(source)return pending(source,{single:true});return value.media.filter(m=>m.kind===kind).map(fromMedia).filter(Boolean);});
  }
  if(value.pendingNodeIds.length)throw userError('原生参考包含尚未支持的动态媒体来源');
  let media=value.media;
  if(mode==='generator'&&generationTypes.has(type)){
   const refs=(node.params?.nativeCanvas?.inputOrder||[]).filter(r=>r.sourceNodeId===id&&r.itemType==='generated').sort((a,b)=>a.index-b.index),ordered=[];
   for(const ref of refs){const item=media[ref.itemIndex],url=item&&(source.params?.nativeCanvas?.resources.find(r=>r.assetId===item.assetId)?.url||'/api/assets/'+item.assetId);if(item&&url===ref.itemUrl&&!ordered.includes(item))ordered.push(item);}
   media=[...ordered,...media.filter(item=>!ordered.includes(item))];
  }
  return media.map(fromMedia).filter(Boolean);
 }
 let expanded=[];
 for(const ref of references){
  if(ref.sourceNodeId){
   if(!parents.has(ref.sourceNodeId)||!byId.has(ref.sourceNodeId))throw userError('整组参考必须来自相连的上游节点');
   sourceIndexFields(ref);let values=resolve(ref.sourceNodeId);if(ref.sourceIndex!==undefined){const slots=values.flatMap(item=>item.pending?Array.from({length:item.expectedCount},()=>({...item,expectedCount:1})):[item]),selected=slots[ref.sourceIndex];if(!selected)throw userError('所选上游素材序号不存在');values=[selected];}if(!values.length&&!isNativeLoop(byId.get(ref.sourceNodeId)))throw userError('所选上游没有可用媒体参考');
   expanded.push(...values.map(value=>({...value,originNodeId:ref.sourceNodeId})));
  }else{sourceIndexFields(ref);const item=checked(ref);if(item)expanded.push(item);}
 }
 if(node.params?.nativeCanvas?.inputOrder?.length){
  const entries=nativeFlowPreview(project,{nodeId:node.id,outputs,execution:true,loopContexts,mediaVersion}).inputs.sources,ordered=[];
  for(const entry of entries){
   for(const media of entry.media){const item=expanded.find(item=>item.originNodeId===entry.sourceNodeId&&item.assetId===media.assetId);if(item&&!ordered.includes(item))ordered.push(item);}
   for(const item of expanded)if(item.pending&&item.originNodeId===entry.sourceNodeId&&entry.pendingNodeIds.includes(item.sourceNodeId)&&!ordered.includes(item))ordered.push(item);
  }
  expanded=[...ordered,...expanded.filter(item=>!ordered.includes(item))];
 }
 const used=new Set();for(const item of expanded){const key=item.assetId?'asset:'+item.assetId:item.url?'url:'+item.url:'node:'+item.sourceNodeId;if(!trackSelection&&!h3Automatic&&used.has(key))throw userError('整组参考包含重复素材或重叠来源，请重新选择；不会自动去重');used.add(key);}
 if(expanded.length>1000)throw userError('整组参考超过1000项');
 return{references:expanded.map(item=>item.assetId?{assetId:item.assetId}:item.url?{url:item.url,type:item.type||'image/png'}:{sourceNodeId:item.sourceNodeId,expectedCount:item.expectedCount}),kinds:[...new Set(expanded.map(item=>item.kind))],details:expanded};
}
export function nativeReferenceSelectionSlots(project,node,sourceNodeId,{consumer='generator',loopContexts={},mediaVersion=nativeMediaVersion(project,node)}={}){
 let plan;try{plan=nativeReferencePlan(project,node,[{sourceNodeId}],{planning:true,consumer,loopContexts,mediaVersion,[selectionSnapshot]:true});}catch(error){if(error.message==='所选上游没有可用媒体参考')return[];throw error;}
 return plan.details.flatMap(item=>item.pending?Array.from({length:item.expectedCount},(_,sourceIndex)=>({...item,expectedCount:1,selection:{sourceNodeId:item.sourceNodeId,sourceIndex}})):[item]);
}
export function selectNativeExecutionMedia(value,sourceIndex,{planning=false}={}){
 if(sourceIndex!==undefined&&(!Number.isSafeInteger(sourceIndex)||sourceIndex<0||sourceIndex>999))throw userError('素材序号须为0–999的整数');
 if(value.pendingNodeIds.length){if(planning)return null;throw userError('上游素材尚未完整生成');}
 if(sourceIndex===undefined&&value.media.length>1)throw userError('上游包含多份素材，请为该工作流字段明确选择素材序号');
 const selected=value.media[sourceIndex??0];if(!selected)throw userError('所选上游素材序号不存在');return selected;
}
export function nativeStepOutputs(project,job,step){
 const actual=new Map(nativeFlowOutputsFromJob(project,job).map(value=>[value.nodeId,value]));
 if(step.loopId)for(const value of nativeFlowOutputsFromJob(project,job,{loopId:step.loopId,roundIndex:step.roundIndex}))actual.set(value.nodeId,value);
 return[...actual.values()];
}
