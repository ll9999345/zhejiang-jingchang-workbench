import {nativeNodeIssues} from './native-canvas-core.js';
import {isNativePrompt,nativePromptLlmEnabled} from './native-prompt-core.js';
import {isNativeLoop,nativeLoopSettings} from './native-loop-core.js';
import {nativeMediaVersion} from './native-media-version.js';
import {smartGroupMediaMembers} from './smart-group-media-core.js';

let smartGroupStoredMedia=true;
export function configureSmartGroupStoredMedia(enabled){smartGroupStoredMedia=enabled===true;}
export const smartGroupStoredMediaEnabled=()=>smartGroupStoredMedia;

const mediaKinds=new Set(['image','video','audio']);
const groupTypes=new Set(['group','promptGroup','smart-group']);
const generationTypes=new Set(['generator','midjourney','msgen','comfy','ltxDirector','video','rh','minimax','smart-minimax','smart-image']);
const bindingKeys=['workflowBinding','cloudBinding','imageBinding','llmBinding','studioBinding'];
const migratedIssues=new Set(['原生输出节点接收并展示整组生成结果尚待迁移','原生多素材节点向下游传递整组素材尚待迁移','原生提示词组的聚合语义尚待迁移','原生分组作为输入输出的聚合语义尚待迁移']);
const kindNames={image:'图片',video:'视频',audio:'音频'};
const typeOf=node=>node?.params?.nativeCanvas?.node?.type||node?.type;
const unique=items=>[...new Set(items)];
const kindOf=asset=>String(asset?.type||'').split('/')[0];

// Display-only migration status. Direct generation keeps its existing guard;
// the backend execution plan still decides whether a combination can run.
export function nativeFlowNodeIssues(node,project){
 return nativeNodeIssues(node,project).filter(issue=>!migratedIssues.has(issue));
}

function dependencies(project,nodes,id){
 const node=nodes.get(id);if(!node)throw Error('上游节点不存在，请检查连线');
 const type=typeOf(node),members=groupTypes.has(type)?(node.params?.nativeCanvas?.members||[]).map(ref=>ref.sourceNodeId).filter(memberId=>{
  const member=nodes.get(memberId);if(!member)throw Error('原生分组成员缺失，请检查工作流');
  return type==='smart-group'?typeOf(member)!=='smart-group':type==='group'?['image','prompt','text','script'].includes(typeOf(member))||!member.params?.nativeCanvas&&mediaKinds.has(member.type):true;
 }):[];
 return unique([...(project.edges||[]).filter(edge=>edge.target===id).map(edge=>edge.source),...members]);
}

// Match the runner's semantic dependencies: a group member need not have its
// own edge to the consumer. This describes reachability, not execution readiness.
export function semanticAncestors(project,nodeId){
 const nodes=new Map((project.nodes||[]).map(node=>[node.id,node])),found=new Set(),visiting=new Set(),visited=new Set();
 function visit(id){
  if(visiting.has(id))throw Error('原生分组成员与连线形成循环依赖');
  if(visited.has(id))return;
  visiting.add(id);
  for(const parent of dependencies(project,nodes,id)){found.add(parent);visit(parent);}
  visiting.delete(id);visited.add(id);
 }
 visit(nodeId);return found;
}

