import {jimengStudioDefaults} from './jimeng-studio-core.js';
import {jimengStudioFields,readJimengStudioFields,jimengChangedCommand} from './jimeng-studio-ui.js';
import {nativeReferenceChoices} from './native-flow-ui.js';
import {referenceFields,installReferenceFields,readReferenceFields} from './reference-fields.js';
let target;
export async function jimengBindingAction(action,ctx){
 if(!['bind-jimeng-node','save-jimeng-binding'].includes(action))return false;
 const {getProject,getSelected,modal,esc,checkpoint,changed,save,toast}=ctx,p=getProject(),n=p.nodes.find(n=>n.id===(action==='save-jimeng-binding'?target:getSelected()));if(!['image','video'].includes(n?.type))throw Error('请选择图片或视频节点');
 if(action==='bind-jimeng-node'){
  target=n.id;const b=ctx.jimengSeed||n.params?.studioBinding,config=b?.config?.protocol==='jimeng'?b.config:jimengStudioDefaults(n.type),sources=b?.config?.protocol==='jimeng'?b.referenceSources:[],choices=[...nativeReferenceChoices(p,n.id,{kinds:['image','video','audio']}),...p.assets.filter(a=>/^(image|video|audio)\//.test(a.type)).map(a=>({value:'asset:'+a.id,label:'固定素材：'+a.name}))];
  modal('绑定本机即梦',`<p>保存命令、规格、素材映射和原查询范围。运行画布时再逐个确认本机登录、生成预算、原文件及查询范围，不填写API密钥。</p><form id="jimeng-binding"><div id="jimeng-binding-config">${jimengStudioFields({mode:n.type,config},esc)}</div><label>提示词范围<select name="includeUpstream"><option value="true">当前节点及上游文字</option><option value="false" ${b?.includeUpstream===false?'selected':''}>仅当前节点</option></select></label><div id="jimeng-binding-references">${referenceFields({sources,choices,max:20,label:'参考',esc})}</div><p class="small muted">保留所选顺序。上游整组媒体按当前数据流展开；角色和数量在运行前核对，不会静默丢弃超限素材。</p></form>`,`<button class="primary" data-action="save-jimeng-binding">保存即梦绑定</button>`);
  const form=document.querySelector('#jimeng-binding');form.jimengConfig=structuredClone(config);installReferenceFields(form,{choices,max:20,label:'参考'});
  form.querySelector('#jimeng-binding-config').onchange=e=>{if(e.target.name==='jt-command'){form.jimengConfig=jimengChangedCommand(form.jimengConfig,n.type,e.target.value);form.querySelector('#jimeng-binding-config').innerHTML=jimengStudioFields({mode:n.type,config:form.jimengConfig},esc);}else try{form.jimengConfig=readJimengStudioFields(form,n.type);}catch(error){toast(error.message);}};return true;
 }
 const form=document.querySelector('#jimeng-binding');if(!form.reportValidity())return true;const config=readJimengStudioFields(form,n.type),referenceSources=readReferenceFields(form);if(new Set(referenceSources.map(r=>JSON.stringify(r))).size!==referenceSources.length)throw Error('参考不能重复');
 checkpoint();n.params.studioBinding={mode:n.type,config,includeUpstream:form.elements.includeUpstream.value==='true',referenceSources};for(const key of ['workflowBinding','cloudBinding','imageBinding','llmBinding'])delete n.params[key];changed();await save();document.querySelector('#modal').close();toast('即梦绑定已保存；运行画布前另行确认');return true;
}
