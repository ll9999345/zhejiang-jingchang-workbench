import {minimaxTimelineOf} from './minimax-h3-core.js';
import {isNativePrompt,nativePromptSettings} from './native-prompt-core.js';
import {isNativeLoop,nativeLoopSettings,nativeLoopEnabled} from './native-loop-core.js';
import {nativeWorkflowSettings} from './native-workflow-config.js';
import {normalizeNativeModelscopeConfig,normalizeNativeModelscopeSize,nativeModelscopeModel,studioRequestCount} from './native-modelscope-core.js';
import {nativeBranchSettings,isNativeBranchLoop} from './native-branch-core.js';
const nativeTypes=new Set(['image','prompt','loop','smart-loop','group','promptGroup','llm','generator','midjourney','msgen','video','minimax','rh','comfy','ltxDirector','output','smart-image','smart-prompt','smart-group','smart-minimax']);
const generationTypes=new Set(['llm','generator','midjourney','msgen','video','rh','comfy','ltxDirector','minimax','smart-minimax']);
export const nativeTypeLabels={image:'参考素材',prompt:'提示词',loop:'原生循环',group:'原生分组',promptGroup:'提示词组',llm:'语言模型',generator:'在线图片',midjourney:'Midjourney',msgen:'ModelScope',video:'视频生成',minimax:'MiniMax H3',rh:'RunningHub',comfy:'ComfyUI',ltxDirector:'LTX 导演',output:'输出素材','smart-image':'智能素材','smart-prompt':'智能提示词','smart-loop':'智能循环','smart-group':'智能分组','smart-minimax':'MiniMax H3'};
const safeId=id=>typeof id==='string'&&/^[\w-]{1,100}$/.test(id);
export function nativeNodeIssues(node,project){
 const value=node.params?.nativeCanvas;if(!value)return [];
 const source=value.node,issues=[];
 for(const url of value.adaptation==='configured'?[]:value.missingResources||[])issues.push('缺少本地素材：'+url);
 const type=source.type;
 const outgoing=project?project.edges.some(e=>e.source===node.id):value.outgoingMedia,connectedOutput=project?type==='output'&&project.edges.some(e=>e.target===node.id):value.connectedOutput,connectedGroup=project?['group','smart-group'].includes(type)&&project.edges.some(e=>e.source===node.id||e.target===node.id):value.connectedGroup;
 if(connectedOutput)issues.push('原生输出节点接收并展示整组生成结果尚待迁移');
 if(outgoing&&value.mediaAssetIds.length>1&&!(value.adaptation==='configured'&&minimaxTimelineOf(node)))issues.push('原生多素材节点向下游传递整组素材尚待迁移');
 if(!nativeTypes.has(type))issues.push('尚未适配的原生节点类型：'+type);
 else if(['minimax','smart-minimax'].includes(type)&&!(value.adaptation==='configured'&&(node.params?.workflowBinding?.minimaxH3||node.params?.cloudBinding?.minimaxH3)))issues.push('MiniMax H3 请通过专用时间轴选择执行方式并确认迁移');
 else if(isNativeLoop(node)){
  let enabled=false;try{enabled=nativeLoopEnabled(node);}catch(error){issues.push(error.message);}
  if(!enabled)issues.push('原生循环尚未启用，请核对起始计数、轮数和媒体批次');
  if([node.params.workflowBinding,node.params.cloudBinding,node.params.imageBinding,node.params.studioBinding,node.params.llmBinding].some(Boolean))issues.push('原生循环只传递每轮数据，生成方式应绑定到下游节点');
 }
 else if(type==='promptGroup')issues.push('原生提示词组的聚合语义尚待迁移');
 else if(['group','smart-group'].includes(type)&&connectedGroup)issues.push('原生分组作为输入输出的聚合语义尚待迁移');
 else if(type==='smart-prompt'){
  let settings;try{settings=nativePromptSettings(node);}catch(error){issues.push(error.message);}
  if(settings?.llmEnabled){if(!node.params.llmBinding)issues.push('智能提示词语言模型尚未绑定本机平台和模型');else if(value.adaptation!=='configured')issues.push('请检查智能提示词的指令、模型和素材映射并确认迁移');}
  if([node.params.workflowBinding,node.params.cloudBinding,node.params.imageBinding,node.params.studioBinding].some(Boolean))issues.push('智能提示词只支持语言模型绑定');
 }
 else if(type==='smart-image'&&source.runSettings){
  if(value.adaptation!=='configured')issues.push('智能素材的原生生成设置尚待迁移');
  else if(nativeWorkflowSettings(node,'modelscope')){
   const binding=node.params?.studioBinding;
   if(!binding||binding.mode!=='image'||binding.config?.protocol!=='modelscope'||binding.config.nativeModelscope===undefined)issues.push('智能素材的原生 ModelScope 图片配置缺失，请核对模型、数量及尺寸并确认迁移');
   else try{
    const marker=normalizeNativeModelscopeConfig(binding.config.nativeModelscope),definition=nativeModelscopeModel(marker);
    studioRequestCount(binding);normalizeNativeModelscopeSize(binding.config.size);
    if(marker.modelKey!==(source.runSettings.msgenModel||'zimage'))issues.push('智能素材的 ModelScope 模型标记与原设置不符，请重新核对迁移');
    if(definition.modelId&&binding.config.model!==definition.modelId)issues.push('智能素材的 ModelScope 模型编号与固定原版不符');
    if(!definition.modelId&&(typeof binding.config.model!=='string'||!binding.config.model.trim()))issues.push('智能素材的自定义 ModelScope 模型编号缺失');
    if([node.params?.workflowBinding,node.params?.cloudBinding,node.params?.imageBinding,node.params?.llmBinding].some(Boolean))issues.push('智能素材的 ModelScope 与其他生成绑定冲突，请只保留已确认的执行方式');
   }catch(error){issues.push(error.message);}
  }else if(!node.params?.workflowBinding&&!node.params?.cloudBinding)issues.push('智能素材的本机工作流绑定缺失');
 }
 else if(generationTypes.has(type)){
  if(value.adaptation!=='configured')issues.push('请检查原始参数，重新绑定本机平台或工作流并确认迁移');
  else if(![node.params?.workflowBinding,node.params?.cloudBinding,node.params?.imageBinding,node.params?.llmBinding,node.params?.studioBinding].filter(Boolean).length)issues.push('迁移后的生成配置缺失');
 }
 return issues;
}
export function syncNativeConnections(project){
 for(const n of project.nodes){const value=n.params?.nativeCanvas;if(!value)continue;const type=value.node.type;value.outgoingMedia=project.edges.some(e=>e.source===n.id);value.connectedOutput=type==='output'&&project.edges.some(e=>e.target===n.id);value.connectedGroup=['group','smart-group'].includes(type)&&project.edges.some(e=>e.source===n.id||e.target===n.id);}
 return project;
}
export function nativeCanConfigure(node){return generationTypes.has(node.params?.nativeCanvas?.node?.type)||isNativePrompt(node)||node.params?.nativeCanvas?.node?.type==='smart-image'&&!!(nativeWorkflowSettings(node,'comfy')||nativeWorkflowSettings(node,'runninghub')||nativeWorkflowSettings(node,'modelscope'));}
export function validateNativeUrls(value,depth=0){
 if(depth>50)throw Error('原生工作流内容嵌套过深');
 if(typeof value==='string'&&/^https?:\/\//i.test(value)){let url;try{url=new URL(value);}catch{return;}if(url.username||url.password||[...url.searchParams.keys()].some(key=>/^(api[_-]?key|auth[_-]?(key|token)|access[_-]?token|token|authorization|password|secret|sig|signature|x-amz-(security-token|signature)|x-oss-security-token|x-goog-signature)$/i.test(key)))throw Error('原生工作流包含带认证信息的地址，请移除凭据或导出本机素材 ZIP');}
 else if(value&&typeof value==='object')for(const [key,child]of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(key))throw Error('原生工作流包含不支持的字段');validateNativeUrls(child,depth+1);}
}
export function validateNativeNode(node,project){
 const value=node.params?.nativeCanvas;if(value===undefined){if(node.params?.nativePrompt!==undefined)throw Error('智能提示词设置必须属于原生智能提示词节点');if(node.params?.nativeLoop!==undefined)throw Error('原生循环设置必须属于原生循环节点');if(node.params?.nativeBranch!==undefined)throw Error('智能分支设置必须属于原生智能循环');return;}
 if(!value||value.version!==1||!['infinite-canvas-workflow','infinite-smart-canvas-workflow'].includes(value.format)||!value.node||typeof value.node.type!=='string'||value.node.type.length>100||!['reference','configured'].includes(value.adaptation)||!Array.isArray(value.resources)||value.resources.length>1000||!Array.isArray(value.missingResources)||value.missingResources.length>1000||!Array.isArray(value.members)||value.members.length>1500||!Array.isArray(value.mediaAssetIds)||value.mediaAssetIds.length>1000||typeof value.connectedGroup!=='boolean'||typeof value.connectedOutput!=='boolean'||typeof value.outgoingMedia!=='boolean')throw Error('原生工作流节点记录无效');
 const assets=new Set(project.assets.map(a=>a.id)),nodes=new Set(project.nodes.map(n=>n.id));
 for(const resource of value.resources)if(!resource||typeof resource.url!=='string'||!resource.url||resource.url.length>12000000||!safeId(resource.assetId)||!assets.has(resource.assetId)||typeof resource.archive!=='string'||resource.archive.length>512)throw Error('原生工作流素材映射无效或文件缺失');
 if(value.mediaAssetIds.some(id=>!safeId(id)||!assets.has(id))||value.missingResources.some(url=>typeof url!=='string'||!url||url.length>2048)||value.members.some(ref=>!safeId(ref.sourceNodeId)||!nodes.has(ref.sourceNodeId)))throw Error('原生工作流依赖节点或缺失素材记录无效');
 if(value.adaptation==='configured'&&!nativeCanConfigure(node))throw Error('此原生节点还不能迁移为已配置节点');
 if(value.node.type==='smart-prompt')nativePromptSettings(node);else if(node.params?.nativePrompt!==undefined)throw Error('智能提示词设置必须属于原生智能提示词节点');
 if(isNativeLoop(node))nativeLoopSettings(node);else if(node.params?.nativeLoop!==undefined)throw Error('原生循环设置必须属于原生循环节点');
 if(node.params?.nativeBranch!==undefined){if(!isNativeBranchLoop(node))throw Error('智能分支设置必须属于原生智能循环');nativeBranchSettings(node);}
 if(!Array.isArray(value.inputOrder)||value.inputOrder.length>1500||value.inputOrder.some(ref=>!ref||!Number.isInteger(ref.index)||ref.index<0||ref.index>1499||!safeId(ref.sourceNodeId)||!nodes.has(ref.sourceNodeId)))throw Error('原生节点输入次序记录无效');
 validateNativeUrls(value.node);validateNativeUrls(value.header);for(const resource of value.resources)validateNativeUrls(resource.url);
}
