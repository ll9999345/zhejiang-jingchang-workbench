// Fixed Infinite Canvas baseline; no shell text, login or account commands.
export const JIMENG_COMMANDS=['text2image','image2image','image_upscale','text2video','image2video','frames2video','multiframe2video','multimodal2video'];
export const JIMENG_IMAGE_MODELS=['3.0','3.1','4.0','4.1','4.5','4.6','4.7','5.0','5.0Pro'];
export const JIMENG_VIDEO_MODELS=['seedance1.0fast','seedance1.5pro','seedance2.0','seedance2.0fast','seedance2.0_vip','seedance2.0fast_vip','seedance2.0mini'];
const ratios=['21:9','16:9','3:2','4:3','1:1','3:4','2:3','9:16'];
const allowed=(value,choices,label)=>{if(!choices.includes(value))throw Error(label+'不支持该值');return value;};
const integer=(v,lo,hi,label)=>{if(!Number.isInteger(v)||v<lo||v>hi)throw Error(label+'超出允许范围');return v;};
export function normalizeJimengRequest(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['command','prompt','model','resolution','ratio','duration','references','generateNum'].includes(k)))throw Error('即梦参数包含不支持的字段');
 const command=allowed(input.command,JIMENG_COMMANDS,'命令'),video=command.includes('video'),references=input.references??[];
 if(!Array.isArray(references)||references.length>20)throw Error('参考素材数量无效');
 const seen=new Set();for(const r of references){if(!r||Object.keys(r).sort().join(',')!=='assetId,role'||typeof r.assetId!=='string'||!/^[-\w]{1,100}$/.test(r.assetId)||!['image','video','audio','first','last','frame'].includes(r.role)||seen.has(r.assetId))throw Error('参考素材编号、角色或重复项无效');seen.add(r.assetId);}
 let prompt=input.prompt??'';if(typeof prompt!=='string'||prompt.length>20000||prompt.includes('\0'))throw Error('提示词无效');prompt=prompt.trim();if(!prompt&&['text2image','text2video','image2video','frames2video','multimodal2video'].includes(command))throw Error('请填写提示词');
 if(command==='image_upscale'&&prompt)throw Error('图片放大命令不接受提示词');
 const model=command==='image_upscale'||command==='multiframe2video'?'':allowed(input.model??(video?'seedance2.0':'5.0'),video?JIMENG_VIDEO_MODELS:JIMENG_IMAGE_MODELS,'模型');
 if(!model&&input.model)throw Error('此命令不接受模型参数');
 const ratio=allowed(input.ratio??'16:9',video?ratios.filter(r=>!['3:2','2:3'].includes(r)):ratios,'比例');
 let resolution=input.resolution??(video?'720p':'2k');
 if(video)allowed(resolution,command==='multiframe2video'?['720p','1080p']:model==='seedance2.0_vip'?['720p','1080p','4k']:['720p'],'视频分辨率');
 else allowed(resolution,command==='image_upscale'?['2k','4k','8k']:model==='5.0Pro'?['1k','1.5k','2k','4k']:['3.0','3.1'].includes(model)&&command==='text2image'?['1k','2k']:['2k','4k'],'图片分辨率');
 const images=references.filter(r=>['image','first','last','frame'].includes(r.role)),videos=references.filter(r=>r.role==='video'),audios=references.filter(r=>r.role==='audio');
 if(['text2image','text2video'].includes(command)&&references.length)throw Error('文生模式不接受参考素材');
 if(command==='image2image'&&(images.length<1||images.length>10||videos.length||audios.length||references.some(r=>r.role!=='image')||['3.0','3.1'].includes(model)))throw Error('图生图需要1–10张图片，且不支持3.0/3.1模型');
 if(['image_upscale','image2video'].includes(command)&&(references.length!==1||references[0].role!=='image'))throw Error('此命令需要一张图片');
 if(command==='frames2video'&&(references.length!==2||references.filter(r=>r.role==='first').length!==1||references.filter(r=>r.role==='last').length!==1))throw Error('首尾帧需要分别选择一张首帧与尾帧');
 if(command==='multiframe2video'&&(references.length<2||references.some(r=>r.role!=='frame')))throw Error('多帧模式需要2–20张有序图片');
 if(command==='multimodal2video'&&(images.length>9||videos.length>3||audios.length>3||references.length>15||images.length+videos.length<1||images.some(r=>r.role!=='image')))throw Error('多模态需要图片或视频，最多9图/3视频/3音频，总15份');
 if(video&&command!=='multiframe2video'){
  if(model==='seedance1.0fast'&&command!=='image2video'||model==='seedance1.5pro'&&!['image2video','frames2video'].includes(command))throw Error('此视频命令不支持所选模型');
 }
 const duration=video?integer(input.duration??5,command==='multiframe2video'?1:model==='seedance1.0fast'||model==='seedance1.5pro'?5:4,command==='multiframe2video'?8:model==='seedance1.0fast'?10:model==='seedance1.5pro'?12:15,'视频时长'):0;
 if(command==='multiframe2video'&&duration*(references.length-1)<2)throw Error('多帧视频总时长至少2秒');
 if(!video&&input.duration!==undefined&&input.duration!==0)throw Error('图片命令不接受时长');
 const generateNum=integer(input.generateNum??1,1,10,'图片数量');if(command!=='text2image'&&command!=='image2image'&&generateNum!==1)throw Error('此命令不接受图片批量数量');
 return{command,prompt,model,resolution,ratio,duration,generateNum,references:references.map(r=>({...r}))};
}
export function jimengArguments(input,{fileForAsset}={}){
 const p=normalizeJimengRequest(input),args=[p.command],files=role=>p.references.filter(r=>r.role===role).map(r=>{const f=fileForAsset?.(r.assetId);if(typeof f!=='string'||!f||f.includes('\0')||f.includes(','))throw Error('参考文件路径无效或含逗号');return f;}),add=(k,v)=>args.push('--'+k+'='+v);
 if(p.command!=='image_upscale'&&!(p.command==='multiframe2video'&&p.references.length>2)&&(p.prompt||p.command==='text2image'))add('prompt',p.prompt);
 if(p.model)add('model_version',p.model);
 if(p.command==='image2image')add('images',files('image').join(','));
 if(['image_upscale','image2video'].includes(p.command))add('image',files('image')[0]);
 if(p.command==='frames2video'){add('first',files('first')[0]);add('last',files('last')[0]);}
 if(p.command==='multiframe2video'){
  add('images',files('frame').join(','));
  if(p.references.length===2)add('duration',p.duration);
  else{const lines=p.prompt.split('\n').map(x=>x.trim()).filter(Boolean);for(let i=0;i<p.references.length-1;i++){if(lines.length)add('transition-prompt',lines[Math.min(i,lines.length-1)]);add('transition-duration',p.duration);}}
 }else if(p.command.includes('video'))add('duration',p.duration);
 if(p.command==='multimodal2video')for(const role of ['image','video','audio'])for(const f of files(role))add(role,f);
 add(p.command.includes('video')?'video_resolution':'resolution_type',p.resolution);
 if(['text2image','image2image','text2video','multimodal2video'].includes(p.command))add('ratio',p.ratio);
 if(['text2image','image2image'].includes(p.command))add('generate_num',p.generateNum);
 add('poll',0);return args;
}
