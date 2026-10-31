import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {makeProject,makeNode,validateProject} from '../lib/model.mjs';
import {cameraInstruction,cameraNodeText,normalizeCameraAngle,cameraProjection} from '../public/camera-angle-core.js';
import {resolveImageContext} from '../lib/input-context.mjs';
import {generationService} from '../lib/generation.mjs';
import {creationStudioService} from '../lib/creation-studio.mjs';
import {canvasLlmService} from '../lib/canvas-llm.mjs';
import {canvasRunner} from '../lib/canvas-runner.mjs';
import {submitModelScope} from '../lib/native-protocols.mjs';
import {copySelectedNodes} from '../lib/canvas-tools.mjs';
import {applyCanvasResults} from '../lib/generation-results.mjs';
import {storeAsset,readJson} from '../lib/workspace.mjs';
import {cameraMock,png,workflow} from './helpers/camera-angle-fixture.mjs';
const key='synthetic-camera-test-key',sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(f,id,check){for(let i=0;i<700;i++){const j=await readJson(path.join(f.data,'jobs',id+'.json'));if(check(j))return j;await sleep(15);}throw Error('job timeout');}
const done=(f,id)=>wait(f,id,j=>!['queued','running'].includes(j.status));
async function idle(f){for(let i=0;i<100&&f.activeJobs.size;i++)await sleep(15);assert.equal(f.activeJobs.size,0);}
async function fixture(t,mode='modelscope'){
 const mock=await cameraMock();t.after(mock.close);const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-angle-')),activeJobs=new Map(),generation=generationService({data,activeJobs}),creationStudio=creationStudioService({data,activeJobs,pollInterval:10}),canvasLlm=canvasLlmService({data,activeJobs}),runner=canvasRunner({data,activeJobs,generation,creationStudio,canvasLlm,pollInterval:10}),asset=await storeAsset(data,png,{type:'image/png',name:'原图.png'}),project=makeProject('机位验收');
 const source=makeNode('image',0,0,{assetId:asset.id,text:'上游风格'}),node=makeNode('image',360,0,{text:'保留红色小屋',params:{cameraAngle:{rotation:45,pitch:30,distance:2}}});project.nodes=[source,node];project.edges=[{id:'source-angle',source:source.id,target:node.id}];project.assets=[asset];
 if(mode==='comfy'){const template=await generation.saveTemplate({name:'机位图像编辑',workflow});node.params.workflowBinding={workflowId:template.id,overrides:[],imageSources:[{nodeId:'1',name:'image',sourceNodeId:source.id}],promptField:{nodeId:'2',name:'text'},count:1};}
 else node.params.studioBinding={mode:'image',config:{protocol:'modelscope',model:'Qwen/Qwen-Image-Edit-2509',baseUrl:mock.endpoint+'/v1',imageAsync:true,loras:{'author/angle':1}},includeUpstream:false,referenceSources:[{sourceNodeId:source.id}]};
 const projects={load:async()=>project,save:async p=>{Object.assign(project,p);return project;}};
 return {...mock,data,activeJobs,generation,creationStudio,canvasLlm,runner,asset,project,source,node,projects};
}
function credentials(f,steps){return{requestId:crypto.randomUUID(),revision:f.project.revision,consent:true,studioCredentials:steps.filter(s=>s.kind==='studio'&&s.status!=='completed').map(s=>({nodeId:s.executionId||s.nodeId,apiKey:key,authorization:{origin:f.endpoint,model:s.studio.config.model,sendPrompt:true,sendReferences:s.sendAssets,requestLimit:1,budget:1,currency:'CNY'}}))};}
async function noKey(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())await noKey(file);else if(e.name.endsWith('.json'))assert.ok(!(await fs.readFile(file,'utf8')).includes(key));}}
test('机位范围、默认值、投影极值及普通节点内容兼容',()=>{
 assert.deepEqual(normalizeCameraAngle(),{rotation:0,pitch:0,distance:4});
 for(const a of [{rotation:91},{pitch:-91},{distance:0},{distance:8.1},{rotation:'0'},{pitch:NaN},null])assert.throws(()=>normalizeCameraAngle(a));
 for(const rotation of [-90,0,90])for(const pitch of [-90,0,90])for(const distance of [.1,4,8])for(const p of [[0,0,0],[-1,1,0],[1,-1,0]]){const out=cameraProjection(p,{rotation,pitch,distance},760,380);assert.ok(out===null||Object.values(out).every(Number.isFinite));}
 assert.match(cameraInstruction({rotation:-45,pitch:-30,distance:2}),/向左.*45/);assert.match(cameraInstruction({distance:8}),/2 倍/);
 assert.equal(cameraNodeText({text:' 普通文字 '}),'普通文字');const p=makeProject();p.nodes[0].params.cameraAngle={rotation:Infinity};assert.throws(()=>validateProject(p),/机位/);
});
test('Comfy真实上传协议、机位指令与上游文字一起进入执行，结果仅回填一次',async t=>{
 const f=await fixture(t,'comfy'),plan=await f.runner.plan(f.project);assert.match(plan[0].text,/向右旋转 45 度/);const j=await f.runner.start(f.project,credentials(f,plan),f.endpoint),result=await done(f,j.id);assert.equal(result.status,'completed',result.message);
 const prompt=f.state.calls.find(c=>c.url==='/prompt').body.prompt;assert.match(prompt['2'].inputs.text,/上游风格/);assert.match(prompt['2'].inputs.text,/上方俯视 30 度/);assert.match(prompt['2'].inputs.text,/0.5 倍/);assert.equal(prompt['1'].inputs.image,'uploaded-angle.png');assert.equal(f.state.calls.filter(c=>c.url==='/upload/image').length,1);
 await applyCanvasResults({...f,job:result,revision:0});await assert.rejects(applyCanvasResults({...f,job:result,revision:0}),/尚未加入/);assert.equal(f.project.assets.length,2);assert.ok(f.project.nodes.at(-1).y>Math.max(f.node.y,f.source.y)+300);assert.deepEqual(f.node.params.cameraAngle,{rotation:45,pitch:30,distance:2});await noKey(f.data);
});
test('ModelScope机位编辑以data URL发送原图，单图/多图/无图契约与输入拒绝',async t=>{
 const f=await fixture(t),plan=await f.runner.plan(f.project);assert.doesNotMatch(plan[0].text,/上游风格/);const j=await f.runner.start(f.project,credentials(f,plan),f.endpoint),result=await done(f,j.id);assert.equal(result.status,'completed',result.message);const call=f.state.calls[0];assert.deepEqual(call.body.image_url,['data:image/png;base64,'+png.toString('base64')]);assert.deepEqual(call.body.loras,{'author/angle':1});assert.match(call.body.prompt,/向右旋转 45 度/);assert.doesNotMatch(call.body.prompt,/上游风格/);assert.equal(call.headers['x-modelscope-async-mode'],'true');
 for(const count of [0,1,3]){const studio={mode:'image',prompt:'编辑',references:Array(count).fill({assetId:f.asset.id}),config:{model:'Qwen/test',count:1,quality:'auto',transparent:false,loras:{}}};await submitModelScope({baseUrl:f.endpoint+'/v1',apiKey:key,studio,references:Array.from({length:count},()=>({bytes:png,mime:'image/png'}))});const b=f.state.calls.at(-1).body;assert.equal(b.image_url?.length||0,count);if(!count)assert.equal('image_url'in b,false);}
 const before=f.state.calls.length;for(const bad of [{references:Array(4).fill({bytes:png,mime:'image/png'})},{references:[{bytes:Buffer.from('bad'),mime:'image/png'}]}])await assert.rejects(submitModelScope({baseUrl:f.endpoint+'/v1',apiKey:key,studio:{mode:'image',prompt:'编辑',references:bad.references,config:{count:1,quality:'auto'}},...bad}));assert.equal(f.state.calls.length,before);await noKey(f.data);
});
test('整图预检拒绝非法角度、四张参考图、不支持参数、隐藏字段和无参考来源',async t=>{
 const f=await fixture(t);for(const change of [n=>n.params.cameraAngle.rotation=100,n=>n.params.studioBinding.config.count=2,n=>n.params.studioBinding.referenceSources=[{assetId:'missing'}],n=>n.params.studioBinding.referenceSources=Array.from({length:4},(_,i)=>({url:'https://example.com/'+i+'.png'}))]){const p=structuredClone(f.project);change(p.nodes[1]);await assert.rejects(f.runner.plan(p));}assert.equal(f.state.calls.length,0);
 const local=await fixture(t,'comfy'),b=local.node.params.workflowBinding,template=await local.generation.template(b.workflowId);await local.generation.configure(template.id,{revision:0,fields:[{nodeId:'2',name:'text',control:'textarea',label:'提示词',exposed:false,defaultValue:'original prompt'}]});await assert.rejects(local.runner.plan(local.project));assert.equal(local.state.calls.length,0);
});
test('停止和重建执行器后查询原ModelScope编号，无重新提交或素材上传',async t=>{
 const f=await fixture(t);f.state.pending=true;const j=await f.runner.start(f.project,credentials(f,await f.runner.plan(f.project)),f.endpoint);await wait(f,j.id,()=>f.state.queries.length);f.activeJobs.get(j.id).controller.abort();const stopped=await done(f,j.id);await idle(f);await fs.rename(path.join(f.data,'assets',f.asset.id),path.join(f.data,'assets',f.asset.id+'.preserved'));
 const runner=canvasRunner({...f,pollInterval:10});f.state.pending=false;await runner.resume(j.id,credentials(f,stopped.steps));const result=await done(f,j.id);assert.equal(result.status,'completed',result.message);assert.equal(f.state.calls.length,1);assert.equal(new Set(f.state.queries).size,1);await noKey(f.data);
});
test('ModelScope提交结果不确定且无编号时，恢复不重发',async t=>{
 const f=await fixture(t);f.state.uncertain=true;const j=await f.runner.start(f.project,credentials(f,await f.runner.plan(f.project)),f.endpoint),stopped=await done(f,j.id);await idle(f);await f.runner.resume(j.id,credentials(f,stopped.steps));const result=await done(f,j.id);assert.match(result.message,/不会自动重发/);assert.equal(f.state.calls.length,1);await noKey(f.data);
});
test('动态语言模型文字与机位只各传递一次，直接图片上下文也包含机位',async t=>{
 const f=await fixture(t),llm=makeNode('script',0,200,{text:'原始LLM指令'});llm.params.llmBinding={platform:{id:'chat',name:'本机模拟',protocol:'openai-compatible',baseUrl:f.endpoint+'/v1',models:[{id:'chat-test',category:'chat'}]},model:'chat-test',stream:false,referenceSources:[]};f.project.nodes.unshift(llm);f.project.edges.push({id:'llm-angle',source:llm.id,target:f.node.id});f.node.params.studioBinding.includeUpstream=true;
 const plan=await f.runner.plan(f.project),body=credentials(f,plan);body.llmCredentials=[{nodeId:llm.id,apiKey:key,authorization:{origin:f.endpoint,model:'chat-test',sendPrompt:true,sendReferences:false,requestLimit:1,budget:1,currency:'CNY'}}];const j=await f.runner.start(f.project,body,f.endpoint),result=await done(f,j.id);assert.equal(result.status,'completed',result.message);const prompt=f.state.calls.find(c=>c.url==='/v1/images/generations').body.prompt;assert.match(prompt,/生成后的光线描述/);assert.doesNotMatch(prompt,/原始LLM指令/);assert.equal(prompt.split('向右旋转').length-1,1);assert.match(resolveImageContext(f.project,f.node.id).prompt,/向右旋转/);await noKey(f.data);
});
test('复制、完整备份和重导入保留角度及原图引用，导入后可执行',async t=>{
 const f=await fixture(t),copy=copySelectedNodes(f.project,[f.source.id,f.node.id]),added=copy.nodes.filter(n=>!f.project.nodes.some(x=>x.id===n.id));assert.equal(added[1].params.studioBinding.referenceSources[0].sourceNodeId,added[0].id);assert.deepEqual(added[1].params.cameraAngle,f.node.params.cameraAngle);
 f.node.params.studioBinding.referenceSources=[{assetId:f.asset.id}];const {projectBundleService}=await import('../lib/project-bundles.mjs'),bundles=projectBundleService(f),out=await bundles.exportBundle(f.project.id,0),data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-angle-import-')),activeJobs=new Map();let imported;const projects={load:async()=>{if(imported)return imported;throw Object.assign(Error('missing'),{status:404});},save:async p=>(imported=p)},target=projectBundleService({data,activeJobs,projects}),preview=await target.upload(createReadStream(await bundles.download(out.id))),p=await target.importBundle(preview.id);assert.deepEqual(p.nodes[1].params.cameraAngle,f.node.params.cameraAngle);assert.notEqual(p.nodes[1].params.studioBinding.referenceSources[0].assetId,f.asset.id);
 const creationStudio=creationStudioService({data,activeJobs,pollInterval:10}),runner=canvasRunner({data,activeJobs,generation:generationService({data,activeJobs}),creationStudio,pollInterval:10}),ff={...f,data,project:p};const j=await runner.start(p,credentials(ff,await runner.plan(p)),f.endpoint),result=await done(ff,j.id);assert.equal(result.status,'completed',result.message);await noKey(data);
});
