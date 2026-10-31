import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {makeNode} from '../lib/model.mjs';
import {storeAsset} from '../lib/workspace.mjs';
import {normalizeNativeWorkflow,nativeToFragment} from '../lib/native-canvas-core.mjs';
import {nativeExecutionAncestors,nativeReferencePlan} from '../lib/native-flow-execution.mjs';
import {planNativeApiStep,resolveNativeApiStep} from '../lib/native-api-inputs.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
const raw=(id,type,extra={})=>({id,type,x:0,y:0,...extra});
function wav(){const bytes=Buffer.alloc(1644);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(8000,24);bytes.writeUInt32LE(16000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);return bytes;}
async function fixture(nodes,edges,sourceId,{kind='image-api',count=1}={}){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-native-api-auth-'));
 const oldImage=await storeAsset(data,png,{name:'approved-image.png',type:'image/png'}),oldAudio=await storeAsset(data,wav(),{name:'approved-audio.wav',type:'audio/wav'});
 const resources=[['/old-image',oldImage],['/old-audio',oldAudio]].map(([url,asset])=>({url,asset,archive:'resources/'+asset.id,portableUrl:asset.url}));
 const project=nativeToFragment(normalizeNativeWorkflow({nodes,connections:edges.map(([from,to])=>({from,to}))}),resources,'整组发送授权验证'),node=id=>project.nodes.find(n=>n.params?.nativeCanvas?.node.id===id);
 for(const n of project.nodes)if(n.params?.nativeCanvas?.node.type==='comfy'){n.params.nativeCanvas.adaptation='configured';n.params.workflowBinding={workflowId:'synthetic-workflow',count,overrides:[],imageSources:[]};}
 const target=makeNode(kind==='canvas-llm'?'script':'image',600,0,{text:'查看已确认的参考素材'}),category=kind==='canvas-llm'?'chat':'image';
 const platform={id:'synthetic-platform',name:'仅本机验证',protocol:kind==='canvas-llm'?'gemini':'openai-compatible',baseUrl:'http://127.0.0.1:1/v1',models:[{id:kind==='canvas-llm'?'gemini-test-chat':'image-test',category,referenceSupport:true,audioSupport:true,videoSupport:true}]};
 const binding={platform,model:platform.models[0].id,referenceSources:[{sourceNodeId:node(sourceId).id}],stream:false};
 target.params[kind==='canvas-llm'?'llmBinding':'imageBinding']=binding;project.nodes.push(target);project.edges.push({id:'reference-target',source:node(sourceId).id,target:target.id});
 const addAsset=async(name,type='image/png')=>{const asset=await storeAsset(data,type==='audio/wav'?wav():png,{name,type});project.assets.push(asset);return asset;};
 const plan=async()=>{const step=await planNativeApiStep(kind,{data,project,node:target,binding,parents:nativeExecutionAncestors(project,target.id),text:target.text});step.authorization={origin:'http://127.0.0.1:1',model:binding.model,sendPrompt:true,sendReferences:step.sendAssets,requestLimit:1,budget:1,currency:'CNY',...(step.sendNativeVideo?{sendNativeVideo:true}:{})};return step;};
 const output=(id,assets)=>({nodeId:node(id).id,assetIds:assets.map(a=>a.id),promptItems:[]});
 const noJob=async()=>assert.deepEqual(await fs.readdir(path.join(data,'jobs')).catch(e=>{if(e.code==='ENOENT')return[];throw e;}),[]);
 return{data,project,node,target,binding,oldImage,oldAudio,addAsset,plan,output,noJob};
}

test('嵌套输出只授权自身历史，不能把间接待生成素材伪装为本轮接收结果',async()=>{
 const f=await fixture([raw('g','comfy'),raw('first','output'),raw('last','output',{images:['/old-image']})],[['g','first'],['first','last']],'last');
 const step=await f.plan();assert.deepEqual(step.nativeReferences.details.map(d=>({assetId:d.assetId,pending:d.pending})),[{assetId:f.oldImage.id,pending:undefined}]);
 const fresh=await f.addAsset('fresh.png'),outputs=[f.output('g',[fresh])],resolved=await resolveNativeApiStep(f.data,f.project,step,outputs);
 assert.deepEqual(resolved.image.referenceSources,[{assetId:f.oldImage.id}]);assert.equal(resolved.resolvedReferences[0].name,'approved-image.png');
 // Old plans which promised the indirect generator must fail closed rather
 // than silently spend that allowance on the receiver's historical image.
 const oldPlan=structuredClone(step);oldPlan.nativeReferences.details=[{originNodeId:f.node('last').id,sourceNodeId:f.node('g').id,kind:'image',pending:true,expectedCount:1}];
 await assert.rejects(resolveNativeApiStep(f.data,f.project,oldPlan,outputs),/固定文件或生成来源不一致/);await f.noJob();
});

test('没有自身历史的嵌套输出在任何模型任务之前拒绝参考映射',async()=>{
 const f=await fixture([raw('g','comfy'),raw('first','output'),raw('last','output')],[['g','first'],['first','last']],'last');
 await assert.rejects(f.plan(),/没有可用媒体参考/);await f.noJob();
});

