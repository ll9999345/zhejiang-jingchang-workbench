import './helpers/local-network-only.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runConversationImage} from '../lib/conversation-images.mjs';

const SECRET='synthetic-miao-conversation-image-redaction-key';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64');
const platform={id:'isolated-miao-redaction-fixture',protocol:'openai-compatible',baseUrl:'http://127.0.0.1:1/v1'};

async function fixture(){
  // Retain owned fixture directories for investigation; never touch user data.
  const data=await fs.mkdtemp(path.join(os.tmpdir(),'jc-miao-image-redaction-'));
  const refs=[{assetId:'self-created-reference',bytes:Buffer.from(PNG),mime:'image/png',name:'self-created.png'}];
  const job={id:'self-created-image-task',kind:'conversation-image',status:'queued',requestCount:0,progress:0,uncertain:false,assets:[],input:{text:'自制本地脱敏验收，未发送模型请求',model:'fixture-image',size:'auto',quality:'auto',assetIds:['self-created-reference']}};
  const calls={generator:0,persist:[],answers:[]};
  async function snapshot(kind,value){
    const serialized=JSON.stringify(value);
    assert.equal(serialized.includes(SECRET),false,kind+' must be safe before writing');
    const copy=JSON.parse(serialized),list=kind==='persist'?calls.persist:calls.answers,file=path.join(data,kind+'-'+list.length+'.json');
    await fs.writeFile(file,serialized);assert.equal((await fs.readFile(file,'utf8')).includes(SECRET),false);
    list.push(copy);
  }
  return{data,refs,job,calls,controller:new AbortController(),persist:value=>snapshot('persist',value),saveAnswer:async value=>{assert.equal(refs.length,0,'reference array must be cleared before saving the answer');await snapshot('answer',value);}};
}
async function noSecretOnDisk(data){
  for(const entry of await fs.readdir(data,{withFileTypes:true})){
    const file=path.join(data,entry.name);
    if(entry.isDirectory())await noSecretOnDisk(file);else assert.equal((await fs.readFile(file)).includes(Buffer.from(SECRET)),false,file);
  }
}
async function execute(f,generator,extra={}){
  await runConversationImage({data:f.data,job:f.job,platform,key:SECRET,references:f.refs,controller:f.controller,persist:f.persist,saveAnswer:f.saveAnswer,imageGenerator:async args=>{
    f.calls.generator++;assert.equal(args.apiKey,SECRET);assert.equal(args.references,f.refs);assert.equal(args.prompt,f.job.input.text);assert.ok(args.signal instanceof AbortSignal);
    return generator(args);
  },...extra});
  assert.equal(f.refs.length,0);await noSecretOnDisk(f.data);
}

test('生图 usage 的嵌套字段名与值、Gemini parts 回显在每次保存前脱敏，PNG 字节保留',async()=>{
  const f=await fixture(),usage={input_tokens:3,output_tokens:4,total_tokens:7,zero:0,ok:true,missing:null,
    ['usage-'+SECRET]:{doNotPersist:'field name itself contains credential'},
    nested:{accepted:2,['nested-'+SECRET]:1,note:'prefix '+SECRET+' suffix',items:[{value:SECRET,['array-'+SECRET]:9},'echo '+SECRET,8]},
    provider_note:'safe detail',api_key:SECRET};
  const textPart={type:'text',text:'fixture output '+SECRET,thoughtSignature:'signed '+SECRET,['part-'+SECRET]:'must be removed',normal:'kept'};
  await execute(f,async()=>({images:[{bytes:PNG,mime:'image/png'}],usage,geminiParts:[textPart,{type:'image',index:0,mime:'image/png',thoughtSignature:'image-signature '+SECRET}]}));
  assert.equal(f.calls.generator,1);assert.equal(f.calls.persist.length,3);assert.equal(f.calls.answers.length,1);
  assert.equal(f.job.status,'completed');assert.equal(f.job.requestCount,1);assert.equal(f.job.progress,100);assert.equal(f.job.uncertain,false);
  assert.deepEqual(f.job.usage,{input_tokens:3,output_tokens:4,total_tokens:7,zero:0,ok:true,missing:null,nested:{accepted:2,note:'prefix [已隐藏] suffix',items:[{value:'[已隐藏]'},'echo [已隐藏]',8]},provider_note:'safe detail',api_key:'[已隐藏]'});
  assert.equal(f.job.assets.length,1);assert.deepEqual(await fs.readFile(path.join(f.data,'assets',f.job.assets[0].id)),PNG);
  assert.equal(f.job.geminiParts[0].text,'fixture output [已隐藏]');assert.equal(f.job.geminiParts[0].thoughtSignature,'signed [已隐藏]');assert.equal(f.job.geminiParts[0].normal,'kept');assert.ok(!Object.keys(f.job.geminiParts[0]).some(name=>name.includes(SECRET)));
  assert.equal(f.job.geminiParts[1].assetId,f.job.assets[0].id);assert.equal(f.job.geminiParts[1].thoughtSignature,'image-signature [已隐藏]');
  assert.deepEqual(f.calls.answers[0].usage,f.job.usage);assert.deepEqual(f.calls.persist.at(-1).geminiParts,f.job.geminiParts);
  assert.equal(usage.nested.items[0].value,SECRET,'redaction must not mutate the provider result');assert.equal(textPart.text,'fixture output '+SECRET);
});

