import {createHash} from 'node:crypto';
import {validateProject} from './model.mjs';
import {assertNoCredentials,safeId,userError} from './workspace.mjs';
import {nativeFlowDependencyOrder,nativeFlowPreview} from './native-flow.mjs';
import {nativeExecutionAncestors,nativeReferenceSelectionSlots} from './native-flow-execution.mjs';
import {syncNativeConnections} from '../public/native-canvas-core.js';

const type=n=>n?.params?.nativeCanvas?.node.type||n?.type;
const ordinary=n=>n?.params?.nativeCanvas?.format==='infinite-canvas-workflow'&&['group','promptGroup'].includes(type(n));
const eligible=(n,kind)=>n&&(n.params?.nativeCanvas?.format??'infinite-canvas-workflow')==='infinite-canvas-workflow'&&(kind==='group'?['image','prompt','text','script']:['prompt','text','script']).includes(type(n));
const sourceId=n=>n.params?.nativeCanvas?.node.id??n.id;
const generators=new Set(['generator','midjourney','msgen','comfy','ltxDirector','video','rh','minimax']);
const bindings=['workflowBinding','cloudBinding','imageBinding','llmBinding','studioBinding'];
const generation=n=>generators.has(type(n))||!n.params?.nativeCanvas&&bindings.filter(k=>k!=='llmBinding').some(k=>n.params?.[k]);
const canonical=(value,depth=0)=>{if(depth>100)throw userError('成员修改快照层级过深');if(Array.isArray(value))return value.map(v=>canonical(v,depth+1));if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k],depth+1)]));return value;};
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function membershipRequest(body){
 if(!body||typeof body!=='object'||!['manual','drag'].includes(body.mode)||!safeId(body.requestId)||!Number.isSafeInteger(body.revision)||body.revision<0)throw userError('成员修改请求无效');
 const request={mode:body.mode,requestId:body.requestId,revision:body.revision};
 if(body.mode==='manual'){
  if(!safeId(body.groupId)||!Array.isArray(body.memberIds)||body.memberIds.length>1500||body.memberIds.some(id=>!safeId(id))||new Set(body.memberIds).size!==body.memberIds.length||typeof body.title!=='string'||!body.title.trim()||body.title.trim().length>120)throw userError('输入组名称或成员清单无效');
  Object.assign(request,{groupId:body.groupId,memberIds:[...body.memberIds],title:body.title.trim()});
 }else{
  if(!Array.isArray(body.movedIds)||!body.movedIds.length||body.movedIds.length>1500||body.movedIds.some(id=>!safeId(id))||new Set(body.movedIds).size!==body.movedIds.length||!body.draft||typeof body.draft!=='object')throw userError('拖动范围或画布草稿无效');
  request.movedIds=[...body.movedIds];request.draft=structuredClone(body.draft);
 }
 const rects=body.rects??{};if(!rects||typeof rects!=='object'||Array.isArray(rects)||Object.keys(rects).length>1500)throw userError('节点尺寸清单无效');
 request.rects={};for(const [id,r]of Object.entries(rects)){if(!safeId(id)||!r||!Number.isFinite(r.width)||!Number.isFinite(r.height)||r.width<=0||r.height<=0||r.width>1e7||r.height>1e7)throw userError('节点尺寸无效');Object.defineProperty(request.rects,id,{value:{width:r.width,height:r.height},enumerable:true,writable:true});}
 assertNoCredentials(request);return request;
}

