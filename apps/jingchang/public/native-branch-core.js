import {nativeLoopEnabled,nativeLoopSettings,nativeLoopRoundContext} from './native-loop-core.js';

// The pinned smart canvas rotates direct image/loop children by the *counter*,
// not by the round offset. Routing is an explicit migration setting so that
// existing Jingchang projects keep their previous all-branches behaviour.
const typeOf = node => node?.params?.nativeCanvas?.node?.type || node?.type;
const groups = new Set(['group','promptGroup','smart-group']);
const smartImage = node => typeOf(node)==='smart-image' && !node.params.nativeCanvas.node.isHistoryGroup && !node.params.nativeCanvas.node.historyFor;
const kindOf = edge => edge.nativeCanvasConnection?.kind || 'flow';

export const isNativeBranchLoop = node => typeOf(node)==='smart-loop';
export function normalizeNativeBranch(value) {
 if (!value || value.version!==1 || typeof value.enabled!=='boolean' || Object.keys(value).some(key=>!['version','enabled'].includes(key))) throw Error('智能分支设置无效：须使用明确的启用开关');
 return {version:1,enabled:value.enabled};
}
export function nativeBranchSettings(node) {
 if (!isNativeBranchLoop(node)) throw Error('分支轮换只适用于原生智能循环');
 return node.params.nativeBranch===undefined ? {version:1,enabled:false} : normalizeNativeBranch(node.params.nativeBranch);
}
export const nativeBranchEnabled = node => isNativeBranchLoop(node) && nativeBranchSettings(node).enabled;

function dependencies(project,id) {
 const node=project.nodes.find(node=>node.id===id);
 const members=groups.has(typeOf(node)) ? (node.params.nativeCanvas.members||[]).map(ref=>ref.sourceNodeId).filter(id=>{
  const member=project.nodes.find(node=>node.id===id),type=typeOf(member);
  return typeOf(node)==='smart-group' ? type!=='smart-group' : typeOf(node)==='group' ? ['image','prompt','text','script'].includes(type) || !member?.params?.nativeCanvas && ['image','video','audio'].includes(member?.type) : true;
 }) : [];
 return [...new Set([...project.edges.filter(edge=>edge.target===id).map(edge=>edge.source),...members])];
}
function topology(project) {
 const nodes=new Map(project.nodes.map(node=>[node.id,node])),children=new Map(project.nodes.map(node=>[node.id,[]]));
 for (const node of project.nodes) for (const id of dependencies(project,node.id)) {
  if (!nodes.has(id)) throw Error('智能分支依赖的节点已不存在');
  children.get(id).push(node.id);
 }
 const descendants=id=>{
  const found=new Set(),queue=[id];
  while(queue.length) for (const child of children.get(queue.shift())||[]) if (!found.has(child) && child!==id) {found.add(child);queue.push(child);}
  return found;
 };
 return {nodes,children,descendants};
}

export function nativeBranchCandidates(project,loop) {
 if (!isNativeBranchLoop(loop)) throw Error('请选择原生智能循环');
 const {nodes,descendants}=topology(project),owned=descendants(loop.id),settings=nativeLoopSettings(loop);
 if (!settings.showPrompt) return [];
 return project.nodes.filter(source=>owned.has(source.id) && smartImage(source) && project.edges.some(edge=>edge.source===loop.id && edge.target===source.id && kindOf(edge)==='input')).flatMap(source=>{
  const targets=[...new Set(project.edges.filter(edge=>edge.source===source.id && ['input','flow'].includes(kindOf(edge))).map(edge=>edge.target))].map(id=>nodes.get(id)).filter(target=>smartImage(target) || typeOf(target)==='smart-loop');
  targets.sort((a,b)=>a.x-b.x || a.y-b.y);
  return targets.length>1 ? [{sourceNodeId:source.id,targetNodeIds:targets.map(node=>node.id)}] : [];
 });
}

