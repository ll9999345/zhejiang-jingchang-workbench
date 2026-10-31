import {canvasNodeReferences,canvasNodeAssetIds} from './canvas-reference-core.js';
import {nativeMediaVersion} from './native-media-version.js';
import {remapNativeCopies,refreshNativeCopyProofs} from './native-copy-core.js';

export function canvasClipboardSnapshot(project,nodeIds){
 if(!Array.isArray(nodeIds)||!nodeIds.length||new Set(nodeIds).size!==nodeIds.length||nodeIds.some(id=>!project.nodes.some(n=>n.id===id)))throw Error('复制范围已变化，请重新选择');
 return {project:structuredClone(project),nodeIds:[...nodeIds],pasteCount:0};
}

// Infinite Canvas anchors the midpoint of node origins, not rendered card bounds.
// Keep placement in world coordinates so the same delta can go to the local
// copy path and the cross-project, resumable insertion path.
export function canvasPastePlacement(clipboard,{anchor,offset=(clipboard.pasteCount+1)*40}={}){
 const ids=clipboard?.nodeIds,nodes=clipboard?.project?.nodes;
 if(!Array.isArray(ids)||!ids.length||!Array.isArray(nodes)||new Set(ids).size!==ids.length)throw Error('复制范围已变化，请重新复制');
 const selected=ids.map(id=>nodes.find(n=>n.id===id));if(selected.some(n=>!n||![n.x,n.y].every(Number.isFinite)))throw Error('复制节点坐标无效');
 const xs=selected.map(n=>n.x),ys=selected.map(n=>n.y),left=Math.min(...xs),top=Math.min(...ys),right=Math.max(...xs),bottom=Math.max(...ys);
 let dx=offset,dy=offset;
 if(anchor!==undefined){if(!anchor||![anchor.x,anchor.y].every(Number.isFinite))throw Error('粘贴指针坐标无效');dx=anchor.x-(left+right)/2;dy=anchor.y-(top+bottom)/2;}
 if(![dx,dy].every(Number.isFinite)||selected.some(n=>Math.abs(n.x+dx)>1e7||Math.abs(n.y+dy)>1e7))throw Error('粘贴位置超出画布范围');
 return{x:left+dx,y:top+dy,dx,dy};
}

export function canvasPasteAnchor({pointer,projectId,viewport,width,height}){
 if(pointer?.projectId===projectId&&[pointer.x,pointer.y].every(Number.isFinite))return{x:pointer.x,y:pointer.y};
 if(!viewport||![viewport.x,viewport.y,viewport.zoom,width,height].every(Number.isFinite)||viewport.zoom<=0||width<=0||height<=0)throw Error('当前画布尺寸无效');
 return{x:(width/2-viewport.x)/viewport.zoom,y:(height/2-viewport.y)/viewport.zoom};
}

// This clipboard does not read account storage or contact services. It is a
// local, in-memory snapshot; the normal project API persists the result.
export function prepareCanvasPaste(target,clipboard,{copyNodes,offset=(clipboard.pasteCount+1)*40,anchor}={}){
 if(typeof copyNodes!=='function')throw Error('粘贴工具尚未加载');
 const source=clipboard.project,ids=clipboard.nodeIds,selected=new Set(ids),cross=source.id!==target.id;
 if(!Array.isArray(ids)||!ids.length||selected.size!==ids.length||ids.some(id=>!source.nodes.some(n=>n.id===id)))throw Error('复制范围已变化，请重新复制');
 const originalById=new Map(source.nodes.map(n=>[n.id,n])),originals=source.nodes.filter(n=>selected.has(n.id)),required=new Set(originals.flatMap(canvasNodeAssetIds)),assets=new Map();
 for(const a of source.assets){if(assets.has(a.id))throw Error('原素材清单有重复编号，请先核对');assets.set(a.id,a);}
 if([...required].some(id=>!assets.has(id)))throw Error('复制内容缺少素材清单，请保留原工程并重新导入');
 const allowed=new Set(cross?ids:[...ids,...target.nodes.map(n=>n.id)]);
 for(const n of originals)for(const {value,key}of canvasNodeReferences(n))if(value[key]&&!allowed.has(value[key]))throw Error('节点“'+n.title+'”还引用未选中的节点，请一并复制该依赖节点');
 const placement=canvasPastePlacement(clipboard,{anchor,offset}),copied=copyNodes(source,ids,{offsetX:placement.dx,offsetY:placement.dy,copyGroups:true,nativeIdentity:true,nativeRemap:remapNativeCopies}),nodes=copied.nodes.slice(source.nodes.length),idMap=new Map(ids.map((id,i)=>[id,nodes[i].id])),newIds=new Set(nodes.map(n=>n.id)),edges=copied.edges.filter(e=>newIds.has(e.target)),oldGroups=new Set((source.groups||[]).map(g=>g.id)),groups=(copied.groups||[]).filter(g=>!oldGroups.has(g.id)),next=structuredClone(target),addedAssets=[];
 if(target.nodes.length+nodes.length>1500||target.edges.length+edges.length>5000||(target.groups||[]).length+groups.length>1500)throw Error('粘贴后超过画布容量，请缩小选区或使用新项目');
 for(const [collection,added,label]of [[target.nodes,nodes,'节点'],[target.edges,edges,'连线'],[target.groups||[],groups,'分组']]){const known=new Set(collection.map(x=>x.id));for(const n of added){if(known.has(n.id))throw Error(label+'编号冲突，原工程保持');known.add(n.id);}}
 for(const id of required){const a=assets.get(id),old=target.assets.find(a=>a.id===id);if(old){for(const k of ['type','size','sha256'])if(old[k]!==undefined&&a[k]!==undefined&&old[k]!==a[k])throw Error('同编号素材内容信息冲突，原素材保持，请重新导入');}else{const value=structuredClone(a);next.assets.push(value);addedAssets.push(id);}}
 for(const n of nodes){const old=originalById.get(ids[nodes.indexOf(n)]),version=nativeMediaVersion(source,old);if(version!==nativeMediaVersion(target))n.params={...n.params,nativeMediaVersion:version};}
 next.nodes.push(...nodes);next.edges.push(...edges);if(groups.length)next.groups=[...(next.groups||[]),...groups];
 refreshNativeCopyProofs(source,next,idMap);
 return {project:next,nodeIds:nodes.map(n=>n.id),edgeIds:edges.map(e=>e.id),groupIds:groups.map(g=>g.id),assetIds:addedAssets,crossProject:cross,placement:{x:placement.x,y:placement.y}};
}
