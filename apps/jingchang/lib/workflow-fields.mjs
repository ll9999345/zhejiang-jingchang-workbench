import {inspectWorkflow} from './providers.mjs';
import {userError,assertNoCredentials} from './workspace.mjs';
export const fieldKey=f=>JSON.stringify([f.nodeId,f.name]);
export function normalizeFields(workflow,fields=[]){
 if(!Array.isArray(fields)||fields.length>1000)throw userError('字段设置须为数组，最多1000项');assertNoCredentials(fields);
 const inputs=new Map(inspectWorkflow(workflow).nodes.flatMap(n=>n.inputs.map(f=>[fieldKey({nodeId:n.id,name:f.name}),f]))),seen=new Set(),nativeIds=new Set();
 return fields.map(f=>{
  if(!f||typeof f.nodeId!=='string'||typeof f.name!=='string')throw userError('字段标识无效');const key=fieldKey(f),input=inputs.get(key);if(!input||seen.has(key))throw userError('字段不存在或重复');seen.add(key);
  const allowed={string:['text','textarea','select'],number:['number','slider','select'],boolean:['switch']}[input.type];if(!allowed?.includes(f.control))throw userError('控件与原字段类型不匹配');
  if(Object.hasOwn(f,'mediaKind')){if(input.type!=='string'||!['none','image','video','audio'].includes(f.mediaKind))throw userError('媒体类型只能设置在文字字段上');if(f.mediaKind!=='none'&&f.control==='select')throw userError('媒体字段不能同时使用下拉选项');}
  const label=f.label??f.name;if(typeof label!=='string'||!label.trim()||label.length>120)throw userError('字段名称须为1–120字');const help=f.help??'';if(typeof help!=='string'||help.length>500)throw userError('字段说明最多500字');
  const out={nodeId:f.nodeId,name:f.name,control:f.control,label:label.trim(),help,exposed:f.exposed!==false};
  if(Object.hasOwn(f,'nativeFieldId')){if(typeof f.nativeFieldId!=='string'||!f.nativeFieldId||f.nativeFieldId.length>200||['__proto__','constructor','prototype'].includes(f.nativeFieldId)||nativeIds.has(f.nativeFieldId))throw userError('原生字段编号无效或重复');nativeIds.add(f.nativeFieldId);out.nativeFieldId=f.nativeFieldId;}
  if(Object.hasOwn(f,'mediaKind'))out.mediaKind=f.mediaKind;
  if(f.control==='select'){
   if(!Array.isArray(f.options)||f.options.length<1||f.options.length>200||new Set(f.options).size!==f.options.length||f.options.some(v=>typeof v!==input.type||typeof v==='number'&&!Number.isFinite(v)||typeof v==='string'&&v.length>2000))throw userError('下拉选项须为不重复且与字段同类型的值，最多200项');out.options=[...f.options];
  }
  if(['slider','number'].includes(f.control)){
   for(const k of ['min','max','step'])if(f[k]!==undefined){if(!(out.nativeFieldId&&f[k]===null)&&!Number.isFinite(f[k]))throw userError('数值范围和步长必须为有限数字');out[k]=f[k];}
   if(out.min!=null&&out.max!=null&&out.min>=out.max)throw userError('最小值必须小于最大值');if(out.step!=null&&out.step<=0)throw userError('步长必须大于0');
   if(f.control==='slider'&&[out.min,out.max,out.step].some(v=>v==null))throw userError('滑杆必须配置最小值、最大值和步长');
  }
  if(Object.hasOwn(f,'randomEnabled')){if(typeof f.randomEnabled!=='boolean'||f.randomEnabled&&f.control!=='number')throw userError('只有数字输入控件可以开启随机');if(f.randomEnabled)out.randomEnabled=true;}
  out.defaultValue=Object.hasOwn(f,'defaultValue')?f.defaultValue:input.value;
  checkValue(out,input,out.defaultValue);return out;
 });
}
function checkValue(f,input,value,{random=false}={}){
 if(typeof value!==input.type||typeof value==='number'&&!Number.isFinite(value)||typeof value==='string'&&value.length>200000)throw userError('字段值类型或长度无效：'+f.label);
 if(f.control==='select'&&!f.options.includes(value))throw userError('请选择配置中的选项：'+f.label);
 if(typeof value==='number'&&!random){
  if(f.min!=null&&value<f.min||f.max!=null&&value>f.max)throw userError('数值超出范围：'+f.label);
  if(f.step!=null){const steps=(value-(f.min??0))/f.step;if(Math.abs(steps-Math.round(steps))>1e-7*Math.max(1,Math.abs(steps)))throw userError('数值不符合步长：'+f.label);}
 }
}
export function configuredGraph(template,overrides=[]){
 const graph=structuredClone(template.workflow),fields=normalizeFields(graph,template.fields||[]),map=new Map(fields.map(f=>[fieldKey(f),f]));
 for(const f of fields)graph[f.nodeId].inputs[f.name]=f.defaultValue;
 const seen=new Set();for(const entry of overrides){if(!entry||typeof entry.nodeId!=='string'||typeof entry.name!=='string')throw userError('工作流参数无效');const key=fieldKey(entry),node=Object.hasOwn(graph,entry.nodeId)?graph[entry.nodeId]:null;if(seen.has(key)||!node||!Object.hasOwn(node.inputs,entry.name))throw userError('字段不存在或重复');seen.add(key);const previous=node.inputs[entry.name];if(!['string','number','boolean'].includes(typeof previous)||typeof entry.value!==typeof previous||typeof entry.value==='number'&&!Number.isFinite(entry.value))throw userError('工作流参数类型不匹配');const f=map.get(key);if(f){if(!f.exposed)throw userError('字段已隐藏，请重新配置节点：'+f.label);checkValue(f,{type:typeof previous},entry.value);}node.inputs[entry.name]=entry.value;}
 assertNoCredentials(graph);return graph;
}
export function verifyConfiguredGraph(template,graph,{randomFields=[]}={}){const selected=new Set(randomFields.map(fieldKey));for(const f of normalizeFields(template.workflow,template.fields||[]))checkValue(f,{type:typeof template.workflow[f.nodeId].inputs[f.name]},graph[f.nodeId].inputs[f.name],{random:f.randomEnabled===true&&f.control==='number'&&f.exposed&&selected.has(fieldKey(f))});}
