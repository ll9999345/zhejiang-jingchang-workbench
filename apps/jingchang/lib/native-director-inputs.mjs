import {nativeProducerIndices} from './native-producer-slots.mjs';
import {nativeMediaVersion} from '../public/native-media-version.js';
import {nativeReferencePlan,nativeExecutionMedia} from './native-flow-execution.mjs';
import {orderedNativeInputIds} from './native-flow.mjs';
import {normalizeMinimaxTimeline,selectedMinimaxSegment,normalizeMinimaxRefs,minimaxLimits} from '../public/minimax-h3-core.js';
import {normalizeLtxTimeline} from '../public/ltx-director-core.js';
import {sourceIndexFields} from '../public/source-index-core.js';
import {userError} from './workspace.mjs';

function slots(details){return details.flatMap(item=>{if(!item.pending)return[item];return nativeProducerIndices(item).map(index=>{const out={...item,expectedCount:1,producerIndex:index};delete out.producerIndices;return out;});});}
function wire(item){return item.assetId?{assetId:item.assetId}:{sourceNodeId:item.sourceNodeId,sourceIndex:item.producerIndex};}
export function nativeScalarReference(project,node,ref,kind,options={}){
 if(!ref||typeof ref!=='object'||Array.isArray(ref))throw userError('导演或增强输入需要选择项目素材或上游节点');
 try{sourceIndexFields(ref);}catch(e){throw userError(e.message);}
 const plan=nativeReferencePlan(project,node,[ref],{...options,consumer:'loop'}),items=slots(plan.details);
 if(ref.sourceIndex===undefined&&items.length>1)throw userError('上游包含多份素材，请明确选择素材序号；不会自动取第一项');
 const selected=items[0];
 if(!selected)throw userError('所选上游素材序号不存在');
 if(selected.kind!==kind)throw userError('所选素材条目与导演或增强输入类型不匹配');
 return{reference:wire(selected),details:[selected]};
}

export function selectH3AutomaticReferences(details,policy='smart'){
 if(!['smart','ordinary'].includes(policy))throw userError('H3 自动参考规则无效');
 const seen=new Set(),unique=[];let duplicates=0;
 for(const item of details){if(!Object.hasOwn(minimaxLimits,item.kind))continue;const key=item.kind+':'+(item.assetId?'asset:'+item.assetId:'node:'+item.sourceNodeId+':'+item.producerIndex);if(seen.has(key)){duplicates++;continue;}seen.add(key);unique.push(item);}
 const selected=policy==='ordinary'?unique.slice(0,15):['image','video','audio'].flatMap(kind=>unique.filter(item=>item.kind===kind).slice(0,minimaxLimits[kind]));
 return{policy,candidates:details,details:selected,duplicates,excluded:unique.length-selected.length};
}
function h3AutoReferences(project,node,options,kinds=['image','video','audio']){
 const ids=orderedNativeInputIds(project,node.id).filter(id=>{
  const value=nativeExecutionMedia(project,id,{mediaVersion:nativeMediaVersion(project,node),...options,execution:true,consumer:'loop'});
  return value.media.length||value.pendingNodeIds.some(id=>['image','video','audio'].includes(project.nodes.find(n=>n.id===id)?.type));
 });
 const automatic=options.h3Automatic!==false,all=ids.length?slots(nativeReferencePlan(project,node,ids.map(sourceNodeId=>({sourceNodeId})),{...options,consumer:'loop',h3Automatic:automatic}).details):[],details=all.filter(item=>kinds.includes(item.kind));
 if(!automatic)return{details};
 return selectH3AutomaticReferences(details,node.params?.nativeCanvas?.node.type==='minimax'?'ordinary':'smart');
}
export function prepareNativeH3(project,node,input,options={}){
 const original=normalizeMinimaxTimeline(input),timeline=structuredClone(original),segment=selectedMinimaxSegment(timeline);
 const useAuto=original.autoUpstream&&!segment.refs.length&&(original.fallbackByKind?['image','video','audio'].some(kind=>!original.refs.some(ref=>ref.kind===kind)):!original.refs.length);
 const inheritedKinds=original.fallbackByKind?['image','video','audio'].filter(kind=>!original.refs.some(ref=>ref.kind===kind)):['image','video','audio'];
 const automatic=useAuto?h3AutoReferences(project,node,options,inheritedKinds):null,fallback=automatic?.details||[];
 const explicit=refs=>refs.flatMap(ref=>nativeScalarReference(project,node,ref,ref.kind,options).details);
 const details=segment.refs.length?explicit(segment.refs):original.fallbackByKind?['image','video','audio'].flatMap(kind=>original.refs.some(r=>r.kind===kind)?explicit(original.refs.filter(r=>r.kind===kind)):fallback.filter(r=>r.kind===kind)):original.refs.length?explicit(original.refs):fallback;
 // Only the execution copy expands sources; the editable timeline and its
 // attachment signature remain the original normalized data.
 timeline.refs=[];if(original.autoUpstream&&!segment.prompt.trim()&&typeof options.text==='string')segment.prompt=options.text.trim();timeline.autoUpstream=false;segment.refs=normalizeMinimaxRefs(details.map(item=>({kind:item.kind,...wire(item)})));
 return{original,timeline,ledger:{version:automatic?.policy?2:1,kind:'h3',details,...(automatic?.policy?{automatic:{...automatic,candidates:original.fallbackByKind?automatic.candidates.filter(item=>!original.refs.some(ref=>ref.kind===item.kind)):automatic.candidates}}:{})}};
}
export function prepareNativeLtx(project,node,input,options={}){
 const original=normalizeLtxTimeline(input),timeline=structuredClone(original),details=[];
 for(const track of ['segments','audioSegments'])for(const segment of timeline[track]){
  if(segment.type==='text')continue;
  const selected=nativeScalarReference(project,node,segment,segment.type,options);
  details.push(...selected.details.map(item=>({...item,slot:track+':'+segment.id})));
  delete segment.assetId;delete segment.sourceNodeId;delete segment.sourceIndex;Object.assign(segment,selected.reference);
 }
 return{original,timeline,ledger:{version:1,kind:'ltx',details}};
}
export function prepareNativeEnhancement(project,node,source,options={}){
 const selected=nativeScalarReference(project,node,source,'image',options);
 return{source:selected.reference,ledger:{version:1,kind:'enhance',details:selected.details}};
}

