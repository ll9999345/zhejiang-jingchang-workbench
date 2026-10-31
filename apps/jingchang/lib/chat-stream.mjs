// Chat Completions text only: deltas are data, never executable tool calls.
const MAX_TEXT=200000,MAX_WIRE=4*1024*1024,MAX_EVENT=512*1024;
const reasons=new Set(['stop','length','content_filter','tool_calls','function_call']);
const fail=message=>{throw Object.assign(new Error(message),{publicMessage:message});};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function checkedChatPayload(payload){
 if(!object(payload))fail('平台返回的对话数据格式无效；不会自动重发');
 const check=value=>{if(value.error||value.success===false||(value.code!==undefined&&value.code!==200&&value.code!=='200'))fail('平台返回对话错误，请检查原请求；不会自动重发');};
 check(payload);
 // APIMart wraps a normal completion once in {code:200,data:{choices:…}}.
 // Do not search arbitrary nested data or replace a present top-level choice.
 if(!Object.hasOwn(payload,'choices')&&object(payload.data)){payload=payload.data;check(payload);}
 return payload;
}
export function chatReply(payload){
 payload=checkedChatPayload(payload);
 const choice=payload?.choices?.[0],m=choice?.message;if(!m||m.tool_calls?.length||m.function_call)fail('对话未返回普通文字；此页面不执行模型工具');
 let text=m.content??m.refusal;if(Array.isArray(text))text=text.filter(x=>object(x)&&(x.type===undefined||x.type==='text')).map(x=>typeof x.text==='string'?x.text:typeof x.content==='string'?x.content:'').filter(Boolean).join('\n');
 if(typeof text!=='string'||!text.trim()||text.length>MAX_TEXT)fail('模型未返回有效文字或回答超过20万字');
 const finishReason=choice.finish_reason==null?'stop':reasons.has(choice.finish_reason)?choice.finish_reason:'unknown';
 return{text,finishReason,complete:finishReason==='stop'};
}
export function redactChatText(text,key,final=false){
 if(!key)return text;
 const safe=text.split(key).join('[已隐藏密钥]');
 // Do not publish a key prefix that could become a complete key in the next chunk.
 for(let n=Math.min(key.length-1,safe.length);n>0;n--)if(safe.endsWith(key.slice(0,n)))return safe.slice(0,-n)+(final?'[已隐藏密钥片段]':'');
 return safe;
}
export async function consumeChatStream(response,{onDelta=async()=>{},signal}={}){
 let pending='',event=[],eventSize=0,text='',finishReason=null,done=false,total=0;const decoder=new TextDecoder('utf-8',{fatal:true});
 async function dispatch(){if(!event.length)return;const data=event.join('\n');event=[];eventSize=0;if(data==='[DONE]'){done=true;return;}let payload;try{payload=JSON.parse(data);}catch{fail('对话流包含无效数据；已接收片段会保留，不会自动重发');}if(payload?.error)fail('平台在回答过程中返回错误；不会自动重发');if(!Array.isArray(payload?.choices))fail('对话流缺少有效消息');for(const choice of payload.choices){if(choice.index!==0)continue;const delta=choice.delta||{};if(delta.tool_calls?.length||delta.function_call)fail('对话流返回了工具调用；此页面不执行模型工具');const content=delta.content??delta.refusal;if(content!==undefined&&content!==null){if(typeof content!=='string')fail('对话流文字格式无效');if(text.length+content.length>MAX_TEXT)fail('回答超过20万字，已停止接收');if(finishReason&&content)fail('回答结束后仍返回文字，结果需核对');text+=content;if(content)await onDelta(text);}if(choice.finish_reason!==undefined&&choice.finish_reason!==null){if(!reasons.has(choice.finish_reason))fail('模型返回未知结束状态');finishReason=choice.finish_reason;}}}
 async function line(value){if(value==='')return dispatch();if(value.startsWith('data:')){const part=value.slice(5).replace(/^ /,'');eventSize+=part.length;if(eventSize>MAX_EVENT)fail('对话流单条消息过大');event.push(part);}}
 async function drain(final=false){while(!done){const match=/[\r\n]/.exec(pending);if(!match)break;const i=match.index;if(pending[i]==='\r'&&i===pending.length-1&&!final)break;const count=pending[i]==='\r'&&pending[i+1]==='\n'?2:1;const value=pending.slice(0,i);pending=pending.slice(i+count);await line(value);}if(pending.length>MAX_EVENT)fail('对话流单条消息过大');}
 if(!response.body)fail('平台未返回对话流');
 for await(const chunk of response.body){if(signal?.aborted)throw signal.reason;total+=chunk.length;if(total>MAX_WIRE)fail('对话流超过4MB，已停止接收');pending+=decoder.decode(chunk,{stream:true});await drain();if(done)break;}
 if(!done){pending+=decoder.decode();await drain(true);if(pending)await line(pending);await dispatch();}
 if(!finishReason&&!done)fail('连接在回答结束前断开；保留片段，不会自动重发');
 if(!text.trim())fail('模型未返回有效文字');
 // A DONE sentinel is a terminal marker; length/filter/tool termination stays incomplete.
 return{text,finishReason:finishReason||'stop',complete:!finishReason||finishReason==='stop'};
}
