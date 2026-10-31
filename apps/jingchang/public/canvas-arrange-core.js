// Local geometry only. No task, media, prompt or connection is rewritten.
const groups=new Set(['group','promptGroup']);
const id=v=>typeof v==='string'&&/^[\w-]{1,100}$/.test(v);
const finite=(v,label)=>{if(!Number.isFinite(v))throw Error(label+'不是有效坐标');return v;};
const size=(v,fallback)=>Number.isFinite(v)&&v>0&&v<=100000?v:fallback;

export function arrangeCanvasSelection(project,nodeIds,{rects={},groupRects={}}={}){
 if(!project||!Array.isArray(project.nodes)||project.nodes.length>1500||!Array.isArray(project.edges)||!Array.isArray(nodeIds)||!rects||!groupRects)throw Error('画布整理范围无效');
 const nodes=new Map(),containers=new Map(),parent=new Map();
 for(const n of project.nodes){if(!id(n.id)||nodes.has(n.id))throw Error('画布节点编号无效或重复');finite(n.x,'节点X');finite(n.y,'节点Y');nodes.set(n.id,n);}
 const selected=[...new Set(nodeIds.filter(k=>typeof k==='string'&&nodes.has(k)))];
 const own=(child,owner)=>{if(!nodes.has(child)&&!containers.has(child))throw Error('分组引用了不存在的节点');if(parent.has(child)&&parent.get(child)!==owner){const first=containers.get(parent.get(child)),next=containers.get(owner);if(first?.native&&next?.native&&first.kind!==next.kind)return;throw Error('分组成员存在重叠，未移动节点');}parent.set(child,owner);};
 for(const n of nodes.values()){
  const raw=n.params?.nativeCanvas;
  if(groups.has(raw?.node?.type)&&Array.isArray(raw.members)&&raw.members.length){
   const members=raw.members.map(r=>r?.sourceNodeId);if(members.some(k=>!nodes.has(k))||new Set(members).size!==members.length)throw Error('原生分组成员无效');
   containers.set(n.id,{id:n.id,members,native:true,kind:raw.node.type});
  }
 }
 for(const c of containers.values())for(const member of c.members)own(member,c.id);
 const displayGroups=project.groups??[];if(!Array.isArray(displayGroups)||displayGroups.length>1500)throw Error('画布分组无效');const groupIds=new Set();
 for(const g of displayGroups){
  if(!id(g.id)||groupIds.has(g.id)||!Array.isArray(g.nodeIds)||!g.nodeIds.length||g.nodeIds.some(k=>!nodes.has(k))||new Set(g.nodeIds).size!==g.nodeIds.length)throw Error('画布分组成员无效');groupIds.add(g.id);
  // A visual-only frame may cover members of one or more input groups.
  // It follows those members; executable groups keep their atomic ownership.
  const nativeRoots=g.nodeIds.map(key=>{const seen=new Set();while(parent.has(key)){if(seen.has(key))throw Error('分组包含循环，未移动节点');seen.add(key);key=parent.get(key);}return key;});
  if(nativeRoots.some(key=>containers.get(key)?.native))continue;
  const aliases=[...containers.values()].filter(c=>c.native&&c.members.length===g.nodeIds.length&&c.members.every(k=>g.nodeIds.includes(k)));
  if(aliases.length>1)throw Error('原生分组归属不明确，未移动节点');
  if(aliases.length){aliases[0].display=g;continue;}
  const key='group:'+g.id;containers.set(key,{id:key,members:[...g.nodeIds],display:g,native:false});for(const member of g.nodeIds)own(member,key);
 }
 const ownerOf=new Map();
 for(const key of nodes.keys()){
  let current=key;const seen=new Set();while(parent.has(current)){if(seen.has(current))throw Error('分组包含循环，未移动节点');seen.add(current);current=parent.get(current);}ownerOf.set(key,current);
 }
 const atoms=new Map();for(const [key,owner]of ownerOf){if(!atoms.has(owner))atoms.set(owner,{id:owner,members:[]});atoms.get(owner).members.push(key);}
 // A prompt may belong to both kinds. Selection promotion uses the first
 // group in source order, while translating an explicitly selected group
 // still visits all of its own members, as the pinned source does.
 for(const atom of atoms.values()){
  const seen=new Set(atom.members),visiting=new Set(),done=new Set();
  function collect(key){if(visiting.has(key))throw Error('分组包含循环，未移动节点');if(done.has(key))return;visiting.add(key);const c=containers.get(key);if(c?.native)for(const child of c.members){seen.add(child);collect(child);}visiting.delete(key);done.add(key);}
  for(const key of [...atom.members])collect(key);atom.members=[...seen];
 }
 function nodeRect(n){const measured=rects instanceof Map?rects.get(n.id):rects[n.id];return{x:n.x,y:n.y,width:size(measured?.width,size(n.width??n.w??(groups.has(n.params?.nativeCanvas?.node.type)?n.params.nativeCanvas.node.w:undefined),288)),height:size(measured?.height,size(n.height??n.h??(groups.has(n.params?.nativeCanvas?.node.type)?n.params.nativeCanvas.node.h:undefined),270))};}
 function union(values){return{x:Math.min(...values.map(v=>v.x)),y:Math.min(...values.map(v=>v.y)),width:Math.max(...values.map(v=>v.x+v.width))-Math.min(...values.map(v=>v.x)),height:Math.max(...values.map(v=>v.y+v.height))-Math.min(...values.map(v=>v.y))};}
 for(const atom of atoms.values()){
  const container=containers.get(atom.id),members=atom.members.map(k=>nodeRect(nodes.get(k)));let bounds=container?.native?nodeRect(nodes.get(atom.id)):union(members);
  if(container&&!container.native){
   const g=container.display,r=groupRects instanceof Map?groupRects.get(g.id):groupRects[g.id];
   if(g.collapsed){bounds={x:bounds.x-18,y:bounds.y-44,width:size(r?.width,Math.max(300,Math.min(460,(g.title||'').length*10+190))),height:size(r?.height,52)};}
   else bounds={x:bounds.x-18,y:bounds.y-44,width:bounds.width+36,height:bounds.height+62};
  }
  atom.bounds=bounds;
 }
 // Match the source order: expand the raw connected cluster first, then
 // replace selected members by their parent atoms. A group is not a portal
 // to unrelated connections owned by another, unselected member.
 const mode=selected.length===1?'connected':'selected';let rawScope=[...selected];
 if(mode==='connected'){
  const seen=new Set(rawScope);for(let i=0;i<rawScope.length;i++)for(const e of project.edges){
   if(!e||e.source!==rawScope[i]&&e.target!==rawScope[i])continue;
   const next=e.source===rawScope[i]?e.target:e.source;if(nodes.has(next)&&!seen.has(next)){seen.add(next);rawScope.push(next);}
  }
 }
 const chosenSet=new Set(rawScope);let replaced=true;
 while(replaced){replaced=false;for(const [child,owner] of parent)if(chosenSet.has(child)){chosenSet.delete(child);chosenSet.add(owner);replaced=true;}}
 const chosen=[...chosenSet],links=[];
 for(const e of project.edges){if(!e||!nodes.has(e.source)||!nodes.has(e.target))continue;const sourceOwner=ownerOf.get(e.source),targetOwner=ownerOf.get(e.target);const from=containers.get(sourceOwner)?.native?e.source:sourceOwner,to=containers.get(targetOwner)?.native?e.target:targetOwner;if(from!==to)links.push({from,to});}
 const scope=[...chosen];
 const next=structuredClone(project),scopeNodes=[...new Set(scope.flatMap(k=>atoms.get(k).members))];
 if(scope.length<2)return{project:next,mode,scopeNodeIds:scopeNodes,movedNodeIds:[],columns:[],changed:false};
 const included=new Set(scope),internal=links.filter(e=>included.has(e.from)&&included.has(e.to)),depth=new Map(scope.map(k=>[k,0])),incoming=new Map(scope.map(k=>[k,0])),outgoing=new Map();
 for(const e of internal){incoming.set(e.to,incoming.get(e.to)+1);if(!outgoing.has(e.from))outgoing.set(e.from,[]);outgoing.get(e.from).push(e.to);}
 if(internal.length){const roots=scope.filter(k=>incoming.get(k)===0),queue=roots.length?roots:[scope[0]],seen=new Set(queue);for(let i=0;i<queue.length;i++)for(const target of outgoing.get(queue[i])||[]){depth.set(target,Math.max(depth.get(target),depth.get(queue[i])+1));if(!seen.has(target)){seen.add(target);queue.push(target);}}}
 const columns=new Map();for(const key of scope){const d=depth.get(key);if(!columns.has(d))columns.set(d,[]);columns.get(d).push(key);}
 const startX=Math.min(...scope.map(k=>atoms.get(k).bounds.x)),startY=Math.min(...scope.map(k=>atoms.get(k).bounds.y)),targets=new Map(),report=[];let x=startX;
 for(const d of [...columns.keys()].sort((a,b)=>a-b)){
  const col=columns.get(d).sort((a,b)=>atoms.get(a).bounds.y-atoms.get(b).bounds.y||String(a).localeCompare(String(b)));let y=startY,width=0;
  for(const key of col){const atom=atoms.get(key),dx=Math.round(x-atom.bounds.x),dy=Math.round(y-atom.bounds.y);for(const member of atom.members){const n=targets.get(member)||nodes.get(member);const target={x:Math.round(n.x+dx),y:Math.round(n.y+dy)};if(Math.abs(target.x)>1e7||Math.abs(target.y)>1e7)throw Error('整理后的坐标超出画布范围，未移动节点');targets.set(member,target);}y+=Math.max(120,atom.bounds.height)+56;width=Math.max(width,Math.max(220,atom.bounds.width));}
  report.push({depth:d,atomIds:col});x+=width+180;
 }
 const moved=[];for(const n of next.nodes){const target=targets.get(n.id);if(target&&(target.x!==n.x||target.y!==n.y)){n.x=target.x;n.y=target.y;moved.push(n.id);}}
 return{project:next,mode,scopeNodeIds:scopeNodes,movedNodeIds:moved,columns:report,changed:moved.length>0};
}