export function verifyDirectorInputs(expected,actual,outputs=[]){
 if(![1,2].includes(expected?.version)||expected.kind!==actual?.kind||!Array.isArray(expected.details))throw userError('导演素材检查版本无效');
 if(expected.version===2){
  if(expected.kind!=='h3'||!expected.automatic||expected.automatic.policy!==actual.automatic?.policy||!Array.isArray(expected.automatic.candidates)||!Array.isArray(actual.automatic.candidates))throw userError('H3 自动参考规则与原确认不一致');
  verifyDirectorInputs({version:1,kind:'h3',details:expected.automatic.candidates},{version:1,kind:'h3',details:actual.automatic.candidates},outputs);
 }
 const remaining=expected.details.map(item=>({...item,remaining:1}));
 for(const item of actual.details){
  const sameScope=e=>(e.originNodeId||'')===(item.originNodeId||'')&&(e.slot||'')===(item.slot||'')&&e.kind===item.kind&&e.remaining>0;
  const fixed=remaining.find(e=>!e.pending&&sameScope(e)&&e.assetId===item.assetId);
  const generated=fixed?null:remaining.find(e=>e.pending&&sameScope(e)&&e.sourceNodeId===item.producerNodeId&&outputs.some(output=>output.nodeId===e.sourceNodeId&&output.assetIds?.[e.producerIndex]===item.assetId));
  if(!fixed&&!generated)throw userError('实际导演素材与已确认的文件、数量或生成来源不一致，后续未提交');
  (fixed||generated).remaining--;
 }
}
export function resolveNativeDirectorStep(project,step,outputs=[]){
 if(!step.nativeDirectorInputs)return step;
 const node=project.nodes.find(n=>n.id===step.nodeId),options={outputs,loopContexts:step.nativeLoop?.contexts,text:step.text,h3Automatic:step.nativeDirectorInputs.version===2};let prepared;
 if(step.minimaxH3)prepared=prepareNativeH3(project,node,step.minimaxH3,options);
 else if(step.ltxDirector)prepared=prepareNativeLtx(project,node,step.ltxDirector,options);
 else if(step.imageEnhance)prepared=prepareNativeEnhancement(project,node,step.enhanceSource,options);
 else throw userError('导演素材执行方式无效');
 verifyDirectorInputs(step.nativeDirectorInputs,prepared.ledger,outputs);
 return{...step,...(step.minimaxH3?{minimaxH3:prepared.timeline,minimaxUpstreamRefs:[]}:step.ltxDirector?{ltxDirector:prepared.timeline}:{enhanceSourceId:prepared.source.assetId}),resolvedDirectorInputs:prepared.ledger.details};
}
