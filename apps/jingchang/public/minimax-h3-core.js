import {sourceIndexFields} from './source-index-core.js';
export const minimaxLimits={image:9,video:3,audio:3};
export function supportsMinimaxRhAsset(a){return ['image/png','image/jpeg','image/webp','video/mp4','video/quicktime','audio/mpeg','audio/wav','audio/flac'].includes(a?.type)&&a.size>0&&a.size<=(a.type.startsWith('image/')?10:30)*1024*1024;}
export const minimaxRatios={'16:9':'16:9 (Widescreen)','9:16':'9:16 (Portrait)','1:1':'1:1 (Square)','4:3':'4:3 (Standard)','3:4':'3:4 (Portrait)','21:9':'21:9 (Ultrawide)','9:21':'9:21 (Portrait)'};
export const minimaxParameterNames={prompt:'提示词',duration:'生成时长（秒）',aspectRatio:'画面比例',megapixels:'百万像素',seed:'种子'};
const safeId=id=>typeof id==='string'&&/^[\w-]{1,100}$/.test(id);
const fail=message=>{throw Error(message);};
const number=(value,min,max,label)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)fail(label+'超出范围');return value;};
export function normalizeMinimaxRefs(refs=[]){
 if(!Array.isArray(refs)||refs.length>15)fail('H3 参考素材最多9张图、3段视频、3段音频');
 const counts={image:0,video:0,audio:0},seen=new Set();
 return refs.map(r=>{if(!r||!Object.hasOwn(counts,r.kind)||!!r.assetId===!!r.sourceNodeId||!safeId(r.assetId||r.sourceNodeId))fail('H3 参考素材须选择项目素材或上游节点');
  const index=sourceIndexFields(r),key=[r.kind,r.assetId?'asset':'node',r.assetId||r.sourceNodeId,r.sourceIndex??''].join(':');if(seen.has(key))fail('H3 同类参考素材不能重复');seen.add(key);if(++counts[r.kind]>minimaxLimits[r.kind])fail('H3 '+r.kind+'参考素材超过'+minimaxLimits[r.kind]+'项');
  return {kind:r.kind,...(r.assetId?{assetId:r.assetId}:{sourceNodeId:r.sourceNodeId}),...index};});
}
export function newMinimaxSegment(id,start=0,base={}){return {id,start,duration:8,prompt:'',aspectRatio:'16:9',megapixels:.4,seed:1,refs:[],trimIn:0,trimOut:8,resultAssetId:null,resultAssetIds:[],...base};}
export function minimaxParameters(segment,prompt=segment?.prompt){
 if(typeof prompt!=='string'||prompt.length>32000)fail('H3 每段提示词最多32000字');
 if(!Object.hasOwn(minimaxRatios,segment?.aspectRatio))fail('H3 画面比例无效');
 if(!Number.isSafeInteger(segment.seed)||segment.seed<0)fail('H3 种子须为非负安全整数');
 return {prompt,duration:number(segment.duration,.5,60,'H3 片段时长'),aspectRatio:segment.aspectRatio,megapixels:number(segment.megapixels,.1,2,'H3 百万像素'),seed:segment.seed};
}
// A loop changes its execution snapshot, while the editable source timeline stays intact.
export function applyMinimaxLoopValues(input,values){
 const t=normalizeMinimaxTimeline(input),s=selectedMinimaxSegment(t),before=s.duration;
 for(const [name,value]of Object.entries(values)){if(!Object.hasOwn(minimaxParameterNames,name))fail('不支持的 H3 逐轮参数');s[name]=value;if(name==='seed')delete s.seedMode;}
 minimaxParameters(s);
 if(before!==s.duration){const index=t.segments.indexOf(s);for(const next of t.segments.slice(index+1))next.start=Math.round((next.start+s.duration-before)*1e6)/1e6;s.trimIn=Math.min(s.trimIn,s.duration-.1);s.trimOut=Math.max(s.trimIn+.1,Math.min(s.trimOut,s.duration));}
 return normalizeMinimaxTimeline(t);
}
export function normalizeMinimaxTimeline(value){
 if(!value||value.version!==1||!Array.isArray(value.segments)||value.segments.length<1||value.segments.length>64)fail('H3 时间轴须包含1–64个片段');
 if(value.engine!==undefined&&!['comfyui','runninghub'].includes(value.engine))fail('H3 执行方式无效');
 if(value.referenceNodeId!==undefined&&value.referenceNodeId!==''&&!safeId(value.referenceNodeId))fail('H3 工作流参考节点编号无效');
 const ids=new Set();let end=0;
 const segments=value.segments.map(s=>{
  if(!s||!safeId(s.id)||ids.has(s.id))fail('H3 片段编号无效或重复');ids.add(s.id);
  const start=number(s.start,0,21600,'H3 片段起点'),duration=number(s.duration,.5,60,'H3 片段时长');
  if(start+1e-7<end||start+duration>21600)fail('H3 片段不能重叠或超过6小时');end=start+duration;
  if(typeof s.prompt!=='string'||s.prompt.length>32000)fail('H3 每段提示词最多32000字');
  if(!Object.hasOwn(minimaxRatios,s.aspectRatio))fail('H3 画面比例无效');
  const megapixels=number(s.megapixels,.1,2,'H3 百万像素');if(!Number.isSafeInteger(s.seed)||s.seed<0)fail('H3 种子须为非负安全整数');
  if(s.seedMode!==undefined&&!['fixed','random'].includes(s.seedMode))fail('H3 种子方式无效');
  const trimIn=number(s.trimIn??0,0,duration-.1,'H3 裁切入点'),trimOut=number(s.trimOut??duration,trimIn+.1,duration,'H3 裁切出点');
  const results=s.resultAssetIds??[];if(!Array.isArray(results)||results.length>100||new Set(results).size!==results.length||results.some(id=>!safeId(id)))fail('H3 片段结果记录无效');
  const resultAssetId=s.resultAssetId??null;if(resultAssetId&&(!safeId(resultAssetId)||!results.includes(resultAssetId)))fail('H3 当前结果不在片段结果列表中');
  let resultVariants;
  if(s.resultVariants!==undefined){if(!Array.isArray(s.resultVariants)||s.resultVariants.length>100||new Set(s.resultVariants.map(r=>r?.assetId)).size!==s.resultVariants.length)fail('H3 逐轮结果记录无效');resultVariants=s.resultVariants.map(r=>{if(!r||!results.includes(r.assetId)||(r.loopId!==undefined||r.roundIndex!==undefined)&&(!safeId(r.loopId)||!Number.isInteger(r.roundIndex)||r.roundIndex<0||r.roundIndex>99))fail('H3 逐轮结果记录无效');return{assetId:r.assetId,...(r.loopId!==undefined?{loopId:r.loopId,roundIndex:r.roundIndex}:{}),parameters:minimaxParameters(r.parameters)};});}
  return {id:s.id,start,duration,prompt:s.prompt,aspectRatio:s.aspectRatio,megapixels,seed:s.seed,...(s.seedMode==='random'?{seedMode:'random'}:{}),refs:normalizeMinimaxRefs(s.refs),trimIn,trimOut,resultAssetId,resultAssetIds:[...results],...(resultVariants?{resultVariants}:{})};
 });
 if(!ids.has(value.selectedSegmentId))fail('请选择 H3 时间轴中的片段');
 const materials=value.materials??[];if(!Array.isArray(materials)||materials.length>1000||materials.some(r=>!r||!safeId(r.assetId)||(r.segmentId!==undefined&&!safeId(r.segmentId))))fail('H3 素材抽屉记录无效');
 return {version:1,engine:value.engine||'comfyui',referenceNodeId:value.referenceNodeId||'',selectedSegmentId:value.selectedSegmentId,segments,refs:normalizeMinimaxRefs(value.refs),materials:materials.map(r=>({assetId:r.assetId,...(r.segmentId?{segmentId:r.segmentId}:{})})),autoUpstream:value.autoUpstream!==false,fallbackByKind:value.fallbackByKind===true,playhead:number(value.playhead??0,0,21600,'H3 播放头'),muted:value.muted===true,timelineZoom:number(value.timelineZoom??1,.25,8,'H3 时间轴缩放')};
}
// Return original objects so callers can remap ids during copy/import.
export function minimaxReferences(t){return t?[...(t.refs||[]),...(t.segments||[]).flatMap(s=>s.refs||[])]:[];}
export function minimaxAssetIds(t){return t?[...new Set([...minimaxReferences(t).map(r=>r.assetId),...(t.segments||[]).flatMap(s=>[s.resultAssetId,...(s.resultAssetIds||[])]),...(t.materials||[]).map(r=>r.assetId)].filter(Boolean))]:[];}
export function selectedMinimaxSegment(t){return t.segments.find(s=>s.id===t.selectedSegmentId);}
export function minimaxTimelineOf(node){return node?.params?.workflowBinding?.minimaxH3||node?.params?.cloudBinding?.minimaxH3||node?.params?.minimaxH3;}
export function compactMinimaxSegments(t){let start=0;for(const s of t.segments){s.start=Math.round(start*1000)/1000;start+=s.duration;}return t;}
export function minimaxSegmentSignature(s){const {resultAssetId,resultAssetIds,resultVariants,trimIn,trimOut,...input}=s;return JSON.stringify(input);}

