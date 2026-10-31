import {createHash,randomUUID} from 'node:crypto';
import {assertNoCredentials,safeId,userError} from './workspace.mjs';
import {validateNativeCascadeProgram} from './native-cascade-plan.mjs';
import {cascadeReferenceResolver,normalizeCascadeRefs,stripCascadeRefs,uniqueCascadeRefs} from './native-cascade-media.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const done=state=>state.rounds.flatMap(round=>round.receipts).filter(receipt=>receipt.status==='completed');
const statuses=new Set(['queued','running','completed','stopped','failed']);
const receiptStatuses=new Set(['prepared','submitting','running','completed','interrupted','failed']);
const key=(round,operation)=>round.roundIndex+':'+operation.id;
const originalId=(project,nodeId)=>String(project.nodes.find(node=>node.id===nodeId)?.params?.nativeCanvas?.node.id??nodeId);
const targetId=(state,round,operation)=>operation.target.kind==='loop-slot'?state.slots[round.roundIndex].nodeId:operation.targetNodeId;
const policy=receipt=>receipt.usedFallback?'replace-with-history':receipt.resultPolicy;

export function createNativeCascadeState(project,program){
 validateNativeCascadeProgram(project,program);
 return{version:1,snapshotDigest:digest(project),programDigest:digest(program),status:'queued',completedOperationCount:0,completedOrder:[],receivers:{},slots:program.singleNodeLoopRun?program.rounds.map(round=>{
  const target=round.operations[0].target;return{...target,nodeId:target.nodeId||randomUUID(),created:!target.nodeId};
 }):[],rounds:program.rounds.map(round=>({roundIndex:round.roundIndex,status:'queued',receipts:[],nodeOutputs:{},operationOutputs:{}}))};
}

function applyReceipt(project,program,state,round,operation,receipt){
 const local=state.rounds[round.roundIndex],out=normalizeCascadeRefs(receipt.outputRefs);
 if(out.length&&operation.kind!=='relay'){
  const id=targetId(state,round,operation),receiver=state.receivers[id]||{
   currentRefs:project.nodes.some(node=>node.id===id)?stripCascadeRefs(cascadeReferenceResolver(project,{round,nodeOutputs:local.nodeOutputs,receivers:state.receivers}).stored(id)):[],
   historyRefs:[],appendInitialized:false};
  const next=uniqueCascadeRefs(stripCascadeRefs(out),{withKind:true});
  if(policy(receipt)==='append-loop'){
   if(!receiver.appendInitialized){receiver.historyRefs=uniqueCascadeRefs([...receiver.currentRefs,...receiver.historyRefs],{withKind:true});receiver.currentRefs=[];receiver.appendInitialized=true;}
   receiver.currentRefs=uniqueCascadeRefs([...receiver.currentRefs,...next],{withKind:true});
  }else{
   receiver.historyRefs=uniqueCascadeRefs([...receiver.currentRefs,...receiver.historyRefs],{withKind:true});receiver.currentRefs=next;
  }
  state.receivers[id]=receiver;local.nodeOutputs[id]=stripCascadeRefs(out);
 }
 // An empty shared copy does not erase the receiver or replace its round value.
 // Relay results remain references; loops never acquire generated media.
 const id=operation.kind==='relay'?operation.sourceNodeId:targetId(state,round,operation);
 const currentLength=state.receivers[id]?.currentRefs.length??(project.nodes.some(node=>node.id===id)?cascadeReferenceResolver(project,{round,nodeOutputs:local.nodeOutputs,receivers:state.receivers}).stored(id).length:0);
 local.operationOutputs[operation.id]=out.map((ref,imageIndex)=>({...ref,originalNodeId:originalId(project,id),imageIndex:currentLength-out.length+imageIndex}));
}

