import {normalizeEdits,editSize} from './image-edit-core.mjs';
import {safeId,userError} from './workspace.mjs';
const id=x=>{if(!safeId(x))throw userError('图片编辑记录编号无效');return x;};
const dimensions=(w,h)=>{try{return editSize(w,h);}catch(e){throw userError(e.message);}};
export function editAssetMetadata(asset){
 if(asset.editId===undefined)return{};
 id(asset.editId);id(asset.sourceAssetId);if(asset.type!=='image/png'||!['image','mask','input'].includes(asset.editOutput)||asset.operation!=='image-edit')throw userError('图片编辑输出记录无效');
 return{editId:asset.editId,editOutput:asset.editOutput,sourceAssetId:asset.sourceAssetId,operation:'image-edit',...dimensions(asset.width,asset.height)};
}
export function normalizeBundleEdits(input,assets){
 const records=input??[];if(!Array.isArray(records)||records.length>1000)throw userError('图片编辑记录数量无效');const assetMap=new Map(assets.map(a=>[a.id,a])),ids=new Set(),owners=new Set();
 const edits=records.map(r=>{
  if(!r||r.version!==1||ids.has(id(r.id)))throw userError('图片编辑记录版本或编号无效');ids.add(r.id);const source=assetMap.get(id(r.sourceAssetId));if(!source?.type.startsWith('image/'))throw userError('备份缺少图片编辑原图');
  dimensions(r.sourceWidth,r.sourceHeight);let normalized;try{normalized=normalizeEdits(r.sourceWidth,r.sourceHeight,r.operations);}catch(e){throw userError('图片编辑步骤无效：'+e.message);}
  if(normalized.width!==r.width||normalized.height!==r.height)throw userError('图片编辑步骤与输出尺寸不一致');const outputs={};
  for(const kind of ['image','mask','input']){const assetId=id(r.outputs?.[kind]),a=assetMap.get(assetId);if(!a||a.type!=='image/png'||a.editId!==r.id||a.editOutput!==kind||a.sourceAssetId!==source.id||a.width!==r.width||a.height!==r.height||assetId===source.id||owners.has(assetId))throw userError('备份缺少或混淆了图片编辑输出');owners.add(assetId);outputs[kind]=assetId;}
  if(source.editId&&(source.width!==r.sourceWidth||source.height!==r.sourceHeight))throw userError('图片编辑原图尺寸与上游结果不一致');
  return{id:r.id,version:1,sourceAssetId:source.id,sourceWidth:r.sourceWidth,sourceHeight:r.sourceHeight,width:r.width,height:r.height,operations:normalized.operations,outputs};
 });
 for(const a of assets)if(a.editId&&(!ids.has(a.editId)||!owners.has(a.id)))throw userError('备份缺少素材对应的图片编辑记录');
 const byId=new Map(edits.map(r=>[r.id,r])),done=new Set();
 for(const r of edits){const chain=new Set();let current=r;while(current&&!done.has(current.id)){if(chain.has(current.id))throw userError('图片编辑原图存在循环依赖');chain.add(current.id);current=byId.get(assetMap.get(current.sourceAssetId)?.editId);}for(const key of chain)done.add(key);}
 return edits;
}
// Check actual PNG headers as well as manifest values; ordinary non-edit assets retain v1 behavior.
export async function checkEditPngs(assets,edits,readHeader){
 const expected=new Map(),byId=new Map(assets.map(a=>[a.id,a]));const add=(key,width,height)=>{const previous=expected.get(key);if(previous&&(previous.width!==width||previous.height!==height))throw userError('图片编辑原图尺寸声明冲突');expected.set(key,{width,height});};
 for(const r of edits){add(r.sourceAssetId,r.sourceWidth,r.sourceHeight);for(const key of Object.values(r.outputs))add(key,r.width,r.height);}
 for(const a of assets)if(a.operation==='panorama'){add(a.id,a.width,a.height);add(a.sourceAssetId,a.sourceWidth,a.sourceHeight);}
 for(const [key,size] of expected){if(byId.get(key)?.type!=='image/png')continue;const header=await readHeader(key);if(header.length<24||!header.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))||header.readUInt32BE(16)!==size.width||header.readUInt32BE(20)!==size.height)throw userError('图片编辑PNG实际尺寸与记录不一致');}
}
