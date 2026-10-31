import {validateProject} from './model.mjs';
import {assertNoCredentials,safeId,userError} from './workspace.mjs';
import {isNativePrompt,nativePromptItems,nativePromptSettings,nativePromptLlmEnabled} from '../public/native-prompt-core.js';
import {nativeLoopSettings,nativeLoopLocalPromptFields} from '../public/native-loop-core.js';
import {smartGroupMediaMembers} from '../public/smart-group-media-core.js';
import {nativeMediaVersion,checkedNativeMediaVersion} from '../public/native-media-version.js';

// Resolve source values without changing a canvas or submitting a model job.
// Execution integration must wait for every pending dependency before using
// these values; a stored preview is never proof of a new generation result.
export const NATIVE_FLOW_VERSION=1;
let smartGroupStoredMedia=true;
export function configureNativeSmartGroupStoredMedia(enabled){smartGroupStoredMedia=enabled===true;}
export const nativeSmartGroupStoredMediaEnabled=()=>smartGroupStoredMedia;
const generatedTypes=new Set(['generator','midjourney','msgen','comfy','ltxDirector','video','rh','minimax','smart-minimax','smart-image']);
const groupTypes=new Set(['group','promptGroup','smart-group']);
const mediaKinds=new Set(['image','video','audio']);
const sourceType=node=>node.params?.nativeCanvas?.node?.type||node.type;
const sourceRecord=node=>node.params?.nativeCanvas?.node||{};
const itemUrl=item=>typeof item==='string'?item:typeof item?.url==='string'?item.url:'';
const trimmed=value=>String(value??'').trim();
const unique=values=>[...new Set(values)];
const ordinaryGroupMember=node=>['image','prompt','text','script'].includes(sourceType(node))||!node.params?.nativeCanvas&&mediaKinds.has(node.type);

export function nativeFlowDependencyOrder(project){
 validateProject(project);
 const nodes=new Map(project.nodes.map(n=>[n.id,n])),visited=new Set(),visiting=new Set(),order=[];
 function visit(id){
  if(visited.has(id))return;
  if(visiting.has(id))throw userError('原生分组成员与连线形成循环依赖');
  visiting.add(id);const node=nodes.get(id);
  const children=groupTypes.has(sourceType(node))?(node.params.nativeCanvas.members||[]).map(ref=>ref.sourceNodeId).filter(child=>sourceType(node)==='smart-group'?sourceType(nodes.get(child))!=='smart-group':sourceType(node)==='group'?ordinaryGroupMember(nodes.get(child)):true):[];
  for(const dependency of unique([...orderedNativeInputIds(project,id),...children]))visit(dependency);
  visiting.delete(id);visited.add(id);order.push(id);
 }
 for(const id of nodes.keys())visit(id);
 return order;
}

export function splitNativePrompt(text,{enabled=false,separator=';'}={}){
 const value=trimmed(text);
 if(!value)return [];
 if(!enabled)return [value];
 const delimiter=separator===''?';':separator;
 if(typeof delimiter!=='string'||delimiter.length>8)throw userError('原生提示词分隔符最多8个字符');
 const parts=value.split(delimiter).map(trimmed).filter(Boolean);
 return parts.length>1?parts:[value];
}

export function orderedNativeInputIds(project,nodeId){
 const node=project.nodes.find(n=>n.id===nodeId);
 if(!node)throw userError('原生数据流节点不存在');
 const connected=unique(project.edges.filter(e=>e.target===nodeId).map(e=>e.source));
 const saved=(node.params?.nativeCanvas?.inputOrder||[]).slice().sort((a,b)=>a.index-b.index).map(r=>r.sourceNodeId);
 return unique([...saved.filter(id=>connected.includes(id)),...connected]);
}

function sourceInteger(value,fallback,label,{max=Number.MAX_SAFE_INTEGER}={}){
 const number=Number(value||fallback);
 if(!Number.isFinite(number)||!Number.isSafeInteger(number))throw userError(label+'须为整数');
 return Math.max(1,Math.min(max,number));
}

function declaredGeneration(node){
 if(isNativePrompt(node)&&!nativePromptLlmEnabled(node))return false;
 return ['workflowBinding','cloudBinding','imageBinding','llmBinding','studioBinding'].some(key=>node.params?.[key]);
}