test('LLM固定音频额度不能被声明生成图片的意外音频结果占用',async()=>{
 const f=await fixture([raw('g','comfy'),raw('out','output',{images:['/old-audio']})],[['g','out']],'out',{kind:'canvas-llm'}),step=await f.plan();
 assert.deepEqual(step.nativeReferences.details.map(d=>[d.kind,d.assetId||d.sourceNodeId]),[['image',f.node('g').id],['audio',f.oldAudio.id]]);
 const unexpected=await f.addAsset('unexpected-audio.wav','audio/wav');
 await assert.rejects(resolveNativeApiStep(f.data,f.project,step,[f.output('g',[unexpected])]),/固定文件或生成来源不一致/);
 const expected=await f.addAsset('expected-image.png'),valid=await resolveNativeApiStep(f.data,f.project,step,[f.output('g',[expected])]);
 assert.deepEqual(valid.llm.referenceSources,[{assetId:expected.id},{assetId:f.oldAudio.id}]);
 assert.equal(valid.resolvedReferences[0].producerNodeId,f.node('g').id);assert.equal(valid.resolvedReferences[1].producerNodeId,undefined);await f.noJob();
});

test('同一组内两个生成节点分别核对额度，不能相互借用同类型数量',async()=>{
 const f=await fixture([raw('a','comfy'),raw('b','comfy'),raw('group','smart-group',{items:['a','b']})],[],'group',{count:2}),step=await f.plan();
 const assets=await Promise.all([1,2,3,4].map(i=>f.addAsset('fresh-'+i+'.png')));
 await assert.rejects(resolveNativeApiStep(f.data,f.project,step,[f.output('a',assets.slice(0,3)),f.output('b',assets.slice(3))]),/数量超过已确认范围/);
 const result=await resolveNativeApiStep(f.data,f.project,step,[f.output('a',assets.slice(0,2)),f.output('b',assets.slice(2))]);
 assert.deepEqual(result.image.referenceSources,assets.map(asset=>({assetId:asset.id})));
 assert.deepEqual(result.resolvedReferences.map(item=>item.producerNodeId),[f.node('a').id,f.node('a').id,f.node('b').id,f.node('b').id]);await f.noJob();
});

test('静态分组参考必须保持已确认文件身份，同类型替换也被拒绝',async()=>{
 const f=await fixture([raw('image','image',{url:'/old-image'}),raw('group','group',{items:['image']})],[],'group'),step=await f.plan(),replacement=await f.addAsset('replacement.png');
 const source=f.node('image');source.assetId=replacement.id;source.params.nativeCanvas.mediaAssetIds=[replacement.id];source.params.nativeCanvas.resources.find(r=>r.assetId===f.oldImage.id).assetId=replacement.id;
 await assert.rejects(resolveNativeApiStep(f.data,f.project,step,[]),/固定文件或生成来源不一致/);await f.noJob();
});

test('固定公网参考地址必须与授权清单完全一致，校验自身不访问地址',async()=>{
 const f=await fixture([raw('image','image',{url:'/old-image'}),raw('group','group',{items:['image']})],[],'group');
 const binding={mode:'image',config:{protocol:'studio',baseUrl:'http://127.0.0.1:1/v1',model:'image-test'},referenceSources:[{url:'https://example.invalid/approved.png'}]};
 delete f.target.params.imageBinding;f.target.params.studioBinding=binding;
 const step=await planNativeApiStep('studio',{data:f.data,project:f.project,node:f.target,binding,parents:nativeExecutionAncestors(f.project,f.target.id),text:f.target.text});
 step.authorization={sendReferences:true};
 const allowed=await resolveNativeApiStep(f.data,f.project,step,[]);assert.deepEqual(allowed.studio.referenceSources,[{url:'https://example.invalid/approved.png',type:'image/png'}]);
 const changed=structuredClone(step);changed.studio.referenceSources[0].url='https://example.invalid/replacement.png';
 await assert.rejects(resolveNativeApiStep(f.data,f.project,changed,[]),/固定文件或生成来源不一致/);await f.noJob();
});

test('输出中的直接生成输入覆盖对应种类，间接生成输入不会改变授权清单',async()=>{
 const f=await fixture([raw('indirect','comfy'),raw('first','output'),raw('direct','comfy'),raw('last','output',{images:['/old-audio']})],[['indirect','first'],['first','last'],['direct','last']],'last',{kind:'canvas-llm'}),step=await f.plan();
 assert.deepEqual(step.nativeReferences.details.filter(d=>d.pending).map(d=>d.sourceNodeId),[f.node('direct').id]);
 const indirect=await f.addAsset('indirect.png'),direct=await f.addAsset('direct.png'),outputs=[f.output('indirect',[indirect]),f.output('direct',[direct])];
 const result=await resolveNativeApiStep(f.data,f.project,step,outputs);assert.deepEqual(result.llm.referenceSources,[{assetId:direct.id},{assetId:f.oldAudio.id}]);
 assert.deepEqual(nativeReferencePlan(f.project,f.target,f.binding.referenceSources,{outputs,consumer:'llm'}).details.map(d=>d.name),['direct.png','approved-audio.wav']);await f.noJob();
});
