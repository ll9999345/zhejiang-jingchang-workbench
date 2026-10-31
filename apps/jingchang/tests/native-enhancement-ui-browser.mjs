// Production markup, isolated local presentation fixture. No model or project writes.
import {createRequire} from 'node:module';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const require=createRequire('/Users/mjd-ppps/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright');
const stage=path.resolve(process.env.ENHANCE_UI_ARTIFACTS||'artifacts/native-enhancement-ui-'+Date.now());await fs.mkdir(stage,{recursive:true});
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>body{padding:24px}main{max-width:800px;margin:auto}h1{font-size:20px}.native-enhancement-receipt{overflow-wrap:anywhere}section{margin:20px 0}</style><main><h1>图片增强 · 模拟界面验收</h1><p>生产组件与合成收据；未提交模型任务。</p><section id="plan"></section><section id="actual"></section><section id="workflow"></section></main><script type="module">
import{nativeCascadePlanMarkup,nativeCascadeRequestMarkup}from'/native-cascade-ui.js';
const esc=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const enhancement={kind:'enhance',engine:'comfy',strength:.65,seedMode:'random'};
document.querySelector('#plan').innerHTML=nativeCascadePlanMarkup({summary:{operations:2,generations:1,requests:1,sharedCopies:1},program:{},steps:[{title:'增强 & 共享 '+String.fromCharCode(60)+'script>bad'+String.fromCharCode(60)+'/script>',cascadeKind:'generate',count:1,imageEnhance:enhancement}]},esc);
const input={prompt:'',referenceRefs:[{name:'原图 <img src=x>',assetId:'source-123',kind:'image'}],unusedRefs:[{name:'保留图',assetId:'unused-456'}],enhancement:{...enhancement,seed:1234,sourceAssetId:'source-123'}};
document.querySelector('#actual').innerHTML=nativeCascadeRequestMarkup({actualInput:input},esc);
document.querySelector('#workflow').innerHTML=nativeCascadeRequestMarkup({actualInput:{...input,enhancement:{...enhancement,seedMode:'workflow',sourceAssetId:'source-123'}}},esc);
window.ready=true;</script>`;
const server=http.createServer(async(req,res)=>{try{if(req.url==='/'){res.setHeader('content-type','text/html');res.end(html);}else if(['/style.css','/native-cascade-ui.js'].includes(req.url)){res.setHeader('content-type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(await fs.readFile(path.join('public',req.url.slice(1))));}else{res.writeHead(404);res.end();}}catch{res.writeHead(500);res.end();}});
server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
let browser;const errors=[],blocked=[],checks=[];
try{
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const context=await browser.newContext({viewport:{width:1280,height:1000}});
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==base||route.request().method()!=='GET'){blocked.push(route.request().url());return route.abort();}return route.continue();});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.waitForFunction(()=>window.ready);
 assert.match(await page.locator('#plan').innerText(),/强度 0.65 · 执行时选择一次随机种子/);assert(!await page.locator('#plan').innerText().then(s=>s.includes('种子 1234')));checks.push('preflight-shows-policy-without-inventing-seed');
 const actual=page.locator('#actual summary');await actual.focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#actual details').evaluate(e=>e.open),true);
 assert.match(await page.locator('#actual').innerText(),/种子 1234 · 来源 原图 <img src=x>（source-123）/);assert.match(await page.locator('#actual').innerText(),/保留图/);checks.push('keyboard-opens-actual-receipt-with-used-and-unused-source');
 await page.locator('#workflow summary').click();assert.match(await page.locator('#workflow').innerText(),/沿用工作流种子/);assert(!(await page.locator('#workflow').innerText()).includes('种子 1234'));assert.equal(await page.locator('section img,section script').count(),0);checks.push('workflow-seed-is-not-fabricated-and-labels-are-escaped');
 await page.screenshot({path:path.join(stage,'01-enhancement-receipts-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(stage,'02-enhancement-receipts-mobile.png'),fullPage:true});checks.push('390px-receipts-readable-without-horizontal-overflow');
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
 await fs.writeFile(path.join(stage,'result.json'),JSON.stringify({ok:true,evidenceKind:'mock_interaction',productionMarkup:true,checks,pageErrors:errors,blocked,realSecretReads:0,providerRequests:0,formalWrites:0},null,2));console.log(JSON.stringify({ok:true,checks,stage}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
