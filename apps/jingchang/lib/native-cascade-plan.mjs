import {validateProject} from './model.mjs';
import {assertNoCredentials,userError,safeId} from './workspace.mjs';
import {nativeLoopSettings,nativeLoopRoundContext} from '../public/native-loop-core.js';

// Independent execution contract for the pinned smart-canvas behaviour.
// This is an edge program: a sender generates into its first receiver, while
// its remaining receivers share that result. It must not be reduced to a
// topological list of individually bound nodes (diamonds revisit receivers).
export const NATIVE_CASCADE_VERSION=1;
export const NATIVE_CASCADE_LIMITS=Object.freeze({operations:3200,generations:1000});
const raw=node=>node?.params?.nativeCanvas?.node||{};
const type=node=>raw(node).type||node?.type;
const smartImage=node=>type(node)==='smart-image'&&!raw(node).isHistoryGroup&&!raw(node).historyFor;
const hasMedia=node=>Array.isArray(raw(node).images)&&raw(node).images.some(image=>image?.url);
const kind=edge=>edge.nativeCanvasConnection?.kind||'flow';
const xy=(a,b)=>a.x-b.x||a.y-b.y;
const sourceId=node=>raw(node).id||node.id;

function graphIndex(project){
 const nodes=new Map(project.nodes.map(node=>[node.id,node]));
 const inputs=(id,kinds=['input','flow'])=>{
  const ids=[...new Set(project.edges.filter(edge=>edge.target===id&&kinds.includes(kind(edge))).map(edge=>edge.source))];
  return ids.map(id=>nodes.get(id));
 };
 const children=id=>project.edges.filter(edge=>edge.source===id&&['input','flow'].includes(kind(edge)))
  .map(edge=>nodes.get(edge.target)).filter(node=>smartImage(node)||type(node)==='smart-loop').sort(xy);
 const images=id=>children(id).filter(smartImage);
 const descendants=id=>{
  const seen=new Set([id]),result=[];
  const visit=id=>{
   for(const edge of project.edges.filter(edge=>edge.source===id&&['input','flow'].includes(kind(edge)))){
    if(seen.has(edge.target))continue;seen.add(edge.target);result.push(nodes.get(edge.target));visit(edge.target);
   }
  };
  visit(id);return result;
 };
 function ancestors(id){
  const seen=new Set([id]),result=[];
  const visit=id=>{for(const input of inputs(id)){if(seen.has(input.id))continue;seen.add(input.id);visit(input.id);result.push(input);}};
  visit(id);return result;
 }
 const loopFor=id=>ancestors(id).filter(node=>type(node)==='smart-loop').at(-1)||null;
 const workflowImages=id=>images(id).filter(target=>raw(target).sourceNodeId!==sourceId(nodes.get(id)));
 function primaryImage(node){
  const upstream=inputs(node.id),direct=upstream.filter(node=>smartImage(node)&&hasMedia(node)).sort((a,b)=>b.x-a.x||a.y-b.y)[0];
  if(direct)return direct;
  const loop=upstream.find(node=>type(node)==='smart-loop');
  if(loop&&nativeLoopSettings(loop).imageInput)return inputs(loop.id).find(node=>smartImage(node)&&hasMedia(node))||null;
  return null;
 }
 function chain(tail){
  const path=[],seen=new Set();let current=tail;
  while(current&&!seen.has(current.id)){seen.add(current.id);path.unshift(current);current=primaryImage(current);}
  return path;
 }
 function graph(tail){
  const path=chain(tail),loop=loopFor(tail.id),root=(loop?images(loop.id).find(node=>path.includes(node)):null)||path[0];
  const adjacency=new Map(),edges=[],seenEdges=new Set(),visiting=new Set(),visited=new Set();
  const visit=node=>{
   if(visiting.has(node.id))throw userError('智能串联不能形成循环依赖');
   if(visited.has(node.id))return;visiting.add(node.id);
   const targets=children(node.id);adjacency.set(node.id,targets);
   for(const target of targets){const key=node.id+'->'+target.id;if(!seenEdges.has(key)){seenEdges.add(key);edges.push({sourceNodeId:node.id,targetNodeId:target.id});}visit(target);}
   visiting.delete(node.id);visited.add(node.id);
  };
  visit(root);return{root,path,loop,adjacency,edges};
 }
 function directLoopTarget(tail,g){
  return !!g.loop&&g.root.id===tail.id&&!workflowImages(tail.id).length&&images(g.loop.id).includes(tail);
 }
 function canRun(tail){
  if(!smartImage(tail))return false;const g=graph(tail);
  if(directLoopTarget(tail,g))return true;
  if(descendants(tail.id).some(smartImage))return false;
  return g.edges.length>0||!!g.loop;
 }
 function tailForLoop(loop){
  const direct=images(loop.id),targets=direct.filter(node=>!workflowImages(node.id).length);
  if(targets.length)return targets.at(-1);
  const ids=new Set(direct.map(node=>node.id));
  return descendants(loop.id).filter(node=>smartImage(node)&&canRun(node))
   .sort((a,b)=>Number(ids.has(a.id))-Number(ids.has(b.id))||b.x-a.x||b.y-a.y)[0]||null;
 }
 return{nodes,inputs,children,images,descendants,loopFor,graph,directLoopTarget,canRun,tailForLoop};
}

