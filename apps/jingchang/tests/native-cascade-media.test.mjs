import test from 'node:test';
import assert from 'node:assert/strict';
import {cascadeFixture} from './helpers/native-cascade-fixture.mjs';
import {planNativeCascade} from '../lib/native-cascade-plan.mjs';
import {cascadeReferenceResolver,normalizeCascadeRefs,uniqueCascadeRefs} from '../lib/native-cascade-media.mjs';

const ref=id=>({assetId:id,kind:'image',name:id+'.png'});
function graph(){const f=cascadeFixture();f.node('A');f.node('B');f.node('C');f.edge('A','B');f.edge('B','C');return f;}
const resolver=(f,values={})=>cascadeReferenceResolver(f.project,{round:planNativeCascade(f.project,{nodeId:'C'}).rounds[0],...values});

test('发送方自有素材优先，本轮新结果覆盖旧图；默认及入边只作回退',()=>{
 const f=graph(),p=planNativeCascade(f.project,{nodeId:'C'}),first=p.rounds[0].operations[0],second=p.rounds[0].operations[1];
 assert.deepEqual(resolver(f).forRequest(first).map(ref=>ref.assetId),['asset-A']);
 const r=resolver(f,{nodeOutputs:{B:[ref('new-B')]}});
 assert.deepEqual(r.forRequest(second,{[first.id]:[ref('from-incoming')]}).map(ref=>ref.assetId),['new-B']);
 assert.deepEqual(resolver(f).forRequest(second,{[first.id]:[ref('from-incoming')]}).map(ref=>ref.assetId),['asset-B']);
});
test('forceWorkflow改变默认参考，显式发送方自图仍先于默认整组',()=>{
 const f=graph();f.node('M');f.edge('M','B','input');
 const p=planNativeCascade(f.project,{nodeId:'C'}),r=cascadeReferenceResolver(f.project,{round:{...p.rounds[0],forceWorkflow:true}});
 assert.deepEqual(r.defaultRefs('B').map(ref=>ref.assetId),['asset-A','asset-M']);
 assert.deepEqual(r.forRequest(p.rounds[0].operations[1],{[p.rounds[0].operations[0].id]:[ref('incoming')]}).map(ref=>ref.assetId),['asset-B']);
});
test('已记录空的本轮输出不借用旧预览；空来源最终读取真正入边引用',()=>{
 const f=graph();f.find('B').params.nativeCanvas.node.images=[];f.project.edges[0].nativeCanvasConnection.kind='history';
 // Keep the original compiled operation for this isolated reference-resolution assertion.
 const operation={requestNodeId:'B',references:{kind:'self-default-incoming',selfNodeId:'B',defaultNodeId:'B',incoming:{kind:'operation-output',operationId:'upstream'}}};
 const r=cascadeReferenceResolver(f.project,{round:{forceWorkflow:false,index:null},nodeOutputs:{B:[]}});
 assert.deepEqual(r.forRequest(operation,{upstream:[ref('actual-input')]}).map(ref=>ref.assetId),['actual-input']);
 assert.throws(()=>r.forRequest(operation),/尚未完整完成/);
});
test('循环只读取input边、采用真实起始计数与批次，保留视频音频类型',()=>{
 const f=cascadeFixture();f.node('L',{kind:'smart-loop',count:2,start:2,imageInput:true,batch:2});const a=f.node('A');f.node('X');f.node('C');f.edge('A','L','input');f.edge('X','L','flow');f.edge('L','C');
 a.params.nativeCanvas.node.images=[];a.params.nativeCanvas.resources=[];a.params.nativeCanvas.mediaAssetIds=[];
 for(const [i,kind]of ['image','video','audio','image'].entries()){
  const assetId='kind-'+i,url='/api/assets/'+assetId;f.project.assets.push({id:assetId,type:kind+'/synthetic',name:assetId});a.params.nativeCanvas.node.images.push({url});a.params.nativeCanvas.resources.push({url,assetId,archive:'media/'+assetId});a.params.nativeCanvas.mediaAssetIds.push(assetId);
 }
 const p=planNativeCascade(f.project,{nodeId:'C'}),r=cascadeReferenceResolver(f.project,{round:p.rounds[0]});
 assert.deepEqual(r.output('L').map(ref=>[ref.assetId,ref.kind]),[['kind-1','video'],['kind-2','audio']]);
 assert.equal(cascadeReferenceResolver(f.project,{round:p.rounds[1]}).output('L').length,1);
});
test('循环媒体中继每一层按相同计数切片，不把内层批次当成外层迭代次数',()=>{
 const f=cascadeFixture();const a=f.node('A');f.node('L1',{kind:'smart-loop',imageInput:true,batch:3});f.node('L2',{kind:'smart-loop',imageInput:true,batch:2,count:2,start:2});f.node('C');f.edge('A','L1','input');f.edge('L1','L2','input');f.edge('L2','C');
 a.params.nativeCanvas.node.images=[];a.params.nativeCanvas.resources=[];
 for(let i=1;i<=4;i++){const assetId='picture-'+i,url='/api/assets/'+assetId;f.project.assets.push({id:assetId,name:assetId,type:'image/png'});a.params.nativeCanvas.node.images.push({url});a.params.nativeCanvas.resources.push({url,assetId,archive:'media/'+assetId});}
 const round=planNativeCascade(f.project,{nodeId:'C'}).rounds[0];
 assert.deepEqual(cascadeReferenceResolver(f.project,{round}).output('L2').map(ref=>ref.assetId),['picture-3','picture-4']);
});
test('智能分组先保留自图，再按行容差和横坐标整理素材成员，不递归套组',()=>{
 const f=graph();const group=f.node('G',{kind:'smart-group',raw:{images:[{url:'/api/assets/asset-A'}]}});f.node('M1',{x:200,y:0});f.node('M2',{x:100,y:10});f.node('M3',{x:0,y:100});f.node('N',{kind:'smart-group'});
 group.params.nativeCanvas.members=['M1','M2','M3','N'].map(sourceNodeId=>({sourceNodeId}));
 assert.deepEqual(resolver(f).output('G').map(ref=>ref.assetId),['asset-A','asset-M2','asset-M1','asset-M3']);
 const r=resolver(f,{nodeOutputs:{M2:[ref('round-M2')]},receivers:{M2:{currentRefs:[ref('canvas-M2')]}}});
 assert.deepEqual(r.output('G').map(ref=>ref.assetId),['asset-A','canvas-M2','asset-M1','asset-M3']);
});
test('默认参考按原URL身份去重，保留名称和原媒体，最多20份',()=>{
 const f=graph();f.find('B').params.nativeCanvas.node.images=[];
 for(let i=0;i<22;i++){const n=f.node('M'+i);f.edge(n,f.find('B'),'input');}
 f.edge('A','B','input');
 const refs=cascadeReferenceResolver(f.project,{round:{forceWorkflow:false,index:null}}).defaultRefs('B');assert.equal(refs.length,20);assert.equal(refs[0].assetId,'asset-M0');assert.equal(refs.at(-1).assetId,'asset-M19');
 const a=normalizeCascadeRefs([ref('same'),ref('same')]);assert.equal(uniqueCascadeRefs(a).length,1);
});
test('blockedInputRefs按原节点和素材位置排除，原URL键也适用于新结果',()=>{
 const f=graph();f.find('A').params.nativeCanvas.node.blockedInputRefs=['original-A|0'];const p=planNativeCascade(f.project,{nodeId:'C'});
 assert.deepEqual(resolver(f).forRequest(p.rounds[0].operations[0]),[]);
 f.find('B').params.nativeCanvas.node.blockedInputRefs=['original-B|0'];
 assert.deepEqual(resolver(f,{nodeOutputs:{B:[ref('fresh-B')]}}).forRequest(p.rounds[0].operations[1],{[p.rounds[0].operations[0].id]:[]}).map(ref=>ref.assetId),['fresh-B']);
 f.find('B').params.nativeCanvas.node.blockedInputRefs=['url|/api/assets/fresh-B'];
 assert.deepEqual(resolver(f,{nodeOutputs:{B:[ref('fresh-B')]}}).forRequest(p.rounds[0].operations[1],{[p.rounds[0].operations[0].id]:[]}),[]);
});
test('手动参考可从已导入全局映射恢复，但不存在的原图在生成前阻断',()=>{
 const f=graph();f.find('B').params.nativeCanvas.node.manualInputRefs=[{url:'/api/assets/asset-C',name:'手动参考'}];
 assert.deepEqual(resolver(f).defaultRefs('B').map(ref=>ref.assetId),['asset-B','asset-C']);
 f.find('A').params.nativeCanvas.node.images=[{url:'missing-local-file.png'}];
 assert.throws(()=>resolver(f).output('A'),/尚未导入本机/);
});
test('素材收据不接受非法编号、类型、身份或秘密字段',()=>{
 for(const bad of [{assetId:'../x',kind:'image',name:'x'},{...ref('x'),kind:'unknown'},{...ref('x'),identity:'tampered'},{...ref('x'),apiKey:'never-a-real-key'}])assert.throws(()=>normalizeCascadeRefs([bad]),/格式无效|凭据|密钥|敏感|secret|不应/);
});
