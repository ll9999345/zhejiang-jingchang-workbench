import {localMiaoCredentialService,normalizeMiaoCredential,resolveMiaoCredential} from './miao-credentials.mjs';
import {assertCanvasParent,conflictingCanvasChild,linkCanvasChild} from './canvas-child-scope.mjs';
import {assertNativeNodeReady} from './native-canvas-core.mjs';
import {assertImageRequestSize} from './image-api.mjs';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { atomicJson, records, loadAsset, storeAsset, userError, safeId } from './workspace.mjs';
import { generateImage } from './image-api.mjs';
import {validateInputImage} from './providers.mjs';
import { resolveImageContext, listUpstreamImageReferences } from './input-context.mjs';
import { imageDimensions } from './media-tools.mjs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const MAX_MASK_PIXELS=16_777_216;

async function openAIMaskInputs(referenceBytes,maskBytes,expectedSize){
  const [referenceImage,maskImage]=await Promise.all([loadImage(referenceBytes),loadImage(maskBytes)]);
  const width=referenceImage.width,height=referenceImage.height;
  if(width!==maskImage.width||height!==maskImage.height)throw userError('遮罩与底图解码后的像素尺寸必须完全一致');
  if(width!==expectedSize.width||height!==expectedSize.height||width*height>MAX_MASK_PIXELS)throw userError('底图尺寸无效或超过 1677 万像素');

  const canvas=createCanvas(width,height),ctx=canvas.getContext('2d');
  ctx.drawImage(referenceImage,0,0);
  const pngReference=canvas.toBuffer('image/png');
  ctx.clearRect(0,0,width,height);
  ctx.drawImage(maskImage,0,0);
  const pixels=ctx.getImageData(0,0,width,height),data=pixels.data;
  // The local editor exports opaque grayscale: 255 means repaint, 0 means
  // preserve. OpenAI's mask uses transparency for the editable region.
  for(let i=0;i<data.length;i+=4){
    const editable=Math.round(((data[i]+data[i+1]+data[i+2])/3)*data[i+3]/255);
    data[i]=data[i+1]=data[i+2]=255;
    data[i+3]=255-editable;
  }
  ctx.putImageData(pixels,0,0);
  return {reference:{bytes:pngReference,mime:'image/png'},mask:{bytes:canvas.toBuffer('image/png'),mime:'image/png'}};
}

function checkedContext(project,nodeId,options){try{return resolveImageContext(project,nodeId,options);}catch(e){throw userError(e.message);}}

