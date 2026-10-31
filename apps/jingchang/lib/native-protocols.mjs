import {safeApiCall,parseImageData,downloadApiVideo} from './image-api.mjs';
import {validateInputImage} from './providers.mjs';
import {userError} from './workspace.mjs';
import {normalizeStudioUrlReference,assertArkReferences} from './ark-references.mjs';
import {isArkMultimodal,arkMediaCategory} from '../public/ark-reference-core.js';
import {normalizeNativeModelscopeConfig,normalizeNativeModelscopeSize,nativeModelscopeModel,studioModelscopeReferenceLimit} from '../public/native-modelscope-core.js';
const taskId=x=>{if(typeof x!=='string'||!/^[-\w]{1,128}$/.test(x))throw userError('上游未返回有效任务编号');return x;};
export function normalizeLoras(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>6)throw userError('LoRA 配置最多6项');
 const entries=Object.entries(value);let total=0;
 for(const [name,weight] of entries){if(!/^[\w.-]+\/[\w.-]+$/.test(name)||name.length>200||!Number.isFinite(weight)||weight<=0||weight>1)throw userError('LoRA 名称须为作者/模型，权重在0–1之间');total+=weight;}
 if(entries.length&&Math.abs(total-1)>1e-6)throw userError('LoRA 权重合计须为1');return Object.fromEntries(entries);
}
export async function submitModelScope({baseUrl,apiKey,studio,references=[],signal}){
 const c=studio.config;
 const native=c.nativeModelscope!==undefined;if(native)try{normalizeNativeModelscopeConfig(c.nativeModelscope);}catch(e){throw userError(e.message);}
 if(native){const definition=nativeModelscopeModel(c.nativeModelscope);if(definition.modelId&&c.model!==definition.modelId)throw userError('原生 ModelScope 固定模型编号与模型标记不一致');if(definition.requiresImages&&!references.length)throw userError('此原生 ModelScope 编辑模型至少需要一张参考图');}
 if(studio.mode!=='image'||references.length>studioModelscopeReferenceLimit(studio)||references.length!==studio.references.length||c.count!==1||c.transparent||c.quality!=='auto')throw userError('ModelScope 参考图或单份请求参数超出已确认范围');
 const loras=normalizeLoras(c.loras),body={model:c.model,prompt:studio.prompt,...(Object.keys(loras).length?{loras}:{})};
 if(native){try{body.size=normalizeNativeModelscopeSize(c.size);}catch(e){throw userError(e.message);}}
 if(references.length)body.image_url=references.map(ref=>{const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[ref.mime];if(!ext)throw userError('ModelScope 参考图须为 PNG、JPEG 或 WebP');const image=validateInputImage({...ref,name:'reference.'+ext});return `data:${image.mime};base64,${image.bytes.toString('base64')}`;});
 const result=await safeApiCall({baseUrl,apiKey,path:'images/generations',method:'POST',modelScopeMode:'submit',body,signal});
 return {upstreamId:taskId(result.task_id)};
}
export async function queryModelScope({baseUrl,apiKey,upstreamId,signal}){
 const result=await safeApiCall({baseUrl,apiKey,path:'tasks/'+taskId(upstreamId),modelScopeMode:'query',signal});
 if(result.task_status==='SUCCEED')return {status:'completed',progress:100,images:await parseImageData({data:(result.output_images||[]).map(url=>({url}))},{baseUrl,signal,maxImages:1})};
 if(['FAILED','CANCELED','CANCELLED'].includes(result.task_status))return {status:'failed',progress:0,message:'ModelScope 任务失败，请到平台查看原因'};
 if(!['PENDING','RUNNING','QUEUED','PROCESSING'].includes(result.task_status))throw userError('ModelScope 返回未知任务状态，请核对原任务');
 return {status:'running',progress:20,message:'ModelScope 正在处理原任务'};
}
export async function submitArk({baseUrl,apiKey,studio,references=[],signal}){
 const c=studio.config,multimodal=isArkMultimodal(studio);assertArkReferences(studio,references);
 const content=[{type:'text',text:studio.prompt}];
 for(const [i,ref] of references.entries()){
  const kind=arkMediaCategory(ref);let url=ref.url;
  if(url)url=normalizeStudioUrlReference({...ref,type:multimodal?ref.type||ref.mime:'image/png'},studio).url;
  else if(kind==='image'){const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[ref.mime];const image=validateInputImage({...ref,name:'reference.'+ext});url=`data:${image.mime};base64,${image.bytes.toString('base64')}`;}
  else if(kind==='audio'&&multimodal){if(!Buffer.isBuffer(ref.bytes)||!ref.bytes.length||ref.bytes.length>15*1024*1024||!['audio/mpeg','audio/wav','audio/x-wav'].includes(ref.mime))throw userError('方舟参考音频格式或大小无效');url=`data:${ref.mime==='audio/mpeg'?'audio/mp3':'audio/wav'};base64,${ref.bytes.toString('base64')}`;}
  else throw userError('方舟参考视频须使用公网地址或平台素材编号');
  const key=kind+'_url';content.push({type:key,[key]:{url},role:multimodal?'reference_'+kind:i===0?'first_frame':'last_frame'});
 }
 const result=await safeApiCall({baseUrl,apiKey,path:'contents/generations/tasks',method:'POST',signal,body:{model:c.model,content,duration:c.duration,ratio:c.ratio,resolution:c.resolution,generate_audio:c.generateAudio}});
 return {upstreamId:taskId(result.id)};
}
export async function queryArk({baseUrl,apiKey,upstreamId,signal}){
 const result=await safeApiCall({baseUrl,apiKey,path:'contents/generations/tasks/'+taskId(upstreamId),signal});
 if(result.status==='succeeded')return {status:'completed',progress:100,videoUrl:result.content?.video_url};
 if(['failed','expired','cancelled'].includes(result.status))return {status:'failed',message:'方舟任务未完成，请查看平台原任务',progress:0};
 if(!['queued','running'].includes(result.status))throw userError('方舟返回未知任务状态');
 return {status:'running',progress:20,message:'方舟正在处理原任务'};
}
export const downloadArk=({videoUrl,baseUrl,signal})=>downloadApiVideo(videoUrl,{baseUrl,signal});
