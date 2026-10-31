import path from 'node:path';
import {randomInt} from 'node:crypto';
import {normalizeEnhancement,enhancementMetadata,enhanceFieldKey} from '../public/image-enhance-core.js';
import {comfyMediaField} from '../public/comfy-media.js';
import {atomicJson,loadAsset,userError} from './workspace.mjs';

export function compileEnhancement(binding,graph,fieldConfigs=[]){
 let recipe;try{recipe=normalizeEnhancement(binding.imageEnhance);}catch(e){throw userError(e.message);}
 if(recipe.engine!=='comfy')throw userError('本地增强须绑定 ComfyUI 工作流');
 if((binding.count||1)!==1||binding.promptBatch||binding.ltxDirector)throw userError('增强节点每次处理一张图片，请用画布循环运行多组');
 const check=(f,type)=>{const n=Object.hasOwn(graph,f.nodeId)?graph[f.nodeId]:null;if(!n||typeof n.inputs?.[f.name]!==type||Array.isArray(n.inputs?.[f.name]))throw userError('增强字段不存在或已变为连线，请重新映射');return n;};
 const image=check(recipe.imageField,'string');if(!comfyMediaField(image.class_type,recipe.imageField.name,fieldConfigs.find(f=>f.nodeId===recipe.imageField.nodeId&&f.name===recipe.imageField.name))?.kinds.includes('image'))throw userError('增强参考图须映射到图片输入');
 if(binding.imageSources?.length!==1||enhanceFieldKey(binding.imageSources[0])!==enhanceFieldKey(recipe.imageField))throw userError('增强节点须绑定一张参考图，且与增强图片字段一致');
 const overrides=[];
 if(recipe.kind==='enhance'){check(recipe.strengthField,'number');overrides.push({...recipe.strengthField,value:recipe.strength});}
 else{
  const n=check(recipe.resolutionField,'number');check(recipe.maxResolutionField,'number');
  if(n.class_type!=='SeedVR2VideoUpscaler'||recipe.resolutionField.name!=='resolution'||recipe.maxResolutionField.nodeId!==recipe.resolutionField.nodeId||recipe.maxResolutionField.name!=='max_resolution')throw userError('2K / 4K 放大须映射同一 SeedVR2VideoUpscaler 的 resolution 和 max_resolution');
  overrides.push({...recipe.resolutionField,value:recipe.resolution},{...recipe.maxResolutionField,value:recipe.maxResolution});
 }
 if(recipe.seedMode!=='workflow'){
  const seed=recipe.seedMode==='fixed'?recipe.seed:randomInt(0,4294967296);recipe.seed=seed;
  for(const f of recipe.seedFields){check(f,'number');overrides.push({...f,value:seed});}
 }
 const keys=new Set(overrides.map(enhanceFieldKey));
 if([...(binding.overrides||[]),binding.promptField,binding.promptBatch,...(binding.imageSources||[])].filter(Boolean).some(f=>keys.has(enhanceFieldKey(f))))throw userError('增强受控字段与普通参数重复，请在增强面板调整');
 return{recipe,overrides,source:binding.imageSources[0]};
}
export function normalizeCloudEnhancement(binding){
 if(!binding.imageEnhance)return null;let r;try{r=normalizeEnhancement(binding.imageEnhance);}catch(e){throw userError(e.message);}
 if(r.engine!=='modelscope'||r.kind!=='enhance'||binding.mode!=='image'||binding.config?.protocol!=='modelscope'||binding.referenceSources?.length!==1||binding.referenceSources[0].url)throw userError('ModelScope 增强须绑定一张本地或上游图片');return r;
}
export async function annotateEnhancement(data,assets,step){
 const r=step.imageEnhance;if(!r)return assets;
 const source=await loadAsset(data,step.enhanceSourceId);if(!source.type.startsWith('image/'))throw userError('增强来源不是图片');
 return Promise.all(assets.map(async a=>{
  if(!a.type.startsWith('image/'))return a;
  const meta=await loadAsset(data,a.id),enhancement={kind:r.kind,engine:r.engine,sourceAssetId:source.id,originalAssetId:source.enhancement?.originalAssetId||source.id,...(r.kind==='upscale'?{resolution:r.resolution,maxResolution:r.maxResolution}:r.engine==='comfy'?{strength:r.strength}:{}),...(r.seed!==undefined?{seed:r.seed}:{})};
  if(meta.enhancement&&JSON.stringify(meta.enhancement)!==JSON.stringify(enhancement))throw userError('增强结果来源记录冲突，已保留原结果');
  let update;try{update=enhancementMetadata({...meta,enhancement});}catch(e){throw userError(e.message);}
  const result={...meta,...update};await atomicJson(path.join(data,'assets',a.id+'.json'),result);return{...a,...update};
 }));
}
export function validateEnhancementLinks(assets,version){
 const byId=new Map(assets.map(a=>[a.id,a]));
 for(const a of assets){if(!a.enhancement)continue;if(version<4)throw userError('带原图关联的增强结果需要第4版备份');for(const id of [a.enhancement.sourceAssetId,a.enhancement.originalAssetId])if(!byId.get(id)?.type.startsWith('image/'))throw userError('备份缺少增强前的原图');const source=byId.get(a.enhancement.sourceAssetId);if(a.enhancement.originalAssetId!==(source.enhancement?.originalAssetId||source.id))throw userError('增强结果的原图关联不一致');}
 const done=new Set(),visiting=new Set();function visit(a){if(done.has(a.id))return;if(visiting.has(a.id))throw userError('媒体原图存在循环依赖');visiting.add(a.id);for(const id of [...(a.editId||a.operation==='panorama'?[a.sourceAssetId]:[]),...(a.enhancement?[a.enhancement.sourceAssetId,a.enhancement.originalAssetId]:[])]){const source=byId.get(id);if(source)visit(source);}visiting.delete(a.id);done.add(a.id);}for(const a of assets)visit(a);
}
