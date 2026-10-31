import {isApimartMultimodal} from './reference-limits.js';
export {isApimartMultimodal};
export const apimartAssetUrl=v=>typeof v==='string'&&/^asset:\/\/[a-zA-Z0-9_-]{1,128}$/.test(v);
export const APIMART_REFERENCE_TYPES=['image/png','image/jpeg','image/webp','video/mp4','video/quicktime','audio/wav','audio/x-wav','audio/mpeg','audio/mp4'];
export function apimartReferenceError(s,refs){
 if(s?.config?.protocol!=='apimart'||s.mode!=='video')return '';
 const c=s.config;if(!['doubao-seedance-2.0','doubao-seedance-2.0-fast'].includes(c.model)||c.operation!=='generate'||c.duration<5||c.resolution==='1080p')return 'APIMart视频使用Seedance 2.0 / fast，5–15秒、480p或720p。';
 if(!isApimartMultimodal(s))return refs.length>2||refs.some(r=>!r.url||!String(r.type||'image/png').startsWith('image/'))?'首尾帧模式最多两张公网图片；多类型或平台素材请显式选择APIMart多素材模式。':'';
 if(refs.length>15||new Set(refs.map(r=>r.url)).size!==refs.length)return '多素材参考合计最多15项，不能重复。';
 const count={image:0,video:0,audio:0};
 for(const r of refs){const type=r.type||r.mime||'image/png',kind=type.split('/')[0];if(!r.url||!APIMART_REFERENCE_TYPES.includes(type))return 'APIMart多素材参考须先取得公网HTTPS链接或审核后的asset://编号；不会自动上传本机文件。';count[kind]++;}
 if(count.image>9||count.video>3||count.audio>3)return 'APIMart多素材最多9张图片、3段视频、3段音频。';
 if(count.audio&&!count.image&&!count.video)return '音频参考须与图片或视频一同使用。';return '';
}
