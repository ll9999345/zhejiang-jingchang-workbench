import {createCanvas,loadImage} from '@napi-rs/canvas';
import {isMidjourney,validMjTask,normalizeMidjourneyConfig,validateMidjourneyRequest} from '../public/midjourney-core.js';
import {safeApiCall,parseImageData,ImageApiError,MAX_JSON_BYTES} from './image-api.mjs';
import {validateInputImage} from './providers.mjs';

const invalid=message=>{throw new ImageApiError('invalid_response',message,{uncertain:true});};
function responseData(raw) {
  if(!raw||typeof raw!=='object'||raw.error||raw.code!==undefined&&raw.code!==200)invalid('Midjourney 未返回有效任务响应，请先核对原任务与账单');
  const data=raw.data??raw;
  if(Array.isArray(data)){if(data.length!==1||!data[0]||typeof data[0]!=='object')invalid('Midjourney 返回的任务数量不明，不会自动重发');return data[0];}
  if(!data||typeof data!=='object')invalid('Midjourney 任务响应无效');return data;
}
function idFrom(data,apiKey) {
  const ids=[data.task_id,data.taskId,data.id].filter(id=>id!==undefined&&id!==null),id=ids[0];
  if(!validMjTask(id)||ids.some(value=>value!==id)||(apiKey&&id.includes(apiKey)))invalid('Midjourney 未返回一致有效的任务编号，不会自动重发');return id;
}
const paths={imagine:'',blend:'blend',edit:'edits',upscale:'upscale',variation:'variation',low_variation:'low-variation',high_variation:'high-variation',reroll:'reroll',zoom:'zoom',pan:'pan',inpaint:'inpaint',modal:'modal',remix_subtle:'remix-subtle',remix_strong:'remix-strong'};
const imageRef=r=>{const checked=validateInputImage({...r,name:'reference.'+({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[r.mime]||'png')});return `data:${checked.mime};base64,${checked.bytes.toString('base64')}`;};

export async function midjourneyMask(reference,convention) {
  validateInputImage({...reference,name:'mask.'+({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[reference.mime]||'png')});
  if(convention==='alpha')return imageRef(reference);
  const image=await loadImage(reference.bytes),width=image.width,height=image.height;
  if(width<1||height<1||width>8192||height>8192||width*height>16777216)throw new ImageApiError('invalid_reference','遮罩尺寸超出允许范围');
  const canvas=createCanvas(width,height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,width,height);
  for(let i=0;i<pixels.data.length;i+=4){const lum=Math.round(.299*pixels.data[i]+.587*pixels.data[i+1]+.114*pixels.data[i+2]);pixels.data[i]=255;pixels.data[i+1]=255;pixels.data[i+2]=255;pixels.data[i+3]=255-lum;}
  ctx.putImageData(pixels,0,0);const bytes=await canvas.encode('png');if(bytes.length>10*1024*1024)throw new ImageApiError('request_too_large','转换后的遮罩超过10MB');return `data:image/png;base64,${bytes.toString('base64')}`;
}

export async function submitMidjourney({baseUrl,apiKey,studio,references=[],signal}) {
  validateMidjourneyRequest(studio,references);const c={...studio.config,...normalizeMidjourneyConfig(studio.config)},mode=c.mjMode;
  const body={speed:c.mjSpeed,metadata:{source:'jingchang-agent'}};
  if(['imagine','blend','edit'].includes(mode)){
    body.size=c.mjSize;if(mode!=='blend')body.prompt=studio.prompt.trim();if(mode==='imagine')body.version=c.mjVersion;
    if(references.length)body.image_urls=references.map(imageRef);
  }else{
    body.task_id=c.mjTaskId;
    if(c.mjCustomId)body.custom_id=c.mjCustomId;
    if(['upscale','variation','low_variation','high_variation','remix_subtle','remix_strong','zoom','pan'].includes(mode)&&!c.mjCustomId)body.index=c.mjIndex;
    if(mode==='zoom')body.zoom_ratio=c.mjZoom;
    if(mode==='pan'&&!c.mjCustomId)body.direction=c.mjDirection;
    if(['remix_subtle','remix_strong','modal'].includes(mode)&&studio.prompt.trim())body.prompt=studio.prompt.trim();
    if(mode==='modal')body.mask_url=await midjourneyMask(references[0],c.mjMaskConvention);
  }
  if(Buffer.byteLength(JSON.stringify(body))>MAX_JSON_BYTES)throw new ImageApiError('request_too_large','Midjourney 图片请求过大，请减少参考图');
  signal?.throwIfAborted();const data=responseData(await safeApiCall({baseUrl,apiKey,path:'midjourney/generations'+(paths[mode]?'/'+paths[mode]:''),method:'POST',body,signal}));
  return {upstreamId:idFrom(data,apiKey),requiresInput:String(data.status??data.task_status??'').toLowerCase()==='modal'};
}

export async function queryMidjourney({baseUrl,apiKey,studio,upstreamId,signal}) {
  if(!isMidjourney(studio)||!validMjTask(upstreamId))throw new ImageApiError('invalid_parameter','Midjourney 原任务参数无效');
  const data=responseData(await safeApiCall({baseUrl,apiKey,path:'midjourney/'+encodeURIComponent(upstreamId),signal}));
  if(idFrom(data,apiKey)!==upstreamId)invalid('Midjourney 返回了其他任务的结果，已停止保存');
  const status=String(data.status??data.task_status??'').toLowerCase();
  if(status==='modal')return {status:'awaiting_input',progress:0,message:'平台等待重绘遮罩和提示词。请按原编号单独确认补参请求；本机没有自动提交。'};
  if(['failed','failure','error','rejected','cancelled','canceled','cancel'].includes(status))return {status:status.startsWith('cancel')?'cancelled':'failed',progress:0,message:'Midjourney 平台任务未完成，请在平台核对失败原因；不会自动重发'};
  if(['submitted','pending','queued','running','processing','in_progress','not_start','in_queue'].includes(status)){
    const value=typeof data.progress==='string'&&/^\d{1,3}%$/.test(data.progress)?Number(data.progress.slice(0,-1)):typeof data.progress==='number'?data.progress:0;
    return {status:'running',progress:Math.min(99,Math.max(0,Number.isFinite(value)?value:0)),message:'Midjourney 正在处理原任务'};
  }
  if(!['success','succeeded','completed','done','finished'].includes(status))invalid('Midjourney 任务状态无法识别，请核对原任务；不会自动重发');
  let values=data.image_urls??data.imageUrls??data.result?.images;
  if(typeof values==='string')values=[values];
  if(values===undefined||Array.isArray(values)&&!values.length)values=[data.image_url??data.imageUrl??data.grid_image_url??data.gridImageUrl].filter(Boolean);
  if(!Array.isArray(values)||!values.length||values.length>4)invalid('Midjourney 成功任务没有有效的1–4张图片，不会自动重发');
  const urls=values.map(v=>typeof v==='string'?v:v?.url);
  if(urls.some(url=>typeof url!=='string'||(apiKey&&url.includes(apiKey)))||new Set(urls).size!==urls.length)invalid('Midjourney 图片地址无效或重复，已停止保存');
  const images=await parseImageData({data:urls.map(url=>({url}))},{baseUrl,signal,maxImages:4});
  const buttons=Array.isArray(data.buttons)?data.buttons.slice(0,32).flatMap(b=>{
    const customId=b?.customId??b?.custom_id,label=b?.label;
    if(typeof customId!=='string'||!customId||customId.length>600||/[\x00-\x1f\x7f]/.test(customId)||typeof label!=='string'||label.length>80||(apiKey&&(customId.includes(apiKey)||label.includes(apiKey))))return [];
    return [{customId,label}];
  }):[];
  return {status:'completed',progress:100,images,buttons};
}
