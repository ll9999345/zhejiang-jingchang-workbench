// Seedance 2.0 reference mode is explicit: legacy projects keep frame roles.
import {isArkMultimodal} from './reference-limits.js';
export {isArkMultimodal};
export const ARK_REFERENCE_LIMITS = Object.freeze({image:9,video:3,audio:3,total:15});
export const ARK_REFERENCE_TYPES = Object.freeze(['image/png','image/jpeg','image/webp','video/mp4','video/quicktime','audio/wav','audio/x-wav','audio/mpeg']);
export const arkAssetUrl = value => typeof value==='string' && /^asset:\/\/[A-Za-z0-9_-]{1,128}$/.test(value);
export const arkMediaCategory = ref => String(ref?.type||ref?.mime||'image/png').split('/')[0];
export function arkReferenceError(studio, refs) {
  if(studio?.config?.protocol!=='ark')return '';
  if(studio.mode!=='video'||studio.config.operation!=='generate')return '方舟仅支持生成视频；请切换操作为生成。';
  if(!isArkMultimodal(studio))return refs.length>2||refs.some(r=>arkMediaCategory(r)!=='image')?'首尾帧模式支持纯文字、单首帧或两张首尾帧；多素材请切换参考模式。':'';
  const model=studio.config.model||'';
  if(!(/seedance[-.]2[-.]0(?:[-.]|$)/i.test(model)||/^ep-[A-Za-z0-9_-]+$/.test(model)))return '多素材参考仅接入 Seedance 2.0 系列。使用 ep- 接入点时，请确认它对应此系列。';
  if(refs.length>ARK_REFERENCE_LIMITS.total)return '方舟多素材参考合计最多15项。';
  const counts={image:0,video:0,audio:0};
  for(const r of refs){const type=r.type||r.mime||'image/png',kind=arkMediaCategory(r);if(!ARK_REFERENCE_TYPES.includes(type))return '方舟参考支持 PNG/JPEG/WebP、MP4/MOV 公网地址或平台素材、MP3/WAV。';counts[kind]++;if(kind==='video'&&!r.url)return '方舟参考视频原文件需要公网 HTTPS 地址或 asset:// 平台素材编号。本机视频尚未接入平台素材上传，请保留原文件并使用已上传地址。';}
  for(const [kind,max] of Object.entries(ARK_REFERENCE_LIMITS))if(kind!=='total'&&counts[kind]>max)return `方舟多素材参考${{image:'图片',video:'视频',audio:'音频'}[kind]}最多${max}项。`;
  if(counts.audio&&!counts.image&&!counts.video)return 'Seedance 2.0 不能仅以音频参考生成；请至少添加一张图片或一段视频。';
  return '';
}
export const arkSendsOriginalMedia = (studio,refs) => isArkMultimodal(studio)&&refs.some(r=>['video','audio'].includes(arkMediaCategory(r)));
