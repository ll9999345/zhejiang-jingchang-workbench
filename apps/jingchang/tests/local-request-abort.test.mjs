import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {abortableRequest} from '../lib/local-request-abort.mjs';
test('装监听前已断开的请求不启动操作，所有监听释放',async()=>{
 for(const flag of ['aborted','destroyed']){const req=new EventEmitter(),res=new EventEmitter();(flag==='aborted'?req:res)[flag]=true;let calls=0;await assert.rejects(abortableRequest(req,res,()=>{calls++;}),/本机请求已断开/);assert.equal(calls,0);assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);}
});
test('中途断开传递取消信号，成功响应close不误取消，异常后也释放监听',async()=>{
 const req=new EventEmitter(),res=new EventEmitter();await abortableRequest(req,res,signal=>{assert.equal(signal.aborted,false);res.emit('close');assert.equal(signal.aborted,true);});assert.equal(req.listenerCount('aborted'),0);
 res.writableEnded=true;await abortableRequest(req,res,signal=>{res.emit('close');assert.equal(signal.aborted,false);});
 await assert.rejects(abortableRequest(req,res,()=>{throw Error('operation failed');}),/operation failed/);assert.equal(res.listenerCount('close'),0);
});
