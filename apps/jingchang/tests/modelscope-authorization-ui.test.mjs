import test from 'node:test';
import assert from 'node:assert/strict';
import {studioAuthorizationMarkup,readStudioCredentials,studioBindingAction} from '../public/canvas-studio.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const marker={version:1,modelKey:'custom',acceptsImages:true};
const step=(count=8,config={})=>({kind:'studio',nodeId:'node-ms',title:'原节点图片',status:'ready',text:'本次完整上游文字',sendAssets:true,studio:{mode:'image',config:{protocol:'modelscope',baseUrl:'https://example.invalid/v1',model:'synthetic-image-model',size:'2048x1152',count,unitPrice:0.5,currency:'CNY',nativeModelscope:marker,...config},referenceSources:Array.from({length:20},(_,i)=>({assetId:'asset-'+i}))},nativeReferences:{details:Array.from({length:20},(_,i)=>({kind:'image',assetId:'asset-'+i,name:'参考'+(i+1)}))}});
function withGlobals(t,values){for(const [name,value] of Object.entries(values)){const previous=globalThis[name];globalThis[name]=value;t.after(()=>{if(previous===undefined)delete globalThis[name];else globalThis[name]=previous;});}}
function authRow(s,{consent=true,budget='5',key='synthetic-ui-only'}={}){
 const credential={querySelector:selector=>selector==='[data-manual-key]'?{value:key}:null};
 return{dataset:{studioAuth:s.executionId||s.nodeId},querySelector:selector=>({'[name=studio-node-consent]':{checked:consent},'[name=studio-node-budget]':{value:budget},'[data-ark-credential]':credential}[selector]||null)};
}

test('原 ModelScope 授权显示真实8份、尺寸、完整20图与不重试说明，预算按8次估算',()=>{
 const s=step(),before=structuredClone(s),html=studioAuthorizationMarkup([s],esc);
 assert.match(html,/最多提交8次生成（8份独立请求）/);assert.match(html,/尺寸：2048x1152/);assert.match(html,/最多20张/);assert.match(html,/每份使用同一清单/);assert.match(html,/参考估算 4/);assert.match(html,/失败时停止，不自动重试/);
 for(let i=1;i<=20;i++)assert.match(html,new RegExp('参考'+i+'<'));
 assert.deepEqual(s,before);
});

test('授权份数与共享后端口径一致1–8，旧 ModelScope 和其他协议仍为1次',t=>{
 const cases=[...Array.from({length:8},(_,i)=>step(i+1)),step(4,{nativeModelscope:undefined}),step(4,{protocol:'studio'})];
 cases.forEach((s,i)=>s.executionId='execution-'+i);const rows=cases.map(s=>authRow(s));withGlobals(t,{document:{querySelectorAll:()=>rows}});
 const result=readStudioCredentials(cases);assert.deepEqual(result.map(r=>r.authorization.requestLimit),[1,2,3,4,5,6,7,8,1,1]);
 assert.deepEqual(result[7].authorization,{origin:'https://example.invalid',model:'synthetic-image-model',sendPrompt:true,sendReferences:true,requestLimit:8,budget:5,currency:'CNY'});
 assert.match(studioAuthorizationMarkup([cases[8]],esc),/最多3张/);assert.match(studioAuthorizationMarkup([cases[9]],esc),/参考估算 2/);
});

test('循环执行副本只授权本轮1份，不改已保存原份数',t=>{
 const saved=step(8),s=structuredClone(saved);s.studio.config.count=1;s.loopId='loop';s.roundIndex=1;s.roundCount=3;
 withGlobals(t,{document:{querySelectorAll:()=>[authRow(s)]}});
 assert.equal(readStudioCredentials([s])[0].authorization.requestLimit,1);assert.match(studioAuthorizationMarkup([s],esc),/本轮1份，原保存份数保留/);assert.equal(saved.studio.config.count,8);
});

