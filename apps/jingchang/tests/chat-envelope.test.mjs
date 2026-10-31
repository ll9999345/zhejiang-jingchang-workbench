import test from 'node:test';
import assert from 'node:assert/strict';
import {chatReply} from '../lib/chat-stream.mjs';

const completion=(content,reason='stop')=>({choices:[{message:{content},finish_reason:reason}]});
const wrap=data=>({code:200,data});

test('APIMart 完整响应解包并保留分段文字、拒绝说明与结束状态',()=>{
 assert.deepEqual(chatReply(wrap(completion('回答'))),chatReply(completion('回答')));
 assert.equal(chatReply(wrap(completion([{type:'text',text:'第一段'},{text:'第二段'},{content:'第三段'},null,{type:'image_url',image_url:{url:'https://unused.example'}}]))).text,'第一段\n第二段\n第三段');
 assert.equal(chatReply(wrap({choices:[{message:{content:null,refusal:'无法执行该操作'},finish_reason:'content_filter'}]})).complete,false);
 assert.equal(chatReply({data:completion('无状态包装')}).text,'无状态包装');
 assert.equal(chatReply({...completion('顶层优先'),data:completion('不能覆盖')}).text,'顶层优先');
});

test('错误或畸形包装不能伪装为成功，错误正文与工具不作为回答',()=>{
 const secret='synthetic-envelope-error-key';
 const bad=[null,[],{code:403,data:completion('伪成功'),message:secret},{code:200,success:false,data:completion('伪成功')},
  {code:200,error:{message:secret},data:completion('伪成功')},wrap({error:{message:secret},...completion('伪成功')}),
  wrap(wrap(completion('嵌套'))),{code:200,data:[completion('数组')]},{choices:null,data:completion('不能替代损坏顶层')},
  wrap(completion('x'.repeat(200001))),wrap({choices:[{message:{content:'不执行',tool_calls:[{function:{name:'run'}}]},finish_reason:'stop'}]})];
 for(const value of bad)assert.throws(()=>chatReply(value),e=>!!e.publicMessage&&!e.message.includes(secret));
});

test('未知结束原因保留文字为未完成，不把供应商未知状态当作成功',()=>{
 for(const reason of ['length','content_filter','tool_calls','function_call','vendor_interrupted']){
  const reply=chatReply(wrap(completion('已收到片段',reason)));assert.equal(reply.text,'已收到片段');assert.equal(reply.complete,false);
  assert.equal(reply.finishReason,reason==='vendor_interrupted'?'unknown':reason);
 }
 assert.equal(chatReply(wrap(completion('旧接口省略结束原因',null))).complete,true);
});
