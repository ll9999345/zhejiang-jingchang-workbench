const id=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v);
export const enhanceFieldKey=f=>JSON.stringify([f.nodeId,f.name]);
const field=f=>{if(!f||!id(f.nodeId)||typeof f.name!=='string'||!f.name||f.name.length>120||['__proto__','constructor','prototype'].includes(f.name))throw Error('增强工作流字段无效');return{nodeId:f.nodeId,name:f.name};};
export function normalizeEnhancement(value){
 if(!value||!['enhance','upscale'].includes(value.kind)||!['comfy','modelscope'].includes(value.engine))throw Error('图片增强方式无效');
 const out={kind:value.kind,engine:value.engine};
 if(value.engine==='modelscope'){if(value.kind!=='enhance')throw Error('超分辨率放大须使用本地 SeedVR2 工作流');return out;}
 out.imageField=field(value.imageField);
 if(value.kind==='enhance'){
  if(typeof value.strength!=='number'||!Number.isFinite(value.strength)||value.strength<.1||value.strength>1)throw Error('细节增强强度须为 0.1–1');
  out.strength=value.strength;out.strengthField=field(value.strengthField);
 }else{
  if(![2048,4096].includes(value.resolution)||value.maxResolution!==4096)throw Error('请选择 2K 或 4K，长边上限为 4096');
  out.resolution=value.resolution;out.maxResolution=4096;out.resolutionField=field(value.resolutionField);out.maxResolutionField=field(value.maxResolutionField);
 }
 if(!['random','fixed','workflow'].includes(value.seedMode))throw Error('随机种子设置无效');out.seedMode=value.seedMode;
 if(value.seedMode!=='workflow'){
  if(!Array.isArray(value.seedFields)||!value.seedFields.length||value.seedFields.length>32)throw Error('请选择需要控制的 seed 或 noise_seed 字段');
  out.seedFields=value.seedFields.map(f=>{const v=field(f);if(!['seed','noise_seed'].includes(v.name))throw Error('随机种子只可映射 seed 或 noise_seed');return v;});
  if(value.seedMode==='fixed'){if(!Number.isSafeInteger(value.seed)||value.seed<0||value.seed>4294967295)throw Error('随机种子须为 0–4294967295 的整数');out.seed=value.seed;}
 }
 const mapped=[out.imageField,out.strengthField,out.resolutionField,out.maxResolutionField,...(out.seedFields||[])].filter(Boolean);
 if(new Set(mapped.map(enhanceFieldKey)).size!==mapped.length)throw Error('增强工作流的受控字段不能重复');return out;
}
export function enhancementOf(node){return node?.params?.workflowBinding?.imageEnhance||node?.params?.studioBinding?.imageEnhance;}
export function enhancementMetadata(asset){
 if(asset.enhancement===undefined)return{};const e=asset.enhancement;
 if(!e||!asset.type?.startsWith('image/')||!id(e.sourceAssetId)||!id(e.originalAssetId)||e.sourceAssetId===asset.id||e.originalAssetId===asset.id||!['enhance','upscale'].includes(e.kind)||!['comfy','modelscope'].includes(e.engine))throw Error('图片增强来源记录无效');
 const out={kind:e.kind,engine:e.engine,sourceAssetId:e.sourceAssetId,originalAssetId:e.originalAssetId};
 if(e.kind==='upscale'){if(e.engine!=='comfy'||![2048,4096].includes(e.resolution)||e.maxResolution!==4096)throw Error('放大结果参数无效');Object.assign(out,{resolution:e.resolution,maxResolution:4096});}
 if(e.kind==='enhance'&&e.engine==='comfy'){if(!Number.isFinite(e.strength)||e.strength<.1||e.strength>1)throw Error('增强结果强度无效');out.strength=e.strength;}
 if(e.seed!==undefined){if(!Number.isSafeInteger(e.seed)||e.seed<0||e.seed>4294967295)throw Error('增强结果随机种子无效');out.seed=e.seed;}
 return{enhancement:out};
}