function normalizeOutputs(project,outputs){
 if(!Array.isArray(outputs)||outputs.length>1500)throw userError('原生数据流结果集合无效');
 const nodes=new Set(project.nodes.map(n=>n.id)),assets=new Map(project.assets.map(a=>[a.id,a])),map=new Map();
 for(const output of outputs){
  if(!output||!nodes.has(output.nodeId)||map.has(output.nodeId)||!Array.isArray(output.assetIds)||output.assetIds.length>1000||!Array.isArray(output.promptItems)||output.promptItems.length>1000||output.promptItems.some(text=>typeof text!=='string'||text.length>200000)||output.assetIds.some(id=>!safeId(id)||!assets.has(id)))throw userError('原生数据流结果必须属于当前节点及项目素材');
  map.set(output.nodeId,{assetIds:[...output.assetIds],promptItems:output.promptItems.map(trimmed).filter(Boolean)});
 }
 return map;
}

export function nativeFlowPreview(project,{nodeId,outputs=[],execution=false,loopContexts={},mediaVersion}={}){
 validateProject(project);assertNoCredentials(project);assertNoCredentials(outputs);
 if(typeof execution!=='boolean'||!loopContexts||Array.isArray(loopContexts)||typeof loopContexts!=='object')throw userError('原生数据流上下文无效');
 if(nodeId!==undefined&&(!safeId(nodeId)||!project.nodes.some(n=>n.id===nodeId)))throw userError('原生数据流节点不存在');
 const dependencyOrder=nativeFlowDependencyOrder(project);
 const nodes=new Map(project.nodes.map(n=>[n.id,n])),assets=new Map(project.assets.map(a=>[a.id,a])),actual=normalizeOutputs(project,outputs),memo=new Map(),visiting=new Set();
 const completeMedia=smartGroupStoredMedia&&checkedNativeMediaVersion(mediaVersion??nativeMediaVersion(project,nodeId?nodes.get(nodeId):null))===2;
 for(const [id,ctx]of Object.entries(loopContexts))if(!nodes.has(id)||!['loop','smart-loop'].includes(sourceType(nodes.get(id)))||!ctx||!Number.isSafeInteger(ctx.index)||ctx.index<1||ctx.index>19899||ctx.total!==undefined&&(!Number.isSafeInteger(ctx.total)||ctx.total<1||ctx.total>19899))throw userError('原生循环上下文须使用有效节点、计数及总数');
 const media=(id,origin,index)=>{
  const asset=assets.get(id),prefix=asset?.type?.split('/')[0],kind=mediaKinds.has(prefix)?prefix:prefix==='text'?'text':'file';
  if(!asset)throw userError('原生数据流素材不属于当前项目');
  return {assetId:id,kind,sourceNodeId:origin,index,name:asset.name};
 };
 const storedMedia=node=>{
  const native=node.params?.nativeCanvas,raw=sourceRecord(node),type=sourceType(node);
  if(!native)return node.assetId?[media(node.assetId,node.id,0)]:[];
  if(native.adaptation==='configured'&&(node.params?.workflowBinding?.minimaxH3||node.params?.cloudBinding?.minimaxH3)&&node.assetId)return[media(node.assetId,node.id,0)];
  const rawItems=type==='image'&&raw.url?[raw.url]:['smart-image','smart-group','output'].includes(type)?raw.images||[]:generatedTypes.has(type)?raw.generatedOutputs||raw.images||[]:[];
  if(!Array.isArray(rawItems))throw userError('原生素材数组无效');
  const result=[];
  for(const [index,item]of rawItems.entries()){
   const url=itemUrl(item);if(!url)continue;
   const mapping=native.resources.find(r=>r.url===url||r.archive===url||'./'+r.archive===url);
   if(mapping)result.push(media(mapping.assetId,node.id,index));
  }
  // Legacy references may have only the portable asset list. Never treat the
  // first node's unreferenced document resources as its own media outputs.
  if(!rawItems.length)for(const [index,id]of native.mediaAssetIds.entries())result.push(media(id,node.id,index));
  return result;
 };
 const combine=values=>({promptItems:values.flatMap(v=>v.promptItems),media:values.flatMap(v=>v.media),pendingNodeIds:unique(values.flatMap(v=>v.pendingNodeIds)),issues:unique(values.flatMap(v=>v.issues))});
 function members(node){
  return (node.params?.nativeCanvas?.members||[]).map(ref=>nodes.get(ref.sourceNodeId)).filter(member=>{
   if(!member)throw userError('原生分组成员缺失');
   // Fixed smart-canvas explicitly ignores nested smart groups.
   return sourceType(node)!=='smart-group'||sourceType(member)!=='smart-group';
  });
 }
 function inputValues(node,consumer){
  const entries=unique(project.edges.filter(edge=>edge.target===node.id).map(edge=>edge.source)).flatMap(id=>{
   const from=nodes.get(id),type=sourceType(from),value=resolve(id),next={...value,promptItems:[...value.promptItems],media:[...value.media]};
   if(consumer==='smart'&&!['smart-prompt','smart-loop','smart-group','text','script'].includes(type))next.promptItems=[];
   if(consumer==='llm'&&type==='group')next.promptItems=[];
   if(consumer==='loop'&&!['prompt','promptGroup','loop','llm','text','script'].includes(type))next.promptItems=[];
   // In ordinary canvas the output receiver keeps the whole history, while
   // generatorSources chooses its newest item as the next reference.
   if(consumer==='generator'&&type==='output')next.media=next.media.length?[next.media.at(-1)]:[];
   if(consumer==='llm'&&type==='output')next.media=['image','video','audio'].flatMap(kind=>{const found=next.media.findLast(item=>item.kind===kind);return found?[found]:[];});
   const tagged=(item,details={})=>({...item,sourceNodeId:id,...details});
   if(consumer==='generator'&&type==='group')return[...next.media.map(item=>tagged({...next,promptItems:[],media:[item]},{itemType:'group-media',memberId:String(sourceRecord(nodes.get(item.sourceNodeId)).id??item.sourceNodeId)})),...(next.promptItems.length?[tagged({...next,promptItems:[next.promptItems.join('\n\n')],media:[]},{itemType:'group-prompts'})]:[])];
   if(consumer==='generator'&&generatedTypes.has(type)&&next.media.length)return next.media.filter(item=>['rh','ltxDirector','video','minimax','smart-minimax'].includes(type)?mediaKinds.has(item.kind):item.kind==='image').map((item,index)=>tagged({...next,promptItems:[],media:[item]},{itemType:'generated',itemIndex:index,itemUrl:from.params?.nativeCanvas?.resources.find(r=>r.assetId===item.assetId)?.url||'/api/assets/'+item.assetId}));
   if(consumer==='generator'&&type==='promptGroup')next.promptItems=next.promptItems.length?[next.promptItems.join('\n\n')]:[];
   return[tagged(next)];
  });
  const saved=(node.params?.nativeCanvas?.inputOrder||[]).slice().sort((a,b)=>a.index-b.index),ordered=[];
  for(const ref of saved){
   if(ref.itemType&&!['generated','group-media','group-prompts'].includes(ref.itemType)||ref.itemType==='generated'&&(!Number.isSafeInteger(ref.itemIndex)||ref.itemIndex<0||ref.itemIndex>999||typeof ref.itemUrl!=='string'||ref.itemUrl.length>12000000)||ref.itemType==='group-media'&&typeof ref.memberId!=='string')throw userError('原生素材条目次序无效');
   const matches=entries.filter(entry=>entry.sourceNodeId===ref.sourceNodeId&&(consumer!=='generator'||entry.itemType===ref.itemType&&(ref.itemType==='generated'?entry.itemIndex===ref.itemIndex&&entry.itemUrl===ref.itemUrl:ref.itemType==='group-media'?entry.memberId===ref.memberId:true)));
   for(const entry of matches)if(!ordered.includes(entry))ordered.push(entry);
  }
  for(const entry of entries)if(!ordered.includes(entry))ordered.push(entry);
  return ordered;
 }
 function resolve(id){
  if(memo.has(id))return memo.get(id);
  if(visiting.has(id))throw userError('原生分组成员与连线形成循环依赖');
  visiting.add(id);
  const node=nodes.get(id);if(!node)throw userError('原生数据流节点不存在');
  const type=sourceType(node),raw=sourceRecord(node),native=node.params?.nativeCanvas,provided=actual.get(id);
  let value={nodeId:id,type,promptItems:[],media:[],pendingNodeIds:[],issues:[]};
  if(provided){
   value.promptItems=[...provided.promptItems];value.media=provided.assetIds.map((assetId,index)=>media(assetId,id,index));
   if(type==='smart-prompt')value.promptItems=provided.promptItems.flatMap(text=>nativePromptItems(node,text));
  }else if(groupTypes.has(type)){
   const groupMembers=members(node).filter(member=>type!=='group'||ordinaryGroupMember(member));
   if(type==='promptGroup'){
    const children=groupMembers.map(member=>resolve(member.id));value.pendingNodeIds=unique(children.flatMap(v=>v.pendingNodeIds));value.issues=unique(children.flatMap(v=>v.issues));value.promptItems=groupMembers.map(member=>actual.get(member.id)?.promptItems.join('\n\n')??member.text).map(trimmed).filter(Boolean);
   }else{
    const children=groupMembers.map(member=>resolve(member.id));Object.assign(value,combine(children));
    if(type==='smart-group'&&completeMedia)value.media=[...storedMedia(node),...smartGroupMediaMembers(groupMembers).flatMap(member=>resolve(member.id).media)];
    if(type==='group'){
     value.promptItems=groupMembers.filter(member=>['prompt','text','script'].includes(sourceType(member))).map(member=>trimmed(member.text)).filter(Boolean);
     value.media=children.flatMap((child,index)=>sourceType(groupMembers[index])==='image'||!groupMembers[index].params?.nativeCanvas&&mediaKinds.has(groupMembers[index].type)?child.media:[]);
    }
   }
  }else if(type==='smart-prompt'){
   const settings=nativePromptSettings(node);value.promptItems=nativePromptItems(node);
   if(settings.llmEnabled){
    const upstream=combine(inputValues(node,'smart'));value.pendingNodeIds=upstream.pendingNodeIds;value.issues=upstream.issues;
    if(!node.params?.llmBinding)value.issues.push('智能提示词语言模型尚未绑定本机平台和模型');
    else if(execution)value.pendingNodeIds.push(id);
    value.llmInput=[...unique(upstream.promptItems),settings.instruction.trim()||value.promptItems.join('\n\n')].filter(Boolean).join('\n\n');
   }
  }else if(type==='loop'&&!native){
   // Mirror the already compiled Jingchang loop value, rather than interpreting
   // its own loop configuration as an Infinite Canvas loop configuration.
   value.promptItems=trimmed(node.text)?[trimmed(node.text)]:[];
  }else if(['loop','smart-loop'].includes(type)){
   const settings=nativeLoopSettings(node),smart=type==='smart-loop',count=settings.count,start=settings.start,ctx=loopContexts[id]||{index:start,total:count},inputs=combine(inputValues(node,smart?'smart':'loop'));
   value.pendingNodeIds=inputs.pendingNodeIds;value.issues=inputs.issues;value.loop={count,start,index:ctx.index,total:ctx.total??count,imageBatchSize:settings.imageBatchSize,videoBatchSize:settings.videoBatchSize,parallel:settings.mode==='parallel'};
   if(settings.showPrompt){
    const selected=inputs.promptItems.length?inputs.promptItems[(ctx.index-1)%inputs.promptItems.length]:'';
    let local=trimmed(settings.variablePrompt);
    if(smart){const fields=nativeLoopLocalPromptFields(settings);local=fields.length?fields[(ctx.index-1)%fields.length]:'';if(selected&&['现在生成第《计数》张卖点图片','Generate selling-point image 《计数》'].includes(local))local='';}
    const text=smart?[selected,local].filter(Boolean).join('\n\n'):selected||local;
    value.promptItems=text?[text.replaceAll('《计数》',String(ctx.index)).replaceAll('[计数]',String(ctx.index)).replaceAll('[Counter]',String(ctx.index)).replaceAll('《总数》',String(ctx.total??count)).replaceAll('[总数]',String(ctx.total??count)).replaceAll('[Total]',String(ctx.total??count)).replaceAll('《进度》',`${ctx.index}/${ctx.total??count}`).replaceAll('[进度]',`${ctx.index}/${ctx.total??count}`).replaceAll('[Progress]',`${ctx.index}/${ctx.total??count}`)]:[];
   }
   if(settings.imageInput){const refs=smart?inputs.media:inputs.media.filter(item=>item.kind==='image');value.media=refs.slice(ctx.index-1,ctx.index-1+value.loop.imageBatchSize);}
   if(!smart&&settings.videoInput){const refs=inputs.media.filter(item=>item.kind==='video');value.media.push(...refs.slice(ctx.index-1,ctx.index-1+value.loop.videoBatchSize));}
  }else if(['prompt','text','script','character','scene'].includes(type)){
   value.promptItems=trimmed(node.text)?[trimmed(node.text)]:[];
  }else if(type==='llm'){
   if(!raw.mode||raw.mode==='node')value.promptItems=trimmed(raw.outputText)?[trimmed(raw.outputText)]:[];
   else value.issues.push('原生语言模型对话模式尚未接入画布数据流');
   if(execution&&node.params?.llmBinding)value.pendingNodeIds.push(id);
  }else if(type==='output'){
   value.media=storedMedia(node);
   const incoming=orderedNativeInputIds(project,id).map(input=>resolve(input));
   value.pendingNodeIds=unique(incoming.flatMap(v=>v.pendingNodeIds));value.issues=unique(incoming.flatMap(v=>v.issues));
   for(const input of incoming)if(generatedTypes.has(input.type)&&actual.has(input.nodeId))for(const item of input.media)if(mediaKinds.has(item.kind)&&!value.media.some(prior=>prior.assetId===item.assetId))value.media.push({...item,receiverNodeId:id});
  }else if(['image','smart-image','video','audio'].includes(type)||generatedTypes.has(type)){
   value.media=storedMedia(node);
   if(type==='smart-image'&&raw.runSettings&&native?.adaptation!=='configured')value.issues.push('智能素材原生生成设置尚未迁移');
  }else value.issues.push('尚未适配的原生数据流节点：'+type);
  if(!provided&&execution&&declaredGeneration(node)&&!value.pendingNodeIds.includes(id))value.pendingNodeIds.push(id);
  if(native?.adaptation!=='configured'&&native?.missingResources.length)value.issues.push('缺少 '+native.missingResources.length+' 份已引用本机素材');
  if(value.promptItems.length>1000||value.media.length>1000||value.promptItems.reduce((n,t)=>n+t.length,0)>200000)throw userError('原生数据流聚合超过1000项或20万字');
  value.pendingNodeIds=unique(value.pendingNodeIds);value.issues=unique(value.issues);value.status=value.issues.length?'blocked':value.pendingNodeIds.length?'pending':'resolved';
  visiting.delete(id);memo.set(id,value);return value;
 }
 const selected=nodeId?[resolve(nodeId)]:project.nodes.map(node=>resolve(node.id));
 const entries=nodeId?inputValues(nodes.get(nodeId),sourceType(nodes.get(nodeId)).startsWith('smart-')?'smart':sourceType(nodes.get(nodeId))==='llm'?'llm':['loop','smart-loop'].includes(sourceType(nodes.get(nodeId)))?'loop':'generator'):undefined;
 const inputs=entries?{...combine(entries),sources:entries.map(entry=>({sourceNodeId:entry.sourceNodeId,...(entry.itemType?{itemType:entry.itemType}:{}),...(entry.itemIndex!==undefined?{itemIndex:entry.itemIndex}:{}),...(entry.memberId?{memberId:entry.memberId}:{}),promptItems:entry.promptItems,media:entry.media,pendingNodeIds:entry.pendingNodeIds,issues:entry.issues}))}:undefined;
 return {version:NATIVE_FLOW_VERSION,projectId:project.id,revision:project.revision,executionEnabled:false,dependencyOrder,nodes:structuredClone(selected),...(inputs?{inputs:structuredClone(inputs)}:{})};
}

