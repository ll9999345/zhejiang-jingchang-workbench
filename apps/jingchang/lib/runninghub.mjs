import {safeApiCall,validateApiBaseUrl,parseImageData,downloadApiVideo,downloadApiAudio,downloadApiText,downloadApiGlb,ImageApiError} from './image-api.mjs';
import {userError} from './workspace.mjs';
import {validateInputImage} from './providers.mjs';
import {applyRhWorkflowFields,normalizeRhWorkflow} from './rh-workflow.mjs';
export const rhId=value=>{if(typeof value!=='string'||!/^\d{1,30}$/.test(value))throw userError('RunningHub 编号须为数字字符串');return value;};
const secretField=s=>/(api.?key|password|secret|authorization|credential|access.?token)/i.test(s);
const scalar=x=>['string','boolean'].includes(typeof x)||typeof x==='number'&&Number.isFinite(x);
export function rhBase(value){const base=validateApiBaseUrl(value);if(new URL(base).pathname!=='/')throw userError('RunningHub 地址只填站点根地址，不要添加 /v1 或接口路径');return base;}
export function normalizeRhFields(fields){
 if(!Array.isArray(fields)||fields.length>200)throw userError('工作流字段最多200项');const seen=new Set();
 return fields.map(f=>{const nodeId=String(f.nodeId||''),fieldName=String(f.fieldName||'');if(!/^[\w-]{1,100}$/.test(nodeId)||!/^[-\w.]{1,100}$/.test(fieldName)||secretField(fieldName))throw userError('字段编号或名称无效，不能配置密钥字段');const id=nodeId+':'+fieldName;if(seen.has(id))throw userError('工作流字段重复');seen.add(id);
  if(!scalar(f.fieldValue)||String(f.fieldValue).length>20000)throw userError('字段值只支持文字、数字或开关，最多20000字');
  const type=['text','number','boolean','select','image','video','audio'].includes(f.type)?f.type:'text';
  if(type==='number'&&(!Number.isFinite(Number(f.fieldValue))||String(f.fieldValue).trim()===''))throw userError('数字字段无效');
  const options=Array.isArray(f.options)?f.options.slice(0,200).filter(scalar).map(String):[];
  if(type==='select'&&(!options.length||!options.includes(String(f.fieldValue))))throw userError('下拉字段须选择平台提供的值');
  const source=['asset','lora'].includes(f.source)?f.source:'value',nodeClass=typeof f.nodeClass==='string'?f.nodeClass.slice(0,120):'';
  if(source==='lora'&&(nodeClass!=='RHLoraLoader'||type!=='text'||!/^[-\w]{1,100}$/.test(f.assetId||'')||!/^[-\w]{1,100}$/.test(f.receiptId||'')))throw userError('LoRA 须选择成功上传记录，并绑定 RHLoraLoader 文字字段');
  if(source==='asset'&&(!['image','video','audio'].includes(type)||typeof f.assetId!=='string'||!/^[\w-]{1,100}$/.test(f.assetId)))throw userError('素材字段映射无效');
  const random={};if(Object.hasOwn(f,'randomEnabled')){if(typeof f.randomEnabled!=='boolean'||f.randomEnabled&&(type!=='number'||source!=='value'))throw userError('随机只用于普通工作流的数字值字段');if(f.randomEnabled)random.randomEnabled=true;}
  if(Object.hasOwn(f,'randomActive')){if(typeof f.randomActive!=='boolean'||!random.randomEnabled)throw userError('请先允许该数字字段随机');random.randomActive=f.randomActive;}
  if(type==='number')for(const key of ['min','max','step'])if(f[key]!==undefined){if(!Number.isFinite(f[key])||key==='step'&&f[key]<=0)throw userError('随机数范围和步长须为有限数字，步长大于0');random[key]=f[key];}
  return {nodeId,fieldName,fieldValue:type==='number'?Number(f.fieldValue):type==='boolean'?f.fieldValue===true||f.fieldValue==='true':f.fieldValue,type,label:String(f.label||fieldName).slice(0,120),options,source,...random,...(f.required===true?{required:true}:{}),...(nodeClass?{nodeClass}:{}),...(['asset','lora'].includes(source)?{assetId:f.assetId}:{}),...(source==='lora'?{receiptId:f.receiptId}:{})};
 });
}
function checked(result){if(result?.code!==0)throw new ImageApiError('rh_rejected','RunningHub 拒绝了请求，请核对编号、密钥权限和平台记录',{uncertain:false});return result.data;}
const scrub=(s,key)=>typeof s==='string'&&key?s.split(key).join('[已隐藏]'):s;
export async function discoverRh({baseUrl,apiKey,kind,targetId,includeWorkflow=false,signal}){
 const base=rhBase(baseUrl);rhId(targetId);let fields,workflowJson;if(includeWorkflow&&kind!=='workflow')throw userError('仅工作流支持拉取 API 整图');
 if(kind==='app'){
  const data=checked(await safeApiCall({baseUrl:base,apiKey,path:'api/webapp/apiCallDemo',runningHubAppId:targetId,signal}));
  if(!Array.isArray(data?.nodeInfoList))throw userError('应用没有返回可用字段，请核对应用编号；不执行平台返回的示例代码');
  fields=data.nodeInfoList.map(f=>{let fd;try{fd=JSON.parse(f.fieldData||'null');}catch{}const options=Array.isArray(fd)?fd.filter(x=>x&&typeof x==='object'&&scalar(x.index)).map(x=>String(x.index)):[];
   const type={IMAGE:'image',VIDEO:'video',AUDIO:'audio',INT:'number',FLOAT:'number',BOOLEAN:'boolean',LIST:'select'}[f.fieldType]||'text';
   return {...f,fieldValue:scrub(scalar(f.fieldValue)?f.fieldValue:'',apiKey),type,options:options.map(x=>scrub(x,apiKey)),label:scrub(f.description||f.fieldName,apiKey)};
  });
 }else if(kind==='workflow'){
  const data=checked(await safeApiCall({baseUrl:base,apiKey,path:'api/openapi/getJsonApiFormat',method:'POST',body:{apiKey,workflowId:targetId},signal}));
  let graph;try{graph=typeof data?.prompt==='string'?JSON.parse(data.prompt):data?.prompt;}catch{throw userError('平台工作流 JSON 无效');}
  if(!graph||typeof graph!=='object'||Array.isArray(graph)||Object.keys(graph).length>1000)throw userError('平台工作流结构无效');
  if(includeWorkflow){workflowJson=normalizeRhWorkflow(graph);if(apiKey&&JSON.stringify(workflowJson).includes(apiKey))throw userError('平台工作流包含本次密钥，不能保存整图');}
  fields=Object.entries(graph).flatMap(([nodeId,node])=>Object.entries(node.inputs||{}).filter(([name,value])=>!secretField(name)&&scalar(value)).map(([fieldName,fieldValue])=>({nodeId,fieldName,nodeClass:scrub(node.class_type,apiKey),fieldValue:scrub(fieldValue,apiKey),type:/LoadImage|LoadImageMask/.test(node.class_type)&&fieldName==='image'?'image':/LoadVideo/.test(node.class_type)&&['file','video'].includes(fieldName)?'video':/LoadAudio/.test(node.class_type)&&fieldName==='audio'?'audio':typeof fieldValue==='number'?'number':typeof fieldValue==='boolean'?'boolean':'text',label:scrub(`${node._meta?.title||node.class_type||nodeId} · ${fieldName}`,apiKey)})));
 }else throw userError('请选择应用或工作流');
 return {fields:normalizeRhFields(fields),...(workflowJson?{workflowJson}:{})};
}
export function checkRhMedia(bytes,mime){
 if(bytes.length===0||bytes.length>30*1024*1024)throw userError('RunningHub 输入素材须为1字节至30MB');
 if(mime.startsWith('image/'))return validateInputImage({bytes,mime,name:'input.'+({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[mime]||'invalid')});
 const video=['video/mp4','video/quicktime'].includes(mime)&&bytes.toString('ascii',4,8)==='ftyp';
 const audio=mime==='audio/wav'&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE'||mime==='audio/flac'&&bytes.toString('ascii',0,4)==='fLaC'||mime==='audio/mpeg'&&(bytes.toString('ascii',0,3)==='ID3'||bytes.length>=2&&bytes[0]===255&&(bytes[1]&224)===224);
 if(!video&&!audio)throw userError('素材内容与支持的 PNG/JPEG/WebP、MP4/MOV、MP3/WAV/FLAC 格式不符');return {bytes,mime,name:'input.'+({'video/mp4':'mp4','video/quicktime':'mov','audio/wav':'wav','audio/flac':'flac','audio/mpeg':'mp3'}[mime])};
}
export async function uploadRh({baseUrl,apiKey,bytes,mime,signal}){
 const media=checkRhMedia(bytes,mime),form=new FormData();form.append('apiKey',apiKey);form.append('fileType','input');form.append('file',new Blob([media.bytes],{type:mime}),media.name);
 const d=checked(await safeApiCall({baseUrl:rhBase(baseUrl),apiKey,path:'task/openapi/upload',method:'POST',body:form,signal}));
 if(typeof d?.fileName!=='string'||d.fileName.length>300||!d.fileName.split('/').every(p=>/^[\w.-]+$/.test(p)&&p!=='.'&&p!=='..')||apiKey&&d.fileName.includes(apiKey))throw userError('平台返回的上传文件标识无效');return d.fileName;
}
export async function submitRh({baseUrl,apiKey,kind,targetId,fields,workflowJson,signal}){
 if(workflowJson!==undefined&&kind!=='workflow')throw userError('整图提交仅用于 RunningHub 工作流');
 const nodeInfoList=fields.map(f=>({nodeId:f.nodeId,fieldName:f.fieldName,fieldValue:String(f.fieldValue)}));
 const workflow=workflowJson===undefined?null:applyRhWorkflowFields(workflowJson,fields);if(workflow&&apiKey&&JSON.stringify(workflow).includes(apiKey))throw userError('工作流内容包含本次密钥');
 const d=checked(await safeApiCall({baseUrl:rhBase(baseUrl),apiKey,path:kind==='app'?'task/openapi/ai-app/run':'task/openapi/create',method:'POST',body:{apiKey,[kind==='app'?'webappId':'workflowId']:rhId(targetId),nodeInfoList,...(workflow?{workflow:JSON.stringify(workflow),addMetadata:true}:{})},signal}));
 if(typeof d?.taskId!=='string'||!/^\d{1,30}$/.test(d.taskId))throw new ImageApiError('invalid_response','RunningHub 未返回有效任务编号，请核对平台记录，不自动重发',{uncertain:true});return d.taskId;
}
export async function queryRh({baseUrl,apiKey,taskId,signal}){
 const d=await safeApiCall({baseUrl:rhBase(baseUrl),apiKey,path:'openapi/v2/query',method:'POST',body:{taskId:rhId(taskId)},signal});
 if(d.taskId!==taskId)throw userError('RunningHub 查询结果不是原任务');
 if(d.status==='FAILED'||d.status==='CANCELED'||d.status==='CANCELLED')return {status:'failed'};
 if(['QUEUED','RUNNING','PENDING'].includes(d.status))return {status:'running'};
 if(d.status!=='SUCCESS'||!Array.isArray(d.results)||!d.results.length||d.results.length>32)throw userError('RunningHub 结果状态或数量无效，请核对原任务');
 if(d.results.some(r=>!r||typeof r!=='object'||Array.isArray(r)))throw userError('平台结果格式无效');
 const results=d.results.map(r=>{const type=String(r.outputType||'').toLowerCase(),url=r.url;if(type==='string'){
   if(r.text!==undefined&&r.text!==null&&(typeof r.text!=='string'||r.text.length>200_000||!r.text.trim()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(r.text)||apiKey&&r.text.includes(apiKey)))throw userError('RunningHub 文字结果为空、过长或无效');
   if(typeof r.text==='string')return {type,text:r.text};
   if(typeof url!=='string'||url.length>16000||apiKey&&url.includes(apiKey))throw userError('RunningHub 文字结果链接无效');
   return {type,url};
  }
  if(typeof url!=='string'||url.length>16000||apiKey&&url.includes(apiKey))throw userError('平台结果链接无效');
  return {url,type};
 });
 return {status:'completed',results};
}
export async function downloadRh(result,{baseUrl,signal,apiKey}){
 if(result.type==='string'){
  const output=typeof result.text==='string'?{bytes:Buffer.from(result.text,'utf8'),mime:'text/plain',fileName:'result.txt',text:result.text}:await downloadApiText(result.url,{baseUrl,signal});
  if(apiKey&&output.text.includes(apiKey))throw userError('RunningHub 文字结果包含本次密钥，已阻止保存');
  return output;
 }
 if(['3d','glb'].includes(result.type))return downloadApiGlb(result.url,{baseUrl,signal,apiKey});
 if(['png','jpg','jpeg','webp'].includes(result.type)){const [a]=await parseImageData({data:[{url:result.url}]},{baseUrl,signal});return a;}
 if(['mp4','mov'].includes(result.type))return downloadApiVideo(result.url,{baseUrl,signal});
 if(['mp3','wav','flac'].includes(result.type))return downloadApiAudio(result.url,{baseUrl,signal});
 throw userError('RunningHub 输出格式暂不支持，请在平台下载；不丢弃其他已保存结果');
}
