import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {cascadeFixture} from './helpers/native-cascade-fixture.mjs';
import {storeAsset,atomicJson} from '../lib/workspace.mjs';
import {normalizeStudioBinding} from '../lib/canvas-studio.mjs';
import {planNativeCascade} from '../lib/native-cascade-plan.mjs';
import {createNativeCascadeState,executeNativeCascade} from '../lib/native-cascade-execution.mjs';
import {nativeCascadeRequestPreparer} from '../lib/native-cascade-requests.mjs';
import {nativeCascadeChildAdapter,cascadeChildRequestId} from '../lib/native-cascade-children.mjs';

// This audit runs the real preparer and public reconciliation path against a
// new local workspace. It never submits, queries, resolves a key or starts a
// service. The rejection assertions remain strict until the owner fixes the
// production integrity gap; a red audit is preserved as evidence, not success.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
const originalLoras={'audit/expected-lora':.6,'audit/original-second':.4};

async function fixture(){
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-modelscope-integrity-audit-'));
 const graph=cascadeFixture();graph.node('A');graph.node('B');graph.edge('A','B');
 const project=graph.project;
 for(const node of project.nodes){
  const asset=await storeAsset(data,png,{name:'synthetic-'+node.id+'.png',type:'image/png'});
  project.assets=project.assets.filter(a=>a.id!=='asset-'+node.id);project.assets.push(asset);
  node.params.nativeCanvas.resources[0].assetId=asset.id;
  node.params.nativeCanvas.mediaAssetIds=[asset.id];
 }
 const binding=normalizeStudioBinding({mode:'image',config:{protocol:'modelscope',model:'audit/explicit',baseUrl:'https://example.invalid/v1',count:1,size:'641x1279',imageAsync:true,quality:'auto',transparent:false,unitPrice:1,currency:'CNY',loras:originalLoras,nativeModelscope:{version:1,modelKey:'custom',acceptsImages:true}},referenceSources:[],includeUpstream:true});
 const source=graph.find('A');source.params.studioBinding=binding;
 source.params.nativeCanvas.adaptation='configured';
 source.params.nativeCanvas.node.runSettings={engine:'modelscope',msgenModel:'custom',msCustomModel:'audit/explicit',count:1,msResolution:'custom',msCustomSize:'641x1279'};
 const program=planNativeCascade(project,{nodeId:'B'}),state=createNativeCascadeState(project,program);
 const parentId='integrity-parent',childId='integrity-child',controller=new AbortController();let captured;
 await executeNativeCascade({project,program,state,signal:controller.signal,persist:async()=>{},generate:async request=>{
  captured=request;await request.onAccepted(childId);controller.abort();throw controller.signal.reason;
 }});
 assert.equal(state.status,'stopped');assert(captured);
 const forbidden=()=>{throw Error('audit must not invoke a provider or credential reader');};
 const preparer=nativeCascadeRequestPreparer({data,generation:{template:forbidden},cloudWorkflows:{get:forbidden},authorizationFor:async()=>({origin:'https://example.invalid',model:binding.config.model,sendPrompt:true,sendReferences:true,requestLimit:1,budget:1,currency:'CNY'})});
 const prepared=await preparer.prepare({...captured,project,signal:new AbortController().signal});
 const child={id:childId,kind:'studio',status:'running',projectId:project.id,studioId:parentId,parentId,nodeId:'A',requestId:cascadeChildRequestId(parentId,captured.operation.id),input:{studio:prepared.studio},authorization:prepared.body.authorization,requestCount:1,items:[{index:0,status:'pending',upstreamId:'synthetic-original-one',assets:[]}],assets:[]};
 const file=path.join(data,'jobs',childId+'.json');await atomicJson(file,child);
 const adapter=nativeCascadeChildAdapter({data,project,program,parentId,activeJobs:new Map(),prepare:forbidden,credentialsFor:forbidden,enhancementFor:()=>prepared.ledger});
 return{data,file,child,binding,prepared,adapter,state};
}

test('ModelScope integrity audit accepts unchanged authorized LoRA receipts',async()=>{
 const f=await fixture();await assert.doesNotReject(f.adapter.reconcile(f.state));
});

test('ModelScope actual input must preserve the exact approved LoRA parameters',async()=>{
 const f=await fixture();assert.deepEqual(f.prepared.ledger.modelscope.loras,originalLoras);
});

for(const [name,loras]of [['replaced',{'audit/replaced-lora':1}],['removed',{}],['weights-changed',{'audit/expected-lora':.5,'audit/original-second':.5}]])test('ModelScope resume reconciliation rejects '+name+' LoRA before any query or credential read',async()=>{
 const f=await fixture();f.child.input.studio.config.loras=loras;await atomicJson(f.file,f.child);
 await assert.rejects(f.adapter.reconcile(f.state),/LoRA|实际参数|实际收据|不一致|冲突/);
});

test('ModelScope resume reconciliation rejects changed actual LoRA ledger',async()=>{
 const f=await fixture();f.prepared.ledger.modelscope.loras={'audit/replaced-lora':1};
 await assert.rejects(f.adapter.reconcile(f.state),/LoRA|实际参数|实际收据|不一致|冲突/);
});

test('ModelScope same-value LoRA dictionaries accept reversed entry order',async()=>{
 const f=await fixture(),reversed=Object.fromEntries(Object.entries(originalLoras).reverse());
 f.child.input.studio.config.loras=reversed;f.prepared.ledger.modelscope.loras=reversed;await atomicJson(f.file,f.child);
 await assert.doesNotReject(f.adapter.reconcile(f.state));
});

test('ModelScope stored actual receipt also accepts same-value reversed LoRA order',async()=>{
 const f=await fixture();f.child.cascadeModelscope=structuredClone(f.prepared.ledger.modelscope);
 f.prepared.ledger.modelscope.loras=Object.fromEntries(Object.entries(originalLoras).reverse());
 await atomicJson(f.file,f.child);await assert.doesNotReject(f.adapter.reconcile(f.state));
});

test('ModelScope legacy actual receipt without LoRA still uses the original authorized binding',async()=>{
 const f=await fixture();delete f.prepared.ledger.modelscope.loras;
 await assert.doesNotReject(f.adapter.reconcile(f.state));
 f.child.input.studio.config.loras={};await atomicJson(f.file,f.child);
 await assert.rejects(f.adapter.reconcile(f.state),/LoRA|实际参数|实际收据|不一致|冲突/);
});

test('ModelScope integrity audit still rejects a changed model negative control',async()=>{
 const f=await fixture();f.child.input.studio.config.model='audit/different-model';await atomicJson(f.file,f.child);
 await assert.rejects(f.adapter.reconcile(f.state),/实际收据|不一致/);
});
