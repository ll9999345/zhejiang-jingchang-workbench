// Smart canvas drag semantics from the pinned Infinite Canvas reference.
// Coordinates and the 96-unit insertion radius are world-space, not screen pixels.
const raw=n=>n?.params?.nativeCanvas?.node||n;
const type=n=>raw(n)?.type;
const image=n=>type(n)==='smart-image';
const history=n=>image(n)&&!!(raw(n).isHistoryGroup||raw(n).historyFor);
const kind=e=>e.nativeCanvasConnection?.kind||'flow';
const rect=(n,sizes)=>({x:n.x,y:n.y,width:sizes[n.id]?.width||raw(n).w||288,height:sizes[n.id]?.height||raw(n).h||270});
function hasPrompt(project,node,seen=new Set()){
 if(!node||seen.has(node.id))return false;seen=new Set([...seen,node.id]);
 if(type(node)==='smart-prompt')return !!String(node.text??raw(node).text??'').trim();
 if(type(node)==='smart-group')return(node.params.nativeCanvas.members||[]).some(r=>hasPrompt(project,project.nodes.find(n=>n.id===r.sourceNodeId),seen));
 if(type(node)!=='smart-loop')return false;
 const settings=node.params?.nativeLoop||raw(node);if(!settings.showPrompt)return false;
 const local=Array.isArray(settings.variablePrompts)&&settings.variablePrompts.length?settings.variablePrompts:[settings.variablePrompt];
 return local.some(s=>String(s||'').trim())||project.edges.some(e=>e.target===node.id&&kind(e)==='input'&&hasPrompt(project,project.nodes.find(n=>n.id===e.source),seen));
}
export function smartDragTarget(project,primaryId,movedIds,point,sizes={}){
 const source=project.nodes.find(n=>n.id===primaryId);if(!source||movedIds.length!==1)return null;
 const r=rect(source,sizes),p=['smart-prompt','smart-loop'].includes(type(source))&&point?point:{x:r.x+r.width/2,y:r.y+r.height/2},excluded=new Set([primaryId,...movedIds]);
 return project.nodes.find(n=>{if(excluded.has(n.id))return false;const t=rect(n,sizes);return p.x>=t.x&&p.x<=t.x+t.width&&p.y>=t.y&&p.y<=t.y+t.height;})||null;
}
export function canSmartDragConnect(source,target){
 if(!source||!target||source.id===target.id||history(source)||history(target)||type(target)==='smart-group')return false;
 if(image(source))return image(target)||['smart-loop','smart-prompt'].includes(type(target));
 if(type(source)==='smart-prompt'||type(source)==='smart-group')return image(target)||type(target)==='smart-loop';
 return type(source)==='smart-loop'&&image(target);
}
export function smartLoopInsertion(project,primaryId,sizes={}){
 const source=project.nodes.find(n=>n.id===primaryId);if(type(source)!=='smart-loop')return null;
 const r=rect(source,sizes),cx=r.x+r.width/2,cy=r.y+r.height/2;let best=null;
 for(const edge of project.edges){
  if(!['input','flow'].includes(kind(edge))||edge.source===primaryId||edge.target===primaryId)continue;
  const from=project.nodes.find(n=>n.id===edge.source),to=project.nodes.find(n=>n.id===edge.target);if(!from||!to||history(from)||history(to))continue;
  const a=rect(from,sizes),b=rect(to,sizes),score=Math.hypot(cx-(a.x+a.width+b.x)/2,cy-(a.y+a.height/2+b.y+b.height/2)/2);
  if(score<=96&&(!best||score<best.score))best={edgeId:edge.id,score};
 }
 return best;
}
function addEdge(project,from,to,edgeKind,idFactory){
 if(project.edges.some(e=>e.source===from.id&&e.target===to.id&&kind(e)===edgeKind))return;
 project.edges.push({id:idFactory(),source:from.id,target:to.id,nativeCanvasConnection:{from:raw(from).id,to:raw(to).id,kind:edgeKind}});
 const native=to.params?.nativeCanvas;if(native&&!native.inputOrder.some(r=>r.sourceNodeId===from.id))native.inputOrder.push({sourceNodeId:from.id,index:Math.max(-1,...native.inputOrder.map(r=>r.index))+1});
}
export function connectSmartDragInput(project,from,to,idFactory){
 if(!from||!to||from.id===to.id)return false;
 if(type(to)==='smart-loop'){
  const fromState=from.params?.nativeLoop||raw(from);
  const members=type(from)==='smart-group'?[from,...(from.params.nativeCanvas.members||[]).map(r=>project.nodes.find(n=>n.id===r.sourceNodeId)).filter(Boolean)]:[];
  const looksImage=image(from)||members.some(n=>(n===from||image(n))&&(raw(n).images||[]).some(i=>i?.url))||type(from)==='smart-loop'&&fromState.imageInput;
  const looksPrompt=type(from)==='smart-prompt'||type(from)==='smart-group'&&hasPrompt(project,from)||type(from)==='smart-loop'&&fromState.showPrompt;
  if(!looksImage&&!looksPrompt)return false;
  for(const [key,on]of [['imageInput',looksImage],['showPrompt',looksPrompt]])if(on){raw(to)[key]=true;if(to.params?.nativeLoop)to.params.nativeLoop[key]=true;}
 }
 raw(to).inputNodeIds=[...new Set([...(raw(to).inputNodeIds||[]),raw(from).id])];
 addEdge(project,from,to,'input',idFactory);return true;
}
export function insertSmartDragLoop(project,primaryId,hit,idFactory){
 const node=project.nodes.find(n=>n.id===primaryId),edge=project.edges.find(e=>e.id===hit?.edgeId);if(type(node)!=='smart-loop'||!edge)return false;
 const from=project.nodes.find(n=>n.id===edge.source),to=project.nodes.find(n=>n.id===edge.target);
 project.edges=project.edges.filter(e=>e.id!==edge.id);
 if(Array.isArray(raw(to).inputNodeIds))raw(to).inputNodeIds=raw(to).inputNodeIds.filter(id=>String(id)!==String(raw(from).id));
 if(to.params?.nativeCanvas&&!project.edges.some(e=>e.source===from.id&&e.target===to.id))to.params.nativeCanvas.inputOrder=to.params.nativeCanvas.inputOrder.filter(r=>r.sourceNodeId!==from.id);
 addEdge(project,from,node,kind(edge)==='flow'?'flow':'input',idFactory);
 connectSmartDragInput(project,node,to,idFactory);return true;
}
