import {nativeMediaReferenceDescriptors as descriptors,nativeMediaPathKey} from '../public/native-media-map-core.js';
import {nativeMediaMapScope} from './native-media-maps.mjs';
import {nativeMediaRoundViews} from './native-media-rounds.mjs';
import {prepareNativeH3} from './native-director-inputs.mjs';
import {createHash} from 'node:crypto';
import {nativeMediaVersion} from '../public/native-media-version.js';
import {nativeReferenceSelectionSlots} from './native-flow-execution.mjs';
import {normalizeMinimaxTimeline} from '../public/minimax-h3-core.js';
import {validateProject} from './model.mjs';
import {safeId,userError,assertNoCredentials} from './workspace.mjs';

const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
function requestFor(body){
 if(!body||!['project','node'].includes(body.mode)||!safeId(body.requestId)||!Number.isSafeInteger(body.revision)||body.revision<0)throw userError('素材版本修改请求无效');
 const r={mode:body.mode,requestId:body.requestId,revision:body.revision};
 if(r.mode==='node'){
  if(!safeId(body.nodeId)||!['preserve','adopt','refresh','clear'].includes(body.selection))throw userError('请选择节点以及保留原素材或采用新范围');
  Object.assign(r,{nodeId:body.nodeId,selection:body.selection});
 }
 assertNoCredentials(r);return r;
}
const priorIndex=(p,id,path)=>descriptors(p.nodes.find(n=>n.id===id)).find(d=>nativeMediaPathKey(d.path)===nativeMediaPathKey(path)).ref.sourceIndex??0;
const identity=s=>JSON.stringify([s.selection?.sourceNodeId,s.selection?.sourceIndex,s.kind]);
const shown=slots=>slots.map(s=>({kind:s.kind,...(s.assetId?{assetId:s.assetId,name:s.name}:{sourceNodeId:s.sourceNodeId,pending:true,producerIndex:s.selection?.sourceIndex,...(s.name?{name:s.name}:{})}),...(s.selection?{selection:structuredClone(s.selection)}:{})}));

