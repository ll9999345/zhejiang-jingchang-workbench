import {nativeExecutionMedia,selectNativeExecutionMedia} from './native-flow-execution.mjs';
import {normalizeLtxTimeline,ltxPromptSchedule,ltxReferences} from '../public/ltx-director-core.js';
import {supportsComfyAsset} from '../public/comfy-media.js';
import {userError} from './workspace.mjs';
import {renderSource} from './render-inputs.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
const required=['global_prompt','timeline_data','local_prompts','segment_lengths','guide_strength','duration_frames','duration_seconds','frame_rate','display_mode','custom_width','custom_height','resize_method','divisible_by','img_compression','epsilon','use_custom_audio'];
export const ltxManagedFields=[...required,'start_frame','end_frame','start_second','end_second'];
export function compileLtxTimeline(input,graph,{project,parents,resolve=false,text}={}){
 let t;try{t=normalizeLtxTimeline(input);}catch(e){throw userError(e.message);}
 const node=Object.hasOwn(graph,t.nodeId)?graph[t.nodeId]:null;
 if(node?.class_type!=='LTXDirector')throw userError('工作流缺少选定的 LTXDirector 节点');
 for(const name of required)if(!Object.hasOwn(node.inputs||{},name))throw userError('LTX 工作流缺少时间线字段：'+name);
 for(const s of ltxReferences(t)){
  const kinds=s.type==='image'?['image']:['audio'],media={kinds};
  if(s.sourceNodeId){
   const n=project?.nodes.find(n=>n.id===s.sourceNodeId);
   if(!parents?.has(s.sourceNodeId)||!n||!kinds.includes(n.type)||!n.assetId&&!['workflowBinding','cloudBinding','studioBinding','imageBinding'].some(k=>n.params?.[k]))throw userError('LTX 动态素材须来自相连且类型匹配的上游节点');
   if(resolve){const selected=s.sourceIndex!==undefined?selectNativeExecutionMedia(nativeExecutionMedia(project,n.id,{consumer:'loop'}),s.sourceIndex):null;if(selected&&selected.kind!==s.type)throw userError('LTX 上游素材条目类型不匹配');if(!selected&&!n.assetId)throw userError('LTX 上游节点尚未返回素材');s.assetId=selected?.assetId||n.assetId;delete s.sourceNodeId;delete s.sourceIndex;}
  }
  if(s.assetId&&!project?.assets.some(a=>a.id===s.assetId&&supportsComfyAsset(media,a)))throw userError('LTX 片段素材不属于项目、格式不匹配或超过大小限制');
 }
 const schedule=ltxPromptSchedule(t),bindings=[];
 const tracks=Object.fromEntries(['segments','audioSegments'].map(track=>[track,t[track].filter(s=>s.start<t.durationFrames&&(track!=='audioSegments'||t.useCustomAudio)).map(s=>{
  const {assetId,sourceNodeId,sourceIndex,...wire}=s;
  if(s.type!=='text'){wire[s.type==='image'?'imageFile':'audioFile']='';bindings.push({nodeId:t.nodeId,name:'timeline_data',ltxTrack:track,segmentId:s.id,...(assetId?{assetId}:{sourceNodeId,...(sourceIndex!==undefined?{sourceIndex}:{})})});}
  return wire;
 })]));
 const global=t.includeUpstream&&text?[text,t.globalPrompt].filter(Boolean).join('\n\n'):t.globalPrompt;
 if(global.length>32000)throw userError('LTX 全局与上游提示词合计不能超过32000字');
 const values={global_prompt:global,timeline_data:JSON.stringify(tracks),local_prompts:schedule.localPrompts,segment_lengths:schedule.segmentLengths,guide_strength:tracks.segments.filter(s=>s.type==='image').map(s=>s.guideStrength.toFixed(2)).join(','),duration_frames:t.durationFrames,duration_seconds:t.durationFrames/t.frameRate,frame_rate:t.frameRate,display_mode:t.displayMode,custom_width:t.width,custom_height:t.height,resize_method:t.resizeMethod,divisible_by:t.divisibleBy,img_compression:t.compression,epsilon:t.epsilon,use_custom_audio:t.useCustomAudio};
 // Newer nodes add explicit in/out fields; synchronize only fields present in the imported workflow.
 for(const [name,value] of Object.entries({start_frame:0,end_frame:t.durationFrames,start_second:0,end_second:t.durationFrames/t.frameRate}))if(Object.hasOwn(node.inputs,name))values[name]=value;
 for(const [name,value] of Object.entries(values))if(typeof node.inputs[name]!==typeof value)throw userError('LTX 工作流字段类型不匹配：'+name);
 if(bindings.some(b=>b.ltxTrack==='segments')&&!Object.values(graph).some(n=>n.class_type==='LTXDirectorGuide'&&Array.isArray(n.inputs?.guide_data)&&n.inputs.guide_data[0]===t.nodeId))throw userError('图片时间线需要连接此导演节点 guide_data 的 LTXDirectorGuide');
 return {timeline:t,overrides:Object.entries(values).map(([name,value])=>({nodeId:t.nodeId,name,value})),bindings};
}
export async function checkLtxAudio(data,t,project){
 if(!t?.useCustomAudio)return;const sources=new Map();
 const command=async(cmd,args,signal,options={})=>{const {stdout}=await run(cmd,args,{signal,timeout:15000,maxBuffer:8*1024*1024});options.onStdout?.(Buffer.from(stdout));return stdout;};
 for(const s of t.audioSegments.filter(s=>s.start<t.durationFrames)){
  if(!sources.has(s.assetId))sources.set(s.assetId,await renderSource(data,project.assets.find(a=>a.id===s.assetId),command));
  const source=sources.get(s.assetId),length=Math.min(s.length,t.durationFrames-s.start);
  if(s.trimStart/t.frameRate>=source.duration||(s.trimStart+length)/t.frameRate>source.duration+1/t.frameRate)throw userError('LTX 音频片段超出素材时长，请调整音频入点或片段长度：'+source.name);
 }
}
export function rejectLtxConflicts(t,fields){if(!t)return;for(const f of fields.filter(Boolean))if(f.nodeId===t.nodeId&&ltxManagedFields.includes(f.name))throw userError('LTX 时间线字段由导演面板管理，不能同时设置覆盖、列表或上游文字映射');}
export function assignLtxMedia(graph,binding,value){
 const n=graph[binding.nodeId];if(n?.class_type!=='LTXDirector'||binding.name!=='timeline_data'||!['segments','audioSegments'].includes(binding.ltxTrack))throw userError('LTX 媒体映射无效');
 const data=JSON.parse(n.inputs.timeline_data),s=data[binding.ltxTrack]?.find(s=>s.id===binding.segmentId);
 if(!s||!['image','audio'].includes(s.type))throw userError('LTX 媒体片段不存在');
 s[s.type==='image'?'imageFile':'audioFile']=value;n.inputs.timeline_data=JSON.stringify(data);
}
