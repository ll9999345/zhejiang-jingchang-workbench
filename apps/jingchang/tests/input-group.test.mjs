import './helpers/local-network-only.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {createInputGroup,inputGroupMemberIds} from '../public/input-group-core.js';
import {arrangeCanvasSelection} from '../public/canvas-arrange-core.js';
import {copySelectedNodes,moveNodes,removeSelectedNodes} from '../lib/canvas-tools.mjs';
import {makeProject,makeNode,validateProject} from '../lib/model.mjs';
import {normalizeNativeWorkflow,nativeToFragment,fragmentToNative} from '../lib/native-canvas-core.mjs';
import {nativeFlowPreview} from '../lib/native-flow.mjs';
import {nativeExecutionAncestors,nativeReferencePlan} from '../lib/native-flow-execution.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';
import {generationService} from '../lib/generation.mjs';
import {storeAsset,readJson} from '../lib/workspace.mjs';

const n=(id,type='text',x=100,y=100)=>makeNode(type,x,y,{id,title:id,text:id});
const e=(id,source,target)=>({id,source,target});
function fixture(){const p=makeProject('输入组单元验收');p.nodes=[n('text-a'),n('text-b','script',400,300),n('img','image',100,450),n('target','image',800,100),n('outside','text',900,600)];p.nodes[3].params.imageBinding={preserved:{refs:'all'}};p.edges=[e('img-target','img','target'),e('prompt-target','text-a','target'),e('prompt-other','text-a','outside')];p.groups=[];return p;}
function group(p,ids=['text-a','text-b','img'],opts={}){let i=0;return createInputGroup(p,ids,{idFactory:()=>['new-group','new-edge-a','new-edge-b'][i++],...opts});}