export function nativeMinimaxResolver(project){
 const resources=project.nodes.flatMap(n=>n.params?.nativeCanvas?.resources||[]);
 return r=>{
  // A result's nodeId can be the provider's output id, rather than a canvas id.
  if(!r.asResult&&r.nodeId!==undefined){const n=project.nodes.find(n=>n.params?.nativeCanvas&&String(n.params.nativeCanvas.node.id)===String(r.nodeId));if(n)return {sourceNodeId:n.id};}
  const record=resources.find(x=>[x.url,x.archive,'./'+x.archive,x.archive.split('/').at(-1)].includes(r.url));return record?{assetId:record.assetId}:null;
 };
}

function nativeRefs(value,resolve){
 const raw=Array.isArray(value)?value:Array.isArray(value?.refItems)&&value.refItems.length?value.refItems:Object.entries(value?.refs||value||{}).filter(([kind,v])=>Object.hasOwn(minimaxLimits,kind)&&Array.isArray(v)).flatMap(([kind,items])=>items.map(r=>typeof r==='string'?{kind,url:r}:{...r,kind}));
 return normalizeMinimaxRefs(raw.map(r=>{if(typeof r==='string')r={kind:'image',url:r};const kind=String(r.kind||r.type||'').split('/')[0];if(!Object.hasOwn(minimaxLimits,kind))fail('原生 H3 参考素材类型无效');const ref=resolve({...r,kind});if(!ref)fail('原生 H3 参考素材尚未导入：'+(r.name||r.url||r.nodeId||kind));return {kind,...ref};}));
}
export function minimaxFromNative(source,resolve,id){
 if(!['minimax','smart-minimax'].includes(source?.type))fail('不是原生 H3 节点');
 if(source.minimaxEngine&&!['comfyui','runninghub'].includes(source.minimaxEngine))fail('原生 H3 执行方式尚未支持');
 const global=nativeRefs(source.refs||[],resolve),segments=(source.segments?.length?source.segments:[{id,start:0,duration:source.duration||8,prompt:source.promptDraftText||''}]).map((s,index)=>{
  const duration=Number(s.duration??source.duration??8),ratio=String(s.aspectRatio||source.aspectRatio||'16:9').match(/\d+:\d+/)?.[0];
  const explicit=nativeRefs(Array.isArray(s.refs)?s.refs:s,resolve);let refs=explicit;
  const resultAssetIds=[];for(const result of [...(s.results||[]),...(s.result?[s.result]:[])]){const ref=resolve({...result,kind:result.kind||'video',asResult:true});if(!ref?.assetId)fail('原生 H3 生成结果尚未导入：'+(result.name||result.url||index));if(!resultAssetIds.includes(ref.assetId))resultAssetIds.push(ref.assetId);}
  const primary=s.result?resolve({...s.result,kind:s.result.kind||'video',asResult:true})?.assetId:null;
  return newMinimaxSegment(s.id||id+'-'+index,Number(s.start??0),{duration,prompt:s.prompt||'',aspectRatio:ratio,megapixels:Number(s.megapixels??source.megapixels??.4),seed:Number(s.seed??source.seed??1),...(source.minimaxEngine!=='runninghub'?{seedMode:'random'}:{}),refs,trimIn:Number(s.trimIn??0),trimOut:Number(s.trimOut??duration),resultAssetId:primary,resultAssetIds});
 });
 const materials=(source.materials||[]).map(r=>{const ref=resolve({...r,kind:r.kind||'video',asResult:true});if(!ref?.assetId)fail('原生 H3 素材尚未导入：'+(r.name||r.url));return {assetId:ref.assetId,...(r.segmentId?{segmentId:r.segmentId}:{})};});
 return normalizeMinimaxTimeline({version:1,engine:source.minimaxEngine||'comfyui',segments,refs:global,materials,selectedSegmentId:segments.some(s=>s.id===source.selectedSegmentId)?source.selectedSegmentId:segments[0].id,playhead:Number(source.playhead||0),timelineZoom:Number(source.timelineZoom||1),muted:source.minimaxMuted===true,autoUpstream:true,fallbackByKind:source.type==='smart-minimax'});
}

