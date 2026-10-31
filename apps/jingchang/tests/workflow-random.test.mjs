import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowRandomDescriptor,workflowRandomDescriptors,drawWorkflowNumber,materializeWorkflowRandom,applyWorkflowRandom,normalizeRandomSelection} from '../public/workflow-random-core.js';
import {cloudRandomFields,applyCloudRandom} from '../lib/workflow-random.mjs';
const field=(extra={})=>({nodeId:'1',name:'seed',label:'种子',control:'number',randomEnabled:true,...extra});

test('只有已开启且可见的数字输入参与，开关默认开启，显式空选择保持全部固定',()=>{
 const fields=[field(),field({name:'hidden',exposed:false}),field({name:'slider',control:'slider'}),field({name:'select',control:'select'}),field({name:'off',randomActive:false})];
 assert.deepEqual(workflowRandomDescriptors(fields).map(f=>f.name),['seed']);assert.deepEqual(workflowRandomDescriptors(fields,[]),[]);
 assert.equal(workflowRandomDescriptors(fields,[{nodeId:'1',name:'off'}])[0].name,'off');
 for(const name of ['hidden','slider','select','missing'])assert.throws(()=>workflowRandomDescriptors(fields,[{nodeId:'1',name}]),/随机|隐藏/);
 assert.throws(()=>normalizeRandomSelection([{nodeId:'1',name:'seed'},{nodeId:'1',name:'seed'}]),/重复/);assert.throws(()=>normalizeRandomSelection([{nodeId:'1',name:'seed',value:99}]),/标识/);
});
test('固定版整数默认、seed上限、中文/噪声识别和空值转换保持原策略',()=>{
 const seed=workflowRandomDescriptor(field());assert.equal(seed.min,1);assert.equal(seed.max,4294967295);assert.equal(drawWorkflowNumber(seed,()=>0),1);assert.equal(drawWorkflowNumber(seed,()=>1-Number.EPSILON),4294967294);
 const number=workflowRandomDescriptor(field({name:'steps',label:'迭代'}));assert.equal(number.min,0);assert.equal(number.max,999999);assert.equal(drawWorkflowNumber(number,()=>.5),499999);
 for(const name of ['noise_seed','随机数','噪声'])assert.equal(workflowRandomDescriptor(field({name,label:name,max:5e10})).max,4294967295);
 assert.equal(workflowRandomDescriptor(field({min:null,max:null})).min,0);
 assert.equal(workflowRandomDescriptor(field({name:'x',label:'值',min:10,max:2})).max,999999);
 assert.throws(()=>workflowRandomDescriptor(field({min:4294967295})),/范围/);
});
test('浮点按小数位取值而不吸附步长，科学记数法及八位精度按固定版处理',()=>{
 const floating=workflowRandomDescriptor(field({name:'strength',label:'强度',min:0,max:1,step:.25}));assert.equal(drawWorkflowNumber(floating,()=>.3333),.33);
 const scientific=workflowRandomDescriptor(field({name:'value',label:'值',min:0,max:.0001,step:1e-7}));assert.equal(scientific.precision,2);assert.equal(drawWorkflowNumber(scientific,()=>.9),0);
 const tiny=workflowRandomDescriptor(field({name:'x',label:'值',min:0,max:1,step:.123456789}));assert.equal(tiny.precision,8);assert.equal(drawWorkflowNumber(tiny,()=>.123456789),.12345679);
 for(const fraction of [-.1,1,NaN,Infinity])assert.throws(()=>drawWorkflowNumber(floating,()=>fraction),/随机数/);
});
test('每批每字段只选一次，原记录恢复不重选，保存字段范围和实际值',()=>{
 const fields=workflowRandomDescriptors([field({min:0,max:10}),field({name:'steps',label:'步数',min:2,max:6})]);let draws=0;
 const record=materializeWorkflowRandom(fields,2,{draw:()=>[.1,.2,.3,.4][draws++]});assert.equal(draws,4);assert.deepEqual(record.batches.map(b=>b.values.map(f=>f.value)),[[1,2],[3,3]]);
 assert.deepEqual(materializeWorkflowRandom(fields,2,{record,draw:()=>assert.fail('must not redraw')}),record);
 const graph={'1':{class_type:'Sampler',inputs:{seed:9,steps:4,text:'原输入'}}},before=structuredClone(graph),applied=applyWorkflowRandom(graph,record,1);assert.equal(applied['1'].inputs.seed,3);assert.equal(applied['1'].inputs.steps,3);assert.deepEqual(graph,before);
 for(const bad of [{...record,count:1},{...record,fields:[...fields].reverse()},{...record,batches:[{index:0,values:[{nodeId:'1',name:'seed',value:100}]}]}])assert.throws(()=>materializeWorkflowRandom(fields,2,{record:bad}),/原随机/);
 assert.equal(materializeWorkflowRandom([],1,{draw:()=>assert.fail('fixed must not draw')}),null);
});
test('RunningHub普通工作流与Comfy共用数字规则，标准模型和媒体字段不被自动随机',()=>{
 const recipe={kind:'workflow',fields:[{nodeId:'1',fieldName:'seed',type:'number',source:'value',label:'种子',fieldValue:7,randomEnabled:true},{nodeId:'2',fieldName:'image',type:'image',source:'value',fieldValue:'a.png'}]},before=structuredClone(recipe);
 const fields=cloudRandomFields(recipe),record=materializeWorkflowRandom(fields,1,{draw:()=>.5}),next=applyCloudRandom(recipe,record);
 assert.equal(next.fields[0].fieldValue,2147483648);assert.equal(next.fields[1].fieldValue,'a.png');assert.deepEqual(recipe,before);assert.deepEqual(cloudRandomFields({...recipe,kind:'model'}),[]);
});
