import {nativeMediaVersion} from '../public/native-media-version.js';
import {isNativeLoop,nativeLoopSettings} from '../public/native-loop-core.js';
import {isNativePrompt,nativePromptSettings} from '../public/native-prompt-core.js';
import {randomUUID} from 'node:crypto';
import {makeProject,makeNode,validateProject} from './model.mjs';
import {assertNoCredentials,userError} from './workspace.mjs';
import {nativeNodeIssues,nativeTypeLabels,validateNativeUrls} from '../public/native-canvas-core.js';
import {minimaxTimelineOf} from '../public/minimax-h3-core.js';
import {nativeExecutionNodeIssues,nativeExecutionAncestors} from './native-flow-execution.mjs';

export function guardNativeTree(value,depth=0){
 if(depth>50)throw userError('原生工作流内容嵌套过深');
 if(!value||typeof value!=='object')return;
 for(const [key,child]of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(key))throw userError('原生工作流包含不支持的字段');guardNativeTree(child,depth+1);}
}
const sourceId=id=>{if(!['string','number'].includes(typeof id)||typeof id==='number'&&!Number.isSafeInteger(id)||!/^[\w-]{1,100}$/.test(String(id)))throw userError('原生工作流节点编号无效');return String(id);};
export function normalizeNativeWorkflow(input){
 guardNativeTree(input);assertNoCredentials(input);try{validateNativeUrls(input);}catch(e){throw userError(e.message);}
 const value=Array.isArray(input)?{nodes:input,connections:[]}:input?.workflow&&typeof input.workflow==='object'?input.workflow:input;
 if(!value||typeof value!=='object'||!Array.isArray(value.nodes)||!value.nodes.length||value.nodes.length>1500||!Array.isArray(value.connections??[])||(value.connections??[]).length>5000)throw userError('请选择含1–1500个节点及连接的 Infinite Canvas JSON/ZIP');
 if(value.format!==undefined&&!['infinite-canvas-workflow','infinite-smart-canvas-workflow'].includes(value.format)||value.version!==undefined&&value.version!==1)throw userError('不支持此原生工作流格式或版本');
 const ids=new Set();for(const n of value.nodes){const id=sourceId(n?.id);if(ids.has(id)||typeof n.type!=='string'||!n.type||n.type.length>100||['__proto__','constructor','prototype'].includes(n.type)||!Number.isFinite(n.x)||!Number.isFinite(n.y)||Math.abs(n.x)>1e7||Math.abs(n.y)>1e7)throw userError('原生节点编号重复、类型或坐标无效');ids.add(id);}
 for(const node of value.nodes)for(const input of Array.isArray(node.inputs)?node.inputs:[]){const match=typeof input==='string'&&input.match(/^[\w-]+:generated:\d+:(.+)$/);if(match)try{validateNativeUrls(match[1]);}catch(e){throw userError(e.message);}}
 const connectionIds=new Set();for(const c of value.connections||[]){if(!c||!ids.has(sourceId(c.from))||!ids.has(sourceId(c.to))||String(c.from)===String(c.to))throw userError('原生连线指向不存在的节点或自身');if(c.id!==undefined){const id=sourceId(c.id);if(connectionIds.has(id))throw userError('原生连线编号重复');connectionIds.add(id);}}
 if(value.resources!==undefined&&(!Array.isArray(value.resources)||value.resources.length>1000))throw userError('原生素材列表无效或超过1000份');
 const archives=new Set(),urls=new Set();for(const r of value.resources||[]){if(!r||typeof r.url!=='string'||!r.url||r.url.length>2048||typeof r.archive!=='string'||!r.archive||Buffer.byteLength(r.archive)>512||typeof r.name!=='string'||r.name.length>200||!Number.isSafeInteger(r.size)||r.size<1||r.size>4_000_000_000||archives.has(r.archive)||urls.has(r.url))throw userError('原生素材记录重复或字段无效');archives.add(r.archive);urls.add(r.url);}
 const format=value.format||(value.nodes.some(n=>n.type.startsWith('smart-'))?'infinite-smart-canvas-workflow':'infinite-canvas-workflow');
 return {...structuredClone(value),format,version:1,connections:structuredClone(value.connections||[]),resources:structuredClone(value.resources||[])};
}
export function parseNativeJson(bytes){let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,''));}catch{throw userError('原生工作流不是有效的 UTF-8 JSON');}return normalizeNativeWorkflow(value);}

