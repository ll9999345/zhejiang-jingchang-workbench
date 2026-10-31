import {randomUUID,createHash} from 'node:crypto';
import {attachMinimaxResults,minimaxAttachmentState,captureMinimaxDependencies} from './minimax-h3.mjs';
import {minimaxTimelineOf} from '../public/minimax-h3-core.js';
import {makeNode,validateProject} from './model.mjs';
import {loadAsset,userError} from './workspace.mjs';
import {imageAssetReferences,jobReferenceAssetIds} from './media-lineage.mjs';
import {nativeExecutionAncestors} from './native-flow-execution.mjs';
import {sortNativeLoopResults} from './native-loop-results.mjs';
import {nativeBranchEnabled} from '../public/native-branch-core.js';
const paramsHash=node=>createHash('sha256').update(JSON.stringify(node.params)).digest('hex');
export function captureNativeResultTargets(project){return project.nodes.filter(n=>n.params?.nativeCanvas?.adaptation==='configured').map(n=>({id:n.id,assetId:n.assetId,text:n.text,paramsSha256:paramsHash(n)}));}
const nativeGenerationTypes=new Set(['generator','midjourney','msgen','comfy','ltxDirector','video','rh','minimax','smart-minimax','smart-image']);
const dependencyState=node=>({id:node.id,type:node.type,assetId:node.assetId,text:node.text,paramsSha256:paramsHash(node)});
const edgeState=(project,ids,targetId)=>project.edges.filter(e=>e.target===targetId||ids.has(e.source)&&ids.has(e.target)).map(e=>JSON.stringify(e)).sort();
export function captureNativeOutputTargets(project){return project.nodes.filter(node=>node.params?.nativeCanvas?.node.type==='output').map(node=>{const ids=nativeExecutionAncestors(project,node.id);return{...dependencyState(node),dependencies:project.nodes.filter(n=>ids.has(n.id)).map(dependencyState),edges:edgeState(project,ids,node.id),...(project.nodes.some(n=>ids.has(n.id)&&nativeBranchEnabled(n))?{nativeBranchLayout:project.nodes.filter(n=>ids.has(n.id)&&n.params?.nativeCanvas?.node.type==='smart-image').map(n=>({id:n.id,x:n.x,y:n.y}))}:{})};});}
function appendNativeResource(node,asset){const native=node.params.nativeCanvas;if(!native.resources.some(r=>r.assetId===asset.id))native.resources.push({assetId:asset.id,url:asset.url,archive:'resources/'+asset.id});}
const nativeMediaItem=asset=>({url:asset.url,name:asset.name,kind:asset.type.split('/')[0],type:asset.type});
function attachNativeOutputs(project,guardProject,job,pending){
 const attached=[];
 for(const initial of job.nativeOutputTargets||[]){
  const previous=project.runs.filter(r=>r.jobId===job.id).flatMap(r=>r.nativeOutputAttachments||[]).findLast(r=>r.nodeId===initial.id),original=previous?.state||initial;
  const before=guardProject.nodes.find(n=>n.id===original.id),target=project.nodes.find(n=>n.id===original.id);
  const {dependencies,edges,nativeBranchLayout,...state}=original;
  if(!before||before.params?.nativeCanvas?.node.type!=='output'||JSON.stringify(dependencyState(before))!==JSON.stringify(state))continue;
  const ids=new Set(original.dependencies.map(n=>n.id));
  if(nativeBranchLayout?.some(saved=>{const current=guardProject.nodes.find(node=>node.id===saved.id);return!current||current.x!==saved.x||current.y!==saved.y;}))continue;
  if(original.dependencies.some(state=>{const current=guardProject.nodes.find(n=>n.id===state.id);return!current||JSON.stringify(dependencyState(current))!==JSON.stringify(state);})||JSON.stringify(edgeState(guardProject,ids,original.id))!==JSON.stringify(original.edges))continue;
  const incoming=new Set(guardProject.edges.filter(e=>e.target===target.id).map(e=>e.source));
  const complete=(job.steps||[]).filter(step=>step.status==='completed'&&(!step.loopId||step.nativeLoop?.version===1));
  const results=pending.filter(asset=>incoming.has(asset.sourceNodeId)&&complete.some(step=>step.nodeId===asset.sourceNodeId&&(step.loopId?step.loopId===asset.loopId&&step.roundIndex===asset.roundIndex:!asset.loopId))&&nativeGenerationTypes.has(job.snapshot?.nodes.find(n=>n.id===asset.sourceNodeId)?.params?.nativeCanvas?.node.type)&&/^(image|video|audio)\//.test(asset.type));
  if(!results.length)continue;
  const native=target.params.nativeCanvas,items=native.node.images||[],known=new Set(items.map(item=>typeof item==='string'?item:item.url)),additions=results.filter(asset=>!known.has(asset.url));
  if(items.length+additions.length>1000||native.resources.length+additions.filter(a=>!native.resources.some(r=>r.assetId===a.id)).length>1000)throw userError('原生输出收集超过1000份，请先保存独立画布');
  native.node.images=[...items,...additions.map(nativeMediaItem)];
  for(const asset of additions){appendNativeResource(target,asset);if(!native.mediaAssetIds.includes(asset.id))native.mediaAssetIds.push(asset.id);}
  if(additions.length){const last=additions.at(-1);target.type=last.type.split('/')[0];target.assetId=last.id;attached.push({nodeId:target.id,assetIds:additions.map(a=>a.id)});}
 }
 return attached;
}
export async function applyPromptBatchResults({data,project,job,revision,acceptPartial=false}){
 if(job.kind!=='comfy'||!job.promptBatch||job.projectId!==project.id)throw userError('不是当前项目的提示词列表任务');
 if(!['completed','cancelled','interrupted','failed'].includes(job.status))throw userError('请先停止或等待任务完成');
 if(job.status!=='completed'&&acceptPartial!==true)throw userError('任务尚未全部完成，请确认仅取回已完成项');
 const previous=project.runs.filter(r=>r.jobId===job.id),used=new Set(previous.flatMap(r=>r.assetIds||[]));
 const complete=new Set(job.items.filter(i=>i.status==='completed').flatMap(i=>i.assets.map(a=>a.id))),pending=job.assets.filter(a=>complete.has(a.id)&&!used.has(a.id));
 if(!pending.length)throw userError('当前没有尚未加入画布的已完成项',409);
 if(project.revision!==revision)throw userError('项目已更新，请刷新后再加入结果',409);
 const target=project.nodes.find(n=>n.id===job.target?.id),attach=!previous.length&&target&&target.assetId===job.target.assetId&&target.text===job.target.text;
 for(const [i,result] of pending.entries()){const a=await loadAsset(data,result.id);if(!project.assets.some(x=>x.id===a.id))project.assets.push(a);const text=job.promptBatch.values[result.batchIndex]||'',type=a.type.split('/')[0];
  if(i===0&&attach){target.assetId=a.id;target.text=text;}else project.nodes.push(makeNode(['image','video','audio'].includes(type)?type:'image',100+(i%3)*350,150+Math.floor(project.nodes.length/3)*330,{title:`第 ${(result.batchIndex??0)+1} 项 · ${a.name}`.slice(0,120),assetId:a.id,text}));
  used.add(a.id);
 }
 project.runs.push({id:randomUUID(),jobId:job.id,status:job.status==='completed'?'completed':'partial',kind:'generation',assetIds:pending.map(a=>a.id),assetReferences:imageAssetReferences(project,pending,jobReferenceAssetIds(job)),createdAt:new Date().toISOString()});project.revision++;project.updatedAt=new Date().toISOString();validateProject(project);return{project,appliedAssetIds:[...used],applied:job.status==='completed'&&job.assets.every(a=>used.has(a.id))};
}

export async function applyCanvasResults({data,project,job,revision,acceptPartial=false}){
 if(job.kind!=='canvas-run'||job.projectId!==project.id)throw userError('不是当前项目的画布执行任务');
 if(!['completed','cancelled','interrupted','failed'].includes(job.status))throw userError('请先停止或等待任务完成');
 if(job.status!=='completed'&&acceptPartial!==true)throw userError('画布尚未完成，请确认仅取回已完成步骤');
 sortNativeLoopResults(job);
 const used=new Set(project.runs.filter(r=>r.jobId===job.id).flatMap(r=>r.assetIds||job.assets.map(a=>a.id))),pending=job.assets.filter(a=>!used.has(a.id));const usedText=new Set(project.runs.filter(r=>r.jobId===job.id).flatMap(r=>r.textIds||[])),texts=(job.textResults||[]).filter(r=>!usedText.has(r.id));if(!pending.length&&!texts.length)throw userError('当前没有尚未加入画布的画布执行结果',409);if(project.revision!==revision)throw userError('项目已更新，请刷新后再加入结果',409);
 const resultY=Math.max(0,...project.nodes.map(n=>n.y))+400;let resultIndex=0;const resultPosition=()=>{const i=resultIndex++;return [120+(i%3)*350,resultY+Math.floor(i/3)*330];};
 const attached=new Set(),originals=new Map((job.nativeResultTargets||[]).map(n=>[n.id,n]));
 // Guard all segments against the same source, before any upstream result changes it.
 const guardProject=structuredClone(project),minimaxAttachments=[],handled=new Set();
 const previousAttachments=project.runs.filter(r=>r.jobId===job.id).flatMap(r=>r.minimaxAttachments||[]);
 for(const step of job.steps||[]){
  if(!step.minimaxResultTarget)continue;const key=step.nodeId+':'+step.minimaxResultTarget.segmentId;if(handled.has(key))continue;handled.add(key);
  const last=previousAttachments.findLast(r=>r.nodeId===step.nodeId&&r.segmentId===step.minimaxResultTarget.segmentId),target={...step.minimaxResultTarget,...(last?{resultAssetId:last.resultAssetId,resultState:last.resultState,...(last.dependencies?{dependencies:last.dependencies}:{})}:{})};
  const results=pending.filter(a=>a.sourceNodeId===step.nodeId&&a.minimaxSegmentId===target.segmentId&&(step.loopId?a.loopId===step.loopId:!a.loopId));
  if(attachMinimaxResults(project,target,results,{guardProject}))minimaxAttachments.push(minimaxAttachmentState(project.nodes.find(n=>n.id===step.nodeId),target.segmentId));
 }
 const nativeTarget=id=>{const target=project.nodes.find(n=>n.id===id),original=originals.get(id);return !minimaxTimelineOf(target)&&target?.params?.nativeCanvas?.adaptation==='configured'&&original&&!attached.has(id)&&target.assetId===original.assetId&&target.text===original.text&&paramsHash(target)===original.paramsSha256?target:null;};
 for(const result of pending){const a=await loadAsset(data,result.id),type=a.type.split('/')[0];if(!project.assets.some(x=>x.id===a.id))project.assets.push(a);if(a.type!=='text/plain'){const target=!result.loopId&&nativeTarget(result.sourceNodeId);if(target&&target.type===type){target.assetId=a.id;const outputs=pending.filter(item=>!item.loopId&&item.sourceNodeId===target.id&&/^(image|video|audio)\//.test(item.type));if(outputs.length>1000||target.params.nativeCanvas.resources.length+outputs.filter(item=>!target.params.nativeCanvas.resources.some(r=>r.assetId===item.id)).length>1000)throw userError('原生生成结果超过1000份');target.params.nativeCanvas.node.generatedOutputs=outputs.map(nativeMediaItem);target.params.nativeCanvas.mediaAssetIds=outputs.map(item=>item.id);for(const item of outputs)appendNativeResource(target,item);attached.add(target.id);}const round=result.loopId?`第 ${result.roundIndex+1} 轮 · `:'';project.nodes.push(makeNode(a.type==='model/gltf-binary'?'scene':['image','video','audio'].includes(type)?type:'image',...resultPosition(),{title:(round+a.name).slice(0,120),assetId:a.id,text:result.sourcePrompt||''}));}used.add(a.id);}
 for(const r of texts){const target=!r.loopId&&nativeTarget(r.sourceNodeId);if(target&&['text','script'].includes(target.type)){target.text=r.text;if(target.params.nativeCanvas.node.type==='llm')target.params.nativeCanvas.node.outputText=r.text;attached.add(target.id);}project.nodes.push(makeNode(r.type==='script'?'script':'text',...resultPosition(),{title:((r.loopId?'第 '+(r.roundIndex+1)+' 轮 · ':'')+r.title+' · 结果').slice(0,120),text:r.text}));usedText.add(r.id);}
 const nativeOutputAttachments=attachNativeOutputs(project,guardProject,job,pending);
 for(const a of minimaxAttachments){const target=job.steps.find(s=>s.nodeId===a.nodeId&&s.minimaxResultTarget?.segmentId===a.segmentId).minimaxResultTarget;a.dependencies=captureMinimaxDependencies(project,(target.dependencies||[]).map(d=>d.nodeId));}
 if(nativeOutputAttachments.length){const states=captureNativeOutputTargets(project);for(const attached of nativeOutputAttachments)attached.state=states.find(state=>state.id===attached.nodeId);}
 project.runs.push({id:randomUUID(),jobId:job.id,kind:'generation',status:job.status==='completed'?'completed':'partial',assetIds:pending.map(a=>a.id),assetReferences:imageAssetReferences(project,pending),textIds:texts.map(r=>r.id),...(minimaxAttachments.length?{minimaxAttachments}:{}),...(nativeOutputAttachments.length?{nativeOutputAttachments}:{}),createdAt:new Date().toISOString()});project.revision++;project.updatedAt=new Date().toISOString();validateProject(project);return{project,appliedAssetIds:[...used],appliedTextIds:[...usedText],applied:job.status==='completed'&&job.assets.every(a=>used.has(a.id))&&(job.textResults||[]).every(r=>usedText.has(r.id))};
}

export {applyCanvasResults as applyLoopResults};
