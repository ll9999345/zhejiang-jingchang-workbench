import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {makeProject,makeNode,validateProject} from '../lib/model.mjs';
import {normalizeNativeWorkflow,nativeToFragment,fragmentToNative} from '../lib/native-canvas-core.mjs';
import {nativeFlowPreview} from '../lib/native-flow.mjs';
import {captureJimengCanvasTarget,validJimengCanvasTarget,assertJimengCanvasTarget,jimengCanvasContext,applyJimengCanvasResults} from '../lib/jimeng-canvas.mjs';
import {jimengTaskService,jimengTaskHistory} from '../lib/jimeng-cli-tasks.mjs';
import {streamAssetService} from '../lib/stream-assets.mjs';
import {storeAsset} from '../lib/workspace.mjs';
import {jimengFixture} from './helpers/jimeng-generation-fixture.mjs';

function canvas(){const p=makeProject('节点范围测试'),up=makeNode('text',0,0,{text:'上游画面'}),target=makeNode('image',300,0,{text:'翡翠色玻璃'});p.nodes=[up,target];p.edges=[{id:'edge',source:up.id,target:target.id}];return{p,up,target};}
const asset=(id,type='image/png')=>({id,name:id+'.png',type,url:'/media/'+id,size:68});
const task=(target,assets)=>({id:'fixed-task',plan:{request:{prompt:'原提示词'},canvasTarget:target},assets});
function native(nodes,edges=[],assets=[]){const doc=normalizeNativeWorkflow({format:'infinite-canvas-workflow',version:1,nodes:nodes.map(n=>({x:0,y:0,...n})),connections:edges.map(([from,to])=>({from,to}))});return nativeToFragment(doc,assets.map(asset=>({url:'/source/'+asset.id,archive:'resources/'+asset.id,portableUrl:asset.url,asset})),'原生节点范围测试');}
test('only node content, ancestors, reference metadata and ordered edges bind the scope; layout/unrelated data remain editable',()=>{
 const {p,up,target}=canvas(),saved=captureJimengCanvasTarget(p,target.id);assert.ok(validJimengCanvasTarget(saved));
 p.revision++;target.x=900;up.y=600;p.viewport.x=500;p.nodes.push(makeNode('text',0,0));p.assets.push(asset('unrelated'));assertJimengCanvasTarget(p,saved);
 const reordered=structuredClone(p);reordered.nodes.find(n=>n.id===target.id).params=Object.fromEntries(Object.entries(target.params).reverse());assertJimengCanvasTarget(reordered,saved);
 for(const mutate of [q=>q.nodes.find(n=>n.id===up.id).text+=' changed',q=>q.nodes.find(n=>n.id===target.id).params.ratio='9:16',q=>q.edges=[],q=>q.nodes.find(n=>n.id===target.id).title+=' changed',q=>q.nodes=q.nodes.filter(n=>n.id!==target.id)]){const q=structuredClone(p);mutate(q);assert.throws(()=>assertJimengCanvasTarget(q,saved),/变化/);}
 assert.equal(validJimengCanvasTarget({...saved,unexpected:1}),false);assert.throws(()=>captureJimengCanvasTarget(p,up.id));
});
test('ordinary prompt and current image inputs prefill without running upstream or dropping unsupported roles',()=>{
 const {p,up,target}=canvas(),a=asset('input');p.assets.push(a);const picture=makeNode('image',0,0,{assetId:a.id});p.nodes.push(picture);p.edges.push({id:'image-edge',source:picture.id,target:target.id});
 const c=jimengCanvasContext(p,target.id);assert.equal(c.request.command,'image2image');assert.equal(c.request.prompt,'上游画面\n\n翡翠色玻璃');assert.deepEqual(c.request.references,[{assetId:a.id,role:'image'}]);assert.equal(c.target.signature,captureJimengCanvasTarget(p,target.id).signature);
 p.edges=[];target.assetId=a.id;assert.equal(jimengCanvasContext(p,target.id).request.command,'image2image');
});
test('native group order and prompt aggregation reach a video node as first/last frames; stored generated output is not self-input',()=>{
 const a=asset('a'),b=asset('b'),p=native([{id:'a',type:'image',url:'/source/a'},{id:'b',type:'image',url:'/source/b'},{id:'t',type:'prompt',text:'镜头文字'},{id:'g',type:'group',items:['b','a','t']},{id:'v',type:'video',prompt:'移动镜头'}],[['g','v']],[a,b]);
 const v=p.nodes.find(n=>n.params.nativeCanvas.node.id==='v'),c=jimengCanvasContext(p,v.id);assert.equal(c.request.command,'frames2video');assert.deepEqual(c.request.references,[{assetId:'b',role:'first'},{assetId:'a',role:'last'}]);assert.match(c.request.prompt,/镜头文字/);
 const saved=c.target;p.nodes.find(n=>n.params.nativeCanvas.node.id==='g').params.nativeCanvas.members.reverse();assert.throws(()=>assertJimengCanvasTarget(p,saved),/变化/);
 const q=native([{id:'gen',type:'generator',generatedOutputs:[{url:'/source/a',type:'image/png'}]}],[],[a]);assert.deepEqual(jimengCanvasContext(q,q.nodes[0].id).request.references,[]);
});
test('target placement changes only the bound node asset, retains its text/config and previous assets, and is idempotent after subsequent editing',()=>{
 const {p,target}=canvas(),old=asset('old'),result=asset('result');p.assets.push(old);target.assetId=old.id;const saved=captureJimengCanvasTarget(p,target.id),before=structuredClone(target),t=task(saved,[result]);
 assert.equal(applyJimengCanvasResults(p,t,[result],{revision:0,placement:'target'}),true);assert.equal(target.assetId,result.id);assert.deepEqual({...target,assetId:old.id},before);assert.ok(p.assets.some(a=>a.id===old.id));assert.equal(p.nodes.length,3);validateProject(p);
 target.text='之后的新修改';p.revision++;const latest=structuredClone(p);assert.equal(applyJimengCanvasResults(p,t,[result],{revision:0,placement:'target'}),false);assert.deepEqual(p,latest);
});
test('stale target or project revision leaves every byte intact; explicit new placement keeps the changed target',()=>{
 const {p,up,target}=canvas(),result=asset('result'),t=task(captureJimengCanvasTarget(p,target.id),[result]);up.text='后来修改';const before=structuredClone(p);
 assert.throws(()=>applyJimengCanvasResults(p,t,[result],{revision:0,placement:'target'}),/变化/);assert.deepEqual(p,before);
 assert.throws(()=>applyJimengCanvasResults(p,t,[result],{revision:9,placement:'new'}),/更新/);assert.deepEqual(p,before);
 applyJimengCanvasResults(p,t,[result],{revision:0,placement:'new'});assert.equal(target.assetId,null);assert.equal(up.text,'后来修改');assert.equal(p.nodes.length,3);
});
test('native placement updates portable resources and downstream media while retaining original records and preserving roundtrip output',()=>{
 for(const type of ['image','generator','smart-image','video']){
  const old=asset('old',type==='video'?'video/mp4':'image/png'),result=asset('new',old.type),p=native([{id:'n',type,...(type==='image'?{url:'/source/old'}:{generatedOutputs:[{url:'/source/old',type:old.type}],...(type==='smart-image'?{images:[{url:'/source/old',type:old.type}]}:{})})}],[],[old]),node=p.nodes[0],t=task(captureJimengCanvasTarget(p,node.id),[result]);
  applyJimengCanvasResults(p,t,[result],{revision:p.revision,placement:'target'});validateProject(p);assert.equal(node.assetId,'new');assert.ok(node.params.nativeCanvas.resources.some(r=>r.assetId==='old'));assert.deepEqual(nativeFlowPreview(p,{nodeId:node.id}).nodes[0].media.map(m=>m.assetId),['new']);const exported=fragmentToNative(p,p.assets,{withResources:true}),restored=nativeToFragment(exported,exported.resources.map((ref,index)=>({...ref,portableUrl:p.assets[index].url,asset:p.assets[index]})),'CLI结果原生往返');const restoredNode=restored.nodes.find(n=>n.params.nativeCanvas.node.id==='n');assert.deepEqual(nativeFlowPreview(restored,{nodeId:restoredNode.id}).nodes[0].media.map(m=>m.assetId),['new']);
 }
});

