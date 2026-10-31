import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowSourceFieldIssues,assertWorkflowSourceFields,sourceIndexToInput,sourceIndexFromInput} from '../public/workflow-source-fields.js';

function fixture(){
 const template={id:'workflow',inspection:{nodes:[{id:'loader',class_type:'LoadImage',inputs:[{name:'image',type:'string',value:'old.png'}]},{id:'custom',class_type:'VendorLoader',inputs:[{name:'clip',type:'string',value:'old.mp4'}]}]},fields:[{nodeId:'custom',name:'clip',label:'参考视频',control:'text',mediaKind:'video'}]};
 const binding={workflowId:'workflow',imageSources:[{nodeId:'loader',name:'image',sourceNodeId:'group',sourceIndex:5},{nodeId:'custom',name:'clip',assetId:'video'}]};
 return{binding,template};
}

test('正常内置和自定义媒体字段可编辑，来源配置及素材序号完整保留',()=>{
 const {binding,template}=fixture(),before=structuredClone({binding,template});assert.deepEqual(workflowSourceFieldIssues(binding,template),[]);assert.doesNotThrow(()=>assertWorkflowSourceFields(binding,template));assert.deepEqual({binding,template},before);
 for(const index of [0,5,999])assert.equal(sourceIndexFromInput(sourceIndexToInput(index)),index);
 assert.equal(sourceIndexToInput(undefined),'');assert.equal(sourceIndexFromInput(''),undefined);
});

test('改为普通文本的已绑定字段明确阻断，恢复媒体用途后可继续',()=>{
 const {binding,template}=fixture();template.fields.push({nodeId:'loader',name:'image',control:'text',mediaKind:'none'});const before=structuredClone(binding);
 assert.deepEqual(workflowSourceFieldIssues(binding,template),[{nodeId:'loader',name:'image',label:'image',reason:'字段用途已改为普通文本'}]);assert.throws(()=>assertWorkflowSourceFields(binding,template),/#loader image.*普通文本.*原配置已保留/);assert.deepEqual(binding,before);
 template.fields.at(-1).mediaKind='image';assert.deepEqual(workflowSourceFieldIssues(binding,template),[]);assert.equal(binding.imageSources[0].sourceIndex,5);
});

test('隐藏媒体字段仍被完整模板检测到，恢复显示不丢映射或序号',()=>{
 const {binding,template}=fixture();template.fields.push({nodeId:'loader',name:'image',control:'text',mediaKind:'image',exposed:false});template.fields[0].exposed=false;const before=structuredClone(binding),issues=workflowSourceFieldIssues(binding,template);
 assert.equal(issues.length,2);assert.deepEqual(issues.map(issue=>issue.reason),['字段已隐藏','字段已隐藏']);assert.throws(()=>assertWorkflowSourceFields(binding,template),/#loader image.*#custom clip/);assert.deepEqual(binding,before);
 for(const field of template.fields)field.exposed=true;assert.doesNotThrow(()=>assertWorkflowSourceFields(binding,template));assert.equal(sourceIndexToInput(binding.imageSources[0].sourceIndex),'6');
});

test('节点丢失、字段丢失和类型变化均指明原绑定字段',()=>{
 for(const [change,reason] of [[template=>template.inspection.nodes.shift(),'工作流节点已不存在'],[template=>template.inspection.nodes[0].inputs=[],'输入字段已不存在'],[template=>template.inspection.nodes[0].inputs[0].type='number','字段已不是字符串媒体输入']]){
  const {binding,template}=fixture();change(template);const issues=workflowSourceFieldIssues(binding,template);assert.equal(issues[0].nodeId,'loader');assert.equal(issues[0].name,'image');assert.equal(issues[0].reason,reason);assert.throws(()=>assertWorkflowSourceFields(binding,template));assert.equal(binding.imageSources[0].sourceIndex,5);
 }
});

test('检查只针对当前相同工作流，切换模板或首次绑定不会被旧字段误挡',()=>{
 const {binding,template}=fixture();template.id='different-workflow';template.inspection.nodes=[];assert.deepEqual(workflowSourceFieldIssues(binding,template),[]);assert.doesNotThrow(()=>assertWorkflowSourceFields(binding,template));assert.deepEqual(workflowSourceFieldIssues(null,template),[]);assert.doesNotThrow(()=>assertWorkflowSourceFields({workflowId:template.id,imageSources:[]},template));
});

test('素材序号转换明确拒绝缺失必填值、越界和非整数',()=>{
 assert.throws(()=>sourceIndexFromInput(' ',{required:true}),/必须明确/);
 for(const value of ['0','1001','-1','1.5','hello','Infinity'])assert.throws(()=>sourceIndexFromInput(value),/1–1000/);
 for(const value of [-1,1000,1.5,'1',null])assert.throws(()=>sourceIndexToInput(value),/已保存/);
 assert.equal(sourceIndexFromInput(' 6 ',{required:true}),5);
});
