import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {cascadeFixture} from './native-cascade-fixture.mjs';
import {nativeLoopFixture,png} from './native-loop-fixture.mjs';
import {storeAsset,atomicJson,readJson} from '../../lib/workspace.mjs';
import {imageStep} from '../../lib/canvas-images.mjs';
import {normalizeStudioBinding,studioStep,resolveStudio} from '../../lib/canvas-studio.mjs';
import {nativeCascadeChildAdapter} from '../../lib/native-cascade-children.mjs';
import {planNativeCascade} from '../../lib/native-cascade-plan.mjs';

// Explicit test-only field formatter. The product's native prompt/field
// migration and UI admission are a separate integration gate, not implied by
// these loopback adapter tests.
export async function cascadeProtocolFixture(t,{pairs=[['A','B'],['B','C']],kinds={}}={}){
 const f=await nativeLoopFixture(t),g=cascadeFixture();
 const ids=[...new Set(pairs.flat())];for(const [index,id]of ids.entries())g.node(id,{x:index*300});for(const [a,b]of pairs)g.edge(a,b);
 const project=g.project;
 for(const node of project.nodes){
  const asset=await storeAsset(f.data,png,{name:node.id+'.png',type:'image/png'}),native=node.params.nativeCanvas;
  project.assets=project.assets.filter(a=>a.id!=='asset-'+node.id);project.assets.push(asset);native.resources[0].assetId=asset.id;native.mediaAssetIds=[asset.id];
 }
 const workflowId=f.node('generate0').params.workflowBinding.workflowId;
 for(const node of project.nodes){
  const kind=kinds[node.id]||'comfy';
  if(kind==='comfy')node.params.workflowBinding={workflowId,count:1,overrides:[],imageSources:[],promptField:{nodeId:'1',name:'text'}};
  else if(kind==='runninghub'){
   const recipe=await f.cloudWorkflows.create({projectId:project.id});const saved=await f.cloudWorkflows.save(recipe.id,{...recipe,name:'发送方 '+node.id,baseUrl:f.endpoint,targetId:'12345',fields:[{nodeId:'1',fieldName:'text',type:'text',fieldValue:'old'},{nodeId:'2',fieldName:'image',type:'image',fieldValue:''}]});
   node.params.cloudBinding={recipeId:saved.id,recipeRevision:saved.revision,inputs:[]};node.params.nativeCanvas.node.runSettings={engine:'runninghub',rhWorkflowId:'12345'};
  }else if(kind==='image-api'){
   node.params.imageBinding={platform:{id:'cascade-loopback-image',name:'本机合成图片协议',protocol:'openai-compatible',baseUrl:f.endpoint+'/v1',models:[{id:'fixture-image',category:'image',referenceSupport:true}]},model:'fixture-image',size:'1024x1024',quality:'medium',includeUpstream:true,referenceSources:[]};
   node.params.nativeCanvas.node.runSettings={engine:'api',apiKind:'image'};
  }else if(kind==='studio'){
   node.type='video';node.params.studioBinding=normalizeStudioBinding({mode:'video',config:{protocol:'ark',model:'synthetic-ark-video',baseUrl:f.endpoint+'/v1',duration:5},referenceSources:[]});
   node.params.nativeCanvas.node.runSettings={engine:'api',apiKind:'video'};
  }
 }
 const parentId='cascade-parent',controller=new AbortController();f.activeJobs.set(parentId,{controller,projectId:project.id,kind:'canvas-run'});
 async function prepare(request){
  const p=request.project,node=p.nodes.find(node=>node.id===request.requestNode.id),params=node.params;
  const text='发送参数 '+node.id+'；'+request.requestNode.params.nativeCanvas.node.promptDraftText;
  // Ephemeral requests already have fully resolved media; source JSON remains
  // in the parent's immutable snapshot rather than being reinterpreted twice.
  delete params.nativeCanvas;delete params.nativeLoop;delete params.nativePrompt;delete params.nativeBranch;node.text=text;
  const images=request.referenceRefs.filter(ref=>ref.kind==='image').map(ref=>({assetId:ref.assetId}));
  if(params.workflowBinding)return{kind:'comfy',project:p,endpoint:f.pool[0],body:{nodeId:node.id,workflowId,overrides:[{nodeId:'1',name:'text',value:text}],imageBindings:images.length?[{nodeId:'3',name:'image',assetId:images[0].assetId}]:[],count:1}};
  if(params.cloudBinding){
   const recipe=await f.cloudWorkflows.get(params.cloudBinding.recipeId),fields=recipe.fields.map(field=>field.type==='text'?{...field,fieldValue:text}:images.length?{...field,source:'asset',assetId:images[0].assetId}:{...field,source:'literal',fieldValue:''}),resolved={...recipe,fields};
   return{kind:'runninghub',project:p,recipe:resolved,body:{revision:recipe.revision,authorization:{origin:f.endpoint,kind:recipe.kind,targetId:recipe.targetId,requestLimit:1,sendFields:true,sendAssets:images.length>0,budget:1,currency:'CNY'}}};
  }
  if(params.imageBinding){
   const step=await imageStep({data:f.data,project:p,node,binding:{...params.imageBinding,referenceSources:images},parents:new Set(),text});
   step.authorization={origin:f.endpoint,model:step.image.model,requestLimit:1,sendPrompt:true,sendReferences:images.length>0,budget:1,currency:'CNY'};return{kind:'image-api',project:p,step};
  }
  const step=await studioStep({data:f.data,project:p,node,binding:{...params.studioBinding,referenceSources:images},parents:new Set(),text});
  return{kind:'studio',project:p,studio:resolveStudio(step,p),body:{authorization:{origin:f.endpoint,model:step.studio.config.model,requestLimit:1,sendPrompt:true,sendReferences:images.length>0,budget:1,currency:'CNY'}}};
 }
 const program=planNativeCascade(project,{nodeId:pairs.at(-1)[1]}),stateFile=path.join(f.data,'cascade-state.json'),persist=state=>atomicJson(stateFile,state);
 const adapter=services=>nativeCascadeChildAdapter({...f,...services,project,program,parentId,prepare,credentialsFor:async()=>({apiKey:'synthetic-only-cascade'}),pollInterval:10});
 async function waitChildren(){for(let i=0;i<500;i++){if(![...f.activeJobs.values()].some(job=>job.parentId===parentId))return;await delay(10);}throw Error('合成子任务未停止');}
 async function waitPrompt(){
  for(let i=0;i<500;i++){
   if(f.state.prompts.length){
    const state=await readJson(stateFile).catch(()=>null),childId=state?.rounds[0]?.receipts[0]?.childJobId;
    const child=childId?await readJson(path.join(f.data,'jobs',childId+'.json')).catch(()=>null):null;
    if(child?.items?.some(item=>item.promptId===f.state.prompts[0].id))return;
   }
   await delay(10);
  }
  throw Error('本机合成提交尚未持久保存上游编号');
 }
 t.after(async()=>{for(const job of f.activeJobs.values())job.controller.abort();await waitChildren();});
 return{...f,graph:g,project,program,parentId,controller,persist,adapter,stateFile,waitChildren,waitPrompt,readState:()=>readJson(stateFile)};
}
