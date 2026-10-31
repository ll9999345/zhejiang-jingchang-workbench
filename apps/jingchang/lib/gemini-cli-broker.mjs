import http from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {safeApiCall} from './image-api.mjs';
import {geminiChatModel,geminiChatReply,geminiChatBody} from './gemini-chat.mjs';
import {redactChatText} from './chat-stream.mjs';
import {userError} from './workspace.mjs';

export function geminiCliReply(payload,{apiKey=''}={}){
 const result=geminiChatReply(payload),candidate=payload.candidates[0];
 const plain=candidate.content.parts.every(p=>p&&typeof p.text==='string'&&Object.keys(p).every(k=>['text','thought','thoughtSignature'].includes(k)));
 const usage={},map={promptTokenCount:'input_tokens',candidatesTokenCount:'output_tokens',totalTokenCount:'total_tokens'};
 for(const [key,target]of Object.entries(map))if(Number.isSafeInteger(payload.usageMetadata?.[key])&&payload.usageMetadata[key]>=0)usage[target]=payload.usageMetadata[key];
 const upstreamId=typeof payload.responseId==='string'&&/^[-\w]{1,160}$/.test(payload.responseId)&&(!apiKey||!payload.responseId.includes(apiKey))?payload.responseId:undefined;
 return{text:redactChatText(result.text,apiKey,true),complete:result.complete&&plain&&payload.candidates.length===1,...(upstreamId?{upstreamId}:{}),...(Object.keys(usage).length?{usage}:{})};
}
export function geminiCliSse(reply,model){
 const usageMetadata={};for(const [key,target]of Object.entries({input_tokens:'promptTokenCount',output_tokens:'candidatesTokenCount',total_tokens:'totalTokenCount'}))if(reply.usage?.[key]!==undefined)usageMetadata[target]=reply.usage[key];
 return Buffer.from('data: '+JSON.stringify({candidates:[{content:{role:'model',parts:[{text:reply.text}]},finishReason:reply.complete?'STOP':'MAX_TOKENS',index:0}],modelVersion:model,...(Object.keys(usageMetadata).length?{usageMetadata}:{})})+'\n\n');
}

// The installed CLI receives a disposable loopback capability, not a provider key.
// Its prompt, tools, system instructions and image inputs cannot widen this body.
export async function geminiCliBroker({baseUrl,model,apiKey,body,signal,onSent,onReply,apiCall=safeApiCall}){
 if(!geminiChatModel(model))throw userError('Gemini普通对话型号无效');
 const canonical=geminiChatBody(structuredClone(body.contents),body.systemInstruction?.parts?.map(p=>p.text).join('')||'',body.generationConfig?.maxOutputTokens);
 const token=randomBytes(32).toString('hex');let claimed=false,forwarded=0,denied=0,closed=false;const pending=new Set();
 async function handle(req,res){
  const fail=(code,message)=>{if(!res.writableEnded&&!res.destroyed){res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:{message}}));}};
  try{
   if(req.headers['x-goog-api-key']!==token||req.headers.host!==`127.0.0.1:${server.address()?.port}`){denied++;return fail(403,'本机范围不符');}
   if(req.method!=='POST'||req.url!==`/v1beta/models/${model}:streamGenerateContent?alt=sse`){denied++;return fail(404,'本次只允许已确认型号的一次Gemini普通回答');}
   let bytes=0,raw='';for await(const chunk of req){bytes+=chunk.length;if(bytes>32*1024**2){denied++;return fail(413,'CLI请求过大');}raw+=chunk.toString('utf8');}
   let request;try{request=JSON.parse(raw);}catch{denied++;return fail(400,'CLI请求无效');}raw='';if(!request||typeof request!=='object'||Array.isArray(request)){denied++;return fail(400,'CLI请求无效');}
   if(claimed||closed||signal?.aborted){denied++;return fail(409,'本次范围已使用或停止，不会重发');}
   claimed=true;await onSent();signal?.throwIfAborted();forwarded++;
   const payload=await apiCall({baseUrl,path:`models/${model}:generateContent`,authMode:'gemini',apiKey,method:'POST',body:structuredClone(canonical),signal});
   const reply=geminiCliReply(payload,{apiKey});await onReply(reply);
   const clean=geminiCliSse(reply,model);res.writeHead(200,{'content-type':'text/event-stream','content-length':String(clean.length),'cache-control':'no-store'});res.end(clean);
  }catch{fail(502,'本次回答中断；请读取镜场原记录，不会自动重发');}
 }
 const server=http.createServer((req,res)=>{const operation=handle(req,res);pending.add(operation);void operation.finally(()=>pending.delete(operation));});
 server.requestTimeout=15000;server.headersTimeout=10000;server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
 async function stop(){if(closed)return;closed=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await Promise.allSettled([...pending]);}
 return{port,baseUrl:`http://127.0.0.1:${port}/`,token,stats:()=>({claimed,forwarded,denied}),stop};
}
