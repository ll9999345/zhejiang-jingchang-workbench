const type=n=>n?.params?.nativeCanvas?.node.type||n?.type;
const group=n=>n?.params?.nativeCanvas?.format==='infinite-canvas-workflow'&&['group','promptGroup'].includes(type(n));
const eligible=(n,kind)=>(n.params?.nativeCanvas?.format??'infinite-canvas-workflow')==='infinite-canvas-workflow'&&(kind==='group'?['image','prompt','text','script']:['prompt','text','script']).includes(type(n));
let pending=null,formState=null,busy=false;

async function recoverEdit(api,projectId,body,error){
 try{const p=await api('/api/projects/'+encodeURIComponent(projectId),{signal:AbortSignal.timeout(8000)}),receipt=p.settings?.inputGroupEditReceipt;
  if(receipt?.requestId===body.requestId&&receipt.mode===body.mode&&(!body.planHash||receipt.planHash===body.planHash))return{project:p,recovered:true,newer:p.revision!==receipt.revision};
 }catch{}
 throw error;
}
export async function applyMembershipEdit(api,projectId,body,{automatic=false,signal}={}){
 try{return{project:await api('/api/projects/'+encodeURIComponent(projectId)+'/input-groups/'+(automatic?'reconcile':'apply'),{method:'POST',body:JSON.stringify(body),signal}),recovered:false,newer:false};}
 catch(error){return recoverEdit(api,projectId,body,error);}
}
function editor(c,node,initial){
 const p=c.getProject(),members=node.params.nativeCanvas.members.map(r=>r.sourceNodeId),chosen=new Set(initial?.memberIds||members),nodes=new Map(p.nodes.map(n=>[n.id,n]));
 const ids=[...new Set([...members,...p.nodes.filter(n=>eligible(n,type(node))).map(n=>n.id)])];
 c.modal('编辑输入组成员',`<section class="input-group-members-editor"><label>组名称<input id="member-edit-title" maxlength="120" value="${c.esc(initial?.title??node.title)}"></label><p>同类型其他组中的成员会移入本组。文字在图文组与提示词组中的归属分别计算，原节点和素材保留。</p><div class="input-group-member-list">${ids.map(id=>{const n=nodes.get(id);if(!n)return'';const owners=p.nodes.filter(group).filter(g=>g.params.nativeCanvas.members.some(r=>r.sourceNodeId===id)).map(g=>g.title).join('、');return`<label><input type="checkbox" name="inputGroupMembers" value="${c.esc(id)}" ${chosen.has(id)?'checked':''}><span>${c.esc(n.title)}<small>${c.esc(owners?'当前：'+owners:'尚未归入输入组')}${eligible(n,type(node))?'':' · 原有特殊成员，可取消保留'}</small></span></label>`;}).join('')||'<p>目前没有适用的成员节点。可先在画布添加图片或文字。</p>'}</div><p class="small muted">先检查成员与字段变化，不会启动生成。</p></section>`,`<button data-action="close-modal">返回画布</button><button class="primary" data-action="preview-input-group-members">检查成员修改</button>`);
 formState={projectId:p.id,groupId:node.id,revision:p.revision};
}
function previewMarkup(result,c){
 const names=new Map(c.getProject().nodes.map(n=>[n.id,n.title])),label=id=>names.get(id)||id,e=result.effects;
 const actionNames={'restore-member-edge':'保留原成员的字段连线','remove-empty-group-reference':'空组不再提供参考素材','preserve-selected-slot':'保留原来选中的素材','preserve-original-producer':'保留原素材生产节点'};
 return`<section class="input-group-members-preview"><p>${result.changed?'以下修改仅保存画布，不提交模型。':'当前成员与名称无需修改。'}</p>${e.memberships.map(g=>`<article><h3>${c.esc(g.title)}</h3><p>加入：${c.esc(g.addedIds.map(label).join('、')||'无')}</p><p>移出：${c.esc(g.removedIds.map(label).join('、')||'无')}</p><p class="small muted">移出成员仍保留在画布和素材库中。</p></article>`).join('')}<p>新增 ${e.addedEdges.length} 条连线，交接 ${e.removedEdges.length} 条旧连线。</p>${e.fieldChanges.length?`<h3>已选择的素材字段</h3><ul>${e.fieldChanges.map(f=>`<li>${c.esc(f.title)} · ${c.esc(f.label)}：${c.esc(actionNames[f.action]||f.action)}</li>`).join('')}</ul>`:''}${e.warnings.length?`<h3>运行前仍需检查</h3><ul>${e.warnings.map(w=>`<li>${c.esc(label(w.nodeId))} · ${c.esc(w.label)}：${c.esc(w.message)}</li>`).join('')}</ul>`:''}</section>`;
}
export async function inputGroupMembershipAction(action,c){
 if(!['edit-input-group-members','back-input-group-members','preview-input-group-members','apply-input-group-members'].includes(action))return false;
 if(busy)return true;
 if(action==='edit-input-group-members'||action==='back-input-group-members'){
  await c.save();const p=c.getProject(),node=p.nodes.find(n=>n.id===(action==='back-input-group-members'?formState?.groupId:c.selected()));if(!group(node))throw Error('请选择普通输入组或提示词组');
  const initial=action==='back-input-group-members'?pending?.body:null;pending=null;editor(c,node,initial);return true;
 }
 if(action==='preview-input-group-members'){
  if(!formState||formState.projectId!==c.getProject().id)throw Error('画布已切换，请重新打开成员编辑');
  busy=true;try{
   const title=document.querySelector('#member-edit-title').value.trim(),memberIds=[...document.querySelectorAll('[name=inputGroupMembers]:checked')].map(el=>el.value);await c.save();const p=c.getProject();
   const body={mode:'manual',requestId:crypto.randomUUID(),revision:p.revision,groupId:formState.groupId,title,memberIds};
   const result=await c.api('/api/projects/'+encodeURIComponent(p.id)+'/input-groups/preview',{method:'POST',body:JSON.stringify(body)});
   pending={body:{...body,planHash:result.planHash},projectId:p.id,source:JSON.stringify(p)};
   c.modal('核对成员与字段变化',previewMarkup(result,c),'<button data-action="back-input-group-members">返回修改</button>'+(result.changed?'<button class="primary" data-action="apply-input-group-members">保存成员修改</button>':'<button data-action="close-modal">返回画布</button>'));
  }finally{busy=false;}return true;
 }
 if(!pending||c.getProject().id!==pending.projectId||JSON.stringify(c.getProject())!==pending.source)throw Error('画布已变化，请重新检查成员修改');
 busy=true;const button=document.querySelector('[data-action=apply-input-group-members]');if(button)button.disabled=true;const hold=c.holdSave?.();let holdResult;
 try{const base=structuredClone(c.getProject()),result=await applyMembershipEdit(c.api,pending.projectId,pending.body,{signal:AbortSignal.timeout(15000)});const merged=c.applyProject(result.project,{groupId:pending.body.groupId,recoveredNewer:result.newer,base});if(merged?.conflicts?.length)holdResult={error:Error('已保留新的画布编辑，请检查后手动保存')};pending=null;const dialog=document.querySelector('#modal');if(dialog?.querySelector('.input-group-members-preview'))dialog.close();c.notify(merged?.conflicts?.length?'已保留保存期间的新编辑，请检查后手动保存':result.recovered?'已从本机保存回执恢复成员修改':'成员已保存，未启动生成');}
 catch(error){holdResult={error};throw error;}
 finally{hold?.release(holdResult);busy=false;if(button?.isConnected)button.disabled=false;}
 return true;
}
