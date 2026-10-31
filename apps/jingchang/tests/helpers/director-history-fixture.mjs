import {promises as fs} from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {ownedSmartFixture} from './smart-group-owned-fixture.mjs';import {persistFixture} from './library-backup-server.mjs';
import {normalizeNativeWorkflow,nativeToFragment} from '../../lib/native-canvas-core.mjs';
import {newMinimaxSegment,normalizeMinimaxTimeline} from '../../public/minimax-h3-core.js';
import {normalizeLtxTimeline,ltxDefaults} from '../../public/ltx-director-core.js';
import {nativeLoopSettings} from '../../public/native-loop-core.js';import {applyNativeLoopSettings} from '../../public/native-loop.js';
import {generationService} from '../../lib/generation.mjs';import {canvasRunner} from '../../lib/canvas-runner.mjs';
import {cloudWorkflowService} from '../../lib/cloud-workflows.mjs';import {h3RunningHubMock,h3RunningHubGraph} from './minimax-runninghub-fixture.mjs';
import {h3Mock,h3Workflow} from './minimax-h3-fixture.mjs';import {ltxMock,ltxWorkflow,wav} from './ltx-fixture.mjs';import {storeAsset,readJson,atomicJson,records} from '../../lib/workspace.mjs';
export async function directorHistoryFixture(stage,kind){
 const data=path.join(stage,'data'),owned=await ownedSmartFixture(data),mock=await(kind==='rh'?h3RunningHubMock():kind==='h3'?h3Mock():ltxMock());
 try{
  const resources=[],media=[];for(let i=0;i<2;i++){
   const a=owned.entries[i].asset;resources.push({url:'/owned/image-'+i,archive:'resources/image-'+i+'.png',portableUrl:a.url,asset:a});media.push({id:'image-'+i,type:'smart-image',x:i*200,y:0,images:['/owned/image-'+i]});
   if(kind==='ltx'){const bytes=wav();if(i)for(let at=44;at<bytes.length;at+=2)bytes.writeInt16LE(-bytes.readInt16LE(at),at);const audio=await storeAsset(data,bytes,{name:'owned-audio-'+i+'.wav',type:'audio/wav'});resources.push({url:'/owned/audio-'+i,archive:'resources/audio-'+i+'.wav',portableUrl:audio.url,asset:audio});media.push({id:'audio-'+i,type:'smart-image',x:i*200+100,y:0,images:['/owned/audio-'+i]});}
  }
  const project=nativeToFragment(normalizeNativeWorkflow({format:'infinite-smart-canvas-workflow',version:1,nodes:[...media,{id:'group',type:'smart-group',x:0,y:0,items:media.map(n=>n.id)},{id:'loop',type:'smart-loop',x:500,y:0,count:2,loopStart:1},{id:'target',type:kind!=='ltx'?'smart-minimax':'ltxDirector',x:800,y:0,text:'旧导演实际协议恢复'},{id:'output',type:'output',x:1100,y:0}],connections:[{from:'group',to:'loop'},{from:'loop',to:'target'},{from:'target',to:'output'}]}),resources,'旧导演档案 · '+kind),node=id=>project.nodes.find(n=>n.params.nativeCanvas.node.id===id),target=node('target');delete project.settings.nativeMediaVersion;target.type='video';target.params.nativeCanvas.adaptation='configured';applyNativeLoopSettings(node('loop'),{...nativeLoopSettings(node('loop')),enabled:true,count:2,start:1,mode:'serial',imageInput:true,imageBatchSize:kind==='ltx'?2:1});
  const activeJobs=new Map(),seedState={draws:0},draw=()=>800+seedState.draws++,generation=generationService({data,activeJobs,minimaxSeedDraw:draw}),projects={load:async()=>project,apply:async()=>project};
  let template,recipe,cloudWorkflows;
  if(kind==='rh'){
   cloudWorkflows=cloudWorkflowService({data,activeJobs,projects,pollInterval:10});const initial=await cloudWorkflows.create({projectId:project.id});recipe=await cloudWorkflows.save(initial.id,{revision:initial.revision,name:'Owned RH H3 history',kind:'workflow',baseUrl:mock.endpoint,targetId:'2084608321469898754',fields:[],minimaxProfile:'h3',workflowJson:h3RunningHubGraph()});target.params.cloudBinding={recipeId:recipe.id,recipeRevision:recipe.revision,inputs:[]};
  }else{template=await generation.saveTemplate({name:'本机 '+kind+' 协议工作流',workflow:kind==='h3'?h3Workflow:ltxWorkflow});target.params.workflowBinding={workflowId:template.id,count:1,overrides:[],imageSources:[]};}
  const binding=target.params[kind==='rh'?'cloudBinding':'workflowBinding'];
  if(kind!=='ltx')binding.minimaxH3=normalizeMinimaxTimeline({version:1,engine:kind==='rh'?'runninghub':'comfyui',segments:[newMinimaxSegment('owned-segment',0,{duration:1,trimOut:1,prompt:'原始片段',seedMode:'random'})],selectedSegmentId:'owned-segment',autoUpstream:true});
  else binding.ltxDirector=normalizeLtxTimeline({...ltxDefaults,nodeId:'46',durationFrames:24,useCustomAudio:true,globalPrompt:'原全局提示词',segments:[{id:'owned-image',type:'image',start:0,length:24,prompt:'原镜头',sourceNodeId:node('loop').id,sourceIndex:0,guideStrength:.7}],audioSegments:[{id:'owned-audio',type:'audio',start:0,length:24,trimStart:0,sourceNodeId:node('loop').id,sourceIndex:1}]});
  await persistFixture({data,p:project});const runner=canvasRunner({data,activeJobs,generation,cloudWorkflows,pollInterval:10,minimaxSeedDraw:draw}),file=id=>path.join(data,'jobs',id+'.json');
  const credentials=steps=>kind==='rh'?{cloudCredentials:steps.filter(s=>s.kind==='runninghub').map(s=>({nodeId:s.executionId||s.nodeId,apiKey:'synthetic-director-history-only',authorization:{origin:mock.endpoint,kind:'workflow',targetId:recipe.targetId,requestLimit:1,sendFields:true,sendAssets:s.sendAssets,sendWorkflow:true,budget:1,currency:'CNY'}}))}:{};
  const rebuild=()=>canvasRunner({data,activeJobs,projects,generation:generationService({data,activeJobs,minimaxSeedDraw:draw}),cloudWorkflows:kind==='rh'?cloudWorkflowService({data,activeJobs,projects,pollInterval:10}):undefined,pollInterval:10,minimaxSeedDraw:draw});
  const wait=async(id,predicate=row=>!['queued','running'].includes(row.status))=>{const until=Date.now()+30000;while(Date.now()<until){const row=await readJson(file(id));if(predicate(row))return row;await new Promise(r=>setTimeout(r,20));}throw Error('Owned director wait timed out');};
  const idle=async()=>{const until=Date.now()+10000;while(activeJobs.size&&Date.now()<until)await new Promise(r=>setTimeout(r,20));if(activeJobs.size)throw Error('Owned director still active');};
  return{...mock,stage,data,kind,owned,resources,project,p:project,node,target,template,recipe,activeJobs,generation,runner,seedState,draw,wait,idle,file,jobFiles:()=>records(path.join(data,'jobs')),start:async()=>runner.start(project,{revision:project.revision,requestId:randomUUID(),consent:true,...credentials(await runner.plan(project))},mock.endpoint),persist:()=>atomicJson(path.join(data,'projects',project.id,'project.json'),project),rebuild,resume:async id=>{const row=await readJson(file(id));return rebuild().resume(id,credentials(row.steps.filter(s=>s.status!=='completed')));}};

 }catch(error){await mock.close();throw error;}
}
