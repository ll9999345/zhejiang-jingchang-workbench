let pending=null,owner=null,editVersion=0;
const $=selector=>document.querySelector(selector);
export function openNativeFieldImport(template,{modal,esc}) {
 owner={id:template.id,revision:template.revision};pending=null;editVersion++;
 modal('导入原生字段配置',`<p>${esc(template.name)} · 在本机预览 Infinite Canvas .config.json。字段编号、目标输入、类型及默认值全部通过检查后才保存；保存会保留旧字段修订。</p><form id="native-field-import"><label>字段配置文件<input name="file" type="file" accept=".json,application/json"></label><label>或粘贴 .config.json<textarea name="config" rows="6"></textarea></label></form><div id="native-field-preview" role="status"></div>`,`<button data-action="preview-native-field-import">检查字段映射</button><button class="primary" data-action="save-native-field-import" disabled>保存字段配置</button>`);
 $('#native-field-import').addEventListener('input',()=>{editVersion++;pending=null;const button=$('[data-action="save-native-field-import"]');if(button)button.disabled=true;$('#native-field-preview').textContent='配置已更改，请重新检查';});
}
export async function nativeFieldImportAction(action,{api,esc,workflowEditor,toast}) {
 if (!['preview-native-field-import','save-native-field-import'].includes(action)) return false;
 if (!owner || !$('#native-field-import')) throw Error('请重新打开字段导入');
 if (action==='preview-native-field-import') {
  const form=$('#native-field-import'),file=form.elements.file.files[0],identity=owner,version=++editVersion;
  pending=null;$('[data-action="save-native-field-import"]').disabled=true;
  if (file?.size>200000) throw Error('字段配置最多200KB');
  const text=file?await file.text():form.elements.config.value;
  if (text.length>200000) throw Error('字段配置最多200KB');
  let config;try{config=JSON.parse(text);}catch{throw Error('请选择或粘贴有效的 .config.json');}
  if(owner!==identity||editVersion!==version||$('#native-field-import')!==form)return true;
  const preview=await api('/api/workflows/fields/preview',{method:'POST',body:JSON.stringify({workflowId:owner.id,nativeConfig:config})});
  if (owner!==identity || editVersion!==version || $('#native-field-import')!==form) return true;
  pending=config;$('#native-field-preview').innerHTML=`<p>匹配${preview.fields.filter(field=>field.nativeFieldId).length}个原生字段；${preview.fields.filter(field=>field.randomEnabled).length}个数字随机能力。尚未保存或运行。</p><details open><summary>字段编号与目标</summary><ul>${preview.fields.filter(field=>field.nativeFieldId).map(field=>`<li>${esc(field.nativeFieldId)} → #${esc(field.nodeId)} ${esc(field.name)} · ${esc(field.label)}${field.randomEnabled?' · 允许随机':''}</li>`).join('')}</ul></details>`;
  $('[data-action="save-native-field-import"]').disabled=false;
 } else {
  if (!pending) throw Error('请先检查当前字段配置');
  const button=$('[data-action="save-native-field-import"]');button.disabled=true;
  try {const next=await api('/api/workflows/'+owner.id+'/config',{method:'PUT',body:JSON.stringify({revision:owner.revision,nativeConfig:pending})});pending=null;await workflowEditor(next.id);toast('原生字段配置已保存，旧修订保留');}finally{if(button.isConnected)button.disabled=false;}
 }
 return true;
}
export function applyNativeComfyParameters(form,fields,plan,{restoreRandomFields}) {
 if (!plan || plan.issues.length) return false;
 for (const entry of plan.overrides) {
  const index=fields.findIndex(field=>field.nodeId===entry.nodeId&&field.name===entry.name),input=form.elements['field-'+index];
  if (input) {
   if(input.type==='checkbox')input.checked=entry.value===true;
   else input.value=String(entry.value);
   const slider=form.querySelector('[data-field-slider="'+index+'"]');if(slider)slider.value=String(entry.value);
  }
 }
 restoreRandomFields(form,fields,plan.randomFields);
 if (form.elements.incrementSeeds) form.elements.incrementSeeds.value='false';
 return true;
}
