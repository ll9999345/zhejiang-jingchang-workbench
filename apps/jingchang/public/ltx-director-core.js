import {sourceIndexFields} from './source-index-core.js';
// Project-owned timeline data. Backend filenames are created only after media upload.
const id=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v);
const integer=(v,min,max,label)=>{if(!Number.isInteger(v)||v<min||v>max)throw Error(`${label}须为${min}–${max}的整数`);return v;};
const number=(v,min,max,label)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw Error(`${label}须为${min}–${max}`);return v;};
const text=(v,max,label)=>{if(typeof v!=='string'||v.length>max)throw Error(`${label}最多${max}字`);return v;};
export const ltxDefaults={frameRate:24,durationFrames:120,displayMode:'seconds',width:768,height:512,resizeMethod:'maintain aspect ratio',divisibleBy:32,compression:18,epsilon:.001,useCustomAudio:false,globalPrompt:'',includeUpstream:true};
export const ltxResizeMethods=['maintain aspect ratio','stretch to fit','pad','pad green','crop'];
export function snapLtxDelta(delta,sources,targets,framesPerPixel,tolerancePixels=8){
 if(!Number.isFinite(delta)||!Array.isArray(sources)||!Array.isArray(targets)||!Number.isFinite(framesPerPixel)||framesPerPixel<=0)return{delta,snapped:false,target:null};
 let best=null;
 for(const source of sources)for(const target of targets){if(!Number.isFinite(source)||!Number.isFinite(target))continue;const distance=Math.abs((source+delta)-target)*framesPerPixel;if(distance<=tolerancePixels&&(!best||distance<best.distance))best={distance,delta:target-source,target};}
 return best?{delta:best.delta,snapped:true,target:best.target}:{delta,snapped:false,target:null};
}
export function ltxReferences(t){return [...(t?.segments||[]),...(t?.audioSegments||[])].filter(s=>s.type!=='text');}
export function normalizeLtxTimeline(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('LTX 时间线数据无效');
 if(typeof input.nodeId!=='string'||!/^[\w:.-]{1,100}$/.test(input.nodeId))throw Error('请选择工作流中的 LTXDirector 节点');
 const p={...ltxDefaults,...input},out={nodeId:p.nodeId};
 out.frameRate=integer(p.frameRate,1,120,'帧率');out.durationFrames=integer(p.durationFrames,1,10000,'输出帧数');
 if(!['frames','seconds'].includes(p.displayMode))throw Error('时间单位无效');out.displayMode=p.displayMode;
 out.divisibleBy=integer(p.divisibleBy,1,256,'尺寸倍数');
 for(const k of ['width','height']){out[k]=integer(p[k],0,8192,k==='width'?'宽度':'高度');if(out[k]&&out[k]%out.divisibleBy)throw Error('非零宽高须为尺寸倍数的整数倍');}
 if(!ltxResizeMethods.includes(p.resizeMethod))throw Error('图片缩放方式无效');out.resizeMethod=p.resizeMethod;
 out.compression=integer(p.compression,0,100,'参考图压缩');out.epsilon=number(p.epsilon,.0001,.99,'分段边界柔化');
 for(const k of ['useCustomAudio','includeUpstream']){if(typeof p[k]!=='boolean')throw Error('LTX 开关参数无效');out[k]=p[k];}
 out.globalPrompt=text(p.globalPrompt,16000,'全局提示词');const ids=new Set();
 for(const [track,max] of [['segments',64],['audioSegments',16]]){
  if(!Array.isArray(p[track])||p[track].length>max)throw Error(`LTX ${track==='segments'?'画面':'音频'}轨道最多${max}段`);
  out[track]=p[track].map(s=>{
   if(!s||!id(s.id)||ids.has(s.id))throw Error('时间片段编号无效或重复');ids.add(s.id);
   if(!(track==='segments'?['text','image']:['audio']).includes(s.type))throw Error('时间片段类型无效');
   const r={id:s.id,type:s.type,start:integer(s.start,0,9999,'起始帧'),length:integer(s.length,1,10000,'片段帧数')};
   if(r.start+r.length>10000)throw Error('时间线片段结束位置不能超过10000帧');
   if(s.type!=='audio'){r.prompt=text(s.prompt??'',4000,'分段提示词');if(r.prompt.includes('|'))throw Error('LTX 分段提示词不能包含分隔符 |，请改用逗号');}
   if(s.type!=='text'){
    if(!!s.assetId===!!s.sourceNodeId||!id(s.assetId||s.sourceNodeId))throw Error('每个媒体片段须选择一个项目素材或上游节点');
    if(s.assetId)r.assetId=s.assetId;else r.sourceNodeId=s.sourceNodeId;Object.assign(r,sourceIndexFields(s));
   }
   if(s.type==='text'&&s.sourceIndex!==undefined)throw Error('文字片段不能使用素材序号');
   if(s.type==='image')r.guideStrength=number(s.guideStrength??1,0,10,'参考强度');
   if(s.type==='audio')r.trimStart=integer(s.trimStart??0,0,1000000,'音频源起始帧');
   return r;
  }).sort((a,b)=>a.start-b.start);
  for(let i=1;i<out[track].length;i++)if(out[track][i].start<out[track][i-1].start+out[track][i-1].length)throw Error('同一轨道的片段不能重叠，请移动或裁短');
 }
 if(!out.segments.some(s=>s.start<out.durationFrames))throw Error('输出范围内至少需要一个画面或文字片段');
 if(!out.segments.some(s=>s.type==='image'&&s.start<out.durationFrames)&&(!out.width||!out.height))throw Error('纯文字生成需要同时设置非零宽高');
 if(out.useCustomAudio&&!out.audioSegments.some(s=>s.start<out.durationFrames))throw Error('请添加输出范围内的音频片段，或关闭使用时间线音频');
 return out;
}
export function ltxPromptSchedule(t){
 const lengths=[],prompts=[];let cursor=0,prefix=0;
 for(const s of t.segments){if(s.start>=t.durationFrames)break;
  const gap=Math.max(0,s.start-cursor);if(lengths.length)lengths[lengths.length-1]+=gap;else prefix+=gap;
  lengths.push(Math.min(s.start+s.length,t.durationFrames)-s.start+prefix);prompts.push(s.prompt);prefix=0;cursor=s.start+s.length;
 }
 if(lengths.length)lengths[lengths.length-1]+=Math.max(0,t.durationFrames-cursor);
 return {localPrompts:prompts.join(' | '),segmentLengths:lengths.join(',')};
}
export function ltxFromShots(shots,assets,frameRate=24){
 let cursor=0;const segments=[],audioSegments=[];
 for(const shot of shots){const length=Math.max(1,Math.round(shot.duration*frameRate)),asset=assets.find(a=>a.id===shot.assetId),s={id:crypto.randomUUID(),start:cursor,length,type:asset?.type.startsWith('image/')?'image':'text',prompt:shot.description||''};if(s.type==='image')Object.assign(s,{assetId:asset.id,guideStrength:1});segments.push(s);if(shot.audioId)audioSegments.push({id:crypto.randomUUID(),type:'audio',start:cursor,length,trimStart:0,assetId:shot.audioId});cursor+=length;}
 return {segments,audioSegments,durationFrames:cursor};
}
