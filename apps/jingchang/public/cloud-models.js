// Model fields are returned by the local, versioned catalog. No API keys are
// required or sent while browsing the catalog or editing these controls.
export function modelFieldMarkup(f,i,project,esc){
 const disabled=f.enabled===false?'disabled':'',valueAttr=`data-value="${i}" id="field-value-${i}" ${disabled}`;
 const options=(values,selected=f.fieldValue)=>values.map(v=>`<option value="${esc(v)}" ${String(v)===String(selected)?'selected':''}>${esc(v==='empty'?'采用平台默认（不发送）':v)}</option>`).join('');
 let input;
 if(f.type==='boolean')input=`<select ${valueAttr}>${options(['true','false'])}</select>`;
 else if(f.type==='multi-select')input=`<select ${valueAttr} multiple size="${Math.min(6,f.options.length)}">${f.options.map(v=>`<option value="${esc(v)}" ${f.fieldValue.includes(v)?'selected':''}>${esc(v)}</option>`).join('')}</select><p class="hint">可多选，按所选值发送数组。</p>`;
 else if(f.type==='select')input=`<select ${valueAttr}><option value="">选择…</option>${options(f.options)}</select>`;
 else if(f.type==='size')input=`<input ${valueAttr} list="field-sizes-${i}" placeholder="如 1024*1024" value="${esc(f.fieldValue)}"><datalist id="field-sizes-${i}">${options(f.options.filter(v=>v!=='custom'))}</datalist>`;
 else if(f.type==='number')input=`<input ${valueAttr} type="number" step="${f.integer?1:'any'}" ${f.min!==undefined?`min="${esc(f.min)}"`:''} ${f.max!==undefined?`max="${esc(f.max)}"`:''} value="${esc(f.fieldValue)}">`;
 else if(f.type==='text-list')input=`<textarea ${valueAttr} placeholder="每行一项">${esc(f.fieldValue.join('\n'))}</textarea><p class="hint">每行一项，最多 ${f.maxItems} 项，按列表传入模型。</p>`;
 else input=`<textarea ${valueAttr} ${f.maxLength?`maxlength="${f.maxLength}"`:''} placeholder="${['image','video','audio'].includes(f.type)?'HTTPS 素材链接或 asset:// 标识':''}">${esc(f.fieldValue)}</textarea>`;
 if(['image','video','audio'].includes(f.type)){
  const assets=project.assets.filter(a=>a.type.startsWith(f.type+'/'));
  input=`<label class="sr-only" for="field-source-${i}">${esc(f.label)} 来源</label><select id="field-source-${i}" data-source="${i}" ${disabled}><option value="value" ${f.source!=='asset'?'selected':''}>使用已有素材链接</option><option value="asset" ${f.source==='asset'?'selected':''}>使用本项目素材（运行时上传）</option></select>${f.source==='asset'?`<select ${valueAttr.replace('data-value','data-asset')}><option value="">选择项目素材…</option>${assets.map(a=>`<option value="${a.id}" ${a.id===f.assetId?'selected':''}>${esc(a.name)}</option>`).join('')}</select>`:input}`;
 }
 return `<div class="field model-field" data-field="${esc(f.nodeId+':'+f.fieldName)}"><div class="field-title"><label for="field-value-${i}"><b>${esc(f.label)}</b>${f.required?'<span class="required"> 必填</span>':''}</label><small>${esc(f.type)}</small>${!f.required?`<label class="check field-enable"><input data-enabled="${i}" type="checkbox" ${f.enabled!==false?'checked':''}>发送此参数</label>`:''}</div>${f.description?`<p class="hint">${esc(f.description)}</p>`:''}${input}</div>`;
}
export const activeFields=recipe=>recipe.fields.filter(f=>recipe.kind!=='model'||f.enabled!==false);
export const modelKindLabel=kind=>({model:'标准模型',app:'AI 应用',workflow:'工作流'}[kind]||kind);
