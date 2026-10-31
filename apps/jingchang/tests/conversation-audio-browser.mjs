import './helpers/local-network-only.mjs';
import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';

const require=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'),{chromium}=require('playwright');
const root=process.cwd(),artifacts=path.join(root,'artifacts','conversation-audio-qa-'+Date.now()),data=path.join(artifacts,'data'),key='synthetic-gemini-audio-browser-key',calls=[],errors=[];
await fs.mkdir(artifacts,{recursive:true});
function wav(){const samples=8000,b=Buffer.alloc(44+samples*2);b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40);return b;}
const audio=wav(),mock=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);calls.push({url:req.url,headers:req.headers,raw:Buffer.concat(chunks).toString()});res.setHeader('content-type','application/json');res.end(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:'音频内容：本机隔离测试回答。'}]}}]}));});
mock.listen(0,'127.0.0.1');await once(mock,'listening');
const reserve=http.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));let server,browser,page;
async function start(){server=spawn(process.execPath,['--import','./tests/helpers/local-network-only.mjs','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),JINGCHANG_DATA_DIR:data,JINGCHANG_LLM_URL:'',JINGCHANG_LLM_MODEL:''},stdio:['ignore','pipe','pipe']});server.stderr.on('data',chunk=>fs.appendFile(path.join(artifacts,'server.log'),chunk));await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw Error('server exited');}),new Promise((_,reject)=>setTimeout(()=>reject(Error('startup timeout')),10000).unref())]);}
async function scan(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await scan(file);else assert.equal((await fs.readFile(file)).includes(Buffer.from(key)),false,file);}}
try{
 await start();browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000},baseURL:'http://127.0.0.1:'+port});
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(!['127.0.0.1','localhost'].includes(new URL(request.url()).hostname))errors.push('nonlocal browser request');});
 const api=async(route,method='get',body)=>{const response=await page.request[method](route,{data:body});assert.ok(response.ok(),await response.text());return response.json();};
 const mockBase='http://127.0.0.1:'+mock.address().port+'/v1beta',project=await api('/api/projects','post',{name:'Gemini 音频浏览器验收'});
 const platform=await api('/api/platforms','put',{revision:0,platform:{name:'本机 Gemini 音频 mock',protocol:'openai-compatible',baseUrl:mockBase,models:[{id:'gemini-3-flash',category:'chat'}]}});

 await page.goto('/?project='+project.id);await page.locator('[data-action="api-settings"]').waitFor();await page.locator('[data-action="api-settings"]').click();await page.locator('[data-edit-platform="'+platform.platforms[0].id+'"]').click();
 await page.locator('#platform-form [name="protocol"]').selectOption('gemini');await page.locator('#platform-models [data-model-field="audioSupport"]').waitFor();assert.equal(await page.locator('#platform-models [data-model-field="audioSupport"]').inputValue(),'false');
 await page.locator('#platform-models [data-model-field="audioSupport"]').selectOption('true');await page.locator('[data-action="save-platform"]').click();await page.waitForFunction(()=>document.querySelector('#platform-form [data-model-field="audioSupport"]')?.value==='true');
 const saved=await api('/api/platforms');assert.equal(saved.platforms[0].protocol,'gemini');assert.equal(saved.platforms[0].models[0].audioSupport,true);

 await page.goto('/conversation.html?project='+project.id);await page.locator('#text').waitFor();assert.match(await page.locator('#model-note').textContent(),/音频输入已按模型文档启用/);assert.match(await page.locator('#upload-files').getAttribute('accept'),/audio\/wav/);
 await page.locator('#upload-files').setInputFiles({name:'本机对白.wav',mimeType:'audio/wav',buffer:audio});await page.locator('.audio-attachment audio').waitFor();await page.waitForFunction(()=>!document.querySelector('#send').disabled);assert.equal(calls.length,0);assert.equal(await page.locator('.audio-attachment audio').count(),1);
 await page.locator('#text').fill('请概括这段音频。');await page.locator('#send').click();await page.locator('#dialog-content audio').waitFor();const preview=await page.locator('#dialog-content').innerText();assert.match(preview,/Gemini 模型：gemini-3-flash/);assert.match(preview,/发送最近20条完整上下文/);assert.match(preview,/本机对白\.wav/);assert.match(preview,/不会上传到另一个存储服务/);assert.equal(calls.length,0);
 await page.locator('#key').fill(key);await page.locator('#budget').fill('1');await page.locator('#consent').check();await page.locator('#confirm').click();await page.waitForFunction(()=>!document.querySelector('#dialog').open);await page.getByText('音频内容：本机隔离测试回答。',{exact:true}).waitFor();assert.equal(calls.length,1);
 assert.equal(calls[0].url,'/v1beta/models/gemini-3-flash:generateContent');assert.equal(calls[0].headers['x-goog-api-key'],key);const request=JSON.parse(calls[0].raw);assert.equal(request.contents.at(-1).role,'user');assert.equal(request.contents.at(-1).parts[0].text,'请概括这段音频。');assert.deepEqual(request.contents.at(-1).parts[1].inlineData,{mimeType:'audio/wav',data:audio.toString('base64')});assert.equal(await page.locator('.message-audio audio').count(),1);await page.screenshot({path:path.join(artifacts,'01-audio-chat.png')});
 await scan(data);assert.deepEqual(errors,[]);await fs.writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,checks:['API settings switches to Gemini and shows per-model audio opt-in','audio upload and player are available in chat mode','confirmation shows model, target, context, original audio, budget and one-request scope','one isolated Gemini call contains the expected inline WAV bytes','answer and original audio remain visible in conversation','synthetic API key is absent from persisted workspace','no browser errors or non-local requests'],calls:calls.length,pageErrors:errors},null,2));console.log(JSON.stringify({passed:true,checks:7,artifacts}));
}catch(error){if(page){await page.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});console.error('toast',await page.locator('#toast').textContent().catch(()=>''));}throw error;}finally{await browser?.close();server?.kill('SIGTERM');mock.closeAllConnections();await new Promise(resolve=>mock.close(resolve));}