const stage=path.resolve('artifacts/jimeng-canvas-tests-'+Date.now());await fs.mkdir(stage,{recursive:true});
const until=async fn=>{const end=Date.now()+6000;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('settle timeout');};
async function service(){const dir=path.join(stage,randomUUID()),data=path.join(dir,'data');await fs.mkdir(data,{recursive:true});const fixture=await jimengFixture(path.join(dir,'bin')),{p,up,target}=canvas();const projects={load:async id=>{assert.equal(id,p.id);return structuredClone(p);},apply:async(t,revision,placement)=>{applyJimengCanvasResults(p,t,t.assets,{revision,placement});return p;}};const opts={data,projects,streamAssets:streamAssetService({data,projects,activeJobs:new Map()}),env:{PATH:process.env.PATH,JIMENG_BIN:fixture.file},timeoutMs:2000},s=jimengTaskService(opts);const auth=(plan,action='generate',upstreamId)=>({service:'local-dreamina-login',action,command:plan.request.command,model:plan.request.model,requestLimit:1,useLocalLogin:true,sendPrompt:action==='generate',sendOriginalMedia:action==='generate'&&!!plan.media.length,budget:1,currency:'credits',consent:true,...(upstreamId?{upstreamId}:{})});const prepare=async()=>{const context=await s.context(p.id,target.id),preview=await s.preview({projectId:p.id,request:context.request,canvasTarget:context.target});return{projectId:p.id,request:preview.plan.request,canvasTarget:context.target,requestId:randomUUID(),fingerprint:preview.fingerprint,consent:true,authorization:auth(preview.plan)};};const settle=async id=>until(async()=>{const r=await s.get(id,p.id);return r.status!=='executing'?r:null;});return{p,up,target,s,fixture,data,auth,prepare,settle,opts};}
test('canvas generation scope is revalidated before launch; semantic changes and type switching execute zero commands',async()=>{
 const c=await service(),body=await c.prepare();c.up.text+=' changed';await assert.rejects(c.s.start(body),/变化/);assert.equal((await c.fixture.calls()).length,0);
 const ctx=await c.s.context(c.p.id,c.target.id);await assert.rejects(c.s.preview({projectId:c.p.id,canvasTarget:ctx.target,request:{command:'text2video',prompt:'wrong type'}}),/类型/);assert.equal((await c.fixture.calls()).length,0);
});
test('a dependency edit after confirmation but before the execution intent prevents even the first CLI command',async()=>{
 const c=await service();let resolutions=0;const s=jimengTaskService({...c.opts,resolveTool:async()=>{if(++resolutions===3)c.up.text='changed while preparing the executable';return{executable:c.fixture.file};}}),ctx=await s.context(c.p.id,c.target.id),preview=await s.preview({projectId:c.p.id,canvasTarget:ctx.target,request:ctx.request});const body={projectId:c.p.id,canvasTarget:ctx.target,request:preview.plan.request,requestId:randomUUID(),fingerprint:preview.fingerprint,consent:true,authorization:c.auth(preview.plan)};await s.start(body);const r=await c.settle(body.requestId);assert.equal(r.requestCount,0);assert.equal(r.status,'uncertain');assert.equal((await c.fixture.calls()).length,0);
});
test('real local fixture task/query/restart/target placement and inert portable archive retain the original node scope',async()=>{
 const c=await service(),body=await c.prepare();await c.s.start(body);let r=await c.settle(body.requestId);await c.s.query(r.id,{projectId:c.p.id,requestId:randomUUID(),consent:true,authorization:c.auth(r.plan,'query',r.upstreamId)});r=await c.settle(r.id);assert.equal(r.status,'completed');const history=jimengTaskHistory(await c.s.history(r.id,c.p.id));assert.deepEqual(history.plan.canvasTarget,body.canvasTarget);const bad=structuredClone(history);bad.plan.canvasTarget.signature='0'.repeat(64);assert.throws(()=>jimengTaskHistory(bad));
 const resumed=jimengTaskService(c.opts);await resumed.apply(r.id,{projectId:c.p.id,revision:0,placement:'target'});assert.equal(c.target.assetId,r.assets[0].id);c.target.text='编辑后';await resumed.apply(r.id,{projectId:c.p.id,revision:0,placement:'target'});assert.equal(c.target.text,'编辑后');assert.equal((await c.fixture.calls()).length,2);
});
test('changed reference bytes block target placement while explicit new-node placement retains both original and result',async()=>{
 const c=await service(),bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=','base64'),a=await storeAsset(c.data,bytes,{name:'original.png',type:'image/png'});c.p.assets.push(a);c.target.assetId=a.id;const body=await c.prepare();await c.s.start(body);let r=await c.settle(body.requestId);await c.s.query(r.id,{projectId:c.p.id,requestId:randomUUID(),consent:true,authorization:c.auth(r.plan,'query',r.upstreamId)});r=await c.settle(r.id);assert.equal(r.status,'completed');await fs.appendFile(path.join(c.data,'assets',a.id),Buffer.from([0]));await assert.rejects(c.s.apply(r.id,{projectId:c.p.id,revision:0,placement:'target'}),/变化/);assert.equal(c.target.assetId,a.id);await c.s.apply(r.id,{projectId:c.p.id,revision:0,placement:'new'});assert.equal(c.target.assetId,a.id);assert.equal((await c.fixture.calls()).length,2);
});
console.log('Retained canvas fixtures:',stage);
