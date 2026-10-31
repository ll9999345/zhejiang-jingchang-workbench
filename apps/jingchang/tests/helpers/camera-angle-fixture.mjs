import http from 'node:http';
import {once} from 'node:events';
import {createCanvas} from '@napi-rs/canvas';
export const workflow={
 '1':{class_type:'LoadImage',inputs:{image:'original.png'}},
 '2':{class_type:'CLIPTextEncode',inputs:{text:'original prompt'}},
 '3':{class_type:'SaveImage',inputs:{images:['1',0],filename_prefix:'camera-output'}}
};
const canvas=createCanvas(280,180),ctx=canvas.getContext('2d');ctx.fillStyle='#76bbd7';ctx.fillRect(0,0,280,180);ctx.fillStyle='#32614a';ctx.fillRect(0,125,280,55);ctx.fillStyle='#c04b35';ctx.fillRect(85,60,100,75);ctx.fillStyle='#fff1d2';ctx.fillRect(117,83,24,52);ctx.beginPath();ctx.moveTo(73,60);ctx.lineTo(135,16);ctx.lineTo(196,60);ctx.closePath();ctx.fill();
export const png=canvas.toBuffer('image/png');
export async function cameraMock(){
 const state={calls:[],queries:[],pending:false,uncertain:false};let endpoint;
 const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks);let body;try{body=JSON.parse(raw);}catch{}res.setHeader('content-type','application/json');
  if(req.method==='POST')state.calls.push({url:req.url,headers:req.headers,body,raw:raw.toString()});
  if(req.url==='/system_stats')return res.end('{}');
  if(req.url==='/v1/chat/completions')return res.end(JSON.stringify({choices:[{message:{content:'生成后的光线描述'},finish_reason:'stop'}]}));
  if(req.url==='/v1/images/generations'){if(state.uncertain)return res.destroy();return res.end(JSON.stringify({task_id:'angle-'+state.calls.length}));}
  if(req.url.startsWith('/v1/tasks/')){state.queries.push(req.url);return res.end(JSON.stringify({task_status:state.pending?'RUNNING':'SUCCEED',output_images:[endpoint+'/png']}));}
  if(req.url==='/upload/image')return res.end(JSON.stringify({name:'uploaded-angle.png',subfolder:'',type:'input'}));
  if(req.url==='/prompt')return res.end(JSON.stringify({prompt_id:'comfy-'+state.calls.length}));
  if(req.url.startsWith('/history/')){state.queries.push(req.url);const id=req.url.split('/').at(-1);return res.end(JSON.stringify(state.pending?{}:{[id]:{status:{completed:true,status_str:'success'},outputs:{'3':{images:[{filename:'out.png',subfolder:'',type:'output'}]}}}}));}
  if(req.url==='/png'||req.url.startsWith('/view')){res.setHeader('content-type','image/png');return res.end(png);}
  res.statusCode=404;res.end('{}');
 });server.listen(0,'127.0.0.1');await once(server,'listening');endpoint='http://127.0.0.1:'+server.address().port;
 return {state,endpoint,close:()=>new Promise(r=>{server.close(r);server.closeAllConnections();})};
}
