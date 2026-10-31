import {loadLoraReceipt,scanReadOnlyLoraReceipts} from './lora-receipt-store.mjs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson,readJson,records,safeId,userError,assertNoCredentials,textValue} from './workspace.mjs';
import {safeApiCall,validateSignedDestination} from './image-api.mjs';
import {rhBase} from './runninghub.mjs';
import {verifyLoraAsset,importLoraFile,LORA_MIME} from './lora-files.mjs';
import {putSignedFile} from './signed-upload.mjs';
const id=x=>{if(!safeId(x))throw userError('LoRA 编号无效');return x;},stamp=()=>new Date().toISOString();
export function loraFileName(s){if(typeof s!=='string'||s.length>400||!s.endsWith('.safetensors')||!s.split('/').every(x=>/^[\w.-]+$/.test(x)&&x!=='.'&&x!=='..'))throw userError('平台返回的 LoRA 文件标识无效');return s;}
export function loraReceipt(j){
 if(j?.kind!=='lora-upload'||j.status!=='completed'||!safeId(j.id)||!safeId(j.assetId)||!Number.isSafeInteger(j.size)||j.size<10||!/^[a-f0-9]{64}$/.test(j.sha256)||!/^[a-f0-9]{32}$/.test(j.md5Hex))throw userError('LoRA 上传记录尚未成功或格式无效');
 const receipt={id:j.id,kind:'lora-upload',status:'completed',assetId:j.assetId,size:j.size,sha256:j.sha256,md5Hex:j.md5Hex,baseUrl:rhBase(j.baseUrl),fileName:loraFileName(j.fileName),name:textValue(j.name,200,'LoRA 名称'),createdAt:String(j.createdAt||'').slice(0,40),completedAt:String(j.completedAt||'').slice(0,40),uploadCount:1};assertNoCredentials(receipt);return receipt;
}
export async function resolveRhLoras({data,project,recipe}){
 const verified=new Map();for(const f of recipe.fields.filter(f=>f.source==='lora')){
  if(recipe.kind==='model'||f.nodeClass!=='RHLoraLoader'||f.type!=='text'||!safeId(f.receiptId)||!safeId(f.assetId))throw userError('上传的 LoRA 只能绑定 RHLoraLoader 的文字字段');
  let receipt,raw;try{raw=(await loadLoraReceipt(data,f.receiptId)).record;receipt=loraReceipt(raw);}catch{throw userError('没有成功的 LoRA 上传记录，请到 LoRA 文件页检查');}
  if(raw.projectId!==project.id||receipt.assetId!==f.assetId||receipt.baseUrl!==recipe.baseUrl||!project.assets.some(a=>a.id===f.assetId))throw userError('LoRA 上传记录的项目、文件或平台与当前配置不一致');
  let a=verified.get(f.assetId);if(!a){a=await verifyLoraAsset(data,f.assetId);verified.set(f.assetId,a);}if(receipt.sha256!==a.lora.sha256||receipt.md5Hex!==a.lora.md5Hex||receipt.size!==a.size)throw userError('LoRA 上传记录与本机文件不一致');f.fieldValue=receipt.fileName;
 }return recipe;
}
export function runningHubLoraService({data,projects,activeJobs,planTtlMs=300000}){
 const plans=new Map(),locks=new Map(),file=key=>path.join(data,'jobs',id(key)+'.json');
 async function locked(key,fn){const previous=locks.get(key)||Promise.resolve(),task=previous.catch(()=>{}).then(fn);locks.set(key,task);try{return await task;}finally{if(locks.get(key)===task)locks.delete(key);}}
 async function get(key){const {record:j,readOnly}=await loadLoraReceipt(data,key);if(j.kind!=='lora-upload')throw userError('不是 LoRA 上传记录');if(j.status==='awaiting-confirmation'&&!activeJobs.has(key)&&(!plans.has(key)||Date.now()>=Date.parse(j.expiresAt))){plans.delete(key);j.status='expired';j.message='临时上传地址已失效，文件未发送。重新准备需再次确认。';await atomicJson(file(key),j);}return{...j,...(readOnly?{readOnly:true,canResume:false,canApply:false}:{}),...(activeJobs.get(key)?.bytesSent!==undefined?{bytesSent:activeJobs.get(key).bytesSent}:{})};}
 async function list(projectId){await projects.load(id(projectId));const items=[...(await records(path.join(data,'jobs'))),...(await scanReadOnlyLoraReceipts(data)).records].filter(j=>j.kind==='lora-upload'&&j.projectId===projectId);return Promise.all(items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(j=>get(j.id)));}
 async function localFiles(projectId){await projects.load(id(projectId));return(await records(path.join(data,'assets'))).filter(a=>a.type===LORA_MIME).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
 async function attach(assetId,b){const a=await verifyLoraAsset(data,id(assetId));return projects.attach(id(b.projectId),a,b.revision);}
 async function prepare(b){return locked('prepare-'+id(b.requestId),async()=>{
  const project=await projects.load(id(b.projectId)),previous=(await list(project.id)).find(j=>j.requestId===b.requestId);if(previous)return previous;
  const baseUrl=rhBase(b.baseUrl),a=await verifyLoraAsset(data,id(b.assetId));if(!project.assets.some(x=>x.id===a.id))throw userError('先将 LoRA 文件加入当前项目');const name=textValue(b.loraName,120,'平台 LoRA 名称');assertNoCredentials({name});
  const auth=b.authorization;if(!auth||auth.origin!==baseUrl||auth.assetId!==a.id||auth.md5Hex!==a.lora.md5Hex||auth.size!==a.size||auth.loraName!==name||auth.metadataOnly!==true||auth.requestLimit!==1)throw userError('请确认向此平台发送 LoRA 名称、大小和校验值以取得上传地址');
  let key=b.apiKey;if(typeof key!=='string'||!key.trim()||key.length>4096||/[\r\n]/.test(key))throw userError('请输入本次 RunningHub API Key');key=key.trim();if(JSON.stringify({name,baseUrl,asset:a,requestId:b.requestId,projectId:b.projectId}).includes(key))throw userError('LoRA 名称或文件记录包含本次密钥');
  const j={id:randomUUID(),kind:'lora-upload',projectId:project.id,requestId:b.requestId,name,assetId:a.id,size:a.size,...a.lora,baseUrl,createdAt:stamp(),status:'preparing',message:'正在取得上传地址，尚未发送文件',requestCount:1,uploadCount:0,bytesSent:0,assets:[],authorization:{origin:baseUrl,assetId:a.id,md5Hex:a.lora.md5Hex,size:a.size,loraName:name,metadataOnly:true,requestLimit:1}},controller=new AbortController();
  await atomicJson(file(j.id),j);activeJobs.set(j.id,{kind:j.kind,projectId:j.projectId,controller});
  try{const result=await safeApiCall({baseUrl,apiKey:key,path:'api/openapi/getLoraUploadUrl',method:'POST',body:{apiKey:key,loraName:name,md5Hex:a.lora.md5Hex},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
   if(result?.code!==0||typeof result.data?.url!=='string'||result.data.url.length>20000||JSON.stringify(result.data).includes(key))throw userError('平台未返回可用的 LoRA 上传地址，请核对权限和文件信息');const remoteName=loraFileName(result.data.fileName),destination=await validateSignedDestination(result.data.url,baseUrl);
   j.fileName=remoteName;j.storageOrigin=destination.url.origin;j.expiresAt=new Date(Date.now()+planTtlMs).toISOString();j.status='awaiting-confirmation';j.message='上传地址已准备，请核对存储服务地址后确认发送文件';plans.set(j.id,result.data.url);setTimeout(()=>plans.delete(j.id),planTtlMs).unref();
  }catch(e){j.status='failed';j.message=e.publicMessage||'获取上传地址失败，文件尚未发送；不会自动再次查询';j.uncertain=false;}
  finally{key='';b.apiKey='';activeJobs.delete(j.id);await atomicJson(file(j.id),j);}return structuredClone(j);
 });}
 async function confirm(key,b){return locked('upload-'+id(key),async()=>{
  const j=await get(key);if(j.uploadCount>0)return j;if(j.status!=='awaiting-confirmation'||!plans.has(key))throw userError('上传地址不可用，请重新准备并确认');
  const a=await verifyLoraAsset(data,j.assetId),project=await projects.load(j.projectId);if(!project.assets.some(x=>x.id===a.id)||a.lora.sha256!==j.sha256||a.size!==j.size)throw userError('文件或项目关联已变化，请重新准备');const auth=b.authorization;
  if(!auth||auth.storageOrigin!==j.storageOrigin||auth.origin!==j.baseUrl||auth.assetId!==j.assetId||auth.sha256!==j.sha256||auth.size!==j.size||auth.uploadLimit!==1||auth.sendFile!==true)throw userError('请确认准确的存储地址、文件与一次上传范围');
  if([...activeJobs.values()].some(x=>x.projectId===j.projectId))throw userError('当前项目仍有任务执行，请稍后上传',409);
  // Check again after hashing a large file. An expired plan never sends bytes.
  if(Date.now()>=Date.parse(j.expiresAt))throw userError('上传地址已过期，请重新准备');const url=plans.get(key);const controller=new AbortController(),active={controller,projectId:j.projectId,kind:'lora-upload',bytesSent:0};activeJobs.set(key,active);plans.delete(key);j.status='running';j.uploadCount=1;j.message='正在发送已确认的 LoRA 文件';j.uploadAuthorization={origin:j.baseUrl,storageOrigin:j.storageOrigin,assetId:j.assetId,size:j.size,sha256:j.sha256,uploadLimit:1,sendFile:true};try{await atomicJson(file(key),j);}catch(e){activeJobs.delete(key);throw e;}
  void(async()=>{try{await putSignedFile({url,baseUrl:j.baseUrl,file:path.join(data,'assets',a.id),size:a.size,sha256:j.sha256,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(1800000)]),onProgress:n=>{active.bytesSent=n;}});j.status='completed';j.completedAt=stamp();j.uncertain=false;j.message='存储服务已确认上传，可选入 RHLoraLoader 字段；实际模型兼容性仍由生成验证';}
   catch{j.status=controller.signal.aborted?'cancelled':'failed';j.uncertain=true;j.message='上传未取得成功确认，请先核对平台文件记录；不会自动重复发送';}
   finally{j.bytesSent=active.bytesSent;try{await atomicJson(file(key),j);}finally{activeJobs.delete(key);}}})().catch(()=>{});return structuredClone(j);
 });}
 async function recover(){for(const j of await records(path.join(data,'jobs')))if(j.kind==='lora-upload'&&['preparing','awaiting-confirmation','running','queued','interrupted'].includes(j.status)){j.status=j.uploadCount?'interrupted':'expired';j.uncertain=j.uploadCount>0;j.message=j.uploadCount?'服务重启，上传结果未确认；请核对平台文件记录，不会自动重传':'临时上传地址已清除，文件未发送。请重新准备并确认。';await atomicJson(file(j.id),j);}}
 return {list,get,localFiles,attach,prepare,confirm,recover,importFile:(stream,b)=>importLoraFile(data,stream,b)};
}
