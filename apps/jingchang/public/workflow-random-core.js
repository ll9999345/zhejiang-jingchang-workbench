export const WORKFLOW_RANDOM_POLICY='infinite-canvas-number-v1';
export const randomFieldKey=field=>JSON.stringify([field.nodeId,field.name??field.fieldName]);
const fail=message=>{throw Error(message);};
export function normalizeRandomSelection(value){
 if(!Array.isArray(value)||value.length>1000)fail('随机字段须为数组，最多1000项');
 const seen=new Set();
 return value.map(field=>{
  if(!field||typeof field.nodeId!=='string'||!field.nodeId||field.nodeId.length>100||typeof field.name!=='string'||!field.name||field.name.length>200||Object.keys(field).some(k=>!['nodeId','name'].includes(k)))fail('随机字段标识无效');
  const key=randomFieldKey(field);if(seen.has(key))fail('随机字段重复');seen.add(key);return{nodeId:field.nodeId,name:field.name};
 });
}
export function workflowRandomDescriptor(field){
 if(field.randomEnabled!==true||field.control!=='number'||field.exposed===false)return null;
 const name=String(field.name??field.fieldName),label=String(field.label||name),seedLike=/seed|noise|随机|噪/i.test(name+' '+label);
 const parsed=value=>Number.isFinite(Number(value))?Number(value):null;
 const lower=parsed(field.min),upper=parsed(field.max),min=lower===null?(seedLike?1:0):lower;
 let max=upper===null||upper<=min?(seedLike?4294967295:999999):upper;
 if(seedLike)max=Math.min(max,4294967295);
 if(!Number.isFinite(min)||!Number.isFinite(max-min)||max<=min)fail('随机范围无效：'+label);
 const step=Number(field.step),isFloat=step>0&&step<1,precision=isFloat?Math.min(8,Math.max(1,String(field.step).split('.')[1]?.length||2)):0;
 return{nodeId:field.nodeId,name,label,min,max,isFloat,precision};
}
export function workflowRandomDescriptors(fields,selection){
 const allowed=fields.map(workflowRandomDescriptor).filter(Boolean),byKey=new Map(allowed.map(field=>[randomFieldKey(field),field]));
 if(selection===undefined)return allowed.filter(field=>fields.find(f=>randomFieldKey(f)===randomFieldKey(field))?.randomActive!==false);
 return normalizeRandomSelection(selection).map(field=>byKey.get(randomFieldKey(field))||fail('字段未开启数字随机或已隐藏：'+field.name));
}
export function drawWorkflowNumber(field,draw=Math.random){
 const fraction=draw();if(!Number.isFinite(fraction)||fraction<0||fraction>=1)fail('随机数来源须返回0至1之间的有限数');
 const value=field.min+(field.max-field.min)*fraction,result=field.isFloat?Number(value.toFixed(field.precision)):Math.floor(value);
 if(!Number.isFinite(result))fail('随机结果不是有限数：'+field.label);return result;
}
function possibleRandomNumber(field,value){
 if(!Number.isFinite(value))return false;
 if(field.isFloat)return Number(value.toFixed(field.precision))===value&&value>=Number(field.min.toFixed(field.precision))&&value<=Number(field.max.toFixed(field.precision));
 return Number.isInteger(value)&&value>=Math.floor(field.min)&&value<=Math.ceil(field.max)-1;
}
export function materializeWorkflowRandom(fields,count,{record,draw=Math.random}={}){
 if(!Number.isInteger(count)||count<1||count>64)fail('随机参数批次数须为1–64');
 if(!Array.isArray(fields)||fields.length>1000||new Set(fields.map(randomFieldKey)).size!==fields.length||fields.some(f=>typeof f.nodeId!=='string'||typeof f.name!=='string'||typeof f.label!=='string'||!Number.isFinite(f.min)||!Number.isFinite(f.max-f.min)||f.max<=f.min||typeof f.isFloat!=='boolean'||!Number.isInteger(f.precision)||f.precision<0||f.precision>8||!f.isFloat&&f.precision!==0))fail('原随机字段范围无效');
 if(!fields.length){if(record!==undefined&&record!==null)fail('原随机记录没有对应字段');return null;}
 if(record!==undefined&&record!==null){
  if(!record||record.version!==1||record.policy!==WORKFLOW_RANDOM_POLICY||record.count!==count||JSON.stringify(record.fields)!==JSON.stringify(fields)||!Array.isArray(record.batches)||record.batches.length!==count)fail('原随机记录与已确认字段范围不一致');
  for(const [index,batch]of record.batches.entries()){
   if(batch.index!==index||!Array.isArray(batch.values)||batch.values.length!==fields.length)fail('原随机批次记录无效');
   for(const [i,entry]of batch.values.entries())if(!entry||randomFieldKey(entry)!==randomFieldKey(fields[i])||Object.keys(entry).some(k=>!['nodeId','name','value'].includes(k))||!possibleRandomNumber(fields[i],entry.value))fail('原随机字段值无效');
  }
  return structuredClone(record);
 }
 return{version:1,policy:WORKFLOW_RANDOM_POLICY,count,fields:structuredClone(fields),batches:Array.from({length:count},(_,index)=>({index,values:fields.map(field=>({nodeId:field.nodeId,name:field.name,value:drawWorkflowNumber(field,draw)}))}))};
}
export function applyWorkflowRandom(graph,record,index){
 const result=structuredClone(graph);if(!record)return result;
 const batch=record.batches[index];if(!batch||batch.index!==index)fail('找不到原随机批次');
 for(const field of batch.values){const node=Object.hasOwn(result,field.nodeId)?result[field.nodeId]:null;if(!node||typeof node.inputs?.[field.name]!=='number')fail('随机字段不再是数字输入：'+field.name);node.inputs[field.name]=field.value;}
 return result;
}
