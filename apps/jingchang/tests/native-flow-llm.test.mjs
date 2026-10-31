import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {makeProject,makeNode} from '../lib/model.mjs';
import {storeAsset} from '../lib/workspace.mjs';
import {llmStep,llmCredentials} from '../lib/canvas-llm.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
const syntheticKey='synthetic-native-llm-key';
function binding(protocol='openai-compatible'){
 const model=protocol==='gemini'?'gemini-test-chat':'chat-test';
 return {platform:{id:'local-plan-platform',name:'本机预检',protocol,baseUrl:'http://127.0.0.1:1/v1',models:[{id:model,category:'chat',referenceSupport:true,...(protocol==='gemini'?{audioSupport:true,videoSupport:true}:{})}]},model,referenceSources:[],stream:false};
}
async function fixture(protocol='openai-compatible'){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-native-llm-plan-'));
 const project=makeProject('整组语言模型预检'),node=makeNode('script',400,0,{text:'解读参考素材'}),group=makeNode('script',0,0,{text:'素材分组'});
 const b=binding(protocol);b.referenceSources=[{sourceNodeId:group.id}];
 project.nodes=[group,node];project.edges=[{id:'group-llm',source:group.id,target:node.id}];project.assets=[];
 const parents=new Set([group.id]);
 const addAsset=async(bytes=png,type='image/png',name='reference.png')=>{const a=await storeAsset(data,bytes,{type,name});project.assets.push(a);return a;};
 const pending=kind=>{const n=makeNode(kind,0,200,{text:'上游生成'});n.params.workflowBinding={workflowId:'local-workflow',count:1};project.nodes.push(n);parents.add(n.id);return n;};
 const plan=(nativeReferences,extra={})=>llmStep({data,project,node,binding:b,parents,text:node.text,nativeReferences,...extra});
 return {data,project,node,group,b,parents,addAsset,pending,plan};
}
function wav(){const samples=800,bytes=Buffer.alloc(44+samples*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(8000,24);bytes.writeUInt32LE(16000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);return bytes;}

test('整组已展开素材逐项预检并保留顺序与原始分组映射',async()=>{
 const f=await fixture(),first=await f.addAsset(),second=await f.addAsset(png,'image/png','second.png'),original=structuredClone(f.b);
 const step=await f.plan([{assetId:second.id},{assetId:first.id}]);
 assert.deepEqual(step.llm.referenceSources,[{sourceNodeId:f.group.id}]);
 assert.deepEqual(step.referenceDetails.map(r=>r.assetId),[second.id,first.id]);
 assert.deepEqual(step.referenceDetails.map(r=>r.kind),['image','image']);
 assert.equal(step.sendAssets,true);assert.deepEqual(f.b,original);
 await assert.rejects(fs.stat(path.join(f.data,'jobs')),e=>e.code==='ENOENT');
});

test('待生成图片按预计整组数量计限额，不能以单节点绕过8张上限',async()=>{
 const f=await fixture(),source=f.pending('image'),asset=await f.addAsset();
 let step=await f.plan([{sourceNodeId:source.id,expectedCount:8}]);
 assert.equal(step.referenceDetails[0].expectedCount,8);
 assert.equal(step.referenceDetails.length,1);assert.deepEqual(step.llm.referenceSources,[{sourceNodeId:f.group.id}]);
 await assert.rejects(f.plan([{sourceNodeId:source.id,expectedCount:9}]),/最多8张/);
 await assert.rejects(f.plan([{assetId:asset.id},{sourceNodeId:source.id,expectedCount:8}]),/最多8张/);
 step=await f.plan([{assetId:asset.id},{sourceNodeId:source.id,expectedCount:7}]);
 assert.equal(step.referenceDetails.length,2);assert.equal(step.referenceDetails[1].expectedCount,7);
});

test('整组待生成数量只接受1到64整数且只能用于已绑定上游节点',async()=>{
 const f=await fixture(),source=f.pending('image'),asset=await f.addAsset();
 for(const expectedCount of [0,-1,1.5,65,'2',null])await assert.rejects(f.plan([{sourceNodeId:source.id,expectedCount}]),/展开参考素材映射无效/);
 await assert.rejects(f.plan([{assetId:asset.id,expectedCount:2}]),/展开参考素材映射无效/);
 delete source.params.workflowBinding;source.assetId=asset.id;
 await assert.rejects(f.plan([{sourceNodeId:source.id,expectedCount:1}]),/已绑定/);
 source.params.workflowBinding={workflowId:'local-workflow'};f.parents.delete(source.id);
 await assert.rejects(f.plan([{sourceNodeId:source.id,expectedCount:1}]),/相连上游/);
});

test('音频与原视频整组限额及能力在任何执行前校验',async()=>{
 const f=await fixture('gemini'),audio=f.pending('audio'),video=f.pending('video');f.b.videoInputMode='native';
 await assert.rejects(f.plan([{sourceNodeId:audio.id,expectedCount:2}]),/最多8张/);
 await assert.rejects(f.plan([{sourceNodeId:video.id,expectedCount:4}]),/最多8张/);
 const step=await f.plan([{sourceNodeId:audio.id,expectedCount:1},{sourceNodeId:video.id,expectedCount:3}]);
 assert.equal(step.sendNativeVideo,true);assert.equal(step.audioReferences.length,1);
 assert.deepEqual(step.referenceDetails.map(r=>[r.kind,r.expectedCount]),[['audio',1],['video',3]]);
 f.b.platform.models[0].audioSupport=false;
 await assert.rejects(f.plan([{sourceNodeId:audio.id,expectedCount:1}]),/音频理解/);
});

test('整组静态视频生成受保护预览，原视频发送仍需独立授权',async()=>{
 const f=await fixture('gemini');f.b.videoInputMode='native';
 const movie=path.join(f.data,'synthetic.mp4');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=black:s=64x64:r=1','-t','1','-c:v','libx264','-pix_fmt','yuv420p',movie]);
 const video=await f.addAsset(await fs.readFile(movie),'video/mp4','synthetic.mp4'),audio=await f.addAsset(wav(),'audio/wav','synthetic.wav'),image=await f.addAsset();
 const step=await f.plan([{assetId:video.id},{assetId:audio.id},{assetId:image.id}]);
 assert.deepEqual(step.referenceDetails.map(r=>r.kind),['video','audio','image']);
 assert.equal(step.videoSamples.length,0);assert.equal(step.nativeVideos.length,1);
 assert.equal(step.nativeVideos[0].assetId,video.id);assert.match(step.nativeVideos[0].sourceSha256,/^[a-f0-9]{64}$/);
 assert.equal(step.audioReferences[0].assetId,audio.id);assert.equal(step.sendNativeVideo,true);
 const authorization={origin:'http://127.0.0.1:1',model:step.llm.model,sendPrompt:true,sendReferences:true,requestLimit:1,budget:1,currency:'CNY'};
 assert.throws(()=>llmCredentials([step],{llmCredentials:[{nodeId:step.nodeId,apiKey:syntheticKey,authorization}]}),/原视频/);
 assert.equal(llmCredentials([step],{llmCredentials:[{nodeId:step.nodeId,apiKey:syntheticKey,authorization:{...authorization,sendNativeVideo:true}}]}).size,1);
});

test('整组参考拒绝重复、非项目素材、文件替换和不支持格式',async()=>{
 const f=await fixture(),asset=await f.addAsset();
 await assert.rejects(f.plan([{assetId:asset.id},{assetId:asset.id}]),/重复/);
 await assert.rejects(f.plan([{assetId:'not-in-project'}]),/不属于当前项目/);
 const unsupported=await f.addAsset(Buffer.from('text'),'text/plain','text.txt');
 await assert.rejects(f.plan([{assetId:unsupported.id}]),/语言模型参考仅支持/);
 await fs.appendFile(path.join(f.data,'assets',asset.id),'changed');
 await assert.rejects(f.plan([{assetId:asset.id}]),/记录与文件不一致/);
});

test('空的原生展开不伪造待发送素材，旧单素材路径保持兼容',async()=>{
 const f=await fixture(),empty=await f.plan([]);
 assert.equal(empty.sendAssets,false);assert.deepEqual(empty.referenceDetails,[]);assert.deepEqual(empty.llm.referenceSources,[{sourceNodeId:f.group.id}]);
 const source=f.pending('image'),asset=await f.addAsset();delete source.params.workflowBinding;source.assetId=asset.id;f.b.referenceSources=[{sourceNodeId:source.id}];
 const step=await f.plan(undefined);assert.equal(step.sendAssets,true);assert.equal(step.referenceDetails[0].assetId,asset.id);
});