test('正常 usage 计数与内容签名保持不变，不改变图片、请求数或素材身份',async()=>{
  const f=await fixture(),usage={input_tokens:12,output_tokens:9,total_tokens:21,provider:{model:'fixture-image',image_count:1,detail:[{name:'image',count:1}]}},parts=[{type:'text',text:'普通返回文字',thoughtSignature:'unchanged-signature'},{type:'image',index:0,mime:'image/png',thoughtSignature:'unchanged-image-signature'}];
  await execute(f,async()=>({images:[{bytes:PNG,mime:'image/png'}],usage,geminiParts:parts}));
  assert.deepEqual(f.job.usage,usage);assert.deepEqual(f.job.geminiParts[0],parts[0]);assert.deepEqual(f.job.geminiParts[1],{type:'image',assetId:f.job.assets[0].id,mime:'image/png',thoughtSignature:'unchanged-image-signature'});
  assert.equal(f.calls.generator,1);assert.equal(f.job.status,'completed');assert.equal(f.job.assets[0].type,'image/png');assert.equal(f.job.assets[0].size,PNG.length);assert.deepEqual(await fs.readFile(path.join(f.data,'assets',f.job.assets[0].id)),PNG);
});

test('上游公开错误回显凭据时保存安全失败说明，明确拒绝不重试且清空参考图',async()=>{
  const f=await fixture();await execute(f,async()=>{throw Object.assign(new Error('private raw error '+SECRET),{publicMessage:'fixture rejected credential '+SECRET,uncertain:false});});
  assert.equal(f.calls.generator,1);assert.equal(f.calls.persist.length,2);assert.equal(f.calls.answers.length,1);assert.equal(f.job.status,'failed');assert.equal(f.job.requestCount,1);assert.equal(f.job.uncertain,false);assert.equal(f.job.message,'fixture rejected credential [已隐藏]');assert.deepEqual(f.job.assets,[]);
  assert.equal(f.calls.answers[0].message,f.job.message);assert.equal(f.calls.persist.at(-1).message,f.job.message);
});

test('非公开异常中的凭据不进入回答或任务，保持未知结果提醒且不重试',async()=>{
  const f=await fixture();await execute(f,async()=>{throw Error('transport response '+SECRET);});
  assert.equal(f.calls.generator,1);assert.equal(f.job.status,'failed');assert.equal(f.job.uncertain,true);assert.match(f.job.message,/未确认.*不会自动重发/);assert.deepEqual(f.job.assets,[]);assert.equal(f.calls.answers.length,1);
});

test('保存回答失败时不回显异常、不重发，已生成图片与正常计数仍保留',async()=>{
  const f=await fixture();await execute(f,async()=>({images:[{bytes:PNG,mime:'image/png'}],usage:{total_tokens:5,detail:'usage echo '+SECRET}}),{saveAnswer:async value=>{
    assert.equal(f.refs.length,0);const text=JSON.stringify(value);assert.equal(text.includes(SECRET),false);f.calls.answers.push(JSON.parse(text));await fs.writeFile(path.join(f.data,'answer-before-failure.json'),text);throw Error('fixture answer storage error '+SECRET);
  }});
  assert.equal(f.calls.generator,1);assert.equal(f.calls.answers.length,1);assert.equal(f.job.status,'failed');assert.match(f.job.message,/结果保留.*对话保存失败.*不会自动重发/);assert.equal(f.job.usage.total_tokens,5);assert.equal(f.job.usage.detail,'usage echo [已隐藏]');assert.equal(f.job.assets.length,1);assert.deepEqual(await fs.readFile(path.join(f.data,'assets',f.job.assets[0].id)),PNG);
});

test('生成器返回时取消不保存返回内容，不重发并在最终回写前清空参考图',async()=>{
  const f=await fixture();await execute(f,async()=>{f.controller.abort(Error('synthetic cancellation '+SECRET));return{images:[{bytes:PNG,mime:'image/png'}],usage:{echo:SECRET},geminiParts:[{type:'text',text:SECRET}]};});
  assert.equal(f.calls.generator,1);assert.equal(f.job.status,'cancelled');assert.equal(f.job.requestCount,1);assert.equal(f.job.uncertain,true);assert.deepEqual(f.job.assets,[]);assert.equal(f.job.usage,undefined);assert.equal(f.job.geminiParts,undefined);assert.match(f.job.message,/停止本机等待.*不会自动重发/);assert.equal(f.calls.answers.length,1);
});