test('混合输入组聚合选中文图，交接生成边并保留其他连接/绑定/记录',()=>{
 const p=fixture(),before=structuredClone(p),r=group(p);validateProject(r.project);assert.deepEqual(p,before);assert.equal(r.project.nodes.length,6);assert.deepEqual(r.project.nodes.slice(0,5).map(n=>({id:n.id,x:n.x,y:n.y,text:n.text,params:n.params})),p.nodes.map(n=>({id:n.id,x:n.x,y:n.y,text:n.text,params:n.params})));
 assert.deepEqual(r.project.edges,[p.edges[2],e('new-edge-a','new-group','target')]);assert.deepEqual(r.targetIds,['target']);assert.equal(r.removedEdgeIds.length,2);assert.deepEqual(r.project.assets,p.assets);assert.deepEqual(r.project.runs,p.runs);assert.deepEqual(r.project.groups,p.groups);
 const g=r.project.nodes.at(-1);assert.equal(g.type,'scene');assert.deepEqual(g.params.nativeCanvas.members.map(m=>m.sourceNodeId),['text-a','text-b','img']);assert.equal(g.params.nativeCanvas.connectedGroup,true);
 assert.deepEqual(nativeExecutionAncestors(r.project,'target'),new Set(['new-group','text-a','text-b','img']));
});
test('提示词组仅纳入文字，不自动交接原来的生成连线',()=>{
 const p=fixture(),r=group(p,undefined,{kind:'promptGroup',title:'提示词汇总'});assert.deepEqual(r.project.edges,p.edges);assert.deepEqual(r.ignoredIds,['img']);assert.deepEqual(r.members.map(n=>n.id),['text-a','text-b']);validateProject(r.project);
 const inspect=nativeFlowPreview(r.project,{nodeId:r.groupId});assert.deepEqual(inspect.nodes[0].promptItems,['text-a','text-b']);
});
test('空选择和不适用选择建立空组，坐标/尺寸按已审阅源规则',()=>{
 const p=fixture();for(const ids of [[],['outside']]){const r=group(p,ids,{kind:'promptGroup',point:{x:33,y:44}});if(ids.length)assert.equal(r.members.length,1);else{assert.equal(r.project.nodes.at(-1).x,33);assert.equal(r.project.nodes.at(-1).params.nativeCanvas.node.w,300);}}
 const r=group(p,undefined,{rects:{'text-a':{width:200,height:100},'text-b':{width:300,height:150},img:{width:400,height:200}}});const raw=r.project.nodes.at(-1).params.nativeCanvas.node;assert.deepEqual([raw.x,raw.y,raw.w,raw.h],[76,42,648,640]);
});
test('原生目标输入顺序更新，明确素材字段仍指向原成员并有效',()=>{
 const raw={nodes:[{id:'a',type:'prompt',x:0,y:0,text:'一'},{id:'b',type:'prompt',x:400,y:100,text:'二'},{id:'sink',type:'comfy',x:800,y:0,inputs:['a','b'],custom:'保留'}],connections:[{from:'a',to:'sink'},{from:'b',to:'sink'}]};const p=nativeToFragment(normalizeNativeWorkflow(raw),[],'原生组交接'),r=group(p,[p.nodes[0].id,p.nodes[1].id]),target=r.project.nodes[2];validateProject(r.project);
 assert.deepEqual(target.params.nativeCanvas.inputOrder,[{sourceNodeId:r.groupId,itemType:'group-prompts',index:0}]);assert.deepEqual(target.params.nativeCanvas.node.inputs,[r.groupId+':prompts']);assert.equal(target.params.nativeCanvas.node.custom,'保留');
 r.project.nodes.at(-1).title='更名后的输入组';const out=fragmentToNative(r.project,[]);assert.equal(out.nodes[3].title,'更名后的输入组');assert.deepEqual(out.nodes[2].inputs,[r.groupId+':prompts']);assert.deepEqual(out.nodes[3].items,['a','b']);assert.equal(out.connections[0].from,r.groupId);
});
test('普通视觉编组保持；原生已有成员不猜测重归属，拒绝且不部分修改',()=>{
 const p=fixture();p.groups=[{id:'visual',title:'视觉编组',nodeIds:['text-a','text-b']}];const r=group(p);assert.deepEqual(r.project.groups,p.groups);validateProject(r.project);
 const native=nativeToFragment(normalizeNativeWorkflow({nodes:[{id:'p',type:'prompt',x:0,y:0,text:'p'},{id:'g',type:'group',x:0,y:0,items:['p']}],connections:[]}),[],'原生旧组'),before=structuredClone(native);assert.throws(()=>group(native,[native.nodes[0].id]),/已属于/);assert.deepEqual(native,before);
});
test('完整视觉组纳入输入组后仍可局部整理，部分视觉组在创建前明确拒绝',()=>{
 const p=fixture();p.groups=[{id:'visual',title:'已有视觉组',nodeIds:['text-a','text-b']}];assert.throws(()=>group(p,['text-a','img']),/部分成员/);
 const r=group(p),arranged=arrangeCanvasSelection(r.project,[r.groupId]);validateProject(arranged.project);assert.deepEqual(arranged.project.groups,p.groups);assert.deepEqual(arranged.project.nodes[4],p.nodes[4]);
 const [a,b,img]=arranged.project.nodes;assert.equal(b.x-a.x,p.nodes[1].x-p.nodes[0].x);assert.equal(img.y-a.y,p.nodes[2].y-p.nodes[0].y);
});
test('组头拖动、复制及移出范围完整包含成员，原组引用和素材保持',()=>{
 const r=group(fixture()),ids=inputGroupMemberIds(r.project,[r.groupId]);assert.deepEqual(new Set(ids),new Set([r.groupId,'text-a','text-b','img']));
 const moved=moveNodes(r.project,ids,{x:40,y:20});for(const id of ids){const before=r.project.nodes.find(n=>n.id===id),after=moved.nodes.find(n=>n.id===id);assert.equal(after.x-before.x,40);assert.equal(after.y-before.y,20);}
 const copied=copySelectedNodes(r.project,ids),clones=copied.nodes.slice(r.project.nodes.length),clone=clones.find(n=>n.params?.nativeCanvas?.node.type==='group');assert(clone.params.nativeCanvas.members.every(r=>clones.some(n=>n.id===r.sourceNodeId)));validateProject(copied);
 const removed=removeSelectedNodes(copied,inputGroupMemberIds(copied,[clone.id]));assert.deepEqual(removed.nodes,r.project.nodes);assert.deepEqual(removed.assets,r.project.assets);validateProject(removed);
});
test('选入下游生成节点导致语义环时，在保存和请求前整体拒绝',()=>{
 const p=fixture(),before=structuredClone(p);assert.throws(()=>group(p,['img','target']),/循环依赖/);assert.deepEqual(p,before);
});
test('源普通LLM/输出与未绑定文本边不被误交接',()=>{
 const p=nativeToFragment(normalizeNativeWorkflow({nodes:[{id:'a',type:'prompt',x:0,y:0,text:'a'},{id:'llm',type:'llm',x:200,y:0,mode:'node'},{id:'out',type:'output',x:400,y:0,images:[]}],connections:[{from:'a',to:'llm'},{from:'a',to:'out'}]}),[],'非生成器边');const r=group(p,[p.nodes[0].id]);assert.deepEqual(r.project.edges,p.edges);assert.equal(r.removedEdgeIds.length,0);
});
test('无效标题、失效选择、编号冲突、智能节点和容量均不修改原项目',()=>{
 const p=fixture(),before=structuredClone(p);for(const options of [{title:''},{title:'x'.repeat(121)},{point:{x:Infinity,y:1},kind:'promptGroup'}])assert.throws(()=>group(p,[],options));
 assert.throws(()=>group(p,['missing']),/选区/);assert.throws(()=>group(p,undefined,{idFactory:()=>p.nodes[0].id}),/编号/);
 const smart=nativeToFragment(normalizeNativeWorkflow({format:'infinite-smart-canvas-workflow',nodes:[{id:'a',type:'text',x:0,y:0,text:'a'}],connections:[]}),[],'智能');assert.throws(()=>group(smart,[smart.nodes[0].id]),/智能画布/);
 assert.deepEqual(p,before);
});
test('固定源交接函数的连接结果与独立实现一致',async()=>{
 const source=await fs.readFile('tests/fixtures/reference/07-canvas.js','utf8');assert.equal(createHash('sha256').update(source).digest('hex'),'a1e2dd0ba845ededca8a4351d0889e3569bab46479715408d22d2512482de1ed');
 const fn=source.slice(source.indexOf('function handoffExistingInputsToGroup('),source.indexOf('function updateGroupMembership('));
 const nodes=[{id:'a',type:'prompt'},{id:'i',type:'image'},{id:'gen',type:'comfy'},{id:'llm',type:'llm'}],connections=[{id:'ag',from:'a',to:'gen'},{id:'ig',from:'i',to:'gen'},{id:'al',from:'a',to:'llm'}],context=vm.createContext({nodes,connections,CANVAS_GENERATOR_TYPES:['generator','midjourney','msgen','comfy','ltxDirector','video','rh','minimax'],canConnect:()=>true,uid:()=> 'new-edge-a'},{codeGeneration:{strings:false,wasm:false}});vm.runInContext(fn+"handoffExistingInputsToGroup({id:'new-group',type:'group'},nodes.slice(0,2));",context,{timeout:200});
 const p=nativeToFragment(normalizeNativeWorkflow({nodes:nodes.map(n=>({...n,x:0,y:0,text:n.id})),connections}),[],'对照');const r=group(p,[p.nodes[0].id,p.nodes[1].id]),reverse=new Map(p.nodes.map(n=>[n.id,n.params.nativeCanvas.node.id]));reverse.set(r.groupId,r.groupId);assert.deepEqual(r.project.edges.map(e=>[reverse.get(e.source),reverse.get(e.target)]),JSON.parse(vm.runInContext('JSON.stringify(connections.map(e=>[e.from,e.to]))',context)));
});

