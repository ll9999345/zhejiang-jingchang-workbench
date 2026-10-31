import {nativeBranchCandidates,nativeBranchRound,nativeBranchMarkup} from './native-branch-core.js';

export function nativeBranchPreviewMarkup(project,node,loopSettings,enabled,esc) {
 const loop={...node,params:{...node.params,nativeLoop:loopSettings,nativeBranch:{version:1,enabled}}};
 const preview={...project,nodes:project.nodes.map(current=>current.id===loop.id?loop:current)};
 const label=id=>project.nodes.find(node=>node.id===id)?.title||id;
 const candidates=nativeBranchCandidates(preview,loop);
 const heading='<h4>智能分支轮换</h4>';
 if(!enabled)return heading+'<p class="small muted">未启用分支轮换。原连线和生成设置保持。</p>';
 if(!loopSettings.enabled)return heading+'<p class="notice">保存启用智能循环后，才能按计数选择分支。</p>';
 if(!candidates.length)return heading+'<p class="small muted">当前没有可轮换的分支。需要把智能循环以提示词输入连接到智能素材，该素材须有至少两个素材下游；仅工作流连线不触发轮换。</p>';
 const rounds=Array.from({length:Math.min(loopSettings.count,3)},(_,index)=>index);
 if(loopSettings.count>3)rounds.push(loopSettings.count-1);
 return heading+`<p class="small muted">分支按画布横坐标、纵坐标排序；每轮按实际计数选一个。保存和预览不执行生成。</p>`+rounds.map(round=>`<details ${round===0?'open':''}><summary>第 ${round+1}/${loopSettings.count} 轮</summary>${nativeBranchMarkup(nativeBranchRound(preview,loop,round).route,esc,label)}</details>`).join('')+'<p class="small muted">运行前会逐轮核对所选节点、素材和次数。原连线与未选分支数据保留。</p>';
}
