// Pure conversions for the pinned Infinite Canvas field and parameter formats.
// No file, network, credential, or generation operations are performed here.
import {randomFieldKey} from './workflow-random-core.js';
import {nativeModelscopeModel,normalizeNativeModelscopeSize} from './native-modelscope-core.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const scalar = value => ['string','boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value);
const own = (value,key) => Object.hasOwn(value,key);
const numeric = (value,label) => {
 if (!['string','number'].includes(typeof value) || !Number.isFinite(Number(value))) throw Error('原生数字值无效：'+label);
 return Number(value);
};
const dictionary = (value,label) => {
 if (value === undefined) return {};
 if (!object(value) || Object.keys(value).length > 1000 || Object.keys(value).some(key => key.length>300 || ['__proto__','constructor','prototype'].includes(key))) throw Error('原生'+label+'不是有效字段表');
 return value;
};
const converted = (value,type,label) => {
 if (type === 'number') return numeric(value,label);
 if (type === 'boolean') {if (typeof value !== 'boolean') throw Error('原生开关值类型不符：'+label);return value;}
 if (typeof value !== 'string') throw Error('原生文字值类型不符：'+label);
 return value;
};

export function nativeComfyFields(inspection,config) {
 if (!object(config) || !Array.isArray(config.fields) || config.fields.length > 1000) throw Error('请选择含fields列表的 Infinite Canvas .config.json');
 const inputs = new Map(inspection.nodes.flatMap(node => node.inputs.map(input => [randomFieldKey({nodeId:node.id,name:input.name}),{...input,nodeId:node.id}])));
 const ids = new Set(), targets = new Set(), fields = [];
 for (const field of config.fields) {
  if (!object(field) || typeof field.id !== 'string' || !field.id || field.id.length > 200 || ['__proto__','constructor','prototype'].includes(field.id) || ids.has(field.id)) throw Error('原生字段编号缺失、重复或过长');
  ids.add(field.id);
  const target = {nodeId:String(field.node ?? ''),name:field.input},key=randomFieldKey(target),input=inputs.get(key);
  if (!input || typeof target.name !== 'string' || targets.has(key)) throw Error('原生字段没有唯一的工作流输入：'+field.id);
  targets.add(key);
  const label = field.name || target.name;
  const type = field.type || 'text', mediaKind=['image','video','audio'].includes(type)?type:undefined;
  const control = {text:'text',textarea:'textarea',number:'number',slider:'slider',boolean:'switch',dropdown:'select',image:'text',video:'text',audio:'text'}[type];
  if (!control || (['number','slider'].includes(type) && input.type !== 'number') || (type==='boolean' && input.type!=='boolean') || (['text','textarea','image','video','audio'].includes(type) && input.type!=='string')) throw Error('原生控件与工作流类型不符：'+field.id);
  const defaultValue = field.default === undefined || field.default === null ? {number:0,boolean:false,string:''}[input.type] : converted(field.default,input.type,label);
  const out = {...target,nativeFieldId:field.id,control,label,help:'',exposed:true,defaultValue,...(mediaKind?{mediaKind}:{})};
  if (control==='select') {
   if (!Array.isArray(field.options)) throw Error('原生下拉选项无效：'+field.id);
   out.options=field.options.map(value=>converted(value,input.type,label));
  }
  if (['number','slider'].includes(control)) for (const name of ['min','max','step']) if (own(field,name)) {
   if (field[name] !== null && !Number.isFinite(field[name])) throw Error('原生范围与步长无效：'+field.id);
   out[name]=field[name];
  }
  if (own(field,'random_enabled') && typeof field.random_enabled!=='boolean') throw Error('原生随机能力须为开关：'+field.id);
  // Slider and all non-number fields stay fixed, as in the pinned source.
  if (type==='number' && field.random_enabled===true) out.randomEnabled=true;
  fields.push(out);
 }
 // The source displays only explicitly configured fields. Remaining inputs
 // retain their original defaults without becoming new visible/random fields.
 for (const [key,input] of inputs) if (!targets.has(key)) fields.push({nodeId:input.nodeId,name:input.name,control:{string:'textarea',number:'number',boolean:'switch'}[input.type],label:input.name,help:'',exposed:false,defaultValue:input.value});
 return fields;
}

