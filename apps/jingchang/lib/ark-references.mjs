import {isApimartMultimodal,apimartAssetUrl,APIMART_REFERENCE_TYPES} from '../public/apimart-reference-core.js';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {userError,loadAsset} from './workspace.mjs';
import {validateApiBaseUrl,MAX_JSON_BYTES} from './image-api.mjs';
import {validateInputImage} from './providers.mjs';
import {isArkMultimodal,arkAssetUrl,arkReferenceError,arkSendsOriginalMedia,ARK_REFERENCE_TYPES} from '../public/ark-reference-core.js';

const run=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const imageExt={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'};
export function normalizeStudioUrlReference(ref,studio){
  const type=ref.type==='audio/x-wav'?'audio/wav':ref.type||'image/png';
  if(isApimartMultimodal(studio)){if(!APIMART_REFERENCE_TYPES.includes(type))throw userError('APIMart参考类型无效');if(apimartAssetUrl(ref.url))return {url:ref.url,type};}
  else if(isArkMultimodal(studio)){
    if(!ARK_REFERENCE_TYPES.includes(type))throw userError('方舟参考类型无效');
    if(arkAssetUrl(ref.url))return {url:ref.url,type};
  }else if(type!=='image/png')throw userError('当前接口的外部参考仅接受图片链接；多类型链接需使用方舟多素材模式');
  const url=validateApiBaseUrl(ref.url);
  if(new URL(url).protocol!=='https:')throw userError('参考素材地址须为公网 HTTPS，不接受本机地址、查询参数或登录信息');
  return{url,type};
}
export function assertArkReferences(studio,refs){const error=arkReferenceError(studio,refs);if(error)throw userError(error);}
export function assertArkEncodedSize(inputs,prompt='',model=''){
  const bytes=inputs.reduce((n,r)=>n+(r.url?Buffer.byteLength(r.url):Number.isSafeInteger(r.size)&&r.size>=0?4*Math.ceil(r.size/3):Infinity),Buffer.byteLength(prompt)+Buffer.byteLength(model)+65536);
  if(bytes>MAX_JSON_BYTES)throw userError('方舟参考编码后超过本机48 MB发送上限，请压缩图片或减少素材');
  return bytes;
}

export async function inspectArkLocalReference(data,ref,signal){
  const meta=await loadAsset(data,ref.assetId),root=await fs.realpath(data),dir=path.join(root,'assets'),file=path.join(dir,ref.assetId);
  let bytes;
  try{if(await fs.realpath(dir)!==dir||await fs.realpath(file)!==file)throw Error();const st=await fs.lstat(file),mt=await fs.lstat(file+'.json');if(!st.isFile()||!mt.isFile()||await fs.realpath(file+'.json')!==file+'.json'||mt.size>1024**2||st.size!==meta.size||st.size<1||st.size>(meta.type.startsWith('image/')?10:15)*1024*1024)throw Error();bytes=await fs.readFile(file);}catch{throw userError('方舟参考文件缺失、被替换、为符号链接或超过本机发送上限');}
  if(ref.type!==meta.type||bytes.length!==meta.size)throw userError('方舟参考文件与素材记录不一致');
  const image=meta.type.startsWith('image/'),format=image?{'image/png':'png_pipe','image/jpeg':'jpeg_pipe','image/webp':'webp_pipe'}[meta.type]:{'audio/wav':'wav','audio/x-wav':'wav','audio/mpeg':'mp3'}[meta.type];
  if(!format)throw userError('方舟本机参考仅支持 PNG/JPEG/WebP 图片及 MP3/WAV 音频');
  if(image)validateInputImage({bytes,mime:meta.type,name:'reference.'+imageExt[meta.type]});
  const input=['-protocol_whitelist','file,pipe','-format_whitelist',format,'-f',format,'-threads','1','-max_alloc','67108864'];
  let info;
  try{const out=await run(process.env.FFPROBE_PATH||'ffprobe',['-v','error',...input,'-show_streams','-show_format','-of','json',file],{timeout:10000,maxBuffer:512*1024,signal});info=JSON.parse(out.stdout);}catch{throw userError('方舟参考无法读取，请检查素材内容和本机 FFprobe');}
  let details;
  if(image){const v=info.streams?.find(s=>s.codec_type==='video'),w=v?.width,h=v?.height;if(!Number.isInteger(w)||!Number.isInteger(h)||w<300||h<300||w>6000||h>6000||w/h<.4||w/h>2.5||w*h>16777216)throw userError('方舟多参考图片宽高须为300–6000像素、比例0.4–2.5；本机解码最多1600万像素');details={width:w,height:h};}
  else{const audio=info.streams?.filter(s=>s.codec_type==='audio')||[],duration=Number(info.format?.duration||audio[0]?.duration);if(audio.length!==1||info.streams?.some(s=>s.codec_type==='video'&&!s.disposition?.attached_pic)||!Number.isFinite(duration)||duration<2||duration>15)throw userError('方舟参考音频须为可解码的单音轨 MP3/WAV，时长2–15秒');details={duration};}
  try{await run(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-nostdin',...input,'-i',file,...(image?['-frames:v','1']:['-t','15']),'-f','null','pipe:1'],{timeout:15000,maxBuffer:128*1024,signal});}catch{throw userError('方舟参考素材解码失败，请重新导入完整文件');}
  const sourceSha256=sha(bytes);if(sha(await fs.readFile(file))!==sourceSha256)throw userError('参考文件在检查期间发生变化，请重新确认');
  return{reference:{bytes,mime:meta.type,name:meta.name,type:meta.type},input:{assetId:meta.id,type:meta.type,name:meta.name,size:bytes.length,sourceSha256,...details,verified:true}};
}
export async function prepareArkReferences({data,studio,refs,signal}){
  assertArkReferences(studio,refs);
  const prepared=[],inputs=[];
  for(const ref of refs){if(ref.url){const normalized=normalizeStudioUrlReference(ref,studio);prepared.push(normalized);inputs.push({...normalized,verified:false});}else{const result=await inspectArkLocalReference(data,ref,signal);prepared.push(result.reference);inputs.push(result.input);}}
  const audioDuration=inputs.filter(r=>r.type.startsWith('audio/')&&r.verified).reduce((n,r)=>n+r.duration,0);
  if(audioDuration>15)throw userError('方舟参考音频的总时长超过15秒，请缩短或减少参考音频');
  // The workbench's existing 48 MiB JSON transport is stricter than Ark's 64 MB.
  const encodedBytes=assertArkEncodedSize(inputs,studio.prompt,studio.config.model);
  const fingerprint=sha(JSON.stringify({prompt:studio.prompt,config:studio.config,references:studio.references,inputs}));
  const categories={image:0,video:0,audio:0};const summary=inputs.map((r,index)=>({...r,index:index+1,referenceIndex:++categories[r.type.split('/')[0]]}));
  return {prepared,plan:{fingerprint,inputs:summary,counts:categories,knownAudioDuration:audioDuration,encodedBytes,sendOriginalMedia:arkSendsOriginalMedia(studio,refs),externalMediaUnchecked:inputs.some(r=>!r.verified)}};
}
