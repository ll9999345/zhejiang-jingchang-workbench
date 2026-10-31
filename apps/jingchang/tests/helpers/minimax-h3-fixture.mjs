import http from 'node:http';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
export {png,wav} from './ltx-fixture.mjs';
export const h3Workflow={
 '115':{class_type:'ResolutionSelector',inputs:{aspect_ratio:'16:9 (Widescreen)',megapixels:.4,multiple:32}},
 '129':{class_type:'RandomNoise',inputs:{noise_seed:1}},
 '131':{class_type:'ComfyMathExpression',inputs:{expression:'round(a * 24)','values.a':['132',0]}},
 '132':{class_type:'PrimitiveFloat',inputs:{value:1}},
 '136':{class_type:'MiniMaxH3ReferenceToVideo',inputs:{prompt:['138',0],width:['115',0],height:['115',1],length:['131',1],clip:['clip',0],vae:['vae',0],audio_vae:['vae',0],'ref_images.ref_image_0':['137',0]}},
 '137':{class_type:'LoadImage',inputs:{image:'original-reference.png'}},
 '138':{class_type:'PrimitiveStringMultiline',inputs:{value:'original prompt'}},
 'clip':{class_type:'CLIPLoader',inputs:{clip_name:'owned-mock.safetensors'}},
 'vae':{class_type:'VAELoader',inputs:{vae_name:'owned-mock.safetensors'}},
 'out':{class_type:'SaveVideo',inputs:{video:['136',1],filename_prefix:'H3-test'}}
};
let video;
export function h3Video(){return video??=execFileSync('ffmpeg',['-v','error','-nostdin','-f','lavfi','-i','color=c=teal:s=192x108:r=24:d=2','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-f','mp4','-movflags','frag_keyframe+empty_moov','pipe:1']);}
export async function h3Mock(){
 const bytes=h3Video(),state={uploads:[],submissions:[],queries:[],pending:false,uncertain:false,uploadUncertain:false,imageOutputs:1};
 const server=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks);res.setHeader('content-type','application/json');
  if(req.url==='/system_stats')return res.end('{}');
  if(req.url==='/upload/image'){const name=raw.toString().match(/filename="([^"]+)"/)?.[1];state.uploads.push({name,raw});if(state.uploadUncertain)return res.destroy();return res.end(JSON.stringify({name,subfolder:'owned-h3',type:'input'}));}
  if(req.url==='/prompt'){state.submissions.push(JSON.parse(raw).prompt);if(state.uncertain)return res.destroy();return res.end(JSON.stringify({prompt_id:'h3-'+state.submissions.length}));}
  if(req.url.startsWith('/history/')){const id=req.url.split('/').at(-1);state.queries.push(id);return res.end(JSON.stringify(state.pending?{}:{[id]:{status:{completed:true,status_str:'success'},outputs:{out:Object.values(state.submissions[Number(id.split('-').at(-1))-1]||{}).some(n=>n.class_type==='MiniMaxH3ReferenceToVideo')?{videos:[{filename:'h3-result.mp4',subfolder:'',type:'output'}]}:{images:Array.from({length:state.imageOutputs},(_,index)=>({filename:'synthetic-'+id+'-'+index+'.png',subfolder:'',type:'output'}))}}}}));}
  if(req.url.startsWith('/view')){if(req.url.includes('.png')){res.setHeader('content-type','image/png');return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64'));}res.setHeader('content-type','video/mp4');return res.end(bytes);}
  res.statusCode=404;res.end('{}');
 });server.listen(0,'127.0.0.1');await once(server,'listening');return {state,endpoint:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
