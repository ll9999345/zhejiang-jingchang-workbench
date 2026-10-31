import {workflowRandomDescriptors,materializeWorkflowRandom,normalizeRandomSelection,randomFieldKey} from '../public/workflow-random-core.js';
import {userError} from './workspace.mjs';
const checked=fn=>{try{return fn();}catch(error){throw userError(error.message);}};
export const checkedRandomSelection=value=>checked(()=>normalizeRandomSelection(value));
export const comfyRandomFields=(template,selection)=>checked(()=>workflowRandomDescriptors(template.fields||[],selection));
export const cloudRandomFields=(recipe,selection)=>checked(()=>workflowRandomDescriptors(recipe.kind==='model'?[]:recipe.fields.map(field=>({...field,name:field.fieldName,control:field.type==='number'&&field.source==='value'?'number':null})),selection));
export const chooseWorkflowRandom=(fields,count,options)=>checked(()=>materializeWorkflowRandom(fields,count,options));
export function validateSavedWorkflowRandom(job){
 if(!job.workflowRandom){if(job.randomFields?.length)throw userError('原随机参数记录缺失');return;}
 const fields=job.workflowRandom.fields;
 if(JSON.stringify(job.randomFields)!==JSON.stringify(fields?.map(({nodeId,name})=>({nodeId,name}))))throw userError('原随机字段选择不一致');
 chooseWorkflowRandom(fields,job.count,{record:job.workflowRandom});
}
export function applyCloudRandom(recipe,record){
 if(!record)return structuredClone(recipe);
 return checked(()=>{
  const expected=cloudRandomFields(recipe,record.fields.map(({nodeId,name})=>({nodeId,name})));materializeWorkflowRandom(expected,1,{record});
  const values=new Map(record.batches[0].values.map(field=>[randomFieldKey(field),field.value]));
  return{...structuredClone(recipe),fields:recipe.fields.map(field=>values.has(randomFieldKey(field))?{...field,fieldValue:values.get(randomFieldKey(field))}:structuredClone(field))};
 });
}
export function validateSavedCloudRandom(job){
 const recipe=job.input.recipe,selection=job.randomFields??job.workflowRandom?.fields?.map(({nodeId,name})=>({nodeId,name}))??(recipe.minimaxProfile==='h3'?[]:undefined),fields=cloudRandomFields(recipe,selection);
 if(fields.length&&!job.workflowRandom)throw userError('原云随机参数记录缺失');
 if(job.workflowRandom)chooseWorkflowRandom(fields,1,{record:job.workflowRandom});
}
