import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {cascadeProtocolFixture} from './native-cascade-protocol-fixture.mjs';
import {nativeCascadeRunner,publicCascadeJob} from '../../lib/native-cascade-runner.mjs';
import {readJson} from '../../lib/workspace.mjs';

// Production generators and parent runner, isolated temporary files and HTTP
// loopback only. This tests transport and receipts, not installed GPU models.
export async function cascadeSpecializedFixture(t,{workflow,recipe,batch,seedMode='fixed',count}={}){
 const f=await cascadeProtocolFixture(t,{pairs:[['A','B'],['A','C']]});f.activeJobs.delete(f.parentId);
 const source=f.project.nodes.find(node=>node.id==='A');source.text='';source.params.nativeCanvas.node.promptDraftText='';source.params.nativeCanvas.node.promptDraftHtml='';
 const batchWorkflow=batch&&!workflow?{...(await f.generation.template(source.params.workflowBinding.workflowId)).workflow,'4':{class_type:'KSampler',inputs:{seed:30}}}:workflow;
 const saved=batchWorkflow?await f.generation.saveTemplate({name:'isolated cascade specialized',workflow:batchWorkflow}):await f.generation.template(source.params.workflowBinding.workflowId);
 const template=batch?await f.generation.configure(saved.id,{revision:saved.revision,nativeConfig:{fields:[
  {id:'prompt',node:'1',input:'text',name:'提示词',type:'textarea',default:'template literal'},
  {id:'image',node:'3',input:'image',name:'参考图',type:'image',default:'original.png'}]}}):saved;
 if(recipe){recipe={...recipe,seedMode};if(seedMode!=='fixed')delete recipe.seed;}
 source.params.workflowBinding={workflowId:template.id,overrides:[],imageSources:recipe?[{...recipe.imageField,sourceNodeId:'A'}]:[],
  ...(recipe?{imageEnhance:recipe}:batch?{promptBatch:batch}:{}),...(count!==undefined?{count}:recipe?{count:1}:{}),incrementSeeds:false};
 const runner=nativeCascadeRunner({...f,pollInterval:5}),file=id=>path.join(f.data,'jobs',id+'.json');
 async function wait(id,predicate=job=>!['queued','running'].includes(job.status)){
  for(let i=0;i<1600;i++){const job=await readJson(file(id));if(predicate(job))return job;await delay(5);}throw Error('isolated specialized timeout');
 }
 async function idle(){for(let i=0;i<1600;i++){if(!f.activeJobs.size)return;await delay(5);}throw Error('isolated specialized jobs not idle');}
 const body=async(requestId='specialized-parent')=>({requestId,nodeId:'C',revision:f.project.revision,consent:true,previewHash:(await runner.plan(f.project,{nodeId:'C'})).previewHash});
 async function launch(){const started=await runner.start(f.project,await body(),f.pool[0]);return wait(started.id);}
 async function stop(){f.state.hold=true;const started=await runner.start(f.project,await body(),f.pool[0]);
  const accepted=await wait(started.id,job=>job.steps[0].jobId&&f.state.prompts.length===1),childId=accepted.steps[0].jobId;
  await wait(childId,job=>job.items.some(item=>item.promptId));f.activeJobs.get(started.id).controller.abort();const stopped=await wait(started.id);await idle();
  if(stopped.status!=='cancelled'||!publicCascadeJob(stopped).canResume)throw Error('isolated specialized stop failed');return{stopped,childId};
 }
 t.after(async()=>{for(const active of f.activeJobs.values())active.controller.abort();await idle();});
 return{...f,runner,source,template,recipe,file,wait,idle,body,launch,stop};
}