export function validateNativeCascadeState(project,program,state){
 validateNativeCascadeProgram(project,program);assertNoCredentials(state);
 if(!state||state.version!==1||state.snapshotDigest!==digest(project)||state.programDigest!==digest(program)||!statuses.has(state.status)
  ||!Array.isArray(state.rounds)||state.rounds.length!==program.rounds.length||!Array.isArray(state.slots)||state.slots.length!==(program.singleNodeLoopRun?program.rounds.length:0)
  ||!Array.isArray(state.completedOrder)||!state.receivers||typeof state.receivers!=='object')throw userError('智能串联恢复记录与原快照不一致');
 const ids=new Set(project.nodes.map(node=>node.id)),slots=new Set();
 for(const [offset,slot]of state.slots.entries()){
  const expected=program.rounds[offset].operations[0].target;
  if(!slot||!safeId(slot.nodeId)||slots.has(slot.nodeId)||slot.created!==!expected.nodeId||slot.kind!==expected.kind||slot.rootNodeId!==expected.rootNodeId||slot.loopId!==expected.loopId||slot.index!==expected.index||slot.slotIndex!==offset||expected.nodeId&&slot.nodeId!==expected.nodeId||!expected.nodeId&&ids.has(slot.nodeId))throw userError('智能串联输出槽记录无效');
  slots.add(slot.nodeId);
 }
 const completed=new Map();
 for(const [offset,local]of state.rounds.entries()){
  const round=program.rounds[offset];
  if(!local||local.roundIndex!==offset||!['queued','running','completed','interrupted'].includes(local.status)||!Array.isArray(local.receipts)||local.receipts.length>round.operations.length)throw userError('智能串联回合恢复记录无效');
  for(const [index,receipt]of local.receipts.entries()){
   const operation=round.operations[index];
   if(index&&local.receipts[index-1].status!=='completed'||!receipt||receipt.operationId!==operation.id||receipt.kind!==operation.kind||receipt.sourceNodeId!==operation.sourceNodeId||receipt.targetNodeId!==targetId(state,round,operation)||receipt.requestNodeId!==operation.requestNodeId||receipt.resultPolicy!==operation.resultPolicy||!receiptStatuses.has(receipt.status)||typeof receipt.usedFallback!=='boolean'||receipt.usedFallback&&(!operation.missingPromptFallback||receipt.status!=='completed')||receipt.childJobId!==null&&(!safeId(receipt.childJobId)||operation.kind!=='generate')||receipt.requestNodeDigest!== (operation.requestNodeId?digest(project.nodes.find(node=>node.id===operation.requestNodeId)):null))throw userError('智能串联步骤收据与执行清单不一致');
   normalizeCascadeRefs(receipt.inputRefs);normalizeCascadeRefs(receipt.fallbackRefs);normalizeCascadeRefs(receipt.outputRefs);
   if(receipt.status==='completed'&&operation.kind==='generate'&&(!receipt.outputRefs.length||!receipt.usedFallback&&!receipt.childJobId))throw userError('智能串联生成收据缺少原子任务或完整结果');
   if(receipt.status==='completed')completed.set(key(round,operation),{round,operation,receipt});
  }
  if(local.status==='completed'&&(local.receipts.length!==round.operations.length||local.receipts.some(receipt=>receipt.status!=='completed')))throw userError('智能串联回合未完整完成');
 }
 if(state.completedOperationCount!==completed.size||state.completedOrder.length!==completed.size||new Set(state.completedOrder).size!==completed.size||state.completedOrder.some(id=>!completed.has(id))||state.status==='completed'&&completed.size!==program.operationCount)throw userError('智能串联完成计数不一致');
 const replay={slots:state.slots,receivers:{},rounds:program.rounds.map(round=>({roundIndex:round.roundIndex,nodeOutputs:{},operationOutputs:{}}))};
 for(const id of state.completedOrder){const entry=completed.get(id);applyReceipt(project,program,replay,entry.round,entry.operation,entry.receipt);}
 if(JSON.stringify(replay.receivers)!==JSON.stringify(state.receivers)||replay.rounds.some((round,index)=>JSON.stringify(round.nodeOutputs)!==JSON.stringify(state.rounds[index].nodeOutputs)||JSON.stringify(round.operationOutputs)!==JSON.stringify(state.rounds[index].operationOutputs)))throw userError('智能串联结果投影与已完成收据不一致');
 return state;
}

