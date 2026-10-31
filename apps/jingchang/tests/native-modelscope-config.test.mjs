import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {nativeModelscopeParameters,nativeWorkflowSettings} from '../public/native-workflow-config.js';
import {normalizeNativeModelscopeConfig,normalizeNativeModelscopeSize,nativeModelscopeModel,studioRequestCount,studioModelscopeReferenceLimit} from '../public/native-modelscope-core.js';
import {nativeCanConfigure,nativeNodeIssues} from '../public/native-canvas-core.js';
import {normalizeNativeWorkflow,nativeToFragment,fragmentToNative} from '../lib/native-canvas-core.mjs';

const node=settings=>({id:'smart',params:{nativeCanvas:{node:{id:'smart',type:'smart-image',runSettings:{engine:'modelscope',...settings}},adaptation:'reference',mediaAssetIds:[],missingResources:[],outgoingMedia:false,connectedOutput:false,connectedGroup:false}}});
const marker=(modelKey='zimage')=>({version:1,modelKey,acceptsImages:modelKey!=='zimage'});
const studio=(modelKey='zimage',count=1)=>({mode:'image',config:{protocol:'modelscope',nativeModelscope:marker(modelKey),count,size:'1024x1024'}});

test('固定源码四个模型编号与所需参考语义，不猜测custom平台默认模型',async()=>{
 const source=await readFile(new URL('./fixtures/reference/05-smart-canvas.js',import.meta.url),'utf8');
 for(const [key,id,accepts,required]of [['zimage','Tongyi-MAI/Z-Image-Turbo',false,false],['qwen_edit','Qwen/Qwen-Image-Edit-2511',true,true],['klein_edit','black-forest-labs/FLUX.2-klein-9B',true,true],['custom','',true,false]]){
  assert.ok(source.includes(id||"custom: { label:tr('smart.custom')"));
  assert.deepEqual(nativeModelscopeModel(marker(key)),{modelKey:key,modelId:id,acceptsImages:accepts,requiresImages:required});
  const plan=nativeModelscopeParameters(node({msgenModel:key,...(key==='custom'?{msCustomModel:'user/explicit-model'}:{})}));
  assert.deepEqual(plan.issues,[]);assert.equal(plan.config.model,id||'user/explicit-model');assert.equal(plan.requiresImages,required);assert.equal(plan.maxReferences,accepts?20:0);
 }
 const unspecified=nativeModelscopeParameters(node({msgenModel:'custom'}));assert.ok(unspecified.unsupported.includes('custom-model'));assert.equal(unspecified.config.model,'');
});

test('27组固定画幅尺寸逐项保留，与旧默认1024正方形分开',()=>{
 const golden={square:['1024x1024','2048x2048','4096x4096'],portrait:['1024x1536','1360x2048','2352x3520'],portrait43:['1008x1344','1536x2048','2448x3264'],landscape43:['1344x1008','2048x1536','3264x2448'],landscape:['1536x1024','2048x1360','3520x2352'],story:['720x1280','1152x2048','2160x3840'],wide:['1280x720','2048x1152','3840x2160'],ultrawide:['1280x544','2048x880','3840x1648'],ultratall:['544x1280','880x2048','1648x3840']};
 for(const [msRatio,sizes]of Object.entries(golden))for(const [index,msResolution]of ['1k','2k','4k'].entries()){
  const plan=nativeModelscopeParameters(node({msRatio,msResolution}));assert.deepEqual(plan.issues,[]);assert.equal(plan.config.size,sizes[index],msRatio+' '+msResolution);
 }
});

test('自定义/原图比例直接对照固定源码纯函数，保留长边像素限制及16取整',async()=>{
 // Execute only the pinned size calculation, never the source application or
 // a reimplemented oracle. These functions contain no network/file calls.
 const source=await readFile(new URL('./fixtures/reference/05-smart-canvas.js',import.meta.url),'utf8');
 const constants=['SIZE_MAP','RES_LONG_SIDE','RES_PIXEL_LIMIT'].map(name=>source.match(new RegExp('const '+name+' = ([\\s\\S]*?);'))?.[0]);
 const functions=['parseSizeValue','parseRatioValue','apiImageSize'].map(name=>source.slice(source.indexOf('function '+name+'('),source.indexOf('\nfunction ',source.indexOf('function '+name+'(')+1)));
 assert.ok(constants.every(Boolean));const context=vm.createContext({});vm.runInContext([...constants,...functions].join('\n'),context);
 for(const msRatio of ['custom','source'])for(const msResolution of ['1k','2k','4k'])for(const msCustomRatio of ['3:2','2:3','1:1','21:9','0.02:1','1*0.02']){
  const plan=nativeModelscopeParameters(node({msRatio,msResolution,msCustomRatio}));assert.deepEqual(plan.issues,[]);assert.equal(plan.config.size,context.apiImageSize(msRatio,msResolution,msCustomRatio,''));
 }
 assert.equal(nativeModelscopeParameters(node({msRatio:'custom',msResolution:'1k',msCustomRatio:'1:1'})).config.size,'1536x1248');
});

