import {checkNativeHistoryInput} from './native-history-inputs.mjs';
import {checkDirectorHistoryInput} from './director-history-inputs.mjs';
// Linked CLI execution remains readonly when restoring complete task archives.
import {libraryCropReceipt} from './library-crops.mjs';
import {safeId,userError} from './workspace.mjs';
import {classificationSnapshot} from './asset-classification-history.mjs';

// Only these named fields can enter receipts. Dynamic dictionaries are limited
// to declared workflow graphs, node-indexed records and primitive LoRA weights.
const fields=new Set(`producerIndices nativeMediaEditReceipt nativeMediaVersion time textSha256 truncated encoding imageLimit sheetCount history currentAssetIds program codexPlan codexFingerprint conversation parts llm audioReferences referenceDetails finishReason models referenceSupport audioSupport videoSupport maskSupport available entrySha256 executor codexProgram codexTaskId programSha256 programEntrySha256 programVersion caption sourceSha256 id projectId name revision archived createdAt updatedAt completedAt startedAt finishedAt importedAt kind status progress message requestId parentId parentJobId childJobId jobId nodeId sourceNodeId targetNodeId requestNodeId requestNodeDigest operationId conversationId studioId recipeId workflowId workflowRevision executionMode requestCount uploadCount count incrementSeeds seedOffset target backend endpoint workflow workflowJson input snapshot plan result assets items applied textResults processedResults originalTexts steps nativeResultTargets nativeOutputTargets loopBackends summary cascadeProgram cascadeState authorization imageAuthorization uploadAuthorization billingStatus uncertain canResume outputText stream userMessage referencePlan referenceIds usedReferenceIds maskAssetId assetId assetIds audioId sourceAssetId originalAssetId source fileMark sha256 md5Hex size type url category tags format version nodes edges groups shots messages runs viewport settings x y zoom title text params ratio duration resolution model negativePrompt seed voice source target content role description dialogue sound camera sourcePort targetPort nodeIds collapsed color width height imageSources promptField overrides value fieldValue fieldName fields sourceIndex sourceNodeIds referenceSources includeUpstream platform platformId platformName protocol baseUrl modelId modelLabel label language maxTokens temperature systemPrompt size quality transparent generateAudio imageAsync mode operation unitPrice currency config references view outputType targetId catalogVersion minimaxProfile prompt promptBatch values enabled scope referenceCount requestLimit sendPrompt sendReferences sendNativeVideo sendFields sendAssets sendWorkflow sendFile uploadLimit storageOrigin origin budget model protocol imageCount inheritLastImage metadataOnly maskIncluded imagePlatformId imageModel imageBindings inputMappings inputPrepared inputPreparation uploaded filename subfolder mime ltxTrack index promptId outputKey batchIndex error code output nodeInputs inputs class_type _meta actualSeed inputReceipt inputReceipts originalFilename uploadedAt importedAt bytesReceived bytesSent expectedSize requestSignature signature bytesTransferred attempt subtitleUrl subtitlesBurned subtitleCount duckMusic transition effectiveSeconds musicTracks projectRevision fps captions music width height errors warnings requestLimit sendImage sendVideo sendAudio upstreamId expiresAt fileName loraName uploadCount storageOrigin metadataOnly lora loraReceipts architecture parameterCount tensorCount headerBytes formatVersion sourceJobId sourceRequestId sourceRevision importBundleId importLibraryBackupId catalogRevision completedSteps totalSteps totalBytes completedBytes importId catalogState libraries folders libraryId folderId itemId originalAssetIds completedOperationCount completedOrder receivers slots rounds roundIndex total index forceWorkflow operations dependencyOrder enabledNodeIds missingPromptFallback references relayPromptNodeIds resultPolicy outputRefs inputRefs fallbackRefs usedFallback nodeOutputs operationOutputs nodeResults receiverBindings operationBindings snapshotDigest programDigest ordering sourceType operationType assetsDigest nativeLoop nativeBranch nativePrompt nativeFlow nativeApi nativeCanvas groupChildren groupParent nativeDirectorInputs nativeField nativeFields runninghub studio comfy image-api canvas-llm textType kind sourceNodeDigest kind sourceNodeId outputAssetIds loopId loopContexts runtime runtimeState singleNodeLoopRun loopMode operationCount roundCount sourceNodeIds requestNodeIds receiverNodeIds min max step default options required optional number boolean string fieldType description displayName connectable promptNodeId referenceNodeId originalTexts generatedOptions generatedImages generatedVideos generatedAudios nativeIndex nativeType executionEnabled inputOrder itemType itemIndex itemUrl memberId sourceId nodeType selected generatedAssets generated sourceInputs timeline edit editing audio music subtitle subtitles caption captions musicAssetId musicVolume musicOffset subtitleStyle transitionType trimIn trimOut volume muted playbackRate speed crop pan scale fit position background layout textColor fontSize fontFamily fontWeight lineHeight align stroke strokeColor strokeWidth shadow shadowColor shadowBlur shadowOffsetX shadowOffsetY opacity padding margin borderRadius start end durationSeconds offsetSeconds fadeIn fadeOut video audio textTrack type seconds selectedIndex sourceIndex outputIndex resultIndex roundStep randomFields randomDescriptors resolvedRandom randomEnabled randomSeed randomReceipt sampling steps cfg denoise sampler_name scheduler checkpoint image image_mask mask strength steps guidance scale seed behavior randomize min max negative upstreamText loras referenceMode arkReferenceMode imageResolution operationOptions taskId fileKey action buttons selectedButton customId taskConfig remix parentTaskId imageUrl assetUrl textUrl videoUrl audioUrl submitReceipt queryReceipt lastQueryAt lastAttemptAt terminalReason requestedAt preparedAt receivedAt queriedAt modelName providerId providerName currentProjectRevision outputs results dependencies operationCount resultCount summary outputs textResults sourceAssetIds inputs count total unknown frameCount frames method timestamp seconds position nativeVideos documentSamples videoSamples thoughtSignature nativeContext nativeParts imagePrompts agentSettings tokenUsage usage inputTokens outputTokens totalTokens feedback completed incomplete state requests stored interrupted sourceName resultAssetId dataType mediaType mimeType name originalSource sourceAssetId sourceType aspectRatio placement path sender messageId planId actions actionCount provenance minimaxParameters fieldValues portType multiple parentId branchId branchIndex selector selected optionId optionIndex groups options choices discriminator conditions condition compare operator threshold fallback branch exit autoRepeat repeat iteration round maximumRounds parallel concurrency maxConcurrency outputPolicy missingPromptPolicy order empty expanded known parameters workflowBinding cloudBinding studioBinding llmBinding imageBinding cloudWorkflowId promptAssetIds render editing settings loop importBundleId importBundleId nativeResultTargets nativeOutputTargets nativeBranchId archiveKind isInput original`.split(/\s+/));
for (const key of ['asset','renderAssetImport','renderJobId','renderAttempt','previousRequestIds','sourceMark','sourceMetadata','enhancement','classification','sourceName','operationId','editId','outputs','sourceWidth','sourceHeight','batchMode','libraryCopy','sourceLibraryId','sourceFolderId','catalogEntryId','assetCatalog','project','projectId','cloudWorkflows','workflows','studios','conversations','imageEdits','arkMaterials','publicMedia','canvasFragment']) fields.add(key);
for (const key of ['actualInput', 'childRequests', 'batchExecution', 'workflowRandom', 'cascadeBatch', 'cascadeEnhancement', 'imageEnhance', 'seedMode', 'engine', 'executionId', 'cascadeKind', 'generations', 'sharedCopies', 'relays', 'adaptation', 'node', 'resources', 'missingResources', 'mediaAssetIds', 'members', 'outgoingMedia', 'connectedOutput', 'connectedGroup', 'nativeCanvasConnection', 'requestedNodeId', 'tailNodeId', 'rootNodeId', 'pathNodeIds', 'scheduling', 'generationOperationCount', 'preserveTargetConfiguration', 'selfNodeId', 'defaultNodeId', 'incoming', 'reference', 'skippedNodeIds', 'currentRefs', 'historyRefs', 'appendInitialized', 'receipts', 'identity', 'originalNodeId', 'imageIndex', 'network']) fields.add(key);
for (const key of ['displayPrompt','roles','referenceRefs','mappings','unusedRefs','promptFields','providerRequestCount','mediaDefaults','workflowHash','policy','isFloat','precision','batches','submitted','images','runSettings','promptDraftHtml','promptDraftText','archive','from','to','parallelLimitPolicy']) fields.add(key);
fields.add('comfyWorkflow');fields.add('nodeCount');fields.add('sceneId');fields.add('editOutput');
for (const key of ['loopTitle','showPrompt','imageInput','imageBatchSize','videoInput','videoBatchSize','variablePrompt','variablePrompts','stride','endIndex','maxResolution','imageField','resolutionField','maxResolutionField','seedFields','sourceIdentity','enhanceSourceId','resultAssetIds']) fields.add(key);
for (const key of ['inspection','control','help','exposed','nativeFieldId','defaultValue','mediaKind']) fields.add(key);
for (const key of ['sourceStart','sourceEnd','endMode','sourceAudio','sourceVolume','voiceStart','voiceOffset','voiceVolume','burnSubtitles','font','outlineColor','outline','bottom','backgroundOpacity','subtitleCues','workbenchSource','sourceDuration','hasOriginalAudio']) fields.add(key);
for(const key of ['assetReferences','textIds','sourcePrompt','referenceInputs','sourceSha256','textInputs','childProgress','childMessage','appliedAssetIds','appliedTextIds'])fields.add(key);
for(const key of ['jimeng','command','jimengTaskId','resultQueries','queryCount','scopeFingerprint','used','remaining','sessions','number','stoppedAt','initialStoppedAt','intervalSeconds','useLocalLogin','resultQueriesConsent'])fields.add(key);
for(const k of ['geminiCliPlan','geminiCliFingerprint','geminiCliTaskId','geminiCliProgram'])fields.add(k);
for(const k of ['sourceItemId','entryId','streamRequestId','sources','fingerprint'])fields.add(k);
const dropped=new Set(['credentialSource','credentialProvider']);
fields.add('nativeInputReviews');fields.add('nativeInputReviewApplied');
for(const key of ['minimaxH3','ltxDirector','minimaxSeed','minimaxResultTarget','minimaxSegmentId','resolvedDirectorInputs','minimaxUpstreamRefs','minimaxAttachments','nativeOutputAttachments','segmentId','paramsSha256'])fields.add(key);
const sensitive=/(?:api.?key|(?:access|auth|api|refresh|bearer)[_-]?token|password|secret|credential)|^token$|^(headers|cookies|cookie|signedUrl)$/i;
const dictionaries=new Set(['loopContexts','originalTexts','receivers','nodeOutputs','operationOutputs','nodeResults','nativeResultTargets','nativeOutputTargets','generatedOptions']);
export const SUPPORTED_TASK_KINDS=new Set(['gemini-cli-chat','library-crop','codex-chat','comfy','canvas-run','render','image-api','canvas-llm','studio','runninghub','conversation','conversation-image','conversation-agent','lora-upload','library-copy','folder-import']);
function guardString(value){
 if(/\bBearer\s+\S+|\bsk-[\w-]{16,}/i.test(value))throw userError('归档内容疑似含密钥；请移除后重试');
 const secretQueryKey=key=>{let decoded=key;for(let i=0;i<2;i++){try{const next=decodeURIComponent(decoded.replace(/\+/g,' '));if(next===decoded)break;decoded=next;}catch{break;}}return sensitive.test(decoded)||/^(key|auth|authorization|sig|signature|sas)$|signature|x-amz|x-goog/i.test(decoded);};
 // Receipts can contain relative links or a URL inside a prompt/message. Check
 // query names throughout the string rather than only at its beginning.
 const text=value.replace(/&amp;|&#0*38;|&#x0*26;/gi,'&');
 for(const match of text.matchAll(/[?&#;]([^=?&#\s"'<>]+)=/g))if(secretQueryKey(match[1]))throw userError('归档链接包含凭据或签名；请移除后重试');
 for(const match of text.matchAll(/(?:https?:)?\/\/[^\s"'<>]+/gi)){let u;try{u=new URL(match[0],'https://archive.invalid/');}catch{throw userError('归档链接格式无效');}if(u.username||u.password||[...u.searchParams.keys()].some(secretQueryKey))throw userError('归档链接包含凭据或签名；请移除后重试');}
}
export function guardArchiveSecrets(value,depth=0){
 if(depth>70)throw userError('归档数据嵌套过深');
 if(typeof value==='string'){guardString(value);return;}
 if(!value||typeof value!=='object')return;
 for(const [key,v]of Object.entries(value)){
  if(['__proto__','constructor','prototype'].includes(key))throw userError('归档含不安全字段');
  if(!dropped.has(key)&&sensitive.test(key)&&v!==null&&v!==undefined&&v!=='')throw userError('归档含秘密字段；请移除后重试');
  if(key==='authorization'&&v!==null&&typeof v!=='object')throw userError('归档含认证头；请移除后重试');
  guardArchiveSecrets(v,depth+1);
 }
}
export function projectReceipt(value,unsupported=[],location='project'){
 if(!value||!safeId(value.id))throw userError('归档项目编号无效');
 return receiptTree(value,unsupported,location);
}
function workflowGraph(value,unsupported,location){
 if(!value||Array.isArray(value)||typeof value!=='object')throw userError('归档工作流结构无效');
 const out={};for(const [key,node]of Object.entries(value)){
  if(!/^[\w-]{1,100}$/.test(key)||!node||typeof node.class_type!=='string'||!node.inputs||typeof node.inputs!=='object')throw userError('归档工作流节点无效');
  const allowed=new Set(['class_type','inputs','_meta']);for(const k of Object.keys(node))if(!allowed.has(k))unsupported.push(location+'.'+key+'.'+k);
  const inputs={};for(const [k,v]of Object.entries(node.inputs)){if(!/^[\w. -]{1,160}$/.test(k))throw userError('归档工作流输入名称无效');guardArchiveSecrets({[k]:v});inputs[k]=structuredClone(v);}
  out[key]={class_type:node.class_type,inputs,...(node._meta?{_meta:{title:String(node._meta.title||'')}}:{})};
 }
 return out;
}
export function receiptTree(value,unsupported=[],location='record',parent='',depth=0){
 if(depth===0)guardArchiveSecrets(value);
 if(['running','queued'].includes(parent)&&typeof value!=='boolean')throw userError('归档原生运行标记须为布尔值');
 if(depth>70)throw userError('归档数据嵌套过深');
 const director=checkDirectorHistoryInput(parent,value,unsupported,location,guardArchiveSecrets);if(director!==undefined)return director;
 const native=checkNativeHistoryInput(parent,value,unsupported,location);if(['contexts','nativeInputReviews','nativeInputReviewApplied'].includes(parent)&&native!==undefined)return native;
 if(value===null||['string','boolean'].includes(typeof value))return value;
 if(typeof value==='number'){if(!Number.isFinite(value))throw userError('归档包含无效数值');return value;}
 if(Array.isArray(value))return value.map((v,i)=>receiptTree(v,unsupported,location+'['+i+']',parent,depth+1));
 if(!value||typeof value!=='object')throw userError('归档字段类型无效');
 if(parent==='classification')return classificationSnapshot(value);
 if(['workflow','workflowJson'].includes(parent))return workflowGraph(value,unsupported,location);
 const out={};for(const [key,v]of Object.entries(value)){
  if(dropped.has(key))continue;
  if(dictionaries.has(parent)){if(!safeId(key))throw userError('归档字典编号无效');out[key]=receiptTree(v,unsupported,location+'.'+key,'',depth+1);continue;}
  if(parent==='loras'){if(!/^[\w./ -]{1,200}$/.test(key)||typeof v!=='number'||!Number.isFinite(v))throw userError('归档LoRA权重无效');out[key]=v;continue;}
  if(!fields.has(key)){unsupported.push(location+'.'+key);continue;}
  out[key]=receiptTree(v,unsupported,location+'.'+key,key,depth+1);
 }
 return out;
}
export function taskReceipt(job){
 if(job?.kind==='library-crop')libraryCropReceipt(job);
 if(job?.kind==='folder-import')return folderImportReceipt(job);
 if(!job||!safeId(job.id)||!safeId(job.projectId)||typeof job.kind!=='string')throw userError('归档任务身份无效');
 const unknown=[],record=receiptTree(job,unknown,'job:'+job.id);
 const unsupported=[];if(!SUPPORTED_TASK_KINDS.has(job.kind))unsupported.push({id:job.id,kind:job.kind,reason:'unsupported-task-kind'});
 if(unknown.length)unsupported.push({id:job.id,kind:job.kind,reason:'unsupported-fields',fields:[...new Set(unknown)]});
 return{record,unsupported};
}
function folderImportReceipt(job){
 guardArchiveSecrets(job);
 const bad=()=>{throw userError('共享文件夹导入留痕无效');};
 const relative=v=>typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\x00-\x1f\\]/.test(v)&&!v.startsWith('/')&&!/^[a-z]:/i.test(v)&&v.split('/').every(p=>p&&!p.startsWith('.')&&p!=='..');
 if(!safeId(job.id)||job.requestId!==job.id||!safeId(job.projectId)||!safeId(job.folderId)||!Array.isArray(job.items)||!job.items.length||job.items.length>200||!job.snapshot||Object.keys(job.snapshot).join(',')!=='paths'||!Array.isArray(job.snapshot.paths)||job.snapshot.paths.length!==job.items.length)bad();
 const clean=structuredClone(job),saved=[];delete clean.snapshot;
 for(let i=0;i<job.items.length;i++){
  const item=job.items[i],source=job.snapshot.paths[i];
  if(!relative(item.relativePath)||!source||Object.keys(source).sort().join(',')!=='fingerprint,path'||source.path!==item.relativePath||!/^[a-f0-9]{64}$/.test(source.fingerprint)||item.streamRequestId!==undefined&&!safeId(item.streamRequestId)||!['pending','importing','completed','failed','interrupted'].includes(item.status)||item.status==='completed'&&(!safeId(item.asset?.id)||!safeId(item.streamRequestId)))bad();
  saved.push({relativePath:item.relativePath,...(item.streamRequestId?{streamRequestId:item.streamRequestId}:{})});delete clean.items[i].relativePath;delete clean.items[i].streamRequestId;
 }
 const unknown=[],record=receiptTree(clean,unknown,'folder-import:'+job.id);
 record.snapshot=structuredClone(job.snapshot);for(let i=0;i<record.items.length;i++)Object.assign(record.items[i],saved[i]);
 const unsupported=[];if(!['completed','partial','failed','cancelled','interrupted'].includes(job.status))unsupported.push({id:job.id,kind:job.kind,reason:'active-folder-import'});
 if(job.status==='completed'&&job.items.some(i=>i.status!=='completed'))bad();
 if(unknown.length)unsupported.push({id:job.id,kind:job.kind,reason:'unsupported-fields',fields:[...new Set(unknown)]});return{record,unsupported};
}
export function referencedAssets(value,out=new Set(),parent=''){
 if(Array.isArray(value)){if(['assetIds','appliedAssetIds','referenceIds','referenceAssetIds','usedReferenceIds','sourceAssetIds','originalAssetIds','outputAssetIds','mediaAssetIds','resultAssetIds','promptAssetIds'].includes(parent))for(const id of value)if(safeId(id))out.add(id);for(const v of value)referencedAssets(v,out,parent);return out;}
 if(!value||typeof value!=='object')return out;
 if(['assets','asset'].includes(parent)&&safeId(value.id))out.add(value.id);
 for(const [key,v]of Object.entries(value)){if(parent==='outputs'&&['image','mask','input'].includes(key)&&safeId(v))out.add(v);if(['assetId','audioId','sourceAssetId','originalAssetId','maskAssetId','musicAssetId','resultAssetId'].includes(key)&&v!==null&&v!==''&&v!==undefined){if(!safeId(v))throw userError('归档素材引用编号无效');out.add(v);}referencedAssets(v,out,key);}
 return out;
}

for(const key of ['sendOriginalMedia','outputCount','nodeClass','receiptId','recipeRevision','originalReceiptId','modelKey','acceptsImages','nativeModelscope','cascadeModelscope','modelscope','referenceAssetIds','referenceIdentities','attempted'])fields.add(key);
// Fixed upstream ModelScope source settings remain part of the original node
// and revision receipt, alongside the normalized executable binding.
for(const key of ['msgenModel','msCustomModel','msRatio','msResolution','msCustomRatio','msCustomSize','msCustomRatioWidth','msCustomRatioHeight','msCustomWidth','msCustomHeight','msLoraEnabled','msLoraId','msLoraStrength','msModel','msSize'])fields.add(key);

fields.add('apimartReferenceMode');

// Ordinary imported frames and local membership-edit receipts must survive
// full project/history archives without treating the receipt as executable.
for(const key of ['w','h','groupDisplayState','inputGroupEditReceipt','requestHash','planHash','addedEdges','removedEdges'])fields.add(key);

// Pinned smart-canvas document metadata and prompt source controls remain
// readable in history archives; all unknown fields still stay unsupported.
for(const key of ['header','canvas_type','created_at','updated_at','promptSplitEnabled','promptSeparator','promptSplitPreviewHeight','llmEnabled','llmInstruction','llmSystemEnabled','llmSystemPrompt'])fields.add(key);

// Fixed native output arrays and the original loop start are preserved in
// read-only archives; credential/URL guards and unknown-field rejection remain.
for(const key of ['generatedOutputs','loopStart'])fields.add(key);

for(const key of ['nativeUnit','nativeBackend','nativeReferences','ownText','contexts','resolvedReferences','kinds','details','originNodeId','producerNodeId','pending','expectedCount'])fields.add(key);

for(const key of ['nativeMediaMap','scopeHash','originalSourceIndex','selection','nativeMappedFields'])fields.add(key);

for(const key of ['smartGroupEditReceipt','groupId'])fields.add(key);

// Fixed upstream image dimensions remain part of the original media receipt.
for(const key of ['natural_w','natural_h','layout_w','layout_h','preview_w','preview_h'])fields.add(key);
// Fixed-source copies explicitly store idle booleans; these are not job states.
for(const key of ['running','queued'])fields.add(key);

// Original cloud H3 plan and its dependency IDs belong to the parent/child receipt.
for(const key of ['recipe','minimaxRecipe','minimaxParents'])fields.add(key);
