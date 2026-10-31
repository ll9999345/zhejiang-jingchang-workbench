// Shared mapping contract for built-in and user-configured ComfyUI file inputs.
const labels={image:'图片',video:'视频',audio:'音频'};
function descriptor(kind,classType,name){
 if(!Object.hasOwn(labels,kind))return null;
 const kinds=kind==='audio'&&classType==='LoadAudio'&&name==='audio'?['audio','video']:[kind];
 return {kind,label:labels[kind],kinds};
}
export function comfyMediaField(classType,name,config){
 // A saved setting takes precedence, so built-in mappings can also be disabled.
 if(config&&Object.hasOwn(config,'mediaKind'))return config.mediaKind==='none'?null:descriptor(config.mediaKind,classType,name);
 if(['LoadImage','LoadImageMask'].includes(classType)&&name==='image')return descriptor('image',classType,name);
 if(classType==='LoadVideo'&&name==='file')return descriptor('video',classType,name);
 if(classType==='LoadAudio'&&name==='audio')return descriptor('audio',classType,name);
 return null;
}
export function suggestComfyMediaKind(name,value=''){
 const key=String(name||'').toLowerCase(),sample=String(value||'');
 if(/prompt|text|description|提示词|正向|负向/.test(key)||sample.length>60)return 'none';
 if(/video|movie|mp4|webm|mov|m4v|vhs/.test(key)||/\.(mp4|webm|mov|m4v|avi|mkv)(\?|$)/i.test(sample))return 'video';
 if(/audio|sound|music|voice|wav|mp3/.test(key)||/\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(sample))return 'audio';
 if(/image|img|mask|filename|file/.test(key)||/\.(png|jpe?g|webp|gif|bmp|tiff?)(\?|$)/i.test(sample))return 'image';
 return 'none';
}
export const comfyMediaTypes={'image/png':{extension:'png',limit:10},'image/jpeg':{extension:'jpg',limit:10},'image/webp':{extension:'webp',limit:10},'video/mp4':{extension:'mp4',limit:150},'video/quicktime':{extension:'mov',limit:150},'video/webm':{extension:'webm',limit:150},'audio/wav':{extension:'wav',limit:150},'audio/x-wav':{extension:'wav',limit:150},'audio/mpeg':{extension:'mp3',limit:150},'audio/flac':{extension:'flac',limit:150},'audio/ogg':{extension:'ogg',limit:150},'audio/mp4':{extension:'m4a',limit:150}};
export function supportsComfyAsset(field,asset){const type=comfyMediaTypes[asset.type];return !!type&&field.kinds.includes(asset.type.split('/')[0])&&asset.size>0&&asset.size<=type.limit*1024*1024;}
