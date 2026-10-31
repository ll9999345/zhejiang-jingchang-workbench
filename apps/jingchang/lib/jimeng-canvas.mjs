import {createHash} from 'node:crypto';
import {safeId,userError} from './workspace.mjs';
import {makeNode} from './model.mjs';
import {nativeFlowPreview} from './native-flow.mjs';
import {nativeExecutionAncestors} from './native-flow-execution.mjs';
import {cameraNodeText} from '../public/camera-angle-core.js';

const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
// Object insertion order is not a content edit. Array order (including input
// order and references) is meaningful and is deliberately preserved.
function canonical(value){return Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;}
export function validJimengCanvasTarget(value){return !!value&&Object.keys(value).sort().join(',')==='nodeId,nodeType,signature,version'&&value.version===1&&safeId(value.nodeId)&&['image','video'].includes(value.nodeType)&&typeof value.signature==='string'&&/^[a-f0-9]{64}$/.test(value.signature);}
export function captureJimengCanvasTarget(project,nodeId){
 const target=project.nodes.find(node=>node.id===nodeId);
 if(!target||!['image','video'].includes(target.type))throw userError('请选择当前画布的图片或视频节点');
 const ids=nativeExecutionAncestors(project,nodeId);ids.add(nodeId);
 const nodes=project.nodes.filter(node=>ids.has(node.id)).map(({id,type,title,text,assetId,params})=>({id,type,title,text,assetId,params})).sort((a,b)=>a.id.localeCompare(b.id));
 const assets=project.assets.map(({id,name,type,size,sha256})=>({id,name,type,size,sha256}));
 // Only assets reachable from these nodes matter; unrelated imports and layout
 // changes must not invalidate a manual generation or its eventual placement.
 const used=new Set();for(const node of nodes){if(node.assetId)used.add(node.assetId);for(const id of node.params?.nativeCanvas?.mediaAssetIds||[])used.add(id);for(const item of node.params?.nativeCanvas?.resources||[])used.add(item.assetId);}
 const edges=project.edges.filter(edge=>ids.has(edge.target)).map(edge=>canonical(edge)).sort((a,b)=>a.id.localeCompare(b.id));
 return{version:1,nodeId,nodeType:target.type,signature:digest(canonical({nodes,edges,assets:assets.filter(asset=>used.has(asset.id)).sort((a,b)=>a.id.localeCompare(b.id))}))};
}
export function assertJimengCanvasTarget(project,saved){
 if(!validJimengCanvasTarget(saved))throw userError('画布节点范围无效；请从节点重新进入');
 let current;try{current=captureJimengCanvasTarget(project,saved.nodeId);}catch{throw userError('原节点或依赖已变化，请从画布重新进入；也可将已完成结果另存新节点',409);}
 if(current.nodeType!==saved.nodeType||current.signature!==saved.signature)throw userError('原节点、上游内容或连线已变化，未覆盖或执行；请重新带入，或将已完成结果另存新节点',409);
 return project.nodes.find(node=>node.id===saved.nodeId);
}
export function jimengCanvasContext(project,nodeId){
 const target=captureJimengCanvasTarget(project,nodeId),node=project.nodes.find(node=>node.id===nodeId),flow=nativeFlowPreview(project,{nodeId});
 if(flow.inputs.issues.length)throw userError('当前已保存输入不能带入：'+flow.inputs.issues.slice(0,4).join('；'));
 const prompt=[...flow.inputs.promptItems,cameraNodeText(node)].map(text=>text.trim()).filter(Boolean).join('\n\n'),media=[...flow.inputs.media];
 // An ordinary uploaded media node may be edited directly. A generator's old
 // output is not silently reinterpreted as a new reference to itself.
 if(!media.length&&(!node.params?.nativeCanvas||node.params.nativeCanvas.node.type==='image'))media.push(...flow.nodes[0].media);
 const references=[...new Map(media.filter(item=>['image','video','audio'].includes(item.kind)).map(item=>[item.assetId,{assetId:item.assetId,role:item.kind}])).values()];
 let command=node.type==='image'?(references.length?'image2image':'text2image'):references.length===0?'text2video':references.length===1&&references[0].role==='image'?'image2video':references.length===2&&references.every(ref=>ref.role==='image')?'frames2video':'multimodal2video';
 if(command==='frames2video')references.forEach((ref,i)=>ref.role=i?'last':'first');
 return{projectId:project.id,revision:project.revision,title:node.title,target,request:{command,prompt,model:node.type==='video'?'seedance2.0':'5.0',resolution:node.type==='video'?'720p':'2k',ratio:node.params?.ratio||project.settings?.ratio||'16:9',duration:node.type==='video'?(node.params?.duration??5):0,generateNum:1,references},notice:'仅带入当前已保存的文字和本机素材，不运行上游；模型为即梦默认值，请核对规格、参考顺序与角色后预览。'};
}
export function applyJimengCanvasResults(project,task,assets,{revision,placement='new'}={}){
 if(!['new','target'].includes(placement))throw userError('回填方式无效');
 if(placement==='target'&&!task.plan.canvasTarget)throw userError('此原任务没有绑定画布节点，只能另存新节点');
 const ids=assets.map(asset=>'jc-'+digest(task.id+':'+asset.id));
 // The deterministic result nodes are the transaction's durable proof. A
 // repeated apply never overwrites later edits, even after a service restart.
 if(ids.every(id=>project.nodes.some(node=>node.id===id)))return false;
 if(project.revision!==revision)throw userError('画布已更新，请刷新后再放入CLI结果',409);
 const target=placement==='target'?assertJimengCanvasTarget(project,task.plan.canvasTarget):null;
 if(target&&assets.some(asset=>!asset.type.startsWith(target.type+'/')))throw userError('结果类型与原节点不符');
 if(target?.params?.nativeCanvas){
  const native=target.params.nativeCanvas,items=assets.map(asset=>({url:asset.url,name:asset.name,kind:asset.type.split('/')[0],type:asset.type}));
  if(native.resources.length+assets.filter(asset=>!native.resources.some(ref=>ref.assetId===asset.id)).length>1000)throw userError('原生结果资源超过1000份，未回填');
  native.node.generatedOutputs=items;native.mediaAssetIds=assets.map(asset=>asset.id);
  if(native.node.type==='image')native.node.url=assets[0].url;
  if(native.node.type==='smart-image')native.node.images=items;
  for(const asset of assets)if(!native.resources.some(ref=>ref.assetId===asset.id))native.resources.push({assetId:asset.id,url:asset.url,archive:'resources/'+asset.id});
 }
 if(target)target.assetId=assets[0].id;
 for(const [i,asset]of assets.entries()){
  if(!project.assets.some(item=>item.id===asset.id))project.assets.push(asset);
  if(!project.nodes.some(node=>node.id===ids[i]))project.nodes.push(makeNode(asset.type.split('/')[0],target?target.x+360+(i%3)*350:150+(i%3)*350,target?target.y+Math.floor(i/3)*300:150+Math.ceil(project.nodes.length/3)*300,{id:ids[i],title:asset.name,text:task.plan.request.prompt,assetId:asset.id}));
 }
 project.revision++;project.updatedAt=new Date().toISOString();return true;
}
