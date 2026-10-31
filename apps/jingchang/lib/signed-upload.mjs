import {promises as fs} from 'node:fs';
import {request as httpsRequest} from 'node:https';
import {request as httpRequest} from 'node:http';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {validateSignedDestination,ImageApiError} from './image-api.mjs';

// Use a fresh request with fixed headers. Never forward the API Authorization header.
export async function putSignedFile({url,baseUrl,file,size,sha256,signal,onProgress=()=>{}}){
 const destination=await validateSignedDestination(url,baseUrl),target=destination.url,h=await fs.open(file,'r');
 try{const st=await h.stat();if(!st.isFile()||st.size!==size)throw Error('file-changed');signal?.throwIfAborted();
  let bytes=0;const sha=createHash('sha256'),checker=new Transform({transform(chunk,_enc,cb){bytes+=chunk.length;if(bytes>size)return cb(Error('file-changed'));sha.update(chunk);onProgress(bytes);cb(null,chunk);},flush(cb){if(bytes!==size||sha.digest('hex')!==sha256)return cb(Error('file-changed'));cb();}});
  let req;const response=new Promise((resolve,reject)=>{const options={method:'PUT',headers:{'Content-Type':'application/octet-stream','Content-Length':String(size)},signal,...(destination.pinned?{family:destination.pinned.family,autoSelectFamily:false,lookup:(_host,_options,cb)=>cb(null,destination.pinned.address,destination.pinned.family)}:{})};
   req=(target.protocol==='https:'?httpsRequest:httpRequest)(target,options,res=>{if(res.statusCode<200||res.statusCode>=300){res.resume();req.destroy(Error('upload-rejected'));return reject(Error('upload-rejected'));}let read=0;res.on('data',c=>{read+=c.length;if(read>65536)res.destroy(Error('large-response'));});res.once('error',e=>{req.destroy(e);reject(e);});res.once('end',()=>resolve(res.statusCode));});req.once('error',reject);
  });
  // Both streams settle together, including early server rejection and aborted sockets.
  const transfer=pipeline(h.createReadStream({autoClose:false,start:0,end:size-1}),checker,req),results=await Promise.allSettled([response,transfer]);
  if(results.some(r=>r.status==='rejected'))throw Error('upload-uncertain');const status=results[0].value;if(status<200||status>=300)throw new ImageApiError('lora_upload_rejected','存储服务未确认上传成功，请核对平台记录；不会自动重发',{upstreamStatus:status,uncertain:true});return{bytesSent:bytes};
 }catch(e){if(e instanceof ImageApiError)throw e;throw new ImageApiError('lora_upload_uncertain','LoRA 上传结果不明确，请核对平台记录；不会自动重发',{uncertain:true});}finally{await h.close();}
}