function selectGraph(project,nodeId){
 if(!safeId(nodeId))throw userError('请选择智能串联的链尾素材或智能循环');
 const index=graphIndex(project),requested=index.nodes.get(nodeId);
 if(!requested)throw userError('智能串联目标节点不存在');
 const tail=type(requested)==='smart-loop'?index.tailForLoop(requested):requested;
 if(!tail||!index.canRun(tail))throw userError('请选择智能串联的链尾素材或已有下游的智能循环');
 return{...index,requested,tail,...index.graph(tail)};
}

export function nativeCascadeGraph(project,{nodeId}={}){
 validateProject(project);assertNoCredentials(project);
 const g=selectGraph(project,nodeId);
 return{requestedNodeId:nodeId,tailNodeId:g.tail.id,rootNodeId:g.root.id,pathNodeIds:g.path.map(node=>node.id),loopId:g.loop?.id||null,
  edges:g.edges,children:[...g.adjacency].map(([sourceNodeId,targets])=>({sourceNodeId,targetNodeIds:targets.map(node=>node.id)}))};
}

function existingSlot(g,index,offset){
 const rootId=sourceId(g.tail),loopId=sourceId(g.loop);
 const candidates=g.descendants(g.tail.id).filter(smartImage).sort(xy)
  .filter(node=>raw(node).sourceNodeId===rootId&&(!raw(node).loopSourceId||raw(node).loopSourceId===loopId));
 const untagged=candidates.filter(node=>!Number.isFinite(Number(raw(node).loopRoundIndex))&&!Number.isFinite(Number(raw(node).loopSlotIndex)));
 return candidates.find(node=>Number(raw(node).loopRoundIndex)===index)
  ||candidates.find(node=>Number(raw(node).loopSlotIndex)===offset)||untagged[offset]||null;
}

