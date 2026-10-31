import {nativeProducerIndices} from './native-producer-slots.mjs';
import {prepareNativeEnhancement} from './native-director-inputs.mjs';
import {nativeReferencePlan,nativeExecutionAncestors} from './native-flow-execution.mjs';
import {appendPromptAssetSources} from './prompt-assets.mjs';
import {imageStep} from './canvas-images.mjs';
import {llmStep} from './canvas-llm.mjs';
import {studioStep} from './canvas-studio.mjs';
import {userError} from './workspace.mjs';

const adapters={
 'image-api':{key:'image',plan:imageStep,consumer:'generator'},
 'canvas-llm':{key:'llm',plan:llmStep,consumer:'llm'},
 studio:{key:'studio',plan:studioStep,consumer:'generator'}
};

export async function planNativeApiStep(kind,args){
 const adapter=adapters[kind];if(!adapter)throw userError('此接口尚未接入整组素材');
 const enhancement=args.binding.imageEnhance?prepareNativeEnhancement(args.project,args.node,args.binding.referenceSources[0],{planning:true,loopContexts:args.loopContexts}):null;
 const references=appendPromptAssetSources(args.binding.referenceSources,args.promptReferences||[]);
 const plan=nativeReferencePlan(args.project,args.node,references,{planning:true,consumer:adapter.consumer,loopContexts:args.loopContexts});
 const step=await adapter.plan({...args,nativeReferences:plan.references});
 return{...step,...(enhancement?{nativeDirectorInputs:enhancement.ledger}:{}),nativeReferences:{version:1,kinds:plan.kinds,details:plan.details}};
}

export async function resolveNativeApiStep(data,project,step,outputs=[]){
 if(!step.nativeReferences)return step;
 const adapter=adapters[step.kind];if(!adapter||step.nativeReferences.version!==1)throw userError('整组接口任务版本不支持');
 const node=project.nodes.find(n=>n.id===step.nodeId),binding=step[adapter.key];
 const plan=nativeReferencePlan(project,node,binding.referenceSources,{outputs,consumer:adapter.consumer,loopContexts:step.nativeLoop?.contexts});
 if(plan.kinds.some(kind=>!step.nativeReferences.kinds.includes(kind)))throw userError('上游实际输出新增了未确认的媒体类型，后续未提交；请重新检查发送范围');
 const confirmed=step.nativeReferences.details.map(item=>({...item,remaining:item.pending===true?item.expectedCount:1,...(item.pending?{allowedProducerIndices:nativeProducerIndices(item)}:{})}));
 if(confirmed.some(item=>!Number.isSafeInteger(item.remaining)||item.remaining<1||item.remaining>64))throw userError('整组素材的已确认数量无效，请重新检查运行计划');
 const sameScope=(expected,item)=>(expected.originNodeId||'')===(item.originNodeId||'')&&expected.kind===item.kind;
 for(const item of plan.details){
  // Static files and URLs are exact selections. A newly generated item must
  // consume its own producer's allowance, never a same-kind historical slot.
  const fixed=confirmed.find(expected=>expected.pending!==true&&sameScope(expected,item)&&(item.assetId?expected.assetId===item.assetId:!!item.url&&expected.url===item.url));
  const generated=fixed?null:confirmed.find(expected=>expected.pending===true&&sameScope(expected,item)&&expected.sourceNodeId===item.producerNodeId&&outputs.some(output=>output.nodeId===expected.sourceNodeId&&expected.allowedProducerIndices.some(index=>output.assetIds?.[index]===item.assetId)));
  const allowance=fixed||generated;
  if(!allowance&&confirmed.some(expected=>expected.pending&&expected.producerIndices===undefined&&sameScope(expected,item)&&expected.sourceNodeId===item.producerNodeId&&outputs.some(output=>output.nodeId===expected.sourceNodeId&&output.assetIds?.indexOf(item.assetId)>=expected.expectedCount)))throw userError('上游实际整组数量超过已确认范围，后续未提交；已保留全部上游结果');
  if(!allowance)throw userError('实际参考素材与已确认的固定文件或生成来源不一致，后续未提交；请重新检查发送范围');
  if(--allowance.remaining<0)throw userError('上游实际整组数量超过已确认范围，后续未提交；已保留全部上游结果');
 }
 if(plan.references.length&&step.authorization?.sendReferences!==true)throw userError('整组素材缺少发送授权，后续未提交');
 const fresh=await adapter.plan({data,project,node:{...node,text:step.text},binding:{...binding,referenceSources:plan.references},parents:nativeExecutionAncestors(project,node.id),text:step.text});
 if(fresh.sendNativeVideo&&step.authorization?.sendNativeVideo!==true||fresh.sendOriginalMedia&&step.authorization?.sendOriginalMedia!==true)throw userError('整组素材缺少原视频或音频发送范围授权，后续未提交');
 // Retain the originally confirmed static video samples / Ark fingerprints.
 // Services will revalidate those bytes and prepare newly generated media.
 return{...step,[adapter.key]:fresh[adapter.key],resolvedReferences:plan.details};
}
