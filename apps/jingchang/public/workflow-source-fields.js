import {comfyMediaField} from './comfy-media.js';

// Inspect the complete template, including hidden inputs. Rendering only the
// editable fields must never discard a previously saved source mapping.
export function workflowSourceFieldIssues(binding,template){
 if(!binding||binding.workflowId!==template?.id)return[];
 const nodes=new Map((template.inspection?.nodes||[]).map(node=>[node.id,node]));
 return(binding.imageSources||[]).flatMap(source=>{
  const node=nodes.get(source.nodeId),input=node?.inputs?.find(input=>input.name===source.name),config=template.fields?.find(field=>field.nodeId===source.nodeId&&field.name===source.name);
  let reason='';
  if(!node)reason='工作流节点已不存在';
  else if(!input)reason='输入字段已不存在';
  else if(config?.exposed===false)reason='字段已隐藏';
  else if(input.type!=='string')reason='字段已不是字符串媒体输入';
  else if(!comfyMediaField(node.class_type,input.name,config))reason='字段用途已改为普通文本';
  return reason?[{nodeId:source.nodeId,name:source.name,label:config?.label||input?.name||source.name,reason}]:[];
 });
}

export function assertWorkflowSourceFields(binding,template){
 const issues=workflowSourceFieldIssues(binding,template);
 if(issues.length)throw Error('原绑定的素材字段不可编辑：'+issues.map(issue=>`#${issue.nodeId} ${issue.name}（${issue.reason}）`).join('；')+'。原配置已保留，请在“设置字段表单”恢复字段显示和媒体用途后继续。');
}

export function sourceIndexToInput(index){
 if(index===undefined)return'';
 if(!Number.isSafeInteger(index)||index<0||index>999)throw Error('已保存的来源素材序号无效');
 return String(index+1);
}

export function sourceIndexFromInput(value,{required=false}={}){
 const text=String(value??'').trim();
 if(!text){if(required)throw Error('整组或待生成来源必须明确填写素材序号');return undefined;}
 const index=Number(text);if(!Number.isSafeInteger(index)||index<1||index>1000)throw Error('来源素材序号须为 1–1000 的整数');
 return index-1;
}
