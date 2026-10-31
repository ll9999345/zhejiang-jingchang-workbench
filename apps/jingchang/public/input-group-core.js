import {syncNativeConnections} from './native-canvas-core.js';

const safeId=v=>typeof v==='string'&&/^[\w-]{1,100}$/.test(v);
const typeOf=n=>n?.params?.nativeCanvas?.node.type||n?.type;
const sourceGenerators=new Set(['generator','midjourney','msgen','comfy','ltxDirector','video','rh','minimax']);
const localGenerator=n=>!n.params?.nativeCanvas&&['workflowBinding','cloudBinding','imageBinding','studioBinding'].some(k=>n.params?.[k]);
const eligible=(n,kind)=>kind==='promptGroup'?['prompt','text','script'].includes(typeOf(n)):['image','prompt','text','script'].includes(typeOf(n));
const groupTypes=new Set(['group','promptGroup','smart-group']);
const nativeId=n=>n.params?.nativeCanvas?.node.id??n.id;

export function inputGroupMemberIds(project,nodeIds,{smartGroups=false}={}){
 const byId=new Map(project.nodes.map(n=>[n.id,n])),result=new Set(),visiting=new Set();
 function visit(id){if(visiting.has(id))throw Error('输入组包含循环');if(result.has(id))return;const n=byId.get(id);if(!n)throw Error('输入组成员已失效');visiting.add(id);result.add(id);if(['group','promptGroup'].includes(typeOf(n))||smartGroups&&typeOf(n)==='smart-group')for(const ref of n.params.nativeCanvas.members||[])if(typeOf(n)!=='smart-group'||typeOf(byId.get(ref.sourceNodeId))!=='smart-group')visit(ref.sourceNodeId);visiting.delete(id);}
 for(const id of nodeIds)visit(id);return [...result];
}

