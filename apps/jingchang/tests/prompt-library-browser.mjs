import {createRequire} from 'node:module';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';

const require=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright');
const root=process.cwd(),data=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-prompt-browser-'));
const rewriteRequests=[];
const modelServer=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);rewriteRequests.push({path:req.url,authorization:req.headers.authorization,body:JSON.parse(Buffer.concat(chunks))});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'优化稿：保持角色特点，增加电影感光影。'}}]}));});
modelServer.listen(0,'127.0.0.1');await once(modelServer,'listening');const modelPort=modelServer.address().port;
const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await new Promise(resolve=>reservation.once('listening',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),JINGCHANG_DATA_DIR:data},stdio:'ignore'});
let browser,context;
try{
 const origin=`http://127.0.0.1:${port}`;let ready=false;
 for(let i=0;i<80;i++){if(child.exitCode!==null)throw new Error('隔离测试服务未能启动');try{const response=await fetch(origin+'/api/health');if(response.ok){ready=true;break;}}catch{}await delay(100);}
 assert.ok(ready,'等待隔离测试服务超时');
 const config=await fetch(origin+'/api/config').then(response=>response.json());const savedConfig=await fetch(origin+'/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:config.revision,llmUrl:`http://127.0.0.1:${modelPort}/v1/chat/completions`,llmModel:'Astra-mock',comfyUrl:config.comfyUrl})});assert.equal(savedConfig.status,200);
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 context=await browser.newContext({viewport:{width:1280,height:900}});const page=await context.newPage(),pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
 await page.goto(origin);await page.locator('[data-action="prompts"]').first().waitFor();await page.locator('[data-action="prompts"]').first().click();await page.locator('#prompt-form').locator('xpath=..').locator('summary').click();
 await page.locator('#prompt-form [name="title"]').fill('角色一致性模板');await page.locator('#prompt-form [name="category"]').fill('角色');await page.locator('#prompt-form [name="text"]').fill('保持 {{hero}} 的造型，置身 {{scene}}，再出现 {{hero}}');
 await page.locator('[data-action="save-prompt"]').click();await page.getByText('角色一致性模板',{exact:true}).waitFor();
 await page.locator('[data-use-prompt]').click();await page.locator('#prompt-use-form [name="hero"]').fill('林岚');await page.locator('#prompt-use-form [name="scene"]').fill('江南旧街');await page.locator('[data-action="apply-prompt"]').click();
 await page.locator('.panel [data-field="text"]').waitFor();assert.equal(await page.locator('.panel [data-field="text"]').inputValue(),'保持 林岚 的造型，置身 江南旧街，再出现 林岚');
 await page.locator('[data-action="prompts"]').first().click();await page.locator('[data-prompt-rewrite]').click();await page.locator('#prompt-rewrite-form [name="instruction"]').fill('增强镜头和光线表达');await page.locator('[data-action="rewrite-prompt"]').click();assert.equal(rewriteRequests.length,0);await page.locator('#prompt-rewrite-form [name="consent"]').check();await page.locator('[data-action="rewrite-prompt"]').click();await page.locator('#prompt-rewrite-result-form').waitFor();assert.equal(await page.locator('#prompt-rewrite-result-form [name="text"]').inputValue(),'优化稿：保持角色特点，增加电影感光影。');assert.equal(rewriteRequests.length,1);assert.equal(rewriteRequests[0].authorization,undefined);assert.equal(rewriteRequests[0].body.model,'Astra-mock');
 await page.locator('[data-action="edit-prompt-rewrite"]').click();assert.equal(await page.locator('#prompt-edit-form [name="text"]').inputValue(),'优化稿：保持角色特点，增加电影感光影。');await page.locator('[data-action="update-prompt"]').click();await page.locator('[data-prompt-versions]').waitFor();
 await page.locator('[data-prompt-versions]').click();await page.getByText('v1 · 角色一致性模板',{exact:true}).waitFor();await page.locator('[data-prompt-restore][data-revision="1"]').click();await page.getByText('v3',{exact:false}).first().waitFor();
 assert.deepEqual(pageErrors,[]);
 console.log(JSON.stringify({passed:true,checks:12,variableFill:true,localRewriteRequiresConsent:true,rewriteSubmissions:rewriteRequests.length,editCreatesRevision:true,historyRestoreCreatesRevision:true,pageErrors}));
}finally{if(context)await context.close();if(browser)await browser.close();child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve)).catch(()=>{});await new Promise(resolve=>modelServer.close(resolve));}
