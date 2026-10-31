import {isNativePrompt,nativePromptSettings,nativePromptItems,normalizeNativePromptSettings} from './native-prompt-core.js';
let targetId;

export function readNativePromptForm(form){
 return normalizeNativePromptSettings({version:1,splitEnabled:form.elements.splitEnabled.checked,separator:form.elements.separator.value,llmEnabled:form.elements.llmEnabled.checked,instruction:form.elements.instruction.value,previewHeight:Number(form.elements.previewHeight.value)});
}
export function applyNativePromptSettings(node,value){
 if(!isNativePrompt(node))throw Error('智能提示词节点已不存在');
 node.params.nativePrompt=normalizeNativePromptSettings(value);return node;
}
export function nativePromptPreviewMarkup(node,value,esc){
 const preview={...node,params:{...node.params,nativePrompt:normalizeNativePromptSettings(value)}},parts=nativePromptItems(preview);
 return`<p class="small muted">${parts.length} 段 · ${value.llmEnabled?'当前结果预览；运行后按完整回答重新拆分':'本地文字拆分，不调用模型'}</p><ol style="height:${value.previewHeight}px;overflow:auto;overflow-wrap:anywhere">${parts.map(text=>`<li>${esc(text)}</li>`).join('')}</ol>`;
}
export async function nativePromptAction(action,ctx){
 if(!['edit-native-prompt','save-native-prompt'].includes(action))return false;
 const {modal,esc,getProject,getSelected,checkpoint,changed,save,toast}=ctx,project=getProject(),node=project.nodes.find(node=>node.id===(action==='edit-native-prompt'?getSelected():targetId));
 if(!isNativePrompt(node))throw Error('请选择原生智能提示词节点');
 if(action==='edit-native-prompt'){
  targetId=node.id;const settings=nativePromptSettings(node);
  modal('智能提示词拆分与改写',`<p>按分隔符拆分文字，或先由语言模型改写再拆分。原始参数保留，本机设置随项目保存。</p><form id="native-prompt-settings"><label class="check-label"><input name="splitEnabled" type="checkbox" ${settings.splitEnabled?'checked':''}>开启分隔符拆分</label><label>分隔符<input name="separator" maxlength="8" value="${esc(settings.separator)}" placeholder=";（留空也使用分号）"></label><label class="check-label"><input name="llmEnabled" type="checkbox" ${settings.llmEnabled?'checked':''}>开启语言模型改写</label><label>改写指令<textarea name="instruction" maxlength="32000" rows="4" placeholder="留空时使用当前文字；上游文字会先去重再传入">${esc(settings.instruction)}</textarea></label><p class="small muted">模型、系统指令和媒体参考在“绑定/编辑语言模型”中配置，并明确确认迁移。关闭改写会保留绑定，运行时只传递本地文字。保存设置不发送到模型。</p><label>拆分预览高度<input name="previewHeight" type="range" min="40" max="220" step="1" value="${settings.previewHeight}"></label><section id="native-prompt-preview" aria-live="polite">${nativePromptPreviewMarkup(node,settings,esc)}</section></form>`,`<button data-action="close-modal">取消</button><button class="primary" data-action="save-native-prompt">保存本机设置</button>`);
  const form=document.querySelector('#native-prompt-settings'),preview=document.querySelector('#native-prompt-preview');form.addEventListener('input',()=>{try{preview.innerHTML=nativePromptPreviewMarkup(node,readNativePromptForm(form),esc);}catch(error){preview.textContent=error.message;}});return true;
 }
 const form=document.querySelector('#native-prompt-settings');if(!form.reportValidity())return true;const value=readNativePromptForm(form);checkpoint();applyNativePromptSettings(node,value);changed();await save();document.querySelector('#modal').close();toast('智能提示词设置已保存，未调用模型');return true;
}
