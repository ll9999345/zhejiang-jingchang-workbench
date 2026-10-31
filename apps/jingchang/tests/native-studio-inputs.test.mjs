import './helpers/local-network-only.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {makeProject,makeNode} from '../lib/model.mjs';
import {storeAsset} from '../lib/workspace.mjs';
import {normalizeStudioBinding,studioStep,studioCredentials} from '../lib/canvas-studio.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
async function fixture(t,{multimodal=false}={}){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-native-studio-inputs-'));
 const project=makeProject('原生素材组创作预检'),group=makeNode('text',0,0,{title:'素材组'}),node=makeNode('video',400,0,{title:'视频创作',text:'围绕参考内容缓慢推进'});
 const images=await Promise.all(['首帧','尾帧'].map(name=>storeAsset(data,png,{type:'image/png',name:name+'.png'})));
 project.nodes=[group,node];project.assets=images;project.edges=[{id:'group-video',source:group.id,target:node.id}];
 const binding=normalizeStudioBinding({mode:'video',config:{protocol:'ark',baseUrl:'http://127.0.0.1:9/v1',model:'doubao-seedance-2-0-260128',arkReferenceMode:multimodal?'multimodal':'frames'},referenceSources:[{sourceNodeId:group.id}]});
 node.params.studioBinding=structuredClone(binding);let sends=0;t.mock.method(globalThis,'fetch',async()=>{sends++;throw Error('此预检测试禁止网络发送');});
 return {data,project,group,node,images,binding,parents:new Set([group.id]),text:node.text,get sends(){return sends;}};
}

test('原生组展开的两张固定图参与首尾帧预检，保存的组映射保持原样',async t=>{
 const f=await fixture(t),original=structuredClone(f.binding),nativeReferences=f.images.map(a=>({assetId:a.id}));
 const step=await studioStep({...f,nativeReferences});
 assert.equal(step.sendAssets,true);assert.deepEqual(step.studio.referenceSources,[{sourceNodeId:f.group.id}]);assert.deepEqual(f.binding,original);assert.deepEqual(nativeReferences,f.images.map(a=>({assetId:a.id})));assert.equal(f.sends,0);
 await assert.rejects(studioStep(f),/相连的上游媒体节点/,'未传展开值时，原组映射不能被当成首张图');
 await assert.rejects(studioStep({...f,nativeReferences:[{assetId:'foreign-asset'}]}),/不属于当前项目/);assert.equal(f.sends,0);
});

test('待生成整组数量在首尾帧和多素材上限检查中完整展开，超额零发送',async t=>{
 for(const [multimodal,count,error] of [[false,3,/首尾帧/],[true,10,/数量超过 9/]]){
  const f=await fixture(t,{multimodal});f.group.type='image';f.group.params.workflowBinding={workflowId:'local-synthetic-workflow'};
  await assert.rejects(studioStep({...f,nativeReferences:[{sourceNodeId:f.group.id,expectedCount:count}]}),error);
  const accepted=await studioStep({...f,nativeReferences:[{sourceNodeId:f.group.id,expectedCount:2}]});assert.equal(accepted.sendAssets,true);assert.deepEqual(accepted.studio.referenceSources,f.binding.referenceSources);assert.equal(f.sends,0);
 }
});

test('待生成数量、媒体来源和原始映射均不能通过展开参数绕过校验',async t=>{
 const f=await fixture(t);f.group.type='image';f.group.params.workflowBinding={workflowId:'local-synthetic-workflow'};
 for(const expectedCount of [0,65,1.5,'2'])await assert.rejects(studioStep({...f,nativeReferences:[{sourceNodeId:f.group.id,expectedCount}]}),/1–64/);
 await assert.rejects(studioStep({...f,nativeReferences:[{assetId:f.images[0].id,expectedCount:2}]}),/1–64/);
 await assert.rejects(studioStep({...f,nativeReferences:[{sourceNodeId:f.group.id,assetId:f.images[0].id}]}),/映射无效/);
 await assert.rejects(studioStep({...f,parents:new Set(),nativeReferences:[{sourceNodeId:f.group.id,expectedCount:2}]}),/相连的上游/);
 await assert.rejects(studioStep({...f,nativeReferences:[{url:'http://127.0.0.1:9/private.png'}]}),/公网|本机/);
 delete f.group.params.workflowBinding;f.group.assetId=f.images[0].id;await assert.rejects(studioStep({...f,nativeReferences:[{sourceNodeId:f.group.id,expectedCount:2}]}),/只能用于已配置/);
 assert.equal(f.sends,0);
});

test('展开后的原视频音频仍须单独授权，动态音频不会丢失原文件发送标志',async t=>{
 const f=await fixture(t,{multimodal:true}),refs=[{url:'asset://synthetic-video',type:'video/mp4'},{url:'asset://synthetic-audio',type:'audio/wav'}];
 const step=await studioStep({...f,nativeReferences:refs});assert.equal(step.sendOriginalMedia,true);assert.equal(step.sendAssets,true);assert.deepEqual(step.referenceInputs,[]);assert.deepEqual(step.studio.referenceSources,f.binding.referenceSources);
 const body=sendOriginalMedia=>({studioCredentials:[{nodeId:f.node.id,apiKey:'synthetic-native-studio-key',authorization:{origin:'http://127.0.0.1:9',model:step.studio.config.model,sendPrompt:true,sendReferences:true,sendOriginalMedia,requestLimit:1,budget:1,currency:'CNY'}}]});
 assert.throws(()=>studioCredentials([structuredClone(step)],body(false)),/单独确认/);const authorized=structuredClone(step);studioCredentials([authorized],body(true));assert.equal(authorized.authorization.sendOriginalMedia,true);
 f.group.type='audio';f.group.params.workflowBinding={workflowId:'local-synthetic-audio'};
 const pending=await studioStep({...f,nativeReferences:[refs[0],{sourceNodeId:f.group.id,expectedCount:2}]});assert.equal(pending.sendOriginalMedia,true);assert.deepEqual(pending.referenceInputs,[]);
 assert.equal(f.sends,0);
});

test('展开的方舟本机音频保留内容指纹，文件被替换仍在发送前拒绝',async t=>{
 const f=await fixture(t,{multimodal:true});
 const bytes=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','2','-c:a','pcm_s16le','-f','wav','pipe:1']);
 const audio=await storeAsset(f.data,bytes,{type:'audio/wav',name:'本机合成参考.wav'});f.project.assets.push(audio);
 const nativeReferences=[{url:'asset://synthetic-video',type:'video/mp4'},{assetId:audio.id}],step=await studioStep({...f,nativeReferences});
 assert.equal(step.sendOriginalMedia,true);assert.equal(step.referenceInputs.length,1);assert.equal(step.referenceInputs[0].assetId,audio.id);assert.equal(step.referenceInputs[0].sourceSha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(step.referenceInputs[0].verified,true);assert.equal(step.referenceInputs[0].duration,2);
 await fs.writeFile(path.join(f.data,'assets',audio.id),Buffer.alloc(bytes.length));await assert.rejects(studioStep({...f,nativeReferences}),/无法读取|解码失败/);assert.equal(f.sends,0);
});
