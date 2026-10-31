import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';

const require=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright'),root=process.cwd(),artifacts=path.join(root,'artifacts','gemini-history-qa-'+Date.now());
await fs.mkdir(artifacts,{recursive:true});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII=','base64'),key='synthetic-gemini-history-browser-key',calls=[];
const mock=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks).toString();calls.push({url:req.url,raw,headers:req.headers});res.setHeader('content-type','application/json');res.end(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:'本机模拟模型回复',thoughtSignature:'browser-signature'},{inlineData:{mimeType:'image/png',data:png.toString('base64')},thoughtSignature:'image-signature'}]}}]}));});
mock.listen(0,'127.0.0.1');await once(mock,'listening');
const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
let server,browser,page;const errors=[];
async function start(){server=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),JINGCHANG_DATA_DIR:path.join(artifacts,'data'),JINGCHANG_LLM_URL:'',JINGCHANG_LLM_MODEL:''},stdio:['ignore','pipe','pipe']});for(let i=0;i<80;i++){if(server.exitCode!==null)throw Error('isolated server exited');try{const r=await fetch(`http://127.0.0.1:${port}/api/health`);if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,125));}throw Error('isolated server startup timeout');}
try{
 await start();browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 page=await browser.newPage({viewport:{width:1440,height:900},baseURL:`http://127.0.0.1:${port}`});page.on('pageerror',e=>errors.push(e.message));
 const call=async(route,method='get',data)=>{const r=await page.request[method](route,{data});assert.ok(r.ok(),await r.text());return r.json();};
 const project=await call('/api/projects','post',{name:'Gemini 连续会话浏览器验收'}),conversation=await call('/api/conversations','post',{projectId:project.id});
 await call('/api/platforms','put',{revision:0,platform:{name:'Gemini 本机模拟',protocol:'gemini',baseUrl:`http://127.0.0.1:${mock.address().port}/v1beta`,models:[{id:'gemini-3.1-flash-image',category:'image',referenceSupport:true}]}});await call('/api/platforms','put',{revision:1,platform:{name:'兼容图片模拟',protocol:'openai-compatible',baseUrl:`http://127.0.0.1:${mock.address().port}/v1`,models:[{id:'image-test',category:'image',referenceSupport:true}]}});
 await page.goto(`/conversation.html?project=${project.id}&conversation=${conversation.id}`);await page.waitForSelector('#text');
 await page.locator('#mode').selectOption('image');await page.locator('#platform').selectOption({label:'Gemini 本机模拟'});await page.waitForFunction(()=>!document.querySelector('#gemini-history-option').hidden);
 const historyToggle=page.locator('#gemini-history');assert.equal(await historyToggle.isDisabled(),true);assert.equal(await historyToggle.isChecked(),false);
 const send=async(prompt,index)=>{await page.locator('#text').fill(prompt);await page.locator('#send').click();await page.locator('#dialog').waitFor({state:'visible'});await page.locator('#key').fill(key);await page.locator('#budget').fill('1');await page.locator('#consent').check();await page.locator('#confirm').click();await page.waitForFunction(()=>!document.querySelector('#dialog').open);for(let i=0;i<200&&calls.length<index;i++)await new Promise(r=>setTimeout(r,10));assert.equal(calls.length,index);await page.waitForFunction(()=>!document.querySelector('#send').disabled);};
 await send('画一座彩虹山',1);assert.equal(JSON.parse(calls[0].raw).contents.length,1);await page.waitForFunction(()=>!document.querySelector('#gemini-history').disabled);assert.equal(await historyToggle.isChecked(),false);
 await historyToggle.check();assert.ok((await page.locator('#scope-note').textContent()).includes('最近 1 轮'));
 await page.locator('#text').fill('把天空改成夜色');await page.locator('#send').click();await page.locator('#dialog').waitFor({state:'visible'});await page.locator('#dialog-content details summary').click();const preview=await page.locator('#dialog-content').innerText();assert.match(preview,/画一座彩虹山/);assert.match(preview,/核对将发送的 Gemini 历史/);assert.equal(await page.locator('#dialog-content details img').count(),1);
 await fs.writeFile(path.join(artifacts,'gemini-history-confirmation.png'),await page.screenshot());
 await page.locator('#key').fill(key);await page.locator('#budget').fill('1');await page.locator('#consent').check();await page.locator('#confirm').click();await page.waitForFunction(()=>!document.querySelector('#dialog').open);for(let i=0;i<200&&calls.length<2;i++)await new Promise(r=>setTimeout(r,10));assert.equal(calls.length,2);await page.waitForFunction(()=>!document.querySelector('#send').disabled);
 const body=JSON.parse(calls[1].raw);assert.deepEqual(body.contents.map(x=>x.role),['user','model','user']);assert.equal(body.contents[0].parts[0].text,'画一座彩虹山');assert.equal(body.contents[1].parts[0].thoughtSignature,'browser-signature');assert.equal(body.contents[1].parts[1].inlineData.data,png.toString('base64'));assert.equal(body.contents[2].parts[0].text,'把天空改成夜色');await page.locator('#platform').selectOption({label:'兼容图片模拟'});assert.equal(await page.locator('#gemini-history-option').isVisible(),false);assert.deepEqual(errors,[]);
 async function scan(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const f=path.join(dir,entry.name);if(entry.isDirectory())await scan(f);else assert.equal((await fs.readFile(f)).includes(Buffer.from(key)),false,f);}}await scan(path.join(artifacts,'data'));
 await fs.writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,checks:['Gemini multi-turn option hidden for other protocols and disabled without history','history is opt-in','confirmation lists exact previous prompt and image','native role order, image, and thought signature sent','API key absent from isolated workspace'],requests:calls.length,pageErrors:errors},null,2));
 console.log(JSON.stringify({passed:true,artifacts}));
}finally{await browser?.close();server?.kill('SIGTERM');mock.closeAllConnections();await new Promise(r=>mock.close(r));}
