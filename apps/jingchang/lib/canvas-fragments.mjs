import {remapNativeCopies} from '../public/native-copy-core.js';
import {canvasNodeReferences as references,canvasNodeAssetIds} from '../public/canvas-reference-core.js';
import {nativeMediaVersion} from '../public/native-media-version.js';
import {randomUUID} from 'node:crypto';
import {validateProject} from './model.mjs';
import {safeId,userError,assertNoCredentials} from './workspace.mjs';
import {ltxReferences} from '../public/ltx-director-core.js';
import {minimaxReferences,minimaxTimelineOf,minimaxAssetIds} from '../public/minimax-h3-core.js';

export function validateFragmentReferences(project){
 const known=new Set(project.nodes.map(n=>n.id));
 for(const node of project.nodes)for(const {value,key}of references(node)){
  if(value[key]&&!known.has(value[key]))throw userError('节点“'+node.title+'”引用了未选中的节点，请一并选中该依赖节点');
 }
 return project;
}
export function selectCanvasFragment(project,nodeIds){
 validateProject(project);
 if(!Array.isArray(nodeIds)||!nodeIds.length||nodeIds.length>1500||nodeIds.some(id=>!safeId(id))||new Set(nodeIds).size!==nodeIds.length)throw userError('请选择1–1500个不同画布节点');
 const selected=new Set(nodeIds);
 if(nodeIds.some(id=>!project.nodes.some(n=>n.id===id)))throw userError('选择中有不存在的画布节点，请重新选择');
 const nodes=structuredClone(project.nodes.filter(n=>selected.has(n.id))),assetIds=new Set();
 for(const n of nodes)for(const id of canvasNodeAssetIds(n))assetIds.add(id);
 const out={
  id:project.id,name:project.name,revision:0,archived:false,nodes,
  edges:structuredClone(project.edges.filter(e=>selected.has(e.source)&&selected.has(e.target))),
  groups:structuredClone((project.groups||[]).map(g=>({...g,nodeIds:g.nodeIds.filter(id=>selected.has(id))})).filter(g=>g.nodeIds.length)),
  assets:structuredClone(project.assets.filter(a=>assetIds.has(a.id))),
  shots:[],messages:[],runs:[],viewport:{x:0,y:0,zoom:1},
  settings:{ratio:project.settings.ratio,fps:project.settings.fps,...(project.settings.nativeMediaVersion===undefined?{}:{nativeMediaVersion:project.settings.nativeMediaVersion})}
 };
 validateFragmentReferences(out);assertNoCredentials(out);validateProject(out);return out;
}
export function fragmentMaps(project){
 const map=items=>Object.fromEntries(items.map(x=>[x.id,randomUUID()]));
 return {nodes:map(project.nodes),edges:map(project.edges),groups:map(project.groups||[])};
}
export function fragmentPlacement(target,fragment,placement={}){
 const supplied=placement.x!==undefined||placement.y!==undefined;
 const x=supplied?placement.x:target.nodes.length?Math.max(...target.nodes.map(n=>n.x))+420:180;
 const y=supplied?placement.y:target.nodes.length?Math.min(...target.nodes.map(n=>n.y)):180;
 if(!Number.isFinite(x)||!Number.isFinite(y)||Math.abs(x)>1e7||Math.abs(y)>1e7)throw userError('工作流插入位置无效');
 const dx=x-Math.min(...fragment.nodes.map(n=>n.x)),dy=y-Math.min(...fragment.nodes.map(n=>n.y));
 for(const n of fragment.nodes)if(Math.abs(n.x+dx)>1e7||Math.abs(n.y+dy)>1e7)throw userError('工作流插入位置超出画布范围');
 if(target.nodes.length+fragment.nodes.length>1500||target.edges.length+fragment.edges.length>5000||(target.groups||[]).length+(fragment.groups||[]).length>1500)throw userError('插入后将超过画布容量，请使用新项目');
 return {x,y,dx,dy};
}
export function mergeCanvasFragment(target,fragment,maps,placement){
 validateProject(target);validateProject(fragment);validateFragmentReferences(fragment);
 const {dx,dy}=fragmentPlacement(target,fragment,placement),out=structuredClone(target);
 const requireId=(map,id)=>{if(!safeId(map?.[id]))throw userError('画布工作流编号映射不完整');return map[id];};
 const nodes=structuredClone(fragment.nodes);
 for(const n of nodes){
  const version=nativeMediaVersion(fragment,n);if(version!==nativeMediaVersion(target))n.params={...n.params,nativeMediaVersion:version};
  n.id=requireId(maps.nodes,n.id);n.x+=dx;n.y+=dy;
  for(const {value,key}of references(n))if(value[key])value[key]=requireId(maps.nodes,value[key]);
  for(const s of minimaxTimelineOf(n)?.segments||[])for(const r of s.resultVariants||[])if(maps.nodes[r.loopId])r.loopId=maps.nodes[r.loopId];
 }
 const edges=fragment.edges.map(e=>({...structuredClone(e),id:requireId(maps.edges,e.id),source:requireId(maps.nodes,e.source),target:requireId(maps.nodes,e.target)}));
 const groups=(fragment.groups||[]).map(g=>({...structuredClone(g),id:requireId(maps.groups,g.id),nodeIds:g.nodeIds.map(id=>requireId(maps.nodes,id))}));
 for(const items of [[...target.nodes,...nodes],[...target.edges,...edges],[...(target.groups||[]),...groups]]){const ids=items.map(x=>x.id);if(new Set(ids).size!==ids.length)throw userError('工作流编号与当前画布冲突，原项目保留',409);}
 out.nodes.push(...nodes);out.edges.push(...edges);
 if(groups.length)out.groups=[...(out.groups||[]),...groups];
 for(const a of fragment.assets)if(!out.assets.some(old=>old.id===a.id))out.assets.push(structuredClone(a));
 remapNativeCopies(fragment,out,new Map(Object.entries(maps.nodes)));validateProject(out);
 return {project:out,nodeIds:nodes.map(n=>n.id),edgeIds:edges.map(e=>e.id),groupIds:groups.map(g=>g.id),assetIds:fragment.assets.map(a=>a.id)};
}