function descriptors(node){
 const result=[];const add=(ref,label,collection=null)=>{if(ref?.sourceNodeId)result.push({ref,label,collection});};
 const p=node.params||{};
 const addH3=h3=>{for(const r of h3?.refs||[])add(r,'H3 '+r.kind);for(const s of h3?.segments||[])for(const r of s.refs||[])add(r,'H3片段 '+r.kind);};
 addH3(p.minimaxH3);
 for(const [key,name]of [['workflowBinding','工作流'],['cloudBinding','云工作流']]){
  const b=p[key];for(const r of b?.imageSources||[])add(r,name+' '+(r.name||'素材字段'));for(const r of b?.inputs||[])add(r,name+' '+(r.fieldName||'素材字段'));
  addH3(b?.minimaxH3);
  const ltx=b?.ltxDirector;for(const key of ['segments','audioSegments'])for(const r of ltx?.[key]||[])if(r.type!=='text')add(r,'LTX '+r.type);
 }
 for(const key of ['imageBinding','llmBinding','studioBinding']){const refs=p[key]?.referenceSources;for(const r of refs||[])add(r,'参考素材',refs);}
 return result;
}
function refreshInputOrder(project,groupIds){
 const nodes=new Map(project.nodes.map(n=>[n.id,n]));
 for(const node of project.nodes){
  const native=node.params?.nativeCanvas;if(!native||!project.edges.some(e=>e.target===node.id&&groupIds.has(e.source))&&!(native.inputOrder||[]).some(r=>groupIds.has(r.sourceNodeId)))continue;
  const entries=nativeFlowPreview(project,{nodeId:node.id}).inputs.sources;
  native.inputOrder=entries.map((entry,index)=>({index,sourceNodeId:entry.sourceNodeId,...Object.fromEntries(['itemType','memberId','itemIndex','itemUrl'].filter(k=>entry[k]!==undefined).map(k=>[k,entry[k]]))}));
  native.node.inputs=native.inputOrder.map(r=>{const id=sourceId(nodes.get(r.sourceNodeId));return r.itemType==='generated'?`${id}:generated:${r.itemIndex}:${r.itemUrl}`:r.itemType==='group-media'?`${id}:${r.memberId}`:r.itemType==='group-prompts'?`${id}:prompts`:id;});
 }
}
export function refreshDisplayGroups(before,next,newId){
 const oldGroups=before.nodes.filter(n=>n.params?.nativeCanvas&&String(sourceId(n))!==n.id&&['group','promptGroup','smart-group'].includes(type(n))),nodes=new Map(next.nodes.map(n=>[n.id,n]));
 const frameOwner=new Map();for(const frame of before.groups||[]){const matches=oldGroups.filter(n=>n.params.nativeCanvas.members.length===frame.nodeIds.length&&n.params.nativeCanvas.members.every(r=>frame.nodeIds.includes(r.sourceNodeId)));const owner=matches.find(n=>n.title===frame.title)||matches[0];if(owner)frameOwner.set(frame.id,owner.id);}
 const kept=(next.groups||[]).filter(g=>!frameOwner.has(g.id)),occupied=new Set(kept.flatMap(g=>g.nodeIds)),ids=new Set(kept.map(g=>g.id));
 for(const node of next.nodes.filter(n=>n.params?.nativeCanvas&&['group','promptGroup','smart-group'].includes(type(n)))){
  const oldFrame=(before.groups||[]).find(g=>frameOwner.get(g.id)===node.id),saved=node.params.nativeCanvas.groupDisplayState;
  if(!oldFrame&&!saved)continue;const members=node.params.nativeCanvas.members.map(r=>r.sourceNodeId),presentation=oldFrame?Object.fromEntries(Object.entries(oldFrame).filter(([k])=>k!=='nodeIds')):structuredClone(saved);
  if(!members.length||members.some(id=>occupied.has(id))){node.params.nativeCanvas.groupDisplayState=presentation;continue;}
  const id=ids.has(presentation.id)?newId():presentation.id;ids.add(id);members.forEach(id=>occupied.add(id));kept.push({...presentation,id,nodeIds:members});delete node.params.nativeCanvas.groupDisplayState;
 }
 // Independent visual grouping is not rewritten. Only exact imported mirror
 // frames follow their source members; hidden presentation stays on the node.
 next.groups=kept;
}

