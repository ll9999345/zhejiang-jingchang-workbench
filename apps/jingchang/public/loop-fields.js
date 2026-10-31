import {loopDescendants} from '/loop-core.mjs';
import {comfyMediaField} from './comfy-media.js';
import {minimaxTimelineOf,selectedMinimaxSegment,minimaxParameterNames,minimaxRatios,minimaxGraphContract} from './minimax-h3-core.js';
const identity=f=>JSON.stringify([f.targetNodeId,f.kind==='minimax'?'minimax':f.nodeId,f.name]);
const mapping=(f,rounds)=>({targetNodeId:f.targetNodeId,...(f.kind?{kind:f.kind}:{nodeId:f.nodeId}),name:f.name,values:Array(rounds).fill(f.value)});
export async function createLoopFields({form,node,project,config,api,esc}){
 const area=form.querySelector('#loop-field-values'),desc=loopDescendants(project,node.id),templates=new Map(),fields=[];
 for(const n of project.nodes.filter(n=>desc.has(n.id))){
  const b=n.params?.workflowBinding,h3=minimaxTimelineOf(n);
  if(h3&&(b?.minimaxH3||n.params?.cloudBinding?.minimaxH3)){
   const s=selectedMinimaxSegment(h3),meta={duration:{min:.5,max:60,step:.1},megapixels:{min:.1,max:2,step:.1},seed:{min:0,max:Number.MAX_SAFE_INTEGER,step:1},aspectRatio:{control:'select',options:Object.keys(minimaxRatios)}};
   for(const [name,label]of Object.entries(minimaxParameterNames))if(name!=='seed'||!b?.incrementSeeds)fields.push({targetNodeId:n.id,kind:'minimax',name,type:typeof s[name],value:s[name],meta:meta[name],title:`${n.title} / H3 当前片段 / ${label}`});
  }
  if(!b)continue;
  let template=templates.get(b.workflowId);if(!template){template=await api('/api/workflows/'+encodeURIComponent(b.workflowId));templates.set(b.workflowId,template);}
  const managed=new Set(h3?Object.values(minimaxGraphContract(template.workflow,h3.referenceNodeId)).filter(f=>f&&typeof f==='object').map(f=>f.nodeId+':'+f.name):[]);
  for(const [nodeId,w]of Object.entries(template.workflow))for(const [name,value]of Object.entries(w.inputs||{})){
   const meta=template.fields?.find(f=>f.nodeId===nodeId&&f.name===name),match=f=>f?.nodeId===nodeId&&f?.name===name;
   if(managed.has(nodeId+':'+name)||!['string','number','boolean'].includes(typeof value)||meta?.exposed===false||comfyMediaField(w.class_type,name,meta)||match(b.promptField)||match(b.promptBatch)||b.imageSources?.some(match)||b.incrementSeeds&&['seed','noise_seed'].includes(name))continue;
   fields.push({targetNodeId:n.id,nodeId,name,type:typeof value,value:meta?.defaultValue??value,meta,title:`${n.title} / ${w._meta?.title||w.class_type} / ${meta?.label||name}`});
  }
 }
 let mappings=structuredClone(config.fieldValues||[]),rounds=config.count;
 function capture(){for(const [i,m] of mappings.entries()){const f=fields.find(f=>identity(f)===identity(m));if(!f)continue;const values=[...area.querySelectorAll(`[data-loop-mapping="${i}"] [data-loop-round]`)];m.values=values.map(el=>f.type==='boolean'?el.value==='true':f.type==='number'?el.value.trim()===''?null:Number(el.value):el.value);}}
 function control(f,v,r){const attr=`data-loop-round="${r}"`;if(f.meta?.control==='select')return `<select ${attr}>${f.meta.options.map(o=>`<option value="${esc(String(o))}" ${o===v?'selected':''}>${esc(String(o))}</option>`).join('')}</select>`;if(f.type==='boolean')return `<select ${attr}><option value="true" ${v===true?'selected':''}>是</option><option value="false" ${v===false?'selected':''}>否</option></select>`;if(f.type==='number')return `<input ${attr} type="number" required step="${f.meta?.step??'any'}" ${f.meta?.min!==undefined?`min="${f.meta.min}"`:''} ${f.meta?.max!==undefined?`max="${f.meta.max}"`:''} value="${esc(String(v??''))}">`;return `<textarea ${attr} rows="2" maxlength="32000">${esc(String(v??''))}</textarea>`;}
 function render(){area.innerHTML=`<details ${mappings.length?'open':''}><summary>每轮不同的参数${mappings.length?' · '+mappings.length+' 个字段':''}</summary><p class="small muted">可选择ComfyUI字段或两种引擎的H3当前片段参数。逐轮填写提示词、时长、比例、百万像素和种子；原时间轴保持原值。H3接收列表文字时，须开启上游输入并留空当前片段提示词。显式填写种子前，须关闭目标节点的递增种子。</p>${mappings.map((m,i)=>{const f=fields.find(f=>identity(f)===identity(m));return `<section class="loop-variable" data-loop-mapping="${i}"><div class="row"><label>目标字段<select data-loop-pick="${i}">${!f?'<option value="">原字段已失效，请重新选择</option>':''}${fields.map((x,k)=>`<option value="${k}" ${identity(x)===identity(m)?'selected':''}>${esc(x.title)}</option>`).join('')}</select></label><button type="button" data-loop-remove="${i}" aria-label="移除参数 ${i+1}">移除</button></div>${f?`<p class="small muted loop-field-name">${esc(f.title)}</p>`:''}${f?Array.from({length:rounds},(_,r)=>`<label>第 ${r+1} 轮${control(f,m.values[r]??f.value,r)}</label>`).join(''):''}</section>`;}).join('')}${fields.length?`<button type="button" data-loop-add ${mappings.length>=16?'disabled':''}>添加逐轮参数</button>`:'<p class="small muted">先连接并绑定下游ComfyUI工作流或H3时间轴，再来选择可变参数。</p>'}</details>`;}
 area.addEventListener('click',e=>{const add=e.target.closest('[data-loop-add]'),remove=e.target.closest('[data-loop-remove]');if(!add&&!remove)return;e.preventDefault();capture();if(add){const f=fields.find(f=>!mappings.some(m=>identity(m)===identity(f)));if(!f||mappings.length>=16)return;mappings.push(mapping(f,rounds));}else mappings.splice(Number(remove.dataset.loopRemove),1);render();});
 area.addEventListener('change',e=>{const pick=e.target.closest('[data-loop-pick]');if(!pick)return;capture();const f=fields[Number(pick.value)];if(!f)return;mappings[Number(pick.dataset.loopPick)]=mapping(f,rounds);render();});
 form.addEventListener('input',e=>{if(!['mode','count','format','values'].includes(e.target.name))return;let count;try{count=form.elements.mode.value==='repeat'?Number(form.elements.count.value):form.elements.format.value==='json'?JSON.parse(form.elements.values.value).length:form.elements.values.value.split(/\r?\n/).filter(s=>s.trim()).length;}catch{return;}if(!Number.isInteger(count)||count<1||count>32||count===rounds)return;capture();rounds=count;render();});
 render();return()=>{capture();for(const m of mappings)if(!fields.some(f=>identity(f)===identity(m)))throw Error('逐轮参数字段已失效，请重新选择或移除');return mappings;};
}
