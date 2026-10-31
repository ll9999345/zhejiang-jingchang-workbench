import test from 'node:test';
import assert from 'node:assert/strict';
import {applyStudioModelChoice,studioModelContract} from '../public/studio-service-core.js';
import {inferStudioModelCategory} from '../public/studio-model-catalog-core.js';
const choice={id:'gpt-image-2.5-flare',platformId:'9ce79a6e-5796-4904-9b05-2f069e046f1a',baseUrl:'https://miaoapi.xyz/v1',platformProtocol:'openai-compatible',category:'image'};
test('从原生或异步图片协议切换已登记兼容图片时移除旧路由参数且不改原对象',()=>{
 const old={protocol:'modelscope',baseUrl:'https://different.example/v1',model:'Qwen/Qwen-Image',imageAsync:true,count:12,quality:'auto',size:'1024x1024',nativeModelscope:{batch:12},unitPrice:.1};const next=applyStudioModelChoice(old,choice);assert.equal(next.model,choice.id);assert.equal(next.baseUrl,choice.baseUrl);assert.equal(next.protocol,'studio');assert.equal(next.imageAsync,false);assert.equal(next.nativeModelscope,undefined);assert.equal(next.count,1);assert.equal(next.unitPrice,.1);assert.equal(old.imageAsync,true);assert.ok(old.nativeModelscope);
});
test('Gemini选择单图原生契约，保留准确ID并重设不支持的图片参数',()=>{
 const next=applyStudioModelChoice({imageAsync:true,count:4,transparent:true,quality:'high'}, {...choice,id:'gemini-2.5-flash-image',platformProtocol:'gemini'});assert.equal(next.protocol,'gemini');assert.equal(next.imageAsync,false);assert.equal(next.count,1);assert.equal(next.transparent,false);assert.equal(next.quality,'auto');assert.equal(next.model,'gemini-2.5-flash-image');
});
test('视频目录分类和未知图片型号不能升级为可调用协议',()=>{
 for(const model of [{...choice,id:'MiniMax-H3',category:'video'},{...choice,id:'seedance-2.0',category:'video'},{...choice,id:'unverified-image'}]){assert.equal(studioModelContract(model).supported,false);assert.throws(()=>applyStudioModelChoice({},model),/接口待核实/);}
});
test('明确H3-Max和Gemini-image型号仅分类，兼容目录名称不能升级为可调用协议',()=>{
 assert.equal(inferStudioModelCategory({id:'MiniMax-H3-Max'}),'video');assert.equal(inferStudioModelCategory({id:'gemini-2.5-flash-image'}),'image');assert.equal(inferStudioModelCategory({id:'MiniMax-H3-Preview'}),null);assert.equal(studioModelContract({...choice,id:'gemini-2.5-flash-image'}).supported,false);assert.equal(studioModelContract({...choice,id:'MiniMax-H3-Max',category:'video'}).supported,false);
});
test('固定服务发现新图片别名时不因名称相似而虚构可调用契约',()=>{
 assert.equal(studioModelContract({...choice,id:'gpt-image-unverified-alias',source:'discovered'}).supported,false);assert.equal(studioModelContract({...choice,id:'dall-e-3',source:'discovered'}).supported,false);assert.equal(studioModelContract({...choice,id:'gpt-image-2.5-sunburst',source:'discovered'}).supported,true);
});
