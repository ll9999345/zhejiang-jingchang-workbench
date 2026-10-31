import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeLibraryImportController} from '../public/native-library-import.js';
const projectId='synthetic-project',record={id:'preview-one',projectId,status:'checked',canImport:true,sourceDirectory:'/tmp/synthetic-canvas',counts:{libraries:2,folders:3,media:1,fragments:0,workflows:0},bytes:10,missing:[],unsupported:[],warnings:[]};

test('先检查再确认，只调用本机目录接口；完成后刷新目录且不重复迁入',async()=>{
 const calls=[];let notified=0;
 const c=createNativeLibraryImportController({projectId,api:async(url,payload)=>{calls.push({url,payload});if(url.endsWith('/preview'))return structuredClone(record);if(url==='/api/asset-catalog')return{revision:4};if(url.endsWith('/import'))return{id:record.id,status:'completed',libraryIds:['new-library'],alreadyPublished:false};throw Error('unexpected '+url);},onImport:()=>{notified++;}});
 await assert.rejects(c.preview(),/完整路径/);assert.equal(calls.length,0);
 c.setSource(record.sourceDirectory);await c.preview();assert.equal(c.snapshot().confirmed,false);
 await assert.rejects(c.import(),/勾选确认/);assert.equal(calls.length,1);
 c.setConfirmed(true);await c.import();assert.equal(c.snapshot().current.status,'completed');assert.equal(notified,1);
 assert.deepEqual(calls.at(-1).payload,{requestId:c.snapshot().current.importRequestId,projectId,revision:4,confirmLocalImport:true});
 await assert.rejects(c.import(),/先读取并通过检查/);assert.equal(calls.length,3);
 assert.ok(calls.every(x=>x.url.startsWith('/api/')));
});

test('响应丢失不自动重发，读取原记录后使用原 requestId 续办',async()=>{
 const calls=[];let first=true,originalId;
 const c=createNativeLibraryImportController({projectId,api:async(url,payload)=>{calls.push({url,payload});if(url.endsWith('/preview'))return structuredClone(record);if(url==='/api/asset-catalog')return{revision:3};if(url.endsWith('/import')){originalId??=payload.requestId;if(first){first=false;throw Error('响应中断');}assert.equal(payload.requestId,originalId);return{id:record.id,status:'completed'};}if(url.includes('/preview-one?'))return{...record,status:'interrupted',importRequestId:originalId};throw Error('unexpected');}});
 c.setSource(record.sourceDirectory);await c.preview();c.setConfirmed(true);await assert.rejects(c.import(),/响应中断/);
 assert.equal(c.snapshot().awaitingRead,true);assert.equal(calls.filter(x=>x.url.endsWith('/import')).length,1);
 await assert.rejects(c.import(),/先读取/);assert.equal(calls.filter(x=>x.url.endsWith('/import')).length,1);
 await c.read(record.id);assert.equal(c.snapshot().confirmed,false);c.setConfirmed(true);await c.import();
 assert.equal(calls.filter(x=>x.url.endsWith('/import')).length,2);
});

test('重开后只读取本机记录，保留原导入请求编号；拒绝错误工程与阻断预检',async()=>{
 const id='original-import-request',calls=[];
 const c=createNativeLibraryImportController({projectId,api:async(url,payload)=>{calls.push({url,payload});if(url==='/api/native-library-imports?projectId='+projectId)return{items:[{...record,status:'interrupted',importRequestId:id}],issues:[]};if(url.includes('/preview-one?'))return{...record,status:'interrupted',importRequestId:id};if(url==='/api/asset-catalog')return{revision:8};return{status:'completed',id:record.id};}});
 await c.load();assert.equal(c.snapshot().items.length,1);assert.equal(c.snapshot().current,null);assert.equal(calls.length,1);
 await c.read(record.id);c.setConfirmed(true);await c.import();assert.equal(calls.at(-1).payload.requestId,id);
 const bad=createNativeLibraryImportController({projectId,api:async()=>({...record,projectId:'other'})});bad.setSource('/tmp/synthetic');await assert.rejects(bad.preview(),/不属于/);
 const blocked=createNativeLibraryImportController({projectId,api:async()=>({...record,status:'blocked',canImport:false})});blocked.setSource('/tmp/synthetic');await blocked.preview();blocked.setConfirmed(true);await assert.rejects(blocked.import(),/通过检查/);
});

test('改目录清除旧确认，读取记录同步对应路径，不能把A计划当作B迁入',async()=>{
 const calls=[],c=createNativeLibraryImportController({projectId,api:async(url,payload)=>{calls.push({url,payload});return structuredClone(record);}});
 c.setSource(record.sourceDirectory);await c.preview();c.setConfirmed(true);c.setSource('/tmp/another-directory');assert.equal(c.snapshot().confirmed,false);assert.equal(c.snapshot().current,null);await assert.rejects(c.import(),/先读取/);assert.equal(calls.length,1);
 await c.read(record.id);assert.equal(c.snapshot().sourceDirectory,record.sourceDirectory);assert.equal(c.snapshot().confirmed,false);
});

test('关闭重开后检查同目录先读取旧计划，明确源库新版本才允许新预检',async()=>{
 const calls=[],saved={...record,status:'completed',canImport:false,importRequestId:'original-request'},c=createNativeLibraryImportController({projectId,api:async(url,payload)=>{calls.push({url,payload});if(url==='/api/native-library-imports?projectId='+projectId)return{items:[saved],issues:[]};if(url.includes('/preview-one?'))return structuredClone(saved);if(url.endsWith('/preview'))return structuredClone(record);throw Error('unexpected');}});
 await c.load();c.setSource(record.sourceDirectory);await c.preview();assert.equal(c.snapshot().current.status,'completed');assert.equal(calls.filter(x=>x.url.endsWith('/preview')).length,0);
 await c.preview({newVersion:true});assert.equal(calls.filter(x=>x.url.endsWith('/preview')).length,1);assert.equal(c.snapshot().confirmed,false);
 const interrupted=createNativeLibraryImportController({projectId,api:async url=>url==='/api/native-library-imports?projectId='+projectId?{items:[{...saved,status:'interrupted',canImport:true}],issues:[]}:url.includes('/preview-one?')?{...saved,status:'interrupted',canImport:true}:assert.fail('不得新建计划')});
 await interrupted.load();interrupted.setSource(record.sourceDirectory);await interrupted.preview({newVersion:true});assert.equal(interrupted.snapshot().current.importRequestId,'original-request');
});

test('停止等待时保留原请求，重复点击不会提交两份；目录刷新失败仍记作已迁入',async()=>{
 const calls=[];let entered;
 const gate=new Promise(r=>{entered=r;});
 const c=createNativeLibraryImportController({projectId,api:async(url,payload,{signal})=>{calls.push({url,payload});entered();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('stopped','AbortError')),{once:true}));}});
 c.setSource('/tmp/synthetic');const pending=c.preview();await gate;await c.preview();assert.equal(calls.length,1);c.stop();await assert.rejects(pending,/stopped/);assert.equal(c.snapshot().busy,false);assert.equal(c.snapshot().awaitingRead,true);
 const done=createNativeLibraryImportController({projectId,api:async url=>url.endsWith('/preview')?structuredClone(record):url==='/api/asset-catalog'?{revision:0}:{id:record.id,status:'completed'},onImport:async()=>{throw Error('refresh unavailable');}});
 done.setSource('/tmp/synthetic');await done.preview();done.setConfirmed(true);await done.import();assert.equal(done.snapshot().current.status,'completed');assert.match(done.snapshot().message,/尚未刷新/);assert.equal(done.snapshot().error,'');
});
