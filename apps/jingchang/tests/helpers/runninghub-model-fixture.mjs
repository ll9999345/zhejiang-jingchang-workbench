import {modelGlb} from './model3d-fixture.mjs';
import http from 'node:http';
import {once} from 'node:events';
import {createCanvas} from '@napi-rs/canvas';
const canvas=createCanvas(96,64),ctx=canvas.getContext('2d');ctx.fillStyle='#6b874b';ctx.fillRect(0,0,96,64);
export const rhPng=canvas.toBuffer('image/png');
ctx.fillStyle='#caa55d';ctx.fillRect(16,12,48,32);export const secondRhPng=canvas.toBuffer('image/png');
export const imageModel='alibaba/qwen-image-3.0/image-edit',videoModel='rhart-video-s-official/image-to-video-realistic',audioModel='rhart-audio/text-to-audio/speech-2.8-hd',textModel='rhart-text-g-3-flash-preview/text-to-text';
export async function runninghubModelMock(){
 const state={calls:[],uploads:[],submissions:[],queries:[],pending:false,uncertain:false,downloadFailure:false,wrongId:false,uploadFailure:false,accountMissing:false,textAsUrl:false};let base;
 const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const b of req)chunks.push(b);const bytes=Buffer.concat(chunks);let body;try{body=JSON.parse(bytes);}catch{}
  state.calls.push({url:req.url,headers:req.headers,body});res.setHeader('content-type','application/json');
  if(req.url==='/uc/openapi/accountStatus')return res.end(JSON.stringify({code:0,data:state.accountMissing?{remainMoney:'not returned',secret:req.headers.authorization}:{remainMoney:'12.50',currency:'CNY',remainCoins:40,currentTaskCounts:2,apiKey:body.apikey}}));
  if(req.url==='/openapi/v2/media/upload/binary'){state.uploads.push({bytes,headers:req.headers});if(state.uploadFailure)return res.end('{}');return res.end(JSON.stringify({code:0,data:{download_url:base+'/uploaded/'+state.uploads.length}}));}
  if(req.url==='/openapi/v2/query'){
   state.queries.push(body.taskId);const index=Number(body.taskId)-8000,submission=state.submissions[index-1],isText=submission?.path.includes('rhart-text'),output=submission?.path.includes('3d')?'glb':submission?.path.includes('audio')?'wav':submission?.path.includes('video')?'mp4':'png';
   return res.end(JSON.stringify({taskId:state.wrongId?'999999':body.taskId,status:state.pending?'RUNNING':'SUCCESS',results:isText?[state.textAsUrl?{url:base+'/output/result.txt',outputType:'string'}:{outputType:'string',text:'RunningHub 的文字结果。'}]:[{url:base+'/output/'+index+'.'+output,outputType:output},...(output==='png'&&submission?.body.imageNum==='2'?[{url:base+'/output/second.png',outputType:'png'}]:[])]}));
  }
  if(req.url.startsWith('/openapi/v2/')){state.submissions.push({path:req.url,body,headers:req.headers});if(state.uncertain)return res.destroy();return res.end(JSON.stringify({taskId:String(8000+state.submissions.length),status:'QUEUED'}));}
  if(req.url.startsWith('/output/')){if(req.url.endsWith('.glb')){res.setHeader('content-type','model/gltf-binary');return res.end(state.invalidModel3d?Buffer.from('<html>error</html>'):state.model3dBytes||modelGlb());}if(state.downloadFailure&&req.url.endsWith('second.png')){res.statusCode=503;return res.end('{}');}if(req.url.endsWith('.txt')){res.setHeader('content-type','text/plain; charset=utf-8');return res.end('RunningHub 的文字文件结果。');}const video=req.url.endsWith('.mp4'),audio=req.url.endsWith('.wav');res.setHeader('content-type',video?'video/mp4':audio?'audio/wav':'image/png');return res.end(video?Buffer.from([0,0,0,24,...Buffer.from('ftypmp42synthetic')]):audio?Buffer.from('RIFF0000WAVEfmt synthetic'):rhPng);}
  res.statusCode=404;res.end('{}');
 });server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
 return{base,state,close:()=>new Promise(r=>{server.closeAllConnections();server.close(r);})};
}
