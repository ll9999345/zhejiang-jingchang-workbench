import {IMAGE_REFERENCE_LIMIT} from '../public/reference-limits.js';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {generateImage,assertImageRequestSize} from './image-api.mjs';
import {generateGeminiImages} from './extended-protocols.mjs';
import {validateInputImage} from './providers.mjs';
import {loadAsset,storeAsset,userError,safeId} from './workspace.mjs';

export function geminiReferenceLimit(model){return model==='gemini-3.1-flash-image'||model==='gemini-3.1-flash-lite-image'||model==='gemini-3-pro-image'?14:model==='gemini-2.5-flash-image'?3:3;}
export async function prepareConversationImage({data,platform,model,text,assetIds,body,conversation,includeGeminiHistory=false}){
 if(!['openai-compatible','gemini'].includes(platform.protocol))throw userError('图片模式需要已配置支持的图片平台');
 const refLimit=platform.protocol==='gemini'?geminiReferenceLimit(model.id):IMAGE_REFERENCE_LIMIT;
 if(assetIds.length>refLimit)throw userError(`当前模型最多使用${refLimit}张参考图`);
 if(assetIds.length&&!model.referenceSupport)throw userError('当前图片模型未开启参考图支持');
 const size=body.size||'auto',quality=body.quality||'auto';
 if(!/^(auto|[1-9]\d{1,4}x[1-9]\d{1,4})$/.test(size))throw userError('尺寸格式须为 宽x高 或 auto');
 if(!['auto','low','medium','high'].includes(quality))throw userError('图片质量参数无效');
 if(platform.protocol==='gemini'&&quality!=='auto')throw userError('Gemini 原生图片接口当前只使用自动质量');
 const ratio=body.ratio||'auto',rawResolution=body.resolution||'1024',resolution=({'1024':'1K','2048':'2K','4096':'4K','1K':'1K','2K':'2K','4K':'4K'})[rawResolution];
 if(!['auto','custom','1:1','16:9','9:16','4:3','3:4','5:4','4:5','3:2','2:3','21:9','1:4','4:1','1:8','8:1'].includes(ratio))throw userError('Gemini 图片比例无效');
 if(!resolution)throw userError('Gemini 图片分辨率无效');
 if(platform.protocol==='gemini'&&['gemini-2.5-flash-image','gemini-3.1-flash-lite-image'].includes(model.id)&&resolution!=='1K')throw userError('当前 Gemini 图片模型只支持默认或 1K 分辨率');
 const references=[];let referenceBytes=0;
 async function readReference(id,expectedMime){const a=await loadAsset(data,id),file=path.join(data,'assets',id),st=await fs.lstat(file),ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[a.type];
  if(!ext||!st.isFile()||st.size>10*1024*1024||st.size!==a.size)throw userError('参考图须为不超过10MB的本地 PNG/JPEG/WebP');
  if(expectedMime&&expectedMime!==a.type)throw userError('Gemini 连续会话中的图片类型与本地素材不一致');
  const bytes=await fs.readFile(file);validateInputImage({bytes,mime:a.type,name:'reference.'+ext});referenceBytes+=st.size;return{assetId:id,bytes,mime:a.type,name:'reference.'+ext};
 }
 for(const id of assetIds)references.push(await readReference(id));
 assertImageRequestSize(referenceBytes,text,model.id);
 const historyContents=[],geminiHistory=[];
 if(includeGeminiHistory){
  if(platform.protocol!=='gemini')throw userError('连续会话上下文仅用于 Gemini 原生图片模型');
  const messages=(conversation?.messages||[]).filter(m=>m.state!=='incomplete'),turns=[];
  for(let i=0;i<messages.length;i++){
   const user=messages[i];if(user.role!=='user'||user.mode!=='image'||user.nativeImage?.protocol!=='gemini'||user.nativeImage.baseUrl!==platform.baseUrl||user.nativeImage.modelId!==model.id||!Array.isArray(user.assetIds)||typeof user.text!=='string'||user.text.length>20000)continue;
   const assistant=messages[i+1];if(!assistant||assistant.state==='incomplete'||assistant.mode!=='image'||assistant.nativeImage?.protocol!=='gemini'||assistant.nativeImage.baseUrl!==platform.baseUrl||assistant.nativeImage.modelId!==model.id||!Array.isArray(assistant.geminiParts)||!assistant.geminiParts.length||assistant.geminiParts.length>64||assistant.geminiParts.some(p=>p.type==='text'?(typeof p.text!=='string'||p.text.length>32000||p.thoughtSignature!==undefined&&(typeof p.thoughtSignature!=='string'||p.thoughtSignature.length>32768)):p.type==='image'?(!safeId(p.assetId)||!['image/png','image/jpeg','image/webp'].includes(p.mime)||p.thoughtSignature!==undefined&&(typeof p.thoughtSignature!=='string'||p.thoughtSignature.length>32768)):true))continue;
   turns.push({user,assistant});
  }
  let selectedTurns=[],imageCount=assetIds.length;
  for(const turn of turns.slice(-8).reverse()){
   const priorImages=turn.user.assetIds.length+turn.assistant.geminiParts.filter(p=>p.type==='image').length;
   if(imageCount+priorImages>refLimit)break;
   imageCount+=priorImages;selectedTurns.unshift(turn);
  }
  if(!selectedTurns.length)throw userError('没有可用于当前 Gemini 图片模型的完整历史；请选择上一张结果作为参考图，或关闭连续会话');
  for(const {user,assistant} of selectedTurns){
   const userParts=[{text:user.text}],userSnapshot=[{type:'text',text:user.text}];
   for(const id of user.assetIds){const ref=await readReference(id);userParts.push({inlineData:{mimeType:ref.mime,data:ref.bytes.toString('base64')}});userSnapshot.push({type:'image',assetId:id,mime:ref.mime});}
   historyContents.push({role:'user',parts:userParts});geminiHistory.push({role:'user',parts:userSnapshot});
   const modelParts=[],modelSnapshot=[];
   for(const part of assistant.geminiParts){
    if(part.type==='text'){modelParts.push({text:part.text,...(part.thoughtSignature?{thoughtSignature:part.thoughtSignature}:{})});modelSnapshot.push({...part});}
    else if(part.type==='image'){
     const ref=await readReference(part.assetId,part.mime);modelParts.push({inlineData:{mimeType:ref.mime,data:ref.bytes.toString('base64')},...(part.thoughtSignature?{thoughtSignature:part.thoughtSignature}:{})});modelSnapshot.push({...part});
    }else throw userError('Gemini 连续会话包含不支持的模型内容');
   }
   historyContents.push({role:'model',parts:modelParts});geminiHistory.push({role:'model',parts:modelSnapshot});
  }
  if(geminiHistory.some(m=>m.parts.some(p=>p.type==='image'))&&!model.referenceSupport)throw userError('当前 Gemini 图片模型未启用参考图，不能发送连续会话图片');
 }
 assertImageRequestSize(referenceBytes,text,model.id);
 if(platform.protocol==='gemini'&&Math.ceil(referenceBytes/3)*4+Buffer.byteLength(text)+Buffer.byteLength(JSON.stringify(geminiHistory))+65536>18*1024*1024)throw userError('Gemini 连续会话图片内容超过18MB，请减少历史轮次或图片');
 return{input:{text,size,quality,model:model.id,platformId:platform.id,assetIds,ratio:ratio==='custom'?'auto':ratio,resolution,...(geminiHistory.length?{geminiHistory}:{})},references,historyContents};
}
export async function runConversationImage({data,job,platform,key,references,historyContents=[],controller,persist,saveAnswer,imageGenerator=generateImage}){
 const redact=value=>typeof value==='string'&&key?value.replaceAll(key,'[已隐藏]'):Array.isArray(value)?value.map(redact):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([name])=>!key||!name.includes(key)).map(([name,item])=>[name,redact(item)])):value;
 try{
  controller.signal.throwIfAborted();job.status='running';job.requestCount=1;job.message='正在生成图片，请勿重复提交';await persist(job);
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(180000)]);
  const result=platform.protocol==='gemini'?await generateGeminiImages({baseUrl:platform.baseUrl,apiKey:key,studio:{mode:'image',prompt:job.input.text,references,config:{protocol:'gemini',imageAsync:false,count:1,transparent:false,quality:'auto',model:job.input.model,ratio:job.input.ratio,imageResolution:job.input.resolution,useImageResolution:true}},references,historyContents,signal}):await imageGenerator({baseUrl:platform.baseUrl,apiKey:key,model:job.input.model,prompt:job.input.text,size:job.input.size,quality:job.input.quality,references,signal});
  controller.signal.throwIfAborted();
  for(const output of result.images){const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[output.mime];const a=await storeAsset(data,output.bytes,{name:`对话图片-${job.id.slice(0,8)}.${ext}`,type:output.mime,source:'conversation-image',category:'生成素材'});job.assets.push(a);await persist(job);}
  if(result.geminiParts?.length){const parts=result.geminiParts.map(p=>p.type==='image'?{type:'image',assetId:job.assets[p.index]?.id,mime:p.mime,...(p.thoughtSignature?{thoughtSignature:p.thoughtSignature}:{})}:{...p});if(parts.every(p=>p.type!=='image'||p.assetId))job.geminiParts=redact(parts);}
  if(!job.assets.length)throw userError('模型没有返回图片');job.usage=redact(result.usage||null);job.status='completed';job.progress=100;job.uncertain=false;job.message='图片已保存，可继续改图或放入画布';
 }catch(e){job.status=controller.signal.aborted?'cancelled':'failed';job.uncertain=job.requestCount>0&&e.uncertain!==false;job.message=controller.signal.aborted?'已停止本机等待；上游可能仍在处理，不会自动重发':redact(e.publicMessage||'图片请求未确认，请核对平台任务和账单；不会自动重发');}
 finally{key='';references.length=0;try{await saveAnswer(job);}catch{job.status='failed';job.message='结果保留在任务和素材库，对话保存失败；不会自动重发';}await persist(job);}
}
