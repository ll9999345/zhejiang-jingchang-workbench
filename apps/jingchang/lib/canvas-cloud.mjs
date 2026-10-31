import {nativeMediaVersion} from '../public/native-media-version.js';
import {prepareNativeH3} from './native-director-inputs.mjs';
import {resolveRhLoras} from './runninghub-loras.mjs';
import {normalizeCloudRecipe} from './cloud-recipes.mjs';
import {cloudRandomFields} from './workflow-random.mjs';
import {normalizeCloudOverrides} from './native-workflow-config.mjs';
import {activeRhFields,compileRhModel,checkRhModelMedia} from './runninghub-models.mjs';
import {checkRhMedia} from './runninghub.mjs';
import {loadAsset,userError,assertNoCredentials,safeId} from './workspace.mjs';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {promptAssetIds} from './prompt-assets.mjs';
import {compileMinimaxRunningHub} from './minimax-h3-runninghub.mjs';
import {captureMinimaxResultTarget,minimaxUpstreamRefs} from './minimax-h3.mjs';
import {nativeExecutionMedia,selectNativeExecutionMedia,needsNativeFlow} from './native-flow-execution.mjs';
export async function cloudStep({data,project,node,binding,parents,text,promptReferences=[],cloudWorkflows,loopContexts={}}){
 if(!cloudWorkflows)throw userError('云工作流执行器未配置');
 let recipe=structuredClone(await cloudWorkflows.get(binding.recipeId));
 if(recipe.projectId!==project.id||recipe.revision!==binding.recipeRevision)throw userError('云工作流不属于当前项目或绑定版本已更新，请重新绑定');
 Object.assign(recipe,normalizeCloudRecipe(recipe));assertNoCredentials(recipe);const textOutput=recipe.kind==='model'&&recipe.outputType==='string';if(recipe.kind==='model'&&(!textOutput&&!(recipe.outputType===node.type||recipe.outputType==='3d'&&node.type==='scene')||textOutput&&!['text','script'].includes(node.type))||recipe.kind!=='model'&&!['image','video','audio'].includes(node.type))throw userError('云工作流的输出类型与画布节点不一致');
 if(!Array.isArray(binding.inputs)||binding.inputs.length>200)throw userError('云工作流映射无效');
 const overrides=normalizeCloudOverrides(binding.overrides,recipe),overridden=new Set(overrides.map(field=>field.nodeId+':'+field.fieldName));
 if((binding.inputs||[]).some(input=>overridden.has(input.nodeId+':'+input.fieldName)))throw userError('云节点字段不能同时覆盖固定值与映射上游输入');
 for(const override of overrides)recipe.fields.find(field=>field.nodeId===override.nodeId&&field.fieldName===override.fieldName).fieldValue=override.fieldValue;
 Object.assign(recipe,normalizeCloudRecipe(recipe));
 const used=new Set(),nativeInputs=[],nativeFlow=needsNativeFlow(project,node,parents);let inputs=[],h3=null,minimaxRecipe=null,nativeH3=null;
 if(binding.minimaxH3){if(node.type!=='video'||binding.inputs.length||binding.minimaxH3.engine!=='runninghub')throw userError('H3 云时间轴只用于视频节点，参考由时间轴管理');minimaxRecipe=structuredClone(recipe);nativeH3=nativeFlow?prepareNativeH3(project,node,binding.minimaxH3,{planning:true,loopContexts,text}):null;h3=compileMinimaxRunningHub(nativeH3?.timeline||binding.minimaxH3,recipe,{project,parents,text,upstreamRefs:nativeH3?[]:minimaxUpstreamRefs(project,parents)});recipe=h3.recipe;inputs=h3.inputs;}
 for(const input of binding.inputs){const key=input.nodeId+':'+input.fieldName,f=recipe.fields.find(f=>f.nodeId===input.nodeId&&f.fieldName===input.fieldName);if(f?.source==='lora')throw userError('LoRA 文件字段不能映射上游文字，请先在云配置中解除 LoRA 选择');if(!f||used.has(key))throw userError('云工作流映射字段重复或不存在');used.add(key);f.enabled=true;
  if(input.useText===true){if(input.sourceNodeId||input.sourceIndex!==undefined||f.type!=='text'||!text||text.length>20000)throw userError('上游提示词映射须为文字字段且1–20000字');f.fieldValue=text;f.source='value';delete f.assetId;inputs.push({nodeId:f.nodeId,fieldName:f.fieldName,useText:true});}
  else{
   const source=project.nodes.find(n=>n.id===input.sourceNodeId);
   if(!source||!parents.has(source.id)||!['image','video','audio'].includes(f.type))throw userError('云工作流素材须来自连线且类型匹配的上游');
   if(nativeFlow||source.params?.nativeCanvas||input.sourceIndex!==undefined){
    const value=nativeExecutionMedia(project,source.id,{execution:true,loopContexts,mediaVersion:nativeMediaVersion(project,node)}),selected=selectNativeExecutionMedia(value,input.sourceIndex,{planning:true});
    const candidates=selected?[selected]:value.media.filter(item=>item.kind===f.type),pending=value.pendingNodeIds.filter(id=>project.nodes.find(n=>n.id===id)?.type===f.type);
    if(selected?selected.kind!==f.type:!candidates.length&&!pending.length)throw userError('原生素材条目与云工作流字段类型不匹配');
    // Check every static candidate when pending results can still move the
    // selected position. No upload or upstream submission happens here.
    for(const item of candidates)await checkAsset(data,project,item.assetId,f.type,recipe.kind==='model'?f:null);
    nativeInputs.push({nodeId:f.nodeId,fieldName:f.fieldName,sourceNodeId:source.id,...(input.sourceIndex!==undefined?{sourceIndex:input.sourceIndex}:{}),kind:f.type,fieldLabel:f.label,sourceName:source.title,...(selected?{assetId:selected.assetId,name:project.assets.find(a=>a.id===selected.assetId)?.name}:{pendingNodeIds:[...value.pendingNodeIds]})});
   }else if(source.type!==f.type||!source.assetId&&!source.params?.workflowBinding&&!source.params?.cloudBinding&&!source.params?.imageBinding&&!source.params?.studioBinding)throw userError('云工作流素材须来自连线且类型匹配的上游');
   inputs.push({nodeId:f.nodeId,fieldName:f.fieldName,sourceNodeId:source.id,...(input.sourceIndex!==undefined?{sourceIndex:input.sourceIndex}:{})});f.source='value';f.fieldValue='';delete f.assetId;
  }
 }
 const mentioned=h3?[]:promptReferences.length?promptReferences:promptAssetIds(project,node);
 for(const assetId of mentioned){if(activeRhFields(recipe).some(f=>f.source==='asset'&&f.assetId===assetId))continue;const field=recipe.fields.find(f=>f.type==='image'&&f.source!=='lora'&&(recipe.kind!=='model'||f.enabled!==false)&&!used.has(f.nodeId+':'+f.fieldName));if(!field)throw userError('提示词中的 @ 图片需要云工作流包含未映射的图片输入字段');field.enabled=true;field.source='asset';field.assetId=assetId;field.fieldValue='';used.add(field.nodeId+':'+field.fieldName);}
 const refs=new Set([...activeRhFields(recipe).filter(f=>f.source==='asset').map(f=>'asset:'+f.assetId),...inputs.filter(f=>f.sourceNodeId).map(f=>{const native=nativeInputs.find(i=>i.nodeId===f.nodeId&&i.fieldName===f.fieldName);return native?.assetId?'asset:'+native.assetId:'node:'+f.sourceNodeId+':'+(f.sourceIndex??0);})]);if(refs.size>(recipe.minimaxProfile==='h3'?15:recipe.kind==='model'?32:8))throw userError('云节点参考素材数量超过允许范围');
 if(recipe.minimaxProfile==='h3')for(const [kind,limit]of Object.entries({image:9,video:3,audio:3})){const fields=activeRhFields(recipe).filter(f=>f.type===kind&&(f.source==='asset'||inputs.some(i=>i.sourceNodeId&&i.nodeId===f.nodeId&&i.fieldName===f.fieldName)));if(fields.length>limit)throw userError('H3 '+kind+'参考素材超过'+limit+'项');}
 const sendAssets=activeRhFields(recipe).some(f=>f.source==='asset')||inputs.some(f=>f.sourceNodeId);
 for(const f of activeRhFields(recipe).filter(f=>f.source==='asset'))await checkAsset(data,project,f.assetId,f.type,recipe.kind==='model'?f:null);
 // Existing static upstream assets can be checked before any node is submitted.
 for(const input of inputs.filter(f=>f.sourceNodeId&&!nativeInputs.some(i=>i.nodeId===f.nodeId&&i.fieldName===f.fieldName))){const source=project.nodes.find(n=>n.id===input.sourceNodeId);if(source.assetId&&!source.params?.workflowBinding&&!source.params?.cloudBinding&&!source.params?.imageBinding&&!source.params?.studioBinding)await checkAsset(data,project,source.assetId,source.type,recipe.kind==='model'?recipe.fields.find(f=>f.nodeId===input.nodeId&&f.fieldName===input.fieldName):null);}
 await resolveRhLoras({data,project,recipe});
  if(recipe.kind==='model')compileRhModel(recipe,{allowAssets:true,allowMissing:new Set(inputs.map(f=>f.nodeId+':'+f.fieldName))});
 const random=cloudRandomFields(recipe,binding.randomFields??(h3?[]:undefined));if(h3&&random.length)throw userError('H3 随机由片段管理，请关闭通用字段随机');
 return{kind:'runninghub',nodeId:node.id,title:node.title,recipeId:recipe.id,recipe,outputType:recipe.kind==='model'?recipe.outputType:null,inputs,text,count:1,status:'pending',sendAssets,...(random.length||binding.randomFields!==undefined||recipe.fields.some(f=>f.randomEnabled)?{randomFields:random.map(({nodeId,name})=>({nodeId,name})),randomDescriptors:random}:{}),...(nativeInputs.length?{nativeInputs:{version:1,fields:nativeInputs}}:{}),...(h3?{minimaxH3:nativeH3?.original||h3.timeline,...(nativeH3?{nativeDirectorInputs:nativeH3.ledger}:{}),minimaxRecipe,minimaxParents:[...parents],minimaxUpstreamRefs:nativeH3?[]:minimaxUpstreamRefs(project,parents),minimaxResultTarget:captureMinimaxResultTarget(node,nativeH3?.original||h3.timeline,{project,parents})}:{})};
}
async function checkAsset(data,project,id,type,field){if(!project.assets.some(a=>a.id===id))throw userError('云工作流素材不属于当前项目');const a=await loadAsset(data,id),file=path.join(data,'assets',id),st=await fs.lstat(file);if(!st.isFile()||st.size>30*1024*1024||a.size!==st.size||a.type.split('/')[0]!==type)throw userError('云工作流素材类型或大小不匹配');const bytes=await fs.readFile(file);if(field)checkRhModelMedia(bytes,a.type,field);else checkRhMedia(bytes,a.type);}
export async function resolveCloudRecipe(step,project,{data,outputs=[]}={}){
 if(step.minimaxH3)return compileMinimaxRunningHub(step.minimaxH3,step.minimaxRecipe,{project,parents:new Set(step.minimaxParents),text:step.text,upstreamRefs:step.minimaxUpstreamRefs,resolve:true}).recipe;
 const recipe=structuredClone(step.recipe);
 for(const input of step.inputs){
  const f=recipe.fields.find(f=>f.nodeId===input.nodeId&&f.fieldName===input.fieldName);if(!f)throw userError('云工作流映射字段不存在');
  if(input.useText)f.fieldValue=step.text;
  if(input.sourceNodeId){
   const native=step.nativeInputs?.fields.find(i=>i.nodeId===input.nodeId&&i.fieldName===input.fieldName);let assetId;
   if(native){
    if(native.sourceNodeId!==input.sourceNodeId||native.sourceIndex!==input.sourceIndex||native.kind!==f.type)throw userError('云工作流素材映射与已确认范围不一致');
    const selected=selectNativeExecutionMedia(nativeExecutionMedia(project,input.sourceNodeId,{outputs,execution:true,loopContexts:step.nativeLoop?.contexts,mediaVersion:nativeMediaVersion(project,project.nodes.find(n=>n.id===step.nodeId))}),input.sourceIndex);
    if(selected.kind!==native.kind)throw userError('实际生成素材与云工作流字段类型不匹配，后续未提交');
    if(native.assetId&&selected.assetId!==native.assetId)throw userError('已确认的固定素材发生变化，后续未提交');
    if(!data)throw userError('云工作流素材执行前检查未配置');assetId=selected.assetId;
    await checkAsset(data,project,assetId,f.type,recipe.kind==='model'?f:null);
   }else assetId=project.nodes.find(n=>n.id===input.sourceNodeId)?.assetId;
   if(!assetId)throw userError('上游没有生成可用素材');f.source='asset';f.assetId=assetId;f.fieldValue='';
  }
 }
 return recipe;
}
export function cloudCredentials(steps,body,{resume=false}={}){
 const required=steps.filter(s=>s.kind==='runninghub'&&s.status!=='completed'),provided=body.cloudCredentials??[];
 if(!Array.isArray(provided)||provided.length!==required.length||new Set(provided.map(x=>x?.nodeId)).size!==provided.length)throw userError('请为每个待执行云节点填写本次密钥和授权');
 if(provided.some(x=>!x||!safeId(x.nodeId)))throw userError('云节点授权格式无效');
 const keys=new Map();for(const step of required){const item=provided.find(x=>x.nodeId===(step.executionId||step.nodeId));if(!item||typeof item.apiKey!=='string'||!item.apiKey.trim()||item.apiKey.length>4096||/[\r\n]/.test(item.apiKey))throw userError('请输入每个云节点本次使用的密钥');keys.set(step.executionId||step.nodeId,item.apiKey.trim());if(resume)continue;const a=item.authorization,r=step.recipe;if(!a||a.origin!==new URL(r.baseUrl).origin||a.targetId!==r.targetId||a.kind!==r.kind||a.requestLimit!==1||a.sendFields!==true||a.sendAssets!==step.sendAssets||!Number.isFinite(a.budget)||a.budget<=0||!['CNY','USD'].includes(a.currency))throw userError('请逐个确认云节点的服务、字段、素材、预算和一次生成范围');if(r.workflowJson?a.sendWorkflow!==true:a.sendWorkflow===true)throw userError('请确认此云节点的 API 整图发送范围');step.authorization={origin:a.origin,targetId:r.targetId,kind:r.kind,requestLimit:1,sendFields:true,sendAssets:step.sendAssets,...(r.workflowJson?{sendWorkflow:true}:{}),budget:a.budget,currency:a.currency};}
 return keys;
}
export function clearCloudCredentials(body){if(Array.isArray(body?.cloudCredentials))for(const item of body.cloudCredentials)if(item&&typeof item==='object')item.apiKey='';}
