import test from 'node:test';
import assert from 'node:assert/strict';
import {openAssetCatalog} from '../public/asset-catalog.js';

// Stop at the initial read. No dialog, browser, network or production data is
// needed to verify the opening lock and its release after a failed response.
function openingGate(t){
 const documentDescriptor=Object.getOwnPropertyDescriptor(globalThis,'document'),fetchDescriptor=Object.getOwnPropertyDescriptor(globalThis,'fetch');
 const requests=[],pending=[];const stopped=Error('synthetic initial catalogue read failed');
 Object.defineProperty(globalThis,'document',{configurable:true,writable:true,value:{querySelector:()=>null}});
 Object.defineProperty(globalThis,'fetch',{configurable:true,writable:true,value:url=>{if(url==='/api/health')return Promise.resolve(Response.json({ok:true,capabilities:{smartGroupStoredMedia:false}}));requests.push(url);return new Promise((resolve,reject)=>pending.push(reject));}});
 const rejectPending=()=>{for(const reject of pending.splice(0))reject(stopped);};
 t.after(()=>{rejectPending();if(documentDescriptor)Object.defineProperty(globalThis,'document',documentDescriptor);else Reflect.deleteProperty(globalThis,'document');if(fetchDescriptor)Object.defineProperty(globalThis,'fetch',fetchDescriptor);else Reflect.deleteProperty(globalThis,'fetch');});
 return{requests,rejectPending,stopped};
}
async function waitRequests(g,count){for(let i=0;i<100&&g.requests.length<count;i++)await Promise.resolve();assert.equal(g.requests.length,count);}

test('素材库窗口准备期间连续打开共用一轮读取，不建立第二个迁入控制器',async t=>{
 const g=openingGate(t),first=openAssetCatalog({projectId:'synthetic-project'}),second=openAssetCatalog({projectId:'synthetic-project'}),settled=Promise.allSettled([first,second]);
 await waitRequests(g,1);const requestCount=g.requests.length;g.rejectPending();const results=await settled;
 assert.equal(requestCount,1);assert.equal(results.length,2);assert.equal(results[0].status,'rejected');assert.equal(results[0].reason.message,g.stopped.message);if(results[1].status==='rejected')assert.equal(results[1].reason.message,g.stopped.message);else assert.equal(results[1].value,undefined);assert.deepEqual(g.requests,['/api/asset-catalog']);
});

test('首次打开读取失败会释放opening锁，用户再次打开发起一轮新读取',async t=>{
 const g=openingGate(t),first=openAssetCatalog({projectId:'synthetic-project'}),failed=assert.rejects(first,/synthetic initial catalogue read failed/);await waitRequests(g,1);g.rejectPending();await failed;
 const second=openAssetCatalog({projectId:'synthetic-project'}),retried=assert.rejects(second,/synthetic initial catalogue read failed/);await waitRequests(g,2);g.rejectPending();await retried;
});
