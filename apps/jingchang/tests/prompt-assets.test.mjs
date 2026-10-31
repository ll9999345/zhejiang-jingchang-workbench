import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {makeProject,validateProject} from '../lib/model.mjs';
import {generationService} from '../lib/generation.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';
import {imageStep} from '../lib/canvas-images.mjs';
import {llmStep} from '../lib/canvas-llm.mjs';
import {studioStep} from '../lib/canvas-studio.mjs';
import {cloudStep} from '../lib/canvas-cloud.mjs';
import {appendPromptAssetSources,PROMPT_ASSET_BYTES_LIMIT,PROMPT_ASSET_LIMIT} from '../lib/prompt-assets.mjs';
import {storeAsset} from '../lib/workspace.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
async function fixture(){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-prompt-assets-'));
 const asset=await storeAsset(data,png,{name:'晨雾参考.png',type:'image/png'});
 const project=makeProject('提示词素材引用');project.assets=[asset];project.nodes[0].text='绘制一幅清晨山景';
 return{data,asset,project};
}

test('提示词素材来源合并时保留已有映射并去重，不修改输入',()=>{
 const original=[{assetId:'fixed-image'},{sourceNodeId:'upstream-image'}],merged=appendPromptAssetSources(original,['fixed-image','mentioned-image','mentioned-image']);
 assert.deepEqual(merged,[{assetId:'fixed-image'},{sourceNodeId:'upstream-image'},{assetId:'mentioned-image'}]);
 assert.deepEqual(original,[{assetId:'fixed-image'},{sourceNodeId:'upstream-image'}]);
});

test('节点@引用图片校验素材归属、图像格式、大小、重复和数量',async()=>{
 const {asset,project}=await fixture(),node=project.nodes[0];
 node.params.promptAssetIds=[asset.id];assert.deepEqual(node.params.promptAssetIds,[asset.id]);
 for(const [metadata,ids] of [
  [{...asset,type:'image/gif'},[asset.id]],
  [{...asset,size:PROMPT_ASSET_BYTES_LIMIT+1},[asset.id]],
  [asset,['foreign-image']],
  [asset,[asset.id,asset.id]],
  [asset,Array.from({length:PROMPT_ASSET_LIMIT+1},(_,i)=>'asset-'+i)],
 ]){
  project.assets=[metadata];node.params.promptAssetIds=ids;
  assert.throws(()=>validateProject(project));
 }
});

test('画布计划把@图片映射到空闲 ComfyUI 图片字段',async()=>{
 const {data,asset,project}=await fixture(),mentioned=await storeAsset(data,Buffer.from(png),{name:'风格参考.png',type:'image/png'}),generation=generationService({data,activeJobs:new Map()}),template=await generation.saveTemplate({name:'图片输入工作流',workflow:{
  '1':{class_type:'LoadImage',inputs:{image:'style.png'}},
  '2':{class_type:'LoadImage',inputs:{image:'character.png'}},
 '3':{class_type:'SaveImage',inputs:{images:['2',0]}},
 },fields:[{nodeId:'1',name:'image',control:'text',label:'输入图一',mediaKind:'image'},{nodeId:'2',name:'image',control:'text',label:'输入图二',mediaKind:'image'}]});
 project.assets.push(mentioned);const node=project.nodes[0];node.params={workflowBinding:{workflowId:template.id,overrides:[],imageSources:[{nodeId:'1',name:'image',assetId:asset.id}],count:1},promptAssetIds:[mentioned.id]};
 const plan=await canvasRunner({data,activeJobs:new Map(),generation}).plan(project);
 assert.equal(plan.length,1);assert.equal(plan[0].imageSources.length,2);
 assert.equal(plan[0].imageSources[0].nodeId,'1');assert.equal(plan[0].imageSources[0].assetId,asset.id);
 assert.equal(plan[0].imageSources[1].nodeId,'2');assert.equal(plan[0].imageSources[1].assetId,mentioned.id);
});

test('画布图片接口计划把@素材纳入本次参考图并保留单次发送授权标记',async()=>{
 const {data,asset,project}=await fixture(),node=project.nodes[0];
 node.params={promptAssetIds:[asset.id],imageBinding:{
  platform:{id:'local-image-platform',name:'本机模拟图片接口',protocol:'openai-compatible',baseUrl:'http://127.0.0.1:1/v1',models:[{id:'test-image',label:'模拟图片模型',category:'image',referenceSupport:true}]},
  model:'test-image',size:'1024x1024',quality:'high',includeUpstream:true,referenceSources:[],
 }};
 const step=await imageStep({data,project,node,binding:node.params.imageBinding,parents:new Set(),text:node.text,promptReferences:node.params.promptAssetIds});
 assert.equal(step.kind,'image-api');assert.deepEqual(step.image.referenceSources,[{assetId:asset.id}]);assert.equal(step.sendAssets,true);
});

test('@图片引用进入多模态语言模型输入',async()=>{
 const {data,asset,project}=await fixture(),node=project.nodes[0];node.type='text';node.title='图片理解';node.params={promptAssetIds:[asset.id]};
 const binding={platform:{id:'local-chat-platform',name:'本机模拟对话接口',protocol:'openai-compatible',baseUrl:'http://127.0.0.1:1/v1',models:[{id:'test-chat',label:'模拟多模态模型',category:'chat',referenceSupport:true}]},model:'test-chat',systemPrompt:'',maxTokens:512,stream:false,includeUpstream:true,referenceSources:[]};
 const step=await llmStep({data,project,node,binding,parents:new Set(),text:node.text,promptReferences:[asset.id]});
 assert.equal(step.kind,'canvas-llm');assert.deepEqual(step.llm.referenceSources,[{assetId:asset.id}]);assert.equal(step.sendAssets,true);
});

test('创作台与RunningHub计划均将@图片变成本地固定图片参考',async()=>{
 const f=await fixture(),node=f.project.nodes[0];node.text='生成带有参考风格的画面';node.params={promptAssetIds:[f.asset.id]};
 const studio=await studioStep({data:f.data,project:f.project,node,binding:{mode:'image',config:{protocol:'studio',baseUrl:'http://127.0.0.1:1/v1',model:'gpt-image-1'},referenceSources:[]},parents:new Set(),text:node.text,promptReferences:[f.asset.id]});
 assert.equal(studio.kind,'studio');assert.deepEqual(studio.studio.referenceSources,[{assetId:f.asset.id}]);assert.equal(studio.sendAssets,true);
 const recipe={id:'recipe-one',projectId:f.project.id,revision:2,name:'本机模拟工作流',kind:'workflow',targetId:'12345',baseUrl:'http://127.0.0.1:4768',fields:[{nodeId:'1',fieldName:'style',fieldValue:'',type:'image',source:'value',label:'风格参考'}]};
 const cloud=await cloudStep({data:f.data,project:f.project,node,binding:{recipeId:recipe.id,recipeRevision:recipe.revision,inputs:[]},parents:new Set(),text:node.text,promptReferences:[f.asset.id],cloudWorkflows:{get:async()=>recipe}});
 assert.equal(cloud.kind,'runninghub');assert.equal(cloud.recipe.fields[0].source,'asset');assert.equal(cloud.recipe.fields[0].assetId,f.asset.id);assert.equal(cloud.sendAssets,true);
});
