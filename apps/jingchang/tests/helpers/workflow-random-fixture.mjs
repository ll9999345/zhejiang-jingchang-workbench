import http from 'node:http';
import {once} from 'node:events';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generationService} from '../../lib/generation.mjs';
import {makeProject,makeNode} from '../../lib/model.mjs';
import {readJson} from '../../lib/workspace.mjs';
export const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTuEAAAAASUVORK5CYII=','base64');
export const workflow={'1':{class_type:'SyntheticInput',inputs:{seed:10,strength:.5,text:'本机协议测试'}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}}};
export const fields=[{nodeId:'1',name:'seed',control:'number',randomEnabled:true,min:10,max:20,step:1},{nodeId:'1',name:'strength',control:'number',randomEnabled:true,min:0,max:1,step:.25}];
export async function randomFixture(t,{draw=()=>.5}={}){
 const state={prompts:[],uploads:0,queries:[],rh:[],hold:false},server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);let body;try{body=JSON.parse(Buffer.concat(chunks));}catch{}
  res.setHeader('content-type','application/json');
  if(req.url==='/prompt'){const id='prompt-'+(state.prompts.length+1);state.prompts.push({id,body});return res.end(JSON.stringify({prompt_id:id}));}
  if(req.url==='/upload/image'||req.url==='/task/openapi/upload'){state.uploads++;return res.end(JSON.stringify(req.url==='/upload/image'?{name:'local.png',subfolder:'',type:'input'}:{code:0,data:{fileName:'api/local.png'}}));}
  if(req.url.startsWith('/history/')){const id=req.url.split('/').at(-1);state.queries.push(id);return res.end(state.hold?'{}':JSON.stringify({[id]:{status:{completed:true,status_str:'success'},outputs:{'2':{images:[{filename:id+'.png',type:'output',subfolder:''}]}}}}));}
  if(['/task/openapi/create','/task/openapi/ai-app/run'].includes(req.url)){const id=String(123456788+state.rh.length);state.rh.push({id,body,url:req.url});return res.end(JSON.stringify({code:0,data:{taskId:id}}));}
  if(req.url==='/openapi/v2/query'){state.queries.push(body.taskId);return res.end(JSON.stringify({taskId:body.taskId,status:state.hold?'RUNNING':'SUCCESS',results:[{outputType:'png',url:endpoint+'/output.png'}]}));}
  if(req.url.startsWith('/view')||req.url==='/output.png'){res.setHeader('content-type','image/png');return res.end(png);}
  res.statusCode=404;res.end('{}');
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const endpoint='http://127.0.0.1:'+server.address().port,data=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-random-')),activeJobs=new Map(),project=makeProject('随机参数验收'),generation=generationService({data,activeJobs,workflowRandomDraw:draw});
 const template=await generation.saveTemplate({name:'本机数字随机',workflow,fields});project.nodes=[makeNode('image',100,100)];
 return{data,activeJobs,project,generation,template,state,endpoint};
}
export async function waitRandom(f,id,predicate=j=>!['queued','running'].includes(j.status)){
 const deadline=Date.now()+15000;while(Date.now()<deadline){const job=await readJson(path.join(f.data,'jobs',id+'.json'));if(predicate(job))return job;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('本机随机任务等待超时');
}
export async function idleRandom(f){for(let i=0;i<500&&f.activeJobs.size;i++)await new Promise(resolve=>setTimeout(resolve,10));if(f.activeJobs.size)throw Error('本机任务未停止');}
export const randomBody=(f,id='random-local')=>({workflowId:f.template.id,workflowRevision:f.template.revision,requestId:id,revision:f.project.revision,count:1,overrides:[]});
