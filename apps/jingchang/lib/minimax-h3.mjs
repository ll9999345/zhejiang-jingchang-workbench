import {nativeExecutionMedia,selectNativeExecutionMedia} from './native-flow-execution.mjs';
import {normalizeMinimaxTimeline,normalizeMinimaxRefs,minimaxRatios,selectedMinimaxSegment,minimaxReferences,minimaxSegmentSignature,minimaxTimelineOf,minimaxParameters} from '../public/minimax-h3-core.js';
import {randomUUID,createHash} from 'node:crypto';
import {supportsComfyAsset} from '../public/comfy-media.js';
import {userError} from './workspace.mjs';
export {minimaxGraphContract} from '../public/minimax-h3-core.js';
import {minimaxGraphContract} from '../public/minimax-h3-core.js';
export function rejectMinimaxConflicts(contract,fields=[]){
 const keys=new Set(Object.values(contract).filter(v=>v&&typeof v==='object').map(f=>JSON.stringify([f.nodeId,f.name])));
 for(const f of fields.filter(Boolean))if(keys.has(JSON.stringify([f.nodeId,f.name]))||f.nodeId===contract.referenceNodeId&&/^ref_(images|videos|audios)\./.test(f.name))throw userError('H3 片段参数由时间轴管理，不能同时覆盖、批量或映射同一字段');
}
export function compileMinimaxH3(input,graph,{project,parents,resolve=false,text='',upstreamRefs=[],referenceAllowed=(a,kind)=>supportsComfyAsset({kinds:[kind]},a)}={}){
 let timeline;try{timeline=normalizeMinimaxTimeline(input);}catch(e){throw userError(e.message);}
 let contract;try{contract=minimaxGraphContract(graph,timeline.referenceNodeId);}catch(e){throw userError(e.message);}
 const segment=selectedMinimaxSegment(timeline),fallback=timeline.autoUpstream?upstreamRefs:[],raw=segment.refs.length?segment.refs:timeline.fallbackByKind?['image','video','audio'].flatMap(kind=>timeline.refs.some(r=>r.kind===kind)?timeline.refs.filter(r=>r.kind===kind):fallback.filter(r=>r.kind===kind)):timeline.refs.length?timeline.refs:fallback;
 let refs;try{refs=normalizeMinimaxRefs(raw);}catch(e){throw userError(e.message);}
 if(typeof text!=='string')throw userError('H3 上游文字无效');const prompt=segment.prompt.trim()||(timeline.autoUpstream?text.trim():'');if(!prompt||prompt.length>32000)throw userError('H3 当前片段需要1–32000字提示词，或连接上游文字');
 for(const ref of refs){
  if(ref.sourceNodeId){const source=project?.nodes.find(n=>n.id===ref.sourceNodeId);if(!source||parents&&!parents.has(source.id)||source.type!==ref.kind||!source.assetId&&!['workflowBinding','cloudBinding','imageBinding','studioBinding'].some(k=>source.params?.[k]))throw userError('H3 动态参考须来自相连且类型匹配的上游节点');if(resolve){const selected=ref.sourceIndex!==undefined?selectNativeExecutionMedia(nativeExecutionMedia(project,source.id,{consumer:'loop'}),ref.sourceIndex):null;if(selected&&selected.kind!==ref.kind)throw userError('H3 上游素材条目类型不匹配');if(!selected&&!source.assetId)throw userError('H3 上游素材尚未生成');ref.assetId=selected?.assetId||source.assetId;delete ref.sourceNodeId;delete ref.sourceIndex;}}
  if(ref.assetId&&!project?.assets.some(a=>a.id===ref.assetId&&a.type.startsWith(ref.kind+'/')&&referenceAllowed(a,ref.kind)))throw userError('H3 参考素材不属于项目或类型、大小不匹配');
 }
 const ratio=Object.values(minimaxRatios).includes(graph[contract.ratio.nodeId].inputs.aspect_ratio)?minimaxRatios[segment.aspectRatio]:segment.aspectRatio;
 const overrides=[{...contract.prompt,value:prompt},{...contract.duration,value:segment.duration},{...contract.ratio,value:ratio},{...contract.megapixels,value:segment.megapixels},{...contract.seed,value:segment.seed}];
 const compiled=structuredClone(graph);for(const f of overrides)compiled[f.nodeId].inputs[f.name]=f.value;
 const refNode=compiled[contract.referenceNodeId];for(const key of Object.keys(refNode.inputs))if(/^ref_(images|videos|audios)\./.test(key))delete refNode.inputs[key];
 const counts={image:0,video:0,audio:0},bindings=[];let suffix=0;
 const add=(class_type,inputs)=>{let id;do{id='jc-h3-'+suffix++;}while(Object.hasOwn(compiled,id));compiled[id]={class_type,inputs};return id;};
 for(const ref of refs){const i=counts[ref.kind]++,media=ref.kind==='image'?{class_type:'LoadImage',name:'image'}:ref.kind==='video'?{class_type:'LoadVideo',name:'file'}:{class_type:'LoadAudio',name:'audio'},nodeId=add(media.class_type,{[media.name]:''});let outputId=nodeId;
  if(ref.kind==='video')outputId=add('GetVideoComponents',{video:[nodeId,0]});
  refNode.inputs['ref_'+ref.kind+'s.ref_'+ref.kind+'_'+i]=[outputId,0];bindings.push({nodeId,name:media.name,...(ref.assetId?{assetId:ref.assetId}:{sourceNodeId:ref.sourceNodeId,...(ref.sourceIndex!==undefined?{sourceIndex:ref.sourceIndex}:{})})});
 }
 return {timeline,segment,contract,graph:compiled,bindings,overrides,signature:minimaxSegmentSignature(segment)};
}
export function minimaxUpstreamRefs(project,parents){return project.nodes.filter(n=>parents.has(n.id)&&['image','video','audio'].includes(n.type)).map(n=>({kind:n.type,sourceNodeId:n.id}));}
const dependencyHash=node=>createHash('sha256').update(JSON.stringify([node.text,node.assetId,node.params])).digest('hex');
export function captureMinimaxDependencies(project,ids){return [...ids].map(id=>project.nodes.find(n=>n.id===id)).filter(Boolean).map(n=>({nodeId:n.id,sha256:dependencyHash(n)}));}
const resultState=(t,s)=>createHash('sha256').update(JSON.stringify([s.resultAssetIds,s.resultVariants||[],t.materials])).digest('hex');
export function minimaxAttachmentState(node,segmentId){const t=minimaxTimelineOf(node),s=t?.segments.find(s=>s.id===segmentId);return s?{nodeId:node.id,segmentId,resultAssetId:s.resultAssetId,resultState:resultState(t,s)}:null;}
export function captureMinimaxResultTarget(node,timeline,{project,parents}={}){const segment=selectedMinimaxSegment(timeline),dependencies=project?captureMinimaxDependencies(project,parents||[]):[];return {nodeId:node.id,segmentId:segment.id,signature:minimaxSegmentSignature(segment),engine:timeline.engine||'comfyui',...(node.params?.cloudBinding?.minimaxH3?{recipeId:node.params.cloudBinding.recipeId,recipeRevision:node.params.cloudBinding.recipeRevision}:{workflowId:node.params?.workflowBinding?.workflowId}),resultAssetId:segment.resultAssetId,resultState:resultState(timeline,segment),refs:JSON.stringify(timeline.refs),autoUpstream:timeline.autoUpstream,fallbackByKind:timeline.fallbackByKind,referenceNodeId:timeline.referenceNodeId,...(project?{nodeText:node.text,dependencies}:{})};}
export function attachMinimaxResults(project,target,assets,{guardProject=project}={}){
 const guardNode=guardProject.nodes.find(n=>n.id===target?.nodeId),guardInput=guardNode?.params?.workflowBinding?.minimaxH3||guardNode?.params?.cloudBinding?.minimaxH3;if(!guardInput)return false;
 if(target.nodeText!==undefined&&target.nodeText!==guardNode.text||(target.dependencies||[]).some(d=>{const n=guardProject.nodes.find(n=>n.id===d.nodeId);return !n||dependencyHash(n)!==d.sha256;}))return false;
 const guard=normalizeMinimaxTimeline(guardInput),before=guard.segments.find(s=>s.id===target.segmentId);
 const sameBinding=guard.engine==='runninghub'?target.recipeId===guardNode.params.cloudBinding?.recipeId&&target.recipeRevision===guardNode.params.cloudBinding?.recipeRevision:target.workflowId===guardNode.params.workflowBinding?.workflowId;
 if(!before||!sameBinding||(target.engine||'comfyui')!==guard.engine||target.signature!==minimaxSegmentSignature(before)||target.refs!==JSON.stringify(guard.refs)||target.autoUpstream!==guard.autoUpstream||target.fallbackByKind!==guard.fallbackByKind||target.referenceNodeId!==guard.referenceNodeId||before.resultAssetId!==target.resultAssetId||target.resultState&&target.resultState!==resultState(guard,before))return false;
 const videos=assets.filter(a=>a.type.startsWith('video/'));if(!videos.length)return false;
 const node=project.nodes.find(n=>n.id===target.nodeId),original=node.params.workflowBinding?.minimaxH3||node.params.cloudBinding?.minimaxH3,timeline=normalizeMinimaxTimeline(original),segment=timeline.segments.find(s=>s.id===target.segmentId);
 const additions=videos.filter(a=>!segment.resultAssetIds.includes(a.id)),materials=assets.filter(a=>!timeline.materials.some(r=>r.assetId===a.id));
 // Capacity blocks only attachment; independent result nodes keep every generated file.
 if(segment.resultAssetIds.length+additions.length>100||timeline.materials.length+materials.length>1000)return false;
 const primary=videos.every(a=>a.loopId)?videos.reduce((last,a)=>a.roundIndex>=last.roundIndex?a:last):videos[0];
 segment.resultAssetId=primary.id;for(const a of additions)segment.resultAssetIds.push(a.id);
 for(const a of additions)if(a.minimaxParameters){(segment.resultVariants??=[]).push({assetId:a.id,...(a.loopId?{loopId:a.loopId,roundIndex:a.roundIndex}:{}),parameters:minimaxParameters(a.minimaxParameters)});}
 if(primary.minimaxParameters?.duration<segment.trimOut){segment.trimOut=primary.minimaxParameters.duration;segment.trimIn=Math.min(segment.trimIn,segment.trimOut-.1);}
 for(const a of materials)timeline.materials.push({assetId:a.id,segmentId:segment.id});Object.assign(original,normalizeMinimaxTimeline(timeline));node.assetId=primary.id;return true;
}
export {minimaxReferences};