// Pure local preview. No media is uploaded, executed, reordered or removed.
export function planNativeMediaMigration(project,body,{preservedMap}={}){
 const request=requestFor(body);validateProject(project);assertNoCredentials(project);
 if(project.revision!==request.revision)throw userError('画布已更新，请重新检查素材版本',409);
 const next=structuredClone(project),effects={pinned:[],fields:[],rounds:[],automatic:[],warnings:[],blocked:[]};
 if(request.mode==='project'){
  // Pin every existing node, including currently unbound nodes. Upgrading the
  // default must not alter an existing inspector or a future rebind implicitly.
  for(const n of next.nodes){const version=nativeMediaVersion(project,n);if(n.params?.nativeMediaVersion===undefined){n.params={...n.params,nativeMediaVersion:version};effects.pinned.push({nodeId:n.id,title:n.title,version});}}
  next.settings.nativeMediaVersion=2;
 }else{
  const node=next.nodes.find(n=>n.id===request.nodeId),old=project.nodes.find(n=>n.id===request.nodeId);
  if(!node)throw userError('节点不存在');
  if(request.selection==='clear'){
   const map=node.params?.nativeMediaMap;if(map){delete node.params.nativeMediaMap;effects.warnings.push('取消逐轮选图后，各轮使用字段里当前显示的序号；请核对字段后再运行。');}
  }else if(request.selection==='refresh'){
   const map=node.params?.nativeMediaMap;if(!map)throw userError('此节点没有逐轮选图记录');
   const working=structuredClone(project),target=working.nodes.find(n=>n.id===node.id),refs=descriptors(target);
   if(refs.filter(d=>!d.collection).length!==map.fields.length)throw userError('素材字段清单已变化，请取消逐轮选图后重新选择');
   for(const field of map.fields){const d=refs.find(d=>nativeMediaPathKey(d.path)===nativeMediaPathKey(field.path));if(!d||d.ref.sourceNodeId!==field.sourceNodeId)throw userError('原字段或来源已变更，请取消逐轮选图后重新选择');d.ref.sourceIndex=field.originalSourceIndex;}
   delete target.params.nativeMediaMap;target.params.nativeMediaVersion=1;
   const refreshed=planNativeMediaMigration(working,{...request,selection:'preserve'},{preservedMap:map});refreshed.request=request;refreshed.requestHash=digest(request);refreshed.planHash=refreshed.canApply?digest({request,project:refreshed.project}):null;refreshed.changed=refreshed.canApply&&JSON.stringify(refreshed.project)!==JSON.stringify(project);refreshed.effects.warnings.push('按原来保留的选择重新核对各轮；按保存的素材身份定位，不按重新排序后的第一格选图。只有确认后才更新记录。');return refreshed;
  }else
  if(nativeMediaVersion(project,old)!==2){
   let views=[];try{views=nativeMediaRoundViews(project,old.id);}catch(e){effects.blocked.push(e.message);}
   const mapped=new Map(),mappedRounds=new Map(),targetDescriptors=descriptors(node);
   const automaticIdentity=item=>JSON.stringify([item.assetId||item.url||null,item.sourceNodeId||null,item.producerIndex??null,item.kind]);
   for(const view of views){
    const round=Object.fromEntries(['loopId','roundIndex','index','total','excluded','nativeBranch'].filter(k=>view[k]!==undefined).map(k=>[k,structuredClone(view[k])]));effects.rounds.push(round);
    if(view.excluded)continue;
    const original=view.project.nodes.find(n=>n.id===old.id),candidate=structuredClone(original),prior=descriptors(original),after=descriptors(candidate);candidate.params={...candidate.params,nativeMediaVersion:2};
    for(let i=0;i<prior.length;i++){
     const a=prior[i],b=after[i],consumer=a.collection&&old.params?.llmBinding?'llm':'loop';
     let before,complete;try{before=nativeReferenceSelectionSlots(view.project,original,a.ref.sourceNodeId,{consumer,mediaVersion:1,loopContexts:view.loopContexts});complete=nativeReferenceSelectionSlots(view.project,original,a.ref.sourceNodeId,{consumer,mediaVersion:2,loopContexts:view.loopContexts});}catch(e){effects.blocked.push((view.loopId?'第'+(view.roundIndex+1)+'轮 ':'')+a.label+'：'+e.message);continue;}
     const entry={label:a.label,sourceNodeId:a.ref.sourceNodeId,before:shown(before),after:shown(complete),collection:a.collection,...round};
     if(a.collection){
      if(request.selection==='preserve'&&JSON.stringify(before.map(identity))!==JSON.stringify(complete.map(identity)))effects.blocked.push('整组参考范围将变化，无法用一个素材序号保留；请检查范围后选择采用新范围'+(view.loopId?'（第'+(view.roundIndex+1)+'轮）':''));
     }else{
      const savedField=preservedMap?.fields.find(f=>nativeMediaPathKey(f.path)===nativeMediaPathKey(a.path)),savedRound=savedField?.rounds.find(r=>r.roundIndex===view.roundIndex),saved=savedRound?.selection;
      if(preservedMap&&(!saved||!saved.kind||preservedMap.loopId!==view.loopId)){effects.blocked.push('本轮没有可核对的原素材身份，请取消逐轮选图后重新选择');effects.fields.push(entry);continue;}
      const selected=saved?{selection:{sourceNodeId:saved.sourceNodeId,sourceIndex:saved.sourceIndex},kind:saved.kind,...(saved.assetId?{assetId:saved.assetId,name:project.assets.find(a=>a.id===saved.assetId)?.name}:{})}:before[a.ref.sourceIndex??0];
      if(saved)entry.retainedSelection=shown([selected])[0];
      if(!selected||!saved&&a.ref.sourceIndex===undefined&&before.length!==1)effects.blocked.push(a.label+'原素材选择不明确，请先修复字段');
      else if(request.selection==='preserve'){
       const indices=complete.flatMap((s,index)=>identity(s)===identity(selected)?[index]:[]);
       if(indices.length!==1)effects.blocked.push((view.loopId?'第'+(view.roundIndex+1)+'轮 ':'')+a.label+'无法唯一保留原素材，请检查完整范围');
       else {entry.fromIndex=a.ref.sourceIndex??0;entry.toIndex=indices[0];if(a.ref.sourceIndex!==undefined||complete.length!==1)b.ref.sourceIndex=indices[0];if(!mapped.has(i))mapped.set(i,new Set());mapped.get(i).add(indices[0]);if(!mappedRounds.has(i))mappedRounds.set(i,[]);mappedRounds.get(i).push({roundIndex:view.roundIndex,index:view.index,sourceIndex:indices[0],selection:{...selected.selection,kind:selected.kind,...(selected.assetId?{assetId:selected.assetId}:{})}});}
      }else if(!complete[a.ref.sourceIndex??0])effects.blocked.push((view.loopId?'第'+(view.roundIndex+1)+'轮 ':'')+a.label+'新范围内没有所选序号');
     }
     effects.fields.push(entry);
    }
    const h3Of=n=>[n.params?.minimaxH3,n.params?.workflowBinding?.minimaxH3,n.params?.cloudBinding?.minimaxH3].find(Boolean),h3=h3Of(original);
    if(h3&&normalizeMinimaxTimeline(h3).autoUpstream){
     try{
      const before=prepareNativeH3(view.project,original,h3,{planning:true,loopContexts:view.loopContexts,mediaVersion:1}).ledger,complete=prepareNativeH3(view.project,candidate,h3Of(candidate),{planning:true,loopContexts:view.loopContexts,mediaVersion:2}).ledger;
      if(before.automatic||complete.automatic){
       const candidates=ledger=>ledger.automatic?.candidates||ledger.details,display=items=>items.map(item=>({kind:item.kind,...(item.assetId?{assetId:item.assetId,name:item.name}:{sourceNodeId:item.sourceNodeId,pending:true,producerIndex:item.producerIndex})}));
       effects.automatic.push({...round,policy:complete.automatic?.policy||before.automatic?.policy,before:display(before.details),after:display(complete.details),beforeCandidates:display(candidates(before)),afterCandidates:display(candidates(complete)),beforeExcluded:before.automatic?.excluded??0,afterExcluded:complete.automatic?.excluded??0});
       if(request.selection==='preserve'&&(JSON.stringify(before.details.map(automaticIdentity))!==JSON.stringify(complete.details.map(automaticIdentity))||JSON.stringify(candidates(before).map(automaticIdentity))!==JSON.stringify(candidates(complete).map(automaticIdentity))))effects.blocked.push('H3自动参考候选或发送范围变化，请逐轮检查后明确采用完整范围'+(view.loopId?'（第'+(view.roundIndex+1)+'轮）':''));
      }
     }catch(e){effects.blocked.push('H3自动参考：'+e.message);}
    }
   }
   if(!views.some(view=>!view.excluded)&&!effects.blocked.length)effects.blocked.push('此节点未被任何回合选中，请先核对分支设置');
   const varying=[...mapped.values()].some(indices=>indices.size>1);
   if(request.selection==='preserve')for(const [i,indices]of mapped){
    const d=targetDescriptors[i];if(d.ref.sourceIndex!==undefined||effects.fields.some(f=>!f.collection&&f.after.length>1))d.ref.sourceIndex=[...indices][0];
    if(varying){const rounds=mappedRounds.get(i),loopIds=new Set(views.filter(v=>!v.excluded).map(v=>v.loopId));if(loopIds.size!==1||!views[0]?.loopId)effects.blocked.push('逐轮选图需要唯一原生循环');else{node.params.nativeMediaMap??={version:1,loopId:views[0].loopId,scopeHash:'0'.repeat(64),fields:[]};node.params.nativeMediaMap.fields.push({path:d.path,sourceNodeId:d.ref.sourceNodeId,sourceIndex:d.ref.sourceIndex,originalSourceIndex:priorIndex(project,old.id,d.path),rounds});}}
   }
   node.params={...node.params,nativeMediaVersion:2};
   if(node.params.nativeMediaMap)node.params.nativeMediaMap.scopeHash=nativeMediaMapScope(next,node);
  }
 }
 effects.blocked=[...new Set(effects.blocked)];
 if(effects.blocked.length)return{project:structuredClone(project),changed:false,request,requestHash:digest(request),planHash:null,effects,canApply:false};
 validateProject(next);assertNoCredentials(next);
 return{project:next,changed:JSON.stringify(next)!==JSON.stringify(project),request,requestHash:digest(request),planHash:digest({request,project:next}),effects,canApply:true};
}
export function nativeMediaMigrationService({projects,exclusive}){
 async function preview(id,body){const p=await projects.load(id),plan=planNativeMediaMigration(p,body);return{projectId:id,revision:p.revision,changed:plan.changed,planHash:plan.planHash,effects:plan.effects,canApply:plan.canApply};}
 async function apply(id,body){return exclusive(id,async()=>{
  const p=await projects.load(id),request=requestFor(body),requestHash=digest(request),receipt=p.settings?.nativeMediaEditReceipt;
  if(receipt?.requestId===request.requestId){if(receipt.requestHash!==requestHash||receipt.planHash!==body.planHash)throw userError('此修改编号已用于另一份素材版本范围',409);return p;}
  const plan=planNativeMediaMigration(p,request);
  if(!plan.canApply)throw userError(plan.effects.blocked.join('；'),409);
  if(!body.planHash||body.planHash!==plan.planHash)throw userError('素材范围已变化，请重新检查',409);
  if(!plan.changed)return p;
  plan.project.revision=p.revision+1;plan.project.updatedAt=new Date().toISOString();plan.project.settings.nativeMediaEditReceipt={version:1,requestId:request.requestId,requestHash,planHash:plan.planHash,revision:plan.project.revision};
  return projects.save(plan.project);
 });}
 return{preview,apply};
}
