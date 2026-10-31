// Isolated local browser acceptance of the production multi-credential control.
import {createRequire} from 'node:module';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const require=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright');
const stage=path.resolve(process.env.MIAO_CONTROL_ARTIFACTS||'artifacts/miao-controls-'+Date.now());await fs.mkdir(stage,{recursive:true});
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>多节点凭据选择 · 隔离本机验收</title><style>body{margin:24px;font:16px system-ui;background:#111629;color:#edf4ff}section{padding:18px;border:1px solid #b7ccff66;border-radius:14px;margin-bottom:12px}label{display:grid;gap:8px;margin:12px 0}input,select{padding:10px;width:90%;box-sizing:border-box}input[type=checkbox]{width:auto}h1{font-size:20px}.muted{font-size:13px}label[hidden]{display:none}</style><h1>多节点与 Agent 凭据隔离验收</h1><form>${['节点一','节点二','Agent 路由','Agent 图片'].map((name,i)=>'<section><b>'+name+'</b><label>本次 Key<input id="key'+i+'" type="password" autocomplete="off"></label></section>').join('')}</form><script type="module">import{mountMiaoCredentialChoice,readMiaoCredentialChoice}from'/miao-credential-ui.js';window.controls={mountMiaoCredentialChoice,readMiaoCredentialChoice};for(let i=0;i<4;i++)await mountMiaoCredentialChoice(document.querySelector('#key'+i),{protocol:'openai-compatible',baseUrl:'https://miaoapi.xyz/v1'},{purpose:i===3?'image':'chat'});window.ready=true;</script>`;
const server=http.createServer(async(req,res)=>{try{if(req.url==='/'){res.setHeader('content-type','text/html');res.end(html);}else if(['/miao-credential-ui.js','/miao-credential-core.js'].includes(req.url)){res.setHeader('content-type','text/javascript');res.end(await fs.readFile(path.join('public',req.url.slice(1))));}else{res.writeHead(404);res.end();}}catch{res.writeHead(500);res.end();}});
server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
let browser;const blocked=[],errors=[],checks=[];
try{
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const context=await browser.newContext({viewport:{width:1280,height:1000}});
 await context.route('**/*',route=>{const req=route.request();if(req.url()===base+'/api/miao-credentials/status')return route.fulfill({json:{configured:true,checkedWithoutReadingSecret:true}});if(new URL(req.url()).origin!==base||req.method()!=='GET'){blocked.push({url:req.url(),method:req.method()});return route.abort();}return route.continue();});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.waitForFunction(()=>window.ready);
 assert.equal(await page.locator('[data-miao-credential-choice]').count(),4);
 for(let i=0;i<4;i++)await page.locator('#key'+i).fill('synthetic-manual-'+i);
 const section1=page.locator('section').nth(1);await section1.locator('select').selectOption('miao-local');
 assert.equal(await page.locator('#key1').inputValue(),'');assert(await page.locator('#key1').isDisabled());
 const noConsent=await page.evaluate(()=>{try{controls.readMiaoCredentialChoice(document.querySelector('#key1'));return false;}catch{return true;}});assert(noConsent);
 await section1.locator('[data-miao-consent]').check();
 const selected=await page.evaluate(()=>[0,1,2,3].map(i=>controls.readMiaoCredentialChoice(document.querySelector('#key'+i))));
 assert.equal(selected[0].apiKey,'synthetic-manual-0');assert.equal(selected[1].credentialSource,'miao-local');assert.equal(selected[1].credentialConsent,true);assert.equal(selected[2].apiKey,'synthetic-manual-2');assert.equal(selected[3].apiKey,'synthetic-manual-3');checks.push('four-fields-have-independent-source-and-consent');
 await page.evaluate(()=>controls.mountMiaoCredentialChoice(document.querySelector('#key0'),{protocol:'openai-compatible',baseUrl:'http://127.0.0.1:9999/v1'}));
 assert.equal(await page.locator('[data-miao-credential-choice]').count(),3);assert(await section1.locator('[data-miao-consent]').isChecked());checks.push('remount-removes-only-own-control');
 await section1.locator('select').selectOption('manual');assert(await page.locator('#key1').isEnabled());assert(!await section1.locator('[data-miao-consent]').isChecked());checks.push('switch-back-clears-one-time-consent');
 await page.screenshot({path:path.join(stage,'01-independent-controls-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.locator('#key2').focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.tagName),'SELECT');checks.push('mobile-no-overflow-and-keyboard-tab');
 await page.screenshot({path:path.join(stage,'02-independent-controls-mobile.png'),fullPage:true});
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
 await fs.writeFile(path.join(stage,'result.json'),JSON.stringify({ok:true,evidenceKind:'mock_interaction',productionModule:true,checks,pageErrors:errors,blocked,realSecretReads:0,providerRequests:0,formalWrites:0},null,2));console.log(JSON.stringify({ok:true,checks,stage}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
