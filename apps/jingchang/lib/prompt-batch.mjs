import {validateSavedWorkflowRandom} from './workflow-random.mjs';
import {configuredGraph,verifyConfiguredGraph} from './workflow-fields.mjs';
import {comfyMediaField} from '../public/comfy-media.js';
import {userError,assertNoCredentials} from './workspace.mjs';
export function normalizePromptBatch(template,batch){
 if(batch===undefined||batch===null)return null;
 if(!batch||typeof batch!=='object'||typeof batch.nodeId!=='string'||typeof batch.name!=='string'||!Array.isArray(batch.values)||!batch.values.length||batch.values.length>64)throw userError('提示词列表须选择文字字段，并包含1–64项');
 const n=template.workflow?.[batch.nodeId];if(!n||!Object.hasOwn(n.inputs||{},batch.name)||typeof n.inputs[batch.name]!=='string'||comfyMediaField(n.class_type,batch.name,template.fields?.find(f=>f.nodeId===batch.nodeId&&f.name===batch.name)))throw userError('列表只能写入工作流文字字段，不能替代媒体映射');
 if(batch.values.some(v=>typeof v!=='string'||!v.trim()||v.length>32000)||batch.values.reduce((n,v)=>n+v.length,0)>256000)throw userError('每条提示词须为1–32000字，列表合计最多256000字');
 const normalized={nodeId:batch.nodeId,name:batch.name,values:batch.values.map(v=>v.trim())};assertNoCredentials(normalized);
 for(const value of normalized.values)configuredGraph(template,[{nodeId:normalized.nodeId,name:normalized.name,value}]);
 return normalized;
}
export function batchCount(count,batch){if(batch){if(count!==undefined&&count!==batch.values.length)throw userError('列表项数须与批量次数一致');return batch.values.length;}const n=count??1;if(!Number.isInteger(n)||n<1||n>8)throw userError('批量数量须为1–8');return n;}
export function batchGraph(graph,index,batch,increment,randomFields=[]){const result=structuredClone(graph),random=new Set(randomFields.map(f=>JSON.stringify([f.nodeId,f.name])));if(batch)result[batch.nodeId].inputs[batch.name]=batch.values[index];if(increment)for(const [id,n]of Object.entries(result))for(const k of ['seed','noise_seed'])if(!random.has(JSON.stringify([id,k]))&&Number.isSafeInteger(n.inputs?.[k])&&n.inputs[k]>=0){const seed=n.inputs[k]+index;if(!Number.isSafeInteger(seed))throw userError('递增随机种子超出安全整数范围');n.inputs[k]=seed;}return result;}
export function validateBatchGraphs(template,graph,count,batch,increment,randomFields=[]){for(let i=0;i<count;i++)verifyConfiguredGraph(template,batchGraph(graph,i,batch,increment,randomFields),{randomFields});}
export function canResumeGeneration(job){try{validateSavedWorkflowRandom(job);}catch{return false;}if(job.kind!=='comfy'||!['interrupted','cancelled'].includes(job.status))return false;const pending=job.items.find(i=>i.status!=='completed');if(pending)return !!pending.promptId&&pending.status!=='failed';return job.items.length<=job.count&&(!job.imageBindings?.length||job.inputPrepared===true);}