export function resourceAliases(resource){return [...new Set([resource.url,resource.archive,'./'+resource.archive,resource.archive.split('/').at(-1)])];}
// These fields carry identifiers or user text, even when their value happens
// to equal a packaged filename. Rewriting them would corrupt source links.
const nativeLiteralFields=new Set(['id','type','text','prompt','negative_prompt','outputText','title','name','llmInstruction','variablePrompt','variablePrompts','promptSeparator']);
export function nodeMediaUrls(node,aliases=new Set()){
 const found=new Set();
 function walk(value,key=''){if(nativeLiteralFields.has(key))return;if(typeof value==='string'){if(aliases.has(value)||/^\/(assets|output)\//.test(value)||/^(url|src|image|images|video|audio|image_url|video_url|audio_url|preview|thumbnail|filename)$/i.test(key)&&value.trim())found.add(value);}else if(Array.isArray(value))for(const child of value)walk(child,key);else if(value&&typeof value==='object')for(const [name,child]of Object.entries(value))walk(child,name);}
 for(const [key,value]of Object.entries(node))if(!['items','inputs'].includes(key))walk(value,key);return [...found];
}
function mapType(node,asset){const type=node.type;if(['prompt','smart-prompt','llm','loop','smart-loop'].includes(type))return 'text';if(['group','smart-group','promptGroup'].includes(type))return 'scene';if(['video','minimax','smart-minimax','ltxDirector'].includes(type))return 'video';if(['image','smart-image','output'].includes(type)&&asset)return asset.type.split('/')[0];return 'image';}

export function nativeToFragment(document,resources,name){
 const rewrite=(value,key='')=>{if(nativeLiteralFields.has(key))return structuredClone(value);if(typeof value==='string')return aliasMap.get(value)?.portableUrl||value;if(Array.isArray(value))return value.map(child=>rewrite(child,key));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,child])=>[name,rewrite(child,name)]));return value;};
 const p=makeProject(name),maps=Object.fromEntries(document.nodes.map(n=>[String(n.id),randomUUID()])),aliasMap=new Map(),aliases=new Set(),usedFiles=new Map();
 for(const r of resources){for(const alias of resourceAliases(r)){if(aliasMap.has(alias)&&aliasMap.get(alias).asset.id!==r.asset.id)throw userError('素材别名重复，无法确定节点引用：'+alias);aliasMap.set(alias,r);aliases.add(alias);}usedFiles.set(r.asset.id,r);}
 if(document.format==='infinite-smart-canvas-workflow'&&document.nodes.some(n=>n.type==='smart-group'))p.settings.nativeMediaVersion=2;
 const inputReference=(input,index)=>{
  if(!['string','number'].includes(typeof input))return null;const value=String(input);
  if(maps[value])return{index,sourceNodeId:maps[value]};
  const prefix=document.nodes.find(source=>value.startsWith(String(source.id)+':'));if(!prefix)return null;
  const tail=value.slice(String(prefix.id).length+1),base={index,sourceNodeId:maps[String(prefix.id)]},generated=tail.match(/^generated:(\d+):(.+)$/);
  if(generated){const itemIndex=Number(generated[1]);if(!Number.isSafeInteger(itemIndex)||itemIndex>999)return null;return{...base,itemType:'generated',itemIndex,itemUrl:aliasMap.get(generated[2])?.portableUrl||generated[2]};}
  if(prefix.type==='group'&&tail==='prompts')return{...base,itemType:'group-prompts'};
  if(prefix.type==='group'&&(prefix.items||[]).some(id=>String(id)===tail))return{...base,itemType:'group-media',memberId:tail};
  return null;
 };
 p.nodes=document.nodes.map((source,index)=>{
  const urls=nodeMediaUrls(source,aliases),matched=urls.map(url=>aliasMap.get(url)).filter(Boolean),media=[...new Map(matched.map(r=>[r.asset.id,r])).values()],members=Array.isArray(source.items)?source.items.map(id=>{if(!maps[String(id)])throw userError('原生分组引用不存在的节点');return {sourceNodeId:maps[String(id)]};}):[],ownResources=media.map(r=>({url:r.portableUrl||r.url,archive:r.archive,assetId:r.asset.id}));
  // The first node also retains unreferenced packaged resources and document
  // metadata, so a native round trip cannot discard unused files or fields.
  if(index===0)for(const r of resources)if(!ownResources.some(x=>x.assetId===r.asset.id))ownResources.push({url:r.portableUrl||r.url,archive:r.archive,assetId:r.asset.id});
  const rawText=typeof source.text==='string'?source.text:typeof source.outputText==='string'?source.outputText:typeof source.prompt==='string'?source.prompt:'';
  if(rawText.length>200000)throw userError('原生节点文字超过20万字');
  const inputOrder=Array.isArray(source.inputs)?source.inputs.map(inputReference).filter(Boolean):[];
  const rawNode=rewrite(source);for(const key of ['items','inputs'])if(Object.hasOwn(source,key))rawNode[key]=structuredClone(source[key]);
  const nativeCanvas={inputOrder,version:1,format:document.format,node:rawNode,adaptation:'reference',resources:ownResources,missingResources:urls.filter(url=>!aliasMap.has(url)).map(url=>url.length>2048?'未打包的内嵌素材':url),members,mediaAssetIds:media.map(r=>r.asset.id),connectedOutput:source.type==='output'&&document.connections.some(c=>String(c.to)===String(source.id)),outgoingMedia:document.connections.some(c=>String(c.from)===String(source.id)),connectedGroup:['group','smart-group'].includes(source.type)&&document.connections.some(c=>String(c.from)===String(source.id)||String(c.to)===String(source.id))};
  if(index===0){nativeCanvas.header=rewrite(document);delete nativeCanvas.header.nodes;delete nativeCanvas.header.connections;}
  const n=makeNode(mapType(source,media[0]?.asset),source.x,source.y,{id:maps[String(source.id)],title:String(source.title||source.name||nativeTypeLabels[source.type]||source.type).slice(0,200),text:rawText,assetId:['image','smart-image','output'].includes(source.type)?media[0]?.asset.id||null:null,params:{nativeCanvas}});return n;
 });
 p.assets=[...usedFiles.values()].map(r=>r.asset);p.edges=document.connections.map(c=>({id:randomUUID(),source:maps[String(c.from)],target:maps[String(c.to)],nativeCanvasConnection:structuredClone(c)}));
 p.groups=[];const framed=new Set();for(const n of p.nodes.filter(n=>['group','smart-group','promptGroup'].includes(n.params.nativeCanvas.node.type)&&n.params.nativeCanvas.members.length)){const ids=n.params.nativeCanvas.members.map(m=>m.sourceNodeId);const frame={id:randomUUID(),title:n.title.slice(0,120),color:'#818cf8',collapsed:false};if(ids.some(id=>framed.has(id))){n.params.nativeCanvas.groupDisplayState=frame;continue;}ids.forEach(id=>framed.add(id));p.groups.push({...frame,nodeIds:ids});}
 p.shots=[];p.messages=[];p.runs=[];try{validateProject(p);}catch(e){throw userError(e.message);}assertNoCredentials(p);return p;
}
export function nativeFragmentSummary(project){const nodes=project.nodes.filter(n=>n.params?.nativeCanvas),issues=nodes.flatMap(n=>nativeNodeIssues(n,project).map(detail=>({nodeId:n.id,title:n.title,type:n.params.nativeCanvas.node.type,detail}))),counts=Object.create(null);for(const n of nodes){const type=n.params.nativeCanvas.node.type;counts[type]=(counts[type]||0)+1;}return {sourceFormat:nodes[0]?.params.nativeCanvas.format,nativeTypes:{...counts},issues:issues.slice(0,200),issueCount:issues.length,pendingNodes:new Set(issues.map(i=>i.nodeId)).size};}
export function assertNativeNodeReady(project,nodeId,{flow=false}={}){const node=project.nodes.find(n=>n.id===nodeId),issues=node?(flow?nativeExecutionNodeIssues(node,project):nativeNodeIssues(node,project)):[];if(issues.length)throw userError('原生节点尚不能执行；“'+node.title+'”：'+issues.slice(0,8).join('；'));}

