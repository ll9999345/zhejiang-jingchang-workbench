import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeToFragment,normalizeNativeWorkflow} from '../../lib/native-canvas-core.mjs';
import {generationService} from '../../lib/generation.mjs';
import {canvasLlmService} from '../../lib/canvas-llm.mjs';
import {directImageService} from '../../lib/direct-images.mjs';
import {canvasRunner} from '../../lib/canvas-runner.mjs';
import {cloudWorkflowService} from '../../lib/cloud-workflows.mjs';
import {creationStudioService} from '../../lib/creation-studio.mjs';
import {normalizeStudioBinding} from '../../lib/canvas-studio.mjs';
import {nativeLoopSettings} from '../../public/native-loop-core.js';
import {applyNativeLoopSettings} from '../../public/native-loop.js';
import {readJson,storeAsset} from '../../lib/workspace.mjs';

export const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
export const source=(id,type,extra={})=>({id,type,x:0,y:0,...extra});
export async function nativeLoopFixture(t,{smart=false,count=3,start=2,batch=1,mode='serial',stages=1,chat=false,imageApi=false,upstream=false,media=0}={}){
 const state={prompts:[],chats:[],images:[],uploads:[],rhCreates:[],rhQueries:[],studioCreates:[],studioQueries:[],active:0,maxActive:0,hold:false,delayMs:0,finish:'stop',outputs:1};
 const mocks=[];
 for(let backend=0;backend<2;backend++){
  const mock=http.createServer(async(req,res)=>{
   const chunks=[];for await(const chunk of req)chunks.push(chunk);res.setHeader('content-type','application/json');
   if(req.url==='/prompt'){
    const body=JSON.parse(Buffer.concat(chunks)),id='fixture-'+state.prompts.length;
    state.prompts.push({id,backend,body});state.active++;state.maxActive=Math.max(state.maxActive,state.active);
    return res.end(JSON.stringify({prompt_id:id}));
   }
   if(req.url.startsWith('/history/')){
    const id=req.url.split('/').at(-1),record=state.prompts.find(item=>item.id===id);
    if(state.hold)return res.end('{}');
    if(state.delayMs)await delay(state.delayMs);
    if(!record.complete){record.complete=true;state.active--;}
    const images=Array.from({length:state.outputs},(_,index)=>({filename:id+'-'+index+'.png',type:'output',subfolder:''}));
    return res.end(JSON.stringify({[id]:{status:{completed:true,status_str:'success'},outputs:{'2':{images}}}}));
   }
   if(req.url.startsWith('/view')){res.setHeader('content-type','image/png');return res.end(png);}
   if(req.url==='/upload/image'){state.uploads.push({backend,bytes:Buffer.concat(chunks)});return res.end(JSON.stringify({name:'fixture-reference.png',subfolder:'',type:'input'}));}
   if(req.url==='/v1/chat/completions'){
    const body=JSON.parse(Buffer.concat(chunks));state.chats.push(body);state.active++;state.maxActive=Math.max(state.maxActive,state.active);if(state.delayMs)await delay(state.delayMs);state.active--;
    const content=body.messages.find(message=>message.role==='user').content,text=typeof content==='string'?content:content.filter(part=>part.type==='text').map(part=>part.text).join('\n');
    return res.end(JSON.stringify({choices:[{message:{content:'已改写('+text+')'},finish_reason:state.finish}]}));
   }
   if(req.url==='/v1/images/generations'||req.url==='/v1/images/edits'){
    const bytes=Buffer.concat(chunks),contentType=req.headers['content-type']||'';
    let body;
    if(contentType.startsWith('multipart/form-data')){
     const form=await new Request('http://127.0.0.1/mock',{method:'POST',headers:{'content-type':contentType},body:bytes}).formData();
     body=Object.fromEntries([...form.entries()].filter(([,value])=>typeof value==='string'));
     body.images=await Promise.all(form.getAll('image[]').map(async image=>({name:image.name,type:image.type,bytes:Buffer.from(await image.arrayBuffer())})));
    }else body=JSON.parse(bytes);
    state.images.push(body);state.active++;state.maxActive=Math.max(state.maxActive,state.active);if(state.delayMs)await delay(state.delayMs);state.active--;
    return res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));
   }
   if(req.url==='/task/openapi/create'){
    const body=JSON.parse(Buffer.concat(chunks)),id=String(10000+state.rhCreates.length);state.rhCreates.push({id,body});state.active++;state.maxActive=Math.max(state.maxActive,state.active);return res.end(JSON.stringify({code:0,data:{taskId:id}}));
   }
   if(req.url==='/openapi/v2/query'){
    const body=JSON.parse(Buffer.concat(chunks));state.rhQueries.push(body.taskId);const record=state.rhCreates.find(item=>item.id===body.taskId);if(state.hold)return res.end(JSON.stringify({taskId:body.taskId,status:'RUNNING'}));if(state.delayMs)await delay(state.delayMs);if(!record.complete){record.complete=true;state.active--;}
    return res.end(JSON.stringify({taskId:body.taskId,status:'SUCCESS',results:[{url:'http://127.0.0.1:'+mock.address().port+'/fixture.png',outputType:'png'}]}));
   }
   if(req.url==='/task/openapi/upload'){state.uploads.push({backend,bytes:Buffer.concat(chunks)});return res.end(JSON.stringify({code:0,data:{fileName:'input/synthetic.png'}}));}
   if(req.url==='/v1/contents/generations/tasks'){
    const body=JSON.parse(Buffer.concat(chunks)),id='ark-fixture-'+state.studioCreates.length;state.studioCreates.push({id,body});state.active++;state.maxActive=Math.max(state.maxActive,state.active);return res.end(JSON.stringify({id}));
   }
   if(req.url.startsWith('/v1/contents/generations/tasks/')){
    const id=req.url.split('/').at(-1);state.studioQueries.push(id);const record=state.studioCreates.find(item=>item.id===id);if(state.hold)return res.end(JSON.stringify({status:'running'}));if(state.delayMs)await delay(state.delayMs);if(!record.complete){record.complete=true;state.active--;}
    return res.end(JSON.stringify({status:'succeeded',content:{video_url:'http://127.0.0.1:'+mock.address().port+'/fixture.mp4'}}));
   }
   if(req.url==='/fixture.png'){res.setHeader('content-type','image/png');return res.end(png);}
   if(req.url==='/fixture.mp4'){res.setHeader('content-type','video/mp4');return res.end(Buffer.from('000000186674797069736f6d0000020069736f6d69736f32','hex'));}
   res.statusCode=404;res.end('{}');
  });mock.listen(0,'127.0.0.1');await once(mock,'listening');mocks.push(mock);t.after(()=>new Promise(resolve=>mock.close(resolve)));
 }
 const endpoints=mocks.map(mock=>'http://127.0.0.1:'+mock.address().port),endpoint=endpoints[0],data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-native-loop-')),activeJobs=new Map(),generation=generationService({data,activeJobs}),canvasLlm=canvasLlmService({data,activeJobs}),directImages=directImageService({data,activeJobs}),runner=canvasRunner({data,activeJobs,generation,canvasLlm,directImages,pollInterval:10}),resources=[];
 for(let i=0;i<media;i++){const asset=await storeAsset(data,png,{type:'image/png',name:'本机合成'+i+'.png'});resources.push({url:'/fixture/'+i,archive:'resources/'+i+'.png',portableUrl:asset.url,asset});}
 const nodes=[source('prompt',smart?'smart-prompt':'prompt',{text:smart?'甲《计数》;乙《计数》':'上游《计数》/《总数》',promptSplitEnabled:true}),source('loop',smart?'smart-loop':'loop',{count,loopStart:start,showPrompt:true,variablePrompt:'本地《计数》/《总数》',foreign:'源参数保留'}),...Array.from({length:stages},(_,i)=>source('generate'+i,'comfy',{text:'节点'+i})),source('output','output')];
 const connections=[{from:'prompt',to:'loop'},{from:'loop',to:'generate0'},{from:'generate'+(stages-1),to:'output'}];
 for(let i=1;i<stages;i++)connections.push({from:'generate'+(i-1),to:'generate'+i});
 if(chat){nodes.push(source('chat','llm',{text:'每轮指令'}));connections.splice(1,1,{from:'loop',to:'chat'},{from:'chat',to:'generate0'});}
 if(upstream){nodes.push(source('upstream','comfy',{text:'循环外只运行一次'}));connections.push({from:'upstream',to:'loop'});}
 if(media){nodes.push(source('pictures',smart?'smart-image':'output',{images:resources.map(r=>r.url)}));connections.push({from:'pictures',to:'loop'});}
 const project=nativeToFragment(normalizeNativeWorkflow({format:smart?'infinite-smart-canvas-workflow':'infinite-canvas-workflow',version:1,nodes,connections}),resources,'原生循环本机协议样本'),node=raw=>project.nodes.find(node=>node.params?.nativeCanvas?.node.id===raw),loop=node('loop');
 applyNativeLoopSettings(loop,{...nativeLoopSettings(loop),enabled:true,mode,imageInput:media>0||upstream,imageBatchSize:batch});
 const template=await generation.saveTemplate({name:'本机合成输出',workflow:{'1':{class_type:'CLIPTextEncode',inputs:{text:'未替换'}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}},'3':{class_type:'LoadImage',inputs:{image:'未上传.png'}}}});
 const comfy=(n,{reference=false,count=1}={})=>{n.params.nativeCanvas.adaptation='configured';n.params.workflowBinding={workflowId:template.id,promptField:{nodeId:'1',name:'text'},overrides:[],imageSources:reference?[{nodeId:'3',name:'image',sourceNodeId:loop.id,sourceIndex:0}]:[],count};};
 for(let i=0;i<stages;i++)comfy(node('generate'+i));if(upstream)comfy(node('upstream'),{count:4});
 if(chat){const n=node('chat');n.params.nativeCanvas.adaptation='configured';n.params.llmBinding={platform:{id:'local-chat-fixture',name:'本机合成模型',protocol:'openai-compatible',baseUrl:endpoint+'/v1',models:[{id:'local-chat',category:'chat',referenceSupport:true}]},model:'local-chat',maxTokens:512,systemPrompt:'本机样本',includeUpstream:true,stream:false,referenceSources:[]};}
 if(imageApi){const n=node('generate0');delete n.params.workflowBinding;n.params.imageBinding={platform:{id:'local-image-fixture',name:'本机合成图片',protocol:'openai-compatible',baseUrl:endpoint+'/v1',models:[{id:'fixture-image',category:'image',referenceSupport:true}]},model:'fixture-image',size:'1024x1024',quality:'medium',includeUpstream:true,referenceSources:[]};}
 const body=async(id='local-native-loop')=>{
  const steps=await runner.plan(project),authorization=s=>({origin:new URL(endpoint).origin,model:s.llm?.model||s.image?.model,sendPrompt:true,sendReferences:s.sendAssets,requestLimit:1,budget:1,currency:'CNY'});
  return{revision:project.revision,consent:true,requestId:id,llmCredentials:steps.filter(s=>s.kind==='canvas-llm').map(s=>({nodeId:s.executionId||s.nodeId,apiKey:'synthetic-fixture-only',authorization:authorization(s)})),imageCredentials:steps.filter(s=>s.kind==='image-api').map(s=>({nodeId:s.executionId||s.nodeId,apiKey:'synthetic-fixture-only',authorization:authorization(s)}))};
 };
 const pool=endpoints.map((url,i)=>({id:'fixture-backend-'+i,name:'本机合成后端'+i,url,network:'local'}));
 const cloudWorkflows=cloudWorkflowService({data,activeJobs,projects:{load:async()=>project},pollInterval:10}),creationStudio=creationStudioService({data,activeJobs,pollInterval:10});
 async function useCloud({reference=false}={}){
  const n=node('generate0');delete n.params.workflowBinding;delete n.params.imageBinding;let recipe=await cloudWorkflows.create({projectId:project.id});recipe=await cloudWorkflows.save(recipe.id,{...recipe,baseUrl:endpoint,targetId:'12345',fields:[{nodeId:'1',fieldName:'text',type:'text',fieldValue:'旧文字'},...(reference?[{nodeId:'2',fieldName:'image',type:'image',fieldValue:''}]:[])]});
  n.params.nativeCanvas.node.type='rh';n.params.cloudBinding={recipeId:recipe.id,recipeRevision:recipe.revision,inputs:[{nodeId:'1',fieldName:'text',useText:true},...(reference?[{nodeId:'2',fieldName:'image',sourceNodeId:loop.id,sourceIndex:0}]:[])]};const runner=canvasRunner({data,activeJobs,generation,cloudWorkflows,pollInterval:10}),body=async(requestId='rh-native-loop')=>({revision:0,requestId,consent:true,cloudCredentials:(await runner.plan(project)).filter(s=>s.kind==='runninghub').map(s=>({nodeId:s.executionId||s.nodeId,apiKey:'synthetic-fixture-only',authorization:{origin:endpoint,kind:recipe.kind,targetId:recipe.targetId,requestLimit:1,sendFields:true,sendAssets:s.sendAssets,budget:1,currency:'CNY'}}))});return{runner,body,recipe};
 }
 function useStudio(){const n=node('generate0');delete n.params.workflowBinding;delete n.params.imageBinding;n.type='video';n.params.studioBinding=normalizeStudioBinding({mode:'video',config:{protocol:'ark',model:'synthetic-ark-video',baseUrl:endpoint+'/v1',duration:5},referenceSources:[]});const runner=canvasRunner({data,activeJobs,generation,creationStudio,pollInterval:10}),body=async(requestId='studio-native-loop')=>({revision:0,requestId,consent:true,studioCredentials:(await runner.plan(project)).filter(s=>s.kind==='studio').map(s=>({nodeId:s.executionId||s.nodeId,apiKey:'synthetic-fixture-only',authorization:{origin:endpoint,model:s.studio.config.model,sendPrompt:true,sendReferences:s.sendAssets,requestLimit:1,budget:1,currency:'CNY'}}))});return{runner,body};}
 return{data,activeJobs,generation,canvasLlm,directImages,runner,project,node,loop,endpoint,endpoints,pool,state,body,comfy,cloudWorkflows,creationStudio,useCloud,useStudio};
}
export async function waitLoop(f,id){for(let i=0;i<1000;i++){const job=await readJson(path.join(f.data,'jobs',id+'.json'));if(['completed','interrupted','cancelled'].includes(job.status))return job;await delay(10);}throw Error('本机循环任务等待超时');}
export async function idleLoop(f){for(let i=0;i<500&&f.activeJobs.size;i++)await delay(10);if(f.activeJobs.size)throw Error('本机子任务尚未结束');}
export const chatText=chat=>{const value=chat.messages.find(message=>message.role==='user').content;return typeof value==='string'?value:value.filter(part=>part.type==='text').map(part=>part.text).join('\n');};