export function splitNativeNumberedPrompts(text){
 const value=trimmed(text);if(!value)return [];
 const numbered=value.split(/\s*(?:^|\s)\d+\s*[.、)）．]\s+/).map(trimmed).filter(Boolean);
 if(numbered.length>=2)return numbered;
 const lines=value.split(/\r?\n+/).map(trimmed).filter(Boolean);
 return lines.length>=2?lines:[value];
}

export function nativeFlowOutputsFromJob(project,job,{loopId,roundIndex}={}){
 if(job?.kind!=='canvas-run'||job.projectId!==project.id)throw userError('原生数据流结果任务不属于当前项目');
 if(loopId!==undefined&&(!safeId(loopId)||!Number.isSafeInteger(roundIndex)||roundIndex<0))throw userError('结果回合筛选无效');
 const completed=(job.steps||[]).filter(step=>step.status==='completed'&&(loopId===undefined?!step.loopId:step.loopId===loopId&&step.roundIndex===roundIndex));
 const ids=new Set(completed.map(step=>step.nodeId)),outputs=new Map([...ids].map(id=>[id,{nodeId:id,assetIds:[],promptItems:[]}]));
 const matching=value=>loopId===undefined?!value.loopId:value.loopId===loopId&&value.roundIndex===roundIndex;
 for(const asset of job.assets||[])if(outputs.has(asset.sourceNodeId)&&matching(asset))outputs.get(asset.sourceNodeId).assetIds.push(asset.id);
 for(const text of job.textResults||[])if(outputs.has(text.sourceNodeId)&&matching(text))outputs.get(text.sourceNodeId).promptItems=[text.text];
 const result=[...outputs.values()];normalizeOutputs(project,result);return result;
}