export function planInputGroupMembership(project,body){
 const request=membershipRequest(body);validateProject(project);assertNoCredentials(project);
 if(project.revision!==request.revision)throw userError('画布已更新，请重新检查成员范围',409);
 let before=project;
 if(request.mode==='drag'){
  const draft=request.draft;if(draft.id!==project.id||draft.revision!==project.revision)throw userError('拖动画布版本不一致',409);validateProject(draft);assertNoCredentials(draft);
  // A drag can include an unsaved Alt-copy or another pending local edit,
  // just as the ordinary project PUT can. Immutable project identity stays.
  before={...structuredClone(draft),id:project.id,createdAt:project.createdAt};
 }
 const next=structuredClone(before),nodes=new Map(next.nodes.map(n=>[n.id,n])),groups=next.nodes.filter(ordinary),oldMembers=new Map(groups.map(n=>[n.id,n.params.nativeCanvas.members.map(r=>r.sourceNodeId)]));
 const effects={memberships:[],addedEdges:[],removedEdges:[],fieldChanges:[],warnings:[]},handoffGroups=new Set();
 let sequence=0;const used=new Set([...next.nodes.map(n=>n.id),...next.edges.map(e=>e.id)]),edgeId=()=>{for(let i=0;i<10000;i++){const id='membership-'+hash([request.requestId,sequence++]).slice(0,32);if(!used.has(id)){used.add(id);return id;}}throw userError('无法分配连线编号');};
 const addEdge=(source,target,reason)=>{if(next.edges.some(e=>e.source===source&&e.target===target))return false;const edge={id:edgeId(),source,target};next.edges.push(edge);effects.addedEdges.push({...edge,reason});return true;};
 const handoff=(group,child)=>{
  if(type(group)!=='group'||!eligible(child,'group'))return;
  const targets=new Set(next.edges.filter(e=>[child.id,group.id].includes(e.source)&&generation(nodes.get(e.target))).map(e=>e.target));
  const removed=next.edges.filter(e=>e.source===child.id&&targets.has(e.target));effects.removedEdges.push(...removed);const removedIds=new Set(removed.map(e=>e.id));next.edges=next.edges.filter(e=>!removedIds.has(e.id));
  if(removed.length)handoffGroups.add(group.id);for(const target of targets)if(addEdge(group.id,target,'组成员生成连线交接'))handoffGroups.add(group.id);
 };
 const setMembers=(group,ids)=>{const prior=new Map(group.params.nativeCanvas.members.map(r=>[r.sourceNodeId,r]));group.params.nativeCanvas.members=ids.map(sourceNodeId=>prior.has(sourceNodeId)?structuredClone(prior.get(sourceNodeId)):{sourceNodeId});group.params.nativeCanvas.node.items=ids.map(id=>sourceId(nodes.get(id)));};
 const editMember=(child,kind,containing)=>{
  for(const group of groups.filter(n=>type(n)===kind)){
   let ids=group.params.nativeCanvas.members.map(r=>r.sourceNodeId);
   if(group!==containing)ids=ids.filter(id=>id!==child.id);else if(!ids.includes(child.id))ids.push(child.id);
   if(JSON.stringify(ids)!==JSON.stringify(group.params.nativeCanvas.members.map(r=>r.sourceNodeId)))setMembers(group,ids);
  }
  if(containing)handoff(containing,child);
 };
 if(request.mode==='manual'){
  const target=nodes.get(request.groupId);if(!ordinary(target))throw userError('请选择普通输入组或提示词组');
  const prior=new Set(oldMembers.get(target.id));if(request.memberIds.some(id=>!nodes.has(id)||!eligible(nodes.get(id),type(target))&&!prior.has(id)))throw userError('新成员类型不适用于此输入组');
  for(const id of request.memberIds)if(eligible(nodes.get(id),type(target)))editMember(nodes.get(id),type(target),target);
  if(JSON.stringify(request.memberIds)!==JSON.stringify(target.params.nativeCanvas.members.map(r=>r.sourceNodeId)))setMembers(target,request.memberIds);
  if(target.title!==request.title){target.title=request.title;target.params.nativeCanvas.node.title=request.title;}
 }else{
  if(request.movedIds.some(id=>!nodes.has(id)))throw userError('拖动的节点已不存在');
  const rect=n=>{const r=Object.hasOwn(request.rects,n.id)?request.rects[n.id]:null;return{x:n.x,y:n.y,width:r?.width||(ordinary(n)?Math.max(220,Number(n.params.nativeCanvas.node.w)||300):288),height:r?.height||(ordinary(n)?Math.max(120,Number(n.params.nativeCanvas.node.h)||220):270)};};
  const moved=request.movedIds.map(id=>nodes.get(id));
  // The pinned endDrag explicitly skips reassignment if a whole group is
  // among the moved nodes, including its recursively translated members.
  const draggedGroup=moved.some(n=>['group','promptGroup'].includes(type(n)));
  for(const [childKind,groupKind]of [['image','group'],['prompt','group'],['prompt','promptGroup']]){
   if(draggedGroup)break;
   const candidates=groups.filter(n=>type(n)===groupKind);
   for(const child of moved.filter(n=>childKind==='image'?type(n)==='image':['prompt','text','script'].includes(type(n)))){
    if((child.params?.nativeCanvas?.format??'infinite-canvas-workflow')!=='infinite-canvas-workflow')continue;
    const cr=rect(child),cx=cr.x+cr.width/2,cy=cr.y+cr.height/2;
    const containing=candidates.find(n=>{const r=rect(n);return cx>=r.x&&cx<=r.x+r.width&&cy>=r.y&&cy<=r.y+r.height;});
    editMember(child,groupKind,containing);
   }
  }
 }
 const changedGroups=new Set();for(const group of groups){const beforeIds=oldMembers.get(group.id),afterIds=group.params.nativeCanvas.members.map(r=>r.sourceNodeId);if(JSON.stringify(beforeIds)!==JSON.stringify(afterIds)){changedGroups.add(group.id);effects.memberships.push({groupId:group.id,title:group.title,addedIds:afterIds.filter(id=>!beforeIds.includes(id)),removedIds:beforeIds.filter(id=>!afterIds.includes(id)),memberIds:afterIds});}}
 // Even an unchanged membership can hand off a newly drawn direct edge.
 for(const id of handoffGroups)changedGroups.add(id);
 if(changedGroups.size)refreshDisplayGroups(before,next,edgeId);
 nativeFlowDependencyOrder(next);refreshInputOrder(next,changedGroups);
 const oldNodes=new Map(before.nodes.map(n=>[n.id,n])),snapshotCache=new Map(),slots=(p,n,id,consumer)=>{
  const key=(p===before?'old:':'new:')+n.id+':'+id+':'+consumer;if(snapshotCache.has(key))return snapshotCache.get(key);
  const value=nativeReferenceSelectionSlots(p,n,id,{consumer});snapshotCache.set(key,value);return value;
 };
 const same=(a,b)=>a?.sourceNodeId===b?.sourceNodeId&&a?.sourceIndex===b?.sourceIndex;
 for(const node of next.nodes){
  const original=oldNodes.get(node.id);if(!original)continue;
  const priorParents=nativeExecutionAncestors(before,node.id),currentParents=()=>nativeExecutionAncestors(next,node.id);
  for(const d of descriptors(node)){
   const ref=d.ref,oldSource=ref.sourceNodeId,oldIndex=ref.sourceIndex,consumer=node.params?.llmBinding?'llm':'generator';
   if(!oldNodes.has(oldSource))continue;
   const affectedGroup=changedGroups.has(oldSource)&&ordinary(oldNodes.get(oldSource));
   if(!affectedGroup){if(priorParents.has(oldSource)&&!currentParents().has(oldSource)){addEdge(oldSource,node.id,'保留原成员字段映射');effects.fieldChanges.push({nodeId:node.id,title:node.title,label:d.label,action:'restore-member-edge',sourceNodeId:oldSource});}continue;}
   if(d.collection){
    let remaining;try{remaining=slots(next,node,oldSource,consumer);}catch(error){effects.warnings.push({nodeId:node.id,label:d.label,message:error.message});continue;}
    if(!remaining.length){const index=d.collection.indexOf(ref);if(index>=0)d.collection.splice(index,1);effects.fieldChanges.push({nodeId:node.id,title:node.title,label:d.label,action:'remove-empty-group-reference',sourceNodeId:oldSource});}
    continue;
   }
   let prior,remaining;try{prior=slots(before,original,oldSource,consumer);remaining=slots(next,node,oldSource,consumer);}catch(error){effects.warnings.push({nodeId:node.id,label:d.label,message:error.message});continue;}
   const selected=prior[oldIndex??0];if(!selected?.selection||oldIndex===undefined&&prior.length!==1){effects.warnings.push({nodeId:node.id,label:d.label,message:'原素材序号尚未明确，请在运行前检查字段'});continue;}
   const newIndex=remaining.findIndex(item=>same(item.selection,selected.selection));
   if(newIndex>=0){if(oldIndex!==undefined||remaining.length>1)ref.sourceIndex=newIndex;}
   else{ref.sourceNodeId=selected.selection.sourceNodeId;ref.sourceIndex=selected.selection.sourceIndex;if(!currentParents().has(ref.sourceNodeId))addEdge(ref.sourceNodeId,node.id,'保留原素材生产节点');}
   if(ref.sourceNodeId!==oldSource||ref.sourceIndex!==oldIndex)effects.fieldChanges.push({nodeId:node.id,title:node.title,label:d.label,action:newIndex>=0?'preserve-selected-slot':'preserve-original-producer',from:{sourceNodeId:oldSource,...(oldIndex===undefined?{}:{sourceIndex:oldIndex})},to:{sourceNodeId:ref.sourceNodeId,...(ref.sourceIndex===undefined?{}:{sourceIndex:ref.sourceIndex})}});
  }
 }
 if(next.edges.length>5000)throw userError('改组后的连线超过当前容量，未保存');
 syncNativeConnections(next);nativeFlowDependencyOrder(next);refreshInputOrder(next,changedGroups);validateProject(next);assertNoCredentials(next);
 const changed=JSON.stringify(next)!==JSON.stringify(project),requestHash=hash(request),planHash=hash({requestHash,project:next});
 return{project:next,changed,request,requestHash,planHash,effects};
}