export function directImageService({data,activeJobs,platforms,miaoCredentials=localMiaoCredentialService(),imageGenerator=generateImage}){
  const file=id=>path.join(data,'jobs',id+'.json');
  const submissionLocks=new Map();
  async function context(project,nodeId){return {...checkedContext(project,nodeId,{autoReferences:false,allowEmptyPrompt:true}),candidates:listUpstreamImageReferences(project,nodeId)};}
  async function start(project,body,canvasPlatform=null,parentId,executionPrompt){
    // Serialize admission, not generation: deduplication and registration must be atomic.
    const previous=submissionLocks.get(project.id)||Promise.resolve();
    let release;
    const current=new Promise(resolve=>{release=resolve;});
    submissionLocks.set(project.id,current);
    await previous;
    try{return await startUnlocked(project,body,canvasPlatform,parentId,executionPrompt);}
    finally{release();if(submissionLocks.get(project.id)===current)submissionLocks.delete(project.id);}
  }
  async function startUnlocked(project,body,canvasPlatform,parentId,executionPrompt){
    if(!safeId(body.requestId))throw userError('缺少本次请求编号');
    const previous=(await records(path.join(data,'jobs'))).find(j=>j.kind==='image-api'&&j.projectId===project.id&&j.requestId===body.requestId);
    if(previous)return previous;
    assertNativeNodeReady(project,body.nodeId,{flow:!!canvasPlatform});
    if(conflictingCanvasChild(activeJobs,project.id,parentId,'image-api'))throw userError('当前项目已有图片生成任务，请先查看任务中心',409);
    if(project.revision!==body.revision)throw userError('项目已更新，请重新打开生成面板',409);
    const node=project.nodes.find(n=>n.id===body.nodeId);if(!node||!['image','character','scene'].includes(node.type))throw userError('请选择图片、角色或场景节点');
    const platform=canvasPlatform||await platforms.get(body.platformId),model=platform.models.find(m=>m.id===body.model&&m.category==='image');
    if(platform.protocol!=='openai-compatible')throw userError('画布直接生图当前要求 OpenAI 兼容图片协议；Gemini 原生图片请在创作台或独立对话中使用');
    if(!model)throw userError('请选择已保存到图片分类的模型');
    const resolved=checkedContext(project,node.id,{includeUpstream:body.includeUpstream!==false,autoReferences:false,referenceIds:body.referenceIds||[]});
    // A native cascade has already composed the source prompt. Keep its exact
    // text instead of adding the ordinary conversation-context node label.
    // This private argument is available only to a verified canvas parent.
    if(executionPrompt!==undefined){
      if(typeof executionPrompt.prompt!=='string'||!executionPrompt.prompt.trim())throw userError('缺少提示词');
      if(executionPrompt.prompt.length>32000)throw userError('智能串联提示词超过32000字');
      const ids=executionPrompt.referenceIds;
      if(!Array.isArray(ids)||ids.length>20||ids.some(id=>!safeId(id)||!project.assets.some(asset=>asset.id===id)))throw userError('智能串联有序参考不属于当前项目或超过20项');
      // URL identities have already been deduplicated by the cascade. Distinct
      // URL references may resolve to the same local file; keep every role in
      // its original order. Ordinary image calls retain their ID deduplication.
      resolved.prompt=executionPrompt.prompt;
      resolved.referenceIds=[...ids];
    }
    if(resolved.referenceIds.length&&!model.referenceSupport)throw userError('当前模型未开启参考图支持，请清空参考图或修改模型能力设置');
    const maskAssetId=body.maskAssetId||null;
    let mask=null,maskedReference=null;
    if(maskAssetId){
      if(typeof maskAssetId!=='string'||!safeId(maskAssetId)||maskAssetId===resolved.referenceIds[0])throw userError('请选择有效的独立 PNG 遮罩素材');
      if(!project.assets.some(asset=>asset.id===maskAssetId))throw userError('遮罩素材不属于当前项目，请先将遮罩放入当前项目');
      if(!model.maskSupport)throw userError('请先在 API 设置中确认此图片模型支持遮罩重绘');
      if(resolved.referenceIds.length!==1)throw userError('遮罩重绘必须且只能选择一张底图');
      const maskMeta=await loadAsset(data,maskAssetId);
      const referenceMeta=await loadAsset(data,resolved.referenceIds[0]);
      if(maskMeta.type!=='image/png'||maskMeta.operation!=='image-edit'||maskMeta.editOutput!=='mask'||maskMeta.sourceAssetId!==referenceMeta.id)throw userError('遮罩必须来自所选底图对应的本机图片编辑记录');
      if(!['image/png','image/jpeg','image/webp'].includes(referenceMeta.type)||referenceMeta.size>10*1024*1024)throw userError('遮罩底图须为不超过 10 MB 的 PNG、JPEG 或 WebP');
      const [referenceSize,maskSize]=await Promise.all([
        imageDimensions({data,assetId:referenceMeta.id}),
        imageDimensions({data,assetId:maskMeta.id}),
      ]);
      if(referenceSize.width!==maskSize.width||referenceSize.height!==maskSize.height)throw userError('遮罩与底图尺寸必须完全一致');
      const [referenceBytes,maskBytes]=await Promise.all([
        fs.readFile(path.join(data,'assets',referenceMeta.id)),
        fs.readFile(path.join(data,'assets',maskAssetId)),
      ]);
      if(referenceBytes.length>10*1024*1024)throw userError('遮罩底图不能超过 10 MB');
      if(maskBytes.length>10*1024*1024)throw userError('PNG 遮罩不能超过 10 MB');
      const prepared=await openAIMaskInputs(referenceBytes,maskBytes,referenceSize);
      maskedReference={...prepared.reference,name:referenceMeta.name};
      mask={...prepared.mask,name:maskMeta.name};
    }
    const size=body.size||'auto',quality=body.quality||'auto';
    if(!/^(auto|[1-9]\d{1,4}x[1-9]\d{1,4})$/.test(size))throw userError('尺寸格式须为 宽x高 或 auto');
    if(!['auto','low','medium','high'].includes(quality))throw userError('质量参数无效');
    const hostname=new URL(platform.baseUrl).hostname,local=['localhost','127.0.0.1','[::1]'].includes(hostname);
    const a=body.authorization;
    if(!local&&(!a||a.origin!==new URL(platform.baseUrl).origin||a.model!==model.id||a.requestLimit!==1||a.sendPrompt!==true||(resolved.referenceIds.length&&a.sendReferences!==true)||(maskAssetId&&a.sendMask!==true)||!Number.isFinite(a.budget)||a.budget<=0||!['CNY','USD'].includes(a.currency)))throw userError('调用云平台前需确认服务、模型、本次文字/参考图/遮罩发送范围及预算');
    const credential=normalizeMiaoCredential(body,platform,{purpose:'image'});
    const references=[];let referenceBytes=0;
    for(const id of resolved.referenceIds){const meta=await loadAsset(data,id);if(!['image/png','image/jpeg','image/webp'].includes(meta.type)||meta.size>10*1024*1024)throw userError('参考图须为不超过 10 MB 的 PNG、JPEG 或 WebP');const prepared=id===resolved.referenceIds[0]&&maskedReference?maskedReference:null,bytes=prepared?.bytes||await fs.readFile(path.join(data,'assets',id)),mime=prepared?.mime||meta.type;if(bytes.length>10*1024*1024&&!prepared)throw userError('参考图过大');validateInputImage({bytes,mime,name:meta.name});referenceBytes+=bytes.length;assertImageRequestSize(referenceBytes+(mask?.bytes.length||0),resolved.prompt,model.id);references.push({bytes,mime,name:meta.name});}
    let key=(await resolveMiaoCredential(credential,platform,miaoCredentials,{purpose:'image'})).apiKey;
    if(key&&JSON.stringify({prompt:resolved.prompt,title:node.title,model:model.id,platformName:platform.name,size,quality}).includes(key))throw userError('提示词包含本次密钥，请移除后执行');
    const job={id:randomUUID(),requestId:body.requestId,kind:'image-api',projectId:project.id,...(parentId?{parentId}:{}),revision:project.revision,name:`${platform.name} · ${model.label}`,createdAt:new Date().toISOString(),status:'queued',progress:0,message:'等待提交图片生成',count:1,assets:[],items:[],applied:false,target:{id:node.id,assetId:node.assetId,text:node.text},input:{model:model.id,platformId:platform.id,platformName:platform.name,prompt:resolved.prompt,size,quality,referenceIds:resolved.referenceIds,...(maskAssetId?{maskAssetId}:{})},authorization:local?{scope:'local',requestLimit:1,...(maskAssetId?{maskIncluded:true}:{})}:{origin:a.origin,model:a.model,budget:a.budget,currency:a.currency,requestLimit:1,referenceCount:resolved.referenceIds.length,...(maskAssetId?{maskIncluded:true}:{})},billingStatus:'unknown',requestCount:0};
    await atomicJson(file(job.id),job);
    const controller=new AbortController(),unlink=linkCanvasChild(activeJobs,parentId,controller);activeJobs.set(job.id,{controller,projectId:project.id,kind:'image-api',...(parentId?{parentId}:{})});
    // Authentication remains in this closure only; it is never placed in job/config/history.
    void (async()=>{try{
      controller.signal.throwIfAborted();job.status='running';job.requestCount=1;job.progress=10;job.message='正在请求图片模型，请勿重复提交';await atomicJson(file(job.id),job);
      const result=await imageGenerator({baseUrl:platform.baseUrl,apiKey:key,model:model.id,prompt:resolved.prompt,size,quality,references,mask,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(180000)])});
      for(const output of result.images){const ext=({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'})[output.mime];const asset=await storeAsset(data,output.bytes,{name:`${node.title.slice(0,80)}-${job.id.slice(0,8)}.${ext}`,type:output.mime,source:'image-api',category:'生成素材',tags:[model.id.slice(0,40)]});job.assets.push(asset);await atomicJson(file(job.id),job);}
      if(!job.assets.length)throw userError('模型没有返回图片');
      job.usage=result.usage?(key?JSON.parse(JSON.stringify(result.usage).split(key).join('[已隐藏]')):result.usage):null;job.status='completed';job.progress=100;job.message='图片已生成，可加入当前项目';
    }catch(e){job.status=controller.signal.aborted?'cancelled':'failed';job.uncertain=e.uncertain!==false;job.message=controller.signal.aborted?'已停止等待；上游可能仍在处理或已计费，不会自动重试。':(typeof e.publicMessage==='string'?(key?e.publicMessage.split(key).join('[已隐藏]'):e.publicMessage):'图片请求未确认，请先检查平台任务和账单；不会自动重试。');}
    finally{unlink();key='';body.apiKey='';references.length=0;await atomicJson(file(job.id),job);activeJobs.delete(job.id);}})();
    const snapshot=structuredClone(job);return snapshot;
  }
  async function startFromCanvas(step,project,{apiKey,requestId,credentialSource,credentialConsent},parentId,{exactPrompt=false}={}){assertCanvasParent(activeJobs,parentId,project.id);const p=structuredClone(project),node=p.nodes.find(n=>n.id===step.nodeId);node.text=step.text;const referenceIds=step.image.referenceSources.map(r=>r.assetId||p.nodes.find(n=>n.id===r.sourceNodeId)?.assetId);if(referenceIds.some(id=>!id))throw userError('上游没有生成可用参考图');return start(p,{nodeId:node.id,revision:p.revision,requestId,apiKey,credentialSource,credentialConsent,platformId:step.image.platform.id,model:step.image.model,size:step.image.size,quality:step.image.quality,includeUpstream:false,referenceIds,authorization:step.authorization},step.image.platform,parentId,exactPrompt?{prompt:step.text,referenceIds}:undefined);}
  return {context,start:(project,body)=>start(project,body),startFromCanvas};
}
