import {nativeComfyFields,nativeRhFields} from '../public/native-workflow-config.js';
import {inspectWorkflow} from './providers.mjs';
import {normalizeFields} from './workflow-fields.mjs';
import {normalizeRhFields} from './runninghub.mjs';
import {assertNoCredentials,userError} from './workspace.mjs';

function checkedConfig(value) {
 assertNoCredentials(value);
 if (JSON.stringify(value)?.length>200000) throw userError('原生字段配置最多200KB');
 function walk(value,depth=0) {
  if (depth>30) throw userError('原生字段配置嵌套过深');
  if (!value || typeof value!=='object') return;
  for (const [key,child] of Object.entries(value)) {if (['__proto__','constructor','prototype'].includes(key)) throw userError('原生字段配置含不支持的键');walk(child,depth+1);}
 }
 walk(value);return value;
}
export function importNativeComfyFields(workflow,config) {
 checkedConfig(config);
 try {return normalizeFields(workflow,nativeComfyFields(inspectWorkflow(workflow),config));}catch(error){if(error.status)throw error;throw userError(error.message);}
}
export function importNativeRhFields(config) {
 checkedConfig(config);
 try {return normalizeRhFields(nativeRhFields(config));}catch(error){if(error.status)throw error;throw userError(error.message);}
}
export function normalizeCloudOverrides(value=[],recipe) {
 assertNoCredentials(value);
 if (!Array.isArray(value) || value.length>200) throw userError('云节点固定参数最多200项');
 if (value.length && recipe && (recipe.kind==='model'||recipe.minimaxProfile==='h3')) throw userError('标准模型与H3使用专用参数，不支持普通字段覆盖');
 const seen=new Set();
 return value.map(item=>{
  if (!item || typeof item.nodeId!=='string' || !/^[\w-]{1,100}$/.test(item.nodeId) || typeof item.fieldName!=='string' || !/^[-\w.]{1,100}$/.test(item.fieldName)) throw userError('云节点固定字段标识无效');
  const key=item.nodeId+':'+item.fieldName;
  if (seen.has(key)) throw userError('云节点固定字段重复');seen.add(key);
  if (!['string','number','boolean'].includes(typeof item.fieldValue) || typeof item.fieldValue==='number'&&!Number.isFinite(item.fieldValue) || typeof item.fieldValue==='string'&&item.fieldValue.length>20000) throw userError('云节点固定字段值无效');
  const target=recipe?.fields.find(field=>field.nodeId===item.nodeId&&field.fieldName===item.fieldName);
  if (recipe && (!target || target.source!=='value' || ['image','video','audio'].includes(target.type))) throw userError('云节点覆盖仅用于现有的普通值字段');
  if (target?.type==='number' && (!['number','string'].includes(typeof item.fieldValue) || String(item.fieldValue).trim()==='' || !Number.isFinite(Number(item.fieldValue)))) throw userError('云节点固定数值类型不符');
  if (target?.type==='boolean' && ![true,false,'true','false'].includes(item.fieldValue)) throw userError('云节点固定开关类型不符');
  if (target) normalizeRhFields([{...target,fieldValue:item.fieldValue}]);
  return {nodeId:item.nodeId,fieldName:item.fieldName,fieldValue:item.fieldValue};
 });
}
