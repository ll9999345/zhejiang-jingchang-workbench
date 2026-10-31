import {nativeReferenceChoices} from './native-flow-ui.js';
import {sourceIndexFromInput,sourceIndexToInput} from './workflow-source-fields.js';

const mediaKinds=new Set(['image','video','audio']);
const kindNames={image:'图片',video:'视频',audio:'音频'};

export function cloudSourceChoices(project,nodeId){
 return nativeReferenceChoices(project,nodeId);
}

export function cloudSourceFieldIssues(binding,recipe,choices){
 if(!binding||binding.recipeId!==recipe.id)return[];
 return(binding.inputs||[]).flatMap(input=>{
  const field=recipe.fields.find(f=>f.nodeId===input.nodeId&&f.fieldName===input.fieldName);
  let reason='';
  if(!field)reason='字段已不存在';
  else if(field.source==='lora')reason='字段已配置为 LoRA';
  else if(input.useText&&field.type!=='text')reason='字段已不是文字输入';
  else if(input.sourceNodeId&&(!mediaKinds.has(field.type)||!choices.some(choice=>choice.value==='node:'+input.sourceNodeId&&choice.kinds.includes(field.type))))reason='上游来源或媒体类型不再可用';
  return reason?[{nodeId:input.nodeId,fieldName:input.fieldName,label:field?.label||input.fieldName,reason}]:[];
 });
}

export function cloudSourceFieldsMarkup(recipe,binding,choices,esc){
 return recipe.fields.map((field,index)=>{
  const previous=binding?.inputs?.find(input=>input.nodeId===field.nodeId&&input.fieldName===field.fieldName),value=previous?.useText?'text':previous?.sourceNodeId?'node:'+previous.sourceNodeId:'',options=mediaKinds.has(field.type)?choices.filter(choice=>choice.kinds.includes(field.type)):[];
  const missing=value.startsWith('node:')&&!options.some(choice=>choice.value===value);
  return`<label>${esc(field.label)}<select name="cloud-input-${index}" ${field.source==='lora'?'disabled':''}><option value="">使用配置中的值</option>${field.type==='text'&&field.source!=='lora'?`<option value="text" ${value==='text'?'selected':''}>传入当前及所有上游文字</option>`:''}${options.map(choice=>`<option value="${esc(choice.value)}" data-grouped="${choice.grouped?'true':'false'}" data-dynamic="${choice.dynamic?'true':'false'}" ${value===choice.value?'selected':''}>${esc(choice.label)}</option>`).join('')}${missing?`<option value="${esc(value)}" selected disabled>原来源已不可用，请恢复来源</option>`:''}</select>${mediaKinds.has(field.type)?`<span class="native-flow-index-control" data-cloud-index-control="${index}" hidden><span>使用来源中的第几份素材</span><input name="cloud-source-index-${index}" type="number" min="1" max="1000" step="1" disabled value="${sourceIndexToInput(previous?.sourceIndex)}" placeholder="单份来源可留空" aria-label="${esc(field.label)} 来源素材序号"><span class="small muted" data-cloud-index-hint="${index}"></span></span><span class="small muted">每个字段接收一份${kindNames[field.type]}。可将同组不同序号分配到多个字段；序号从 1 开始，按来源的完整素材顺序选择，运行时复查类型和真实结果。</span>`:''}</label>`;
 }).join('');
}

export function syncCloudSourceControl(form,index,{reset=false}={}){
 const select=form.elements['cloud-input-'+index],input=form.elements['cloud-source-index-'+index];if(!select||!input)return;
 const selected=select.selectedOptions[0],isNode=select.value.startsWith('node:'),required=isNode&&(selected?.dataset.grouped==='true'||selected?.dataset.dynamic==='true');
 if(reset||!isNode)input.value='';input.disabled=!isNode;input.required=required;
 form.querySelector('[data-cloud-index-control="'+index+'"]').hidden=!isNode;
 form.querySelector('[data-cloud-index-hint="'+index+'"]').textContent=required?'整组或待生成来源须填写 1–1000 的序号；只使用本轮完整结果。':'已有单份来源可留空，或明确选择第 1 份。';
}

export function readCloudBindingInputs(form,recipe,choices){
 return recipe.fields.flatMap((field,index)=>{
  const value=form.elements['cloud-input-'+index]?.value||'';if(!value)return[];
  if(field.source==='lora')throw Error('LoRA 字段不能映射上游素材或文字');
  if(value==='text'){if(field.type!=='text')throw Error('此字段不能接收上游文字');return[{nodeId:field.nodeId,fieldName:field.fieldName,useText:true}];}
  const choice=choices.find(choice=>choice.value===value);if(!value.startsWith('node:')||!choice||!choice.kinds.includes(field.type))throw Error('原来源已不可用，请恢复连线和素材后继续；原绑定已保留');
  const sourceIndex=sourceIndexFromInput(form.elements['cloud-source-index-'+index]?.value,{required:choice.grouped||choice.dynamic});
  return[{nodeId:field.nodeId,fieldName:field.fieldName,sourceNodeId:value.slice(5),...(sourceIndex!==undefined?{sourceIndex}:{})}];
 });
}

export function nativeCloudInputMarkup(step,esc){
 const fields=step.nativeInputs?.fields;if(!fields?.length)return'';
 return`<section class="native-reference-manifest"><strong>本次云字段素材清单</strong><ol>${fields.map(field=>`<li>${esc(field.fieldLabel||field.fieldName)} ← ${esc(field.sourceName)} · ${esc(kindNames[field.kind])} · ${field.sourceIndex===undefined?'已确认单份来源':'第 '+(field.sourceIndex+1)+' 份'} · ${field.assetId?esc(field.name||field.assetId):'本轮待生成，完整完成后复验'}</li>`).join('')}</ol><p class="small muted">每个字段只使用上述一份素材。序号越界、文件变化或媒体类型不符时停止后续提交，上游结果保留。</p></section>`;
}