export function planNativeCascade(project,{nodeId}={}){
 validateProject(project);assertNoCredentials(project);
 const g=selectGraph(project,nodeId),settings=g.loop?nativeLoopSettings(g.loop):null;
 if(settings&&!settings.enabled)throw userError('请先核对并明确启用智能循环，再运行智能串联');
 const singleNodeLoopRun=!!g.loop&&(g.path.length===1||g.directLoopTarget(g.tail,g));
 if(!g.edges.length&&!singleNodeLoopRun)throw userError('智能串联没有可运行的链路');
 const count=settings?.count||1,start=settings?.start||1,stride=settings?.imageInput?settings.imageBatchSize:1;
 const endIndex=start+(count-1)*stride,rounds=[];let operationCount=0,generationOperationCount=0;
 const append=operations=>operation=>{
  if(++operationCount>NATIVE_CASCADE_LIMITS.operations)throw userError('智能串联展开超过3200步，请减少轮次或分支');
  if(operation.kind==='generate'&&++generationOperationCount>NATIVE_CASCADE_LIMITS.generations)throw userError('智能串联超过1000个生成步骤，请减少轮次或分支');
  const id='cascade-r'+rounds.length+'-s'+operations.length;
  operations.push({id,...operation});return{kind:'operation-output',operationId:id};
 };
 for(let offset=0;offset<count;offset++){
  const context=g.loop?nativeLoopRoundContext(g.loop,offset):null,index=context?.index||start;
  const operations=[],push=append(operations),choices=[],visitedNodeIds=new Set([g.root.id]);
  const loopContexts=context?Object.fromEntries(project.nodes.filter(node=>type(node)==='smart-loop').map(node=>[node.id,{...context}])):{};
  if(singleNodeLoopRun){
   const slot=existingSlot(g,index,offset);
   push({kind:'generate',sourceNodeId:g.tail.id,targetNodeId:slot?.id||null,requestNodeId:g.tail.id,
    target:{kind:'loop-slot',nodeId:slot?.id||null,rootNodeId:g.tail.id,loopId:g.loop.id,index,slotIndex:offset},
    references:{kind:'loop-input',nodeId:g.loop.id},relayPromptNodeIds:[],resultPolicy:'replace-with-history',preserveTargetConfiguration:false,missingPromptFallback:null});
   if(slot)visitedNodeIds.add(slot.id);
  }else{
   const visit=(source,incoming)=>{
    let targets=g.adjacency.get(source.id)||[];
    const prompts=smartImage(source)?g.inputs(source.id,['input']).filter(node=>type(node)==='smart-loop'&&nativeLoopSettings(node).showPrompt):[];
    if(prompts.length&&targets.length>1){
     const counter=context?.index||nativeLoopSettings(prompts[0]).start,selected=targets[(counter-1)%targets.length];
     choices.push({sourceNodeId:source.id,promptLoopNodeIds:prompts.map(node=>node.id),index:counter,targetNodeIds:targets.map(node=>node.id),selectedNodeId:selected.id});targets=[selected];
    }
    let shared=incoming;
    for(const [siblingIndex,target]of targets.entries()){
     visitedNodeIds.add(target.id);
     const loops=smartImage(source)&&smartImage(target)?prompts.filter(loop=>!g.inputs(target.id,['input']).some(input=>input.id===loop.id)):[];
     const leaf=type(target)!=='smart-loop'&&!(g.adjacency.get(target.id)||[]).some(child=>type(child)!=='smart-loop');
     const base={sourceNodeId:source.id,targetNodeId:target.id,target:{kind:'node',nodeId:target.id},relayPromptNodeIds:loops.map(node=>node.id),preserveTargetConfiguration:true};
     let outgoing;
     if(type(target)==='smart-loop'){
      shared=push({...base,kind:'relay',requestNodeId:null,references:{kind:'node-output',nodeId:source.id},resultPolicy:'relay-only',missingPromptFallback:null});outgoing=shared;
     }else if(siblingIndex===0){
      shared=push({...base,kind:'generate',requestNodeId:type(source)==='smart-loop'?target.id:source.id,
       references:{kind:'self-default-incoming',selfNodeId:type(source)==='smart-loop'?null:source.id,defaultNodeId:type(source)==='smart-loop'?target.id:source.id,incoming},
       resultPolicy:g.loop&&leaf?'append-loop':'replace-with-history',missingPromptFallback:{reference:incoming,resultPolicy:'replace-with-history'}});outgoing=shared;
     }else{
      outgoing=push({...base,kind:'copy',requestNodeId:null,references:shared,resultPolicy:'replace-with-history',missingPromptFallback:null});
     }
     visit(target,outgoing);
    }
   };
   visit(g.root,{kind:'default',nodeId:g.root.id});
  }
  rounds.push({roundIndex:offset,index:context?.index||null,total:context?.total||null,forceWorkflow:!!g.loop&&g.path.length>1&&!singleNodeLoopRun,
   loopContexts,choices,operations,skippedNodeIds:[...g.adjacency.keys()].filter(id=>!visitedNodeIds.has(id))});
 }
 const comfyInPath=g.path.some(node=>!!node.params?.workflowBinding||raw(node).runSettings?.engine==='comfy');
 return{version:NATIVE_CASCADE_VERSION,mode:'native-cascade',requestedNodeId:nodeId,tailNodeId:g.tail.id,rootNodeId:g.root.id,pathNodeIds:g.path.map(node=>node.id),singleNodeLoopRun,
  loop:settings?{nodeId:g.loop.id,count,mode:settings.mode,start,stride,endIndex}:null,
  scheduling:{mode:settings?.mode||'serial',parallelLimitPolicy:comfyInPath?'comfy-backends-at-most-six':'at-most-six'},
  operationCount,generationOperationCount,rounds};
}

export function validateNativeCascadeProgram(project,program){
 if(!program||program.version!==NATIVE_CASCADE_VERSION||program.mode!=='native-cascade')throw userError('智能串联执行清单版本无效');
 assertNoCredentials(program);
 const expected=planNativeCascade(project,{nodeId:program.requestedNodeId});
 if(JSON.stringify(program)!==JSON.stringify(expected))throw userError('智能串联执行清单与原画布快照不一致，未继续执行');
 return expected;
}