export function inputGroupMembershipService({projects,exclusive}){
 async function preview(projectId,body){const p=await projects.load(projectId),plan=planInputGroupMembership(p,body);return{projectId,revision:p.revision,changed:plan.changed,planHash:plan.planHash,effects:plan.effects};}
 async function apply(projectId,body,{automatic=false}={}){return exclusive(projectId,async()=>{
  const p=await projects.load(projectId),request=membershipRequest(body),requestHash=hash(request),receipt=p.settings?.inputGroupEditReceipt;
  if(automatic&&request.mode!=='drag'||!automatic&&request.mode!=='manual')throw userError('成员修改方式与接口不一致');
  if(receipt?.requestId===request.requestId){if(receipt.requestHash!==requestHash||!automatic&&body.planHash!==receipt.planHash)throw userError('此修改编号已用于另一份成员范围',409);return p;}
  const plan=planInputGroupMembership(p,request);
  if(automatic&&request.mode!=='drag'||!automatic&&(typeof body.planHash!=='string'||body.planHash!==plan.planHash))throw userError('成员修改范围已变化，请重新检查',409);
  if(!plan.changed)return p;
  plan.project.revision=p.revision+1;plan.project.updatedAt=new Date().toISOString();plan.project.settings={...plan.project.settings,inputGroupEditReceipt:{version:1,requestId:request.requestId,requestHash,planHash:plan.planHash,mode:request.mode,revision:plan.project.revision,summary:{groups:plan.effects.memberships.length,fields:plan.effects.fieldChanges.length,addedEdges:plan.effects.addedEdges.length,removedEdges:plan.effects.removedEdges.length}}};
  validateProject(plan.project);return projects.save(plan.project);
 });}
 return{preview,apply};
}