test('原子任务仅查询；原画布未提交步骤显示原计划范围，凭据读取不创建新授权',t=>{
 const s=step();s.jobId='existing-receipt';s.authorization={budget:4,currency:'CNY'};
 const row=authRow(s);row.querySelector=new Proxy(row.querySelector,{apply(target,that,args){if(args[0]==='[name=studio-node-budget]')throw Error('恢复不可读取新预算');return Reflect.apply(target,that,args);}});
 withGlobals(t,{document:{querySelectorAll:()=>[row]}});
 const result=readStudioCredentials([s],true);assert.equal(Object.hasOwn(result[0],'authorization'),false);
 for(const jobId of ['existing-receipt',undefined]){s.jobId=jobId;const html=studioAuthorizationMarkup([s],esc,true);assert.doesNotMatch(html,/name="studio-node-budget"/);if(jobId){assert.match(html,/本次0份新生成/);assert.match(html,/没有可查询编号则保持停止，不重发生成/);assert.doesNotMatch(html,/最多提交8次/);}else{assert.match(html,/继续原画布中尚未提交的步骤/);assert.match(html,/最多提交8次生成/);assert.match(html,/原授权预算：4 CNY/);assert.doesNotMatch(html,/本次0份新生成|仅查询原任务/);}}
});

test('未确认、无效预算、非法迁移标记或份数均停止读取，字符串字段完整转义',t=>{
 const s=step();let row=authRow(s,{consent:false});withGlobals(t,{document:{querySelectorAll:()=>[row]}});
 assert.throws(()=>readStudioCredentials([s]),/逐个确认/);row=authRow(s,{budget:'NaN'});assert.throws(()=>readStudioCredentials([s]),/填写节点预算/);
 row=authRow(s);s.studio.config.count=9;assert.throws(()=>readStudioCredentials([s]),/1–8/);s.studio.config.count=1;s.studio.config.nativeModelscope={...marker,endpoint:'forbidden'};assert.throws(()=>studioAuthorizationMarkup([s],esc),/标记无效/);
 s.studio.config.nativeModelscope=marker;s.studio.config.size='<img src=x>';s.title='<script>';s.nativeReferences.details[0].name='<svg>';const html=studioAuthorizationMarkup([s],esc);assert.doesNotMatch(html,/<img|<script|<svg/);assert.match(html,/&lt;img/);
});

