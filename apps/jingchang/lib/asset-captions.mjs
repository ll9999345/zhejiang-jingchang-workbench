import {withAssetMetadataLock} from './asset-metadata-lock.mjs';
import path from 'node:path';
import {promises as fs,constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {safeId,userError,loadAsset,atomicJson} from './workspace.mjs';
import {inspectPublicMediaSource} from './public-media.mjs';
import {guardArchiveSecrets} from './task-history-schema.mjs';

export const CAPTION_MAX_CHARACTERS=100000;
export const CAPTION_IMAGE_TYPES=new Set(['image/png','image/jpeg','image/webp']);
export {DEFAULT_ASSET_CAPTION_PROMPT} from '../public/asset-caption-core.js';
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
export function captionText(value,{allowEmpty=true}={}){
 if(typeof value!=='string'||value.length>CAPTION_MAX_CHARACTERS*2||[...value].length>CAPTION_MAX_CHARACTERS||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)||!allowEmpty&&!value.trim())throw userError('图片提示词须为有效文字，最多100000个字符');
 guardArchiveSecrets(value);return value;
}
export function normalizeAssetCaption(value){
 const keys=['version','revision','text','updatedAt','sourceSha256','source',...(value?.source==='model'?['platformId','model','sourceRequestId']:[])];
 if(!value||Object.keys(value).sort().join(',')!==keys.sort().join(',')||value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<1||value.revision>1e9||!timestamp(value.updatedAt)||!hash(value.sourceSha256)||!['manual','model'].includes(value.source))throw userError('图片提示词元数据无效');
 const out={version:1,revision:value.revision,text:captionText(value.text),updatedAt:value.updatedAt,sourceSha256:value.sourceSha256,source:value.source};
 if(value.source==='model'){
  if(!safeId(value.platformId)||!safeId(value.sourceRequestId)||typeof value.model!=='string'||!value.model.length||value.model.length>200)throw userError('图片提示词模型出处无效');
  Object.assign(out,{platformId:value.platformId,model:value.model,sourceRequestId:value.sourceRequestId});
 }
 guardArchiveSecrets(out);return out;
}
export function assetCaptionService({data}){
 async function asset(id){if(!safeId(id))throw userError('素材编号无效');const file=path.join(await fs.realpath(data),'assets',id+'.json');if(await fs.realpath(file)!==file||!(await fs.lstat(file)).isFile())throw userError('素材元数据不是普通文件',409);const a=await loadAsset(data,id);if(a.id!==id)throw userError('素材元数据归属不符',409);if(!CAPTION_IMAGE_TYPES.has(a.type))throw userError('反推提示词仅支持PNG、JPEG和WebP图片');return a;}
 async function directory(){const root=await fs.realpath(data),base=path.join(root,'asset-caption-history');await fs.mkdir(base,{recursive:true,mode:0o700});if(await fs.realpath(base)!==base)throw userError('提示词历史目录异常');return base;}
 async function get(id){const a=await asset(id),caption=a.caption?normalizeAssetCaption(a.caption):null;return{assetId:a.id,name:a.name,caption,revision:caption?.revision||0};}
 async function save(id,body,{modelResult}={}){return withAssetMetadataLock(data,id,async()=>{
  const a=await asset(id),old=a.caption?normalizeAssetCaption(a.caption):null;
  if(!body||!Number.isSafeInteger(body.revision)||body.revision!==(old?.revision||0))throw userError('图片提示词已经修改，请重新读取后再保存；旧文字保持',409);
  if(!modelResult&&Object.keys(body).some(k=>!['revision','text'].includes(k)))throw userError('手动保存仅接受文字和原版本号');
  const text=captionText(body.text),media=await inspectPublicMediaSource(data,id,10*1024**2);
  if(modelResult&&media.sourceSha256!==modelResult.sourceSha256)throw userError('原图片已经变化，未回填旧反推结果',409);
  const caption=normalizeAssetCaption({version:1,revision:(old?.revision||0)+1,text,updatedAt:new Date().toISOString(),sourceSha256:media.sourceSha256,source:modelResult?'model':'manual',...(modelResult?{platformId:modelResult.platformId,model:modelResult.model,sourceRequestId:modelResult.requestId}:{})});
  if(old){const base=await directory(),file=path.join(base,randomUUID()+'.json');await fs.writeFile(file,JSON.stringify({version:1,assetId:id,caption:old}),{flag:'wx',mode:0o600});}
  const meta=path.join(await fs.realpath(data),'assets',id+'.json');if(await fs.realpath(meta)!==meta)throw userError('素材元数据路径异常，未覆盖原记录',409);
  await atomicJson(meta,{...a,caption});return{assetId:id,name:a.name,caption,revision:caption.revision};
 });}
 async function apply(id,record){
  if(!record||record.status!=='completed'||record.complete!==true||!safeId(record.requestId)||!safeId(record.platformId)||typeof record.text!=='string'||!hash(record.sourceSha256))throw userError('仅能取回已完整完成的反推结果');
  const current=await get(id);if(current.caption?.source==='model'&&current.caption.sourceRequestId===record.requestId){if(current.caption.text!==record.text||current.caption.sourceSha256!==record.sourceSha256||(await inspectPublicMediaSource(data,id,10*1024**2)).sourceSha256!==record.sourceSha256)throw userError('原反推请求的结果记录冲突',409);return{...current,replayed:true};}
  return save(id,{revision:record.captionRevision,text:record.text},{modelResult:record});
 }
 async function history(id){const current=await get(id),base=await directory(),rows=current.caption?[{version:1,assetId:id,caption:current.caption}]:[],seen=new Set(rows.map(r=>JSON.stringify(r.caption)));for(const name of (await fs.readdir(base)).filter(n=>/^[\w-]+\.json$/.test(n))){let handle;try{handle=await fs.open(path.join(base,name),constants.O_RDONLY|constants.O_NOFOLLOW);const st=await handle.stat();if(!st.isFile()||st.size>2*1024**2)throw userError('提示词历史文件异常');const row=JSON.parse(await handle.readFile('utf8'));if(row.assetId!==id)continue;const caption=normalizeAssetCaption(row.caption),signature=JSON.stringify(caption);if(!seen.has(signature)){rows.push({version:1,assetId:id,caption});seen.add(signature);}}finally{await handle?.close();}}return rows.sort((a,b)=>b.caption.revision-a.caption.revision||b.caption.updatedAt.localeCompare(a.caption.updatedAt));}

 return{get,save,apply,history,metadata:normalizeAssetCaption};
}
