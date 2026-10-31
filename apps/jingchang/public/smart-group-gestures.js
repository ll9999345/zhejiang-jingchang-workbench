import {smartGroupMembers,resizeSmartGroup,smartGroupMediaEntries} from './smart-group-core.js';
import {mergeCanvasEdit} from './canvas-edit-merge.js';
const raw=n=>n.params?.nativeCanvas?.node||n;
const keys=['x','y','w','h','scale','_memberZoom'];
function restore(target,source){for(const key of keys){if(Object.hasOwn(source,key))target[key]=source[key];else delete target[key];}}
// Restore only geometry to its gesture origin. New text, bindings, assets and
// task results arriving during the gesture remain part of the next local save.
export function smartGroupGestureDraft(current,source,ids){
 const draft=structuredClone(current),selected=new Set(ids);
 for(const node of draft.nodes.filter(n=>selected.has(n.id))){const start=source.nodes.find(n=>n.id===node.id);if(!start)continue;restore(node,start);if(raw(node)!==node&&raw(start)!==start)restore(raw(node),raw(start));}
 return draft;
}
export function smartGroupResizePreview(source,groupId,width,height,rects={}){
 const group=source.nodes.find(n=>n.id===groupId);if(!group)throw Error('智能组已不存在');
 const ids=new Set([groupId,...smartGroupMembers(source,group).map(n=>n.id)]),preview={nodes:source.nodes.filter(n=>ids.has(n.id)).map(n=>n.params?.nativeCanvas?{...n,params:{...n.params,nativeCanvas:{...n.params.nativeCanvas,node:{...n.params.nativeCanvas.node}}}}:{...n}),assets:source.assets};
 resizeSmartGroup(preview,preview.nodes.find(n=>n.id===groupId),{width,height},rects);
 return preview.nodes.map(n=>({id:n.id,node:Object.fromEntries(keys.filter(k=>Object.hasOwn(n,k)).map(k=>[k,n[k]])),native:Object.fromEntries(keys.filter(k=>Object.hasOwn(raw(n),k)).map(k=>[k,raw(n)[k]]))}));
}
export function applySmartGroupGeometry(project,rows){for(const row of rows){const n=project.nodes.find(n=>n.id===row.id);if(!n)continue;restore(n,row.node);if(raw(n)!==n)restore(raw(n),row.native);}return project;}
// If a preceding save fails, its persisted baseline is unknown. Keep local
// conflicts visible and also retain newly arrived records; require review.
export function retainUnconfirmedSmartGesture(local,latest){return mergeCanvasEdit({id:local.id,nodes:[],edges:[],assets:[],groups:[],shots:[],messages:[],runs:[],settings:{},viewport:{}},local,latest);}

export function smartThumbnailGestureDraft(current,source,groupId,temporaryId,index){
 const group=source.nodes.find(n=>n.id===groupId);if(!group)throw Error('缩略图来源已不存在');
 const draft=smartGroupGestureDraft(current,source,[groupId,...smartGroupMembers(source,group).map(n=>n.id)]),live=draft.nodes.find(n=>n.id===groupId),hadPreview=draft.nodes.some(n=>n.id===temporaryId);
 draft.nodes=draft.nodes.filter(n=>n.id!==temporaryId);draft.edges=draft.edges.filter(e=>e.source!==temporaryId&&e.target!==temporaryId);if(!live||!hadPreview)return draft;
 const original=smartGroupMediaEntries(source,group).filter(r=>r.sourceNodeId===groupId).map(r=>r.item),remaining=original.filter((_,i)=>i!==index),images=raw(live).images||[];
 if(JSON.stringify(images)===JSON.stringify(remaining)){if(Object.hasOwn(raw(group),'images'))raw(live).images=structuredClone(raw(group).images);else delete raw(live).images;live.params.nativeCanvas.mediaAssetIds=[...group.params.nativeCanvas.mediaAssetIds];}
 else{raw(live).images=[...images];raw(live).images.splice(Math.min(index,images.length),0,structuredClone(original[index]));live.params.nativeCanvas.mediaAssetIds=[...new Set(smartGroupMediaEntries(draft,live).filter(r=>r.sourceNodeId===groupId&&r.assetId).map(r=>r.assetId))];}
 return draft;
}

export function smartGroupMirrorFrameIds(project){return new Set((project.groups||[]).filter(frame=>project.nodes.some(n=>n.params?.nativeCanvas?.node.type==='smart-group'&&String(n.params.nativeCanvas.node.id)!==n.id&&n.title===frame.title&&frame.nodeIds.length===n.params.nativeCanvas.members.length&&n.params.nativeCanvas.members.every(r=>frame.nodeIds.includes(r.sourceNodeId)))).map(frame=>frame.id));}
