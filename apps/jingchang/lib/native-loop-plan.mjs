import {captureMinimaxResultTarget} from './minimax-h3.mjs';
import {applyNativeMediaMaps,assertNativeMediaMapScopes} from './native-media-maps.mjs';
import {isNativeLoop,nativeLoopEnabled,nativeLoopSettings,nativeLoopRoundContext} from '../public/native-loop-core.js';
import {nativeExecutionAncestors} from './native-flow-execution.mjs';
import {userError} from './workspace.mjs';
import {isNativePrompt,nativePromptLlmEnabled} from '../public/native-prompt-core.js';
import {planNativeBranchRound} from './native-branch.mjs';

export const hasEnabledNativeLoops=project=>project.nodes.some(nativeLoopEnabled);
export async function planNativeLoops(project,singlePlan){
 assertNativeMediaMapScopes(project);
 const loops=project.nodes.filter(nativeLoopEnabled).map(node=>({node,settings:nativeLoopSettings(node),body:[]}));
 if(!loops.length)return singlePlan(project);
 if(project.nodes.some(node=>node.type==='loop'))throw userError('原生循环与镜场字段循环的组合尚待接入');
 for(const loop of loops)if(loops.some(other=>other!==loop&&nativeExecutionAncestors(project,other.node.id).has(loop.node.id)))throw userError('原生嵌套循环与分支轮换尚待接入，请分别运行各条循环链');
 const contexts=(loop,round)=>Object.fromEntries(loops.map(current=>[current.node.id,nativeLoopRoundContext(current.node,current===loop?round:0)]));
 const bound=project.nodes.filter(node=>[node.params?.workflowBinding,node.params?.cloudBinding,node.params?.imageBinding,node.params?.llmBinding,node.params?.studioBinding].some(Boolean)&&(!isNativePrompt(node)||nativePromptLlmEnabled(node))),boundIds=new Set(bound.map(node=>node.id)),owner=new Map();
 for(const loop of loops){loop.body=bound.filter(node=>nativeExecutionAncestors(project,node.id).has(loop.node.id)).map(node=>node.id);if(!loop.body.length)throw userError('原生循环下游没有已绑定的生成节点');for(const id of loop.body){if(owner.has(id))throw userError('一个生成节点不能同时接受两条原生循环，请分开下游链路');owner.set(id,loop.node.id);}}
 const units=new Map();for(const node of bound){const key=owner.get(node.id)||node.id;if(!units.has(key))units.set(key,{key,nodeIds:[],dependencies:new Set()});units.get(key).nodeIds.push(node.id);}
 for(const node of bound){const key=owner.get(node.id)||node.id;for(const id of nativeExecutionAncestors(project,node.id))if(boundIds.has(id)){const upstream=owner.get(id)||id;if(upstream!==key)units.get(key).dependencies.add(upstream);}}
 const ordered=[],visiting=new Set(),done=new Set();function visit(key){if(visiting.has(key))throw userError('原生循环与外部步骤存在交叉依赖');if(done.has(key))return;visiting.add(key);for(const upstream of units.get(key).dependencies)visit(upstream);visiting.delete(key);done.add(key);ordered.push(units.get(key));}for(const key of units.keys())visit(key);
 const result=[];let requests=0;for(const unit of ordered){const loop=loops.find(loop=>loop.node.id===unit.key),roundCount=loop?.settings.count||1;
  for(let round=0;round<roundCount;round++){
   const current=contexts(loop,round),routed=loop?planNativeBranchRound(project,loop.node,round):{project,route:null},ids=new Set(unit.nodeIds.filter(id=>routed.project.nodes.some(node=>node.id===id)));
   const planned=await singlePlan(applyNativeMediaMaps(routed.project,{proofProject:project,loopId:loop?.node.id,roundIndex:round,loopContexts:current,nodeIds:ids}),loop?new Map(loop.body.map(id=>[id,round])):new Map(),current,ids);
   if(!planned.length)throw userError('本轮选中的分支没有已绑定的生成节点，请核对运行清单');
   for(const [index,original]of planned.entries()){
    const step=structuredClone(original);
    const originalNode=project.nodes.find(n=>n.id===step.nodeId);if(originalNode?.params?.nativeMediaMap&&step.minimaxH3)step.minimaxResultTarget=captureMinimaxResultTarget(originalNode,originalNode.params.minimaxH3||originalNode.params.workflowBinding?.minimaxH3||originalNode.params.cloudBinding?.minimaxH3,{project,parents:nativeExecutionAncestors(project,originalNode.id)});
    step.nativeUnit={version:1,id:unit.key,dependencies:[...unit.dependencies]};
    if(loop){const ctx=current[loop.node.id];Object.assign(step,{executionId:`native-loop-${loops.indexOf(loop)}-${round}-${index}`,loopId:loop.node.id,loopTitle:loop.node.title,roundIndex:round,roundCount,nativeLoop:{version:1,mode:loop.settings.mode,index:ctx.index,total:ctx.total,contexts:structuredClone(current)}});}
    if(routed.route)step.nativeBranch=structuredClone(routed.route);
    requests+=step.count;if(requests>1000)throw userError('当前原生循环单次画布最多1000次生成，请拆分工程；不会截断循环轮数');
    result.push(step);
    if(result.length>3200)throw userError('原生循环展开步骤超出当前画布容量');
   }
  }
 }
 if(result.length>3200)throw userError('原生循环展开步骤超出当前画布容量');return result;
}

export function nativeExecutionUnits(steps){
 const groups=new Map();for(const [index,step]of steps.entries()){
  if(step.nativeUnit?.version!==1)throw userError('原生循环任务缺少执行单元，请重新规划');
  const key=step.nativeUnit.id;if(!groups.has(key))groups.set(key,{id:key,dependencies:step.nativeUnit.dependencies,mode:step.nativeLoop?.mode||'serial',rounds:new Map()});
  const unit=groups.get(key),round=step.loopId?step.roundIndex:-1;if(!unit.rounds.has(round))unit.rounds.set(round,[]);unit.rounds.get(round).push({step,index});
 }
 const ordered=[],seen=new Set(),visiting=new Set();function visit(key){if(!groups.has(key))throw userError('原生循环任务依赖单元缺失');if(visiting.has(key))throw userError('原生循环任务依赖有环');if(seen.has(key))return;visiting.add(key);for(const id of groups.get(key).dependencies)visit(id);visiting.delete(key);seen.add(key);ordered.push(groups.get(key));}for(const key of groups.keys())visit(key);return ordered;
}
