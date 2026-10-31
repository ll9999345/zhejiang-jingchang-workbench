import http from 'node:http';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {png} from './camera-angle-fixture.mjs';
export {png};
export const ltxWorkflow={
 '46':{class_type:'LTXDirector',inputs:{global_prompt:'original',duration_frames:120,duration_seconds:5,timeline_data:'{"segments":[],"audioSegments":[]}',local_prompts:'',segment_lengths:'',epsilon:.001,guide_strength:'',use_custom_audio:false,frame_rate:24,display_mode:'seconds',custom_width:768,custom_height:512,resize_method:'maintain aspect ratio',divisible_by:32,img_compression:18,timeline_ui:''}},
 'guide':{class_type:'LTXDirectorGuide',inputs:{guide_data:['46',4],scale_by:1}},
 'sampler':{class_type:'SamplerCustom',inputs:{seed:10,enabled:true}},
 'out':{class_type:'SaveVideo',inputs:{video:['guide',0],filename_prefix:'LTX'}}
};
export function wav(){const rate=8000,samples=rate*4,bytes=Buffer.alloc(44+samples*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);for(let i=0;i<samples;i++)bytes.writeInt16LE(Math.round(Math.sin(i/rate*440*2*Math.PI)*3000),44+i*2);return bytes;}
let video;
export async function ltxMock(){
 video??=execFileSync('ffmpeg',['-v','error','-nostdin','-f','lavfi','-i','color=c=teal:s=256x160:r=24:d=1','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-f','mp4','-movflags','frag_keyframe+empty_moov','pipe:1']);
 const state={uploads:[],submissions:[],queries:[],pending:false,uncertain:false,uploadUncertain:false};
 const server=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks);res.setHeader('content-type','application/json');
  if(req.url==='/system_stats')return res.end('{}');
  if(req.url==='/upload/image'){const filename=raw.toString().match(/filename="([^"]+)"/)?.[1];state.uploads.push({filename,raw});if(state.uploadUncertain)return res.destroy();return res.end(JSON.stringify({name:filename,subfolder:'ltx-input',type:'input'}));}
  if(req.url==='/prompt'){state.submissions.push(JSON.parse(raw).prompt);if(state.uncertain)return res.destroy();return res.end(JSON.stringify({prompt_id:'ltx-'+state.submissions.length}));}
  if(req.url.startsWith('/history/')){const id=req.url.split('/').at(-1);state.queries.push(id);return res.end(JSON.stringify(state.pending?{}:{[id]:{status:{completed:true,status_str:'success'},outputs:{out:Object.values(state.submissions[Number(id.split('-').at(-1))-1]).some(n=>n.class_type==='LTXDirector')?{videos:[{filename:'result.mp4',subfolder:'',type:'output'}]}:{images:[{filename:'result.png',subfolder:'',type:'output'}]}}}}));}
  if(req.url.startsWith('/view')&&req.url.includes('result.png')){res.setHeader('content-type','image/png');return res.end(png);}
  if(req.url.startsWith('/view')){res.setHeader('content-type','video/mp4');return res.end(video);}
  res.statusCode=404;res.end('{}');
 });server.listen(0,'127.0.0.1');await once(server,'listening');return {state,endpoint:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(r=>{server.close(r);server.closeAllConnections();})};
}
