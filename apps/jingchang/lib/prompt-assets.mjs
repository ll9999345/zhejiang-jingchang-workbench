import {safeId,userError} from './workspace.mjs';

export const PROMPT_ASSET_TYPES=Object.freeze(['image/png','image/jpeg','image/webp']);
export const PROMPT_ASSET_LIMIT=20;
export const PROMPT_ASSET_BYTES_LIMIT=10*1024*1024;

export function promptAssetIds(project,node){
 const ids=node?.params?.promptAssetIds??[];
 if(!Array.isArray(ids)||ids.length>PROMPT_ASSET_LIMIT)throw userError('提示词引用图片最多20张');
 const seen=new Set();
 for(const id of ids){
  if(!safeId(id)||seen.has(id))throw userError('提示词引用图片编号无效或重复');
  seen.add(id);
  const asset=project.assets.find(a=>a.id===id);
  if(!asset||!PROMPT_ASSET_TYPES.includes(asset.type)||!Number.isFinite(asset.size)||asset.size<=0||asset.size>PROMPT_ASSET_BYTES_LIMIT)throw userError('提示词引用仅支持当前项目内不超过10MB的PNG、JPEG或WebP图片');
 }
 return [...ids];
}

export function appendPromptAssetSources(sources,ids){
 const result=[...(sources||[])],seen=new Set(result.filter(r=>r?.assetId).map(r=>r.assetId));
 for(const assetId of ids)if(!seen.has(assetId)){result.push({assetId});seen.add(assetId);}
 return result;
}
