import {createHash} from 'node:crypto';
import {editSmartGroupStructure,isSmartGroup,smartGroupMediaEntries} from '../public/smart-group-core.js';
import {nativeMediaVersion} from '../public/native-media-version.js';
import {nativeMediaReferenceDescriptors,nativeMediaPathKey} from '../public/native-media-map-core.js';
import {nativeReferenceSelectionSlots,nativeExecutionAncestors} from './native-flow-execution.mjs';
import {nativeMediaRoundViews} from './native-media-rounds.mjs';
import {applyNativeMediaMaps,validNativeMediaMapIds,nativeMediaMapScope} from './native-media-maps.mjs';
import {nativeFlowDependencyOrder} from './native-flow.mjs';
import {validateProject} from './model.mjs';
import {safeId,userError,assertNoCredentials} from './workspace.mjs';
import {planInputGroupMembership,refreshDisplayGroups} from './input-group-membership.mjs';

const canonical=(v,depth=0)=>{if(depth>100)throw userError('智能组记录层级过深');return Array.isArray(v)?v.map(x=>canonical(x,depth+1)):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k],depth+1)])):v;};
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const get=(root,path)=>path.reduce((v,key)=>v?.[key],root);
const set=(root,path,value)=>{const parent=get(root,path.slice(0,-1));if(!parent)throw userError('素材字段已变化');parent[path.at(-1)]=value;};
const raw=n=>n?.params?.nativeCanvas?.node||n;
export function smartGroupRequest(body){
 assertNoCredentials(body);
 const modes=['create','absorb','release','release-item','detach','arrange','move','resize','drag','thumb-drag'];
 if(!body||!modes.includes(body.mode)||!safeId(body.requestId)||!Number.isSafeInteger(body.revision)||body.revision<0)throw userError('智能组修改请求无效');
 const r={mode:body.mode,requestId:body.requestId,revision:body.revision};
 if(!['create','drag'].includes(body.mode)){if(!safeId(body.groupId))throw userError('智能组编号无效');r.groupId=body.groupId;}
 if(body.mode==='drag'){
  if(!safeId(body.primaryId)||!Array.isArray(body.positions)||!body.positions.length||body.positions.length>1500||body.positions.some(v=>!v||!safeId(v.id)||![v.x,v.y].every(x=>Number.isFinite(x)&&Math.abs(x)<=1e7))||new Set(body.positions.map(v=>v.id)).size!==body.positions.length||!body.positions.some(v=>v.id===body.primaryId))throw userError('智能组拖动范围无效');
  r.primaryId=body.primaryId;r.positions=body.positions.map(({id,x,y})=>({id,x,y}));
  if(body.ctrlDrag!==undefined){if(typeof body.ctrlDrag!=='boolean')throw userError('Ctrl 拖动状态无效');r.ctrlDrag=body.ctrlDrag;}
  if(body.ctrlDrag){if(!body.pointer||![body.pointer.x,body.pointer.y].every(n=>Number.isFinite(n)&&Math.abs(n)<=1e7))throw userError('Ctrl 拖动指针无效');r.pointer={x:body.pointer.x,y:body.pointer.y};}
  if(body.selectionIds!==undefined){if(!Array.isArray(body.selectionIds)||!body.selectionIds.length||new Set(body.selectionIds).size!==body.selectionIds.length||body.selectionIds.some(id=>!r.positions.some(v=>v.id===id)))throw userError('拖动选区无效');r.selectionIds=[...body.selectionIds];}
 }
 if(body.draft!==undefined){if(!['drag','resize','thumb-drag'].includes(body.mode)||!body.draft||typeof body.draft!=='object'||Array.isArray(body.draft))throw userError('手势起点草稿无效');r.draft=structuredClone(body.draft);}
 if(['create','absorb','detach'].includes(body.mode)){if(!Array.isArray(body.nodeIds)||!body.nodeIds.length||body.nodeIds.length>1500||body.nodeIds.some(id=>!safeId(id))||new Set(body.nodeIds).size!==body.nodeIds.length)throw userError('智能组成员选区无效');r.nodeIds=[...body.nodeIds];}
 if(body.mode==='create'){if(typeof body.title!=='string'||!body.title.trim()||body.title.trim().length>120)throw userError('组名称须为1–120个字符');r.title=body.title.trim();}
 if(['release-item','thumb-drag'].includes(body.mode)){if(!Number.isSafeInteger(body.index)||body.index<0||body.index>999)throw userError('组内素材序号无效');r.index=body.index;}
 if(['move','thumb-drag'].includes(body.mode)){for(const key of ['x','y']){if(!Number.isFinite(body[key])||Math.abs(body[key])>1e7)throw userError('分组坐标无效');r[key]=body[key];}}
 if(body.mode==='thumb-drag'){if(!safeId(body.assetId))throw userError('拖出素材编号无效');r.assetId=body.assetId;if(body.naturalSize!==undefined){if(!body.naturalSize||![body.naturalSize.width,body.naturalSize.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=1000000))throw userError('媒体自然尺寸无效');r.naturalSize={width:body.naturalSize.width,height:body.naturalSize.height};}}
 if(body.mode==='resize'){for(const key of ['width','height']){if(!Number.isFinite(body[key])||body[key]<(key==='width'?150:130)||body[key]>100000)throw userError('智能组尺寸无效');r[key]=body[key];}}
 if(body.rects!==undefined){if(!body.rects||typeof body.rects!=='object'||Array.isArray(body.rects)||Object.keys(body.rects).length>1500)throw userError('节点尺寸清单无效');r.rects=Object.create(null);for(const [id,v]of Object.entries(body.rects)){if(!safeId(id)||!v||![v.width,v.height].every(x=>Number.isFinite(x)&&x>0&&x<=100000))throw userError('节点尺寸无效');Object.defineProperty(r.rects,id,{value:{width:v.width,height:v.height},enumerable:true});}}
 assertNoCredentials(r);return r;
}
function fieldDescriptors(node){
 const rows=nativeMediaReferenceDescriptors(node);for(const key of ['workflowBinding','studioBinding']){const ref=node.params?.[key]?.imageEnhance?.source;if(ref?.sourceNodeId)rows.push({ref,path:[key,'imageEnhance','source'],label:'增强原图',collection:false});}return rows;
}
function staticSelection(project,node,descriptor){
 const all=[];
 for(const view of nativeMediaRoundViews(project,node.id)){
  if(view.excluded)continue;
  const effective=applyNativeMediaMaps(view.project,{proofProject:project,nodeId:node.id,loopId:view.loopId,roundIndex:view.roundIndex,loopContexts:view.loopContexts}),consumer=effective.nodes.find(n=>n.id===node.id),ref=get(consumer.params,descriptor.path);
  if(!ref?.sourceNodeId)throw userError('原字段来源已变化');
  const slots=nativeReferenceSelectionSlots(effective,consumer,ref.sourceNodeId,{loopContexts:view.loopContexts,consumer:descriptor.path[0]==='llmBinding'?'llm':'generator'}),selected=descriptor.collection&&ref.sourceIndex===undefined?slots:ref.sourceIndex===undefined?(slots.length===1?slots:[]):slots[ref.sourceIndex]?[slots[ref.sourceIndex]]:[];
  if(!selected.length||selected.some(item=>!item.assetId))throw userError('原选择包含尚未确认的生成结果或未明确序号，请先选择已有素材');
  const ids=selected.map(item=>item.assetId);if(all.length&&JSON.stringify(all[0])!==JSON.stringify(ids))throw userError('各轮原素材不同，不能改成同一固定素材；请先逐轮核对');all.push(ids);
 }
 if(!all.length)throw userError('该字段没有可核对的有效回合');return all[0];
}
function fixedRef(ref,assetId){const result=structuredClone(ref);for(const key of ['sourceNodeId','sourceIndex','expectedCount'])delete result[key];result.assetId=assetId;return result;}
function keepMapProofs(before,next,effects){
 const valid=new Set(validNativeMediaMapIds(before));
 for(const node of next.nodes.filter(n=>n.params?.nativeMediaMap)){
  const map=node.params.nativeMediaMap;let consistent=valid.has(node.id);
  try{for(const view of nativeMediaRoundViews(next,node.id)){if(view.excluded)continue;if(view.loopId!==map.loopId)throw Error();for(const field of map.fields){const ref=get(node.params,field.path),row=field.rounds.find(r=>r.roundIndex===view.roundIndex&&r.index===view.index);if(!row?.selection.kind||ref?.sourceNodeId!==field.sourceNodeId||ref.sourceIndex!==field.sourceIndex)throw Error();const slots=nativeReferenceSelectionSlots(view.project,node,ref.sourceNodeId,{loopContexts:view.loopContexts,mediaVersion:2}),slot=slots[row.sourceIndex];if(!slot||slot.selection.sourceNodeId!==row.selection.sourceNodeId||slot.selection.sourceIndex!==row.selection.sourceIndex||slot.kind!==row.selection.kind||row.selection.assetId!==undefined&&slot.assetId!==row.selection.assetId)throw Error();}}}catch{consistent=false;}
  if(consistent)map.scopeHash=nativeMediaMapScope(next,node);else effects.recheckNodeIds.push(node.id);
 }
}
export function planSmartGroupLifecycle(project,body){
 validateProject(project);assertNoCredentials(project);const request=smartGroupRequest(body);if(project.revision!==request.revision)throw userError('画布已在另一窗口变化，请重新检查智能组',409);
 const stored=project;
 if(request.draft){if(request.draft.id!==project.id||request.draft.revision!==project.revision)throw userError('手势起点版本已变化',409);validateProject(request.draft);assertNoCredentials(request.draft);project={...structuredClone(request.draft),id:stored.id,createdAt:stored.createdAt};}
 const before=structuredClone(project),ids=new Set(before.nodes.map(n=>n.id));if(request.nodeIds?.some(id=>!ids.has(id))||request.positions?.some(row=>!ids.has(row.id)))throw userError('选中的节点已不存在');
 if(request.mode==='thumb-drag'){const group=before.nodes.find(n=>n.id===request.groupId);if(!isSmartGroup(group))throw userError('请选择智能分组');const entry=smartGroupMediaEntries(before,group).find(r=>r.sourceNodeId===group.id&&r.index===request.index);if(!entry||entry.assetId!==request.assetId)throw userError('组内素材身份已变化，请重新拖动',409);}
 const used=new Set([...ids,...before.nodes.map(n=>String(raw(n).id)),...before.edges.map(e=>e.id),...(before.groups||[]).map(g=>g.id)]);let serial=0;const idFactory=()=>{let id;do{id='sg-'+hash({projectId:project.id,requestId:request.requestId,revision:request.revision,serial:serial++}).slice(0,40);}while(used.has(id));used.add(id);return id;};
 const result=editSmartGroupStructure(before,request,{idFactory,rects:request.rects});let next=result.project,ordinary;
 if(request.mode==='drag'&&request.positions.some(row=>next.nodes.some(n=>n.id===row.id))&&before.nodes.some(n=>n.params?.nativeCanvas?.format==='infinite-canvas-workflow'&&['group','promptGroup'].includes(raw(n).type))){ordinary=planInputGroupMembership(before,{mode:'drag',revision:request.revision,requestId:request.requestId,draft:next,movedIds:request.positions.map(row=>row.id).filter(id=>next.nodes.some(n=>n.id===id)),rects:request.rects});next=result.project=ordinary.project;}
 const effects={...result.effects,ordinaryMemberships:ordinary?.effects.memberships||[],fieldChanges:[],blocked:[],warnings:[],recheckNodeIds:[],retainedMapNodeIds:[],addedFieldEdges:[],newNodeDefaultUpgraded:false};
 if((['create','absorb','drag'].includes(request.mode)||request.mode==='thumb-drag'&&effects.absorbedNodeIds.length)&&(effects.createdNodeIds.length||effects.absorbedNodeIds.length||effects.mergedGroupIds.length||effects.addedMemberIds.length)){
  if(project.settings.nativeMediaVersion!==2){for(const node of next.nodes){const old=project.nodes.find(n=>n.id===node.id);if(old){node.params??={};node.params.nativeMediaVersion=nativeMediaVersion(project,old);}}next.settings.nativeMediaVersion=2;effects.newNodeDefaultUpgraded=true;}
  const group=next.nodes.find(n=>n.id===result.groupId);if(group)group.params.nativeMediaVersion=2;
 }
 const removed=new Set(effects.removedNodeIds),changedGroups=new Set(project.nodes.filter(isSmartGroup).filter(old=>{const current=next.nodes.find(n=>n.id===old.id);return !current||JSON.stringify(smartGroupMediaEntries(project,old).map(r=>[r.sourceNodeId,r.index,r.item.url]))!==JSON.stringify(smartGroupMediaEntries(next,current).map(r=>[r.sourceNodeId,r.index,r.item.url]))||JSON.stringify(old.params.nativeCanvas.members)!==JSON.stringify(current.params.nativeCanvas.members);}).map(n=>n.id));
 if(effects.connectionGesture?.kind==='merge-images')changedGroups.add(effects.connectionGesture.targetId);
 for(const old of project.nodes.filter(n=>n.params?.nativeCanvas&&['group','promptGroup'].includes(raw(n).type))){const now=next.nodes.find(n=>n.id===old.id);if(now&&JSON.stringify(now.params.nativeCanvas.members)!==JSON.stringify(old.params.nativeCanvas.members))changedGroups.add(old.id);}
 const affected=(node,descriptor)=>{const ref=descriptor.ref;if(removed.has(ref.sourceNodeId)||changedGroups.has(ref.sourceNodeId))return true;try{return nativeExecutionAncestors(project,node.id).has(ref.sourceNodeId)&&!nativeExecutionAncestors(next,node.id).has(ref.sourceNodeId);}catch{return true;}};
 for(const original of project.nodes){
  const node=next.nodes.find(n=>n.id===original.id);if(!node)continue;const descriptors=fieldDescriptors(original),chosen=descriptors.filter(d=>affected(original,d)),cloud=chosen.some(d=>d.path[0]==='cloudBinding'&&d.path[1]==='inputs');
  if(cloud&&nativeMediaVersion(next,node)!==2){node.params.nativeMediaVersion=2;for(const d of descriptors)if(!chosen.includes(d))chosen.push(d);}
  const updates=[];
  for(const d of chosen){
   try{
    const selected=staticSelection(project,original,d),ref=get(node.params,d.path);if(!ref)throw userError('当前字段已变化');
    if(d.path[0]==='cloudBinding'&&d.path[1]==='inputs'){
     const preferred=next.nodes.find(n=>n.id===d.ref.sourceNodeId)||next.nodes.find(n=>n.id===result.groupId),candidates=[preferred,...next.nodes.filter(n=>result.effects.createdNodeIds.includes(n.id))].filter(Boolean);let match;
     for(const source of candidates){const slots=nativeReferenceSelectionSlots(next,node,source.id,{mediaVersion:2}),index=slots.findIndex(item=>item.assetId===selected[0]);if(index>=0){match={source,index};break;}}
     if(!match)throw userError('云字段尚无可保留的素材来源，请先重新选择字段');
     ref.sourceNodeId=match.source.id;ref.sourceIndex=match.index;
     if(!nativeExecutionAncestors(next,node.id).has(match.source.id)){const id=idFactory();next.edges.push({id,source:match.source.id,target:node.id});effects.addedFieldEdges.push(id);}
    }else if(d.collection){if(new Set(selected).size!==selected.length)throw userError('原参考范围包含重复素材，请先检查');updates.push({path:d.path,refs:selected.map(id=>fixedRef(ref,id))});}
    else{if(selected.length!==1)throw userError('单素材字段原选择不唯一');set(node.params,d.path,fixedRef(ref,selected[0]));}
    effects.fieldChanges.push({nodeId:node.id,title:node.title,path:d.path,label:d.label,assetIds:selected,action:d.path[0]==='cloudBinding'&&d.path[1]==='inputs'?'preserve-cloud-source':'keep-original-assets'});
   }catch(error){effects.blocked.push({nodeId:node.id,title:node.title,label:d.label,message:error.message});}
  }
  for(const update of updates.sort((a,b)=>b.path.at(-1)-a.path.at(-1))){const array=get(node.params,update.path.slice(0,-1));array.splice(update.path.at(-1),1,...update.refs);}
  if(node.params?.nativeMediaMap){const keys=new Set(effects.fieldChanges.filter(f=>f.nodeId===node.id).map(f=>nativeMediaPathKey(f.path)));node.params.nativeMediaMap.fields=node.params.nativeMediaMap.fields.filter(f=>!keys.has(nativeMediaPathKey(f.path)));if(!node.params.nativeMediaMap.fields.length)delete node.params.nativeMediaMap;}
 }
 // Preserve the source's edge deletion on release, while adapter-specific cloud
 // fields keep their explicit static source edge after the preview confirms it.
 refreshDisplayGroups(before,next,idFactory);
 try{nativeFlowDependencyOrder(next);validateProject(next);assertNoCredentials(next);keepMapProofs(project,next,effects);validateProject(next);}catch(error){effects.blocked.push({message:error.message});}
 for(const id of effects.removedNodeIds){const old=project.nodes.find(n=>n.id===id);if(['workflowBinding','cloudBinding','imageBinding','llmBinding','studioBinding'].some(k=>old?.params?.[k]))effects.warnings.push('原卡片“'+old.title+'”的生成绑定将退出当前画布；素材保留，原卡片可从项目历史或撤销恢复。');}
 if(effects.recheckNodeIds.length)effects.warnings.push('部分逐轮选择需要在编辑后重新检查；运行保护不会猜选其他素材。');
 const requestHash=hash(request),planHash=hash({requestHash,project:next}),changed=JSON.stringify(next)!==JSON.stringify(stored);
 return{...result,project:next,request,requestHash,planHash,changed,canApply:effects.blocked.length===0,effects};
}
export function smartGroupLifecycleService({projects,exclusive}){
 async function preview(projectId,body){const p=await projects.load(projectId),plan=planSmartGroupLifecycle(p,body);return{projectId,revision:p.revision,groupId:plan.groupId,selection:plan.selection,changed:plan.changed,canApply:plan.canApply,effects:plan.effects,planHash:plan.planHash};}
 async function apply(projectId,body,{automatic=false}={}){return exclusive(projectId,async()=>{const p=await projects.load(projectId),request=smartGroupRequest(body),requestHash=hash(request),receipt=p.settings?.smartGroupEditReceipt;if(automatic&&!['drag','resize','thumb-drag'].includes(request.mode))throw userError('此操作不能通过手势保存');if(receipt?.requestId===request.requestId){if(receipt.requestHash!==requestHash||!automatic&&body.planHash!==receipt.planHash)throw userError('修改编号已用于另一份智能组范围',409);return p;}const plan=planSmartGroupLifecycle(p,request);if(!plan.canApply)throw userError('智能组字段尚待核对，原画布保持',409);if(!automatic&&body.planHash!==plan.planHash)throw userError('智能组范围已变化，请重新检查',409);if(!plan.changed)return p;plan.project.revision=p.revision+1;plan.project.updatedAt=new Date().toISOString();plan.project.settings.smartGroupEditReceipt={version:1,requestId:request.requestId,requestHash,planHash:plan.planHash,mode:request.mode,revision:plan.project.revision,groupId:plan.groupId,nodeIds:plan.selection};validateProject(plan.project);return projects.save(plan.project);});}
 return{preview,apply};
}