export function nativeWorkflowSettings(node,engine) {
 const source=node?.params?.nativeCanvas?.node;
 if (!source) return null;
 if (source.type==='smart-image') {
  const settings=source.runSettings;
  return object(settings) && settings.engine===engine ? settings : null;
 }
 return engine==='comfy' && source.type==='comfy' ? source : engine==='runninghub' && source.type==='rh' ? source : null;
}

const nativeModelscopeSizes={
 square:{'1k':'1024x1024','2k':'2048x2048','4k':'4096x4096'},
 portrait:{'1k':'1024x1536','2k':'1360x2048','4k':'2352x3520'},
 portrait43:{'1k':'1008x1344','2k':'1536x2048','4k':'2448x3264'},
 landscape43:{'1k':'1344x1008','2k':'2048x1536','4k':'3264x2448'},
 landscape:{'1k':'1536x1024','2k':'2048x1360','4k':'3520x2352'},
 story:{'1k':'720x1280','2k':'1152x2048','4k':'2160x3840'},
 wide:{'1k':'1280x720','2k':'2048x1152','4k':'3840x2160'},
 ultrawide:{'1k':'1280x544','2k':'2048x880','4k':'3840x1648'},
 ultratall:{'1k':'544x1280','2k':'880x2048','4k':'1648x3840'}
};
const nativeModelscopeLongSide={'1k':1536,'2k':2048,'4k':3840};
const nativeModelscopePixelLimit={'1k':1572864,'2k':4194304,'4k':8294400};
const studioConfigKeys=new Set(['protocol','arkReferenceMode','imageResolution','loras','baseUrl','model','resolution','ratio','duration','generateAudio','quality','size','transparent','imageAsync','count','operation','unitPrice','currency','nativeModelscope','mjMode','mjSpeed','mjVersion','mjSize','mjTaskId','mjCustomId','mjIndex','mjZoom','mjDirection','mjMaskConvention']);
const privateConfigKey=/^(api[_-]?key|auth[_-]?(key|token)|access[_-]?token|token|authorization|password|secret|sig|signature|x-amz-(security-token|signature)|x-oss-security-token|x-goog-signature)$/i;
function publicConfigValue(value,depth=0){
 if(depth>50)return false;
 if(typeof value==='string'&&/^https?:\/\//i.test(value)){let url;try{url=new URL(value);}catch{return false;}if(url.username||url.password||[...url.searchParams.keys()].some(key=>privateConfigKey.test(key)))return false;}
 if(value&&typeof value==='object')return Object.entries(value).every(([key,child])=>!['__proto__','constructor','prototype'].includes(key)&&!privateConfigKey.test(key)&&publicConfigValue(child,depth+1));
 return value===null||scalar(value);
}
function publicStudioConfig(config,keys,issue){
 const result={};for(const [key,value]of Object.entries(object(config)?config:{}))if(keys.has(key)){
  if(publicConfigValue(value))result[key]=structuredClone(value);
  else issue('private-config','服务配置含不能迁移的私密或无效内容，请在运行授权中单独填写凭据');
 }return result;
}

export function nativeModelscopeParameters(node,serviceConfig={}){
 const settings=nativeWorkflowSettings(node,'modelscope');if(!settings)return null;
 const issues=[],unsupported=[];
 const issue=(key,message)=>{unsupported.push(key);issues.push(message);};
 const modelKey=settings.msgenModel||'zimage',known=['zimage','qwen_edit','klein_edit','custom'].includes(modelKey);
 if(!known)issue('model','原 ModelScope 模型类型尚未支持，不能猜测模型');
 if(own(settings,'msCustomModelId'))issue('msCustomModelId','固定原版使用 msCustomModel；msCustomModelId 未自动当作模型编号');
 const marker={version:1,modelKey:known?modelKey:'zimage',acceptsImages:known&&modelKey!=='zimage'},definition=nativeModelscopeModel(marker);
 let model=definition.modelId;
 if(modelKey==='custom'){
  model=typeof settings.msCustomModel==='string'?settings.msCustomModel.trim():'';
  if(!model||model.length>200||/[\u0000-\u001f\u007f]/.test(model))issue('custom-model','原自定义 ModelScope 模型编号缺失或无效，请明确选择模型');
 }
 const rawCount=Number(settings.count||1),count=Math.max(1,Math.min(8,rawCount));
 if(!Number.isInteger(rawCount)||rawCount<1||rawCount>8)issue('count','原 ModelScope 数量不是1–8的整数，原记录已保留，请核对');
 const ratio=settings.msRatio||'square',resolution=settings.msResolution||'1k';
 let size='';
 if(resolution==='custom'){
  const match=String(settings.msCustomSize||'').trim().match(/^(\d+)\s*[xX*]\s*(\d+)$/);
  if(match&&Number(match[1])>0&&Number(match[2])>0)size=Number(match[1])+'x'+Number(match[2]);
  else issue('custom-size','原 ModelScope 自定义尺寸未提供有效宽高，不能静默改为默认尺寸');
 }else if(!own(nativeModelscopeLongSide,resolution))issue('resolution','原 ModelScope 分辨率尚未支持，不能静默改为默认尺寸');
 else if(ratio==='custom'||ratio==='source'){
  const raw=String(settings.msCustomRatio||'').trim(),parts=raw.includes(':')?raw.split(':'):raw.split(/[xX*]/),w=Number(parts[0]),h=Number(parts[1]),parsed=parts.length===2&&w>0&&h>0&&Number.isFinite(w/h)?w/h:0;
  if(!parsed)issue('custom-ratio','原 ModelScope 自定义或原图比例缺失，不能猜测参考图尺寸');
  else{
   const longSide=nativeModelscopeLongSide[resolution],pixelLimit=nativeModelscopePixelLimit[resolution];
   const width=parsed>=1?longSide:Math.min(longSide*parsed,Math.sqrt(pixelLimit*parsed));
   const height=parsed>=1?Math.min(longSide/parsed,Math.sqrt(pixelLimit/parsed)):longSide;
   size=Math.max(64,Math.floor(width/16)*16)+'x'+Math.max(64,Math.floor(height/16)*16);
  }
 }else if(own(nativeModelscopeSizes,ratio))size=nativeModelscopeSizes[ratio][resolution];
 else issue('ratio','原 ModelScope 画幅尚未支持，不能静默改为正方形');
 if(size)try{normalizeNativeModelscopeSize(size);}catch(error){issue('size',error.message);}
 // Only an explicitly selected service and pricing may be carried forward.
 // The pinned app's private endpoints and model-list fallback are not portable.
 const existing=object(node.params?.studioBinding),service=existing?{}:publicStudioConfig(serviceConfig,new Set(['baseUrl','unitPrice','currency']),issue);
 const config=existing?publicStudioConfig(node.params.studioBinding.config,studioConfigKeys,issue):{...service,protocol:'modelscope',model,size,count,imageAsync:true,quality:'auto',transparent:false,loras:{},nativeModelscope:marker};
 return{engine:'modelscope',config,alreadyConfigured:existing,mayFill:!existing,issues,unsupported,requiresImages:definition.requiresImages,maxReferences:definition.acceptsImages?20:0,sourceCount:scalar(settings.count)?settings.count:1,sourceSize:{ratio:typeof ratio==='string'?ratio:'',resolution:typeof resolution==='string'?resolution:'',customRatio:typeof settings.msCustomRatio==='string'?settings.msCustomRatio:'',customSize:typeof settings.msCustomSize==='string'?settings.msCustomSize:''}};
}

export function nativeComfyParameters(node,template) {
 const settings=nativeWorkflowSettings(node,'comfy');if (!settings) return null;
 const values=dictionary(settings.comfyParams ?? settings.comfy_params,'ComfyUI参数'),active=dictionary(settings.comfyRandomActive,'ComfyUI随机开关');
 const fields=template.fields||[],aliases=new Map(fields.filter(field=>field.nativeFieldId).map(field=>[field.nativeFieldId,field]));
 const issues=[],overrides=[],randomFields=[],skippedMedia=[];
 for (const id of new Set([...Object.keys(values),...Object.keys(active)])) {
  const field=aliases.get(id);
  if (!field) {issues.push('原字段编号尚未映射：'+id);continue;}
  if (field.exposed===false) issues.push('原字段在当前模板中已隐藏：'+id);
  if (own(active,id) && typeof active[id]!=='boolean') issues.push('原随机开关无效：'+id);
  if (own(active,id) && active[id]!==false && (!field.randomEnabled || field.control!=='number')) issues.push('原随机能力与模板不符：'+id);
 }
 for (const field of fields.filter(field=>field.nativeFieldId && field.exposed!==false)) {
  const id=field.nativeFieldId;
  if (field.mediaKind && field.mediaKind!=='none') {if (own(values,id)) skippedMedia.push({id,nodeId:field.nodeId,name:field.name});continue;}
  if (own(values,id) || node.params.nativeCanvas.node.type==='smart-image') {
   try {
    let value=converted(own(values,id)?values[id]:field.defaultValue,typeof field.defaultValue,field.label);
    // The pinned smart canvas rounds integer controls before constructing params.
    if(node.params.nativeCanvas.node.type==='smart-image' && ['number','slider'].includes(field.control) && !(field.step && Number(field.step)<1))value=Math.round(value);
    overrides.push({nodeId:field.nodeId,name:field.name,value});
   }catch(error){issues.push(error.message);}
  }
  if (field.randomEnabled && field.control==='number' && active[id]!==false) randomFields.push({nodeId:field.nodeId,name:field.name});
 }
 if (!aliases.size && (Object.keys(values).length||Object.keys(active).length)) issues.push('请先导入对应 .config.json，不能猜测原字段编号');
 return {engine:'comfy',issues,overrides,randomFields,skippedMedia,sourceWorkflow:settings.comfyWorkflow||'',mappedFields:aliases.size};
}

export function nativeRhParameters(node,recipe) {
 const settings=nativeWorkflowSettings(node,'runninghub');if (!settings || recipe.kind==='model' || recipe.minimaxProfile==='h3') return null;
 const values=dictionary(settings.rhParams,'RunningHub参数'),active=dictionary(settings.rhRandomActive,'RunningHub随机开关');
 const byKey=new Map(recipe.fields.map(field=>[`${field.nodeId}::${field.fieldName}`,field]));
 const issues=[],overrides=[],randomFields=[],skippedMedia=[];
 for (const key of new Set([...Object.keys(values),...Object.keys(active)])) {
  const field=byKey.get(key);
  if (!field) {issues.push('原云字段尚未映射：'+key);continue;}
  if (own(active,key) && typeof active[key]!=='boolean') issues.push('原云随机开关无效：'+key);
  if (own(active,key) && active[key]!==false && (!field.randomEnabled || field.type!=='number')) issues.push('原云随机能力与配置不符：'+key);
  if (['image','video','audio'].includes(field.type) || field.source!=='value') {if (own(values,key)) skippedMedia.push({id:key,nodeId:field.nodeId,name:field.fieldName});continue;}
  if (own(values,key)) {
   const parameter=values[key];
   if (!object(parameter) || !own(parameter,'value')) {issues.push('原云字段缺少value：'+key);continue;}
   try {
    let value=parameter.value;
    if (field.type==='number') value=numeric(value,field.label);
    else if (field.type==='boolean') {if (![true,false,'true','false'].includes(value)) throw Error('原云开关值无效：'+key);value=value===true||value==='true';}
    else if (!scalar(value)) throw Error('原云字段值类型无效：'+key);
    overrides.push({nodeId:field.nodeId,fieldName:field.fieldName,fieldValue:value});
   }catch(error){issues.push(error.message);}
  }
 }
 for (const field of recipe.fields) if (field.randomEnabled && field.type==='number' && field.source==='value' && active[`${field.nodeId}::${field.fieldName}`]!==false) randomFields.push({nodeId:field.nodeId,name:field.fieldName});
 return {engine:'runninghub',issues,overrides,randomFields,skippedMedia,mappedFields:byKey.size};
}

export function nativeRhFields(config) {
 const fields=Array.isArray(config)?config:config?.fields??config?.nodeInfoList;
 if (!Array.isArray(fields) || fields.length>200) throw Error('请选择含fields或nodeInfoList的 RunningHub字段配置');
 return fields.map(field=>{
  if (!object(field)) throw Error('原生云字段无效');
  const kind=String(field.fieldType||'').toUpperCase(),type={NUMBER:'number',FLOAT:'number',INTEGER:'number',INT:'number',SLIDER:'number',BOOLEAN:'boolean',BOOL:'boolean',IMAGE:'image',VIDEO:'video',AUDIO:'audio',LIST:'select',SELECT:'select',DROPDOWN:'select',COMBO:'select',TEXT:'text',STRING:'text'}[kind]||field.type;
  if (!['text','number','boolean','select','image','video','audio'].includes(type)) throw Error('原生云字段类型未识别：'+field.fieldName);
  if (own(field,'random_enabled') && typeof field.random_enabled!=='boolean') throw Error('原云随机能力须为开关：'+field.fieldName);
  let value=Array.isArray(field.fieldValue)?field.fieldValue[0]:field.fieldValue;
  if (type==='number') value=numeric(value,field.fieldName);
  else if (type==='boolean') {if (![true,false,'true','false'].includes(value)) throw Error('原云开关默认值无效');value=value===true||value==='true';}
  if (!scalar(value)) throw Error('原云字段默认值无效：'+field.fieldName);
  let options=field.options;
  if(options===undefined && type==='select' && field.fieldData!==undefined){
   let data;try{data=typeof field.fieldData==='string'?JSON.parse(field.fieldData):field.fieldData;}catch{throw Error('原云下拉选项JSON无效');}
   if(!Array.isArray(data)||data.some(item=>!object(item)||!scalar(item.index)))throw Error('原云下拉选项缺少index');
   options=data.map(item=>String(item.index));
  }
  const out={nodeId:String(field.nodeId??''),fieldName:field.fieldName,fieldValue:value,type,source:'value',label:field.label||field.description||field.fieldName,options:options||[],...(field.nodeClass?{nodeClass:field.nodeClass}:{})};
  if (kind!=='SLIDER' && type==='number' && field.random_enabled===true) out.randomEnabled=true;
  if (type==='number') for (const key of ['min','max','step']) if (own(field,key)) {
   if (field[key]!==null && !Number.isFinite(field[key])) throw Error('原云随机范围无效');
   if (key!=='step' || field[key]!==null) out[key]=Number(field[key]);
  }
  return out;
 });
}

export function nativeParameterMarkup(plan,esc) {
 if (!plan) return '';
 return `<section class="native-parameter-preview"><strong>原生字段参数</strong>${plan.issues.length?`<p role="alert">${plan.issues.map(esc).join('；')}。原记录保留，请先补齐字段映射。</p>`:`<p>已匹配${plan.mappedFields}个字段；${plan.overrides.length}个原值，${plan.randomFields.length}个每次随机。只填入当前表单，保存绑定后生效。</p>`}${plan.skippedMedia.length?'<p>原媒体文件标识未自动当作本机素材；请在字段中选择相应来源。</p>':''}<details><summary>查看字段映射</summary><pre>${esc(JSON.stringify({fixedValues:plan.overrides,randomFields:plan.randomFields,mediaToReview:plan.skippedMedia},null,2))}</pre></details></section>`;
}