// Editing only: creates a semantic input group, never executes a node. All
// changes are calculated on a copy so failure cannot leave half a handoff.
export function createInputGroup(project,nodeIds,{kind='group',title='输入组',rects={},point={x:180,y:180},idFactory=()=>crypto.randomUUID()}={}){
 if(!project||!Array.isArray(project.nodes)||!Array.isArray(project.edges)||!Array.isArray(nodeIds)||!['group','promptGroup'].includes(kind)||!rects||!point||typeof idFactory!=='function')throw Error('输入组参数无效');
 if(project.nodes.length>=1500||project.edges.length>5000)throw Error('画布容量不足，未创建输入组');
 if(typeof title!=='string'||!title.trim()||title.trim().length>120)throw Error('输入组名称须为1–120个字符');
 const nodes=new Map(project.nodes.map(n=>[n.id,n]));if(nodes.size!==project.nodes.length||project.nodes.some(n=>!safeId(n.id)||!Number.isFinite(n.x)||!Number.isFinite(n.y)))throw Error('画布节点无效');
 const ids=[...new Set(nodeIds)];if(ids.some(id=>!safeId(id)||!nodes.has(id)))throw Error('选区已变化，请重新选择节点');
 const members=ids.map(id=>nodes.get(id)).filter(n=>eligible(n,kind)),memberIds=new Set(members.map(n=>n.id));
 if(members.some(n=>n.params?.nativeCanvas&&n.params.nativeCanvas.format!=='infinite-canvas-workflow'))throw Error('普通输入组不能混入智能画布节点');
 // Shared semantic membership has different source rules and is deliberately
 // not guessed. Existing visual-only grouping does not restrict input groups.
 if(project.nodes.some(n=>groupTypes.has(typeOf(n))&&(n.params.nativeCanvas.members||[]).some(r=>memberIds.has(r.sourceNodeId))))throw Error('选区已属于原生输入组；请选择尚未入组的成员，原组保持');
 for(const g of project.groups||[])if(g.nodeIds.some(id=>memberIds.has(id))&&!g.nodeIds.every(id=>memberIds.has(id)))throw Error('选区只包含视觉组部分成员，请先选择整组；未改变原组');
 const usedIds=new Set([...nodes.keys(),...project.nodes.map(n=>String(nativeId(n))),...project.edges.map(e=>e.id),...(project.groups||[]).map(g=>g.id)]);
 const newId=()=>{const id=idFactory();if(!safeId(id)||usedIds.has(id))throw Error('新编号重复或无效，未创建输入组');usedIds.add(id);return id;};
 const size=(v,fallback)=>Number.isFinite(v)&&v>0&&v<=100000?v:fallback;
 const rs=members.map(n=>{const r=rects instanceof Map?rects.get(n.id):rects[n.id];return{x:n.x,y:n.y,w:size(r?.width,size(n.w,288)),h:size(r?.height,size(n.h,270))};});
 const x=rs.length?Math.min(...rs.map(r=>r.x))-24:point.x,y=rs.length?Math.min(...rs.map(r=>r.y))-58:point.y;
 const w=rs.length?Math.max(...rs.map(r=>r.x+r.w))-x+24:300,h=rs.length?Math.max(...rs.map(r=>r.y+r.h))-y+32:220;
 if(!Number.isFinite(x)||!Number.isFinite(y)||Math.abs(x)>1e7||Math.abs(y)>1e7)throw Error('输入组坐标超出范围');
 const next=structuredClone(project),groupId=newId();
 const raw={id:groupId,type:kind,title:title.trim(),x,y,w,h,items:members.map(nativeId)};
 const node={id:groupId,type:'scene',x,y,title:title.trim(),text:'',assetId:null,params:{nativeCanvas:{version:1,format:'infinite-canvas-workflow',node:raw,adaptation:'reference',resources:[],missingResources:[],inputOrder:[],members:members.map(n=>({sourceNodeId:n.id})),mediaAssetIds:[],connectedGroup:false,connectedOutput:false,outgoingMedia:false}}};
 next.nodes.push(node);
 const targets=new Set();if(kind==='group')for(const edge of project.edges){const target=nodes.get(edge.target);if(memberIds.has(edge.source)&&target&&(sourceGenerators.has(typeOf(target))||localGenerator(target)))targets.add(target.id);}
 const removed=project.edges.filter(e=>memberIds.has(e.source)&&targets.has(e.target));next.edges=next.edges.filter(e=>!removed.some(r=>r.id===e.id));
 for(const targetId of targets){if(!next.edges.some(e=>e.source===groupId&&e.target===targetId))next.edges.push({id:newId(),source:groupId,target:targetId});
  const target=next.nodes.find(n=>n.id===targetId),native=target.params?.nativeCanvas;
  if(native){
   const order=(native.inputOrder||[]).filter(r=>!memberIds.has(r.sourceNodeId)).slice().sort((a,b)=>a.index-b.index);
   for(const m of members.filter(n=>typeOf(n)==='image'))order.push({sourceNodeId:groupId,itemType:'group-media',memberId:String(nativeId(m))});
   if(members.some(n=>['prompt','text','script'].includes(typeOf(n))))order.push({sourceNodeId:groupId,itemType:'group-prompts'});
   native.inputOrder=order.map((r,index)=>({...r,index}));
   native.node.inputs=native.inputOrder.map(r=>{const source=r.sourceNodeId===groupId?node:nodes.get(r.sourceNodeId);if(!source)throw Error('原生输入来源失效');const id=nativeId(source);return r.itemType==='generated'?`${id}:generated:${r.itemIndex}:${r.itemUrl}`:r.itemType==='group-media'?`${id}:${r.memberId}`:r.itemType==='group-prompts'?`${id}:prompts`:id;});
  }
 }
 if(next.edges.length>5000)throw Error('画布连线容量不足，未创建输入组');
 // Include semantic membership in the cycle check: a plain edge DAG is not
 // enough when a selected member is itself a downstream generator.
 const byId=new Map(next.nodes.map(n=>[n.id,n])),incoming=new Map(next.nodes.map(n=>[n.id,[]]));
 for(const e of next.edges){if(!byId.has(e.source)||!byId.has(e.target))throw Error('画布连线失效');incoming.get(e.target).push(e.source);}
 for(const n of next.nodes)if(groupTypes.has(typeOf(n)))for(const r of n.params.nativeCanvas.members||[]){if(!byId.has(r.sourceNodeId))throw Error('原生组成员失效');incoming.get(n.id).push(r.sourceNodeId);}
 const visiting=new Set(),visited=new Set();function visit(id){if(visiting.has(id))throw Error('输入组会形成循环依赖，未改变节点或连线');if(visited.has(id))return;visiting.add(id);for(const parent of incoming.get(id))visit(parent);visiting.delete(id);visited.add(id);}for(const id of byId.keys())visit(id);
 syncNativeConnections(next);
 return{project:next,groupId,kind,members:members.map(n=>({id:n.id,title:n.title,type:typeOf(n)})),ignoredIds:ids.filter(id=>!memberIds.has(id)),removedEdgeIds:removed.map(e=>e.id),targetIds:[...targets],preservedFieldMappings:true};
}