test('实际本机Comfy链：创建组后保留原字段映射、完整组文字、上传原图并收到结果',async t=>{
 const stage=path.resolve('artifacts','input-group-execution-'+Date.now());await fs.mkdir(stage,{recursive:true});const data=path.join(stage,'data'),state={prompts:[],uploads:[]};
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
 const mock=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);res.setHeader('content-type','application/json');if(req.url==='/upload/image'){state.uploads.push(Buffer.concat(chunks));return res.end(JSON.stringify({name:'group-source.png',type:'input',subfolder:''}));}if(req.url==='/prompt'){state.prompts.push(JSON.parse(Buffer.concat(chunks)));return res.end(JSON.stringify({prompt_id:'group-result'}));}if(req.url.startsWith('/history/'))return res.end(JSON.stringify({'group-result':{status:{completed:true,status_str:'success'},outputs:{'3':{images:[{filename:'group-result.png',subfolder:'',type:'output'}]}}}}));if(req.url.startsWith('/view')){res.setHeader('content-type','image/png');return res.end(png);}res.statusCode=404;res.end('{}');});mock.listen(0,'127.0.0.1');await once(mock,'listening');t.after(()=>{mock.closeAllConnections();return new Promise(r=>mock.close(r));});
 const activeJobs=new Map(),generation=generationService({data,activeJobs}),runner=canvasRunner({data,activeJobs,generation,pollInterval:10}),template=await generation.saveTemplate({name:'本机组输入验收',workflow:{'1':{class_type:'LoadImage',inputs:{image:'old.png'}},'2':{class_type:'CLIPTextEncode',inputs:{text:'old',clip:['4',0]}},'3':{class_type:'SaveImage',inputs:{images:['1',0]}},'4':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'test.safetensors'}}}});
 const p=fixture(),asset=await storeAsset(data,png,{name:'自建原图.png',type:'image/png'});p.assets=[asset];p.nodes.find(n=>n.id==='img').assetId=asset.id;delete p.nodes[3].params.imageBinding;p.nodes[3].params.workflowBinding={workflowId:template.id,overrides:[],imageSources:[{nodeId:'1',name:'image',sourceNodeId:'img'}],promptField:{nodeId:'2',name:'text'},count:1};
 const oldBinding=structuredClone(p.nodes[3].params.workflowBinding),r=group(p),next=r.project;validateProject(next);assert.deepEqual(next.nodes[3].params.workflowBinding,oldBinding);
 const plan=await runner.plan(next,{nodeId:'target'});assert.equal(plan.length,1);assert.equal(plan[0].imageSources[0].sourceNodeId,'img');assert.match(plan[0].text,/text-a\n\ntext-b/);assert.equal(state.prompts.length,0);
 const refs=nativeReferencePlan(next,next.nodes[3],[{sourceNodeId:'img'}],{planning:true});assert.deepEqual(refs.references,[{assetId:asset.id}]);
 const job=await runner.start(next,{revision:next.revision,requestId:'created-input-group',consent:true},'http://127.0.0.1:'+mock.address().port);let done;const deadline=Date.now()+20000;while(Date.now()<deadline){done=await readJson(path.join(data,'jobs',job.id+'.json'));if(!['queued','running'].includes(done.status)&&!activeJobs.size)break;await new Promise(r=>setTimeout(r,20));}assert.equal(done.status,'completed',done.message);assert.equal(state.prompts.length,1);assert.equal(state.uploads.length,1);assert.ok(state.uploads[0].includes(png));assert.equal(state.prompts[0].prompt['1'].inputs.image,'group-source.png');assert.match(state.prompts[0].prompt['2'].inputs.text,/text-a\n\ntext-b/);assert.equal(done.assets.length,1);assert.equal(done.assets[0].type,'image/png');await fs.writeFile(path.join(stage,'result.json'),JSON.stringify({ok:true,groupId:r.groupId,jobId:job.id,actualLocalRequests:1,uploadContainsOriginalPng:true,output:done.assets[0],externalCalls:0,thirdPartyUploads:0,model:'loopback Comfy fixture; no GPU or AI model'},null,2));
});
