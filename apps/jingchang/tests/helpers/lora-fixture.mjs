import http from 'node:http';
import {once} from 'node:events';
export const loraKey='synthetic-lora-api-secret',signedSecret='synthetic-signed-storage-secret';
export function tensorFile(raw={lora_up:{dtype:'F32',shape:[2,2],data_offsets:[0,16]}},bytes=Buffer.alloc(16)){
 const header=Buffer.from(typeof raw==='string'?raw:JSON.stringify(raw)),len=Buffer.alloc(8);len.writeBigUInt64LE(BigInt(header.length));return Buffer.concat([len,header,bytes]);
}
export async function loraMock(){
 const state={queries:[],uploads:[],calls:[],submits:[],hold:false,reject:false,redirect:false,drop:false,badUrl:null,echoKey:false,rejectPlan:false,release:[]};
 const storage=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);state.uploads.push({method:req.method,url:req.url,headers:req.headers,bytes:Buffer.concat(chunks)});if(state.drop)return res.destroy();if(state.redirect){res.writeHead(307,{location:storageBase+'/unexpected'});return res.end();}if(state.reject){res.statusCode=403;return res.end('rejected');}if(state.hold){state.release.push(()=>res.end());return;}res.end();});storage.listen(0,'127.0.0.1');await once(storage,'listening');const storageBase='http://127.0.0.1:'+storage.address().port;
 const server=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);let b;try{b=JSON.parse(Buffer.concat(chunks));}catch{}state.calls.push(req.url);res.setHeader('content-type','application/json');
  if(req.url==='/api/openapi/getLoraUploadUrl'){state.queries.push({body:b,headers:req.headers});if(state.rejectPlan)return res.end(JSON.stringify({code:500,data:{}}));return res.end(JSON.stringify({code:0,data:{fileName:'api-lora-cn/'+b.md5Hex+'.safetensors',url:state.badUrl||(storageBase+'/model?sign='+(state.echoKey?loraKey:signedSecret))}}));}
  if(req.url==='/api/openapi/getJsonApiFormat')return res.end(JSON.stringify({code:0,data:{prompt:JSON.stringify({'7':{class_type:'RHLoraLoader',inputs:{lora_name:'None',strength_model:1}},'2':{class_type:'Text',inputs:{text:'a landscape'}}})}}));
  if(req.url==='/task/openapi/create'){state.submits.push(b);return res.end(JSON.stringify({code:0,data:{taskId:'54321234'}}));}
  if(req.url==='/openapi/v2/query')return res.end(JSON.stringify({taskId:'54321234',status:'SUCCESS',results:[{url:base+'/result',outputType:'png'}]}));
  if(req.url==='/result'){res.setHeader('content-type','image/png');return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64'));}
  res.statusCode=404;res.end('{}');
 });server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 return{base,storageBase,state,close:async()=>{state.release.forEach(fn=>fn());server.closeAllConnections();storage.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>storage.close(r))]);}};
}