test('自定义尺寸保留任意源正整数，x/X/*只规范表示，不吸附16倍数',()=>{
 for(const [msCustomSize,size]of [['641x1279','641x1279'],[' 0637 X 01237 ','637x1237'],['1 * 1','1x1']]){
  const plan=nativeModelscopeParameters(node({msResolution:'custom',msCustomSize}));assert.deepEqual(plan.issues,[]);assert.equal(plan.config.size,size);
 }
 for(const size of ['auto','0x10','-5x10','1.5x4','10x0','100000x20',' 20x20','20X20'])assert.throws(()=>normalizeNativeModelscopeSize(size));
});

test('普通原生数量1到8用于独立请求；旧协议/旧ModelScope仍只算一次请求',()=>{
 for(let count=1;count<=8;count++){
  const plan=nativeModelscopeParameters(node({count}));assert.deepEqual(plan.issues,[]);assert.equal(plan.config.count,count);assert.equal(studioRequestCount({mode:'image',config:plan.config}),count);
 }
 assert.equal(studioRequestCount({mode:'image',config:{protocol:'modelscope',count:4}}),1);
 for(const protocol of ['studio','ark','apimart','gemini','midjourney'])assert.equal(studioRequestCount({mode:'image',config:{protocol,count:4,nativeModelscope:marker()}}),1);
 for(const count of [0,9,1.5,'3',NaN])assert.throws(()=>studioRequestCount({...studio(),config:{...studio().config,count}}));
 assert.throws(()=>studioRequestCount({...studio(),mode:'video'}));
});

test('原生20图范围只有验证后的marker启用，ZImage为零图，legacy三图',()=>{
 assert.equal(studioModelscopeReferenceLimit({mode:'image',config:{protocol:'modelscope'}}),3);
 assert.equal(studioModelscopeReferenceLimit(studio('zimage')),0);
 for(const key of ['qwen_edit','klein_edit','custom'])assert.equal(studioModelscopeReferenceLimit(studio(key)),20);
 for(const value of [null,{},[],'marker',{...marker(),version:2},{...marker(),acceptsImages:true},{...marker('custom'),acceptsImages:false},{...marker(),apiKey:'synthetic-forbidden'},{...marker(),modelKey:'__proto__'}]){
  assert.throws(()=>normalizeNativeModelscopeConfig(value));assert.throws(()=>studioModelscopeReferenceLimit({mode:'image',config:{protocol:'modelscope',nativeModelscope:value}}));
 }
 const value=marker('qwen_edit'),before=structuredClone(value);assert.deepEqual(normalizeNativeModelscopeConfig(value),before);assert.deepEqual(value,before);
});

test('转换只带显式服务与价格，原版LoRA、地址、密钥均不自动迁入',t=>{
 let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;throw Error('纯转换禁止网络');});
 const n=node({count:3,msRatio:'story',msResolution:'2k',loras:{'source/lora':1},endpoint:'https://source.invalid',apiKey:'synthetic-source'}),before=structuredClone(n);
 const plan=nativeModelscopeParameters(n,{baseUrl:'https://user-selected.invalid/v1',unitPrice:.5,currency:'CNY',apiKey:'synthetic-runtime',authorization:{budget:4},credentialId:'secret-record',loras:{'other/lora':1},model:'wrong/default'});
 assert.equal(plan.config.baseUrl,'https://user-selected.invalid/v1');assert.equal(plan.config.unitPrice,.5);assert.equal(plan.config.currency,'CNY');assert.deepEqual(plan.config.loras,{});assert.equal(plan.config.count,3);assert.equal(plan.config.size,'1152x2048');assert.equal(plan.config.model,'Tongyi-MAI/Z-Image-Turbo');assert.equal(calls,0);
 assert.doesNotMatch(JSON.stringify(plan),/synthetic|secret-record|source.invalid|source\/lora|other\/lora/);assert.deepEqual(n,before);
 assert.equal(nativeModelscopeParameters(node({})).config.baseUrl,undefined);
});

test('已有binding保留旧count/尺寸/marker语义，不自动用原runSettings覆盖',()=>{
 const n=node({count:8,msRatio:'wide',msResolution:'4k'}),existing={protocol:'modelscope',model:'selected/legacy',count:1,size:'1024x1024',baseUrl:'https://previous.invalid',unitPrice:.2,currency:'USD',apiKey:'synthetic-dropped'};
 n.params.studioBinding={mode:'image',config:existing,referenceSources:[{assetId:'original'}]};const before=structuredClone(n),plan=nativeModelscopeParameters(n,{baseUrl:'https://new.invalid'});
 assert.equal(plan.alreadyConfigured,true);assert.equal(plan.mayFill,false);assert.deepEqual(plan.config,{protocol:'modelscope',model:'selected/legacy',count:1,size:'1024x1024',baseUrl:'https://previous.invalid',unitPrice:.2,currency:'USD'});assert.equal(plan.config.nativeModelscope,undefined);assert.deepEqual(n,before);
});

