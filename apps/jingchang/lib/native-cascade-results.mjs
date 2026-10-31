import {createHash,randomUUID} from 'node:crypto';
import {loadAsset,userError} from './workspace.mjs';
import {makeNode,validateProject} from './model.mjs';
import {validateNativeCascadeState} from './native-cascade-execution.mjs';
import {nativeCascadeChildAdapter} from './native-cascade-children.mjs';

const fingerprint=node=>createHash('sha256').update(JSON.stringify(node)).digest('hex');
const edges=project=>JSON.stringify(project.edges);
const item=asset=>({url:asset.url,name:asset.name,type:asset.type,kind:asset.type.split('/')[0]});

// Sharing is a receiver projection, not duplicate assets or duplicate billing.
// Current edits win. All generated files can still be recovered independently
// when a receiver or the wiring changed while its original run was in flight.
export async function applyNativeCascadeResults({data,project,job,revision,acceptPartial=false}){
 if(job.kind!=='canvas-run'||job.executionMode!=='native-cascade'||job.projectId!==project.id)throw userError('不是当前项目的智能串联任务');
 if(!['completed','cancelled','interrupted','failed'].includes(job.status))throw userError('请先停止或等待智能串联完成');
 if(job.status!=='completed'&&acceptPartial!==true)throw userError('请确认仅取回智能串联已完成的步骤');
 if(project.revision!==revision)throw userError('画布已更新，请刷新后加入结果',409);
 validateNativeCascadeState(job.snapshot,job.cascadeProgram,job.cascadeState);
 // Validate completed outputs against their original child jobs, not just the
 // parent's projection. Reconciliation here only reads local receipts.
 await nativeCascadeChildAdapter({data,project:job.snapshot,program:job.cascadeProgram,parentId:job.id,
  activeJobs:new Map(),enhancementFor:operation=>job.steps.find(step=>step.executionId===operation.id)?.actualInput,
  batchProgressFor:operation=>job.steps.find(step=>step.executionId===operation.id)?.childRequests,
  prepare:async()=>{throw userError('加入结果不能提交生成任务');}}).reconcile(job.cascadeState);
 const result=structuredClone(project),previous=result.runs.filter(run=>run.jobId===job.id);
 const used=new Set(previous.flatMap(run=>run.assetIds||[])),available=new Map(result.assets.map(asset=>[asset.id,asset]));
 const refs=job.cascadeState.rounds.flatMap(round=>round.receipts.filter(receipt=>receipt.status==='completed').flatMap(receipt=>receipt.outputRefs));
 const generatedIds=new Set(job.cascadeState.rounds.flatMap(round=>round.receipts.filter(receipt=>receipt.kind==='generate'&&receipt.status==='completed'&&!receipt.usedFallback).flatMap(receipt=>receipt.outputRefs.map(ref=>ref.assetId))));
 for(const ref of refs)if(!available.has(ref.assetId))available.set(ref.assetId,await loadAsset(data,ref.assetId));
 const pending=[...generatedIds].filter(id=>!used.has(id));
 const projectionKey=fingerprint({receivers:job.cascadeState.receivers,slots:job.cascadeState.slots,completedOrder:job.cascadeState.completedOrder});
 if(!pending.length&&previous.some(run=>run.cascadeProjectionKey===projectionKey))throw userError('这批已完成素材已经加入画布',409);
 const lastTargets=new Map(previous.flatMap(run=>run.cascadeTargets||[]).map(target=>[target.nodeId,target.fingerprint]));
 const sourceNodes=new Map(job.snapshot.nodes.map(node=>[node.id,node]));
 const unchanged=edges(result)===edges(job.snapshot)&&job.snapshot.nodes.every(node=>{
  const now=result.nodes.find(current=>current.id===node.id);
  return now&&fingerprint(now)===(lastTargets.get(node.id)||fingerprint(node));
 });
 for(const id of pending){const asset=available.get(id);if(!result.assets.some(item=>item.id===id))result.assets.push(asset);}
 const attachments=[];
 if(unchanged)for(const [nodeId,receiver]of Object.entries(job.cascadeState.receivers)){
  if(!receiver.currentRefs.length)continue;
  let target=result.nodes.find(node=>node.id===nodeId);
  if(!target){
   const slot=job.cascadeState.slots.find(slot=>slot.nodeId===nodeId),source=sourceNodes.get(slot?.rootNodeId);
   if(!slot?.created||!source)continue;
   const params=structuredClone(source.params);
   for(const field of ['workflowBinding','cloudBinding','imageBinding','studioBinding','llmBinding'])delete params[field];
   Object.assign(params.nativeCanvas.node,{id:nodeId,sourceNodeId:source.params.nativeCanvas.node.id,
    loopSourceId:sourceNodes.get(slot.loopId).params.nativeCanvas.node.id,loopRoundIndex:slot.index,loopSlotIndex:slot.slotIndex});
   target=makeNode(source.type,source.x+360,source.y+slot.slotIndex*320,{id:nodeId,title:`${source.title} · 第${slot.slotIndex+1}轮`.slice(0,120),params});result.nodes.push(target);
  }
  const native=target.params?.nativeCanvas;if(!native||native.node.type!=='smart-image')continue;
  const assets=receiver.currentRefs.map(ref=>available.get(ref.assetId));
  if(assets.some(asset=>!asset||!/^(image|video|audio)\//.test(asset.type)))continue;
  for(const asset of assets){
   if(!result.assets.some(item=>item.id===asset.id))result.assets.push(asset);
   if(!native.resources.some(ref=>ref.assetId===asset.id))native.resources.push({url:asset.url,assetId:asset.id,archive:'resources/'+asset.id});
  }
  if(native.resources.length>1000)throw userError('原生节点保留素材超过1000份，请先保存独立工作流');
  native.node.images=assets.map(item);native.node.generatedOutputs=assets.map(item);
  native.mediaAssetIds=[...new Set(native.resources.map(ref=>ref.assetId))];
  target.assetId=assets.at(-1).id;target.type=assets.at(-1).type.split('/')[0];
  attachments.push({nodeId:target.id,fingerprint:fingerprint(target),assetIds:assets.map(asset=>asset.id)});
 }
 if(!pending.length&&!attachments.length)throw userError('这批没有可加入的新素材；原任务和当前编辑均保留',409);
 // Independent result nodes provide an accessible history even when the source
 // receiver changes its preview. The original files and bindings are retained.
 const y=Math.max(0,...result.nodes.map(node=>node.y))+360;
 for(const [offset,id]of pending.entries()){
  const asset=available.get(id),kind=asset.type.split('/')[0];
  result.nodes.push(makeNode(['image','video','audio'].includes(kind)?kind:'text',120+(offset%3)*350,y+Math.floor(offset/3)*320,
   {title:asset.name.slice(0,120),assetId:id}));used.add(id);
 }
 result.runs.push({id:randomUUID(),jobId:job.id,kind:'generation',executionMode:'native-cascade',
  status:job.status==='completed'?'completed':'partial',assetIds:pending,cascadeTargets:attachments,cascadeProjectionKey:projectionKey,createdAt:new Date().toISOString()});
 result.revision++;result.updatedAt=new Date().toISOString();validateProject(result);
 return {project:result,appliedAssetIds:[...used],applied:job.status==='completed'&&[...generatedIds].every(id=>used.has(id))};
}
