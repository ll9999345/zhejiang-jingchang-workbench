import {isApimartMultimodal,apimartReferenceError} from '../public/apimart-reference-core.js';
import {safeApiCall,parseImageData,ImageApiError} from './image-api.mjs';
import {validateInputImage} from './providers.mjs';
import {userError} from './workspace.mjs';

const geminiModel=m=>typeof m==='string'&&/^gemini[-\w.]{1,160}$/.test(m)&&!m.includes('..');
const geminiImageModel=m=>geminiModel(m)&&/-image(?:[-.]|$)/i.test(m);
const taskId=x=>{if(typeof x!=='string'||!/^[-\w]{1,128}$/.test(x))throw new ImageApiError('invalid_response','APIMart 未返回有效任务编号',{uncertain:true});return x;};
export function validateExtendedStudio(studio,references=studio.references){
 const c=studio.config;
 if(c.protocol==='gemini'){
  if(studio.mode!=='image'||c.imageAsync||c.count!==1||c.transparent||c.quality!=='auto'||!geminiImageModel(c.model))throw userError('Gemini 原生图片需要已知图片模型、同步单图、自动质量及非透明背景');
 }
 if(c.protocol==='apimart'){
  if(studio.mode==='image'){
   if(!['gpt-image-2','gpt-image-2-ext'].includes(c.model)||!c.imageAsync||c.transparent||c.quality!=='auto')throw userError('APIMart 图片当前支持 gpt-image-2 / gpt-image-2-ext 异步生成，自动质量及非透明背景');
  }else{
   const error=apimartReferenceError(studio,references);if(error)throw userError(error);
  }
 }
}
function imageData(ref){
 const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[ref.mime];
 return validateInputImage({...ref,name:'reference.'+ext});
}
export async function generateGeminiImages({baseUrl,apiKey,studio,references=[],historyContents=[],signal}){
 validateExtendedStudio(studio,references);
 const parts=[{text:studio.prompt}];
 for(const ref of references){const r=imageData(ref);parts.push({inlineData:{mimeType:r.mime,data:r.bytes.toString('base64')}});}
 const model=studio.config.model,ratio=studio.config.ratio;
 const image={};if(ratio&&ratio!=='auto')image.aspectRatio=ratio;
 const rawResolution=studio.config.useImageResolution===true?String(studio.config.imageResolution||'').toUpperCase():'';
 if(rawResolution&&!['1K','2K','4K'].includes(rawResolution))throw userError('Gemini 图片清晰度只支持 1K、2K 或 4K');
 if(rawResolution&&model!=='gemini-2.5-flash-image')image.imageSize=rawResolution;
 const safeHistoryPart=p=>{const sig=p?.thoughtSignature;if(sig!==undefined&&(typeof sig!=='string'||sig.length>32768))return false;if(typeof p?.text==='string')return p.text.length<=32000;if(p?.inlineData)return['image/png','image/jpeg','image/webp'].includes(p.inlineData.mimeType)&&typeof p.inlineData.data==='string'&&p.inlineData.data.length<=16*1024*1024&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.inlineData.data);return false;};
 if(!Array.isArray(historyContents)||historyContents.length>16||historyContents.some(c=>!c||!['user','model'].includes(c.role)||!Array.isArray(c.parts)||!c.parts.length||c.parts.length>16||c.parts.some(p=>!safeHistoryPart(p))))throw userError('Gemini 连续会话上下文无效');
 const body={contents:[...historyContents,{role:'user',parts}],generationConfig:{responseModalities:['TEXT','IMAGE'],...(Object.keys(image).length?{responseFormat:{image}}:{})}};
 if(Buffer.byteLength(JSON.stringify(body))>18*1024*1024)throw userError('Gemini 编码后的图片请求超过18MB，请减少或缩小参考图');
 const result=await safeApiCall({baseUrl,apiKey,authMode:'gemini',path:'models/'+studio.config.model+':generateContent',method:'POST',body,signal});
 const candidate=result.candidates?.[0];
 if(result.promptFeedback?.blockReason||candidate?.finishReason&&candidate.finishReason!=='STOP')throw new ImageApiError('generation_blocked','Gemini 未完成图片生成，请到平台核对原因；不会自动重试',{uncertain:false});
 // Thought images are internal previews, not the requested output.
 const rawParts=candidate?.content?.parts||[],images=rawParts.filter(p=>!p.thought&&p.inlineData);
 if(!images.length)throw new ImageApiError('no_image','Gemini 只返回文字或没有图片，请核对原请求后再决定是否重新生成',{uncertain:true});
 if(images.length>1)throw new ImageApiError('multiple_images','Gemini 返回了多张图片，当前单图会话无法安全保存连续上下文；请核对平台任务后再决定是否重试',{uncertain:true});
 for(const p of images)if(!['image/png','image/jpeg','image/webp'].includes(p.inlineData.mimeType))throw new ImageApiError('invalid_image','Gemini 返回了不支持的图片格式',{uncertain:true});
 let geminiParts=[];
 for(const part of rawParts){
  const thoughtSignature=part.thoughtSignature??part.thought_signature;
  if(part.thought||thoughtSignature!==undefined&&(typeof thoughtSignature!=='string'||thoughtSignature.length>32768)){geminiParts=null;break;}
  if(typeof part.text==='string'){if(part.text.length>32000){geminiParts=null;break;}geminiParts.push({type:'text',text:part.text,...(thoughtSignature?{thoughtSignature}:{})});}
  else if(part.inlineData&&!part.thought)geminiParts.push({type:'image',index:0,mime:part.inlineData.mimeType,...(thoughtSignature?{thoughtSignature}:{})});
  else{geminiParts=null;break;}
 }
 if(!geminiParts?.length)geminiParts=null;
 return {images:await parseImageData({data:images.map(p=>({b64_json:p.inlineData.data}))},{baseUrl,signal,maxImages:1}),geminiParts};
}
export async function listGeminiModels({baseUrl,apiKey,signal}){
 const result=await safeApiCall({baseUrl,apiKey,authMode:'gemini',path:'models',signal});
 if(!Array.isArray(result.models))throw userError('Gemini 没有返回有效模型列表');
 const models=result.models.filter(m=>m.supportedGenerationMethods?.includes('generateContent')).map(m=>{const id=String(m.name||'').replace(/^models\//,'');return{id,category:geminiImageModel(id)?'image':'chat'};}).filter(m=>geminiModel(m.id)&&!/-tts(?:[-.]|$)/i.test(m.id)&&(!apiKey||!m.id.includes(apiKey))).slice(0,1000);
 return {models,partial:!!result.nextPageToken,note:'仅列出支持 generateContent 的图片与文字模型。对话模型的音频理解能力需按所选模型文档逐个核对，并在配置中明确开启；模型列表不代表账户权限。'+(result.nextPageToken?'仅显示平台返回的第一页，可手动填写其他模型。':'')};
}
export async function submitApimart({baseUrl,apiKey,studio,references=[],signal}){
 validateExtendedStudio(studio,references);const c=studio.config;
 let body={model:c.model,prompt:studio.prompt};
 if(studio.mode==='image'){
  body={...body,n:c.count,size:c.ratio,resolution:c.imageResolution};
  if(references.length)body.image_urls=references.map(ref=>{const r=imageData(ref);return `data:${r.mime};base64,${r.bytes.toString('base64')}`;});
 }else{
  body={...body,resolution:c.resolution,size:c.ratio,duration:c.duration,generate_audio:c.generateAudio};
  if(isApimartMultimodal(studio)){for(const [kind,field]of [['image','image_urls'],['video','video_urls'],['audio','audio_urls']]){const urls=references.filter(r=>r.type.startsWith(kind+'/')).map(r=>r.url);if(urls.length)body[field]=urls;}}else if(references.length)body.image_with_roles=references.map((r,i)=>({url:r.url,role:i===0?'first_frame':'last_frame'}));
 }
 const result=await safeApiCall({baseUrl,apiKey,path:studio.mode==='image'?'images/generations':'videos/generations',method:'POST',body,signal});
 if(result.code!==200||!Array.isArray(result.data)||result.data.length!==1)throw new ImageApiError('invalid_response','APIMart 未返回单个有效任务，请核对平台记录；不会自动重提',{uncertain:true});
 return {upstreamId:taskId(result.data[0].task_id)};
}
function resultUrls(items){
 if(!Array.isArray(items))return [];
 return items.flatMap(item=>Array.isArray(item?.url)?item.url:[item?.url]).filter(url=>typeof url==='string'&&url.length>0);
}
export async function queryApimart({baseUrl,apiKey,upstreamId,studio,signal}){
 const result=await safeApiCall({baseUrl,apiKey,path:'tasks/'+taskId(upstreamId),signal});
 if(result.code!==200||!result.data||result.data.id!==upstreamId)throw userError('APIMart 查询结果与原任务编号不匹配');
 const d=result.data;
 if(['failed','cancelled'].includes(d.status))return {status:d.status,progress:0,message:'APIMart 原任务未完成，请到平台查看原因'};
 if(d.status==='completed'){
  if(studio.mode==='image'){
   const urls=resultUrls(d.result?.images);if(urls.length!==studio.config.count)throw userError('APIMart 返回图片数量与请求不符，请核对原任务');
   return {status:'completed',progress:100,images:await parseImageData({data:urls.map(url=>({url}))},{baseUrl,signal,maxImages:studio.config.count})};
  }
  const urls=resultUrls(d.result?.videos);if(urls.length!==1)throw userError('APIMart 未返回单个视频结果，请核对原任务');
  return {status:'completed',progress:100,videoUrl:urls[0]};
 }
 if(!['pending','processing','submitted'].includes(d.status))throw userError('APIMart 返回未知任务状态，请核对原任务');
 return {status:'running',progress:Number.isFinite(d.progress)?Math.max(0,Math.min(99,d.progress)):10,message:'APIMart 正在处理原任务'};
}
