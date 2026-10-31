import {createHash} from 'node:crypto';
import {safeId,userError,assertNoCredentials} from './workspace.mjs';
import {nativeLoopSettings} from '../public/native-loop-core.js';

const record=node=>node?.params?.nativeCanvas?.node||{};
const type=node=>record(node).type||node?.type;
const identity=url=>createHash('sha256').update(url).digest('hex');
const mediaKinds=new Set(['image','video','audio','text','file']);

// Media identities refer to already imported local assets. Original URLs are
// hashed for the source's URL-based deduplication; they are never fetched here.
export function normalizeCascadeRefs(refs){
 if(!Array.isArray(refs)||refs.length>1000)throw userError('智能串联素材结果须为最多1000份的数组');
 assertNoCredentials(refs);
 return refs.map(ref=>{
  if(!ref||!safeId(ref.assetId)||!mediaKinds.has(ref.kind)||typeof ref.name!=='string'||ref.name.length>4096
   ||ref.identity!==undefined&&!/^[a-f0-9]{64}$/.test(ref.identity)
   ||ref.originalNodeId!==undefined&&(typeof ref.originalNodeId!=='string'||ref.originalNodeId.length>1000)
   ||ref.imageIndex!==undefined&&(!Number.isFinite(ref.imageIndex)||Math.abs(ref.imageIndex)>1000000))throw userError('智能串联素材结果格式无效');
  return{assetId:ref.assetId,kind:ref.kind,name:ref.name,identity:ref.identity||identity('/api/assets/'+ref.assetId),
   ...(ref.originalNodeId!==undefined?{originalNodeId:ref.originalNodeId}:{}),...(ref.imageIndex!==undefined?{imageIndex:ref.imageIndex}:{})};
 });
}
export const stripCascadeRefs=refs=>normalizeCascadeRefs(refs).map(({assetId,kind,name,identity})=>({assetId,kind,name,identity}));
export function uniqueCascadeRefs(refs,{limit=1000,withKind=false}={}){
 if(!Array.isArray(refs)||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw userError('智能串联素材去重范围无效');
 const seen=new Set(),result=[];
 // A group may contain more than 1000 candidates. The source selects the
 // first twenty unique URLs rather than rejecting the entire group first.
 for(const item of refs){const ref=normalizeCascadeRefs([item])[0],key=(withKind?ref.kind+'|':'')+ref.identity;
  if(seen.has(key))continue;seen.add(key);result.push(ref);if(result.length===limit)break;
 }
 return result;
}

export function cascadeReferenceResolver(project,{round,nodeOutputs={},receivers={}}){
 const nodes=new Map(project.nodes.map(node=>[node.id,node])),assets=new Map(project.assets.map(asset=>[asset.id,asset]));
 const resources=project.nodes.flatMap(node=>node.params?.nativeCanvas?.resources||[]);
 const ownId=node=>String(record(node).id??node.id);
 const inputs=(node,kinds=['input'])=>[...new Set(project.edges.filter(edge=>edge.target===node.id&&kinds.includes(edge.nativeCanvasConnection?.kind||'flow')).map(edge=>edge.source))].map(id=>nodes.get(id));
 const groupMembers=node=>[...new Set((node.params?.nativeCanvas?.members||[]).map(ref=>ref.sourceNodeId))].map(id=>nodes.get(id)).filter(member=>member&&member.id!==node.id&&type(member)!=='smart-group');
 function imported(node,item,index){
  const url=typeof item==='string'?item:item?.url;if(!url)return null;
  if(typeof url!=='string'||url.length>12000000)throw userError('智能串联原素材地址无效');
  const resource=(node.params?.nativeCanvas?.resources||[]).find(ref=>[ref.url,ref.archive,'./'+ref.archive].includes(url))
   ||resources.find(ref=>[ref.url,ref.archive,'./'+ref.archive].includes(url));
  const asset=resource&&assets.get(resource.assetId);
  if(!asset)throw userError('智能串联引用的原素材尚未导入本机，请先替换缺失素材');
  const prefix=asset.type.split('/')[0],kind=mediaKinds.has(prefix)?prefix:'file';
  return{assetId:asset.id,kind,name:typeof item==='object'&&item.name||asset.name,identity:identity(url),originalNodeId:ownId(node),imageIndex:index};
 }
 function stored(node){
  if(!node)throw userError('智能串联素材节点不存在');
  const current=receivers[node.id]?.currentRefs;
  if(current)return stripCascadeRefs(current).map((ref,imageIndex)=>({...ref,originalNodeId:ownId(node),imageIndex}));
  const raw=record(node),items=Array.isArray(raw.images)?raw.images:type(node)==='image'&&raw.url?[raw.url]:[];
  const result=items.map((item,index)=>imported(node,item,index)).filter(Boolean);
  if(!node.params?.nativeCanvas&&node.assetId){const asset=assets.get(node.assetId);if(asset)result.push({assetId:asset.id,kind:asset.type.split('/')[0],name:asset.name,identity:identity('/api/assets/'+asset.id),originalNodeId:node.id,imageIndex:0});}
  return normalizeCascadeRefs(result);
 }
 function images(node){
  if(type(node)!=='smart-group')return stored(node);
  const members=groupMembers(node).filter(member=>type(member)==='smart-image').sort((a,b)=>Math.abs(a.y-b.y)>24?a.y-b.y:a.x-b.x);
  return[...stored(node),...members.flatMap(stored)];
 }
 function loopInput(node,visiting=new Set()){
  if(visiting.has(node.id))throw userError('智能循环媒体输入形成循环依赖');
  const settings=nativeLoopSettings(node);if(!settings.imageInput)return[];
  const next=new Set(visiting).add(node.id),refs=inputs(node).flatMap(input=>type(input)==='smart-loop'?loopInput(input,next):images(input));
  const index=round.index||settings.start;
  return refs.slice(index-1,index-1+settings.imageBatchSize);
 }
 function output(nodeId){
  const node=nodes.get(nodeId);if(!node)throw userError('智能串联素材节点不存在');
  if(type(node)==='smart-loop')return loopInput(node);
  if(type(node)==='smart-group')return images(node);
  if(Object.hasOwn(nodeOutputs,nodeId))return normalizeCascadeRefs(nodeOutputs[nodeId]);
  return images(node);
 }
 function defaultRefs(nodeId){
  const node=nodes.get(nodeId);if(!node)throw userError('智能串联请求节点不存在');
  const self=output(nodeId),workflow=type(node)==='smart-image'&&round.forceWorkflow;
  const upstream=inputs(node,workflow?['input','flow']:['input']).flatMap(input=>output(input.id));
  const manual=(Array.isArray(record(node).manualInputRefs)?record(node).manualInputRefs:[]).map((item,index)=>{
   const ref=imported(node,item,index);if(!ref)return null;
   if(item.nodeId!==undefined)ref.originalNodeId=String(item.nodeId);else delete ref.originalNodeId;
   ref.imageIndex=Number.isFinite(Number(item.imageIndex))?Number(item.imageIndex):index;return ref;
  }).filter(Boolean);
  return uniqueCascadeRefs([...(workflow?[]:self),...upstream,...manual],{limit:20});
 }
 function blocked(nodeId,refs){
  const node=nodes.get(nodeId);if(!node)throw userError('智能串联请求节点不存在');
  const excluded=new Set(Array.isArray(record(node).blockedInputRefs)?record(node).blockedInputRefs:[]),urlKeys=new Set([...excluded].filter(key=>typeof key==='string'&&key.startsWith('url|')).map(key=>identity(key.slice(4))));
  return refs.filter(ref=>ref.originalNodeId&&Number.isFinite(ref.imageIndex)?!excluded.has(ref.originalNodeId+'|'+ref.imageIndex):!urlKeys.has(ref.identity));
 }
 function handle(reference,operationOutputs){
  if(reference.kind==='operation-output'){
   if(!Object.hasOwn(operationOutputs,reference.operationId))throw userError('智能串联上一步尚未完整完成');
   return normalizeCascadeRefs(operationOutputs[reference.operationId]);
  }
  if(reference.kind==='node-output'||reference.kind==='loop-input')return output(reference.nodeId);
  if(reference.kind==='default')return defaultRefs(reference.nodeId);
  if(reference.kind==='self-default-incoming'){
   const self=reference.selfNodeId?output(reference.selfNodeId):[],source=self.length?self:defaultRefs(reference.defaultNodeId);
   return source.length?source:handle(reference.incoming,operationOutputs);
  }
  throw userError('智能串联素材引用清单无效');
 }
 return{output,stored:nodeId=>stored(nodes.get(nodeId)),defaultRefs,filterBlockedRefs:(nodeId,refs)=>blocked(nodeId,refs),referenceForItem:(nodeId,item,index=0)=>{const node=nodes.get(nodeId);if(!node)throw userError('智能串联引用节点不存在');return imported(node,item,index);},resolve:(reference,operationOutputs={})=>handle(reference,operationOutputs),
  forRequest:(operation,operationOutputs={})=>uniqueCascadeRefs(blocked(operation.requestNodeId,handle(operation.references,operationOutputs)),{limit:20})};
}
