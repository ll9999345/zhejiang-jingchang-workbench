import {nativeLoopEnabled,nativeLoopSettings,nativeLoopRoundContext} from '../public/native-loop-core.js';
import {nativeExecutionAncestors} from './native-flow-execution.mjs';
import {planNativeBranchRound} from './native-branch.mjs';
import {userError} from './workspace.mjs';
// Match planNativeLoops' owner, initial external-loop contexts and branch route.
// This creates read-only views, not generation steps or provider requests.
export function nativeMediaRoundViews(project,nodeId){
 const loops=project.nodes.filter(nativeLoopEnabled),ancestors=nativeExecutionAncestors(project,nodeId);
 if(project.nodes.some(n=>ancestors.has(n.id)&&n.type==='loop'))throw userError('镜场字段循环的素材版本需另行核对，当前保留原规则');
 if(loops.length&&project.nodes.some(n=>n.type==='loop'))throw userError('原生循环与镜场字段循环的组合尚待接入');
 for(const loop of loops)if(loops.some(other=>other!==loop&&nativeExecutionAncestors(project,other.id).has(loop.id)))throw userError('原生嵌套循环尚待接入，未猜测逐轮素材');
 const owners=loops.filter(loop=>ancestors.has(loop.id));
 if(owners.length>1)throw userError('一个节点不能同时接受两条原生循环');
 const owner=owners[0],count=owner?nativeLoopSettings(owner).count:1,views=[];
 for(let round=0;round<count;round++){
  const loopContexts=Object.fromEntries(loops.map(loop=>[loop.id,nativeLoopRoundContext(loop,loop===owner?round:0)])),routed=owner?planNativeBranchRound(project,owner,round):{project,route:null};
  views.push({project:routed.project,loopContexts,...(owner?{loopId:owner.id,roundIndex:round,index:loopContexts[owner.id].index,total:loopContexts[owner.id].total}:{}),...(routed.route?{nativeBranch:routed.route}:{}),excluded:!routed.project.nodes.some(n=>n.id===nodeId)});
 }
 return views;
}
