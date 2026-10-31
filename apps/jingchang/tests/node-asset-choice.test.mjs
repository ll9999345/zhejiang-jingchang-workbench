import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptsNodeAsset,nodeAssetChoices,nodeAssetHint,canAutoBindImageResult} from '../public/node-asset-choice.js';
import {serviceDisplayText,platformDisplayName,modelDisplayName} from '../public/model-service-labels.js';

const image={id:'picture',name:'湖面.png',type:'image/png'},video={id:'video',name:'video.mp4',type:'video/mp4'};
test('全局图片成为候选但读取候选不虚构关联、不修改项目',()=>{
 const node={id:'output',type:'image',assetId:null},project={nodes:[node],assets:[],edges:[]},before=structuredClone(project);
 assert.deepEqual(nodeAssetChoices(node,project,[image,video]),[image]);assert.deepEqual(project,before);
 assert.match(nodeAssetHint(node,project,[image]),/当前节点暂无图片/);assert.match(nodeAssetHint(node,project,[image]),/选择模型只设置生成方式/);
});
test('当前项目图片去重优先；视频、音频与模型权重不混入图片候选',()=>{
 const node={id:'output',type:'image',assetId:'picture'},project={nodes:[node],assets:[image],edges:[]};
 assert.deepEqual(nodeAssetChoices(node,project,[{...image,name:'全局旧名称'},video,{id:'weights',type:'application/x-safetensors'}]),[image]);
 assert.equal(acceptsNodeAsset(node,video),false);assert.match(nodeAssetHint(node,project),/已关联 湖面.png/);
});
test('历史类型不匹配的绑定仍可见，不悄悄解除或改写素材',()=>{
 const node={id:'output',type:'image',assetId:'video'},project={assets:[video]};
 assert.deepEqual(nodeAssetChoices(node,project),[video]);assert.equal(node.assetId,'video');assert.equal(acceptsNodeAsset(node,video),false);
});
test('只有文字的上游给明确提示；图片上游或图片引用不会被说成只有文字',()=>{
 const node={id:'output',type:'image',assetId:null},text={id:'text',type:'text',text:'湖面'},script={id:'script',type:'script',text:'清晨'},project={nodes:[node,text,script],assets:[],edges:[{source:'script',target:'text'},{source:'text',target:'output'},{source:'output',target:'script'}]};
 assert.match(nodeAssetHint(node,project),/上游只有文字/);
 text.assetId=image.id;project.assets=[image];assert.doesNotMatch(nodeAssetHint(node,project),/上游只有文字/);
 text.assetId=null;text.type='image';assert.doesNotMatch(nodeAssetHint(node,project),/上游只有文字/);
});
test('显示层保留真实模型与 API 地址，只清理服务商标注',()=>{
 const platform={id:'unchanged',name:'喵喵中转站',baseUrl:'https://miaoapi.xyz/v1'},model={id:'gpt-image-2.5-flare',label:'gpt-image-2.5-flare · MiaoAPI'};
 assert.equal(platformDisplayName(platform),'模型服务');assert.equal(modelDisplayName(model),'gpt-image-2.5-flare');
 assert.equal(serviceDisplayText(platform.baseUrl),platform.baseUrl);assert.equal(platform.id,'unchanged');assert.equal(model.id,'gpt-image-2.5-flare');
 assert.equal(modelDisplayName({...model,label:'喵喵API'}),model.id);assert.equal(serviceDisplayText('本机喵喵API配置不可读取'),'本机配置不可读取');
});
test('仅同项目未改节点的完成图片结果可自动绑定，失败和旧目标保持原状态',()=>{
 const node={id:'output',type:'image',text:'湖面',assetId:null,params:{model:'image-model',apiPlatformId:'service'}},project={id:'project',nodes:[node]},job={kind:'image-api',status:'completed',projectId:project.id,target:{id:node.id,text:node.text,assetId:null},input:{model:'image-model',platformId:'service'}};
 assert.equal(canAutoBindImageResult(job,project),true);
 for(const changed of [{status:'failed'},{status:'running'},{applied:true},{projectId:'other-project'}])assert.equal(canAutoBindImageResult({...job,...changed},project),false);
 for(const changed of [{text:'新提示词'},{assetId:'new-image'},{params:{...node.params,model:'new-model'}},{params:{...node.params,apiPlatformId:'other-service'}}])assert.equal(canAutoBindImageResult(job,{...project,nodes:[{...node,...changed}]}),false);
 assert.equal(canAutoBindImageResult(job,{...project,nodes:[]}),false);assert.equal(node.assetId,null);
});