export function fragmentToNative(project,assetRecords,{withResources=false}={}){
 if(!project.nodes.length)throw userError('请选择原生工作流节点');
 if(project.nodes.some(n=>n.params?.nativeMediaMap))throw userError('逐轮选图不能保存到原生格式，请使用 .jingchang 完整备份');
 const smartGroupIds=new Set(project.nodes.filter(n=>n.params?.nativeCanvas?.node.type==='smart-group').map(n=>n.id));
 if(smartGroupIds.size&&project.nodes.some(n=>nativeMediaVersion(project,n)!==2&&(smartGroupIds.has(n.id)||[...nativeExecutionAncestors(project,n.id)].some(id=>smartGroupIds.has(id)))))throw userError('此工程保留旧版素材范围，原生格式无法保存该规则；请使用 .jingchang 完整备份');
 if(project.nodes.some(node=>node.params?.nativeBranch?.enabled===true))throw userError('已启用镜场分支运行策略，请使用 .jingchang 保存迁移设置');
 const formats=new Set(project.nodes.map(n=>n.params?.nativeCanvas?.format||'infinite-canvas-workflow'));
 if(formats.size>1)throw userError('普通画布和智能画布请分别导出');
 const format=[...formats][0],smart=format==='infinite-smart-canvas-workflow',assets=new Map(assetRecords.map(a=>[a.id,a])),nativeIds=new Map(project.nodes.map(n=>[n.id,n.params?.nativeCanvas?.node.id??n.id])),replacements=new Map(),records=[];
 // Retain source IDs so opaque source parameters keep their original references.
 // Two copies of a source graph must be exported separately rather than guessing
 // how an unsupported node's nested references should be renamed.
 if(new Set([...nativeIds.values()].map(String)).size!==nativeIds.size)throw userError('选区包含重复的原生节点编号，请分别导出各份原生工作流，或使用 .jingchang 保存');
 for(const a of assetRecords){const archive='resources/'+a.id+pathExtension(a.name,a.type),url='/assets/input/'+a.id+pathExtension(a.name,a.type);records.push({url,archive,name:a.name,size:a.size});}
 const recordMap=new Map(assetRecords.map((a,i)=>[a.id,records[i]]));
 for(const n of project.nodes)for(const r of n.params?.nativeCanvas?.resources||[]){const a=recordMap.get(r.assetId);if(!a)throw userError('导出缺少原生素材');for(const alias of resourceAliases(r)){if(replacements.has(alias)&&replacements.get(alias)!==a.url)throw userError('多个已插入工作流使用同一原生素材别名，请分别导出');replacements.set(alias,a.url);}}
 function replace(value,key=''){if(nativeLiteralFields.has(key))return structuredClone(value);if(typeof value==='string')return replacements.get(value)||value;if(Array.isArray(value))return value.map(child=>replace(child,key));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replace(v,k)]));return value;}
 const nodes=project.nodes.map(n=>{
  const native=n.params?.nativeCanvas;
  if(minimaxTimelineOf(n))throw userError('H3 时间轴包含镜场片段、参考及结果配置，请使用 .jingchang 导出，避免丢失未绑定或已编辑的时间轴');
  if(native){const raw=replace(native.node);raw.id=nativeIds.get(n.id);raw.x=n.x;raw.y=n.y;if(['group','promptGroup'].includes(raw.type))raw.title=n.title;if(['prompt','smart-prompt'].includes(raw.type))raw.text=n.text;if(isNativePrompt(n)&&n.params.nativePrompt){const settings=nativePromptSettings(n);Object.assign(raw,{promptSplitEnabled:settings.splitEnabled,promptSeparator:settings.separator,llmEnabled:settings.llmEnabled,llmInstruction:settings.instruction,promptSplitPreviewHeight:settings.previewHeight});}if(isNativeLoop(n)&&n.params.nativeLoop){const settings=nativeLoopSettings(n);Object.assign(raw,{mode:settings.mode,parallel:settings.mode==='parallel',count:settings.count,loopStart:settings.start,showPrompt:settings.showPrompt,imageInput:settings.imageInput,imageBatchSize:settings.imageBatchSize,videoInput:settings.videoInput,videoBatchSize:settings.videoBatchSize,variablePrompt:settings.variablePrompt});if(settings.variablePrompts===null)delete raw.variablePrompts;else raw.variablePrompts=[...settings.variablePrompts];}if(Array.isArray(raw.inputs)){raw.inputs=structuredClone(native.node.inputs);for(const ref of native.inputOrder||[])if(nativeIds.has(ref.sourceNodeId)){const sourceId=nativeIds.get(ref.sourceNodeId);raw.inputs[ref.index]=ref.itemType==='generated'?`${sourceId}:generated:${ref.itemIndex}:${replace(ref.itemUrl)}`:ref.itemType==='group-media'?`${sourceId}:${ref.memberId}`:ref.itemType==='group-prompts'?`${sourceId}:prompts`:sourceId;}}if(Array.isArray(raw.items))raw.items=native.members.filter(m=>nativeIds.has(m.sourceNodeId)).map(m=>nativeIds.get(m.sourceNodeId));if(native.adaptation==='configured')throw userError('已迁移为镜场生成配置的节点请使用 .jingchang 导出，原生平台配置不能等同转换');return raw;}
  if([n.params?.workflowBinding,n.params?.cloudBinding,n.params?.imageBinding,n.params?.llmBinding,n.params?.studioBinding].some(Boolean)||n.type==='loop')throw userError('此镜场执行配置没有等价的原生字段，请使用 .jingchang 导出');
  if(n.assetId){const a=assets.get(n.assetId),r=recordMap.get(n.assetId);if(!a||!r)throw userError('节点素材缺失');if(smart)return {id:n.id,type:'smart-image',x:n.x,y:n.y,title:n.title,images:[{url:r.url,name:a.name,type:a.type}]};return {id:n.id,type:'image',x:n.x,y:n.y,name:n.title,url:r.url};}
  return {id:n.id,type:smart?'smart-prompt':'prompt',x:n.x,y:n.y,title:n.title,text:n.text};
 });
 const header=replace(project.nodes.find(n=>n.params?.nativeCanvas?.header)?.params.nativeCanvas.header||{}),connections=project.edges.map(e=>({...replace(e.nativeCanvasConnection||{}),id:e.id,from:nativeIds.get(e.source),to:nativeIds.get(e.target)}));
 const result={...header,format,version:1,exported_at:Date.now(),nodes,connections,resources:withResources?records:[],...(smart?{canvas_type:'smart'}:{})};
 // JSON without media must retain original external/local references, rather
 // than pretending generated /assets/input paths exist in the other app.
 if(!withResources&&assetRecords.length)throw userError('此工作流含本机素材，请导出 ZIP；JSON 仅用于无本机素材的工作流');
 return normalizeNativeWorkflow(result);
}
function pathExtension(name,type){const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/avif':'avif','image/bmp':'bmp','video/mp4':'mp4','video/quicktime':'mov','video/webm':'webm','video/x-flv':'flv','video/x-matroska':'mkv','audio/mpeg':'mp3','audio/mp3':'mp3','audio/wav':'wav','audio/x-wav':'wav','audio/wave':'wav','audio/ogg':'ogg','audio/opus':'opus','audio/flac':'flac','audio/x-flac':'flac','audio/mp4':'m4a','audio/x-m4a':'m4a','audio/aac':'aac','audio/webm':'webm'}[type.split(';')[0]];if(!ext)throw userError('原生工作流不支持此素材格式');return '.'+ext;}
