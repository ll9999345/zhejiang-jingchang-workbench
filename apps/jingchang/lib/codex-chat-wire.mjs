import {randomUUID} from 'node:crypto';
import {userError} from './workspace.mjs';
import {redactChatText} from './chat-stream.mjs';

const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const text=(v,label,max=200000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw userError(label+'无效或超出容量');return v;};
// Inspect only the Responses fields which prove a plain, finished answer.
// Tool/reasoning bodies are never forwarded to the local program or retained.
export function plainResponsesReply(payload,{apiKey=''}={}){
 if(!object(payload)||!Array.isArray(payload.output)||payload.output.length>100)throw userError('Responses未返回有效输出');
 const parts=[];let invalid=false;
 for(const item of payload.output){
  if(item?.type==='reasoning')continue;
  if(item?.type!=='message'||item.role!=='assistant'||!Array.isArray(item.content)){invalid=true;continue;}
  if(item.status&&item.status!=='completed')invalid=true;
  for(const p of item.content){if(p?.type==='output_text'&&typeof p.text==='string')parts.push(p.text);else if(p?.type==='refusal'&&typeof p.refusal==='string')parts.push(p.refusal);else invalid=true;}
 }
 const result=redactChatText(text(parts.join('\n'),'Responses回答'),apiKey,true);
 const complete=payload.status==='completed'&&!payload.error&&!invalid;
 const upstreamId=typeof payload.id==='string'&&/^[-\w]{1,160}$/.test(payload.id)&&(!apiKey||!payload.id.includes(apiKey))?payload.id:undefined;
 const usage={};for(const key of ['input_tokens','output_tokens','total_tokens'])if(Number.isSafeInteger(payload.usage?.[key])&&payload.usage[key]>=0)usage[key]=payload.usage[key];
 return{text:result,complete,...(upstreamId?{upstreamId}:{}),...(Object.keys(usage).length?{usage}:{})};
}
export function parseResponsesWire(bytes,mime,{apiKey=''}={}){
 if(!Buffer.isBuffer(bytes)||bytes.length>8*1024**2)throw userError('Responses输出超过8MiB');
 let raw;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw userError('Responses输出不是有效UTF8');}
 if(mime==='application/json'){let value;try{value=JSON.parse(raw);}catch{throw userError('Responses输出不是有效JSON');}return plainResponsesReply(value,{apiKey});}
 if(mime!=='text/event-stream')throw userError('Responses接口未返回JSON或SSE；未把HTML当回答');
 let terminal=null,delta='',events=0,failed=false;
 for(const block of raw.replaceAll('\r\n','\n').split('\n\n')){
  const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).replace(/^ /,'')).join('\n');if(!data||data==='[DONE]')continue;
  if(++events>20000||data.length>1024**2)throw userError('Responses流事件过多或过大');
  let v;try{v=JSON.parse(data);}catch{throw userError('Responses流含不完整JSON；不会重发');}
  if(v.type==='response.output_text.delta'){if(typeof v.delta!=='string'||delta.length+v.delta.length>200000)throw userError('Responses片段文字无效或超限');delta+=v.delta;}
  if(['response.completed','response.incomplete','response.failed'].includes(v.type)){if(terminal)throw userError('Responses返回了多个结束结果');terminal=v.response;}
  if(v.type==='error')failed=true;
 }
 if(!terminal){if(!delta.trim())throw userError('Responses在完整回答前断开；不会重发');return{text:redactChatText(delta,apiKey,true),complete:false};}
 const reply=plainResponsesReply(terminal,{apiKey});if(failed)reply.complete=false;return reply;
}
export function responsesTextSse(reply,{model}={}){
 text(reply.text,'本机转发回答');
 const response={id:'resp_'+randomUUID().replaceAll('-',''),object:'response',created_at:Math.floor(Date.now()/1000),status:reply.complete?'completed':'incomplete',model,output:[{id:'msg_'+randomUUID().replaceAll('-',''),type:'message',status:reply.complete?'completed':'incomplete',role:'assistant',content:[{type:'output_text',text:reply.text,annotations:[]}]}],usage:reply.usage||{input_tokens:0,output_tokens:0,total_tokens:0}};
 const item=response.output[0],events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},{type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:reply.text},{type:'response.output_text.done',item_id:item.id,output_index:0,content_index:0,text:reply.text},{type:'response.output_item.done',output_index:0,item},{type:reply.complete?'response.completed':'response.incomplete',response}];
 return Buffer.from(events.map((e,i)=>'event: '+e.type+'\ndata: '+JSON.stringify({...e,sequence_number:i})+'\n\n').join(''));
}
export function codexJsonlReply(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>2*1024**2)throw userError('CLI输出超出2MiB');
 let threadId=null,turns=0,complete=false,failed=false,answer='',toolAttempt=false,warnings=0;
 for(const line of raw.split(/\r?\n/).filter(l=>l.trim())){
  let event;try{event=JSON.parse(line);}catch{throw userError('CLI输出不是完整JSONL');}
  if(event.type==='thread.started'){if(threadId&&threadId!==event.thread_id)throw userError('CLI返回不同会话编号');if(typeof event.thread_id!=='string'||!/^[-\w]{1,160}$/.test(event.thread_id))throw userError('CLI会话编号无效');threadId=event.thread_id;}
  if(event.type==='turn.started'&&++turns>1)throw userError('CLI尝试执行多轮；本次只授权一次回答');
  if(event.type==='turn.completed')complete=true;
  if(['turn.failed','error'].includes(event.type))failed=true;
  if(event.type?.startsWith('item.')){
   const item=event.item;if(!object(item))throw userError('CLI项目输出无效');
   if(item.type==='agent_message'&&event.type==='item.completed')answer=text(item.text,'CLI回答');
   else if(item.type==='error')warnings++;
   else if(!['agent_message','reasoning'].includes(item.type))toolAttempt=true;
  }
 }
 return{text:answer,complete:complete&&!failed&&!toolAttempt&&turns===1&&!!answer,toolAttempt,warnings,...(threadId?{threadId}:{})};
}
