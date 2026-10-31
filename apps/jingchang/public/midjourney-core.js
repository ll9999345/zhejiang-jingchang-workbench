export const MJ_MODES = {
  imagine:'文生图 / 参考图生成', blend:'多图融合', edit:'图片编辑',
  upscale:'放大选图', variation:'生成变体', low_variation:'微调变体',
  high_variation:'大幅变体', reroll:'重新生成', zoom:'缩放扩图', pan:'平移扩图',
  inpaint:'局部重绘入口', modal:'补充重绘遮罩', remix_subtle:'轻度重塑', remix_strong:'强度重塑',
};
export const MJ_TASK_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/;
export const validMjTask = value => typeof value==='string' && MJ_TASK_PATTERN.test(value) && !value.includes('..');
export const isMidjourney = studio => studio?.mode==='image' && studio?.config?.protocol==='midjourney';
export const mjPromptOptional = studio => isMidjourney(studio) && !['imagine','edit'].includes(studio.config.mjMode||'imagine');

export function normalizeMidjourneyConfig(c) {
  const mjMode=c.mjMode??'imagine', mjSpeed=c.mjSpeed??'relax', mjVersion=c.mjVersion??'6.1';
  if(!Object.hasOwn(MJ_MODES,mjMode)||!['relax','fast','turbo'].includes(mjSpeed))throw Error('Midjourney 操作或速度无效');
  if(typeof mjVersion!=='string'||!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,23}$/.test(mjVersion))throw Error('Midjourney 版本无效');
  const mjSize=c.mjSize??c.ratio??'1:1';
  if(typeof mjSize!=='string'||!/^\d{1,2}:\d{1,2}$/.test(mjSize)||mjSize.split(':').some(n=>Number(n)<1))throw Error('Midjourney 画幅须为1–99的宽:高，例如7:5');
  const mjTaskId=c.mjTaskId??'',mjCustomId=c.mjCustomId??'';
  if(mjTaskId!==''&&!validMjTask(mjTaskId))throw Error('Midjourney 原任务编号无效');
  if(typeof mjCustomId!=='string'||mjCustomId.length>600||/[\x00-\x1f\x7f]/.test(mjCustomId))throw Error('Midjourney 操作按钮编号无效');
  const mjIndex=c.mjIndex??1,mjZoom=c.mjZoom??2,mjDirection=c.mjDirection??'left',mjMaskConvention=c.mjMaskConvention??'white-edit';
  if(!Number.isInteger(mjIndex)||mjIndex<1||mjIndex>4)throw Error('Midjourney 图片序号须为1–4');
  if(typeof mjZoom!=='number'||!Number.isFinite(mjZoom)||mjZoom<=1||mjZoom>4)throw Error('Midjourney 缩放须大于1且不超过4');
  if(!['left','right','up','down'].includes(mjDirection)||!['white-edit','alpha'].includes(mjMaskConvention))throw Error('Midjourney 方向或遮罩模式无效');
  return {mjMode,mjSpeed,mjVersion,mjSize,mjTaskId,mjCustomId,mjIndex,mjZoom,mjDirection,mjMaskConvention};
}

export function validateMidjourneyRequest(studio, refs=studio.references||[]) {
  if(studio?.config?.protocol!=='midjourney')return;
  const c=studio.config,m=normalizeMidjourneyConfig(c),mode=m.mjMode;
  if(!isMidjourney(studio)||c.model!=='midjourney'||!c.imageAsync||c.count!==1||c.transparent||c.quality!=='auto')throw Error('Midjourney 需要图片异步模式、midjourney模型、单次操作、自动质量及非透明背景');
  if(refs.length>4||refs.some(r=>(r.type||r.mime)&&!['image/png','image/jpeg','image/webp'].includes(r.type||r.mime)))throw Error('Midjourney 最多4张PNG/JPEG/WebP参考图');
  if(['imagine','edit'].includes(mode)&&!studio.prompt?.trim())throw Error('Midjourney 生成或编辑需要提示词');
  if(mode==='blend'&&(refs.length<2||refs.length>4))throw Error('Midjourney 多图融合需要2–4张图片');
  if(mode==='edit'&&!refs.length)throw Error('Midjourney 编辑至少需要一张参考图');
  if(!['imagine','blend','edit'].includes(mode)&&!validMjTask(m.mjTaskId))throw Error('请填写同一服务下的Midjourney原任务编号');
  if(mode==='modal'&&refs.length!==1)throw Error('重绘补参需要恰好一张遮罩图');
  if(!['imagine','blend','edit','modal'].includes(mode)&&refs.length)throw Error('此二次操作使用原任务，不发送新的参考图片；请先移除本次引用');
  if(mode==='modal'&&m.mjMaskConvention==='alpha'&&refs.some(r=>(r.type||r.mime)&&((r.type||r.mime)!=='image/png')))throw Error('透明区域遮罩须使用PNG');
}
