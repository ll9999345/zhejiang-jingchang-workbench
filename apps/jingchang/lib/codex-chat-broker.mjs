import http from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {safeApiCall} from './image-api.mjs';
import {parseResponsesWire,responsesTextSse} from './codex-chat-wire.mjs';
import {userError} from './workspace.mjs';

// A one-use loopback capability. The program receives only a random local
// capability, never the provider key. Its input/tools cannot widen the plan.
export async function codexChatBroker({baseUrl,model,apiKey,body,signal,onSent,onReply,apiCall=safeApiCall}){
 const token=randomBytes(32).toString('hex');let claimed=false,forwarded=0,denied=0,closed=false;
 const pending=new Set();
 async function handle(req,res){
  const fail=(code,message)=>{if(!res.writableEnded){res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:{message}}));}};
  try{
   if(req.headers.authorization!=='Bearer '+token||req.headers.host!==`127.0.0.1:${server.address()?.port}`){denied++;return fail(403,'本机范围不符');}
   if(req.method!=='POST'||req.url!=='/v1/responses'){denied++;return fail(404,'本次只允许一次Responses回答');}
   let bytes=0,raw='';for await(const chunk of req){bytes+=chunk.length;if(bytes>32*1024**2){denied++;return fail(413,'CLI请求过大');}raw+=chunk.toString('utf8');}
   let request;try{request=JSON.parse(raw);}catch{denied++;return fail(400,'CLI请求无效');}raw='';
   if(request.model!==model){denied++;return fail(409,'CLI型号与预览不符');}
   if(claimed||closed||signal?.aborted){denied++;return fail(409,'本次转发范围已使用或停止，不会重发');}
   claimed=true;await onSent();signal?.throwIfAborted();forwarded++;
   const output=await apiCall({baseUrl,path:'responses',apiKey,method:'POST',body:{...body,model,stream:true,tools:[],tool_choice:'none',store:false},signal,responseType:'bytes',maxBytes:8*1024**2});
   const reply=parseResponsesWire(output.bytes,output.mime,{apiKey});await onReply(reply);
   const clean=responsesTextSse(reply,{model});res.writeHead(200,{'content-type':'text/event-stream','content-length':String(clean.length),'cache-control':'no-store'});res.end(clean);
  }catch{fail(502,'本次回答中断；请读取镜场原记录，不会自动重发');}
 }
 const server=http.createServer((req,res)=>{const operation=handle(req,res);pending.add(operation);void operation.finally(()=>pending.delete(operation));});
 server.requestTimeout=15000;server.headersTimeout=10000;server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=server.address().port;
 async function stop(){if(closed)return;closed=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await Promise.allSettled([...pending]);}
 return{port,baseUrl:`http://127.0.0.1:${port}/v1`,token,stats:()=>({claimed,forwarded,denied}),stop};
}
