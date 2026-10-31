import {isJimengStudio,jimengStudioRequest} from '../public/jimeng-studio-core.js';
import {normalizeJimengStudio,jimengStudioAdapter} from './jimeng-studio.mjs';
import {isApimartMultimodal} from '../public/apimart-reference-core.js';
import {studioImageReferenceLimit,studioAudioReferenceLimit,studioReferenceLimit} from '../public/reference-limits.js';
import {isArkMultimodal} from '../public/ark-reference-core.js';
import {mjPromptOptional,normalizeMidjourneyConfig,validateMidjourneyRequest} from '../public/midjourney-core.js';
import {submitMidjourney,queryMidjourney} from './midjourney.mjs';
import {normalizeStudioUrlReference,assertArkReferences,prepareArkReferences} from './ark-references.mjs';
import {localArkCredentialService,normalizeStudioCredential,resolveStudioCredential} from './ark-credentials.mjs';
import {localMiaoCredentialService} from './miao-credentials.mjs';
import {studioModelChoices} from '../public/studio-model-catalog-core.js';
import {studioModelContract,STUDIO_SERVICE_BUILD} from '../public/studio-service-core.js';
import {isLocalMiaoTarget} from '../public/miao-credential-core.js';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {atomicJson,readJson,records,safeId,textValue,userError,loadAsset,storeAsset,assertNoCredentials} from './workspace.mjs';
import {validateApiBaseUrl,listImageModels,parseImageData,assertImageRequestSize} from './image-api.mjs';
import {submitModelScope,queryModelScope,submitArk,queryArk,downloadArk,normalizeLoras} from './native-protocols.mjs';
import {validateExtendedStudio,generateGeminiImages,listGeminiModels,submitApimart,queryApimart} from './extended-protocols.mjs';
import {uploadReference,submitVideo,queryVideo,downloadVideo,cancelVideo,generateStudioImages,submitImageTask,queryImageTask} from './studio-protocol.mjs';
import {normalizeNativeModelscopeConfig,normalizeNativeModelscopeSize,nativeModelscopeModel,studioRequestCount,studioModelscopeReferenceLimit} from '../public/native-modelscope-core.js';
import {isNativeModelscopeJob,nativeModelscopeHasOriginalIds,validateNativeModelscopeBatch,runNativeModelscopeBatch} from './native-modelscope-batch.mjs';

