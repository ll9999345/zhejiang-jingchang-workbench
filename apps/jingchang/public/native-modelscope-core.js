// Pinned smart-canvas ModelScope capability. This module never selects a
// service, carries credentials, or submits work.
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const models=Object.freeze({
 zimage:Object.freeze({modelId:'Tongyi-MAI/Z-Image-Turbo',acceptsImages:false,requiresImages:false}),
 qwen_edit:Object.freeze({modelId:'Qwen/Qwen-Image-Edit-2511',acceptsImages:true,requiresImages:true}),
 klein_edit:Object.freeze({modelId:'black-forest-labs/FLUX.2-klein-9B',acceptsImages:true,requiresImages:true}),
 custom:Object.freeze({modelId:'',acceptsImages:true,requiresImages:false})
});

export function normalizeNativeModelscopeConfig(marker){
 if(!object(marker)||marker.version!==1||!Object.hasOwn(models,marker.modelKey)||typeof marker.acceptsImages!=='boolean'||marker.acceptsImages!==models[marker.modelKey].acceptsImages||Object.keys(marker).some(key=>!['version','modelKey','acceptsImages'].includes(key)))throw Error('原生 ModelScope 标记无效，请重新核对模型与参考图范围');
 return{version:1,modelKey:marker.modelKey,acceptsImages:marker.acceptsImages};
}
export function nativeModelscopeModel(marker){
 const normalized=normalizeNativeModelscopeConfig(marker);
 return{modelKey:normalized.modelKey,...models[normalized.modelKey]};
}
export function normalizeNativeModelscopeSize(size){
 if(typeof size!=='string'||!/^([1-9]\d{0,4})x([1-9]\d{0,4})$/.test(size))throw Error('原生 ModelScope 尺寸须为有效的宽x高正整数');
 return size;
}
export function studioRequestCount(studio){
 const config=studio?.config;
 if(config?.protocol!=='modelscope'||config.nativeModelscope===undefined)return 1;
 normalizeNativeModelscopeConfig(config.nativeModelscope);
 const count=config.count??1;
 if(studio.mode!=='image'||!Number.isInteger(count)||count<1||count>8)throw Error('原生 ModelScope 图片数量须为1–8的整数');
 return count;
}
export function studioModelscopeReferenceLimit(studio){
 const config=studio?.config;
 if(config?.protocol!=='modelscope'||config.nativeModelscope===undefined)return 3;
 return normalizeNativeModelscopeConfig(config.nativeModelscope).acceptsImages?20:0;
}