const linked=(graph,value,types,name)=>{const node=Array.isArray(value)&&value[1]===0?graph[value[0]]:null;if(!node||!types.includes(node.class_type)||typeof node.inputs?.[name]!==(name==='value'&&types.includes('PrimitiveFloat')?'number':'string'))throw Error('H3 工作流 '+name+'连接或节点类型不匹配');return {nodeId:String(value[0]),name};};
export function minimaxGraphContract(graph,referenceNodeId=''){
 const references=Object.entries(graph).filter(([,n])=>n.class_type==='MiniMaxH3ReferenceToVideo');
 const pair=referenceNodeId?references.find(([id])=>id===referenceNodeId):references.length===1?references[0]:null;
 if(!pair)throw Error('请选择含唯一 MiniMaxH3ReferenceToVideo 的 API 工作流，或指定参考节点');
 const [referenceId,reference]=pair,prompt=linked(graph,reference.inputs?.prompt,['PrimitiveStringMultiline','PrimitiveString'],'value'),resolution=graph[reference.inputs?.width?.[0]],ratioId=reference.inputs?.width?.[0];
 if(resolution?.class_type!=='ResolutionSelector'||reference.inputs.width[1]!==0||reference.inputs?.height?.[0]!==ratioId||reference.inputs.height[1]!==1||typeof resolution.inputs?.aspect_ratio!=='string'||typeof resolution.inputs?.megapixels!=='number')throw Error('H3 工作流缺少相连的 ResolutionSelector');
 const length=graph[reference.inputs?.length?.[0]];if(length?.class_type!=='ComfyMathExpression')throw Error('H3 工作流缺少时长表达式');
 const duration=linked(graph,length.inputs?.['values.a'],['PrimitiveFloat'],'value');
 const seeds=Object.entries(graph).filter(([,n])=>n.class_type==='RandomNoise'&&Number.isSafeInteger(n.inputs?.noise_seed));if(seeds.length!==1)throw Error('H3 工作流需要唯一 RandomNoise 种子节点');
 return {referenceNodeId:referenceId,prompt,duration,ratio:{nodeId:ratioId,name:'aspect_ratio'},megapixels:{nodeId:ratioId,name:'megapixels'},seed:{nodeId:seeds[0][0],name:'noise_seed'}};
}