function referenceInspector(project,consumer='generator',mediaVersion=nativeMediaVersion(project)){
 if(!['generator','llm','loop'].includes(consumer))throw Error('不支持的参考素材使用方式');
 const nodes=new Map((project.nodes||[]).map(node=>[node.id,node])),assets=new Map((project.assets||[]).map(asset=>[asset.id,asset])),memo=new Map(),visiting=new Set();
 const empty=(blocked=false)=>({kinds:[],assetIds:[],pendingNodeIds:[],slots:[],count:0,grouped:false,dynamic:false,blocked});
 const merge=values=>({kinds:unique(values.flatMap(value=>value.kinds)),assetIds:values.flatMap(value=>value.assetIds),pendingNodeIds:unique(values.flatMap(value=>value.pendingNodeIds)),slots:values.flatMap(value=>value.slots||[]),count:values.reduce((sum,value)=>sum+value.count,0),grouped:false,dynamic:values.some(value=>value.dynamic),blocked:values.some(value=>value.blocked)});
 const assetSummary=ids=>{
  const kinds=ids.map(id=>kindOf(assets.get(id)));
  return{kinds:unique(kinds.filter(kind=>mediaKinds.has(kind))),assetIds:[...ids],pendingNodeIds:[],slots:ids.map((assetId,index)=>({assetId,kind:kinds[index]})),count:ids.length,grouped:ids.length>1,dynamic:false,blocked:kinds.some(kind=>!mediaKinds.has(kind))};
 };
 function stored(node){
  const native=node.params?.nativeCanvas;if(!native)return assetSummary(node.assetId?[node.assetId]:[]);
  const raw=native.node||{},type=typeOf(node),items=type==='image'&&raw.url?[raw.url]:['smart-image','smart-group','output'].includes(type)?raw.images||[]:generationTypes.has(type)?raw.generatedOutputs||raw.images||[]:[];
  if(!Array.isArray(items))return empty(true);
  if(!items.length)return assetSummary(native.mediaAssetIds||[]);
  const ids=[];
  for(const item of items){
   const url=typeof item==='string'?item:item?.url;if(!url)continue;
   const resource=(native.resources||[]).find(ref=>ref.url===url||ref.archive===url||'./'+ref.archive===url);
   if(!resource)return empty(true);
   ids.push(resource.assetId);
  }
  return assetSummary(ids);
 }
 function inspect(id,mode=consumer){
  const memoKey=id+'|'+mode;if(memo.has(memoKey))return memo.get(memoKey);
  const node=nodes.get(id);if(!node||visiting.has(id))return empty(true);
  visiting.add(id);
  const native=node.params?.nativeCanvas,type=typeOf(node),bindings=bindingKeys.filter(key=>node.params?.[key]&&!(key==='llmBinding'&&isNativePrompt(node)&&!nativePromptLlmEnabled(node)));
  let value;
  let blocked=false;
  try{blocked=!!native&&nativeFlowNodeIssues(node,project).length>0;}catch{blocked=true;}
  if(type==='llm'&&native?.node.mode&&native.node.mode!=='node')blocked=true;
  if(blocked||bindings.length>1)value=empty(true);
  else if(bindings.length){
   // A bound node must run again. Its saved preview says nothing about the
   // current result, even if its old file has a different MIME type.
   const parents=dependencies(project,nodes,id).map(parent=>inspect(parent,mode));
   if(parents.some(value=>value.blocked))value=empty(true);
   else if(!mediaKinds.has(node.type))value={...empty(),pendingNodeIds:[id],dynamic:true};
   else{
    const count=node.params.workflowBinding?.count??node.params.workflowBinding?.promptBatch?.values?.length??(node.params.studioBinding?.mode==='image'?node.params.studioBinding.config?.count:1)??1;
    value=Number.isSafeInteger(count)&&count>=1&&count<=64?{kinds:[node.type],assetIds:[],pendingNodeIds:[id],slots:Array.from({length:count},()=>({sourceNodeId:id,kind:node.type})),count,grouped:count>1||!!native&&generationTypes.has(type),dynamic:true,blocked:false}:empty(true);
   }
  }else if(isNativeLoop(node)){
   const settings=nativeLoopSettings(node),connected=unique((project.edges||[]).filter(edge=>edge.target===id).map(edge=>edge.source)),saved=(native.inputOrder||[]).slice().sort((a,b)=>a.index-b.index).map(ref=>ref.sourceNodeId),parents=unique([...saved.filter(id=>connected.includes(id)),...connected]).map(parent=>inspect(parent,'loop')),slots=parents.flatMap(value=>value.slots||[]),slice=(items,size)=>items.slice(settings.start-1,settings.start-1+size),selected=[...(settings.imageInput?slice(type==='smart-loop'?slots:slots.filter(item=>item.kind==='image'),settings.imageBatchSize):[]),...(type!=='smart-loop'&&settings.videoInput?slice(slots.filter(item=>item.kind==='video'),settings.videoBatchSize):[])];
   value={kinds:unique(selected.map(item=>item.kind)),assetIds:selected.flatMap(item=>item.assetId?[item.assetId]:[]),pendingNodeIds:unique(selected.flatMap(item=>item.sourceNodeId?[item.sourceNodeId]:[])),slots:selected,count:selected.length,grouped:true,dynamic:selected.some(item=>item.sourceNodeId),blocked:parents.some(value=>value.blocked)};
  }else if(groupTypes.has(type)){
   const memberIds=dependencies({...project,edges:[]},nodes,id),ordered=type==='smart-group'&&smartGroupStoredMedia&&mediaVersion===2?smartGroupMediaMembers(memberIds.map(id=>nodes.get(id))).map(n=>n.id):memberIds,children=ordered.map(parent=>inspect(parent,mode));
   if(type==='smart-group'&&smartGroupStoredMedia&&mediaVersion===2)children.unshift(stored(node));
   const combined=merge(children);
   value=type==='promptGroup'?{...empty(combined.blocked),pendingNodeIds:combined.pendingNodeIds,dynamic:combined.dynamic}:{...combined,grouped:true};
  }else if(type==='output'){
   const connected=unique((project.edges||[]).filter(edge=>edge.target===id).map(edge=>edge.source));
   const saved=(native?.inputOrder||[]).slice().sort((a,b)=>a.index-b.index).map(ref=>ref.sourceNodeId);
   const incoming=unique([...saved.filter(id=>connected.includes(id)),...connected]);
   const children=incoming.map(parent=>inspect(parent,mode)),history=stored(node);
   const pendingNodeIds=unique(children.flatMap(value=>value.pendingNodeIds));
   const pending=incoming.map(id=>nodes.get(id)).filter((source,index)=>generationTypes.has(typeOf(source))&&mediaKinds.has(source?.type)&&children[index].pendingNodeIds.includes(source.id));
   if(children.some(value=>value.blocked))value=empty(true);
   else{
    // Output nodes are receivers, not ordinary bags: generators select the
    // latest one; LLMs select the latest item of each media kind. Pending
    // results replace that selection without borrowing a stale preview. Only
    // directly connected generators can add results to this receiver; nested
    // receivers/groups remain dependencies, not new output producers.
    const latest=kind=>history.assetIds.findLast(id=>kindOf(assets.get(id))===kind);
    const dynamic=source=>({...empty(),kinds:[source.type],pendingNodeIds:[source.id],slots:[{sourceNodeId:source.id,kind:source.type}],count:1,dynamic:true});
    if(mode==='loop')value=merge([history,...pending.map(source=>children[incoming.indexOf(source.id)])]);
    else if(mode==='generator')value=pending.length?dynamic(pending.at(-1)):assetSummary(history.assetIds.length?[history.assetIds.at(-1)]:[]);
    else value=merge(['image','video','audio'].map(kind=>{
     const source=pending.findLast(source=>source.type===kind),assetId=latest(kind);
     return source?dynamic(source):assetSummary(assetId?[assetId]:[]);
    }));
    value={...value,pendingNodeIds,grouped:true,blocked:value.blocked||history.blocked&&!history.assetIds.length};
   }
  }else if(['image','smart-image','video','audio'].includes(type)||generationTypes.has(type))value=stored(node);
  else value=empty();
  visiting.delete(id);memo.set(memoKey,value);return value;
 }
 return{inspect,assets};
}

