import {randomFieldKey,workflowRandomDescriptors} from './workflow-random-core.js';
const expandedReceipts=new Set();
export function randomNumberControl(input,index,field,esc,{active=true,prefix='random'}={}){
 const label=field.label||field.name||field.fieldName;
 return `<span class="workflow-random-control" data-random-control><span class="workflow-random-value">${input}</span><input type="hidden" name="${prefix}-${index}" value="${active}"><button type="button" role="switch" aria-checked="${active}" aria-label="${esc(label)} 每次随机" data-random-toggle="${prefix}-${index}">${active?'每次随机':'固定数值'}</button><span class="small muted workflow-random-help" data-random-help>${active?'每批次选一个值，恢复沿用原值':'使用手填数值'}</span></span>`;
}
export function syncRandomControl(button,active){
 const row=button.closest('[data-random-control]');if(!row)return;const flag=row.querySelector(`input[name="${button.dataset.randomToggle}"]`);if(flag)flag.value=String(active);button.setAttribute('aria-checked',String(active));button.textContent=active?'每次随机':'固定数值';row.querySelectorAll('.workflow-random-value input').forEach(input=>input.disabled=active);const help=row.querySelector('[data-random-help]');if(help)help.textContent=active?'每批次选一个值，恢复沿用原值':'使用手填数值';
}
export function restoreRandomFields(form,fields,selection,{prefix='random'}={}){
 const keys=selection===undefined?null:new Set(selection.map(randomFieldKey));fields.forEach((field,index)=>{const button=form.querySelector(`[data-random-toggle="${prefix}-${index}"]`);if(button)syncRandomControl(button,keys===null?field.randomActive!==false:keys.has(randomFieldKey(field)));});
}
export function readRandomFields(form,fields,{prefix='random'}={}){
 const capable=fields.map((field,index)=>({field,index})).filter(({index})=>form.elements[`${prefix}-${index}`]);if(!capable.length)return undefined;return capable.filter(({index})=>form.elements[`${prefix}-${index}`].value==='true').map(({field})=>({nodeId:field.nodeId,name:field.name??field.fieldName}));
}
export function randomSelectionIssues(fields,selection){
 if(selection===undefined)return[];const keys=new Set(fields.filter(f=>f.randomEnabled===true&&f.control==='number'&&f.exposed!==false).map(randomFieldKey));return selection.filter(f=>!keys.has(randomFieldKey(f)));
}
export const cloudNumberFields=recipe=>recipe.kind==='model'||recipe.minimaxProfile==='h3'?[]:recipe.fields.map(f=>({...f,name:f.fieldName,control:f.type==='number'&&f.source==='value'?'number':null}));
export function randomScopeMarkup(fields,esc){
 if(!fields?.length)return'';return `<p class="workflow-random-scope small muted">每批次随机：${fields.map(f=>`${esc(f.label||f.name)}（${esc(f.min)}–${esc(f.max)}${f.isFloat?'，'+f.precision+' 位小数':'，整数'}）`).join('；')}。开始任务时选值并保存；恢复沿用原值。</p>`;
}
export function cloudRandomScope(recipe,esc){return randomScopeMarkup(workflowRandomDescriptors(cloudNumberFields(recipe)),esc);}
export function randomReceiptMarkup(job,esc){
 const record=job.workflowRandom;if(!record?.batches?.length)return'';
 const owner=job.id||job.executionId||job.nodeId||'local';
 const state=index=>job.items?.[index]?.promptId||job.upstreamId||job.status==='completed'?'已提交':job.items?.[index]?.status==='submitting'?'提交待确认':'已保存，待提交';
 return `<details class="workflow-random-receipt" data-random-receipt data-random-owner="${esc(owner)}" ${expandedReceipts.has(owner)?'open':''}><summary>已保存的随机参数 · ${record.count} 批次</summary><p class="small muted">恢复继续使用这些值。保存参数不代表上游已经接受任务。</p>${record.batches.map(batch=>`<section><strong>第 ${batch.index+1} 次 · ${state(batch.index)}</strong><dl>${batch.values.slice(0,20).map((field,index)=>`<div><dt>${esc(record.fields[index]?.label||field.name)} <small>#${esc(field.nodeId)} ${esc(field.name)}</small></dt><dd>${esc(field.value)}</dd></div>`).join('')}</dl>${batch.values.length>20?'<p class="small muted">其余字段见完整任务记录。</p>':''}</section>`).join('')}${job.id?`<a href="/api/jobs/${encodeURIComponent(job.id)}" download="随机参数-${esc(job.id)}.json">下载完整任务记录</a>`:''}</details>`;
}
if(typeof document!=='undefined')document.addEventListener('toggle',event=>{const receipt=event.target;if(receipt.matches?.('[data-random-owner]')){if(receipt.open)expandedReceipts.add(receipt.dataset.randomOwner);else expandedReceipts.delete(receipt.dataset.randomOwner);}},true);
if(typeof document!=='undefined')document.addEventListener('click',event=>{const button=event.target.closest?.('[data-random-toggle]');if(button){event.preventDefault();const active=button.getAttribute('aria-checked')!=='true';syncRandomControl(button,active);button.dispatchEvent(new CustomEvent('workflow-random-change',{bubbles:true,detail:{name:button.dataset.randomToggle,active}}));}});