export function nativeBranchRound(project,loop,round) {
 if (!nativeBranchEnabled(loop)) return {project,route:null};
 if (!nativeLoopEnabled(loop)) throw Error('请先启用智能循环，再启用分支轮换');
 const context=nativeLoopRoundContext(loop,round),{nodes,children,descendants}=topology(project),owned=descendants(loop.id);
 const candidates=new Map(nativeBranchCandidates(project,loop).map(candidate=>[candidate.sourceNodeId,candidate]));
 const smartSources=project.nodes.filter(node=>owned.has(node.id) && smartImage(node));
 // Additional loop->image links carry that image's prompt. They do not turn
 // an unselected descendant branch into another independent execution root.
 const relayed=new Set(smartSources.flatMap(node=>[...descendants(node.id)]));
 const reached=new Set([loop.id]),queue=[loop.id],choices=[];
 while(queue.length) {
  const id=queue.shift(),candidate=candidates.get(id);
  const selected=candidate?.targetNodeIds[(context.index-1)%candidate.targetNodeIds.length];
  if (candidate) choices.push({sourceNodeId:id,index:context.index,targetNodeIds:[...candidate.targetNodeIds],selectedNodeId:selected});
  for (const child of children.get(id)||[]) {
   if (id===loop.id && relayed.has(child)) continue;
   if (candidate && candidate.targetNodeIds.includes(child) && child!==selected) continue;
   if (!reached.has(child)) {reached.add(child);queue.push(child);}
  }
 }
 const excludedNodeIds=project.nodes.filter(node=>owned.has(node.id) && !reached.has(node.id)).map(node=>node.id);
 const excluded=new Set(excludedNodeIds),routed=structuredClone(project);
 routed.nodes=routed.nodes.filter(node=>!excluded.has(node.id));
 routed.edges=routed.edges.filter(edge=>!excluded.has(edge.source) && !excluded.has(edge.target) && (!candidates.has(edge.source) || !candidates.get(edge.source).targetNodeIds.includes(edge.target) || choices.some(choice=>choice.sourceNodeId===edge.source && choice.selectedNodeId===edge.target)));
 routed.groups=(routed.groups||[]).map(group=>({...group,nodeIds:group.nodeIds.filter(id=>!excluded.has(id))})).filter(group=>group.nodeIds.length);
 for (const node of routed.nodes) if (node.params?.nativeCanvas) {
  const native=node.params.nativeCanvas;
  native.members=native.members.filter(ref=>!excluded.has(ref.sourceNodeId));
  native.inputOrder=native.inputOrder.filter(ref=>!excluded.has(ref.sourceNodeId) && routed.edges.some(edge=>edge.source===ref.sourceNodeId && edge.target===node.id));
 }
 return {project:routed,route:{version:1,loopId:loop.id,roundIndex:round,choices,excludedNodeIds}};
}

export function nativeBranchProjectFromStep(project,step) {
 const loop=project.nodes.find(node=>node.id===step.loopId);
 if (!loop || !nativeBranchEnabled(loop)) {
  if (step.nativeBranch) throw Error('任务分支记录与原循环设置不一致');
  return project;
 }
 const {project:routed,route}=nativeBranchRound(project,loop,step.roundIndex);
 const context=nativeLoopRoundContext(loop,step.roundIndex),saved=step.nativeLoop?.contexts?.[loop.id];
 if (step.nativeLoop?.version!==1 || step.roundCount!==nativeLoopSettings(loop).count || step.nativeLoop.index!==context.index || step.nativeLoop.total!==context.total || JSON.stringify(saved)!==JSON.stringify(context)) throw Error('任务分支计数与原循环设置不一致，未继续执行');
 if (JSON.stringify(step.nativeBranch)!==JSON.stringify(route)) throw Error('任务分支选择与提交时快照不一致，未继续执行');
 if (!routed.nodes.some(node=>node.id===step.nodeId)) throw Error('执行节点不属于本轮选中的分支');
 return routed;
}

export function nativeBranchMarkup(route,esc,label=id=>id) {
 if (!route) return '';
 if (!route.choices.length) return '<div class="native-branch-summary"><p class="small muted">本轮没有符合轮换条件的分支；按已保存连线执行。</p></div>';
 return `<div class="native-branch-summary"><p class="small muted">本轮按计数 ${esc(route.choices[0]?.index??'—')} 选择智能分支；未选分支不提交。</p>${route.choices.map(choice=>`<p class="small">${esc(label(choice.sourceNodeId))} → <strong>${esc(label(choice.selectedNodeId))}</strong>（${choice.targetNodeIds.indexOf(choice.selectedNodeId)+1}/${choice.targetNodeIds.length}）</p>`).join('')}${route.excludedNodeIds.length?`<p class="small muted">本轮跳过 ${route.excludedNodeIds.length} 个分支节点。</p>`:''}</div>`;
}