export function nativeReferenceChoices(project,nodeId,{kinds=['image','video','audio'],consumer='generator'}={}){
 const ancestors=semanticAncestors(project,nodeId),allowed=new Set(kinds),{inspect}=referenceInspector(project,consumer,nativeMediaVersion(project,project.nodes.find(n=>n.id===nodeId)));
 return(project.nodes||[]).filter(node=>ancestors.has(node.id)).flatMap(node=>{
  const value=inspect(node.id);
  // Mixed groups are indivisible here; never silently discard an unsupported
  // member just to make a source appear compatible with a destination.
  if(value.blocked||!value.count||!value.kinds.length||value.kinds.some(kind=>!allowed.has(kind)))return[];
  const grouped=value.grouped||value.count>1,scope=value.dynamic?'本轮待生成，数量在运行前检查':`${value.count} 份已有素材`;
  return[{value:'node:'+node.id,label:`上游：${node.title||'未命名节点'} · ${grouped?'整组 · ':''}${value.kinds.map(kind=>kindNames[kind]).join(' / ')} · ${scope}`,kinds:[...value.kinds],grouped,dynamic:value.dynamic}];
 });
}

export function nativeReferenceKinds(project,reference,{consumer='generator',nodeId}={}){
 if(!reference||typeof reference!=='object')return[];
 const {inspect,assets}=referenceInspector(project,consumer,nativeMediaVersion(project,project.nodes.find(n=>n.id===nodeId)));
 if(reference.sourceNodeId){const value=inspect(reference.sourceNodeId);return value.blocked?[]:[...value.kinds];}
 const kind=reference.assetId?kindOf(assets.get(reference.assetId)):reference.url?kindOf({type:reference.type||'image/png'}):'';
 return mediaKinds.has(kind)?[kind]:[];
}

