import {VIDEO_SAMPLING_METHOD,LEGACY_VIDEO_SAMPLING_METHOD,videoSamplingLabel} from '../public/video-sampling.js';
import {isDocument} from '../public/document-types.js';
import {prepareDocument,readDocumentSample,documentSamples as normalizeDocuments,documentParts} from './chat-documents.mjs';
import {CHAT_REFERENCE_LIMIT} from '../public/reference-limits.js';
import {CHAT_AUDIO_MIME} from '../public/chat-audio-types.js';
import path from 'node:path';
import {promises as fs,createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {atomicJson,safeId,userError} from './workspace.mjs';
import {validateInputImage} from './providers.mjs';
import {sampleVideoForChat} from './media-tools.mjs';
import {prepareNativeVideo,readNativeVideo,nativeVideoParts,nativeVideos as normalizeNativeVideos,validateBundleNativeVideos} from './chat-native-video.mjs';

const images=Object.assign(Object.create(null),{'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}),videos=new Set(['video/mp4','video/webm','video/quicktime']);
const audioMime=CHAT_AUDIO_MIME;
const locks=new Map(),hashPattern=/^[a-f0-9]{64}$/;
export const CHAT_MEDIA_LIMIT=24*1024*1024;
export function chatAssetIds(ids){if(!Array.isArray(ids)||ids.length>CHAT_REFERENCE_LIMIT||new Set(ids).size!==ids.length||ids.some(id=>!safeId(id)))throw userError('最多选择20份不同的图片、视频、音频或文档，其中视频最多3份');return ids;}
async function digest(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
async function asset(data,id){
 if(!safeId(id))throw userError('参考素材编号无效');
 const root=await fs.realpath(data),dir=path.join(root,'assets'),file=path.join(dir,id),metaFile=file+'.json';
 try{
  if(await fs.realpath(dir)!==dir)throw userError('参考素材目录不能是符号链接');
  const [ms,st]=await Promise.all([fs.lstat(metaFile),fs.lstat(file)]);
  if(!ms.isFile()||ms.size>1024**2||!st.isFile()||st.size<1||st.size>150*1024*1024)throw userError('参考素材不是有效的本地文件');
  const meta=JSON.parse(await fs.readFile(metaFile,'utf8'));
  if(meta.id!==id||meta.size!==st.size)throw userError('参考素材记录与文件不一致');
  if(!images[meta.type]&&!videos.has(meta.type)&&!audioMime[meta.type]&&!isDocument(meta))throw userError('对话参考支持图片、视频、音频、文字、DOCX 和 XLSX 文档');
  if(images[meta.type]&&st.size>10*1024*1024)throw userError('参考图不能超过10MB');
  if(audioMime[meta.type]&&st.size>10*1024*1024)throw userError('对话音频不能超过10MB');
  return {root,file,meta};
 }catch(e){if(e.status)throw e;throw userError('找不到完整的本地参考素材',404);}
}
async function audioPart(a){
 const bytes=await fs.readFile(a.file),mime=audioMime[a.meta.type];
 const valid=mime==='audio/wav'&&bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE'||mime==='audio/mp3'&&(bytes.toString('ascii',0,3)==='ID3'||bytes.length>=2&&bytes[0]===255&&(bytes[1]&224)===224)||mime==='audio/aac'&&bytes.length>=2&&bytes[0]===255&&(bytes[1]&246)===240||mime==='audio/aiff'&&bytes.length>=12&&bytes.toString('ascii',0,4)==='FORM'&&['AIFF','AIFC'].includes(bytes.toString('ascii',8,12))||mime==='audio/flac'&&bytes.toString('ascii',0,4)==='fLaC'||mime==='audio/ogg'&&bytes.toString('ascii',0,4)==='OggS'||mime==='audio/webm'&&bytes.length>=4&&bytes[0]===0x1a&&bytes[1]===0x45&&bytes[2]===0xdf&&bytes[3]===0xa3||mime==='audio/m4a'&&bytes.length>=12&&bytes.toString('ascii',4,8)==='ftyp';
 if(!valid)throw userError('音频文件内容与 WAV/MP3/AAC/AIFF/FLAC/OGG/WebM/M4A 格式不符');
 return{type:'gemini_audio',mimeType:mime,data:bytes.toString('base64')};
}
async function imagePart(data,id,hash){const a=await asset(data,id);if(!images[a.meta.type])throw userError('视频抽样结果须为图片');const bytes=await fs.readFile(a.file);if(hash&&createHash('sha256').update(bytes).digest('hex')!==hash)throw userError('视频抽样图片已变化，请恢复原文件');validateInputImage({bytes,mime:a.meta.type,name:'reference.'+images[a.meta.type]});return {type:'image_url',image_url:{url:`data:${a.meta.type};base64,${bytes.toString('base64')}`,detail:'auto'}};}
export function normalizeVideoSample(s){
 if(!s||!safeId(s.id)||!safeId(s.assetId)||![VIDEO_SAMPLING_METHOD,LEGACY_VIDEO_SAMPLING_METHOD].includes(s.method)||!hashPattern.test(s.sourceSha256)||typeof s.duration!=='number'||!Number.isFinite(s.duration)||s.duration<=0||s.duration>21600||!Array.isArray(s.frames)||s.frames.length<1||s.frames.length>6||(s.method===LEGACY_VIDEO_SAMPLING_METHOD&&s.frames.length!==6)||(s.fallback!==undefined&&!(s.method===VIDEO_SAMPLING_METHOD&&s.fallback==='first-frame'&&s.frames.length===1&&s.frames[0]?.time===0)))throw userError('视频抽样记录无效');
 const seen=new Set();let previous=-1;
 const frames=s.frames.map(f=>{if(!f||!safeId(f.assetId)||seen.has(f.assetId)||!hashPattern.test(f.sha256)||typeof f.time!=='number'||!Number.isFinite(f.time)||f.time<0||f.time>=s.duration||f.time<previous||(s.method===VIDEO_SAMPLING_METHOD&&(!Number.isInteger(f.time)||(previous>=0&&f.time!==previous+1))))throw userError('视频抽样帧记录无效');seen.add(f.assetId);previous=f.time;return{assetId:f.assetId,time:f.time,sha256:f.sha256};});
 return{id:s.id,assetId:s.assetId,method:s.method,sourceSha256:s.sourceSha256,duration:s.duration,frames,...(s.fallback?{fallback:s.fallback}:{})};
}
async function sampleParts(data,s,source){
 s=normalizeVideoSample(s);const a=source||await asset(data,s.assetId);
 if(a.meta.id!==s.assetId||!videos.has(a.meta.type)||await digest(a.file)!==s.sourceSha256)throw userError('视频原文件已变化，请恢复原文件或重新导入');
 const parts=[{type:'text',text:`以下为参考视频的${s.frames.length}张抽样画面（${videoSamplingLabel(s)}）。视频时长 ${s.duration.toFixed(3)} 秒；时间为近似抽样位置。未提供音频，不要推断对话、声音或未抽到的事件。`}];
 for(const [i,f] of s.frames.entries()){parts.push({type:'text',text:`参考视频抽样 ${i+1}/${s.frames.length}，约 ${f.time.toFixed(3)} 秒`},await imagePart(data,f.assetId,f.sha256));}
 return parts;
}
async function cacheDirectory(data){const root=await fs.realpath(data),dir=path.join(root,'chat-video-samples');await fs.mkdir(dir,{recursive:true});if(await fs.realpath(dir)!==dir)throw userError('视频抽样记录目录不能是符号链接');return dir;}
async function readSample(data,id){if(!safeId(id))throw userError('视频预览编号无效');const dir=await cacheDirectory(data),file=path.join(dir,id+'.json'),st=await fs.lstat(file);if(!st.isFile()||st.size>65536)throw userError('视频预览记录无效');const s=normalizeVideoSample(JSON.parse(await fs.readFile(file,'utf8')));if(s.id!==id)throw userError('视频预览编号不一致');return s;}
async function prepareVideo(data,a){
 const sourceSha256=await digest(a.file),id=createHash('sha256').update(VIDEO_SAMPLING_METHOD+':'+a.meta.id+':'+sourceSha256).digest('hex'),key=a.root+':'+id;
 if(locks.has(key))return locks.get(key);
 const task=(async()=>{
  try{const existing=await readSample(data,id);await sampleParts(data,existing,a);return existing;}catch(e){if(e.code!=='ENOENT')throw e;}
  const sampled=await sampleVideoForChat({data,assetId:a.meta.id});
  if(await digest(a.file)!==sourceSha256)throw userError('视频在抽样时发生变化，请重新导入');
  const frames=[];for(const f of sampled.frames){const frame=await asset(data,f.assetId);frames.push({...f,sha256:await digest(frame.file)});}
  const sample=normalizeVideoSample({id,assetId:a.meta.id,sourceSha256,method:VIDEO_SAMPLING_METHOD,duration:sampled.duration,frames,...(sampled.fallback?{fallback:sampled.fallback}:{})});
  await atomicJson(path.join(await cacheDirectory(data),id+'.json'),sample);return sample;
 })();locks.set(key,task);try{return await task;}finally{locks.delete(key);}
}
// Local preview only: no model request or remote media fetch occurs here.
export async function prepareChatMedia({data,assetIds,videoInputMode='frames'}){
 if(!['frames','native'].includes(videoInputMode))throw userError('视频输入方式无效');
 chatAssetIds(assetIds);const sources=[];for(const id of assetIds)sources.push(await asset(data,id));if(sources.filter(a=>videos.has(a.meta.type)).length>3)throw userError('每次最多3份视频');
 if(sources.filter(a=>audioMime[a.meta.type]).length>1)throw userError('每条消息最多附加1份音频');
 const videoSamples=[],nativeVideos=[],documentSamples=[];let remaining=20-sources.filter(a=>images[a.meta.type]).length;for(const a of sources)if(videos.has(a.meta.type)){if(videoInputMode==='native')nativeVideos.push(await prepareNativeVideo(data,a));else videoSamples.push(await prepareVideo(data,a));}else if(isDocument(a.meta)){const s=await prepareDocument(data,a.meta.id,remaining);documentSamples.push(s);remaining-=s.images.length;}else if(audioMime[a.meta.type])await audioPart(a);else await imagePart(data,a.meta.id);
 const result=await chatReferenceParts({data,assetIds,videoSamples,nativeVideos,documentSamples,protocol:'gemini'});
 if(nativeVideos.length&&result.encodedBytes>18*1024*1024)throw userError('原视频和其他参考素材编码后超过18MB，请减少素材或改用抽样画面');
 return {assets:sources.map(a=>a.meta),videoSamples,nativeVideos,documentSamples,encodedBytes:result.encodedBytes};
}
// New conversation messages must name a saved, locally reviewed preview; callers
// cannot inject arbitrary frame IDs into that message.
export async function loadChatReferences({data,assetIds,videoSampleIds=[],nativeVideoIds=[],documentSampleIds=[],protocol='openai-compatible'}){
 chatAssetIds(assetIds);if(!Array.isArray(videoSampleIds)||videoSampleIds.length>3||new Set(videoSampleIds).size!==videoSampleIds.length)throw userError('视频预览编号无效');
 const samples=[];for(const id of videoSampleIds){try{samples.push(await readSample(data,id));}catch(e){if(e.code==='ENOENT')throw userError('找不到视频预览，请重新准备抽样');throw e;}}
 if(!Array.isArray(nativeVideoIds)||nativeVideoIds.length>3||new Set(nativeVideoIds).size!==nativeVideoIds.length)throw userError('原视频预览编号无效');
 if(nativeVideoIds.length&&protocol!=='gemini')throw userError('原视频理解要求 Gemini 原生对话模型；请改用抽样画面或切换模型');
 const originals=[];for(const id of nativeVideoIds)originals.push(await readNativeVideo(data,id));
 if(!Array.isArray(documentSampleIds)||documentSampleIds.length>20||new Set(documentSampleIds).size!==documentSampleIds.length)throw userError('文档预览编号无效');
 const documents=[];for(const id of documentSampleIds)documents.push(await readDocumentSample(data,id));
 await chatReferenceParts({data,assetIds,videoSamples:samples,nativeVideos:originals,documentSamples:documents,protocol});return {videoSamples:samples,nativeVideos:originals,documentSamples:documents};
}
export async function loadChatVideoSamples(body){return (await loadChatReferences(body)).videoSamples;}
export async function chatReferenceParts({data,assetIds,videoSamples=[],nativeVideos=[],documentSamples=[],multimodal=true,protocol='openai-compatible'}){
 chatAssetIds(assetIds);
 if(!Array.isArray(videoSamples)||videoSamples.length>3)throw userError('视频抽样记录无效');const samples=videoSamples.map(normalizeVideoSample),originals=normalizeNativeVideos(nativeVideos),documents=normalizeDocuments(documentSamples),seen=new Set();
 if(new Set([...samples,...originals].map(s=>s.assetId)).size!==samples.length+originals.length||samples.length+originals.length>3||[...samples,...originals,...documents].some(s=>!assetIds.includes(s.assetId)))throw userError('预览与消息引用不匹配');
 if(originals.length&&protocol!=='gemini')throw userError('原视频理解要求 Gemini 原生对话模型；历史中的原视频不会自动改成抽样画面，请切换模型或新建对话');
 const sources=[];for(const id of assetIds)sources.push(await asset(data,id));let remaining=20-sources.filter(a=>images[a.meta.type]).length;
 if(sources.filter(a=>audioMime[a.meta.type]).length>1)throw userError('每条消息最多附加1份音频');
 const parts=[];let encodedBytes=0;
 for(const a of sources){const id=a.meta.id;let current;
  if(videos.has(a.meta.type)){const s=samples.find(s=>s.assetId===id),v=originals.find(s=>s.assetId===id);if(!s&&!v)throw userError('请先准备并查看视频抽样或原视频预览，再发送');if(documents.some(s=>s.assetId===id))throw userError('视频不能绑定文档预览');seen.add(id);if(seen.size>3)throw userError('每次最多3份视频');current=v?await nativeVideoParts(data,v,a):await sampleParts(data,s,a);}
  else if(isDocument(a.meta)){const s=documents.find(s=>s.assetId===id);if(!s||s.imageLimit!==remaining)throw userError('请重新准备文档预览，再发送');if([...samples,...originals].some(s=>s.assetId===id))throw userError('文档不能绑定视频预览');current=await documentParts(data,s);remaining-=s.images.length;}
  else if(audioMime[a.meta.type]){if(protocol!=='gemini')throw userError('音频理解目前要求 Gemini 原生对话模型；可先移除音频或切换模型');if([...samples,...originals,...documents].some(s=>s.assetId===id))throw userError('音频不能绑定视频或文档预览');current=[await audioPart(a)];}
  else{if([...samples,...originals,...documents].some(s=>s.assetId===id))throw userError('图片不能绑定视频或文档预览');current=[await imagePart(data,id)];}
  for(const part of current){encodedBytes+=part.image_url?.url.length||part.data?.length||0;if(encodedBytes>CHAT_MEDIA_LIMIT)throw userError('参考素材合计过大，当前上下文媒体内容超出限制，请减少素材或新建对话');parts.push(part);}
 }
 if(!multimodal&&parts.some(p=>p.type==='image_url'))throw userError('本次上下文包含图片或视频抽样，请在 API 设置中为对话模型启用图片输入能力');
 return {parts,encodedBytes};
}
export function validateBundleVideoSamples(conversations,assets,version){validateBundleNativeVideos(conversations,assets,version);const byId=new Map(assets.map(a=>[a.id,a]));for(const c of conversations)for(const m of c.messages){const samples=m.videoSamples||[],originals=m.nativeVideos||[],all=[...samples,...originals];if(samples.some(s=>s.method===VIDEO_SAMPLING_METHOD)&&version<11)throw userError('逐秒视频抽样需要第11版备份格式');if(samples.length&&version<7)throw userError('视频对话需要第7版备份格式');if(all.length>3||new Set(all.map(s=>s.assetId)).size!==all.length)throw userError('备份视频预览重复或过多');for(const s of samples){const a=byId.get(s.assetId);if(!m.assetIds.includes(s.assetId)||!a||!videos.has(a.type)||a.sha256!==s.sourceSha256)throw userError('备份视频与抽样记录不一致');for(const f of s.frames){const image=byId.get(f.assetId);if(!image||!images[image.type]||(s.method===VIDEO_SAMPLING_METHOD&&image.type!=='image/jpeg')||image.sha256!==f.sha256)throw userError('备份缺少完整的视频抽样图片');}}for(const id of m.assetIds)if(videos.has(byId.get(id)?.type)&&!all.some(s=>s.assetId===id))throw userError('备份对话缺少视频抽样或原视频预览记录');}}
