let pending=null,busy=false;
export async function applyNativeMediaVersion(api,projectId,body){
 try{return{project:await api('/api/projects/'+encodeURIComponent(projectId)+'/native-media-version/apply',{method:'POST',body:JSON.stringify(body),signal:AbortSignal.timeout(15000)}),recovered:false};}
 catch(error){
  // A lost response is not a reason to repeat the mutation.
  try{const project=await api('/api/projects/'+encodeURIComponent(projectId),{signal:AbortSignal.timeout(8000)}),r=project.settings?.nativeMediaEditReceipt;if(r?.requestId===body.requestId&&r.planHash===body.planHash)return{project,recovered:true,newer:project.revision!==r.revision};}catch{}
  throw error;
 }
}
function markup(result,c){
 const e=result.effects,show=items=>items.map(s=>(s.name||(s.pending?'待生成素材':'素材 '+s.assetId))+(s.pending&&s.producerIndex!==undefined?' · 原第'+(s.producerIndex+1)+'份':'')).join('、')||'无';
 const field=f=>`<article><h3>${c.esc(f.label)}</h3><p>原范围：${c.esc(show(f.before))}</p>${f.retainedSelection?`<p>保留的原素材：${c.esc(show([f.retainedSelection]))}</p>`:''}<p>完整范围：${c.esc(show(f.after))}</p>${f.toIndex!==undefined?`<p>保留原图：第 ${f.fromIndex+1} 格 → 第 ${f.toIndex+1} 格</p>`:''}</article>`;
 const automatic=f=>`<article><h3>H3自动参考 · ${f.policy==='ordinary'?'原顺序前15份':'9图 / 3视频 / 3音频上限'}</h3><p>原发送范围：${c.esc(show(f.before))}</p><p>完整发送范围：${c.esc(show(f.after))}</p><details><summary>自动参考候选及去重限额</summary><p>原候选：${c.esc(show(f.beforeCandidates))}</p><p>完整候选：${c.esc(show(f.afterCandidates))}</p><p>限额排除：原 ${f.beforeExcluded} 份，完整 ${f.afterExcluded} 份。</p></details></article>`;
 const rounds=e.rounds||[],matching=(item,r)=>(item.loopId||'')===(r.loopId||'')&&item.roundIndex===r.roundIndex,content=rounds.length?rounds.map(r=>{const body=r.excluded?'<p>本轮未选中此分支，不会提交这个节点。</p>':(e.fields.filter(f=>matching(f,r)).map(field).join('')+(e.automatic||[]).filter(f=>matching(f,r)).map(automatic).join('')||'<p>本轮没有显式素材字段。</p>');return r.loopId?`<details class="media-version-round" ${r.roundIndex===0?'open':''}><summary>第 ${r.roundIndex+1} 轮 · 计数 ${r.index} / ${r.total}${r.excluded?' · 分支跳过':''}</summary>${body}</details>`:body;}).join(''):e.fields.map(field).join('');
 return`<section class="native-media-version-preview"><p>只保存本机画布，不启动生成或上传素材。</p>${e.pinned.length?`<p>工程默认范围升级后，${e.pinned.length} 个已有节点仍保留原规则。新增节点可使用完整范围。</p>`:''}${rounds.some(r=>r.loopId)?`<p>已核对全部 ${rounds.length} 轮，包含 ${rounds.filter(r=>r.excluded).length} 轮分支跳过；可展开每轮查看真实范围。</p>`:''}${content}${e.warnings?.length?`<ul>${e.warnings.map(s=>`<li>${c.esc(s)}</li>`).join('')}</ul>`:''}${e.blocked.length?`<ul role="alert">${e.blocked.map(s=>`<li>${c.esc(s)}</li>`).join('')}</ul><p>当前工程保持原规则。请先完成上述核对。</p>`:''}<p class="small muted">已有任务快照和原素材保留。逐轮选图保留原素材来源；相关上游或字段变化后请重新检查。</p></section>`;
}
export async function nativeMediaVersionAction(action,c){
 if(!['media-version-project','media-version-preserve','media-version-adopt','media-version-refresh','media-version-clear','media-version-apply'].includes(action))return false;
 if(busy)return true;
 busy=true;let hold,holdResult;
 try{
  if(action!=='media-version-apply'){
   pending=null;await c.save();const p=c.getProject(),body={mode:action==='media-version-project'?'project':'node',requestId:crypto.randomUUID(),revision:p.revision,...(action==='media-version-project'?{}:{nodeId:c.selected(),selection:action==='media-version-preserve'?'preserve':action==='media-version-refresh'?'refresh':action==='media-version-clear'?'clear':'adopt'})};
   const result=await c.api('/api/projects/'+encodeURIComponent(p.id)+'/native-media-version/preview',{method:'POST',body:JSON.stringify(body)});
   pending=result.canApply&&result.changed?{projectId:p.id,source:JSON.stringify(p),body:{...body,planHash:result.planHash}}:null;
   c.modal('核对素材范围',markup(result,c),'<button data-action="close-modal">返回画布</button>'+(pending?'<button class="primary" data-action="media-version-apply">保存以上素材规则</button>':''));return true;
  }
  if(!pending||pending.projectId!==c.getProject().id||pending.source!==JSON.stringify(c.getProject()))throw Error('画布已变化，请重新检查素材范围');
  const button=document.querySelector('[data-action=media-version-apply]');if(button)button.disabled=true;hold=c.holdSave?.();
  const base=structuredClone(c.getProject()),result=await applyNativeMediaVersion(c.api,pending.projectId,pending.body),merged=c.applyProject(result.project,{groupId:pending.body.nodeId,recoveredNewer:result.newer,base});
  if(merged?.conflicts?.length)holdResult={error:Error('已保留新的本地编辑，请检查后手动保存')};pending=null;
  if(document.querySelector('#modal .native-media-version-preview'))document.querySelector('#modal').close();
  c.notify(merged?.conflicts?.length?'已保留新编辑，请检查后手动保存':result.recovered?'已从本机保存回执恢复素材规则':'素材规则已保存，未启动生成');return true;
 }catch(error){holdResult={error};throw error;}finally{hold?.release(holdResult);busy=false;const button=document.querySelector('[data-action=media-version-apply]');if(button)button.disabled=false;}
}
