import test from 'node:test';
import assert from 'node:assert/strict';
import {runNativeModelscopeBatch,validateNativeModelscopeBatch} from '../lib/native-modelscope-batch.mjs';

const studio={mode:'image',references:[],config:{protocol:'modelscope',baseUrl:'https://isolated.invalid/v1',currency:'CNY',model:'test/explicit',count:1,size:'641x1279',nativeModelscope:{version:1,modelKey:'custom',acceptsImages:true}}};
const job=()=>({kind:'studio',input:{studio},authorization:{origin:'https://isolated.invalid',model:'test/explicit',currency:'CNY',budget:1,sendPrompt:true,sendReferences:false,requestLimit:1},requestCount:0,items:[{index:0,status:'unsubmitted',assets:[]}],assets:[],status:'running'});
const asset={id:'stored-asset',type:'image/png'};
test('保存图片后收据写入失败不把完整份改成failed，原任务恢复复用已保存结果',async()=>{
 const j=job();let submits=0,queries=0,stores=0;
 const common={job:j,studio,images:[],signal:new AbortController().signal,pollInterval:1,submit:async()=>{submits++;return{upstreamId:'original-id'};},query:async()=>{queries++;return{status:'completed',images:[{}]};},store:async()=>{stores++;return asset;}};
 await assert.rejects(runNativeModelscopeBatch({...common,resuming:false,persist:async value=>{if(value.items[0].status==='completed')throw Error('isolated receipt-write failure');}}),/receipt-write/);
 assert.equal(j.items[0].status,'completed');assert.deepEqual(j.assets,[asset]);validateNativeModelscopeBatch(j);
 await runNativeModelscopeBatch({...common,resuming:true,persist:async()=>{}});assert.deepEqual(j.assets,[asset]);assert.equal(submits,1);assert.equal(queries,1);assert.equal(stores,1);
});
test('failed状态持有图片的矛盾收据在恢复前拒绝，避免重复保存',()=>{
 const j=job();j.requestCount=1;j.items=[{index:0,status:'failed',upstreamId:'original-id',assets:[asset]}];j.assets=[asset];assert.throws(()=>validateNativeModelscopeBatch(j),/结果收据/);
});
