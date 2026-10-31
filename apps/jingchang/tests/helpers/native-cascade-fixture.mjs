import {makeProject,makeNode} from '../../lib/model.mjs';

// Portable graph-only samples; no provider, credential, file upload or GPU.
export function cascadeFixture(){
 const project=makeProject('智能串联规则样本');project.id='cascade-project';project.nodes=[];
 function node(id,{kind='smart-image',x=0,y=0,stored=true,raw={},count=1,start=1,mode='serial',showPrompt=false,imageInput=false,batch=1,enabled=true}={}){
  const image=kind==='smart-image',assetId='asset-'+id,url='/api/assets/'+assetId;
  if(image&&stored)project.assets.push({id:assetId,name:id+'.png',type:'image/png'});
  const native={version:1,format:'infinite-smart-canvas-workflow',adaptation:'reference',node:{id:'original-'+id,type:kind,...(image?{images:stored?[{url,name:id+'.png',kind:'image'}]:[],runSettings:{engine:'comfy',comfyWorkflow:'wf-'+id},promptDraftHtml:'参数属于 '+id,promptDraftText:'参数属于 '+id}:{}),...raw},resources:image&&stored?[{url,assetId,archive:'media/'+id+'.png'}]:[],missingResources:[],mediaAssetIds:image&&stored?[assetId]:[],members:[],inputOrder:[],outgoingMedia:false,connectedOutput:false,connectedGroup:false};
  const params={nativeCanvas:native};
  if(kind==='smart-loop')params.nativeLoop={version:1,enabled,mode,count,start,showPrompt,imageInput,imageBatchSize:batch,videoInput:false,videoBatchSize:1,variablePrompt:'第《计数》轮',variablePrompts:null};
  const value=makeNode(image?'image':'text',x,y,{id,title:id,text:'独立提示 '+id,params});project.nodes.push(value);return value;
 }
 function edge(from,to,kind='flow'){
  from=typeof from==='string'?project.nodes.find(node=>node.id===from):from;to=typeof to==='string'?project.nodes.find(node=>node.id===to):to;
  project.edges.push({id:'edge-'+project.edges.length,source:from.id,target:to.id,nativeCanvasConnection:{from:from.params.nativeCanvas.node.id,to:to.params.nativeCanvas.node.id,kind}});
 }
 return{project,node,edge,find:id=>project.nodes.find(node=>node.id===id)};
}
export const cascadeTrace=program=>program.rounds.map(round=>round.operations.map(operation=>[operation.kind,operation.sourceNodeId,operation.targetNodeId,operation.requestNodeId]));
