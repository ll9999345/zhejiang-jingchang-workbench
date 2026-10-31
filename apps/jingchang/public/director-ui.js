import {serviceDisplayText,platformDisplayName,modelDisplayName} from './model-service-labels.js';
export function directorBudgetFields(state,esc){
 if(state.provider==='miaoapi')return `<div class="director-budget-fields"><label>本次费用上限（美元）<input name="directorBudget" type="number" min="0.001" max="100" step="0.001" required placeholder="例如 0.10"></label><input name="directorThinking" type="hidden" value="off"></div><label class="check-label"><input name="directorConsent" type="checkbox" required>确认发送上述文字到 ${esc(serviceDisplayText(state.label,state.model))}，最多请求 1 次。预算为应用预留，实际费用以平台账单为准。</label>`;
 return `<div class="director-budget-fields"><label>本次费用上限（美元）<input name="directorBudget" type="number" min="0.001" max="100" step="0.001" required placeholder="例如 0.10"></label><label>思考方式<select name="directorThinking"><option value="off">快速 · 日常创作</option><option value="low">稍作思考</option><option value="high">深入 · 复杂方案</option><option value="max">充分 · 更长等待</option></select></label></div><label class="check-label"><input name="directorConsent" type="checkbox" required>确认发送上述文字到 ${esc(serviceDisplayText(state.label||state.model))}，最多请求 1 次，按所填预算执行</label>`;
}
export function readDirectorAuthorization(form,state){
 const budget=Number(form.elements.directorBudget.value),thinking=form.elements.directorThinking.value;
 if(!form.elements.directorConsent.checked||!Number.isFinite(budget)||budget<=0||budget>100)throw Error('请填写本次费用上限并确认文字发送范围');
 if(!state.configured||!state.profileRevision)throw Error('模型配置已变化，请重新检查');
 return {thinking,authorization:{provider:state.provider,origin:state.origin,model:state.model,sendText:true,sendMedia:false,requestLimit:1,currency:'USD',budget,profileRevision:state.profileRevision}};
}
export function directorConfirmationMarkup(preview,esc){
 const {director,scope}=preview;
 return `<form id="director-confirmation-form"><div class="director-confirm-card"><span class="chip">${esc(serviceDisplayText(director.label,director.model))}</span><h3>先规划，确认后改画布</h3><p>会发送你的指令、项目名称与节点连接、${scope.nodes} 个节点的文字、${scope.shots} 个镜头的设定、${scope.assetNames} 个素材名称，以及最近最多 8 条助理对话。图片、视频和音频文件留在本机。</p><p class="small muted">按当前预留单价和输出上限，保守预留约 $${preview.estimatedMaximumUSD.toFixed(6)}。实际费用以 所选模型服务 账单为准，思考内容也计入输出。</p></div>${directorBudgetFields(director,esc)}<p class="small muted">使用已存配置。只请求一次，不自动生成媒体、不自动重试。</p></form>`;
}
export function planActionsMarkup(plan,project,esc){
 const labels={add_node:'添加节点',edit_node:'修改节点',connect:'连接节点',layout:'整理画布',append_shots:'追加分镜',edit_shots:'调整已有分镜',set_shots:'替换全部分镜'};
 const byId=id=>project.nodes.find(n=>n.id===id)?.title||id;
 return plan.actions.map(action=>{
  const a=action.args;let title=labels[action.tool]||action.tool,detail='';
  if(action.tool==='edit_shots')detail=a.shots.map(change=>{const old=project.shots.find(s=>s.id===change.id);return `<article><strong>${esc(old?.title||change.id)}</strong>${change.duration!==undefined?`<p>时长 ${esc(old?.duration)} → ${esc(change.duration)} 秒</p>`:''}${['title','description','dialogue','camera','size','sound'].filter(k=>change[k]!==undefined).map(k=>`<p><span class="muted">${({title:'名称',description:'画面',dialogue:'字幕 / 对白',camera:'运镜',size:'景别',sound:'声音说明'})[k]}</span><br>${esc(change[k])}</p>`).join('')}<p class="small muted">原素材和配音绑定保留</p></article>`;}).join('');
  else if(a.shots)detail=a.shots.map(s=>`<article><strong>${esc(s.title||'新镜头')} · ${esc(s.duration||5)} 秒</strong><p>${esc(s.description||'')}</p>${s.dialogue?`<p class="muted">${esc(s.dialogue)}</p>`:''}</article>`).join('');
  else if(['add_node','edit_node'].includes(action.tool)){title+=' · '+(a.title||byId(a.id)||a.type);detail=`${a.text!==undefined?`<p>${esc(a.text)}</p>`:''}${a.params?`<pre>${esc(JSON.stringify(a.params,null,2))}</pre>`:''}`;}
  else if(action.tool==='connect')detail=`<p>${esc(byId(a.source))} → ${esc(byId(a.target))}</p>`;
  else detail='<p>只调整节点位置，文字、素材和连接保持原样。</p>';
  return `<details class="director-plan-action"><summary>${esc(title)}${a.shots?' · '+a.shots.length+' 镜':''}</summary><div>${detail}</div></details>`;
 }).join('');
}

// Tab-local allowance: no remembered consent after reload; reserve before each request.
export class DirectorChatAllowance {
 constructor(){this.clear();}
 clear(){this.key=null;this.remaining=0;this.thinking='off';this.until=0;}
 keyFor(projectId,d){return JSON.stringify([projectId,d.provider,d.origin,d.model,d.profileRevision]);}
 approve(projectId,d,budget,thinking){if(!Number.isFinite(budget)||budget<=0||budget>100)throw Error('聊天额度无效');this.key=this.keyFor(projectId,d);this.remaining=budget;this.thinking=thinking;this.until=Date.now()+3600000;}
 available(projectId,d,cost){return this.key===this.keyFor(projectId,d)&&Date.now()<this.until&&Number.isFinite(cost)&&cost>0&&cost<=this.remaining;}
 reserve(projectId,d,cost){if(!this.available(projectId,d,cost))throw Error('请先设置本轮聊天额度');this.remaining=Math.max(0,this.remaining-cost);return {thinking:this.thinking,authorization:{provider:d.provider,origin:d.origin,model:d.model,profileRevision:d.profileRevision,sendText:true,sendMedia:false,requestLimit:1,currency:'USD',budget:cost}};}
}
