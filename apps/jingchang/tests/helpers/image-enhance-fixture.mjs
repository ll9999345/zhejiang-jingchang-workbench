import http from 'node:http';
import {once} from 'node:events';
import {createCanvas} from '@napi-rs/canvas';
// Deliberately small synthetic graphs and images. These verify transport and
// orchestration, not installed GPU models or enhancement quality.
export const enhanceWorkflow={
 '15':{class_type:'LoadImage',inputs:{image:'input.png'}},
 '23':{class_type:'CLIPTextEncode',inputs:{text:'details'}},
 '204':{class_type:'FloatConstant',inputs:{value:.5}},
 '202':{class_type:'EnhanceStrengthTest',inputs:{value:['204',0]}},
 '146':{class_type:'KSampler',inputs:{seed:10,denoise:['202',0]}},
 '181':{class_type:'KSampler',inputs:{seed:20,denoise:['202',0]}},
 '174':{class_type:'SaveImage',inputs:{images:['15',0],filename_prefix:'enhance'}}
};
export const upscaleWorkflow={
 '15':{class_type:'LoadImage',inputs:{image:'input.png'}},
 '172':{class_type:'SeedVR2VideoUpscaler',inputs:{seed:30,resolution:2048,max_resolution:4096,image:['15',0]}},
 '174':{class_type:'SaveImage',inputs:{images:['172',0],filename_prefix:'upscale'}}
};
export const enhanceRecipe=()=>({kind:'enhance',engine:'comfy',imageField:{nodeId:'15',name:'image'},strength:.65,strengthField:{nodeId:'204',name:'value'},seedMode:'fixed',seed:1234,seedFields:[{nodeId:'146',name:'seed'},{nodeId:'181',name:'seed'}]});
export const upscaleRecipe=()=>({kind:'upscale',engine:'comfy',imageField:{nodeId:'15',name:'image'},resolution:4096,maxResolution:4096,resolutionField:{nodeId:'172',name:'resolution'},maxResolutionField:{nodeId:'172',name:'max_resolution'},seedMode:'fixed',seed:5678,seedFields:[{nodeId:'172',name:'seed'}]});
function picture(w,h,color){const c=createCanvas(w,h),x=c.getContext('2d');x.fillStyle='#cedbe7';x.fillRect(0,0,w,h);x.fillStyle=color;x.fillRect(w*.2,h*.24,w*.6,h*.55);x.fillStyle='#fcf3da';x.fillRect(w*.43,h*.4,w*.14,h*.39);x.fillStyle='#33485c';x.beginPath();x.moveTo(w*.12,h*.24);x.lineTo(w*.5,h*.03);x.lineTo(w*.88,h*.24);x.closePath();x.fill();return c.toBuffer('image/png');}
export const originalPng=picture(280,180,'#b87361'),enhancedPng=picture(560,360,'#bf5c3c'),upscaledPng=picture(1120,720,'#be6a3c');
export async function enhanceMock(){
 const state={uploads:[],submissions:[],queries:[],cloud:[],pendingUpscale:false,failUpscale:false,uncertain:false,cloudUncertain:false};let endpoint;
 const server=http.createServer(async(req,res)=>{const parts=[];for await(const p of req)parts.push(p);const bytes=Buffer.concat(parts);res.setHeader('content-type','application/json');
  if(req.url==='/system_stats')return res.end('{}');
  if(req.url==='/upload/image'){const filename=bytes.toString().match(/filename="([^"]+)"/)?.[1];state.uploads.push({filename,bytes});return res.end(JSON.stringify({name:filename,subfolder:'enhance-input',type:'input'}));}
  if(req.url==='/prompt'){const graph=JSON.parse(bytes).prompt;state.submissions.push(graph);if(state.uncertain)return res.destroy();return res.end(JSON.stringify({prompt_id:'enhance-'+state.submissions.length}));}
  if(req.url.startsWith('/history/')){const id=req.url.split('/').at(-1),graph=state.submissions[Number(id.split('-').at(-1))-1],upscale=!!graph?.['172'];state.queries.push(id);if(upscale&&state.pendingUpscale)return res.end('{}');if(upscale&&state.failUpscale)return res.end(JSON.stringify({[id]:{status:{completed:false,status_str:'error',messages:[['execution_error',{exception_message:'synthetic GPU failure'}]]}}}));return res.end(JSON.stringify({[id]:{status:{completed:true,status_str:'success'},outputs:{'174':{images:[{filename:upscale?'upscale.png':'enhance.png',subfolder:'',type:'output'}]}}}}));}
  if(req.url==='/v1/images/generations'){state.cloud.push(JSON.parse(bytes));if(state.cloudUncertain)return res.destroy();return res.end(JSON.stringify({task_id:'cloud-enhance-'+state.cloud.length}));}
  if(req.url.startsWith('/v1/tasks/'))return res.end(JSON.stringify({task_status:'SUCCEED',output_images:[endpoint+'/enhance.png']}));
  if(req.url==='/enhance.png'||req.url.startsWith('/view')){res.setHeader('content-type','image/png');return res.end(req.url.includes('upscale.png')?upscaledPng:enhancedPng);}
  res.statusCode=404;res.end('{}');
 });server.listen(0,'127.0.0.1');await once(server,'listening');endpoint='http://127.0.0.1:'+server.address().port;return{state,endpoint,close:()=>new Promise(r=>{server.close(r);server.closeAllConnections();})};
}
