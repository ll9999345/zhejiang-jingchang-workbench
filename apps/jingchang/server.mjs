import {canvasClipboardService} from './lib/canvas-clipboard.mjs';
import {nativeInputReviewService} from './lib/native-input-review-service.mjs';
import {smartGroupLifecycleService} from './lib/smart-group-lifecycle.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {NATIVE_MEDIA_SESSION_HEADER,nativeMediaSession,nativeMediaSessionToken,assertNativeMediaSession,assertNativeMediaProjectSession} from './public/native-media-session-core.js';
const nativeMediaRequests=new AsyncLocalStorage();
import {nativeMediaMigrationService} from './lib/native-media-migration.mjs';
import {inputGroupMembershipService} from './lib/input-group-membership.mjs';
import {configureNativeSmartGroupStoredMedia} from './lib/native-flow.mjs';
import {nativeMediaRuntime,workspaceRoot} from './lib/runtime-config.mjs';
// A frozen runtime opts in explicitly. Missing configuration keeps legacy
// behavior; existing projects retain their own stored media version.
const smartGroupStoredMediaCandidate=(await nativeMediaRuntime()).storedMedia;
configureNativeSmartGroupStoredMedia(smartGroupStoredMediaCandidate);
import {geminiCliService,geminiCliTargetDigest} from './lib/gemini-cli-tasks.mjs';
import {codexChatService,codexChatTargetDigest} from './lib/codex-chat-tasks.mjs';
import {promptCatalogService} from './lib/prompt-catalog.mjs';
import {promptCatalogImports} from './lib/prompt-catalog-imports.mjs';
import {assetCaptionService} from './lib/asset-captions.mjs';
import {assetCaptionBatchService} from './lib/asset-caption-batches.mjs';
import {withAssetMetadataLock} from './lib/asset-metadata-lock.mjs';
import {jimengAccountService} from './lib/jimeng-account.mjs';
import {jimengOperationGuard} from './lib/jimeng-operation-guard.mjs';
import {applyJimengCanvasResults} from './lib/jimeng-canvas.mjs';
import {jimengTaskService} from './lib/jimeng-cli-tasks.mjs';
import {apimartMaterialService} from './lib/apimart-materials.mjs';
import {minimaxExportProject,attachMinimaxResults} from './lib/minimax-h3.mjs';
import {localMiaoCredentialService} from './lib/miao-credentials.mjs';
import {localArkCredentialService} from './lib/ark-credentials.mjs';
import {arkAssetService} from './lib/ark-assets.mjs';
import {publicMediaService,publicMediaProfiles} from './lib/public-media.mjs';
import {streamAssetService,streamMediaSize} from './lib/stream-assets.mjs';
import {sharedFolderService,serveSharedMedia} from './lib/shared-folders.mjs';
import {libraryCropService} from './lib/library-crops.mjs';
import {assetCatalogService} from './lib/asset-catalog.mjs';
import {libraryBackupService,publicLibraryJob} from './lib/library-backups.mjs';
import {nativeLibraryImportService} from './lib/native-library-import.mjs';
import {abortableRequest} from './lib/local-request-abort.mjs';
import {nativeCanvasService} from './lib/native-canvas.mjs';
import {nativeFlowService} from './lib/native-flow-service.mjs';
import {model3dInfo} from './lib/model3d.mjs';
import {importChatDocument} from './lib/chat-documents.mjs';
import {isDocument,DOCUMENT_LIMIT} from './public/document-types.js';
import {prepareChatMedia} from './lib/chat-media.mjs';
import {runningHubLoraService} from './lib/runninghub-loras.mjs';
import {LORA_MIME} from './lib/lora-files.mjs';
import {clearStudioCredentials} from './lib/canvas-studio.mjs';
import {canvasLlmService,clearLlmCredentials} from './lib/canvas-llm.mjs';
import {clearImageCredentials} from './lib/canvas-images.mjs';
import {applyPromptBatchResults,applyCanvasResults} from './lib/generation-results.mjs';
import {imageAssetReferences,jobReferenceAssetIds} from './lib/media-lineage.mjs';
import {clearCloudCredentials} from './lib/canvas-cloud.mjs';
import {backendState,updateBackends,selectBackend,selectCanvasBackends,updateLegacyComfy} from './lib/comfy-backends.mjs';
import {inspectComfyBackend} from './lib/providers.mjs';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID,createHash } from 'node:crypto';
import { makeNode, makeProject, validateProject } from './lib/model.mjs';
import { makePlan, applyPlan, preflight, skills, templateActions, planMessages } from './lib/agent.mjs';
import {directorProviderService,directorRequestHash,remoteDirector} from './lib/director-provider.mjs';
import { extractVideoFrames, cropImage, splitImageGrid, composeImageGrid, editImage, editorSource, readImageEdit, capturePanorama } from './lib/media-tools.mjs';
import {renderService} from './lib/render-service.mjs';
import { projectBundleService } from './lib/project-bundles.mjs';
import {taskHistoryArchiveService} from './lib/task-history-archive.mjs';
import {rhModelCatalog,rhModelFields,RH_CATALOG_VERSION} from './lib/runninghub-models.mjs';
import { cloudWorkflowService } from './lib/cloud-workflows.mjs';
import {importNativeRhFields} from './lib/native-workflow-config.mjs';
import { canvasRunner } from './lib/canvas-runner.mjs';
import {nativeCascadeRunner,publicCascadeJob} from './lib/native-cascade-runner.mjs';
import {applyNativeCascadeResults} from './lib/native-cascade-results.mjs';
import { conversationService } from './lib/conversations.mjs';
import { platformService } from './lib/api-platforms.mjs';
import { creationStudioService, studioModels } from './lib/creation-studio.mjs';
import { directImageService } from './lib/direct-images.mjs';
import { diagnostics } from './lib/diagnostics.mjs';
import { localCliStatus, localCliStatuses } from './lib/local-cli-status.mjs';
import { localCliInfoService } from './lib/local-cli-info.mjs';
import {assetClassificationService} from './lib/asset-classification.mjs';
import {classificationBatchService} from './lib/classification-batches.mjs';
import {audioWaveformService} from './lib/audio-waveform.mjs';
import {promptLibraryService} from './lib/prompt-library.mjs';
import {rewritePrompt} from './lib/prompt-rewrite.mjs';
import { generationService, publicJob } from './lib/generation.mjs';
import { userError, atomicJson, readJson, records, textValue, localUrl, storeAsset, loadAsset } from './lib/workspace.mjs';
import { createMediaArchive } from './lib/media-archive.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const workspace=workspaceRoot();
const data=process.env.JINGCHANG_DATA_DIR || path.join(workspace,'data');
const port=Number(process.env.PORT||4768);
const appVersion=(await readJson(path.join(root,'package.json'))).version;
const cliInfo=localCliInfoService();
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.mp4':'video/mp4'};
await fs.mkdir(path.join(data,'projects'),{recursive:true});
await fs.mkdir(path.join(data,'assets'),{recursive:true});
await fs.mkdir(path.join(data,'jobs'),{recursive:true});
await fs.mkdir(path.join(data,'plans'),{recursive:true});
await fs.mkdir(path.join(data,'templates'),{recursive:true});
const activeJobs=new Map(),jimengGuard=jimengOperationGuard();
const assetCaptions=assetCaptionService({data}),captionBatches=assetCaptionBatchService({data,captions:assetCaptions,platforms:{get:id=>platforms.get(id)},projects:{load}});
const jimengAccount=jimengAccountService({data,guard:jimengGuard,beforeAccountChange:async()=>{for(const [id,entry]of activeJobs){if(!['canvas-run','studio'].includes(entry.kind))continue;const job=await readJson(path.join(data,'jobs',id+'.json'));if(job.input?.studio?.config?.protocol==='jimeng'||job.steps?.some(step=>step.studio?.config?.protocol==='jimeng'))return true;}return false;}});
const publicMedia=publicMediaService({data,activeJobs,projects:{load}});
const streamAssets=streamAssetService({data,activeJobs,projects:{load}});
const sharedFolders=sharedFolderService({root:workspace,data,activeJobs,streamAssets,projects:{load,attach:async(job,assets,revision)=>exclusive(job.projectId,async()=>{const p=await load(job.projectId);if(assets.every(a=>p.assets.some(item=>item.id===a.id)))return p;if(p.revision!==revision)fail(409,'项目已更新，请刷新后加入共享素材');for(const asset of assets)if(!p.assets.some(item=>item.id===asset.id))p.assets.push(await loadAsset(data,asset.id));p.revision++;p.updatedAt=new Date().toISOString();validateProject(p);return save(p);})}});
const jimengTasks=jimengTaskService({data,activeJobs,streamAssets,operationGuard:jimengGuard,projects:{load,apply:async(task,revision,placement)=>exclusive(task.projectId,async()=>{const p=await load(task.projectId),assets=await Promise.all(task.assets.map(a=>loadAsset(data,a.id)));if(!applyJimengCanvasResults(p,task,assets,{revision,placement}))return p;validateProject(p);return save(p);})}});
const apimartMaterials=apimartMaterialService({data,projects:{load},publicMedia});
const arkAssets=arkAssetService({data,activeJobs,projects:{load},publicMedia});
const generation=generationService({data,activeJobs});
const platforms=platformService(data);
const assetClassification=assetClassificationService({data,platforms});
const classificationBatches=classificationBatchService({data,platforms,sharedFolders,classifier:assetClassification});
const audioWaveforms=audioWaveformService({data});
const promptLibrary=promptLibraryService({data});
const promptCatalog=promptCatalogService({data,prompts:promptLibrary}),promptImports=promptCatalogImports({data,catalog:promptCatalog,prompts:promptLibrary});
const directImages=directImageService({data,activeJobs,platforms});
const arkCredentials=localArkCredentialService();
const creationStudio=creationStudioService({data,activeJobs,arkCredentials,platforms,jimengTasks,projects:{load,create:async name=>save(makeProject(name)),rename:async(id,name,revision)=>exclusive(id,async()=>{const p=await load(id);if(p.revision!==revision)fail(409,'主画布已更新，请刷新后重命名');p.name=name;p.revision++;p.updatedAt=new Date().toISOString();return save(p);}),apply:applyStudioResults}});
const assetCatalog=assetCatalogService({data,activeJobs,streamAssets,projects:{load,attach:async(job,assets,revision)=>exclusive(job.projectId,async()=>{const p=await load(job.projectId);if(assets.every(a=>p.assets.some(item=>item.id===a.id)))return p;if(p.revision!==revision)fail(409,'项目已更新，请刷新后加入素材库副本');for(const asset of assets)if(!p.assets.some(item=>item.id===asset.id))p.assets.push(await loadAsset(data,asset.id));p.revision++;p.updatedAt=new Date().toISOString();validateProject(p);return save(p);})},workflows:{template:generation.template,saveTemplate:generation.saveTemplate},bundles:{export:(...args)=>projectBundles.exportBundle(...args),download:(...args)=>projectBundles.download(...args),upload:(...args)=>projectBundles.upload(...args),import:(...args)=>projectBundles.importBundle(...args),insert:(...args)=>projectBundles.insertBundle(...args),package:(...args)=>projectBundles.libraryPackage(...args),nativeSourceFromExport:(...args)=>projectBundles.nativeSourceFromExport(...args)}});
const libraryCrops=libraryCropService({data,activeJobs,catalog:assetCatalog,projects:{load,attach:async(job,assets,revision)=>exclusive(job.projectId,async()=>{const p=await load(job.projectId);if(assets.every(a=>p.assets.some(x=>x.id===a.id)))return p;if(p.revision!==revision)throw userError('项目已更新，请刷新后再加入',409);p.assets.push(...assets.filter(a=>!p.assets.some(x=>x.id===a.id)));p.revision++;await save(p);return p;})}});
const projectBundles=projectBundleService({data,activeJobs,projects:{load,save,exclusive},assetCatalog});
const clipboardPastes=canvasClipboardService({data,projects:{load},bundles:projectBundles,activeJobs});
const taskHistoryArchives=taskHistoryArchiveService({data,activeJobs,projects:{load,save,exclusive},projectBundles});
const libraryBackups=libraryBackupService({data,activeJobs,projects:{load},catalog:assetCatalog,bundles:projectBundles});
const nativeLibraryImports=nativeLibraryImportService({data,projects:{load},catalog:assetCatalog,bundles:projectBundles});
const nativeCanvas=nativeCanvasService({data,bundles:projectBundles,catalog:assetCatalog});
const nativeFlow=nativeFlowService({data,assertProject:p=>assertNativeMediaProjectSession(p,nativeMediaRequests.getStore(),smartGroupStoredMediaCandidate)});
const inputGroupMembers=inputGroupMembershipService({projects:{load,save},exclusive});
const nativeMediaVersions=nativeMediaMigrationService({projects:{load,save},exclusive});
const smartGroups=smartGroupLifecycleService({projects:{load,save},exclusive});
const renders=renderService({data,activeJobs,projects:{apply:(job,asset,revision)=>exclusive(job.projectId,async()=>{const p=await load(job.projectId);if(p.runs.some(r=>r.jobId===job.id))return p;if(p.revision!==revision)fail(409,'画布已更新，请刷新后再加入成片');if(!p.assets.some(a=>a.id===asset.id))p.assets.push(asset);p.nodes.push(makeNode('video',180,150+Math.ceil(p.nodes.length/3)*300,{title:asset.name,assetId:asset.id}));p.runs.push({id:randomUUID(),jobId:job.id,kind:'render',createdAt:new Date().toISOString()});p.revision++;p.updatedAt=new Date().toISOString();validateProject(p);return save(p);})}});
const loras=runningHubLoraService({data,activeJobs,projects:{load,attach:async(projectId,asset,revision)=>exclusive(projectId,async()=>{const p=await load(projectId);if(p.assets.some(a=>a.id===asset.id))return p;if(p.revision!==revision)fail(409,'项目已更新，请刷新后加入 LoRA');p.assets.push(asset);p.revision++;p.updatedAt=new Date().toISOString();return save(p);})}});
const cloudWorkflows=cloudWorkflowService({data,activeJobs,projects:{load,apply:applyStudioResults}});
const cascadeRuns=nativeCascadeRunner({data,activeJobs,generation,cloudWorkflows,directImages,creationStudio});
const nativeInputReviews=nativeInputReviewService({data,activeJobs,exclusive:(id,fn)=>exclusive('resume-'+id,fn)});
const publicExecutionJob=job=>job.executionMode==='native-cascade'?publicCascadeJob(job):publicJob(job);
const codexChats=codexChatService({data,platforms,activeJobs,projects:{load,apply:async(task,body)=>exclusive(task.projectId,async()=>{
 const p=await load(task.projectId);if(p.runs.some(r=>r.kind==='codex-chat'&&r.jobId===task.id&&r.mode===body.placement))return p;
 if(!Number.isSafeInteger(body.revision)||p.revision!==body.revision)fail(409,'画布已变化，请重新读取后取回；原回答保留');
 let node;if(body.placement==='bound'){const target=task.plan.target;node=target&&p.nodes.find(n=>n.id===target.nodeId);if(!node||codexChatTargetDigest(node)!==target.sourceNodeDigest)fail(409,'原节点已有新编辑，未覆盖；可另存新文本节点');node.text=task.response.text;}
 else{node=makeNode('text',160,150+Math.ceil(p.nodes.length/3)*300,{title:('Codex · '+task.plan.text).slice(0,120),text:task.response.text});p.nodes.push(node);}
 p.runs.push({id:randomUUID(),kind:'codex-chat',jobId:task.id,nodeId:node.id,mode:body.placement,createdAt:new Date().toISOString()});p.revision++;p.updatedAt=new Date().toISOString();validateProject(p);return save(p);
})}});
const geminiCliChats=geminiCliService({data,platforms,activeJobs,projects:{load,apply:async(task,body)=>exclusive(task.projectId,async()=>{
 const p=await load(task.projectId);if(p.runs.some(r=>r.kind==='gemini-cli-chat'&&r.jobId===task.id&&r.mode===body.placement))return p;
 if(!Number.isSafeInteger(body.revision)||p.revision!==body.revision)fail(409,'画布已变化，请重新读取后取回；原回答保留');
 let node;if(body.placement==='bound'){const target=task.plan.target;node=target&&p.nodes.find(n=>n.id===target.nodeId);if(!node||geminiCliTargetDigest(node)!==target.sourceNodeDigest)fail(409,'原节点已有新编辑，未覆盖；可另存新文本节点');node.text=task.response.text;}
 else{node=makeNode('text',160,150+Math.ceil(p.nodes.length/3)*300,{title:('Gemini · '+task.plan.text).slice(0,120),text:task.response.text});p.nodes.push(node);}
 p.runs.push({id:randomUUID(),kind:'gemini-cli-chat',jobId:task.id,nodeId:node.id,mode:body.placement,createdAt:new Date().toISOString()});p.revision++;p.updatedAt=new Date().toISOString();validateProject(p);return save(p);
})}});
const canvasLlm=canvasLlmService({data,activeJobs,codexChats,geminiCliChats});
const canvasRuns=canvasRunner({data,activeJobs,generation,cloudWorkflows,directImages,canvasLlm,creationStudio});
const conversations=conversationService({data,platforms,activeJobs,codexChats,geminiCliChats,projects:{load,apply:async(c,m,revision)=>exclusive(c.projectId,async()=>{const p=await load(c.projectId);if(p.runs.some(r=>r.messageId===m.id))return p;if(p.revision!==revision)fail(409,'画布已更新，请刷新后再放入');if(m.assetIds?.length){for(const assetId of m.assetIds){const a=await loadAsset(data,assetId);if(!a.type.startsWith('image/'))fail(400,'对话结果不是图片');if(!p.assets.some(x=>x.id===a.id))p.assets.push(a);p.nodes.push(makeNode('image',160,150+Math.ceil(p.nodes.length/3)*300,{title:c.name.slice(0,120),text:m.imagePrompts?.[m.assetIds.indexOf(assetId)]||c.messages.slice(0,c.messages.indexOf(m)).findLast(x=>x.role==='user')?.text||m.text,assetId:a.id}));}}else p.nodes.push(makeNode('text',160,150+Math.ceil(p.nodes.length/3)*300,{title:(c.name+(m.state==='incomplete'?'（未完成片段）':'')).slice(0,120),text:m.text}));p.runs.push({id:randomUUID(),kind:'conversation',messageId:m.id,jobId:m.jobId,createdAt:new Date().toISOString()});p.revision++;p.updatedAt=new Date().toISOString();validateProject(p);return save(p);})}});
let config=await readJson(path.join(data,'config.json'),{llmUrl:'',llmModel:'',comfyUrl:'http://127.0.0.1:8188'});
const directorProvider=directorProviderService({data});
async function directorPreview(p,message){
  textValue(message,20000,'助理指令');
  const director=await directorProvider.status({refresh:true,provider:config.agentProvider});if(!director.configured)fail(400,director.error||'模型服务尚未配置');
  const messages=planMessages(p,message),bytes=Buffer.byteLength(JSON.stringify(messages));if(bytes>200000)fail(400,'本次画布文字过多，请精简后再规划；没有提交请求');
  return {director,projectRevision:p.revision,previewHash:directorRequestHash({projectId:p.id,revision:p.revision,messages,profileRevision:director.profileRevision}),estimatedMaximumUSD:Math.ceil((bytes+4096)*director.pricing.input_per_million+6000*director.pricing.output_per_million)/1000000,scope:{nodes:p.nodes.length,shots:p.shots.length,assetNames:p.assets.length,textBytes:bytes},maxTokens:6000};
}
for(const f of (await fs.readdir(path.join(data,'jobs'))).filter(f=>/^[\w-]+\.json$/.test(f))){try{const j=JSON.parse(await fs.readFile(path.join(data,'jobs',f),'utf8'));if(['running','queued'].includes(j.status)){j.status='interrupted';if(['conversation','conversation-image','conversation-agent'].includes(j.kind))j.uncertain=j.requestCount>0;j.message=['library-backup','library-restore'].includes(j.kind)?'服务重启，本机整库操作已中断；原计划和文件保留，请从素材库读取原记录后继续。':['folder-import','library-copy'].includes(j.kind)?'服务重启，本机导入已中断；完成副本和收到的部分文件保留，点击继续只处理未完成项。':j.kind==='render'?'服务重启，本机合成已中断。可按原剪辑设置重新合成，原素材与中间文件保留。':'服务重启，任务已中断。画布执行任务及有原编号的 ComfyUI、云工作流或创作台异步任务可继续查询；其他请求请先核对平台账单，不会自动重复提交。';await atomicJson(path.join(data,'jobs',f),j);}}catch{}}
await canvasLlm.recover();
await conversations.recover();
await loras.recover();
await sharedFolders.recover();
await assetCatalog.recover();
await libraryCrops.recover();
await libraryBackups.recover();
await assetClassification.recover();
const validId=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(x);
function fail(status,message){const e=new Error(message);e.status=status;throw e;}
async function body(req,limit=20*1024*1024){let n=0,parts=[];for await(const chunk of req){n+=chunk.length;if(n>limit)fail(413,'文件或请求过大');parts.push(chunk);}return Buffer.concat(parts);}
async function jsonBody(req,limit){try{return JSON.parse((await body(req,limit)).toString());}catch(e){if(e.status)throw e;fail(400,'请求内容不是有效 JSON');}}
function json(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
async function load(id,{metadata=false}={}){if(!validId(id))fail(400,'项目编号无效');try{const p=JSON.parse(await fs.readFile(path.join(data,'projects',id,'project.json'),'utf8'));if(!metadata)assertNativeMediaProjectSession(p,nativeMediaRequests.getStore(),smartGroupStoredMediaCandidate);return p;}catch(e){if(e.code==='ENOENT')fail(404,'项目不存在');throw e;}}
const locks=new Map();
async function exclusive(id,fn){const before=locks.get(id)||Promise.resolve();const task=before.catch(()=>{}).then(fn);locks.set(id,task);try{return await task;}finally{if(locks.get(id)===task)locks.delete(id);}}
async function save(p){assertNativeMediaProjectSession(p,nativeMediaRequests.getStore(),smartGroupStoredMediaCandidate);const dir=path.join(data,'projects',p.id);await fs.mkdir(path.join(dir,'history'),{recursive:true});await fs.writeFile(path.join(dir,'history',`${p.revision}-${randomUUID()}.json`),JSON.stringify(p));const tmp=path.join(dir,`pending-${randomUUID()}.json`);await fs.writeFile(tmp,JSON.stringify(p));await fs.rename(tmp,path.join(dir,'project.json'));return p;}
async function applyStudioResults(job,revision){return exclusive(job.projectId,async()=>{
  const p=await load(job.projectId);
  if(p.runs.some(r=>r.jobId===job.id)){if(!job.applied){job.applied=true;await atomicJson(path.join(data,'jobs',job.id+'.json'),job);}return p;}
  if(p.revision!==revision)fail(409,'主画布已更新，请重新读取后加入结果');
  let index=0;for(const result of job.assets){const a=await loadAsset(data,result.id);if(!p.assets.some(x=>x.id===a.id))p.assets.push(a);if(a.type==='text/plain')continue;const type=a.type.split('/')[0];p.nodes.push(makeNode(a.type==='model/gltf-binary'?'scene':['image','video','audio'].includes(type)?type:'image',150+(index%3)*350,100+Math.ceil(p.nodes.length/3)*300,{title:a.name.slice(0,120),assetId:a.id,text:job.input.studio?.prompt||'',params:job.kind==='runninghub'?{cloudWorkflowId:job.recipeId}:{...job.input.studio.config}}));index++;}
  const textResults=job.textResults||[];for(const result of textResults)p.nodes.push(makeNode('text',150+(index%3)*350,100+Math.ceil(p.nodes.length/3)*300,{title:String(result.title||job.name||'文字结果').slice(0,120),text:result.text})),index++;
  p.runs.push({id:randomUUID(),jobId:job.id,status:'completed',kind:job.kind==='runninghub'?'cloud-generation':'studio-generation',assetIds:job.assets.map(a=>a.id),textIds:textResults.map(r=>r.id),assetReferences:imageAssetReferences(p,job.assets,jobReferenceAssetIds(job)),createdAt:new Date().toISOString()});p.revision++;p.updatedAt=new Date().toISOString();validateProject(p);await save(p);job.applied=true;await atomicJson(path.join(data,'jobs',job.id+'.json'),job);return p;
});}
async function list(){const ids=await fs.readdir(path.join(data,'projects'));const ps=await Promise.all(ids.map(id=>load(id,{metadata:true}).catch(()=>null)));return ps.filter(Boolean).map(({id,name,updatedAt,nodes,shots,archived})=>({id,name,updatedAt,nodes:nodes.length,shots:shots.length,archived})).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
async function serveFile(req,res,file,type){const st=await fs.stat(file);const range=req.headers.range;res.setHeader('Content-Type',type);res.setHeader('Accept-Ranges','bytes');res.setHeader('X-Content-Type-Options','nosniff');if(range){const m=/^bytes=(\d+)-(\d*)$/.exec(range);if(!m)fail(416,'请求范围无效');const start=Number(m[1]),end=Math.min(m[2]?Number(m[2]):st.size-1,st.size-1);if(start>end||start>=st.size)fail(416,'请求范围无效');res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${st.size}`,'Content-Length':end-start+1});if(req.method==='HEAD')return res.end();const handle=await fs.open(file);handle.createReadStream({start,end,autoClose:true}).pipe(res);}else{res.setHeader('Content-Length',st.size);res.writeHead(200);if(req.method==='HEAD')return res.end();const handle=await fs.open(file);handle.createReadStream().pipe(res);}}
const server=http.createServer({requestTimeout:3600000},(req,res)=>nativeMediaRequests.run({header:req.headers[NATIVE_MEDIA_SESSION_HEADER],method:req.method,pathname:''},async()=>{try{
  const host=req.headers.host;
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host))fail(403,'仅允许本机访问');
  const origin=req.headers.origin;
  const u=new URL(req.url,'http://'+host),parts=u.pathname.split('/').filter(Boolean);
  nativeMediaRequests.getStore().pathname=u.pathname;
  const chromeOrigin=typeof origin==='string'&&/^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  const chromeImportRoute=u.pathname==='/api/chrome-import';
  const chromeHealthRoute=u.pathname==='/api/health'&&req.method==='GET';
  const chromeClassificationModelsRoute=u.pathname==='/api/chrome-import/classification-models';
  const chromeAssetClassificationRoute=/^\/api\/assets\/[a-zA-Z0-9_-]{1,100}\/classify$/.test(u.pathname);
  const allowChromeOrigin=chromeOrigin&&(chromeImportRoute||chromeHealthRoute||chromeClassificationModelsRoute||chromeAssetClassificationRoute);
  if(origin&&!['http://127.0.0.1:'+port,'http://localhost:'+port].includes(origin)&&!allowChromeOrigin)fail(403,'来源不受信任');
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  if(allowChromeOrigin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
  if((chromeImportRoute||chromeClassificationModelsRoute||chromeAssetClassificationRoute)&&req.method==='OPTIONS'){
    const allowedMethod=chromeClassificationModelsRoute?'GET':'POST';
    if(!allowChromeOrigin||req.headers['access-control-request-method']!==allowedMethod)fail(403,'只允许镜场 Chrome 扩展执行已授权的素材操作');
    const requested=(req.headers['access-control-request-headers']||'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);if(requested.some(h=>h!=='content-type'))fail(403,'素材导入请求头无效');
    res.writeHead(204,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':allowedMethod+', OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600',...(req.headers['access-control-request-private-network']==='true'?{'Access-Control-Allow-Private-Network':'true'}:{}),'Vary':'Origin'});return res.end();
  }
  if(chromeClassificationModelsRoute&&req.method==='GET'){
    const state=await platforms.list(),models=[];
    for(const platform of state.platforms.filter(item=>item.protocol==='openai-compatible')){
      let endpoint;try{endpoint=new URL(platform.baseUrl);}catch{continue;}
      for(const model of platform.models.filter(item=>item.category==='chat'&&item.referenceSupport===true))models.push({platformId:platform.id,platformName:platform.name,modelId:model.id,modelName:model.label||model.id,origin:endpoint.origin,local:endpoint.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)});
    }
    return json(res,200,{models});
  }
  if(u.pathname.startsWith('/api/')){res.setHeader(NATIVE_MEDIA_SESSION_HEADER,nativeMediaSessionToken(nativeMediaSession(smartGroupStoredMediaCandidate)));if(u.pathname!=='/api/health')assertNativeMediaSession(req.headers[NATIVE_MEDIA_SESSION_HEADER],{enabled:smartGroupStoredMediaCandidate,pathname:u.pathname,method:req.method});}
  if(u.pathname==='/api/health')return json(res,200,{ok:true,nativeMediaSession:nativeMediaSession(smartGroupStoredMediaCandidate),...await directorProvider.health(config),version:appVersion,runtimeInstance:/^[a-f0-9-]{36}$/.test(process.env.JINGCHANG_RUNTIME_INSTANCE||'')?process.env.JINGCHANG_RUNTIME_INSTANCE:null,capabilities:{nativeBranchRouting:true,nativeCascade:true,nativeCascadePromptBatch:true,nativeCascadeUpscale:true,nativeModelscopeBatch:true,taskHistoryArchive:true,readOnlyLoraHistory:true,largeRenderAssetImport:true,nativeLibraryImport:true,assetClassificationReceipts:true,assetClassificationHistory:true,assetClassificationBatches:true,apimartMaterials:true,jimengCliTasks:true,jimengCanvasContext:true,jimengBoundedResultQueries:true,jimengStudioProtocol:true,jimengAccountControls:true,assetCaptions:true,promptCatalog:true,codexChatTasks:true,geminiCliChats:true,geminiCliConversations:true,geminiCliCanvasLlm:true,canvasArrangeSelection:true,nativeInputGroups:true,inputGroupMembership:true,smartGroupStoredMedia:smartGroupStoredMediaCandidate,nativeMediaVersions:smartGroupStoredMediaCandidate,smartGroupLifecycle:smartGroupStoredMediaCandidate,smartGroupGestures:smartGroupStoredMediaCandidate,smartCanvasCtrlDrag:smartGroupStoredMediaCandidate,canvasPointerPaste:smartGroupStoredMediaCandidate,clipboardPastePaging:smartGroupStoredMediaCandidate,smartGroupThumbnailDrag:smartGroupStoredMediaCandidate,codexCanvasLlm:true,codexConversations:true,libraryCrops:true,nativePromptLibraries:true}});
  if(u.pathname==='/api/miao-credentials/status'&&req.method==='GET')return json(res,200,await localMiaoCredentialService().status());
  if(u.pathname==='/api/director/status'&&req.method==='GET')return json(res,200,await directorProvider.status({refresh:true,provider:u.searchParams.get('provider')||(remoteDirector(config.agentProvider)?config.agentProvider:'deepseek')}));
  if(u.pathname==='/api/native-canvas/imports'&&req.method==='POST')return json(res,201,await nativeCanvas.inspect(req,{requestId:u.searchParams.get('requestId'),name:u.searchParams.get('name')}));
  if(u.pathname==='/api/native-canvas/imports'&&req.method==='GET')return json(res,200,await nativeCanvas.list());
  if(parts[0]==='api'&&parts[1]==='native-canvas'&&parts[2]==='imports'&&validId(parts[3])){
    if(parts.length===4&&req.method==='GET')return json(res,200,await nativeCanvas.get(parts[3]));
    if(parts.length===5&&parts[4]==='library'&&req.method==='POST')return json(res,201,await nativeCanvas.save(parts[3],await jsonBody(req)));
  }
  if(u.pathname==='/api/native-canvas/export'&&req.method==='POST')return json(res,201,await nativeCanvas.exportFile(await jsonBody(req)));
  if(parts.length===5&&parts[0]==='api'&&parts[1]==='native-canvas'&&parts[2]==='exports'&&validId(parts[3])&&parts[4]==='download'&&['GET','HEAD'].includes(req.method)){const file=await nativeCanvas.download(parts[3]);res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(file.name));return await serveFile(req,res,file.file,file.type);}
  if(u.pathname==='/api/library-crops/preview'&&req.method==='POST')return json(res,200,await libraryCrops.preview(await jsonBody(req)));
  if(u.pathname==='/api/library-crops'&&req.method==='POST')return json(res,202,await libraryCrops.start(await jsonBody(req)));
  if(u.pathname==='/api/library-crops'&&req.method==='GET')return json(res,200,await libraryCrops.list(u.searchParams.get('projectId')));
  if(parts[0]==='api'&&parts[1]==='library-crops'&&validId(parts[2])){
    if(parts.length===3&&req.method==='GET')return json(res,200,await libraryCrops.get(parts[2],u.searchParams.get('projectId')));
    if(parts.length===4&&req.method==='POST'){const b=await jsonBody(req);if(parts[3]==='resume')return json(res,202,await libraryCrops.resume(parts[2],b));if(parts[3]==='cancel')return json(res,200,await libraryCrops.cancel(parts[2],b.projectId));if(parts[3]==='apply')return json(res,200,await libraryCrops.apply(parts[2],b));}
  }
  if(u.pathname==='/api/asset-catalog'&&req.method==='GET')return json(res,200,await assetCatalog.list());
  if(u.pathname==='/api/native-library-imports'&&req.method==='GET')return json(res,200,await nativeLibraryImports.list(u.searchParams.get('projectId')));
  if(u.pathname==='/api/native-library-imports/preview'&&req.method==='POST'){
    const input=await jsonBody(req);return json(res,201,await abortableRequest(req,res,signal=>nativeLibraryImports.preview(input,{signal})));
  }
  if(parts[0]==='api'&&parts[1]==='native-library-imports'&&validId(parts[2])&&parts[2]!=='preview'){
    if(parts.length===3&&req.method==='GET')return json(res,200,await nativeLibraryImports.inspect(parts[2],u.searchParams.get('projectId')));
    if(parts.length===4&&parts[3]==='import'&&req.method==='POST'){
      const input=await jsonBody(req);return json(res,200,await abortableRequest(req,res,signal=>nativeLibraryImports.import(parts[2],input,{signal})));
    }
  }
  if(u.pathname==='/api/asset-library-backups'){
    if(req.method==='GET')return json(res,200,await libraryBackups.list(u.searchParams.get('projectId')));
    if(req.method==='POST')return json(res,202,await libraryBackups.start(await jsonBody(req)));
  }
  if(parts[0]==='api'&&parts[1]==='asset-library-backups'&&parts[2]==='imports'){
    if(parts.length===3&&req.method==='GET')return json(res,200,await libraryBackups.listImports(u.searchParams.get('projectId')));
    if(parts.length===3&&req.method==='POST')return json(res,201,await libraryBackups.upload(req,{requestId:u.searchParams.get('requestId'),projectId:u.searchParams.get('projectId')}));
    if(validId(parts[3])&&parts.length===4&&req.method==='GET')return json(res,200,await libraryBackups.getImport(parts[3],u.searchParams.get('projectId')));
    if(validId(parts[3])&&parts.length===5&&parts[4]==='restore'&&req.method==='POST')return json(res,202,await libraryBackups.start(await jsonBody(req),parts[3]));
  }
  if(parts[0]==='api'&&parts[1]==='asset-library-backups'&&validId(parts[2])&&parts[2]!=='imports'){
    if(parts.length===3&&req.method==='GET')return json(res,200,await libraryBackups.get(parts[2],u.searchParams.get('projectId')));
    if(parts.length===4&&parts[3]==='download'&&['GET','HEAD'].includes(req.method)){const file=await libraryBackups.download(parts[2]);res.setHeader('Content-Disposition','attachment; filename=assets.jingchang-library');return await serveFile(req,res,file,'application/octet-stream');}
    if(parts.length===4&&parts[3]==='resume'&&req.method==='POST')return json(res,202,await libraryBackups.resume(parts[2],await jsonBody(req)));
    if(parts.length===4&&parts[3]==='cancel'&&req.method==='POST')return json(res,200,await libraryBackups.cancel(parts[2],(await jsonBody(req)).projectId));
  }
  if(u.pathname==='/api/asset-catalog/libraries'&&req.method==='POST')return json(res,201,await assetCatalog.createLibrary(await jsonBody(req)));
  if(u.pathname==='/api/asset-catalog/copy'&&req.method==='POST')return json(res,202,await assetCatalog.start(await jsonBody(req)));
  if(u.pathname==='/api/asset-catalog/items/move'&&req.method==='POST')return json(res,200,await assetCatalog.move(await jsonBody(req)));
  if(u.pathname==='/api/asset-catalog/items/archive'&&req.method==='POST')return json(res,200,await assetCatalog.archiveItems(await jsonBody(req)));
  if(u.pathname==='/api/asset-catalog/workflows'&&req.method==='POST')return json(res,201,await assetCatalog.addWorkflow(await jsonBody(req)));
  if(u.pathname==='/api/asset-catalog/workflows/import'&&req.method==='POST')return json(res,201,await assetCatalog.importWorkflow(req,{requestId:u.searchParams.get('requestId'),libraryId:u.searchParams.get('libraryId'),folderId:u.searchParams.get('folderId'),name:u.searchParams.get('name'),revision:Number(u.searchParams.get('revision'))}));
  if(u.pathname==='/api/asset-catalog/insertions'&&req.method==='GET')return json(res,200,await assetCatalog.listInsertions(u.searchParams.get('projectId')));
  if(parts.length===4&&parts[0]==='api'&&parts[1]==='asset-catalog'&&parts[2]==='insertions'&&validId(parts[3])&&req.method==='GET')return json(res,200,await assetCatalog.getInsertion(parts[3],u.searchParams.get('projectId')));
  if(parts[0]==='api'&&parts[1]==='asset-catalog'&&parts[2]==='libraries'&&validId(parts[3])){
    if(parts.length===4&&req.method==='PATCH')return json(res,200,await assetCatalog.renameLibrary(parts[3],await jsonBody(req)));
    if(parts.length===5&&parts[4]==='archive'&&req.method==='POST')return json(res,200,await assetCatalog.archiveLibrary(parts[3],await jsonBody(req)));
    if(parts.length===5&&parts[4]==='folders'&&req.method==='POST')return json(res,201,await assetCatalog.createFolder(parts[3],await jsonBody(req)));
    if(parts.length===6&&parts[4]==='folders'&&validId(parts[5])&&req.method==='PATCH')return json(res,200,await assetCatalog.renameFolder(parts[3],parts[5],await jsonBody(req)));
    if(parts.length===7&&parts[4]==='folders'&&validId(parts[5])&&parts[6]==='archive'&&req.method==='POST')return json(res,200,await assetCatalog.archiveFolder(parts[3],parts[5],await jsonBody(req)));
  }
  if(parts[0]==='api'&&parts[1]==='asset-catalog'&&parts[2]==='items'&&validId(parts[3])){
    if(parts.length===4&&req.method==='GET')return json(res,200,await assetCatalog.details(parts[3]));
    if(parts.length===4&&req.method==='PATCH')return json(res,200,await assetCatalog.renameItem(parts[3],await jsonBody(req)));
    if(parts.length===5&&parts[4]==='open-project'&&req.method==='POST')return json(res,201,await assetCatalog.reuseCanvas(parts[3],await jsonBody(req)));
    if(parts.length===5&&parts[4]==='insert'&&req.method==='POST')return json(res,200,await assetCatalog.insertCanvas(parts[3],await jsonBody(req)));
    if(parts.length===5&&parts[4]==='download'&&['GET','HEAD'].includes(req.method)){const file=await assetCatalog.download(parts[3]);res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(file.name));return await serveFile(req,res,file.file,file.type);}
  }
  if(u.pathname==='/api/library-copies'&&req.method==='GET')return json(res,200,await assetCatalog.listJobs(u.searchParams.get('projectId')));
  if(parts[0]==='api'&&parts[1]==='library-copies'&&validId(parts[2])){
    if(parts.length===3&&req.method==='GET')return json(res,200,await assetCatalog.get(parts[2],u.searchParams.get('projectId')));
    if(parts.length===4&&req.method==='POST'){const b=await jsonBody(req);if(parts[3]==='resume')return json(res,202,await assetCatalog.resume(parts[2],b));if(parts[3]==='cancel')return json(res,200,await assetCatalog.cancel(parts[2],b.projectId));if(parts[3]==='apply')return json(res,200,await assetCatalog.apply(parts[2],b));}
  }
  if(u.pathname==='/api/classification-batches/preview'&&req.method==='POST')return json(res,200,await classificationBatches.preview(await jsonBody(req)));
  if(u.pathname==='/api/classification-batches'&&req.method==='GET')return json(res,200,await classificationBatches.list({projectId:u.searchParams.get('projectId'),sourceImportId:u.searchParams.get('sourceImportId')||undefined}));
  if(u.pathname==='/api/classification-batches'&&req.method==='POST'){const b=await jsonBody(req);try{return json(res,202,await classificationBatches.start(b));}finally{b.apiKey='';b.prompt='';}}
  if(parts[0]==='api'&&parts[1]==='classification-batches'&&validId(parts[2])){
    if(parts.length===3&&req.method==='GET')return json(res,200,await classificationBatches.get(parts[2],u.searchParams.get('projectId')));
    if(parts.length===4&&req.method==='POST'){const b=await jsonBody(req);try{if(parts[3]==='apply')return json(res,200,await classificationBatches.apply(parts[2],b.projectId));if(parts[3]==='resume')return json(res,202,await classificationBatches.resume(parts[2],b));if(parts[3]==='cancel')return json(res,200,await classificationBatches.cancel(parts[2],b.projectId));}finally{b.apiKey='';b.prompt='';}}
  }
  if(u.pathname==='/api/asset-classification-tasks'&&req.method==='GET')return json(res,200,await assetClassification.list({assetId:u.searchParams.get('assetId')||undefined,projectId:u.searchParams.get('projectId')||undefined}));
  if(parts[0]==='api'&&parts[1]==='asset-classification-tasks'&&validId(parts[2])){
    if(parts.length===3&&req.method==='GET')return json(res,200,await assetClassification.get(parts[2]));
    if(parts.length===4&&parts[3]==='cancel'&&req.method==='POST'){await jsonBody(req);return json(res,200,await assetClassification.cancel(parts[2]));}
  }
  if(u.pathname==='/api/shared-folders'&&req.method==='GET')return json(res,200,await sharedFolders.list());
  if(u.pathname==='/api/shared-folders'&&req.method==='POST')return json(res,201,await sharedFolders.register(await jsonBody(req)));
  if(u.pathname==='/api/shared-folders/import'&&req.method==='POST')return json(res,202,await sharedFolders.start(await jsonBody(req)));
  if(parts[0]==='api'&&parts[1]==='shared-folders'&&validId(parts[2])){
    if(parts.length===3&&req.method==='DELETE')return json(res,200,await sharedFolders.disable(parts[2]));
    if(parts.length===4&&parts[3]==='tree'&&req.method==='GET')return json(res,200,await sharedFolders.tree(parts[2]));
    if(parts.length===4&&parts[3]==='file'&&['GET','HEAD'].includes(req.method))return await serveSharedMedia(req,res,await sharedFolders.openFile(parts[2],u.searchParams.get('path'),u.searchParams.get('fingerprint')));
  }
  if(u.pathname==='/api/shared-folder-imports'&&req.method==='GET')return json(res,200,await sharedFolders.listImports(u.searchParams.get('projectId')));
  if(parts[0]==='api'&&parts[1]==='shared-folder-imports'&&validId(parts[2])){
    if(parts.length===3&&req.method==='GET')return json(res,200,await sharedFolders.get(parts[2],u.searchParams.get('projectId')));
    if(parts.length===4&&req.method==='POST'){const b=await jsonBody(req);if(parts[3]==='resume')return json(res,202,await sharedFolders.resume(parts[2],b));if(parts[3]==='cancel')return json(res,200,await sharedFolders.cancel(parts[2],b.projectId));if(parts[3]==='apply')return json(res,200,await sharedFolders.apply(parts[2],b));}
  }
  if(u.pathname==='/api/ark-credentials/status'&&req.method==='GET')return json(res,200,await arkCredentials.status());
  if(u.pathname==='/api/jimeng-tasks'&&req.method==='GET')return json(res,200,await jimengTasks.list(u.searchParams.get('projectId')));
  if(u.pathname==='/api/jimeng-tasks/context'&&req.method==='GET')return json(res,200,await jimengTasks.context(u.searchParams.get('projectId'),u.searchParams.get('nodeId')));
  if(u.pathname==='/api/jimeng-tasks/preview'&&req.method==='POST')return json(res,200,await jimengTasks.preview(await jsonBody(req)));
  if(u.pathname==='/api/jimeng-tasks'&&req.method==='POST')return json(res,202,await jimengTasks.start(await jsonBody(req)));
  if(parts[0]==='api'&&parts[1]==='jimeng-tasks'&&validId(parts[2])){
    if(parts.length===3&&req.method==='GET')return json(res,200,await jimengTasks.get(parts[2],u.searchParams.get('projectId')));
    if(parts.length===4&&req.method==='POST'){const b=await jsonBody(req);if(parts[3]==='continue-result-queries')return json(res,202,await jimengTasks.continueResultQueries(parts[2],b));if(parts[3]==='query')return json(res,202,await jimengTasks.query(parts[2],b));if(parts[3]==='cancel')return json(res,200,await jimengTasks.cancel(parts[2],b.projectId));if(parts[3]==='repair')return json(res,200,await jimengTasks.repair(parts[2],b.projectId));if(parts[3]==='apply')return json(res,200,await jimengTasks.apply(parts[2],b));}
  }
  if(u.pathname==='/api/jimeng/account'&&req.method==='GET')return json(res,200,await jimengAccount.status());
  if(u.pathname==='/api/jimeng/account/preview'&&req.method==='POST')return json(res,200,await jimengAccount.preview(await jsonBody(req)));
  if(u.pathname==='/api/jimeng/account/requests'&&req.method==='POST')return json(res,202,await jimengAccount.start(await jsonBody(req)));
  if(parts.length===5&&parts.slice(0,4).join('/')==='api/jimeng/account/requests'&&validId(parts[4])&&req.method==='GET')return json(res,200,await jimengAccount.get(parts[4]));
  if(parts.length===6&&parts.slice(0,4).join('/')==='api/jimeng/account/requests'&&validId(parts[4])&&parts[5]==='stop'&&req.method==='POST')return json(res,200,await jimengAccount.stop(parts[4]));
  if(parts.length===6&&parts.slice(0,4).join('/')==='api/jimeng/account/sessions'&&validId(parts[4])&&parts[5]==='forget'&&req.method==='POST')return json(res,200,jimengAccount.forget(parts[4]));
  if(u.pathname==='/api/codex-chats/program'&&req.method==='GET')return json(res,200,await codexChats.program());
  if(u.pathname==='/api/codex-chats'&&req.method==='GET')return json(res,200,await codexChats.list(u.searchParams.get('projectId')));
  if(u.pathname==='/api/codex-chats/preview'&&req.method==='POST')return json(res,200,await codexChats.preview(await jsonBody(req)));
  if(u.pathname==='/api/codex-chats'&&req.method==='POST'){const b=await jsonBody(req);try{return json(res,202,await codexChats.start(b));}finally{b.apiKey='';}}
  if(parts[0]==='api'&&parts[1]==='codex-chats'&&validId(parts[2])){
   if(parts.length===3&&req.method==='GET')return json(res,200,await codexChats.get(parts[2],u.searchParams.get('projectId')));
   if(parts.length===4&&req.method==='POST'){const b=await jsonBody(req);if(parts[3]==='stop')return json(res,200,await codexChats.stop(parts[2],b.projectId));if(parts[3]==='apply')return json(res,200,await codexChats.apply(parts[2],b));}
  }
  if(u.pathname==='/api/gemini-cli-chats/program'&&req.method==='GET')return json(res,200,await geminiCliChats.program());
  if(u.pathname==='/api/gemini-cli-chats'&&req.method==='GET')return json(res,200,await geminiCliChats.list(u.searchParams.get('projectId')));
  if(u.pathname==='/api/gemini-cli-chats/preview'&&req.method==='POST')return json(res,200,await geminiCliChats.preview(await jsonBody(req)));
  if(u.pathname==='/api/gemini-cli-chats'&&req.method==='POST'){const b=await jsonBody(req);try{return json(res,202,await geminiCliChats.start(b));}finally{b.apiKey='';}}
  if(parts[0]==='api'&&parts[1]==='gemini-cli-chats'&&validId(parts[2])){
   if(parts.length===3&&req.method==='GET')return json(res,200,await geminiCliChats.get(parts[2],u.searchParams.get('projectId')));
   if(parts.length===4&&req.method==='POST'){const b=await jsonBody(req);if(parts[3]==='stop')return json(res,200,await geminiCliChats.stop(parts[2],b.projectId));if(parts[3]==='apply')return json(res,200,await geminiCliChats.apply(parts[2],b));}
  }
  if(u.pathname==='/api/local-cli'&&req.method==='GET')return json(res,200,{tools:await localCliStatuses()});
  if(parts[0]==='api'&&['codex','gemini-cli','jimeng'].includes(parts[1])&&['version','help'].includes(parts[2])&&parts.length===3&&req.method==='POST'){
    const payload=await jsonBody(req),controller=new AbortController(),abort=()=>controller.abort();res.once('close',abort);
    try{return json(res,200,await cliInfo.read(parts[1],parts[2],payload,{signal:controller.signal}));}finally{res.removeListener('close',abort);}
  }
  if(u.pathname==='/api/codex/status'&&req.method==='GET')return json(res,200,await localCliStatus('codex'));
  if(u.pathname==='/api/gemini-cli/status'&&req.method==='GET')return json(res,200,await localCliStatus('gemini-cli'));
  if(u.pathname==='/api/jimeng/status'&&req.method==='GET')return json(res,200,await localCliStatus('jimeng'));
  if(u.pathname==='/api/project-bundles/inspect'&&req.method==='POST')return json(res,201,await projectBundles.upload(req));
  if(u.pathname==='/api/task-history-archives/inspect'&&req.method==='POST')return json(res,201,await abortableRequest(req,res,signal=>taskHistoryArchives.upload(req,{signal})));
  if(u.pathname==='/api/task-history-archives'&&req.method==='GET')return json(res,200,await taskHistoryArchives.listArchives(u.searchParams.get('projectId')));
  if(parts[0]==='api'&&parts[1]==='task-history-archives'){
    if(parts.length===5&&parts[2]==='exports'&&validId(parts[3])&&parts[4]==='download'&&['GET','HEAD'].includes(req.method)){const file=await taskHistoryArchives.download(parts[3]);res.setHeader('Content-Disposition','attachment; filename=project.jhistory');return await serveFile(req,res,file,'application/octet-stream');}
    if(parts.length===5&&parts[2]==='imports'&&validId(parts[3])){
      if(parts[4]==='preview'&&req.method==='GET')return json(res,200,await taskHistoryArchives.readPreview(parts[3]));
      if(parts[4]==='import'&&req.method==='POST'){const b=await jsonBody(req);return json(res,201,await abortableRequest(req,res,signal=>taskHistoryArchives.importArchive(parts[3],{previewDigest:b.previewDigest,signal})));}
    }
    if(parts.length===3&&validId(parts[2])&&req.method==='GET')return json(res,200,await taskHistoryArchives.readArchive(parts[2],{projectId:u.searchParams.get('projectId')}));
    if(parts.length===5&&validId(parts[2])&&parts[3]==='files'&&validId(parts[4])&&['GET','HEAD'].includes(req.method)){const file=await taskHistoryArchives.archiveFile(parts[2],parts[4],{projectId:u.searchParams.get('projectId')});res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(file.name));return await serveFile(req,res,file.file,'application/octet-stream');}
  }
  if(parts[0]==='api'&&parts[1]==='project-bundles'&&parts[2]==='exports'&&validId(parts[3])&&parts[4]==='download'&&['GET','HEAD'].includes(req.method)){const file=await projectBundles.download(parts[3]);res.setHeader('Content-Disposition','attachment; filename=project.jingchang');return await serveFile(req,res,file,'application/octet-stream');}
  if(parts[0]==='api'&&parts[1]==='project-bundles'&&validId(parts[2])&&parts[3]==='import'&&req.method==='POST')return json(res,201,await projectBundles.importBundle(parts[2]));
  if(u.pathname==='/api/chat-documents/import'&&req.method==='POST')return json(res,201,await importChatDocument({data,bytes:await body(req,DOCUMENT_LIMIT),name:u.searchParams.get('name')||''}));
  if(u.pathname==='/api/chat-media/prepare'&&req.method==='POST')return json(res,200,await prepareChatMedia({...await jsonBody(req),data}));
  if(u.pathname==='/api/conversations'&&req.method==='GET')return json(res,200,await conversations.list(u.searchParams.get('projectId')));
  if(u.pathname==='/api/conversations'&&req.method==='POST')return json(res,201,await conversations.create(await jsonBody(req)));
  if(parts[0]==='api'&&parts[1]==='conversations'&&validId(parts[2])){
    if(parts.length===3&&req.method==='GET')return json(res,200,await conversations.get(parts[2]));
    if(parts.length===3&&req.method==='PUT')return json(res,200,await conversations.rename(parts[2],await jsonBody(req)));
    if(parts[3]==='agent-preview'&&req.method==='POST')return json(res,200,await conversations.agentPreview(parts[2],await jsonBody(req)));
    if(parts[3]==='gemini-cli-preview'&&req.method==='POST')return json(res,200,await conversations.geminiCliPreview(parts[2],await jsonBody(req)));
    if(parts[3]==='recover-gemini-cli'&&req.method==='POST')return json(res,200,await conversations.recoverOriginalGeminiCli(parts[2],await jsonBody(req)));
    if(parts[3]==='codex-preview'&&req.method==='POST')return json(res,200,await conversations.codexPreview(parts[2],await jsonBody(req)));
    if(parts[3]==='recover-codex'&&req.method==='POST')return json(res,200,await conversations.recoverOriginal(parts[2],await jsonBody(req)));
    if(parts[3]==='messages'&&req.method==='POST'){const b=await jsonBody(req);try{return json(res,202,await conversations.send(parts[2],b));}finally{b.apiKey='';if(b.agent&&typeof b.agent==='object')b.agent.imageApiKey='';}}
    if(parts[3]==='apply'&&req.method==='POST')return json(res,200,await conversations.apply(parts[2],await jsonBody(req)));
  }
  if(u.pathname==='/api/loras/files'&&req.method==='GET')return json(res,200,await loras.localFiles(u.searchParams.get('projectId')));
  if(u.pathname==='/api/loras/import'&&req.method==='POST')return json(res,201,await loras.importFile(req,{name:u.searchParams.get('name'),size:Number(req.headers['content-length'])}));
  if(u.pathname==='/api/loras'&&req.method==='GET')return json(res,200,await loras.list(u.searchParams.get('projectId')));
  if(u.pathname==='/api/loras/prepare'&&req.method==='POST'){const b=await jsonBody(req);try{return json(res,201,await loras.prepare(b));}finally{b.apiKey='';}}
  if(parts[0]==='api'&&parts[1]==='loras'&&validId(parts[2])){
    if(parts.length===3&&req.method==='GET')return json(res,200,await loras.get(parts[2]));
    if(parts.length===4&&parts[3]==='attach'&&req.method==='POST')return json(res,200,await loras.attach(parts[2],await jsonBody(req)));
    if(parts.length===4&&parts[3]==='confirm'&&req.method==='POST')return json(res,202,await loras.confirm(parts[2],await jsonBody(req)));
  }
  if(u.pathname==='/api/cloud-models'&&req.method==='GET')return json(res,200,u.searchParams.has('id')?{fields:rhModelFields(u.searchParams.get('id')),catalogVersion:RH_CATALOG_VERSION}:rhModelCatalog());
  if(u.pathname==='/api/cloud-workflows/account'&&req.method==='POST'){const b=await jsonBody(req);try{return json(res,200,await cloudWorkflows.account(b));}finally{b.apiKey='';}}
  if(u.pathname==='/api/cloud-workflows/discover'&&req.method==='POST'){const b=await jsonBody(req);try{return json(res,200,await cloudWorkflows.discover(b));}finally{b.apiKey='';}}
  if(u.pathname==='/api/cloud-workflows'&&req.method==='GET')return json(res,200,await cloudWorkflows.list(u.searchParams.get('projectId')));
  if(u.pathname==='/api/cloud-workflows'&&req.method==='POST')return json(res,201,await cloudWorkflows.create(await jsonBody(req)));
  if(u.pathname==='/api/cloud-workflows/fields/preview'&&req.method==='POST'){const b=await jsonBody(req);return json(res,200,{fields:importNativeRhFields(b.nativeConfig),persisted:false});}
  if(parts[0]==='api'&&parts[1]==='cloud-workflows'&&validId(parts[2])){
    const id=parts[2];
    if(parts.length===3&&req.method==='GET')return json(res,200,await cloudWorkflows.get(id));
    if(parts.length===3&&req.method==='PUT')return json(res,200,await cloudWorkflows.save(id,await jsonBody(req)));
    if(parts.length===4&&parts[3]==='preview'&&req.method==='GET')return json(res,200,await cloudWorkflows.preview(id));
    if(parts.length===4&&parts[3]==='jobs'&&req.method==='GET')return json(res,200,await cloudWorkflows.jobs(id));
    if(req.method==='POST'){const b=await jsonBody(req);try{
      if(parts.length===4&&parts[3]==='run')return json(res,202,await cloudWorkflows.start(id,b));
      if(parts.length===6&&parts[3]==='jobs'&&validId(parts[4])){
        if(parts[5]==='resume')return json(res,202,await cloudWorkflows.resume(id,parts[4],b));
        if(parts[5]==='apply')return json(res,200,await cloudWorkflows.apply(id,parts[4],b));
      }
    }finally{b.apiKey='';}}
  }
  if(u.pathname==='/api/public-media/profiles'&&req.method==='GET')return json(res,200,publicMediaProfiles());
  if(u.pathname==='/api/public-media'&&req.method==='GET')return json(res,200,await publicMedia.list(u.searchParams.get('projectId')));
  if(parts[0]==='api'&&parts[1]==='public-media'){
    if(parts.length===3&&validId(parts[2])&&req.method==='GET')return json(res,200,await publicMedia.get(parts[2],u.searchParams.get('projectId')));
    if(req.method==='POST'){
      const b=await jsonBody(req);
      if(parts.length===3&&parts[2]==='preview')return json(res,200,await publicMedia.preview(b));
      if(parts.length===3&&parts[2]==='start')return json(res,202,await publicMedia.start(b));
      if(parts.length===4&&validId(parts[2])&&parts[3]==='reference')return json(res,200,await publicMedia.reference(parts[2],b.projectId));
    }
  }
  if(u.pathname==='/api/apimart-materials'&&req.method==='GET')return json(res,200,await apimartMaterials.list(u.searchParams.get('projectId')));
  if(u.pathname==='/api/apimart-materials/preview'&&req.method==='POST')return json(res,200,await apimartMaterials.preview(await jsonBody(req)));
  if(u.pathname==='/api/apimart-materials'&&req.method==='POST'){const b=await jsonBody(req);try{return json(res,202,await apimartMaterials.start(b));}finally{b.apiKey='';}}
  if(parts[0]==='api'&&parts[1]==='apimart-materials'&&validId(parts[2])){
    if(parts.length===3&&req.method==='GET')return json(res,200,await apimartMaterials.get(parts[2],u.searchParams.get('projectId')));
    if(parts.length===4&&req.method==='POST'){const b=await jsonBody(req);try{if(parts[3]==='query')return json(res,200,await apimartMaterials.query(parts[2],b));if(parts[3]==='cancel')return json(res,200,await apimartMaterials.cancel(parts[2],b.projectId));}finally{b.apiKey='';}}
  }
  if(u.pathname==='/api/ark-assets'&&req.method==='GET')return json(res,200,await arkAssets.list(u.searchParams.get('projectId')));
  if(parts[0]==='api'&&parts[1]==='ark-assets'&&req.method==='POST'){
    const b=await jsonBody(req);try{
      if(parts.length===3&&parts[2]==='preview')return json(res,200,await arkAssets.preview(b));
      if(parts.length===3&&parts[2]==='create')return json(res,201,await arkAssets.create(b));
      if(parts.length===3&&parts[2]==='browse')return json(res,200,await arkAssets.browse(b));
      if(parts.length===3&&parts[2]==='remember')return json(res,200,await arkAssets.remember(b));
      if(parts.length===4&&validId(parts[2])&&parts[3]==='refresh')return json(res,200,await arkAssets.refresh(parts[2],b));
    }finally{b.accessKeyId=b.secretAccessKey='';}
  }
  if(u.pathname==='/api/studios'&&req.method==='GET')return json(res,200,await creationStudio.list(u.searchParams.get('projectId')));
  if(u.pathname==='/api/studios'&&req.method==='POST')return json(res,201,await creationStudio.create(await jsonBody(req)));
  if(u.pathname==='/api/studio-models'&&req.method==='GET')return json(res,200,{models:(studioModels[u.searchParams.get('mode')]||studioModels.video).map(id=>({id,label:id})),source:'reference-catalog',note:'参考型号，不代表当前平台已开通；可填写自定义模型。'});
  if(u.pathname==='/api/studio-catalog'&&req.method==='GET')return json(res,200,await creationStudio.catalog());
  if(u.pathname==='/api/studio-models'&&req.method==='POST'){const b=await jsonBody(req);try{return json(res,200,await creationStudio.discover(b));}finally{b.apiKey='';}}
  if(parts[0]==='api'&&parts[1]==='studios'&&validId(parts[2])){
    const id=parts[2];
    if(parts.length===3&&req.method==='GET')return json(res,200,await creationStudio.get(id));
    if(parts.length===3&&req.method==='PUT')return json(res,200,await creationStudio.save(id,await jsonBody(req)));
    if(parts.length===4&&parts[3]==='jobs'&&req.method==='GET')return json(res,200,await creationStudio.jobs(id));
    if(parts.length===4&&parts[3]==='jimeng-preview'&&req.method==='GET')return json(res,200,await creationStudio.jimengPreview(id));
    if(parts.length===4&&parts[3]==='reference-preview'&&req.method==='GET')return json(res,200,await creationStudio.preview(id));
    if(parts.length===4&&parts[3]==='generate'&&req.method==='POST'){const b=await jsonBody(req);try{return json(res,202,await creationStudio.start(id,b));}finally{b.apiKey='';}}
    if(parts.length===6&&parts[3]==='jobs'&&validId(parts[4])&&req.method==='POST'){
      const b=await jsonBody(req);try{
        if(parts[5]==='apply')return json(res,200,await creationStudio.apply(id,parts[4],b));
        if(parts[5]==='resume')return json(res,202,await creationStudio.resume(id,parts[4],b));
        if(parts[5]==='cancel')return json(res,200,await creationStudio.cancel(id,parts[4],b));
      }finally{b.apiKey='';}
    }
  }
  if(u.pathname==='/api/platforms'&&req.method==='GET')return json(res,200,await platforms.list());
  if(u.pathname==='/api/platforms'&&req.method==='PUT')return json(res,200,await platforms.save(await jsonBody(req)));
  if(u.pathname==='/api/platforms/discover'&&req.method==='POST'){const b=await jsonBody(req);try{return json(res,200,await platforms.discover(b));}finally{b.apiKey='';}}
  if(u.pathname==='/api/diagnostics'&&req.method==='GET')return json(res,200,await diagnostics({root,data,projects:await list()}));
  if(u.pathname==='/api/comfy-backends'&&req.method==='GET')return json(res,200,backendState(config));
  if(u.pathname==='/api/comfy-backends'&&req.method==='PUT'){const b=await jsonBody(req);return await exclusive('workspace-config',async()=>{const next=updateBackends(config,b);await atomicJson(path.join(data,'config.json'),next);config=next;return json(res,200,backendState(config));});}
  if(u.pathname==='/api/comfy-backends/probe'&&req.method==='POST'){const b=await jsonBody(req);if(b.consent!==true)fail(400,'请确认检查已保存的后端连接');try{return json(res,200,await inspectComfyBackend(selectBackend(config,b.backendId)));}catch{fail(400,'无法确认该ComfyUI连接，请检查地址、服务状态和网络；没有提交生成任务');}}
  if(u.pathname==='/api/config'&&req.method==='GET')return json(res,200,{...config,revision:config.revision||0});
  if(u.pathname==='/api/config'&&req.method==='PUT'){
    const b=await jsonBody(req);return await exclusive('workspace-config',async()=>{if((b.revision??0)!==(config.revision||0))fail(409,'设置已在另一窗口修改，请重新打开设置后保存');const agentProvider=b.agentProvider??config.agentProvider??'local';if(!['local','deepseek','miaoapi'].includes(agentProvider))fail(400,'助理服务无效');if(remoteDirector(agentProvider)){const state=await directorProvider.status({refresh:true,provider:agentProvider});if(!state.configured)fail(400,state.error||'DeepSeek 本机配置不可读取');}const next={...updateLegacyComfy(config,b.comfyUrl||'http://127.0.0.1:8188'),agentProvider,llmUrl:b.llmUrl?localUrl(b.llmUrl):'',llmModel:b.llmModel?textValue(b.llmModel,200,'模型名称'):''};if(!!next.llmUrl!==!!next.llmModel)fail(400,'语言模型地址和名称需同时填写');next.revision=(config.revision||0)+1;await atomicJson(path.join(data,'config.json'),next);config=next;return json(res,200,config);});
  }
  if(u.pathname==='/api/media/extract-frames'&&req.method==='POST'){const b=await jsonBody(req);return json(res,201,await extractVideoFrames({data,assetId:b.assetId,times:b.times}));}
  if(u.pathname==='/api/media/editor-source'&&req.method==='GET')return await serveFile(req,res,await editorSource({data,assetId:u.searchParams.get('assetId')}),'image/png');
  if(u.pathname==='/api/media/image-edit'&&req.method==='POST'){const b=await jsonBody(req);return json(res,201,await editImage({data,assetId:b.assetId,operations:b.operations}));}
  if(parts[0]==='api'&&parts[1]==='image-edits'&&req.method==='GET')return json(res,200,await readImageEdit(data,parts[2]));
  if(u.pathname==='/api/media/panorama'&&req.method==='POST'){const b=await jsonBody(req);return json(res,201,await capturePanorama({...b,data}));}
  if(u.pathname==='/api/media/crop'&&req.method==='POST'){const b=await jsonBody(req);return json(res,201,await cropImage({data,assetId:b.assetId,x:b.x,y:b.y,width:b.width,height:b.height}));}
  if(u.pathname==='/api/media/grid-split'&&req.method==='POST'){const b=await jsonBody(req);return json(res,201,await splitImageGrid({...b,data}));}
  if(u.pathname==='/api/media/grid-compose'&&req.method==='POST'){const b=await jsonBody(req);return json(res,201,await composeImageGrid({...b,data}));}
  if(u.pathname==='/api/assets/page'&&req.method==='GET'){
    const integerParam=(name,fallback,maximum)=>{const raw=u.searchParams.get(name);if(raw===null)return fallback;if(!/^\d+$/.test(raw))fail(400,`${name} 必须是非负整数`);const value=Number(raw);if(!Number.isSafeInteger(value)||value>maximum)fail(400,`${name} 超出允许范围`);return value;};
    const offset=integerParam('offset',0,10000000),limit=integerParam('limit',48,100),scope=u.searchParams.get('scope')||'project',projectId=u.searchParams.get('projectId')||'';
    if(!limit)fail(400,'limit 必须大于 0');if(!['project','global'].includes(scope))fail(400,'素材范围无效');
    const type=u.searchParams.get('type')||'all',category=u.searchParams.get('category')||'',search=u.searchParams.get('search')||'',smartClass=u.searchParams.get('smartClass')||'';
    if(!['all','image','video','audio','text','lora','3d'].includes(type))fail(400,'素材类型无效');if(category.length>80)fail(400,'素材分类过长');if(search.length>200)fail(400,'搜索内容不能超过 200 个字符');
    let smartDimension='',smartTag='';if(smartClass){const split=smartClass.indexOf('::');if(split<1||smartClass.length>80)fail(400,'智能分类筛选无效');smartDimension=smartClass.slice(0,split);smartTag=smartClass.slice(split+2);if(!/^[a-z0-9_-]{1,40}$/.test(smartDimension)||!smartTag||smartTag.length>24)fail(400,'智能分类筛选无效');}
    let source;
    if(scope==='global')source=(await records(path.join(data,'assets'))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    else{if(!validId(projectId))fail(400,'项目编号无效');const p=await load(projectId);source=await Promise.all((p.assets||[]).map(async a=>{try{return await loadAsset(data,a.id);}catch(e){if(e.code==='ENOENT')return a;throw e;}}));}
    const libraryId=u.searchParams.get('libraryId')||'',folderId=u.searchParams.get('folderId')||'';if(folderId&&!libraryId)fail(400,'请选择素材库');if(libraryId){const selected=await assetCatalog.selectedAssets(libraryId,folderId);source=source.filter(a=>selected.ids.has(a.id));}
    const categories=[...new Set(source.map(a=>a.category).filter(Boolean))],needle=search.toLocaleLowerCase(),classCounts=new Map();
    for(const asset of source){if(!String(asset.type||'').startsWith('image/'))continue;for(const entry of asset.classification?.flat||[]){if(!entry||typeof entry.dimension!=='string'||typeof entry.tag!=='string'||!entry.dimension||!entry.tag)continue;const key=entry.dimension+'::'+entry.tag,prev=classCounts.get(key)||{id:key,dimension:entry.dimension,label:String(entry.label||entry.dimension),tag:entry.tag,count:0};prev.count++;classCounts.set(key,prev);}}
    const smartClasses=[...classCounts.values()].sort((a,b)=>a.label.localeCompare(b.label,'zh-CN')||b.count-a.count||a.tag.localeCompare(b.tag,'zh-CN')).slice(0,200);
    const matches=source.filter(a=>{
      const flat=Array.isArray(a.classification?.flat)?a.classification.flat:[];
      const matchesClass=!smartClass||flat.some(item=>item?.dimension===smartDimension&&item?.tag===smartTag);
      const searchable=[a.name,...(a.tags||[]),a.classification?.summary||'',...(a.classification?.tags||[]),...flat.map(item=>item?.tag||'')].join(' ').toLocaleLowerCase();
      return (type==='all'||(type==='lora'?a.type==='application/x-safetensors':type==='3d'?a.type==='model/gltf-binary':a.type.startsWith(type+'/')))&&(!category||a.category===category)&&matchesClass&&(!needle||searchable.includes(needle));
    });
    return json(res,200,{items:matches.slice(offset,offset+limit),total:matches.length,sourceTotal:source.length,categories,smartClasses,offset,limit});
  }
  if(u.pathname==='/api/assets'&&req.method==='GET')return json(res,200,(await records(path.join(data,'assets'))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));
  if(u.pathname==='/api/asset-caption-batches/preview'&&req.method==='POST')return json(res,200,await captionBatches.preview(await jsonBody(req)));
  if(u.pathname==='/api/asset-caption-batches'&&req.method==='GET')return json(res,200,await captionBatches.list(u.searchParams.get('projectId')));
  if(u.pathname==='/api/asset-caption-batches'&&req.method==='POST'){const b=await jsonBody(req);try{return json(res,202,await captionBatches.start(b));}finally{b.apiKey='';}}
  if(parts[0]==='api'&&parts[1]==='asset-caption-batches'&&validId(parts[2])){
    if(parts.length===3&&req.method==='GET')return json(res,200,await captionBatches.get(parts[2],u.searchParams.get('projectId')));
    if(parts.length===4&&req.method==='POST'){const b=await jsonBody(req);try{if(parts[3]==='stop')return json(res,200,await captionBatches.stop(parts[2],b.projectId));if(parts[3]==='resume')return json(res,202,await captionBatches.resume(parts[2],b));if(parts[3]==='apply')return json(res,200,await captionBatches.apply(parts[2],b));}finally{b.apiKey='';}}
  }
  if(parts[0]==='api'&&parts[1]==='assets'&&validId(parts[2])&&parts.length===4){
    if(parts[3]==='caption'&&req.method==='GET')return json(res,200,await assetCaptions.get(parts[2]));
    if(parts[3]==='caption'&&req.method==='PATCH')return json(res,200,await assetCaptions.save(parts[2],await jsonBody(req)));
    if(parts[3]==='caption-history'&&req.method==='GET')return json(res,200,await assetCaptions.history(parts[2]));
    if(parts[3]==='caption.txt'&&req.method==='GET'){const row=await assetCaptions.get(parts[2]);if(!row.caption)fail(404,'这份图片尚未保存提示词');const name=row.name.replace(/\.[^.]+$/,'')+'.txt',encoded=encodeURIComponent(name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':"attachment; filename*=UTF-8''"+encoded,'Cache-Control':'no-store'});return res.end(row.caption.text);}
  }
  if(parts[0]==='api'&&parts[1]==='assets'&&validId(parts[2])&&parts[3]==='waveform'&&req.method==='GET'){
    const controller=new AbortController();res.once('close',()=>{if(!res.writableEnded)controller.abort();});
    return json(res,200,await audioWaveforms.preview(parts[2],controller.signal));
  }
  if(parts[0]==='api'&&parts[1]==='assets'&&validId(parts[2])&&parts[3]==='classify'&&req.method==='POST'){
    const b=await jsonBody(req);try{return await exclusive('asset-'+parts[2],async()=>json(res,200,await assetClassification.classify(parts[2],b)));}finally{b.apiKey='';b.prompt='';}
  }
  if(parts[0]==='api'&&parts[1]==='assets'&&validId(parts[2])&&req.method==='PATCH'){
    const b=await jsonBody(req);return await withAssetMetadataLock(data,parts[2],async()=>{const a=await loadAsset(data,parts[2]);a.name=textValue(b.name,200,'素材名称');a.category=String(b.category||'').slice(0,80);if(!Array.isArray(b.tags)||b.tags.length>20)fail(400,'标签数量不超过 20 个');a.tags=b.tags.map(t=>textValue(t,40,'标签'));await atomicJson(path.join(data,'assets',a.id+'.json'),a);return json(res,200,a);});
  }
  if(u.pathname==='/api/prompt-catalog'&&req.method==='GET')return json(res,200,await promptCatalog.snapshot());
  if(u.pathname==='/api/prompt-catalog/native-export/preview'&&req.method==='GET'){const libraryId=u.searchParams.get('libraryId'),r=await promptCatalog.nativeExport(libraryId?{libraryIds:[libraryId]}:{});return json(res,200,{fingerprint:r.fingerprint,report:r.report});}
  if(u.pathname==='/api/prompt-catalog/native-export'&&req.method==='GET'){const libraryId=u.searchParams.get('libraryId'),r=await promptCatalog.nativeExport(libraryId?{libraryIds:[libraryId]}:{});if(u.searchParams.get('fingerprint')!==r.fingerprint)fail(409,'导出范围已变化或尚未检查，请重新预览原版导出');const bytes=Buffer.from(JSON.stringify(r.payload,null,2)+'\n');res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="prompt_libraries.json"','Content-Length':String(bytes.length),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(bytes);}
  if(u.pathname==='/api/prompt-catalog/export'&&req.method==='GET'){const libraryId=u.searchParams.get('libraryId');return json(res,200,await promptCatalog.exportArchive(libraryId?{libraryIds:[libraryId]}:{}));}
  if(u.pathname==='/api/prompt-catalog/imports'&&req.method==='GET')return json(res,200,await promptImports.list());
  if(u.pathname==='/api/prompt-catalog/imports'&&req.method==='POST')return json(res,201,await promptImports.inspect(await jsonBody(req,34*1024**2)));
  if(parts[0]==='api'&&parts[1]==='prompt-catalog'&&parts[2]==='imports'&&validId(parts[3])){if(parts.length===5&&parts[4]==='original'&&req.method==='GET'){const r=await promptImports.original(parts[3]),bytes=Buffer.from(r.sourceText);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="prompt_libraries.original.json"','Content-Length':String(bytes.length),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Content-SHA256':r.sourceFingerprint});return res.end(bytes);}if(parts.length===4&&req.method==='GET')return json(res,200,await promptImports.preview(parts[3]));if(parts.length===5&&parts[4]==='restore'&&req.method==='POST')return json(res,200,await promptImports.restore(parts[3],await jsonBody(req)));}
  if(u.pathname==='/api/prompt-catalog/items'&&req.method==='POST')return json(res,201,await promptCatalog.createItem(await jsonBody(req)));
  if(parts[0]==='api'&&parts[1]==='prompt-catalog'&&['libraries','categories','items'].includes(parts[2])&&parts.length===4&&req.method==='POST'){const service={libraries:promptCatalog.libraries,categories:promptCatalog.categories,items:promptCatalog.items}[parts[2]];return json(res,200,await service(parts[3],await jsonBody(req)));}
  if(u.pathname==='/api/prompts'&&req.method==='GET')return json(res,200,await promptLibrary.list());
  if(u.pathname==='/api/prompts'&&req.method==='POST')return json(res,201,await promptLibrary.create(await jsonBody(req)));
  if(parts[0]==='api'&&parts[1]==='prompts'&&validId(parts[2])){
    if(parts.length===4&&parts[3]==='versions'&&req.method==='GET')return json(res,200,await promptLibrary.versions(parts[2]));
    if(parts.length===4&&parts[3]==='restore'&&req.method==='POST')return await exclusive('prompt-'+parts[2],async()=>json(res,200,await promptLibrary.restore(parts[2],await jsonBody(req))));
    if(parts.length===4&&parts[3]==='rewrite'&&req.method==='POST'){
      const b=await jsonBody(req),p=await promptLibrary.get(parts[2]);
      if(!Number.isInteger(b.revision)||b.revision!==p.revision)fail(409,'提示词已更新，请重新读取后再改写');
      const endpoint=config.llmUrl||process.env.JINGCHANG_LLM_URL,model=config.llmModel||process.env.JINGCHANG_LLM_MODEL;
      const requestModel=remoteDirector(config.agentProvider)?options=>directorProvider.completeOnce({...options,provider:config.agentProvider,requestId:b.requestId,scope:'prompt:'+p.id+':'+p.revision,consent:b.consent,authorization:b.authorization,thinking:b.thinking}):undefined;
      return json(res,200,{...await rewritePrompt({endpoint,model,sourcePrompt:p.text,instruction:b.instruction,consent:b.consent,requestModel}),revision:p.revision});
    }
    if(parts.length===3&&req.method==='GET')return json(res,200,await promptLibrary.get(parts[2]));
    if(parts.length===3&&req.method==='PUT')return await exclusive('prompt-'+parts[2],async()=>json(res,200,await promptLibrary.update(parts[2],await jsonBody(req))));
  }
  if(u.pathname==='/api/jobs'&&req.method==='GET'){
    const projectId=u.searchParams.get('projectId'),includeActive=u.searchParams.get('includeActive')==='true';
    const activeStates=new Set(['queued','running','preparing','pending','submitting','awaiting_input','awaiting-confirmation']);
    const jobs=(await Promise.all((await records(path.join(data,'jobs'))).map(j=>j.kind==='gemini-cli-chat'?geminiCliChats.summary(j.id):j.kind==='codex-chat'?codexChats.summary(j.id):j.kind==='canvas-llm'?canvasLlm.refresh(j):j.kind==='conversation'&&['codex','gemini-cli'].includes(j.input?.executor)?conversations.refresh(j):j.kind==='studio'&&j.input?.studio?.config.protocol==='jimeng'?creationStudio.refresh(j):j.kind==='canvas-run'?exclusive('resume-'+j.id,async()=>creationStudio.recoverCanvasLinks(await readJson(path.join(data,'jobs',j.id+'.json')))):j))).map(j=>['library-backup','library-restore'].includes(j.kind)?publicLibraryJob(j):publicExecutionJob(j)).filter(j=>!projectId||j.projectId===projectId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return json(res,200,jobs.filter((job,index)=>index<200||includeActive&&activeStates.has(job.status)));
  }
  if(u.pathname==='/api/workflows'&&req.method==='GET')return json(res,200,await generation.list());
  if(u.pathname==='/api/workflows'&&req.method==='POST')return json(res,201,await generation.saveTemplate(await jsonBody(req)));
  if(u.pathname==='/api/workflows/fields/preview'&&req.method==='POST')return json(res,200,await generation.previewNativeConfig(await jsonBody(req)));
  if(parts[0]==='api'&&parts[1]==='workflows'&&validId(parts[2])&&parts[3]==='config'&&req.method==='PUT'){const workflow=await generation.configure(parts[2],await jsonBody(req));await assetCatalog.workflowChanged(workflow.id);return json(res,200,workflow);}
  if(parts[0]==='api'&&parts[1]==='workflows'&&parts[2]&&req.method==='GET')return json(res,200,await generation.template(parts[2]));
  if(u.pathname==='/api/skills'&&req.method==='GET')return json(res,200,skills);
  if(u.pathname==='/api/templates'&&req.method==='GET'){const files=await fs.readdir(path.join(data,'templates'));return json(res,200,await Promise.all(files.map(async f=>JSON.parse(await fs.readFile(path.join(data,'templates',f),'utf8')))));}
  if(u.pathname==='/api/templates'&&req.method==='POST'){const b=await jsonBody(req),p=await load(b.projectId);const t={id:randomUUID(),name:String(b.name||p.name).slice(0,120),nodes:p.nodes.map(n=>{const node=structuredClone(n);node.assetId=null;if(node.params?.promptAssetIds)node.params.promptAssetIds=[];return node;}),edges:p.edges,createdAt:new Date().toISOString()};await fs.writeFile(path.join(data,'templates',t.id+'.json'),JSON.stringify(t));return json(res,201,t);}
  if(u.pathname==='/api/projects'&&req.method==='GET')return json(res,200,await list());
  if(u.pathname==='/api/projects'&&req.method==='POST'){const b=await jsonBody(req);const p=makeProject(typeof b.name==='string'?b.name:'未命名项目');if(smartGroupStoredMediaCandidate)p.settings.nativeMediaVersion=2;validateProject(p);return json(res,201,await save(p));}
  if(parts[0]==='api'&&parts[1]==='projects'&&parts[2]){
    const id=parts[2];
    if(smartGroupStoredMediaCandidate&&parts[3]==='clipboard-pastes'){if(parts.length===4&&req.method==='GET'){const paged=u.searchParams.has('limit')||u.searchParams.has('offset');if(paged&&[...u.searchParams.keys()].some(k=>!['limit','offset'].includes(k)))throw userError('粘贴记录分页参数无效');return json(res,200,await clipboardPastes.list(id,paged?Object.fromEntries(u.searchParams):undefined));}if(parts.length===4&&req.method==='POST')return json(res,200,await clipboardPastes.paste(id,await jsonBody(req)));if(parts.length===5&&req.method==='GET')return json(res,200,await clipboardPastes.get(id,parts[4]));if(parts.length===6&&parts[5]==='resume'&&req.method==='POST')return json(res,200,await clipboardPastes.resume(id,parts[4]));}
    if(smartGroupStoredMediaCandidate&&parts.length===5&&parts[3]==='smart-groups'&&req.method==='POST'){const b=await jsonBody(req);if(parts[4]==='preview')return json(res,200,await smartGroups.preview(id,b));if(parts[4]==='apply')return json(res,200,await smartGroups.apply(id,b));if(parts[4]==='reconcile')return json(res,200,await smartGroups.apply(id,b,{automatic:true}));}
    if(smartGroupStoredMediaCandidate&&parts.length===5&&parts[3]==='native-media-version'&&req.method==='POST'){const body=await jsonBody(req);if(parts[4]==='preview')return json(res,200,await nativeMediaVersions.preview(id,body));if(parts[4]==='apply')return json(res,200,await nativeMediaVersions.apply(id,body));}
    if(parts.length===5&&parts[3]==='input-groups'&&req.method==='POST'){const body=await jsonBody(req);if(parts[4]==='preview')return json(res,200,await inputGroupMembers.preview(id,body));if(parts[4]==='apply')return json(res,200,await inputGroupMembers.apply(id,body));if(parts[4]==='reconcile')return json(res,200,await inputGroupMembers.apply(id,body,{automatic:true}));}
    if(parts.length===4&&parts[3]==='task-history-archive'&&req.method==='POST'){const b=await jsonBody(req);return json(res,201,await abortableRequest(req,res,signal=>exclusive(id,()=>taskHistoryArchives.exportArchive(id,b.revision,{requestId:b.requestId,signal}))));}
    if(parts[3]==='assets'&&parts[4]==='archive'&&req.method==='POST'){
      const b=await jsonBody(req),p=await load(id),archive=await createMediaArchive({data,project:p,assetIds:b.assetIds});
      res.setHeader('Content-Type','application/zip');res.setHeader('Content-Length',archive.size);
      res.setHeader('Content-Disposition',"attachment; filename=\"jingchang-assets.zip\"; filename*=UTF-8''%E9%95%9C%E5%9C%BA-%E7%B4%A0%E6%9D%90%E7%BB%84.zip");
      res.setHeader('Cache-Control','no-store');
      archive.stream.once('error',error=>{if(!res.destroyed)res.destroy(error);});res.once('close',()=>archive.stream.destroy());archive.stream.pipe(res);return;
    }
    if(parts[3]==='bundle'&&req.method==='POST'){const b=await jsonBody(req);return json(res,201,await projectBundles.exportBundle(id,b.revision));}
    if(parts[3]==='archive'&&req.method==='POST'){const b=await jsonBody(req);if(typeof b.archived!=='boolean')fail(400,'回收站状态无效');return await exclusive(id,async()=>{const p=await load(id);if(p.revision!==b.revision)fail(409,'项目已更新，请重新打开项目库');p.archived=b.archived;p.revision++;p.updatedAt=new Date().toISOString();return json(res,200,await save(p));});}
    if(parts[3]==='image-context'&&req.method==='GET')return json(res,200,await directImages.context(await load(id),u.searchParams.get('nodeId')));
    if(parts[3]==='generate-image'&&req.method==='POST'){if([...activeJobs.values()].some(j=>j.projectId===id&&j.kind==='canvas-run'))fail(409,'画布执行中，请先完成或停止');const b=await jsonBody(req);try{return await exclusive('generate-'+id,async()=>json(res,202,await directImages.start(await load(id),b)));}catch(e){b.apiKey='';throw e;}}
    if(parts[3]==='native-flow'&&req.method==='GET'){const query=key=>u.searchParams.has(key)?u.searchParams.get(key):undefined,round=query('roundIndex');if(round!==undefined&&!/^(0|[1-9]\d?)$/.test(round))fail(400,'数据流回合筛选无效');return json(res,200,await nativeFlow.inspect(await load(id),{nodeId:query('nodeId'),jobId:query('jobId'),loopId:query('loopId'),roundIndex:round===undefined?undefined:Number(round)}));}
    if(parts[3]==='native-cascade-plan'&&req.method==='GET')return json(res,200,await cascadeRuns.plan(await load(id),{nodeId:u.searchParams.get('nodeId')||undefined}));
    if(parts[3]==='canvas-run-plan'&&req.method==='GET')return json(res,200,{steps:await canvasRuns.plan(await load(id),{nodeId:u.searchParams.get('nodeId')||undefined})});
    if(parts[3]==='canvas-run'&&req.method==='POST'){const b=await jsonBody(req);try{return await exclusive('generate-'+id,async()=>json(res,202,await (b.executionMode==='native-cascade'?cascadeRuns:canvasRuns).start(await load(id),b,selectCanvasBackends(config,b))));}finally{clearCloudCredentials(b);clearImageCredentials(b);clearLlmCredentials(b);clearStudioCredentials(b);}}
    if(parts[3]==='generate'&&req.method==='POST'){if([...activeJobs.values()].some(j=>j.projectId===id&&j.kind==='canvas-run'))fail(409,'画布执行中，请先完成或停止');const b=await jsonBody(req);return await exclusive('generate-'+id,async()=>json(res,202,await generation.start(await load(id),b,selectBackend(config,b.backendId))));}
    if(parts[3]==='apply-generation'&&req.method==='POST'){
      const b=await jsonBody(req);if(!validId(b.jobId))fail(400,'任务编号无效');return await exclusive(id,async()=>{
        const p=await load(id),job=await readJson(path.join(data,'jobs',b.jobId+'.json'));
        if(job.kind==='canvas-run'){for(const childId of [...new Set((job.steps||[]).map(s=>s.jobId).filter(Boolean))]){const child=await readJson(path.join(data,'jobs',childId+'.json'));if(child.input?.studio?.config.protocol==='jimeng'&&child.assets?.some(a=>job.assets.some(r=>r.id===a.id)))await creationStudio.verify(child);}const result=await (job.executionMode==='native-cascade'?applyNativeCascadeResults:applyCanvasResults)({data,project:p,job,revision:b.revision,acceptPartial:b.acceptPartial===true});await save(result.project);job.applied=result.applied;job.appliedAssetIds=result.appliedAssetIds;job.appliedTextIds=result.appliedTextIds||[];await atomicJson(path.join(data,'jobs',job.id+'.json'),job);return json(res,200,result.project);}
        if(job.kind==='comfy'&&job.promptBatch){const result=await applyPromptBatchResults({data,project:p,job,revision:b.revision,acceptPartial:b.acceptPartial===true});await save(result.project);job.applied=result.applied;job.appliedAssetIds=result.appliedAssetIds;job.appliedTextIds=result.appliedTextIds||[];await atomicJson(path.join(data,'jobs',job.id+'.json'),job);return json(res,200,result.project);}
        if(!['comfy','image-api','canvas-run'].includes(job.kind)||job.projectId!==id||job.status!=='completed')fail(400,'生成任务尚未完成或不属于本项目');
        if(p.runs.some(r=>r.jobId===job.id))fail(409,'这批结果已经加入项目');if(p.revision!==b.revision)fail(409,'项目已更新，请刷新后再加入结果');
        if(job.minimaxResultTarget)attachMinimaxResults(p,job.minimaxResultTarget,job.assets);
        const target=p.nodes.find(n=>n.id===job.target?.id),canAttach=!job.minimaxH3&&target&&target.assetId===job.target.assetId&&target.text===job.target.text;
        for(let i=0;i<job.assets.length;i++){
          const a=await loadAsset(data,job.assets[i].id);if(!p.assets.some(x=>x.id===a.id))p.assets.push(a);
          if(i===0&&canAttach)target.assetId=a.id;
          else{const type=a.type.split('/')[0];p.nodes.push(makeNode(['image','video','audio'].includes(type)?type:'text',100+(i%3)*350,150+Math.floor(i/3)*330,{title:a.name.slice(0,120),assetId:a.id,text:job.assets[i].sourcePrompt||''}));}
        }
        const outputAssets=job.assets.map(a=>a.id);
        p.runs.push({id:randomUUID(),jobId:job.id,status:'completed',kind:'generation',assetIds:outputAssets,assetReferences:imageAssetReferences(p,job.assets,jobReferenceAssetIds(job)),createdAt:new Date().toISOString()});p.revision++;p.updatedAt=new Date().toISOString();validateProject(p);await save(p);job.applied=true;await atomicJson(path.join(data,'jobs',job.id+'.json'),job);return json(res,200,p);
      });
    }
    if(parts[3]==='preflight'&&req.method==='GET')return json(res,200,{steps:preflight(await load(id))});
    if(parts[3]==='agent-preview'&&req.method==='POST'){
      if(!remoteDirector(config.agentProvider))fail(400,'当前助理没有选择远程模型');
      const b=await jsonBody(req);return json(res,200,await directorPreview(await load(id),b.message));
    }
    if(parts[3]==='agent-plan'&&req.method==='POST'){
      const b=await jsonBody(req),remote=b.mode==='model'&&remoteDirector(config.agentProvider);
      if(remote&&(!validId(b.requestId)||!/^[-a-f0-9]{36}$/i.test(b.requestId)))fail(400,'请重新检查本次请求编号');
      return await exclusive(remote?'director-plan-'+b.requestId:'local-plan-'+id,async()=>{
        const p=await load(id),inputHash=remote?directorRequestHash({message:b.message,authorization:b.authorization,thinking:b.thinking,projectRevision:b.projectRevision,previewHash:b.previewHash}):null;
        if(remote){const old=await readJson(path.join(data,'plans',b.requestId+'.json'),null);if(old){if(old.projectId!==id||old.inputHash!==inputHash)fail(409,'请求编号已用于其他内容，请重新检查后提交');return json(res,200,old);}}
        let requestModel;
        if(remote){const preview=await directorPreview(p,b.message);if(b.projectRevision!==p.revision||b.previewHash!==preview.previewHash)fail(409,'画布或服务已变化，请重新检查发送内容；没有提交模型请求');requestModel=options=>directorProvider.completeOnce({...options,provider:config.agentProvider,requestId:b.requestId,scope:'plan:'+id+':'+p.revision,consent:b.consent,authorization:b.authorization,thinking:b.thinking});}
        let plan;try{plan=await makePlan(p,b.message,b.mode,{consent:b.consent,endpoint:config.llmUrl||undefined,model:config.llmModel||undefined,requestModel});}catch(e){fail(e.status||400,e.message);}
        const record={...plan,id:remote?b.requestId:randomUUID(),projectId:id,revision:p.revision,createdAt:new Date().toISOString(),message:b.message,applied:false,...(remote?{inputHash}: {})};await atomicJson(path.join(data,'plans',record.id+'.json'),record);return json(res,200,record);
      });
    }
    if(parts[3]==='record-plan-answer'&&req.method==='POST'){
      const b=await jsonBody(req);if(!validId(b.planId))fail(400,'计划编号无效');return await exclusive(id,async()=>{
        const file=path.join(data,'plans',b.planId+'.json'),plan=await readJson(file,null),p=await load(id);
        if(!plan||plan.projectId!==id)fail(403,'回答不属于当前项目');
        if(plan.answerRecorded)return json(res,200,p);
        if(p.revision!==plan.revision)fail(409,'项目已变化，回答仍保留在计划记录中');
        p.messages.push({role:'user',content:plan.message},{role:'assistant',content:plan.summary});p.revision++;p.updatedAt=new Date().toISOString();await save(p);
        plan.answerRecorded=true;plan.revision=p.revision;await atomicJson(file,plan);return json(res,200,p);
      });
    }
    if(parts[3]==='apply-plan'&&req.method==='POST'){
      const b=await jsonBody(req);if(!validId(b.planId))fail(400,'计划编号无效');return await exclusive(id,async()=>{
        const file=path.join(data,'plans',b.planId+'.json'),plan=JSON.parse(await fs.readFile(file,'utf8')),p=await load(id);
        if(plan.projectId!==id)fail(403,'计划不属于当前项目');if(plan.applied||p.runs.some(r=>r.planId===plan.id))fail(409,'计划已经应用，不能重复执行');if(p.revision!==plan.revision)fail(409,'项目在规划后发生了变化，请重新规划');
        const next=applyPlan(p,plan);if(!plan.answerRecorded)next.messages.push({role:'user',content:plan.message},{role:'assistant',content:plan.summary+(plan.actions.length?'\n已应用到项目。':'\n回答已保存。')});next.runs.push({id:randomUUID(),planId:plan.id,status:'completed',kind:plan.source,actions:plan.actions.length,createdAt:new Date().toISOString()});next.revision=p.revision+1;next.updatedAt=new Date().toISOString();await save(next);plan.applied=true;await fs.writeFile(file,JSON.stringify(plan));return json(res,200,next);
      });
    }
    if(parts[3]==='apply-skill'&&req.method==='POST'){
      const b=await jsonBody(req);return await exclusive(id,async()=>{const p=await load(id);let next;if(b.templateId){if(!validId(b.templateId))fail(400,'模板编号无效');const t=JSON.parse(await fs.readFile(path.join(data,'templates',b.templateId+'.json'),'utf8'));const refs=new Map(t.nodes.map(n=>[n.id,randomUUID()]));next=structuredClone(p);next.nodes.push(...t.nodes.map(n=>{const node=structuredClone(n);node.id=refs.get(n.id);node.x=n.x+80;node.y=n.y+80;node.assetId=null;if(node.params?.promptAssetIds)node.params.promptAssetIds=[];return node;}));next.edges.push(...t.edges.map(e=>({...e,id:randomUUID(),source:refs.get(e.source),target:refs.get(e.target)})));validateProject(next);}else next=applyPlan(p,{actions:templateActions(b.skillId)});next.revision=p.revision+1;next.updatedAt=new Date().toISOString();return json(res,200,await save(next));});
    }
    if(parts[3]==='render-plan'&&req.method==='GET')return json(res,200,await renders.plan(await load(id)));
    if(parts[3]==='render'&&req.method==='POST'){const b=await jsonBody(req);return await exclusive('generate-'+id,()=>exclusive(id,async()=>json(res,202,await renders.start(await load(id),b))));}
    if(parts[3]==='minimax-export'&&req.method==='POST'){const b=await jsonBody(req);return await exclusive('generate-'+id,()=>exclusive(id,async()=>json(res,202,await renders.start(minimaxExportProject(await load(id),b),b))));}
    if(parts[3]==='render-apply'&&req.method==='POST'){const b=await jsonBody(req);return json(res,200,await renders.apply(id,b.jobId,b));}
    if(parts.length===3&&req.method==='GET')return json(res,200,await load(id));
    if(parts.length===3&&req.method==='PUT'){
      const p=await jsonBody(req);try{validateProject(p);}catch(e){fail(400,e.message);}return await exclusive(id,async()=>{const prev=await load(id);if(p.revision!==prev.revision)fail(409,'项目已在另一窗口更新，请重新打开后再编辑');p.id=id;p.createdAt=prev.createdAt;p.revision=prev.revision+1;p.updatedAt=new Date().toISOString();return json(res,200,await save(p));});
    }
    if(parts[3]==='history'&&req.method==='GET'){await load(id);const files=await fs.readdir(path.join(data,'projects',id,'history'));const items=await Promise.all(files.map(async f=>{const p=JSON.parse(await fs.readFile(path.join(data,'projects',id,'history',f),'utf8'));return {file:f,revision:p.revision,name:p.name,updatedAt:p.updatedAt,nodes:p.nodes.length};}));return json(res,200,items.sort((a,b)=>b.revision-a.revision).slice(0,80));}
    if(parts[3]==='restore'&&req.method==='POST'){const b=await jsonBody(req);if(typeof b.file!=='string'||!/^\d+-[a-f0-9-]+\.json$/.test(b.file))fail(400,'历史版本无效');return await exclusive(id,async()=>{const cur=await load(id);if(b.revision!==cur.revision)fail(409,'项目已更新');const old=JSON.parse(await fs.readFile(path.join(data,'projects',id,'history',b.file),'utf8'));validateProject(old);old.revision=cur.revision+1;old.updatedAt=new Date().toISOString();return json(res,200,await save(old));});}
  }
  if(parts[0]==='api'&&parts[1]==='jobs'&&validId(parts[2])&&parts.length===5&&parts[3]==='native-input-review'&&['preview','confirm'].includes(parts[4])&&req.method==='POST'){const body=await jsonBody(req),raw=await readJson(path.join(data,'jobs',parts[2]+'.json'));if(raw.snapshot)assertNativeMediaProjectSession(raw.snapshot,nativeMediaRequests.getStore(),smartGroupStoredMediaCandidate);if(parts[4]==='preview')return json(res,200,await nativeInputReviews.preview(parts[2],body));const result=await nativeInputReviews.confirm(parts[2],body);return json(res,200,{...result,job:publicExecutionJob(result.job)});}
  if(parts[0]==='api'&&parts[1]==='jobs'&&validId(parts[2])){const file=path.join(data,'jobs',parts[2]+'.json');if(req.method==='GET'){let j=await readJson(file);if(j.kind==='gemini-cli-chat')return json(res,200,await geminiCliChats.summary(j.id));if(j.kind==='codex-chat')return json(res,200,await codexChats.summary(j.id));if(j.kind==='canvas-llm')j=await canvasLlm.refresh(j);if(j.kind==='conversation'&&['codex','gemini-cli'].includes(j.input?.executor))j=await conversations.refresh(j);if(j.kind==='studio'&&j.input?.studio?.config.protocol==='jimeng')j=await creationStudio.refresh(j);if(j.kind==='canvas-run')j=await exclusive('resume-'+j.id,async()=>creationStudio.recoverCanvasLinks(await readJson(path.join(data,'jobs',j.id+'.json'))));return json(res,200,j.kind==='folder-import'?await sharedFolders.get(j.id,j.projectId):j.kind==='library-copy'?await assetCatalog.get(j.id,j.projectId):['library-backup','library-restore'].includes(j.kind)?await libraryBackups.get(j.id,j.projectId):publicExecutionJob(j));}if(req.method==='POST'&&parts[3]==='resume')return await exclusive('resume-'+parts[2],async()=>{const j=await readJson(file);if(j.snapshot)assertNativeMediaProjectSession(j.snapshot,nativeMediaRequests.getStore(),smartGroupStoredMediaCandidate);if(j.kind==='library-crop')fail(409,'请从素材库裁剪记录确认原范围后继续');if(j.kind==='conversation'&&['codex','gemini-cli'].includes(j.input?.executor))fail(409,'CLI对话只读取原收据，不会自动重发');if(j.kind==='canvas-llm'&&['codex','gemini-cli'].includes(j.input?.executor))fail(409,'CLI语言任务只读取原收据，不会重新发送');if(j.kind==='gemini-cli-chat')fail(409,'Gemini原回答只能读取和取回，不会自动重发');if(j.kind==='codex-chat')fail(409,'CLI原回答只能读取和取回，不会自动重发');const b=await jsonBody(req);try{return json(res,202,await (j.kind==='studio'?{resume:(id,b)=>creationStudio.resume(j.studioId,id,b)}:j.kind==='canvas-run'?(j.executionMode==='native-cascade'?cascadeRuns:canvasRuns):j.kind==='render'?renders:j.kind==='folder-import'?sharedFolders:j.kind==='library-copy'?assetCatalog:['library-backup','library-restore'].includes(j.kind)?libraryBackups:generation).resume(parts[2],['folder-import','library-copy','library-backup','library-restore'].includes(j.kind)?{...b,projectId:j.projectId}:b));}finally{clearCloudCredentials(b);clearImageCredentials(b);clearLlmCredentials(b);clearStudioCredentials(b);}});if(req.method==='POST'&&parts[3]==='cancel'){const job=await readJson(file);if(job.kind==='library-crop')return json(res,200,await libraryCrops.cancel(job.id,job.projectId));if(job.kind==='gemini-cli-chat')return json(res,200,await geminiCliChats.stop(job.id,job.projectId));if(job.kind==='codex-chat')return json(res,200,await codexChats.stop(job.id,job.projectId));if(job.kind==='studio'){await creationStudio.cancel(job.studioId,job.id);return json(res,200,{ok:true});}activeJobs.get(parts[2])?.controller.abort();return json(res,200,{ok:true});}}
  if(parts[0]==='renders'&&validId(parts[1])&&['GET','HEAD'].includes(req.method)){
    if(parts.length===2)return await serveFile(req,res,path.join(data,'renders',parts[1],'final.mp4'),'video/mp4');
    if(parts.length===4&&/^attempt-[a-zA-Z0-9_-]+$/.test(parts[2])&&['final.mp4','subtitles.srt'].includes(parts[3])){const j=await readJson(path.join(data,'jobs',parts[1]+'.json'));if(j.kind!=='render'||j.status!=='completed'||j.result?.attempt!==parts[2])fail(404,'成片尚未完成');return await serveFile(req,res,path.join(data,'renders',parts[1],parts[2],parts[3]),parts[3]==='final.mp4'?'video/mp4':'text/plain; charset=utf-8');}
  }
  if(parts[0]==='api'&&parts[1]==='model3d'&&parts.length===3&&req.method==='GET')return json(res,200,await model3dInfo(data,parts[2]));
  if(u.pathname==='/api/assets/stream'&&req.method==='POST'){
    const size=streamMediaSize(req.headers['x-jingchang-file-size'],req.headers['content-length']);
    const meta=await streamAssets.importFile(req,{projectId:u.searchParams.get('projectId'),requestId:u.searchParams.get('requestId'),name:u.searchParams.get('name')||'媒体文件',type:req.headers['content-type'],size});return json(res,201,meta);
  }
  if(parts[0]==='api'&&parts[1]==='asset-imports'&&parts.length===3&&req.method==='GET')return json(res,200,await streamAssets.get(parts[2],u.searchParams.get('projectId')));
  if(u.pathname==='/api/assets'&&req.method==='POST'){
    const name=u.searchParams.get('name')||'素材';const type=req.headers['content-type']||'application/octet-stream';
    if(!/^(image\/(png|jpeg|webp|gif|avif|bmp)|video\/(mp4|webm|quicktime|x-matroska)|audio\/[\w.+-]+|text\/plain|model\/gltf-binary|application\/json)(;.*)?$/.test(type))fail(415,'当前支持常见图片、视频、音频和文本；SVG、HTML 不作为媒体导入');
    const meta=await storeAsset(data,await body(req,150*1024*1024),{name:name.slice(0,200),type});return json(res,201,meta);
  }
  if(chromeImportRoute&&req.method==='POST'){
    if(!allowChromeOrigin)fail(403,'只允许镜场 Chrome 扩展发起本机素材导入');
    const name=u.searchParams.get('name')||'网页素材',category=(u.searchParams.get('category')||'网页采集').slice(0,80),type=(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
    if(!/^(image\/(png|jpeg|webp|gif|avif)|video\/(mp4|webm|quicktime|x-flv))$/.test(type))fail(415,'网页采集仅支持 PNG/JPEG/WebP/GIF/AVIF 图片及 MP4/WebM/MOV/FLV 视频');
    const meta=await storeAsset(data,await body(req,150*1024*1024),{name:name.slice(0,200),type,category,source:'chrome-extension'});return json(res,201,meta);
  }
  if(parts[0]==='media'&&validId(parts[1])&&['GET','HEAD'].includes(req.method)){const meta=JSON.parse(await fs.readFile(path.join(data,'assets',parts[1]+'.json'),'utf8'));if(meta.type===LORA_MIME||isDocument(meta))res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(meta.name));return await serveFile(req,res,path.join(data,'assets',parts[1]),meta.type);}
  if(u.pathname==='/loop-core.mjs'&&req.method==='GET')return await serveFile(req,res,path.join(root,'lib','loop-core.mjs'),'text/javascript; charset=utf-8');
  if(u.pathname==='/public/reference-limits.js'&&req.method==='GET')return await serveFile(req,res,path.join(root,'public','reference-limits.js'),mime['.js']);
  if(['/public/minimax-h3-core.js','/public/native-canvas-core.js','/public/native-prompt-core.js','/public/native-loop-core.js','/public/native-branch-core.js','/public/source-index-core.js','/public/native-workflow-config.js','/public/workflow-random-core.js','/public/native-modelscope-core.js'].includes(u.pathname)&&req.method==='GET')return await serveFile(req,res,path.join(root,'public',path.basename(u.pathname)),mime['.js']);
  if(u.pathname==='/panorama-core.mjs'&&req.method==='GET')return await serveFile(req,res,path.join(root,'lib','panorama-core.mjs'),'text/javascript; charset=utf-8');
  if(u.pathname==='/image-edit-core.mjs'&&req.method==='GET')return await serveFile(req,res,path.join(root,'lib','image-edit-core.mjs'),'text/javascript; charset=utf-8');
  if(u.pathname==='/grid-layout.mjs'&&req.method==='GET')return await serveFile(req,res,path.join(root,'lib','grid-layout.mjs'),'text/javascript; charset=utf-8');
  if(u.pathname==='/canvas-tools.mjs'&&req.method==='GET')return await serveFile(req,res,path.join(root,'lib','canvas-tools.mjs'),'text/javascript; charset=utf-8');
  if(u.pathname.startsWith('/api/'))fail(404,'接口不存在');
  if(!['GET','HEAD'].includes(req.method))fail(405,'请求方式不支持');
  const rel=u.pathname==='/'?'index.html':u.pathname==='/creation-studio'?'creation-studio.html':decodeURIComponent(u.pathname.slice(1));const file=path.resolve(root,'public',rel);if(!file.startsWith(path.join(root,'public')+path.sep))fail(403,'路径无效');
  return await serveFile(req,res,file,mime[path.extname(file)]||'application/octet-stream');
}catch(e){if(res.headersSent){res.destroy();return;}json(res,e.status|| (e.code==='ENOENT'?404:500),{...(['NATIVE_MEDIA_SESSION_CHANGED','NATIVE_MEDIA_RULES_UNAVAILABLE','NATIVE_LEGACY_INPUT_REVIEW_REQUIRED','NATIVE_INPUT_REVIEW_STALE'].includes(e.code)?{code:e.code}:{}),error:e.publicMessage|| (e.status?e.message:(e.code==='ENOENT'?'文件不存在':'操作失败，请重试')),...(e.classificationTask?.kind==='asset-classification'?{classificationTask:e.classificationTask}:{})});}}));
server.listen(port,'127.0.0.1',()=>console.log(`镜场工作台 http://127.0.0.1:${port}`));