export function minimaxExportProject(project,{nodeId,selectedOnly=false}={}){
 const node=project.nodes.find(n=>n.id===nodeId);let timeline;try{timeline=normalizeMinimaxTimeline(minimaxTimelineOf(node));}catch(e){throw userError(e.message);}
 const clips=selectedOnly?[selectedMinimaxSegment(timeline)]:timeline.segments;
 if(clips.some(s=>!s.resultAssetId||!project.assets.some(a=>a.id===s.resultAssetId&&a.type.startsWith('video/'))))throw userError('导出范围内每个片段都需要本机视频结果，请先生成或选择素材');
 const snapshot=structuredClone(project);snapshot.name=(project.name+' · H3 '+(selectedOnly?'片段':'时间轴')).slice(0,120);
 snapshot.shots=clips.map((s,i)=>({id:randomUUID(),title:'H3 片段 '+(i+1),description:s.prompt,duration:Math.round((s.trimOut-s.trimIn)*1000000)/1000000,assetId:s.resultAssetId,audioId:null,edit:{sourceStart:s.trimIn,sourceEnd:s.trimOut,endMode:'strict',fit:'contain',sourceAudio:timeline.muted?'mute':'keep'}}));
 snapshot.settings.edit={burnSubtitles:false,music:[]};return snapshot;
}
