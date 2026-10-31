import {randomUUID} from 'node:crypto';
import {nativeLoopFixture} from './native-loop-fixture.mjs';
import {nativeBranchRound} from '../../public/native-branch-core.js';
import {canvasRunner} from '../../lib/canvas-runner.mjs';

export async function nativeBranchFixture(t,{count=4,start=2,mode='serial',branches=3,tails=true,enabled=true,cloud=false,...options}={}) {
 const f=await nativeLoopFixture(t,{smart:true,count,start,mode,...options}),root=f.node('generate0'),output=f.node('output');
 root.title='根素材';root.params.nativeCanvas.node.type='smart-image';root.params.nativeCanvas.node.runSettings={engine:'comfy',comfyWorkflow:'本机合成输出'};
 f.loop.params.nativeBranch={version:1,enabled};
 f.project.edges=f.project.edges.filter(edge=>!(edge.source===root.id&&edge.target===output.id));
 f.project.edges.find(edge=>edge.source===f.loop.id&&edge.target===root.id).nativeCanvasConnection.kind='input';
 const targets=[],leaves=[];
 function image(id,title,x,y) {
  const node=structuredClone(root);node.id=id;node.title=title;node.text=title;node.x=x;node.y=y;node.params.nativeCanvas.node.id=id;delete node.params.nativeCanvas.header;node.params.nativeCanvas.inputOrder=[];
  f.project.nodes.push(node);return node;
 }
 const edge=(source,target,kind='flow')=>f.project.edges.push({id:randomUUID(),source:source.id,target:target.id,nativeCanvasConnection:{from:source.params.nativeCanvas.node.id,to:target.params.nativeCanvas.node.id,kind}});
 for(let i=0;i<branches;i++) {
  const target=image('native-branch-'+i,'分支 '+(i+1),700+(i===0?1:0)*100,i*300),leaf=tails?image('native-tail-'+i,'分支尾 '+(i+1),1200,i*300):target;
  edge(root,target);target.params.workflowBinding.imageSources=[{nodeId:'3',name:'image',sourceNodeId:root.id,sourceIndex:0}];
  if(tails){edge(target,leaf);leaf.params.workflowBinding.imageSources=[{nodeId:'3',name:'image',sourceNodeId:target.id,sourceIndex:0}];}
  edge(leaf,output);targets.push(target);leaves.push(leaf);
 }
 // Coordinate order differs from creation/connection order: 2,3,1.
 targets.sort((a,b)=>a.x-b.x||a.y-b.y);
 if(cloud) {
  for(const target of targets) {
   const recipe=await f.cloudWorkflows.create({projectId:f.project.id}),saved=await f.cloudWorkflows.save(recipe.id,{...recipe,name:target.title+' · 本机协议',baseUrl:f.endpoint,targetId:'12345',fields:[{nodeId:'1',fieldName:'text',type:'text',fieldValue:'未替换'},{nodeId:'2',fieldName:'image',type:'image',fieldValue:''}]});
   delete target.params.workflowBinding;target.params.nativeCanvas.node.runSettings={engine:'runninghub',rhWorkflowId:'12345'};
   target.params.cloudBinding={recipeId:saved.id,recipeRevision:saved.revision,inputs:[{nodeId:'1',fieldName:'text',useText:true},{nodeId:'2',fieldName:'image',sourceNodeId:root.id,sourceIndex:0}]};
  }
  f.runner=canvasRunner({...f,pollInterval:10});
 }
 async function body(requestId='native-branch-fixture',scope={}) {
  const steps=await f.runner.plan(f.project,scope),keys=cloud?{revision:f.project.revision,consent:true,requestId}:await f.body(requestId);
  return {...keys,...scope,cloudCredentials:steps.filter(step=>step.kind==='runninghub').map(step=>({nodeId:step.executionId,apiKey:'synthetic-loopback-only',authorization:{origin:f.endpoint,kind:step.recipe.kind,targetId:step.recipe.targetId,requestLimit:step.count,sendFields:true,sendAssets:step.sendAssets,budget:1,currency:'CNY'}}))};
 }
 return {...f,root,output,targets,leaves,branchBody:body,branchRound:round=>nativeBranchRound(f.project,f.loop,round)};
}