export const studioModels={video:['seedance-2.0','seedance-2.0-fast','seedance-2.0-mini','happy-horse-1.1','grok-imagine-1.5','ltx-2.3-pro','ltx-2.3-fast'],image:['gpt-image-2','gpt-image-1.5','gpt-image-1','dall-e-3']};
const nodeIds=['prompt','references','config','generate','output'];
const defaults={protocol:'studio',arkReferenceMode:'frames',imageResolution:'1k',loras:{},baseUrl:'',model:'seedance-2.0',resolution:'720p',ratio:'16:9',duration:4,generateAudio:false,quality:'auto',size:'1024x1024',transparent:false,imageAsync:false,count:1,operation:'generate',unitPrice:0,currency:'CNY'};
const stopStates=['completed','failed','cancelled'];
function safeCatalogResult(result,apiKey){
  const containsSecret=value=>typeof value==='string'?!!apiKey&&value.includes(apiKey):!!value&&typeof value==='object'&&Object.entries(value).some(([key,item])=>containsSecret(key)||containsSecret(item));
  const original=Array.isArray(result)?result:result?.models||[];
  const models=original.filter(model=>!containsSecret(model));
  const note=typeof result?.note==='string'?(apiKey?result.note.replaceAll(apiKey,'[已隐藏]'):result.note):'';
  return {models,...(note?{note}:{}),...(result?.partial?{partial:true}:{})};
}
function requireId(id){if(!safeId(id))throw userError('编号无效');return id;}
export function normalizeStudio(input){
  if(!input||!['image','video'].includes(input.mode))throw userError('请选择图片或视频模式');
  if(isJimengStudio(input))return normalizeJimengStudio(input);
  const c=input.config||{}, config={...defaults};
  config.baseUrl=c.baseUrl?validateApiBaseUrl(c.baseUrl):'';
  config.protocol=c.protocol||'studio';if(!['studio','modelscope','ark','gemini','apimart','midjourney'].includes(config.protocol))throw userError('生成协议无效');config.loras=normalizeLoras(c.loras);
  if(c.nativeModelscope!==undefined){if(config.protocol!=='modelscope'||input.mode!=='image')throw userError('原生 ModelScope 配置只用于图片协议');try{config.nativeModelscope=normalizeNativeModelscopeConfig(c.nativeModelscope);}catch(e){throw userError(e.message);}}
  if(config.protocol==='midjourney'){try{Object.assign(config,normalizeMidjourneyConfig(c));}catch(e){throw userError(e.message);}}
  if(c.apimartReferenceMode!==undefined&&!['frames','multimodal'].includes(c.apimartReferenceMode))throw userError('APIMart参考模式无效');if(c.apimartReferenceMode==='multimodal'&&input.mode==='video'&&config.protocol==='apimart')config.apimartReferenceMode='multimodal';
  config.model=c.model===''?'':textValue(c.model||'seedance-2.0',200,'模型名称');
  if(c.platformId)config.platformId=requireId(c.platformId);
  if(config.nativeModelscope){const definition=nativeModelscopeModel(config.nativeModelscope);if(definition.modelId&&config.model!==definition.modelId)throw userError('原生 ModelScope 固定模型编号与模型标记不一致');}
  for(const [key,allowed] of Object.entries({arkReferenceMode:['frames','multimodal'],imageResolution:['1k','2k','4k'],resolution:['480p','720p','1080p'],ratio:['16:9','9:16','1:1','4:3','3:4','21:9'],quality:['auto','high','medium','low'],operation:['generate','edit','extend'],currency:['CNY','USD']})){
    if(c[key]!==undefined&&!allowed.includes(c[key]))throw userError('生成参数无效：'+key);config[key]=c[key]??defaults[key];
  }
  config.duration=Number(c.duration??4);if(!Number.isInteger(config.duration)||config.duration<4||config.duration>15)throw userError('视频时长须为 4–15 秒');
  config.count=Number(c.count??1);if(config.nativeModelscope){try{studioRequestCount({mode:input.mode,config});}catch(e){throw userError(e.message);}}else if(![1,2,4].includes(config.count))throw userError('图片数量须为 1、2 或 4');
  config.size=String(c.size||'1024x1024');if(config.nativeModelscope){try{config.size=normalizeNativeModelscopeSize(config.size);}catch(e){throw userError(e.message);}}else if(!/^(auto|[1-9]\d{1,4}x[1-9]\d{1,4})$/.test(config.size))throw userError('图片尺寸无效');
  config.imageAsync=c.imageAsync===true;config.generateAudio=c.generateAudio===true;config.transparent=c.transparent===true;
  config.unitPrice=Number(c.unitPrice??0);if(!Number.isFinite(config.unitPrice)||config.unitPrice<0||config.unitPrice>1e6)throw userError('参考单价无效');
  const prompt=typeof input.prompt==='string'?input.prompt:'';if(prompt.length>5000)throw userError('提示词最多 5000 字符');
  if(!Array.isArray(input.references)||input.references.length>studioReferenceLimit({mode:input.mode,config}))throw userError('图片创作最多20份参考；当前视频创作最多'+studioReferenceLimit({mode:input.mode,config})+'份参考');
  const references=input.references.map(r=>{if(!r||[r.assetId,r.url].filter(Boolean).length!==1)throw userError('参考素材映射无效');return r.assetId?{assetId:requireId(r.assetId)}:normalizeStudioUrlReference(r,{mode:input.mode,config});});
  if((isArkMultimodal({mode:input.mode,config})||isApimartMultimodal({mode:input.mode,config}))&&new Set(references.map(r=>r.assetId||r.url)).size!==references.length)throw userError('方舟多素材参考不能重复');
  if(!Array.isArray(input.nodes)||input.nodes.length!==5||new Set(input.nodes.map(n=>n.id)).size!==5)throw userError('工作流需要五个节点');
  const nodes=input.nodes.map(n=>{if(!nodeIds.includes(n.id)||![n.x,n.y].every(x=>Number.isFinite(x)&&Math.abs(x)<1e6))throw userError('节点位置无效');return{id:n.id,x:n.x,y:n.y};});
  const v=input.viewport;if(!v||![v.x,v.y,v.zoom].every(Number.isFinite)||Math.abs(v.x)>1e6||Math.abs(v.y)>1e6||v.zoom<.15||v.zoom>3)throw userError('画布视图无效');
  return {name:textValue(input.name,120,'项目名称'),mode:input.mode,prompt,config,references,nodes,viewport:{x:v.x,y:v.y,zoom:v.zoom},view:input.view==='list'?'list':'canvas'};
}
const normalize=normalizeStudio;
export function validateStudioReferences(studio,output){
    if(isJimengStudio(studio)){const req=jimengStudioRequest(studio,output);for(const [i,ref]of output.entries())if(req.references[i].role!=='video'&&req.references[i].role!=='audio'&&!ref.type.startsWith('image/'))throw userError('此即梦命令只接受图片参考');return;} 
    try{validateMidjourneyRequest(studio,output);}catch(e){throw userError(e.message);}
    for(const [type,max] of [['image',studio.config.nativeModelscope?studioModelscopeReferenceLimit(studio):studioImageReferenceLimit(studio)],['video',3],['audio',studioAudioReferenceLimit(studio)]])if(output.filter(r=>r.type.startsWith(type+'/')).length>max)throw userError(`参考${type}数量超过 ${max}`);
    if(studio.mode==='video'&&!['studio','ark','apimart'].includes(studio.config.protocol))throw userError('此协议不支持视频模式');
    validateExtendedStudio(studio,output);
    if(studio.config.protocol==='modelscope'&&(studio.mode!=='image'||!studio.config.imageAsync))throw userError('ModelScope 需要图片异步模式');
    if(studio.config.protocol==='ark')assertArkReferences(studio,output);
    if(studio.config.protocol==='modelscope'&&(output.length>studioModelscopeReferenceLimit(studio)||(!studio.config.nativeModelscope&&studio.config.count!==1)||studio.config.transparent||studio.config.quality!=='auto'))throw userError('ModelScope 参考图或实际生成份数不符合所选协议');
    if(studio.config.nativeModelscope){const definition=nativeModelscopeModel(studio.config.nativeModelscope);if(definition.modelId&&studio.config.model!==definition.modelId)throw userError('原生 ModelScope 固定模型编号与模型标记不一致');if(definition.requiresImages&&!output.some(r=>r.type.startsWith('image/')))throw userError('此原生 ModelScope 编辑模型至少需要一张参考图');}
    if(studio.mode==='image'&&!['apimart','modelscope','midjourney'].includes(studio.config.protocol)&&studio.config.imageAsync&&(output.length||studio.config.count!==1||studio.config.transparent||studio.config.quality!=='auto'))throw userError('异步图片当前仅支持纯文字、单张、自动质量、不透明背景');
    if(studio.mode==='image'&&output.some(r=>!r.type.startsWith('image/')))throw userError('图片生成只接受图片参考，请移除视频或音频参考');
    if(studio.mode==='video'&&!['ark','apimart'].includes(studio.config.protocol)){
      if(studio.config.operation!=='generate'&&output.filter(r=>r.type.startsWith('video/')).length!==1)throw userError('编辑或延长视频需要恰好一段参考视频');
      if(studio.config.operation!=='generate'&&output.length!==1)throw userError('视频编辑/延长只提交一段视频，其他素材请先从本次参考中移除');
      if(studio.config.operation==='generate'&&(output.length>1||output.some(r=>!r.type.startsWith('image/'))))throw userError('多参考生成的字段契约尚未核实，当前仅提交纯文字或单图视频；素材已保留。');
    }
}
export function creationStudioService({data,activeJobs,pollInterval=2500,projects,platforms,miaoCredentials=localMiaoCredentialService(),arkCredentials=localArkCredentialService(),arkTransport={submit:submitArk,query:queryArk,download:downloadArk},jimengTasks}){
  const jimeng=jimengStudioAdapter({data,activeJobs,tasks:jimengTasks,projects});
  const dir=path.join(data,'studios'),jobFile=id=>path.join(data,'jobs',requireId(id)+'.json'),locks=new Map();
  // Successful catalogs live in memory only. A failed refresh never replaces
  // a prior complete catalog or alters the user's saved provider settings.
  const discoveredByPlatform=Object.create(null);
  async function catalog(){const saved=platforms?await platforms.list():{platforms:[]};return {platforms:saved.platforms||[],discoveredByPlatform,credentialStatus:await miaoCredentials.status(),source:'saved-and-discovered',catalogVersion:STUDIO_SERVICE_BUILD,apimartMaterials:true,generationVerified:false};}
  async function assertBoundModel(studio){
    const c=studio.config,registeredVideo=studio.mode==='video'&&isLocalMiaoTarget({protocol:'openai-compatible',baseUrl:c.baseUrl},{purpose:'video'});
    if(!c.platformId&&!registeredVideo)return;
    const saved=platforms?await platforms.list():{platforms:[]};
    const choice=studioModelChoices(saved.platforms,studio.mode,{discoveredByPlatform}).find(m=>m.id===c.model&&(c.platformId?m.platformId===c.platformId:m.baseUrl===c.baseUrl));
    if(!choice)throw userError(registeredVideo?'此模型服务的视频接口尚未核实，请刷新目录并选择已适配型号':'所选模型不在已登记的服务目录中，请刷新目录后重新选择');
    const contract=studioModelContract(choice);
    if(!contract.supported)throw userError(contract.note);
    if(choice.baseUrl!==c.baseUrl||contract.protocol!==c.protocol)throw userError('模型与服务地址或接口不一致，请重新选择模型');
  }
  async function locked(id,fn){const previous=locks.get(id)||Promise.resolve();const task=previous.catch(()=>{}).then(fn);locks.set(id,task);try{return await task;}finally{if(locks.get(id)===task)locks.delete(id);}}
  async function get(id){const studio=await readJson(path.join(dir,requireId(id),'studio.json'));if(projects&&studio.projectId){const project=await projects.load(studio.projectId);return {...studio,name:project.name,projectRevision:project.revision};}return studio;}
  async function persist(studio){await atomicJson(path.join(dir,studio.id,'history',`${studio.revision}-${randomUUID()}.json`),studio);await atomicJson(path.join(dir,studio.id,'studio.json'),studio);return studio;}
  async function list(projectId){await fs.mkdir(dir,{recursive:true});const items=await Promise.all((await fs.readdir(dir)).filter(safeId).map(id=>get(id).catch(()=>null)));return items.filter(p=>p&&(!projectId||p.projectId===projectId)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(({id,name,mode,revision,updatedAt,projectId})=>({id,name,mode,revision,updatedAt,projectId}));}
  async function create(body={}){const project=projects?(body.projectId?await projects.load(requireId(body.projectId)):await projects.create(body.name||'未命名创作项目')):null;const date=new Date().toISOString();return persist({id:randomUUID(),...(project?{projectId:project.id,projectRevision:project.revision}:{}),revision:0,createdAt:date,updatedAt:date,...normalize({name:project?.name||body.name||'未命名创作项目',mode:body.mode||'video',prompt:'',config:{...defaults,model:body.mode==='image'?'gpt-image-2':'seedance-2.0'},references:[],nodes:nodeIds.map((id,i)=>({id,x:[80,80,480,860,1230][i],y:[100,410,100,250,250][i]})),viewport:{x:30,y:30,zoom:.7},view:'canvas'})});}
  async function save(id,input){return locked(id,async()=>{const old=await get(id);if(old.revision!==input.revision)throw userError('项目已在另一窗口更新，请重新打开后保存',409);const next=normalize(input);let projectRevision=old.projectRevision;if(projects&&old.projectId&&next.name!==old.name){const project=await projects.rename(old.projectId,next.name,input.projectRevision);projectRevision=project.revision;}return persist({...next,id:old.id,...(old.projectId?{projectId:old.projectId,projectRevision}:{}),createdAt:old.createdAt,updatedAt:new Date().toISOString(),revision:old.revision+1});});}
  const jobs=async id=>(await Promise.all((await records(path.join(data,'jobs'))).filter(j=>j.kind==='studio'&&j.studioId===id).map(j=>isJimengStudio(j.input?.studio)?jimeng.refresh(j):j))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  async function references(studio){
    const output=[];for(const ref of studio.references){if(ref.url){output.push(normalizeStudioUrlReference(ref,studio));continue;}const a=await loadAsset(data,ref.assetId);const category=a.type.split('/')[0],limit={image:10,video:32,audio:20}[category];if(!limit||!['image/png','image/jpeg','image/webp','video/mp4','video/quicktime','audio/mpeg','audio/wav','audio/x-wav','audio/mp4'].includes(a.type))throw userError('参考素材格式不支持，请使用 PNG/JPEG/WebP、MP4/MOV、MP3/WAV');if(a.size>limit*1024*1024)throw userError(`参考${category}文件超过 ${limit} MB`);output.push({...ref,type:a.type,name:a.name,size:a.size});}
    validateStudioReferences(studio,output);
    if(studio.mode==='image'&&studio.config.protocol==='studio')assertImageRequestSize(output.reduce((sum,r)=>sum+(r.size||0),0),studio.prompt,studio.config.model);
    return output;
  }
  function checkAuthorization(studio,body){const a=body.authorization,c=studio.config;if(!c.baseUrl)throw userError('请先填写 API 地址');const origin=new URL(c.baseUrl).origin;
    const count=studioRequestCount(studio);if(!a||a.origin!==origin||a.model!==c.model||a.requestLimit!==count||a.sendPrompt!==true||(studio.references.length&&a.sendReferences!==true)||!Number.isFinite(a.budget)||a.budget<=0||a.currency!==c.currency)throw userError('请确认本次服务、模型、实际生成次数、发送素材和预算');
    if(c.unitPrice>0&&a.budget<c.unitPrice*(studio.mode==='video'?c.duration:c.count))throw userError('本次预算小于已填写的参考价格估算');
    const original=isApimartMultimodal(studio)&&studio.references.some(r=>/^(video|audio)\//.test(r.type||''));if(original&&a.sendOriginalMedia!==true)throw userError('请单独确认APIMart读取视频或音频原文件及声音');
    normalizeStudioCredential(body,studio);
    return {...(isApimartMultimodal(studio)?{sendOriginalMedia:original}:{}),origin,model:c.model,requestLimit:count,budget:a.budget,currency:a.currency,sendPrompt:true,sendReferences:studio.references.length>0};
  }
  async function start(id,body,context){return locked('submit-'+id,async()=>{
    if(context)assertParent(context.parentId,context.project.id);
    requireId(body.requestId);const previous=(await jobs(id)).find(j=>j.requestId===body.requestId);if(previous)return previous;
    if([...activeJobs.values()].some(j=>j.studioId===id&&(!context?.parentId||j.parentId!==context.parentId)))throw userError('当前项目已有生成任务',409);
    const studio=context?.studio||await get(id);if(studio.revision!==body.revision)throw userError('项目已更新，请重新检查参数后生成',409);if(isJimengStudio(studio))return jimeng.start(studio,body,context);if(!studio.prompt.trim()&&!mjPromptOptional(studio))throw userError('请填写提示词');if(!studio.config.model)throw userError('请选择真实目录中的模型');
    if(context){assertNoCredentials(studio);for(const r of studio.references)if(r.assetId&&!context.project.assets.some(a=>a.id===r.assetId))throw userError('参考素材不属于当前画布');}
    if(body.apiKey?.trim()&&JSON.stringify(studio).includes(body.apiKey.trim()))throw userError('创作参数包含本次密钥，请移除后执行');
    await assertBoundModel(studio);const authorization=checkAuthorization(studio,body),refs=await references(studio);
    const ark=isArkMultimodal(studio)?await prepareArkReferences({data,studio,refs,signal:AbortSignal.timeout(120000)}):null;
    if(ark){if(!context&&body.referenceFingerprint!==ark.plan.fingerprint)throw userError('多素材内容已变化或尚未检查，请重新预览并确认发送',409);if(ark.plan.sendOriginalMedia&&body.authorization?.sendOriginalMedia!==true)throw userError('请单独确认向方舟发送视频或音频原文件（包括声音）');if(context)for(const previous of body.referenceInputs||[])if(previous.assetId&&previous.sourceSha256!==ark.plan.inputs.find(r=>r.assetId===previous.assetId)?.sourceSha256)throw userError('已授权的方舟本机参考文件发生变化，请重新规划画布');authorization.sendOriginalMedia=ark.plan.sendOriginalMedia;}

    const credential=normalizeStudioCredential(body,studio),resolved=await resolveStudioCredential(credential,studio,arkCredentials,miaoCredentials);
    let key=resolved.apiKey;
    try{
      if(key&&JSON.stringify(studio).includes(key))throw userError('创作参数包含本次密钥，请移除后执行');
      const job={id:randomUUID(),kind:'studio',studioId:id,projectId:studio.projectId||id,name:studio.name+' · '+studio.config.model,createdAt:new Date().toISOString(),status:'queued',progress:0,message:'任务已准备',assets:[],items:[],requestId:body.requestId,requestCount:0,input:{studio},authorization,billingStatus:'unknown',credentialSource:credential.credentialSource,credentialProvider:resolved.source,...(ark?{referencePlan:ark.plan}:{}),...(context?{parentId:context.parentId,nodeId:context.nodeId}:{})};
      if(isNativeModelscopeJob(job))job.items=Array.from({length:studioRequestCount(studio)},(_,index)=>({index,status:'unsubmitted',assets:[]}));
      await atomicJson(jobFile(job.id),job);launch(job,key,ark?.prepared||refs,false);return structuredClone(job);
    }finally{key='';resolved.apiKey='';body.apiKey='';}
  });}
  async function readReference(ref){const bytes=await fs.readFile(path.join(data,'assets',ref.assetId));const limit={image:10,video:32,audio:20}[ref.type.split('/')[0]]*1024*1024;if(bytes.length>limit)throw userError('参考素材大小超限');return {bytes,mime:ref.type,name:ref.name};}
  function launch(job,key,refs,resuming){
    const controller=new AbortController(),parentSignal=activeJobs.get(job.parentId)?.controller.signal,stop=()=>controller.abort();parentSignal?.addEventListener('abort',stop,{once:true});if(parentSignal?.aborted)controller.abort();activeJobs.set(job.id,{controller,studioId:job.studioId,projectId:job.projectId,kind:'studio',...(job.parentId?{parentId:job.parentId}:{})});
    void(async()=>{const studio=job.input.studio,c=studio.config,signal=AbortSignal.any([controller.signal,AbortSignal.timeout(1800000)]),opts={baseUrl:c.baseUrl,apiKey:key,signal};try{
      job.status='running';job.message=resuming?'正在查询原任务，不会重新生成':'准备参考素材';await atomicJson(jobFile(job.id),job);
      if(studio.mode==='image'){
        const images=[];for(const ref of (resuming?[]:refs)){if(ref.url){const [r]=await parseImageData({data:[{url:ref.url}]},{baseUrl:c.baseUrl,signal});if(r.bytes.length>10*1024*1024)throw userError('参考图超过 10 MB');images.push({...r,name:'reference.png'});}else images.push(await readReference(ref));}
        if(c.protocol==='studio')assertImageRequestSize(images.reduce((sum,r)=>sum+r.bytes.length,0),studio.prompt,c.model);
        let result;
        if(c.nativeModelscope){
          await runNativeModelscopeBatch({job,studio,images,signal,resuming,pollInterval,persist:value=>atomicJson(jobFile(job.id),value),
            submit:(single,references,signal)=>submitModelScope({...opts,studio:single,references,signal}),query:(upstreamId,signal)=>queryModelScope({...opts,studio,upstreamId,signal}),
            store:(r,index)=>storeAsset(data,r.bytes,{name:`${studio.name.slice(0,80)}-${index+1}.${r.mime==='image/jpeg'?'jpg':r.mime.split('/')[1]}`,type:r.mime,source:'creation-studio'})});
          result={images:[]};
        }else if(c.imageAsync){
          if(!resuming){job.requestCount=1;job.message='正在提交异步图片任务';await atomicJson(jobFile(job.id),job);const task=await (c.protocol==='midjourney'?submitMidjourney:c.protocol==='modelscope'?submitModelScope:c.protocol==='apimart'?submitApimart:submitImageTask)({...opts,studio,references:images});job.upstreamId=task.upstreamId;await atomicJson(jobFile(job.id),job);if(task.requiresInput){job.status='awaiting_input';job.uncertain=false;job.message='平台等待重绘遮罩和提示词，请按原编号单独确认补参请求';return;}}
          while(true){signal.throwIfAborted();result=await (c.protocol==='midjourney'?queryMidjourney:c.protocol==='modelscope'?queryModelScope:c.protocol==='apimart'?queryApimart:queryImageTask)({...opts,studio,upstreamId:job.upstreamId});job.progress=result.progress;job.message=result.message||'图片生成中';await atomicJson(jobFile(job.id),job);if(result.status==='completed')break;if(['failed','cancelled','awaiting_input'].includes(result.status)){job.status=result.status;if(result.status==='awaiting_input')job.uncertain=false;return;}await new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new Error('查询停止'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},pollInterval);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}
        }else{job.requestCount=1;job.message='正在生成图片';await atomicJson(jobFile(job.id),job);result=await (c.protocol==='gemini'?generateGeminiImages:generateStudioImages)({...opts,studio,references:images});}
        if(c.protocol==='midjourney')job.mjButtons=result.buttons||[];
        for(const [index,r] of result.images.entries()){if(index<job.assets.length)continue;job.assets.push(await storeAsset(data,r.bytes,{name:`${studio.name.slice(0,80)}-${job.assets.length+1}.${r.mime==='image/jpeg'?'jpg':r.mime.split('/')[1]}`,type:r.mime,source:'creation-studio'}));await atomicJson(jobFile(job.id),job);}job.usage=result.usage||null;
      }else{
        if(!resuming){const uploaded=[];for(const ref of refs){if(['ark','apimart'].includes(c.protocol)){uploaded.push(ref.bytes?ref:ref.url?{url:ref.url,type:ref.type}:await readReference(ref));}else{const url=ref.url||await uploadReference({...opts,reference:await readReference(ref)});uploaded.push({url,type:ref.type});}}job.requestCount=1;job.message='正在提交视频任务';await atomicJson(jobFile(job.id),job);const task=await (c.protocol==='ark'?arkTransport.submit:c.protocol==='apimart'?submitApimart:submitVideo)({...opts,studio,references:uploaded});job.upstreamId=task.upstreamId;await atomicJson(jobFile(job.id),job);}
        let videoUrl;while(true){signal.throwIfAborted();const result=await (c.protocol==='ark'?arkTransport.query:c.protocol==='apimart'?queryApimart:queryVideo)({...opts,studio,upstreamId:job.upstreamId});job.progress=result.progress;job.message=result.message||'视频生成中';await atomicJson(jobFile(job.id),job);if(result.status==='completed'){videoUrl=result.videoUrl;break;}if(['failed','cancelled'].includes(result.status)){job.status=result.status;job.message=result.message||'平台任务未完成';return;}await new Promise((resolve,reject)=>{const aborted=()=>{clearTimeout(timer);reject(new Error('查询停止'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',aborted);resolve();},pollInterval);signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();});}
        job.message='正在保存视频到本机';await atomicJson(jobFile(job.id),job);const result=['ark','apimart'].includes(c.protocol)?await (c.protocol==='ark'?arkTransport.download:downloadArk)({...opts,videoUrl}):await downloadVideo({...opts,upstreamId:job.upstreamId});job.assets.push(await storeAsset(data,result.bytes,{name:studio.name.slice(0,100)+'.mp4',type:result.mime,source:'creation-studio'}));
      }
      if(!job.assets.length)throw userError('平台未返回可保存的素材');job.status='completed';job.progress=100;job.message='生成完成，结果已保存到本机素材库';job.uncertain=false;
    }catch(e){job.status=controller.signal.aborted?'cancelled':'failed';job.uncertain=Boolean(job.upstreamId)||job.requestCount>0&&e.uncertain!==false;job.message=controller.signal.aborted?'已停止本机等待；平台可能仍在处理。可按原编号继续查询。':e.publicMessage||(e.status?e.message:'任务未完成，请核对平台任务与账单；不会自动重试。');}
    finally{parentSignal?.removeEventListener('abort',stop);key='';opts.apiKey='';await atomicJson(jobFile(job.id),job);activeJobs.delete(job.id);}})();
  }
  async function resume(id,jobId,body,parentId){return locked('submit-'+id,async()=>{const job=await readJson(jobFile(jobId));if(isJimengStudio(job.input?.studio)){if(job.kind!=='studio'||job.studioId!==id)throw userError('原任务不属于此创作');if(job.parentId){if(job.parentId!==parentId)throw userError('请从所属画布任务继续');assertParent(parentId,job.projectId);}if(activeJobs.has(jobId))throw userError('原任务仍在执行，请读取记录',409);return jimeng.resume(job,body);}if(job.kind!=='studio'||job.studioId!==id||!job.upstreamId&&!nativeModelscopeHasOriginalIds(job)||(job.input.studio.mode!=='video'&&!job.input.studio.config.imageAsync))throw userError('没有可查询的异步任务编号');if(job.parentId){if(job.parentId!==parentId)throw userError('请从所属画布任务继续此步骤');assertParent(parentId,job.projectId);}if(isNativeModelscopeJob(job))validateNativeModelscopeBatch(job);if(job.status==='completed')return job;if([...activeJobs.values()].some(j=>j.studioId===id&&(!parentId||j.parentId!==parentId)))throw userError('当前项目已有运行中任务',409);const credential=normalizeStudioCredential(body,job.input.studio),resolved=await resolveStudioCredential(credential,job.input.studio,arkCredentials,miaoCredentials);try{job.status='running';await atomicJson(jobFile(job.id),job);launch(job,resolved.apiKey,[],true);return structuredClone(job);}finally{resolved.apiKey='';body.apiKey='';}});}
  async function cancel(id,jobId,body={}){const job=await readJson(jobFile(jobId));if(job.kind!=='studio'||job.studioId!==id)throw userError('任务不属于此项目');if(isJimengStudio(job.input?.studio))return jimeng.cancel(job);if(body.cancelUpstream===true&&(job.input.studio.mode!=='video'||job.input.studio.config.protocol!=='studio'))throw userError('该协议仅支持停止本机查询，未配置上游取消协议');activeJobs.get(jobId)?.controller.abort();if(body.cancelUpstream===true){if(!job.upstreamId)throw userError('没有平台任务编号');await cancelVideo({baseUrl:job.input.studio.config.baseUrl,apiKey:body.apiKey,upstreamId:job.upstreamId,signal:AbortSignal.timeout(30000)});}return {ok:true};}
  async function apply(id,jobId,body){if(!projects)throw userError('当前服务未绑定主画布');const studio=await get(id),job=await readJson(jobFile(jobId));if(!studio.projectId||job.kind!=='studio'||job.studioId!==id||job.projectId!==studio.projectId||job.status!=='completed')throw userError('任务未完成或不属于当前项目');if(isJimengStudio(job.input?.studio))await jimeng.verify(job);return projects.apply(job,body.revision);}
  async function preview(id){const studio=await get(id);if(!isArkMultimodal(studio))throw userError('此预览仅用于方舟多素材参考');const refs=await references(studio),result=await prepareArkReferences({data,studio,refs,signal:AbortSignal.timeout(120000)});return {...result.plan,revision:studio.revision};}
  async function discover(body){if(body.consent!==true)throw userError('请确认向此平台发送模型列表请求');if(body.platformId){if(!platforms)throw userError('服务目录暂不可用',503);const p=await platforms.get(requireId(body.platformId)),result=await platforms.discover(body);const sanitized=(result.models||[]).filter(m=>typeof m?.id==='string'&&m.id.length<=200&&!/[\u0000-\u001f\u007f]/.test(m.id)).map(m=>({id:m.id,...(typeof m.label==='string'?{label:m.label.slice(0,120)}:{}),...(['image','chat','video'].includes(m.category)?{category:m.category}:{})}));discoveredByPlatform[p.id]=sanitized;return {...result,platformId:p.id};}const target={mode:body.mode==='image'?'image':'video',config:{protocol:body.protocol,baseUrl:body.baseUrl}},credential=normalizeStudioCredential(body,target),resolved=await resolveStudioCredential(credential,target,arkCredentials,miaoCredentials);try{const value=body.protocol==='gemini'?await listGeminiModels({...body,apiKey:resolved.apiKey,signal:AbortSignal.timeout(30000)}):await listImageModels({baseUrl:body.baseUrl,apiKey:resolved.apiKey,signal:AbortSignal.timeout(30000)});return safeCatalogResult(value,resolved.apiKey);}finally{resolved.apiKey='';body.apiKey='';}}
  function assertParent(parentId,projectId){const p=activeJobs.get(parentId);if(!p||p.kind!=='canvas-run'||p.projectId!==projectId||p.controller.signal.aborted)throw userError('没有正在执行的所属画布任务');}
  return {recoverCanvasLinks:jimeng.recoverCanvasLinks,verify:jimeng.verify,jimengPreview:async id=>jimeng.preview(await get(id)),refresh:jimeng.refresh,get,list,create,save,jobs,preview,catalog,start:(id,b)=>start(id,b),resume:(id,jobId,b)=>resume(id,jobId,b),cancel,discover,apply,
    startFromCanvas:(studio,project,b,parentId,nodeId)=>start(parentId,{...b,revision:0},{studio:{...studio,id:parentId,projectId:project.id,revision:0},project,parentId,nodeId}),
    resumeFromCanvas:(jobId,b,parentId)=>resume(parentId,jobId,b,parentId)};
}
