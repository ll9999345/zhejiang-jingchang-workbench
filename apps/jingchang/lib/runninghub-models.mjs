import {readFileSync} from 'node:fs';
import {rhBase,rhId,checkRhMedia} from './runninghub.mjs';
import {safeApiCall,validateApiBaseUrl,ImageApiError} from './image-api.mjs';
import {userError,safeId,assertNoCredentials} from './workspace.mjs';

export const RH_CATALOG_VERSION='8f9c858e7e631a1c1c49df0c4defd77fdd690dd4';
const registry=JSON.parse(readFileSync(new URL('../resources/runninghub/models_registry.json',import.meta.url),'utf8'));
const models=new Map((Array.isArray(registry)?registry:registry.models).map(m=>[m.endpoint,m]));
const mediaTypes={IMAGE:'image',VIDEO:'video',AUDIO:'audio'};
const supportedTypes=new Set(['STRING','INT','FLOAT','BOOLEAN','LIST','SIZE',...Object.keys(mediaTypes)]);
const fieldId=f=>f.nodeId+':'+f.fieldName;
function unsupported(m){
 if(!['image','video','audio','string','3d'].includes(m.output_type))return '此目录项输出类型尚未接入';
 if(m.asset_ids_mode||m.real_person_mode_default)return '此模型还需要独立的真人资产转换流程，暂不可运行';
 if(m.params.some(p=>!supportedTypes.has(p.type)))return '模型含尚未支持的参数类型';
 return '';
}
export function rhModel(id,{allowUnsupported=false}={}){
 const m=models.get(id);if(!m)throw userError('请从 RunningHub 标准模型目录中选择型号');
 const reason=unsupported(m);if(reason&&!allowUnsupported)throw userError(reason);return m;
}
export function rhModelCatalog(){return {version:RH_CATALOG_VERSION,source:'https://github.com/HM-RunningHub/ComfyUI_RH_OpenAPI/tree/'+RH_CATALOG_VERSION,models:[...models.values()].map(m=>({id:m.endpoint,name:m.display_name||m.name_cn,alias:m.name_en,outputType:m.output_type,category:m.category,supported:!unsupported(m),reason:unsupported(m)}))};}
function options(p){return(p.options||[]).map(o=>String(typeof o==='object'?o.value:o)).filter(v=>!(p.fieldKey==='promptExtendMode'&&v==='agent'));}
function slots(p){return mediaTypes[p.type]&&p.multipleInputs?Math.max(1,Math.min(32,p.maxInputNum||5)):1;}
export function rhModelFields(id){return rhModel(id).params.flatMap(p=>Array.from({length:slots(p)},(_,index)=>{
 const media=mediaTypes[p.type],opts=options(p),required=!!p.required&&(index===0),type=media||({STRING:p.multipleInputs?'text-list':'text',INT:'number',FLOAT:'number',BOOLEAN:'boolean',LIST:p.payload_as_list?'multi-select':'select',SIZE:'size'}[p.type]);
 let value=p.defaultValue??(p.type==='BOOLEAN'?false:'');
  if(['LIST','SIZE'].includes(p.type)&&!p.payload_as_list&&!opts.includes(String(value)))value=required?opts.find(x=>x!=='empty'&&x!=='custom')||'':'';
  if(['LIST','SIZE','STRING'].includes(p.type)&&!p.payload_as_list)value=String(value);
  if(p.payload_as_list||type==='text-list')value=Array.isArray(value)?value:value?[String(value)]:[];
 return {nodeId:media?'ref-'+(index+1):'model',fieldName:p.fieldKey,fieldValue:value,type,label:(p.label||p.fieldKey)+(slots(p)>1?' · '+(index+1):''),description:p.description||'',options:opts,source:'value',required,enabled:!!media||required||p.defaultValue!==undefined,integer:p.type==='INT',...(type==='text-list'?{maxItems:Math.min(100,p.maxInputNum||32)}:{}),...(Number.isFinite(p.min)?{min:p.min}:{}),...(Number.isFinite(p.max)?{max:p.max}:{}),...(Number.isFinite(p.maxLength)?{maxLength:Math.min(20000,p.maxLength)}:{}),...(media?{maxBytes:Math.min(30,Number(p.maxSize)||30)*1024*1024,accept:p.accept||''}:{})};
}));}
export const activeRhFields=recipe=>recipe.fields.filter(f=>recipe.kind!=='model'||f.enabled!==false);
export function normalizeRhModelFields(id,fields){
 if(!Array.isArray(fields)||fields.length>200)throw userError('模型参数数量无效');
 const canonical=rhModelFields(id),expected=new Set(canonical.map(fieldId)),values=new Map();
 for(const f of fields){if(!f||!expected.has(fieldId(f))||values.has(fieldId(f)))throw userError('模型字段重复或不属于所选型号，请重新加载参数');values.set(fieldId(f),f);}
 return canonical.map(d=>{
  const f=values.get(fieldId(d))||d,enabled=d.required?true:f.enabled!==false,source=f.source==='asset'?'asset':'value';let v=f.fieldValue;
  if(d.type==='multi-select'||d.type==='text-list'){if(!Array.isArray(v)||v.length>(d.maxItems||100)||new Set(v).size!==v.length||v.some(x=>typeof x!=='string'||!x.trim()||x.length>(d.maxLength||20000)||d.type==='multi-select'&&!d.options.includes(x)))throw userError(d.label+'：列表值无效');v=[...v];}
  else if(!['string','number','boolean'].includes(typeof v)||typeof v==='number'&&!Number.isFinite(v)||String(v).length>20000)throw userError(d.label+'：参数值无效');
  if(enabled){
   if(d.type==='number'&&v!==''){if(typeof v==='boolean'||String(v).trim()===''||!Number.isFinite(Number(v))||d.integer&&!Number.isSafeInteger(Number(v)))throw userError(d.label+'：请输入有效'+(d.integer?'整数':'数字'));v=Number(v);if(d.min!==undefined&&v<d.min||d.max!==undefined&&v>d.max)throw userError(d.label+'：数值超出模型范围');}
   if(d.type==='boolean'&&typeof v!=='boolean')throw userError(d.label+'：开关必须为 true 或 false');
   if(d.type==='select'&&v!==''&&!d.options.includes(v))throw userError(d.label+'：请选择模型提供的选项');
   if(d.type==='size'&&v!==''&&!d.options.includes(v)&&!/^\d{2,5}[*x]\d{2,5}$/.test(v))throw userError(d.label+'：请输入宽*高或选择预设尺寸');
   if(d.maxLength!==undefined&&typeof v==='string'&&v.length>d.maxLength)throw userError(d.label+'：内容超过模型字数限制');
  }
  if(source==='asset'&&(!['image','video','audio'].includes(d.type)||!safeId(f.assetId)))throw userError(d.label+'：请选择本项目素材');
  return {...d,fieldValue:v,enabled,source,...(source==='asset'?{assetId:f.assetId}:{})};
 });
}
export function rhMediaUrl(value,baseUrl){
 if(typeof value!=='string'||value.length>16000)throw userError('参考素材链接无效');
 if(/^asset:\/\/[\w-]{1,200}$/.test(value))return value;
 let u;try{u=new URL(value);}catch{throw userError('标准模型参考素材须为 HTTPS 链接、asset:// 标识或项目素材');}
 if(!['https:','http:'].includes(u.protocol))throw userError('参考素材不支持此链接类型，请选择项目素材上传');
 if(u.username||u.password||u.hash)throw userError('素材链接不能包含登录信息或片段');
 const base=new URL(rhBase(baseUrl));validateApiBaseUrl(u.origin+u.pathname);
 if(u.protocol==='http:'&&u.origin!==base.origin)throw userError('本机素材不能以本地链接交给云平台，请选择项目素材上传');
 return u.href;
}
const nonempty=v=>Array.isArray(v)?v.length>0:typeof v==='string'?v.trim()!=='':v!==undefined;
export function compileRhModel(recipe,{allowAssets=false,allowMissing=new Set()}={}){
 const model=rhModel(recipe.targetId);if(recipe.catalogVersion&&recipe.catalogVersion!==RH_CATALOG_VERSION)throw userError('模型目录版本不匹配，请重新加载并核对参数');
 const fields=normalizeRhModelFields(recipe.targetId,recipe.fields),body={};
 for(const p of model.params){const all=fields.filter(f=>f.fieldName===p.fieldKey),rows=all.filter(f=>f.enabled!==false),isMedia=!!mediaTypes[p.type];
  if(isMedia){const refs=[];for(const f of rows){if(allowMissing.has(fieldId(f)))refs.push('__pending_reference__');else if(f.source==='asset'){if(!allowAssets)throw userError('请先上传已授权的项目素材');refs.push('__project_reference__');}else if(nonempty(f.fieldValue))refs.push(rhMediaUrl(f.fieldValue,recipe.baseUrl));}if(p.required&&!refs.length)throw userError((p.label||p.fieldKey)+'：请提供至少一项参考素材');if(refs.length)body[p.fieldKey]=p.multipleInputs||/Urls$/.test(p.fieldKey)?refs:refs[0];continue;}
  const f=rows[0];if(!f)continue;let v=f.fieldValue;
  if(allowMissing.has(fieldId(f)))v='__pending_text__';
  if(!nonempty(v)||(['LIST','SIZE'].includes(p.type)&&v==='empty')){if(p.required)throw userError(f.label+'：请填写必填参数');continue;}
  if(p.type==='SIZE'){if(v==='custom')throw userError('请选择具体尺寸，或填写自定义宽*高');const match=/^(\d{2,5})[*x](\d{2,5})$/.exec(v);if(!match)throw userError('图像尺寸格式无效');const [w,h]=match.slice(1).map(Number),pixels=w*h;if(p.min&&pixels<p.min**2||p.max&&pixels>p.max**2)throw userError('图像总像素超出模型允许范围');v=w+'*'+h;}
  // The documented v2 contract represents LIST selections as strings, even
  // when registry option values (e.g. Qwen imageNum) happen to be numbers.
  body[p.fieldKey]=v;
 }
 for(const p of model.params.filter(p=>p.payload_as_prompt_suffix)){
  const x=p.payload_as_prompt_suffix,v=body[p.fieldKey];if(v===undefined||x.skip_values?.includes(v))continue;
  const target=x.target_field||'prompt',prompt=String(body[target]||''),templates=/[\u3400-\u9fff]/.test(prompt)?x.templates_zh:x.templates_en;
  const decoration=String(templates?.[v]||templates?._default||' {value}').replaceAll('{value}',String(v));body[target]=x.position==='prefix'?decoration+prompt:prompt+decoration;if(!x.also_send_as_payload)delete body[p.fieldKey];
 }
 const c=model.size_constraints;if(c){if(body[c.gate_field]!==undefined){delete body[c.width_field];delete body[c.height_field];}else{const w=body[c.width_field],h=body[c.height_field],area=w*h,ratio=w/h;if(!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||area<c.min_total_pixels||area>c.max_total_pixels||ratio<c.min_aspect_ratio||ratio>c.max_aspect_ratio)throw userError('宽高组合超出模型的总像素或宽高比限制');}}
 assertNoCredentials(body);return body;
}
export function checkRhModelMedia(bytes,mime,field){checkRhMedia(bytes,mime);if(mime.split('/')[0]!==field.type||bytes.length>field.maxBytes)throw userError(field.label+'：素材类型或大小不符合模型要求');let accept;try{accept=JSON.parse(field.accept||'null');}catch{}if(Array.isArray(accept)&&accept.length){const ext={'image/png':'PNG','image/jpeg':'JPG','image/webp':'WEBP','video/mp4':'MP4','video/quicktime':'MOV','audio/wav':'WAV','audio/mpeg':'MP3','audio/flac':'FLAC'}[mime];if(!accept.map(x=>String(x).replace(/^\./,'').toUpperCase().replace('JPEG','JPG')).includes(ext))throw userError(field.label+'：模型不接受此文件格式');}}
export async function uploadRhModel({baseUrl,apiKey,bytes,mime,signal}){
 const media=checkRhMedia(bytes,mime),form=new FormData();form.append('file',new Blob([media.bytes],{type:mime}),media.name);
 const d=await safeApiCall({baseUrl:rhBase(baseUrl),apiKey,path:'openapi/v2/media/upload/binary',method:'POST',body:form,signal});
 if(d?.code!==0||typeof d.data?.download_url!=='string'||d.data.download_url.includes(apiKey))throw new ImageApiError('rh_upload','平台没有返回有效素材链接，不会自动重传');
 return rhMediaUrl(d.data.download_url,baseUrl);
}
export async function submitRhModel({recipe,apiKey,signal}){
 const body=compileRhModel(recipe),baseUrl=rhBase(recipe.baseUrl);
 const d=await safeApiCall({baseUrl,apiKey,path:'openapi/v2/'+rhModel(recipe.targetId).endpoint,method:'POST',body,signal});
 if(d?.errorCode||d?.errorMessage)throw new ImageApiError('rh_rejected','RunningHub 拒绝了此模型请求，请到平台查看原因',{uncertain:false});
 if(typeof d?.taskId!=='string'||!/^\d{1,30}$/.test(d.taskId))throw new ImageApiError('rh_missing_task','平台未返回有效任务编号，请核对原请求；不会自动重发',{uncertain:true});
 return rhId(d.taskId);
}
export async function queryRhAccount({baseUrl,apiKey,signal}){
 const d=await safeApiCall({baseUrl:rhBase(baseUrl),apiKey,path:'uc/openapi/accountStatus',method:'POST',body:{apikey:apiKey},signal});
 if(d?.code!==0||!d.data||typeof d.data!=='object')throw new ImageApiError('rh_account','账户查询失败，请核对站点与账户查询密钥',{uncertain:false});
 const value=v=>typeof v==='number'&&Number.isFinite(v)?v:typeof v==='string'&&v!==apiKey&&/^\d+(\.\d+)?$/.test(v)&&Number.isFinite(Number(v))?Number(v):null;
 return {remainMoney:value(d.data.remainMoney),remainCoins:value(d.data.remainCoins),currentTaskCounts:value(d.data.currentTaskCounts),currency:['CNY','USD'].includes(d.data.currency)?d.data.currency:null,checkedAt:new Date().toISOString()};
}