// Provider adapters own request validation, credentials and actual child jobs.
// The kernel owns edge semantics and durable completion receipts. onAccepted
// must be awaited before the adapter continues: a resumed step can query that
// same child job, but cannot submit again if acceptance remains uncertain.
export async function executeNativeCascade({project,program,state=createNativeCascadeState(project,program),generate,persist,signal,comfyInstanceCount=1}){
 validateNativeCascadeState(project,program,state);
 if(typeof generate!=='function'||typeof persist!=='function')throw userError('智能串联需要生成适配器及持久收据存储');
 if(!Number.isSafeInteger(comfyInstanceCount)||comfyInstanceCount<1||comfyInstanceCount>64)throw userError('智能串联后端数量无效');
 if(state.status==='completed')return structuredClone(state);
 const controller=new AbortController(),runSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
 let writeQueue=Promise.resolve(),next=0,firstError=null;
 const save=()=>{const snapshot=structuredClone(state);const task=writeQueue.then(()=>persist(snapshot));writeQueue=task;return task;};
 const update=()=>{state.completedOperationCount=done(state).length;};
 async function runRound(round){
  const local=state.rounds[round.roundIndex];if(local.status==='completed')return;
  local.status='running';await save();
  for(const [index,operation]of round.operations.entries()){
   runSignal.throwIfAborted();let receipt=local.receipts[index];if(receipt?.status==='completed')continue;
   const resolver=cascadeReferenceResolver(project,{round,nodeOutputs:local.nodeOutputs,receivers:state.receivers});
   if(!receipt){
    const inputRefs=operation.kind==='generate'?resolver.forRequest(operation,local.operationOutputs):resolver.resolve(operation.references,local.operationOutputs);
    const fallbackRefs=operation.missingPromptFallback?resolver.resolve(operation.missingPromptFallback.reference,local.operationOutputs):[];
    receipt={operationId:operation.id,kind:operation.kind,sourceNodeId:operation.sourceNodeId,targetNodeId:targetId(state,round,operation),requestNodeId:operation.requestNodeId,
     requestNodeDigest:operation.requestNodeId?digest(project.nodes.find(node=>node.id===operation.requestNodeId)):null,resultPolicy:operation.resultPolicy,
     status:operation.kind==='generate'?'submitting':'prepared',childJobId:null,usedFallback:false,inputRefs:normalizeCascadeRefs(inputRefs),fallbackRefs:normalizeCascadeRefs(fallbackRefs),outputRefs:[]};
    local.receipts.push(receipt);await save();
   }else if(operation.kind==='generate'&&!receipt.childJobId){
    throw userError('智能串联原生成步骤没有可确认的子任务编号，不会自动重发；请先核对原任务');
   }
   try{
    runSignal.throwIfAborted();
    if(operation.kind==='generate'){
     const childJobId=receipt.childJobId;
     const result=await generate({operation:structuredClone(operation),requestNode:structuredClone(project.nodes.find(node=>node.id===operation.requestNodeId)),targetNodeId:receipt.targetNodeId,
      referenceRefs:structuredClone(receipt.inputRefs),context:{roundIndex:round.roundIndex,index:round.index,total:round.total,forceWorkflow:round.forceWorkflow,loopContexts:structuredClone(round.loopContexts),relayPromptNodeIds:[...operation.relayPromptNodeIds]},
      resume:!!childJobId,childJobId,signal:runSignal,onAccepted:async id=>{
       if(!safeId(id)||receipt.childJobId&&receipt.childJobId!==id)throw userError('智能串联子任务编号与原收据不一致');
       receipt.childJobId=id;receipt.status='running';await save();runSignal.throwIfAborted();
      }});
     if(!receipt.childJobId)throw userError('智能串联生成适配器未保存子任务编号，后续未继续');
     receipt.outputRefs=stripCascadeRefs(result);if(!receipt.outputRefs.length)throw userError('智能串联生成步骤没有返回素材');
    }else receipt.outputRefs=stripCascadeRefs(receipt.inputRefs);
   }catch(error){
    if(!runSignal.aborted&&operation.missingPromptFallback&&/缺少提示词|需要输入文本|need prompt/i.test(error.message||'')&&receipt.fallbackRefs.length){
     receipt.usedFallback=true;receipt.outputRefs=stripCascadeRefs(receipt.fallbackRefs);receipt.error=String(error.message||error).slice(0,1000);
    }else{
     receipt.status=runSignal.aborted?'interrupted':'failed';receipt.error=String(error.message||error).slice(0,1000);await save();throw error;
    }
   }
   applyReceipt(project,program,state,round,operation,receipt);receipt.status='completed';state.completedOrder.push(key(round,operation));update();await save();
  }
  local.status='completed';await save();
 }
 state.status='running';delete state.error;await save();
 const concurrency=program.scheduling.mode==='parallel'?Math.min(program.rounds.length,6,program.scheduling.parallelLimitPolicy==='comfy-backends-at-most-six'?comfyInstanceCount:6):1;
 const worker=async()=>{
  while(next<program.rounds.length&&!runSignal.aborted){const round=program.rounds[next++];try{await runRound(round);}catch(error){if(!firstError)firstError=error;controller.abort(error);}}
 };
 await Promise.allSettled(Array.from({length:concurrency},worker));
 for(const round of state.rounds)if(round.status==='running')round.status='interrupted';
 if(firstError||runSignal.aborted){state.status=signal?.aborted?'stopped':'failed';state.error=String(firstError?.message||runSignal.reason?.message||'已停止智能串联').slice(0,1000);}
 else state.status='completed';
 update();await save();validateNativeCascadeState(project,program,state);
 return structuredClone(state);
}
