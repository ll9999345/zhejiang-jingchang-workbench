import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudSourceFieldsMarkup,cloudSourceFieldIssues,syncCloudSourceControl,readCloudBindingInputs,nativeCloudInputMarkup} from '../public/cloud-source-fields.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const recipe={id:'saved-recipe',fields:[{nodeId:'1',fieldName:'prompt',label:'提示词',type:'text',source:'value'},{nodeId:'2',fieldName:'image',label:'首图',type:'image',source:'value'},{nodeId:'3',fieldName:'video',label:'视频',type:'video',source:'value'}]};
const choices=[{value:'node:group',label:'混合组 <保留>',kinds:['image','video'],grouped:true,dynamic:false},{value:'node:producer',label:'本轮待生成',kinds:['image'],grouped:false,dynamic:true},{value:'node:single',label:'单图',kinds:['image'],grouped:false,dynamic:false}];
function form(value='node:group',index='2'){
 const elements={'cloud-input-0':{value:'text'},'cloud-input-1':{value,selectedOptions:[{dataset:{grouped:String(value==='node:group'),dynamic:String(value==='node:producer')}}]},'cloud-input-2':{value:''},'cloud-source-index-1':{value:index,disabled:true,required:false}},control={hidden:true},hint={textContent:''};
 return{elements,control,hint,querySelector:selector=>selector.includes('hint')?hint:control};
}

test('混合组可分配单媒体字段，序号从0保存为界面1起算且名称安全转义',()=>{
 const binding={recipeId:recipe.id,inputs:[{nodeId:'2',fieldName:'image',sourceNodeId:'group',sourceIndex:3}]};
 const html=cloudSourceFieldsMarkup(recipe,binding,choices,esc);assert.match(html,/value="4"/);assert.match(html,/混合组 &lt;保留&gt;/);assert.match(html,/node:group/);assert.match(html,/data-grouped="true"/);assert.match(html,/每个字段接收一份视频/);
 assert.deepEqual(readCloudBindingInputs(form('node:group','4'),recipe,choices),[{nodeId:'1',fieldName:'prompt',useText:true},{nodeId:'2',fieldName:'image',sourceNodeId:'group',sourceIndex:3}]);
});

test('整组和动态来源要求明确序号，单份可保留旧映射，切换来源清除旧序号',()=>{
 for(const value of ['node:group','node:producer']){const f=form(value,'');syncCloudSourceControl(f,1);assert.equal(f.elements['cloud-source-index-1'].required,true);assert.equal(f.control.hidden,false);assert.throws(()=>readCloudBindingInputs(f,recipe,choices),/必须明确/);}
 const f=form('node:single','');syncCloudSourceControl(f,1);assert.equal(f.elements['cloud-source-index-1'].required,false);assert.equal(readCloudBindingInputs(f,recipe,choices)[1].sourceIndex,undefined);
 f.elements['cloud-source-index-1'].value='3';syncCloudSourceControl(f,1,{reset:true});assert.equal(f.elements['cloud-source-index-1'].value,'');f.elements['cloud-input-1'].value='';syncCloudSourceControl(f,1);assert.equal(f.control.hidden,true);assert.equal(f.elements['cloud-source-index-1'].disabled,true);
});

test('非法序号、已断开来源和错媒体类型不会产生新的绑定',()=>{
 for(const index of ['0','1001','1.1','invalid'])assert.throws(()=>readCloudBindingInputs(form('node:group',index),recipe,choices),/1–1000/);
 assert.throws(()=>readCloudBindingInputs(form('node:missing','1'),recipe,choices),/原绑定已保留/);
 const f=form();f.elements['cloud-input-2'].value='node:single';assert.throws(()=>readCloudBindingInputs(f,recipe,choices),/原绑定已保留/);
});

test('原字段删除、改成LoRA或来源不可用时显示问题，原映射及序号保持完整',()=>{
 const binding={recipeId:recipe.id,inputs:[{nodeId:'2',fieldName:'image',sourceNodeId:'group',sourceIndex:3}]},before=structuredClone(binding);
 for(const change of [r=>r.fields.splice(1,1),r=>r.fields[1].source='lora',r=>r.fields[1].type='text']){const r=structuredClone(recipe);change(r);assert.equal(cloudSourceFieldIssues(binding,r,choices).length,1);}
 assert.equal(cloudSourceFieldIssues(binding,recipe,[]).length,1);assert.match(cloudSourceFieldsMarkup(recipe,binding,[],esc),/原来源已不可用/);assert.deepEqual(binding,before);
});

test('素材发送清单分清固定文件和本轮结果，并显示实际字段与序号',()=>{
 const step={nativeInputs:{fields:[{fieldLabel:'参考一',sourceName:'组 <一>',sourceIndex:1,kind:'image',assetId:'saved-id',name:'已有图片.png'},{fieldLabel:'视频',sourceName:'上游',sourceIndex:0,kind:'video',pendingNodeIds:['producer']}]}},html=nativeCloudInputMarkup(step,esc);
 assert.match(html,/参考一 ← 组 &lt;一&gt; · 图片 · 第 2 份 · 已有图片.png/);assert.match(html,/视频 · 第 1 份 · 本轮待生成/);assert.match(html,/停止后续提交/);assert.equal(nativeCloudInputMarkup({},esc),'');
});