// This narrow DOM double exercises the actual populate/save handler without
// loading a browser, opening a port, or executing any provider request.
function bindingDom(){
 const elements={},names=['preset','protocol','baseUrl','model','includeUpstream','duration','resolution','operation','arkReferenceMode','ratio','unitPrice','currency','size','count','quality','imageResolution','generateAudio','imageAsync','transparent','loras'];
 for(const name of names){let value='',options;const input={type:['generateAudio','imageAsync','transparent'].includes(name)?'checkbox':'text',checked:false,closest:()=>({style:{}})};Object.defineProperties(input,{value:{get:()=>value,set:v=>{value=options&&!options.includes(String(v))?'':String(v);}},innerHTML:{get:()=>options?.join(',')||'',set:html=>{options=[...html.matchAll(/value="([^"]*)"/g)].map(m=>m[1]);value=options[0]||'';}}});elements[name]=input;}
 let installed=false;const add={};const host={dataset:{mediaUrls:'false'},querySelector:()=>add,querySelectorAll:()=>[]};
 const form={elements,reportValidity:()=>true,references:[],querySelector:selector=>selector==='[data-reference-fields]'&&installed?host:null,querySelectorAll:selector=>selector==='[data-reference-fields] select'?form.references.map(source=>({value:'asset:'+source.assetId})):[]};
 const refs={};Object.defineProperty(refs,'innerHTML',{set:()=>{installed=true;}});
 const nodes={'#studio-binding':form,'#studio-price-label':{firstChild:{}},'#canvas-midjourney-fields':{},'#studio-binding-help':{},'#studio-native-modelscope':{},'#studio-reference-list':refs,'#modal':{close(){}}};
 const document={querySelector:selector=>nodes[selector]||null};
 class LocalFormData{constructor(form){this.entries=Object.entries(form.elements).filter(([,input])=>input.type!=='checkbox'||input.checked).map(([key,input])=>[key,input.type==='checkbox'?'on':input.value]);}get(key){return this.entries.find(x=>x[0]===key)?.[1]??null;}has(key){return this.entries.some(x=>x[0]===key);}[Symbol.iterator](){return this.entries[Symbol.iterator]();}}
 return{document,FormData:LocalFormData,form,nodes};
}
function node(settings={},binding){return{id:'native-ms',type:'image',params:{nativeCanvas:{node:{id:'original-ms',type:'smart-image',runSettings:{engine:'modelscope',msgenModel:'custom',msCustomModel:'synthetic-original-model',msRatio:'wide',msResolution:'2k',count:7,...settings}}},...(binding?{studioBinding:binding}:{})}};}
function context(n){const project={id:'synthetic-project',nodes:[n],edges:[],assets:[]},events={saved:0,checkpoint:0,html:''};return{events,ctx:{getProject:()=>project,getSelected:()=>n.id,api:async()=>[],modal:(_title,html)=>{events.html=html;},esc,checkpoint:()=>events.checkpoint++,changed(){},save:async()=>events.saved++,toast(){}}};}

test('绑定面板回填原模型/宽高/7份，保留明确服务地址并保存安全迁移标记',async t=>{
 const dom=bindingDom();withGlobals(t,{document:dom.document,FormData:dom.FormData});const n=node(),original=structuredClone(n.params.nativeCanvas),{ctx,events}=context(n);
 await studioBindingAction('bind-studio-node',ctx);const e=dom.form.elements;assert.equal(e.model.value,'synthetic-original-model');assert.equal(e.size.value,'2048x1152');assert.equal(e.count.value,'7');assert.equal(e.baseUrl.value,'');assert.equal(dom.form.querySelector('[data-reference-fields]').dataset.max,'20');assert.match(dom.nodes['#studio-binding-help'].textContent,/1–8份/);assert.doesNotMatch(events.html,/type="password"/);
 e.baseUrl.value='https://example.invalid/user-selected/v1';await e.preset.onchange();assert.equal(e.baseUrl.value,'https://example.invalid/user-selected/v1');await studioBindingAction('save-studio-binding',ctx);
 assert.equal(n.params.studioBinding.config.baseUrl,'https://example.invalid/user-selected/v1');assert.equal(n.params.studioBinding.config.count,7);assert.equal(n.params.studioBinding.config.size,'2048x1152');assert.deepEqual(n.params.studioBinding.config.nativeModelscope,marker);assert.deepEqual(n.params.nativeCanvas,original);assert.equal(events.saved,1);
});

test('旧绑定不被原节点参数覆盖，不启用迁移能力，也不填任何凭据',async t=>{
 const dom=bindingDom();withGlobals(t,{document:dom.document,FormData:dom.FormData});const binding={mode:'image',config:{protocol:'modelscope',baseUrl:'https://example.invalid/old/v1',model:'kept-model',size:'1024x1024',count:1,apiKey:'synthetic-never-rendered'},referenceSources:[]},n=node({},binding),{ctx,events}=context(n);
 await studioBindingAction('bind-studio-node',ctx);assert.equal(dom.form.elements.baseUrl.value,binding.config.baseUrl);assert.equal(dom.form.elements.model.value,'kept-model');assert.equal(dom.form.elements.count.innerHTML,'1');assert.equal(dom.form.nativeModelscopeConfig,undefined);assert.equal(dom.form.querySelector('[data-reference-fields]').dataset.max,'3');assert.doesNotMatch(events.html,/synthetic-never-rendered/);
 await studioBindingAction('save-studio-binding',ctx);assert.equal(Object.hasOwn(n.params.studioBinding.config,'apiKey'),false);assert.equal(Object.hasOwn(n.params.studioBinding.config,'nativeModelscope'),false);
});

test('原编辑模型无图时停止保存，显式20图可保存、21图停止；非法份数/尺寸停止',async t=>{
 const dom=bindingDom();withGlobals(t,{document:dom.document,FormData:dom.FormData});const n=node({msgenModel:'qwen_edit',count:8}),{ctx,events}=context(n);await studioBindingAction('bind-studio-node',ctx);dom.form.elements.baseUrl.value='https://example.invalid/v1';
 await assert.rejects(studioBindingAction('save-studio-binding',ctx),/至少1张参考图/);assert.equal(events.saved,0);
 dom.form.references=Array.from({length:20},(_,i)=>({assetId:'asset-'+i}));await studioBindingAction('save-studio-binding',ctx);assert.equal(n.params.studioBinding.referenceSources.length,20);assert.equal(events.saved,1);
 dom.form.references.push({assetId:'asset-20'});await assert.rejects(studioBindingAction('save-studio-binding',ctx),/最多20张/);dom.form.references.pop();dom.form.elements.count.value='9';await assert.rejects(studioBindingAction('save-studio-binding',ctx),/1–8/);dom.form.elements.count.value='8';dom.form.elements.size.value='auto';await assert.rejects(studioBindingAction('save-studio-binding',ctx),/尺寸须/);assert.equal(events.saved,1);
});

test('文字预设不接受图片，0图上限与旧3图及其他协议容量保持一致',async t=>{
 const dom=bindingDom();withGlobals(t,{document:dom.document,FormData:dom.FormData});const n=node({msgenModel:'zimage',count:2}),{ctx,events}=context(n);await studioBindingAction('bind-studio-node',ctx);dom.form.elements.baseUrl.value='https://example.invalid/v1';assert.equal(dom.form.querySelector('[data-reference-fields]').dataset.max,'0');
 dom.form.references=[{assetId:'unsupported-image'}];await assert.rejects(studioBindingAction('save-studio-binding',ctx),/最多0张/);assert.equal(events.saved,0);dom.form.references=[];await studioBindingAction('save-studio-binding',ctx);assert.deepEqual(n.params.studioBinding.config.nativeModelscope,{version:1,modelKey:'zimage',acceptsImages:false});
 const {studioImageReferenceLimit}=await import('../public/reference-limits.js');for(const [studio,expected] of [[{mode:'image',config:{protocol:'modelscope'}},3],[{mode:'image',config:{protocol:'modelscope',nativeModelscope:marker}},20],[{mode:'image',config:{protocol:'studio'}},20],[{mode:'image',config:{protocol:'gemini'}},4],[{mode:'video',config:{protocol:'ark',arkReferenceMode:'multimodal'}},9]])assert.equal(studioImageReferenceLimit(studio),expected);
});

test('无效原份数或尺寸不自动改为可提交默认值，用户显式修正后保留原记录',async t=>{
 const dom=bindingDom();withGlobals(t,{document:dom.document,FormData:dom.FormData});const n=node({count:9,msResolution:'custom',msCustomSize:'invalid'}),before=structuredClone(n.params.nativeCanvas),{ctx,events}=context(n);await studioBindingAction('bind-studio-node',ctx);dom.form.elements.baseUrl.value='https://example.invalid/v1';assert.equal(dom.form.elements.count.value,'');assert.equal(dom.form.elements.size.value,'');assert.match(dom.nodes['#studio-native-modelscope'].textContent,/请先修正/);
 await assert.rejects(studioBindingAction('save-studio-binding',ctx),/尺寸须/);dom.form.elements.size.value='1280x720';await assert.rejects(studioBindingAction('save-studio-binding',ctx),/1–8/);assert.equal(events.saved,0);dom.form.elements.count.value='8';await studioBindingAction('save-studio-binding',ctx);assert.equal(n.params.studioBinding.config.count,8);assert.equal(n.params.studioBinding.config.size,'1280x720');assert.deepEqual(n.params.nativeCanvas,before);
});

test('未知原模型不能按回退预设宣称完成，停止保存且原节点保持完整',async t=>{
 const dom=bindingDom();withGlobals(t,{document:dom.document,FormData:dom.FormData});const n=node({msgenModel:'unknown-future-model'}),before=structuredClone(n),{ctx,events}=context(n);await studioBindingAction('bind-studio-node',ctx);dom.form.elements.baseUrl.value='https://example.invalid/v1';await assert.rejects(studioBindingAction('save-studio-binding',ctx),/模型类型尚未支持/);assert.deepEqual(n,before);assert.equal(events.saved,0);
});

test('原绑定含认证地址或私密LoRA字段时不把它们填回表单，修正只影响新绑定',async t=>{
 const dom=bindingDom();withGlobals(t,{document:dom.document,FormData:dom.FormData});const binding={mode:'image',config:{protocol:'modelscope',baseUrl:'https://example.invalid/v1?api_key=synthetic-private-only',model:'kept-model',size:'1024x1024',count:1,loras:{apiKey:'synthetic-private-only'}},referenceSources:[]},n=node({},binding),before=structuredClone(n.params.nativeCanvas),{ctx,events}=context(n);
 await studioBindingAction('bind-studio-node',ctx);assert.equal(dom.form.elements.baseUrl.value,'');assert.equal(dom.form.elements.loras.value,'{}');assert.doesNotMatch(events.html,/synthetic-private-only/);
 dom.form.elements.baseUrl.value='https://example.invalid/v1';await studioBindingAction('save-studio-binding',ctx);assert.equal(n.params.studioBinding.config.baseUrl,'https://example.invalid/v1');assert.deepEqual(n.params.nativeCanvas,before);
});
