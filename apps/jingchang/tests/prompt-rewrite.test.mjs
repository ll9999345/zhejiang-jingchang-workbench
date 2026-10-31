import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {rewritePrompt} from '../lib/prompt-rewrite.mjs';

test('提示词改写只向授权的本机模型提交一次，并返回可审阅文本',async()=>{
 let requests=0,received;
 const server=http.createServer(async(req,res)=>{requests++;const parts=[];for await(const part of req)parts.push(part);received={url:req.url,authorization:req.headers.authorization,body:JSON.parse(Buffer.concat(parts))};res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'电影感改写稿'}}]}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');const endpoint=`http://127.0.0.1:${server.address().port}/v1/chat/completions`;
 try{
  await assert.rejects(rewritePrompt({endpoint,model:'Astra-mock',sourcePrompt:'原稿',instruction:'更有电影感',consent:false}),{status:400});assert.equal(requests,0);
  await assert.rejects(rewritePrompt({endpoint:'https://example.test/v1/chat/completions',model:'Astra-mock',sourcePrompt:'原稿',instruction:'优化',consent:true}),{status:400});assert.equal(requests,0);
  const result=await rewritePrompt({endpoint,model:'Astra-mock',sourcePrompt:'主角走入旧城',instruction:'强化光线',consent:true});
  assert.deepEqual(result,{text:'电影感改写稿',model:'Astra-mock'});assert.equal(requests,1);assert.equal(received.url,'/v1/chat/completions');assert.equal(received.authorization,undefined);assert.equal(received.body.model,'Astra-mock');assert.match(received.body.messages[1].content,/主角走入旧城/u);assert.match(received.body.messages[1].content,/强化光线/u);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('提示词改写错误不自动重试，且不接受空或超长模型结果',async()=>{
 let requests=0;
 const failing=async()=>{requests++;return{ok:false,status:503};};
 await assert.rejects(rewritePrompt({endpoint:'http://127.0.0.1:1/chat/completions',model:'Astra-mock',sourcePrompt:'原稿',instruction:'优化',consent:true,fetchImpl:failing}),/没有自动重试/u);assert.equal(requests,1);
 await assert.rejects(rewritePrompt({endpoint:'http://127.0.0.1:1/chat/completions',model:'Astra-mock',sourcePrompt:'原稿',instruction:'优化',consent:true,fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:' '}}]})})}),/没有返回有效提示词/u);
});