const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function nativeReferenceMarkup(step,esc=escapeHtml){
 let details=step?.nativeReferences?.details||step?.nativeDirectorInputs?.details;if(!Array.isArray(details)||!details.length)return'';
 if(step.nativeDirectorInputs?.kind==='ltx'&&step.ltxDirector)details=details.filter(item=>{const [track,id]=String(item.slot||'').split(':');return ['segments','audioSegments'].includes(track)&&(track!=='audioSegments'||step.ltxDirector.useCustomAudio)&&step.ltxDirector[track]?.some(segment=>segment.id===id&&segment.start<step.ltxDirector.durationFrames);});
 if(!details.length)return'';
 let total=0,valid=true;
 const rows=details.map(item=>{
  const dynamic=item.pending===true||item.dynamic===true||item.expectedCount!==undefined,count=dynamic?item.expectedCount:1;
  const known=Number.isSafeInteger(count)&&count>=1&&count<=1000;
  if(known)total+=count;else valid=false;
  const name=item.name||item.sourceName||item.title||(item.assetId?'素材 '+item.assetId:item.sourceNodeId?'上游节点 '+item.sourceNodeId:item.url?'地址参考':'未命名参考');
  const quantity=dynamic?(known?`本轮待生成 · 最多 ${count} 份`:'本轮待生成 · 数量待重新检查'):'已有素材 · 1 份';
  return`<li><strong>${esc(String(name))}</strong><span> · ${esc(kindNames[item.kind]||'未知媒体类型')} · ${esc(quantity)}${dynamic&&Number.isSafeInteger(item.producerIndex)?' · 上游第'+(item.producerIndex+1)+'份':dynamic&&Array.isArray(item.producerIndices)?' · 上游原序号 '+item.producerIndices.map(i=>i+1).join('、'):''}</span></li>`;
 }).join('');
 const automatic=step.nativeDirectorInputs?.automatic;
 const selection=automatic?`<p class="small muted">${automatic.policy==='ordinary'?'自动去重后按原顺序取前15份，并检查9图／3视频／3音频上限。':'自动去重后按类型取前9图／3视频／3音频。'}${Number.isSafeInteger(automatic.duplicates)&&automatic.duplicates>0?` 合并重复 ${automatic.duplicates} 份。`:''}${Number.isSafeInteger(automatic.excluded)&&automatic.excluded>0?` 另有 ${automatic.excluded} 份未选入本次发送。`:''} 全部上游结果仍保留。</p>`:'';
 return`<section class="native-reference-manifest"><p class="small"><strong>本次整组参考发送清单</strong>${valid?` · 最多 ${total} 份`:''}</p>${selection}<ol>${rows}</ol><p class="small muted">按以上顺序传递；待生成项只在本轮上游完整完成后使用，旧预览不会代替新结果。实际数量、媒体类型或文件大小超出确认范围时停止下游提交，上游结果保留。最终以运行前检查为准。</p></section>`;
}