test('已选服务或现绑定的认证URL、嵌套凭据不进入迁移预览，原记录保持',()=>{
 for(const baseUrl of ['https://user:synthetic-private@selected.invalid/v1','https://selected.invalid/v1?api_key=synthetic-private']){
  const plan=nativeModelscopeParameters(node({}),{baseUrl,unitPrice:0,currency:'CNY'});assert.ok(plan.unsupported.includes('private-config'));assert.equal(plan.config.baseUrl,undefined);assert.doesNotMatch(JSON.stringify(plan),/synthetic-private/);
 }
 const n=node({count:{apiKey:'synthetic-private'},msCustomRatio:{token:'synthetic-private'}});n.params.studioBinding={mode:'image',config:{protocol:'modelscope',baseUrl:'https://safe.invalid',count:1,loras:{nested:{apiKey:'synthetic-private'}}}};
 const before=structuredClone(n),plan=nativeModelscopeParameters(n);assert.equal(plan.alreadyConfigured,true);assert.ok(plan.unsupported.includes('private-config'));assert.doesNotMatch(JSON.stringify(plan),/synthetic-private/);assert.deepEqual(n,before);
});

test('无效/未知源参数明确保留为unsupported，不静默猜测大小、模型或count',()=>{
 for(const settings of [{msgenModel:'unknown'},{msgenModel:'custom',msCustomModelId:'not-the-source-field'},{msRatio:'not-a-ratio'},{msResolution:'auto'},{msResolution:'custom',msCustomSize:'bad'},{msResolution:'custom',msCustomSize:'0x20'},{msRatio:'source',msCustomRatio:''},{msRatio:'custom',msCustomRatio:'Infinity:1'},{count:9},{count:1.5},{count:'invalid'}]){
  const n=node(settings),before=structuredClone(n),plan=nativeModelscopeParameters(n);assert.ok(plan.issues.length>0,JSON.stringify(settings));assert.equal(plan.unsupported.length,plan.issues.length);assert.deepEqual(n,before);
 }
 assert.equal(nativeModelscopeParameters(node({engine:'api'})),null);assert.equal(nativeWorkflowSettings(node({}),'modelscope').engine,'modelscope');
});

test('智能素材仅确认的ModelScope原生studio配置放行，任意协议绑定仍阻止',()=>{
 const n=node({msgenModel:'qwen_edit',count:3});assert.equal(nativeCanConfigure(n),true);assert.match(nativeNodeIssues(n).join(''),/尚待迁移/);n.params.nativeCanvas.adaptation='configured';
 for(const binding of [undefined,{mode:'image',config:{protocol:'studio'}},{mode:'image',config:{protocol:'modelscope',model:'Qwen/Qwen-Image-Edit-2511',count:1,size:'1024x1024'}}]){n.params.studioBinding=binding;assert.ok(nativeNodeIssues(n).length);}
 n.params.studioBinding={mode:'image',config:nativeModelscopeParameters(node({msgenModel:'qwen_edit',count:3})).config};assert.deepEqual(nativeNodeIssues(n),[]);
 n.params.studioBinding.config.model='wrong/model';assert.match(nativeNodeIssues(n).join(''),/模型编号/);n.params.studioBinding.config.model='Qwen/Qwen-Image-Edit-2511';n.params.studioBinding.config.nativeModelscope=marker('zimage');assert.match(nativeNodeIssues(n).join(''),/标记与原设置不符/);
 n.params.studioBinding.config.nativeModelscope=marker('qwen_edit');n.params.workflowBinding={workflowId:'conflicting'};assert.match(nativeNodeIssues(n).join(''),/绑定冲突/);
 assert.equal(nativeCanConfigure(node({engine:'some-new-protocol'})),false);
});

test('未迁移源runSettings完整往返，转换不改源值或原生工作流导出',()=>{
 const runSettings={engine:'modelscope',msgenModel:'custom',msCustomModel:'author/explicit',count:7,msRatio:'custom',msResolution:'2k',msCustomRatio:'2:3',msCustomRatioWidth:2,msCustomRatioHeight:3,msCustomSize:'',msCustomWidth:'',msCustomHeight:'',userFutureValue:{kept:'literal'},loras:{'author/source':1}};
 const source={id:'source',type:'smart-image',x:1,y:2,runSettings},project=nativeToFragment(normalizeNativeWorkflow({format:'infinite-smart-canvas-workflow',nodes:[source],connections:[]}),[],'原始设置');
 const before=structuredClone(project);nativeModelscopeParameters(project.nodes[0]);assert.deepEqual(project,before);assert.deepEqual(fragmentToNative(project,[]).nodes[0].runSettings,runSettings);
});
