export function installNativeCloudFieldImport({api,getRecipe,replaceFields,changed,toast}) {
 const fingerprint=()=>JSON.stringify(getRecipe());
 const box=document.createElement('details');box.id='native-rh-field-import';
 box.innerHTML='<summary>导入原生 RunningHub字段配置</summary><p>在本机检查fields或nodeInfoList，不拉取平台、不运行生成。采用后还需保存配置；旧修订保留。</p><label>JSON文件<input id="native-rh-field-file" type="file" accept=".json,application/json"></label><button type="button" id="native-rh-field-preview">检查字段</button><div id="native-rh-field-result" role="status"></div><button type="button" id="native-rh-field-adopt" disabled>采用这些字段</button>';
 document.querySelector('#fields').before(box);let pending=null;
 const result=box.querySelector('#native-rh-field-result'),adopt=box.querySelector('#native-rh-field-adopt'),preview=box.querySelector('#native-rh-field-preview'),fileInput=box.querySelector('#native-rh-field-file');
 fileInput.addEventListener('change',()=>{pending=null;adopt.disabled=true;result.textContent='请检查当前文件';});
 preview.addEventListener('click',async()=>{
  pending=null;adopt.disabled=true;preview.disabled=true;
  try {
   const owner=getRecipe(),signature=fingerprint(),file=fileInput.files[0];if(!owner||owner.kind==='model'||owner.minimaxProfile==='h3')throw Error('原生字段导入用于普通应用或工作流');
   if(!file||file.size>200000)throw Error('请选择不超过200KB的字段JSON');
   let nativeConfig;try{nativeConfig=JSON.parse(await file.text());}catch{throw Error('原字段配置不是有效JSON');}
   const value=await api('/api/cloud-workflows/fields/preview','POST',{nativeConfig});
   if(getRecipe()!==owner||fingerprint()!==signature||fileInput.files[0]!==file)throw Error('检查期间配置或文件已切换，请重新检查');
   pending={owner,signature,file,fields:value.fields};result.textContent=`匹配${value.fields.length}个字段，${value.fields.filter(field=>field.randomEnabled).length}个数字随机能力；尚未采用或保存。`;adopt.disabled=false;
  } catch(error){result.textContent=error.message;toast(error.message);}finally{preview.disabled=false;}
 });
 adopt.addEventListener('click',()=>{
  if(!pending||getRecipe()!==pending.owner||fingerprint()!==pending.signature||fileInput.files[0]!==pending.file){pending=null;adopt.disabled=true;toast('配置已切换，请重新检查');return;}
  replaceFields(structuredClone(pending.fields));pending=null;adopt.disabled=true;changed();result.textContent='字段已填入当前配置草稿，保存后生效；没有运行生成。';
 });
}

export function cloudOverrideIssues(binding,recipe) {
 if(!binding||binding.recipeId!==recipe.id)return[];
 return(binding.overrides||[]).flatMap(item=>{
  const field=recipe.fields.find(field=>field.nodeId===item.nodeId&&field.fieldName===item.fieldName);
  let reason='';
  if(!field||field.source!=='value'||['image','video','audio'].includes(field.type)||recipe.kind==='model'||recipe.minimaxProfile==='h3')reason='原固定值字段已不可覆盖';
  else if(field.type==='number'&&(!['number','string'].includes(typeof item.fieldValue)||!Number.isFinite(Number(item.fieldValue))))reason='原数值类型不符';
  else if(field.type==='boolean'&&![true,false,'true','false'].includes(item.fieldValue))reason='原开关类型不符';
  else if(field.type==='select'&&!field.options.includes(String(item.fieldValue)))reason='原下拉值已不在选项中';
  return reason?[{nodeId:item.nodeId,fieldName:item.fieldName,label:field?.label||item.fieldName,reason}]:[];
 });
}
export function cloudOverrideMarkup(recipe,binding,esc) {
 if(recipe.kind==='model'||recipe.minimaxProfile==='h3')return'';
 return recipe.fields.map((field,index)=>{
  if(field.source!=='value'||['image','video','audio'].includes(field.type))return'';
  const prior=binding?.overrides?.find(item=>item.nodeId===field.nodeId&&item.fieldName===field.fieldName),value=prior?.fieldValue??field.fieldValue,name='cloud-value-'+index;
  const input=field.type==='number'?`<input name="${name}" type="number" step="any" value="${esc(value)}">`:field.type==='boolean'||field.type==='select'?`<select name="${name}">${(field.type==='boolean'?['true','false']:field.options).map(option=>`<option value="${esc(option)}" ${String(value)===option?'selected':''}>${esc(option)}</option>`).join('')}</select>`:`<textarea name="${name}" maxlength="20000" rows="2">${esc(value)}</textarea>`;
  return `<label class="cloud-fixed-override"><span><input type="checkbox" name="cloud-fixed-${index}" data-cloud-fixed="${index}" ${prior?'checked':''}>覆盖本节点：${esc(field.label)}</span>${input}<span class="small muted">关闭时沿用配置原值；开启只保存在本节点，不改云配置。</span></label>`;
 }).join('');
}
export function readCloudOverrides(form,recipe) {
 if(recipe.kind==='model'||recipe.minimaxProfile==='h3')return[];
 return recipe.fields.flatMap((field,index)=>{
  if(!form.elements['cloud-fixed-'+index]?.checked)return[];
  if(form.elements['cloud-input-'+index]?.value)throw Error('字段不能同时覆盖固定值与映射上游输入');
  const value=form.elements['cloud-value-'+index]?.value;
  if(value===undefined||field.type==='number'&&(!value.trim()||!Number.isFinite(Number(value))))throw Error('请填写有效的节点固定值');
  return[{nodeId:field.nodeId,fieldName:field.fieldName,fieldValue:field.type==='number'?Number(value):field.type==='boolean'?value==='true':value}];
 });
}
