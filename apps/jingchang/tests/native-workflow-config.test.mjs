import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {importNativeComfyFields,importNativeRhFields,normalizeCloudOverrides} from '../lib/native-workflow-config.mjs';
import {nativeComfyParameters,nativeRhParameters,nativeWorkflowSettings} from '../public/native-workflow-config.js';
import {normalizeNativeWorkflow,nativeToFragment,fragmentToNative} from '../lib/native-canvas-core.mjs';
import {validateProject} from '../lib/model.mjs';
import {nativeCanConfigure,nativeNodeIssues} from '../public/native-canvas-core.js';
import {randomFixture} from './helpers/workflow-random-fixture.mjs';
import {nativeGraph,nativeConfig,nativeRhConfig,ordinaryComfy,ordinaryRh} from './helpers/native-workflow-config-fixture.mjs';
const node=source=>nativeToFragment(normalizeNativeWorkflow({nodes:[source],connections:[]}),[],'原生参数').nodes[0];
const template=()=>({fields:importNativeComfyFields(nativeGraph,nativeConfig)});
test('原生配置按编号和目标唯一映射，保留NULL默认语义、控件、类型、隐藏原值',()=>{
 const before=structuredClone([nativeGraph,nativeConfig]),fields=template().fields;
 assert.equal(fields[0].nativeFieldId,'seed-field');assert.deepEqual([fields[0].min,fields[0].max,fields[0].step],[null,null,null]);assert.equal(fields[0].randomEnabled,true);
 assert.equal(fields[6].control,'slider');assert.equal(fields[6].randomEnabled,undefined);assert.deepEqual(fields[4].options,[1,2,3]);assert.equal(fields[4].defaultValue,2);assert.equal(fields[5].mediaKind,'image');assert.equal(fields[7].exposed,false);assert.equal(fields[7].defaultValue,42);assert.deepEqual([nativeGraph,nativeConfig],before);
});
test('缺省和NULL默认值按原表单补零、空文字、关闭，不借用图中非零值',()=>{
 const c=structuredClone(nativeConfig);for(const f of c.fields.slice(0,4))f.default=null;
 const fields=importNativeComfyFields(nativeGraph,c);assert.deepEqual(fields.slice(0,4).map(f=>f.defaultValue),[0,0,'',false]);
});
const badConfigs=[['缺编号',c=>delete c.fields[0].id],['重复编号',c=>c.fields[1].id=c.fields[0].id],['重复目标',c=>{c.fields[1].node='1';c.fields[1].input='seed';}],['不存在目标',c=>c.fields[0].input='absent'],['错误控件',c=>c.fields[0].type='text'],['无效随机能力',c=>c.fields[0].random_enabled='true'],['无效下拉',c=>c.fields[4].options=['2','2']],['无效范围',c=>c.fields[1].min=2]];
for(const [label,mutate]of badConfigs)test('原生配置拒绝'+label+'，不修改原图',()=>{const c=structuredClone(nativeConfig),before=structuredClone(nativeGraph);mutate(c);assert.throws(()=>importNativeComfyFields(nativeGraph,c));assert.deepEqual(nativeGraph,before);});
test('凭据、不支持键和超大原生配置拒绝；不写配置或执行代码',()=>{
 for(const extra of [{apiKey:'synthetic-rejected'},JSON.parse('{"constructor":{"invalid":true}}'),{long:'x'.repeat(200001)}])assert.throws(()=>importNativeComfyFields(nativeGraph,{...nativeConfig,...extra}));
});
test('普通Comfy原值按field.id恢复；关闭随机保留固定值；媒体标识仅列出待核对',()=>{
 const n=node(ordinaryComfy),before=structuredClone(n),plan=nativeComfyParameters(n,template());assert.deepEqual(plan.issues,[]);assert.deepEqual(plan.randomFields,[]);assert.deepEqual(plan.overrides.map(f=>f.value),[12,.75,'原节点文字',true,3]);assert.equal(plan.skippedMedia[0].id,'media-field');assert.deepEqual(n,before);const p=nativeToFragment(normalizeNativeWorkflow({nodes:[ordinaryComfy],connections:[]}),[],'原件');assert.deepEqual(fragmentToNative(p,[]).nodes[0].comfyParams,ordinaryComfy.comfyParams);
});
test('未知编号和随机能力冲突保留原记录，不猜测field.name',()=>{
 const n=node({...ordinaryComfy,comfyParams:{seed:999},comfyRandomActive:{'slider-field':true}}),plan=nativeComfyParameters(n,template());assert.match(plan.issues.join(''),/尚未映射/);assert.match(plan.issues.join(''),/能力与模板不符/);const noAlias=nativeComfyParameters(n,{fields:[]});assert.match(noAlias.issues.join(''),/不能猜测/);assert.equal(n.params.nativeCanvas.node.comfyParams.seed,999);
});
test('智能素材使用runSettings及旧comfy_params；整数按原智能画布取整，浮点不吸附',()=>{
 const n=node({id:'smart',type:'smart-image',x:0,y:0,runSettings:{engine:'comfy',comfyWorkflow:'custom.json',comfy_params:{'seed-field':12.7,'gain-field':.75},comfyRandomActive:{'seed-field':false,'gain-field':false}}});assert.ok(nativeCanConfigure(n));const plan=nativeComfyParameters(n,template());assert.deepEqual(plan.issues,[]);assert.equal(plan.overrides[0].value,13);assert.equal(plan.overrides[1].value,.75);assert.equal(nativeWorkflowSettings(n,'runninghub'),null);n.params.nativeCanvas.adaptation='configured';n.params.workflowBinding={workflowId:'local-workflow',overrides:plan.overrides,imageSources:[],randomFields:[]};const p=nativeToFragment(normalizeNativeWorkflow({nodes:[{id:'smart',type:'smart-image',x:0,y:0,runSettings:{engine:'comfy'}}],connections:[]}),[],'智能');p.nodes=[n];validateProject(p);assert.deepEqual(nativeNodeIssues(n,p),[]);
});
test('云字段配置本地导入保留数字、布尔、LIST index选项；SLIDER固定',()=>{
 const fields=importNativeRhFields(nativeRhConfig);assert.equal(fields[0].fieldValue,10);assert.equal(fields[0].randomEnabled,true);assert.equal(fields[2].fieldValue,true);assert.deepEqual(fields[3].options,['1','2','3']);assert.equal(fields[5].randomEnabled,undefined);assert.equal(fields[4].type,'image');
});
test('RunningHub原节点使用双冒号键，数字和开关恢复；媒体标识不成为本机素材',()=>{
 const fields=importNativeRhFields(nativeRhConfig),n=node(ordinaryRh),before=structuredClone(n),recipe={kind:'app',fields},plan=nativeRhParameters(n,recipe);assert.deepEqual(plan.issues,[]);assert.deepEqual(plan.overrides.map(f=>f.fieldValue),[12,.75,false,'3']);assert.deepEqual(plan.randomFields,[{nodeId:'1',name:'strength'}]);assert.equal(plan.skippedMedia[0].id,'1::image');assert.deepEqual(n,before);
 const wrong=nativeRhParameters(node({...ordinaryRh,rhParams:{'1:seed':{value:100}}}),recipe);assert.match(wrong.issues.join(''),/尚未映射/);assert.equal(nativeRhParameters(n,{...recipe,kind:'model'}),null);
});
test('云固定值仅能覆盖普通值字段；拒绝重复、缺失、素材和选项失配',()=>{
 const recipe={kind:'app',fields:importNativeRhFields(nativeRhConfig)};assert.deepEqual(normalizeCloudOverrides([{nodeId:'1',fieldName:'seed',fieldValue:12}],recipe),[{nodeId:'1',fieldName:'seed',fieldValue:12}]);
 for(const overrides of [[{nodeId:'1',fieldName:'image',fieldValue:'wrong.png'}],[{nodeId:'1',fieldName:'absent',fieldValue:1}],[{nodeId:'1',fieldName:'mode',fieldValue:'4'}],[{nodeId:'1',fieldName:'seed',fieldValue:''}],[{nodeId:'1',fieldName:'seed',fieldValue:false}],[{nodeId:'1',fieldName:'enabled',fieldValue:'not-a-switch'}],[{nodeId:'1',fieldName:'seed',fieldValue:1},{nodeId:'1',fieldName:'seed',fieldValue:2}]])assert.throws(()=>normalizeCloudOverrides(overrides,recipe));assert.throws(()=>normalizeCloudOverrides([{nodeId:'1',fieldName:'seed',fieldValue:1}],{...recipe,kind:'model'}));
});
test('字段预览不写模板；明确保存保留旧修订并执行乐观锁，失败无新增修订',async t=>{
 const f=await randomFixture(t),old=await f.generation.saveTemplate({name:'原生字段修订样本',workflow:nativeGraph}),before=await fs.readFile(path.join(f.data,'workflows',old.id+'.json'));
 const preview=await f.generation.previewNativeConfig({workflowId:old.id,nativeConfig});assert.equal(preview.persisted,false);assert.equal(preview.fields[0].nativeFieldId,'seed-field');assert.deepEqual(await fs.readFile(path.join(f.data,'workflows',old.id+'.json')),before);
 const next=await f.generation.configure(old.id,{revision:0,nativeConfig});assert.equal(next.revision,1);const history=await fs.readdir(path.join(f.data,'workflows','history',old.id));assert.equal(history.length,1);assert.equal(JSON.parse(await fs.readFile(path.join(f.data,'workflows','history',old.id,history[0]))).fields.length,0);
 await assert.rejects(f.generation.configure(old.id,{revision:0,nativeConfig}),e=>e.status===409);await assert.rejects(f.generation.configure(old.id,{revision:1,nativeConfig,fields:[]}),/不能同时/);assert.equal((await f.generation.template(old.id)).revision,1);assert.equal(f.state.prompts.length,0);
});
