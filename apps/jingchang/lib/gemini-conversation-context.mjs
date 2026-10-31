import {createHash} from 'node:crypto';
import {inspectPublicMediaSource} from './public-media.mjs';
import {guardArchiveSecrets} from './task-history-schema.mjs';
import {safeId,userError} from './workspace.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('|')===keys.sort().join('|');
const fail=message=>{throw userError(message);};
export function geminiConversationImageIds(message){
 return (message.assetIds||[]).flatMap(id=>{
  const video=(message.videoSamples||[]).find(s=>s.assetId===id),document=(message.documentSamples||[]).find(s=>s.assetId===id);
  return video?video.frames.map(f=>f.assetId):document?document.images.map(i=>i.assetId):[id];
 });
}

// Convert the ordinary conversation's already validated native Gemini message parts.
// Preserve each text/image position, including document labels and video times.
// Image bytes must match the actual local file before replacing them with IDs.
export async function geminiConversationContext({data,id,revision,sourceMessages,wireMessages,systemPrompt=''}){
 if(!safeId(id)||!Number.isSafeInteger(revision)||revision<0||!Array.isArray(sourceMessages)||!sourceMessages.length||sourceMessages.length>20||!Array.isArray(wireMessages)||sourceMessages.length!==wireMessages.length)fail('Gemini CLI原会话范围无效');
 if(Buffer.byteLength(JSON.stringify(wireMessages))+Buffer.byteLength(systemPrompt)+4096>18*1024**2)fail('Gemini CLI本次完整上下文超过18MiB，请明确减少引用或新建对话；未发送');
 const images=new Map(),messages=[];let rawBytes=0;
 for(let index=0;index<sourceMessages.length;index++){
  const source=sourceMessages[index],wire=wireMessages[index],expectedRole=source.role==='assistant'&&source.mode==='image'?'user':source.role;
  if(source.nativeVideos?.length)fail('Gemini CLI暂不发送原视频及声音；请保留引用切回原API，尚未发送');
  if(!safeId(source.id)||source.state==='incomplete'||!['user','assistant'].includes(expectedRole)||wire.role!==(expectedRole==='assistant'?'model':'user')||source.nativeVideos?.length)fail('Gemini CLI原会话身份、角色或输入方式不匹配');
  const ids=geminiConversationImageIds(source),content=wire.parts;
  if(!Array.isArray(content)||!content.length||content.length>200)fail('Gemini CLI消息内容无效或超过200段');
  const parts=[];let imageIndex=0;
  for(const part of content){
   if(exact(part,['text'])&&typeof part.text==='string')parts.push({type:'input_text',text:part.text});
   else if(exact(part,['inlineData'])&&exact(part.inlineData,['mimeType','data'])&&['image/png','image/jpeg','image/webp'].includes(part.inlineData.mimeType)){
    const assetId=ids[imageIndex++];if(!safeId(assetId))fail('Gemini CLI图片与原消息引用不对应');
    const match=typeof part.inlineData.data==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(part.inlineData.data)?[null,part.inlineData.mimeType,part.inlineData.data]:null;
    if(!match)fail('Gemini CLI只发送已检查的本机图片，不接受额外远程图片地址');
    let image=images.get(assetId);
    if(!image){const s=await inspectPublicMediaSource(data,assetId,10*1024**2);image={assetId:s.assetId,name:s.name,type:s.type,size:s.size,sha256:s.sourceSha256};rawBytes+=image.size;images.set(assetId,image);}
    const bytes=Buffer.from(match[2],'base64');if(image.type!==match[1]||bytes.length!==image.size||sha(bytes)!==image.sha256)fail('Gemini CLI待发送图片与原文件字节不一致');
    parts.push({type:'input_image',assetId});
   }else fail('Gemini CLI上下文暂不支持原音频、原视频或额外工具片段；可保留引用切回原API，尚未发送');
  }
  if(imageIndex!==ids.length||expectedRole==='assistant'&&parts.some(p=>p.type==='input_image'))fail('Gemini CLI图片数量或模型回答角色不匹配');
  messages.push({id:source.id,role:expectedRole,parts});
 }
 if(images.size>20||rawBytes>18*1024**2)fail('Gemini CLI完整上下文最多20张不同图片、原字节合计18MiB；未发送');
 const conversation=validateGeminiConversation({id,revision,messages}),currentAssetIds=[...new Set(messages.at(-1).parts.filter(p=>p.type==='input_image').map(p=>p.assetId))];
 return{conversation,images:[...images.values()],currentAssetIds};
}

export function validateGeminiConversation(value){
 if(!exact(value,['id','revision','messages'])||!safeId(value.id)||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.messages)||!value.messages.length||value.messages.length>20)fail('Gemini CLI会话快照无效');
 const ids=new Set();let characters=0;
 for(const m of value.messages){
  if(!exact(m,['id','role','parts'])||!safeId(m.id)||ids.has(m.id)||!['user','assistant'].includes(m.role)||!Array.isArray(m.parts)||!m.parts.length||m.parts.length>200)fail('Gemini CLI会话消息身份或内容无效');ids.add(m.id);
  for(const p of m.parts){
   if(p.type==='input_text'&&exact(p,['type','text'])&&typeof p.text==='string'&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(p.text))characters+=p.text.length;
   else if(p.type==='input_image'&&exact(p,['type','assetId'])&&safeId(p.assetId)&&m.role==='user')continue;
   else fail('Gemini CLI会话消息片段无效');
  }
 }
 if(characters>100000||value.messages.at(-1).id!=='current'||value.messages.at(-1).role!=='user')fail('Gemini CLI会话须包含本次问题，正文及提取内容合计最多10万字');
 guardArchiveSecrets(value);return value;
}

export function geminiConversationWire(conversation,imageParts){
 validateGeminiConversation(conversation);
 return conversation.messages.map(m=>({role:m.role==='assistant'?'model':'user',parts:m.parts.map(p=>p.type==='input_text'?{text:p.text}:imageParts.get(p.assetId)||fail('Gemini CLI原图片资料缺失'))}));
}
